/*
 * solar-store — projects/solar-calculator/js/store.js in node with stub Web Storage.
 *
 * Covers: defaults, deep merge semantics, subscriptions, persistence round trip (dataset never
 * persisted), sanitising stale/corrupt JSON, API-key placement (session vs remembered), and the
 * app surviving storage that throws on every access.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore, defaultState, STATE_KEY, API_KEY_KEY } from '../../../projects/solar-calculator/js/store.js';

class MemStorage {
    constructor() { this.map = new Map(); }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
    clear() { this.map.clear(); }
    get length() { return this.map.size; }
    key(i) { return [...this.map.keys()][i] ?? null; }
}

class ThrowingStorage {
    getItem() { throw new Error('SecurityError'); }
    setItem() { throw new Error('QuotaExceededError'); }
    removeItem() { throw new Error('SecurityError'); }
}

let local, session;
beforeEach(() => { local = new MemStorage(); session = new MemStorage(); });

describe('store defaults and updates', () => {
    it('starts from the contract defaults', () => {
        const s = createStore({ local, session });
        const st = s.get();
        expect(st.version).toBe(1);
        expect(st.connection.kind).toBe(null);
        expect(st.connection.rememberKey).toBe(false);
        expect(st.connection.demoServerW).toBe(500);
        expect(st.connection.priceBasis).toBe('mine');
        expect(st.dataset).toBe(null);
        expect(st.settings.maxPaybackYears).toBe(10);
        expect(st.settings.vatReturns).toBe(true);
        expect(st.scenarios).toEqual({ saved: [], pinned: [], activeId: null });
        expect(st.ui.tab).toBe('verdict');
        expect(st.ui.designMode).toBe('simple');
    });

    it('deep-merges plain objects and replaces arrays', () => {
        const s = createStore({ local, session });
        s.set({ ui: { tab: 'usage' } });
        expect(s.get().ui.designMode).toBe('simple');
        expect(s.get().ui.tab).toBe('usage');
        s.set({ scenarios: { pinned: ['a', 'b'] } });
        s.set({ scenarios: { pinned: ['c'] } });
        expect(s.get().scenarios.pinned).toEqual(['c']);
        expect(s.get().scenarios.saved).toEqual([]);
        s.set({ connection: { location: { postcode: 'SW1A 1AA' } } });
        expect(s.get().connection.location).toEqual({ postcode: 'SW1A 1AA', lat: null, lon: null });
    });

    it('ignores unknown top-level keys and non-object patches', () => {
        const s = createStore({ local, session });
        s.set({ nonsense: 1 });
        s.set(null);
        s.set('x');
        expect('nonsense' in s.get()).toBe(false);
    });

    it('refuses writes that would turn an object section into null/array/scalar', () => {
        const s = createStore({ local, session });
        const fn = vi.fn();
        s.subscribe(fn);
        s.set({ settings: null, ui: [] });
        s.set({ connection: 'octopus' });
        s.update('scenarios', () => null);
        s.update('settings', () => undefined);
        expect(fn).not.toHaveBeenCalled();
        expect(s.get().settings.maxPaybackYears).toBe(10);
        expect(s.get().scenarios.saved).toEqual([]);
        // the nullable dataset still accepts null and objects
        s.set({ dataset: { id: 'd' } });
        s.set({ dataset: null });
        expect(s.get().dataset).toBe(null);
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('update replaces a key with fn(current)', () => {
        const s = createStore({ local, session });
        s.update('scenarios', sc => ({ ...sc, saved: [...sc.saved, { id: 'x' }] }));
        expect(s.get().scenarios.saved).toEqual([{ id: 'x' }]);
        s.update('nope', () => 1);
        expect('nope' in s.get()).toBe(false);
    });

    it('notifies subscribers, filtered by key, and unsubscribes', () => {
        const s = createStore({ local, session });
        const all = vi.fn();
        const onlySettings = vi.fn();
        const offAll = s.subscribe(all);
        s.subscribe(onlySettings, ['settings']);
        s.set({ ui: { tab: 'compare' } });
        expect(all).toHaveBeenCalledTimes(1);
        expect(all.mock.calls[0][1]).toEqual(['ui']);
        expect(onlySettings).not.toHaveBeenCalled();
        s.set({ settings: { projectBaseW: 350 } });
        expect(onlySettings).toHaveBeenCalledTimes(1);
        expect(onlySettings.mock.calls[0][0].settings.projectBaseW).toBe(350);
        offAll();
        s.set({ ui: { tab: 'method' } });
        expect(all).toHaveBeenCalledTimes(2);
    });

    it('a throwing subscriber does not break the others', () => {
        const s = createStore({ local, session });
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const ok = vi.fn();
        s.subscribe(() => { throw new Error('boom'); });
        s.subscribe(ok);
        s.set({ ui: { tab: 'design' } });
        expect(ok).toHaveBeenCalledTimes(1);
        err.mockRestore();
    });
});

describe('persistence', () => {
    it('round-trips everything except the dataset', () => {
        const a = createStore({ local, session });
        a.set({ connection: { kind: 'demo', demoServerW: 650 }, settings: { finance: { discountRate: 0.05 } } });
        a.set({ dataset: { id: 'ds1', days: 365 } });
        a.set({ ui: { chartTables: { 'usage-profile': true } } });
        const raw = JSON.parse(local.getItem(STATE_KEY));
        expect(raw.dataset).toBeUndefined();
        expect(raw.connection.kind).toBe('demo');

        const b = createStore({ local, session });
        expect(b.get().connection.kind).toBe('demo');
        expect(b.get().connection.demoServerW).toBe(650);
        expect(b.get().settings.finance).toEqual({ discountRate: 0.05 });
        expect(b.get().ui.chartTables).toEqual({ 'usage-profile': true });
        expect(b.get().dataset).toBe(null);
    });

    it('keeps the picked meter (mpan) and a hand-picked region across a reload (they used to be dropped as unknown keys)', () => {
        const a = createStore({ local, session });
        expect(a.get().connection).toMatchObject({ mpan: null, region: null });
        a.set({ connection: { kind: 'octopus', mpan: '1900000000001', region: 'C' } });
        const b = createStore({ local, session });
        expect(b.get().connection).toMatchObject({ kind: 'octopus', mpan: '1900000000001', region: 'C' });
    });

    it('never writes the API key into the state blob', () => {
        const s = createStore({ local, session });
        s.setApiKey('sk_live_secret123', true);
        s.set({ connection: { accountNumber: 'A-1234ABCD' } });
        expect(local.getItem(STATE_KEY)).not.toContain('sk_live_secret123');
    });

    it('falls back to defaults on corrupt JSON or a different version', () => {
        local.setItem(STATE_KEY, '{not json');
        expect(createStore({ local, session }).get()).toEqual(defaultState());
        local.setItem(STATE_KEY, JSON.stringify({ version: 99, ui: { tab: 'usage' } }));
        expect(createStore({ local, session }).get().ui.tab).toBe('verdict');
    });

    it('sanitises wrongly-typed fields from stale JSON', () => {
        local.setItem(STATE_KEY, JSON.stringify({
            version: 1,
            settings: { spots: 'oops', maxPaybackYears: '12', finance: { years: 25 } },
            scenarios: { saved: null, pinned: ['s01'] },
            ui: { tab: 'orientation', extra: 1 },
            bogus: true,
        }));
        const st = createStore({ local, session }).get();
        expect(st.settings.spots).toEqual([]);
        expect(st.settings.maxPaybackYears).toBe(10);
        expect(st.settings.finance).toEqual({ years: 25 });
        expect(st.scenarios.saved).toEqual([]);
        expect(st.scenarios.pinned).toEqual(['s01']);
        expect(st.ui.tab).toBe('orientation');
        expect('extra' in st.ui).toBe(false);
        expect('bogus' in st).toBe(false);
    });

    it('reset returns to defaults but keeps the loaded dataset summary', () => {
        const s = createStore({ local, session });
        s.set({ dataset: { id: 'x' }, ui: { tab: 'usage' } });
        s.reset();
        expect(s.get().ui.tab).toBe('verdict');
        expect(s.get().dataset).toEqual({ id: 'x' });
    });
});

describe('API key', () => {
    it('keeps an unremembered key in sessionStorage only', () => {
        const s = createStore({ local, session });
        s.setApiKey('  sk_live_abc  ', false);
        expect(session.getItem(API_KEY_KEY)).toBe('sk_live_abc');
        expect(local.getItem(API_KEY_KEY)).toBe(null);
        expect(s.getApiKey()).toBe('sk_live_abc');
        expect(s.get().connection.rememberKey).toBe(false);
        // A new store in the same tab (page reload) finds it again.
        expect(createStore({ local, session }).getApiKey()).toBe('sk_live_abc');
        // A new tab (fresh session storage) does not.
        expect(createStore({ local, session: new MemStorage() }).getApiKey()).toBe(null);
    });

    it('moves a remembered key to localStorage and back when unticked', () => {
        const s = createStore({ local, session });
        s.setApiKey('sk_live_abc', true);
        expect(local.getItem(API_KEY_KEY)).toBe('sk_live_abc');
        expect(session.getItem(API_KEY_KEY)).toBe(null);
        expect(s.get().connection.rememberKey).toBe(true);
        expect(createStore({ local, session: new MemStorage() }).getApiKey()).toBe('sk_live_abc');
        s.setApiKey('sk_live_abc', false);
        expect(local.getItem(API_KEY_KEY)).toBe(null);
        expect(session.getItem(API_KEY_KEY)).toBe('sk_live_abc');
        expect(s.get().connection.rememberKey).toBe(false);
    });

    it('clearApiKey forgets it everywhere; an empty key clears too', () => {
        const s = createStore({ local, session });
        s.setApiKey('sk_live_abc', true);
        s.clearApiKey();
        expect(s.getApiKey()).toBe(null);
        expect(local.getItem(API_KEY_KEY)).toBe(null);
        s.setApiKey('sk_live_x', false);
        s.setApiKey('   ', false);
        expect(s.getApiKey()).toBe(null);
        expect(session.getItem(API_KEY_KEY)).toBe(null);
    });
});

describe('storage that throws', () => {
    it('works in memory when every storage call throws', () => {
        const s = createStore({ local: new ThrowingStorage(), session: new ThrowingStorage() });
        expect(s.get()).toEqual(defaultState());
        s.set({ ui: { tab: 'usage' } });
        expect(s.get().ui.tab).toBe('usage');
        expect(s.persistOk()).toBe(false);
        s.setApiKey('sk_live_mem', true);
        expect(s.getApiKey()).toBe('sk_live_mem');
        s.clearApiKey();
        expect(s.getApiKey()).toBe(null);
    });

    it('works when the storage getter itself throws (blocked site data)', () => {
        const thrower = () => { throw new Error('SecurityError: access denied'); };
        const s = createStore({ local: () => thrower(), session: () => thrower() });
        s.set({ ui: { tab: 'compare' } });
        s.setApiKey('sk_live_y', false);
        expect(s.getApiKey()).toBe('sk_live_y');
        expect(s.get().ui.tab).toBe('compare');
    });

    it('works with no storage at all', () => {
        const s = createStore({ local: null, session: null });
        s.set({ connection: { kind: 'manual' } });
        expect(s.get().connection.kind).toBe('manual');
        expect(s.persistOk()).toBe(false);
    });
});

describe('the module singleton uses the globals lazily', () => {
    let saved;
    beforeEach(() => {
        saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
        vi.resetModules();
    });
    afterEach(() => {
        if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
        else delete globalThis.localStorage;
        delete globalThis.sessionStorage;
    });

    it('reads persisted state from globalThis.localStorage', async () => {
        const g = new MemStorage();
        g.setItem(STATE_KEY, JSON.stringify({ version: 1, ui: { tab: 'method' } }));
        Object.defineProperty(globalThis, 'localStorage', { value: g, configurable: true, writable: true });
        globalThis.sessionStorage = new MemStorage();
        const mod = await import('../../../projects/solar-calculator/js/store.js');
        expect(mod.store.get().ui.tab).toBe('method');
        mod.setApiKey('sk_live_g', false);
        expect(mod.getApiKey()).toBe('sk_live_g');
        expect(globalThis.sessionStorage.getItem(API_KEY_KEY)).toBe('sk_live_g');
        mod.clearApiKey();
        expect(mod.getApiKey()).toBe(null);
    });

    it('survives a localStorage getter that throws', async () => {
        Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('SecurityError'); }, configurable: true });
        const mod = await import('../../../projects/solar-calculator/js/store.js');
        mod.store.set({ ui: { tab: 'usage' } });
        expect(mod.store.get().ui.tab).toBe('usage');
        expect(mod.store.persistOk()).toBe(false);
    });
});
