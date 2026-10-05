// a1-t3.mjs — dev-only: engine-critique acceptance T3 (PV chain, full year) for the physics modules.
//
//   node projects/solar-calculator/scripts/a1-t3.mjs [researchDir]
//
// Runs pv.js over the shipped data/demo.json (London, 1 Oct 2025 – 30 Sep 2026, already joined to
// Agile C prices by epoch ms) with the sweep-12m.mjs settings and prints kWh / £ as billed /
// 16–19 local kWh against the T3 expectations (±0.2% kWh and £, ±0.3 kWh on 16–19). The same
// check runs in lib/slopnet/__tests__/solar-pv.test.js; this script prints the whole table.
//
// With a research folder (argument or SOLAR_RESEARCH_DIR) holding pv-reference-verified.js and
// demo-london-12m-halfhourly.json it also re-runs the reference chain on the unrounded research
// weather, separating port differences from the intentional temperature-interpolation change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareGeometry, prepareSky, simulatePv, lossFactor, DEFAULT_LOSSES } from '../js/pv.js';
import { buildLocalIndex, SLOT_MS } from '../js/time.js';
import { withVat } from '../js/vat.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESEARCH = process.argv[2] ?? process.env.SOLAR_RESEARCH_DIR ?? null;
const demo = JSON.parse(fs.readFileSync(path.join(HERE, '../data/demo.json'), 'utf8'));

const { start, n } = demo;
const ds = {
    start, n, ghi: Float32Array.from(demo.ghi), dni: Float32Array.from(demo.dni), dhi: Float32Array.from(demo.dhi),
    tempC: Float32Array.from(demo.tempC), windMs: Float32Array.from(demo.windMs),
};
// billed = ex-VAT × (1 + VAT in force); the whole demo year is before the 0% window
const price = withVat(Float64Array.from(demo.importExc), start);
const LINKE = [3.35, 4.35, 3.95, 3.65, 4.6, 4.95, 4.4, 4.3, 3.85, 3.45, 3.1, 3.15];
const site = { start, n, lat: demo.lat, lon: demo.lon, altitude: demo.altitude };
const local = buildLocalIndex(start, n);
const inverter = { acLimitW: 800, etaNom: 0.96, inputs: [{ maxAcW: 400 }, { maxAcW: 400 }], standbyW: 0 };
const arr = (tilt, azimuth, input, wp = 400) => ({
    count: 1, wp, tilt, azimuth, input, mounting: 'open', albedo: 0.2, tempCoeffPct: -0.3, lowLightK: 0.007,
    dcModel: 'pvwatts', shadingPct: 0, beamShadingPct: 0, diffuseShadingPct: 0, horizon: [], bifaciality: 0,
});
const cases = {
    'S45 2x400': { arrays: [arr(45, 180, 0), arr(45, 180, 1)], exp: [959.5, 161.45, 104.2] },
    'az210 t45 2x400': { arrays: [arr(45, 210, 0), arr(45, 210, 1)], exp: [926.3, 165.43, 159.9] },
    'SW45 2x400': { arrays: [arr(45, 225, 0), arr(45, 225, 1)], exp: [888.9, 163.90, 179.9] },
    'W45 2x400': { arrays: [arr(45, 270, 0), arr(45, 270, 1)], exp: [714.1, 143.49, 198.6] },
    'S90 2x400': { arrays: [arr(90, 180, 0), arr(90, 180, 1)], exp: [672.9, 111.89, 54.7] },
    'W90 2x400': { arrays: [arr(90, 270, 0), arr(90, 270, 1)], exp: [506.2, 113.95, 183.5] },
    'E90+W90 2x400': { arrays: [arr(90, 90, 0), arr(90, 270, 1)], exp: [513.1, 103.58, 106.9] },
    'S35 2x500': { arrays: [arr(35, 180, 0, 500), arr(35, 180, 1, 500)], exp: [1198.4, 203.37, null], clip: 7.8 },
};

const t0 = performance.now();
const geom = prepareGeometry(site, { subSteps: 3, linke: LINKE });
const sky = prepareSky(ds, geom);
const tPrep = performance.now() - t0;
console.log(`lossFactor ${lossFactor(DEFAULT_LOSSES).toFixed(5)}; geometry+sky ${tPrep.toFixed(0)} ms; annual GHI ${(demo.ghi.reduce((a, b) => a + b, 0) / 2000).toFixed(1)} kWh/m²`);

// optional: the research reference chain on the unrounded research weather (starts 2025-10-01T00:00Z)
let ref = null;
if (RESEARCH) {
    const refMod = await import(pathToFileURL(path.join(RESEARCH, 'pv-reference-verified.js')).href);
    const raw = JSON.parse(fs.readFileSync(path.join(RESEARCH, 'demo-london-12m-halfhourly.json'), 'utf8'));
    const rStart = Date.parse(raw.meta.start_utc);
    const recs = raw.ghi.map((g, k) => ({ tEnd: rStart + (k + 1) * SLOT_MS, ghi: g, dhi: raw.dhi[k], tAir: raw.temp[k], wind: raw.wind[k] }));
    ref = { mod: refMod, hh: refMod.hourlyToHalfHourly(recs, { lat: site.lat, lon: site.lon, altitude: site.altitude }, { periodMinutes: 30, subSteps: 3, linke: LINKE }) };
}

const pct = (a, b) => (100 * (a - b)) / b;
const rows = [];
for (const [name, c] of Object.entries(cases)) {
    const t1 = performance.now();
    const { pv } = simulatePv(sky, c.arrays, inverter);
    const ms = performance.now() - t1;
    let kwh = 0, gbp = 0, peak = 0, clipDc = 0;
    for (let t = 0; t < n; t++) {
        const e = pv.acKwh[t];
        if (!Number.isFinite(e)) throw new Error('NaN in acKwh');
        kwh += e; clipDc += pv.clippedDcKwh[t];
        if (local.peak[t]) peak += e;
        gbp += (e * price[t]) / 100;
    }
    const row = {
        name, kWh: +kwh.toFixed(2), gbp: +gbp.toFixed(3), peakKwh: +peak.toFixed(2), clippedDcKwh: +clipDc.toFixed(2), ms: +ms.toFixed(1),
        dKwhPct: +pct(kwh, c.exp[0]).toFixed(3), dGbpPct: +pct(gbp, c.exp[1]).toFixed(3),
        dPeakKwh: c.exp[2] == null ? null : +(peak - c.exp[2]).toFixed(2),
    };
    if (ref) {
        const toRef = (a) => ({ tilt: a.tilt, surfaceAzimuth: a.azimuth, albedo: a.albedo, pdc0: a.wp * a.count, input: a.input, transposition: 'perez', iam: { model: 'martin-ruiz', ar: 0.16 }, faiman: { u0: 26.9, u1: 6.2 }, gamma: -0.003, lowLightK: 0.007 });
        const r = ref.mod.simulateHalfHours(ref.hh, { lat: site.lat, lon: site.lon, arrays: c.arrays.map(toRef), losses: DEFAULT_LOSSES, inverter: { pacMax: 800, etaNom: 0.96, nInputs: 2, inputMaxAc: [400, 400], standbyW: 0 } });
        const refKwh = r.reduce((s, x) => s + x.acWh / 1000, 0);
        row.refVerifiedKwh = +refKwh.toFixed(2);
        row.refClippedMixedKwh = +r.reduce((s, x) => s + x.clippedWh / 1000, 0).toFixed(2);
        row.vsRefPct = +pct(kwh, refKwh).toFixed(4);
    }
    rows.push(row);
}
console.table(rows);
const bad = rows.filter((r) => Math.abs(r.dKwhPct) > 0.2 || Math.abs(r.dGbpPct) > 0.2 || (r.dPeakKwh != null && Math.abs(r.dPeakKwh) > 0.3));
console.log(bad.length ? `OUTSIDE T3 tolerance: ${bad.map((r) => r.name).join(', ')}` : 'all T3 rows within ±0.2% kWh/£ and ±0.3 kWh peak');
