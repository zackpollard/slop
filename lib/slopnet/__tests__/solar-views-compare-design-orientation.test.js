/*
 * solar-views-compare-design-orientation — wave D1c-2: the Compare, Design and Orientation views on
 * the engine's and the shell's new pieces. Pure helpers are tested directly; the view methods that
 * carry the new behaviour run on Object.create(view) with stubbed ctx/render methods (no DOM):
 *   - design: dayLayers on typicalDay's stored-side and station flows (no dc double count, a
 *     station's own panels as live solar, no −1e-9 stacking hack), changeVia's recompute when an
 *     edit lands meanwhile, Compare's price overrides as "ready-made at your price";
 *   - orientation: the station-aware profile / monthly share / metric helpers, price overrides
 *     laid over the ready-made options, the flip checks via answerOrientation for any kit;
 *   - compare: the override signature the pick follows (same as app.js priceOverrides), which
 *     rows the Verdict doesn't rank, which rows can vary their panels, the station-inclusive 4–7pm
 *     share, and the pick shown at once by the rule while the Verdict re-runs at your prices.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { dayLayers } from '../../../projects/solar-calculator/js/views/design.js';
import designView from '../../../projects/solar-calculator/js/views/design.js';
import orientationView, { profileW, monthlyPeakShare, metricKey, withPriceOverrides, plainCopy } from '../../../projects/solar-calculator/js/views/orientation.js';
import compareView, { overrideSig, hasOwnOptions, canVaryPanels, rowModel, pickBestBuy } from '../../../projects/solar-calculator/js/views/compare.js';
import { priceOverrides, stableKey } from '../../../projects/solar-calculator/js/app.js';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';
import { stationToSystem, kitToSystem, findProduct } from '../../../projects/solar-calculator/js/kits.js';
import { sliceDemo, loadCatalog } from './fixtures/solar/b1-load.js';

const W = kwh => kwh * 2000;
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/* ── design: a day in the life ─────────────────────────────────────────────── */

describe('design dayLayers (typicalDay slots → average watts)', () => {
    it('a dc battery storing solar counts once — battIn, not battNet plus the pvAc − pvDirectAc guess', () => {
        // H1 at 10:00 on the demo midsummer day: 162 W reaches the cells through the AC side of
        // the profile (battChgAc) and the same solar shows as pvAc − pvDirectAc; 179 W is stored
        const s = { load: 0.302, pvAc: 0.388, pvDirectAc: 0.307, battNet: -0.081, imp: 0, exp: 0, clipped: 0, battIn: 0.0895, battOut: 0, gridChg: 0, upsPv: 0, upsPvWasted: 0, price: 20 };
        const L = dayLayers([s]);
        expect(L.chg[0]).toBeCloseTo(-W(0.0895), 9);
        expect(L.solar[0] + L.batt[0] + L.grid[0]).toBeCloseTo(L.use[0], 9);
        expect(L.solar[0]).toBeCloseTo(W(0.302), 9);   // the use is all solar: the battery only stores
    });

    it('a power station: its output to the servers comes from the bus balance, split into stored and its own panels live', () => {
        // C1 at 10:00: 604 W use, 433 W of plug-in solar of which 227 W exported, 34 W from storage
        const s = { load: 0.302, pvAc: 0.2165, pvDirectAc: 0.2165, battNet: 0.017, imp: 0, exp: 0.1135, clipped: 0, battIn: 0, battOut: 0.0185, gridChg: 0, upsPv: 0.2005, upsPvWasted: 0, price: 20 };
        const L = dayLayers([s], { ups: true });
        expect(L.batt[0]).toBeCloseTo(W(0.017), 9);
        expect(L.own[0]).toBeCloseTo(W(0.302 + 0.1135 - 0.2165) - W(0.017), 9);   // 398 − 34 W
        expect(L.solar[0]).toBeCloseTo(L.own[0] + W(0.302 - 0.199), 9);            // + the plug-in solar used at home
        expect(L.grid[0]).toBeCloseTo(0, 9);
        expect(L.solar[0] + L.batt[0] + L.grid[0]).toBeCloseTo(L.use[0], 9);
        // without ups the same slot is read as a battery: battNet only, no own-panel share
        expect(dayLayers([s]).own[0]).toBe(0);
    });

    it('a station on bypass (import above the use by its overhead) gives nothing: the grid meets the whole use', () => {
        const s = { load: 0.28, pvAc: 0, pvDirectAc: 0, battNet: -0.05, imp: 0.334, exp: 0, clipped: 0, battIn: 0.044, gridChg: 0.05, upsPv: 0, upsPvWasted: 0, price: 9 };
        const L = dayLayers([s], { ups: true });
        expect(L.own[0]).toBe(0);
        expect(L.batt[0]).toBe(0);
        expect(L.grid[0]).toBeCloseTo(W(0.28), 9);
        expect(L.chg[0]).toBeCloseTo(-W(0.044), 9);
    });

    it('lost = clipped + the station’s wasted solar; empty below-zero layers are plain zeros (charts.js stacks them below)', () => {
        const L = dayLayers([
            { load: 0.3, pvAc: 0.4, pvDirectAc: 0.4, battNet: 0, imp: 0, exp: 0.1, clipped: 0.02, upsPvWasted: 0.03, battIn: 0, price: 1 },
            { load: 0.3, pvAc: 0, pvDirectAc: 0, battNet: 0, imp: 0.3, exp: 0, clipped: 0, upsPvWasted: 0, battIn: 0, price: 1 },
        ]);
        expect(L.lost[0]).toBeCloseTo(-W(0.05), 9);
        expect(L.clipped[0]).toBeCloseTo(-W(0.02), 9);
        expect(L.waste[0]).toBeCloseTo(-W(0.03), 9);
        for (const k of ['exp', 'chg', 'lost']) expect(Math.abs(L[k][1])).toBe(0);
    });

    describe('on the engine’s typicalDay (demo June slice)', () => {
        let eng, cat;
        beforeAll(() => {
            cat = loadCatalog();
            eng = new SolarEngine(sliceDemo('2026-06-07T23:00:00Z', 28), cat);
        });
        const spot = { azimuth: 200, tilt: 40, kind: 'ground', shadingPct: 3, horizon: [] };

        it('a power station on its own panels: every half-hour balances, its panels show as live solar and as stored', () => {
            const sys = stationToSystem(findProduct(cat, 'ecoflow-delta-3-plus'), { catalog: cat, panels: { count: 2, spot } });
            const day = eng.typicalDay(sys, 'summer');
            const L = dayLayers(day.slots, { ups: true });
            for (let i = 0; i < L.use.length; i++) expect(close(L.use[i], L.solar[i] + L.batt[i] + L.grid[i], 1e-6)).toBe(true);
            expect(L.own.reduce((a, b) => a + b, 0)).toBeGreaterThan(500);       // W·half-hours of live own-panel solar
            expect(-L.chg.reduce((a, b) => a + b, 0)).toBeGreaterThan(500);      // and some of it stored
            // grid import = the grid's share of the use + grid charging, give or take the bypass overhead
            day.slots.forEach((s, i) => expect(W(s.imp) - L.grid[i] - W(s.gridChg)).toBeLessThan(8.5));
        });

        it('a plug-in kit: solar + grid = use, export below zero, nothing stored', () => {
            const sys = kitToSystem(findProduct(cat, 'cityplumbing-dmegc-2x515-hiflow'), { catalog: cat, spot });
            const L = dayLayers(eng.typicalDay(sys, 'summer').slots);
            for (let i = 0; i < L.use.length; i++) expect(close(L.use[i], L.solar[i] + L.grid[i], 1e-6)).toBe(true);
            expect(L.batt.every(v => v === 0) && L.chg.every(v => v === 0) && L.own.every(v => v === 0)).toBe(true);
            expect(Math.min(...L.exp)).toBeLessThan(0);
        });
    });
});

/* ── design: edits computed in the worker, price overrides ─────────────────── */

function designStub(draft) {
    const view = Object.create(designView);
    Object.assign(view, {
        alive: true, v: {}, editSeq: 0, running: false, timerPending: false,
        st: { draft },
        ctx: { ui: { toast: vi.fn() } },
        setStale: vi.fn(), renderEditor: vi.fn(),
    });
    view.applied = [];
    view.change = fn => { const next = fn(structuredClone(view.st.draft)); view.applied.push(next); view.st.draft = next; };
    return view;
}

describe('design changeVia (edits that need the worker)', () => {
    it('applies the worker’s result through change() when nothing else changed', async () => {
        const view = designStub({ id: 'd', n: 1 });
        const ok = await view.changeVia(async d => ({ ...d, battery: 'x' }));
        expect(ok).toBe(true);
        expect(view.applied).toEqual([{ id: 'd', n: 1, battery: 'x' }]);
    });

    it('computes again from the newer draft when another edit lands while the worker is busy', async () => {
        const view = designStub({ id: 'd', n: 1 });
        const seen = [];
        const ok = await view.changeVia(async d => {
            seen.push(d.n);
            if (seen.length === 1) view.st.draft = { id: 'd', n: 2 };   // the user typed meanwhile
            return { ...d, battery: 'x' };
        });
        expect(ok).toBe(true);
        expect(seen).toEqual([1, 2]);
        expect(view.applied).toEqual([{ id: 'd', n: 2, battery: 'x' }]);
    });

    it('a newer worker edit wins; a failed one says so and puts the controls back', async () => {
        const view = designStub({ id: 'd' });
        let release;
        const first = view.changeVia(() => new Promise(r => { release = () => r({ id: 'd', from: 'first' }); }));
        const second = view.changeVia(async d => ({ ...d, from: 'second' }));
        expect(await second).toBe(true);
        release();
        expect(await first).toBe(false);
        expect(view.applied.map(s => s.from)).toEqual(['second']);

        const bad = await view.changeVia(async () => { throw new Error('no such product'); }, { what: 'change the battery' });
        expect(bad).toBe(false);
        expect(view.ctx.ui.toast).toHaveBeenCalledWith('Couldn’t change the battery: no such product', { tone: 'bad' });
        expect(view.renderEditor).toHaveBeenCalled();
    });

    it('a Compare price override is the ready-made option at your price, not one of your saved options', () => {
        const saved = [
            { id: 'S05', name: 'City Plumbing 2×515 W', costs: [{ label: 'kit', gbp: 400, year: 0, kind: 'hardware' }], priceOverride: true, overrideOf: 'S05' },
            { id: 'my-1', name: 'Mine', costs: [] },
        ];
        const view = Object.create(designView);
        view.ctx = { store: { get: () => ({ scenarios: { saved } }) } };
        expect(view.savedList().map(s => s.id)).toEqual(['my-1']);
        expect(view.overrideFor('S05')?.costs[0].gbp).toBe(400);
        expect(view.overrideFor('my-1')).toBeNull();
        expect(view.overrideFor('S01')).toBeNull();
    });
});

/* ── orientation ───────────────────────────────────────────────────────────── */

describe('orientation helpers: a power station’s own panels', () => {
    it('profileW and monthlyPeakShare read the station’s own panels with station: true', () => {
        const profile = { pvAc: new Float64Array(48).fill(0.1), upsPv: new Float64Array(48).fill(0.05) };
        expect(profileW(profile)[0]).toBeCloseTo(200, 9);
        expect(profileW(profile, { station: true })[0]).toBeCloseTo(100, 9);
        const monthly = [
            { month0: 7, pvAcKwh: 100, peakPvAcKwh: 20, upsPvKwh: 50, peakUpsPvKwh: 5 },
            { month0: 7, pvAcKwh: 0, peakPvAcKwh: 0, upsPvKwh: 50, peakUpsPvKwh: 15 },
        ];
        expect(monthlyPeakShare(monthly)[7]).toBeCloseTo(20, 9);
        expect(monthlyPeakShare(monthly, { station: true })[7]).toBeCloseTo(20, 9);
        expect(monthlyPeakShare([{ month0: 0, pvAcKwh: 10, peakPvAcKwh: 1, upsPvKwh: 0, peakUpsPvKwh: 0 }], { station: true })[0]).toBeNaN();
    });

    it('metricKey: the 4–7pm share of a station’s own panels is the all-panels one; other metrics are unchanged', () => {
        const peak = { id: 'peak', key: 'peakSharePct', stationKey: 'peakShareAllPct' };
        expect(metricKey(peak, true)).toBe('peakShareAllPct');
        expect(metricKey(peak, false)).toBe('peakSharePct');
        expect(metricKey({ id: 'gbp', key: 'gbp' }, true)).toBe('gbp');
    });

    it('price overrides replace their ready-made option (first saved entry per id); a saved copy drops the markers', () => {
        const autos = [{ id: 'S01', name: 'a' }, { id: 'S05', name: 'b' }];
        const saved = [{ id: 'S05', name: 'b', priceOverride: true, overrideOf: 'S05', costs: [{ gbp: 1 }] }, { id: 'S05', priceOverride: true, costs: [{ gbp: 2 }] }, { id: 'S01', name: 'edited' }];
        const out = withPriceOverrides(autos, saved);
        expect(out[0]).toBe(autos[0]);                 // only overrides count, not a saved edit
        expect(out[1].costs[0].gbp).toBe(1);
        expect(plainCopy(out[1])).toEqual({ id: 'S05', name: 'b', costs: [{ gbp: 1 }] });
    });
});

describe('orientation flip checks (answerOrientation for any kit)', () => {
    function orientStub(sel, call) {
        const view = Object.create(orientationView);
        Object.assign(view, { sel, runKey: 'k1', token: 1, sweep: {}, flips: null, fillAnswer: vi.fn(),
            ctx: { engine: { call: vi.fn(call) }, data: { finance: () => ({ vatReturns: true }) } } });
        return view;
    }

    it('asks the engine for the kit on screen with the money settings, and keeps its answer', async () => {
        const a = { flips: [], checked: ['C1', 'C2'], best: { az: 210, tilt: 40 } };
        const view = orientStub({ id: 'H1', sys: { id: 'H1' }, station: false, arrayId: '*' }, () => Promise.resolve(a));
        const p = view.loadFlips(1);
        expect(view.flips).toEqual({ key: 'k1', state: 'pending', a: null });
        await p;
        expect(view.ctx.engine.call).toHaveBeenCalledWith('answerOrientation', { id: 'H1' }, { finance: { vatReturns: true }, tieBandPct: 3, flips: true });
        expect(view.flips).toEqual({ key: 'k1', state: 'done', a });
        // the answer merges it for the same kit and key
        view.starred = k => ({ bestGbp: { az: 200, tilt: 35, gbp: 1, kwh: 1 }, W90: null, S35: null, current: null, bestKwh: null }[k]);
        view.sweep = { cells: [] };
        expect(view.answer()).toMatchObject({ source: 'engine', checked: ['C1', 'C2'], best: { az: 210, tilt: 40 } });
    });

    it('no flip checks for a station’s own panels or one panel set of several; a cancel leaves nothing behind', async () => {
        const station = orientStub({ id: 'U3', sys: {}, station: true, arrayId: '*' }, () => Promise.resolve({}));
        await station.loadFlips(1);
        const one = orientStub({ id: 'S02', sys: {}, station: false, arrayId: 'a1' }, () => Promise.resolve({}));
        await one.loadFlips(1);
        expect(station.ctx.engine.call).not.toHaveBeenCalled();
        expect(one.ctx.engine.call).not.toHaveBeenCalled();
        expect(station.flips).toBeNull();

        const abort = orientStub({ id: 'S05', sys: {}, station: false, arrayId: '*' }, () => Promise.reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })));
        await abort.loadFlips(1);
        expect(abort.flips).toBeNull();
        const fail = orientStub({ id: 'S05', sys: {}, station: false, arrayId: '*' }, () => Promise.reject(new Error('boom')));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await fail.loadFlips(1);
        warn.mockRestore();
        expect(fail.flips.state).toBe('failed');
    });
});

/* ── compare ───────────────────────────────────────────────────────────────── */

describe('compare: your prices and the Verdict', () => {
    const ov = (id, gbp, extra = {}) => ({ id, priceOverride: true, overrideOf: id, costs: [{ label: 'x', gbp, year: 0, kind: 'hardware' }], ...extra });

    it('overrideSig changes exactly when the overrides the Verdict receives (app.js priceOverrides) change', () => {
        const cases = [
            [],
            [ov('S05', 400)],
            [ov('S05', 400), { id: 'my-1', costs: [] }],          // a saved option of your own: no override
            [{ id: 'S05', costs: [] }, ov('S05', 400)],            // the first entry per id wins: an edit, not a price
            [ov('S05', 300)],
            [ov('S05', 400), ov('S01', 500)],
        ];
        for (const a of cases) {
            for (const b of cases) {
                expect(overrideSig(a) === overrideSig(b)).toBe(stableKey(priceOverrides(a)) === stableKey(priceOverrides(b)));
            }
        }
    });

    it('only saved options of your own (or saved edits) make Compare pick by itself — price overrides reach the Verdict', () => {
        expect(hasOwnOptions([{ kind: 'auto' }, { kind: 'price' }])).toBe(false);
        expect(hasOwnOptions([{ kind: 'auto' }, { kind: 'saved' }])).toBe(true);
        expect(hasOwnOptions([{ kind: 'edited' }])).toBe(true);
    });

    it('More panels? takes a kit beside a power station (the engine prices the station in) but not two kits or a staged plan', () => {
        const row = (o) => ({ ready: true, legal: 'ok', hasBattery: false, coupling: null, sys: { arrays: [{}] }, ...o });
        expect(canVaryPanels(row({ route: 'plugin', coupling: 'ups', hasBattery: true, legal: 'check' }))).toBe(true);   // C1
        expect(canVaryPanels(row({ route: 'ups', coupling: 'ups', hasBattery: true, sys: { arrays: [] } }))).toBe(true);  // U2: its own inputs
        expect(canVaryPanels(row({ route: 'whatif', legal: 'whatif' }))).toBe(false);                                     // W3 / W2
        expect(canVaryPanels(row({ route: 'hardwired', coupling: 'ac', hasBattery: true, sys: { arrays: [] } }))).toBe(false); // battery only
        expect(canVaryPanels(row({ legal: 'reference' }))).toBe(false);
        expect(canVaryPanels(row({ ready: false }))).toBe(false);
    });

    it('the 4–7pm share counts a power station’s own panels (peakGenShareAllPct), else the grid-tied share', () => {
        const entry = { sys: { id: 'U3', route: 'ups', costs: [] }, kind: 'auto' };
        const res = h => ({ headline: { capexGbp: 1, savingsGbp: 1, ...h }, typical: { annual: {} }, rules: { legal: 'ok', errors: [], warnings: [] }, finance: {} });
        expect(rowModel(entry, res({ peakGenSharePct: 0, peakGenShareAllPct: 16.3 })).peakShare).toBeCloseTo(16.3, 9);
        expect(rowModel(entry, res({ peakGenSharePct: 12 })).peakShare).toBe(12);
    });

    describe('the pick while the Verdict re-runs at your prices', () => {
        const rowsFor = () => [
            { id: 'A', ready: true, legal: 'ok', errors: 0, onSale: true, payback: 3, npv10: 1000, capex: 400, hasBattery: false, route: 'plugin', kind: 'auto' },
            { id: 'B', ready: true, legal: 'ok', errors: 0, onSale: true, payback: 4, npv10: 700, capex: 600, hasBattery: false, route: 'plugin', kind: 'price' },
        ];
        function compareStub(saved) {
            const view = Object.create(compareView);
            let resolveVerdict;
            const store = { saved };
            Object.assign(view, {
                token: 1,
                v: { rows: rowsFor(), byId: null, final: true, pick: null },
                applyPick: vi.fn(),
                settings: () => ({ sig: 'set', maxPayback: 10 }),
                ctx: {
                    store: { get: () => ({ scenarios: { saved: store.saved } }) },
                    data: {
                        summary: () => ({ id: 'ds' }),
                        verdict: vi.fn(() => new Promise(r => { resolveVerdict = r; })),
                    },
                },
            });
            view.v.byId = new Map(view.v.rows.map(r => [r.id, r]));
            view.store = store;
            view.answer = v => resolveVerdict(v);
            return view;
        }
        const tick = () => new Promise(r => setTimeout(r, 0));

        it('first time: pending until the Verdict answers', async () => {
            const view = compareStub([]);
            view.requestPick(1);
            expect(view.v.pick.source).toBe('pending');
            view.answer({ bestBuyId: 'A', stepUp: null });
            await tick();
            expect(view.v.pick).toMatchObject({ id: 'A', source: 'verdict' });
            expect(view.applyPick).toHaveBeenCalledTimes(1);
            clearTimeout(view.v.pickTimer);
        });

        it('a new price: the same rule picks at once (podium redrawn), then the Verdict confirms without a second redraw', async () => {
            const view = compareStub([]);
            view.requestPick(1);
            view.answer({ bestBuyId: 'A', stepUp: null });
            await tick();
            view.applyPick.mockClear();
            view.store.saved = [ov('B', 100)];
            view.v.rows[1].capex = 100;
            view.v.rows[1].npv10 = 1200;
            view.requestPick(1);
            expect(view.v.pick).toMatchObject({ id: pickBestBuy(view.v.rows, 10).best, source: 'rule' });
            expect(view.v.pick.id).toBe('B');
            expect(view.applyPick).toHaveBeenCalledTimes(1);
            expect(view.ctx.data.verdict).toHaveBeenCalledTimes(2);
            view.answer({ bestBuyId: 'B', stepUp: null });
            await tick();
            expect(view.v.pick).toMatchObject({ id: 'B', source: 'verdict' });
            expect(view.applyPick).toHaveBeenCalledTimes(1);
            // and when the Verdict disagrees with the rule, its pick wins and is drawn
            view.store.saved = [ov('B', 150)];
            view.requestPick(1);
            view.answer({ bestBuyId: 'A', stepUp: null });
            await tick();
            expect(view.v.pick).toMatchObject({ id: 'A', source: 'verdict' });
            expect(view.applyPick).toHaveBeenCalledTimes(3);
            clearTimeout(view.v.pickTimer);
        });

        it('the same prices again reuse the Verdict’s pick without asking', async () => {
            const view = compareStub([ov('B', 100)]);
            view.requestPick(1);
            view.answer({ bestBuyId: 'B', stepUp: null });
            await tick();
            view.requestPick(1);
            expect(view.ctx.data.verdict).toHaveBeenCalledTimes(1);
            expect(view.v.pick.source).toBe('verdict');
            clearTimeout(view.v.pickTimer);
        });
    });
});
