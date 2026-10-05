/*
 * views/compare.js — the Compare tab: every option on one footing (UX critique §'Compare', SPEC §4.5).
 *
 * Data: ctx.data.autoScenarios() (featured + leaderboard rows) merged with the user's saved
 * scenarios (store.scenarios.saved), each run through ctx.data.scenario(system) — the same call
 * and options the verdict uses, so the engine's result cache is shared between the tabs. Curves
 * come straight from the worker (engine.call 'panelCountCurve' | 'batterySizeCurve' |
 * 'baseLoadCurve', each with the user's money settings as { finance: ctx.data.finance() }), and
 * the Verdict's bestBuyId is used for the "Best buy" badge and the default pins when a verdict can
 * be had (the critique's own rule is the fallback). The Verdict prices every option with the
 * user's own prices from here (DataHub passes the overrides), so the two tabs only differ when
 * saved options of the user's own are in the running — the Verdict ranks the ready-made ones.
 *
 * Layout, top to bottom:
 *   1. head: basis line ("your last N days, typical-year sunshine, e% price rise, r% discount")
 *      and Save as PDF
 *   2. leaderboard: podium (best buy · fastest payback · lowest outlay), sort + filter chips,
 *      the table (saves a year with a p10–p90 weather strip on a shared scale, payback, ahead
 *      after 10 yrs, NPV, confidence, on sale, pin), rows beaten on both price and savings greyed
 *      and sorted last (collapsible), future-rules rows under a divider, yardsticks last;
 *      every cost is editable (writes a price override to store.scenarios.saved → re-run)
 *   3. side by side: 2–4 pins (A–D, persisted in store.scenarios.pinned), best per row in gold,
 *      a Difference column and step-up sentence with exactly two pins, money back over the years
 *   4. step-ups ladder · always-on load curve for the pinned options
 *   5. "More panels?" and "A bigger battery?": each step's extra £/yr against what it would need
 *      to save to pay back within the payback limit
 *   6. print-only assumptions block (prices checked date, finance basis)
 *
 * Price overrides: a saved System with the same id as the auto scenario plus
 * { priceOverride: true, overrideOf: id }. Saved systems with an auto id replace that row
 * ("Your price" / "Edited"); others are appended ("Saved").
 *
 * Per-device prefs live in the store's open-ended ui.chartTables map under 'compare.*': sort,
 * route filters, on-sale filter, whether beaten rows are shown, whether the pins were chosen by
 * hand, chart table twins.
 *
 * View-local components (candidates for ui.js — see the report): rangeStrip() (a p10–p90 bar on
 * a shared scale with the typical value as a dot), confMeter() (three-step confidence meter),
 * filterChip() (aria-pressed pill with a route dot), pinButton()/pinLetter() (A–D pin identity
 * used across table, charts and side-by-side) and the step-up ladder. CSS lives in the injected
 * <style id="style-compare">.
 */

import { DEFAULT_FINANCE } from '../finance.js';

const STYLE_ID = 'style-compare';
const PREF = 'compare.';
const MAX_PINS = 4;
const POOL = 2;                       // scenario runs in flight: keeps worker cancels responsive
const LETTERS = ['A', 'B', 'C', 'D'];
const PIN_TOKENS = ['cat1', 'cat2', 'cat3', 'cat4'];
const PIN_VARS = ['--cat-1', '--cat-2', '--cat-3', '--cat-4'];
const VERDICT_WAIT_MS = 12000;
const BEST_BUY_RULE = max => `Legal, on sale and paying back within ${max} years: the plug-in or wired solar furthest ahead after 10 years (a battery only if it is cheaper and worth more)`;
const MINUS = '−';

const ROUTE = {
    plugin: { chip: 'Plug-in', label: 'Plug-in', how: 'Plug into a socket yourself (on an RCD-protected circuit) and register it at myplugin.solar.' },
    hardwired: { chip: 'Electrician', label: 'Electrician', how: 'An electrician fits a dedicated circuit and tells your network operator; about £350.' },
    ups: { chip: 'Power station', label: 'Power station', how: 'The servers plug into the power station, which charges from a normal socket — no grid connection, nothing to register.' },
    whatif: { chip: 'Future rules', label: 'Future rules', how: 'Not legal today — shown for planning only.' },
    reference: { chip: 'Yardstick', label: 'Yardstick', how: 'Nothing to buy.' },
};
const FILTER_ROUTES = ['plugin', 'hardwired', 'ups', 'whatif'];

// '10-yr value' is the Verdict's name for npv10Gbp (discounted); 'Ahead after 10 yrs' is net10Gbp
// (plain pounds) on the Verdict card and in Design, so the two words never swap meaning between tabs.
const SORTS = {
    npv10: { label: '10-yr value', short: '10-yr value' },
    payback: { label: 'Payback', short: 'Payback' },
    capex: { label: 'Cost', short: 'Cost' },
    sav: { label: 'Saves a year', short: 'Saves/yr' },
};

const STYLES = `
.cv { display: flex; flex-direction: column; gap: 20px; }
.cv .view-title:focus { outline: none; }
.cv .view-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.cv-stale-wrap { transition: opacity .2s ease; }
.cv.is-stale .cv-stale-wrap { opacity: .5; }
.cv .chart-tip:not(.show) { transform: none !important; transition: opacity .1s, transform 0s .1s; }
.cv-untitled .chart-title { display: none; }
/* scenario names are long and wrap (shared CSS): keep each key beside the first line */
.cv .chart-legend li { align-items: flex-start; }
.cv .chart-legend li .key { margin-top: 6px; }
.cv-lg { display: inline; }
.cv-sm { display: none; }
.cv-pin.cv-edit-m { display: none; }
.cv-basis { margin-top: 8px; max-width: 92ch; }
.cv-basis b { white-space: nowrap; }
.cv-basis-2 { display: block; }
.cv-basis-2:empty { display: none; }
.cv-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

.cv-status {
    position: sticky; top: 58px; z-index: 6; align-self: flex-start; max-width: 100%;
    display: flex; align-items: center; gap: 12px; min-height: 36px; padding: 6px 16px; margin: -6px 0 -8px;
    border: 1px solid var(--border); border-radius: 999px; background: var(--surface); box-shadow: 0 6px 18px rgba(0, 0, 0, .35);
    font-family: var(--font-mono); font-size: 12px; color: var(--text-2);
}
.cv-status[hidden] { display: none; }
.cv-bar { position: relative; flex: 0 0 120px; height: 3px; border-radius: 3px; background: var(--surface-3); overflow: hidden; }
.cv-bar i { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--accent); border-radius: 3px; transition: width .25s ease; }

/* podium */
.cv-podium { display: grid; grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
.cv-pod { position: relative; min-width: 0; padding: 12px 14px 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--sunk); }
.cv-pod.is-lead { border-color: var(--accent-line); box-shadow: inset 0 2px 0 var(--accent); }
.cv-pod-label { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
.cv-pod.is-lead .cv-pod-label { color: var(--accent); }
.cv-pod-name { display: block; margin-top: 6px; font-size: 14px; font-weight: 600; color: var(--text); text-decoration: none; line-height: 1.3;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
a.cv-pod-name:hover { color: var(--accent-strong); text-decoration: underline; }
.cv-pod-fig { margin-top: 6px; font-family: var(--font-mono); font-size: 13px; color: var(--text-2); }
.cv-pod-fig b { font-size: 18px; font-weight: 600; letter-spacing: -.03em; color: var(--text); margin-right: 4px; }
.cv-pod-note { grid-column: 1 / -1; display: flex; align-items: flex-start; gap: 8px; margin: -4px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--muted); }
.cv-pod-note .icon { flex: none; width: 14px; height: 14px; margin-top: 2px; color: var(--accent); }

/* controls */
.cv-controls { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 24px; margin-bottom: 14px; }
.cv-control { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cv-control-label { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
.cv-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.cv-chip {
    display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 12px;
    border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--text-2);
    font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap;
}
.cv-chip:hover { border-color: var(--border-strong); color: var(--text); }
.cv-chip[aria-pressed='true'] { border-color: var(--accent-line); background: var(--accent-dim); color: var(--text); }
.cv-chip[aria-pressed='true']::after { content: '✓'; font-size: 11px; color: var(--accent); }
.cv-chip-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--rc, var(--faint)); flex: none; }
.cv-chip-dot.is-ring { background: transparent; box-shadow: inset 0 0 0 1.5px var(--route-whatif); }
.cv-count { font-size: 12.5px; color: var(--muted); margin: -4px 0 10px; }
.cv-count b { color: var(--text-2); font-weight: 600; }

/* leaderboard */
.cv-board thead th { white-space: normal; vertical-align: bottom; line-height: 1.35; }
.cv-board th, .cv-board td { padding-left: 8px; padding-right: 8px; }
.cv-board th.c-name { min-width: 190px; }
.cv-board th.c-npv10, .cv-board th.c-npv20 { width: 92px; }
.cv-board .th-sort { display: inline; white-space: normal; text-align: inherit; }
.cv-board .th-arrow { display: inline-block; margin: 0 3px; }
.cv-board td.c-sale, .cv-board td.c-conf { white-space: nowrap; }
.cv-board .th-sort { text-align: inherit; }
.cv-board tbody tr > * { transition: color .15s; }
.cv-board tbody tr.cv-row:hover { background: rgba(255, 255, 255, .022); }
.cv-name { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cv-name-link { color: var(--text); text-decoration: none; font-weight: 550; line-height: 1.35; overflow-wrap: anywhere; }
.cv-name-link:hover { color: var(--accent-strong); text-decoration: underline; }
.cv-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.cv-meta:empty { display: none; }
.cv-meta .badge { height: 20px; font-size: 11px; padding: 0 7px; }
.cv-beaten { font-size: 12px; color: var(--muted); line-height: 1.4; }
.cv-life { font-size: 12px; color: var(--muted); line-height: 1.4; }
.cv-beaten b { color: var(--text-2); font-weight: 500; }
.cv-cost { display: inline-flex; align-items: center; gap: 2px; justify-content: flex-end; }
.cv-edit {
    display: inline-grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 6px;
    background: transparent; color: var(--faint); cursor: pointer; flex: none;
}
.cv-edit:hover { color: var(--accent); background: var(--surface-2); }
.cv-edit .icon { width: 13px; height: 13px; }
.cv-later { display: block; font-size: 10.5px; color: var(--muted); }
.cv-sav { display: inline-flex; align-items: center; gap: 10px; justify-content: flex-end; }
.cv-fig-pending { display: inline-block; width: 5ch; height: 12px; vertical-align: middle; border-radius: 4px; }
.cv-strip { position: relative; display: inline-block; width: 96px; height: 14px; flex: none; }
.cv-strip::before { content: ''; position: absolute; left: 0; right: 0; top: 6.5px; height: 1px; background: var(--hairline); }
.cv-strip-zero { position: absolute; top: 2px; bottom: 2px; width: 1px; background: var(--border-strong); }
.cv-strip-band { position: absolute; top: 4px; height: 6px; min-width: 2px; border-radius: 3px; background: var(--rc); opacity: .38; }
.cv-strip-dot { position: absolute; top: 3px; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%; background: var(--rc); box-shadow: 0 0 0 2px var(--surface); }
.cv-strip-dot.is-ring { background: var(--surface); box-shadow: inset 0 0 0 2px var(--rc), 0 0 0 2px var(--surface); }
.cv-scale { display: flex; justify-content: space-between; gap: 6px; width: 96px; margin-left: auto; margin-top: 4px; font-size: 9.5px; letter-spacing: 0; color: var(--muted); text-transform: none; }
.cv-neg { color: var(--bad); }
.cv-never { color: var(--muted); }
.cv-conf { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; font-size: 12.5px; }
.cv-conf-m { display: inline-flex; gap: 2px; }
.cv-conf-m i { width: 5px; height: 10px; border-radius: 1.5px; background: var(--surface-3); }
.cv-conf-m.l3 i { background: var(--good); }
.cv-conf-m.l2 i:nth-child(-n+2) { background: var(--warn); }
.cv-conf-m.l1 i:first-child { background: var(--bad); }
.cv-sale-no { color: var(--warn); }
.cv-actions-cell { white-space: nowrap; text-align: right; }

tr.cv-row.is-beaten > th, tr.cv-row.is-beaten > td { color: var(--muted); }
tr.cv-row.is-beaten .cv-name-link { color: var(--text-2); font-weight: 500; }
tr.cv-row.is-beaten .cv-strip { filter: grayscale(1); opacity: .7; }
tr.cv-row.is-pinned > th:first-child { box-shadow: inset 3px 0 0 var(--pc); }
tr.cv-row.is-flash { animation: cv-flash 1.6s ease; }
@keyframes cv-flash { 0%, 30% { background: var(--accent-dim); } 100% { background: transparent; } }
tr.cv-row.is-hidden { display: none; }
tr.cv-group > th {
    padding: 18px 10px 8px; border-bottom: 1px solid var(--border);
    font-family: var(--font-mono); font-size: 10.5px; font-weight: 500; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); text-align: left;
}
tr.cv-group > th span { display: block; margin-top: 3px; font-family: var(--font-body); font-size: 12.5px; letter-spacing: 0; text-transform: none; color: var(--muted); }
tr.cv-toggle > td { padding: 8px 10px; }
.cv-link-btn {
    display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 4px; border: 0; background: none;
    color: var(--accent); font: inherit; font-size: 13px; cursor: pointer;
}
.cv-link-btn:hover { color: var(--accent-strong); text-decoration: underline; }
.cv-link-btn .icon { transition: transform .2s ease; }
.cv-link-btn[aria-expanded='true'] .icon { transform: rotate(180deg); }
.cv-how { margin-top: 12px; font-size: 12.5px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px 18px; }
.cv-how span { display: inline-flex; align-items: center; gap: 7px; }

/* pins */
.cv-pin {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 66px; height: 30px; padding: 0 10px;
    border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-2);
    font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap;
}
.cv-pin:hover { border-color: var(--border-strong); color: var(--text); }
.cv-pin[aria-pressed='true'] { border-color: var(--pc); color: var(--text); background: color-mix(in srgb, var(--pc) 13%, transparent); }
.cv-pin:disabled { opacity: .4; cursor: not-allowed; }
.cv-letter {
    display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; flex: none;
    background: var(--pc); color: var(--accent-ink); font-family: var(--font-mono); font-size: 11px; font-weight: 600; line-height: 1;
}
.cv-pin-plus { font-size: 15px; line-height: 1; color: var(--muted); }

/* side by side */
.cv-sbs-wrap { overflow-x: auto; }
.cv-sbs { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 13.5px; }
.cv-sbs th, .cv-sbs td { padding: 9px 12px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
.cv-sbs thead th { border-bottom: 1px solid var(--border); vertical-align: bottom; padding-bottom: 10px; text-align: left; font-weight: 500; }
.cv-sbs thead th:first-child { width: 210px; }
.cv-sbs tbody th { text-align: left; font-weight: 500; color: var(--text-2); }
.cv-sbs tbody th .cv-sbs-help { display: block; font-size: 11.5px; font-weight: 400; color: var(--muted); margin-top: 2px; }
.cv-sbs td { text-align: right; font-family: var(--font-mono); font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
.cv-sbs td.is-text { text-align: left; font-family: var(--font-body); font-size: 13px; color: var(--text-2); line-height: 1.45; }
.cv-sbs td .cv-sub { display: block; font-size: 11.5px; color: var(--muted); margin-top: 2px; white-space: normal; }
.cv-sbs td.is-best .cv-val { color: var(--accent-strong); font-weight: 600; }
.cv-sbs td.is-best .cv-val::before { content: '●'; font-size: 7px; vertical-align: 2px; margin-right: 6px; color: var(--accent); }
.cv-sbs td.cv-diff { color: var(--text-2); background: rgba(255, 255, 255, .015); }
.cv-sbs thead th.cv-diff { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); text-align: right; }
.cv-sbs tbody tr:hover { background: rgba(255, 255, 255, .015); }
.cv-sbs-k { display: none; }
.cv-ph { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
.cv-ph-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
.cv-ph-text a { color: var(--text); text-decoration: none; font-weight: 600; font-size: 13.5px; line-height: 1.3; overflow-wrap: anywhere; }
.cv-ph-text a:hover { color: var(--accent-strong); text-decoration: underline; }
.cv-x {
    display: inline-grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 6px; flex: none;
    background: transparent; color: var(--muted); cursor: pointer;
}
.cv-x:hover { color: var(--text); background: var(--surface-2); }
.cv-x .icon { width: 13px; height: 13px; }
.cv-pinlist { display: none; }
.cv-sbs-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-top: 12px; }
.cv-sbs-note { font-size: 12.5px; color: var(--muted); }
.cv-sbs-note .cv-dotkey { color: var(--accent); font-size: 8px; vertical-align: 2px; margin-right: 4px; }
.cv-stepline { margin-top: 14px; padding: 12px 14px; border: 1px solid var(--hairline); border-left: 2px solid var(--accent); border-radius: 0 8px 8px 0; background: var(--sunk); font-size: 14px; color: var(--text-2); }
.cv-stepline b { color: var(--text); font-weight: 600; }
.cv-add { display: flex; align-items: center; gap: 8px; }
.cv-add .select { min-width: 220px; max-width: 320px; }
.cv-chart-gap { margin-top: 22px; }

/* ladder */
.cv-ladder { list-style: none; margin: 0; padding: 0; position: relative; }
.cv-ladder::before { content: ''; position: absolute; left: 6px; top: 14px; bottom: 14px; width: 2px; background: var(--border); border-radius: 2px; }
.cv-node { position: relative; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 7px 0 7px 26px; }
.cv-node::before {
    content: ''; position: absolute; left: 1px; top: 12px; width: 12px; height: 12px; border-radius: 50%;
    background: var(--rc, var(--faint)); box-shadow: 0 0 0 3px var(--surface);
}
.cv-node.is-start::before { background: var(--surface); box-shadow: inset 0 0 0 2px var(--faint), 0 0 0 3px var(--surface); }
.cv-node-name { min-width: 0; font-size: 14px; font-weight: 550; color: var(--text); line-height: 1.35; }
.cv-node-name a { color: inherit; text-decoration: none; }
.cv-node-name a:hover { color: var(--accent-strong); text-decoration: underline; }
.cv-node-fig { flex: none; font-family: var(--font-mono); font-size: 12.5px; color: var(--muted); text-align: right; white-space: nowrap; }
.cv-node-fig b { color: var(--text-2); font-weight: 500; }
.cv-rung { position: relative; padding: 2px 0 4px 26px; font-size: 13px; color: var(--text-2); line-height: 1.5; }
.cv-rung-pill {
    display: inline-flex; align-items: center; gap: 5px; margin-left: 4px; padding: 1px 8px; border-radius: 999px;
    font-family: var(--font-mono); font-size: 11.5px; white-space: nowrap; border: 1px solid transparent;
}
.cv-rung-pill.tone-good { color: var(--good); background: var(--good-dim); border-color: rgba(92, 178, 130, .35); }
.cv-rung-pill.tone-warn { color: var(--warn); background: var(--warn-dim); border-color: rgba(217, 163, 58, .35); }
.cv-rung-pill.tone-bad { color: var(--bad); background: var(--bad-dim); border-color: rgba(217, 112, 95, .35); }
.cv-rung .num { color: var(--text); }
.cv-foot { margin-top: 12px; font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.cv-lede { color: var(--text-2); font-size: 14px; margin-bottom: 14px; max-width: 70ch; }
.cv-lede b { color: var(--text); font-weight: 600; }
.cv-pick { margin-bottom: 14px; }
.cv-pick .field { max-width: 460px; }
.cv-error { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.cv-print-only { display: none; }
.cv-facts { list-style: none; margin: 14px 0 0; padding: 12px 0 0; border-top: 1px solid var(--hairline); display: grid; gap: 8px; font-size: 13px; color: var(--text-2); }
.cv-facts li { display: flex; gap: 10px; align-items: flex-start; line-height: 1.45; }
.cv-facts li .cv-letter { margin-top: 1px; }
.cv-facts b { color: var(--text); font-weight: 600; }
.cv-letter-ref { background: var(--surface-3); color: var(--text-2); }

@media (max-width: 1180px) {
    .cv-board .c-npv20 { display: none; }
}
@media (max-width: 1023px) {
    .cv-podium { gap: 8px; }
}
@media (max-width: 960px) {
    .cv-board .c-conf, .cv-board .c-sale { display: none; }
}
@media (pointer: coarse), (max-width: 600px) {
    /* text links that are primary targets: grow the hit area to 44 px without moving anything */
    .cv-name-link, .cv-node-name a { display: inline-block; padding: 13px 0; margin: -13px 0; }
    .cv-pod-name::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
    .cv-pinlist-item a { display: flex; align-items: center; min-height: 44px; }
    .cv-chip { min-height: 44px; }
    .cv-pin { height: 44px; }
    .cv-edit, .cv-x { width: 44px; height: 44px; }
    .cv-link-btn { min-height: 44px; }
}
@media (max-width: 600px) {
    .cv-podium { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .cv-pod { padding: 10px 11px 11px; }
    .cv-pod-label { font-size: 9.5px; letter-spacing: .07em; }
    .cv-pod-name { margin-top: 4px; font-size: 13px; }
    .cv-pod-fig { margin-top: 4px; font-size: 11.5px; line-height: 1.45; }
    .cv-pod-fig b { display: block; font-size: 16px; }
    .cv-controls { flex-direction: column; align-items: stretch; }
    .cv-control .segmented { width: 100%; }
    .cv-lg { display: none; }
    .cv-sm { display: inline; }
    .cv-edit-d { display: none !important; }
    .cv-pin.cv-edit-m { display: inline-flex; min-width: 0; }
    .cv-board .c-npv20, .cv-board .c-conf, .cv-board .c-sale { display: none !important; }
    .cv-board tbody tr.cv-row { grid-template-columns: minmax(0, 1fr) auto; }
    /* the desktop name column's 190 px floor would push the title under the range strip */
    .cv-board th.c-name { min-width: 0; }
    .cv-board tbody .m-primary { align-self: start; }
    .cv-board .cv-sav { flex-direction: column; align-items: flex-end; gap: 4px; }
    .cv-board .cv-strip { width: 96px; }
    .cv-board tbody .m-show .cv-cost { gap: 0; }
    .cv-board tbody td.cv-actions-cell { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
    .cv-board tbody td.cv-actions-cell .cv-pin { min-width: 104px; }
    .cv-board tbody td.cv-actions-cell:empty { display: none; }
    .tbl tbody tr.cv-group { display: block; border: 0; background: none; padding: 14px 2px 4px; margin: 0; }
    .tbl tbody tr.cv-group > th { display: block; padding: 0; border: 0; }
    .tbl tbody tr.cv-toggle { display: block; border: 0; background: none; padding: 0 0 8px; margin: 0; }
    .tbl tbody tr.cv-toggle > td { display: block; padding: 0; border: 0; }
    .tbl tbody tr.cv-row.is-hidden { display: none; }
    .tbl tbody tr.cv-row.is-pinned > th:first-child { box-shadow: none; }
    .tbl tbody tr.cv-row.is-pinned { border-color: var(--pc); }
    .cv-sbs-wrap { overflow: visible; }
    .cv-sbs, .cv-sbs tbody, .cv-sbs tr, .cv-sbs th, .cv-sbs td { display: block; width: auto; }
    .cv-sbs thead { display: none; }
    .cv-sbs tbody tr { border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px 8px; margin-bottom: 8px; background: var(--sunk); }
    .cv-sbs tbody tr:hover { background: var(--sunk); }
    .cv-sbs tbody th { padding: 0 0 6px; border: 0; color: var(--text); font-weight: 600; }
    .cv-sbs td { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: baseline; gap: 12px; padding: 5px 0; border: 0; border-top: 1px solid var(--hairline); }
    .cv-sbs td.is-text { display: block; }
    .cv-sbs td.cv-diff { background: none; }
    .cv-sbs-k { display: inline-flex; align-items: center; gap: 7px; min-width: 0; font-family: var(--font-body); font-size: 12.5px; color: var(--text-2); text-align: left; }
    .cv-sbs-k span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 30vw; }
    .cv-sbs td.is-text .cv-sbs-k { margin-bottom: 3px; }
    .cv-sbs td .cv-cell { text-align: right; min-width: 0; }
    .cv-sbs td.is-text .cv-cell { text-align: left; }
    .cv-pinlist { display: flex; flex-direction: column; gap: 6px; margin: 0 0 12px; padding: 0; list-style: none; }
    .cv-pinlist-item { display: flex; align-items: center; gap: 10px; padding: 4px 4px 4px 10px; border: 1px solid var(--border); border-radius: 8px; }
    .cv-pinlist-item a { flex: 1; min-width: 0; color: var(--text); text-decoration: none; font-weight: 550; font-size: 13.5px; }
    /* the card head wraps on phones, but its actions are flex:none and a <select> is as wide as its
       longest option (a 700 px scenario name): let the actions take the row and the select shrink */
    .cv .card-actions { flex: 1 1 100%; min-width: 0; max-width: 100%; justify-content: stretch; }
    .cv .card-actions > .card-actions { flex-wrap: nowrap; }
    .cv-add { flex: 1 1 auto; width: auto; min-width: 0; }
    .cv-add .select { min-width: 0; max-width: 100%; width: 100%; }
    .cv-node { flex-direction: column; gap: 2px; }
    .cv-node-fig { text-align: left; }
}
@media print {
    /* the leaderboard runs to several pages: let its card break (the shared rule keeps cards whole,
       which pushed it off page one and left the title page blank) but keep rows, pins and steps whole */
    .cv .card { break-inside: auto !important; }
    .cv tr, .cv-pod, .cv-node, .cv-rung, .cv-facts li, .cv-stepline, .cv-print-block { break-inside: avoid; }
    .cv .card-head, .cv .chart-head, .cv-sbs thead { break-after: avoid; }
    .cv.is-stale .cv-stale-wrap { opacity: 1; }
    .cv-print-only { display: block; }
    .cv-controls, .cv-status, .cv-edit, .cv-pin, .cv-x, .cv-add, .cv-link-btn, .cv-actions-cell, .cv-actions-h, tr.cv-toggle { display: none !important; }
    tr.cv-row.is-hidden { display: table-row !important; }
    .cv-board .c-npv20, .cv-board .c-conf, .cv-board .c-sale { display: table-cell !important; }
    .cv-strip::before { background: #ccc; }
    .cv-strip-dot { box-shadow: none; }
    .cv-pod, .cv-stepline, .cv-sbs td.cv-diff { background: #fff !important; }
    tr.cv-row.is-beaten > th, tr.cv-row.is-beaten > td { color: #777 !important; }
    .cv-print-block { border: 1px solid #ccc; border-radius: 8px; padding: 12px 14px; font-size: 10pt; color: #222; }
    .cv-print-block h2 { font-size: 12pt; margin-bottom: 6px; }
    .cv-print-block ul { margin: 0; padding-left: 18px; }
}
`;

/* ── pure helpers (exported for tests) ──────────────────────────────────────── */

const finite = v => typeof v === 'number' && Number.isFinite(v);
const num = v => (finite(v) ? v : null);
/* a saved option's lists (costs, products, panels) as arrays: junk saved before the import checks never throws */
const list = v => (Array.isArray(v) ? v : []);
const EPS = 0.005;

/** Stable JSON (sorted keys) for change detection. */
export function stableJson(v) {
    const walk = x => {
        if (x === undefined) return null;
        if (x === null || typeof x !== 'object') return typeof x === 'number' && !Number.isFinite(x) ? String(x) : x;
        if (ArrayBuffer.isView(x)) return Array.from(x);
        if (Array.isArray(x)) return x.map(walk);
        const o = {};
        for (const k of Object.keys(x).sort()) if (typeof x[k] !== 'function') o[k] = walk(x[k]);
        return o;
    };
    return JSON.stringify(walk(v));
}

/** The engine-facing copy of a system (drops this view's override markers). */
export function engineSystem(sys) {
    const { priceOverride, overrideOf, ...rest } = sys || {};
    return rest;
}

/**
 * Auto scenarios merged with saved ones: a saved system with an auto id replaces that row
 * (kind 'price' for a price override, 'edited' otherwise); others are appended (kind 'saved').
 * @param {object[]} auto
 * @param {object[]} saved
 * @returns {Array<{ sys: object, kind: 'auto'|'price'|'edited'|'saved', auto: object|null }>}
 */
export function mergeSystems(auto, saved) {
    const byId = new Map((auto || []).map(s => [s.id, { sys: s, kind: 'auto', auto: s }]));
    const extra = [];
    const seen = new Set();
    for (const s of Array.isArray(saved) ? saved : []) {
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || seen.has(s.id)) continue;
        seen.add(s.id);
        if (byId.has(s.id)) byId.set(s.id, { sys: s, kind: s.priceOverride ? 'price' : 'edited', auto: byId.get(s.id).auto });
        else extra.push({ sys: s, kind: 'saved', auto: null });
    }
    return [...byId.values(), ...extra];
}

/**
 * Pence saved per kWh of solar made — Design's definition (design.js solarPPerKwh), so the two tabs
 * show one number. With a battery the headline saving also holds what it earns charging in cheap
 * half-hours (and loses on standby), which isn't the solar's doing: count the panels alone
 * (battery.baseGbp) plus the battery's storing-solar share instead. Without the battery split
 * (no battery, or a proxy run) it is the headline saving ÷ kWh made. When the engine fills
 * headline.pvValuePPerKwh (the same figure, worked out once in core.js), that is used as is.
 * @param {object|null} res ScenarioResult
 * @returns {number|null}
 */
export function solarPPerKwh(res) {
    const hl = res?.headline;
    if (!hl || !finite(hl.pvKwh) || !(hl.pvKwh > 1)) return null;
    if (finite(hl.pvValuePPerKwh)) return hl.pvValuePPerKwh;
    const b = res.battery;
    const gbp = b && finite(b.baseGbp) ? b.baseGbp + Math.max(0, b.split?.fromSolarGbp ?? 0) : hl.savingsGbp;
    return finite(gbp) ? (100 * gbp) / hl.pvKwh : null;
}

/**
 * One leaderboard row from a system and its ScenarioResult (res may be null while it runs).
 * Saved options come from this device's storage, which may hold anything an older import let
 * through (costs: 'free', sourceIds: 'kit-1', upgrade: { costs: {} }): a list that isn't one
 * counts as empty, so the row still renders.
 * @param {{ sys: object, kind: string }} entry
 * @param {object|null} res
 * @param {{ products: Map<string, object> }} env
 */
export function rowModel(entry, res, env = {}) {
    const sys = entry.sys;
    const h = res?.headline || null;
    const A = res?.typical?.annual || null;
    const costs = list(sys.costs);
    const costs0 = costs.filter(c => !(Number(c?.year) > 0));
    const sumOf = items => items.reduce((s, c) => s + (Number(c?.gbp) || 0), 0);
    const products = list(sys.sourceIds).map(id => env.products?.get(id)).filter(Boolean);
    const warnings = list(res?.rules?.warnings);
    const legal = res?.rules?.legal ?? (sys.route === 'whatif' ? 'whatif' : sys.route === 'reference' ? 'reference' : 'ok');
    const battery = sys.battery && typeof sys.battery === 'object' ? sys.battery : null;
    const r = {
        id: sys.id, name: typeof sys.name === 'string' && sys.name.trim() ? sys.name : String(sys.id), route: sys.route, kind: entry.kind, sys, res, ready: !!res,
        featured: !!sys.featured, legal,
        errors: list(res?.rules?.errors).length,
        warnings,
        capex: finite(h?.capexGbp) ? h.capexGbp : sumOf(costs0),
        install: sumOf(costs0.filter(c => c?.kind === 'install')),
        sav: num(h?.savingsGbp), p10: num(h?.p10Gbp), p90: num(h?.p90Gbp), actual: num(h?.actualGbp),
        payback: num(h?.paybackYears), dpayback: num(res?.finance?.discountedPaybackYears),
        npv10: num(h?.npv10Gbp), net10: num(h?.net10Gbp), npv20: num(h?.npvGbp),
        pvKwh: num(h?.pvKwh), selfUse: num(h?.selfUsePct), exportKwh: num(h?.exportKwh), unpaidKwh: num(h?.exportUnpaidKwh),
        exportIncome: num(h?.exportIncomeGbp),
        clipped: num(A?.clippedKwh) ?? 0, curtailed: num(A?.curtailedKwh) ?? 0, upsWasted: num(A?.upsPvWastedKwh) ?? 0,
        // 4–7pm share of everything the option's panels make, a power station's own panels included
        // (peakGenSharePct counts grid-tied panels only)
        peakShare: num(h?.peakGenShareAllPct) ?? num(h?.peakGenSharePct), cycles: num(A?.battCycles) ?? 0,
        pvAcKwh: num(A?.pvAcKwh) ?? 0, upsPvKwh: num(A?.upsPvKwh) ?? 0,
        // the last year a battery or power station saves; with 'buy a new battery when it wears
        // out' on, the figures include the new one (finance flag batteryReplaced)
        batteryEndYear: num(res?.finance?.batteryEndYear),
        batteryReplaced: list(res?.finance?.flags).includes('batteryReplaced'),
        hasBattery: !!battery, coupling: battery?.coupling ?? null,
        onSale: !products.some(p => p.availableNow === false) && !warnings.some(w => w?.code === 'NOT_ON_SALE'),
        preorder: products.some(p => p.preorder === true),
        products,
        dominatedBy: null, dominatedHow: null,
    };
    r.lost = r.clipped + r.curtailed + r.upsWasted;
    // a staged plan buys more later: show it beside the upfront cost
    const up = sys.upgrade && typeof sys.upgrade === 'object' ? sys.upgrade : null;
    r.laterGbp = (up ? sumOf(list(up.costs)) : 0) + sumOf(costsLater(costs));
    r.laterYear = num(up?.atYear) ?? num(Number(costsLater(costs)[0]?.year)) ?? null;
    // the solar's share of the saving per kWh made (not the battery's grid charging), as in Design
    r.pPerKwh = solarPPerKwh(res);
    r.pPerKwhSplit = !!res?.battery && finite(res.battery.baseGbp);
    r.paybackSort = r.legal === 'reference' ? -1 : finite(r.payback) ? r.payback : Infinity;
    return r;
}

function costsLater(costs) { return list(costs).filter(c => Number(c?.year) > 0); }

/** Rows that compete on price and savings: not future rules, not yardsticks. */
export const isMain = r => r.legal !== 'whatif' && r.legal !== 'reference';

/**
 * The price overrides as the Verdict receives them (app.js priceOverrides: the first saved entry
 * per id that carries priceOverride), as a stable string: when it changes, the Verdict's pick has
 * to be asked for again.
 * @param {object[]} saved store.scenarios.saved
 * @returns {string}
 */
export function overrideSig(saved) {
    const seen = new Set();
    const out = [];
    for (const s of Array.isArray(saved) ? saved : []) {
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || seen.has(s.id)) continue;
        seen.add(s.id);
        if (s.priceOverride) out.push([s.id, s.costs ?? []]);
    }
    return stableJson(out);
}

/**
 * Does the leaderboard hold options the Verdict doesn't rank? Price overrides ('price' rows) reach
 * the Verdict, so they don't count; saved options of the user's own ('saved') and saved edits of a
 * ready-made option ('edited') do — then the best-buy rule is run on the rows shown here.
 * @param {Array<{ kind: string }>} rows
 * @returns {boolean}
 */
export function hasOwnOptions(rows) {
    return (rows || []).some(r => r.kind === 'saved' || r.kind === 'edited');
}

/**
 * Can the 'More panels?' card vary this row? A plug-in kit (alone or beside a power station —
 * the engine prices the station into every kit it lists), wired-in panels or a power station's
 * own inputs. Future-rules rows without a battery are two kits or a staged plan, not one kit, and
 * yardsticks have nothing to vary.
 * @param {object} r row
 * @returns {boolean}
 */
export function canVaryPanels(r) {
    return !!r && r.ready && r.legal !== 'reference' && (list(r.sys?.arrays).length > 0 || r.coupling === 'ups') && !(r.legal === 'whatif' && !r.hasBattery);
}

/**
 * Dominance (UX critique Compare §2) among the given non-whatif, non-reference rows: s is beaten by
 * t when t costs no more and saves no less, one of them strictly. Only rows on sale without rule
 * errors can beat another (you can't step down to something you can't buy). When several beat
 * a row, the one furthest ahead after 10 years is named. Mutates dominatedBy / dominatedHow.
 * @param {object[]} rows
 */
export function markDominance(rows) {
    const main = rows.filter(r => isMain(r) && r.ready && finite(r.sav) && finite(r.capex));
    for (const r of rows) { r.dominatedBy = null; r.dominatedHow = null; }
    for (const s of main) {
        let best = null;
        for (const t of main) {
            if (t === s || !t.onSale || t.errors) continue;
            const cheaper = t.capex < s.capex - EPS, more = t.sav > s.sav + EPS;
            if (t.capex <= s.capex + EPS && t.sav >= s.sav - EPS && (cheaper || more)) {
                if (!best || (t.npv10 ?? -Infinity) > (best.npv10 ?? -Infinity)) best = t;
            }
        }
        if (best) {
            s.dominatedBy = best.id;
            const cheaper = best.capex < s.capex - EPS, more = best.sav > s.sav + EPS;
            s.dominatedHow = cheaper && more ? 'both' : cheaper ? 'cheaper' : 'more';
        }
    }
    return rows;
}

/**
 * Step-ups (UX critique Compare §3): the rows nobody beats (on sale, no rule errors) by cost; each
 * consecutive pair gives +£ for +£/yr and how long the extra takes to pay back (Δcapex/Δsav).
 * The first step is from nothing.
 * @param {object[]} rows already marked by markDominance
 * @returns {Array<{ from: object|null, to: object, dCapex: number, dSav: number, years: number|null }>}
 */
export function stepUps(rows) {
    const nodes = rows.filter(r => isMain(r) && r.ready && !r.dominatedBy && r.onSale && !r.errors && finite(r.capex) && finite(r.sav))
        .sort((a, b) => a.capex - b.capex || b.sav - a.sav);
    const out = [];
    let prev = null;
    for (const n of nodes) {
        if (prev && Math.abs(n.capex - prev.capex) < EPS && Math.abs(n.sav - prev.sav) < EPS) continue;
        const dCapex = n.capex - (prev?.capex ?? 0);
        const dSav = n.sav - (prev?.sav ?? 0);
        out.push({ from: prev, to: n, dCapex, dSav, years: dSav > EPS ? dCapex / dSav : null });
        prev = n;
    }
    return out;
}

/**
 * Rows the verdict could recommend: legal 'ok', no rule errors, on sale, pays back within the limit.
 * @param {object[]} rows @param {number} maxPaybackYears
 */
export function eligible(rows, maxPaybackYears = 10) {
    return rows.filter(r => r.ready && r.legal === 'ok' && !r.errors && r.onSale && finite(r.payback) && r.payback <= maxPaybackYears && finite(r.npv10));
}

/**
 * The best buy when no verdict is available, mirroring verdict.js: among eligible rows (capex > 0),
 * prefer options without storage (plug-in or electrician solar); highest NPV over 10 years, and
 * within £25 of it the cheapest. Storage that is cheaper and worth more than that pick wins
 * instead. `most` is the option furthest ahead after 10 years when that isn't the best buy.
 * @returns {{ best: string|null, most: string|null }}
 */
export function pickBestBuy(rows, maxPaybackYears = 10) {
    const el = eligible(rows, maxPaybackYears).filter(r => r.capex > 0);
    const byNpv = (a, b) => b.npv10 - a.npv10 || a.capex - b.capex;
    const pick = list => {
        if (!list.length) return null;
        const top = [...list].sort(byNpv)[0];
        return list.filter(r => r.npv10 >= top.npv10 - 25).sort((a, b) => a.capex - b.capex || byNpv(a, b))[0];
    };
    const solar = r => !r.hasBattery && (r.route === 'plugin' || r.route === 'hardwired');
    let best = pick(el.filter(solar).length ? el.filter(solar) : el);
    if (best) {
        const better = el.filter(r => r !== best && r.capex <= best.capex && r.npv10 > best.npv10 + 25);
        if (better.length) best = pick(better);
    }
    const most = best ? el.filter(r => r !== best && r.npv10 > best.npv10 + 25).sort(byNpv)[0] ?? null : null;
    return { best: best?.id ?? null, most: most?.id ?? null };
}

/**
 * 'Fastest payback' and 'Lowest outlay' among eligible rows (capex > 0), ties broken by 10-yr value
 * as verdict.js does, so the badges match the Verdict's.
 * @returns {{ fastest: object|null, cheapest: object|null }}
 */
export function quickest(eligibleRows) {
    const el = (eligibleRows || []).filter(r => r.capex > 0);
    const byNpv = (a, b) => b.npv10 - a.npv10;
    return {
        fastest: [...el].sort((a, b) => a.payback - b.payback || byNpv(a, b))[0] ?? null,
        cheapest: [...el].sort((a, b) => a.capex - b.capex || byNpv(a, b))[0] ?? null,
    };
}

/** Best non-whatif battery (not a power station) and best power station by NPV over 10 years. */
export function bestBy(rows, test) {
    return rows.filter(r => r.ready && isMain(r) && !r.errors && finite(r.npv10) && test(r)).sort((a, b) => b.npv10 - a.npv10)[0] ?? null;
}

/**
 * Default pins (UX critique Compare §4): bestBuy, S03 (the west wall), the best battery, the best UPS.
 * @returns {string[]}
 */
export function defaultPins(rows, bestId) {
    const ids = [bestId, rows.some(r => r.id === 'S03') ? 'S03' : null,
        bestBy(rows, r => r.hasBattery && r.coupling !== 'ups')?.id,
        bestBy(rows, r => r.route === 'ups')?.id];
    return [...new Set(ids.filter(Boolean))].slice(0, MAX_PINS);
}

/**
 * Confidence (UX critique 'How sure'): the lowest of data, weather and model; notes never lower it.
 * @param {object} r row
 * @param {{ realPct?: number, days?: number }} data
 * @returns {{ level: 'high'|'medium'|'low', score: 1|2|3, reasons: string[], notes: string[] }}
 */
export function confidenceOf(r, { realPct = 100, days = 365 } = {}) {
    const reasons = [], notes = [];
    const fmtGbp = v => `£${Math.round(v).toLocaleString('en-GB')}`;
    let data = realPct >= 95 && days >= 330 ? 3 : realPct >= 80 && days >= 180 ? 2 : 1;
    if (data < 3) reasons.push(days < (data === 2 ? 330 : 180) ? `only ${Math.round(days)} days of your data` : `${Math.round(100 - realPct)}% of your half-hours are estimated`);
    let weather = 3;
    if (finite(r.p10) && finite(r.p90) && finite(r.sav) && Math.abs(r.sav) > 1) {
        const spread = (r.p90 - r.p10) / Math.abs(r.res?.band?.p50 ?? r.sav);
        weather = spread <= 0.15 ? 3 : spread <= 0.30 ? 2 : 1;
        if (weather < 3) reasons.push(`weather alone moves it between ${fmtGbp(r.p10)} and ${fmtGbp(r.p90)} a year`);
    }
    let model = 3;
    if (r.legal === 'whatif') { model = 1; reasons.push('not legal today'); }
    else if (r.legal === 'reference') model = 3;
    else if (r.coupling === 'ups') {
        const st = r.products.find(p => p.kind === 'power-station');
        if (st && st.fixedLossW == null) { model = 1; reasons.push(`this unit’s losses aren’t measured; we assume ${st.assumedP0W ?? 20} W`); }
        else { model = 2; reasons.push('depends on how well the power station is automated'); }
    } else if (r.hasBattery) {
        model = 2;
        const b = r.res?.battery;
        reasons.push(b && finite(b.thresholdSystemGbp) && finite(b.optimalSystemGbp)
            ? `depends on how well it’s automated: ${fmtGbp(b.thresholdSystemGbp)} realistic vs ${fmtGbp(b.optimalSystemGbp)} best case`
            : 'depends on how well the battery is automated');
    }
    const arrays = [...list(r.sys?.arrays), ...list(r.sys?.battery?.ups?.pvArrays)];
    if (arrays.some(a => a && !a.shadingExplicit && Number(a.shadingPct ?? 3) === 3)) notes.push('assumes 3% shading — a tree or wall can cost 10–30%');
    // same test as verdict.js: a 'medium' catalog entry, or a weak rating on its price or specs
    if (r.products.some(p => typeof p.confidence === 'string' && (/^medium\b/i.test(p.confidence) || /\b(medium|low|unknown) \((?=[^)]*(price|spec))/i.test(p.confidence)))) {
        notes.push('price/specs from a secondary source');
    }
    const score = Math.min(data, weather, model);
    return { level: score === 3 ? 'high' : score === 2 ? 'medium' : 'low', score, reasons, notes };
}

const cmpNum = (a, b, dir) => {
    const ma = !finite(a), mb = !finite(b);
    if (ma || mb) return ma === mb ? 0 : ma ? 1 : -1;
    return dir * (a - b);
};

/**
 * Sort rows in place by a SORTS key (missing values last; ties by NPV 10 yrs then name).
 * @param {object[]} rows @param {'npv10'|'payback'|'capex'|'sav'} key
 */
export function sortRows(rows, key) {
    const primary = {
        npv10: (a, b) => cmpNum(a.npv10, b.npv10, -1),
        payback: (a, b) => cmpNum(a.paybackSort === Infinity ? NaN : a.paybackSort, b.paybackSort === Infinity ? NaN : b.paybackSort, 1),
        capex: (a, b) => cmpNum(a.capex, b.capex, 1),
        sav: (a, b) => cmpNum(a.sav, b.sav, -1),
    }[key] || (() => 0);
    return rows.sort((a, b) => primary(a, b) || cmpNum(a.npv10, b.npv10, -1) || String(a.name).localeCompare(String(b.name)));
}

/**
 * Steps of an engine curve (panelCountCurve / batterySizeCurve points). Points that stack the same
 * thing ('No battery', 'as configured', '+k × …', 'k × W') form a chain and each step is measured
 * against the one before; other single options (a different pack) are measured against the system
 * as configured. Each step: { label, title, dCapex, dSav, years, need, role }, where role says where
 * the step sits against the system as it is: 'base' (no battery → the battery as configured),
 * 'smaller' (up to the configured size), 'bigger' (beyond it) or 'alt' (a different pack instead).
 * The configured point is the one labelled 'as configured', else the one costing capexNow.
 * @param {object[]} pts @param {number} maxPaybackYears @param {{ capexNow?: number }} [opts]
 */
export function curveSteps(pts, maxPaybackYears = 10, { capexNow = null } = {}) {
    const list = (pts || []).filter(p => finite(p.capexGbp) && finite(p.savingsGbp));
    const other = p => /^\+[\d.]+ kWh \(/.test(String(p.label || ''));
    const chain = list.filter(p => !other(p));
    const cfg = list.find(p => /as configured/.test(String(p.label || '')))
        ?? (finite(capexNow) ? chain.find(p => Math.abs(p.capexGbp - capexNow) < 0.01) : null) ?? chain[0] ?? null;
    const cfgAt = chain.indexOf(cfg);
    const step = (from, to, role) => {
        const dCapex = to.capexGbp - from.capexGbp;
        const dSav = to.savingsGbp - from.savingsGbp;
        return { from, to, label: to.label, title: `${from.label} → ${to.label}`, dCapex, dSav, role,
            years: dSav > EPS && dCapex > 0 ? dCapex / dSav : dCapex <= 0 && dSav >= 0 ? 0 : null, need: dCapex / maxPaybackYears };
    };
    const out = [];
    for (let i = 1; i < chain.length; i++) {
        const role = i > cfgAt ? 'bigger' : i === cfgAt && /^no battery/i.test(String(chain[i - 1].label || '')) ? 'base' : 'smaller';
        out.push(step(chain[i - 1], chain[i], role));
    }
    if (cfg) for (const p of list.filter(other)) out.push(step(cfg, p, 'alt'));
    return out;
}

/* ── the view ───────────────────────────────────────────────────────────────── */

export default {
    id: 'compare',
    title: 'Compare',

    mount(el, ctx) {
        this.el = el;
        this.ctx = ctx;
        this.token = 0;
        this.v = null;
        this.visible = true;
        this.dirty = false;
        this.jobs = new Set();
        this.products = null;
        injectStyle(ctx.ui.h);
        this.offs = [
            ctx.data.on('dataset', () => this.requestRender()),
            ctx.data.on('settings', () => this.requestRender()),
            ctx.data.on('status', () => this.onStatus()),
            ctx.data.on('scenarios', () => this.onScenarios()),
            ctx.data.on('verdict', v => this.onVerdict(v)),
        ];
        this.render();
    },

    show(params) {
        this.params = params || {};
        this.visible = true;
        if (this.dirty) { this.dirty = false; this.render(); }
    },

    hide() { this.visible = false; },

    unmount() {
        this.offs?.forEach(off => off());
        this.cancelJobs();
        this.teardown();
    },

    /* ── lifecycle helpers ──────────────────────────────────────────────── */

    requestRender() {
        if (!this.visible || this.el.hidden) { this.dirty = true; this.cancelJobs(); this.setStale(true); return; }
        this.render();
    },

    onStatus() {
        const st = this.ctx.data.status();
        if (st === 'loading') { this.setStale(true); this.setStatusLine('Loading your data…', null); return; }
        if (!this.ctx.data.summary() && this.el.querySelector('.connect-card')) return;
        if (st !== 'ready' || !this.v) this.requestRender();
    },

    cancelJobs() {
        for (const j of this.jobs) { try { j.cancel?.(); } catch { /* gone */ } }
        this.jobs.clear();
    },

    /**
     * Re-render a region without dropping keyboard focus (ui.keepFocus): a control the user just
     * pressed is usually rebuilt, so focus the rebuilt twin (same data-fk), else a fallback.
     */
    keepFocus(container, fn, fallback = null) {
        this.ctx.ui.keepFocus(container, fn, null, { fallback });
    },

    /** Track a direct engine call so a re-render or teardown can cancel it. */
    engineCall(method, ...args) {
        const job = this.ctx.engine.call(method, ...args);
        this.jobs.add(job);
        const done = () => this.jobs.delete(job);
        job.then(done, done);
        return job;
    },

    teardown() {
        if (!this.v) return;
        for (const c of Object.values(this.v.charts)) c?.destroy();
        clearTimeout(this.v.pickTimer);
        for (const c of Object.values(this.v.curve || {})) clearTimeout(c?.timer);
        this.v = null;
    },

    setStale(on) {
        if (!this.v) return;
        this.v.root.classList.toggle('is-stale', !!on);
        if (on) this.v.root.setAttribute('aria-busy', 'true'); else this.v.root.removeAttribute('aria-busy');
    },

    pref(key, dflt = null) {
        const v = this.ctx.store.get().ui?.chartTables?.[PREF + key];
        return v === undefined ? dflt : v;
    },
    setPref(key, value) {
        if (stableJson(this.pref(key)) === stableJson(value)) return;
        this.ctx.store.set({ ui: { chartTables: { [PREF + key]: value } } });
    },

    settings() {
        const s = this.ctx.store.get().settings || {};
        const f = { ...DEFAULT_FINANCE, ...(s.finance || {}) };
        return {
            maxPayback: finite(s.maxPaybackYears) && s.maxPaybackYears > 0 ? s.maxPaybackYears : 10,
            escalation: finite(f.escalation) ? f.escalation : DEFAULT_FINANCE.escalation,
            discount: finite(f.discountRate) ? f.discountRate : DEFAULT_FINANCE.discountRate,
            years: finite(f.years) ? Math.round(f.years) : DEFAULT_FINANCE.years,
            // 'Buy a new battery when it wears out' (Method / Design): off, a worn-out battery or
            // power station stops saving instead
            replaceBattery: f.replaceBattery === true,
            installDate: typeof s.finance?.installDate === 'string' ? s.finance.installDate : nextMonthIso(),
            vatReturns: s.vatReturns !== false,
            projectBaseW: finite(s.projectBaseW) ? s.projectBaseW : null,
            sig: stableJson({ f: s.finance, v: s.vatReturns, p: s.projectBaseW, m: s.maxPaybackYears, sp: s.spots }),
        };
    },

    /* ── render ─────────────────────────────────────────────────────────── */

    async render() {
        const { ui, data } = this.ctx;
        // The connect card shows its own progress and errors: leave it alone until data arrives.
        if (!data.summary() && this.el.querySelector('.connect-card')) return;
        const token = ++this.token;
        this.cancelJobs();
        const summary = data.summary();

        if (data.status() === 'loading') {
            if (this.v) this.setStale(true);
            else this.el.replaceChildren(this.skeleton(null));
            return;
        }
        if (!summary) {
            this.teardown();
            this.el.replaceChildren(ui.connectCard(this.ctx));
            return;
        }
        if (summary.engineUnavailable) {
            this.teardown();
            this.el.replaceChildren(this.engineCard(summary));
            this.restoreFocus();
            return;
        }

        const fresh = !this.v || this.v.dsId !== summary.id;
        if (fresh) {
            this.teardown();
            this.el.replaceChildren(this.skeleton(summary));
        } else {
            this.setStale(true);
            this.paintHead(summary);
            // the option list itself may be rebuilt first (a settings change clears it): say so at once
            this.setStatusLine('Updating every option for your settings…', null);
        }

        let auto;
        try {
            [auto] = await Promise.all([data.autoScenarios(), this.loadProducts()]);
        } catch (err) {
            if (err?.name === 'AbortError' || token !== this.token) return;
            this.teardown();
            this.el.replaceChildren(this.errorCard(err, true));
            this.restoreFocus();
            return;
        }
        if (token !== this.token || data.summary()?.id !== summary.id) return;

        // Building the rows can trip over a saved option this view can't draw (junk an older import
        // let into storage): then the error card replaces the view, never a half-built one.
        try {
            const entries = mergeSystems(auto, this.ctx.store.get().scenarios?.saved);
            if (fresh || !this.v) {
                this.teardown();
                this.build(summary);
            }
            const v = this.v;
            v.auto = auto;
            v.savedSig = stableJson(this.ctx.store.get().scenarios?.saved || []);
            const set = this.settings();
            const progressive = fresh || !v.rows?.length || v.settingsSig !== set.sig;
            const next = new Map();
            // Fresh: rows appear at once (cost known up front) and fill in as each run returns.
            if (fresh) {
                v.entries = entries;
                v.results = next;
                v.keys = new Map();
                this.rebuildRows();
                this.renderBoard();
            }
            this.setStatusLine(`Working out ${entries.length} options…`, 0);
            if (progressive) this.announce(`Working out ${entries.length} options…`);
            v.running = true;
            const ok = await this.runEntries(token, entries, next, {
                onEach: (done) => {
                    this.setStatusLine(`Working out option ${Math.min(done + 1, entries.length)} of ${entries.length}…`, done / entries.length);
                    if (fresh) { this.rebuildRows(); this.scheduleBoard(); }
                },
            });
            if (this.v === v) v.running = false;
            if (!ok || token !== this.token) return;
            v.entries = entries;
            v.results = next;
            v.keys = new Map(entries.map(e => [e.sys.id, stableJson(engineSystem(e.sys))]));
            v.settingsSig = set.sig;
            this.setStatusLine(null);
            if (!this.finalize(token, { announce: progressive })) return;
            if (v.pendingScenarios) { v.pendingScenarios = false; this.onScenarios(); }
        } catch (err) {
            if (err?.name === 'AbortError' || token !== this.token) return;
            this.fail(err);
        }
    },

    /**
     * A render step threw: put the error card (with Try again) where the half-built view was, stop
     * the runs still in flight from painting into it, and keep the keyboard in the view.
     */
    fail(err) {
        console.error('compare view failed', err);
        const hadFocus = typeof document !== 'undefined' && !!document.activeElement && document.activeElement !== document.body
            && this.el.contains(document.activeElement);
        this.token++;
        this.cancelJobs();
        this.teardown();
        this.el.replaceChildren(this.errorCard(err, true));
        if (hadFocus) this.focusAfter = 'error';
        this.restoreFocus();
    },

    /** Run a synchronous render step; on a throw, fail() and return false. */
    guarded(fn) {
        try {
            fn();
            return true;
        } catch (err) {
            this.fail(err);
            return false;
        }
    },

    /**
     * Run every entry through the hub (memoised; shares the engine cache with the verdict), POOL at
     * a time so a cancel isn't stuck behind 40 queued runs. Returns false when superseded.
     */
    async runEntries(token, entries, into, { onEach } = {}) {
        const queue = [...entries];
        let done = 0;
        let aborted = false;
        const errors = this.v.errors = this.v.errors || new Map();
        const worker = async () => {
            while (queue.length && !aborted) {
                if (token !== this.token) { aborted = true; return; }
                const e = queue.shift();
                try {
                    const res = await this.ctx.data.scenario(engineSystem(e.sys), {});
                    if (token !== this.token) { aborted = true; return; }
                    into.set(e.sys.id, res);
                    errors.delete(e.sys.id);
                } catch (err) {
                    if (err?.name === 'AbortError' || token !== this.token) { aborted = true; return; }
                    errors.set(e.sys.id, err);
                    console.warn(`compare: ${e.sys.id} failed:`, err?.message || err);
                }
                done += 1;
                onEach?.(done);
            }
        };
        await Promise.all(Array.from({ length: POOL }, worker));
        return !aborted && token === this.token;
    },

    /** Rebuild the row models from the current entries and results. */
    rebuildRows() {
        const v = this.v;
        const env = { products: this.products || new Map() };
        const summary = this.ctx.data.summary();
        const dataQ = { realPct: summary?.coverage?.realPct ?? 100, days: summary?.days ?? 365 };
        v.rows = v.entries.map(e => {
            const r = rowModel(e, v.results.get(e.sys.id) || null, env);
            r.failed = v.errors?.get(e.sys.id) || null;
            if (r.ready) r.conf = confidenceOf(r, dataQ);
            return r;
        });
        v.byId = new Map(v.rows.map(r => [r.id, r]));
    },

    /**
     * Everything that needs all results: dominance, badges, pins, side-by-side, ladder, curves.
     * Returns false when a step threw (the error card is up instead).
     */
    finalize(token, { announce = false } = {}) {
        const v = this.v;
        if (!v) return false;
        return this.guarded(() => {
            this.rebuildRows();
            v.final = true;
            this.renderBoard();
            this.setStale(false);
            this.renderPodium();
            this.renderLadder();
            this.renderSide();
            this.renderCurves();
            this.requestPick(token);
            if (announce) this.announce(`All ${v.rows.length} options worked out.`);
            this.restoreFocus();
        });
    },

    /* ── verdict pick ───────────────────────────────────────────────────── */

    /**
     * What the Verdict's pick depends on: the data, the settings and the user's own prices (which
     * the DataHub hands the Verdict). `base` leaves the prices out.
     * @returns {{ key: string, base: string }}
     */
    pickKey() {
        const base = `${this.ctx.data.summary()?.id}|${this.settings().sig}`;
        return { base, key: `${base}|${overrideSig(this.ctx.store.get().scenarios?.saved)}` };
    },

    /**
     * The "Best buy" is the Verdict's pick, so the two tabs never disagree. The verdict is asked for
     * once all rows are in (its scenario runs then hit the engine cache); if it isn't available
     * within a few seconds (or js/verdict.js fails) the critique's rule picks instead. When only
     * your prices changed, the same rule picks at once while the Verdict re-runs with them, so the
     * podium never blanks out.
     */
    requestPick(token) {
        const v = this.v;
        const { key, base } = this.pickKey();
        if (v.pick?.key === key && v.pick.source === 'verdict') { this.applyPick(); return; }
        if (v.pick && v.pick.source !== 'pending' && v.pick.base === base) {
            const p = pickBestBuy(v.rows, this.settings().maxPayback);
            v.pick = { key, base, id: p.best, most: p.most, source: 'rule' };
            this.applyPick();
        } else v.pick = { key, base, id: null, source: 'pending' };
        clearTimeout(v.pickTimer);
        v.pickTimer = setTimeout(() => {
            if (this.v !== v || v.pick.key !== key || v.pick.source !== 'pending') return;
            const p = pickBestBuy(v.rows, this.settings().maxPayback);
            v.pick = { key, base, id: p.best, most: p.most, source: 'rule' };
            this.applyPick();
        }, VERDICT_WAIT_MS);
        const take = (stage, verdict) => {
            if (this.v !== v || token !== this.token || v.pick.key !== key) return;
            if (!verdict || !('bestBuyId' in verdict)) return;
            if (stage && !['all', 'bands', 'answers'].includes(stage)) return;
            const id = verdict.bestBuyId == null ? null : String(verdict.bestBuyId);
            const most = verdict.stepUp?.id == null ? null : String(verdict.stepUp.id);
            if (v.pick.source === 'verdict' && v.pick.id === id && v.pick.most === most) return;
            const was = v.pick;
            v.pick = { key, base, id: id && v.byId.has(id) ? id : null, most: most && v.byId.has(most) ? most : null, source: 'verdict' };
            clearTimeout(v.pickTimer);
            // the rule already on screen agreed: nothing to redraw
            if (was.source === 'rule' && was.id === v.pick.id && was.most === v.pick.most) return;
            this.applyPick();
        };
        this.ctx.data.verdict({ onPartial: (stage, partial) => take(stage, partial) })
            .then(verdict => take(null, verdict))
            .catch(err => {
                if (this.v !== v || v.pick.key !== key || v.pick.source !== 'pending') return;
                if (err?.name === 'AbortError') return;
                clearTimeout(v.pickTimer);
                const p = pickBestBuy(v.rows, this.settings().maxPayback);
                v.pick = { key, base, id: p.best, most: p.most, source: 'rule' };
                this.applyPick();
            });
    },

    onVerdict(verdict) {
        const v = this.v;
        if (!v?.final || !verdict || !('bestBuyId' in verdict)) return;
        const { key, base } = this.pickKey();
        const id = verdict.bestBuyId == null ? null : String(verdict.bestBuyId);
        const most = verdict.stepUp?.id == null ? null : String(verdict.stepUp.id);
        if (v.pick?.source === 'verdict' && v.pick.key === key && v.pick.id === id && v.pick.most === most) return;
        clearTimeout(v.pickTimer);
        v.pick = { key, base, id: id && v.byId.has(id) ? id : null, most: most && v.byId.has(most) ? most : null, source: 'verdict' };
        this.applyPick();
    },

    applyPick() {
        if (!this.v?.final) return;
        this.guarded(() => {
            this.renderBoard();
            this.renderPodium();
            this.renderSide();
            this.renderCurves();
        });
    },

    /**
     * The pick on screen: the Verdict's (or the same rule run here), unless saved options of your own
     * change the answer — the Verdict ranks the ready-made options (at your prices), so then the
     * rule is run on the rows shown here and the badge says so ('yours').
     * @returns {{ id: string|null, most: string|null, source: 'verdict'|'rule'|'yours' }|null}
     */
    pickNow() {
        const v = this.v;
        const p = v?.pick;
        if (!p || p.source === 'pending') return null;
        if (!v.final || !hasOwnOptions(v.rows)) return p;
        const mine = pickBestBuy(v.rows, this.settings().maxPayback);
        if (mine.best === p.id) return mine.most === p.most ? p : { ...p, most: mine.most };
        return { key: p.key, id: mine.best, most: mine.most, source: 'yours' };
    },

    bestId() {
        return this.pickNow()?.id ?? null;
    },

    /* ── store events ───────────────────────────────────────────────────── */

    /** Pins changed (re-render the pin sections) or saved scenarios changed (re-run what changed). */
    async onScenarios() {
        const v = this.v;
        if (!v?.final || !v.auto) return;
        const saved = this.ctx.store.get().scenarios?.saved || [];
        const sig = stableJson(saved);
        if (sig === v.savedSig) { this.guarded(() => { this.renderBoard(); this.renderSide(); }); return; }
        if (v.running) { v.pendingScenarios = true; return; }
        if (!this.visible || this.el.hidden) { this.dirty = true; return; }
        v.savedSig = sig;
        const token = this.token;
        try {
            const entries = mergeSystems(v.auto, saved);
            const changed = entries.filter(e => v.keys.get(e.sys.id) !== stableJson(engineSystem(e.sys)));
            v.entries = entries;
            for (const e of changed) v.results.delete(e.sys.id);
            // drop results for rows that no longer exist
            const ids = new Set(entries.map(e => e.sys.id));
            for (const id of [...v.results.keys()]) if (!ids.has(id)) v.results.delete(id);
            this.rebuildRows();
            this.renderBoard();
            if (!changed.length) { this.finalize(token); return; }
            this.setStatusLine(`Re-working ${changed.length === 1 ? v.byId.get(changed[0].sys.id)?.name ?? changed[0].sys.id : `${changed.length} options`}…`, null);
            v.running = true;
            const ok = await this.runEntries(token, changed, v.results, { onEach: () => { this.rebuildRows(); this.scheduleBoard(); } });
            if (this.v === v) v.running = false;
            if (!ok || this.v !== v) return;
            for (const e of changed) v.keys.set(e.sys.id, stableJson(engineSystem(e.sys)));
            this.setStatusLine(null);
            if (!this.finalize(token)) return;
            if (changed.length === 1) this.flashRow(changed[0].sys.id);
            if (v.pendingScenarios) { v.pendingScenarios = false; this.onScenarios(); }
        } catch (err) {
            if (err?.name === 'AbortError' || token !== this.token || this.v !== v) return;
            this.fail(err);
        }
    },

    /* ── catalog (availability, pre-order, price dates) ─────────────────── */

    async loadProducts() {
        if (this.products) return this.products;
        try {
            const cat = await this.engineCall('catalog');
            const m = new Map();
            for (const p of [...(cat?.kits || []), ...(cat?.stations || []), ...(cat?.bundles || [])]) if (p?.id) m.set(p.id, p);
            this.products = m;
        } catch (err) {
            if (err?.name === 'AbortError') throw err;
            this.products = new Map();      // availability then comes from rule warnings only
        }
        return this.products;
    },

    /* ── skeleton, errors, head ─────────────────────────────────────────── */

    skeleton(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'cv', 'aria-busy': 'true' },
            this.head(summary),
            ui.card({ eyebrow: 'Every option', title: 'The leaderboard', body: h('div', null,
                h('div', { class: 'cv-podium' }, [0, 1, 2].map(() => h('div', { class: 'cv-pod' }, ui.skeleton({ lines: 2 })))),
                ui.skeleton({ lines: 6 })) }),
            ui.card({ eyebrow: 'Side by side', title: 'Your pinned options', body: ui.skeleton({ height: 260 }) }));
    },

    errorCard(err, retry) {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'cv' },
            this.head(this.ctx.data.summary()),
            ui.card({ body: h('div', { class: 'cv-error' },
                h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'),
                    h('span', null, `Couldn’t work out the options: ${err?.message || err}`)),
                h('div', { class: 'row' },
                    retry ? ui.button({ label: 'Try again', icon: 'refresh', onClick: () => { this.focusAfter = 'retry'; this.render(); } }) : null,
                    ui.button({ label: 'Check your data', kind: 'ghost', href: '#data', icon: 'arrowRight' }))) }));
    },

    /**
     * The data is loaded but the calculator didn't start (part of it, or the product list, didn't
     * download): say why in the engine's own words (summary.engineError), offer Try again, and
     * point at what works meanwhile. The hub also retries by itself; when the calculator starts it
     * fires 'dataset' and this view renders the options.
     */
    engineCard(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        const msg = h('span', null, `Options can’t be compared until the calculator starts. ${engineWhy(summary)}`);
        let retry = null;
        if (typeof this.ctx.data.retryEngine === 'function') {
            retry = ui.button({ label: 'Try again', icon: 'refresh', onClick: () => {
                if (retry.disabled) return;
                retry.disabled = true;
                retry.setAttribute('aria-busy', 'true');
                this.focusAfter = 'retry';      // on success the view is rebuilt: land on its title
                this.ctx.data.retryEngine().catch(err => {
                    if (!retry.isConnected) return;
                    this.focusAfter = null;
                    msg.textContent = `Still can’t compare the options. ${retryWhy(err)}`;
                    retry.disabled = false;
                    retry.removeAttribute('aria-busy');
                    retry.focus();
                });
            } });
        }
        return h('div', { class: 'cv' },
            this.head(null),
            ui.card({ body: h('div', { class: 'cv-error' },
                h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'), msg),
                h('p', { class: 'cv-lede', style: { margin: '0' } }, 'This page also tries again by itself for a couple of minutes, and the options appear as soon as it works. Your usage is on the Usage tab meanwhile.'),
                h('div', { class: 'row' },
                    retry,
                    ui.button({ label: 'See your usage', kind: 'ghost', href: '#usage', icon: 'arrowRight' }))) }));
    },

    head(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        const basis = h('p', { class: 'context-line cv-basis' });
        if (summary) this.fillBasis(basis, summary);
        const pdf = ui.button({ label: 'Save as PDF', icon: 'print', kind: 'ghost', onClick: () => this.print() });
        return h('div', { class: 'view-head' },
            h('div', null,
                h('div', { class: 'view-kicker' }, 'Compare'),
                h('h1', { class: 'view-title', tabindex: '-1' }, 'Every option, on the same footing'),
                basis),
            h('div', { class: 'cv-head-actions no-print' }, summary ? pdf : null));
    },

    fillBasis(el, summary) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const s = this.settings();
        const pct = v => fmt.pct(v * 100, { dp: Math.abs(v * 100 - Math.round(v * 100)) > 0.05 ? 1 : 0 });
        const y1 = firstYearLabel(s.installDate, fmt);
        const parts = [
            'All options: ', h('b', null, `your last ${fmt.num(Math.round(summary.days || 0))} days`), ', ',
            h('b', null, 'typical-year sunshine'), ', ',
            h('b', null, `${pct(s.escalation)} price rise/yr`), ', ',
            h('b', null, `${pct(s.discount)} discount rate`),
            h('span', { class: 'cv-basis-2' },
                y1 ? `£/yr is your first year (${y1})` : null,
                s.projectBaseW != null ? [y1 ? ' · ' : '', 'projected with ', h('b', null, `${fmt.num(s.projectBaseW)} W always-on`)] : null,
                s.vatReturns ? null : ' · VAT stays at 0%'),
        ];
        el.replaceChildren(...parts.flat().filter(x => x != null));
    },

    paintHead(summary) {
        const basis = this.v?.root.querySelector('.cv-basis');
        if (basis) this.fillBasis(basis, summary);
        if (this.v?.parts.print) this.fillPrint();
    },

    print() {
        try { window.print(); } catch { this.ctx.ui.toast('Your browser can’t print from here — use its own Print menu.', { tone: 'warn' }); }
    },

    restoreFocus() {
        const want = this.focusAfter;
        this.focusAfter = null;
        if (!want || this.el.hidden || typeof document === 'undefined') return;
        const a = document.activeElement;
        if (a && a !== document.body && a.isConnected && !a.closest?.('.toasts')) return;
        (this.el.querySelector('.cv-error .btn') || this.el.querySelector('.view-title'))?.focus();
    },

    announce(text) {
        const live = this.v?.parts.live;
        if (!live) return;
        live.textContent = '';
        setTimeout(() => { if (this.v?.parts.live === live) live.textContent = text; }, 40);
    },

    setStatusLine(text, frac) {
        const p = this.v?.parts;
        if (!p) return;
        if (!text) { p.status.hidden = true; return; }
        p.status.hidden = false;
        p.statusText.textContent = text;
        p.bar.hidden = frac == null;
        if (frac != null) p.bar.firstChild.style.width = `${Math.round(Math.max(0.03, Math.min(1, frac)) * 100)}%`;
    },

    /* ── build once per dataset ─────────────────────────────────────────── */

    build(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = {};
        p.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
        p.bar = h('span', { class: 'cv-bar', 'aria-hidden': 'true' }, h('i'));
        p.statusText = h('span');
        // visual progress only: screen readers get one message at the start and one at the end (p.live)
        p.status = h('div', { class: 'cv-status', 'aria-hidden': 'true' }, p.bar, p.statusText);
        p.podium = h('div', { class: 'cv-podium' });
        p.controls = h('div', { class: 'cv-controls' });
        p.count = h('p', { class: 'cv-count' });
        p.board = h('div', { class: 'tbl-wrap' });
        p.how = h('div', { class: 'cv-how' });
        p.side = h('div');
        p.sideActions = h('div', { class: 'card-actions' });
        p.ladder = h('div');
        p.base = h('div');
        p.baseSub = h('span');
        p.baseFacts = h('ul', { class: 'cv-facts' });
        p.panels = h('div');
        p.battery = h('div');
        // chart hosts live across re-renders so charts update in place (hover, table toggle kept)
        p.cashHost = h('div', { class: 'cv-chart-gap' });
        p.panelsChart = h('div', { class: 'cv-untitled' });
        p.batteryChart = h('div', { class: 'cv-untitled' });
        p.print = h('div', { class: 'cv-print-only' });

        // the progress pill sits outside the dimmed wrapper (and sticks under the tabs) so it stays
        // readable while old figures are held at half strength
        const root = h('div', { class: 'cv' },
            this.head(summary),
            p.live,
            p.status,
            h('div', { class: 'cv-stale-wrap stack' },
                ui.card({
                    eyebrow: 'Every option',
                    title: 'The leaderboard',
                    subtitle: 'Each option on its best spot, same data and money rules for all. Click a name to open it in Design; pin up to four to compare side by side.',
                    body: h('div', null, p.podium, p.controls, p.count, p.board, p.how),
                }),
                ui.card({ eyebrow: 'Side by side', title: 'Your pinned options', actions: p.sideActions, body: p.side }),
                h('div', { class: 'grid-2' },
                    ui.card({ eyebrow: 'Is it worth paying more?', title: 'Step by step up the price list', body: p.ladder }),
                    ui.card({ eyebrow: 'Always-on load', title: 'How much your always-on load matters', subtitle: p.baseSub, body: h('div', null, h('div', { class: 'cv-untitled' }, p.base), p.baseFacts) })),
                h('div', { class: 'grid-2' },
                    ui.card({ eyebrow: 'Bigger or smaller', title: 'More panels?', body: p.panels }),
                    ui.card({ eyebrow: 'Bigger or smaller', title: 'A bigger battery?', body: p.battery })),
                p.print));
        this.el.replaceChildren(root);
        this.v = { dsId: summary.id, root, parts: p, charts: {}, rows: [], entries: [], results: new Map(), keys: new Map(), errors: new Map(),
            final: false, pick: null, curve: {}, base: null };
        this.renderControls();
        this.renderLegend();
        this.fillPrint();
    },

    /* ── leaderboard ────────────────────────────────────────────────────── */

    sortKey() {
        const k = this.pref('sort', 'npv10');
        return SORTS[k] ? k : 'npv10';
    },
    routeFilter() {
        const f = this.pref('routes', []);
        return new Set(Array.isArray(f) ? f.filter(r => FILTER_ROUTES.includes(r)) : []);
    },

    renderControls() {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const sort = this.sortKey();
        const seg = ui.segmented({
            ariaLabel: 'Sort options by', size: 'sm', value: sort,
            options: Object.entries(SORTS).map(([value, s]) => ({ value, label: h('span', null, h('span', { class: 'cv-lg' }, s.label), h('span', { class: 'cv-sm' }, s.short)) })),
            onChange: val => { this.setPref('sort', val); this.renderBoard(); },
        });
        const routes = this.routeFilter();
        const chips = FILTER_ROUTES.map(r => filterChip(h, {
            label: ROUTE[r].chip, pressed: routes.has(r), dot: r,
            onClick: () => {
                const cur = this.routeFilter();
                if (cur.has(r)) cur.delete(r); else cur.add(r);
                this.setPref('routes', [...cur]);
                this.renderControls();
                this.afterFilter();
            },
        }));
        chips.push(filterChip(h, {
            label: 'Only on sale now', pressed: !!this.pref('onSale', false),
            onClick: () => { this.setPref('onSale', !this.pref('onSale', false)); this.renderControls(); this.afterFilter(); },
        }));
        this.keepFocus(p.controls, () => p.controls.replaceChildren(
            h('div', { class: 'cv-control' }, h('span', { class: 'cv-control-label', id: 'cv-sort-l' }, 'Sort by'), seg),
            h('div', { class: 'cv-control' }, h('span', { class: 'cv-control-label', id: 'cv-filter-l' }, 'Show'),
                h('div', { class: 'cv-chips', role: 'group', 'aria-labelledby': 'cv-filter-l' }, chips))));
        seg.setAttribute('aria-labelledby', 'cv-sort-l');
        seg.removeAttribute('aria-label');
    },

    afterFilter() {
        this.renderBoard();
        if (this.v?.final) this.renderLadder();
    },

    renderLegend() {
        const { ui } = this.ctx;
        const h = ui.h;
        this.v.parts.how.replaceChildren(
            h('span', null, h('span', { class: 'cv-strip', style: { '--rc': 'var(--muted)', width: '42px' }, 'aria-hidden': 'true' },
                h('i', { class: 'cv-strip-band', style: { left: '15%', width: '70%' } }), h('i', { class: 'cv-strip-dot', style: { left: '55%' } })),
            'Saves a year in a typical year (dot) and across 2006–2025 weather (bar)'),
            h('span', null, h('span', { class: 'cv-conf-m l2', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'How sure: the weakest of data, weather and model'),
            h('span', null, 'Greyed: another option costs no more and saves more'));
    },

    scheduleBoard() {
        if (this.boardRaf) return;
        this.boardRaf = requestAnimationFrame(() => { this.boardRaf = 0; if (this.v) this.guarded(() => this.renderBoard()); });
    },

    /** Rows passing the filters (yardsticks always show). */
    visibleRows() {
        const routes = this.routeFilter();
        const onSale = !!this.pref('onSale', false);
        return this.v.rows.filter(r => {
            if (r.legal === 'reference' || r.route === 'reference') return true;
            const route = r.legal === 'whatif' ? 'whatif' : r.route;
            if (routes.size && !routes.has(route)) return false;
            if (onSale && !r.onSale) return false;
            return true;
        });
    },

    renderBoard() {
        const v = this.v;
        if (!v) return;
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const sort = this.sortKey();
        const rows = this.visibleRows();
        if (v.final) markDominance(rows);
        else for (const r of rows) { r.dominatedBy = null; r.dominatedHow = null; }
        const pins = this.pins();
        const set = this.settings();
        const badges = this.badges();

        // shared scale for the weather strips
        let lo = 0, hi = 0;
        for (const r of rows) {
            if (!r.ready) continue;
            for (const x of [r.p10, r.p90, r.sav]) if (finite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
        }
        const scale = niceMax(lo, hi);

        const cols = [
            { key: 'name', label: 'Option', cls: 'c-name', mobile: 'title' },
            { key: 'capex', label: 'Cost', cls: 'c-capex', align: 'right', sort: 'capex', mobile: 'show' },
            { key: 'sav', label: 'Saves a year', cls: 'c-sav', align: 'right', sort: 'sav', mobile: 'primary', scale: true },
            { key: 'payback', label: 'Payback', cls: 'c-payback', align: 'right', sort: 'payback', mobile: 'show' },
            { key: 'npv10', label: '10-yr value', cls: 'c-npv10', align: 'right', sort: 'npv10', mobile: sort === 'npv10' ? 'show' : 'hide',
                help: `What you’re ahead after 10 years in today’s money (later savings count ${fmt.pct(set.discount * 100, { dp: 0 })} a year less) — the Verdict’s ranking` },
            { key: 'npv20', label: `${set.years}-yr value`, cls: 'c-npv20', align: 'right', mobile: 'hide',
                help: `The same over ${set.years} years${npvLongHelp(set)}` },
            { key: 'conf', label: 'How sure', cls: 'c-conf', mobile: 'hide' },
            { key: 'sale', label: 'On sale', cls: 'c-sale', mobile: 'hide' },
            { key: 'pin', label: 'Compare', cls: 'c-pin cv-actions-h', align: 'right', mobile: 'actions' },
        ];

        const thead = h('thead', null, h('tr', null, cols.map(c => {
            const active = c.sort === sort;
            const label = c.sort ? h('button', {
                type: 'button', class: 'th-sort', title: `Sort by ${SORTS[c.sort].label.toLowerCase()}`, dataset: { fk: `sort:${c.sort}` },
                on: { click: () => { this.setPref('sort', c.sort); this.renderControls(); this.renderBoard(); } },
            }, c.label, h('span', { class: 'th-arrow', 'aria-hidden': 'true' }, active ? (['capex', 'payback'].includes(c.sort) ? '▲' : '▼') : '')) : c.label;
            return h('th', {
                scope: 'col', class: [`al-${c.align || 'left'}`, c.cls],
                'aria-sort': c.sort ? (active ? (['capex', 'payback'].includes(c.sort) ? 'ascending' : 'descending') : 'none') : null,
                title: c.help || null,
            }, label, c.scale && v.final ? h('span', { class: 'cv-scale', 'aria-hidden': 'true' },
                h('span', null, fmt.gbp(scale.min, { compact: true })), h('span', null, fmt.gbp(scale.max, { compact: true }))) : null);
        })));

        const body = h('tbody');
        const rowEl = r => this.boardRow(r, cols, { pins, scale, badges, sort });
        if (!v.final) {
            for (const r of rows) body.appendChild(rowEl(r));
        } else {
            const main = rows.filter(isMain);
            const ahead = sortRows(main.filter(r => !r.dominatedBy), sort);
            const beaten = sortRows(main.filter(r => r.dominatedBy), sort);
            const whatif = sortRows(rows.filter(r => r.legal === 'whatif'), sort);
            const refs = rows.filter(r => r.legal === 'reference');
            for (const r of ahead) body.appendChild(rowEl(r));
            if (beaten.length) {
                // collapsed by default: there are usually more beaten options than worthwhile ones
                const show = !!this.pref('showBeaten', false);
                const btn = h('button', {
                    type: 'button', class: 'cv-link-btn', 'aria-expanded': String(!!show), dataset: { fk: 'beaten' },
                    on: { click: () => { this.setPref('showBeaten', !show); this.renderBoard(); } },
                }, ui.icon('chevron'), show ? `Hide the ${beaten.length} options beaten on both price and savings`
                    : `Show ${beaten.length} options beaten on both price and savings`);
                body.appendChild(h('tr', { class: 'cv-toggle' }, h('td', { colspan: cols.length }, btn)));
                for (const r of beaten) {
                    const tr = rowEl(r);
                    if (!show) tr.classList.add('is-hidden');
                    body.appendChild(tr);
                }
            }
            if (whatif.length) {
                body.appendChild(h('tr', { class: 'cv-group' }, h('th', { colspan: cols.length, scope: 'colgroup' }, 'Not legal yet — for planning',
                    h('span', null, 'Plug-in batteries (hoped for 2027) or more than one plug-in kit per home. Never the best buy.'))));
                for (const r of whatif) body.appendChild(rowEl(r));
            }
            if (refs.length) {
                body.appendChild(h('tr', { class: 'cv-group' }, h('th', { colspan: cols.length, scope: 'colgroup' }, 'Yardsticks',
                    h('span', null, 'Nothing to buy: what doing nothing, or switching off 100 W of servers for good, is worth.'))));
                for (const r of refs) body.appendChild(rowEl(r));
            }
        }
        const table = h('table', { class: 'tbl cv-board' },
            h('caption', { class: 'sr-only' }, `Every option, sorted by ${SORTS[sort].label.toLowerCase()}`), thead, body);
        this.keepFocus(v.parts.board, () => v.parts.board.replaceChildren(table));

        // count line
        const total = v.rows.length;
        const shown = rows.length;
        const beatenN = rows.filter(r => r.dominatedBy).length;
        const pending = v.rows.filter(r => !r.ready && !r.failed).length;
        ui.put(v.parts.count,
            h('b', null, shown === total ? `${total} options` : `${shown} of ${total} options`),
            pending && !v.final ? ` · ${pending} still working out` : '',
            v.final && beatenN ? ` · ${beatenN} beaten on both price and savings` : '',
            v.final && this.routeFilter().size + (this.pref('onSale', false) ? 1 : 0) ? ' · filtered' : '');
    },

    badges() {
        const v = this.v;
        const out = new Map();
        if (!v?.final) return out;
        const add = (id, b) => { if (!id) return; if (!out.has(id)) out.set(id, []); out.get(id).push(b); };
        const pick = this.pickNow();
        const max = this.settings().maxPayback;
        add(pick?.id, { text: 'Best buy', tone: 'accent',
            title: pick?.source === 'verdict' ? 'The Verdict tab’s pick' : pick?.source === 'yours' ? `Your saved options included. ${BEST_BUY_RULE(max)}. The Verdict tab ranks the ready-made options only.` : BEST_BUY_RULE(max) });
        if (pick?.most) add(pick.most, { text: 'Most over 10 yrs', tone: 'info', title: 'The highest 10-yr value of everything legal that pays back in time — but it costs more than the best buy' });
        const { fastest, cheapest } = quickest(eligible(v.rows, max));
        if (fastest) add(fastest.id, { text: 'Fastest payback', tone: 'good' });
        if (cheapest) add(cheapest.id, { text: 'Lowest outlay', tone: 'default' });
        return out;
    },

    boardRow(r, cols, { pins, scale, badges }) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const pinIdx = pins.indexOf(r.id);
        const tr = h('tr', {
            class: ['cv-row', r.dominatedBy && 'is-beaten', pinIdx >= 0 && 'is-pinned'],
            dataset: { id: r.id },
            style: pinIdx >= 0 ? { '--pc': `var(${PIN_VARS[pinIdx]})` } : null,
        });
        const rc = routeColor(r);
        const cell = (c, content, extra = {}) => h(c.key === 'name' ? 'th' : 'td', {
            class: [`al-${c.align || 'left'}`, c.cls, c.mobile === 'actions' ? 'cv-actions-cell' : `m-${c.mobile}`],
            scope: c.key === 'name' ? 'row' : null, dataset: { label: c.label }, ...extra,
        }, content);
        const pend = () => h('span', { class: 'shimmer cv-fig-pending', 'aria-label': 'working out' });
        const failed = r.failed ? h('span', { class: 'cv-never', title: r.failed?.message || '' }, 'failed') : null;

        for (const c of cols) {
            let content = null;
            switch (c.key) {
                case 'name': {
                    const meta = h('div', { class: 'cv-meta' },
                        ui.badge({ text: routeLabel(r), tone: badgeTone(r) }),
                        (badges.get(r.id) || []).map(b => ui.badge(b)),
                        r.kind === 'price' ? ui.badge({ text: 'Your price', tone: 'info' }) : null,
                        r.kind === 'edited' ? ui.badge({ text: 'Edited', tone: 'info' }) : null,
                        r.kind === 'saved' ? ui.badge({ text: 'Saved', tone: 'info' }) : null,
                        r.legal === 'check' ? ui.badge({ text: 'Check first', tone: 'warn', title: (r.warnings.find(w => /UPS_WITH_PLUGIN/.test(w.code)) || r.warnings[0])?.message }) : null,
                        r.preorder ? ui.badge({ text: 'Pre-order', tone: 'warn' }) : !r.onSale && r.legal !== 'reference' ? ui.badge({ text: 'Not on sale now', tone: 'warn' }) : null);
                    const by = r.dominatedBy ? this.v.byId.get(r.dominatedBy) : null;
                    const life = r.ready ? wearsOut(r) : null;
                    content = h('div', { class: 'cv-name' },
                        r.legal === 'reference' ? h('span', { class: 'cv-name-link' }, r.name)
                            : h('a', { class: 'cv-name-link', href: `#design?scenario=${encodeURIComponent(r.id)}` }, r.name),
                        meta,
                        // a battery or power station that wears out inside the 10 years says so (as on
                        // the Verdict): it is why a quick payback can still leave a small 10-yr value
                        life ? h('span', { class: 'cv-life', title: life.title }, life.text) : null,
                        by ? h('span', { class: 'cv-beaten' }, 'Beaten by ', h('b', null, by.name), `: ${r.dominatedHow === 'both' ? 'cheaper and saves more' : r.dominatedHow === 'cheaper' ? 'cheaper, saves the same' : 'same price, saves more'}`) : null);
                    break;
                }
                case 'capex':
                    content = h('span', { class: 'cv-cost' }, h('span', null, fmt.gbp(r.capex),
                        r.laterGbp > 0.5 ? h('span', { class: 'cv-later' }, `+${fmt.gbp(r.laterGbp)} in yr ${r.laterYear ?? '?'}`) : null),
                        r.legal === 'reference' ? null : h('button', {
                            type: 'button', class: 'cv-edit cv-edit-d no-print', 'aria-label': `Change the price of ${r.name}`, title: 'Use your own price', dataset: { fk: `edit:${r.id}` },
                            on: { click: () => this.openPriceEditor(r.id) },
                        }, ui.icon('pencil')));
                    break;
                case 'sav':
                    content = r.ready ? h('span', { class: 'cv-sav' },
                        h('span', { class: ['cv-sav-fig', r.sav < 0 && 'cv-neg'] }, fmt.gbp(r.sav)),
                        rangeStrip(h, { lo: r.p10, hi: r.p90, mid: r.sav, scale, color: rc, ring: r.legal === 'whatif' }),
                        h('span', { class: 'sr-only' }, finite(r.p10) && finite(r.p90) && Math.abs(r.p90 - r.p10) > 0.5 ? `, ${fmt.gbp(r.p10)} to ${fmt.gbp(r.p90)} depending on the weather` : ''))
                        : failed || pend();
                    break;
                case 'payback':
                    // nothing to pay back: yardsticks, or a saved option with no costs entered
                    content = !r.ready ? failed || pend() : r.legal === 'reference' || r.capex <= EPS ? '—'
                        : finite(r.payback) ? fmt.years(r.payback) : h('span', { class: 'cv-never' }, 'never');
                    break;
                case 'npv10':
                    content = !r.ready ? failed || pend() : h('span', { class: r.npv10 < 0 ? 'cv-neg' : null }, fmt.gbp(r.npv10));
                    break;
                case 'npv20':
                    content = !r.ready ? failed || pend() : h('span', { class: r.npv20 < 0 ? 'cv-neg' : null }, fmt.gbp(r.npv20));
                    break;
                case 'conf':
                    content = !r.ready ? failed || pend() : r.legal === 'reference' ? '—' : confMeter(h, this.confOf(r));
                    break;
                case 'sale':
                    content = r.legal === 'reference' ? '—' : r.preorder ? h('span', { class: 'cv-sale-no' }, 'Pre-order')
                        : r.onSale ? 'Yes' : h('span', { class: 'cv-sale-no' }, 'Not now');
                    break;
                case 'pin':
                    content = r.legal === 'reference' ? null : [
                        h('button', { type: 'button', class: 'cv-pin cv-edit-m', 'aria-label': `Change the price of ${r.name}`, dataset: { fk: `editm:${r.id}` }, on: { click: () => this.openPriceEditor(r.id) } },
                            ui.icon('pencil'), 'Price'),
                        this.pinButton(r, pinIdx, pins.length)];
                    break;
                default:
            }
            tr.appendChild(cell(c, content));
        }
        return tr;
    },

    confOf(r) {
        return r.conf || { level: 'medium', score: 2, reasons: [], notes: [] };
    },

    pinButton(r, idx, count) {
        const h = this.ctx.ui.h;
        const on = idx >= 0;
        const full = !on && count >= MAX_PINS;
        return h('button', {
            type: 'button', class: 'cv-pin', 'aria-pressed': String(on), dataset: { fk: `pin:${r.id}` },
            style: on ? { '--pc': `var(${PIN_VARS[idx]})` } : null,
            'aria-label': on ? `Unpin ${r.name} (column ${LETTERS[idx]})` : `Pin ${r.name} to compare side by side`,
            title: full ? `You can compare up to ${MAX_PINS} — unpin one first` : null,
            on: { click: () => this.togglePin(r.id) },
        }, on ? [h('span', { class: 'cv-letter', 'aria-hidden': 'true' }, LETTERS[idx]), 'Pinned'] : [h('span', { class: 'cv-pin-plus', 'aria-hidden': 'true' }, '+'), 'Pin']);
    },

    /* ── pins ───────────────────────────────────────────────────────────── */

    /**
     * The pinned ids on screen. Once the user has pinned or unpinned here, exactly their list.
     * Until then the suggested pins, after anything pinned from another tab (Design's "Pin to
     * Compare" adds to the stored list): one pin from Design shouldn't wipe the suggestions.
     */
    pins() {
        const v = this.v;
        if (!v) return [];
        const stored = this.ctx.store.get().scenarios?.pinned;
        const ids = [...new Set((Array.isArray(stored) ? stored : []).filter(id => v.byId?.has(id) && v.byId.get(id).legal !== 'reference'))];
        if (this.pref('pinsCustom', false)) return ids.slice(0, MAX_PINS);
        if (!v.final || v.pick?.source === 'pending' || !v.pick) return ids.slice(0, MAX_PINS);
        return [...new Set([...ids, ...defaultPins(v.rows, this.bestId())])].slice(0, MAX_PINS);
    },

    pinsPending() {
        const v = this.v;
        const stored = this.ctx.store.get().scenarios?.pinned;
        const has = Array.isArray(stored) && stored.some(id => v?.byId?.has(id));
        return !has && !this.pref('pinsCustom', false) && (!v?.final || !v.pick || v.pick.source === 'pending');
    },

    setPins(ids) {
        this.setPref('pinsCustom', true);
        this.ctx.store.set({ scenarios: { pinned: [...new Set(ids)].slice(0, MAX_PINS) } });
    },

    togglePin(id) {
        const cur = this.pins();
        const row = this.v?.byId.get(id);
        if (cur.includes(id)) { this.setPins(cur.filter(x => x !== id)); this.announce(`${row?.name || id} unpinned.`); return; }
        if (cur.length >= MAX_PINS) {
            this.ctx.ui.toast(`You can compare up to ${MAX_PINS} options — unpin one first.`, { tone: 'warn' });
            return;
        }
        this.setPins([...cur, id]);
        this.announce(`${row?.name || id} pinned as ${LETTERS[cur.length]}.`);
    },

    /* ── podium ─────────────────────────────────────────────────────────── */

    renderPodium() {
        const v = this.v;
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        if (!v?.final) return;
        const max = this.settings().maxPayback;
        const el = eligible(v.rows, max).filter(r => r.capex > 0);
        const pick = this.pickNow();
        const best = pick?.id ? v.byId.get(pick.id) : null;
        const most = pick?.most ? v.byId.get(pick.most) : null;
        const { fastest, cheapest } = quickest(el);
        const pod = (label, r, fig, lead) => h('div', { class: ['cv-pod', lead && 'is-lead'] },
            h('div', { class: 'cv-pod-label' }, label),
            r ? h('a', { class: 'cv-pod-name', href: `#design?scenario=${encodeURIComponent(r.id)}` }, r.name) : h('span', { class: 'cv-pod-name' }, '—'),
            h('div', { class: 'cv-pod-fig' }, r ? fig(r) : ''));
        if (v.pick?.source === 'pending' && !best) {
            v.parts.podium.style.setProperty('--n', '3');
            v.parts.podium.replaceChildren(...[0, 1, 2].map(() => h('div', { class: 'cv-pod' }, ui.skeleton({ lines: 2 }))));
            return;
        }
        if (!el.length && !best) {
            v.parts.podium.replaceChildren(h('div', { class: 'notice notice-warn', style: { gridColumn: '1 / -1' } }, ui.icon('alert'),
                h('span', null, `Nothing legal and on sale pays back within ${max} years on your data. The yardsticks at the bottom show what cutting always-on load is worth instead.`)));
            return;
        }
        const pods = [
            pod('Best buy', best, r => [h('b', null, `${fmt.gbp(r.sav)}/yr`), `back in ${fmt.years(r.payback)}`], true),
            most ? pod('Most over 10 yrs', most, r => [h('b', null, `${fmt.gbp(r.sav)}/yr`), `10-yr value ${fmt.gbp(r.npv10)} · costs ${fmt.gbp(r.capex)}`]) : null,
            pod('Fastest payback', fastest, r => [h('b', null, fmt.years(r.payback)), `for ${fmt.gbp(r.capex)}`]),
            pod('Lowest outlay', cheapest, r => [h('b', null, fmt.gbp(r.capex)), `saves ${fmt.gbp(r.sav)}/yr`]),
        ].filter(Boolean);
        if (pick?.source === 'yours') {
            pods.push(h('p', { class: 'cv-pod-note' }, ui.icon('info'),
                h('span', null, 'Best buy with your saved options included. The Verdict tab ranks only the ready-made options (at your prices), so it may pick differently.')));
        }
        v.parts.podium.style.setProperty('--n', String(pods.length - (pick?.source === 'yours' ? 1 : 0)));
        v.parts.podium.replaceChildren(...pods);
    },

    /* ── side by side ───────────────────────────────────────────────────── */

    renderSide() {
        const v = this.v;
        if (!v) return;
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const p = v.parts;
        const pins = this.pins();
        const rows = pins.map(id => v.byId.get(id)).filter(Boolean);

        // actions: add an option, back to the suggested pins
        const options = v.rows.filter(r => r.legal !== 'reference' && !pins.includes(r.id) && r.ready)
            .map(r => ({ value: r.id, label: r.name, group: r.legal === 'whatif' ? 'Future rules' : ROUTE[r.route]?.label || 'Other' }));
        // choose, then Pin: a closed <select> fires 'change' on every arrow key, so pinning on change
        // would pin whatever a keyboard user scrolls past
        let addBtn = null;
        const add = pins.length < MAX_PINS && options.length && v.final ? ui.select({
            ariaLabel: 'Option to add to the comparison',
            options: [{ value: '', label: pins.length ? 'Add an option…' : 'Pick an option…' }, ...options],
            value: '', onChange: id => { if (addBtn) addBtn.disabled = !id; },
        }) : null;
        if (add) {
            add.dataset.fk = 'add';
            add.addEventListener('keydown', e => { if (e.key === 'Enter' && add.value) { e.preventDefault(); addBtn?.click(); } });
            addBtn = ui.button({ label: 'Pin', size: 'sm', disabled: true, ariaLabel: 'Pin the chosen option', onClick: () => {
                const id = add.value;
                if (!id) return;
                this.setPins([...this.pins(), id]);
                this.announce(`${v.byId.get(id)?.name || id} pinned as ${LETTERS[Math.min(MAX_PINS, this.pins().length) - 1] ?? ''}.`);
            } });
            addBtn.dataset.fk = 'addbtn';
        }
        const custom = this.pref('pinsCustom', false);
        this.keepFocus(p.sideActions, () => ui.put(p.sideActions,
            add ? h('div', { class: 'cv-add no-print' }, add, addBtn) : null,
            custom && v.final && v.pick?.source !== 'pending' ? ui.button({
                label: 'Suggested', kind: 'ghost', size: 'sm', title: 'Pin the suggested options: best buy, west wall, best battery, best power station',
                onClick: () => {
                    this.setPref('pinsCustom', false);
                    this.ctx.store.set({ scenarios: { pinned: [] } });
                    // this button goes away with the custom pins: keep the keyboard in the card
                    requestAnimationFrame(() => [...p.side.querySelectorAll('.cv-x'), ...p.sideActions.querySelectorAll('select')].find(b => b.offsetParent !== null)?.focus());
                    this.announce('Back to the suggested options.');
                },
            }) : null), () => p.sideActions.querySelector('select, button'));

        if (this.pinsPending()) {
            p.side.replaceChildren(h('p', { class: 'cv-lede' }, 'Picking the suggested options to compare…'), ui.skeleton({ height: 240 }));
            return;
        }
        if (!rows.length) {
            v.charts.cash?.destroy(); delete v.charts.cash;
            p.side.replaceChildren(ui.emptyState({
                title: 'Nothing pinned yet',
                body: 'Pin two to four options in the leaderboard (or add one above) to see them side by side — cost, savings, payback, energy and how each is installed.',
            }));
            this.renderBase();
            return;
        }

        const metrics = this.sideMetrics();
        const two = rows.length === 2;
        const pinIdx = id => pins.indexOf(id);
        const head = h('tr', null, h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Measure')),
            rows.map(r => h('th', { scope: 'col', style: { '--pc': `var(${PIN_VARS[pinIdx(r.id)]})` } }, h('div', { class: 'cv-ph' },
                pinLetter(h, pinIdx(r.id)),
                h('div', { class: 'cv-ph-text' },
                    h('a', { href: `#design?scenario=${encodeURIComponent(r.id)}` }, r.name),
                    h('span', null, ui.badge({ text: routeLabel(r), tone: badgeTone(r) }))),
                h('button', { type: 'button', class: 'cv-x no-print', 'aria-label': `Remove ${r.name} from the comparison`, dataset: { fk: `x:${r.id}` }, on: { click: () => this.togglePin(r.id) } }, ui.icon('x'))))),
            two ? h('th', { scope: 'col', class: 'cv-diff' }, `${LETTERS[pinIdx(rows[1].id)]} − ${LETTERS[pinIdx(rows[0].id)]}`) : null);

        const body = h('tbody');
        for (const m of metrics) {
            const vals = rows.map(r => (r.ready ? m.value(r) : undefined));
            let bestIx = [];
            if (m.better && rows.length > 1) {
                const nums = vals.map(x => (finite(x) ? x : null));
                const cand = nums.filter(x => x != null);
                if (cand.length > 1) {
                    const target = m.better === 'high' ? Math.max(...cand) : Math.min(...cand);
                    const spread = Math.max(...cand) - Math.min(...cand);
                    if (spread > (m.tie ?? 0.5)) bestIx = nums.map((x, i) => (x != null && Math.abs(x - target) <= (m.tie ?? 0.5) / 2 ? i : -1)).filter(i => i >= 0);
                }
            }
            const tr = h('tr', null, h('th', { scope: 'row' }, m.label, m.help ? h('span', { class: 'cv-sbs-help' }, m.help) : null));
            rows.forEach((r, i) => {
                const key = h('span', { class: 'cv-sbs-k', 'aria-hidden': 'true', style: { '--pc': `var(${PIN_VARS[pinIdx(r.id)]})` } }, pinLetter(h, pinIdx(r.id)), h('span', null, r.name));
                const content = !r.ready ? h('span', { class: 'shimmer cv-fig-pending' }) : m.render(r);
                const best = bestIx.includes(i);
                tr.appendChild(h('td', { class: [m.text && 'is-text', best && 'is-best'] },
                    key, h('div', { class: 'cv-cell' }, h('span', { class: 'cv-val' }, content), best ? h('span', { class: 'sr-only' }, ' (best)') : null,
                        m.sub && r.ready ? m.sub(r) : null)));
            });
            if (two) {
                const [a, b] = rows;
                const d = m.diff && a.ready && b.ready ? m.diff(b, a) : null;
                tr.appendChild(h('td', { class: ['cv-diff', m.text && 'is-text'] },
                    h('span', { class: 'cv-sbs-k', 'aria-hidden': 'true' }, h('span', null, `${LETTERS[pinIdx(b.id)]} − ${LETTERS[pinIdx(a.id)]}`)),
                    h('div', { class: 'cv-cell' }, d ?? '')));
            }
            body.appendChild(tr);
        }
        const table = h('table', { class: 'cv-sbs' }, h('caption', { class: 'sr-only' }, 'Pinned options side by side'), h('thead', null, head), body);
        // phones only (display:none above 600 px, where the table head carries the same controls,
        // which are in turn hidden on phones) — so exactly one set is ever reachable
        const pinlist = h('ul', { class: 'cv-pinlist', 'aria-label': 'Pinned options' }, rows.map(r => h('li', { class: 'cv-pinlist-item', style: { '--pc': `var(${PIN_VARS[pinIdx(r.id)]})` } },
            pinLetter(h, pinIdx(r.id)), h('span', { class: 'sr-only' }, `${LETTERS[pinIdx(r.id)]}: `),
            h('a', { href: `#design?scenario=${encodeURIComponent(r.id)}` }, r.name),
            h('button', { type: 'button', class: 'cv-x', 'aria-label': `Remove ${r.name} from the comparison`, dataset: { fk: `xm:${r.id}` }, on: { click: () => this.togglePin(r.id) } }, ui.icon('x')))));

        const step = two && rows.every(r => r.ready) ? this.stepSentence(rows[0], rows[1]) : null;
        const note = h('div', { class: 'cv-sbs-foot' },
            h('p', { class: 'cv-sbs-note' }, h('span', { class: 'cv-dotkey', 'aria-hidden': 'true' }, '●'),
                'Gold: the best in that row. ',
                rows.length < 2 ? 'Pin another option to compare.' : rows.length === 2 ? 'With two pinned, the last column is the difference.' : 'Pin exactly two to see the difference.'));
        this.keepFocus(p.side, () => p.side.replaceChildren(pinlist, h('div', { class: 'cv-sbs-wrap' }, table), note, step ?? '', p.cashHost),
            () => [...p.side.querySelectorAll('.cv-x'), ...p.sideActions.querySelectorAll('select, button')].find(b => b.offsetParent !== null));
        this.renderCash(p.cashHost, rows, pins);
        this.renderBase();
    },

    stepSentence(a, b) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const [lo, hi] = a.capex <= b.capex ? [a, b] : [b, a];
        const dC = hi.capex - lo.capex, dS = hi.sav - lo.sav;
        let text;
        if (Math.abs(dC) < EPS && Math.abs(dS) < 0.5) text = [h('b', null, lo.name), ' and ', h('b', null, hi.name), ' cost and save about the same.'];
        else if (dS <= 0) text = [h('b', null, hi.name), ` costs ${fmt.gbp(dC)} more than `, h('b', null, lo.name), ` and saves ${fmt.gbp(-dS)}/yr less — `, h('b', null, 'no reason to pay more'), '.'];
        else if (dC < EPS) text = [h('b', null, hi.name), ` costs the same as `, h('b', null, lo.name), ` and saves ${fmt.gbp(dS)}/yr more.`];
        else {
            const yrs = dC / dS;
            text = ['From ', h('b', null, lo.name), ' to ', h('b', null, hi.name), `: +${fmt.gbp(dC)} for +${fmt.gbp(dS)}/yr — the extra pays back in `,
                h('b', null, fmt.years(yrs)), yrs > this.settings().maxPayback ? `, longer than your ${this.settings().maxPayback}-year limit.` : '.'];
        }
        return h('p', { class: 'cv-stepline' }, text);
    },

    sideMetrics() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const set = this.settings();
        const sgn = (v, f) => (finite(v) ? `${v > 0 ? '+' : v < 0 ? MINUS : '±'}${f(Math.abs(v))}` : '—');
        const gbpD = (b, a, k) => sgn(b[k] - a[k], x => fmt.gbp(x));
        // both cells read 'none' below half a kWh, so their difference must too
        const kwhD = (b, a, k) => (!finite(b[k]) || !finite(a[k]) ? '—' : Math.abs(b[k]) < 0.5 && Math.abs(a[k]) < 0.5 ? '—' : sgn(b[k] - a[k], x => fmt.kwh(x)));
        const sub = text => h('span', { class: 'cv-sub' }, text);
        const wx = this.ctx.data.summary()?.weatherBasis;
        const wxHelp = wx && finite(wx.pctVsAverage) && Math.abs(wx.pctVsAverage) >= 1
            ? `actual weather: ${fmt.pct(Math.abs(wx.pctVsAverage), { dp: 0 })} ${wx.pctVsAverage > 0 ? 'sunnier' : 'duller'} than average`
            : 'actual weather';
        return [
            { label: 'Upfront cost', value: r => r.capex, better: 'low', render: r => fmt.gbp(r.capex),
                sub: r => sub([r.install > 0 ? `of which installation ${fmt.gbp(r.install)}` : 'no installer needed',
                    r.laterGbp > 0.5 ? `then ${fmt.gbp(r.laterGbp)} in year ${r.laterYear ?? '?'}` : null].filter(Boolean).join(' · ')), diff: (b, a) => gbpD(b, a, 'capex') },
            { label: 'Saves in your first year', help: 'typical-year sunshine', value: r => r.sav, better: 'high', render: r => fmt.gbp(r.sav), diff: (b, a) => gbpD(b, a, 'sav') },
            { label: 'Weather range', help: 'across 2006–2025 sunshine', value: r => r.p90 - r.p10, render: r => (finite(r.p10) && finite(r.p90) ? (Math.abs(r.p90 - r.p10) < 0.5 ? `${fmt.gbp(r.sav)} (no sun needed)` : fmt.range(r.p10, r.p90, fmt.gbp)) : '—') },
            { label: 'Last 12 months as it happened', help: wxHelp, value: r => r.actual, render: r => fmt.gbp(r.actual), diff: (b, a) => gbpD(b, a, 'actual') },
            { label: 'Payback', help: 'simple · discounted', value: r => (finite(r.payback) ? r.payback : Infinity), better: 'low', tie: 0.05,
                render: r => (r.capex <= EPS && r.legal !== 'reference' ? '—' : finite(r.payback) ? fmt.years(r.payback) : 'never'),
                sub: r => {
                    // a power station isn't replaced (unless 'Buy a new battery when it wears out' is
                    // on): once its battery is worn out it stops saving
                    const stops = r.coupling === 'ups' && !r.batteryReplaced && finite(r.batteryEndYear) && r.batteryEndYear < set.years ? `it stops saving after year ${r.batteryEndYear}` : null;
                    const disc = finite(r.dpayback) ? `${fmt.years(r.dpayback)} discounted`
                        : finite(r.payback) ? (stops ? 'never once discounted' : `not within ${set.years} yrs once discounted`)
                            : `not within ${set.years} yrs`;
                    return sub([disc, stops].filter(Boolean).join(' · '));
                },
                diff: (b, a) => (finite(b.payback) && finite(a.payback) ? sgn(b.payback - a.payback, x => fmt.years(x)) : '—') },
            { label: 'Ahead after 10 yrs', help: 'savings minus costs, plain £', value: r => r.net10, better: 'high', render: r => fmt.gbp(r.net10),
                sub: r => sub(`${fmt.gbp(r.npv10)} in today’s money`), diff: (b, a) => gbpD(b, a, 'net10') },
            { label: `${set.years}-yr value`, help: `in today’s money${npvLongHelp(set)}`, value: r => r.npv20, better: 'high', render: r => fmt.gbp(r.npv20), diff: (b, a) => gbpD(b, a, 'npv20') },
            { label: 'Made a year', help: 'solar electricity', value: r => r.pvKwh, better: 'high', tie: 1, render: r => (r.pvKwh > 0.5 ? fmt.kwh(r.pvKwh) : 'no panels'), diff: (b, a) => kwhD(b, a, 'pvKwh') },
            { label: 'Used at home', help: 'share of what it makes', value: r => (r.pvKwh > 0.5 ? r.selfUse : null), better: 'high', tie: 0.2,
                render: r => (r.pvKwh > 0.5 ? fmt.pct(r.selfUse) : '—'), diff: (b, a) => (b.pvKwh > 0.5 && a.pvKwh > 0.5 ? sgn(b.selfUse - a.selfUse, x => `${fmt.num(x, 1)} pts`) : '—') },
            { label: 'Sent to the grid', help: 'paid · unpaid', value: r => r.exportKwh,
                render: r => (r.exportKwh > 0.5 ? fmt.kwh(r.exportKwh) : 'none'),
                sub: r => {
                    if (!(r.exportKwh > 0.5)) return null;
                    const paid = Math.max(0, r.exportKwh - (r.unpaidKwh || 0));
                    if (r.unpaidKwh > 0.5 && paid < 0.5) return sub('all unpaid — no export payments for this option');
                    if (r.unpaidKwh > 0.5) return sub(`${fmt.kwh(paid)} paid · ${fmt.kwh(r.unpaidKwh)} unpaid`);
                    return sub(`all paid · ${r.exportIncome >= 0.5 ? `${fmt.gbp(r.exportIncome)}/yr` : 'under £1/yr'}`);
                },
                diff: (b, a) => kwhD(b, a, 'exportKwh') },
            { label: 'Lost', help: '800 W limit · switched off · station full', value: r => r.lost, better: 'low', tie: 1,
                render: r => (r.lost > 0.5 ? fmt.kwh(r.lost) : 'none'),
                sub: r => (r.lost > 0.5 ? sub([r.clipped > 0.5 ? `${fmt.kwh(r.clipped)} to the 800 W limit` : null, r.curtailed > 0.5 ? `${fmt.kwh(r.curtailed)} switched off` : null,
                    r.upsWasted > 0.5 ? `${fmt.kwh(r.upsWasted)} with the station full` : null].filter(Boolean).join(' · ')) : null),
                diff: (b, a) => kwhD(b, a, 'lost') },
            { label: 'Value per kWh made', help: 'the solar’s first-year £ ÷ kWh', value: r => r.pPerKwh, better: 'high', tie: 0.05, render: r => (finite(r.pPerKwh) ? fmt.p(r.pPerKwh) : '—'),
                // with a battery it is the solar's share (Design's figure), not the cheap-slot charging
                sub: r => (r.pPerKwhSplit && finite(r.pPerKwh) ? sub('leaves out its grid charging') : null),
                diff: (b, a) => (finite(b.pPerKwh) && finite(a.pPerKwh) ? sgn(b.pPerKwh - a.pPerKwh, x => fmt.p(x)) : '—') },
            { label: 'Made between 4 and 7pm', help: 'when Agile is dearest', value: r => (r.pvKwh > 0.5 ? r.peakShare : null), better: 'high', tie: 0.2,
                render: r => (r.pvKwh > 0.5 && finite(r.peakShare) ? fmt.pct(r.peakShare) : '—'),
                // a power station's own panels count too (they charge it; the share is when they make it)
                sub: r => (r.upsPvKwh > 0.5 ? sub(r.pvAcKwh > 0.5 ? 'plug-in and station panels together' : 'by its own panels') : null),
                diff: (b, a) => (b.pvKwh > 0.5 && a.pvKwh > 0.5 && finite(b.peakShare) && finite(a.peakShare) ? sgn(b.peakShare - a.peakShare, x => `${fmt.num(x, 1)} pts`) : '—') },
            { label: 'Battery cycles a year', value: r => (r.hasBattery ? r.cycles : null), render: r => (r.hasBattery ? fmt.num(r.cycles) : 'no battery') },
            { label: 'How it’s installed', text: true, value: () => null, render: r => [h('b', { style: { color: 'var(--text)', fontWeight: 600 } }, routeLabel(r)), ' — ', howText(r)] },
            { label: 'How sure', text: true, value: () => null, render: r => {
                const c = this.confOf(r);
                return [confMeter(h, c, { withReasons: false }), c.reasons.length || c.notes.length ? h('span', { class: 'cv-sub' }, [...c.reasons, ...c.notes].join('; ')) : null];
            } },
        ];
    },

    renderCash(host, rows, pins) {
        const v = this.v;
        const { charts, fmt } = this.ctx;
        const ready = rows.filter(r => r.ready && r.res?.finance?.years?.length);
        if (!ready.length) { v.charts.cash?.destroy(); delete v.charts.cash; host.replaceChildren(); return; }
        const n = Math.max(...ready.map(r => r.res.finance.years.length));
        const xs = Array.from({ length: n }, (_, i) => i);
        const series = ready.map(r => ({
            key: r.id, label: `${LETTERS[pins.indexOf(r.id)]} · ${r.name}`, color: PIN_TOKENS[pins.indexOf(r.id)],
            values: xs.map(y => num(r.res.finance.years[y]?.cumulativeGbp) ?? NaN),
        }));
        const markers = ready.filter(r => finite(r.payback) && r.payback <= n - 1).map(r => ({ x: r.payback, label: `${LETTERS[pins.indexOf(r.id)]} · ${fmt.years(r.payback)}` }));
        this.chart('cash', charts.createLine, host, {
            title: 'Money back over the years',
            ariaLabel: 'Cumulative money back for each pinned option, by year after install',
            note: cashNote(this.settings()),
            x: { values: xs, type: 'linear', label: 'Years after install', format: y => `${y}`, tipFormat: y => (y === 0 ? 'Day one' : `After ${y} yr${y === 1 ? '' : 's'}`) },
            y: { format: x => fmt.gbp(x, { compact: true }) },
            series, markers, endLabels: false, height: 260,
        });
        v.cashIds = ready.map(r => r.id).join();
    },

    /* ── always-on load curve (pins) ────────────────────────────────────── */

    async renderBase() {
        const v = this.v;
        if (!v?.final) return;
        const { ui } = this.ctx;
        const h = ui.h;
        const pins = this.pins();
        const rows = pins.map(id => v.byId.get(id)).filter(r => r && r.ready && r.legal !== 'reference');
        const host = v.parts.base;
        if (!rows.length) {
            v.charts.base?.destroy(); delete v.charts.base;
            v.base = null;
            v.parts.baseSub.textContent = '';
            v.parts.baseFacts.replaceChildren();
            host.replaceChildren(ui.emptyState({ title: 'Pin an option first', body: 'This chart follows your pinned options.' }));
            return;
        }
        const key = `${v.dsId}|${this.settings().sig}|${rows.map(r => `${r.id}:${v.keys.get(r.id)}`).join(',')}`;
        if (v.base?.key === key && v.base.data) { this.drawBase(v.base.data, rows, pins); return; }
        v.base = { key, data: null };
        if (!v.charts.base) host.replaceChildren(ui.skeleton({ height: 240 }));
        else v.charts.base.el?.classList.add('is-stale');
        const token = this.token;
        try {
            const data = await this.engineCall('baseLoadCurve', rows.map(r => engineSystem(r.sys)), null, { finance: this.ctx.data.finance() });
            if (this.v !== v || v.base?.key !== key || token !== this.token) return;
            v.base.data = data;
            this.drawBase(data, rows, pins);
        } catch (err) {
            if (err?.name === 'AbortError' || this.v !== v || v.base?.key !== key) return;
            v.charts.base?.destroy(); delete v.charts.base;
            host.replaceChildren(h('div', { class: 'notice notice-bad' }, ui.icon('alert'), h('span', null, `Couldn’t work out the always-on load curve: ${err?.message || err}`)));
        }
    },

    drawBase(data, rows, pins) {
        const v = this.v;
        const { ui, fmt, charts } = this.ctx;
        const h = ui.h;
        const host = v.parts.base;
        const curves = (data || []).filter(c => c?.points?.length);
        if (!curves.length) { host.replaceChildren(ui.emptyState({ title: 'No curve for these options' })); return; }
        const xs = curves[0].points.map(p => p.x);
        const series = curves.map((c, i) => {
            const r = rows[i];
            const pi = pins.indexOf(r?.id ?? c.id);
            return { key: c.id, label: `${LETTERS[pi] ?? '?'} · ${c.name || r?.name || c.id}`, color: PIN_TOKENS[pi] ?? `cat${i + 1}`, values: xs.map(x => num(c.points.find(p => p.x === x)?.savingsGbp) ?? NaN) };
        });
        const baseW = num(curves[0].baseLoadW);
        const recentW = num(curves[0].recentBaseW);
        const set = this.settings();
        const projW = set.projectBaseW;
        const projected = finite(projW) && (!finite(baseW) || Math.abs(projW - baseW) > 20);
        const markers = [];
        // with a projection ('Use today's W' on Usage) the forecast runs at projW: that is "you now"
        if (finite(baseW)) markers.push({ x: baseW, label: `${projected ? 'last 12 months' : 'you now'} · ${fmt.w(Math.round(baseW))}` });
        if (projected) markers.push({ x: projW, label: `you now · ${fmt.w(Math.round(projW))}` });
        else if (finite(recentW) && finite(baseW) && Math.abs(recentW - baseW) / Math.max(1, baseW) >= 0.15) markers.push({ x: recentW, label: 'last 2 months' });
        const xMax = Math.max(...xs);
        const bands = rows.some(r => r.route === 'plugin') && xMax > 800 ? [{ from: 800, to: xMax, label: 'all of a plug-in kit’s output used at home' }] : [];
        v.parts.baseSub.textContent = '£ saved in the first year if your always-on load were different — your pinned options, same weather, prices and money settings.';
        if (!v.charts.base) host.replaceChildren();
        this.chart('base', charts.createLine, host, {
            title: 'Saves a year at different always-on loads',
            ariaLabel: 'First-year savings of each pinned option against always-on load',
            x: { values: xs, type: 'linear', label: 'Always-on load (W)', format: x => fmt.num(x), tipFormat: x => `${fmt.w(x)} always-on` },
            y: { format: x => fmt.gbp(x) },
            series, markers, bands, endLabels: false, height: 260,
        });
        v.charts.base.el?.classList.remove('is-stale');
        this.baseFacts(curves, rows, pins, xs);
    },

    /**
     * One plain sentence per pinned option: at which always-on loads it pays back within the limit
     * (read off the curve's own points, no interpolation), plus the 'cut 100 W' yardstick.
     */
    baseFacts(curves, rows, pins, xs) {
        const v = this.v;
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const max = this.settings().maxPayback;
        const top = Math.max(...xs);
        const items = curves.map((c, i) => {
            const r = rows[i];
            const pi = pins.indexOf(r?.id ?? c.id);
            const pts = [...c.points].sort((a, b) => a.x - b.x);
            const ok = pts.filter(p => finite(p.paybackYears) && p.paybackYears <= max);
            let text;
            if (!ok.length) text = `doesn’t pay back within ${max} years at any always-on load up to ${fmt.w(top)}.`;
            else {
                const lo = ok[0].x, hi = ok[ok.length - 1].x;
                const gap = pts.some(p => p.x > lo && p.x < hi && !ok.includes(p));
                text = lo <= pts[0].x && hi >= top ? `pays back within ${max} years at any always-on load up to ${fmt.w(top)}.`
                    : gap ? `pays back within ${max} years only at some always-on loads (see the table).`
                        : lo <= pts[0].x ? `pays back within ${max} years only below about ${fmt.w(hi)} of always-on load.`
                            : hi >= top ? `needs at least about ${fmt.w(lo)} of always-on load to pay back within ${max} years.`
                                : `pays back within ${max} years only between about ${fmt.w(lo)} and ${fmt.w(hi)}.`;
            }
            return h('li', null, pinLetter(h, pi), h('span', null, h('b', null, r?.name || c.name), ' ', text));
        });
        const cut = v.byId.get('R1');
        if (cut?.ready && finite(cut.sav)) items.push(h('li', null, h('span', { class: 'cv-letter cv-letter-ref', 'aria-hidden': 'true' }, '−'),
            h('span', null, 'Switching off 100 W of servers for good saves ', h('b', null, `${fmt.gbp(cut.sav)}/yr`), ' on its own — for nothing.')));
        v.parts.baseFacts.replaceChildren(...items);
    },

    /* ── step-ups ladder ────────────────────────────────────────────────── */

    renderLadder() {
        const v = this.v;
        if (!v?.final) return;
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const rows = this.visibleRows();
        markDominance(rows);
        const steps = stepUps(rows);
        const max = this.settings().maxPayback;
        if (!steps.length) {
            v.parts.ladder.replaceChildren(ui.emptyState({ title: 'No options to step through', body: 'Every option shown is either beaten, not on sale or not legal yet. Try clearing the filters.' }));
            return;
        }
        const node = (r, start) => h('li', { class: ['cv-node', start && 'is-start'], style: r ? { '--rc': `var(${routeVar(r)})` } : null },
            h('span', { class: 'cv-node-name' }, r ? h('a', { href: `#design?scenario=${encodeURIComponent(r.id)}` }, r.name) : 'Nothing (today)'),
            h('span', { class: 'cv-node-fig' }, r ? [h('b', null, fmt.gbp(r.capex)), ` · ${fmt.gbp(r.sav)}/yr`] : '£0 · £0/yr'));
        const items = [node(null, true)];
        for (const s of steps) {
            const yrs = s.from ? s.years : s.to.payback;
            const tone = !finite(yrs) ? 'bad' : yrs <= max ? 'good' : 'warn';
            items.push(h('li', { class: 'cv-rung' },
                s.from ? [h('span', { class: 'num' }, `+${fmt.gbp(s.dCapex)}`), ' for ', h('span', { class: 'num' }, `+${fmt.gbp(s.dSav)}/yr`), ' — the extra pays back in']
                    : [h('span', { class: 'num' }, fmt.gbp(s.dCapex)), ' for ', h('span', { class: 'num' }, `${fmt.gbp(s.dSav)}/yr`), ' — pays back in'],
                h('span', { class: ['cv-rung-pill', `tone-${tone}`] }, finite(yrs) ? fmt.years(yrs) : 'never')));
            items.push(node(s.to, false));
        }
        const slow = steps.filter(s => !(s.from ? finite(s.years) && s.years <= max : finite(s.to.payback) && s.to.payback <= max));
        const names = list => list.map(s => s.to.name);
        const join = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
        v.parts.ladder.replaceChildren(
            h('p', { class: 'cv-lede' }, 'Only options nobody beats on price and savings, cheapest first. Each step says what the ',
                h('b', null, 'extra'), ' money buys you.'),
            h('ol', { class: 'cv-ladder', 'aria-label': 'Step-ups from the cheapest option' }, items),
            h('p', { class: 'cv-foot' },
                !slow.length ? `Every step pays its extra back within ${max} years. `
                    : [slow.length === 1 ? 'The step to ' : 'The steps to ', h('b', { style: { color: 'var(--text-2)' } }, join(names(slow))),
                        ` ${slow.length === 1 ? 'takes' : 'take'} longer than ${max} years to pay back ${slow.length === 1 ? 'its' : 'their'} extra cost. `],
                'Step paybacks are simple: extra cost ÷ extra saving in the first year.'));
    },

    /* ── panel-count and battery-size curves ────────────────────────────── */

    renderCurves() {
        const v = this.v;
        if (!v?.final) return;
        this.renderCurve('panels');
        this.renderCurve('battery');
    },

    curveCandidates(kind) {
        // Panels: the engine answers a plug-in build with the list of single kits on sale, each at its
        // own price (with a power station beside the kit, C1, the station's price in every one). Two
        // kits (W3) or a staged plan (W2) aren't a single kit at all, so those are left out.
        return this.v.rows.filter(r => (kind === 'panels' ? canVaryPanels(r) : r.ready && r.legal !== 'reference' && r.hasBattery));
    },

    curveDefault(kind, cands) {
        const best = this.bestId();
        if (kind === 'panels') return (cands.find(r => r.id === best) || cands.find(r => r.route === 'plugin' && r.legal === 'ok') || cands[0])?.id ?? null;
        const b = bestBy(cands, r => r.coupling !== 'ups') || bestBy(cands, () => true);
        return b?.id ?? cands[0]?.id ?? null;
    },

    async renderCurve(kind) {
        const v = this.v;
        const { ui } = this.ctx;
        const h = ui.h;
        const host = v.parts[kind];
        const chartHost = v.parts[`${kind}Chart`];
        const cands = this.curveCandidates(kind);
        const clearChart = () => { v.charts[kind]?.destroy(); delete v.charts[kind]; chartHost.replaceChildren(); };
        if (!cands.length) {
            clearChart();
            host.replaceChildren(ui.emptyState({ title: kind === 'panels' ? 'No option with panels to vary' : 'No option with a battery', body: 'Clear the filters or add an option in Design.' }));
            return;
        }
        if (v.pick?.source === 'pending' && !v.curve[kind]?.userSet) {
            if (!v.charts[kind]) host.replaceChildren(ui.skeleton({ lines: 2 }), h('div', { style: { marginTop: '14px' } }, ui.skeleton({ height: 220 })));
            return;
        }
        const state = v.curve[kind] || (v.curve[kind] = {});
        if (!state.id || !cands.some(r => r.id === state.id)) { state.id = this.curveDefault(kind, cands); state.userSet = false; }
        else if (!state.userSet) state.id = this.curveDefault(kind, cands);
        const row = v.byId.get(state.id);
        const sel = ui.select({
            options: cands.map(r => ({ value: r.id, label: r.name, group: r.legal === 'whatif' ? 'Future rules' : ROUTE[r.route]?.label || 'Other' })),
            value: state.id,
            // debounced: arrow keys on a closed <select> fire 'change' per step, and each step
            // would otherwise queue its own curve run in the worker
            onChange: id => {
                state.id = id;
                state.userSet = true;
                clearTimeout(state.timer);
                v.charts[kind]?.el?.classList.add('is-stale');
                state.timer = setTimeout(() => { if (this.v === v) this.renderCurve(kind); }, 300);
            },
        });
        sel.dataset.fk = `curve:${kind}`;   // rebuilt on every change: keepFocus hands focus to the new one
        const pick = h('div', { class: 'cv-pick' }, ui.field({ label: kind === 'panels' ? 'Grow or shrink' : 'Change the battery of', input: sel }));
        const lede = h('p', { class: 'cv-lede', 'aria-live': 'polite' });
        const key = `${v.dsId}|${this.settings().sig}|${state.id}|${v.keys.get(state.id)}`;
        if (state.key === key && state.data) {
            this.keepFocus(host, () => host.replaceChildren(pick, lede, chartHost));
            this.drawCurve(kind, row, state.data, lede, chartHost);
            return;
        }
        state.key = key;
        state.data = null;
        const skel = v.charts[kind] ? null : ui.skeleton({ height: 220 });
        v.charts[kind]?.el?.classList.add('is-stale');
        this.keepFocus(host, () => host.replaceChildren(pick, lede, chartHost, skel ?? ''));
        lede.textContent = 'Working out each step…';
        const token = this.token;
        try {
            try { state.job?.cancel?.(); } catch { /* finished */ }
            const job = state.job = this.engineCall(kind === 'panels' ? 'panelCountCurve' : 'batterySizeCurve', engineSystem(row.sys), { finance: this.ctx.data.finance() });
            const data = await job;
            if (this.v !== v || state.key !== key || token !== this.token) return;
            state.data = data || [];
            skel?.remove();
            this.drawCurve(kind, row, state.data, lede, chartHost);
        } catch (err) {
            if (err?.name === 'AbortError' || this.v !== v || state.key !== key) return;
            skel?.remove();
            clearChart();
            lede.replaceChildren();
            chartHost.replaceChildren(h('div', { class: 'notice notice-bad' }, ui.icon('alert'), h('span', null, `Couldn’t work this out: ${err?.message || err}`)));
        }
    },

    drawCurve(kind, row, pts, lede, host) {
        const v = this.v;
        const { ui, fmt, charts } = this.ctx;
        const h = ui.h;
        const set = this.settings();
        const max = set.maxPayback;
        // a power station's list starts at 'No panels' (the station on its own), so none → the
        // first panel is a step like any other
        const kitList = kind === 'panels' && pts.some(p => p.kitId);
        if (!pts.length || (!kitList && pts.length < 2)) {
            v.charts[kind]?.destroy(); delete v.charts[kind];
            lede.textContent = kind === 'panels'
                ? `${row.name} can’t take more or fewer panels here.`
                : `${row.name} has no other battery size on sale to compare.`;
            host.replaceChildren();
            return;
        }
        let spec;
        if (kitList) {
            // Plug-in: a kit can't be extended, so compare the kits actually on sale at their prices.
            const list = [...pts].sort((a, b) => a.x - b.x || a.capexGbp - b.capexGbp);
            const here = list.find(p => p.kitId && p.kitId === row.sys.kitId);
            const bestPb = list.filter(p => finite(p.paybackYears)).sort((a, b) => a.paybackYears - b.paybackYears)[0];
            const beside = row.coupling === 'ups' ? ` Each one is priced with ${row.sys.battery?.ups?.pvArrays?.length ? 'the power station and its own panels' : 'the power station'} beside it.` : '';
            ui.put(lede, 'A plug-in kit has to be used exactly as sold, so the only way to change the panel count is a different kit. Each kit on sale, on the same spot: ',
                bestPb ? [h('b', null, bestPb.label), ` pays back fastest (${fmt.years(bestPb.paybackYears)}).`] : 'none pays back.', beside);
            spec = {
                title: 'Plug-in kits on sale, by panel size',
                ariaLabel: 'First-year savings of each plug-in kit against what it would need to save to pay back in time',
                // marker first: narrow screens cut long kit names at the end
                categories: list.map(p => `${p === here ? '▸ ' : ''}${p.label}${p === here ? ' (this one)' : ''}`),
                horizontal: true,
                series: [
                    { key: 'earn', label: 'Saves a year', color: 'pv', values: list.map(p => p.savingsGbp) },
                    { key: 'need', label: `Needed to pay back in ${max} yrs`, color: 'muted', outline: true, values: list.map(p => p.capexGbp / max) },
                ],
                x: { label: 'Kit', tipFormat: (c, i) => `${list[i].label} · ${fmt.num(list[i].x)} W · ${fmt.gbp(list[i].capexGbp)}` },
                y: { format: x => fmt.gbp(x) },
            };
        } else {
            // the engine's 'No battery' point costs what removing the battery leaves (a power
            // station's own panels and frames go with it), so the base step is the station's real price
            const steps = curveSteps(pts, max, { capexNow: row.capex });
            if (!steps.length) { v.charts[kind]?.destroy(); delete v.charts[kind]; lede.textContent = 'Nothing to step through.'; host.replaceChildren(); return; }
            const ok = s => finite(s.years) && s.years <= max;
            const yrs = s => h('b', null, finite(s.years) ? fmt.years(s.years) : 'for ever');
            const what = kind === 'panels' ? 'panel' : 'pack';
            // read the steps in their real order: the battery itself, then each size beyond what's
            // configured (a run of worthwhile steps, then the first that isn't), then other packs
            const base = steps.find(s => s.role === 'base');
            const bigger = steps.filter(s => s.role === 'bigger');
            const alts = steps.filter(s => s.role === 'alt');
            const run = [];
            for (const s of bigger) { if (!ok(s)) break; run.push(s); }
            const firstBad = bigger[run.length] ?? null;
            const thing = row.coupling === 'ups' ? 'The power station' : 'The battery';
            ui.put(lede,
                base ? [`${thing} as configured: +${fmt.gbp(base.dCapex)} for +${fmt.gbp(base.dSav)}/yr — `,
                    ok(base) ? ['pays back in ', yrs(base)] : finite(base.years) ? ['takes ', yrs(base), ' to pay back'] : h('b', null, 'never pays back'), '. '] : null,
                !bigger.length ? (kind === 'panels' ? `${row.name} already has as many panels as its solar inputs take. ` : 'No bigger size of it is on sale. ')
                    : [kind === 'panels' ? `Each extra panel on ${row.name}: ` : 'Each extra pack: ',
                        !firstBad ? `every one pays its extra back within ${max} years.`
                            : !run.length && firstBad.dSav <= EPS ? [`more makes it worse — the first extra ${what} (`, h('b', null, firstBad.label), ') saves ',
                                h('b', null, `${fmt.gbp(-firstBad.dSav)}/yr less`), ', so its extra cost never comes back.']
                                : !run.length ? [`even the first (`, h('b', null, firstBad.label), ') takes ', yrs(firstBad), ' to pay back its extra cost.']
                                    : ['worth it up to ', h('b', null, run[run.length - 1].label), '; ', h('b', null, firstBad.label), ' would take ', yrs(firstBad), ' to pay back its extra.'],
                        ' '],
                alts.map(s => [h('b', null, s.label), ' instead: +', fmt.gbp(s.dCapex), ' for +', fmt.gbp(s.dSav), '/yr — ', ok(s) ? ['pays back in ', yrs(s)] : finite(s.years) ? ['takes ', yrs(s)] : h('b', null, 'never pays back'), '. ']),
                'Solid bar: what each step adds a year. Outline: what it would need to add to pay back in time.');
            spec = {
                title: kind === 'panels' ? 'What each extra panel adds' : 'What each battery step adds',
                ariaLabel: `Extra first-year savings of each ${kind === 'panels' ? 'panel' : 'battery step'} against what it would need to save to pay back within ${max} years`,
                categories: steps.map(s => (s.role === 'base' ? `${row.coupling === 'ups' ? 'The station' : 'The battery'} (${s.label.replace(/\s*\(as configured\)/, '')})`
                    : kind === 'panels' && Math.abs(s.to.capexGbp - row.capex) < 0.01 ? `${s.label} (now)` : s.label)),
                horizontal: true,
                series: [
                    { key: 'earn', label: 'Extra saved a year', color: kind === 'panels' ? 'pv' : 'battery', values: steps.map(s => s.dSav) },
                    { key: 'need', label: `Needed to pay back in ${max} yrs`, color: 'muted', outline: true, values: steps.map(s => s.need) },
                ],
                x: { label: 'Step', tipFormat: (c, i) => `${steps[i].title} · +${fmt.gbp(steps[i].dCapex)}${finite(steps[i].years) ? ` · pays back in ${fmt.years(steps[i].years)}` : ' · never pays back'}` },
                y: { format: x => fmt.gbp(x) },
            };
        }
        // charts.js fits the value axis to the plot width and keeps its end labels inside it
        this.chart(kind, charts.createBars, host, spec);
        v.charts[kind]?.el?.classList.remove('is-stale');
    },

    /* ── chart helper ───────────────────────────────────────────────────── */

    /**
     * Create a chart on first use and update it afterwards. The table twin's open state is
     * remembered per device and the toggle gets a name saying which chart it belongs to.
     */
    chart(key, create, host, spec) {
        const v = this.v;
        const full = { ...spec, table: !!this.pref(`table.${key}`, false), onTable: on => this.setPref(`table.${key}`, !!on) };
        const c = v.charts[key];
        if (c && host.contains(c.el)) c.update(full);
        else { c?.destroy(); v.charts[key] = create(host, full); }
        host.querySelector('.chart-toggle')?.setAttribute('aria-label', `Table: ${spec.title || spec.ariaLabel}`);
    },

    /* ── price editor ───────────────────────────────────────────────────── */

    openPriceEditor(id) {
        const v = this.v;
        const r = v?.byId.get(id);
        if (!r) return;
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const entry = v.entries.find(e => e.sys.id === id);
        const base = entry?.auto ?? null;
        const lines = list(r.sys.costs).map((c, i) => ({ c, i })).filter(({ c }) => c && typeof c === 'object' && !(Number(c.year) > 0));
        const vals = new Map(lines.map(({ c, i }) => [i, Number(c.gbp) || 0]));
        const inputs = new Map();
        const bad = new Set();        // cost lines whose box is empty or not a price: never saved as £0
        const money = x => fmt.gbp(x, { dp: Number.isInteger(Math.round(x * 100) / 100) ? 0 : 2 });
        const total = h('p', { class: 'cv-lede', style: { marginTop: '14px', marginBottom: '0' }, 'aria-live': 'polite' });
        const error = h('p', { class: 'notice notice-bad', role: 'alert', hidden: true }, ui.icon('alert'), h('span', null, 'Put a price in every box (£0 or more) — or press Cancel.'));
        const paint = () => {
            const t = [...vals.values()].reduce((s, x) => s + x, 0);
            total.replaceChildren('Upfront cost: ', h('b', null, bad.size ? '—' : money(t)),
                base ? ` · catalog ${money(sumYear0(base.costs))}` : '');
            if (!bad.size) error.hidden = true;
        };
        const read = (i, input) => {
            const raw = String(input.value).replace(/[,£\s]/g, '');
            const x = raw === '' ? NaN : Number(raw);
            if (Number.isFinite(x) && x >= 0 && x <= 100000) { vals.set(i, x); bad.delete(i); input.removeAttribute('aria-invalid'); }
            else bad.add(i);
            paint();
        };
        const fields = lines.map(({ c, i }) => {
            const auto = base?.costs?.[i];
            const inp = ui.numberInput({ value: Number(c.gbp) || 0, min: 0, max: 100000, step: 1, dp: 2, unit: '£', onChange: () => read(i, inp.input) });
            inputs.set(i, inp.input);
            // 'input' for the running total; 'change' after numberInput has tidied (or restored) the box
            inp.input.addEventListener('input', () => read(i, inp.input));
            inp.input.addEventListener('change', () => read(i, inp.input));
            const hint = auto && Math.abs((Number(auto.gbp) || 0) - (Number(c.gbp) || 0)) > EPS ? `Catalog price ${money(Number(auto.gbp))}` : c.kind === 'install' ? 'Our estimate — use your electrician’s quote' : null;
            return ui.field({ label: typeof c.label === 'string' && c.label.trim() ? c.label : 'Price', hint, input: inp });
        });
        paint();
        const sources = r.products.filter(p => p.priceGbp != null).map(p => `${p.name || p.id}: ${fmt.gbp(p.priceGbp, { dp: Number.isInteger(p.priceGbp) ? 0 : 2 })}${p.priceDate ? ` on ${fmt.date(Date.parse(`${p.priceDate}T12:00:00Z`))}` : ''}`);
        const body = h('div', { class: 'stack-sm' },
            h('p', null, 'Found it cheaper, or got a quote? Put in what you’d really pay. This option is then worked out again with your price — here, in Design and in the Verdict.'),
            fields, total, error,
            sources.length ? h('p', { class: 'field-hint', style: { marginTop: '6px' } }, `Prices we found: ${sources.join(' · ')}.`) : null);
        const isOverride = r.kind === 'price';
        // saving re-renders the board, so the button that opened this is gone: focus its twin
        const refocus = () => setTimeout(() => {
            const a = document.activeElement;
            if (a && a !== document.body && a.isConnected) return;
            const board = this.v?.parts.board;
            if (!board) return;
            // its row may now be folded away with the beaten options: then the fold's toggle
            const cands = [...board.querySelectorAll(`[data-fk="edit:${cssEscape(id)}"], [data-fk="editm:${cssEscape(id)}"]`),
                board.querySelector(`tr[data-id="${cssEscape(id)}"] .cv-name-link`), board.querySelector('[data-fk="beaten"]')];
            cands.find(b => b && b.offsetParent !== null)?.focus();
        }, 0);
        const dlg = ui.modal({
            title: `Your price for ${r.name}`,
            onClose: refocus,
            body,
            actions: [
                { label: 'Cancel' },
                ...(isOverride ? [{ label: 'Back to catalog price', onClick: () => { this.savePrice(id, null); } }] : []),
                {
                    label: 'Use my price', primary: true, onClick: () => {
                        for (const [i, input] of inputs) read(i, input);
                        if (bad.size) {
                            for (const i of bad) inputs.get(i)?.setAttribute('aria-invalid', 'true');
                            error.hidden = false;
                            inputs.get([...bad][0])?.focus();
                            return false;
                        }
                        this.savePrice(id, vals);
                        return true;
                    },
                },
            ],
        });
        // start in the first price box, ready to type over; Enter in a box is "Use my price"
        const submit = dlg?.el?.querySelector('.modal-foot .btn-primary');
        for (const input of inputs.values()) {
            input.addEventListener('keydown', e => {
                if (e.key !== 'Enter' || e.isComposing) return;
                e.preventDefault();
                setTimeout(() => submit?.click(), 0);   // after numberInput has committed the value
            });
        }
        const first = inputs.values().next().value;
        if (first) setTimeout(() => { first.focus(); first.select?.(); }, 0);
    },

    savePrice(id, vals) {
        const v = this.v;
        const { store, ui, fmt } = this.ctx;
        const entry = v?.entries.find(e => e.sys.id === id);
        if (!entry) return;
        const name = v.byId?.get(id)?.name ?? id;
        const saved = Array.isArray(store.get().scenarios?.saved) ? [...store.get().scenarios.saved] : [];
        const base = entry.auto;
        const costs = list(entry.sys.costs).map((c, i) => (vals && vals.has(i) ? { ...c, gbp: Math.round(vals.get(i) * 100) / 100 } : c));
        const unchanged = vals && list(entry.sys.costs).every((c, i) => !vals.has(i) || Math.abs((Number(c?.gbp) || 0) - vals.get(i)) < EPS);
        if (unchanged) { ui.toast(`No change to the price of ${name}.`, { timeoutMs: 3000 }); return; }
        let next;
        let same = false;
        if (entry.kind === 'saved' || entry.kind === 'edited') {
            // a scenario the user saved: change its costs in place
            next = saved.map(s => (s?.id === id ? { ...s, costs } : s));
        } else {
            same = !vals || (base && costs.every((c, i) => Math.abs((Number(c.gbp) || 0) - (Number(base.costs?.[i]?.gbp) || 0)) < EPS));
            next = saved.filter(s => !(s?.id === id && s.priceOverride));
            if (!same) next.push({ ...engineSystem(base || entry.sys), costs, priceOverride: true, overrideOf: id });
        }
        store.set({ scenarios: { saved: next } });
        const t = sumYear0(costs);
        ui.toast(vals && !same ? `Using ${fmt.gbp(t, { dp: Number.isInteger(t) ? 0 : 2 })} for ${name}. Working it out again…` : `Back to the catalog price for ${name}.`, { tone: 'good' });
    },

    flashRow(id) {
        const tr = this.v?.parts.board.querySelector(`tr[data-id="${cssEscape(id)}"]`);
        if (!tr) return;
        tr.classList.remove('is-flash');
        void tr.offsetWidth;
        tr.classList.add('is-flash');
    },

    /* ── print block ────────────────────────────────────────────────────── */

    fillPrint() {
        const v = this.v;
        if (!v) return;
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const s = this.settings();
        const dates = [...(this.products?.values() || [])].map(p => p.priceDate).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).sort();
        const checked = dates.length ? fmt.date(Date.parse(`${dates[dates.length - 1]}T12:00:00Z`)) : fmt.date(Date.now());
        v.parts.print.replaceChildren(h('section', { class: 'cv-print-block' },
            h('h2', null, 'Assumptions'),
            h('ul', null,
                h('li', null, `Prices checked ${checked}. Your own prices are marked “Your price”.`),
                h('li', null, `Money: first year from ${firstYearLabel(s.installDate, fmt) || s.installDate}; ${fmt.pct(s.escalation * 100)} price rise a year; ${fmt.pct(s.discount * 100)} discount rate; ${s.years}-year horizon; VAT on electricity ${s.vatReturns ? 'returns to 5% in April 2027' : 'stays at 0%'}.`),
                h('li', null, 'Sunshine: a typical year at your home (each month scaled to its 2006–2025 average); ranges show 2006–2025 weather.'),
                h('li', null, 'Batteries and power stations use realistic Agile-aware automation; plug-in kits are paid for export only where the seller offers it.'),
                s.projectBaseW != null ? h('li', null, `Projected with ${fmt.num(s.projectBaseW)} W always-on load.`) : null)));
        if (this.products) v.printFilled = true;
    },
};

/* ── view-local components ──────────────────────────────────────────────────── */

/**
 * p10–p90 bar on a shared scale with the typical value as a dot (hollow for future-rules rows).
 * @param {Function} h @param {{ lo, hi, mid, scale: { min, max }, color: string, ring?: boolean }} o
 */
function rangeStrip(h, { lo, hi, mid, scale, color, ring = false }) {
    const span = scale.max - scale.min || 1;
    const at = x => `${Math.max(0, Math.min(100, ((x - scale.min) / span) * 100)).toFixed(2)}%`;
    const kids = [];
    if (scale.min < 0) kids.push(h('i', { class: 'cv-strip-zero', style: { left: at(0) } }));
    if (finite(lo) && finite(hi) && Math.abs(hi - lo) > 0.5) {
        const a = Math.min(lo, hi), b = Math.max(lo, hi);
        kids.push(h('i', { class: 'cv-strip-band', style: { left: at(a), width: `calc(${at(b)} - ${at(a)})` } }));
    }
    if (finite(mid)) kids.push(h('i', { class: ['cv-strip-dot', ring && 'is-ring'], style: { left: at(mid) } }));
    return h('span', { class: 'cv-strip', style: { '--rc': color }, 'aria-hidden': 'true' }, kids);
}

/**
 * Three-step confidence meter with its word; the reasons go in a tooltip and, unless the caller
 * prints them next to it (withReasons: false), in screen-reader text.
 */
function confMeter(h, c, { withReasons = true } = {}) {
    const words = { high: 'High', medium: 'Medium', low: 'Low' };
    const why = [...(c.reasons || []), ...(c.notes || [])].join('; ');
    return h('span', { class: 'cv-conf', title: withReasons ? why || null : null },
        h('span', { class: ['cv-conf-m', `l${c.score}`], 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
        words[c.level] || c.level,
        why && withReasons ? h('span', { class: 'sr-only' }, `: ${why}`) : null);
}

/** A filter pill (aria-pressed) with an optional route dot. */
function filterChip(h, { label, pressed, onClick, dot }) {
    return h('button', { type: 'button', class: 'cv-chip', 'aria-pressed': String(!!pressed), dataset: { fk: `chip:${label}` }, on: { click: onClick } },
        dot ? h('span', { class: ['cv-chip-dot', dot === 'whatif' && 'is-ring'], style: { '--rc': `var(--route-${dot})` }, 'aria-hidden': 'true' }) : null,
        label);
}

function pinLetter(h, idx) {
    return h('span', { class: 'cv-letter', style: { '--pc': `var(${PIN_VARS[idx] || '--faint'})` }, 'aria-hidden': 'true' }, LETTERS[idx] ?? '?');
}

/* ── small helpers ──────────────────────────────────────────────────────────── */

function routeLabel(r) {
    if (r.legal === 'whatif') return ROUTE.whatif.label;
    if (r.route === 'plugin' && r.coupling === 'ups') return 'Plug-in + station';
    return ROUTE[r.route]?.label || r.route || '—';
}
function badgeTone(r) {
    if (r.legal === 'whatif') return 'whatif';
    return ['plugin', 'hardwired', 'ups', 'reference'].includes(r.route) ? r.route : 'default';
}
function routeVar(r) {
    if (r.legal === 'whatif') return '--route-whatif';
    return `--route-${['plugin', 'hardwired', 'ups', 'reference'].includes(r.route) ? r.route : 'reference'}`;
}
function routeColor(r) { return `var(${routeVar(r)})`; }

function howText(r) {
    if (r.legal === 'whatif') return ROUTE.whatif.how;
    if (r.route === 'plugin' && r.coupling === 'ups') return 'A plug-in kit in a socket plus a power station for the servers. Check first: plug-in kits’ instructions forbid use with a battery.';
    if (r.route === 'hardwired' && !list(r.sys?.arrays).length) return 'An electrician wires in a battery; no panels. About £350 to install.';
    return ROUTE[r.route]?.how || '—';
}

/**
 * A battery or power station that wears out before year 10 (the years options are ranked on),
 * as a sub-line for its name: 'wears out in year N' (its savings stop then), or, with 'Buy a new
 * battery when it wears out' on, 'battery bought again after year N'. Null otherwise.
 * @param {{ hasBattery: boolean, batteryEndYear: number|null, batteryReplaced?: boolean }} r row
 * @returns {{ text: string, title: string }|null}
 */
export function wearsOut(r) {
    if (!r?.hasBattery || !finite(r.batteryEndYear) || !(r.batteryEndYear < 10)) return null;
    return r.batteryReplaced
        ? { text: `battery bought again after year ${r.batteryEndYear}`, title: 'A new one is bought then; the 10-yr value counts its price.' }
        : { text: `wears out in year ${r.batteryEndYear}`, title: 'Its savings stop then; the 10-yr value counts that.' };
}

/**
 * The end of the help for the long-horizon value (20-yr value): 'with replacements' only when a
 * new battery is bought each time one wears out; otherwise a worn-out one just stops saving.
 * @param {{ replaceBattery?: boolean }} set
 * @returns {string} a clause starting with its own punctuation
 */
export function npvLongHelp(set) {
    return set?.replaceBattery ? ', with replacements (a new battery each time one wears out)'
        : '; a battery or power station that wears out stops saving then';
}

/**
 * The note under 'Money back over the years': battery replacements are only in those lines when
 * a new battery is bought each time one wears out (the micro-inverter swap is always counted).
 * @param {{ replaceBattery?: boolean }} set
 * @returns {string}
 */
export function cashNote(set) {
    return `Nominal £: savings minus what it cost, with price rises and inverter replacements${set?.replaceBattery
        ? ', and a new battery each time one wears out' : '; a battery or power station that wears out stops saving then'}. Where a line crosses zero, it has paid for itself.`;
}

/**
 * Why the calculator isn't running, in the engine's own words (summary.engineError, e.g. “Couldn't
 * download the product list (data/kits.json, error 503). Try again in a moment.”).
 * @param {object|null} summary DatasetSummary
 * @returns {string}
 */
export function engineWhy(summary) {
    const m = summary?.engineError?.message;
    return typeof m === 'string' && m.trim() ? m.trim() : 'Part of the calculator didn’t download.';
}

/**
 * A failed retryEngine() in a sentence for the card, without the worker's lead-in the card already
 * says ('Your data is loaded, but the simulation engine couldn’t start.').
 * @param {unknown} err
 * @returns {string}
 */
export function retryWhy(err) {
    const m = String(err?.message || err || '').replace(/^Your data is loaded, but the simulation engine couldn[’']t start\.\s*/, '').trim();
    return m || 'Part of the calculator still didn’t download.';
}

function sumYear0(costs) {
    return list(costs).filter(c => !(Number(c?.year) > 0)).reduce((s, c) => s + (Number(c?.gbp) || 0), 0);
}

/** A tidy max for the strip scale (1/2/2.5/5 × 10ⁿ). */
function niceMax(lo, hi) {
    const nice = x => {
        if (!(x > 0)) return 0;
        const e = 10 ** Math.floor(Math.log10(x));
        return [1, 2, 2.5, 5, 10].map(m => m * e).find(m => m >= x - 1e-9);
    };
    return { min: lo < 0 ? -nice(-lo) : 0, max: Math.max(nice(hi), 1) };
}

/** The 1st of next month on the UK calendar — the engine's default install date (core.js). */
export function nextMonthIso(now = Date.now()) {
    let y, m0;
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric' }).formatToParts(new Date(now));
        y = Number(parts.find(p => p.type === 'year')?.value);
        m0 = Number(parts.find(p => p.type === 'month')?.value) - 1;
    } catch { /* no time-zone data: UTC is within an hour of it */ }
    if (!Number.isFinite(y) || !Number.isFinite(m0)) { const d = new Date(now); y = d.getUTCFullYear(); m0 = d.getUTCMonth(); }
    const ny = y + (m0 === 11 ? 1 : 0);
    const nm = (m0 + 1) % 12;
    return `${ny}-${String(nm + 1).padStart(2, '0')}-01`;
}

/** 'Nov 2026 – Oct 2027' for an install date. */
function firstYearLabel(iso, fmt) {
    const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
    if (!m) return null;
    const y = +m[1], mo = +m[2] - 1;
    const end = mo === 0 ? `${y}-12` : `${y + 1}-${String(mo).padStart(2, '0')}`;
    return `${fmt.month(`${y}-${m[2]}`)} – ${fmt.month(end)}`;
}

function cssEscape(s) {
    try { return CSS.escape(s); } catch { return String(s).replace(/["\\]/g, '\\$&'); }
}

function injectStyle(h) {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    document.head.appendChild(h('style', { id: STYLE_ID }, STYLES));
}
