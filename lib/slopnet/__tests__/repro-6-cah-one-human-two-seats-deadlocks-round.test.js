/**
 * REPRO 6 — "One human, two seats: a second tab permanently deadlocks the round"
 *
 * BUG (projects/cards-against-humanity/index.html:491-507 + :568-575,
 *      identity minted in lib/sloplobby/sloplobby.js:104-111)
 *
 *   getClientId (sloplobby.js:104-108) mints the clientId into **sessionStorage**, which
 *   is per-tab by spec. Open the room link a second time — a second tab, a laptop, an
 *   in-app webview — and joinRoom (sloplobby.js:244) mints a BRAND NEW id. PeerHost keys
 *   join-vs-rejoin purely on that id (slopnet.js:290 `_findClientByClientId`), so the
 *   second tab falls through to the "New client" branch and emits 'client-joined'
 *   (slopnet.js:326-327), NOT 'client-rejoined'. One human, two identities.
 *
 *   CAH's onPlayerJoined then seats it unconditionally:
 *       const player = { id: clientId, name: playerName, score: 0 };
 *       state.players.push(player);                                   // index.html:496
 *       ...
 *       if (state.phase !== 'lobby') { dealHand(10); send('game-start') }   // :502-506
 *   There is no duplicate-name check, no duplicate-human check, and no mid-game rejection.
 *
 *   The submit gate lives *only* inside `case 'submit'` of handleHostMessage:
 *       const needed = state.players.length - 1;                      // index.html:568
 *       const got = Object.keys(state.submissions).length;            // :569
 *       if (got >= needed) startJudging();                            // :573-575
 *   `needed` counts the abandoned seat; `got` never can, because that tab submits nothing.
 *   startJudging has exactly one call site (:574) — no timer, no host override, no
 *   "skip player"/"force judging"/"kick" control exists anywhere in the file. The round
 *   hangs forever and host-reload (which destroys the room and every score) is the exit.
 *
 *   Worse: closing the stray tab does not heal it. onPlayerLeft (:529-540) filters
 *   state.players and deletes the submission, but nothing re-evaluates the gate, and
 *   `if (state.submissions[senderId]) break;` (:560) blocks a resubmit that might.
 *   (This is the same reason any real player who drops after the others have submitted
 *   strands the round — the duplicate tab is just the easiest way for a user to build it.)
 *
 * WHY THE EXISTING 101 TESTS CANNOT SEE IT
 *   No test in this suite loads any app's game logic, so nothing ever asserts a fact about
 *   `state.players`, `needed`, or the czar rotation. multi-client.test.js always allocates a
 *   distinct clientId per distinct *player*, so "one human, two identities" is never
 *   constructed. lib/sloplobby/ — the layer that mints identity — has no tests at all.
 *
 * ON THE MOCK
 *   mock-peer.js is NOT modified and NOT extended. Nothing here is a transport subtlety:
 *   the second tab is a perfectly healthy, fully-open connection. What was missing is a
 *   harness, and this file builds two:
 *     1. `useTab()` — a sessionStorage stub with **one store per simulated browser tab**,
 *        which is the whole point: sessionStorage is per-tab, so tab 2 gets a new clientId.
 *     2. `loadCahApp()` — loads the REAL inline <script> out of
 *        projects/cards-against-humanity/index.html and runs it against a minimal DOM stub,
 *        so the assertions below are about the shipped game logic, not a transcription of it.
 *   SlopNet/SlopLobby are the real classes; only `_PeerClass: MockPeer` is injected
 *   (slopnet.js:173/:625), exactly as repro-2 does.
 *
 * These tests FAIL on purpose. They document the bug; do not relax them to make them pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
const { SlopLobby } = SlopLobbyModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const CAH_HTML = resolve(HERE, '../../../projects/cards-against-humanity/index.html');

/* ── Harness 1: per-tab sessionStorage ────────────────────────────────────
   sessionStorage is scoped to a tab. sloplobby.js:105 `sessionStorage.getItem(storageKey)`
   therefore misses in a freshly-opened tab and :107 mints a new id. `useTab(name)` points
   the stub at that tab's own store; every join below declares which tab it happens in. */

const savedGlobals = {};
const tabStores = new Map();
let currentTab = null;

function useTab(name) {
    if (!tabStores.has(name)) tabStores.set(name, new Map());
    currentTab = tabStores.get(name);
}

/* ── Harness 2: minimal DOM ───────────────────────────────────────────────
   Enough for SlopLobby's $/toast/showScreen (sloplobby.js:39-99) and CAH's render/log
   helpers. getElementById memoises one fake element per id so the app can read back
   values it wrote (e.g. $('player-name').value). */

function makeEl(id) {
    return {
        id: id || '',
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        scrollTop: 0,
        scrollHeight: 0,
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        appendChild() {},
        remove() {},
        addEventListener() {},
        click() {},
        querySelectorAll: () => [],
    };
}

function installBrowserGlobals() {
    for (const key of ['sessionStorage', 'document', 'SlopNet', 'SlopLobby']) {
        savedGlobals[key] = globalThis[key];
    }

    tabStores.clear();
    useTab('host');

    globalThis.sessionStorage = {
        getItem: (k) => (currentTab.has(k) ? currentTab.get(k) : null),
        setItem: (k, v) => { currentTab.set(k, String(v)); },
        removeItem: (k) => { currentTab.delete(k); },
        clear: () => currentTab.clear(),
    };

    const byId = new Map();
    globalThis.document = {
        getElementById(id) {
            if (!byId.has(id)) byId.set(id, makeEl(id));
            return byId.get(id);
        },
        createElement: () => makeEl(),
        querySelectorAll: () => [],
        body: { appendChild() {} },
    };
    globalThis.document._byId = byId;

    // Real SlopNet/SlopLobby; only the Peer transport is injected.
    globalThis.SlopNet = {
        ...SlopNet,
        PeerHost: class extends SlopNet.PeerHost {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
        PeerClient: class extends SlopNet.PeerClient {
            constructor(cfg) { super({ ...cfg, _PeerClass: MockPeer }); }
        },
    };
    globalThis.SlopLobby = SlopLobbyModule;
}

function restoreGlobals() {
    for (const key of ['sessionStorage', 'document', 'SlopNet', 'SlopLobby']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

/**
 * Load the real CAH game script out of index.html.
 * The inline <script> at index.html:416-1082 is a plain top-level script (not an IIFE),
 * so evaluating it as a function body keeps its `const state` / `let lobby` in a closure
 * we can read through getters. Nothing in the app source is edited.
 */
function loadCahApp() {
    const lines = readFileSync(CAH_HTML, 'utf8').split('\n');
    const start = lines.findIndex(l => l.trim() === '<script>');
    const end = lines.findIndex((l, i) => i > start && l.trim() === '</script>');
    if (start < 0 || end < 0) throw new Error('could not locate the CAH inline <script>');
    const src = lines.slice(start + 1, end).join('\n');

    const factory = new Function(`
        ${src}
        ;return {
            get state() { return state; },
            get lobby() { return lobby; },
            createGame, startGame, handleHostMessage,
        };
    `);
    return factory();
}

/** A player's phone/tab: a plain SlopLobby client speaking CAH's wire protocol. */
function makeSeat(tabName, displayName) {
    const seat = {
        tabName,
        name: displayName,
        lobby: null,
        czarId: null,
        hand: [],
        lastSubmitCount: null,
        sawJudging: false,
    };
    seat.lobby = new SlopLobby({
        roomPrefix: 'cah-',
        storageKey: 'cah-client-id',
        onClientData: (data) => {
            // Mirrors handleClientMessage (index.html:761-826) for the parts that matter.
            if (data.type === 'game-start') { seat.hand = data.hand; if (data.czarId) seat.czarId = data.czarId; }
            if (data.type === 'new-round') { seat.hand = data.hand; seat.czarId = data.czarId; }
            if (data.type === 'submit-count') seat.lastSubmitCount = { count: data.count, needed: data.needed };
            if (data.type === 'judging') seat.sawJudging = true;
        },
    });
    return seat;
}

describe('CAH: a second tab seats the same human twice and deadlocks the round', () => {
    let app, seats;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        app = loadCahApp();
        seats = [];
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) {}
        for (const s of seats) { try { s.lobby.destroy(); } catch (e) {} }
        vi.useRealTimers();
        restoreGlobals();
    });

    /** Alice hosts (index.html:475-555, driven through the real createGame). */
    async function hostGame() {
        useTab('host');
        document.getElementById('player-name').value = 'Alice';
        document.getElementById('score-limit').value = '7';
        const p = app.createGame();
        await vi.advanceTimersByTimeAsync(50);
        await p;
        return app.state.gameCode;
    }

    /** One phone taps the link: `tabName` is the browser tab it opens in. */
    async function joinAs(tabName, displayName, code) {
        useTab(tabName);
        const seat = makeSeat(tabName, displayName);
        seats.push(seat);
        const p = seat.lobby.joinRoom(code, displayName);   // index.html:751
        await vi.advanceTimersByTimeAsync(60);
        await p;
        return seat;
    }

    /** Everyone who is not the czar plays their cards (index.html:945-947). */
    async function everyoneNonCzarSubmits() {
        for (const seat of seats) {
            if (seat.abandoned) continue;                        // nobody is looking at that tab
            if (!seat.lobby.client) continue;                    // tab already closed
            if (seat.lobby.clientId === seat.czarId) continue;    // the czar does not submit
            if (seat.submitted) continue;
            seat.submitted = true;
            seat.lobby.sendToHost({ type: 'submit', cards: [seat.hand[0]] });
            await vi.advanceTimersByTimeAsync(30);
        }
        await vi.advanceTimersByTimeAsync(60);
    }

    /**
     * Alice hosts; Bob, Carol and Dan join from their phones; the game starts.
     * Round 1 czar is state.players[0] — Alice, the host.
     */
    async function gameInProgress() {
        const code = await hostGame();
        await joinAs('bob-phone', 'Bob', code);
        await joinAs('carol-phone', 'Carol', code);
        await joinAs('dan-phone', 'Dan', code);

        expect(app.state.players.length).toBe(4);   // precondition: 4 humans, 4 seats
        app.startGame();                            // index.html:610-632
        await vi.advanceTimersByTimeAsync(80);
        expect(app.state.phase).toBe('playing');
        return code;
    }

    /** Bob taps the room link again — a NEW tab, so a fresh sessionStorage. */
    async function bobOpensASecondTab(code) {
        const before = seats[0].lobby.clientId;
        const tab2 = await joinAs('bob-laptop', 'Bob', code);
        expect(
            tab2.lobby.clientId,
            'precondition: the second tab must mint a different clientId (sloplobby.js:105-108)'
        ).not.toBe(before);
        // Bob plays in his phone tab; this one just sits on the game screen.
        tab2.abandoned = true;
        return tab2;
    }

    /**
     * Control (this one PASSES): the harness really does drive a round to judging, so the
     * three failures below are the duplicate seat, not the scaffolding.
     */
    it('control: with one tab per human the round reaches judging', async () => {
        await gameInProgress();
        await everyoneNonCzarSubmits();
        expect(app.state.phase).toBe('judging');
        expect(seats.every(s => s.sawJudging || s.lobby.clientId === s.czarId)).toBe(true);
    });

    it('does not seat the same human twice when they re-open the room link', async () => {
        const code = await gameInProgress();
        await bobOpensASecondTab(code);

        const names = app.state.players.map(p => p.name);
        expect(
            names,
            'index.html:496 pushed a second seat for the same human — onPlayerJoined has no ' +
            'duplicate-name / duplicate-human check and never rejects a mid-game join'
        ).toEqual(['Alice', 'Bob', 'Carol', 'Dan']);
    });

    it('still reaches judging once every real player has submitted', async () => {
        const code = await gameInProgress();
        await bobOpensASecondTab(code);   // this tab is left on the game screen, untouched

        await everyoneNonCzarSubmits();   // Bob (phone), Carol, Dan — Alice is czar

        const needed = app.state.players.length - 1;              // index.html:568
        const got = Object.keys(app.state.submissions).length;    // index.html:569
        expect(
            app.state.phase,
            `round is deadlocked: got=${got} needed=${needed} — index.html:573 can never fire ` +
            'because the abandoned tab is counted in state.players but never submits, and ' +
            'startJudging() has no other call site (no timer, no host override)'
        ).toBe('judging');
    });

    it('recovers when the abandoned tab is closed', async () => {
        const code = await gameInProgress();
        const tab2 = await bobOpensASecondTab(code);

        await everyoneNonCzarSubmits();

        // Bob notices the stray tab and closes it.
        tab2.lobby.destroy();
        await vi.advanceTimersByTimeAsync(200);

        expect(
            app.state.players.length,
            'precondition: onPlayerLeft (index.html:533) removed the abandoned seat'
        ).toBe(4);
        expect(
            app.state.phase,
            'the phantom is gone and every remaining player has submitted, but onPlayerLeft ' +
            '(index.html:529-540) never re-evaluates the gate at :573, and :560 blocks a ' +
            'resubmit that might — the round stays hung, host-reload is the only exit'
        ).toBe('judging');
    });
});
