import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    buildDataset, demoDatasetFromJson, summarize, withBaseLoad, fillGaps, markGaps, realBaseLoadW, chooseWindow,
    joinByEpoch, loadDataset, resolveLocation, DataError, LEVY_EXC_P, LEVY_END_MS,
} from '../../../projects/solar-calculator/js/dataset.js';
import { buildLocalIndex, localMidnightUtc } from '../../../projects/solar-calculator/js/time.js';
import {
    SLOT, json, rateEndpoint, consumptionEndpoint, halfHourly, interval, mockFetch, accountBody, consumptionRows,
} from './fixtures/solar/a2-octopus-mock.js';

const DEMO_PATH = fileURLToPath(new URL('../../../projects/solar-calculator/data/demo.json', import.meta.url));
const JOIN = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/solar/a2-weather-join.json', import.meta.url)), 'utf8'));
let demo, ds;

beforeAll(() => {
    demo = JSON.parse(readFileSync(DEMO_PATH, 'utf8'));
    ds = demoDatasetFromJson(demo, { serverW: 500, seed: 1 });
});

/** Parts for buildDataset on the demo grid with a custom consumption series. */
function demoParts(consumption, extra = {}) {
    const start = demo.start, n = demo.n;
    return {
        source: 'csv', start, n, lat: demo.lat, lon: demo.lon, region: 'C', postcode: 'SW1A 1AA',
        consumption,
        importExc: { start, values: demo.importExc },
        tariffs: [{ code: demo.tariffCode, product: 'AGILE-24-10-01', fromMs: start, toMs: start + n * SLOT }],
        exportAgile: { start, values: demo.exportAgile },
        standing: [{ fromMs: start, toMs: start + n * SLOT, pPerDayExc: 37.6525 }],
        weather: { start, ghi: demo.ghi, dni: demo.dni, dhi: demo.dhi, tempC: demo.tempC, windMs: demo.windMs, wxSource: demo.wxSource },
        ...extra,
    };
}

const sum = (a, f = x => x) => { let s = 0; for (let i = 0; i < a.length; i++) s += f(a[i], i); return s; };

describe('T1 — demo prices on the local-day window', () => {
    it('has 17 520 slots, 365 local days, DST days of 50 and 46 slots', () => {
        expect(ds.n).toBe(17520);
        expect(ds.start).toBe(Date.parse('2025-09-30T23:00:00Z'));
        expect(ds.local.days).toHaveLength(365);
        expect(ds.local.days.find(d => d.date === '2025-10-26').count).toBe(50);
        expect(ds.local.days.find(d => d.date === '2026-03-29').count).toBe(46);
    });

    it('as-billed mean 19.993, 497 negative slots, 16–19 local mean 34.830 vs 17.873', () => {
        const p = ds.importPrice;
        expect(sum(p) / ds.n).toBeCloseTo(19.993, 3);
        expect(Math.abs(sum(p) / ds.n - 19.993)).toBeLessThan(0.001);
        expect(sum(p, v => (v < 0 ? 1 : 0))).toBe(497);
        let pk = 0, pn = 0, r = 0, rn = 0;
        for (let t = 0; t < ds.n; t++) { if (ds.local.peak[t]) { pk += p[t]; pn++; } else { r += p[t]; rn++; } }
        expect(Math.abs(pk / pn - 34.830)).toBeLessThan(0.001);
        expect(Math.abs(r / rn - 17.873)).toBeLessThan(0.001);
        // as billed = exc × 1.05 throughout this window (it ends the instant VAT went to 0%)
        for (let t = 0; t < ds.n; t += 997) expect(p[t]).toBeCloseTo(ds.importPriceExc[t] * 1.05, 10);
    });
});

describe('T2 — price bases for a constant 500 W', () => {
    it('as billed £875.69, ex VAT £833.99, forward ex VAT £761.21', () => {
        const flat = buildDataset(demoParts(new Float64Array(demo.n).fill(0.25)));
        const gbp = arr => sum(flat.load, (l, t) => l * arr[t]) / 100;
        expect(Math.abs(gbp(flat.importPrice) - 875.69)).toBeLessThan(0.01);
        expect(Math.abs(gbp(flat.importPriceExc) - 833.99)).toBeLessThan(0.01);
        expect(Math.abs(gbp(flat.importPriceFwdExc) - 761.21)).toBeLessThan(0.01);
        // Levy removed only from Agile slots before 2026-03-31T22:00Z.
        const k = (LEVY_END_MS - flat.start) / SLOT;
        expect(flat.importPriceFwdExc[k - 1]).toBeCloseTo(flat.importPriceExc[k - 1] - LEVY_EXC_P, 10);
        expect(flat.importPriceFwdExc[k]).toBe(flat.importPriceExc[k]);
        expect(flat.meta.forward.levyAdjust).toBe(true);
        const noLevy = buildDataset(demoParts(new Float64Array(demo.n).fill(0.25), { levyAdjust: false }));
        expect(Array.from(noLevy.importPriceFwdExc)).toEqual(Array.from(noLevy.importPriceExc));
    });

    it('16–19 local cost £190.70 (21.78%) and £1.7514 per always-on W per year, from the epoch-joined prices', () => {
        const flat = buildDataset(demoParts(new Float64Array(demo.n).fill(0.25)));
        let all = 0, peak = 0;
        for (let t = 0; t < flat.n; t++) {
            const c = flat.load[t] * flat.importPrice[t];
            all += c;
            if (flat.local.peak[t]) peak += c;
        }
        expect(Math.abs(peak / 100 - 190.70)).toBeLessThan(0.01);
        expect(Math.abs(100 * peak / all - 21.78)).toBeLessThan(0.005);
        expect(Math.abs(all / 100 / 500 - 1.7514)).toBeLessThan(0.0001);
    });

    it('levy applies per tariff: Flexible slots keep their price, Agile slots lose 3.333p', () => {
        const start = demo.start, n = demo.n;
        const split = Date.parse('2026-01-15T00:00:00Z');
        const exc = Float64Array.from(demo.importExc, (v, t) => (start + t * SLOT < split ? 25 : v));
        const d = buildDataset(demoParts(new Float64Array(n).fill(0.25), {
            importExc: exc,
            tariffs: [
                { code: 'E-1R-VAR-22-11-01-C', product: 'VAR-22-11-01', fromMs: start, toMs: split },
                { code: 'E-1R-AGILE-24-10-01-C', product: 'AGILE-24-10-01', fromMs: split, toMs: start + n * SLOT },
            ],
        }));
        expect(d.importPriceFwdExc[0]).toBe(25);
        const k = (split - start) / SLOT;
        expect(d.importPriceFwdExc[k]).toBeCloseTo(exc[k] - LEVY_EXC_P, 10);
    });

    it('flat and forward-series bases', () => {
        const flat = buildDataset(demoParts(new Float64Array(demo.n).fill(0.25), {
            importExc: new Float64Array(demo.n).fill(24.5), priceBasis: 'flat',
            forward: { kind: 'flat', code: 'FLAT-24.5p', flatExc: 24.5 },
        }));
        expect(flat.importPriceFwdExc.every(v => v === 24.5)).toBe(true);
        expect(flat.importPrice[0]).toBeCloseTo(24.5 * 1.05, 10);
        expect(flat.meta.priceBasis).toBe('flat');
    });
});

describe('epoch-ms join of demo.json (never an index zip)', () => {
    const researchStart = Date.parse(JOIN.researchStart);

    it('matches the research weather at the same instant, including 2026-06-21T11:00Z', () => {
        for (const [iso, idx, ghi, dni, dhi, temp, wind, src] of JOIN.rows) {
            const ms = Date.parse(iso);
            expect((ms - researchStart) / SLOT).toBe(idx);
            const k = (ms - demo.start) / SLOT;
            if (k >= demo.n) continue; // the research file runs two slots past the window
            expect(demo.ghi[k]).toBe(ghi);
            expect(demo.dni[k]).toBe(dni);
            expect(demo.dhi[k]).toBe(dhi);
            // stored at 1 dp: within half a unit of the last place
            expect(Math.abs(demo.tempC[k] - temp)).toBeLessThanOrEqual(0.05 + 1e-9);
            expect(Math.abs(demo.windMs[k] - wind)).toBeLessThanOrEqual(0.05 + 1e-9);
            expect(demo.wxSource[k]).toBe(src);
            expect(ds.ghi[k]).toBe(ghi);
        }
        const k = (Date.parse('2026-06-21T11:00:00Z') - ds.start) / SLOT;
        const row = JOIN.rows.find(r => r[0] === '2026-06-21T11:00:00Z');
        expect(row[1]).toBe((Date.parse('2026-06-21T11:00:00Z') - Date.parse('2025-10-01T00:00:00Z')) / 1.8e6);
        expect(ds.ghi[k]).toBe(row[2]);
        expect(ds.ghi[k]).toBe(655);
    });

    it('an index-zipped build would fail: research index ≠ demo index by exactly 2 slots', () => {
        const day = JOIN.rows.filter(r => r[0].startsWith('2026-06-21') && r[2] > 0);
        const zipMismatches = day.filter(([, idx, ghi]) => demo.ghi[idx] !== ghi).length;
        expect(zipMismatches).toBeGreaterThan(day.length / 2);
        expect((researchStart - demo.start) / SLOT).toBe(2);
    });

    it('gives the two leading night slots zero irradiance, the 00:00Z temp/wind and wxSource 3', () => {
        const first = JOIN.rows[0];
        for (const k of [0, 1]) {
            expect([demo.ghi[k], demo.dni[k], demo.dhi[k]]).toEqual([0, 0, 0]);
            expect(demo.wxSource[k]).toBe(3);
            expect(demo.tempC[k]).toBeCloseTo(first[5], 1);
        }
        expect(demo.ghi[2]).toBe(first[2]);
    });

    it('annual Σghi·0.5/1000 = 1204.6 ± 0.1 kWh/m²', () => {
        expect(Math.abs(sum(ds.ghi) * 0.5 / 1000 - 1204.6)).toBeLessThan(0.1);
        expect(Math.abs(sum(ds.ghi) * 0.5 / 1000 - JOIN.annualGhiKwhM2)).toBeLessThan(0.1);
    });

    it('joinByEpoch handles rows, offset grids and aligned arrays', () => {
        const s = Date.parse('2026-01-01T00:00:00Z');
        expect(Array.from(joinByEpoch([[s + SLOT, 2], [s - SLOT, 9], [s + 7, 4]], s, 3))).toEqual([NaN, 2, NaN]);
        expect(Array.from(joinByEpoch({ start: s - 2 * SLOT, values: [1, 2, 3, 4] }, s, 3))).toEqual([3, 4, NaN]);
        expect(Array.from(joinByEpoch([5, 6, 7], s, 3))).toEqual([5, 6, 7]);
        expect(() => joinByEpoch([5, 6], s, 3)).toThrow();
    });
});

describe('gap filling', () => {
    it('synthetic 500 W + 3 zero runs → 6 filled slots, base load 500 W, filledSharePct = 6/17520·100', () => {
        const load = new Float64Array(demo.n).fill(0.25);
        for (const k of [1000, 8000, 15000]) { load[k] = 0; load[k + 1] = 0; }
        const d = buildDataset(demoParts(load));
        expect(sum(d.loadFilled, v => (v === 1 ? 1 : 0))).toBe(6);
        for (const k of [1000, 1001, 8000, 8001, 15000, 15001]) expect(d.load[k]).toBe(0.25);
        const filledShare = 100 * sum(d.load, (l, t) => (d.loadFilled[t] ? l : 0)) / sum(d.load);
        expect(Math.abs(filledShare - 6 / 17520 * 100)).toBeLessThan(1e-9);
        expect(Math.abs(d.meta.baseLoadW - 500)).toBeLessThan(1);
        expect(d.meta.coverage).toMatchObject({ filledSlots: 6, extrapolatedSlots: 0, days: 365 });
        expect(d.meta.notes.join(' ')).toMatch(/6 half-hours read 0 kWh/);
    });

    it('keeps a single zero reading as real', () => {
        const load = new Float64Array(demo.n).fill(0.25);
        load[12000] = 0;
        const d = buildDataset(demoParts(load));
        expect(d.loadFilled[12000]).toBe(0);
        expect(d.load[12000]).toBe(0);
        expect(d.meta.coverage.filledSlots).toBe(0);
    });

    it('treats readings above 10 kWh as gaps', () => {
        const m = markGaps(Float64Array.from([0.2, 12, 0.3, 0, 0.4, 0, 0, 0, 0.5]));
        expect(Array.from(m.load)).toEqual([0.2, NaN, 0.3, 0, 0.4, NaN, NaN, NaN, 0.5]);
        expect(m).toMatchObject({ zeroRunSlots: 3, outlierSlots: 1 });
    });

    it('fills from same hh and day type within ±14 days, widening to ±28, else base load', () => {
        const start = localMidnightUtc('2026-01-05'); // a Monday
        const n = 48 * 70;
        const local = buildLocalIndex(start, n);
        const load = new Float64Array(n);
        for (let t = 0; t < n; t++) {
            const wkend = local.dow[t] >= 5;
            load[t] = (wkend ? 1 : 0.5) + local.hh[t] / 1000 + local.day[t] / 1e6;
        }
        // 1) one weekday gap: donors are the weekdays within ±14 days at the same hh
        const g1 = Float64Array.from(load);
        const t1 = 30 * 48 + 20; // day 30 (a Wednesday), 10:00
        g1[t1] = NaN;
        const f1 = fillGaps(g1, local, 300);
        const donors = [];
        for (let d = 16; d <= 44; d++) if (d !== 30 && local.dow[d * 48] < 5) donors.push(load[d * 48 + 20]);
        donors.sort((a, b) => a - b);
        const med = donors.length % 2 ? donors[donors.length >> 1] : (donors[donors.length / 2 - 1] + donors[donors.length / 2]) / 2;
        expect(f1.load[t1]).toBeCloseTo(med, 12);
        expect(f1.filled[t1]).toBe(1);

        // 2) wipe ±14 days of that hh except 2 donors → widen to ±28
        const g2 = Float64Array.from(load);
        for (let d = 16; d <= 44; d++) if (d !== 17 && d !== 43) g2[d * 48 + 20] = NaN;
        const f2 = fillGaps(g2, local, 300);
        const wide = [];
        for (let d = 2; d <= 58; d++) if (local.dow[d * 48] < 5 && !Number.isNaN(g2[d * 48 + 20])) wide.push(load[d * 48 + 20]);
        expect(wide.length).toBeGreaterThanOrEqual(4);
        expect(f2.filled[t1]).toBe(1);
        expect(f2.load[t1]).toBeGreaterThan(0.5);

        // 3) no donors at all for that hh → base load
        const g3 = Float64Array.from(load);
        for (let d = 0; d < 70; d++) g3[d * 48 + 20] = NaN;
        const f3 = fillGaps(g3, local, 300);
        expect(f3.load[t1]).toBeCloseTo(0.15, 12);
    });

    it('extends short history backwards with the first 28 real days (loadFilled = 2)', () => {
        const load = new Float64Array(demo.n).fill(NaN);
        const realFrom = demo.n - 100 * 48;
        const local = buildLocalIndex(demo.start, demo.n);
        for (let t = realFrom; t < demo.n; t++) load[t] = local.dow[t] >= 5 ? 0.4 : 0.3;
        const d = buildDataset(demoParts(load));
        expect(d.meta.coverage.extrapolatedSlots).toBe(realFrom);
        expect(d.loadFilled[0]).toBe(2);
        expect(d.loadFilled[realFrom]).toBe(0);
        expect(d.load[0]).toBe(local.dow[0] >= 5 ? 0.4 : 0.3);
        expect(d.load.some(Number.isNaN)).toBe(false);
        expect(d.meta.notes.join(' ')).toMatch(/extrapolated/);
    });

    it('fills a weeks-long meter outage with the nearby household profile, not a flat base load', () => {
        const start = localMidnightUtc('2026-01-05');
        const n = 48 * 200;
        const local = buildLocalIndex(start, n);
        const shape = t => (local.dow[t] >= 5 ? 0.6 : 0.3) + 0.4 * Math.max(0, Math.sin(Math.PI * (local.hh[t] - 12) / 36));
        const load = Float64Array.from({ length: n }, (_, t) => shape(t));
        const h0 = 48 * 80, h1 = 48 * 140; // a 60-day hole, well inside the real span
        load.fill(NaN, h0, h1);
        const { load: out, filled } = fillGaps(load, local, 250); // base load 250 W = 0.125 kWh
        let worst = 0, flatBase = 0;
        for (let t = h0; t < h1; t++) {
            expect(filled[t]).toBe(1);
            worst = Math.max(worst, Math.abs(out[t] - shape(t)));
            if (Math.abs(out[t] - 0.125) < 1e-12) flatBase++;
        }
        expect(flatBase).toBe(0);
        expect(worst).toBeLessThan(1e-12); // the shape is periodic by (hh, day type), so donors match exactly
        // The 16:00–19:00 peak survives in the middle of the hole.
        const mid = h0 + 30 * 48;
        const day = local.day[mid];
        const peakSlot = local.days[day].first + 36, nightSlot = local.days[day].first + 6;
        expect(out[peakSlot]).toBeGreaterThan(out[nightSlot] + 0.2);
    });

    it('T6: 500 W + up to 2 kW spikes in 20 random slots a day → 500 ± 1 W; short days dropped; zeros ignored', () => {
        const start = localMidnightUtc('2026-01-05');
        const days = 120, n = 48 * days;
        const local = buildLocalIndex(start, n);
        let seed = 7;
        const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 2 ** 32; };
        const load = new Float64Array(n).fill(0.25);
        for (let d = 0; d < days; d++) {
            for (let k = 0; k < 20; k++) load[d * 48 + Math.floor(rnd() * 48)] += rnd() * 1.0; // ≤ 2 kW for 30 min
        }
        // Low-reading days that must be dropped (< 44 real slots), and zeros that must be ignored.
        for (let d = 10; d < 30; d++) { load.fill(NaN, d * 48, d * 48 + 10); load[d * 48 + 20] = 0.05; }
        for (let d = 40; d < 60; d++) load[d * 48 + 3] = 0;
        expect(Math.abs(realBaseLoadW(load, local) - 500)).toBeLessThan(1);
    });

    it('estimates base load from real slots only (zeros and gaps ignored)', () => {
        const start = localMidnightUtc('2026-02-02');
        const local = buildLocalIndex(start, 48 * 20);
        const load = new Float64Array(48 * 20).fill(0.25);
        for (let t = 0; t < load.length; t += 7) load[t] += 1; // spikes
        load[5] = 0;
        for (let t = 48 * 3; t < 48 * 3 + 10; t++) load[t] = NaN; // a day with 38 slots is dropped
        expect(realBaseLoadW(load, local)).toBeCloseTo(500, 9);
    });
});

describe('window choice', () => {
    const rowsBetween = (fromMs, toMs, skip = () => false) => {
        const out = [];
        for (let ms = fromMs; ms < toMs; ms += SLOT) if (!skip(ms)) out.push([ms, 0.3]);
        return out;
    };

    it('ends on the latest complete local day and spans 365 local days', () => {
        const rows = rowsBetween(Date.parse('2025-06-01T00:00:00Z'), Date.parse('2026-10-03T10:00:00Z'));
        const w = chooseWindow(rows);
        expect(w.lastDate).toBe('2026-10-02');
        expect(w.firstDate).toBe('2025-10-03');
        expect(w.start).toBe(localMidnightUtc('2025-10-03'));
        expect(w.n).toBe(17520);
    });

    it('a normal day needs ≥46 real slots, the 46-slot day ≥44, the 50-slot day ≥48', () => {
        const base = Date.parse('2026-03-20T00:00:00Z');
        const end29 = localMidnightUtc('2026-03-30');
        // 2026-03-29 has 46 slots; drop 2 → 44 real → still complete
        const r1 = rowsBetween(base, end29, ms => ms === localMidnightUtc('2026-03-29') || ms === localMidnightUtc('2026-03-29') + SLOT);
        expect(chooseWindow(r1, { days: 3 }).lastDate).toBe('2026-03-29');
        // drop 3 → 43 → not complete
        const r2 = rowsBetween(base, end29, ms => ms >= localMidnightUtc('2026-03-29') && ms < localMidnightUtc('2026-03-29') + 3 * SLOT);
        expect(chooseWindow(r2, { days: 3 }).lastDate).toBe('2026-03-28');
        // a normal day missing 3 slots is incomplete; zero runs don't count as real
        const r3 = rowsBetween(base, localMidnightUtc('2026-03-26'), ms => ms >= localMidnightUtc('2026-03-25') && ms < localMidnightUtc('2026-03-25') + 3 * SLOT);
        expect(chooseWindow(r3, { days: 3 }).lastDate).toBe('2026-03-24');
        const r4 = rowsBetween(base, localMidnightUtc('2026-03-26')).map(([ms, v]) => [ms, ms >= localMidnightUtc('2026-03-25') + 4 * SLOT && ms < localMidnightUtc('2026-03-25') + 7 * SLOT ? 0 : v]);
        expect(chooseWindow(r4, { days: 3 }).lastDate).toBe('2026-03-24');
    });

    it('drops readings from the install date onwards (endCapMs)', () => {
        const rows = rowsBetween(Date.parse('2025-01-01T00:00:00Z'), Date.parse('2026-10-03T00:00:00Z'));
        const w = chooseWindow(rows, { endCapMs: localMidnightUtc('2026-05-01') });
        expect(w.lastDate).toBe('2026-04-30');
        expect(() => chooseWindow([])).toThrow(DataError);
    });
});

describe('withBaseLoad, summarize, invariants', () => {
    it('withBaseLoad(ds, b, b) leaves load identical; a change shares every other array and gets a new id', () => {
        const same = withBaseLoad(ds, 560, 560);
        expect(Array.from(same.load)).toEqual(Array.from(ds.load));
        expect(same.id).toBe(ds.id);
        const less = withBaseLoad(ds, 560, 460);
        expect(less.id).not.toBe(ds.id);
        expect(less.importPrice).toBe(ds.importPrice);
        expect(less.ghi).toBe(ds.ghi);
        expect(less.local).toBe(ds.local);
        for (let t = 0; t < ds.n; t += 101) expect(less.load[t]).toBeCloseTo(Math.max(0, ds.load[t] - 0.05), 12);
        const zero = withBaseLoad(ds, 560, -10000);
        expect(Math.min(...zero.load)).toBe(0);
        expect(ds.load[0]).toBeGreaterThan(0.25); // original untouched
    });

    it('withBaseLoad ids differ whenever the load differs (results are cached by id)', () => {
        const a = withBaseLoad(ds, 560, 560.2), b = withBaseLoad(ds, 560, 560.4), c = withBaseLoad(ds, 560, 560.2);
        expect(a.load[0]).not.toBe(b.load[0]);
        expect(a.id).not.toBe(b.id);
        expect(a.id).toBe(c.id);
        expect(withBaseLoad(ds, 563.8, 300).id).not.toBe(withBaseLoad(ds, 563.8, 300.5).id);
    });

    it('gives the bundled climatology the same meanDim / year range fields as weather.js', () => {
        expect(ds.climatology.meanDim).toBeInstanceOf(Float64Array);
        expect(ds.climatology.meanDim[1]).toBeCloseTo(28.25, 12); // 5 leap years in 2006–2025
        expect(ds.climatology.meanDim[0]).toBe(31);
        expect([ds.climatology.fromYear, ds.climatology.toYear]).toEqual([2006, 2025]);
    });

    it('reports prices the API never published as a non-retryable error with the period', () => {
        const err = (() => {
            try { buildDataset(demoParts(new Float64Array(demo.n).fill(0.25), { importExc: [] })); } catch (e) { return e; }
        })();
        expect(err).toBeInstanceOf(DataError);
        expect(err).toMatchObject({ code: 'NETWORK', step: 'prices', retryable: false });
        expect(err.message).toMatch(/2025-10-01 – 2026-09-30/);
    });

    it('export prices: Prime synthesised by local clock, fixed 15p→12p, Agile floored, forward variants', () => {
        const at = iso => (Date.parse(iso) - ds.start) / SLOT;
        const { prime, fixed, agile } = ds.exportPrices;
        expect(prime[at('2026-01-15T16:00:00Z')]).toBe(16);
        expect(prime[at('2026-01-15T15:30:00Z')]).toBe(9);
        expect(prime[at('2026-07-01T15:00:00Z')]).toBe(16); // 16:00 BST
        expect(prime[at('2026-07-01T18:00:00Z')]).toBe(9); // 19:00 BST
        expect(fixed[at('2026-02-28T23:30:00Z')]).toBe(15);
        expect(fixed[at('2026-03-01T00:00:00Z')]).toBe(12);
        expect(ds.exportPricesFwd.fixed.every(v => v === 12)).toBe(true);
        expect(Array.from(ds.exportPricesFwd.prime)).toEqual(Array.from(prime));
        expect(Math.min(...agile)).toBe(0);
        expect(ds.exportPricesFwd.agile).toBe(agile);
        const noAgile = buildDataset(demoParts(new Float64Array(demo.n).fill(0.25), { exportAgile: null }));
        expect(noAgile.exportPrices.agile).toBeNull();
    });

    it('has no NaN anywhere and the contract fields', () => {
        const arrays = ['load', 'loadFilled', 'importPriceExc', 'importPrice', 'importPriceFwdExc', 'ghi', 'dni', 'dhi', 'tempC', 'windMs', 'wxSource'];
        for (const k of arrays) {
            expect(ds[k].length, k).toBe(ds.n);
            expect(ds[k].some(v => !Number.isFinite(v)), k).toBe(false);
        }
        for (const k of ['prime', 'fixed', 'agile']) {
            expect(ds.exportPrices[k].some(v => !Number.isFinite(v))).toBe(false);
            expect(ds.exportPricesFwd[k].some(v => !Number.isFinite(v))).toBe(false);
        }
        expect(ds.ghi).toBeInstanceOf(Float32Array);
        expect(ds.wxSource).toBeInstanceOf(Uint8Array);
        expect(ds.climatology.monthlyKwhM2).toBeInstanceOf(Float64Array);
        expect(ds.climatology.years).toBeInstanceOf(Int16Array);
        expect(ds.climatology.yearMonthlyKwhM2.length).toBe(ds.climatology.years.length * 12);
        expect(ds.standing).toEqual([{ fromMs: ds.start, toMs: ds.start + ds.n * SLOT, pPerDayExc: 37.6525 }]);
        expect(ds.meta).toMatchObject({ source: 'demo', region: 'C', postcode: 'SW1A 1AA', priceBasis: 'mine', serverW: 500 });
        expect(ds.meta.weather.counts).toEqual([17134, 382, 2, 2, 0]);
        expect(ds.altitude).toBe(16);
    });

    it('summarize gives a small structured-clone-safe description', () => {
        const s = summarize(ds);
        expect(s).toMatchObject({
            id: ds.id, n: 17520, days: 365, from: '2025-10-01', to: '2026-09-30', region: 'C', regionName: 'London',
            postcode: 'SW1A 1AA', source: 'demo', tariffCode: 'E-1R-AGILE-24-10-01-C', priceBasis: 'mine', serverW: 500,
        });
        expect(s.coverage).toEqual({ realPct: 100, filledSlots: 0, extrapolatedSlots: 0, days: 365 });
        expect(structuredClone(s)).toEqual(s);
    });

    it('DataError carries code, default action and serialises for the worker', () => {
        const e = new DataError('WEATHER', 'Sunshine missing');
        expect(e).toBeInstanceOf(Error);
        expect(e.toJSON()).toEqual({ name: 'DataError', code: 'WEATHER', message: 'Sunshine missing', step: null, retryable: true, action: 'retry', choices: null });
        expect(new DataError('LOCATION', 'x').action).toBe('setPostcode');
        expect(new DataError('ACCOUNT', 'x', { choices: ['A-1'] }).choices).toEqual(['A-1']);
    });
});

describe('location', () => {
    it('uses lat/lon directly, geocodes postcodes, falls back to outcode then the region centre', async () => {
        expect(await resolveLocation({ lat: 51.5, lon: -0.1 }, {})).toMatchObject({ lat: 51.5, lon: -0.1, locationSource: 'latlon' });
        await expect(resolveLocation({ lat: 40, lon: -0.1 }, {})).rejects.toMatchObject({ code: 'LOCATION' });
        const f = mockFetch({
            'https://api.postcodes.io/postcodes/SW1A1AA': () => json({ status: 200, result: { postcode: 'SW1A 1AA', latitude: 51.50101, longitude: -0.141563 } }),
            'https://api.postcodes.io/postcodes/': () => json({ status: 404, error: 'Invalid postcode' }, 404),
            'https://api.postcodes.io/outcodes/SW9': () => json({ status: 200, result: { outcode: 'SW9', latitude: 51.47, longitude: -0.11 } }),
            'https://api.postcodes.io/outcodes/': () => json({ status: 404 }, 404),
        });
        expect(await resolveLocation({ postcode: 'sw1a 1aa' }, { fetch: f })).toMatchObject({ lat: 51.50101, lon: -0.141563, postcode: 'SW1A 1AA', locationSource: 'postcode' });
        const out = await resolveLocation({ postcode: 'SW9 9ZZ' }, { fetch: f });
        expect(out).toMatchObject({ lat: 51.47, locationSource: 'outcode' });
        const cen = await resolveLocation({ postcode: 'XX1 1XX' }, { fetch: f, region: 'P' });
        expect(cen).toMatchObject({ locationSource: 'region-centroid' });
        expect(cen.notes[0]).toMatch(/centre of your region/);
        await expect(resolveLocation({ postcode: 'XX1 1XX' }, { fetch: f })).rejects.toMatchObject({ code: 'LOCATION', action: 'setPostcode' });
        expect(f.calls.every(c => !c.init.headers?.Authorization)).toBe(true);
    });
});

describe('loadDataset orchestration (mocked network)', () => {
    const NOW = Date.parse('2026-10-05T12:00:00Z');
    const KEY = 'sk_live_ORCHESTRATE';
    const agileF = ms => 12 + ((ms / SLOT) % 48) / 4;
    const stubWeather = async ({ start, n }) => ({
        ghi: new Float32Array(n).fill(100), dni: new Float32Array(n).fill(50), dhi: new Float32Array(n).fill(60),
        tempC: new Float32Array(n).fill(11), windMs: new Float32Array(n).fill(3), wxSource: new Uint8Array(n),
        meta: { counts: [n, 0, 0, 0, 0], sarahLastMs: start + (n - 1) * SLOT, ifsScaled: false, gridLat: 51.5, gridLon: -0.15, notes: [] },
    });
    const stubClim = async () => ({ monthlyKwhM2: new Float64Array(12).fill(90), years: Int16Array.of(2025), yearMonthlyKwhM2: new Float64Array(12).fill(90), gridLat: 51.5, gridLon: -0.15 });

    function octopusRoutes() {
        const old = consumptionRows(Date.parse('2025-09-20T00:00:00Z'), Date.parse('2026-01-12T00:00:00Z'),
            ms => (ms >= Date.parse('2026-01-10T00:00:00Z') ? 0 : 0.25));
        const neu = consumptionRows(Date.parse('2026-01-08T00:00:00Z'), Date.parse('2026-10-03T10:00:00Z'), () => 0.3, { asString: true });
        const window0 = Date.parse('2025-09-01T00:00:00Z'), window1 = Date.parse('2026-10-07T00:00:00Z');
        return {
            '/v1/accounts/A-1A2B3C4D/': (url, init) => (init.headers.Authorization ? json(accountBody()) : json({ detail: 'no' }, 401)),
            '/v1/electricity-meter-points/1200000000001/meters/19L0000001/consumption/': consumptionEndpoint(old),
            '/v1/electricity-meter-points/1200000000001/meters/23J0000002/consumption/': consumptionEndpoint(neu),
            '/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standard-unit-rates/': rateEndpoint([
                interval('2025-06-30T23:00:00Z', null, 24.0, 'DIRECT_DEBIT'), interval('2025-06-30T23:00:00Z', null, 25.2, 'NON_DIRECT_DEBIT')]),
            '/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standing-charges/': rateEndpoint([interval('2025-01-01T00:00:00Z', null, 41.0, 'DIRECT_DEBIT')]),
            '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/': rateEndpoint(halfHourly(window0, window1, agileF)),
            '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standing-charges/': rateEndpoint([interval('2024-09-30T23:00:00Z', null, 37.6525)]),
            '/v1/products/AGILE-OUTGOING-19-05-13/': rateEndpoint(halfHourly(window0, window1, ms => ((ms / SLOT) % 20) - 3)),
            '/v1/products/OUTGOING-PRIME-FIX-12M-26-06-23/': rateEndpoint([]),
            '/v1/products/OUTGOING-VAR-24-10-26/': rateEndpoint([interval('2024-10-26T00:00:00Z', '2026-03-01T00:00:00Z', 15), interval('2026-03-01T00:00:00Z', null, 12)]),
            '/v1/products/': url => json({ count: 2, next: null, results: [
                { code: 'AGILE-24-10-01', direction: 'IMPORT', available_from: '2024-10-01T00:00:00+01:00' },
                { code: 'AGILE-OUTGOING-19-05-13', direction: 'EXPORT', available_from: '2019-05-13T00:00:00+01:00' }] }),
            'https://api.postcodes.io/postcodes/': () => json({ status: 200, result: { postcode: 'SW1A 1AA', latitude: 51.50101, longitude: -0.141563 } }),
        };
    }

    it('octopus: account → merged usage → per-agreement prices → export → weather → dataset', async () => {
        const f = mockFetch(octopusRoutes());
        const events = [];
        // The store passes empty location fields: the account's postcode must still be used.
        const d = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'a-1a2b3c4d', location: { postcode: '', lat: null, lon: null } }, {
            fetch: f, nowMs: NOW, sleep: () => Promise.resolve(), onProgress: e => events.push(e),
            deps: { fetchWeather: stubWeather, fetchClimatology: stubClim },
        });
        expect(d.n).toBe(17520);
        expect(d.local.days[0].date).toBe('2025-10-03');
        expect(d.local.days[364].date).toBe('2026-10-02');
        // Meter exchange: the new meter's 0.3 wins the overlap; the old meter's stale zeros never sum or win.
        const at = iso => (Date.parse(iso) - d.start) / SLOT;
        expect(d.load[at('2025-12-01T12:00:00Z')]).toBe(0.25);
        expect(d.load[at('2026-01-09T12:00:00Z')]).toBe(0.3);
        expect(d.load[at('2026-01-11T12:00:00Z')]).toBe(0.3);
        expect(d.meta.coverage.realPct).toBe(100);
        // Two agreements, each priced with its own tariff; DIRECT_DEBIT preferred.
        expect(d.meta.tariffs.map(t => t.product)).toEqual(['VAR-22-11-01', 'AGILE-24-10-01']);
        expect(d.importPriceExc[at('2026-01-14T12:00:00Z')]).toBe(24.0);
        expect(d.importPriceExc[at('2026-01-15T12:00:00Z')]).toBe(agileF(Date.parse('2026-01-15T12:00:00Z')));
        // Forward = today's Agile on every slot, levy-adjusted before April 2026.
        expect(d.importPriceFwdExc[at('2026-01-14T12:00:00Z')]).toBeCloseTo(agileF(Date.parse('2026-01-14T12:00:00Z')) - LEVY_EXC_P, 10);
        expect(d.importPriceFwdExc[at('2026-06-14T12:00:00Z')]).toBe(agileF(Date.parse('2026-06-14T12:00:00Z')));
        expect(d.standing.map(s => s.pPerDayExc)).toEqual([41.0, 37.6525]);
        expect(Math.min(...d.exportPrices.agile)).toBe(0);
        expect(d.exportPrices.fixed[at('2026-02-01T12:00:00Z')]).toBe(15);
        expect(d.meta).toMatchObject({ source: 'octopus', region: 'C', postcode: 'SW1A 1AA', locationSource: 'postcode', priceBasis: 'mine' });
        expect(d.lat).toBe(51.50101);
        expect(d.climatology.monthlyKwhM2[0]).toBe(90);
        expect(d.meta.createdAtMs).toBe(NOW);
        const done = events.filter(e => e.status === 'done').map(e => e.step);
        for (const s of ['account', 'usage', 'prices', 'export', 'weather', 'climatology', 'build']) expect(done).toContain(s);
        // The key only ever goes to api.octopus.energy.
        for (const c of f.calls) if (c.init.headers?.Authorization) expect(c.url.origin).toBe('https://api.octopus.energy');
        expect(f.calls.some(c => c.url.hostname === 'api.postcodes.io')).toBe(true);
        expect(f.maxInFlight).toBe(1);
    });

    it('octopus: installedSolarDate drops later slots and needs 180 days before it', async () => {
        const f = mockFetch(octopusRoutes());
        const ctx = { fetch: f, nowMs: NOW, sleep: () => Promise.resolve(), deps: { fetchWeather: stubWeather, fetchClimatology: stubClim } };
        const d = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D', installedSolarDate: '2026-07-01' }, ctx);
        expect(d.local.days[d.local.days.length - 1].date).toBe('2026-06-30');
        expect(d.meta.coverage.extrapolatedSlots).toBeGreaterThan(0); // history starts 2025-09-20, so ~2 months were extended
        await expect(loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D', installedSolarDate: '2026-02-01' }, ctx))
            .rejects.toMatchObject({ code: 'TOO_LITTLE_DATA', step: 'usage' });
    });

    it('octopus: a meter that stopped communicating months ago still gets a full year of REAL readings', async () => {
        const stops = Date.parse('2026-07-01T00:00:00Z'); // SMETS comms lost; NOW is 2026-10-05
        const rows = consumptionRows(Date.parse('2025-03-01T00:00:00Z'), stops, () => 0.3);
        const f = mockFetch({
            ...octopusRoutes(),
            '/v1/accounts/A-1A2B3C4D/': () => json(accountBody({ serials: ['19L0000001'] })),
            '/v1/electricity-meter-points/1200000000001/meters/19L0000001/consumption/': consumptionEndpoint(rows),
            '/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standard-unit-rates/': rateEndpoint([interval('2024-06-30T23:00:00Z', null, 24.0, 'DIRECT_DEBIT')]),
            '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/': rateEndpoint(halfHourly(Date.parse('2025-06-01T00:00:00Z'), Date.parse('2026-10-07T00:00:00Z'), agileF)),
        });
        const d = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D' }, {
            fetch: f, nowMs: NOW, sleep: () => Promise.resolve(), deps: { fetchWeather: stubWeather, fetchClimatology: stubClim },
        });
        expect(d.local.days.at(-1).date).toBe('2026-06-30');
        expect(d.n).toBe(17520);
        expect(d.meta.coverage).toMatchObject({ realPct: 100, extrapolatedSlots: 0, filledSlots: 0 });
        const reads = f.calls.filter(c => c.url.pathname.endsWith('/consumption/'));
        expect(reads).toHaveLength(2); // the usual 372 days, then the stretch before them
    });

    it('octopus: surfaces AUTH and NO_SMART_DATA with the failing step', async () => {
        const routes = octopusRoutes();
        const bad = mockFetch({ ...routes, '/v1/accounts/A-1A2B3C4D/': () => json({ detail: 'Invalid API key.' }, 401) });
        const events = [];
        const e1 = await loadDataset({ kind: 'octopus', apiKey: 'sk_live_x', accountNumber: 'A-1A2B3C4D' }, { fetch: bad, nowMs: NOW, onProgress: e => events.push(e) }).catch(e => e);
        expect(e1).toMatchObject({ code: 'AUTH', step: 'account', action: 'checkKey' });
        expect(events.at(-1)).toMatchObject({ step: 'account', status: 'error' });
        const empty = mockFetch({
            ...routes,
            '/v1/electricity-meter-points/1200000000001/meters/19L0000001/consumption/': consumptionEndpoint([]),
            '/v1/electricity-meter-points/1200000000001/meters/23J0000002/consumption/': consumptionEndpoint([]),
        });
        await expect(loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D' }, { fetch: empty, nowMs: NOW }))
            .rejects.toMatchObject({ code: 'NO_SMART_DATA', step: 'usage', action: 'useDemo' });
    });

    it('csv: parses, prices on today\'s Agile for the region, extends a short history', async () => {
        const f = mockFetch(octopusRoutes());
        let text = 'Consumption (kWh), Start, End\n';
        for (let ms = Date.parse('2026-06-01T00:00:00Z'); ms < Date.parse('2026-10-01T00:00:00Z'); ms += SLOT) {
            text += ` 0.4, ${new Date(ms).toISOString()}, ${new Date(ms + SLOT).toISOString()}\n`;
        }
        const d = await loadDataset({ kind: 'csv', text, location: { postcode: 'SW1A 1AA' }, region: 'C' }, {
            fetch: f, nowMs: NOW, deps: { fetchWeather: stubWeather, fetchClimatology: stubClim },
        });
        expect(d.meta.source).toBe('csv');
        expect(d.meta.priceBasis).toBe('agile');
        expect(d.meta.tariffs[0].product).toBe('AGILE-24-10-01');
        expect(d.n).toBe(17520);
        expect(d.meta.coverage.extrapolatedSlots).toBeGreaterThan(17520 / 2);
        expect(d.load.every(v => Math.abs(v - 0.4) < 1e-12)).toBe(true);
    });

    it('manual: synthetic profile from base W + other kWh, priced for the region', async () => {
        const f = mockFetch(octopusRoutes());
        const d = await loadDataset({ kind: 'manual', baseW: 300, otherKwhYr: 2000, location: { lat: 51.5, lon: -0.12 }, region: 'C', priceBasis: 'agile' }, {
            fetch: f, nowMs: NOW, deps: { fetchWeather: stubWeather, fetchClimatology: stubClim },
        });
        expect(d.meta.source).toBe('manual');
        const total = sum(d.load);
        expect(total).toBeCloseTo((300 * 8.76 + 2000) * d.n / 17520, 6);
        expect(d.meta.baseLoadW).toBeGreaterThan(299);
        expect(d.meta.baseLoadW).toBeLessThan(330);
    });

    it('manual/csv: derives the region from a map point via reverse geocoding', async () => {
        const f = mockFetch({
            ...octopusRoutes(),
            'https://api.postcodes.io/postcodes?': () => json({ status: 200, result: [{ postcode: 'SW1A 2DX', latitude: 51.5069, longitude: -0.1278 }] }),
            '/v1/industry/grid-supply-points/': url => json({ count: 1, next: null, results: url.searchParams.get('postcode') === 'SW1A2DX' ? [{ group_id: '_C' }] : [] }),
        });
        const d = await loadDataset({ kind: 'manual', baseW: 200, otherKwhYr: 1500, location: { lat: 51.5072, lon: -0.1276 } }, {
            fetch: f, nowMs: NOW, deps: { fetchWeather: stubWeather, fetchClimatology: stubClim },
        });
        expect(d.meta.region).toBe('C');
        expect(d.meta.locationSource).toBe('latlon');
        await expect(loadDataset({ kind: 'manual', baseW: 200, otherKwhYr: 1500, location: {} }, { fetch: f, nowMs: NOW }))
            .rejects.toMatchObject({ code: 'LOCATION', action: 'setPostcode' });
    });

    it('flat basis: fetches standing charges only (no year of unit rates), prices every slot at flatP', async () => {
        const f = mockFetch(octopusRoutes());
        const d = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D', priceBasis: 'flat', flatP: 24.5 }, {
            fetch: f, nowMs: NOW, sleep: () => Promise.resolve(), deps: { fetchWeather: stubWeather, fetchClimatology: stubClim },
        });
        expect(d.meta.priceBasis).toBe('flat');
        expect(d.importPriceExc.every(v => v === 24.5)).toBe(true);
        expect(d.importPriceFwdExc.every(v => v === 24.5)).toBe(true);
        expect(d.standing.map(s => s.pPerDayExc)).toEqual([41.0, 37.6525]);
        const importRates = f.calls.filter(c => c.url.pathname.endsWith('/standard-unit-rates/') && !/OUTGOING/.test(c.url.pathname));
        // the only unit-rate request is the one-page Flexible comparison (insights.flexible), never a year of Agile
        expect(importRates.map(c => c.url.pathname)).toEqual(['/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standard-unit-rates/']);
    });
    it('Flexible for the same window: two small requests, Direct Debit records, stretched to the window; a failure only drops it', async () => {
        const f = mockFetch(octopusRoutes());
        const ctx = { fetch: f, nowMs: NOW, sleep: () => Promise.resolve(), deps: { fetchWeather: stubWeather, fetchClimatology: stubClim } };
        const d = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D' }, ctx);
        expect(d.flexible).toMatchObject({ product: 'VAR-22-11-01', code: 'E-1R-VAR-22-11-01-C' });
        expect(d.flexible.unit).toEqual([{ fromMs: d.start, toMs: d.start + d.n * SLOT, exc: 24.0 }]);
        expect(d.flexible.standing).toEqual([{ fromMs: d.start, toMs: d.start + d.n * SLOT, pPerDayExc: 41.0 }]);
        expect(summarize(d).flexible).toEqual({ product: 'VAR-22-11-01', code: 'E-1R-VAR-22-11-01-C' });
        const flexCalls = f.calls.filter(c => /VAR-22-11-01\/electricity-tariffs\/E-1R-VAR-22-11-01-C\/(standard-unit-rates|standing-charges)/.test(c.url.pathname));
        expect(flexCalls.length).toBeGreaterThanOrEqual(2);
        // Flexible down: the dataset still loads, without the comparison
        const routes = octopusRoutes();
        const broken = { ...routes };
        for (const k of Object.keys(broken)) if (k.startsWith('/v1/products/VAR-22-11-01/')) broken[k] = () => json({ detail: 'boom' }, 404);
        const priced = { ...broken, '/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standard-unit-rates/': routes['/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standard-unit-rates/'] };
        const d2 = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D', priceBasis: 'agile' }, { ...ctx, fetch: mockFetch(broken) });
        expect(d2.flexible).toBeNull();
        expect(d2.n).toBe(17520);
        // unit rates without standing charges still compare (standing then unknown)
        const d3 = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D', priceBasis: 'agile' }, { ...ctx, fetch: mockFetch(priced) });
        expect(d3.flexible.unit).toHaveLength(1);
        expect(d3.flexible.standing).toEqual([]);
    });

    it('accepts a lower-case or underscored region, and tags window errors with the usage step', async () => {
        const f = mockFetch(octopusRoutes());
        let text = 'start,kwh\n';
        for (let ms = Date.parse('2026-06-01T00:00:00Z'); ms < Date.parse('2026-09-01T00:00:00Z'); ms += SLOT) text += `${new Date(ms).toISOString()},0.3\n`;
        const ctx = { fetch: f, nowMs: NOW, deps: { fetchWeather: stubWeather, fetchClimatology: stubClim } };
        const d = await loadDataset({ kind: 'csv', text, location: { postcode: 'SW1A 1AA' }, region: '_c' }, ctx);
        expect(d.meta.region).toBe('C');
        // 30-minute readings (explicit End) for only every other half-hour: no complete day exists.
        let sparse = 'start,end,kwh\n';
        for (let ms = Date.parse('2026-06-01T00:00:00Z'); ms < Date.parse('2026-09-01T00:00:00Z'); ms += 2 * SLOT) {
            sparse += `${new Date(ms).toISOString()},${new Date(ms + SLOT).toISOString()},0.3\n`;
        }
        const events = [];
        const err = await loadDataset({ kind: 'csv', text: sparse, location: { postcode: 'SW1A 1AA' }, region: 'C' }, { ...ctx, onProgress: e => events.push(e) }).catch(e => e);
        expect(err).toMatchObject({ code: 'TOO_LITTLE_DATA', step: 'usage' });
        expect(events.at(-1)).toMatchObject({ step: 'usage', status: 'error' });
    });

    it('ends the period earlier when the newest days have no sunshine data yet, cutting usage and prices to match', async () => {
        const cutoff = Date.parse('2026-10-01T00:00:00Z');
        const calls = [];
        const laggingWeather = async (a) => {
            calls.push(a.n);
            if (a.start + a.n * SLOT > cutoff) {
                throw Object.assign(new Error('No weather data for 20 daylight half-hours'), { name: 'DataError', code: 'WEATHER', retryable: true, action: 'retry' });
            }
            return stubWeather(a);
        };
        const f = mockFetch(octopusRoutes());
        const events = [];
        const d = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D' }, {
            fetch: f, nowMs: NOW, sleep: () => Promise.resolve(), onProgress: e => events.push(e),
            deps: { fetchWeather: laggingWeather, fetchClimatology: stubClim },
        });
        expect(calls).toEqual([17520, 17424]); // window ended 2026-10-02 → 2 days dropped
        expect(d.n).toBe(17424);
        expect(d.local.days.at(-1).date).toBe('2026-09-30');
        expect(d.start + d.n * SLOT).toBeLessThanOrEqual(cutoff);
        for (const k of ['load', 'importPrice', 'importPriceFwdExc', 'ghi']) expect(d[k].some(v => !Number.isFinite(v)), k).toBe(false);
        expect(Math.max(...d.meta.tariffs.map(t => t.toMs))).toBe(d.start + d.n * SLOT);
        expect(Math.max(...d.standing.map(s => s.toMs))).toBe(d.start + d.n * SLOT);
        expect(d.meta.notes.join(' ')).toMatch(/period ends 2 days earlier/);
        expect(events.some(e => e.step === 'weather' && e.status === 'error')).toBe(false);

        // A hole that isn't at the end keeps failing: give up after three tries with the step tagged.
        const always = async () => { throw Object.assign(new Error('no data'), { name: 'DataError', code: 'WEATHER' }); };
        const err = await loadDataset({ kind: 'octopus', apiKey: KEY, accountNumber: 'A-1A2B3C4D' }, {
            fetch: mockFetch(octopusRoutes()), nowMs: NOW, sleep: () => Promise.resolve(), deps: { fetchWeather: always, fetchClimatology: stubClim },
        }).catch(e => e);
        expect(err).toMatchObject({ code: 'WEATHER', step: 'weather' });
    });

    it('manual: refuses an all-zero profile up front with an actionable message', async () => {
        const err = await loadDataset({ kind: 'manual', baseW: 0, otherKwhYr: 0, location: { lat: 51.5, lon: -0.12 }, region: 'C' }, { fetch: mockFetch({}), nowMs: NOW }).catch(e => e);
        expect(err).toBeInstanceOf(DataError);
        expect(err).toMatchObject({ code: 'TOO_LITTLE_DATA', step: 'usage' });
        expect(err.message).toMatch(/always-on/);
    });

    it('demo: fetches data/demo.json relative to the module', async () => {
        let asked = null;
        const f = async (url) => { asked = String(url); return new Response(readFileSync(DEMO_PATH, 'utf8'), { status: 200 }); };
        const d = await loadDataset({ kind: 'demo', serverW: 300 }, { fetch: f });
        expect(asked).toMatch(/projects\/solar-calculator\/data\/demo\.json$/);
        expect(d.meta.serverW).toBe(300);
        expect(d.id).not.toBe(ds.id);
    });
});
