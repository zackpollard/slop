import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { slotDC, slotAC, slotUPS, dpPlan, dispatch, noBatteryFlows, upsFixedLossW, STRATEGY_LABELS } from '../../../projects/solar-calculator/js/battery.js';
import { normalizeBattery } from '../../../projects/solar-calculator/js/system.js';
import { buildLocalIndex } from '../../../projects/solar-calculator/js/time.js';
import { synthDataset, synthPv, synthUpsPv, findNonFinite } from './fixtures/solar/a3-synth.js';

const fx = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/solar/${name}`, import.meta.url)), 'utf8'));

/** A slot-function config equivalent to the research reference defaults (constant inverter eff 0.95). */
function refDcConfig({ wear = 0, acCharge = true, canCurtail = true, allowGridExport = true } = {}) {
    return {
        coupling: 'dc', allowGridExport, canCurtail, wear, etaNom: 0.95, acCap: 0.4, allowGridCharge: acCharge,
        effC: 0.96, effD: 0.96, acChargeEff: 0.93, maxChgDc: 0.5, maxDisDc: 0.5, gridCapDc: acCharge ? 0.4 * 0.93 : 0,
    };
}
function refAcConfig() {
    return {
        coupling: 'ac', allowGridExport: true, canCurtail: false, wear: 0, etaNom: 0.95, acCap: 0.4, allowGridCharge: true,
        acEffC: 0.922, acEffD: 0.922, maxChgAc: 1.25, maxDisAc: 0.4, gridCapAc: 1.25,
    };
}
/** Reference slot inputs: S = DC PV kWh with constant eff 0.95 and a 400 Wh AC cap per slot. */
function refSlot({ S, L, p, x }) {
    const cap = 0.4 / 0.95;
    const dcInv = Math.min(S, cap);
    return { L, p, x, dcInv, clip: S - dcInv, etaPv: 0.95, pvAc: 0.95 * dcInv, Pu: 0, D: 0, Agt: 0.95 * dcInv };
}

const UPS_C = {
    coupling: 'ups', allowGridExport: false, canCurtail: false, wear: 2, etaNom: 0.96, acCap: Infinity, allowGridCharge: true, online: false,
    etaInv: 0.94, chargeEff: 0.88, chargeCap: 0.4, p0: 0.01, byp: 0.004, outletCap: 0.9, inputCap: 1.495,
};

describe('slotUPS — engine-critique hand slot (L 0.25, D 0.15, Pu 0, p 30, x 0)', () => {
    const s = { L: 0.25, D: 0.15, Agt: 0, Pu: 0, p: 30, x: 0, clip: 0 };
    const need = 0.15 / 0.94 + 0.01;

    it('need = 0.1695745', () => {
        expect(need).toBeCloseTo(0.1695745, 7);
        expect(upsFixedLossW(normalizeBattery({ coupling: 'ups', capacityKwh: 2 }))).toBe(20);
        expect(upsFixedLossW(normalizeBattery({ coupling: 'ups', capacityKwh: 3 }))).toBe(30);
    });
    it('delta = −need → f = 1, imp 0.10, cost 3.000p', () => {
        const r = slotUPS(-need, s, UPS_C);
        expect(r.f).toBeCloseTo(1, 12);
        expect(r.imp).toBeCloseTo(0.10, 12);
        expect(r.cost).toBeCloseTo(3.0, 9);
    });
    it('delta = −need/2 → f = 0.5, cost 5.310p', () => {
        const r = slotUPS(-need / 2, s, UPS_C);
        expect(r.f).toBeCloseTo(0.5, 12);
        expect(r.cost).toBeCloseTo(5.31, 9);
    });
    it('delta = 0 → imp 0.254, cost 7.620p', () => {
        const r = slotUPS(0, s, UPS_C);
        expect(r.imp).toBeCloseTo(0.254, 12);
        expect(r.cost).toBeCloseTo(7.62, 9);
    });
    it('delta = +0.2 → grid charge 0.2272727, cost 14.438p', () => {
        const r = slotUPS(0.2, s, UPS_C);
        expect(r.gridChg).toBeCloseTo(0.2272727, 7);
        expect(r.f).toBe(0);
        expect(r.cost).toBeCloseTo(14.438, 3);
    });
    it('delta = −0.2 (more than need) → null', () => {
        expect(slotUPS(-0.2, s, UPS_C)).toBeNull();
    });
    it('with grid-tied PV Agt = 0.3, delta = +0.2 → imp 0.1812727, cost 5.438p', () => {
        const r = slotUPS(0.2, { ...s, Agt: 0.3 }, UPS_C);
        expect(r.imp).toBeCloseTo(0.1812727, 7);
        expect(r.cost).toBeCloseTo(5.438, 3);
    });
    it('never charges from the grid while inverting (no f > 0 with c > 0)', () => {
        for (let d = -0.17; d <= 0.4; d += 0.01) {
            const r = slotUPS(d, s, UPS_C);
            if (r) expect(r.f > 1e-12 && r.gridChg > 1e-12).toBe(false);
        }
    });
    it('own PV feeds the inverter first; surplus beyond the battery is wasted only when delta asks for it', () => {
        const r = slotUPS(0.05, { ...s, Pu: 0.3 }, UPS_C); // PV 0.3: 0.1696 to the servers, 0.05 stored, rest wasted
        expect(r.f).toBeCloseTo(1, 12);
        expect(r.wasted).toBeCloseTo(0.3 - 0.05 - need, 12);
        expect(r.imp).toBeCloseTo(0.1, 12);
    });
    it('online (bypass disabled) always inverts and may charge at the same time', () => {
        const r = slotUPS(0.1, s, { ...UPS_C, online: true });
        expect(r.f).toBe(1);
        expect(r.gridChg).toBeCloseTo((0.1 + need) / 0.88, 12);
        expect(r.bypass).toBe(0);
    });
});

describe('port fidelity vs research dispatch.mjs (goldens)', () => {
    const g = fx('a3-dispatch-golden.json');

    it('slotDC costs match the reference on a delta grid (canCurtail true)', () => {
        const c = refDcConfig();
        let compared = 0;
        g.slots.forEach((sl, i) => {
            const s = refSlot(sl);
            g.deltas.forEach((d, j) => {
                const ref = g.dc[i][j];
                const r = slotDC(d, s, c);
                if (ref === null) { expect(r).toBeNull(); return; }
                // the port also enforces the DC charge limit inside the slot (the reference relied on kUp)
                if (r === null) { expect(d / c.effC).toBeGreaterThan(c.maxChgDc); return; }
                // exact enumeration is never worse than the reference's greedy source order, and is
                // identical unless import is cheaper than export (p < x, e.g. negative Agile slots), where
                // the greedy grid-charges and curtails instead of exporting
                expect(r.cost).toBeLessThanOrEqual(ref + 1e-6);
                if (sl.p >= sl.x) {
                    expect(Math.abs(r.cost - ref)).toBeLessThan(1e-6 * Math.max(1, Math.abs(ref)));
                    compared++;
                }
            });
        });
        expect(compared).toBeGreaterThan(300);
    });

    it('slotAC costs match the reference on a delta grid', () => {
        const c = refAcConfig();
        g.slots.forEach((sl, i) => {
            const s = refSlot(sl);
            g.deltas.forEach((d, j) => {
                const ref = g.ac[i][j];
                const r = slotAC(d, s, c);
                if (ref === null) { expect(r).toBeNull(); return; }
                expect(r.cost).toBeCloseTo(ref, 6);
            });
        });
    });

    it('dpPlan reproduces the reference plan over a 62-slot horizon (N 41, wear 2p, AC charging)', () => {
        const dp = g.dp;
        const c = refDcConfig({ wear: 2 });
        const sMin = 0.2;
        const dE = 1.8 / 40;
        const S = dp.S.map((S, i) => refSlot({ S, L: dp.L[i], p: dp.p[i], x: dp.x[i] }));
        const cost = (t, delta) => {
            const r = slotDC(delta, S[t], c);
            return r ? r.cost + 2 * r.wearKwh : Infinity;
        };
        const kUp = Math.floor((0.5 * 0.96) / dE + 1e-9);
        const kDn = Math.floor(Math.min(0.5, 0.4 / 0.95) / 0.96 / dE + 1e-9);
        expect([kUp, kDn]).toEqual([dp.kUp, dp.kDn]);
        const plan = dpPlan({ cost, t0: 0, t1: dp.S.length, N: 41, dE, kUp, kDn, startIdx: Math.round((dp.socStartKwh - sMin) / dE), termValuePerKwh: dp.termValuePerKwh });
        expect(Array.from(plan.ks)).toEqual(dp.ks);
    });
});

describe('regressions found in review', () => {
    it('dawn/dusk DC that the inverter turns into no AC (etaPv = 0) is never credited as AC', () => {
        const c = { ...refDcConfig({ canCurtail: false, allowGridExport: false }), etaNom: 0.96 };
        const s = { L: 0.2, p: 20, x: 0, dcInv: 0.002, clip: 0, etaPv: 0, pvAc: 0 };
        const idle = slotDC(0, s, c);
        expect(idle.pvDirectAc).toBe(0);
        expect(idle.imp).toBeCloseTo(0.2, 12);
        // the DC can still charge a dc-coupled battery (MPPT → cells) without any AC being lost
        const chg = slotDC(0.001, s, c);
        expect(chg.cost).toBeCloseTo(idle.cost, 12);
        expect(chg.gridChg).toBe(0);
        const dis = slotDC(-0.1, s, c);
        expect(dis.pvDirectAc).toBe(0);
        expect(Number.isFinite(dis.cost)).toBe(true);
        // a full dispatch with zero load at dawn (0/0 in the follow-the-load target) stays finite
        const nn = 96;
        const local = buildLocalIndex(Date.parse('2026-06-01T00:00:00Z'), nn);
        const z = new Float64Array(nn);
        const inp = { n: nn, load: z, pvAc: z, dcInvKwh: new Float64Array(nn).fill(0.002), clippedDcKwh: z, etaPv: z, standbyKwh: null,
            upsPvDc: null, dedicated: null, pD: new Float64Array(nn).fill(20), xD: z, local, acLimitW: 800, etaNom: 0.96, canCurtail: false };
        for (const strategy of ['self', 'fixed', 'threshold', 'optimal']) {
            const fl = dispatch(inp, DC({ strategy, standbyW: 0 }));
            expect(findNonFinite(fl)).toEqual([]);
            expect(fl.pvDirectAc.every((v) => v === 0)).toBe(true);
        }
    });
    it('the DP replay follows the policy at the actual SoC: an infeasible stretch never drives SoC out of range', () => {
        // a station run with bypass disabled whose charger cannot carry an 800 W stretch: those
        // slots force a different move than the plan, and the precomputed path used to take the SoC to −0.77 kWh
        const nn = 48 * 4;
        const local = buildLocalIndex(Date.parse('2026-01-10T00:00:00Z'), nn);
        const load = Float64Array.from({ length: nn }, (_, t) => (t >= 40 && t < 60 ? 0.4 : 0.15));
        const z = new Float64Array(nn);
        const inp = { n: nn, load, pvAc: z, dcInvKwh: z, clippedDcKwh: z, etaPv: null, standbyKwh: null, upsPvDc: null, dedicated: load,
            pD: Float64Array.from({ length: nn }, (_, t) => (local.hh[t] >= 32 && local.hh[t] < 38 ? 40 : 15)), xD: z, local,
            acLimitW: Infinity, etaNom: 0.96, canCurtail: false };
        for (const strategy of ['optimal', 'smart']) {
            const b = normalizeBattery({ coupling: 'ups', capacityKwh: 1, acOutputW: 1800, strategy, ups: { dedicatedW: 800, chargeW: 500, bypass: 'disabled' } });
            const fl = dispatch(inp, b);
            expect(fl.warnings.join(' ')).toMatch(/no feasible battery move/);
            for (let t = 0; t < nn; t++) {
                expect(fl.soc[t]).toBeGreaterThanOrEqual(fl.sMin - 1e-9);
                expect(fl.soc[t]).toBeLessThanOrEqual(fl.sMax + 1e-9);
            }
        }
    });
    it('dpPlan exposes the full policy (row t − t0, column SoC index) consistent with ks', () => {
        const p = [5, 30, 5, 30];
        const plan = dpPlan({ cost: (t, d) => p[t] * d, t1: 4, N: 5, dE: 0.25, kUp: 2, kDn: 2, startIdx: 0 });
        expect(plan.policy).toBeInstanceOf(Int16Array);
        expect(plan.policy.length).toBe(4 * 5);
        let i = 0;
        for (let t = 0; t < 4; t++) { expect(plan.ks[t]).toBe(plan.policy[t * 5 + i]); i += plan.ks[t]; }
    });
    it('a battery too large for the 201-level grid at its power warns instead of silently under-using it', () => {
        const inp = inputs({ x: primeX });
        const fl = dispatch(inp, AC({ strategy: 'optimal', capacityKwh: 100, maxChargeW: 800, maxDischargeW: 800 }));
        expect(fl.N).toBe(201);
        expect(fl.warnings.join(' ')).toMatch(/too large for the optimiser/);
        expect(dispatch(inp, AC({ strategy: 'optimal' })).warnings.join(' ')).not.toMatch(/too large/);
    });
});

describe('dpPlan', () => {
    it('uses an Int16Array policy: kUp > 127 does not wrap', () => {
        const T = 6;
        const p = [5, 5, 50, 50, 5, 50];
        const cost = (t, d) => (d >= 0 ? p[t] * d : p[t] * d * 0.9);
        const plan = dpPlan({ cost, t1: T, N: 301, dE: 0.01, kUp: 200, kDn: 200, startIdx: 0 });
        expect(plan.ks).toBeInstanceOf(Int16Array);
        expect(Math.max(...plan.ks)).toBe(200); // 2 kWh in one cheap slot: more steps than Int8 can hold
        expect(Math.min(...plan.ks)).toBeGreaterThanOrEqual(-200);
    });
    it('terminal value keeps energy when it is worth more than using it', () => {
        const cost = (t, d) => 10 * d;
        const keep = dpPlan({ cost, t1: 3, N: 11, dE: 0.1, kUp: 2, kDn: 2, startIdx: 10, termValuePerKwh: 20 });
        expect(keep.endIdx).toBe(10);
        const use = dpPlan({ cost, t1: 3, N: 11, dE: 0.1, kUp: 2, kDn: 2, startIdx: 10, termValuePerKwh: 0 });
        expect(use.endIdx).toBe(4);
    });
});

/* ── full synthetic year: invariants for every strategy × coupling ── */

const ds = synthDataset({ seed: 11, baseW: 350 });
const pv = synthPv(ds, { kWp: 1.84, seed: 4, standbyW: 1 });
const upsPv = synthUpsPv(ds, { kWp: 0.46, maxDcW: 500 });
const n = ds.n;
const pD = ds.importPriceFwdExc.map((v) => v * 1.05);
const primeX = ds.exportPricesFwd.prime;

function inputs({ withPv = true, x = null, canCurtail = false, dedicatedW = 0, ups = false, ownPv = true } = {}) {
    const z = new Float64Array(n);
    const D = ups ? ds.load.map((l) => Math.min(l, (dedicatedW * 0.5) / 1000)) : null;
    return {
        n, load: ds.load, pvAc: withPv ? pv.acKwh : z, dcInvKwh: withPv ? pv.dcInvKwh : z, clippedDcKwh: withPv ? pv.clippedDcKwh : z,
        etaPv: withPv ? pv.etaPv : null, standbyKwh: withPv ? pv.standbyKwh : null, upsPvDc: ups && ownPv ? upsPv : null, dedicated: D,
        pD, xD: x ?? new Float64Array(n), local: ds.local, acLimitW: 800, etaNom: 0.96, canCurtail,
    };
}

const DC = (extra = {}) => normalizeBattery({ coupling: 'dc', capacityKwh: 2, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 800, ...extra });
const AC = (extra = {}) => normalizeBattery({ coupling: 'ac', capacityKwh: 2.4, maxChargeW: 1200, maxDischargeW: 800, acChargeW: 1200, standbyW: 6, ...extra });
const UPS = (extra = {}, upsExtra = {}) => normalizeBattery({ coupling: 'ups', capacityKwh: 2, ...extra, ups: { dedicatedW: 300, chargeW: 800, outletMaxW: 1800, ...upsExtra } });

function checkInvariants(fl, inp, b) {
    const tol = 1e-9;
    let prev = fl.socStart;
    const bad = [];
    for (let t = 0; t < n; t++) {
        const L = inp.load[t];
        const sb = inp.standbyKwh ? inp.standbyKwh[t] : 0;
        const soc = fl.soc[t];
        if (soc < fl.sMin - tol || soc > fl.sMax + tol) bad.push(`soc ${t}`);
        if (Math.abs(soc - prev - (fl.battIn[t] - fl.battOut[t])) > tol) bad.push(`soc step ${t}`);
        if (b.coupling === 'dc') {
            const cPv = fl.battIn[t] / b.effCharge - fl.gridChg[t] * b.acChargeEff;
            const dcRaw = inp.dcInvKwh[t] + inp.clippedDcKwh[t];
            if (cPv < -tol) bad.push(`cPv<0 ${t}`);
            if (inp.dcInvKwh[t] > 0 && inp.etaPv[t] === 0) {
                // dawn/dusk: the inverter turns its DC into no AC, so u is not observable from pvDirectAc;
                // the flows must still add no AC and keep u = dcRaw − cPv − clipped − curtailed in [0, dcInv]
                const u = dcRaw - cPv - fl.clipped[t] - fl.curtailed[t];
                if (fl.pvDirectAc[t] !== 0 || u < -tol || u > inp.dcInvKwh[t] + tol) bad.push(`dc dawn ${t}`);
            } else {
                const u = fl.pvDirectAc[t] / (inp.dcInvKwh[t] > 0 ? inp.etaPv[t] : 0.96);
                if (Math.abs(dcRaw - (cPv + u + fl.clipped[t] + fl.curtailed[t])) > tol) bad.push(`dc bus ${t}`);
            }
            if (fl.battOut[t] > 0 && Math.abs(fl.battOut[t] * b.effDischarge * 0.96 - fl.battOutAc[t]) > tol) bad.push(`dc out ${t}`);
            const house = L + b.standbyW * 0.5 / 1000 + sb + fl.gridChg[t] - fl.pvDirectAc[t] - fl.battOutAc[t];
            if (Math.abs(fl.imp[t] - fl.exp[t] - house) > tol) bad.push(`house ${t}`);
            if (fl.pvDirectAc[t] + fl.battOutAc[t] > 0.4 + tol) bad.push(`ac cap ${t}`);
        } else if (b.coupling === 'ac') {
            if (Math.abs(fl.battIn[t] - b.acEffCharge * fl.battChgAc[t]) > tol) bad.push(`ac in ${t}`);
            if (Math.abs(fl.battOut[t] * b.acEffDischarge - fl.battOutAc[t]) > tol) bad.push(`ac out ${t}`);
            const eta = inp.etaPv[t] > 0 ? inp.etaPv[t] : 0.96;
            if (Math.abs(inp.pvAc[t] - fl.pvDirectAc[t] - fl.curtailed[t] * eta) > tol) bad.push(`ac pv ${t}`);
            const house = L + b.standbyW * 0.5 / 1000 + sb + fl.battChgAc[t] - fl.pvDirectAc[t] - fl.battOutAc[t];
            if (Math.abs(fl.imp[t] - fl.exp[t] - house) > tol) bad.push(`house ${t}`);
        } else {
            const D = inp.dedicated[t];
            const f = fl.upsF[t];
            const p0 = upsFixedLossW(b) * 0.5 / 1000;
            const dS = fl.battIn[t] - fl.battOut[t];
            const expect = (inp.upsPvDc ? inp.upsPvDc[t] : 0) - fl.upsPvWasted[t] + b.ups.chargeEff * fl.gridChg[t] - f * (D / b.ups.etaInv + p0);
            if (Math.abs(dS - expect) > tol) bad.push(`ups store ${t}`);
            const house = L + sb - f * D + fl.bypassOverhead[t] + fl.gridChg[t] - inp.pvAc[t];
            if (Math.abs(fl.imp[t] - fl.exp[t] - house) > tol) bad.push(`ups house ${t}`);
            if (b.ups.bypass !== 'disabled' && f > 1e-12 && fl.gridChg[t] > 1e-12) bad.push(`ups f&c ${t}`);
            if (fl.upsPvWasted[t] < -tol) bad.push(`wasted<0 ${t}`);
        }
        prev = soc;
        if (bad.length > 5) break;
    }
    return bad;
}

const RULES = ['self', 'fixed', 'schedule', 'threshold'];
const ALL = [...RULES, 'smart', 'optimal'];

describe('per-slot invariants over a synthetic year (every strategy × coupling)', () => {
    for (const strategy of ALL) {
        it(`dc ${strategy}`, () => {
            const inp = inputs({ x: primeX });
            const b = DC({ strategy });
            const fl = dispatch(inp, b, { baseLoadW: 350 });
            expect(checkInvariants(fl, inp, b)).toEqual([]);
            expect(findNonFinite(fl)).toEqual([]);
        });
        it(`ac ${strategy}`, () => {
            const inp = inputs({ x: primeX });
            const b = AC({ strategy });
            const fl = dispatch(inp, b, { baseLoadW: 350 });
            expect(checkInvariants(fl, inp, b)).toEqual([]);
            expect(findNonFinite(fl)).toEqual([]);
        });
    }
    for (const strategy of ['self', 'schedule', 'threshold', 'smart', 'optimal']) {
        it(`ups ${strategy} (own PV, grid-tied PV on the house bus)`, () => {
            const inp = inputs({ ups: true, dedicatedW: 300 });
            const b = UPS({ strategy });
            const fl = dispatch(inp, b);
            expect(checkInvariants(fl, inp, b)).toEqual([]);
            expect(findNonFinite(fl)).toEqual([]);
        });
    }
    for (const strategy of ['optimal', 'self', 'threshold']) {
        it(`ups online (bypass disabled, real charge rate), strategy ${strategy}`, () => {
            const inp = inputs({ ups: true, dedicatedW: 300 });
            const b = UPS({ strategy }, { bypass: 'disabled', chargeW: 1500 });
            const fl = dispatch(inp, b, { N: 61 });
            expect(checkInvariants(fl, inp, b)).toEqual([]);
            expect(fl.bypassOverhead.every((v) => v === 0)).toBe(true);
            expect(fl.upsF.every((v) => v === 1)).toBe(true);
            expect(fl.warnings.join(' ')).not.toMatch(/no feasible/);
        });
    }
    it('dc with canCurtail and battery export allowed still conserves energy', () => {
        const inp = inputs({ x: primeX, canCurtail: true });
        const b = DC({ strategy: 'optimal', allowGridExport: true });
        const fl = dispatch(inp, b, { N: 41 });
        expect(checkInvariants(fl, inp, b)).toEqual([]);
    });
});

describe('physics consistency with the no-battery run', () => {
    const inp = inputs({ x: primeX });
    const nb = noBatteryFlows(inp);

    it('slotDC(0) and slotAC(0) give pvAC = acKwh of the no-battery pass for every slot', () => {
        const cDc = { ...refDcConfig({ canCurtail: false, allowGridExport: false }), etaNom: 0.96, acCap: 0.4 };
        const cAc = { ...refAcConfig(), canCurtail: false };
        let worst = 0;
        for (let t = 0; t < n; t++) {
            const s = { L: ds.load[t], p: pD[t], x: primeX[t], dcInv: pv.dcInvKwh[t], clip: pv.clippedDcKwh[t], etaPv: pv.etaPv[t], pvAc: pv.acKwh[t] };
            worst = Math.max(worst, Math.abs(slotDC(0, s, cDc).pvDirectAc - pv.acKwh[t]), Math.abs(slotAC(0, s, cAc).pvDirectAc - pv.acKwh[t]));
            expect(nb.pvDirectAc[t]).toBe(pv.acKwh[t]);
        }
        expect(worst).toBeLessThan(1e-9);
    });

    for (const mk of [DC, AC]) {
        it(`${mk === DC ? 'dc' : 'ac'} battery held at delta ≡ 0 with standby 0 reproduces the no-battery flows`, () => {
            const fl = dispatch(inp, mk({ standbyW: 0 }), { strategy: 'idle' });
            let d = 0;
            for (let t = 0; t < n; t++) d = Math.max(d, Math.abs(fl.imp[t] - nb.imp[t]), Math.abs(fl.exp[t] - nb.exp[t]), Math.abs(fl.clipped[t] - nb.clipped[t]));
            expect(d).toBeLessThan(1e-12);
            expect(Math.abs(fl.costP - nb.costP)).toBeLessThan(1e-6);
        });
    }
});

describe('no battery-to-grid export by default', () => {
    for (const mk of [DC, AC]) {
        const name = mk === DC ? 'dc' : 'ac';
        it(`${name}: with Prime export and AC charging, discharge never exports (allowGridExport false)`, () => {
            const inp = inputs({ x: primeX });
            for (const strategy of ['optimal', 'threshold', 'fixed']) {
                const fl = dispatch(inp, mk({ strategy, fixedOutputW: 800 }), { N: 41 });
                for (let t = 0; t < n; t++) {
                    if (fl.battOut[t] > 1e-12) {
                        const sb = inp.standbyKwh[t] + mk().standbyW * 0.5 / 1000;
                        expect(fl.exp[t]).toBeLessThanOrEqual(Math.max(0, fl.pvDirectAc[t] - inp.load[t] - sb) + 1e-9);
                    }
                }
            }
        });
        it(`${name}: DP savings with battery export ≥ without`, () => {
            const inp = inputs({ x: primeX });
            const no = dispatch(inp, mk({ strategy: 'optimal' }), { N: 41 });
            const yes = dispatch(inp, mk({ strategy: 'optimal', allowGridExport: true }), { N: 41 });
            expect(yes.objectiveP).toBeLessThanOrEqual(no.objectiveP + 1e-6);
        });
    }
});

describe('UPS never exports when there is no grid-tied PV', () => {
    for (const strategy of ['self', 'schedule', 'threshold', 'smart', 'optimal', 'online', 'fixed']) {
        it(strategy, () => {
            const inp = inputs({ withPv: false, ups: true, dedicatedW: 300 });
            const fl = dispatch(inp, UPS({ strategy }, strategy === 'online' ? { chargeW: 1500 } : {}), { N: 41 });
            expect(fl.exp.every((v) => v === 0)).toBe(true);
            if (strategy === 'fixed') expect(fl.strategy).toBe('threshold');
        });
    }
});

describe('DP vs rule strategies on the objective J = cost + wear', () => {
    for (const [name, mk, ups] of [['dc', DC, false], ['ac', AC, false], ['ups', UPS, true]]) {
        it(`${name}: J_DP(N=81) ≤ J_rule·1.005 for every rule`, () => {
            const inp = ups ? inputs({ ups: true, dedicatedW: 300 }) : inputs({ x: primeX });
            const dp = dispatch(inp, mk({ strategy: 'optimal' }), { N: 81, baseLoadW: 350 });
            for (const r of ups ? ['self', 'schedule', 'threshold'] : RULES) {
                const fl = dispatch(inp, mk({ strategy: r }), { baseLoadW: 350 });
                expect(dp.objectiveP).toBeLessThanOrEqual(fl.objectiveP * 1.005);
            }
        });
    }
    it('with wear 0, DP cost ≤ every rule cost (+0.5%)', () => {
        const inp = inputs({ x: primeX });
        const dp = dispatch(inp, DC({ strategy: 'optimal', wearPPerKwh: 0 }), { N: 81 });
        for (const r of RULES) {
            const fl = dispatch(inp, DC({ strategy: r, wearPPerKwh: 0 }), { baseLoadW: 350 });
            expect(dp.costP).toBeLessThanOrEqual(fl.costP * 1.005);
        }
    });
    it('rolling-horizon "smart" is close to perfect hindsight for a small battery', () => {
        const inp = inputs({ x: primeX });
        const opt = dispatch(inp, DC({ strategy: 'optimal' }), { N: 41 });
        const smart = dispatch(inp, DC({ strategy: 'smart' }), { N: 41 });
        expect(smart.objectiveP).toBeGreaterThanOrEqual(opt.objectiveP - 1e-6);
        expect(smart.objectiveP).toBeLessThan(opt.objectiveP * 1.01);
    });
});

describe('SoC grid and strategy handling', () => {
    it('N follows the δ rule: clamp(ceil(range/δ)+1, 41, 201)', () => {
        const inp = inputs({ x: primeX });
        expect(dispatch(inp, DC({ strategy: 'optimal', capacityKwh: 2 })).N).toBe(73); // 1.8/0.025 + 1
        expect(dispatch(inp, DC({ strategy: 'optimal', capacityKwh: 0.5 })).N).toBe(41);
        expect(dispatch(inp, DC({ strategy: 'optimal', capacityKwh: 10 })).N).toBe(201);
        expect(dispatch(inp, DC({ strategy: 'optimal', capacityKwh: 2 }), { deltaKwh: 0.05 }).N).toBe(41);
    });
    it('UPS grid is aligned so a whole inverter slot (f = 1) is representable', () => {
        const inp = inputs({ withPv: false, ups: true, dedicatedW: 300 });
        const fl = dispatch(inp, UPS({ strategy: 'optimal' }));
        const need = 0.15 / 0.94 + 0.01;
        expect(Math.abs(need / fl.dE - Math.round(need / fl.dE))).toBeLessThan(1e-9);
        expect(fl.upsF.some((f) => f === 1)).toBe(true);
    });
    it('a zero-capacity battery behaves like no battery plus standby', () => {
        const inp = inputs({ x: primeX });
        const fl = dispatch(inp, DC({ capacityKwh: 0, standbyW: 0, strategy: 'optimal' }));
        const nb = noBatteryFlows(inp);
        expect(Math.abs(fl.costP - nb.costP)).toBeLessThan(1e-6);
        expect(fl.cycles).toBe(0);
    });
    it('self mode on a station without its own panels warns', () => {
        const fl = dispatch(inputs({ withPv: false, ups: true, dedicatedW: 300, ownPv: false }), UPS({ strategy: 'self' }));
        expect(fl.warnings.join(' ')).toMatch(/never recharges/);
    });
    it('a charger too small to carry the load online is flagged', () => {
        const fl = dispatch(inputs({ withPv: false, ups: true, dedicatedW: 900 }), UPS({ strategy: 'optimal' }, { bypass: 'disabled', chargeW: 500 }), { N: 41 });
        expect(fl.warnings.join(' ')).toMatch(/charge rate is below/);
        expect(findNonFinite(fl)).toEqual([]);
    });
    it('labels exist for every strategy', () => {
        for (const s of ['self', 'fixed', 'schedule', 'threshold', 'smart', 'optimal', 'online']) expect(typeof STRATEGY_LABELS[s]).toBe('string');
    });
    it('works across the DST change days (46/50-slot local days)', () => {
        const start = Date.parse('2026-03-27T00:00:00Z');
        const local = buildLocalIndex(start, 48 * 4);
        const nn = 48 * 4;
        const z = new Float64Array(nn);
        const inp = { n: nn, load: new Float64Array(nn).fill(0.2), pvAc: z, dcInvKwh: z, clippedDcKwh: z, etaPv: null, standbyKwh: null,
            upsPvDc: null, dedicated: null, pD: Float64Array.from({ length: nn }, (_, t) => (local.hh[t] >= 32 && local.hh[t] < 38 ? 40 : 10)),
            xD: z, local, acLimitW: 800, etaNom: 0.96, canCurtail: false };
        for (const strategy of ['smart', 'threshold', 'schedule']) {
            const fl = dispatch(inp, AC({ strategy }));
            expect(findNonFinite(fl)).toEqual([]);
            expect(fl.battOut.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.5);
        }
    });
});
