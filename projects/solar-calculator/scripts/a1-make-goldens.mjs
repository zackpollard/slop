// a1-make-goldens.mjs — dev-only: regenerate the port-fidelity fixtures for the solar physics
// tests from the RESEARCH reference modules (not shipped; the app never imports them).
//
//   node projects/solar-calculator/scripts/a1-make-goldens.mjs [researchDir]
//
// researchDir (or SOLAR_RESEARCH_DIR) is the research folder; it must contain pv-reference-verified.js,
// weather-align-reference.mjs, demo-london-12m-halfhourly.json and the raw Open-Meteo year files.
// Writes lib/slopnet/__tests__/fixtures/solar/a1-{pv-golden,weather-align,sun-ref,climatology}.json.
//
// One intentional difference from the reference is applied before simulating: pv.js interpolates
// temperature/wind (slot-midpoint values) between slot MIDPOINTS, whereas the reference's
// hourlyToHalfHourly ramps from the previous record to the current one across the slot (right for
// hourly period-ending input, 15 min late for aligned half-hours). The golden samples get the
// midpoint interpolation so everything else in the chain is compared exactly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const RESEARCH = process.argv[2] ?? process.env.SOLAR_RESEARCH_DIR;
if (!RESEARCH) {
    console.error('usage: node projects/solar-calculator/scripts/a1-make-goldens.mjs <researchDir>  (or set SOLAR_RESEARCH_DIR)');
    process.exit(2);
}
const OUT = path.join(ROOT, 'lib/slopnet/__tests__/fixtures/solar');
fs.mkdirSync(OUT, { recursive: true });

const ref = await import(pathToFileURL(path.join(RESEARCH, 'pv-reference-verified.js')).href);
const wref = await import(pathToFileURL(path.join(RESEARCH, 'weather-align-reference.mjs')).href);
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(RESEARCH, f), 'utf8'));
const write = (name, obj) => {
    const file = path.join(OUT, name);
    fs.writeFileSync(file, JSON.stringify(obj));
    console.log(name, (fs.statSync(file).size / 1024).toFixed(1), 'kB');
};
const r6 = (v) => (Number.isFinite(v) ? +v.toPrecision(12) : v);

const SLOT = 1800e3;
const LAT = 51.5072, LON = -0.1276, ALT = 16;
const LINKE = [3.35, 4.35, 3.95, 3.65, 4.6, 4.95, 4.4, 4.3, 3.85, 3.45, 3.1, 3.15];

/* ── 1. PV chain goldens on two 7-day slices of the aligned demo year ── */
{
    const demo = readJson('demo-london-12m-halfhourly.json');
    const start0 = Date.parse(demo.meta.start_utc);
    const f32 = (a) => a.map((v) => Math.fround(v)); // what the app's Float32 slot arrays will hold
    // my-array → reference-array mapping (app units: % and compass azimuth)
    const configs = {
        S45: [{ tilt: 45, azimuth: 180, input: 0 }, { tilt: 45, azimuth: 180, input: 1 }],
        W90: [{ tilt: 90, azimuth: 270, input: 0 }, { tilt: 90, azimuth: 270, input: 1 }],
        'E90+W90': [{ tilt: 90, azimuth: 90, input: 0 }, { tilt: 90, azimuth: 270, input: 1 }],
        // a single 800 Wp wall on one 400 W channel: input clipping, horizon, bifacial rear (incl.
        // the blocked-sun Perez re-classification), ground self-shade, beam/diffuse shading, Huld 2025
        W90wall: [{
            tilt: 90, azimuth: 260, input: 0, count: 2, wp: 400, mounting: 'wall', groundSelfShade: true, bifaciality: 0.7,
            rearShading: 0.6, dcModel: 'huld2025', beamShadingPct: 5, diffuseShadingPct: 3,
            horizon: [5, 5, 6, 8, 10, 12, 15, 18, 20, 22, 20, 15, 12, 10, 8, 6, 5, 5, 4, 4, 5, 8, 12, 16, 22, 25, 22, 18, 14, 10, 8, 6, 5, 5, 5, 5],
        }],
        // 2 × 500 Wp S35 Hay–Davies: AC clipping at 800 W
        S35x500HD: [{ tilt: 35, azimuth: 180, input: 0, wp: 500, transposition: 'haydavies' }, { tilt: 35, azimuth: 180, input: 1, wp: 500, transposition: 'haydavies' }],
        // isotropic, railing preset, bifacial + low tilt, lumped shading 3%
        SE30iso: [{ tilt: 30, azimuth: 135, input: 0, mounting: 'railing', transposition: 'isotropic', bifaciality: 0.8, rearShading: 0.5, shadingPct: 3 }],
    };
    const FAI = { open: [26.9, 6.2], roof: [20, 3.2], railing: [24, 5], wall: [21, 3.5] };
    const toRef = (a) => {
        const mounting = a.mounting ?? 'open';
        return {
            tilt: a.tilt, surfaceAzimuth: a.azimuth, pdc0: (a.count ?? 1) * (a.wp ?? 400), input: a.input,
            transposition: a.transposition ?? 'perez', iam: { model: 'martin-ruiz', ar: 0.16 },
            faiman: { u0: FAI[mounting][0], u1: FAI[mounting][1] }, gamma: -0.003, lowLightK: 0.007,
            dcModel: a.dcModel ?? 'pvwatts', bifaciality: a.bifaciality ?? 0, rearShading: a.rearShading ?? 0.6,
            groundSelfShade: a.groundSelfShade ?? (mounting === 'railing' || mounting === 'wall'),
            horizon: a.horizon, beamShading: (a.beamShadingPct ?? 0) / 100, diffuseShading: (a.diffuseShadingPct ?? 0) / 100,
        };
    };
    // pv.js drops the lumped shading % once a horizon or beam/diffuse shading is given
    const lumped = ([a]) => (a.horizon?.length || a.beamShadingPct || a.diffuseShadingPct ? 0 : a.shadingPct ?? 0);
    const slices = [];
    for (const [name, iso] of [['midsummer', '2026-06-18T00:00:00Z'], ['dst-spring', '2026-03-26T00:00:00Z']]) {
        const s = Date.parse(iso), n = 7 * 48, k0 = (s - start0) / SLOT;
        const pick = (arr) => f32(arr.slice(k0, k0 + n));
        const ghi = pick(demo.ghi), dni = pick(demo.dni), dhi = pick(demo.dhi), temp = pick(demo.temp), wind = pick(demo.wind);
        const recs = ghi.map((g, k) => ({ tEnd: s + (k + 1) * SLOT, ghi: g, dhi: dhi[k], tAir: temp[k], wind: wind[k] }));
        const hh = ref.hourlyToHalfHourly(recs, { lat: LAT, lon: LON, altitude: ALT }, { periodMinutes: 30, subSteps: 3, linke: LINKE });
        // midpoint-to-midpoint interpolation of the slot-midpoint temperature/wind (see header)
        const at = (arr, k) => arr[Math.min(Math.max(k, 0), n - 1)];
        hh.forEach((slot, t) => slot.samples.forEach((smp, j) => {
            const tau = (j + 0.5) / 3;
            for (const [key, arr] of [['tAir', temp], ['wind', wind]]) {
                smp[key] = tau < 0.5 ? at(arr, t - 1) + (at(arr, t) - at(arr, t - 1)) * (tau + 0.5)
                    : at(arr, t) + (at(arr, t + 1) - at(arr, t)) * (tau - 0.5);
            }
        }));
        const out = {};
        for (const [cname, arrays] of Object.entries(configs)) {
            const lossPct = lumped(arrays);
            const losses = { soiling: 2, mismatch: 1, wiring: 1, lid: 1, availability: 1, ...(lossPct ? { shading: lossPct } : {}) };
            const res = ref.simulateHalfHours(hh, {
                lat: LAT, lon: LON, arrays: arrays.map(toRef), losses,
                inverter: { pacMax: 800, etaNom: 0.96, nInputs: 2, inputMaxAc: [400, 400], standbyW: 0 },
            });
            out[cname] = { acWh: res.map((x) => r6(x.acWh)), dcWh: res.map((x) => r6(x.dcWh)) };
        }
        slices.push({ name, start: s, n, ghi, dni, dhi, tempC: temp, windMs: wind, golden: out });
    }
    write('a1-pv-golden.json', {
        note: 'Reference: research pv-reference-verified.js hourlyToHalfHourly(periodMinutes 30, subSteps 3, London Linke, altitude 16) + simulateHalfHours; temperature/wind re-interpolated midpoint-to-midpoint (see scripts/a1-make-goldens.mjs). Inputs are Float32-rounded demo-london-12m-halfhourly.json slots.',
        site: { lat: LAT, lon: LON, altitude: ALT, linke: LINKE },
        inverter: { acLimitW: 800, etaNom: 0.96, inputs: [{ maxAcW: 400 }, { maxAcW: 400 }], standbyW: 0 },
        arrayDefaults: { tempCoeffPct: -0.3, lowLightK: 0.007, shadingPct: 0, albedo: 0.2 },
        configs, slices,
    });
}

/* ── 2. Weather alignment on trimmed raw responses (SARAH-3 day, MSG-filled day, MSG+IFS day) ── */
{
    const start = Date.parse('2026-03-14T00:00:00Z'), n = 3 * 48;
    const lo = start - 3600e3, hi = start + n * SLOT + 3600e3;
    const trim = (resp) => {
        const keep = resp.hourly.time.map((t) => Date.parse(t + ':00Z')).map((ms) => ms >= lo && ms <= hi);
        const hourly = {};
        for (const [k, v] of Object.entries(resp.hourly)) if (k !== 'cloud_cover' && k !== 'direct_radiation') hourly[k] = v.filter((_, i) => keep[i]);
        const { latitude, longitude, utc_offset_seconds, timezone } = resp;
        return { latitude, longitude, utc_offset_seconds, timezone, hourly };
    };
    const sarah3 = trim(readJson('openmeteo-london-12m-sarah3-30min.json'));
    const msg = trim(readJson('openmeteo-london-12m-msg-15min.json'));
    const archive = trim(readJson('openmeteo-london-12m.json'));
    const res = wref.alignToSlots({ sarah3, msg, archive }, LAT, LON, start, n);
    const arr = (a) => Array.from(a, (v) => (Number.isFinite(v) ? r6(v) : null));
    write('a1-weather-align.json', {
        note: 'Raw Open-Meteo responses (research 12-month files, trimmed) and the research weather-align-reference.mjs alignToSlots output (src 2 = IFS WITHOUT the 0.93 factor; src 3 = missing in the reference).',
        lat: LAT, lon: LON, start, n, sarah3, msg, archive,
        ref: { ghi: arr(res.ghi), dni: arr(res.dni), dhi: arr(res.dhi), temp: arr(res.temp), wind: arr(res.wind), src: Array.from(res.src) },
    });
}

/* ── 3. Sun position and meanCosZ from the reference implementations ── */
{
    let seed = 20261005;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const rows = [];
    for (let i = 0; i < 80; i++) {
        const ms = Math.round(Date.UTC(2000, 0, 1) + rnd() * (Date.UTC(2045, 0, 1) - Date.UTC(2000, 0, 1)));
        const lat = -65 + 130 * rnd(), lon = -180 + 360 * rnd();
        const sp = ref.sunPosition(ms, lat, lon);
        rows.push([ms, lat, lon, sp.zenith, sp.zenithTrue, sp.azimuth, sp.declination]);
    }
    const mcz = [];
    for (let i = 0; i < 40; i++) {
        const a = Date.parse('2026-01-01T00:00:00Z') + Math.floor(rnd() * 365 * 48) * SLOT;
        mcz.push([a, a + SLOT, ref.sunPosition(a, LAT, LON).zenith, wref.meanCosZ(a, a + SLOT, LAT, LON)]);
    }
    const nrelMs = Date.UTC(2003, 9, 17, 19, 30, 30);
    const nrel = ref.sunPosition(nrelMs, 39.742476, -105.1786, { pressureHpa: 820, tempC: 11 });
    const cs = [0, 20, 45, 60, 75, 85, 88, 89.5].map((z) => [z, ...Object.values(ref.clearSkyIneichen(z, 172, 3.35, 16))]);
    write('a1-sun-ref.json', {
        note: 'research pv-reference-verified.js sunPosition (default refraction 1010 hPa / 10 C) rows [ms, lat, lon, zenithApparent, zenithTrue, azimuth, declination]; weather-align-reference.mjs meanCosZ rows [a, b, -, mcz] at London.',
        rows, meanCosZ: mcz.map(([a, b, , v]) => [a, b, v]),
        nrel: { ms: nrelMs, zenith: nrel.zenith, azimuth: nrel.azimuth },
        clearSkyDoy172Tl335Alt16: cs,
    });
}

/* ── 4. SARAH-3 daily climatology (compact) + the verifier's corrected annual/monthly values ── */
{
    const daily = readJson('samples/sarah3-london-daily-2005-2025.json');
    const verified = readJson('samples/sarah3-london-annual-2006-2025-verified.json');
    write('a1-climatology.json', {
        note: 'research samples/sarah3-london-daily-2005-2025.json (MJ/m2/day, timezone GMT) as one value per day from start; expected values from samples/sarah3-london-annual-2006-2025-verified.json.',
        latitude: daily.latitude, longitude: daily.longitude, start: daily.daily.time[0], mjm2: daily.daily.shortwave_radiation_sum,
        expected: { annual: verified.annual_kwh_m2, monthlyClimatology: verified.monthly_climatology_2006_2025_kwh_m2, mean: verified.mean_2006_2025, monthly2008: verified.monthly_kwh_m2['2008'] },
    });
}
