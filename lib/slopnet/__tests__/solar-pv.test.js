import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
    DEFAULT_LOSSES, FAIMAN, HULD_CSI_2025, lossFactor, poaIrradiance, perezCoefficients, iamMartinRuiz,
    iamMartinRuizDiffuse, cellTempFaiman, dcPowerPvwatts, dcPowerHuld, acPowerPvwatts, pdcAtAcLimit,
    horizonElevation, horizonFactors, prepareGeometry, prepareSky, arrayKey, arrayDcW, effectiveShadingPct,
    dcByInput, inverterAc, dcToSlotsKwh, scaleDcByMonth, simulatePv,
} from '../../../projects/solar-calculator/js/pv.js';
import { SLOT_MS, localParts, buildLocalIndex } from '../../../projects/solar-calculator/js/time.js';
import { withVat } from '../../../projects/solar-calculator/js/vat.js';

const FIX = new URL('./fixtures/solar/', import.meta.url);
const load = (f) => JSON.parse(fs.readFileSync(new URL(f, FIX), 'utf8'));
const PV = load('a1-pvlib-vectors.json');   // pvlib 0.16.1
const GOLD = load('a1-pv-golden.json');      // research reference chain on two demo weeks
const sum = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const allFinite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

const dsOf = (s) => ({
    start: s.start, n: s.n, ghi: Float32Array.from(s.ghi), dni: Float32Array.from(s.dni), dhi: Float32Array.from(s.dhi),
    tempC: Float32Array.from(s.tempC), windMs: Float32Array.from(s.windMs),
});
const geomOf = (s, subSteps = 3) => prepareGeometry({ start: s.start, n: s.n, lat: GOLD.site.lat, lon: GOLD.site.lon, altitude: GOLD.site.altitude }, { subSteps, linke: GOLD.site.linke });
const SUMMER = GOLD.slices[0], SPRING = GOLD.slices[1];
const skySummer = prepareSky(dsOf(SUMMER), geomOf(SUMMER));
const T3 = { shadingPct: 0, tempCoeffPct: -0.3, lowLightK: 0.007, mounting: 'open' };
const INV = { acLimitW: 800, etaNom: 0.96, inputs: [{ maxAcW: 400 }, { maxAcW: 400 }], standbyW: 0 };

describe('transposition vs pvlib (200 random vectors)', () => {
    const T = PV.transp;
    for (const model of ['isotropic', 'haydavies', 'perez']) {
        it(`${model}: POA global/direct/sky/ground within 1e-6 W/m²`, () => {
            const ref = T.poa[model];
            for (let i = 0; i < T.zen.length; i++) {
                const p = poaIrradiance({
                    ghi: T.ghi[i], dni: T.dni[i], dhi: T.dhi[i], zenith: T.zen[i], azimuth: T.azi[i], tilt: T.tilt[i],
                    surfaceAzimuth: T.saz[i], albedo: 0.2, dniExtra: T.dni_extra[i], airmass: T.am[i], model,
                });
                expect(Math.abs(p.poaGlobal - ref.poa_global[i])).toBeLessThan(1e-6);
                expect(Math.abs(p.poaBeam - ref.poa_direct[i])).toBeLessThan(1e-6);
                expect(Math.abs(p.poaSky - ref.poa_sky_diffuse[i])).toBeLessThan(1e-6);
                expect(Math.abs(p.poaGround - ref.poa_ground_diffuse[i])).toBeLessThan(1e-6);
            }
        });
    }

    it('Perez components (circumsolar, isotropic, horizon band) and AOI match pvlib', () => {
        for (let i = 0; i < T.zen.length; i++) {
            const p = poaIrradiance({
                ghi: T.ghi[i], dni: T.dni[i], dhi: T.dhi[i], zenith: T.zen[i], azimuth: T.azi[i], tilt: T.tilt[i],
                surfaceAzimuth: T.saz[i], dniExtra: T.dni_extra[i], airmass: T.am[i],
            });
            expect(Math.abs(p.circumsolar - T.perez_cs[i])).toBeLessThan(1e-6);
            expect(Math.abs(p.isotropic - T.perez_iso[i])).toBeLessThan(1e-6);
            expect(Math.abs(p.horizon - T.perez_hz[i])).toBeLessThan(1e-6);
            expect(Math.abs(p.poaSky - T.perez_sky[i])).toBeLessThan(1e-6);
            expect(Math.abs(p.aoi - T.aoi[i])).toBeLessThan(1e-7);
            expect(Math.abs(iamMartinRuiz(p.aoi, 0.16) - T.iam_mr[i])).toBeLessThan(1e-12);
        }
    });

    it('exposes the Perez coefficients and zeroes them with the sun down', () => {
        const { F1, F2 } = perezCoefficients(150, 600, 40, 1.3, 1361);
        expect(F1).toBeGreaterThan(0);
        expect(Number.isFinite(F2)).toBe(true);
        expect(perezCoefficients(150, 0, 95, 0, 1361)).toEqual({ F1: 0, F2: 0 });
        expect(perezCoefficients(0, 600, 40, 1.3, 1361)).toEqual({ F1: 0, F2: 0 });
    });

    it('reflects only diffuse off self-shaded ground when the sun is behind the plane', () => {
        const base = { ghi: 400, dni: 500, dhi: 100, zenith: 60, azimuth: 90, tilt: 90, surfaceAzimuth: 270, dniExtra: 1361 };
        const open = poaIrradiance(base), shaded = poaIrradiance({ ...base, groundSelfShade: true });
        expect(open.cosInc).toBeLessThan(0);
        expect(open.poaGround).toBeCloseTo(400 * 0.2 / 2, 9);
        expect(shaded.poaGround).toBeCloseTo(100 * 0.2 / 2, 9);
    });
});

describe('IAM, temperature, DC and inverter vs pvlib', () => {
    it('Martin–Ruiz beam and diffuse IAMs', () => {
        for (const [aoi, v] of Object.entries(PV.iam_beam)) expect(Math.abs(iamMartinRuiz(+aoi, 0.16) - v)).toBeLessThan(1e-12);
        PV.mrd.tilt.forEach((tilt, i) => {
            const d = iamMartinRuizDiffuse(tilt, 0.16);
            expect(Math.abs(d.sky - PV.mrd.sky[i])).toBeLessThan(1e-12);
            expect(Math.abs(d.ground - PV.mrd.gnd[i])).toBeLessThan(1e-12);
        });
    });

    it('Faiman cell temperature and PVWatts DC with low-light k = 0.007', () => {
        const th = PV.thermal;
        th.G.forEach((G, i) => {
            const tc = cellTempFaiman(G, th.Ta[i], th.ws[i], 26.9, 6.2);
            expect(Math.abs(tc - th.tf[i])).toBeLessThan(1e-9);
            expect(Math.abs(dcPowerPvwatts(G, th.tf[i], 400, -0.003, 0.007) - th.dc[i])).toBeLessThan(1e-9);
        });
    });

    it('PVWatts inverter (pvlib pdc0 = 800 → Pac0 = 768)', () => {
        PV.inv.pdc.forEach((pdc, i) => expect(Math.abs(acPowerPvwatts(pdc, 768, 0.96) - PV.inv.ac[i])).toBeLessThan(1e-9));
        expect(acPowerPvwatts(0, 800)).toBe(0);
        expect(acPowerPvwatts(-5, 800)).toBe(0);
    });

    it('finds the DC power at the AC limit (= Pac0/ηnom for ηref 0.9637)', () => {
        expect(pdcAtAcLimit(800, 0.96)).toBeCloseTo(800 / 0.96, 6);
        expect(acPowerPvwatts(pdcAtAcLimit(800, 0.96), 800, 0.96)).toBeCloseTo(800, 6);
        expect(acPowerPvwatts(pdcAtAcLimit(800, 0.96) * 0.999, 800, 0.96)).toBeLessThan(800);
        expect(pdcAtAcLimit(600, 0.965, 0.97)).toBeGreaterThan(600);
    });

    it('Huld CSI 2025 is unity at STC and ~−0.30 %/K', () => {
        expect(dcPowerHuld(1000, 25, 400)).toBeCloseTo(400, 9);
        expect(dcPowerHuld(1000, 35, 400) / 400 - 1).toBeCloseTo(10 * HULD_CSI_2025[2], 9);
        expect(dcPowerHuld(0.4, 25, 400)).toBe(0);
    });

    it('loss stack and mounting presets', () => {
        expect(lossFactor(DEFAULT_LOSSES)).toBeCloseTo(0.98 * 0.99 ** 4, 12);
        expect(lossFactor(DEFAULT_LOSSES)).toBeCloseTo(0.94138, 5);
        expect(lossFactor({})).toBe(1);
        expect(lossFactor({ soiling: 10, note: 'ignored' })).toBeCloseTo(0.9, 12);
        // out-of-range percentages are clamped, so DC can never turn negative or exceed the panels
        expect(lossFactor({ soiling: 150 })).toBe(0);
        expect(lossFactor({ soiling: -20, wiring: 1 })).toBeCloseTo(0.99, 12);
        expect(FAIMAN).toEqual({ open: [26.9, 6.2], roof: [20, 3.2], railing: [24, 5], wall: [21, 3.5] });
    });
});

describe('horizon profile', () => {
    it('interpolates sector elevations from North', () => {
        const hz = [0, 10, 20, 30];
        expect(horizonElevation(hz, 0)).toBe(0);
        expect(horizonElevation(hz, 45)).toBe(5);
        expect(horizonElevation(hz, 315)).toBe(15);
        expect(horizonElevation([], 123)).toBe(0);
    });

    it('a uniform horizon h hides 1 − sin²h of a flat plane’s isotropic sky', () => {
        const h = 20;
        const f = horizonFactors(0, 180, new Array(36).fill(h));
        expect(f.iso).toBeCloseTo(1 - Math.sin((h * Math.PI) / 180) ** 2, 2);
        expect(f.band).toBe(0);
        expect(horizonFactors(30, 180, [])).toEqual({ iso: 1, band: 1 });
    });
});

describe('geometry and sky precompute', () => {
    const g = geomOf(SUMMER);

    it('is cached per site/window/subSteps', () => {
        expect(geomOf(SUMMER)).toBe(g);
        expect(geomOf(SUMMER, 1)).not.toBe(g);
        expect(g.m).toBe(SUMMER.n * 3);
        for (const k of ['cosZ', 'sinZ', 'zenithDeg', 'sunAzDeg', 'dniExtra', 'airmass', 'csWeight']) {
            expect(g[k].length).toBe(g.m);
            expect(allFinite(g[k])).toBe(true);
        }
    });

    it('centres sub-samples in the slot and tags them with the LOCAL month', () => {
        const G = prepareGeometry({ start: Date.parse('2026-03-31T22:00:00Z'), n: 4, lat: 51.5, lon: -0.13 }, { subSteps: 3 });
        // 22:00Z and 22:30Z on 31 Mar are still March locally; 23:00Z is 1 Apr 00:00 BST
        expect(Array.from(G.monthOfSub)).toEqual([2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3]);
        expect(localParts(Date.parse('2026-03-31T23:00:00Z')).month).toBe(4);
    });

    it('keeps each slot’s mean GHI exactly and closes GHI = DNI·cos z + DHI per sub-sample', () => {
        const ds = dsOf(SUMMER);
        const sky = skySummer;
        for (let t = 0; t < ds.n; t++) {
            let s = 0;
            for (let j = 0; j < 3; j++) s += sky.ghi[t * 3 + j];
            expect(Math.abs(s / 3 - ds.ghi[t])).toBeLessThanOrEqual(2e-6 * Math.max(1, ds.ghi[t]));
            let w = 0;
            for (let j = 0; j < 3; j++) w += g.csWeight[t * 3 + j];
            expect(w / 3).toBeCloseTo(1, 12);
        }
        for (let i = 0; i < g.m; i++) {
            if (g.cosZ[i] > 0.0175 && sky.ghi[i] > 0) {
                expect(Math.abs(sky.dni[i] * g.cosZ[i] + sky.dhi[i] - sky.ghi[i])).toBeLessThan(1e-3);
            }
        }
        for (const k of ['ghi', 'dni', 'dhi', 'F1', 'F2', 'tempC', 'windMs']) expect(allFinite(sky[k])).toBe(true);
    });

    it('interpolates temperature between slot midpoints', () => {
        const ds = dsOf(SUMMER);
        const t = 100;
        expect(skySummer.tempC[t * 3 + 1]).toBeCloseTo(ds.tempC[t], 5);
        expect(skySummer.tempC[t * 3]).toBeCloseTo(ds.tempC[t - 1] + (ds.tempC[t] - ds.tempC[t - 1]) * (2 / 3), 4);
        expect(skySummer.tempC[t * 3 + 2]).toBeCloseTo(ds.tempC[t] + (ds.tempC[t + 1] - ds.tempC[t]) / 3, 4);
    });

    it('monthScale of ones is bit-identical to actual weather; other factors scale GHI/DHI/DNI', () => {
        const ds = dsOf(SUMMER);
        const ones = prepareSky(ds, g, { monthScale: new Float64Array(12).fill(1) });
        expect(ones.scaleKey).toBe('actual');
        for (const k of ['ghi', 'dni', 'dhi', 'F1', 'F2', 'tempC']) expect(ones[k]).toEqual(skySummer[k]);
        const f = new Float64Array(12).fill(1); f[5] = 1.3; // June
        const s13 = prepareSky(ds, g, { monthScale: f });
        expect(s13.scaleKey).not.toBe('actual');
        for (let i = 0; i < g.m; i += 7) {
            expect(s13.ghi[i]).toBeCloseTo(skySummer.ghi[i] * 1.3, 2);
            expect(s13.dhi[i]).toBeCloseTo(skySummer.dhi[i] * 1.3, 2);
            expect(s13.dni[i]).toBeCloseTo(skySummer.dni[i] * 1.3, 2);
        }
    });

    it('rejects a dataset that does not match the geometry', () => {
        expect(() => prepareSky({ ...dsOf(SUMMER), start: SUMMER.start + SLOT_MS }, g)).toThrow(RangeError);
    });
});

describe('port fidelity: per-slot AC/DC vs the research reference chain', () => {
    for (const slice of GOLD.slices) {
        const sky = slice === SUMMER ? skySummer : prepareSky(dsOf(slice), geomOf(slice));
        for (const [name, arrays] of Object.entries(GOLD.configs)) {
            it(`${slice.name} ${name}: relative error ≤ 1e-5 per slot`, () => {
                const arr = arrays.map((a) => ({ ...GOLD.arrayDefaults, ...a }));
                const { pv } = simulatePv(sky, arr, GOLD.inverter);
                const gold = slice.golden[name];
                for (let t = 0; t < slice.n; t++) {
                    const ac = pv.acKwh[t] * 1000, dc = pv.dcRawKwh[t] * 1000;
                    expect(Math.abs(ac - gold.acWh[t])).toBeLessThanOrEqual(1e-5 * Math.abs(gold.acWh[t]) + 1e-6);
                    expect(Math.abs(dc - gold.dcWh[t])).toBeLessThanOrEqual(1e-5 * Math.abs(gold.dcWh[t]) + 1e-6);
                }
                expect(Math.abs(sum(pv.acKwh) * 1000 / sum(gold.acWh) - 1)).toBeLessThan(1e-6);
            });
        }
    }
});

describe('inverterAc semantics', () => {
    const big = [{ ...T3, tilt: 35, azimuth: 180, wp: 600, input: 0 }, { ...T3, tilt: 35, azimuth: 180, wp: 600, input: 1 }];
    const cases = {
        'T3 S45 2×400': { arrays: [{ ...T3, tilt: 45, azimuth: 180, input: 0 }, { ...T3, tilt: 45, azimuth: 180, input: 1 }], inv: INV },
        '2×600 Wp, 800 W AC cap only': { arrays: big, inv: { acLimitW: 800, etaNom: 0.96, inputs: [{}, {}] } },
        '2×600 Wp, 400 W per input': { arrays: big, inv: INV },
        'standby 2 W': { arrays: [{ ...T3, tilt: 90, azimuth: 270, input: 0 }], inv: { ...INV, standbyW: 2 } },
    };
    for (const [name, c] of Object.entries(cases)) {
        it(`${name}: AC ≤ cap, dcRaw = dcInv + clippedDc, zero at night, no NaN`, () => {
            const { pv } = simulatePv(skySummer, c.arrays, c.inv);
            const capKwh = (c.inv.acLimitW * 0.5) / 1000;
            for (let t = 0; t < SUMMER.n; t++) {
                expect(pv.acKwh[t]).toBeGreaterThanOrEqual(0);
                expect(pv.acKwh[t]).toBeLessThanOrEqual(capKwh + 1e-12);
                expect(Math.abs(pv.dcRawKwh[t] - pv.dcInvKwh[t] - pv.clippedDcKwh[t])).toBeLessThan(1e-12);
                expect(pv.clippedDcKwh[t]).toBeGreaterThanOrEqual(-1e-15);
                expect(Math.abs(pv.etaPv[t] * pv.dcInvKwh[t] - pv.acKwh[t])).toBeLessThan(1e-12);
                expect(pv.etaPv[t]).toBeGreaterThanOrEqual(0);
                expect(pv.etaPv[t]).toBeLessThanOrEqual(1);
                const night = SUMMER.ghi[t] === 0;
                if (night) {
                    expect(pv.acKwh[t]).toBe(0);
                    expect(pv.dcRawKwh[t]).toBe(0);
                    expect(pv.etaPv[t]).toBe(c.inv.etaNom);
                    expect(pv.standbyKwh[t]).toBeCloseTo(((c.inv.standbyW ?? 0) * 0.5) / 1000, 15);
                }
            }
            for (const k of Object.keys(pv)) expect(allFinite(pv[k])).toBe(true);
        });
    }

    it('clips at the AC limit through pdcAtCap and at per-input caps', () => {
        const ac = simulatePv(skySummer, big, cases['2×600 Wp, 800 W AC cap only'].inv).pv;
        const per = simulatePv(skySummer, big, INV).pv;
        const pdcCap = pdcAtAcLimit(800, 0.96);
        expect(Math.max(...ac.acKwh)).toBeCloseTo(0.4, 6);
        expect(Math.max(...ac.dcInvKwh)).toBeLessThanOrEqual((pdcCap * 0.5) / 1000 + 1e-12);
        expect(sum(ac.clippedDcKwh)).toBeGreaterThan(1);
        expect(Math.max(...per.dcInvKwh)).toBeLessThanOrEqual((2 * (400 / 0.96) * 0.5) / 1000 + 1e-12);
        // per-input AC caps never produce more than the shared cap alone
        expect(sum(per.acKwh)).toBeLessThanOrEqual(sum(ac.acKwh) + 1e-9);
    });

    it('does not net standby into AC', () => {
        const { pv } = simulatePv(skySummer, cases['standby 2 W'].arrays, cases['standby 2 W'].inv);
        const { pv: p0 } = simulatePv(skySummer, cases['standby 2 W'].arrays, INV);
        expect(pv.acKwh).toEqual(p0.acKwh);
        expect(sum(pv.standbyKwh)).toBeGreaterThan(0);
        expect(sum(p0.standbyKwh)).toBe(0);
    });

    it('groups arrays by input and rejects unknown inputs', () => {
        const a = [{ ...T3, tilt: 45, azimuth: 180, input: 0 }, { ...T3, tilt: 45, azimuth: 270, input: 0 }];
        const dc = a.map((x) => arrayDcW(skySummer, x));
        const grouped = dcByInput(skySummer.geom, a, dc, INV);
        expect(grouped.length).toBe(2);
        expect(grouped[0][500]).toBeCloseTo(dc[0][500] + dc[1][500], 3);
        expect(sum(grouped[1])).toBe(0);
        expect(dc[0][500]).toBe(arrayDcW(skySummer, a[0])[500]); // inputs are not mutated
        expect(() => dcByInput(skySummer.geom, [{ input: 2 }], [dc[0]], INV)).toThrow(RangeError);
        expect(() => inverterAc(skySummer.geom, [dc[0], dc[1], dc[0]], INV)).toThrow(RangeError);
    });

    it('works with a missing inverter description (800 W, ηnom 0.96, one input)', () => {
        const dc = arrayDcW(skySummer, { ...T3, tilt: 35, azimuth: 180, count: 2 });
        const a = inverterAc(skySummer.geom, [dc], null);
        const b = inverterAc(skySummer.geom, [dc], { acLimitW: 800, etaNom: 0.96, inputs: [{}] });
        expect(a.acKwh).toEqual(b.acKwh);
    });
});

describe('arrays: shading, keys and options', () => {
    const base = { ...T3, tilt: 90, azimuth: 250, count: 2 };
    const horizon = new Array(36).fill(10);

    it('drops the lumped shading default once a horizon profile is given (no double count)', () => {
        const withH3 = arrayDcW(skySummer, { ...base, horizon, shadingPct: 3 });
        const withH0 = arrayDcW(skySummer, { ...base, horizon, shadingPct: 0 });
        expect(withH3).toEqual(withH0);
        expect(effectiveShadingPct({ ...base, horizon, shadingPct: 3 })).toBe(0);
        expect(effectiveShadingPct({ ...base, beamShadingPct: 5, shadingPct: 3 })).toBe(0);
        expect(effectiveShadingPct({ ...base, shadingPct: 3 })).toBe(3);
        expect(effectiveShadingPct({ ...base, horizon, shadingPct: 3, shadingExplicit: true })).toBe(3);
        expect(effectiveShadingPct({ tilt: 30 })).toBe(3); // contract default
    });

    it('applies lumped shading as a plain DC factor and the horizon as a real loss', () => {
        const s0 = arrayDcW(skySummer, { ...base, shadingPct: 0 });
        const s3 = arrayDcW(skySummer, { ...base, shadingPct: 3 });
        expect(sum(s3) / sum(s0)).toBeCloseTo(0.97, 6);
        const h = arrayDcW(skySummer, { ...base, horizon, shadingPct: 0 });
        expect(sum(h)).toBeLessThan(sum(s0));
        expect(sum(h)).toBeGreaterThan(0.5 * sum(s0));
    });

    it('arrayKey covers every DC field and ignores identity/wiring', () => {
        const a = { id: 'a', name: 'West wall', input: 0, ...base };
        expect(arrayKey({ ...a, id: 'b', name: 'other', input: 1 })).toBe(arrayKey(a));
        expect(arrayKey({ tilt: 35 })).toBe(arrayKey({ tilt: 35, albedo: 0.2, mounting: 'open', lowLightK: 0.0064 }));
        for (const [k, v] of [['tilt', 80], ['azimuth', 260], ['count', 3], ['wp', 450], ['mounting', 'wall'], ['albedo', 0.3],
            ['tempCoeffPct', -0.35], ['dcModel', 'huld2025'], ['lowLightK', 0.01], ['bifaciality', 0.7], ['shadingPct', 5],
            ['beamShadingPct', 2], ['diffuseShadingPct', 2], ['horizon', [5, 5, 5, 5]], ['groundSelfShade', true]]) {
            expect(arrayKey({ ...a, [k]: v })).not.toBe(arrayKey(a));
        }
    });

    it('wall/railing default to ground self-shade and their own Faiman presets', () => {
        const open = arrayDcW(skySummer, { ...base, mounting: 'open' });
        const wall = arrayDcW(skySummer, { ...base, mounting: 'wall' });
        const wallNoGss = arrayDcW(skySummer, { ...base, mounting: 'wall', groundSelfShade: false });
        expect(sum(wall)).toBeLessThan(sum(wallNoGss));
        expect(sum(wallNoGss)).toBeLessThan(sum(open)); // hotter module
    });

    it('bifacial adds rear gain; Huld 2025 and PVWatts agree within a few percent', () => {
        // a vertical panel's rear faces the morning sun in summer, so its gain is large (the
        // research reference gives +42% a year for W90 at φ 0.8, rear shading 0.6); tilted is small
        const mono = arrayDcW(skySummer, base);
        const bif = arrayDcW(skySummer, { ...base, bifaciality: 0.7 });
        expect(sum(bif) / sum(mono)).toBeGreaterThan(1.05);
        expect(sum(bif) / sum(mono)).toBeLessThan(1.6);
        const tilted = { ...base, tilt: 35, azimuth: 180 };
        const gain = sum(arrayDcW(skySummer, { ...tilted, bifaciality: 0.7 })) / sum(arrayDcW(skySummer, tilted));
        expect(gain).toBeGreaterThan(1.005);
        expect(gain).toBeLessThan(1.1);
        const huld = arrayDcW(skySummer, { ...base, dcModel: 'huld2025' });
        expect(Math.abs(sum(huld) / sum(mono) - 1)).toBeLessThan(0.05);
    });

    it('reads numeric strings (form fields) as numbers rather than silently using defaults', () => {
        const a = arrayDcW(skySummer, { ...T3, tilt: 60, azimuth: 200, count: 2 });
        const b = arrayDcW(skySummer, { ...T3, tilt: '60', azimuth: '200', count: '2' });
        expect(b).toEqual(a);
        expect(arrayKey({ ...T3, tilt: '60' })).toBe(arrayKey({ ...T3, tilt: 60 }));
    });

    it('never yields NaN for odd but valid configurations', () => {
        const odd = [
            { tilt: 0, azimuth: 0 }, { tilt: 90, azimuth: 0, bifaciality: 1, rearShading: 0 },
            { tilt: 15, azimuth: 359.9, transposition: 'haydavies', horizon: [80, 0, 80, 0] },
            { tilt: 60, azimuth: 90, transposition: 'isotropic', bifaciality: 0.5, horizon: new Array(72).fill(30) },
            { tilt: 35, azimuth: 180, count: 0 }, { tilt: 35, azimuth: 180, wp: -5 }, { tilt: 'x', azimuth: null, albedo: NaN },
        ];
        for (const a of odd) {
            const dc = arrayDcW(skySummer, a);
            expect(allFinite(dc)).toBe(true);
            expect(Math.min(...dc)).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('slot helpers', () => {
    const dc = arrayDcW(skySummer, { ...T3, tilt: 35, azimuth: 180, count: 2, wp: 500 });

    it('dcToSlotsKwh averages sub-samples and applies a per-sub-sample cap', () => {
        const all = dcToSlotsKwh(skySummer.geom, dc);
        expect(sum(all)).toBeCloseTo((sum(dc) * 0.5) / 1000 / 3, 9);
        const capped = dcToSlotsKwh(skySummer.geom, dc, 300);
        expect(Math.max(...capped)).toBeLessThanOrEqual(0.15 + 1e-12);
        expect(sum(capped)).toBeLessThan(sum(all));
    });

    it('scaleDcByMonth multiplies by the local month factor', () => {
        const f = new Float64Array(12).fill(1); f[5] = 0.8;
        const s = scaleDcByMonth(skySummer.geom, dc, f);
        for (let i = 0; i < dc.length; i += 11) expect(s[i]).toBeCloseTo(dc[i] * 0.8, 3);
        expect(scaleDcByMonth(skySummer.geom, dc, new Float64Array(12).fill(1))).toEqual(dc);
        // a negative or missing factor can never make DC negative
        const neg = new Float64Array(12).fill(1); neg[5] = -2;
        expect(Math.min(...scaleDcByMonth(skySummer.geom, dc, neg))).toBe(0);
        expect(scaleDcByMonth(skySummer.geom, dc, null)).toEqual(dc);
    });

    it('dcToSlotsKwh ignores NaN/negative sub-samples instead of turning them into the cap', () => {
        const g = skySummer.geom;
        const bad = Float32Array.from(dc);
        bad[3 * 100] = NaN; bad[3 * 100 + 1] = -50;
        const capped = dcToSlotsKwh(g, bad, 300);
        expect(allFinite(capped)).toBe(true);
        expect(capped[100]).toBeCloseTo((Math.min(dc[3 * 100 + 2], 300) * 0.5) / 1000 / 3, 9);
        expect(sum(dcToSlotsKwh(g, dc, NaN))).toBeCloseTo(sum(dcToSlotsKwh(g, dc)), 9); // NaN cap = no cap
    });

    it('runs a synthetic year fast enough for the worker', () => {
        const start = Date.parse('2025-10-01T00:00:00Z'), n = 17_520;
        const g = prepareGeometry({ start, n, lat: 53.48, lon: -2.24, altitude: 40 }, { subSteps: 3 });
        const ghi = new Float32Array(n), dhi = new Float32Array(n);
        for (let t = 0; t < n; t++) { const c = Math.max(0, g.cosZ[t * 3 + 1]); ghi[t] = 700 * c; dhi[t] = 0.5 * ghi[t]; }
        const ds = { start, n, ghi, dhi, dni: new Float32Array(n), tempC: new Float32Array(n).fill(11), windMs: new Float32Array(n).fill(3) };
        const sky = prepareSky(ds, g);
        const t0 = performance.now();
        const { pv } = simulatePv(sky, [{ ...T3, tilt: 35, azimuth: 180, input: 0 }, { ...T3, tilt: 90, azimuth: 270, input: 1 }], INV);
        const ms = performance.now() - t0;
        expect(ms).toBeLessThan(400);
        expect(allFinite(pv.acKwh)).toBe(true);
        expect(sum(pv.acKwh)).toBeGreaterThan(300);
    });
});

describe('full demo year (data/demo.json) — engine-critique T3 and UX acceptance (2)', () => {
    // the shipped demo year: London, 1 Oct 2025 00:00 BST + 17 520 slots, prices joined by epoch
    const D = JSON.parse(fs.readFileSync(new URL('../../../projects/solar-calculator/data/demo.json', import.meta.url), 'utf8'));
    const ds = {
        start: D.start, n: D.n, ghi: Float32Array.from(D.ghi), dni: Float32Array.from(D.dni), dhi: Float32Array.from(D.dhi),
        tempC: Float32Array.from(D.tempC), windMs: Float32Array.from(D.windMs),
    };
    // default Linke for London must be the pvlib monthly table T3 was computed with
    const geom = prepareGeometry({ start: D.start, n: D.n, lat: D.lat, lon: D.lon, altitude: D.altitude }, { subSteps: 3 });
    const sky = prepareSky(ds, geom);
    const billed = withVat(Float64Array.from(D.importExc), D.start); // as billed: 5% VAT all year
    const local = buildLocalIndex(D.start, D.n);
    const arr = (tilt, azimuth, input, wp = 400) => ({ ...T3, count: 1, wp, tilt, azimuth, input });

    it('uses the London monthly Linke table by default', () => {
        const explicit = prepareGeometry({ start: D.start, n: D.n, lat: D.lat, lon: D.lon, altitude: D.altitude },
            { subSteps: 3, linke: [3.35, 4.35, 3.95, 3.65, 4.6, 4.95, 4.4, 4.3, 3.85, 3.45, 3.1, 3.15] });
        expect(explicit).toBe(geom);
    });

    // T3: 2 × 400 Wp (or 2 × 500), losses 5.86%, no shading, k 0.007, γ −0.3%/K, Faiman open, Perez,
    // MR 0.16, albedo 0.2, altitude 16, 2 × 400 W per-input AC caps, 800 W, ηnom 0.96, 3 sub-steps,
    // everything self-consumed (2 kW load) and valued as billed. ±0.2% on kWh and £, ±0.3 kWh on 16–19.
    const T3ROWS = [
        ['S45', [arr(45, 180, 0), arr(45, 180, 1)], 959.5, 161.45, 104.2],
        ['az210 t45', [arr(45, 210, 0), arr(45, 210, 1)], 926.3, 165.43, 159.9],
        ['SW45', [arr(45, 225, 0), arr(45, 225, 1)], 888.9, 163.90, 179.9],
        ['W45', [arr(45, 270, 0), arr(45, 270, 1)], 714.1, 143.49, 198.6],
        ['S90', [arr(90, 180, 0), arr(90, 180, 1)], 672.9, 111.89, 54.7],
        ['W90', [arr(90, 270, 0), arr(90, 270, 1)], 506.2, 113.95, 183.5],
        ['E90+W90', [arr(90, 90, 0), arr(90, 270, 1)], 513.1, 103.58, 106.9],
        ['S35 2×500', [arr(35, 180, 0, 500), arr(35, 180, 1, 500)], 1198.4, 203.37, null],
    ];
    for (const [name, arrays, kwhExp, gbpExp, peakExp] of T3ROWS) {
        it(`T3 ${name}: ${kwhExp} kWh, £${gbpExp} as billed${peakExp == null ? '' : `, ${peakExp} kWh in 16–19`}`, () => {
            const { pv } = simulatePv(sky, arrays, INV);
            let kwh = 0, gbp = 0, peak = 0, clip = 0;
            for (let t = 0; t < D.n; t++) {
                kwh += pv.acKwh[t];
                gbp += (pv.acKwh[t] * billed[t]) / 100;
                if (local.peak[t]) peak += pv.acKwh[t];
                clip += pv.clippedDcKwh[t];
            }
            expect(Math.abs(kwh / kwhExp - 1)).toBeLessThan(0.002);
            expect(Math.abs(gbp / gbpExp - 1)).toBeLessThan(0.002);
            if (peakExp != null) expect(Math.abs(peak - peakExp)).toBeLessThan(0.3);
            // clipping is reported in DC units (engine critique); T3's 7.8 kWh rounds the same energy
            if (name === 'S35 2×500') expect(Math.abs(clip - 7.8)).toBeLessThan(0.1);
            else expect(clip).toBe(0);
        });
    }

    it('T3 answers the user’s question: south beats west-vertical on £, west wins the 16–19 window and p/kWh', () => {
        const run = (arrays) => {
            const { acKwh } = simulatePv(sky, arrays, INV).pv;
            let kwh = 0, p = 0, peak = 0;
            for (let t = 0; t < D.n; t++) { kwh += acKwh[t]; p += acKwh[t] * billed[t]; if (local.peak[t]) peak += acKwh[t]; }
            return { kwh, p, peak };
        };
        const s45 = run(T3ROWS[0][1]), w90 = run(T3ROWS[5][1]);
        expect(s45.p).toBeGreaterThan(1.3 * w90.p);           // £161 vs £114
        expect(w90.peak).toBeGreaterThan(1.7 * s45.peak);     // 183 vs 104 kWh in 16–19
        expect(w90.p / w90.kwh).toBeGreaterThan(1.3 * (s45.p / s45.kwh)); // ~22.5p vs ~16.8p per kWh
    });

    it('UX acceptance (2): DC-level and irradiance-level month scaling differ by < 1.5% a year (S35, W90; ×0.7, ×1.3)', () => {
        for (const [tilt, az] of [[35, 180], [90, 270]]) {
            const arrays = [arr(tilt, az, 0), arr(tilt, az, 1)];
            const base = simulatePv(sky, arrays, INV).dc;
            for (const k of [0.7, 1.3]) {
                const f = new Float64Array(12).fill(k);
                const irr = sum(simulatePv(prepareSky(ds, geom, { monthScale: f }), arrays, INV).pv.acKwh);
                const scaled = base.map((d) => scaleDcByMonth(geom, d, f));
                const dcl = sum(inverterAc(geom, dcByInput(geom, arrays, scaled, INV), INV).acKwh);
                expect(Math.abs(dcl / irr - 1)).toBeLessThan(0.015);
            }
        }
    });

    it('UX acceptance (1): factors of 1 give the actual-weather result bit for bit', () => {
        const arrays = T3ROWS[5][1];
        const ones = prepareSky(ds, geom, { monthScale: new Float64Array(12).fill(1) });
        expect(simulatePv(ones, arrays, INV).pv.acKwh).toEqual(simulatePv(sky, arrays, INV).pv.acKwh);
    });
});
