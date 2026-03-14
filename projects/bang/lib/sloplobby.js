/**
 * SlopLobby — Shared lobby & connection management for slop multiplayer games.
 *
 * Provides:
 *   - Utility helpers: $, esc, toast, showScreen
 *   - Persistent clientId via sessionStorage
 *   - Host lifecycle: create room, track players, validate joins
 *   - Client lifecycle: join room, auto-reconnect event wiring
 *   - Standard connection-status toasts
 *
 * Usage:
 *   const lobby = new SlopLobby({
 *     roomPrefix: 'cah-',
 *     storageKey: 'cah-client-id',
 *     onHostData:    (clientId, data) => { ... },
 *     onClientData:  (data) => { ... },
 *     onPlayerJoined:   (clientId, meta) => true | 'reason to reject',
 *     onPlayerRejoined: (clientId, meta) => { ... },
 *     onPlayerLeft:     (clientId, meta) => { ... },
 *   });
 *
 *   // Host
 *   const code = await lobby.createRoom('Alice');
 *   lobby.broadcast({ type: 'state', ... });
 *   lobby.send(clientId, { ... });
 *
 *   // Client
 *   await lobby.joinRoom('ABC123', 'Bob');
 *   lobby.sendToHost({ type: 'action', ... });
 *
 * Depends on: SlopNet (loaded before this script).
 */
(function (root) {
    'use strict';

    /* ── Utility helpers ─────────────────────────────────────────── */

    /** getElementById shorthand */
    function $(id) { return document.getElementById(id); }

    /** HTML-escape a string */
    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    /**
     * Show a toast notification.
     * If a #toast element exists, uses the show-class pattern.
     * If a #toasts container exists, appends an ephemeral child.
     * Otherwise falls back to a temporary fixed element.
     */
    function toast(msg) {
        // Pattern 1: single #toast element with .show class (CAH, herd, flip-7)
        const singleToast = document.getElementById('toast');
        if (singleToast) {
            singleToast.textContent = msg;
            singleToast.classList.add('show');
            clearTimeout(singleToast._tid);
            singleToast._tid = setTimeout(() => singleToast.classList.remove('show'), 3000);
            return;
        }

        // Pattern 2: #toasts container with appended children (texas-holdem)
        const container = document.getElementById('toasts');
        if (container) {
            const el = document.createElement('div');
            el.className = 'toast';
            el.textContent = msg;
            container.appendChild(el);
            setTimeout(() => el.remove(), 3000);
            return;
        }

        // Pattern 3: fallback — create a temporary element
        const el = document.createElement('div');
        el.textContent = msg;
        Object.assign(el.style, {
            position: 'fixed', bottom: '1.5rem', left: '50%',
            transform: 'translateX(-50%)', background: '#c4a24e',
            color: '#0f0f0c', padding: '0.75rem 1.5rem', borderRadius: '10px',
            fontWeight: '600', fontSize: '0.9rem', zIndex: '1000',
            textAlign: 'center', maxWidth: '90vw',
        });
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    /**
     * Switch visible screen.
     * Supports both id-based (#screen-name or #name) and
     * class-based (.screen.active) patterns.
     */
    function showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const el = document.getElementById('screen-' + name) || document.getElementById(name);
        if (el) el.classList.add('active');
    }

    /**
     * Get or create a persistent client ID stored in sessionStorage.
     */
    function getClientId(storageKey) {
        let id = sessionStorage.getItem(storageKey);
        if (!id) {
            id = 'p' + Date.now() + Math.random().toString(36).slice(2, 5);
            sessionStorage.setItem(storageKey, id);
        }
        return id;
    }

    /* ── SlopLobby class ─────────────────────────────────────────── */

    class SlopLobby {
        /**
         * @param {Object} opts
         * @param {string} opts.roomPrefix  — SlopNet room prefix (e.g. 'cah-')
         * @param {string} opts.storageKey  — sessionStorage key for clientId (e.g. 'cah-client-id')
         *
         * Callbacks (all optional):
         * @param {Function} opts.onHostData       — (clientId, data) host receives data from a client
         * @param {Function} opts.onClientData     — (data) client receives data from the host
         * @param {Function} opts.onPlayerJoined   — (clientId, metadata) called when a new client joins
         *   Return true (or undefined) to accept, or a string with a rejection reason.
         * @param {Function} opts.onPlayerRejoined — (clientId, metadata) called when a client reconnects
         * @param {Function} opts.onPlayerLeft     — (clientId, metadata) called when a client disconnects
         * @param {Function} opts.onStateChange    — (state) 'connecting'|'connected'|'disconnected'|'reconnected'|'reconnect-failed'
         */
        constructor(opts) {
            this.roomPrefix = opts.roomPrefix;
            this.storageKey = opts.storageKey;
            this._onHostData = opts.onHostData || (() => {});
            this._onClientData = opts.onClientData || (() => {});
            this._onPlayerJoined = opts.onPlayerJoined || (() => {});
            this._onPlayerRejoined = opts.onPlayerRejoined || (() => {});
            this._onPlayerLeft = opts.onPlayerLeft || (() => {});
            this._onStateChange = opts.onStateChange || (() => {});

            this.host = null;      // SlopNet.PeerHost instance (host only)
            this.client = null;    // SlopNet.PeerClient instance (client only)
            this.isHost = false;
            this.roomCode = null;
            this.hostName = null;  // Host's display name
            this.clientId = null;  // This peer's client ID (for clients)

            /** Map<clientId, { name, ...metadata }> — host tracks connected players */
            this.players = new Map();
        }

        /* ── Host methods ──────────────────────────────────────── */

        /**
         * Create a new room as host.
         * @param {string} hostName — Display name for the host player
         * @returns {Promise<string>} Room code
         */
        async createRoom(hostName) {
            this.isHost = true;
            this.hostName = hostName;

            const host = new SlopNet.PeerHost({ roomPrefix: this.roomPrefix });
            this.host = host;

            host.on('client-joined', (clientId, metadata) => {
                const result = this._onPlayerJoined(clientId, metadata);
                if (typeof result === 'string') {
                    // Rejected — send error and remove
                    host.send(clientId, { type: 'join-error', reason: result });
                    host.removeClient(clientId);
                    return;
                }
                const name = (metadata && metadata.name) || 'Unknown';
                this.players.set(clientId, { name, ...metadata });
            });

            host.on('client-rejoined', (clientId, metadata) => {
                const name = (metadata && metadata.name) || 'Unknown';
                if (!this.players.has(clientId)) {
                    this.players.set(clientId, { name, ...metadata });
                }
                this._onPlayerRejoined(clientId, metadata);
            });

            host.on('client-left', (clientId) => {
                const meta = this.players.get(clientId);
                this.players.delete(clientId);
                this._onPlayerLeft(clientId, meta);
            });

            host.on('data', (clientId, data) => {
                this._onHostData(clientId, data);
            });

            host.on('error', (err) => {
                console.error('[SlopLobby] Host error:', err);
            });

            this.roomCode = await host.start();
            return this.roomCode;
        }

        /**
         * Send data to a specific client (host only).
         */
        send(clientId, data) {
            if (this.host) this.host.send(clientId, data);
        }

        /**
         * Broadcast data to all clients (host only).
         */
        broadcast(data) {
            if (this.host) this.host.broadcast(data);
        }

        /**
         * Remove a client (host only).
         */
        removeClient(clientId) {
            if (this.host) this.host.removeClient(clientId);
            this.players.delete(clientId);
        }

        /**
         * Get array of connected client IDs (host only).
         */
        getConnectedClientIds() {
            return this.host ? this.host.getConnectedClientIds() : [];
        }

        /* ── Client methods ────────────────────────────────────── */

        /**
         * Join an existing room as a client.
         * @param {string} code      — Room code to join
         * @param {string} name      — Display name
         * @param {Object} [extra]   — Additional metadata to send to host
         * @returns {Promise<void>}
         */
        async joinRoom(code, name, extra) {
            this.isHost = false;
            this.roomCode = code;
            this.clientId = getClientId(this.storageKey);

            const client = new SlopNet.PeerClient({ roomPrefix: this.roomPrefix });
            this.client = client;

            client.on('data', (data) => {
                this._onClientData(data);
            });

            client.on('disconnected', () => {
                toast('Disconnected — reconnecting...');
                this._onStateChange('disconnected');
            });

            client.on('reconnected', () => {
                toast('Reconnected!');
                this._onStateChange('reconnected');
            });

            client.on('reconnect-failed', () => {
                toast('Lost connection to game');
                this._onStateChange('reconnect-failed');
            });

            client.on('error', (err) => {
                console.error('[SlopLobby] Client error:', err);
            });

            this._onStateChange('connecting');
            await client.connect(code, this.clientId, { name, ...extra });
            this._onStateChange('connected');
        }

        /**
         * Send data to the host (client only).
         */
        sendToHost(data) {
            if (this.client) this.client.send(data);
        }

        /* ── Shared methods ────────────────────────────────────── */

        /**
         * Destroy the host or client connection and clean up.
         */
        destroy() {
            if (this.host) { this.host.destroy(); this.host = null; }
            if (this.client) { this.client.destroy(); this.client = null; }
            this.players.clear();
            this.roomCode = null;
        }
    }

    /* ── Export ───────────────────────────────────────────────────── */

    const SlopLobby_exports = {
        SlopLobby,
        $,
        esc,
        toast,
        showScreen,
        getClientId,
    };

    // UMD
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = SlopLobby_exports;
    } else {
        root.SlopLobby = SlopLobby_exports;
    }

})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
