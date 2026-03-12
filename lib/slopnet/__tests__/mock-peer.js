/**
 * Mock PeerJS implementation for testing SlopNet.
 *
 * Simulates a PeerJS signaling server in-memory, allowing creation of
 * MockPeer instances that can connect to each other without WebRTC.
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
    }

    send(data) {
        if (this._closed || !this.open) {
            throw new Error('Connection is not open');
        }
        if (!this._remote || this._remote._closed) {
            throw new Error('Remote connection is closed');
        }
        // Deep clone to simulate serialization
        const cloned = JSON.parse(JSON.stringify(data));
        // Deliver asynchronously to simulate network
        setTimeout(() => {
            if (!this._remote._closed && this._remote.open) {
                this._remote.emit('data', cloned);
            }
        }, 0);
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this.open = false;
        setTimeout(() => {
            this.emit('close');
            if (this._remote && !this._remote._closed) {
                this._remote._closed = true;
                this._remote.open = false;
                setTimeout(() => {
                    this._remote.emit('close');
                }, 0);
            }
        }, 0);
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
                if (!this.destroyed) {
                    this.emit('open', this.id);
                }
            }, 0);
        }
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
        if (!remotePeer || remotePeer.destroyed) {
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
            this.emit('open', this.id);
        }, 0);
    }

    disconnect() {
        this.disconnected = true;
        registry.delete(this.id);
        setTimeout(() => {
            this.emit('disconnected');
        }, 0);
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.disconnected = true;
        registry.delete(this.id);
        // Close all connections
        for (const conn of this._connections) {
            if (!conn._closed) {
                conn.close();
            }
        }
        this._connections = [];
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
};
