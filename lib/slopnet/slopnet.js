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
    const DEFAULT_CONFIG = {
        roomPrefix: 'slop-',
        roomCodeLength: 6,
        roomCodeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
        peerOptions: { debug: 0 },
        reliable: true,

        // Reconnection
        maxReconnectAttempts: 20,
        reconnectBackoffBase: 1000,
        reconnectBackoffMultiplier: 1.5,
        reconnectBackoffMax: 15000,

        // Heartbeat
        heartbeatInterval: 5000,
        heartbeatTimeout: 15000,

        // Reconnect window (how long host keeps a slot for a disconnected client)
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
     *   'ready'          (roomCode)          - Host peer opened, ready to accept connections
     *   'client-joined'  (clientId, metadata) - New client connected and sent join message
     *   'client-rejoined'(clientId, metadata) - Existing client reconnected
     *   'client-left'    (clientId, metadata) - Client disconnected
     *   'client-lost'    (clientId, metadata) - Client exceeded reconnect window, removed
     *   'data'           (clientId, data)     - Data received from a client
     *   'error'          (error)              - Error on the host peer
     *   'reconnecting'   (attempt, max)       - Host is reconnecting to signaling server
     *   'reconnected'    ()                   - Host reconnected to signaling server
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

            // Map<clientId, { conn, metadata, disconnected, disconnectedAt }>
            this.clients = new Map();

            this._heartbeatTimer = null;
            this._reconnectAttempts = 0;
            this._reconnectTimer = null;
            this._reconnectWindowTimers = new Map();
            this._started = false;
            this._destroyed = false;

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

        _createPeer(resolve, reject) {
            if (this._destroyed) return;

            const PeerClass = this._PeerClass;
            if (!PeerClass) throw new Error('PeerJS not loaded');

            this.peer = new PeerClass(this.peerId, this.config.peerOptions);

            this.peer.on('open', () => {
                this._reconnectAttempts = 0;
                this._clearReconnectTimer();
                this._setupConnectionHandler();
                this._startHeartbeat();
                this.emit('ready', this.roomCode);
                if (resolve) {
                    resolve(this.roomCode);
                    resolve = null;
                    reject = null;
                }
            });

            this.peer.on('error', (err) => {
                if (err.type === 'unavailable-id' && resolve) {
                    // Room code collision during initial start - regenerate
                    this._destroyPeer();
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
                    reject(err);
                    resolve = null;
                    reject = null;
                }
            });

            this.peer.on('disconnected', () => {
                if (this._started && !this._destroyed) {
                    this._startReconnect();
                }
            });
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
            // Handle internal heartbeat messages
            if (data && data.type === '__slopnet_ping') {
                try { conn.send({ type: '__slopnet_pong' }); } catch (e) {}
                return;
            }
            if (data && data.type === '__slopnet_pong') {
                const client = this.clients.get(conn.peer);
                if (client) {
                    client._lastPong = Date.now();
                    if (client.disconnected) {
                        client.disconnected = false;
                        client.disconnectedAt = null;
                    }
                }
                return;
            }

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

                    // Clear reconnect window timer
                    this._clearReconnectWindowTimer(clientId);

                    // Update map key if peer ID changed
                    if (oldPeerId !== conn.peer) {
                        this.clients.delete(oldPeerId);
                        this.clients.set(conn.peer, existing);
                    }

                    conn.send({ type: '__slopnet_join_ack', reconnected: true, clientId });
                    this.emit('client-rejoined', clientId, metadata);
                    return;
                }

                // New client
                const clientInfo = {
                    conn,
                    peerId: conn.peer,
                    clientId,
                    metadata,
                    disconnected: false,
                    disconnectedAt: null,
                    _lastPong: Date.now(),
                    _messageQueue: [],
                };
                this.clients.set(conn.peer, clientInfo);
                conn.send({ type: '__slopnet_join_ack', reconnected: false, clientId });
                this.emit('client-joined', clientId, metadata);
                return;
            }

            // Regular data message
            const client = this.clients.get(conn.peer);
            const clientId = client ? client.clientId : conn.peer;
            this.emit('data', clientId, data);
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
            if (client.disconnected) return;

            client.disconnected = true;
            client.disconnectedAt = Date.now();
            this.emit('client-left', client.clientId, client.metadata);

            // Start reconnect window timer
            if (this.config.reconnectWindowMs > 0) {
                const timer = setTimeout(() => {
                    this._reconnectWindowTimers.delete(client.clientId);
                    if (client.disconnected) {
                        this.clients.delete(conn.peer);
                        this.emit('client-lost', client.clientId, client.metadata);
                    }
                }, this.config.reconnectWindowMs);
                this._reconnectWindowTimers.set(client.clientId, timer);
            } else {
                this.clients.delete(conn.peer);
                this.emit('client-lost', client.clientId, client.metadata);
            }
        }

        /**
         * Send data to a specific client by clientId.
         */
        send(clientId, data) {
            const client = this._findClientByClientId(clientId);
            if (!client) return false;
            if (client.disconnected || !client.conn || !client.conn.open) {
                return false;
            }
            try {
                client.conn.send(data);
                return true;
            } catch (e) {
                return false;
            }
        }

        /**
         * Broadcast data to all connected clients.
         * @param {*} data
         * @param {string[]} [excludeClientIds] - Client IDs to exclude
         */
        broadcast(data, excludeClientIds) {
            const exclude = new Set(excludeClientIds || []);
            for (const [, client] of this.clients) {
                if (exclude.has(client.clientId)) continue;
                if (client.disconnected || !client.conn || !client.conn.open) continue;
                try { client.conn.send(data); } catch (e) {}
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
            try { client.conn.close(); } catch (e) {}
            this.clients.delete(client.peerId);
            return true;
        }

        // --- Heartbeat ---

        _startHeartbeat() {
            this._stopHeartbeat();
            if (this.config.heartbeatInterval <= 0) return;

            this._heartbeatTimer = setInterval(() => {
                const now = Date.now();
                for (const [, client] of this.clients) {
                    if (client.disconnected) continue;
                    if (!client.conn || !client.conn.open) continue;

                    // Check for timeout
                    if (client._lastPong && (now - client._lastPong) > this.config.heartbeatTimeout) {
                        this._handleDisconnect(client.conn);
                        continue;
                    }

                    try { client.conn.send({ type: '__slopnet_ping' }); } catch (e) {}
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

        _startReconnect() {
            if (this._destroyed) return;
            if (this._reconnectTimer) return; // Already reconnecting

            // Mark all clients as disconnected
            for (const [, client] of this.clients) {
                if (!client.disconnected) {
                    client.disconnected = true;
                    client.disconnectedAt = Date.now();
                    this.emit('client-left', client.clientId, client.metadata);
                }
            }

            this._stopHeartbeat();
            this._reconnectAttempts = 0;
            this._attemptReconnect();
        }

        _attemptReconnect() {
            if (this._destroyed) return;
            if (this._reconnectAttempts >= this.config.maxReconnectAttempts) {
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

        _doReconnect() {
            if (this._destroyed) return;

            this._destroyPeer();

            this._createPeer(
                () => {
                    // Successfully re-registered
                    this.emit('reconnected');
                },
                () => {
                    // Error handled in _createPeer error handler
                }
            );
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

        _destroyPeer() {
            if (this.peer) {
                try { this.peer.destroy(); } catch (e) {}
                this.peer = null;
            }
        }

        /**
         * Destroy the host and clean up all resources.
         */
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this._started = false;

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
                if (this._hasConnectedOnce && !this._destroyed) {
                    this._onDisconnect();
                }
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

            if (data && data.type === '__slopnet_ping') {
                try { this.connection.send({ type: '__slopnet_pong' }); } catch (e) {}
                return;
            }

            if (data && data.type === '__slopnet_pong') {
                this._lastPongTime = Date.now();
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

            this._heartbeatTimer = setInterval(() => {
                if (!this._connected || !this.connection || !this.connection.open) return;

                const now = Date.now();
                if (this._lastPongTime && (now - this._lastPongTime) > this.config.heartbeatTimeout) {
                    this._onDisconnect();
                    return;
                }

                try { this.connection.send({ type: '__slopnet_ping' }); } catch (e) {}
            }, this.config.heartbeatInterval);
        }

        _stopHeartbeat() {
            if (this._heartbeatTimer) {
                clearInterval(this._heartbeatTimer);
                this._heartbeatTimer = null;
            }
        }

        // --- Reconnection ---

        _attemptReconnect() {
            if (this._destroyed) return;
            if (this._reconnectTimer) return; // Already waiting for a reconnect attempt
            if (this._reconnectAttempts >= this.config.maxReconnectAttempts) {
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
