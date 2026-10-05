import { describe, it, expect } from 'vitest';
import { normalizeSystem, systemKey, capexGbp, upgradedSystem, DEFAULTS } from '../../../projects/solar-calculator/js/system.js';

describe('normalizeSystem', () => {
    it('fills every default from an empty object', () => {
        const s = normalizeSystem({});
        expect(s).toMatchObject({ id: 'custom', route: 'plugin', arrays: [], inverter: null, battery: null, export: { kind: 'none', flatP: 0 },
            canCurtail: false, loadAdjustW: 0, costs: [], upgrade: null, featured: false, notes: [] });
    });
    it('is idempotent and never throws on garbage', () => {
        const partial = { arrays: [{ count: '2', wp: 460, azimuth: -90, tilt: 120, mounting: 'balcony', horizon: [5, 'x', 100] }], battery: { coupling: 'ups', capacityKwh: -1, strategy: 'yolo' }, costs: [{ gbp: '650' }, null] };
        const a = normalizeSystem(partial);
        expect(normalizeSystem(a)).toEqual(a);
        for (const junk of [null, undefined, 42, 'x', [], { arrays: 'no', battery: 7, export: null, costs: {} }]) expect(() => normalizeSystem(junk)).not.toThrow();
        expect(a.arrays[0]).toMatchObject({ count: 2, azimuth: 270, tilt: 90, mounting: 'open', horizon: [5, 0, 90] });
        expect(a.battery).toMatchObject({ capacityKwh: 0, strategy: 'threshold', coupling: 'ups' });
        expect(a.costs).toEqual([{ label: 'Cost', gbp: 650, year: 0, kind: 'hardware' }, { label: 'Cost', gbp: 0, year: 0, kind: 'hardware' }]);
    });
    it('array defaults follow the contract and groundSelfShade defaults by mounting', () => {
        const s = normalizeSystem({ arrays: [{}, { mounting: 'wall' }, { mounting: 'railing' }] });
        const a = s.arrays[0];
        for (const k of ['albedo', 'tempCoeffPct', 'dcModel', 'lowLightK', 'bifaciality', 'rearShading', 'shadingPct']) expect(a[k]).toEqual(DEFAULTS.array[k]);
        expect(a.groundSelfShade).toBe(false);
        expect(s.arrays[1].groundSelfShade).toBe(true);
        expect(s.arrays[2].groundSelfShade).toBe(true);
        expect(s.arrays.map((x) => x.id)).toEqual(['a0', 'a1', 'a2']);
    });
    it('drops the 3% lumped shading when shading is described explicitly (no double count)', () => {
        const s = normalizeSystem({ arrays: [{ horizon: Array(36).fill(10) }, { beamShadingPct: 5 }, { horizon: [10], shadingPct: 3 }, {}] });
        expect(s.arrays.map((a) => a.shadingPct)).toEqual([0, 0, 3, 3]);
        expect(s.arrays.every((a) => a.shadingExplicit === false)).toBe(true);
        const o = normalizeSystem({ arrays: [{ horizon: [10], shadingExplicit: true }] }).arrays[0];
        expect(o).toMatchObject({ shadingPct: 3, shadingExplicit: true });
    });
    it('keeps pv.js physics overrides (transposition, iamAr, faiman) and drops invalid ones', () => {
        const [a, b] = normalizeSystem({ arrays: [{ transposition: 'haydavies', iamAr: 0.2, faiman: [25, 5], dcModel: 'huld' }, { transposition: 'magic', faiman: [1] }] }).arrays;
        expect(a).toMatchObject({ transposition: 'haydavies', iamAr: 0.2, faiman: [25, 5], dcModel: 'huld' });
        expect('transposition' in b || 'faiman' in b || 'iamAr' in b).toBe(false);
    });
    it('creates the default dual-input 800 W micro for arrays, extends it for more inputs, clamps to explicit inputs', () => {
        expect(normalizeSystem({ arrays: [{}] }).inverter).toEqual({ acLimitW: 800, etaNom: 0.96, inputs: [{ maxDcW: 1000, maxAcW: 400 }, { maxDcW: 1000, maxAcW: 400 }], standbyW: 0, supportsPowerLimit: false });
        expect(normalizeSystem({ arrays: [{ input: 3 }] }).inverter.inputs.length).toBe(4);
        const s = normalizeSystem({ arrays: [{ input: 3 }], inverter: { acLimitW: 800, inputs: [{ maxDcW: 2000, maxAcW: 800 }] } });
        expect(s.arrays[0].input).toBe(0);
        const custom = normalizeSystem({ arrays: [{}, { input: 1 }], inverter: { acLimitW: 2400 } });
        expect(custom.inverter.inputs).toEqual([{ maxDcW: 2400, maxAcW: 2400 }, { maxDcW: 2400, maxAcW: 2400 }]);
    });
    it('a dc-coupled battery always gets an inverter; ac and ups batteries without arrays do not', () => {
        expect(normalizeSystem({ battery: { coupling: 'dc' } }).inverter).not.toBeNull();
        expect(normalizeSystem({ battery: { coupling: 'ac' } }).inverter).toBeNull();
        expect(normalizeSystem({ battery: { coupling: 'ups' } }).inverter).toBeNull();
    });
    it('battery defaults (capacity semantics, strategy, schedule) and the ups block', () => {
        const b = normalizeSystem({ battery: {} }).battery;
        expect(b).toMatchObject({ coupling: 'dc', minSocPct: 10, effCharge: 0.96, effDischarge: 0.96, acChargeEff: 0.93, standbyW: 10,
            allowGridExport: false, strategy: 'threshold', replanAt: '16:00', wearPPerKwh: 2, deltaKwh: 0.025, pvForecast: 'persistence', ups: null,
            schedule: { chargeBelowP: null, chargeWindow: ['00:00', '06:00'], dischargeWindow: ['16:00', '19:00'] } });
        const u = normalizeSystem({ battery: { coupling: 'ups', acOutputW: 1800, capacityKwh: 1 } }).battery.ups;
        expect(u).toMatchObject({ dedicatedW: 'baseload', outletMaxW: 1800, etaInv: 0.94, chargeEff: 0.88, fixedLossW: null, bypassW: 8, bypass: 'auto', pvArrays: [] });
        expect(normalizeSystem({ battery: { coupling: 'ups', ups: { dedicatedW: 350, fixedLossW: 11 } } }).battery.ups).toMatchObject({ dedicatedW: 350, fixedLossW: 11 });
        expect(normalizeSystem({ battery: { strategy: 'online' } }).battery.strategy).toBe('online');
        expect(normalizeSystem({ battery: { schedule: { chargeWindow: ['25:00', '06:30'] } } }).battery.schedule.chargeWindow).toEqual(['00:00', '06:30']);
    });
    it('export kinds and route are validated', () => {
        const s = normalizeSystem({ route: 'ups', export: { kind: 'prime' } });
        expect(s.route).toBe('ups');
        expect(normalizeSystem({ route: 'moon', export: { kind: 'free' } })).toMatchObject({ route: 'plugin', export: { kind: 'none' } });
        expect(normalizeSystem({ export: { kind: 'flat', flatP: 15 } }).export).toEqual({ kind: 'flat', flatP: 15 });
    });
});

describe('systemKey', () => {
    const base = { id: 'S01', name: 'Octopus 2×460', featured: true, notes: ['x'], arrays: [{ count: 2, wp: 460 }], costs: [{ gbp: 650 }], export: { kind: 'prime' } };
    it('ignores id/name/featured/notes and key order', () => {
        const a = systemKey(base);
        const b = systemKey({ notes: [], featured: false, name: 'Other', id: 'S99', export: { kind: 'prime' }, costs: [{ gbp: 650 }], arrays: [{ wp: 460, count: 2 }] });
        expect(a).toBe(b);
    });
    it('changes with anything that changes the simulation or finance', () => {
        const a = systemKey(base);
        expect(systemKey({ ...base, arrays: [{ count: 2, wp: 460, azimuth: 200 }] })).not.toBe(a);
        expect(systemKey({ ...base, export: { kind: 'none' } })).not.toBe(a);
        expect(systemKey({ ...base, costs: [{ gbp: 651 }] })).not.toBe(a);
        expect(systemKey({ ...base, battery: {} })).not.toBe(a);
    });
});

describe('capexGbp and upgrades', () => {
    const sys = {
        costs: [{ gbp: 650 }, { gbp: 350, kind: 'install' }, { gbp: 150, year: 12 }],
        battery: null,
        arrays: [{ count: 2, wp: 460 }],
        upgrade: { atYear: 2, label: 'Plug-in battery', battery: { coupling: 'ac', capacityKwh: 1.92 }, costs: [{ gbp: 1049.99 }] },
    };
    it('sums the cost items of a year (upgrade costs land in atYear)', () => {
        expect(capexGbp(sys)).toBe(1000);
        expect(capexGbp(sys, { year: 12 })).toBe(150);
        expect(capexGbp(sys, { year: 2 })).toBeCloseTo(1049.99, 9);
    });
    it('upgrade cost items are relative to atYear, as finance.project books them', () => {
        const s = { ...sys, upgrade: { ...sys.upgrade, costs: [{ gbp: 1000 }, { gbp: 350, year: 1, kind: 'install' }] } };
        expect(capexGbp(s, { year: 2 })).toBe(1000);
        expect(capexGbp(s, { year: 3 })).toBe(350);
    });
    it('upgradedSystem merges the upgrade into a stage-2 system', () => {
        const s2 = upgradedSystem(sys);
        expect(s2.upgrade).toBeNull();
        expect(s2.battery).toMatchObject({ coupling: 'ac', capacityKwh: 1.92 });
        expect(s2.arrays.length).toBe(1);
        expect(upgradedSystem({ arrays: [] })).toBeNull();
        const more = upgradedSystem({ arrays: [{ id: 'p' }], upgrade: { atYear: 1, addArrays: [{ id: 'p', azimuth: 270 }], route: 'hardwired' } });
        expect(more.arrays.map((a) => a.id)).toEqual(['p', 'p-u0']);
        expect(more.route).toBe('hardwired');
    });
});
