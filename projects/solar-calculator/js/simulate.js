/*
 * simulate.js — one System on one Dataset: dispatch once, value twice, aggregate, annualise.
 *
 * Dispatch (rules or DP) runs ONCE on decision prices: pD = importPriceFwdExc·1.05 (last year's
 * Agile with the removed 3.333p levy taken out, at the 5% VAT a future year mostly pays) and
 * xD = the forward export price. The resulting flows are then valued two ways:
 *   (a) as billed — the VAT and levy actually charged in each historical slot, export as paid;
 *   (b) forward ex-VAT by local calendar month — what finance.js projects from, applying its own
 *       month-by-month VAT schedule (export income is never VAT'd).
 * Annual figures scale each calendar month's additive totals by DIM/coveredDays and recompute
 * ratios from the annual sums (scaling a percentage is meaningless).
 */

import { DT_H } from './time.js';
import { normalizeSystem } from './system.js';
import { dispatch, noBatteryFlows } from './battery.js';
import { estimateBaseLoad, monthCoverage, DIM } from './insights.js';

/**
 * Additive per-slot quantities accumulated per calendar month (kWh, pence, slot counts).
 * Ratios in Totals are recomputed from these after aggregation or annualisation.
 */
const ADDITIVE = [
    'loadKwh', 'baselineLoadKwh', 'pvDcKwh', 'upsPvKwh', 'pvAcKwh', 'pvDirectAcKwh', 'clippedKwh', 'curtailedKwh',
    'upsPvWastedKwh', 'exportKwh', 'exportUnpaidKwh', 'importKwh', 'gridChargeKwh', 'battInKwh', 'battOutKwh',
    'battOutAcKwh', 'standbyKwh', 'upsConversionLossKwh', 'bypassOverheadKwh',
    'baselineBilledP', 'newBilledP', 'savingsBilledP', 'exportIncomeBilledP', 'impSavFwdExcP', 'expIncFwdP',
    'standbyCostFwdExcP', 'wearP', 'savingsFilledP', 'filledLoadKwh',
    // ratio components
    'pvExportedKwh', 'netImportKwh', 'peakPvAcKwh', 'peakUpsPvKwh', 'peakImportKwh', 'peakBaselineLoadKwh',
    'slots', 'dedicatedClampSlots', 'upsOverloadSlots',
];

function zeroSums() {
    const o = {};
    for (const k of ADDITIVE) o[k] = 0;
    return o;
}

/**
 * Totals = additive sums + derived ratios (engine critique definitions):
 * selfConsumptionPct = 100·(1 − (Σ min(exp, pvDirectAc) + Σ station PV wasted)/(pvAc + station PV));
 * selfSufficiencyPct = clamp(100·(1 − Σ(imp − gridChg)/Σ L), 0, 100);
 * peakGenSharePct = 100·Σ_peak pvAc/Σ pvAc (grid-tied panels only); peakGenShareAllPct = the same with a
 * power station's own panels counted too (Σ_peak (pvAc + upsPv)/Σ (pvAc + upsPv));
 * peakImportCutPct = 100·(1 − Σ_peak imp/Σ_peak L_baseline);
 * filledSharePct = 100·Σ_filled L/Σ L; battCycles = battOut (stored)/(sMax − sMin).
 */
function finishTotals(sums, days, usableKwh) {
    const t = { days, ...sums };
    const pvGen = sums.pvAcKwh + sums.upsPvKwh;
    t.selfConsumptionPct = pvGen > 1e-9 ? Math.max(0, Math.min(100, 100 * (1 - (sums.pvExportedKwh + sums.upsPvWastedKwh) / pvGen))) : 0;
    t.selfSufficiencyPct = sums.loadKwh > 1e-9 ? Math.max(0, Math.min(100, 100 * (1 - sums.netImportKwh / sums.loadKwh))) : 0;
    t.peakGenSharePct = sums.pvAcKwh > 1e-9 ? (100 * sums.peakPvAcKwh) / sums.pvAcKwh : 0;
    t.peakGenShareAllPct = pvGen > 1e-9 ? (100 * (sums.peakPvAcKwh + sums.peakUpsPvKwh)) / pvGen : 0;
    t.peakImportCutPct = sums.peakBaselineLoadKwh > 1e-9 ? 100 * (1 - sums.peakImportKwh / sums.peakBaselineLoadKwh) : 0;
    t.filledSharePct = sums.loadKwh > 1e-9 ? (100 * sums.filledLoadKwh) / sums.loadKwh : 0;
    t.battCycles = usableKwh > 1e-9 ? sums.battOutKwh / usableKwh : 0;
    t.dedicatedClampPct = sums.slots > 0 ? (100 * sums.dedicatedClampSlots) / sums.slots : 0;
    return t;
}

/**
 * Annualise MonthRows: each additive quantity of calendar month-of-year m is scaled by
 * DIM[m]/Σ coveredDays of every row with that month-of-year (so a window starting mid-month,
 * with two partial Octobers, counts October once). Months with no data contribute 0.
 * @param {Array<Object>} monthly MonthRow[] (simulate().monthly)
 * @returns {Object} the additive Totals fields, annualised
 */
export function annualise(monthly) {
    const cov = new Float64Array(12);
    for (const r of monthly) cov[r.month0] += r.coveredDays;
    const out = zeroSums();
    for (const r of monthly) {
        const f = cov[r.month0] > 1e-9 ? DIM[r.month0] / cov[r.month0] : 0;
        for (const k of ADDITIVE) out[k] += (r[k] ?? 0) * f;
    }
    return out;
}

/**
 * Forward ex-VAT money by month-of-year, annualised to a full typical month — the shape
 * finance.project() takes as pvMonthly / battMonthly / standby.
 * @param {Array<Object>} monthly MonthRow[]
 * @returns {Array<{ impSavFwdExcP: number, expIncFwdP: number, standbyCostFwdExcP: number }>} length 12, by month0
 */
export function toMonthlyFwd(monthly) {
    const cov = new Float64Array(12);
    for (const r of monthly) cov[r.month0] += r.coveredDays;
    const out = Array.from({ length: 12 }, () => ({ impSavFwdExcP: 0, expIncFwdP: 0, standbyCostFwdExcP: 0 }));
    for (const r of monthly) {
        const f = cov[r.month0] > 1e-9 ? DIM[r.month0] / cov[r.month0] : 0;
        out[r.month0].impSavFwdExcP += r.impSavFwdExcP * f;
        out[r.month0].expIncFwdP += r.expIncFwdP * f;
        out[r.month0].standbyCostFwdExcP += r.standbyCostFwdExcP * f;
    }
    return out;
}

/**
 * Per-month difference a − b of MonthlyFwd arrays (marginal battery value = full run − PV-only run).
 * @param {Array<Object>} a
 * @param {Array<Object>} b
 * @returns {Array<Object>}
 */
export function diffMonthlyFwd(a, b) {
    return a.map((m, i) => ({
        impSavFwdExcP: m.impSavFwdExcP - (b?.[i]?.impSavFwdExcP ?? 0),
        expIncFwdP: m.expIncFwdP - (b?.[i]?.expIncFwdP ?? 0),
        standbyCostFwdExcP: m.standbyCostFwdExcP - (b?.[i]?.standbyCostFwdExcP ?? 0),
    }));
}

/** Price series for an export kind: as paid and forward. Missing series → zeros + warning. */
function exportSeries(ds, exp, n, warnings) {
    const kind = exp?.kind ?? 'none';
    if (kind === 'none') { const z = new Float64Array(n); return { paid: z, fwd: z }; }
    if (kind === 'flat') { const v = new Float64Array(n).fill(exp.flatP ?? 0); return { paid: v, fwd: v }; }
    const paid = ds.exportPrices?.[kind];
    const fwd = ds.exportPricesFwd?.[kind] ?? paid;
    if (!paid || !fwd) {
        warnings.push(`No ${kind} export prices in this dataset — export valued at 0p.`);
        const z = new Float64Array(n);
        return { paid: z, fwd: z };
    }
    return { paid, fwd };
}

/** importPriceFwdExc with fallbacks for hand-built datasets (tests). */
function forwardExc(ds) {
    if (ds.importPriceFwdExc) return ds.importPriceFwdExc;
    if (ds.importPriceExc) return ds.importPriceExc;
    const out = new Float64Array(ds.n);
    for (let t = 0; t < ds.n; t++) out[t] = ds.importPrice[t] / 1.05;
    return out;
}

/**
 * Simulate a system over a dataset.
 * @param {Object} ds Dataset (dataset.js)
 * @param {Object|null} pv PvSlots of the grid-tied arrays from pv.inverterAc (null = no grid-tied PV)
 * @param {Object} system System (normalised or partial)
 * @param {{ upsPvDc?: Float64Array|null, includeSlots?: boolean,
 *   dispatchOpts?: { deltaKwh?: number, N?: number, strategy?: string, soh?: number } }} [opts]
 *   upsPvDc = the power station's own-panel DC kWh per slot, already capped at its input limit
 *   (pv.dcToSlotsKwh); dispatchOpts tunes the battery run (δ = 0.05 for sweeps, N = 21 for bands)
 * @returns {Object} SimResult { totals, annual, monthly, profile, warnings, dispatch, slots? }.
 *   A power station's own panels are counted apart from the grid-tied ones: totals/MonthRow
 *   upsPvKwh and peakUpsPvKwh (its DC kWh, all day and 4–7pm), totals peakGenShareAllPct
 *   (4–7pm share of both), profile.upsPv (mean kWh per local half-hour) and slots.upsPv.
 * @throws {RangeError} when pv or upsPvDc arrays do not have ds.n slots
 */
export function simulate(ds, pv, system, { upsPvDc = null, includeSlots = false, dispatchOpts = {} } = {}) {
    const sys = normalizeSystem(system);
    const n = ds.n;
    const local = ds.local;
    const warnings = [];
    const pB = ds.importPrice;
    const pFwdExc = forwardExc(ds);
    const pD = new Float64Array(n);
    for (let t = 0; t < n; t++) pD[t] = pFwdExc[t] * 1.05;
    const { paid: xPaid, fwd: xFwd } = exportSeries(ds, sys.export, n, warnings);

    const adj = (sys.loadAdjustW * DT_H) / 1000;
    const L0 = ds.load;
    const L = new Float64Array(n);
    for (let t = 0; t < n; t++) L[t] = Math.max(0, L0[t] + adj);

    if (!pv && sys.arrays.length) warnings.push('No PV output was supplied for this system’s panels.');
    if (pv && !sys.arrays.length) {
        // cached PvSlots belong to some other system's arrays (a station-only or reference system has
        // no grid-tied panels); using them would credit solar this system does not have
        warnings.push('PV output was supplied for a system without grid-tied panels and was ignored.');
        pv = null;
    }
    for (const [name, arr] of [['pv.acKwh', pv?.acKwh], ['pv.dcInvKwh', pv?.dcInvKwh], ['pv.clippedDcKwh', pv?.clippedDcKwh], ['upsPvDc', upsPvDc]]) {
        // a short array would read undefined → NaN in every total; that is a caller bug, so fail loudly
        if (arr && arr.length !== n) throw new RangeError(`simulate: ${name} has ${arr.length} slots, the dataset has ${n}`);
    }
    const zero = new Float64Array(n);
    const pvAc = pv?.acKwh ?? zero;
    const dcRaw = pv?.dcRawKwh ?? zero;

    const bat = sys.battery;
    let D = null;
    let dedicatedW = 0;
    let outletCap = Infinity;
    if (bat?.coupling === 'ups') {
        dedicatedW = bat.ups.dedicatedW === 'baseload' ? estimateBaseLoad(ds).w : bat.ups.dedicatedW;
        outletCap = (bat.ups.outletMaxW * DT_H) / 1000;
        const dk = (dedicatedW * DT_H) / 1000;
        D = new Float64Array(n);
        for (let t = 0; t < n; t++) D[t] = Math.min(L[t], dk);
    }
    const inp = {
        n, load: L, pvAc, dcInvKwh: pv?.dcInvKwh ?? zero, clippedDcKwh: pv?.clippedDcKwh ?? zero, etaPv: pv?.etaPv ?? null,
        standbyKwh: pv?.standbyKwh ?? null, upsPvDc: bat?.coupling === 'ups' ? upsPvDc : null, dedicated: D,
        pD, xD: xFwd, local, acLimitW: sys.inverter?.acLimitW ?? Infinity, etaNom: sys.inverter?.etaNom ?? 0.96,
        canCurtail: sys.canCurtail && !!sys.inverter?.supportsPowerLimit,
    };
    const fl = bat ? dispatch(inp, bat, { baseLoadW: estimateBaseLoad(ds).w, ...dispatchOpts }) : noBatteryFlows(inp);
    warnings.push(...fl.warnings);
    const usable = bat ? fl.sMax - fl.sMin : 0;
    const wearPer = bat ? bat.wearPPerKwh * (bat.coupling === 'dc' ? bat.effDischarge : 1) : 0;
    const upsPv = inp.upsPvDc;

    // per calendar month accumulation. Local scalar accumulators, flushed once per month: ~37
    // read-modify-writes per slot on an object cost ~4 ms a run, which a 649-cell orientation sweep
    // would pay 649 times. The summation order is unchanged, so results are bit-identical.
    const months = local.months;
    const cov = monthCoverage(ds);
    const sums = months.map(() => zeroSums());
    const profN = new Uint16Array(48);
    const prof = { load: new Float64Array(48), pvAc: new Float64Array(48), upsPv: new Float64Array(48), imp: new Float64Array(48), exp: new Float64Array(48),
        battNet: new Float64Array(48), priceBilled: new Float64Array(48), savingsBilledP: new Float64Array(48) };
    const { imp: fImp, exp: fExp, pvDirectAc: fPvd, clipped: fClip, curtailed: fCurt, upsPvWasted: fWaste, gridChg: fGc, battIn: fIn,
        battOut: fOut, battOutAc: fOutAc, battChgAc: fChgAc, standby: fSb, upsConversionLoss: fConv, bypassOverhead: fByp } = fl;
    const filled = ds.loadFilled ?? null;
    const { peak, hh } = local;
    const dk = (dedicatedW * DT_H) / 1000 - 1e-12;
    const pLoad = prof.load, pPv = prof.pvAc, pUps = prof.upsPv, pImp = prof.imp, pExp = prof.exp, pBn = prof.battNet, pPr = prof.priceBilled, pSav = prof.savingsBilledP;
    for (let mi = 0; mi < months.length; mi++) {
        const t0 = months[mi].first;
        const t1 = Math.min(n, t0 + months[mi].count);
        let loadKwh = 0, baselineLoadKwh = 0, pvDcKwh = 0, upsPvKwh = 0, pvAcKwh = 0, pvDirectAcKwh = 0, clippedKwh = 0, curtailedKwh = 0;
        let upsPvWastedKwh = 0, exportKwh = 0, exportUnpaidKwh = 0, importKwh = 0, gridChargeKwh = 0, battInKwh = 0, battOutKwh = 0;
        let battOutAcKwh = 0, standbyKwh = 0, upsConversionLossKwh = 0, bypassOverheadKwh = 0, baselineBilledP = 0, newBilledP = 0;
        let savingsBilledP = 0, exportIncomeBilledP = 0, impSavFwdExcP = 0, expIncFwdP = 0, standbyCostFwdExcP = 0, wearP = 0;
        let savingsFilledP = 0, filledLoadKwh = 0, pvExportedKwh = 0, netImportKwh = 0, peakPvAcKwh = 0, peakUpsPvKwh = 0, peakImportKwh = 0;
        let peakBaselineLoadKwh = 0, dedicatedClampSlots = 0, upsOverloadSlots = 0;
        for (let t = t0; t < t1; t++) {
            const imp = fImp[t];
            const exp = fExp[t];
            const l0 = L0[t];
            const lt = L[t];
            const pb = pB[t];
            const pa = pvAc[t];
            const baseP = l0 * pb;
            const newP = imp * pb - exp * xPaid[t];
            const sav = baseP - newP;
            const up = upsPv ? upsPv[t] : 0;
            loadKwh += lt;
            baselineLoadKwh += l0;
            pvDcKwh += dcRaw[t] + up;
            upsPvKwh += up;
            pvAcKwh += pa;
            pvDirectAcKwh += fPvd[t];
            clippedKwh += fClip[t];
            curtailedKwh += fCurt[t];
            upsPvWastedKwh += fWaste[t];
            exportKwh += exp;
            if (xFwd[t] === 0) exportUnpaidKwh += exp;
            importKwh += imp;
            gridChargeKwh += fGc[t];
            battInKwh += fIn[t];
            battOutKwh += fOut[t];
            battOutAcKwh += fOutAc[t];
            standbyKwh += fSb[t];
            upsConversionLossKwh += fConv[t];
            bypassOverheadKwh += fByp[t];
            baselineBilledP += baseP;
            newBilledP += newP;
            savingsBilledP += sav;
            exportIncomeBilledP += exp * xPaid[t];
            impSavFwdExcP += (l0 - imp) * pFwdExc[t];
            expIncFwdP += exp * xFwd[t];
            standbyCostFwdExcP += fSb[t] * pFwdExc[t];
            wearP += fOut[t] * wearPer;
            if (filled && filled[t] !== 0) { savingsFilledP += sav; filledLoadKwh += lt; }
            pvExportedKwh += Math.min(exp, fPvd[t]);
            netImportKwh += imp - fGc[t];
            if (peak[t]) { peakPvAcKwh += pa; peakUpsPvKwh += up; peakImportKwh += imp; peakBaselineLoadKwh += l0; }
            if (D) {
                if (lt < dk) dedicatedClampSlots += 1;
                if (D[t] > outletCap + 1e-9) upsOverloadSlots += 1;
            }
            const h = hh[t];
            profN[h]++;
            pLoad[h] += lt;
            pPv[h] += pa;
            pUps[h] += up;
            pImp[h] += imp;
            pExp[h] += exp;
            pBn[h] += fOutAc[t] - fChgAc[t];
            pPr[h] += pb;
            pSav[h] += sav;
        }
        Object.assign(sums[mi], {
            loadKwh, baselineLoadKwh, pvDcKwh, upsPvKwh, pvAcKwh, pvDirectAcKwh, clippedKwh, curtailedKwh, upsPvWastedKwh, exportKwh,
            exportUnpaidKwh, importKwh, gridChargeKwh, battInKwh, battOutKwh, battOutAcKwh, standbyKwh, upsConversionLossKwh,
            bypassOverheadKwh, baselineBilledP, newBilledP, savingsBilledP, exportIncomeBilledP, impSavFwdExcP, expIncFwdP,
            standbyCostFwdExcP, wearP, savingsFilledP, filledLoadKwh, pvExportedKwh, netImportKwh, peakPvAcKwh, peakUpsPvKwh, peakImportKwh,
            peakBaselineLoadKwh, slots: t1 - t0, dedicatedClampSlots, upsOverloadSlots,
        });
    }
    for (const k of Object.keys(prof)) for (let h = 0; h < 48; h++) prof[k][h] = profN[h] ? prof[k][h] / profN[h] : 0;

    const monthly = months.map((m, i) => ({ key: m.key, month0: m.month0, coveredDays: cov.coveredDays[i], dim: m.dim, ...sums[i] }));
    const total = zeroSums();
    for (const s of sums) for (const k of ADDITIVE) total[k] += s[k];
    const totals = finishTotals(total, n / 48, usable);
    const annual = finishTotals(annualise(monthly), 365, usable);
    for (const T of [totals, annual]) T.dedicatedW = dedicatedW;

    const thin = [];
    for (let m0 = 0; m0 < 12; m0++) if (cov.coveredByMonth0[m0] < 7) thin.push(m0);
    if (thin.length) warnings.push(`Needs 12 months of usage data: ${thin.length} calendar month(s) have under 7 days, so annual figures are incomplete.`);
    if (totals.filledSharePct > 5) {
        warnings.push(`Savings include ${Math.round(total.filledLoadKwh > 0 ? (totals.filledSharePct / 100) * totals.days : 0)} days of estimated usage.`);
    }
    if (D && totals.dedicatedClampPct > 5) {
        warnings.push(`Your dedicated load (${Math.round(dedicatedW)} W) is above your whole-house use in ${Math.round(totals.dedicatedClampPct)}% of half-hours — it is probably set too high.`);
    }

    const res = {
        totals, annual, monthly, profile: prof, warnings,
        dispatch: { strategy: fl.strategy, N: fl.N, dE: fl.dE, sMin: fl.sMin, sMax: fl.sMax, costP: fl.costP,
            wearP: fl.wearP, objectiveP: fl.objectiveP, cycles: fl.cycles, upsOverloadSlots: fl.upsOverloadSlots },
    };
    if (includeSlots) {
        const { warnings: _w, ...arrays } = fl;
        res.slots = { ...arrays, pvAc, upsPv: upsPv ?? zero, load: L };
    }
    return res;
}
