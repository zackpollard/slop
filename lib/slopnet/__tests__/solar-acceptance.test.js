/*
 * End-to-end acceptance of the solar-calculator engine on the shipped data/demo.json (real London
 * Agile prices and SARAH-3 sunshine, 1 Oct 2025 – 30 Sep 2026), driven through SolarEngine:
 * engine critique T1–T8, the UX critique's scenario / rules / orientation / battery / UPS checks
 * (UPS figures as corrected by A3), the weather band, and the time budgets.
 *
 * Time budgets are asserted with 2× slack because vitest runs test files in parallel and CPU
 * contention would otherwise make them flaky; the measured values are printed for the report.
 */
import { describe, it, expect } from 'vitest';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';
import { kitToSystem, stationToSystem, findProduct } from '../../../projects/solar-calculator/js/kits.js';
import { normalizeSystem, capexGbp } from '../../../projects/solar-calculator/js/system.js';
import { project } from '../../../projects/solar-calculator/js/finance.js';
import { buildLocalIndex } from '../../../projects/solar-calculator/js/time.js';
import { loadCatalog, loadDemo, constantLoad, NOW } from './fixtures/solar/b1-load.js';
import { lcg, findNonFinite } from './fixtures/solar/a3-synth.js';

const SLACK = 2;
const cat = loadCatalog();
const demo = loadDemo({ serverW: 500 });
const engine = (ds = demo) => new SolarEngine(ds, cat, { nowMs: NOW });
const SOUTH = { id: 'ground', kind: 'ground', azimuth: 180, tilt: 35 };
const ms = (f) => { const a = performance.now(); const r = f(); return [r, performance.now() - a]; };
const timings = {};

describe('T1 prices and T2 constant 500 W (engine critique)', () => {
    it('T1: as-billed mean 19.993p, 497 negative slots, 16–19 mean 34.830 vs 17.873, DST days 50/46', () => {
        const e = engine();
        const { importPrice: p, local, n } = e.ds;
        expect(n).toBe(17520);
        let s = 0, neg = 0, pk = 0, pkn = 0, rest = 0;
        for (let t = 0; t < n; t++) {
            s += p[t];
            if (p[t] < 0) neg++;
            if (local.peak[t]) { pk += p[t]; pkn++; } else rest += p[t];
        }
        expect(Math.abs(s / n - 19.993)).toBeLessThan(0.001);
        expect(neg).toBe(497);
        expect(Math.abs(pk / pkn - 34.830)).toBeLessThan(0.001);
        expect(Math.abs(rest / (n - pkn) - 17.873)).toBeLessThan(0.001);
        expect(local.days.find((d) => d.date === '2025-10-26').count).toBe(50);
        expect(local.days.find((d) => d.date === '2026-03-29').count).toBe(46);
    });
    it('T2: £875.69 as billed, £833.99 ex VAT, £190.70 at 16–19 (21.78%), £761.21 forward, £1.7514 per W·yr', () => {
        const c500 = constantLoad(demo, 500);
        const e = engine(c500);
        const r = e.runScenario({ id: 'off', route: 'reference', loadAdjustW: -500 });
        expect(Math.abs(r.typical.totals.baselineBilledP / 100 - 875.69)).toBeLessThan(0.01);
        expect(Math.abs(r.typical.totals.savingsBilledP / 100 - 875.69)).toBeLessThan(0.01);
        expect(Math.abs(r.typical.totals.impSavFwdExcP / 100 - 761.21)).toBeLessThan(0.01);
        let exc = 0;
        for (let t = 0; t < c500.n; t++) exc += c500.load[t] * c500.importPriceExc[t];
        expect(Math.abs(exc / 100 - 833.99)).toBeLessThan(0.01);
        const bl = e.insights().baseLoad;
        expect(Math.abs(bl.w - 500)).toBeLessThan(1e-6);
        expect(Math.abs(bl.costPeakGbpYr - 190.70)).toBeLessThan(0.01);
        expect(Math.abs((100 * bl.costPeakGbpYr) / bl.costBilledGbpYr - 21.78)).toBeLessThan(0.01);
        expect(Math.abs(bl.gbpPer100W / 100 - 1.7514)).toBeLessThan(0.0001);
    });
});

describe('T3 PV chain and T4 forward valuation (2 kW always-on load, actual weather, as billed)', () => {
    const e = engine();
    e.setProjectBaseW(2000);
    const T3 = { shadingPct: 0, tempCoeffPct: -0.3, lowLightK: 0.007, mounting: 'open' };
    const INV = { acLimitW: 800, etaNom: 0.96, inputs: [{ maxAcW: 400 }, { maxAcW: 400 }], standbyW: 0 };
    const arr = (tilt, azimuth, input, wp = 400) => ({ ...T3, id: `a${input}`, count: 1, wp, tilt, azimuth, input });
    const sys = (arrays) => ({ id: 't3', route: 'hardwired', arrays, inverter: INV, costs: [] });
    const ROWS = [
        ['S45', [arr(45, 180, 0), arr(45, 180, 1)], 959.5, 161.45, 104.2],
        ['az210 t45', [arr(45, 210, 0), arr(45, 210, 1)], 926.3, 165.43, 159.9],
        ['SW45', [arr(45, 225, 0), arr(45, 225, 1)], 888.9, 163.90, 179.9],
        ['W45', [arr(45, 270, 0), arr(45, 270, 1)], 714.1, 143.49, 198.6],
        ['S90', [arr(90, 180, 0), arr(90, 180, 1)], 672.9, 111.89, 54.7],
        ['W90', [arr(90, 270, 0), arr(90, 270, 1)], 506.2, 113.95, 183.5],
        ['E90+W90', [arr(90, 90, 0), arr(90, 270, 1)], 513.1, 103.58, 106.9],
        ['S35 2×500', [arr(35, 180, 0, 500), arr(35, 180, 1, 500)], 1198.4, 203.37, null],
    ];
    for (const [name, arrays, kwh, gbp, peak] of ROWS) {
        it(`T3 ${name}: ${kwh} kWh, £${gbp}${peak == null ? '' : `, ${peak} kWh in 16–19`} (±0.2%, ±0.3 kWh)`, () => {
            const T = e.runScenario(sys(arrays), { withBand: false }).actual.totals;
            expect(Math.abs(T.pvAcKwh / kwh - 1)).toBeLessThan(0.002);
            expect(Math.abs(T.savingsBilledP / 100 / gbp - 1)).toBeLessThan(0.002);
            expect(T.exportKwh).toBe(0); // everything self-consumed
            if (peak != null) expect(Math.abs(T.peakPvAcKwh - peak)).toBeLessThan(0.3);
            if (name === 'S35 2×500') expect(Math.abs(T.clippedKwh - 7.8)).toBeLessThan(0.1);
            else expect(T.clippedKwh).toBe(0);
        });
    }
    it('T4: S45 forward ex VAT £144.20, ×1.05 £151.41 (±0.3%)', () => {
        const T = e.runScenario(sys(ROWS[0][1]), { withBand: false }).actual.totals;
        expect(Math.abs(T.impSavFwdExcP / 100 / 144.20 - 1)).toBeLessThan(0.003);
        expect(Math.abs((1.05 * T.impSavFwdExcP) / 100 / 151.41 - 1)).toBeLessThan(0.003);
    });
});

describe('T5 power station and the UX DELTA 3 Plus checks (as corrected by A3)', () => {
    const billed = (r) => r.typical.totals.savingsBilledP / 100;
    it('T5 (300 W, 2 kWh, 800 W charger, start full): night schedule £31.41 ± 0.50, optimal (N 81) £76.84 ± 2, no export', () => {
        const e = engine(constantLoad(demo, 300));
        const ups = (strategy) => ({ id: `t5-${strategy}`, route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 2, minSocPct: 10, strategy,
            ups: { dedicatedW: 300, chargeW: 800, outletMaxW: 1800 } } });
        const sch = e.runScenario(ups('schedule'), { withBand: false });
        const opt = e.runScenario(ups('optimal'), { withBand: false, dispatchOpts: { N: 81 } });
        expect(Math.abs(billed(sch) - 31.41)).toBeLessThan(0.5);
        expect(Math.abs(billed(opt) - 76.84)).toBeLessThan(2);
        for (const r of [sch, opt]) expect(r.typical.totals.exportKwh).toBe(0);
    });
    it('DELTA 3 Plus at 500 W (1 kWh, 500 W charger, P0 17 W): optimal £57.41 ± 3%, smart-plug cut ≤ threshold ≤ optimal, bypass-disabled penalty < −£100', () => {
        const e = engine(constantLoad(demo, 500));
        const d3 = (strategy, u = {}, b = {}) => ({ id: `d3-${strategy}-${u.bypass ?? 'auto'}`, route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 1, minSocPct: 10, strategy, ...b,
            ups: { dedicatedW: 500, chargeW: 500, fixedLossW: 17, bypassW: 8, outletMaxW: 1800, ...u } } });
        const plug = e.runScenario(d3('schedule', {}, { schedule: { chargeWindow: ['19:00', '16:00'] } }), { withBand: false });
        const thr = e.runScenario(d3('threshold'), { withBand: false });
        const opt = e.runScenario(d3('optimal'), { withBand: false, dispatchOpts: { N: 81 } });
        const online = e.runScenario(d3('optimal', { bypass: 'disabled', chargeW: 1500 }), { withBand: false, dispatchOpts: { N: 81 } });
        expect(Math.abs(billed(opt) / 57.41 - 1)).toBeLessThan(0.03);
        expect(billed(plug)).toBeLessThanOrEqual(5);
        expect(billed(plug)).toBeLessThanOrEqual(billed(thr));
        expect(billed(thr)).toBeLessThanOrEqual(billed(opt));
        expect(billed(online) - billed(opt)).toBeLessThan(-100);
        for (const r of [plug, thr, opt, online]) expect(r.typical.totals.exportKwh).toBe(0);
        console.log(`[acceptance] DELTA 3 Plus @500 W billed: smart-plug ${billed(plug).toFixed(2)} · threshold ${billed(thr).toFixed(2)} · optimal(N81) ${billed(opt).toFixed(2)} · online penalty ${(billed(online) - billed(opt)).toFixed(2)}`);
    });
    it('the catalog DELTA 3 Plus on the demo household: upsStrategies gives the same ordering and penalty', () => {
        const e = engine();
        const u = e.upsStrategies(stationToSystem('ecoflow-delta-3-plus', { catalog: cat }));
        expect(u.peakCutGbp).toBeLessThanOrEqual(u.realisticGbp);
        expect(u.realisticGbp).toBeLessThanOrEqual(u.bestCaseGbp);
        expect(u.onlinePenaltyGbp).toBeLessThan(-100);
        expect(u.onlineWarnings.join(' ')).not.toMatch(/cannot be sustained|no feasible/);
        console.log(`[acceptance] DELTA 3 Plus (catalog) year 1: realistic ${u.realisticGbp.toFixed(2)} · best ${u.bestCaseGbp.toFixed(2)} · smart-plug ${u.peakCutGbp.toFixed(2)} · online penalty ${u.onlinePenaltyGbp.toFixed(2)}`);
    });
});

describe('power-station realistic automation: the day-ahead plan (D1a)', () => {
    const e = engine();
    const list = e.autoScenarios();
    const by = (id) => list.find((s) => s.id === id);
    const variant = (s, b) => ({ ...s, id: `${s.id}~${b.strategy}~${b.capacityKwh ?? ''}`, battery: { ...s.battery, ...b } });
    it('U1, U2, U3, C1 and the DELTA 3 Plus at 500 W earn ≥ 0.85 × perfect hindsight (the old rule: 0.53, 0.78, 0.70, 0.44, 0.79)', () => {
        const out = [];
        for (const id of ['U1', 'U2', 'U3', 'C1']) {
            const thr = e.runScenario(variant(by(id), { strategy: 'threshold' }), { withBand: false }).battery.totalGbp;
            const opt = e.runScenario(variant(by(id), { strategy: 'optimal' }), { withBand: false }).battery.totalGbp;
            expect(thr, id).toBeGreaterThanOrEqual(0.85 * opt);
            out.push(`${id} ${thr.toFixed(2)}/${opt.toFixed(2)}`);
        }
        const e5 = engine(constantLoad(demo, 500));
        const d3 = (strategy) => ({ id: `d3a-${strategy}`, route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 1, minSocPct: 10, strategy,
            ups: { dedicatedW: 500, chargeW: 500, fixedLossW: 17, bypassW: 8, outletMaxW: 1800 } } });
        const billed = (r) => r.typical.totals.savingsBilledP / 100;
        const thr = billed(e5.runScenario(d3('threshold'), { withBand: false }));
        const opt = billed(e5.runScenario(d3('optimal'), { withBand: false, dispatchOpts: { N: 81 } }));
        expect(thr).toBeGreaterThanOrEqual(0.85 * opt);
        console.log(`[acceptance] station realistic/hindsight year 1 (battery £): ${out.join(' · ')} · DELTA 3 Plus @500 W billed ${thr.toFixed(2)}/${opt.toFixed(2)}`);
    }, 60000);
    it('value rises with capacity (U1 and U3, 0.5–10 kWh) and the battery-size curves never dip (the old rule fell above ~4 kWh)', () => {
        for (const id of ['U1', 'U3']) {
            const v = [0.5, 1, 2, 4, 7.5, 10].map((capacityKwh) => e.runScenario(variant(by(id), { strategy: 'threshold', capacityKwh }), { withBand: false, fidelity: 'proxy' }).headline.savingsGbp);
            for (let i = 1; i < v.length; i++) expect(v[i], `${id} step ${i}`).toBeGreaterThan(v[i - 1]);
            const curve = e.batterySizeCurve(by(id)).filter((p) => p.x > 0);
            for (let i = 1; i < curve.length; i++) expect(curve[i].savingsGbp, `${id} curve ${curve[i].label}`).toBeGreaterThanOrEqual(curve[i - 1].savingsGbp);
        }
    }, 60000);
});

describe('T6 base load, T7 annualisation, T8 finance', () => {
    it('T6: 500 W + up to 2 kW spikes in 20 random slots a day (and stray zeros) → base load 500 ± 1 W', () => {
        const rnd = lcg(42);
        const load = new Float64Array(demo.n).fill(0.25);
        for (const d of demo.local.days) {
            for (let k = 0; k < 20; k++) load[d.first + Math.floor(rnd() * d.count)] += rnd();
            load[d.first + Math.floor(rnd() * d.count)] = 0;
        }
        const e = engine({ ...demo, id: 't6', load, loadFilled: new Uint8Array(demo.n) });
        expect(Math.abs(e.insights().baseLoad.w - 500)).toBeLessThan(1);
    });
    it('T7 (a): the demo year duplicated to 730 days annualises to the 365-day figures (1e-9 relative)', () => {
        const dup = (a) => {
            if (!a) return a;
            const o = new a.constructor(a.length * 2);
            o.set(a);
            o.set(a, a.length);
            return o;
        };
        const map = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dup(v)]));
        const ds2 = { ...demo, id: `${demo.id}~x2`, n: demo.n * 2, load: dup(demo.load), loadFilled: dup(demo.loadFilled), importPrice: dup(demo.importPrice),
            importPriceExc: dup(demo.importPriceExc), importPriceFwdExc: dup(demo.importPriceFwdExc), exportPrices: map(demo.exportPrices),
            exportPricesFwd: map(demo.exportPricesFwd), ghi: dup(demo.ghi), dni: dup(demo.dni), dhi: dup(demo.dhi), tempC: dup(demo.tempC),
            windMs: dup(demo.windMs), wxSource: dup(demo.wxSource), local: buildLocalIndex(demo.start, demo.n * 2) };
        const r1 = { id: 'R1', route: 'reference', loadAdjustW: -100 };
        const a = engine().runScenario(r1, { withBand: false }).typical;
        const b = engine(ds2).runScenario(r1, { withBand: false }).typical;
        for (const k of ['savingsBilledP', 'impSavFwdExcP', 'loadKwh', 'importKwh', 'baselineBilledP']) {
            expect(Math.abs(b.annual[k] / a.annual[k] - 1), k).toBeLessThan(1e-9);
        }
        expect(b.totals.days).toBe(730);
        expect(b.annual.selfSufficiencyPct).toBe(a.annual.selfSufficiencyPct);
        // the copy is by UTC slot, and the second year changes its clocks a day earlier (25 Oct 2026,
        // 28 Mar 2027): on those days the 4–7pm window sits an hour apart, so only this ratio moves
        expect(Math.abs(b.annual.peakImportCutPct - a.annual.peakImportCutPct)).toBeLessThan(0.01);
    });
    it('T7 (b): for the exact 365-day window starting on the 1st, annual == totals (PV and battery runs)', () => {
        const e = engine();
        const dcb = { ...kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: SOUTH, dsSource: 'demo' }), route: 'hardwired',
            battery: { coupling: 'dc', capacityKwh: 2, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 800 } };
        const T = e.runScenario(dcb, { withBand: false }).typical;
        for (const k of ['pvAcKwh', 'exportKwh', 'importKwh', 'savingsBilledP', 'impSavFwdExcP', 'expIncFwdP', 'battOutKwh', 'standbyKwh']) {
            expect(Math.abs(T.annual[k] - T.totals[k]), k).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(T.totals[k])));
        }
        expect(T.annual.selfConsumptionPct).toBeCloseTo(T.totals.selfConsumptionPct, 9);
    });
    it('T8: finance hand cases (NPV £709.03, IRR 14.33%, paybacks 6.500/7.681 y; Sav_1 13 550p with the VAT schedule)', () => {
        const e = engine();
        const flat = (p, x = 0) => Array.from({ length: 12 }, () => ({ impSavFwdExcP: p / 12, expIncFwdP: x / 12 }));
        const f = project({ costs: [{ label: 'kit', gbp: 650 }], pvMonthly: flat(10000), hasMicro: false,
            opts: e.financeOptions({ years: 20, discountRate: 0.04, escalation: 0, vatSchedule: [{ untilMs: Infinity, rate: 0 }], pvAnnualDeg: 0 }) });
        expect(f.npvGbp).toBeCloseTo(709.03, 2);
        expect(Math.abs(f.irr - 0.14328)).toBeLessThan(0.0001);
        expect(f.paybackYears).toBeCloseTo(6.5, 3);
        expect(f.discountedPaybackYears).toBeCloseTo(7.681, 3);
        const m = Array.from({ length: 12 }, () => ({ impSavFwdExcP: 1000, expIncFwdP: 100 }));
        const v = project({ pvMonthly: m, hasMicro: false, opts: e.financeOptions({ escalation: 0, pvAnnualDeg: 0 }) });
        expect(v.years[1].savingsGbp * 100).toBeCloseTo(13550, 6);
        expect(v.years[2].savingsGbp * 100).toBeCloseTo(13800, 6);
    });
});

describe('UX critique acceptance: the default scenarios on demo, with bands', () => {
    const e = engine();
    let list;
    let results;
    it('autoScenarios + runScenario for every scenario (with the weather band)', () => {
        const t0 = performance.now();
        list = e.autoScenarios();
        timings.autoScenariosMs = performance.now() - t0;
        results = new Map(list.map((s) => [s.id, e.runScenario(s)]));
        timings.allScenariosMs = performance.now() - t0;
        expect(timings.allScenariosMs).toBeLessThan(25000 * SLACK);
    }, 120000);
    it('≥ 18 scenarios with unique ids; capex = Σ year-0 cost items', () => {
        expect(list.length).toBeGreaterThanOrEqual(18);
        expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
        for (const s of list) {
            const sum = s.costs.filter((c) => c.year === 0).reduce((a, c) => a + c.gbp, 0);
            expect(capexGbp(s), s.id).toBeCloseTo(sum, 9);
            expect(results.get(s.id).finance.capexGbp, s.id).toBeCloseTo(sum, 9);
        }
    });
    it('every non-what-if scenario has no rule errors; what-ifs are flagged', () => {
        for (const s of list) {
            const r = results.get(s.id).rules;
            if (s.route === 'whatif') expect(r.legal).toBe('whatif');
            else expect(r.errors.map((x) => x.code), s.id).toEqual([]);
        }
    });
    it('plug-in envelope: 800 W AC, ≤ 2000 Wp, ≤ 4 modules, no grid-tied battery', () => {
        for (const s of list.filter((x) => x.route === 'plugin')) {
            expect(s.inverter.acLimitW, s.id).toBe(800);
            expect(s.arrays.reduce((a, x) => a + x.count * x.wp, 0), s.id).toBeLessThanOrEqual(2000);
            expect(s.arrays.reduce((a, x) => a + x.count, 0), s.id).toBeLessThanOrEqual(4);
            expect(!s.battery || s.battery.coupling === 'ups', s.id).toBe(true);
        }
    });
    it('S02 only for a two-input kit; H4 has no panels', () => {
        const s02 = list.find((s) => s.id === 'S02');
        expect(cat.byId(s02.kitId).mppts).toBeGreaterThanOrEqual(2);
        for (const s of list.filter((x) => x.route === 'plugin' && cat.byId(x.kitId)?.singleInput)) {
            expect(new Set(s.arrays.map((a) => `${a.azimuth}|${a.tilt}`)).size, s.id).toBe(1);
        }
        expect(list.find((s) => s.id === 'H4').arrays).toEqual([]);
    });
    it('power stations never export; in C1 every exported kWh comes from the plug-in kit, none from the station', () => {
        for (const id of ['U1', 'U2', 'U3']) expect(results.get(id).typical.totals.exportKwh, id).toBe(0);
        for (const s of list.filter((x) => x.route === 'ups')) expect(results.get(s.id).typical.totals.exportKwh, s.id).toBe(0);
        const c1 = e.runScenario(list.find((s) => s.id === 'C1'), { withBand: false, includeSlots: true }).typical.slots;
        let over = 0;
        for (let t = 0; t < c1.exp.length; t++) over = Math.max(over, c1.exp[t] - c1.pvAc[t]);
        expect(over).toBeLessThanOrEqual(1e-9);
    });
    it('Octopus kits use Outgoing Prime on demo data, every other kit none', () => {
        for (const s of list.filter((x) => x.route === 'plugin' || x.route === 'hardwired')) {
            const octo = s.sourceIds.some((id) => cat.byId(id)?.octopus);
            expect(s.export.kind, s.id).toBe(octo && s.route === 'plugin' ? 'prime' : 'none');
        }
        expect(results.get('S01').typical.totals.expIncFwdP).toBeGreaterThan(0);
        expect(results.get('S05').typical.totals.expIncFwdP).toBe(0);
    });
    it('weather band: p10 ≤ p50 ≤ p90 everywhere; S01 last-12-months ≥ band p90 (sunnier than 2006–2025)', () => {
        for (const [id, r] of results) {
            if (!r.band) continue;
            expect(r.band.p10, id).toBeLessThanOrEqual(r.band.p50 + 1e-9);
            expect(r.band.p50, id).toBeLessThanOrEqual(r.band.p90 + 1e-9);
        }
        const s01 = results.get('S01');
        expect(s01.headline.actualGbp).toBeGreaterThanOrEqual(s01.band.p90);
        expect(e.weatherInfo().sunnierThanYears).toBe(20);
        expect(Math.abs(e.weatherInfo().pctVsAverage - 12)).toBeLessThan(1);
    });
    it('no NaN or Infinity in any result', () => {
        for (const [id, r] of results) {
            const bad = findNonFinite({ typical: r.typical.totals, actual: r.actual.totals, annual: r.typical.annual, band: r.band?.savingsGbp ?? [], battery: r.battery ?? {} });
            expect(bad, id).toEqual([]);
        }
    });
    it('reports the headline table', () => {
        const rows = list.map((s) => {
            const h = results.get(s.id).headline;
            return `${s.id.padEnd(32)} £${h.capexGbp.toFixed(0).padStart(5)}  saves £${h.savingsGbp.toFixed(1).padStart(6)} (£${(h.p10Gbp ?? 0).toFixed(0)}–${(h.p90Gbp ?? 0).toFixed(0)})  payback ${h.paybackYears == null ? 'never' : h.paybackYears.toFixed(1)}`;
        });
        console.log(`[acceptance] scenarios (typical year, year-1 £):\n${rows.join('\n')}`);
        expect(rows.length).toBe(list.length);
    });
});

describe('adversarial review: the default scenarios make sense for a UK homelab owner on Agile', () => {
    const e = engine();
    const list = e.autoScenarios();
    const by = (id) => list.find((s) => s.id === id);
    const withBattery = list.filter((s) => s.battery && s.battery.coupling !== 'ups');
    it('every product exists in the catalog and every product line is priced exactly as the catalog', () => {
        for (const s of list) {
            for (const id of [s.kitId, ...s.sourceIds].filter(Boolean)) expect(findProduct(cat, id), `${s.id}: ${id}`).not.toBe(null);
            if (s.route === 'reference') continue;
            // the first line is the product (or the bundle) at its catalog price; every later line is a known part,
            // the electrician, the free smart-plug placeholder or the second W3 kit
            const head = findProduct(cat, s.sourceIds[0]);
            expect(s.costs[0].gbp, s.id).toBe(head.priceGbp);
            for (const c of s.costs.slice(1)) {
                if (c.kind === 'install') { expect(c.gbp, s.id).toBe(cat.electrician.gbp); continue; }
                if (/^Smart plug/.test(c.label)) { expect(c.gbp).toBe(0); continue; }
                const part = [...new Set(s.sourceIds)].map((id) => findProduct(cat, id)).find((p) => c.label.includes(p.name) || c.label.endsWith(p.name));
                expect(part, `${s.id}: ${c.label}`).toBeTruthy();
                const n = Number((/^(\d+) × /.exec(c.label) ?? [0, 1])[1]);
                const per = part.includedPanels && part.kind === 'panel' ? part.includedPanels.count : 1;
                expect(c.gbp, `${s.id}: ${c.label}`).toBeCloseTo((part.priceGbp * n) / per, 2);
            }
        }
    });
    it('every hardwired battery pays an electrician; plug-in rows, power stations and future plug-in batteries never do', () => {
        const hasInstall = (s) => s.costs.some((c) => c.kind === 'install');
        for (const s of list) {
            if (s.route === 'hardwired') expect(hasInstall(s), s.id).toBe(true);
            if (s.route === 'plugin' || s.route === 'ups' || s.route === 'reference' || s.route === 'whatif') expect(hasInstall(s), s.id).toBe(false);
        }
        expect(withBattery.filter((s) => s.route === 'hardwired').map((s) => s.id)).toEqual(expect.arrayContaining(['H1', 'H2', 'H3', 'H4']));
        // panels on a ground frame are costed with a frame however they are sold (H1's bundle ships without mounting)
        for (const id of ['H1', 'H2', 'H3', 'U3', 'L-ecoflow-stream-ultra-x+4x500']) expect(by(id).costs.some((c) => /frame/i.test(c.label)), id).toBe(true);
    });
    it('Prime only for kits bought from Octopus, on Octopus or demo data; nobody gets it on CSV data', () => {
        for (const s of list) if (s.export.kind === 'prime') expect(findProduct(cat, s.kitId).octopus, s.id).toBe(true);
        const csv = engine({ ...demo, id: `${demo.id}~csv`, meta: { ...demo.meta, source: 'csv' } }).autoScenarios();
        expect(csv.filter((s) => s.export.kind !== 'none').map((s) => s.id)).toEqual([]);
    });
    it('power stations: panels within what the inputs can wire and carry, real charge rates, life = min(15, 2 × warranty)', () => {
        for (const s of list.filter((x) => x.battery?.coupling === 'ups')) {
            const st = [s.kitId, ...s.sourceIds].map((id) => findProduct(cat, id)).find((p) => p?.kind === 'power-station');
            const u = s.battery.ups;
            expect(u.pvArrays.reduce((a, x) => a + x.count, 0), s.id).toBeLessThanOrEqual(st.pvWireablePanels);
            for (const a of u.pvArrays) expect(a.count * a.wp, `${s.id} input ${a.input}`).toBeLessThanOrEqual(st.pvInputs[a.input].maxDcW);
            expect(u.chargeW, s.id).toBe(st.chargeW);
            expect(s.battery.lifeYears, s.id).toBe(st.warrantyYears ? Math.min(15, 2 * st.warrantyYears) : 10);
            expect(e.validate(s).warnings.map((w) => w.code), s.id).not.toContain('UPS_PV_WIRING');
        }
    });
    it('battery figures are on the headline basis: systemGbp = headline, the split sums to headline(B) − headline(B0)', () => {
        for (const s of [...withBattery, by('U1'), by('U3'), by('C1')]) {
            const r = e.runScenario(s, { withBand: false });
            const b0 = e.runScenario({ ...s, id: `${s.id}-nobatt`, battery: null }, { withBand: false });
            expect(Math.abs(r.battery.systemGbp - r.headline.savingsGbp), s.id).toBeLessThan(1e-9);
            expect(Math.abs(r.battery.totalGbp - (r.headline.savingsGbp - b0.headline.savingsGbp)), s.id).toBeLessThan(1e-6);
            const sp = r.battery.split;
            expect(Math.abs(sp.fromSolarGbp + sp.fromGridGbp + sp.standbyGbp - r.battery.totalGbp), s.id).toBeLessThan(0.01);
        }
        const u = e.upsStrategies(by('U1'));
        expect(Math.abs(u.realisticGbp - e.runScenario(by('U1'), { withBand: false }).headline.savingsGbp)).toBeLessThan(1e-9);
    }, 60000);
    it('determinism and the worker boundary: fresh engines agree to the bit; results clone with no functions', () => {
        const json = (v) => JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? Array.from(x) : x));
        const fns = (v, p = '') => (typeof v === 'function' ? [p] : v && typeof v === 'object' && !ArrayBuffer.isView(v)
            ? Object.keys(v).flatMap((k) => fns(v[k], `${p}.${k}`)) : []);
        const f = engine();
        expect(json(f.autoScenarios())).toBe(json(list));
        for (const id of ['S01', 'H1', 'U3', 'C1', 'W2']) {
            const a = e.runScenario(by(id), { withBand: false });
            expect(json(f.runScenario(by(id), { withBand: false })), id).toBe(json(a));
            expect(fns(a), id).toEqual([]);
            expect(() => structuredClone(a), id).not.toThrow();
        }
        for (const v of [e.upsStrategies(by('U1')), e.tornado(by('S01')), e.batterySizeCurve(by('H1')), e.panelCountCurve(by('H2')), e.typicalDay(by('H1'), 'winter'), e.summary]) {
            expect(fns(v)).toEqual([]);
            expect(() => structuredClone(v)).not.toThrow();
        }
        expect(() => structuredClone(cat)).not.toThrow(); // byId is non-enumerable
    }, 60000);
    it('UX export acceptance: on a constant 100 W load S01 earns export and S05 none; S05 after S01 equals S05 alone', () => {
        const c100 = constantLoad(demo, 100);
        const a = engine(c100);
        const s01 = a.runScenario(by('S01'), { withBand: false });
        const s05 = a.runScenario(by('S05'), { withBand: false });
        expect(s01.typical.totals.exportIncomeBilledP).toBeGreaterThan(0);
        expect(s05.typical.totals.exportIncomeBilledP).toBe(0);
        expect(engine(c100).runScenario(by('S05'), { withBand: false }).typical.totals).toEqual(s05.typical.totals);
    });
    it('UX growth acceptance: NPV(W2) = NPV(S01) + discounted stage-2 gain − £1,049.99/(1+r); an upgrade beyond the horizon changes nothing', () => {
        const fo = e.financeOptions({});
        const s01 = e.runScenario(by('S01'), { withBand: false }).finance;
        const w2 = e.runScenario(by('W2'), { withBand: false }).finance;
        expect(w2.years[1].savingsGbp).toBe(s01.years[1].savingsGbp);
        // stage 2 is W1's system with its battery one year younger: year y of W2 = W1's battery at age y − 1
        const w1 = e.runScenario(by('W1'), { withBand: false }).finance;
        expect(w2.years[2].battGbp).toBeGreaterThan(0);
        expect(w2.years[2].soh).toBeCloseTo(w1.years[1].soh, 9);
        let rhs = s01.npvGbp - 1049.99 / (1 + fo.discountRate);
        for (let y = 2; y <= fo.years; y++) rhs += (w2.years[y].savingsGbp - s01.years[y].savingsGbp) / (1 + fo.discountRate) ** y;
        expect(Math.abs(w2.npvGbp - rhs)).toBeLessThan(1);
        const far = e.runScenario({ ...by('W2'), id: 'W2-far', upgrade: { ...by('W2').upgrade, atYear: 40 } }, { withBand: false }).finance;
        expect(far.npvGbp).toBeCloseTo(s01.npvGbp, 9);
        expect(far.paybackYears).toBe(s01.paybackYears);
    });
});

describe('UX critique acceptance: rules through the engine', () => {
    const e = engine();
    const oct = () => kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: SOUTH, dsSource: 'demo' });
    const codes = (s) => e.validate(s).errors.map((x) => x.code);
    it('Octopus + a third panel → PLUGIN_KIT_ALTERED; City Plumbing split → PLUGIN_SINGLE_INPUT_MIXED; Octopus split OK; every fix clears', () => {
        const third = oct();
        third.arrays[0].count = 2;
        expect(codes(third)).toEqual(['PLUGIN_KIT_ALTERED']);
        const cp = kitToSystem('cityplumbing-dmegc-2x515-hiflow', { catalog: cat, spot: SOUTH });
        const split = { ...cp, arrays: [{ ...cp.arrays[0], count: 1 }, { ...cp.arrays[0], id: 'a1', count: 1, azimuth: 270 }] };
        expect(codes(split)).toEqual(['PLUGIN_SINGLE_INPUT_MIXED']);
        const osplit = oct();
        osplit.arrays[1].azimuth = 270;
        expect(codes(osplit)).toEqual([]);
        for (const s of [third, split]) {
            for (const err of e.validate(s).errors) for (const f of err.fixes) expect(codes(e.applyFix(s, f.action)), f.label).toEqual([]);
        }
    });
});

describe('UX critique acceptance: orientation (2000 W always-on via withBaseLoad, S01 kit)', () => {
    it('best az ∈ [170, 235]; W90/best £ ∈ [0.60, 0.80]; W90 p/kWh > best; W90 > 30% in 16–19; west does not pay', () => {
        const e = engine();
        e.setProjectBaseW(2000);
        const [a, t] = ms(() => e.answerOrientation(kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: SOUTH, dsSource: 'demo' })));
        timings.answerOrientationMs = t;
        expect(a.best.az).toBeGreaterThanOrEqual(170);
        expect(a.best.az).toBeLessThanOrEqual(235);
        const ratio = a.w90.gbp / a.best.gbp;
        expect(ratio).toBeGreaterThanOrEqual(0.6);
        expect(ratio).toBeLessThanOrEqual(0.8);
        expect(a.w90.pPerKwh).toBeGreaterThan(a.best.pPerKwh);
        expect(a.w90.peakSharePct).toBeGreaterThan(30);
        expect(a.westPays).toBe(false);
        expect(a.tie.azMin).toBeLessThanOrEqual(a.best.az);
        console.log(`[acceptance] orientation @2000 W: best ${a.compass} ${a.best.az}/${a.best.tilt} £${a.best.gbp.toFixed(2)} (${a.best.kwh.toFixed(0)} kWh, ${a.best.pPerKwh.toFixed(2)} p/kWh); W90 £${a.w90.gbp.toFixed(2)} (${a.w90.kwh.toFixed(0)} kWh, ${a.w90.pPerKwh.toFixed(2)} p/kWh, ${a.w90.peakSharePct.toFixed(1)}% 4–7pm) ratio ${ratio.toFixed(3)}; tie ${a.tie.azMin}–${a.tie.azMax}° × ${a.tie.tiltMin}–${a.tie.tiltMax}°; flips ${a.flips.map((f) => f.condition).join(',') || 'none'}`);
    }, 60000);
});

describe('UX critique acceptance: battery (2 kWh dc + 1.8 kWp S35, constant 500 W)', () => {
    const e = engine(constantLoad(demo, 500));
    const arrays = [{ count: 2, wp: 450, tilt: 35, azimuth: 180, input: 0 }, { count: 2, wp: 450, tilt: 35, azimuth: 180, input: 1 }];
    const sys = (battery) => normalizeSystem({ id: 'batt', route: 'hardwired', arrays, battery, costs: [{ label: 'kit', gbp: 2000 }] });
    const B = { coupling: 'dc', capacityKwh: 2, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 800 };
    it('self ≤ threshold ≤ optimal + £1, threshold ≥ 0.85·optimal; the split sums to the total within 1p', () => {
        const thr = e.runScenario(sys({ ...B, strategy: 'threshold' }), { withBand: false });
        const self = e.runScenario(sys({ ...B, strategy: 'self' }), { withBand: false });
        const b = thr.battery;
        expect(self.battery.systemGbp).toBeLessThanOrEqual(b.thresholdSystemGbp);
        expect(b.thresholdSystemGbp).toBeLessThanOrEqual(b.optimalSystemGbp + 1);
        expect(b.thresholdSystemGbp).toBeGreaterThanOrEqual(0.85 * b.optimalSystemGbp);
        const { fromSolarGbp, fromGridGbp, standbyGbp } = b.split;
        expect(Math.abs(fromSolarGbp + fromGridGbp + standbyGbp - b.totalGbp)).toBeLessThan(0.01);
        // billed, as the research benches report it
        expect(self.typical.totals.savingsBilledP).toBeLessThanOrEqual(thr.typical.totals.savingsBilledP);
        console.log(`[acceptance] battery year 1: PV only £${b.baseGbp.toFixed(2)}; self £${self.battery.systemGbp.toFixed(2)} ≤ threshold £${b.thresholdSystemGbp.toFixed(2)} ≤ optimal £${b.optimalSystemGbp.toFixed(2)} (ratio ${(b.thresholdSystemGbp / b.optimalSystemGbp).toFixed(3)}); split solar £${fromSolarGbp.toFixed(2)} grid £${fromGridGbp.toFixed(2)} standby £${standbyGbp.toFixed(2)}`);
    }, 60000);
    it('with acChargeW 0 the battery gets nothing from the grid', () => {
        const r = e.runScenario(sys({ ...B, acChargeW: 0 }), { withBand: false });
        expect(r.battery.split.fromGridGbp).toBe(0);
        expect(r.typical.totals.gridChargeKwh).toBe(0);
    });
});

describe('UX critique acceptance: base load and weather basis', () => {
    it('no-battery plug-in savings never fall as the always-on load rises; above 1 kW an 800 W kit exports ≤ 1%', () => {
        const e = engine();
        const kits = ['octopus-plugin-solar-2x460', 'cityplumbing-dmegc-2x515-hiflow'].map((id) => kitToSystem(id, { catalog: cat, spot: SOUTH, dsSource: 'demo' }));
        for (const c of e.baseLoadCurve(kits)) {
            for (let i = 1; i < c.points.length; i++) expect(c.points[i].savingsGbp, `${c.id} @${c.points[i].x}`).toBeGreaterThanOrEqual(c.points[i - 1].savingsGbp - 1e-9);
            for (const p of c.points.filter((q) => q.x >= 1000)) expect(p.exportKwh).toBeLessThanOrEqual(0.01 * p.pvKwh);
        }
    }, 60000);
    it('with every typical-year factor at 1, typical === actual bit for bit', () => {
        const e = engine({ ...demo, id: 'noclim', climatology: null });
        const r = e.runScenario(kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: SOUTH, dsSource: 'demo' }));
        expect(e.typicalFactors.every((v) => v === 1)).toBe(true);
        expect(r.typical.totals).toEqual(r.actual.totals);
        expect(r.typical.monthly).toEqual(r.actual.monthly);
        expect(r.typical.profile).toEqual(r.actual.profile);
    });
});

describe('time budgets (node, demo year)', () => {
    it('plug-in cold/warm, dc battery threshold/optimal, station, orientation sweep', () => {
        const e = engine();
        const s01 = kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: SOUTH, dsSource: 'demo', id: 'S01' });
        timings.pluginColdMs = ms(() => e.runScenario(s01))[1];
        timings.pluginWarmFinanceMs = ms(() => e.runScenario(s01, { finance: { discountRate: 0.05 } }))[1];
        timings.pluginWarmVariantMs = ms(() => e.runScenario({ ...s01, export: { kind: 'none' } }))[1];
        // let the JIT see the dispatch code once (a different battery), then time cold caches
        e.runScenario({ ...s01, id: 'jit', route: 'hardwired', battery: { coupling: 'dc', capacityKwh: 1, acChargeW: 500, strategy: 'optimal' } }, { withBand: false });
        const dc = (strategy) => ({ ...s01, id: `dc-${strategy}`, route: 'hardwired', battery: { coupling: 'dc', capacityKwh: 2, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 800, strategy } });
        timings.dcThresholdMs = ms(() => e.runScenario(dc('threshold')))[1];
        timings.dcOptimalMs = ms(() => e.runScenario(dc('optimal')))[1];
        timings.stationMs = ms(() => e.runScenario(stationToSystem('ecoflow-delta-3-plus', { catalog: cat })))[1];
        timings.sweepMs = ms(() => e.orientationSweep(s01, '*'))[1];
        console.log(`[acceptance] timings ms: ${JSON.stringify(Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])))}`);
        expect(timings.pluginWarmVariantMs).toBeLessThan(150 * SLACK);
        expect(timings.pluginWarmFinanceMs).toBeLessThan(150 * SLACK);
        expect(timings.dcOptimalMs).toBeLessThan(800 * SLACK);
        expect(timings.sweepMs).toBeLessThan(4000 * SLACK);
    }, 120000);
});
