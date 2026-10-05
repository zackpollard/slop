import { describe, it, expect } from 'vitest';
import { project, npv, irr, paybackYears, pvDegradation, batteryHealth, financeOptions, DEFAULT_FINANCE } from '../../../projects/solar-calculator/js/finance.js';
import { findNonFinite } from './fixtures/solar/a3-synth.js';

const NO_VAT = [{ untilMs: Infinity, rate: 0 }];
const flat = (pPerYear, expPerYear = 0) => Array.from({ length: 12 }, () => ({ impSavFwdExcP: pPerYear / 12, expIncFwdP: expPerYear / 12 }));
/** £100/yr flat, no VAT, no degradation — the engine critique's hand case basis. */
const HAND = { years: 20, discountRate: 0.04, escalation: 0, vatSchedule: NO_VAT, pvFirstYearDeg: 0, pvAnnualDeg: 0 };

describe('cash-flow primitives (C0 £650, £100/yr flat, 20 y, r 4%)', () => {
    const cf = [-650, ...Array(20).fill(100)];
    it('NPV £709.03', () => expect(npv(cf, 0.04)).toBeCloseTo(709.03, 2));
    it('IRR 14.33% ± 0.01', () => expect(Math.abs(irr(cf) * 100 - 14.33)).toBeLessThan(0.01));
    it('simple payback 6.500 y, discounted 7.681 y', () => {
        expect(paybackYears(cf)).toBeCloseTo(6.5, 9);
        expect(paybackYears(cf.map((v, y) => v / 1.04 ** y))).toBeCloseTo(7.681, 3);
    });
    it('IRR is null without a bracket; payback null when never reached', () => {
        expect(irr([-100, -10, -10])).toBeNull();
        expect(paybackYears([-100, 10, 10])).toBeNull();
        expect(paybackYears([0, 10])).toBe(0);
    });
});

describe('project() hand cases', () => {
    it('reproduces the primitives through the monthly pipeline', () => {
        const f = project({ costs: [{ label: 'kit', gbp: 650 }], pvMonthly: flat(10000), hasMicro: false, opts: HAND });
        expect(f.capexGbp).toBe(650);
        expect(f.year1Gbp).toBeCloseTo(100, 9);
        expect(f.npvGbp).toBeCloseTo(709.03, 2);
        expect(Math.abs(f.irr * 100 - 14.33)).toBeLessThan(0.01);
        expect(f.paybackYears).toBeCloseTo(6.5, 9);
        expect(f.discountedPaybackYears).toBeCloseTo(7.681, 3);
        expect(f.net10Gbp).toBeCloseTo(350, 9);
        expect(f.npv10Gbp).toBeCloseTo(-650 + 100 * ((1 - 1.04 ** -10) / 0.04), 9);
        expect(f.roiPct).toBeCloseTo((100 * 1350) / 650, 9);
        expect(f.years.length).toBe(21);
        expect(f.years[0]).toMatchObject({ y: 0, cashFlowGbp: -650, cumulativeGbp: -650 });
    });
    it('with degradation (first year 1%) and 2% escalation: payback 6.278 y, NPV £891.30', () => {
        const f = project({ costs: [{ gbp: 650 }], pvMonthly: flat(10000), hasMicro: false, opts: { ...HAND, escalation: 0.02, pvFirstYearDeg: 0.01, pvAnnualDeg: 0.004 } });
        expect(f.paybackYears).toBeCloseTo(6.278, 3);
        expect(f.npvGbp).toBeCloseTo(891.3, 2);
    });
    it('plus a £150 micro-inverter replacement in year 12: NPV £797.61', () => {
        const f = project({ costs: [{ gbp: 650 }], pvMonthly: flat(10000), hasMicro: true, opts: { ...HAND, escalation: 0.02, pvFirstYearDeg: 0.01, pvAnnualDeg: 0.004 } });
        expect(f.npvGbp).toBeCloseTo(797.61, 2);
        expect(f.years[12].outlayGbp).toBe(150);
    });
    it('PV degradation factors (mid-year)', () => {
        const a = [1, 2, 10, 20].map((y) => +pvDegradation(y, 0, 0.004).toFixed(5));
        const b = [1, 2, 10, 20].map((y) => +pvDegradation(y, 0.01, 0.004).toFixed(5));
        expect(a).toEqual([1, 0.998, 0.96651, 0.92853]);
        expect(b).toEqual([0.995, 0.98802, 0.95684, 0.91925]);
        expect(DEFAULT_FINANCE.pvFirstYearDeg).toBe(0); // LID is already in the DC loss stack
    });
    it('battery SoH with 250 EFC/yr: SoH_mid(1) 0.98625, SoH_mid(11) 0.71125, end of life y* = 11', () => {
        const h = batteryHealth({ efcPerYear: 250, cycles: 6000 });
        expect(h.sohMid(1)).toBeCloseTo(0.98625, 12);
        expect(h.sohMid(11)).toBeCloseTo(0.71125, 12);
        expect(h.endAge).toBe(11);
        expect(batteryHealth({ efcPerYear: 0, lifeYears: 15 }).endAge).toBe(15);
    });
});

describe('VAT by month (install 1 Nov 2026)', () => {
    const m = Array.from({ length: 12 }, () => ({ impSavFwdExcP: 1000, expIncFwdP: 100 }));
    const o = { escalation: 0, pvFirstYearDeg: 0, pvAnnualDeg: 0 };
    it('Sav_1 = 13 550p (5 months at 0%, 7 at 5%, export never VAT\'d), Sav_2 = 13 800p', () => {
        const f = project({ pvMonthly: m, hasMicro: false, opts: o });
        expect(f.years[1].savingsGbp * 100).toBeCloseTo(13550, 6);
        expect(f.years[2].savingsGbp * 100).toBeCloseTo(13800, 6);
    });
    it('with 2% escalation Sav_2 = 14 076p', () => {
        const f = project({ pvMonthly: m, hasMicro: false, opts: { ...o, escalation: 0.02 } });
        expect(f.years[2].savingsGbp * 100).toBeCloseTo(14076, 6);
    });
    it('"VAT stays at 0%" toggle: Sav_2 = 13 200p', () => {
        const f = project({ pvMonthly: m, hasMicro: false, opts: { ...o, vatReturns: false } });
        expect(f.years[2].savingsGbp * 100).toBeCloseTo(13200, 6);
    });
    it('flat profile: Sav_1 = savExc·(5/12 + 7/12·1.05) + export (UX acceptance)', () => {
        const f = project({ pvMonthly: flat(24000, 3000), hasMicro: false, opts: o });
        expect(f.year1Gbp * 100).toBeCloseTo(24000 * (5 / 12 + (7 / 12) * 1.05) + 3000, 6);
    });
    it('5% VAT throughout and no escalation/degradation: Sav_1 = forward savings × 1.05 + export', () => {
        const f = project({ pvMonthly: flat(24000, 3000), hasMicro: false, opts: { ...o, vatSchedule: [{ untilMs: Infinity, rate: 0.05 }] } });
        expect(f.year1Gbp * 100).toBeCloseTo(24000 * 1.05 + 3000, 6);
    });
    it('an install date in April 2027 starts at 5%', () => {
        const f = project({ pvMonthly: m, hasMicro: false, opts: { ...o, installDate: '2027-04-01' } });
        expect(f.years[1].savingsGbp * 100).toBeCloseTo(13800, 6);
    });
});

describe('battery term, end of life and replacement', () => {
    const battery = { coupling: 'ac', efcPerYear: 250, cycles: 6000, lifeYears: 15, capexGbp: 1000 };
    const opts = { ...HAND };
    it('(Sav_batt + standby)·SoH_mid − standby, zero after y* = 11', () => {
        const f = project({ costs: [{ gbp: 1650 }], pvMonthly: flat(10000), battMonthly: flat(1200), standbyCostFwdP: 175, battery, hasMicro: false, opts });
        expect(f.years[1].battGbp).toBeCloseTo((12 + 1.75) * 0.98625 - 1.75, 9);
        expect(f.years[11].battGbp).toBeCloseTo((12 + 1.75) * 0.71125 - 1.75, 9);
        expect(f.years[12].battGbp).toBe(0);
        expect(f.years[11].soh).toBeCloseTo(0.71125, 12);
        expect(f.years[12].soh).toBeNull();
        expect(f.batteryEndYear).toBe(11);
    });
    it('replaceBattery adds the battery capex at y* + 1 and restarts SoH', () => {
        const f = project({ costs: [{ gbp: 1650 }], pvMonthly: flat(10000), battMonthly: flat(1200), standbyCostFwdP: 175, battery, hasMicro: false, opts: { ...opts, replaceBattery: true } });
        expect(f.years[12].outlayGbp).toBe(1000);
        expect(f.years[12].battGbp).toBeCloseTo((12 + 1.75) * 0.98625 - 1.75, 9);
        expect(f.flags).toContain('batteryReplaced');
    });
    it('dc-coupled: no year-12 micro, a £150 inverter after the battery dies keeps PV running', () => {
        const f = project({ costs: [{ gbp: 1650 }], pvMonthly: flat(10000), battMonthly: flat(1200), battery: { ...battery, coupling: 'dc' }, hasMicro: true, opts });
        expect(f.years[12].outlayGbp).toBe(150); // y* + 1 = 12, the regular year-12 micro is dropped
        expect(f.years.filter((r) => r.outlayGbp > 0 && r.y > 0).length).toBe(1);
        expect(f.years[13].pvGbp).toBeCloseTo(100, 9);
        const stop = project({ costs: [{ gbp: 1650 }], pvMonthly: flat(10000), battMonthly: flat(1200), battery: { ...battery, coupling: 'dc' }, hasMicro: true, opts: { ...opts, dcInverterOnBatteryEol: false } });
        expect(stop.years[12].pvGbp).toBe(0);
        expect(stop.flags).toContain('pvStopsWithBattery');
    });
    it('LCOE and LCOS follow their definitions', () => {
        const f = project({ costs: [{ gbp: 1650 }], pvMonthly: flat(10000), battMonthly: flat(1200), standbyCostFwdP: 175, battery, hasMicro: false,
            energy: { pvAcKwh: 700, battOutAcKwh: 500 }, opts });
        const ann = (1 - 1.04 ** -20) / 0.04;
        expect(f.lcoePPerKwh).toBeCloseTo((65000) / (700 * ann), 9);
        let num = 100000;
        let den = 0;
        const h = batteryHealth(battery);
        for (let y = 1; y <= 11; y++) { num += 175 / 1.04 ** y; den += (500 * h.sohMid(y)) / 1.04 ** y; }
        expect(f.lcosPPerKwh).toBeCloseTo(num / den, 9);
    });
});

describe('staged upgrade (UX critique)', () => {
    const r = 0.04;
    const s01 = { costs: [{ gbp: 650 }], pvMonthly: flat(15000), hasMicro: true, opts: { ...HAND, escalation: 0.02 } };
    it('NPV(W2) = NPV(S01) + Σ_{y>atYear}(Sav2_y − Sav1_y)/(1+r)^y − cost/(1+r)^atYear', () => {
        const base = project(s01);
        const atYear = 2;
        const w2 = project({ ...s01, upgrade: { atYear, costs: [{ gbp: 1049.99 }], stage2PvMonthly: flat(15000), stage2BattMonthly: flat(9000),
            battery: { coupling: 'ac', efcPerYear: 200, cycles: 6000, lifeYears: 15 } } });
        let expected = base.npvGbp - 1049.99 / (1 + r) ** atYear;
        for (let y = atYear + 1; y <= 20; y++) expected += (w2.years[y].savingsGbp - base.years[y].savingsGbp) / (1 + r) ** y;
        expect(Math.abs(w2.npvGbp - expected)).toBeLessThan(1);
        // the stage-2 battery's ageing clock starts at atYear
        const h = batteryHealth({ efcPerYear: 200, cycles: 6000 });
        expect(w2.years[3].soh).toBeCloseTo(h.sohMid(1), 12);
        expect(w2.years[2].battGbp).toBe(0);
        expect(w2.years[2].outlayGbp).toBeCloseTo(1049.99, 9);
    });
    it('an upgrade beyond the horizon changes nothing', () => {
        const base = project(s01);
        const late = project({ ...s01, upgrade: { atYear: 25, costs: [{ gbp: 999 }], stage2PvMonthly: flat(50000) } });
        expect(late.npvGbp).toBeCloseTo(base.npvGbp, 9);
        expect(late.flags).toContain('upgradeBeyondHorizon');
    });
});

describe('settings from a form never poison the projection', () => {
    const m = flat(10000);
    const base = project({ costs: [{ gbp: 650 }], pvMonthly: m });
    it('blank, NaN or out-of-range options fall back to the defaults (a {...defaults, ...opts} merge would give NaN)', () => {
        for (const bad of [{ microReplaceGbp: undefined }, { discountRate: NaN }, { escalation: '' }, { pvAnnualDeg: null }, { omGbpPerYear: NaN },
            { installDate: 'soon' }, { vatSchedule: [] }, { years: NaN }, null]) {
            const f = project({ costs: [{ gbp: 650 }], pvMonthly: m, opts: bad });
            expect(findNonFinite(f)).toEqual([]);
            expect(f.npvGbp).toBeCloseTo(base.npvGbp, 9);
        }
        expect(financeOptions({ discountRate: -1 }).discountRate).toBe(-0.5); // −100% would divide by zero
        expect(financeOptions({ years: 2.6 }).years).toBe(3);
        expect(financeOptions(DEFAULT_FINANCE)).toEqual({ ...DEFAULT_FINANCE });
    });
    it('NaN or missing cost amounts count as £0; fractional years are rounded, not dropped by the typed array', () => {
        const f = project({ costs: [{ gbp: 650 }, { gbp: NaN }, null, { gbp: 10, year: 2.4 }], pvMonthly: m, energy: null,
            battery: { coupling: 'ac', efcPerYear: NaN, lifeYears: 12.5, capexGbp: NaN }, battMonthly: flat(1200) });
        expect(findNonFinite(f)).toEqual([]);
        expect(f.capexGbp).toBe(650);
        expect(f.years[2].outlayGbp).toBe(10);
        expect(f.batteryEndYear).toBe(12); // whole years of service
        const up = project({ costs: [{ gbp: 650 }], pvMonthly: m, upgrade: { atYear: 2.4, costs: [{ gbp: 100 }], stage2PvMonthly: m } });
        expect(up.years[2].outlayGbp).toBe(100);
    });
    it('an upgrade without its own stage-2 PV series keeps the stage-1 PV savings (battery-only upgrade)', () => {
        const f = project({ costs: [{ gbp: 650 }], pvMonthly: m, hasMicro: false, opts: HAND,
            upgrade: { atYear: 3, costs: [{ gbp: 500 }], stage2BattMonthly: flat(6000), battery: { coupling: 'ac', efcPerYear: 200 } } });
        expect(f.years[4].pvGbp).toBeCloseTo(100, 9);
        expect(f.years[4].battGbp).toBeGreaterThan(0);
        expect(f.years[3].battGbp).toBe(0);
    });
    it('IRR above 100% is reported (a kit that pays back in months is not "n/a")', () => {
        const cf = [-100, ...Array(20).fill(200)];
        const r = irr(cf);
        expect(r).toBeGreaterThan(1);
        expect(Math.abs(npv(cf, r))).toBeLessThan(1e-6);
        expect(irr([-100, -10, -10])).toBeNull();
        expect(irr([-650, ...Array(20).fill(100)])).toBeCloseTo(0.14328, 4);
    });
});

describe('robustness', () => {
    it('flags a payback that later reverts (big replacement outlay)', () => {
        const f = project({ costs: [{ gbp: 100 }, { gbp: 5000, year: 5 }], pvMonthly: flat(10000), hasMicro: false, opts: HAND });
        expect(f.paybackYears).toBeCloseTo(1, 9);
        expect(f.flags).toContain('paybackReverts');
    });
    it('zero capex, empty months and no battery produce no NaN', () => {
        const f = project({ costs: [], pvMonthly: Array(12).fill(null), hasMicro: false });
        expect(f.paybackYears).toBe(0);
        expect(f.roiPct).toBeNull();
        expect(findNonFinite(f)).toEqual([]);
        const g = project({ costs: [{ gbp: 500 }], pvMonthly: flat(0), battMonthly: flat(100), battery: { coupling: 'ups', efcPerYear: 400, cycles: 4000, lifeYears: 10 } });
        expect(findNonFinite(g)).toEqual([]);
        expect(g.paybackYears).toBeNull();
    });
});

describe('cycle wear follows the rating basis, not the end-of-life threshold (D2)', () => {
    it("a '4000 cycles to 80%' unit at 620 EFC/yr wears out in year 7, not year 5", () => {
        const rated80 = batteryHealth({ coupling: 'ups', efcPerYear: 620, cycles: 4000, cycleRatingSoh: 0.8, lifeYears: 15 });
        // 0.015 calendar + 0.2/4000 × 620 = 0.046 a year → SoH_end(6) = 0.724 ≥ 0.7 > SoH_end(7)
        expect(rated80.rate).toBeCloseTo(0.015 + (0.2 / 4000) * 620, 12);
        expect(rated80.endAge).toBe(7);
        // read as cycles to 70% (the old formula) the same unit died in year 5
        expect(batteryHealth({ efcPerYear: 620, cycles: 4000, cycleRatingSoh: 0.7, lifeYears: 15 }).endAge).toBe(5);
    });
    it('the basis defaults by coupling: power stations to 80%, home batteries to 70%', () => {
        expect(batteryHealth({ coupling: 'ups', efcPerYear: 620, cycles: 4000 }).rate).toBeCloseTo(0.015 + (0.2 / 4000) * 620, 12);
        expect(batteryHealth({ coupling: 'dc', efcPerYear: 620, cycles: 4000 }).rate).toBeCloseTo(0.015 + (0.3 / 4000) * 620, 12);
        expect(batteryHealth({ efcPerYear: 620, cycles: 4000 }).rate).toBeCloseTo(0.015 + (0.3 / 4000) * 620, 12);
    });
    it('a lower worn-out threshold makes the battery last longer, never wear faster', () => {
        const b = { coupling: 'ups', efcPerYear: 620, cycles: 4000, cycleRatingSoh: 0.8, lifeYears: 30 };
        const at = (eol) => batteryHealth(b, { ...DEFAULT_FINANCE, batteryEolSoh: eol, batteryCalendarFade: 0 });
        // the fade per year is the same whatever the user calls worn out …
        expect(at(0.6).rate).toBe(at(0.8).rate);
        expect(at(0.6).sohMid(5)).toBe(at(0.7).sohMid(5));
        // … so only the end moves: at 0.031/yr it crosses 80% during year 7, 70% during year 10, 60% during year 13
        expect([0.8, 0.7, 0.6].map((e) => at(e).endAge)).toEqual([7, 10, 13]);
    });
    it('project() ages a station by its rating: it earns for 7 years, not 5', () => {
        const f = project({ costs: [{ gbp: 900 }], pvMonthly: flat(0), battMonthly: flat(1500), hasMicro: false,
            battery: { coupling: 'ups', efcPerYear: 620, cycles: 4000, cycleRatingSoh: 0.8, lifeYears: 10 }, opts: HAND });
        expect(f.batteryEndYear).toBe(7);
        expect(f.years[7].battGbp).toBeGreaterThan(0);
        expect(f.years[8].battGbp).toBe(0);
    });
});
