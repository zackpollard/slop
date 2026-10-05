/*
 * solar-views-main — wave D1c-1: the Usage, Verdict, Data and Method views on the shared pieces,
 * driven in node over solar-fake-dom.js with stub charts (they record the specs a view passes):
 *   - usage: the always-on band from insights.baseLoad.monthly as a range-band series, null gaps,
 *     tableCaption instead of hidden titles, the hatched no-reading mask on the load heatmap, the
 *     Agile-vs-Flexible card from insights.flexible, ui.coverageChip and ui.figurePair;
 *   - verdict: one grouped options table (optionGroups) instead of three, data-id rows that survive
 *     a group toggle, the user's own prices marked, the 'overrides' event re-running the verdict,
 *     the station-inclusive peak share and the own-panels power-station copy;
 *   - data: progress via ui.progressList (error rows empty, settle), the meter and region from
 *     store.connection, keepFocus on the device card;
 *   - method: dismissLabel on the re-run bar, keepFocus with the heading fallback, region and
 *     meter in settings export/import.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './solar-fake-dom.js';
import { demoDatasetFromJson, summarize } from '../../../projects/solar-calculator/js/dataset.js';
import { analyseUsage } from '../../../projects/solar-calculator/js/insights.js';

let dom, ui, usageMod, verdictMod, dataMod, methodMod;
let demoIns, demoSummary;

beforeAll(async () => {
    dom = installFakeDom({ cssVars: { '--series-load': '#3987e5', '--chart-surface': '#1a1a16' } });
    // two DOM members the data view uses that solar-fake-dom.js doesn't have (added for this file only)
    const nodeProto = Object.getPrototypeOf(Object.getPrototypeOf(document.createElement('div')));
    if (!('parentElement' in nodeProto)) {
        Object.defineProperty(nodeProto, 'parentElement', { configurable: true, get() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; } });
    }
    if (!nodeProto.replaceWith) {
        nodeProto.replaceWith = function replaceWith(node) { const p = this.parentNode; if (!p) return; p.insertBefore(node, this); p.removeChild(this); };
    }
    ui = await import('../../../projects/solar-calculator/js/ui.js');
    usageMod = await import('../../../projects/solar-calculator/js/views/usage.js');
    verdictMod = await import('../../../projects/solar-calculator/js/views/verdict.js');
    dataMod = await import('../../../projects/solar-calculator/js/views/data.js');
    methodMod = await import('../../../projects/solar-calculator/js/views/method.js');
    const json = JSON.parse(readFileSync(fileURLToPath(new URL('../../../projects/solar-calculator/data/demo.json', import.meta.url)), 'utf8'));
    const ds = demoDatasetFromJson(json, { serverW: 500 });
    demoIns = analyseUsage(ds);
    demoSummary = summarize(ds);
});
afterAll(() => dom.restore());

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async (n = 4) => { for (let i = 0; i < n; i++) await tick(); };
const text = el => el.textContent.replace(/\s+/g, ' ').trim();

/** Charts that record what a view asks for. */
function stubCharts() {
    const made = {};
    const kind = k => (el, spec) => {
        const rec = { kind: k, el, spec, updates: 0 };
        const key = spec.tableCaption || spec.title || spec.ariaLabel;
        made[key] = rec;
        return { update(s) { rec.spec = s; rec.updates++; }, destroy() {}, setTable() {} };
    };
    return { made, createLine: kind('line'), createBars: kind('bars'), createHeatmap: kind('heatmap'), createScatter: kind('scatter'), createTornado: kind('tornado'), createStackedArea: kind('area') };
}

/** A store stub with the bits the views read and the deep-ish merge they rely on. */
function stubStore(state = {}) {
    let s = { settings: {}, ui: { chartTables: {} }, scenarios: { saved: [] }, connection: {}, ...state };
    return {
        get: () => s,
        set(patch) {
            const next = { ...s };
            for (const [k, v] of Object.entries(patch)) next[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(s[k] || {}), ...v } : v;
            if (patch.ui?.chartTables) next.ui = { ...s.ui, chartTables: { ...(s.ui?.chartTables || {}), ...patch.ui.chartTables } };
            s = next;
        },
        getApiKey: () => s._key ?? null,
        setApiKey() {}, clearApiKey() {},
    };
}

/* ── usage ──────────────────────────────────────────────────────────────────── */

describe('usage view helpers', () => {
    it('baseLoadMonths takes the monthly p10/p90 from insights and falls back to the bill months', () => {
        const rows = usageMod.baseLoadMonths({ monthly: [{ key: '2026-01', w: 500, p10: 480, p90: 530, days: 31 }, { key: '2026-02', w: null, p10: NaN, p90: undefined, days: 0 }] });
        expect(rows).toEqual([
            { key: '2026-01', w: 500, p10: 480, p90: 530, days: 31 },
            { key: '2026-02', w: null, p10: null, p90: null, days: 0 },
        ]);
        expect(usageMod.baseLoadMonths({ monthly: [] }, [{ key: '2025-10' }])).toEqual([{ key: '2025-10', w: null, p10: null, p90: null, days: 0 }]);
        // the demo's own rows carry the spread insights.js computed (no regrouping of dailyW in the view)
        const demo = usageMod.baseLoadMonths(demoIns.baseLoad, demoIns.monthlyBills);
        expect(demo).toHaveLength(12);
        for (const [i, m] of demo.entries()) {
            expect(m.p10).toBe(demoIns.baseLoad.monthly[i].p10);
            expect(m.p90).toBe(demoIns.baseLoad.monthly[i].p90);
            expect(m.p10).toBeLessThanOrEqual(m.w);
            expect(m.p90).toBeGreaterThanOrEqual(m.w);
        }
    });

    it('flexibleCard compares the same usage on Flexible with what was paid', () => {
        const fc = usageMod.flexibleCard(demoIns, demoSummary);
        const fx = demoIns.flexible;
        expect(fc.isAgile).toBe(true);
        expect(fc.billedGbp).toBeCloseTo(demoIns.totals.energyGbp + demoIns.totals.standingGbp, 9);
        expect(fc.flexGbp).toBeCloseTo(fx.energyGbp + fx.standingGbp, 9);
        expect(fc.diffGbp).toBeCloseTo(fx.deltaGbp, 9);
        expect(fc.diffGbp).toBeCloseTo(fc.flexGbp - fc.billedGbp, 6);
        expect(fc.outcome).toBe('flexDearer');            // demo: Flexible ≈ £352 dearer
        expect(fc.code).toBe('E-1R-VAR-22-11-01-C');
        // the account's own bills are 'what you paid'; a usage priced as if on Agile is not
        expect(fc.paid).toBe(true);
        expect(usageMod.flexibleCard(demoIns, { ...demoSummary, priceBasis: 'agile' }).paid).toBe(false);
        // nothing to compare: no Flexible prices, or the usage is already priced on Flexible
        expect(usageMod.flexibleCard({ ...demoIns, flexible: null }, demoSummary)).toBeNull();
        expect(usageMod.flexibleCard(demoIns, { ...demoSummary, priceBasis: 'flexible' })).toBeNull();
        const flat = usageMod.flexibleCard({ ...demoIns, flexible: { ...fx, deltaGbp: -0.4 } }, { priceBasis: 'flat', tariffCode: 'FLAT-28' });
        expect(flat.isAgile).toBe(false);
        expect(flat.yours).toBe('your flat price');
        expect(flat.outcome).toBe('same');
    });

    it('loadMask hatches half-hours with a price but no reading, never the skipped clock-change hour', () => {
        const days = 2;
        const load = new Float32Array(days * 48).fill(0.3);
        const price = new Float32Array(days * 48).fill(20);
        load[5] = NaN;                       // a gap: priced, no reading
        load[60] = NaN; price[60] = NaN;     // the hour the clocks skip: neither
        const derived = usageMod.loadMask({ days, load, price });
        expect([...derived].reduce((a, b) => a + b, 0)).toBe(1);
        expect(derived[5]).toBe(1);
        expect(derived[60]).toBe(0);
        // insights' own mask is used as-is when it is the right size
        const filled = new Uint8Array(days * 48); filled[7] = 1;
        expect(usageMod.loadMask({ days, load, price, filled })).toBe(filled);
        // every half-hour read: nothing to hatch
        expect(usageMod.loadMask({ days, load: new Float32Array(96).fill(1), price, filled: new Uint8Array(96) })).toBeNull();
    });
});

describe('usage view on the shared pieces', () => {
    async function mountUsage({ ins = demoIns, summary = demoSummary, more = true } = {}) {
        const charts = stubCharts();
        const store = stubStore({ ui: { chartTables: { 'usage.more': more } } });
        const ctx = {
            ui, fmt: ui.fmt, charts, store,
            data: { on: () => () => {}, summary: () => summary, status: () => 'ready', insights: async () => ins },
        };
        const el = document.body.appendChild(ui.h('div'));
        const view = Object.create(usageMod.default);
        view.mount(el, ctx);
        await settle();
        return { view, el, charts, store };
    }

    it('draws the always-on spread as one range band behind the typical day, with null gaps', async () => {
        const ins = { ...demoIns, baseLoad: { ...demoIns.baseLoad, monthly: demoIns.baseLoad.monthly.map((m, i) => (i === 3 ? { ...m, w: null, p10: null, p90: null, days: 0 } : m)) } };
        const { charts, el } = await mountUsage({ ins });
        const spec = charts.made['Always-on load, month by month'].spec;
        expect(spec.title).toBeUndefined();                      // the card heading names it
        const band = spec.series.find(s => s.lo);
        expect(band).toMatchObject({ key: 'range', label: '8 days in 10', color: 'load', loLabel: 'low', hiLabel: 'high' });
        expect(band.values).toBeUndefined();
        expect(band.lo).toEqual(ins.baseLoad.monthly.map((m, i) => (i === 3 ? null : m.p10)));
        expect(band.hi).toEqual(ins.baseLoad.monthly.map((m, i) => (i === 3 ? null : m.p90)));
        // the old two dashed p10 / p90 lines are gone; the typical day keeps its gap as null (not NaN)
        expect(spec.series.map(s => s.key)).toEqual(['range', 'p50']);
        expect(spec.series[1].values[3]).toBeNull();
        expect(spec.series[1].values[0]).toBe(ins.baseLoad.monthly[0].w);
        // the average-day profiles pass null gaps too (charts.js draws null as a break)
        expect(charts.made['Your load'].spec.series[0].values.every(v => v === null || Number.isFinite(v))).toBe(true);
        el.remove();
    });

    it('uses ui.coverageChip, ui.figurePair and tableCaption in place of the view-local versions', async () => {
        const { el, charts } = await mountUsage();
        const chip = el.querySelector('.cov-chip');
        expect(chip.getAttribute('href')).toBe('#data');
        expect(text(chip)).toBe('100% real readings');
        expect(el.querySelector('.uv-chip')).toBeNull();
        expect(el.querySelectorAll('.fig-pair').length).toBeGreaterThanOrEqual(3);   // peak panel, shift, Flexible
        expect(el.querySelector('.uv-pair')).toBeNull();
        for (const key of ['Monthly bills', 'Your load, every half-hour', 'The price, every half-hour', 'Negative-price half-hours by month']) {
            expect(charts.made[key].spec.tableCaption).toBe(key);
            expect(charts.made[key].spec.title).toBeUndefined();
        }
        el.remove();
    });

    it('hatches the load heatmap where there is no reading and says so under it', async () => {
        const hm = demoIns.heatmap;
        const load = Float32Array.from(hm.load);
        const filled = new Uint8Array(hm.filled.length);
        for (let i = 100; i < 148; i++) { load[i] = NaN; filled[i] = 1; }
        const ins = { ...demoIns, heatmap: { ...hm, load, filled }, coverage: { ...demoIns.coverage, filledSlots: 48, realPct: 99.6 } };
        const { el, charts } = await mountUsage({ ins });
        const spec = charts.made['Your load, every half-hour'].spec;
        expect(spec.mask).toBe(filled);
        expect(spec.maskLabel).toBe('No reading — estimated');
        const note = text(el.querySelector('.uv-note'));
        expect(note).toMatch(/^Hatched: no meter reading — 48 in gaps, filled in from the same time on similar days\./);
        expect(el.querySelector('.uv-note .key-hatch')).not.toBeNull();
        // the demo has a reading for every half-hour: no mask, and the March clock change is named as such
        const plain = await mountUsage();
        expect(plain.charts.made['Your load, every half-hour'].spec.mask).toBeNull();
        expect(text(plain.el.querySelector('.uv-note'))).toMatch(/^Every half-hour has a real meter reading\. The plain grey notch on .* is the hour the clocks went forward\./);
        el.remove(); plain.el.remove();
    });

    it('shows Agile against Flexible from insights.flexible, and hides it without', async () => {
        const { el, view } = await mountUsage();
        const card = view.v.parts.flex;
        expect(card.hidden).toBe(false);
        const t = text(card);
        expect(t).toContain('Agile against Flexible');
        expect(t).toContain(`Agile saved you ${ui.fmt.gbp(demoIns.flexible.deltaGbp)} against Flexible`);
        expect(t).toContain(ui.fmt.gbp(demoIns.totals.energyGbp + demoIns.totals.standingGbp));
        expect(t).toContain(ui.fmt.gbp(demoIns.flexible.energyGbp + demoIns.flexible.standingGbp));
        expect(t).toContain('E-1R-VAR-22-11-01-C');
        expect(text(view.v.parts.moreSub)).toContain('what Octopus Flexible would have cost');
        el.remove();
        // a CSV priced as if on Agile: not "what you paid"
        const csv = await mountUsage({ summary: { ...demoSummary, source: 'csv', priceBasis: 'agile', tariffCode: null } });
        const ct = text(csv.view.v.parts.flex);
        expect(ct).toContain('Your usage on Agile');
        expect(ct).toContain(`Agile comes out ${ui.fmt.gbp(demoIns.flexible.deltaGbp)} cheaper than Flexible`);
        expect(ct).not.toContain('What you paid');
        csv.el.remove();
        const none = await mountUsage({ ins: { ...demoIns, flexible: null } });
        expect(none.view.v.parts.flex.hidden).toBe(true);
        expect(text(none.view.v.parts.moreSub)).not.toContain('Flexible');
        none.el.remove();
    });
});

/* ── verdict ────────────────────────────────────────────────────────────────── */

const vrow = (id, o = {}) => ({
    id, name: `Option ${id}`, route: 'plugin', legal: 'ok', capexGbp: 500, savings: { typical: 100, p10: 90, p90: 110 },
    payback: { typical: 5 }, npv10Gbp: 300, net10Gbp: 500, confidence: { level: 'high', reasons: [], notes: [] }, badges: [], warnings: [],
    dominatedBy: null, upgrade: null, availableNow: true, preorder: false, battery: null, panels: null, ...o,
});

function fakeVerdict(extra = {}) {
    const ranked = [
        vrow('S05', { npv10Gbp: 1044 }), vrow('S06', { npv10Gbp: 900, priceOverride: true }), vrow('S01', { npv10Gbp: 800 }),
        vrow('S02', { npv10Gbp: 700 }), vrow('S03', { npv10Gbp: 600 }), vrow('S04', { npv10Gbp: 500 }), vrow('H1', { route: 'hardwired', npv10Gbp: 400 }),
        vrow('R1', { route: 'reference', legal: 'reference', name: 'Cut 100 W of always-on load', capexGbp: 0 }),
        vrow('S09', { dominatedBy: 'S05', npv10Gbp: 100 }), vrow('S10', { dominatedBy: 'S05', npv10Gbp: 90 }),
        vrow('W2', { route: 'whatif', legal: 'whatif', banner: 'Not legal in GB today: a plug-in battery.' }),
    ];
    return {
        stage: 'all', done: false, ranked, bestBuyId: 'S05', runnerUpId: 'S06',
        headline: { kind: 'buy', name: 'Option S05', lede: 'It **pays**.', why: null, equivalent: null, nextSteps: [] },
        context: { finance: { discountRate: 0.04, escalation: 0.02 }, days: 365, options: ranked.length, maxPaybackYears: 10, priceOverrides: ['S06'] },
        answers: {}, ...extra,
    };
}

describe('verdict optionGroups', () => {
    it('desktop: the options, the yardsticks under a divider, beaten (folded) and plans', () => {
        const V = fakeVerdict();
        const { groups, limited } = verdictMod.optionGroups(V);
        expect(limited).toBe(false);
        expect(groups.map(g => g.key)).toEqual(['main', 'refs', 'beaten', 'plans']);
        expect(groups[0].rows.map(r => r.id)).toEqual(['S05', 'S06', 'S01', 'S02', 'S03', 'S04', 'H1']);
        expect(groups[1]).toMatchObject({ divider: true, rows: [V.ranked[7]] });
        expect(groups[2]).toMatchObject({ title: 'Beaten on both price and savings', collapsible: true, collapsed: true });
        expect(groups[2].rows.map(r => r.id)).toEqual(['S09', 'S10']);
        expect(groups[3]).toMatchObject({ title: 'Not legal yet — for planning', note: 'Not legal in GB today: a plug-in battery.', collapsible: false, collapsed: false });
        expect(verdictMod.optionGroups(V, { beatenOpen: true }).groups[2].collapsed).toBe(false);
    });

    it('phones: five options, the rest with the yardsticks in a folded "More options", plans folded', () => {
        const V = fakeVerdict();
        const { groups, limited } = verdictMod.optionGroups(V, { phone: true });
        expect(limited).toBe(true);
        expect(groups.map(g => g.key)).toEqual(['main', 'more', 'beaten', 'plans']);
        expect(groups[0].rows).toHaveLength(5);
        expect(groups[1]).toMatchObject({ title: 'More options', collapsible: true, collapsed: true });
        expect(groups[1].rows.map(r => r.id)).toEqual(['S04', 'H1', 'R1']);
        expect(groups[3]).toMatchObject({ collapsible: true, collapsed: true });
        const open = verdictMod.optionGroups(V, { phone: true, showAll: true, plansOpen: true }).groups;
        expect(open[1].collapsed).toBe(false);
        expect(open[3].collapsed).toBe(false);
        // few enough options: nothing is held back
        expect(verdictMod.optionGroups({ ranked: V.ranked.slice(0, 3) }, { phone: true }).limited).toBe(false);
    });
});

describe('verdict view on the shared pieces', () => {
    async function mountVerdict(V, { phone = false } = {}) {
        const mm = window.matchMedia;
        window.matchMedia = () => ({ matches: phone, addEventListener() {}, removeEventListener() {} });
        const charts = stubCharts();
        const listeners = new Map();
        const verdictCalls = [];
        const ctx = {
            ui, fmt: ui.fmt, charts, store: stubStore(), router: { go: vi.fn() },
            data: {
                on: (evt, fn) => { listeners.set(evt, fn); return () => listeners.delete(evt); },
                summary: () => ({ ...demoSummary, source: 'octopus' }), status: () => 'ready',
                insights: async () => demoIns,
                verdict: ({ onPartial } = {}) => { verdictCalls.push(onPartial); return Promise.resolve(V); },
            },
        };
        const el = document.body.appendChild(ui.h('div'));
        const view = Object.create(verdictMod.default);
        view.mount(el, ctx);
        await settle();
        window.matchMedia = mm;
        return { view, el, charts, listeners, verdictCalls };
    }

    it('ranks every option in one grouped table, rows tagged with their id', async () => {
        const V = fakeVerdict();
        const { el, view } = await mountVerdict(V);
        const opt = view.v.parts.optBody;
        expect(opt.querySelectorAll('.tbl')).toHaveLength(1);
        const bodies = opt.querySelectorAll('tbody');
        expect(bodies.map(b => b.dataset.group)).toEqual(['main', 'refs', 'beaten', 'plans']);
        const ids = g => opt.querySelector(`tbody[data-group="${g}"]`).querySelectorAll('tr').filter(tr => !tr.classList.contains('tbl-group-head')).map(tr => tr.dataset.id);
        expect(ids('main')).toEqual(['S05', 'S06', 'S01', 'S02', 'S03', 'S04', 'H1']);
        expect(ids('refs')).toEqual(['R1']);
        expect(ids('beaten')).toEqual([]);                // folded until opened
        expect(ids('plans')).toEqual(['W2']);
        expect(opt.querySelector('tr[data-id="S05"]').classList.contains('is-highlight')).toBe(true);
        expect(opt.querySelector('tr[data-id="R1"]').classList.contains('vd-ref')).toBe(true);
        // the footnote is the table's own .tbl-note; the 10-yr value header carries help
        expect(text(opt.querySelector('.tbl-note'))).toMatch(/^10-yr value: what you’re ahead after 10 years/);
        expect(opt.querySelector('.th-help')).not.toBeNull();
        // opening the beaten group shows its rows, still tagged, and remembers it for the next refresh
        opt.querySelector('tbody[data-group="beaten"] .tbl-group-toggle').click();
        expect(ids('beaten')).toEqual(['S09', 'S10']);
        expect(text(opt.querySelector('tr[data-id="S09"]'))).toContain('beaten by Option S05');
        expect(view.v.beatenOpen).toBe(true);
        view.fillOptions(V);
        expect(ids('beaten')).toEqual(['S09', 'S10']);
        el.remove();
    });

    it('marks the options priced with the user’s own figure, and says the verdict uses it', async () => {
        const { el, view } = await mountVerdict(fakeVerdict());
        const opt = view.v.parts.optBody;
        expect(text(opt.querySelector('tr[data-id="S06"]'))).toContain('Your price');
        expect(text(opt.querySelector('tr[data-id="S05"]'))).not.toContain('Your price');
        const notice = text(opt.querySelector('.vd-override'));
        expect(notice).toContain('Option S06 is priced with your own figure from Compare');
        expect(notice).not.toContain('catalogue');
        el.remove();
        const none = await mountVerdict(fakeVerdict({ ranked: fakeVerdict().ranked.map(r => ({ ...r, priceOverride: undefined })) }));
        expect(none.view.v.parts.optBody.querySelector('.vd-override')).toBeNull();
        none.el.remove();
    });

    it('re-runs the verdict when Compare’s prices change (the overrides event)', async () => {
        const { el, listeners, verdictCalls } = await mountVerdict(fakeVerdict());
        expect(listeners.has('overrides')).toBe(true);
        expect(listeners.has('scenarios')).toBe(false);
        const before = verdictCalls.length;
        listeners.get('overrides')({ S06: { priceGbp: 300 } });
        await settle();
        expect(verdictCalls.length).toBe(before + 1);
        el.remove();
    });

    it('phones: a folded "More options" group in the same table', async () => {
        const { el, view } = await mountVerdict(fakeVerdict(), { phone: true });
        const opt = view.v.parts.optBody;
        const more = opt.querySelector('tbody[data-group="more"]');
        expect(more).not.toBeNull();
        const toggle = more.querySelector('.tbl-group-toggle');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        toggle.click();
        expect(view.showAllOptions).toBe(true);
        expect(opt.querySelector('tbody[data-group="more"]').querySelectorAll('tr[data-id]').map(tr => tr.dataset.id)).toEqual(['S04', 'H1', 'R1']);
        el.remove();
    });

    it('uses the station-inclusive 4–7pm share and names a station’s own panels', async () => {
        const station = vrow('U3', { route: 'ups', battery: { coupling: 'ups' }, panels: { count: 2, station: true } });
        const V = fakeVerdict({ stage: 'answers' });
        V.ranked = [...V.ranked, station];
        V.answers = {
            orientation: { status: 'ready', summary: 'No.', body: [], forId: 'S05',
                best: { az: 210, tilt: 40, kwh: 1000, pPerKwh: 16, gbp: 160, peakSharePct: 5, peakShareAllPct: 9 },
                cells: [{ az: 270, tilt: 90, kwh: 500, pPerKwh: 21, gbp: 105, peakSharePct: 30, peakShareAllPct: 35 }] },
            ups: { status: 'ready', summary: 'Saves £150/yr.', body: [], bestId: 'U3', realisticGbp: 150, bestCaseGbp: 170, peakCutGbp: 20, onlineGbp: 10 },
        };
        const { el, charts } = await mountVerdict(V);
        const orient = charts.made['Energy vs value'].spec;
        expect(orient.points.find(p => p.route === 'reference').extra[1].value).toBe(ui.fmt.pct(35));
        expect(orient.points.find(p => p.emphasis).extra[2].value).toBe(ui.fmt.pct(9));
        const ups = Object.values(charts.made).find(c => /Power station/.test(c.spec.tableCaption)).spec;
        expect(ups.tableCaption).toBe('Power station with its own 2 panels: what the automation is worth');
        expect(ups.note).toMatch(/includes what its 2 panels make/);
        expect(ups.title).toBeUndefined();
        el.remove();
    });
});

/* ── data ───────────────────────────────────────────────────────────────────── */

describe('data view', () => {
    const view = () => Object.create(dataMod.default);

    it('progress: error rows stay empty, and settle() puts a spinning step back to waiting', () => {
        const pl = ui.progressList(ui.loadStepsFor('octopus'));
        const run = { failed: null };
        const v = view();
        v.ctx = { ui };
        const on = v.progressHandler(pl, run);
        on({ step: 'usage', status: 'start' });
        on({ step: 'prices', status: 'start' });
        on({ step: 'usage', status: 'error', detail: 'Octopus said 500' });
        expect(run.failed).toBe('usage');
        expect(text(pl.el.querySelector('[data-key="usage"] .pl-detail'))).toBe('');
        pl.settle(run.failed);
        expect(pl.status('usage')).toBe('error');
        expect(pl.status('prices')).toBe('pending');
    });

    it('re-fetch specs take the meter and the region from store.connection', () => {
        const mk = (connection, summary) => {
            const v = view();
            v.ctx = { ui: { toast() {} }, store: { get: () => ({ connection }), getApiKey: () => 'sk_live_x' }, data: { summary: () => summary } };
            return v;
        };
        const oct = mk({ kind: 'octopus', accountNumber: 'A-1234ABCD', mpan: '1200000000001', priceBasis: 'mine' }, { source: 'octopus', priceBasis: 'mine' });
        expect(oct.specFor({}).mpan).toBe('1200000000001');
        expect(oct.specFor({ mpan: '1200000000009' }).mpan).toBe('1200000000009');
        // another account: the stored meter belongs to the old one
        expect(oct.specFor({ accountNumber: 'A-9999ZZZZ' }).mpan).toBeUndefined();
        const man = mk({ kind: 'manual', region: 'C', manual: { baseW: 300, otherKwhYr: 2700 }, location: { postcode: 'SW1A 1AA' }, priceBasis: 'agile' }, { source: 'manual', priceBasis: 'agile' });
        expect(man.specFor({}).region).toBe('C');
        expect(man.specFor({ region: 'J' }).region).toBe('J');
        expect(man.specFor({ region: null }).region).toBeUndefined();
        // DataHub.load persists the basis, flat price, date, meter and region: only a missing location is cleared here
        expect(view().extraConnection({ kind: 'csv', priceBasis: 'flat', flatP: 28 })).toEqual({ location: { postcode: null, lat: null, lon: null } });
        expect(view().extraConnection({ kind: 'octopus', location: { postcode: 'M1 1AE' } })).toEqual({});
    });

    it('rebuilding the device card keeps focus on the same control (ui.keepFocus)', () => {
        const v = view();
        const store = stubStore({ connection: { rememberKey: true } });
        store.get()._key = 'sk_live_x';
        v.ctx = { ui, store, data: { summary: () => ({ id: 'x' }) } };
        v.el = document.body.appendChild(ui.h('div', null, ui.h('section', { class: 'card' }, v.deviceBody({}))));
        const toggle = v.el.querySelector('[data-fk="dev-remember"] input');
        toggle.focus();
        v.refreshDevice();
        const now = document.activeElement;
        expect(now).not.toBe(toggle);
        expect(now.closest('[data-fk]').dataset.fk).toBe('dev-remember');
        // "Forget this device" forgets the meter picked on the account too
        store.set({ connection: { kind: 'octopus', accountNumber: 'A-1234ABCD', mpan: '1200000000001', region: null } });
        v.draft = {};
        v.forgetDevice();
        const go = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Forget this device');
        go.click();
        expect(store.get().connection).toMatchObject({ accountNumber: null, mpan: null, rememberKey: false });
        v.el.remove();
        document.querySelectorAll('dialog').forEach(d => d.remove());
    });
});

/* ── method ─────────────────────────────────────────────────────────────────── */

describe('method view', () => {
    it('the re-run bar says its dismiss keeps the edits', () => {
        const show = vi.fn();
        const self = { visible: true, ctx: { shell: { rerun: { show } }, data: { summary: () => ({}) } }, apply() {}, refocus() {} };
        methodMod.default.showRerun.call(self);
        expect(show).toHaveBeenCalledWith(expect.objectContaining({ dismissLabel: 'Later', actionLabel: 'Apply & re-run' }));
    });

    it('keepFocus: the rebuilt twin, else the section heading', () => {
        const self = { ctx: { ui } };
        const sec = document.body.appendChild(ui.h('section', { class: 'mv-sec' }, ui.h('h2', null, 'Assumptions')));
        const host = sec.appendChild(ui.h('div'));
        const build = withAdd => ui.put(host,
            ui.h('div', { dataset: { fk: 'fin-years' } }, ui.h('input', { value: '20' })),
            withAdd ? ui.h('button', { dataset: { fk: 'spot-add' } }, 'Add') : null);
        build(true);
        host.querySelector('input').focus();
        methodMod.default.keepFocus.call(self, host, () => build(true));
        expect(document.activeElement).toBe(host.querySelector('input'));
        host.querySelector('button').focus();
        methodMod.default.keepFocus.call(self, host, () => build(false));
        expect(document.activeElement).toBe(sec.querySelector('h2'));
        expect(sec.querySelector('h2').getAttribute('tabindex')).toBe('-1');
        // after Discard / Apply (the pressed button is gone) the field last edited comes first
        build(true);
        host.querySelector('button').focus();
        methodMod.default.keepFocus.call({ ...self, lastFk: 'fin-years' }, host, () => build(false));
        expect(document.activeElement).toBe(host.querySelector('input'));
        sec.remove();
    });

    it('settings import keeps a valid region and a meter that belongs to the account', () => {
        const normalizeAccount = s => ({ value: String(s).toUpperCase(), valid: /^A-[0-9A-F]{8}$/i.test(String(s)) });
        const ok = methodMod.sanitizeImport({ connection: { accountNumber: 'A-1234ABCD', mpan: '1200 0000 0000 1', region: '_c' } }, { normalizeAccount });
        expect(ok.connection).toEqual({ accountNumber: 'A-1234ABCD', mpan: '1200000000001', region: 'C' });
        expect(ok.ignored).toEqual([]);
        const bad = methodMod.sanitizeImport({ connection: { mpan: '12', region: 'Z', priceBasis: 'agile' } }, { normalizeAccount });
        expect(bad.connection).toEqual({ priceBasis: 'agile' });
        expect(bad.ignored).toHaveLength(2);
        // a meter without the account it belongs to is left out
        const orphan = methodMod.sanitizeImport({ connection: { mpan: '1200000000001' } }, { normalizeAccount });
        expect(orphan.connection).toBeNull();
        expect(orphan.ignored[0]).toMatch(/meter number/);
    });
});
