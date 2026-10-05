/*
 * rules.js — the GB legal envelope for a System (UX critique "plug-in rules with fixes", SPEC §3.3).
 *
 * Plug-in solar became legal on 27 Aug 2026 with hard limits: one complete ENA-registered kit per
 * home, used exactly as sold (no extra or swapped panels), ≤ 800 W AC, ≤ 2000 Wp, ≤ 4 modules, and
 * no battery (plug-in storage "remains prohibited"). Anything else needs an electrician (G98,
 * ≤ 16 A per phase ≈ 3.68 kW) or is a plan for rules that do not exist yet. A power station that
 * only charges from a socket and runs the servers from its own outlets is an appliance.
 *
 * Every issue carries its fixes as data — { label, action } — so the UI renders buttons and the
 * worker applies them with applyFix(); a fix always produces a System with no errors.
 */

import { normalizeSystem, upgradedSystem } from './system.js';
import { findProduct, kitToSystem, pluginKits, electricianCost, orientationForSpot } from './kits.js';

/** Limits used when no catalog is supplied (constants.json values). */
const FALLBACK_LIMITS = { plugin: { acMaxW: 800, dcMaxWp: 2000, maxModules: 4, devices: 1, proCheckAboveWp: 960 }, hardwiredMaxW: 3680 };

/** Orientation differences that make two strings on one input mismatch (UX critique). */
const MIX_AZ_DEG = 10;
const MIX_TILT_DEG = 5;

const WHATIF_BANNER = 'Not legal in GB today (Oct 2026) — shown for planning only.';

/**
 * @typedef {{ code: string, message: string, fixes: Array<{ label: string, action: Object }>, stage?: 2 }} Issue
 * @typedef {{ legal: 'ok'|'check'|'whatif'|'reference', errors: Issue[], warnings: Issue[], banner: string|null }} RulesResult
 */

const limitsOf = (catalog) => catalog?.limits ?? FALLBACK_LIMITS;
const azDiff = (a, b) => {
    const d = Math.abs((((a - b) % 360) + 360) % 360);
    return d > 180 ? 360 - d : d;
};
const totalWp = (arrays) => arrays.reduce((s, a) => s + a.count * a.wp, 0);
const totalModules = (arrays) => arrays.reduce((s, a) => s + a.count, 0);

/** Catalog kits the system was built from that are plug-in micro-inverter kits. */
function pluginDevices(sys, catalog) {
    const ids = [...(sys.sourceIds ?? [])];
    if (sys.kitId && !ids.includes(sys.kitId)) ids.unshift(sys.kitId);
    return ids.map((id) => findProduct(catalog, id)).filter((k) => k && k.kind === 'microinverter' && k.route === 'plugin');
}

/** The catalog power station a system is built around (C1 lists it in sourceIds, U* in kitId). */
function stationOf(sys, catalog) {
    const ids = [sys.kitId, ...(sys.sourceIds ?? [])].filter(Boolean);
    for (const id of ids) {
        const p = findProduct(catalog, id);
        if (p?.kind === 'power-station') return p;
    }
    return null;
}

/** The next plug-in kit up from `wp` (closest at or above; else the biggest on sale). */
function biggerKit(catalog, wp, { minInputs = 1, exclude = null } = {}) {
    const kits = pluginKits(catalog).filter((k) => k.id !== exclude && (k.mppts ?? 1) >= minInputs);
    if (!kits.length) return null;
    const size = (k) => k.includedPanels.count * k.includedPanels.wp;
    const above = kits.filter((k) => size(k) >= wp);
    if (above.length) return above.sort((a, b) => size(a) - size(b) || (a.priceGbp ?? 0) - (b.priceGbp ?? 0))[0];
    return kits.sort((a, b) => size(b) - size(a) || (a.priceGbp ?? 0) - (b.priceGbp ?? 0))[0];
}

const fixElectrician = (catalog) => ({ label: `Make it electrician-installed (+£${catalog?.electrician?.gbp ?? 350})`, action: { type: 'setRoute', route: 'hardwired', addElectrician: true } });
const fixWhatif = (label = 'Plan it under future rules') => ({ label, action: { type: 'setRoute', route: 'whatif' } });

/** Arrays sharing an inverter input whose orientations differ enough to mismatch. */
function mixedInputs(arrays) {
    const byInput = new Map();
    for (const a of arrays) {
        if (!(a.count > 0)) continue;
        if (!byInput.has(a.input)) byInput.set(a.input, []);
        byInput.get(a.input).push(a);
    }
    const out = [];
    for (const [input, list] of byInput) {
        const ref = list[0];
        if (list.some((a) => azDiff(a.azimuth, ref.azimuth) > MIX_AZ_DEG || Math.abs(a.tilt - ref.tilt) > MIX_TILT_DEG)) out.push(input);
    }
    return out;
}

/**
 * Validate a system against its route.
 * @param {Object} system System (raw or normalised; raw input wiring is checked before clamping)
 * @param {Object} [catalog] normalised catalog (kits.js)
 * @param {{ baseLoadW?: number, spots?: Object[] }} [ctx] baseLoadW resolves a 'baseload' dedicated
 *   load; spots supply groundLevel for the system's spotId
 * @returns {RulesResult}
 */
export function validate(system, catalog = null, ctx = {}) {
    const raw = system && typeof system === 'object' ? system : {};
    const sys = normalizeSystem(raw);
    const lim = limitsOf(catalog);
    const errors = [];
    const warnings = [];
    let legal = sys.route === 'whatif' ? 'whatif' : sys.route === 'reference' ? 'reference' : 'ok';
    const kit = sys.kitId ? findProduct(catalog, sys.kitId) : null;
    const err = (code, message, fixes = []) => errors.push({ code, message, fixes });
    const warn = (code, message, fixes = []) => warnings.push({ code, message, fixes });

    if (sys.route === 'reference') return { legal, errors, warnings, banner: null };

    // ── wiring: an array on an input the inverter does not have (normalizeSystem would hide it)
    const rawInputs = Array.isArray(raw.inverter?.inputs) ? raw.inverter.inputs.length : null;
    if (rawInputs !== null && Array.isArray(raw.arrays)) {
        const bad = raw.arrays.filter((a) => Number(a?.input ?? 0) >= rawInputs);
        if (bad.length) {
            err('ARRAY_INPUT_RANGE', `${bad.length === 1 ? 'A panel group is' : 'Some panel groups are'} wired to solar input ${Number(bad[0].input) + 1}, but the inverter has ${rawInputs}.`,
                [{ label: 'Wire them to the inverter’s inputs', action: { type: 'clampInputs' } }]);
        }
    }

    // ── two strings in different directions on one input
    const mixed = sys.inverter ? mixedInputs(sys.arrays) : [];
    if (mixed.length) {
        const single = (kit ? kit.mppts === 1 && !kit.flags?.includes('inputsUnknown') : false) || (sys.inverter?.inputs.length ?? 1) === 1;
        const unknown = kit?.flags?.includes('inputsUnknown') ?? false;
        const align = { label: 'Point them all the same way', action: { type: 'alignInput', input: mixed[0] } };
        if (sys.route === 'plugin' && single && !unknown) {
            const two = biggerKit(catalog, totalWp(sys.arrays), { minInputs: 2, exclude: kit?.id });
            const fixes = [align];
            if (two) fixes.push({ label: `Choose a kit with two solar inputs (${two.name})`, action: { type: 'chooseKit', kitId: two.id, keepSplit: true } });
            err('PLUGIN_SINGLE_INPUT_MIXED', `${kit?.name ?? 'This inverter'} has one solar input, so both panels must face the same way.`, fixes);
        } else if (unknown) {
            warn('INPUTS_UNKNOWN_MIXED', `${kit?.name ?? 'This kit'} doesn't publish how many solar inputs it has — if it has one, panels facing different ways lose a lot to mismatch.`, [align]);
        } else {
            const free = (sys.inverter?.inputs.length ?? 0) > new Set(sys.arrays.map((a) => a.input)).size;
            const fixes = [align];
            if (free) fixes.push({ label: 'Give each direction its own solar input', action: { type: 'splitInputs' } });
            warn('INPUT_MIXED', 'Panels on the same solar input face different ways, which loses energy to mismatch.', fixes);
        }
    }

    // ── plug-in envelope
    if (sys.route === 'plugin') {
        const wp = totalWp(sys.arrays);
        const modules = totalModules(sys.arrays);
        const devices = pluginDevices(sys, catalog);
        if (kit && kit.route === 'plugin' && kit.includedPanels) {
            const inc = kit.includedPanels;
            const swapped = sys.arrays.some((a) => a.count > 0 && Math.abs(a.wp - inc.wp) > 1e-6);
            if (modules !== inc.count || swapped) {
                const fixes = [];
                const big = biggerKit(catalog, wp, { exclude: kit.id });
                if (big) fixes.push({ label: `Choose a bigger kit (${big.name})`, action: { type: 'chooseKit', kitId: big.id } });
                fixes.push({ label: `Use the kit as sold (${inc.count} × ${inc.wp} W)`, action: { type: 'restoreKit' } });
                fixes.push(fixElectrician(catalog));
                err('PLUGIN_KIT_ALTERED', 'Plug-in kits must be used exactly as sold — they’re registered on the ENA list as a complete kit, so you can’t add or swap panels.', fixes);
            }
        } else if (kit && kit.route !== 'plugin' && kit.kind !== 'power-station') {
            err('PLUGIN_NOT_REGISTERED', `${kit.name} isn’t sold as a registered plug-in kit, so it has to be wired in by an electrician.`, [fixElectrician(catalog), fixWhatif()]);
        } else if (!kit && sys.arrays.length) {
            if (legal === 'ok') legal = 'check';
            warn('PLUGIN_CUSTOM', 'A custom plug-in system is only legal if this exact kit is on the ENA register — check before you buy.');
        }
        if ((sys.inverter?.acLimitW ?? 0) > lim.plugin.acMaxW + 1e-9) {
            err('PLUGIN_AC_LIMIT', `Plug-in kits are limited to ${lim.plugin.acMaxW} W out; this inverter gives ${sys.inverter.acLimitW} W.`, [fixElectrician(catalog), fixWhatif()]);
        }
        if (wp > lim.plugin.dcMaxWp + 1e-9) {
            err('PLUGIN_DC_LIMIT', `Plug-in kits are limited to ${lim.plugin.dcMaxWp} W of panels; this has ${Math.round(wp)} W.`, [fixElectrician(catalog), fixWhatif()]);
        }
        if (modules > lim.plugin.maxModules) {
            err('PLUGIN_MODULES', `Plug-in kits can have at most ${lim.plugin.maxModules} panels; this has ${modules}.`, [fixElectrician(catalog), fixWhatif()]);
        }
        if (devices.length > lim.plugin.devices) {
            err('PLUGIN_TWO_DEVICES', 'Only one plug-in kit per home (G98).', [fixWhatif('Plan it under future rules (one kit per circuit is proposed)')]);
        }
        if (sys.battery && sys.battery.coupling !== 'ups') {
            err('PLUGIN_BATTERY', 'Plug-in batteries aren’t legal in GB yet (SI 2026/848; Ofgem: “remain prohibited”).',
                [fixElectrician(catalog), fixWhatif('Plan it as a future plug-in battery')]);
        }
        if (sys.battery?.coupling === 'ups') {
            if (legal === 'ok') legal = 'check';
            warn('UPS_WITH_PLUGIN', 'Check first: plug-in kits’ instructions forbid using them “in conjunction with a battery”. A power station that only charges from a normal socket is arguably just a load, but nobody has confirmed this.');
        }
        if (wp > lim.plugin.proCheckAboveWp + 1e-9 && wp <= lim.plugin.dcMaxWp + 1e-9) {
            warn('PLUGIN_DC_960', `Get the circuit checked by an electrician — advised above ${lim.plugin.proCheckAboveWp} W of panels.`);
        }
        if (sys.export.kind === 'fixed' || sys.export.kind === 'agile') {
            warn('EXPORT_SEG_PLUGIN', 'Plug-in kits can’t get the Smart Export Guarantee (no MCS certificate).', [{ label: 'No export payments', action: { type: 'setExport', kind: 'none' } }]);
        }
    }

    // ── export eligibility (Prime is for Octopus-bought plug-in kits only)
    if (sys.export.kind === 'prime' && sys.route !== 'whatif') {
        const octopus = pluginDevices(sys, catalog).some((k) => k.octopus) || (kit?.octopus ?? false);
        if (!octopus || sys.route !== 'plugin') {
            warn('EXPORT_PRIME_NOT_OCTOPUS', 'Octopus only pays export on plug-in kits bought from Octopus.', [{ label: 'No export payments', action: { type: 'setExport', kind: 'none' } }]);
        }
    }

    // ── hardwired (G98)
    if (sys.route === 'hardwired') {
        const acBattW = sys.battery?.coupling === 'ac' ? Math.min(sys.battery.maxDischargeW, sys.battery.acOutputW || Infinity) : 0;
        const totalAc = (sys.inverter?.acLimitW ?? 0) + acBattW;
        if (totalAc > lim.hardwiredMaxW + 1e-9) {
            err('HARDWIRED_AC_LIMIT', `A G98 installation is limited to ${lim.hardwiredMaxW} W in total (16 A per phase); this has ${Math.round(totalAc)} W of inverters.`,
                [{ label: `Limit the inverter to ${lim.hardwiredMaxW - acBattW} W`, action: { type: 'capAcLimit', w: Math.max(0, lim.hardwiredMaxW - acBattW) } }]);
        }
        if (!sys.costs.some((c) => c.kind === 'install')) {
            warn('HARDWIRED_NO_INSTALL', `Wired-in systems need an electrician — add their cost (we assume £${catalog?.electrician?.gbp ?? 350}).`,
                [{ label: 'Add the electrician', action: { type: 'addElectrician' } }]);
        }
    }

    // ── power stations used like a UPS
    const b = sys.battery;
    if (b?.coupling === 'ups') {
        if (b.strategy === 'fixed') {
            err('UPS_FIXED', 'A power station’s output always equals what is plugged into it — a fixed output doesn’t apply.',
                [{ label: 'Use Agile-aware automation', action: { type: 'setStrategy', strategy: 'threshold' } }]);
        }
        if (b.strategy === 'self' && !(b.ups.pvArrays.length && totalWp(b.ups.pvArrays) > 0)) {
            err('UPS_SELF_NO_PV', 'Self mode never recharges without its own panels.',
                [{ label: 'Use Agile-aware automation', action: { type: 'setStrategy', strategy: 'threshold' } }]);
        }
        const dW = b.ups.dedicatedW === 'baseload' ? (Number.isFinite(ctx.baseLoadW) ? ctx.baseLoadW : null) : b.ups.dedicatedW;
        if (dW !== null && dW > b.ups.outletMaxW + 1e-9) {
            err('UPS_OVER_OUTLET', `${Math.round(dW)} W of servers is more than this power station’s ${b.ups.outletMaxW} W outlets can supply.`,
                [{ label: `Run ${b.ups.outletMaxW} W of the servers on it`, action: { type: 'setDedicatedW', w: b.ups.outletMaxW } }]);
        }
        if (sys.route === 'ups' && sys.arrays.length) {
            err('UPS_GRID_ARRAYS', 'A power-station system has no grid connection — its panels go on the station’s own solar inputs.',
                [{ label: 'Make it a plug-in kit plus a power station', action: { type: 'setRoute', route: 'plugin' } }]);
        }
        // its own panels must be wireable: the 11–60 V inputs take one typical panel each (VERIFY-ups),
        // and the physics caps each input's DC, so an over-wired station would look better than it can be
        const station = stationOf(sys, catalog);
        const nPanels = b.ups.pvArrays.reduce((s, a) => s + (a.count > 0 && a.wp > 0 ? a.count : 0), 0);
        if (station && nPanels > 0) {
            if (!station.pvInputs?.length || !(station.pvWireablePanels > 0)) {
                err('UPS_NO_PV_INPUT', `${station.name} has no solar input that takes a normal panel${station.pvNote ? ` (${station.pvNote})` : ''}.`,
                    [{ label: 'Remove its panels', action: { type: 'removeStationPanels' } }]);
            } else if (nPanels > station.pvWireablePanels || b.ups.pvArrays.some((a) => a.count > 0 && a.input >= station.pvInputs.length)) {
                const n = station.pvWireablePanels;
                warn('UPS_PV_WIRING', `${station.name} can only take ${n} panel${n === 1 ? '' : 's'} on its solar input${station.pvInputs.length === 1 ? '' : 's'} (voltage and current limits) — the rest can’t be wired.`,
                    [{ label: `Use ${n} panel${n === 1 ? '' : 's'}, one per input`, action: { type: 'capStationPanels' } }]);
            }
        }
    } else if (sys.route === 'ups') {
        err('UPS_NO_STATION', 'Choose a power station for this option.', [{ label: 'Plan it as wired-in instead', action: { type: 'setRoute', route: 'hardwired', addElectrician: true } }]);
    }

    // ── availability
    const products = [kit, ...(sys.sourceIds ?? []).map((id) => findProduct(catalog, id))].filter(Boolean);
    const gone = products.find((p) => p.onSale === false);
    if (gone) warn('NOT_ON_SALE', `Not on sale right now${gone.availability ? ` (${gone.availability})` : ''}.`);

    // ── where it goes
    const spot = sys.spotId && Array.isArray(ctx.spots) ? ctx.spots.find((s) => s.id === sys.spotId) : null;
    if (spot && spot.groundLevel === false && sys.arrays.length) warn('ABOVE_GROUND', 'Above ground level — get professional advice.');

    // ── a staged plan: stage 2 must be legal under its own route
    if (sys.upgrade) {
        const s2 = upgradedSystem(sys);
        const r2 = validate(s2, catalog, ctx);
        for (const e of r2.errors) errors.push({ ...e, stage: 2, message: `Later: ${e.message}` });
    }

    let banner = null;
    if (sys.route === 'whatif') {
        banner = WHATIF_BANNER;
        warn('WHATIF', WHATIF_BANNER);
        // future-rules plans are allowed to break today's plug-in rules — only physical problems stay errors
        const keep = new Set(['ARRAY_INPUT_RANGE', 'UPS_FIXED', 'UPS_SELF_NO_PV', 'UPS_OVER_OUTLET', 'UPS_NO_PV_INPUT']);
        for (let i = errors.length - 1; i >= 0; i--) if (!keep.has(errors[i].code)) errors.splice(i, 1);
    }
    return { legal, errors, warnings, banner };
}

/** Panels of the system flattened to one entry per panel (orientation + input), for re-layouts. */
function panelsOf(sys) {
    const out = [];
    for (const a of sys.arrays) for (let i = 0; i < a.count; i++) out.push(a);
    return out;
}

/**
 * Apply a fix action from a validate() Issue. Unknown actions return the system unchanged.
 * Actions: setRoute {route, addElectrician?}, chooseKit {kitId, keepSplit?}, restoreKit, alignInput
 * {input}, splitInputs, clampInputs, setStrategy {strategy}, setDedicatedW {w}, capAcLimit {w},
 * addElectrician, setExport {kind}, removeBattery, removeStationPanels, capStationPanels (to what
 * the station's inputs can really take, one per input).
 * @param {Object} system
 * @param {{ type: string }} action
 * @param {Object} [catalog]
 * @returns {Object} System (normalised)
 */
export function applyFix(system, action, catalog = null) {
    const raw = system && typeof system === 'object' ? system : {};
    let sys = normalizeSystem(raw);
    const a = action && typeof action === 'object' ? action : {};
    const addElectrician = (s) => (s.costs.some((c) => c.kind === 'install') ? s : { ...s, costs: [...s.costs, electricianCost(catalog)] });
    switch (a.type) {
        case 'setRoute': {
            let s = { ...sys, route: a.route };
            if (a.route === 'hardwired' && a.addElectrician !== false) s = addElectrician(s);
            // a wired-in or future build is no longer the registered kit, so its panels may change freely
            if (a.route === 'hardwired' && s.export.kind === 'prime') s = { ...s, export: { kind: 'none', flatP: 0 } };
            return normalizeSystem(s);
        }
        case 'chooseKit': {
            const kit = findProduct(catalog, a.kitId);
            if (!kit) return sys;
            const first = sys.arrays[0];
            const spot = first ? { id: sys.spotId, azimuth: first.azimuth, tilt: first.tilt, kind: first.mounting === 'wall' ? 'wall' : first.mounting === 'railing' ? 'railing' : 'ground', shadingPct: first.shadingPct, horizon: first.horizon } : null;
            const prime = sys.export.kind === 'prime' || kit.octopus;
            const next = kitToSystem(kit, { spot, catalog, exportKind: kit.octopus && prime ? 'prime' : 'none', id: sys.id, name: kit.name });
            if (a.keepSplit && sys.arrays.length > 1 && kit.inputs.length > 1) {
                // keep each original direction, one panel per input (the point of a two-input kit)
                const panels = panelsOf(sys);
                const n = kit.includedPanels?.count ?? panels.length;
                const per = kit.inputs.length;
                const arrays = [];
                for (let i = 0; i < n; i++) {
                    const src = panels[Math.min(i, panels.length - 1)];
                    const input = i % per;
                    const same = arrays.find((x) => x.input === input && x.azimuth === src.azimuth && x.tilt === src.tilt);
                    if (same) same.count++;
                    else arrays.push({ id: `a${arrays.length}`, name: `Input ${input + 1}`, count: 1, wp: kit.includedPanels?.wp ?? src.wp, tilt: src.tilt, azimuth: src.azimuth,
                        mounting: src.mounting, shadingPct: src.shadingPct, horizon: src.horizon, input });
                }
                return normalizeSystem({ ...next, arrays, battery: sys.battery?.coupling === 'ups' ? sys.battery : next.battery, upgrade: sys.upgrade });
            }
            return normalizeSystem({ ...next, battery: sys.battery?.coupling === 'ups' ? sys.battery : next.battery, upgrade: sys.upgrade });
        }
        case 'restoreKit': {
            const kit = sys.kitId ? findProduct(catalog, sys.kitId) : null;
            if (!kit?.includedPanels) return sys;
            const first = sys.arrays[0];
            const o = first ? { azimuth: first.azimuth, tilt: first.tilt, mounting: first.mounting, shadingPct: first.shadingPct, horizon: first.horizon }
                : orientationForSpot(null);
            const per = Math.max(1, kit.inputs.length);
            const n = kit.includedPanels.count;
            const arrays = [];
            for (let q = 0; q < Math.min(per, n); q++) {
                const src = sys.arrays.find((x) => x.input === q) ?? first ?? o;
                arrays.push({ id: `a${q}`, name: per === 1 ? 'Panels' : `Input ${q + 1}`, count: 0, wp: kit.includedPanels.wp, tilt: src.tilt ?? o.tilt,
                    azimuth: src.azimuth ?? o.azimuth, mounting: src.mounting ?? o.mounting, shadingPct: src.shadingPct ?? o.shadingPct, horizon: src.horizon ?? [], input: q });
            }
            for (let i = 0; i < n; i++) arrays[i % arrays.length].count++;
            if (arrays.length === 1 && sys.arrays.length > 1) {
                // a single input takes every panel in one direction
                Object.assign(arrays[0], { tilt: o.tilt, azimuth: o.azimuth });
            }
            return normalizeSystem({ ...sys, arrays });
        }
        case 'alignInput': {
            const ref = sys.arrays.find((x) => x.input === a.input) ?? sys.arrays[0];
            if (!ref) return sys;
            const arrays = sys.arrays.map((x) => (x.input === ref.input ? { ...x, azimuth: ref.azimuth, tilt: ref.tilt, mounting: ref.mounting } : x));
            return normalizeSystem({ ...sys, arrays });
        }
        case 'splitInputs': {
            const n = sys.inverter?.inputs.length ?? 1;
            const used = new Set();
            const arrays = sys.arrays.map((x) => ({ ...x }));
            // each distinct direction gets the next free input; same-direction arrays stay together
            const dirKey = (x) => `${x.azimuth}|${x.tilt}`;
            const assigned = new Map();
            let next = 0;
            for (const x of arrays) {
                const k = dirKey(x);
                if (assigned.has(k)) { x.input = assigned.get(k); continue; }
                while (used.has(next) && next < n - 1) next++;
                x.input = Math.min(next, n - 1);
                used.add(x.input);
                assigned.set(k, x.input);
            }
            return normalizeSystem({ ...sys, arrays });
        }
        case 'clampInputs': {
            const n = Array.isArray(raw.inverter?.inputs) ? raw.inverter.inputs.length : sys.inverter?.inputs.length ?? 1;
            const arrays = (Array.isArray(raw.arrays) ? raw.arrays : sys.arrays).map((x) => ({ ...x, input: Math.min(Math.max(0, Number(x?.input ?? 0) || 0), n - 1) }));
            return normalizeSystem({ ...raw, arrays });
        }
        case 'setStrategy':
            return sys.battery ? normalizeSystem({ ...sys, battery: { ...sys.battery, strategy: a.strategy } }) : sys;
        case 'setDedicatedW':
            return sys.battery?.ups ? normalizeSystem({ ...sys, battery: { ...sys.battery, ups: { ...sys.battery.ups, dedicatedW: a.w } } }) : sys;
        case 'capAcLimit':
            return sys.inverter ? normalizeSystem({ ...sys, inverter: { ...sys.inverter, acLimitW: a.w } }) : sys;
        case 'addElectrician':
            return normalizeSystem(addElectrician(sys));
        case 'setExport':
            return normalizeSystem({ ...sys, export: { kind: a.kind ?? 'none', flatP: a.flatP ?? 0 } });
        case 'removeBattery':
            return normalizeSystem({ ...sys, battery: null });
        case 'removeStationPanels':
            return sys.battery?.ups ? normalizeSystem({ ...sys, battery: { ...sys.battery, ups: { ...sys.battery.ups, pvArrays: [] } } }) : sys;
        case 'capStationPanels': {
            // what can really be wired: one panel per input, extras in series on input 0 (kits.stationToSystem)
            const u = sys.battery?.ups;
            const ref = u?.pvArrays.find((x) => x.count > 0);
            if (!ref) return sys;
            const st = stationOf(sys, catalog);
            const nIn = Math.max(1, st?.pvInputs?.length ?? u.pvInputs.length);
            const max = Math.max(0, st?.pvWireablePanels ?? nIn);
            const per = new Array(Math.min(nIn, max)).fill(1);
            for (let i = per.length; i < max; i++) per[0]++;
            const pvArrays = per.map((c, q) => ({ ...ref, id: `s${q}`, name: `Station input ${q + 1}`, count: c, input: q }));
            return normalizeSystem({ ...sys, battery: { ...sys.battery, ups: { ...u, pvArrays } } });
        }
        default:
            return sys;
    }
}
