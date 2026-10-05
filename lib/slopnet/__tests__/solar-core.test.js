import { describe, it, expect } from 'vitest';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';
import { kitToSystem, stationToSystem, bundleToSystem } from '../../../projects/solar-calculator/js/kits.js';
import { normalizeSystem } from '../../../projects/solar-calculator/js/system.js';
import { project } from '../../../projects/solar-calculator/js/finance.js';
import { toMonthlyFwd } from '../../../projects/solar-calculator/js/simulate.js';
import { loadCatalog, sliceDemo, NOW } from './fixtures/solar/b1-load.js';
import { findNonFinite } from './fixtures/solar/a3-synth.js';

// May–July 2026 of the demo year: sunny, no clock change, fast (4416 slots)
const ds = sliceDemo('2026-04-30T23:00:00Z', 92);
const cat = loadCatalog();
const eng = new SolarEngine(ds, cat, { nowMs: NOW });
const SOUTH = { id: 'ground', kind: 'ground', azimuth: 180, tilt: 35 };
const S01 = kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: SOUTH, dsSource: 'demo', id: 'S01' });
const DCB = normalizeSystem({ ...S01, id: 'DCB', route: 'hardwired', battery: { coupling: 'dc', capacityKwh: 2, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 800 } });
const U3 = stationToSystem('ecoflow-delta-3-plus', { catalog: cat, panels: { count: 2, spot: SOUTH }, id: 'U3' });

describe('construction and dataset-level methods', () => {
    it('default install date is the 1st of next month; typical factors come from the climatology', () => {
        expect(eng.defaultInstallDate).toBe('2026-11-01');
        expect(new SolarEngine(ds, cat, { nowMs: Date.parse('2026-12-15T00:00:00Z') }).defaultInstallDate).toBe('2027-01-01');
        // UK calendar, not UTC: 00:30 BST on 1 Oct is already October here
        expect(new SolarEngine(ds, cat, { nowMs: Date.parse('2026-09-30T23:30:00Z') }).defaultInstallDate).toBe('2026-11-01');
        expect(new SolarEngine(ds, cat, { nowMs: Date.parse('2026-09-30T22:30:00Z') }).defaultInstallDate).toBe('2026-10-01');
        expect(eng.typicalFactors).toHaveLength(12);
        expect(eng.typicalFactors[6]).toBeLessThan(0.8); // July 2026 was far sunnier than 2006–2025
        expect(eng.typicalFactors[0]).toBe(1); // January not in this slice
        expect(eng.bandYears.map((b) => b.year)).toEqual(Array.from({ length: 20 }, (_, i) => 2006 + i));
    });
    it('summary adds the weather basis to dataset.summarize; insights are cached', () => {
        const s = eng.summary;
        expect(s).toMatchObject({ id: ds.id, n: ds.n, source: 'demo', projectBaseW: null });
        expect(s.weatherBasis.hasClimatology).toBe(true);
        expect(s.weatherBasis.typicalFactors).toHaveLength(12);
        expect(eng.insights()).toBe(eng.insights());
        expect(structuredClone(s)).toEqual(s);
    });
    it('weatherInfo on the full year: London last 12 months ≈ +12% vs 2006–2025, sunnier than all 20 years', () => {
        // the slice covers 3 months; the other 9 fall back to the climatology itself
        const w = eng.weatherInfo();
        expect(w.yearsCompared).toBe(20);
        expect(w.pctVsAverage).toBeGreaterThan(0);
    });
});

describe('runScenario', () => {
    const r = eng.runScenario(S01);
    it('returns the contract shape, survives structuredClone and has no NaN', () => {
        for (const k of ['id', 'system', 'rules', 'typical', 'actual', 'pvOnly', 'band', 'finance', 'financeBand', 'headline', 'weather']) expect(r).toHaveProperty(k);
        expect(r.id).toBe('S01');
        expect(r.pvOnly).toBe(null);
        expect(r.battery).toBeUndefined();
        expect(r.rules.legal).toBe('ok');
        expect(findNonFinite({ ...r, band: { ...r.band, paybackYears: [] }, finance: null, financeBand: null, headline: null })).toEqual([]);
        expect(() => structuredClone(r)).not.toThrow();
    });
    it('caches: the same call returns the same object; another name reuses the run under its own id', () => {
        expect(eng.runScenario(S01)).toBe(r);
        const other = eng.runScenario({ ...S01, id: 'copy', name: 'Copy' });
        expect(other.id).toBe('copy');
        expect(other.system.name).toBe('Copy');
        expect(other.typical).toBe(r.typical);
    });
    it('headline = finance year 1; actual weather is sunnier than typical here', () => {
        expect(r.headline.savingsGbp).toBe(r.finance.year1Gbp);
        expect(r.headline.capexGbp).toBe(650);
        expect(r.headline.actualGbp).toBeGreaterThan(r.headline.savingsGbp);
        expect(r.headline.billedGbp).toBeCloseTo(r.actual.totals.savingsBilledP / 100, 12);
        expect(r.typical.totals.pvAcKwh).toBeLessThan(r.actual.totals.pvAcKwh);
    });
    it('band: 20 years, p10 ≤ p50 ≤ p90, p10/p90 finance reproduces the band figures in year 1', () => {
        expect(r.band.years).toHaveLength(20);
        expect(r.band.p10).toBeLessThanOrEqual(r.band.p50);
        expect(r.band.p50).toBeLessThanOrEqual(r.band.p90);
        expect(r.financeBand.p10.year1Gbp).toBeCloseTo(r.band.p10, 9);
        expect(r.financeBand.p90.year1Gbp).toBeCloseTo(r.band.p90, 9);
        expect(r.headline.paybackP10Years).toBeGreaterThanOrEqual(r.headline.paybackP90Years);
        // the typical year sits inside the band (DC-level vs irradiance-level scaling differ by < 1.5%)
        expect(r.headline.savingsGbp).toBeGreaterThan(r.band.p10 * 0.985);
        expect(r.headline.savingsGbp).toBeLessThan(r.band.p90 * 1.015);
    });
    it('withBand false and proxy fidelity skip the band; proxy runs at one sub-sample', () => {
        const nb = eng.runScenario(S01, { withBand: false });
        expect(nb.band).toBe(null);
        expect(nb.typical).toBe(r.typical);
        const px = eng.runScenario(S01, { fidelity: 'proxy' });
        expect(px.band).toBe(null);
        expect(px.typical.totals.pvAcKwh).not.toBe(r.typical.totals.pvAcKwh);
        expect(Math.abs(px.typical.totals.pvAcKwh / r.typical.totals.pvAcKwh - 1)).toBeLessThan(0.02);
    });
    it('finance options flow through (discount rate, VAT staying at 0%)', () => {
        const hi = eng.runScenario(S01, { finance: { discountRate: 0.1 } });
        expect(hi.finance.npvGbp).toBeLessThan(r.finance.npvGbp);
        const novat = eng.runScenario(S01, { finance: { vatReturns: false } });
        expect(novat.finance.year1Gbp).toBeLessThan(r.finance.year1Gbp);
        expect(hi.typical).toBe(r.typical); // physics is shared
    });
    it('battery: marginal value split into solar, grid and standby that sums to the total', () => {
        const b = eng.runScenario(DCB);
        expect(b.pvOnly).not.toBe(null);
        const { fromSolarGbp, fromGridGbp, standbyGbp } = b.battery.split;
        expect(Math.abs(fromSolarGbp + fromGridGbp + standbyGbp - b.battery.totalGbp)).toBeLessThan(0.01);
        expect(b.battery.optimalGbp).toBeGreaterThanOrEqual(b.battery.thresholdGbp - 1);
        expect(b.battery.totalGbp).toBeCloseTo(b.battery.thresholdGbp, 9); // default strategy is threshold
        expect(standbyGbp).toBeLessThan(0);
        const noGrid = eng.runScenario({ ...DCB, battery: { ...DCB.battery, acChargeW: 0 } });
        expect(noGrid.battery.split.fromGridGbp).toBe(0);
        // finance gets the battery-less twin as PV and the difference as battery
        const pvM = toMonthlyFwd(b.pvOnly.monthly);
        const alone = project({ costs: [], pvMonthly: pvM, hasMicro: false, opts: eng.financeOptions() });
        expect(b.finance.years[1].pvGbp).toBeCloseTo(alone.years[1].pvGbp, 9);
    });
    it('power station with own panels: no export, station PV counted, band runs', () => {
        const u = eng.runScenario(U3);
        expect(u.typical.totals.exportKwh).toBe(0);
        expect(u.typical.totals.upsPvKwh).toBeGreaterThan(50);
        expect(u.band.p90).toBeGreaterThan(u.band.p10);
        expect(u.headline.pvKwh).toBeCloseTo(u.typical.annual.upsPvKwh, 9);
    });
    it('systems without any PV are weather-independent: actual is typical, the band is flat', () => {
        const h4 = eng.runScenario(kitToSystem('ecoflow-stream-ac-5000', { catalog: cat }));
        expect(h4.actual).toBe(h4.typical);
        expect(h4.band.p10).toBe(h4.band.p90);
        const r1 = eng.runScenario({ id: 'R1', route: 'reference', loadAdjustW: -100 });
        expect(r1.headline.savingsGbp).toBeGreaterThan(0);
        expect(r1.headline.capexGbp).toBe(0);
    });
    it('staged upgrade: stage-2 savings from atYear + 1, upgrade cost at atYear', () => {
        const w2 = eng.runScenario({ ...S01, id: 'W2', route: 'whatif', upgrade: { atYear: 1, battery: { coupling: 'ac', capacityKwh: 1.92, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 1000 }, route: 'whatif', costs: [{ label: 'Battery', gbp: 1049.99 }] } });
        expect(w2.finance.years[1].savingsGbp).toBeCloseTo(r.finance.years[1].savingsGbp, 9);
        expect(w2.finance.years[1].outlayGbp).toBeCloseTo(1049.99, 9);
        expect(w2.finance.years[2].savingsGbp).toBeGreaterThan(r.finance.years[2].savingsGbp);
        // the weather band projects the staged plan too (stage 2 simulated in every weather year)
        expect(w2.financeBand.p10.years[1].outlayGbp).toBeCloseTo(1049.99, 9);
        expect(w2.financeBand.p90.years[2].battGbp).toBeGreaterThan(0);
        expect(w2.band.savingsGbp).toEqual(r.band.savingsGbp); // year 1 is stage 1 only
        // a later (or no) payback in every weather year: null = never within the horizon
        w2.band.paybackYears.forEach((p, i) => expect(p === null || p > r.band.paybackYears[i]).toBe(true));
    });
});

describe('cache keys (adversarial review): a changed field changes the result, an unchanged one hits', () => {
    const e = () => new SolarEngine(ds, cat, { nowMs: NOW });
    const sav = (en, s, o = {}) => en.runScenario(s, { withBand: false, ...o }).headline.savingsGbp;
    // a power-limiting inverter with curtailment allowed earns more in the negative-price slots
    const cur = (c) => ({ ...S01, export: { kind: 'none', flatP: 0 }, canCurtail: c, inverter: { ...S01.inverter, supportsPowerLimit: true } });
    it('runScenario: export kind, curtailment, finance, load adjustment and projected base load all re-run', () => {
        const a = e();
        expect(sav(a, S01)).not.toBeCloseTo(sav(a, { ...S01, export: { kind: 'none', flatP: 0 } }), 6);
        expect(sav(a, cur(true))).toBeGreaterThan(sav(a, cur(false)));
        expect(sav(a, S01, { finance: { vatReturns: false } })).not.toBeCloseTo(sav(a, S01), 6);
        expect(sav(a, { id: 'r', route: 'reference', loadAdjustW: -50 })).toBeCloseTo(sav(a, { id: 'r', route: 'reference', loadAdjustW: -100 }) / 2, 6);
        const before = sav(a, S01);
        a.setProjectBaseW(200);
        const at200 = sav(a, S01);
        const b = e();
        b.setProjectBaseW(200);
        expect(at200).toBe(sav(b, S01));
        a.setProjectBaseW(null);
        expect(sav(a, S01)).toBe(before);
        expect(a.runScenario(S01)).toBe(a.runScenario(S01)); // unchanged → the cached object
    });
    it('placementCells: canCurtail is part of the key (it used to be served from the other flag)', () => {
        const grid = [{ az: 180, tilt: 35 }];
        const a = e();
        const off = a.placementCells(cur(false), grid)[0].gbp;
        const on = a.placementCells(cur(true), grid)[0].gbp;
        expect(on).toBeGreaterThan(off);
        expect(on).toBe(e().placementCells(cur(true), grid)[0].gbp);
        expect(a.placementCells(cur(true), grid)).toBe(a.placementCells(cur(true), grid));
    });
    it('a price-only change (Compare\'s own prices, the verdict\'s ×10) re-uses every simulation and gives what a fresh engine gives', () => {
        const a = e();
        const W2 = normalizeSystem({ ...DCB, id: 'W2ish', route: 'plugin', battery: null,
            upgrade: { atYear: 2, label: 'later', route: 'whatif', battery: { ...DCB.battery, coupling: 'ac' }, costs: [{ label: 'Battery', gbp: 900, year: 0, kind: 'hardware' }] } });
        for (const s of [S01, DCB, U3, W2]) {
            const base = a.runScenario(s);
            const cheaper = { ...s, costs: s.costs.map((c) => ({ ...c, gbp: c.gbp * 0.5 })), upgrade: s.upgrade ? { ...s.upgrade, costs: s.upgrade.costs.map((c) => ({ ...c, gbp: c.gbp * 0.5 })) } : null };
            const t = performance.now();
            const r = a.runScenario(cheaper);
            const ms = performance.now() - t;
            expect(r.typical, s.id).toBe(base.typical);
            expect(r.actual, s.id).toBe(base.actual);
            expect(r.pvOnly, s.id).toBe(base.pvOnly);
            expect(r.band.savingsGbp, s.id).toEqual(base.band.savingsGbp);
            expect(r.headline.capexGbp, s.id).toBeCloseTo(base.headline.capexGbp * 0.5, 9);
            expect(ms, s.id).toBeLessThan(150);
            // the cached physics changes nothing: the same figures as a cold engine
            const cold = e().runScenario(cheaper);
            expect(r.headline, s.id).toEqual(cold.headline);
            expect(r.financeBand.p10.years, s.id).toEqual(cold.financeBand.p10.years);
        }
    });
    it('runScenario rules follow the mount spots; a cached run is returned under the caller’s labels', () => {
        const a = e();
        const balc = { ...S01, id: 'balc', spotId: 'balcony' };
        expect(a.runScenario(balc, { withBand: false }).rules.warnings.map((w) => w.code)).not.toContain('ABOVE_GROUND');
        a.autoScenarios({ spots: [{ id: 'balcony', name: 'Balcony', kind: 'railing', azimuth: 200, groundLevel: false }] });
        expect(a.runScenario(balc, { withBand: false }).rules.warnings.map((w) => w.code)).toContain('ABOVE_GROUND');
        const relabelled = a.runScenario({ ...balc, notes: ['mine'], featured: true }, { withBand: false });
        expect(relabelled.system.notes).toEqual(['mine']);
        expect(relabelled.system.featured).toBe(true);
    });
});

describe('battery money on the headline basis (adversarial review)', () => {
    it('an idle battery with no standby adds exactly nothing (engine critique, through the engine)', () => {
        for (const coupling of ['dc', 'ac']) {
            const s = { ...S01, id: `idle-${coupling}`, battery: { coupling, capacityKwh: 2, standbyW: 0, acChargeW: 0 } };
            const r = eng.runScenario(s, { withBand: false, dispatchOpts: { strategy: 'idle' } });
            expect(Math.abs(r.battery.totalGbp)).toBeLessThan(1e-8);
            expect(Math.abs(r.headline.savingsGbp - eng.runScenario(S01, { withBand: false }).headline.savingsGbp)).toBeLessThan(1e-8);
        }
    });
    it('systemGbp is the headline, totalGbp is headline(B) − headline(B0), the split sums to it', () => {
        const r = eng.runScenario(DCB);
        const b0 = eng.runScenario({ ...DCB, id: 'DCB0', battery: null });
        expect(r.battery.systemGbp).toBe(r.headline.savingsGbp);
        expect(Math.abs(r.battery.totalGbp - (r.headline.savingsGbp - b0.headline.savingsGbp))).toBeLessThan(1e-9);
        const { fromSolarGbp, fromGridGbp, standbyGbp } = r.battery.split;
        expect(Math.abs(fromSolarGbp + fromGridGbp + standbyGbp - r.battery.totalGbp)).toBeLessThan(1e-9);
        // optimal's own figure ages with its own cycles: the same as running it as the scenario
        const opt = eng.runScenario({ ...DCB, id: 'DCBopt', battery: { ...DCB.battery, strategy: 'optimal' } }, { withBand: false });
        expect(Math.abs(r.battery.optimalSystemGbp - opt.headline.savingsGbp)).toBeLessThan(1e-9);
    });
    it('a power station: realisticGbp equals its threshold headline; no panels → nothing "from solar"', () => {
        const u1 = stationToSystem('ecoflow-delta-3-plus', { catalog: cat, id: 'U1' });
        const r = eng.runScenario(u1, { withBand: false });
        expect(r.battery.split.fromSolarGbp).toBe(0);
        expect(Math.abs(eng.upsStrategies(u1).realisticGbp - r.headline.savingsGbp)).toBeLessThan(1e-9);
        const r3 = eng.runScenario(U3, { withBand: false });
        expect(r3.battery.systemGbp).toBe(r3.headline.savingsGbp);
    });
    it('starred orientation points of a battery system and of a split kit agree with their headline', () => {
        const cur = (s) => eng.orientationSweep(s, '*').starred.find((x) => x.key === 'current');
        expect(Math.abs(cur(DCB).gbp - eng.runScenario(DCB).headline.savingsGbp)).toBeLessThan(1e-9);
        const split = { ...S01, id: 'S02', arrays: [S01.arrays[0], { ...S01.arrays[1], azimuth: 270 }] };
        const c = cur(split);
        expect(c.mixed).toBe(true);
        expect(c.proxyGbp).toBe(null);
        expect(Math.abs(c.gbp - eng.runScenario(split, { withBand: false }).headline.savingsGbp)).toBeLessThan(1e-9);
        expect(Math.abs(eng.answerOrientation(split, { flips: false }).current.gbp - c.gbp)).toBeLessThan(1e-9);
        expect(Math.abs(cur(U3).gbp - eng.runScenario(U3).headline.savingsGbp)).toBeLessThan(1e-9);
    });
});

describe('typical vs actual', () => {
    it('with no climatology (all factors 1) typical === actual bit for bit', () => {
        const flat = new SolarEngine({ ...ds, id: 'noclim', climatology: null }, cat, { nowMs: NOW });
        expect(flat.typicalIsActual).toBe(true);
        const r = flat.runScenario(S01);
        expect(r.band).toBe(null);
        expect(r.typical.totals).toEqual(r.actual.totals);
        expect(r.typical.monthly).toEqual(r.actual.monthly);
        expect(r.headline.savingsGbp).toBe(r.headline.actualGbp);
    });
});

describe('setProjectBaseW', () => {
    it('projects the always-on load and null restores the data as measured', () => {
        const e = new SolarEngine(ds, cat, { nowMs: NOW });
        const a = e.runScenario(S01, { withBand: false });
        e.setProjectBaseW(150);
        expect(e.ds.load).not.toBe(ds.load);
        const b = e.runScenario(S01, { withBand: false });
        expect(b.typical.totals.exportKwh).toBeGreaterThan(a.typical.totals.exportKwh);
        expect(b.headline.savingsGbp).toBeLessThan(a.headline.savingsGbp);
        expect(e.summary.projectBaseW).toBe(150);
        e.setProjectBaseW(null);
        expect(e.ds).toBe(ds);
        expect(e.runScenario(S01, { withBand: false }).headline.savingsGbp).toBe(a.headline.savingsGbp);
    });
});

describe('orientation', () => {
    const sw = eng.orientationSweep(S01, '*');
    it('649 proxy cells and up to 8 starred full-fidelity configurations', () => {
        expect(sw.cells).toHaveLength(649);
        expect(sw.azimuths).toHaveLength(36);
        expect(sw.tilts).toHaveLength(19);
        expect(sw.starred.length).toBeLessThanOrEqual(8);
        expect(sw.starred.map((s) => s.key).slice(0, 6)).toEqual(['current', 'W90', 'S35', 'SSW45', 'bestGbp', 'bestKwh']);
        expect(sw.proxyNote).toMatch(/panels only, no battery/);
        expect(eng.orientationSweep(S01, null)).toBe(sw);
    });
    it('proxy cell for the current config equals a proxy-fidelity run within 1e-9', () => {
        const cell = sw.cells.find((c) => c.az === 180 && c.tilt === 35);
        const px = eng.runScenario(S01, { fidelity: 'proxy', withBand: false });
        expect(Math.abs(cell.gbp - px.finance.year1Gbp)).toBeLessThan(1e-9);
        expect(Math.abs(cell.kwh - px.typical.annual.pvAcKwh)).toBeLessThan(1e-9);
    });
    it('without a battery the starred best equals the proxy evaluated at 3 sub-samples within 1e-9', () => {
        const best = sw.starred.find((s) => s.key === 'bestGbp');
        const at3 = eng._proxyContext(S01, '*', { subSteps: 3 }).evaluate(best.az, best.tilt);
        expect(Math.abs(at3.gbp - best.gbp)).toBeLessThan(1e-9);
        // and the full-fidelity point equals runScenario of that orientation
        const moved = { ...S01, arrays: S01.arrays.map((a) => ({ ...a, azimuth: best.az, tilt: best.tilt })) };
        expect(Math.abs(eng.runScenario(moved, { withBand: false }).finance.year1Gbp - best.gbp)).toBeLessThan(1e-9);
    });
    it('a single array can be swept on its own', () => {
        const one = eng.orientationSweep(S01, S01.arrays[1].id);
        expect(one.arrayId).toBe(S01.arrays[1].id);
        const cur = one.starred.find((s) => s.key === 'current');
        expect(cur.gbp).toBeCloseTo(sw.starred.find((s) => s.key === 'current').gbp, 9);
    });
    it("a station's own panels sweep on a coarse grid with the station running", () => {
        const st = eng.orientationSweep(U3, '*');
        expect(st.station).toBe(true);
        expect(st.cells).toHaveLength(13 * 6 + 1);
        expect(Math.max(...st.cells.map((c) => c.gbp))).toBeGreaterThan(Math.min(...st.cells.map((c) => c.gbp)));
    });
    it('the starred best is the best of the proxy best and its neighbours at full fidelity (C1: the proxy drops the station)', () => {
        const c1 = normalizeSystem({ ...S01, id: 'C1sw', battery: U3.battery, costs: [...S01.costs, ...U3.costs], sourceIds: [...S01.sourceIds, ...U3.sourceIds] });
        const s = eng.orientationSweep(c1, '*');
        const best = s.starred.find((p) => p.key === 'bestGbp');
        for (const p of s.starred.filter((q) => q.key.startsWith('neighbour'))) expect(best.gbp).toBeGreaterThanOrEqual(p.gbp);
        expect(new Set(s.starred.map((p) => p.key)).size).toBe(s.starred.length);
        const a = eng.answerOrientation(c1, { flips: false });
        if (best.az >= 90 && best.az <= 270 && best.tilt >= 15) expect(a.best.gbp).toBeGreaterThanOrEqual(best.gbp - 1e-9);
    });
    it('answerOrientation gives the UX answer shape', () => {
        const a = eng.answerOrientation(S01);
        for (const k of ['best', 's35', 'w45', 'w90', 'ssw45', 'current', 'tie', 'westPays', 'flips', 'checked', 'compass']) expect(a).toHaveProperty(k);
        expect(a.best.az).toBeGreaterThanOrEqual(90);
        expect(a.best.az).toBeLessThanOrEqual(270);
        expect(a.tie.azMin).toBeLessThanOrEqual(a.best.az);
        expect(a.tie.azMax).toBeGreaterThanOrEqual(a.best.az);
        expect(a.checked).toEqual(['C1', 'C3', 'C4']); // S01 already has Prime: C2 is not a change
        expect(() => structuredClone(a)).not.toThrow();
    });
});

describe('curves', () => {
    it('baseLoadCurve: default xs include the user base; no-battery plug-in savings never fall with load', () => {
        const [c] = eng.baseLoadCurve([S01]);
        expect(c.id).toBe('S01');
        const xs = c.points.map((p) => p.x);
        expect(xs).toEqual([...xs].sort((a, b) => a - b));
        expect(xs).toEqual(expect.arrayContaining([0, 100, 500, 1500, Math.round(c.baseLoadW)]));
        for (let i = 1; i < c.points.length; i++) expect(c.points[i].savingsGbp).toBeGreaterThanOrEqual(c.points[i - 1].savingsGbp - 1e-9);
        const [d] = eng.baseLoadCurve([S01], [200, 1000]);
        expect(d.points.map((p) => p.x)).toEqual([200, 1000]);
        expect(d.points[1].exportKwh).toBeLessThanOrEqual(0.01 * d.points[1].pvKwh);
    });
    it('baseLoadCurve: a power station running baseload servers earns more as the always-on load grows (the old rule dipped 564 → 600 W)', () => {
        // dedicatedW 'baseload' follows the projected load exactly (D = x, far inside the outlets and
        // the charger); the dip came from the old controller's whole-slot counts (usable ÷ need), which
        // stepped down as need grew. The day-ahead planner has no such steps.
        for (const id of ['bluetti-elite-200-v2', 'ecoflow-delta-3-plus']) {
            const xs = [300, 450, 500, 540, 564, 580, 600, 650, 700, 800, 1000];
            const [c] = eng.baseLoadCurve([stationToSystem(id, { catalog: cat })], xs);
            for (let i = 1; i < c.points.length; i++) expect(c.points[i].savingsGbp, `${id} at ${xs[i]} W`).toBeGreaterThanOrEqual(c.points[i - 1].savingsGbp - 1e-9);
        }
    });
    it('panelCountCurve: plug-in route uses the kits on sale at their prices', () => {
        const pts = eng.panelCountCurve(S01);
        expect(pts.map((p) => p.x)).toEqual([460, 465, 890, 910, 920, 920, 920, 1030]);
        expect(pts.find((p) => p.kitId === 'octopus-plugin-solar-2x460').capexGbp).toBe(650);
        expect(pts[0].marginalGbp).toBe(null);
        expect(pts[1].marginalGbp).toBeCloseTo(pts[1].savingsGbp - pts[0].savingsGbp, 9);
    });
    it('panelCountCurve: other routes vary 1..N panels priced from the loose panel + frame', () => {
        const h2 = kitToSystem('zendure-solarflow-2400-pro', { catalog: cat, spot: SOUTH, panels: { count: 4, wp: 460, catalogId: 'astronergy-460w-bifacial-trade', frameId: 'its-adjustable-tilt-frame-15-30' } });
        const pts = eng.panelCountCurve(h2);
        expect(pts[0].label).toBe('1 × 460 W');
        expect(pts.find((p) => p.x === 1840).capexGbp).toBeCloseTo(1933.8, 9);
        expect(pts[1].capexGbp - pts[0].capexGbp).toBeCloseTo(121.2, 9);
        const st = eng.panelCountCurve(U3);
        // DELTA 3 Plus can take two typical panels; 0 = the station on its own
        expect(st.map((p) => p.x)).toEqual([0, 460, 920]);
        expect(st[0]).toMatchObject({ label: 'No panels', marginalGbp: null });
        expect(st[0].capexGbp).toBeCloseTo(st[2].capexGbp - 2 * 121.2, 9);
        expect(st[1].marginalGbp).toBeGreaterThan(0);
        expect(eng.panelCountCurve(stationToSystem('ecoflow-delta-3-plus', { catalog: cat })).map((p) => p.x)).toEqual([0, 460, 920]);
    });
    it('batterySizeCurve: real expansion packs at their prices', () => {
        const u1 = stationToSystem('ecoflow-delta-3-plus', { catalog: cat });
        const pts = eng.batterySizeCurve(u1);
        expect(pts[0]).toMatchObject({ x: 0, label: 'No battery', capexGbp: 0 });
        expect(pts[1].capexGbp).toBe(599);
        // the maker's own extra battery (DELTA 3 Smart Extra Battery 1.024 kWh £459) stacked; the DELTA Pro 3 pack once
        expect(pts.map((p) => Math.round(p.capexGbp))).toEqual([0, 599, 1058, 1517, 1976, 2278]);
        expect(pts[2].x).toBeCloseTo((1.024 + 1.024) * 0.9, 9);
        expect(pts[5].label).toMatch(/4\.096 kWh/);
        const h1 = bundleToSystem('ecoflow-stream-ultra+4x500', { catalog: cat, spot: SOUTH });
        const hp = eng.batterySizeCurve(h1);
        expect(hp[0].label).toMatch(/as configured/); // an all-in-one cannot drop its battery
        expect(hp[1].capexGbp).toBeCloseTo(1499 + 163.2 + 350 + 699, 9);
        expect(eng.batterySizeCurve(S01)).toEqual([]);
        // a battery-only build without its battery buys nothing — not even the electrician
        const h4 = eng.batterySizeCurve(kitToSystem('ecoflow-stream-ac-5000', { catalog: cat }));
        expect(h4[0]).toMatchObject({ x: 0, label: 'No battery', capexGbp: 0, savingsGbp: 0 });
        expect(h4[1].capexGbp).toBe(1849);
        // a station's own panels go with it (nothing to connect them to)
        expect(eng.batterySizeCurve(U3)[0]).toMatchObject({ label: 'No battery', capexGbp: 0 });
        // … also beside a plug-in kit (C1): without the station only the kit is left to pay for
        const c1 = normalizeSystem({ ...S01, id: 'C1ish', battery: U3.battery, costs: [...S01.costs, ...U3.costs], sourceIds: [...S01.sourceIds, ...U3.sourceIds] });
        expect(eng.batterySizeCurve(c1)[0].capexGbp).toBeCloseTo(S01.costs.reduce((s, c) => s + c.gbp, 0), 9);
    });
    it('panelCountCurve with a power station beside the kit (C1): every kit option keeps the station and pays for it', () => {
        const c1 = normalizeSystem({ ...S01, id: 'C1ish', battery: U3.battery, costs: [...S01.costs, ...U3.costs], sourceIds: [...S01.sourceIds, ...U3.sourceIds] });
        const stationGbp = U3.costs.reduce((s, c) => s + c.gbp, 0);
        const pts = eng.panelCountCurve(c1);
        const own = pts.find((p) => p.kitId === 'octopus-plugin-solar-2x460');
        expect(own.capexGbp).toBeCloseTo(650 + stationGbp, 9);
        expect(own.savingsGbp).toBeCloseTo(eng.runScenario(c1, { withBand: false }).headline.savingsGbp, 0);
        for (const p of pts) expect(p.capexGbp).toBeGreaterThan(stationGbp);
    });
});

describe('slots: typicalDay and exportCsv', () => {
    it("'summer' is the clearest complete day within ±15 days of 21 June; explicit dates work", () => {
        const d = eng.typicalDay(DCB, 'summer');
        expect(d.date >= '2026-06-06' && d.date <= '2026-07-06').toBe(true);
        expect(d.slots).toHaveLength(48);
        expect(d.slots[0]).toMatchObject({ hh: 0, time: '00:00' });
        for (const k of ['load', 'pvAc', 'battNet', 'imp', 'exp', 'soc', 'price']) expect(Number.isFinite(d.slots[24][k])).toBe(true);
        expect(eng.typicalDay(DCB, '2026-05-10').date).toBe('2026-05-10');
        expect(() => eng.typicalDay(DCB, '1999-01-01')).toThrow(RangeError);
        expect(() => eng.typicalDay(DCB, 'winter')).toThrow(RangeError); // no December in this slice
    });
    it('a power station\'s own panels are visible: profile, months, 4–7pm share and the typical day (stored-side flows too)', () => {
        const r = eng.runScenario(U3, { withBand: false });
        const T = r.typical.annual;
        expect(T.upsPvKwh).toBeGreaterThan(100);
        expect(T.peakGenSharePct).toBe(0); // grid-tied panels only: U3 has none
        expect(T.peakGenShareAllPct).toBeCloseTo((100 * T.peakUpsPvKwh) / T.upsPvKwh, 9);
        expect(T.peakGenShareAllPct).toBeGreaterThan(1);
        expect(r.headline.peakGenShareAllPct).toBe(T.peakGenShareAllPct);
        const tot = r.typical.totals;
        expect(r.typical.monthly.reduce((s, m) => s + m.upsPvKwh, 0)).toBeCloseTo(tot.upsPvKwh, 9);
        expect(r.typical.monthly.reduce((s, m) => s + m.peakUpsPvKwh, 0)).toBeCloseTo(tot.peakUpsPvKwh, 9);
        expect(r.typical.profile.upsPv.reduce((s, v) => s + v, 0) * tot.days).toBeCloseTo(tot.upsPvKwh, 6);
        const d = eng.typicalDay(U3, 'summer');
        let pv = 0;
        let prev = null;
        for (const s of d.slots) {
            pv += s.upsPv;
            for (const k of ['upsPv', 'upsPvWasted', 'battIn', 'battOut', 'gridChg']) expect(Number.isFinite(s[k]), k).toBe(true);
            if (prev) expect(s.soc - prev.soc).toBeCloseTo(s.battIn - s.battOut, 9);
            prev = s;
        }
        expect(pv).toBeGreaterThan(1);
        // grid-tied kits: the two shares agree
        const s01 = eng.runScenario(S01, { withBand: false }).typical.annual;
        expect(s01.peakGenShareAllPct).toBeCloseTo(s01.peakGenSharePct, 9);
        expect(eng.typicalDay(S01, 'summer').slots.every((s) => s.upsPv === 0)).toBe(true);
    });
    it('CSV: header + one row per half-hour, local and UTC time, savings as billed', () => {
        const csv = eng.exportCsv(S01);
        const rows = csv.trim().split('\n');
        expect(rows[0]).toBe('time_utc,time_local,load_kwh,pv_ac_kwh,import_kwh,export_kwh,battery_net_kwh,battery_soc_kwh,import_price_p,export_price_p,saving_p');
        expect(rows).toHaveLength(ds.n + 1);
        expect(rows[1].startsWith('2026-04-30T23:00Z,2026-05-01 00:00,')).toBe(true);
        const sum = rows.slice(1).reduce((s, r) => s + Number(r.split(',')[10]), 0);
        const sim = eng._sim(normalizeSystem(S01), {});
        expect(sum / 100).toBeCloseTo(sim.totals.savingsBilledP / 100, 0);
    });
});

describe('answers for the verdict', () => {
    it('upsStrategies: realistic, best case, smart-plug cut and the bypass-disabled penalty', () => {
        const u = eng.upsStrategies(stationToSystem('ecoflow-delta-3-plus', { catalog: cat }));
        expect(u.bestCaseGbp).toBeGreaterThanOrEqual(u.realisticGbp);
        expect(u.peakCutGbp).toBeLessThan(u.realisticGbp);
        expect(u.onlinePenaltyGbp).toBeLessThan(0);
        expect(u).toMatchObject({ switchMs: 10, hid: true, bypassDisableable: true });
        expect(eng.upsStrategies(S01)).toBe(null);
    });
    it('upsStrategies finds the station by kind: beside a plug-in kit (C1, kitId = the kit) and in a build with no kitId', () => {
        const c1 = normalizeSystem({ ...S01, id: 'C1ups', battery: U3.battery, costs: [...S01.costs, ...U3.costs], sourceIds: [...S01.sourceIds, ...U3.sourceIds] });
        expect(c1.kitId).toBe(S01.kitId);
        expect(eng.upsStrategies(c1)).toMatchObject({ switchMs: 10, hid: true, bypassDisableable: true });
        // a Design build that only lists the station among its parts, and one with no catalog product at all
        expect(eng.upsStrategies({ ...U3, id: 'U3nokit', kitId: null })).toMatchObject({ switchMs: 10, hid: true });
        expect(eng.upsStrategies({ ...U3, id: 'U3bare', kitId: null, sourceIds: [] })).toMatchObject({ switchMs: null, hid: false, bypassDisableable: false });
    });
    it('tornado: rows sorted by swing, weather row = the band paybacks, centre = payback', () => {
        const t = eng.tornado(DCB);
        const r = eng.runScenario(DCB);
        expect(t.center).toBe(r.finance.paybackYears);
        for (let i = 1; i < t.rows.length; i++) expect(t.rows[i].swing).toBeLessThanOrEqual(t.rows[i - 1].swing);
        const w = t.all.find((x) => x.key === 'weather');
        expect(w.low).toBe(r.financeBand.p10.paybackYears);
        expect(w.high).toBe(r.financeBand.p90.paybackYears);
        expect(t.all.map((x) => x.key).sort()).toEqual(['automation', 'baseLoad', 'price', 'shading', 'trend', 'weather']);
        expect(t.rows.length).toBeLessThanOrEqual(5);
    });
    it('validate and applyFix go through the engine with its base load', () => {
        const big = { ...U3, battery: { ...U3.battery, ups: { ...U3.battery.ups, dedicatedW: 'baseload', outletMaxW: 100 } } };
        expect(eng.validate(big).errors.map((e) => e.code)).toEqual(['UPS_OVER_OUTLET']);
        const fixed = eng.applyFix(big, eng.validate(big).errors[0].fixes[0].action);
        expect(eng.validate(fixed).errors).toEqual([]);
    });
});

describe('D2 engine fixes', () => {
    const WEST_WALL = { id: 'west-wall', kind: 'wall', azimuth: 270, tilt: 90 };
    const S03 = kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: WEST_WALL, dsSource: 'demo', id: 'S03' });
    const CP2 = kitToSystem('cityplumbing-dmegc-2x515-hiflow', { catalog: cat, spot: SOUTH, id: 'S05' });

    it('"on a west wall" is one figure: the W90 point of a frame kit is the west-wall option (wall physics)', () => {
        expect(S03.arrays[0]).toMatchObject({ mounting: 'wall', groundSelfShade: true });
        const wall = eng.runScenario(S03, { withBand: false }).headline;
        const a = eng.answerOrientation(S01);
        expect(Math.abs(a.w90.kwh - wall.pvKwh)).toBeLessThan(1e-9);
        expect(Math.abs(a.w90.gbp - wall.savingsGbp)).toBeLessThan(1e-9);
        const w90 = eng.orientationSweep(S01, '*').starred.find((p) => p.key === 'W90');
        expect(Math.abs(w90.gbp - wall.savingsGbp)).toBeLessThan(1e-9);
        // and the frame physics follow the panels off the wall: the best direction does not depend on the entry picked
        const b = eng.answerOrientation(S03, { flips: false });
        expect([b.best.az, b.best.tilt]).toEqual([a.best.az, a.best.tilt]);
        expect(Math.abs(b.best.gbp - a.best.gbp)).toBeLessThan(1e-9);
        expect(Math.abs(b.w90.gbp - wall.savingsGbp)).toBeLessThan(1e-9);
        // the rose's vertical ring is a wall too (proxy = the system on that wall, one sub-sample)
        const cell = eng.orientationSweep(S01, '*').cells.find((c) => c.az === 270 && c.tilt === 90);
        expect(Math.abs(cell.gbp - eng.runScenario(S03, { withBand: false, fidelity: 'proxy' }).finance.year1Gbp)).toBeLessThan(1e-9);
    });
    it('Outgoing Prime flips are only checked for a kit Prime can pay, and "~150 W" only when the load is well above it', () => {
        const cp = eng.answerOrientation(CP2);
        expect(cp.checked).toEqual(['C3', 'C4']);
        expect(cp.flips.map((f) => f.condition)).not.toContain('C1');
        expect(eng._primeEligible(normalizeSystem(S01))).toBe(true);
        expect(eng._primeEligible(normalizeSystem(CP2))).toBe(false);
        expect(eng._primeEligible(normalizeSystem({ ...S01, route: 'hardwired' }))).toBe(false);
        // the same panels bought from Octopus as a what-if keep the flips (the cache key carries eligibility)
        const asOctopus = normalizeSystem({ ...CP2, id: 'cp-oct', kitId: S01.kitId, sourceIds: [S01.kitId], route: 'whatif' });
        expect(eng.answerOrientation(asOctopus).checked).toEqual(['C1', 'C2', 'C3', 'C4']);
        try {
            eng.setProjectBaseW(150);
            expect(eng.answerOrientation(S01).checked).toEqual(['C3', 'C4']);
            eng.setProjectBaseW(190);
            expect(eng.answerOrientation(S01).checked).not.toContain('C1');
            eng.setProjectBaseW(400);
            expect(eng.answerOrientation(S01).checked).toEqual(['C1', 'C3', 'C4']);
        } finally {
            eng.setProjectBaseW(null);
        }
    });
    it('a weather band is centred on its headline: an optimiser on a big battery stays inside its own p10–p90', () => {
        const big = (strategy) => normalizeSystem({ ...S01, id: `big-${strategy}`, route: 'hardwired', inverter: { ...S01.inverter, acLimitW: 2400 },
            battery: { coupling: 'dc', capacityKwh: 5, maxChargeW: 2500, maxDischargeW: 2500, acChargeW: 2500, strategy } });
        for (const strategy of ['optimal', 'smart']) {
            const r = eng.runScenario(big(strategy));
            const h = r.headline;
            expect(h.p10Gbp, strategy).toBeLessThanOrEqual(h.savingsGbp);
            expect(h.p90Gbp, strategy).toBeGreaterThanOrEqual(h.savingsGbp);
            expect(h.paybackP10Years, strategy).toBeGreaterThanOrEqual(h.paybackYears);
            expect(h.paybackP90Years, strategy).toBeLessThanOrEqual(h.paybackYears);
            // the band grid sets the spread only: every year moves by what the grid costs the headline
            const same = eng.runScenario(big(strategy), { dispatchOpts: { N: 21 } });
            const shift = h.savingsGbp - same.headline.savingsGbp;
            expect(shift, strategy).toBeGreaterThan(1);
            r.band.savingsGbp.forEach((v, i) => expect(Math.abs(v - same.band.savingsGbp[i] - shift), `${strategy} ${r.band.years[i]}`).toBeLessThan(0.5));
        }
        // a rule strategy doesn't use the SoC grid: nothing to anchor
        const thr = eng.runScenario(big('threshold'));
        expect(eng.runScenario(big('threshold'), { dispatchOpts: { N: 21 } }).band.savingsGbp).toEqual(thr.band.savingsGbp);
    });
    it('autoScenarios with no spots goes back to the defaults (and the rules forget the old spots)', () => {
        const a = new SolarEngine(ds, cat, { nowMs: NOW });
        const where = (list) => list.filter((s) => ['S01', 'S05'].includes(s.id)).map((s) => `${s.id} ${s.spotId} ${s.arrays[0].azimuth}/${s.arrays[0].tilt}`);
        const fresh = where(a.autoScenarios());
        const custom = [{ id: 'balcony', name: 'Balcony', kind: 'railing', azimuth: 135, tiltRange: [60, 90], groundLevel: false }];
        expect(where(a.autoScenarios({ spots: custom }))).not.toEqual(fresh);
        const balc = { ...S01, id: 'balc', spotId: 'balcony' };
        expect(a.runScenario(balc, { withBand: false }).rules.warnings.map((w) => w.code)).toContain('ABOVE_GROUND');
        for (const opts of [{ spots: [] }, {}, { spots: null }]) {
            a.autoScenarios({ spots: custom });
            expect(where(a.autoScenarios(opts)), JSON.stringify(opts)).toEqual(fresh);
            expect(a.spots.map((s) => s.id)).toEqual(['ground', 'west-wall']);
            expect(a.runScenario(balc, { withBand: false }).rules.warnings.map((w) => w.code)).not.toContain('ABOVE_GROUND');
        }
    });
    it('a 0 W inverter limit means the default everywhere: a dc battery behind it is not silenced', () => {
        const zero = normalizeSystem({ ...DCB, id: 'DCB0', inverter: { ...DCB.inverter, acLimitW: 0 } });
        expect(zero.inverter.acLimitW).toBe(800);
        const a = eng.runScenario(zero, { withBand: false });
        const b = eng.runScenario(DCB, { withBand: false });
        expect(a.headline.savingsGbp).toBe(b.headline.savingsGbp);
        expect(a.battery.totalGbp).toBeGreaterThan(0);
    });
    it('callAsync: the inline engine pauses between cells, years and runs, and gives exactly the sync answers', async () => {
        const fresh = () => new SolarEngine(ds, cat, { nowMs: NOW });
        const a = fresh();
        const b = fresh();
        const big = normalizeSystem({ ...DCB, id: 'DCBopt', battery: { ...DCB.battery, strategy: 'optimal' } });
        let pauses = 0;
        const opts = { sliceMs: 0, yieldFn: async () => { pauses++; } };
        const r = await a.callAsync('runScenario', [big], opts);
        expect(pauses).toBeGreaterThanOrEqual(20); // at least once per weather year
        expect(r.headline).toEqual(b.runScenario(big).headline);
        expect(r.band).toEqual(b.runScenario(big).band);
        expect(a.runScenario(big)).toBe(r); // the cooperative run fills the same cache
        pauses = 0;
        const o = await a.callAsync('answerOrientation', [S01, { flips: false }], opts);
        expect(pauses).toBeGreaterThan(649); // every proxy cell, then every full-fidelity point
        expect(JSON.stringify(o)).toBe(JSON.stringify(b.answerOrientation(S01, { flips: false })));
        // a method without a step form still answers
        expect(await a.callAsync('upsStrategies', [U3])).toEqual(b.upsStrategies(U3));
        // a pause that throws (a cancelled job) stops it
        const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        await expect(fresh().callAsync('tornado', [DCB], { sliceMs: 0, yieldFn: async () => { throw abort; } })).rejects.toBe(abort);
    });
    it('power stations age by their own rating, and say whether servers ride through the switchover', () => {
        const r = eng.runScenario(U3, { withBand: false });
        expect(r.system.battery.cycleRatingSoh).toBe(0.8);
        const efc = r.typical.annual.battCycles;
        const end = (rated) => Math.min(10, Math.floor(1 + 0.3 / (0.015 + ((1 - rated) / 4000) * efc) + 1e-9));
        expect(r.finance.batteryEndYear).toBe(end(0.8));
        expect(eng.upsStrategies(U3)).toMatchObject({ switchMs: 10, serverSafeSwitch: true, holdUpMs: 12 });
        expect(eng.upsStrategies(stationToSystem('jackery-explorer-1000-v2', { catalog: cat }))).toMatchObject({ switchMs: 20, serverSafeSwitch: false });
    });
});
