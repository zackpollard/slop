/*
 * views/usage.js — the Usage tab: what the user's own half-hourly data says before any solar.
 *
 * Reads ctx.data.insights() only (insights.js, CONTRACTS §7) plus the store's settings, so it is
 * cheap and never waits on the simulation engine. Layout, top to bottom:
 *   1. head + context line (days, dates, tariff, region, real-data chip → #data)
 *   2. drift / projection banner: when the always-on load moved ≥ 15 % in the last 60 days, offer
 *      "Use today's {W} W for the forecast" (writes settings.projectBaseW); when a projection is in
 *      force, say so and offer to go back to the measured figure
 *   3. hero: "your home draws {W} around the clock" + a floor glyph (the average day with the
 *      always-on floor filled) + the £/yr readout, 4–7pm part and £ per 100 W
 *   4. tiles: most days (p10–p90 of daily lows), used 4–7pm, the bill, average price paid
 *   5. an average day: load profile stacked above the price profile (shared x, 4–7pm shaded —
 *      two charts, never a dual axis) beside a 4–7pm panel
 *   6. always-on load by month (median, dashed p10 / p90 days) · monthly bills (energy + standing)
 *   7. 'More charts' (lazy): load and price heatmaps, negative-price half-hours, how much the
 *      user already shifts (load- vs time-weighted price), Agile vs Flexible when the engine
 *      provides it, and a data-coverage note
 *
 * Re-rendering: the DOM is built once per dataset and filled from insights. A settings change or
 * a dataset reload keeps the previous render at reduced opacity until the new figures arrive (no
 * skeleton flash, no layout jump); charts are updated in place. When a re-render removes the
 * button the user just pressed (banner actions, Try again, a toast's Undo), focus moves to the
 * banner's next action or the view heading instead of falling to <body>.
 *
 * Remembered per device (store ui.chartTables, keys 'usage.more' and 'usage.table.<chart>'):
 * whether 'More charts' is open and which charts show their table twin.
 *
 * View-local components (candidates for ui.js/charts.js — see the report): floorGlyph() (the
 * always-on floor drawn under the average day) and figurePair() (two figures compared, with
 * the difference spelled out). Their CSS lives in the injected <style id="style-usage">.
 */

const STYLE_ID = 'style-usage';
const PEAK = [32, 38];                      // half-hour indices 16:00–19:00 local (end exclusive)
const DRIFT_FLAG_PCT = 15;                  // UX critique: flag |drift| ≥ 15 %
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WX_SOURCES = ['SARAH-3 satellite', 'MSG satellite (recent days)', 'forecast model, scaled', 'example data', 'interpolated'];
const SCALE_NOTE = 'The colour scale leaves out the most extreme 1% at each end, so a few spikes don’t wash out the rest';

const CSS = `
.uv { display: flex; flex-direction: column; gap: 20px; transition: opacity .2s ease; }
.uv.is-stale { opacity: .5; }
.uv .view-title:focus { outline: none; }
.uv .view-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.uv-context { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 8px; }
/* tariff codes and place names can be long unbroken strings: never let them widen the page */
.uv-context .context-line { min-width: 0; overflow-wrap: anywhere; }
/* the card heading above already names these charts; their title only captions the table twin */
.uv-untitled .chart-title { display: none; }
/* a hidden chart tooltip keeps its last position; after a resize that can sit past the edge and
   widen the page, so park it at the origin once it has faded out */
.uv .chart-tip:not(.show) { transform: none !important; transition: opacity .1s, transform 0s .1s; }
.uv .help-dot { flex: none; }
.uv-chip {
    display: inline-flex; align-items: center; gap: 7px; min-height: 26px; padding: 0 10px;
    border: 1px solid var(--border); border-radius: 999px; text-decoration: none;
    font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); white-space: nowrap;
}
.uv-chip:hover { border-color: var(--accent-line); color: var(--text); }
.uv-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--good); flex: none; }
.uv-chip.is-warn .uv-chip-dot { background: var(--warn); }

.uv-banner { align-items: center; flex-wrap: wrap; }
.uv-banner-text { flex: 1 1 320px; min-width: 0; }
.uv-banner-text b { color: var(--text); font-weight: 600; }
.uv-banner-sub { display: block; color: var(--muted); font-size: 13px; margin-top: 2px; }
.uv-banner .btn { flex: none; }
.uv-banner-actions { display: flex; flex-wrap: wrap; gap: 8px; flex: none; }

.uv-hero { padding: 26px 28px 24px; }
.uv-hero-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 34px; align-items: stretch; }
.uv-eyebrow { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
.uv-hero-title { font-size: 26px; font-weight: 700; letter-spacing: -.03em; line-height: 1.18; margin-top: 8px; }
.uv-hero-title .uv-fig { font-family: var(--font-mono); font-weight: 600; letter-spacing: -.04em; color: var(--accent-strong); white-space: nowrap; }
.uv-hero-title .uv-fig-unit { font-family: var(--font-body); letter-spacing: -.01em; }
.uv-hero-body { color: var(--text-2); margin-top: 10px; max-width: 62ch; }
.uv-hero-body b { color: var(--text); font-weight: 600; white-space: nowrap; }

.uv-floor { margin-top: 20px; }
.uv-floor-plot { position: relative; height: 92px; border-bottom: 1px solid var(--border-strong); }
.uv-floor-plot svg { width: 100%; height: 100%; display: block; overflow: visible; }
.uv-floor-base { fill: var(--series-load); fill-opacity: .34; }
.uv-floor-above { fill: var(--series-load); fill-opacity: .16; }
.uv-floor-line { fill: none; stroke: var(--series-load); stroke-width: 2; stroke-linejoin: round; }
.uv-floor-rule { stroke: var(--text-2); stroke-width: 1; stroke-dasharray: 3 3; }
.uv-floor-peak { fill: var(--chart-band); }
.uv-floor-tag {
    position: absolute; left: 10px; bottom: 7px; font-family: var(--font-mono); font-size: 11.5px; color: var(--text);
    text-shadow: 0 1px 2px rgba(0, 0, 0, .6);
}
.uv-floor-peaktag { position: absolute; top: -18px; transform: translateX(-50%); font-family: var(--font-mono); font-size: 10.5px; color: var(--chart-band-text); white-space: nowrap; }
.uv-floor-axis { position: relative; height: 18px; font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); }
.uv-floor-axis span { position: absolute; top: 4px; transform: translateX(-50%); white-space: nowrap; }
.uv-floor-axis span:first-child { transform: none; }
.uv-floor-axis span:last-child { transform: translateX(-100%); }
.uv-floor-key { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 6px; font-size: 12.5px; color: var(--text-2); }
.uv-floor-key span { display: inline-flex; align-items: center; gap: 7px; }
.uv-swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.uv-swatch-base { background: var(--series-load); opacity: .6; }
.uv-swatch-above { background: rgba(57, 135, 229, .22); box-shadow: inset 0 2px 0 var(--series-load); }

.uv-readout { border-left: 1px solid var(--hairline); padding-left: 30px; display: flex; flex-direction: column; justify-content: center; min-width: 0; }
.uv-readout-label { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.uv-readout-fig { font-family: var(--font-mono); font-size: 60px; font-weight: 600; letter-spacing: -.055em; line-height: 1; margin-top: 8px; color: var(--text); }
.uv-readout-fig small { font-family: var(--font-body); font-size: 16px; font-weight: 500; letter-spacing: 0; color: var(--muted); margin-left: 8px; }
.uv-readout-sub { color: var(--muted); font-size: 13px; margin-top: 8px; }
.uv-readout-rows { margin: 18px 0 0; padding: 0; display: grid; gap: 0; }
.uv-readout-row { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; padding: 9px 0; border-top: 1px solid var(--hairline); }
.uv-readout-row dt { color: var(--text-2); font-size: 13.5px; }
.uv-readout-row dd { margin: 0; font-family: var(--font-mono); font-size: 15px; font-weight: 600; color: var(--text); white-space: nowrap; }

.uv-day { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 26px; align-items: start; }
.uv-day-charts { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.uv-panel { border-left: 1px solid var(--hairline); padding-left: 24px; display: flex; flex-direction: column; gap: 16px; }
.uv-panel-title { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.uv-panel p { color: var(--text-2); font-size: 13.5px; }
.uv-panel p b { color: var(--text); font-weight: 600; }
.uv-panel-links { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }

.uv-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--hairline); border: 1px solid var(--hairline); border-radius: 8px; overflow: hidden; }
.uv-pair > div { background: var(--surface); padding: 11px 13px 12px; min-width: 0; }
.uv-pair-label { font-size: 12px; color: var(--muted); line-height: 1.35; }
.uv-pair-fig { font-family: var(--font-mono); font-size: 22px; font-weight: 600; letter-spacing: -.035em; color: var(--text); margin-top: 4px; }
.uv-pair-fig small { font-family: var(--font-body); font-size: 12px; font-weight: 500; letter-spacing: 0; color: var(--muted); margin-left: 4px; }
.uv-pair > div.is-strong { box-shadow: inset 0 2px 0 var(--accent); }

.uv-more > summary { font-size: 15px; font-weight: 600; color: var(--text); padding: 16px 2px; }
.uv-more > summary .uv-more-sub { display: block; font-size: 13px; font-weight: 400; color: var(--muted); margin-top: 2px; }
.uv-more-body { display: flex; flex-direction: column; gap: 20px; padding-top: 6px; }
.uv-note { font-size: 12.5px; color: var(--muted); margin-top: 8px; display: flex; gap: 8px; align-items: flex-start; }
.uv-note .uv-swatch { margin-top: 3px; background: var(--ramp-empty); }
.uv-facts { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 22px; font-size: 13.5px; }
.uv-facts dt { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); padding-top: 3px; }
.uv-facts dd { margin: 0; color: var(--text-2); min-width: 0; overflow-wrap: anywhere; }
.uv-facts dd b { color: var(--text); font-weight: 600; }
.uv-facts dd ul { margin: 0; padding-left: 18px; }
.uv-lede-sm { color: var(--text-2); font-size: 14px; margin-bottom: 14px; max-width: 70ch; }
.uv-lede-sm b { color: var(--text); font-weight: 600; }
.uv-error { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }

@media (max-width: 1023px) {
    .uv-day { grid-template-columns: minmax(0, 1fr); }
    .uv-panel { border-left: 0; padding-left: 0; border-top: 1px solid var(--hairline); padding-top: 16px; }
}
@media (max-width: 760px) {
    .uv-hero-grid { grid-template-columns: minmax(0, 1fr); gap: 22px; }
    .uv-readout { border-left: 0; padding-left: 0; border-top: 1px solid var(--hairline); padding-top: 18px; }
}
@media (max-width: 600px) {
    .uv-hero { padding: 18px 16px 16px; }
    .uv-hero-title { font-size: 21px; }
    .uv-readout-fig { font-size: 46px; }
    .uv-floor-plot { height: 76px; }
    .uv-chip { min-height: 44px; padding: 0 12px; }
    .uv-facts { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .uv-facts dd { margin-bottom: 10px; }
    .uv-banner .btn { width: 100%; }
    .uv-banner-actions { width: 100%; flex-direction: column; }
    .uv-more > summary { min-height: 44px; }
}
@media print {
    .uv.is-stale { opacity: 1; }
    .uv-floor-base { fill-opacity: .3; }
    .uv-readout { border-color: #ddd; }
    /* Paper is ~720 CSS px wide, which trips the phone rules above: keep the hero side by side and
       the four tiles on one row so the headline page isn't half empty. */
    .uv-hero-grid { grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 24px; }
    .uv-readout { border-left: 1px solid #ddd; padding-left: 20px; border-top: 0; padding-top: 0; }
    .uv-readout-fig { font-size: 44px; }
    .uv .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
    /* Cards that carry table twins run longer than a page: let them break between rows (the
       global rule keeps every card whole, which pushes them on and leaves blank pages), but never
       through a chart or a figure. */
    .uv .card:not(.uv-hero):has(.chart) { break-inside: auto; }
    .uv .chart-plot, .uv .chart-head, .uv-pair, .uv-floor, .uv .stat, .uv .card-head { break-inside: avoid; }
    .uv .card-head { break-after: avoid; }
}
`;

/* ── pure helpers ───────────────────────────────────────────────────────────── */

const finite = v => typeof v === 'number' && Number.isFinite(v);
const HH = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const hhRange = i => `${HH[i]}–${HH[(i + 1) % 48] === '00:00' ? '24:00' : HH[(i + 1) % 48]}`;
const toW = kwhPerSlot => kwhPerSlot * 2000;
/** A line-series value: charts.js reads +null as 0, so a gap must be NaN to stay a gap. */
const gap = v => (finite(v) ? v : NaN);

/** Linear-interpolated quantile of a sorted array (numpy default, as insights.js uses). */
function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Quantiles of the finite values of a typed array (sorted copy). */
function quantilesOf(arr, qs) {
    const vals = [];
    for (const v of arr) if (Number.isFinite(v)) vals.push(v);
    vals.sort((a, b) => a - b);
    return qs.map(q => quantile(vals, q));
}

/**
 * Per-month p10 / median / p90 of the daily always-on values (insights dailyW, NaN = day dropped).
 * @param {Float64Array|number[]} dailyW
 * @param {string[]} dates local 'YYYY-MM-DD', aligned with dailyW
 * @param {string[]} keys month keys to report, in order
 */
function monthlyBaseBands(dailyW, dates, keys) {
    const by = new Map(keys.map(k => [k, []]));
    for (let i = 0; i < (dailyW?.length || 0); i++) {
        const v = dailyW[i];
        if (!Number.isFinite(v)) continue;
        by.get(String(dates?.[i] || '').slice(0, 7))?.push(v);
    }
    return keys.map(k => {
        const v = (by.get(k) || []).sort((a, b) => a - b);
        return { key: k, days: v.length, p10: quantile(v, 0.1), p50: quantile(v, 0.5), p90: quantile(v, 0.9) };
    });
}

/** Negative-price half-hours per month from the day × 48 price heatmap (load in real slots only). */
function negativeByMonth(hm, keys) {
    const by = new Map(keys.map(k => [k, { slots: 0, kwh: 0 }]));
    const hours = new Uint16Array(48);
    if (!hm?.price) return { months: keys.map(k => ({ key: k, slots: 0, kwh: 0 })), hours };
    for (let d = 0; d < hm.days; d++) {
        const row = by.get(String(hm.dates[d]).slice(0, 7));
        for (let k = 0; k < 48; k++) {
            const p = hm.price[d * 48 + k];
            if (!(p < 0)) continue;
            hours[k]++;
            if (row) {
                row.slots++;
                const l = hm.load?.[d * 48 + k];
                if (Number.isFinite(l)) row.kwh += l;
            }
        }
    }
    return { months: keys.map(k => ({ key: k, ...by.get(k) })), hours };
}

/**
 * Share (0–1) of each month's half-hours with no real meter reading, from the day × 48 load
 * heatmap (NaN = no real reading: gap-filled, or extended to complete a year).
 * @param {{ days: number, dates: string[], load: Float32Array }} hm
 * @param {string[]} keys month keys
 * @returns {number[]}
 */
function estimatedShareByMonth(hm, keys) {
    const tot = new Map(keys.map(k => [k, [0, 0]]));
    if (!hm?.load) return keys.map(() => 0);
    for (let d = 0; d < hm.days; d++) {
        const row = tot.get(String(hm.dates[d]).slice(0, 7));
        if (!row) continue;
        for (let k = 0; k < 48; k++) { row[1]++; if (!Number.isFinite(hm.load[d * 48 + k])) row[0]++; }
    }
    return keys.map(k => { const [miss, all] = tot.get(k); return all ? miss / all : 0; });
}

/**
 * Classify the empty cells of the day × 48 heatmaps. The price heatmap has a value for every
 * half-hour that exists in the data, so: no price → that half-hour never existed (the hour the
 * clocks skip in March, or outside the window on the first/last day); a price but no real load
 * reading → genuinely no meter reading (gap-filled or extended to a year).
 * @param {{ days: number, dates: string[], load: Float32Array, price: Float32Array }} hm
 * @returns {{ noReading: number, skippedDates: string[] }}
 */
function heatmapGaps(hm) {
    let noReading = 0;
    const skipped = new Set();
    const D = hm?.days || 0;
    for (let d = 0; d < D; d++) {
        for (let k = 0; k < 48; k++) {
            const i = d * 48 + k;
            if (!Number.isFinite(hm.price?.[i])) {
                if (d > 0 && d < D - 1) skipped.add(hm.dates[d]);
                continue;
            }
            if (!Number.isFinite(hm.load?.[i])) noReading++;
        }
    }
    return { noReading, skippedDates: [...skipped] };
}

/** Month label for axes: 'Oct', or "Oct ’25" when the data spans more than a year. */
function monthTick(key, long) {
    const m = /^(\d{4})-(\d{2})/.exec(String(key));
    if (!m) return String(key);
    return long ? `${MONTHS[+m[2] - 1]} ’${m[1].slice(2)}` : MONTHS[+m[2] - 1];
}

const daysInMonth = key => { const [y, m] = String(key).split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

/* ── the view ───────────────────────────────────────────────────────────────── */

export default {
    id: 'usage',
    title: 'Usage',

    mount(el, ctx) {
        this.el = el;
        this.ctx = ctx;
        this.token = 0;
        this.v = null;            // the built view for one dataset: { dsId, root, parts, charts }
        injectStyle(ctx.ui.h);
        this.offs = [
            ctx.data.on('dataset', () => this.render()),
            ctx.data.on('settings', () => this.render()),
            ctx.data.on('status', () => this.render()),
        ];
        this.render();
    },

    show(params) { this.params = params || {}; },

    hide() {},

    unmount() {
        this.offs?.forEach(off => off());
        this.teardown();
    },

    /** Destroy charts and forget the built view. */
    teardown() {
        if (!this.v) return;
        for (const c of Object.values(this.v.charts)) c?.destroy();
        this.v = null;
    },

    setStale(on) {
        if (!this.v) return;
        this.v.root.classList.toggle('is-stale', !!on);
        if (on) this.v.root.setAttribute('aria-busy', 'true'); else this.v.root.removeAttribute('aria-busy');
    },

    async render() {
        const { ui, data } = this.ctx;
        // The connect card shows its own progress and errors: leave it alone until data arrives.
        if (!data.summary() && this.el.querySelector('.connect-card')) return;
        const token = ++this.token;
        const summary = data.summary();

        if (data.status() === 'loading') {
            if (this.v) this.setStale(true);
            else this.el.replaceChildren(this.skeleton());
            return;
        }
        if (!summary) {
            this.teardown();
            this.el.replaceChildren(ui.connectCard(this.ctx));
            return;
        }
        if (this.v) this.setStale(true);
        else this.el.replaceChildren(this.skeleton(summary));

        let ins;
        try {
            ins = await data.insights();
        } catch (err) {
            if (err?.name === 'AbortError' || token !== this.token) return;
            // A refresh of figures already on screen failed: keep them, say so above them.
            if (this.v && this.v.dsId === summary.id && this.v.ins) {
                this.setStale(false);
                this.showInlineError(err);
            } else {
                this.teardown();
                this.el.replaceChildren(this.errorCard(err));
            }
            this.restoreFocus();
            return;
        }
        if (token !== this.token || data.summary()?.id !== summary.id) return;
        try {
            if (!this.v || this.v.dsId !== summary.id) {
                this.teardown();
                this.build(summary);
            }
            this.fill(summary, ins);
        } catch (err) {
            console.error('usage view failed to render', err);
            this.teardown();
            this.el.replaceChildren(this.errorCard(err));
            this.restoreFocus();
            return;
        }
        this.setStale(false);
        this.restoreFocus();
    },

    /**
     * A button the user just pressed (a banner action, Try again, a toast's Undo) is usually gone
     * after the re-render it caused, which drops keyboard focus to <body>. Put it somewhere useful:
     * the banner's first action when asked, else the retry button of an error, else the heading.
     * Never steals focus the user has already moved elsewhere, or from a hidden tab.
     */
    restoreFocus() {
        const want = this.focusAfter;
        this.focusAfter = null;
        if (!want || this.el.hidden || typeof document === 'undefined') return;
        const a = document.activeElement;
        const lost = !a || a === document.body || !a.isConnected || !!a.closest?.('.toasts');
        if (!lost) return;
        const target = (want === 'banner' && this.el.querySelector('.uv-banner .btn'))
            || this.el.querySelector('.uv-error .btn')
            || this.el.querySelector('.view-title');
        target?.focus();
    },

    /** Per-device view preferences (open 'More charts', table twins) in the store's open-ended ui.chartTables map. */
    pref(key) {
        return !!this.ctx.store.get().ui?.chartTables?.[`usage.${key}`];
    },
    setPref(key, on) {
        if (this.pref(key) === !!on) return;
        this.ctx.store.set({ ui: { chartTables: { [`usage.${key}`]: !!on } } });
    },

    /**
     * Create a chart on first use and update it afterwards (keeps hover state, focus and the table
     * toggle). The table twin's open state is remembered per device, and the toggle gets a name
     * that says which chart it belongs to (eight buttons all called "Table" are no use to a
     * screen-reader user).
     */
    chart(key, create, host, spec) {
        const v = this.v;
        const full = { ...spec, table: this.pref(`table.${key}`), onTable: on => this.setPref(`table.${key}`, on) };
        const c = v.charts[key];
        if (c) c.update(full);
        else v.charts[key] = create(host, full);
        host.querySelector('.chart-toggle')?.setAttribute('aria-label', `Table: ${spec.title || spec.ariaLabel}`);
    },

    /* ── skeleton & error ───────────────────────────────────────────────── */

    skeleton(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        // Same labels and card heads as the built page, so nothing jumps when the figures arrive.
        return h('div', { class: 'uv', 'aria-busy': 'true' },
            this.head(summary, null),
            ui.card({ accent: true, className: 'uv-hero', body: h('div', { class: 'uv-hero-grid' },
                h('div', null, ui.skeleton({ lines: 4 }), h('div', { style: { marginTop: '20px' } }, ui.skeleton({ height: 132 }))),
                h('div', { class: 'uv-readout' }, ui.skeleton({ height: 60 }), h('div', { style: { marginTop: '18px' } }, ui.skeleton({ lines: 3 })))) }),
            h('div', { class: 'tiles' }, ['Most days', 'Used 4–7pm', 'Energy, last 12 months', 'Average price paid'].map(label => ui.statTile({ label, loading: true }))),
            ui.card({ eyebrow: 'An average day', title: 'When you use electricity, and what it costs then', body: ui.skeleton({ height: 420 }) }),
            h('div', { class: 'grid-2' },
                ui.card({ title: 'Always-on load, month by month', body: ui.skeleton({ height: 290 }) }),
                ui.card({ title: 'Monthly bills', body: ui.skeleton({ height: 290 }) })));
    },

    errorCard(err) {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'uv' },
            this.head(this.ctx.data.summary(), null),
            ui.card({ body: h('div', { class: 'uv-error' },
                h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'),
                    h('span', null, `Couldn’t analyse your usage: ${err?.message || err}`)),
                h('div', { class: 'uv-banner-actions' },
                    ui.button({ label: 'Try again', icon: 'refresh', onClick: () => { this.focusAfter = 'head'; this.render(); } }),
                    ui.button({ label: 'Check your data', kind: 'ghost', href: '#data', icon: 'arrowRight' }))) }));
    },

    showInlineError(err) {
        const { ui } = this.ctx;
        const h = ui.h;
        const host = this.v.parts.banner;
        host.replaceChildren(h('div', { class: 'notice notice-bad uv-banner', role: 'alert' }, ui.icon('alert'),
            h('div', { class: 'uv-banner-text' },
                h('span', null, `Couldn’t refresh your usage figures: ${err?.message || err}`),
                h('span', { class: 'uv-banner-sub' }, 'What you see below is from the last successful analysis of this data.')),
            ui.button({ label: 'Try again', icon: 'refresh', size: 'sm', onClick: () => { this.focusAfter = 'banner'; this.render(); } })));
        host.hidden = false;
    },

    /* ── view head + context line ───────────────────────────────────────── */

    head(summary, ins) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const ctxLine = [];
        const cov = ins?.coverage ?? summary?.coverage;
        const real = cov?.realPct;
        const estDays = finite(cov?.extrapolatedSlots) ? Math.round(cov.extrapolatedSlots / 48) : 0;
        if (summary) {
            const d = s => (s ? fmt.date(Date.parse(`${s}T12:00:00Z`)) : '?');
            const days = Math.round(summary.days || 0);
            // A short history is extended to a year; say how much of the year is real readings.
            ctxLine.push(estDays > 0 && estDays < days
                ? h('span', null, h('b', null, `${fmt.num(days - estDays)} days`), ` of half-hourly readings, extended to a year (${d(summary.from)} – ${d(summary.to)})`)
                : h('span', null, h('b', null, `${fmt.num(days)} days`), ` of half-hourly use (${d(summary.from)} – ${d(summary.to)})`));
            if (summary.tariffCode) ctxLine.push(' · ', h('b', null, summary.tariffCode));
            // a postcode never breaks across lines ('SW1A' / '1AA' reads as two things)
            const postcode = summary.postcode ? String(summary.postcode).replace(/\s+/g, ' ') : null;
            const where = [postcode, summary.regionName || (summary.region ? `region ${summary.region}` : null)].filter(Boolean).join(', ');
            if (where) ctxLine.push(` · ${where}`);
        }
        const chip = finite(real)
            ? h('a', { class: ['uv-chip', real < 95 && 'is-warn'], href: '#data', title: 'See where your data came from' },
                h('span', { class: 'uv-chip-dot', 'aria-hidden': 'true' }),
                `${fmt.pct(real, { dp: real >= 99.95 || real < 10 ? 0 : 1 })} real readings${estDays ? ` · ${fmt.num(estDays)} days estimated` : ''}`)
            : null;
        return h('div', { class: 'view-head' }, h('div', null,
            h('div', { class: 'view-kicker' }, 'Usage'),
            // tabindex -1: focus lands here when a re-render removes the control the user just used
            h('h1', { class: 'view-title', tabindex: '-1' }, 'What your meter says'),
            summary ? h('div', { class: 'uv-context' }, h('p', { class: 'context-line' }, ctxLine), chip) : null));
    },

    /* ── build once per dataset ─────────────────────────────────────────── */

    build(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = {};
        p.head = h('div');
        p.banner = h('div', { hidden: true });
        p.heroLeft = h('div');
        p.readout = h('div', { class: 'uv-readout' });
        p.tiles = h('div', { class: 'tiles' });
        p.loadProfile = h('div');
        p.priceProfile = h('div');
        p.peakPanel = h('aside', { class: 'uv-panel', 'aria-label': 'The 4–7pm peak' });
        p.baseMonthly = h('div', { class: 'uv-untitled' });
        p.baseSub = h('span');
        p.bills = h('div', { class: 'uv-untitled' });
        p.billsSub = h('span');
        p.more = h('div', { class: 'uv-more-body' });
        p.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });

        const more = ui.details({
            className: 'uv-more',
            summary: h('span', null, 'More charts',
                h('span', { class: 'uv-more-sub' }, 'Every half-hour of the year, negative prices, how much you already shift, and where the data came from')),
            body: p.more,
            open: this.pref('more'),        // remembered on this device, so it survives reloads
            onToggle: open => { this.setPref('more', open); if (open) this.fillMore(); },
        });
        p.moreDetails = more;

        const root = h('div', { class: 'uv' },
            p.head,
            p.banner,
            ui.card({ accent: true, className: 'uv-hero', body: h('div', { class: 'uv-hero-grid' }, p.heroLeft, p.readout) }),
            p.tiles,
            ui.card({
                eyebrow: 'An average day',
                title: 'When you use electricity, and what it costs then',
                subtitle: 'Each half-hour averaged over every day of your data, local time. Shaded: the 4–7pm peak.',
                body: h('div', { class: 'uv-day' }, h('div', { class: 'uv-day-charts' }, p.loadProfile, p.priceProfile), p.peakPanel),
            }),
            h('div', { class: 'grid-2' },
                ui.card({ title: 'Always-on load, month by month', subtitle: p.baseSub, body: p.baseMonthly }),
                ui.card({ title: 'Monthly bills', subtitle: p.billsSub, body: p.bills })),
            more,
            p.live);
        this.el.replaceChildren(root);
        this.v = { dsId: summary.id, root, parts: p, charts: {}, ins: null, summary, moreBuilt: false };
    },

    /* ── fill / update from insights ────────────────────────────────────── */

    fill(summary, ins) {
        const v = this.v;
        v.ins = ins;
        v.summary = summary;
        const p = v.parts;
        p.head.replaceChildren(this.head(summary, ins));
        this.fillBanner(ins);
        this.fillHero(summary, ins);
        this.fillTiles(summary, ins);
        this.fillDay(summary, ins);
        this.fillMonthly(summary, ins);
        if (v.moreBuilt || p.moreDetails.open) this.fillMore();
        const { fmt } = this.ctx;
        // Set a beat after the build: a live region filled in the same task it was inserted in is
        // often not announced at all.
        const msg = `Usage analysed: always-on load ${fmt.w(ins.baseLoad?.w)}, costing ${fmt.gbp(ins.baseLoad?.costBilledGbpYr)} a year.`;
        clearTimeout(this.liveTimer);
        this.liveTimer = setTimeout(() => { if (p.live.isConnected) p.live.textContent = msg; }, 150);
    },

    /** Drift (offer the recent figure) or projection (say it is in force, offer the measured one). */
    fillBanner(ins) {
        const { ui, fmt, store } = this.ctx;
        const h = ui.h;
        const host = this.v.parts.banner;
        const bl = ins.baseLoad || {};
        const pb = store.get().settings?.projectBaseW;
        const w = bl.w, recent = bl.recentW;
        const per100 = bl.gbpPer100W;
        const flagged = finite(bl.driftPct) && Math.abs(bl.driftPct) >= DRIFT_FLAG_PCT && finite(recent);
        const target = finite(recent) ? Math.round(recent) : null;
        const setProject = (val, msg) => {
            const undo = store.get().settings?.projectBaseW ?? null;
            this.focusAfter = 'banner';
            store.set({ settings: { projectBaseW: val } });
            ui.toast(msg, { tone: 'good', timeoutMs: 6000, action: { label: 'Undo', onClick: () => { this.focusAfter = 'banner'; store.set({ settings: { projectBaseW: undo } }); } } });
        };
        const useRecent = kind => ui.button({ label: `Use today’s ${fmt.w(target)} for the forecast`, kind, size: 'sm',
            onClick: () => setProject(target, `Forecasts now use ${fmt.w(target)} always-on.`) });

        if (finite(pb) && !(finite(w) && Math.abs(pb - w) < 0.5)) {
            const isRecent = finite(recent) && Math.abs(pb - recent) < 1;
            // A projection set earlier (or on another dataset) must not hide a drift the data shows now.
            const offerRecent = flagged && !isRecent;
            host.replaceChildren(h('div', { class: 'notice uv-banner', role: 'status' }, ui.icon('info'),
                h('div', { class: 'uv-banner-text' },
                    h('span', null, 'Forecasts use ', h('b', null, `${fmt.w(pb)} always-on`),
                        isRecent ? ' (your last 2 months)' : '', `, not the ${fmt.w(w)} your data shows over the whole period.`),
                    h('span', { class: 'uv-banner-sub' },
                        finite(per100) ? `At ${fmt.w(pb)} your always-on load would cost ${fmt.gbp((per100 * pb) / 100)} a year. ` : '',
                        offerRecent ? `Your last 2 months ran at ${fmt.w(recent)}. ` : '',
                        'The figures below are what your meter actually recorded.')),
                h('div', { class: 'uv-banner-actions' },
                    offerRecent ? useRecent('primary') : null,
                    ui.button({ label: `Use ${fmt.w(w)} from your data`, size: 'sm', onClick: () => setProject(null, `Forecasts use your measured ${fmt.w(w)} again.`) }))));
            host.hidden = false;
            return;
        }
        if (flagged) {
            host.replaceChildren(h('div', { class: 'notice notice-warn uv-banner', role: 'status' }, ui.icon('alert'),
                h('div', { class: 'uv-banner-text' },
                    h('span', null, 'Your always-on load changed: ', h('b', null, fmt.w(w)), (bl.days ?? 0) >= 330 ? ' over the year, ' : ' across your data, ', h('b', null, fmt.w(recent)), ' in the last 2 months.'),
                    h('span', { class: 'uv-banner-sub' }, recent > w
                        ? 'If that’s new kit that’s staying, solar will look better than the long-run figure suggests.'
                        : 'If that’s kit you’ve switched off for good, the long-run figure overstates what solar would save.')),
                h('div', { class: 'uv-banner-actions' }, useRecent('primary'))));
            host.hidden = false;
            return;
        }
        host.hidden = true;
        host.replaceChildren();
    },

    fillHero(summary, ins) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const bl = ins.baseLoad || {};
        const isAgile = /AGILE/i.test(summary.tariffCode || '') || summary.priceBasis === 'agile';
        const serverW = summary.source === 'demo' && finite(summary.serverW) ? summary.serverW : null;

        const title = h('h2', { class: 'uv-hero-title' },
            bl.estimated ? 'Your home rarely drops below ' : 'Your home draws ',
            h('span', { class: 'uv-fig' }, fmt.num(bl.w), h('span', { class: 'uv-fig-unit' }, '\u2009W')),
            bl.estimated ? '.' : ' around the clock.');
        const body = h('p', { class: 'uv-hero-body' },
            'That’s your always-on load — ',
            serverW ? `${fmt.w(serverW)} of servers in this example, plus the fridge, router and things on standby` : 'servers, the fridge, the router, things on standby',
            '. At your prices it costs ', h('b', null, `${fmt.gbp(bl.costBilledGbpYr)} a year`), ', ',
            h('b', null, fmt.gbp(bl.costPeakGbpYr)), ` of it between 4 and 7pm${isAgile ? ', when Agile is dearest' : ''}.`,
            finite(bl.sharePct) ? ` It’s ${fmt.pct(bl.sharePct, { dp: 0 })} of all the electricity you use.` : '',
            bl.estimated ? ' (Estimated: too few complete days of readings, so this is the quietest 5% of half-hours.)' : '');
        p.heroLeft.replaceChildren(
            h('div', { class: 'uv-eyebrow' }, 'Always-on load'),
            title, body,
            floorGlyph(h, fmt, ins.profiles?.load, bl.w, bl.sharePct));

        const perDay = finite(bl.costBilledGbpYr) ? bl.costBilledGbpYr / 365 : null;
        p.readout.replaceChildren(
            h('div', { class: 'uv-readout-label' }, 'It costs you'),
            h('div', { class: 'uv-readout-fig' }, fmt.gbp(bl.costBilledGbpYr), h('small', null, 'a year')),
            h('div', { class: 'uv-readout-sub' }, `${fmt.gbp(perDay, { dp: 2 })} a day · ${fmt.kwh(bl.kwhYr)} a year`),
            h('dl', { class: 'uv-readout-rows' },
                h('div', { class: 'uv-readout-row' }, h('dt', null, 'Of that, 4–7pm'), h('dd', null, fmt.gbp(bl.costPeakGbpYr))),
                h('div', { class: 'uv-readout-row' }, h('dt', null, 'Every 100 W you switch off saves'), h('dd', null, `${fmt.gbp(bl.gbpPer100W)}/yr`))));
    },

    fillTiles(summary, ins) {
        const { ui, fmt } = this.ctx;
        const bl = ins.baseLoad || {};
        const pk = ins.peak || {};
        const tot = ins.totals || {};
        const days = tot.days ?? summary.days;
        const yearish = finite(days) && days >= 358 && days <= 372;
        const estPct = finite(ins.coverage?.extrapolatedSlots) && ins.coverage.extrapolatedSlots > 0 && finite(summary.n) ? (100 * ins.coverage.extrapolatedSlots) / summary.n : 0;
        const flagged = finite(bl.driftPct) && Math.abs(bl.driftPct) >= DRIFT_FLAG_PCT;
        const lw = ins.loadWeightedPriceP, tw = ins.timeWeightedPriceP;
        const range = !bl.estimated && finite(bl.p10) && finite(bl.p90) && Math.round(bl.p10) !== Math.round(bl.p90);
        this.v.parts.tiles.replaceChildren(
            ui.statTile({
                label: 'Most days', value: range ? `${fmt.num(bl.p10)}–${fmt.num(bl.p90)}` : fmt.num(bl.w), unit: 'W',
                sub: bl.estimated
                    ? 'Always-on, estimated from your quietest half-hours'
                    : `Always-on load on 8 days in 10 · last 2 months ${fmt.w(bl.recentW)}`,
                tone: flagged ? 'warn' : 'default',
                help: 'Each day’s always-on figure is the average of its four lowest half-hours (real meter readings only). 8 days in 10 fall in this range; the rest are quieter or busier.',
            }),
            ui.statTile({
                label: 'Used 4–7pm', value: fmt.pct(pk.kwhSharePct, { dp: 0 }), unit: 'of your kWh',
                sub: `${fmt.pct(pk.costSharePct, { dp: 0 })} of what you pay for energy · ${fmt.kwh(pk.kwhPerDay)} a day`,
            }),
            ui.statTile({
                label: yearish ? 'Energy, last 12 months' : `Energy, ${fmt.num(Math.round(days))} days`, value: fmt.gbp(tot.energyGbp),
                sub: `+ ${fmt.gbp(tot.standingGbp)} standing charges · ${fmt.kwh(tot.kwh)}${estPct >= 1 ? ` · ${fmt.pct(estPct, { dp: 0 })} estimated` : ''}`,
            }),
            ui.statTile({
                label: 'Average price paid', value: fmt.p(lw), unit: 'per kWh',
                sub: finite(tw) ? `The plain average price was ${fmt.p(tw)} — ${lw > tw ? 'your use leans to dearer times' : 'you already lean to cheaper times'}` : null,
                help: 'What your usage cost per kWh (as billed, incl. VAT), against the simple average of every half-hour’s price — what a perfectly flat load would pay.',
            }));
    },

    fillDay(summary, ins) {
        const { ui, fmt, charts } = this.ctx;
        const h = ui.h;
        const v = this.v;
        const bl = ins.baseLoad || {};
        const loadW = Array.from(ins.profiles?.load || [], kwh => gap(toW(kwh)));
        const price = Array.from(ins.profiles?.priceBilled || [], gap);
        const tw = ins.timeWeightedPriceP;
        // ticks on whole 3-hour marks only; the tooltip and table give the exact half-hour
        const x = { values: HH, format: (val, i) => (i % 6 === 0 ? val : ''), tipFormat: (_, i) => hhRange(i) };

        const loadSpec = {
            title: 'Your load', ariaLabel: 'Average load by half-hour of the day, in watts',
            height: 190, gutter: 58, endLabels: false, x,
            y: { label: 'W', format: val => fmt.num(val) },
            series: [
                { key: 'load', label: 'Average load', color: 'load', values: loadW, area: true, format: val => fmt.w(val) },
                finite(bl.w) ? { key: 'base', label: 'Always-on load', color: 'muted', values: HH.map(() => bl.w), dash: [4, 4], format: val => fmt.w(val) } : null,
            ].filter(Boolean),
            bands: [{ from: PEAK[0], to: PEAK[1], label: '4–7pm', legend: false }],
        };
        const priceSpec = {
            title: 'The price', ariaLabel: 'Average price by half-hour of the day, pence per kWh including VAT',
            height: 190, gutter: 58, endLabels: false, x,
            y: { label: 'p/kWh', format: val => fmt.num(val, 0) },
            series: [
                { key: 'price', label: 'Average price, incl. VAT', color: 'price', values: price, format: val => fmt.p(val) },
                finite(tw) ? { key: 'flat', label: 'All-day average', color: 'muted', values: HH.map(() => tw), dash: [4, 4], format: val => fmt.p(val) } : null,
            ].filter(Boolean),
            bands: [{ from: PEAK[0], to: PEAK[1], legend: false }],
        };
        this.chart('loadProfile', charts.createLine, v.parts.loadProfile, loadSpec);
        this.chart('priceProfile', charts.createLine, v.parts.priceProfile, priceSpec);

        // 4–7pm panel: what a peak kWh costs against the rest of the day
        const pk = ins.peak || {};
        const tot = ins.totals || {};
        const peakKwh = (tot.kwh * (pk.kwhSharePct ?? 0)) / 100;
        const peakP = (tot.energyGbp * 100 * (pk.costSharePct ?? 0)) / 100;
        const peakPrice = peakKwh > 0 ? peakP / peakKwh : null;
        const restPrice = tot.kwh - peakKwh > 0 ? (tot.energyGbp * 100 - peakP) / (tot.kwh - peakKwh) : null;
        const perDayGbp = finite(peakPrice) && finite(pk.kwhPerDay) ? (pk.kwhPerDay * peakPrice) / 100 : null;
        const ratio = finite(peakPrice) && finite(restPrice) && restPrice > 0 ? peakPrice / restPrice : null;
        v.parts.peakPanel.replaceChildren(
            h('div', { class: 'uv-panel-title' }, 'The 4–7pm peak'),
            figurePair(h, [
                { label: 'You paid per kWh at 4–7pm', value: fmt.p(peakPrice), strong: true },
                { label: 'and the rest of the day', value: fmt.p(restPrice) },
            ]),
            h('p', null, 'You use ', h('b', null, `${fmt.kwh(pk.kwhPerDay)} a day`), ' in those three hours — ',
                h('b', null, fmt.pct(pk.kwhSharePct, { dp: 0 })), ' of your electricity but ', h('b', null, fmt.pct(pk.costSharePct, { dp: 0 })),
                ` of what it costs${finite(perDayGbp) ? `, about ${fmt.gbp(perDayGbp, { dp: 2 })} a day` : ''}.`),
            finite(ratio) && ratio > 1.2 ? h('p', null, `Each peak kWh costs ${fmt.num(ratio, 1)}× the rest — which is why panels facing west and batteries are worth testing. There’s little sun after 4pm from November to February, though.`) : null,
            h('div', { class: 'uv-panel-links' },
                ui.button({ label: 'Does facing west pay?', kind: 'link', size: 'sm', href: '#orientation', icon: 'arrowRight' }),
                ui.button({ label: 'See the verdict', kind: 'link', size: 'sm', href: '#verdict', icon: 'arrowRight' })));
    },

    fillMonthly(summary, ins) {
        const { fmt, charts, store } = this.ctx;
        const v = this.v;
        const bl = ins.baseLoad || {};
        const bills = ins.monthlyBills || [];
        const keys = (bl.monthly?.length ? bl.monthly : bills).map(m => m.key);
        const long = keys.length > 12;
        const bands = monthlyBaseBands(bl.dailyW, ins.heatmap?.dates, keys);
        const med = new Map((bl.monthly || []).map(m => [m.key, m.w]));
        const pb = store.get().settings?.projectBaseW;
        const flagged = finite(bl.driftPct) && Math.abs(bl.driftPct) >= DRIFT_FLAG_PCT;

        // y from below the lowest low day (not zero) so the spread and any drift are visible;
        // the floor is still labelled, so nothing pretends the load is near zero.
        const lows = bands.map(b => b.p10).filter(finite);
        const highs = bands.map(b => b.p90).filter(finite);
        if (finite(pb)) { lows.push(pb); highs.push(pb); }
        const lo = lows.length ? Math.min(...lows) : 0;
        const hi = highs.length ? Math.max(...highs) : 1;
        // Never zoom closer than ±12.5 % of the load: a steady load should look steady.
        const span = Math.max(hi - lo, 0.25 * hi, 40);
        const pad = (span - (hi - lo)) / 2 + span * 0.08;
        const step = span > 400 ? 100 : span > 150 ? 50 : 20;
        const yMin = Math.max(0, Math.floor((lo - pad) / step) * step);
        const yMax = Math.ceil((hi + pad) / step) * step;

        const series = [
            { key: 'p50', label: 'Typical day', color: 'load', values: bands.map(b => gap(med.has(b.key) ? med.get(b.key) : b.p50)), format: val => fmt.w(val) },
            { key: 'p90', label: 'Busiest 10%', color: 'muted', values: bands.map(b => gap(b.p90)), dash: [2, 3], format: val => fmt.w(val) },
            { key: 'p10', label: 'Quietest 10%', color: 'muted', values: bands.map(b => gap(b.p10)), dash: [5, 4], format: val => fmt.w(val) },
        ];
        if (finite(pb)) series.push({ key: 'proj', label: `Used for forecasts (${fmt.w(pb)})`, color: '--accent', values: keys.map(() => pb), dash: [6, 3], format: val => fmt.w(val) });
        const n = keys.length;
        this.chart('baseMonthly', charts.createLine, v.parts.baseMonthly, {
            title: 'Always-on load, month by month',
            ariaLabel: 'Always-on load by month: median day, with the quietest and busiest 10% of days',
            height: 240, endLabels: false,
            x: { values: keys, format: k => monthTick(k, long), tipFormat: (k, i) => `${fmt.month(k)} · ${bands[i]?.days ? `${bands[i].days} days` : 'no complete days of readings'}` },
            y: { label: 'W', format: val => fmt.num(val), min: yMin, max: yMax, zero: false },
            series,
            bands: flagged && n >= 3 ? [{ from: n - 2, to: n, label: 'last 2 months', legend: false }] : [],
        });
        v.parts.baseSub.textContent = `Each day’s always-on figure, by month: the typical day, and the quietest and busiest 10% of days. Whole period ${fmt.w(bl.w)} · last 2 months ${fmt.w(bl.recentW)}.`;

        const billKeys = bills.map(b => b.key);
        const billLong = billKeys.length > 12;
        // Months whose usage is mostly estimated (gap-filled or extended to a year) are drawn as
        // outlines — the app's mark for "not as it happened" — with the share in the tooltip.
        const estShare = estimatedShareByMonth(ins.heatmap, billKeys);
        const isEst = estShare.map(f => f > 0.5);
        const energyFmt = val => fmt.gbp(val, { dp: 2 });
        const energySeries = isEst.some(Boolean)
            ? [
                { key: 'energy', label: 'Energy', color: 'import', values: bills.map((b, i) => (isEst[i] ? null : b.energyGbp)), format: energyFmt },
                { key: 'energyEst', label: 'Energy, mostly estimated', color: 'import', outline: true, values: bills.map((b, i) => (isEst[i] ? b.energyGbp : null)), format: energyFmt },
            ]
            : [{ key: 'energy', label: 'Energy', color: 'import', values: bills.map(b => b.energyGbp), format: energyFmt }];
        this.chart('bills', charts.createBars, v.parts.bills, {
            title: 'Monthly bills',
            ariaLabel: 'Monthly electricity bill: energy and standing charges, as billed including VAT',
            height: 240, stacked: true, totalLabel: 'Bill',
            categories: billKeys,
            x: {
                label: 'Month',
                format: k => monthTick(k, billLong),
                tipFormat: (k, i) => {
                    const b = bills[i];
                    const dim = daysInMonth(k);
                    const part = b && b.coveredDays < dim - 0.01 ? ` · ${fmt.num(b.coveredDays, 0)} of ${dim} days` : '';
                    const est = estShare[i] >= 0.005 ? ` · ${fmt.pct(100 * estShare[i], { dp: 0 })} estimated` : '';
                    return `${fmt.month(k)} · ${fmt.kwh(b?.kwh)}${part}${est}`;
                },
            },
            // Whole pounds on the axis ticks; the stacked total in the tooltip keeps its pence, so it
            // adds up with the energy and standing figures shown above it.
            y: { format: val => fmt.gbp(val, { dp: Math.abs(val - Math.round(val)) < 1e-9 ? 0 : 2 }) },
            series: [
                ...energySeries,
                { key: 'standing', label: 'Standing charge', color: 'muted', values: bills.map(b => b.standingGbp), format: val => fmt.gbp(val, { dp: 2 }) },
            ],
        });
        const tot = ins.totals || {};
        const partial = bills.filter(b => b.coveredDays < daysInMonth(b.key) - 0.01).length;
        v.parts.billsSub.textContent = `As billed, incl. VAT: ${fmt.gbp(tot.energyGbp)} energy + ${fmt.gbp(tot.standingGbp)} standing over ${fmt.num(Math.round(tot.days ?? summary.days))} days${partial ? ` (${partial} part month${partial > 1 ? 's' : ''})` : ''}.`;
    },

    /* ── 'More charts' (built on first open) ────────────────────────────── */

    fillMore() {
        const v = this.v;
        if (!v?.ins) return;
        const { ui, fmt, charts } = this.ctx;
        const h = ui.h;
        const ins = v.ins;
        const summary = v.summary;
        const hm = ins.heatmap || {};
        const p = v.parts;

        if (!v.moreBuilt) {
            v.moreBuilt = true;
            p.loadHeat = h('div', { class: 'uv-untitled' });
            p.priceHeat = h('div', { class: 'uv-untitled' });
            p.negChart = h('div', { class: 'uv-untitled' });
            p.negLede = h('p', { class: 'uv-lede-sm' });
            p.shift = h('div');
            p.flex = h('div', { hidden: true });
            p.facts = h('div');
            p.loadHeatNote = h('div', { class: 'uv-note' });
            p.priceHeatNote = h('div', { class: 'uv-note' });
            p.more.replaceChildren(
                ui.card({ level: 3, title: 'Your load, every half-hour', subtitle: 'Days run left to right, time of day top to bottom.', body: [p.loadHeat, p.loadHeatNote] }),
                ui.card({ level: 3, title: 'The price, every half-hour', subtitle: 'As billed, incl. VAT.', body: [p.priceHeat, p.priceHeatNote] }),
                h('div', { class: 'grid-2' },
                    ui.card({ level: 3, title: 'When Agile paid you to use electricity', body: [p.negLede, p.negChart] }),
                    h('div', { class: 'stack' },
                        ui.card({ level: 3, title: 'How much you already shift', body: p.shift }),
                        p.flex,
                        ui.card({ level: 3, title: 'About this data', body: p.facts }))));
        }

        // heatmaps (W for load, as everywhere on this tab)
        const D = hm.days || 0;
        const loadVals = new Float32Array(D * 48);
        for (let i = 0; i < D * 48; i++) loadVals[i] = toW(hm.load?.[i] ?? NaN);
        const [l1, l99] = quantilesOf(loadVals, [0.01, 0.99]);
        const gaps = heatmapGaps(hm);
        this.chart('loadHeat', charts.createHeatmap, p.loadHeat, {
            title: 'Your load, every half-hour',
            ariaLabel: 'Load for every half-hour of every day, in watts',
            rows: D, cols: 48, values: loadVals, rowLabels: hm.dates || [], colLabels: HH, transpose: true, height: 260,
            valueLabel: 'average over the half-hour', format:val => `${fmt.num(val)}\u00a0W`,
            scale: { ramp: 'sequential', min: finite(l1) ? l1 : undefined, max: finite(l99) ? l99 : undefined },
        });
        // What the grey cells are, in the coverage's own terms (half-hours), not "missing cells":
        // the hour the clocks skip in March is grey too but was never missing.
        const cov = ins.coverage || summary.coverage || {};
        const why = [
            cov.extrapolatedSlots > 0 ? `${fmt.num(cov.extrapolatedSlots)} half-hours outside the period your meter covers, estimated to make up a full year` : null,
            cov.filledSlots > 0 ? `${fmt.num(cov.filledSlots)} in gaps, filled in from the same time on similar days` : null,
        ].filter(Boolean);
        const dstNote = gaps.skippedDates.length
            ? ` The grey notch on ${gaps.skippedDates.map(d => fmt.date(Date.parse(`${d}T12:00:00Z`))).join(' and ')} is the hour the clocks went forward.`
            : '';
        p.loadHeatNote.replaceChildren(h('span', { class: 'uv-swatch', 'aria-hidden': 'true' }),
            h('span', null, gaps.noReading
                ? `Grey: no meter reading${why.length ? ` — ${why.join('; ')}` : ` (${fmt.num(gaps.noReading)} half-hour${gaps.noReading === 1 ? '' : 's'})`}.${dstNote} ${SCALE_NOTE}.`
                : `Every half-hour has a real meter reading.${dstNote} ${SCALE_NOTE}.`));

        const priceVals = hm.price || new Float32Array(0);
        const [p1, p99] = quantilesOf(priceVals, [0.01, 0.99]);
        const tw = ins.timeWeightedPriceP;
        this.chart('priceHeat', charts.createHeatmap, p.priceHeat, {
            title: 'The price, every half-hour',
            ariaLabel: 'Import price for every half-hour of every day, pence per kWh',
            rows: D, cols: 48, values: priceVals, rowLabels: hm.dates || [], colLabels: HH, transpose: true, height: 260,
            valueLabel: 'per kWh, incl. VAT', format: val => fmt.p(val),
            scale: { ramp: 'diverging', mid: finite(tw) ? tw : undefined, min: finite(p1) ? p1 : undefined, max: finite(p99) ? p99 : undefined },
        });
        p.priceHeatNote.replaceChildren(h('span', null,
            `Blue: cheaper than the ${fmt.p(tw)} average · orange: dearer${finite(p1) && p1 < 0 ? ' · the deepest blue is below zero' : ''}. ${SCALE_NOTE} (here ${fmt.p(p1)} to ${fmt.p(p99)}).`));

        // negative prices
        const neg = ins.negative || {};
        const keys = (ins.monthlyBills || []).map(b => b.key);
        const nb = negativeByMonth(hm, keys);
        let topHour = -1, topCount = 0;
        nb.hours.forEach((c, i) => { if (c > topCount) { topCount = c; topHour = i; } });
        if (neg.slots > 0) {
            p.negLede.replaceChildren(
                'Agile went below zero in ', h('b', null, `${fmt.num(neg.slots)} half-hours`), '. You used ', h('b', null, fmt.kwh(neg.kwh)),
                ' in them and were paid ', h('b', null, fmt.gbp(-neg.gbp, { dp: 2 })), ' for it',
                topHour >= 0 ? `; most often around ${HH[topHour]}.` : '.',
                ' Solar would be making power at exactly the times it’s worth least.');
        } else {
            p.negLede.replaceChildren('Your price never went below zero in this period.');
        }
        const negLong = keys.length > 12;
        this.chart('neg', charts.createBars, p.negChart, {
            title: 'Negative-price half-hours by month',
            ariaLabel: 'Half-hours with a negative price, by month',
            height: 220,
            categories: keys,
            x: { label: 'Month', format: k => monthTick(k, negLong), tipFormat: (k, i) => `${fmt.month(k)}${nb.months[i]?.slots ? ` · you used ${fmt.kwh(nb.months[i].kwh)} in them` : ''}` },
            y: { format: val => fmt.num(val) },
            series: [{ key: 'slots', label: 'Half-hours below zero', color: 'price', values: nb.months.map(m => m.slots) }],
            emptyText: 'No negative prices.',
        });

        // load-weighted vs time-weighted price
        const lw = ins.loadWeightedPriceP;
        const shiftPct = finite(lw) && finite(tw) && tw !== 0 ? (100 * (tw - lw)) / tw : null;
        // 4–7pm is 6 of 48 half-hours (12.5 %): well above that, the evening is what tips the balance
        const eveningHeavy = finite(ins.peak?.kwhSharePct) && ins.peak.kwhSharePct > 15;
        p.shift.replaceChildren(
            // 1 dp, the same as the 'Average price paid' tile above
            figurePair(h, [
                { label: 'You paid per kWh, on average', value: fmt.p(lw), strong: true },
                { label: 'A perfectly flat load would pay', value: fmt.p(tw) },
            ]),
            h('p', { class: 'uv-lede-sm', style: { margin: '14px 0 0' } },
                !finite(shiftPct) ? 'Not enough priced readings to compare.'
                    : shiftPct >= 0.5 ? ['You already shift: you pay ', h('b', null, `${fmt.pct(shiftPct)} less`), ' per kWh than a flat load would, because your use leans towards the cheaper half-hours.']
                        : shiftPct <= -0.5 ? ['You pay ', h('b', null, `${fmt.pct(-shiftPct)} more`), ' per kWh than a flat load would: your use leans towards dearer times',
                            eveningHeavy ? ', and the 4–7pm peak is a big part of that. Moving what you can out of those three hours saves money before any solar.' : '. Moving what you can to cheaper half-hours saves money before any solar.']
                            : 'Your use is spread almost exactly like a flat load: no shifting yet, and nothing working against you either.'));

        // Agile vs Flexible — only when the engine supplies Flexible prices (see the report)
        const fx = ins.flexible || ins.tariffCompare?.flexible || null;
        if (fx && finite(fx.energyGbp)) {
            const agileTotal = (ins.totals?.energyGbp ?? 0) + (ins.totals?.standingGbp ?? 0);
            const flexTotal = fx.energyGbp + (finite(fx.standingGbp) ? fx.standingGbp : ins.totals?.standingGbp ?? 0);
            const diff = flexTotal - agileTotal;
            p.flex.replaceChildren(ui.card({ level: 3, title: 'Agile against Flexible', body: [
                figurePair(h, [
                    { label: 'Your prices (Agile)', value: fmt.gbp(agileTotal), strong: diff >= 0 },
                    { label: `Octopus Flexible${finite(fx.unitP) ? ` at ${fmt.p(fx.unitP)}` : ''}`, value: fmt.gbp(flexTotal), strong: diff < 0 },
                ]),
                h('p', { class: 'uv-lede-sm', style: { margin: '14px 0 0' } },
                    Math.abs(diff) < 1 ? 'The same usage would have cost about the same on Flexible.'
                        : diff > 0 ? `The same usage would have cost ${fmt.gbp(diff)} more on Flexible, standing charges included.`
                            : `The same usage would have cost ${fmt.gbp(-diff)} less on Flexible, standing charges included.`),
            ] }));
        } else p.flex.replaceChildren();
        p.flex.hidden = !p.flex.firstChild;

        // data coverage (cov: see the load heatmap above)
        const wx = summary.weather || {};
        const counts = Array.isArray(wx.counts) ? wx.counts : [];
        const wxTotal = counts.reduce((a, c) => a + (c || 0), 0);
        const share = c => { const pc = (100 * c) / (wxTotal || 1); return pc < 0.05 ? '<0.1%' : fmt.pct(pc); };
        const wxItems = counts.map((c, i) => (c ? `${WX_SOURCES[i] ?? `source ${i}`}: ${fmt.num(c)} half-hours (${share(c)})` : null)).filter(Boolean);
        const tariffs = summary.tariffs || [];
        const basis = { mine: 'your own tariffs, as billed', agile: 'Agile today', flexible: 'Octopus Flexible', flat: 'a flat price' }[summary.priceBasis] || summary.priceBasis;
        const facts = [
            ['Usage', [h('b', null, `${fmt.pct(cov.realPct, { dp: cov.realPct >= 99.95 ? 0 : 1 })} real meter readings`),
                ` over ${fmt.num(Math.round(cov.days ?? summary.days))} days.`,
                cov.filledSlots ? ` ${fmt.num(cov.filledSlots)} missing half-hours were filled in from the same time on similar days.` : ' No gaps to fill.',
                cov.extrapolatedSlots ? ` ${fmt.num(cov.extrapolatedSlots)} half-hours were estimated to complete a year.` : '']],
            ['Always-on', ins.baseLoad?.estimated
                ? ['Too few complete days of real readings, so this is the level your quietest 5% of half-hours sit at.', ' Its yearly cost is scaled up month by month.']
                : [`Each day’s figure is the average of its four lowest real half-hours; the headline is the middle value of ${fmt.num(ins.baseLoad?.days)} such days.`,
                    ' Its yearly cost is scaled up month by month, so a part year still gives a full year.']],
            ['Prices', [`Priced on ${basis}`, tariffs.length ? `: ${tariffs.map(t => t.code).join(', ')}` : '', '. Energy includes VAT at the rate charged on each date.']],
            wxItems.length ? ['Sunshine', h('ul', null, wxItems.map(t => h('li', null, t)))] : null,
            summary.notes?.length ? ['Notes', h('ul', null, summary.notes.map(t => h('li', null, t)))] : null,
        ].filter(Boolean);
        p.facts.replaceChildren(
            h('dl', { class: 'uv-facts' }, facts.flatMap(([k, val]) => [h('dt', null, k), h('dd', null, val)])),
            h('p', { class: 'uv-note' }, ui.button({ label: 'Change your data', kind: 'link', size: 'sm', href: '#data', icon: 'arrowRight' })));
    },
};

/* ── view-local components ──────────────────────────────────────────────────── */

/** Inject this view's stylesheet once. */
function injectStyle(h) {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    document.head.appendChild(h('style', { id: STYLE_ID }, CSS));
}

/**
 * usage-floorGlyph — the average day as a profile with the always-on floor filled solid and the
 * rest as a wash: the picture behind "most of your bill is a flat line". Decorative-explanatory
 * (role img + label); the precise numbers are in the average-day chart and its table.
 * @param {Function} h ui.h
 * @param {object} fmt ui.fmt
 * @param {ArrayLike<number>} profileKwh 48 mean kWh per half-hour
 * @param {number} baseW always-on watts
 * @param {number} sharePct always-on share of all kWh
 * @returns {HTMLElement}
 */
function floorGlyph(h, fmt, profileKwh, baseW, sharePct) {
    const W = 480, H = 100;
    const vals = Array.from(profileKwh || [], toW);
    if (vals.length !== 48 || !finite(baseW)) return h('div');
    const top = Math.max(baseW * 1.15, ...vals) * 1.08 || 1;
    const y = val => H - (Math.max(0, val) / top) * H;
    const x = i => ((i + 0.5) / 48) * W;
    const pts = vals.map((val, i) => [x(i), y(val)]);
    pts.unshift([0, y(vals[0])]);
    pts.push([W, y(vals[47])]);
    const line = pts.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join('');
    const yb = y(baseW);
    // area between the profile and the floor (clamped at the floor where the mean dips below it)
    const above = `${pts.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${Math.min(pt[1], yb).toFixed(1)}`).join('')}L${W} ${yb.toFixed(1)}L0 ${yb.toFixed(1)}Z`;
    const px0 = (PEAK[0] / 48) * W, px1 = (PEAK[1] / 48) * W;
    const label = `An average day: an always-on floor of ${fmt.w(baseW)}${finite(sharePct) ? ` makes up ${fmt.pct(sharePct, { dp: 0 })} of your use` : ''}, with the rest on top, highest in the evening.`;
    const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        h('rect', { class: 'uv-floor-peak', x: px0, y: 0, width: px1 - px0, height: H }),
        h('rect', { class: 'uv-floor-base', x: 0, y: yb, width: W, height: H - yb }),
        h('path', { class: 'uv-floor-above', d: above }),
        h('line', { class: 'uv-floor-rule', x1: 0, x2: W, y1: yb, y2: yb, 'vector-effect': 'non-scaling-stroke' }),
        h('path', { class: 'uv-floor-line', d: line, 'vector-effect': 'non-scaling-stroke' }));
    const pct = n => `${((n / 48) * 100).toFixed(3)}%`;
    // The tag sits inside the solid floor when there is room for it. A thin floor would push it
    // onto the profile line, so then the figure lives in the key below instead.
    const roomy = baseW / top >= 0.3;
    return h('figure', { class: 'uv-floor', role: 'img', 'aria-label': label, style: { margin: '20px 0 0' } },
        h('div', { class: 'uv-floor-plot' }, svg,
            h('span', { class: 'uv-floor-peaktag', style: { left: pct((PEAK[0] + PEAK[1]) / 2) } }, '4–7pm'),
            roomy ? h('span', { class: 'uv-floor-tag' }, `always-on ${fmt.w(baseW)}`) : null),
        h('div', { class: 'uv-floor-axis', 'aria-hidden': 'true' },
            h('span', { style: { left: '0%' } }, 'midnight'),
            h('span', { style: { left: '25%' } }, '6am'),
            h('span', { style: { left: '50%' } }, 'noon'),
            h('span', { style: { left: '75%' } }, '6pm'),
            h('span', { style: { left: '100%' } }, 'midnight')),
        h('figcaption', { class: 'uv-floor-key' },
            h('span', null, h('span', { class: 'uv-swatch uv-swatch-base', 'aria-hidden': 'true' }),
                `Always-on ${fmt.w(baseW)}${finite(sharePct) ? ` · ${fmt.pct(sharePct, { dp: 0 })} of your kWh` : ''}`),
            h('span', null, h('span', { class: 'uv-swatch uv-swatch-above', 'aria-hidden': 'true' }), 'Everything else, on an average day')));
}

/**
 * usage-figurePair — two figures side by side for a direct comparison (the stronger one gets the
 * accent rule). Used for peak vs off-peak price and load- vs time-weighted price.
 * @param {Function} h ui.h
 * @param {Array<{ label: string, value: string, strong?: boolean }>} items
 * @returns {HTMLElement}
 */
function figurePair(h, items) {
    return h('div', { class: 'uv-pair' }, items.map(it => h('div', { class: it.strong ? 'is-strong' : null },
        h('div', { class: 'uv-pair-label' }, it.label),
        h('div', { class: 'uv-pair-fig' }, it.value))));
}
