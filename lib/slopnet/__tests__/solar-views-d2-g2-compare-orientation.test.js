/*
 * solar-views-d2-g2-compare-orientation — wave D2 follow-ups in the Compare and Orientation views:
 *   - compare: saved options with junk lists (left in storage by an older import) still render;
 *     a render step that throws puts the error card up instead of a half-built view; a battery or
 *     power station that wears out before year 10 says so under its name; the 20-yr value's help
 *     says 'with replacements' only when a new battery is bought; value per kWh made comes from
 *     the engine's headline.pvValuePPerKwh when it is there;
 *   - both views: when the calculator didn't start, the card says why in the engine's words
 *     (summary.engineError) and Try again calls ctx.data.retryEngine();
 *   - orientation: a picked direction runs the mounting physics the rose shows (system.js
 *     pointArray, as SolarEngine._repoint), the named-directions rows say what pressing them does,
 *     and the pick card scrolls with ui.scrollBehavior().
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './solar-fake-dom.js';
import compareView, {
    rowModel, mergeSystems, confidenceOf, canVaryPanels, solarPPerKwh, wearsOut, npvLongHelp, cashNote, engineWhy, retryWhy,
} from '../../../projects/solar-calculator/js/views/compare.js';
import orientationView, { repoint } from '../../../projects/solar-calculator/js/views/orientation.js';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';

const src = name => readFileSync(fileURLToPath(new URL(`../../../projects/solar-calculator/js/views/${name}`, import.meta.url)), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (dom, n = 6) => { for (let i = 0; i < n; i++) { await tick(); dom?.flush(); } };
const text = el => el.textContent.replace(/\s+/g, ' ');

/** A ScenarioResult just rich enough for a leaderboard row. */
const result = ({ capex = 300, sav = 60, finance = {}, battery = null, headline = {} } = {}) => ({
    headline: { capexGbp: capex, savingsGbp: sav, p10Gbp: sav - 5, p90Gbp: sav + 5, paybackYears: capex / sav, npv10Gbp: 10 * sav - capex,
        net10Gbp: 10 * sav - capex, npvGbp: 20 * sav - capex, pvKwh: 400, selfUsePct: 90, ...headline },
    typical: { annual: {} }, rules: { legal: 'ok', errors: [], warnings: [] }, finance, battery,
});

/* ── compare: junk saved options ───────────────────────────────────────────── */

describe('compare: saved options with lists that aren’t lists still make a row', () => {
    const junk = [
        { id: 'a', name: 'A', costs: 'free' },
        { id: 'b', costs: { gbp: 100 } },
        { id: 'c', costs: [null, 5, 'x', { gbp: 'abc', year: 0 }, { gbp: 50, kind: 'install' }, { gbp: 20, year: 'later' }] },
        { id: 'e', sourceIds: 'kit-1' },
        { id: 'f', name: { x: 1 } },
        { id: 'g', arrays: 'not-an-array', battery: 5 },
        { id: 'j', upgrade: { atYear: 3, costs: {} } },
        { id: 'k', upgrade: 'soon', costs: [{ gbp: 20, year: 2 }] },
        { id: 'l', battery: { coupling: 'ups', ups: { pvArrays: 'x' } } },
    ];
    const products = new Map([['kit-1', { id: 'kit-1', availableNow: false }]]);

    it('rowModel never throws, with or without a result, and reads junk lists as empty', () => {
        const rows = new Map();
        for (const e of mergeSystems([], junk)) {
            expect(() => rowModel(e, null, { products }), e.sys.id).not.toThrow();
            const r = rowModel(e, result(), { products });
            expect(() => confidenceOf(r), e.sys.id).not.toThrow();
            expect(() => canVaryPanels(r), e.sys.id).not.toThrow();
            rows.set(e.sys.id, rowModel(e, null, { products }));
        }
        expect(rows.get('a').capex).toBe(0);
        expect(rows.get('b').capex).toBe(0);
        expect(rows.get('c')).toMatchObject({ capex: 70, install: 50 });   // a year that isn't a number counts as day one
        expect(rows.get('e')).toMatchObject({ products: [], onSale: true });   // a string isn't a list of products
        expect(rows.get('f').name).toBe('f');                                   // a name that isn't text: the id
        expect(rows.get('g')).toMatchObject({ hasBattery: false, coupling: null });
        expect(rows.get('j')).toMatchObject({ laterGbp: 0, laterYear: 3 });
        expect(rows.get('k')).toMatchObject({ laterGbp: 20, laterYear: 2 });
        expect(canVaryPanels({ ...rowModel({ sys: junk[5], kind: 'saved' }, result()), ready: true })).toBe(false);
    });
});

/* ── compare: the view, end to end on stubs ─────────────────────────────────── */

describe('compare view', () => {
    let dom, ui;
    beforeAll(async () => {
        dom = installFakeDom();
        ui = await import('../../../projects/solar-calculator/js/ui.js');
    });
    afterAll(() => dom.restore());

    const job = v => Object.assign(Promise.resolve(v), { cancel() {} });
    function mount({ summary = { id: 'ds', days: 365, coverage: { realPct: 100 } }, auto = [], saved = [], scenario, retryEngine, tweak, settings = {} } = {}) {
        const el = document.body.appendChild(document.createElement('div'));
        const view = Object.create(compareView);
        tweak?.(view);
        const state = { settings, ui: { chartTables: {} }, scenarios: { saved, pinned: [] } };
        const ctx = {
            ui, fmt: ui.fmt, charts: {},
            store: { get: () => state, set() {}, update() {} },
            engine: { call: () => job({ kits: [], stations: [], bundles: [] }) },
            router: { go() {} },
            data: {
                summary: () => summary, status: () => 'ready', on: () => () => {},
                autoScenarios: async () => auto,
                scenario: scenario ?? (async () => result()),
                verdict: () => new Promise(() => {}),
                finance: () => ({}),
                ...(retryEngine ? { retryEngine } : {}),
            },
        };
        view.mount(el, ctx);
        return { view, el, ctx };
    }

    it('a junk saved option (an older import) gets its row — the run fails, the board still renders', async () => {
        const saved = [{ id: 'junk-2', name: 'Junk two', arrays: 'not-an-array', battery: 5, costs: 'free', sourceIds: 'x', upgrade: { costs: {} } }];
        const scenario = async sys => { if (!Array.isArray(sys.arrays)) throw new Error('bad system'); return result(); };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { el, view } = mount({ auto: [{ id: 'S01', name: 'Kit one', route: 'plugin', arrays: [{}], costs: [{ gbp: 300 }] }], saved, scenario });
        await settle(dom);
        warn.mockRestore();
        expect(el.querySelector('.cv-error')).toBeNull();
        expect(el.querySelector('.cv-board')).not.toBeNull();
        expect(text(el.querySelector('.cv-board'))).toContain('Junk two');
        expect(text(el.querySelector('.cv-board'))).toContain('failed');
        view.unmount();
        el.remove();
    });

    it('a render step that throws: the error card replaces the half-built view (fresh rows)', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { el, view } = mount({ auto: [{ id: 'S01', name: 'Kit one', route: 'plugin', arrays: [{}], costs: [] }],
            tweak: v => { v.rebuildRows = () => { throw new Error('rows broke'); }; } });
        await settle(dom);
        expect(err).toHaveBeenCalled();
        err.mockRestore();
        expect(el.querySelector('.cv-board')).toBeNull();
        expect(el.querySelector('.cv-podium')).toBeNull();
        expect(text(el.querySelector('.cv-error'))).toContain('Couldn’t work out the options: rows broke');
        expect(view.v).toBeNull();
        // Try again renders afresh
        const again = [...el.querySelectorAll('.cv-error button')].find(b => /Try again/.test(b.textContent));
        expect(again).toBeTruthy();
        view.unmount();
        el.remove();
    });

    it('… and when it throws once every result is in (finalize)', async () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { el, view } = mount({ auto: [{ id: 'S01', name: 'Kit one', route: 'plugin', arrays: [{}], costs: [] }],
            tweak: v => { v.renderPodium = () => { throw new Error('podium broke'); }; } });
        await settle(dom);
        err.mockRestore();
        expect(el.querySelector('.cv-board')).toBeNull();
        expect(text(el.querySelector('.cv-error'))).toContain('podium broke');
        view.unmount();
        el.remove();
    });

    it('a battery that wears out before year 10 says so under its name; with a new battery bought, that instead', async () => {
        const auto = [
            { id: 'U3', name: 'Station', route: 'ups', arrays: [], battery: { coupling: 'ups' }, costs: [] },
            { id: 'H3', name: 'Wired battery', route: 'hardwired', arrays: [{}], battery: { coupling: 'dc' }, costs: [] },
            { id: 'S01', name: 'Kit one', route: 'plugin', arrays: [{}], costs: [] },
        ];
        const fin = { U3: { batteryEndYear: 7, flags: [] }, H3: { batteryEndYear: 14, flags: [] }, S01: {} };
        const { el, view } = mount({ auto, scenario: async sys => result({ finance: fin[sys.id] }) });
        await settle(dom);
        const row = id => text(el.querySelector(`tr[data-id="${id}"]`));
        expect(row('U3')).toContain('wears out in year 7');
        expect(row('H3')).not.toContain('wears out');           // year 14: after the 10 years ranked on
        expect(row('S01')).not.toContain('wears out');
        view.unmount();
        el.remove();

        expect(wearsOut({ hasBattery: true, batteryEndYear: 7, batteryReplaced: true }).text).toBe('battery bought again after year 7');
        expect(wearsOut({ hasBattery: true, batteryEndYear: 7 }).text).toBe('wears out in year 7');
        expect(wearsOut({ hasBattery: true, batteryEndYear: 10 })).toBeNull();
        expect(wearsOut({ hasBattery: false, batteryEndYear: 3 })).toBeNull();
        expect(rowModel({ sys: { id: 'x', battery: {} }, kind: 'auto' }, result({ finance: { batteryEndYear: 6, flags: ['batteryReplaced'] } })).batteryReplaced).toBe(true);
    });

    it('the 20-yr value says “with replacements” only when a new battery is bought', async () => {
        expect(npvLongHelp({ replaceBattery: true })).toBe(', with replacements (a new battery each time one wears out)');
        expect(npvLongHelp({ replaceBattery: false })).toBe('; a battery or power station that wears out stops saving then');
        for (const replaceBattery of [false, true]) {
            const { el, view } = mount({ auto: [{ id: 'S01', name: 'Kit one', route: 'plugin', arrays: [{}], costs: [] }], settings: { finance: { replaceBattery } } });
            await settle(dom);
            const th = [...el.querySelectorAll('.cv-board th')].find(t => t.textContent.includes('20-yr value'));
            expect(th.getAttribute('title')).toBe(`The same over 20 years${npvLongHelp({ replaceBattery })}`);
            const side = view.sideMetrics().find(m => m.label === '20-yr value');
            expect(side.help).toBe(replaceBattery ? 'in today’s money, with replacements (a new battery each time one wears out)'
                : 'in today’s money; a battery or power station that wears out stops saving then');
            view.unmount();
            el.remove();
        }
    });

    it('the money-back chart only claims battery replacements when a new battery is bought', () => {
        expect(cashNote({ replaceBattery: false })).toContain('a battery or power station that wears out stops saving then');
        expect(cashNote({ replaceBattery: false })).not.toMatch(/new battery/);
        expect(cashNote({ replaceBattery: true })).toContain('a new battery each time one wears out');
        expect(cashNote({})).toBe(cashNote({ replaceBattery: false }));
        expect(src('compare.js')).not.toContain('with price rises and replacements.');
    });

    it('a power station that is bought again doesn’t “stop saving” in the payback line', () => {
        const view = Object.create(compareView);
        view.ctx = { ui, fmt: ui.fmt, store: { get: () => ({ settings: { finance: { replaceBattery: true } } }) }, data: { summary: () => null } };
        const pay = view.sideMetrics().find(m => m.label === 'Payback');
        const r = { coupling: 'ups', batteryEndYear: 7, payback: 4, dpayback: 5, capex: 500 };
        expect(text(pay.sub({ ...r, batteryReplaced: false }))).toContain('it stops saving after year 7');
        expect(text(pay.sub({ ...r, batteryReplaced: true }))).not.toContain('stops saving');
    });

    it('when the calculator didn’t start: the engine’s own reason, and Try again calls retryEngine()', async () => {
        const why = 'Couldn’t download the product list (data/kits.json, error 503). Try again in a moment.';
        let fail;
        const retryEngine = vi.fn(() => new Promise((_, rej) => { fail = rej; }));
        const { el, view } = mount({ summary: { id: 'ds', engineUnavailable: true, engineError: { code: 'CATALOG', message: why } }, retryEngine });
        await settle(dom);
        const t = text(el);
        expect(t).toContain(`Options can’t be compared until the calculator starts. ${why}`);
        expect(t).not.toContain('in this browser');
        expect(el.querySelector('a[href="#usage"]')).not.toBeNull();
        const btn = [...el.querySelectorAll('button')].find(b => /Try again/.test(b.textContent));
        btn.click();
        btn.click();                                     // busy: one call
        expect(retryEngine).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(true);
        fail(new Error('Your data is loaded, but the simulation engine couldn’t start. Still offline.'));
        await settle(dom);
        expect(text(el)).toContain('Still can’t compare the options. Still offline.');   // the card already says the data is loaded
        expect(text(el)).not.toContain('Your data is loaded');
        expect(btn.disabled).toBe(false);
        expect(document.activeElement).toBe(btn);
        view.unmount();
        el.remove();

        expect(engineWhy({ engineUnavailable: true })).toBe('Part of the calculator didn’t download.');
        expect(retryWhy(new Error('Your data is loaded, but the simulation engine couldn’t start.'))).toBe('Part of the calculator still didn’t download.');
        expect(retryWhy(new Error('Load your data first.'))).toBe('Load your data first.');
    });
});

/* ── compare: value per kWh made from the engine ───────────────────────────── */

describe('compare: value per kWh made', () => {
    it('headline.pvValuePPerKwh (core.js) is used as is; without it the same formula runs here', () => {
        const withBattery = { headline: { savingsGbp: 553.54, pvKwh: 1819.3 }, battery: { baseGbp: 258.23, split: { fromSolarGbp: 198.83 } } };
        const local = solarPPerKwh(withBattery);
        expect(local).toBeCloseTo((100 * (258.23 + 198.83)) / 1819.3, 9);
        expect(solarPPerKwh({ ...withBattery, headline: { ...withBattery.headline, pvValuePPerKwh: 12.5 } })).toBe(12.5);
        expect(solarPPerKwh({ ...withBattery, headline: { ...withBattery.headline, pvValuePPerKwh: null } })).toBeCloseTo(local, 9);
    });
});

/* ── orientation ───────────────────────────────────────────────────────────── */

describe('orientation: a picked direction runs the physics the rose shows', () => {
    const frame = { id: 'a1', azimuth: 180, tilt: 30, mounting: 'open', groundSelfShade: false, faiman: { u0: 26.9, u1: 6.2 } };
    const wall = { id: 'a2', azimuth: 90, tilt: 90, mounting: 'wall', groundSelfShade: true };

    it('frame panels turned vertical become a wall mount (and back), as SolarEngine._repoint', () => {
        const sys = { id: 'S01', arrays: [frame, wall] };
        const all = { index: -1, station: false };
        const a = repoint(sys, all, 270, 90);
        expect(a.arrays[0]).toMatchObject({ azimuth: 270, tilt: 90, mounting: 'wall', groundSelfShade: true });
        expect(a.arrays[0].faiman).toBeUndefined();
        expect(a).toEqual(SolarEngine._repoint(sys, all, 270, 90));
        const b = repoint(sys, { index: 1, station: false }, 200, 35);
        expect(b.arrays[0]).toBe(frame);
        expect(b.arrays[1]).toMatchObject({ azimuth: 200, tilt: 35, mounting: 'open', groundSelfShade: false });
        expect(b).toEqual(SolarEngine._repoint(sys, { index: 1, station: false }, 200, 35));
        // a turn that stays a frame keeps everything else
        expect(repoint(sys, all, 210, 40).arrays[0]).toEqual({ ...frame, azimuth: 210, tilt: 40 });
    });

    it('a power station’s own panels likewise', () => {
        const sys = { id: 'U2', arrays: [], battery: { coupling: 'ups', ups: { pvArrays: [frame] } } };
        const tg = { index: -1, station: true };
        const r = repoint(sys, tg, 270, 90);
        expect(r.battery.ups.pvArrays[0]).toMatchObject({ mounting: 'wall', groundSelfShade: true });
        expect(r).toEqual(SolarEngine._repoint(sys, tg, 270, 90));
    });

    it('the pick card scrolls with ui.scrollBehavior(); the named rows say what pressing them does', () => {
        const s = src('orientation.js');
        expect(s).not.toMatch(/behavior:\s*'smooth'/);
        expect(s).toMatch(/behavior: this\.ctx\.ui\.scrollBehavior/);
        expect(s).toMatch(/rowAction: r => \(r\.mixed \? 'its panels face different ways' : 'try this direction'\)/);
    });
});

describe('orientation view: the calculator didn’t start', () => {
    let dom, ui;
    beforeAll(async () => {
        dom = installFakeDom();
        ui = await import('../../../projects/solar-calculator/js/ui.js');
    });
    afterAll(() => dom.restore());

    function mount(summary, retryEngine) {
        const el = document.body.appendChild(document.createElement('div'));
        const view = Object.create(orientationView);
        view.mount(el, {
            ui, fmt: ui.fmt, store: { get: () => ({ settings: {}, scenarios: {} }) }, router: { params: () => ({}) },
            data: { summary: () => summary, status: () => 'ready', on: () => () => {}, ...(retryEngine ? { retryEngine } : {}) },
        });
        return { el, view };
    }

    it('says why in the engine’s words, and Try again calls retryEngine() (a failure says so and keeps the button)', async () => {
        const why = 'Couldn’t download part of the calculator (js/core.js). Check your connection and try again — if it keeps failing, reload the page.';
        let fail;
        const retryEngine = vi.fn(() => new Promise((_, rej) => { fail = rej; }));
        const { el, view } = mount({ id: 'ds', engineUnavailable: true, engineError: { code: 'MISSING_MODULE', message: why } }, retryEngine);
        await settle(dom);
        expect(text(el)).toContain(`Directions can’t be compared until the calculator starts. ${why}`);
        expect(text(el)).not.toContain('isn’t available');
        const btn = [...el.querySelectorAll('button')].find(b => /Try again/.test(b.textContent));
        btn.click();
        expect(retryEngine).toHaveBeenCalledTimes(1);
        expect(btn.disabled).toBe(true);
        fail(new Error('Your data is loaded, but the simulation engine couldn’t start. Still offline.'));
        await settle(dom);
        expect(text(el)).toContain('Still can’t compare directions. Still offline.');
        expect(btn.disabled).toBe(false);
        expect(document.activeElement).toBe(btn);
        view.unmount();
        el.remove();
    });

    it('without a reason on file, a plain one', async () => {
        const { el, view } = mount({ id: 'ds', engineUnavailable: true });
        await settle(dom);
        expect(text(el)).toContain('Directions can’t be compared until the calculator starts. Part of the calculator didn’t download.');
        // no retryEngine on the hub (an older shell): no button that can't work
        expect([...el.querySelectorAll('button')].some(b => /Try again/.test(b.textContent))).toBe(false);
        view.unmount();
        el.remove();
    });
});
