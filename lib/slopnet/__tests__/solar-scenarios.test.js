import { describe, it, expect } from 'vitest';
import { autoScenarios, DEFAULT_SPOTS, normalizeSpot } from '../../../projects/solar-calculator/js/scenarios.js';
import { normalizeCatalog } from '../../../projects/solar-calculator/js/kits.js';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';
import { capexGbp } from '../../../projects/solar-calculator/js/system.js';
import { validate } from '../../../projects/solar-calculator/js/rules.js';
import { loadCatalog, rawCatalog, sliceDemo, NOW } from './fixtures/solar/b1-load.js';

const ds = sliceDemo('2026-04-30T23:00:00Z', 92);
const cat = loadCatalog();
const eng = new SolarEngine(ds, cat, { nowMs: NOW });
const list = eng.autoScenarios();
const byId = (id) => list.find((s) => s.id === id);

describe('DEFAULT_SPOTS and normalizeSpot', () => {
    it('ground frame (free direction, 15–45°) and a vertical west wall', () => {
        expect(DEFAULT_SPOTS.map((s) => [s.id, s.kind, s.azimuth, s.tilt, s.tiltRange])).toEqual([
            ['ground', 'ground', null, null, [15, 45]], ['west-wall', 'wall', 270, 90, [90, 90]]]);
        expect(Object.isFrozen(DEFAULT_SPOTS)).toBe(true);
    });
    it('fills defaults by kind', () => {
        expect(normalizeSpot({ kind: 'railing', azimuth: 200 })).toMatchObject({ kind: 'railing', azimuth: 200, tilt: null, tiltRange: [60, 90], maxPanels: 4, shadingPct: 3, groundLevel: true });
        expect(normalizeSpot({ kind: 'wall', azimuth: -90, tilt: 60 })).toMatchObject({ azimuth: 270, tilt: 90, tiltRange: [90, 90] });
        expect(normalizeSpot({ kind: 'pitched', azimuth: 180, tilt: 30 }, 2)).toMatchObject({ id: 'spot3', tiltRange: [30, 30] });
        expect(normalizeSpot({ kind: 'nonsense', groundLevel: false })).toMatchObject({ kind: 'ground', groundLevel: false });
    });
});

describe('autoScenarios on the shipped catalog', () => {
    it('featured S01–S06, H1–H4, U1–U3, C1, W1–W3, R0, R1, then the leaderboard', () => {
        const featured = list.filter((s) => s.featured).map((s) => s.id);
        expect(featured).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'H1', 'H2', 'H3', 'H4', 'U1', 'U2', 'U3', 'C1', 'W1', 'W2', 'W3', 'R0', 'R1']);
        const leader = list.filter((s) => !s.featured).map((s) => s.id);
        expect(leader.slice(0, 7)).toEqual(['L-powerxpress-920-marstek', 'L-patiosun-duo', 'L-thunder-bolt-920', 'L-solarfy-duo-910',
            'L-ecoflow-stream-micro-2x500', 'L-ecoflow-stream-facade-2x400', 'L-ecoflow-stream-ultra-x+4x500']);
        // every in-stock power station not already featured (13 of the 18)
        expect(leader.filter((id) => cat.byId(id.slice(2))?.kind === 'power-station')).toHaveLength(13);
        expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
    });
    it('catalog prices (UX critique): S01 £650 … U3 £841.40, W1 £1,699.99', () => {
        const capex = Object.fromEntries(list.map((s) => [s.id, Math.round(capexGbp(s) * 100) / 100]));
        // the EcoFlow bundles ship without mounting: framed like H2/H3 (UX critique's £1,849 left the frames out)
        expect(capex).toMatchObject({ S01: 650, S02: 650, S03: 650, S04: 450, S05: 468, S06: 336, H1: 2012.2, H2: 1933.8, H3: 2533.8, H4: 1849,
            U1: 599, U2: 1299, U3: 841.4, W1: 1699.99, W2: 650, R0: 0, R1: 0, 'L-ecoflow-stream-micro-2x500': 899, 'L-ecoflow-stream-ultra-x+4x500': 2162.2 });
        expect(capexGbp(byId('W2'), { year: 1 })).toBe(1049.99);
        expect(capex.C1).toBeCloseTo(capex.U3 + capexGbp(list.find((s) => s.id === `L-${byId('C1').kitId}`) ?? { costs: byId('C1').costs.slice(0, 1) }), 2);
    });
    it('placement: free-direction kits face the swept best; S03 is a west wall; S02 splits one panel west', () => {
        const s01 = byId('S01');
        expect(s01.spotId).toBe('ground');
        expect(s01.arrays[0].azimuth).toBeGreaterThanOrEqual(150);
        expect(s01.arrays[0].azimuth).toBeLessThanOrEqual(240);
        expect(s01.arrays[0].tilt).toBeGreaterThanOrEqual(15);
        expect(s01.arrays[0].tilt).toBeLessThanOrEqual(45);
        expect(byId('S03').arrays.map((a) => [a.azimuth, a.tilt, a.mounting])).toEqual([[270, 90, 'wall'], [270, 90, 'wall']]);
        expect(byId('S02').arrays.map((a) => [a.azimuth, a.input])).toEqual([[s01.arrays[0].azimuth, 0], [270, 1]]);
        expect(byId('S02').arrays[1].tilt).toBe(s01.arrays[0].tilt);
        expect(byId('U3').battery.ups.pvArrays).toHaveLength(2);
    });
    it('routes, export defaults and what-if structure', () => {
        expect(byId('S01').export.kind).toBe('prime'); // demo data → Octopus kits get Prime
        for (const id of ['S05', 'S06', 'H1', 'H2', 'H3', 'H4', 'U1', 'L-powerxpress-920-marstek']) expect(byId(id).export.kind).toBe('none');
        expect(byId('H4').arrays).toEqual([]);
        expect(byId('W3')).toMatchObject({ route: 'whatif' });
        expect(byId('W3').inverter.acLimitW).toBe(1600);
        // two of the best kit: its inputs twice over, the second kit's panels on the second set
        const kitInputs = cat.byId(byId('W3').kitId).inputs.length;
        expect(byId('W3').inverter.inputs).toHaveLength(2 * kitInputs);
        expect(Math.max(...byId('W3').arrays.map((a) => a.input))).toBe(2 * kitInputs - 1);
        expect(byId('W2').upgrade).toMatchObject({ atYear: 1, route: 'whatif' });
        expect(byId('W2').upgrade.battery.coupling).toBe('ac');
        expect(byId('R1').loadAdjustW).toBe(-100);
        expect(byId('C1')).toMatchObject({ route: 'plugin' });
        expect(byId('C1').battery.coupling).toBe('ups');
    });
    it('rules: non-what-if rows have no errors; legal levels', () => {
        for (const s of list) {
            const r = validate(s, cat, { baseLoadW: 560, spots: DEFAULT_SPOTS });
            if (s.route !== 'whatif') expect(r.errors.map((e) => e.code), s.id).toEqual([]);
        }
        expect(validate(byId('C1'), cat).legal).toBe('check');
        expect(validate(byId('W1'), cat).legal).toBe('whatif');
        expect(validate(byId('L-ecoflow-stream-facade-2x400'), cat).warnings.map((w) => w.code)).toContain('NOT_ON_SALE');
    });
    it('is cached per spots and projected base load', () => {
        expect(eng.autoScenarios()).toBe(list);
        expect(() => structuredClone(list)).not.toThrow();
    });
});

describe('autoScenarios edge cases', () => {
    it('S02 is absent when the Octopus kit has a single input', () => {
        const raw = rawCatalog();
        const one = normalizeCatalog({ ...raw, kits: raw.kits.map((k) => (k.id === 'octopus-plugin-solar-2x460' ? { ...k, mppts: 1, pvInputs: [k.pvInputs[0]] } : k)) });
        const ids = autoScenarios(eng, one).map((s) => s.id);
        expect(ids).toContain('S01');
        expect(ids).not.toContain('S02');
    });
    it('a missing featured product is replaced by the nearest real one, with a note', () => {
        const raw = rawCatalog();
        const cut = normalizeCatalog({ ...raw, kits: raw.kits.filter((k) => k.id !== 'cityplumbing-dmegc-2x515-hiflow') });
        const out = autoScenarios(eng, cut);
        const s05 = out.find((s) => s.id === 'S05');
        expect(s05.kitId).toBe('patiosun-duo'); // the single-input kit nearest 1030 Wp (890 Wp)
        expect(s05.notes.join(' ')).toMatch(/Stands in for cityplumbing-dmegc-2x515-hiflow/);
        expect(out[0].notes.join(' ')).toMatch(/not in the catalog/);
    });
    it('user spots: a pitched roof is never used for plug-in kits; only spots big enough are used', () => {
        const spots = [
            { id: 'roof', name: 'Roof', kind: 'pitched', azimuth: 180, tilt: 35 },
            { id: 'balcony', name: 'Balcony', kind: 'railing', azimuth: 225, maxPanels: 2, groundLevel: false },
            { id: 'wall', name: 'East wall', kind: 'wall', azimuth: 90 },
        ];
        const out = autoScenarios(eng, cat, { spots });
        const s01 = out.find((s) => s.id === 'S01');
        expect(['balcony', 'wall']).toContain(s01.spotId);
        const h1 = out.find((s) => s.id === 'H1'); // 4 panels: not the balcony; hardwired may use the roof
        expect(h1.spotId).not.toBe('balcony');
        // a hardwired kit in the same size class as a plug-in kit still gets to rank the roof
        const roofOrNorth = autoScenarios(eng, cat, { spots: [spots[0], { id: 'north', name: 'North wall', kind: 'wall', azimuth: 0 }] });
        expect(roofOrNorth.find((s) => s.id === 'S05').spotId).toBe('north'); // plug-in: the roof is not allowed
        const micro = roofOrNorth.find((s) => s.id === 'L-ecoflow-stream-micro-2x500');
        expect(micro.spotId).toBe('roof');
        expect(micro.arrays[0]).toMatchObject({ azimuth: 180, tilt: 35, mounting: 'roof' });
        expect(out.find((s) => s.id === 'S03').arrays[0].azimuth).toBe(270); // the west-wall hypothesis is always shown
        if (s01.spotId === 'balcony') expect(validate(s01, cat, { spots: spots.map(normalizeSpot) }).warnings.map((w) => w.code)).toContain('ABOVE_GROUND');
    });
});
