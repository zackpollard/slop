import { describe, it, expect } from 'vitest';
import { DEFAULT_VAT_SCHEDULE, vatAt, withVat, vatSchedule } from '../../../projects/solar-calculator/js/vat.js';
import { localMidnightUtc, SLOT_MS } from '../../../projects/solar-calculator/js/time.js';

const Z = (s) => Date.parse(s);

describe('VAT schedule', () => {
    it('is 5% → 0% from 1 Oct 2026 (BST) → 5% from 1 Apr 2027 (BST)', () => {
        expect(DEFAULT_VAT_SCHEDULE.map((e) => [e.untilMs, e.rate])).toEqual([
            [Z('2026-09-30T23:00:00Z'), 0.05],
            [Z('2027-03-31T23:00:00Z'), 0],
            [Infinity, 0.05],
        ]);
        expect(Object.isFrozen(DEFAULT_VAT_SCHEDULE)).toBe(true);
        expect(Object.isFrozen(DEFAULT_VAT_SCHEDULE[0])).toBe(true);
    });

    it('applies each rate to instants before its untilMs', () => {
        expect(vatAt(Z('2025-10-01T12:00:00Z'))).toBe(0.05);
        expect(vatAt(Z('2026-09-30T22:59:59.999Z'))).toBe(0.05);
        expect(vatAt(Z('2026-09-30T23:00:00Z'))).toBe(0);
        expect(vatAt(Z('2027-03-31T22:30:00Z'))).toBe(0);
        expect(vatAt(Z('2027-03-31T23:00:00Z'))).toBe(0.05);
        expect(vatAt(Z('2040-01-01T00:00:00Z'))).toBe(0.05);
    });

    it('keeps the last rate past a finite schedule and handles an empty one', () => {
        const s = [{ untilMs: Z('2026-01-01T00:00:00Z'), rate: 0.2 }, { untilMs: Z('2027-01-01T00:00:00Z'), rate: 0.1 }];
        expect(vatAt(Z('2025-06-01T00:00:00Z'), s)).toBe(0.2);
        expect(vatAt(Z('2026-06-01T00:00:00Z'), s)).toBe(0.1);
        expect(vatAt(Z('2030-06-01T00:00:00Z'), s)).toBe(0.1);
        expect(vatAt(0, [])).toBe(0);
        expect(Array.from(withVat([10, 20], 0, []))).toEqual([10, 20]);
    });

    it('treats a null schedule (an unset option after structured clone) as the default', () => {
        expect(vatAt(Z('2026-12-01T00:00:00Z'), null)).toBe(0);
        expect(vatAt(Z('2026-06-01T00:00:00Z'), null)).toBe(0.05);
        expect(Array.from(withVat([10, 10], Z('2026-09-30T22:30:00Z'), null))).toEqual([10.5, 10]);
    });

    it('offers the "VAT stays at 0%" variant', () => {
        const s = vatSchedule({ returnsTo5: false });
        expect(vatAt(Z('2026-06-01T00:00:00Z'), s)).toBe(0.05);
        expect(vatAt(Z('2027-06-01T00:00:00Z'), s)).toBe(0);
        expect(vatAt(Z('2035-06-01T00:00:00Z'), s)).toBe(0);
        expect(vatSchedule()).toBe(DEFAULT_VAT_SCHEDULE);
    });
});

describe('withVat', () => {
    it('prices each slot at the rate in force at its start', () => {
        const start = Z('2026-09-30T22:00:00Z');
        const out = withVat(new Float64Array([10, 10, 10, 10]), start);
        expect(out).toBeInstanceOf(Float64Array);
        expect(Array.from(out)).toEqual([10 * 1.05, 10 * 1.05, 10, 10]);
        const back = withVat([20, 20, 20, 20], Z('2027-03-31T22:00:00Z'));
        expect(Array.from(back)).toEqual([20, 20, 21, 21]);
    });

    it('never touches negative prices beyond scaling them', () => {
        expect(Array.from(withVat([-2, 0], Z('2025-12-01T00:00:00Z')))).toEqual([-2.1, 0]);
    });

    it('agrees with vatAt slot by slot over a year that spans both changes', () => {
        const start = Z('2026-06-01T00:00:00Z');
        const n = 48 * 400;
        const exc = Float64Array.from({ length: n }, (_, t) => 5 + (t % 97) / 7);
        const inc = withVat(exc, start);
        for (let t = 0; t < n; t++) expect(inc[t]).toBe(exc[t] * (1 + vatAt(start + t * SLOT_MS)));
    });
});

describe('finance hand case (engine critique §price bases, test a)', () => {
    // monthly import saving 1000p ex VAT, export 100p (never VAT'd), install 2026-11-01:
    // Sav_1 = Σ over Nov 2026..Oct 2027 of 1000·(1 + vat(month start)) + 100
    const monthStart = (y, m0) => localMidnightUtc(`${y + Math.floor(m0 / 12)}-${String((m0 % 12) + 1).padStart(2, '0')}-01`);
    const year = (y0) => {
        let s = 0;
        for (let k = 0; k < 12; k++) s += 1000 * (1 + vatAt(monthStart(y0, 10 + k))) + 100;
        return s;
    };

    it('gives 13 550p in year 1 and 13 800p in year 2', () => {
        expect(year(2026)).toBeCloseTo(13_550, 9);
        expect(year(2027)).toBeCloseTo(13_800, 9);
        expect(year(2027) * 1.02).toBeCloseTo(14_076, 9);
    });
});
