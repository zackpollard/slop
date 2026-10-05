import { describe, it, expect } from 'vitest';
import {
    normalizeCatalog, kitToSystem, stationToSystem, bundleToSystem, findProduct, pluginKits, layoutPanels, orientationForSpot, SERVER_HOLDUP_MS,
} from '../../../projects/solar-calculator/js/kits.js';
import { capexGbp } from '../../../projects/solar-calculator/js/system.js';
import { rawCatalog, dataFile, loadCatalog } from './fixtures/solar/b1-load.js';

const cat = loadCatalog();
const SOUTH = { id: 'ground', kind: 'ground', azimuth: 180, tilt: 35, shadingPct: 3, horizon: [] };

describe('normalizeCatalog', () => {
    it('accepts the bare arrays the worker passes and the wrapped data files alike', () => {
        const wrapped = normalizeCatalog({ kits: dataFile('kits'), stations: dataFile('stations'), bundles: dataFile('bundles'), constants: dataFile('constants') });
        const bare = normalizeCatalog(rawCatalog());
        expect(wrapped.kits.length).toBe(29);
        expect(wrapped.stations.length).toBe(18);
        expect(wrapped.bundles.length).toBe(2);
        expect(JSON.stringify(wrapped)).toBe(JSON.stringify(bare));
        // station defaults are read from the wrapped file when not passed separately
        expect(wrapped.stationDefaults.etaInv).toBe(0.94);
        expect(normalizeCatalog().kits).toEqual([]);
    });
    it('byId is non-enumerable (survives structuredClone without a function) and findProduct works either way', () => {
        expect(cat.byId('octopus-plugin-solar-2x460').name).toBe('Octopus 2×460 W');
        const clone = structuredClone(cat);
        expect(clone.byId).toBeUndefined();
        expect(findProduct(clone, 'bluetti-elite-300').name).toBe('BLUETTI Elite 300');
        expect(findProduct(clone, 'nope')).toBe(null);
    });
    it('electrician line and legal limits come from constants.json', () => {
        expect(cat.electrician).toMatchObject({ gbp: 350, low: 150, high: 600, cuLow: 400, cuHigh: 900 });
        expect(cat.electrician.note).toMatch(/£150–600.*£400–900/);
        expect(cat.limits.plugin).toEqual({ acMaxW: 800, dcMaxWp: 2000, maxModules: 4, devices: 1, proCheckAboveWp: 960 });
        expect(cat.limits.hardwiredMaxW).toBe(3680);
        expect(cat.parts.panel.id).toBe('astronergy-460w-bifacial-trade');
        expect(cat.parts.frame.priceGbp).toBe(40.8);
    });
});

describe('kit normalisation (UX critique)', () => {
    const k = (id) => cat.byId(id);
    it('routes: plug-in kits, the hardwired-as-shipped EcoFlow micro, the unpurchasable facade kit, parts', () => {
        expect(k('octopus-plugin-solar-2x460').route).toBe('plugin');
        expect(k('ecoflow-stream-micro-2x500').route).toBe('hardwired');
        expect(k('ecoflow-stream-facade-2x400')).toMatchObject({ route: 'plugin', onSale: false });
        expect(k('astronergy-460w-bifacial-trade').route).toBe(null);
        expect(k('cityplumbing-dmegc-2x515-hiflow')).toMatchObject({ availableNow: null, onSale: true });
    });
    it('efficiency: weighted as given, peak − 0.005, unknown → 0.955 flagged', () => {
        expect(k('octopus-plugin-solar-2x460').etaNom).toBe(0.955);
        expect(k('patiosun-duo').etaNom).toBe(0.96);
        expect(k('thunder-bolt-920')).toMatchObject({ etaNom: 0.962 });
        expect(k('thunder-bolt-920').flags).toContain('efficiencyPeakCorrected');
        expect(k('ecoflow-stream-micro-2x500').etaNom).toBe(0.955);
        expect(k('ecoflow-stream-micro-2x500').flags).toContain('efficiencyAssumed');
    });
    it('inputs: dual-input 800 W micros are two 400 W channels; single-input HiFlow; unknown → 1 input, flagged', () => {
        expect(k('octopus-plugin-solar-2x460').inputs).toEqual([{ maxDcW: 670, maxAcW: 400 }, { maxDcW: 670, maxAcW: 400 }]);
        expect(k('powerxpress-920-marstek').inputs.map((x) => x.maxAcW)).toEqual([400, 400]);
        expect(k('cityplumbing-dmegc-2x515-hiflow')).toMatchObject({ mppts: 1, singleInput: true, inputs: [{ maxDcW: 1280, maxAcW: 800 }] });
        const sf = k('solarfy-duo-910');
        expect(sf).toMatchObject({ mppts: 1, singleInput: false });
        expect(sf.flags).toContain('inputsUnknown');
    });
    it('all-in-one units keep their own MPPT limits with no per-input AC cap', () => {
        expect(k('ecoflow-stream-ultra').inputs).toEqual(Array(4).fill({ maxDcW: 500, maxAcW: 800 }));
        expect(k('zendure-solarflow-2400-pro').inputs[0]).toEqual({ maxDcW: 750, maxAcW: 2400 });
    });
    it('battery capacity semantics and charge rates', () => {
        const ultra = k('ecoflow-stream-ultra').battery;
        // usableKwh null → nominal with the 10% reserve applied once by the physics
        expect(ultra).toMatchObject({ coupling: 'dc', capacityKwh: 1.92, minSocPct: 10, acChargeW: 1050, maxChargeW: 1050, cycles: 6000 });
        expect(k('ecoflow-stream-ultra').flags).toContain('chargeRateAssumed');
        // dc discharge rating is AC: DC-bus limit = AC/ηnom
        expect(ultra.maxDischargeW).toBeCloseTo(800 / 0.955, 0);
        const vault = k('thunder-vault-hibattery-1920ac').battery;
        expect(vault).toMatchObject({ coupling: 'ac', capacityKwh: 1.92, minSocPct: 10, maxChargeW: 1000, maxDischargeW: 800, acOutputW: 800 });
        expect(vault.acEffCharge * vault.acEffDischarge).toBeCloseTo(0.87, 12);
        const hb = k('hoymiles-hibattery-4020x');
        expect(hb.battery).toMatchObject({ maxChargeW: 2500, acChargeW: 2500 });
        expect(hb.flags).toEqual(expect.arrayContaining(['chargeRateAssumed', 'gridChargeRateAssumed', 'inputsUnknown']));
        // a pack whose usable figure differs from nominal is already net of its reserve
        const custom = normalizeCatalog({ kits: [{ id: 'x', kind: 'battery-addon', coupling: 'ac', batteryKwh: 5, usableKwh: 4.5, acLimitW: 2000, maxChargeW: 2000, maxDischargeW: 2000, acChargeW: 2000 }] });
        expect(custom.kits[0].battery).toMatchObject({ capacityKwh: 4.5, minSocPct: 0 });
    });
    it('pluginKits lists the registered kits on sale, smallest first', () => {
        const ids = pluginKits(cat).map((x) => x.id);
        expect(ids[0]).toBe('octopus-plugin-solar-1x460');
        expect(ids).not.toContain('ecoflow-stream-facade-2x400');
        expect(ids).not.toContain('ecoflow-stream-micro-2x500');
        expect(ids[ids.length - 1]).toBe('cityplumbing-dmegc-2x515-hiflow');
        expect(pluginKits(cat, { onSaleOnly: false }).map((x) => x.id)).toContain('ecoflow-stream-facade-2x400');
    });
});

describe('station normalisation (VERIFY-ups)', () => {
    const s = (id) => cat.byId(id);
    it('availability from the free text, pre-orders, losses and their source', () => {
        expect(s('ecoflow-delta-3-plus')).toMatchObject({ availableNow: true, preorder: false, capacityKwh: 1.024, chargeW: 1500, acOutputW: 1800,
            inputLimitW: 2990, fixedLossW: 17, p0Source: 'idle', lifeYears: 10, hid: true, smartPlugOnly: false, pvWireablePanels: 2 });
        expect(s('ecoflow-delta-3-max-plus')).toMatchObject({ availableNow: false, preorder: true, inputLimitW: 2300 });
        expect(s('bluetti-elite-300')).toMatchObject({ fixedLossW: 11, p0Source: 'measured', smartPlugOnly: true });
        expect(s('bluetti-elite-200-v2')).toMatchObject({ fixedLossW: null, p0Source: 'assumed', assumedP0W: 20 });
        expect(s('anker-solix-f3000')).toMatchObject({ assumedP0W: 29, pvWireablePanels: 4 });
    });
});

describe('kitToSystem', () => {
    it('Octopus kit: one panel per 400 W channel, Prime with Octopus or demo data, none otherwise', () => {
        const sys = kitToSystem(cat.byId('octopus-plugin-solar-2x460'), { catalog: cat, spot: SOUTH, dsSource: 'demo' });
        expect(sys).toMatchObject({ route: 'plugin', kitId: 'octopus-plugin-solar-2x460', export: { kind: 'prime' } });
        expect(sys.arrays.map((a) => [a.count, a.wp, a.input, a.azimuth, a.tilt])).toEqual([[1, 460, 0, 180, 35], [1, 460, 1, 180, 35]]);
        expect(sys.inverter).toMatchObject({ acLimitW: 800, etaNom: 0.955, inputs: [{ maxDcW: 670, maxAcW: 400 }, { maxDcW: 670, maxAcW: 400 }] });
        expect(sys.notes.join(' ')).toMatch(/network operator approves/);
        expect(kitToSystem('octopus-plugin-solar-2x460', { catalog: cat, dsSource: 'csv' }).export.kind).toBe('none');
        expect(capexGbp(sys)).toBe(650);
    });
    it('single-input kits put every panel on input 0; other kits get no export', () => {
        const sys = kitToSystem(cat.byId('cityplumbing-dmegc-2x515-hiflow'), { catalog: cat, spot: SOUTH, dsSource: 'octopus' });
        expect(sys.arrays).toHaveLength(1);
        expect(sys.arrays[0]).toMatchObject({ count: 2, wp: 515, input: 0 });
        expect(sys.export.kind).toBe('none');
    });
    it('hardwired products carry the electrician line', () => {
        const sys = kitToSystem(cat.byId('ecoflow-stream-micro-2x500'), { catalog: cat, spot: SOUTH });
        expect(sys.route).toBe('hardwired');
        expect(sys.costs.map((c) => [c.label, c.gbp, c.kind])).toEqual([['EcoFlow STREAM micro 2×500 W', 549, 'hardware'], ['Electrician: dedicated circuit + G98 notification', 350, 'install']]);
        expect(capexGbp(sys)).toBe(899);
    });
    it('all-in-one with loose panels and frames: H2 = £1,933.80, H3 = £2,533.80 (UX critique)', () => {
        const panels = { count: 4, wp: 460, catalogId: 'astronergy-460w-bifacial-trade', frameId: 'its-adjustable-tilt-frame-15-30' };
        const h2 = kitToSystem(cat.byId('zendure-solarflow-2400-pro'), { catalog: cat, spot: SOUTH, panels });
        expect(capexGbp(h2)).toBeCloseTo(1933.8, 9);
        expect(h2.arrays.map((a) => a.input)).toEqual([0, 1, 2, 3]);
        expect(h2.battery).toMatchObject({ coupling: 'dc', capacityKwh: 2.4, acChargeW: 2400 });
        expect(h2.inverter.acLimitW).toBe(2400);
        const h3 = kitToSystem(cat.byId('anker-solarbank4-e5000-pro'), { catalog: cat, spot: SOUTH, panels });
        expect(capexGbp(h3)).toBeCloseTo(2533.8, 9);
        const h4 = kitToSystem(cat.byId('ecoflow-stream-ac-5000'), { catalog: cat });
        expect(h4.arrays).toEqual([]);
        expect(h4.inverter).toBe(null);
        expect(h4.battery.coupling).toBe('ac');
        expect(capexGbp(h4)).toBe(1849);
    });
    it('bundles: unit + panels at the bundle price + frames on an open spot (H1 £1,499 + 4 × £40.80 + £350)', () => {
        const h1 = bundleToSystem('ecoflow-stream-ultra+4x500', { catalog: cat, spot: SOUTH });
        // the bundle ships without mounting, so it is framed like H2/H3's loose panels and U3's
        expect(capexGbp(h1)).toBeCloseTo(1499 + 163.2 + 350, 9);
        expect(h1.costs.map((c) => c.kind)).toEqual(['hardware', 'hardware', 'install']);
        expect(h1.arrays.reduce((s, a) => s + a.count * a.wp, 0)).toBe(2000);
        expect(h1.sourceIds).toEqual(['ecoflow-stream-ultra+4x500', 'ecoflow-stream-ultra', 'ecoflow-panel-500w-rigid-x2', 'its-adjustable-tilt-frame-15-30']);
        expect(h1.battery).toMatchObject({ coupling: 'dc', capacityKwh: 1.92, maxChargeW: 1050 });
        // a wall spot takes the kit's own brackets: no ground frames, for bundles and loose panels alike
        const wall = { id: 'w', kind: 'wall', azimuth: 270, tilt: 90 };
        expect(capexGbp(bundleToSystem('ecoflow-stream-ultra+4x500', { catalog: cat, spot: wall }))).toBe(1849);
        const loose = { count: 4, wp: 460, catalogId: 'astronergy-460w-bifacial-trade', frameId: 'its-adjustable-tilt-frame-15-30' };
        expect(capexGbp(kitToSystem('zendure-solarflow-2400-pro', { catalog: cat, spot: wall, panels: loose }))).toBeCloseTo(1099 + 321.6 + 350, 9);
    });
    it('unknown kits throw', () => {
        expect(() => kitToSystem('nope', { catalog: cat })).toThrow(/unknown kit/);
    });
});

describe('stationToSystem', () => {
    it('DELTA 3 Plus: real charge rate, idle draw as P0, no export, app schedule keeps the night-charge window', () => {
        const u1 = stationToSystem(cat.byId('ecoflow-delta-3-plus'), { catalog: cat });
        expect(u1).toMatchObject({ route: 'ups', arrays: [], inverter: null, export: { kind: 'none' } });
        expect(u1.battery).toMatchObject({ coupling: 'ups', capacityKwh: 1.024, minSocPct: 10, strategy: 'threshold', lifeYears: 10, cycles: 4000 });
        expect(u1.battery.ups).toMatchObject({ dedicatedW: 'baseload', outletMaxW: 1800, chargeW: 1500, fixedLossW: 17, etaInv: 0.94, chargeEff: 0.88, bypassW: 8, inputLimitW: 2990 });
        expect(u1.battery.schedule.chargeWindow).toEqual(['00:00', '06:00']);
        expect(capexGbp(u1)).toBe(599);
    });
    it('smart-plug-only units get the cut-4–7pm-recharge-after schedule and a £0 smart-plug line', () => {
        const u2 = stationToSystem(cat.byId('bluetti-elite-300'), { catalog: cat });
        expect(u2.battery.schedule).toEqual({ chargeBelowP: null, chargeWindow: ['19:00', '16:00'], dischargeWindow: ['16:00', '19:00'] });
        expect(u2.costs.map((c) => c.gbp)).toEqual([1299, 0]);
        expect(capexGbp(u2)).toBe(1299);
    });
    it('own panels are capped at what can really be wired, one per input (U3 = £841.40)', () => {
        const u3 = stationToSystem(cat.byId('ecoflow-delta-3-plus'), { catalog: cat, panels: { count: 3, wp: 460, spot: SOUTH } });
        expect(u3.battery.ups.pvArrays.map((a) => [a.count, a.input])).toEqual([[1, 0], [1, 1]]);
        expect(u3.battery.ups.pvInputs).toEqual([{ maxDcW: 500 }, { maxDcW: 500 }]);
        expect(u3.notes.join(' ')).toMatch(/Only 2 panels can be wired/);
        const two = stationToSystem(cat.byId('ecoflow-delta-3-plus'), { catalog: cat, panels: { count: 2, wp: 460, spot: SOUTH } });
        expect(capexGbp(two)).toBeCloseTo(841.4, 9);
        // a big unit: extra panels in series on its high-voltage input
        const f3 = stationToSystem(cat.byId('anker-solix-f3000'), { catalog: cat, panels: { count: 4, wp: 450, spot: SOUTH }, frames: false });
        expect(f3.battery.ups.pvArrays.map((a) => [a.count, a.input])).toEqual([[3, 0], [1, 1]]);
        expect(f3.battery.ups.fixedLossW).toBe(29);
    });
});

describe('layout helpers', () => {
    it('layoutPanels spreads panels over inputs, series pairs when there are more panels than inputs', () => {
        const o = orientationForSpot(SOUTH);
        expect(layoutPanels(4, 500, 2, o).map((a) => [a.count, a.input])).toEqual([[2, 0], [2, 1]]);
        expect(layoutPanels(3, 500, 2, o).map((a) => [a.count, a.input])).toEqual([[2, 0], [1, 1]]);
        expect(layoutPanels(1, 460, 2, o).map((a) => [a.count, a.input])).toEqual([[1, 0]]);
    });
    it('orientationForSpot: free spots default south at 35° inside their range; walls are vertical wall mounts', () => {
        expect(orientationForSpot({ kind: 'ground', azimuth: null, tilt: null, tiltRange: [15, 30] })).toMatchObject({ azimuth: 180, tilt: 30, mounting: 'open' });
        expect(orientationForSpot({ kind: 'wall', azimuth: 270, tilt: 90 })).toMatchObject({ azimuth: 270, tilt: 90, mounting: 'wall' });
        expect(orientationForSpot(null)).toMatchObject({ azimuth: 180, tilt: 35, shadingPct: 3 });
    });
});

describe('cycle rating basis and server switchover (D2)', () => {
    it('reads what each rating runs to: stations to 80% (Jackery 70%), home batteries to 70%', () => {
        const st = (id) => cat.byId(id);
        // "4000 cycles to 80%" (DELTA 3 Plus by its siblings, DELTA Pro 3), "6000 cycles to 80%" (Apex 300), "3000 cycles to 80%" (RIVER 3 Plus)
        for (const id of ['ecoflow-delta-3-plus', 'ecoflow-delta-pro-3', 'bluetti-apex-300', 'ecoflow-river-3-plus', 'bluetti-elite-200-v2']) expect(st(id).cycleRatingSoh, id).toBe(0.8);
        // "4000 cycles to 70%" in the notes, and the rest of the Jackery range by brand
        for (const id of ['jackery-explorer-1000-v2', 'jackery-explorer-2000-v2', 'jackery-explorer-3000-v2']) expect(st(id).cycleRatingSoh, id).toBe(0.7);
        // "6000 cycles to 70%" (STREAM Ultra / Ultra X) and the home-battery default
        expect(st('ecoflow-stream-ultra').battery.cycleRatingSoh).toBe(0.7);
        expect(st('anker-solarbank4-e5000-pro').battery.cycleRatingSoh).toBe(0.7);
        expect(st('anker-solarbank4-e5000-pro').flags).toContain('cycleRatingAssumed');
        // a catalog field wins over the notes
        const raw = rawCatalog();
        const own = normalizeCatalog({ ...raw, stations: raw.stations.map((s) => (s.id === 'jackery-explorer-1000-v2' ? { ...s, cycleRatingSoh: 0.8 } : s)) });
        expect(own.byId('jackery-explorer-1000-v2').cycleRatingSoh).toBe(0.8);
    });
    it('the basis reaches the System, so finance ages each unit by its own rating', () => {
        expect(stationToSystem(cat.byId('ecoflow-delta-3-plus'), { catalog: cat }).battery.cycleRatingSoh).toBe(0.8);
        expect(stationToSystem(cat.byId('jackery-explorer-1000-v2'), { catalog: cat }).battery.cycleRatingSoh).toBe(0.7);
        expect(kitToSystem('ecoflow-stream-ultra', { catalog: cat, panels: { count: 4, wp: 500 } }).battery.cycleRatingSoh).toBe(0.7);
    });
    it('only ≤10 ms units are a UPS servers can rely on (ATX 3.1 PSUs hold up ~12 ms at full load)', () => {
        expect(SERVER_HOLDUP_MS).toBe(12);
        expect(cat.byId('ecoflow-delta-3-plus')).toMatchObject({ upsSwitchMs: 10, serverSafeSwitch: true });
        expect(cat.byId('bluetti-elite-200-v2')).toMatchObject({ upsSwitchMs: 15, serverSafeSwitch: false });
        expect(cat.byId('jackery-explorer-1000-v2')).toMatchObject({ upsSwitchMs: 20, serverSafeSwitch: false });
    });
});
