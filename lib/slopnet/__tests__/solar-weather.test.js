import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
    MODELS, WX, IFS_SCALE, MAX_INTERP_SLOTS, buildUrls, alignToSlots, fetchWeather, onSatelliteGrid,
    climatologyFromDaily, climatologyUrl, fetchClimatology, typicalMonthScale, WeatherDataError, FETCH_ATTEMPTS,
} from '../../../projects/solar-calculator/js/weather.js';
import { meanCosZ, extraterrestrial, dayOfYear } from '../../../projects/solar-calculator/js/sun.js';
import { SLOT_MS, buildLocalIndex } from '../../../projects/solar-calculator/js/time.js';

const FIX = new URL('./fixtures/solar/', import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, FIX), 'utf8'));
const F = load('a1-weather-align.json');   // trimmed raw Open-Meteo + reference alignment output
const C = load('a1-climatology.json');     // SARAH-3 London daily sums 2005–2025
const Z = (s) => Date.parse(s);
const LAT = 51.5072, LON = -0.1276;
const allFinite = (a) => Array.from(a).every(Number.isFinite);

/** A synthetic Open-Meteo hourly response (unixtime) from label → row. */
function resp(rows, { latitude = 51.5, longitude = -0.15000153, step = SLOT_MS } = {}) {
    const keys = [...rows.keys()].sort((a, b) => a - b);
    const first = keys[0], last = keys[keys.length - 1];
    const hourly = { time: [], shortwave_radiation: [], direct_normal_irradiance: [], diffuse_radiation: [], temperature_2m: [], wind_speed_10m: [] };
    for (let ms = first; ms <= last; ms += step) {
        const r = rows.get(ms) ?? {};
        hourly.time.push(ms / 1000);
        hourly.shortwave_radiation.push(r.ghi ?? null);
        hourly.direct_normal_irradiance.push(r.dni ?? null);
        hourly.diffuse_radiation.push(r.dhi ?? null);
        hourly.temperature_2m.push(r.temp ?? null);
        hourly.wind_speed_10m.push(r.wind ?? null);
    }
    return { latitude, longitude, utc_offset_seconds: 0, timezone: 'GMT', hourly };
}
const archiveTemps = (from, to, f = () => ({ temp: 12, wind: 3 })) => {
    const m = new Map();
    for (let ms = from; ms <= to; ms += 3_600_000) m.set(ms, f(ms));
    return resp(m, { latitude: 51.493847, longitude: -0.1630249, step: 3_600_000 });
};

describe('buildUrls', () => {
    const now = Z('2026-10-05T09:00:00Z');

    it('requests the UTC date of the first slot (a BST window starts the day before)', () => {
        const u = buildUrls({ lat: LAT, lon: LON, start: Z('2025-09-30T23:00:00Z'), n: 17_520, nowMs: now });
        expect(u.startDate).toBe('2025-09-30');
        expect(u.endDate).toBe('2026-10-01'); // last slot 2026-09-30T22:30Z → + 1 day
        for (const url of [u.sarah3, u.msg, u.archive]) {
            expect(url).toContain('start_date=2025-09-30');
            expect(url).toContain('end_date=2026-10-01');
            expect(url).toContain('timezone=GMT');
            expect(url).toContain('timeformat=unixtime');
            expect(url.match(/models=/g)).toHaveLength(1); // one model per request, always explicit
        }
        expect(u.sarah3).toContain(`models=${MODELS.sarah3}`);
        expect(u.sarah3).toContain('temporal_resolution=native');
        expect(u.sarah3.startsWith('https://satellite-api.open-meteo.com/v1/archive?')).toBe(true);
        expect(u.msg).toContain(`models=${MODELS.msg}`);
        expect(u.archive).toContain(`models=${MODELS.archive}`);
        expect(u.archive).toContain('wind_speed_unit=ms');
        expect(u.archive).toContain('temperature_2m,wind_speed_10m');
        expect(u.archive.startsWith('https://archive-api.open-meteo.com/v1/archive?')).toBe(true);
        expect(u.sarah3).toContain('latitude=51.5072&longitude=-0.1276');
    });

    it('caps end_date at today (UTC) and never asks MSG for 2024', () => {
        const u = buildUrls({ lat: LAT, lon: LON, start: Z('2025-10-01T00:00:00Z'), n: 17_520, nowMs: Z('2026-09-30T10:00:00Z') });
        expect(u.endDate).toBe('2026-09-30');
        const old = buildUrls({ lat: LAT, lon: LON, start: Z('2024-06-01T00:00:00Z'), n: 48, nowMs: now });
        expect(old.msg).toContain('start_date=2025-01-01');
        expect(old.sarah3).toContain('start_date=2024-06-01');
    });

    it('builds the 2006–2025 climatology request', () => {
        const url = climatologyUrl({ lat: LAT, lon: LON });
        expect(url).toContain('daily=shortwave_radiation_sum');
        expect(url).toContain('models=eumetsat_sarah3');
        expect(url).toContain('start_date=2006-01-01&end_date=2025-12-31');
    });
});

describe('alignToSlots on real Open-Meteo responses vs weather-align-reference.mjs', () => {
    const out = alignToSlots({ sarah3: F.sarah3, msg: F.msg, archive: F.archive }, F.lat, F.lon, F.start, F.n);

    it('reproduces the reference to Float32 precision (IFS rows ×0.93 by design)', () => {
        // the outputs are Float32 (≈ 6e-5 W/m² resolution at 1000 W/m²); anything larger is a
        // change in the alignment rule, not rounding
        const used = new Set();
        for (let k = 0; k < F.n; k++) {
            const src = F.ref.src[k];
            used.add(src);
            const f = src === WX.IFS ? IFS_SCALE : 1;
            expect(out.wxSource[k]).toBe(src);
            expect(Math.abs(out.ghi[k] - F.ref.ghi[k] * f)).toBeLessThan(1e-3);
            expect(Math.abs(out.dhi[k] - F.ref.dhi[k] * f)).toBeLessThan(1e-3);
            expect(Math.abs(out.dni[k] - F.ref.dni[k])).toBeLessThan(1e-3);
            expect(Math.abs(out.tempC[k] - F.ref.temp[k])).toBeLessThan(1e-4);
            expect(Math.abs(out.windMs[k] - F.ref.wind[k])).toBeLessThan(1e-4);
        }
        expect([...used].sort()).toEqual([0, 1, 2]); // the slice exercises all three sources
    });

    it('reports source counts, the grid cell and notes', () => {
        expect(out.meta.counts.reduce((a, b) => a + b, 0)).toBe(F.n);
        expect(out.meta.counts[WX.IFS]).toBe(2);
        expect(out.meta.ifsScaled).toBe(true);
        expect([out.meta.gridLat, out.meta.gridLon]).toEqual([51.5, -0.15000153]);
        expect(out.meta.sarahLastMs).toBeGreaterThan(F.start);
        expect(out.meta.notes.join(' ')).toMatch(/MSG/);
        for (const k of ['ghi', 'dni', 'dhi', 'tempC', 'windMs']) {
            expect(out[k]).toBeInstanceOf(Float32Array);
            expect(allFinite(out[k])).toBe(true);
        }
        expect(out.wxSource).toBeInstanceOf(Uint8Array);
    });
});

describe('the SARAH-3 label rule', () => {
    // label-coded values reveal which label each slot used and with what factor
    const check = (lat, lon, day) => {
        const start = Z(day + 'T00:00:00Z'), n = 48;
        const rows = new Map();
        for (let k = -1; k <= n; k++) {
            const L = start + k * SLOT_MS;
            rows.set(L, { ghi: 1000 + k, dhi: 500 + k, dni: 100 + k });
        }
        const out = alignToSlots({ sarah3: resp(rows), archive: archiveTemps(start - 3_600_000, start + 26 * 3_600_000) }, lat, lon, start, n);
        let sunrise = 0, scaled = 0;
        for (let k = 0; k < n; k++) {
            const S = start + k * SLOT_MS;
            const mp = meanCosZ(S - SLOT_MS, S, lat, lon), mn = meanCosZ(S, S + SLOT_MS, lat, lon);
            expect(out.wxSource[k]).toBe(WX.SARAH3);
            if (mn <= 0) { expect(out.ghi[k]).toBe(0); expect(out.dni[k]).toBe(0); continue; }
            if (mp >= 0.05) {
                const fac = Math.min(mn / mp, 3);
                expect(out.ghi[k]).toBeCloseTo((1000 + k) * fac, 3); // label S, rescaled
                expect(out.dhi[k]).toBeCloseTo((500 + k) * fac, 3);
                expect(out.dni[k]).toBeCloseTo(100 + k, 4);          // DNI unchanged
                expect(fac).toBeLessThanOrEqual(3);
                if (fac !== 1) scaled++;
            } else {
                expect(out.ghi[k]).toBeCloseTo(1000 + k + 1, 3);       // sunrise: label S+30 unscaled
                sunrise++;
            }
        }
        return { sunrise, scaled };
    };

    it('uses label S rescaled by mcz(S,S+30)/mcz(S−30,S), S+30 at sunrise, zero at night (London, both solstices)', () => {
        for (const day of ['2026-06-21', '2026-12-21']) {
            const r = check(LAT, LON, day);
            expect(r.sunrise).toBeGreaterThanOrEqual(1);
            expect(r.scaled).toBeGreaterThan(10);
        }
    });

    it('clamps the rescale factor at 3 where the sun climbs fast (equator)', () => {
        check(0.025, 0.025, '2026-03-20');
    });
});

describe('fallbacks, gaps and nulls', () => {
    const day = Z('2026-06-21T00:00:00Z');
    const n = 48;
    const fullSarah = () => {
        const m = new Map();
        for (let k = -1; k <= n; k++) {
            const S = day + k * SLOT_MS;
            const mn = meanCosZ(S, S + SLOT_MS, LAT, LON);
            const g = 750 * mn; // a clear-ish day with kt ≈ 0.55
            m.set(S, { ghi: g, dhi: 0.4 * g, dni: mn > 0 ? 400 : 0 });
        }
        return m;
    };
    const temps = archiveTemps(day - 3_600_000, day + 26 * 3_600_000);

    it('treats MSG night nulls as DNI 0 / DHI = GHI and averages labels S+15 and S+30', () => {
        const m = new Map();
        for (let ms = day; ms <= day + n * SLOT_MS; ms += 900_000) {
            const mn = meanCosZ(ms - 900_000, ms, LAT, LON);
            m.set(ms, mn > 0 ? { ghi: 600 * mn, dni: 300, dhi: 200 * mn } : { ghi: 0, dni: null, dhi: null });
        }
        const msg = resp(m, { step: 900_000 });
        const out = alignToSlots({ msg, archive: temps }, LAT, LON, day, n);
        for (let k = 0; k < n; k++) {
            expect(out.wxSource[k]).toBe(WX.MSG);
            const a = m.get(day + k * SLOT_MS + 900_000), b = m.get(day + (k + 1) * SLOT_MS);
            expect(out.ghi[k]).toBeCloseTo((a.ghi + b.ghi) / 2, 3);
            expect(out.dni[k]).toBeCloseTo(((a.dni ?? 0) + (b.dni ?? 0)) / 2, 3);
            expect(out.dhi[k]).toBeCloseTo(((a.dhi ?? a.ghi) + (b.dhi ?? b.ghi)) / 2, 3);
        }
        expect(out.ghi[2]).toBe(0);
        expect(out.dhi[2]).toBe(0);
    });

    it('falls back to IFS ×0.93 with the kt-preserving hourly split when both satellites are missing', () => {
        const ar = new Map();
        for (let ms = day - 3_600_000; ms <= day + 26 * 3_600_000; ms += 3_600_000) {
            const mh = meanCosZ(ms - 3_600_000, ms, LAT, LON);
            ar.set(ms, { ghi: 800 * mh, dhi: 300 * mh, dni: 350, temp: 15, wind: 4 });
        }
        const out = alignToSlots({ archive: resp(ar, { latitude: 51.493847, longitude: -0.1630249, step: 3_600_000 }) }, LAT, LON, day, n);
        expect(out.meta.ifsScaled).toBe(true);
        for (let k = 0; k < n; k++) {
            expect(out.wxSource[k]).toBe(WX.IFS);
            const S = day + k * SLOT_MS;
            const H = Math.floor(S / 3_600_000) * 3_600_000 + 3_600_000;
            const mh = meanCosZ(H - 3_600_000, H, LAT, LON), mn = meanCosZ(S, S + SLOT_MS, LAT, LON);
            const f = mh > 0 ? mn / mh : 0;
            expect(out.ghi[k]).toBeCloseTo(800 * mh * f * 0.93, 3);
            expect(out.dhi[k]).toBeCloseTo(300 * mh * f * 0.93, 3);
        }
        // the two half-hours of an hour average back to the hour (×0.93): energy conserving up to
        // the midpoint-rule sampling of mean cos z (10 samples per window)
        const k = 24, H = day + 13 * 3_600_000;
        const hour = 800 * meanCosZ(H - 3_600_000, H, LAT, LON) * 0.93;
        expect(Math.abs((out.ghi[k] + out.ghi[k + 1]) / 2 / hour - 1)).toBeLessThan(1e-4);
    });

    it('interpolates a short daylight gap in clearness index (src 4)', () => {
        const rows = fullSarah();
        const gap = [22, 23, 24, 25]; // 11:00–13:00Z
        for (const k of gap) rows.set(day + k * SLOT_MS, { ghi: null, dhi: null, dni: null });
        rows.set(day + 21 * SLOT_MS, { ...rows.get(day + 21 * SLOT_MS), ghi: 300 * meanCosZ(day + 21 * SLOT_MS, day + 22 * SLOT_MS, LAT, LON) / 0.75 * 0.75 });
        const out = alignToSlots({ sarah3: resp(rows), archive: temps }, LAT, LON, day, n);
        const kt = (k) => out.ghi[k] / (extraterrestrial(dayOfYear(day + k * SLOT_MS)) * meanCosZ(day + k * SLOT_MS, day + (k + 1) * SLOT_MS, LAT, LON));
        for (const k of gap) {
            expect(out.wxSource[k]).toBe(WX.INTERP);
            expect(out.dni[k]).toBe(0);
            expect(out.ghi[k]).toBeGreaterThan(0);
            const lo = Math.min(kt(21), kt(26)), hi = Math.max(kt(21), kt(26));
            expect(kt(k)).toBeGreaterThanOrEqual(lo - 1e-6);
            expect(kt(k)).toBeLessThanOrEqual(hi + 1e-6);
        }
        expect(kt(23)).toBeCloseTo(kt(21) + ((kt(26) - kt(21)) * 2) / 5, 4);
        expect(out.dhi[22] / out.ghi[22]).toBeCloseTo(out.dhi[21] / out.ghi[21], 4); // nearer neighbour's diffuse share
        expect(out.dhi[25] / out.ghi[25]).toBeCloseTo(out.dhi[26] / out.ghi[26], 4);
        expect(out.meta.counts[WX.INTERP]).toBe(4);
        expect(out.meta.interpDaylightSlots).toBe(4);
        expect(out.meta.notes.join(' ')).toMatch(/4 daylight half-hours had no weather source/);
    });

    it(`throws a WEATHER DataError for more than ${MAX_INTERP_SLOTS} missing daylight slots`, () => {
        const rows = fullSarah();
        for (let k = 20; k < 27; k++) rows.set(day + k * SLOT_MS, { ghi: null, dhi: null, dni: null });
        let err = null;
        try { alignToSlots({ sarah3: resp(rows), archive: temps }, LAT, LON, day, n); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(WeatherDataError);
        expect(err).toMatchObject({ name: 'DataError', code: 'WEATHER', step: 'weather', retryable: true, action: 'retry' });
        expect(err.message).toMatch(/7 daylight half-hours/);
    });

    it('zero-fills missing NIGHT slots without complaint', () => {
        const rows = fullSarah();
        // labels 00:00–03:00Z gone; a night slot reads label S+30 (sunrise rule), so slots 0–5 have no source
        for (let k = 0; k <= 6; k++) rows.set(day + k * SLOT_MS, { ghi: null, dhi: null, dni: null });
        const out = alignToSlots({ sarah3: resp(rows), archive: archiveTemps(day - 3_600_000, day + 26 * 3_600_000, () => ({ temp: 9, wind: 1 })) }, LAT, LON, day, n);
        for (let k = 0; k < 6; k++) { expect(out.ghi[k]).toBe(0); expect(out.wxSource[k]).toBe(WX.INTERP); }
        expect(out.wxSource[6]).toBe(WX.SARAH3); // 03:00–03:30Z, sun still down, reads label 03:30
        // dark by geometry, not guessed: the quality note must not call these interpolated
        expect(out.meta.interpDaylightSlots).toBe(0);
        expect(out.meta.notes.join(' ')).not.toMatch(/interpolated/);
    });

    it('fills temperature/wind from the nearest value within 3 h, else 10 °C / 2 m/s', () => {
        const withHole = archiveTemps(day - 3_600_000, day + 26 * 3_600_000, (ms) => {
            const h = (ms - day) / 3_600_000;
            return h >= 10 && h <= 11 ? { temp: null, wind: null } : { temp: 10 + h, wind: 3 };
        });
        const out = alignToSlots({ sarah3: resp(fullSarah()), archive: withHole }, LAT, LON, day, n);
        expect(out.meta.tempFilledSlots).toBeGreaterThan(0);
        expect(out.meta.tempDefaultSlots).toBe(0);
        expect(allFinite(out.tempC)).toBe(true);
        expect(out.tempC[19]).toBeCloseTo(18.75, 4);        // 09:30Z slot: interpolated 09:45 between 09:00 and 10:00
        expect(out.tempC[20]).toBeCloseTo(18.75, 4);        // 10:00Z slot: needs 10:00 label → nearest earlier slot
        const none = alignToSlots({ sarah3: resp(fullSarah()) }, LAT, LON, day, n);
        expect(Array.from(none.tempC)).toEqual(new Array(n).fill(10));
        expect(Array.from(none.windMs)).toEqual(new Array(n).fill(2));
        expect(none.meta.tempDefaultSlots).toBe(n);
        expect(none.meta.notes.join(' ')).toMatch(/assumed 10 °C/);
    });

    it('ignores a "satellite" response that is not on the 0.05° grid (IFS in disguise)', () => {
        const fake = resp(fullSarah(), { latitude: 51.493847, longitude: -0.1630249 });
        expect(onSatelliteGrid(fake)).toBe(false);
        expect(onSatelliteGrid(resp(fullSarah()))).toBe(true);
        const ar = new Map();
        for (let ms = day - 3_600_000; ms <= day + 26 * 3_600_000; ms += 3_600_000) ar.set(ms, { ghi: 100, dhi: 50, dni: 10, temp: 12, wind: 2 });
        const out = alignToSlots({ sarah3: fake, archive: resp(ar, { latitude: 51.493847, longitude: -0.1630249, step: 3_600_000 }) }, LAT, LON, day, n);
        expect(out.meta.counts[WX.SARAH3]).toBe(0);
        expect(out.meta.counts[WX.IFS]).toBe(n);
        expect(out.meta.notes.join(' ')).toMatch(/not on the 0\.05° satellite grid/);
    });

    it('reads ISO-8601 GMT timestamps as well as unixtime', () => {
        const iso = { ...F.sarah3 };
        expect(typeof iso.hourly.time[0]).toBe('string');
        const asUnix = { ...F.sarah3, hourly: { ...F.sarah3.hourly, time: F.sarah3.hourly.time.map((t) => Date.parse(t + ':00Z') / 1000) } };
        const a = alignToSlots({ sarah3: iso, archive: F.archive }, F.lat, F.lon, F.start, 48);
        const b = alignToSlots({ sarah3: asUnix, archive: F.archive }, F.lat, F.lon, F.start, 48);
        expect(b.ghi).toEqual(a.ghi);
    });
});

describe('fetchWeather', () => {
    const now = Z('2026-10-05T09:00:00Z');
    const bodyFor = (url) => {
        const m = new URL(url).searchParams.get('models');
        return m === MODELS.sarah3 ? F.sarah3 : m === MODELS.msg ? F.msg : m === MODELS.archive ? F.archive : null;
    };
    const mockFetch = (calls, override = () => null) => async (url) => {
        calls.push(url);
        const o = override(url);
        if (o) return o;
        const body = bodyFor(url);
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const memCache = () => {
        const m = new Map();
        return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } };
    };

    it('fetches SARAH-3 + archive, then MSG only for the days SARAH-3 lacks', async () => {
        const calls = [];
        const progress = [];
        const res = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(calls), nowMs: now, onProgress: (p) => progress.push(p) });
        expect(calls.length).toBe(3);
        expect(calls.slice(0, 2).map((u) => new URL(u).searchParams.get('models')).sort()).toEqual([MODELS.sarah3, MODELS.archive].sort());
        const msgUrl = new URL(calls[2]);
        expect(msgUrl.searchParams.get('models')).toBe(MODELS.msg);
        expect(msgUrl.searchParams.get('start_date') >= '2026-03-14').toBe(true);
        expect(msgUrl.searchParams.get('end_date') <= '2026-03-17').toBe(true);
        const direct = alignToSlots({ sarah3: F.sarah3, msg: F.msg, archive: F.archive }, F.lat, F.lon, F.start, F.n);
        expect(res.ghi).toEqual(direct.ghi);
        expect(res.wxSource).toEqual(direct.wxSource);
        expect(progress.every((p) => p.step === 'weather')).toBe(true);
        expect(progress[progress.length - 1].status).toBe('done');
    });

    it('serves past windows from the cache and refreshes recent ones after 6 h', async () => {
        const cache = memCache();
        const calls = [];
        await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(calls), cache, nowMs: now });
        const first = calls.length;
        await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(calls), cache, nowMs: now });
        expect(calls.length).toBe(first);
        // same window seen from 2 days later: still "recent" → reused within 6 h, refetched after
        const recentNow = Z('2026-03-18T12:00:00Z');
        const c2 = [];
        await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(c2), cache: memCache(), nowMs: recentNow });
        const cache3 = memCache();
        const c3 = [];
        await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(c3), cache: cache3, nowMs: recentNow });
        await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(c3), cache: cache3, nowMs: recentNow + 3_600_000 });
        expect(c3.length).toBe(c2.length);
        await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(c3), cache: cache3, nowMs: recentNow + 7 * 3_600_000 });
        expect(c3.length).toBe(2 * c2.length);
    });

    it('treats a broken cache as a miss', async () => {
        const calls = [];
        const cache = { get: async () => { throw new Error('idb gone'); }, set: async () => { throw new Error('quota'); } };
        const res = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(calls), cache, nowMs: now });
        expect(res.ghi.length).toBe(F.n);
    });

    // Retries wait between attempts; tests record the waits instead of sleeping.
    const noSleep = (log = []) => Object.assign(async (ms) => { log.push(ms); }, { log });

    it('turns an HTTP 200 text body into a retryable error (never "not published yet"), without echoing the body', async () => {
        const text = { ok: true, status: 200, text: async () => 'Unexpected error while streaming data: cannotReturnModelsWithDifferentTimeIntervals' };
        const calls = [];
        const sleep = noSleep();
        const p = fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(calls, (u) => (u.includes('archive-api') ? text : null)), nowMs: now, sleep });
        // WEATHER would make the dataset shorten the period and claim the last days aren't published
        const err = await p.catch((e) => e);
        expect(err).toMatchObject({ name: 'DataError', code: 'NETWORK', retryable: true, action: 'retry', step: 'weather' });
        expect(err.message).toMatch(/temperature archive.*having problems \(an unreadable reply\)/);
        expect(err.message).not.toMatch(/Unexpected error|cannotReturn/);
        expect(calls.filter((u) => u.includes('archive-api'))).toHaveLength(FETCH_ATTEMPTS);
        expect(sleep.log).toEqual([1000, 3000]);
    });

    it('maps 429, 400 JSON errors and network failures', async () => {
        const r429 = { ok: false, status: 429, text: async () => '{"error":true,"reason":"Minutely API request limit exceeded"}' };
        const c429 = [];
        const s429 = noSleep();
        const e429 = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(c429, (u) => (u.includes('archive-api') ? r429 : null)), nowMs: now, sleep: s429 }).catch((e) => e);
        expect(e429).toMatchObject({ code: 'RATE_LIMIT', retryable: true });
        expect(e429.message).not.toMatch(/[{}]|"error"/); // no raw JSON in the error box
        expect(c429.filter((u) => u.includes('archive-api'))).toHaveLength(2); // one more try after a pause
        expect(s429.log).toEqual([5000]);
        const r400 = { ok: false, status: 400, text: async () => '{"error":true,"reason":"Parameter end_date is out of allowed range"}' };
        const c400 = [];
        await expect(fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(c400, (u) => (u.includes('archive-api') ? r400 : null)), nowMs: now, sleep: noSleep() }))
            .rejects.toThrow(/out of allowed range/);
        expect(c400.filter((u) => u.includes('archive-api'))).toHaveLength(1); // a 400 is never retried
        let tries = 0;
        const boom = async () => { tries++; throw new TypeError('Failed to fetch'); };
        await expect(fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: boom, nowMs: now, sleep: noSleep() }))
            .rejects.toMatchObject({ code: 'NETWORK', retryable: true, action: 'retry' });
        expect(tries).toBe(2 * FETCH_ATTEMPTS); // SARAH-3 and the archive, each tried 3 times
    });

    it('maps a body that dies mid-stream to NETWORK and a 4xx HTML page to a non-retryable error', async () => {
        const dropped = { ok: true, status: 200, text: async () => { throw new TypeError('network error'); } };
        await expect(fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch([], (u) => (u.includes('archive-api') ? dropped : null)), nowMs: now, sleep: noSleep() }))
            .rejects.toMatchObject({ name: 'DataError', code: 'NETWORK', retryable: true });
        const html = { ok: false, status: 404, text: async () => '<html>Not found</html>' };
        const e = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch([], (u) => (u.includes('archive-api') ? html : null)), nowMs: now, sleep: noSleep() }).catch((x) => x);
        expect(e).toMatchObject({ code: 'WEATHER', retryable: false });
        expect(e.message).toMatch(/unreadable response \(HTTP 404\)/);
        expect(e.message).not.toMatch(/<html>/);
    });

    it('rides out one 502 on the archive, and a 5xx HTML page never reaches the message', async () => {
        const calls = [];
        let failed = 0;
        const once = (u) => (u.includes('archive-api') && failed++ === 0 ? { ok: false, status: 502, text: async () => '<html><body>502 Bad Gateway</body></html>' } : null);
        const sleep = noSleep();
        const res = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(calls, once), nowMs: now, sleep });
        const direct = alignToSlots({ sarah3: F.sarah3, msg: F.msg, archive: F.archive }, F.lat, F.lon, F.start, F.n);
        expect(res.ghi).toEqual(direct.ghi);
        expect(sleep.log).toEqual([1000]);
        // still failing after every try: a clean message naming what failed
        const always = (u) => (u.includes('archive-api') ? { ok: false, status: 502, text: async () => '<html><body>502 Bad Gateway</body></html>' } : null);
        const err = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch([], always), nowMs: now, sleep: noSleep() }).catch((e) => e);
        expect(err).toMatchObject({ code: 'NETWORK', retryable: true, action: 'retry' });
        expect(err.message).toBe('Open-Meteo’s temperature archive (ECMWF IFS) is having problems (HTTP 502). Retry in a few minutes.');
    });

    it('keeps SARAH-3 through one transient failure instead of silently swapping the year to MSG/IFS', async () => {
        const calls = [];
        let failed = 0;
        const once = (u) => (u.includes(MODELS.sarah3) && failed++ === 0 ? { ok: false, status: 502, text: async () => '<html>502</html>' } : null);
        const res = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch(calls, once), nowMs: now, sleep: noSleep() });
        const direct = alignToSlots({ sarah3: F.sarah3, msg: F.msg, archive: F.archive }, F.lat, F.lon, F.start, F.n);
        expect(res.meta.counts[WX.SARAH3]).toBe(direct.meta.counts[WX.SARAH3]);
        expect(res.meta.counts[WX.SARAH3]).toBeGreaterThan(0);
        expect(res.meta.notes.join(' ')).not.toMatch(/SARAH-3 unavailable/);
    });

    it('stops retrying as soon as the load is aborted', async () => {
        const ctl = new AbortController();
        let tries = 0;
        const flaky = async () => { tries++; throw new TypeError('Failed to fetch'); };
        const sleep = async () => { ctl.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
        await expect(fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: flaky, nowMs: now, sleep, signal: ctl.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(tries).toBeLessThanOrEqual(2); // one try per request, no retry after the abort
    });

    it('falls back to a stale cached response when the refresh fails on the network', async () => {
        const recentNow = Z('2026-03-18T12:00:00Z');
        const cache = memCache();
        const fresh = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: mockFetch([]), cache, nowMs: recentNow });
        const offline = async () => { throw new TypeError('Failed to fetch'); };
        const later = await fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: offline, cache, nowMs: recentNow + 7 * 3_600_000, sleep: noSleep() });
        expect(later.ghi).toEqual(fresh.ghi);
        // without a cached copy the same failure is still an error
        await expect(fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: offline, cache: memCache(), nowMs: recentNow, sleep: noSleep() }))
            .rejects.toMatchObject({ code: 'NETWORK' });
    });

    it('carries on with MSG/IFS when SARAH-3 keeps failing, and says so briefly', async () => {
        const calls = [];
        const res = await fetchWeather({
            lat: F.lat, lon: F.lon, start: F.start, n: F.n, nowMs: now, sleep: noSleep(),
            fetch: mockFetch(calls, (u) => (u.includes(MODELS.sarah3) ? { ok: false, status: 503, text: async () => 'The service is overloaded' } : null)),
        });
        expect(res.meta.counts[WX.SARAH3]).toBe(0);
        expect(res.meta.notes[0]).toBe('SARAH-3 unavailable (HTTP 503); using MSG/IFS instead.');
        expect(calls.filter((u) => u.includes(MODELS.sarah3))).toHaveLength(FETCH_ATTEMPTS);
        expect(allFinite(res.ghi)).toBe(true);
    });

    it('propagates aborts untouched', async () => {
        const abort = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
        await expect(fetchWeather({ lat: F.lat, lon: F.lon, start: F.start, n: F.n, fetch: abort, nowMs: now })).rejects.toMatchObject({ name: 'AbortError' });
    });
});

describe('climatology', () => {
    const dailyJson = (unix = false) => {
        const t0 = Z(C.start + 'T00:00:00Z');
        const time = C.mjm2.map((_, i) => (unix ? t0 / 1000 + i * 86_400 : new Date(t0 + i * 86_400_000).toISOString().slice(0, 10)));
        return { latitude: C.latitude, longitude: C.longitude, utc_offset_seconds: 0, daily: { time, shortwave_radiation_sum: C.mjm2 } };
    };
    const clim = climatologyFromDaily(dailyJson());
    const MM = (m0) => String(m0 + 1).padStart(2, '0'); // expected values are keyed '01'..'12'

    it('fills null days with the month-year mean (never sums them as 0)', () => {
        expect(Array.from(clim.years)).toEqual(Array.from({ length: 21 }, (_, i) => 2005 + i));
        clim.years.forEach((y, yi) => {
            let annual = 0;
            for (let m = 0; m < 12; m++) annual += clim.yearMonthlyKwhM2[yi * 12 + m];
            expect(Math.abs(annual - C.expected.annual[String(y)])).toBeLessThanOrEqual(0.051);
        });
        const y2008 = clim.years.indexOf(2008);
        for (let m = 0; m < 12; m++) {
            expect(Math.abs(clim.yearMonthlyKwhM2[y2008 * 12 + m] - C.expected.monthly2008[MM(m)])).toBeLessThanOrEqual(0.051);
        }
        // summing nulls as zero would understate 2008 (10 missing days)
        const t0 = Z(C.start + 'T00:00:00Z');
        let naive = 0;
        C.mjm2.forEach((v, i) => { if (new Date(t0 + i * 86_400_000).getUTCFullYear() === 2008) naive += (v ?? 0) / 3.6; });
        expect(naive).toBeLessThan(C.expected.annual['2008'] - 10);
    });

    it('gives the verified 2006–2025 monthly climatology and 1076.5 kWh/m² mean', () => {
        for (let m = 0; m < 12; m++) expect(Math.abs(clim.monthlyKwhM2[m] - C.expected.monthlyClimatology[MM(m)])).toBeLessThanOrEqual(0.051);
        const annual = clim.monthlyKwhM2.reduce((a, b) => a + b, 0);
        expect(Math.abs(annual - C.expected.mean)).toBeLessThanOrEqual(0.06);
        expect([clim.fromYear, clim.toYear]).toEqual([2006, 2025]);
        expect(clim.meanDim[1]).toBeCloseTo(28.25, 12);
        expect([clim.gridLat, clim.gridLon]).toEqual([51.5, -0.15000153]);
    });

    it('reads unixtime days identically and rejects empty responses', () => {
        const u = climatologyFromDaily(dailyJson(true));
        expect(u.monthlyKwhM2).toEqual(clim.monthlyKwhM2);
        expect(() => climatologyFromDaily({ daily: {} })).toThrow(/no daily data/);
        expect(() => climatologyFromDaily(null)).toThrow(WeatherDataError);
    });

    it('drops a year that has a month with no data at all', () => {
        const j = dailyJson();
        j.daily.shortwave_radiation_sum = j.daily.shortwave_radiation_sum.map((v, i) => (j.daily.time[i].startsWith('2010-07') ? null : v));
        const c = climatologyFromDaily(j);
        expect(Array.from(c.years)).not.toContain(2010);
        expect(c.years.length).toBe(20);
    });

    it('fetchClimatology checks the satellite grid', async () => {
        const ok = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(dailyJson(true)) });
        const c = await fetchClimatology({ lat: LAT, lon: LON, fetch: ok });
        expect(c.monthlyKwhM2).toEqual(clim.monthlyKwhM2);
        const off = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ...dailyJson(true), latitude: 51.493847 }) });
        await expect(fetchClimatology({ lat: LAT, lon: LON, fetch: off })).rejects.toMatchObject({ code: 'WEATHER' });
    });

    it('typicalMonthScale compares daily means per local month and clamps to [0.5, 2]', () => {
        const start = Z('2025-09-30T23:00:00Z'), n = 17_520;
        const local = buildLocalIndex(start, n);
        // a flat 100 W/m² all year = 2.4 kWh/m²/day in every month
        const ghi = new Float32Array(n).fill(100);
        const f = typicalMonthScale(clim, ghi, local);
        for (let m = 0; m < 12; m++) {
            const want = Math.min(2, Math.max(0.5, clim.monthlyKwhM2[m] / clim.meanDim[m] / 2.4));
            expect(f[m]).toBeCloseTo(want, 9);
        }
        expect(f[0]).toBe(0.5);   // January is far darker than 2.4 kWh/m²/day
        expect(f[5]).toBe(2);     // June far brighter
        expect(f[2]).toBeCloseTo(clim.monthlyKwhM2[2] / 31 / 2.4, 9);
        const short = buildLocalIndex(Z('2026-06-01T00:00:00Z'), 96);
        const g = typicalMonthScale(clim, new Float32Array(96).fill(200), short);
        expect(Array.from(g).filter((v) => v !== 1).length).toBe(1);
        // without meanDim (e.g. a bundled climatology) February uses the 20-year mean 28.25 days
        const bare = { monthlyKwhM2: clim.monthlyKwhM2 };
        expect(typicalMonthScale(bare, ghi, local)).toEqual(f);
        expect(Array.from(typicalMonthScale(clim, new Float32Array(n).fill(NaN), local))).toEqual(new Array(12).fill(1));
    });

    it('typicalMonthScale({ year }) gives the per-year band factors GY/Gact on the same daily basis', () => {
        const start = Z('2025-09-30T23:00:00Z'), n = 17_520;
        const local = buildLocalIndex(start, n);
        const ghi = new Float32Array(n).fill(100); // 2.4 kWh/m²/day
        const yi = clim.years.indexOf(2012);
        const f = typicalMonthScale(clim, ghi, local, { year: 2012, min: 0, max: 100 });
        for (let m = 0; m < 12; m++) {
            const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m]; // 2012 is a leap year
            expect(f[m]).toBeCloseTo(clim.yearMonthlyKwhM2[yi * 12 + m] / dim / 2.4, 9);
        }
        // the band brackets the typical year: the mean of the 20 yearly factors is the typical factor
        // (up to February's 28/29-day weighting)
        const typ = typicalMonthScale(clim, ghi, local, { min: 0, max: 100 });
        const years = Array.from(clim.years).filter((y) => y >= 2006 && y <= 2025);
        for (const m of [0, 5, 9]) {
            const mean = years.reduce((s, y) => s + typicalMonthScale(clim, ghi, local, { year: y, min: 0, max: 100 })[m], 0) / years.length;
            expect(mean / typ[m]).toBeCloseTo(1, 9);
        }
        expect(() => typicalMonthScale(clim, ghi, local, { year: 1999 })).toThrow(RangeError);
    });
});
