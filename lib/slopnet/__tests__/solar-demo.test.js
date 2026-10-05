import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { syntheticLoad, mulberry32 } from '../../../projects/solar-calculator/js/demo.js';
import { demoDatasetFromJson, realBaseLoadW } from '../../../projects/solar-calculator/js/dataset.js';
import { buildLocalIndex } from '../../../projects/solar-calculator/js/time.js';

const DATA = p => fileURLToPath(new URL(`../../../projects/solar-calculator/data/${p}`, import.meta.url));
let demo, local;

beforeAll(() => {
    demo = JSON.parse(readFileSync(DATA('demo.json'), 'utf8'));
    local = buildLocalIndex(demo.start, demo.n);
});

const sum = a => a.reduce((s, v) => s + v, 0);

describe('syntheticLoad', () => {
    it('is deterministic for a seed and differs between seeds', () => {
        const a = syntheticLoad(local, { serverW: 500, seed: 1 });
        const b = syntheticLoad(local, { serverW: 500, seed: 1 });
        const c = syntheticLoad(local, { serverW: 500, seed: 2 });
        expect(Array.from(a)).toEqual(Array.from(b));
        expect(Array.from(a)).not.toEqual(Array.from(c));
        const r1 = mulberry32(7), r2 = mulberry32(7);
        for (let i = 0; i < 5; i++) expect(r1()).toBe(r2());
    });

    it('adds a constant server load to a household that totals householdKwhYr per year', () => {
        const a = syntheticLoad(local, { serverW: 500, seed: 1 });
        const house = sum(Array.from(a, v => v - 0.25));
        expect(house).toBeCloseTo(2700, 6);
        expect(Math.min(...a)).toBeGreaterThan(0.25);
        const b = syntheticLoad(local, { serverW: 0, householdKwhYr: 4000, seed: 1 });
        expect(sum(Array.from(b))).toBeCloseTo(4000, 6);
        expect(Math.min(...b)).toBeGreaterThan(0);
    });

    it('has weekday morning/evening peaks, a winter-heavy season and different weekends', () => {
        const a = syntheticLoad(local, { serverW: 0, seed: 1 });
        const mean = (pred) => { let s = 0, c = 0; for (let t = 0; t < a.length; t++) if (pred(t)) { s += a[t]; c++; } return s / c; };
        const wkday = t => local.dow[t] < 5, wkend = t => local.dow[t] >= 5;
        const at = (t, h) => local.hh[t] === h;
        expect(mean(t => wkday(t) && at(t, 36))).toBeGreaterThan(2 * mean(t => wkday(t) && at(t, 24))); // 18:00 vs 12:00
        expect(mean(t => wkday(t) && at(t, 14))).toBeGreaterThan(2 * mean(t => wkday(t) && at(t, 6))); // 07:00 vs 03:00
        expect(mean(t => wkend(t) && at(t, 24))).toBeGreaterThan(1.5 * mean(t => wkday(t) && at(t, 24))); // weekend lunch
        const dec = mean(t => local.month[t] === 11), jun = mean(t => local.month[t] === 5);
        expect(dec).toBeGreaterThan(1.2 * jun);
        // Lighting falls in the 16–19 window in winter but not in summer.
        const decPeak = mean(t => local.month[t] === 11 && local.peak[t]), junPeak = mean(t => local.month[t] === 5 && local.peak[t]);
        expect(decPeak / dec).toBeGreaterThan(junPeak / jun);
    });

    it('puts the always-on estimate a little above serverW (standby + fridge), or at it without the floor', () => {
        const withFloor = realBaseLoadW(syntheticLoad(local, { serverW: 500, seed: 1 }), local);
        expect(withFloor).toBeGreaterThan(530);
        expect(withFloor).toBeLessThan(600);
        const noFloor = realBaseLoadW(syntheticLoad(local, { serverW: 300, householdKwhYr: 2000, seed: 1, householdFloor: false }), local);
        expect(noFloor).toBeGreaterThan(299);
        expect(noFloor).toBeLessThan(330);
    });
});

describe('data/demo.json', () => {
    it('is compact and complete', () => {
        const kb = statSync(DATA('demo.json')).size / 1024;
        expect(kb).toBeLessThan(600);
        expect(demo).toMatchObject({ version: 1, n: 17520, region: 'C', postcode: 'SW1A 1AA', tariffCode: 'E-1R-AGILE-24-10-01-C', standingPPerDayExc: 37.6525 });
        expect(demo.start).toBe(Date.parse('2025-09-30T23:00:00Z'));
        for (const k of ['importExc', 'exportAgile', 'ghi', 'dni', 'dhi', 'tempC', 'windMs', 'wxSource']) {
            expect(demo[k], k).toHaveLength(17520);
            expect(demo[k].every(Number.isFinite), k).toBe(true);
        }
        expect(demo.ghi.every(Number.isInteger) && demo.dni.every(Number.isInteger) && demo.dhi.every(Number.isInteger)).toBe(true);
        const dp = (arr, d) => arr.every(v => Math.abs(Math.round(v * 10 ** d) - v * 10 ** d) < 1e-6);
        expect(dp(demo.importExc, 2) && dp(demo.exportAgile, 2)).toBe(true);
        expect(dp(demo.tempC, 1) && dp(demo.windMs, 1)).toBe(true);
        expect(Math.min(...demo.exportAgile)).toBe(0);
        expect(demo.attribution).toMatch(/Open-Meteo/);
        expect(demo.attribution).toMatch(/SARAH-3/);
        expect(demo.attribution).toMatch(/Octopus/);
        expect(demo.climatology.monthlyKwhM2).toHaveLength(12);
        expect(demo.climatology.years[0]).toBe(2006);
        expect(demo.climatology.years.at(-1)).toBe(2025);
        // Matches the verified 2006–2025 London climatology (research, ±0.06 rounding).
        const verified = [25.7, 40.3, 81.4, 125.3, 148.3, 159.9, 159.7, 132.6, 95.2, 56.7, 30.8, 20.5];
        demo.climatology.monthlyKwhM2.forEach((v, m) => expect(Math.abs(v - verified[m])).toBeLessThan(0.06));
    });
});

describe('demoDatasetFromJson', () => {
    it('is deterministic, and serverW changes the load and id but not prices or weather', () => {
        const a = demoDatasetFromJson(demo, { serverW: 500, seed: 1 });
        const b = demoDatasetFromJson(demo, { serverW: 500, seed: 1 });
        expect(a.id).toBe(b.id);
        expect(Array.from(a.load)).toEqual(Array.from(b.load));
        expect(Array.from(a.importPrice)).toEqual(Array.from(b.importPrice));
        const c = demoDatasetFromJson(demo, { serverW: 200, seed: 1 });
        expect(c.id).not.toBe(a.id);
        expect(Array.from(c.importPrice)).toEqual(Array.from(a.importPrice));
        for (let t = 0; t < a.n; t += 777) expect(a.load[t] - c.load[t]).toBeCloseTo(0.15, 12);
        expect(a.meta.notes[0]).toMatch(/synthetic/);
        expect(a.meta.coverage.realPct).toBe(100);
    });

    it('builds the demo dataset quickly', () => {
        const t0 = performance.now();
        demoDatasetFromJson(demo, { serverW: 500 });
        expect(performance.now() - t0).toBeLessThan(500);
    });
});

describe('catalog data files', () => {
    const kits = () => JSON.parse(readFileSync(DATA('kits.json'), 'utf8'));
    const stations = () => JSON.parse(readFileSync(DATA('stations.json'), 'utf8'));
    const bundles = () => JSON.parse(readFileSync(DATA('bundles.json'), 'utf8'));
    const constants = () => JSON.parse(readFileSync(DATA('constants.json'), 'utf8'));

    it('kits keep provenance and the fields the app needs', () => {
        const k = kits().kits;
        expect(k).toHaveLength(29);
        expect(new Set(k.map(x => x.id)).size).toBe(29);
        for (const x of k) {
            for (const f of ['id', 'kind', 'installRoute', 'priceGbp', 'priceDate', 'priceSource', 'confidence', 'notes']) expect(x[f], `${x.id}.${f}`).toBeDefined();
            expect('availableNow' in x).toBe(true);
        }
        const oct = k.find(x => x.id === 'octopus-plugin-solar-2x460');
        expect(oct).toMatchObject({ priceGbp: 650, acLimitW: 800, mppts: 2, enaRef: 'OCTOQ/21124/V1/A5' });
        expect(oct.exportTariff.productCode).toBe('OUTGOING-PRIME-FIX-12M-26-06-23');
        expect(oct.pvInputs).toHaveLength(2);
        expect(k.find(x => x.id === 'cityplumbing-dmegc-2x515-hiflow').inverterEffBasis).toMatch(/weighted/);
    });

    it('stations: 18 verified entries with availability, fixed loss and structured PV inputs', () => {
        const s = stations();
        expect(s.stations).toHaveLength(18);
        const d3 = s.stations.find(x => x.id === 'ecoflow-delta-3-plus');
        expect(d3).toMatchObject({ priceGbp: 599, usableKwh: 1.024, acChargeW: 1500, availableNow: true, pvWireablePanels: 2 });
        expect(d3.pvInputs.every(i => i.vocMaxV === 60)).toBe(true);
        expect(s.stations.find(x => x.id === 'bluetti-elite-300').fixedLossW).toBe(11);
        expect(s.stations.find(x => x.id === 'ecoflow-delta-3-max-plus')).toMatchObject({ availableNow: false, preorder: true });
        for (const x of s.stations) {
            expect(typeof x.availability).toBe('string');
            expect(Array.isArray(x.pvInputs)).toBe(true);
            expect(x.pvVoltageRange).toBeDefined();
        }
        expect(s.defaults).toMatchObject({ etaInv: 0.94, chargeEff: 0.88, bypassW: 8 });
    });

    it('bundles reference real catalog entries and carry explicit prices', () => {
        const ids = new Set(kits().kits.map(x => x.id));
        const b = bundles().bundles;
        expect(b.map(x => [x.id, x.base, x.priceGbp])).toEqual([
            ['ecoflow-stream-ultra+4x500', 'ecoflow-stream-ultra', 1499],
            ['ecoflow-stream-ultra-x+4x500', 'ecoflow-stream-ultra-x', 1649],
        ]);
        for (const x of b) {
            expect(ids.has(x.base)).toBe(true);
            expect(ids.has(x.panels.catalogId)).toBe(true);
            expect(x.panels).toMatchObject({ count: 4, wp: 500 });
            // The price is quoted in the verified catalog's own text for the base unit.
            const base = kits().kits.find(k => k.id === x.base);
            expect(base.notes).toContain(`GBP ${x.priceGbp.toLocaleString('en-GB')}`);
        }
    });

    it('constants keep the legal limits and export tariffs', () => {
        const c = constants();
        expect(c.plugInRules).toMatchObject({ acMaxVA: 800, dcMaxWp: 2000, maxModules: 4, batteriesAllowed: false });
        expect(c.installCostDefaultsGbp.electricianDedicatedCircuit.default).toBe(350);
        expect(c.exportTariffs.outgoingPrime).toMatchObject({ peakPence: 16, offPeakPence: 9 });
        expect(c.exportTariffs.outgoingFlat.pence).toBe(12);
    });
});
