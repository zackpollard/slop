/*
 * kits.js — the verified product catalog in the shape the engine needs, and the mapping from a
 * catalog product to a complete System (CONTRACTS §14, UX critique "kits.js normalisation").
 *
 * The catalog files are transcriptions of the verified research and carry its traps: mixed
 * efficiency bases (weighted vs peak), unknown MPPT counts, null capacities and charge rates, a
 * kit that ships hardwired despite its name, and stations whose "in stock" is a free-text string.
 * Everything that resolves those gaps happens here, once, with a flag saying it was assumed, so
 * the physics never meets a null and the UI can say what was guessed.
 *
 * Pure module: no DOM, no fetch. The worker loads data/*.json and hands them to normalizeCatalog.
 */

import { normalizeSystem } from './system.js';

/** Electrician defaults (constants.json installCostDefaultsGbp) when the constants file is absent. */
const ELECTRICIAN_FALLBACK = { gbp: 350, low: 150, high: 600, cuLow: 400, cuHigh: 900 };

/** GB plug-in and G98 limits (constants.json plugInRules / hardwiredRules) — fallbacks only. */
const LIMITS_FALLBACK = { plugin: { acMaxW: 800, dcMaxWp: 2000, maxModules: 4, devices: 1, proCheckAboveWp: 960 }, hardwiredMaxW: 3680 };

/** Default panel and frame for builds that need loose panels (H2/H3/U3 in the UX critique). */
const DEFAULT_PANEL_ID = 'astronergy-460w-bifacial-trade';
const DEFAULT_FRAME_ID = 'its-adjustable-tilt-frame-15-30';

/** Display names for the products the verdict talks about; anything else gets a derived name. */
const SHORT_NAMES = {
    'octopus-plugin-solar-1x460': 'Octopus 1×460 W',
    'octopus-plugin-solar-2x460': 'Octopus 2×460 W',
    'ecoflow-stream-micro-2x500': 'EcoFlow STREAM micro 2×500 W',
    'ecoflow-stream-facade-2x400': 'EcoFlow STREAM facade 2×400 W',
    'cityplumbing-dmegc-1x465-hiflow': 'City Plumbing 1×465 W',
    'cityplumbing-dmegc-2x515-hiflow': 'City Plumbing 2×515 W',
    'powerxpress-920-marstek': 'PowerXpress 2×460 W (Marstek)',
    'patiosun-duo': 'PatioSun Duo 2×445 W',
    'thunder-bolt-920': 'Thunder Bolt 2×460 W',
    'solarfy-duo-910': 'Solarfy Duo 2×455 W',
    'hoymiles-hf-800-wb-loose': 'Hoymiles HiFlow 800 W (loose inverter)',
    'ecoflow-stream-ultra': 'EcoFlow STREAM Ultra',
    'ecoflow-stream-ultra-x': 'EcoFlow STREAM Ultra X',
    'ecoflow-stream-ac-pro': 'EcoFlow STREAM AC Pro',
    'anker-solarbank4-e5000-pro': 'Anker Solarbank 4 Pro 5 kWh',
    'zendure-solarflow-2400-pro': 'Zendure SolarFlow 2400 Pro',
    'zendure-solarflow-2400-ac-plus': 'Zendure SolarFlow 2400 AC+',
    'thunder-vault-hibattery-1920ac': 'Thunder Vault 1.92 kWh',
    'hoymiles-hibattery-4020x': 'Hoymiles HiBattery 4020X',
    'ecoflow-stream-5000': 'EcoFlow STREAM 5000',
    'ecoflow-stream-ac-5000': 'EcoFlow STREAM AC 5000',
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const pos = (v) => (finite(v) && v > 0 ? v : null);
const round2 = (v) => Math.round(v * 100) / 100;

/** Accept either the bare array or the wrapped data file ({ kits: [...] }). */
function unwrap(v, key) {
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v[key])) return v[key];
    return [];
}

function shortName(e) {
    if (SHORT_NAMES[e.id]) return SHORT_NAMES[e.id];
    const brand = String(e.brand ?? '').split('(')[0].trim();
    const model = String(e.model ?? e.id).split('(')[0].trim();
    const name = model.toLowerCase().startsWith(brand.toLowerCase()) || !brand ? model : `${brand} ${model}`;
    return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/**
 * Route from the catalog's free-text installRoute: 'plug-in…' is a registered plug-in kit (even
 * the facade kit that is not on sale), 'hardwired…' needs an electrician, anything else is a part.
 */
function routeOf(installRoute) {
    const s = String(installRoute ?? '').toLowerCase();
    if (s.startsWith('plug-in appliance')) return 'ups';
    if (s.startsWith('plug-in')) return 'plugin';
    if (s.startsWith('hardwired')) return 'hardwired';
    return null;
}

/**
 * PVWatts ηnom from the catalog. Unknown → 0.955 (flagged). A peak ("max") efficiency overstates
 * the weighted figure PVWatts wants by about half a point, so it is reduced by 0.005.
 */
function etaFrom(eff, basis, flags) {
    if (!finite(eff) || eff <= 0 || eff > 1) {
        flags.push('efficiencyAssumed');
        return 0.955;
    }
    if (/^\s*peak/i.test(String(basis ?? ''))) {
        flags.push('efficiencyPeakCorrected');
        return Math.round((eff - 0.005) * 10000) / 10000;
    }
    return eff;
}

/**
 * Inverter solar inputs from the catalog. Dual-input 800 W micro-inverters (Fox M1-800-E,
 * Hoymiles HMS-800, Marstek, the EcoFlow micro) behave as independent channels of acLimit/inputs
 * each (verified on the HMS-800), so maxAcW = acLimit/inputs. All-in-one battery units put every
 * MPPT on one DC bus behind the battery, so only the MPPT DC limit applies per input (maxAcW =
 * the unit's AC limit) — DC beyond the AC limit is what their battery soaks up.
 */
function inputsFrom(raw, kind, acLimitW, flags) {
    let mppts = finite(raw.mppts) && raw.mppts > 0 ? Math.round(raw.mppts) : null;
    const listed = Array.isArray(raw.pvInputs) ? raw.pvInputs : null;
    if (mppts === null && listed?.length) mppts = listed.length;
    if (mppts === null) {
        flags.push('inputsUnknown');
        mppts = 1;
    }
    const perInputDc = pos(raw.pvInputMaxW) ? raw.pvInputMaxW / mppts : null;
    const allInOne = kind === 'battery-inverter';
    const inputs = [];
    for (let q = 0; q < mppts; q++) {
        const spec = listed?.[q] ?? null;
        // unknown per-input DC limit: the kit's total over its inputs, else no tighter than the AC channel
        const maxDcW = pos(spec?.maxDcW) ?? perInputDc ?? Math.max(1000, acLimitW);
        const maxAcW = allInOne || mppts === 1 ? acLimitW : acLimitW / mppts;
        inputs.push({ maxDcW, maxAcW });
    }
    return { mppts, inputs };
}

/**
 * Battery block of a battery-inverter (dc-coupled all-in-one) or battery-addon (ac-coupled) kit.
 * Capacity semantics (engine critique): usableKwh distinct from batteryKwh means the maker already
 * netted the reserve → capacity = usable, minSoc 0; otherwise nominal with the 10% reserve applied
 * once by the physics. Charge rates: maxChargeW null → acChargeW (UX critique). For dc units the
 * catalog's discharge rating is AC, so the DC-bus limit is AC/ηnom.
 */
function batteryFrom(raw, kind, etaNom, acLimitW, flags) {
    if (kind !== 'battery-inverter' && kind !== 'battery-addon') return null;
    const coupling = raw.coupling === 'ac' || raw.coupling === 'dc' ? raw.coupling : kind === 'battery-addon' ? 'ac' : 'dc';
    const nominal = pos(raw.batteryKwh) ?? 0;
    const usable = pos(raw.usableKwh);
    const netted = usable !== null && Math.abs(usable - nominal) > 1e-9;
    let maxDischargeW = pos(raw.maxDischargeW) ?? acLimitW;
    let maxChargeW = pos(raw.maxChargeW);
    let acChargeW = pos(raw.acChargeW);
    if (maxChargeW === null) {
        maxChargeW = acChargeW ?? maxDischargeW;
        flags.push('chargeRateAssumed');
    }
    if (acChargeW === null) {
        // e.g. HiBattery 4020X: "grid charging in cheap TOU periods supported (power not stated)"
        acChargeW = maxChargeW;
        flags.push('gridChargeRateAssumed');
    }
    const b = {
        coupling,
        capacityKwh: netted ? usable : nominal,
        minSocPct: netted ? 0 : 10,
        maxChargeW,
        acChargeW,
        cycles: pos(raw.cycles) ?? 6000,
        lifeYears: 15,
        warrantyYears: pos(raw.warrantyYears),
        standbyW: 10,
    };
    if (!pos(raw.cycles)) flags.push('cyclesAssumed');
    if (coupling === 'dc') {
        b.maxDischargeW = Math.round((Math.min(maxDischargeW, acLimitW) / etaNom) * 10) / 10;
    } else {
        b.maxDischargeW = Math.min(maxDischargeW, acLimitW);
        b.acOutputW = acLimitW;
        if (pos(raw.roundTripEff)) {
            // a published AC→AC round trip, split evenly between the charge and discharge legs
            const leg = Math.sqrt(Math.min(1, raw.roundTripEff));
            b.acEffCharge = leg;
            b.acEffDischarge = leg;
        }
    }
    return b;
}

/**
 * @typedef {Object} Kit  one kits.json entry, normalised
 * @property {string} id
 * @property {string} name   short display name
 * @property {string} kind   'microinverter'|'battery-inverter'|'battery-addon'|'panel'|'mount'
 * @property {'plugin'|'hardwired'|null} route  null for loose parts
 * @property {number|null} priceGbp
 * @property {boolean|null} availableNow  catalog value (null = not stated)
 * @property {boolean} onSale  availableNow !== false
 * @property {{ count: number, wp: number }|null} includedPanels
 * @property {number} mppts
 * @property {Array<{ maxDcW: number, maxAcW: number }>} inputs
 * @property {number} acLimitW
 * @property {number} etaNom
 * @property {boolean} octopus  Outgoing Prime eligible (kit bought from Octopus)
 * @property {Object|null} battery  partial Battery (system.js) for battery units
 * @property {Array<{ model: string, kwh: number, priceGbp: number|null }>} expansion
 * @property {string[]} flags  what was assumed (efficiencyAssumed, inputsUnknown, chargeRateAssumed, …)
 */

/** @returns {Kit} */
function normalizeKit(raw) {
    const flags = [];
    const kind = String(raw.kind ?? 'microinverter');
    const route = routeOf(raw.installRoute);
    const acLimitW = pos(raw.acLimitW) ?? (kind === 'panel' || kind === 'mount' ? 0 : 800);
    const isDevice = kind === 'microinverter' || kind === 'battery-inverter' || kind === 'battery-addon';
    const etaNom = isDevice ? etaFrom(raw.inverterEff, raw.inverterEffBasis, flags) : null;
    const io = kind === 'microinverter' || kind === 'battery-inverter' ? inputsFrom(raw, kind, acLimitW, flags) : { mppts: 0, inputs: [] };
    const inc = raw.includedPanels && pos(raw.includedPanels.count) && pos(raw.includedPanels.wp)
        ? { count: Math.round(raw.includedPanels.count), wp: raw.includedPanels.wp } : null;
    const availableNow = typeof raw.availableNow === 'boolean' ? raw.availableNow : null;
    return {
        id: raw.id,
        name: shortName(raw),
        brand: raw.brand ?? null,
        model: raw.model ?? null,
        kind,
        route,
        installRoute: raw.installRoute ?? null,
        registeredPlugin: route === 'plugin',
        priceGbp: finite(raw.priceGbp) ? raw.priceGbp : null,
        priceDate: raw.priceDate ?? null,
        priceSource: raw.priceSource ?? null,
        confidence: raw.confidence ?? null,
        availableNow,
        onSale: availableNow !== false,
        preorder: /pre-?order/i.test(String(raw.availability ?? '')),
        includedPanels: inc,
        bifacial: /bifacial/i.test(`${raw.model ?? ''}`),
        acLimitW,
        mppts: io.mppts,
        inputs: io.inputs,
        singleInput: io.mppts === 1 && !flags.includes('inputsUnknown'),
        etaNom,
        octopus: String(raw.id).startsWith('octopus-') || !!raw.exportTariff,
        battery: isDevice ? batteryFrom(raw, kind, etaNom ?? 0.955, acLimitW, flags) : null,
        expansion: Array.isArray(raw.expansion)
            ? raw.expansion.filter((x) => pos(x?.kwh)).map((x) => ({ model: String(x.model ?? ''), kwh: x.kwh, priceGbp: finite(x.priceGbp) ? x.priceGbp : null }))
            : [],
        warrantyYears: pos(raw.warrantyYears),
        notes: raw.notes ?? '',
        flags,
    };
}

/**
 * @typedef {Object} Station  one stations.json entry, normalised for the UPS model
 * @property {string} id
 * @property {string} name
 * @property {number} priceGbp
 * @property {boolean} availableNow  'in stock' in the availability text (or the catalog flag)
 * @property {boolean} preorder
 * @property {number} capacityKwh  nominal pack energy, treated as usable DC (10% reserve in the physics)
 * @property {number} reservePct
 * @property {number} chargeW  real AC charge rate (needed to carry the load with bypass disabled)
 * @property {number} acOutputW
 * @property {number} inputLimitW  the 13 A plug (or the unit's AC input limit)
 * @property {number|null} fixedLossW  P0 actually used: measured, else the idle draw, else null
 *   (battery.js then assumes 20/30 W by size)
 * @property {'measured'|'idle'|'assumed'} p0Source
 * @property {Array<{ maxDcW: number }>} pvInputs
 * @property {number} pvWireablePanels  typical 400–450 W panels that can really be wired (Voc/Isc limits)
 * @property {boolean} smartPlugOnly  no app schedule or TOU mode: automation = a smart plug on its mains lead
 * @property {number} lifeYears  min(15, 2 × warranty)
 */

/** @returns {Station} */
function normalizeStation(raw, d) {
    const flags = [];
    const availability = String(raw.availability ?? '');
    const availableNow = typeof raw.availableNow === 'boolean' ? raw.availableNow : /in stock/i.test(availability);
    const measured = pos(raw.fixedLossW);
    const idle = pos(raw.idleW);
    const p0Source = measured !== null ? 'measured' : idle !== null ? 'idle' : 'assumed';
    if (p0Source !== 'measured') flags.push('lossesNotMeasured');
    const capacityKwh = pos(raw.usableKwh) ?? 1;
    const warranty = pos(raw.warrantyYears);
    const pvInputs = Array.isArray(raw.pvInputs) ? raw.pvInputs.filter((p) => pos(p?.maxDcW)).map((p) => ({ maxDcW: p.maxDcW })) : [];
    const cp = raw.controlPaths ?? {};
    const smartPlugOnly = cp.appSchedule === false && raw.touMode !== true;
    const smallMax = finite(d.fixedLossSmallMaxKwh) ? d.fixedLossSmallMaxKwh : 2.5;
    return {
        id: raw.id,
        name: shortName(raw),
        brand: raw.brand ?? null,
        model: raw.model ?? null,
        kind: 'power-station',
        route: 'ups',
        priceGbp: finite(raw.priceGbp) ? raw.priceGbp : 0,
        rrpGbp: finite(raw.rrpGbp) ? raw.rrpGbp : null,
        priceDate: raw.priceDate ?? null,
        priceSource: raw.priceSource ?? null,
        confidence: raw.confidence ?? null,
        availability,
        availableNow,
        onSale: availableNow,
        preorder: raw.preorder === true || /pre-?order/i.test(availability),
        capacityKwh,
        reservePct: finite(d.reservePct) ? d.reservePct : 10,
        chargeW: pos(raw.acChargeW) ?? 800,
        acOutputW: pos(raw.acOutputW) ?? 1800,
        inputLimitW: pos(raw.acInputLimitW) ?? 2990,
        fixedLossW: measured ?? idle,
        p0Source,
        assumedP0W: measured ?? idle ?? (capacityKwh <= smallMax ? (d.fixedLossWSmall ?? 20) : (d.fixedLossWLarge ?? 30)),
        etaInv: finite(d.etaInv) ? d.etaInv : 0.94,
        chargeEff: finite(d.chargeEff) ? d.chargeEff : 0.88,
        bypassW: finite(d.bypassW) ? d.bypassW : 8,
        pvInputs,
        pvWireablePanels: finite(raw.pvWireablePanels) ? Math.max(0, Math.round(raw.pvWireablePanels)) : Math.min(1, pvInputs.length),
        pvNote: raw.pvNote ?? null,
        cycles: pos(raw.cycles) ?? 4000,
        warrantyYears: warranty,
        lifeYears: warranty !== null ? Math.min(15, 2 * warranty) : 10,
        upsSwitchMs: pos(raw.upsSwitchMs),
        hid: /\bHID\b/.test(String(raw.scheduling ?? '')),
        touMode: raw.touMode === true,
        smartPlugOnly,
        bypassDisableable: raw.bypassDisableable === true,
        expansion: Array.isArray(raw.expansion)
            ? raw.expansion.filter((x) => pos(x?.kwh)).map((x) => ({ model: String(x.model ?? ''), kwh: x.kwh, priceGbp: finite(x.priceGbp) ? x.priceGbp : null }))
            : [],
        scheduling: raw.scheduling ?? null,
        notes: raw.notes ?? '',
        flags,
    };
}

/**
 * @typedef {Object} Catalog
 * @property {Kit[]} kits
 * @property {Station[]} stations
 * @property {Array<Object>} bundles  { id, name, base, panels: { count, wp, catalogId, bifacial }, priceGbp, … }
 * @property {Object} constants  constants.json as given
 * @property {{ gbp: number, low: number, high: number, cuLow: number, cuHigh: number, label: string, note: string }} electrician
 * @property {{ plugin: Object, hardwiredMaxW: number }} limits
 * @property {{ panel: Kit|null, frame: Kit|null }} parts  default loose panel and frame for panel-only builds
 * @property {(id: string) => (Kit|Station|Object|null)} byId  non-enumerable (does not cross postMessage)
 */

/**
 * Normalise the catalog. Accepts the bare arrays the worker passes, or the wrapped data files
 * ({ kits: [...] }, { stations: [...], defaults }, { bundles: [...] }); extra keys are ignored.
 * @param {{ kits?: any, stations?: any, bundles?: any, constants?: Object, stationDefaults?: Object, raw?: Object }} [input]
 * @returns {Catalog}
 */
export function normalizeCatalog({ kits, stations, bundles, constants, stationDefaults } = {}) {
    const stationDefs = stationDefaults ?? (stations && !Array.isArray(stations) ? stations.defaults : null) ?? {};
    const k = unwrap(kits, 'kits').filter((e) => e && typeof e.id === 'string').map(normalizeKit);
    const s = unwrap(stations, 'stations').filter((e) => e && typeof e.id === 'string').map((e) => normalizeStation(e, stationDefs));
    const kitIds = new Set(k.map((e) => e.id));
    const b = unwrap(bundles, 'bundles')
        .filter((e) => e && typeof e.id === 'string' && kitIds.has(e.base) && finite(e.priceGbp) && pos(e.panels?.count) && pos(e.panels?.wp))
        .map((e) => ({ ...e, kind: 'bundle', route: 'hardwired', onSale: e.availableNow !== false, panels: { ...e.panels } }));
    const c = constants && typeof constants === 'object' ? constants : {};
    const ic = c.installCostDefaultsGbp ?? {};
    const el = ic.electricianDedicatedCircuit ?? {};
    const cu = ic.consumerUnitUpgradeIfNeeded ?? {};
    const electrician = {
        gbp: finite(el.default) ? el.default : ELECTRICIAN_FALLBACK.gbp,
        low: finite(el.low) ? el.low : ELECTRICIAN_FALLBACK.low,
        high: finite(el.high) ? el.high : ELECTRICIAN_FALLBACK.high,
        cuLow: finite(cu.low) ? cu.low : ELECTRICIAN_FALLBACK.cuLow,
        cuHigh: finite(cu.high) ? cu.high : ELECTRICIAN_FALLBACK.cuHigh,
    };
    electrician.label = 'Electrician: dedicated circuit + G98 notification';
    electrician.note = `We assumed £${electrician.gbp} (range £${electrician.low}–${electrician.high}; +£${electrician.cuLow}–${electrician.cuHigh} if your consumer unit needs replacing).`;
    const pr = c.plugInRules ?? {};
    const limits = {
        plugin: {
            acMaxW: finite(pr.acMaxVA) ? pr.acMaxVA : LIMITS_FALLBACK.plugin.acMaxW,
            dcMaxWp: finite(pr.dcMaxWp) ? pr.dcMaxWp : LIMITS_FALLBACK.plugin.dcMaxWp,
            maxModules: finite(pr.maxModules) ? pr.maxModules : LIMITS_FALLBACK.plugin.maxModules,
            devices: finite(pr.devicesPerHousehold) ? pr.devicesPerHousehold : LIMITS_FALLBACK.plugin.devices,
            proCheckAboveWp: finite(pr.dcProfessionalAssessmentAboveWp) ? pr.dcProfessionalAssessmentAboveWp : LIMITS_FALLBACK.plugin.proCheckAboveWp,
        },
        hardwiredMaxW: finite(c.hardwiredRules?.g98PerPhaseMaxW_at230V) ? c.hardwiredRules.g98PerPhaseMaxW_at230V : LIMITS_FALLBACK.hardwiredMaxW,
    };
    const index = new Map();
    for (const e of [...k, ...s, ...b]) if (!index.has(e.id)) index.set(e.id, e);
    const catalog = {
        kits: k,
        stations: s,
        bundles: b,
        constants: c,
        stationDefaults: { ...stationDefs },
        electrician,
        limits,
        parts: { panel: index.get(DEFAULT_PANEL_ID) ?? null, frame: index.get(DEFAULT_FRAME_ID) ?? null },
    };
    Object.defineProperty(catalog, 'byId', { value: (id) => index.get(id) ?? null, enumerable: false });
    return catalog;
}

/**
 * byId that also works on a catalog that lost its function crossing postMessage.
 * @param {Catalog|Object|null} catalog
 * @param {string} id kit, station or bundle id
 * @returns {Kit|Station|Object|null}
 */
export function findProduct(catalog, id) {
    if (!catalog || typeof id !== 'string') return null;
    if (typeof catalog.byId === 'function') return catalog.byId(id);
    for (const list of [catalog.kits, catalog.stations, catalog.bundles]) {
        const hit = Array.isArray(list) ? list.find((e) => e.id === id) : null;
        if (hit) return hit;
    }
    return null;
}

/**
 * Plug-in kits a household can buy now (registered, panels included), smallest first.
 * @param {Catalog} catalog
 * @param {{ onSaleOnly?: boolean }} [opts]
 * @returns {Kit[]}
 */
export function pluginKits(catalog, { onSaleOnly = true } = {}) {
    return (catalog?.kits ?? [])
        .filter((k) => k.route === 'plugin' && k.kind === 'microinverter' && k.includedPanels && (!onSaleOnly || k.onSale))
        .sort((a, b) => a.includedPanels.count * a.includedPanels.wp - b.includedPanels.count * b.includedPanels.wp || (a.priceGbp ?? 0) - (b.priceGbp ?? 0));
}

/**
 * Mounting preset per mount-spot kind (UX critique MountSpot defaults): walls and railings get
 * their own Faiman presets and ground self-shading; pitched roofs are roof-mounted.
 * @param {{ kind?: string }|null} spot
 * @returns {'open'|'wall'|'railing'|'roof'}
 */
export function mountingForSpot(spot) {
    switch (spot?.kind) {
        case 'wall': return 'wall';
        case 'railing': return 'railing';
        case 'pitched': return 'roof';
        default: return 'open';
    }
}

/**
 * Orientation a spot gives (a free spot without a chosen direction gets due south at the middle
 * of its tilt range; scenarios.js replaces that with the swept best).
 * @param {Object|null} spot MountSpot
 * @returns {{ azimuth: number, tilt: number, mounting: string, shadingPct: number, horizon: number[] }}
 */
export function orientationForSpot(spot) {
    const range = Array.isArray(spot?.tiltRange) && spot.tiltRange.length === 2 ? spot.tiltRange : [15, 45];
    const tilt = finite(spot?.tilt) ? spot.tilt : Math.min(range[1], Math.max(range[0], 35));
    return {
        azimuth: finite(spot?.azimuth) ? spot.azimuth : 180,
        tilt,
        mounting: mountingForSpot(spot),
        shadingPct: finite(spot?.shadingPct) ? spot.shadingPct : 3,
        horizon: Array.isArray(spot?.horizon) ? [...spot.horizon] : [],
    };
}

/**
 * Lay `count` panels on an inverter's inputs: one per input while inputs last (each dual-input
 * channel takes one panel — the realistic wiring), otherwise the remainder in series on the
 * first inputs. One PvArray per used input.
 * @param {number} count
 * @param {number} wp
 * @param {number} nInputs
 * @param {Object} o orientation (orientationForSpot)
 * @param {{ idPrefix?: string, firstInput?: number }} [opt]
 * @returns {Object[]} PvArray partials
 */
export function layoutPanels(count, wp, nInputs, o, { idPrefix = 'a', firstInput = 0 } = {}) {
    const n = Math.max(1, Math.round(nInputs || 1));
    const per = new Array(Math.min(n, Math.max(1, count))).fill(0);
    for (let i = 0; i < count; i++) per[i % per.length]++;
    return per.map((c, q) => ({
        id: `${idPrefix}${q}`,
        name: per.length === 1 ? 'Panels' : `Input ${firstInput + q + 1}`,
        count: c,
        wp,
        tilt: o.tilt,
        azimuth: o.azimuth,
        mounting: o.mounting,
        shadingPct: o.shadingPct,
        horizon: [...o.horizon],
        input: firstInput + q,
    }));
}

/**
 * The electrician cost line (UX critique: £350, range in the catalog's electrician note).
 * @param {Catalog|null} catalog
 * @returns {{ label: string, gbp: number, year: 0, kind: 'install' }}
 */
export function electricianCost(catalog) {
    const e = catalog?.electrician ?? { ...ELECTRICIAN_FALLBACK, label: 'Electrician: dedicated circuit + G98 notification' };
    return { label: e.label, gbp: e.gbp, year: 0, kind: 'install' };
}

/**
 * Grid-tied inverter of a kit as a system.js Inverter.
 * @param {Kit} kit
 * @returns {{ acLimitW: number, etaNom: number, inputs: Array<{ maxDcW: number, maxAcW: number }>, standbyW: number, supportsPowerLimit: boolean }}
 */
export function kitInverter(kit) {
    return {
        acLimitW: kit.acLimitW,
        etaNom: kit.etaNom ?? 0.955,
        inputs: kit.inputs.map((x) => ({ ...x })),
        standbyW: 0,
        supportsPowerLimit: false,
    };
}

/**
 * A catalog kit (plug-in kit, all-in-one battery unit or add-on battery) as a complete System.
 *
 * Export defaults (UX critique): Octopus kits get Outgoing Prime when the dataset comes from an
 * Octopus account or the demo (pass exportKind to override); every other kit and every
 * hardwired build gets none. A hardwired product gets the electrician cost line.
 * @param {Kit|string} kit catalog kit (or its id)
 * @param {{ spot?: Object, catalog?: Catalog, exportKind?: string, panels?: { count: number, wp: number, catalogId?: string, frameId?: string }|null,
 *   priceGbp?: number, id?: string, name?: string, dsSource?: string, route?: string, strategy?: string, battery?: Object|null }} [opts]
 *   panels: loose panels for a unit sold without them (all-in-ones), priced per piece from catalogId/frameId
 *   unless priceGbp (a bundle price) covers everything
 * @returns {Object} System (normalised)
 */
export function kitToSystem(kit, { spot = null, catalog = null, exportKind, panels = null, priceGbp, id, name, dsSource = 'octopus', route, strategy, battery } = {}) {
    const k = typeof kit === 'string' ? findProduct(catalog, kit) : kit;
    if (!k) throw new Error(`kitToSystem: unknown kit ${kit}`);
    const o = orientationForSpot(spot);
    const pnl = panels ?? k.includedPanels;
    const hasInverter = k.kind === 'microinverter' || k.kind === 'battery-inverter';
    const arrays = hasInverter && pnl ? layoutPanels(pnl.count, pnl.wp, k.inputs.length, o) : [];
    const r = route ?? k.route ?? 'hardwired';
    const costs = [{ label: k.name, gbp: priceGbp ?? k.priceGbp ?? 0, year: 0, kind: 'hardware' }];
    if (panels && priceGbp === undefined) {
        // loose panels (and frames) bought for a unit sold without them, priced per piece
        const panelItem = panels.catalogId ? findProduct(catalog, panels.catalogId) : null;
        if (panelItem?.priceGbp != null) {
            const per = panelItem.includedPanels?.count ?? 1;
            costs.push({ label: `${panels.count} × ${panelItem.name}`, gbp: round2((panelItem.priceGbp * panels.count) / per), year: 0, kind: 'hardware' });
        }
    }
    // loose panels need a frame on a ground / flat-roof spot (the same rule as a station's panels
    // and a bundle's); a wall or railing spot uses the kit's own brackets. A given priceGbp
    // covers everything.
    const frame = panels?.frameId && priceGbp === undefined ? findProduct(catalog, panels.frameId) : null;
    if (frame?.priceGbp != null && o.mounting === 'open') costs.push({ label: `${panels.count} × ${frame.name}`, gbp: round2(frame.priceGbp * panels.count), year: 0, kind: 'hardware' });
    if (r === 'hardwired') costs.push(electricianCost(catalog));
    const prime = k.octopus && (dsSource === 'octopus' || dsSource === 'demo');
    const exp = exportKind ?? (r === 'plugin' && prime ? 'prime' : 'none');
    const notes = [];
    if (k.flags.includes('efficiencyAssumed')) notes.push('Inverter efficiency not published — assumed 95.5%.');
    if (k.flags.includes('inputsUnknown')) notes.push('Number of solar inputs not published — modelled as one input.');
    if (k.flags.includes('chargeRateAssumed')) notes.push('Battery charge rate not published — assumed equal to its grid-charge rate.');
    if (r === 'hardwired') notes.push(catalog?.electrician?.note ?? 'We assumed £350 for the electrician.');
    if (exp === 'prime') notes.push('Starts after your network operator approves the kit.');
    let bat = battery === undefined ? (k.battery ? { ...k.battery } : null) : battery;
    if (bat && strategy) bat = { ...bat, strategy };
    const sys = {
        id: id ?? k.id,
        name: name ?? (pnl && !k.includedPanels ? `${k.name} + ${pnl.count}×${pnl.wp} W` : k.name),
        route: r,
        kitId: k.id,
        sourceIds: [k.id, ...(panels?.catalogId ? [panels.catalogId] : []), ...(panels?.frameId ? [panels.frameId] : [])],
        arrays,
        inverter: hasInverter ? kitInverter(k) : null,
        battery: bat,
        export: { kind: exp, flatP: 0 },
        costs,
        spotId: spot?.id ?? null,
        notes,
    };
    return normalizeSystem(sys);
}

/**
 * A power station used like a UPS for the servers, optionally with its own panels on its own
 * solar inputs (no grid connection, nothing to register).
 *
 * Panels are capped at what can really be wired (pvWireablePanels: the stations' 11–60 V inputs
 * take one typical panel each) and spread one per input, extra ones in series on the first
 * (high-voltage) input. Smart-plug-only units (no app schedule or TOU mode) get the "cut the
 * mains 4–7pm, recharge right after" schedule (chargeWindow 19:00–16:00), the only schedule
 * they can actually run.
 * @param {Station|string} station
 * @param {{ dedicatedW?: 'baseload'|number, panels?: { count: number, wp?: number, spot?: Object }|null, catalog?: Catalog,
 *   strategy?: string, id?: string, name?: string, frames?: boolean }} [opts]
 * @returns {Object} System (normalised)
 */
export function stationToSystem(station, { dedicatedW = 'baseload', panels = null, catalog = null, strategy = 'threshold', id, name, frames = true } = {}) {
    const st = typeof station === 'string' ? findProduct(catalog, station) : station;
    if (!st) throw new Error(`stationToSystem: unknown station ${station}`);
    const costs = [{ label: st.name, gbp: st.priceGbp, year: 0, kind: 'hardware' }];
    const notes = [];
    let pvArrays = [];
    // every product bought, for provenance (the rules, the battery's capex, the "Products" list)
    const bought = [st.id];
    const wanted = panels ? Math.max(0, Math.round(panels.count ?? 0)) : 0;
    const count = Math.min(wanted, st.pvWireablePanels);
    if (wanted > count) notes.push(`Only ${st.pvWireablePanels} panel${st.pvWireablePanels === 1 ? '' : 's'} can be wired to its solar input${st.pvInputs.length === 1 ? '' : 's'}.`);
    if (count > 0) {
        const panel = catalog?.parts?.panel ?? null;
        const frame = catalog?.parts?.frame ?? null;
        const wp = panels.wp ?? panel?.includedPanels?.wp ?? 460;
        const o = orientationForSpot(panels.spot ?? null);
        const nIn = Math.max(1, st.pvInputs.length);
        // one panel per input; extra panels in series on input 0 (the high-voltage input on the big units)
        const per = new Array(Math.min(nIn, count)).fill(1);
        for (let i = per.length; i < count; i++) per[0]++;
        pvArrays = per.map((c, q) => ({ id: `s${q}`, name: `Station input ${q + 1}`, count: c, wp, tilt: o.tilt, azimuth: o.azimuth,
            mounting: o.mounting, shadingPct: o.shadingPct, horizon: [...o.horizon], input: q }));
        if (panel) bought.push(panel.id);
        if (panel?.priceGbp != null) costs.push({ label: `${count} × ${panel.name}`, gbp: round2(panel.priceGbp * count), year: 0, kind: 'hardware' });
        if (frames && frame?.priceGbp != null && o.mounting === 'open') {
            costs.push({ label: `${count} × ${frame.name}`, gbp: round2(frame.priceGbp * count), year: 0, kind: 'hardware' });
            bought.push(frame.id);
        }
    }
    if (st.smartPlugOnly) {
        costs.push({ label: 'Smart plug for automation (enter yours)', gbp: 0, year: 0, kind: 'other' });
        notes.push('No price-aware app schedule: automate it with a 13 A smart plug on its mains lead.');
    }
    if (st.p0Source !== 'measured') notes.push(`This unit's losses aren't measured; we assume ${st.assumedP0W} W while it runs the servers.`);
    const sys = {
        id: id ?? st.id,
        name: name ?? (count > 0 ? `${st.name} + ${count}×${pvArrays[0].wp} W on its own inputs` : st.name),
        route: 'ups',
        kitId: st.id,
        sourceIds: bought,
        arrays: [],
        inverter: null,
        battery: {
            coupling: 'ups',
            capacityKwh: st.capacityKwh,
            minSocPct: st.reservePct,
            maxChargeW: st.chargeW,
            maxDischargeW: st.acOutputW,
            acChargeW: st.chargeW,
            acOutputW: st.acOutputW,
            standbyW: 0,
            strategy,
            cycles: st.cycles,
            lifeYears: st.lifeYears,
            schedule: st.smartPlugOnly
                ? { chargeBelowP: null, chargeWindow: ['19:00', '16:00'], dischargeWindow: ['16:00', '19:00'] }
                : { chargeBelowP: null, chargeWindow: ['00:00', '06:00'], dischargeWindow: ['16:00', '19:00'] },
            ups: {
                dedicatedW,
                outletMaxW: st.acOutputW,
                etaInv: st.etaInv,
                chargeEff: st.chargeEff,
                chargeW: st.chargeW,
                fixedLossW: st.fixedLossW,
                bypassW: st.bypassW,
                bypass: 'auto',
                pvArrays,
                pvInputs: st.pvInputs.map((p) => ({ ...p })),
                inputLimitW: st.inputLimitW,
            },
        },
        export: { kind: 'none', flatP: 0 },
        costs,
        spotId: panels?.spot?.id ?? null,
        notes,
    };
    return normalizeSystem(sys);
}

/**
 * Bundle (unit + panels at one price) as a System: the base kit with the bundle's panels, the
 * bundle price, the electrician line and — because the bundles ship without mounting ("mounting
 * not included" in the catalog notes) — the catalog frame per panel on a ground / flat-roof spot,
 * exactly as the loose-panel builds (H2, H3) and a station's own panels are costed. Without it a
 * bundle would look £163 cheaper than an equivalent build for the same frames.
 * @param {Object|string} bundle
 * @param {{ spot?: Object, catalog: Catalog, id?: string, name?: string, strategy?: string }} opts
 * @returns {Object} System
 */
export function bundleToSystem(bundle, { spot = null, catalog, id, name, strategy } = {}) {
    const b = typeof bundle === 'string' ? findProduct(catalog, bundle) : bundle;
    if (!b) throw new Error(`bundleToSystem: unknown bundle ${bundle}`);
    const base = findProduct(catalog, b.base);
    const sys = kitToSystem(base, { spot, catalog, panels: { count: b.panels.count, wp: b.panels.wp }, priceGbp: b.priceGbp,
        id: id ?? b.id, name: name ?? b.name, route: 'hardwired', strategy });
    sys.costs[0].label = b.name;
    const frame = catalog?.parts?.frame ?? null;
    const framed = frame?.priceGbp != null && mountingForSpot(spot) === 'open' && !/mounting (is )?included/i.test(String(b.notes ?? ''));
    if (framed) {
        // after the hardware line, before the electrician (cost lines read hardware → install)
        const at = sys.costs.findIndex((c) => c.kind === 'install');
        const item = { label: `${b.panels.count} × ${frame.name}`, gbp: round2(frame.priceGbp * b.panels.count), year: 0, kind: 'hardware' };
        sys.costs.splice(at < 0 ? sys.costs.length : at, 0, item);
        sys.notes = [...sys.notes, 'The bundle ships without mounting: a ground/flat-roof frame per panel is included in the cost.'];
    }
    sys.sourceIds = [b.id, b.base, ...(b.panels.catalogId ? [b.panels.catalogId] : []), ...(framed ? [frame.id] : [])];
    return sys;
}
