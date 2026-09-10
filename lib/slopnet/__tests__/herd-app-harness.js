/**
 * Shared harness for the herd-mentality suites — app-herd.test.js (the game people play) and
 * attack-herd-mentality.test.js (the same script, driven adversarially).
 *
 * Both load the real inline <script> out of projects/herd-mentality/index.html (never a
 * transcription of it) and run it against a DOM stub and the real SlopNet/SlopLobby, with
 * only the Peer transport injected. The assertions in each suite are therefore about the
 * shipped game.
 *
 * ON THE HARNESS
 *   `installBrowserGlobals()` registers an element for every id that exists in index.html, and
 *   registers the ids inside any innerHTML the app writes — which is how the host's own answer
 *   box (built at runtime by showHostAnswerPrompt) is clickable here. `click()` dispatches the
 *   listeners the app really registered. `useTab()` gives each simulated browser tab its own
 *   sessionStorage, because that is where the clientId and the seat token live. `freezePage()`
 *   (from repro-4) models a locked phone: timers stopped, messages buffered, DataChannel
 *   untouched.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { MockPeer, resetRegistry } from './mock-peer.js';

export { resetRegistry };

const SlopNet = require('../slopnet.js');
const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
export const { SlopLobby } = SlopLobbyModule;

const HERE = dirname(fileURLToPath(import.meta.url));
const HERD_HTML = resolve(HERE, '../../../projects/herd-mentality/index.html');
export const HERD_SOURCE = readFileSync(HERD_HTML, 'utf8');

/* ── per-tab sessionStorage ───────────────────────────────────────────── */

const savedGlobals = {};
const tabStores = new Map();
let currentTab = null;

export function useTab(name) {
    if (!tabStores.has(name)) tabStores.set(name, new Map());
    currentTab = tabStores.get(name);
}

/* ── DOM stub ─────────────────────────────────────────────────────────── */

function makeClassList() {
    const set = new Set();
    return {
        add: (...c) => c.forEach(x => set.add(x)),
        remove: (...c) => c.forEach(x => set.delete(x)),
        toggle: (c) => (set.has(c) ? set.delete(c) : set.add(c)),
        contains: (c) => set.has(c),
    };
}

function makeEl(id, byId) {
    const listeners = {};
    const el = {
        id: id || '',
        value: '',
        textContent: '',
        disabled: false,
        className: '',
        style: {},
        dataset: {},
        focused: false,
        children: [],
        classList: makeClassList(),
        _html: '',
        get innerHTML() { return el._html; },
        set innerHTML(v) {
            el._html = String(v == null ? '' : v);
            registerIds(el._html, byId);
        },
        appendChild(child) {
            el.children.push(child);
            if (child && child.id) byId.set(child.id, child);
        },
        remove() { if (el.id) byId.delete(el.id); },
        addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
        removeEventListener(type, fn) {
            if (listeners[type]) listeners[type] = listeners[type].filter(f => f !== fn);
        },
        dispatch(type, ev) {
            for (const fn of (listeners[type] || []).slice()) fn(ev || { target: el });
        },
        click() { el.dispatch('click', { target: el, preventDefault() {} }); },
        focus() { el.focused = true; },
        querySelectorAll: () => [],
        closest: () => null,
        listenerCount(type) { return (listeners[type] || []).length; },
    };
    return el;
}

/** Any id the app writes into innerHTML becomes reachable through getElementById. */
function registerIds(html, byId) {
    const re = /id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        if (!byId.has(m[1])) byId.set(m[1], makeEl(m[1], byId));
    }
}

/**
 * A fresh, empty DOM carrying every id the shipped markup has — i.e. a PAGE RELOAD.
 *
 * sessionStorage (and therefore the clientId, the seat token and the remembered room code)
 * is deliberately untouched, so a second `loadHerdApp()` after this is the same tab running
 * the script again: exactly what a discarded-and-restored host tab does. Without a new DOM
 * the two copies of the script share element objects and both their click handlers fire.
 */
export function reloadDom() {
    const byId = new Map();
    registerIds(HERD_SOURCE, byId);
    globalThis.document = {
        getElementById: (id) => byId.get(id) || null,
        createElement: () => makeEl('', byId),
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        body: { appendChild() {} },
        visibilityState: 'visible',
    };
    globalThis.document._byId = byId;
}

export function installBrowserGlobals() {
    for (const key of ['sessionStorage', 'document', 'window', 'SlopNet', 'SlopLobby']) {
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

    reloadDom();

    globalThis.window = {
        AudioContext: FakeAudioContext,
        addEventListener() {},
        removeEventListener() {},
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
}

export function restoreGlobals() {
    for (const key of ['sessionStorage', 'document', 'window', 'SlopNet', 'SlopLobby']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

export const $ = (id) => globalThis.document.getElementById(id);

/* ── audio stub: counts contexts built and moos actually sounded ───────── */

export const audio = { contexts: 0, moos: 0 };

export class FakeAudioContext {
    constructor() {
        audio.contexts++;
        this.state = 'suspended';
        this.currentTime = 0;
        this.destination = {};
    }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
        return {
            type: '',
            frequency: { setValueAtTime() {}, linearRampToValueAtTime() {} },
            connect() {}, start() {}, stop() {},
        };
    }
    createGain() {
        audio.moos++;                 // exactly one gain node per moo
        return {
            gain: {
                setValueAtTime() {}, linearRampToValueAtTime() {},
                exponentialRampToValueAtTime() {},
            },
            connect() {},
        };
    }
}

/* ── the app under test ───────────────────────────────────────────────── */

/**
 * Load the real herd script. The inline <script> is one IIFE, so the wrapper is peeled off
 * and the body is evaluated as a function body — its `let players` / `let lobby` then live
 * in a closure the getters below can read. Nothing in the app source is edited.
 */
export function loadHerdApp() {
    const lines = HERD_SOURCE.split('\n');
    const start = lines.findIndex(l => l.trim() === '<script>');
    const end = lines.findIndex((l, i) => i > start && l.trim() === '</script>');
    if (start < 0 || end < 0) throw new Error('could not locate the herd inline <script>');
    const inner = lines.slice(start + 1, end);
    const open = inner.findIndex(l => l.trim() === '(function() {');
    const closeFromEnd = [...inner].reverse().findIndex(l => l.trim() === '})();');
    if (open < 0 || closeFromEnd < 0) throw new Error('could not unwrap the herd IIFE');
    const close = inner.length - 1 - closeFromEnd;
    const src = inner.slice(open + 1, close).join('\n');

    const factory = new Function(`
        ${src}
        ;return {
            get lobby() { return lobby; },
            get role() { return role; },
            get myName() { return myName; },
            get roomCode() { return roomCode; },
            get players() { return players; },
            get scores() { return scores; },
            get answers() { return answers; },
            get cowHolder() { return cowHolder; },
            get gamePhase() { return gamePhase; },
            get roundNumber() { return roundNumber; },
            get currentScreen() { return currentScreen; },
            get awayPlayers() { return awayPlayers; },
            get disconnectedPlayers() { return disconnectedPlayers; },
            get roundParticipants() { return roundParticipants; },
            get mergeGroups() { return mergeGroups; },
            get myAnswer() { return myAnswer; },
            get myAnswerSent() { return myAnswerSent; },
            get lastResults() { return lastResults; },
        };
    `);
    return factory();
}

/* ── a player's phone: a plain SlopLobby client speaking herd's protocol ── */

export function makeSeat(tabName, displayName) {
    const seat = {
        tabName, name: displayName, lobby: null,
        received: [], round: null, question: null, phase: null, moos: 0, acked: [], rejected: [],
    };
    seat.attach = (lobbyInstance) => { seat.lobby = lobbyInstance; return seat; };
    seat.onData = (data) => {
        seat.received.push(data);
        if (data.type === 'question') { seat.round = data.round; seat.question = data.question; seat.phase = 'answering'; }
        if (data.type === 'rejoin') { seat.round = data.round; seat.question = data.question; seat.phase = data.gamePhase; }
        if (data.type === 'joined') seat.phase = 'lobby';
        if (data.type === 'moo') seat.moos++;
        if (data.type === 'answer-ack') seat.acked.push(data.round);
        if (data.type === 'answer-reject') seat.rejected.push(data.round);
    };
    return seat;
}

export function newClientLobby(seat) {
    return new SlopLobby({
        roomPrefix: 'herdm-',
        storageKey: 'herd-client-id',
        onClientData: seat.onData,
    });
}

/* ── a locked phone (repro-4's helper) ────────────────────────────────── */

export function freezePage(client) {
    const conn = client.connection;
    const realEmit = conn.emit.bind(conn);
    const buffered = [];
    conn.emit = (event, ...args) => { buffered.push([event, args]); };
    client._stopHeartbeat();
    return {
        wake() { conn.emit = realEmit; },
        deliverBufferedMessages() { for (const [e, a] of buffered.splice(0)) realEmit(e, ...a); },
        resumeTimers() { client._startHeartbeat(); },
    };
}

