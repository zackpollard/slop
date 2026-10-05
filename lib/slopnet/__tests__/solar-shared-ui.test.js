/*
 * solar-shared-ui — wave D1b: the shared UI pieces and chart options, driven in node over
 * solar-fake-dom.js (a small DOM + a recording canvas):
 *   - ui.js: put, keepFocus, progressList.settle / error rows, figurePair, coverageChip, table
 *     groups / dividers / collapsible groups / header tooltips / note / followSort, toast focus
 *     return, the download icon;
 *   - app.js: the re-run bar (dismissLabel, scroll-padding class);
 *   - charts.js: null gaps, range-band series, heatmap mask + month thinning, tornado and
 *     horizontal-bar tick fitting, keyboard cursor kept across update(), table-toggle names and
 *     captions, zero slots of below-zero stacked layers, scatter labels vs payback labels, the
 *     polar 'pick' marker and tipLabel.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { installFakeDom } from './solar-fake-dom.js';

let dom, ui, charts, app;
const CSS_VARS = {
    '--series-pv': '#c98500', '--series-load': '#3987e5', '--series-import': '#d95926', '--series-export': '#199e70',
    '--series-battery': '#9085e9', '--chart-surface': '#1a1a16', '--chart-hatch': 'rgba(232,228,212,0.62)', '--accent': '#c4a24e',
    '--cat-1': '#3987e5', '--cat-2': '#d95926', '--tornado-low': '#3987e5', '--tornado-high': '#d95926',
};

beforeAll(async () => {
    dom = installFakeDom({ cssVars: CSS_VARS });
    ui = await import('../../../projects/solar-calculator/js/ui.js');
    charts = await import('../../../projects/solar-calculator/js/charts.js');
    app = await import('../../../projects/solar-calculator/js/app.js');
});
afterAll(() => dom.restore());

const mount = el => { document.body.appendChild(el); return el; };
const text = el => el.textContent.replace(/\s+/g, ' ').trim();

/* ── ui.js ──────────────────────────────────────────────────────────────────── */

describe('ui.put and ui.keepFocus', () => {
    it('put() drops null/false and flattens arrays instead of printing "null"', () => {
        const el = ui.h('div');
        ui.put(el, null, 'a', false, [ui.h('b', null, 'x'), null], 0);
        expect(el.textContent).toBe('ax0');
    });

    it('moves focus to the rebuilt twin of the pressed control (matched by data-fk)', () => {
        const host = mount(ui.h('div'));
        const build = n => host.replaceChildren(
            ui.h('h3', { tabindex: '-1', class: 'head' }, 'Section'),
            ui.h('button', { dataset: { fk: 'add' } }, `Add ${n}`),
            ui.h('div', { dataset: { fk: 'unit' } }, ui.h('input', { value: 'kWh' })));
        build(1);
        host.querySelector('[data-fk="add"]').focus();
        const got = ui.keepFocus(host, () => build(2));
        expect(document.activeElement).toBe(host.querySelector('[data-fk="add"]'));
        expect(got.textContent).toBe('Add 2');
        // a holder resolves to its control
        host.querySelector('input').focus();
        ui.keepFocus(host, () => build(3));
        expect(document.activeElement).toBe(host.querySelector('input'));
        host.remove();
    });

    it('a deliberate target wins; a vanished or disabled twin falls back; focus outside is left alone', () => {
        const host = mount(ui.h('div'));
        const outside = mount(ui.h('button', null, 'elsewhere'));
        const build = ({ twin = true, disabled = false } = {}) => ui.put(host,
            ui.h('h3', { tabindex: '-1', class: 'head' }, 'Section'),
            twin ? ui.h('button', { dataset: { fk: 'go' }, disabled }, 'Go') : null,
            ui.h('button', { class: 'next' }, 'Next'));
        build();
        host.querySelector('[data-fk="go"]').focus();
        ui.keepFocus(host, () => build(), '.next');
        expect(document.activeElement.className).toBe('next');

        host.querySelector('[data-fk="go"]').focus();
        ui.keepFocus(host, () => build({ twin: false }), null, { fallback: '.head' });
        expect(document.activeElement.className).toBe('head');

        build();
        host.querySelector('[data-fk="go"]').focus();
        ui.keepFocus(host, () => build({ disabled: true }), null, { fallback: () => host.querySelector('.head') });
        expect(document.activeElement.className).toBe('head');

        outside.focus();
        ui.keepFocus(host, () => build(), null, { fallback: '.head' });
        expect(document.activeElement).toBe(outside);
        host.remove(); outside.remove();
    });

    it('controlIn prefers the checked radio of a group', () => {
        const g = ui.segmented({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'b' });
        expect(ui.controlIn(g).textContent).toBe('B');
    });
});

describe('ui.progressList', () => {
    it('settle() fails the given step and puts every spinning row back to waiting', () => {
        const pl = ui.progressList(ui.loadStepsFor('csv'));
        pl.set('usage', 'start');
        pl.set('prices', 'active');
        expect(pl.status('usage')).toBe('active');
        pl.settle('usage');
        expect(pl.status('usage')).toBe('error');
        expect(pl.status('prices')).toBe('pending');
        expect(pl.el.querySelectorAll('.pl-row.is-active')).toHaveLength(0);
        pl.settle();   // nothing failed (a cancel): only the spinners reset
        expect(pl.status('usage')).toBe('error');
    });

    it('an error row keeps the message out of its detail (the panel says it once) unless asked', () => {
        const pl = ui.progressList(ui.loadStepsFor('demo'));
        pl.set('usage', 'done', '17,520 half-hours');
        pl.set('weather', 'error', 'Open-Meteo timed out');
        const row = k => pl.el.querySelector(`[data-key="${k}"]`);
        expect(row('usage').querySelector('.pl-detail').textContent).toBe('17,520 half-hours');
        expect(row('weather').querySelector('.pl-detail').textContent).toBe('');
        expect(row('weather').querySelector('.sr-only').textContent).toBe('failed');
        const verbose = ui.progressList(ui.loadStepsFor('demo'), { errorDetail: true });
        verbose.set('weather', 'error', 'Open-Meteo timed out');
        expect(verbose.el.querySelector('[data-key="weather"] .pl-detail').textContent).toBe('Open-Meteo timed out');
        // unknown steps still get a labelled row
        pl.set('climatology', 'done');
        expect(text(row('climatology'))).toContain('20-year sunshine averages');
    });
});

describe('ui.figurePair, ui.coverageChip, download icon', () => {
    it('figurePair renders two labelled figures, the strong one marked', () => {
        const el = ui.figurePair([{ label: 'At 4–7pm', value: '35.4p', strong: true }, { label: 'Rest of the day', value: null, unit: 'avg' }]);
        const items = el.querySelectorAll('.fig-pair-item');
        expect(items).toHaveLength(2);
        expect(items[0].classList.contains('is-strong')).toBe(true);
        expect(text(items[0])).toBe('At 4–7pm35.4p');
        expect(text(items[1])).toBe('Rest of the day—avg');
    });

    it('coverageChip: real-reading share, estimated days, amber below 95%, null when unknown', () => {
        const full = ui.coverageChip({ realPct: 100, extrapolatedSlots: 0 });
        expect(full.textContent).toBe('100% real readings');
        expect(full.getAttribute('href')).toBe('#data');
        expect(full.classList.contains('is-warn')).toBe(false);
        const part = ui.coverageChip({ realPct: 53.71, extrapolatedSlots: 166 * 48 }, { href: '#data?edit=prices' });
        expect(part.textContent).toBe('53.7% real readings · 166 days estimated');
        expect(part.classList.contains('is-warn')).toBe(true);
        expect(part.getAttribute('href')).toBe('#data?edit=prices');
        expect(ui.coverageChip(null)).toBe(null);
        expect(ui.coverageChip({ realPct: NaN })).toBe(null);
    });

    it('has a download icon distinct from upload', () => {
        const d = ui.icon('download').querySelector('path').getAttribute('d');
        const u = ui.icon('upload').querySelector('path').getAttribute('d');
        expect(d).toBeTruthy();
        expect(d).not.toBe(u);
        expect(d).not.toBe(ui.icon('nope').querySelector('path').getAttribute('d'));
    });
});

describe('ui.table groups, header tooltips, notes', () => {
    const columns = [
        { key: 'name', label: 'Option' },
        { key: 'cost', label: 'Cost', align: 'right', help: 'Upfront, including the electrician' },
        { key: 'sav', label: 'Saves/yr', align: 'right', mobile: 'primary' },
        { key: 'conf', label: 'Confidence', sortable: false, help: 'How sure we are', mobile: 'hide' },
    ];
    const rows = n => Array.from({ length: n }, (_, i) => ({ name: `Kit ${i}`, cost: 100 * (n - i), sav: 10 * i, conf: 'High' }));

    it('one <tbody> per group with a heading row; dividers; empty groups left out; sorting within groups', () => {
        const t = mount(ui.table({
            columns, sortKey: 'cost',
            groups: [
                { key: 'ranked', rows: rows(3) },
                { key: 'beaten', title: 'Beaten on price and savings', note: 'Cheaper options save more', rows: rows(2) },
                { key: 'empty', title: 'Nothing here', rows: [] },
                { key: 'future', divider: true, rows: [{ name: 'Plug-in battery (future rules)', cost: 1700, sav: 380 }] },
            ],
        }));
        const bodies = t.querySelectorAll('tbody');
        expect(bodies.map(b => b.dataset.group)).toEqual(['ranked', 'beaten', 'future']);
        expect(bodies[0].querySelector('.tbl-group-head')).toBe(null);
        expect(text(bodies[1].querySelector('.tbl-group-head'))).toBe('Beaten on price and savingsCheaper options save more');
        expect(bodies[1].querySelector('.tbl-group-head th').getAttribute('colspan')).toBe('4');
        expect(bodies[2].classList.contains('tbl-divider')).toBe(true);
        // ascending cost within each group, groups keep their order
        expect(bodies[0].querySelectorAll('tr').map(tr => tr.querySelector('th').textContent)).toEqual(['Kit 2', 'Kit 1', 'Kit 0']);
        expect(t.querySelector('table').classList.contains('tbl-grouped')).toBe(true);
        t.remove();
    });

    it('a collapsible group toggles its rows from a button that keeps focus', () => {
        const onToggle = vi.fn();
        const t = mount(ui.table({ columns, onToggle, groups: [{ key: 'top', rows: rows(1) }, { key: 'beaten', title: 'Beaten', rows: rows(3), collapsible: true, collapsed: true }] }));
        const btn = () => t.querySelector('.tbl-group-toggle');
        expect(btn().getAttribute('aria-expanded')).toBe('false');
        expect(text(btn())).toBe('Beaten3');
        expect(t.querySelector('[data-group="beaten"]').querySelectorAll('tr')).toHaveLength(1);   // just the heading
        btn().focus();
        btn().click();
        expect(btn().getAttribute('aria-expanded')).toBe('true');
        expect(t.querySelector('[data-group="beaten"]').querySelectorAll('tr')).toHaveLength(4);
        expect(document.activeElement).toBe(btn());
        expect(onToggle).toHaveBeenCalledWith('beaten', true);
        // the open state survives new data
        t.setGroups([{ key: 'beaten', title: 'Beaten', rows: rows(2), collapsible: true, collapsed: true }]);
        expect(t.querySelector('[data-group="beaten"]').querySelectorAll('tr')).toHaveLength(3);
        t.remove();
    });

    it('header help text becomes a tooltip and accessible description; sort keeps focus on its header', () => {
        const onSort = vi.fn();
        const t = mount(ui.table({ columns, rows: rows(3), onSort }));
        const ths = t.querySelectorAll('thead th');
        const costBtn = ths[1].querySelector('button.th-sort');
        expect(costBtn.getAttribute('aria-description')).toBe('Upfront, including the electrician');
        expect(costBtn.querySelector('.th-help').textContent).toBe('Cost');
        // a non-sortable column's help sits on a focusable span
        const tip = ths[3].querySelector('.th-tip');
        expect(tip.getAttribute('tabindex')).toBe('0');
        expect(tip.getAttribute('aria-description')).toBe('How sure we are');
        costBtn.focus();
        costBtn.click();
        expect(onSort).toHaveBeenCalledWith('-cost');
        expect(document.activeElement.dataset.fk).toBe('tbl-sort:cost');
        expect(t.sortKey()).toBe('-cost');
        t.remove();
    });

    it('note renders under the table; followSort makes the sorted column the phone card figure', () => {
        const t = ui.table({ columns, rows: rows(2), note: ui.h('a', { href: '#compare' }, 'Is the extra worth it?'), followSort: true, sortKey: '-cost' });
        expect(t.querySelector('.tbl-note a').textContent).toBe('Is the extra worth it?');
        const firstRow = t.querySelector('tbody tr');
        expect(firstRow.querySelectorAll('td')[0].classList.contains('m-primary')).toBe(true);    // cost (sorted)
        expect(firstRow.querySelectorAll('td')[1].classList.contains('m-show')).toBe(true);       // sav, demoted
        t.setSort('conf');
        expect(t.querySelector('tbody tr').querySelectorAll('td')[2].classList.contains('m-primary')).toBe(true);   // hidden col shown when sorted
        // plain rows still work, and update() leaves group mode
        t.setGroups([{ key: 'a', rows: rows(1) }]);
        t.update(rows(2));
        expect(t.querySelectorAll('tbody')).toHaveLength(1);
        expect(t.querySelector('table').classList.contains('tbl-grouped')).toBe(false);
    });

    it('review: an untitled group asked to be collapsible and collapsed still shows its rows (it has no button to reopen it)', () => {
        const t = mount(ui.table({ columns, groups: [{ key: 'top', rows: rows(2) }, { key: 'rest', divider: true, collapsible: true, collapsed: true, rows: rows(3) }] }));
        const rest = t.querySelector('[data-group="rest"]');
        expect(rest.classList.contains('is-collapsed')).toBe(false);
        expect(rest.querySelectorAll('tr')).toHaveLength(3);
        expect(t.querySelector('.tbl-group-toggle')).toBe(null);
        t.remove();
    });
});

describe('ui.toast', () => {
    it('pressing its action returns focus to where it was, not <body>', () => {
        const field = mount(ui.h('input'));
        field.focus();
        const undo = vi.fn();
        ui.toast('Saved', { action: { label: 'Undo', onClick: undo }, timeoutMs: 0 });
        const btn = document.body.querySelector('.toast-action');
        btn.focus();
        btn.click();
        expect(undo).toHaveBeenCalled();
        expect(document.activeElement).toBe(field);
        field.remove();
    });

    it('an action that moves focus itself is respected', () => {
        const a = mount(ui.h('button', null, 'A'));
        const b = mount(ui.h('button', null, 'B'));
        a.focus();
        ui.toast('Removed', { action: { label: 'Undo', onClick: () => b.focus() }, timeoutMs: 0 });
        const btns = document.body.querySelectorAll('.toast-action');
        const btn = btns[btns.length - 1];
        btn.focus();
        btn.click();
        expect(document.activeElement).toBe(b);
        a.remove(); b.remove();
    });
});

describe('ui.connectCard', () => {
    const cardWith = (conn, load) => {
        const ctx = { store: { get: () => ({ connection: { location: {}, ...conn } }), set: vi.fn() }, data: { load } };
        const card = mount(ui.connectCard(ctx));
        const submit = (key, acct = '') => {
            card.querySelector('input[name="octopus-key"]').value = key;
            card.querySelector('input[name="octopus-account"]').value = acct;
            card.querySelector('form').dispatchEvent({ type: 'submit', bubbles: true, preventDefault() {} });
        };
        return { card, submit };
    };

    it('re-sends the meter picked last time while it is the same account', async () => {
        const load = vi.fn(async () => ({}));
        const { card, submit } = cardWith({ accountNumber: 'A-1234ABCD', mpan: '1900000000001' }, load);
        submit('sk_live_abcdef', 'a-1234abcd');
        await new Promise(r => setTimeout(r, 0));
        expect(load.mock.calls[0][0]).toMatchObject({ kind: 'octopus', accountNumber: 'A-1234ABCD', mpan: '1900000000001' });
        submit('sk_live_abcdef', 'A-9999ZZZZ');
        await new Promise(r => setTimeout(r, 0));
        expect(load.mock.calls[1][0]).not.toHaveProperty('mpan');
        card.remove();
    });

    it('a failed load settles the progress list: the failed step is marked and nothing keeps spinning', async () => {
        const load = vi.fn(async (spec, { onProgress }) => {
            onProgress({ step: 'account', status: 'done' });
            onProgress({ step: 'usage', status: 'start' });
            onProgress({ step: 'prices', status: 'start' });
            throw Object.assign(new Error('No electricity meter was found on this account.'), { code: 'NO_SMART_DATA', step: 'usage', action: 'useDemo' });
        });
        const { card, submit } = cardWith({}, load);
        submit('sk_live_abcdef');
        await new Promise(r => setTimeout(r, 0));
        const status = k => card.querySelector(`.pl-row[data-key="${k}"]`).className;
        expect(status('account')).toContain('is-done');
        expect(status('usage')).toContain('is-error');
        expect(status('prices')).toContain('is-pending');
        expect(card.querySelectorAll('.pl-row.is-active')).toHaveLength(0);
        expect(text(card.querySelector('.connect-error'))).toContain('No electricity meter was found');
        card.remove();
    });
});

/* ── app.js re-run bar ──────────────────────────────────────────────────────── */

describe('shell re-run bar', () => {
    it('shows a custom dismiss label, adds the scroll-padding class while open, and clears it on either button', () => {
        const el = mount(ui.h('div', { hidden: true }));
        const root = ui.h('html');
        const delayed = [];
        const bar = app.createRerunBar(el, { root, raf: fn => fn(), delay: fn => delayed.push(fn) });
        const onRun = vi.fn(), onDismiss = vi.fn();
        bar.show({ text: 'Settings changed', actionLabel: 'Apply & re-run', dismissLabel: 'Discard', onRun, onDismiss });
        expect(el.hidden).toBe(false);
        expect(el.classList.contains('show')).toBe(true);
        expect(root.classList.contains('rerun-open')).toBe(true);
        const labels = el.querySelectorAll('button').map(b => b.textContent);
        expect(labels).toEqual(['Discard', 'Apply & re-run']);
        el.querySelectorAll('button')[0].click();
        expect(onDismiss).toHaveBeenCalled();
        expect(root.classList.contains('rerun-open')).toBe(false);
        delayed.forEach(f => f());
        expect(el.hidden).toBe(true);
        // defaults: 'Not now' only with onDismiss
        bar.show({ onRun });
        expect(el.querySelectorAll('button').map(b => b.textContent)).toEqual(['Re-run']);
        bar.show({ onRun, onDismiss });
        expect(el.querySelectorAll('button')[0].textContent).toBe('Not now');
        el.querySelectorAll('button')[1].click();
        expect(onRun).toHaveBeenCalled();
        expect(bar.isOpen()).toBe(false);
        el.remove();
    });
});

/* ── charts.js ──────────────────────────────────────────────────────────────── */

const host = () => mount(ui.h('div'));
/* The calls between the last beginPath before `marker` and `marker` (a property assignment). */
function pathBefore(calls, test) {
    const at = calls.findIndex(test);
    let b = at;
    while (b >= 0 && calls[b][0] !== 'beginPath') b--;
    return calls.slice(b, at);
}

describe('chart helpers', () => {
    it('valueLookup: null, undefined, NaN, Infinity and "" are gaps — never zero', () => {
        const f = charts.valueLookup([1, null, undefined, NaN, Infinity, '', '2.5', 0]);
        expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(f)).toEqual([1, null, null, null, null, null, 2.5, 0, null]);
    });

    it('fitTicks keeps the tight domain and labels every 2nd/3rd tick (0 always) when they would collide', () => {
        const wide = charts.fitTicks(2.2, 3.4, 600, () => 30);
        expect(wide.show.every(Boolean)).toBe(true);
        const narrow = charts.fitTicks(2.2, 3.4, 200, () => 30, { gap: 12 });
        expect([narrow.min, narrow.max]).toEqual([wide.min, wide.max]);          // same scale, fewer labels
        const span = narrow.max - narrow.min;
        const pos = narrow.ticks.map(v => ((v - narrow.min) / span) * 200).filter((_, i) => narrow.show[i]);
        for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeGreaterThanOrEqual(30 + 12);
        expect(narrow.show.filter(Boolean).length).toBeLessThan(wide.ticks.length);
        const signed = charts.fitTicks(-16, 155, 173, v => String(v).length * 6 + 6, { gap: 14 });
        expect(signed.min).toBeGreaterThanOrEqual(-50);                         // not stretched to −100
        expect(signed.show[signed.ticks.indexOf(0)]).toBe(true);
        // nothing fits at all: just the two ends
        const tiny = charts.fitTicks(0, 1000, 20, () => 40);
        expect(tiny.show.filter(Boolean).length).toBeLessThanOrEqual(2);
    });

    it('thinTicks steps over months that would collide, always keeping the first', () => {
        const months = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
        const wide = months.map((m, i) => [i * 80, m]);
        expect(charts.thinTicks(wide, () => 20)).toHaveLength(12);
        const tight = months.map((m, i) => [i * 25, m]);   // 25 px apart, 20 px labels + 8 gap → every 2nd
        expect(charts.thinTicks(tight, () => 20).map(t => t[1])).toEqual(['Oct', 'Dec', 'Feb', 'Apr', 'Jun', 'Aug']);
        const tighter = months.map((m, i) => [i * 10, m]);
        expect(charts.thinTicks(tighter, () => 20).map(t => t[1])).toEqual(['Oct', 'Jan', 'Apr', 'Jul']);
        expect(charts.thinTicks([], () => 1)).toEqual([]);
    });

    it('review: thinScaleLabels keeps a fixed scale and only drops labels (0 kept), ends only as a last resort', () => {
        const sc = charts.niceScale(-20, 180, 5);
        const wide = charts.thinScaleLabels(sc, 600, () => 30);
        expect(wide.ticks).toEqual(sc.ticks);
        expect(wide.show.every(Boolean)).toBe(true);
        const narrow = charts.thinScaleLabels(sc, 150, () => 30, { gap: 14 });
        expect([narrow.min, narrow.max, narrow.ticks]).toEqual([sc.min, sc.max, sc.ticks]);
        expect(narrow.show[sc.ticks.indexOf(0)]).toBe(true);
        const pos = sc.ticks.map(v => ((v - sc.min) / (sc.max - sc.min)) * 150).filter((_, i) => narrow.show[i]);
        for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeGreaterThanOrEqual(30 + 14);
        const tiny = charts.thinScaleLabels(sc, 10, () => 30);
        expect(tiny.show.filter(Boolean)).toHaveLength(2);
        expect([tiny.show[0], tiny.show.at(-1)]).toEqual([true, true]);
    });
});

describe('line charts', () => {
    it('a null in a series is a gap: the line restarts after it instead of dropping to zero', () => {
        const el = host();
        const c = charts.createLine(el, { x: { values: ['a', 'b', 'c', 'd', 'e'] }, series: [{ key: 'l', label: 'Load', color: '#ff0000', values: [1, null, 3, NaN, 5] }] });
        const ctx = el.querySelector('canvas').getContext('2d');
        const path = pathBefore(ctx.calls, c2 => c2[0] === '=strokeStyle' && c2[1] === '#ff0000');
        expect(path.filter(x => x[0] === 'moveTo')).toHaveLength(3);
        expect(path.filter(x => x[0] === 'lineTo')).toHaveLength(0);
        c.setTable(true);
        const cells = el.querySelectorAll('.chart-table tbody tr').map(tr => tr.querySelectorAll('td')[0].textContent);
        expect(cells).toEqual(['1.00', '—', '3.00', '—', '5.00']);
        c.destroy();
    });

    it('a range-band series fills lo–hi, reads "lo–hi" in the tooltip and has two table columns', () => {
        const el = host();
        const fmtW = v => `${Math.round(v)} W`;
        const c = charts.createLine(el, {
            title: 'Always-on load by month',
            x: { values: ['Oct', 'Nov', 'Dec'] }, y: { format: fmtW },
            series: [
                { key: 'band', label: 'Most days (p10–p90)', color: '#3987e5', lo: [520, 530, null], hi: [600, 610, 640] },
                { key: 'w', label: 'Always-on', color: '#3987e5', values: [560, 571, 590] },
            ],
        });
        const legend = el.querySelectorAll('.chart-legend li');
        expect(legend.map(li => li.textContent)).toEqual(['Most days (p10–p90)', 'Always-on']);
        expect(legend[0].querySelector('.key-range')).toBeTruthy();
        const ctx = el.querySelector('canvas').getContext('2d');
        expect(ctx.calls.some(x => x[0] === '=fillStyle' && /^rgba\(57,135,229,0\.15\)$/.test(x[1]))).toBe(true);
        // keyboard: first point's tooltip
        el.querySelector('canvas').dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
        const tip = el.querySelector('.chart-tip');
        expect(text(tip)).toContain('520 W–600 W');
        expect(text(tip)).toContain('560 W');
        c.setTable(true);
        const head = el.querySelectorAll('.chart-table thead th').map(th => th.textContent.replace(/[▲▼]/g, ''));
        expect(head).toEqual(['', 'Most days (p10–p90) (low)', 'Most days (p10–p90) (high)', 'Always-on']);
        const last = el.querySelectorAll('.chart-table tbody tr')[2].querySelectorAll('td').map(td => td.textContent);
        expect(last).toEqual(['—', '640 W', '590 W']);
        c.destroy();
    });

    it('keeps the keyboard cursor across update() while focused; drops a mouse hover', () => {
        const el = host();
        const spec = vals => ({ title: 'Savings', x: { values: ['a', 'b', 'c', 'd'] }, series: [{ key: 's', label: 'S', values: vals }] });
        const c = charts.createLine(el, spec([1, 2, 3, 4]));
        const canvas = el.querySelector('canvas');
        canvas.focus();
        for (let i = 0; i < 3; i++) canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
        expect(text(el.querySelector('.chart-tip'))).toMatch(/^c/);
        c.update(spec([5, 6, 7, 8]));
        expect(el.querySelector('.chart-tip').classList.contains('show')).toBe(true);
        expect(text(el.querySelector('.chart-tip'))).toMatch(/^c7/);
        // fewer points: clamped to the last one
        c.update({ ...spec([1, 2]), x: { values: ['a', 'b'] } });
        expect(text(el.querySelector('.chart-tip'))).toMatch(/^b2/);
        canvas.blur();
        c.update(spec([1, 2, 3, 4]));
        expect(el.querySelector('.chart-tip').classList.contains('show')).toBe(false);
        c.destroy();
    });

    it('each table toggle is named after its chart; the table caption falls back to ariaLabel', () => {
        const el = host();
        const c = charts.createLine(el, { ariaLabel: 'Average load by half-hour', x: { values: [0, 1] }, series: [{ key: 'a', values: [1, 2] }] });
        expect(el.querySelector('.chart-toggle').getAttribute('aria-label')).toBe('Table: Average load by half-hour');
        expect(el.querySelector('.chart-toggle').textContent).toBe('Table');
        c.setTable(true);
        expect(el.querySelector('.chart-table caption').textContent).toBe('Average load by half-hour');
        c.update({ tableCaption: 'Load, kWh per half-hour', title: 'Load', x: { values: [0, 1] }, series: [{ key: 'a', values: [1, 2] }] });
        expect(el.querySelector('.chart-table caption').textContent).toBe('Load, kWh per half-hour');
        expect(el.querySelector('.chart-toggle').getAttribute('aria-label')).toBe('Table: Load, kWh per half-hour');
        const bare = host();
        charts.createLine(bare, { x: { values: [0] }, series: [{ key: 'a', values: [1] }] }).setTable(true);
        expect(bare.querySelector('.chart-toggle').getAttribute('aria-label')).toBe(null);
        expect(bare.querySelector('caption').textContent).toBe('line data');
        c.destroy();
    });
});

describe('stacked areas', () => {
    it('an empty half-hour of a below-zero layer stays at zero instead of jumping to the positive top', () => {
        const el = host();
        const c = charts.createStackedArea(el, {
            x: { values: ['a', 'b', 'c'] },
            series: [{ key: 'pv', label: 'Solar', color: '#aa0000', values: [1, 1, 1] }, { key: 'exp', label: 'Export', color: '#00aa00', values: [-1, 0, -1] }],
        });
        const ctx = el.querySelector('canvas').getContext('2d');
        const poly = color => {
            const p = pathBefore(ctx.calls, x => x[0] === '=fillStyle' && x[1] === color).filter(x => x[0] === 'moveTo' || x[0] === 'lineTo');
            return { upper: p.slice(0, 3).map(x => x[2]), lower: p.slice(3).reverse().map(x => x[2]) };
        };
        const pv = poly('#aa0000'), ex = poly('#00aa00');
        const zeroY = pv.lower[1];
        expect(ex.upper[1]).toBeCloseTo(zeroY, 6);     // was pv.upper[1] (the top of the solar layer)
        expect(ex.upper[0]).toBeGreaterThan(zeroY);   // below zero on screen
        c.destroy();
    });

    it('a slot where every layer is missing splits the stack (a gap, not a zero)', () => {
        const el = host();
        const c = charts.createStackedArea(el, { x: { values: ['a', 'b', 'c', 'd', 'e'] }, series: [{ key: 'a', color: '#aa0000', values: [1, 2, null, 2, 1] }] });
        const ctx = el.querySelector('canvas').getContext('2d');
        const fills = ctx.calls.filter((x, i) => x[0] === 'fill' && ctx.calls[i - 1]?.[0] === '=fillStyle' && ctx.calls[i - 1][1] === '#aa0000');
        expect(fills).toHaveLength(2);
        c.destroy();
    });
});

describe('heatmaps', () => {
    const DAYS = 365;
    const dates = Array.from({ length: DAYS }, (_, d) => new Date(Date.UTC(2025, 9, 1 + d)).toISOString().slice(0, 10));
    const HH = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
    const values = Float32Array.from({ length: DAYS * 48 }, (_, i) => (i % 48) / 48);

    it('mask cells are hatched, keyed in the scale, noted in the tooltip and marked in the table', () => {
        const el = host();
        const mask = new Uint8Array(DAYS * 48);
        for (let k = 0; k < 48; k++) mask[40 * 48 + k] = 1;   // day 41 estimated
        const c = charts.createHeatmap(el, { rows: DAYS, cols: 48, values, rowLabels: dates, colLabels: HH, transpose: true, mask, maskLabel: 'Estimated', format: v => v.toFixed(2) });
        const ctx = el.querySelector('canvas').getContext('2d');
        expect(ctx.calls.filter(x => x[0] === 'drawImage')).toHaveLength(2);   // cells + hatch overlay
        expect(text(el.querySelector('.chart-scale'))).toContain('Estimated');
        expect(el.querySelector('.chart-scale .key-hatch')).toBeTruthy();
        // keyboard to day 41 (index 40), first half-hour
        const canvas = el.querySelector('canvas');
        canvas.focus();
        canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
        for (let i = 0; i < 40; i++) canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} });
        expect(text(el.querySelector('.chart-tip'))).toContain('Estimated');
        canvas.dispatchEvent({ type: 'keydown', key: 'ArrowLeft', preventDefault() {} });
        expect(text(el.querySelector('.chart-tip'))).not.toContain('Estimated');
        c.setTable(true);
        const row41 = el.querySelectorAll('.chart-table tbody tr')[40];
        expect(row41.querySelectorAll('td')[0].textContent).toBe('0.00 (estimated)');
        expect(el.querySelectorAll('.chart-table tbody tr')[39].querySelectorAll('td')[0].textContent).toBe('0.00');
        // no mask → no overlay, no key
        c.update({ rows: DAYS, cols: 48, values, rowLabels: dates, colLabels: HH, transpose: true });
        expect(el.querySelector('.chart-scale .key-hatch')).toBe(null);
        c.destroy();
    });

    it('month labels are thinned on a narrow plot (no "OcNov")', () => {
        const draw = width => {
            const el = host();
            el._clientWidth = width;
            const c = charts.createHeatmap(el, { rows: DAYS, cols: 48, values, rowLabels: dates, colLabels: HH, transpose: true });
            const plot = el.querySelector('.chart-plot');
            plot._clientWidth = width;
            c.update({ rows: DAYS, cols: 48, values, rowLabels: dates, colLabels: HH, transpose: true });
            const ctx = el.querySelector('canvas').getContext('2d');
            const lastClear = ctx.calls.map(x => x[0]).lastIndexOf('clearRect');
            const labels = ctx.calls.slice(lastClear).filter(x => x[0] === 'fillText' && /^[A-Z][a-z]{2}$/.test(x[1]));
            c.destroy();
            return labels;
        };
        const wide = draw(1200);
        const narrow = draw(330);
        expect(wide.length).toBeGreaterThanOrEqual(12);
        expect(narrow.length).toBeLessThan(wide.length);
        const xs = narrow.map(x => x[2]);
        for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(18 + 8 - 0.01);
    });
});

describe('tornado, horizontal bars, scatter, polar', () => {
    const rows = [
        { label: 'Agile price level', low: 3.3, high: 2.2, lowLabel: 'prices −20%', highLabel: 'prices +20%' },
        { label: 'Shading', low: 2.6, high: 3.0, lowLabel: 'no shade', highLabel: '15% shaded' },
        { label: 'Weather year', low: 2.9, high: 2.5, lowLabel: 'dull', highLabel: 'sunny' },
    ];
    const tickLabels = (el, re) => {
        const ctx = el.querySelector('canvas').getContext('2d');
        const lastClear = ctx.calls.map(x => x[0]).lastIndexOf('clearRect');
        return ctx.calls.slice(lastClear).filter(x => x[0] === 'fillText' && re.test(x[1]));
    };

    it('tornado ticks thin out on a phone-width plot and never overlap', () => {
        const el = host();
        const spec = { center: 2.7, centerLabel: 'Payback 2.7 yrs', rows, format: v => `${v.toFixed(1)} yrs` };
        const c = charts.createTornado(el, spec);
        // the axis row is the lowest text on the canvas
        const axis = () => { const all = tickLabels(el, /^\d\.\d yrs$/); const y = Math.max(...all.map(x => x[3])); return all.filter(x => x[3] === y); };
        const wide = axis().length;
        el.querySelector('.chart-plot')._clientWidth = 343;
        c.update(spec);
        const ticks = axis();
        expect(ticks.length).toBeLessThanOrEqual(wide);
        const xs = ticks.map(x => x[2]).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(7 * 6 + 12 - 0.01);
        c.destroy();
    });

    it('tornado: full bar-end labels at desktop width; at 343 px every value is still drawn', () => {
        const el = host();
        const spec = { center: 2.7, centerLabel: 'Payback 2.7 yrs', rows, format: v => v.toFixed(1) };
        const c = charts.createTornado(el, spec);
        const all = () => tickLabels(el, /./).map(x => x[1]);
        for (const r of rows) {
            expect(all()).toContain(`${r.lowLabel} · ${r.low.toFixed(1)}`);
            expect(all()).toContain(`${r.highLabel} · ${r.high.toFixed(1)}`);
        }
        el.querySelector('.chart-plot')._clientWidth = 343;
        c.update(spec);
        const drawn = all();
        for (const r of rows) for (const [v, lab] of [[r.low, r.lowLabel], [r.high, r.highLabel]]) {
            expect(drawn.some(t => t === v.toFixed(1) || t === `${lab} · ${v.toFixed(1)}`), `${lab} ${v}`).toBe(true);
        }
        c.destroy();
    });

    it('horizontal bars: value ticks fitted to the width and the last label kept inside the canvas', () => {
        const el = host();
        const c = charts.createBars(el, { horizontal: true, categories: ['Battery from solar', 'From cheap slots', 'Standby'], y: { format: v => `£${v}` },
            series: [{ key: 's', label: 'Saves', values: [99, 155, -16] }] });
        el.querySelector('.chart-plot')._clientWidth = 343;
        c.update({ horizontal: true, categories: ['Battery from solar', 'From cheap slots', 'Standby'], y: { format: v => `£${v}` }, series: [{ key: 's', label: 'Saves', values: [99, 155, -16] }] });
        const money = tickLabels(el, /^-?£-?\d+$/);
        const ticks = money.filter(x => x[3] === Math.max(...money.map(m => m[3])));   // the axis row, not bar values
        const xs = ticks.map(x => x[2]).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(4 * 6 + 14 - 0.01);
        for (const t of ticks) expect(t[2] + (t[1].length * 6) / 2).toBeLessThanOrEqual(343);
        c.destroy();
    });

    it('review: horizontal bars with an explicit y.min / y.max keep that domain and thin only the labels on a phone', () => {
        const el = host();
        // compare.js pads the domain by hand (y.max = 1.12 × the largest value); that used to skip the fitting
        const spec = { horizontal: true, categories: ['Battery from solar', 'From cheap slots', 'Standby'], y: { format: v => `£${v}/yr`, min: -17.92, max: 173.6 },
            series: [{ key: 's', label: 'Saves', values: [99, 155, -16] }] };
        const c = charts.createBars(el, spec);
        const axisRow = () => { const money = tickLabels(el, /^-?£-?[\d.]+\/yr$/); const y = Math.max(...money.map(m => m[3])); return money.filter(m => m[3] === y); };
        const wideCount = axisRow().length;
        el.querySelector('.chart-plot')._clientWidth = 343;
        c.update(spec);
        const ticks = axisRow();
        expect(ticks.length).toBeGreaterThanOrEqual(2);
        expect(ticks.length).toBeLessThanOrEqual(wideCount);
        const xs = ticks.map(x => x[2]).sort((a, b) => a - b);
        for (let i = 1; i < xs.length; i++) {
            const [a, b] = [ticks.find(t => t[2] === xs[i - 1]), ticks.find(t => t[2] === xs[i])];
            expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(((a[1].length + b[1].length) * 6) / 2 + 14 - 0.01);
        }
        c.destroy();
    });

    it('scatter point labels avoid the payback-line labels', () => {
        const el = host();
        const pts = [{ x: 2534, y: 496, label: 'Anker Solarbank 4 Pro 5 kWh + 4×460 W', emphasis: true }, { x: 468, y: 172, label: 'City Plumbing', emphasis: true }];
        const c = charts.createScatter(el, { points: pts, isolines: [3, 5].map(n => ({ label: `pays back in ${n} yrs`, points: [[0, 0], [3000, 3000 / n]] })) });
        const ctx = el.querySelector('canvas').getContext('2d');
        const drawn = ctx.calls.filter(x => x[0] === 'fillText');
        const box = (t, x, y, align) => {
            const w = t.length * 6;
            const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
            return [x0, y - 11, x0 + w, y + 3];
        };
        // replay alignment from the recorded '=textAlign' assignments
        const boxes = [];
        let align = 'left';
        for (const x of ctx.calls) {
            if (x[0] === '=textAlign') align = x[1];
            if (x[0] === 'fillText') boxes.push({ t: x[1], b: box(x[1], x[2], x[3], align) });
        }
        const iso = boxes.filter(b => b.t.startsWith('pays back'));
        const named = boxes.filter(b => pts.some(p => p.label === b.t));
        expect(iso.length).toBeGreaterThan(0);
        for (const n of named) for (const i of iso) {
            const overlap = !(n.b[2] < i.b[0] || n.b[0] > i.b[2] || n.b[3] < i.b[1] || n.b[1] > i.b[3]);
            expect(overlap, `${n.t} overlaps ${i.t}`).toBe(false);
        }
        void drawn;
        c.destroy();
    });

    it("polar: a 'pick' marker has its own legend entry and ring; tipLabel names the first tooltip row", () => {
        const el = host();
        const az = [90, 135, 180, 225, 270], ti = [0, 30, 60];
        const c = charts.createPolar(el, { azimuths: az, tilts: ti, values: az.flatMap(() => [100, 150, 120]), metricLabel: '£ a year', tipLabel: 'a year', format: v => `£${v}`,
            markers: [{ az: 180, tilt: 30, kind: 'best', label: 'Best' }, { az: 225, tilt: 60, kind: 'pick', label: 'Picked' }, { az: 180, tilt: 30, kind: 'current' }] });
        const items = el.querySelectorAll('.chart-legend li').map(li => li.textContent);
        expect(items).toEqual(['Best (marked)', 'Your pick', 'Current']);
        const ctx = el.querySelector('canvas').getContext('2d');
        expect(ctx.calls.some(x => x[0] === '=strokeStyle' && x[1] === '#c4a24e')).toBe(true);
        const canvas = el.querySelector('canvas');
        canvas.focus();
        canvas.dispatchEvent({ type: 'keydown', key: 'ArrowUp', preventDefault() {} });   // starts at the pick
        const tip = text(el.querySelector('.chart-tip'));
        expect(tip).toContain('SW 225° · tilt 60°');   // started from the pick, then moved up a row → same az
        expect(tip).toContain('a year');
        expect(tip).not.toContain('£ a year');
        expect(text(el.querySelector('.chart-scale'))).toContain('£ a year');
        // Enter picks; the follow-up update keeps the cursor where it was
        const before = tip;
        c.update({ azimuths: az, tilts: ti, values: az.flatMap(() => [101, 151, 121]), tipLabel: 'a year', format: v => `£${v}`, markers: [{ az: 225, tilt: 60, kind: 'pick' }] });
        expect(text(el.querySelector('.chart-tip')).split('£')[0]).toBe(before.split('£')[0]);
        c.destroy();
    });
});
