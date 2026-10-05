/*
 * a3-synth.js — deterministic synthetic datasets and PV for the A3 (economics) tests.
 *
 * Shapes are Agile-like on purpose: cheap nights, a 16:00–19:00 peak, summer midday dips that go
 * negative, seasonal sun with random cloudiness, an 800 W micro-inverter whose efficiency varies
 * with load (so etaPv differs per slot, which is what the "consistent PV physics" invariants need).
 */

import { buildLocalIndex, SLOT_MS } from '../../../../../projects/solar-calculator/js/time.js';

/** Seeded uniform RNG (LCG). */
export function lcg(seed = 1) {
    let s = seed >>> 0 || 1;
    return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

export const START_2025_10_01 = Date.parse('2025-09-30T23:00:00Z'); // 1 Oct 2025 00:00 BST
const LEVY_END = Date.parse('2026-03-31T22:00:00Z');

/**
 * Build a Dataset-shaped object.
 * @param {Object} o
 * @param {number} [o.start]
 * @param {number} [o.n] slot count (default 17 520 = 365 local days from START_2025_10_01)
 * @param {number} [o.baseW] always-on load (W)
 * @param {number} [o.seed]
 * @param {(t: number, local: Object) => { load?: number, price?: number }} [o.custom] override per slot
 * @param {boolean} [o.household] add evening/morning household use on top of the base
 */
export function synthDataset({ start = START_2025_10_01, n = 17520, baseW = 400, seed = 7, custom = null, household = true } = {}) {
    const local = buildLocalIndex(start, n);
    const rnd = lcg(seed);
    const load = new Float64Array(n);
    const importPrice = new Float64Array(n);
    const importPriceExc = new Float64Array(n);
    const importPriceFwdExc = new Float64Array(n);
    const agileOut = new Float64Array(n);
    const prime = new Float64Array(n);
    const fixed = new Float64Array(n).fill(12);
    for (let t = 0; t < n; t++) {
        const hh = local.hh[t];
        const m = local.month[t];
        const summer = Math.cos((2 * Math.PI * (m - 5.5)) / 12); // +1 Jun/Jul, −1 Dec/Jan
        let p = 17 + 3 * (1 - summer) / 2;
        if (hh >= 32 && hh < 38) p += 16;
        else if (hh >= 14 && hh < 18) p += 4;
        else if (hh < 10) p -= 4;
        if (hh >= 22 && hh < 30) p -= 7 * Math.max(0, summer) + 3 * rnd();
        p += 6 * (rnd() - 0.5);
        if (rnd() < 0.01 && hh >= 20 && hh < 32) p = -2 - 6 * rnd();
        let l = (baseW / 1000) * 0.5;
        if (household) {
            if (hh >= 34 && hh < 44) l += 0.12 + 0.1 * rnd();
            else if (hh >= 14 && hh < 18) l += 0.05 * rnd();
            if (rnd() < 0.04) l += 0.6 * rnd();
        }
        if (custom) {
            const v = custom(t, local);
            if (v.load !== undefined) l = v.load;
            if (v.price !== undefined) p = v.price;
        }
        load[t] = l;
        importPrice[t] = p;
        importPriceExc[t] = p / 1.05;
        importPriceFwdExc[t] = importPriceExc[t] - (start + t * SLOT_MS < LEVY_END ? 3.333 : 0);
        agileOut[t] = Math.max(0, 0.6 * importPriceExc[t] - 1);
        prime[t] = hh >= 32 && hh < 38 ? 16 : 9;
    }
    return {
        id: `synth-${seed}-${n}`, start, n, lat: 51.5, lon: -0.12, altitude: 16,
        load, loadFilled: new Uint8Array(n), importPriceExc, importPrice, importPriceFwdExc,
        exportPrices: { prime, fixed, agile: agileOut },
        exportPricesFwd: { prime, fixed, agile: agileOut },
        standing: [{ fromMs: -Infinity, toMs: Infinity, pPerDayExc: 37.6525 }],
        local,
        meta: { source: 'demo', region: 'C', coverage: { realPct: 100, filledSlots: 0, extrapolatedSlots: 0, days: n / 48 }, notes: [] },
    };
}

/**
 * Synthetic grid-tied PvSlots (pv.inverterAc shape) for `kWp` of panels on an inverter capped at
 * acLimitW. Efficiency follows a PVWatts-like part-load curve, clipping happens at the AC cap.
 * @returns {{ dcRawKwh: Float64Array, dcInvKwh: Float64Array, acKwh: Float64Array, clippedDcKwh: Float64Array,
 *   standbyKwh: Float64Array, etaPv: Float64Array }}
 */
export function synthPv(ds, { kWp = 0.92, acLimitW = 800, etaNom = 0.96, seed = 3, standbyW = 0, westness = 0 } = {}) {
    const { n, local } = ds;
    const rnd = lcg(seed);
    const dcRawKwh = new Float64Array(n);
    const dcInvKwh = new Float64Array(n);
    const acKwh = new Float64Array(n);
    const clippedDcKwh = new Float64Array(n);
    const standbyKwh = new Float64Array(n);
    const etaPv = new Float64Array(n);
    const acCap = (acLimitW * 0.5) / 1000;
    const pdc0 = acCap / etaNom;
    // PVWatts part-load curve as pv.js uses it: below ~0.6% of rating it goes negative and the AC
    // is clamped to 0 — so dawn/dusk slots have dcInvKwh > 0 with acKwh = 0 and etaPv = 0, which the
    // battery physics must treat as "no AC", never as etaNom
    const eta = (dc) => {
        const z = dc / pdc0;
        if (!(z > 0)) return 0;
        return Math.min(etaNom, Math.max(0, (etaNom / 0.9637) * (-0.0162 * z - 0.0059 / z + 0.9858)));
    };
    let cloud = 1;
    let lastDay = -1;
    for (let t = 0; t < n; t++) {
        if (local.day[t] !== lastDay) { cloud = 0.15 + 0.95 * rnd(); lastDay = local.day[t]; }
        const m = local.month[t];
        const summer = Math.cos((2 * Math.PI * (m - 5.5)) / 12);
        const dayLen = 12 + 4.3 * summer; // hours
        const noon = 12.5 + 0.5 * (summer > 0 ? 1 : 0) + 1.5 * westness;
        const h = local.hh[t] / 2 + 0.25;
        const x = (h - (noon - dayLen / 2)) / dayLen;
        const shape = x > 0 && x < 1 ? Math.sin(Math.PI * x) ** 1.3 : 0;
        const amp = 0.55 + 0.45 * summer;
        const dc = Math.min(1.25, cloud) * amp * shape * kWp * 0.5 * 1.1;
        dcRawKwh[t] = dc;
        // largest DC the inverter converts without exceeding the AC cap (bisection, as pv.js does)
        let lo = 0;
        let hi = Math.max(dc, pdc0 * 1.2);
        if (eta(hi) * hi <= acCap) lo = hi;
        else for (let i = 0; i < 60; i++) { const mid = 0.5 * (lo + hi); if (eta(mid) * mid <= acCap) lo = mid; else hi = mid; }
        // a thin dawn/dusk tail (≈ 0.1–0.5% of rating) that the inverter cannot convert
        const used = Math.min(dc, lo) + (shape === 0 && x > -0.07 && x < 1.07 ? pdc0 * 0.004 * cloud : 0);
        dcRawKwh[t] = Math.max(dc, used);
        dcInvKwh[t] = used;
        acKwh[t] = used > 0 ? eta(used) * used : 0;
        clippedDcKwh[t] = dcRawKwh[t] - used;
        etaPv[t] = used > 0 ? acKwh[t] / used : etaNom;
        standbyKwh[t] = used > 0 ? 0 : (standbyW * 0.5) / 1000;
    }
    return { dcRawKwh, dcInvKwh, acKwh, clippedDcKwh, standbyKwh, etaPv };
}

/** Own-panel DC for a power station (kWh per slot), capped at maxDcW. */
export function synthUpsPv(ds, { kWp = 0.46, maxDcW = 500, seed = 5 } = {}) {
    const pv = synthPv(ds, { kWp, acLimitW: 1e6, seed });
    const out = new Float64Array(ds.n);
    for (let t = 0; t < ds.n; t++) out[t] = Math.min(pv.dcRawKwh[t], (maxDcW * 0.5) / 1000);
    return out;
}

/** Deep-scan any result object for NaN/±Infinity in numbers and typed arrays. Returns offending paths. */
export function findNonFinite(obj, path = 'r', out = [], seen = new Set()) {
    if (obj === null || obj === undefined) return out;
    if (typeof obj === 'number') { if (!Number.isFinite(obj)) out.push(path); return out; }
    if (typeof obj !== 'object' || seen.has(obj)) return out;
    seen.add(obj);
    if (ArrayBuffer.isView(obj)) {
        for (let i = 0; i < obj.length; i++) if (!Number.isFinite(obj[i])) { out.push(`${path}[${i}]`); break; }
        return out;
    }
    for (const [k, v] of Object.entries(obj)) findNonFinite(v, `${path}.${k}`, out, seen);
    return out;
}
