/*
 * b1-load.js — shared loaders for the B1 (decision layer) tests: the shipped catalog files, the
 * shipped demo year, a slice of it (fast engine tests), and constant-load variants (T2/T5 style).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { demoDatasetFromJson } from '../../../../../projects/solar-calculator/js/dataset.js';
import { normalizeCatalog } from '../../../../../projects/solar-calculator/js/kits.js';

const DATA = new URL('../../../../../projects/solar-calculator/data/', import.meta.url);
const cache = new Map();

/** Parsed data/<name>.json (cached; treat as read-only). */
export function dataFile(name) {
    if (!cache.has(name)) cache.set(name, JSON.parse(readFileSync(fileURLToPath(new URL(`${name}.json`, DATA)), 'utf8')));
    return cache.get(name);
}

/** The wrapped data files exactly as the worker's catalog loader hands them over. */
export function rawCatalog() {
    const kits = dataFile('kits');
    const stations = dataFile('stations');
    const bundles = dataFile('bundles');
    return { kits: kits.kits, stations: stations.stations, bundles: bundles.bundles, constants: dataFile('constants'), stationDefaults: stations.defaults, raw: { kits, stations, bundles } };
}

/** normalizeCatalog over the shipped files. */
export function loadCatalog() {
    return normalizeCatalog(rawCatalog());
}

/** The demo Dataset (real London prices + sunshine, synthetic household + servers). */
export function loadDemo({ serverW = 500 } = {}) {
    return demoDatasetFromJson(dataFile('demo'), { serverW });
}

/**
 * A slice of the demo year starting at a local midnight (fast engine tests). Every per-slot
 * array of demo.json is cut to the window; the climatology rides along unchanged.
 * @param {string} fromIso UTC instant of the first slot
 * @param {number} days
 */
export function sliceDemo(fromIso, days, { serverW = 500 } = {}) {
    const j = dataFile('demo');
    const off = Math.round((Date.parse(fromIso) - Number(j.start)) / 1_800_000);
    const n = days * 48;
    const cut = (a) => a.slice(off, off + n);
    const json = {
        ...j, start: Number(j.start) + off * 1_800_000, n,
        importExc: cut(j.importExc), exportAgile: cut(j.exportAgile), ghi: cut(j.ghi), dni: cut(j.dni), dhi: cut(j.dhi),
        tempC: cut(j.tempC), windMs: cut(j.windMs), wxSource: cut(j.wxSource),
    };
    return demoDatasetFromJson(json, { serverW });
}

/** The same dataset with a constant always-on load and no filled slots (T2/T5 setups). */
export function constantLoad(ds, w) {
    return { ...ds, id: `${ds.id}~c${w}`, load: new Float64Array(ds.n).fill((w * 0.5) / 1000), loadFilled: new Uint8Array(ds.n) };
}

/** "Today" for every B1 test (default install date 1 Nov 2026, as the contract assumes). */
export const NOW = Date.parse('2026-10-05T12:00:00Z');
