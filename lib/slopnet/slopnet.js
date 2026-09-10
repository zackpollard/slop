/**
 * SlopNet - PeerJS Connection Management Library
 *
 * Provides robust host/client peer-to-peer networking with:
 * - Automatic reconnection with exponential backoff
 * - Heartbeat-based connection health monitoring
 * - Message queuing during disconnection
 * - Reconnect window for temporary client absence
 * - Seat tokens: a clientId can only be reclaimed by the connection holding its token
 * - Terminal client states ('rejected', 'superseded', 'room-closed') that never reconnect
 * - Typed event emitter system
 *
 * Usage (via script tag):
 *   <script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"></script>
 *   <script src="/lib/slopnet/slopnet.js"></script>
 *   const host = new SlopNet.PeerHost({ roomPrefix: 'myapp-' });
 *   const client = new SlopNet.PeerClient({ roomPrefix: 'myapp-' });
 *
 * Wire protocol (all internal messages are objects whose `type` starts with '__slopnet_'):
 *   client -> host   __slopnet_join { clientId, metadata, token?, staleMs? }
 *   host   -> client __slopnet_join_ack { reconnected, clientId, token }
 *   client -> host   __slopnet_join_confirm { token }        "the ack (and its token) arrived"
 *   host   -> client __slopnet_join_reject { reason }        terminal for the client
 *   host   -> client __slopnet_superseded                      terminal for the client
 *   host   -> client __slopnet_room_closed { reason }         terminal for the client
 *   host   -> client __slopnet_rejoin_required                 "I hold no seat for this connection"
 *   both             __slopnet_ping / __slopnet_pong
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

        /**
         * Listeners are isolated from one another. emit() is called from inside
         * PeerJS's own DataConnection handlers, so a throw in one app listener used to
         * abort every listener after it AND propagate into the transport — the
         * library's own bookkeeping listeners were skipped and the peer was left in
         * whatever state the exception found it in.
         */
        emit(event, ...args) {
            const list = this._listeners[event];
            if (!list) return false;
            for (const fn of list.slice()) {
                try {
                    fn.apply(this, args);
                } catch (err) {
                    console.error('[SlopNet] listener for "' + event + '" threw', err);
                }
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
     * Upper bound on messages held for the other side while the link is down. On the
     * host the record (and its queue) is dropped wholesale when the reconnect window
     * expires, so this only bounds a single absence; on the client it bounds what a
     * player can tap into a dead screen before the queue starts forgetting the oldest.
     */
    const MAX_QUEUED_MESSAGES = 200;

    /**
     * How many departed players' identities (and seat tokens) the host keeps so a
     * late return is still a rejoin. Well above any real party; the cap only stops
     * an all-night flaky room growing a map forever.
     */
    const MAX_PAST_CLIENTS = 256;

    /**
     * A connection that holds no seat is told so at most this often. It is a nudge,
     * not a conversation: one is enough for a live client to re-send its join.
     */
    const REJOIN_NUDGE_INTERVAL_MS = 2000;

    /**
     * How long after resume() the client re-examines a channel that claims to be open.
     *
     * The probe does NOT judge on this clock. Wall time alone is exactly the evidence
     * the rest of the library was hardened against: these are phone games at both ends,
     * and a host whose page is frozen cannot answer anything, however healthy the
     * DataChannel is. The probe only brings the HEARTBEAT's verdict (N pings actually
     * sent and ignored AND heartbeatTimeout of silence) forward by up to one tick.
     */
    const RESUME_PROBE_MS = 3000;

    /**
     * The shortest gap between two attempts started by resume(). A foregrounded tab
     * fires visibilitychange on every app switch, and dialling on each one pins the
     * backoff at its base, hammers the signalling server and makes 'reconnect-failed'
     * unreachable. A resume inside this window leaves the armed rung where it is.
     */
    const RESUME_REDIAL_MIN_MS = 1000;

    /**
     * How many superseded tokens a seat keeps accepting as proof of identity. One is
     * enough for the case they exist for (an unproven seat handed on while its real
     * holder was away); a couple of spares costs nothing.
     */
    const MAX_ALT_TOKENS = 3;

    /**
     * How many kicks-with-a-reason the host remembers for players it could not reach
     * (they were inside their reconnect window). Consumed by the first join that
     * follows, so this only ever holds the handful of players kicked while absent.
     */
    const MAX_PENDING_REJECTIONS = 64;

    /** How long PeerHost.close() waits for its goodbyes to leave before destroying. */
    const DEFAULT_CLOSE_GRACE_MS = 400;

    /** Reason a join is refused when the seat's token does not match. */
    const SEAT_TAKEN_REASON = 'That seat belongs to another connection';

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

        // How many times start() re-presents a code the CALLER asked for when the
        // signalling server says it is taken. Sized to outlast PeerServer's ~60s
        // alive_timeout, which is how long it keeps holding the id of a socket that
        // died with the radio: 1+1.5+2.25+3.4+5+6*6 = ~49s of waiting over 10 tries.
        maxCodeRetries: 10,

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

    /**
     * Seat token: 24 characters, unguessable in practice. crypto when the platform
     * has it; a clientId that was only ever meant to be unique, not secret, is what
     * this exists to stop being enough.
     */
    function generateToken() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const length = 24;
        let out = '';
        const c = (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function')
            ? crypto : null;
        if (c) {
            const bytes = new Uint8Array(length);
            c.getRandomValues(bytes);
            for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
        } else {
            for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
        }
        return out;
    }

    function computeBackoff(attempt, base, multiplier, max) {
        return Math.min(base * Math.pow(multiplier, attempt), max);
    }

    /**
     * Close a DataConnection AFTER everything already sent on it has been delivered.
     *
     * peerjs's close({ flush: true }) does not close locally at all: it sends a close
     * control message through the ordered send path and lets the REMOTE close, which
     * is what guarantees a goodbye sent just before it actually arrives. A plain
     * close() drops unsent messages on the floor. A connection that is not open has
     * nothing buffered to flush, and flush-closing it only raises an error event, so
     * that case (and any throw) falls back to the plain close.
     */
    function flushClose(conn) {
        if (!conn) return;
        if (conn.open) {
            try { conn.close({ flush: true }); return; } catch (e) { /* fall through */ }
        }
        try { conn.close(); } catch (e) { /* already gone */ }
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
     *                                          nothing about anybody's data channel — and NOT
     *                                          emitted for connections the host itself closed
     *                                          (removeClient, rejectClient, close, destroy).
     *   'client-lost'    (clientId, metadata) - Client exceeded reconnect window, seat released
     *   'data'           (clientId, data)     - Data received from a SEATED client. Traffic from
     *                                          a connection that holds no seat is never
     *                                          delivered, and never under a raw peer id; the
     *                                          sender is told to rejoin instead.
     *   'error'          (error)              - Error on the host peer
     *   'reconnecting'   (attempt, max)       - Host is re-registering with the signaling server.
     *                                          `attempt` is clamped to `max`; knocking continues
     *                                          past it.
     *   'reconnected'    ()                   - Host re-registered under the SAME room code
     *   'reconnect-failed' ()                 - Emitted ONCE per outage when the ladder is
     *                                          exhausted. The host keeps re-registering at
     *                                          reconnectBackoffMax for as long as it lives and
     *                                          emits 'reconnected' if that ever succeeds.
     *   'destroyed'      ()                   - Host peer destroyed
     *
     * Methods of note:
     *   start(roomCode?)               -> Promise<roomCode>. Rejects (and leaves nothing
     *                                     running) if the FIRST registration fails; the app
     *                                     owns that retry. destroy() while it is in flight
     *                                     rejects it with err.type 'destroyed'.
     *   send(clientId, data)           -> boolean. false = queued for an absent seat, or unknown.
     *   broadcast(data, exclude?)
     *   removeClient(clientId)         -> boolean. Kick: flush close, nothing said. The kick
     *                                     STICKS against the player's own RETRY LADDER — the
     *                                     next automatic rung by that clientId is refused
     *                                     once, silently — so the shape every app ships
     *                                     ("send an error, then removeClient") cannot loop
     *                                     the player back in once a second all night.
     *   rejectClient(clientId, reason) -> boolean. Kick WITH a reason: the client receives it
     *                                     before the close, enters its terminal 'rejected'
     *                                     state and never retries. The reason is ALSO held
     *                                     for that clientId's next automatic rung (once),
     *                                     because an open-looking channel may already be
     *                                     dead: a kick shouted into one used to leave the
     *                                     player free to walk back in as a brand-new joiner.
     *                                     Both kicks work on a player whose reconnect window
     *                                     has already expired (identity remembered only) —
     *                                     that is the one the host is looking at when they
     *                                     tap Remove on a ghost in the lobby.
     *
     *                                     THE HOLD IS AIMED AT THE MACHINE, NOT THE PLAYER.
     *                                     A join carrying no `staleMs` — a PeerClient built
     *                                     since, i.e. a player tapping Join again because
     *                                     the app told them to — is NOT refused here; it
     *                                     goes to the app like any other new join, and the
     *                                     app's own no-new-players gate decides. flip-7 and
     *                                     herd-mentality refuse a join by returning 'Name
     *                                     already taken' from onPlayerJoined and then send
     *                                     the player back to the form, and a hold that
     *                                     covered the whole clientId spent itself on the
     *                                     corrected name — refusing it with the stale words
     *                                     without ever asking the app. What a deliberate
     *                                     return does NOT get back is its identity: the kick
     *                                     forgets _pastClients, so they arrive as
     *                                     'client-joined', never the 'client-rejoined' every
     *                                     app uses to bypass that gate.
     *   close(reason?, { graceMs })    -> Promise. Tells every client the room is over
     *                                     ('room-closed'), flush-closes them, destroys after
     *                                     graceMs (default 400). destroy() during the grace
     *                                     destroys at once and forfeits the goodbye.
     *   destroy()                      -> immediate teardown, no goodbye. Idempotent.
     *   resume()                       -> "the page just became visible": run a pending
     *                                     signalling reconnect now, ping every seated client.
     *
     * Seat tokens:
     *   A new seat is issued a random token in its join_ack, and the client confirms
     *   it (__slopnet_join_confirm). From then on the token protects the SEAT for as
     *   long as the host holds one — while its holder is sitting in it AND for the
     *   whole reconnect window while their ladder is climbing. A join for that
     *   clientId which cannot present the token is refused with SEAT_TAKEN_REASON and
     *   the holder is never told. clientIds are unique, not secret (these games put
     *   player ids on the wire), so the window is exactly when a seat is worth stealing.
     *   A duplicate tab (Chrome copies sessionStorage) does present the right token;
     *   then newest wins and the OLD connection is told it was superseded — unless its
     *   join comes from a connection that has been out of touch since before the
     *   current holder was last HEARD FROM, i.e. a retry timer from a tab the player
     *   abandoned, which is superseded instead. "Heard from", not "bound": a binding
     *   whose ack may never have arrived defends nothing, or a player with one tab is
     *   superseded by their own next rung.
     *
     *   Two seats cannot be defended, and are deliberately left claimable:
     *     - one whose token was never confirmed (the ack may never have arrived — the
     *       holder owns a seat they cannot prove). Claiming it does NOT invalidate the
     *       old token, so the original holder still gets their seat back (C3).
     *     - one the reconnect window has already released; only the identity is
     *       remembered, and a stale token there simply buys a fresh one.
     */
    class PeerHost extends TypedEmitter {
        constructor(config) {
            super();
            this.config = mergeConfig(DEFAULT_CONFIG, config);
            this.peer = null;
            this.roomCode = '';
            this.peerId = '';

            // Map<clientId, { conn, peerId, clientId, metadata, token, disconnected,
            //                 disconnectedAt, _lastPong, _pingsAwaitingPong, _messageQueue }>
            // Keyed by clientId, not by peer id: one peer can open two DataConnections,
            // and keying by its id let a second join silently overwrite the first seat.
            // A record is BOUND to exactly one DataConnection (`conn`), and the reverse
            // direction is stamped on the connection itself (`_slopnetClientId`). Only
            // the bound connection may speak for a record or close it; see
            // _clientForConn / _handleData / _handleDisconnect.
            this.clients = new Map();

            // Map<clientId, { metadata, token }> — players whose reconnect window expired.
            // They are no longer seated, but they are not strangers either: see _handleJoin.
            this._pastClients = new Map();

            // Map<clientId, reason> — kicks-with-a-reason that could not be delivered
            // because the player was already off the air. Consumed by their next join.
            this._pendingRejections = new Map();

            this._heartbeatTimer = null;
            this._reconnectAttempts = 0;
            this._reconnectTimer = null;
            this._reconnectDueAt = 0;       // when the armed rung is due (resume())
            this._lastAttemptAt = 0;        // when the last registration attempt started
            this._reconnectWindowTimers = new Map();
            this._started = false;
            this._destroyed = false;
            this._pendingStart = null;      // an unsettled start() promise

            // Signalling peer bookkeeping. Handlers are tracked next to the peer they
            // are attached to so a peer can always be silenced before it is dropped.
            this._peerHandlers = null;
            this._pendingPeer = null;        // re-registration in flight
            this._pendingHandlers = null;
            this._retiredPeers = [];         // replaced peers that still own live channels
            this._reconnecting = false;
            this._reconnectFailedReported = false;

            // Orderly shutdown (close()): goodbyes out, then destroy after a grace.
            this._pendingTimer = null;
            this._codeRequested = false;
            this._codeRetries = 0;
            this._codeRetryTimer = null;

            this._closing = false;
            this._closeReason = null;
            this._closeTimer = null;
            this._closePromise = null;
            this._closeResolve = null;

            // Dependency injection for testing
            this._PeerClass = (config && config._PeerClass) || (typeof Peer !== 'undefined' ? Peer : null);
        }

        /**
         * Start the host and register with the PeerJS signaling server.
         * @param {string} [roomCode] - Optional room code (generated if not provided)
         * @returns {Promise<string>} The room code
         */
        start(roomCode, opts) {
            if (this._destroyed) throw new Error('Host has been destroyed');
            if (this._started) throw new Error('Host already started');
            this._started = true;

            // `opts.reuse` means "this code is OURS from a previous life — the one every
            // player is already holding". Only the caller knows that: from here a
            // remembered code and a freshly chosen one look identical, and the difference
            // decides whether an 'unavailable-id' means "somebody else has this" (take
            // another) or "the server has not let go of ours yet" (wait for it). Getting
            // it wrong the second way silently strands the whole table on a dead code.
            this._codeRequested = !!roomCode && !!(opts && opts.reuse);
            this._codeRetries = 0;
            this.roomCode = roomCode || generateRoomCode(this.config.roomCodeLength, this.config.roomCodeChars);
            this.peerId = this.config.roomPrefix + this.roomCode;

            return new Promise((resolve, reject) => {
                // Tracked so destroy() can settle it. A host destroyed while its first
                // registration was in flight left the caller's `await start()` pending
                // for ever — and an app that double-taps Host, or retires a host it is
                // still making, does exactly that.
                const done = (err, code) => {
                    if (!this._pendingStart) return;
                    this._pendingStart = null;
                    if (err) reject(err); else resolve(code);
                };
                this._pendingStart = done;
                try {
                    this._createPeer((code) => done(null, code), (err) => done(err));
                } catch (e) {
                    this._started = false;
                    done(e);
                }
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
         * The handlers a LIVE (adopted) signalling peer carries for the rest of its life.
         *
         * There is exactly one set, used by both the initial registration and every
         * re-registration. The reconnect path used to leave its ATTEMPT handlers on the
         * adopted peer, and those returned early unless the peer was still pending — so
         * once adopted, the peer's later 'disconnected' reached nothing. The first outage
         * of the night was repaired and the second was not: the room silently fell off
         * the signalling server and nobody could (re)join for the rest of the evening.
         */
        _livePeerHandlers(peer) {
            return {
                error: (err) => {
                    if (this.peer !== peer) return;
                    this.emit('error', err);
                    // Only a signalling-level failure is a reason to re-register. peerjs
                    // also raises 'webrtc' here for a single client's failed negotiation,
                    // and re-registering under an id our own live socket still holds
                    // would only ever be answered 'unavailable-id'.
                    if (!this._started || this._destroyed) return;
                    if (peer.disconnected || isSignallingError(err)) this._startReconnect();
                },
                disconnected: () => {
                    if (this._started && !this._destroyed && this.peer === peer) {
                        this._startReconnect();
                    }
                },
            };
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
                    // The attempt's handlers come off and the live set goes on.
                    this._detachHandlers(peer, handlers);
                    this._adoptPeer(peer);
                    this._reconnectAttempts = 0;
                    this._reconnecting = false;
                    this._clearReconnectTimer();
                    this._startHeartbeat();
                    // Settle the promise BEFORE announcing: an app's `await start()` must
                    // never be left hanging by whatever its own 'ready' listener does.
                    if (resolve) {
                        const done = resolve;
                        resolve = null;
                        reject = null;
                        done(this.roomCode);
                    }
                    this.emit('ready', this.roomCode);
                },
                error: (err) => {
                    if (err && err.type === 'unavailable-id' && resolve) {
                        this._discardPeer(peer, handlers);
                        if (this.peer === peer) { this.peer = null; this._peerHandlers = null; }

                        if (!this._codeRequested) {
                            // A code WE generated collided with somebody else's room.
                            // Nothing has been shown to a player yet, so nothing is
                            // stranded: take another one.
                            this.roomCode = generateRoomCode(this.config.roomCodeLength, this.config.roomCodeChars);
                            this.peerId = this.config.roomPrefix + this.roomCode;
                            this._createPeer(resolve, reject);
                            return;
                        }

                        // A code the CALLER asked for. SlopLobby re-presents the code this
                        // tab was last hosting under precisely so a discarded-and-restored
                        // host tab comes back as the SAME room — and the overwhelmingly
                        // likely reason it is "taken" is that it is still OURS: the
                        // PeerServer has not yet reaped the socket that died with the
                        // radio (~60 s alive_timeout). Re-rolling here silently abandoned
                        // every player holding the code on their screen, with no channel
                        // left to tell them. So keep the id and wait for the server to let
                        // go, exactly as the reconnect path does.
                        if (this._codeRetries >= this.config.maxCodeRetries) {
                            this._started = false;
                            this.emit('error', err);
                            if (reject) {
                                const fail = reject;
                                resolve = null;
                                reject = null;
                                fail(err);
                            }
                            return;
                        }
                        this._codeRetries++;
                        this.emit('room-code-busy', this._codeRetries, this.config.maxCodeRetries);
                        const wait = computeBackoff(
                            this._codeRetries,
                            this.config.reconnectBackoffBase,
                            this.config.reconnectBackoffMultiplier,
                            this.config.reconnectBackoffMax
                        );
                        this._codeRetryTimer = setTimeout(() => {
                            this._codeRetryTimer = null;
                            if (this._destroyed) return;
                            this._createPeer(resolve, reject);
                        }, wait);
                        return;
                    }

                    // The FIRST registration failed. No room exists yet, so there is
                    // nothing to keep alive: the app owns this retry. A never-opened host
                    // that kept re-registering in the background used to come back later
                    // and overwrite the room code the tab had since remembered.
                    this._discardPeer(peer, handlers);
                    if (this.peer === peer) { this.peer = null; this._peerHandlers = null; }
                    this._started = false;
                    this.emit('error', err);

                    if (reject) {
                        const fail = reject;
                        resolve = null;
                        reject = null;
                        fail(err);
                    }
                },
                disconnected: () => {
                    // A socket that dies before 'open' is always reported through 'error'
                    // first (peerjs emits the error, then disconnects), and that branch
                    // has already discarded this peer. Nothing more to do here.
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
        _adoptPeer(peer) {
            const previous = this.peer;
            const previousHandlers = this._peerHandlers;
            const live = this._livePeerHandlers(peer);
            this.peer = peer;
            this._peerHandlers = live;
            this._attachHandlers(peer, live);
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
            if (this._destroyed) return;

            if (data && data.type === '__slopnet_join') {
                this._handleJoin(conn, data);
                return;
            }

            // The room is on its way out. The app has already been told the game is
            // over (it is the one that called close()), so one more move arriving in
            // the grace must not be delivered into a torn-down screen.
            if (this._closing) return;

            // Only the connection a seat is BOUND to may speak for it. A connection with
            // no record — the tail of a superseded tab, a channel whose seat expired
            // while the tab was frozen, a stranger who never joined — used to have its
            // traffic delivered under a raw peer id the apps could not map to anyone,
            // and its pings answered, which kept its heartbeat green forever. Now it
            // gets nothing but a nudge to rejoin, and a live client acts on that.
            const client = this._clientForConn(conn);
            if (!client) {
                this._nudgeRejoin(conn);
                return;
            }

            // Every other inbound message — ping, pong or game traffic — is proof this
            // link is alive, and is counted as such before anything else looks at it.
            this._noteClientAlive(client);

            // Handle internal heartbeat messages
            if (data && data.type === '__slopnet_ping') {
                try { conn.send({ type: '__slopnet_pong' }); } catch (e) {}
                return;
            }
            if (data && data.type === '__slopnet_pong') {
                return;
            }

            // "Your join_ack arrived, and this is the token that was in it." Until a
            // seat hears this, its token may never have left the building, and the
            // host stays lenient about letting an unproven seat be reclaimed by a
            // connection that cannot present one (see _handleJoin).
            if (data && data.type === '__slopnet_join_confirm') {
                if (client.token && data.token === client.token) client.tokenProven = true;
                return;
            }

            // Regular data message
            this.emit('data', client.clientId, data);
        }

        _handleJoin(conn, data) {
            if (this._closing) {
                // The room is on its way out. Anyone arriving now hears the same goodbye
                // as everyone already here, and is closed the same way.
                try { conn.send({ type: '__slopnet_room_closed', reason: this._closeReason }); } catch (e) {}
                flushClose(conn);
                return;
            }

            const clientId = data.clientId || conn.peer;
            const metadata = data.metadata || {};
            const token = (typeof data.token === 'string' && data.token) ? data.token : null;
            // How long the joiner says it has been since it last heard from THIS host.
            // A duration, not a timestamp, so the two clocks never have to agree.
            const staleMs = (typeof data.staleMs === 'number' && isFinite(data.staleMs) && data.staleMs > 0)
                ? data.staleMs : 0;

            // One connection, one seat. A second join under a DIFFERENT clientId on the
            // same channel re-stamps the connection, and the record it used to point at
            // becomes unreachable: its close is ignored (C2), no window is armed and
            // 'client-left'/'client-lost' can never fire for it — a ghost that outlives
            // the room and deadlocks every app that waits on getConnectedClientIds().
            // Put the old seat down properly first.
            const prior = this._clientForConn(conn);
            if (prior && prior.clientId !== clientId) {
                // IGNORED. A clientId belongs to a PeerClient instance and a PeerClient
                // owns exactly one connection, so a second identity arriving on a channel
                // that already has one is never a real player: it is a client looping its
                // own join, or one deliberately minting seats.
                //
                // Putting the old seat down and re-stamping the channel let ONE connection
                // mint unbounded seats — each retired record keeping a 120 s window timer
                // and its own copy of every broadcast — until the host's maps and every
                // app's roster were full of ghosts no disconnect could clear.
                //
                // But refusing it is not the answer either: a refusal closes the channel,
                // and this channel belongs to `prior` — so the impostor join would
                // disconnect the seat it was trying to displace, and a reject message on
                // it is terminal for the PeerClient that legitimately owns it. There is
                // nobody here to answer, so say nothing and change nothing: the channel
                // goes on serving the identity it was bound to.
                return;
            }

            // A kick with a reason that could not be delivered while the player was off
            // the air. Tell them now, once, instead of seating them again: their retry
            // ladder used to walk them straight back in as a brand-new player.
            //
            // ONLY the automatic ladder, though. `staleMs` is set by PeerClient only
            // once it has actually heard from this host (_joinMessage), so a rung of a
            // client that was acked at some point always carries one, while a join from
            // a PeerClient built since — an app that put the player back on its join
            // form and invited them to try again — carries none. Spending the held kick
            // on THAT is spending it on the retry the app itself asked for: flip-7 and
            // herd-mentality refuse a join by returning 'Name already taken' from
            // onPlayerJoined, and the corrected name used to be refused with the stale
            // words while onPlayerJoined was never even asked about it. A deliberate
            // new join goes to the app, which has its own no-new-players gate; only the
            // machine's own retry is turned away here.
            if (staleMs > 0 && this._pendingRejections.has(clientId)) {
                const reason = this._pendingRejections.get(clientId);
                this._pendingRejections.delete(clientId);
                this._refuseSeat(conn, reason);
                return;
            }

            // Check if this is a reconnection
            const existing = this._findClientByClientId(clientId);
            if (existing) {
                // The token protects the SEAT, for as long as the host is holding one
                // — whether somebody is sitting in it this instant or their reconnect
                // window is still running. A clientId is unique, not secret (every one
                // of these games puts player ids on the wire), so a join that cannot
                // present the seat's token is turned away and the holder is not
                // disturbed. Refusing only the occupied case handed a two-minute window
                // to anyone who read an id off the wire, AND re-minted the token
                // underneath the true holder, whose own ladder then came home to a
                // terminal "that seat belongs to another connection".
                //
                // The one seat that CANNOT be defended this way is one whose token the
                // holder may never have received: the host mints it in the join_ack,
                // and an ack that never arrived leaves a player owning a seat with no
                // way to prove it, for the life of the room. So the seat is only locked
                // once the client has said the token reached it (__slopnet_join_confirm,
                // or a later join presenting it). Until then an unproven, EMPTY seat
                // stays claimable — and the token it had keeps working (_rotateToken),
                // so the original holder can still come home and take it back (C3).
                const sameConn = existing.conn === conn;
                const occupied = !sameConn && !existing.disconnected && !!existing.conn && !!existing.conn.open;
                const tokenOk = !existing.token || sameConn || token === existing.token ||
                    (!!token && !!existing.altTokens && existing.altTokens.has(token));
                if (!tokenOk) {
                    if (occupied || existing.tokenProven) {
                        this._refuseSeat(conn);
                        return;
                    }
                    this._rotateToken(existing);
                }
                // A record with no token can only have been written by an older host;
                // be lenient and issue one now.
                if (!existing.token) existing.token = generateToken();
                // Possession of the current token is itself proof it was delivered.
                if (token && token === existing.token) existing.tokenProven = true;

                // "Newest wins" is about the player, not about whose timer fired last.
                // A hidden tab's timers are throttled to about one wake a minute, so a
                // rung armed before the player opened the game again can fire long
                // afterwards — and it carries the same clientId and the same token,
                // because Chrome's "Duplicate tab" copies sessionStorage. A join whose
                // last contact with this host predates the moment the CURRENT holder was
                // last heard from has been out of the loop for that holder's whole
                // tenure: it is the tab the player walked away from, and it is the one
                // that is told it has been superseded, rather than the tab in front of
                // them.
                //
                // TWO conditions, and they are about different things.
                //
                // `heardFromAt > 0` says the CURRENT binding is real: it is zeroed by
                // _bindConn and only ever set by _noteClientAlive, so a non-zero value
                // means somebody has spoken on that connection since it was bound. A
                // binding nobody has acknowledged is not evidence that anyone is sitting
                // there, and it must not be allowed to turn a returning player away.
                //
                // The comparison, though, is against `boundAt` — when the holder
                // connected — and NOT against heardFromAt. The two stamps measure
                // OPPOSITE DIRECTIONS of the same link: `staleMs` is how long since the
                // JOINER last heard from us, while heardFromAt is when WE last heard from
                // the holder. For one tab reconnecting into its own seat those are the
                // same link, and comparing them made the winner depend on which direction
                // happened to carry the last packet — so a player whose final act was
                // outbound (they tapped, then the radio died: the ordinary case) was
                // superseded by their own next rung, terminally, since 'superseded' never
                // reconnects.
                //
                // Against boundAt the question becomes the one actually worth asking:
                // has this joiner been out of the loop since before the current holder
                // even connected? Only then is it a tab from a previous era — the one the
                // player walked away from — rather than the tab in front of them. Their
                // own reconnect always carries a last-contact at or after the moment they
                // were bound (the ack itself is inbound), so it can never lose.
                if (occupied && staleMs > 0 && existing.heardFromAt > 0 &&
                    Date.now() - staleMs < existing.boundAt) {
                    this._supersede(conn);
                    return;
                }

                // Reconnection
                const oldConn = existing.conn;
                existing.disconnected = false;
                existing.disconnectedAt = null;
                existing._lastPong = Date.now();
                existing._pingsAwaitingPong = 0;
                existing.metadata = metadata;

                // Clear reconnect window timer
                this._clearReconnectWindowTimer(clientId);

                // Bound to the new connection FIRST, then the old one is dismissed: with
                // real peerjs close() fires 'close' synchronously, and the record must
                // already be bound elsewhere so that close is a no-op (_handleDisconnect).
                this._bindConn(existing, conn);
                if (oldConn && oldConn !== conn) this._supersede(oldConn);

                // Seated again, so any undelivered kick is spent. Leaving it in the map
                // meant it sat there waiting for this player's NEXT ordinary reconnect —
                // a blip minutes later, in a game they are now legitimately playing —
                // and terminally ejected them with the words from an argument that was
                // over. A kick is one-shot: it applies to the player who was kicked, not
                // to the seat they later hold.
                this._pendingRejections.delete(clientId);
                this._ack(conn, true, clientId, existing.token);
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
            // what refuses them their own seat. Their token travelled with them —
            // but the seat has been given back to the game, so a token that does not
            // match is not grounds for refusing anyone: nobody is holding this seat.
            // A stale token simply buys a fresh one.
            const past = this._pastClients.get(clientId);
            const returning = !!past;
            if (returning) this._pastClients.delete(clientId);
            const keptToken = (past && past.token && token === past.token) ? past.token : null;

            const clientInfo = {
                conn,
                peerId: conn.peer,
                clientId,
                metadata,
                token: keptToken || generateToken(),
                // Tokens this seat has issued before, still accepted as proof. A seat
                // that had to be handed to somebody who could not prove it (see above)
                // must not lock its original holder out when they do come back.
                altTokens: null,
                // Whether the holder has told us the token reached them. A seat whose
                // token was never confirmed is not defensible: see _handleJoin.
                tokenProven: !!keptToken,
                // Diagnostic only. It is deliberately NOT what the rejoin tie-break
                // reads — see heardFromAt below and _handleJoin.
                boundAt: Date.now(),
                // When the CURRENT binding last said anything. Reset by _bindConn and
                // stamped by _noteClientAlive: it is the only evidence that the
                // connection holding this seat is carrying a live tab, and the seat is
                // only defended against a returning rung once it exists.
                heardFromAt: 0,
                disconnected: false,
                disconnectedAt: null,
                _lastPong: Date.now(),
                _pingsAwaitingPong: 0,
                _messageQueue: [],
            };
            this.clients.set(clientId, clientInfo);
            this._bindConn(clientInfo, conn);
            // Seated, so any undelivered kick is spent — see the rejoin path above.
            this._pendingRejections.delete(clientId);
            this._ack(conn, returning, clientId, clientInfo.token);
            this.emit(returning ? 'client-rejoined' : 'client-joined', clientId, metadata);
        }

        _ack(conn, reconnected, clientId, token) {
            try {
                conn.send({ type: '__slopnet_join_ack', reconnected, clientId, token });
            } catch (e) {}
        }

        /**
         * Bind a record to a connection, in both directions. The connection carries the
         * clientId so that inbound traffic can be resolved without trusting `conn.peer`
         * — one peer may own several connections.
         */
        _bindConn(client, conn) {
            client.conn = conn;
            client.peerId = conn.peer;
            client.boundAt = Date.now();
            // A brand-new binding has proved nothing yet. The ack has not even been
            // sent, let alone received, so until this connection says something back
            // the seat is not defensible against the holder's own next rung.
            client.heardFromAt = 0;
            conn._slopnetClientId = client.clientId;
        }

        /**
         * Issue this seat a new token WITHOUT invalidating the one it had.
         *
         * Used only when an unproven, empty seat is handed to a connection that could
         * not present its token. The previous token stays valid because the likeliest
         * owner of it is the player who was here first — a join_ack that never landed,
         * a confirm lost with the radio — and re-minting on its own is what turned
         * "somebody took my seat" into a permanent lockout: their ladder came home with
         * a token this host itself had issued and was refused for the life of the room.
         */
        _rotateToken(client) {
            if (client.token) {
                if (!client.altTokens) client.altTokens = new Set();
                client.altTokens.add(client.token);
                while (client.altTokens.size > MAX_ALT_TOKENS) {
                    client.altTokens.delete(client.altTokens.keys().next().value);
                }
            }
            client.token = generateToken();
            client.tokenProven = false;
        }

        /** The seat this connection is bound to, or null. */
        _clientForConn(conn) {
            if (!conn) return null;
            const clientId = conn._slopnetClientId;
            if (!clientId) return null;
            const client = this.clients.get(clientId);
            return (client && client.conn === conn) ? client : null;
        }

        /**
         * Turn a join away for good. Either it presented the wrong token for a seat
         * somebody is sitting in, or it is a player the host kicked while they were
         * off the air. Told once and flush-closed; nobody else hears anything.
         */
        _refuseSeat(conn, reason) {
            const text = reason == null ? SEAT_TAKEN_REASON : String(reason);
            try { conn.send({ type: '__slopnet_join_reject', reason: text }); } catch (e) {}
            flushClose(conn);
        }

        /**
         * The seat was reclaimed by a newer connection with the right token. Tell the
         * old one so it stops — it is a duplicate tab, and left to itself it would see
         * its channel close and dial straight back in, taking the seat back again in a
         * loop with the tab the player is actually looking at.
         */
        _supersede(oldConn) {
            oldConn._slopnetSuperseded = true;
            try { oldConn.send({ type: '__slopnet_superseded' }); } catch (e) {}
            flushClose(oldConn);
        }

        /**
         * Tell a connection that holds no seat to join again. Rate-limited per
         * connection: the point is one message a live client acts on, not a stream.
         * A superseded connection is deliberately left out — it has already been told
         * something better.
         */
        _nudgeRejoin(conn) {
            if (!conn || conn._slopnetSuperseded) return;
            const now = Date.now();
            if (conn._slopnetLastRejoinNudge && now - conn._slopnetLastRejoinNudge < REJOIN_NUDGE_INTERVAL_MS) return;
            conn._slopnetLastRejoinNudge = now;
            try { conn.send({ type: '__slopnet_rejoin_required' }); } catch (e) {}
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
            // Proof that the connection this seat is bound to reaches a running tab —
            // the join_confirm that follows every ack is the first of these. The
            // rejoin tie-break is decided on it (see _handleJoin).
            client.heardFromAt = client._lastPong;
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
            return this.clients.get(clientId) || null;
        }

        _handleDisconnect(conn) {
            // Teardown closes connections ourselves; their 'close' says nothing new.
            if (this._destroyed || this._closing) return;
            // Only the BOUND connection may mark its record down. A stale connection
            // (superseded, or already unseated) closing must not touch a live seat.
            const client = this._clientForConn(conn);
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
                this.clients.delete(client.clientId);
                // Releasing the seat at once is not the same as never having met them:
                // remember the identity exactly as the windowed path does, or a player
                // who merely blinked comes back as a stranger and every app's
                // no-new-players-mid-game gate refuses them their own seat.
                this._rememberPastClient(client);
                this.emit('client-lost', client.clientId, client.metadata);
            }
        }

        _armReconnectWindow(client) {
            const timer = setTimeout(() => {
                // A window that runs out during close()'s grace has nothing to announce:
                // the room is over and the app has torn its lobby down already.
                if (this._destroyed || this._closing) return;
                this._reconnectWindowTimers.delete(client.clientId);
                if (!client.disconnected) return;
                this.clients.delete(client.clientId);
                // The seat goes back to the game, but remember who held it: if this
                // player turns up again they are a rejoin, not a stranger.
                this._rememberPastClient(client);
                // A channel that is still open here belongs to a tab whose JavaScript
                // stopped (locked phone, frozen tab). Closing it is the only way that
                // tab, when it thaws, sees something real and reconnects — otherwise it
                // talks into a channel nobody is listening to. The record is already
                // gone, so the 'close' this raises is ignored by _handleDisconnect.
                //
                // Only OUR channel, though: the same binding rule _handleDisconnect
                // applies. A connection that has since been re-stamped for a different
                // clientId belongs to somebody else now, and closing it would drop a
                // seated, connected player two minutes after an event that had nothing
                // to do with them.
                const conn = client.conn;
                if (conn && conn.open && conn._slopnetClientId === client.clientId) {
                    try { conn.close(); } catch (e) {}
                }
                this.emit('client-lost', client.clientId, client.metadata);
            }, this.config.reconnectWindowMs);
            this._reconnectWindowTimers.set(client.clientId, timer);
        }

        _rememberPastClient(client) {
            // Delete-then-set so a returning key moves to the newest end, and the cap
            // really does drop the OLDEST.
            this._pastClients.delete(client.clientId);
            if (this._pastClients.size >= MAX_PAST_CLIENTS) {
                this._pastClients.delete(this._pastClients.keys().next().value);
            }
            this._pastClients.set(client.clientId, { metadata: client.metadata, token: client.token || null });
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
         * Forget a seat: timers, memory and the live record, in that order and BEFORE
         * the connection is closed. With real peerjs 'close' fires synchronously inside
         * close(), and with the record already gone that close is a no-op — no
         * 'client-left', no 120 s window armed for a player we just threw out.
         */
        _unseat(client) {
            this._clearReconnectWindowTimer(client.clientId);
            // A kick is deliberate, so this clientId must NOT be remembered as a seat
            // holder — otherwise the kicked player walks straight back in as a rejoin.
            this._pastClients.delete(client.clientId);
            this.clients.delete(client.clientId);
        }

        /**
         * Remove a client entirely (kick). No message of our own: the client sees its
         * channel close and, knowing nothing better, will try to come back — an app
         * that wants it to stop should use rejectClient.
         *
         * The close is a FLUSH close so that whatever the app itself sent immediately
         * before (texas-holdem sends `{type:'error', message:'Game already in
         * progress'}` and kicks in the same breath) is still delivered: peerjs's plain
         * close drops the unsent buffer, and that message is the only explanation the
         * player ever gets.
         */
        removeClient(clientId) {
            const client = this._findClientByClientId(clientId);
            if (!client) return this._kickAbsent(clientId, '');
            this._unseat(client);
            // A kick is a decision, not a hiccup. Say nothing, but do not let their
            // ladder walk them back in either: without this the shape every app ships
            // (send an error, then removeClient) is an unbounded loop — the client
            // rejoins a second later, is acked (which rewinds its backoff), is kicked
            // again, and the player's screen flickers "Disconnected/Reconnected" for
            // the rest of the night.
            this._rememberRejection(clientId, '');
            flushClose(client.conn);
            return true;
        }

        /**
         * Remove a client WITH a reason it will hear before the channel closes. The
         * client enters its terminal 'rejected' state and never retries — which is what
         * "send join-error then removeClient" could not guarantee: a plain close drops
         * unsent messages, so the reason was lost and the client came straight back to
         * be rejected again, forever.
         */
        rejectClient(clientId, reason) {
            const text = String(reason == null ? '' : reason);
            const client = this._findClientByClientId(clientId);
            if (!client) return this._kickAbsent(clientId, text);
            const conn = client.conn;
            if (conn && conn.open) {
                try { conn.send({ type: '__slopnet_join_reject', reason: text }); } catch (e) {}
            }
            // The reason is ALSO kept for their next join, whatever we believe about
            // the channel. `conn.open` is only the host's opinion: a phone whose radio
            // died sees its own close at once and starts its ladder, while this side
            // reads open until the heartbeat convicts it — up to ~20 s on the defaults.
            // A kick issued in that window used to be shouted into a dead channel and
            // forgotten, and the player it removed walked back in as a brand-new
            // joiner. Held reasons are consumed by one knock, so a player who really
            // did hear it costs nothing.
            this._rememberRejection(clientId, text);
            this._unseat(client);
            flushClose(conn);
            return true;
        }

        /**
         * Kick somebody who is not sitting down: their reconnect window has expired
         * and only their identity is remembered (_pastClients), which is precisely the
         * memory that makes their next join a 'client-rejoined' — the event every app
         * uses to BYPASS its no-new-players-mid-game check. Both kick entry points
         * used to bail here and report false, so the ghost the host had just tapped
         * "Remove" on walked straight back into the game.
         */
        _kickAbsent(clientId, reason) {
            if (!this._pastClients.has(clientId)) return false;
            this._pastClients.delete(clientId);
            this._clearReconnectWindowTimer(clientId);
            this._rememberRejection(clientId, reason);
            return true;
        }

        /** Hold an undeliverable kick reason for the next join by that clientId. */
        _rememberRejection(clientId, reason) {
            this._pendingRejections.delete(clientId);
            if (this._pendingRejections.size >= MAX_PENDING_REJECTIONS) {
                this._pendingRejections.delete(this._pendingRejections.keys().next().value);
            }
            this._pendingRejections.set(clientId, reason);
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
                    this._pingClient(client);
                }
            }, this.config.heartbeatInterval);
        }

        _pingClient(client) {
            try {
                client.conn.send({ type: '__slopnet_ping' });
                client._pingsAwaitingPong = (client._pingsAwaitingPong || 0) + 1;
            } catch (e) {}
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
            this._reconnectFailedReported = false;
            this._reconnectAttempts = 0;   // a fresh outage starts a fresh ladder — and
                                           // ONLY a fresh outage does
            this._lastAttemptAt = 0;       // ...and nothing has been dialled in it yet
            this._attemptReconnect();
        }

        /**
         * Arm the next rung. The ladder is never abandoned: past maxReconnectAttempts
         * 'reconnect-failed' is reported once and the host keeps knocking at the
         * plateau interval for as long as it lives. A host that gives up for good has
         * made every player's room code permanently undialable — while the game may
         * still be running perfectly over the channels it already has.
         */
        _attemptReconnect() {
            if (this._destroyed || !this._started) return;
            const max = this.config.maxReconnectAttempts;
            if (this._reconnectAttempts >= max && !this._reconnectFailedReported) {
                this._reconnectFailedReported = true;
                this.emit('reconnect-failed');
            }

            const delay = computeBackoff(
                Math.min(this._reconnectAttempts, max),
                this.config.reconnectBackoffBase,
                this.config.reconnectBackoffMultiplier,
                this.config.reconnectBackoffMax
            );
            this._reconnectAttempts++;
            // Clamped like the client's: past the ladder we are repeating the last rung.
            this.emit('reconnecting', Math.min(this._reconnectAttempts, max), max);

            // When this rung is due. resume() only brings a rung forward once it is
            // OVERDUE — see resume().
            this._reconnectDueAt = Date.now() + delay;
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
            if (this._destroyed || !this._started) return;
            if (this._pendingPeer) return;   // an attempt is already in flight

            this._lastAttemptAt = Date.now();
            let peer;
            try {
                peer = this._newPeer();
            } catch (e) {
                // A throw here is just a failed rung, exactly as it is on the client
                // (_createPeerAndConnect). Clearing _reconnecting and returning ended
                // the ladder for good and silently: no timer was left, so nothing ever
                // ran again; 'reconnect-failed' was never emitted, so no app could
                // tell; and resume() only fires a rung that is already armed, so the
                // visibilitychange lever could not restart it either. The room was off
                // the signalling server for the rest of the night. C13: keep knocking
                // for as long as _started && !_destroyed.
                this.emit('error', e);
                this._attemptReconnect();
                return;
            }

            const handlers = {
                open: () => {
                    if (this._pendingPeer !== peer) return;
                    this._clearPendingTimer();
                    this._pendingPeer = null;
                    this._pendingHandlers = null;
                    // Attempt handlers off, live handlers on — the adopted peer must be
                    // able to report the NEXT outage too.
                    this._detachHandlers(peer, handlers);
                    this._adoptPeer(peer);
                    this._reconnecting = false;
                    this._reconnectAttempts = 0;
                    this._reconnectFailedReported = false;
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
                    if (!err || err.type !== 'unavailable-id') this.emit('error', err);
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
            // A rung that never resolves must not wedge the ladder. peerjs gives no
            // event for "the socket opened but the server never answered", and every
            // lever out of here is gated on this attempt finishing: _attemptReconnect is
            // only re-entered from _failedAttempt, resume() only fires a rung that is
            // already ARMED (this one is in flight, so there is no timer), _doReconnect
            // returns early on _pendingPeer and _startReconnect on _reconnecting. So a
            // hung rung meant the room was off the signalling server permanently, with no
            // event, no timer and no escape hatch. Give it the same deadline every client
            // attempt gets, after which it is simply a failed rung.
            this._pendingTimer = setTimeout(() => {
                this._pendingTimer = null;
                if (this._pendingPeer !== peer) return;
                this._failedAttempt(peer, handlers);
            }, this.config.connectionTimeout);
            this._attachHandlers(peer, handlers);
        }

        _clearPendingTimer() {
            if (this._pendingTimer) {
                clearTimeout(this._pendingTimer);
                this._pendingTimer = null;
            }
        }

        _failedAttempt(peer, handlers) {
            this._clearPendingTimer();
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

        /**
         * Whether resume() may dial now: the ladder has not actually tried yet, or the
         * rung it armed should already have fired.
         *
         * This is the whole of resume()'s licence to dial early. A backgrounded tab's
         * timers are throttled to about one wake a minute, so a rung armed for six
         * seconds really can be a minute late — that is the case worth fixing. A rung
         * that is still on schedule is left exactly where it is: visibilitychange
         * fires on every app switch, and dialling on each one pins the backoff at its
         * base, hammers the signalling server and (because every failed attempt arms
         * the next rung) marches the host to 'reconnect-failed' — the state every app
         * reads as "the room is gone" — while the room is perfectly healthy over the
         * data channels it already has. The client has had this guard since C24;
         * the host was given resume() without one.
         */
        _mayRedialNow() {
            const now = Date.now();
            if (this._lastAttemptAt && now - this._lastAttemptAt < RESUME_REDIAL_MIN_MS) return false;
            // Nothing has actually been dialled yet in this outage: the first look at
            // a foregrounded page is always worth one attempt.
            if (!this._lastAttemptAt) return true;
            return !this._reconnectDueAt || now >= this._reconnectDueAt;
        }

        /**
         * "The page just became visible."
         *
         * A backgrounded tab's timers are throttled to one wake a minute, so a
         * reconnect rung armed for six seconds may not fire for sixty. If one is
         * OVERDUE, run it now. And ping every seated client at once: a channel that
         * died while the tab slept is then caught on the next heartbeat tick rather
         * than three ticks later.
         */
        resume() {
            if (this._destroyed || !this._started) return;
            if (this._reconnectTimer && this._mayRedialNow()) {
                this._clearReconnectTimer();
                this._doReconnect();
            }
            for (const [, client] of this.clients) {
                if (client.disconnected || !client.conn || !client.conn.open) continue;
                this._pingClient(client);
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
         * End the room properly: every seated client hears 'room-closed' (with the
         * reason) BEFORE its channel closes, and the host destroys itself once the
         * goodbyes have had a moment to leave. Idempotent; resolves after destroy().
         *
         * The wait is bounded by graceMs alone — it does not wait for the remote closes,
         * because a client that is already gone would never send one. destroy() called
         * during the grace destroys immediately and forfeits the goodbye guarantee.
         *
         * Without this, "Leave game" on the host was indistinguishable, from a player's
         * seat, from the host's phone dying: every client reconnected for ~3.5 minutes
         * against a room that no longer existed.
         */
        close(reason, opts) {
            if (this._destroyed) return Promise.resolve();
            if (this._closePromise) return this._closePromise;

            const graceMs = (opts && typeof opts.graceMs === 'number')
                ? opts.graceMs
                : this._defaultGrace();
            this._closing = true;
            this._closeReason = reason == null ? null : reason;
            // No more judging silence: we are the ones going quiet.
            this._stopHeartbeat();

            const goodbye = { type: '__slopnet_room_closed', reason: this._closeReason };
            for (const [, client] of this.clients) {
                const conn = client.conn;
                if (!conn) continue;
                if (conn.open) {
                    try { conn.send(goodbye); } catch (e) {}
                }
                flushClose(conn);
            }

            this._closePromise = new Promise((resolve) => {
                this._closeResolve = resolve;
                this._closeTimer = setTimeout(() => {
                    this._closeTimer = null;
                    this.destroy();
                }, graceMs);
            });
            return this._closePromise;
        }

        /**
         * How long to hold the door open on close().
         *
         * A player whose channel dropped a moment ago cannot be sent anything, but they
         * ARE about to knock: their first reconnect rung is reconnectBackoffBase away,
         * and a join that arrives while we are closing is answered with the same
         * goodbye everyone else got (see _handleJoin's _closing branch). So when a seat
         * is being held for somebody absent, wait past that first rung. With nobody
         * absent there is nothing to wait for.
         *
         * It is not a guarantee: a player whose ladder has climbed to a later rung, or
         * whose phone is asleep, is beyond reach and finds an empty room. That is the
         * documented limit of close().
         */
        _defaultGrace() {
            let absent = false;
            for (const [, client] of this.clients) {
                if (client.disconnected || !client.conn || !client.conn.open) { absent = true; break; }
            }
            if (!absent) return DEFAULT_CLOSE_GRACE_MS;
            return Math.max(DEFAULT_CLOSE_GRACE_MS, this.config.reconnectBackoffBase + 250);
        }

        /**
         * Destroy the host and clean up all resources. Immediate: nobody is told.
         *
         * Bookkeeping is cleared BEFORE any connection is closed. With real peerjs
         * close() fires 'close' synchronously, and with the records still in place the
         * old order emitted 'client-left' for every seated player on Leave and then
         * re-armed a 120 s window timer for each of them after the map was wiped.
         */
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this._started = false;
            this._reconnecting = false;

            this._stopHeartbeat();
            this._clearReconnectTimer();
            if (this._closeTimer) {
                clearTimeout(this._closeTimer);
                this._closeTimer = null;
            }
            if (this._codeRetryTimer) {
                clearTimeout(this._codeRetryTimer);
                this._codeRetryTimer = null;
            }
            this._clearPendingTimer();

            for (const [, timer] of this._reconnectWindowTimers) {
                clearTimeout(timer);
            }
            this._reconnectWindowTimers.clear();

            const conns = [];
            for (const [, client] of this.clients) {
                if (client.conn) conns.push(client.conn);
            }
            this.clients.clear();
            this._pastClients.clear();
            this._pendingRejections.clear();

            for (const conn of conns) {
                try { conn.close(); } catch (e) {}
            }

            this._destroyPeer();

            // A start() that never settled must not leave its caller waiting.
            if (this._pendingStart) {
                const settle = this._pendingStart;
                const err = new Error('Host destroyed');
                err.type = 'destroyed';
                settle(err);
            }

            this.emit('destroyed');
            this.removeAllListeners();

            if (this._closeResolve) {
                const done = this._closeResolve;
                this._closeResolve = null;
                done();
            }
        }
    }

    /**
     * peerjs error types that mean the SIGNALLING socket is gone (or never came up),
     * as opposed to one DataConnection's negotiation failing ('webrtc') or a dial to a
     * peer that is not there ('peer-unavailable').
     */
    function isSignallingError(err) {
        const type = err && err.type;
        return type === 'network' || type === 'server-error' || type === 'socket-error' ||
            type === 'socket-closed' || type === 'unavailable-id' || type === 'disconnected';
    }

    // =========================================================================
    // PeerClient
    // =========================================================================

    /**
     * Events:
     *   'connected'       ()                 - The FIRST successful join of this instance's life
     *   'reconnected'     (hostRemembersUs)  - Every later successful join. `false` means the host
     *                                          had no record of us (it restarted and re-registered
     *                                          the same code): whatever state it held for us is
     *                                          gone and the app must re-send what matters.
     *   'token'           (token)            - The seat token changed (first ack, or a restarted
     *                                          host minted a new one). Persist it and hand it to
     *                                          the next connect() as opts.token.
     *   'data'            (data)             - Data received from host
     *   'disconnected'    ()                 - Link lost; reconnection is being attempted. NEVER
     *                                          emitted once the client is terminal.
     *   'reconnecting'    (attempt, max)     - Attempting to reconnect
     *   'reconnect-failed' ()                - Exhausted reconnection attempts. Emitted ONCE per
     *                                          ladder, and the peer built for the last rung is
     *                                          torn down with it — nothing is left registered
     *                                          or wired. reconnect()/resume() start a fresh
     *                                          ladder (and may report failure again).
     *   'rejected'        (reason)           - TERMINAL. The host refused, or later removed, this
     *                                          seat and said why.
     *   'superseded'      ()                 - TERMINAL. Another connection presented our clientId
     *                                          AND token — a duplicate of this tab — and took the
     *                                          seat. This one should go quiet.
     *   'room-closed'     (reason)           - TERMINAL. The host ended the room.
     *   'error'           (error)            - Error occurred
     *   'destroyed'       ()                 - Client peer destroyed
     *
     * Terminal states ('rejected' | 'superseded' | 'room-closed') tear the peer down,
     * never reconnect, never emit 'disconnected', and make send() return false without
     * queueing. See isTerminal / terminalReason.
     *
     * connect(roomCode, clientId, metadata, { token }) rejects with `err.type` one of:
     *   a peerjs error type ('peer-unavailable', 'network', 'server-error', ...)
     *   'connection-timeout'   nothing acked within connectionTimeout
     *   'connection-closed'    the data channel closed or errored before the first ack
     *   'destroyed'            destroy() was called while connect() was pending
     *   'rejected' | 'superseded' | 'room-closed'
     *                          the host turned us away before acking (err.reason carries
     *                          the host's reason string where there is one)
     * A rejection that arrives AFTER the ack does not reject connect(); it is reported
     * through the terminal event alone.
     *
     * Methods of note:
     *   send(data)   -> boolean. true = on the wire now; false = queued (or dropped when
     *                   terminal/destroyed).
     *   reconnect()  -> run the next attempt NOW with a fresh ladder. No-op while
     *                   connected, mid-attempt, terminal, destroyed or never connected.
     *                   This is the app's Retry button: it rewinds the ladder.
     *   resume()     -> "the page just became visible": while connected, ping and re-check
     *                   the heartbeat's verdict 3 s later (never a stricter one); while
     *                   disconnected, bring the pending rung forward, at most once per
     *                   second and WITHOUT rewinding the ladder.
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
            this.token = null;

            this._connected = false;
            this._connecting = false;       // one attempt is mid-negotiation
            this._hasConnectedOnce = false;
            this._terminal = null;          // 'rejected' | 'superseded' | 'room-closed'
            this._terminalPayload = null;
            this._reconnectAttempts = 0;
            this._reconnectFailedReported = false;  // one 'reconnect-failed' per ladder
            this._reconnectTimer = null;
            this._connectTimer = null;      // the current attempt's overall timeout
            this._resumeProbe = null;
            this._lastAttemptAt = 0;        // when the current/last attempt was started
            this._heartbeatTimer = null;
            this._lastPongTime = 0;
            this._pingsAwaitingPong = 0;   // pings sent since we last heard anything back
            this._lastJoinResend = 0;
            this._messageQueue = [];
            this._pendingConnect = null;    // { resolve, reject } of an unsettled connect()
            this._destroyed = false;

            // Dependency injection for testing
            this._PeerClass = (config && config._PeerClass) || (typeof Peer !== 'undefined' ? Peer : null);
        }

        /**
         * Connect to a host room.
         * @param {string} roomCode
         * @param {string} clientId - Unique client identifier (used for reconnection)
         * @param {object} [metadata] - Metadata to send with join message
         * @param {object} [opts]
         * @param {string} [opts.token] - Seat token from a previous session with this host
         * @returns {Promise<void>}
         */
        connect(roomCode, clientId, metadata, opts) {
            if (this._destroyed) throw new Error('Client has been destroyed');
            if (this._connected) throw new Error('Client already connected');
            if (this._terminal) throw new Error('Client is terminal (' + this._terminal + ')');
            // One instance, one connection. A second connect() would wire a second peer
            // and a second set of handlers onto the same state machine.
            if (this._connecting || this._hasConnectedOnce) throw new Error('Client already connecting/connected');

            this.roomCode = roomCode;
            this.clientId = clientId;
            this.metadata = metadata || {};
            if (opts && typeof opts.token === 'string' && opts.token) this.token = opts.token;

            return new Promise((resolve, reject) => {
                this._createPeerAndConnect(resolve, reject);
            });
        }

        _joinMessage() {
            const msg = { type: '__slopnet_join', clientId: this.clientId, metadata: this.metadata };
            // Always the CURRENT token: a restarted host may have minted a new one since.
            if (this.token) msg.token = this.token;
            // How long since we last heard anything from this host. The host uses it to
            // order two connections claiming the same seat: a rung fired by a tab the
            // player abandoned has been out of touch since before the tab they are
            // looking at sat down, and must not evict it. A duration rather than a
            // timestamp, because the two clocks are never the same clock.
            const stale = this._lastPongTime ? Date.now() - this._lastPongTime : 0;
            if (stale > 0) msg.staleMs = stale;
            return msg;
        }

        _createPeerAndConnect(resolve, reject) {
            if (this._destroyed || this._terminal) return;

            const PeerClass = this._PeerClass;
            if (!PeerClass) throw new Error('PeerJS not loaded');

            if (resolve) this._pendingConnect = { resolve, reject };

            // Everything from here to the last handler is wrapped: an exception escaping
            // between "_connecting = true" and the handlers that clear it latches the
            // flag on forever, and _attemptReconnect, _doReconnect, reconnect() and
            // resume() are all gated on it — the client would be permanently offline
            // with nothing reported. A throw is just another failed attempt.
            try {
                this._startAttempt(PeerClass);
            } catch (e) {
                if (!e.type) e.type = 'connection-failed';
                this.emit('error', e);
                this._linkFailed(e);
            }
        }

        _startAttempt(PeerClass) {
            // Flagged BEFORE the previous attempt is torn down: peerjs's destroy() emits
            // 'disconnected' synchronously on the old peer, and anything that re-enters
            // the reconnect logic from there must find an attempt already in flight.
            this._connecting = true;
            this._lastAttemptAt = Date.now();
            this._destroyPeer();

            const peer = new PeerClass(undefined, this.config.peerOptions);
            this.peer = peer;

            // Every handler below belongs to THIS attempt. A retired peer or connection
            // is still an object that emits — peerjs closes them synchronously and they
            // fire their handlers while doing so — so each one checks it is still the
            // current attempt before it is allowed to move the state machine. Without
            // that, every rung of the ladder cancelled itself: destroying rung N's peer
            // raised a 'disconnected' that armed rung N+1 while rung N was still dialling.
            this._connectTimer = setTimeout(() => {
                this._connectTimer = null;
                if (this.peer !== peer || this._connected) return;
                const err = new Error('Connection timeout');
                err.type = 'connection-timeout';
                this.emit('error', err);
                this._linkFailed(err);
            }, this.config.connectionTimeout);

            peer.on('open', () => {
                if (this.peer !== peer) return;
                const hostPeerId = this.config.roomPrefix + this.roomCode;
                let conn;
                try {
                    conn = peer.connect(hostPeerId, { reliable: this.config.reliable });
                } catch (e) {
                    this._linkFailed(e);
                    return;
                }
                this.connection = conn;

                conn.on('open', () => {
                    if (this.connection !== conn) return;
                    try {
                        conn.send(this._joinMessage());
                    } catch (e) {
                        this._linkFailed(e);
                    }
                });

                conn.on('data', (data) => {
                    if (this.connection !== conn) return;
                    this._handleData(data);
                });

                conn.on('close', () => {
                    if (this.connection !== conn) return;
                    const err = new Error('Connection closed');
                    err.type = 'connection-closed';
                    this._linkFailed(err);
                });

                conn.on('error', (e) => {
                    if (this.connection !== conn) return;
                    const err = e instanceof Error ? e : new Error('Connection error');
                    if (!err.type) err.type = 'connection-closed';
                    this._linkFailed(err);
                });
            });

            peer.on('error', (err) => {
                if (this.peer !== peer) return;
                this.emit('error', err);
                // A signalling error on a peer whose data channel is open and in use is
                // not a reason to rebuild anything. peerjs raises error{network} just
                // BEFORE 'disconnected' when the socket dies on a backgrounded phone, and
                // rebuilding here closed a perfectly good channel for it. Same rule the
                // 'disconnected' handler below has always applied.
                if (this._connected && this.connection && this.connection.open) return;
                this._linkFailed(err);
            });

            peer.on('disconnected', () => {
                if (this.peer !== peer) return;
                // Losing the signalling socket is not losing the game. PeerJS keeps that
                // socket alive with a JS timer, so a backgrounded phone loses it on its
                // own after ~60s, while the DataConnection — native WebRTC, no JS timer
                // involved — keeps carrying every message. Tearing down here would kill a
                // healthy channel for a reason that has nothing to do with it.
                if (this.connection && this.connection.open) return;
                if (!this._hasConnectedOnce && !this._connecting) return;
                const err = new Error('Signalling connection lost');
                err.type = 'network';
                this._linkFailed(err);
            });
        }

        /**
         * The current peer/connection can no longer carry the game, so the attempt that
         * owned it is over. On a first connect there is nothing to fall back to: tear
         * down what we built and hand the error to connect()'s caller (an `await
         * joinRoom()` used to hang forever on a "Connecting…" screen here). Otherwise
         * fall into the ordinary reconnect ladder.
         */
        _linkFailed(err) {
            this._connecting = false;
            this._clearConnectTimer();
            if (this._destroyed || this._terminal) return;
            if (!this._hasConnectedOnce) {
                this._destroyPeer();
                this._settleConnect(err);
                return;
            }
            this._onDisconnect();
        }

        _settleConnect(err) {
            const pending = this._pendingConnect;
            if (!pending) return;
            this._pendingConnect = null;
            if (err) pending.reject(err);
            else pending.resolve();
        }

        _handleData(data) {
            if (this._destroyed || this._terminal) return;
            // Anything at all from the host answers a resume() probe.
            this._clearResumeProbe();

            if (data && data.type === '__slopnet_join_ack') {
                this._onJoinAck(data);
                return;
            }
            if (data && data.type === '__slopnet_join_reject') {
                this._terminate('rejected', typeof data.reason === 'string' ? data.reason : '');
                return;
            }
            if (data && data.type === '__slopnet_superseded') {
                this._terminate('superseded');
                return;
            }
            if (data && data.type === '__slopnet_room_closed') {
                this._terminate('room-closed', data.reason == null ? null : data.reason);
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

            if (data && data.type === '__slopnet_rejoin_required') {
                this._resendJoin();
                return;
            }

            // Regular message
            this.emit('data', data);
        }

        _onJoinAck(data) {
            this._clearConnectTimer();
            this._connecting = false;
            // A successful join ends the attempt, so the next drop may redial at once
            // rather than being rate-limited against the attempt that just worked.
            this._lastAttemptAt = 0;
            const first = !this._hasConnectedOnce;
            this._connected = true;
            this._hasConnectedOnce = true;
            this._reconnectAttempts = 0;
            this._reconnectFailedReported = false;
            this._clearReconnectTimer();
            this._lastPongTime = Date.now();
            this._pingsAwaitingPong = 0;
            this._startHeartbeat();

            // The host is authoritative about the seat token: a restarted host has
            // forgotten us and mints a fresh one, and that is the one to keep.
            let tokenChanged = false;
            if (typeof data.token === 'string' && data.token && data.token !== this.token) {
                this.token = data.token;
                tokenChanged = true;
            }

            // Tell the host the token got here. Until it hears this the host cannot
            // tell "the seat's owner is off the air" from "the seat's owner never
            // received the proof we minted for them", and has to stay lenient about
            // handing that seat to whoever asks — which is exactly the window a
            // stranger who read the clientId off the wire would walk through.
            if (this.token && this.connection && this.connection.open) {
                try {
                    this.connection.send({ type: '__slopnet_join_confirm', token: this.token });
                } catch (e) {}
            }

            // Flush queued messages
            this._flushQueue();

            // Settle connect() BEFORE announcing, so a listener can never leave the
            // caller's `await` pending.
            this._settleConnect(null);

            // Token first, so a wrapper has persisted it by the time the app hears
            // it is connected.
            if (tokenChanged) this.emit('token', this.token);

            // 'connected' is for the first ack of this instance's life only. Every
            // later ack is a return — even one the host does not remember (it
            // restarted): announcing that as 'connected' left wrappers that only
            // listen for 'reconnected' showing a "disconnected" banner forever.
            if (first) {
                this.emit('connected');
            } else {
                this.emit('reconnected', !!data.reconnected);
            }
        }

        /**
         * The host says it holds no seat for this connection. If we think we are
         * connected, present our join again on the same channel — the host will treat
         * it as a return (or, after a host restart, a fresh join). Rate-limited: one
         * nudge, one join.
         */
        _resendJoin() {
            if (!this._connected || !this.connection || !this.connection.open) return;
            const now = Date.now();
            if (this._lastJoinResend && now - this._lastJoinResend < REJOIN_NUDGE_INTERVAL_MS) return;
            this._lastJoinResend = now;
            try { this.connection.send(this._joinMessage()); } catch (e) {}
        }

        /**
         * Enter a terminal state. The host has said, in so many words, that this
         * connection is not wanted: refused ('rejected'), replaced by a duplicate of
         * ourselves ('superseded'), or the room is over ('room-closed'). Nothing here
         * is a network fault, so nothing here is worth a reconnect — a client that
         * retried anyway was the retry storm that kept knocking on a host that had
         * already turned it away.
         */
        _terminate(reason, payload) {
            if (this._terminal || this._destroyed) return;
            this._terminal = reason;
            this._terminalPayload = payload === undefined ? null : payload;
            this._connected = false;
            this._connecting = false;
            this._stopHeartbeat();
            this._clearReconnectTimer();
            this._clearResumeProbe();
            this._clearConnectTimer();
            this._messageQueue = [];
            this._destroyPeer();

            // A connect() still waiting for its first ack must settle too.
            const err = new Error('Join ' + reason + (payload ? ': ' + payload : ''));
            err.type = reason;
            err.reason = this._terminalPayload;
            this._settleConnect(err);

            if (reason === 'rejected') this.emit('rejected', this._terminalPayload);
            else if (reason === 'superseded') this.emit('superseded');
            else this.emit('room-closed', this._terminalPayload);
        }

        _onDisconnect() {
            if (this._destroyed || this._terminal) return;
            if (!this._connected && !this._hasConnectedOnce) return;
            this._clearResumeProbe();

            const wasConnected = this._connected;
            this._connected = false;
            this._stopHeartbeat();

            if (wasConnected) {
                this.emit('disconnected');
            }

            this._attemptReconnect();
        }

        /**
         * Send data to the host.
         * If disconnected, queues the message for delivery on reconnect.
         * @returns {boolean} true if it went out on the wire now.
         */
        send(data) {
            // Terminal: there is no host to deliver to, and never will be.
            if (this._terminal || this._destroyed) return false;
            if (this._connected && this.connection && this.connection.open) {
                try {
                    this.connection.send(data);
                    return true;
                } catch (e) {
                    this._enqueue(data);
                    return false;
                }
            }
            this._enqueue(data);
            return false;
        }

        _enqueue(data) {
            this._messageQueue.push(data);
            if (this._messageQueue.length > MAX_QUEUED_MESSAGES) {
                this._messageQueue.splice(0, this._messageQueue.length - MAX_QUEUED_MESSAGES);
            }
        }

        _flushQueue() {
            if (!this._connected || !this.connection || !this.connection.open) return;
            const queue = this._messageQueue.splice(0);
            for (let i = 0; i < queue.length; i++) {
                try {
                    this.connection.send(queue[i]);
                } catch (e) {
                    // Put the tail back, in order, ahead of anything queued since. Only
                    // the failing message used to be re-queued; everything after it
                    // was lost.
                    this._messageQueue = queue.slice(i).concat(this._messageQueue);
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

        /** Whether an attempt (first connect or a reconnect rung) is mid-negotiation. */
        get isConnecting() {
            return this._connecting;
        }

        /**
         * Whether this client has ever been acked by the host. It separates a rejection
         * at the DOOR (connect() is still pending and settles as the failure — the
         * app's `await joinRoom()` throws) from one that arrives after the player was
         * already in (nothing is pending; the terminal event is the only channel).
         */
        get hasJoined() {
            return this._hasConnectedOnce;
        }

        /** Whether the client has reached a terminal state and will never reconnect. */
        get isTerminal() {
            return this._terminal !== null;
        }

        /** 'rejected' | 'superseded' | 'room-closed' | null */
        get terminalReason() {
            return this._terminal;
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

                this._ping();
            }, this.config.heartbeatInterval);
            // missesAllowed is recomputed by _isChannelDead() for resume()'s probe; the
            // two must stay the same rule.
        }

        _ping() {
            try {
                this.connection.send({ type: '__slopnet_ping' });
                this._pingsAwaitingPong = (this._pingsAwaitingPong || 0) + 1;
            } catch (e) {}
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
            if (this._destroyed || this._terminal) return;
            if (this._reconnectTimer) return; // Already waiting for a reconnect attempt
            if (this._connecting) return;     // An attempt is mid-negotiation; let it finish
            if (this._reconnectAttempts >= this._maxTotalAttempts()) {
                // Nothing more is coming, so nothing more may be left running. The rung
                // that failed last handed its peer and connection to the NEXT rung's
                // _destroyPeer() — and there is no next rung, so a client that had given
                // up kept a registered Peer (and its signalling socket, and peerjs's
                // keepalive timer) for the life of the page. It also stayed WIRED: when
                // that socket died in the background it walked straight back in here and
                // announced 'reconnect-failed' all over again, so the app toasted "Lost
                // connection to game" at a player who had stopped minutes ago.
                //
                // The ladder is restartable — reconnect() and resume() both rebuild the
                // peer — so tearing it down here costs nothing.
                this._destroyPeer();
                if (!this._reconnectFailedReported) {
                    this._reconnectFailedReported = true;
                    this.emit('reconnect-failed');
                }
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
            if (this._destroyed || this._terminal) return;
            if (this._connecting) return;
            this._createPeerAndConnect(null, null);
        }

        _clearReconnectTimer() {
            if (this._reconnectTimer) {
                clearTimeout(this._reconnectTimer);
                this._reconnectTimer = null;
            }
        }

        _clearConnectTimer() {
            if (this._connectTimer) {
                clearTimeout(this._connectTimer);
                this._connectTimer = null;
            }
        }

        _clearResumeProbe() {
            if (this._resumeProbe) {
                clearTimeout(this._resumeProbe);
                this._resumeProbe = null;
            }
        }

        /**
         * Manually trigger a reconnection attempt NOW, with a fresh ladder. A pending
         * rung is cancelled rather than waited for — a backgrounded tab's six-second
         * timer may not have fired for a minute, and the player is looking at the
         * screen this instant. No-op while connected, while an attempt is already
         * mid-negotiation (destroying that peer would only start over), when terminal,
         * destroyed, or never connected.
         */
        reconnect() {
            if (this._destroyed || this._terminal) return;
            if (this._connected) return;
            if (!this._hasConnectedOnce) return;
            if (this._connecting) return;

            this._clearReconnectTimer();
            // Rung 1 of a fresh ladder, run immediately instead of after its backoff.
            this._reconnectAttempts = 1;
            this._reconnectFailedReported = false;
            this.emit('reconnecting', 1, this.config.maxReconnectAttempts);
            this._doReconnect();
        }

        /**
         * "The page just became visible."
         *
         * While connected: the channel may have died while the tab slept (a locked
         * phone stops JavaScript, not the radio's opinion of itself), and the heartbeat
         * would take up to three ticks to notice. Ping now, and look again in a moment.
         *
         * The second look does NOT judge on the wall clock. Both ends of these games
         * are phones: when this one wakes first the host's page is still frozen and
         * cannot answer anything, however healthy the channel is. Three seconds of
         * silence from a peer that is not running its JavaScript is not evidence of a
         * dead channel — tearing the peer down there closes a working DataChannel and
         * starts renegotiating against a host that still cannot answer. So the probe
         * applies the heartbeat's OWN rule (pings actually sent and ignored, AND a full
         * heartbeatTimeout of silence) and merely brings that verdict forward by up to
         * one tick.
         *
         * While disconnected: bring the pending rung forward — but not oftener than
         * RESUME_REDIAL_MIN_MS, and without rewinding the ladder. visibilitychange
         * fires on every app switch; dialling on each one pinned the backoff at its
         * base and made 'reconnect-failed' unreachable.
         */
        resume() {
            if (this._destroyed || this._terminal) return;
            if (this._connected) {
                if (!this.connection || !this.connection.open) return;
                this._ping();
                if (!this._resumeProbe) {
                    this._resumeProbe = setTimeout(() => {
                        this._resumeProbe = null;
                        if (this._isChannelDead()) this._onDisconnect();
                    }, RESUME_PROBE_MS);
                }
                return;
            }
            if (this._connecting || !this._hasConnectedOnce) return;
            if (this._lastAttemptAt && Date.now() - this._lastAttemptAt < RESUME_REDIAL_MIN_MS) return;
            if (this._reconnectTimer) {
                // The rung was announced when it was armed; running it early is silent.
                this._clearReconnectTimer();
                this._doReconnect();
                return;
            }
            // Nothing pending: the ladder has been exhausted. The player is looking at
            // the screen, so give them a fresh one.
            this._reconnectAttempts = 0;
            this._reconnectFailedReported = false;
            this._attemptReconnect();
        }

        /**
         * The heartbeat's verdict, evaluated on demand: silence only counts once we
         * have actually sent pings that went unanswered.
         */
        _isChannelDead() {
            if (!this._connected || !this.connection || !this.connection.open) return false;
            const missesAllowed = this.config.heartbeatInterval > 0
                ? Math.max(1, Math.ceil(this.config.heartbeatTimeout / this.config.heartbeatInterval))
                : 1;
            const silentFor = this._lastPongTime ? Date.now() - this._lastPongTime : 0;
            return (this._pingsAwaitingPong || 0) >= missesAllowed &&
                silentFor > this.config.heartbeatTimeout;
        }

        /**
         * Retire the current peer and connection. References are cleared FIRST: real
         * peerjs emits 'close' and 'disconnected' synchronously from inside close() and
         * destroy(), and those handlers must find the objects already retired.
         */
        _destroyPeer() {
            this._stopHeartbeat();
            this._clearConnectTimer();
            const conn = this.connection;
            const peer = this.peer;
            this.connection = null;
            this.peer = null;
            if (conn) {
                try { conn.close(); } catch (e) {}
            }
            if (peer) {
                try { peer.destroy(); } catch (e) {}
            }
        }

        /**
         * Destroy the client and clean up all resources. A connect() still pending is
         * rejected with an error of type 'destroyed'.
         */
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this._connected = false;
            this._connecting = false;

            this._clearReconnectTimer();
            this._clearResumeProbe();
            this._destroyPeer();
            this._messageQueue = [];

            const err = new Error('Client destroyed');
            err.type = 'destroyed';
            this._settleConnect(err);

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
        SEAT_TAKEN_REASON,
        _computeBackoff: computeBackoff,
    };
});
