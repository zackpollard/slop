import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { estimateBaseLoad, analyseUsage, monthCoverage, annualSum, slotsInLocalDay, flexibleCompare } from '../../../projects/solar-calculator/js/insights.js';
import { demoDatasetFromJson } from '../../../projects/solar-calculator/js/dataset.js';
import { synthDataset, lcg, findNonFinite } from './fixtures/solar/a3-synth.js';

/** T6: 500 W servers + up to 2 kW appliance spikes in 20 random slots per day. */
function spiky({ seed = 9, n = 17520, start } = {}) {
    const rnd = lcg(seed);
    const d = synthDataset({ seed, n, start, household: false, custom: () => ({ load: 0.25 }) });
    for (const day of d.local.days) {
        for (let k = 0; k < 20; k++) {
            const t = day.first + Math.floor(rnd() * day.count);
            d.load[t] = 0.25 + rnd() * 1.0; // + up to 2 kW for the half-hour
        }
    }
    return d;
}

describe('estimateBaseLoad (T6)', () => {
    it('500 W + appliance spikes → 500 ± 1 W, p10/p90 tight', () => {
        const b = estimateBaseLoad(spiky());
        expect(Math.abs(b.w - 500)).toBeLessThan(1);
        expect(b.p10).toBeGreaterThan(499);
        expect(b.p90).toBeLessThan(501);
        expect(b.days).toBe(365);
        expect(b.estimated).toBe(false);
        expect(Math.abs(b.p5SlotW - 500)).toBeLessThan(1);
    });
    it('days with < 44 real slots are dropped; zeros are ignored', () => {
        const d = spiky({ seed: 4 });
        d.loadFilled = new Uint8Array(d.n);
        const day10 = d.local.days[10];
        for (let t = day10.first; t < day10.first + 6; t++) d.loadFilled[t] = 1; // 42 real slots left
        const day20 = d.local.days[20];
        for (let t = day20.first; t < day20.first + 3; t++) d.load[t] = 0; // 45 positive readings: kept
        const day30 = d.local.days[30];
        for (let t = day30.first; t < day30.first + 5; t++) d.load[t] = 0; // 43 positive readings: dropped
        const b = estimateBaseLoad(d);
        expect(Number.isNaN(b.dailyW[10])).toBe(true);
        expect(b.dailyW[20]).toBeCloseTo(500, 6);
        expect(Number.isNaN(b.dailyW[30])).toBe(true);
        expect(b.days).toBe(363);
        expect(Math.abs(b.w - 500)).toBeLessThan(1);
    });
    it('gap-filled slots never pull the estimate (engine critique: 500 W + 3 zero runs filled)', () => {
        const d = synthDataset({ household: false, custom: () => ({ load: 0.25 }) });
        d.loadFilled = new Uint8Array(d.n);
        for (const start of [1000, 5000, 9000]) for (let t = start; t < start + 2; t++) { d.load[t] = 0.1; d.loadFilled[t] = 1; }
        const b = estimateBaseLoad(d);
        expect(Math.abs(b.w - 500)).toBeLessThan(1);
    });
    it('recent base load and drift: servers cut from 500 W to 300 W for the last 65 days', () => {
        const d = synthDataset({ household: false, custom: (t, local) => ({ load: local.day[t] >= 300 ? 0.15 : 0.25 }) });
        const b = estimateBaseLoad(d);
        expect(b.w).toBeCloseTo(500, 6);
        expect(b.recentW).toBeCloseTo(300, 6);
        expect(b.driftPct).toBeCloseTo(-40, 6);
        expect(b.monthly.at(-1).w).toBeCloseTo(300, 6);
        expect(b.monthly[0]).toMatchObject({ key: '2025-10' });
    });
    it('the memo distinguishes datasets that share a load array but not the filled mask', () => {
        const d = synthDataset({ household: false, custom: (t) => ({ load: t % 48 < 8 ? 0.1 : 0.25 }) });
        expect(estimateBaseLoad(d).w).toBeCloseTo(200, 9);
        const filled = new Uint8Array(d.n);
        for (let t = 0; t < d.n; t++) if (t % 48 < 8) filled[t] = 1;
        expect(estimateBaseLoad({ ...d, loadFilled: filled }).w).toBeCloseTo(500, 9);
        expect(estimateBaseLoad(d).w).toBeCloseTo(200, 9);
    });
    it('no usable day falls back to the 5th percentile of real slots, flagged estimated', () => {
        const d = synthDataset({ n: 48 * 3, household: false, custom: () => ({ load: 0.2 }) });
        d.loadFilled = new Uint8Array(d.n);
        for (let t = 0; t < d.n; t += 2) d.loadFilled[t] = 1;
        const b = estimateBaseLoad(d);
        expect(b.estimated).toBe(true);
        expect(b.w).toBeCloseTo(400, 6);
        expect(findNonFinite({ ...b, dailyW: null })).toEqual([]);
    });
});

describe('analyseUsage', () => {
    const d = synthDataset({ seed: 5, baseW: 500 });
    const ins = analyseUsage(d);

    it('base-load cost = Σ price·base·Δt (full year from the 1st) and £ per 100 W', () => {
        let s = 0;
        let sp = 0;
        for (let t = 0; t < d.n; t++) { s += d.importPrice[t] * 0.05; if (d.local.peak[t]) sp += d.importPrice[t] * 0.05; }
        expect(ins.baseLoad.gbpPer100W).toBeCloseTo(s / 100, 9);
        expect(ins.baseLoad.costBilledGbpYr).toBeCloseTo((s / 100) * (ins.baseLoad.w / 100), 9);
        expect(ins.baseLoad.costPeakGbpYr).toBeCloseTo((sp / 100) * (ins.baseLoad.w / 100), 9);
        expect(ins.baseLoad.kwhYr).toBeCloseTo((ins.baseLoad.w * 8760) / 1000, 9);
        expect(ins.baseLoad.sharePct).toBeGreaterThan(50);
        expect(ins.baseLoad.sharePct).toBeLessThan(100);
    });
    it('peak shares and kWh per day', () => {
        let all = 0;
        let pk = 0;
        let allP = 0;
        let pkP = 0;
        for (let t = 0; t < d.n; t++) {
            all += d.load[t]; allP += d.load[t] * d.importPrice[t];
            if (d.local.peak[t]) { pk += d.load[t]; pkP += d.load[t] * d.importPrice[t]; }
        }
        expect(ins.peak.kwhSharePct).toBeCloseTo((100 * pk) / all, 9);
        expect(ins.peak.costSharePct).toBeCloseTo((100 * pkP) / allP, 9);
        expect(ins.peak.kwhPerDay).toBeCloseTo(pk / 365, 6);
    });
    it('48-slot profiles divide by per-hh counts; filled slots are excluded from the load profile', () => {
        const d2 = { ...d, loadFilled: new Uint8Array(d.n) };
        for (let t = 0; t < d.n; t++) if (d.local.hh[t] === 10 && t % 3 === 0) d2.loadFilled[t] = 1;
        const i2 = analyseUsage(d2);
        let c10 = 0;
        let s10 = 0;
        for (let t = 0; t < d.n; t++) if (d.local.hh[t] === 10 && !d2.loadFilled[t]) { c10++; s10 += d.load[t]; }
        expect(i2.profiles.loadCounts[10]).toBe(c10);
        expect(i2.profiles.load[10]).toBeCloseTo(s10 / c10, 12);
        // DST: hh 2 is missing on the 46-slot day and doubled on the 50-slot day
        expect(ins.profiles.loadCounts[2]).toBe(365);
        expect(ins.profiles.loadCounts[20]).toBe(365);
    });
    it('heatmap: absent cells NaN (46-slot day), duplicates averaged (50-slot day)', () => {
        const hm = ins.heatmap;
        expect(hm.days).toBe(365);
        const spring = hm.dates.indexOf('2026-03-29');
        const autumn = hm.dates.indexOf('2025-10-26');
        expect(Number.isNaN(hm.load[spring * 48 + 2])).toBe(true);
        expect(Number.isNaN(hm.price[spring * 48 + 3])).toBe(true);
        const day = d.local.days[autumn];
        const twice = [];
        for (let t = day.first; t < day.first + day.count; t++) if (d.local.hh[t] === 2) twice.push(t);
        expect(twice.length).toBe(2);
        expect(hm.price[autumn * 48 + 2]).toBeCloseTo((d.importPrice[twice[0]] + d.importPrice[twice[1]]) / 2, 4);
    });
    it('monthly bills: energy as billed + standing charges with VAT by date (0% from Oct 2026)', () => {
        const d3 = synthDataset({ seed: 2, start: Date.parse('2026-08-31T23:00:00Z'), n: 48 * 61 + 2 }); // 25 Oct has 50 slots
        const i3 = analyseUsage(d3);
        expect(i3.monthlyBills.map((b) => b.key)).toEqual(['2026-09', '2026-10']);
        expect(i3.monthlyBills[0].standingGbp).toBeCloseTo((30 * 37.6525 * 1.05) / 100, 9);
        expect(i3.monthlyBills[1].standingGbp).toBeCloseTo((31 * 37.6525) / 100, 9);
        let e = 0;
        let k = 0;
        for (let t = 0; t < d3.local.months[0].count; t++) { e += d3.load[t] * d3.importPrice[t]; k += d3.load[t]; }
        expect(i3.monthlyBills[0].energyGbp).toBeCloseTo(e / 100, 9);
        expect(i3.monthlyBills[0].kwh).toBeCloseTo(k, 9);
        expect(i3.totals.standingGbp).toBeCloseTo(i3.monthlyBills[0].standingGbp + i3.monthlyBills[1].standingGbp, 9);
    });
    it('monthly base load carries p10/p90 and the number of days, from the same daily values', () => {
        const b = estimateBaseLoad(d);
        for (const m of b.monthly) {
            const month = d.local.months.find((x) => x.key === m.key);
            const vals = d.local.days.map((x, i) => [x, b.dailyW[i]]).filter(([x, v]) => x.first >= month.first && x.first < month.first + month.count && Number.isFinite(v)).map(([, v]) => v);
            expect(m.days).toBe(vals.length);
            expect(m.p10).toBeLessThanOrEqual(m.w);
            expect(m.p90).toBeGreaterThanOrEqual(m.w);
            expect(m.p10).toBeGreaterThanOrEqual(Math.min(...vals) - 1e-9);
            expect(m.p90).toBeLessThanOrEqual(Math.max(...vals) + 1e-9);
        }
        // a month without usable days: nulls, 0 days
        const g = synthDataset({ seed: 3, start: Date.parse('2026-08-31T23:00:00Z'), n: 48 * 61 + 2 });
        g.loadFilled = new Uint8Array(g.n);
        for (let t = 0; t < g.local.months[0].count; t++) g.loadFilled[t] = 1;
        expect(estimateBaseLoad(g).monthly[0]).toEqual({ key: '2026-09', w: null, p10: null, p90: null, days: 0 });
    });
    it('Flexible: the same usage priced on interval rates with VAT by date, standing per local day; null without prices', () => {
        expect(ins.flexible).toBeNull(); // the synthetic dataset has no Flexible prices
        const d3 = synthDataset({ seed: 2, start: Date.parse('2026-08-31T23:00:00Z'), n: 48 * 61 + 2 });
        const cut = Date.parse('2026-09-15T23:00:00Z');
        d3.flexible = { product: 'VAR-22-11-01', code: 'E-1R-VAR-22-11-01-C',
            unit: [{ fromMs: -Infinity, toMs: cut, exc: 20 }, { fromMs: cut, toMs: Infinity, exc: 30 }],
            standing: [{ fromMs: -Infinity, toMs: Infinity, pPerDayExc: 40 }] };
        const i3 = analyseUsage(d3);
        let p = 0;
        let kwh = 0;
        for (let t = 0; t < d3.n; t++) {
            const ms = d3.start + t * 1_800_000;
            const exc = ms < cut ? 20 : 30;
            p += d3.load[t] * exc * (ms < Date.parse('2026-09-30T23:00:00Z') ? 1.05 : 1);
            kwh += d3.load[t];
        }
        const f = i3.flexible;
        expect(f.product).toBe('VAR-22-11-01');
        expect(f.energyGbp).toBeCloseTo(p / 100, 9);
        expect(f.unitP).toBeCloseTo(p / kwh, 9);
        expect(f.standingGbp).toBeCloseTo((30 * 40 * 1.05 + 31 * 40) / 100, 9); // VAT 5% in Sept, 0% in Oct
        expect(f.deltaGbp).toBeCloseTo(f.energyGbp + f.standingGbp - i3.totals.energyGbp - i3.totals.standingGbp, 9);
        // a hole between records takes the nearer record's price; no standing charges → the same as billed
        const holed = { ...d3, flexible: { ...d3.flexible, unit: [{ fromMs: -Infinity, toMs: cut, exc: 20 }, { fromMs: cut + 86400000, toMs: Infinity, exc: 30 }], standing: [] } };
        const h = flexibleCompare(holed, { energyGbp: 1, standingGbp: 7 });
        expect(h.standingGbp).toBe(7);
        let ph = 0;
        for (let t = 0; t < d3.n; t++) {
            const ms = d3.start + t * 1_800_000;
            const exc = ms < cut ? 20 : ms >= cut + 86400000 ? 30 : ms - cut < cut + 86400000 - ms ? 20 : 30;
            ph += d3.load[t] * exc * (ms < Date.parse("2026-09-30T23:00:00Z") ? 1.05 : 1);
        }
        expect(h.energyGbp).toBeCloseTo(ph / 100, 9);
    });
    it('negative-price slots and load- vs time-weighted price', () => {
        let ns = 0;
        let nk = 0;
        let ng = 0;
        let lw = 0;
        let l = 0;
        let tw = 0;
        for (let t = 0; t < d.n; t++) {
            if (d.importPrice[t] < 0) { ns++; nk += d.load[t]; ng += d.load[t] * d.importPrice[t]; }
            lw += d.load[t] * d.importPrice[t]; l += d.load[t]; tw += d.importPrice[t];
        }
        expect(ns).toBeGreaterThan(0);
        expect(ins.negative).toEqual({ slots: ns, kwh: expect.closeTo(nk, 9), gbp: expect.closeTo(ng / 100, 9) });
        expect(ins.loadWeightedPriceP).toBeCloseTo(lw / l, 9);
        expect(ins.timeWeightedPriceP).toBeCloseTo(tw / d.n, 9);
        expect(ins.coverage.realPct).toBe(100);
    });
    it('no NaN outside the documented heatmap/dailyW holes', () => {
        const { heatmap, baseLoad, ...rest } = ins;
        const { dailyW, ...bl } = baseLoad;
        expect(findNonFinite({ ...rest, bl, prices: heatmap.price.filter((v) => !Number.isNaN(v)) })).toEqual([]);
        expect(dailyW.length).toBe(365);
    });
});

describe('acceptance on the shipped data/demo.json (engine critique T1/T2, research §6)', () => {
    const json = JSON.parse(readFileSync(fileURLToPath(new URL('../../../projects/solar-calculator/data/demo.json', import.meta.url)), 'utf8'));
    const demo = demoDatasetFromJson(json, { serverW: 500 });
    const c500 = { ...demo, load: new Float64Array(demo.n).fill(0.25), loadFilled: new Uint8Array(demo.n) };
    const ins = analyseUsage(c500);

    it('T2: 500 W costs £875.69/yr, £1.7514 per W per year, £190.70 (21.78%) of it 4–7pm', () => {
        expect(ins.baseLoad.w).toBeCloseTo(500, 9);
        expect(Math.abs(ins.baseLoad.gbpPer100W / 100 - 1.7514)).toBeLessThan(0.0001);
        expect(Math.abs(ins.baseLoad.costBilledGbpYr - 875.69)).toBeLessThan(0.01);
        expect(Math.abs(ins.baseLoad.costPeakGbpYr - 190.70)).toBeLessThan(0.01);
        expect(Math.abs((100 * ins.baseLoad.costPeakGbpYr) / ins.baseLoad.costBilledGbpYr - 21.78)).toBeLessThan(0.005);
        expect(ins.totals.energyGbp).toBeCloseTo(ins.baseLoad.costBilledGbpYr, 9); // a full year from the 1st
    });
    it('T1: mean price 19.993p, 497 negative slots, 16–19 mean 34.830p vs 17.873p the rest', () => {
        expect(Math.abs(ins.timeWeightedPriceP - 19.993)).toBeLessThan(0.001);
        expect(ins.negative.slots).toBe(497);
        let pk = 0, pkN = 0, rest = 0, restN = 0;
        for (let h = 0; h < 48; h++) {
            const c = ins.profiles.loadCounts[h];
            if (h >= 32 && h < 38) { pk += ins.profiles.priceBilled[h] * c; pkN += c; } else { rest += ins.profiles.priceBilled[h] * c; restN += c; }
        }
        expect(Math.abs(pk / pkN - 34.83)).toBeLessThan(0.001);
        expect(Math.abs(rest / restN - 17.873)).toBeLessThan(0.001);
        expect(ins.heatmap.dates.length).toBe(365);
    });
    it('demo: the same usage on region C Flexible (VAR-22-11-01, Direct Debit) is dearer than Agile', () => {
        const f = analyseUsage(demo).flexible;
        expect(f).toMatchObject({ product: 'VAR-22-11-01', code: 'E-1R-VAR-22-11-01-C' });
        expect(f.unitP).toBeGreaterThan(23.7 * 1.05 - 1e-9); // between the cheapest and dearest quarter, inc VAT
        expect(f.unitP).toBeLessThan(25.72 * 1.05 + 1e-9);
        expect(f.standingGbp).toBeGreaterThan(150);
        expect(f.deltaGbp).toBeGreaterThan(0);
    });
    it('the demo household (servers + synthetic home) has a ~500 W+ base load, flat over the year', () => {
        const b = analyseUsage(demo).baseLoad;
        expect(b.w).toBeGreaterThan(500);
        expect(b.w).toBeLessThan(650);
        expect(Math.abs(b.driftPct)).toBeLessThan(15);
        expect(Math.abs(b.p5SlotW / b.w - 1)).toBeLessThan(0.15); // the 5th-percentile cross-check agrees
    });
});

describe('calendar-month annualisation helpers', () => {
    it('slotsInLocalDay: 46 / 48 / 50', () => {
        expect(slotsInLocalDay('2026-03-29')).toBe(46);
        expect(slotsInLocalDay('2025-10-26')).toBe(50);
        expect(slotsInLocalDay('2026-07-01')).toBe(48);
    });
    it('covered days count whole local days (DST days count as one)', () => {
        const d = synthDataset({ seed: 1 });
        const c = monthCoverage(d);
        expect(Array.from(c.coveredDays)).toEqual([31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30]);
        expect(Array.from(c.factorByMonth0)).toEqual(Array(12).fill(1));
    });
    it('a 61-day window annualises each month by DIM/covered, other months contribute 0', () => {
        const d = synthDataset({ seed: 1, start: Date.parse('2026-05-31T23:00:00Z'), n: 48 * 45 });
        const a = annualSum(d, () => 1);
        // June fully covered (×1), July half covered (15 days → ×31/15)
        expect(a).toBeCloseTo(30 * 48 + 15 * 48 * (31 / 15), 6);
    });
});
