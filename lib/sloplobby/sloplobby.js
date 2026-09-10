/**
 * SlopLobby — Shared lobby & connection management for slop multiplayer games.
 *
 * Provides:
 *   - Utility helpers: $, esc, escJs, toast, showScreen
 *   - Persistent clientId (and per-room seat token) via sessionStorage, with an
 *     in-memory fallback for contexts where storage throws
 *   - Host lifecycle: create room, track players, validate joins, close room
 *   - Client lifecycle: join room, auto-reconnect event wiring, terminal states
 *   - Standard connection-status toasts
 *   - Page-visibility handling: a tab that comes back to the foreground probes /
 *     reconnects at once instead of waiting for a throttled timer
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
 *     onStateChange:    (state, detail) => { ... },    // optional, see below
 *   });
 *
 *   // Host
 *   const code = await lobby.createRoom('Alice');
 *   lobby.broadcast({ type: 'state', ... });
 *   lobby.send(clientId, { ... });                 // -> boolean
 *   lobby.removeClient(clientId, 'Kicked');       // reason optional; with one the
 *                                                  // player is told why. Either way the
 *                                                  // kick sticks: their retry ladder
 *                                                  // cannot walk them back in.
 *   await lobby.closeRoom('Host ended the game'); // players hear 'room-closed'
 *
 *   // Client
 *   await lobby.joinRoom('ABC123', 'Bob');        // rejects: see PeerClient.connect().
 *                                                  // Calling it again retires the
 *                                                  // previous client first.
 *   lobby.sendToHost({ type: 'action', ... });     // -> boolean
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

    const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    /**
     * HTML-escape a string. Safe for text nodes and for attribute VALUES, whichever
     * quote character delimits them: `<div title="${esc(name)}">`, `<div title='...'>`,
     * `<td>${esc(name)}</td>`.
     *
     * NOT sufficient for JavaScript inside an attribute — `onclick="fn('${...}')"`.
     * The HTML parser decodes character references BEFORE the handler source is
     * compiled, so `&#39;` is a bare apostrophe again by the time JS sees it and
     * O'Brien is still a syntax error. Use escJs() for that (or, better, a data-*
     * attribute and a delegated listener).
     */
    function esc(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ESC_MAP[ch]);
    }

    /**
     * Escape a string for use INSIDE a JavaScript string literal that is itself
     * inside an HTML attribute: `onclick="fn('${escJs(name)}')"`.
     *
     * Everything dangerous becomes a \uXXXX escape, which contains no HTML-special
     * character — so it survives the HTML parser's decoding untouched and reaches the
     * JS compiler as an escape sequence rather than as a quote that ends the string.
     */
    function escJs(str) {
        return String(str == null ? '' : str).replace(
            /[\\'"`$<>&\r\n\u2028\u2029]/g,
            ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
        );
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

    // Storage access throws outright in some private/partitioned contexts. A tab
    // that cannot remember anything must still be able to join a game AND to prove
    // who it is, so every value below falls back to one held in memory for the life
    // of the page — but ONLY for the keys whose storage actually threw. An identity
    // that outlives its proof is what turns "try again" into a permanent lockout, so
    // the clientId and its seat token must always have the same lifetime.
    const memoryStore = new Map();

    /** @returns {{ok: boolean, value: string|null}} — ok:false means storage threw. */
    function readStorage(key) {
        try { return { ok: true, value: sessionStorage.getItem(key) }; }
        catch (e) { return { ok: false, value: null }; }
    }

    /** @returns {boolean} whether the write landed in real storage. */
    function writeStorage(key, value) {
        try {
            sessionStorage.setItem(key, value);
            // Real storage has it now, so the in-memory copy must not shadow it.
            memoryStore.delete(key);
            return true;
        } catch (e) {
            memoryStore.set(key, String(value));
            return false;
        }
    }

    function readWithFallback(key) {
        // Memory FIRST. It only ever holds a key whose write real storage refused, so
        // when it has one it is the freshest thing we own. Reading storage first was
        // the whole bug: the common broken shape is a storage whose getItem works and
        // whose setItem throws (Safari private mode, a full quota), and there the read
        // succeeded and handed back the null it had just failed to overwrite — so the
        // fallback was write-only, getClientId minted a new identity on EVERY call,
        // and no tab could ever rejoin its own seat.
        if (memoryStore.has(key)) return memoryStore.get(key);
        const r = readStorage(key);
        return r.ok ? r.value : null;
    }

    /**
     * Get or create a persistent client ID stored in sessionStorage.
     */
    function getClientId(storageKey) {
        const existing = readWithFallback(storageKey);
        if (existing) return existing;
        const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 5);
        writeStorage(storageKey, id);
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
        return readWithFallback(roomStorageKey(storageKey));
    }

    function saveRoomCode(storageKey, code) {
        writeStorage(roomStorageKey(storageKey), code);
    }

    function clearRoomCode(storageKey) {
        memoryStore.delete(roomStorageKey(storageKey));
        try { sessionStorage.removeItem(roomStorageKey(storageKey)); } catch (e) { /* ignore */ }
    }

    /**
     * Remember / recall the seat token the host issued this tab, PER ROOM.
     *
     * The clientId says WHO we claim to be; the token proves it is still us. It lives
     * next to the clientId in sessionStorage, so a reloaded or restored tab presents
     * both and walks back into its own seat. Chrome's "Duplicate tab" copies
     * sessionStorage, so a duplicate presents a valid token too — SlopNet handles that
     * (newest wins, the old tab is told it was superseded). What the token stops is a
     * different tab or device asserting a clientId it read off the wire.
     *
     * The room code is part of the key because tokens are minted PER HOST while the
     * clientId is per tab. One key per app meant that visiting the other table at the
     * same party overwrote the first room's token, and coming back presented a token
     * that room had never issued.
     */
    function tokenStorageKey(storageKey, roomCode) {
        return storageKey + '-token-' + (roomCode || '');
    }

    function loadToken(storageKey, roomCode) {
        return readWithFallback(tokenStorageKey(storageKey, roomCode)) || null;
    }

    function saveToken(storageKey, roomCode, token) {
        writeStorage(tokenStorageKey(storageKey, roomCode), token);
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
         *   Return true (or undefined) to accept, or a string with a rejection reason. A rejected
         *   client receives `{ type: 'join-error', reason }` through its onClientData, is told to
         *   stop (it never retries), and its lobby reports onStateChange('rejected', reason).
         * @param {Function} opts.onPlayerRejoined — (clientId, metadata) called when a client reconnects
         * @param {Function} opts.onPlayerLeft     — (clientId, metadata, final) called when a client's
         *   connection drops. `final` is false while SlopNet is still holding the seat open for them
         *   (they may walk straight back in), and true when the seat has been released for good.
         *   Apps written before `final` existed simply ignore the extra argument. An app that
         *   defines no onPlayerLost hears onPlayerLeft TWICE for a player who never returns:
         *   once with final=false when the link drops, once with final=true when the window
         *   expires. Handlers must therefore be idempotent (mark-disconnected, filter-by-id).
         * @param {Function} opts.onPlayerLost     — (clientId, metadata) optional. Called INSTEAD of the
         *   final onPlayerLeft when SlopNet's reconnect window expires, for apps that want to treat
         *   "gone for now" and "gone for good" differently.
         * @param {Function} opts.onRoomCode       — (roomCode, changed) optional. Called with the
         *   authoritative room code every time the host registers with the signalling server.
         *   `changed` is true when this is not the code the room was previously announcing, which is
         *   an app's cue to repaint it. Without this callback a changed code raises a toast, because
         *   the code already on screen now dials a room that does not exist.
         * @param {Function} opts.onStateChange    — (state, detail) optional. States, and what
         *   `detail` carries for each:
         *     client: 'connecting' | 'connected'
         *             'disconnected'                       link lost, reconnecting
         *             'reconnecting'   { attempt, max }
         *             'reconnected'    { fresh }           fresh=true: the host had restarted and
         *                                                  holds no state for us — re-send what matters
         *             'reconnect-failed'
         *             'rejected'       reason (string)     TERMINAL — the host refused/removed us
         *             'superseded'                         TERMINAL — this game is open in another tab
         *             'room-closed'    reason|null         TERMINAL — the host ended the game
         *     host:   'reconnecting'   { attempt, max }    re-registering with the signalling server
         *             'reconnected'
         *             'reconnect-failed'                   once per outage; the host keeps trying
         *   A terminal state never reconnects and never raises the reconnecting toast
         *   itself. (A kick that closes the channel without a word — removeClient — is
         *   preceded by a GENUINE link loss, and that one does toast: at the moment it
         *   fires, reconnecting is exactly what is happening.)
         *
         *   All three terminal states are wrapped in the vocabulary every app already
         *   knows — 'disconnected', then the specific state, then 'reconnect-failed' —
         *   so an app that has not learnt the new words still leaves its game screen
         *   instead of sitting on a live-looking board where nothing works. See
         *   _endOfTheRoad. The one exception is a refusal at the DOOR (see below),
         *   where the app is already on its way back to its join form.
         *
         *   A refusal is reported through BOTH channels, and an app may act on either:
         *   onStateChange('rejected', reason) fires, and the same reason arrives as
         *   onClientData({ type: 'join-error', reason }) — the message every app
         *   already paints — ALWAYS, including the empty reason a reasonless kick
         *   carries. The message is delivered LAST, after the states, so an app that
         *   paints it keeps the host's actual words on screen rather than one of the
         *   generic bookends.
         *
         *   A refusal at the DOOR (before the first ack) additionally rejects the
         *   joinRoom() promise with err.type='rejected' and err.reason, and gets no
         *   bookends. There the join-error message is delivered on the NEXT tick, after
         *   the app's own catch has painted whatever it paints, so the host's actual
         *   reason is the last thing on screen rather than a generic "could not
         *   connect". It is dropped only if another joinRoom() has started since —
         *   destroying the lobby in that catch (which is what flip-7, CAH and
         *   texas-holdem all do) does not suppress it.
         *
         *   After 'rejected' lobby.client is null. After 'superseded' / 'room-closed'
         *   it is a terminal client object when the state arrived mid-game (send()
         *   returns false, reconnect() is a no-op), and null when it arrived at the
         *   door, because joinRoom()'s failure path drops the client. An app that uses
         *   it to mean "am I in a game" should test `lobby.client && !lobby.client.isTerminal`.
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

            /** Map<clientId, { name, ...app fields }> — host tracks connected players. Seeded by
             *  this library with the normalised NAME only; anything else on the record was
             *  put there by the app, never by the joining client. */
            this.players = new Map();
            // Records of players whose reconnect window expired, kept so that a late
            // return restores their seat rather than arriving as a nameless stranger.
            // Bounded: a long night with a flaky room must not grow this forever.
            this._pastPlayers = new Map();

            this._onVisibility = null;
            // The createRoom() that is still registering, if any (see createRoom).
            this._creating = null;
            // Bumped by every joinRoom(). The deferred door-step join-error is keyed to
            // it, so a reason from an attempt the player has already moved on from
            // cannot land on the screen of the next one. destroy() deliberately does
            // NOT bump it: every app that needs that message destroys its lobby in the
            // same catch that would otherwise leave the wrong reason on screen.
            this._joinGeneration = 0;
            // Nothing is gated on this, so a lobby object can still be reused after
            // destroy() the way it always could.
            this._destroyed = false;
        }

        /* ── Page visibility ───────────────────────────────────── */

        /**
         * One listener per lobby, for either role. A hidden tab's timers are
         * throttled to about one wake a minute, so a reconnect rung armed for six
         * seconds may not fire for sixty — and a locked phone's channel may have died
         * without its owner's JavaScript running to notice. The moment the page is
         * visible again the player is looking at it, so ask the library to check now.
         */
        _watchVisibility() {
            if (this._onVisibility) return;
            if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
            this._onVisibility = () => {
                if (document.visibilityState !== 'visible') return;
                if (this.client && typeof this.client.resume === 'function') this.client.resume();
                if (this.host && typeof this.host.resume === 'function') this.host.resume();
            };
            document.addEventListener('visibilitychange', this._onVisibility);
        }

        _unwatchVisibility() {
            if (!this._onVisibility) return;
            try { document.removeEventListener('visibilitychange', this._onVisibility); } catch (e) { /* ignore */ }
            this._onVisibility = null;
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
            // A second createRoom while the first is still registering is a
            // double-tapped Host button, not a second room. Hand back the room that is
            // already being made: two live PeerHosts under two codes split the room in
            // two — players given the first code reach a host this lobby no longer
            // points at, so every message the app sends them is dropped, destroy()
            // cannot clean that host up, and when its socket blips its 'ready' handler
            // (still bound to this lobby) renames the room out from under the live one.
            if (this._creating && !roomCode) return this._creating;

            const promise = this._createRoom(hostName, roomCode);
            this._creating = promise;
            const settled = () => { if (this._creating === promise) this._creating = null; };
            promise.then(settled, settled);
            return promise;
        }

        async _createRoom(hostName, roomCode) {
            this._destroyed = false;      // a lobby object may be reused after destroy()
            this.isHost = true;
            this.hostName = hostName;

            // Retire whatever we were already hosting first — joinRoom has done this
            // for its client since C10, and for the same reason: the listeners of the
            // host we drop here are all still bound to this lobby.
            if (this.host) {
                const previous = this.host;
                this.host = null;
                previous.destroy();
            }

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
                // ONLY the normalised name. The record is the host's own bookkeeping and
                // apps hang their authority on it — texas-holdem keeps the seat id here,
                // and every game answers "who sent this?" by reading it — so spreading
                // raw wire metadata in let a client choose those fields itself, by simply
                // including them in the metadata it joined with. It also let a client
                // defeat the 'Unknown' fallback above by sending a name the trim rejected.
                // Anything else an app wants on the record, the app writes below.
                const seeded = { name };
                this.players.set(clientId, seeded);

                const result = this._onPlayerJoined(clientId, metadata);
                if (typeof result === 'string') {
                    // Rejected. The reason travels inside the library's own reject
                    // message, which the client is guaranteed to read BEFORE its channel
                    // closes; the client-side lobby turns it back into the same
                    // { type: 'join-error', reason } apps have always handled, and the
                    // client stops for good instead of dialling straight back in.
                    this._kick(clientId, result);
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
                        // Name only — see the 'client-joined' seed above.
                        this.players.set(clientId, { name });
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

            // The host's own signalling socket. Nobody is evicted by any of these (the
            // data channels are unaffected), but an app may want to show that new
            // players cannot join until 'reconnected'.
            host.on('reconnecting', (attempt, max) => {
                this._onStateChange('reconnecting', { attempt, max });
            });
            host.on('reconnected', () => {
                this._onStateChange('reconnected');
            });
            host.on('reconnect-failed', () => {
                this._onStateChange('reconnect-failed');
            });

            host.on('error', (err) => {
                console.error('[SlopLobby] Host error:', err);
            });

            this._watchVisibility();

            // Reuse the remembered code unless the caller named one. A tab the browser
            // discarded and restored runs createRoom again from scratch; without this it
            // would come back as a different room, with every player still holding the
            // old code and no way left to tell them.
            // A code the CALLER named is a fresh choice: if it collides with somebody
            // else's room, taking another one costs nothing. A code we REMEMBERED is the
            // one this tab was hosting under and every player has already typed in, so a
            // collision there is almost always the signalling server still holding our
            // own registration — waiting for it is right, and re-rolling silently strands
            // the whole table on a code that now dials nothing.
            const remembered = roomCode ? null : loadRoomCode(this.storageKey);
            const preferred = roomCode || remembered;
            try {
                this.roomCode = await host.start(preferred || undefined, { reuse: !!remembered });
            } catch (err) {
                // The first registration failed and PeerHost kept nothing running; the
                // app owns the retry. Leave nothing of ours behind either — a truthy
                // `this.host` makes send/broadcast pretend to work, and a retry would
                // drop this object on the floor with its listener still registered.
                // (joinRoom has done this since C10; createRoom had no equivalent.)
                if (this.host === host) {
                    this.host = null;
                    this.isHost = false;
                    this._unwatchVisibility();
                }
                host.destroy();
                throw err;
            }
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
         * @returns {boolean} true if it went out on the wire now; false if it was queued
         *   for an absent seat, the client is unknown, or this lobby is not hosting.
         */
        send(clientId, data) {
            return this.host ? this.host.send(clientId, data) : false;
        }

        /**
         * Broadcast data to all clients (host only).
         */
        broadcast(data) {
            if (this.host) this.host.broadcast(data);
        }

        /**
         * Remove a client (host only). Either way the kick sticks against the player's
         * own retry ladder: SlopNet refuses its next automatic knock. A player who taps
         * Join again by hand is handed to onPlayerJoined as a NEW player (never the
         * 'rejoined' that bypasses a mid-game gate), so that decision stays the app's.
         * @param {string} clientId
         * @param {string} [reason] — Optional. With a reason the player is TOLD before the
         *   channel closes; without one they learn on their next knock. Either way their
         *   app sees { type:'join-error', reason } (empty string when none was given)
         *   and onStateChange 'disconnected' -> 'rejected' -> 'reconnect-failed'.
         */
        removeClient(clientId, reason) {
            this._kick(clientId, typeof reason === 'string' ? reason : null);
        }

        /**
         * Forget a player on purpose. Their parked record goes too: a kick is
         * deliberate, so nothing may hold their seat for a comeback.
         */
        _kick(clientId, reason) {
            this._pastPlayers.delete(clientId);
            this.players.delete(clientId);
            if (!this.host) return;
            if (reason !== null && reason !== undefined) this.host.rejectClient(clientId, reason);
            else this.host.removeClient(clientId);
        }

        /**
         * Get array of connected client IDs (host only).
         */
        getConnectedClientIds() {
            return this.host ? this.host.getConnectedClientIds() : [];
        }

        /**
         * End the room properly (host only): every player hears the host has closed the
         * game (with `reason`, if given) BEFORE their channel closes, so their apps show
         * "Host ended the game" instead of reconnecting for minutes against a room that no
         * longer exists. Then the same cleanup as destroy(). destroy() itself stays
         * immediate and silent.
         * @param {string} [reason]
         * @returns {Promise<void>}
         */
        async closeRoom(reason) {
            const host = this.host;
            if (host) await host.close(reason);
            this.destroy();
        }

        /* ── Client methods ────────────────────────────────────── */

        /**
         * Join an existing room as a client.
         * @param {string} code      — Room code to join
         * @param {string} name      — Display name
         * @param {Object} [extra]   — Additional metadata to send to host
         * @returns {Promise<void>} Rejects with the error from PeerClient.connect() (see its
         *   header for `err.type`; 'destroyed' means this lobby was destroyed while joining).
         *   On rejection the failed client has already been destroyed and `lobby.client` is
         *   null — nothing is left running.
         */
        async joinRoom(code, name, extra) {
            this._destroyed = false;      // a lobby object may be reused after destroy()
            // This attempt's identity, captured once. Anything deferred past the end
            // of the join belongs to THIS generation and is dropped if another
            // joinRoom() has started since (see the 'rejected' handler).
            const joinGeneration = ++this._joinGeneration;
            this.isHost = false;
            this.roomCode = code;
            this.clientId = getClientId(this.storageKey);

            // One client per lobby. A second joinRoom — a double-tapped Join button,
            // an app switching rooms — used to wire a second PeerClient onto the same
            // lobby while the first stayed connected and holding the seat; the loser's
            // terminal handler then nulled `this.client` and every later tap went
            // nowhere. The newest call wins: retire whatever we were holding first.
            if (this.client) {
                const previous = this.client;
                this.client = null;
                previous.destroy();
            }

            const client = new SlopNet.PeerClient({ roomPrefix: this.roomPrefix });
            this.client = client;

            // Retire THIS client — and only if it is still the one we hold, so an app
            // that already called lobby.destroy() from a handler is not tripped up.
            const dropClient = () => {
                if (this.client === client) this.client = null;
                // Nothing of this join may outlive it. The visibilitychange listener
                // was registered before connect(), and createRoom's failure path has
                // always removed its own: a mistyped room code used to leave one
                // document listener — and the whole dead lobby it closes over — alive
                // for the life of the page, once per attempt.
                if (!this.host && !this.client) this._unwatchVisibility();
                client.destroy();
            };

            client.on('data', (data) => {
                this._onClientData(data);
            });

            // Persist the seat token the moment the host hands it over, so a reload or
            // a restored tab can prove it is us. Keyed by room: tokens are minted per
            // host, and one key per app locked a tab out of the first room it visited.
            client.on('token', (token) => {
                saveToken(this.storageKey, code, token);
            });

            // Never fires once the client is terminal: PeerClient tears down without
            // emitting it, so none of the terminal handlers below race this toast.
            client.on('disconnected', () => {
                toast('Disconnected — reconnecting...');
                this._onStateChange('disconnected');
            });

            client.on('reconnecting', (attempt, max) => {
                this._onStateChange('reconnecting', { attempt, max });
            });

            client.on('reconnected', (hostRemembersUs) => {
                toast('Reconnected!');
                // fresh: the host restarted and holds nothing for us any more.
                this._onStateChange('reconnected', { fresh: !hostRemembersUs });
            });

            client.on('reconnect-failed', () => {
                toast('Lost connection to game');
                this._onStateChange('reconnect-failed');
            });

            // TERMINAL: the host said no. Two shapes, reported differently because the
            // app is in a different place in each:
            //
            //   - after the player was already IN (a kick, or onPlayerJoined returning
            //     a string): connect() resolved long ago, so events are the only
            //     channel. The app is sitting on a live-looking game screen, so it gets
            //     _endOfTheRoad's bookends and then the reason.
            //   - at the DOOR, before the first ack: connect() is still pending and
            //     settles as the rejection too, so `await joinRoom()` throws with
            //     err.type === 'rejected' and err.reason, and the app is already
            //     heading back to its join form. No bookends — they would only bounce
            //     it somewhere else. The message is still sent, because it is the only
            //     path an unmodified app paints the reason from, but on the NEXT tick:
            //     the app's catch runs as a microtask and its generic "could not
            //     connect, check the room code" would otherwise be the last thing on
            //     screen, for a room code that was perfectly correct.
            client.on('rejected', (reason) => {
                const text = reason == null ? '' : reason;
                if (client.hasJoined) {
                    // The player was already IN. 'rejected' is a word none of the
                    // shipped apps branch on, and two of the four never look at
                    // join-error either, so on its own a kick leaves a fully painted,
                    // fully interactive board on screen with every tap dropped — or,
                    // when the kick closed the channel first, the "Reconnecting…"
                    // banner that the genuine 'disconnected' put up, for ever. Give it
                    // the same bookends 'superseded' and 'room-closed' get.
                    this._endOfTheRoad('rejected', text);
                    // The reason LAST, so it is the final word on screen: the bookends
                    // are deliberately generic ("lost connection", "disconnected from
                    // host") and an app that paints join-error would otherwise have its
                    // real explanation overwritten by one of them.
                    this._onClientData({ type: 'join-error', reason: text });
                } else {
                    // At the DOOR: connect() is still pending and settles as this same
                    // refusal, so the app is already on its way back to the join form
                    // — the bookends would only bounce it somewhere else (herd's
                    // 'reconnect-failed' branch goes to the home screen) and overwrite
                    // the reason.
                    this._onStateChange('rejected', text);
                    // An app's catch runs as a microtask — after every listener here.
                    // Painting the host's reason now would only be overwritten one tick
                    // later by that catch's generic "could not connect, check the room
                    // code", which is actively misleading when the code was right.
                    // Handing it over on the next tick makes the true reason the last
                    // word the player sees, without any app having to learn err.reason.
                    //
                    // Guarded by the JOIN generation, not by _destroyed: every app that
                    // needs this message destroys its lobby inside that very catch
                    // (flip-7's cleanupMultiplayer, CAH, texas-holdem's resetToLobby),
                    // so a _destroyed guard dropped the reason for exactly the apps it
                    // was written for and left them showing "check the room code" about
                    // a room code that was perfectly correct. What must suppress it is
                    // a screen that has moved ON — another join — which is what the
                    // generation counts.
                    setTimeout(() => {
                        if (this._joinGeneration !== joinGeneration) return;
                        this._onClientData({ type: 'join-error', reason: text });
                    }, 0);
                }
                dropClient();
            });

            // TERMINAL: a duplicate of this tab took the seat. This one goes quiet.
            client.on('superseded', () => {
                toast('This game is open in another tab');
                this._endOfTheRoad('superseded', undefined);
            });

            // TERMINAL: the host ended the room.
            client.on('room-closed', (reason) => {
                toast(reason ? 'Host ended the game: ' + reason : 'Host ended the game');
                this._endOfTheRoad('room-closed', reason);
            });

            client.on('error', (err) => {
                console.error('[SlopLobby] Client error:', err);
            });

            this._watchVisibility();

            this._onStateChange('connecting');
            try {
                await client.connect(
                    code, this.clientId, { name, ...extra },
                    { token: loadToken(this.storageKey, code) }
                );
            } catch (err) {
                // A failed first connect used to leak the client and its peer, which kept
                // dialling in the background. Nothing may be left running.
                dropClient();
                throw err;
            }
            this._onStateChange('connected');
        }

        /**
         * Report a terminal state in a vocabulary every app already understands.
         *
         * 'rejected', 'superseded' and 'room-closed' end the game as finally as a lost
         * connection does, but they are new words: an app that branches only on the
         * states that existed before keeps a fully painted, fully interactive game on
         * screen while every tap is silently dropped. So the specific state is
         * sandwiched between the two states the apps DO act on, in the order they tell
         * the truth:
         *
         *   'disconnected'      the link is gone (it is — the peer has been torn down)
         *   the specific state  ...and here is why
         *   'reconnect-failed'  ...and nothing more is coming
         *
         * Both bookends are load-bearing. flip-7's 'reconnect-failed' branch only
         * REWRITES a banner that its 'disconnected' branch creates (index.html:1784),
         * so without the first state a superseded flip-7 tab is shown nothing at all;
         * CAH, herd-mentality and texas-holdem leave the game on the last one, and
         * pub-quiz (which only knows 'disconnected'/'reconnected') paints its status
         * dot 'off' and stops there, which is honest too.
         *
         * The 'Disconnected — reconnecting...' TOAST is not raised: that lives on the
         * client's own 'disconnected' event, which a terminal client never emits (C8),
         * and telling a player we are reconnecting when we never will is the one thing
         * this must not do.
         */
        _endOfTheRoad(state, detail) {
            this._onStateChange('disconnected');
            this._onStateChange(state, detail);
            this._onStateChange('reconnect-failed');
        }

        /**
         * Send data to the host (client only).
         * @returns {boolean} true if it went out on the wire now; false if it was queued
         *   for the reconnect, or dropped (terminal client, or no client at all).
         */
        sendToHost(data) {
            return this.client ? this.client.send(data) : false;
        }

        /* ── Shared methods ────────────────────────────────────── */

        /**
         * Destroy the host or client connection and clean up. Immediate: as host, the
         * players are not told (use closeRoom for that).
         */
        destroy() {
            this._destroyed = true;
            // Deliberately ending the room is the one thing that forgets its code. A tab
            // the browser discards never gets here, which is exactly the case the
            // remembered code exists for.
            if (this.isHost) clearRoomCode(this.storageKey);
            this._unwatchVisibility();
            if (this.host) { this.host.destroy(); this.host = null; }
            if (this.client) { this.client.destroy(); this.client = null; }
            this.players.clear();
            // The parked records go too. PeerHost.destroy() clears its own mirror
            // (_pastClients); a lobby that is reused for the next game must not restore
            // a seat from a game that is over.
            this._pastPlayers.clear();
            this.roomCode = null;
        }
    }

    /* ── Export ───────────────────────────────────────────────────── */

    const SlopLobby_exports = {
        SlopLobby,
        $,
        esc,
        escJs,
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
