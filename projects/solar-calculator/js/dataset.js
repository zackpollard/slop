/*
 * dataset.js — turns usage, prices and weather into one aligned, immutable Dataset.
 *
 * Rules that matter for correctness (engine critique, accepted amendments):
 *   - Every series is joined on the UTC epoch ms of the slot start, never by array
 *     index: the research Agile file starts at local midnight (23:00Z in BST) while the
 *     weather file starts at UTC midnight, and an index zip shifts the sun by an hour
 *     against the prices — exactly the 16:00–19:00 question the user is asking.
 *   - Prices exist in three bases: as billed (exc × (1 + VAT at the time)), ex VAT, and a
 *     forward basis that removes the 3.333p ex-VAT levy Agile carried until
 *     2026-03-31T22:00Z (the 1 April 2026 Agile day). Export income is never VAT'd.
 *   - A 24/7 server household never reads 0 kWh for an hour, so runs of ≥2 zero slots are
 *     treated as meter gaps (a single zero is kept), as are readings above 10 kWh.
 *   - Gaps are filled from the same local half-hour and day type (Mon–Fri / Sat–Sun)
 *     within ±14 days (±28 if fewer than 4 donors), else the base load; history shorter
 *     than a year is extended with the nearest 28 real days' profile and flagged as
 *     extrapolated. Simulation uses filled slots; base-load statistics must not.
 *   - Nothing in a Dataset is ever NaN.
 * This module is pure apart from loadDataset (network) and runs in a worker or node.
 */

import { SLOT_MS, DT_H, buildLocalIndex, localMidnightUtc, localParts, daysInMonth } from './time.js';
import { withVat } from './vat.js';
import {
    OctopusClient, parseAccount, normaliseAccountNumber, fetchAgreementPrices, fetchProductPrices, fetchStandingCharges,
    fetchExportPrices, fetchFlexibleRates, resolveRegion, mergeConsumption, parseTariffCode,
    REGION_CENTROIDS, REGIONS, CURRENT, OUTGOING_FIXED_CHANGE_MS,
} from './octopus.js';
import { parseConsumptionCsv } from './csv.js';
import { syntheticLoad } from './demo.js';

/** Agile's ex-VAT levy, removed from the 1 April 2026 Agile day (starts 23:00 BST 31 Mar). */
export const LEVY_EXC_P = 3.333;
export const LEVY_END_MS = Date.parse('2026-03-31T22:00:00Z');
/** Current export rates for the forward basis. */
export const FIXED_EXPORT_FWD_P = 12.0;
export const PRIME_PEAK_P = 16.0;
export const PRIME_OFFPEAK_P = 9.0;
const FIXED_EXPORT_OLD_P = 15.0;

const DAY_MS = 86_400_000;
const MAX_SLOT_KWH = 10;
const DEFAULT_TEMP_C = 10;
const DEFAULT_WIND_MS = 2;

const DEFAULT_ACTIONS = {
    AUTH: 'checkKey', ACCOUNT: 'pickAccount', NO_SMART_DATA: 'useDemo', NETWORK: 'retry', RATE_LIMIT: 'retry',
    WEATHER: 'retry', LOCATION: 'setPostcode', TOO_LITTLE_DATA: 'useDemo', CSV: 'useDemo',
};
const RETRYABLE = new Set(['NETWORK', 'RATE_LIMIT', 'WEATHER']);

/**
 * The one error type for data problems. `action` tells the UI which fix to offer.
 * Crosses the worker boundary as `toJSON()`.
 */
export class DataError extends Error {
    /**
     * @param {'AUTH'|'ACCOUNT'|'NO_SMART_DATA'|'NETWORK'|'RATE_LIMIT'|'WEATHER'|'LOCATION'|'TOO_LITTLE_DATA'|'CSV'} code
     * @param {string} message  user-facing, plain English
     * @param {{ step?: string|null, retryable?: boolean, action?: 'checkKey'|'retry'|'useDemo'|'setPostcode'|'pickAccount'|null, choices?: any[]|null }} [opts]
     */
    constructor(code, message, { step = null, retryable, action, choices = null } = {}) {
        super(message);
        this.name = 'DataError';
        this.code = code;
        this.step = step;
        this.retryable = retryable ?? RETRYABLE.has(code);
        this.action = action ?? DEFAULT_ACTIONS[code] ?? null;
        this.choices = choices;
    }

    /** Structured-clone-safe form used by the worker protocol. */
    toJSON() {
        return { name: this.name, code: this.code, message: this.message, step: this.step, retryable: this.retryable, action: this.action, choices: this.choices };
    }
}

// ───────────────────────────── small helpers ─────────────────────────────

function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** Order-sensitive checksum of a numeric array (for ids: distinct CSVs of one range differ). */
function checksum(arr) {
    let h = 0;
    for (let i = 0; i < arr.length; i++) h = (Math.imul(h, 31) + Math.round(arr[i] * 1e4)) | 0;
    return (h >>> 0).toString(16);
}

function addDays(date, k) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}

function median(values) {
    if (!values.length) return NaN;
    const s = values.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Join a series onto the (start, n) grid by epoch ms.
 * Accepts `{ start, values }`, `Array<[ms, v]>`, or an array already of length n on this grid.
 * @returns {Float64Array} NaN where the source has no value
 */
export function joinByEpoch(src, start, n) {
    const out = new Float64Array(n).fill(NaN);
    if (src == null) return out;
    if (Array.isArray(src) && (src.length === 0 || Array.isArray(src[0]))) {
        for (const [ms, v] of src) {
            const k = (ms - start) / SLOT_MS;
            if (Number.isInteger(k) && k >= 0 && k < n && v != null) out[k] = Number(v);
        }
        return out;
    }
    if (typeof src === 'object' && 'values' in src && Number.isFinite(src.start)) {
        const off = (src.start - start) / SLOT_MS;
        if (!Number.isInteger(off)) throw new Error('joinByEpoch: series start is not on the slot grid');
        const vals = src.values;
        const lo = Math.max(0, off), hi = Math.min(n, off + vals.length);
        for (let k = lo; k < hi; k++) {
            const v = vals[k - off];
            out[k] = v == null ? NaN : Number(v);
        }
        return out;
    }
    if (src.length !== n) throw new Error(`joinByEpoch: aligned array has length ${src.length}, expected ${n}`);
    for (let k = 0; k < n; k++) out[k] = src[k] == null ? NaN : Number(src[k]);
    return out;
}

/** Fill NaN by carrying the nearest value forward, then backward. Returns NaN count filled. */
function carryFill(arr) {
    let filled = 0, last = NaN;
    for (let i = 0; i < arr.length; i++) {
        if (Number.isNaN(arr[i])) { if (!Number.isNaN(last)) { arr[i] = last; filled++; } } else last = arr[i];
    }
    last = NaN;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (Number.isNaN(arr[i])) { if (!Number.isNaN(last)) { arr[i] = last; filled++; } } else last = arr[i];
    }
    return filled;
}

// ───────────────────────────── load cleaning ─────────────────────────────

/**
 * Mark meter gaps as NaN: runs of ≥2 consecutive zero readings (a single zero is kept)
 * and readings above 10 kWh per half-hour.
 * @param {Float64Array} load  kWh per slot, NaN = absent
 * @returns {{ load: Float64Array, zeroRunSlots: number, outlierSlots: number }}
 */
export function markGaps(load) {
    const out = Float64Array.from(load);
    let zeroRunSlots = 0, outlierSlots = 0;
    for (let i = 0; i < out.length;) {
        if (out[i] === 0) {
            let j = i;
            while (j < out.length && out[j] === 0) j++;
            if (j - i >= 2) { out.fill(NaN, i, j); zeroRunSlots += j - i; }
            i = j;
            continue;
        }
        if (out[i] > MAX_SLOT_KWH || out[i] < 0) { out[i] = NaN; outlierSlots++; }
        i++;
    }
    return { load: out, zeroRunSlots, outlierSlots };
}

/**
 * Always-on load from REAL slots: median over local days (≥44 real slots) of the mean of
 * each day's 4 lowest positive half-hours. Falls back to the 5th percentile of positive
 * readings when no day qualifies.
 * @param {Float64Array} load  NaN = gap
 * @param {object} local  LocalIndex
 * @returns {number} W, or NaN without any positive reading
 */
export function realBaseLoadW(load, local) {
    const daily = [];
    for (const { first, count } of local.days) {
        const vals = [];
        for (let t = first; t < first + count; t++) if (load[t] > 0) vals.push(load[t]);
        let real = 0;
        for (let t = first; t < first + count; t++) if (!Number.isNaN(load[t])) real++;
        if (real < 44 || vals.length < 4) continue;
        vals.sort((a, b) => a - b);
        daily.push((vals[0] + vals[1] + vals[2] + vals[3]) / 4);
    }
    if (daily.length) return median(daily) * 1000 / DT_H;
    const pos = [];
    for (let t = 0; t < load.length; t++) if (load[t] > 0) pos.push(load[t]);
    if (!pos.length) return NaN;
    pos.sort((a, b) => a - b);
    return pos[Math.floor(pos.length * 0.05)] * 1000 / DT_H;
}

/**
 * Fill gaps (NaN) in a cleaned load series.
 *  - Inside the span of real data (code 1): median of real values at the same local hh
 *    and day type within ±14 local days; ±28 if fewer than 4 donors; else (a hole of
 *    weeks) the hh × day-type median of the 28 real days nearest that day; base load only
 *    for an hh that has no reading at all.
 *  - Before the first / after the last real reading (code 2, "extrapolated"): the
 *    hh × day-type median of the nearest 28 days that have real data.
 *
 * @param {Float64Array} loadWithNaN  kWh per slot
 * @param {object} local  LocalIndex for the same grid
 * @param {number} baseLoadW  fallback, W
 * @returns {{ load: Float64Array, filled: Uint8Array }}  filled: 0 real, 1 filled, 2 extrapolated
 */
export function fillGaps(loadWithNaN, local, baseLoadW) {
    const n = loadWithNaN.length;
    const load = Float64Array.from(loadWithNaN);
    const filled = new Uint8Array(n);
    const D = local.days.length;
    const baseKwh = Number.isFinite(baseLoadW) && baseLoadW > 0 ? baseLoadW * DT_H / 1000 : 0;

    // One donor cell per (local day, hh); the repeated hh on the 50-slot day is averaged.
    const sum = new Float64Array(D * 48), cnt = new Uint16Array(D * 48);
    const weekend = new Uint8Array(D);
    const realPerDay = new Uint16Array(D);
    let firstReal = -1, lastReal = -1;
    for (let t = 0; t < n; t++) {
        const v = loadWithNaN[t];
        if (Number.isNaN(v)) continue;
        if (firstReal < 0) firstReal = t;
        lastReal = t;
        const c = local.day[t] * 48 + local.hh[t];
        sum[c] += v; cnt[c]++;
        realPerDay[local.day[t]]++;
    }
    for (let d = 0; d < D; d++) weekend[d] = local.dow[local.days[d].first] >= 5 ? 1 : 0;
    if (firstReal < 0) {
        load.fill(baseKwh);
        filled.fill(2);
        return { load, filled };
    }
    const cell = (d, h) => cnt[d * 48 + h] ? sum[d * 48 + h] / cnt[d * 48 + h] : NaN;

    const donorsAt = (d, h, w, radius) => {
        const out = [];
        for (let dd = Math.max(0, d - radius); dd <= Math.min(D - 1, d + radius); dd++) {
            if (weekend[dd] !== w) continue;
            const v = cell(dd, h);
            if (!Number.isNaN(v)) out.push(v);
        }
        return out;
    };

    // Profiles for the extrapolated ends: nearest 28 days with real data.
    const profileFrom = (days) => {
        const prof = new Float64Array(96).fill(NaN); // [weekend*48 + hh]
        for (let w = 0; w < 2; w++) {
            for (let h = 0; h < 48; h++) {
                const vals = [];
                for (const d of days) if (weekend[d] === w) { const v = cell(d, h); if (!Number.isNaN(v)) vals.push(v); }
                prof[w * 48 + h] = median(vals);
            }
        }
        for (let h = 0; h < 48; h++) {
            for (let w = 0; w < 2; w++) {
                if (Number.isNaN(prof[w * 48 + h])) prof[w * 48 + h] = Number.isNaN(prof[(1 - w) * 48 + h]) ? baseKwh : prof[(1 - w) * 48 + h];
            }
        }
        return prof;
    };
    const realDays = [];
    for (let d = 0; d < D; d++) if (realPerDay[d] > 0) realDays.push(d);
    let headProf = null, tailProf = null;

    // Inside a long hole (a meter outage of weeks) even ±28 days has < 4 donors. A flat base
    // load there would erase the household's daily shape — including its 16:00–19:00 peak —
    // for weeks, so use the profile of the 28 real days nearest that day instead (the same
    // rule as the extrapolated ends); the base load is only the last resort for an hh that
    // never has a reading.
    const nearProf = new Map();
    const nearestProfile = (d) => {
        let p = nearProf.get(d);
        if (p) return p;
        let hi = 0;
        while (hi < realDays.length && realDays[hi] < d) hi++;
        let lo = hi - 1;
        const pick = [];
        while (pick.length < 28 && (lo >= 0 || hi < realDays.length)) {
            if (hi >= realDays.length || (lo >= 0 && d - realDays[lo] <= realDays[hi] - d)) pick.push(realDays[lo--]);
            else pick.push(realDays[hi++]);
        }
        p = profileFrom(pick);
        nearProf.set(d, p);
        return p;
    };

    for (let t = 0; t < n; t++) {
        if (!Number.isNaN(load[t])) continue;
        const d = local.day[t], h = local.hh[t], w = weekend[d];
        if (t < firstReal || t > lastReal) {
            if (t < firstReal) headProf ??= profileFrom(realDays.slice(0, 28));
            else tailProf ??= profileFrom(realDays.slice(-28));
            load[t] = (t < firstReal ? headProf : tailProf)[w * 48 + h];
            filled[t] = 2;
            continue;
        }
        let donors = donorsAt(d, h, w, 14);
        if (donors.length < 4) donors = donorsAt(d, h, w, 28);
        load[t] = donors.length >= 4 ? median(donors) : nearestProfile(d)[w * 48 + h];
        filled[t] = 1;
    }
    return { load, filled };
}

/**
 * Choose the analysis window from real readings: the last `days` complete local days,
 * ending on the latest complete day before `endCapMs`. A day is complete when it has at
 * most 2 slots missing — ≥46 of 48 on a normal day, ≥44 on the 46-slot spring-forward
 * day, ≥48 on the 50-slot autumn day (reconciles the 46 and 44 rules of the critiques).
 * Zero runs and >10 kWh readings don't count as real.
 *
 * @param {Array<[number, number]>} rows  readings in any order
 * @param {{ endCapMs?: number, days?: number }} [opts]
 * @returns {{ start: number, n: number, firstDate: string, lastDate: string, realDays: number, completeDays: number }}
 */
export function chooseWindow(rows, { endCapMs = Infinity, days = 365 } = {}) {
    const usable = rows.filter(r => r[0] < endCapMs);
    if (!usable.length) {
        throw new DataError('TOO_LITTLE_DATA', 'No half-hourly readings were found for this period.', { action: 'useDemo' });
    }
    let lo = Infinity, hi = -Infinity; // don't trust the caller's order
    for (const r of usable) { if (r[0] < lo) lo = r[0]; if (r[0] > hi) hi = r[0]; }
    const s0 = localMidnightUtc(localParts(lo).date);
    const lastDate = localParts(hi).date;
    const s1 = localMidnightUtc(addDays(lastDate, 1));
    const span = Math.round((s1 - s0) / SLOT_MS);
    const dense = markGaps(joinByEpoch(usable, s0, span)).load;
    const local = buildLocalIndex(s0, span);
    let end = null, realDays = 0;
    const complete = new Set();
    for (const { date, first, count } of local.days) {
        let real = 0;
        for (let t = first; t < first + count; t++) if (!Number.isNaN(dense[t])) real++;
        if (real > 0) realDays++;
        if (real >= count - 2) { complete.add(date); end = date; }
    }
    if (!end) {
        throw new DataError('TOO_LITTLE_DATA', 'There is not a single complete day of half-hourly readings yet.', { action: 'useDemo' });
    }
    const firstDate = addDays(end, -(days - 1));
    const start = localMidnightUtc(firstDate);
    const stop = localMidnightUtc(addDays(end, 1));
    let completeDays = 0;
    for (const d of complete) if (d >= firstDate) completeDays++;
    return { start, n: Math.round((stop - start) / SLOT_MS), firstDate, lastDate: end, realDays, completeDays };
}

// ───────────────────────────── price helpers ─────────────────────────────

/** Per-slot product code from a tariff list (latest covering agreement wins). */
function productAt(tariffs, start, n) {
    const out = new Array(n).fill(null);
    for (const tf of tariffs.slice().sort((a, b) => a.fromMs - b.fromMs)) {
        const i0 = Math.max(0, Math.ceil((tf.fromMs - start) / SLOT_MS));
        const i1 = Math.min(n, Math.ceil((tf.toMs - start) / SLOT_MS));
        for (let i = i0; i < i1; i++) out[i] = tf.product;
    }
    return out;
}

const isAgileProduct = p => typeof p === 'string' && /^AGILE-/.test(p) && !/OUTGOING|EXPORT/.test(p);

/**
 * Prime export by local clock: 16p in the 16:00–19:00 local peak, 9p otherwise.
 * @returns {Float64Array}
 */
function primeByClock(local) {
    const n = local.peak.length;
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = local.peak[t] ? PRIME_PEAK_P : PRIME_OFFPEAK_P;
    return out;
}

function toClimatology(c) {
    if (!c) return null;
    const f64 = a => a instanceof Float64Array ? a : Float64Array.from(a ?? []);
    const years = c.years instanceof Int16Array ? c.years : Int16Array.from(c.years ?? []);
    // weather.js adds the mean days per month over the climatology years (Feb ≈ 28.25);
    // typical-year scaling divides by it, so a bundled climatology gets the same field.
    let meanDim = c.meanDim ? f64(c.meanDim) : null;
    if (!meanDim && years.length) {
        meanDim = new Float64Array(12);
        for (let m0 = 0; m0 < 12; m0++) {
            let s = 0;
            for (const y of years) s += daysInMonth(y, m0 + 1);
            meanDim[m0] = s / years.length;
        }
    }
    return {
        ...c,
        monthlyKwhM2: f64(c.monthlyKwhM2),
        years,
        yearMonthlyKwhM2: f64(c.yearMonthlyKwhM2),
        ...(meanDim ? { meanDim } : {}),
        ...(years.length && c.fromYear == null ? { fromYear: years[0], toYear: years[years.length - 1] } : {}),
    };
}

/** 'c', '_C' or ' C ' → 'C'; null unless it is one of the 14 GSP group letters. */
function normRegion(r) {
    const g = String(r ?? '').trim().replace(/^_/, '').toUpperCase();
    return REGIONS[g] ? g : null;
}

// ───────────────────────────── build ─────────────────────────────

/**
 * @typedef {Object} DatasetParts
 * @property {'octopus'|'csv'|'demo'|'manual'} source
 * @property {number} start  epoch ms of slot 0 (slot-aligned; normally a local midnight)
 * @property {number} n
 * @property {number} lat
 * @property {number} lon
 * @property {number} [altitude]
 * @property {string|null} region
 * @property {string|null} [postcode]
 * @property {string} [locationSource]
 * @property {Array<[number, number]>|{start:number, values:ArrayLike<number>}|ArrayLike<number>} consumption  real readings (absent = gap)
 * @property {number} [baseLoadW]  fallback fill level; default: estimated from real slots
 * @property {*} importExc  p/kWh exc VAT as billed (any joinByEpoch form)
 * @property {Array<{ code, product, fromMs, toMs, assumed? }>} [tariffs]
 * @property {{ kind: 'series'|'flat', code?: string, product?: string, rawExc?: *, flatExc?: number }} [forward]
 * @property {'mine'|'agile'|'flexible'|'flat'} [priceBasis]
 * @property {boolean} [levyAdjust=true]
 * @property {*} [exportAgile]  Agile Outgoing p/kWh (null/absent = not fetched)
 * @property {*} [exportPrime]  real Prime rows where they exist (gaps synthesised by clock)
 * @property {*} [exportFixed]  Outgoing rows (gaps synthesised 15p → 12p on 2026-03-01)
 * @property {Array<{ fromMs, toMs, pPerDayExc }>} [standing]
 * @property {{ product: string, code?: string, unit: Array<{ fromMs, toMs, exc }>, standing?: Array<{ fromMs, toMs, pPerDayExc }> }|null} [flexible]
 *   the region's Octopus Flexible prices over the window (insights' "same usage on Flexible"); null = not fetched
 * @property {{ start?: number, ghi, dni, dhi, tempC, windMs, wxSource, meta? }} weather
 * @property {object|null} [climatology]
 * @property {Array<{ untilMs: number, rate: number }>} [vatSchedule]
 * @property {number} [serverW]
 * @property {string[]} [notes]
 * @property {number} [createdAtMs]
 */

/**
 * Flexible price records clipped to the window [a0, a1) and checked (finite prices, ascending);
 * null when there are no usable unit rates.
 */
function normFlexible(f, a0, a1) {
    if (!f || typeof f !== 'object' || !Array.isArray(f.unit)) return null;
    const clip = (recs, key) => (Array.isArray(recs) ? recs : [])
        .map(r => ({ fromMs: Math.max(Number(r.fromMs ?? -Infinity), a0), toMs: Math.min(Number(r.toMs ?? Infinity), a1), [key]: Number(r[key]) }))
        .filter(r => r.toMs > r.fromMs && Number.isFinite(r[key]))
        .sort((x, y) => x.fromMs - y.fromMs);
    const unit = clip(f.unit, 'exc');
    if (!unit.length) return null;
    return { product: String(f.product ?? CURRENT.flexible), code: f.code ?? null, unit, standing: clip(f.standing, 'pPerDayExc') };
}

/**
 * Pure: align every input by epoch ms onto (start, n), clean and fill the load, build
 * the price variants and assemble a Dataset (see CONTRACTS §6). Never returns NaN.
 *
 * @param {DatasetParts} parts
 * @returns {object} Dataset
 */
export function buildDataset(parts) {
    const { source, start, n } = parts;
    if (!Number.isFinite(start) || start % SLOT_MS !== 0) throw new Error('buildDataset: start must be on the half-hour grid');
    if (!Number.isInteger(n) || n <= 0) throw new Error('buildDataset: n must be a positive integer');
    const notes = [...(parts.notes ?? [])];
    const local = buildLocalIndex(start, n);

    // Load: join, mark gaps, fill.
    const marked = markGaps(joinByEpoch(parts.consumption, start, n));
    let realSlots = 0;
    for (let t = 0; t < n; t++) if (!Number.isNaN(marked.load[t])) realSlots++;
    if (!realSlots) {
        throw new DataError('TOO_LITTLE_DATA', 'None of the half-hours in this period have usable readings.', { action: 'useDemo' });
    }
    const estBase = realBaseLoadW(marked.load, local);
    const baseLoadW = Number.isFinite(parts.baseLoadW) ? parts.baseLoadW : estBase;
    const { load, filled } = fillGaps(marked.load, local, baseLoadW);
    let filledSlots = 0, extrapolatedSlots = 0;
    for (let t = 0; t < n; t++) { if (filled[t] === 1) filledSlots++; else if (filled[t] === 2) extrapolatedSlots++; }
    if (marked.zeroRunSlots) notes.push(`${marked.zeroRunSlots} half-hours read 0 kWh in a row and were treated as meter gaps.`);
    if (marked.outlierSlots) notes.push(`${marked.outlierSlots} readings above ${MAX_SLOT_KWH} kWh per half-hour were treated as meter errors.`);
    if (filledSlots) notes.push(`${filledSlots} missing half-hours (${(filledSlots / 48).toFixed(1)} days) were estimated from similar days.`);
    if (extrapolatedSlots) notes.push(`${(extrapolatedSlots / 48).toFixed(0)} days before your data starts were extrapolated from your first weeks, to make a full year.`);

    // Import prices.
    const importPriceExc = joinByEpoch(parts.importExc, start, n);
    const priceGaps = importPriceExc.reduce((c, v) => c + (Number.isNaN(v) ? 1 : 0), 0);
    if (priceGaps === n) {
        // Reaching here means the API answered with no rows (a failed request throws earlier),
        // so retrying the same period can't help.
        const from = local.days[0]?.date, to = local.days[local.days.length - 1]?.date;
        throw new DataError('NETWORK', `Octopus publishes no electricity prices for ${from} – ${to}.`, { step: 'prices', retryable: false, action: 'useDemo' });
    }
    if (priceGaps) { carryFill(importPriceExc); notes.push(`${priceGaps} half-hours had no price; the nearest price was used.`); }
    const importPrice = withVat(importPriceExc, start, parts.vatSchedule);
    const tariffs = (parts.tariffs ?? []).map(t => ({ ...t }));
    const levyAdjust = parts.levyAdjust ?? true;
    let importPriceFwdExc;
    const fwd = parts.forward ?? null;
    if (fwd?.kind === 'flat' && Number.isFinite(fwd.flatExc)) {
        importPriceFwdExc = new Float64Array(n).fill(fwd.flatExc);
    } else {
        let raw = importPriceExc;
        let products;
        if (fwd?.kind === 'series' && fwd.rawExc != null) {
            raw = joinByEpoch(fwd.rawExc, start, n);
            for (let t = 0; t < n; t++) if (Number.isNaN(raw[t])) raw[t] = importPriceExc[t];
            products = new Array(n).fill(fwd.product ?? parseTariffCode(fwd.code)?.product ?? null);
        } else {
            products = productAt(tariffs, start, n);
        }
        importPriceFwdExc = Float64Array.from(raw);
        if (levyAdjust) {
            for (let t = 0; t < n; t++) {
                if (start + t * SLOT_MS >= LEVY_END_MS) break;
                if (isAgileProduct(products[t])) importPriceFwdExc[t] -= LEVY_EXC_P;
            }
        }
    }

    // Export prices (as paid, never VAT'd) and their forward variants.
    let agile = parts.exportAgile == null ? null : joinByEpoch(parts.exportAgile, start, n);
    if (agile) {
        let have = 0;
        for (let t = 0; t < n; t++) if (!Number.isNaN(agile[t])) { have++; if (agile[t] < 0) agile[t] = 0; }
        if (!have) agile = null;
        else if (have < n) carryFill(agile);
    }
    const prime = joinByEpoch(parts.exportPrime, start, n);
    const fixed = joinByEpoch(parts.exportFixed, start, n);
    for (let t = 0; t < n; t++) {
        if (Number.isNaN(prime[t])) prime[t] = local.peak[t] ? PRIME_PEAK_P : PRIME_OFFPEAK_P;
        if (Number.isNaN(fixed[t])) fixed[t] = start + t * SLOT_MS < OUTGOING_FIXED_CHANGE_MS ? FIXED_EXPORT_OLD_P : FIXED_EXPORT_FWD_P;
    }
    const exportPrices = { prime, fixed, agile };
    const exportPricesFwd = { prime: primeByClock(local), fixed: new Float64Array(n).fill(FIXED_EXPORT_FWD_P), agile };

    // Weather, joined by epoch.
    const w = parts.weather;
    if (!w || !w.ghi) throw new DataError('WEATHER', 'No weather data was supplied for this period.', { step: 'weather' });
    const ws = Number.isFinite(w.start) ? w.start : start;
    const wj = key => joinByEpoch(w[key] == null ? null : { start: ws, values: w[key] }, start, n);
    const ghiJ = wj('ghi'), dniJ = wj('dni'), dhiJ = wj('dhi'), tJ = wj('tempC'), vJ = wj('windMs'), srcJ = wj('wxSource');
    let wxMissing = 0;
    const ghi = new Float32Array(n), dni = new Float32Array(n), dhi = new Float32Array(n);
    const wxSource = new Uint8Array(n);
    for (let t = 0; t < n; t++) {
        if (Number.isNaN(ghiJ[t])) wxMissing++;
        ghi[t] = Number.isNaN(ghiJ[t]) ? 0 : Math.max(0, ghiJ[t]);
        dni[t] = Number.isNaN(dniJ[t]) ? 0 : Math.max(0, dniJ[t]);
        dhi[t] = Number.isNaN(dhiJ[t]) ? 0 : Math.max(0, dhiJ[t]);
        wxSource[t] = Number.isNaN(srcJ[t]) ? 4 : srcJ[t];
    }
    if (wxMissing > 48) {
        throw new DataError('WEATHER', `Sunshine data is missing for ${(wxMissing / 48).toFixed(1)} days of this period.`, { step: 'weather' });
    }
    if (wxMissing) notes.push(`${wxMissing} half-hours had no sunshine data and were set to dark.`);
    const nearestFill = (arr, dflt) => {
        // Nearest valid value within 3 h (6 slots), else a neutral default.
        const out = new Float32Array(n);
        let defaulted = 0;
        for (let t = 0; t < n; t++) {
            if (!Number.isNaN(arr[t])) { out[t] = arr[t]; continue; }
            let v = NaN;
            for (let k = 1; k <= 6 && Number.isNaN(v); k++) {
                if (t - k >= 0 && !Number.isNaN(arr[t - k])) v = arr[t - k];
                else if (t + k < n && !Number.isNaN(arr[t + k])) v = arr[t + k];
            }
            if (Number.isNaN(v)) { v = dflt; defaulted++; }
            out[t] = v;
        }
        return { out, defaulted };
    };
    const tempFill = nearestFill(tJ, DEFAULT_TEMP_C);
    const windFill = nearestFill(vJ, DEFAULT_WIND_MS);
    if (tempFill.defaulted || windFill.defaulted) {
        notes.push(`Temperature or wind was missing for ${Math.max(tempFill.defaulted, windFill.defaulted)} half-hours; ${DEFAULT_TEMP_C} °C / ${DEFAULT_WIND_MS} m/s were assumed.`);
    }
    const counts = [0, 0, 0, 0, 0];
    for (let t = 0; t < n; t++) counts[Math.min(4, wxSource[t])]++;
    const weatherMeta = { ...(w.meta ?? {}), counts };

    const standing = (parts.standing ?? []).map(s => ({ fromMs: s.fromMs, toMs: s.toMs, pPerDayExc: s.pPerDayExc }));
    const flexible = normFlexible(parts.flexible, start, start + n * SLOT_MS);
    const lat = Number(parts.lat), lon = Number(parts.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new DataError('LOCATION', 'A location is needed to look up sunshine.', { action: 'setPostcode' });
    }
    const priceBasis = parts.priceBasis ?? 'mine';
    const serverW = Number.isFinite(parts.serverW) ? parts.serverW : undefined;
    const id = 'ds-' + fnv1a([
        source, start, n, lat.toFixed(4), lon.toFixed(4), priceBasis,
        tariffs.map(t => `${t.code}@${t.fromMs}`).join(','), serverW ?? '',
        checksum(load), checksum(importPriceExc),
    ].join('|')) + fnv1a(`${source}:${start}:${n}:${checksum(filled)}`).slice(0, 4);

    return {
        id, start, n, lat, lon,
        altitude: Number.isFinite(parts.altitude) ? parts.altitude : Number.isFinite(w.meta?.elevation) ? w.meta.elevation : 0,
        load, loadFilled: filled,
        importPriceExc, importPrice, importPriceFwdExc,
        exportPrices, exportPricesFwd,
        standing,
        flexible,
        ghi, dni, dhi, tempC: tempFill.out, windMs: windFill.out, wxSource,
        local,
        climatology: toClimatology(parts.climatology),
        meta: {
            source,
            region: parts.region ?? null,
            postcode: parts.postcode ?? null,
            locationSource: parts.locationSource ?? (parts.postcode ? 'postcode' : 'latlon'),
            tariffs,
            priceBasis,
            ...(serverW !== undefined ? { serverW } : {}),
            baseLoadW: Number.isFinite(estBase) ? estBase : null,
            coverage: { realPct: 100 * realSlots / n, filledSlots, extrapolatedSlots, days: n / 48 },
            weather: weatherMeta,
            forward: { levyAdjust, levyExcP: LEVY_EXC_P, levyEndMs: LEVY_END_MS, kind: fwd?.kind ?? 'series', code: fwd?.code ?? tariffs[tariffs.length - 1]?.code ?? null },
            notes,
            createdAtMs: Number.isFinite(parts.createdAtMs) ? parts.createdAtMs : 0,
        },
    };
}

/**
 * Small, structured-clone-friendly description of a Dataset for the UI.
 * @param {object} ds
 * @returns {{ id, start, n, days, from, to, region, regionName, postcode, lat, lon, altitude, source, coverage,
 *   tariffs, tariffCode, priceBasis, serverW, baseLoadW, locationSource, notes, weather, createdAtMs,
 *   flexible: { product, code }|null }}
 */
export function summarize(ds) {
    const days = ds.local.days;
    const tariffs = ds.meta.tariffs ?? [];
    return {
        id: ds.id, start: ds.start, n: ds.n, days: ds.n / 48,
        from: days[0]?.date ?? null, to: days[days.length - 1]?.date ?? null,
        region: ds.meta.region, regionName: REGIONS[ds.meta.region] ?? null,
        postcode: ds.meta.postcode, lat: ds.lat, lon: ds.lon, altitude: ds.altitude,
        source: ds.meta.source, coverage: { ...ds.meta.coverage },
        tariffs: tariffs.map(t => ({ ...t })),
        tariffCode: tariffs[tariffs.length - 1]?.code ?? null,
        priceBasis: ds.meta.priceBasis, serverW: ds.meta.serverW ?? null, baseLoadW: ds.meta.baseLoadW ?? null,
        locationSource: ds.meta.locationSource,
        notes: [...ds.meta.notes], weather: { ...ds.meta.weather },
        createdAtMs: ds.meta.createdAtMs,
        flexible: ds.flexible ? { product: ds.flexible.product, code: ds.flexible.code } : null,
    };
}

/**
 * Re-project the dataset to a different always-on load: load'_t = max(0, load_t +
 * (targetW − baseW)·Δt/1000). Every other array is shared (Datasets are immutable).
 *
 * @param {object} ds
 * @param {number} baseW  the always-on load the data shows
 * @param {number} targetW  the always-on load to project with
 * @returns {object} Dataset (same object identity of every array except load)
 */
export function withBaseLoad(ds, baseW, targetW) {
    const delta = (targetW - baseW) * DT_H / 1000;
    if (!Number.isFinite(delta) || delta === 0) return { ...ds };
    const load = new Float64Array(ds.n);
    for (let t = 0; t < ds.n; t++) load[t] = Math.max(0, ds.load[t] + delta);
    // The id must change with ANY change of load (results are cached by id): rounding to
    // whole watts made +0.2 W and +0.4 W share an id while their loads differed.
    const dW = Number((targetW - baseW).toPrecision(12));
    return {
        ...ds,
        id: `${ds.id}~b${dW}`,
        load,
        meta: { ...ds.meta, projectedBase: { baseW, targetW } },
    };
}

/** demo.json's Flexible block ({ from, to } ISO, to null = open) as buildDataset parts. */
function demoFlexible(f) {
    if (!f || !Array.isArray(f.unit)) return null;
    const ms = (iso, dflt) => (iso == null ? dflt : Date.parse(iso));
    const recs = (list, key) => (list ?? []).map(r => ({ fromMs: ms(r.from, -Infinity), toMs: ms(r.to, Infinity), [key]: r.exc }));
    return { product: f.product, code: f.code ?? null, unit: recs(f.unit, 'exc'), standing: recs(f.standing, 'pPerDayExc') };
}

/**
 * Demo Dataset from the shipped data/demo.json (real London Agile prices, Agile Outgoing
 * and SARAH-3 sunshine for 1 Oct 2025 – 30 Sep 2026) + a seeded synthetic household.
 *
 * @param {object} json  parsed data/demo.json
 * @param {{ serverW?: number, seed?: number }} [opts]
 * @returns {object} Dataset
 */
export function demoDatasetFromJson(json, { serverW = 500, seed = 1 } = {}) {
    const start = Number(json.start);
    const n = json.n;
    const local = buildLocalIndex(start, n);
    const load = syntheticLoad(local, { serverW, seed });
    const end = start + n * SLOT_MS;
    const product = parseTariffCode(json.tariffCode)?.product ?? CURRENT.agile;
    const wxCounts = [0, 0, 0, 0, 0];
    let sarahLastMs = null;
    for (let t = 0; t < n; t++) {
        wxCounts[json.wxSource[t]]++;
        if (json.wxSource[t] === 0) sarahLastMs = start + t * SLOT_MS;
    }
    return buildDataset({
        source: 'demo', start, n,
        lat: json.lat, lon: json.lon, altitude: json.altitude ?? 0,
        region: json.region, postcode: json.postcode, locationSource: 'demo',
        consumption: load,
        importExc: { start, values: json.importExc },
        tariffs: [{ code: json.tariffCode, product, fromMs: start, toMs: end }],
        forward: { kind: 'series', code: json.tariffCode, product, rawExc: { start, values: json.importExc } },
        priceBasis: 'mine',
        exportAgile: { start, values: json.exportAgile },
        standing: [{ fromMs: start, toMs: end, pPerDayExc: json.standingPPerDayExc }],
        flexible: demoFlexible(json.flexible),
        weather: {
            start,
            ghi: json.ghi, dni: json.dni, dhi: json.dhi, tempC: json.tempC, windMs: json.windMs, wxSource: json.wxSource,
            meta: {
                counts: wxCounts, sarahLastMs, ifsScaled: false,
                gridLat: json.weatherGrid?.lat ?? json.lat, gridLon: json.weatherGrid?.lon ?? json.lon,
                elevation: json.altitude ?? 0,
                notes: [json.attribution],
            },
        },
        climatology: json.climatology,
        serverW,
        notes: [`Example data: real London Agile prices and satellite sunshine (${json.from ?? ''} – ${json.to ?? ''}); the household's usage is synthetic, with ${serverW} W of servers running 24/7.`],
        createdAtMs: Date.parse(json.generatedAt ?? '') || 0,
    });
}

// ───────────────────────────── loading ─────────────────────────────

/**
 * Geocode a location. postcodes.io (CORS *, verified 2026-10-05) for full postcodes, its
 * outcode endpoint for partial ones; the region centroid as a last resort.
 *
 * @param {{ postcode?: string, lat?: number, lon?: number }|null} location
 * @param {{ fetch: typeof fetch, region?: string|null, signal?: AbortSignal }} ctx
 * @returns {Promise<{ lat: number, lon: number, postcode: string|null, locationSource: string, notes: string[] }>}
 */
export async function resolveLocation(location, { fetch: fetchImpl, region = null, signal } = {}) {
    const notes = [];
    const lat = Number(location?.lat), lon = Number(location?.lon);
    if (location?.lat != null && location?.lon != null && location.lat !== '' && location.lon !== ''
        && Number.isFinite(lat) && Number.isFinite(lon)) {
        if (lat < 49 || lat > 61 || lon < -9 || lon > 2.5) {
            throw new DataError('LOCATION', 'That location is outside Great Britain.', { action: 'setPostcode' });
        }
        return { lat, lon, postcode: location.postcode ?? null, locationSource: 'latlon', notes };
    }
    const pc = String(location?.postcode ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (pc) {
        const get = async (path) => {
            try {
                const res = await fetchImpl(`https://api.postcodes.io/${path}`, { signal, credentials: 'omit' });
                if (!res.ok) return null;
                const j = await res.json();
                return Number.isFinite(j?.result?.latitude) && Number.isFinite(j?.result?.longitude) ? j.result : null;
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                return null;
            }
        };
        const full = await get(`postcodes/${encodeURIComponent(pc.replace(/\s+/g, ''))}`);
        if (full) return { lat: full.latitude, lon: full.longitude, postcode: full.postcode ?? pc, locationSource: 'postcode', notes };
        const compact = pc.replace(/\s+/g, '');
        const outward = pc.includes(' ') ? pc.split(' ')[0] : compact.length >= 5 ? compact.slice(0, -3) : compact;
        const out = await get(`outcodes/${encodeURIComponent(outward)}`);
        if (out) {
            notes.push(`Located by postcode district ${outward}; set your full postcode for the exact spot.`);
            return { lat: out.latitude, lon: out.longitude, postcode: pc, locationSource: 'outcode', notes };
        }
    }
    if (region && REGION_CENTROIDS[region]) {
        const c = REGION_CENTROIDS[region];
        notes.push('Using the centre of your region — set your postcode for accurate sunshine.');
        return { lat: c.lat, lon: c.lon, postcode: pc || null, locationSource: 'region-centroid', notes };
    }
    throw new DataError('LOCATION', pc ? `Couldn't find the postcode ${pc}.` : 'Enter a postcode (or pick a spot on the map) to look up sunshine.', { action: 'setPostcode' });
}

/** Wrap one pipeline step with progress events and step-tagged errors. */
async function step(onProgress, name, fn) {
    onProgress?.({ step: name, status: 'start' });
    try {
        const out = await fn();
        return out;
    } catch (e) {
        // weather.js throws a look-alike (name 'DataError') to avoid an import cycle.
        if (e && typeof e === 'object' && (e instanceof DataError || e.name === 'DataError') && !e.step) e.step = name;
        onProgress?.({ step: name, status: 'error', detail: e?.message ?? String(e) });
        throw e;
    }
}

/**
 * Prices for a window on the requested basis.
 * @returns {Promise<{ exc, tariffs, standing, notes, forward, priceBasis }>}
 */
async function pricesFor(client, { basis, agreements, region, start, n, nowMs, flatP }) {
    if (basis === 'mine' && agreements?.length) {
        return { ...await fetchAgreementPrices(client, { agreements, region, start, n, nowMs }), priceBasis: 'mine' };
    }
    if (basis === 'flexible') {
        return { ...await fetchProductPrices(client, { product: CURRENT.flexible, region, start, n, nowMs }), priceBasis: 'flexible' };
    }
    if (basis === 'flat') {
        const p = Number.isFinite(flatP) && flatP > 0 ? flatP : 25;
        // Only the standing charge is needed: a year of half-hourly unit rates (12+ requests)
        // would be fetched and thrown away.
        const base = await fetchStandingCharges(client, { agreements, region, start, n });
        return {
            exc: new Float64Array(n).fill(p),
            tariffs: [{ code: `FLAT-${p}p`, product: `FLAT-${p}p`, fromMs: start, toMs: start + n * SLOT_MS }],
            standing: base.standing,
            notes: [`Priced at a flat ${p}p/kWh (before VAT); standing charges from ${base.code}.`],
            forward: { kind: 'flat', code: `FLAT-${p}p`, product: `FLAT-${p}p`, flatExc: p },
            priceBasis: 'flat',
        };
    }
    const product = await client.latestAgileProduct();
    return { ...await fetchProductPrices(client, { product, region, start, n, nowMs }), priceBasis: 'agile' };
}

/**
 * Load a Dataset from any source, reporting progress per step:
 * account → usage → prices → export → weather → climatology → build.
 *
 * `deps` lets tests replace weather fetching; `nowMs` pins "now".
 *
 * @param {{ kind: 'octopus', apiKey: string, accountNumber?: string, mpan?: string, location?: object, priceBasis?: string, flatP?: number, installedSolarDate?: string }
 *   | { kind: 'demo', serverW?: number, seed?: number }
 *   | { kind: 'csv', text: string, location: object, region?: string, priceBasis?: string, flatP?: number }
 *   | { kind: 'manual', baseW: number, otherKwhYr: number, location: object, region?: string, priceBasis?: string, flatP?: number }} spec
 * @param {{ fetch?: typeof fetch, cache?: object, onProgress?: (e: object) => void, signal?: AbortSignal, nowMs?: number,
 *   sleep?: (ms: number) => Promise<void>, deps?: { fetchWeather?: Function, fetchClimatology?: Function } }} [ctx]
 * @returns {Promise<object>} Dataset
 */
export async function loadDataset(spec, ctx = {}) {
    const fetchImpl = ctx.fetch ?? globalThis.fetch?.bind(globalThis);
    const { cache = null, onProgress = null, signal = undefined } = ctx;
    const nowMs = ctx.nowMs ?? Date.now();
    // weather.js is loaded lazily: demo/build paths never need it, and tests inject stubs.
    const weatherMod = () => import('./weather.js');
    const getWeather = ctx.deps?.fetchWeather ?? (async (a) => (await weatherMod()).fetchWeather(a));
    const getClimatology = ctx.deps?.fetchClimatology ?? (async (a) => (await weatherMod()).fetchClimatology(a));
    const progress = e => { try { onProgress?.(e); } catch { /* UI errors must not break loading */ } };

    if (spec?.kind === 'demo') {
        const json = await step(progress, 'usage', async () => {
            const res = await fetchImpl(new URL('../data/demo.json', import.meta.url).href, { signal });
            if (!res.ok) throw new DataError('NETWORK', `Couldn't load the example data (${res.status}).`, { retryable: true });
            return res.json();
        });
        progress({ step: 'usage', status: 'done', count: json.n, pct: 100, detail: 'Example household' });
        progress({ step: 'prices', status: 'done', count: json.n, detail: json.tariffCode });
        progress({ step: 'weather', status: 'done', count: json.n / 48, detail: 'Satellite sunshine, London' });
        progress({ step: 'build', status: 'start' });
        const ds = demoDatasetFromJson(json, { serverW: spec.serverW ?? 500, seed: spec.seed ?? 1 });
        progress({ step: 'build', status: 'done' });
        return ds;
    }

    const client = new OctopusClient({ apiKey: spec?.apiKey ?? null, fetch: fetchImpl, signal, sleep: ctx.sleep, cache, nowMs });
    const notes = [];
    let rows, window, region = normRegion(spec?.region), postcode = null, agreements = null, mpan = null;
    let source = spec?.kind;
    let installCapMs = Infinity;

    if (spec?.kind === 'octopus') {
        const acct = await step(progress, 'account', async () => {
            let number = normaliseAccountNumber(spec.accountNumber);
            if (spec.accountNumber && !number) {
                throw new DataError('ACCOUNT', 'Octopus account numbers look like A-1234ABCD.', { action: 'pickAccount' });
            }
            if (!number) {
                const found = await client.findAccountNumbers();
                if (!found.length) throw new DataError('ACCOUNT', 'No electricity account was found for this API key.', { action: 'checkKey' });
                if (found.length > 1) {
                    throw new DataError('ACCOUNT', 'This key can see more than one account — pick one.', { action: 'pickAccount', choices: found });
                }
                number = found[0];
            }
            const a = parseAccount(await client.account(number));
            if (spec.mpan) {
                const chosen = a.property?.importPoints.find(p => p.mpan === String(spec.mpan));
                if (chosen) { a.importPoint = chosen; a.agreements = chosen.agreements; }
            } else if (a.importChoices.length > 1) {
                throw new DataError('ACCOUNT', 'This property has more than one electricity meter — pick one.', {
                    action: 'pickAccount', choices: a.importChoices.map(p => ({ mpan: p.mpan, serials: p.serials })),
                });
            }
            if (!a.importPoint || !a.importPoint.serials.length) {
                throw new DataError('NO_SMART_DATA', 'No electricity meter was found on this account.', { action: 'useDemo' });
            }
            return a;
        });
        mpan = acct.importPoint.mpan;
        agreements = acct.agreements;
        postcode = acct.postcode;
        const reg = await resolveRegion(client, { agreements, mpan, postcode: String(spec.location?.postcode ?? '').trim() || postcode });
        region = reg.region;
        if (!region) throw new DataError('ACCOUNT', "Couldn't work out your electricity region.", { step: 'account', action: 'setPostcode' });
        progress({ step: 'account', status: 'done', detail: `${acct.number} · ${REGIONS[region]} · ${agreements[agreements.length - 1]?.code ?? ''}` });

        if (spec.installedSolarDate) installCapMs = localMidnightUtc(spec.installedSolarDate);
        const endCap = Math.min(nowMs, installCapMs);
        rows = await step(progress, 'usage', async () => {
            // One read per serial, merged on a temporary grid and never summed (meter exchanges).
            const read = async (from, to) => {
                const series = [];
                for (const serial of acct.importPoint.serials) series.push(await client.consumption(mpan, serial, from, to));
                const live = series.filter(s => s.length);
                if (live.length <= 1) return live[0] ?? [];
                const t0 = Math.min(...live.map(s => s[0][0]));
                const t1 = Math.max(...live.map(s => s[s.length - 1][0])) + SLOT_MS;
                const span = Math.round((t1 - t0) / SLOT_MS);
                const m = mergeConsumption(live, t0, span);
                const out = [];
                for (let k = 0; k < span; k++) if (!Number.isNaN(m[k])) out.push([t0 + k * SLOT_MS, m[k]]);
                return out;
            };
            const from = endCap - 372 * DAY_MS;
            let got = (await read(from, endCap)).filter(r => r[0] >= from && r[0] < endCap);
            if (!got.length) {
                throw new DataError('NO_SMART_DATA', 'Octopus has no half-hourly readings for this meter. Is it a smart meter sending half-hourly data?', { action: 'useDemo' });
            }
            // Smart meters often stop communicating for weeks. The year before the LAST
            // reading then starts before `from`; read that stretch too rather than
            // extrapolating months that Octopus actually has.
            const last = got[got.length - 1][0];
            if (last < endCap - 7 * DAY_MS) {
                const earlier = (await read(last - 372 * DAY_MS, from)).filter(r => r[0] < from);
                got = earlier.concat(got);
            }
            return got;
        });
        source = 'octopus';
    } else if (spec?.kind === 'csv') {
        const parsed = await step(progress, 'usage', async () => parseConsumptionCsv(spec.text));
        rows = parsed.rows;
        notes.push(...parsed.warnings);
        if (spec.installedSolarDate) installCapMs = localMidnightUtc(spec.installedSolarDate);
    } else if (spec?.kind === 'manual') {
        const baseW = Math.max(0, Number(spec.baseW) || 0);
        const other = Math.max(0, Number(spec.otherKwhYr) || 0);
        if (!(baseW > 0 || other > 0)) {
            // Both zero would build an all-zero year that the gap rules then reject as "no readings".
            throw new DataError('TOO_LITTLE_DATA', 'Enter your always-on load (W) or your other yearly use (kWh) to build a usage profile.', { step: 'usage', action: 'useDemo' });
        }
        // A synthetic year ending three days ago (weather archives lag by a few days).
        const today = localParts(nowMs).date;
        const end = localMidnightUtc(addDays(today, -3));
        const start = localMidnightUtc(addDays(today, -368));
        window = { start, n: Math.round((end - start) / SLOT_MS) };
        const local = buildLocalIndex(window.start, window.n);
        const load = syntheticLoad(local, { serverW: baseW, householdKwhYr: other, seed: 1, householdFloor: false });
        rows = Array.from(load, (v, k) => [window.start + k * SLOT_MS, v]);
        notes.push(`Usage is a typical profile built from your inputs: ${baseW} W always on plus ${other} kWh/yr of other use.`);
    } else {
        throw new DataError('CSV', `Unknown data source '${spec?.kind}'.`, { action: 'useDemo' });
    }

    if (spec.kind !== 'octopus') {
        // CSV and manual need a region for prices: given, from the postcode, or from a map
        // point via postcodes.io reverse geocoding (CORS *, verified 2026-10-05).
        let pc = String(spec.location?.postcode ?? '').trim();
        const lat = Number(spec.location?.lat), lon = Number(spec.location?.lon);
        if (!region && !pc && spec.location?.lat != null && Number.isFinite(lat) && Number.isFinite(lon)) {
            try {
                const res = await fetchImpl(`https://api.postcodes.io/postcodes?${new URLSearchParams({ lon: String(lon), lat: String(lat), radius: '2000', limit: '1' })}`, { signal, credentials: 'omit' });
                if (res.ok) pc = (await res.json())?.result?.[0]?.postcode ?? '';
            } catch (e) { if (e?.name === 'AbortError') throw e; }
        }
        if (!region && pc) {
            try {
                const gs = await client.gspForPostcode(pc);
                region = gs[0] ?? null;
            } catch (e) { if (e?.name === 'AbortError') throw e; }
        }
        if (!region || !REGIONS[region]) {
            throw new DataError('LOCATION', 'Pick your electricity region (or enter a postcode) so we can price your usage.', { step: 'prices', action: 'setPostcode' });
        }
    }

    if (!window) {
        try {
            window = chooseWindow(rows, { endCapMs: installCapMs });
            if (window.realDays < 14) {
                throw new DataError('TOO_LITTLE_DATA', `Only ${window.realDays} days of readings were found; at least 14 are needed.`, { action: 'useDemo' });
            }
            if (Number.isFinite(installCapMs) && window.realDays < 180) {
                throw new DataError('TOO_LITTLE_DATA', 'Not enough usage from before your install (at least 180 days are needed).', { action: 'useDemo' });
            }
        } catch (e) {
            if (e instanceof DataError && !e.step) e.step = 'usage';
            progress({ step: 'usage', status: 'error', detail: e?.message ?? String(e) });
            throw e;
        }
        const inWin = rows.filter(r => r[0] >= window.start && r[0] < window.start + window.n * SLOT_MS).length;
        progress({ step: 'usage', status: 'done', count: inWin, pct: 100 * inWin / window.n, detail: `${window.firstDate} – ${window.lastDate}` });
    } else {
        progress({ step: 'usage', status: 'done', count: window.n, pct: 100 });
    }
    const { start, n } = window;

    const basis = spec.priceBasis ?? (spec.kind === 'octopus' ? 'mine' : 'agile');
    const prices = await step(progress, 'prices', () => pricesFor(client, {
        basis, agreements: spec.kind === 'octopus' ? agreements : null, region, start, n, nowMs, flatP: spec.flatP,
    }));
    notes.push(...prices.notes);
    if (spec.kind !== 'octopus' && basis === 'mine') notes.push('Without an Octopus account the usage is priced as if on Agile today.');
    progress({ step: 'prices', status: 'done', count: n, detail: prices.tariffs.map(t => t.code).join(', ') });

    const exp = await step(progress, 'export', () => fetchExportPrices(client, { region, start, n }));
    notes.push(...exp.notes);
    progress({ step: 'export', status: 'done', detail: exp.agile ? 'Agile Outgoing, Outgoing, Prime' : 'Outgoing, Prime' });

    // The same usage on the region's Flexible tariff (Usage tab): two small public requests; a
    // failure only hides that comparison.
    let flexible = null;
    try {
        flexible = await fetchFlexibleRates(client, { region, start, n });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
    }

    // The store keeps { postcode, lat, lon } with empty fields; fall back to the account's postcode.
    const typedPc = String(spec.location?.postcode ?? '').trim();
    const where = { ...(spec.location ?? {}), postcode: typedPc || postcode || null };
    const loc = await step(progress, 'weather', () => resolveLocation(where, { fetch: fetchImpl, region, signal }));
    notes.push(...loc.notes);
    // The newest days can lack every weather source for a while (SARAH-3 lags ~3 days, and
    // an MSG outage leaves only the model archive, which lags too). Rather than fail the
    // whole load, end the period up to 4 days earlier; usage and prices are cut to match.
    let weather = null, nw = n;
    progress({ step: 'weather', status: 'start' });
    for (let attempt = 0; ; attempt++) {
        try {
            weather = await getWeather({
                lat: loc.lat, lon: loc.lon, start, n: nw, fetch: fetchImpl, cache, signal, nowMs,
                onProgress: e => progress({ ...(e && typeof e === 'object' ? e : { detail: String(e) }), step: 'weather', status: 'start' }),
            });
            break;
        } catch (e) {
            if (e?.code === 'WEATHER' && attempt < 2 && nw > 96 * 7) { nw -= 96; continue; }
            // weather.js throws a look-alike (name 'DataError') to avoid an import cycle.
            if (e && typeof e === 'object' && (e instanceof DataError || e.name === 'DataError') && !e.step) e.step = 'weather';
            progress({ step: 'weather', status: 'error', detail: e?.message ?? String(e) });
            throw e;
        }
    }
    if (nw < n) notes.push(`Sunshine data for the last ${((n - nw) / 48).toFixed(0)} days isn't published yet, so the period ends ${((n - nw) / 48).toFixed(0)} days earlier.`);
    progress({ step: 'weather', status: 'done', count: nw / 48, detail: `${(nw / 48).toFixed(0)} days` });

    let climatology = null;
    try {
        climatology = await step(progress, 'climatology', () => getClimatology({ lat: loc.lat, lon: loc.lon, fetch: fetchImpl, cache, signal }));
        progress({ step: 'climatology', status: 'done' });
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        notes.push('20-year sunshine averages could not be fetched; results use the actual last 12 months only.');
    }

    return step(progress, 'build', async () => {
        // Window-length arrays are passed as { start, values } so they join by epoch even
        // when the weather step shortened the period.
        const onGrid = a => (a == null ? a : { start, values: a });
        const end = start + nw * SLOT_MS;
        const forward = prices.forward?.rawExc ? { ...prices.forward, rawExc: onGrid(prices.forward.rawExc) } : prices.forward;
        const ds = buildDataset({
            source, start, n: nw,
            lat: loc.lat, lon: loc.lon,
            region, postcode: loc.postcode ?? postcode, locationSource: loc.locationSource,
            consumption: rows,
            importExc: onGrid(prices.exc), forward, priceBasis: prices.priceBasis,
            tariffs: prices.tariffs.filter(t => t.fromMs < end).map(t => ({ ...t, toMs: Math.min(t.toMs, end) })),
            exportAgile: onGrid(exp.agile), exportPrime: onGrid(exp.prime), exportFixed: onGrid(exp.fixed),
            standing: prices.standing.filter(s => s.fromMs < end).map(s => ({ ...s, toMs: Math.min(s.toMs, end) })),
            flexible,
            weather, climatology,
            notes,
            createdAtMs: nowMs,
        });
        progress({ step: 'build', status: 'done' });
        return ds;
    });
}
