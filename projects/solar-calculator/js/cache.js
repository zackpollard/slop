/*
 * cache.js — a tiny promise key/value cache over IndexedDB.
 *
 * Used for slow, public, immutable-ish downloads (Open-Meteo history, Octopus rate pages
 * for closed periods) so a reload doesn't refetch a year of data. It runs in the page,
 * in the module Web Worker and in node/vitest:
 *   - `globalThis.indexedDB` exists in windows and workers but not in node, and can be
 *     present yet unusable (Firefox private windows, Safari with storage blocked, quota).
 *   - so every operation falls back to an in-memory Map and NOTHING here ever throws or
 *     rejects: a cache miss is always an acceptable answer.
 * Values must be structured-clonable (plain objects, arrays, typed arrays).
 */

const STORE = 'kv';
const VERSION = 1;
/**
 * The in-memory mirror keeps at most this many entries (oldest written first out). Weather
 * responses are ~1–2 MB each, and reloading for several locations in one session would
 * otherwise pin all of them in the worker's memory even though IndexedDB holds them.
 */
const MEM_MAX = 48;

/**
 * Wrap an IDBRequest in a promise that resolves to `fallback` on any error.
 * @template T
 * @param {IDBRequest} req
 * @param {T} fallback
 * @returns {Promise<T>}
 */
function settle(req, fallback) {
    return new Promise(resolve => {
        try {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(fallback);
        } catch {
            resolve(fallback);
        }
    });
}

/**
 * Open (or create) a named cache.
 *
 * Entries may carry an expiry: `set(key, value, { ttlMs })`. Expired entries read as
 * `undefined` and are deleted lazily.
 *
 * @param {string} [name='solar-calculator']  IndexedDB database name
 * @param {{ indexedDB?: IDBFactory|null }} [opts]  inject a factory (tests) or null to force memory
 * @returns {{ get(key: string): Promise<any>, set(key: string, value: any, opts?: { ttlMs?: number }): Promise<boolean>,
 *            delete(key: string): Promise<boolean>, clear(): Promise<boolean>, kind(): Promise<'indexeddb'|'memory'> }}
 */
export function openCache(name = 'solar-calculator', opts = {}) {
    const mem = new Map();
    const remember = (key, entry) => {
        mem.delete(key); // re-insert so Map order tracks recency
        mem.set(key, entry);
        while (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
    };
    let factory = null;
    try {
        factory = 'indexedDB' in opts ? opts.indexedDB : globalThis.indexedDB;
    } catch {
        factory = null; // some sandboxes throw on mere access
    }

    /** @type {Promise<IDBDatabase|null>} */
    const dbp = !factory ? Promise.resolve(null) : new Promise(resolve => {
        try {
            const req = factory.open(name, VERSION);
            req.onupgradeneeded = () => {
                try { req.result.createObjectStore(STORE); } catch { /* already there */ }
            };
            req.onsuccess = () => {
                const db = req.result;
                // Another tab upgrading the schema must not be blocked by this connection.
                try { db.onversionchange = () => { try { db.close(); } catch { /* already closed */ } }; } catch { /* ignore */ }
                resolve(db);
            };
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
        } catch {
            resolve(null);
        }
    });

    /** Run `fn(store)` in a transaction; resolve `fallback` if anything goes wrong. */
    async function withStore(mode, fn, fallback) {
        const db = await dbp;
        if (!db) return undefined;
        try {
            const tx = db.transaction(STORE, mode);
            return await settle(fn(tx.objectStore(STORE)), fallback);
        } catch {
            return fallback;
        }
    }

    const fresh = (entry) => entry && typeof entry === 'object' && 'v' in entry
        && (entry.exp == null || entry.exp > Date.now());

    return {
        async get(key) {
            const m = mem.get(key);
            if (m !== undefined) {
                if (fresh(m)) return m.v;
                mem.delete(key);
            }
            const entry = await withStore('readonly', s => s.get(key), undefined);
            if (entry === undefined) return undefined;
            if (!fresh(entry)) {
                withStore('readwrite', s => s.delete(key), undefined);
                return undefined;
            }
            remember(key, entry);
            return entry.v;
        },
        async set(key, value, { ttlMs } = {}) {
            const entry = { v: value, exp: Number.isFinite(ttlMs) ? Date.now() + ttlMs : null };
            remember(key, entry);
            const ok = await withStore('readwrite', s => s.put(entry, key), false);
            return ok !== false;
        },
        async delete(key) {
            mem.delete(key);
            const ok = await withStore('readwrite', s => s.delete(key), false);
            return ok !== false;
        },
        async clear() {
            mem.clear();
            const ok = await withStore('readwrite', s => s.clear(), false);
            return ok !== false;
        },
        async kind() {
            return (await dbp) ? 'indexeddb' : 'memory';
        },
    };
}
