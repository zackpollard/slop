import { describe, it, expect } from 'vitest';
import { validate, applyFix } from '../../../projects/solar-calculator/js/rules.js';
import { kitToSystem, stationToSystem } from '../../../projects/solar-calculator/js/kits.js';
import { normalizeSystem } from '../../../projects/solar-calculator/js/system.js';
import { loadCatalog } from './fixtures/solar/b1-load.js';

const cat = loadCatalog();
const SOUTH = { id: 'ground', kind: 'ground', azimuth: 180, tilt: 35 };
const octopus = () => kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, spot: SOUTH, dsSource: 'demo' });
const cityPlumbing = () => kitToSystem('cityplumbing-dmegc-2x515-hiflow', { catalog: cat, spot: SOUTH });
const codes = (r) => r.errors.map((e) => e.code);
const wcodes = (r) => r.warnings.map((e) => e.code);

/** Every fix of every error yields a system with no errors (UX critique acceptance). */
function expectEveryFixClean(sys, ctx = {}) {
    const r = validate(sys, cat, ctx);
    expect(r.errors.length).toBeGreaterThan(0);
    for (const e of r.errors) {
        expect(e.fixes.length, `${e.code} has fixes`).toBeGreaterThan(0);
        for (const f of e.fixes) {
            const fixed = applyFix(sys, f.action, cat);
            const after = validate(fixed, cat, ctx);
            expect(codes(after), `${e.code} → ${f.label}`).toEqual([]);
            expect(JSON.parse(JSON.stringify(f.action))).toEqual(f.action); // fixes are plain data
        }
    }
}

describe('UX critique rules acceptance', () => {
    it('a catalog kit as sold is legal with no issues', () => {
        const r = validate(octopus(), cat);
        expect(r).toMatchObject({ legal: 'ok', errors: [], banner: null });
        expect(r.warnings).toEqual([]);
    });
    it('Octopus 2×460 with a third panel → PLUGIN_KIT_ALTERED, and every fix clears it', () => {
        const s = octopus();
        s.arrays[0].count = 2;
        expect(codes(validate(s, cat))).toEqual(['PLUGIN_KIT_ALTERED']);
        expectEveryFixClean(s);
        const bigger = validate(s, cat).errors[0].fixes[0];
        expect(bigger.action).toEqual({ type: 'chooseKit', kitId: 'cityplumbing-dmegc-2x515-hiflow' });
        const swapped = octopus();
        swapped.arrays[1].wp = 500;
        expect(codes(validate(swapped, cat))).toEqual(['PLUGIN_KIT_ALTERED']);
    });
    it('City Plumbing 2×515 with one panel at 180° and one at 270° → PLUGIN_SINGLE_INPUT_MIXED', () => {
        const s = cityPlumbing();
        const split = { ...s, arrays: [{ ...s.arrays[0], id: 'a0', count: 1 }, { ...s.arrays[0], id: 'a1', count: 1, azimuth: 270 }] };
        const r = validate(split, cat);
        expect(codes(r)).toEqual(['PLUGIN_SINGLE_INPUT_MIXED']);
        expect(r.errors[0].message).toMatch(/one solar input/);
        expectEveryFixClean(split);
        // "choose a kit with two inputs" keeps the split, one direction per input
        const two = applyFix(split, r.errors[0].fixes.find((f) => f.action.type === 'chooseKit').action, cat);
        expect(two.kitId).toBe('octopus-plugin-solar-2x460');
        expect(two.arrays.map((a) => [a.azimuth, a.input])).toEqual([[180, 0], [270, 1]]);
    });
    it('the same split on Octopus 2×460 (one panel per input) is legal', () => {
        const s = octopus();
        s.arrays[1].azimuth = 270;
        expect(validate(s, cat)).toMatchObject({ legal: 'ok', errors: [] });
    });
    it('PLUGIN_BATTERY with fixes to wire it in or plan it under future rules', () => {
        const s = { ...octopus(), battery: { coupling: 'ac', capacityKwh: 1.92, acChargeW: 1000 } };
        const r = validate(s, cat);
        expect(codes(r)).toEqual(['PLUGIN_BATTERY']);
        expect(r.errors[0].fixes.map((f) => f.action)).toEqual([
            { type: 'setRoute', route: 'hardwired', addElectrician: true }, { type: 'setRoute', route: 'whatif' }]);
        expectEveryFixClean(s);
        const wired = applyFix(s, r.errors[0].fixes[0].action, cat);
        expect(wired.costs.some((c) => c.kind === 'install' && c.gbp === 350)).toBe(true);
        expect(wired.export.kind).toBe('none'); // Prime is for the plug-in kit only
        expect(validate(applyFix(s, r.errors[0].fixes[1].action, cat), cat)).toMatchObject({ legal: 'whatif', banner: expect.stringMatching(/Not legal in GB today/) });
    });
    it('PLUGIN_TWO_DEVICES (two kits on one plug-in system) → plan it under future rules', () => {
        const a = octopus();
        const two = { ...a, sourceIds: [...a.sourceIds, a.kitId], inverter: { ...a.inverter, acLimitW: 1600, inputs: [...a.inverter.inputs, ...a.inverter.inputs] },
            arrays: [...a.arrays, ...a.arrays.map((x, i) => ({ ...x, id: `b${i}`, input: x.input + 2 }))] };
        const r = validate(two, cat);
        expect(codes(r)).toEqual(expect.arrayContaining(['PLUGIN_TWO_DEVICES', 'PLUGIN_KIT_ALTERED', 'PLUGIN_AC_LIMIT']));
        const plan = applyFix(two, r.errors.find((e) => e.code === 'PLUGIN_TWO_DEVICES').fixes[0].action, cat);
        expect(validate(plan, cat)).toMatchObject({ legal: 'whatif', errors: [] });
    });
});

describe('plug-in warnings', () => {
    it('> 960 Wp advises an electrician check; Prime on a non-Octopus kit and SEG on plug-in are warned', () => {
        expect(wcodes(validate(cityPlumbing(), cat))).toEqual(['PLUGIN_DC_960']);
        const prime = { ...cityPlumbing(), export: { kind: 'prime' } };
        expect(wcodes(validate(prime, cat))).toContain('EXPORT_PRIME_NOT_OCTOPUS');
        const seg = { ...octopus(), export: { kind: 'fixed' } };
        expect(wcodes(validate(seg, cat))).toContain('EXPORT_SEG_PLUGIN');
        expect(codes(validate(prime, cat))).toEqual([]);
    });
    it('not on sale, above ground, unknown inputs with a split', () => {
        const facade = kitToSystem('ecoflow-stream-facade-2x400', { catalog: cat, spot: SOUTH });
        expect(wcodes(validate(facade, cat))).toContain('NOT_ON_SALE');
        const balcony = { ...octopus(), spotId: 'balcony' };
        expect(wcodes(validate(balcony, cat, { spots: [{ id: 'balcony', groundLevel: false }] }))).toContain('ABOVE_GROUND');
        const sf = kitToSystem('solarfy-duo-910', { catalog: cat, spot: SOUTH });
        const split = { ...sf, arrays: [{ ...sf.arrays[0], count: 1 }, { ...sf.arrays[0], id: 'a1', count: 1, azimuth: 270 }] };
        const r = validate(split, cat);
        expect(codes(r)).toEqual([]);
        expect(wcodes(r)).toContain('INPUTS_UNKNOWN_MIXED');
    });
    it('custom plug-in builds are "check"; a hardwired product on the plug-in route is an error', () => {
        const custom = normalizeSystem({ route: 'plugin', arrays: [{ count: 2, wp: 400 }] });
        expect(validate(custom, cat)).toMatchObject({ legal: 'check', errors: [] });
        const loose = { ...kitToSystem('ecoflow-stream-micro-2x500', { catalog: cat, spot: SOUTH }), route: 'plugin' };
        expect(codes(validate(loose, cat))).toEqual(['PLUGIN_NOT_REGISTERED']);
        expectEveryFixClean(loose);
    });
    it('a plug-in kit plus a socket-charged power station is legal "check", not a battery error', () => {
        const u3 = stationToSystem('ecoflow-delta-3-plus', { catalog: cat, panels: { count: 2, spot: SOUTH } });
        const c1 = { ...octopus(), battery: u3.battery };
        const r = validate(c1, cat);
        expect(r).toMatchObject({ legal: 'check', errors: [] });
        expect(wcodes(r)).toContain('UPS_WITH_PLUGIN');
    });
});

describe('power stations', () => {
    const u1 = () => stationToSystem('ecoflow-delta-3-plus', { catalog: cat });
    it('a station as built is legal', () => {
        expect(validate(u1(), cat, { baseLoadW: 500 })).toMatchObject({ legal: 'ok', errors: [] });
    });
    it("'fixed' and 'self' without own panels are errors, fixed by switching to automation", () => {
        const fixed = { ...u1(), battery: { ...u1().battery, strategy: 'fixed' } };
        expect(codes(validate(fixed, cat))).toEqual(['UPS_FIXED']);
        expectEveryFixClean(fixed);
        const self = { ...u1(), battery: { ...u1().battery, strategy: 'self' } };
        expect(codes(validate(self, cat))).toEqual(['UPS_SELF_NO_PV']);
        expectEveryFixClean(self);
        const withPv = stationToSystem('ecoflow-delta-3-plus', { catalog: cat, panels: { count: 1, spot: SOUTH }, strategy: 'self' });
        expect(codes(validate(withPv, cat))).toEqual([]);
    });
    it('a dedicated load above the outlets is an error (baseload resolved from the dataset)', () => {
        const big = { ...u1(), battery: { ...u1().battery, ups: { ...u1().battery.ups, dedicatedW: 2400 } } };
        expect(codes(validate(big, cat))).toEqual(['UPS_OVER_OUTLET']);
        expectEveryFixClean(big);
        expect(codes(validate(u1(), cat, { baseLoadW: 2000 }))).toEqual(['UPS_OVER_OUTLET']);
        expect(codes(validate(u1(), cat))).toEqual([]); // unknown base load: nothing to check
    });
    it('grid-tied panels on a power-station system are an error', () => {
        const s = { ...u1(), arrays: [{ count: 1, wp: 460 }] };
        expect(codes(validate(s, cat))).toContain('UPS_GRID_ARRAYS');
        expectEveryFixClean(s);
    });
    it("own panels beyond what the station's inputs can take are warned, with a fix that re-wires them", () => {
        const u3 = stationToSystem('ecoflow-delta-3-plus', { catalog: cat, panels: { count: 2, spot: SOUTH } });
        expect(wcodes(validate(u3, cat))).not.toContain('UPS_PV_WIRING');
        // three panels on a 2-input 11–60 V station: two in series would exceed 60 V Voc
        const over = { ...u3, battery: { ...u3.battery, ups: { ...u3.battery.ups, pvArrays: [{ ...u3.battery.ups.pvArrays[0], count: 3, input: 0 }] } } };
        const r = validate(over, cat);
        expect(codes(r)).toEqual([]);
        const w = r.warnings.find((x) => x.code === 'UPS_PV_WIRING');
        expect(w.message).toMatch(/only take 2 panels/);
        const fixed = applyFix(over, w.fixes[0].action, cat);
        expect(fixed.battery.ups.pvArrays.map((a) => [a.count, a.input])).toEqual([[1, 0], [1, 1]]);
        expect(wcodes(validate(fixed, cat))).not.toContain('UPS_PV_WIRING');
        // a panel on an input the station doesn't have is the same problem
        const third = { ...u3, battery: { ...u3.battery, ups: { ...u3.battery.ups, pvArrays: [{ ...u3.battery.ups.pvArrays[0], count: 1, input: 2 }] } } };
        expect(wcodes(validate(third, cat))).toContain('UPS_PV_WIRING');
    });
    it('panels on a station with no usable solar input are an error (also in a what-if plan)', () => {
        const dji = stationToSystem('dji-power-2000', { catalog: cat });
        const s = { ...dji, battery: { ...dji.battery, ups: { ...dji.battery.ups, pvArrays: [{ count: 1, wp: 460, tilt: 35, azimuth: 180 }] } } };
        expect(codes(validate(s, cat))).toEqual(['UPS_NO_PV_INPUT']);
        expect(validate(s, cat).errors[0].message).toMatch(/1\.8 kW solar charger/);
        expectEveryFixClean(s);
        expect(codes(validate({ ...s, route: 'whatif' }, cat))).toEqual(['UPS_NO_PV_INPUT']);
    });
});

describe('hardwired and wiring', () => {
    it('G98 total ≤ 3680 W counts the PV inverter and an ac battery', () => {
        const h = { ...kitToSystem('zendure-solarflow-2400-pro', { catalog: cat, spot: SOUTH, panels: { count: 4, wp: 460 } }) };
        expect(codes(validate(h, cat))).toEqual([]);
        const over = { ...h, battery: { coupling: 'ac', capacityKwh: 5, maxDischargeW: 2500, acOutputW: 3000 } };
        const r = validate(over, cat);
        expect(codes(r)).toEqual(['HARDWIRED_AC_LIMIT']);
        expect(r.errors[0].fixes[0].action).toEqual({ type: 'capAcLimit', w: 1180 });
        expectEveryFixClean(over);
    });
    it('an ac battery that alone takes the whole 3680 W gets no 0 W inverter limit (0 W means "not set") but a fix that works', () => {
        const h = kitToSystem('zendure-solarflow-2400-pro', { catalog: cat, spot: SOUTH, panels: { count: 4, wp: 460 } });
        const huge = { ...h, battery: { coupling: 'ac', capacityKwh: 10, maxDischargeW: 4000, acOutputW: 4000 } };
        const r = validate(huge, cat);
        expect(codes(r)).toEqual(['HARDWIRED_AC_LIMIT']);
        expect(r.errors[0].fixes.map((f) => f.action.type)).toEqual(['removeBattery']);
        expectEveryFixClean(huge);
        // the 0 W limit the old fix wrote is read as the default by every module, rules included
        expect(applyFix(h, { type: 'capAcLimit', w: 0 }, cat).inverter.acLimitW).toBe(800);
    });
    it('a hardwired system without an install cost line is warned, with a fix that adds it', () => {
        const s = normalizeSystem({ route: 'hardwired', arrays: [{ count: 2, wp: 460 }] });
        const r = validate(s, cat);
        expect(wcodes(r)).toEqual(['HARDWIRED_NO_INSTALL']);
        expect(validate(applyFix(s, r.warnings[0].fixes[0].action, cat), cat).warnings).toEqual([]);
    });
    it('an array on an input the inverter does not have (raw system) is an error', () => {
        const raw = { route: 'hardwired', costs: [{ label: 'x', gbp: 1, kind: 'install' }], inverter: { acLimitW: 800, inputs: [{ maxDcW: 600, maxAcW: 400 }] },
            arrays: [{ count: 1, wp: 400, input: 0 }, { count: 1, wp: 400, input: 1, azimuth: 90 }] };
        const r = validate(raw, cat);
        expect(codes(r)).toEqual(['ARRAY_INPUT_RANGE']);
        const fixed = applyFix(raw, r.errors[0].fixes[0].action, cat);
        expect(fixed.arrays.map((a) => a.input)).toEqual([0, 0]);
        expect(codes(validate(fixed, cat))).toEqual([]);
        expect(wcodes(validate(fixed, cat))).toContain('INPUT_MIXED');
    });
});

describe('what-if and reference', () => {
    it('what-if systems carry the banner and keep only physical errors', () => {
        const w = { ...octopus(), route: 'whatif', battery: { coupling: 'ac', capacityKwh: 1.92, acChargeW: 1000 } };
        const r = validate(w, cat);
        expect(r).toMatchObject({ legal: 'whatif', errors: [] });
        expect(wcodes(r)).toContain('WHATIF');
        const bad = { ...w, battery: { coupling: 'ups', strategy: 'fixed', capacityKwh: 1 } };
        expect(codes(validate(bad, cat))).toEqual(['UPS_FIXED']);
    });
    it('reference rows have no checks', () => {
        expect(validate({ route: 'reference', loadAdjustW: -100 }, cat)).toEqual({ legal: 'reference', errors: [], warnings: [], banner: null });
    });
    it('a staged plan checks stage 2 too', () => {
        const s = { ...octopus(), upgrade: { atYear: 2, battery: { coupling: 'ac', capacityKwh: 2 }, costs: [{ gbp: 1000 }] } };
        const r = validate(s, cat);
        expect(r.errors.map((e) => [e.code, e.stage])).toEqual([['PLUGIN_BATTERY', 2]]);
        expect(r.errors[0].message).toMatch(/^Later: /);
    });
    it('a later step under future rules is warned (stage 2, "Later step: …") with the electrician fix; a later wired-in step needs its electrician', () => {
        const vault = cat.kits.find((k) => k.id === 'thunder-vault-hibattery-1920ac');
        const s = { ...octopus(), upgrade: { atYear: 1, label: 'Add a plug-in battery', route: 'whatif', battery: { ...vault.battery, coupling: 'ac' },
            costs: [{ label: `${vault.name} as a plug-in battery`, gbp: vault.priceGbp, year: 0, kind: 'hardware' }] } };
        const r = validate(s, cat);
        expect(r.legal).toBe('ok');
        expect(r.errors).toEqual([]);
        const w = r.warnings.find((x) => x.code === 'LATER_WHATIF');
        expect(w).toMatchObject({ stage: 2, message: 'Later step: plug-in batteries aren’t legal yet, so the battery at the end of year 1 counts on the rules changing first (Octopus hopes for early 2027).' });
        expect(w.fixes.map((f) => f.label)).toEqual(['Have an electrician fit it instead']);
        const fixed = applyFix(s, w.fixes[0].action, cat);
        expect(fixed.upgrade.route).toBe('hardwired');
        expect(fixed.upgrade.costs.filter((c) => c.kind === 'install')).toHaveLength(1);
        expect(fixed.costs).toEqual(normalizeSystem(s).costs); // stage 1 pays nothing more
        const after = validate(fixed, cat);
        expect(after.errors).toEqual([]);
        expect(wcodes(after)).not.toContain('LATER_WHATIF');
        expect(wcodes(after)).not.toContain('HARDWIRED_NO_INSTALL');
        // a later wired-in step with no electrician anywhere is warned at stage 2, and the fix adds one
        const bare = { ...s, upgrade: { ...s.upgrade, route: 'hardwired' } };
        const nb = validate(bare, cat).warnings.find((x) => x.code === 'HARDWIRED_NO_INSTALL');
        expect(nb).toMatchObject({ stage: 2 });
        expect(nb.message).toMatch(/^Later: /);
        expect(wcodes(validate(applyFix(bare, nb.fixes[0].action, cat), cat))).not.toContain('HARDWIRED_NO_INSTALL');
        // a plan that is future-rules as a whole is not warned twice
        expect(wcodes(validate({ ...s, route: 'whatif' }, cat))).not.toContain('LATER_WHATIF');
    });
    it('removeBattery takes the battery off the bill: its cost line, a station\'s own panels, frames and smart plug, and their ids', () => {
        const k = cityPlumbing();
        const st = stationToSystem('ecoflow-delta-3-plus', { catalog: cat, panels: { count: 2, spot: SOUTH } });
        const c1 = { ...k, battery: st.battery, costs: [...k.costs, ...st.costs], sourceIds: [...k.sourceIds, ...st.sourceIds] };
        const r = applyFix(c1, { type: 'removeBattery' }, cat);
        expect(r.battery).toBeNull();
        expect(r.costs).toEqual(k.costs);
        expect(r.sourceIds).toEqual(k.sourceIds);
        expect(r.kitId).toBe(k.kitId);
        // a power station on its own: nothing left to pay for, and no kit
        const u = applyFix(st, { type: 'removeBattery' }, cat);
        expect(u.costs).toEqual([]);
        expect(u.sourceIds).toEqual([]);
        expect(u.kitId).toBeNull();
        // a kit plus an add-on battery ("as a plug-in battery" too) loses that line and id only
        const vault = cat.kits.find((x) => x.id === 'thunder-vault-hibattery-1920ac');
        const w1 = { ...octopus(), route: 'whatif', battery: { ...vault.battery, coupling: 'ac' },
            costs: [...octopus().costs, { label: `${vault.name} as a plug-in battery`, gbp: vault.priceGbp, year: 0, kind: 'hardware' }], sourceIds: [...octopus().sourceIds, vault.id] };
        const w = applyFix(w1, { type: 'removeBattery' }, cat);
        expect(w.costs).toEqual(octopus().costs);
        expect(w.sourceIds).toEqual(octopus().sourceIds);
        // a staged plan's later battery (priced in upgrade.costs) stays, id and all
        const w2 = { ...w1, battery: { coupling: 'dc', capacityKwh: 1 }, costs: octopus().costs,
            upgrade: { atYear: 1, route: 'whatif', battery: { ...vault.battery, coupling: 'ac' }, costs: [{ label: `${vault.name} as a plug-in battery`, gbp: vault.priceGbp, year: 0 }] } };
        const keep = applyFix(w2, { type: 'removeBattery' }, cat);
        expect(keep.sourceIds).toContain(vault.id);
        expect(keep.upgrade.costs).toHaveLength(1);
        // a battery inside an all-in-one unit has no line of its own: the unit's price stays
        const aio = cat.kits.find((x) => x.kind === 'battery-inverter');
        const h = kitToSystem(aio, { catalog: cat, spot: SOUTH, panels: { count: 2, wp: 450 } });
        expect(applyFix(h, { type: 'removeBattery' }, cat).costs).toEqual(h.costs);
    });
    it('unknown fix actions leave the system unchanged; works without a catalog', () => {
        const s = octopus();
        expect(applyFix(s, { type: 'teleport' }, cat)).toEqual(normalizeSystem(s));
        expect(validate(normalizeSystem({ route: 'plugin', arrays: [{ count: 5, wp: 500 }] })).errors.map((e) => e.code)).toEqual(['PLUGIN_DC_LIMIT', 'PLUGIN_MODULES']);
    });
});
