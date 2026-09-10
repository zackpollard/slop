/**
 * Shared harness for the lib-*.test.js suites.
 *
 * sloplobby.js is a UMD IIFE that reads a GLOBAL `SlopNet` plus browser globals
 * (`sessionStorage`, `document`) at call time. This module supplies them, following
 * the pattern the repro-* files established, with two additions the newer library
 * features need: a `document` that can register/dispatch 'visibilitychange', and a
 * `sessionStorage` that can be made to throw (private/partitioned contexts).
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */
import { createRequire } from 'node:module';
import { vi } from 'vitest';
import { MockPeer } from './mock-peer.js';

const require = createRequire(import.meta.url);
export const SlopNet = require('../slopnet.js');
export const SlopLobbyModule = require('../../sloplobby/sloplobby.js');
export const { SlopLobby } = SlopLobbyModule;

const savedGlobals = {};

/**
 * @param {object} [opts]
 * @param {Map}    [opts.store]            backing store (share one to model the same tab)
 * @param {boolean}[opts.throwingStorage]  every sessionStorage call throws
 * @param {boolean}[opts.withVisibility]   default true; false = document has no addEventListener
 * @returns {{ store: Map, document: object, toasts: string[] }}
 */
export function installBrowserGlobals(opts = {}) {
    // `current` is swappable so one test can model several browser tabs, each
    // with its own sessionStorage, against the same lobby objects.
    const current = { store: opts.store || new Map() };
    const throwing = !!opts.throwingStorage;
    savedGlobals.sessionStorage = globalThis.sessionStorage;
    savedGlobals.document = globalThis.document;

    const deny = () => { throw new Error('SecurityError: storage is not available in this context'); };
    globalThis.sessionStorage = {
        getItem: (k) => { if (throwing) deny(); return current.store.has(k) ? current.store.get(k) : null; },
        setItem: (k, v) => { if (throwing) deny(); current.store.set(k, String(v)); },
        removeItem: (k) => { if (throwing) deny(); current.store.delete(k); },
        clear: () => current.store.clear(),
    };

    const toasts = [];
    const makeEl = () => ({
        style: {}, className: '', textContent: '',
        classList: { add() {}, remove() {} },
        appendChild() {}, remove() {},
    });
    const listeners = new Map();
    const doc = {
        visibilityState: 'visible',
        getElementById: () => null,          // forces toast()'s pattern-3 fallback
        createElement: makeEl,
        querySelectorAll: () => [],
        // toast()'s fallback appends the element here; record what it said.
        body: { appendChild(el) { toasts.push(el.textContent); } },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            const set = listeners.get(type);
            if (set) set.delete(fn);
        },
        /** Test helper: fire every listener for `type`. */
        _dispatch(type) {
            for (const fn of [...(listeners.get(type) || [])]) fn();
        },
        _listenerCount(type) {
            return (listeners.get(type) || new Set()).size;
        },
    };
    if (opts.withVisibility === false) {
        delete doc.addEventListener;
        delete doc.removeEventListener;
    }
    globalThis.document = doc;
    return {
        store: current.store,
        document: doc,
        toasts,
        /** Point the global sessionStorage at another tab's store. */
        useStore(map) { current.store = map; },
    };
}

/**
 * Global `SlopNet` with the REAL classes; only the Peer transport is injected, so
 * every other config value is the production default — exactly how sloplobby.js
 * constructs them with `{ roomPrefix }` alone.
 */
export function installSlopNetGlobal(PeerClass = MockPeer, extraConfig = {}) {
    savedGlobals.SlopNet = globalThis.SlopNet;
    globalThis.SlopNet = {
        ...SlopNet,
        PeerHost: class extends SlopNet.PeerHost {
            constructor(cfg) { super({ ...cfg, ...extraConfig, _PeerClass: PeerClass }); }
        },
        PeerClient: class extends SlopNet.PeerClient {
            constructor(cfg) { super({ ...cfg, ...extraConfig, _PeerClass: PeerClass }); }
        },
    };
}

export function restoreGlobals() {
    for (const key of ['sessionStorage', 'document', 'SlopNet']) {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
        delete savedGlobals[key];
    }
}

/** Fast-ladder config for direct PeerHost/PeerClient tests. */
export const FAST = {
    roomPrefix: 'lib-',
    heartbeatInterval: 0,
    reconnectWindowMs: 60000,
    connectionTimeout: 3000,
    reconnectBackoffBase: 50,
    reconnectBackoffMultiplier: 1.5,
    reconnectBackoffMax: 500,
    _PeerClass: MockPeer,
};

export function createHost(overrides = {}) {
    return new SlopNet.PeerHost({ ...FAST, ...overrides });
}

export function createClient(overrides = {}) {
    return new SlopNet.PeerClient({ ...FAST, ...overrides });
}

/** Start a host on `code` and settle it. */
export async function startHost(code = 'ROOM1', overrides = {}) {
    const host = createHost(overrides);
    const p = host.start(code);
    await advance(20);
    await p;
    return host;
}

/** Connect a client to `code` as `clientId` and settle it. */
export async function joinClient(code, clientId, metadata = {}, overrides = {}, connectOpts) {
    const client = createClient(overrides);
    const p = client.connect(code, clientId, metadata, connectOpts);
    await advance(50);
    await p;
    return client;
}

/** Record every emission of `events` on `emitter` as `{ event, args }`. */
export function recordEvents(emitter, events) {
    const log = [];
    for (const ev of events) emitter.on(ev, (...args) => log.push({ event: ev, args }));
    return log;
}

export function advance(ms) {
    return vi.advanceTimersByTimeAsync(ms);
}
