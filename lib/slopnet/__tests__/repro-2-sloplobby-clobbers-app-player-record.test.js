/**
 * REPRO 2 — "SlopLobby clobbers the app's per-client record, and the rejoin path
 *            can never rebuild it"
 *
 * BUG (lib/sloplobby/sloplobby.js:165-175, :177-183, :185-189)
 *
 *   host.on('client-joined', (clientId, metadata) => {
 *       const result = this._onPlayerJoined(clientId, metadata);   // :166  app runs FIRST
 *       ...
 *       const name = (metadata && metadata.name) || 'Unknown';     // :173
 *       this.players.set(clientId, { name, ...metadata });         // :174  full REPLACE
 *   });
 *
 * The app callback is invoked before the library registers the player, and :174 is a fresh
 * object literal — not a merge — so anything the app attached to `lobby.players` inside its
 * own callback is destroyed one statement later, in the same synchronous tick
 * (slopnet.js:62-68 `emit` is a direct call; slopnet.js:327 emits from inside `_handleData`).
 *
 * texas-holdem/index.html:1348 is the ONLY place that ever writes the seat binding:
 *     lobby.players.set(clientId, { name: playerName, playerId });
 * and the client joins with `lobby.joinRoom(roomCode, myName)` (texas-holdem:1448) — no
 * `extra` — so the wire metadata is exactly `{ name }` (sloplobby.js:273). `{ name, ...metadata }`
 * therefore erases `playerId` on every single join, with no network fault involved.
 *
 * Downstream, in the app the library is supposed to serve:
 *   - texas-holdem:1327-1330 `game.handleAction(entry.playerId /* undefined *​/, ...)` →
 *     handleAction's findIndex returns -1 (:958) → every remote fold/call/raise is dropped.
 *   - broadcastState :1394-1395 `getStateForPlayer(undefined)` → the client is dealt
 *     ['back','back'] for its OWN hole cards and `myId: undefined`, so renderGame's `me`
 *     is undefined and the Fold/Call/Raise controls are never built.
 *   - onPlayerLeft :1371 `game.setDisconnected(undefined, true)` is a no-op, and there is no
 *     turn clock in the file, so the table hangs on the first remote player's turn.
 *
 * The rejoin path cannot repair it either: 'client-left' DELETES the record on the
 * *temporary* disconnect (sloplobby.js:185-189, fired by slopnet.js:351 on conn close, long
 * before the reconnect window expires at :359/:365), and 'client-rejoined' rebuilds it from
 * wire metadata only (sloplobby.js:177-183) — `{ name }` again.
 *
 * WHY THE EXISTING 101 TESTS CANNOT SEE IT
 * `lib/sloplobby/` contains only sloplobby.js — no __tests__, and no test in this suite
 * imports it. The 101 tests drive PeerHost/PeerClient directly with `vi.fn()` spies and
 * push-to-array listeners, so "the library overwrites what my callback wrote" is out of
 * scope by construction: peer-host.test.js asserts on emitted events and
 * getConnectedClientIds(), never on the `players` Map that only SlopLobby owns.
 *
 * ON THE MOCK
 * mock-peer.js is NOT modified — it is adequate here, because this bug is pure
 * same-tick bookkeeping, not a transport subtlety. What was missing is a harness for
 * sloplobby.js, which is a UMD IIFE that reads a *global* `SlopNet` and browser globals.
 * `installBrowserGlobals()` + `installSlopNetGlobal()` below are that harness: minimal
 * `sessionStorage`/`document` stubs (sloplobby.js:104-111 getClientId, :54-88 toast) and a
 * global `SlopNet` whose PeerHost/PeerClient are the REAL classes with only `_PeerClass:
 * MockPeer` injected — every other config value is the production default, exactly as
 * sloplobby.js:162/:246 construct them with `{ roomPrefix }` alone.
 *
 * The app callbacks below are transcriptions of texas-holdem/index.html:1327-1380.
 *
 * These tests FAIL on purpose. They document the bug; do not relax them to make them pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
const { SlopLobby } = SlopLobbyModule;

/* ── Harness ──────────────────────────────────────────────────────────────
   sloplobby.js is `(function (root) { ... })(globalThis)` with a UMD tail, so
   `require` gives us its exports directly; what it does NOT bring is the ambient
   browser/SlopNet environment it expects at call time. We supply it here. */

const savedGlobals = {};

/** Minimal sessionStorage (sloplobby.js:104-111) and document (sloplobby.js:54-99). */
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

const SEAT_ID = 'p-seat-1';

/**
 * Host lobby wired exactly like texas-holdem/index.html:1322-1380.
 * `log` records what the app saw, so we can prove the write happened and was undone.
 */
function makeHostLobby(log) {
    return new SlopLobby({
        roomPrefix: 'slop-holdem-',
        storageKey: 'holdem-client-id',
        onHostData: (clientId, data) => {
            if (data.type === 'action') {
                const entry = log.hostLobby.players.get(clientId);           // texas-holdem:1328
                if (entry) log.actionsResolvedTo.push(entry.playerId);       // :1330
            }
        },
        onPlayerJoined: (clientId, metadata) => {
            // texas-holdem:1341-1348 — mint the seat and bind it to the clientId.
            const playerName = metadata.name || 'Player';
            log.hostLobby.players.set(clientId, { name: playerName, playerId: SEAT_ID });
            log.insideOnPlayerJoined = { ...log.hostLobby.players.get(clientId) };
            // falls off the end returning undefined — the accept path (sloplobby.js:167)
        },
        onPlayerRejoined: (clientId) => {
            const entry = log.hostLobby.players.get(clientId);               // texas-holdem:1356
            log.insideOnPlayerRejoined = entry ? { ...entry } : entry;
        },
        onPlayerLeft: (clientId, meta) => {
            log.insideOnPlayerLeft = meta ? { ...meta } : meta;              // texas-holdem:1369-1371
        },
    });
}

describe('SlopLobby player record (repro: library clobbers the app\'s write)', () => {
    let hostLobby, clientLobby, log;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        installSlopNetGlobal();
        log = { actionsResolvedTo: [], insideOnPlayerJoined: null, insideOnPlayerRejoined: null, insideOnPlayerLeft: null };
        hostLobby = makeHostLobby(log);
        log.hostLobby = hostLobby;
        clientLobby = new SlopLobby({ roomPrefix: 'slop-holdem-', storageKey: 'holdem-client-id' });
    });

    afterEach(() => {
        try { hostLobby && hostLobby.destroy(); } catch (e) {}
        try { clientLobby && clientLobby.destroy(); } catch (e) {}
        vi.useRealTimers();
        restoreGlobals();
    });

    /** Host up, one client joined, everything settled. Returns the client's clientId. */
    async function joinOneClient() {
        const created = hostLobby.createRoom('Alice');   // sloplobby.js:199 generates the code
        await vi.advanceTimersByTimeAsync(20);
        const code = await created;

        const joined = clientLobby.joinRoom(code, 'Bob');   // texas-holdem:1448 — no `extra`
        await vi.advanceTimersByTimeAsync(50);
        await joined;

        return clientLobby.clientId;
    }

    it('keeps the playerId the app attached in onPlayerJoined', async () => {
        const clientId = await joinOneClient();

        // The app's write really happened, in its own callback:
        expect(log.insideOnPlayerJoined).toEqual({ name: 'Bob', playerId: SEAT_ID });

        // ...and must still be there once the join settles. sloplobby.js:174 replaces it.
        expect(
            hostLobby.players.get(clientId),
            'sloplobby.js:174 replaced the app record written at texas-holdem:1348 with { name, ...metadata }'
        ).toEqual({ name: 'Bob', playerId: SEAT_ID });
    });

    it('resolves an inbound action to the seat the app bound to that client', async () => {
        await joinOneClient();

        clientLobby.sendToHost({ type: 'action', action: 'call' });   // texas-holdem:1463
        await vi.advanceTimersByTimeAsync(20);

        // texas-holdem:1330 passes entry.playerId to game.handleAction; undefined makes
        // handleAction's findIndex return -1 (:958) and the action is silently discarded.
        expect(
            log.actionsResolvedTo,
            'the host resolved the remote action to an undefined playerId, so it is dropped at texas-holdem:958-959'
        ).toEqual([SEAT_ID]);
    });

    /**
     * Phone loses the connection. slopnet.js:351 emits 'client-left' immediately — this is
     * the TEMPORARY event, fired on conn close, 120 seconds before the reconnect window
     * expires and 'client-lost' (slopnet.js:359/:365) says the slot is really gone.
     */
    async function dropConnection() {
        clientLobby.client.peer.simulateConnectionDrop();
        await vi.advanceTimersByTimeAsync(50);
    }

    it('keeps the player record while slopnet is still holding the slot open', async () => {
        const clientId = await joinOneClient();
        await dropConnection();

        expect(log.insideOnPlayerLeft, 'onPlayerLeft never fired — the drop was not delivered').toBeTruthy();
        expect(
            hostLobby.host.clients.size,
            'precondition: slopnet still holds the client slot for the whole reconnect window'
        ).toBe(1);
        expect(
            hostLobby.players.has(clientId),
            'sloplobby.js:187 deleted the player on the TEMPORARY client-left, while slopnet still holds the slot open'
        ).toBe(true);
    });

    it('still knows the seat after a real drop-and-reconnect', async () => {
        const clientId = await joinOneClient();
        await dropConnection();

        await vi.advanceTimersByTimeAsync(3000);   // client's first backoff step is 1000ms

        expect(log.insideOnPlayerRejoined, 'onPlayerRejoined never fired — the client did not reconnect').toBeTruthy();
        expect(
            hostLobby.players.get(clientId),
            'sloplobby.js:179-181 rebuilt the record from wire metadata ({ name }), so the seat binding is gone for good'
        ).toEqual({ name: 'Bob', playerId: SEAT_ID });
    });
});
