/*
 * solar-store — projects/solar-calculator/js/store.js in node with stub Web Storage.
 *
 * Covers: defaults, deep merge semantics, subscriptions, persistence round trip (dataset never
 * persisted), sanitising stale/corrupt JSON, API-key placement (session vs remembered), and the
 * app surviving storage that throws on every access.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStore, defaultState, mergeStates, STATE_KEY, API_KEY_KEY } from '../../../projects/solar-calculator/js/store.js';

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

describe('D2: two tabs share one blob without wiping each other', () => {
    // Tab B was opened before tab A saved anything; neither hears the other's events unless a test sends one.
    const tabs = () => {
        const shared = new MemStorage();
        const a = createStore({ local: shared, session: new MemStorage(), events: null });
        const b = createStore({ local: shared, session: new MemStorage(), events: null });
        return { shared, a, b, disk: () => JSON.parse(shared.getItem(STATE_KEY)) };
    };
    const mine = { id: 'my-1', name: 'Octopus 2×460 W on a west wall (mine)', costs: [{ label: 'Kit', gbp: 650, year: 0 }] };

    it('a stale tab switching views keeps the option another tab saved (it used to write saved=[] over it)', () => {
        const { shared, a, b, disk } = tabs();
        a.update('scenarios', sc => ({ ...sc, saved: [...sc.saved, mine] }));
        expect(disk().scenarios.saved).toEqual([mine]);
        const fn = vi.fn();
        b.subscribe(fn);
        b.set({ ui: { tab: 'usage' } });            // the old tab only navigates
        expect(disk().scenarios.saved).toEqual([mine]);
        expect(disk().ui.tab).toBe('usage');
        // the old tab now has it too, and tells its subscribers
        expect(b.get().scenarios.saved).toEqual([mine]);
        expect(fn.mock.calls.at(-1)[1]).toEqual(expect.arrayContaining(['ui', 'scenarios']));
        // a reload of the first tab still finds it
        expect(createStore({ local: shared, session: new MemStorage(), events: null }).get().scenarios.saved).toEqual([mine]);
    });

    it('a stale tab changing a setting keeps the other tab\'s saved options, price overrides and settings', () => {
        const { a, b, disk } = tabs();
        const override = { id: 'S03', priceOverride: true, overrideOf: 'S03', costs: [{ label: 'Kit', gbp: 499, year: 0 }] };
        a.update('scenarios', sc => ({ ...sc, saved: [mine, override] }));
        a.set({ settings: { maxPaybackYears: 12 } });
        b.set({ settings: { vatReturns: false } });
        expect(disk().scenarios.saved).toEqual([mine, override]);
        expect(disk().settings).toMatchObject({ maxPaybackYears: 12, vatReturns: false });
        expect(b.get().settings).toMatchObject({ maxPaybackYears: 12, vatReturns: false });
    });

    it('both tabs adding to the same list keep both entries; a removal in one tab sticks', () => {
        const { a, b, disk } = tabs();
        const x = { id: 'x', name: 'X' }, y = { id: 'y', name: 'Y' }, z = { id: 'z', name: 'Z' };
        a.update('scenarios', sc => ({ ...sc, saved: [z], pinned: ['S01'] }));
        b.sync();                                    // both tabs agree on [z]
        a.update('scenarios', sc => ({ ...sc, saved: [...sc.saved, x], pinned: [...sc.pinned, 'S02'] }));
        b.update('scenarios', sc => ({ ...sc, saved: sc.saved.filter(s => s.id !== 'z').concat(y), pinned: [...sc.pinned, 'H3'] }));
        expect(disk().scenarios.saved.map(s => s.id)).toEqual(['x', 'y']);
        expect(disk().scenarios.pinned).toEqual(['S01', 'S02', 'H3']);
        // an edit to the same entry in both: the later writer wins
        a.sync();
        a.update('scenarios', sc => ({ ...sc, saved: sc.saved.map(s => (s.id === 'x' ? { ...s, name: 'X from A' } : s)) }));
        b.update('scenarios', sc => ({ ...sc, saved: sc.saved.map(s => (s.id === 'x' ? { ...s, name: 'X from B' } : s)) }));
        expect(disk().scenarios.saved.find(s => s.id === 'x').name).toBe('X from B');
    });

    it('the storage event adopts the other tab\'s state at once, but each tab keeps its own open tab and scenario', () => {
        const shared = new MemStorage();
        const target = new EventTarget();
        const a = createStore({ local: shared, session: new MemStorage(), events: null });
        const b = createStore({ local: shared, session: new MemStorage(), events: target });
        b.set({ ui: { tab: 'compare' }, scenarios: { activeId: 'S05' } });
        a.sync();
        a.set({ ui: { tab: 'design' }, scenarios: { activeId: 'H3' }, settings: { projectBaseW: 350 } });
        a.update('scenarios', sc => ({ ...sc, saved: [mine] }));
        const fn = vi.fn();
        b.subscribe(fn, ['scenarios', 'settings']);
        const ev = Object.assign(new Event('storage'), { key: STATE_KEY, newValue: shared.getItem(STATE_KEY), storageArea: shared });
        target.dispatchEvent(ev);
        expect(b.get().scenarios.saved).toEqual([mine]);
        expect(b.get().settings.projectBaseW).toBe(350);
        expect(b.get().ui.tab).toBe('compare');
        expect(b.get().scenarios.activeId).toBe('S05');
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][1]).toEqual(expect.arrayContaining(['scenarios', 'settings']));
        // other keys, and the same blob again, are ignored
        target.dispatchEvent(Object.assign(new Event('storage'), { key: API_KEY_KEY, newValue: 'x', storageArea: shared }));
        target.dispatchEvent(ev);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('a page restored from the back/forward cache catches up with what it missed', () => {
        const shared = new MemStorage();
        const target = new EventTarget();
        const a = createStore({ local: shared, session: new MemStorage(), events: null });
        const b = createStore({ local: shared, session: new MemStorage(), events: target });
        a.update('scenarios', sc => ({ ...sc, pinned: ['W3'] }));
        target.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
        expect(b.get().scenarios.pinned).toEqual(['W3']);
    });

    it('a corrupt blob from elsewhere is ignored, not merged', () => {
        const { shared, b, disk } = tabs();
        b.set({ settings: { maxPaybackYears: 8 } });
        shared.setItem(STATE_KEY, '{oops');
        b.set({ ui: { tab: 'method' } });
        expect(disk()).toMatchObject({ settings: { maxPaybackYears: 8 }, ui: { tab: 'method' } });
    });

    it('reset() writes the defaults for every tab instead of merging the old blob back in', () => {
        const { a, b, disk } = tabs();
        a.update('scenarios', sc => ({ ...sc, saved: [mine] }));
        b.sync();
        b.reset();
        expect(disk().scenarios.saved).toEqual([]);
        a.sync();
        expect(a.get().scenarios.saved).toEqual([]);
    });
});

describe('D2: the dataset summary is replaced, never merged', () => {
    it('a field the new summary lacks does not survive from the old one', () => {
        const s = createStore({ local, session });
        s.set({ dataset: { id: 'a', engineUnavailable: true, coverage: { realPct: 100, synthetic: 'demo' } } });
        s.set({ dataset: { id: 'a', coverage: { realPct: 98 } } });
        expect(s.get().dataset).toEqual({ id: 'a', coverage: { realPct: 98 } });
    });
});

describe('mergeStates', () => {
    it('takes whichever side changed, merges objects by key and id lists by entry', () => {
        const base = { a: 1, o: { x: 1, y: 1 }, list: [{ id: 'p', v: 1 }], pins: ['A'] };
        const ours = { a: 2, o: { x: 2, y: 1 }, list: [{ id: 'p', v: 1 }, { id: 'q', v: 1 }], pins: ['A'] };
        const theirs = { a: 1, o: { x: 1, y: 3 }, list: [{ id: 'p', v: 9 }], pins: [] };
        expect(mergeStates(base, ours, theirs)).toEqual({ a: 2, o: { x: 2, y: 3 }, list: [{ id: 'p', v: 9 }, { id: 'q', v: 1 }], pins: [] });
        expect(mergeStates(base, base, theirs)).toBe(theirs);
        expect(mergeStates(base, ours, base)).toBe(ours);
    });
});
