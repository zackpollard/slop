/**
 * Mock PeerJS implementation for testing SlopNet.
 *
 * Simulates a PeerJS signaling server in-memory, allowing creation of
 * MockPeer instances that can connect to each other without WebRTC.
 *
 * Faithful to peerjs 1.5.5 where SlopNet's correctness depends on it:
 *   - DataConnection.close() (plain) emits 'close' SYNCHRONOUSLY on the local side
 *     if the connection was open, DROPS anything still sitting in its outgoing
 *     buffer, and closes the remote one tick later (the remote then emits its own
 *     'close'). The dropped buffer is the whole reason rejectClient()/close() use
 *     close({ flush: true }), so the mock has a real outbox that a plain close
 *     discards — otherwise "the reason arrives before the close" passes just as
 *     well without the flush and the guarantee is not under test.
 *   - DataConnection.close({ flush: true }) does NOT close locally. It sends a
 *     { __peerData: { type: 'close' } } control message through the ordered,
 *     deferred send path; the REMOTE, on reading it, runs its own plain close()
 *     (delivering everything sent before it first), which closes us a tick later.
 *   - __peerData control messages are never surfaced as 'data'.
 *   - Peer.disconnect() emits 'disconnected' SYNCHRONOUSLY (once), leaves
 *     DataConnections alone. The id it held is freed at once by default, or after
 *     MockPeer.aliveTimeoutMs, which models the PeerServer's alive_timeout (the
 *     reason a re-registration after an outage is answered 'unavailable-id'). A
 *     disconnected peer still holding its id cannot be DIALLED, though: the offer
 *     would have to travel over the socket it no longer has, so connect() answers
 *     'peer-unavailable' exactly as it does for a destroyed peer.
 *   - Peer.destroy() = disconnect(), then plain-close every DataConnection, then
 *     emit 'close'.
 */

// Global signaling registry - simulates the PeerJS signaling server
const registry = new Map(); // peerId -> MockPeer

let peerIdCounter = 0;

function generateMockPeerId() {
    return '__mock_peer_' + (++peerIdCounter);
}

/**
 * Reset the global registry (call between tests).
 */
function resetRegistry() {
    registry.clear();
    peerIdCounter = 0;
    MockPeer.openDelayMs = 0;
    MockPeer.aliveTimeoutMs = 0;
}

/**
 * Flush microtasks to allow async operations to complete.
 */
function flushMicrotasks() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Wait for a specific event on an emitter, with timeout.
 */
function waitForEvent(emitter, event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`));
        }, timeoutMs);
        emitter.once(event, (...args) => {
            clearTimeout(timer);
            resolve(args.length === 1 ? args[0] : args);
        });
    });
}

/**
 * Wait for N occurrences of an event.
 */
function waitForEvents(emitter, event, count, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const results = [];
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for ${count} "${event}" events (got ${results.length}) after ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (...args) => {
            results.push(args.length === 1 ? args[0] : args);
            if (results.length >= count) {
                clearTimeout(timer);
                emitter.off(event, handler);
                resolve(results);
            }
        };
        emitter.on(event, handler);
    });
}

// Simple event emitter for mock classes
class SimpleEmitter {
    constructor() {
        this._handlers = {};
    }

    on(event, fn) {
        if (!this._handlers[event]) this._handlers[event] = [];
        this._handlers[event].push(fn);
        return this;
    }

    off(event, fn) {
        if (!this._handlers[event]) return this;
        if (fn) {
            this._handlers[event] = this._handlers[event].filter(h => h !== fn);
        } else {
            delete this._handlers[event];
        }
        return this;
    }

    once(event, fn) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            fn(...args);
        };
        return this.on(event, wrapper);
    }

    emit(event, ...args) {
        const handlers = this._handlers[event];
        if (!handlers) return;
        for (const fn of handlers.slice()) {
            fn(...args);
        }
    }
}

/**
 * MockDataConnection - simulates a PeerJS DataConnection.
 */
class MockDataConnection extends SimpleEmitter {
    constructor(localPeer, remotePeerId, options) {
        super();
        this.peer = remotePeerId;
        this.open = false;
        this.reliable = (options && options.reliable) || false;
        this._localPeer = localPeer;
        this._remote = null; // Set when paired
        this._closed = false;
        // Everything sent goes here first and leaves on a later tick, exactly like
        // peerjs's buffered send path. A plain close() throws whatever is still in it
        // away; a flush close lets it drain and closes behind it.
        this._outbox = [];
    }

    send(data) {
        // Real peerjs emits an 'error' event and returns here; the throw is kept
        // because slopnet checks `.open` before every send, so it is unreachable from
        // the library — do not rely on it in new tests.
        if (this._closed || !this.open) {
            throw new Error('Connection is not open');
        }
        if (!this._remote || this._remote._closed) {
            throw new Error('Remote connection is closed');
        }
        // Deep clone to simulate serialization
        const cloned = JSON.parse(JSON.stringify(data));
        this._deliver(cloned);
    }

    /**
     * The one deferred, ordered send path. Everything — game data, slopnet's own
     * messages and peerjs control messages — goes through here, so a control
     * message queued after N data messages is acted on after those N are delivered,
     * and a plain close() before the queue drains loses the lot.
     */
    _deliver(payload) {
        // Buffered here, dispatched on its own tick (a real DataChannel delivers each
        // message in its own task, so a promise settled by one handler resolves before
        // the next message arrives). Timers fire in scheduling order, so the buffer
        // drains in order — and a plain close() that empties it in the meantime takes
        // every message still in it with it, exactly as peerjs does.
        this._outbox.push(payload);
        setTimeout(() => {
            if (!this._outbox.length) return;               // dropped by a plain close()
            const next = this._outbox.shift();
            const remote = this._remote;
            if (this._closed) return;
            if (!remote || remote._closed || !remote.open) return;
            if (next && next.__peerData) {
                // peerjs control message: acted on, never surfaced as 'data'.
                if (next.__peerData.type === 'close') remote.close();
                return;
            }
            remote.emit('data', next);
        }, 0);
    }

    close(options) {
        if (options && options.flush) {
            // Flush-close: ask the REMOTE to close once it has read everything we sent
            // before this. We do not close locally at all; the remote's close closes us.
            if (!this.open || this._closed) return;
            this._deliver({ __peerData: { type: 'close' } });
            return;
        }

        if (this._closed) return;
        const wasOpen = this.open;
        this._closed = true;
        this.open = false;
        // Real peerjs drops the unsent buffer on the floor here.
        this._outbox.length = 0;
        if (!wasOpen) return; // never opened: nothing to announce

        // Synchronous, exactly as peerjs does it.
        this.emit('close');

        const remote = this._remote;
        if (remote && !remote._closed) {
            // The remote's data channel sees the close a tick later and runs its own
            // plain close() (which emits its 'close' and finds us already closed).
            setTimeout(() => {
                if (!remote._closed) remote.close();
            }, 0);
        }
    }
}

/**
 * MockPeer - simulates a PeerJS Peer instance.
 */
class MockPeer extends SimpleEmitter {
    constructor(id, options) {
        super();
        this.id = id || generateMockPeerId();
        this.options = options || {};
        this.destroyed = false;
        this.disconnected = false;
        this._connections = [];
        this._networkDisabled = false;

        // Register and emit open asynchronously
        if (registry.has(this.id)) {
            // ID collision
            setTimeout(() => {
                const err = new Error('ID "' + this.id + '" is taken');
                err.type = 'unavailable-id';
                this.emit('error', err);
            }, 0);
        } else {
            registry.set(this.id, this);
            setTimeout(() => {
                if (!this.destroyed && !this.disconnected) {
                    this.emit('open', this.id);
                }
            }, this._openDelay());
        }
    }

    /**
     * How long registration takes. Per-instance via options.openDelayMs (slopnet
     * forwards config.peerOptions to the constructor), else the static default —
     * so a test can hold an attempt mid-handshake.
     */
    _openDelay() {
        if (this.options && typeof this.options.openDelayMs === 'number') return this.options.openDelayMs;
        return MockPeer.openDelayMs || 0;
    }

    connect(remotePeerId, options) {
        const localConn = new MockDataConnection(this, remotePeerId, options);

        if (this._networkDisabled) {
            setTimeout(() => {
                const err = new Error('Network disabled');
                err.type = 'network';
                localConn.emit('error', err);
            }, 0);
            return localConn;
        }

        const remotePeer = registry.get(remotePeerId);
        // A peer whose signalling socket is gone cannot be dialled, even while the
        // server is still holding its id (aliveTimeoutMs): real peerjs routes the offer
        // through that socket, so the dialler is answered 'peer-unavailable'. Without
        // this, "a client can still join" — the assertion the C12/C13 tests reach for —
        // passed with no reconnect having happened at all.
        if (!remotePeer || remotePeer.destroyed || remotePeer.disconnected) {
            setTimeout(() => {
                const err = new Error('Could not connect to peer ' + remotePeerId);
                err.type = 'peer-unavailable';
                this.emit('error', err);
            }, 0);
            return localConn;
        }

        // Create the remote side of the connection
        const remoteConn = new MockDataConnection(remotePeer, this.id, options);

        // Pair the connections
        localConn._remote = remoteConn;
        remoteConn._remote = localConn;
        localConn.peer = remotePeerId;
        remoteConn.peer = this.id;

        this._connections.push(localConn);
        remotePeer._connections.push(remoteConn);

        // Open both sides asynchronously
        setTimeout(() => {
            if (!localConn._closed && !this.destroyed) {
                localConn.open = true;
                localConn.emit('open');
            }
            if (!remoteConn._closed && !remotePeer.destroyed) {
                remoteConn.open = true;
                // Notify the remote peer of the incoming connection
                remotePeer.emit('connection', remoteConn);
                remoteConn.emit('open');
            }
        }, 0);

        return localConn;
    }

    reconnect() {
        if (this.destroyed) return;
        this.disconnected = false;
        if (!registry.has(this.id)) {
            registry.set(this.id, this);
        }
        setTimeout(() => {
            if (!this.destroyed && !this.disconnected) this.emit('open', this.id);
        }, this._openDelay());
    }

    /**
     * Leave the signalling server. Synchronous 'disconnected', once; DataConnections
     * are untouched ("Does not close any active connections").
     */
    disconnect() {
        if (this.disconnected) return;
        this.disconnected = true;
        // Only the holder of the registration frees it: a peer that lost an id race
        // and was answered 'unavailable-id' must not evict the true holder on its way out.
        //
        // A real PeerServer does not free it at once either: it holds a dropped id for
        // its alive_timeout (~60 s), which is exactly why re-registering after an
        // outage is answered 'unavailable-id' for a while — the branch that must keep
        // the room code rather than roll a new one. MockPeer.aliveTimeoutMs (default 0)
        // models that; leave it at 0 for tests that just want the id back.
        if (registry.get(this.id) === this) {
            const hold = MockPeer.aliveTimeoutMs || 0;
            if (hold > 0) {
                setTimeout(() => { if (registry.get(this.id) === this) registry.delete(this.id); }, hold);
            } else {
                registry.delete(this.id);
            }
        }
        this.emit('disconnected', this.id);
    }

    destroy() {
        if (this.destroyed) return;
        this.disconnect();
        this.destroyed = true;
        // Close all connections, plainly (synchronous local 'close' on each)
        for (const conn of this._connections.splice(0)) {
            if (!conn._closed) {
                conn.close();
            }
        }
        this.emit('close');
    }

    // --- Test helpers ---

    /**
     * Simulate network failure - new connections will fail.
     */
    disableNetwork() {
        this._networkDisabled = true;
    }

    /**
     * Re-enable network.
     */
    enableNetwork() {
        this._networkDisabled = false;
    }

    /**
     * Simulate disconnection from signaling server.
     */
    simulateDisconnect() {
        this.disconnect();
    }

    /**
     * Simulate all existing connections dropping.
     */
    simulateConnectionDrop() {
        for (const conn of this._connections.slice()) {
            if (!conn._closed) {
                conn.close();
            }
        }
    }
}

/** Static default for registration delay; resetRegistry() puts it back to 0. */
MockPeer.openDelayMs = 0;

/**
 * How long the registry keeps a disconnected peer's id (the PeerServer's
 * alive_timeout). 0 = freed immediately; resetRegistry() puts it back to 0.
 */
MockPeer.aliveTimeoutMs = 0;

/**
 * A page whose JavaScript stops running: a locked / backgrounded phone.
 *
 * It does not drop its DataChannel; it stops executing. No timer callback fires and
 * no message event is dispatched. On resume the buffered messages are delivered and
 * the overdue timer fires once. That is all this models: emits on the client's own
 * MockDataConnection are buffered and the client's heartbeat timer is stopped. The
 * host, the wire, the mock and Date.now() are untouched.
 */
function freezePage(client) {
    const conn = client.connection;
    const realEmit = conn.emit.bind(conn);
    const buffered = [];

    // Screen off: events queue up in the browser instead of being dispatched to the page...
    conn.emit = (event, ...args) => { buffered.push([event, args]); };
    // ...and no timer callback runs.
    client._stopHeartbeat();

    return {
        get bufferedCount() { return buffered.length; },
        /** Screen back on: the page can execute again. Nothing has been delivered yet. */
        wake() { conn.emit = realEmit; },
        /** The browser hands the page the messages that arrived while it was frozen. */
        deliverBufferedMessages() {
            for (const [event, args] of buffered.splice(0)) realEmit(event, ...args);
        },
        /** The page's overdue timers start running again. */
        resumeTimers() { client._startHeartbeat(); },
    };
}

export {
    MockPeer,
    MockDataConnection,
    SimpleEmitter,
    resetRegistry,
    registry,
    flushMicrotasks,
    waitForEvent,
    waitForEvents,
    generateMockPeerId,
    freezePage,
};
