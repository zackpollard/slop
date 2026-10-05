/*
 * time.js — UK wall-clock time and half-hour slot helpers.
 *
 * Octopus settles electricity in UTC half-hours, but every human bucket the app reports — the
 * 16:00–19:00 Agile peak, days, calendar months — is Europe/London wall-clock time. The BST rule
 * is computed arithmetically here so hot loops never touch Intl (slow, and its tz data is not
 * guaranteed in every worker runtime). All inputs and outputs are UTC epoch milliseconds.
 */

/** Length of one settlement slot in milliseconds (30 min). */
export const SLOT_MS = 1_800_000;
/** Length of one settlement slot in hours. */
export const DT_H = 0.5;
/** First local half-hour index of the Agile peak (16:00). */
export const PEAK_FROM_HH = 32;
/** Exclusive end of the Agile peak (19:00). */
export const PEAK_TO_HH = 38;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/* ── civil calendar arithmetic (proleptic Gregorian, no Date objects) ── */

/**
 * Days since 1970-01-01 → { y, m (1-12), d }. Howard Hinnant's civil_from_days; exact for any
 * integer day, which lets the per-slot loops avoid allocating Date objects.
 */
function civilFromDays(days) {
    const z = days + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Days in month (month1 = 1..12) of a Gregorian year. */
export function daysInMonth(year, month1) {
    if (month1 === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
    return month1 === 4 || month1 === 6 || month1 === 9 || month1 === 11 ? 30 : 31;
}

const pad2 = (v) => (v < 10 ? '0' : '') + v;
const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/* ── BST rule ── */

const bstCache = new Map();

/** UTC ms of 01:00Z on the last Sunday of month0 in year — when UK clocks change. */
function lastSundayAt0100Z(year, month0) {
    const lastDay = Date.UTC(year, month0 + 1, 0);
    const weekday = new Date(lastDay).getUTCDay(); // 0 = Sunday
    return lastDay - weekday * DAY_MS + HOUR_MS;
}

/**
 * The BST interval of a year as [startMs, endMs): last Sunday of March 01:00Z to last Sunday of
 * October 01:00Z (the rule in force since 1996; the app never looks further back than 2005).
 * @param {number} year
 * @returns {[number, number]}
 */
export function bstWindow(year) {
    let w = bstCache.get(year);
    if (!w) {
        w = [lastSundayAt0100Z(year, 2), lastSundayAt0100Z(year, 9)];
        bstCache.set(year, w);
    }
    return w;
}

/**
 * Europe/London offset from UTC at an instant.
 * @param {number} ms UTC epoch ms
 * @returns {0 | 3600000}
 */
export function ukOffsetMs(ms) {
    const w = bstWindow(civilFromDays(Math.floor(ms / DAY_MS)).y);
    return ms >= w[0] && ms < w[1] ? HOUR_MS : 0;
}

/**
 * Wall-clock parts of an instant in Europe/London. `hh` is the half-hour index of the local
 * clock (floor(minutes/30)), so on the 50-slot October day hh 2 and 3 occur twice and on the
 * 46-slot March day they never occur.
 * @param {number} ms UTC epoch ms
 * @returns {{ year: number, month: number, day: number, minutes: number, hh: number, dow: number, date: string }}
 *   month 1-12, minutes 0..1439, hh 0..47, dow 0 = Monday
 */
export function localParts(ms) {
    const local = ms + ukOffsetMs(ms);
    const days = Math.floor(local / DAY_MS);
    const { y, m, d } = civilFromDays(days);
    const minutes = Math.floor((local - days * DAY_MS) / MIN_MS);
    return {
        year: y, month: m, day: d, minutes, hh: Math.floor(minutes / 30),
        // 1970-01-01 was a Thursday (index 3 when Monday = 0)
        dow: (((days + 3) % 7) + 7) % 7,
        date: isoDate(y, m, d),
    };
}

/**
 * UTC instant of local midnight at the start of a London calendar date. Clocks change at 01:00Z,
 * so midnight itself is never skipped or doubled and one offset lookup is exact.
 * @param {string} date 'YYYY-MM-DD'
 * @returns {number} UTC epoch ms
 */
export function localMidnightUtc(date) {
    const [y, m, d] = String(date).split('-').map(Number);
    const guess = Date.UTC(y, m - 1, d);
    if (!Number.isFinite(guess)) throw new RangeError(`Invalid date: ${date}`);
    return guess - ukOffsetMs(guess);
}

/**
 * UTC calendar date of an instant — what Open-Meteo's start_date/end_date mean with timezone=GMT.
 * @param {number} ms UTC epoch ms
 * @returns {string} 'YYYY-MM-DD'
 */
export function utcDate(ms) {
    const { y, m, d } = civilFromDays(Math.floor(ms / DAY_MS));
    return isoDate(y, m, d);
}

/**
 * Parse an Octopus API timestamp. The API mixes 'Z', '+01:00' and the colon-less '+0100' that
 * Date.parse rejects; a string with no zone at all is taken as UTC so parsing never depends on
 * the host's timezone.
 * @param {string} s
 * @returns {number} UTC epoch ms
 * @throws {RangeError} when the string cannot be parsed
 */
export function parseOctopusTime(s) {
    if (typeof s !== 'string') throw new RangeError(`Not a timestamp: ${s}`);
    let t = s.trim().replace(' ', 'T');
    if (t.includes('T')) {
        t = t.replace(/(T[\d:.]+[+-]\d{2})(\d{2})$/, '$1:$2').replace(/(T[\d:.]+[+-]\d{2})$/, '$1:00');
        if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += 'Z';
    }
    const ms = Date.parse(t);
    if (!Number.isFinite(ms)) throw new RangeError(`Unparseable timestamp: ${s}`);
    return ms;
}

/**
 * Start of the settlement slot containing an instant.
 * @param {number} ms UTC epoch ms
 * @returns {number}
 */
export function floorSlot(ms) {
    return Math.floor(ms / SLOT_MS) * SLOT_MS;
}

/**
 * Half-hour index of a wall-clock 'HH:MM' string ('16:00' → 32, '24:00' → 48).
 * @param {string} clock
 * @returns {number}
 */
export function hhFromClock(clock) {
    const [h, m] = String(clock).split(':').map(Number);
    return h * 2 + (m >= 30 ? 1 : 0);
}

/**
 * @typedef {Object} LocalIndex
 * @property {Uint8Array} hh        local half-hour 0..47
 * @property {Int32Array} day       0-based local-day index into `days`
 * @property {Uint8Array} month     local month 0..11
 * @property {Int32Array} monthKey  year*12 + month0 (distinguishes two Octobers)
 * @property {Uint8Array} dow       0 = Monday
 * @property {Uint8Array} peak      1 when 16:00 ≤ local < 19:00
 * @property {Array<{date: string, first: number, count: number}>} days
 * @property {Array<{key: string, monthKey: number, month0: number, first: number, count: number, dim: number}>} months
 */

/**
 * Local-time bucketing for n slots from `start`. Built once per dataset; every 48-slot profile
 * divides by the per-hh slot count, never by the number of days, because DST days have 46/50.
 * @param {number} start UTC ms of slot 0 (a :00/:30 boundary)
 * @param {number} n slot count
 * @returns {LocalIndex}
 */
export function buildLocalIndex(start, n) {
    const hh = new Uint8Array(n);
    const day = new Int32Array(n);
    const month = new Uint8Array(n);
    const monthKey = new Int32Array(n);
    const dow = new Uint8Array(n);
    const peak = new Uint8Array(n);
    const days = [];
    const months = [];
    let lastDays = NaN;
    let lastMonthKey = NaN;
    let cur = null;
    for (let t = 0; t < n; t++) {
        const ms = start + t * SLOT_MS;
        const local = ms + ukOffsetMs(ms);
        const dn = Math.floor(local / DAY_MS);
        if (dn !== lastDays) {
            cur = civilFromDays(dn);
            days.push({ date: isoDate(cur.y, cur.m, cur.d), first: t, count: 0 });
            lastDays = dn;
        }
        const h = Math.floor((local - dn * DAY_MS) / (30 * MIN_MS));
        const mk = cur.y * 12 + (cur.m - 1);
        if (mk !== lastMonthKey) {
            months.push({ key: `${cur.y}-${pad2(cur.m)}`, monthKey: mk, month0: cur.m - 1, first: t, count: 0, dim: daysInMonth(cur.y, cur.m) });
            lastMonthKey = mk;
        }
        hh[t] = h;
        day[t] = days.length - 1;
        month[t] = cur.m - 1;
        monthKey[t] = mk;
        dow[t] = (((dn + 3) % 7) + 7) % 7;
        peak[t] = h >= PEAK_FROM_HH && h < PEAK_TO_HH ? 1 : 0;
        days[days.length - 1].count++;
        months[months.length - 1].count++;
    }
    return { hh, day, month, monthKey, dow, peak, days, months };
}

/**
 * Slot indices where a daily re-plan happens: the first slot of each local day whose hh equals
 * `atHh` (32 = 16:00, when next-day Agile prices are out; 40 = the conservative 20:00).
 * @param {LocalIndex} local
 * @param {number} [atHh=32]
 * @returns {Int32Array}
 */
export function replanStarts(local, atHh = PEAK_FROM_HH) {
    const out = [];
    for (const d of local.days) {
        for (let t = d.first; t < d.first + d.count; t++) {
            if (local.hh[t] === atHh) { out.push(t); break; }
        }
    }
    return Int32Array.from(out);
}

/**
 * Exclusive end of a rolling-horizon plan starting at slot t: the first slot at local 23:00
 * (hh 46) on the next local date — the end of the last Agile day whose prices are known.
 * Returns n when the dataset ends first. On clock-change days this is 60 or 64 slots from a
 * 16:00 re-plan, not 62.
 * @param {LocalIndex} local
 * @param {number} t
 * @returns {number}
 */
export function horizonEnd(local, t) {
    const n = local.hh.length;
    const target = local.day[t] + 1;
    const d = local.days[target];
    if (!d) return n;
    for (let u = d.first; u < d.first + d.count; u++) if (local.hh[u] === 46) return u;
    return Math.min(n, d.first + d.count);
}
