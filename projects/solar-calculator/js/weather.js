/*
 * weather.js — Open-Meteo irradiance, temperature and wind aligned to settlement slots, plus the
 * 2006–2025 SARAH-3 climatology behind the "typical year".
 *
 * Source chain per slot [S, S+30) UTC (verified 2026-10-05, research VERIFY-irradiance.md):
 *   0 SARAH-3 (satellite, 30 min). Open-Meteo stores each scan's clearness index under label S
 *     as if it were the mean over (S−30, S], but the scan is taken ~11 min AFTER S. So slot
 *     [S, S+30) takes label S, rescaled from the (S−30, S] sun geometry to its own:
 *     ×mcz(S, S+30)/mcz(S−30, S) on GHI and DHI (DNI unchanged), factor clamped at 3. At sunrise
 *     (mcz(S−30, S) < 0.05) label S+30 is used unscaled; a slot with the sun down all the way
 *     gets zero. This one decision moves W90 yield by ~6.6%, so it is made here and nowhere else.
 *   1 LSA SAF MSG (satellite, 15 min, since 2025): mean of labels S+15 and S+30. Night DNI/DHI
 *     come back null (= 0 / GHI); daytime nulls are missing data (land mask, outages).
 *   2 ECMWF IFS archive (hourly, label H = floor_hour(S)+1h covers (H−1h, H]): split into the two
 *     half-hours keeping the clearness index, then ×0.93 on GHI/DHI because IFS reads ~7% high.
 *   4 all three missing: ≤ 6 daylight slots are interpolated in clearness index; longer gaps
 *     are an error rather than silently zero-filled (zero-filling cost 3% of a year's sunshine).
 * Temperature and wind are instantaneous hourly values, interpolated to the slot midpoint S+15.
 *
 * Every request names its model explicitly: the satellite API without models= silently returns
 * IFS model data with the same JSON shape. Satellite responses must sit on the 0.05° grid.
 */

import { SLOT_MS, DT_H, utcDate, daysInMonth } from './time.js';
import { meanCosZ, extraterrestrial, dayOfYear } from './sun.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const SAT_API = 'https://satellite-api.open-meteo.com/v1/archive';
const ARCHIVE_API = 'https://archive-api.open-meteo.com/v1/archive';
const RAD_VARS = 'shortwave_radiation,direct_normal_irradiance,diffuse_radiation';
const MSG_FIRST_DATE = '2025-01-01';

/** Open-Meteo model ids, one per request. */
export const MODELS = Object.freeze({ sarah3: 'eumetsat_sarah3', msg: 'eumetsat_lsa_saf_msg', archive: 'ecmwf_ifs' });
/** wxSource codes. */
export const WX = Object.freeze({ SARAH3: 0, MSG: 1, IFS: 2, DEMO: 3, INTERP: 4 });
/** IFS GHI/DHI read ~7% high against ground stations (KNMI 2026: +6.8 to +7.8%). */
export const IFS_SCALE = 0.93;
/** Longest run of daylight slots with no source that may be interpolated. */
export const MAX_INTERP_SLOTS = 6;

/**
 * Error with the shape of dataset.js's DataError (CONTRACTS §8). Defined here instead of imported
 * so weather.js stays usable on its own (dataset.js imports this module; importing back would be
 * a cycle). Callers should test `err.code`, not instanceof.
 */
export class WeatherDataError extends Error {
    /**
     * @param {'WEATHER'|'NETWORK'|'RATE_LIMIT'} code
     * @param {string} message
     * @param {{ step?: string, retryable?: boolean, action?: string, choices?: any }} [opts]
     */
    constructor(code, message, { step = 'weather', retryable = false, action, choices } = {}) {
        super(message);
        this.name = 'DataError';
        this.code = code;
        this.step = step;
        this.retryable = retryable;
        if (action) this.action = action;
        if (choices) this.choices = choices;
    }
}

/* ── URLs ── */

const fmtCoord = (v) => String(+(+v).toFixed(4));

function satUrl(model, lat, lon, startDate, endDate) {
    return `${SAT_API}?latitude=${fmtCoord(lat)}&longitude=${fmtCoord(lon)}&start_date=${startDate}&end_date=${endDate}` +
        `&hourly=${RAD_VARS}&models=${model}&temporal_resolution=native&timezone=GMT&timeformat=unixtime`;
}

function archiveUrl(lat, lon, startDate, endDate) {
    return `${ARCHIVE_API}?latitude=${fmtCoord(lat)}&longitude=${fmtCoord(lon)}&start_date=${startDate}&end_date=${endDate}` +
        `&hourly=${RAD_VARS},temperature_2m,wind_speed_10m&models=${MODELS.archive}&wind_speed_unit=ms&timezone=GMT&timeformat=unixtime`;
}

const addDays = (date, k) => utcDate(Date.parse(date + 'T00:00:00Z') + k * DAY_MS);

/**
 * Request URLs for a slot window. start_date is the UTC date of the first slot (a BST window that
 * starts at local midnight begins at 23:00Z the day before); end_date is the UTC date of the last
 * slot plus one day so its end-labelled values are included, capped at today UTC (later dates
 * are an HTTP 400).
 * @param {{ lat: number, lon: number, start: number, n: number, nowMs?: number }} p
 * @returns {{ sarah3: string, msg: string, archive: string, startDate: string, endDate: string }}
 */
export function buildUrls({ lat, lon, start, n, nowMs = Date.now() }) {
    const startDate = utcDate(start);
    const today = utcDate(nowMs);
    let endDate = utcDate(start + (n - 1) * SLOT_MS + DAY_MS);
    if (endDate > today) endDate = today;
    return {
        sarah3: satUrl(MODELS.sarah3, lat, lon, startDate, endDate),
        msg: satUrl(MODELS.msg, lat, lon, startDate < MSG_FIRST_DATE ? MSG_FIRST_DATE : startDate, endDate),
        archive: archiveUrl(lat, lon, startDate, endDate),
        startDate, endDate,
    };
}

/* ── response parsing ── */

/** True when a satellite response sits on the 0.05° grid (IFS cells such as 51.4938 do not). */
export function onSatelliteGrid(json) {
    const ok = (v) => typeof v === 'number' && Math.abs(v / 0.05 - Math.round(v / 0.05)) < 0.01;
    return ok(json?.latitude) && ok(json?.longitude);
}

/**
 * Label (UTC ms) → row for one or more Open-Meteo hourly responses. Accepts unixtime seconds or
 * GMT ISO strings. Later responses only fill labels the earlier ones left null.
 */
function indexByTime(list) {
    const out = new Map();
    for (const resp of list) {
        const h = resp?.hourly;
        if (!h || !Array.isArray(h.time)) continue;
        const off = (resp.utc_offset_seconds ?? 0) * 1000;
        const col = (name) => (Array.isArray(h[name]) ? h[name] : null);
        const G = col('shortwave_radiation'), N = col('direct_normal_irradiance'), D = col('diffuse_radiation');
        const T = col('temperature_2m'), W = col('wind_speed_10m');
        for (let i = 0; i < h.time.length; i++) {
            const t = h.time[i];
            // unixtime is UTC; ISO strings are wall time in the response's timezone
            const ms = typeof t === 'number' ? t * 1000 : Date.parse(t + ':00Z') - off;
            if (!Number.isFinite(ms)) continue;
            const row = {
                ghi: G?.[i] ?? null, dni: N?.[i] ?? null, dhi: D?.[i] ?? null,
                temp: T?.[i] ?? null, wind: W?.[i] ?? null,
            };
            const prev = out.get(ms);
            if (!prev) { out.set(ms, row); continue; }
            for (const k of Object.keys(row)) if (prev[k] == null && row[k] != null) prev[k] = row[k];
        }
    }
    return out;
}

/** mcz[k + 1] = mean max(cos true zenith, 0) over slot k, for k = −1 … n−1. */
function slotMeanCosZ(lat, lon, start, n) {
    const mcz = new Float64Array(n + 1);
    for (let k = -1; k < n; k++) mcz[k + 1] = meanCosZ(start + k * SLOT_MS, start + (k + 1) * SLOT_MS, lat, lon);
    return mcz;
}

/** The SARAH-3 label and rescale factor for slot k (the alignment rule in the header). */
function sarahPick(mcz, k, S) {
    const mn = mcz[k + 1], mp = mcz[k];
    if (mn <= 0) return [mp >= 0.05 ? S : S + SLOT_MS, 0];
    if (mp >= 0.05) return [S, Math.min(mn / mp, 3)];
    return [S + SLOT_MS, 1];
}

const validSarah = (a) => a && a.ghi != null && a.dhi != null && a.dni != null;

/** Keep only usable satellite responses; anything off the 0.05° grid is model data in disguise. */
function satList(json, name, notes) {
    if (!json) return [];
    const list = Array.isArray(json) ? json : [json];
    return list.filter((j) => {
        if (!j?.hourly) return false;
        if (onSatelliteGrid(j)) return true;
        notes.push(`${name} response is not on the 0.05° satellite grid (${j.latitude}, ${j.longitude}) and was ignored.`);
        return false;
    });
}

/**
 * @typedef {Object} WeatherSeries
 * @property {Float32Array} ghi    W/m², mean over each slot
 * @property {Float32Array} dni
 * @property {Float32Array} dhi
 * @property {Float32Array} tempC  °C at the slot midpoint
 * @property {Float32Array} windMs m/s at 10 m, slot midpoint
 * @property {Uint8Array} wxSource 0 SARAH-3, 1 MSG, 2 IFS×0.93, 3 demo, 4 interpolated
 * @property {{ counts: number[], sarahLastMs: number|null, ifsScaled: boolean, gridLat: number|null,
 *   gridLon: number|null, notes: string[], tempFilledSlots: number, tempDefaultSlots: number,
 *   interpDaylightSlots: number }} meta
 */

/**
 * Align parsed Open-Meteo responses to n slots from `start` (pure). `msg` may be one response or
 * an array of responses covering different date ranges.
 * @param {{ sarah3?: Object|null, msg?: Object|Object[]|null, archive?: Object|null }} sources
 * @param {number} lat
 * @param {number} lon
 * @param {number} start UTC ms of slot 0
 * @param {number} n
 * @returns {WeatherSeries}
 * @throws {WeatherDataError} code 'WEATHER' when more than MAX_INTERP_SLOTS daylight slots in a
 *   row have no source at all
 */
export function alignToSlots({ sarah3 = null, msg = null, archive = null } = {}, lat, lon, start, n) {
    const notes = [];
    const s3List = satList(sarah3, 'SARAH-3', notes);
    const msgList = satList(msg, 'MSG', notes);
    const arList = archive ? (Array.isArray(archive) ? archive : [archive]).filter((j) => j?.hourly) : [];
    const S3 = indexByTime(s3List), MS = indexByTime(msgList), AR = indexByTime(arList);
    const mcz = slotMeanCosZ(lat, lon, start, n);

    const ghi = new Float64Array(n).fill(NaN), dni = new Float64Array(n).fill(NaN), dhi = new Float64Array(n).fill(NaN);
    const src = new Uint8Array(n).fill(255);
    let ifsDaytime = false;
    for (let k = 0; k < n; k++) {
        const S = start + k * SLOT_MS, E = S + SLOT_MS;
        const mn = mcz[k + 1];
        const [X, fac] = sarahPick(mcz, k, S);
        const a = S3.get(X);
        if (validSarah(a)) {
            ghi[k] = a.ghi * fac; dhi[k] = a.dhi * fac; dni[k] = fac === 0 ? 0 : a.dni; src[k] = WX.SARAH3;
            continue;
        }
        const m1 = MS.get(S + 900_000), m2 = MS.get(E);
        if (m1 && m2 && m1.ghi != null && m2.ghi != null) {
            ghi[k] = (m1.ghi + m2.ghi) / 2;
            dni[k] = ((m1.dni ?? 0) + (m2.dni ?? 0)) / 2;
            dhi[k] = ((m1.dhi ?? m1.ghi) + (m2.dhi ?? m2.ghi)) / 2;
            src[k] = WX.MSG;
            continue;
        }
        const H = Math.floor(S / HOUR_MS) * HOUR_MS + HOUR_MS;
        const h = AR.get(H);
        if (h && h.ghi != null) {
            const mh = meanCosZ(H - HOUR_MS, H, lat, lon);
            const f = mh > 0 ? mn / mh : 0;
            ghi[k] = h.ghi * f * IFS_SCALE;
            dhi[k] = (h.dhi ?? h.ghi) * f * IFS_SCALE;
            dni[k] = f > 0 ? (h.dni ?? 0) : 0;
            src[k] = WX.IFS;
            if (mn > 0) ifsDaytime = true;
        }
    }

    const interpDaylight = fillRadiationGaps({ ghi, dni, dhi, src, mcz, start, n });

    const tempC = new Float64Array(n).fill(NaN), windMs = new Float64Array(n).fill(NaN);
    for (let k = 0; k < n; k++) {
        const M = start + k * SLOT_MS + 900_000;
        const h0 = Math.floor(M / HOUR_MS) * HOUR_MS;
        const w = (M - h0) / HOUR_MS;
        const t0 = AR.get(h0), t1 = AR.get(h0 + HOUR_MS);
        if (t0 && t1 && t0.temp != null && t1.temp != null) tempC[k] = t0.temp + (t1.temp - t0.temp) * w;
        if (t0 && t1 && t0.wind != null && t1.wind != null) windMs[k] = t0.wind + (t1.wind - t0.wind) * w;
    }
    const tf = fillNearest(tempC, 6, 10);
    const wf = fillNearest(windMs, 6, 2);
    if (tf.filled || wf.filled) notes.push(`Temperature/wind missing for ${Math.max(tf.filled, wf.filled)} half-hours; nearest value within 3 h used.`);
    if (tf.defaulted || wf.defaulted) notes.push(`Temperature/wind unavailable for ${Math.max(tf.defaulted, wf.defaulted)} half-hours; assumed 10 °C and 2 m/s.`);

    const counts = [0, 0, 0, 0, 0];
    for (let k = 0; k < n; k++) counts[src[k]]++;
    if (counts[WX.MSG]) notes.push(`${counts[WX.MSG]} half-hours use LSA SAF MSG where SARAH-3 had no data.`);
    if (counts[WX.IFS]) notes.push(`${counts[WX.IFS]} half-hours use ECMWF IFS model radiation (×${IFS_SCALE}).`);
    // night slots with no source also carry code 4 but are dark by geometry, not guessed
    if (interpDaylight) notes.push(`${interpDaylight} daylight half-hours had no weather source and were interpolated.`);
    let sarahLastMs = null;
    for (const [ms, row] of S3) if (row.ghi != null && (sarahLastMs === null || ms > sarahLastMs)) sarahLastMs = ms;
    const cell = s3List[0] ?? msgList[0] ?? arList[0] ?? null;
    return {
        ghi: Float32Array.from(ghi), dni: Float32Array.from(dni), dhi: Float32Array.from(dhi),
        tempC: Float32Array.from(tempC), windMs: Float32Array.from(windMs), wxSource: src,
        meta: {
            counts, sarahLastMs, ifsScaled: ifsDaytime,
            gridLat: cell ? cell.latitude : null, gridLon: cell ? cell.longitude : null, notes,
            tempFilledSlots: Math.max(tf.filled, wf.filled), tempDefaultSlots: Math.max(tf.defaulted, wf.defaulted),
            interpDaylightSlots: interpDaylight,
        },
    };
}

/**
 * Fill slots no source covered. Night slots are zero by geometry. A run with ≤ 6 daylight slots
 * is interpolated linearly in clearness index kt = GHI/(ETR·mcz) between the nearest daylight
 * slots that have data, taking the diffuse fraction from the nearer one (DNI = 0, the beam is
 * unknown); a longer run throws, because inventing hours of sunshine would bias the answer.
 * Returns the number of daylight slots interpolated.
 */
function fillRadiationGaps({ ghi, dni, dhi, src, mcz, start, n }) {
    let interpolated = 0;
    const etr = (k) => extraterrestrial(dayOfYear(start + k * SLOT_MS + 900_000));
    const ktAt = (k) => {
        const m = mcz[k + 1];
        return m > 0.02 ? Math.min(Math.max(ghi[k] / (etr(k) * m), 0), 1.1) : NaN;
    };
    let k = 0;
    while (k < n) {
        if (src[k] !== 255) { k++; continue; }
        let b = k;
        while (b + 1 < n && src[b + 1] === 255) b++;
        let daylight = 0;
        for (let u = k; u <= b; u++) if (mcz[u + 1] > 0) daylight++;
        if (daylight > MAX_INTERP_SLOTS) {
            const when = new Date(start + k * SLOT_MS).toISOString().slice(0, 16).replace('T', ' ');
            throw new WeatherDataError('WEATHER',
                `No weather data for ${daylight} daylight half-hours from ${when} UTC (satellite and model both missing). ` +
                'Open-Meteo may still be filling in recent days — try again later or end the period earlier.',
                { retryable: true, action: 'retry' });
        }
        // nearest daylight neighbours with data, searching up to 12 slots beyond the run
        let L = -1, R = -1;
        for (let u = k - 1; u >= Math.max(0, k - 12); u--) if (src[u] !== 255 && Number.isFinite(ktAt(u))) { L = u; break; }
        for (let u = b + 1; u <= Math.min(n - 1, b + 12); u++) if (src[u] !== 255 && Number.isFinite(ktAt(u))) { R = u; break; }
        const kdOf = (u) => (ghi[u] > 0 ? Math.min(Math.max(dhi[u] / ghi[u], 0), 1) : 1);
        for (let u = k; u <= b; u++) {
            src[u] = WX.INTERP;
            dni[u] = 0;
            const m = mcz[u + 1];
            if (!(m > 0)) { ghi[u] = 0; dhi[u] = 0; continue; }
            interpolated++;
            let kt, kd;
            if (L >= 0 && R >= 0) {
                kt = ktAt(L) + ((ktAt(R) - ktAt(L)) * (u - L)) / (R - L);
                kd = u - L <= R - u ? kdOf(L) : kdOf(R);
            } else if (L >= 0 || R >= 0) {
                const q = L >= 0 ? L : R;
                kt = ktAt(q); kd = kdOf(q);
            } else {
                kt = 0.45; kd = 0.6; // UK mean clearness/diffuse share, only for an isolated sliver of daylight
            }
            ghi[u] = kt * etr(u) * m;
            dhi[u] = kd * ghi[u];
        }
        k = b + 1;
    }
    return interpolated;
}

/** Replace NaN by the nearest finite value within `maxSlots` (earlier wins ties), else `dflt`. */
function fillNearest(arr, maxSlots, dflt) {
    const n = arr.length;
    const orig = Float64Array.from(arr);
    let filled = 0, defaulted = 0;
    for (let k = 0; k < n; k++) {
        if (Number.isFinite(orig[k])) continue;
        let v = NaN;
        for (let d = 1; d <= maxSlots; d++) {
            if (k - d >= 0 && Number.isFinite(orig[k - d])) { v = orig[k - d]; break; }
            if (k + d < n && Number.isFinite(orig[k + d])) { v = orig[k + d]; break; }
        }
        if (Number.isFinite(v)) { arr[k] = v; filled++; } else { arr[k] = dflt; defaulted++; }
    }
    return { filled, defaulted };
}

/* ── fetching ── */

/** Attempts per Open-Meteo request for passing trouble (network, 5xx, a 200 that isn't JSON). */
export const FETCH_ATTEMPTS = 3;
/** Waits before the 2nd and 3rd attempt (ms). A 429 is retried once after Retry-After or 5 s. */
const BACKOFF_MS = [1_000, 3_000];
const RATE_LIMIT_WAIT_MS = 5_000;

const abortError = (signal) => signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });

/** setTimeout that rejects with the abort reason as soon as `signal` fires. */
function defaultSleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError(signal)); return; }
        const onAbort = () => { clearTimeout(t); reject(abortError(signal)); };
        const t = setTimeout(() => { signal?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

/** What a URL asks Open-Meteo for, in words an error box can show. */
function describeUrl(url) {
    const u = String(url);
    if (u.startsWith(ARCHIVE_API)) return 'Open-Meteo’s temperature archive (ECMWF IFS)';
    if (u.includes('daily=')) return 'Open-Meteo’s 20-year sunshine record (SARAH-3)';
    if (u.includes(`models=${MODELS.msg}`)) return 'Open-Meteo’s satellite sunshine (MSG)';
    return 'Open-Meteo’s satellite sunshine (SARAH-3)';
}

function retryAfterMs(res) {
    const v = res?.headers?.get?.('retry-after');
    if (!v) return null;
    const s = Number(v);
    return Number.isFinite(s) && s >= 0 ? Math.min(30_000, s * 1000) : null;
}

/**
 * One attempt at one Open-Meteo URL. An HTTP 200 whose body is not JSON (e.g. "Unexpected error
 * while streaming data: …") is an error, as is any `{ error: true }` body. Messages never carry
 * the raw body (an HTML error page means nothing to a user), only Open-Meteo's own `reason`.
 * `transient` marks a failure worth another attempt.
 */
async function fetchJsonOnce(url, fetchFn, signal) {
    const what = describeUrl(url);
    const fail = (code, message, { retryable, transient = false, ...extra }) =>
        Object.assign(new WeatherDataError(code, message, { retryable, action: 'retry' }), { transient, ...extra });
    let res;
    try {
        res = await fetchFn(url, signal ? { signal } : undefined);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;
        throw fail('NETWORK', `Couldn't reach ${what} (${e?.message ?? e}). Check your connection and retry.`, { retryable: true, transient: true, brief: 'no connection' });
    }
    let text;
    try {
        text = await res.text();
    } catch (e) {
        // the body can fail mid-stream (connection dropped); that is a network error, not a bug
        if (e?.name === 'AbortError') throw e;
        throw fail('NETWORK', `Lost the connection to ${what} (${e?.message ?? e}). Retry in a moment.`, { retryable: true, transient: true, brief: 'connection dropped' });
    }
    if (res.status === 429) {
        throw fail('RATE_LIMIT', `${what} is limiting how often it can be asked. Wait a minute and retry.`, { retryable: true, rateLimited: true, waitMs: retryAfterMs(res), brief: 'rate limited' });
    }
    let j;
    try { j = JSON.parse(text); } catch {
        // 200 + text ("Unexpected error while streaming data…") and 5xx pages are passing server
        // trouble, worth a retry; a 4xx HTML page is not. Neither means "not published yet"
        // (code WEATHER), which the dataset answers by ending the period earlier.
        const transient = res.status < 400 || res.status >= 500;
        throw transient
            ? fail('NETWORK', `${what} is having problems (${res.status >= 500 ? `HTTP ${res.status}` : 'an unreadable reply'}). Retry in a few minutes.`, { retryable: true, transient: true, brief: res.status >= 500 ? `HTTP ${res.status}` : 'unreadable reply' })
            : fail('WEATHER', `${what} returned an unreadable response (HTTP ${res.status}).`, { retryable: false, brief: `HTTP ${res.status}` });
    }
    if (!res.ok || j?.error) {
        const reason = typeof j?.reason === 'string' && j.reason.length <= 300 ? j.reason : null;
        throw res.status >= 500
            ? fail('NETWORK', `${what} is having problems (HTTP ${res.status}${reason ? `: ${reason}` : ''}). Retry in a few minutes.`, { retryable: true, transient: true, brief: `HTTP ${res.status}` })
            : fail('WEATHER', `Open-Meteo error (HTTP ${res.status})${reason ? `: ${reason}` : ''}.`, { retryable: false, brief: `HTTP ${res.status}${reason ? `: ${reason}` : ''}` });
    }
    return j;
}

/**
 * Fetch and parse one Open-Meteo URL, riding out passing trouble the way the Octopus client
 * does: network errors, 5xx and a 200 that isn't JSON get FETCH_ATTEMPTS tries with backoff, and
 * a 429 one more try after a pause. Without this one 502 failed the whole load, or — on the
 * SARAH-3 request — silently swapped the year's sunshine to MSG/IFS. Aborts propagate at once.
 */
async function fetchJson(url, fetchFn, signal, sleep = defaultSleep) {
    let rateRetried = false;
    for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw abortError(signal);
        try {
            return await fetchJsonOnce(url, fetchFn, signal);
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            if (e?.rateLimited && !rateRetried) {
                rateRetried = true;
                await sleep(e.waitMs ?? RATE_LIMIT_WAIT_MS, signal);
                continue;
            }
            if (e?.transient && attempt < FETCH_ATTEMPTS) {
                await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)], signal);
                continue;
            }
            throw e;
        }
    }
}

/**
 * Fetch through the optional cache. Past weather is immutable except the last few days
 * (SARAH-3 backfills ~3 days late, IFS forecast hours get replaced), so responses reaching into
 * the last 5 days are only reused for 6 hours. If the refresh then fails on the network, the
 * stale copy is still better than nothing: its missing tail is filled from MSG/IFS or reported
 * by alignToSlots like any other gap.
 */
async function cachedJson(url, endDate, { fetchFn, cache, signal, nowMs, sleep }) {
    const recent = endDate >= utcDate(nowMs - 5 * DAY_MS);
    let stale = null;
    if (cache) {
        try {
            const hit = await cache.get(url);
            if (hit && hit.json) {
                if (!recent || nowMs - (hit.savedAtMs ?? 0) < 6 * HOUR_MS) return hit.json;
                stale = hit.json;
            }
        } catch { /* a broken cache is just a miss */ }
    }
    let json;
    try {
        json = await fetchJson(url, fetchFn, signal, sleep);
    } catch (e) {
        if (stale && (e?.code === 'NETWORK' || e?.code === 'RATE_LIMIT')) return stale;
        throw e;
    }
    if (cache) {
        try { await cache.set(url, { savedAtMs: nowMs, json }); } catch { /* best effort */ }
    }
    return json;
}

/** UTC dates whose slots lack a usable SARAH-3 label, grouped into a few [from, to] ranges. */
function msgRanges(sarah3, lat, lon, start, n, endDate) {
    const S3 = indexByTime(sarah3 ? [sarah3] : []);
    const mcz = slotMeanCosZ(lat, lon, start, n);
    const dates = [];
    let last = '';
    for (let k = 0; k < n; k++) {
        const S = start + k * SLOT_MS;
        const [X] = sarahPick(mcz, k, S);
        if (validSarah(S3.get(X))) continue;
        const d = utcDate(S);
        if (d !== last && d >= MSG_FIRST_DATE) { dates.push(d); last = d; }
    }
    if (!dates.length) return [];
    // MSG's last label of a slot is S+30, so each range runs to the next day; merge ranges
    // separated by under a week, and fall back to one range if the gaps are scattered widely
    let ranges = [];
    for (const d of dates) {
        const to = addDays(d, 1) > endDate ? endDate : addDays(d, 1);
        const r = ranges[ranges.length - 1];
        if (r && addDays(r[1], 7) >= d) r[1] = to > r[1] ? to : r[1];
        else ranges.push([d, to]);
    }
    if (ranges.length > 6) ranges = [[ranges[0][0], ranges[ranges.length - 1][1]]];
    return ranges;
}

/**
 * Fetch SARAH-3 + IFS archive, then MSG only for the days SARAH-3 is missing, and align them.
 * @param {{ lat: number, lon: number, start: number, n: number, fetch?: Function,
 *   cache?: { get(key: string): Promise<any>, set(key: string, value: any): Promise<any> }|null,
 *   onProgress?: Function|null, signal?: AbortSignal|null, nowMs?: number,
 *   sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }} p  sleep: the wait between retries (tests pass a no-op)
 * @returns {Promise<WeatherSeries>}
 */
export async function fetchWeather({ lat, lon, start, n, fetch: fetchFn = globalThis.fetch, cache = null, onProgress = null, signal = null, nowMs = Date.now(), sleep = defaultSleep }) {
    const progress = (status, detail, pct) => { try { onProgress?.({ step: 'weather', status, detail, pct }); } catch { /* UI only */ } };
    const urls = buildUrls({ lat, lon, start, n, nowMs });
    if (urls.startDate > urls.endDate) throw new WeatherDataError('WEATHER', 'The requested period starts in the future.', { action: 'retry' });
    const opts = { fetchFn, cache, signal, nowMs, sleep };
    progress('start', 'Satellite sunshine (SARAH-3) and temperature (ECMWF IFS)', 0);
    const [s3, ar] = await Promise.allSettled([
        cachedJson(urls.sarah3, urls.endDate, opts),
        cachedJson(urls.archive, urls.endDate, opts),
    ]);
    if (ar.status === 'rejected') { progress('error', ar.reason?.message); throw ar.reason; }
    const notes = [];
    let sarah3 = null;
    if (s3.status === 'fulfilled') sarah3 = s3.value;
    else {
        if (s3.reason?.name === 'AbortError') throw s3.reason;
        notes.push(`SARAH-3 unavailable (${s3.reason?.brief ?? s3.reason?.message ?? s3.reason}); using MSG/IFS instead.`);
    }
    progress('start', 'Filling satellite gaps (MSG)', 60);
    const ranges = msgRanges(sarah3 && onSatelliteGrid(sarah3) ? sarah3 : null, lat, lon, start, n, urls.endDate);
    const msg = [];
    for (const [from, to] of ranges) {
        try {
            msg.push(await cachedJson(satUrl(MODELS.msg, lat, lon, from, to), to, opts));
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            notes.push(`MSG unavailable for ${from}..${to} (${e?.brief ?? e?.message ?? e}).`);
        }
    }
    const series = alignToSlots({ sarah3, msg, archive: ar.value }, lat, lon, start, n);
    series.meta.notes.unshift(...notes);
    progress('done', `${series.meta.counts[0]} of ${n} half-hours from SARAH-3`, 100);
    return series;
}

/* ── climatology ── */

/**
 * @typedef {Object} Climatology
 * @property {Float64Array} monthlyKwhM2      12, mean of the fromYear..toYear monthly GHI sums
 * @property {Int16Array} years                complete years present in the response
 * @property {Float64Array} yearMonthlyKwhM2   years.length × 12
 * @property {Float64Array} meanDim            mean days per month over fromYear..toYear (Feb 28.25)
 * @property {number|null} gridLat
 * @property {number|null} gridLon
 * @property {number} fromYear
 * @property {number} toYear
 */

/**
 * Monthly GHI climatology from an Open-Meteo daily shortwave_radiation_sum response (MJ/m²/day).
 * A null day is filled with the mean of the available days of that month-year — summing nulls as
 * zero understated 2008/2009 by up to 4%. Years with a month of no data at all are dropped.
 * @param {Object} json
 * @param {{ fromYear?: number, toYear?: number }} [opts]
 * @returns {Climatology}
 */
export function climatologyFromDaily(json, { fromYear = 2006, toYear = 2025 } = {}) {
    const d = json?.daily;
    const vals = d?.shortwave_radiation_sum;
    if (!d || !Array.isArray(d.time) || !Array.isArray(vals)) {
        throw new WeatherDataError('WEATHER', 'The sunshine climatology response has no daily data.', { retryable: true, action: 'retry' });
    }
    const off = (json.utc_offset_seconds ?? 0) * 1000;
    const acc = new Map(); // year*12 + month0 → [sum, count, seen]
    for (let i = 0; i < d.time.length; i++) {
        const t = d.time[i];
        const date = typeof t === 'number' ? utcDate(t * 1000 + off) : String(t).slice(0, 10);
        const y = +date.slice(0, 4), m0 = +date.slice(5, 7) - 1;
        if (!Number.isFinite(y) || !(m0 >= 0 && m0 < 12)) continue;
        const key = y * 12 + m0;
        let a = acc.get(key);
        if (!a) { a = [0, 0]; acc.set(key, a); }
        const v = vals[i];
        if (typeof v === 'number' && Number.isFinite(v)) { a[0] += v; a[1]++; }
    }
    const allYears = [...new Set([...acc.keys()].map((k) => Math.floor(k / 12)))].sort((a, b) => a - b);
    const years = allYears.filter((y) => {
        for (let m0 = 0; m0 < 12; m0++) if (!(acc.get(y * 12 + m0)?.[1] > 0)) return false;
        return true;
    });
    if (!years.length) throw new WeatherDataError('WEATHER', 'The sunshine climatology has no complete year.', { retryable: true, action: 'retry' });
    const yearMonthlyKwhM2 = new Float64Array(years.length * 12);
    years.forEach((y, yi) => {
        for (let m0 = 0; m0 < 12; m0++) {
            const [sum, cnt] = acc.get(y * 12 + m0);
            yearMonthlyKwhM2[yi * 12 + m0] = ((sum / cnt) * daysInMonth(y, m0 + 1)) / 3.6; // MJ → kWh
        }
    });
    let inRange = years.map((y, yi) => [y, yi]).filter(([y]) => y >= fromYear && y <= toYear);
    if (!inRange.length) inRange = years.map((y, yi) => [y, yi]);
    const monthlyKwhM2 = new Float64Array(12), meanDim = new Float64Array(12);
    for (let m0 = 0; m0 < 12; m0++) {
        let s = 0, dim = 0;
        for (const [y, yi] of inRange) { s += yearMonthlyKwhM2[yi * 12 + m0]; dim += daysInMonth(y, m0 + 1); }
        monthlyKwhM2[m0] = s / inRange.length;
        meanDim[m0] = dim / inRange.length;
    }
    return {
        monthlyKwhM2, years: Int16Array.from(years), yearMonthlyKwhM2, meanDim,
        gridLat: typeof json.latitude === 'number' ? json.latitude : null,
        gridLon: typeof json.longitude === 'number' ? json.longitude : null,
        fromYear: inRange[0][0], toYear: inRange[inRange.length - 1][0],
    };
}

/**
 * URL of the 2006–2025 daily SARAH-3 sums for a location (~55 weighted Open-Meteo calls, cached
 * forever since the past does not change).
 * @param {{ lat: number, lon: number, fromYear?: number, toYear?: number }} p
 * @returns {string}
 */
export function climatologyUrl({ lat, lon, fromYear = 2006, toYear = 2025 }) {
    return `${SAT_API}?latitude=${fmtCoord(lat)}&longitude=${fmtCoord(lon)}&start_date=${fromYear}-01-01&end_date=${toYear}-12-31` +
        `&daily=shortwave_radiation_sum&models=${MODELS.sarah3}&timezone=GMT&timeformat=unixtime`;
}

/**
 * Fetch and reduce the SARAH-3 daily climatology.
 * @param {{ lat: number, lon: number, fetch?: Function, cache?: Object|null, signal?: AbortSignal|null, sleep?: Function }} p
 * @returns {Promise<Climatology>}
 */
export async function fetchClimatology({ lat, lon, fetch: fetchFn = globalThis.fetch, cache = null, signal = null, sleep = defaultSleep }) {
    const url = climatologyUrl({ lat, lon });
    const json = await cachedJson(url, '2025-12-31', { fetchFn, cache, signal, nowMs: Date.now(), sleep });
    if (!onSatelliteGrid(json)) {
        throw new WeatherDataError('WEATHER', `The climatology came back off the satellite grid (${json.latitude}, ${json.longitude}).`, { retryable: true, action: 'retry' });
    }
    return climatologyFromDaily(json);
}

/**
 * Typical-year irradiance factors per local month: (climatological daily GHI) / (the dataset's
 * daily GHI in that month), clamped. Using daily means handles partially covered months; months
 * with under a day of data keep factor 1.
 *
 * With `year`, the numerator is that single year's daily GHI instead of the 2006–2025 mean — the
 * per-year factors GY/Gact behind the weather band (applied to cached actual-weather DC with
 * pv.js scaleDcByMonth). Both use the same daily normalisation, so the band brackets the
 * typical-year figure consistently.
 * @param {Climatology} climatology
 * @param {ArrayLike<number>} ghi slot-mean W/m²
 * @param {{ month: Uint8Array }} local LocalIndex (time.js)
 * @param {{ min?: number, max?: number, year?: number|null }} [opts]
 * @returns {Float64Array} 12 factors by local month0
 * @throws {RangeError} when `year` is not one of climatology.years
 */
export function typicalMonthScale(climatology, ghi, local, { min = 0.5, max = 2, year = null } = {}) {
    let yi = -1;
    if (year != null) {
        yi = Array.prototype.indexOf.call(climatology.years ?? [], year);
        if (yi < 0) throw new RangeError(`typicalMonthScale: ${year} is not in the climatology`);
    }
    const sums = new Float64Array(12), slots = new Float64Array(12);
    for (let t = 0; t < ghi.length; t++) {
        const g = ghi[t];
        if (!Number.isFinite(g)) continue;
        sums[local.month[t]] += (g * DT_H) / 1000;
        slots[local.month[t]]++;
    }
    const out = new Float64Array(12).fill(1);
    // a climatology from elsewhere (e.g. bundled demo data) may lack meanDim: use the 20-year mean
    const dim = (m0) => climatology.meanDim?.[m0] ?? (m0 === 1 ? 28.25 : daysInMonth(2025, m0 + 1));
    for (let m0 = 0; m0 < 12; m0++) {
        const covered = slots[m0] / 48;
        if (covered < 1 || !(sums[m0] > 0)) continue;
        const ref = yi < 0
            ? climatology.monthlyKwhM2[m0] / dim(m0)
            : climatology.yearMonthlyKwhM2[yi * 12 + m0] / daysInMonth(year, m0 + 1);
        if (!(ref >= 0)) continue;
        const actual = sums[m0] / covered;
        out[m0] = Math.min(max, Math.max(min, ref / actual));
    }
    return out;
}
