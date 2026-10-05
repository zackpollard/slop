/*
 * battery.js — half-hourly battery / power-station dispatch on Agile prices.
 *
 * Ported from the research reference (agile-econ/dispatch.mjs, ups/scripts/sim_ups.py) with the
 * engine-critique amendments:
 *  - PV physics is the SAME as the no-battery run: per slot the grid-tied inverter's own
 *    efficiency etaPv = acKwh/dcInvKwh (PVWatts curve, sub-sample clipping already applied by
 *    pv.js), the free clip source is pv.js's clippedDcKwh, and the AC cap is
 *    etaPv·u + etaNom·d ≤ acLimit·Δt. So a battery held at delta ≡ 0 reproduces the no-battery
 *    flows exactly and Sav_batt is pure battery value, not a modelling artefact.
 *  - PV is only ever withheld (curtailed) when canCurtail is true.
 *  - Battery-to-grid export is off unless battery.allowGridExport (discharge ≤ load net of PV).
 *  - Power stations use the measured loss model (P_dc = P_ac/η_inv + P0 while inverting, bypass
 *    relay overhead while not, charger efficiency ~0.88) and never export.
 *  - SoC grid step δ, Int16Array policy, wear cost in the objective only.
 *
 * Energies are kWh per slot, prices p/kWh, Δt = 0.5 h. "Stored" energy s is the DC energy in the
 * cells; delta = Δs per slot. Every slot function answers: "the battery must change by delta —
 * what is the cheapest way to do it at these prices, and what flows result?" (null = impossible).
 * Because that answer never depends on the SoC, the DP can price each delta once per slot.
 */

import { DT_H, hhFromClock, replanStarts, horizonEnd } from './time.js';

/** Feasibility tolerance (kWh): floating noise must never turn a valid move into null. */
const TOL = 1e-9;

/** UI labels per strategy (UX critique). */
export const STRATEGY_LABELS = Object.freeze({
    self: 'Follow my usage',
    fixed: 'Fixed output',
    schedule: 'Simple timer: charge overnight, run 4–7pm',
    threshold: 'Agile-aware automation (realistic)',
    smart: 'Agile-aware with a perfect solar forecast',
    optimal: 'Perfect hindsight (best case)',
    online: 'Bypass disabled (servers always on the inverter)',
});

/** Power-station wording differs where the mechanism differs. */
export const UPS_STRATEGY_LABELS = Object.freeze({
    ...STRATEGY_LABELS,
    schedule: 'Smart plug cuts the mains 4–7pm',
    self: 'Charge from its own panels only',
});

const pos = (v) => (v > 0 ? v : 0);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const gridCost = (g, p, x) => (g >= 0 ? p * g : x * g);
/**
 * Inverter DC input that fits an AC allowance. etaPv is legitimately 0 at dawn and dusk: the
 * PVWatts curve turns a few watts of DC into no AC at all, so any DC input fits (Infinity).
 */
const dcForAc = (ac, etaPv) => (etaPv > 0 ? ac / etaPv : Infinity);

/**
 * Assumed fixed DC loss while a power station's inverter runs, when the catalog has no
 * measurement (power-stations-verified.meta: 20 W for 1–2 kWh units, 30 W for 3–4 kWh).
 * @param {Object} battery normalised battery with coupling 'ups'
 * @returns {number} W
 */
export function upsFixedLossW(battery) {
    const v = battery?.ups?.fixedLossW;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return (battery?.capacityKwh ?? 0) <= 2.5 ? 20 : 30;
}

/**
 * Build a result object. `delta` is the stored change; g the house-bus net import.
 * Kept in one place so every coupling reports the same fields.
 */
function result(g, p, x, fields) {
    const r = fields;
    r.cost = gridCost(g, p, x);
    r.imp = pos(g);
    r.exp = pos(-g);
    return r;
}

/**
 * DC-coupled slot (battery on the PV DC bus behind the shared grid-tied inverter).
 * Decision variables: grid DC into the cells gc (via the AC charger), PV into the cells from the
 * clip source fc and from inverter-capable PV fi, inverter PV input u, battery DC out d.
 * For a fixed delta the house-bus import g is linear in the decisions and the slot cost depends
 * on g only (p above zero, x below), so the cheapest decision is one of: the minimum-g decision,
 * the maximum-g decision, or the blend that lands exactly on g = 0.
 * @param {number} delta stored-energy change (kWh)
 * @param {{ L: number, p: number, x: number, dcInv: number, clip: number, etaPv: number }} s
 *   L = house load incl. standby; dcInv/clip from pv.js; p/x decision prices
 * @param {Object} c prepared battery config (see prepareConfig)
 * @returns {Object|null}
 */
export function slotDC(delta, s, c) {
    const { L, p, x, dcInv, clip, etaPv } = s;
    const cap = c.acCap;
    if (delta >= 0) {
        const b = delta / c.effC;
        if (b > c.maxChgDc + TOL) return null;
        const gridCap = c.allowGridCharge ? c.gridCapDc : 0;
        const lo = pos(b - clip - dcInv);
        const hi = Math.min(b, gridCap);
        if (lo > hi + TOL) return null;
        const aE = c.acChargeEff;
        // min-g decision: PV first (clip is free, then inverter PV), grid only for the remainder
        const fcA = Math.min(clip, b - lo);
        const fiA = Math.min(dcInv, pos(b - lo - fcA));
        const uA = Math.min(dcInv - fiA, dcForAc(cap, etaPv));
        const gA = L + lo / aE - etaPv * uA;
        // max-g decision: grid first, then inverter PV (reduces AC), clip last; curtail if allowed
        const remB = pos(b - hi);
        const fiB = Math.min(dcInv, remB);
        const fcB = Math.min(clip, pos(remB - fiB));
        const uMaxB = Math.min(dcInv - fiB, dcForAc(cap, etaPv));
        const uB = c.canCurtail ? 0 : uMaxB;
        const gB = L + hi / aE - etaPv * uB;
        let lam = 1; // weight on decision A
        let best = gridCost(gA, p, x);
        const cB = gridCost(gB, p, x);
        if (cB < best - 1e-12) { best = cB; lam = 0; }
        if (gA < 0 && gB > 0) {
            const l0 = gB / (gB - gA);
            if (0 < best - 1e-12) { best = 0; lam = l0; }
        }
        const k = 1 - lam;
        const gc = lam * lo + k * hi;
        const fc = lam * fcA + k * fcB;
        const fi = lam * fiA + k * fiB;
        const uMax = lam * uA + k * uMaxB;
        const u = lam * uA + k * uB;
        const g = L + gc / aE - etaPv * u;
        return result(g, p, x, {
            delta, gridChg: gc / aE, battChgAc: gc / aE + etaPv * fi, battOutAc: 0, pvDirectAc: etaPv * u,
            clipped: pos(clip - fc) + pos(dcInv - fi - uMax), curtailed: pos(uMax - u), wasted: 0,
            f: 0, conv: 0, bypass: 0, wearKwh: 0,
        });
    }
    const d = -delta * c.effD;
    if (d > c.maxDisDc + TOL) return null;
    const head = cap - c.etaNom * d;
    if (head < -TOL) return null;
    const uMax = Math.max(0, Math.min(dcInv, dcForAc(pos(head), etaPv)));
    let uHi = uMax;
    if (!c.allowGridExport && c.etaNom * d > pos(L - etaPv * uMax) + TOL) {
        // the battery may only serve the house; with a power-limit-capable inverter PV can be
        // turned down to make room, otherwise this discharge would export
        if (!c.canCurtail || c.etaNom * d > L + TOL) return null;
        uHi = Math.min(uMax, dcForAc(pos(L - c.etaNom * d), etaPv));
    }
    const uLo = c.canCurtail ? 0 : uHi;
    const gA = L - etaPv * uHi - c.etaNom * d;
    const gB = L - etaPv * uLo - c.etaNom * d;
    let u = uHi;
    let best = gridCost(gA, p, x);
    const cB = gridCost(gB, p, x);
    if (cB < best - 1e-12) { best = cB; u = uLo; }
    if (gA < 0 && gB > 0 && 0 < best - 1e-12) u = uHi + (uLo - uHi) * (gA / (gA - gB));
    const g = L - etaPv * u - c.etaNom * d;
    return result(g, p, x, {
        delta, gridChg: 0, battChgAc: 0, battOutAc: c.etaNom * d, pvDirectAc: etaPv * u,
        clipped: clip + pos(dcInv - uMax), curtailed: pos(uMax - u), wasted: 0,
        f: 0, conv: 0, bypass: 0, wearKwh: d,
    });
}

/**
 * AC-coupled slot: the grid-tied PV inverter output pvAc is unchanged (unless curtailed) and
 * the battery has its own bidirectional inverter on the house bus. maxChargeW/maxDischargeW are
 * AC-terminal limits; grid charging only when acChargeW > 0 (then ≤ acChargeW for the grid part).
 * @param {number} delta
 * @param {{ L: number, p: number, x: number, pvAc: number, etaPv: number, clip: number }} s
 * @param {Object} c
 * @returns {Object|null}
 */
export function slotAC(delta, s, c) {
    const { L, p, x, pvAc, etaPv } = s;
    if (delta >= 0) {
        const acIn = delta / c.acEffC;
        if (acIn > c.maxChgAc + TOL) return null;
        const gridCap = c.allowGridCharge ? c.gridCapAc : 0;
        if (acIn - pos(pvAc - L) > gridCap + TOL) return null;
        // lowest PV use that still keeps the grid part of the charge within gridCap
        const pvLo = c.canCurtail ? Math.min(pvAc, acIn > gridCap ? L + acIn - gridCap : 0) : pvAc;
        const gA = L + acIn - pvAc;
        const gB = L + acIn - pvLo;
        let pvU = pvAc;
        let best = gridCost(gA, p, x);
        const cB = gridCost(gB, p, x);
        if (cB < best - 1e-12) { best = cB; pvU = pvLo; }
        if (gA < 0 && gB > 0 && 0 < best - 1e-12) pvU = L + acIn;
        const g = L + acIn - pvU;
        return result(g, p, x, {
            delta, gridChg: pos(acIn - pos(pvU - L)), battChgAc: acIn, battOutAc: 0, pvDirectAc: pvU,
            clipped: s.clip, curtailed: etaPv > 0 ? pos(pvAc - pvU) / etaPv : 0, wasted: 0,
            f: 0, conv: 0, bypass: 0, wearKwh: 0,
        });
    }
    const acOut = -delta * c.acEffD;
    if (acOut > c.maxDisAc + TOL) return null;
    let pvHi = pvAc;
    if (!c.allowGridExport && acOut > pos(L - pvAc) + TOL) {
        if (!c.canCurtail || acOut > L + TOL) return null;
        pvHi = pos(L - acOut);
    }
    const pvLo = c.canCurtail ? 0 : pvHi;
    const gA = L - pvHi - acOut;
    const gB = L - pvLo - acOut;
    let pvU = pvHi;
    let best = gridCost(gA, p, x);
    const cB = gridCost(gB, p, x);
    if (cB < best - 1e-12) { best = cB; pvU = pvLo; }
    if (gA < 0 && gB > 0 && 0 < best - 1e-12) pvU = L - acOut;
    const g = L - pvU - acOut;
    return result(g, p, x, {
        delta, gridChg: 0, battChgAc: 0, battOutAc: acOut, pvDirectAc: pvU,
        clipped: s.clip, curtailed: etaPv > 0 ? pos(pvAc - pvU) / etaPv : 0, wasted: 0,
        f: 0, conv: 0, bypass: 0, wearKwh: -delta,
    });
}

/**
 * Flows of a power station for explicit decisions: inverter time-share f (0 = bypass relay,
 * 1 = whole slot on the battery inverter), grid charge cc (AC kWh), own PV wasted w.
 * House bus: g = (L − D) + (1−f)·(D + bypass) + cc − Agt.
 */
function upsFlows(f, cc, w, delta, s, c, need) {
    const byp = (1 - f) * c.byp;
    const g = s.L - f * s.D + byp + cc - s.Agt;
    return result(g, s.p, s.x, {
        delta, gridChg: cc, battChgAc: cc,
        battOutAc: delta < 0 && need > 0 ? (s.D * -delta) / need : 0,
        pvDirectAc: s.Agt, clipped: s.clip, curtailed: 0, wasted: w,
        f, conv: f * (s.D / c.etaInv - s.D + c.p0), bypass: byp, wearKwh: pos(-delta),
    });
}

/** Grid charge (AC kWh) a station can draw this slot while in bypass: charger rating and the plug. */
function upsChargeCap(s, c) {
    return Math.min(c.chargeCap, pos(c.inputCap - s.D - c.byp));
}

/**
 * Power station feeding a dedicated load D (the servers) from its own outlets; never grid-tied.
 * Candidates per the engine critique (an offline UPS cannot charge while its input is cut, so
 * no candidate has f > 0 and cc > 0):
 *  A (inverter share, no grid charge): f = clamp((Pu−delta)/need, 0, 1), w = Pu − delta − f·need
 *  B (bypass ± charge): f = 0, cc = max(0, delta − Pu)/chargeEff, w = max(0, Pu − delta)
 * need = D/etaInv + P0·Δt. With bypass disabled ('online') the inverter always runs (f = 1) and
 * the charger may run at the same time.
 * @param {number} delta
 * @param {{ L: number, p: number, x: number, Pu: number, D: number, Agt: number, clip: number }} s
 *   L = house load (incl. inverter standby, excl. bypass overhead); Pu own PV DC; Agt grid-tied PV AC
 * @param {Object} c
 * @returns {Object|null}
 */
export function slotUPS(delta, s, c) {
    const { Pu, D } = s;
    const need = D / c.etaInv + c.p0;
    if (c.online) {
        if (D > c.outletCap + TOL) return null;
        const cc = pos(delta - Pu + need) / c.chargeEff;
        const w = pos(Pu - need - delta);
        if (w > Pu + TOL || cc > c.chargeCap + TOL) return null;
        if (cc > TOL && !c.allowGridCharge) return null;
        return upsFlows(1, cc, w, delta, s, c, need);
    }
    let best = null;
    if (need > 0) {
        const f = clamp01((Pu - delta) / need);
        const w = Pu - delta - f * need;
        if (w >= -TOL && w <= Pu + TOL && (f <= 0 || D <= c.outletCap + TOL)) best = upsFlows(f, 0, pos(w), delta, s, c, need);
    }
    const cc = pos(delta - Pu) / c.chargeEff;
    const w = pos(Pu - delta);
    if (w <= Pu + TOL && cc <= upsChargeCap(s, c) + TOL && (cc <= TOL || c.allowGridCharge)) {
        const r = upsFlows(0, cc, w, delta, s, c, need);
        if (!best || r.cost < best.cost - 1e-12) best = r;
    }
    return best;
}

/**
 * Backward-induction DP over a discretised SoC grid (N levels, step dE), perfect foresight over
 * [t0, t1). V_T(i) = −termValuePerKwh·i·dE values energy left in the battery. The policy is an
 * Int16Array (the reference's Int8Array wraps silently once kUp or kDn exceeds 127).
 * kUp/kDn = floor(max power/dE) truncate the power limits by up to one step.
 * `ks` is the plan along the optimal path from startIdx; `policy` (row t − t0, column SoC index)
 * is the move for every state, which a replay needs as soon as reality leaves that path (a slot
 * with no feasible move forces a different SoC, and the rest of `ks` would then push the SoC
 * outside [sMin, sMax]).
 * @param {{ cost: (t: number, delta: number) => number, t0?: number, t1: number, N: number, dE: number,
 *   kUp: number, kDn: number, startIdx?: number, termValuePerKwh?: number }} a
 *   cost(t, delta) = objective of moving the SoC by delta in slot t (Infinity if impossible)
 * @returns {{ ks: Int16Array, endIdx: number, objective: number, policy: Int16Array }}
 */
export function dpPlan({ cost, t0 = 0, t1, N, dE, kUp, kDn, startIdx = 0, termValuePerKwh = 0 }) {
    const T = Math.max(0, t1 - t0);
    kUp = Math.max(0, Math.min(N - 1, kUp));
    kDn = Math.max(0, Math.min(N - 1, kDn));
    const K = kUp + kDn + 1;
    let V = new Float64Array(N);
    let Vn = new Float64Array(N);
    for (let i = 0; i < N; i++) V[i] = -termValuePerKwh * i * dE;
    const pol = new Int16Array(T * N);
    const F = new Float64Array(K);
    for (let t = t1 - 1; t >= t0; t--) {
        // only the feasible band of moves is scanned: at night every charge move of a battery
        // without grid charging is Infinity, which halves the O(N·K) inner loop there
        let fLo = K;
        let fHi = -1;
        for (let j = 0; j < K; j++) {
            const v = cost(t, (j - kDn) * dE);
            F[j] = v;
            if (v < Infinity) { if (j < fLo) fLo = j; fHi = j; }
        }
        const base = (t - t0) * N;
        for (let i = 0; i < N; i++) {
            let best = Infinity;
            let bk = 0;
            const jLo = Math.max(fLo, kDn - i > 0 ? kDn - i : 0);
            const jHi = Math.min(fHi, K - 1, kDn + (N - 1 - i));
            for (let j = jLo; j <= jHi; j++) {
                const v = F[j] + V[i + j - kDn];
                if (v < best) { best = v; bk = j - kDn; }
            }
            Vn[i] = best;
            pol[base + i] = bk;
        }
        const tmp = V; V = Vn; Vn = tmp;
    }
    const ks = new Int16Array(T);
    let i = Math.max(0, Math.min(N - 1, startIdx));
    const objective = T > 0 ? V[i] : 0;
    for (let t = 0; t < T; t++) {
        const k = pol[t * N + i];
        ks[t] = k;
        i += k;
    }
    return { ks, endIdx: i, objective, policy: pol };
}

/* ── model preparation ── */

/**
 * Resolve the battery and the dispatch inputs into the numbers the slot functions use.
 * @returns {Object} config c
 */
function prepareConfig(inp, b, opts, strategy) {
    const dt = DT_H;
    const kwh = (w) => (w * dt) / 1000;
    const c = {
        coupling: b.coupling,
        allowGridExport: !!b.allowGridExport,
        canCurtail: !!inp.canCurtail,
        wear: b.wearPPerKwh,
        etaNom: inp.etaNom ?? 0.96,
        acCap: kwh(inp.acLimitW ?? Infinity),
        allowGridCharge: true,
        online: false,
    };
    if (b.coupling === 'dc') {
        c.effC = b.effCharge;
        c.effD = b.effDischarge;
        c.acChargeEff = b.acChargeEff;
        c.maxChgDc = kwh(b.maxChargeW);
        c.maxDisDc = kwh(b.maxDischargeW);
        c.gridCapDc = kwh(b.acChargeW) * b.acChargeEff;
        c.allowGridCharge = b.acChargeW > 0;
        if (!Number.isFinite(c.acCap)) c.acCap = 1e9;
    } else if (b.coupling === 'ac') {
        c.acEffC = b.acEffCharge;
        c.acEffD = b.acEffDischarge;
        c.maxChgAc = kwh(b.maxChargeW);
        c.maxDisAc = kwh(b.maxDischargeW);
        c.gridCapAc = kwh(Math.min(b.acChargeW, b.maxChargeW));
        c.allowGridCharge = b.acChargeW > 0;
    } else {
        const u = b.ups;
        c.etaInv = u.etaInv;
        c.chargeEff = u.chargeEff;
        c.chargeCap = kwh(u.chargeW);
        c.p0 = kwh(upsFixedLossW(b));
        c.byp = kwh(u.bypassW);
        c.outletCap = kwh(u.outletMaxW);
        c.inputCap = kwh(u.inputLimitW);
        c.online = u.bypass === 'disabled' || strategy === 'online';
        // with bypass disabled the charger is the servers' only grid path, so it can never be off
        c.allowGridCharge = u.chargeW > 0 && (strategy !== 'self' || c.online);
        c.allowGridExport = false;
    }
    return c;
}

/**
 * Per-slot input objects (built once; the DP prices K deltas per slot against them).
 * L includes the battery's standby (dc/ac) and the PV inverter's night standby; for a power
 * station the bypass overhead is decision-dependent and added inside slotUPS instead.
 */
function prepareSlots(inp, b, c) {
    const n = inp.n;
    const S = new Array(n);
    const standbyB = b.coupling === 'ups' ? 0 : (b.standbyW * DT_H) / 1000;
    const etaNom = c.etaNom;
    for (let t = 0; t < n; t++) {
        const dcInv = inp.dcInvKwh ? inp.dcInvKwh[t] : 0;
        const pvAc = inp.pvAc ? inp.pvAc[t] : 0;
        // etaPv = 0 with dcInv > 0 is real (dawn/dusk DC below the inverter's turn-on point gives
        // no AC). Replacing it with etaNom invented AC the no-battery run never had: an idle battery
        // stopped matching the no-battery run, and rule strategies (which size discharges from the
        // real pvAc) were refused and backed off at dawn. Only a slot without DC gets etaNom.
        let etaPv = etaNom;
        if (dcInv > 0) {
            const e = inp.etaPv ? inp.etaPv[t] : NaN;
            etaPv = e >= 0 && Number.isFinite(e) ? e : pvAc / dcInv;
            if (!(etaPv >= 0)) etaPv = etaNom;
        }
        const pvSb = inp.standbyKwh ? inp.standbyKwh[t] : 0;
        S[t] = {
            L: inp.load[t] + standbyB + pvSb,
            p: inp.pD[t],
            x: inp.xD ? inp.xD[t] : 0,
            dcInv,
            clip: inp.clippedDcKwh ? inp.clippedDcKwh[t] : 0,
            etaPv,
            pvAc,
            Pu: inp.upsPvDc ? inp.upsPvDc[t] : 0,
            D: inp.dedicated ? Math.min(inp.dedicated[t], inp.load[t]) : 0,
            Agt: pvAc,
            standby: standbyB + pvSb,
        };
    }
    return S;
}

/** Window test on local half-hours; a window may wrap past midnight ('23:00'–'07:00'). */
function inWindow(hh, a, b) {
    return a <= b ? hh >= a && hh < b : hh >= a || hh < b;
}

function median(arr) {
    if (!arr.length) return 0;
    const a = Float64Array.from(arr).sort();
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

/** Agile day index per slot: the Agile day runs 23:00 → 23:00 local, so hh ≥ 46 joins the next day. */
function agileDays(local, n) {
    const ad = new Int32Array(n);
    for (let t = 0; t < n; t++) ad[t] = local.day[t] + (local.hh[t] >= 46 ? 1 : 0);
    return ad;
}

/** Group slot indices by an integer key array (keys ascending in time). */
function groupBy(keys, n) {
    const groups = [];
    let cur = null;
    let last = NaN;
    for (let t = 0; t < n; t++) {
        if (keys[t] !== last) { cur = []; groups.push(cur); last = keys[t]; }
        cur.push(t);
    }
    return groups;
}

/* ── flows accumulation ── */

/**
 * @typedef {Object} Flows
 * Per-slot Float64Array(n): imp, exp (grid kWh), gridChg (AC kWh drawn from the grid to charge),
 * battIn/battOut (stored side, max(0, ±Δs)), battOutAc (AC delivered from the battery), soc (kWh
 * at slot end), pvDirectAc (grid-tied PV AC reaching the house bus), curtailed (DC withheld,
 * 0 unless canCurtail), clipped (DC lost to inverter limits), upsPvWasted (station PV with nowhere
 * to go), standby (battery standby + PV inverter night draw + bypass overhead), upsConversionLoss,
 * bypassOverhead, battChgAc (AC-equivalent energy into the battery, for profiles), upsF (inverter
 * time share). Scalars: wearP (wear cost of the dispatch, objective only), cycles, costP (cost at
 * decision prices), objectiveP (costP + wearP), sMin, sMax, socStart (SoC before slot 0; a DP
 * starts on its grid), N, dE, strategy, warnings, upsOverloadSlots.
 */

function newFlows(n) {
    const f = () => new Float64Array(n);
    return {
        imp: f(), exp: f(), gridChg: f(), battIn: f(), battOut: f(), battOutAc: f(), soc: f(), pvDirectAc: f(),
        curtailed: f(), clipped: f(), upsPvWasted: f(), standby: f(), upsConversionLoss: f(), bypassOverhead: f(),
        battChgAc: f(), upsF: f(),
        wearP: 0, cycles: 0, costP: 0, objectiveP: 0, sMin: 0, sMax: 0, socStart: 0, N: 0, dE: 0, strategy: 'none',
        warnings: [], upsOverloadSlots: 0,
    };
}

function record(fl, t, r, socAfter, s, wear) {
    fl.imp[t] = r.imp;
    fl.exp[t] = r.exp;
    fl.gridChg[t] = r.gridChg;
    fl.battIn[t] = pos(r.delta);
    fl.battOut[t] = pos(-r.delta);
    fl.battOutAc[t] = r.battOutAc;
    fl.battChgAc[t] = r.battChgAc;
    fl.soc[t] = socAfter;
    fl.pvDirectAc[t] = r.pvDirectAc;
    fl.curtailed[t] = r.curtailed;
    fl.clipped[t] = r.clipped;
    fl.upsPvWasted[t] = r.wasted;
    fl.standby[t] = s.standby + r.bypass;
    fl.bypassOverhead[t] = r.bypass;
    fl.upsConversionLoss[t] = r.conv;
    fl.upsF[t] = r.f;
    fl.costP += r.cost;
    fl.wearP += wear * r.wearKwh;
}

/**
 * Flows without any battery: PV straight to the house bus (curtailed only when allowed and
 * cheaper, i.e. at negative import prices), inverter night standby added to the load.
 * @param {Object} inp DispatchInputs
 * @returns {Flows}
 */
export function noBatteryFlows(inp) {
    const n = inp.n;
    const fl = newFlows(n);
    for (let t = 0; t < n; t++) {
        const sb = inp.standbyKwh ? inp.standbyKwh[t] : 0;
        const L = inp.load[t] + sb;
        const pvAc = inp.pvAc ? inp.pvAc[t] : 0;
        const p = inp.pD[t];
        const x = inp.xD ? inp.xD[t] : 0;
        let pvU = pvAc;
        if (inp.canCurtail && pvAc > 0) {
            let best = gridCost(L - pvAc, p, x);
            for (const v of [Math.min(pvAc, L), 0]) {
                const cst = gridCost(L - v, p, x);
                if (cst < best - 1e-12) { best = cst; pvU = v; }
            }
        }
        const g = L - pvU;
        const dcInv = inp.dcInvKwh ? inp.dcInvKwh[t] : 0;
        const etaPv = inp.etaPv && inp.etaPv[t] > 0 ? inp.etaPv[t] : dcInv > 0 ? pvAc / dcInv : inp.etaNom ?? 0.96;
        fl.imp[t] = pos(g);
        fl.exp[t] = pos(-g);
        fl.pvDirectAc[t] = pvU;
        fl.curtailed[t] = etaPv > 0 ? pos(pvAc - pvU) / etaPv : 0;
        fl.clipped[t] = inp.clippedDcKwh ? inp.clippedDcKwh[t] : 0;
        fl.standby[t] = sb;
        fl.costP += gridCost(g, p, x);
    }
    fl.objectiveP = fl.costP;
    return fl;
}

/* ── strategies ── */

/**
 * Stored-energy change that makes the battery follow an AC target: PV surplus over the target
 * charges, a shortfall is discharged (reference followTarget, with per-slot etaPv).
 */
function followTarget(target, s, c) {
    if (c.coupling === 'ac') {
        const net = s.pvAc - target;
        return net >= 0 ? net * c.acEffC : net / c.acEffD;
    }
    // surplus in DC terms: the inverter needs target/etaPv of its DC for the target, the rest of
    // its DC and all clipped DC can charge (written so etaPv = 0 at dawn never divides 0 by 0)
    if (s.pvAc >= target) return (s.dcInv - (target > 0 ? target / s.etaPv : 0) + s.clip) * c.effC;
    return -(target - s.pvAc) / c.etaNom / c.effD;
}

/**
 * Largest AC output a follow-the-load target can ask for: a dc-coupled battery shares the PV
 * inverter's AC cap, an ac-coupled one has its own inverter (its power limit is applied in clampDelta).
 */
function outCap(c) {
    return c.coupling === 'dc' ? c.acCap : Infinity;
}

/** Clamp a desired delta to power, SoC and no-export limits so slot functions accept it. */
function clampDelta(want, soc, s, c, sMin, sMax) {
    let up;
    let dn;
    if (c.coupling === 'ac') {
        up = Math.min(c.maxChgAc, pos(s.pvAc - s.L) + (c.allowGridCharge ? c.gridCapAc : 0)) * c.acEffC;
        dn = Math.min(c.maxDisAc, c.allowGridExport ? Infinity : pos(s.L - s.pvAc)) / c.acEffD;
    } else {
        up = Math.min(c.maxChgDc, s.clip + s.dcInv + (c.allowGridCharge ? c.gridCapDc : 0)) * c.effC;
        dn = Math.min(c.maxDisDc, c.acCap / c.etaNom, c.allowGridExport ? Infinity : pos(s.L - s.pvAc) / c.etaNom) / c.effD;
    }
    up = Math.min(up, pos(sMax - soc));
    dn = Math.min(dn, pos(soc - sMin));
    return want > up ? up : want < -dn ? -dn : want;
}

/** Evaluate a rule's delta, backing off toward 0 if the physics refuses it (never null). */
function ruleSlot(slot, delta, s, c) {
    let r = slot(delta, s, c);
    let tries = 0;
    while (!r && tries++ < 40) { delta *= 0.8; r = slot(delta, s, c); }
    return r || slot(0, s, c);
}

/** Threshold ("Agile-aware automation") roles for dc/ac: price-aware rule + PV headroom. */
function thresholdPlan(m) {
    const { n, S, c, b, sMin, sMax, ad } = m;
    const usable = sMax - sMin;
    const role = new Int8Array(n);
    const target = new Float64Array(n).fill(sMin);
    const lastDis = new Int32Array(n).fill(-1);
    const groups = groupBy(ad, n);
    const ac = c.coupling === 'ac';
    const etaOut = ac ? c.acEffD : c.effD * c.etaNom;
    const disAc = ac ? c.maxDisAc : Math.min(c.maxDisDc * c.etaNom, c.acCap);
    const chgAc = ac ? (c.allowGridCharge ? c.gridCapAc : 0) : (c.allowGridCharge ? c.gridCapDc / c.acChargeEff : 0);
    const etaIn = ac ? c.acEffC : c.effC * c.acChargeEff;
    const etaInPv = ac ? c.acEffC : c.effC / c.etaNom;
    const rte = ac ? c.acEffC * c.acEffD : c.acChargeEff * c.effC * c.effD * c.etaNom;
    const surplus = groups.map((ts) => {
        let v = 0;
        for (const t of ts) v += pos(S[t].pvAc - S[t].L) + (ac ? 0 : S[t].clip * S[t].etaPv);
        return v;
    });
    let prevLast = -1;
    for (let di = 0; di < groups.length; di++) {
        const ts = groups[di];
        let meanL = 0;
        for (const t of ts) meanL += S[t].L;
        meanL /= ts.length;
        // without battery export a discharge slot can only cover the house load
        const perSlot = c.allowGridExport ? disAc : Math.min(disAc, meanL);
        const mm = Math.max(1, Math.min(ts.length, perSlot > 0 ? Math.ceil((usable * etaOut) / perSlot - 1e-9) : ts.length));
        const hi = [...ts].sort((a, z) => S[a].p - S[z].p || a - z).slice(-mm);
        let tFirst = Infinity;
        let tLast = -1;
        let pHi = 0;
        for (const t of hi) { role[t] = 1; tFirst = Math.min(tFirst, t); tLast = Math.max(tLast, t); pHi += S[t].p; }
        pHi /= hi.length;
        const fc = b.pvForecast === 'perfect' || di === 0 ? surplus[di] : surplus[di - 1];
        const tgt = Math.max(sMin, sMax - 0.8 * fc * etaInPv);
        if (chgAc > 0) {
            const nn = Math.ceil(usable / (etaIn * chgAc) - 1e-9);
            const cand = [];
            for (let t = prevLast + 1; t < tFirst; t++) if (role[t] === 0) cand.push(t);
            cand.sort((a, z) => S[a].p - S[z].p || a - z);
            for (const t of cand.slice(0, nn)) {
                if (S[t].p / rte + b.wearPPerKwh < pHi) { role[t] = -1; target[t] = tgt; }
            }
        }
        for (const t of ts) lastDis[t] = tLast;
        prevLast = tLast;
    }
    const follow = (t) => followTarget(Math.min(S[t].L, outCap(c)), S[t], c);
    return (t, soc) => {
        const f = follow(t);
        if (role[t] === 1) return f;
        if (role[t] === -1) return Math.max(pos(f), target[t] - soc);
        return t > lastDis[t] ? f : pos(f);
    };
}

/** Rule controllers for dc/ac: return the desired delta for slot t at SoC soc. */
function ruleController(m, strategy) {
    const { S, c, b, local } = m;
    const capAc = outCap(c);
    const follow = (t) => followTarget(Math.min(S[t].L, capAc), S[t], c);
    if (strategy === 'idle') return () => 0;
    if (strategy === 'self') return (t) => follow(t);
    if (strategy === 'fixed') {
        const w = b.fixedOutputW ?? m.opts.baseLoadW ?? 300;
        const tgt = (w * DT_H) / 1000;
        return (t) => followTarget(Math.min(tgt, capAc), S[t], c);
    }
    if (strategy === 'schedule') {
        const [c0, c1] = b.schedule.chargeWindow.map(hhFromClock);
        const [d0, d1] = b.schedule.dischargeWindow.map(hhFromClock);
        const below = b.schedule.chargeBelowP;
        return (t) => {
            const hh = local.hh[t];
            const f = follow(t);
            if (inWindow(hh, d0, d1)) return f;
            if (c.allowGridCharge && inWindow(hh, c0, c1) && (below === null || S[t].p <= below)) return 1e9;
            // after the evening run, free-run until midnight or the charge window
            const afterRun = d0 <= d1 && hh >= d1 && (c0 > d1 ? hh < c0 : true);
            return afterRun ? f : pos(f);
        };
    }
    return thresholdPlan(m);
}

/** Apply explicit power-station decisions with SoC limits; returns slot flows. */
function upsRuleSlot(f, cc, soc, s, c, sMin, sMax) {
    const need = s.D / c.etaInv + c.p0;
    if (f > 0 && s.D > c.outletCap + TOL) f = 0;
    if (f > 0 && cc > 0) cc = 0;
    let raw = s.Pu + c.chargeEff * cc - f * need;
    if (soc + raw < sMin - TOL && f > 0) {
        f = need > 0 ? clamp01((soc - sMin + s.Pu + c.chargeEff * cc) / need) : 0;
        raw = s.Pu + c.chargeEff * cc - f * need;
    }
    let w = pos(soc + raw - sMax);
    if (w > s.Pu) {
        cc = pos(cc - (w - s.Pu) / c.chargeEff);
        raw = s.Pu + c.chargeEff * cc - f * need;
        w = Math.min(s.Pu, pos(soc + raw - sMax));
    }
    return upsFlows(f, cc, w, raw - w, s, c, need);
}

/** Power-station rule controllers: return { f, cc } for slot t at SoC soc. */
function upsController(m, strategy) {
    const { n, S, c, b, sMin, sMax, local, ad } = m;
    const capB = (s) => upsChargeCap(s, c);
    const needOf = (s) => s.D / c.etaInv + c.p0;
    if (strategy === 'idle') return () => ({ f: 0, cc: 0, idle: true });
    if (strategy === 'self') {
        return (t, soc) => {
            const s = S[t];
            const need = needOf(s);
            return { f: soc - sMin + s.Pu >= need - TOL ? 1 : 0, cc: 0 };
        };
    }
    if (strategy === 'schedule') {
        const [c0, c1] = b.schedule.chargeWindow.map(hhFromClock);
        const [d0, d1] = b.schedule.dischargeWindow.map(hhFromClock);
        const below = b.schedule.chargeBelowP;
        return (t, soc) => {
            const s = S[t];
            const hh = local.hh[t];
            const need = needOf(s);
            if (inWindow(hh, d0, d1)) return { f: need > 0 ? clamp01((soc - sMin + s.Pu) / need) : 0, cc: 0 };
            let cc = 0;
            if (c.allowGridCharge && inWindow(hh, c0, c1) && (below === null || s.p <= below)) {
                cc = Math.min(capB(s), pos(sMax - soc - s.Pu) / c.chargeEff);
            }
            return { f: 0, cc };
        };
    }
    // threshold: sim_ups run_heur per Agile day, with persistence PV headroom by default
    const usable = sMax - sMin;
    const groups = groupBy(ad, n);
    const hiP = new Float64Array(n);
    const loP = new Float64Array(n);
    const allow = new Uint8Array(n);
    const tgt = new Float64Array(n);
    const pvDay = groups.map((ts) => ts.reduce((a, t) => a + S[t].Pu, 0));
    for (let di = 0; di < groups.length; di++) {
        const ts = groups[di];
        let needMean = 0;
        let dMean = 0;
        for (const t of ts) { needMean += needOf(S[t]); dMean += S[t].D; }
        needMean /= ts.length;
        dMean /= ts.length;
        const mm = needMean > 0 ? Math.max(1, Math.floor(usable / needMean)) : 1;
        const kk = c.chargeCap > 0 ? Math.max(1, Math.ceil(usable / (c.chargeCap * c.chargeEff))) : 1;
        const sorted = ts.map((t) => S[t].p).sort((a, z) => a - z);
        const hi = sorted[Math.max(0, sorted.length - Math.min(mm, sorted.length))];
        const lo = sorted[Math.min(kk, sorted.length) - 1];
        // AC in → AC out round trip at this load (VERIFY-ups corrected form)
        const rte = dMean > 0 ? c.chargeEff * c.etaInv * dMean / (dMean + c.p0 * c.etaInv) : 0;
        const ok = rte > 0 && hi > lo / rte + b.wearPPerKwh;
        const fc = b.pvForecast === 'perfect' || di === 0 ? pvDay[di] : pvDay[di - 1];
        const target = Math.min(sMax, Math.max(sMin + Math.min(usable, mm * needMean), sMax - 0.8 * fc));
        for (const t of ts) { hiP[t] = hi; loP[t] = lo; allow[t] = ok ? 1 : 0; tgt[t] = target; }
    }
    return (t, soc) => {
        const s = S[t];
        const need = needOf(s);
        const batt = (allow[t] && s.p >= hiP[t]) || s.Pu >= 0.5 * need;
        if (batt && soc + s.Pu - need >= sMin - TOL && s.D <= c.outletCap + TOL) return { f: 1, cc: 0 };
        const s1 = Math.min(sMax, soc + s.Pu);
        let cc = 0;
        if (c.allowGridCharge && s.p <= loP[t] && s1 < tgt[t]) cc = Math.min(tgt[t] - s1, capB(s) * c.chargeEff) / c.chargeEff;
        return { f: 0, cc };
    };
}

/**
 * Run the DP (full year or rolling horizon) and replay the plan through the slot physics.
 */
function runDp(m, fl, rolling) {
    const { n, S, c, slot, sMin, N, dE, kUp, kDn, wear, local } = m;
    const costAt = (t, delta) => {
        const r = slot(delta, S[t], c);
        return r ? r.cost + wear * r.wearKwh : Infinity;
    };
    let idx = Math.round((m.socStart - sMin) / dE);
    idx = Math.max(0, Math.min(N - 1, idx));
    let soc = sMin + idx * dE;
    fl.socStart = soc;
    const step = (t, k) => {
        let r = slot(k * dE, S[t], c);
        if (!r) {
            // only reachable when every move was infeasible (e.g. a station run online with a charger
            // too small for the load): take the nearest feasible move, else hold
            for (let j = 1; j <= Math.max(kUp, kDn) && !r; j++) {
                for (const kk of [k + j, k - j]) {
                    if (r || kk > kUp || kk < -kDn || idx + kk < 0 || idx + kk > N - 1) continue;
                    r = slot(kk * dE, S[t], c);
                    if (r) k = kk;
                }
            }
            if (!r) { k = 0; r = slot(0, S[t], c) || upsFlows(0, 0, S[t].Pu, 0, S[t], c, 0); m.infeasible++; }
        }
        idx += k;
        soc = sMin + idx * dE;
        record(fl, t, r, soc, S[t], wear);
    };
    // replay the policy at the SoC we are actually at (not the precomputed path `ks`), so a slot
    // that forced a different move can never walk the SoC out of [sMin, sMax] afterwards
    if (!rolling) {
        const plan = dpPlan({ cost: costAt, t0: 0, t1: n, N, dE, kUp, kDn, startIdx: idx, termValuePerKwh: 0 });
        for (let t = 0; t < n; t++) step(t, plan.policy[t * N + idx]);
        return;
    }
    const replanHh = hhFromClock(m.b.replanAt);
    const starts = Array.from(replanStarts(local, replanHh));
    if (!starts.length || starts[0] !== 0) starts.unshift(0);
    const eta = c.coupling === 'dc' ? c.effD * c.etaNom : c.coupling === 'ac' ? c.acEffD : c.etaInv;
    let t0 = 0;
    let r = 0;
    while (t0 < n) {
        while (r < starts.length && starts[r] <= t0) r++;
        const nextReplan = r < starts.length ? starts[r] : n;
        let t1;
        if (t0 === 0 && local.hh[0] !== replanHh) {
            // before the first re-plan only the current Agile day's prices are known
            t1 = n;
            for (let t = 1; t < n; t++) if (local.hh[t] === 46) { t1 = t; break; }
        } else {
            t1 = horizonEnd(local, t0);
        }
        if (!(t1 > t0)) t1 = Math.min(n, t0 + 48);
        const tCommit = Math.max(t0 + 1, Math.min(nextReplan, t1));
        const ps = [];
        for (let t = t0; t < t1; t++) ps.push(S[t].p);
        const tau = median(ps) * eta;
        const plan = dpPlan({ cost: costAt, t0, t1, N, dE, kUp, kDn, startIdx: idx, termValuePerKwh: tau });
        for (let t = t0; t < tCommit; t++) step(t, plan.policy[(t - t0) * N + idx]);
        t0 = tCommit;
    }
}

/**
 * Dispatch a battery or power station over the whole dataset.
 * @param {Object} inp DispatchInputs { n, load (kWh, incl. loadAdjust), pvAc (no-battery acKwh), dcInvKwh,
 *   clippedDcKwh, etaPv, standbyKwh? (PV inverter night draw), upsPvDc (station own PV DC kWh, capped),
 *   dedicated (D_t kWh), pD, xD (decision prices), local (time.js LocalIndex), acLimitW, etaNom, canCurtail }
 * @param {Object} battery normalised battery (system.js)
 * @param {{ strategy?: string, N?: number, deltaKwh?: number, soh?: number, socStartKwh?: number,
 *   baseLoadW?: number }} [opts]  strategy 'idle' holds delta ≡ 0 (tests); N overrides the δ rule
 * @returns {Flows}
 */
export function dispatch(inp, battery, opts = {}) {
    const n = inp.n;
    const fl = newFlows(n);
    let strategy = opts.strategy ?? battery.strategy;
    if (battery.coupling === 'ups') {
        if (strategy === 'fixed') {
            fl.warnings.push("A power station's output always equals what is plugged into it — 'fixed' is not a valid mode; using threshold.");
            strategy = 'threshold';
        }
    } else if (strategy === 'online') {
        strategy = 'optimal';
    }
    const c = prepareConfig(inp, battery, opts, strategy);
    const S = prepareSlots(inp, battery, c);
    const soh = opts.soh ?? 1;
    const sMax = battery.capacityKwh * soh;
    const sMin = (battery.minSocPct / 100) * sMax;
    const range = sMax - sMin;
    fl.sMin = sMin;
    fl.sMax = sMax;
    const slot = battery.coupling === 'dc' ? slotDC : battery.coupling === 'ac' ? slotAC : slotUPS;
    if (battery.coupling === 'ups') {
        let pvAny = false;
        for (let t = 0; t < n; t++) {
            if (S[t].D > c.outletCap + TOL) fl.upsOverloadSlots++;
            if (S[t].Pu > 0) pvAny = true;
        }
        if (strategy === 'self' && !pvAny) fl.warnings.push('Self mode never recharges without its own panels.');
        if (fl.upsOverloadSlots > 0) fl.warnings.push(`The server load exceeds the station's outlet rating in ${fl.upsOverloadSlots} half-hours; those run on the grid.`);
    }
    if (!(range > 1e-9)) strategy = 'idle';
    // SoC grid: N = clamp(ceil(range/δ)+1, 41, 201) unless N is forced
    const delta = opts.deltaKwh ?? battery.deltaKwh ?? 0.025;
    let N = range > 1e-9 ? Math.max(2, Math.round(opts.N ?? Math.min(201, Math.max(41, Math.ceil(range / delta - 1e-9) + 1)))) : 1;
    let dE = range > 1e-9 ? range / (N - 1) : 0;
    if (battery.coupling === 'ups' && opts.N == null && range > 1e-9) {
        // A station's most valuable move is a whole slot on the inverter (f = 1, Δs = −need). On a
        // grid where need is not a multiple of dE that move is truncated to f < 1 every peak slot
        // (−2.7% on the 2 kWh/300 W case), so align dE to need and give up < dE of headroom at the top.
        let needRef = 0;
        for (let t = 0; t < n; t++) needRef = Math.max(needRef, S[t].D / c.etaInv + c.p0 - S[t].Pu);
        if (needRef > 1e-9) {
            let q = Math.max(1, Math.ceil(needRef / delta - 1e-9));
            if (Math.floor((range * q) / needRef + 1e-9) + 1 < 41) q = Math.ceil((needRef * 40) / range - 1e-9);
            const n2 = Math.floor((range * q) / needRef + 1e-9) + 1;
            if (n2 >= 2 && n2 <= 201) { N = n2; dE = needRef / q; }
        }
    }
    let kUp = 0;
    let kDn = 0;
    let upKwh = 0; // largest stored-energy change per slot the power limits allow
    let dnKwh = 0;
    if (dE > 0) {
        if (battery.coupling === 'dc') {
            upKwh = c.maxChgDc * c.effC;
            dnKwh = Math.min(c.maxDisDc, c.acCap / c.etaNom) / c.effD;
        } else if (battery.coupling === 'ac') {
            upKwh = c.maxChgAc * c.acEffC;
            dnKwh = c.maxDisAc / c.acEffD;
        } else {
            let maxPu = 0;
            let maxNeed = 0;
            for (let t = 0; t < n; t++) {
                if (S[t].Pu > maxPu) maxPu = S[t].Pu;
                const need = S[t].D / c.etaInv + c.p0;
                if (need > maxNeed) maxNeed = need;
            }
            upKwh = c.chargeCap * c.chargeEff + maxPu;
            dnKwh = maxNeed;
        }
        kUp = Math.min(N - 1, Math.floor(upKwh / dE + 1e-9));
        kDn = Math.min(N - 1, Math.floor(dnKwh / dE + 1e-9));
    }
    const usesDp = strategy === 'optimal' || strategy === 'smart' || strategy === 'online' || c.online;
    if (usesDp && dE > 0 && ((upKwh > 0 && kUp < 2) || (dnKwh > 0 && kDn < 2))) {
        // N is capped at 201 for speed, so a very large battery with modest power gets a grid step
        // close to (or above) a whole slot's charge or discharge — the optimiser then under-uses it
        fl.warnings.push(`The battery is too large for the optimiser's ${N}-level charge grid at this power (${(dE * 1000).toFixed(0)} Wh per step); its optimised savings are understated.`);
    }
    fl.N = N;
    fl.dE = dE;
    // A power station arrives charged (and sim_ups starts full); a home battery starts at reserve.
    const socStart = opts.socStartKwh ?? (battery.coupling === 'ups' ? sMax : sMin);
    const m = {
        n, S, c, b: battery, slot, sMin, sMax, N, dE, kUp, kDn, wear: battery.wearPPerKwh, local: inp.local,
        socStart: Math.max(sMin, Math.min(sMax, socStart)), opts, infeasible: 0,
        ad: inp.local ? agileDays(inp.local, n) : new Int32Array(n),
    };
    const dpStrategy = strategy === 'optimal' || strategy === 'smart' || strategy === 'online' || (c.online && strategy !== 'idle');
    if (c.online && !dpStrategy) fl.warnings.push('With bypass disabled the charger timing is optimised; rule strategies do not apply.');
    if (dpStrategy) {
        if (!inp.local && strategy === 'smart') throw new Error('dispatch: smart strategy needs inp.local');
        runDp(m, fl, strategy === 'smart');
    } else if (battery.coupling === 'ups') {
        const ctl = upsController(m, strategy);
        let soc = m.socStart;
        fl.socStart = soc;
        for (let t = 0; t < n; t++) {
            const { f, cc } = ctl(t, soc);
            const r = upsRuleSlot(f, cc, soc, S[t], c, sMin, sMax);
            soc = Math.max(sMin, Math.min(sMax, soc + r.delta));
            record(fl, t, r, soc, S[t], m.wear);
        }
    } else {
        const ctl = ruleController(m, strategy);
        let soc = m.socStart;
        fl.socStart = soc;
        for (let t = 0; t < n; t++) {
            const want = ctl(t, soc);
            const d = strategy === 'idle' ? 0 : clampDelta(want, soc, S[t], c, sMin, sMax);
            const r = ruleSlot(slot, d, S[t], c);
            soc = Math.max(sMin, Math.min(sMax, soc + r.delta));
            record(fl, t, r, soc, S[t], m.wear);
        }
    }
    if (m.infeasible > 0) fl.warnings.push(`${m.infeasible} half-hours had no feasible battery move (charger too small for the load?) and ran on the grid.`);
    if (c.online) {
        let deficit = 0;
        for (let t = 0; t < n; t++) deficit = Math.max(deficit, S[t].D / c.etaInv + c.p0 - S[t].Pu);
        if (c.chargeCap * c.chargeEff + 1e-12 < deficit) {
            fl.warnings.push('The charge rate is below what the servers draw through the inverter, so running with bypass disabled cannot be sustained.');
        }
    }
    fl.strategy = strategy;
    let out = 0;
    for (let t = 0; t < n; t++) out += fl.battOut[t];
    fl.cycles = range > 1e-9 ? out / range : 0;
    fl.objectiveP = fl.costP + fl.wearP;
    return fl;
}
