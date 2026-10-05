/*
 * system.js — the System schema: one candidate purchase (panels, inverter, battery or power
 * station, export tariff, costs) in a canonical, fully-defaulted shape.
 *
 * Everything downstream (pv.js, battery.js, simulate.js, finance.js, the rules and the cache keys)
 * reads systems through normalizeSystem(), so a partial object from the UI, a catalog kit or a
 * saved scenario always produces the same physics. Normalisation clamps instead of throwing: a
 * half-typed form must still simulate; rules.js is where impossible builds are reported.
 *
 * Units follow CONTRACTS §0: W, kWh, p, £ (…Gbp), compass azimuth 0 = N clockwise.
 */

/** @typedef {{ id: string, name: string, count: number, wp: number, tilt: number, azimuth: number, input: number,
 *   mounting: 'open'|'roof'|'railing'|'wall', groundSelfShade: boolean, albedo: number, tempCoeffPct: number,
 *   dcModel: 'pvwatts'|'huld2025'|'huld', lowLightK: number, bifaciality: number, rearShading: number, shadingPct: number,
 *   beamShadingPct: number, diffuseShadingPct: number, horizon: number[], shadingExplicit: boolean,
 *   transposition?: string, iamAr?: number, faiman?: number[] }} PvArray (optional fields pass through to pv.js) */
/** @typedef {{ acLimitW: number, etaNom: number, inputs: Array<{ maxDcW: number, maxAcW: number }>, standbyW: number,
 *   supportsPowerLimit: boolean }} Inverter */
/** @typedef {{ dedicatedW: 'baseload'|number, outletMaxW: number, etaInv: number, chargeEff: number, chargeW: number,
 *   fixedLossW: number|null, bypassW: number, bypass: 'auto'|'disabled', pvArrays: PvArray[],
 *   pvInputs: Array<{ maxDcW: number }>, inputLimitW: number }} UpsSpec */
/** @typedef {Object} Battery  see DEFAULTS.battery for every field */
/** @typedef {{ label: string, gbp: number, year: number, kind: 'hardware'|'install'|'other' }} CostItem */
/** @typedef {{ atYear: number, label: string, battery?: Battery, addArrays?: PvArray[], route?: 'hardwired'|'whatif', costs: CostItem[] }} Upgrade */
/** @typedef {Object} System  see normalizeSystem() */

const ROUTES = ['plugin', 'hardwired', 'ups', 'whatif', 'reference'];
const MOUNTINGS = ['open', 'roof', 'railing', 'wall'];
const DC_MODELS = ['pvwatts', 'huld2025', 'huld'];
const COUPLINGS = ['dc', 'ac', 'ups'];
/** Every strategy id battery.js understands; 'online' is UPS-only (bypass disabled, for the penalty figure). */
const STRATEGIES = ['self', 'fixed', 'schedule', 'threshold', 'smart', 'optimal', 'online'];
const EXPORT_KINDS = ['none', 'prime', 'fixed', 'agile', 'flat'];
const COST_KINDS = ['hardware', 'install', 'other'];

/**
 * Default field values. `array` and `inverter` describe the generic GB plug-in kit: dual-input
 * 800 W micro-inverter whose inputs behave as two independent ~400 W channels (verified on the
 * Hoymiles HMS-800), so one panel per input is the realistic wiring.
 */
export const DEFAULTS = Object.freeze({
    array: Object.freeze({
        id: 'a0', name: 'Panels', count: 2, wp: 460, tilt: 35, azimuth: 180, input: 0, mounting: 'open',
        groundSelfShade: false, albedo: 0.2, tempCoeffPct: -0.30, dcModel: 'pvwatts', lowLightK: 0.0064,
        bifaciality: 0, rearShading: 0.6, shadingPct: 3, beamShadingPct: 0, diffuseShadingPct: 0,
        horizon: Object.freeze([]),
    }),
    inverter: Object.freeze({
        acLimitW: 800, etaNom: 0.96,
        inputs: Object.freeze([Object.freeze({ maxDcW: 1000, maxAcW: 400 }), Object.freeze({ maxDcW: 1000, maxAcW: 400 })]),
        standbyW: 0, supportsPowerLimit: false,
    }),
    battery: Object.freeze({
        coupling: 'dc', capacityKwh: 2, minSocPct: 10, maxChargeW: 1000, maxDischargeW: 800, acChargeW: 0,
        effCharge: 0.96, effDischarge: 0.96, acChargeEff: 0.93, acEffCharge: 0.92, acEffDischarge: 0.92, acOutputW: 800,
        standbyW: 10, allowGridExport: false, strategy: 'threshold', fixedOutputW: null,
        schedule: Object.freeze({ chargeBelowP: null, chargeWindow: Object.freeze(['00:00', '06:00']), dischargeWindow: Object.freeze(['16:00', '19:00']) }),
        replanAt: '16:00', wearPPerKwh: 2, deltaKwh: 0.025, cycles: 6000, lifeYears: 15, pvForecast: 'persistence',
        ups: null,
    }),
    // Power-station defaults from the UPS research loss model (P_dc = P_ac/0.94 + P0 while inverting,
    // ~8 W relay/fan overhead while in bypass, 0.87–0.88 measured charger efficiency). fixedLossW null
    // means "not measured for this unit": battery.js then assumes 20 W (≤2.5 kWh) or 30 W.
    ups: Object.freeze({
        dedicatedW: 'baseload', outletMaxW: 1800, etaInv: 0.94, chargeEff: 0.88, chargeW: 800, fixedLossW: null,
        bypassW: 8, bypass: 'auto', pvArrays: Object.freeze([]), pvInputs: Object.freeze([]),
        // A UK 13 A plug (or smart plug) carries ~2990 W; in bypass the servers and the charger share it.
        inputLimitW: 2990,
    }),
});

/* ── small coercion helpers (never throw) ── */

function num(v, def, lo = -Infinity, hi = Infinity) {
    const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof x !== 'number' || !Number.isFinite(x)) return def;
    return x < lo ? lo : x > hi ? hi : x;
}
/** Like num() but keeps an explicit null (meaning "unknown / use the physics default"). */
function numOrNull(v, def, lo, hi) {
    if (v === null) return null;
    return num(v, def, lo, hi);
}
function int(v, def, lo, hi) {
    return Math.round(num(v, def, lo, hi));
}
function oneOf(v, list, def) {
    return list.includes(v) ? v : def;
}
function bool(v, def) {
    return typeof v === 'boolean' ? v : def;
}
function str(v, def) {
    return typeof v === 'string' && v.length ? v : def;
}
function clock(v, def) {
    return typeof v === 'string' && /^([01]?\d|2[0-4]):[0-5]\d$/.test(v) ? v : def;
}
function wrapAz(a) {
    const r = a % 360;
    return r < 0 ? r + 360 : r;
}

/**
 * Normalise one PV array (plane of panels on one inverter input).
 * The 3% lumped shading default is dropped when the user has described shading explicitly
 * (horizon profile or beam/diffuse fractions) and did not set shadingPct themselves — otherwise
 * the same obstruction is counted twice (engine critique, shading amendment).
 * @param {Partial<PvArray>} [p]
 * @param {number} [i] index, used for default id/name
 * @param {number} [nInputs] inverter input count; `input` is clamped below it
 * @returns {PvArray}
 */
export function normalizeArray(p = {}, i = 0, nInputs = Infinity) {
    const d = DEFAULTS.array;
    p = p && typeof p === 'object' ? p : {};
    const mounting = oneOf(p.mounting, MOUNTINGS, d.mounting);
    const horizon = Array.isArray(p.horizon) ? p.horizon.map((h) => num(h, 0, 0, 90)) : [];
    const beamShadingPct = num(p.beamShadingPct, 0, 0, 100);
    const diffuseShadingPct = num(p.diffuseShadingPct, 0, 0, 100);
    const explicitShading = horizon.length > 0 || beamShadingPct > 0 || diffuseShadingPct > 0;
    const shadingExplicit = p.shadingExplicit === true;
    const shadingPct = p.shadingPct === undefined && explicitShading && !shadingExplicit ? 0 : num(p.shadingPct, d.shadingPct, 0, 100);
    const maxInput = Number.isFinite(nInputs) ? Math.max(0, nInputs - 1) : 63;
    // pv.js also understands these optional physics overrides; keep them when given
    const extra = {};
    if (['perez', 'haydavies', 'isotropic'].includes(p.transposition)) extra.transposition = p.transposition;
    if (typeof p.iamAr === 'number' && p.iamAr > 0 && Number.isFinite(p.iamAr)) extra.iamAr = p.iamAr;
    if (Array.isArray(p.faiman) && p.faiman.length === 2 && p.faiman.every((v) => typeof v === 'number' && Number.isFinite(v))) extra.faiman = [...p.faiman];
    return {
        id: str(p.id, `a${i}`),
        name: str(p.name, i === 0 ? d.name : `Panels ${i + 1}`),
        count: int(p.count, d.count, 0, 200),
        wp: num(p.wp, d.wp, 0, 2000),
        tilt: num(p.tilt, d.tilt, 0, 90),
        azimuth: wrapAz(num(p.azimuth, d.azimuth)),
        input: int(p.input, 0, 0, maxInput),
        mounting,
        groundSelfShade: bool(p.groundSelfShade, mounting === 'railing' || mounting === 'wall'),
        albedo: num(p.albedo, d.albedo, 0, 1),
        tempCoeffPct: num(p.tempCoeffPct, d.tempCoeffPct, -1, 0),
        dcModel: oneOf(p.dcModel, DC_MODELS, d.dcModel),
        lowLightK: num(p.lowLightK, d.lowLightK, 0, 0.05),
        bifaciality: num(p.bifaciality, d.bifaciality, 0, 1),
        rearShading: num(p.rearShading, d.rearShading, 0, 1),
        shadingPct,
        beamShadingPct,
        diffuseShadingPct,
        horizon,
        shadingExplicit,
        ...extra,
    };
}

/**
 * Normalise an inverter. No inverter at all → DEFAULTS.inverter (the common dual 400 W-channel
 * micro, extended if arrays name more inputs). A partial inverter without `inputs` gets one
 * neutral input per wired array input (no per-input AC cap beyond the total).
 * @param {Partial<Inverter>|null} p
 * @param {number} [minInputs] inputs the arrays reference (ignored when inputs are explicit)
 * @returns {Inverter}
 */
export function normalizeInverter(p, minInputs = 1) {
    const d = DEFAULTS.inverter;
    if (!p || typeof p !== 'object') p = {};
    const acLimitW = num(p.acLimitW, d.acLimitW, 0, 100000);
    let inputs;
    if (Array.isArray(p.inputs) && p.inputs.length) {
        // Explicit wiring wins: arrays that name a missing input are clamped onto the last one
        // (conservative — they share its caps); rules.js reports the wiring problem.
        inputs = p.inputs.map((x) => ({
            maxDcW: num(x?.maxDcW, Math.max(1000, acLimitW), 0, 1e6),
            maxAcW: num(x?.maxAcW, acLimitW, 0, 1e6),
        }));
    } else if (p.acLimitW === undefined && p.inputs === undefined) {
        inputs = d.inputs.map((x) => ({ ...x }));
        while (inputs.length < minInputs) inputs.push({ ...d.inputs[0] });
    } else {
        inputs = [];
        while (inputs.length < Math.max(1, minInputs)) inputs.push({ maxDcW: Math.max(1000, acLimitW), maxAcW: acLimitW });
    }
    return {
        acLimitW,
        etaNom: num(p.etaNom, d.etaNom, 0.5, 1),
        inputs,
        standbyW: num(p.standbyW, d.standbyW, 0, 100),
        supportsPowerLimit: bool(p.supportsPowerLimit, d.supportsPowerLimit),
    };
}

/**
 * Normalise the power-station block of a 'ups' battery.
 * @param {Partial<UpsSpec>|null} p
 * @param {number} acOutputW the station's rated AC output, default for outletMaxW
 * @returns {UpsSpec}
 */
export function normalizeUps(p, acOutputW) {
    const d = DEFAULTS.ups;
    if (!p || typeof p !== 'object') p = {};
    const pvArrays = Array.isArray(p.pvArrays) ? p.pvArrays.map((a, i) => normalizeArray(a, i, Infinity)) : [];
    const dedicatedW = p.dedicatedW === 'baseload' || p.dedicatedW === undefined || p.dedicatedW === null
        ? 'baseload' : num(p.dedicatedW, 0, 0, 100000);
    return {
        dedicatedW,
        outletMaxW: num(p.outletMaxW, acOutputW > 0 ? acOutputW : d.outletMaxW, 0, 100000),
        etaInv: num(p.etaInv, d.etaInv, 0.5, 1),
        chargeEff: num(p.chargeEff, d.chargeEff, 0.5, 1),
        chargeW: num(p.chargeW, d.chargeW, 0, 100000),
        fixedLossW: numOrNull(p.fixedLossW, null, 0, 1000),
        bypassW: num(p.bypassW, d.bypassW, 0, 1000),
        bypass: oneOf(p.bypass, ['auto', 'disabled'], d.bypass),
        pvArrays,
        pvInputs: Array.isArray(p.pvInputs) ? p.pvInputs.map((x) => ({ maxDcW: num(x?.maxDcW, 500, 0, 1e6) })) : [],
        inputLimitW: num(p.inputLimitW, d.inputLimitW, 0, 100000),
    };
}

/**
 * Normalise a battery (dc-coupled all-in-one, ac-coupled home battery, or a power station
 * used like a UPS). capacityKwh is nominal DC; sMin = minSocPct·capacity·SoH and
 * sMax = capacity·SoH (capacity-semantics amendment). maxChargeW/maxDischargeW are at the DC bus
 * for 'dc' and at the AC terminals for 'ac'/'ups'.
 * @param {Partial<Battery>|null} p
 * @returns {Battery|null}
 */
export function normalizeBattery(p) {
    if (!p || typeof p !== 'object') return null;
    const d = DEFAULTS.battery;
    const coupling = oneOf(p.coupling, COUPLINGS, d.coupling);
    const sched = p.schedule && typeof p.schedule === 'object' ? p.schedule : {};
    const cw = Array.isArray(sched.chargeWindow) ? sched.chargeWindow : d.schedule.chargeWindow;
    const dw = Array.isArray(sched.dischargeWindow) ? sched.dischargeWindow : d.schedule.dischargeWindow;
    const acOutputW = num(p.acOutputW, d.acOutputW, 0, 100000);
    return {
        coupling,
        capacityKwh: num(p.capacityKwh, d.capacityKwh, 0, 200),
        minSocPct: num(p.minSocPct, d.minSocPct, 0, 95),
        maxChargeW: num(p.maxChargeW, d.maxChargeW, 0, 100000),
        maxDischargeW: num(p.maxDischargeW, d.maxDischargeW, 0, 100000),
        acChargeW: num(p.acChargeW, d.acChargeW, 0, 100000),
        effCharge: num(p.effCharge, d.effCharge, 0.5, 1),
        effDischarge: num(p.effDischarge, d.effDischarge, 0.5, 1),
        acChargeEff: num(p.acChargeEff, d.acChargeEff, 0.5, 1),
        acEffCharge: num(p.acEffCharge, d.acEffCharge, 0.5, 1),
        acEffDischarge: num(p.acEffDischarge, d.acEffDischarge, 0.5, 1),
        acOutputW,
        standbyW: num(p.standbyW, d.standbyW, 0, 1000),
        allowGridExport: bool(p.allowGridExport, d.allowGridExport),
        strategy: oneOf(p.strategy, STRATEGIES, d.strategy),
        fixedOutputW: numOrNull(p.fixedOutputW ?? null, null, 0, 100000),
        schedule: {
            chargeBelowP: numOrNull(sched.chargeBelowP ?? null, null, -1000, 1000),
            chargeWindow: [clock(cw[0], d.schedule.chargeWindow[0]), clock(cw[1], d.schedule.chargeWindow[1])],
            dischargeWindow: [clock(dw[0], d.schedule.dischargeWindow[0]), clock(dw[1], d.schedule.dischargeWindow[1])],
        },
        replanAt: clock(p.replanAt, d.replanAt),
        wearPPerKwh: num(p.wearPPerKwh, d.wearPPerKwh, 0, 100),
        deltaKwh: num(p.deltaKwh, d.deltaKwh, 0.005, 1),
        cycles: num(p.cycles, d.cycles, 100, 100000),
        lifeYears: num(p.lifeYears, d.lifeYears, 1, 40),
        pvForecast: oneOf(p.pvForecast, ['persistence', 'perfect'], d.pvForecast),
        ups: coupling === 'ups' ? normalizeUps(p.ups, acOutputW) : null,
    };
}

/**
 * @param {Partial<CostItem>} c
 * @returns {CostItem}
 */
function normalizeCost(c) {
    c = c && typeof c === 'object' ? c : {};
    return {
        label: str(c.label, 'Cost'),
        gbp: num(c.gbp, 0, -1e7, 1e7),
        year: int(c.year, 0, 0, 100),
        kind: oneOf(c.kind, COST_KINDS, 'hardware'),
    };
}

function normalizeUpgrade(u) {
    if (!u || typeof u !== 'object') return null;
    return {
        atYear: int(u.atYear, 1, 1, 100),
        label: str(u.label, 'Upgrade'),
        battery: u.battery ? normalizeBattery(u.battery) : null,
        addArrays: Array.isArray(u.addArrays) ? u.addArrays.map((a, i) => normalizeArray(a, i, Infinity)) : [],
        route: u.route === 'hardwired' || u.route === 'whatif' ? u.route : null,
        costs: Array.isArray(u.costs) ? u.costs.map(normalizeCost) : [],
    };
}

/**
 * Fill every default, clamp ranges and coerce types. Idempotent; never throws.
 * A grid-tied inverter is created when there are arrays or a dc-coupled battery (which shares it);
 * otherwise `inverter` stays null (battery-only and power-station systems).
 * @param {Object} [partial]
 * @returns {System}
 */
export function normalizeSystem(partial = {}) {
    const p = partial && typeof partial === 'object' ? partial : {};
    const rawArrays = Array.isArray(p.arrays) ? p.arrays : [];
    const battery = normalizeBattery(p.battery);
    const maxInput = rawArrays.reduce((m, a) => Math.max(m, Math.round(num(a?.input, 0, 0, 63))), 0);
    const needInverter = rawArrays.length > 0 || battery?.coupling === 'dc' || (p.inverter && typeof p.inverter === 'object');
    const inverter = needInverter ? normalizeInverter(p.inverter, rawArrays.length ? maxInput + 1 : 1) : null;
    const nInputs = inverter ? inverter.inputs.length : Infinity;
    const arrays = rawArrays.map((a, i) => normalizeArray(a, i, nInputs));
    const exp = p.export && typeof p.export === 'object' ? p.export : {};
    return {
        id: str(p.id, 'custom'),
        name: str(p.name, 'Custom system'),
        route: oneOf(p.route, ROUTES, 'plugin'),
        kitId: typeof p.kitId === 'string' ? p.kitId : null,
        sourceIds: Array.isArray(p.sourceIds) ? p.sourceIds.filter((s) => typeof s === 'string') : [],
        arrays,
        inverter,
        battery,
        export: { kind: oneOf(exp.kind, EXPORT_KINDS, 'none'), flatP: num(exp.flatP, 0, -1000, 1000) },
        canCurtail: bool(p.canCurtail, false),
        loadAdjustW: num(p.loadAdjustW, 0, -1e6, 1e6),
        costs: Array.isArray(p.costs) ? p.costs.map(normalizeCost) : [],
        upgrade: normalizeUpgrade(p.upgrade),
        spotId: typeof p.spotId === 'string' ? p.spotId : null,
        featured: bool(p.featured, false),
        notes: Array.isArray(p.notes) ? p.notes.filter((s) => typeof s === 'string') : [],
    };
}

/** Deterministic JSON with sorted object keys; non-finite numbers become null (as JSON does). */
function stableStringify(v) {
    if (v === null || typeof v !== 'object') {
        if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
        return v === undefined ? 'null' : JSON.stringify(v);
    }
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return '[' + Array.from(v, stableStringify).join(',') + ']';
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

const KEY_EXCLUDE = new Set(['id', 'name', 'featured', 'notes']);

/**
 * Stable cache key of everything that changes a simulation or its finance: the normalised system
 * minus its top-level id/name/featured/notes. Two systems with equal keys simulate identically.
 * @param {Object} system (normalised or partial — it is normalised first)
 * @returns {string}
 */
export function systemKey(system) {
    const s = normalizeSystem(system);
    const o = {};
    for (const k of Object.keys(s)) if (!KEY_EXCLUDE.has(k)) o[k] = s[k];
    return stableStringify(o);
}

/**
 * Money spent in one ownership year: Σ cost items with that `year`, plus the upgrade's cost items
 * that fall in it. Upgrade cost items are relative to the upgrade: item.year 0 is paid in atYear,
 * item.year 1 the year after (finance.project books them the same way).
 * @param {Object} system
 * @param {{ year?: number }} [opts]
 * @returns {number} £
 */
export function capexGbp(system, { year = 0 } = {}) {
    const s = normalizeSystem(system);
    let sum = 0;
    for (const c of s.costs) if (c.year === year) sum += c.gbp;
    if (s.upgrade) for (const c of s.upgrade.costs) if (s.upgrade.atYear + c.year === year) sum += c.gbp;
    return sum;
}

/**
 * The system an upgrade turns this one into (stage 2): arrays appended, battery replaced,
 * route switched, upgrade removed. Used to simulate the staged plan once.
 * @param {Object} system
 * @returns {System|null} null when there is no upgrade
 */
export function upgradedSystem(system) {
    const s = normalizeSystem(system);
    if (!s.upgrade) return null;
    const u = s.upgrade;
    const arrays = [...s.arrays, ...u.addArrays.map((a, i) => ({ ...a, id: `${a.id}-u${i}` }))];
    return normalizeSystem({
        ...s,
        id: `${s.id}-stage2`,
        arrays,
        battery: u.battery ?? s.battery,
        route: u.route ?? s.route,
        upgrade: null,
    });
}
