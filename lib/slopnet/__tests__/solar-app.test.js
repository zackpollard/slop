/*
 * solar-app — the UI foundation's DOM-free logic, in node:
 *   - app.js: hash router helpers, stableKey, and the DataHub (memoising, cancellation on
 *     dataset/settings change, streamed verdict partials, load() sequencing and races) driven
 *     with a scripted fake engine and the real store;
 *   - ui.js: the contract formatters (fmt), account normalisation, and the connect card's
 *     progress steps checked against what the real dataset.js demo path actually reports;
 *   - charts.js: niceScale (incl. the inputs that used to loop forever) and the label layout
 *     for band/marker labels above a plot.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseHash, buildHash, stableKey, createDataHub } from '../../../projects/solar-calculator/js/app.js';
import { createStore } from '../../../projects/solar-calculator/js/store.js';
import { fmt, normalizeAccount, progressDetail, loadStepsFor, LOAD_STEPS } from '../../../projects/solar-calculator/js/ui.js';
import { niceScale, layoutTopLabels } from '../../../projects/solar-calculator/js/charts.js';
import { loadDataset } from '../../../projects/solar-calculator/js/dataset.js';
import { makeGuardedFetch } from '../../../projects/solar-calculator/js/worker.js';

class MemStorage {
    constructor() { this.map = new Map(); }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
}

const tick = () => new Promise(r => setTimeout(r, 0));
const abortErr = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

/*
 * Scripted EngineClient: every call is recorded; `auto` handlers answer immediately, anything
 * else stays pending until the test resolves it. cancel() behaves like engine.js (rejects at once).
 */
function fakeEngine(auto = {}) {
    const calls = [];
    let next = 1;
    return {
        calls,
        of: method => calls.filter(c => c.method === method),
        call(method, ...args) {
            let opts = null;
            const last = args[args.length - 1];
            if (last && typeof last === 'object' && typeof last.onProgress === 'function') opts = args.pop();
            let resolve, reject;
            const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            const rec = { method, args, opts, resolve, reject, cancelled: false, id: next };
            calls.push(rec);
            promise.id = next++;
            promise.cancel = () => { if (!rec.done) { rec.cancelled = true; rec.done = true; reject(abortErr()); } };
            rec.settle = v => { if (!rec.done) { rec.done = true; resolve(v); } };
            rec.fail = e => { if (!rec.done) { rec.done = true; reject(e); } };
            if (auto[method]) queueMicrotask(() => { try { rec.settle(auto[method](...args)); } catch (e) { rec.fail(e); } });
            return promise;
        },
    };
}

function hubWith(auto, { settings } = {}) {
    const st = createStore({ local: new MemStorage(), session: new MemStorage() });
    if (settings) st.set({ settings });
    const engine = fakeEngine(auto);
    const nav = vi.fn();
    const hub = createDataHub({ engine, store: st, onNavigate: nav });
    return { st, engine, nav, hub };
}

const SUMMARY = { id: 'ds-demo', days: 365, region: 'C', source: 'demo', from: '2025-10-01', to: '2026-09-30' };

/* ── router helpers ─────────────────────────────────────────────────────────── */

describe('router helpers', () => {
    it('parses the contract routes with params and falls back to the verdict', () => {
        expect(parseHash('#design?scenario=S01')).toEqual({ tab: 'design', params: { scenario: 'S01' }, known: true });
        expect(parseHash('#orientation?scenario=H1&metric=kwh')).toEqual({ tab: 'orientation', params: { scenario: 'H1', metric: 'kwh' }, known: true });
        expect(parseHash('#/Usage')).toMatchObject({ tab: 'usage', known: true });
        expect(parseHash('#data?mode=csv').tab).toBe('data');
        expect(parseHash('')).toEqual({ tab: 'verdict', params: {}, known: false });
        expect(parseHash('#nonsense')).toMatchObject({ tab: 'verdict', known: false });
    });

    it('builds hashes that round-trip, dropping empty params', () => {
        expect(buildHash('design', { scenario: 'S 01&x', empty: '', none: null })).toBe('#design?scenario=S+01%26x');
        expect(parseHash(buildHash('design', { scenario: 'S 01&x' })).params.scenario).toBe('S 01&x');
        expect(buildHash('verdict')).toBe('#verdict');
    });

    it('stableKey is order-independent and handles typed arrays, non-finite numbers and cycles', () => {
        expect(stableKey({ b: 1, a: [1, 2] })).toBe(stableKey({ a: [1, 2], b: 1 }));
        expect(stableKey({ a: new Float64Array([1, 2]) })).toBe(stableKey({ a: [1, 2] }));
        expect(stableKey({ x: Infinity })).not.toBe(stableKey({ x: null }));
        expect(stableKey({ x: undefined, f() {} })).toBe(stableKey({ x: null }));
        const c = { a: 1 }; c.self = c;
        expect(() => stableKey(c)).not.toThrow();
    });
});

/* ── DataHub ────────────────────────────────────────────────────────────────── */

describe('DataHub', () => {
    it('refuses work before a dataset is loaded', async () => {
        const { hub } = hubWith();
        expect(hub.status()).toBe('empty');
        await expect(hub.insights()).rejects.toMatchObject({ code: 'NO_DATASET', action: 'useDemo' });
        await expect(hub.verdict()).rejects.toMatchObject({ code: 'NO_DATASET' });
        await expect(hub.scenario({ id: 'S01' })).rejects.toMatchObject({ code: 'NO_DATASET' });
    });

    it('load(): loading → ready, store + connection written, base-load pushed, dataset event after ready, navigates', async () => {
        const { hub, st, engine, nav } = hubWith({ loadDataset: () => SUMMARY, setProjectBaseW: () => true }, { settings: { projectBaseW: 350 } });
        const statuses = [];
        hub.on('status', s => statuses.push(s));
        const seenOnDataset = [];
        hub.on('dataset', ds => seenOnDataset.push([ds?.id, hub.status()]));
        const progress = [];
        const out = await hub.load({ kind: 'demo', serverW: 650 }, { onProgress: p => progress.push(p) });
        expect(out).toBe(SUMMARY);
        expect(statuses).toEqual(['loading', 'ready']);
        expect(st.get().dataset).toBe(SUMMARY);
        expect(st.get().connection).toMatchObject({ kind: 'demo', demoServerW: 650 });
        expect(engine.of('setProjectBaseW').map(c => c.args[0])).toEqual([350]);
        // The base load reaches the worker before the summary is published.
        expect(engine.calls.map(c => c.method)).toEqual(['loadDataset', 'setProjectBaseW']);
        expect(seenOnDataset).toEqual([['ds-demo', 'ready']]);
        expect(nav).toHaveBeenCalledWith('verdict');
        await hub.load({ kind: 'demo' }, { navigate: false });
        expect(nav).toHaveBeenCalledTimes(1);
    });

    it('load() failure: error status with no data, previous data kept otherwise; abort restores', async () => {
        const boom = Object.assign(new Error('Octopus says that API key is not valid.'), { name: 'DataError', code: 'AUTH', action: 'checkKey' });
        const { hub, engine, st } = hubWith();
        const p1 = hub.load({ kind: 'octopus', apiKey: 'sk_live_x' });
        engine.of('loadDataset')[0].fail(boom);
        await expect(p1).rejects.toBe(boom);
        expect(hub.status()).toBe('error');

        const p2 = hub.load({ kind: 'demo' });
        engine.of('loadDataset')[1].settle(SUMMARY);
        await p2;
        const p3 = hub.load({ kind: 'octopus', apiKey: 'sk_live_x' });
        engine.of('loadDataset')[2].fail(boom);
        await expect(p3).rejects.toBe(boom);
        expect(hub.status()).toBe('ready');
        expect(st.get().dataset.id).toBe('ds-demo');
    });

    it('an externally cancelled load restores the status that matches the data on hand', async () => {
        const { hub, engine } = hubWith({ loadDataset: () => SUMMARY });
        await hub.load({ kind: 'demo' }, { navigate: false });
        const p = hub.load({ kind: 'octopus', apiKey: 'sk_live_k' }, { navigate: false });
        expect(hub.status()).toBe('loading');
        engine.of('loadDataset')[1].fail(abortErr());       // e.g. the worker cancelled it
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        expect(hub.status()).toBe('ready');                  // the demo is still loaded
        const { hub: h2, engine: e2 } = hubWith();
        const q = h2.load({ kind: 'demo' }, { navigate: false });
        e2.of('loadDataset')[0].fail(abortErr());
        await expect(q).rejects.toMatchObject({ name: 'AbortError' });
        expect(h2.status()).toBe('empty');
    });

    it('a second load() cancels the first; the first never touches the store or the status', async () => {
        const { hub, engine, st } = hubWith();
        const a = hub.load({ kind: 'demo' }, { navigate: false });
        const b = hub.load({ kind: 'octopus', apiKey: 'sk_live_k' }, { navigate: false });
        expect(engine.of('loadDataset')[0].cancelled).toBe(true);
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        expect(hub.status()).toBe('loading');
        engine.of('loadDataset')[1].settle({ ...SUMMARY, id: 'ds-octo', source: 'octopus' });
        await b;
        expect(st.get().dataset.id).toBe('ds-octo');
        expect(hub.status()).toBe('ready');
    });

    it('a load superseded while pushing the base load does not overwrite the newer one', async () => {
        const { hub, engine, st } = hubWith({}, { settings: { projectBaseW: 300 } });
        const a = hub.load({ kind: 'demo' }, { navigate: false });
        engine.of('loadDataset')[0].settle({ ...SUMMARY, id: 'A' });
        await tick();
        expect(engine.of('setProjectBaseW')).toHaveLength(1);       // A is now waiting on this
        const b = hub.load({ kind: 'demo', serverW: 800 }, { navigate: false });
        engine.of('setProjectBaseW')[0].settle(true);
        await expect(a).rejects.toMatchObject({ name: 'AbortError' });
        expect(st.get().dataset).toBe(null);
        expect(hub.status()).toBe('loading');
        engine.of('loadDataset')[1].settle({ ...SUMMARY, id: 'B' });
        await tick();
        engine.of('setProjectBaseW')[1].settle(true);
        await b;
        expect(st.get().dataset.id).toBe('B');
        expect(hub.status()).toBe('ready');
    });

    it('insights are memoised; a new dataset cancels in-flight work and drops memos', async () => {
        const { hub, engine } = hubWith({ loadDataset: () => SUMMARY });
        await hub.load({ kind: 'demo' }, { navigate: false });
        const i1 = hub.insights();
        const i2 = hub.insights();
        expect(engine.of('insights')).toHaveLength(1);
        // Callers get derived promises: neither can cancel the shared job.
        expect(i1.cancel).toBeUndefined();
        const sc = hub.scenario({ id: 'S01' });
        await hub.load({ kind: 'demo', serverW: 900 }, { navigate: false });
        expect(engine.of('insights')[0].cancelled).toBe(true);
        expect(engine.of('runScenario')[0].cancelled).toBe(true);
        await expect(i1).rejects.toMatchObject({ name: 'AbortError' });
        await expect(i2).rejects.toMatchObject({ name: 'AbortError' });
        await expect(sc).rejects.toMatchObject({ name: 'AbortError' });
        const i3 = hub.insights();
        expect(engine.of('insights')).toHaveLength(2);
        engine.of('insights')[1].settle({ baseLoad: { w: 480 } });
        expect(await i3).toEqual({ baseLoad: { w: 480 } });
        // memo kept after success
        expect(await hub.insights()).toEqual({ baseLoad: { w: 480 } });
        expect(engine.of('insights')).toHaveLength(2);
    });

    it('a failed insights call is not memoised', async () => {
        const { hub, engine } = hubWith({ loadDataset: () => SUMMARY });
        await hub.load({ kind: 'demo' }, { navigate: false });
        const p = hub.insights();
        engine.of('insights')[0].fail(new Error('nope'));
        await expect(p).rejects.toThrow('nope');
        hub.insights();
        expect(engine.of('insights')).toHaveLength(2);
    });

    it('scenario() merges the user finance under opts.finance and memoises by system + options', async () => {
        const { hub, engine, st } = hubWith({ loadDataset: () => SUMMARY, runScenario: s => ({ id: s.id }) },
            { settings: { finance: { discountRate: 0.05, years: 25 }, vatReturns: false } });
        await hub.load({ kind: 'demo' }, { navigate: false });
        await hub.scenario({ id: 'S01', arrays: [] }, { withBand: false, finance: { years: 10 } });
        const [sys, opts] = engine.of('runScenario')[0].args;
        expect(sys).toEqual({ id: 'S01', arrays: [] });
        expect(opts).toEqual({ withBand: false, finance: { discountRate: 0.05, years: 10, vatReturns: false } });
        await hub.scenario({ arrays: [], id: 'S01' }, { finance: { years: 10 }, withBand: false });   // same, keys reordered
        expect(engine.of('runScenario')).toHaveLength(1);
        await hub.scenario({ id: 'S01', arrays: [] }, { withBand: true });
        expect(engine.of('runScenario')).toHaveLength(2);
        // A settings change invalidates: the same call runs again.
        st.set({ settings: { finance: { discountRate: 0.03 } } });
        await hub.scenario({ id: 'S01', arrays: [] }, { withBand: true });
        expect(engine.of('runScenario')).toHaveLength(3);
        expect(engine.of('runScenario')[2].args[1].finance.discountRate).toBe(0.03);
    });

    it('settings changes push projectBaseW to the engine, cancel work and emit "settings"', async () => {
        const { hub, engine, st } = hubWith({ loadDataset: () => SUMMARY, setProjectBaseW: () => true });
        await hub.load({ kind: 'demo' }, { navigate: false });
        const onSettings = vi.fn();
        hub.on('settings', onSettings);
        const v = hub.verdict();
        st.set({ settings: { projectBaseW: 250 } });
        expect(engine.of('setProjectBaseW').map(c => c.args[0])).toEqual([250]);
        expect(engine.of('verdict')[0].cancelled).toBe(true);
        await expect(v).rejects.toMatchObject({ name: 'AbortError' });
        expect(onSettings).toHaveBeenCalledTimes(1);
        st.set({ settings: { projectBaseW: null } });
        expect(engine.of('setProjectBaseW').map(c => c.args[0])).toEqual([250, null]);
        // Unrelated store changes do nothing.
        st.set({ ui: { tab: 'usage' } });
        expect(onSettings).toHaveBeenCalledTimes(2);
    });

    it('verdict(): streams partials, replays the latest to a late caller, sends the user settings', async () => {
        const { hub, engine } = hubWith({ loadDataset: () => SUMMARY }, { settings: { maxPaybackYears: 8, spots: [{ id: 'roof' }] } });
        await hub.load({ kind: 'demo' }, { navigate: false });
        const a = [];
        const pa = hub.verdict({ onPartial: (s, v) => a.push([s, v.n]) });
        const call = engine.of('verdict')[0];
        expect(call.args[0]).toMatchObject({ maxPaybackYears: 8, spots: [{ id: 'roof' }], finance: { vatReturns: true } });
        call.opts.onProgress({ stage: 'usage', verdict: { n: 1 } });
        call.opts.onProgress({ stage: 'plugin', verdict: { n: 2 } });
        const b = [];
        const pb = hub.verdict({ onPartial: (s, v) => b.push([s, v.n]) });
        expect(engine.of('verdict')).toHaveLength(1);
        await tick();
        call.opts.onProgress({ stage: 'all', verdict: { n: 3 } });
        const onVerdict = vi.fn();
        hub.on('verdict', onVerdict);
        call.settle({ bestBuyId: 'S01' });
        expect(await pa).toEqual({ bestBuyId: 'S01' });
        expect(await pb).toEqual({ bestBuyId: 'S01' });
        expect(a).toEqual([['usage', 1], ['plugin', 2], ['all', 3]]);
        expect(b).toEqual([['plugin', 2], ['all', 3]]);
        expect(onVerdict).toHaveBeenCalledWith({ bestBuyId: 'S01' });
        // finished verdicts are memoised
        expect(await hub.verdict()).toEqual({ bestBuyId: 'S01' });
        expect(engine.of('verdict')).toHaveLength(1);
    });
});

/* ── ui.js formatters and connect-card helpers ──────────────────────────────── */

describe('fmt (contract §19)', () => {
    it('formats money, energy, power, percentages and years', () => {
        expect(fmt.gbp(1234.5)).toBe('£1,235');
        expect(fmt.gbp(1234.5, { dp: 2 })).toBe('£1,234.50');
        expect(fmt.gbp(-169)).toBe('−£169');
        expect(fmt.gbp(-0.004, { dp: 2 })).toBe('£0.00');
        expect(fmt.gbp(12_345, { compact: true })).toBe('£12.3k');
        expect(fmt.gbp(10_000, { compact: true })).toBe('£10k');
        expect(fmt.gbpFromP(16_450)).toBe('£165');
        expect(fmt.p(24.31)).toBe('24.3p');
        expect(fmt.p(-5.3)).toBe('−5.3p');
        expect(fmt.kwh(0.42)).toBe('0.42 kWh');
        expect(fmt.kwh(12.34)).toBe('12.3 kWh');
        expect(fmt.kwh(1234)).toBe('1,234 kWh');
        expect(fmt.w(500)).toBe('500 W');
        expect(fmt.w(12_345)).toBe('12.3 kW');
        expect(fmt.pct(42.4)).toBe('42%');
        expect(fmt.pct(4.25)).toBe('4.3%');
        expect(fmt.pct(5)).toBe('5%');
        expect(fmt.years(6.43)).toBe('6.4 yrs');
        expect(fmt.years(1)).toBe('1.0 yr');
        expect(fmt.years(null)).toBe('never');
        expect(fmt.years(Infinity)).toBe('never');
        expect(fmt.years(75)).toBe('50+ yrs');
        expect(fmt.num(12345.678, 1)).toBe('12,345.7');
        expect(fmt.range(120, 180, fmt.gbp)).toBe('£120–£180');
    });

    it('never prints NaN/Infinity/undefined', () => {
        for (const f of ['gbp', 'gbpFromP', 'p', 'kwh', 'w', 'pct', 'num', 'compass', 'date']) {
            for (const v of [NaN, Infinity, -Infinity, null, undefined, '12']) expect(fmt[f](v)).toBe('—');
        }
        expect(fmt.range(1, NaN)).toBe('—');
        expect(fmt.month('garbage')).toBe('—');
    });

    it('compass, months and dates', () => {
        expect(fmt.compass(202)).toBe('SSW');
        expect(fmt.compass(0)).toBe('N');
        expect(fmt.compass(359)).toBe('N');
        expect(fmt.compass(-90)).toBe('W');
        expect(fmt.compass(270)).toBe('W');
        expect(fmt.month('2025-10')).toBe('Oct 2025');
        expect(fmt.month(11)).toBe('Dec');
        // Europe/London: 23:30Z on 31 Mar 2026 is already 1 Apr locally (BST).
        expect(fmt.date(Date.UTC(2026, 2, 31, 23, 30))).toBe('1 Apr 2026');
        expect(fmt.date(Date.UTC(2026, 8, 5, 12), { year: false })).toBe('5 Sep');
    });
});

describe('connect-card helpers', () => {
    it('normalises account numbers the way Octopus expects', () => {
        expect(normalizeAccount(' a-1234 abcd ')).toEqual({ value: 'A-1234ABCD', valid: true });
        expect(normalizeAccount('')).toEqual({ value: null, valid: true });
        expect(normalizeAccount('A-123')).toEqual({ value: 'A-123', valid: false });
        expect(normalizeAccount('1234ABCD').valid).toBe(false);
    });

    it('progressDetail prefers the step detail, then counts', () => {
        expect(progressDetail({ step: 'usage', count: 17402, pct: 99.3 })).toBe('17,402 half-hours (99%)');
        expect(progressDetail({ step: 'weather', count: 365 })).toBe('365 days');
        expect(progressDetail({ step: 'prices', detail: 'AGILE-24-10-01' })).toBe('AGILE-24-10-01');
        expect(progressDetail(null)).toBe('');
    });

    it('the demo progress list has exactly the steps dataset.js reports for the demo', async () => {
        const seen = new Set();
        await loadDataset({ kind: 'demo', serverW: 500 }, { fetch: makeGuardedFetch(globalThis.fetch), onProgress: p => seen.add(p.step) });
        const listed = loadStepsFor('demo').map(s => s.key);
        // Before the fix the list held 'climatology' (never reported → stuck on "waiting") and
        // lacked 'usage' (reported → appended at the bottom as a raw key).
        expect(new Set(listed)).toEqual(seen);
        expect(loadStepsFor('demo').every(s => s.label && s.label !== s.key)).toBe(true);
    }, 30000);

    it('the Octopus progress list covers every contract step', () => {
        expect(loadStepsFor('octopus').map(s => s.key)).toEqual(LOAD_STEPS.map(s => s.key));
    });
});

/* ── charts.js pure helpers ─────────────────────────────────────────────────── */

describe('niceScale', () => {
    const isNice = step => { const m = step / 10 ** Math.floor(Math.log10(step) + 1e-12); return [1, 2, 5, 10].some(x => Math.abs(m - x) < 1e-9); };

    it('covers the data with evenly spaced 1/2/5×10ⁿ ticks', () => {
        for (const [lo, hi] of [[0, 1], [380, 920], [-5.3, 49.4], [0.0012, 0.0187], [-1000, 4000], [21, 25]]) {
            const s = niceScale(lo, hi, 5);
            expect(s.min).toBeLessThanOrEqual(lo);
            expect(s.max).toBeGreaterThanOrEqual(hi);
            expect(isNice(s.step)).toBe(true);
            expect(s.ticks[0]).toBeCloseTo(s.min, 9);
            expect(s.ticks.at(-1)).toBeCloseTo(s.max, 9);
            for (let i = 1; i < s.ticks.length; i++) expect(s.ticks[i] - s.ticks[i - 1]).toBeCloseTo(s.step, 9);
            expect(s.ticks.length).toBeGreaterThanOrEqual(2);
            expect(s.ticks.length).toBeLessThanOrEqual(12);
        }
    });

    it('handles flat, reversed and non-finite input', () => {
        expect(niceScale(0, 0)).toMatchObject({ min: 0, max: 1 });
        const flat = niceScale(-5, -5);
        expect(flat.min).toBeLessThan(-5);
        expect(flat.max).toBeGreaterThan(-5);
        expect(niceScale(10, 0)).toEqual(niceScale(0, 10));
        expect(niceScale(NaN, Infinity)).toEqual(niceScale(0, 1));
    });

    it('terminates where `v += step` cannot move (huge magnitude, sub-ulp step)', () => {
        const s = niceScale(1e15, 1e15 + 0.125, 5);    // step 0.05 < float spacing 0.125 at 1e15
        expect(s.ticks.length).toBeLessThanOrEqual(201);
        expect(s.ticks.every(Number.isFinite)).toBe(true);
        const t = niceScale(-1e308, 1e308);
        expect(t.ticks.every(Number.isFinite)).toBe(true);
    });
});

describe('layoutTopLabels (band and marker names above a plot)', () => {
    const w7 = s => s.length * 7;   // 7 px per character

    it('keeps separate labels on one row, centred and inside the chart', () => {
        const r = layoutTopLabels([{ text: '4–7pm', x: 200, kind: 'band' }, { text: 'you now', x: 60, kind: 'marker' }], w7, 400);
        expect(r.rows).toBe(1);
        const band = r.placed.find(p => p.kind === 'band');
        expect(band.x0).toBeCloseTo(200 - 17.5, 6);
        const edge = layoutTopLabels([{ text: 'all of an 800 W kit used at home', x: 395, kind: 'band' }], w7, 400);
        expect(edge.placed[0].x1).toBeLessThanOrEqual(398);
        expect(edge.placed[0].x0).toBeGreaterThanOrEqual(2);
    });

    it('moves a colliding label to a second row (375 px: "pays back" vs "new micro-inverter")', () => {
        const r = layoutTopLabels([
            { text: 'pays back · 3.8 yrs', x: 120, kind: 'marker' },
            { text: 'new micro-inverter', x: 190, kind: 'marker' },
        ], w7, 330);
        expect(r.rows).toBe(2);
        const [a, b] = r.placed;
        expect(a.row).not.toBe(b.row);
    });

    it('markers win over bands; a label with no free row is dropped, never overprinted', () => {
        const r = layoutTopLabels([
            { text: 'all of an 800 W kit used at home', x: 200, kind: 'band' },
            { text: 'you now', x: 190, kind: 'marker' },
            { text: 'payback', x: 210, kind: 'marker' },
        ], w7, 400);
        expect(r.placed.map(p => p.text).sort()).toEqual(['payback', 'you now']);
        for (const row of [0, 1]) {
            const boxes = r.placed.filter(p => p.row === row).sort((p, q) => p.x0 - q.x0);
            for (let i = 1; i < boxes.length; i++) expect(boxes[i].x0).toBeGreaterThanOrEqual(boxes[i - 1].x1);
        }
    });

    it('keeps row 1 clear of the y-axis title', () => {
        const r = layoutTopLabels([
            { text: 'aaaaaaaaaa', x: 40, kind: 'marker' },
            { text: 'bbbbbbbbbb', x: 50, kind: 'marker' },
        ], w7, 400, 120);
        expect(r.placed).toHaveLength(1);
        expect(r.rows).toBe(1);
    });

    it('no labels → no rows', () => {
        expect(layoutTopLabels([], w7, 300)).toEqual({ rows: 0, placed: [] });
    });
});
