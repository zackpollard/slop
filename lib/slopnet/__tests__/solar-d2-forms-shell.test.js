/*
 * solar-d2-forms-shell — wave D2 follow-ups in the forms and the shell, in node:
 *   - store.js drops saved scenarios a view would choke on whenever it reads the stored blob (at
 *     start-up and when another tab writes), keeping the valid ones exactly as stored;
 *   - checkSavedScenario lives in system.js (store.js can't import a view); method.js re-exports it;
 *   - DataHub.load drops an API key Octopus rejected from session and local storage — that key
 *     only, and only for a real rejection — and always sends the mount spots as a list;
 *   - data view: the existing-solar editor fills in the date the account's readings suggest, and
 *     the device card stops saying a dropped key is kept; reduced motion reaches the views' scrolls;
 *   - design: the AC limit field can't be set to 0 W (the engine reads 0 as "not set", 800 W);
 *   - style.css: a tinted badge on a highlighted table row keeps 4.5:1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './solar-fake-dom.js';
import { createStore, STATE_KEY, API_KEY_KEY } from '../../../projects/solar-calculator/js/store.js';
import { createDataHub, keyRejected } from '../../../projects/solar-calculator/js/app.js';
import * as system from '../../../projects/solar-calculator/js/system.js';

class MemStorage {
    constructor() { this.map = new Map(); }
    getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
    setItem(k, v) { this.map.set(k, String(v)); }
    removeItem(k) { this.map.delete(k); }
}

const text = el => el.textContent.replace(/\s+/g, ' ').trim();
const abortErr = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const dataErr = (code, message, action) => Object.assign(new Error(message), { name: 'DataError', code, action });

/* A scripted engine client (as in solar-app.test.js): calls stay pending until the test settles them. */
function fakeEngine() {
    const calls = [];
    return {
        calls,
        of: method => calls.filter(c => c.method === method),
        call(method, ...args) {
            const last = args[args.length - 1];
            if (last && typeof last === 'object' && typeof last.onProgress === 'function') args.pop();
            let resolve, reject;
            const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            const rec = { method, args, done: false };
            calls.push(rec);
            promise.cancel = () => { if (!rec.done) { rec.done = true; reject(abortErr()); } };
            rec.settle = v => { if (!rec.done) { rec.done = true; resolve(v); } };
            rec.fail = e => { if (!rec.done) { rec.done = true; reject(e); } };
            return promise;
        },
    };
}

let dom, ui, dataMod, methodMod, designMod;
beforeAll(async () => {
    dom = installFakeDom();
    // a DOM member the data view uses that solar-fake-dom.js doesn't have (as solar-views-main adds it)
    const nodeProto = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement('div')));
    if (!nodeProto.replaceWith) {
        nodeProto.replaceWith = function replaceWith(node) { const p = this.parentNode; if (!p) return; p.insertBefore(node, this); p.removeChild(this); };
    }
    ui = await import('../../../projects/solar-calculator/js/ui.js');
    dataMod = await import('../../../projects/solar-calculator/js/views/data.js');
    methodMod = await import('../../../projects/solar-calculator/js/views/method.js');
    designMod = await import('../../../projects/solar-calculator/js/views/design.js');
});
afterAll(() => dom.restore());

/* ── store: saved scenarios are checked on every read ───────────────────────── */

describe('store drops saved scenarios a view would choke on', () => {
    let local, session;
    beforeEach(() => { local = new MemStorage(); session = new MemStorage(); });

    const good = { id: 'my-1', name: 'Octopus 2×460 W (mine)', costs: [{ label: 'Kit', gbp: 650, year: 0, kind: 'hardware' }], arrays: [{ count: 2 }] };
    const override = { id: 'S03', priceOverride: true, overrideOf: 'S03', costs: [{ label: 'Kit', gbp: 499, year: 0 }] };
    const nameless = { id: 'my-2' };
    const junk = [
        { id: 'free', name: 'Free kit', costs: 'free' },                       // Compare used to throw on this every visit
        null,
        'S01',
        { id: 'flat', arrays: { a0: {} } },
        { id: 'later', upgrade: { atYear: 3, costs: [{ label: 'x', gbp: 'lots' }] } },
        { id: 'pricey', priceOverride: 'yes' },
        { name: 'no id' },
    ];

    it('at start-up: only the valid ones survive, exactly as they were stored', () => {
        local.setItem(STATE_KEY, JSON.stringify({
            version: 1,
            scenarios: { saved: [good, ...junk.slice(0, 3), override, ...junk.slice(3), nameless], pinned: ['free', 'S01'], activeId: 'free' },
        }));
        const s = createStore({ local, session, events: null });
        // a valid entry is not rewritten (no name filled in): the tabs' merge compares entries by JSON
        expect(s.get().scenarios.saved).toEqual([good, override, nameless]);
        // pins and the active id may name ready-made options: left alone (views cope with unknown ids)
        expect(s.get().scenarios.pinned).toEqual(['free', 'S01']);
        expect(s.get().scenarios.activeId).toBe('free');
        // the next write stores the clean list
        s.set({ ui: { tab: 'usage' } });
        expect(JSON.parse(local.getItem(STATE_KEY)).scenarios.saved).toEqual([good, override, nameless]);
    });

    it('a blob another tab wrote is checked the same way', () => {
        const s = createStore({ local, session, events: null });
        s.update('scenarios', sc => ({ ...sc, saved: [good] }));
        const theirs = JSON.parse(local.getItem(STATE_KEY));
        theirs.scenarios.saved = [good, junk[0], override];
        const changed = s.sync(JSON.stringify(theirs));
        expect(changed).toContain('scenarios');
        expect(s.get().scenarios.saved).toEqual([good, override]);
    });

    it('a stored list that is all junk comes back empty, never broken', () => {
        local.setItem(STATE_KEY, JSON.stringify({ version: 1, scenarios: { saved: junk } }));
        expect(createStore({ local, session, events: null }).get().scenarios.saved).toEqual([]);
    });
});

describe('checkSavedScenario lives in system.js', () => {
    it('method.js re-exports the same function (the settings import and the store agree)', () => {
        expect(methodMod.checkSavedScenario).toBe(system.checkSavedScenario);
        expect(system.checkSavedScenario({ id: 'x', costs: 'free' }).why).toBe('its costs aren’t a list of prices');
        expect(system.checkSavedScenario({ id: 'x', name: ' ' }).sys).toEqual({ id: 'x', name: 'x' });
        expect(system.checkSavedScenario({ id: 'x', name: 'y'.repeat(500) }).sys.name).toHaveLength(system.MAX_SCENARIO_NAME);
    });

    it('everything the app itself saves passes (a normalised system, a Compare price override)', () => {
        const sys = system.normalizeSystem({ id: 'my-3', name: 'Mine', arrays: [{}], battery: { coupling: 'ups', ups: { pvArrays: [{}] } }, costs: [{ label: 'Kit', gbp: 300 }], upgrade: { atYear: 2, battery: {}, costs: [{ label: 'More', gbp: 100 }] } });
        expect(system.checkSavedScenario(sys).sys).toBe(sys);
        expect(system.checkSavedScenario({ ...sys, priceOverride: true, overrideOf: 'S01' }).why).toBeUndefined();
    });
});

/* ── DataHub: a rejected key is dropped; spots always go as a list ─────────── */

describe('DataHub.load drops an API key Octopus rejected', () => {
    const SUMMARY = { id: 'ds', days: 365, source: 'octopus' };
    const setup = ({ remember }) => {
        const local = new MemStorage(), session = new MemStorage();
        const st = createStore({ local, session, events: null });
        st.setApiKey('sk_live_bad', remember);
        const engine = fakeEngine();
        const hub = createDataHub({ engine, store: st });
        return { local, session, st, engine, hub };
    };
    const failWith = async ({ engine, hub }, err, spec = { kind: 'octopus', apiKey: 'sk_live_bad' }) => {
        const p = hub.load(spec, { navigate: false });
        engine.of('loadDataset').at(-1).fail(err);
        await expect(p).rejects.toBe(err);
    };

    it('keyRejected: a 401 / invalid-key answer, not a token hiccup, an empty account or a network error', () => {
        expect(keyRejected(dataErr('AUTH', 'Octopus says that API key is not valid.', 'checkKey'))).toBe(true);
        expect(keyRejected({ code: 'AUTH' })).toBe(true);                                   // AUTH's default remedy
        expect(keyRejected(dataErr('AUTH', 'Octopus could not look up your account (KT-CT-1112).', 'pickAccount'))).toBe(false);
        expect(keyRejected(dataErr('ACCOUNT', 'No electricity account was found for this API key.', 'checkKey'))).toBe(false);
        expect(keyRejected(dataErr('NETWORK', 'Unexpected answer from Octopus (500).', 'retry'))).toBe(false);
        expect(keyRejected(abortErr())).toBe(false);
        expect(keyRejected(null)).toBe(false);
    });

    for (const remember of [true, false]) {
        it(`a remembered=${remember} key is gone from memory, this tab and this device`, async () => {
            const env = setup({ remember });
            expect(env.st.getApiKey()).toBe('sk_live_bad');
            await failWith(env, dataErr('AUTH', 'Octopus says that API key is not valid.', 'checkKey'));
            expect(env.st.getApiKey()).toBeNull();
            expect(env.local.getItem(API_KEY_KEY)).toBeNull();
            expect(env.session.getItem(API_KEY_KEY)).toBeNull();
            expect(env.hub.status()).toBe('error');
        });
    }

    it('keeps the key for every other failure', async () => {
        const env = setup({ remember: true });
        await failWith(env, dataErr('NETWORK', 'Unexpected answer from Octopus (503).', 'retry'));
        await failWith(env, dataErr('AUTH', 'Octopus could not look up your account (KT-CT-1124).', 'pickAccount'));
        await failWith(env, dataErr('ACCOUNT', 'No electricity account was found for this API key.', 'checkKey'));
        await failWith(env, abortErr());
        expect(env.st.getApiKey()).toBe('sk_live_bad');
        expect(env.local.getItem(API_KEY_KEY)).toBe('sk_live_bad');
    });

    it('only the key that load used: one pasted since is kept', async () => {
        const env = setup({ remember: true });
        const p = env.hub.load({ kind: 'octopus', apiKey: 'sk_live_bad' }, { navigate: false });
        env.st.setApiKey('sk_live_fixed', true);
        const err = dataErr('AUTH', 'Octopus says that API key is not valid.', 'checkKey');
        env.engine.of('loadDataset')[0].fail(err);
        await expect(p).rejects.toBe(err);
        expect(env.st.getApiKey()).toBe('sk_live_fixed');
        expect(env.local.getItem(API_KEY_KEY)).toBe('sk_live_fixed');
    });

    it('a successful load keeps it', async () => {
        const env = setup({ remember: false });
        const p = env.hub.load({ kind: 'octopus', apiKey: 'sk_live_bad' }, { navigate: false });
        env.engine.of('loadDataset')[0].settle(SUMMARY);
        await p;
        expect(env.st.getApiKey()).toBe('sk_live_bad');
        expect(env.session.getItem(API_KEY_KEY)).toBe('sk_live_bad');
    });
});

describe('DataHub sends the mount spots as a list, always', () => {
    const ready = async spots => {
        const st = createStore({ local: new MemStorage(), session: new MemStorage(), events: null });
        if (spots !== undefined) st.set({ settings: { spots } });
        const engine = fakeEngine();
        const hub = createDataHub({ engine, store: st });
        const p = hub.load({ kind: 'demo' }, { navigate: false });
        engine.of('loadDataset')[0].settle({ id: 'ds-demo', source: 'demo' });
        await p;
        return { engine, hub };
    };

    it('no spots: an explicit empty list (the engine’s defaults) to the verdict and the options', async () => {
        const { engine, hub } = await ready();
        hub.verdict().catch(() => {});
        hub.autoScenarios().catch(() => {});
        expect(engine.of('verdict')[0].args[0].spots).toEqual([]);
        expect(engine.of('autoScenarios')[0].args).toEqual([{ spots: [] }]);
    });

    it('the user’s spots go as they are', async () => {
        const spots = [{ id: 'wall', kind: 'wall', azimuth: 270 }];
        const { engine, hub } = await ready(spots);
        hub.verdict().catch(() => {});
        hub.autoScenarios().catch(() => {});
        expect(engine.of('verdict')[0].args[0].spots).toEqual(spots);
        expect(engine.of('autoScenarios')[0].args).toEqual([{ spots }]);
    });
});

/* ── data view ──────────────────────────────────────────────────────────────── */

describe('data view: existing solar the account suggests', () => {
    const dateText = ms => ui.fmt.date(ms);
    const exportHint = { exportMpan: '1900000000001', exportSince: '2026-04-02', zeroTailFrom: null, suggestedInstallDate: '2026-04-02' };
    const tailHint = { exportMpan: null, exportSince: null, zeroTailFrom: '2026-06-15', suggestedInstallDate: '2026-06-15' };

    it('suggestedInstall names the sign, and stays quiet once a date is set', () => {
        const a = dataMod.suggestedInstall({ existingGeneration: exportHint }, { installedSolarDate: null }, dateText);
        expect(a).toEqual({ date: '2026-04-02', why: 'Your account has had an export meter since 2 Apr 2026.' });
        const b = dataMod.suggestedInstall({ existingGeneration: tailHint }, {}, dateText);
        expect(b).toEqual({ date: '2026-06-15', why: 'Your readings after 14 Jun 2026 are mostly 0 kWh.' });
        expect(dataMod.suggestedInstall({ existingGeneration: exportHint }, { installedSolarDate: '2026-03-01' }, dateText)).toBeNull();
        expect(dataMod.suggestedInstall({ existingGeneration: { ...exportHint, suggestedInstallDate: null } }, {}, dateText)).toBeNull();
        expect(dataMod.suggestedInstall({ existingGeneration: null }, {}, dateText)).toBeNull();
        expect(dataMod.suggestedInstall(null, null, dateText)).toBeNull();
        expect(dataMod.suggestedInstall({ existingGeneration: { suggestedInstallDate: 'soon' } }, {}, dateText)).toBeNull();
    });

    it('the editor opens with that date filled in, once per opening', () => {
        const summary = { id: 'ds', source: 'octopus', priceBasis: 'mine', existingGeneration: exportHint };
        let connection = { kind: 'octopus', installedSolarDate: null };
        const v = Object.create(dataMod.default);
        v.ctx = { ui, fmt: ui.fmt, store: { get: () => ({ connection }) }, data: { summary: () => summary } };
        v.draft = {};
        v.syncDraft();
        const box = v.installedEditor(summary);
        expect(box.querySelector('input[name="installed"]').value).toBe('2026-04-02');
        expect(v.draft.installed).toBe('2026-04-02');
        expect(text(box)).toMatch(/^The date below is filled in from your account/);
        // the user clears it: a re-render of the open editor doesn't put it back
        v.draft.installed = '';
        expect(v.installedEditor(summary).querySelector('input[name="installed"]').value).toBe('');
        // closing and opening again offers it again
        v.syncDraft();
        expect(v.installedEditor(summary).querySelector('input[name="installed"]').value).toBe('2026-04-02');
        // a date already set is never replaced
        connection = { kind: 'octopus', installedSolarDate: '2026-01-10' };
        v.syncDraft();
        const set = v.installedEditor(summary);
        expect(set.querySelector('input[name="installed"]').value).toBe('2026-01-10');
        expect(text(set)).not.toMatch(/filled in from your account/);
    });

    it('the device card stops saying a dropped key is kept (without moving focus)', () => {
        let key = 'sk_live_x';
        const v = Object.create(dataMod.default);
        v.ctx = { ui, store: { get: () => ({ connection: { rememberKey: true } }), getApiKey: () => key }, data: { summary: () => ({ id: 'x' }) } };
        v.el = document.body.appendChild(ui.h('div', null, ui.h('section', { class: 'card' }, v.deviceBody({}))));
        const other = document.body.appendChild(ui.h('input', { name: 'octopus-key' }));
        other.focus();
        expect(text(v.el)).toMatch(/remembered on this device/);
        key = null;
        v.paintDevice();
        expect(text(v.el)).toMatch(/No Octopus API key is stored in this browser/);
        expect(document.activeElement).toBe(other);
        v.el.remove();
        other.remove();
    });
});

describe('reduced motion reaches the views’ scrolls', () => {
    let saved;
    beforeAll(() => {
        saved = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia');
        globalThis.matchMedia = q => ({ matches: /prefers-reduced-motion: reduce/.test(q), addEventListener() {} });
    });
    afterAll(() => { if (saved) Object.defineProperty(globalThis, 'matchMedia', saved); else delete globalThis.matchMedia; });

    it('Method’s contents list jumps instead of gliding', () => {
        const v = Object.create(methodMod.default);
        v.ctx = { ui };
        const sec = ui.h('section', { dataset: { sec: 'rules' } }, ui.h('h2', null, 'The rules'));
        const seen = [];
        sec.scrollIntoView = o => seen.push(o);
        v.el = ui.h('div', null, sec);
        v.jump('rules');
        expect(seen).toEqual([{ behavior: 'auto', block: 'start' }]);
    });

    it('a Data failure panel is brought on screen without a glide', () => {
        const v = Object.create(dataMod.default);
        v.ctx = { ui };
        const panel = document.body.appendChild(ui.h('div', { class: 'da-fail' }, 'Octopus says that API key is not valid.'));
        panel.getBoundingClientRect = () => ({ top: 2000, bottom: 2100 });
        const seen = [];
        panel.scrollIntoView = o => seen.push(o);
        const field = document.body.appendChild(ui.h('input', { name: 'octopus-key' }));
        field.focus();                       // focus still in the form: the panel only scrolls
        v.reveal(panel);
        dom.flush();
        expect(seen).toEqual([{ block: 'center', behavior: 'auto' }]);
        expect(document.activeElement).toBe(field);
        panel.remove();
        field.remove();
    });
});

/* ── design: the AC limit field ─────────────────────────────────────────────── */

describe('design: "Most it sends to the house"', () => {
    it('can’t go below 1 W (0 W would show one limit while the engine simulates 800 W)', () => {
        const v = Object.create(designMod.default);
        v.ctx = { ui, fmt: ui.fmt };
        v.st = { draft: system.normalizeSystem({ arrays: [{}] }) };
        v.change = fn => { v.st.draft = fn(JSON.parse(JSON.stringify(v.st.draft))); };
        const el = v.advInverter();
        const input = el.querySelector('[data-k="inverter.acLimitW"] input');
        expect(input.value).toBe('800');
        input.value = '0';
        input.dispatchEvent({ type: 'change', bubbles: true });
        expect(v.st.draft.inverter.acLimitW).toBe(1);
        expect(input.value).toBe('1');
        expect(system.normalizeSystem(v.st.draft).inverter.acLimitW).toBe(1);
    });
});

/* ── style.css: badges on the highlighted (best-buy) row ────────────────────── */

describe('style.css: a tinted badge on a highlighted row keeps 4.5:1', () => {
    const css = readFileSync(fileURLToPath(new URL('../../../projects/solar-calculator/css/style.css', import.meta.url)), 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
    const token = name => new RegExp(`--${name}:\\s*([^;]+);`).exec(root)?.[1].trim();
    const rgba = c => {
        const v = c.startsWith('var(') ? token(c.slice(6, -1)) : c;
        if (v.startsWith('#')) return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)).concat(1);
        return v.slice(v.indexOf('(') + 1, -1).split(',').map(Number);
    };
    const over = (bg, [r, g, b, a]) => bg.map((c, i) => c * (1 - a) + [r, g, b][i] * a);
    const lum = c => { const s = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]; };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

    it('each tint is laid over the card surface, not over the row’s own tint', () => {
        expect(css).toMatch(/\.tbl tr\.is-highlight :is\(\.badge-accent, \.badge-good, \.badge-warn, \.badge-bad, \.badge-info\) \{ background-color: var\(--surface\); \}/);
        const surface = rgba('var(--surface)').slice(0, 3);
        for (const k of ['accent', 'good', 'warn', 'bad', 'info']) {
            const base = new RegExp(`\\.badge-${k} \\{[^}]*background: ([^;]+);[^}]*color: ([^;]+);`).exec(css);
            const hi = new RegExp(`\\.tbl tr\\.is-highlight \\.badge-${k} \\{ background-image: linear-gradient\\((.+?), \\1\\); \\}`).exec(css);
            expect(hi, k).not.toBeNull();
            expect(hi[1], `${k}: the same tint as the badge elsewhere`).toBe(base[1]);
            const bg = over(surface, rgba(hi[1]));
            expect(contrast(rgba(base[2]).slice(0, 3), bg), k).toBeGreaterThanOrEqual(4.5);
        }
    });
});
