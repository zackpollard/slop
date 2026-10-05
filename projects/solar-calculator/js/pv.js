/*
 * pv.js — plane-of-array irradiance, cell temperature, DC power and the micro-inverter, run on
 * half-hour slots split into sub-samples.
 *
 * A faithful port of the verified research reference (pv-reference-verified.js, every formula
 * matched to pvlib 0.16.1 within 1e-11 W/m²), reorganised for speed:
 *   prepareGeometry  sun position, airmass, ETR and clear-sky weights — weather-independent, so
 *                    one per dataset and sub-step count
 *   prepareSky       the clear-sky-index split of each slot's GHI/DHI into sub-samples, Perez
 *                    F1/F2 and temperature/wind — orientation-independent
 *   arrayDcW         POA → IAM → shading → bifacial → Faiman → PVWatts/Huld → DC losses
 *   inverterAc       per-input caps → PVWatts efficiency → AC cap per sub-sample → slot energy
 *
 * Conventions: weather slot values are means over [S, S+30) exactly as weather.js aligned them
 * (the SARAH-3 label decision lives there, never here). Azimuths are compass (0 = N, cw) for both
 * the sun and the panel, matching pvlib, so app array azimuths are used directly.
 */

import { SLOT_MS, DT_H, buildLocalIndex } from './time.js';
import { sunPosition, dayOfYear, extraterrestrial, airmassKastenYoung, clearSkyIneichen, linkeFor } from './sun.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const COS85 = Math.cos(85 * D2R);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
// numeric strings (form fields, URL params) count as numbers, like system.js; anything else
// non-finite falls back to the default instead of propagating NaN into the physics
const num = (v, dflt) => {
    const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof x === 'number' && Number.isFinite(x) ? x : dflt;
};

/** DC loss stack in % (multiplicative). Shading is NOT in here — it is a per-array input. */
export const DEFAULT_LOSSES = Object.freeze({ soiling: 2, mismatch: 1, wiring: 1, lid: 1, availability: 1 });

/**
 * Faiman U0 [W/m²K], U1 [W/m³sK] by mounting, for 10 m wind. open/roof are PVGIS's c-Si
 * free-standing and building-integrated values; railing/wall are inferred in-betweens for
 * open-backed balcony rails and panels flush on a wall.
 */
export const FAIMAN = Object.freeze({
    open: Object.freeze([26.9, 6.2]),
    roof: Object.freeze([20, 3.2]),
    railing: Object.freeze([24, 5]),
    wall: Object.freeze([21, 3.5]),
});

/** Huld et al. (2011) "CSi current" coefficients k1..k6 (PVGIS), for PVGIS-clone validation. */
export const HULD_CSI = Object.freeze([-0.017237, -0.040465, -0.004702, 0.000149, 0.000170, 0.000005]);
/** PVGIS "CSI 2025" (Chatzipanagi et al. 2025, pvtechchoice=crystSi2025): a modern TOPCon-like module. */
export const HULD_CSI_2025 = Object.freeze([-0.006756, -0.016444, -0.003015, -0.000045, -0.000043, 0.0]);

/* ── scalar physics (exported for tests and for one-off use) ── */

/**
 * Multiplicative DC loss factor from a {name: percent} map (every numeric entry counts). Each
 * percentage is clamped to 0–100: a loss outside that range is a typo, and letting it through
 * would turn DC negative (or above the panels' output) downstream.
 * @param {Record<string, number>} [losses]
 * @returns {number} e.g. 0.94138 for DEFAULT_LOSSES; always within [0, 1]
 */
export function lossFactor(losses = DEFAULT_LOSSES) {
    let f = 1;
    for (const v of Object.values(losses ?? {})) if (typeof v === 'number' && Number.isFinite(v)) f *= 1 - clamp(v, 0, 100) / 100;
    return f;
}

// Perez 1990 'allsitescomposite1990' [f11, f12, f13, f21, f22, f23] per sky-clearness bin,
// with pvlib's bin edges: bin k covers edges[k-1] <= eps < edges[k].
const PEREZ_EDGES = [1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2];
const PEREZ_1990 = [
    [-0.0080, 0.5880, -0.0620, -0.0600, 0.0720, -0.0220],
    [0.1300, 0.6830, -0.1510, -0.0190, 0.0660, -0.0290],
    [0.3300, 0.4870, -0.2210, 0.0550, -0.0640, -0.0260],
    [0.5680, 0.1870, -0.2950, 0.1090, -0.1520, -0.0140],
    [0.8730, -0.3920, -0.3620, 0.2260, -0.4620, 0.0010],
    [1.1320, -1.2370, -0.4120, 0.2880, -0.8230, 0.0560],
    [1.0600, -1.6000, -0.3590, 0.2640, -1.1270, 0.1310],
    [0.6780, -0.3270, -0.2500, 0.1560, -1.3770, 0.2510],
];

/**
 * Perez brightening coefficients into out[0] = F1, out[1] = F2. Zero when there is no diffuse or
 * the sun is down, which makes the Perez formula collapse to the isotropic sky — the reference's
 * twilight fallback.
 */
function perezInto(out, dhi, dni, zenithDeg, airmass, dniExtra) {
    if (!(dhi > 0) || !(zenithDeg < 90) || !(airmass > 0)) { out[0] = 0; out[1] = 0; return; }
    const z = zenithDeg * D2R;
    const kz3 = 1.041 * z ** 3;
    const eps = ((dhi + dni) / dhi + kz3) / (1 + kz3);
    const delta = (dhi * airmass) / dniExtra;
    let bin = 0;
    while (bin < 7 && eps >= PEREZ_EDGES[bin]) bin++;
    const c = PEREZ_1990[bin];
    out[0] = Math.max(0, c[0] + c[1] * delta + c[2] * z);
    out[1] = c[3] + c[4] * delta + c[5] * z;
}

/**
 * Perez F1/F2 for one instant.
 * @param {number} dhi W/m²
 * @param {number} dni W/m²
 * @param {number} zenithDeg apparent zenith
 * @param {number} airmass relative (Kasten–Young)
 * @param {number} dniExtra W/m²
 * @returns {{ F1: number, F2: number }}
 */
export function perezCoefficients(dhi, dni, zenithDeg, airmass, dniExtra) {
    const o = [0, 0];
    perezInto(o, dhi, dni, zenithDeg, airmass, dniExtra);
    return { F1: o[0], F2: o[1] };
}

/** cos(angle of incidence) on a plane; negative when the sun is behind it. */
function cosAoi(tilt, surfaceAzimuth, zenith, azimuth) {
    return clamp(Math.cos(zenith * D2R) * Math.cos(tilt * D2R) +
        Math.sin(zenith * D2R) * Math.sin(tilt * D2R) * Math.cos((azimuth - surfaceAzimuth) * D2R), -1, 1);
}

/**
 * Plane-of-array irradiance for one instant (scalar mirror of the reference poaIrradiance).
 * @param {{ ghi: number, dni: number, dhi: number, zenith: number, azimuth: number, tilt: number,
 *   surfaceAzimuth: number, albedo?: number, dniExtra?: number, dayOfYear?: number,
 *   model?: 'perez'|'haydavies'|'isotropic', airmass?: number, groundSelfShade?: boolean }} p
 *   zenith is the APPARENT zenith; azimuths are compass degrees
 * @returns {{ poaGlobal: number, poaBeam: number, poaSky: number, poaGround: number,
 *   circumsolar: number, isotropic: number, horizon: number, cosInc: number, aoi: number }}
 */
export function poaIrradiance(p) {
    const { ghi, dhi, zenith, azimuth, tilt, surfaceAzimuth } = p;
    const albedo = p.albedo ?? 0.2;
    const model = p.model ?? 'perez';
    const dniExtra = p.dniExtra ?? extraterrestrial(p.dayOfYear);
    const sunUp = zenith < 90;
    const dni = sunUp ? Math.max(p.dni, 0) : 0;
    const cosInc = cosAoi(tilt, surfaceAzimuth, zenith, azimuth);
    const ct = Math.cos(tilt * D2R);
    const poaBeam = sunUp ? dni * Math.max(cosInc, 0) : 0;
    let iso = 0, cs = 0, hor = 0;
    if (dhi > 0) {
        if (model === 'perez') {
            const am = p.airmass ?? airmassKastenYoung(zenith);
            const o = [0, 0];
            perezInto(o, dhi, dni, zenith, Number.isFinite(am) ? am : 0, dniExtra);
            iso = dhi * (1 - o[0]) * (1 + ct) / 2;
            cs = (dhi * o[0] * Math.max(0, cosInc)) / Math.max(COS85, Math.cos(zenith * D2R));
            hor = dhi * o[1] * Math.sin(tilt * D2R);
            if (!(iso + cs + hor > 0)) iso = cs = hor = 0;
        } else if (model === 'haydavies') {
            const AI = clamp(dni / dniExtra, 0, 1);
            const Rb = Math.max(cosInc, 0) / Math.max(Math.cos(zenith * D2R), 0.01745);
            iso = Math.max(dhi * (1 - AI) * (1 + ct) / 2, 0);
            cs = Math.max(dhi * AI * Rb, 0);
        } else {
            iso = dhi * (1 + ct) / 2;
        }
    }
    const poaSky = Math.max(0, iso + cs + hor);
    // groundSelfShade: with the sun behind a wall/railing plane, the ground in front of it is in
    // the building's shadow, so only diffuse is reflected (what PVGIS does; verified).
    const ghiForGround = p.groundSelfShade && cosInc <= 0 ? Math.max(dhi, 0) : Math.max(ghi, 0);
    const poaGround = ghiForGround * albedo * (1 - ct) / 2;
    return {
        poaGlobal: poaBeam + poaSky + poaGround, poaBeam, poaSky, poaGround,
        circumsolar: cs, isotropic: iso, horizon: hor, cosInc, aoi: Math.acos(cosInc) * R2D,
    };
}

/**
 * Martin & Ruiz beam incidence-angle modifier.
 * @param {number} aoiDeg
 * @param {number} [ar=0.16]
 * @returns {number}
 */
export function iamMartinRuiz(aoiDeg, ar = 0.16) {
    if (!(Math.abs(aoiDeg) < 90)) return 0;
    return (1 - Math.exp(-Math.cos(aoiDeg * D2R) / ar)) / (1 - Math.exp(-1 / ar));
}

/**
 * Martin & Ruiz diffuse IAMs for sky and ground (IEC 61853-3 / pvlib: c1 = 4/(3π), c2 = 0.5·ar − 0.154).
 * @param {number} tiltDeg
 * @param {number} [ar=0.16]
 * @returns {{ sky: number, ground: number }}
 */
export function iamMartinRuizDiffuse(tiltDeg, ar = 0.16) {
    const c1 = 0.4244, c2 = 0.5 * ar - 0.154;
    const t = tiltDeg === 0 ? 1e-6 : tiltDeg === 180 ? 180 - 1e-6 : tiltDeg;
    const b = t * D2R;
    const sb = t < 90 ? Math.sin(b) : Math.sin(Math.PI - b);
    const xs = sb + (Math.PI - b - sb) / (1 + Math.cos(b));
    const xg = sb + (b - sb) / (1 - Math.cos(b));
    return {
        sky: 1 - Math.exp(-((c1 + c2 * xs) * xs) / ar),
        ground: 1 - Math.exp(-((c1 + c2 * xg) * xg) / ar),
    };
}

/**
 * Faiman module temperature.
 * @param {number} poaGlobal W/m² (front, before IAM)
 * @param {number} tAir °C
 * @param {number} wind m/s at 10 m
 * @param {number} [u0=26.9]
 * @param {number} [u1=6.2]
 * @returns {number} °C
 */
export function cellTempFaiman(poaGlobal, tAir, wind, u0 = 26.9, u1 = 6.2) {
    return tAir + poaGlobal / (u0 + u1 * Math.max(wind, 0));
}

/**
 * PVWatts v5 DC with Marion's low-light correction k (pvlib pvwatts_dc with cap_adjustment):
 * k = (0.2·Pdc0 − P200)/Pdc0, so k = 0.0064 is a 3.2% relative drop at 200 W/m².
 * @param {number} gEff effective irradiance W/m²
 * @param {number} tCell °C
 * @param {number} pdc0 W at STC
 * @param {number} [gamma=-0.003] 1/K
 * @param {number} [k=0]
 * @returns {number} W
 */
export function dcPowerPvwatts(gEff, tCell, pdc0, gamma = -0.003, k = 0) {
    if (!(gEff > 0)) return 0;
    let p = (gEff / 1000) * pdc0 * (1 + gamma * (tCell - 25));
    if (k) {
        const err = gEff <= 200 ? k * (1 - (1 - gEff / 200) ** 4) : gEff >= 1000 ? 0 : (k * (1000 - gEff)) / 800;
        p -= pdc0 * err;
    }
    return Math.max(p, 0);
}

/**
 * Huld (2011) PV module model as used by PVGIS.
 * @param {number} gEff W/m²
 * @param {number} tModule °C
 * @param {number} pdc0 W
 * @param {ReadonlyArray<number>} [k=HULD_CSI_2025]
 * @returns {number} W
 */
export function dcPowerHuld(gEff, tModule, pdc0, k = HULD_CSI_2025) {
    if (!(gEff > 0.5)) return 0;
    const g = gEff / 1000, lg = Math.log(g), t = tModule - 25;
    const eff = 1 + k[0] * lg + k[1] * lg * lg + k[2] * t + k[3] * t * lg + k[4] * t * lg * lg + k[5] * t * t;
    return Math.max(0, pdc0 * g * eff);
}

/**
 * PVWatts inverter: η = ηnom/ηref·(−0.0162ζ − 0.0059/ζ + 0.9858), ζ = Pdc/Pdc0, Pdc0 = Pac0/ηnom,
 * clipped to [0, Pac0]. Its low-load droop (86% at 5% load) is what makes an 800 W cap slightly
 * favour vertical planes.
 * @param {number} pdc W
 * @param {number} pac0 W AC limit
 * @param {number} [etaNom=0.96]
 * @param {number} [etaRef=0.9637]
 * @returns {number} W
 */
export function acPowerPvwatts(pdc, pac0, etaNom = 0.96, etaRef = 0.9637) {
    if (!(pdc > 0)) return 0;
    const z = pdc / (pac0 / etaNom);
    const eta = (etaNom / etaRef) * (-0.0162 * z - 0.0059 / z + 0.9858);
    return clamp(eta * pdc, 0, pac0);
}

/**
 * DC input power at which the PVWatts curve reaches the AC limit (solved once by bisection;
 * equals Pac0/ηnom when ηref = 0.9637). DC above this is clipped.
 * @param {number} pac0
 * @param {number} [etaNom=0.96]
 * @param {number} [etaRef=0.9637]
 * @returns {number} W
 */
export function pdcAtAcLimit(pac0, etaNom = 0.96, etaRef = 0.9637) {
    if (!(pac0 > 0)) return 0;
    if (!Number.isFinite(pac0)) return Infinity;
    const pdc0 = pac0 / etaNom;
    const raw = (p) => { const z = p / pdc0; return (etaNom / etaRef) * (-0.0162 * z - 0.0059 / z + 0.9858) * p; };
    // the curve rises monotonically up to ζ ≈ 30, far beyond any real operating point
    let lo = pdc0 * 1e-3, hi = pdc0 * 30;
    if (!(raw(hi) >= pac0)) return pdc0;
    for (let i = 0; i < 200 && hi - lo > 1e-12 * pdc0; i++) {
        const mid = (lo + hi) / 2;
        if (raw(mid) < pac0) lo = mid; else hi = mid;
    }
    return hi;
}

/**
 * Horizon elevation at an azimuth from a profile of equal sectors starting at North, linearly
 * interpolated between sector values.
 * @param {ArrayLike<number>} horizon
 * @param {number} azimuthDeg
 * @returns {number} degrees
 */
export function horizonElevation(horizon, azimuthDeg) {
    if (!horizon || !horizon.length) return 0;
    const n = horizon.length, step = 360 / n;
    const x = (((azimuthDeg % 360) + 360) % 360) / step;
    const i = Math.floor(x) % n, j = (i + 1) % n, f = x - Math.floor(x);
    return horizon[i] * (1 - f) + horizon[j] * f;
}

const hzCache = new Map();

/**
 * Fractions of a plane's isotropic sky diffuse (`iso`) and of the Perez horizon band
 * (0–6.5°, `band`) left visible by a horizon profile, by cos-incidence × solid-angle integration.
 * @param {number} tilt
 * @param {number} surfaceAzimuth compass degrees
 * @param {ArrayLike<number>} horizon sector elevations from North
 * @returns {{ iso: number, band: number }}
 */
export function horizonFactors(tilt, surfaceAzimuth, horizon) {
    if (!horizon || !horizon.length) return { iso: 1, band: 1 };
    const key = `${tilt}|${surfaceAzimuth}|${Array.from(horizon).join(',')}`;
    const hit = hzCache.get(key);
    if (hit) return hit;
    const nAz = 72, nEl = 45;
    let seen = 0, total = 0, bandSeen = 0, bandTot = 0;
    const dAz = (2 * Math.PI) / nAz, dEl = Math.PI / 2 / nEl;
    const cellDeg = 90 / nEl;
    for (let i = 0; i < nAz; i++) {
        const az = (i + 0.5) * (360 / nAz);
        const hz = horizonElevation(horizon, az);
        for (let j = 0; j < nEl; j++) {
            const el = (j + 0.5) * cellDeg;
            const ci = cosAoi(tilt, surfaceAzimuth, 90 - el, az);
            if (ci <= 0) continue;
            const w = ci * Math.cos(el * D2R) * dAz * dEl;
            total += w;
            seen += w * clamp(((j + 1) * cellDeg - hz) / cellDeg, 0, 1);
        }
        const cb = cosAoi(tilt, surfaceAzimuth, 90 - 3.25, az);
        if (cb > 0) { bandTot += cb; bandSeen += cb * clamp((6.5 - hz) / 6.5, 0, 1); }
    }
    const res = Object.freeze({ iso: total > 0 ? seen / total : 1, band: bandTot > 0 ? bandSeen / bandTot : 1 });
    if (hzCache.size > 256) hzCache.clear();
    hzCache.set(key, res);
    return res;
}

/* ── geometry and sky precompute ── */

/**
 * @typedef {Object} Geometry
 * @property {number} start
 * @property {number} n
 * @property {number} subSteps
 * @property {number} m n·subSteps; sub-sample j of slot t is index t·subSteps + j, centred at
 *   start + t·SLOT_MS + (j + 0.5)·SLOT_MS/subSteps
 * @property {number} lat
 * @property {number} lon
 * @property {number} altitude
 * @property {Float64Array} cosZ      cos(apparent zenith)
 * @property {Float64Array} sinZ
 * @property {Float64Array} zenithDeg apparent zenith
 * @property {Float64Array} sunAzDeg  compass
 * @property {Float64Array} cosAz
 * @property {Float64Array} sinAz
 * @property {Float64Array} dniExtra  W/m²
 * @property {Float64Array} airmass   Kasten–Young; 0 when the sun is down
 * @property {Uint8Array} monthOfSub  LOCAL month0 of the slot each sub-sample belongs to
 * @property {Float64Array} csWeight  clear-sky GHI / slot clear-sky mean (sub-sample mean = 1)
 * @property {Uint8Array} uniform     per slot: 1 when the slot has no usable clear-sky reference
 * @property {string} key
 */

const geomCache = new Map();

/**
 * Orientation- and weather-independent geometry for every sub-sample, cached per
 * (start, n, lat, lon, altitude, subSteps, linke).
 * @param {{ start: number, n: number, lat: number, lon: number, altitude?: number }} site
 * @param {{ subSteps?: number, linke?: number|ArrayLike<number>|null }} [opts]
 *   linke: monthly Linke turbidity (UTC month0) or one number; default linkeFor(lat, lon)
 * @returns {Geometry}
 */
export function prepareGeometry({ start, n, lat, lon, altitude = 0 }, { subSteps = 3, linke = null } = {}) {
    const sub = Math.max(1, Math.round(subSteps));
    const tl = linke == null ? linkeFor(lat, lon)
        : typeof linke === 'number' ? new Float64Array(12).fill(linke) : Float64Array.from(linke);
    const key = [start, n, lat, lon, altitude, sub, Array.from(tl).join(',')].join('|');
    const hit = geomCache.get(key);
    if (hit) return hit;

    const m = n * sub;
    const cosZ = new Float64Array(m), sinZ = new Float64Array(m), zenithDeg = new Float64Array(m);
    const sunAzDeg = new Float64Array(m), cosAz = new Float64Array(m), sinAz = new Float64Array(m);
    const dniExtra = new Float64Array(m), airmass = new Float64Array(m);
    const monthOfSub = new Uint8Array(m), csWeight = new Float64Array(m), uniform = new Uint8Array(n);
    const local = buildLocalIndex(start, n);
    const cs = new Float64Array(sub);
    for (let t = 0; t < n; t++) {
        const t0 = start + t * SLOT_MS;
        // a slot never straddles a UTC month boundary, so one Linke lookup per slot is exact
        const linkeT = tl[new Date(t0).getUTCMonth()];
        let csSum = 0;
        for (let j = 0; j < sub; j++) {
            const i = t * sub + j;
            const ms = t0 + ((j + 0.5) * SLOT_MS) / sub;
            const sp = sunPosition(ms, lat, lon);
            const doy = dayOfYear(ms);
            const z = sp.zenithDeg;
            zenithDeg[i] = z;
            cosZ[i] = sp.cosZ;
            sinZ[i] = Math.sin(z * D2R);
            sunAzDeg[i] = sp.azimuthDeg;
            cosAz[i] = Math.cos(sp.azimuthDeg * D2R);
            sinAz[i] = Math.sin(sp.azimuthDeg * D2R);
            dniExtra[i] = extraterrestrial(doy);
            const am = airmassKastenYoung(z);
            airmass[i] = Number.isFinite(am) ? am : 0;
            monthOfSub[i] = local.month[t];
            cs[j] = clearSkyIneichen(z, doy, linkeT, altitude).ghi;
            csSum += cs[j];
        }
        const csMean = csSum / sub;
        // below 1 W/m² of clear sky (twilight) there is no shape to follow: spread uniformly
        if (csMean > 1) for (let j = 0; j < sub; j++) csWeight[t * sub + j] = cs[j] / csMean;
        else { uniform[t] = 1; for (let j = 0; j < sub; j++) csWeight[t * sub + j] = 1; }
    }
    const geom = Object.freeze({
        start, n, subSteps: sub, m, lat, lon, altitude, cosZ, sinZ, zenithDeg, sunAzDeg, cosAz, sinAz,
        dniExtra, airmass, monthOfSub, csWeight, uniform, key,
    });
    if (geomCache.size >= 4) geomCache.delete(geomCache.keys().next().value);
    geomCache.set(key, geom);
    return geom;
}

/**
 * @typedef {Object} Sky
 * @property {Geometry} geom
 * @property {Float32Array} ghi    sub-sample W/m²
 * @property {Float32Array} dni
 * @property {Float32Array} dhi
 * @property {Float32Array} F1     Perez coefficients (classified on the unshaded sky)
 * @property {Float32Array} F2
 * @property {Float32Array} tempC
 * @property {Float32Array} windMs
 * @property {string} scaleKey     'actual' or the month factors
 */

/**
 * Split slot-mean irradiance into sub-samples by the clear-sky index — each sub-sample is the
 * slot GHI times its clear-sky weight, so the sub-sample mean equals the slot mean exactly and
 * the diffuse fraction is constant within the slot. DNI is re-derived per sub-sample as
 * (GHI − DHI)/cos z (the slot DNI is not used); beam at sun elevations under 1° moves into
 * diffuse. Temperature and wind (slot-midpoint values) are interpolated linearly between slot
 * midpoints. `monthScale` multiplies GHI and DHI (hence DNI) by the slot's local-month factor,
 * which keeps GHI = DNI·cos z + DHI closure.
 * @param {{ ghi: ArrayLike<number>, dhi: ArrayLike<number>, tempC: ArrayLike<number>, windMs: ArrayLike<number>,
 *   n: number, start?: number }} ds Dataset or any object with those slot arrays
 * @param {Geometry} geom
 * @param {{ monthScale?: ArrayLike<number>|null }} [opts] 12 factors by local month0
 * @returns {Sky}
 */
export function prepareSky(ds, geom, { monthScale = null } = {}) {
    if (ds.n !== geom.n || (ds.start != null && ds.start !== geom.start)) {
        throw new RangeError(`prepareSky: dataset (start ${ds.start}, n ${ds.n}) does not match geometry (start ${geom.start}, n ${geom.n})`);
    }
    const { n, subSteps: sub, m } = geom;
    let scale = null;
    if (monthScale) {
        scale = Float64Array.from({ length: 12 }, (_, k) => Math.max(0, num(monthScale[k], 1)));
        if (scale.every((v) => v === 1)) scale = null;
    }
    const ghi = new Float32Array(m), dni = new Float32Array(m), dhi = new Float32Array(m);
    const F1 = new Float32Array(m), F2 = new Float32Array(m);
    const tempC = new Float32Array(m), windMs = new Float32Array(m);
    const scratch = [0, 0];
    const T = ds.tempC, W = ds.windMs;
    // non-finite temperature/wind cannot reach here from weather.js; these are last-ditch guards
    const tAt = (k) => num(T[k], 10);
    const wAt = (k) => num(W[k], 2);
    for (let t = 0; t < n; t++) {
        const sc = scale ? scale[geom.monthOfSub[t * sub]] : 1;
        const g0 = ds.ghi[t] > 0 ? ds.ghi[t] : 0;
        const d0 = ds.dhi[t];
        const kd = g0 > 0 ? clamp((Number.isFinite(d0) ? d0 : g0) / g0, 0, 1) : 1;
        const G = g0 * sc;
        const uni = geom.uniform[t] === 1;
        const Tc = tAt(t), Tp = t > 0 ? tAt(t - 1) : Tc, Tn = t < n - 1 ? tAt(t + 1) : Tc;
        const Wc = wAt(t), Wp = t > 0 ? wAt(t - 1) : Wc, Wn = t < n - 1 ? wAt(t + 1) : Wc;
        for (let j = 0; j < sub; j++) {
            const i = t * sub + j;
            let g, d;
            if (uni) { g = G; d = g; } else { g = G * geom.csWeight[i]; d = kd * g; }
            let dn = 0;
            if (g - d > 0) {
                const cz = geom.cosZ[i];
                if (cz > 0.0175) dn = (g - d) / cz; else d = g;
            }
            ghi[i] = g; dhi[i] = d; dni[i] = dn;
            perezInto(scratch, d, dn, geom.zenithDeg[i], geom.airmass[i], geom.dniExtra[i]);
            F1[i] = scratch[0]; F2[i] = scratch[1];
            const tau = (j + 0.5) / sub;
            if (tau < 0.5) {
                tempC[i] = Tp + (Tc - Tp) * (tau + 0.5);
                windMs[i] = Wp + (Wc - Wp) * (tau + 0.5);
            } else {
                tempC[i] = Tc + (Tn - Tc) * (tau - 0.5);
                windMs[i] = Wc + (Wn - Wc) * (tau - 0.5);
            }
        }
    }
    const scaleKey = scale ? 'm:' + Array.from(scale, (v) => v.toPrecision(10)).join(',') : 'actual';
    return { geom, ghi, dni, dhi, F1, F2, tempC, windMs, scaleKey };
}

/* ── arrays ── */

/**
 * Fill PvArray defaults (CONTRACTS §9) for the fields that affect DC. Optional extras the engine
 * understands: transposition ('perez' | 'haydavies' | 'isotropic'), iamAr (Martin–Ruiz a_r),
 * faiman ([U0, U1] overriding the mounting preset), shadingExplicit (apply shadingPct even with
 * a horizon profile).
 */
function normalizeArray(a = {}) {
    const mounting = FAIMAN[a.mounting] ? a.mounting : 'open';
    const pct = (v, dflt) => clamp(num(v, dflt), 0, 100);
    const horizon = Array.isArray(a.horizon) || ArrayBuffer.isView(a.horizon) ? Array.from(a.horizon, (v) => num(v, 0)) : [];
    const dcModel = a.dcModel === 'huld2025' || a.dcModel === 'huld' ? a.dcModel : 'pvwatts';
    const tr = a.transposition === 'haydavies' || a.transposition === 'isotropic' ? a.transposition : 'perez';
    const faiman = Array.isArray(a.faiman) && a.faiman.length === 2 ? [num(a.faiman[0], 26.9), num(a.faiman[1], 6.2)] : FAIMAN[mounting];
    return {
        count: Math.max(0, num(a.count, 1)), wp: Math.max(0, num(a.wp, 400)),
        tilt: clamp(num(a.tilt, 35), 0, 180), azimuth: ((num(a.azimuth, 180) % 360) + 360) % 360,
        mounting, groundSelfShade: typeof a.groundSelfShade === 'boolean' ? a.groundSelfShade : mounting === 'railing' || mounting === 'wall',
        albedo: clamp(num(a.albedo, 0.2), 0, 1), tempCoeffPct: num(a.tempCoeffPct, -0.30), dcModel,
        lowLightK: num(a.lowLightK, 0.0064), bifaciality: clamp(num(a.bifaciality, 0), 0, 1),
        rearShading: clamp(num(a.rearShading, 0.6), 0, 1), shadingPct: pct(a.shadingPct, 3),
        beamShadingPct: pct(a.beamShadingPct, 0), diffuseShadingPct: pct(a.diffuseShadingPct, 0), horizon,
        transposition: tr, iamAr: num(a.iamAr, 0.16) > 0 ? num(a.iamAr, 0.16) : 0.16, faiman,
        shadingExplicit: a.shadingExplicit === true,
    };
}

/**
 * The lumped shading % actually applied. A horizon profile or explicit beam/diffuse shading
 * models the same losses, so the lumped default is dropped then (no double count) unless the
 * user set shadingExplicit.
 * @param {Object} array PvArray
 * @returns {number} percent
 */
export function effectiveShadingPct(array) {
    const a = normalizeArray(array);
    if (a.shadingExplicit) return a.shadingPct;
    return a.horizon.length === 0 && a.beamShadingPct === 0 && a.diffuseShadingPct === 0 ? a.shadingPct : 0;
}

/**
 * Stable key over every array field that changes DC output (not id, name or input wiring).
 * @param {Object} array PvArray
 * @returns {string}
 */
export function arrayKey(array) {
    const a = normalizeArray(array);
    return JSON.stringify([a.count, a.wp, a.tilt, a.azimuth, a.mounting, a.groundSelfShade, a.albedo, a.tempCoeffPct,
        a.dcModel, a.lowLightK, a.bifaciality, a.rearShading, effectiveShadingPct(array), a.beamShadingPct,
        a.diffuseShadingPct, a.horizon, a.transposition, a.iamAr, a.faiman]);
}

/**
 * DC power per sub-sample for one array: POA (Perez by default) → Martin–Ruiz IAM (beam and
 * circumsolar get the beam IAM, the rest the diffuse sky/ground IAMs) → horizon/beam/diffuse
 * shading → bifacial rear gain → Faiman temperature → PVWatts (or Huld) → DC losses and lumped
 * shading. Degradation belongs to finance, not here.
 * @param {Sky} sky
 * @param {Object} array PvArray (compass azimuth)
 * @param {{ losses?: Record<string, number> }} [opts]
 * @returns {Float32Array} W per sub-sample, length geom.m
 */
export function arrayDcW(sky, array, { losses = DEFAULT_LOSSES } = {}) {
    const a = normalizeArray(array);
    const geom = sky.geom;
    const m = geom.m;
    const out = new Float32Array(m);
    const pdc0 = a.count * a.wp;
    if (!(pdc0 > 0)) return out;

    const ct = Math.cos(a.tilt * D2R), st = Math.sin(a.tilt * D2R);
    const cSa = Math.cos(a.azimuth * D2R), sSa = Math.sin(a.azimuth * D2R);
    const horizon = a.horizon, hasHz = horizon.length > 0;
    const hz = horizonFactors(a.tilt, a.azimuth, horizon);
    const ar = a.iamAr;
    const mrDen = 1 - Math.exp(-1 / ar);
    const { sky: fs, ground: fg } = iamMartinRuizDiffuse(a.tilt, ar);
    const [u0, u1] = a.faiman;
    const gamma = a.tempCoeffPct / 100, k = a.lowLightK;
    const lf = lossFactor(losses) * (1 - effectiveShadingPct(array) / 100);
    const beamKeep = 1 - a.beamShadingPct / 100, difKeep = 1 - a.diffuseShadingPct / 100;
    const albedo = a.albedo, gss = a.groundSelfShade;
    const rearF = a.bifaciality > 0 ? a.bifaciality * (1 - a.rearShading) : 0;
    const model = a.transposition === 'perez' ? 0 : a.transposition === 'haydavies' ? 1 : 2;
    const huldK = a.dcModel === 'huld2025' ? HULD_CSI_2025 : a.dcModel === 'huld' ? HULD_CSI : null;
    const scratch = [0, 0];
    const { ghi, dhi, dni, F1, F2, tempC, windMs } = sky;
    const { cosZ, sinZ, zenithDeg, cosAz, sinAz, sunAzDeg, dniExtra, airmass } = geom;

    for (let i = 0; i < m; i++) {
        const g = ghi[i];
        if (!(g > 0)) continue; // no GHI → no beam, diffuse or ground light
        const d = dhi[i], dn = dni[i];
        const zen = zenithDeg[i], cz = cosZ[i];
        const sunUp = zen < 90;
        const cosInc = clamp(cz * ct + sinZ[i] * st * (cosAz[i] * cSa + sinAz[i] * sSa), -1, 1);
        const blocked = hasHz && 90 - zen < horizonElevation(horizon, sunAzDeg[i]);
        const dniUp = sunUp && dn > 0 ? dn : 0;
        const poaBeam = dniUp * (cosInc > 0 ? cosInc : 0);

        // sky diffuse components; Perez keeps its sky classification from the unshaded DNI
        let iso = 0, cs = 0, hor = 0;
        if (d > 0) {
            if (model === 0) {
                const f1 = F1[i];
                iso = d * (1 - f1) * (1 + ct) / 2;
                cs = (d * f1 * (cosInc > 0 ? cosInc : 0)) / (cz > COS85 ? cz : COS85);
                hor = d * F2[i] * st;
                if (!(iso + cs + hor > 0)) iso = cs = hor = 0;
            } else if (model === 1) {
                const AI = clamp(dniUp / dniExtra[i], 0, 1);
                const Rb = (cosInc > 0 ? cosInc : 0) / (cz > 0.01745 ? cz : 0.01745);
                iso = Math.max(d * (1 - AI) * (1 + ct) / 2, 0);
                cs = Math.max(d * AI * Rb, 0);
            } else {
                iso = d * (1 + ct) / 2;
            }
        }

        // shading: a blocked sun loses beam and circumsolar; the horizon removes part of the
        // isotropic dome and of the (positive) horizon-brightening band
        const beamF = blocked ? 0 : beamKeep;
        const cs2 = cs * beamF;
        const iso2 = iso * hz.iso * difKeep;
        const hor2 = hor * (hor > 0 ? hz.band : 1) * difKeep;
        let poaSky = cs2 + iso2 + hor2;
        if (poaSky < 0) poaSky = 0;
        const beam2 = poaBeam * beamF;
        const poaGround = (gss && cosInc <= 0 ? (d > 0 ? d : 0) : g) * albedo * (1 - ct) / 2;
        const poaGlobal = beam2 + poaSky + poaGround;
        const fb = cosInc > 0 ? (1 - Math.exp(-cosInc / ar)) / mrDen : 0;
        let gEff = beam2 * fb + cs2 * fb + (poaSky - cs2) * fs + poaGround * fg;

        if (rearF > 0) {
            // rear face = plane at (180 − tilt, azimuth + 180), so its cos-incidence is −cosInc;
            // no rear IAM or horizon (rearShading absorbs both), as in the reference
            const ci = -cosInc;
            const dR = blocked ? 0 : dniUp;
            const beamR = dR * (ci > 0 ? ci : 0);
            let skyR = 0;
            if (d > 0) {
                if (model === 0) {
                    let f1 = F1[i], f2 = F2[i];
                    if (blocked) { perezInto(scratch, d, 0, zen, airmass[i], dniExtra[i]); f1 = scratch[0]; f2 = scratch[1]; }
                    skyR = d * (1 - f1) * (1 - ct) / 2 + (d * f1 * (ci > 0 ? ci : 0)) / (cz > COS85 ? cz : COS85) + d * f2 * st;
                    if (skyR < 0) skyR = 0;
                } else if (model === 1) {
                    const AI = clamp(dR / dniExtra[i], 0, 1);
                    const Rb = (ci > 0 ? ci : 0) / (cz > 0.01745 ? cz : 0.01745);
                    skyR = Math.max(d * (1 - AI) * (1 - ct) / 2, 0) + Math.max(d * AI * Rb, 0);
                } else {
                    skyR = d * (1 - ct) / 2;
                }
            }
            const groundR = (gss && ci <= 0 ? (d > 0 ? d : 0) : g) * albedo * (1 + ct) / 2;
            gEff += rearF * (beamR + skyR + groundR);
        }

        const w = windMs[i];
        const tc = tempC[i] + poaGlobal / (u0 + u1 * (w > 0 ? w : 0));
        let p;
        if (huldK) p = dcPowerHuld(gEff, tc, pdc0, huldK);
        else if (gEff > 0) {
            p = (gEff / 1000) * pdc0 * (1 + gamma * (tc - 25));
            if (k) p -= pdc0 * (gEff <= 200 ? k * (1 - (1 - gEff / 200) ** 4) : gEff >= 1000 ? 0 : (k * (1000 - gEff)) / 800);
            if (p < 0) p = 0;
        } else p = 0;
        out[i] = p * lf;
    }
    return out;
}

/* ── inverter ── */

/** Fill Inverter defaults (CONTRACTS §5). */
function normalizeInverter(inv) {
    const i = inv ?? {};
    const inputs = Array.isArray(i.inputs) && i.inputs.length ? i.inputs : [{}];
    return {
        acLimitW: num(i.acLimitW, 800) > 0 ? num(i.acLimitW, 800) : 800,
        etaNom: clamp(num(i.etaNom, 0.96), 0.5, 1),
        // ηref only rescales the curve; 0 or a negative value would divide by zero or flip it
        etaRef: clamp(num(i.etaRef, 0.9637), 0.5, 1),
        inputs,
        standbyW: Math.max(0, num(i.standbyW, 0)),
    };
}

/**
 * Sum per-array DC onto the inverter inputs they are wired to.
 * @param {Geometry} geom
 * @param {Array<{ input?: number, id?: string }>} arrays PvArrays in the same order as dcList
 * @param {Float32Array[]} dcList arrayDcW output per array
 * @param {Object|null} inverter
 * @returns {Float32Array[]} one per inverter input
 * @throws {RangeError} when an array names an input the inverter does not have
 */
export function dcByInput(geom, arrays, dcList, inverter) {
    const nIn = normalizeInverter(inverter).inputs.length;
    const out = new Array(nIn).fill(null);
    const owned = new Array(nIn).fill(false);
    arrays.forEach((a, k) => {
        const idx = a?.input ?? 0;
        if (!(Number.isInteger(idx) && idx >= 0 && idx < nIn)) {
            throw new RangeError(`array ${a?.id ?? k}: input ${idx} is outside the inverter's inputs 0..${nIn - 1}`);
        }
        const dc = dcList[k];
        if (!out[idx]) { out[idx] = dc; return; }
        if (!owned[idx]) { out[idx] = Float32Array.from(out[idx]); owned[idx] = true; }
        const acc = out[idx];
        for (let i = 0; i < acc.length; i++) acc[i] += dc[i];
    });
    return out.map((x) => x ?? new Float32Array(geom.m));
}

/**
 * @typedef {Object} PvSlots  per-slot energies (kWh) of the grid-tied PV path, no battery
 * @property {Float64Array} dcRawKwh      all array DC
 * @property {Float64Array} dcInvKwh      DC the inverter actually converts: Σ min(dcAfterInputCaps, pdcAtCap)
 * @property {Float64Array} acKwh         AC out, ≥ 0 (standby is NOT netted here)
 * @property {Float64Array} clippedDcKwh  dcRaw − dcInv, in DC units (input caps + AC cap)
 * @property {Float64Array} standbyKwh    inverter draw while producing nothing
 * @property {Float64Array} etaPv         acKwh / dcInvKwh, or etaNom when there is no DC
 */

/**
 * Micro-inverter per sub-sample, then averaged to slots: per-input DC cap min(maxDcW, maxAcW/ηnom)
 * (dual-input micros behave as two ~400 W channels), PVWatts efficiency, AC cap. Clipping per
 * sub-sample matters for vertical and E/W planes whose peaks are short.
 * @param {Geometry} geom
 * @param {Array<Float32Array|null>} dcByInputW DC W per sub-sample, one per inverter input
 * @param {{ acLimitW?: number, etaNom?: number, etaRef?: number, inputs?: Array<{ maxDcW?: number, maxAcW?: number }>, standbyW?: number }|null} inverter
 * @returns {PvSlots}
 */
export function inverterAc(geom, dcByInputW, inverter) {
    const inv = normalizeInverter(inverter);
    const { n, subSteps: sub } = geom;
    const nIn = dcByInputW.length;
    if (nIn > inv.inputs.length) throw new RangeError(`inverterAc: ${nIn} DC inputs but the inverter has ${inv.inputs.length}`);
    const caps = Float64Array.from({ length: nIn }, (_, q) => {
        const spec = inv.inputs[q] ?? {};
        return Math.min(num(spec.maxDcW, Infinity), num(spec.maxAcW, Infinity) / inv.etaNom);
    });
    const pac0 = inv.acLimitW, etaNom = inv.etaNom, etaRef = inv.etaRef;
    const pdcCap = pdcAtAcLimit(pac0, etaNom, etaRef);
    const kWh = DT_H / 1000 / sub;
    const dcRawKwh = new Float64Array(n), dcInvKwh = new Float64Array(n), acKwh = new Float64Array(n);
    const clippedDcKwh = new Float64Array(n), standbyKwh = new Float64Array(n), etaPv = new Float64Array(n);
    for (let t = 0; t < n; t++) {
        let sRaw = 0, sInv = 0, sClip = 0, sAc = 0, sStby = 0;
        for (let j = 0; j < sub; j++) {
            const i = t * sub + j;
            let raw = 0, used = 0;
            for (let q = 0; q < nIn; q++) {
                const arr = dcByInputW[q];
                const p = arr ? arr[i] : 0;
                if (p > 0) { raw += p; used += p < caps[q] ? p : caps[q]; }
            }
            const conv = used < pdcCap ? used : pdcCap;
            sRaw += raw;
            sInv += conv;
            sClip += raw - conv;
            if (used > 0) sAc += acPowerPvwatts(used, pac0, etaNom, etaRef);
            else sStby += inv.standbyW;
        }
        dcRawKwh[t] = sRaw * kWh;
        dcInvKwh[t] = sInv * kWh;
        clippedDcKwh[t] = sClip * kWh;
        acKwh[t] = sAc * kWh;
        standbyKwh[t] = sStby * kWh;
        etaPv[t] = sInv > 0 ? sAc / sInv : etaNom;
    }
    return { dcRawKwh, dcInvKwh, acKwh, clippedDcKwh, standbyKwh, etaPv };
}

/**
 * DC energy per slot from sub-sample power, each sub-sample capped at maxDcW — for panels that
 * feed a power station's own DC input (no grid inverter).
 * @param {Geometry} geom
 * @param {Float32Array} dcW
 * @param {number} [maxDcW=Infinity]
 * @returns {Float64Array} kWh per slot
 */
export function dcToSlotsKwh(geom, dcW, maxDcW = Infinity) {
    const { n, subSteps: sub } = geom;
    const out = new Float64Array(n);
    const kWh = DT_H / 1000 / sub;
    const cap = maxDcW >= 0 ? maxDcW : Infinity; // NaN/negative cap = no cap, never "Infinity kWh"
    for (let t = 0; t < n; t++) {
        let s = 0;
        for (let j = 0; j < sub; j++) {
            const p = dcW[t * sub + j];
            if (p > 0) s += p < cap ? p : cap; // also drops NaN: `NaN < cap` would add the cap
        }
        out[t] = s * kWh;
    }
    return out;
}

/**
 * Scale cached DC by a factor per local month — the cheap weather-year band: re-running the
 * whole sky is unnecessary when only the month's sunshine total changes.
 * @param {Geometry} geom
 * @param {Float32Array} dcW
 * @param {ArrayLike<number>|null} factors 12, by local month0 (null or a missing entry = 1;
 *   negative = 0, never negative DC)
 * @returns {Float32Array}
 */
export function scaleDcByMonth(geom, dcW, factors) {
    const out = new Float32Array(dcW.length);
    const f = Float64Array.from({ length: 12 }, (_, k) => Math.max(0, num(factors?.[k], 1)));
    for (let i = 0; i < dcW.length; i++) out[i] = dcW[i] * f[geom.monthOfSub[i]];
    return out;
}

/**
 * Convenience: every array's DC, grouped by input, through the inverter.
 * @param {Sky} sky
 * @param {Object[]} arrays PvArrays
 * @param {Object|null} inverter
 * @param {{ losses?: Record<string, number> }} [opts]
 * @returns {{ pv: PvSlots, dc: Float32Array[] }}
 */
export function simulatePv(sky, arrays, inverter, { losses = DEFAULT_LOSSES } = {}) {
    const dc = arrays.map((a) => arrayDcW(sky, a, { losses }));
    const pv = inverterAc(sky.geom, dcByInput(sky.geom, arrays, dc, inverter), inverter);
    return { pv, dc };
}
