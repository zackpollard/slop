import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
    sunPosition, cosZenithTrue, meanCosZ, dayOfYear, extraterrestrial, airmassKastenYoung, alt2pres,
    clearSkyIneichen, refractionNOAA, LINKE, linkeFor,
} from '../../../projects/solar-calculator/js/sun.js';

const FIX = new URL('./fixtures/solar/', import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, FIX), 'utf8'));
const PV = load('a1-pvlib-vectors.json'); // pvlib 0.16.1 values
const REF = load('a1-sun-ref.json');      // research reference implementation values
const Z = (s) => Date.parse(s);
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

describe('sunPosition — port fidelity', () => {
    it('reproduces the research reference (pv-reference-verified.js) exactly', () => {
        for (const [ms, lat, lon, zApp, zTrue, az, decl] of REF.rows) {
            const sp = sunPosition(ms, lat, lon);
            expect(Math.abs(sp.zenithDeg - zApp)).toBeLessThan(1e-9);
            expect(Math.abs(sp.zenithTrueDeg - zTrue)).toBeLessThan(1e-9);
            expect(Math.abs(angDiff(sp.azimuthDeg, az))).toBeLessThan(1e-9);
            expect(Math.abs(sp.declinationDeg - decl)).toBeLessThan(1e-9);
            expect(sp.elevationDeg).toBeCloseTo(90 - sp.zenithDeg, 12);
            expect(sp.cosZ).toBeCloseTo(Math.cos((sp.zenithDeg * Math.PI) / 180), 12);
        }
    });
});

describe('sunPosition — against NREL SPA', () => {
    it('is within 0.003° of the NREL SPA report example (Reda & Andreas Table A4.1)', () => {
        const e = PV.nrel_spa_example;
        const sp = sunPosition(e.ms, e.lat, e.lon, { pressureHpa: e.pressureHpa, tempC: e.tempC });
        expect(Math.abs(sp.zenithDeg - e.published_zenith)).toBeLessThan(0.003);
        expect(Math.abs(sp.azimuthDeg - e.published_azimuth)).toBeLessThan(0.003);
        expect(Math.abs(sp.zenithDeg - e.pvlib_apparent_zenith)).toBeLessThan(0.003);
    });

    it('is within 0.02° of pvlib spa_python on 120 random times and places 1995–2045', () => {
        for (const [ms, lat, lon, zTrue, zApp, az] of PV.sunpos_spa.rows) {
            const sp = sunPosition(ms, lat, lon, { pressureHpa: 1013.25, tempC: 12 });
            expect(Math.abs(sp.zenithTrueDeg - zTrue)).toBeLessThan(0.02);
            // refraction models differ below ~1° elevation (SPA stops refracting under the horizon)
            if (zApp < 89) expect(Math.abs(sp.zenithDeg - zApp)).toBeLessThan(0.02);
            // azimuth error shrinks to nothing at the zenith, so compare the arc on the sky
            expect(Math.abs(angDiff(sp.azimuthDeg, az)) * Math.sin((zTrue * Math.PI) / 180)).toBeLessThan(0.02);
        }
    });

    it('has the London midsummer noon the NOAA calculator shows (61.94°, 178.89°, refraction-corrected)', () => {
        const sp = sunPosition(Z('2023-06-21T12:00:00Z'), 51.5072, -0.1276);
        expect(sp.elevationDeg).toBeCloseTo(61.94, 2);
        expect(sp.azimuthDeg).toBeCloseTo(178.89, 2);
    });

    it('can switch refraction off and scales it with pressure/temperature', () => {
        const ms = Z('2026-03-20T07:00:00Z');
        const a = sunPosition(ms, 51.5, 0, { refraction: false });
        expect(a.zenithDeg).toBe(a.zenithTrueDeg);
        const el = 90 - a.zenithTrueDeg;
        expect(refractionNOAA(el, 1010, 10) * (900 / 1010)).toBeCloseTo(refractionNOAA(el, 900, 10), 12);
        expect(refractionNOAA(86)).toBe(0);
    });
});

describe('cosZenithTrue / meanCosZ', () => {
    it('match the weather-alignment reference meanCosZ to 1e-12', () => {
        for (const [a, b, v] of REF.meanCosZ) expect(Math.abs(meanCosZ(a, b, 51.5072, -0.1276) - v)).toBeLessThan(1e-12);
    });

    it('cosZenithTrue is the unclamped cos of the true zenith', () => {
        const ms = Z('2026-01-15T02:00:00Z');
        const c = cosZenithTrue(ms, 51.5, -0.13);
        expect(c).toBeLessThan(0);
        expect(Math.acos(c) * 180 / Math.PI).toBeCloseTo(sunPosition(ms, 51.5, -0.13).zenithTrueDeg, 10);
    });

    it('meanCosZ is zero at night and close to the midpoint value at noon', () => {
        expect(meanCosZ(Z('2026-01-15T00:00:00Z'), Z('2026-01-15T00:30:00Z'), 51.5, 0)).toBe(0);
        const noon = meanCosZ(Z('2026-06-21T11:45:00Z'), Z('2026-06-21T12:15:00Z'), 51.5, 0);
        expect(noon).toBeCloseTo(cosZenithTrue(Z('2026-06-21T12:00:00Z'), 51.5, 0), 3);
    });
});

describe('extraterrestrial, airmass, clear sky', () => {
    it('dayOfYear is the UTC day number', () => {
        expect(dayOfYear(Z('2026-01-01T00:00:00Z'))).toBe(1);
        expect(dayOfYear(Z('2026-12-31T23:59:59Z'))).toBe(365);
        expect(dayOfYear(Z('2024-12-31T12:00:00Z'))).toBe(366);
        expect(dayOfYear(Z('2026-03-28T23:30:00Z'))).toBe(87);
    });

    it('matches pvlib Spencer extraterrestrial irradiance', () => {
        for (const [doy, v] of Object.entries(PV.etr)) expect(extraterrestrial(+doy)).toBeCloseTo(v, 9);
    });

    it('matches pvlib Kasten–Young airmass and is NaN at/below the horizon', () => {
        for (const [z, v] of Object.entries(PV.airmass)) expect(Math.abs(airmassKastenYoung(+z) / v - 1)).toBeLessThan(1e-12);
        expect(airmassKastenYoung(90)).toBeNaN();
        expect(airmassKastenYoung(95)).toBeNaN();
    });

    it('matches pvlib Ineichen clear sky (Linke 3.5, 19 m)', () => {
        // pvlib was called with a constant dni_extra = 1366.1; every Ineichen output is linear in I0
        const doy = 172, f = 1366.1 / extraterrestrial(doy);
        for (const [z, ghi, dni, dhi] of PV.clearsky_tl35_alt19) {
            const c = clearSkyIneichen(z, doy, 3.5, 19);
            expect(c.ghi * f).toBeCloseTo(ghi, 8);
            expect(c.dni * f).toBeCloseTo(dni, 8);
            expect(c.dhi * f).toBeCloseTo(dhi, 8);
        }
    });

    it('matches the reference clear sky and is zero with the sun down', () => {
        for (const [z, ghi, dni, dhi] of REF.clearSkyDoy172Tl335Alt16) {
            const c = clearSkyIneichen(z, 172, 3.35, 16);
            expect(Math.abs(c.ghi - ghi)).toBeLessThan(1e-9);
            expect(Math.abs(c.dni - dni)).toBeLessThan(1e-9);
            expect(Math.abs(c.dhi - dhi)).toBeLessThan(1e-9);
        }
        expect(clearSkyIneichen(90, 172)).toEqual({ ghi: 0, dni: 0, dhi: 0 });
        expect(clearSkyIneichen(120, 172)).toEqual({ ghi: 0, dni: 0, dhi: 0 });
    });

    it('alt2pres is the standard atmosphere', () => {
        expect(alt2pres(0)).toBeCloseTo(101325, -1);
        expect(alt2pres(1500)).toBeLessThan(alt2pres(0));
    });
});

describe('Linke turbidity tables', () => {
    it('carries pvlib monthly values for London and Manchester', () => {
        expect(Array.from(LINKE.london)).toEqual([3.35, 4.35, 3.95, 3.65, 4.6, 4.95, 4.4, 4.3, 3.85, 3.45, 3.1, 3.15]);
        expect(LINKE.manchester.length).toBe(12);
        expect(LINKE.default).toBe(3.5);
    });

    it('picks the nearer UK site, else a flat 3.5', () => {
        expect(linkeFor(51.45, -2.58)).toEqual(LINKE.london);      // Bristol
        expect(linkeFor(55.95, -3.19)).toEqual(LINKE.manchester);  // Edinburgh
        expect(Array.from(linkeFor(48.85, 2.35))).toEqual(new Array(12).fill(3.5)); // Paris
    });

    it('hands out copies, so a caller cannot corrupt the shared tables', () => {
        const t = linkeFor(51.5, -0.13);
        expect(t).not.toBe(LINKE.london);
        t.fill(99);
        expect(LINKE.london[0]).toBe(3.35);
        expect(linkeFor(51.5, -0.13)[0]).toBe(3.35);
    });
});
