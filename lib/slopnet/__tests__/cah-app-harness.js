/**
 * Harness for the Cards Against Humanity app tests.
 *
 * Two pieces, both shared by repro-6 and app-cah.test.js:
 *
 *   1. `useTab()` — a sessionStorage stub with ONE STORE PER SIMULATED TAB, which is the
 *      whole point of the identity bugs: sessionStorage is per-tab, so a second tab mints a
 *      brand-new clientId (sloplobby.js getClientId).
 *   2. `loadCahApp()` — loads the REAL inline <script> out of
 *      projects/cards-against-humanity/index.html and runs it against a minimal DOM stub, so
 *      every assertion is about the shipped game logic rather than a transcription of it.
 *
 * SlopNet/SlopLobby are the real classes; only `_PeerClass: MockPeer` is injected.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MockPeer } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
export const { SlopLobby } = SlopLobbyModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const CAH_HTML = resolve(HERE, '../../../projects/cards-against-humanity/index.html');

/* ── Per-tab sessionStorage ─────────────────────────────────────────────── */

const savedGlobals = {};
const tabStores = new Map();
let currentTab = null;

export function useTab(name) {
    if (!tabStores.has(name)) tabStores.set(name, new Map());
    currentTab = tabStores.get(name);
}

/* ── Minimal DOM ────────────────────────────────────────────────────────────
   Enough for SlopLobby's $/toast/showScreen and CAH's render/log helpers.
   getElementById memoises one fake element per id, so the app can read back what it
   wrote (e.g. $('player-name').value, or the last #game-status text an assertion checks). */

export function makeEl(id) {
    const classes = new Set();
    // The app wires every control with addEventListener at load, so a test that wants to
    // press a button has to be handed the handler back. A disabled control fires nothing,
    // exactly as a real one does not (even for element.click()).
    const listeners = new Map();
    const element = {
        id: id || '',
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        scrollTop: 0,
        scrollHeight: 0,
        style: {},
        classList: {
            add: (c) => classes.add(c),
            remove: (c) => classes.delete(c),
            toggle: (c, force) => {
                const on = force === undefined ? !classes.has(c) : !!force;
                if (on) classes.add(c); else classes.delete(c);
                return on;
            },
            contains: (c) => classes.has(c),
        },
        appendChild() {},
        remove() {},
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        dispatch(type, event) {
            if (element.disabled) return undefined;
            let last;
            for (const fn of (listeners.get(type) || []).slice()) last = fn(event || { type });
            return last;
        },
        click() { return element.dispatch('click'); },
        querySelectorAll: () => [],
    };
    return element;
}

/** How many times the page has asked to reload itself (New Game does, once). */
let reloadCount = 0;
export function reloads() { return reloadCount; }

export function installBrowserGlobals() {
    for (const key of ['sessionStorage', 'document', 'SlopNet', 'SlopLobby', 'location']) {
        savedGlobals[key] = globalThis[key];
    }

    reloadCount = 0;
    globalThis.location = { reload: () => { reloadCount++; } };

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

export function restoreGlobals() {
    for (const key of ['sessionStorage', 'document', 'SlopNet', 'SlopLobby', 'location']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

/** The element the app last wrote to, by id (assertions read #game-status, #submitted-count). */
export function el(id) {
    return globalThis.document.getElementById(id);
}

/**
 * Press a control, the way a finger does — through the listener the app registered for it.
 * A disabled button does nothing, so a test can prove a guard by tapping twice.
 * @returns whatever the handler returned (a promise, for the async ones).
 */
export function tap(id) {
    return el(id).click();
}

/**
 * Load the real CAH game script out of index.html.
 * The inline <script> is a plain top-level script (not an IIFE), so evaluating it as a
 * function body keeps its `const state` / `let lobby` in a closure we read through getters.
 * Nothing in the app source is edited.
 */
export function loadCahApp() {
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
            get selectedSubmissionId() { return selectedSubmissionId; },
            get renderedSubmissions() { return renderedSubmissions; },
            // The host's own taps are marked with a Symbol so no wire message can claim to be
            // the host; a test that drives handleHostMessage directly needs the same marker.
            HOST_SELF,
            createGame, joinGame, startGame, nextRound, startJudging, maybeStartJudging,
            handleHostMessage, handleClientMessage, handleClientState,
            buildResync, submitCards, selectCard, selectSubmission, pickWinner,
            triggerNextRound, renderRound, announceWinner,
            // Player ids never leave the host: the wire carries an alias per seat, so a test
            // that compares what a client was told against host state has to translate.
            wireId,
        };
    `);
    return factory();
}

/**
 * A player's phone/tab: a plain SlopLobby client that records what the host tells it.
 * Mirrors handleClientMessage for the parts the assertions care about.
 */
export function makeSeat(tabName, displayName) {
    const seat = {
        tabName,
        name: displayName,
        lobby: null,
        czarId: null,
        hand: [],
        black: null,
        round: 0,
        phase: null,
        players: [],
        submitted: false,
        lastSubmitCount: null,
        sawJudging: false,
        judging: null,
        myId: null,
        // Every app-level message this device was handed, verbatim — the evidence for
        // "no clientId ever reaches a player's page".
        messages: [],
        resyncs: [],
        winners: [],
        rejections: [],
        joinErrors: [],
        states: [],
        gameOvers: [],
    };
    seat.lobby = new SlopLobby({
        roomPrefix: 'cah-',
        storageKey: 'cah-client-id',
        onClientData: (data) => {
            seat.messages.push(data);
            if (data.type === 'resync') {
                seat.resyncs.push(data);
                // Which seat is ours, in the only ids this device is ever shown.
                if (data.youId) seat.myId = data.youId;
                seat.hand = data.hand || [];
                seat.black = data.black || null;
                seat.czarId = data.czarId;
                seat.round = data.round;
                seat.phase = data.phase;
                seat.players = data.players || [];
                seat.submitted = !!data.submitted;
                if (data.submissions) seat.judging = data.submissions;
            }
            if (data.type === 'new-round') {
                seat.hand = data.hand;
                seat.black = data.black || null;
                seat.czarId = data.czarId;
                seat.round = data.round;
                seat.phase = 'playing';
                seat.players = data.players || seat.players;
                seat.submitted = false;
            }
            if (data.type === 'player-list') {
                seat.players = data.players || seat.players;
                if ('czarId' in data) seat.czarId = data.czarId;
            }
            if (data.type === 'submit-count') seat.lastSubmitCount = { count: data.count, needed: data.needed };
            if (data.type === 'judging') {
                seat.sawJudging = true;
                seat.phase = 'judging';
                seat.judging = data.submissions;
                if ('czarId' in data) seat.czarId = data.czarId;
            }
            if (data.type === 'round-winner') {
                seat.phase = data.gameOver ? 'gameover' : 'result';
                seat.winners.push({ id: data.winnerId, name: data.winnerName, players: data.players });
                seat.players = data.players || seat.players;
            }
            if (data.type === 'game-over') seat.gameOvers.push(data);
            if (data.type === 'submit-rejected' || data.type === 'pick-rejected' ||
                data.type === 'next-round-rejected') {
                seat.rejections.push(data);
            }
            if (data.type === 'join-error') seat.joinErrors.push(data);
        },
        onStateChange: (status, detail) => { seat.states.push({ status, detail }); },
    });
    return seat;
}

/** How many cards this round's black card asks for. */
export function pickCount(seat) {
    return (seat.black && seat.black.p) || 1;
}

/** One seat plays the first `pick` cards of its hand, the way submitCards does. */
export function seatSubmits(seat) {
    const cards = seat.hand.slice(0, pickCount(seat));
    seat.submitted = true;
    return seat.lobby.sendToHost({ type: 'submit', round: seat.round, cards });
}
