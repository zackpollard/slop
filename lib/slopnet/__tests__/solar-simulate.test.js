import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { simulate, annualise, toMonthlyFwd, diffMonthlyFwd } from '../../../projects/solar-calculator/js/simulate.js';
import { buildLocalIndex, SLOT_MS } from '../../../projects/solar-calculator/js/time.js';
import { demoDatasetFromJson } from '../../../projects/solar-calculator/js/dataset.js';
import { prepareGeometry, prepareSky, arrayDcW, dcByInput, inverterAc } from '../../../projects/solar-calculator/js/pv.js';
import { normalizeSystem } from '../../../projects/solar-calculator/js/system.js';
import { synthDataset, synthPv, synthUpsPv, findNonFinite, START_2025_10_01 } from './fixtures/solar/a3-synth.js';

const fx = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/solar/${name}`, import.meta.url)), 'utf8'));

const ds = synthDataset({ seed: 21, baseW: 450 });
const pv = synthPv(ds, { kWp: 0.92, seed: 8 });
const n = ds.n;
const KIT = (extra = {}) => ({
    id: 'kit', route: 'plugin', arrays: [{ count: 2, wp: 460 }], export: { kind: 'none' },
    inverter: { acLimitW: 800, etaNom: 0.96, inputs: [{ maxDcW: 1000, maxAcW: 400 }, { maxDcW: 1000, maxAcW: 400 }] }, ...extra,
});
const DCB = (extra = {}) => ({ coupling: 'dc', capacityKwh: 2, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 800, ...extra });

/** Same per-slot values as a function of (local month, hh): makes year 2 identical to year 1 month by month. */
const seasonal = (t, local) => ({
    load: 0.2 + 0.01 * local.month[t] + (local.hh[t] >= 34 && local.hh[t] < 44 ? 0.1 : 0),
    price: 12 + local.month[t] + (local.hh[t] >= 32 && local.hh[t] < 38 ? 18 : 0) + (local.hh[t] >= 24 && local.hh[t] < 28 ? -15 : 0),
});

describe('no-battery valuation', () => {
    it('canCurtail false: savings == Σ[min(L,pv)·p + max(0,pv−L)·x] exactly, nothing curtailed', () => {
        const r = simulate(ds, pv, KIT({ export: { kind: 'prime' } }), { includeSlots: true });
        let s = 0;
        const x = ds.exportPrices.prime;
        for (let t = 0; t < n; t++) s += Math.min(ds.load[t], pv.acKwh[t]) * ds.importPrice[t] + Math.max(0, pv.acKwh[t] - ds.load[t]) * x[t];
        expect(Math.abs(r.totals.savingsBilledP - s)).toBeLessThan(1e-6);
        expect(r.totals.curtailedKwh).toBe(0);
        expect(r.totals.pvDirectAcKwh).toBeCloseTo(r.totals.pvAcKwh, 9);
    });
    it('canCurtail true (inverter with a power limit): decision-basis savings never fall', () => {
        const a = simulate(ds, pv, KIT({ export: { kind: 'prime' } }));
        const b = simulate(ds, pv, KIT({ export: { kind: 'prime' }, canCurtail: true, inverter: { acLimitW: 800, supportsPowerLimit: true } }));
        const fwd = (r) => r.totals.impSavFwdExcP * 1.05 + r.totals.expIncFwdP;
        expect(fwd(b)).toBeGreaterThanOrEqual(fwd(a) - 1e-9);
        expect(b.totals.curtailedKwh).toBeGreaterThan(0);
        // canCurtail alone is not enough: the inverter must support a power limit
        const c = simulate(ds, pv, KIT({ export: { kind: 'prime' }, canCurtail: true }));
        expect(c.totals.curtailedKwh).toBe(0);
    });
    it('forward valuation: impSavFwdExcP = Σ(L − imp)·fwdExc and expIncFwdP = Σ exp·xFwd', () => {
        const r = simulate(ds, pv, KIT({ export: { kind: 'agile' } }), { includeSlots: true });
        let a = 0;
        let b = 0;
        for (let t = 0; t < n; t++) {
            a += (ds.load[t] - r.slots.imp[t]) * ds.importPriceFwdExc[t];
            b += r.slots.exp[t] * ds.exportPricesFwd.agile[t];
        }
        expect(r.totals.impSavFwdExcP).toBeCloseTo(a, 6);
        expect(r.totals.expIncFwdP).toBeCloseTo(b, 6);
        expect(r.totals.impSavFwdExcP).toBeLessThan(r.totals.savingsBilledP); // levy + VAT removed
    });
    it('export kind none pays nothing, prime pays; runs do not share state', () => {
        const s01 = simulate(ds, pv, KIT({ id: 'S01', export: { kind: 'prime' } }));
        const s05a = simulate(ds, pv, KIT({ id: 'S05', export: { kind: 'none' } }));
        const s05b = simulate(ds, pv, KIT({ id: 'S05', export: { kind: 'none' } }));
        expect(s01.totals.exportIncomeBilledP).toBeGreaterThan(0);
        expect(s05a.totals.exportIncomeBilledP).toBe(0);
        expect(s05a.totals.exportUnpaidKwh).toBeCloseTo(s05a.totals.exportKwh, 12);
        expect(JSON.stringify(s05a)).toBe(JSON.stringify(s05b));
    });
    it('missing export series warns and values export at 0', () => {
        const d2 = { ...ds, exportPrices: { ...ds.exportPrices, agile: null }, exportPricesFwd: { ...ds.exportPricesFwd, agile: null } };
        const r = simulate(d2, pv, KIT({ export: { kind: 'agile' } }));
        expect(r.warnings.join(' ')).toMatch(/No agile export prices/);
        expect(r.totals.exportIncomeBilledP).toBe(0);
    });
    it('"cut 100 W" reference (loadAdjustW −100) saves Σ 0.05·p', () => {
        const r = simulate(ds, null, { route: 'reference', loadAdjustW: -100 });
        let s = 0;
        for (let t = 0; t < n; t++) s += 0.05 * ds.importPrice[t];
        expect(r.totals.savingsBilledP).toBeCloseTo(s, 6);
    });
});

describe('battery attribution and standby', () => {
    it('a battery held at delta ≡ 0 with standby 0 gives Sav_batt = 0 (billed and forward)', () => {
        for (const coupling of ['dc', 'ac']) {
            const pvOnly = simulate(ds, pv, KIT({ export: { kind: 'prime' } }));
            const full = simulate(ds, pv, KIT({ export: { kind: 'prime' }, battery: DCB({ coupling, standbyW: 0 }) }), { dispatchOpts: { strategy: 'idle' } });
            expect(Math.abs(full.totals.savingsBilledP - pvOnly.totals.savingsBilledP)).toBeLessThan(1e-6);
            expect(Math.abs(full.totals.impSavFwdExcP - pvOnly.totals.impSavFwdExcP)).toBeLessThan(1e-6);
            const m = diffMonthlyFwd(toMonthlyFwd(full.monthly), toMonthlyFwd(pvOnly.monthly));
            for (const r of m) expect(Math.abs(r.impSavFwdExcP) + Math.abs(r.expIncFwdP)).toBeLessThan(1e-6);
        }
    });
    it('standby is counted exactly once (idle battery, 10 W)', () => {
        const full = simulate(ds, pv, KIT({ battery: DCB({ standbyW: 10 }) }), { dispatchOpts: { strategy: 'idle' } });
        let s = 0;
        for (let t = 0; t < n; t++) {
            const g = ds.load[t] + 0.005 - pv.acKwh[t];
            s += ds.load[t] * ds.importPrice[t] - Math.max(0, g) * ds.importPrice[t];
        }
        expect(full.totals.savingsBilledP).toBeCloseTo(s, 6);
        expect(full.totals.standbyKwh).toBeCloseTo(n * 0.005, 9);
        expect(full.totals.standbyCostFwdExcP).toBeGreaterThan(0);
    });
    it('a real battery adds savings, and the totals definitions hold', () => {
        const pvOnly = simulate(ds, pv, KIT());
        const full = simulate(ds, pv, KIT({ battery: DCB({ strategy: 'threshold' }) }), { includeSlots: true });
        expect(full.totals.savingsBilledP).toBeGreaterThan(pvOnly.totals.savingsBilledP);
        const T = full.totals;
        expect(T.pvAcKwh).toBeCloseTo(pvOnly.totals.pvAcKwh, 9); // dispatch-independent
        let lost = 0;
        let netImp = 0;
        for (let t = 0; t < n; t++) { lost += Math.min(full.slots.exp[t], full.slots.pvDirectAc[t]); netImp += full.slots.imp[t] - full.slots.gridChg[t]; }
        expect(T.selfConsumptionPct).toBeCloseTo(100 * (1 - lost / T.pvAcKwh), 9);
        expect(T.selfSufficiencyPct).toBeCloseTo(Math.max(0, Math.min(100, 100 * (1 - netImp / T.loadKwh))), 9);
        expect(T.battCycles).toBeCloseTo(T.battOutKwh / (full.dispatch.sMax - full.dispatch.sMin), 9);
        expect(findNonFinite(full)).toEqual([]);
    });
});

describe('annualisation per calendar month', () => {
    const y1 = synthDataset({ seed: 1, custom: seasonal });
    const y2 = synthDataset({ seed: 1, n: 17520 * 2, custom: seasonal });
    // the levy adjustment is date-bound (before 31 Mar 2026), so it would make year 2 differ
    for (const d of [y1, y2]) d.importPriceFwdExc = d.importPriceExc.slice();
    const pv1 = synthPv(y1, { kWp: 0.9, seed: 1 });
    const pv2 = synthPv(y2, { kWp: 0.9, seed: 1 });
    // PV as a function of (local month, hh) too, so year 2 repeats year 1 month by month
    for (const [p, d] of [[pv1, y1], [pv2, y2]]) {
        for (let t = 0; t < d.n; t++) {
            const hh = d.local.hh[t];
            const v = Math.min(0.42, (0.3 * (hh > 14 && hh < 38 ? 1 : 0) * (1 + Math.cos((2 * Math.PI * (d.local.month[t] - 5.5)) / 12))) / 2);
            p.dcRawKwh[t] = v; p.dcInvKwh[t] = v; p.acKwh[t] = 0.95 * v; p.clippedDcKwh[t] = 0; p.etaPv[t] = 0.95;
        }
    }

    it('(b) an exact 365-day window starting on the 1st: annual == totals', () => {
        const r = simulate(y1, pv1, KIT({ battery: DCB() }));
        for (const k of ['loadKwh', 'pvAcKwh', 'importKwh', 'exportKwh', 'savingsBilledP', 'impSavFwdExcP', 'battOutKwh', 'standbyKwh']) {
            expect(r.annual[k]).toBeCloseTo(r.totals[k], 9);
        }
        expect(r.annual.selfConsumptionPct).toBeCloseTo(r.totals.selfConsumptionPct, 9);
        expect(r.totals.days).toBe(365);
        expect(r.monthly.map((m) => m.coveredDays)).toEqual([31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30]);
    });
    it('(a) the year duplicated to 730 days gives the same annual values; percentages identical', () => {
        const a = simulate(y1, pv1, KIT({ export: { kind: 'prime' } }));
        const b = simulate(y2, pv2, KIT({ export: { kind: 'prime' } }));
        for (const k of ['loadKwh', 'pvAcKwh', 'importKwh', 'exportKwh', 'savingsBilledP', 'impSavFwdExcP', 'expIncFwdP', 'exportIncomeBilledP']) {
            expect(Math.abs(b.annual[k] - a.annual[k])).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(a.annual[k])));
        }
        for (const k of ['selfConsumptionPct', 'selfSufficiencyPct', 'peakGenSharePct', 'peakImportCutPct']) {
            expect(b.annual[k]).toBeCloseTo(a.annual[k], 9);
        }
        expect(b.totals.savingsBilledP).toBeCloseTo(2 * a.totals.savingsBilledP, 6);
    });
    it('(a) with a battery the duplicated year annualises to within 0.5%', () => {
        const a = simulate(y1, pv1, KIT({ battery: DCB({ strategy: 'threshold' }) }));
        const b = simulate(y2, pv2, KIT({ battery: DCB({ strategy: 'threshold' }) }));
        expect(Math.abs(b.annual.savingsBilledP / a.annual.savingsBilledP - 1)).toBeLessThan(0.005);
    });
    it('a window starting mid-month counts its two partial Octobers once', () => {
        const start = Date.parse('2025-10-14T23:00:00Z'); // 15 Oct 2025 local midnight
        const d = synthDataset({ seed: 1, start, custom: seasonal });
        const r = simulate(d, null, { route: 'reference', loadAdjustW: -100 });
        const ref = simulate(y1, null, { route: 'reference', loadAdjustW: -100 });
        expect(r.monthly.length).toBe(13);
        expect(r.monthly[0].key).toBe('2025-10');
        expect(r.monthly[12].key).toBe('2026-10');
        expect(r.monthly[0].coveredDays + r.monthly[12].coveredDays).toBeCloseTo(31, 9);
        expect(r.annual.savingsBilledP).toBeCloseTo(ref.annual.savingsBilledP, 6);
        const ann = annualise(r.monthly);
        expect(ann.savingsBilledP).toBeCloseTo(r.annual.savingsBilledP, 9);
    });
    it('a summer-only dataset is scaled per month, never ×365/days, and warns', () => {
        const start = Date.parse('2026-05-31T23:00:00Z');
        const d = synthDataset({ seed: 1, start, n: 48 * 61, custom: seasonal });
        const r = simulate(d, null, { route: 'reference', loadAdjustW: -100 });
        expect(r.warnings.join(' ')).toMatch(/Needs 12 months/);
        // June+July only: annual = June·30/30 + July·31/31, not ×365/61
        expect(r.annual.savingsBilledP).toBeCloseTo(r.totals.savingsBilledP, 6);
    });
    it('toMonthlyFwd gives 12 full months whose sum is the annual forward value', () => {
        const r = simulate(y1, pv1, KIT({ export: { kind: 'prime' } }));
        const m = toMonthlyFwd(r.monthly);
        expect(m.length).toBe(12);
        expect(m.reduce((a, b) => a + b.impSavFwdExcP, 0)).toBeCloseTo(r.annual.impSavFwdExcP, 6);
        expect(m.reduce((a, b) => a + b.expIncFwdP, 0)).toBeCloseTo(r.annual.expIncFwdP, 6);
    });
});

describe('profiles, gap-filled share and warnings', () => {
    it('48-slot profile divides by per-hh slot counts (DST days 46/50 slots)', () => {
        const r = simulate(ds, pv, KIT());
        for (const h of [2, 3, 30]) {
            let s = 0;
            let c = 0;
            for (let t = 0; t < n; t++) if (ds.local.hh[t] === h) { s += ds.importPrice[t]; c++; }
            expect(r.profile.priceBilled[h]).toBeCloseTo(s / c, 9);
        }
    });
    it('filled share and savings on filled slots are reported; >5% warns', () => {
        const d = { ...ds, loadFilled: new Uint8Array(n) };
        for (let t = 0; t < n; t += 10) d.loadFilled[t] = 1;
        const r = simulate(d, pv, KIT(), { includeSlots: true });
        let fl = 0;
        let tot = 0;
        for (let t = 0; t < n; t++) { tot += ds.load[t]; if (d.loadFilled[t]) fl += ds.load[t]; }
        expect(r.totals.filledSharePct).toBeCloseTo((100 * fl) / tot, 9);
        expect(r.totals.savingsFilledP).toBeGreaterThan(0);
        expect(r.warnings.join(' ')).toMatch(/estimated usage/);
    });
});

describe('power station (UPS route)', () => {
    const upsSys = (strategy, ups = {}) => ({
        route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 2, strategy, ups: { dedicatedW: 'baseload', chargeW: 800, ...ups } },
    });
    it('dedicated load defaults to the estimated base load and never exports', () => {
        const r = simulate(ds, null, upsSys('threshold'));
        expect(r.totals.dedicatedW).toBeGreaterThan(400);
        expect(r.totals.dedicatedW).toBeLessThan(500);
        expect(r.totals.exportKwh).toBe(0);
        expect(r.totals.savingsBilledP).toBeGreaterThan(0);
        expect(r.totals.bypassOverheadKwh).toBeGreaterThan(0);
        expect(r.totals.upsConversionLossKwh).toBeGreaterThan(0);
        expect(findNonFinite(r)).toEqual([]);
    });
    it('a dedicated load above the whole-house use is clamped and warned about', () => {
        const r = simulate(ds, null, upsSys('threshold', { dedicatedW: 2000 }));
        expect(r.totals.dedicatedClampPct).toBeGreaterThan(5);
        expect(r.warnings.join(' ')).toMatch(/probably set too high/);
    });
    it('own panels add savings; schedule ≤ threshold ≤ optimal', () => {
        const own = synthUpsPv(ds, { kWp: 0.46, maxDcW: 500 });
        const s = (st) => simulate(ds, null, upsSys(st), { upsPvDc: own }).totals.savingsBilledP;
        const sch = s('schedule');
        const thr = s('threshold');
        const opt = s('optimal');
        expect(sch).toBeLessThanOrEqual(thr);
        expect(thr).toBeLessThanOrEqual(opt);
        expect(simulate(ds, null, upsSys('threshold')).totals.savingsBilledP).toBeLessThan(thr);
        const r = simulate(ds, null, upsSys('optimal'), { upsPvDc: own });
        expect(r.totals.upsPvKwh).toBeGreaterThan(0);
        expect(r.totals.selfConsumptionPct).toBeGreaterThan(0);
    });
});

describe('real Agile C prices (two 14-day slices) — strategy ordering', () => {
    const { blocks } = fx('a3-agile-c-slices.json');
    const LEVY_END = Date.parse('2026-03-31T22:00:00Z');
    for (const b of blocks) {
        const start = Date.parse(b.start);
        const local = buildLocalIndex(start, b.n);
        const importPrice = Float64Array.from(b.p);
        const importPriceExc = importPrice.map((v) => v / 1.05);
        const importPriceFwdExc = importPriceExc.map((v, t) => v - (start + t * SLOT_MS < LEVY_END ? 3.333 : 0));
        const d = { start, n: b.n, load: new Float64Array(b.n).fill(0.25), loadFilled: new Uint8Array(b.n), importPrice, importPriceExc, importPriceFwdExc,
            exportPrices: { agile: Float64Array.from(b.x) }, exportPricesFwd: { agile: Float64Array.from(b.x) }, local, standing: [] };
        const S = b.pvS35.map((v) => (v * 1.8 * 0.5) / 0.95);
        const cap = 0.4 / 0.95;
        const p18 = {
            dcRawKwh: Float64Array.from(S), dcInvKwh: Float64Array.from(S, (v) => Math.min(v, cap)), acKwh: Float64Array.from(S, (v) => 0.95 * Math.min(v, cap)),
            clippedDcKwh: Float64Array.from(S, (v) => v - Math.min(v, cap)), standbyKwh: new Float64Array(b.n), etaPv: new Float64Array(b.n).fill(0.95),
        };
        const sys = (strategy) => KIT({ inverter: { acLimitW: 800, etaNom: 0.95, inputs: [{ maxDcW: 1e6, maxAcW: 800 }] }, battery: DCB({ strategy, maxDischargeW: 1000 }) });
        it(`${b.label}: decision-basis cost self ≥ threshold-ish ≥ optimal, DC 2 kWh + 1.8 kWp S35, 500 W`, () => {
            const J = (st) => {
                const r = simulate(d, p18, sys(st), { dispatchOpts: { N: 81 } });
                expect(findNonFinite(r)).toEqual([]);
                return r.dispatch.objectiveP;
            };
            const opt = J('optimal');
            for (const st of ['self', 'fixed', 'schedule', 'threshold', 'smart']) expect(opt).toBeLessThanOrEqual(J(st) * 1.005);
        });
        it(`${b.label}: power station strategies never export and DP beats the rules`, () => {
            const ups = (strategy) => ({ route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 2, strategy, ups: { dedicatedW: 300, chargeW: 800 } } });
            const res = Object.fromEntries(['schedule', 'threshold', 'optimal'].map((st) => [st, simulate({ ...d, load: new Float64Array(b.n).fill(0.15) }, null, ups(st))]));
            for (const r of Object.values(res)) expect(r.totals.exportKwh).toBe(0);
            expect(res.optimal.dispatch.objectiveP).toBeLessThanOrEqual(res.threshold.dispatch.objectiveP * 1.005);
            expect(res.optimal.dispatch.objectiveP).toBeLessThanOrEqual(res.schedule.dispatch.objectiveP * 1.005);
        });
    }
});

describe('acceptance on the shipped data/demo.json (engine critique T2/T5, UX critique UPS & battery)', () => {
    const json = JSON.parse(readFileSync(fileURLToPath(new URL('../../../projects/solar-calculator/data/demo.json', import.meta.url)), 'utf8'));
    const demo = demoDatasetFromJson(json, { serverW: 500 });
    const constant = (w) => ({ ...demo, id: `${demo.id}~c${w}`, load: new Float64Array(demo.n).fill((w * 0.5) / 1000), loadFilled: new Uint8Array(demo.n) });
    const c300 = constant(300);
    const c500 = constant(500);
    const gbp = (r) => r.totals.savingsBilledP / 100;

    it('T2 constant 500 W: baseline £875.69 as billed; removing it saves £761.21 forward ex VAT', () => {
        const r = simulate(c500, null, { route: 'reference', loadAdjustW: -500 });
        expect(r.totals.baselineBilledP / 100).toBeCloseTo(875.69, 2);
        expect(Math.abs(r.totals.savingsBilledP / 100 - 875.69)).toBeLessThan(0.01);
        expect(Math.abs(r.totals.impSavFwdExcP / 100 - 761.21)).toBeLessThan(0.01);
        expect(r.annual.savingsBilledP).toBeCloseTo(r.totals.savingsBilledP, 6); // 365 local days from the 1st
    });

    const ups = (strategy, u = {}, b = {}) => ({ route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 2, minSocPct: 10, strategy, ...b,
        ups: { dedicatedW: 300, chargeW: 800, outletMaxW: 1800, ...u } } });
    it('T5 power station, 300 W, 2 kWh, start full: night-charge schedule £31.41 ± 0.50, optimal (N 81) £76.84 ± 2.00, never exports', () => {
        const sch = simulate(c300, null, ups('schedule'));
        const opt = simulate(c300, null, ups('optimal'), { dispatchOpts: { N: 81 } });
        expect(Math.abs(gbp(sch) - 31.41)).toBeLessThan(0.5);
        expect(Math.abs(gbp(opt) - 76.84)).toBeLessThan(2);
        for (const r of [sch, opt, simulate(c300, null, ups('threshold'))]) expect(r.totals.exportKwh).toBe(0);
    });

    // DELTA 3 Plus (sim-results.json unit): 1 kWh, charger 500 W at 0.88, inverter 0.94, P0 17 W, bypass 8 W, 500 W servers
    const d3 = (strategy, u = {}, b = {}) => ({ route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 1, minSocPct: 10, strategy, ...b,
        ups: { dedicatedW: 500, chargeW: 500, fixedLossW: 17, bypassW: 8, outletMaxW: 1800, ...u } } });
    it('UX DELTA 3 Plus: smart-plug 4–7pm cut ≤ £5, schedule ≤ threshold ≤ optimal, bypass disabled costs > £150/yr more', () => {
        const plug = gbp(simulate(c500, null, d3('schedule', {}, { schedule: { chargeWindow: ['19:00', '16:00'] } })));
        const thr = gbp(simulate(c500, null, d3('threshold')));
        const opt = gbp(simulate(c500, null, d3('optimal'), { dispatchOpts: { N: 81 } }));
        expect(plug).toBeLessThanOrEqual(5);
        expect(plug).toBeLessThanOrEqual(thr);
        expect(thr).toBeLessThanOrEqual(opt);
        // sim_ups's £52.73 only allows whole half-hours on the inverter; the engine-critique slotUPS also
        // uses the last part of a slot (the 77 Wh the third whole slot leaves unused), worth ~9% more
        expect(Math.abs(opt / 57.41 - 1)).toBeLessThan(0.03);
        expect(opt).toBeGreaterThan(52.73);
        // a real 1500 W charge rate can carry 500 W online; the penalty is measured against optimal
        const online = simulate(c500, null, d3('optimal', { bypass: 'disabled', chargeW: 1500 }), { dispatchOpts: { N: 81 } });
        expect(online.warnings.join(' ')).not.toMatch(/no feasible|cannot be sustained/);
        expect(gbp(online) - opt).toBeLessThan(-150);
        expect(online.totals.exportKwh).toBe(0);
    });

    describe('with real PV from pv.js (4 × 460 Wp S35 on the default dual 400 W-channel micro, 500 W)', () => {
        const arrays = [{ count: 2, wp: 460, tilt: 35, azimuth: 180, input: 0, shadingPct: 0 }, { count: 2, wp: 460, tilt: 35, azimuth: 180, input: 1, shadingPct: 0 }];
        const geom = prepareGeometry(c500, { subSteps: 3 });
        const sky = prepareSky(c500, geom);
        const norm = normalizeSystem({ arrays });
        const pvReal = inverterAc(geom, dcByInput(geom, norm.arrays, norm.arrays.map((a) => arrayDcW(sky, a)), norm.inverter), norm.inverter);
        const kit = (battery, exp = 'none') => ({ route: 'hardwired', arrays, battery, export: { kind: exp } });

        it('the slots pv.js reports with DC but no AC (dawn/dusk) exist, and an idle battery still changes nothing', () => {
            let dawn = 0;
            for (let t = 0; t < c500.n; t++) if (pvReal.dcInvKwh[t] > 0 && pvReal.acKwh[t] === 0) dawn++;
            expect(dawn).toBeGreaterThan(50);
            for (const exp of ['none', 'prime']) {
                const pvOnly = simulate(c500, pvReal, kit(null, exp));
                for (const coupling of ['dc', 'ac']) {
                    const idle = simulate(c500, pvReal, kit({ coupling, standbyW: 0 }, exp), { dispatchOpts: { strategy: 'idle' } });
                    expect(Math.abs(idle.totals.savingsBilledP - pvOnly.totals.savingsBilledP)).toBeLessThan(1e-6);
                    expect(Math.abs(idle.totals.impSavFwdExcP - pvOnly.totals.impSavFwdExcP)).toBeLessThan(1e-6);
                }
            }
        });
        it('SPEC §5 budgets on a full year: simulate without a battery < 150 ms, DP N = 41 < 200 ms', () => {
            const best = (f) => { let b = Infinity; for (let i = 0; i < 3; i++) { const a = performance.now(); f(); b = Math.min(b, performance.now() - a); } return b; };
            expect(best(() => simulate(c500, pvReal, kit(null, 'prime')))).toBeLessThan(150);
            expect(best(() => simulate(c500, pvReal, kit({ coupling: 'dc', acChargeW: 800, strategy: 'optimal' }), { dispatchOpts: { N: 41 } }))).toBeLessThan(200);
        });
        it('UX battery (a): 2 kWh dc + AC charging: self ≤ threshold ≤ optimal + £1 and threshold ≥ 0.85·optimal', () => {
            const s = (strategy) => gbp(simulate(c500, pvReal, kit({ coupling: 'dc', capacityKwh: 2, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 800, strategy })));
            const self = s('self');
            const thr = s('threshold');
            const opt = s('optimal');
            expect(self).toBeLessThanOrEqual(thr);
            expect(thr).toBeLessThanOrEqual(opt + 1);
            expect(thr).toBeGreaterThanOrEqual(0.85 * opt);
        });
    });
});

describe('caller mistakes are caught', () => {
    it('PV supplied for a system without grid-tied panels is ignored (and warned about)', () => {
        const ups = { route: 'ups', arrays: [], battery: { coupling: 'ups', capacityKwh: 2, ups: { dedicatedW: 300 } } };
        const a = simulate(ds, null, ups);
        const b = simulate(ds, pv, ups);
        expect(b.totals.savingsBilledP).toBe(a.totals.savingsBilledP);
        expect(b.totals.pvAcKwh).toBe(0);
        expect(b.warnings.join(' ')).toMatch(/without grid-tied panels/);
    });
    it('PV arrays of the wrong length throw instead of turning every total into NaN', () => {
        const short = { ...pv, acKwh: pv.acKwh.subarray(0, 100) };
        expect(() => simulate(ds, short, KIT())).toThrow(RangeError);
        expect(() => simulate(ds, null, { route: 'ups', battery: { coupling: 'ups' } }, { upsPvDc: new Float64Array(5) })).toThrow(RangeError);
    });
    it('engine critique gap-fill case: 500 W with 3 filled two-slot gaps → filledSharePct = 6/17520·100', () => {
        const d = synthDataset({ household: false, custom: () => ({ load: 0.25 }) });
        d.loadFilled = new Uint8Array(d.n);
        for (const s of [1000, 5000, 9000]) { d.loadFilled[s] = 1; d.loadFilled[s + 1] = 1; }
        const r = simulate(d, null, { route: 'reference', loadAdjustW: -100 });
        expect(Math.abs(r.totals.filledSharePct - (6 / 17520) * 100)).toBeLessThan(1e-9);
        let filledSav = 0;
        for (let t = 0; t < d.n; t++) if (d.loadFilled[t]) filledSav += 0.05 * d.importPrice[t];
        expect(r.totals.savingsFilledP).toBeCloseTo(filledSav, 9);
        expect(r.warnings.join(' ')).not.toMatch(/estimated usage/); // 0.03% is far below the 5% warning
    });
});

describe('no NaN anywhere', () => {
    it('empty-ish inputs: zero load, no PV, every coupling', () => {
        const d = synthDataset({ seed: 3, n: 48 * 40, custom: () => ({ load: 0 }) });
        for (const battery of [null, DCB(), DCB({ coupling: 'ac' }), { coupling: 'ups', capacityKwh: 1, ups: { dedicatedW: 'baseload' } }]) {
            const r = simulate(d, null, { route: 'hardwired', arrays: [], battery }, { includeSlots: true });
            expect(findNonFinite(r)).toEqual([]);
        }
    });
    it('START constant is local midnight of 1 Oct 2025', () => {
        expect(buildLocalIndex(START_2025_10_01, 1).hh[0]).toBe(0);
    });
});
