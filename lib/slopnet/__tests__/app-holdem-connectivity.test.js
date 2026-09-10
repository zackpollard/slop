/**
 * texas-holdem — connectivity regressions.
 *
 * Everything here is driven through the SHIPPED projects/texas-holdem/index.html: the
 * whole inline <script> is evaluated as a function body against a small DOM, so the
 * real SlopLobby callbacks, the real screen switching and the real button handlers run.
 * Unlike app-holdem.test.js, each app instance gets its OWN document (keyed by tab, the
 * same way sessionStorage is), so a host tab and a player tab can be on screen at the
 * same time without painting over one another.
 *
 * Covers, in order:
 *   - the single `lobby` global: Create Table and Join Table lock each other out, and a
 *     losing attempt can neither drive nor destroy the table that won;
 *   - the seat-code list shows the seats that can still be reclaimed;
 *   - a rejoin the host never saw as away is still told which seat it holds;
 *   - a host tab that restarts under the same room code puts its returning players in
 *     the new waiting room instead of on the old, now-blank, board;
 *   - the reconnect toast is throttled against a counter that actually counts;
 *   - Leave Table outlives the library's close grace and forgets the room code;
 *   - the host is not told a signalling outage is over that it was never told about;
 *   - a terminal state is announced once, not twice;
 *   - chip amounts off the wire are escaped like every other string in that panel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { MockPeer, resetRegistry } from './mock-peer.js';

const require = createRequire(import.meta.url);
const SlopNet = require('../slopnet.js');
const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
const { SlopLobby } = SlopLobbyModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const HOLDEM_HTML = resolve(HERE, '../../../projects/texas-holdem/index.html');

const HOLDEM_SRC = (() => {
    const lines = readFileSync(HOLDEM_HTML, 'utf8').split('\n');
    const start = lines.findIndex((l) => l.trim() === '<script>');
    const end = lines.findIndex((l, i) => i > start && l.trim() === '</script>');
    if (start < 0 || end < 0) throw new Error('could not locate the holdem inline <script>');
    return lines.slice(start + 1, end).join('\n');
})();

const ROOM_CODE_KEY = 'holdem-client-id-room-code';
const SCREENS = ['lobby', 'waiting-room', 'game'];

/* ── A browser, one per tab ───────────────────────────────────────────────── */

const savedGlobals = {};
let tabs;              // tab name -> Map, that tab's sessionStorage
let currentTab = null;
let appDocs;           // tab name -> the document that tab's app instance was given
let toastLog = [];
let createdEls = [];
let reloads = [];

function makeEl(id) {
    const classes = new Set();
    const listeners = new Map();
    const el = {
        id: id || '',
        value: '',
        textContent: '',
        innerHTML: '',
        outerHTML: '',
        disabled: false,
        style: {},
        dataset: {},
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)),
            contains: (c) => classes.has(c),
        },
        appendChild() {},
        remove() {},
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        // Faithful to the browser: a disabled control fires no click event, not even
        // for an explicit .click(). That is what makes "disable both buttons" a real
        // lock rather than a hint.
        click() {
            if (el.disabled) return;
            for (const fn of listeners.get('click') || []) fn({});
        },
        querySelectorAll: () => [],
    };
    return el;
}

/**
 * One document per app instance, handed to it as a parameter rather than through the
 * global — an app's callbacks fire while any tab is current, so a shared global
 * `document` has a host tab painting its screens into a player's page.
 */
function makeDocument(toastContainer) {
    const bySelector = new Map();
    const screens = SCREENS.map((id) => {
        const el = makeEl(id);
        bySelector.set('#' + id, el);
        return el;
    });
    return {
        _bySelector: bySelector,
        getElementById(id) {
            if (id === 'toast') return null;          // force the #toasts container path
            if (id === 'toasts') return toastContainer;
            return null;
        },
        querySelector(sel) {
            if (!bySelector.has(sel)) bySelector.set(sel, makeEl(sel.replace('#', '')));
            return bySelector.get(sel);
        },
        querySelectorAll: (sel) => (sel === '.screen' ? screens.slice() : []),
        createElement: (tag) => { const el = makeEl(); el.tagName = tag; createdEls.push(el); return el; },
        addEventListener() {},
        removeEventListener() {},
        body: { appendChild() {} },
        visibilityState: 'visible',
    };
}

/** Switch to a tab: its sessionStorage becomes the live one. */
function useTab(name) {
    if (!tabs.has(name)) tabs.set(name, new Map());
    currentTab = tabs.get(name);
}

function docOf(name) { return appDocs.get(name); }
const elIn = (tab, sel) => docOf(tab).querySelector(sel);
const activeScreen = (tab) => SCREENS.find((id) => elIn(tab, '#' + id).classList.contains('active')) || null;

function installBrowserGlobals() {
    for (const key of ['sessionStorage', 'localStorage', 'document', 'window', 'location', 'SlopNet', 'SlopLobby']) {
        savedGlobals[key] = globalThis[key];
    }
    tabs = new Map();
    appDocs = new Map();
    toastLog = [];
    createdEls = [];
    reloads = [];

    const toastContainer = makeEl('toasts');
    toastContainer.appendChild = (el) => { toastLog.push(el.textContent); };
    globalThis.__toastContainer = toastContainer;
    // The library's own helpers (SlopLobby.toast) read the global document. Nothing
    // that matters to a screen assertion lives here.
    globalThis.document = makeDocument(toastContainer);

    globalThis.sessionStorage = {
        getItem: (k) => (currentTab.has(k) ? currentTab.get(k) : null),
        setItem: (k, v) => { currentTab.set(k, String(v)); },
        removeItem: (k) => { currentTab.delete(k); },
        clear: () => currentTab.clear(),
    };
    const local = new Map();
    globalThis.localStorage = {
        getItem: (k) => (local.has(k) ? local.get(k) : null),
        setItem: (k, v) => { local.set(k, String(v)); },
        removeItem: (k) => { local.delete(k); },
    };
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.location = {
        reload() { reloads.push({ roomCode: globalThis.sessionStorage.getItem(ROOM_CODE_KEY) }); },
    };

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

    useTab('host');
}

function restoreGlobals() {
    for (const key of ['sessionStorage', 'localStorage', 'document', 'window', 'location', 'SlopNet', 'SlopLobby']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
    delete globalThis.__toastContainer;
}

/** Load the shipped page into a tab, with a document of its own. */
function loadHoldemApp(tabName) {
    useTab(tabName);
    const doc = makeDocument(globalThis.__toastContainer);
    appDocs.set(tabName, doc);
    const factory = new Function('document', `
        ${HOLDEM_SRC}
        ;return {
            get game() { return game; },
            get lobby() { return lobby; },
            get lastGameState() { return lastGameState; },
            get myPlayerId() { return myPlayerId; },
            get terminalState() { return terminalState; },
            get isHost() { return isHost; },
            get roomCode() { return roomCode; },
            hostGame, joinGame, leaveTable, renderGame, renderSeatCodes, PHASE,
        };
    `);
    return factory(doc);
}

const advance = (ms) => vi.advanceTimersByTimeAsync(ms);

/** A player's phone that is NOT the app: a plain SlopLobby speaking the wire protocol. */
function makeSeat(tabName, displayName) {
    useTab(tabName);
    const s = { name: displayName, messages: [], states: [], stateEvents: [], lobby: null };
    s.lobby = new SlopLobby({
        roomPrefix: 'slop-holdem-',
        storageKey: 'holdem-client-id',
        onClientData: (data) => {
            s.messages.push(data);
            if (data.type === 'state') s.states.push(data.state);
            if (data.type === 'join-error') s.refusal = data.reason;
        },
        onStateChange: (status, detail) => { s.stateEvents.push({ status, detail }); },
    });
    return s;
}

/** A table that is NOT the app: a plain SlopLobby host, so the app under test is a client. */
function makeRemoteHost(tabName) {
    useTab(tabName);
    const h = { lobby: null, joined: [], received: [] };
    h.lobby = new SlopLobby({
        roomPrefix: 'slop-holdem-',
        storageKey: 'holdem-client-id',
        onPlayerJoined: (clientId, metadata) => { h.joined.push({ clientId, metadata }); },
        onHostData: (clientId, data) => { h.received.push({ clientId, data }); },
    });
    h.open = async (name) => {
        const p = h.lobby.createRoom(name);
        await advance(80);
        return p;
    };
    return h;
}

/* ── The single `lobby` global ────────────────────────────────────────────── */

describe('texas-holdem: one table at a time', () => {
    let app;
    let extras;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        extras = [];
        app = loadHoldemApp('player');
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) { /* ignore */ }
        for (const x of extras) { try { x.lobby.destroy(); } catch (e) { /* ignore */ } }
        vi.clearAllTimers();
        vi.useRealTimers();
        restoreGlobals();
    });

    it('locks Create Table and Join Table against each other while either is dialling', async () => {
        // Both buttons live on the same screen for the whole of an attempt — a join can
        // sit unresolved for ten seconds — and both write the same `lobby` global.
        const doc = docOf('player');
        doc.querySelector('#join-name').value = 'Bob';
        doc.querySelector('#room-code').value = 'NOSUCH';

        doc.querySelector('#btn-join').click();
        expect(doc.querySelector('#btn-join').disabled, 'the tapped button goes down').toBe(true);
        expect(
            doc.querySelector('#btn-create').disabled,
            'and so does the other one: it would take the table over underneath this attempt'
        ).toBe(true);

        await advance(15000);
        expect(doc.querySelector('#btn-join').disabled, 'both come back when the attempt fails').toBe(false);
        expect(doc.querySelector('#btn-create').disabled).toBe(false);

        doc.querySelector('#host-name').value = 'Bob';
        doc.querySelector('#btn-create').click();
        expect(doc.querySelector('#btn-create').disabled).toBe(true);
        expect(doc.querySelector('#btn-join').disabled, 'the lock works in both directions').toBe(true);
        await advance(200);
        expect(app.lobby && app.lobby.isHost, 'and the table is created').toBe(true);
    });

    it('retires the lobby it replaces, so the room a player joined cannot drive — or destroy — the table they then created', async () => {
        // The player types a friend's code, gets bored, and taps Create Table instead.
        // The join is left holding a fully wired client lobby: its callbacks still write
        // `myPlayerId`, still call showScreen, and its terminal states still run
        // resetToLobby(), which destroys whatever `lobby` happens to be by then.
        const remote = makeRemoteHost('remote');
        extras.push(remote);
        const remoteCode = await remote.open('Alice');

        useTab('player');
        const joining = app.joinGame('Bob', remoteCode);
        await advance(150);
        await joining;
        const remoteCid = remote.joined[0].clientId;
        remote.lobby.send(remoteCid, { type: 'joined', playerId: 'pRemote', reclaimCode: 'AAAA', waiting: true });
        await advance(50);
        expect(app.myPlayerId, 'seated at the friend\'s table').toBe('pRemote');

        // Now they host their own table.
        useTab('player');
        const hosting = app.hostGame('Bob', { buyIn: 300, smallBlind: 5, bigBlind: 10 });
        await advance(150);
        await hosting;
        const myCode = app.lobby.roomCode;
        expect(app.lobby.isHost, 'the app is hosting now').toBe(true);
        expect(app.myPlayerId).toBe('host');

        // The friend's table talks. It must reach nothing at all.
        remote.lobby.broadcast({ type: 'joined', playerId: 'pRemote2', reclaimCode: 'BBBB', waiting: true });
        await advance(80);
        expect(app.myPlayerId, 'the abandoned join does not re-seat the host in its own table').toBe('host');
        expect(app.roomCode, 'nor repaint the host\'s room code').toBe(myCode);

        // And when the friend's table ends, its terminal state must not tear down the
        // room this player is now running.
        const closing = remote.lobby.closeRoom('Alice went to bed');
        await advance(3000);
        await closing;
        expect(app.lobby, 'the player\'s own room is still up').not.toBe(null);
        expect(app.lobby.isHost).toBe(true);
        expect(app.lobby.roomCode).toBe(myCode);
    });
});

/* ── The host's side of a return ──────────────────────────────────────────── */

describe('texas-holdem host: a player who comes back is told where they are', () => {
    let app;
    let seats;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        app = loadHoldemApp('host');
        seats = [];
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) { /* ignore */ }
        for (const s of seats) { try { s.lobby.destroy(); } catch (e) { /* ignore */ } }
        vi.clearAllTimers();
        vi.useRealTimers();
        restoreGlobals();
    });

    async function hostTable() {
        useTab('host');
        const p = app.hostGame('Alice', { buyIn: 300, smallBlind: 5, bigBlind: 10 });
        await advance(60);
        await p;
        return app.lobby.roomCode;
    }

    async function joinAs(tabName, displayName, code, extra) {
        const s = makeSeat(tabName, displayName);
        seats.push(s);
        s.joinPromise = s.lobby.joinRoom(code, displayName, extra).catch((err) => { s.joinError = err; });
        await advance(120);
        await s.joinPromise;
        return s;
    }

    it('names the seat for a rejoin it never saw as away, so a duplicate tab is not stranded', async () => {
        // A brand-new PeerClient carries no staleMs, so the host binds it to the seat
        // and emits 'client-rejoined' without ever having seen a channel close: the seat
        // is not `disconnected` and not `leaving`. The tab in front of the player has
        // been told nothing at all — no seat id, and, in the waiting room, nothing that
        // can move it off the join form.
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        expect(bob.messages.some((m) => m.type === 'joined'), 'the first join is answered').toBe(true);

        bob.messages.length = 0;
        bob.lobby.client.connection.send({
            type: '__slopnet_join',
            clientId: bob.lobby.clientId,
            metadata: { name: 'Bob' },
            token: bob.lobby.client.token,
        });
        await advance(120);

        const joined = bob.messages.find((m) => m.type === 'joined');
        expect(joined, 'the rejoining tab is told which seat it holds').toBeTruthy();
        expect(joined.playerId).toBe(app.lobby.players.get(bob.lobby.clientId).playerId);
        expect(joined.waiting, 'and that the table has not started').toBe(true);
        expect(bob.messages.some((m) => m.type === 'state'), 'with its snapshot alongside').toBe(true);
    });

    it('says which screen a seated player belongs on rather than leaving them to guess', async () => {
        // The client cannot work it out from its own screen: a player re-seated by a
        // host tab that restarted under the same room code is still showing the board of
        // the game that ended.
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        expect(bob.messages.find((m) => m.type === 'joined').waiting, 'seated before the deal').toBe(true);

        const carol = await joinAs('carol', 'Carol', code);
        expect(carol.messages.find((m) => m.type === 'joined').waiting).toBe(true);

        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const seatCode = bob.messages.find((m) => m.type === 'joined').reclaimCode;
        app.game.startHand();
        await advance(40);
        expect(app.game.phase).not.toBe(0);

        bob.lobby.destroy();
        await advance(300);
        const bobBack = await joinAs('bob-phone-2', 'Bob', code, { reclaim: seatCode });
        await advance(60);
        const reclaimed = bobBack.messages.find((m) => m.type === 'joined');
        expect(reclaimed.playerId, 'the seat is handed back').toBe(bobId);
        expect(reclaimed.waiting, 'into a hand that is running, not a waiting room').toBe(false);
    });

    it('keeps a seat code on the host\'s list once the reconnect window has run out', async () => {
        // Marked `leaving` is exactly the player who is now borrowing a tablet and
        // asking the host to read their code out: onPlayerJoined accepts that reclaim.
        // Only a deliberate removal is final.
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const seatCode = bob.messages.find((m) => m.type === 'joined').reclaimCode;
        app.game.startHand();
        await advance(40);

        bob.lobby.destroy();
        await advance(121000);                       // the whole reconnect window, and past it
        const seat = app.game.players.find((p) => p.id === bobId);
        expect(seat.leaving, 'dealt out of the next hand').toBe(true);
        expect(seat.removed, 'but nobody decided against them').toBe(false);

        useTab('host');
        app.renderSeatCodes();
        const shown = String(elIn('host', '#menu-seat-codes').textContent);
        expect(shown, 'the host can still read the code out').toContain(seatCode);
        expect(shown).toContain('Bob');
        expect(shown, 'and is told which player needs it').toContain('(away)');
    });

    it('drops a removed seat from the list, because that decision is final', async () => {
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);
        const bobId = app.lobby.players.get(bob.lobby.clientId).playerId;
        const seatCode = bob.messages.find((m) => m.type === 'joined').reclaimCode;

        useTab('host');
        app.game.removePlayer(bobId);
        app.renderSeatCodes();
        const shown = String(elIn('host', '#menu-seat-codes').textContent);
        expect(shown).not.toContain(seatCode);
        expect(shown, 'Carol\'s is still there').toContain('Carol');
    });

    it('forgets the room code before the page reloads, even with a seat away', async () => {
        // PeerHost.close() holds the room open for reconnectBackoffBase + 250ms when any
        // seat is absent, so an away player's first reconnect rung is answered with the
        // goodbye. A race shorter than that reloaded the tab still holding the code, and
        // the next table came up under the code everyone had just been bounced off.
        const code = await hostTable();
        const bob = await joinAs('bob', 'Bob', code);
        await joinAs('carol', 'Carol', code);
        useTab('host');
        expect(globalThis.sessionStorage.getItem(ROOM_CODE_KEY), 'remembered for a tab discard').toBe(code);

        bob.lobby.client.connection.close();          // Bob's radio drops
        await advance(400);
        expect([...app.lobby.host.clients.values()].some((c) => c.disconnected || !c.conn || !c.conn.open))
            .toBe(true);

        const leaving = app.leaveTable();
        await advance(5000);
        await leaving;

        expect(reloads.length, 'the page reloaded').toBe(1);
        expect(
            reloads[0].roomCode,
            'and the code was already forgotten when it did'
        ).toBe(null);
    });

    it('does not tell the host an outage is over that it never announced', async () => {
        await hostTable();
        toastLog.length = 0;

        app.lobby.host.peer.simulateDisconnect();     // a Wi-Fi blip the ladder mends
        await advance(4000);

        expect(
            toastLog.filter((t) => t === 'Table is reachable again'),
            'no recovery is announced for a failure that was never announced'
        ).toEqual([]);
        expect(toastLog.filter((t) => t === 'New players cannot join right now')).toEqual([]);
    });
});

/* ── The client's side ────────────────────────────────────────────────────── */

describe('texas-holdem client: what the player is shown', () => {
    let app;
    let remote;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        app = loadHoldemApp('bob');
        remote = null;
    });

    afterEach(() => {
        try { app.lobby && app.lobby.destroy(); } catch (e) { /* ignore */ }
        try { remote && remote.lobby.destroy(); } catch (e) { /* ignore */ }
        vi.clearAllTimers();
        vi.useRealTimers();
        restoreGlobals();
    });

    /** Seat the app at a plain SlopLobby table and return its clientId there. */
    async function seatAtRemote() {
        remote = makeRemoteHost('remote');
        const code = await remote.open('Alice');
        useTab('bob');
        const joining = app.joinGame('Bob', code);
        await advance(150);
        await joining;
        return { code, cid: remote.joined[0].clientId };
    }

    it('announces a terminal state once, not twice', async () => {
        const { cid } = await seatAtRemote();
        remote.lobby.send(cid, { type: 'joined', playerId: 'p1', reclaimCode: 'AAAA', waiting: true });
        await advance(50);
        toastLog.length = 0;

        const closing = remote.lobby.closeRoom('Host left the table');
        await advance(3000);
        await closing;

        expect(
            toastLog.filter((t) => /Host ended the game/.test(t)),
            'SlopLobby already says it on the way through'
        ).toHaveLength(1);
        expect(app.lobby, 'and the client is still put back on the join form').toBe(null);
        expect(activeScreen('bob')).toBe('lobby');
    });

    it('throttles the reconnect toast against a counter that keeps counting', async () => {
        // The library clamps the attempt number it reports at the size of the ladder, on
        // purpose, and then walks the ladder twice — so every rung of the second pass
        // reports the same number and a `% 5` throttle on it fires on all of them.
        const { cid } = await seatAtRemote();
        remote.lobby.send(cid, { type: 'joined', playerId: 'p1', reclaimCode: 'AAAA', waiting: true });
        await advance(50);
        toastLog.length = 0;

        remote.lobby.destroy();                       // the host's tab is killed outright
        await advance(240000);                        // the whole ladder, and past it

        const reconnecting = toastLog.filter((t) => /^Reconnecting/.test(t));
        expect(
            reconnecting.length,
            'a handful of toasts across the outage, not one every six seconds'
        ).toBeLessThanOrEqual(6);
        expect(reconnecting.length, 'but the player is told it is trying').toBeGreaterThan(0);
        expect(
            new Set(reconnecting).size,
            'and each one says something different from the last'
        ).toBe(reconnecting.length);
    });

    it('escapes chip amounts, which came off the wire like every other string in the panel', async () => {
        const hostile = '0<img src=x onerror="steal()">';
        const drawnAt = createdEls.length;
        app.renderGame({
            phase: 1, smallBlind: 5, bigBlind: 10, pot: 0, currentBet: 0, minRaise: 10,
            handNum: 1, turnSeq: 1, currentPlayerIndex: -1, dealerIndex: -1, myId: 'me',
            communityCards: [],
            players: [
                { id: 'me', name: 'Bob', chips: 100, currentBet: 0, holeCards: ['As', 'Kd'], totalBetThisHand: 0 },
                { id: 'x', name: 'Eve', chips: hostile, currentBet: hostile, holeCards: ['back', 'back'], totalBetThisHand: 0 },
            ],
        });

        const panels = createdEls.slice(drawnAt).filter((e) => e.className === 'opponent');
        expect(panels.length, 'the opponent panel was drawn').toBe(1);
        expect(panels[0].innerHTML, 'as text, not as markup').not.toContain('<img');
        expect(panels[0].innerHTML).toContain('&lt;img');
    });
});

/* ── A host tab that comes back ───────────────────────────────────────────── */

describe('texas-holdem: the host tab restarts under the same room code', () => {
    let host;
    let host2;
    let bob;

    beforeEach(() => {
        resetRegistry();
        vi.useFakeTimers();
        installBrowserGlobals();
        host = null; host2 = null; bob = null;
    });

    afterEach(() => {
        for (const a of [host, host2, bob]) {
            try { a && a.lobby && a.lobby.destroy(); } catch (e) { /* ignore */ }
        }
        vi.clearAllTimers();
        vi.useRealTimers();
        restoreGlobals();
    });

    it('puts the returning player in the new waiting room instead of on the old, blank board', async () => {
        // A discarded tab never runs beforeunload, so SlopLobby's remembered room code
        // survives and the restored tab comes back as the SAME room — with a brand-new
        // empty PokerGame. The player's client is still on the game screen from the
        // table that has just evaporated.
        host = loadHoldemApp('host');
        const hosting = host.hostGame('Alice', { buyIn: 300, smallBlind: 5, bigBlind: 10 });
        await advance(80);
        await hosting;
        const code = host.lobby.roomCode;

        bob = loadHoldemApp('bob');
        const joining = bob.joinGame('Bob', code);
        await advance(150);
        await joining;

        useTab('carol');
        const carol = new SlopLobby({
            roomPrefix: 'slop-holdem-', storageKey: 'holdem-client-id', onClientData: () => {},
        });
        const carolJoin = carol.joinRoom(code, 'Carol').catch(() => {});
        await advance(150);
        await carolJoin;

        useTab('host');
        host.game.startHand();
        await advance(120);
        expect(activeScreen('bob'), 'Bob is watching a hand').toBe('game');
        expect(bob.lastGameState, 'with a board on screen').toBeTruthy();

        // The browser discards Alice's tab: no beforeunload, so nothing is told and the
        // room code stays in her sessionStorage.
        host.lobby.host.destroy();
        host.game.destroy();
        await advance(200);
        useTab('host');
        expect(globalThis.sessionStorage.getItem(ROOM_CODE_KEY), 'the code is remembered').toBe(code);

        // She comes back and taps Create Table. Same code, new table.
        host2 = loadHoldemApp('host2');
        useTab('host');                              // the SAME tab: its storage came back with it
        const rehosting = host2.hostGame('Alice', { buyIn: 300, smallBlind: 5, bigBlind: 10 });
        await advance(120);
        await rehosting;
        expect(host2.lobby.roomCode, 'the restored tab is the same room').toBe(code);

        // Bob's ladder finds it again and he is seated in the new waiting room.
        await advance(60000);
        expect(host2.game.players.map((p) => p.name), 'Bob is at the new table').toContain('Bob');
        expect(activeScreen('bob'), 'and looking at a waiting room, not a dead board').toBe('waiting-room');
        expect(
            bob.lastGameState && bob.lastGameState.handNum,
            'the hand that vanished with the old table is not what he is holding'
        ).toBe(0);
        expect(bob.myPlayerId, 'he holds the seat the new table gave him')
            .toBe(host2.game.players.find((p) => p.name === 'Bob').id);
        try { carol.destroy(); } catch (e) { /* ignore */ }
    });
});
