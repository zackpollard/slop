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
 *
 * Several tabs share the one localStorage blob. A tab must never write a stale copy over what
 * another tab saved (an old tab switching views used to wipe options saved in a newer one), so:
 *  - every write is a read-modify-write: if another tab wrote since this one last synced, its
 *    copy is merged in first (three-way, against what this tab last saw: sections and list
 *    entries this tab didn't touch come from the other tab; saved options and pins merge by id);
 *  - a 'storage' event (another tab wrote) or a page coming back from the back/forward cache
 *    adopts the other tab's state at once and notifies subscribers of the sections that changed;
 *  - which tab is open (ui.tab) and the scenario on screen (scenarios.activeId) belong to each
 *    tab: they are written for the next fresh start, but never taken from another tab.
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
            // the import meter picked when an Octopus property has several (so a reload doesn't ask again)
            mpan: null,
            // the electricity region chosen by hand for a CSV / manual dataset ('A'–'P'), null = from the postcode
            region: null,
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

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const copy = v => JSON.parse(JSON.stringify(v));

/* A list whose entries can be matched across tabs: option objects with string ids, or id strings (pins). */
const idOf = x => (typeof x === 'string' ? `s:${x}` : x && typeof x === 'object' && typeof x.id === 'string' ? `o:${x.id}` : null);
const isIdList = a => Array.isArray(a) && a.every(x => idOf(x) != null);

/*
 * Merge the id-keyed lists of two tabs that both changed since `base`: the other tab's order and
 * entries, minus what this tab removed, with this tab's edits winning on an entry both changed, and
 * this tab's new entries appended.
 */
function mergeIdLists(base, ours, theirs) {
    const b = new Map((base || []).map(x => [idOf(x), x]));
    const o = new Map(ours.map(x => [idOf(x), x]));
    const out = [];
    const seen = new Set();
    for (const x of theirs) {
        const k = idOf(x);
        if (seen.has(k)) continue;
        seen.add(k);
        if (b.has(k) && !o.has(k)) continue;                                  // this tab removed it
        out.push(o.has(k) && (!b.has(k) || !sameJson(o.get(k), b.get(k))) ? o.get(k) : x);
    }
    for (const x of ours) {
        const k = idOf(x);
        if (seen.has(k) || b.has(k)) continue;                                // kept above, or the other tab removed it
        seen.add(k);
        out.push(x);
    }
    return out;
}

/**
 * Three-way merge of persisted state: `base` is what this tab last synced, `ours` its state now,
 * `theirs` what another tab has written since. Whatever only one side changed wins; plain objects
 * merge key by key and id lists entry by entry; otherwise this tab (the latest writer) wins.
 * @param {any} base @param {any} ours @param {any} theirs
 * @returns {any}
 */
export function mergeStates(base, ours, theirs) {
    if (sameJson(ours, base)) return theirs;
    if (sameJson(theirs, base) || sameJson(theirs, ours)) return ours;
    if (isPlain(ours) && isPlain(theirs)) {
        const out = {};
        for (const k of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
            if (!(k in ours)) { if (!(isPlain(base) && k in base)) out[k] = theirs[k]; continue; }
            if (!(k in theirs)) { if (!(isPlain(base) && k in base && sameJson(base[k], ours[k]))) out[k] = ours[k]; continue; }
            out[k] = mergeStates(isPlain(base) ? base[k] : undefined, ours[k], theirs[k]);
        }
        return out;
    }
    if (isIdList(ours) && isIdList(theirs)) return mergeIdLists(isIdList(base) ? base : [], ours, theirs);
    return ours;
}

/* Per-tab fields: written for the next fresh start, never adopted from another tab. */
function keepOwn(next, mine) {
    return {
        ...next,
        ui: { ...next.ui, tab: mine.ui.tab },
        scenarios: { ...next.scenarios, activeId: mine.scenarios.activeId },
    };
}

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
 * @param {{ local?: Storage|null|(() => Storage|null), session?: Storage|null|(() => Storage|null),
 *   events?: { addEventListener: Function }|null }} [opts]
 *   storages, or getters for them (default: the globals, resolved lazily on every access);
 *   events: where 'storage' and 'pageshow' arrive (default: window, when there is one)
 * @returns {{ get(): object, set(patch: object): void, update(key: string, fn: (v: any) => any): void,
 *   subscribe(fn: (state: object, changed: string[]) => void, keys?: string[]): () => void,
 *   reset(): void, sync(raw?: string|null): string[], persistOk(): boolean, getApiKey(): string|null,
 *   setApiKey(key: string, remember: boolean): void, clearApiKey(): void }}
 */
export function createStore({ local, session, events } = {}) {
    const resolve = (opt, name) => () => {
        try { return typeof opt === 'function' ? opt() : opt !== undefined ? opt : storageOf(name); } catch { return null; }
    };
    const getLocal = resolve(local, 'localStorage');
    const getSession = resolve(session, 'sessionStorage');

    let lastRaw = null;    // the blob as this tab last read or wrote it
    let base = null;       // …parsed: what this tab last agreed with the other tabs (the merge base)
    let state = load();
    let memoryKey = null;
    let lastPersistOk = true;
    const subs = new Set();

    /* The persisted part of a stored blob, sanitised, or null when it is missing or unreadable. */
    function parse(raw) {
        if (!raw) return null;
        try {
            const saved = JSON.parse(raw);
            if (!saved || saved.version !== 1) return null;
            const s = sanitize(defaultState(), saved);
            delete s.dataset;
            return s;
        } catch {
            return null;
        }
    }

    function load() {
        const raw = safeGet(getLocal(), STATE_KEY);
        const saved = parse(raw);
        if (saved) lastRaw = raw;
        // the merge base: what this tab started from (the defaults when nothing was stored)
        const { dataset, ...start } = saved ?? defaultState();
        base = copy(start);
        return { ...start, dataset: null };
    }

    const persisted = () => { const { dataset, ...rest } = state; return rest; };

    /*
     * Take in what another tab wrote (raw: the blob now in storage). Returns the top-level keys
     * that changed here. Nothing happens when the blob is the one this tab last saw.
     */
    function adopt(raw) {
        if (raw === lastRaw) return [];
        const theirs = parse(raw);
        lastRaw = raw;
        if (!theirs) return [];
        const mine = persisted();
        const merged = keepOwn(mergeStates(base, mine, theirs), mine);
        base = copy(theirs);   // a copy: the merged state may share objects with theirs
        const changed = Object.keys(merged).filter(k => k in state && !sameJson(merged[k], state[k]));
        if (changed.length) state = { ...state, ...Object.fromEntries(changed.map(k => [k, merged[k]])) };
        return changed;
    }

    /* Read-modify-write: fold in another tab's newer copy, then write ours. Returns keys adopted. */
    function persist() {
        const store = getLocal();
        const changed = adopt(safeGet(store, STATE_KEY) ?? lastRaw);
        let json;
        try { json = JSON.stringify(persisted()); } catch { lastPersistOk = false; return changed; }
        lastPersistOk = safeSet(store, STATE_KEY, json);
        if (lastPersistOk) { lastRaw = json; base = JSON.parse(json); }
        return changed;
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

        /**
         * Deep-merge a partial state; notifies subscribers of the top-level keys that changed (plus
         * any another tab changed, folded in by this write). The dataset summary is replaced, never
         * merged: a field the new summary doesn't have (engineUnavailable…) must not survive from the old.
         */
        set(patch) {
            if (!isPlain(patch)) return;
            // Unknown top-level keys are dropped so a typo can't grow the persisted blob forever, and
            // a section that is an object by default can't be replaced by null/array/scalar (every
            // view reads state.settings.x without a guard).
            const changed = Object.keys(patch).filter(k => k in state && patch[k] !== undefined && shapeOk(k, patch[k]));
            if (!changed.length) return;
            const { dataset, ...rest } = Object.fromEntries(changed.map(k => [k, patch[k]]));
            state = merge(state, rest);
            if (changed.includes('dataset')) state = { ...state, dataset };
            const adopted = changed.some(k => k !== 'dataset') ? persist() : [];
            emit([...new Set([...changed, ...adopted])]);
        },

        /** Replace one top-level key with fn(current) (no merge; ignored if it would change the section's shape). */
        update(key, fn) {
            if (!(key in state)) return;
            const next = fn(state[key]);
            if (next === undefined || !shapeOk(key, next)) return;
            state = { ...state, [key]: next };
            const adopted = key !== 'dataset' ? persist() : [];
            emit([...new Set([key, ...adopted])]);
        },

        /**
         * Take in what another tab saved (the 'storage' event does this; also a page restored from the
         * back/forward cache). raw: the blob now stored (default: read it). Notifies subscribers and
         * returns the keys that changed.
         * @param {string|null} [raw]
         * @returns {string[]}
         */
        sync(raw) {
            const changed = adopt(raw === undefined ? safeGet(getLocal(), STATE_KEY) : raw);
            emit(changed);
            return changed;
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
            // Every tab resets: write the defaults over whatever is stored, without merging it back in.
            try {
                const json = JSON.stringify(persisted());
                lastPersistOk = safeSet(getLocal(), STATE_KEY, json);
                if (lastPersistOk) { lastRaw = json; base = JSON.parse(json); }
            } catch { lastPersistOk = false; }
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

    // Another tab saved: take it in now, so this tab's next write builds on it. A page restored from
    // the back/forward cache missed those events while it was frozen.
    let target = events;
    if (target === undefined) target = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
    try {
        target?.addEventListener?.('storage', e => {
            if (e?.key !== STATE_KEY && e?.key !== null) return;          // key null: storage was cleared
            if (e.storageArea && e.storageArea !== getLocal()) return;
            api.sync(e.key === null ? null : e.newValue);
        });
        target?.addEventListener?.('pageshow', e => { if (e?.persisted) api.sync(); });
    } catch { /* no events: the read-modify-write in persist() still keeps tabs from clobbering each other */ }
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
