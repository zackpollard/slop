/*
 * views/orientation.js — the Orientation tab: which way should the panels face, and does west pay
 * for the 4–7pm peak?
 *
 * Engine work (all in the worker):
 *   - ctx.data.autoScenarios()                    the option set the kit picker offers
 *   - ctx.data.scenario(system, { withBand:false }) to find the best plug-in kit (same rule as the
 *     verdict: highest 10-year NPV among eligible plug-in rows, £25 tie → cheaper), and for the
 *     full simulations behind the hour-of-day lines, the monthly 4–7pm shares and a picked cell
 *   - ctx.engine.call('orientationSweep', system, arrayId, { finance })   the solar rose (649-cell
 *     proxy grid + starred full-fidelity points), with progress; cancelled when superseded
 *   - ctx.data.verdict()  only to reuse answers.orientation (flip conditions C1–C4) when it is about
 *     the same kit; started after this view's own work so it never delays the rose
 *
 * Layout, top to bottom:
 *   1. head + context line, then the controls bar: kit picker (saved scenarios, then the catalog
 *      options grouped by route; default the best plug-in) and, for multi-array systems, which panels
 *   2. the answer card: "Should they face west for the 4–7pm peak? No — face them SSW…" with the
 *      UX-critique copy (W90 vs best, tie band, flips), a dial glyph of the tie band and a readout
 *   3. the solar rose (metric toggle £ | kWh | p per kWh | 4–7pm share; sun-side fan or all round)
 *      beside the "Try a direction" panel and the named-directions table. Below 480 px the rose is
 *      replaced by a Top-10 list with the rose behind "Show rose" (CSS-driven).
 *   4. Energy vs value scatter (kWh × p/kWh, iso-£ curves) · hour-of-day generation lines
 *   5. monthly 4–7pm share bars (no sun after 4pm Nov–Feb)
 *
 * Click to apply: a cell (rose), a dot (energy chart) or a row (tables) becomes the pick: quick
 * proxy figures at once, a full simulation a moment later, then "Save as a scenario" (writes a
 * re-pointed copy to store.scenarios.saved and makes it active) and "Open in Design".
 *
 * Re-rendering: the DOM is built once per dataset; recomputes keep the previous figures at reduced
 * opacity (no layout jump). While the tab is hidden, dataset/settings changes only mark it dirty,
 * so a background sweep never competes with the tab the user is on.
 *
 * View-local components (candidates for ui.js/charts.js — see the report): orientationDial() (the
 * tie band as a wedge on a mini fan — "anything in here is fine"), and the Top-10 list.
 */

const STYLE_ID = 'style-orientation';
const TIE_PCT = 3;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HH = Array.from({ length: 48 }, (_, i) => `${String(i >> 1).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const DAY = [8, 44];                     // hour-of-day chart window: 04:00–22:00 local (end exclusive)
const PEAK = [32, 38];                   // 16:00–19:00 local
const SWEEP_CACHE = 8;

/** The named directions the engine stars, in the order the UI lists them, with their series colour. */
const NAMED = [
    { key: 'bestGbp', label: 'Best for £', short: 'Best £', color: 'cat4' },
    { key: 'bestKwh', label: 'Most energy', short: 'Most kWh', color: 'cat1' },
    { key: 'W90', label: 'West wall (vertical)', short: 'W wall', color: 'cat2' },
    { key: 'current', label: 'As set now', short: 'Now', color: 'cat3' },
    { key: 'S35', label: 'Due south, 35°', short: 'S 35°', color: null },
    { key: 'SSW45', label: 'SSW, 45°', short: 'SSW 45°', color: null },
];
const PICK = { key: 'pick', label: 'Your pick', short: 'Picked', color: 'cat5' };
const LINE_KEYS = ['bestGbp', 'bestKwh', 'W90', 'current'];

const METRICS = [
    { id: 'gbp', key: 'gbp', label: '£ saved', short: '£', unit: '£ a year', tip: 'saved a year', ramp: 'solar', best: 'bestGbp' },
    { id: 'kwh', key: 'kwh', label: 'kWh', short: 'kWh', unit: 'kWh a year', tip: 'made a year', ramp: 'solar', best: 'bestKwh' },
    { id: 'ppk', key: 'pPerKwh', label: 'p per kWh made', short: 'p/kWh', unit: 'p per kWh made', tip: 'per kWh made', ramp: 'sequential', best: 'bestGbp' },
    { id: 'peak', key: 'peakSharePct', label: '4–7pm share', short: '4–7pm', unit: '% made 4–7pm', tip: 'made 4–7pm', ramp: 'sequential', best: 'bestGbp' },
];

const FLIP_SHORT = {
    C1: 'a lower always-on load with Outgoing Prime',
    C2: 'Outgoing Prime',
    C3: 'more panels on the same inverter',
    C4: 'a battery',
};

const CSS = `
.ov { display: flex; flex-direction: column; gap: 20px; }
.ov .view-title:focus { outline: none; }
.ov .view-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.ov-dyn { transition: opacity .2s ease; }
.ov.is-stale .ov-dyn, .ov.is-old .ov-dyn { opacity: .5; }
/* a failed run for a different kit: the old kit's figures must not sit under the new kit's name */
.ov.is-empty > .ov-hero, .ov.is-empty > .ov-main, .ov.is-empty > .ov-grid, .ov.is-empty > .ov-dyn { display: none; }
/* card headings already name these charts; the chart title only captions the table twin */
.ov-untitled .chart-title { display: none; }
/* a hidden tooltip keeps its last transform; after a resize that can widen the page */
.ov .chart-tip:not(.show) { transform: none !important; transition: opacity .1s, transform 0s .1s; }
.ov-context { margin-top: 8px; }
.ov-context .context-line { overflow-wrap: anywhere; }

.ov-controls {
    display: flex; flex-wrap: wrap; align-items: flex-end; gap: 14px 22px;
    padding: 14px 18px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
}
.ov-kit { flex: 1 1 340px; max-width: 560px; }
.ov-panels { flex: 0 1 auto; min-width: 0; }
.ov-panels[hidden] { display: none; }
.ov-basis { flex: 1 1 240px; align-self: center; font-family: var(--font-mono); font-size: 11.5px; line-height: 1.65; color: var(--muted); }
.ov-basis b { color: var(--text-2); font-weight: 500; }
.ov-notice[hidden] { display: none; }

/* ── the answer ─────────────────────────────────────────────────────────── */
.ov-hero { padding: 26px 28px 24px; }
.ov-hero-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); gap: 34px; align-items: stretch; }
.ov-q { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
.ov-answer { font-size: 29px; font-weight: 700; letter-spacing: -.032em; line-height: 1.16; margin-top: 9px; max-width: 32ch; text-wrap: balance; }
.ov-answer .ov-dir { font-family: var(--font-mono); font-weight: 600; letter-spacing: -.045em; color: var(--accent-strong); white-space: nowrap; }
.ov-body { color: var(--text-2); margin-top: 12px; max-width: 66ch; }
.ov-body b { color: var(--text); font-weight: 600; white-space: nowrap; }
.ov-eq { margin-top: 18px; max-width: 66ch; }
.ov-eq-title { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }
.ov-eq-row { display: grid; grid-template-columns: minmax(0, 1fr) 22px minmax(0, 1fr) 22px minmax(0, 1fr); align-items: stretch; }
.ov-eq-cell { padding: 10px 12px 11px; border: 1px solid var(--border); border-radius: 8px; background: var(--sunk); min-width: 0; }
.ov-eq-cell.is-result { border-color: var(--accent-line); box-shadow: inset 0 2px 0 var(--accent); }
.ov-eq-label { font-size: 12px; color: var(--muted); }
.ov-eq-val { font-family: var(--font-mono); font-size: 24px; font-weight: 600; letter-spacing: -.04em; line-height: 1.15; margin-top: 3px; color: var(--text); }
.ov-eq-val.is-down { color: var(--bad); }
.ov-eq-val.is-up { color: var(--good); }
.ov-eq-sub { font-family: var(--font-mono); font-size: 11px; color: var(--muted); margin-top: 3px; overflow-wrap: anywhere; }
.ov-eq-op { align-self: center; text-align: center; font-family: var(--font-mono); font-size: 16px; color: var(--faint); }
.ov-short { display: none; }
.ov-tie {
    margin-top: 16px; padding: 11px 14px; border-left: 2px solid var(--accent); border-radius: 0 8px 8px 0;
    background: var(--accent-dim); color: var(--text-2); font-size: 14px; max-width: 66ch;
}
.ov-tie b { color: var(--text); font-weight: 600; white-space: nowrap; }
.ov-more { margin-top: 12px; color: var(--muted); font-size: 13.5px; max-width: 66ch; display: flex; flex-direction: column; gap: 6px; }
.ov-more b { color: var(--text-2); font-weight: 600; }
.ov-more .ov-pending { display: inline-flex; align-items: center; gap: 8px; }
.ov-more .spinner { width: 12px; height: 12px; }
.ov-flip { color: var(--text-2); }
.ov-flip b { color: var(--text); }
.ov-side { border-left: 1px solid var(--hairline); padding-left: 30px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.ov-dial { display: block; width: 100%; max-width: 300px; height: auto; overflow: visible; }
.ov-dial-face { fill: var(--sunk); stroke: var(--border-strong); stroke-width: 1; }
.ov-dial-ring { fill: none; stroke: var(--hairline); stroke-width: 1; }
.ov-dial-spoke { stroke: var(--hairline); stroke-width: 1; }
.ov-dial-tie { fill: rgba(196, 162, 78, .26); stroke: var(--accent); stroke-width: 1.25; stroke-linejoin: round; }
.ov-dial-best { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.ov-dial-west { fill: var(--series-import); stroke: var(--surface); stroke-width: 2; }
.ov-dial-now { fill: none; stroke: var(--text); stroke-width: 2; }
.ov-dial-label { font-family: var(--font-mono); font-size: 10px; fill: var(--muted); }
.ov-dial-tag { font-family: var(--font-body); font-size: 10.5px; font-weight: 600; fill: var(--text-2); }
.ov-dial-key { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; color: var(--muted); margin-top: -4px; }
.ov-dial-key span { display: inline-flex; align-items: center; gap: 6px; }
.ov-k { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.ov-k-tie { width: 12px; height: 9px; border-radius: 2px; background: rgba(196, 162, 78, .26); border: 1px solid var(--accent); }
.ov-k-best { background: var(--accent); }
.ov-k-west { background: var(--series-import); }
.ov-k-now { border: 2px solid var(--text); width: 10px; height: 10px; }
.ov-readout-label { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.ov-readout-fig { font-family: var(--font-mono); font-size: 46px; font-weight: 600; letter-spacing: -.05em; line-height: 1; margin-top: 6px; color: var(--text); }
.ov-readout-fig small { font-family: var(--font-body); font-size: 15px; font-weight: 500; letter-spacing: 0; color: var(--muted); margin-left: 7px; }
.ov-readout-sub { font-family: var(--font-mono); font-size: 12px; color: var(--muted); margin-top: 7px; }
.ov-rows { margin: 0; padding: 0; }
.ov-row { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; padding: 8px 0; border-top: 1px solid var(--hairline); }
.ov-row dt { color: var(--text-2); font-size: 13.5px; min-width: 0; }
.ov-row dt small { display: block; font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
.ov-row dd { margin: 0; font-family: var(--font-mono); font-size: 15px; font-weight: 600; color: var(--text); white-space: nowrap; text-align: right; }
.ov-row dd small { display: block; font-size: 11px; font-weight: 500; color: var(--muted); }
.ov-foot { margin-top: 18px; padding-top: 12px; border-top: 1px solid var(--hairline); font-family: var(--font-mono); font-size: 11px; line-height: 1.6; color: var(--muted); }
.ov-foot a { color: var(--text-2); }

/* ── rose + side panel ──────────────────────────────────────────────────── */
.ov-main { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.ov-col { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.ov-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 14px; margin-bottom: 12px; }
.ov-progress { position: relative; height: 3px; margin: -4px 0 12px; border-radius: 2px; background: var(--hairline); overflow: hidden; }
.ov-progress[hidden] { display: none; }
.ov-progress-bar { position: absolute; inset: 0 auto 0 0; width: 0; background: var(--accent); transition: width .2s ease; }
.ov-progress.is-indeterminate .ov-progress-bar { width: 30%; animation: ov-slide 1.1s ease-in-out infinite; }
@keyframes ov-slide { from { left: -30%; } to { left: 100%; } }
.ov-status { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); min-height: 18px; margin-bottom: 6px; }
.ov-status:empty { display: none; }
.ov-key { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 10px; font-size: 12.5px; color: var(--text-2); }
.ov-key span { display: inline-flex; align-items: center; gap: 7px; }
.ov-k-ref { width: 7px; height: 7px; background: var(--text); }
.ov-note { font-size: 12.5px; color: var(--muted); margin-top: 8px; }
.ov-rose-btn { display: none; }
.ov-top { display: none; list-style: none; margin: 0; padding: 0; }
.ov-top li + li { margin-top: 6px; }
.ov-top-cap { display: none; font-size: 13px; color: var(--muted); margin: 0 0 10px; }
.ov-top-btn {
    display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 2px 10px; width: 100%;
    min-height: 52px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 9px; background: var(--sunk);
    color: var(--text); text-align: left; cursor: pointer; font: inherit;
}
.ov-top-btn:hover { border-color: var(--border-strong); }
.ov-top-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ov-top-btn[aria-pressed='true'] { border-color: var(--accent-line); background: var(--accent-dim); }
.ov-top-rank { font-family: var(--font-mono); font-size: 11px; color: var(--faint); }
.ov-top-dir { font-family: var(--font-mono); font-size: 13.5px; font-weight: 600; min-width: 0; }
.ov-top-dir small { display: block; font-family: var(--font-body); font-size: 12px; font-weight: 400; color: var(--muted); }
.ov-top-val { font-family: var(--font-mono); font-size: 14px; font-weight: 600; white-space: nowrap; }

.ov-pick-empty { display: flex; gap: 12px; align-items: flex-start; color: var(--muted); font-size: 13.5px; }
.ov-pick-empty .icon { flex: none; margin-top: 2px; color: var(--accent); }
.ov-pick-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ov-pick-dir { font-family: var(--font-mono); font-size: 22px; font-weight: 600; letter-spacing: -.035em; color: var(--text); }
.ov-pick-sub { font-size: 13px; color: var(--muted); margin-top: 3px; }
.ov-pick-sub b { color: var(--text-2); font-weight: 600; }
.ov-pick-rows { margin: 12px 0 0; }
.ov-pick-rows .ov-row dd.is-quick { color: var(--text-2); font-weight: 500; }
.ov-pick-tag { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
.ov-pick-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.ov-pick-saved { margin-top: 12px; }
.ov-pick-saved .icon { color: var(--good); }
.ov-pick-saved b { color: var(--text); font-weight: 600; }
.ov-dircell { display: inline-flex; align-items: flex-start; gap: 9px; }
.ov-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; flex: none; margin-top: 5px; }
.ov-swatch-none { background: transparent; border: 1.5px solid var(--faint); }
.ov-dirname { font-weight: 600; color: var(--text); }
.ov-dirsub { display: block; font-family: var(--font-mono); font-size: 11px; color: var(--muted); font-weight: 400; margin-top: 1px; }
.ov-named .tbl tbody th { white-space: normal; }
.ov-named .tbl td { white-space: nowrap; }

.ov-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.ov-grid > .ov-span { grid-column: 1 / -1; }
.ov-take { color: var(--text-2); font-size: 14px; margin: 0 0 12px; max-width: 70ch; }
.ov-take b { color: var(--text); font-weight: 600; white-space: nowrap; }
.ov-month { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 26px; align-items: start; }
.ov-month-side { border-left: 1px solid var(--hairline); padding-left: 24px; display: flex; flex-direction: column; gap: 12px; color: var(--text-2); font-size: 13.5px; }
.ov-month-side b { color: var(--text); font-weight: 600; }
.ov-error { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }

@media (max-width: 1023px) {
    .ov-main, .ov-grid, .ov-month { grid-template-columns: minmax(0, 1fr); }
    .ov-month-side { border-left: 0; padding-left: 0; border-top: 1px solid var(--hairline); padding-top: 14px; }
}
@media (max-width: 760px) {
    .ov-hero-grid { grid-template-columns: minmax(0, 1fr); gap: 22px; }
    .ov-side { border-left: 0; padding-left: 0; border-top: 1px solid var(--hairline); padding-top: 18px; }
    .ov-dial { max-width: 340px; margin: 0 auto; }
}
@media (max-width: 600px) {
    .ov-hero { padding: 18px 16px 16px; }
    .ov-answer { font-size: 23px; }
    .ov-readout-fig { font-size: 38px; }
    .ov-controls { padding: 12px 14px 14px; }
    .ov-kit { flex-basis: 100%; }
    .ov-basis { flex-basis: 100%; }
    .ov-pick-actions .btn { flex: 1 1 auto; }
    .ov-toolbar .seg { min-width: 44px; }
    .ov-foot a { display: inline-flex; align-items: center; min-height: 44px; }
    .ov-eq-row { grid-template-columns: minmax(0, 1fr) 14px minmax(0, 1fr) 14px minmax(0, 1fr); }
    .ov-eq-cell { padding: 8px 8px 9px; }
    .ov-eq-val { font-size: 19px; }
    .ov-eq-label { font-size: 11px; }
    .ov-eq-sub { font-size: 10px; }
    .ov-eq-op { font-size: 13px; }
    .ov-long { display: none; }
    .ov-short { display: inline; }
}
.ov-xs-short { display: none; }
/* Phones: a Top-10 list instead of the rose (UX critique); the rose is one tap away. */
@media (max-width: 479px) {
    .ov-xs-long { display: none; }
    .ov-xs-short { display: inline; }
    .ov-top { display: block; }
    .ov-top-cap:not(:empty) { display: block; }
    .ov-rose-btn { display: inline-flex; width: 100%; margin-top: 12px; }
    .ov-rose-card:not(.show-rose) .ov-rose-wrap { display: none; }
    .ov-rose-card.show-rose .ov-rose-wrap { margin-top: 14px; }
}
@media print {
    .ov.is-stale .ov-dyn { opacity: 1; }
    .ov-side { border-color: #ddd; }
    .ov-dial-face { fill: #fff; }
    .ov-top, .ov-rose-btn, .ov-pick-actions, .ov-toolbar, .ov-pending { display: none !important; }
    /* "click a cell to try" means nothing on paper; a pick's figures do */
    .ov-pick-card:has(.ov-pick-empty) { display: none !important; }
    .ov-rose-card .ov-rose-wrap { display: block !important; }
}
`;

/* ── pure helpers (exported for tests) ──────────────────────────────────────── */

const finite = v => typeof v === 'number' && Number.isFinite(v);

/** Deterministic JSON (sorted keys) for memo keys. */
export function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v, stable).join(',')}]`;
    return `{${Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
}

const panelsOf = a => (a?.count || 0) * (a?.wp || 0) > 0;
const stationArrays = sys => (sys?.battery?.coupling === 'ups' ? sys.battery.ups?.pvArrays || [] : []);

/** True when a system has any panels that can be pointed (grid-tied or a power station's own). */
export function hasPanels(sys) {
    return !!sys && ((sys.arrays || []).some(panelsOf) || stationArrays(sys).some(panelsOf));
}

/**
 * Which panels a sweep re-points — the same rule as SolarEngine._target: one array by id, or for
 * '*' every grid-tied array together (a power station's own panels when there are none).
 * @returns {{ station: boolean, index: number, ref: object }|null}
 */
export function targetOf(sys, arrayId = '*') {
    const arrays = sys?.arrays || [];
    const st = stationArrays(sys);
    const all = arrayId == null || arrayId === '*';
    if (!all) {
        const i = arrays.findIndex(a => a.id === arrayId);
        if (i >= 0) return { station: false, index: i, ref: arrays[i] };
        const k = st.findIndex(a => a.id === arrayId);
        if (k >= 0) return { station: true, index: k, ref: st[k] };
    }
    if (arrays.length) return { station: false, index: -1, ref: arrays[0] };
    if (st.length) return { station: true, index: -1, ref: st[0] };
    return null;
}

/**
 * Does pointing this target leave some of the system's panels where they are? True when one
 * panel set of several is pointed, or when a kit's panels move but a power station's own panels
 * don't (or the reverse). The engine's kWh then counts every panel, so the copy has to talk about
 * "the whole system" rather than "they'd make X kWh".
 * @param {object} sys
 * @param {{ station: boolean, index: number }|null} tg
 * @returns {boolean}
 */
export function leavesPanelsFixed(sys, tg) {
    if (!sys || !tg) return false;
    const grid = (sys.arrays || []).map(panelsOf);
    const st = stationArrays(sys).map(panelsOf);
    const otherGrid = grid.some((p, j) => p && (tg.station || (tg.index >= 0 && j !== tg.index)));
    const otherSt = st.some((p, j) => p && (!tg.station || (tg.index >= 0 && j !== tg.index)));
    return otherGrid || otherSt;
}

/**
 * The longest run of months around December (Oct–Mar only) where a share stays under `below` %
 * — "from November to January there's almost no sun after 4pm" comes from this, not a fixed list.
 * @param {number[]} share 12 monthly shares (NaN = nothing made)
 * @param {number} [below]
 * @returns {number[]} month indices in calendar order through the year end, e.g. [10, 11, 0]
 */
export function darkMonths(share, below = 5) {
    const dark = i => !finite(share?.[i]) || share[i] < below;
    if (!dark(11)) return [];
    const run = [11];
    for (const i of [10, 9]) { if (dark(i)) run.unshift(i); else break; }
    for (const i of [0, 1, 2]) { if (dark(i)) run.push(i); else break; }
    return run;
}

/** The system with the targeted panels pointed at (az, tilt) — mirrors SolarEngine._repoint. */
export function repoint(sys, tg, az, tilt) {
    const re = (a, j) => (tg.index < 0 || j === tg.index ? { ...a, azimuth: az, tilt } : a);
    if (!tg.station) return { ...sys, arrays: sys.arrays.map(re) };
    const u = sys.battery.ups;
    return { ...sys, battery: { ...sys.battery, ups: { ...u, pvArrays: u.pvArrays.map(re) } } };
}

/**
 * The tie band (UX critique): bounding box of the cells within pct % of the best £, searched in
 * the window panels can sensibly face (az 90–270, tilt 15–90) — sweep.js tieBox semantics, with
 * the azimuth range kept contiguous around the best (never wrapping through north).
 * @param {Array<{az:number,tilt:number,gbp:number}>} cells
 * @param {number} [pct]
 * @returns {{ azMin, azMax, tiltMin, tiltMax, count, best }|null}
 */
export function tieBand(cells, pct = TIE_PCT) {
    const win = (cells || []).filter(c => c.tilt >= 15 && c.tilt <= 90 && c.az >= 90 && c.az <= 270 && finite(c.gbp));
    if (!win.length) return null;
    const best = win.reduce((a, b) => (b.gbp > a.gbp ? b : a));
    const floor = best.gbp - (Math.abs(best.gbp) * pct) / 100;
    const ok = win.filter(c => c.gbp >= floor);
    let azMin = best.az, azMax = best.az;
    for (const c of ok) {
        let d = c.az - best.az;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        azMin = Math.min(azMin, best.az + d);
        azMax = Math.max(azMax, best.az + d);
    }
    const tl = ok.map(c => c.tilt);
    return { azMin: ((azMin % 360) + 360) % 360, azMax: ((azMax % 360) + 360) % 360, tiltMin: Math.min(...tl), tiltMax: Math.max(...tl), count: ok.length, best };
}

/**
 * Rose grid for the polar chart: azimuths (sun side 90–270 or all round), tilts and az-major values.
 * @returns {{ azimuths: number[], tilts: number[], values: Float64Array }}
 */
export function roseGrid(sweep, key, sunSide) {
    const az = (sweep?.azimuths || []).filter(a => !sunSide || (a >= 90 && a <= 270));
    const tilts = sweep?.tilts || [];
    const map = new Map((sweep?.cells || []).map(c => [`${c.az}|${c.tilt}`, c]));
    const flat = (sweep?.cells || []).find(c => c.tilt === 0);
    const values = new Float64Array(az.length * tilts.length).fill(NaN);
    az.forEach((a, i) => tilts.forEach((t, j) => {
        const c = t === 0 ? flat : map.get(`${a}|${t}`);
        if (c && finite(c[key])) values[i * tilts.length + j] = c[key];
    }));
    return { azimuths: az, tilts, values };
}

/** Month-of-year share (%) of PV output made 4–7pm from MonthRows (NaN where nothing was made). */
export function monthlyPeakShare(monthly) {
    const pv = new Float64Array(12), pk = new Float64Array(12);
    for (const m of monthly || []) {
        if (!finite(m?.month0)) continue;
        pv[m.month0] += m.pvAcKwh || 0;
        pk[m.month0] += m.peakPvAcKwh || 0;
    }
    return Array.from(pv, (v, i) => (v > 1e-6 ? (100 * pk[i]) / v : NaN));
}

/** Average W by half-hour from a Profile48 (mean kWh per half-hour). */
export const profileW = profile => Array.from(profile?.pvAc || [], v => (finite(v) ? v * 2000 : NaN));

/** Mean of a W profile over half-hour indices [a, b). */
const meanOver = (w, a, b) => { let s = 0, n = 0; for (let i = a; i < b; i++) if (finite(w[i])) { s += w[i]; n++; } return n ? s / n : NaN; };

/**
 * Pick the best plug-in kit from scenario results with the verdict's rule: eligible rows (legal
 * 'ok', no rule errors, payback ≤ maxPaybackYears) by 10-year NPV, a £25 tie going to the cheaper;
 * with nothing eligible, the highest NPV among legal ones.
 * @param {Array<{ id, rules, headline }>} results
 * @param {number} maxPaybackYears
 * @returns {string|null}
 */
export function bestByNpv(results, maxPaybackYears = 10) {
    const ok = (results || []).filter(r => r && r.rules?.legal === 'ok' && !(r.rules?.errors?.length) && finite(r.headline?.npv10Gbp));
    const eligible = ok.filter(r => finite(r.headline.paybackYears) && r.headline.paybackYears <= maxPaybackYears);
    const pool = eligible.length ? eligible : ok;
    if (!pool.length) return null;
    const sorted = [...pool].sort((a, b) => b.headline.npv10Gbp - a.headline.npv10Gbp);
    let best = sorted[0];
    for (const r of sorted.slice(1)) {
        if (best.headline.npv10Gbp - r.headline.npv10Gbp > 25) break;
        if ((r.headline.capexGbp ?? Infinity) < (best.headline.capexGbp ?? Infinity)) best = r;
    }
    return best.id;
}

/** Nice iso-£ levels strictly inside (lo, hi): at most 3 curves, so their labels never crowd. */
export function isoLevels(lo, hi, max = 3) {
    if (!finite(lo) || !finite(hi) || hi <= lo) return [];
    for (const step of [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000]) {
        const out = [];
        for (let g = Math.ceil(lo / step) * step; g <= hi + 1e-9; g += step) if (g > 0 && g > lo) out.push(g);
        if (out.length <= max) return out.length ? out : [Math.round(hi)];
    }
    return [];
}

/* ── the view ───────────────────────────────────────────────────────────────── */

export default {
    id: 'orientation',
    title: 'Orientation',

    mount(el, ctx) {
        this.el = el;
        this.ctx = ctx;
        this.token = 0;
        this.v = null;                 // built DOM for one dataset
        this.sel = null;               // { id, sys, arrayId, tg, ... }
        this.sweep = null;             // the SweepResult on screen (for this.sel)
        this.sweeps = new Map();       // small memo: key → SweepResult
        this.runs = new Map();         // named key → ScenarioResult (this.sel)
        this.pick = null;              // { az, tilt, cell, run, savedId }
        this.metric = 'gbp';
        this.view = 'sun';
        this.verdict = null;           // { key, v } — the last verdict seen for this dataset/settings
        this.verdictState = 'idle';    // 'idle' | 'pending' | 'done' | 'unavailable'
        this.bestMemo = null;          // { key, id }
        this.params = ctx.router?.params?.() || {};
        this.dirty = false;            // a change arrived while the tab was hidden: render on show()
        injectStyle(ctx.ui.h);
        const onChange = reason => () => {
            if (reason !== 'status') { this.bestMemo = null; this.verdict = null; this.verdictState = 'idle'; }
            if (this.el.hidden && this.v) { this.dirty = true; return; }
            this.render();
        };
        this.offs = [
            ctx.data.on('dataset', onChange('dataset')),
            ctx.data.on('settings', onChange('settings')),
            ctx.data.on('status', onChange('status')),
            ctx.data.on('scenarios', () => this.onScenarios()),
            ctx.data.on('verdict', v => this.onVerdict(v)),
        ];
        this.render();
    },

    show(params) {
        const p = params || {};
        const changed = (p.scenario || null) !== (this.params?.scenario || null) || (p.array || null) !== (this.params?.array || null);
        this.params = p;
        if (changed || this.dirty) { this.dirty = false; this.render(); }
    },

    /** Leaving the tab mid-render: stop our own sweep so the tab the user went to gets the worker. */
    hide() {
        if (!this.busy) return;
        this.token++;
        this.busy = false;
        this.sweepJob?.cancel?.();
        this.sweepJob = null;
        this.dirty = true;
    },

    unmount() {
        this.offs?.forEach(off => off());
        this.sweepJob?.cancel?.();
        this.teardown();
    },

    teardown() {
        if (!this.v) return;
        for (const c of Object.values(this.v.charts)) c?.destroy();
        this.v = null;
    },

    /* ── settings & helpers ─────────────────────────────────────────────── */

    financeOpts() {
        const s = this.ctx.store.get().settings || {};
        return { ...(s.finance || {}), vatReturns: s.vatReturns !== false };
    },
    settingsKey() {
        const st = this.ctx.store.get();
        return `${st.dataset?.id ?? ''}|${stable(this.financeOpts())}|${st.settings?.projectBaseW ?? ''}|${st.settings?.maxPaybackYears ?? 10}|${stable(st.settings?.spots || [])}`;
    },
    pref(key) { return !!this.ctx.store.get().ui?.chartTables?.[`orientation.${key}`]; },
    setPref(key, on) {
        if (this.pref(key) === !!on) return;
        this.ctx.store.set({ ui: { chartTables: { [`orientation.${key}`]: !!on } } });
    },
    metricDef() { return METRICS.find(m => m.id === this.metric) || METRICS[0]; },
    fmtMetric(id) {
        const { fmt } = this.ctx;
        return {
            gbp: v => fmt.gbp(v),
            kwh: v => `${fmt.num(v)} kWh`,
            ppk: v => fmt.p(v),
            peak: v => fmt.pct(v, { dp: 0 }),
        }[id] || (v => fmt.num(v));
    },
    dirLabel(az, tilt) {
        const { fmt } = this.ctx;
        return tilt === 0 ? 'Flat (0°)' : `${fmt.compass(az)} ${az}° · ${tilt}°`;
    },
    shortDir(az, tilt) {
        const { fmt } = this.ctx;
        return tilt === 0 ? 'flat' : `${fmt.compass(az)} ${tilt}°`;
    },

    /** Charts: create once, update afterwards; table-twin state remembered per device. */
    chart(key, create, host, spec) {
        const v = this.v;
        const full = { ...spec, table: this.pref(`table.${key}`), onTable: on => this.setPref(`table.${key}`, on) };
        const c = v.charts[key];
        if (c) c.update(full);
        else v.charts[key] = create(host, full);
        host.querySelector('.chart-toggle')?.setAttribute('aria-label', `Table: ${spec.title || spec.ariaLabel}`);
    },

    setStale(on) {
        if (!this.v) return;
        this.v.root.classList.toggle('is-stale', !!on);
        if (on) this.v.root.setAttribute('aria-busy', 'true'); else this.v.root.removeAttribute('aria-busy');
    },

    announce(text) { if (this.v) this.v.parts.live.textContent = text; },

    /* ── render pipeline ────────────────────────────────────────────────── */

    async render() {
        const { ui, data } = this.ctx;
        // The connect card shows its own progress and errors: leave it alone until data arrives.
        if (!data.summary() && this.el.querySelector('.connect-card')) return;
        const token = ++this.token;
        this.sweepJob?.cancel?.();
        this.sweepJob = null;
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
        if (summary.engineUnavailable) {
            this.teardown();
            this.el.replaceChildren(this.errorCard({ message: 'The simulation engine isn’t available, so directions can’t be compared. Your usage figures still work.' }, false));
            return;
        }
        if (!this.v || this.v.dsId !== summary.id) {
            this.teardown();
            this.el.replaceChildren(this.build(summary));
        } else {
            this.setStale(true);
            this.v.parts.error.hidden = true;
        }
        this.status('Gathering the options…', true);
        this.busy = true;

        try {
            // 1. the options, and which one to point
            const scenarios = await data.autoScenarios();
            if (token !== this.token) return;
            this.scenarios = scenarios;
            const sel = await this.resolveSelection(scenarios, token);
            if (!sel || token !== this.token) return;
            const prevKey = this.sel?.key;
            const runKey = `${this.settingsKey()}|${sel.key}`;
            this.sel = sel;
            if (prevKey !== sel.key) { this.pick = null; this.runs = new Map(); this.sweep = null; }
            else if (this.runKey !== runKey) {
                // same kit, new data or settings: keep the pick's direction, drop every figure
                this.runs = new Map();
                if (this.pick) { this.pick.run = null; this.pick.failed = false; }
            }
            this.runKey = runKey;
            this.fillHead(summary);
            this.fillControls();

            // 2. the sweep (the rose and the named points)
            const sweep = await this.runSweep(sel, token);
            if (!sweep || token !== this.token) return;
            this.sweep = sweep;
            this.cellMap = new Map(sweep.cells.map(c => [`${c.az}|${c.tilt}`, c]));
            if (this.pick) this.pick.cell = this.cellAt(this.pick.az, this.pick.tilt);
            if (this.view === 'sun' && !sweep.station) {
                const cur = this.starred('current');
                if (cur && !cur.mixed && cur.tilt > 0 && (cur.az < 90 || cur.az > 270)) this.view = 'all';
            }
            if (sweep.station && this.metric === 'peak') this.metric = 'gbp';
            this.status('', false);
            this.v.root.classList.remove('is-old', 'is-empty');
            this.fillAnswer();
            this.fillRose();
            this.fillNamed();
            this.fillPick();
            this.fillScatter();
            this.setStale(false);
            const best = this.starred('bestGbp');
            if (best) this.announce(`Directions compared. Best for money: ${this.dirLabel(best.az, best.tilt)}, ${this.ctx.fmt.gbp(best.gbp)} a year.`);

            // 3. full simulations behind the hour-of-day lines and the monthly shares
            await this.runNamed(token);
            if (token !== this.token) return;
            this.busy = false;
            this.fillLines();
            this.fillMonthly();

            // 4. the verdict's flip checks, when it's about this kit (never delays the above)
            this.loadVerdict(token);
        } catch (err) {
            if (err?.name === 'AbortError' || token !== this.token) return;
            this.busy = false;
            console.warn('orientation view failed', err);
            this.status('', false);
            this.setStale(false);
            // What's still on screen: figures for this kit from an earlier run (dim them, the
            // notice says so), or another kit's entirely (hide them — the header already names
            // the new kit, so they'd read as its numbers).
            this.v?.root.classList.toggle('is-old', !!this.sweep);
            this.v?.root.classList.toggle('is-empty', !this.sweep);
            this.showError(err);
        }
    },

    /** Progress line + bar above the rose. */
    status(text, busy, pct = null) {
        if (!this.v) return;
        const P = this.v.parts;
        P.status.textContent = text || '';
        P.progress.hidden = !busy;
        P.progress.classList.toggle('is-indeterminate', busy && !finite(pct));
        P.progressBar.style.width = finite(pct) ? `${Math.max(2, Math.min(100, pct))}%` : '';
        if (busy && finite(pct)) {
            P.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
        } else P.progress.removeAttribute('aria-valuenow');
    },

    /**
     * Which system to point: ?scenario=<id> (saved or automatic) → the active scenario → the best
     * plug-in kit. Systems with no panels fall through to the default with a note.
     */
    async resolveSelection(scenarios, token) {
        const { store } = this.ctx;
        const saved = (store.get().scenarios?.saved || []).filter(s => s && s.id);
        const all = [...saved, ...scenarios.filter(s => !saved.some(x => x.id === s.id))];
        // A scenario this view just saved becomes the active one, but it shouldn't swap the kit on
        // screen at the next re-render: the user is still looking at the kit they re-pointed.
        const active = store.get().scenarios?.activeId || null;
        this.lastActive = active;
        const want = this.params?.scenario || (active && !this.ownSaves?.has(active) ? active : null);
        let sys = want ? all.find(s => s.id === want) : null;
        let note = null;
        if (want && !sys && this.params?.scenario) {
            // deleted while on screen (in Design, say): name it, rather than quoting its id
            note = want === this.sel?.id ? `“${this.sel.sys.name}” isn’t in your saved scenarios any more, so this shows the best plug-in kit instead.`
                : `Couldn’t find the scenario “${want}”, so this shows the best plug-in kit instead.`;
        }
        else if (sys && !hasPanels(sys)) {
            note = `“${sys.name}” has no panels to point, so this shows the best plug-in kit instead.`;
            sys = null;
        }
        let isDefault = false;
        if (!sys) {
            this.status('Finding the best plug-in kit for you…', true);
            const id = await this.bestPlugin(scenarios, token);
            if (token !== this.token) return null;
            sys = scenarios.find(s => s.id === id) || scenarios.find(hasPanels);
            isDefault = true;
        }
        if (!sys) throw Object.assign(new Error('None of the options has panels to point.'), { code: 'NO_PANELS' });
        if (saved.some(s => s.id === sys.id)) {
            // saved scenarios may predate defaults: let the engine fill them in, as Design would
            try { sys = await this.ctx.engine.call('normalizeSystem', sys); } catch { /* use as stored */ }
            if (token !== this.token) return null;
        }
        let arrayId = this.params?.array || '*';
        let tg = targetOf(sys, arrayId);
        if (arrayId !== '*' && (!tg || tg.index < 0)) { arrayId = '*'; tg = targetOf(sys, '*'); }
        const v = this.v;
        if (v) {
            v.parts.notice.hidden = !note;
            v.parts.notice.replaceChildren(note ? this.ctx.ui.h('div', { class: 'notice' }, this.ctx.ui.icon('info'), this.ctx.ui.h('span', null, note)) : '');
        }
        const station = !!tg?.station;
        const ownStation = stationArrays(sys).some(panelsOf);
        return {
            id: sys.id, sys, arrayId, tg, isDefault,
            saved: saved.some(s => s.id === sys.id),
            station,
            battery: !!sys.battery && !station,
            // what the battery is called in copy: a power station is not "your battery"
            batteryNoun: sys.battery?.coupling === 'ups' ? 'the power station' : 'the battery',
            // some panels stay put while these move: kWh figures are the whole system's
            partial: leavesPanelsFixed(sys, tg),
            moved: station ? (tg.index < 0 ? 'the power station’s own panels' : 'that station panel')
                : tg?.index >= 0 ? 'that panel set' : ownStation ? 'the plug-in panels' : 'the panels',
            fixed: !station && tg?.index < 0 && ownStation ? 'the power station’s own panels'
                : station && tg.index < 0 && (sys.arrays || []).some(panelsOf) ? 'the plug-in panels' : 'the other panels',
            key: `${stable(sys)}|${arrayId}`,
        };
    },

    async bestPlugin(scenarios, token) {
        const key = this.settingsKey();
        if (this.bestMemo?.key === key) return this.bestMemo.id;
        // The verdict's own choice when we've already seen it.
        const fromV = this.verdictBestPlugin(scenarios);
        if (fromV) { this.bestMemo = { key, id: fromV }; return fromV; }
        const cands = scenarios.filter(s => s.route === 'plugin' && !s.battery && (s.arrays || []).some(panelsOf));
        const results = await Promise.all(cands.map(s => this.ctx.data.scenario(s, { withBand: false }).catch(err => {
            if (err?.name === 'AbortError') throw err;
            return null;
        })));
        if (token !== this.token) return null;
        const max = this.ctx.store.get().settings?.maxPaybackYears ?? 10;
        const id = bestByNpv(results.filter(Boolean), max) || cands[0]?.id || null;
        this.bestMemo = { key, id };
        return id;
    },

    verdictBestPlugin(scenarios) {
        const v = this.verdict?.key === this.settingsKey() ? this.verdict.v : null;
        if (!v?.ranked?.length) return null;
        const ok = id => scenarios.some(s => s.id === id && s.route === 'plugin' && !s.battery && hasPanels(s));
        if (v.bestBuyId && ok(v.bestBuyId)) return v.bestBuyId;
        return v.ranked.find(r => r.route === 'plugin' && r.legal === 'ok' && ok(r.id))?.id || null;
    },

    async runSweep(sel, token) {
        const key = `${this.settingsKey()}|${sel.key}`;
        const hit = this.sweeps.get(key);
        if (hit) return hit;
        // The verdict yields to other calls between its steps, so the sweep starts within a step even
        // while the verdict is being worked out — no "waiting for the verdict" here.
        this.status(this.verdictState === 'pending' ? 'Trying every direction and tilt (the Verdict is being worked out alongside)…' : 'Trying every direction and tilt…', true);
        const job = this.ctx.engine.call('orientationSweep', sel.sys, sel.arrayId, { finance: this.financeOpts() }, {
            onProgress: p => {
                if (token !== this.token || !p) return;
                const pct = finite(p.pct) ? p.pct : null;
                const done = finite(p.done) && finite(p.total) ? `${this.ctx.fmt.num(p.done)} of ${this.ctx.fmt.num(p.total)}` : '';
                this.status(pct >= 100 ? 'Running the named directions in full…' : `Trying every direction and tilt… ${done}`, true, pct >= 100 ? null : pct);
            },
        });
        this.sweepJob = job;
        const res = await job;
        if (this.sweepJob === job) this.sweepJob = null;
        if (token !== this.token) return null;
        this.sweeps.set(key, res);
        while (this.sweeps.size > SWEEP_CACHE) this.sweeps.delete(this.sweeps.keys().next().value);
        return res;
    },

    /** A starred point by key ('bestGbp', 'current', …). */
    starred(key) { return this.sweep?.starred?.find(s => s.key === key) || null; },

    /** The proxy cell at a direction (the map's basis), if the grid has it. */
    cellAt(az, tilt) {
        if (!this.cellMap) return null;
        if (tilt === 0) return this.sweep.cells.find(c => c.tilt === 0) || null;
        return this.cellMap.get(`${az}|${tilt}`) || null;
    },

    /**
     * Distinct named directions in display order, merged when two land on the same cell. A split
     * kit swept as a whole ('*' on S02) has a 'current' with mixed: true — its panels face several
     * ways, so it is never merged with (or drawn as) a single direction.
     */
    namedPoints() {
        const out = [];
        for (const n of NAMED) {
            const s = this.starred(n.key);
            if (!s) continue;
            const same = out.find(o => sameDir(o, s));
            if (same) { same.labels.push(n.label); same.shorts.push(n.short); same.keys.push(n.key); continue; }
            out.push({ ...s, labels: [n.label], shorts: [n.short], keys: [n.key], color: n.color, key: n.key });
        }
        return out;
    },

    /** "SSW 40° + W 40°" for the targeted panels of a split kit (the mixed 'current'). */
    mixedLabel() {
        const sel = this.sel;
        const list = sel.tg.station ? stationArrays(sel.sys) : sel.sys.arrays;
        const dirs = [...new Set((list || []).filter((a, j) => sel.tg.index < 0 || j === sel.tg.index).map(a => this.shortDir(a.azimuth, a.tilt)))];
        return dirs.join(' + ');
    },

    /** Direction label of a point, spelling out a split kit's directions. */
    pointLabel(p) { return p?.mixed ? `split: ${this.mixedLabel()}` : this.dirLabel(p.az, p.tilt); },

    /** Full simulations of the line directions (memoised by the DataHub). */
    async runNamed(token) {
        const sel = this.sel;
        if (sel.station) return;
        const pts = this.namedPoints().filter(p => p.keys.some(k => LINE_KEYS.includes(k)));
        const jobs = pts.map(async p => {
            // a mixed 'current' is the system exactly as configured
            const r = await this.ctx.data.scenario(p.mixed ? sel.sys : repoint(sel.sys, sel.tg, p.az, p.tilt), { withBand: false });
            for (const k of p.keys) this.runs.set(k, r);
        });
        if (this.pick && !this.pick.run) jobs.push(this.runPick(token));
        await Promise.all(jobs);
    },

    async loadVerdict(token) {
        if (this.verdictState === 'pending' || this.verdictState === 'unavailable') return;
        if (this.verdict?.key === this.settingsKey()) { this.fillAnswer(); return; }
        this.verdictState = 'pending';
        this.fillAnswer();
        try {
            const v = await this.ctx.data.verdict();
            this.verdict = { key: this.settingsKey(), v };
            this.verdictState = 'done';
        } catch (err) {
            if (err?.name === 'AbortError') { this.verdictState = 'idle'; return; }
            this.verdictState = 'unavailable';
        }
        if (token === this.token || this.sweep) this.fillAnswer();
    },

    onVerdict(v) {
        if (!v) return;
        this.verdict = { key: this.settingsKey(), v };
        this.verdictState = 'done';
        if (this.sweep && this.v) this.fillAnswer();
    },

    onScenarios() {
        if (!this.v || !this.scenarios) return;
        const rerender = () => { if (this.el.hidden) this.dirty = true; else this.render(); };
        // With no ?scenario= the tab follows the active scenario (Design sets it to whatever it has
        // open) — except the copies this tab saves itself, which shouldn't swap the kit on screen.
        const active = this.ctx.store.get().scenarios?.activeId || null;
        if (!this.params?.scenario && active && active !== this.lastActive && active !== this.sel?.id && !this.ownSaves?.has(active)) { rerender(); return; }
        // A saved scenario changed under us (edited in Design or deleted): re-point the new version.
        const saved = this.ctx.store.get().scenarios?.saved || [];
        if (this.sel?.saved) {
            const now = saved.find(s => s.id === this.sel.id);
            if (!now || stable(now) !== stable(this.sel.sys)) {
                if (this.el.hidden) { this.dirty = true; return; }
                this.render();
                return;
            }
        }
        this.fillControls();
    },

    /**
     * The orientation answer: the verdict's answers.orientation when it is about this kit (same
     * flips everywhere), otherwise composed from this sweep (tie band from the proxy cells).
     */
    answer() {
        const st = k => this.starred(k);
        const best = st('bestGbp'), w90 = st('W90'), s35 = st('S35'), current = st('current'), most = st('bestKwh');
        if (!best) return null;
        const own = {
            best, w90, s35, current, bestKwh: most,
            tie: tieBand(this.sweep.cells), tieBandPct: TIE_PCT,
            westPays: best.az >= 240, flips: null, checked: [], source: 'sweep',
        };
        const va = this.verdict?.key === this.settingsKey() ? this.verdict.v?.answers?.orientation : null;
        if (va && !this.sel.station && this.sel.arrayId === '*' && this.matchesVerdict(va)) {
            return { ...own, ...pickFields(va), current, bestKwh: most, source: 'verdict' };
        }
        return own;
    },

    /** Is the verdict's orientation answer about the kit on screen? (id, or same current point). */
    matchesVerdict(va) {
        if (va.status && va.status !== 'ready') return false;
        const id = va.forId ?? va.systemId ?? va.scenarioId ?? null;
        if (id != null && id === this.sel.id) return true;
        // The same kit pointed another way — a re-pointed copy saved from this tab, or a split kit
        // swept as a whole — has the same answer: the verdict moves every panel together too. Its
        // fixed-direction points (west wall, due south) then match the verdict's to the penny.
        const same = (p, q) => !!p && !!q && [p.gbp, p.kwh, q.gbp, q.kwh].every(finite)
            && Math.abs(p.gbp - q.gbp) <= 1e-6 * Math.max(1, Math.abs(q.gbp)) && Math.abs(p.kwh - q.kwh) <= 1e-6 * Math.max(1, Math.abs(q.kwh));
        if (same(va.w90, this.starred('W90')) && same(va.s35, this.starred('S35'))) return true;
        if (id != null) return false;
        const c = va.current, mine = this.starred('current');
        if (!c || !mine || mine.mixed) return false;
        const close = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005);
        return c.az === mine.az && c.tilt === mine.tilt && close(c.kwh, mine.kwh) && close(c.gbp, mine.gbp);
    },

    /* ── pick (click to apply) ──────────────────────────────────────────── */

    /**
     * Make (az, tilt) the pick. fromRose: picked on the rose itself — when that was the keyboard
     * (Enter/Space with focus on the rose), the rose's redraw waits until focus leaves it, because a
     * chart update resets the keyboard cursor and the next arrow press would jump back to "Now".
     */
    choose(az, tilt, { fromRose = false } = {}) {
        if (!this.sweep || !finite(az) || !finite(tilt)) return;
        const a = tilt === 0 ? 180 : ((Math.round(az) % 360) + 360) % 360;
        if (this.pick && this.pick.az === a && this.pick.tilt === tilt) return;
        this.pick = { az: a, tilt, cell: this.cellAt(a, tilt), run: null, savedId: null, failed: false };
        this.fillPick();
        const roseHost = this.v.parts.rose;
        if (fromRose && this.roseKbd && roseHost.contains(document.activeElement)) {
            if (!this.roseDeferred) {
                this.roseDeferred = true;
                roseHost.addEventListener('focusout', () => { if (this.roseDeferred) { this.roseDeferred = false; this.fillRose(); } }, { once: true });
            }
        } else this.fillRose();
        this.fillScatter();
        this.fillNamed();
        this.announce(`Picked ${this.dirLabel(a, tilt)}.`);
        if (window.matchMedia?.('(max-width: 1023px)').matches) this.v.parts.pickCard.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        const token = this.token;
        this.runPick(token).then(() => {
            if (token !== this.token) return;
            this.fillPick();
            this.fillLines();
            this.fillMonthly();
        }, () => {});
    },

    async runPick(token) {
        const p = this.pick;
        if (!p || !this.sel) return;
        try {
            const r = await this.ctx.data.scenario(repoint(this.sel.sys, this.sel.tg, p.az, p.tilt), { withBand: false });
            if (this.pick === p && token === this.token) p.run = r;
        } catch (err) {
            if (err?.name === 'AbortError') return;
            if (this.pick === p) { p.failed = true; this.fillPick(); }
        }
    },

    clearPick() {
        this.pick = null;
        this.fillPick();
        this.fillRose();
        this.fillScatter();
        this.fillNamed();
        this.fillLines();
        this.fillMonthly();
    },

    /** Save the picked direction as a new scenario (and make it the active one). */
    savePick() {
        const { store } = this.ctx;
        const p = this.pick;
        if (!p || !this.sel) return null;
        if (p.savedId) return p.savedId;
        const base = this.sel.sys;
        const taken = new Set((store.get().scenarios?.saved || []).map(s => s.id));
        let id;
        do { id = `orient-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; } while (taken.has(id));
        const where = this.shortDir(p.az, p.tilt);
        const sys = {
            ...repoint(base, this.sel.tg, p.az, p.tilt),
            id,
            name: `${base.name} · ${where}`,
            featured: false,
            notes: [...(base.notes || []), `Pointed ${this.dirLabel(p.az, p.tilt)} on the Orientation tab (from ${base.name}).`],
        };
        (this.ownSaves ??= new Set()).add(id);
        store.update('scenarios', s => ({ ...s, saved: [...(s?.saved || []), sys], activeId: id }));
        p.savedId = id;
        p.savedName = sys.name;
        // the pick card confirms it in place (role=status) with its own "Open in Design": no toast
        this.fillPick();
        this.v.parts.pick.querySelector('.ov-pick-actions .btn')?.focus();
        return id;
    },

    openInDesign() {
        const id = this.savePick();
        if (id) this.ctx.router.go('design', { scenario: id });
    },

    /* ── skeleton, build, errors ────────────────────────────────────────── */

    skeleton() {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'ov', 'aria-busy': 'true' },
            this.headEl(null),
            h('div', { class: 'ov-controls' }, ui.skeleton({ lines: 1 })),
            ui.card({ accent: true, className: 'ov-hero', body: h('div', { class: 'ov-hero-grid' },
                h('div', null, ui.skeleton({ lines: 5 })), h('div', { class: 'ov-side' }, ui.skeleton({ height: 150 }), ui.skeleton({ lines: 3 }))) }),
            h('div', { class: 'ov-main' },
                ui.card({ title: 'The solar rose', body: ui.skeleton({ height: 380 }) }),
                h('div', { class: 'ov-col' }, ui.card({ title: 'Try a direction', body: ui.skeleton({ lines: 3 }) }), ui.card({ title: 'Named directions', body: ui.skeleton({ lines: 6 }) }))));
    },

    headEl(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'view-head' }, h('div', null,
            h('div', { class: 'view-kicker' }, 'Orientation'),
            h('h1', { class: 'view-title', tabindex: '-1' }, 'Which way should the panels face?'),
            h('div', { class: 'ov-context' }, h('p', { class: 'context-line' }, summary ? '' : 'Every direction and tilt, simulated against your half-hours.'))));
    },

    errorCard(err, retry = true) {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'ov' }, this.headEl(null),
            ui.card({ body: h('div', { class: 'ov-error' },
                h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'), h('span', null, err?.message || String(err))),
                h('div', { class: 'row' },
                    retry ? ui.button({ label: 'Try again', icon: 'refresh', onClick: () => this.render() }) : null,
                    ui.button({ label: 'Check your data', kind: 'ghost', href: '#data', icon: 'arrowRight' }))) }));
    },

    showError(err) {
        const { ui } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        if (!P) { this.el.replaceChildren(this.errorCard(err)); return; }
        P.error.replaceChildren(h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'),
            h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
                h('div', null, `Couldn’t compare directions: ${err?.message || err}`),
                this.sweep ? h('div', { class: 'muted', style: { fontSize: '13px', marginTop: '2px' } }, 'What you see below is from the last successful run.') : null),
            ui.button({ label: 'Try again', icon: 'refresh', size: 'sm', onClick: () => this.render() })));
        P.error.hidden = false;
    },

    build(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = {};
        p.head = this.headEl(summary);
        p.context = p.head.querySelector('.context-line');
        p.notice = h('div', { class: 'ov-notice', hidden: true });
        p.error = h('div', { hidden: true });
        p.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });

        // controls
        p.kitHost = h('div', { class: 'ov-kit' });
        p.panelsHost = h('div', { class: 'ov-panels', hidden: true });
        p.basis = h('p', { class: 'ov-basis' });
        p.controls = h('section', { class: 'ov-controls', 'aria-label': 'What to point' }, p.kitHost, p.panelsHost, p.basis);

        // answer
        p.answer = h('div', { 'aria-live': 'polite' }, this.ctx.ui.skeleton({ lines: 5 }));
        p.side = h('div', { class: 'ov-side' }, ui.skeleton({ height: 150 }), ui.skeleton({ lines: 3 }));
        p.hero = ui.card({ accent: true, className: 'ov-hero ov-dyn', body: h('div', { class: 'ov-hero-grid' }, p.answer, p.side) });
        p.heroFoot = h('div', { class: 'ov-foot' });
        p.hero.querySelector('.card-body').appendChild(p.heroFoot);

        // rose
        p.metricHost = h('div');
        p.viewHost = h('div');
        p.status = h('div', { class: 'ov-status', 'aria-live': 'off' });
        p.progressBar = h('div', { class: 'ov-progress-bar' });
        p.progress = h('div', { class: 'ov-progress', role: 'progressbar', 'aria-label': 'Comparing directions', 'aria-valuemin': 0, 'aria-valuemax': 100, hidden: true }, p.progressBar);
        p.rose = h('div', { class: 'ov-untitled' }, ui.skeleton({ height: 380 }));
        // was the last pick on the rose made from the keyboard? (see choose())
        p.rose.addEventListener('keydown', e => { this.roseKbd = e.key === 'Enter' || e.key === ' '; }, true);
        p.rose.addEventListener('pointerdown', () => { this.roseKbd = false; }, true);
        p.roseKey = h('div', { class: 'ov-key' });
        p.roseNote = h('p', { class: 'ov-note' });
        p.roseWrap = h('div', { class: 'ov-rose-wrap' }, p.rose, p.roseKey, p.roseNote);
        p.top = h('ol', { class: 'ov-top', 'aria-label': 'Top 10 directions' });
        p.topCap = h('p', { class: 'ov-top-cap' });
        p.roseBtn = h('button', { type: 'button', class: 'btn btn-ghost ov-rose-btn', 'aria-expanded': 'false' }, ui.icon('sun'), h('span', null, 'Show rose'));
        p.roseSub = h('span');
        p.roseCard = ui.card({
            title: 'The solar rose', subtitle: p.roseSub, className: 'ov-rose-card ov-dyn',
            body: [h('div', { class: 'ov-toolbar' }, p.metricHost, p.viewHost), p.progress, p.status, p.topCap, p.top, p.roseBtn, p.roseWrap],
        });
        p.roseBtn.addEventListener('click', () => {
            const on = !p.roseCard.classList.contains('show-rose');
            p.roseCard.classList.toggle('show-rose', on);
            p.roseBtn.setAttribute('aria-expanded', String(on));
            p.roseBtn.querySelector('span').textContent = on ? 'Hide rose' : 'Show rose';
        });

        // pick + named
        p.pick = h('div');
        p.pickCard = ui.card({ eyebrow: [h('span', { class: 'ov-xs-long' }, 'Click to try'), h('span', { class: 'ov-xs-short' }, 'Tap to try')], title: 'Try a direction', className: 'ov-pick-card', body: p.pick });
        p.named = h('div', { class: 'ov-named' }, ui.skeleton({ lines: 6 }));
        p.namedSub = h('span');
        p.namedCard = ui.card({ title: 'Named directions', subtitle: p.namedSub, className: 'ov-dyn', body: p.named });

        // energy vs value + hour of day
        p.scatter = h('div', { class: 'ov-untitled' }, ui.skeleton({ height: 340 }));
        p.scatterTake = h('p', { class: 'ov-take' });
        p.scatterSub = h('span');
        p.lines = h('div', { class: 'ov-untitled' }, ui.skeleton({ height: 290 }));
        p.linesTake = h('p', { class: 'ov-take' });
        p.linesSub = h('span');
        p.scatterCard = ui.card({ eyebrow: 'The trade-off', title: 'Energy vs value', subtitle: p.scatterSub, className: 'ov-dyn', body: [p.scatterTake, p.scatter] });
        p.linesCard = ui.card({ eyebrow: 'Time of day', title: 'When each direction makes its power', subtitle: p.linesSub, className: 'ov-dyn', body: [p.linesTake, p.lines] });

        // monthly
        p.monthly = h('div', { class: 'ov-untitled' }, ui.skeleton({ height: 280 }));
        p.monthlySide = h('aside', { class: 'ov-month-side', 'aria-label': 'About the 4–7pm share' });
        p.monthlyCard = ui.card({
            eyebrow: 'Season', title: 'How much lands in the 4–7pm peak, month by month',
            subtitle: 'Share of each month’s output made between 4 and 7pm (local time), typical-year sunshine',
            className: 'ov-dyn', body: h('div', { class: 'ov-month' }, p.monthly, p.monthlySide),
        });

        const root = h('div', { class: 'ov', 'aria-busy': 'true' },
            p.head, p.controls, p.notice, p.error, p.live,
            p.hero,
            h('div', { class: 'ov-main' }, p.roseCard, h('div', { class: 'ov-col' }, p.pickCard, p.namedCard)),
            h('div', { class: 'ov-grid' }, p.scatterCard, p.linesCard),
            p.monthlyCard);
        this.v = { dsId: summary.id, root, parts: p, charts: {} };
        this.fillPick();
        return root;
    },

    /* ── fills ──────────────────────────────────────────────────────────── */

    /**
     * The engine's default install date (the 1st of next month) on the UK calendar — SolarEngine
     * uses the Europe/London month, so a UTC month would be a month out late on the last day.
     */
    installMs() {
        const fo = this.financeOpts();
        if (fo.installDate) return Date.parse(`${fo.installDate}T12:00:00Z`);
        let y, m;
        try {
            const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric' }).formatToParts(new Date());
            y = +parts.find(p => p.type === 'year').value;
            m = +parts.find(p => p.type === 'month').value;   // 1–12
        } catch {
            const d = new Date();
            y = d.getUTCFullYear(); m = d.getUTCMonth() + 1;
        }
        return Date.UTC(m === 12 ? y + 1 : y, m % 12, 1, 12);
    },

    fillHead(summary) {
        const { fmt, ui } = this.ctx;
        const h = ui.h;
        const P = this.v.parts;
        const sel = this.sel;
        const d = s => (s ? fmt.date(Date.parse(`${s}T12:00:00Z`)) : '?');
        const panels = this.panelSummary(sel);
        P.context.replaceChildren(
            h('b', null, sel.sys.name), panels ? ` · ${panels}` : '',
            ` · ${Math.round(summary.days || 0)} days of your use (${d(summary.from)} – ${d(summary.to)})`,
            summary.postcode ? ` · ${summary.postcode}` : '');
    },

    panelSummary(sel) {
        const { fmt } = this.ctx;
        const list = sel.station ? stationArrays(sel.sys) : (sel.sys.arrays || []);
        const n = list.reduce((a, x) => a + (x.count || 0), 0);
        const wp = list.reduce((a, x) => a + (x.count || 0) * (x.wp || 0), 0);
        if (!n) return '';
        const acW = sel.sys.inverter?.acLimitW;
        const an = finite(acW) && /^(8|11|18)/.test(String(Math.round(acW))) ? 'an' : 'a';
        const ac = !sel.station && finite(acW) ? ` on ${an} ${fmt.w(acW)} inverter` : sel.station ? ' on the power station' : '';
        return `${n} panel${n === 1 ? '' : 's'}, ${fmt.w(wp)}${ac}`;
    },

    fillControls() {
        const { ui, store, router, fmt } = this.ctx;
        const h = ui.h;
        const P = this.v.parts;
        const sel = this.sel;
        if (!sel || !this.scenarios) return;
        const saved = (store.get().scenarios?.saved || []).filter(hasPanels);
        const groups = [
            ['Your saved scenarios', saved],
            ['Plug-in kits', this.scenarios.filter(s => s.route === 'plugin' && hasPanels(s))],
            ['Electrician-installed', this.scenarios.filter(s => s.route === 'hardwired' && hasPanels(s))],
            ['Power stations with panels', this.scenarios.filter(s => s.route === 'ups' && hasPanels(s))],
            ['Future rules (what-if)', this.scenarios.filter(s => s.route === 'whatif' && hasPanels(s))],
        ];
        const seen = new Set();
        const bestId = this.bestMemo?.id;
        const options = [];
        for (const [group, list] of groups) for (const s of list) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            options.push({ value: s.id, label: `${s.name}${s.id === bestId ? ' — best plug-in' : ''}`, group });
        }
        if (!seen.has(sel.id)) options.unshift({ value: sel.id, label: sel.sys.name });
        const select = ui.select({
            options, value: sel.id, ariaLabel: 'Kit to point',
            onChange: id => router.replace('orientation', { scenario: id }),
        });
        P.kitHost.replaceChildren(ui.field({ label: 'Kit to point', input: select }));

        // which panels, for systems with more than one thing to point
        const arrays = sel.sys.arrays || [];
        const st = stationArrays(sel.sys);
        const choices = [];
        if (arrays.length > 1 || (arrays.length && st.length)) choices.push({ value: '*', label: arrays.length > 1 ? 'All together' : 'Kit panels' });
        else if (!arrays.length && st.length > 1) choices.push({ value: '*', label: 'All together' });
        // each set says where it faces now, so "Input 2" on a split kit reads as "the west one"
        const now = a => this.shortDir(a.azimuth, a.tilt);
        if (arrays.length > 1) arrays.forEach((a, i) => choices.push({ value: a.id, label: `${a.name && !/^panels$/i.test(a.name) ? a.name : `Panel set ${i + 1}`} · ${now(a)}`, title: `${a.count} × ${a.wp} W, facing ${now(a)} now` }));
        if (arrays.length && st.length) st.forEach((a, i) => choices.push({ value: a.id, label: `${st.length > 1 ? `Station panel ${i + 1}` : 'Station panels'} · ${now(a)}`, title: `${a.count} × ${a.wp} W on the power station’s own input` }));
        else if (st.length > 1) st.forEach((a, i) => choices.push({ value: a.id, label: `Station panel ${i + 1} · ${now(a)}`, title: `${a.count} × ${a.wp} W` }));
        P.panelsHost.hidden = choices.length < 2;
        if (choices.length >= 2) {
            const seg = ui.segmented({
                options: choices, value: sel.arrayId, ariaLabel: 'Which panels to point',
                onChange: v => router.replace('orientation', { scenario: sel.id, array: v === '*' ? null : v }),
            });
            P.panelsHost.replaceChildren(ui.field({ label: 'Which panels', input: seg }));
        }
        const install = fmt.date(this.installMs());
        const projW = store.get().settings?.projectBaseW;
        P.basis.replaceChildren(
            h('b', null, 'Typical-year sunshine'), ' · first-year £ at forward prices (install ', install, ')',
            finite(projW) ? h('span', null, ' · always-on load projected at ', h('b', null, fmt.w(projW))) : '',
            sel.battery ? h('span', null, ' · ', h('b', null, `with ${sel.batteryNoun}`), ' in the named directions') : '');
    },

    fillAnswer() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        if (!P || !this.sweep) return;
        const a = this.answer();
        if (!a) { P.answer.replaceChildren(h('p', { class: 'muted' }, 'No directions to compare.')); return; }
        const sel = this.sel;
        const { best, w90, s35, current, tie } = a;
        const dir = (az, tilt) => h('span', { class: 'ov-dir' }, tilt === 0 ? 'flat' : fmt.compass(az));
        const B = t => h('b', null, t);

        let question, title, body;
        if (!a.westPays) {
            question = 'Should they face west for the 4–7pm peak?';
            title = ['No — face them ', dir(best.az, best.tilt), best.tilt > 0 ? `, tilted about ${best.tilt}°.` : '.'];
            body = [];
            if (w90 && best) {
                const less = best.kwh > 0 ? Math.round(100 * (1 - w90.kwh / best.kwh)) : 0;
                // When other panels stay put, every kWh figure is the whole system's: say so, and
                // leave out the 4–7pm share (it isn't the moved panels' alone).
                if (sel.partial) {
                    body.push(`With ${sel.moved} on a west-facing wall, the whole system would make `, B(`${fmt.num(w90.kwh)} kWh`), ' a year instead of ',
                        B(`${fmt.num(best.kwh)}`), ` (${less}% less; ${sel.fixed} stay as they are). `);
                } else {
                    body.push('On a west-facing wall they’d make ', B(`${fmt.num(w90.kwh)} kWh`), ' a year instead of ', B(`${fmt.num(best.kwh)}`),
                        ` (${less}% less). `);
                }
                if (w90.pPerKwh > best.pPerKwh + 0.05) {
                    body.push(sel.partial ? 'Each kWh is worth more (' : 'Each of those kWh is worth more (', B(fmt.p(w90.pPerKwh)), ' vs ', B(fmt.p(best.pPerKwh)), ')');
                    if (!sel.station && !sel.partial && finite(w90.peakSharePct) && w90.peakSharePct > 0) body.push(' because ', B(fmt.pct(w90.peakSharePct, { dp: 0 })), ' lands in the 4–7pm peak');
                    body.push(', but that doesn’t make up for the lost energy: ');
                } else body.push('Each of those kWh is worth about the same (', B(fmt.p(w90.pPerKwh)), ' vs ', B(fmt.p(best.pPerKwh)), '), so the lost energy is lost money: ');
                body.push(B(fmt.gbp(w90.gbp)), ' vs ', B(fmt.gbp(best.gbp)), ' a year. ');
            }
            body.push('There’s little or no sun after 4pm from November to February.');
        } else {
            question = 'Should they face west for the 4–7pm peak?';
            title = ['Yes — for you, west pays: face them ', dir(best.az, best.tilt), best.tilt > 0 ? ` at ${best.tilt}°.` : '.'];
            body = [B(`${fmt.compass(best.az)} ${best.tilt}°`), ' makes ', B(fmt.gbp(best.gbp)), ' a year',
                s35 ? [' vs ', B(fmt.gbp(s35.gbp)), ' facing south at 35°.'] : '.'];
        }

        // energy × value per kWh = money: the whole west-wall argument in three numbers
        let eq = null;
        if (w90 && best && best.kwh > 0 && best.pPerKwh > 0 && best.gbp > 0 && (w90.az !== best.az || w90.tilt !== best.tilt)) {
            const ch = (a, b) => (100 * (a - b)) / b;
            const cell = (label, d, sub, cls) => h('div', { class: ['ov-eq-cell', cls] },
                h('div', { class: 'ov-eq-label' }, Array.isArray(label)
                    ? [h('span', { class: 'ov-long' }, label[0]), h('span', { class: 'ov-short' }, label[1])] : label),
                h('div', { class: ['ov-eq-val', d < -0.5 ? 'is-down' : d > 0.5 ? 'is-up' : null] }, `${d > 0.5 ? '+' : d < -0.5 ? '−' : '±'}${fmt.num(Math.abs(d))}%`),
                h('div', { class: 'ov-eq-sub' }, sub));
            const eqTitle = sel.partial ? 'The whole system: west wall against the best direction' : 'A west wall against the best direction';
            eq = h('div', { class: 'ov-eq', role: 'group', 'aria-label': eqTitle },
                h('div', { class: 'ov-eq-title' }, eqTitle),
                h('div', { class: 'ov-eq-row' },
                    cell('Energy', ch(w90.kwh, best.kwh), `${fmt.num(w90.kwh)} vs ${fmt.num(best.kwh)} kWh`),
                    h('span', { class: 'ov-eq-op', 'aria-hidden': 'true' }, '×'),
                    cell(['Worth per kWh', 'Per kWh'], ch(w90.pPerKwh, best.pPerKwh), `${fmt.p(w90.pPerKwh)} vs ${fmt.p(best.pPerKwh)}`),
                    h('span', { class: 'ov-eq-op', 'aria-hidden': 'true' }, '='),
                    cell('Money', ch(w90.gbp, best.gbp), `${fmt.gbp(w90.gbp)} vs ${fmt.gbp(best.gbp)} a year`, 'is-result')));
        }

        const tieEl = tie ? h('p', { class: 'ov-tie' },
            tie.azMin === tie.azMax && tie.tiltMin === tie.tiltMax
                ? ['Only ', B(`${fmt.compass(tie.azMin)} at ${tie.tiltMin}°`), ` is within ${a.tieBandPct}% of the best.`]
                : ['Anything from ', B(fmt.compass(tie.azMin)), ' to ', B(fmt.compass(tie.azMax)), ' at ', B(`${tie.tiltMin}–${tie.tiltMax}°`),
                    ` is within ${a.tieBandPct ?? TIE_PCT}% of the best — pick what fits.`]) : null;

        const more = [];
        // as set now
        const nowDiffers = current && best && !sameDir(current, best);
        if (nowDiffers) {
            const diff = best.gbp - current.gbp;
            const inTie = !current.mixed && tie && current.tilt >= tie.tiltMin && current.tilt <= tie.tiltMax && inArc(current.az, tie.azMin, tie.azMax);
            more.push(h('span', null, 'As set now (', B(this.pointLabel(current)), ') they’d save ', B(fmt.gbp(current.gbp)), ' a year',
                diff > 0.5 ? [' — ', B(fmt.gbp(diff)), ` (${(100 * diff) / best.gbp < 1 ? 'under 1%' : fmt.pct((100 * diff) / best.gbp, { dp: 0 })}) less than the best.`] : '.',
                inTie ? ' That’s inside the band, so there’s no need to move them.' : ''));
        }
        // flips
        if (Array.isArray(a.flips)) {
            // C1 (≈150 W always-on load + Outgoing Prime) adds nothing when Outgoing Prime alone
            // (C2) lands on the same direction — e.g. when the load is already projected to 150 W.
            const flips = a.flips.filter(f => !(f.condition === 'C1' && a.flips.some(g => g.condition === 'C2' && g.az === f.az && g.tilt === f.tilt)));
            if (flips.length) {
                for (const f of flips) {
                    more.push(h('span', { class: 'ov-flip' }, `This changes if ${f.text || FLIP_SHORT[f.condition] || f.condition}: best becomes `,
                        B(`${f.compass || fmt.compass(f.az)} ${f.tilt}°`), finite(f.gbp) ? ` (${fmt.gbp(f.gbp)}/yr).` : '.'));
                }
            } else if (a.checked?.length) {
                // C1 already includes Outgoing Prime: name it once (the verdict words it the same way)
                const names = a.checked.filter(c => c !== 'C2' || !a.checked.includes('C1')).map(c => FLIP_SHORT[c]).filter(Boolean);
                if (names.length) more.push(h('span', { class: 'ov-flip' }, `${cap(listJoin(names))} wouldn’t change it.`));
            }
        } else if (this.verdictState === 'pending' && !sel.station && sel.arrayId === '*' && (sel.isDefault || sel.id === 'S01')) {
            // the verdict answers for its best buy (else S01), so only promise flips for that kit
            more.push(h('span', { class: 'ov-pending' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }),
                'Checking whether Outgoing Prime, more panels or a battery would change this…'));
        } else {
            // The flip checks only exist for the Verdict's kit: say where they are, don't go silent.
            const va = this.verdict?.key === this.settingsKey() ? this.verdict.v?.answers?.orientation : null;
            if (va?.status === 'ready' && va.forId && !sel.station) {
                if (sel.arrayId !== '*' && this.matchesVerdict(va)) {
                    more.push(h('span', { class: 'ov-flip' }, 'Whether Outgoing Prime, more panels or a battery would change the answer is checked with every panel moving together — choose ',
                        h('b', null, 'All together'), ' above to see.'));
                } else if (va.forId !== sel.id) {
                    more.push(h('span', { class: 'ov-flip' }, 'Whether Outgoing Prime, more panels or a battery would change the answer is checked for the Verdict’s kit, ',
                        h('b', null, va.forName || va.forId), ' — pick it above to see.'));
                }
            }
        }

        put(P.answer,
            h('div', { class: 'ov-q' }, question),
            h('h2', { class: 'ov-answer' }, title),
            h('p', { class: 'ov-body' }, body),
            eq,
            tieEl,
            more.length ? h('div', { class: 'ov-more' }, more) : null);

        // side: dial + readout
        const rows = [];
        if (w90 && !sameDir(w90, best)) rows.push(['On a west wall', 'W 270° · vertical', w90]);
        if (s35 && !sameDir(s35, best)) rows.push(['Due south', 'S 180° · 35°', s35]);
        if (nowDiffers) rows.push(['As set now', this.pointLabel(current), current]);
        const pctOf = x => (best.gbp > 0 ? Math.round((100 * (x.gbp - best.gbp)) / best.gbp) : 0);
        put(P.side,
            orientationDial(h, fmt, { best, tie, w90, current }),
            h('div', { class: 'ov-dial-key', 'aria-hidden': 'true' },
                h('span', null, h('span', { class: 'ov-k ov-k-tie' }), `within ${a.tieBandPct ?? TIE_PCT}%`),
                h('span', null, h('span', { class: 'ov-k ov-k-best' }), 'best'),
                h('span', null, h('span', { class: 'ov-k ov-k-west' }), 'west wall'),
                nowDiffers && !current.mixed && !sameDir(current, w90) ? h('span', null, h('span', { class: 'ov-k ov-k-now' }), 'as set now') : null),
            h('div', null,
                h('div', { class: 'ov-readout-label' }, 'The best direction saves'),
                h('div', { class: 'ov-readout-fig' }, fmt.gbp(best.gbp), h('small', null, 'a year')),
                h('div', { class: 'ov-readout-sub' }, `${this.dirLabel(best.az, best.tilt)} · ${fmt.num(best.kwh)} kWh · ${fmt.p(best.pPerKwh)}/kWh`)),
            rows.length ? h('dl', { class: 'ov-rows' }, rows.map(([lab, sub, x]) => h('div', { class: 'ov-row' },
                h('dt', null, lab, h('small', null, sub)),
                h('dd', null, fmt.gbp(x.gbp), h('small', null, pctOf(x) === 0 ? 'same' : `${pctOf(x) > 0 ? '+' : '−'}${Math.abs(pctOf(x))}%`))))) : null);

        const src = a.source === 'verdict' ? 'Same answer as the Verdict' : 'Named directions fully simulated';
        // Method's "Where panels can go" section (#method?s=spots) holds the mount-spot editor
        const spots = (this.ctx.store.get().settings?.spots || []).length;
        P.heroFoot.replaceChildren(
            `${src} · typical-year sunshine · first-year £ at forward prices${sel.battery ? `, with ${sel.batteryNoun}` : ''}. `,
            spots ? `Every direction is shown here, not only your ${spots} mount spot${spots === 1 ? '' : 's'} — ` : 'This assumes the panels could face any way — ',
            h('a', { href: '#method?s=spots' }, spots ? 'change where they can go' : 'tell us where they can actually go'), '.');
    },

    fillRose() {
        const { ui, charts, fmt } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        const sw = this.sweep;
        if (!P || !sw) return;
        const sel = this.sel;
        const station = !!sw.station;
        // metric + view toggles
        const metrics = METRICS.filter(m => !(station && m.id === 'peak'));
        // phones: short labels keep the four options on one row — swapped by CSS, so a resize
        // (or a phone turned sideways) gets the right ones without a re-render
        const label = m => [h('span', { class: 'ov-xs-long' }, m.label),
            h('span', { class: 'ov-xs-short' }, h('span', { 'aria-hidden': 'true' }, m.short), h('span', { class: 'sr-only' }, m.label))];
        P.metricHost.replaceChildren(ui.segmented({
            options: metrics.map(m => ({ value: m.id, label: label(m), title: m.unit })), value: this.metric, size: 'sm', ariaLabel: 'Colour the rose by',
            onChange: v => { this.metric = v; this.fillRose(); this.fillTop(); },
        }));
        P.viewHost.replaceChildren(station ? '' : ui.segmented({
            options: [{ value: 'sun', label: 'Sun side', title: 'East through south to west' }, { value: 'all', label: 'All round', title: 'Every direction, north included' }],
            value: this.view, size: 'sm', ariaLabel: 'Directions shown',
            onChange: v => { this.view = v; this.fillRose(); this.fillTop(); },
        }));

        const m = this.metricDef();
        const f = this.fmtMetric(m.id);
        const sun = this.view === 'sun' || station;
        const grid = roseGrid(sw, m.key, sun);
        const inView = (az, tilt) => tilt === 0 || !sun || (az >= 90 && az <= 270);
        const bestKey = m.best;
        const markers = [];
        const used = new Set();
        const add = (s, label, kind) => {
            if (!s || s.mixed || !inView(s.az, s.tilt)) return;   // a split kit has no one cell to mark
            const k = `${s.az}|${s.tilt}`;
            const ex = markers.find(x => `${x.az}|${x.tilt}` === k);
            if (ex) { ex.label = `${ex.label} · ${label}`; if (kind === 'current' && ex.kind !== 'best') ex.kind = 'current'; return; }
            used.add(k);
            markers.push({ az: s.az, tilt: s.tilt, label, kind });
        };
        add(this.starred(bestKey), bestKey === 'bestKwh' ? 'Most kWh' : 'Best £', 'best');
        add(this.starred('current'), 'Now', 'current');
        add(this.starred(bestKey === 'bestKwh' ? 'bestGbp' : 'bestKwh'), bestKey === 'bestKwh' ? 'Best £' : 'Most kWh', 'reference');
        add(this.starred('W90'), 'W wall', 'reference');
        add(this.starred('S35'), 'S 35°', 'reference');
        if (this.pick) add(this.pick, 'Picked', 'reference');
        const unit = sel.battery && m.id !== 'kwh' ? `${m.unit}, panels alone` : m.unit;
        const others = METRICS.filter(x => x.id !== m.id && !(station && x.id === 'peak'));
        this.chart('rose', charts.createPolar, P.rose, {
            title: `${m.unit} by direction and tilt`,
            // no closing full stop: charts.js appends ". Use the arrow keys…"
            ariaLabel: `Solar rose: ${unit} for every direction and tilt. Centre is flat, the rim is vertical`,
            azimuths: grid.azimuths, tilts: grid.tilts, values: grid.values,
            metricLabel: unit, format: f, scale: m.ramp === 'solar' ? { hue: 'solar' } : { ramp: 'sequential' },
            markers, legendMin: 99, height: undefined,
            tipRows: (az, tilt) => {
                const c = this.cellAt(tilt === 0 ? 180 : az, tilt);
                return c ? others.map(o => ({ value: this.fmtMetric(o.id)(c[o.key]), label: o.tip })) : [];
            },
            onPick: (az, tilt) => this.choose(az, tilt, { fromRose: true }),
        });
        const what = { gbp: '£ saved a year', kwh: 'kWh made a year', ppk: 'What each kWh made is worth', peak: 'Share of the output made 4–7pm' }[m.id];
        put(P.roseSub, `${what}${sel.battery && m.id !== 'kwh' ? ' by the panels alone' : ''} for every direction (around) and tilt (flat in the middle, vertical at the rim)${sun ? ', east through south to west' : ''}. `,
            h('span', { class: 'ov-xs-long' }, 'Click a cell to try it.'), h('span', { class: 'ov-xs-short' }, 'Tap one to try it.'));
        put(P.roseKey,
            h('span', null, h('span', { class: 'ov-k ov-k-best' }), bestKey === 'bestKwh' ? 'Most energy' : 'Best for £'),
            h('span', null, h('span', { class: 'ov-k ov-k-now' }), 'As set now'),
            h('span', null, h('span', { class: 'ov-k ov-k-ref' }), 'Named directions'),
            this.pick ? h('span', null, h('span', { class: 'ov-k ov-k-ref' }), 'Picked') : null);
        P.roseNote.textContent = station
            ? `Each cell is a full run of the power station with ${sel.tg.index < 0 ? 'its own panels' : 'that panel'} pointed that way (15° steps)${sel.partial ? `, ${sel.fixed} staying as they are` : ''}. Those panels charge the station’s battery, so their output isn’t split by time of day here.`
            : `Cells are a quick estimate${sel.battery ? ` of the panels alone (without ${sel.batteryNoun})` : ''}, one sun position per half-hour; the named directions are full simulations${sel.battery ? ` including ${sel.batteryNoun}` : ''}.`;
        this.fillTop();
    },

    /** Phones: the ten best cells by the current metric (sun side unless 'All round'). */
    fillTop() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        const sw = this.sweep;
        if (!P || !sw) return;
        const m = this.metricDef();
        const f = this.fmtMetric(m.id);
        const sun = this.view === 'sun' || sw.station;
        const cells = sw.cells.filter(c => finite(c[m.key]) && (c.tilt === 0 || !sun || (c.az >= 90 && c.az <= 270)))
            .sort((a, b) => b[m.key] - a[m.key]).slice(0, 10);
        const items = cells.map((c, i) => {
            const on = this.pick && this.pick.az === c.az && this.pick.tilt === c.tilt;
            const sub = m.id === 'gbp' ? `${fmt.num(c.kwh)} kWh${sw.station ? '' : ` · ${fmt.pct(c.peakSharePct, { dp: 0 })} at 4–7pm`}`
                : `${fmt.gbp(c.gbp)} a year · ${fmt.num(c.kwh)} kWh`;
            return h('li', null, h('button', {
                type: 'button', class: 'ov-top-btn', 'aria-pressed': on ? 'true' : 'false',
                'aria-label': `${i + 1}. ${this.dirLabel(c.az, c.tilt)}: ${f(c[m.key])}, ${sub}`,
                on: { click: () => this.choose(c.az, c.tilt) },
            }, h('span', { class: 'ov-top-rank' }, String(i + 1)),
            h('span', { class: 'ov-top-dir' }, this.dirLabel(c.az, c.tilt), h('small', null, sub)),
            h('span', { class: 'ov-top-val' }, f(c[m.key]))));
        });
        // The top of the rose is usually flat: say so, or ten identical-looking £ figures read as a bug.
        const first = cells[0]?.[m.key], last = cells[cells.length - 1]?.[m.key];
        P.topCap.textContent = m.id === 'gbp' && finite(first) && finite(last) && first > 0 && first - last < 0.03 * first
            ? `All ten are within ${fmt.gbp(Math.max(1, first - last))} a year of each other — the top of the rose is flat, so pick what fits.` : '';
        put(P.top, items);
        P.top.setAttribute('aria-label', `Top 10 directions by ${m.unit}`);
    },

    fillNamed() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        if (!P || !this.sweep) return;
        const station = !!this.sweep.station;
        const best = this.starred('bestGbp');
        const rows = this.namedPoints().map(p => ({ ...p, dir: this.pointLabel(p), vsBest: best ? p.gbp - best.gbp : null }));
        const columns = [
            { key: 'dir', label: 'Direction', mobile: 'title', sortable: false, width: '42%', format: (v, r) => h('span', { class: 'ov-dircell' },
                h('span', { class: ['ov-swatch', !r.color && 'ov-swatch-none'], style: r.color ? { background: `var(--${r.color.replace(/^cat(\d)$/, 'cat-$1')})` } : null, 'aria-hidden': 'true' }),
                h('span', null, h('span', { class: 'ov-dirname' }, r.labels.join(' · ')), h('span', { class: 'ov-dirsub' }, v))) },
            { key: 'gbp', label: '£ a year', align: 'right', mobile: 'primary', format: v => fmt.gbp(v) },
            { key: 'kwh', label: 'kWh', align: 'right', format: v => fmt.num(v) },
            { key: 'pPerKwh', label: 'p/kWh', align: 'right', format: v => fmt.num(v, 1) },
        ];
        if (!station) columns.push({ key: 'peakSharePct', label: '4–7pm', align: 'right', format: v => fmt.pct(v, { dp: 0 }) });
        P.named.replaceChildren(ui.table({
            columns, rows, dense: true, caption: 'Named directions, full simulation',
            onRowClick: r => (r.mixed ? this.ctx.ui.toast('Those panels face different ways — pick one set under “Which panels” to move it.') : this.choose(r.az, r.tilt)),
            rowClass: r => (sameDir(this.pick, r) ? 'is-highlight' : ''),
        }));
        const sel = this.sel;
        put(P.namedSub, `Full simulations${sel.partial ? ' of the whole system' : ''}${sel.battery ? ` with ${sel.batteryNoun}` : ''}: £ saved a year, kWh made a year, what each kWh is worth${station ? '' : ' and the share made 4–7pm'}${sel.partial ? ` — ${sel.fixed} stay as they are` : ''}. `,
            h('span', { class: 'ov-xs-long' }, 'Click a row to try it.'), h('span', { class: 'ov-xs-short' }, 'Tap one to try it.'));
    },

    fillPick() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        if (!P) return;
        const p = this.pick;
        if (!p || !this.sweep) {
            P.pick.replaceChildren(h('div', { class: 'ov-pick-empty' }, ui.icon('info'),
                h('span', null, h('span', { class: 'ov-xs-long' }, 'Click any cell on the rose'), h('span', { class: 'ov-xs-short' }, 'Tap one of the top 10'),
                    ', a dot on the energy chart or a named direction to see what pointing the panels that way does — then save it as a scenario.')));
            return;
        }
        const best = this.starred('bestGbp');
        const station = !!this.sweep.station;
        const run = p.run;
        const hd = run?.headline;
        const c = p.cell;
        const gbp = hd ? hd.savingsGbp : c?.gbp;
        const diff = best && finite(gbp) ? gbp - best.gbp : null;
        const isBest = sameDir(best, p);
        const named = this.namedPoints().find(n => sameDir(n, p));
        const current = this.starred('current');
        const isNow = sameDir(current, p);
        let sub;
        if (isBest) sub = h('span', null, h('b', null, 'This is the best direction for £.'));
        else if (finite(diff) && Math.abs(diff) < 0.5) sub = h('span', null, h('b', null, 'Within 50p a year of the best direction'), ' — as good as it gets.');
        else if (finite(diff)) {
            const pc = (100 * Math.abs(diff)) / best.gbp;
            sub = h('span', null, h('b', null, `${fmt.gbp(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'}`), ` a year than the best (${pc < 1 ? 'under 1%' : fmt.pct(pc, { dp: 0 })}).`);
        }
        const quick = !hd;
        const row = (label, value, small) => h('div', { class: 'ov-row' }, h('dt', null, label), h('dd', { class: quick ? 'is-quick' : null }, value, small ? h('small', null, small) : null));
        const rows = [
            row('Saves a year', finite(gbp) ? fmt.gbp(gbp) : '—', quick && this.sel.battery ? 'panels alone' : null),
            hd ? row('Pays back in', fmt.years(hd.paybackYears)) : null,
            row('Makes', finite(hd?.pvKwh ?? c?.kwh) ? `${fmt.num(hd?.pvKwh ?? c?.kwh)} kWh` : '—',
                quick && this.sel.battery ? 'panels alone' : hd && this.sel.partial ? 'whole system' : null),
            row('Each kWh is worth', finite(hd ? (100 * hd.savingsGbp) / hd.pvKwh : c?.pPerKwh) ? fmt.p(hd ? (100 * hd.savingsGbp) / hd.pvKwh : c?.pPerKwh) : '—'),
            // the 4–7pm share counts every grid-tied panel: with one set of several moved, that's the kit's
            station ? null : row('Made 4–7pm', finite(hd?.peakGenSharePct ?? c?.peakSharePct) ? fmt.pct(hd?.peakGenSharePct ?? c?.peakSharePct, { dp: 0 }) : '—',
                this.sel.partial && this.sel.tg.index >= 0 ? 'whole kit' : null),
        ];
        const tag = hd ? 'Full simulation' : p.failed ? 'Quick estimate (the full run failed)' : 'Quick estimate · full run on its way';
        const actions = p.savedId
            ? [h('div', { class: 'notice ov-pick-saved', role: 'status' }, ui.icon('check'), h('span', null, 'Saved as “', h('b', null, p.savedName), '” — it’s now your active scenario.')),
                h('div', { class: 'ov-pick-actions' },
                    ui.button({ label: 'Open in Design', kind: 'primary', icon: 'arrowRight', onClick: () => this.ctx.router.go('design', { scenario: p.savedId }) }),
                    ui.button({ label: 'Clear', kind: 'link', icon: 'x', onClick: () => this.clearPick() }))]
            : [h('div', { class: 'ov-pick-actions' },
                isNow ? null : ui.button({ label: 'Save as a scenario', kind: 'primary', icon: 'check', onClick: () => this.savePick() }),
                isNow ? null : ui.button({ label: 'Open in Design', kind: 'ghost', icon: 'arrowRight', onClick: () => this.openInDesign() }),
                ui.button({ label: 'Clear', kind: 'link', icon: 'x', onClick: () => this.clearPick() })),
            isNow ? h('p', { class: 'ov-note' }, 'That’s how this kit is set up now.') : null];
        put(P.pick,
            h('div', { class: 'ov-pick-head' },
                h('div', { class: 'ov-pick-dir' }, this.dirLabel(p.az, p.tilt)),
                named ? ui.badge({ text: named.shorts.join(' · '), tone: 'accent' }) : null),
            sub ? h('div', { class: 'ov-pick-sub' }, sub) : null,
            h('dl', { class: 'ov-rows ov-pick-rows', 'aria-live': 'polite' }, h('div', { class: 'ov-pick-tag' }, tag), rows),
            actions);
    },

    fillScatter() {
        const { charts, fmt } = this.ctx;
        const P = this.v?.parts;
        const sw = this.sweep;
        if (!P || !sw) return;
        const sel = this.sel;
        const sunCells = sw.cells.filter(c => (c.tilt === 0 || (c.az >= 90 && c.az <= 270)) && finite(c.kwh) && c.kwh > 0 && finite(c.pPerKwh));
        const faint = sunCells.map(c => ({
            x: c.kwh, y: c.pPerKwh, label: this.dirLabel(c.az, c.tilt), color: '--series-muted', route: 'reference', az: c.az, tilt: c.tilt,
            extra: [{ value: fmt.gbp(c.gbp), label: sel.battery ? '£ a year, panels alone' : '£ a year' }],
        }));
        // Named points sit on the same (map) basis as the cloud, so they land where the cloud says.
        const named = [];
        const pts = this.namedPoints().filter(n => !n.mixed && (n.color || n.keys.includes('S35') || n.keys.includes('SSW45')));
        for (const n of pts) {
            const c = this.cellAt(n.az, n.tilt) || (sel.battery ? null : n);
            if (!c || !(c.kwh > 0)) continue;
            named.push({
                x: c.kwh, y: c.pPerKwh, label: n.shorts.join(' · '), color: n.color || '--text-2', az: n.az, tilt: n.tilt,
                emphasis: n.keys.includes('bestGbp') || n.keys.includes('W90'), showLabel: true,
                extra: [{ value: fmt.gbp(c.gbp), label: '£ a year' }, { value: this.dirLabel(n.az, n.tilt), label: '' }],
            });
        }
        // a pick on a named direction is labelled on that dot; a second dot on top would hide it
        const pickOn = this.pick ? named.find(p => sameDir(p, this.pick)) : null;
        if (pickOn) pickOn.label += ' · Picked';
        else if (this.pick) {
            const c = this.cellAt(this.pick.az, this.pick.tilt);
            if (c && c.kwh > 0) named.push({ x: c.kwh, y: c.pPerKwh, label: 'Picked', color: PICK.color, az: c.az, tilt: c.tilt, showLabel: true, emphasis: true,
                extra: [{ value: fmt.gbp(c.gbp), label: '£ a year' }, { value: this.dirLabel(c.az, c.tilt), label: '' }] });
        }
        const all = [...faint, ...named];
        const xs = all.map(p => p.x), gs = all.map(p => (p.x * p.y) / 100);
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        const levels = isoLevels(Math.min(...gs), Math.max(...gs), (P.scatter.clientWidth || 600) < 480 ? 2 : 3);
        const isolines = levels.map(G => ({
            label: `£${fmt.num(G)}/yr`,
            points: Array.from({ length: 49 }, (_, k) => { const x = xMin * 0.9 + ((xMax * 1.06 - xMin * 0.9) * k) / 48; return [x, (100 * G) / x]; }),
        }));
        const legend = [{ label: `Every direction tried${sel.battery ? ' (panels alone)' : ''}`, color: '--series-muted' }];
        for (const n of NAMED) if (n.color && named.some(p => p.color === n.color)) legend.push({ label: n.label, color: n.color });
        if (this.pick && !pickOn) legend.push({ label: PICK.label, color: PICK.color });
        this.chart('scatter', charts.createScatter, P.scatter, {
            title: 'Energy vs value: kWh a year against p per kWh made',
            ariaLabel: 'Energy versus value: each direction’s yearly kWh against what each kWh is worth; dashed curves are equal pounds a year',
            points: all, legend, isolines,
            x: { label: 'kWh made a year', format: v => fmt.num(v), zero: false },
            y: { label: 'p per kWh made', format: v => fmt.num(v, 1), zero: false },
            // on screen the twin lists every direction tried; on paper that ran to 13 pages, and the
            // named directions table already prints the labelled points
            printTable: false,
            onPick: p => this.choose(p.az, p.tilt),
        });
        P.scatterSub.textContent = 'Right = more energy, up = each kWh worth more. Dashed curves join directions that save the same £ a year.';
        const best = this.starred('bestGbp'), w90 = this.starred('W90');
        if (best && w90) {
            // the text quotes the full simulations (as the answer above does); the dots are the map
            const bh = sel.battery ? this.cellAt(best.az, best.tilt) || best : best;
            const wh = sel.battery ? this.cellAt(w90.az, w90.tilt) || w90 : w90;
            P.scatterTake.replaceChildren(
                'Pointing west moves a kit ', this.ctx.ui.h('b', null, 'up'), sel.station ? ' (each kWh is worth a little more)' : ' (each kWh lands nearer the peak)', ' but much further ',
                this.ctx.ui.h('b', null, 'left'), ` (fewer kWh): the west wall makes ${fmt.p(wh.pPerKwh)} per kWh against ${fmt.p(bh.pPerKwh)}, but `,
                this.ctx.ui.h('b', null, `${fmt.num(wh.kwh)} kWh`), ' against ', this.ctx.ui.h('b', null, `${fmt.num(bh.kwh)}`),
                sel.battery ? ` (the panels alone, without ${sel.batteryNoun}).` : sel.partial ? ' (the whole system).' : '.');
        } else P.scatterTake.textContent = '';
    },

    fillLines() {
        const { charts, fmt, ui } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        if (!P || !this.sweep) return;
        const sel = this.sel;
        // A station's own panels charge its battery: the profile has no time-of-day split for them
        // (the rose note says so), so the card steps aside and the energy chart takes the row.
        P.linesCard.hidden = !!sel.station;
        P.scatterCard.classList.toggle('ov-span', !!sel.station);
        if (sel.station) {
            this.v.charts.lines?.destroy();
            delete this.v.charts.lines;
            return;
        }
        const pts = this.namedPoints().filter(p => p.keys.some(k => LINE_KEYS.includes(k)));
        const series = [];
        for (const p of pts) {
            const run = this.runs.get(p.key);
            if (!run) continue;
            const w = profileW(run.typical?.profile).slice(DAY[0], DAY[1]);
            const isNowOnly = p.keys.length === 1 && p.key === 'current';
            series.push({ key: p.key, label: p.shorts.join(' · '), color: p.color, values: w, dash: isNowOnly ? [5, 4] : undefined });
        }
        // a pick on a drawn direction is that line already: name it there instead of drawing it twice
        const onLine = this.pick ? series.find(s => sameDir(pts.find(p => p.key === s.key), this.pick)) : null;
        if (onLine) onLine.label += ' · picked';
        else if (this.pick?.run) series.push({ key: 'pick', label: PICK.label, color: PICK.color, values: profileW(this.pick.run.typical?.profile).slice(DAY[0], DAY[1]) });
        if (!series.length) return;
        this.chart('lines', charts.createLine, P.lines, {
            title: 'Average output by time of day',
            ariaLabel: 'Average output by time of day for the named directions, 4am to 10pm local time; the 4 to 7pm peak is shaded',
            x: { values: HH.slice(DAY[0], DAY[1]), label: 'local time', tipFormat: v => `${v}–${HH[(HH.indexOf(v) + 1) % 48]}` },
            y: { label: 'average W', format: v => fmt.num(v) },
            series, bands: [{ from: '16:00', to: '19:00', label: '4–7pm' }],
        });
        // A power station's own panels charge its battery and have no time-of-day split: these
        // lines are the plug-in (grid-tied) panels only.
        const ownStation = stationArrays(sel.sys).some(panelsOf);
        P.linesSub.textContent = `Average watts across the year${ownStation ? ' from the plug-in panels (the power station’s own panels aren’t split by time of day)' : ''}, by half-hour (local time). Shaded: 4–7pm.`;
        const best = this.runs.get('bestGbp'), west = this.runs.get('W90');
        if (best && west) {
            const bw = profileW(best.typical.profile), ww = profileW(west.typical.profile);
            const bp = meanOver(bw, PEAK[0], PEAK[1]), wp = meanOver(ww, PEAK[0], PEAK[1]);
            // the year-round comparison on the lines' own basis (grid-tied output), not the system's
            // kWh: with a power station's panels in the mix those differ (46% vs 24% on C1)
            const bk = best.typical?.annual?.pvAcKwh, wk = west.typical?.annual?.pvAcKwh;
            const peakWord = Math.abs(wp - bp) < 0.05 * Math.max(bp, 1) ? 'about the same in the peak' : wp > bp ? 'more in the peak' : 'not even more in the peak';
            P.linesTake.replaceChildren('Between 4 and 7pm the west wall averages ', h('b', null, fmt.w(wp)), ' against ', h('b', null, fmt.w(bp)),
                ' for the best direction — ', peakWord,
                finite(bk) && finite(wk) && bk > 0 ? `, ${peakWord.startsWith('not') ? 'and' : 'but'} ${Math.round(100 * (1 - wk / bk))}% less across the whole year.` : '.');
        } else P.linesTake.textContent = '';
    },

    fillMonthly() {
        const { charts, fmt, ui } = this.ctx;
        const h = ui.h;
        const P = this.v?.parts;
        if (!P || !this.sweep) return;
        const sel = this.sel;
        P.monthlyCard.hidden = !!sel.station;
        if (sel.station) {
            this.v.charts.monthly?.destroy();
            delete this.v.charts.monthly;
            return;
        }
        const pts = this.namedPoints().filter(p => p.keys.some(k => ['bestGbp', 'W90', 'current'].includes(k)));
        const series = [];
        const shares = {};
        for (const p of pts) {
            const run = this.runs.get(p.key);
            if (!run) continue;
            const s = monthlyPeakShare(run.typical?.monthly);
            for (const k of p.keys) shares[k] = s;
            series.push({ key: p.key, label: p.shorts.join(' · '), color: p.color, values: s.map(v => (finite(v) ? v : null)) });
        }
        const onBar = this.pick ? series.find(s => sameDir(pts.find(p => p.key === s.key), this.pick)) : null;
        if (onBar) onBar.label += ' · picked';
        else if (this.pick?.run) series.push({ key: 'pick', label: PICK.label, color: PICK.color, values: monthlyPeakShare(this.pick.run.typical?.monthly).map(v => (finite(v) ? v : null)) });
        if (!series.length) return;
        this.chart('monthly', charts.createBars, P.monthly, {
            title: 'Share of each month’s output made 4–7pm',
            ariaLabel: 'Share of each month’s solar output made between 4 and 7pm, by month, for the named directions',
            categories: MONTHS, series,
            y: { label: '% made 4–7pm', format: v => fmt.pct(v, { dp: 0 }) },
        });
        const best = shares.bestGbp, west = shares.W90;
        const side = [];
        if (best && west) {
            let mi = 0;
            west.forEach((v, i) => { if (finite(v) && v > (west[mi] || 0)) mi = i; });
            side.push(h('p', null, 'In ', h('b', null, MONTH_NAMES[mi]), ' a west wall makes ', h('b', null, fmt.pct(west[mi], { dp: 0 })), ' of its output between 4 and 7pm; the best direction makes ', h('b', null, fmt.pct(best[mi], { dp: 0 })), '.'));
            // The dark months come from these runs (a west wall under 5% at 4–7pm), not a fixed
            // Nov–Feb: on the demo year February's west wall already makes 13% then.
            const dark = darkMonths(west, 5);
            if (dark.length) {
                const span = dark.length === 1 ? ['In ', h('b', null, MONTH_NAMES[dark[0]])] : ['From ', h('b', null, `${MONTH_NAMES[dark[0]]} to ${MONTH_NAMES[dark[dark.length - 1]]}`)];
                const wMax = Math.max(0, ...dark.map(i => west[i]).filter(finite));
                const last = dark[dark.length - 1];
                const after = last === 11 ? 0 : last < 2 ? last + 1 : null;
                side.push(h('p', null, ...span, ` there’s almost no sun after 4pm, whichever way the panels face (a west wall makes ${fmt.pct(wMax, { dp: 0 })} of its output then at most) — and that’s when Agile peaks are dearest.`,
                    after != null && finite(west[after]) ? ` By ${MONTH_NAMES[after]} it’s back to ${fmt.pct(west[after], { dp: 0 })}.` : ''));
            }
        } else {
            side.push(h('p', null, 'From November to February there’s little or no sun after 4pm, whichever way the panels face.'));
        }
        P.monthlySide.replaceChildren(...side);
    },
};

/* ── view-local pieces ──────────────────────────────────────────────────────── */

function injectStyle(h) {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    document.head.appendChild(h('style', { id: STYLE_ID }, CSS));
}

/** Fields of a verdict orientation answer that replace the sweep's own. */
function pickFields(va) {
    const out = {};
    for (const k of ['best', 'w90', 's35', 'tie', 'tieBandPct', 'westPays', 'flips', 'checked']) if (va[k] != null) out[k] = va[k];
    return out;
}

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** Same single direction? A mixed point (a split kit as configured) has none. */
const sameDir = (a, b) => !!a && !!b && !a.mixed && !b.mixed && a.az === b.az && a.tilt === b.tilt;
/** replaceChildren without the trap: null/false children are dropped (the DOM would print "null"), arrays flattened. */
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const listJoin = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`);

/** Is az inside the arc lo → hi (clockwise, the tie band's contiguous range)? */
function inArc(az, lo, hi) {
    const n = x => ((x % 360) + 360) % 360;
    const span = n(hi - lo);
    return n(az - lo) <= span;
}

/**
 * orientation-dial — the tie band drawn as a wedge on a mini sun-side fan (E right, S down, W
 * left; flat in the middle, vertical at the rim — the same picture as the rose), with the best
 * direction, the west wall and the current setting marked. Decorative-explanatory: role img + a
 * full text label; every figure is also in the text and tables.
 * @param {Function} h ui.h
 * @param {object} fmt ui.fmt
 * @param {{ best, tie, w90, current }} o
 * @returns {SVGElement}
 */
function orientationDial(h, fmt, { best, tie, w90, current }) {
    const W = 300, H = 166, cx = 150, cy = 20, R = 130;
    const rad = t => (Math.max(0, Math.min(90, t)) / 90) * R;
    const pt = (az, r) => { const a = ((az - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
    const f2 = v => v.toFixed(2);
    const arcPath = (a0, a1, r0, r1) => {
        const [x0, y0] = pt(a0, r1), [x1, y1] = pt(a1, r1);
        const large = a1 - a0 > 180 ? 1 : 0;
        if (r0 <= 0.5) return `M${f2(cx)} ${f2(cy)}L${f2(x0)} ${f2(y0)}A${f2(r1)} ${f2(r1)} 0 ${large} 1 ${f2(x1)} ${f2(y1)}Z`;
        const [x2, y2] = pt(a1, r0), [x3, y3] = pt(a0, r0);
        return `M${f2(x0)} ${f2(y0)}A${f2(r1)} ${f2(r1)} 0 ${large} 1 ${f2(x1)} ${f2(y1)}L${f2(x2)} ${f2(y2)}A${f2(r0)} ${f2(r0)} 0 ${large} 0 ${f2(x3)} ${f2(y3)}Z`;
    };
    const kids = [];
    // the fan, tilt rings and spokes
    kids.push(h('path', { class: 'ov-dial-face', d: `M${cx - R} ${cy}A${R} ${R} 0 0 0 ${cx + R} ${cy}Z` }));
    for (const t of [30, 60]) kids.push(h('path', { class: 'ov-dial-ring', d: `M${f2(cx - rad(t))} ${cy}A${f2(rad(t))} ${f2(rad(t))} 0 0 0 ${f2(cx + rad(t))} ${cy}` }));
    for (const a of [135, 180, 225]) { const [x, y] = pt(a, R); kids.push(h('line', { class: 'ov-dial-spoke', x1: cx, y1: cy, x2: f2(x), y2: f2(y) })); }
    // the tie band, padded by half a grid step so it covers the cells the rose shows
    let label = '';
    if (tie) {
        let a0 = tie.azMin, a1 = tie.azMax;
        if (a1 < a0) a1 += 360;
        const t0 = Math.max(0, tie.tiltMin - 2.5), t1 = Math.min(90, tie.tiltMax + 2.5);
        // padded, but never past the fan's east/west edges (the dial is the sun side only)
        kids.push(h('path', { class: 'ov-dial-tie', d: arcPath(Math.max(90, a0 - 5), Math.min(270, a1 + 5), rad(t0), rad(t1)) }));
        label = `Anything from ${fmt.compass(tie.azMin)} to ${fmt.compass(tie.azMax)} at ${tie.tiltMin}–${tie.tiltMax}° is within a few percent of the best. `;
    }
    // compass labels
    // E and W sit above the ends of the flat edge (the west-wall dot sits right on W's end)
    for (const [t, a] of [['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270]]) {
        const [x, y] = a === 90 || a === 270 ? [cx + (a === 90 ? R : -R), cy - 12] : pt(a, R + 11);
        kids.push(h('text', { class: 'ov-dial-label', x: f2(x), y: f2(y + 3), 'text-anchor': 'middle' }, t));
    }
    kids.push(h('text', { class: 'ov-dial-label', x: cx, y: cy - 9, 'text-anchor': 'middle' }, 'flat'));
    // markers: west wall, as set now, best
    if (w90) {
        const [x, y] = pt(w90.az, rad(w90.tilt));
        kids.push(h('circle', { class: 'ov-dial-west', cx: f2(x), cy: f2(y), r: 5 }));
        // the tag sits above the flat edge, beside "W": inside the fan a westward tie band covers it
        kids.push(h('text', { class: 'ov-dial-tag', x: f2(x + 12), y: f2(cy - 9), 'text-anchor': 'start' }, 'west wall'));
    }
    if (current && best && !current.mixed && !sameDir(current, best) && !sameDir(current, w90)) {
        const [x, y] = pt(current.az, rad(current.tilt));
        kids.push(h('circle', { class: 'ov-dial-now', cx: f2(x), cy: f2(y), r: 6.5 }));
    }
    if (best) {
        const [x, y] = pt(best.az, rad(best.tilt));
        kids.push(h('line', { x1: cx, y1: cy, x2: f2(x), y2: f2(y), stroke: 'var(--accent)', 'stroke-width': 1.5, 'stroke-dasharray': '3 3' }));
        kids.push(h('circle', { class: 'ov-dial-best', cx: f2(x), cy: f2(y), r: 6.5 }));
        label += `Best: ${fmt.compass(best.az)} ${best.az}° at ${best.tilt}°.`;
    }
    if (w90) label += ` West wall marked at the left edge.`;
    return h('svg', { class: 'ov-dial', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label.trim() }, kids);
}
