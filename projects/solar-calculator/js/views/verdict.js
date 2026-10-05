/*
 * views/verdict.js — the Verdict tab: the answer first, then the evidence (UX critique "Verdict").
 *
 * Everything on it comes from ctx.data.verdict() (js/verdict.js in the worker), streamed in five
 * stages; the usage tiles come straight from ctx.data.insights() so they appear before the
 * simulations start. Layout (≥ 1024 px two columns, left: blocks 1–3, right: 4–5):
 *   head      kicker, title, context line + real-data chip, [Save as PDF]; on example data a
 *             'Server load' slider that reloads the demo; a stage strip while it works
 *   banner    always-on load drift / projection (sets or clears settings.projectBaseW)
 *   1 tiles   always-on load · what it costs · your electricity, last 12 months
 *   2 best    "Buy the …": typical-year saving with the weather range, payback, a cash-flow runway,
 *             why-line, "same as switching off N W", next steps, runner-up and going-bigger lines
 *   3 options every option ranked by 10-year value, in one grouped table (optionGroups): the
 *             options, the yardsticks under a divider, those beaten on both price and savings
 *             (folded), the future-rules plans; prices the user set in Compare are used and marked
 *   4 scatter cost vs yearly saving with payback lines, weather whiskers and the best-value front
 *   5 questions  west vs south, battery, power station, growing later, how sure, always-on load —
 *             each a one-line answer that opens to the reasoning, a chart and a link onward
 * Below 1024 px one column: tiles → best buy → options → questions → chart; phones (≤ 600 px)
 * best buy → top options → questions → tiles → chart (folded). The DOM is always in the order on
 * screen (arrange(), not CSS order), so reading and Tab order follow what is seen.
 *
 * Recomputing (settings, a new demo load) keeps every block on screen, dimmed, until the stage
 * that refreshes it arrives — figures never jump between a typical and an actual year.
 *
 * Shared pieces: ui.table groups (with header help and its .tbl-note), ui.coverageChip, ui.put,
 * the charts' tableCaption. View-local components (candidates for ui.js / charts.js): vdRunway() —
 * the best buy's cumulative cash over ten years with the weather fan and the pay-back point;
 * vdRange() — a p10–p90 bar inside a table cell; vdStages() — a compact stage strip for streamed
 * work; rich() — renders the verdict copy's **emphasis**. Their CSS lives in the injected
 * <style id="style-verdict">.
 */

const STYLE_ID = 'style-verdict';
const STAGES = ['usage', 'plugin', 'all', 'bands', 'answers'];
const STAGE_LABEL = { usage: 'Listing the options', plugin: 'Solar on its own', all: 'Batteries & power stations', bands: '20 years of weather', answers: 'Your questions' };
const ROUTE_LABEL = { plugin: 'Plug-in', hardwired: 'Electrician', ups: 'Power station', whatif: 'Future rules', reference: 'Yardstick' };
const LEVEL = { high: { label: 'High', tone: 'good' }, medium: { label: 'Medium', tone: 'info' }, low: { label: 'Low', tone: 'warn' } };
const BADGE_TONE = { best: 'accent', most: 'good', fastest: 'info', lowest: 'default' };
const MOBILE_ROWS = 5;
const DEMO_W = { min: 0, max: 1500, step: 50 };
const RUNWAY_YEARS = 10;
const QUESTIONS = [
    { key: 'orientation', q: 'Should the panels face west for the 4–7pm peak?' },
    { key: 'battery', q: 'What does a battery add?' },
    { key: 'ups', q: 'Is a power station for the servers worth it?' },
    { key: 'growth', q: 'Can I add more later?' },
    { key: 'confidence', q: 'How sure is this?' },
    { key: 'baseLoad', q: 'How much does my always-on load matter?' },
];

const CSS = `
.vd { display: flex; flex-direction: column; gap: 20px; }
.vd .view-head { margin-bottom: 0; align-items: flex-start; }
.vd .view-title:focus { outline: none; }
.vd .view-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.vd-head-main { min-width: 0; flex: 1 1 520px; }
.vd-head-actions { display: flex; gap: 8px; flex: none; padding-top: 22px; }
.vd-context { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 8px; }
.vd-context .context-line { min-width: 0; overflow-wrap: anywhere; }
.vd-ctx-short { display: none; }

.vd-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 26px; }
.vd-toolbar:empty { display: none; }
.vd-demo { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 0 1 430px; }
.vd-demo-label { font-family: var(--font-mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
.vd-demo .slider { flex: 1; min-width: 150px; }
.vd-demo .range-out { min-width: 7ch; }
.vd-stages { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; margin: 0; padding: 0; list-style: none;
    font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); }
.vd-stages li { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.vd-stage-dot { width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--border-strong); flex: none; }
.vd-stages li.is-done { color: var(--text-2); }
.vd-stages li.is-done .vd-stage-dot { background: var(--good); border-color: var(--good); }
.vd-stages li.is-active { color: var(--text); }
.vd-stages li.is-active .vd-stage-dot { border-color: var(--surface-3); border-top-color: var(--accent); animation: spin .8s linear infinite; width: 10px; height: 10px; border-width: 2px; }
.vd-stages-done { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); display: inline-flex; align-items: center; gap: 7px; }
.vd-stages-done .icon { color: var(--good); width: 14px; height: 14px; }

.vd-banner { align-items: center; flex-wrap: wrap; }
.vd-banner-text { flex: 1 1 320px; min-width: 0; }
.vd-banner-text b { color: var(--text); font-weight: 600; }
.vd-banner .btn { flex: none; }

.vd-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.vd-b-options, .vd-b-assume { grid-column: 1 / -1; }
.vd-col { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.vd-block { transition: opacity .2s ease; min-width: 0; }
.vd-block.is-stale, .vd-qd.is-stale { opacity: .45; }
.vd-qd { transition: opacity .2s ease; }
.vd .tiles { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.vd .stat-value { font-size: 25px; }

/* ── best buy ── */
.vd-best { padding: 24px 26px 22px; }
.vd-best-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.vd-best-top .card-eyebrow { margin: 0; }
.vd-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.vd-best-title { font-size: 30px; font-weight: 700; letter-spacing: -.035em; line-height: 1.12; }
.vd-best-title .vd-name { color: var(--accent-strong); }
.vd-best-title:focus { outline: none; }
.vd-best-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.vd-best-none .vd-best-title { font-size: 25px; }
.vd-lede { margin-top: 12px; color: var(--text-2); font-size: 15.5px; line-height: 1.55; max-width: 60ch; }
.vd-lede b, .vd-rich b { color: var(--text); font-weight: 600; }
.vd-readout { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 20px 0 0; border: 1px solid var(--hairline); border-radius: 9px; overflow: hidden; background: var(--hairline); gap: 1px; }
.vd-readout > div { background: var(--surface); padding: 11px 13px 12px; min-width: 0; }
.vd-readout > div { display: flex; flex-direction: column; justify-content: space-between; }
.vd-readout dt { font-family: var(--font-mono); font-size: 10px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); line-height: 1.35; }
.vd-readout dd { margin: 5px 0 0; font-family: var(--font-mono); font-size: 21px; font-weight: 600; letter-spacing: -.035em; color: var(--text); white-space: nowrap; }
.vd-readout dd small { font-family: var(--font-body); font-size: 12px; font-weight: 500; letter-spacing: 0; color: var(--muted); margin-left: 3px; }
.vd-readout dd.is-good { color: var(--good); }

.vd-runway { margin: 18px 0 2px; }
.vd-runway-head { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; color: var(--muted); margin-bottom: 4px; }
.vd-runway-head b { color: var(--text-2); font-weight: 500; }
.vd-runway-plot { position: relative; height: 96px; }
.vd-runway-plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.vd-rw-band { fill: var(--accent); fill-opacity: .14; }
.vd-rw-line { fill: none; stroke: var(--accent); stroke-width: 2.25; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.vd-rw-zero { stroke: var(--border-strong); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.vd-rw-below { fill: var(--bad); fill-opacity: .07; }
.vd-rw-grid { stroke: var(--hairline); stroke-width: 1; vector-effect: non-scaling-stroke; }
.vd-rw-dot { position: absolute; width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--surface), 0 0 0 4.5px var(--accent-line); }
.vd-rw-tag { position: absolute; font-family: var(--font-mono); font-size: 11px; color: var(--text); white-space: nowrap; text-shadow: 0 0 3px var(--surface), 0 0 6px var(--surface); }
.vd-rw-tag.is-muted { color: var(--muted); }
.vd-rw-axis { position: relative; height: 18px; font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); }
.vd-rw-axis span { position: absolute; top: 3px; transform: translateX(-50%); white-space: nowrap; }
.vd-rw-axis span:first-child { transform: none; }
.vd-rw-axis span:last-child { transform: translateX(-100%); }

.vd-points { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 8px; }
.vd-points li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; color: var(--text-2); font-size: 14px; }
.vd-points .icon { margin-top: 3px; color: var(--accent); }
.vd-steps { margin-top: 18px; border-top: 1px solid var(--hairline); padding-top: 14px; }
.vd-steps-title { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.vd-steps ol { list-style: none; margin: 0; padding: 0; counter-reset: vdstep; display: grid; gap: 8px; }
.vd-steps li { counter-increment: vdstep; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; font-size: 13.5px; color: var(--text-2); line-height: 1.5; }
.vd-steps li::before {
    content: counter(vdstep); display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
    border: 1px solid var(--accent-line); color: var(--accent); font-family: var(--font-mono); font-size: 11px; font-weight: 600;
}
.vd-steps a { white-space: nowrap; }
.vd-steps a .icon { display: inline; margin-left: 3px; width: 12px; height: 12px; vertical-align: -1px; }
.vd-steps-fold > summary { min-height: 44px; }
.vd-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
.vd-alts { margin-top: 18px; display: grid; gap: 1px; background: var(--hairline); border: 1px solid var(--hairline); border-radius: 9px; overflow: hidden; }
.vd-alts > div { background: var(--surface); padding: 10px 13px; font-size: 13.5px; color: var(--text-2); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; }
.vd-alts > div b { color: var(--text); font-weight: 600; }
.vd-alts .btn { flex: none; }
.vd-wxnote { margin-top: 14px; font-size: 12.5px; color: var(--muted); display: flex; gap: 8px; align-items: flex-start; }
.vd-wxnote .icon { margin-top: 2px; color: var(--muted); }
.vd-error { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }

/* ── options ── */
.vd-opt .tbl td, .vd-opt .tbl th { vertical-align: middle; }
.vd-opt-name { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.vd-opt-name > span:first-child { overflow-wrap: anywhere; }
.vd-opt-badges { display: flex; flex-wrap: wrap; gap: 4px; }
.vd-opt-later { font-size: 12px; color: var(--muted); font-weight: 400; }
.vd-opt-later + .vd-opt-later { margin-top: -2px; }
.vd-opt-badges .badge { height: 19px; font-size: 10.5px; padding: 0 6px; }
.vd-sav { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.vd-sav small { font-size: 11.5px; font-weight: 500; color: var(--muted); margin-left: 2px; }
.vd-range { position: relative; display: block; width: 64px; height: 4px; border-radius: 2px; background: var(--surface-3); }
.vd-range-band { position: absolute; top: 0; bottom: 0; border-radius: 2px; background: var(--accent); opacity: .55; min-width: 2px; }
.vd-range-mid { position: absolute; top: -3px; width: 2px; height: 10px; margin-left: -1px; border-radius: 1px; background: var(--text); }
/* yardsticks sit under a dashed divider, in quieter ink (ui.table group 'refs') */
.vd-opt .tbl tr.vd-ref > * { color: var(--muted); }
/* a group heading that wraps on a phone reads from the left, like the rest of the card */
.vd-opt .tbl-group-toggle { text-align: left; }
.vd-neg { color: var(--bad); }
.vd-free { color: var(--good); }
.vd-sub-note { font-size: 13px; color: var(--muted); margin: 2px 0 8px; }
.vd-opt .tbl-note b { color: var(--text-2); font-weight: 600; }
.vd-rank-note { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 10px; }
.vd-rank-note .icon { margin-top: 2px; color: var(--info); }
.vd-inline-link {
    display: inline; padding: 0; border: 0; background: none; font: inherit; color: var(--accent); cursor: pointer;
    text-decoration: underline; text-decoration-color: var(--accent-line); text-underline-offset: 3px;
}
.vd-inline-link:hover { color: var(--accent-strong); }
.vd-inline-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
.vd-override { margin: 0 0 12px; align-items: flex-start; }
.vd-override a { white-space: nowrap; }
.vd-pending-row { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--muted); padding: 12px 2px 0; }
.vd-opt .disclosure { margin-top: 12px; }

/* ── questions ── */
.vd-qs .disclosure:first-child { border-top: 0; }
.vd-q { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 2px 8px; padding: 4px 0; }
.vd-q-idx { font-family: var(--font-mono); font-size: 11px; color: var(--muted); padding-top: 2px; grid-row: span 2; }
.vd-q-title { font-size: 13px; color: var(--muted); font-weight: 500; }
.vd-q-answer { font-size: 15px; color: var(--text); font-weight: 500; line-height: 1.4; }
.vd-q-answer b { font-weight: 650; color: var(--accent-strong); }
.vd-q-pending { display: inline-flex; align-items: center; gap: 8px; color: var(--muted); font-size: 14px; }
.vd-q-body { display: flex; flex-direction: column; gap: 12px; padding-left: 38px; }
.vd-q-body p { color: var(--text-2); font-size: 14px; line-height: 1.6; }
.vd-q-body .vd-rich ul { margin: 0; padding-left: 18px; display: grid; gap: 8px; color: var(--text-2); font-size: 14px; line-height: 1.55; }
.vd-q-link { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.vd-levels { display: flex; flex-wrap: wrap; gap: 8px; }
.vd-level { display: inline-flex; flex-direction: column; gap: 2px; padding: 8px 12px; border: 1px solid var(--hairline); border-radius: 8px; min-width: 120px; }
.vd-level-k { font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.vd-level-v { font-size: 14px; font-weight: 600; }
.vd-level-v.tone-good { color: var(--good); }
.vd-level-v.tone-info { color: var(--info); }
.vd-level-v.tone-warn { color: var(--warn); }
.vd-level-r { font-size: 12px; color: var(--muted); max-width: 30ch; }

.vd-assume dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 20px; font-size: 13.5px; }
.vd-assume dt { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); padding-top: 3px; }
.vd-assume dd { margin: 0; color: var(--text-2); }
.vd-print-only { display: none; }
@media (min-width: 601px) { .vd-chart-fold > summary { display: none; } .vd-chart-fold { border: 0; } .vd-chart-fold > .disclosure-body { padding: 0; } }

/* one column below 1024 px: arrange() puts the blocks in the DOM in the order they are seen */
@media (max-width: 1023px) {
    .vd-grid { display: flex; flex-direction: column; align-items: stretch; }
    .vd-col { display: contents; }
}
@media (max-width: 760px) {
    .vd-readout { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
    .vd { gap: 16px; }
    .vd-grid { gap: 16px; }
    .vd-head-actions { display: none; }
    .vd-ctx-long { display: none; }
    .vd-ctx-short { display: inline; }
    .vd-demo { flex-basis: 100%; }
    .vd-best { padding: 18px 16px 16px; }
    .vd-best-title { font-size: 24px; }
    .vd-lede { font-size: 14.5px; }
    .vd-readout dd { font-size: 19px; }
    .vd-runway { display: none; }
    .vd .cov-chip:not(.is-warn) { display: none; }
    .vd-readout > div { padding: 9px 11px 10px; }
    .vd-alts { margin-top: 4px; }
    .vd-steps { margin-top: 12px; padding-top: 4px; }
    .vd .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .vd .tiles > :last-child:nth-child(odd) { grid-column: 1 / -1; }
    .vd-alts > div { grid-template-columns: minmax(0, 1fr); }
    .vd-actions .btn { flex: 1 1 140px; }
    .vd-q-body { padding-left: 0; }
    .vd-q { grid-template-columns: minmax(0, 1fr); }
    .vd-q-idx { display: none; }
    .vd-assume dl { grid-template-columns: minmax(0, 1fr); gap: 2px; }
    .vd-assume dd { margin-bottom: 8px; }
    .vd-steps a { white-space: normal; display: inline-flex; align-items: center; min-height: 44px; }
    .vd-opt-badges .badge { height: 22px; }
    .vd-rank-note .vd-inline-link, .vd-override a { display: inline-flex; align-items: center; min-height: 44px; }
}
@media print {
    .vd-block.is-stale, .vd-qd.is-stale { opacity: 1; }
    .vd-toolbar, .vd-head-actions, .vd-actions, .vd-banner .btn, .vd-q-link, .vd-inline-link, .vd-override a { display: none !important; }
    .vd-print-only { display: block; margin-top: 4px; }
    .vd .cov-chip { display: none !important; }
    .vd :focus, .vd :focus-visible { outline: none !important; box-shadow: none !important; }
    /* style.css keeps a card without a chart or table whole on paper; these run to pages (the best
       buy and the questions too), so let them flow and keep only their parts (a question's heading
       with its first lines, a chart with its table) whole */
    .vd .vd-best, .vd .vd-qs, .vd .vd-opt, .vd .vd-b-scatter .card { break-inside: auto !important; }
    .vd-qd { break-inside: auto; }
    .vd-qd > summary { break-after: avoid; }
    .vd-q-body > *, .vd-best-top, .vd-readout, .vd-runway, .vd-steps li, .vd-alts > div { break-inside: avoid; }
    .vd .chart { break-inside: avoid; }
    .vd .chart-table .tbl { table-layout: fixed; width: 100%; }
    .vd .chart-table .tbl th, .vd .chart-table .tbl td { overflow-wrap: anywhere; }
    .vd .chart-table .tbl thead th { white-space: normal !important; }
    .vd .card-head { break-after: avoid; }
    .vd-grid { display: block; }
    .vd-col { display: block; }
    .vd-col > * + *, .vd-grid > * + * { margin-top: 14px; }
    .vd-best-title .vd-name { color: #6f5713; }
    .vd-rw-dot { box-shadow: none; }
}
`;

/* ── small pure helpers ───────────────────────────────────────────────────── */

const finite = v => typeof v === 'number' && Number.isFinite(v);
const stageIdx = s => STAGES.indexOf(s);

/** The verdict copy marks the figure that matters with **…**; render it as <b>. */
function rich(h, text) {
    const out = [];
    String(text ?? '').split(/\*\*(.+?)\*\*/).forEach((part, i) => { if (part) out.push(i % 2 ? h('b', null, part) : part); });
    return out;
}
const plainText = s => String(s ?? '').replace(/\*\*/g, '');

/** Tornado bar-end names, short enough to sit beside a bar ('prices −20%' → '−20%'). */
const SHORT_SETTING = {
    price: { low: '−20%', high: '+20%' },
    weather: { low: 'dull', high: 'sunny' },
    shading: { low: 'no shade', high: '15% shade' },
    trend: { low: '0%/yr', high: '4%/yr' },
    automation: { low: 'realistic', high: 'perfect' },
};
/** Tornado row names on phones, where the plot needs the room. */
const SHORT_DRIVER = { price: 'Agile prices', shading: 'Shading', weather: 'Weather', baseLoad: 'Always-on load', trend: 'Price trend', automation: 'Automation' };
function shortSetting(key, label, side) {
    if (SHORT_SETTING[key]) return SHORT_SETTING[key][side];
    return String(label ?? '').replace(/^prices\s+/i, '');
}

/**
 * The ranked options as the groups of one ui.table, in this order: the options (best 10-year value
 * first), the yardsticks under a dashed divider, the options beaten on both price and savings
 * (folded until opened) and the future-rules plans (folded on phones). On phones only the first
 * `mobileRows` options show; the rest, with the yardsticks, sit in a folded 'More options' group.
 * Pure — rows are the verdict's own rows, in the verdict's order.
 * @param {{ ranked?: object[] }} V
 * @param {{ phone?: boolean, showAll?: boolean, beatenOpen?: boolean, plansOpen?: boolean, mobileRows?: number }} [o]
 * @returns {{ groups: Array<{ key: string, title?: string, note?: string, rows: object[], divider?: boolean, collapsible?: boolean,
 *   collapsed?: boolean, className?: string }>, main: object[], refs: object[], beaten: object[], plans: object[], limited: boolean }}
 */
export function optionGroups(V, { phone = false, showAll = false, beatenOpen = false, plansOpen = false, mobileRows = MOBILE_ROWS } = {}) {
    const ranked = V?.ranked ?? [];
    const main = ranked.filter(r => (r.legal === 'ok' || r.legal === 'check') && !r.dominatedBy);
    const refs = ranked.filter(r => r.legal === 'reference');
    const beaten = ranked.filter(r => r.dominatedBy);
    const plans = ranked.filter(r => r.legal === 'whatif');
    const limited = !!phone && main.length > mobileRows;
    const groups = limited
        ? [{ key: 'main', rows: main.slice(0, mobileRows) },
            { key: 'more', title: 'More options', rows: [...main.slice(mobileRows), ...refs], collapsible: true, collapsed: !showAll, className: 'vd-g-more' }]
        : [{ key: 'main', rows: main }, { key: 'refs', rows: refs, divider: true, className: 'vd-g-refs' }];
    groups.push(
        { key: 'beaten', title: 'Beaten on both price and savings', note: 'Each costs at least as much as another option and saves no more.',
            rows: beaten, collapsible: true, collapsed: !beatenOpen, className: 'vd-g-beaten' },
        { key: 'plans', title: 'Not legal yet — for planning', note: plans[0]?.banner || 'Not legal in GB today — shown for planning only.',
            rows: plans, collapsible: !!phone, collapsed: !!phone && !plansOpen, className: 'vd-g-plans' });
    return { groups, main, refs, beaten, plans, limited };
}

/** 'YYYY-MM-DD' → '5 Oct 2026'. */
function isoDay(fmt, iso) {
    return iso ? fmt.date(Date.parse(`${iso}T12:00:00Z`)) : '—';
}

/* ── view-local components ────────────────────────────────────────────────── */

/**
 * vd-range — the p10–p90 weather range as a small bar with a tick at the typical year, scaled to
 * the largest p90 in the table. Decorative: the cell's text and title carry the numbers.
 */
function vdRange(h, { lo, mid, hi, max }) {
    if (!finite(lo) || !finite(hi) || !(max > 0)) return null;
    const p = v => `${Math.max(0, Math.min(100, (v / max) * 100)).toFixed(2)}%`;
    return h('span', { class: 'vd-range', 'aria-hidden': 'true' },
        h('span', { class: 'vd-range-band', style: { left: p(lo), width: `calc(${p(hi)} - ${p(lo)})` } }),
        finite(mid) ? h('span', { class: 'vd-range-mid', style: { left: p(mid) } }) : null);
}

/**
 * vd-runway — the best buy's money over the first ten years: cumulative cash from −cost through
 * the pay-back point, with the 2006–2025 weather fan (p10–p90) behind it. role=img with a label;
 * the exact figures sit in the readout above it.
 */
function vdRunway(h, fmt, { cashflow, payback, capex, years = RUNWAY_YEARS }) {
    const cum = cashflow?.cumulativeGbp ?? [];
    if (cum.length < 2) return null;
    const Y = Math.max(2, Math.min(cum.length - 1, Math.max(years, finite(payback) ? Math.ceil(payback) + 1 : years)));
    const main = cum.slice(0, Y + 1);
    const p10 = cashflow.p10?.length > Y ? cashflow.p10.slice(0, Y + 1) : null;
    const p90 = cashflow.p90?.length > Y ? cashflow.p90.slice(0, Y + 1) : null;
    const all = [...main, ...(p10 ?? []), ...(p90 ?? []), 0];
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const span = hi - lo || 1;
    lo -= span * 0.24;      // room under the start for its label
    hi += span * 0.06;
    const X = i => (i / Y) * 100;
    const Yp = v => 100 * (1 - (v - lo) / (hi - lo));
    const path = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(3)} ${Yp(v).toFixed(3)}`).join('');
    const zero = Yp(0);
    const svg = h('svg', { viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
        [0.25, 0.5, 0.75].map(f => h('line', { x1: X(Y * f), x2: X(Y * f), y1: 0, y2: 100, class: 'vd-rw-grid' })),
        h('rect', { x: 0, y: zero, width: 100, height: Math.max(0, 100 - zero), class: 'vd-rw-below' }),
        p10 && p90 ? h('path', { d: `${path(p90)}${p10.map((v, i) => `L${X(p10.length - 1 - i).toFixed(3)} ${Yp(p10[p10.length - 1 - i]).toFixed(3)}`).join('')}Z`, class: 'vd-rw-band' }) : null,
        h('line', { x1: 0, x2: 100, y1: zero, y2: zero, class: 'vd-rw-zero' }),
        h('path', { d: path(main), class: 'vd-rw-line' }));
    const tags = [];
    const end = main[main.length - 1];
    tags.push(h('span', { class: 'vd-rw-tag is-muted', style: { left: '4px', top: `calc(${Yp(main[0])}% + 3px)` } }, fmt.gbp(main[0])));
    // the end figure sits above the line's end, or under it when the line ends near the top
    // (where it would run into the strip's heading)
    const endY = Yp(end);
    tags.push(h('span', { class: 'vd-rw-tag', style: { right: '0%', top: endY < 30 ? `calc(${endY}% + 6px)` : `calc(${endY}% - 18px)` } }, `${end >= 0 ? '+' : ''}${fmt.gbp(end)}`));
    if (finite(payback) && payback <= Y) {
        const px = X(payback);
        tags.push(h('span', { class: 'vd-rw-dot', style: { left: `${px}%`, top: `${zero}%` } }));
        const left = px < 70;
        tags.push(h('span', { class: 'vd-rw-tag', style: { [left ? 'left' : 'right']: left ? `calc(${px}% + 10px)` : `calc(${100 - px}% + 10px)`, top: `calc(${zero}% + 4px)` } },
            `pays back · ${fmt.years(payback)}`));
    }
    const axis = h('div', { class: 'vd-rw-axis', 'aria-hidden': 'true' },
        h('span', { style: { left: '0%' } }, 'today'),
        h('span', { style: { left: `${X(Math.round(Y / 2))}%` } }, `${Math.round(Y / 2)} yrs`),
        h('span', { style: { left: '100%' } }, `${Y} yrs`));
    const label = `Money over ${Y} years: starts at ${fmt.gbp(main[0])}${finite(payback) ? `, pays back after ${fmt.years(payback)}` : ''}, ${fmt.gbp(end)} ahead after ${Y} years${p10 && p90 ? ` (${fmt.gbp(p10[Y])} to ${fmt.gbp(p90[Y])} across 2006–2025 weather)` : ''}.`;
    return h('figure', { class: 'vd-runway', role: 'img', 'aria-label': label, style: { margin: '18px 0 2px' } },
        h('div', { class: 'vd-runway-head', 'aria-hidden': 'true' },
            h('span', null, h('b', null, 'Your money'), ' · cumulative, after paying for it'),
            p10 && p90 ? h('span', null, 'band: 2006–2025 weather') : null),
        h('div', { class: 'vd-runway-plot' }, svg, tags), axis);
}

/** vd-stages — a compact strip of the verdict's stages while it streams. */
function vdStages(h, ui, stageI, done, info) {
    if (done) {
        return h('span', { class: 'vd-stages-done' }, ui.icon('check'), info);
    }
    return h('ol', { class: 'vd-stages', 'aria-label': 'Working out your verdict' },
        STAGES.map((s, i) => h('li', { class: i <= stageI ? 'is-done' : i === stageI + 1 ? 'is-active' : null },
            h('span', { class: 'vd-stage-dot', 'aria-hidden': 'true' }), STAGE_LABEL[s],
            h('span', { class: 'sr-only' }, i <= stageI ? ' (done)' : i === stageI + 1 ? ' (working)' : ' (waiting)'))));
}

function injectStyle(h) {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    document.head.appendChild(h('style', { id: STYLE_ID }, CSS));
}

/** Give a control a stable key ([data-fk]) so holdFocus() can find its rebuilt twin. */
function fk(el, key) {
    if (el) el.dataset.fk = key;
    return el;
}

/**
 * Rebuild part of the page (build()) without throwing keyboard or screen-reader focus away: if
 * focus was inside `host` on an element the rebuild replaced, it goes to the rebuilt twin with the
 * same [data-fk] — a fold's <summary> included, which ui.keepFocus can't target — else to
 * `fallback`. Folds ([data-fk] <details>) that were open stay open. Focus elsewhere is untouched.
 * @param {HTMLElement} host
 * @param {() => void} build
 * @param {HTMLElement|null} [fallback]
 */
function holdFocus(host, build, fallback = null) {
    const doc = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const a = doc?.activeElement ?? null;
    const inside = !!a && a !== doc.body && host.contains(a);
    const holder = inside ? a.closest('[data-fk]') : null;
    const key = holder && host.contains(holder) ? holder.dataset.fk : null;
    const open = new Set([...host.querySelectorAll('details[data-fk]')].filter(d => d.open).map(d => d.dataset.fk));
    build();
    for (const d of host.querySelectorAll('details[data-fk]')) if (open.has(d.dataset.fk)) d.open = true;
    if (!inside || (a.isConnected && host.contains(a))) return;
    const twin = key != null ? [...host.querySelectorAll('[data-fk]')].find(x => x.dataset.fk === key) ?? null : null;
    // a fold is keyed on its <details>: its summary is what takes focus
    const target = twin ? (twin.localName === 'details' ? twin.querySelector('summary') : twin) : fallback;
    if (!target) return;
    try { target.focus({ preventScroll: true }); } catch { target.focus?.(); }
}

/* ── the view ─────────────────────────────────────────────────────────────── */

export default {
    id: 'verdict',
    title: 'Verdict',

    mount(el, ctx) {
        this.el = el;
        this.ctx = ctx;
        this.token = 0;
        this.v = null;
        this.V = null;
        this.showAllOptions = false;
        injectStyle(ctx.ui.h);
        this.offs = [
            ctx.data.on('dataset', () => this.render()),
            ctx.data.on('settings', () => this.render()),
            ctx.data.on('status', () => this.render()),
            // the user's own prices from Compare are verdict inputs (DataHub sends them as
            // opts.overrides): a change re-runs it — a hidden tab catches up when shown
            ctx.data.on('overrides', () => { if (this.v) this.render(); }),
        ];
        const mm = q => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : null);
        this.mq = mm('(max-width: 600px)');
        this.mqMid = mm('(max-width: 1023px)');
        this.onMq = () => {
            if (this.v) this.arrange();
            if (this.v && this.V) {
                if (stageIdx(this.V.stage) >= stageIdx('plugin')) { this.fillOptions(this.V); this.fillBest(this.V); }
                this.fillQuestions(this.V, true);
            }
            if (this.v) this.syncFolds();
        };
        this.onMqMid = () => { if (this.v) this.arrange(); };
        this.mq?.addEventListener?.('change', this.onMq);
        this.mqMid?.addEventListener?.('change', this.onMqMid);
        this.render();
    },

    show(params) {
        this.params = params || {};
        if (this.needsRun) this.render();
    },

    hide() {},

    unmount() {
        this.offs?.forEach(off => off());
        this.mq?.removeEventListener?.('change', this.onMq);
        this.mqMid?.removeEventListener?.('change', this.onMqMid);
        this.teardown();
    },

    teardown() {
        if (!this.v) return;
        for (const c of Object.values(this.v.charts)) c?.destroy();
        this.v = null;
        this.V = null;
    },

    get isPhone() { return !!this.mq?.matches; },
    /** 'wide' (≥ 1024 px, two columns), 'mid' (601–1023 px, one column) or 'phone' (≤ 600 px). */
    get layout() { return this.isPhone ? 'phone' : this.mqMid?.matches ? 'mid' : 'wide'; },

    /* ── state machine ──────────────────────────────────────────────────── */

    render() {
        const { ui, data } = this.ctx;
        // The connect card shows its own progress and errors: leave it alone until data arrives.
        if (!data.summary() && this.el.querySelector('.connect-card')) return;
        const summary = data.summary();
        if (data.status() === 'loading') {
            if (this.v) this.markStale(true);
            else this.el.replaceChildren(this.skeletonPage());
            return;
        }
        if (!summary) {
            this.teardown();
            this.el.replaceChildren(ui.connectCard(this.ctx));
            return;
        }
        if (!this.v) this.build();
        this.fillHead(summary);
        if (summary.engineUnavailable) {
            this.showError(new Error('Your data is loaded, but the simulation engine isn’t available in this browser. Your usage is still on the Usage tab.'), { retry: false });
            return;
        }
        // A hidden tab doesn't need the worker's time: catch up when it is shown again.
        if (this.el.hidden) { this.needsRun = true; this.markStale(true); return; }
        this.run(summary);
    },

    run(summary) {
        const { data } = this.ctx;
        const token = ++this.token;
        this.needsRun = false;
        this.v.fresh = new Set();
        this.v.running = true;
        this.fillPrintLine();
        this.markStale(true);
        this.v.parts.error.hidden = true;
        this.setStages(-1, false);
        data.insights().then(ins => {
            if (token !== this.token || data.summary()?.id !== summary.id) return;
            this.fillTiles(ins);
            this.fillBanner(ins);
        }).catch(err => {
            if (err?.name === 'AbortError' || token !== this.token) return;
            this.v.parts.tiles.replaceChildren(this.ctx.ui.h('div', { class: 'notice notice-bad' }, this.ctx.ui.icon('alert'), this.ctx.ui.h('span', null, `Couldn’t read your usage: ${err?.message || err}`)));
        });
        const onPartial = (stage, v) => {
            if (token !== this.token || data.summary()?.id !== summary.id || !v) return;
            this.apply(v);
        };
        data.verdict({ onPartial }).then(v => {
            if (token !== this.token || data.summary()?.id !== summary.id) return;
            this.apply(v);
        }).catch(err => {
            if (err?.name === 'AbortError' || token !== this.token) return;
            this.showError(err);
        });
    },

    /** Dim every block that already shows figures (they stay until their stage refreshes them). */
    markStale(on) {
        if (!this.v) return;
        for (const [key, el] of Object.entries(this.v.blocks)) {
            const stale = on && this.v.filled.has(key) && !this.v.fresh?.has(key);
            el.classList.toggle('is-stale', !!stale);
            if (stale) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
        }
    },

    fresh(key) {
        this.v.filled.add(key);
        this.v.fresh.add(key);
        const el = this.v.blocks[key];
        if (el) { el.classList.remove('is-stale'); el.removeAttribute('aria-busy'); }
    },

    /** Apply one streamed (or the final) verdict. */
    apply(V) {
        if (!this.v) return;
        // the last partial and the resolved promise carry the same finished verdict: draw it once
        // (a second rebuild would also drop keyboard focus inside the questions)
        if (V?.done && this.v.doneToken === this.token) return;
        if (V?.done) { this.v.doneToken = this.token; this.v.running = false; }
        this.V = V;
        const si = stageIdx(V.stage);
        try {
            this.setStages(si, !!V.done);
            this.fillPrintLine();
            if (si >= stageIdx('plugin')) { this.fillBest(V); this.fresh('best'); }
            // first run: show the solar rows straight away; a re-run keeps the old table until every row is back
            if (si >= stageIdx('all') || (si >= stageIdx('plugin') && !this.v.filled.has('options'))) { this.fillOptions(V); if (si >= stageIdx('all')) this.fresh('options'); else this.v.filled.add('options'); }
            if (si >= stageIdx('all')) { this.fillScatter(V); this.fresh('scatter'); }
            this.fillQuestions(V);
            if (V.done) {
                this.fresh('assume');
                this.fillAssumptions(V);
                this.v.parts.live.textContent = `Verdict ready. ${plainText(V.headline?.title)}`;
            } else if (si === stageIdx('plugin')) {
                this.v.parts.live.textContent = `${plainText(V.headline?.title)} Still checking batteries, power stations and the weather range.`;
            }
        } catch (err) {
            console.error('verdict view failed to render', err);
            this.showError(err);
        }
    },

    showError(err, { retry = true } = {}) {
        const { ui } = this.ctx;
        const h = ui.h;
        if (!this.v) this.build();
        const host = this.v.parts.error;
        // figures from an earlier run stay on screen, dimmed: say they are out of date
        const old = [...this.v.filled].some(k => k !== 'tiles');
        host.replaceChildren(ui.card({ body: h('div', { class: 'vd-error' },
            h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'), h('span', null, `Couldn’t work out the verdict: ${err?.message || err}`,
                old ? ' The dimmed figures below are from before your last change.' : '')),
            h('div', { class: 'row' },
                retry ? ui.button({ label: 'Try again', icon: 'refresh', onClick: () => { this.v.parts.error.hidden = true; this.render(); } }) : null,
                ui.button({ label: 'Check your data', kind: 'ghost', href: '#data', icon: 'arrowRight' }))) }));
        host.hidden = false;
        this.v.running = false;
        this.fillPrintLine();
        this.setStages(-1, false, true);
        this.v.parts.live.textContent = `Couldn’t work out the verdict: ${err?.message || err}`;
    },

    /* ── skeleton & build ───────────────────────────────────────────────── */

    skeletonPage() {
        const { ui } = this.ctx;
        const h = ui.h;
        const tiles = h('div', { class: 'tiles' }, ['Always-on load', 'It costs', 'Your electricity'].map(label => ui.statTile({ label, loading: true })));
        const best = ui.card({ accent: true, body: ui.skeleton({ lines: 6 }) });
        const options = ui.card({ title: 'Every option, ranked', body: ui.skeleton({ height: 360 }) });
        // the same order as the page it stands in for (arrange())
        const layout = this.layout;
        const grid = layout === 'wide'
            ? h('div', { class: 'vd-grid' }, h('div', { class: 'vd-col' }, tiles, best), h('div', { class: 'vd-col' }, options))
            : h('div', { class: 'vd-grid' }, layout === 'phone' ? [best, options, tiles] : [tiles, best, options]);
        return h('div', { class: 'vd', 'aria-busy': 'true' },
            h('div', { class: 'view-head' }, h('div', { class: 'vd-head-main' },
                h('div', { class: 'view-kicker' }, 'Verdict'), h('h1', { class: 'view-title' }, 'What to buy, and why'), ui.skeleton({ lines: 1 }))),
            grid);
    },

    build() {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = {};
        p.kicker = h('div', { class: 'view-kicker' }, 'Verdict');
        p.title = h('h1', { class: 'view-title', tabindex: '-1' }, 'What to buy, and why');
        p.context = h('div', { class: 'vd-context' });
        p.print = h('div', { class: 'vd-print-only context-line' });
        p.toolbar = h('div', { class: 'vd-toolbar' });
        p.demo = h('div', { class: 'vd-demo', hidden: true });
        p.stages = h('div', { class: 'vd-stage-host' });
        p.toolbar.append(p.demo, p.stages);
        p.banner = h('div', { hidden: true });
        p.error = h('div', { hidden: true });
        p.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
        const pdf = ui.button({ label: 'Save as PDF', icon: 'print', kind: 'ghost', size: 'sm', onClick: () => window.print() });

        p.tiles = h('div', { class: 'tiles' }, ['Always-on load', 'It costs', 'Your electricity, last 12 months'].map(label => ui.statTile({ label, loading: true })));
        p.best = h('div', { class: 'vd-best-body' }, ui.skeleton({ lines: 7 }));
        const bestCard = ui.card({ accent: true, className: 'vd-best', body: p.best });
        p.optBody = h('div', null, ui.skeleton({ height: 320 }));
        p.optSub = h('span', null, 'Every option on your data, best 10-year value first.');
        const optCard = ui.card({ eyebrow: 'All the options', title: 'Every option, ranked', subtitle: p.optSub, className: 'vd-opt', body: p.optBody });
        p.scatterHost = h('div');
        p.scatterFold = ui.details({ summary: 'Show chart', body: p.scatterHost, open: true, className: 'vd-chart-fold' });
        const scatterCard = ui.card({ title: 'Cost vs yearly saving', subtitle: 'Each dot is an option: further up saves more, further left costs less. Dashed lines show simple payback; whiskers the 2006–2025 weather range.',
            body: p.scatterFold });
        p.questions = {};
        const qItems = QUESTIONS.map((q, i) => {
            const answer = h('span', { class: 'vd-q-answer' }, h('span', { class: 'vd-q-pending' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Working it out…'));
            const text = h('div', { class: 'vd-rich' });
            const extra = h('div');
            const chart = h('div');
            const link = h('div', { class: 'vd-q-link' });
            const body = h('div', { class: 'vd-q-body' }, text, extra, chart, link);
            const d = ui.details({
                summary: h('span', { class: 'vd-q' }, h('span', { class: 'vd-q-idx', 'aria-hidden': 'true' }, `Q${i + 1}`), h('span', { class: 'vd-q-title' }, q.q), answer),
                body, className: 'vd-qd',
            });
            p.questions[q.key] = { d, answer, text, extra, chart, link };
            return d;
        });
        const qCard = ui.card({ eyebrow: 'Your questions', title: 'The things you asked', subtitle: 'Each answer is worked out on your own half-hours. Open one for the reasoning.', className: 'vd-qs', body: qItems });
        p.assume = h('div', { class: 'vd-assume' }, ui.skeleton({ lines: 3 }));
        const assumeFold = ui.details({ summary: 'Assumptions behind every figure', body: p.assume, className: 'vd-assume-fold' });

        const blocks = {
            tiles: h('div', { class: 'vd-block vd-b-tiles' }, p.tiles),
            best: h('div', { class: 'vd-block vd-b-best' }, bestCard),
            options: h('div', { class: 'vd-block vd-b-options' }, optCard),
            scatter: h('div', { class: 'vd-block vd-b-scatter' }, scatterCard),
            questions: h('div', { class: 'vd-block vd-b-questions' }, qCard),
            assume: h('div', { class: 'vd-block vd-b-assume' }, ui.card({ body: assumeFold })),
        };
        const qBlocks = Object.fromEntries(QUESTIONS.map(q => [`q:${q.key}`, p.questions[q.key].d]));
        const grid = h('div', { class: 'vd-grid' });
        const cols = [h('div', { class: 'vd-col' }), h('div', { class: 'vd-col' })];
        const root = h('div', { class: 'vd' },
            h('div', { class: 'view-head' },
                h('div', { class: 'vd-head-main' }, p.kicker, p.title, p.context, p.print),
                h('div', { class: 'vd-head-actions' }, pdf)),
            p.toolbar, p.banner, p.error, p.live, grid);
        this.v = { root, parts: p, blocks: { ...blocks, ...qBlocks }, layoutBlocks: blocks, grid, cols, layout: null, charts: {}, filled: new Set(), fresh: new Set() };
        this.arrange();
        this.el.replaceChildren(root);
        this.syncFolds();
    },

    /**
     * Put the blocks in the DOM in the order they are seen, so screen-reader and Tab order follow
     * the screen (WCAG 1.3.2 / 2.4.3) — never CSS `order`. ≥ 1024 px: two columns (tiles and best
     * buy | questions and chart), then the options and assumptions across both; 601–1023 px: tiles,
     * best buy, options, questions, chart; phones: best buy, options, questions, tiles, chart
     * (critique mobile order). Keeps keyboard focus on whatever it was on.
     */
    arrange() {
        const v = this.v;
        if (!v) return;
        const layout = this.layout;
        if (v.layout === layout) return;
        v.layout = layout;
        const b = v.layoutBlocks;
        const [c1, c2] = v.cols;
        const doc = v.grid.ownerDocument || (typeof document !== 'undefined' ? document : null);
        const had = doc?.activeElement && doc.activeElement !== doc.body && v.grid.contains(doc.activeElement) ? doc.activeElement : null;
        if (layout === 'wide') {
            c1.append(b.tiles, b.best);
            c2.append(b.questions, b.scatter);
            v.grid.append(c1, c2, b.options, b.assume);
        } else {
            c1.remove();
            c2.remove();
            v.grid.append(...(layout === 'phone'
                ? [b.best, b.options, b.questions, b.tiles, b.scatter, b.assume]
                : [b.tiles, b.best, b.options, b.questions, b.scatter, b.assume]));
        }
        // moving a node drops its focus: put it back
        if (had && had.isConnected && doc.activeElement !== had) {
            try { had.focus({ preventScroll: true }); } catch { had.focus?.(); }
        }
    },

    /** Phones fold the cost/saving chart away (critique: 'Show chart'); wider screens show it. */
    syncFolds() {
        if (!this.v) return;
        const f = this.v.parts.scatterFold;
        const want = !this.isPhone;
        if (this.v.foldPhone !== this.isPhone) { f.open = want; this.v.foldPhone = this.isPhone; }
    },

    /** Per-device table-twin preferences, in the store's open-ended ui.chartTables map. */
    pref(key) { return !!this.ctx.store.get().ui?.chartTables?.[`verdict.${key}`]; },
    setPref(key, on) {
        if (this.pref(key) === !!on) return;
        this.ctx.store.set({ ui: { chartTables: { [`verdict.${key}`]: !!on } } });
    },

    /**
     * Create or update a chart. Every chart here sits under a heading of its own, so specs pass
     * `tableCaption` (it names the table twin and its toggle, "Table: …") rather than a visible title.
     */
    chart(key, create, host, spec) {
        const full = { ...spec, table: this.pref(`table.${key}`), onTable: on => this.setPref(`table.${key}`, on) };
        const c = this.v.charts[key];
        if (c) c.update(full);
        else this.v.charts[key] = create(host, full);
    },

    /* ── head ───────────────────────────────────────────────────────────── */

    fillHead(summary) {
        const { ui, fmt, store } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const days = Math.round(summary.days || 0);
        const where = summary.postcode || summary.regionName || (summary.region ? `region ${summary.region}` : 'your home');
        const pb = store.get().settings.projectBaseW;
        // no 20-year sunshine record → the engine's "typical" year is the last 12 months
        const typical = summary.weatherBasis ? !!summary.weatherBasis.hasClimatology : true;
        const long = h('span', { class: 'vd-ctx-long' },
            h('b', null, `${fmt.num(days)} days`), ` of your half-hourly use (${isoDay(fmt, summary.from)} – ${isoDay(fmt, summary.to)})`,
            summary.tariffCode ? [' · ', h('b', null, summary.tariffCode)] : null,
            typical ? ` · typical-year sunshine for ${where}` : ` · your last 12 months’ sunshine at ${where}`,
            finite(pb) ? [' · ', h('b', null, `projected with ${fmt.num(pb)} W always-on`)] : null);
        const short = h('span', { class: 'vd-ctx-short' },
            h('b', null, `${fmt.num(days)} days`), ` · ${/AGILE/i.test(summary.tariffCode || '') ? 'Agile' : summary.tariffCode || 'your tariff'} · ${where} · ${typical ? 'typical-year sun' : 'last year’s sun'}`,
            finite(pb) ? ` · ${fmt.num(pb)} W projected` : null);
        const real = summary.coverage?.realPct;
        // the shared real-data chip (amber below 95%; on phones only then, where room is short)
        ui.put(p.context, h('p', { class: 'context-line' }, long, short), ui.coverageChip(summary.coverage));
        this.v.realPct = real;
        this.fillPrintLine();
        this.fillDemo(summary);
    },

    /** Paper has no chip or tooltips: coverage, the catalog price date and the print date in one line. */
    fillPrintLine() {
        const { fmt } = this.ctx;
        const real = this.v.realPct;
        const checked = this.V?.context?.pricesChecked;
        this.v.parts.print.textContent = [
            finite(real) ? `${fmt.pct(real, { dp: real >= 99.95 || real < 10 ? 0 : 1 })} real half-hourly readings` : null,
            checked ? `product prices checked ${isoDay(fmt, checked)}` : null,
            `printed ${fmt.date(Date.now())}`,
            // paper has no spinners: say so when it was printed mid-run
            this.v.running ? 'printed before every answer was worked out' : null,
        ].filter(Boolean).join(' · ');
    },

    /** Example data only: the servers' size is the demo's one input, so let it be moved here. */
    fillDemo(summary) {
        const { ui, fmt, data, store } = this.ctx;
        const h = ui.h;
        const host = this.v.parts.demo;
        if (summary.source !== 'demo') { host.hidden = true; host.replaceChildren(); this.v.demoSlider = null; return; }
        const w = summary.serverW ?? store.get().connection.demoServerW ?? 500;
        host.hidden = false;
        if (this.v.demoSlider) { if (!this.v.demoDragging) this.v.demoSlider.setValue(w); return; }
        const slider = ui.slider({
            value: w, min: DEMO_W.min, max: DEMO_W.max, step: DEMO_W.step, format: v => `${fmt.num(v)} W`, ariaLabel: 'Server load in the example data',
            onInput: () => { this.v.demoDragging = true; },
            onChange: v => {
                // arrow keys fire a change per step: wait for the user to settle before reloading
                clearTimeout(this.v.demoTimer);
                this.v.demoTimer = setTimeout(() => {
                    this.v.demoDragging = false;
                    if (v === (data.summary()?.serverW ?? null)) return;
                    data.load({ kind: 'demo', serverW: v }, { navigate: false }).catch(err => {
                        if (err?.name === 'AbortError') return;
                        ui.toast(`Couldn’t reload the example: ${err?.message || err}`, { tone: 'bad' });
                    });
                }, 450);
            },
        });
        const label = h('span', { class: 'vd-demo-label', id: ui.uniqueId('vd-demo') }, 'Server load');
        slider.input.setAttribute('aria-describedby', label.id);
        host.replaceChildren(label, slider);
        this.v.demoSlider = slider;
    },

    setStages(si, done, failed = false) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const host = this.v.parts.stages;
        if (failed) { host.replaceChildren(); return; }
        const V = this.V;
        const info = done && V ? `${fmt.num(V.context?.options ?? V.ranked.length)} options checked against your ${fmt.num(Math.round(V.context?.days ?? 0))} days` : '';
        host.replaceChildren(vdStages(h, ui, si, done, info));
    },

    /** Drift / projection banner (UX critique base-load amendment). */
    fillBanner(ins) {
        const { ui, fmt, store } = this.ctx;
        const h = ui.h;
        const host = this.v.parts.banner;
        const bl = ins?.baseLoad ?? {};
        const pb = store.get().settings.projectBaseW;
        const setPb = w => { store.set({ settings: { projectBaseW: w } }); };
        if (finite(pb)) {
            host.replaceChildren(h('div', { class: 'notice vd-banner', role: 'status' }, ui.icon('info'),
                h('div', { class: 'vd-banner-text' }, 'Every figure is projected with ', h('b', null, `${fmt.num(pb)} W`), ' of always-on load — your data shows ', h('b', null, `${fmt.num(bl.w)} W`), ' over the year.'),
                ui.button({ label: `Use the measured ${fmt.num(bl.w)} W`, size: 'sm', kind: 'ghost', onClick: () => setPb(null) })));
            host.hidden = false;
            return;
        }
        if (finite(bl.driftPct) && Math.abs(bl.driftPct) >= 15 && finite(bl.recentW)) {
            const r = Math.round(bl.recentW);
            host.replaceChildren(h('div', { class: 'notice notice-warn vd-banner', role: 'status' }, ui.icon('alert'),
                h('div', { class: 'vd-banner-text' }, 'Your always-on load changed: ', h('b', null, `${fmt.num(bl.w)} W`), ' over the year, ', h('b', null, `${fmt.num(r)} W`), ' in the last 2 months.'),
                ui.button({ label: `Use today’s ${fmt.num(r)} W for the forecast`, size: 'sm', onClick: () => setPb(r) })));
            host.hidden = false;
            return;
        }
        host.hidden = true;
        host.replaceChildren();
    },

    /* ── 1 tiles ────────────────────────────────────────────────────────── */

    fillTiles(ins) {
        const { ui, fmt } = this.ctx;
        const bl = ins.baseLoad ?? {};
        const t = ins.totals ?? {};
        this.v.parts.tiles.replaceChildren(
            ui.statTile({ label: 'Always-on load', value: fmt.num(bl.w), unit: 'W', sub: `${fmt.num(bl.kwhYr)} kWh/yr · ${fmt.pct(bl.sharePct)} of your use` }),
            ui.statTile({ label: 'It costs', value: fmt.gbp(bl.costBilledGbpYr), unit: 'a year', sub: `${fmt.gbp(bl.costPeakGbpYr)} of it 4–7pm · ${fmt.gbp(bl.gbpPer100W)} per 100 W`,
                help: 'Your always-on load priced at what you actually paid over the last 12 months, VAT included. What switching load off saves from now on (at next year’s prices) is under ‘How much does my always-on load matter?’.' }),
            ui.statTile({ label: 'Your electricity, last 12 months', value: fmt.gbp(t.energyGbp), sub: `+ ${fmt.gbp(t.standingGbp)} standing charges` }));
        this.fresh('tiles');
    },

    /* ── 2 best buy ─────────────────────────────────────────────────────── */

    /**
     * The best-buy card. Streamed stages redraw it only when something on it changed (a signature
     * of what it shows), and a redraw keeps keyboard focus on the rebuilt twin of the control it
     * was on (holdFocus, [data-fk]) — a reader who starts on the card as soon as it appears isn't
     * thrown back to the top of the page by a later stage.
     */
    fillBest(V) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const hd = V.headline;
        const host = this.v.parts.best;
        if (!hd) return;
        const shown = hd.kind === 'buy' ? V.ranked.find(r => r.id === V.bestBuyId) : hd.closestId ? V.ranked.find(r => r.id === hd.closestId) : null;
        if (hd.kind === 'buy' && !shown) return;
        const sig = JSON.stringify([hd, shown, V.runnerUpId, V.stepUp?.id ?? null, V.context?.weatherNote ?? null, V.context?.maxPaybackYears ?? null, this.isPhone]);
        if (sig === this.v.bestSig && host.firstChild) return;
        this.v.bestSig = sig;
        // the card's heading takes focus when the control focus was on is gone from the new card
        const title = (...kids) => h('h2', { class: 'vd-best-title', tabindex: '-1' }, ...kids);
        if (hd.kind !== 'buy') {
            const closest = shown;
            const t = title(hd.title);
            holdFocus(host, () => ui.put(host, h('div', { class: 'vd-best-none' },
                h('div', { class: 'vd-best-top' }, h('div', { class: 'card-eyebrow' }, 'The verdict')),
                t,
                h('p', { class: 'vd-lede' }, rich(h, hd.lede)),
                h('div', { class: 'vd-actions' },
                    closest ? fk(ui.button({ label: `See the ${closest.name}`, href: `#design?scenario=${encodeURIComponent(closest.id)}`, icon: 'arrowRight' }), 'best:closest') : null,
                    fk(ui.button({ label: `Change the ${fmt.num(V.context?.maxPaybackYears ?? 10)}-year cut-off`, kind: 'ghost', href: '#method' }), 'best:cutoff')))), t);
            return;
        }
        const best = shown;
        const level = best.confidence ? LEVEL[best.confidence.level] : null;
        const badges = h('div', { class: 'vd-badges' },
            ui.badge({ text: ROUTE_LABEL[best.route] || best.route, tone: best.route }),
            level ? ui.badge({ text: `${level.label} confidence`, tone: level.tone }) : null,
            best.priceOverride ? ui.badge({ text: 'Your price', tone: 'info', title: 'Priced with the figure you set in Compare' }) : null,
            best.preorder || best.availableNow === false ? ui.badge({ text: best.availableNow === false ? 'Not on sale now' : 'Pre-order', tone: 'warn' }) : null);
        const s = best.savings;
        const cell = (k, v, extra) => h('div', null, h('dt', null, k), h('dd', extra || null, v));
        const readout = h('dl', { class: 'vd-readout' },
            cell('Cost', fmt.gbp(best.capexGbp)),
            cell('Saves', [fmt.gbp(s.typical), h('small', null, '/yr')]),
            cell('Payback', finite(best.payback.typical) ? [fmt.num(best.payback.typical, 1), h('small', null, 'yrs')] : 'never'),
            cell('Ahead after 10 yrs', fmt.gbp(best.net10Gbp), { class: best.net10Gbp > 0 ? 'is-good' : null }));
        const points = [hd.why, hd.equivalent].filter(Boolean).map(t => h('li', null, ui.icon(t === hd.equivalent ? 'sun' : 'check'), h('span', { class: 'vd-rich' }, rich(h, t))));
        const steps = (hd.nextSteps ?? []).map((st, i) => h('li', null, h('span', null, st.text,
            st.href ? [' ', fk(h('a', { href: st.href, target: '_blank', rel: 'noopener noreferrer' }, st.label || 'Source', ui.icon('external')), `best:step:${i}:${st.href}`)] : null)));
        const stepsList = h('ol', null, steps);
        const stepsBlock = steps.length
            ? (this.isPhone
                ? h('div', { class: 'vd-steps' }, fk(ui.details({ summary: `Next steps (${steps.length})`, body: stepsList, className: 'vd-steps-fold' }), 'best:fold:steps'))
                : h('div', { class: 'vd-steps' }, h('div', { class: 'vd-steps-title' }, 'Next steps'), stepsList))
            : null;
        const alt = [];
        if (hd.runnerUp && V.runnerUpId) {
            alt.push(h('div', null, h('span', { class: 'vd-rich' }, rich(h, hd.runnerUp)),
                fk(ui.button({ label: 'Details', size: 'sm', kind: 'ghost', href: `#design?scenario=${encodeURIComponent(V.runnerUpId)}`, ariaLabel: 'Details of the runner-up' }), 'best:runner-up')));
        }
        if (hd.stepUp && V.stepUp) {
            alt.push(h('div', null, h('span', { class: 'vd-rich' }, rich(h, hd.stepUp)),
                fk(ui.button({ label: 'Details', size: 'sm', kind: 'ghost', href: `#design?scenario=${encodeURIComponent(V.stepUp.id)}`, ariaLabel: 'Details of the bigger option' }), 'best:step-up')));
        }
        const wx = hd.weatherNote || V.context?.weatherNote
            ? h('p', { class: 'vd-wxnote' }, ui.icon('sun'), h('span', null, [hd.weatherNote, V.context?.weatherNote && !hd.weatherNote ? V.context.weatherNote : null].filter(Boolean).join(' '),
                hd.weatherNote ? ' Every figure here uses a typical year instead.' : ''))
            : null;
        const t = title('Buy the ', h('span', { class: 'vd-name' }, hd.name), '.');
        holdFocus(host, () => ui.put(host,
            h('div', { class: 'vd-best-top' }, h('div', { class: 'card-eyebrow' }, 'The verdict · best buy'), badges),
            t,
            h('p', { class: 'vd-lede' }, rich(h, hd.lede)),
            readout,
            vdRunway(h, fmt, { cashflow: hd.cashflow, payback: best.payback.typical, capex: best.capexGbp }),
            points.length ? h('ul', { class: 'vd-points' }, points) : null,
            stepsBlock,
            h('div', { class: 'vd-actions' },
                fk(ui.button({ label: 'See the details', kind: 'primary', icon: 'arrowRight', href: `#design?scenario=${encodeURIComponent(best.id)}` }), 'best:details'),
                fk(ui.button({ label: 'Compare options', href: '#compare', onClick: null }), 'best:compare')),
            this.isPhone && (alt.length || wx)
                ? h('div', { class: 'vd-steps' }, fk(ui.details({ summary: alt.length ? `Other options${wx ? ' and the weather' : ''}` : 'About the weather', body: [alt.length ? h('div', { class: 'vd-alts' }, alt) : null, wx], className: 'vd-steps-fold' }), 'best:fold:alts'))
                : [alt.length ? h('div', { class: 'vd-alts' }, alt) : null, wx]), t);
    },

    /* ── 3 options ──────────────────────────────────────────────────────── */

    optionCols(maxP90) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        // Phones get card rows: title (with the route as a tag), the saving a year as the card's
        // figure, then cost, payback and the 10-year value the list is ordered by (as Compare's
        // cards); confidence stays on wider screens, in the design view and in print.
        const phone = this.isPhone;
        const name = (v, r) => {
            const tags = [];
            if (phone) tags.push(ui.badge({ text: ROUTE_LABEL[r._row.route] || r._row.route, tone: r._row.route }));
            for (const b of r._row.badges) tags.push(ui.badge({ text: b.label, tone: BADGE_TONE[b.key] || 'default' }));
            if (r._row.priceOverride) tags.push(ui.badge({ text: 'Your price', tone: 'info', title: 'Priced with the figure you set in Compare' }));
            if (r._row.availableNow === false) tags.push(ui.badge({ text: 'Not on sale now', tone: 'warn' }));
            else if (r._row.preorder) tags.push(ui.badge({ text: 'Pre-order', tone: 'warn' }));
            if (r._row.legal === 'check') tags.push(ui.badge({ text: 'Check first', tone: 'warn', title: r._row.warnings.map(w => w.message).join(' ') }));
            const up = r._row.upgrade;
            const later = up && finite(up.costGbp) && up.costGbp > 0
                ? h('span', { class: 'vd-opt-later' }, `then ${fmt.gbp(up.costGbp)} in year ${fmt.num(up.atYear)}${up.label ? ` for ${up.label.replace(/^add(ed)?\s+/i, '')}` : ''}`)
                : null;
            // one table now holds every group: a beaten row names what beats it under its own name
            const beatenBy = r.beatenBy ? h('span', { class: 'vd-opt-later' }, `beaten by ${r.beatenBy}`) : null;
            // a battery or power station that wears out inside the 10 years says so: it is why
            // a quick payback can still leave a small (or no) 10-yr value
            const end = r._row.battery && finite(r._row.batteryEndYear) && r._row.batteryEndYear < 10 ? r._row.batteryEndYear : null;
            const wears = end == null ? null : r._row.batteryReplaced
                ? h('span', { class: 'vd-opt-later' }, `battery bought again after year ${fmt.num(end)}`)
                : h('span', { class: 'vd-opt-later', title: 'Its savings stop then; the 10-yr value counts that.' }, `wears out in year ${fmt.num(end)}`);
            return h('span', { class: 'vd-opt-name' }, h('span', null, v), later, beatenBy, wears, tags.length ? h('span', { class: 'vd-opt-badges' }, tags) : null);
        };
        const sav = (v, r) => {
            const s = r._row.savings;
            const hasBand = finite(s.p10) && finite(s.p90) && Math.abs(s.p90 - s.p10) > 0.5;
            // on a phone card the saving stands alone, top right, beside the cost: say what it is
            return h('span', { class: 'vd-sav', title: hasBand ? `${fmt.gbp(s.p10)}–${fmt.gbp(s.p90)} across 2006–2025 weather` : null },
                h('span', null, phone ? h('span', { class: 'sr-only' }, 'Saves ') : null, fmt.gbp(v), phone ? h('small', null, '/yr') : null),
                hasBand ? vdRange(h, { lo: s.p10, mid: s.typical, hi: s.p90, max: maxP90 }) : null,
                hasBand ? h('span', { class: 'sr-only' }, ` (${fmt.gbp(s.p10)} to ${fmt.gbp(s.p90)} depending on the weather)`) : null);
        };
        const pay = (v, r) => {
            if (r._row.route === 'reference') return r._row.savings.typical > 0 ? h('span', { class: 'vd-free' }, 'free') : '—';
            return finite(v) ? fmt.years(v) : h('span', { class: 'muted' }, 'never');
        };
        const ahead = (v, r) => (r._row.route === 'reference' && !(r._row.savings.typical > 0) ? '—' : h('span', { class: v < 0 ? 'vd-neg' : null }, fmt.gbp(v)));
        const conf = (v, r) => {
            const c = r._row.confidence;
            if (r._row.route === 'reference') return '—';
            if (!c) return h('span', { class: 'muted', title: 'Waiting for the weather range' }, '…');
            const l = LEVEL[c.level];
            return ui.badge({ text: l.label, tone: l.tone, title: [...c.reasons, ...c.notes].join('; ') || 'Good data, settled weather, a well-understood setup' });
        };
        const disc = fmt.pct(100 * (this.V?.context?.finance?.discountRate ?? 0.04));
        return [
            { key: 'name', label: 'Option', format: name, sortable: false, mobile: 'title' },
            { key: 'route', label: 'Route', format: v => ui.badge({ text: ROUTE_LABEL[v] || v, tone: v }), sortable: false, mobile: 'hide' },
            { key: 'capex', label: 'Cost', align: 'right', format: v => fmt.gbp(v), sortable: false },
            { key: 'sav', label: 'Saves/yr', align: 'right', format: sav, sortable: false, mobile: 'primary' },
            { key: 'payback', label: 'Payback', align: 'right', format: pay, sortable: false },
            { key: 'npv10', label: '10-yr value', align: 'right', format: ahead, sortable: false, mobile: 'show',
                help: `What you’re ahead after 10 years once it has paid for itself, in today’s money (later savings count ${disc} a year less). The list is in this order.` },
            { key: 'conf', label: 'Confidence', format: conf, sortable: false, mobile: 'hide',
                help: 'How sure the saving is: your data, the spread of 20 years of weather, and how well the model knows this kind of setup.' },
        ];
    },

    /** Tag each body row with its option id (data-id), so keyboard focus can find its row again after a refresh. */
    tagRows(wrap, groups) {
        for (const g of groups) {
            const body = wrap.querySelector(`tbody[data-group="${g.key}"]`);
            if (!body) continue;
            const trs = [...body.querySelectorAll('tr')].filter(tr => !tr.classList.contains('tbl-group-head'));
            trs.forEach((tr, i) => { if (g.rows[i]) tr.dataset.id = g.rows[i].id; });
        }
    },

    rowsFor(list) {
        const byId = new Map(this.V.ranked.map(r => [r.id, r]));
        return list.map(r => ({ id: r.id, name: r.name, route: r.route, capex: r.capexGbp, sav: r.savings.typical, payback: r.payback.typical,
            npv10: r.npv10Gbp, conf: r.confidence?.level ?? null, beatenBy: r.dominatedBy ? byId.get(r.dominatedBy)?.name ?? r.dominatedBy : null, _row: r }));
    },

    fillOptions(V) {
        const { ui, fmt, router } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const ranked = V.ranked ?? [];
        const phone = this.isPhone;
        // one table, grouped: the options, the yardsticks under a divider, those beaten on both
        // price and savings (folded) and the future-rules plans (folded on phones)
        const og = optionGroups(V, { phone, showAll: this.showAllOptions, beatenOpen: !!this.v.beatenOpen, plansOpen: !!this.v.plansOpen });
        const main = og.main;
        const maxP90 = Math.max(1, ...ranked.map(r => (finite(r.savings.p90) ? r.savings.p90 : r.savings.typical)).filter(finite));
        const open = r => router.go('design', { scenario: r.id });
        const rowClass = r => [r.id === V.bestBuyId && 'is-highlight', r._row.route === 'reference' && 'vd-ref'].filter(Boolean).join(' ') || null;
        // keep keyboard focus across a streamed refresh of the table (rows are rebuilt)
        const focusedId = p.optBody.contains(document.activeElement) ? document.activeElement.closest('tr')?.dataset.id ?? null : null;
        const kids = [];
        const bestRow = main.find(r => r.id === V.bestBuyId) ?? null;
        const bestAt = main.findIndex(r => r.id === V.bestBuyId);
        if (bestAt > 0) {
            const above = main.slice(0, bestAt);
            const storage = above.filter(r => r.battery);
            const why = storage.length === above.length
                ? `${above.length === 1 ? 'The option' : `The ${above.length} options`} above the best buy all add a battery or a power station`
                : `${above.length} option${above.length === 1 ? '' : 's'} rank above the best buy`;
            const toBattery = () => {
                const q = this.v.parts.questions.battery.d;
                q.open = true;
                q.scrollIntoView({ behavior: 'smooth', block: 'center' });
                q.querySelector('summary')?.focus({ preventScroll: true });
            };
            kids.push(h('p', { class: 'vd-sub-note vd-rank-note' }, ui.icon('info'), h('span', null,
                `${why} — they earn more over 10 years but cost far more up front. `,
                h('button', { type: 'button', class: 'vd-inline-link', on: { click: toBattery } }, 'Is the extra worth it?'))));
        }
        // The user's own prices from Compare are in these figures (DataHub sends them to the verdict).
        const own = ranked.filter(r => r.priceOverride);
        if (own.length) {
            kids.push(h('div', { class: 'notice vd-override', role: 'note' }, ui.icon('info'), h('span', null,
                `${own.length === 1 ? own[0].name : `${own.length} options`} ${own.length === 1 ? 'is' : 'are'} priced with your own figure${own.length === 1 ? '' : 's'} from Compare, and the ranking uses ${own.length === 1 ? 'it' : 'them'}. `,
                h('a', { href: '#compare' }, 'Change it in Compare'))));
        }
        const disc = fmt.pct(100 * (V.context?.finance?.discountRate ?? 0.04));
        const plain = bestRow ? ` In plain pounds the best buy is ${fmt.gbp(bestRow.net10Gbp)} ahead, as on its card.` : '';
        const note = [h('b', null, '10-yr value'), `: what you’re ahead after 10 years once it has paid for itself, in today’s money (later savings count ${disc} a year less) — the order of this list.`, plain];
        const groups = og.groups.map(g => ({ ...g, rows: this.rowsFor(g.rows) }));
        const tbl = ui.table({
            columns: this.optionCols(maxP90), groups, rowClass, onRowClick: open, dense: true, note: h('span', null, note),
            caption: 'Every option, ranked by 10-year value',
            onToggle: (key, isOpen) => {
                if (key === 'beaten') this.v.beatenOpen = isOpen;
                else if (key === 'plans') this.v.plansOpen = isOpen;
                else if (key === 'more') this.showAllOptions = isOpen;
                this.tagRows(tbl, groups);
            },
        });
        this.tagRows(tbl, groups);
        kids.push(tbl);
        if (stageIdx(V.stage) < stageIdx('all')) {
            kids.push(h('div', { class: 'vd-pending-row', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking batteries, power stations and future-rules plans…'));
        }
        if (V.excluded?.length) {
            kids.push(h('div', { class: 'notice notice-warn', style: { marginTop: '14px' } }, ui.icon('alert'),
                h('span', null, `Left out because they break today’s rules: ${V.excluded.map(x => x.name).join(', ')}.`)));
        }
        p.optBody.replaceChildren(...kids);
        if (focusedId) {
            const tr = [...p.optBody.querySelectorAll('tbody tr')].find(x => x.dataset.id === focusedId);
            tr?.focus({ preventScroll: true });
        }
        const f = V.context?.finance;
        p.optSub.textContent = f
            ? `Your last ${fmt.num(Math.round(V.context.days))} days, typical-year sunshine, ${fmt.pct(100 * f.escalation)} price rise a year, ${fmt.pct(100 * f.discountRate)} discount rate. Open any option for its details.`
            : 'Every option on your data, best 10-year value first.';
    },

    /* ── 4 scatter ──────────────────────────────────────────────────────── */

    fillScatter(V) {
        const { charts, fmt, router } = this.ctx;
        const sc = V.scatter;
        if (!sc) return;
        const byId = new Map(V.ranked.map(r => [r.id, r]));
        const points = sc.points.map(pt => {
            const r = byId.get(pt.id);
            // the yardstick sits on the y axis next to the best buy: a short label fits there
            const short = pt.route === 'reference' ? /^(Cut \d[\d,]* W)\b/.exec(pt.label)?.[1] : null;
            return {
                ...pt, label: short || pt.label,
                extra: [
                    finite(r?.payback.typical) ? { value: fmt.years(r.payback.typical), label: 'payback' } : null,
                    r?.dominatedBy ? { value: 'beaten', label: `by ${byId.get(r.dominatedBy)?.name ?? ''}` } : null,
                ].filter(Boolean),
                note: pt.emphasis ? 'Best buy' : null,
            };
        });
        this.chart('scatter', charts.createScatter, this.v.parts.scatterHost, {
            tableCaption: 'Cost vs yearly saving', ariaLabel: 'Scatter of every option: upfront cost against first-year saving',
            points,
            x: { label: 'upfront cost', format: v => fmt.gbp(v, { compact: true }) },
            y: { label: 'saves in year 1 (£)', format: v => fmt.gbp(v) },
            whiskerLabel: '2006–2025 weather',
            isolines: sc.isolines.map(i => ({ points: i.points, label: i.label })),
            front: sc.front,
            onPick: pt => router.go('design', { scenario: pt.id }),
            printTable: false,   // the ranked tables below carry the same numbers on paper
            note: 'Dashed lines: what an option must save to pay back in that many years (cost ÷ years, before price rises). The pale line joins the options nothing beats on both price and savings. Click a dot to open it.',
        });
    },

    /* ── 5 questions ────────────────────────────────────────────────────── */

    /** @param {boolean} [redraw] true = a layout change redrawing what is on screen (stale stays stale) */
    fillQuestions(V, redraw = false) {
        for (const q of QUESTIONS) {
            const a = V.answers?.[q.key];
            const slot = this.v.parts.questions[q.key];
            if (!a) continue;
            if (a.status === 'pending') continue;
            try {
                this.fillQuestion(q.key, a, V, slot);
            } catch (err) {
                console.error(`verdict question ${q.key} failed to render`, err);
            }
            if (!redraw) this.fresh(`q:${q.key}`);
        }
    },

    /**
     * Redraw one part of a question (its one-line answer, reasoning, extra figures or links) only
     * when what it shows changed, keeping focus on a rebuilt link — later stages re-send every
     * answer, and a reader inside an open question shouldn't lose their place each time.
     * @param {HTMLElement} el
     * @param {string} sig what the part shows
     * @param {() => any[]} make its new children
     * @param {HTMLElement|null} [fallback] focus target when the focused link is gone
     */
    putPart(el, sig, make, fallback = null) {
        if (el.vdSig === sig) return;
        el.vdSig = sig;
        holdFocus(el, () => el.replaceChildren(...make().filter(k => k != null)), fallback);
    },

    fillQuestion(key, a, V, slot) {
        const { ui, fmt, charts } = this.ctx;
        const h = ui.h;
        const summaryEl = slot.d.querySelector('summary');
        if (a.status === 'error') {
            this.putPart(slot.answer, 'error', () => [h('span', { class: 'muted' }, 'Couldn’t work this one out.')]);
            this.putPart(slot.text, `error:${a.message}`, () => [h('p', null, a.message || 'Something went wrong.')]);
            return;
        }
        this.putPart(slot.answer, `a:${a.summary}`, () => rich(h, a.summary || '—'));
        this.putPart(slot.text, JSON.stringify(a.body ?? []), () => (key === 'growth'
            ? [h('ul', null, (a.body ?? []).map(t => h('li', null, rich(h, t))))]
            : (a.body ?? []).map(t => h('p', null, rich(h, t)))));
        const enc = encodeURIComponent;
        // the links under an answer, keyed on their target so focus finds them after a redraw
        const links = (...pairs) => this.putPart(slot.link, JSON.stringify(pairs),
            () => pairs.map(([label, href]) => fk(ui.button({ label, kind: 'link', size: 'sm', icon: 'arrowRight', href }), `q:${key}:${href}`)), summaryEl);
        if (a.status === 'none') {
            this.putPart(slot.extra, 'none', () => []);
            links();
            return;
        }
        switch (key) {
            case 'orientation': {
                this.chart('orient', charts.createScatter, slot.chart, this.orientationSpec(a));
                links(['Explore every direction', `#orientation?scenario=${enc(a.forId)}`]);
                break;
            }
            case 'battery': {
                const s = a.split;
                this.putPart(slot.extra, 'none', () => []);
                this.chart('battery', charts.createBars, slot.chart, {
                    tableCaption: 'What the battery adds, £ a year', ariaLabel: 'Battery value split into cheap-slot charging, stored solar and standby, with its total realistic and with perfect timing',
                    categories: ['Cheap-slot charging', 'Storing your solar', 'Standby power', 'Battery in total', 'Perfect timing'],
                    series: [
                        { key: 'part', label: 'Where it comes from', color: 'battery', values: [s.fromGridGbp, s.fromSolarGbp, s.standbyGbp, null, null] },
                        { key: 'total', label: 'In total', color: 'muted', values: [null, null, null, a.batteryTotalGbp, a.optimalGbp] },
                    ],
                    stacked: true, horizontal: true, y: { format: v => fmt.gbp(v) }, x: { label: 'Part' }, totalLabel: 'Total',
                });
                links(['Open it in Design', `#design?scenario=${enc(a.bestId)}`], ['Battery-size curve', '#compare']);
                break;
            }
            case 'ups': {
                // A station with its own panels: every way of running it includes what they make
                // (they charge it on its own dc inputs, never through the grid side)
                const own = V.ranked?.find(r => r.id === a.bestId)?.panels;
                const ownPanels = own?.station ? own.count : 0;
                const withOwn = ownPanels ? ` with its own ${ownPanels} panel${ownPanels === 1 ? '' : 's'}` : '';
                this.chart('ups', charts.createBars, slot.chart, {
                    tableCaption: `Power station${withOwn}: what the automation is worth`,
                    ariaLabel: `Yearly saving of a power station${withOwn} under four ways of running it`,
                    categories: ['Smart plug, 4–7pm cut', 'Agile-aware (realistic)', 'Perfect timing', 'Bypass off, always on battery'],
                    series: [{ key: 'gbp', label: '£ a year', color: 'ups', values: [a.peakCutGbp, a.realisticGbp, a.bestCaseGbp, a.onlineGbp] }],
                    horizontal: true, y: { format: v => fmt.gbp(v) }, x: { label: 'How it runs' },
                    note: ownPanels ? `Every bar includes what its ${ownPanels} panel${ownPanels === 1 ? '' : 's'} make — they charge it on its own solar inputs, so none of it is exported.` : null,
                });
                links(['Open it in Design', `#design?scenario=${enc(a.bestId)}`], ['Every power station', '#compare']);
                break;
            }
            case 'growth': {
                links(['Compare the options', '#compare']);
                break;
            }
            case 'confidence': {
                const parts = a.parts ?? {};
                const lv = (k, label) => {
                    const p = parts[k];
                    if (!p) return null;
                    const L = LEVEL[p.level];
                    return h('div', { class: 'vd-level' }, h('span', { class: 'vd-level-k' }, label), h('span', { class: ['vd-level-v', `tone-${L.tone}`] }, L.label),
                        p.reason ? h('span', { class: 'vd-level-r' }, p.reason) : null);
                };
                this.putPart(slot.extra, JSON.stringify(parts), () => [h('div', { class: 'vd-levels' }, lv('data', 'Your data'), lv('weather', 'Weather'), lv('model', 'The model'))]);
                const t = V.tornado;
                if (t?.rows?.length && finite(t.center)) {
                    const cap = (V.context?.finance?.years ?? 20) + 5;
                    const capV = v => (finite(v) ? v : cap);
                    this.chart('tornado', charts.createTornado, slot.chart, {
                        tableCaption: 'What moves the payback (years)', ariaLabel: 'Payback in years at the low and high setting of each uncertainty',
                        center: t.center, centerLabel: `payback ${fmt.years(t.center)}`,
                        // short setting names: the bar-end labels must fit beside or inside the bars
                        rows: t.rows.map(r => ({ label: (this.isPhone && SHORT_DRIVER[r.key]) || r.label, low: capV(r.low), high: capV(r.high), lowLabel: shortSetting(r.key, r.lowLabel, 'low'), highLabel: shortSetting(r.key, r.highLabel, 'high') })),
                        format: v => (v >= cap - 1e-9 ? 'never' : fmt.num(v, 1)), legend: ['Low setting', 'High setting'],
                        note: 'Bars run from the central payback to the payback at each setting; the longest bar matters most.',
                    });
                }
                links(['How the model works', '#method']);
                break;
            }
            case 'baseLoad': {
                this.chart('baseload', charts.createLine, slot.chart, this.baseLoadSpec(a, V));
                links(['Your always-on load', '#usage']);
                break;
            }
            default:
        }
    },

    orientationSpec(a) {
        const { fmt } = this.ctx;
        const name = (p) => `${fmt.compass(p.az)} ${Math.round(p.tilt)}°`;
        const cells = (a.cells ?? []).filter(c => c.kwh > 0).map(c => ({ x: c.kwh, y: c.pPerKwh, label: `${fmt.compass(c.az)} (${c.az}°) at ${c.tilt}° — quick estimate`, route: 'reference',
            extra: [{ value: fmt.gbp(c.gbp), label: 'a year' }, { value: fmt.pct(c.peakShareAllPct ?? c.peakSharePct), label: 'made 4–7pm' }] }));
        const named = [
            ['Best for you', a.best, 'pv', true],
            ['South 35°', a.s35, 'load'],
            ['SSW 45°', a.ssw45, 'load'],
            ['West 45°', a.w45, 'price'],
            ['West wall', a.w90, 'price'],
        ].filter(([, p]) => p && p.kwh > 0);
        if (a.current && (a.current.az !== a.best.az || a.current.tilt !== a.best.tilt)) named.push(['As placed', a.current, 'cat3']);
        // a named direction sitting on top of the best one keeps its dot and tooltip but not its
        // label, which would overprint "Best for you"
        const near = p => a.best && Math.abs(p.kwh - a.best.kwh) < 0.03 * a.best.kwh && Math.abs(p.pPerKwh - a.best.pPerKwh) < 0.03 * a.best.pPerKwh;
        const pts = named.map(([label, p, color, em]) => ({
            x: p.kwh, y: p.pPerKwh, label: em ? `${label}: ${name(p)}` : `${label}`, color, emphasis: !!em, showLabel: !em && !near(p),
            extra: [{ value: fmt.gbp(p.gbp), label: 'a year' }, { value: name(p), label: 'direction' }, { value: fmt.pct(p.peakShareAllPct ?? p.peakSharePct), label: 'made 4–7pm' }],
        }));
        const xs = [...cells, ...pts].map(p => p.x);
        const x0 = Math.max(1, Math.min(...xs) * 0.9);
        const x1 = Math.max(...xs) * 1.05;
        const iso = [];
        const gMax = Math.max(...[...cells, ...pts].map(p => (p.x * p.y) / 100));
        for (let g = 50; g <= gMax + 50; g += 50) {
            const line = [];
            for (let k = 0; k <= 24; k++) { const x = x0 + ((x1 - x0) * k) / 24; line.push([x, (100 * g) / x]); }
            iso.push({ points: line, label: `£${g}/yr` });
        }
        return {
            tableCaption: 'Energy vs value', ariaLabel: 'Each direction and tilt: energy made in a year against what each kWh is worth',
            points: [...cells, ...pts],
            x: { label: 'kWh made a year', format: v => fmt.num(v), zero: false, min: x0, max: x1 },
            y: { label: 'p per kWh made', format: v => fmt.p(v, { dp: 0 }), zero: false },
            isolines: iso,
            legend: [{ label: 'Every direction (quick estimate)', color: 'reference' }, { label: 'Best for you', color: 'pv' }, { label: 'South-ish', color: 'load' }, { label: 'West', color: 'price' }],
            note: 'Up is more valuable per kWh, right is more kWh. Dashed curves join directions worth the same £ a year — west climbs the value axis but slides left faster.',
            height: 300, printTable: false,
        };
    },

    baseLoadSpec(a, V) {
        const { fmt } = this.ctx;
        const curves = a.curves ?? [];
        const xs = [...new Set(curves.flatMap(c => c.points.map(p => p.x)))].sort((p, q) => p - q);
        const colors = { plugin: 'pv', hardwired: 'battery', ups: 'ups', whatif: 'muted' };
        const series = curves.map(c => {
            const at = new Map(c.points.map(p => [p.x, p.savingsGbp]));
            return { key: c.id, label: c.name, color: colors[c.route] || undefined, values: xs.map(x => (at.has(x) ? at.get(x) : NaN)) };
        });
        const markers = [];
        const measured = finite(a.measuredBaseW) ? a.measuredBaseW : a.userBaseW;
        if (finite(a.projectedBaseW)) {
            // every figure uses the projection: mark it, and the measured load for reference
            markers.push({ x: Math.round(a.projectedBaseW), label: 'projected' });
            if (finite(measured) && Math.abs(measured - a.projectedBaseW) >= 25) markers.push({ x: Math.round(measured), label: 'measured' });
        } else if (finite(measured)) {
            markers.push({ x: Math.round(measured), label: 'you now' });
            if (finite(a.recentBaseW) && Math.abs(a.recentBaseW - measured) >= 25) markers.push({ x: Math.round(a.recentBaseW), label: 'last 2 months' });
        }
        const xMax = xs[xs.length - 1] ?? 1500;
        const lowest = Math.min(0, ...series.flatMap(se => se.values.filter(finite)));
        const be = c => (!finite(c.breakEvenW) ? 'not at any load we tried' : c.breakEvenW <= 0.5 ? 'at any load' : `from ${fmt.num(Math.round(c.breakEvenW / 10) * 10)} W`);
        return {
            tableCaption: 'Yearly saving against always-on load', ariaLabel: 'First-year saving of the best options as the always-on load changes',
            x: { values: xs, type: 'linear', label: 'always-on load (W)', format: v => `${fmt.num(v)} W` },
            y: { label: '£ saved in year 1', format: v => fmt.gbp(v), min: lowest > -20 ? lowest : undefined },
            series,
            bands: [{ from: a.shadeFromW ?? 800, to: xMax, label: 'kit’s output all used' }],
            markers,
            note: curves.length ? `Pays back within ${fmt.num(V.context?.maxPaybackYears ?? 10)} years: ${curves.map(c => `${c.name} ${be(c)}`).join(' · ')}.` : null,
        };
    },

    /* ── assumptions (screen + print) ───────────────────────────────────── */

    fillAssumptions(V) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const c = V.context ?? {};
        const f = c.finance ?? {};
        const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
        this.v.parts.assume.replaceChildren(h('dl', null,
            row('First year', `${c.firstYear?.label ?? '—'} (installed ${isoDay(fmt, f.installDate)})`),
            row('VAT', f.vatReturns === false ? '0% from Oct 2026 onwards' : '0% until 31 Mar 2027, then back to 5%'),
            row('Prices', `Your own half-hourly prices, rising ${fmt.pct(100 * (f.escalation ?? 0))} a year; future savings discounted at ${fmt.pct(100 * (f.discountRate ?? 0))}`),
            row('Sunshine', c.weather?.typicalYear === false
                ? 'Your last 12 months’ satellite sunshine as it happened — the 20-year record for your home wasn’t available, so there is no weather range'
                : 'Each month scaled to its 2006–2025 satellite average at your home (a typical year); the range shows every year from 2006 to 2025'),
            row('Panels', `Lose ${fmt.pct(100 * (f.pvAnnualDeg ?? 0), { dp: 1 })} a year; micro-inverter replaced in year 12; horizon ${fmt.num(f.years ?? 20)} years`),
            row('Recommended if', `It pays back within ${fmt.num(c.maxPaybackYears ?? 10)} years, is legal today and on sale`),
            row('Prices checked', isoDay(fmt, c.pricesChecked)),
            row('Not advice', 'Estimates from your data — check prices, your circuit and your installer before you buy.')),
            h('div', { class: 'row', style: { marginTop: '10px' } },
                ui.button({ label: 'Change these in Method', kind: 'link', size: 'sm', icon: 'arrowRight', href: '#method' }),
                ui.button({ label: 'Save as PDF', kind: 'ghost', size: 'sm', icon: 'print', onClick: () => window.print() })));
    },
};
