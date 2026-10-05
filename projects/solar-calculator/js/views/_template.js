/*
 * views/_template.js — the pattern every view follows. Copy to views/<id>.js and fill in render().
 *
 * Lifecycle (app.js): the module is imported on first visit, mount(el, ctx) runs once, then
 * show(params) on every visit (params come from the hash: #design?scenario=S01 → { scenario: 'S01' })
 * and hide() when the user leaves. Views stay mounted, so keep chart instances and update() them.
 *
 * ctx = { store, engine, ui, charts, fmt, router: { go, replace, params, current }, data, shell }
 *   data.summary()            DatasetSummary | null
 *   data.status()             'empty' | 'loading' | 'ready' | 'error'
 *   data.insights()           Promise<Insights>            (memoised)
 *   data.verdict({ onPartial }) Promise<Verdict>           (memoised, streamed)
 *   data.scenario(system, o)  Promise<ScenarioResult>      (memoised; user finance merged in)
 *   data.autoScenarios()      Promise<System[]>
 *   data.on(evt, fn) → off    'dataset' | 'settings' | 'scenarios' | 'verdict' | 'status'
 *   shell.rerun.show({ text, actionLabel, onRun }) / hide()   sticky "inputs changed" bar
 *
 * Rules of thumb:
 *   - No dataset → render ui.connectCard(ctx). Loading → skeletons. Never a blank screen.
 *   - But while a connect card is on screen and there's still no dataset, don't re-render: the card
 *     shows its own progress list and error actions, and replacing it would throw them away.
 *   - Ignore AbortError: the hub cancels in-flight work whenever the dataset or settings change.
 *   - Guard async renders with a token so a slow, stale result never overwrites a newer one.
 *   - Text from data (kit names, tariff codes) goes in via ui.h children, never innerHTML.
 *   - Every chart already has a table twin; give it a title and an ariaLabel.
 */

export default {
    id: 'template',
    title: 'Template',

    mount(el, ctx) {
        this.el = el;
        this.ctx = ctx;
        this.charts = [];
        this.token = 0;
        this.offs = [
            ctx.data.on('dataset', () => this.render()),
            ctx.data.on('settings', () => this.render()),
            ctx.data.on('status', () => this.render()),
        ];
        this.render();
    },

    show(params) {
        this.params = params || {};
    },

    hide() {},

    unmount() {
        this.offs?.forEach(off => off());
        this.charts?.forEach(c => c.destroy());
    },

    async render() {
        const { ui, data, charts, fmt } = this.ctx;
        // The connect card shows its own progress and errors: leave it alone until data arrives.
        if (!data.summary() && this.el.querySelector('.connect-card')) return;
        const token = ++this.token;
        this.charts.forEach(c => c.destroy());
        this.charts = [];

        if (data.status() === 'loading') {
            this.el.replaceChildren(ui.card({ body: ui.skeleton({ lines: 6 }) }));
            return;
        }
        const summary = data.summary();
        if (!summary) {
            this.el.replaceChildren(ui.connectCard(this.ctx));
            return;
        }

        const tiles = ui.h('div', { class: 'tiles' }, ui.statTile({ label: 'Always-on load', loading: true }));
        const chartHost = ui.h('div');
        this.el.replaceChildren(
            ui.h('div', { class: 'view-head' }, ui.h('div', null,
                ui.h('div', { class: 'view-kicker' }, 'Template'),
                ui.h('h1', { class: 'view-title' }, 'A view'),
                ui.h('p', { class: 'view-lede' }, `${summary.days} days of data`))),
            ui.h('div', { class: 'stack' }, tiles, ui.card({ title: 'Load profile', body: chartHost })));

        try {
            const ins = await data.insights();
            if (token !== this.token) return;             // a newer render started meanwhile
            tiles.replaceChildren(ui.statTile({ label: 'Always-on load', value: fmt.num(ins.baseLoad?.w), unit: 'W' }));
            this.charts.push(charts.createLine(chartHost, {
                title: 'Average day', ariaLabel: 'Average half-hourly load',
                x: { values: Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`) },
                y: { label: 'kWh per half-hour', format: v => fmt.num(v, 2) },
                series: [{ key: 'load', label: 'Load', color: 'load', values: Array.from(ins.profiles?.load || []), area: true }],
                bands: [{ from: 32, to: 38, label: '4–7pm' }],
            }));
        } catch (err) {
            if (err?.name === 'AbortError' || token !== this.token) return;
            tiles.replaceChildren(ui.h('div', { class: 'notice notice-bad' }, ui.icon('alert'), ui.h('span', null, err?.message || String(err))));
        }
    },
};
