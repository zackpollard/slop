/**
 * HARNESS — loads the REAL inline <script> out of projects/flip-7/index.html and runs
 * it against a DOM stub, so tests assert on the shipped game logic rather than on a
 * transcription of it. SlopNet / SlopLobby are the real classes; only the Peer
 * transport is injected (`_PeerClass: MockPeer`), exactly as repro-2 and repro-6 do.
 *
 * Shared by app-flip7.test.js (behaviour) and attack-flip-7.test.js (adversarial),
 * so an attack and its fix are pinned against the same code path.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MockPeer, resetRegistry } from './mock-peer.js';

const SlopNet = require('../slopnet.js');
const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
const { SlopLobby } = SlopLobbyModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const FLIP7_HTML = resolve(HERE, '../../../projects/flip-7/index.html');

/* ── Harness 1: per-tab sessionStorage ───────────────────────────────────────
   sessionStorage is per tab, and SlopLobby mints its clientId and stores its seat
   token there. Every simulated phone/tab below gets its own store. */

const savedGlobals = {};
const tabStores = new Map();
let currentTab = null;

function useTab(name) {
    if (!tabStores.has(name)) tabStores.set(name, new Map());
    currentTab = tabStores.get(name);
}

/* ── Harness 2: a DOM stub with working listeners ────────────────────────────
   flip-7 grabs ~50 elements by id at load, renders through innerHTML, and wires its
   buttons with addEventListener — so the stub has to remember listeners and let
   `el.click()` dispatch them. That is what lets these tests press the app's own
   Start Game / Submit Round / Reset Game rather than calling internals. */

function makeEl(id) {
    const listeners = Object.create(null);
    const classes = new Set();
    const el = {
        id: id || '',
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        dataset: {},
        style: { cssText: '' },
        classList: {
            add(...names) { names.forEach(n => classes.add(n)); },
            remove(...names) { names.forEach(n => classes.delete(n)); },
            toggle(name, force) {
                const on = force === undefined ? !classes.has(name) : !!force;
                if (on) classes.add(name); else classes.delete(name);
                return on;
            },
            contains(name) { return classes.has(name); },
        },
        _classes: classes,
        appendChild() {},
        remove() {},
        focus() {},
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            listeners[type] = (listeners[type] || []).filter(f => f !== fn);
        },
        dispatch(type, event) {
            const ev = Object.assign({ preventDefault() {}, target: el }, event || {});
            (listeners[type] || []).slice().forEach(fn => fn(ev));
        },
        click() { el.dispatch('click'); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        getAttribute() { return null; },
        parentNode: { insertBefore() {} },
    };
    el.nextSibling = null;
    return el;
}

function makeDocument() {
    const byId = new Map();
    const doc = {
        visibilityState: 'visible',
        getElementById(id) {
            if (!byId.has(id)) byId.set(id, makeEl(id));
            return byId.get(id);
        },
        createElement() { return makeEl(''); },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {},
        body: { appendChild() {} },
        _byId: byId,
    };
    return doc;
}

/**
 * A window stub that REMEMBERS its listeners, so a test can fire the events the
 * browser fires — `beforeunload` above all, which is the one the host tab raises on
 * a reload and which used to end the room for everybody.
 */
function makeWindow() {
    const listeners = Object.create(null);
    return {
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            listeners[type] = (listeners[type] || []).filter(f => f !== fn);
        },
        dispatch(type, event) {
            const ev = Object.assign({ preventDefault() {} }, event || {});
            (listeners[type] || []).slice().forEach(fn => fn(ev));
        },
        _listenerCount(type) { return (listeners[type] || []).length; },
    };
}

function installBrowserGlobals() {
    for (const key of ['sessionStorage', 'localStorage', 'document', 'window',
                       'confirm', 'SlopNet', 'SlopLobby']) {
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

    const local = new Map();
    globalThis.localStorage = {
        getItem: (k) => (local.has(k) ? local.get(k) : null),
        setItem: (k, v) => { local.set(k, String(v)); },
        removeItem: (k) => { local.delete(k); },
        clear: () => local.clear(),
    };

    globalThis.confirm = () => true;
    globalThis.document = makeDocument();
    globalThis.window = makeWindow();

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
    for (const key of Object.keys(savedGlobals)) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

/* ── Harness 3: load the real flip-7 script ──────────────────────────────────
   The inline <script> is a plain IIFE. Stripping the wrapper and evaluating the body
   as a function body keeps its `let players` / `let lobby` in a closure we can read
   through getters. Nothing in the app source is edited. */

const APP_SOURCE = (() => {
    const lines = readFileSync(FLIP7_HTML, 'utf8').split('\n');
    const start = lines.findIndex(l => l.trim() === '<script>');
    const end = lines.findIndex((l, i) => i > start && l.trim() === '</script>');
    if (start < 0 || end < 0) throw new Error('could not locate the flip-7 inline <script>');
    const body = lines.slice(start + 1, end);
    const open = body.findIndex(l => l.trim() === '(function() {');
    const close = body.map(l => l.trim()).lastIndexOf('})();');
    if (open < 0 || close < 0) throw new Error('could not locate the flip-7 IIFE wrapper');
    return body.slice(open + 1, close).join('\n');
})();

const ACCESSORS = `
;return {
    get players() { return players; },
    get rounds() { return rounds; },
    get currentRound() { return currentRound; },
    get gameStarted() { return gameStarted; },
    get gameOver() { return gameOver; },
    get gameMode() { return gameMode; },
    get roomCode() { return roomCode; },
    get myName() { return myName; },
    get myScoreSubmitted() { return myScoreSubmitted; },
    get myScoreQueued() { return myScoreQueued; },
    get lobby() { return lobby; },
    get lobbyPlayers() { return lobbyPlayers; },
    get peerSubmissions() { return peerSubmissions; },
    get roundState() { return roundState; },
    get hostEditingPlayers() { return hostEditingPlayers; },
    get disconnectedPlayers() { return disconnectedPlayers; },
    get terminalActive() { return terminalActive; },
    get roundEpoch() { return roundEpoch; },
    get pendingSubmit() { return pendingSubmit; },
    get myOverridden() { return myOverridden; },
    get rematchRequests() { return rematchRequests; },
    get submissionEpochs() { return submissionEpochs; },
    get allBustTakeovers() { return allBustTakeovers; },
    get localPlayers() { return localPlayers; },
    get ruleset() { return ruleset; },
    get brutal() { return brutal; },
    get rulesetLocked() { return rulesetLocked; },
    nameToId, handlePeerMessage, attemptJoin, isBlankEntry,
    snapshotEntry, calculateRoundScore,
};
`;

function loadApp(tabName) {
    useTab(tabName);
    const doc = makeDocument();
    const win = makeWindow();
    globalThis.document = doc;
    globalThis.window = win;
    const api = new Function(APP_SOURCE + ACCESSORS)();
    return Object.assign(api, {
        doc,
        win,
        tabName,
        el: (id) => doc.getElementById(id),
        /** Point the shared globals at THIS instance's DOM before driving it. */
        activateDom() { globalThis.document = doc; globalThis.window = win; },
    });
}

/** A player's phone: a plain SlopLobby client that records what it is told. */
function makeSeat(tabName, displayName) {
    useTab(tabName);
    const seat = {
        tabName,
        name: displayName,
        messages: [],
        states: [],
        lobby: null,
        last(type) {
            for (let i = seat.messages.length - 1; i >= 0; i--) {
                if (seat.messages[i].type === type) return seat.messages[i];
            }
            return null;
        },
        countOf(type) { return seat.messages.filter(m => m.type === type).length; },
        sawState(name) { return seat.states.some(s => s.state === name); },
        stateDetail(name) {
            const hit = seat.states.find(s => s.state === name);
            return hit ? hit.detail : undefined;
        },
    };
    seat.lobby = new SlopLobby({
        roomPrefix: 'flip7-',
        storageKey: 'flip7-client-id',
        onClientData: (data) => seat.messages.push(data),
        onStateChange: (state, detail) => seat.states.push({ state, detail }),
    });
    return seat;
}

/** A classic-ruleset score payload of the shape submitScorePeer sends. */
function card(cards, extra) {
    return Object.assign(
        { cards: cards.slice(), modifiers: [], x2: false, flip7: false, bust: false },
        extra || {}
    );
}

export {
    useTab, makeEl, makeDocument, makeWindow,
    installBrowserGlobals, restoreGlobals, loadApp, makeSeat, card,
    SlopLobby, SlopNet,
};
