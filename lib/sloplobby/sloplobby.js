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
 *     onPlayerLeft:     (clientId, meta, final) => { ... },
 *     onPlayerLost:     (clientId, meta) => { ... },   // optional, see below
 *     onRoomCode:       (code, changed) => { ... },    // optional, see below
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

    // How many departed players' records to keep for a possible late return. Well
    // above any real party; the cap only stops an all-night flaky room growing a
    // map forever.
    const MAX_PAST_PLAYERS = 64;

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

    /**
     * Remember / recall the room code this tab is hosting under.
     *
     * The room code IS the room. A host that comes back under a different one has
     * stranded every player holding the old one, with no channel left to tell them —
     * and browsers discard and silently reload backgrounded tabs, so "the host tab
     * reloaded" is a routine event rather than a crash. sessionStorage is the right
     * lifetime for it: it is restored with a discarded tab, and dropped when the tab
     * really goes away (a new tab is a new room).
     */
    function roomStorageKey(storageKey) {
        return storageKey + '-room-code';
    }

    function loadRoomCode(storageKey) {
        // Storage access throws outright in some private/partitioned contexts, and a
        // host that cannot remember its code must still be able to open a room.
        try { return sessionStorage.getItem(roomStorageKey(storageKey)); } catch (e) { return null; }
    }

    function saveRoomCode(storageKey, code) {
        try { sessionStorage.setItem(roomStorageKey(storageKey), code); } catch (e) { /* ignore */ }
    }

    function clearRoomCode(storageKey) {
        try { sessionStorage.removeItem(roomStorageKey(storageKey)); } catch (e) { /* ignore */ }
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
         * @param {Function} opts.onPlayerLeft     — (clientId, metadata, final) called when a client's
         *   connection drops. `final` is false while SlopNet is still holding the seat open for them
         *   (they may walk straight back in), and true when the seat has been released for good.
         *   Apps written before `final` existed simply ignore the extra argument.
         * @param {Function} opts.onPlayerLost     — (clientId, metadata) optional. Called INSTEAD of the
         *   final onPlayerLeft when SlopNet's reconnect window expires, for apps that want to treat
         *   "gone for now" and "gone for good" differently.
         * @param {Function} opts.onRoomCode       — (roomCode, changed) optional. Called with the
         *   authoritative room code every time the host registers with the signalling server.
         *   `changed` is true when this is not the code the room was previously announcing, which is
         *   an app's cue to repaint it. Without this callback a changed code raises a toast, because
         *   the code already on screen now dials a room that does not exist.
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
            // Both optional and both have a defined fallback below, so `null` (not a
            // no-op) is what tells us whether the app opted in.
            this._onPlayerLost = opts.onPlayerLost || null;
            this._onRoomCode = opts.onRoomCode || null;
            this._onStateChange = opts.onStateChange || (() => {});

            this.host = null;      // SlopNet.PeerHost instance (host only)
            this.client = null;    // SlopNet.PeerClient instance (client only)
            this.isHost = false;
            this.roomCode = null;
            this.hostName = null;  // Host's display name
            this.clientId = null;  // This peer's client ID (for clients)

            /** Map<clientId, { name, ...metadata }> — host tracks connected players */
            this.players = new Map();
            // Records of players whose reconnect window expired, kept so that a late
            // return restores their seat rather than arriving as a nameless stranger.
            // Bounded: a long night with a flaky room must not grow this forever.
            this._pastPlayers = new Map();
        }

        /* ── Host methods ──────────────────────────────────────── */

        /**
         * Create a new room as host.
         * @param {string} hostName   — Display name for the host player
         * @param {string} [roomCode] — Force a specific room code. Omit it and the room
         *   reuses the code this tab was last hosting under (if any), so a reloaded host
         *   tab comes back as the SAME room; only a genuinely new tab gets a new code.
         * @returns {Promise<string>} Room code
         */
        async createRoom(hostName, roomCode) {
            this.isHost = true;
            this.hostName = hostName;

            const host = new SlopNet.PeerHost({ roomPrefix: this.roomPrefix });
            this.host = host;

            // 'ready' fires on the first registration and again after the host
            // re-registers with the signalling server, always carrying the code the room
            // is actually reachable on. Adopting it in one place is what stops a code
            // that changed under us from being left stale on screen and in storage.
            host.on('ready', (code) => {
                this._adoptRoomCode(code);
            });

            host.on('client-joined', (clientId, metadata) => {
                const name = (metadata && metadata.name) || 'Unknown';

                // Seat the player BEFORE handing them to the app. Apps read and write
                // lobby.players from inside this callback (texas-holdem binds its seat id
                // there, flip-7 documents the record as already present), and the record
                // used to be written afterwards from a fresh object literal — which threw
                // the app's write away one statement later, in the same tick.
                const seeded = { name, ...metadata };
                this.players.set(clientId, seeded);

                const result = this._onPlayerJoined(clientId, metadata);
                if (typeof result === 'string') {
                    // Rejected — send error and remove
                    this.players.delete(clientId);
                    host.send(clientId, { type: 'join-error', reason: result });
                    host.removeClient(clientId);
                    return;
                }

                // The record belongs to the app now: whatever it left there is what
                // stands, including nothing at all (an app may reject a join by calling
                // removeClient itself rather than returning a reason). The only thing
                // filled in is the display name, which this library's own
                // 'client-left'/'client-lost' payloads carry back to the app.
                const stored = this.players.get(clientId);
                if (stored && stored !== seeded && stored.name === undefined) {
                    stored.name = name;
                }
            });

            host.on('client-rejoined', (clientId, metadata) => {
                // Only rebuild when there is nothing to keep. A surviving record carries
                // app state the wire metadata knows nothing about — the seat, the hand,
                // the score — and rebuilding it from `{ name }` is how a returning player
                // used to lose their seat permanently.
                if (!this.players.has(clientId)) {
                    const parked = this._pastPlayers.get(clientId);
                    if (parked) {
                        // Their own record, seat and all, kept from when the window expired.
                        this.players.set(clientId, parked);
                        this._pastPlayers.delete(clientId);
                    } else {
                        const name = (metadata && metadata.name) || 'Unknown';
                        this.players.set(clientId, { name, ...metadata });
                    }
                }
                this._onPlayerRejoined(clientId, metadata);
            });

            // TEMPORARY. The data connection dropped, but SlopNet holds the seat for the
            // whole reconnect window and the player may walk straight back into it, so
            // the record stays put until 'client-lost' says it is really over.
            host.on('client-left', (clientId, metadata) => {
                const meta = this.players.get(clientId) || metadata;
                this._onPlayerLeft(clientId, meta, false);
            });

            // FINAL. The reconnect window expired and SlopNet released the seat. Nothing
            // subscribed to this before, so an app was never told a player was gone for
            // good — it only ever heard the temporary event, and then kept a ghost in the
            // room forever. Apps that predate onPlayerLost hear it as a second
            // onPlayerLeft with final = true; all four consumers' handlers are idempotent
            // (mark-disconnected, or filter-by-id).
            host.on('client-lost', (clientId, metadata) => {
                const meta = this.players.get(clientId) || metadata;
                // Park it rather than bin it. SlopNet greets a post-window returner as
                // 'client-rejoined' precisely so an app does not refuse them their own
                // seat — but that is worth nothing if we have already thrown away the
                // record carrying the seat. Rebuilt from wire metadata it is just
                // { name }, so the player comes back seated with no seat id: cards
                // hidden, controls never built. Same failure, one layer later.
                if (meta) {
                    if (this._pastPlayers.size >= MAX_PAST_PLAYERS) {
                        this._pastPlayers.delete(this._pastPlayers.keys().next().value);
                    }
                    this._pastPlayers.set(clientId, meta);
                }
                this.players.delete(clientId);
                if (this._onPlayerLost) this._onPlayerLost(clientId, meta);
                else this._onPlayerLeft(clientId, meta, true);
            });

            host.on('data', (clientId, data) => {
                this._onHostData(clientId, data);
            });

            host.on('error', (err) => {
                console.error('[SlopLobby] Host error:', err);
            });

            // Reuse the remembered code unless the caller named one. A tab the browser
            // discarded and restored runs createRoom again from scratch; without this it
            // would come back as a different room, with every player still holding the
            // old code and no way left to tell them.
            const preferred = roomCode || loadRoomCode(this.storageKey);
            this.roomCode = await host.start(preferred || undefined);
            this._adoptRoomCode(this.roomCode);
            return this.roomCode;
        }

        /**
         * Take the room code SlopNet reports as authoritative, and make sure it cannot
         * differ from the one the player is looking at.
         */
        _adoptRoomCode(code) {
            if (!code) return;
            const changed = !!this.roomCode && this.roomCode !== code;
            this.roomCode = code;
            saveRoomCode(this.storageKey, code);

            if (this._onRoomCode) {
                this._onRoomCode(code, changed);
                return;
            }
            // No app opted in. A code that CHANGED is the one case where saying nothing
            // is worse than a toast: what is painted on the host's screen, and what every
            // player has already typed in, now dials a room that does not exist.
            if (changed) toast('Room code changed to ' + code);
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
            // A kick is deliberate, so do not hold their record for a comeback.
            if (this._pastPlayers) this._pastPlayers.delete(clientId);
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
            // Deliberately ending the room is the one thing that forgets its code. A tab
            // the browser discards never gets here, which is exactly the case the
            // remembered code exists for.
            if (this.isHost) clearRoomCode(this.storageKey);
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
