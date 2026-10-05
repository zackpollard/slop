/*
 * finance.js — lifetime cash flows of a purchase from one simulated year.
 *
 * Year 1 is the 12 months from the install date (default 1 Nov 2026). Each ownership month takes
 * the forward ex-VAT savings of the same calendar month (simulate.toMonthlyFwd) and applies the
 * VAT in force on that date — 0% until 31 Mar 2027, then 5% unless the user says it stays at 0% —
 * because historical slots were billed at 5% and export income is never VAT'd, so a blanket VAT
 * ratio would be wrong whenever export is paid.
 *
 * PV fades mid-year per pv-reference degradationFactor (first-year LID is 0 by default because the
 * 5.9% DC loss stack already has lid 1%). A battery fades linearly with calendar and cycle ageing
 * and stops at 70% SoH or its life; its standby draw is not faded (it is a fixed cost while the
 * battery exists), so the battery term is (Sav_batt + standby)·SoH_mid − standby.
 */

import { DEFAULT_VAT_SCHEDULE, vatAt } from './vat.js';

/** Defaults (CONTRACTS §12), plus dcInverterOnBatteryEol (see project()). */
export const DEFAULT_FINANCE = Object.freeze({
    installDate: '2026-11-01', years: 20, discountRate: 0.04, escalation: 0.02,
    vatSchedule: DEFAULT_VAT_SCHEDULE, vatReturns: true, pvAnnualDeg: 0.004, pvFirstYearDeg: 0,
    microReplaceYear: 12, microReplaceGbp: 150, batteryCalendarFade: 0.015, batteryEolSoh: 0.7,
    replaceBattery: false, omGbpPerYear: 0,
    // A dc-coupled all-in-one unit is also the PV inverter: when its battery dies, PV only keeps
    // earning if a plain micro-inverter (microReplaceGbp) replaces it the next year.
    dcInverterOnBatteryEol: true,
});

const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const finite = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const clampNum = (v, def, lo, hi) => Math.min(hi, Math.max(lo, finite(v, def)));

/**
 * Merge user finance settings over the defaults. Settings come from a form/store, so a cleared
 * field arrives as undefined, '' or NaN: `{ ...DEFAULT_FINANCE, ...opts }` would then turn one
 * blank box into NaN in every year. Each field falls back to its default and is kept in a range
 * where the formulas stay finite (a discount rate of −100% divides by zero).
 * @param {Object} [opts] Partial<DEFAULT_FINANCE>
 * @returns {Object} complete, finite finance options
 */
export function financeOptions(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const d = DEFAULT_FINANCE;
    const date = typeof o.installDate === 'string' && /^\d{4}-(0[1-9]|1[0-2])/.test(o.installDate) ? o.installDate : d.installDate;
    const sch = Array.isArray(o.vatSchedule) && o.vatSchedule.length && o.vatSchedule.every((e) => e && typeof e.rate === 'number' && Number.isFinite(e.rate))
        ? o.vatSchedule : d.vatSchedule;
    return {
        installDate: date,
        years: Math.round(clampNum(o.years, d.years, 1, 60)),
        discountRate: clampNum(o.discountRate, d.discountRate, -0.5, 1),
        escalation: clampNum(o.escalation, d.escalation, -0.5, 1),
        vatSchedule: sch,
        vatReturns: typeof o.vatReturns === 'boolean' ? o.vatReturns : d.vatReturns,
        pvAnnualDeg: clampNum(o.pvAnnualDeg, d.pvAnnualDeg, 0, 0.5),
        pvFirstYearDeg: clampNum(o.pvFirstYearDeg, d.pvFirstYearDeg, 0, 0.5),
        microReplaceYear: Math.round(clampNum(o.microReplaceYear, d.microReplaceYear, 0, 100)),
        microReplaceGbp: clampNum(o.microReplaceGbp, d.microReplaceGbp, 0, 1e6),
        batteryCalendarFade: clampNum(o.batteryCalendarFade, d.batteryCalendarFade, 0, 1),
        batteryEolSoh: clampNum(o.batteryEolSoh, d.batteryEolSoh, 0, 0.99),
        replaceBattery: typeof o.replaceBattery === 'boolean' ? o.replaceBattery : d.replaceBattery,
        omGbpPerYear: clampNum(o.omGbpPerYear, d.omGbpPerYear, -1e6, 1e6),
        dcInverterOnBatteryEol: typeof o.dcInverterOnBatteryEol === 'boolean' ? o.dcInverterOnBatteryEol : d.dcInverterOnBatteryEol,
    };
}

/**
 * PV output factor in ownership year y (mid-year): pv-reference degradationFactor(y−1, firstYear, annual).
 * firstYear 0 → y1 1.00000, y2 0.99800, y10 0.96651, y20 0.92853.
 * @param {number} y ownership year (1-based)
 * @param {number} [firstYear]
 * @param {number} [annual]
 * @returns {number}
 */
export function pvDegradation(y, firstYear = 0, annual = 0.004) {
    const n = y - 1;
    return n <= 0 ? 1 - firstYear / 2 : (1 - firstYear) * (1 - annual) ** (n - 0.5);
}

/**
 * Battery state of health and end-of-life year.
 * SoH_end(a) = 1 − (aCal + bCyc·EFC)·a, SoH_mid(a) = 1 − (aCal + bCyc·EFC)·(a − 0.5), bCyc = (1 − eol)/cycles;
 * the battery serves ages a ≤ a* = min(life, last a with SoH_end(a − 1) ≥ eol).
 * @param {{ efcPerYear?: number, cycles?: number, lifeYears?: number }} battery
 * @param {{ batteryCalendarFade?: number, batteryEolSoh?: number }} [o]
 * @returns {{ rate: number, sohMid: (a: number) => number, sohEnd: (a: number) => number, endAge: number }}
 */
export function batteryHealth(battery, o = DEFAULT_FINANCE) {
    const eol = finite(o.batteryEolSoh, 0.7);
    const bCyc = (1 - eol) / (finite(battery?.cycles, 0) > 0 ? battery.cycles : 6000);
    const rate = finite(o.batteryCalendarFade, 0.015) + bCyc * Math.max(0, finite(battery?.efcPerYear, 0));
    const life = finite(battery?.lifeYears, 15);
    const byFade = rate > 0 ? Math.floor(1 + (1 - eol) / rate + 1e-9) : Infinity;
    return {
        rate,
        sohMid: (a) => 1 - rate * (a - 0.5),
        sohEnd: (a) => 1 - rate * a,
        // whole years of service: a fractional end age would index the yearly arrays at x.5
        endAge: Math.max(0, Math.floor(Math.min(life, byFade))),
    };
}

/**
 * NPV of cash flows CF_0..CF_Y (CF_y at the end of year y).
 * @param {number[]} cashFlows
 * @param {number} r
 * @returns {number}
 */
export function npv(cashFlows, r) {
    let s = 0;
    for (let y = 0; y < cashFlows.length; y++) s += cashFlows[y] / (1 + r) ** y;
    return s;
}

/**
 * IRR by bisection on [−0.99, 1]; null when NPV has the same sign at both ends (no bracket —
 * replacement outflows can also create several roots, so we never extrapolate). A cheap kit
 * that pays back in months has an IRR above 100%: when NPV is still positive at 100% (and
 * negative only at higher rates) the upper end is widened to 1000% rather than reporting "n/a"
 * for the best investment on the page.
 * @param {number[]} cashFlows
 * @returns {number|null}
 */
export function irr(cashFlows) {
    let lo = -0.99;
    let hi = 1;
    let flo = npv(cashFlows, lo);
    let fhi = npv(cashFlows, hi);
    if (Number.isFinite(flo) && fhi > 0 && flo > 0 && npv(cashFlows, 10) < 0) {
        lo = hi;
        flo = fhi;
        hi = 10;
        fhi = npv(cashFlows, hi);
    }
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
    if (flo === 0) return lo;
    if (fhi === 0) return hi;
    for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
        const mid = 0.5 * (lo + hi);
        const fm = npv(cashFlows, mid);
        if (fm === 0) return mid;
        if (flo * fm < 0) hi = mid;
        else { lo = mid; flo = fm; }
    }
    return 0.5 * (lo + hi);
}

/**
 * Years until the cumulative cash flow first reaches 0, interpolated within the crossing year:
 * y − 1 + (−cum_{y−1})/CF_y. null if it never does. Pass discounted flows for discounted payback.
 * @param {number[]} cashFlows CF_0..CF_Y
 * @returns {number|null}
 */
export function paybackYears(cashFlows) {
    let cum = cashFlows[0] ?? 0;
    if (cum >= 0) return 0;
    for (let y = 1; y < cashFlows.length; y++) {
        const next = cum + cashFlows[y];
        if (next >= 0 && cashFlows[y] > 0) return y - 1 + -cum / cashFlows[y];
        cum = next;
    }
    return null;
}

/** "VAT stays at 0%": every rate from the first 0% period onwards becomes 0. */
function scheduleFor(o) {
    const sch = o.vatSchedule ?? DEFAULT_VAT_SCHEDULE;
    if (o.vatReturns !== false) return sch;
    const i = sch.findIndex((e) => e.rate === 0);
    if (i < 0) return sch;
    return sch.map((e, j) => (j >= i ? { untilMs: e.untilMs, rate: 0 } : e));
}

/** Annual standby cost (exc VAT) per month-of-year, from a number or a 12-array. */
function standbyByMonth(v) {
    if (Array.isArray(v) || ArrayBuffer.isView(v)) {
        return Array.from({ length: 12 }, (_, m) => {
            const e = v[m];
            return typeof e === 'number' ? e : e?.standbyCostFwdExcP ?? 0;
        });
    }
    const a = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    return DIM.map((d) => (a * d) / 365);
}

const parseInstall = (s) => {
    const m = /^(\d{4})-(\d{2})/.exec(String(s ?? ''));
    return m ? { y: Number(m[1]), m0: Number(m[2]) - 1 } : { y: 2026, m0: 10 };
};

const val = (m, k) => (m && Number.isFinite(m[k]) ? m[k] : 0);

/**
 * Project lifetime cash flows.
 * @param {Object} a
 * @param {Array<{ label?: string, gbp: number, year?: number }>} a.costs year-0 capex and later purchases (year = y)
 * @param {Array<{ impSavFwdExcP: number, expIncFwdP: number }>} a.pvMonthly MonthlyFwd (12, by month0) of the
 *   system WITHOUT its battery (same arrays, inverter, export and canCurtail)
 * @param {Array<Object>|null} [a.battMonthly] marginal MonthlyFwd: full system − pvMonthly
 * @param {number|Array} [a.standbyCostFwdP] battery standby cost, forward basis EXC VAT, annualised
 *   (simulate annual.standbyCostFwdExcP of the full run minus the PV-only run), or a 12-array by month0
 * @param {{ coupling: string, efcPerYear: number, cycles?: number, lifeYears?: number, capexGbp?: number }|null} [a.battery]
 * @param {boolean} [a.hasMicro] a separate micro-inverter that needs replacing in microReplaceYear
 * @param {{ atYear: number, costs: Array, stage2PvMonthly?: Array, stage2BattMonthly?: Array, battery?: Object,
 *   standbyCostFwdP?: number|Array }|null} [a.upgrade] bought at the end of year atYear; stage-2 savings from
 *   atYear+1; a stage-2 battery's ageing clock starts at atYear
 * @param {{ pvAcKwh?: number, battOutAcKwh?: number, stage2PvAcKwh?: number, stage2BattOutAcKwh?: number }} [a.energy]
 *   annual kWh for LCOE/LCOS (null outputs when absent)
 * @param {Object} [a.opts] Partial<DEFAULT_FINANCE>
 * @returns {Object} Finance (CONTRACTS §12); money in £, years rows include y = 0
 */
export function project({ costs = [], pvMonthly, battMonthly = null, standbyCostFwdP = 0, battery = null,
    hasMicro = true, upgrade = null, energy = {}, opts = DEFAULT_FINANCE } = {}) {
    const o = financeOptions(opts);
    const en = energy && typeof energy === 'object' ? energy : {};
    const Y = o.years;
    const r = o.discountRate;
    const e = o.escalation;
    const sch = scheduleFor(o);
    const { y: y0, m0: mStart } = parseInstall(o.installDate);
    const flags = [];

    // a typed array silently drops a fractional or NaN index, so every year is rounded and checked
    const costAt = new Float64Array(Y + 1);
    for (const c of Array.isArray(costs) ? costs : []) {
        const y = Math.round(finite(c?.year, 0));
        if (y >= 0 && y <= Y) costAt[y] += finite(c?.gbp, 0);
    }
    const capex = costAt[0];
    const atYear = upgrade ? Math.round(finite(upgrade.atYear, Infinity)) : Infinity;
    const up = upgrade && atYear >= 1 && atYear <= Y ? { ...upgrade, atYear } : null;
    if (upgrade && !up) flags.push('upgradeBeyondHorizon');
    if (up) for (const c of Array.isArray(up.costs) ? up.costs : []) {
        const y = up.atYear + Math.max(0, Math.round(finite(c?.year, 0)));
        if (y <= Y) costAt[y] += finite(c?.gbp, 0);
    }

    const bh = battery && battMonthly ? batteryHealth(battery, o) : null;
    if (battMonthly && !battery) flags.push('batteryWithoutAgeing');
    const bat2 = up && up.stage2BattMonthly ? (up.battery ?? battery) : null;
    const bh2 = bat2 ? batteryHealth(bat2, o) : null;
    const sb1 = standbyByMonth(standbyCostFwdP);
    const sb2 = standbyByMonth(up?.standbyCostFwdP ?? standbyCostFwdP);
    const isDc = battery?.coupling === 'dc' && !!bh;
    const battCapex = Math.max(0, finite(battery?.capexGbp, 0));
    if (o.replaceBattery && bh && !(battCapex > 0)) flags.push('missingBatteryCapex');

    // replacement outlays: R_pv (inverters) and R_batt, nominal £ in CF_y
    const rPv = new Float64Array(Y + 2);
    const rBatt = new Float64Array(Y + 2);
    let pvStopsAfter = Infinity;
    let batteryEndYear = null;
    if (bh) {
        batteryEndYear = bh.endAge;
        if (o.replaceBattery) {
            for (let y = bh.endAge + 1; y <= Y && bh.endAge > 0; y += bh.endAge) rBatt[y] += battCapex;
            if (bh.endAge < Y) flags.push('batteryReplaced');
        } else if (isDc && bh.endAge < Y) {
            if (o.dcInverterOnBatteryEol) rPv[bh.endAge + 1] += o.microReplaceGbp;
            else { pvStopsAfter = bh.endAge; flags.push('pvStopsWithBattery'); }
        }
    }
    if (hasMicro && !isDc && o.microReplaceYear >= 1 && o.microReplaceYear <= Y) rPv[o.microReplaceYear] += o.microReplaceGbp;

    /** Battery age in ownership year y for the stage-1 battery (handles replacement), 0 = none. */
    const age1 = (y) => {
        if (!bh || bh.endAge <= 0) return 0;
        if (!o.replaceBattery) return y <= bh.endAge ? y : 0;
        return ((y - 1) % bh.endAge) + 1;
    };
    const age2 = (y) => {
        if (!bh2 || bh2.endAge <= 0) return 0;
        const a = y - up.atYear;
        if (!o.replaceBattery) return a <= bh2.endAge ? a : 0;
        return ((a - 1) % bh2.endAge) + 1;
    };

    const rows = [{ y: 0, pvGbp: 0, battGbp: 0, savingsGbp: 0, outlayGbp: capex, cashFlowGbp: -capex, cumulativeGbp: -capex, discountedCumulativeGbp: -capex, soh: null }];
    const cf = [-capex];
    const cfDisc = [-capex];
    let cum = -capex;
    let dcum = -capex;
    let lcoeNum = Math.max(0, capex - battCapex);
    let lcoeDen = 0;
    let lcosNum = battCapex;
    let lcosDen = 0;
    for (let y = 1; y <= Y; y++) {
        const stage2 = !!up && y > up.atYear;
        // a stage without its own series keeps the stage-1 one (a battery-only upgrade leaves PV as it was)
        const pvM = stage2 ? up.stage2PvMonthly ?? pvMonthly : pvMonthly;
        const bM = stage2 ? up.stage2BattMonthly ?? battMonthly : battMonthly;
        const sb = stage2 ? sb2 : sb1;
        const age = stage2 ? (up.stage2BattMonthly && up.battery ? age2(y) : bM ? age1(y) : 0) : age1(y);
        const health = stage2 && up.battery && up.stage2BattMonthly ? bh2 : bh;
        const soh = bM && health && age > 0 ? health.sohMid(age) : bM && !health ? 1 : 0;
        const kPv = y > pvStopsAfter ? 0 : pvDegradation(y, o.pvFirstYearDeg, o.pvAnnualDeg);
        let pvP = 0;
        let battP = 0;
        let sbP = 0;
        for (let k = 0; k < 12; k++) {
            const idx = mStart + (y - 1) * 12 + k;
            const year = y0 + Math.floor(idx / 12);
            const m0 = idx % 12;
            const v = 1 + vatAt(Date.UTC(year, m0, 15, 12), sch);
            pvP += val(pvM?.[m0], 'impSavFwdExcP') * v + val(pvM?.[m0], 'expIncFwdP');
            if (bM && soh > 0) {
                const gross = val(bM[m0], 'impSavFwdExcP') * v + val(bM[m0], 'expIncFwdP');
                const sbm = (sb[m0] ?? 0) * v;
                battP += (gross + sbm) * soh - sbm;
                sbP += sbm;
            }
        }
        const esc = (1 + e) ** (y - 1);
        const pvGbp = (kPv * pvP * esc) / 100;
        const battGbp = (battP * esc) / 100;
        const savingsGbp = pvGbp + battGbp;
        const outlay = costAt[y] + rPv[y] + rBatt[y] + o.omGbpPerYear;
        const cfy = savingsGbp - outlay;
        const disc = (1 + r) ** -y;
        cum += cfy;
        dcum += cfy * disc;
        cf.push(cfy);
        cfDisc.push(cfy * disc);
        rows.push({ y, pvGbp, battGbp, savingsGbp, outlayGbp: outlay, cashFlowGbp: cfy, cumulativeGbp: cum, discountedCumulativeGbp: dcum, soh: bM && soh > 0 ? soh : null });
        const pvKwh = stage2 ? en.stage2PvAcKwh ?? en.pvAcKwh : en.pvAcKwh;
        lcoeNum += (rPv[y] + o.omGbpPerYear) * disc;
        lcoeDen += Math.max(0, finite(pvKwh, 0)) * kPv * disc;
        if (soh > 0) {
            const bk = stage2 ? en.stage2BattOutAcKwh ?? en.battOutAcKwh : en.battOutAcKwh;
            lcosNum += (rBatt[y] + (sbP * esc) / 100) * disc;
            lcosDen += Math.max(0, finite(bk, 0)) * soh * disc;
        }
    }

    const payback = paybackYears(cf);
    if (payback !== null) {
        let c = 0;
        let crossed = false;
        for (let y = 0; y < cf.length; y++) {
            c += cf[y];
            if (c >= 0) crossed = true;
            else if (crossed) { flags.push('paybackReverts'); break; }
        }
    }
    const rate = irr(cf);
    if (rate === null && capex > 0) flags.push('noIrrBracket');
    let sum10 = 0;
    let npv10 = -capex;
    for (let y = 1; y <= Math.min(10, Y); y++) { sum10 += cf[y]; npv10 += cf[y] / (1 + r) ** y; }
    const total = cf.reduce((a, b) => a + b, 0);
    return {
        capexGbp: capex,
        year1Gbp: rows[1].savingsGbp,
        years: rows,
        paybackYears: payback,
        discountedPaybackYears: paybackYears(cfDisc),
        npvGbp: npv(cf, r),
        npv10Gbp: npv10,
        net10Gbp: sum10 - capex,
        irr: rate,
        roiPct: capex > 0 ? (100 * total) / capex : null,
        lcoePPerKwh: lcoeDen > 1e-9 ? (100 * lcoeNum) / lcoeDen : null,
        lcosPPerKwh: bh && lcosDen > 1e-9 ? (100 * lcosNum) / lcosDen : null,
        batteryEndYear,
        flags,
    };
}
