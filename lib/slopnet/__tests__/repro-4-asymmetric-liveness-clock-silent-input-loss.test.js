/**
 * REPRO 4 — "the two ends keep different liveness clocks, so a phone that merely locked is
 *            declared gone by the host while its own screen stays green — and everything it
 *            sends afterwards is silently discarded"
 *
 * BUG (lib/slopnet/slopnet.js:344-367 + :455-473 + :266-282, and lib/sloplobby/sloplobby.js:185-189)
 *
 * The host and the client each decide the other is gone from a clock that only the *other*
 * end can advance, and the host never tells the client what it decided:
 *
 *   HOST     :466  `if (client._lastPong && (now - client._lastPong) > heartbeatTimeout)`
 *                  → `_handleDisconnect(client.conn)` at :467.
 *            :344-367 `_handleDisconnect` sets `disconnected = true`, emits the TEMPORARY
 *                  `client-left`, arms the 120s reconnect-window timer — and never calls
 *                  `conn.close()`. Nothing at all goes out on the wire.
 *   CLIENT   `_lastPongTime` is written in exactly two places: :732 (join_ack) and :757 (an
 *                  inbound `__slopnet_pong`). Ordinary inbound game data at :762 only emits.
 *                  A pong only ever arrives in reply to a ping the client sends from its OWN
 *                  `setInterval` at :831-843. A tab whose timers are frozen therefore cannot
 *                  observe anything, in either direction.
 *
 * So "host says gone / client says connected / DataChannel still open" is a reachable steady
 * state, produced by the single most ordinary thing that happens at a games table: a phone
 * put down on the table and auto-locking (iOS minimum 30s), or a flip to another app while
 * somebody else takes their turn.
 *
 * What makes it *lose input* rather than merely look untidy is sloplobby.js:185-189, which
 * treats that temporary event as permanent:
 *
 *   host.on('client-left', (clientId) => {
 *       const meta = this.players.get(clientId);
 *       this.players.delete(clientId);          // :187  identity destroyed at t+15s
 *       this._onPlayerLeft(clientId, meta);
 *   });
 *
 * sloplobby subscribes to no `client-lost` at all (its only host listeners are :165, :177,
 * :185, :191, :195), so slopnet holding the slot open for another 120 seconds buys nothing.
 * Both consumers resolve senders exclusively through that map:
 *   herd-mentality/index.html:741-744 `nameForClientId` → `lobby.players.get(clientId)` →
 *     undefined → null, and :972-978 `if (name && !answers[name])` drops the answer with no
 *     reply, no toast and no log, while the player's own :1505-1506 has already switched them
 *     to 'player-waiting-screen'.
 *   texas-holdem/index.html:1327-1331 `const entry = lobby.players.get(clientId); if (entry)`
 *     is the identical shape, so a fold/call/raise is discarded with chips on the table.
 * Meanwhile herd:940-951 adds the player to `disconnectedPlayers` and, in the `answering`
 * phase, calls `checkAllAnswered()` → :1016-1022 recomputes `activePlayers` without them, so
 * the host's screen jumps to merging while their phone still shows the question.
 *
 * Two further silent losses share the root cause and are covered below:
 *   (a) host→client: `send` :374-377 returns false and `broadcast` :394 skips a client inside
 *       the reconnect window WITHOUT queueing, so state pushed during the freeze is gone for
 *       good — unlike the client→host direction, which does queue at :793.
 *   (b) the recovery is invisible: an inbound pong at :276-279 clears `disconnected` with no
 *       event emitted, so slopnet silently believes the player is back while sloplobby's
 *       `players` map stays empty forever. Nothing can reconcile the two.
 *
 * WHY THE EXISTING 101 TESTS CANNOT SEE IT
 *   All six suites build their peers with `heartbeatInterval: 0` (host-client.test.js:15,
 *   multi-client.test.js:15, peer-client.test.js:10 and :20, peer-host.test.js:10,
 *   reconnection.test.js:15), so `_startHeartbeat` returns at :457/:831 and a heartbeat-driven
 *   `client-left` occurs in 0 of 101 tests. Every disconnect in the suite is instead an
 *   explicit, SYMMETRIC `connection.close()` / `destroy()`, and mock-peer.js:138-152 closes
 *   both ends together — so the asymmetric state this bug lives in is unrepresentable there.
 *   And sloplobby.js has no tests whatsoever.
 *
 * ON THE MOCK — mock-peer.js is UNCHANGED and needed no changes.
 *   The transport is not what is missing; the missing thing is a page whose JavaScript stops.
 *   `freezePage()` below is a small LOCAL helper that models exactly that, and nothing more:
 *   while a page is frozen its timers do not fire and its message events are not dispatched,
 *   and on resume the buffered messages are delivered and the overdue timer fires. It buffers
 *   emits on the client's own MockDataConnection and stops the client's heartbeat timer. The
 *   host, the wire, the mock and `Date.now()` are all untouched — the DataChannel stays open
 *   throughout, which is the whole point: this is a frozen tab, not a dropped link. The first
 *   test drives the same helper for a freeze SHORTER than heartbeatTimeout and passes, proving
 *   the harness is not what causes the loss.
 *
 * The sloplobby harness (`installBrowserGlobals` / `installSlopNetGlobal`) follows
 * repro-2-sloplobby-clobbers-app-player-record.test.js: sloplobby.js is a UMD IIFE that reads
 * a global `SlopNet` plus `sessionStorage`/`document`, and it constructs its peers with
 * `{ roomPrefix }` alone (sloplobby.js:162, :246) — so the PRODUCTION defaults are live here:
 * heartbeatInterval 5000, heartbeatTimeout 15000, reconnectWindowMs 120000 (:102-106).
 *
 * The host app callbacks are transcriptions of herd-mentality/index.html:741-744, :935-951,
 * :971-978 and :1016-1022.
 *
 * These tests FAIL on purpose. They document the bug; do not relax them to make them pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const { DEFAULT_CONFIG } = SlopNet;
const { SlopLobby } = require('../../sloplobby/sloplobby.js');

const HEARTBEAT = DEFAULT_CONFIG.heartbeatInterval;   // 5000
const TIMEOUT = DEFAULT_CONFIG.heartbeatTimeout;      // 15000

/* ── sloplobby harness (see repro-2) ──────────────────────────────────── */

const savedGlobals = {};

function installBrowserGlobals() {
    const store = new Map();
    savedGlobals.sessionStorage = globalThis.sessionStorage;
    savedGlobals.document = globalThis.document;

    globalThis.sessionStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => { store.delete(k); },
        clear: () => store.clear(),
    };

    const makeEl = () => ({
        style: {}, className: '', textContent: '',
        classList: { add() {}, remove() {} },
        appendChild() {}, remove() {},
    });
    globalThis.document = {
        getElementById: () => null,          // forces toast()'s pattern-3 fallback
        createElement: makeEl,
        querySelectorAll: () => [],
        body: { appendChild() {} },
    };
}

/** Global `SlopNet` with the real classes; only the Peer transport is injected. */
function installSlopNetGlobal() {
    savedGlobals.SlopNet = globalThis.SlopNet;
    globalThis.SlopNet = {
        ...SlopNet,
        PeerHost: class extends SlopNet.PeerHost {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
        PeerClient: class extends SlopNet.PeerClient {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
    };
}

function restoreGlobals() {
    for (const key of ['sessionStorage', 'document', 'SlopNet']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

/* ── The one capability the existing harness lacks: a page that stops running ──
 *
 * A locked / backgrounded phone does not drop its DataChannel; it stops executing
 * JavaScript. No timer callback fires and no message event is dispatched. On resume the
 * buffered messages are delivered and the overdue timer fires once. That is all this models.
 * The MockDataConnection itself stays open in both directions the entire time — no mock
 * behaviour is changed, and mock-peer.js is not modified.
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

/* ── herd-mentality host, transcribed ─────────────────────────────────── */

function makeHerdHost(app) {
    return new SlopLobby({
        roomPrefix: 'herd-',
        storageKey: 'herd-host-id',

        // herd-mentality/index.html:971-978, via :741-744
        onHostData: (clientId, data) => {
            if (data.type !== 'answer') return;
            const entry = app.lobby.players.get(clientId);        // herd:742
            const name = entry ? entry.name : null;               // herd:743
            if (name && !app.answers[name]) {                     // herd:973
                app.answers[name] = data.answer;
                app.checkAllAnswered();
            }
        },

        onPlayerJoined: (clientId, metadata) => {
            app.players.push(metadata.name);
        },

        // herd-mentality/index.html:935-951
        onPlayerLeft: (clientId, meta) => {
            const name = meta ? meta.name : null;
            app.playerLeftEvents.push(name);
            if (!name) return;
            if (app.gamePhase === 'lobby') {
                app.players = app.players.filter(p => p !== name);
            } else {
                app.disconnectedPlayers.add(name);
                if (app.gamePhase === 'answering') app.checkAllAnswered();
            }
        },
    });
}

function makeApp() {
    const app = {
        lobby: null,
        players: ['Alice'],                 // Alice is the host, and plays
        answers: {},
        disconnectedPlayers: new Set(),
        gamePhase: 'lobby',
        playerLeftEvents: [],
        mergeScreenShown: false,
        // herd-mentality/index.html:1016-1022
        checkAllAnswered() {
            const activePlayers = app.players.filter(p => !app.disconnectedPlayers.has(p));
            const answeredCount = activePlayers.filter(p => app.answers[p]).length;
            if (answeredCount >= activePlayers.length) app.mergeScreenShown = true;
        },
    };
    return app;
}

describe('REPRO: asymmetric liveness clock silently voids a backgrounded player\'s input', () => {
    let app, hostLobby, clientLobby, libraryInbound, clientReceived;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        installSlopNetGlobal();

        app = makeApp();
        hostLobby = makeHerdHost(app);
        app.lobby = hostLobby;

        libraryInbound = [];
        clientReceived = [];

        clientLobby = new SlopLobby({
            roomPrefix: 'herd-',
            storageKey: 'herd-client-id',
            onClientData: (data) => clientReceived.push(data),
        });
    });

    afterEach(() => {
        try { hostLobby && hostLobby.destroy(); } catch (e) {}
        try { clientLobby && clientLobby.destroy(); } catch (e) {}
        vi.useRealTimers();
        restoreGlobals();
    });

    /**
     * Alice hosts, Bob joins, a round is in the `answering` phase and Alice has answered.
     * Returns Bob's clientId.
     */
    async function setUpRound() {
        const created = hostLobby.createRoom('Alice');
        await vi.advanceTimersByTimeAsync(20);
        const code = await created;

        // Record what the LIBRARY resolved, independently of what the app did with it.
        hostLobby.host.on('data', (clientId, data) => libraryInbound.push({ clientId, data }));

        const joined = clientLobby.joinRoom(code, 'Bob');
        await vi.advanceTimersByTimeAsync(50);
        await joined;

        // A healthy minute of play: pings and pongs both ways.
        await vi.advanceTimersByTimeAsync(60000);
        expect(hostLobby.getConnectedClientIds()).toEqual([clientLobby.clientId]);

        app.gamePhase = 'answering';
        app.answers['Alice'] = 'cow';        // the host answers on her own device
        app.checkAllAnswered();
        expect(app.mergeScreenShown).toBe(false);

        return clientLobby.clientId;
    }

    /** Bob puts the phone down; the screen locks for `ms`; he picks it back up. */
    async function phoneLocked(ms) {
        const frozen = freezePage(clientLobby.client);
        await vi.advanceTimersByTimeAsync(ms);

        // Unlock. The page runs again, and the browser delivers what it buffered.
        frozen.wake();
        frozen.deliverBufferedMessages();
        await vi.advanceTimersByTimeAsync(20);
        frozen.resumeTimers();
        await vi.advanceTimersByTimeAsync(20);
        return frozen;
    }

    it('SANITY: a lock shorter than heartbeatTimeout loses nothing', async () => {
        await setUpRound();

        await phoneLocked(TIMEOUT - HEARTBEAT);      // 10s — inside the tolerance

        expect(app.playerLeftEvents).toEqual([]);
        expect(clientLobby.client.isConnected).toBe(true);

        clientLobby.sendToHost({ type: 'answer', answer: 'sheep' });   // herd:1505
        await vi.advanceTimersByTimeAsync(50);

        expect(app.answers).toEqual({ Alice: 'cow', Bob: 'sheep' });
    });

    it('keeps a backgrounded player\'s answer when their phone comes back', async () => {
        await setUpRound();

        const frozen = await phoneLocked(30000);     // iOS auto-lock minimum

        // Preconditions — the state the existing suite cannot represent.
        expect(app.playerLeftEvents, 'the host did not time Bob out; the freeze model is wrong')
            .toEqual(['Bob']);
        expect(clientLobby.client.isConnected, 'Bob\'s phone was never told anything').toBe(true);
        expect(clientLobby.client.connection.open, 'the DataChannel was never closed').toBe(true);
        expect(frozen.bufferedCount).toBe(0);

        // Bob taps Submit on the answer he had already typed (herd:1503-1506). His UI switches
        // straight to 'player-waiting-screen' — herd does not wait for any acknowledgement.
        // This is the instant after unlock, before his own overdue heartbeat tick has run; that
        // tick is up to heartbeatInterval (5s) away, and until it runs `_connected` is true, so
        // send() at :785-795 puts the message straight down the still-open channel instead of
        // queueing it. A pre-composed answer, or a poker fold, lands inside those 5 seconds
        // easily. (After the tick fires the client reconnects and later messages are safe — the
        // loss is bounded to this window, but the window is on every resume.)
        clientLobby.sendToHost({ type: 'answer', answer: 'sheep' });
        await vi.advanceTimersByTimeAsync(50);

        expect(
            app.answers,
            `Bob's answer was delivered to the host and then silently thrown away by the app. ` +
            `The library itself resolved it correctly — host 'data' fired as ` +
            `${JSON.stringify(libraryInbound)} — but sloplobby.js:187 had already run ` +
            `\`this.players.delete(clientId)\` on the TEMPORARY 'client-left' that slopnet.js:350 ` +
            `emitted from the heartbeat timeout at :466-467, 15s into a screen lock that never ` +
            `touched the DataChannel. So herd:742 \`lobby.players.get(clientId)\` is undefined, ` +
            `:743 returns null, and the guard at :973 \`if (name && !answers[name])\` drops the ` +
            `message with no error to either side. Bob's own screen says "submitted". ` +
            `lobby.players now holds [${[...hostLobby.players.keys()].join(', ')}], while ` +
            `slopnet still holds the slot: host.getConnectedClientIds()=` +
            `[${hostLobby.getConnectedClientIds().join(', ')}], client.isConnected=` +
            `${clientLobby.client.isConnected}, connection.open=${clientLobby.client.connection.open}.`
        ).toEqual({ Alice: 'cow', Bob: 'sheep' });
    });

    it('does not advance the round past a player whose phone merely locked', async () => {
        await setUpRound();

        await phoneLocked(30000);

        expect(
            app.mergeScreenShown,
            `The host advanced the round while Bob's phone was still showing the question and his ` +
            `DataChannel was still open (client.isConnected=${clientLobby.client.isConnected}). ` +
            `slopnet.js:466-467 timed him out on a clock only his own frozen timers could advance ` +
            `(_lastPongTime is written only at :732 and :757, and a pong only answers a ping his own ` +
            `setInterval at :842 sends), sloplobby.js:186-188 forwarded that temporary event as ` +
            `onPlayerLeft, and herd:944-948 then added him to disconnectedPlayers and re-ran ` +
            `checkAllAnswered, whose :1017 activePlayers no longer contains him — so 1 answer of 1 ` +
            `"active" player satisfied the round. Nothing was ever sent to Bob to tell him.`
        ).toBe(false);
    });

    it('does not silently drop host state pushed while the player is inside the reconnect window', async () => {
        await setUpRound();

        const frozen = freezePage(clientLobby.client);
        await vi.advanceTimersByTimeAsync(20000);            // host times Bob out at +15s
        expect(app.playerLeftEvents).toEqual(['Bob']);

        // Alice's game moves on and the host pushes the new state, as every app does after any
        // state change. Nothing throws. The client is inside its 120s reconnect window.
        hostLobby.broadcast({ type: 'state', round: 2 });
        await vi.advanceTimersByTimeAsync(50);

        // Bob picks the phone up; everything the browser buffered is delivered, timers resume,
        // and the link runs normally for another half minute.
        frozen.wake();
        frozen.deliverBufferedMessages();
        await vi.advanceTimersByTimeAsync(20);
        frozen.resumeTimers();
        await vi.advanceTimersByTimeAsync(30000);

        expect(
            clientReceived.filter(m => m.type === 'state'),
            `The host's state push vanished. slopnet.js:394 (broadcast) and :374-377 (send) skip a ` +
            `client whose \`disconnected\` flag is set and — unlike the client→host direction, which ` +
            `queues at :793 — do NOT queue it, so there is nothing left to flush when the player ` +
            `comes back. Bob's phone is now showing round 1 forever with a live, open DataChannel ` +
            `(client.isConnected=${clientLobby.client.isConnected}, ` +
            `connection.open=${clientLobby.client.connection.open}) and received ` +
            `${JSON.stringify(clientReceived)}.`
        ).toEqual([{ type: 'state', round: 2 }]);
    });

    it('re-registers the player when slopnet decides it is talking to them again', async () => {
        const clientId = await setUpRound();

        // Freeze, then the unlock instant only: the page runs again and the browser hands it
        // the pings it buffered, which Bob's client answers with pongs. Bob's own overdue
        // heartbeat tick has NOT fired yet — that is up to heartbeatInterval (5s) away, and it
        // is the exposed window in which every tap is lost (the previous tests).
        const frozen = freezePage(clientLobby.client);
        await vi.advanceTimersByTimeAsync(30000);
        frozen.wake();
        frozen.deliverBufferedMessages();
        await vi.advanceTimersByTimeAsync(20);

        expect(
            { lobbyKnowsPlayer: hostLobby.players.has(clientId), libraryConnected: hostLobby.getConnectedClientIds() },
            `slopnet and sloplobby disagree about the same peer, and no event exists that could ` +
            `reconcile them. The pings Bob answered on unlock reached the host and ` +
            `slopnet.js:276-279 cleared \`client.disconnected\` — but silently: no 'client-rejoined', ` +
            `no 'client-recovered', nothing. So the library is back to reporting him connected ` +
            `while sloplobby's players map, emptied at :187, is never refilled: :177-183 only ` +
            `refills it from 'client-rejoined', which fires solely from a __slopnet_join ` +
            `(slopnet.js:285-311), and sloplobby subscribes to no 'client-lost' at all. This is ` +
            `exactly the state in which the answer in the test above is delivered and discarded. ` +
            `It is only repaired ~heartbeatInterval later, when Bob's own overdue tick finally ` +
            `runs, finds _lastPongTime stale, tears the peer down and rebuilds it — which is a ` +
            `full reconnect nobody needed. client.isConnected=${clientLobby.client.isConnected}, ` +
            `connection.open=${clientLobby.client.connection.open}.`
        ).toEqual({ lobbyKnowsPlayer: true, libraryConnected: [clientId] });
    });
});
