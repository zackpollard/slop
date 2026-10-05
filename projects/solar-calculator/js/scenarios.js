/*
 * scenarios.js — the default set of complete options the verdict ranks (UX critique "default
 * scenarios", AMENDMENTS #6): featured S01–S06 (plug-in kits), H1–H4 (electrician-installed
 * batteries), U1–U3 (power stations for the servers), C1 (plug-in kit + power station), W1–W3
 * (future rules), R0–R1 (reference points), plus the leaderboard rows.
 *
 * Every product id and price comes from the verified catalog (kits.js); when an id is missing the
 * nearest real equivalent is used and the substitution is written into the scenario's notes.
 * Panels go on the best mount spot: free-direction spots are swept at one sub-sample (az 90–270
 * step 10, tilt over the spot's range step 5) on the user's own load and export tariff, valued on
 * the forward first-year basis; the headline runs then use three sub-samples.
 */

import { normalizeSystem } from './system.js';
import { findProduct, pluginKits, kitToSystem, stationToSystem, bundleToSystem, mountingForSpot } from './kits.js';
import { orientationGrid, bestBy } from './sweep.js';

/**
 * @typedef {{ id: string, name: string, kind: 'ground'|'flatroof'|'wall'|'railing'|'pitched', azimuth: number|null,
 *   tilt: number|null, tiltRange: number[], maxPanels: number, shadingPct: number, horizon: number[], groundLevel: boolean }} MountSpot
 */

/** Used when the user has not said where panels can go (UX critique orientation amendment). */
export const DEFAULT_SPOTS = Object.freeze([
    Object.freeze({ id: 'ground', name: 'Ground or flat-roof frame (any direction, 15–45°)', kind: 'ground', azimuth: null, tilt: null,
        tiltRange: Object.freeze([15, 45]), maxPanels: 4, shadingPct: 3, horizon: Object.freeze([]), groundLevel: true }),
    Object.freeze({ id: 'west-wall', name: 'West-facing wall (vertical)', kind: 'wall', azimuth: 270, tilt: 90,
        tiltRange: Object.freeze([90, 90]), maxPanels: 4, shadingPct: 3, horizon: Object.freeze([]), groundLevel: true }),
]);

/** Featured product ids (all verified in data/kits.json, data/stations.json, data/bundles.json on 2026-10-05). */
const IDS = {
    oct2: 'octopus-plugin-solar-2x460',
    oct1: 'octopus-plugin-solar-1x460',
    cp2: 'cityplumbing-dmegc-2x515-hiflow',
    cp1: 'cityplumbing-dmegc-1x465-hiflow',
    h1: 'ecoflow-stream-ultra+4x500',
    h2: 'zendure-solarflow-2400-pro',
    h3: 'anker-solarbank4-e5000-pro',
    h4: 'ecoflow-stream-ac-5000',
    u1: 'ecoflow-delta-3-plus',
    u2: 'bluetti-elite-300',
    vault: 'thunder-vault-hibattery-1920ac',
    panel: 'astronergy-460w-bifacial-trade',
    frame: 'its-adjustable-tilt-frame-15-30',
    leaderKits: ['powerxpress-920-marstek', 'patiosun-duo', 'thunder-bolt-920', 'solarfy-duo-910', 'ecoflow-stream-micro-2x500', 'ecoflow-stream-facade-2x400'],
    leaderBundles: ['ecoflow-stream-ultra-x+4x500'],
};

const TILT_DEFAULTS = { ground: [15, 45], flatroof: [15, 45], wall: [90, 90], railing: [60, 90], pitched: null };

/**
 * Fill MountSpot defaults by kind (UX critique): ground/flat roof free direction 15–45°, wall
 * vertical with a required direction, railing 60–90°, pitched fixed (hardwired only).
 * @param {Partial<MountSpot>} s
 * @param {number} i
 * @returns {MountSpot}
 */
export function normalizeSpot(s, i = 0) {
    const kind = ['ground', 'flatroof', 'wall', 'railing', 'pitched'].includes(s?.kind) ? s.kind : 'ground';
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    let tilt = num(s?.tilt);
    if (kind === 'wall') tilt = 90;
    const range = Array.isArray(s?.tiltRange) && s.tiltRange.length === 2 && s.tiltRange.every((v) => Number.isFinite(v))
        ? [Math.min(...s.tiltRange), Math.max(...s.tiltRange)]
        : tilt !== null ? [tilt, tilt] : TILT_DEFAULTS[kind] ?? [35, 35];
    return {
        id: typeof s?.id === 'string' && s.id ? s.id : `spot${i + 1}`,
        name: typeof s?.name === 'string' && s.name ? s.name : `Spot ${i + 1}`,
        kind,
        azimuth: num(s?.azimuth) === null ? null : ((num(s.azimuth) % 360) + 360) % 360,
        tilt,
        tiltRange: range,
        maxPanels: Number.isFinite(s?.maxPanels) && s.maxPanels > 0 ? Math.round(s.maxPanels) : 4,
        shadingPct: num(s?.shadingPct) ?? 3,
        horizon: Array.isArray(s?.horizon) ? s.horizon.filter(Number.isFinite) : [],
        groundLevel: s?.groundLevel !== false,
    };
}

const panelsOf = (sys) => sys.arrays.reduce((n, a) => n + a.count, 0);
const wpOf = (sys) => sys.arrays.reduce((n, a) => n + a.count * a.wp, 0);

/**
 * Placement bucket: systems with the same export kind, size class and inverter class prefer the
 * same direction closely enough that one sweep serves them all (the sweep costs ~130 cells).
 */
function bucketOf(sys) {
    const wp = wpOf(sys);
    const size = wp <= 500 ? 'S' : wp <= 1100 ? 'M' : 'L';
    const ac = (sys.inverter?.acLimitW ?? 800) <= 800 ? '800' : 'big';
    return `${sys.export.kind}|${size}|${ac}`;
}

/** Spot with a concrete direction (the swept best for free spots). */
function pointed(spot, az, tilt) {
    return { ...spot, azimuth: az, tilt };
}

/**
 * Rank the spots for a system template: free spots swept, fixed spots evaluated once.
 * @returns {Array<{ spot: MountSpot, az: number, tilt: number, gbp: number }>} best first
 */
function rankSpots(engine, template, spots, memo, { plugin = true } = {}) {
    // plug-in kits may not use a pitched roof, so they rank a different set of spots
    const key = `${bucketOf(template)}|${plugin}`;
    if (memo.has(key)) return memo.get(key);
    const ranked = [];
    for (const spot of spots) {
        if (plugin && spot.kind === 'pitched') continue;
        const mounting = mountingForSpot(spot);
        const t = normalizeSystem({ ...template, arrays: template.arrays.map((a) => ({ ...a, mounting, shadingPct: spot.shadingPct, horizon: spot.horizon })) });
        let grid;
        if (spot.azimuth !== null && spot.tilt !== null) grid = [{ az: spot.azimuth, tilt: spot.tilt }];
        else if (spot.azimuth !== null) grid = orientationGrid({ azMin: spot.azimuth, azMax: spot.azimuth, azStep: 10, tiltMin: Math.max(5, spot.tiltRange[0]), tiltMax: spot.tiltRange[1], tiltStep: 5, includeFlat: spot.tiltRange[0] <= 0 });
        else grid = orientationGrid({ azMin: 90, azMax: 270, azStep: 10, tiltMin: Math.max(5, spot.tiltRange[0]), tiltMax: spot.tiltRange[1], tiltStep: 5, includeFlat: spot.tiltRange[0] <= 0 });
        if (spot.tilt !== null && spot.azimuth === null) grid = grid.filter((c) => c.tilt === spot.tilt);
        if (!grid.length) grid = [{ az: spot.azimuth ?? 180, tilt: spot.tilt ?? spot.tiltRange[0] }];
        const best = bestBy(engine.placementCells(t, grid), 'gbp');
        ranked.push({ spot, az: best.az, tilt: best.tilt, gbp: best.gbp });
    }
    ranked.sort((a, b) => b.gbp - a.gbp);
    memo.set(key, ranked);
    return ranked;
}

/** Best spot that can take `panels` panels (falls back to the best overall). */
function bestFit(ranked, panels, skip = null) {
    return ranked.find((r) => r.spot.maxPanels >= panels && r.spot.id !== skip) ?? ranked.find((r) => r.spot.id !== skip) ?? ranked[0] ?? null;
}

/**
 * Build the default scenarios.
 * @param {Object} engine SolarEngine (placement sweeps, dataset source)
 * @param {Object} catalog normalised catalog
 * @param {{ spots?: Array<Partial<MountSpot>> }} [opts]
 * @returns {Object[]} System[] — featured first (S, H, U, C, W, R), then the leaderboard rows
 */
export function autoScenarios(engine, catalog, { spots = DEFAULT_SPOTS } = {}) {
    const sp = (Array.isArray(spots) && spots.length ? spots : DEFAULT_SPOTS).map(normalizeSpot);
    const source = engine.ds0?.meta?.source ?? 'octopus';
    const out = [];
    const memo = new Map();
    const add = (sys, extra = {}) => {
        const s = normalizeSystem({ ...sys, ...extra });
        out.push(s);
        return s;
    };
    const subst = [];
    /** A catalog product, or the nearest real equivalent with a note. */
    const pick = (id, fallback) => {
        const p = findProduct(catalog, id);
        if (p) return { product: p, note: null };
        const alt = fallback?.() ?? null;
        if (alt) subst.push(`${id} is not in the catalog; using ${alt.id} instead.`);
        return { product: alt, note: alt ? `Stands in for ${id}, which is not in the catalog.` : null };
    };
    const kits = pluginKits(catalog);
    const dualKits = kits.filter((k) => k.mppts >= 2);
    const size = (k) => k.includedPanels.count * k.includedPanels.wp;
    const nearestKit = (wp, list = kits) => list.slice().sort((a, b) => Math.abs(size(a) - wp) - Math.abs(size(b) - wp))[0] ?? null;

    /** A kit placed on its best spot. */
    const placeKit = (kit, opts = {}) => {
        const template = kitToSystem(kit, { catalog, dsSource: source, exportKind: opts.exportKind });
        const ranked = rankSpots(engine, template, sp, memo, { plugin: template.route === 'plugin' });
        const at = opts.spotRank ?? bestFit(ranked, panelsOf(template));
        const spot = at ? pointed(at.spot, at.az, at.tilt) : null;
        return { sys: kitToSystem(kit, { catalog, dsSource: source, spot, ...opts }), at, ranked };
    };
    const withNote = (sys, note) => (note ? { ...sys, notes: [...sys.notes, note] } : sys);

    // ── S01–S06: plug-in kits
    const o2 = pick(IDS.oct2, () => dualKits[dualKits.length - 1] ?? kits[kits.length - 1]);
    let s01 = null;
    let s01At = null;
    if (o2.product) {
        const r = placeKit(o2.product, { id: 'S01', name: o2.product.name });
        s01 = add(withNote(r.sys, o2.note), { featured: true });
        s01At = r;
        if ((o2.product.mppts ?? 1) >= 2 && s01.arrays.length >= 2) {
            // one panel on the best spot (input 0), one facing west at the same tilt (input 1)
            const arrays = s01.arrays.map((a, i) => (i === 0 ? a : { ...a, azimuth: 270 }));
            add({ ...s01, id: 'S02', name: `${o2.product.name}, one panel west`, arrays }, { featured: true });
        }
        const wall = sp.find((s) => s.kind === 'wall' && s.azimuth !== null && Math.abs(s.azimuth - 270) <= 45)
            ?? normalizeSpot({ id: 'west-wall', name: 'West-facing wall (vertical)', kind: 'wall', azimuth: 270, tilt: 90 });
        add(withNote(kitToSystem(o2.product, { catalog, dsSource: source, spot: pointed(wall, 270, 90), id: 'S03', name: `${o2.product.name} on a west wall` }), o2.note),
            { featured: true });
    }
    const o1 = pick(IDS.oct1, () => nearestKit(460, kits.filter((k) => k.octopus)) ?? nearestKit(460));
    if (o1.product) add(withNote(placeKit(o1.product, { id: 'S04', name: o1.product.name }).sys, o1.note), { featured: true });
    const c2 = pick(IDS.cp2, () => nearestKit(1030, kits.filter((k) => k.singleInput)));
    if (c2.product) add(withNote(placeKit(c2.product, { id: 'S05', name: c2.product.name }).sys, c2.note), { featured: true });
    const c1 = pick(IDS.cp1, () => nearestKit(465, kits.filter((k) => k.singleInput)));
    if (c1.product) add(withNote(placeKit(c1.product, { id: 'S06', name: c1.product.name }).sys, c1.note), { featured: true });

    // ── H1–H4: electrician-installed batteries
    const h1 = pick(IDS.h1, () => (catalog.bundles ?? [])[0] ?? null);
    if (h1.product) {
        const template = bundleToSystem(h1.product, { catalog, id: 'H1' });
        const at = bestFit(rankSpots(engine, template, sp, memo, { plugin: false }), panelsOf(template));
        add(withNote(bundleToSystem(h1.product, { catalog, id: 'H1', name: `${h1.product.name} (electrician)`, spot: at ? pointed(at.spot, at.az, at.tilt) : null }), h1.note),
            { featured: true });
    }
    const loose = { count: 4, wp: findProduct(catalog, IDS.panel)?.includedPanels?.wp ?? 460, catalogId: IDS.panel, frameId: IDS.frame };
    for (const [sid, id, extraNote] of [['H2', IDS.h2, '2400 W of AC output — not limited to 800 W because it is wired in.'],
        ['H3', IDS.h3, 'Check the panels’ Voc is within its 50 V MPPT window (60 V max) before buying.']]) {
        const p = pick(id, () => (catalog.kits ?? []).find((k) => k.kind === 'battery-inverter' && k.onSale && k.inputs.length >= 2) ?? null);
        if (!p.product) continue;
        const template = kitToSystem(p.product, { catalog, panels: loose, id: sid });
        const at = bestFit(rankSpots(engine, template, sp, memo, { plugin: false }), 4);
        const sys = kitToSystem(p.product, { catalog, panels: loose, id: sid, name: `${p.product.name} + 4×${loose.wp} W`, spot: at ? pointed(at.spot, at.az, at.tilt) : null });
        add(withNote({ ...sys, notes: [...sys.notes, extraNote] }, p.note), { featured: true });
    }
    const h4 = pick(IDS.h4, () => (catalog.kits ?? []).find((k) => k.kind === 'battery-addon' && k.onSale) ?? null);
    if (h4.product) add(withNote(kitToSystem(h4.product, { catalog, id: 'H4', name: `Battery only: ${h4.product.name}` }), h4.note), { featured: true });

    // ── U1–U3: power stations for the servers
    const u1 = pick(IDS.u1, () => (catalog.stations ?? []).find((s) => s.availableNow) ?? null);
    if (u1.product) add(withNote(stationToSystem(u1.product, { catalog, id: 'U1', name: `Power station for the servers: ${u1.product.name} ${u1.product.capacityKwh.toFixed(0)} kWh` }), u1.note), { featured: true });
    const u2 = pick(IDS.u2, () => (catalog.stations ?? []).filter((s) => s.availableNow).sort((a, b) => (a.assumedP0W ?? 99) - (b.assumedP0W ?? 99))[0] ?? null);
    if (u2.product) add(withNote(stationToSystem(u2.product, { catalog, id: 'U2', name: `Power station for the servers: ${u2.product.name} ${u2.product.capacityKwh.toFixed(0)} kWh` }), u2.note), { featured: true });
    let u3 = null;
    if (u1.product) {
        // the station's panels stand on the best free spot (they are not grid-tied, so no plug-in limits)
        const ref = s01At ? bestFit(s01At.ranked, u1.product.pvWireablePanels) : null;
        u3 = add(withNote(stationToSystem(u1.product, { catalog, id: 'U3', name: `${u1.product.name} + ${u1.product.pvWireablePanels}×${loose.wp} W on its own solar inputs`,
            panels: { count: u1.product.pvWireablePanels, wp: loose.wp, spot: ref ? pointed(ref.spot, ref.az, ref.tilt) : null } }), u1.note), { featured: true });
    }

    // ── the best plug-in kit (proxy NPV over 10 years) for C1 and W3
    let bestKit = null;
    let bestKitScore = -Infinity;
    for (const k of kits) {
        const r = placeKit(k);
        // the bucket's sweep chose the direction; value THIS kit there (one proxy cell)
        const gbp = r.at ? engine.placementCells(r.sys, [{ az: r.at.az, tilt: r.at.tilt }])[0].gbp : 0;
        const score = 10 * gbp - (k.priceGbp ?? 0);
        if (score > bestKitScore) { bestKitScore = score; bestKit = r; }
    }

    // ── C1: plug-in kit + the U3 power station (legal 'check')
    if (bestKit && u3) {
        const k = bestKit.sys;
        add({
            ...k, id: 'C1', name: `${k.name} + ${u3.name}`, route: 'plugin', battery: u3.battery,
            costs: [...k.costs, ...u3.costs], sourceIds: [...k.sourceIds, ...u3.sourceIds],
            notes: [...k.notes, 'Check first: plug-in kits’ instructions forbid using them “in conjunction with a battery”. A power station that only charges from a normal socket is arguably just a load, but nobody has confirmed this.'],
        }, { featured: true });
    }

    // ── W1–W3: if the rules change
    const vault = pick(IDS.vault, () => (catalog.kits ?? []).find((k) => k.kind === 'battery-addon' && k.battery?.capacityKwh < 3) ?? null);
    if (s01 && vault.product) {
        const vb = { ...vault.product.battery, coupling: 'ac' };
        const vCost = { label: `${vault.product.name} as a plug-in battery`, gbp: vault.product.priceGbp, year: 0, kind: 'hardware' };
        const whatNote = 'Plug-in batteries aren’t legal in GB yet (Octopus hopes for early 2027).';
        add(withNote({ ...s01, id: 'W1', name: `${s01.name} + plug-in battery (if legalised)`, route: 'whatif', battery: vb,
            costs: [...s01.costs, vCost], sourceIds: [...s01.sourceIds, vault.product.id], notes: [...s01.notes, whatNote] }, vault.note), { featured: true });
        add(withNote({ ...s01, id: 'W2', name: `${s01.name} now, add a plug-in battery later`, route: 'whatif',
            upgrade: { atYear: 1, label: 'Add a plug-in battery', battery: vb, route: 'whatif', costs: [{ ...vCost, year: 0 }] },
            sourceIds: [...s01.sourceIds, vault.product.id], notes: [...s01.notes, whatNote] }, vault.note), { featured: true });
    }
    if (bestKit) {
        const k = bestKit.sys;
        const kit = findProduct(catalog, k.kitId);
        const second = bestFit(bestKit.ranked, panelsOf(k), bestKit.at?.spot.id) ?? bestKit.at;
        const spot2 = second ? pointed(second.spot, second.az, second.tilt) : null;
        const twin = kitToSystem(kit, { catalog, dsSource: source, spot: spot2 });
        const nIn = k.inverter.inputs.length;
        add({
            ...k, id: 'W3', name: `Two ${k.name} kits (if one per circuit is allowed)`, route: 'whatif',
            inverter: { ...k.inverter, acLimitW: 2 * k.inverter.acLimitW, inputs: [...k.inverter.inputs, ...twin.inverter.inputs] },
            arrays: [...k.arrays, ...twin.arrays.map((a, i) => ({ ...a, id: `b${i}`, input: a.input + nIn }))],
            costs: [...k.costs, ...twin.costs.map((c) => ({ ...c, label: `Second ${c.label}` }))],
            sourceIds: [...k.sourceIds, ...twin.sourceIds],
            notes: [...k.notes, `The second kit goes on: ${second?.spot.name ?? 'the next-best spot'}.`, 'Only one plug-in kit per home is allowed today (a “one per circuit” rule is proposed).'],
        }, { featured: true });
    }

    // ── R0, R1: reference points
    add({ id: 'R0', name: 'Do nothing', route: 'reference', arrays: [], costs: [] }, { featured: true });
    add({ id: 'R1', name: 'Cut 100 W of always-on load', route: 'reference', arrays: [], costs: [], loadAdjustW: -100,
        notes: ['Switching off 100 W of servers for good — free, and the yardstick for every option here.'] }, { featured: true });

    // ── leaderboard rows (Compare / "show all")
    const have = new Set(out.flatMap((s) => [s.kitId, ...s.sourceIds]));
    for (const id of IDS.leaderKits) {
        const k = findProduct(catalog, id);
        if (!k || !k.includedPanels) continue;
        add(placeKit(k, { id: `L-${id}`, name: k.name }).sys, { featured: false });
    }
    for (const id of IDS.leaderBundles) {
        const b = findProduct(catalog, id);
        if (!b) continue;
        const template = bundleToSystem(b, { catalog, id: `L-${id}` });
        const at = bestFit(rankSpots(engine, template, sp, memo, { plugin: false }), panelsOf(template));
        add(bundleToSystem(b, { catalog, id: `L-${id}`, name: `${b.name} (electrician)`, spot: at ? pointed(at.spot, at.az, at.tilt) : null }), { featured: false });
    }
    for (const st of catalog.stations ?? []) {
        if (!st.availableNow || have.has(st.id)) continue;
        add(stationToSystem(st, { catalog, id: `L-${st.id}`, name: `Power station: ${st.name}` }), { featured: false });
    }
    if (subst.length && out.length) out[0] = normalizeSystem({ ...out[0], notes: [...out[0].notes, ...subst] });
    return out;
}
