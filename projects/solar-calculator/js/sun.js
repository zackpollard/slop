/*
 * sun.js — solar geometry, extraterrestrial irradiance, airmass and clear sky.
 *
 * Ported from the verified research reference (pv-reference-verified.js, checked against pvlib
 * 0.16.1). Conventions: times are UTC epoch ms; angles are degrees; azimuth is compass
 * (0 = N, 90 = E, 180 = S, 270 = W), the same convention pvlib uses, so no conversion is needed
 * between the app's array azimuths and the physics.
 *
 * Accuracy: the NOAA/Meeus low-precision algorithm is within ~0.02° of NREL SPA over 1995–2045
 * (max true-zenith error 0.0176° on 4000 random cases), which is far below what half-hourly
 * irradiance data can resolve, and it is ~50× cheaper than SPA.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const DAY_MS = 86_400_000;
const sind = (x) => Math.sin(x * D2R);
const cosd = (x) => Math.cos(x * D2R);
const tand = (x) => Math.tan(x * D2R);
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Day of year 1..366 of the UTC date.
 * @param {number} ms UTC epoch ms
 * @returns {number}
 */
export function dayOfYear(ms) {
    const y = new Date(ms).getUTCFullYear();
    return Math.floor((ms - Date.UTC(y, 0, 1)) / DAY_MS) + 1;
}

/**
 * NOAA atmospheric refraction for a geometric elevation, scaled by (P/1010 hPa)·(283/(273+T)).
 * @param {number} elevTrueDeg
 * @param {number} [pressureHpa=1010]
 * @param {number} [tempC=10]
 * @returns {number} refraction in degrees (add to the true elevation)
 */
export function refractionNOAA(elevTrueDeg, pressureHpa = 1010, tempC = 10) {
    if (elevTrueDeg > 85) return 0;
    const te = tand(elevTrueDeg);
    let arcsec;
    if (elevTrueDeg > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
    else if (elevTrueDeg > -0.575) arcsec = 1735 + elevTrueDeg * (-518.2 + elevTrueDeg * (103.4 + elevTrueDeg * (-12.79 + elevTrueDeg * 0.711)));
    else arcsec = -20.774 / te;
    return (arcsec / 3600) * (pressureHpa / 1010) * (283 / (273 + tempC));
}

/**
 * Low-level NOAA terms shared by sunPosition and cosZenithTrue.
 * Returns declination (deg), hour angle (deg) and the extras sunPosition reports.
 */
function noaaCore(ms, lon) {
    const jd = ms / DAY_MS + 2440587.5;
    const T = (jd - 2451545.0) / 36525;
    let L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    if (L0 < 0) L0 += 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const Mr = M * D2R;
    const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
        Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) + Math.sin(3 * Mr) * 0.000289;
    const trueAnom = M + C;
    const R = (1.000001018 * (1 - e * e)) / (1 + e * cosd(trueAnom));
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * sind(omega);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * cosd(omega);
    const decl = Math.asin(sind(eps) * sind(lambda)) * R2D;
    let y = tand(eps / 2);
    y *= y;
    const L0r = L0 * D2R;
    const eqTime = 4 * R2D * (y * Math.sin(2 * L0r) - 2 * e * Math.sin(Mr) +
        4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) - 0.5 * y * y * Math.sin(4 * L0r) -
        1.25 * e * e * Math.sin(2 * Mr));
    const minUTC = (((ms / 60000) % 1440) + 1440) % 1440;
    const tst = (((minUTC + eqTime + 4 * lon) % 1440) + 1440) % 1440;
    return { decl, ha: tst / 4 - 180, eqTime, R };
}

/**
 * Sun position (NOAA / Meeus). Use the APPARENT zenith (refraction-corrected) for irradiance
 * work, as pvlib does; weather alignment uses the true zenith via meanCosZ.
 * @param {number} ms UTC epoch ms
 * @param {number} lat degrees north
 * @param {number} lon degrees east
 * @param {{ pressureHpa?: number, tempC?: number, refraction?: boolean }} [opts]
 * @returns {{ zenithDeg: number, zenithTrueDeg: number, elevationDeg: number, azimuthDeg: number,
 *   cosZ: number, declinationDeg: number, eqTimeMin: number, hourAngleDeg: number, earthSunDistAu: number }}
 */
export function sunPosition(ms, lat, lon, opts = {}) {
    const { decl, ha, eqTime, R } = noaaCore(ms, lon);
    const cosZt = clamp(sind(lat) * sind(decl) + cosd(lat) * cosd(decl) * cosd(ha), -1, 1);
    const zenithTrue = Math.acos(cosZt) * R2D;
    let azimuth = Math.atan2(sind(ha), cosd(ha) * sind(lat) - tand(decl) * cosd(lat)) * R2D + 180;
    azimuth = ((azimuth % 360) + 360) % 360;
    const refr = opts.refraction === false ? 0 : refractionNOAA(90 - zenithTrue, opts.pressureHpa, opts.tempC);
    const zenith = zenithTrue - refr;
    return {
        zenithDeg: zenith, zenithTrueDeg: zenithTrue, elevationDeg: 90 - zenith, azimuthDeg: azimuth,
        cosZ: Math.cos(zenith * D2R), declinationDeg: decl, eqTimeMin: eqTime, hourAngleDeg: ha, earthSunDistAu: R,
    };
}

/**
 * cos(true zenith), unclamped (negative below the horizon). This is the geometry Open-Meteo uses
 * to turn clearness indices into backward means, so alignment must use it rather than the
 * refracted zenith.
 * @param {number} ms
 * @param {number} lat
 * @param {number} lon
 * @returns {number}
 */
export function cosZenithTrue(ms, lat, lon) {
    const { decl, ha } = noaaCore(ms, lon);
    return sind(lat) * sind(decl) + cosd(lat) * cosd(decl) * cosd(ha);
}

/**
 * Mean of max(cos true zenith, 0) over [aMs, bMs) by the midpoint rule.
 * @param {number} aMs
 * @param {number} bMs
 * @param {number} lat
 * @param {number} lon
 * @param {number} [samples=10]
 * @returns {number}
 */
export function meanCosZ(aMs, bMs, lat, lon, samples = 10) {
    let s = 0;
    const d = (bMs - aMs) / samples;
    for (let i = 0; i < samples; i++) s += Math.max(0, cosZenithTrue(aMs + d * (i + 0.5), lat, lon));
    return s / samples;
}

/**
 * Extraterrestrial normal irradiance, Spencer (1971) as in pvlib's get_extra_radiation.
 * @param {number} doy day of year
 * @param {number} [solarConstant=1366.1]
 * @returns {number} W/m²
 */
export function extraterrestrial(doy, solarConstant = 1366.1) {
    const B = (2 * Math.PI * (doy - 1)) / 365;
    return solarConstant * (1.00011 + 0.034221 * Math.cos(B) + 0.00128 * Math.sin(B) +
        0.000719 * Math.cos(2 * B) + 0.000077 * Math.sin(2 * B));
}

/**
 * Kasten & Young (1989) relative airmass.
 * @param {number} zenithDeg APPARENT zenith
 * @returns {number} NaN when the sun is at or below the horizon
 */
export function airmassKastenYoung(zenithDeg) {
    if (!(zenithDeg < 90)) return NaN;
    return 1 / (cosd(zenithDeg) + 0.50572 * (96.07995 - zenithDeg) ** -1.6364);
}

/**
 * Standard-atmosphere pressure from altitude (pvlib alt2pres).
 * @param {number} altitudeM
 * @returns {number} Pa
 */
export function alt2pres(altitudeM) {
    return 100 * ((44331.514 - altitudeM) / 11880.516) ** (1 / 0.1902632);
}

/**
 * Ineichen–Perez clear sky (pvlib.clearsky.ineichen, perez_enhancement=false). Only the SHAPE of
 * the clear-sky curve within a half-hour matters to the app (it weights the sub-sample split),
 * so monthly Linke turbidity is ample.
 * @param {number} zenithDeg APPARENT zenith
 * @param {number} doy day of year
 * @param {number} [linke=3.5]
 * @param {number} [altitudeM=0]
 * @returns {{ ghi: number, dni: number, dhi: number }} W/m²
 */
export function clearSkyIneichen(zenithDeg, doy, linke = 3.5, altitudeM = 0) {
    const cz = Math.max(cosd(zenithDeg), 0);
    const amRel = airmassKastenYoung(zenithDeg);
    if (!(cz > 0) || !Number.isFinite(amRel)) return { ghi: 0, dni: 0, dhi: 0 };
    const I0 = extraterrestrial(doy);
    const ama = (amRel * alt2pres(altitudeM)) / 101325;
    const fh1 = Math.exp(-altitudeM / 8000);
    const fh2 = Math.exp(-altitudeM / 1250);
    const cg1 = 5.09e-5 * altitudeM + 0.868;
    const cg2 = 3.92e-5 * altitudeM + 0.0387;
    const ghi = cg1 * I0 * cz * Math.max(Math.exp(-cg2 * ama * (fh1 + fh2 * (linke - 1))), 0);
    const b = 0.664 + 0.163 / fh1;
    const bnci = I0 * Math.max(b * Math.exp(-0.09 * ama * (linke - 1)), 0);
    const bnci2 = ghi * clamp((1 - (0.1 - 0.2 * Math.exp(-linke)) / (0.1 + 0.882 / fh1)) / cz, 0, 1e20);
    const dni = Math.min(bnci, bnci2);
    return { ghi, dni, dhi: ghi - dni * cz };
}

/**
 * Monthly Linke turbidity (pvlib's climatology, Jan..Dec) for the two UK reference sites, plus
 * the flat 3.5 fallback used outside Great Britain.
 */
export const LINKE = Object.freeze({
    london: Float64Array.of(3.35, 4.35, 3.95, 3.65, 4.6, 4.95, 4.4, 4.3, 3.85, 3.45, 3.1, 3.15),
    manchester: Float64Array.of(3.26, 3.54, 3.45, 3.65, 3.80, 4.10, 4.20, 4.10, 3.66, 3.50, 2.91, 2.70),
    default: 3.5,
});

const SITES = [[51.5072, -0.1276, 'london'], [53.48, -2.24, 'manchester']];

/**
 * Monthly Linke table for a location: the nearer of London/Manchester inside Great Britain,
 * otherwise a flat 3.5. Returns a fresh copy — Object.freeze cannot freeze a typed array's
 * elements, so handing out LINKE.london itself would let one caller corrupt every later run.
 * @param {number} lat
 * @param {number} lon
 * @returns {Float64Array} 12 values indexed by UTC month0
 */
export function linkeFor(lat, lon) {
    const inGB = lat > 49.5 && lat < 61 && lon > -8.7 && lon < 2;
    if (!inGB) return new Float64Array(12).fill(LINKE.default);
    let best = SITES[0], bestD = Infinity;
    for (const s of SITES) {
        const d = (s[0] - lat) ** 2 + ((s[1] - lon) * Math.cos(lat * D2R)) ** 2;
        if (d < bestD) { bestD = d; best = s; }
    }
    return Float64Array.from(LINKE[best[2]]);
}
