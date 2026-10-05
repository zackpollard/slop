/*
 * core.js — SolarEngine: one Dataset + the catalog → every number the app shows (CONTRACTS §13).
 *
 * The expensive physics is cached in layers that match what actually changes it:
 *   geometry       per sub-step count (sun positions; weather- and orientation-free)
 *   sky            per (sub-steps, weather basis): 'actual' = the dataset's own sunshine,
 *                  'typical' = each local month scaled to its 2006–2025 SARAH-3 mean (weather.js
 *                  typicalMonthScale) — the headline basis everywhere (UX critique)
 *   DC             per (sub-steps, basis, arrayKey)
 *   PvSlots        per (sub-steps, basis, inverter, input wiring)
 *   results        per (systemKey, finance, projected base load, options)
 * Load never enters a PV cache, so projecting a different always-on load (setProjectBaseW) or
 * sweeping base load re-runs only dispatch and valuation.
 *
 * Money conventions: every "£/yr" this module reports for a system is its first ownership year
 * (finance.js: the 12 months from the install date, VAT 0% until 31 Mar 2027 then 5%, export
 * never VAT'd). Battery value is always marginal: the same arrays/inverter/export/curtailment with
 * the battery removed (engine critique).
 *
 * Pure module (worker-safe): no DOM, no fetch.
 */

import { prepareGeometry, prepareSky, arrayKey, arrayDcW, dcByInput, inverterAc, dcToSlotsKwh, scaleDcByMonth } from './pv.js';
import { typicalMonthScale } from './weather.js';
import { summarize, withBaseLoad } from './dataset.js';
import { analyseUsage, estimateBaseLoad } from './insights.js';
import { normalizeSystem, systemKey, upgradedSystem, pointArray, DEFAULTS } from './system.js';
import { simulate, toMonthlyFwd, diffMonthlyFwd } from './simulate.js';
import { project, financeOptions, pvDegradation } from './finance.js';
import { vatAt, DEFAULT_VAT_SCHEDULE } from './vat.js';
import { localParts, daysInMonth } from './time.js';
import { validate as validateRules, applyFix as applyRulesFix } from './rules.js';
import { findProduct, pluginKits, kitToSystem, orientationForSpot, SERVER_HOLDUP_MS } from './kits.js';
import { autoScenariosSteps as buildScenariosSteps, DEFAULT_SPOTS } from './scenarios.js';
import { orientationGrid, gridAxes, sweepCellsSteps, runSteps, runStepsAsync, bestBy, restrict, neighbours, tieBox, percentile, azDiff, compass16 } from './sweep.js';

/** Sub-samples per half-hour at full fidelity and for proxies (SPEC: 3 headline, 1 for sweeps). */
const FULL_SUB = 3;
const PROXY_SUB = 1;
/** SoC step for curves and sweeps (engine critique: 0.05 kWh; headline 0.025). */
const COARSE = Object.freeze({ deltaKwh: 0.05 });
/**
 * The weather band re-runs dispatch 20 times. Rule strategies don't use the SoC grid; an
 * optimiser does, and at δ 0.05 (N ≥ 41) 20 years cost ~0.8 s for a 2 kWh battery, so the band's
 * optimiser runs at N = 21 (UX critique band setting) — it sets the spread, the headline keeps δ 0.025.
 */
const BAND_DP = Object.freeze({ N: 21 });
const DP_STRATEGIES = new Set(['optimal', 'smart', 'online']);
const usesDp = (b) => !!b && (DP_STRATEGIES.has(b.strategy) || (b.coupling === 'ups' && b.ups?.bypass === 'disabled'));

const PROXY_NOTE = 'Map: panels only, no battery. Starred points: full simulation including your battery.';

/** The heavy methods with a step form (callAsync): method → its step generator. */
const STEPPED = Object.freeze({
    runScenario: '_runScenarioSteps',
    autoScenarios: '_autoScenariosSteps',
    orientationSweep: '_orientationSweepSteps',
    answerOrientation: '_answerOrientationSteps',
    placementCells: '_placementSteps',
    baseLoadCurve: '_baseLoadCurveSteps',
    tornado: '_tornadoSteps',
});
export const STEPPED_METHODS = Object.freeze(Object.keys(STEPPED));

/** Base-load curve x values (W) before the user's own base and recent base are added (UX critique). */
const BASE_XS = [0, 100, 200, 300, 400, 500, 600, 800, 1000, 1200, 1500];

/** A month is "dark after 4pm" when a west wall makes under this % of its output 4–7pm (Orientation's DARK_PCT). */
export const DARK_PCT = 5;

/**
 * Pence saved per kWh of solar made — the one definition Design and Compare show. With a battery
 * the headline saving also holds what it earns charging in cheap half-hours (and loses on
 * standby), which isn't the solar's doing: count the panels alone (battery.baseGbp) plus the
 * battery's storing-solar share instead. Without the battery split (no battery, or a proxy run)
 * it is the headline saving ÷ kWh made. null when the system makes (almost) nothing.
 * @param {{ headline?: { savingsGbp: number, pvKwh: number }, battery?: { baseGbp: number, split?: { fromSolarGbp: number } } }|null} res
 * @returns {number|null}
 */
export function pvValuePPerKwh(res) {
    const hl = res?.headline;
    if (!hl || !Number.isFinite(hl.pvKwh) || !(hl.pvKwh > 1)) return null;
    const b = res.battery;
    const gbp = b && Number.isFinite(b.baseGbp) ? b.baseGbp + Math.max(0, b.split?.fromSolarGbp ?? 0) : hl.savingsGbp;
    return Number.isFinite(gbp) ? (100 * gbp) / hl.pvKwh : null;
}

/**
 * Month-of-year share (%) of a run's output made 4–7pm: the grid-tied panels', or with station
 * true a power station's own panels' (upsPvKwh). null where a month makes nothing. The same sums
 * as Orientation's monthly chart (views/orientation.js monthlyPeakShare).
 * @param {Array<{ month0: number, pvAcKwh: number, peakPvAcKwh: number, upsPvKwh: number, peakUpsPvKwh: number }>} monthly SimResult.monthly
 * @param {boolean} [station]
 * @returns {Array<number|null>} 12 values, January first
 */
export function monthlyPeakSharePct(monthly, station = false) {
    const pv = new Float64Array(12);
    const pk = new Float64Array(12);
    const [all, peak] = station ? ['upsPvKwh', 'peakUpsPvKwh'] : ['pvAcKwh', 'peakPvAcKwh'];
    for (const m of monthly ?? []) {
        if (!Number.isInteger(m?.month0) || m.month0 < 0 || m.month0 > 11) continue;
        pv[m.month0] += m[all] || 0;
        pk[m.month0] += m[peak] || 0;
    }
    return Array.from(pv, (v, i) => (v > 1e-6 ? (100 * pk[i]) / v : null));
}

/**
 * The longest run of months around December (Oct–Mar only) where the 4–7pm share stays under
 * `below` % — "from November to January there's little or no sun after 4pm" comes from this, not
 * a fixed list. Orientation's darkMonths rule (views/orientation.js), so both tabs name the same months.
 * @param {Array<number|null>} share 12 monthly shares (null/NaN = nothing made, which counts as dark)
 * @param {number} [below]
 * @returns {number[]} month indices in calendar order through the year end, e.g. [10, 11, 0]
 */
export function darkMonths(share, below = DARK_PCT) {
    const dark = (i) => !Number.isFinite(share?.[i]) || share[i] < below;
    if (!dark(11)) return [];
    const run = [11];
    for (const i of [10, 9]) { if (dark(i)) run.unshift(i); else break; }
    for (const i of [0, 1, 2]) { if (dark(i)) run.push(i); else break; }
    return run;
}

/** C1's lower always-on load (W), and how far above it today's load must be for C1 to be "lower". */
const FLIP_LOW_LOAD_W = 150;
const FLIP_LOAD_MARGIN_W = 50;

/** Flip conditions for the orientation answer (UX critique answers.orientation). */
const FLIP_TEXT = {
    C1: 'your always-on load were ~150 W and you had Outgoing Prime',
    C2: 'you had Outgoing Prime',
    C3: 'you had 2000 W of panels on the 800 W inverter (no such kit is on sale yet)',
    C4: 'you add a battery',
};

/** Small LRU: the DC and PvSlots caches would otherwise grow without bound during sweeps and curves. */
class Lru {
    constructor(max) { this.max = max; this.m = new Map(); }
    get(k) {
        if (!this.m.has(k)) return undefined;
        const v = this.m.get(k);
        this.m.delete(k);
        this.m.set(k, v);
        return v;
    }
    set(k, v) {
        this.m.delete(k);
        this.m.set(k, v);
        while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
        return v;
    }
    clear() { this.m.clear(); }
}

/** Deterministic JSON (sorted keys, non-finite → null) for cache keys. */
function stable(v) {
    if (v === null || typeof v !== 'object') {
        if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
        return v === undefined ? 'null' : JSON.stringify(v);
    }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return '[' + Array.from(v, stable).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

/** The 1st of next month on the UK calendar (at 00:30 BST on 1 Oct it is October here, not September). */
const firstOfNextMonth = (ms) => {
    const { year, month } = localParts(ms);
    const y = year + (month === 12 ? 1 : 0);
    const m = month === 12 ? 1 : month + 1;
    return `${y}-${String(m).padStart(2, '0')}-01`;
};

/**
 * Cache key of everything that changes a simulation (systemKey minus what only labels or prices
 * it), so kits with identical physics share proxy runs. Curtailment, export, load adjustment and
 * the inverter's power-limit flag are physics here: a key built from the PV path alone served one
 * kit's placement to another with a different canCurtail.
 */
const physicsKey = (sys) => systemKey({ ...sys, costs: [], kitId: null, sourceIds: [], spotId: null, upgrade: null, route: 'plugin' });

/**
 * The power-station product of a system with a 'ups' battery, found by kind: a U row is built
 * around it (its kitId), C1 adds one to a plug-in kit (one of its sourceIds) and a Design build
 * may carry it in sourceIds only. null when there is none in the catalog.
 */
function stationProduct(catalog, sys) {
    if (sys.battery?.coupling !== 'ups') return null;
    for (const id of [sys.kitId, ...(sys.sourceIds ?? [])]) {
        const p = typeof id === 'string' ? findProduct(catalog, id) : null;
        if (p?.kind === 'power-station') return p;
    }
    return null;
}

const hasStationPanels = (sys) => sys.battery?.coupling === 'ups' && sys.battery.ups.pvArrays.some((a) => a.count * a.wp > 0);
const weatherDependent = (sys) => sys.arrays.some((a) => a.count * a.wp > 0) || hasStationPanels(sys);
/** True when the targeted panels do not all face the same way (a split kit such as S02). */
const mixedTarget = (sys, tg) => {
    if (tg.index >= 0) return false;
    const list = tg.station ? sys.battery.ups.pvArrays : sys.arrays;
    return list.some((a) => a.azimuth !== tg.ref.azimuth || a.tilt !== tg.ref.tilt);
};
const withStrategy = (sys, strategy) => ({ ...sys, battery: sys.battery ? { ...sys.battery, strategy } : null });

/** The battery with grid charging switched off (the "from solar only" counterfactual of the split). */
function noGridCharge(sys) {
    const b = sys.battery;
    if (!b) return sys;
    if (b.coupling === 'ups') return { ...sys, battery: { ...b, ups: { ...b.ups, chargeW: 0 } } };
    return { ...sys, battery: { ...b, acChargeW: 0 } };
}

/** a − b of two _money() outputs (stage 2 included): the per-month money and the annual scalars. */
function moneyDelta(a, b) {
    const dm = (x, y) => (x && y ? diffMonthlyFwd(x, y) : null);
    const one = (x, y) => ({ pvM: dm(x.pvM, y.pvM), battM: dm(x.battM, y.battM), cycles: x.cycles - y.cycles,
        pvAcKwh: x.pvAcKwh - y.pvAcKwh, battOutAcKwh: x.battOutAcKwh - y.battOutAcKwh });
    return { ...one(a, b), s2: a.s2 && b.s2 ? one(a.s2, b.s2) : null };
}

/** _money() output shifted by a moneyDelta (cycles and battery output never below 0). */
function anchorMoney(m, d) {
    const add = (x, y) => (x && y ? x.map((v, i) => ({
        impSavFwdExcP: v.impSavFwdExcP + y[i].impSavFwdExcP,
        expIncFwdP: v.expIncFwdP + y[i].expIncFwdP,
        standbyCostFwdExcP: v.standbyCostFwdExcP + y[i].standbyCostFwdExcP,
    })) : x);
    const one = (x, y) => ({ ...x, pvM: add(x.pvM, y.pvM), battM: add(x.battM, y.battM), cycles: Math.max(0, x.cycles + y.cycles),
        pvAcKwh: Math.max(0, x.pvAcKwh + y.pvAcKwh), battOutAcKwh: Math.max(0, x.battOutAcKwh + y.battOutAcKwh) });
    const out = one(m, d);
    out.s2 = m.s2 && d.s2 ? one(m.s2, d.s2) : m.s2;
    return out;
}

/**
 * The SolarEngine (CONTRACTS §13). Construct once per Dataset; every method is synchronous and
 * returns plain structured-clone data.
 */
export class SolarEngine {
    /**
     * @param {Object} ds Dataset (dataset.js)
     * @param {Object} catalog normalised catalog (kits.normalizeCatalog)
     * @param {{ nowMs?: number }} [opts] nowMs fixes "today" (default install date = 1st of next month)
     */
    constructor(ds, catalog, { nowMs = Date.now() } = {}) {
        if (!ds || !(ds.n > 0)) throw new Error('SolarEngine needs a dataset');
        this.ds0 = ds;
        this.ds = ds;
        this.catalog = catalog ?? { kits: [], stations: [], bundles: [], constants: {} };
        this.projectBaseW = null;
        this.defaultInstallDate = firstOfNextMonth(nowMs);
        this.spots = DEFAULT_SPOTS.map((s) => ({ ...s }));
        this._geom = new Map();
        this._sky = new Map();
        this._dc = new Lru(96);
        this._pv = new Lru(40);
        this._upsPv = new Lru(24);
        this._results = new Lru(200);
        this._slotResults = new Lru(4);
        this._bandMoney = new Lru(200);
        this._slotSims = new Lru(4);
        this._sims = new Lru(400);
        this._misc = new Lru(64);
        this._weights = new Map();
        this._insights = null;
        this._baseW = null;
        const clim = ds.climatology;
        const ones = new Float64Array(12).fill(1);
        this.typicalFactors = clim?.monthlyKwhM2 ? typicalMonthScale(clim, ds.ghi, ds.local) : ones;
        this.typicalIsActual = this.typicalFactors.every((v) => v === 1);
        this.bandYears = [];
        if (clim?.years?.length && clim.yearMonthlyKwhM2) {
            for (const y of clim.years) {
                try {
                    this.bandYears.push({ year: y, f: typicalMonthScale(clim, ds.ghi, ds.local, { year: y }) });
                } catch { /* a year without data cannot be in the band */ }
            }
        }
    }

    /* ───────────────────────── cooperative runs ───────────────────────── */

    /**
     * Run a heavy method cooperatively, for an engine on the page's own thread (engine.js falls
     * back to that when module workers are unavailable): the same work, caches and result as
     * engine[method](...args), but paused (await yieldFn(), default a macrotask) whenever sliceMs
     * has passed, at points between proxy cells, weather years and simulations — so no single
     * stretch blocks the page for seconds. Methods without a step form run in one go.
     * @param {string} method one of STEPPED (others are called directly)
     * @param {Array} [args]
     * @param {{ yieldFn?: () => Promise<unknown>, sliceMs?: number }} [opts]
     * @returns {Promise<*>}
     */
    callAsync(method, args = [], opts = {}) {
        const steps = STEPPED[method];
        if (!steps) return Promise.resolve().then(() => this[method](...args));
        return runStepsAsync(this[steps](...args), opts);
    }

    /* ───────────────────────── dataset-level ───────────────────────── */

    /** Always-on load of the data the user supplied (W), before any projection. */
    get baseLoadW() {
        if (this._baseW === null) this._baseW = estimateBaseLoad(this.ds0).w;
        return this._baseW;
    }

    /**
     * DatasetSummary (dataset.js summarize) plus the weather basis and any projected base load.
     * @returns {Object}
     */
    get summary() {
        return { ...summarize(this.ds0), projectBaseW: this.projectBaseW, weatherBasis: this.weatherInfo() };
    }

    /**
     * Usage insights of the user's own data (cached; never projected).
     * @returns {Object} Insights (insights.js)
     */
    insights() {
        if (!this._insights) this._insights = analyseUsage(this.ds0);
        return this._insights;
    }

    /**
     * How the typical year relates to the data: per-month factors, and how the last 12 months
     * compare with 2006–2025 (UX critique: "sunnier than {k} of the last 20 years").
     * @returns {{ hasClimatology: boolean, typicalFactors: number[], actualKwhM2: number|null, climKwhM2: number|null,
     *   pctVsAverage: number|null, sunnierThanYears: number|null, yearsCompared: number, years: number[] }}
     */
    weatherInfo() {
        const clim = this.ds0.climatology;
        const out = { hasClimatology: !!clim?.monthlyKwhM2, typicalFactors: Array.from(this.typicalFactors), actualKwhM2: null,
            climKwhM2: null, pctVsAverage: null, sunnierThanYears: null, yearsCompared: 0, years: this.bandYears.map((b) => b.year) };
        if (!out.hasClimatology) return out;
        // the dataset's own year, month by month as daily means × typical month length (same basis as the factors)
        const ds = this.ds0;
        const sums = new Float64Array(12);
        const slots = new Float64Array(12);
        for (let t = 0; t < ds.n; t++) {
            const g = ds.ghi[t];
            if (Number.isFinite(g)) { sums[ds.local.month[t]] += (g * 0.5) / 1000; slots[ds.local.month[t]]++; }
        }
        const dim = (m0) => clim.meanDim?.[m0] ?? (m0 === 1 ? 28.25 : daysInMonth(2025, m0 + 1));
        let act = 0;
        let ref = 0;
        for (let m0 = 0; m0 < 12; m0++) {
            const cov = slots[m0] / 48;
            act += cov >= 1 ? (sums[m0] / cov) * dim(m0) : clim.monthlyKwhM2[m0];
            ref += clim.monthlyKwhM2[m0];
        }
        out.actualKwhM2 = act;
        out.climKwhM2 = ref;
        out.pctVsAverage = ref > 0 ? (100 * (act - ref)) / ref : null;
        if (clim.years?.length && clim.yearMonthlyKwhM2) {
            let k = 0;
            for (let yi = 0; yi < clim.years.length; yi++) {
                let s = 0;
                for (let m0 = 0; m0 < 12; m0++) s += clim.yearMonthlyKwhM2[yi * 12 + m0];
                if (s < act) k++;
            }
            out.sunnierThanYears = k;
            out.yearsCompared = clim.years.length;
        }
        return out;
    }

    /**
     * Project every later run with a different always-on load: withBaseLoad(ds, baseLoadW, w).
     * null restores the data as measured.
     * @param {number|null} w
     */
    setProjectBaseW(w) {
        const v = Number.isFinite(w) ? w : null;
        if (v === this.projectBaseW) return;
        this.projectBaseW = v;
        this.ds = v === null ? this.ds0 : withBaseLoad(this.ds0, this.baseLoadW, v);
        this._slotSims.clear();
        this._slotResults.clear();
        this._misc.clear();
    }

    /**
     * @param {Object} partial
     * @returns {Object} System
     */
    normalizeSystem(partial) {
        return normalizeSystem(partial);
    }

    /**
     * Rules for a system, with this dataset's base load (for 'baseload' power-station loads) and spots.
     * @param {Object} system
     * @returns {Object} RulesResult
     */
    validate(system) {
        return validateRules(system, this.catalog, { baseLoadW: estimateBaseLoad(this.ds).w, spots: this.spots });
    }

    /**
     * @param {Object} system
     * @param {Object} action
     * @returns {Object} System
     */
    applyFix(system, action) {
        return applyRulesFix(system, action, this.catalog);
    }

    /* ───────────────────────── PV caches ───────────────────────── */

    _geomFor(sub) {
        let g = this._geom.get(sub);
        if (!g) {
            const ds = this.ds0;
            g = prepareGeometry({ start: ds.start, n: ds.n, lat: ds.lat, lon: ds.lon, altitude: ds.altitude ?? 0 }, { subSteps: sub });
            this._geom.set(sub, g);
        }
        return g;
    }

    _skyFor(sub, weather) {
        const basis = weather === 'typical' && this.typicalIsActual ? 'actual' : weather;
        const key = `${sub}|${basis}`;
        let s = this._sky.get(key);
        if (!s) {
            s = prepareSky(this.ds0, this._geomFor(sub), { monthScale: basis === 'typical' ? this.typicalFactors : null });
            this._sky.set(key, s);
        }
        return s;
    }

    _dcFor(array, sub, weather) {
        const key = `${sub}|${weather}|${arrayKey(array)}`;
        let dc = this._dc.get(key);
        if (!dc) dc = this._dc.set(key, arrayDcW(this._skyFor(sub, weather), array));
        return dc;
    }

    /** Key of the grid-tied PV path: inverter + which arrays sit on which input. */
    static _pvKey(sys) {
        const inv = sys.inverter;
        return stable([inv.acLimitW, inv.etaNom, inv.standbyW, inv.inputs, sys.arrays.map((a) => [a.input, arrayKey(a)])]);
    }

    /**
     * PvSlots of the system's grid-tied arrays, or null without any.
     * @param {Object} sys normalised
     * @param {number} sub
     * @param {'typical'|'actual'} weather
     * @param {Float64Array|null} [factors] band: scale the actual-weather DC by month instead
     */
    _pvFor(sys, sub, weather, factors = null) {
        if (!sys.arrays.length || !sys.inverter) return null;
        const geom = this._geomFor(sub);
        if (factors) {
            const dc = sys.arrays.map((a) => scaleDcByMonth(geom, this._dcFor(a, sub, 'actual'), factors));
            return inverterAc(geom, dcByInput(geom, sys.arrays, dc, sys.inverter), sys.inverter);
        }
        const key = `${sub}|${weather}|${SolarEngine._pvKey(sys)}`;
        let pv = this._pv.get(key);
        if (!pv) {
            const dc = sys.arrays.map((a) => this._dcFor(a, sub, weather));
            pv = this._pv.set(key, inverterAc(geom, dcByInput(geom, sys.arrays, dc, sys.inverter), sys.inverter));
        }
        return pv;
    }

    /**
     * A power station's own-panel DC per slot (kWh), summed per station input and capped at that
     * input's limit (pv.dcToSlotsKwh), or null without panels.
     */
    _stationPv(sys, sub, weather, factors = null) {
        if (!hasStationPanels(sys)) return null;
        const u = sys.battery.ups;
        const key = `${sub}|${weather}|${stable([u.pvInputs, u.pvArrays.map((a) => [a.input, arrayKey(a)])])}`;
        if (!factors) {
            const hit = this._upsPv.get(key);
            if (hit) return hit;
        }
        const geom = this._geomFor(sub);
        const byInput = new Map();
        for (const a of u.pvArrays) {
            let dc = this._dcFor(a, sub, factors ? 'actual' : weather);
            if (factors) dc = scaleDcByMonth(geom, dc, factors);
            const q = a.input ?? 0;
            const acc = byInput.get(q);
            if (!acc) byInput.set(q, Float32Array.from(dc));
            else for (let i = 0; i < acc.length; i++) acc[i] += dc[i];
        }
        const out = new Float64Array(this.ds0.n);
        for (const [q, dc] of byInput) {
            const cap = u.pvInputs[q]?.maxDcW ?? u.pvInputs[u.pvInputs.length - 1]?.maxDcW ?? Infinity;
            const slots = dcToSlotsKwh(geom, dc, cap);
            for (let t = 0; t < out.length; t++) out[t] += slots[t];
        }
        return factors ? out : this._upsPv.set(key, out);
    }

    /** One simulate() run of a normalised system on a weather basis. */
    _sim(sys, { sub = FULL_SUB, weather = 'typical', ds = this.ds, includeSlots = false, dispatchOpts = {}, factors = null } = {}) {
        // a run depends on the system's physics, the weather basis, the dataset (load/prices: its
        // id) and the dispatch options — not on finance, prices, labels or the route, so re-valuing
        // with other finance settings or the user's own prices is free
        const key = factors || includeSlots ? null : `${physicsKey(sys)}|${sub}|${weather}|${ds.id}|${stable(dispatchOpts)}`;
        if (key) {
            const hit = this._sims.get(key);
            if (hit) return hit;
        }
        const pv = this._pvFor(sys, sub, weather, factors);
        const upsPvDc = this._stationPv(sys, sub, weather, factors);
        const r = simulate(ds, pv, sys, { upsPvDc, includeSlots, dispatchOpts });
        return key ? this._sims.set(key, r) : r;
    }

    /* ───────────────────────── money ───────────────────────── */

    /**
     * Finance options for a run: the user's settings over the defaults, install date defaulting to
     * the 1st of next month.
     * @param {Object} [finance]
     * @returns {Object}
     */
    financeOptions(finance = {}) {
        const f = finance && typeof finance === 'object' ? finance : {};
        return financeOptions({ ...f, installDate: f.installDate ?? this.defaultInstallDate });
    }

    /** Year-1 multipliers by month0: (1 + VAT on that date) and the year-1 PV factor. */
    _y1(fo) {
        const key = stable([fo.installDate, fo.vatReturns, fo.vatSchedule, fo.pvFirstYearDeg, fo.pvAnnualDeg]);
        let w = this._weights.get(key);
        if (w) return w;
        let sch = fo.vatSchedule ?? DEFAULT_VAT_SCHEDULE;
        if (fo.vatReturns === false) {
            // same rule as finance.js: from the first 0% period on, VAT stays at 0
            const i = sch.findIndex((e) => e.rate === 0);
            if (i >= 0) sch = sch.map((e, j) => (j >= i ? { untilMs: e.untilMs, rate: 0 } : e));
        }
        const m = /^(\d{4})-(\d{2})/.exec(fo.installDate);
        const y0 = m ? Number(m[1]) : 2026;
        const mStart = m ? Number(m[2]) - 1 : 10;
        const v = new Float64Array(12);
        for (let k = 0; k < 12; k++) {
            const idx = mStart + k;
            v[idx % 12] = 1 + vatAt(Date.UTC(y0 + Math.floor(idx / 12), idx % 12, 15, 12), sch);
        }
        w = { v, k: pvDegradation(1, fo.pvFirstYearDeg, fo.pvAnnualDeg) };
        this._weights.set(key, w);
        return w;
    }

    /** First-year £ of a run's forward money (no battery ageing): Σ_m k·(impSav·(1+VAT) + export)/100. */
    _value(sim, fo) {
        const { v, k } = this._y1(fo);
        const m = toMonthlyFwd(sim.monthly);
        let s = 0;
        for (let i = 0; i < 12; i++) s += m[i].impSavFwdExcP * v[i] + m[i].expIncFwdP;
        return (k * s) / 100;
    }

    /**
     * First-year £ exactly as the headline reports it (finance.project year 1): a battery's share
     * is aged by its year-1 state of health, so every figure for a battery system — the split, the
     * strategy comparison, the starred orientation points — agrees with headline.savingsGbp.
     * _value() skips that ageing and is only right for systems without a battery.
     * @param {Object} sys normalised system the run belongs to (its battery sets the ageing)
     * @param {Object} full SimResult of sys
     * @param {Object|null} pvOnly SimResult of sys with the battery removed (null: no battery)
     * @param {Object} fo finance options
     * @returns {number}
     */
    _yearOneGbp(sys, full, pvOnly, fo) {
        if (!sys.battery || !pvOnly) return this._value(full, fo);
        return this._projectMoney(sys, this._money(sys, full, pvOnly, null), fo).year1Gbp;
    }

    /** First-year standby cost (£, VAT applied) of a run. */
    _standbyValue(sim, fo) {
        const { v } = this._y1(fo);
        const m = toMonthlyFwd(sim.monthly);
        let s = 0;
        for (let i = 0; i < 12; i++) s += m[i].standbyCostFwdExcP * v[i];
        return s / 100;
    }

    /** Catalog price of the battery hardware in a system (for LCOS and battery replacement). */
    _batteryCapex(sys) {
        if (!sys.battery) return null;
        let s = 0;
        let found = false;
        for (const id of new Set(sys.sourceIds)) {
            const p = findProduct(this.catalog, id);
            if (p && (p.battery || p.kind === 'power-station') && Number.isFinite(p.priceGbp)) { s += p.priceGbp; found = true; }
        }
        return found ? s : null;
    }

    /**
     * Monthly forward money of a run, its battery-less twin and (for a staged plan) stage 2, in
     * the shape finance.project takes. Kept separate from project() so the weather band can blend
     * two years' money and project the blend.
     * @returns {{ pvM: Array, battM: Array|null, cycles: number, pvAcKwh: number, battOutAcKwh: number, s2: Object|null }}
     */
    _money(sys, full, pvOnly, stage2 = null) {
        const of = (f, p) => {
            const fullM = toMonthlyFwd(f.monthly);
            const pvM = p ? toMonthlyFwd(p.monthly) : fullM;
            return { pvM, battM: p ? diffMonthlyFwd(fullM, pvM) : null, cycles: f.annual.battCycles,
                pvAcKwh: (p ?? f).annual.pvAcKwh + (p ?? f).annual.upsPvKwh, battOutAcKwh: f.annual.battOutAcKwh };
        };
        const m = { ...of(full, pvOnly), s2: null };
        if (sys.upgrade && stage2) m.s2 = { system: stage2.system, ...of(stage2.full, stage2.pvOnly) };
        return m;
    }

    /** finance.project of _money() output. */
    _projectMoney(sys, m, fo) {
        const batt = (s, cycles) => (s.battery ? { coupling: s.battery.coupling, efcPerYear: cycles, cycles: s.battery.cycles,
            cycleRatingSoh: s.battery.cycleRatingSoh, lifeYears: s.battery.lifeYears, capexGbp: this._batteryCapex(s) ?? undefined } : null);
        const energy = { pvAcKwh: m.pvAcKwh, battOutAcKwh: m.battOutAcKwh };
        let upgrade = null;
        if (sys.upgrade && m.s2) {
            upgrade = { atYear: sys.upgrade.atYear, costs: sys.upgrade.costs, stage2PvMonthly: m.s2.pvM, stage2BattMonthly: m.s2.battM,
                standbyCostFwdP: m.s2.battM ?? 0, battery: batt(m.s2.system, m.s2.cycles) };
            energy.stage2PvAcKwh = m.s2.pvAcKwh;
            energy.stage2BattOutAcKwh = m.s2.battOutAcKwh;
        }
        return project({
            costs: sys.costs, pvMonthly: m.pvM, battMonthly: m.battM, standbyCostFwdP: m.battM ?? 0, battery: batt(sys, m.cycles),
            hasMicro: !!sys.inverter, upgrade, energy, opts: fo,
        });
    }

    /**
     * finance.project for a full run and its battery-less twin (+ stage 2 of a staged plan).
     * @returns {Object} Finance
     */
    _finance(sys, full, pvOnly, fo, stage2 = null) {
        return this._projectMoney(sys, this._money(sys, full, pvOnly, stage2), fo);
    }

    /** Stage 2 of a staged plan, simulated like stage 1 (same basis, factors and dispatch options). */
    _stage2(sys, opts) {
        if (!sys.upgrade) return null;
        const s2 = upgradedSystem(sys);
        return { system: s2, full: this._sim(s2, opts), pvOnly: s2.battery ? this._sim({ ...s2, battery: null }, { ...opts, dispatchOpts: {} }) : null };
    }

    /** Typical-weather run + its battery-less twin + finance, no extras (curves, flips, tornado). */
    _quick(sys, { ds = this.ds, sub = FULL_SUB, weather = 'typical', dispatchOpts = {}, fo, stage2 = true } = {}) {
        const full = this._sim(sys, { sub, weather, ds, dispatchOpts });
        const pvOnly = sys.battery ? this._sim({ ...sys, battery: null }, { sub, weather, ds }) : null;
        const st2 = stage2 ? this._stage2(sys, { sub, weather, ds, dispatchOpts }) : null;
        const finance = this._finance(sys, full, pvOnly, fo, st2);
        return { full, pvOnly, finance, stage2: st2 };
    }

    /* ───────────────────────── scenarios ───────────────────────── */

    /**
     * Run one scenario: typical (headline) and actual weather, the battery-less twin, finance,
     * the 2006–2025 weather band with its finance at p10/p90, and for batteries the split of
     * their value plus realistic-vs-best-case figures.
     * @param {Object} system
     * @param {{ withBand?: boolean, finance?: Object, includeSlots?: boolean, fidelity?: 'full'|'proxy', dispatchOpts?: Object }} [opts]
     * @returns {Object} ScenarioResult (CONTRACTS §13) + headline { savingsGbp, actualGbp, billedGbp, p10Gbp, p50Gbp,
     *   p90Gbp, paybackYears, paybackP10Years, paybackP90Years, capexGbp, npv10Gbp, net10Gbp, npvGbp, selfUsePct,
     *   exportIncomeGbp, exportKwh, exportUnpaidKwh, pvKwh, peakGenSharePct (grid-tied panels), peakGenShareAllPct (a station’s own panels too),
     *   pvValuePPerKwh (pence saved per kWh made, the solar's share only — see pvValuePPerKwh) } and weather { basis: 'typical', factors }
     */
    runScenario(system, opts = {}) {
        return runSteps(this._runScenarioSteps(system, opts));
    }

    /** runScenario as steps: it yields between simulations and between weather-band years. */
    *_runScenarioSteps(system, { withBand = true, finance = {}, includeSlots = false, fidelity = 'full', dispatchOpts = {} } = {}) {
        const sys = normalizeSystem(system);
        const fo = this.financeOptions(finance);
        const full = fidelity !== 'proxy';
        const sub = full ? FULL_SUB : PROXY_SUB;
        const band = withBand && full;
        // the rules depend on the mount spots too (ABOVE_GROUND), so they are part of the key
        const key = [systemKey(sys), stable(fo), this.projectBaseW, band, includeSlots, sub, stable(dispatchOpts), stable(this.spots)].join('#');
        // a result with per-slot arrays is ~3 MB: keep only a few of those
        const cache = includeSlots ? this._slotResults : this._results;
        const hit = cache.get(key);
        // systemKey ignores id/name/featured/notes: an identical build under another label reuses
        // the run, returned under the caller's own labels
        if (hit) {
            const same = hit.id === sys.id && hit.system.name === sys.name && hit.system.featured === sys.featured
                && stable(hit.system.notes) === stable(sys.notes);
            return same ? hit : { ...hit, id: sys.id, system: sys };
        }

        const rules = this.validate(sys);
        const wx = weatherDependent(sys);
        const typical = this._sim(sys, { sub, weather: 'typical', includeSlots, dispatchOpts });
        yield;
        const actual = wx ? this._sim(sys, { sub, weather: 'actual', dispatchOpts }) : typical;
        yield;
        const noBatt = sys.battery ? { ...sys, battery: null } : null;
        const pvOnly = noBatt ? this._sim(noBatt, { sub, weather: 'typical' }) : null;
        const pvOnlyActual = noBatt ? (wx ? this._sim(noBatt, { sub, weather: 'actual' }) : pvOnly) : null;
        yield;
        const st2 = this._stage2(sys, { sub, weather: 'typical', dispatchOpts });
        const fin = this._finance(sys, typical, pvOnly, fo, st2);
        const finActual = wx ? this._finance(sys, actual, pvOnlyActual, fo, this._stage2(sys, { sub, weather: 'actual', dispatchOpts })) : fin;
        yield;

        const res = {
            id: sys.id,
            system: sys,
            rules,
            typical,
            actual,
            pvOnly,
            band: null,
            finance: fin,
            financeBand: null,
            weather: { basis: 'typical', factors: Array.from(this.typicalFactors), typicalIsActual: this.typicalIsActual },
        };
        if (band) Object.assign(res, yield* this._bandSteps(sys, fo, fin, { wx, dispatchOpts, typical, pvOnly, stage2: st2 }));
        if (sys.battery && full) res.battery = yield* this._batteryExtrasSteps(sys, fo, { typical, pvOnly, dispatchOpts, fin });
        const T = typical.annual;
        res.headline = {
            savingsGbp: fin.year1Gbp,
            actualGbp: finActual.year1Gbp,
            billedGbp: actual.totals.savingsBilledP / 100,
            p10Gbp: res.band?.p10 ?? null,
            p50Gbp: res.band?.p50 ?? null,
            p90Gbp: res.band?.p90 ?? null,
            paybackYears: fin.paybackYears,
            paybackP10Years: res.financeBand?.p10.paybackYears ?? null,
            paybackP90Years: res.financeBand?.p90.paybackYears ?? null,
            capexGbp: fin.capexGbp,
            npv10Gbp: fin.npv10Gbp,
            net10Gbp: fin.net10Gbp,
            npvGbp: fin.npvGbp,
            selfUsePct: T.selfConsumptionPct,
            exportIncomeGbp: T.expIncFwdP / 100,
            exportKwh: T.exportKwh,
            exportUnpaidKwh: T.exportUnpaidKwh,
            pvKwh: T.pvAcKwh + T.upsPvKwh,
            peakGenSharePct: T.peakGenSharePct,
            peakGenShareAllPct: T.peakGenShareAllPct,
            pvValuePPerKwh: null,
        };
        res.headline.pvValuePPerKwh = pvValuePPerKwh(res);
        return cache.set(key, res);
    }

    /**
     * The 2006–2025 weather band: each year's monthly factors (GY/Gact, daily means) applied to the
     * cached actual-weather DC (pv.scaleDcByMonth), inverter and dispatch re-run (an optimiser at
     * N = 21), stage 2 of a staged plan likewise, each year projected with finance; percentiles
     * over the first-year savings. The p10/p90 finance blends the two bracketing years' monthly
     * money with the percentile weight, so its year 1 equals the band figure exactly (project()
     * is linear in the monthly inputs).
     *
     * The band's optimiser runs on a coarser SoC grid than the headline, and on a big battery that
     * grid alone costs money (N 21 on 5 kWh truncates charge and discharge to 0.23 kWh steps:
     * ~£33/yr on a 5 kWh dc unit), which put the headline above its own p90. So the band sets the
     * spread and the headline sets the level: the grid's own effect is measured on the typical year
     * (headline grid − band grid, same weather) and added to every band year's money, cycles and
     * battery output before projecting.
     * @param {{ wx: boolean, dispatchOpts: Object, typical?: Object, pvOnly?: Object|null, stage2?: Object|null }} ctx
     *   typical/pvOnly/stage2: the headline's own runs (re-run when absent)
     */
    _band(sys, fo, fin, ctx) {
        return runSteps(this._bandSteps(sys, fo, fin, ctx));
    }

    /** _band as steps: it yields after every weather year. */
    *_bandSteps(sys, fo, fin, { wx, dispatchOpts, typical = null, pvOnly = null, stage2 = null }) {
        const years = this.bandYears;
        if (!years.length) return { band: null, financeBand: null };
        if (!wx) {
            const v = fin.year1Gbp;
            return {
                band: { years: years.map((y) => y.year), savingsGbp: years.map(() => v), paybackYears: years.map(() => fin.paybackYears), p10: v, p50: v, p90: v },
                financeBand: { p10: fin, p90: fin },
            };
        }
        const dOpts = { ...dispatchOpts, ...(usesDp(sys.battery) ? BAND_DP : COARSE) };
        const noBatt = sys.battery ? { ...sys, battery: null } : null;
        const s2sys = sys.upgrade ? upgradedSystem(sys) : null;
        const dOpts2 = { ...dispatchOpts, ...(usesDp(s2sys?.battery) ? BAND_DP : COARSE) };
        // the yearly money depends on the physics of both stages only — not on finance settings or
        // prices — so changing them only re-projects. The cached money carries no system: stage 2's
        // (whose catalog ids price a battery replacement) is attached per call.
        const mkey = `${physicsKey(sys)}|${s2sys ? physicsKey(s2sys) : ''}|${this.ds.id}|${stable(dispatchOpts)}`;
        let cached = this._bandMoney.get(mkey);
        if (!cached) {
            const anchor = this._bandAnchor(sys, s2sys, { dispatchOpts, dOpts, dOpts2, typical, pvOnly, stage2 });
            yield;
            const list = [];
            for (const { year, f } of years) {
                const full = this._sim(sys, { weather: 'actual', factors: f, dispatchOpts: dOpts });
                const po = noBatt ? this._sim(noBatt, { weather: 'actual', factors: f }) : null;
                const st2 = s2sys ? { system: null, full: this._sim(s2sys, { weather: 'actual', factors: f, dispatchOpts: dOpts2 }),
                    pvOnly: s2sys.battery ? this._sim({ ...s2sys, battery: null }, { weather: 'actual', factors: f }) : null } : null;
                const money = this._money(sys, full, po, st2);
                list.push({ year, money: anchor ? anchorMoney(money, anchor) : money });
                yield;
            }
            cached = this._bandMoney.set(mkey, list);
        }
        const series = cached.map((s) => ({ year: s.year, money: s.money.s2 ? { ...s.money, s2: { ...s.money.s2, system: s2sys } } : s.money }));
        const fins = series.map((s) => this._projectMoney(sys, s.money, fo));
        const sav = fins.map((f) => f.year1Gbp);
        const order = sav.map((v, i) => i).sort((a, b) => sav[a] - sav[b]);
        const mixM = (a, b, w) => (a && b ? a.map((m, i) => ({
            impSavFwdExcP: m.impSavFwdExcP * (1 - w) + b[i].impSavFwdExcP * w,
            expIncFwdP: m.expIncFwdP * (1 - w) + b[i].expIncFwdP * w,
            standbyCostFwdExcP: m.standbyCostFwdExcP * (1 - w) + b[i].standbyCostFwdExcP * w,
        })) : null);
        const mix = (A, B, w) => {
            if (!A) return null;
            const out = { pvM: mixM(A.pvM, B.pvM, w), battM: mixM(A.battM, B.battM, w) };
            for (const k of ['cycles', 'pvAcKwh', 'battOutAcKwh']) out[k] = A[k] * (1 - w) + B[k] * w;
            if (A.system) out.system = A.system;
            return out;
        };
        const at = (q) => {
            const pos = (order.length - 1) * q;
            const lo = Math.floor(pos);
            const w = pos - lo;
            const A = series[order[lo]].money;
            const B = series[order[Math.ceil(pos)]].money;
            return this._projectMoney(sys, { ...mix(A, B, w), s2: mix(A.s2, B.s2, w) }, fo);
        };
        return {
            band: {
                years: series.map((s) => s.year),
                savingsGbp: sav,
                paybackYears: fins.map((f) => f.paybackYears),
                p10: percentile(sav, 0.1),
                p50: percentile(sav, 0.5),
                p90: percentile(sav, 0.9),
            },
            financeBand: { p10: at(0.1), p90: at(0.9) },
        };
    }

    /**
     * What the band's coarser SoC grid changes on the typical year, per stage: headline-grid money
     * − band-grid money (monthly battery money, cycles, battery output), or null when no stage
     * runs an optimiser (the rule strategies don't use the SoC grid, so their band needs nothing).
     */
    _bandAnchor(sys, s2sys, { dispatchOpts, dOpts, dOpts2, typical, pvOnly, stage2 }) {
        if (!usesDp(sys.battery) && !usesDp(s2sys?.battery)) return null;
        const twin = (s) => (s.battery ? this._sim({ ...s, battery: null }, { weather: 'typical' }) : null);
        const head = typical ?? this._sim(sys, { weather: 'typical', dispatchOpts });
        const po = pvOnly ?? twin(sys);
        const coarse = usesDp(sys.battery) ? this._sim(sys, { weather: 'typical', dispatchOpts: dOpts }) : head;
        let h2 = null;
        let c2 = null;
        if (s2sys) {
            const s2full = stage2?.full ?? this._sim(s2sys, { weather: 'typical', dispatchOpts });
            const s2po = stage2 ? stage2.pvOnly : twin(s2sys);
            h2 = { system: null, full: s2full, pvOnly: s2po };
            c2 = { system: null, full: usesDp(s2sys.battery) ? this._sim(s2sys, { weather: 'typical', dispatchOpts: dOpts2 }) : s2full, pvOnly: s2po };
        }
        const a = this._money(sys, head, po, h2);
        const b = this._money(sys, coarse, po, c2);
        return moneyDelta(a, b);
    }

    /**
     * What a battery adds and where it comes from (UX critique answers.battery):
     *   total     = sav(B) − sav(B0)                     B0 = battery removed
     *   fromSolar = sav(Bng) − sav(B0) + standby(Bng)    Bng = no grid charging
     *   fromGrid  = sav(B) − sav(Bng)
     *   standby   = −standby(B)
     * All first-year £ on the headline's basis (finance year 1: VAT schedule, the battery's share
     * aged by its year-1 state of health), so systemGbp === headline.savingsGbp and totalGbp is
     * exactly headline(B) − headline(B0). Each variant ages with its own cycle count. For dc/ac
     * batteries standby is a constant draw, so the parts sum to the total exactly; a power
     * station's bypass overhead depends on its decisions, so its fromGrid is the remainder. A
     * system with no panels at all stores no solar: its fromSolar is 0 by definition (a station
     * starts full, which would otherwise show up as a few pence "from solar"). A power station's
     * optimalGbp is never below its thresholdGbp (see upsStrategies).
     */
    _batteryExtras(sys, fo, ctx) {
        return runSteps(this._batteryExtrasSteps(sys, fo, ctx));
    }

    /** _batteryExtras as steps: it yields between its three extra runs. */
    *_batteryExtrasSteps(sys, fo, { typical, pvOnly, dispatchOpts, fin }) {
        const y1 = (s, sim) => this._yearOneGbp(normalizeSystem(s), sim, pvOnly, fo);
        const sbc = (s) => this._standbyValue(s, fo) - this._standbyValue(pvOnly, fo);
        const strat = sys.battery.strategy;
        const thrSys = withStrategy(sys, 'threshold');
        const optSys = withStrategy(sys, 'optimal');
        const ngSys = noGridCharge(sys);
        const thr = strat === 'threshold' ? typical : this._sim(thrSys, { dispatchOpts });
        yield;
        const opt = strat === 'optimal' ? typical : this._sim(optSys, { dispatchOpts });
        yield;
        const ng = this._sim(ngSys, { dispatchOpts });
        yield;
        const sysGbp = fin ? fin.year1Gbp : y1(sys, typical);
        const b0 = this._value(pvOnly, fo);
        const total = sysGbp - b0;
        const standby = -sbc(typical);
        const noPv = !weatherDependent(sys);
        const fromSolar = noPv ? 0 : y1(ngSys, ng) - b0 + sbc(ng);
        const fromGrid = noPv || sys.battery.coupling === 'ups' ? total - fromSolar - standby : sysGbp - y1(ngSys, ng);
        const thrGbp = strat === 'threshold' ? sysGbp : y1(thrSys, thr);
        let optGbp = strat === 'optimal' ? sysGbp : y1(optSys, opt);
        // a station's day-ahead planner can sit a hair above the optimiser's SoC grid (it truncates
        // the charger's power): perfect hindsight is never worth less than a realistic controller
        if (sys.battery.coupling === 'ups') optGbp = Math.max(optGbp, thrGbp);
        return {
            strategy: strat,
            systemGbp: sysGbp,
            baseGbp: b0,
            totalGbp: total,
            split: { fromSolarGbp: fromSolar, fromGridGbp: fromGrid, standbyGbp: standby },
            thresholdGbp: thrGbp - b0,
            optimalGbp: optGbp - b0,
            thresholdSystemGbp: thrGbp,
            optimalSystemGbp: optGbp,
            cyclesPerYear: typical.annual.battCycles,
            gridChargeKwh: typical.annual.gridChargeKwh,
        };
    }

    /**
     * The default option set (scenarios.js), placed on the best of the given mount spots. No spots
     * (none passed, null or an empty list) means the default ground frame + west wall: the call
     * always reflects the spots it is given, so going back to "our defaults" really drops the
     * user's old spots — here and in the rules (ABOVE_GROUND) of every later run.
     * @param {{ spots?: Object[]|null }} [opts]
     * @returns {Object[]} System[]
     */
    autoScenarios(opts = {}) {
        return runSteps(this._autoScenariosSteps(opts));
    }

    /** autoScenarios as steps: it yields inside every placement sweep. */
    *_autoScenariosSteps({ spots } = {}) {
        this.spots = (Array.isArray(spots) && spots.length ? spots : DEFAULT_SPOTS).map((s) => ({ ...s }));
        const key = `auto|${stable(this.spots)}|${this.projectBaseW}`;
        const hit = this._misc.get(key);
        if (hit) return hit;
        const list = yield* buildScenariosSteps(this, this.catalog, { spots: this.spots });
        return this._misc.set(key, list);
    }

    /* ───────────────────────── orientation ───────────────────────── */

    /**
     * Which panels a sweep re-points: one array (by id) or, for '*' / null, every array of the
     * kit together (grid-tied arrays first; a power station's own panels when there are none).
     */
    _target(sys, arrayId) {
        const ups = sys.battery?.coupling === 'ups' ? sys.battery.ups : null;
        const all = arrayId == null || arrayId === '*';
        if (sys.arrays.length && !all) {
            const i = sys.arrays.findIndex((a) => a.id === arrayId);
            if (i >= 0) return { station: false, index: i, ref: sys.arrays[i] };
        }
        if (ups?.pvArrays.length && !all) {
            const i = ups.pvArrays.findIndex((a) => a.id === arrayId);
            if (i >= 0) return { station: true, index: i, ref: ups.pvArrays[i] };
        }
        if (sys.arrays.length) return { station: false, index: -1, ref: sys.arrays[0] };
        if (ups?.pvArrays.length) return { station: true, index: -1, ref: ups.pvArrays[0] };
        throw new RangeError(`orientation: system ${sys.id} has no panels to point`);
    }

    /**
     * The system with the targeted panels pointed at (az, tilt), with the mounting physics of the
     * new direction (system.pointArray): turned vertical they are on a wall, exactly as the
     * west-wall option (S03) is modelled, so "on a west wall" is one figure whichever kit entry
     * the panels came from; wall panels turned to a frame tilt lose the wall physics.
     */
    static _repoint(sys, tg, az, tilt) {
        const re = (a, j) => (tg.index < 0 || j === tg.index ? pointArray(a, az, tilt) : a);
        if (!tg.station) return { ...sys, arrays: sys.arrays.map(re) };
        const u = sys.battery.ups;
        return { ...sys, battery: { ...sys.battery, ups: { ...u, pvArrays: u.pvArrays.map(re) } } };
    }

    /**
     * Annual kWh, first-year £, p per kWh made and 4–7pm share of a run. With a battery, pass the
     * system and its battery-less twin so the £ is the headline's (battery share aged).
     */
    _cellMetrics(sim, fo, sys = null, pvOnly = null) {
        const kwh = sim.annual.pvAcKwh + sim.annual.upsPvKwh;
        const gbp = sys?.battery && pvOnly ? this._yearOneGbp(sys, sim, pvOnly, fo) : this._value(sim, fo);
        return { kwh, gbp, pPerKwh: kwh > 1e-9 ? (100 * gbp) / kwh : 0, peakSharePct: sim.annual.peakGenSharePct, peakShareAllPct: sim.annual.peakGenShareAllPct };
    }

    /**
     * Internal for sweep.js: a cell evaluator re-pointing one array (or the whole kit, '*').
     * Grid-tied panels: proxy = battery removed (unless keepBattery), the system's own export and
     * curtailment flag, `subSteps` (1), forward first-year £. A power station's own panels are
     * valued through the station (its battery is what uses them).
     * @returns {{ station: boolean, index: number, ref: Object, evaluate: (az: number, tilt: number) => Object }}
     */
    _proxyContext(system, arrayId, { ds = this.ds, subSteps = PROXY_SUB, weather = 'typical', finance = {}, keepBattery = false } = {}) {
        const sys0 = normalizeSystem(system);
        const fo = this.financeOptions(finance);
        const geom = this._geomFor(subSteps);
        const sky = this._skyFor(subSteps, weather);
        const tg = this._target(sys0, arrayId);
        const base = keepBattery || tg.station ? sys0 : { ...sys0, battery: null };
        const dOpts = usesDp(base.battery) ? BAND_DP : COARSE;
        const pvGrid = tg.station ? this._pvFor(base, subSteps, weather) : null;
        // a station cell is valued against the same system without the station (its grid-tied
        // panels don't move), so its £ is aged like the headline's
        const stationTwin = tg.station ? simulate(ds, pvGrid, { ...base, battery: null }, {}) : null;
        const moved = (j) => tg.index < 0 || j === tg.index;
        return {
            ...tg,
            evaluate: (az, tilt) => {
                const s = SolarEngine._repoint(base, tg, az, tilt);
                // re-pointed arrays of equal build share one DC series; the rest come from the cache
                const memo = new Map();
                const dcOf = (a, j) => {
                    if (!moved(j)) return this._dcFor(a, subSteps, weather);
                    const k = arrayKey(a);
                    if (!memo.has(k)) memo.set(k, arrayDcW(sky, a));
                    return memo.get(k);
                };
                if (!tg.station) {
                    const dc = s.arrays.map(dcOf);
                    const pv = inverterAc(geom, dcByInput(geom, s.arrays, dc, s.inverter), s.inverter);
                    const sim = simulate(ds, pv, s, { dispatchOpts: dOpts });
                    // a kept battery (flip C4) is aged against the same panels without it
                    const twin = s.battery ? simulate(ds, pv, { ...s, battery: null }, {}) : null;
                    return this._cellMetrics(sim, fo, s, twin);
                }
                const u = s.battery.ups;
                const byInput = new Map();
                u.pvArrays.forEach((a, j) => {
                    const dc = dcOf(a, j);
                    const q = a.input ?? 0;
                    const acc = byInput.get(q);
                    if (!acc) byInput.set(q, Float32Array.from(dc));
                    else for (let i = 0; i < acc.length; i++) acc[i] += dc[i];
                });
                const upsPvDc = new Float64Array(ds.n);
                for (const [q, dc] of byInput) {
                    const sl = dcToSlotsKwh(geom, dc, u.pvInputs[q]?.maxDcW ?? Infinity);
                    for (let t = 0; t < ds.n; t++) upsPvDc[t] += sl[t];
                }
                return this._cellMetrics(simulate(ds, pvGrid, s, { upsPvDc, dispatchOpts: dOpts }), fo, s, stationTwin);
            },
        };
    }

    /**
     * Full-fidelity value with the targeted panels re-pointed (3 sub-samples, typical weather,
     * battery included), on the headline's basis. (az, tilt) null keeps the system as configured:
     * that is "current" for a kit whose panels face different ways. monthly true adds the run's
     * month-of-year 4–7pm share (monthlyPeakSharePct) of the targeted panels.
     */
    _pointed(sys, tg, az, tilt, fo, { monthly = false } = {}) {
        const n = normalizeSystem(sys);
        const s = az === null ? n : normalizeSystem(SolarEngine._repoint(n, tg, az, tilt));
        const q = this._quick(s, { fo, stage2: false });
        const pt = { az: az ?? tg.ref.azimuth, tilt: tilt ?? tg.ref.tilt, ...this._cellMetrics(q.full, fo, s, q.pvOnly) };
        if (az === null) pt.mixed = true;
        if (monthly) pt.monthlyPeakSharePct = monthlyPeakSharePct(q.full.monthly, tg.station);
        return pt;
    }

    /**
     * Solar rose (engine critique sweep amendment): a proxy grid (1 sub-sample, no battery, az
     * 0–350 step 10 × tilt 5–90 step 5 + flat once = 649 cells, forward first-year £), then up to 8
     * starred configurations re-run at full fidelity with the battery: current, W90, S35, SSW45
     * (az 200 tilt 45), best £, best kWh and the two best-£ neighbours. A power station's own
     * panels use a coarse grid (az 90–270 step 15 × tilt 0–90 step 15) because the station's
     * battery has to run in every cell. Every starred £ is the headline's (finance year 1, a
     * battery's share aged), so 'current' equals runScenario's headline.savingsGbp. When the
     * swept panels face different ways (a split kit, '*'), 'current' is the system as configured,
     * carries mixed: true and the first array's direction, and has no proxy cell (proxyGbp null).
     * @param {Object} system
     * @param {string|null} [arrayId] one array, or '*' / null to point the whole kit together
     * @param {{ onProgress?: Function, finance?: Object }} [opts]
     * @returns {Object} SweepResult { arrayId, azimuths, tilts, cells, starred, proxyNote, basis, station }
     */
    orientationSweep(system, arrayId = '*', opts = {}) {
        return runSteps(this._orientationSweepSteps(system, arrayId, opts));
    }

    /** orientationSweep as steps: it yields after every cell and every full-fidelity point. */
    *_orientationSweepSteps(system, arrayId = '*', { onProgress, finance = {} } = {}) {
        const sys = normalizeSystem(system);
        const fo = this.financeOptions(finance);
        const tg = this._target(sys, arrayId);
        const key = `sweep|${physicsKey(sys)}|${tg.station}|${tg.index}|${this.projectBaseW}|${stable(fo)}`;
        const hit = this._misc.get(key);
        if (hit) return hit;
        const grid = tg.station
            ? orientationGrid({ azStep: 15, azMin: 90, azMax: 270, tilts: [0, 15, 30, 45, 60, 75, 90] })
            : orientationGrid({ azStep: 10, tiltStep: 5 });
        const cells = yield* sweepCellsSteps(this, sys, tg.index < 0 ? '*' : tg.ref.id, grid, { finance, onProgress });
        const { azimuths, tilts } = gridAxes(grid);
        const bestGbp = bestBy(cells, 'gbp');
        const bestKwh = bestBy(cells, 'kwh');
        const nb = neighbours(cells, bestGbp, tg.station ? { azStep: 15, tiltStep: 15 } : {}).sort((a, b) => b.gbp - a.gbp).slice(0, 2);
        // a split kit's "current" is the system as configured, not every panel turned to the first one's direction
        const mixed = mixedTarget(sys, tg);
        const wanted = [
            ['current', mixed ? null : tg.ref.azimuth, mixed ? null : tg.ref.tilt],
            ['W90', 270, 90],
            ['S35', 180, 35],
            ['SSW45', 200, 45],
            ['bestGbp', bestGbp.az, bestGbp.tilt],
            ['bestKwh', bestKwh.az, bestKwh.tilt],
            ...nb.map((c, i) => [`neighbour${i + 1}`, c.az, c.tilt]),
        ];
        const seen = new Map();
        const starred = [];
        for (const [k, az, tilt] of wanted) {
            const id = `${az}|${tilt}`;
            let v = seen.get(id);
            if (!v) {
                v = this._pointed(sys, tg, az, tilt, fo);
                seen.set(id, v);
                yield;
            }
            const proxy = az === null ? null : cells.find((c) => c.az === az && c.tilt === tilt) ?? null;
            starred.push({ key: k, ...v, proxyGbp: proxy?.gbp ?? null });
        }
        // the proxy (1 sub-sample, without a station beside the kit) can rank two neighbouring cells
        // the wrong way round: 'bestGbp' is the best of it and its neighbours at full fidelity
        const bi = starred.findIndex((p) => p.key === 'bestGbp');
        let top = bi;
        starred.forEach((p, i) => { if (p.key.startsWith('neighbour') && p.gbp > starred[top].gbp + 1e-9) top = i; });
        if (top !== bi) {
            const k = starred[top].key;
            starred[top] = { ...starred[top], key: 'bestGbp' };
            starred[bi] = { ...starred[bi], key: k };
        }
        const res = { arrayId: tg.index < 0 ? '*' : tg.ref.id, azimuths, tilts, cells, starred, proxyNote: PROXY_NOTE, basis: 'typical', station: tg.station };
        return this._misc.set(key, res);
    }

    /**
     * The verdict's orientation answer (UX critique answers.orientation), computed here so the
     * worker caches the heavy sweeps. The whole kit moves together: best of the rose restricted to
     * az 90–270 × tilt 15–90 (proxy), the named points confirmed at full fidelity, the tie band
     * (cells within tieBandPct of the best), westPays (best az ≥ 240) and the flip conditions
     * C1–C4 on a coarse grid (az 90–270 step 15 × tilt 15/30/45/60/90): reported when the best
     * moves ≥ 30° or westPays changes. C1 and C2 (Outgoing Prime) are only checked for a kit
     * Prime can pay (_primeEligible), C1 only when today's always-on load is ≥ 200 W (otherwise
     * ~150 W is not a lower load), and C1 is dropped when C2 lands on the same direction.
     * Named points are on the headline basis; 'current' of a split kit is the system as
     * configured (mixed: true), as in orientationSweep. A "wall" point (tilt ≥ WALL_TILT) is
     * modelled as a wall mount whichever spot the kit came from (_repoint). w90 also carries its
     * month-of-year 4–7pm share (monthlyPeakSharePct), and darkMonths the months it makes under
     * DARK_PCT % then — the same rule as Orientation, so both tabs name the same months.
     * @param {Object} system the kit to answer for (S01 in the verdict)
     * @param {{ tieBandPct?: number, finance?: Object, flips?: boolean }} [opts]
     * @returns {{ best, s35, w45, w90, ssw45, current, tie, tieBandPct, westPays, flips, checked, proxyNote, compass, cells, darkMonths: number[] }}
     */
    answerOrientation(system, opts = {}) {
        return runSteps(this._answerOrientationSteps(system, opts));
    }

    /** answerOrientation as steps: it yields inside the sweeps and after every full-fidelity point. */
    *_answerOrientationSteps(system, { tieBandPct = 3, finance = {}, flips: doFlips = true } = {}) {
        const sys = normalizeSystem(system);
        const fo = this.financeOptions(finance);
        // physicsKey drops the kit and route, which decide whether the Prime flips apply
        const key = `orient|${physicsKey(sys)}|${this._primeEligible(sys)}|${this.projectBaseW}|${tieBandPct}|${stable(fo)}|${doFlips}`;
        const hit = this._misc.get(key);
        if (hit) return hit;
        const tg = this._target(sys, '*');
        const sw = yield* this._orientationSweepSteps(sys, '*', { finance });
        const window = restrict(sw.cells, { azMin: 90, azMax: 270, tiltMin: 15, tiltMax: 90 });
        const bestCell = bestBy(window, 'gbp');
        const at = (az, tilt) => this._pointed(sys, tg, az, tilt, fo);
        // as in orientationSweep: the best of the proxy's best and its two best neighbours at full
        // fidelity (cached when the sweep has already run them)
        let best = at(bestCell.az, bestCell.tilt);
        yield;
        for (const c of neighbours(window, bestCell, tg.station ? { azStep: 15, tiltStep: 15 } : {}).sort((a, b) => b.gbp - a.gbp).slice(0, 2)) {
            const p = at(c.az, c.tilt);
            if (p.gbp > best.gbp + 1e-9) best = p;
            yield;
        }
        const named = {};
        for (const [k, az, tilt] of [['s35', 180, 35], ['w45', 270, 45], ['w90', 270, 90], ['ssw45', 200, 45]]) {
            named[k] = k === 'w90' ? this._pointed(sys, tg, az, tilt, fo, { monthly: true }) : at(az, tilt);
            yield;
        }
        const out = {
            best,
            ...named,
            current: mixedTarget(sys, tg) ? at(null, null) : at(tg.ref.azimuth, tg.ref.tilt),
            tie: tieBox(window, bestCell, tieBandPct),
            tieBandPct,
            westPays: best.az >= 240,
            flips: [],
            checked: [],
            proxyNote: sw.proxyNote,
            compass: compass16(best.az),
            cells: window,
            darkMonths: darkMonths(named.w90.monthlyPeakSharePct),
        };
        if (doFlips && !tg.station) {
            const coarse = orientationGrid({ azStep: 15, azMin: 90, azMax: 270, tilts: [15, 30, 45, 60, 90], includeFlat: false });
            const conds = [];
            const prime = { ...sys, export: { kind: 'prime', flatP: 0 } };
            // Outgoing Prime pays only on a plug-in kit bought from Octopus (rules
            // EXPORT_PRIME_NOT_OCTOPUS): "if you had Prime" is no condition for any other kit
            const primeOk = this._primeEligible(sys);
            // "~150 W" is a lower load only when today's is well above it
            const loadNow = Number.isFinite(this.projectBaseW) ? this.projectBaseW : this.baseLoadW;
            if (primeOk && loadNow >= FLIP_LOW_LOAD_W + FLIP_LOAD_MARGIN_W) conds.push(['C1', prime, { ds: withBaseLoad(this.ds0, this.baseLoadW, FLIP_LOW_LOAD_W) }]);
            if (primeOk && sys.export.kind !== 'prime') conds.push(['C2', prime, {}]);
            // the same inverter with 4 × 500 Wp, one string per input as far as the inputs go
            const nIn = Math.max(1, Math.min(sys.inverter?.inputs.length ?? 1, 4));
            const big = Array.from({ length: nIn }, (_, q) => ({ ...sys.arrays[0], id: `c3-${q}`, wp: 500, count: Math.floor(4 / nIn) + (q < 4 % nIn ? 1 : 0), input: q }));
            conds.push(['C3', { ...sys, arrays: big }, {}]);
            if (!sys.battery) {
                conds.push(['C4', { ...sys, battery: { ...DEFAULTS.battery, coupling: 'dc', capacityKwh: 2, strategy: 'self', acChargeW: 0 } }, { keepBattery: true }]);
            }
            for (const [code, s, o] of conds) {
                const b = bestBy(yield* sweepCellsSteps(this, normalizeSystem(s), '*', coarse, { ...o, finance }), 'gbp');
                out.checked.push(code);
                if (azDiff(b.az, best.az) >= 30 || (b.az >= 240) !== out.westPays) {
                    out.flips.push({ condition: code, text: FLIP_TEXT[code], az: b.az, tilt: b.tilt, gbp: b.gbp, compass: compass16(b.az) });
                }
            }
            // Prime alone (C2) landing where Prime with a lower load (C1) does says it all
            const c2 = out.flips.find((f) => f.condition === 'C2');
            if (c2) out.flips = out.flips.filter((f) => f.condition !== 'C1' || f.az !== c2.az || f.tilt !== c2.tilt);
        }
        return this._misc.set(key, out);
    }

    /**
     * Whether Outgoing Prime could pay this system's export: a kit bought from Octopus (any of its
     * products), on the plug-in route or as a what-if — the rules' EXPORT_PRIME_NOT_OCTOPUS test.
     * @param {Object} sys normalised
     * @returns {boolean}
     */
    _primeEligible(sys) {
        if (sys.route !== 'plugin' && sys.route !== 'whatif') return false;
        return [sys.kitId, ...sys.sourceIds].some((id) => typeof id === 'string' && !!findProduct(this.catalog, id)?.octopus);
    }

    /**
     * Placement helper for scenarios.js: proxy value of the system with every grid-tied array
     * pointed at each cell (1 sub-sample, battery removed, forward first-year £).
     * @param {Object} system
     * @param {Array<{ az: number, tilt: number }>} grid
     * @param {{ finance?: Object }} [opts]
     * @returns {Array<Object>} cells
     */
    placementCells(system, grid, opts = {}) {
        return runSteps(this._placementSteps(system, grid, opts));
    }

    /** placementCells as steps (scenarios.js runs these inside autoScenarios). */
    *_placementSteps(system, grid, opts = {}) {
        const sys = normalizeSystem(system);
        // the proxy drops the battery unless asked to keep it; everything else that changes a run
        // (curtailment, export, load adjustment, inverter flags) is in the physics key
        const { onProgress, finance, ds, ...rest } = opts;
        const probe = rest.keepBattery ? sys : { ...sys, battery: null };
        const key = `place|${physicsKey(probe)}|${stable(grid)}|${this.projectBaseW}|${ds?.id ?? ''}|${stable(this.financeOptions(finance))}|${stable(rest)}`;
        const hit = this._misc.get(key);
        if (hit) return hit;
        const cells = yield* sweepCellsSteps(this, sys, '*', grid, opts);
        return this._misc.set(key, cells);
    }

    /* ───────────────────────── curves ───────────────────────── */

    /**
     * Savings against always-on load (UX critique base-load curve): withBaseLoad of the measured
     * data to each x; cached PV, batteries at the coarse δ.
     * @param {Object[]} systems
     * @param {number[]} [xs] W; default 0…1500 plus the user's base and recent base
     * @param {{ finance?: Object }} [opts]
     * @returns {Array<{ id, name, points: Array<{ x, savingsGbp, paybackYears, selfUsePct, exportKwh, pvKwh }> }>}
     */
    baseLoadCurve(systems, xs, opts = {}) {
        return runSteps(this._baseLoadCurveSteps(systems, xs, opts));
    }

    /** baseLoadCurve as steps: it yields after every point. */
    *_baseLoadCurveSteps(systems, xs, { finance = {} } = {}) {
        const fo = this.financeOptions(finance);
        const bl = estimateBaseLoad(this.ds0);
        let x = Array.isArray(xs) && xs.length ? xs.filter(Number.isFinite) : [...BASE_XS, Math.round(bl.w), Math.round(bl.recentW)];
        x = [...new Set(x.map((v) => Math.max(0, v)))].sort((a, b) => a - b);
        const dsAt = new Map(x.map((v) => [v, withBaseLoad(this.ds0, bl.w, v)]));
        const out = [];
        for (const system of (systems ?? []).filter(Boolean)) {
            const sys = normalizeSystem(system);
            const points = [];
            for (const v of x) {
                const q = this._quick(sys, { ds: dsAt.get(v), dispatchOpts: COARSE, fo });
                const T = q.full.annual;
                points.push({ x: v, savingsGbp: q.finance.year1Gbp, paybackYears: q.finance.paybackYears, selfUsePct: T.selfConsumptionPct,
                    exportKwh: T.exportKwh, pvKwh: T.pvAcKwh + T.upsPvKwh });
                yield;
            }
            out.push({ id: sys.id, name: sys.name, points, baseLoadW: bl.w, recentBaseW: bl.recentW });
        }
        return out;
    }

    /** Curve point from a system variant (no band). */
    _point(sys, label, x, fo, dispatchOpts = {}) {
        const q = this._quick(normalizeSystem(sys), { dispatchOpts, fo });
        return { x, label, capexGbp: q.finance.capexGbp, savingsGbp: q.finance.year1Gbp, paybackYears: q.finance.paybackYears, npv10Gbp: q.finance.npv10Gbp, id: sys.id ?? null };
    }

    /**
     * Panels vs savings. Plug-in route: the plug-in kits actually on sale, at their prices, on the
     * same spot and direction (a kit can't be extended — UX critique); a power station beside the
     * kit (C1) stays in every option with its own price (its line, panels and frames). Other
     * routes: 1…N panels of the system's panel on its inputs, each extra panel priced from the
     * catalog's loose panel + frame; a power station runs 0…what its inputs can take (0 = the
     * station on its own, label 'No panels').
     * @param {Object} system
     * @param {{ finance?: Object }} [opts]
     * @returns {Array<{ x: number, label: string, capexGbp: number, savingsGbp: number, paybackYears: number|null, marginalGbp: number|null, kitId?: string }>}
     */
    panelCountCurve(system, { finance = {} } = {}) {
        const sys = normalizeSystem(system);
        const fo = this.financeOptions(finance);
        const pts = [];
        // a reference point, or a battery with no inverter to wire panels to, has no panel count to vary
        // (a power station without panels does: its own solar inputs)
        if (sys.route === 'reference' || (!sys.arrays.length && sys.battery?.coupling !== 'ups' && sys.route !== 'plugin')) return pts;
        const first = sys.arrays[0] ?? sys.battery?.ups?.pvArrays[0] ?? null;
        const spot = first ? { id: sys.spotId, azimuth: first.azimuth, tilt: first.tilt, kind: first.mounting === 'wall' ? 'wall' : first.mounting === 'railing' ? 'railing' : 'ground', shadingPct: first.shadingPct, horizon: first.horizon } : null;
        if (sys.route === 'plugin' || sys.route === 'whatif' && !sys.battery) {
            // a power station beside the kit (C1) stays in every option, and so does its price: its
            // own line, panels and frames are what the build costs without the kit
            const station = sys.battery?.coupling === 'ups' ? sys.battery : null;
            const year0 = (cs) => cs.reduce((s, c) => s + (c.year === 0 ? c.gbp : 0), 0);
            const stationGbp = station ? Math.round((year0(sys.costs) - year0(applyRulesFix(sys, { type: 'removeBattery' }, this.catalog).costs)) * 100) / 100 : 0;
            for (const kit of pluginKits(this.catalog)) {
                const s = kitToSystem(kit, { spot, catalog: this.catalog, dsSource: this.ds0.meta?.source, id: kit.id });
                const wp = kit.includedPanels.count * kit.includedPanels.wp;
                const costs = stationGbp ? [...s.costs, { label: 'Power station and its own panels', gbp: stationGbp, year: 0, kind: 'hardware' }] : s.costs;
                pts.push({ ...this._point({ ...s, battery: station, costs }, kit.name, wp, fo), kitId: kit.id });
            }
        } else {
            const panel = this.catalog.parts?.panel;
            const frame = this.catalog.parts?.frame;
            const perPanel = (panel?.priceGbp ?? 80) + (frame?.priceGbp ?? 40);
            const station = !sys.arrays.length && sys.battery?.coupling === 'ups';
            const wp = first?.wp ?? panel?.includedPanels?.wp ?? 460;
            const now = station ? sys.battery.ups.pvArrays.reduce((s, a) => s + a.count, 0) : sys.arrays.reduce((s, a) => s + a.count, 0);
            const st = station ? stationProduct(this.catalog, sys) : null;
            const maxN = station ? Math.max(1, st?.pvWireablePanels ?? sys.battery.ups.pvInputs.length ?? 1)
                : Math.max(1, Math.min(12, Math.floor((sys.inverter?.inputs ?? []).reduce((s, x) => s + (x.maxDcW ?? 0), 0) / Math.max(1, wp)) || 4));
            const o = orientationForSpot(spot);
            const baseCapex = sys.costs.reduce((s, c) => s + (c.year === 0 ? c.gbp : 0), 0);
            // a power station also has a "no panels" step: the station on its own (a grid-tied build
            // without panels is no build at all)
            for (let k = station ? 0 : 1; k <= maxN; k++) {
                let s;
                if (station && k === 0) {
                    s = { ...sys, battery: { ...sys.battery, ups: { ...sys.battery.ups, pvArrays: [] } } };
                } else if (station) {
                    const nIn = Math.max(1, sys.battery.ups.pvInputs.length);
                    const per = new Array(Math.min(nIn, k)).fill(1);
                    for (let i = per.length; i < k; i++) per[0]++;
                    const pvArrays = per.map((c, q) => ({ id: `s${q}`, count: c, wp, tilt: o.tilt, azimuth: o.azimuth, mounting: o.mounting, shadingPct: o.shadingPct, horizon: o.horizon, input: q }));
                    s = { ...sys, battery: { ...sys.battery, ups: { ...sys.battery.ups, pvArrays } } };
                } else {
                    const nIn = Math.max(1, sys.inverter?.inputs.length ?? 1);
                    const per = new Array(Math.min(nIn, k)).fill(0);
                    for (let i = 0; i < k; i++) per[i % per.length]++;
                    s = { ...sys, arrays: per.map((c, q) => ({ ...(sys.arrays[q] ?? first ?? {}), id: `a${q}`, count: c, wp, input: q })) };
                }
                const gbp = Math.round((baseCapex + (k - now) * perPanel) * 100) / 100;
                s.costs = [...sys.costs.filter((c) => c.year !== 0), { label: k === now ? 'System as configured' : k === 0 ? 'Without panels' : `System with ${k} panels`, gbp, year: 0, kind: 'hardware' }];
                pts.push(this._point(s, k === 0 ? 'No panels' : `${k} × ${wp} W`, k * wp, fo, COARSE));
            }
        }
        pts.sort((a, b) => a.x - b.x || a.capexGbp - b.capexGbp);
        for (let i = 0; i < pts.length; i++) pts[i].marginalGbp = i === 0 ? null : pts[i].savingsGbp - pts[i - 1].savingsGbp;
        return pts;
    }

    /**
     * Battery size vs savings with the product's real expansion steps and prices (UX critique
     * Compare §5): x = usable capacity (kWh), threshold automation at the coarse δ.
     * Step 0 is "no battery" where removing it is meaningful (an add-on or a power station);
     * expansion packs are added one at a time (up to 3) at their catalog price.
     * @param {Object} system
     * @param {{ finance?: Object, maxSteps?: number }} [opts]
     * @returns {Array<{ x: number, label: string, capexGbp: number, savingsGbp: number, paybackYears: number|null, marginalGbp: number|null }>}
     */
    batterySizeCurve(system, { finance = {}, maxSteps = 3 } = {}) {
        const sys = normalizeSystem(system);
        const fo = this.financeOptions(finance);
        if (!sys.battery) return [];
        const b = sys.battery;
        const products = sys.sourceIds.map((id) => findProduct(this.catalog, id)).filter(Boolean);
        const unit = products.find((p) => p.battery || p.kind === 'power-station') ?? null;
        const steps = (unit?.expansion ?? []).filter((e) => Number.isFinite(e.priceGbp) && e.kwh > 0);
        // the catalog lists the maker's own extra battery first: that pack is stacked 1…maxSteps
        // times; every other priced option is shown once (e.g. a bigger pack from a sister range)
        const pack = steps[0] ?? null;
        const pts = [];
        const capex = sys.costs.reduce((s, c) => s + (c.year === 0 ? c.gbp : 0), 0);
        const allInOne = b.coupling === 'dc' && sys.arrays.length > 0;
        if (!allInOne) {
            // without the battery a battery-only build (H4, a power station) buys nothing at all —
            // not even the electrician — while a build with panels keeps everything else except what
            // came with the battery: its own line, and a station's own panels and frames, which do
            // nothing without it (rules removeBattery: C1 keeps only the plug-in kit)
            const bare = applyRulesFix(sys, { type: 'removeBattery' }, this.catalog);
            const gbp = weatherDependent(bare) ? bare.costs.reduce((s, c) => s + (c.year === 0 ? c.gbp : 0), 0) : 0;
            const s0 = { ...bare, costs: [{ label: 'Without the battery', gbp, year: 0, kind: 'hardware' }] };
            pts.push(this._point(s0, 'No battery', 0, fo));
        }
        const usable = (cap) => cap * (1 - b.minSocPct / 100);
        pts.push(this._point(sys, `${b.capacityKwh.toFixed(2)} kWh (as configured)`, usable(b.capacityKwh), fo, COARSE));
        if (pack) {
            for (let k = 1; k <= maxSteps; k++) {
                const cap = b.capacityKwh + k * pack.kwh;
                const s = { ...sys, battery: { ...b, capacityKwh: cap }, costs: [...sys.costs, { label: `${k} × ${pack.model}`, gbp: k * pack.priceGbp, year: 0, kind: 'hardware' }] };
                pts.push(this._point(s, `+${k} × ${pack.kwh} kWh`, usable(cap), fo, COARSE));
            }
            for (const other of steps.slice(1)) {
                const cap = b.capacityKwh + other.kwh;
                const gbp = Math.round((capex + other.priceGbp) * 100) / 100;
                if (pts.some((p) => Math.abs(p.x - usable(cap)) < 1e-9 && Math.abs(p.capexGbp - gbp) < 0.01)) continue;
                const s = { ...sys, battery: { ...b, capacityKwh: cap }, costs: [...sys.costs, { label: other.model, gbp: other.priceGbp, year: 0, kind: 'hardware' }] };
                pts.push(this._point(s, `+${other.kwh} kWh (${other.model.split('(')[0].trim()})`, usable(cap), fo, COARSE));
            }
        }
        pts.sort((a, c) => a.x - c.x || a.capexGbp - c.capexGbp);
        for (let i = 0; i < pts.length; i++) pts[i].marginalGbp = i === 0 ? null : pts[i].savingsGbp - pts[i - 1].savingsGbp;
        return pts;
    }

    /* ───────────────────────── slots: typical day & CSV ───────────────────────── */

    _slotSim(system) {
        const sys = normalizeSystem(system);
        const key = `${physicsKey(sys)}|${this.projectBaseW}`;
        let r = this._slotSims.get(key);
        if (!r) r = this._slotSims.set(key, { sys, sim: this._sim(sys, { includeSlots: true }) });
        return r;
    }

    /** Index of the clearest complete local day within ±15 days of a month-day (any year). */
    _clearestNear(mmdd) {
        const ds = this.ds0;
        const [mm, dd] = mmdd.split('-').map(Number);
        let best = -1;
        let bestG = -Infinity;
        ds.local.days.forEach((d, i) => {
            if (d.count < 46) return;
            const [y, m, day] = d.date.split('-').map(Number);
            const target = Date.UTC(y, mm - 1, dd);
            const at = Date.UTC(y, m - 1, day);
            const off = Math.min(...[-1, 0, 1].map((k) => Math.abs(at - Date.UTC(y + k, mm - 1, dd)))) / 86400000;
            if (off > 15 || !Number.isFinite(target)) return;
            let g = 0;
            for (let t = d.first; t < d.first + d.count; t++) g += ds.ghi[t] > 0 ? ds.ghi[t] : 0;
            if (g > bestG) { bestG = g; best = i; }
        });
        return best;
    }

    /**
     * One day of the typical-weather run, half-hour by half-hour.
     * 'summer' = the clearest complete day within ±15 days of 21 June, 'winter' the same around
     * 21 December, or an explicit local date in the data.
     * @param {Object} system
     * @param {'summer'|'winter'|string} which
     * Slots also carry a power station's own panels (upsPv: DC kWh into it; upsPvWasted: what it
     * could not take), the battery's stored-side flows (battIn/battOut, kWh into/out of the cells —
     * a station's own-panel and dc charging included) and gridChg (AC kWh bought to charge).
     * @returns {{ date: string, which: string, slots: Array<{ t, ms, hh, time, load, pvAc, pvDirectAc, battNet, imp, exp, soc, price, exportPrice, clipped,
     *   upsPv, upsPvWasted, battIn, battOut, gridChg }> }}
     */
    typicalDay(system, which = 'summer') {
        const ds = this.ds;
        let di;
        if (which === 'summer') di = this._clearestNear('06-21');
        else if (which === 'winter') di = this._clearestNear('12-21');
        else di = ds.local.days.findIndex((d) => d.date === which);
        if (di < 0) throw new RangeError(`typicalDay: no data for ${which}`);
        const day = ds.local.days[di];
        const { sys, sim } = this._slotSim(system);
        const sl = sim.slots;
        const x = this._exportPaid(sys);
        const slots = [];
        for (let t = day.first; t < day.first + day.count; t++) {
            const ms = ds.start + t * 1_800_000;
            const lp = localParts(ms);
            slots.push({
                t, ms, hh: ds.local.hh[t], time: `${String(Math.floor(lp.minutes / 60)).padStart(2, '0')}:${String(lp.minutes % 60).padStart(2, '0')}`,
                load: sl.load[t], pvAc: sl.pvAc[t], pvDirectAc: sl.pvDirectAc[t], battNet: sl.battOutAc[t] - sl.battChgAc[t],
                imp: sl.imp[t], exp: sl.exp[t], soc: sl.soc[t], price: ds.importPrice[t], exportPrice: x ? x[t] : 0, clipped: sl.clipped[t],
                upsPv: sl.upsPv[t], upsPvWasted: sl.upsPvWasted[t], battIn: sl.battIn[t], battOut: sl.battOut[t], gridChg: sl.gridChg[t],
            });
        }
        return { date: day.date, which, slots };
    }

    /** Export price as paid for the system's export kind (null = none). */
    _exportPaid(sys) {
        const k = sys.export.kind;
        if (k === 'none') return null;
        if (k === 'flat') return new Float64Array(this.ds.n).fill(sys.export.flatP);
        return this.ds.exportPrices?.[k] ?? null;
    }

    /**
     * Half-hourly CSV of the typical-weather run (UTC and local time, load, solar, grid, battery,
     * prices as billed, saving per half-hour as billed).
     * @param {Object} system
     * @returns {string}
     */
    exportCsv(system) {
        const ds = this.ds;
        const { sys, sim } = this._slotSim(system);
        const sl = sim.slots;
        const x = this._exportPaid(sys);
        const L0 = ds.load;
        const rows = ['time_utc,time_local,load_kwh,pv_ac_kwh,import_kwh,export_kwh,battery_net_kwh,battery_soc_kwh,import_price_p,export_price_p,saving_p'];
        const f4 = (v) => (Math.abs(v) < 5e-7 ? '0' : v.toFixed(4));
        for (let t = 0; t < ds.n; t++) {
            const ms = ds.start + t * 1_800_000;
            const lp = localParts(ms);
            const p = ds.importPrice[t];
            const xp = x ? x[t] : 0;
            const saving = L0[t] * p - (sl.imp[t] * p - sl.exp[t] * xp);
            rows.push([
                new Date(ms).toISOString().slice(0, 16) + 'Z',
                `${lp.date} ${String(Math.floor(lp.minutes / 60)).padStart(2, '0')}:${String(lp.minutes % 60).padStart(2, '0')}`,
                f4(sl.load[t]), f4(sl.pvAc[t]), f4(sl.imp[t]), f4(sl.exp[t]), f4(sl.battOutAc[t] - sl.battChgAc[t]), f4(sl.soc[t]),
                p.toFixed(3), xp.toFixed(3), saving.toFixed(3),
            ].join(','));
        }
        return rows.join('\n') + '\n';
    }

    /* ───────────────────────── answers the verdict needs ───────────────────────── */

    /**
     * Power-station strategies for the verdict's UPS answer (UX critique answers.ups): realistic
     * (threshold), best case (optimal), the smart-plug 4–7pm cut (recharge after 7pm), and what
     * disabling the bypass costs against optimal (at the unit's real charge rate). First-year £ on
     * the headline's basis (the station's share aged by its year-1 state of health), marginal over
     * the same system without the station: realisticGbp of a threshold station equals its
     * headline.savingsGbp. bestCaseGbp is never below realisticGbp (the optimiser's SoC grid
     * truncates the charger's power, and without panels the day-ahead planner is near-optimal);
     * onlinePenaltyGbp compares the two optimiser runs.
     * @param {Object} system a system with a 'ups' battery
     * @param {{ finance?: Object }} [opts]
     * @returns {{ realisticGbp, bestCaseGbp, peakCutGbp, onlineGbp, onlinePenaltyGbp, onlineWarnings: string[], switchMs,
     *   serverSafeSwitch: boolean, holdUpMs: number, hid, bypassDisableable } | null}
     */
    upsStrategies(system, { finance = {} } = {}) {
        const sys = normalizeSystem(system);
        if (sys.battery?.coupling !== 'ups') return null;
        const fo = this.financeOptions(finance);
        // the station's catalog facts (switchover, HID) come from its product, found by kind: C1's
        // kitId is the plug-in kit beside it
        const st = stationProduct(this.catalog, sys);
        const key = `ups|${physicsKey(sys)}|${st?.id ?? ''}|${this.projectBaseW}|${stable(fo)}`;
        const hit = this._misc.get(key);
        if (hit) return hit;
        const b = sys.battery;
        // marginal over the same system without the station, on the headline's basis (the
        // station's share aged by its year-1 state of health), so realisticGbp matches a
        // threshold scenario's headline exactly
        const baseSim = this._sim({ ...sys, battery: null });
        const base = this._value(baseSim, fo);
        const y1 = (s, sim) => this._yearOneGbp(s, sim, baseSim, fo);
        const v = (s) => { const n = normalizeSystem(s); return y1(n, this._sim(n)) - base; };
        const thr = v(withStrategy(sys, 'threshold'));
        const optDp = v(withStrategy(sys, 'optimal'));
        // the optimiser's SoC grid truncates the charger's power, and on a station without panels
        // the day-ahead planner is near-optimal: best case is never below the realistic figure
        const opt = Math.max(optDp, thr);
        const plug = v({ ...sys, battery: { ...b, strategy: 'schedule', schedule: { ...b.schedule, chargeWindow: ['19:00', '16:00'], dischargeWindow: ['16:00', '19:00'] } } });
        const onlineSys = normalizeSystem({ ...sys, battery: { ...b, strategy: 'optimal', ups: { ...b.ups, bypass: 'disabled' } } });
        const onlineSim = this._sim(onlineSys);
        const online = y1(onlineSys, onlineSim) - base;
        return this._misc.set(key, {
            realisticGbp: thr,
            bestCaseGbp: opt,
            peakCutGbp: plug,
            onlineGbp: online,
            // optimiser against optimiser (same SoC grid)
            onlinePenaltyGbp: online - optDp,
            onlineWarnings: onlineSim.warnings,
            switchMs: st?.upsSwitchMs ?? null,
            // a 15–20 ms transfer can reboot a heavily loaded server: only ≤ 10 ms units are a UPS
            // the servers can rely on (REPORT-ups server caveat); holdUpMs is what an ATX 3.1 PSU
            // is only required to ride through at full load
            serverSafeSwitch: st?.serverSafeSwitch ?? false,
            holdUpMs: SERVER_HOLDUP_MS,
            hid: st?.hid ?? false,
            bypassDisableable: st?.bypassDisableable ?? false,
        });
    }

    /**
     * Payback sensitivity for one system (UX critique tornado): weather p10/p90, shading 0/15%,
     * import prices ×0.8/×1.2, price trend 0/4% a year, always-on load −30/+30%, and for batteries
     * and power stations threshold/optimal automation. Rows sorted by swing, top `top`.
     * @param {Object} system
     * @param {{ finance?: Object, top?: number }} [opts]
     * @returns {{ id, center: number|null, rows: Array<{ key, label, low, high, lowLabel, highLabel, swing }> }}
     */
    tornado(system, opts = {}) {
        return runSteps(this._tornadoSteps(system, opts));
    }

    /** tornado as steps: it yields inside its scenario run and after every row. */
    *_tornadoSteps(system, { finance = {}, top = 5 } = {}) {
        const sys = normalizeSystem(system);
        const fo = this.financeOptions(finance);
        const key = `tornado|${systemKey(sys)}|${this.projectBaseW}|${stable(fo)}|${top}`;
        const hit = this._misc.get(key);
        if (hit) return hit;
        const res = yield* this._runScenarioSteps(sys, { finance });
        const cap = fo.years + 5;
        const pb = (f) => f?.paybackYears ?? null;
        const swingOf = (a, b) => Math.abs((a ?? cap) - (b ?? cap));
        const rows = [];
        const add = (k, label, low, high, lowLabel, highLabel) => rows.push({ key: k, label, low, high, lowLabel, highLabel, swing: swingOf(low, high) });
        if (res.financeBand) add('weather', 'Weather year', pb(res.financeBand.p10), pb(res.financeBand.p90), 'dull year (p10)', 'sunny year (p90)');
        const allArrays = (fn) => ({ ...sys, arrays: sys.arrays.map(fn), battery: sys.battery?.coupling === 'ups'
            ? { ...sys.battery, ups: { ...sys.battery.ups, pvArrays: sys.battery.ups.pvArrays.map(fn) } } : sys.battery });
        if (weatherDependent(sys)) {
            const shade = (pct) => pb(this._quick(normalizeSystem(allArrays((a) => ({ ...a, shadingPct: pct, shadingExplicit: true }))), { fo }).finance);
            add('shading', 'Shading at your spot', shade(0), shade(15), 'no shade', '15% shaded');
            yield;
        }
        const scaled = (k) => {
            const ds = this.ds;
            const mul = (arr) => (arr ? Float64Array.from(arr, (v) => v * k) : arr);
            return { ...ds, id: `${ds.id}~p${k}`, importPrice: mul(ds.importPrice), importPriceExc: mul(ds.importPriceExc), importPriceFwdExc: mul(ds.importPriceFwdExc) };
        };
        add('price', 'Agile price level', pb(this._quick(sys, { ds: scaled(0.8), fo }).finance), pb(this._quick(sys, { ds: scaled(1.2), fo }).finance), 'prices −20%', 'prices +20%');
        yield;
        const q0 = this._quick(sys, { fo: this.financeOptions({ ...finance, escalation: 0 }) });
        const q4 = this._quick(sys, { fo: this.financeOptions({ ...finance, escalation: 0.04 }) });
        add('trend', 'Price trend', pb(q0.finance), pb(q4.finance), '0% a year', '4% a year');
        yield;
        const b = estimateBaseLoad(this.ds).w;
        const bl = (k) => pb(this._quick(sys, { ds: withBaseLoad(this.ds, b, b * k), fo, dispatchOpts: COARSE }).finance);
        add('baseLoad', 'Always-on load', bl(0.7), bl(1.3), '−30%', '+30%');
        yield;
        if (sys.battery) {
            add('automation', 'Battery automation', pb(this._quick(withStrategy(sys, 'threshold'), { fo }).finance),
                pb(this._quick(withStrategy(sys, 'optimal'), { fo }).finance), 'realistic', 'perfect timing');
            yield;
        }
        rows.sort((a, c) => c.swing - a.swing);
        return this._misc.set(key, { id: sys.id, center: res.finance.paybackYears, rows: rows.slice(0, top), all: rows });
    }
}
