/*
 * store.js — app state, persistence and the Octopus API key.
 *
 * One plain object holds everything the UI needs to remember. It is persisted to localStorage
 * (minus the dataset summary, which is rebuilt from the data every visit) and every storage call
 * is wrapped: private windows, blocked site data and full quotas all throw, and the app must keep
 * working in memory when they do.
 *
 * The API key lives outside the state object on purpose: it is never written into the persisted
 * JSON (so exports and bug reports can't leak it) and only reaches localStorage when the user
 * ticks "Remember on this device". Otherwise it stays in sessionStorage, which dies with the tab.
 */

export const STATE_KEY = 'solar-calculator:v1';
export const API_KEY_KEY = 'solar-calculator:key';

/**
 * Fresh default state (a new object every call, so callers can mutate it).
 * @returns {object}
 */
export function defaultState() {
    return {
        version: 1,
        connection: {
            kind: null,
            accountNumber: null,
            rememberKey: false,
            location: { postcode: null, lat: null, lon: null },
            demoServerW: 500,
            manual: { baseW: 400, otherKwhYr: 2700 },
            installedSolarDate: null,
            priceBasis: 'mine',
            flatP: null,
        },
        dataset: null,
        settings: {
            finance: {},
            projectBaseW: null,
            spots: [],
            vatReturns: true,
            maxPaybackYears: 10,
        },
        scenarios: { saved: [], pinned: [], activeId: null },
        ui: { tab: 'verdict', designMode: 'simple', chartTables: {} },
    };
}

const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)
    && Object.getPrototypeOf(v) === Object.prototype;

/*
 * Plain objects merge recursively so `set({ ui: { tab } })` keeps `ui.designMode`; arrays, typed
 * arrays and null replace wholesale because a partial array merge is never what a caller means.
 */
function merge(base, patch) {
    if (!isPlain(base) || !isPlain(patch)) return patch;
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        out[k] = isPlain(v) && isPlain(base[k]) ? merge(base[k], v) : v;
    }
    return out;
}

/*
 * Restoring old JSON: keep only keys the defaults know about, with the default's type. A stale or
 * hand-edited blob can then never crash a view with `settings.spots.map is not a function`.
 */
function sanitize(defaults, saved) {
    if (!isPlain(defaults)) {
        if (defaults === null) return saved;            // nullable leaf: accept whatever was stored
        if (Array.isArray(defaults)) return Array.isArray(saved) ? saved : defaults;
        return typeof saved === typeof defaults ? saved : defaults;
    }
    if (!isPlain(saved)) return defaults;
    const out = {};
    for (const k of Object.keys(defaults)) out[k] = k in saved ? sanitize(defaults[k], saved[k]) : defaults[k];
    // Open-ended maps (finance overrides, per-chart table toggles) keep their extra keys.
    if (Object.keys(defaults).length === 0) Object.assign(out, saved);
    return out;
}

const SHAPES = defaultState();
/* Top-level sections that are plain objects by default must stay plain objects. */
const shapeOk = (key, value) => !isPlain(SHAPES[key]) || isPlain(value);

function storageOf(name) {
    // Even reading `window.localStorage` throws a SecurityError when site data is blocked.
    try { return globalThis[name] ?? null; } catch { return null; }
}

function safeGet(storage, key) {
    try { return storage ? storage.getItem(key) : null; } catch { return null; }
}

function safeSet(storage, key, value) {
    try { if (!storage) return false; storage.setItem(key, value); return true; } catch { return false; }
}

function safeRemove(storage, key) {
    try { if (storage) storage.removeItem(key); } catch { /* blocked storage: nothing to remove */ }
}

/**
 * Build a store. The app uses the `store` singleton; tests build their own with stub storages.
 * @param {{ local?: Storage|null|(() => Storage|null), session?: Storage|null|(() => Storage|null) }} [opts]
 *   storages, or getters for them (default: the globals, resolved lazily on every access)
 * @returns {{ get(): object, set(patch: object): void, update(key: string, fn: (v: any) => any): void,
 *   subscribe(fn: (state: object, changed: string[]) => void, keys?: string[]): () => void,
 *   reset(): void, persistOk(): boolean, getApiKey(): string|null, setApiKey(key: string, remember: boolean): void,
 *   clearApiKey(): void }}
 */
export function createStore({ local, session } = {}) {
    const resolve = (opt, name) => () => {
        try { return typeof opt === 'function' ? opt() : opt !== undefined ? opt : storageOf(name); } catch { return null; }
    };
    const getLocal = resolve(local, 'localStorage');
    const getSession = resolve(session, 'sessionStorage');

    let state = load();
    let memoryKey = null;
    let lastPersistOk = true;
    const subs = new Set();

    function load() {
        const raw = safeGet(getLocal(), STATE_KEY);
        if (!raw) return defaultState();
        try {
            const saved = JSON.parse(raw);
            if (!saved || saved.version !== 1) return defaultState();
            const s = sanitize(defaultState(), saved);
            s.dataset = null;
            return s;
        } catch {
            return defaultState();
        }
    }

    function persist() {
        const { dataset, ...rest } = state;
        let json;
        try { json = JSON.stringify(rest); } catch { lastPersistOk = false; return; }
        lastPersistOk = safeSet(getLocal(), STATE_KEY, json);
    }

    function emit(changed) {
        if (!changed.length) return;
        for (const sub of [...subs]) {
            if (sub.keys && !sub.keys.some(k => changed.includes(k))) continue;
            try { sub.fn(state, changed); } catch (err) { console.error('store subscriber failed', err); }
        }
    }

    const api = {
        /** @returns {object} the live state — treat it as read-only and change it through set/update */
        get: () => state,

        /** Deep-merge a partial state; notifies subscribers of the top-level keys that changed. */
        set(patch) {
            if (!isPlain(patch)) return;
            // Unknown top-level keys are dropped so a typo can't grow the persisted blob forever, and
            // a section that is an object by default can't be replaced by null/array/scalar (every
            // view reads state.settings.x without a guard).
            const changed = Object.keys(patch).filter(k => k in state && patch[k] !== undefined && shapeOk(k, patch[k]));
            if (!changed.length) return;
            state = merge(state, Object.fromEntries(changed.map(k => [k, patch[k]])));
            if (changed.some(k => k !== 'dataset')) persist();
            emit(changed);
        },

        /** Replace one top-level key with fn(current) (no merge; ignored if it would change the section's shape). */
        update(key, fn) {
            if (!(key in state)) return;
            const next = fn(state[key]);
            if (next === undefined || !shapeOk(key, next)) return;
            state = { ...state, [key]: next };
            if (key !== 'dataset') persist();
            emit([key]);
        },

        /** Listen for changes, optionally only to some top-level keys. Returns an unsubscribe function. */
        subscribe(fn, keys) {
            const sub = { fn, keys: keys && keys.length ? keys : null };
            subs.add(sub);
            return () => subs.delete(sub);
        },

        /** Back to defaults (keeps the API key — use clearApiKey for that). */
        reset() {
            const ds = state.dataset;
            state = defaultState();
            state.dataset = ds;
            persist();
            emit(Object.keys(state));
        },

        /** False when the last write to localStorage failed (the UI can warn once). */
        persistOk: () => lastPersistOk,

        getApiKey() {
            if (memoryKey) return memoryKey;
            const k = safeGet(getSession(), API_KEY_KEY) || safeGet(getLocal(), API_KEY_KEY);
            if (k) memoryKey = k;
            return k || null;
        },

        setApiKey(key, remember) {
            const k = typeof key === 'string' ? key.trim() : '';
            if (!k) { api.clearApiKey(); return; }
            memoryKey = k;
            if (remember) {
                safeSet(getLocal(), API_KEY_KEY, k);
                safeRemove(getSession(), API_KEY_KEY);
            } else {
                // Unticking "remember" must actually forget it on this device.
                safeRemove(getLocal(), API_KEY_KEY);
                safeSet(getSession(), API_KEY_KEY, k);
            }
            if (state.connection.rememberKey !== !!remember) api.set({ connection: { rememberKey: !!remember } });
        },

        clearApiKey() {
            memoryKey = null;
            safeRemove(getLocal(), API_KEY_KEY);
            safeRemove(getSession(), API_KEY_KEY);
        },
    };
    return api;
}

/** The app-wide store (contract §17). */
export const store = createStore();

/** @returns {string|null} the Octopus API key from memory, this tab, or (if remembered) this device */
export function getApiKey() { return store.getApiKey(); }

/**
 * Keep the key for this tab, or on this device when `remember` is true.
 * @param {string} key
 * @param {boolean} remember
 */
export function setApiKey(key, remember) { store.setApiKey(key, remember); }

/** Forget the key everywhere. */
export function clearApiKey() { store.clearApiKey(); }
