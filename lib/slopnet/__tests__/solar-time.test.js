import { describe, it, expect } from 'vitest';
import {
    SLOT_MS, DT_H, PEAK_FROM_HH, PEAK_TO_HH, ukOffsetMs, bstWindow, localParts, localMidnightUtc, utcDate,
    parseOctopusTime, floorSlot, hhFromClock, buildLocalIndex, replanStarts, horizonEnd, daysInMonth,
} from '../../../projects/solar-calculator/js/time.js';

const Z = (s) => Date.parse(s);

// Europe/London wall clock from Intl — allowed in tests as an independent oracle, never in the engine
const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
function intlParts(ms) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const year = +p.year, month = +p.month, day = +p.day, hour = +p.hour, minute = +p.minute;
    const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
    return { year, month, day, minutes: hour * 60 + minute, dow, offset: Date.UTC(year, month - 1, day, hour, minute) - Math.floor(ms / 60000) * 60000 };
}

describe('time.js constants and small helpers', () => {
    it('defines the settlement slot', () => {
        expect(SLOT_MS).toBe(1_800_000);
        expect(DT_H).toBe(0.5);
        expect([PEAK_FROM_HH, PEAK_TO_HH]).toEqual([32, 38]);
    });

    it('floors to the slot start', () => {
        expect(floorSlot(Z('2026-07-01T15:29:59.999Z'))).toBe(Z('2026-07-01T15:00:00Z'));
        expect(floorSlot(Z('2026-07-01T15:30:00Z'))).toBe(Z('2026-07-01T15:30:00Z'));
    });

    it('maps wall-clock strings to half-hour indices', () => {
        expect(hhFromClock('00:00')).toBe(0);
        expect(hhFromClock('16:00')).toBe(32);
        expect(hhFromClock('19:30')).toBe(39);
        expect(hhFromClock('24:00')).toBe(48);
    });

    it('knows month lengths including leap years', () => {
        expect(daysInMonth(2024, 2)).toBe(29);
        expect(daysInMonth(2026, 2)).toBe(28);
        expect(daysInMonth(2000, 2)).toBe(29);
        expect(daysInMonth(2100, 2)).toBe(28);
        expect(daysInMonth(2026, 9)).toBe(30);
    });

    it('gives UTC dates', () => {
        expect(utcDate(Z('2025-09-30T23:00:00Z'))).toBe('2025-09-30');
        expect(utcDate(Z('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
        expect(utcDate(Z('1999-12-31T23:59:59Z'))).toBe('1999-12-31');
    });
});

describe('UK DST rule', () => {
    it('switches at 01:00Z on the last Sundays of March and October', () => {
        expect(bstWindow(2026)).toEqual([Z('2026-03-29T01:00:00Z'), Z('2026-10-25T01:00:00Z')]);
        expect(bstWindow(2025)).toEqual([Z('2025-03-30T01:00:00Z'), Z('2025-10-26T01:00:00Z')]);
        expect(ukOffsetMs(Z('2026-03-29T00:59:59.999Z'))).toBe(0);
        expect(ukOffsetMs(Z('2026-03-29T01:00:00Z'))).toBe(3_600_000);
        expect(ukOffsetMs(Z('2025-10-26T00:59:59.999Z'))).toBe(3_600_000);
        expect(ukOffsetMs(Z('2025-10-26T01:00:00Z'))).toBe(0);
        expect(ukOffsetMs(Z('2026-01-15T12:00:00Z'))).toBe(0);
        expect(ukOffsetMs(Z('2026-07-01T12:00:00Z'))).toBe(3_600_000);
    });

    it('agrees with Intl every half-hour around every change 2005–2040', () => {
        let checked = 0;
        for (let y = 2005; y <= 2040; y++) {
            for (const [a, b] of [[`${y}-03-23`, `${y}-04-02`], [`${y}-10-23`, `${y}-11-02`]]) {
                for (let ms = Z(a + 'T00:00:00Z'); ms < Z(b + 'T00:00:00Z'); ms += SLOT_MS) {
                    expect(ukOffsetMs(ms)).toBe(intlParts(ms).offset);
                    checked++;
                }
            }
        }
        expect(checked).toBeGreaterThan(30_000);
    });
});

describe('localParts', () => {
    it('matches the engine-critique DST vectors', () => {
        expect(localParts(Z('2026-03-29T00:30:00Z')).hh).toBe(1);
        expect(localParts(Z('2026-03-29T01:00:00Z')).hh).toBe(4);
        expect(localParts(Z('2025-10-26T00:30:00Z')).hh).toBe(3);
        expect(localParts(Z('2025-10-26T01:00:00Z')).hh).toBe(2);
        expect(localParts(Z('2025-10-26T00:00:00Z')).hh).toBe(2);
    });

    it('flags the 16:00–19:00 local peak in UTC terms', () => {
        const peak = (s) => { const { hh } = localParts(Z(s)); return hh >= 32 && hh < 38 ? 1 : 0; };
        expect(peak('2026-07-01T15:00:00Z')).toBe(1); // 16:00 BST
        expect(peak('2026-07-01T17:30:00Z')).toBe(1);
        expect(peak('2026-07-01T18:00:00Z')).toBe(0); // 19:00 BST
        expect(peak('2026-01-15T15:00:00Z')).toBe(0); // 15:00 GMT
        expect(peak('2026-01-15T16:00:00Z')).toBe(1);
    });

    it('returns date, weekday and minutes', () => {
        expect(localParts(Z('2026-10-05T10:15:00Z'))).toEqual({ year: 2026, month: 10, day: 5, minutes: 675, hh: 22, dow: 0, date: '2026-10-05' });
        expect(localParts(Z('2025-09-30T23:00:00Z')).date).toBe('2025-10-01'); // local midnight in BST
        expect(localParts(Z('2026-01-04T12:00:00Z')).dow).toBe(6); // Sunday
    });

    it('agrees with Intl on 3000 random instants 2005–2045', () => {
        let seed = 7;
        const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
        const a = Z('2005-01-01T00:00:00Z'), b = Z('2045-01-01T00:00:00Z');
        for (let i = 0; i < 3000; i++) {
            const ms = Math.floor((a + rnd() * (b - a)) / 60000) * 60000;
            const mine = localParts(ms), ref = intlParts(ms);
            expect([mine.year, mine.month, mine.day, mine.minutes, mine.dow]).toEqual([ref.year, ref.month, ref.day, ref.minutes, ref.dow]);
        }
    });
});

describe('localMidnightUtc', () => {
    it('handles both sides of each clock change', () => {
        expect(localMidnightUtc('2025-10-01')).toBe(Z('2025-09-30T23:00:00Z'));
        expect(localMidnightUtc('2025-10-26')).toBe(Z('2025-10-25T23:00:00Z')); // still BST at midnight
        expect(localMidnightUtc('2025-10-27')).toBe(Z('2025-10-27T00:00:00Z'));
        expect(localMidnightUtc('2026-03-29')).toBe(Z('2026-03-29T00:00:00Z')); // still GMT at midnight
        expect(localMidnightUtc('2026-03-30')).toBe(Z('2026-03-29T23:00:00Z'));
        expect(localMidnightUtc('2026-01-15')).toBe(Z('2026-01-15T00:00:00Z'));
    });

    it('round-trips with localParts', () => {
        for (let ms = Z('2025-01-01T00:00:00Z'); ms < Z('2027-01-01T00:00:00Z'); ms += 86_400_000) {
            const d = localParts(ms).date;
            const mid = localMidnightUtc(d);
            expect(localParts(mid)).toMatchObject({ date: d, minutes: 0 });
            expect(localParts(mid - 1).date).not.toBe(d);
        }
    });

    it('rejects garbage', () => {
        expect(() => localMidnightUtc('not-a-date')).toThrow(RangeError);
    });
});

describe('parseOctopusTime', () => {
    it('normalises the offsets the Octopus API mixes', () => {
        const want = Z('2025-09-30T23:00:00Z');
        expect(parseOctopusTime('2025-10-01T00:00:00+01:00')).toBe(want);
        expect(parseOctopusTime('2025-10-01T00:00:00+0100')).toBe(want);
        expect(parseOctopusTime('2025-10-01T00:00:00+01')).toBe(want);
        expect(parseOctopusTime('2025-09-30T23:00:00Z')).toBe(want);
        expect(parseOctopusTime('2025-09-30T23:00:00.000Z')).toBe(want);
        expect(parseOctopusTime(' 2025-09-30T23:00:00Z ')).toBe(want);
    });

    it('treats a zone-less timestamp as UTC regardless of host timezone', () => {
        expect(parseOctopusTime('2025-09-30T23:00:00')).toBe(Z('2025-09-30T23:00:00Z'));
        expect(parseOctopusTime('2026-03-01')).toBe(Z('2026-03-01T00:00:00Z'));
    });

    it('throws on unparseable input', () => {
        expect(() => parseOctopusTime('yesterday')).toThrow(RangeError);
        expect(() => parseOctopusTime(null)).toThrow(RangeError);
        expect(() => parseOctopusTime('')).toThrow(RangeError);
    });
});

describe('buildLocalIndex', () => {
    // the demo dataset window: 365 local days from 1 Oct 2025 00:00 BST
    const start = Z('2025-09-30T23:00:00Z');
    const n = 17_520;
    const L = buildLocalIndex(start, n);

    it('has 365 local days with 50 slots on 26 Oct and 46 on 29 Mar', () => {
        expect(L.days.length).toBe(365);
        expect(L.days[0]).toEqual({ date: '2025-10-01', first: 0, count: 48 });
        expect(L.days[364].date).toBe('2026-09-30');
        const byDate = Object.fromEntries(L.days.map((d) => [d.date, d.count]));
        expect(byDate['2025-10-26']).toBe(50);
        expect(byDate['2026-03-29']).toBe(46);
        const others = L.days.filter((d) => d.date !== '2025-10-26' && d.date !== '2026-03-29');
        expect(others.every((d) => d.count === 48)).toBe(true);
        expect(L.days.reduce((s, d) => s + d.count, 0)).toBe(n);
    });

    it('repeats hh 2 and 3 on the 50-slot day and skips them on the 46-slot day', () => {
        const day = (date) => { const d = L.days.find((x) => x.date === date); return Array.from(L.hh.subarray(d.first, d.first + d.count)); };
        const oct = day('2025-10-26');
        expect(oct.slice(0, 7)).toEqual([0, 1, 2, 3, 2, 3, 4]);
        expect(oct[49]).toBe(47);
        const mar = day('2026-03-29');
        expect(mar.slice(0, 4)).toEqual([0, 1, 4, 5]);
        expect(mar[45]).toBe(47);
        expect(day('2026-07-01')).toEqual(Array.from({ length: 48 }, (_, i) => i));
    });

    it('buckets months locally and keeps profile denominators per hh', () => {
        expect(L.months.map((m) => m.key)).toEqual([
            '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03',
            '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
        ]);
        const oct = L.months[0], mar = L.months[5];
        expect([oct.first, oct.count, oct.dim, oct.month0, oct.monthKey]).toEqual([0, 31 * 48 + 2, 31, 9, 2025 * 12 + 9]);
        expect([mar.count, mar.dim]).toEqual([31 * 48 - 2, 31]);
        expect(L.months.reduce((s, m) => s + m.count, 0)).toBe(n);
        // every hh occurs 365 times over the year: the doubled 01:00–02:00 hour cancels the skipped one
        const counts = new Array(48).fill(0);
        for (let t = 0; t < n; t++) counts[L.hh[t]]++;
        expect(counts.every((c) => c === 365)).toBe(true);
        expect(L.peak.reduce((s, v) => s + v, 0)).toBe(365 * 6);
    });

    it('fills day, month, monthKey and dow consistently with localParts', () => {
        for (let t = 0; t < n; t += 37) {
            const p = localParts(start + t * SLOT_MS);
            expect(L.days[L.day[t]].date).toBe(p.date);
            expect(L.month[t]).toBe(p.month - 1);
            expect(L.monthKey[t]).toBe(p.year * 12 + p.month - 1);
            expect(L.dow[t]).toBe(p.dow);
            expect(L.hh[t]).toBe(p.hh);
            expect(L.peak[t]).toBe(p.hh >= 32 && p.hh < 38 ? 1 : 0);
        }
    });

    it('splits partial first/last days at the dataset edges', () => {
        const P = buildLocalIndex(Z('2026-07-01T10:00:00Z'), 48);
        expect(P.days).toEqual([{ date: '2026-07-01', first: 0, count: 26 }, { date: '2026-07-02', first: 26, count: 22 }]);
        expect(P.months).toEqual([{ key: '2026-07', monthKey: 2026 * 12 + 6, month0: 6, first: 0, count: 48, dim: 31 }]);
    });
});

describe('re-plan and horizon slots', () => {
    const L = buildLocalIndex(Z('2025-09-30T23:00:00Z'), 17_520);
    const idx = (s) => (Z(s) - Z('2025-09-30T23:00:00Z')) / SLOT_MS;

    it('replans at the first local 16:00 (or 20:00) of each day', () => {
        const r = replanStarts(L);
        expect(r.length).toBe(365);
        expect(r[0]).toBe(idx('2025-10-01T15:00:00Z'));
        for (const t of r) expect(L.hh[t]).toBe(32);
        const r20 = replanStarts(L, 40);
        expect(r20[0]).toBe(idx('2025-10-01T19:00:00Z'));
    });

    it('gives 60-slot and 64-slot horizons across the clock changes, 62 otherwise', () => {
        const spring = idx('2026-03-28T16:00:00Z'); // 16:00 GMT
        expect(L.hh[spring]).toBe(32);
        expect(horizonEnd(L, spring) - spring).toBe(60);
        const autumn = idx('2025-10-25T15:00:00Z'); // 16:00 BST
        expect(L.hh[autumn]).toBe(32);
        expect(horizonEnd(L, autumn) - autumn).toBe(64);
        const normal = idx('2026-07-01T15:00:00Z');
        expect(horizonEnd(L, normal) - normal).toBe(62);
        expect(L.hh[horizonEnd(L, normal)]).toBe(46);
        expect(horizonEnd(L, 0)).toBe(idx('2025-10-02T22:00:00Z')); // the first plan starts at t = 0
    });

    it('stops at the end of the data', () => {
        const last = 17_520 - 10;
        expect(horizonEnd(L, last)).toBe(17_520);
    });
});
