/**
 * SlopNet - PeerJS Connection Management Library
 *
 * Provides robust host/client peer-to-peer networking with:
 * - Automatic reconnection with exponential backoff
 * - Heartbeat-based connection health monitoring
 * - Message queuing during disconnection
 * - Reconnect window for temporary client absence
 * - Typed event emitter system
 *
 * Usage (via script tag):
 *   <script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>
 *   <script src="/lib/slopnet/slopnet.js"></script>
 *   const host = new SlopNet.PeerHost({ roomPrefix: 'myapp-' });
 *   const client = new SlopNet.PeerClient({ roomPrefix: 'myapp-' });
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.SlopNet = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // =========================================================================
    // TypedEmitter
    // =========================================================================
    class TypedEmitter {
        constructor() {
            this._listeners = {};
        }

        on(event, fn) {
            if (!this._listeners[event]) {
                this._listeners[event] = [];
            }
            this._listeners[event].push(fn);
            return this;
        }

        off(event, fn) {
            const list = this._listeners[event];
            if (!list) return this;
            if (fn) {
                this._listeners[event] = list.filter(f => f !== fn);
            } else {
                delete this._listeners[event];
            }
            return this;
        }

        once(event, fn) {
            const wrapper = (...args) => {
                this.off(event, wrapper);
                fn.apply(this, args);
            };
            wrapper._original = fn;
            return this.on(event, wrapper);
        }

        emit(event, ...args) {
            const list = this._listeners[event];
            if (!list) return false;
            for (const fn of list.slice()) {
                fn.apply(this, args);
            }
            return true;
        }

        removeAllListeners(event) {
            if (event) {
                delete this._listeners[event];
            } else {
                this._listeners = {};
            }
            return this;
        }

        listenerCount(event) {
            return (this._listeners[event] || []).length;
        }
    }

    // =========================================================================
    // Default configuration
    // =========================================================================

    /**
     * A client that has run out of ladder is not necessarily gone — a pocket, a lift,
     * a tunnel and a locked phone all look identical from here — so it keeps knocking
     * at the plateau interval (reconnectBackoffMax) for the same number of attempts
     * again before it finally reports 'reconnect-failed'.
     *
     * maxReconnectAttempts is therefore the size of the LADDER (the attempts whose
     * growing backoff has to fit inside the host's reconnect window), not a hard cap
     * on how many times a client knocks. The number reported by 'reconnecting' is
     * clamped to maxReconnectAttempts so a UI never renders "attempt 27 of 20".
     */
    const CLIENT_RETRY_LADDER_REPEATS = 2;

    /**
     * Upper bound on host->client messages held for a client that is inside its
     * reconnect window. The record (and its queue) is dropped wholesale when the
     * window expires, so this only bounds a single absence.
     */
    const MAX_QUEUED_MESSAGES = 200;

    const DEFAULT_CONFIG = {
        roomPrefix: 'slop-',
        roomCodeLength: 6,
        roomCodeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
        peerOptions: { debug: 0 },
        reliable: true,

        // --- Reconnection -----------------------------------------------------
        //
        // THESE FOUR AND reconnectWindowMs ARE ONE SETTING, NOT FIVE. The client's
        // ladder must land entirely INSIDE the window the host holds the seat for,
        // or the client spends the tail of its budget dialling a host that has
        // already forgotten it — and every consumer runs an unknown clientId
        // through its keep-strangers-out mid-game validation and refuses the
        // returning player their own seat.
        //
        //   ladder = sum of computeBackoff(i) for i in [0, maxReconnectAttempts)
        //          = 1000 + 1500 + 2250 + 3375 + 5062 + 6000 x 15
        //          = 103,187ms   <   reconnectWindowMs (120,000ms)      ✓
        //
        // If you change any of the four, re-check that sum against the window (the
        // repro-1 test asserts it). reconnectBackoffMax used to be 15,000, which
        // put the ladder at 227,172ms — 107 seconds of it beyond the window.
        maxReconnectAttempts: 20,
        reconnectBackoffBase: 1000,
        reconnectBackoffMultiplier: 1.5,
        reconnectBackoffMax: 6000,

        // Heartbeat
        heartbeatInterval: 5000,
        heartbeatTimeout: 15000,

        // Reconnect window (how long host keeps a slot for a disconnected client).
        // After it expires the seat is released to the app ('client-lost'), but the
        // identity is remembered: a player who comes back later is still announced
        // as a rejoin, never as a stranger.
        reconnectWindowMs: 120000,

        // Connection timeout
        connectionTimeout: 10000,
    };

    function mergeConfig(defaults, overrides) {
        const result = Object.assign({}, defaults);
        if (overrides) {
            for (const key of Object.keys(overrides)) {
                if (overrides[key] !== undefined) {
                    result[key] = overrides[key];
                }
            }
        }
        return result;
    }

    function generateRoomCode(length, chars) {
        let code = '';
        for (let i = 0; i < length; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    }

    function computeBackoff(attempt, base, multiplier, max) {
        return Math.min(base * Math.pow(multiplier, attempt), max);
    }

    // =========================================================================
    // PeerHost
    // =========================================================================

    /**
     * Events:
     *   'ready'          (roomCode)          - Host peer opened, ready to accept connections.
     *                                          Re-emitted after a signalling reconnect, ALWAYS
     *                                          with the same room code the room was created with.
     *   'client-joined'  (clientId, metadata) - A clientId this room has never seen connected
     *   'client-rejoined'(clientId, metadata) - A clientId this room knows is back. Covers all
     *                                          three ways that happens: a rejoin inside the
     *                                          reconnect window, a return after 'client-lost',
     *                                          and a client that answered a ping after the host
     *                                          had written it off as silent.
     *   'client-left'    (clientId, metadata) - This client's data connection dropped or went
     *                                          silent. Temporary: the seat is held for
     *                                          reconnectWindowMs. NOT emitted when the HOST
     *                                          loses its own signalling socket — that says
     *                                          nothing about anybody's data channel.
     *   'client-lost'    (clientId, metadata) - Client exceeded reconnect window, seat released
     *   'data'           (clientId, data)     - Data received from a client
     *   'error'          (error)              - Error on the host peer
     *   'reconnecting'   (attempt, max)       - Host is re-registering with the signaling server
     *   'reconnected'    ()                   - Host re-registered under the SAME room code
     *   'reconnect-failed' ()                 - Host exhausted reconnection attempts
     *   'destroyed'      ()                   - Host peer destroyed
     */
    class PeerHost extends TypedEmitter {
        constructor(config) {
            super();
            this.config = mergeConfig(DEFAULT_CONFIG, config);
            this.peer = null;
            this.roomCode = '';
            this.peerId = '';

            // Map<peerId, { conn, clientId, metadata, disconnected, disconnectedAt }>
            this.clients = new Map();

            // Map<clientId, metadata> — players whose reconnect window expired. They are
            // no longer seated, but they are not strangers either: see _handleData.
            this._pastClients = new Map();

            this._heartbeatTimer = null;
            this._reconnectAttempts = 0;
            this._reconnectTimer = null;
            this._reconnectWindowTimers = new Map();
            this._started = false;
            this._destroyed = false;

            // Signalling peer bookkeeping. Handlers are tracked next to the peer they
            // are attached to so a peer can always be silenced before it is dropped.
            this._peerHandlers = null;
            this._pendingPeer = null;        // re-registration in flight
            this._pendingHandlers = null;
            this._retiredPeers = [];         // replaced peers that still own live channels
            this._reconnecting = false;

            // Dependency injection for testing
            this._PeerClass = (config && config._PeerClass) || (typeof Peer !== 'undefined' ? Peer : null);
        }

        /**
         * Start the host and register with the PeerJS signaling server.
         * @param {string} [roomCode] - Optional room code (generated if not provided)
         * @returns {Promise<string>} The room code
         */
        start(roomCode) {
            if (this._destroyed) throw new Error('Host has been destroyed');
            if (this._started) throw new Error('Host already started');
            this._started = true;

            this.roomCode = roomCode || generateRoomCode(this.config.roomCodeLength, this.config.roomCodeChars);
            this.peerId = this.config.roomPrefix + this.roomCode;

            return new Promise((resolve, reject) => {
                this._createPeer(resolve, reject);
            });
        }

        _newPeer() {
            const PeerClass = this._PeerClass;
            if (!PeerClass) throw new Error('PeerJS not loaded');
            return new PeerClass(this.peerId, this.config.peerOptions);
        }

        _attachHandlers(peer, handlers) {
            for (const event of Object.keys(handlers)) peer.on(event, handlers[event]);
            return handlers;
        }

        /**
         * Take our listeners off a peer. Always do this BEFORE destroying it: peerjs's
         * destroy() calls disconnect(), which emits 'disconnected' synchronously, so a
         * peer we are in the middle of throwing away can otherwise re-enter the very
         * reconnect logic that is throwing it away.
         */
        _detachHandlers(peer, handlers) {
            if (!peer || !handlers) return;
            for (const event of Object.keys(handlers)) {
                try { peer.off(event, handlers[event]); } catch (e) {}
            }
        }

        /** Silence and destroy a peer that never opened (it owns no data channels). */
        _discardPeer(peer, handlers) {
            this._detachHandlers(peer, handlers);
            try { peer.destroy(); } catch (e) {}
        }

        /**
         * Initial registration only. A reconnect goes through _doReconnect, which keeps
         * the room code it was given; only this path is allowed to pick a new one.
         */
        _createPeer(resolve, reject) {
            if (this._destroyed) return;

            const peer = this._newPeer();
            const handlers = {
                open: () => {
                    this._adoptPeer(peer, handlers);
                    this._reconnectAttempts = 0;
                    this._reconnecting = false;
                    this._clearReconnectTimer();
                    this._startHeartbeat();
                    this.emit('ready', this.roomCode);
                    if (resolve) {
                        const done = resolve;
                        resolve = null;
                        reject = null;
                        done(this.roomCode);
                    }
                },
                error: (err) => {
                    if (err.type === 'unavailable-id' && resolve) {
                        // Room code collision during initial start: the id belongs to
                        // somebody else's room, so take another one. Nothing has been
                        // shown to a player yet, so nothing is stranded.
                        //
                        // A RECONNECT must never come through here. There the id we are
                        // refused is our OWN, still held by a PeerServer that has not yet
                        // noticed our socket died (~60s alive_timeout), and re-rolling it
                        // would abandon the code already painted on the host's screen.
                        this._discardPeer(peer, handlers);
                        if (this.peer === peer) { this.peer = null; this._peerHandlers = null; }
                        this.roomCode = generateRoomCode(this.config.roomCodeLength, this.config.roomCodeChars);
                        this.peerId = this.config.roomPrefix + this.roomCode;
                        this._createPeer(resolve, reject);
                        return;
                    }

                    this.emit('error', err);

                    if (this._started && !this._destroyed) {
                        this._startReconnect();
                    }

                    if (reject) {
                        const fail = reject;
                        resolve = null;
                        reject = null;
                        fail(err);
                    }
                },
                disconnected: () => {
                    if (this._started && !this._destroyed && this.peer === peer) {
                        this._startReconnect();
                    }
                },
            };

            this._attachHandlers(peer, handlers);
            // Exposed before 'open' so callers (and the error path above) always have a
            // peer to look at while the very first registration is in flight.
            this.peer = peer;
            this._peerHandlers = handlers;
        }

        /**
         * Make `peer` the live signalling peer and retire whatever was live before it.
         */
        _adoptPeer(peer, handlers) {
            const previous = this.peer;
            const previousHandlers = this._peerHandlers;
            this.peer = peer;
            this._peerHandlers = handlers;
            this._setupConnectionHandler();
            if (previous && previous !== peer) this._retirePeer(previous, previousHandlers);
        }

        /**
         * A peer we have replaced. Its listeners come off immediately, but it is kept
         * alive until the room is torn down, for two reasons:
         *
         *   - Peer#destroy() closes every DataConnection it owns, and those channels are
         *     the game. They are carried by the native WebRTC stack and are unaffected by
         *     the signalling outage that made us replace the peer in the first place.
         *   - its replacement is registered under the SAME id, and tearing the old object
         *     down is one plausible way to have the server drop that registration.
         *
         * A dead signalling socket costs nothing, and a host accumulates one of these per
         * outage — a handful over a session. destroy() cleans them all up.
         */
        _retirePeer(peer, handlers) {
            // Only the lifecycle handlers come off. Its 'connection' handler stays: a
            // client that was already dialling this peer when the socket died still
            // deserves to be let in, and the channel it opens works like any other.
            this._detachHandlers(peer, handlers);
            this._retiredPeers.push(peer);
        }

        _setupConnectionHandler() {
            if (!this.peer) return;
            this.peer.on('connection', (conn) => {
                conn.on('open', () => {
                    // Wait for data (join message)
                });

                conn.on('data', (data) => {
                    this._handleData(conn, data);
                });

                conn.on('close', () => {
                    this._handleDisconnect(conn);
                });

                conn.on('error', () => {
                    this._handleDisconnect(conn);
                });
            });
        }

        _handleData(conn, data) {
            // Handle join messages
            if (data && data.type === '__slopnet_join') {
                const clientId = data.clientId || conn.peer;
                const metadata = data.metadata || {};

                // Check if this is a reconnection
                const existing = this._findClientByClientId(clientId);
                if (existing) {
                    // Reconnection
                    const oldPeerId = existing.peerId;
                    existing.conn = conn;
                    existing.peerId = conn.peer;
                    existing.disconnected = false;
                    existing.disconnectedAt = null;
                    existing._lastPong = Date.now();
                    existing._pingsAwaitingPong = 0;
                    existing.metadata = metadata;

                    // Clear reconnect window timer
                    this._clearReconnectWindowTimer(clientId);

                    // Update map key if peer ID changed
                    if (oldPeerId !== conn.peer) {
                        this.clients.delete(oldPeerId);
                        this.clients.set(conn.peer, existing);
                    }

                    conn.send({ type: '__slopnet_join_ack', reconnected: true, clientId });
                    // Drain the backlog BEFORE announcing the rejoin. emit() is
                    // synchronous, and apps push current state straight from their
                    // 'rejoined' handler — so flushing afterwards lands the stale queue
                    // on top of the fresh state and the player's last render is the
                    // oldest message in it. _noteClientAlive orders these the same way.
                    this._flushClientQueue(existing);
                    this.emit('client-rejoined', clientId, metadata);
                    return;
                }

                // A player whose reconnect window expired is still not a stranger.
                // Consumers gate "no new players once the game has started" on
                // 'client-joined', so announcing a returning player as new is exactly
                // what refuses them their own seat.
                const returning = this._pastClients.has(clientId);
                if (returning) this._pastClients.delete(clientId);

                const clientInfo = {
                    conn,
                    peerId: conn.peer,
                    clientId,
                    metadata,
                    disconnected: false,
                    disconnectedAt: null,
                    _lastPong: Date.now(),
                    _pingsAwaitingPong: 0,
                    _messageQueue: [],
                };
                this.clients.set(conn.peer, clientInfo);
                conn.send({ type: '__slopnet_join_ack', reconnected: returning, clientId });
                this.emit(returning ? 'client-rejoined' : 'client-joined', clientId, metadata);
                return;
            }

            // Every other inbound message — ping, pong or game traffic — is proof this
            // link is alive, and is counted as such before anything else looks at it.
            const client = this.clients.get(conn.peer);
            this._noteClientAlive(client);

            // Handle internal heartbeat messages
            if (data && data.type === '__slopnet_ping') {
                try { conn.send({ type: '__slopnet_pong' }); } catch (e) {}
                return;
            }
            if (data && data.type === '__slopnet_pong') {
                return;
            }

            // Regular data message
            const clientId = client ? client.clientId : conn.peer;
            this.emit('data', clientId, data);
        }

        /**
         * Record that we have heard from a client.
         *
         * Liveness used to advance only on a pong, i.e. only in reply to a ping the host
         * itself sent from a timer. That made `now - _lastPong` a measure of the spacing
         * of the HOST's own timer wakes rather than of the client's silence — and a
         * backgrounded tab gets one wake a minute.
         */
        _noteClientAlive(client) {
            if (!client) return;
            client._lastPong = Date.now();
            client._pingsAwaitingPong = 0;
            if (!client.disconnected) return;

            client.disconnected = false;
            client.disconnectedAt = null;
            this._clearReconnectWindowTimer(client.clientId);
            this._flushClientQueue(client);
            // The host had given up on this seat ('client-left') and the player turned
            // out to have been there the whole time. Say so out loud: 'client-rejoined'
            // is the event consumers use to put a player back in their seat, and without
            // it slopnet and the app disagree about the same peer forever.
            this.emit('client-rejoined', client.clientId, client.metadata);
        }

        _findClientByClientId(clientId) {
            for (const [, info] of this.clients) {
                if (info.clientId === clientId) return info;
            }
            return null;
        }

        _handleDisconnect(conn) {
            const client = this.clients.get(conn.peer);
            if (!client) return;
            if (client.disconnected) {
                // Already marked. Make sure the seat can still be reclaimed anyway: a
                // client marked down without a window timer is a permanent zombie —
                // 'client-lost' can never fire for it and nothing else ever removes it.
                if (this.config.reconnectWindowMs > 0 && !this._reconnectWindowTimers.has(client.clientId)) {
                    this._armReconnectWindow(client);
                }
                return;
            }

            client.disconnected = true;
            client.disconnectedAt = Date.now();
            this.emit('client-left', client.clientId, client.metadata);

            // Start reconnect window timer
            if (this.config.reconnectWindowMs > 0) {
                this._armReconnectWindow(client);
            } else {
                this.clients.delete(client.peerId);
                this.emit('client-lost', client.clientId, client.metadata);
            }
        }

        _armReconnectWindow(client) {
            const timer = setTimeout(() => {
                this._reconnectWindowTimers.delete(client.clientId);
                if (!client.disconnected) return;
                this.clients.delete(client.peerId);
                // The seat goes back to the game, but remember who held it: if this
                // player turns up again they are a rejoin, not a stranger.
                this._pastClients.set(client.clientId, client.metadata);
                this.emit('client-lost', client.clientId, client.metadata);
            }, this.config.reconnectWindowMs);
            this._reconnectWindowTimers.set(client.clientId, timer);
        }

        /**
         * Send data to a specific client by clientId.
         * @returns {boolean} true if it went out on the wire now. A message for a client
         *   whose seat is still being held is queued (and reported false), not dropped.
         */
        send(clientId, data) {
            const client = this._findClientByClientId(clientId);
            if (!client) return false;
            if (client.disconnected || !client.conn || !client.conn.open) {
                this._queueForClient(client, data);
                return false;
            }
            try {
                client.conn.send(data);
                return true;
            } catch (e) {
                this._queueForClient(client, data);
                return false;
            }
        }

        /**
         * Broadcast data to all clients, including those inside their reconnect window
         * (their copy is queued until they are back).
         * @param {*} data
         * @param {string[]} [excludeClientIds] - Client IDs to exclude
         */
        broadcast(data, excludeClientIds) {
            const exclude = new Set(excludeClientIds || []);
            for (const [, client] of this.clients) {
                if (exclude.has(client.clientId)) continue;
                if (client.disconnected || !client.conn || !client.conn.open) {
                    this._queueForClient(client, data);
                    continue;
                }
                try { client.conn.send(data); } catch (e) { this._queueForClient(client, data); }
            }
        }

        /**
         * Hold a host->client message for a client whose seat is still held.
         *
         * The client->host direction has always queued (PeerClient.send), while this
         * direction silently dropped — which is how a phone that locked for twenty
         * seconds comes back to a game two rounds stale, with an error on nobody's
         * screen. If the seat is not being held at all there is nothing to come back
         * to, so nothing is kept.
         */
        _queueForClient(client, data) {
            if (this.config.reconnectWindowMs <= 0) return;
            if (!client._messageQueue) client._messageQueue = [];
            client._messageQueue.push(data);
            if (client._messageQueue.length > MAX_QUEUED_MESSAGES) {
                client._messageQueue.splice(0, client._messageQueue.length - MAX_QUEUED_MESSAGES);
            }
        }

        _flushClientQueue(client) {
            if (!client || !client._messageQueue || !client._messageQueue.length) return;
            if (!client.conn || !client.conn.open) return;
            const queue = client._messageQueue.splice(0);
            for (let i = 0; i < queue.length; i++) {
                try {
                    client.conn.send(queue[i]);
                } catch (e) {
                    // Put the tail back, in order, ahead of anything queued since.
                    client._messageQueue = queue.slice(i).concat(client._messageQueue);
                    break;
                }
            }
        }

        /**
         * Get the list of connected client IDs.
         */
        getConnectedClientIds() {
            const ids = [];
            for (const [, client] of this.clients) {
                if (!client.disconnected) ids.push(client.clientId);
            }
            return ids;
        }

        /**
         * Get the list of disconnected client IDs (within reconnect window).
         */
        getDisconnectedClientIds() {
            const ids = [];
            for (const [, client] of this.clients) {
                if (client.disconnected) ids.push(client.clientId);
            }
            return ids;
        }

        /**
         * Get all client IDs (connected and disconnected).
         */
        getAllClientIds() {
            const ids = [];
            for (const [, client] of this.clients) {
                ids.push(client.clientId);
            }
            return ids;
        }

        /**
         * Check if a specific client is connected.
         */
        isClientConnected(clientId) {
            const client = this._findClientByClientId(clientId);
            return client ? !client.disconnected : false;
        }

        /**
         * Remove a client entirely (kick).
         */
        removeClient(clientId) {
            const client = this._findClientByClientId(clientId);
            if (!client) return false;
            this._clearReconnectWindowTimer(clientId);
            // A kick is deliberate, so this clientId must NOT be remembered as a seat
            // holder — otherwise the kicked player walks straight back in as a rejoin.
            this._pastClients.delete(clientId);
            try { client.conn.close(); } catch (e) {}
            this.clients.delete(client.peerId);
            return true;
        }

        // --- Heartbeat ---

        _startHeartbeat() {
            this._stopHeartbeat();
            if (this.config.heartbeatInterval <= 0) return;

            // How many pings we must have actually SENT and had ignored before silence
            // is evidence of anything.
            //
            // The wall clock on its own is not that evidence: this callback runs on a
            // JS timer, and a hidden tab's timers are throttled to about one wake a
            // minute. Judging `now - _lastPong` on the tick that discovers a long gap
            // convicts every client of a silence that is really the spacing of our own
            // wakes — one late wake used to evict a whole table in a single loop pass,
            // permanently, while every data channel was still carrying traffic.
            const missesAllowed = Math.max(
                1,
                Math.ceil(this.config.heartbeatTimeout / this.config.heartbeatInterval)
            );

            this._heartbeatTimer = setInterval(() => {
                const now = Date.now();
                for (const [, client] of this.clients) {
                    if (client.disconnected) continue;
                    if (!client.conn || !client.conn.open) continue;

                    const silentFor = client._lastPong ? now - client._lastPong : 0;
                    if ((client._pingsAwaitingPong || 0) >= missesAllowed &&
                        silentFor > this.config.heartbeatTimeout) {
                        this._handleDisconnect(client.conn);
                        continue;
                    }

                    // Ping first, judge on a later wake: the tick that finds a big gap is
                    // exactly the tick whose own ping has not been answered yet.
                    try {
                        client.conn.send({ type: '__slopnet_ping' });
                        client._pingsAwaitingPong = (client._pingsAwaitingPong || 0) + 1;
                    } catch (e) {}
                }
            }, this.config.heartbeatInterval);
        }

        _stopHeartbeat() {
            if (this._heartbeatTimer) {
                clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
            }
        }

        // --- Host reconnection to signaling server ---

        /**
         * The host lost its SIGNALLING socket — nothing more.
         *
         * PeerJS keeps that socket alive with a plain JS timer, so on a backgrounded
         * phone the server reaps it after ~60s and peerjs emits error{network} and then
         * 'disconnected'. It deliberately leaves every DataConnection alone ("Does not
         * close any active connections"), because those are native WebRTC and are still
         * carrying the game. So nobody is evicted here and the heartbeat keeps running:
         * the only thing that has to be repaired is our registration, which matters for
         * players who want to (re)join from now on.
         */
        _startReconnect() {
            if (this._destroyed || !this._started) return;
            // One ladder at a time. The old guard was `if (this._reconnectTimer) return`,
            // which is null for the whole time an attempt is in flight — so a
            // 'disconnected' raised by that very attempt re-entered here, reset the
            // attempt counter and armed a second ladder on top of the first. Backoff
            // stayed pinned at the base and the attempt cap could never be reached.
            if (this._reconnecting) return;

            this._reconnecting = true;
            this._reconnectAttempts = 0;   // a fresh outage starts a fresh ladder — and
                                           // ONLY a fresh outage does
            this._attemptReconnect();
        }

        _attemptReconnect() {
            if (this._destroyed) return;
            if (this._reconnectAttempts >= this.config.maxReconnectAttempts) {
                this._reconnecting = false;
                this.emit('reconnect-failed');
                return;
            }

            const delay = computeBackoff(
                this._reconnectAttempts,
                this.config.reconnectBackoffBase,
                this.config.reconnectBackoffMultiplier,
                this.config.reconnectBackoffMax
            );
            this._reconnectAttempts++;
            this.emit('reconnecting', this._reconnectAttempts, this.config.maxReconnectAttempts);

            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                this._doReconnect();
            }, delay);
        }

        /**
         * Re-register under the SAME peer id, alongside the peer we already have.
         *
         * Two things this deliberately does not do:
         *   - it does not destroy the old peer first. Destroying it closes every data
         *     channel it owns (the game), and it also kills a registration that may
         *     still be in flight, which is what turned a single tunnel dip into an
         *     endless destroy/re-arm loop that never recovered.
         *   - it does not re-roll the room code when the server says the id is taken.
         *     On this path the id we are refused is our own.
         */
        _doReconnect() {
            if (this._destroyed) return;

            let peer;
            try {
                peer = this._newPeer();
            } catch (e) {
                this._reconnecting = false;
                this.emit('error', e);
                return;
            }

            const handlers = {
                open: () => {
                    if (this._pendingPeer !== peer) return;
                    this._pendingPeer = null;
                    this._pendingHandlers = null;
                    this._adoptPeer(peer, handlers);
                    this._reconnecting = false;
                    this._reconnectAttempts = 0;
                    this._clearReconnectTimer();
                    this._startHeartbeat();
                    // Same code as always: 'ready' re-announces the room, it never
                    // renames it.
                    this.emit('ready', this.roomCode);
                    this.emit('reconnected');
                },
                error: (err) => {
                    if (this._pendingPeer !== peer) return;
                    // 'unavailable-id' here means the PeerServer has not yet reaped the
                    // socket that died with the radio, so it is still holding OUR id.
                    // That is expected and self-healing — keep the id, keep quiet, and
                    // try again after the next backoff.
                    if (err.type !== 'unavailable-id') this.emit('error', err);
                    this._failedAttempt(peer, handlers);
                },
                disconnected: () => {
                    if (this._pendingPeer !== peer) return;
                    // The attempt's own socket died before it registered.
                    this._failedAttempt(peer, handlers);
                },
            };

            this._pendingPeer = peer;
            this._pendingHandlers = handlers;
            this._attachHandlers(peer, handlers);
        }

        _failedAttempt(peer, handlers) {
            this._pendingPeer = null;
            this._pendingHandlers = null;
            this._discardPeer(peer, handlers);
            this._attemptReconnect();
        }

        _clearReconnectTimer() {
            if (this._reconnectTimer) {
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = null;
            }
        }

        _clearReconnectWindowTimer(clientId) {
            const timer = this._reconnectWindowTimers.get(clientId);
            if (timer) {
                clearTimeout(timer);
                this._reconnectWindowTimers.delete(clientId);
            }
        }

        /** Tear down every signalling peer this host has ever owned. */
        _destroyPeer() {
            if (this.peer) {
                // Listeners off first — peerjs's destroy() emits 'disconnected'
                // synchronously and a dying peer must not drive the state machine.
                this._detachHandlers(this.peer, this._peerHandlers);
                try { this.peer.destroy(); } catch (e) {}
                this.peer = null;
                this._peerHandlers = null;
            }
            if (this._pendingPeer) {
                this._discardPeer(this._pendingPeer, this._pendingHandlers);
                this._pendingPeer = null;
                this._pendingHandlers = null;
            }
            for (const peer of this._retiredPeers.splice(0)) {
                try { peer.destroy(); } catch (e) {}
            }
        }

        /**
         * Destroy the host and clean up all resources.
         */
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this._started = false;
            this._reconnecting = false;

            this._stopHeartbeat();
            this._clearReconnectTimer();

            for (const [clientId, timer] of this._reconnectWindowTimers) {
                clearTimeout(timer);
            }
            this._reconnectWindowTimers.clear();

            for (const [, client] of this.clients) {
                try { client.conn.close(); } catch (e) {}
            }
            this.clients.clear();
            this._pastClients.clear();

            this._destroyPeer();
            this.emit('destroyed');
            this.removeAllListeners();
        }
    }

    // =========================================================================
    // PeerClient
    // =========================================================================

    /**
     * Events:
     *   'connected'       ()              - Connected to host
     *   'reconnected'     ()              - Reconnected to host after disconnect
     *   'data'            (data)          - Data received from host
     *   'disconnected'    ()              - Disconnected from host
     *   'reconnecting'    (attempt, max)  - Attempting to reconnect
     *   'reconnect-failed' ()             - Exhausted reconnection attempts
     *   'error'           (error)         - Error occurred
     *   'destroyed'       ()              - Client peer destroyed
     */
    class PeerClient extends TypedEmitter {
        constructor(config) {
            super();
            this.config = mergeConfig(DEFAULT_CONFIG, config);
            this.peer = null;
            this.connection = null;
            this.roomCode = '';
            this.clientId = '';
            this.metadata = {};

            this._connected = false;
            this._hasConnectedOnce = false;
            this._reconnectAttempts = 0;
            this._reconnectTimer = null;
            this._heartbeatTimer = null;
            this._lastPongTime = 0;
            this._pingsAwaitingPong = 0;   // pings sent since we last heard anything back
            this._messageQueue = [];
            this._destroyed = false;

            // Dependency injection for testing
            this._PeerClass = (config && config._PeerClass) || (typeof Peer !== 'undefined' ? Peer : null);
        }

        /**
         * Connect to a host room.
         * @param {string} roomCode
         * @param {string} clientId - Unique client identifier (used for reconnection)
         * @param {object} [metadata] - Metadata to send with join message
         * @returns {Promise<void>}
         */
        connect(roomCode, clientId, metadata) {
            if (this._destroyed) throw new Error('Client has been destroyed');
            if (this._connected) throw new Error('Client already connected');

            this.roomCode = roomCode;
            this.clientId = clientId;
            this.metadata = metadata || {};

            return new Promise((resolve, reject) => {
                this._createPeerAndConnect(resolve, reject);
            });
        }

        _createPeerAndConnect(resolve, reject) {
            if (this._destroyed) return;

            const PeerClass = this._PeerClass;
            if (!PeerClass) throw new Error('PeerJS not loaded');

            this._destroyPeer();

            this.peer = new PeerClass(undefined, this.config.peerOptions);

            const overallTimeout = setTimeout(() => {
                if (!this._connected) {
                    const err = new Error('Connection timeout');
                    err.type = 'connection-timeout';
                    this.emit('error', err);
                    if (this._hasConnectedOnce) {
                        this._attemptReconnect();
                    } else if (reject) {
                        reject(err);
                        resolve = null;
                        reject = null;
                    }
                }
            }, this.config.connectionTimeout);

            this.peer.on('open', () => {
                const hostPeerId = this.config.roomPrefix + this.roomCode;
                this.connection = this.peer.connect(hostPeerId, { reliable: this.config.reliable });

                this.connection.on('open', () => {
                    // Send join message
                    this.connection.send({
                        type: '__slopnet_join',
                        clientId: this.clientId,
                        metadata: this.metadata,
                    });
                });

                this.connection.on('data', (data) => {
                    this._handleData(data, overallTimeout, resolve);
                    // Null out resolve after first use
                    if (resolve === null) return;
                });

                this.connection.on('close', () => {
                    clearTimeout(overallTimeout);
                    this._onDisconnect();
                });

                this.connection.on('error', () => {
                    clearTimeout(overallTimeout);
                    this._onDisconnect();
                });
            });

            this.peer.on('error', (err) => {
                clearTimeout(overallTimeout);
                this.emit('error', err);

                if (this._hasConnectedOnce) {
                    this._attemptReconnect();
                } else if (reject) {
                    reject(err);
                    resolve = null;
                    reject = null;
                }
            });

            this.peer.on('disconnected', () => {
                if (!this._hasConnectedOnce || this._destroyed) return;
                // Losing the signalling socket is not losing the game. PeerJS keeps that
                // socket alive with a JS timer, so a backgrounded phone loses it on its
                // own after ~60s, while the DataConnection — native WebRTC, no JS timer
                // involved — keeps carrying every message. Tearing down here would kill a
                // healthy channel for a reason that has nothing to do with it.
                if (this.connection && this.connection.open) return;
                this._onDisconnect();
            });
        }

        _handleData(data, overallTimeout, resolve) {
            // Handle internal messages
            if (data && data.type === '__slopnet_join_ack') {
                clearTimeout(overallTimeout);
                const wasConnected = this._connected;
                this._connected = true;
                this._hasConnectedOnce = true;
                this._reconnectAttempts = 0;
                this._clearReconnectTimer();
                this._lastPongTime = Date.now();
                this._pingsAwaitingPong = 0;
                this._startHeartbeat();

                // Flush queued messages
                this._flushQueue();

                if (data.reconnected) {
                    this.emit('reconnected');
                } else {
                    this.emit('connected');
                }

                if (resolve) {
                    resolve();
                    resolve = null;
                }
                return;
            }

            // Anything the host says — a ping, a pong or game state — proves the link is
            // alive. Counting only pongs made this a measure of our own timer's wakes,
            // which a locked or backgrounded phone stops delivering.
            this._lastPongTime = Date.now();
            this._pingsAwaitingPong = 0;

            if (data && data.type === '__slopnet_ping') {
                try { this.connection.send({ type: '__slopnet_pong' }); } catch (e) {}
                return;
            }

            if (data && data.type === '__slopnet_pong') {
                return;
            }

            // Regular message
            this.emit('data', data);
        }

        _onDisconnect() {
            if (!this._connected && !this._hasConnectedOnce) return;

            const wasConnected = this._connected;
            this._connected = false;
            this._stopHeartbeat();

            if (wasConnected) {
                this.emit('disconnected');
            }

            if (this._hasConnectedOnce && !this._destroyed) {
                this._attemptReconnect();
            }
        }

        /**
         * Send data to the host.
         * If disconnected, queues the message for delivery on reconnect.
         */
        send(data) {
            if (this._connected && this.connection && this.connection.open) {
                try {
                    this.connection.send(data);
                    return true;
                } catch (e) {
                    this._messageQueue.push(data);
                    return false;
                }
            }
            this._messageQueue.push(data);
            return false;
        }

        _flushQueue() {
            if (!this._connected || !this.connection || !this.connection.open) return;
            const queue = this._messageQueue.splice(0);
            for (const msg of queue) {
                try {
                    this.connection.send(msg);
                } catch (e) {
                    // Re-queue on failure
                    this._messageQueue.unshift(msg);
                    break;
                }
            }
        }

        /**
         * Whether the client is currently connected.
         */
        get isConnected() {
            return this._connected;
        }

        /**
         * Number of messages waiting in the queue.
         */
        get queueSize() {
            return this._messageQueue.length;
        }

        // --- Heartbeat ---

        _startHeartbeat() {
            this._stopHeartbeat();
            if (this.config.heartbeatInterval <= 0) return;

            // Same rule as the host's heartbeat: silence only counts once we have
            // actually sent pings that went unanswered. A phone that was locked for a
            // minute wakes with one overdue tick, and judging that tick on the wall
            // clock alone tore down a connection that had never stopped working.
            const missesAllowed = Math.max(
                1,
                Math.ceil(this.config.heartbeatTimeout / this.config.heartbeatInterval)
            );

            this._heartbeatTimer = setInterval(() => {
                if (!this._connected || !this.connection || !this.connection.open) return;

                const now = Date.now();
                const silentFor = this._lastPongTime ? now - this._lastPongTime : 0;
                if ((this._pingsAwaitingPong || 0) >= missesAllowed &&
                    silentFor > this.config.heartbeatTimeout) {
                    this._onDisconnect();
                    return;
                }

                try {
                    this.connection.send({ type: '__slopnet_ping' });
                    this._pingsAwaitingPong = (this._pingsAwaitingPong || 0) + 1;
                } catch (e) {}
            }, this.config.heartbeatInterval);
        }

        _stopHeartbeat() {
            if (this._heartbeatTimer) {
                clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
            }
        }

        // --- Reconnection ---

        /**
         * How many times we knock in total before reporting 'reconnect-failed'.
         *
         * maxReconnectAttempts is the size of the ladder, which is sized to land
         * entirely inside the host's reconnect window (see DEFAULT_CONFIG). Running out
         * of ladder is not proof the player is gone — the host remembers the seats of
         * players it has lost — so we keep knocking at the plateau interval for another
         * ladder's worth of attempts before giving up on the game.
         */
        _maxTotalAttempts() {
            return this.config.maxReconnectAttempts * CLIENT_RETRY_LADDER_REPEATS;
        }

        _attemptReconnect() {
            if (this._destroyed) return;
            if (this._reconnectTimer) return; // Already waiting for a reconnect attempt
            if (this._reconnectAttempts >= this._maxTotalAttempts()) {
                this.emit('reconnect-failed');
                return;
            }

            const delay = computeBackoff(
                this._reconnectAttempts,
                this.config.reconnectBackoffBase,
                this.config.reconnectBackoffMultiplier,
                this.config.reconnectBackoffMax
            );
            this._reconnectAttempts++;
            // Reported attempt is clamped to the ladder length: past that we are simply
            // repeating the last rung, and "attempt 27 of 20" reads like a bug to a user.
            this.emit(
                'reconnecting',
                Math.min(this._reconnectAttempts, this.config.maxReconnectAttempts),
                this.config.maxReconnectAttempts
            );

            this._reconnectTimer = setTimeout(() => {
                this._reconnectTimer = null;
                this._doReconnect();
            }, delay);
        }

        _doReconnect() {
            if (this._destroyed) return;
            this._createPeerAndConnect(null, null);
        }

        _clearReconnectTimer() {
            if (this._reconnectTimer) {
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = null;
            }
        }

        /**
         * Manually trigger a reconnection attempt (e.g., on visibility change).
         * Resets the attempt counter for a fresh set of retries.
         */
        reconnect() {
            if (this._destroyed) return;
            if (this._connected) return;
            if (!this._hasConnectedOnce) return;

            this._clearReconnectTimer();
            this._reconnectAttempts = 0;
            this._attemptReconnect();
        }

        _destroyPeer() {
            this._stopHeartbeat();
            if (this.connection) {
                try { this.connection.close(); } catch (e) {}
                this.connection = null;
            }
            if (this.peer) {
                try { this.peer.destroy(); } catch (e) {}
                this.peer = null;
            }
        }

        /**
         * Destroy the client and clean up all resources.
         */
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this._connected = false;

            this._clearReconnectTimer();
            this._destroyPeer();
            this._messageQueue = [];

            this.emit('destroyed');
            this.removeAllListeners();
        }
    }

    // =========================================================================
    // Utility exports
    // =========================================================================

    return {
        TypedEmitter,
        PeerHost,
        PeerClient,
        generateRoomCode,
        DEFAULT_CONFIG,
        _computeBackoff: computeBackoff,
    };
});
