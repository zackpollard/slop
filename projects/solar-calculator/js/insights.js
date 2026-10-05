/*
 * insights.js — what the user's own half-hourly data says before any solar is added: the
 * always-on (base) load and what it costs, the 16:00–19:00 peak share, average day profiles,
 * monthly bills, heatmaps and negative-price slots.
 *
 * Statistics that describe the user's behaviour (base load, percentiles, profiles, heatmaps,
 * load-weighted price) use REAL meter readings only; gap-filled slots would otherwise pull the
 * estimates toward the fill model. Money totals (bills) include filled slots because the
 * simulation does too.
 */

import { SLOT_MS, localMidnightUtc } from './time.js';
import { DEFAULT_VAT_SCHEDULE, vatAt } from './vat.js';

/** Days per calendar month used to annualise (Feb = 28: a "typical" year). */
export const DIM = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/** Linear-interpolated quantile (numpy default) of an already sorted array. */
function quantileSorted(a, q) {
    if (!a.length) return NaN;
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function sortedFinite(values) {
    const out = [];
    for (const v of values) if (Number.isFinite(v)) out.push(v);
    return Float64Array.from(out).sort();
}

const nextDate = (date) => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

const daySlotsCache = new Map();
/**
 * Slots in a full local day: 48, or 46/50 on clock-change days (so a complete DST day still
 * counts as exactly one covered day when annualising).
 * @param {string} date local 'YYYY-MM-DD'
 * @returns {number}
 */
export function slotsInLocalDay(date) {
    let v = daySlotsCache.get(date);
    if (v === undefined) {
        v = Math.round((localMidnightUtc(nextDate(date)) - localMidnightUtc(date)) / SLOT_MS);
        daySlotsCache.set(date, v);
    }
    return v;
}

const coverageCache = new WeakMap();
/**
 * Per local calendar month of the dataset: how many days it covers (fractional at the window
 * edges, exactly 1 per complete day even on 46/50-slot days), and the factor that scales an
 * additive quantity of that month-of-year up to a full typical month: DIM[m0]/Σ covered days of
 * every dataset month with that month-of-year (two partial Octobers share one factor).
 * @param {{ local: Object }} ds
 * @returns {{ coveredDays: Float64Array, factorByMonth0: Float64Array, coveredByMonth0: Float64Array }}
 *   coveredDays aligned with ds.local.months; factor 0 for months with no data
 */
export function monthCoverage(ds) {
    const local = ds.local;
    let v = coverageCache.get(local);
    if (v) return v;
    const coveredDays = new Float64Array(local.months.length);
    let mi = 0;
    for (const d of local.days) {
        while (mi < local.months.length - 1 && d.first >= local.months[mi].first + local.months[mi].count) mi++;
        coveredDays[mi] += d.count / slotsInLocalDay(d.date);
    }
    const coveredByMonth0 = new Float64Array(12);
    local.months.forEach((m, i) => { coveredByMonth0[m.month0] += coveredDays[i]; });
    const factorByMonth0 = new Float64Array(12);
    for (let m0 = 0; m0 < 12; m0++) factorByMonth0[m0] = coveredByMonth0[m0] > 1e-9 ? DIM[m0] / coveredByMonth0[m0] : 0;
    v = { coveredDays, factorByMonth0, coveredByMonth0 };
    coverageCache.set(local, v);
    return v;
}

/**
 * Annual total of a per-slot additive series, annualised per calendar month (never ×365/days,
 * which is season-blind for partial years).
 * @param {Object} ds
 * @param {(t: number) => number} valueAt
 * @param {(t: number) => boolean} [include]
 * @returns {number}
 */
export function annualSum(ds, valueAt, include = null) {
    const { factorByMonth0 } = monthCoverage(ds);
    const month = ds.local.month;
    const byM = new Float64Array(12);
    for (let t = 0; t < ds.n; t++) if (!include || include(t)) byM[month[t]] += valueAt(t);
    let s = 0;
    for (let m0 = 0; m0 < 12; m0++) s += byM[m0] * factorByMonth0[m0];
    return s;
}

const baseCache = new WeakMap();
const NO_MASK = {};

/**
 * Always-on load: for each local day with ≥ minSlots positive REAL readings, the mean of its
 * k lowest half-hours (whole day, not a night window — Agile users move appliances into cheap
 * night slots); the base load is the median over days. Zeros are ignored (outage/glitch).
 * @param {Object} ds Dataset
 * @param {{ k?: number, minSlots?: number, recentDays?: number }} [opts]
 * @returns {{ w: number, p10: number, p90: number, recentW: number, driftPct: number, days: number,
 *   dailyW: Float64Array, monthly: Array<{ key: string, w: number|null }>, p5SlotW: number, estimated: boolean }}
 *   driftPct = 100·(recentW − w)/w (UX: flag at |driftPct| ≥ 15); dailyW NaN = day dropped
 */
export function estimateBaseLoad(ds, { k = 4, minSlots = 44, recentDays = 60 } = {}) {
    const memoKey = `${k}|${minSlots}|${recentDays}`;
    // keyed by the load AND the filled mask: datasets share arrays freely ({ ...ds, loadFilled }),
    // and the same load with a different mask has a different base load
    let byFilled = baseCache.get(ds.load);
    if (!byFilled) { byFilled = new WeakMap(); baseCache.set(ds.load, byFilled); }
    const fKey = ds.loadFilled ?? NO_MASK;
    let memo = byFilled.get(fKey);
    if (memo && memo[memoKey]) return memo[memoKey];
    const { load, loadFilled, local } = ds;
    const days = local.days;
    const dailyW = new Float64Array(days.length).fill(NaN);
    const allReal = [];
    for (let di = 0; di < days.length; di++) {
        const { first, count } = days[di];
        const vals = [];
        for (let t = first; t < first + count; t++) {
            if (loadFilled && loadFilled[t] !== 0) continue;
            const v = load[t];
            if (v > 0 && Number.isFinite(v)) { vals.push(v); allReal.push(v); }
        }
        if (vals.length < minSlots) continue;
        vals.sort((a, b) => a - b);
        let s = 0;
        for (let i = 0; i < k; i++) s += vals[i];
        dailyW[di] = (s / k) * 2000; // kWh per half-hour → W
    }
    const v = sortedFinite(dailyW);
    const reals = Float64Array.from(allReal).sort();
    const p5SlotW = reals.length ? quantileSorted(reals, 0.05) * 2000 : 0;
    const estimated = v.length === 0;
    const w = estimated ? p5SlotW : quantileSorted(v, 0.5);
    const recent = [];
    for (let di = days.length - 1; di >= 0 && recent.length < recentDays; di--) if (Number.isFinite(dailyW[di])) recent.push(dailyW[di]);
    const rs = Float64Array.from(recent).sort();
    const recentW = rs.length ? quantileSorted(rs, 0.5) : w;
    const monthly = local.months.map((m) => {
        const vals = [];
        for (let di = 0; di < days.length; di++) {
            if (days[di].first >= m.first && days[di].first < m.first + m.count && Number.isFinite(dailyW[di])) vals.push(dailyW[di]);
        }
        const s = Float64Array.from(vals).sort();
        return { key: m.key, w: s.length ? quantileSorted(s, 0.5) : null };
    });
    const out = {
        w,
        p10: estimated ? w : quantileSorted(v, 0.1),
        p90: estimated ? w : quantileSorted(v, 0.9),
        recentW,
        driftPct: w > 0 ? (100 * (recentW - w)) / w : 0,
        days: v.length,
        dailyW,
        monthly,
        p5SlotW,
        estimated,
    };
    if (!memo) { memo = {}; byFilled.set(fKey, memo); }
    memo[memoKey] = out;
    return out;
}

/** Standing charge (p/day exc VAT) in force at an instant; 0 when unknown. */
function standingAt(standing, ms) {
    if (!Array.isArray(standing)) return 0;
    for (const s of standing) {
        const to = s.toMs ?? Infinity;
        if (ms >= (s.fromMs ?? -Infinity) && ms < to) return s.pPerDayExc ?? 0;
    }
    return 0;
}

/**
 * Full usage analysis for the Usage tab and the verdict tiles.
 * @param {Object} ds Dataset
 * @returns {Object} Insights (CONTRACTS §7). Money in £ unless suffixed P; base-load cost figures
 *   are annualised per calendar month; totals cover the dataset window as-is.
 */
export function analyseUsage(ds) {
    const { n, load, loadFilled, importPrice, local } = ds;
    const isReal = (t) => !loadFilled || loadFilled[t] === 0;
    const bl = estimateBaseLoad(ds);
    const baseKwhSlot = (bl.w / 1000) * 0.5;

    // base-load cost at the user's own (as billed) prices: Σ price·base·Δt, annualised
    const per100 = annualSum(ds, (t) => importPrice[t] * 0.05) / 100; // 100 W = 0.05 kWh per slot
    const per100Peak = annualSum(ds, (t) => importPrice[t] * 0.05, (t) => local.peak[t] === 1) / 100;
    const costBilledGbpYr = (per100 * bl.w) / 100;
    const costPeakGbpYr = (per100Peak * bl.w) / 100;
    let totalKwh = 0;
    let totalP = 0;
    let peakKwh = 0;
    let peakP = 0;
    for (let t = 0; t < n; t++) {
        totalKwh += load[t];
        totalP += load[t] * importPrice[t];
        if (local.peak[t]) { peakKwh += load[t]; peakP += load[t] * importPrice[t]; }
    }
    const baseShare = totalKwh > 0 ? Math.min(100, (100 * baseKwhSlot * n) / totalKwh) : 0;

    // peak kWh per complete local day
    let pkSum = 0;
    let pkDays = 0;
    for (const d of local.days) {
        if (d.count !== slotsInLocalDay(d.date)) continue;
        let s = 0;
        for (let t = d.first; t < d.first + d.count; t++) if (local.peak[t]) s += load[t];
        pkSum += s;
        pkDays++;
    }

    // 48-slot profiles: real load / all prices, each divided by its own per-hh count (DST-safe)
    const loadSum = new Float64Array(48);
    const loadCounts = new Uint16Array(48);
    const priceSum = new Float64Array(48);
    const priceCounts = new Uint16Array(48);
    for (let t = 0; t < n; t++) {
        const h = local.hh[t];
        priceSum[h] += importPrice[t];
        priceCounts[h]++;
        if (isReal(t)) { loadSum[h] += load[t]; loadCounts[h]++; }
    }
    const profLoad = new Float64Array(48);
    const profPrice = new Float64Array(48);
    for (let h = 0; h < 48; h++) {
        profLoad[h] = loadCounts[h] ? loadSum[h] / loadCounts[h] : 0;
        profPrice[h] = priceCounts[h] ? priceSum[h] / priceCounts[h] : 0;
    }

    // monthly bills (as billed: energy inc VAT per slot, standing exc × VAT by date)
    const cov = monthCoverage(ds);
    const monthlyBills = local.months.map((m) => {
        let kwh = 0;
        let p = 0;
        for (let t = m.first; t < m.first + m.count; t++) { kwh += load[t]; p += load[t] * importPrice[t]; }
        return { key: m.key, kwh, energyGbp: p / 100, standingGbp: 0, coveredDays: 0 };
    });
    let standingTotalP = 0;
    let mi = 0;
    for (const d of local.days) {
        while (mi < local.months.length - 1 && d.first >= local.months[mi].first + local.months[mi].count) mi++;
        const ms = localMidnightUtc(d.date);
        const frac = d.count / slotsInLocalDay(d.date);
        const sp = standingAt(ds.standing, ms) * (1 + vatAt(ms, DEFAULT_VAT_SCHEDULE)) * frac;
        monthlyBills[mi].standingGbp += sp / 100;
        standingTotalP += sp;
    }
    monthlyBills.forEach((b, i) => { b.coveredDays = cov.coveredDays[i]; });

    // heatmaps day × 48: duplicates (50-slot day) averaged, absent cells NaN; load from real slots,
    // `filled` marks cells whose readings were all gap-filled (UI hatches them)
    const D = local.days.length;
    const hmLoad = new Float32Array(D * 48).fill(NaN);
    const hmPrice = new Float32Array(D * 48).fill(NaN);
    const filled = new Uint8Array(D * 48);
    const lc = new Uint8Array(D * 48);
    const pc = new Uint8Array(D * 48);
    for (let t = 0; t < n; t++) {
        const i = local.day[t] * 48 + local.hh[t];
        hmPrice[i] = pc[i] ? hmPrice[i] + importPrice[t] : importPrice[t];
        pc[i]++;
        if (isReal(t)) {
            hmLoad[i] = lc[i] ? hmLoad[i] + load[t] : load[t];
            lc[i]++;
        } else if (!lc[i]) {
            filled[i] = 1;
        }
    }
    for (let i = 0; i < D * 48; i++) {
        if (pc[i] > 1) hmPrice[i] /= pc[i];
        if (lc[i] > 1) hmLoad[i] /= lc[i];
        if (lc[i]) filled[i] = 0;
    }

    // how well the user already shifts: load-weighted vs time-weighted price over real slots
    let lw = 0;
    let lwK = 0;
    let tw = 0;
    let twN = 0;
    for (let t = 0; t < n; t++) {
        if (!isReal(t)) continue;
        lw += load[t] * importPrice[t];
        lwK += load[t];
        tw += importPrice[t];
        twN++;
    }

    let negSlots = 0;
    let negKwh = 0;
    let negP = 0;
    for (let t = 0; t < n; t++) {
        if (importPrice[t] < 0) { negSlots++; negKwh += load[t]; negP += load[t] * importPrice[t]; }
    }

    let filledSlots = 0;
    let extrapolatedSlots = 0;
    if (loadFilled) for (let t = 0; t < n; t++) { if (loadFilled[t] === 1) filledSlots++; else if (loadFilled[t] === 2) extrapolatedSlots++; }

    return {
        baseLoad: {
            ...bl,
            kwhYr: (bl.w * 8760) / 1000,
            sharePct: baseShare,
            costBilledGbpYr,
            costPeakGbpYr,
            gbpPer100W: per100,
        },
        peak: {
            kwhSharePct: totalKwh > 0 ? (100 * peakKwh) / totalKwh : 0,
            costSharePct: totalP !== 0 ? (100 * peakP) / totalP : 0,
            kwhPerDay: pkDays ? pkSum / pkDays : 0,
        },
        profiles: { load: profLoad, priceBilled: profPrice, loadCounts },
        monthlyBills,
        heatmap: { days: D, dates: local.days.map((d) => d.date), load: hmLoad, price: hmPrice, filled },
        loadWeightedPriceP: lwK > 0 ? lw / lwK : 0,
        timeWeightedPriceP: twN > 0 ? tw / twN : 0,
        negative: { slots: negSlots, kwh: negKwh, gbp: negP / 100 },
        totals: { kwh: totalKwh, energyGbp: totalP / 100, standingGbp: standingTotalP / 100, days: n / 48 },
        coverage: {
            realPct: n > 0 ? (100 * (n - filledSlots - extrapolatedSlots)) / n : 0,
            filledSlots,
            extrapolatedSlots,
            days: n / 48,
        },
    };
}
