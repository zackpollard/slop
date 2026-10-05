/*
 * views/design.js — the Design tab: build one option and see what it would do for you.
 *
 * A workbench in two columns. On the left, the build (a sticky, scrollable panel on wide screens):
 *   rules feedback with one-click fixes (rules.js via the worker's validate / applyFix), then the
 *   Simple steps — 01 Start from (saved options, ready-made options, every catalog kit, bundle and
 *   power station grouped by route, or a custom build) with the route's one-liner · 02 Where it goes
 *   (mount spot, compass + tilt, an optional satellite azimuth handle) · 03 Battery (none, a catalog
 *   add-on or power station, or "add one later" as a staged plan) · 04 Automation (realistic / best
 *   case) · 05 What it costs (editable price lines) · 06 Export payments (auto from the kit, or an
 *   override). Advanced mode (remembered per device in store ui.designMode) adds everything else:
 *   route, per-array panels and wiring (input, shading, horizon, rear-side gain, panel model),
 *   inverter limits, battery and power-station parameters, every automation variant, cost lines,
 *   the later purchase, money assumptions for this page and a load change.
 * On the right, the results, grouped as the UX critique asks: Money (saves a year with the
 *   2006–2025 weather band drawn as a strip of the 20 years, payback, ahead after 10 years) ·
 *   Energy (made, used at home, lost) · Details (collapsed) · a day in the life (typical weather,
 *   summer / winter / any date, with that day's prices beneath on the same x) · month by month
 *   (typical solid, last 12 months' weather outlined) · cumulative cash flow with the weather band
 *   and payback marker · what the battery adds (solar / cheap grid / standby split) · notes.
 *
 * Toolbar: the option's name, Saved / Ready-made / Edited state, Save, Save a copy, Delete, Pin to
 * compare (store.scenarios.saved / pinned / activeId). The hash carries ?scenario=<id> for saved
 * and ready-made options, so links from Verdict, Compare and Orientation land on the right build.
 *
 * Engine work: validate, applyFix, runScenario (through ctx.data.scenario, so runs are memoised
 * and the user's finance settings merge in) and typicalDay all run in the worker. Runs are
 * debounced and coalesced (the worker is single-threaded, and runScenario cannot be cancelled
 * mid-flight), staged: rules → a fast run without the weather band → the typical day → the band.
 * While a run is in flight the previous results stay on screen at reduced opacity.
 *
 * Main-thread engine imports (pure, cheap — no simulation): kits.js to turn a catalog product into
 * a System, system.js to keep the draft canonical, scenarios.js for the default mount spots,
 * vat.js and finance.js for the first-year month split and the finance defaults shown. The worker's
 * catalog() result drops the catalog's electrician/limits/parts, so the view normalises the same
 * data/*.json files itself (see engineRequests in the report).
 *
 * View-local components (candidates for ui.js — see the report): dvBandStrip() (the 20 weather
 * years as ticks with the p10–p90 range, the typical year and the last 12 months marked) and the
 * numbered build step (dv-step). Their CSS lives in the injected <style id="style-design">.
 */

import { normalizeCatalog, findProduct, kitToSystem, stationToSystem, bundleToSystem, layoutPanels, mountingForSpot, electricianCost } from '../kits.js';
import { normalizeSystem } from '../system.js';
import { DEFAULT_SPOTS, normalizeSpot } from '../scenarios.js';
import { vatAt, vatSchedule } from '../vat.js';
import { DEFAULT_FINANCE } from '../finance.js';

const STYLE_ID = 'style-design';
const DIM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MEMO_MAX = 16;
const DEFAULT_ID = 'S01';

/** Route labels and one-liners (UX critique "Design (field set…)"). */
const ROUTES = {
    plugin: { label: 'Plug into a socket (DIY)', line: 'Legal since 27 Aug 2026 · up to 800 W out and 2000 W of panels · one per home · register at myplugin.solar' },
    hardwired: { label: 'Wired in by an electrician', line: 'Needed for any battery today · about £350 to install · up to 3.68 kW' },
    ups: { label: 'Power station for the servers', line: 'Charges from a socket and runs the servers from its own outlets · no grid connection, nothing to register' },
    whatif: { label: 'Future rules (not legal yet)', line: 'Plug-in batteries (hoped for 2027) or more than one kit per home' },
    reference: { label: 'Reference point', line: 'Not something to buy — a yardstick for the real options' },
};
const ROUTE_ORDER = ['plugin', 'hardwired', 'ups', 'whatif'];

/** Battery strategy labels (battery.js STRATEGY_LABELS, plain language). */
const STRATEGIES = {
    threshold: 'Agile-aware automation (realistic)',
    smart: 'Agile-aware with a perfect solar forecast',
    optimal: 'Perfect hindsight (best case)',
    schedule: 'Simple timer: charge overnight, run 4–7pm',
    self: 'Follow my usage',
    fixed: 'Fixed output',
    online: 'Bypass disabled (servers always on the inverter)',
};
const STRATEGY_HINT = {
    threshold: 'Charges in the cheapest half-hours, leaves room for tomorrow’s solar and runs the house through the dearest ones. What a home-automation rule can really do.',
    smart: 'The same rules, but it knows tomorrow’s solar exactly — an upper bound for a good forecast.',
    optimal: 'Plans the whole year knowing every price and every cloud. Nobody gets this; it shows the ceiling.',
    schedule: 'A plain timer. With grid charging at any price it fills up overnight and can waste summer solar.',
    self: 'Stores spare solar and gives it back whenever the house needs it. With a flat server load, a fixed output equal to your always-on load does the same without a CT clamp.',
    fixed: 'Gives a steady output (your always-on load unless you set one) whenever it has charge.',
    online: 'Runs the servers through the power station’s inverter all the time — shown only to price the penalty.',
};

const EXPORTS = {
    none: 'No export payments',
    prime: 'Octopus Outgoing Prime',
    fixed: 'Octopus Outgoing Fixed',
    agile: 'Agile Outgoing',
    flat: 'A flat rate I choose',
};
const EXPORT_HINT = {
    none: 'Solar you don’t use goes to the grid for nothing.',
    prime: 'Octopus pays plug-in kits bought from Octopus — from when your network operator approves the kit.',
    fixed: 'A fixed export rate. Needs an MCS-certified installation, so no plug-in kit qualifies.',
    agile: 'Half-hourly export prices that follow the wholesale market. Needs an MCS-certified installation.',
    flat: 'Any flat price per kWh exported, for comparison.',
};

const MOUNTINGS = [
    { value: 'open', label: 'Open frame' },
    { value: 'roof', label: 'Pitched roof' },
    { value: 'railing', label: 'Balcony railing' },
    { value: 'wall', label: 'Flat on a wall' },
];
const SPOT_KIND = { ground: 'ground frame', flatroof: 'flat roof', wall: 'wall', railing: 'balcony railing', pitched: 'pitched roof' };

const LEGAL = {
    ok: { tone: 'good', label: 'Legal as built' },
    check: { tone: 'warn', label: 'Check first' },
    whatif: { tone: 'whatif', label: 'Not legal today — planning only' },
    reference: { tone: 'reference', label: 'Reference point' },
};
const LEGAL_NEXT = {
    plugin: 'Plug it in yourself and register it at myplugin.solar.',
    hardwired: 'An electrician wires it in and tells your network operator.',
    ups: 'Nothing to register — a power station is an appliance.',
    whatif: 'Shown so you can plan for rules that may come.',
    reference: 'Not something to buy.',
};

const FLAG_TEXT = {
    upgradeBeyondHorizon: 'The later purchase falls after the end of the horizon, so it isn’t counted.',
    batteryReplaced: 'The battery is bought again each time it wears out.',
    pvStopsWithBattery: 'The panels stop earning when the all-in-one unit’s battery wears out (no replacement inverter assumed).',
    missingBatteryCapex: 'No battery price was found, so a replacement battery costs nothing here.',
    batteryWithoutAgeing: 'Battery ageing isn’t modelled for this option.',
};

const DESIGN_CSS = `
.dv { display: flex; flex-direction: column; gap: 18px; }
.dv .view-title:focus { outline: none; }
.dv .view-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 2px; }
.dv .view-head { margin-bottom: 2px; }
.dv .context-line { overflow-wrap: anywhere; margin-top: 8px; }
.dv .chart-tip:not(.show) { transform: none !important; transition: opacity .1s, transform 0s .1s; }
.dv-untitled .chart-title { display: none; }
.dv .help-dot { flex: none; }

/* toolbar */
.dv-bar {
    display: flex; align-items: center; justify-content: space-between; gap: 10px 18px; flex-wrap: wrap;
    padding: 10px 12px 10px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
}
.dv-bar-name { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 360px; }
.dv-bar-name .input {
    font-weight: 650; font-size: 16px; letter-spacing: -.01em; background: transparent; border-color: transparent;
    padding: 0 10px; min-width: 0; text-overflow: ellipsis;
}
.dv-bar-name .input:hover { border-color: var(--border); }
.dv-bar-name .input:focus { background: var(--sunk); }
.dv-bar-pencil { display: inline-flex; color: var(--faint); margin-left: 6px; margin-right: -6px; flex: none; }
.dv-bar-name:focus-within .dv-bar-pencil { color: var(--accent); }
.dv-bar-badges { display: flex; gap: 6px; flex: none; flex-wrap: wrap; }
.dv-bar-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; justify-content: flex-end; }
.dv-mini { display: none; }
.dv-mini b { font-family: var(--font-mono); font-weight: 600; color: var(--text); }
.dv-bar .btn[aria-pressed='true'] { border-color: var(--accent-line); color: var(--accent-strong); background: var(--accent-dim); }

/* workbench grid */
.dv-grid { display: grid; grid-template-columns: 408px minmax(0, 1fr); gap: 22px; align-items: start; }
.dv-editor {
    position: sticky; top: 62px; max-height: calc(100vh - 76px); overflow-y: auto; overscroll-behavior: contain;
    scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; padding: 0 20px 6px;
    /* keep focused / scrolled-to controls clear of the sticky panel heading */
    scroll-padding-top: 84px; scroll-padding-bottom: 16px;
}
.dv-editor-head {
    position: sticky; top: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin: 0 -20px; padding: 14px 20px 12px; background: var(--surface); border-bottom: 1px solid var(--hairline);
}
.dv-editor-title { font-size: 16.5px; font-weight: 650; margin: 0; }
.dv-editor-sub { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); margin-bottom: 2px; }
.dv-rules { display: flex; flex-direction: column; gap: 8px; padding-top: 14px; }
.dv-rules:empty { display: none; }
.dv-legal { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.dv-legal .badge { flex: none; }
.dv-issue { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; align-items: start; }
.dv-issue-text { font-size: 13.5px; color: var(--text-2); line-height: 1.45; }
.dv-issue-fixes { grid-column: 2; display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.dv-issue-fixes .btn { white-space: normal; text-align: left; height: auto; min-height: 32px; padding-top: 5px; padding-bottom: 5px; }
.dv-checking { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); display: inline-flex; align-items: center; gap: 8px; }

/* build steps */
.dv-step { padding: 18px 0 20px; border-top: 1px solid var(--hairline); display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dv-steps > .dv-step:first-child { border-top: 0; }
.dv-step-head { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.dv-step-n { font-family: var(--font-mono); font-size: 11px; font-weight: 500; letter-spacing: .06em; color: var(--accent); flex: none; }
.dv-step-title { font-size: 15px; font-weight: 650; color: var(--text); margin: 0; }
.dv-step-aside { margin-left: auto; font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); white-space: nowrap; }
.dv-step p, .dv-p { font-size: 13px; color: var(--muted); line-height: 1.5; margin: 0; }
.dv-p b { color: var(--text-2); font-weight: 600; }
.dv-route { --route-c: var(--faint); display: grid; grid-template-columns: 3px minmax(0, 1fr); gap: 2px 12px; }
.dv-route::before { content: ''; grid-row: 1 / span 2; border-radius: 2px; background: var(--route-c); }
.dv-route-plugin { --route-c: var(--route-plugin); }
.dv-route-hardwired { --route-c: var(--route-hardwired); }
.dv-route-ups { --route-c: var(--route-ups); }
.dv-route-whatif::before { background: transparent; box-shadow: inset 0 0 0 1px var(--route-whatif); }
.dv-route-name { font-weight: 600; font-size: 13.5px; color: var(--text); }
.dv-route-line { font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.dv-facts { display: flex; flex-wrap: wrap; gap: 6px; }
.dv-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }
.dv-fields > .dv-wide { grid-column: 1 / -1; }
.dv-fields .field-label { font-size: 12.5px; }
.dv-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dv-dir { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; align-items: center; }
.dv-dir-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.dv-fixed-dir { display: flex; align-items: baseline; gap: 10px; font-family: var(--font-mono); }
.dv-fixed-dir b { font-size: 20px; font-weight: 600; color: var(--text); }
.dv-fixed-dir span { font-size: 12.5px; color: var(--muted); }
.dv-map { height: 260px; position: relative; isolation: isolate; }   /* keep Leaflet's z-indexes under the sticky heading */
.dv-costs { display: grid; gap: 8px; }
.dv-cost { display: grid; grid-template-columns: minmax(0, 1fr) 124px; gap: 12px; align-items: center; }
.dv-cost-label { font-size: 13.5px; color: var(--text-2); line-height: 1.35; overflow-wrap: anywhere; }
.dv-cost-label small { display: block; font-size: 11.5px; color: var(--muted); }
.dv-cost-total { display: flex; justify-content: space-between; gap: 12px; padding-top: 9px; border-top: 1px dashed var(--border-strong); font-size: 13.5px; color: var(--text-2); }
.dv-cost-total b { font-family: var(--font-mono); font-size: 15px; font-weight: 600; color: var(--text); }
.dv-later { border: 1px dashed var(--border-strong); border-radius: 9px; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.dv-later-title { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); }
.dv-adv { margin-top: 4px; }
.dv-adv-title { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); padding: 18px 0 6px; border-top: 1px solid var(--hairline); }
.dv-adv .disclosure > summary { font-size: 14px; }
.dv-adv .disclosure-body { display: flex; flex-direction: column; gap: 14px; }
.dv-sub { border: 1px solid var(--hairline); border-radius: 9px; padding: 12px; display: flex; flex-direction: column; gap: 12px; background: var(--sunk); }
.dv-sub-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.dv-sub-title { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); }
.dv-sub .input { background: var(--surface); }
.dv-line { display: grid; grid-template-columns: minmax(0, 1fr) 104px; gap: 8px; align-items: end; }
.dv-line-meta { display: grid; grid-template-columns: 76px minmax(0, 1fr) auto; gap: 8px; align-items: end; }
.dv-empty-note { font-size: 13px; color: var(--muted); }

/* results */
.dv-results { display: flex; flex-direction: column; gap: 16px; min-width: 0; transition: opacity .2s ease; }
.dv.is-stale .dv-results { opacity: .55; }
.dv.is-error:not(.is-stale) .dv-results > :not(.dv-runerr) { opacity: .55; }
.dv-group { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 6px 0 -6px 2px; }
.dv-readout { padding: 22px 24px 20px; }
.dv-readout-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px 14px; flex-wrap: wrap; }
.dv-eyebrow { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .1em; text-transform: uppercase; color: var(--accent); }
.dv-badges { display: flex; gap: 6px; flex-wrap: wrap; }
.dv-fig { font-family: var(--font-mono); font-size: 64px; font-weight: 600; letter-spacing: -.055em; line-height: 1; color: var(--text); margin-top: 12px; }
.dv-fig small { font-family: var(--font-body); font-size: 17px; font-weight: 500; letter-spacing: 0; color: var(--muted); margin-left: 8px; }
.dv-fig.is-neg { color: var(--bad); }
.dv-fig-sub { color: var(--muted); font-size: 13px; margin-top: 8px; }
.dv-fig-warn { display: flex; gap: 8px; align-items: flex-start; margin-top: 10px; font-size: 13px; color: var(--bad); }
.dv-fig-warn .icon { flex: none; margin-top: 2px; }
.dv-build { margin-top: 16px; font-family: var(--font-mono); font-size: 12px; color: var(--text-2); line-height: 1.7; overflow-wrap: anywhere; }
.dv-build span + span::before { content: ' · '; color: var(--faint); }
.dv-status { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); min-height: 22px; }
.dv-status:empty { display: none; }
.dv-readout .tiles { margin-top: 18px; }
.dv-readout .stat { background: var(--sunk); }
.dv-err { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }

/* weather band strip */
.dv-band { margin-top: 20px; }
.dv-band-track { position: relative; height: 36px; }
.dv-band-axis { position: absolute; left: 0; right: 0; top: 50%; height: 1px; background: var(--border-strong); }
.dv-band-range { position: absolute; top: 8px; bottom: 8px; border-radius: 5px; background: var(--accent-dim); border: 1px solid var(--accent-line); }
.dv-band-tick { position: absolute; top: 11px; bottom: 11px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--muted); opacity: .75; }
.dv-band-typ, .dv-band-act { position: absolute; top: 50%; border-radius: 50%; }
.dv-band-typ { width: 14px; height: 14px; margin: -7px 0 0 -7px; background: var(--accent); box-shadow: 0 0 0 3px var(--surface); z-index: 2; }
.dv-band-act { width: 14px; height: 14px; margin: -7px 0 0 -7px; border: 2px solid var(--text); background: var(--surface); z-index: 1; }
.dv-band-ends { display: flex; justify-content: space-between; font-family: var(--font-mono); font-size: 10.5px; color: var(--faint); margin-top: 2px; }
.dv-band-key { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 10px; font-size: 12.5px; color: var(--text-2); }
.dv-band-key b { font-family: var(--font-mono); font-weight: 600; color: var(--text); }
.dv-key { display: block; }
.dv-key i { display: inline-block; margin-right: 7px; vertical-align: 0; }
.dv-key-typ { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
.dv-key-act { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--text); }
.dv-key-range { width: 16px; height: 10px; border-radius: 3px; background: var(--accent-dim); border: 1px solid var(--accent-line); }
.dv-key-tick { width: 2px; height: 10px; background: var(--muted); border-radius: 1px; }
.dv-band-wait { margin-top: 20px; }
.dv-band-note { font-size: 12.5px; color: var(--muted); margin-top: 6px; }

/* details */
.dv-dl { margin: 0; columns: 2 300px; column-gap: 32px; }
.dv-dl > div { break-inside: avoid; display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 8px 0; border-top: 1px solid var(--hairline); }
.dv-dl dt { color: var(--text-2); font-size: 13.5px; min-width: 0; }
.dv-dl dt small { display: block; color: var(--muted); font-size: 11.5px; }
.dv-dl dd { margin: 0; font-family: var(--font-mono); font-size: 13.5px; font-weight: 500; color: var(--text); text-align: right; white-space: nowrap; }
.dv-details > summary { font-size: 15px; font-weight: 600; color: var(--text); }
.dv-day-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.dv-day-tools .input { width: auto; min-width: 150px; }
.dv-day { display: flex; flex-direction: column; gap: 4px; }
.dv-day.is-stale .chart-plot { opacity: .5; }
.dv-lede { font-size: 13.5px; color: var(--text-2); margin-bottom: 12px; max-width: 72ch; }
.dv-lede b { color: var(--text); font-weight: 600; }
.dv-batt-facts { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12.5px; color: var(--muted); margin-top: 10px; }
.dv-batt-facts b { font-family: var(--font-mono); color: var(--text-2); font-weight: 500; }
.dv-notes { margin: 0; padding-left: 18px; font-size: 13px; color: var(--text-2); display: grid; gap: 6px; }
.dv-notes li::marker { color: var(--faint); }

@media (max-width: 1180px) {
    .dv-grid { grid-template-columns: 372px minmax(0, 1fr); }
}
@media (max-width: 1023px) {
    .dv-grid { grid-template-columns: minmax(0, 1fr); }
    .dv-editor { position: static; max-height: none; overflow: visible; }
    .dv-editor-head { position: static; }
    .dv-mini { display: inline-flex; flex-basis: 100%; gap: 8px; align-items: center; justify-content: flex-start; padding: 0 10px; }
}
@media (max-width: 600px) {
    .dv-bar { padding: 10px; }
    .dv-bar-name { flex-basis: 100%; flex-wrap: wrap; gap: 6px 10px; }
    .dv-bar-name .input { flex: 1 1 220px; }
    .dv-bar-actions { width: 100%; justify-content: stretch; }
    .dv-bar-actions .btn { flex: 1 1 auto; }
    .dv-editor { padding: 0 16px 4px; }
    .dv-editor-head { margin: 0 -16px; padding: 12px 16px; flex-wrap: wrap; }
    .dv-fields { grid-template-columns: minmax(0, 1fr); }
    .dv-dir { grid-template-columns: minmax(0, 1fr); justify-items: center; }
    .dv-dir-side { width: 100%; }
    .dv-readout { padding: 18px 16px 16px; }
    .dv-fig { font-size: 48px; }
    .dv-fig small { font-size: 15px; }
    .dv-cost { grid-template-columns: minmax(0, 1fr) 116px; }
    .dv-line-meta { grid-template-columns: 72px minmax(0, 1fr); }
    .dv-line-meta .btn { grid-column: 1 / -1; }
    .dv-day-tools { justify-content: flex-start; width: 100%; }
    .dv-day-tools .input { flex: 1 1 auto; }
    .dv-issue-fixes .btn { width: 100%; }
    .dv-details > summary { min-height: 44px; }
}
.dv-print { display: none; }
@media print {
    .dv-editor, .dv-bar, .dv-day-tools { display: none !important; }
    .dv-grid { grid-template-columns: minmax(0, 1fr); }
    .dv.is-stale .dv-results, .dv.is-error .dv-results > * { opacity: 1; }
    .dv-band-typ { box-shadow: none; }
    /* the editor is hidden on paper: name the option and what it costs above the results */
    .dv-print { display: block; break-inside: avoid; }
    .dv-print h2 { font-size: 18px; margin: 0 0 4px; }
    .dv-print table { border-collapse: collapse; margin-top: 8px; font-size: 12px; }
    .dv-print td { padding: 2px 16px 2px 0; }
    .dv-print td:last-child { text-align: right; font-family: var(--font-mono); }
    .dv-print tr.total td { border-top: 1px solid var(--border-strong); font-weight: 600; }
    /* a chart card with its table twin may break across pages; its heading may not. Block flow,
       not flex: Chrome ignores break-after: avoid between flex items. */
    .dv-results { display: block; }
    .dv-results > * + * { margin-top: 16px; }
    .dv-results .card:has(.chart) { break-inside: auto; }
    .dv-results .card-head, .dv-results .chart-head, .dv-group { break-inside: avoid; break-after: avoid; }
    .dv-results > div:has(> .dv-group) { break-inside: avoid; }
    .dv-details { break-inside: avoid; }
}
`;

/* ── pure helpers ───────────────────────────────────────────────────────────── */

const finite = v => typeof v === 'number' && Number.isFinite(v);
const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const countOf = arrays => (arrays || []).reduce((s, a) => s + (a.count || 0), 0);
const wpOf = arrays => (arrays || []).reduce((s, a) => s + (a.count || 0) * (a.wp || 0), 0);
const at = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function put(obj, path, v) {
    let o = obj;
    for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
    o[path[path.length - 1]] = v;
}

/** Deterministic JSON (sorted keys) for change detection. */
function stableJson(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    return `{${Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}
/** Everything the user can change, minus bookkeeping (id, featured, notes). */
function sig(sys) {
    if (!sys) return '';
    const { id, featured, notes, ...rest } = sys;
    void id; void featured; void notes;
    return stableJson(rest);
}

/** The 1st of the next UK-calendar month (the engine's default install date). */
function firstOfNextMonth(ms = Date.now()) {
    let y, m0;
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: 'numeric' }).formatToParts(ms);
        y = +parts.find(p => p.type === 'year').value;
        m0 = +parts.find(p => p.type === 'month').value - 1;
    } catch {
        const d = new Date(ms);
        y = d.getUTCFullYear();
        m0 = d.getUTCMonth();
    }
    const n = m0 + 1;
    return `${y + Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`;
}
function installParts(date) {
    const m = /^(\d{4})-(\d{2})/.exec(String(date || ''));
    return m ? { y: +m[1], m0: +m[2] - 1 } : { y: 2026, m0: 10 };
}
/** 'Nov 2026 – Oct 2027' for an install date. */
function yearSpan(date) {
    const { y, m0 } = installParts(date);
    const endIdx = m0 + 11;
    return `${MONTHS[m0]} ${y} – ${MONTHS[endIdx % 12]} ${y + Math.floor(endIdx / 12)}`;
}

/**
 * First ownership year by month: a run's forward ex-VAT money per month-of-year (annualised to the
 * full month, as simulate.toMonthlyFwd does) × (1 + VAT in that month of year 1) + export income.
 * @param {Array<object>} monthly SimResult.monthly
 * @param {{ installDate: string, vatReturns: boolean }} o
 * @returns {Array<{ key: string, m0: number, gbp: number, covered: boolean }>} 12 rows from the install month
 */
function firstYearMonths(monthly, { installDate, vatReturns }) {
    const cov = new Float64Array(12);
    const imp = new Float64Array(12);
    const exp = new Float64Array(12);
    for (const r of monthly || []) cov[r.month0] += r.coveredDays || 0;
    for (const r of monthly || []) {
        const f = cov[r.month0] > 1e-9 ? DIM[r.month0] / cov[r.month0] : 0;
        imp[r.month0] += (r.impSavFwdExcP || 0) * f;
        exp[r.month0] += (r.expIncFwdP || 0) * f;
    }
    const { y, m0 } = installParts(installDate);
    const sch = vatSchedule({ returnsTo5: vatReturns !== false });
    return Array.from({ length: 12 }, (_, k) => {
        const idx = m0 + k;
        const yr = y + Math.floor(idx / 12);
        const mm = idx % 12;
        const v = 1 + vatAt(Date.UTC(yr, mm, 15, 12), sch);
        return { key: `${yr}-${String(mm + 1).padStart(2, '0')}`, m0: mm, gbp: (imp[mm] * v + exp[mm]) / 100, covered: cov[mm] > 0 };
    });
}
/** Scale month rows to the engine's year-1 total (battery ageing and the like) when they're already close. */
function scaleTo(rows, total) {
    const s = rows.reduce((a, r) => a + r.gbp, 0);
    if (!finite(total) || Math.abs(s) < 1) return rows;
    const f = total / s;
    return f < 0.8 || f > 1.25 ? rows : rows.map(r => ({ ...r, gbp: r.gbp * f }));
}

/**
 * Split one day's half-hours into what met the home's use (solar, battery, grid — sums to the use)
 * and where everything else went (export, battery charging, lost), in average watts.
 */
function dayLayers(slots) {
    const L = { use: [], solar: [], batt: [], grid: [], exp: [], chg: [], lost: [], price: [], xprice: [] };
    for (const s of slots) {
        const load = Math.max(0, s.load || 0);
        const fromBatt = Math.min(load, Math.max(0, s.battNet || 0));
        // into the battery: AC-side charging (grid or surplus solar) plus solar a dc-coupled unit
        // stores before its inverter (the part of the no-battery AC output that never reached AC)
        const charge = Math.max(0, -(s.battNet || 0)) + Math.max(0, (s.pvAc || 0) - (s.pvDirectAc ?? s.pvAc ?? 0));
        // solar meets the home first, the grid tops up; grid charging shows up below zero as charging
        const solarToLoad = Math.min(Math.max(0, load - fromBatt), Math.max(0, s.pvDirectAc ?? s.pvAc ?? 0));
        const gridToLoad = Math.max(0, load - fromBatt - solarToLoad);
        const w = kwh => kwh * 2000;
        L.use.push(w(load));
        L.solar.push(w(solarToLoad));
        L.batt.push(w(fromBatt));
        L.grid.push(w(gridToLoad));
        // below-zero layers stay a hair negative when empty, so charts.js stacks them from zero
        // (an exact 0 would sit on top of the positive stack and draw a sliver down to the next value)
        L.exp.push(-w(Math.max(0, s.exp || 0)) || -1e-9);
        L.chg.push(-w(charge) || -1e-9);
        L.lost.push(-w(Math.max(0, s.clipped || 0)) || -1e-9);
        L.price.push(s.price);
        L.xprice.push(s.exportPrice ?? 0);
    }
    return L;
}

const anyNonZero = arr => arr.some(v => Math.abs(v) > 0.5);

/** Panel arrays the direction controls move: grid-tied arrays, else a power station's own panels. */
function panelArrays(sys) {
    if (sys?.arrays?.length) return sys.arrays;
    return sys?.battery?.ups?.pvArrays ?? [];
}
function panelPath(sys) {
    if (sys?.arrays?.length) return ['arrays'];
    if (sys?.battery?.ups?.pvArrays?.length) return ['battery', 'ups', 'pvArrays'];
    return null;
}

/** ' · 1.92 kWh' unless the product's name already says its size. */
const kwhTag = (name, kwh, fmt) => (/\bkWh\b/.test(name || '') || !finite(kwh) ? '' : ` · ${fmt.num(kwh, kwh < 10 ? 2 : 1)} kWh`);

const sourceKey = src => (!src ? '' : src.kind === 'saved' || src.kind === 'auto' ? `${src.kind}:${src.id}` : src.key || '');

/* ── catalog (main thread: product → System needs the full normalised catalog) ── */

let catalogPromise = null;
function loadCatalog() {
    if (!catalogPromise) {
        catalogPromise = (async () => {
            const base = new URL('../../data/', import.meta.url);
            const get = async name => {
                const res = await fetch(new URL(`${name}.json`, base).href, { credentials: 'same-origin' });
                if (!res.ok) throw new Error(`Couldn’t load the product list (data/${name}.json, ${res.status}).`);
                return res.json();
            };
            const [kits, stations, bundles, constants] = await Promise.all(['kits', 'stations', 'bundles', 'constants'].map(get));
            return normalizeCatalog({
                kits: kits?.kits ?? kits, stations: stations?.stations ?? stations, bundles: bundles?.bundles ?? bundles,
                constants, stationDefaults: stations?.defaults ?? null,
            });
        })();
        catalogPromise.catch(() => { catalogPromise = null; });
    }
    return catalogPromise;
}

function injectStyle(h) {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    document.head.appendChild(h('style', { id: STYLE_ID }, DESIGN_CSS));
}

/**
 * design-dvBandStrip — the 2006–2025 weather band as a strip: one tick per weather year, the
 * p10–p90 range shaded, the typical year as a gold dot and the last 12 months as a ring. The
 * numbers are spelled out in the key under it (and in the aria-label), so nothing is hover-only.
 * @param {Function} h ui.h
 * @param {object} fmt ui.fmt
 * @param {{ values: number[], years: number[], p10: number, p90: number, typical: number, actual: number|null, weather?: object }} o
 * @returns {HTMLElement}
 */
function dvBandStrip(h, fmt, { values, years, p10, p90, typical, actual, weather }) {
    const all = [...values, typical, p10, p90, ...(finite(actual) ? [actual] : [])].filter(finite);
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    const span = Math.max(hi - lo, Math.max(4, Math.abs(typical) * 0.06));
    const mid = (lo + hi) / 2;
    lo = mid - span * 0.56;
    hi = mid + span * 0.56;
    const pos = v => `${(((v - lo) / (hi - lo)) * 100).toFixed(2)}%`;
    const g = v => fmt.gbp(v);
    const n = values.length;
    const yr0 = years?.[0];
    const yr1 = years?.[years.length - 1];
    const sunnier = weather?.sunnierThanYears;
    const actualNote = finite(actual)
        ? (finite(sunnier) && weather?.yearsCompared ? (sunnier >= weather.yearsCompared ? ' (sunnier than every one of those years)' : sunnier === 0 ? ' (duller than every one of those years)' : ` (sunnier than ${sunnier} of ${weather.yearsCompared})`) : '')
        : '';
    const label = `Weather band: in ${n} weather years from ${yr0} to ${yr1} it saves ${g(Math.min(...values))} to ${g(Math.max(...values))} in the first year; `
        + `8 years in 10 between ${g(p10)} and ${g(p90)}; typical year ${g(typical)}`
        + (finite(actual) ? `; with the last 12 months’ sunshine ${g(actual)}${actualNote}.` : '.');
    return h('div', { class: 'dv-band', role: 'img', 'aria-label': label },
        h('div', { class: 'dv-band-track', 'aria-hidden': 'true' },
            h('span', { class: 'dv-band-axis' }),
            h('span', { class: 'dv-band-range', style: { left: pos(p10), width: `calc(${pos(p90)} - ${pos(p10)})` } }),
            values.map((v, i) => h('span', { class: 'dv-band-tick', style: { left: pos(v) }, title: years?.[i] != null ? `${years[i]}: ${g(v)}` : g(v) })),
            finite(actual) ? h('span', { class: 'dv-band-act', style: { left: pos(actual) } }) : null,
            h('span', { class: 'dv-band-typ', style: { left: pos(typical) } })),
        h('div', { class: 'dv-band-ends', 'aria-hidden': 'true' }, h('span', null, g(lo)), h('span', null, g(hi))),
        h('div', { class: 'dv-band-key', 'aria-hidden': 'true' },
            h('span', { class: 'dv-key' }, h('i', { class: 'dv-key-typ' }), 'Typical year ', h('b', null, g(typical))),
            h('span', { class: 'dv-key' }, h('i', { class: 'dv-key-range' }), '8 years in 10 ', h('b', null, fmt.range(p10, p90, g))),
            h('span', { class: 'dv-key' }, h('i', { class: 'dv-key-tick' }), `Each of ${n} weather years, ${yr0}–${yr1}`),
            finite(actual) ? h('span', { class: 'dv-key' }, h('i', { class: 'dv-key-act' }), 'Last 12 months’ sunshine ', h('b', null, g(actual)), actualNote) : null));
}

/* ── the view ───────────────────────────────────────────────────────────────── */

function freshState() {
    return {
        catalog: null, autos: null,
        draft: null, source: null, base: '',
        rules: null, result: null, banded: false, runError: null,
        which: 'summer', date: null, day: null, dayError: null,
        fin: {}, later: null, open: new Set(), mapOpen: false,
    };
}

export default {
    id: 'design',
    title: 'Design',

    mount(el, ctx) {
        this.el = el;
        this.ctx = ctx;
        this.alive = true;
        this.v = null;                 // DOM built for one dataset: { dsId, root, parts, charts }
        this.st = freshState();
        this.token = 0;
        this.ver = 0;
        this.dayToken = 0;
        this.dayMemo = new Map();
        this.running = false;
        this.timer = null;
        this.mapBox = null;
        this.picker = null;
        this.compass = null;
        injectStyle(ctx.ui.h);
        this.offs = [
            ctx.data.on('dataset', () => this.render()),
            ctx.data.on('status', () => this.render()),
            ctx.data.on('settings', () => this.onSettings()),
            ctx.data.on('scenarios', () => this.onScenarios()),
        ];
        this.render();
    },

    show(params) {
        this.params = params || {};
        this.visible = true;
        if (this.v && this.st.autos) {
            this.applyParams();
            // built while another tab was showing: put the option's id in the address now
            if (!this.params.scenario) this.syncUrl();
        }
    },

    hide() {
        this.visible = false;
        if (this.barShown) { this.ctx.shell.rerun.hide(); this.barShown = false; }
    },

    unmount() {
        this.alive = false;
        clearTimeout(this.timer);
        this.offs?.forEach(off => off());
        this.teardown();
        this.picker?.destroy?.();
    },

    teardown() {
        if (!this.v) return;
        for (const c of Object.values(this.v.charts)) c?.destroy();
        this.v = null;
        // the map shows the dataset's location: a new dataset may be somewhere else
        this.picker?.destroy?.();
        this.picker = null;
        this.mapBox = null;
        this.st.mapOpen = false;
    },

    /* ── lifecycle ──────────────────────────────────────────────────────── */

    async render() {
        const { ui, data } = this.ctx;
        // The connect card shows its own progress and errors: leave it alone until data arrives.
        if (!data.summary() && this.el.querySelector('.connect-card')) return;
        const token = ++this.token;
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
        if (this.v && this.v.dsId === summary.id) {
            this.setStale(false);
            return;
        }
        this.teardown();
        this.el.replaceChildren(this.skeleton(summary));
        try {
            const [catalog, autos] = await Promise.all([loadCatalog(), data.autoScenarios()]);
            if (token !== this.token || data.summary()?.id !== summary.id) return;
            this.st.catalog = catalog;
            this.st.autos = autos || [];
            this.dayMemo.clear();
            this.build(summary);
            this.pickInitial();
        } catch (err) {
            if (err?.name === 'AbortError' || token !== this.token) return;
            console.error('design view failed to load', err);
            this.teardown();
            this.el.replaceChildren(this.errorCard(err));
        }
    },

    onSettings() {
        if (!this.v) { this.render(); return; }
        // Finance, spots or the projected base load changed: memos are gone, so re-run (and the
        // spot list in "Where it goes" may be different).
        this.dayMemo.clear();
        this.renderHead();
        this.renderEditor();
        this.scheduleRun(0, { user: false });
    },

    onScenarios() {
        if (!this.v || !this.st.draft) return;
        const src = this.st.source;
        // Deleted elsewhere (Compare, Method's reset): this is now an unsaved build.
        if (src?.kind === 'saved' && !this.savedList().some(s => s.id === src.id)) {
            this.st.source = { kind: 'unsaved', key: '' };
            this.st.base = '';
        }
        this.renderBar();
        this.renderEditor();
    },

    setStale(on) {
        if (!this.v) return;
        this.v.root.classList.toggle('is-stale', !!on);
        const r = this.v.parts.results;
        if (on) r.setAttribute('aria-busy', 'true'); else r.removeAttribute('aria-busy');
        const s = this.v.parts.status;
        if (s) s.replaceChildren(...(on ? [this.ctx.ui.h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Working it out…'] : []));
    },

    /* ── state helpers ──────────────────────────────────────────────────── */

    store() { return this.ctx.store; },
    savedList() { return (this.store().get().scenarios?.saved || []).filter(s => s && typeof s.id === 'string'); },
    pinnedList() { return this.store().get().scenarios?.pinned || []; },
    isDirty() { return !!this.st.draft && sig(this.st.draft) !== this.st.base; },
    persistentId() {
        const s = this.st.source;
        return s && (s.kind === 'saved' || s.kind === 'auto') ? s.id : null;
    },
    spots() {
        const user = this.store().get().settings?.spots;
        const list = Array.isArray(user) && user.length ? user : DEFAULT_SPOTS;
        return list.map((s, i) => normalizeSpot(s, i));
    },
    baseLoadW() {
        const s = this.ctx.data.summary();
        const pb = this.store().get().settings?.projectBaseW;
        return finite(pb) ? pb : finite(s?.baseLoadW) ? s.baseLoadW : null;
    },
    financeView() {
        const s = this.store().get().settings || {};
        const f = { ...DEFAULT_FINANCE, installDate: firstOfNextMonth(), ...(s.finance || {}), vatReturns: s.vatReturns !== false, ...this.st.fin };
        return f;
    },
    dsSource() { return this.ctx.data.summary()?.source ?? 'octopus'; },

    /** The product (kit, bundle or station) a system was built from. */
    mainProduct(sys = this.st.draft) {
        const cat = this.st.catalog;
        if (!cat || !sys) return null;
        return findProduct(cat, sys.kitId) ?? (sys.sourceIds || []).map(id => findProduct(cat, id)).find(Boolean) ?? null;
    },
    /** The battery product added to a system (an add-on battery or a power station), if any. */
    batteryProduct(sys = this.st.draft) {
        const cat = this.st.catalog;
        if (!cat || !sys?.battery) return null;
        const main = this.mainProduct(sys);
        for (const id of sys.sourceIds || []) {
            const p = findProduct(cat, id);
            if (!p || p === main) continue;
            if (p.kind === 'power-station' || p.kind === 'battery-addon') return p;
        }
        return null;
    },
    /** True when the main product IS the battery (an add-on battery bought on its own, or a power station route). */
    batteryIsProduct(sys = this.st.draft) {
        const main = this.mainProduct(sys);
        return !!sys?.battery && !!main && (main.kind === 'power-station' || main.kind === 'battery-addon') && !sys.arrays.length;
    },

    /** A spot-like description of where the draft's panels are, so a new product lands in the same place. */
    currentSpot(sys = this.st.draft) {
        const first = panelArrays(sys)[0];
        const spot = this.spots().find(s => s.id === sys?.spotId) ?? null;
        if (!first) return spot ? { ...spot, azimuth: spot.azimuth ?? 180, tilt: spot.tilt ?? Math.min(spot.tiltRange[1], Math.max(spot.tiltRange[0], 35)) } : null;
        const kind = first.mounting === 'wall' ? 'wall' : first.mounting === 'railing' ? 'railing' : first.mounting === 'roof' ? 'pitched' : (spot?.kind ?? 'ground');
        return { ...(spot || {}), id: sys.spotId ?? spot?.id ?? null, kind, azimuth: first.azimuth, tilt: first.tilt, shadingPct: first.shadingPct, horizon: [...(first.horizon || [])] };
    },

    /* ── choosing what to edit ──────────────────────────────────────────── */

    pickInitial() {
        const params = this.params ?? this.ctx.router.params?.() ?? {};
        if (params.scenario && this.loadById(params.scenario, { quiet: false })) return;
        if (this.st.draft) {
            // A data reload keeps the build being edited; an untouched ready-made one follows the new data.
            const src = this.st.source;
            if (src?.kind === 'auto' && !this.isDirty() && this.loadById(src.id, { quiet: true })) return;
            this.renderAll();
            this.scheduleRun(0, { user: false });
            return;
        }
        const active = this.store().get().scenarios?.activeId;
        if (active && this.loadById(active, { quiet: true })) return;
        if (this.loadById(DEFAULT_ID, { quiet: true })) return;
        const first = this.st.autos.find(s => s.route !== 'reference');
        if (first) this.setDraft(normalizeSystem(clone(first)), { kind: 'auto', id: first.id });
        else this.setDraft(this.buildFrom('blank'), { kind: 'catalog', key: 'blank' });
    },

    applyParams() {
        const id = this.params?.scenario;
        if (!id || id === this.st.source?.id) return;
        const prev = this.snapshot();
        if (this.loadById(id, { quiet: false })) {
            if (prev.dirty) this.offerUndo(prev, `Opened “${this.st.draft.name}”.`);
        } else this.syncUrl();   // a dead link: put the option actually on screen back in the address
    },

    loadById(id, { quiet = true } = {}) {
        const saved = this.savedList().find(s => s.id === id);
        if (saved) { this.setDraft(normalizeSystem(clone(saved)), { kind: 'saved', id }); return true; }
        const auto = this.st.autos?.find(s => s.id === id);
        if (auto) { this.setDraft(normalizeSystem(clone(auto)), { kind: 'auto', id }); return true; }
        if (!quiet) this.ctx.ui.toast(`Couldn’t find the option “${id}” — it may have been deleted.`, { tone: 'warn' });
        return false;
    },

    snapshot() {
        return { draft: this.st.draft, source: this.st.source, base: this.st.base, dirty: this.isDirty() };
    },
    offerUndo(prev, message) {
        this.ctx.ui.toast(`${message} Your unsaved changes to “${prev.draft.name}” were set aside.`, {
            timeoutMs: 9000,
            action: { label: 'Undo', onClick: () => { this.st.draft = prev.draft; this.st.source = prev.source; this.st.base = prev.base; this.afterSourceChange(); this.focusBar(); } },
        });
    },

    setDraft(sys, source) {
        this.st.origin = clone(sys);
        this.st.draft = sys;
        this.st.source = source;
        this.st.base = sig(sys);
        this.afterSourceChange();
    },

    afterSourceChange() {
        this.st.later = null;
        this.st.rules = null;
        const id = this.persistentId();
        const sc = this.store().get().scenarios || {};
        if (id && sc.activeId !== id) this.store().set({ scenarios: { activeId: id } });
        this.syncUrl();
        this.renderAll();
        this.scheduleRun(0, { user: false });
    },

    syncUrl() {
        const { router } = this.ctx;
        if (router.current?.() !== 'design') return;
        const id = this.persistentId();
        const cur = router.params?.().scenario;
        if (id && cur !== id) router.replace('design', { scenario: id });
        else if (!id && cur) router.replace('design', {});
    },

    /** Build a fresh System from a "Start from" choice, keeping the panels where they are. */
    buildFrom(value) {
        const cat = this.st.catalog;
        // where the panels are now; a battery-only or panel-less step in between keeps the last place
        const here = panelArrays(this.st.draft).length ? this.currentSpot() : null;
        if (here) this.st.lastSpot = here;
        const spot = here ?? this.st.lastSpot ?? this.currentSpot() ?? (() => { const s = this.spots()[0]; return s ? { ...s, azimuth: s.azimuth ?? 180, tilt: s.tilt ?? 35 } : null; })();
        const ds = this.dsSource();
        const loose = (count, sp) => ({ count, wp: cat.parts?.panel?.includedPanels?.wp ?? 460, catalogId: cat.parts?.panel?.id,
            frameId: mountingForSpot(sp) === 'open' ? cat.parts?.frame?.id : undefined });
        const [kind, id] = value.split(/:(.*)/s);
        if (kind === 'kit') {
            const kit = findProduct(cat, id);
            if (!kit) throw new Error(`Unknown product ${id}`);
            if (kit.kind === 'battery-addon') return kitToSystem(kit, { catalog: cat, id: 'draft', dsSource: ds });
            if (kit.kind === 'battery-inverter') return kitToSystem(kit, { catalog: cat, spot, id: 'draft', dsSource: ds, panels: loose(Math.min(4, Math.max(1, kit.inputs.length)), spot), name: `${kit.name} + ${Math.min(4, Math.max(1, kit.inputs.length))} panels` });
            if (!kit.includedPanels) return kitToSystem(kit, { catalog: cat, spot, id: 'draft', dsSource: ds, panels: loose(2, spot), name: `${kit.name} + 2 panels` });
            return kitToSystem(kit, { catalog: cat, spot, id: 'draft', dsSource: ds });
        }
        if (kind === 'bundle') return bundleToSystem(findProduct(cat, id), { catalog: cat, spot, id: 'draft' });
        if (kind === 'station') return stationToSystem(findProduct(cat, id), { catalog: cat, id: 'draft' });
        // a custom plug-in build: two panels on the generic dual-input 800 W micro-inverter
        const o = spot ?? { azimuth: 180, tilt: 35, kind: 'ground', shadingPct: 3, horizon: [] };
        return normalizeSystem({
            id: 'draft', name: 'My own plug-in build', route: 'plugin', spotId: o.id ?? null,
            arrays: layoutPanels(2, 460, 2, { azimuth: o.azimuth ?? 180, tilt: o.tilt ?? 35, mounting: mountingForSpot(o), shadingPct: o.shadingPct ?? 3, horizon: o.horizon ?? [] }),
            costs: [{ label: 'Panels, micro-inverter and mounting', gbp: 600, year: 0, kind: 'hardware' }],
            notes: ['A custom build: only legal as a plug-in kit if this exact kit is on the ENA register.'],
        });
    },

    startFrom(value) {
        if (!value || value === sourceKey(this.st.source)) return;
        const prev = this.snapshot();
        const [kind, id] = value.split(/:(.*)/s);
        let ok = true;
        if (kind === 'saved' || kind === 'auto') ok = this.loadById(id, { quiet: false });
        else {
            try {
                this.setDraft(this.buildFrom(value), { kind: 'catalog', key: value });
            } catch (err) {
                ok = false;
                this.ctx.ui.toast(`Couldn’t start from that: ${err?.message || err}`, { tone: 'bad' });
            }
        }
        if (ok && prev.dirty) this.offerUndo(prev, `Started from “${this.st.draft.name}”.`);
    },

    /* ── editing ────────────────────────────────────────────────────────── */

    /**
     * Apply an edit to a copy of the draft, keep it canonical, then re-run.
     * rebuild:false for continuous controls (compass drag, sliders, the map handle) so the control
     * being dragged isn't replaced under the pointer.
     */
    change(mutate, { rebuild = true, delay = 380 } = {}) {
        const d = clone(this.st.draft);
        const out = mutate(d) ?? d;
        this.st.draft = normalizeSystem(out);
        // the run is scheduled even if a re-render fails, so the results never silently stay on
        // the previous build (they dim and re-run instead)
        try {
            this.renderBar();
            if (rebuild) this.renderEditor();
        } finally {
            this.scheduleRun(delay, { user: true });
        }
    },

    async applyFix(fix, button) {
        const { engine, ui } = this.ctx;
        if (button) button.disabled = true;
        try {
            let next = await engine.call('applyFix', this.st.draft, fix.action);
            if (!this.alive) return;
            // rules.applyFix removeBattery leaves the battery's price line behind: take it out too
            if (fix.action?.type === 'removeBattery') next = this.withoutBatteryCosts(next, this.st.draft);
            this.st.draft = normalizeSystem(next);
            this.renderBar();
            this.renderEditor();
            this.scheduleRun(0, { user: true });
            ui.toast(`Done: ${fix.label}.`, { tone: 'good', timeoutMs: 3000 });
            this.focusRules = true;
        } catch (err) {
            if (err?.name === 'AbortError') return;
            if (button) button.disabled = false;
            ui.toast(`Couldn’t apply that fix: ${err?.message || err}`, { tone: 'bad' });
        }
    },

    /** Remove a battery product's own cost lines (and its sourceId) from a system. */
    withoutBatteryCosts(sys, before = sys) {
        const p = this.batteryProduct(before);
        if (!p) return sys;
        const s = clone(sys);
        if (p.kind === 'power-station') {
            s.costs = this.dropStationPanelLines(s.costs, countOf(before.battery?.ups?.pvArrays)).filter(c => c.label !== 'Smart plug for automation (enter yours)');
        }
        const idx = s.costs.map(c => c.label).lastIndexOf(p.name);
        if (idx >= 0) s.costs.splice(idx, 1);
        s.sourceIds = s.sourceIds.filter(id => id !== p.id);
        return this.pruneParts(s);
    },

    /** Drop the loose panel / frame ids from sourceIds once no cost line buys them any more. */
    pruneParts(s) {
        for (const part of [this.st.catalog?.parts?.panel, this.st.catalog?.parts?.frame]) {
            if (part && !s.costs.some(c => c.label.endsWith(`× ${part.name}`))) s.sourceIds = s.sourceIds.filter(id => id !== part.id);
        }
        return s;
    },

    /** Battery select: none, a catalog add-on battery or power station. */
    setBattery(value) {
        const cat = this.st.catalog;
        this.change(d => {
            let s = this.withoutBatteryCosts(d, d);
            if (value === 'none' || value === 'builtin') return { ...s, battery: value === 'none' ? null : s.battery };
            const [kind, id] = value.split(/:(.*)/s);
            const p = findProduct(cat, id);
            if (!p) return s;
            const strategy = d.battery?.strategy && d.battery.strategy !== 'fixed' ? d.battery.strategy : 'threshold';
            if (kind === 'station') {
                const sub = stationToSystem(p, { catalog: cat, strategy });
                s = { ...s, battery: sub.battery, costs: [...s.costs, ...sub.costs], sourceIds: [...s.sourceIds, p.id] };
            } else {
                s = { ...s, battery: { ...clone(p.battery), strategy }, costs: [...s.costs, { label: p.name, gbp: p.priceGbp ?? 0, year: 0, kind: 'hardware' }], sourceIds: [...s.sourceIds, p.id] };
            }
            return s;
        });
    },

    /** Panels on a power station's own solar inputs (0 … what can really be wired). */
    setStationPanels(n) {
        const cat = this.st.catalog;
        const st = this.mainProduct()?.kind === 'power-station' ? this.mainProduct() : this.batteryProduct();
        if (!st) return;
        this.change(d => {
            const spot = (panelArrays(d).length ? this.currentSpot(d) : this.st.lastSpot ?? this.currentSpot(d)) ?? this.spots()[0];
            const sub = stationToSystem(st, { catalog: cat, panels: n > 0 ? { count: n, spot } : null, dedicatedW: d.battery?.ups?.dedicatedW ?? 'baseload', strategy: d.battery?.strategy ?? 'threshold' });
            const costs = this.dropStationPanelLines(d.costs, countOf(d.battery?.ups?.pvArrays));
            const panel = cat.parts?.panel?.name;
            const frame = cat.parts?.frame?.name;
            costs.push(...sub.costs.filter(c => (panel && c.label.endsWith(`× ${panel}`)) || (frame && c.label.endsWith(`× ${frame}`))));
            return this.pruneParts({
                ...d,
                battery: { ...d.battery, ups: { ...d.battery.ups, pvArrays: sub.battery.ups.pvArrays } },
                costs,
                sourceIds: [...new Set([...d.sourceIds, ...sub.sourceIds.filter(id => id !== st.id)])],
                spotId: n > 0 ? (spot?.id ?? d.spotId) : d.spotId,
            });
        });
    },

    /** Cost lines minus the last "N × panel" and "N × frame" lines stationToSystem added for N station panels. */
    dropStationPanelLines(costs, n) {
        const out = [...costs];
        if (!(n > 0)) return out;
        for (const name of [this.st.catalog.parts?.panel?.name, this.st.catalog.parts?.frame?.name]) {
            if (!name) continue;
            const idx = out.map(c => c.label).lastIndexOf(`${n} × ${name}`);
            if (idx >= 0) out.splice(idx, 1);
        }
        return out;
    },

    /** Apply a mount spot to the panels: mounting, shading, horizon and (for fixed spots) direction. */
    setSpot(id) {
        const spot = this.spots().find(s => s.id === id);
        this.change(d => {
            const path = panelPath(d);
            if (!path) return d;
            d.spotId = spot ? spot.id : null;
            if (!spot) return d;
            const arrays = at(d, path);
            for (const a of arrays) {
                a.mounting = mountingForSpot(spot);
                a.shadingPct = spot.shadingPct;
                a.horizon = [...spot.horizon];
                if (finite(spot.azimuth)) a.azimuth = spot.azimuth;
                a.tilt = finite(spot.tilt) ? spot.tilt : Math.min(spot.tiltRange[1], Math.max(spot.tiltRange[0], a.tilt));
            }
            return this.syncFrames(d, arrays);
        });
    },

    /**
     * Loose panels need the catalog frame on a ground or flat-roof spot and none on a wall, railing
     * or roof (kits.js's rule when it builds a system): after a spot change, add or drop the
     * "N × frame" line to match. Only for builds that buy frames at all (a frame or loose-panel
     * line), and only when there's one set of panels to go by.
     */
    syncFrames(d, arrays) {
        const cat = this.st.catalog;
        const frame = cat?.parts?.frame;
        const panel = cat?.parts?.panel;
        if (!frame || !finite(frame.priceGbp) || (d.arrays.length && d.battery?.ups?.pvArrays?.length)) return d;
        const isFrame = c => c.year === 0 && /^\d+ × /.test(c.label) && c.label.endsWith(`× ${frame.name}`);
        const isPanel = c => c.year === 0 && panel && /^\d+ × /.test(c.label) && c.label.endsWith(`× ${panel.name}`);
        if (!d.costs.some(c => isFrame(c) || isPanel(c))) return d;
        const n = countOf(arrays);
        const open = arrays.length > 0 && arrays.every(a => a.mounting === 'open');
        d.costs = d.costs.filter(c => !isFrame(c));
        d.sourceIds = d.sourceIds.filter(x => x !== frame.id);
        if (open && n > 0) {
            const idx = d.costs.findIndex(isPanel);
            d.costs.splice(idx >= 0 ? idx + 1 : Math.min(1, d.costs.length), 0, { label: `${n} × ${frame.name}`, gbp: Math.round(frame.priceGbp * n * 100) / 100, year: 0, kind: 'hardware' });
            d.sourceIds.push(frame.id);
        }
        return d;
    },

    setDirection({ azimuth, tilt }, { fromMap = false, fromCompass = false } = {}) {
        this.change(d => {
            const path = panelPath(d);
            if (!path) return d;
            for (const a of at(d, path)) {
                if (finite(azimuth)) a.azimuth = azimuth;
                if (finite(tilt)) a.tilt = tilt;
            }
            return d;
        }, { rebuild: false, delay: 450 });
        if (finite(azimuth)) {
            if (!fromMap) this.picker?.setAzimuth?.(azimuth);
            if (!fromCompass) this.compass?.setValue?.(azimuth);
            const note = this.v?.parts.editor.querySelector('[data-role="dir-note"]');
            if (note) note.remove();
        }
        const first = panelArrays(this.st.draft)[0];
        const aside = this.v?.parts.steps.querySelector('[data-step="where"] .dv-step-aside');
        if (aside && first) aside.textContent = `${this.ctx.fmt.compass(first.azimuth)} · ${Math.round(first.tilt)}°`;
    },

    /** Loose panels (non-kit builds): lay `count` panels on the inverter's inputs and re-price the panel lines. */
    setPanelCount(count) {
        const cat = this.st.catalog;
        this.change(d => {
            const first = d.arrays[0];
            if (!first) return d;
            const nIn = d.inverter?.inputs.length ?? 1;
            const o = { azimuth: first.azimuth, tilt: first.tilt, mounting: first.mounting, shadingPct: first.shadingPct, horizon: first.horizon };
            d.arrays = layoutPanels(count, first.wp, nIn, o).map((a, i) => ({ ...(d.arrays[i] || first), ...a }));
            const panel = cat.parts?.panel;
            const frame = cat.parts?.frame;
            d.costs = d.costs.map(c => {
                const m = /^(\d+) × (.*)$/.exec(c.label);
                if (!m || c.year !== 0) return c;
                const per = +m[1] > 0 ? c.gbp / +m[1] : 0;
                if ((panel && m[2] === panel.name) || (frame && m[2] === frame.name)) return { ...c, label: `${count} × ${m[2]}`, gbp: Math.round(per * count * 100) / 100 };
                return c;
            });
            return d;
        });
    },

    setLater(plan) {
        const cat = this.st.catalog;
        this.change(d => {
            if (!plan) return { ...d, upgrade: null };
            const p = findProduct(cat, plan.productId);
            if (!p?.battery) return d;
            const costs = [{ label: p.name, gbp: p.priceGbp ?? 0, year: 0, kind: 'hardware' }];
            if (plan.how === 'hardwired' && !d.costs.some(c => c.kind === 'install')) costs.push(electricianCost(cat));
            return {
                ...d,
                upgrade: {
                    atYear: plan.year, label: `Add ${p.name}`,
                    battery: { ...clone(p.battery), coupling: 'ac', strategy: d.battery?.strategy ?? 'threshold' },
                    route: plan.how === 'hardwired' ? 'hardwired' : 'whatif',
                    costs,
                },
                sourceIds: [...new Set([...d.sourceIds, p.id])],
            };
        });
    },

    /** The later battery of a staged plan, wired in by an electrician instead of waiting for plug-in rules. */
    laterHardwired() {
        const cat = this.st.catalog;
        this.change(d => {
            if (!d.upgrade) return d;
            d.upgrade.route = 'hardwired';
            const hasInstall = d.costs.some(c => c.kind === 'install') || d.upgrade.costs.some(c => c.kind === 'install');
            if (!hasInstall) d.upgrade.costs.push(electricianCost(cat));
            return d;
        });
        this.ctx.ui.toast('Done: the later battery is wired in by an electrician.', { tone: 'good', timeoutMs: 3000 });
        this.focusRules = true;
    },

    setStrategy(strategy) {
        this.change(d => {
            if (d.battery) d.battery.strategy = strategy;
            if (d.upgrade?.battery) d.upgrade.battery.strategy = strategy;
            return d;
        });
    },

    autoExportKind(sys = this.st.draft) {
        const main = this.mainProduct(sys);
        const src = this.dsSource();
        return main?.octopus && (sys.route === 'plugin' || sys.route === 'whatif') && (src === 'octopus' || src === 'demo') ? 'prime' : 'none';
    },

    /* ── saving, pinning ────────────────────────────────────────────────── */

    save({ copy = false, quiet = false } = {}) {
        const { store } = this.ctx;
        const src = this.st.source;
        const draft = this.st.draft;
        const updating = !copy && src?.kind === 'saved' && this.savedList().some(s => s.id === src.id);
        const id = updating ? src.id : `my-${Date.now().toString(36)}`;
        let name = (draft.name || 'My option').trim();
        if (copy) name = `${name} (copy)`;
        else if (src?.kind === 'auto' && name === this.st.autos.find(a => a.id === src.id)?.name) name = `${name} (mine)`;
        const sys = normalizeSystem({ ...clone(draft), id, name, featured: false });
        store.update('scenarios', s => {
            const saved = (s.saved || []).filter(x => x?.id !== id);
            const list = updating ? (s.saved || []).map(x => (x?.id === id ? sys : x)) : [...saved, sys];
            return { ...s, saved: list, activeId: id };
        });
        this.st.draft = sys;
        this.st.source = { kind: 'saved', id };
        this.st.base = sig(sys);
        this.syncUrl();
        this.renderBar();
        this.renderEditor();
        if (!quiet) {
            this.ctx.ui.toast(updating ? `Saved “${name}”.` : `Saved as “${name}” — it’s in Compare now.`, {
                tone: 'good', action: updating ? null : { label: 'Open Compare', onClick: () => this.ctx.router.go('compare') },
            });
        }
        return id;
    },

    togglePin() {
        const { store, ui } = this.ctx;
        let id = this.persistentId();
        const pinned = this.pinnedList();
        if (id && pinned.includes(id) && !this.isDirty()) {
            store.update('scenarios', s => ({ ...s, pinned: (s.pinned || []).filter(x => x !== id) }));
            ui.toast(`Unpinned “${this.st.draft.name}”.`, { timeoutMs: 3000 });
            return;
        }
        if (pinned.length >= 4 && !(id && pinned.includes(id))) {
            ui.toast('Compare holds 4 options side by side — unpin one there first.', { tone: 'warn', action: { label: 'Open Compare', onClick: () => this.ctx.router.go('compare') } });
            return;
        }
        // an edited ready-made option or an unsaved build is saved first, so Compare shows what you see
        if (!id || this.isDirty()) id = this.save({ quiet: true });
        store.update('scenarios', s => ({ ...s, pinned: [...new Set([...(s.pinned || []), id])] }));
        ui.toast(`Pinned “${this.st.draft.name}” to Compare.`, { tone: 'good', action: { label: 'Open Compare', onClick: () => this.ctx.router.go('compare') } });
    },

    remove() {
        const { ui, store } = this.ctx;
        const src = this.st.source;
        if (src?.kind !== 'saved') return;
        const victim = this.savedList().find(s => s.id === src.id);
        if (!victim) return;
        ui.modal({
            title: `Delete “${victim.name}”?`,
            body: ui.h('p', null, 'It goes from your saved options and from Compare. This can’t be undone after you leave this page.'),
            actions: [
                { label: 'Keep it' },
                {
                    label: 'Delete', danger: true,
                    onClick: () => {
                        const before = store.get().scenarios;
                        store.update('scenarios', s => ({ ...s, saved: (s.saved || []).filter(x => x?.id !== victim.id), pinned: (s.pinned || []).filter(x => x !== victim.id), activeId: null }));
                        this.loadById(DEFAULT_ID, { quiet: true }) || this.setDraft(this.buildFrom('blank'), { kind: 'catalog', key: 'blank' });
                        this.focusBar();
                        ui.toast(`Deleted “${victim.name}”.`, {
                            timeoutMs: 12000,
                            action: { label: 'Undo', onClick: () => { store.set({ scenarios: { saved: before.saved, pinned: before.pinned } }); this.loadById(victim.id); this.focusBar(); } },
                        });
                    },
                },
            ],
        });
    },

    /**
     * Put focus on the toolbar's first action once a dialog or toast that took it has gone (the
     * control that opened it was replaced by the re-render, so the browser would drop to <body>).
     */
    focusBar() {
        setTimeout(() => {
            const a = document.activeElement;
            if (a && a !== document.body && a.isConnected && !a.closest('.toasts, dialog')) return;
            this.v?.parts.bar.querySelector('.dv-bar-actions button:not([disabled])')?.focus({ preventScroll: true });
        }, 0);
    },

    revert() {
        const src = this.st.source;
        if (src?.kind === 'saved' || src?.kind === 'auto') { this.loadById(src.id, { quiet: false }); return; }
        if (this.st.origin) this.setDraft(clone(this.st.origin), src);
    },

    /* ── runs ───────────────────────────────────────────────────────────── */

    scheduleRun(delay = 380, { user = false } = {}) {
        if (!this.v || !this.st.draft) return;
        this.ver++;
        this.userRun = this.userRun || user;
        this.setStale(true);
        if (this.st.rules) this.renderRules(true);
        clearTimeout(this.timer);
        this.timerPending = true;
        this.timer = setTimeout(() => { this.timerPending = false; this.run(); }, delay);
    },

    async run() {
        if (this.running) return;               // the loop below picks up the newer draft
        this.running = true;
        try {
            let ver;
            do {
                ver = this.ver;
                await this.runOnce(this.st.draft, ver);
            } while (this.alive && ver !== this.ver && !this.timerPending);
        } finally {
            this.running = false;
        }
    },

    async runOnce(sys, ver) {
        const { data, engine } = this.ctx;
        const stale = () => !this.alive || !this.v || ver !== this.ver;
        const finance = this.st.fin;
        try {
            const rules = await engine.call('validate', sys);
            if (stale()) return;
            this.st.rules = rules;
            this.renderRules(false);
            const quick = await data.scenario(sys, { withBand: false, finance });
            if (stale()) return;
            this.st.result = quick;
            this.st.banded = false;
            this.st.runError = null;
            this.renderResults();
            this.setStale(false);
            this.announce(quick);
            this.afterUserRun(quick);
            await this.loadDay(sys);
            if (stale()) return;
            const full = await data.scenario(sys, { withBand: true, finance });
            if (stale()) return;
            this.st.result = full;
            this.st.banded = true;
            this.renderResults();
        } catch (err) {
            if (err?.name === 'AbortError' || stale()) return;
            console.error('design run failed', err);
            this.st.runError = err;
            this.setStale(false);
            this.renderRunError();
        }
    },

    async loadDay(sys = this.st.draft) {
        const { engine, data, store } = this.ctx;
        const which = this.st.which === 'date' ? this.st.date : this.st.which;
        if (!which || !this.v) return;
        const key = `${data.summary()?.id}|${store.get().settings?.projectBaseW}|${which}|${sig(sys)}`;
        const tok = ++this.dayToken;
        let day = this.dayMemo.get(key);
        if (!day) {
            this.v.parts.dayWrap?.classList.add('is-stale');
            try {
                day = await engine.call('typicalDay', sys, which);
            } catch (err) {
                if (err?.name === 'AbortError' || tok !== this.dayToken || !this.v) return;
                this.st.dayError = err;
                this.st.day = null;
                this.renderDay();
                return;
            }
            this.dayMemo.set(key, day);
            if (this.dayMemo.size > DAY_MEMO_MAX) this.dayMemo.delete(this.dayMemo.keys().next().value);
        }
        if (tok !== this.dayToken || !this.alive || !this.v) return;
        this.st.day = day;
        this.st.dayError = null;
        this.renderDay();
    },

    announce(res) {
        const { fmt } = this.ctx;
        const h = res.headline || {};
        const live = this.v?.parts.live;
        if (!live) return;
        const r = this.st.rules;
        const legal = !r ? null : r.errors?.length ? `Not allowed as built: ${r.errors.map(e => e.message).join(' ')}` : (LEGAL[r.legal] || LEGAL.ok).label;
        const said = legal && legal !== this.lastLegal ? ` ${legal}.` : '';
        this.lastLegal = legal;
        const money = h.savingsGbp < -0.5 ? `costs you ${fmt.gbp(-h.savingsGbp)} a year` : `saves ${fmt.gbp(h.savingsGbp)} a year`;
        const pays = !(h.capexGbp > 0) ? 'nothing to buy' : h.paybackYears == null ? 'never pays back' : `pays back in ${fmt.years(h.paybackYears)}`;
        live.textContent = `${this.st.draft.name}: ${money}, ${pays}.${said}`;
    },

    /** On a narrow screen the results sit below the build: after an edit, say what changed and offer to jump. */
    afterUserRun(res) {
        if (!this.userRun) return;
        this.userRun = false;
        if (!this.visible || typeof window === 'undefined' || window.innerWidth >= 1024) return;
        const card = this.v?.parts.readout;
        if (!card) return;
        const r = card.getBoundingClientRect();
        if (r.top < window.innerHeight && r.bottom > 0) return;
        const { fmt, shell } = this.ctx;
        const h = res.headline || {};
        shell.rerun.show({
            text: `${fmt.gbp(h.savingsGbp)}/yr · ${h.capexGbp > 0 ? (h.paybackYears == null ? 'never pays back' : `pays back ${fmt.years(h.paybackYears)}`) : 'no cost'}`,
            actionLabel: 'See results',
            onRun: () => { this.barShown = false; card.scrollIntoView({ behavior: 'smooth', block: 'start' }); card.querySelector('.dv-fig')?.focus?.({ preventScroll: true }); },
            onDismiss: () => { this.barShown = false; },
        });
        this.barShown = true;
    },

    /* ── skeleton, errors ───────────────────────────────────────────────── */

    head(summary) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const fin = this.financeView();
        const bits = [h('b', null, `First year, ${yearSpan(fin.installDate)}`), ', typical weather'];
        if (summary) {
            bits.push(` · ${fmt.num(Math.round(summary.days || 0))} days of your half-hours`);
            const pb = this.ctx.store.get().settings?.projectBaseW;
            if (finite(pb)) bits.push(' · ', h('b', null, `projected with ${fmt.w(pb)} always-on`));
            else if (finite(summary.baseLoadW)) bits.push(` · always-on ${fmt.w(summary.baseLoadW)}`);
        }
        // page-only money assumptions (Advanced) make these figures differ from Verdict and Compare
        if (Object.keys(this.st?.fin || {}).length) bits.push(' · ', h('b', null, 'this page’s own money assumptions'));
        return h('div', { class: 'view-head' }, h('div', null,
            h('div', { class: 'view-kicker' }, 'Design'),
            h('h1', { class: 'view-title', tabindex: '-1' }, 'Build an option and test it'),
            h('p', { class: 'context-line' }, bits)));
    },

    skeleton(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'dv', 'aria-busy': 'true' },
            this.head(summary),
            h('div', { class: 'dv-bar' }, h('div', { style: { flex: '1 1 auto', padding: '6px' } }, ui.skeleton({ height: 30 }))),
            h('div', { class: 'dv-grid' },
                ui.card({ eyebrow: 'The build', title: 'What you’d buy', body: h('div', { class: 'stack-sm' }, ui.skeleton({ lines: 5 }), ui.skeleton({ height: 200 }), ui.skeleton({ lines: 4 })) }),
                h('div', { class: 'dv-results' },
                    ui.card({ accent: true, body: h('div', { class: 'stack-sm' },
                        summary ? h('span', { class: 'dv-status', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Setting up the ready-made options — a few seconds the first time…') : null,
                        ui.skeleton({ height: 64 }), ui.skeleton({ lines: 3 })) }),
                    ui.card({ title: 'A day in the life', body: ui.skeleton({ height: 260 }) }))));
    },

    errorCard(err) {
        const { ui } = this.ctx;
        const h = ui.h;
        return h('div', { class: 'dv' }, this.head(this.ctx.data.summary()),
            ui.card({ body: h('div', { class: 'dv-err' },
                h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'), h('span', null, `Couldn’t open the design workbench: ${err?.message || err}`)),
                h('div', { class: 'row' },
                    ui.button({ label: 'Try again', icon: 'refresh', onClick: () => { this.v = null; this.render(); } }),
                    ui.button({ label: 'Back to the verdict', kind: 'ghost', href: '#verdict' }))) }));
    },

    /* ── build the page once per dataset ────────────────────────────────── */

    build(summary) {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = {};
        p.head = h('div');
        p.bar = h('div', { class: 'dv-bar', role: 'toolbar', 'aria-label': 'This option' });
        // not a live region: it re-renders on every edit; legality changes are announced with the result
        p.rulesHost = h('div', { class: 'dv-rules' });
        p.steps = h('div', { class: 'dv-steps' });
        p.mode = h('div');
        p.editor = h('section', { class: 'card dv-editor', 'aria-labelledby': 'dv-editor-title' },
            h('div', { class: 'dv-editor-head' },
                h('div', null, h('div', { class: 'dv-editor-sub' }, 'The build'), h('h2', { class: 'dv-editor-title', id: 'dv-editor-title' }, 'What you’d buy')),
                p.mode),
            p.rulesHost, p.steps);
        p.status = h('span', { class: 'dv-status', 'aria-hidden': 'true' });
        p.readout = h('section', { class: 'card card-accent dv-readout', 'aria-labelledby': 'dv-money' });
        p.energy = h('div');
        p.details = h('div');
        p.runError = h('div', { class: 'dv-runerr', hidden: true });
        p.dayWrap = h('div', { class: 'dv-day' });
        p.dayTools = h('div', { class: 'dv-day-tools' });
        p.daySub = h('span');
        p.dayFlows = h('div', { class: 'dv-untitled' });
        p.dayPrices = h('div', { class: 'dv-untitled' });
        p.dayNote = h('div');
        p.dayWrap.append(p.dayFlows, p.dayPrices, p.dayNote);
        p.monthly = h('div', { class: 'dv-untitled' });
        p.monthlySub = h('span');
        p.cash = h('div', { class: 'dv-untitled' });
        p.cashSub = h('span');
        p.battery = h('div');
        p.notes = h('div');
        p.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
        p.print = h('div', { class: 'dv-print' });
        p.results = h('div', { class: 'dv-results', 'aria-label': 'Results' },
            p.print,
            p.runError,
            p.readout,
            p.energy,
            p.details,
            ui.card({ eyebrow: 'A day in the life', title: 'Half-hour by half-hour', subtitle: p.daySub, actions: p.dayTools, body: p.dayWrap }),
            ui.card({ eyebrow: 'Month by month', title: 'When in the year it saves', subtitle: p.monthlySub, body: p.monthly }),
            ui.card({ eyebrow: 'Over the years', title: 'Money back, year by year', subtitle: p.cashSub, body: p.cash }),
            p.battery,
            p.notes);
        const root = h('div', { class: 'dv' }, p.head, p.bar, h('div', { class: 'dv-grid' }, p.editor, p.results), p.live);
        p.bar.addEventListener('pointerdown', () => {
            this.barPointerDown = true;
            const up = () => setTimeout(() => {
                this.barPointerDown = false;
                if (this.barPending) { this.barPending = false; this.renderBar(); }
            }, 0);
            window.addEventListener('pointerup', up, { once: true, capture: true });
            window.addEventListener('pointercancel', up, { once: true, capture: true });
        }, true);
        this.el.replaceChildren(root);
        this.v = { dsId: summary.id, root, parts: p, charts: {} };
    },

    renderAll() {
        if (!this.v) return;
        this.renderHead();
        this.renderBar();
        this.renderMode();
        this.renderEditor();
        this.renderRules(true);
        this.renderDayTools();
        if (this.st.result) this.renderResults();
        else this.renderResultsWaiting();
    },

    renderHead() {
        this.v?.parts.head.replaceChildren(this.head(this.ctx.data.summary()));
    },

    /* ── toolbar ────────────────────────────────────────────────────────── */

    renderBar() {
        if (!this.v || !this.st.draft) return;
        const { ui } = this.ctx;
        const h = ui.h;
        const src = this.st.source || {};
        const dirty = this.isDirty();
        const saved = src.kind === 'saved';
        const id = this.persistentId();
        const pinned = !!id && this.pinnedList().includes(id) && !dirty;
        const nameInput = ui.textInput({
            value: this.st.draft.name, ariaLabel: 'Name of this option', maxLength: 80,
            onChange: v => {
                const name = v.trim() || this.st.draft.name;
                this.st.draft = { ...this.st.draft, name };
                this.renderBarSafe();
            },
        });
        nameInput.dataset.k = 'name';
        const badges = [];
        if (saved) badges.push(ui.badge({ text: 'Saved', tone: 'good' }));
        else if (src.kind === 'auto') badges.push(ui.badge({ text: 'Ready-made', tone: 'accent' }));
        else badges.push(ui.badge({ text: 'Not saved' }));
        if (dirty && src.kind !== 'catalog' && src.kind !== 'unsaved') badges.push(ui.badge({ text: 'Edited', tone: 'warn' }));
        const actions = [
            dirty && this.st.origin ? ui.button({ label: 'Undo changes', kind: 'ghost', size: 'sm', icon: 'refresh', onClick: () => this.revert() }) : null,
            ui.button({ label: saved ? 'Save' : 'Save it', kind: dirty || src.kind === 'catalog' || src.kind === 'unsaved' ? 'primary' : 'default', size: 'sm', disabled: saved && !dirty, onClick: () => this.save() }),
            ui.button({ label: 'Save a copy', size: 'sm', onClick: () => this.save({ copy: true }) }),
            saved ? ui.button({ label: 'Delete', kind: 'ghost', size: 'sm', onClick: () => this.remove() }) : null,
        ].filter(Boolean);
        const pin = ui.button({ label: pinned ? 'Pinned to Compare' : 'Pin to Compare', size: 'sm', icon: pinned ? 'check' : 'arrowRight', onClick: () => this.togglePin() });
        pin.setAttribute('aria-pressed', String(pinned));
        actions.push(pin);
        const focusKey = this.v.parts.bar.contains(document.activeElement) ? (document.activeElement.dataset?.k || document.activeElement.textContent) : null;
        // phones: the results sit below the build, so the headline rides in the toolbar with a jump link
        const res = this.st.result;
        const hl = res && sig(res.system) === sig(this.st.draft) ? res.headline : null;
        const mini = hl ? h('button', {
            type: 'button', class: 'link-btn dv-mini',
            on: { click: () => { this.v.parts.readout.scrollIntoView({ behavior: 'smooth', block: 'start' }); this.v.parts.readout.querySelector('.dv-fig')?.focus({ preventScroll: true }); } },
        }, this.ctx.ui.icon('arrowRight'), h('span', null, 'Saves ', h('b', null, this.ctx.fmt.gbp(hl.savingsGbp)), ' a year · ', hl.capexGbp > 0 ? ['pays back in ', h('b', null, this.ctx.fmt.years(hl.paybackYears))] : 'no cost', ' · see results')) : null;
        this.v.parts.bar.replaceChildren(...[
            h('div', { class: 'dv-bar-name' }, h('span', { class: 'dv-bar-pencil', 'aria-hidden': 'true' }, ui.icon('pencil')), nameInput, h('div', { class: 'dv-bar-badges' }, badges)),
            mini,
            h('div', { class: 'dv-bar-actions' }, actions)].filter(Boolean));
        if (focusKey) {
            // "Undo changes" and "Delete" go away once used: land on the next action instead of <body>
            const t = focusKey === 'name' ? nameInput : [...this.v.parts.bar.querySelectorAll('button')].find(b => b.textContent === focusKey)
                ?? this.v.parts.bar.querySelector('.dv-bar-actions button:not([disabled])');
            t?.focus?.({ preventScroll: true });
        }
    },

    /**
     * Re-render the toolbar unless a pointer is down on it: committing the name (blur) on the
     * mousedown of "Save" must not replace the button before its click lands.
     */
    renderBarSafe() {
        if (this.barPointerDown) { this.barPending = true; return; }
        this.renderBar();
    },

    renderMode() {
        const { ui, store } = this.ctx;
        const mode = store.get().ui?.designMode === 'advanced' ? 'advanced' : 'simple';
        const seg = ui.segmented({
            ariaLabel: 'How much to show', size: 'sm', value: mode,
            options: [{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }],
            onChange: v => { store.set({ ui: { designMode: v } }); this.renderEditor(); },
        });
        this.v.parts.mode.replaceChildren(seg);
    },

    /* ── rules ──────────────────────────────────────────────────────────── */

    renderRules(checking) {
        if (!this.v) return;
        const { ui } = this.ctx;
        const h = ui.h;
        const host = this.v.parts.rulesHost;
        const r = this.st.rules;
        if (!r) {
            host.replaceChildren(h('div', { class: 'dv-checking' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking the rules…'));
            return;
        }
        const legal = r.errors?.length ? { tone: 'bad', label: `Not allowed as built — ${r.errors.length === 1 ? 'one problem' : `${r.errors.length} problems`}` } : LEGAL[r.legal] || LEGAL.ok;
        const route = this.st.draft?.route;
        const next = r.errors?.length ? 'Pick a fix below, or change the build.' : LEGAL_NEXT[route] || '';
        const issue = (it, tone) => h('div', { class: ['notice', tone === 'bad' ? 'notice-bad' : tone === 'warn' ? 'notice-warn' : null, 'dv-issue'] },
            ui.icon(tone === 'info' ? 'info' : 'alert'),
            h('div', { class: 'dv-issue-text' }, it.message),
            it.fixes?.length ? h('div', { class: 'dv-issue-fixes' }, it.fixes.map((f, i) => {
                const b = ui.button({ label: f.label, size: 'sm', kind: tone === 'bad' && i === 0 ? 'primary' : 'default', onClick: () => (f.local ? f.local() : this.applyFix(f, b)) });
                return b;
            })) : null);
        // rules.js checks stage 2 of a staged plan for errors only, so a later plug-in battery
        // (legal 'whatif') passes silently: say it here, next to the rules, with a way out
        const d = this.st.draft;
        const later = d?.upgrade?.battery && d.upgrade.route === 'whatif' && d.route !== 'whatif' ? {
            message: `Later step: plug-in batteries aren’t legal yet, so the battery at the end of year ${d.upgrade.atYear} counts on the rules changing first (Octopus hopes for early 2027).`,
            fixes: [{ label: 'Have an electrician fit it instead', local: () => this.laterHardwired() }],
        } : null;
        host.replaceChildren(...[
            h('div', { class: 'dv-legal', tabindex: '-1' },
                ui.badge({ text: legal.label, tone: legal.tone }),
                h('span', null, next),
                checking ? h('span', { class: 'dv-checking' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'checking…') : null),
            ...(r.errors || []).map(it => issue(it, 'bad')),
            later ? issue(later, 'warn') : null,
            ...(r.warnings || []).filter(w => w.code !== 'WHATIF').map(it => issue(it, it.fixes?.length ? 'warn' : 'info')),
        ].filter(Boolean));   // replaceChildren would print a null as the text "null"
        if (!checking && this.focusRules) {
            this.focusRules = false;
            host.querySelector('.dv-legal')?.focus({ preventScroll: true });
        }
    },

    /* ── the editor ─────────────────────────────────────────────────────── */

    renderEditor() {
        if (!this.v || !this.st.draft) return;
        const host = this.v.parts.steps;
        const panel = this.v.parts.editor;
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        // a control that removes itself (Add one later…, Remove, Cancel) names where focus goes next
        const moved = !!this.pendingFocus;
        const key = this.pendingFocus ?? (active && host.contains(active) ? active.closest('[data-k]')?.dataset.k : null);
        this.pendingFocus = null;
        const top = panel.scrollTop;
        host.replaceChildren(...this.editorBody());
        panel.scrollTop = top;
        if (key) {
            const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
            const t = host.querySelector(`[data-k="${esc}"]`);
            const f = t?.matches('input,select,textarea,button,[tabindex]') ? t : t?.querySelector('input,select,textarea,button,[role="slider"],[role="radio"][tabindex="0"]');
            f?.focus?.({ preventScroll: true });
            if (moved) f?.scrollIntoView?.({ block: 'nearest' });
        }
        if (this.st.mapOpen && this.picker) requestAnimationFrame(() => this.picker?.map?.invalidateSize?.());
    },

    editorBody() {
        const { ui, store } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const adv = store.get().ui?.designMode === 'advanced';
        const steps = [];
        let n = 0;
        const step = (title, body, { aside, k } = {}) => {
            n++;
            const hid = ui.uniqueId('dvs');
            steps.push(h('section', { class: 'dv-step', 'aria-labelledby': hid, dataset: { step: k } },
                h('div', { class: 'dv-step-head' },
                    h('span', { class: 'dv-step-n', 'aria-hidden': 'true' }, String(n).padStart(2, '0')),
                    h('h3', { class: 'dv-step-title', id: hid }, title),
                    aside ? h('span', { class: 'dv-step-aside' }, aside) : null),
                body));
        };

        step('Start from', this.stepStart(adv), { k: 'start' });
        const where = this.stepWhere();
        if (where) step('Where it goes', where.body, { aside: where.aside, k: 'where' });
        const batt = this.stepBattery();
        if (batt) step(batt.title, batt.body, { aside: batt.aside, k: 'battery' });
        if (d.battery || d.upgrade?.battery) step('Automation', this.stepAutomation(), { k: 'automation' });
        step('What it costs', this.stepCosts(adv), { aside: ui.fmt.gbp(d.costs.filter(c => c.year === 0).reduce((s, c) => s + c.gbp, 0)), k: 'costs' });
        if (d.arrays.length) step('Export payments', this.stepExport(), { k: 'export' });
        if (adv) steps.push(this.advanced());
        return steps;
    },

    /** Wrap a control in ui.field, tagged so focus can be restored after a rebuild. */
    fld(label, input, { hint, key, wide } = {}) {
        const f = this.ctx.ui.field({ label, hint, input });
        if (key) f.dataset.k = key;
        if (wide) f.classList.add('dv-wide');
        return f;
    },

    numF(label, path, o = {}) {
        const { ui } = this.ctx;
        const scale = o.scale ?? 1;
        const raw = at(this.st.draft, path);
        const input = ui.numberInput({
            value: raw == null || !finite(raw) ? null : raw * scale, min: o.min, max: o.max, step: o.step ?? 1, unit: o.unit, dp: o.dp,
            allowEmpty: !!o.allowEmpty, placeholder: o.placeholder,
            onChange: v => this.change(d => { put(d, path, v == null ? (o.empty ?? null) : v / scale); return o.after ? o.after(d) : d; }),
        });
        return this.fld(label, input, { hint: o.hint, key: path.join('.'), wide: o.wide });
    },

    selF(label, path, options, o = {}) {
        const { ui } = this.ctx;
        const cur = at(this.st.draft, path);
        const input = ui.select({
            options: options.map(x => ({ ...x, value: String(x.value) })), value: String(cur),
            onChange: v => this.change(d => { const opt = options.find(x => String(x.value) === v); put(d, path, opt ? opt.value : v); return o.after ? o.after(d) : d; }),
        });
        return this.fld(label, input, { hint: o.hint, key: path.join('.'), wide: o.wide });
    },

    togF(label, path, o = {}) {
        const { ui } = this.ctx;
        const t = ui.toggle({
            label, hint: o.hint, checked: o.get ? o.get(this.st.draft) : !!at(this.st.draft, path),
            onChange: v => this.change(d => { if (o.set) o.set(d, v); else put(d, path, v); return d; }),
        });
        const w = this.ctx.ui.h('div', { class: ['dv-tog', o.wide !== false && 'dv-wide'], dataset: { k: path.join('.') } }, t);
        return w;
    },

    textF(label, path, o = {}) {
        const { ui } = this.ctx;
        const cur = at(this.st.draft, path);
        const input = ui.textInput({
            value: o.format ? o.format(cur) : cur ?? '', placeholder: o.placeholder, inputmode: o.inputmode, maxLength: o.maxLength,
            onChange: v => {
                const parsed = o.parse ? o.parse(v) : v;
                if (parsed === undefined) { input.setAttribute('aria-invalid', 'true'); return; }
                input.removeAttribute('aria-invalid');
                this.change(d => { put(d, path, parsed); return d; });
            },
        });
        return this.fld(label, input, { hint: o.hint, key: path.join('.'), wide: o.wide });
    },

    /* step 01 — start from */
    stepStart(adv) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const cat = this.st.catalog;
        const d = this.st.draft;
        const options = [];
        const saved = this.savedList();
        for (const s of saved) options.push({ value: `saved:${s.id}`, label: s.name, group: 'Your saved options' });
        const autos = this.st.autos.filter(a => a.featured && a.route !== 'reference');
        for (const a of autos) options.push({ value: `auto:${a.id}`, label: a.name, group: 'Ready-made options' });
        const src = this.st.source;
        if (src?.kind === 'auto' && !autos.some(a => a.id === src.id)) {
            const a = this.st.autos.find(x => x.id === src.id);
            if (a) options.push({ value: `auto:${a.id}`, label: a.name, group: 'Ready-made options' });
        }
        const sale = p => (p.onSale === false ? ' · not on sale' : p.preorder ? ' · pre-order' : '');
        const byOnSale = (a, b) => (b.onSale !== false) - (a.onSale !== false) || (a.priceGbp ?? 0) - (b.priceGbp ?? 0);
        const plug = cat.kits.filter(k => k.route === 'plugin' && k.kind === 'microinverter' && k.includedPanels).sort(byOnSale);
        for (const k of plug) options.push({ value: `kit:${k.id}`, label: `${k.name} · ${fmt.gbp(k.priceGbp)}${sale(k)}`, group: ROUTES.plugin.label });
        const wired = cat.kits.filter(k => k.route === 'hardwired' && ['microinverter', 'battery-inverter', 'battery-addon'].includes(k.kind)).sort(byOnSale);
        for (const b of cat.bundles) options.push({ value: `bundle:${b.id}`, label: `${b.name} · ${fmt.gbp(b.priceGbp)}`, group: ROUTES.hardwired.label });
        for (const k of wired) {
            // the size only when the product's name doesn't already say it ("Thunder Vault 1.92 kWh")
            const size = /\bkWh\b/.test(k.name || '') || !finite(k.battery?.capacityKwh) ? '' : `${fmt.num(k.battery.capacityKwh, 1)} kWh `;
            const what = k.kind === 'battery-addon' ? ` (battery only${size ? `, ${size.trim()}` : ''})`
                : k.kind === 'battery-inverter' ? ` (${size}battery + panels)` : k.includedPanels ? '' : ' (+ panels)';
            options.push({ value: `kit:${k.id}`, label: `${k.name}${what} · ${fmt.gbp(k.priceGbp)}${sale(k)}`, group: ROUTES.hardwired.label });
        }
        for (const s of [...cat.stations].sort(byOnSale)) options.push({ value: `station:${s.id}`, label: `${s.name}${kwhTag(s.name, s.capacityKwh, fmt)} · ${fmt.gbp(s.priceGbp)}${sale(s)}`, group: ROUTES.ups.label });
        options.push({ value: 'blank', label: 'My own plug-in build (any panels)', group: 'Something else' });
        const cur = sourceKey(src);
        if (!options.some(o => o.value === cur)) options.unshift({ value: '', label: this.isDirty() ? `${d.name} (edited)` : d.name });
        const sel = ui.select({ options, value: cur, onChange: v => this.startFrom(v), ariaLabel: 'Start from: an option or product' });
        const route = ROUTES[d.route] || ROUTES.plugin;
        const main = this.mainProduct();
        const facts = [];
        const wp = wpOf(d.arrays) + wpOf(d.battery?.ups?.pvArrays);
        if (wp > 0) facts.push(ui.badge({ text: `${fmt.num(wp)} W of panels` }));
        if (d.inverter) facts.push(ui.badge({ text: `${fmt.num(d.inverter.acLimitW)} W out` }));
        if (d.battery) facts.push(ui.badge({ text: `${fmt.num(d.battery.capacityKwh, d.battery.capacityKwh < 10 ? 2 : 1)} kWh ${d.battery.coupling === 'ups' ? 'power station' : 'battery'}` }));
        if (main?.onSale === false) facts.push(ui.badge({ text: 'Not on sale now', tone: 'warn' }));
        else if (main?.preorder) facts.push(ui.badge({ text: 'Pre-order', tone: 'warn' }));
        const out = [
            this.fld('Option or product', sel, { key: 'start', hint: 'A saved option, a ready-made one, any product we know, or your own build. Panels keep their place when you switch.' }),
            h('div', { class: ['dv-route', `dv-route-${d.route}`] },
                h('div', { class: 'dv-route-name' }, route.label),
                h('div', { class: 'dv-route-line' }, route.line)),
            facts.length ? h('div', { class: 'dv-facts' }, facts) : null,
        ];
        if (adv && d.route !== 'reference') {
            const seg = ui.segmented({
                ariaLabel: 'How it connects', size: 'sm', value: d.route,
                options: ROUTE_ORDER.map(r => ({ value: r, label: { plugin: 'Plug-in', hardwired: 'Electrician', ups: 'Power station', whatif: 'Future rules' }[r], title: ROUTES[r].label })),
                onChange: r => this.applyFix({ label: `treat it as “${ROUTES[r].label}”`, action: { type: 'setRoute', route: r, addElectrician: r === 'hardwired' } }),
            });
            out.push(h('div', { dataset: { k: 'route' } }, this.fld('How it connects', seg, { hint: 'Switching route checks the rules again; an electrician adds their cost line.' })));
        }
        return h('div', { class: 'stack-sm' }, out);
    },

    /* step 02 — where it goes */
    stepWhere() {
        const { ui, fmt, data } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const cat = this.st.catalog;
        const parts = [];
        const stationMain = d.route === 'ups' && this.mainProduct()?.kind === 'power-station' ? this.mainProduct() : null;
        // a power station's own panels: how many can really be wired
        if (stationMain && stationMain.pvWireablePanels > 0) {
            const count = countOf(d.battery?.ups?.pvArrays);
            const opts = Array.from({ length: stationMain.pvWireablePanels + 1 }, (_, i) => ({ value: String(i), label: i === 0 ? 'None — it charges from the socket' : `${i} × ${cat.parts?.panel?.includedPanels?.wp ?? 460} W on its own solar input${i > 1 ? 's' : ''}` }));
            parts.push(this.fld('Panels on the power station', ui.select({ options: opts, value: String(count), onChange: v => this.setStationPanels(+v) }),
                { key: 'stationPanels', hint: stationMain.pvNote || `Its solar inputs take up to ${stationMain.pvWireablePanels} typical panel${stationMain.pvWireablePanels > 1 ? 's' : ''}. No 800 W limit and nothing to register — the panels never touch the grid.` }));
        } else if (stationMain) {
            parts.push(h('p', null, 'This power station has no solar input you can use, so it only charges from the socket.'));
        }
        const arrays = panelArrays(d);
        if (!arrays.length) return parts.length ? { body: h('div', { class: 'stack-sm' }, parts), aside: null } : null;

        // loose panels on a wired-in or custom build: how many
        const main = this.mainProduct();
        const kitAsSold = d.route === 'plugin' && main?.includedPanels && main.kind === 'microinverter';
        if (d.arrays.length && !kitAsSold) {
            const count = countOf(d.arrays);
            parts.push(this.fld('Panels', ui.numberInput({ value: count, min: 1, max: 12, step: 1, unit: `× ${fmt.num(d.arrays[0].wp)} W`, onChange: v => this.setPanelCount(Math.round(v)) }),
                { key: 'panelCount', hint: `${fmt.num(wpOf(d.arrays))} W in all, one panel per solar input while inputs last.` }));
        }

        const spots = this.spots();
        const cur = spots.find(s => s.id === d.spotId);
        const spotOpts = spots.map(s => ({ value: s.id, label: s.name }));
        spotOpts.push({ value: '', label: 'Somewhere else — I’ll set the direction' });
        const spotSel = ui.select({ options: spotOpts, value: cur ? cur.id : '', onChange: v => this.setSpot(v || null), ariaLabel: 'Where the panels go' });
        const spotHint = cur
            ? [`A ${SPOT_KIND[cur.kind] || cur.kind}`, finite(cur.azimuth) ? `facing ${fmt.compass(cur.azimuth)}` : 'any direction', cur.tiltRange[0] === cur.tiltRange[1] ? `${cur.tiltRange[0]}°` : `${cur.tiltRange[0]}–${cur.tiltRange[1]}°`, `up to ${cur.maxPanels} panels`, cur.groundLevel ? null : 'above ground level'].filter(Boolean).join(' · ')
            : 'Set the direction and tilt below.';
        parts.push(this.fld('Where', spotSel, { key: 'spot', hint: h('span', null, spotHint, ' · ', h('a', { href: '#method' }, 'Your spots are set in Method')) }));

        const first = arrays[0];
        const mixed = arrays.some(a => a.azimuth !== first.azimuth || a.tilt !== first.tilt);
        const fixedAz = cur && finite(cur.azimuth);
        const fixedTilt = cur && cur.tiltRange[0] === cur.tiltRange[1];
        const tmin = cur ? cur.tiltRange[0] : 0;
        const tmax = cur ? cur.tiltRange[1] : 90;
        const side = [];
        let compass = null;
        if (fixedAz) {
            this.compass = null;
            side.push(h('div', { class: 'dv-fixed-dir' }, h('b', null, `${fmt.compass(first.azimuth)} ${Math.round(first.azimuth)}°`), h('span', null, 'set by this spot')));
        } else {
            compass = ui.compassInput({ azimuth: first.azimuth, size: typeof window !== 'undefined' && window.innerWidth <= 600 ? 200 : 176, onChange: az => this.setDirection({ azimuth: az }, { fromCompass: true }) });
            this.compass = compass;
        }
        if (fixedTilt) side.push(h('div', { class: 'dv-fixed-dir' }, h('b', null, `${Math.round(first.tilt)}° tilt`), h('span', null, first.tilt >= 89 ? 'vertical' : 'set by this spot')));
        else {
            const sl = ui.slider({ value: Math.min(tmax, Math.max(tmin, Math.round(first.tilt))), min: tmin, max: tmax, step: 1, ariaLabel: 'Tilt from flat',
                format: v => `${v}°`, onChange: v => this.setDirection({ tilt: v }) });
            side.push(this.fld('Tilt from flat', sl, { key: 'tilt', hint: '0° lies flat, 90° is upright on a wall.' }));
        }
        const summary = data.summary();
        if (!fixedAz && finite(summary?.lat) && finite(summary?.lon)) {
            const b = ui.button({ label: this.st.mapOpen ? 'Hide the map' : 'Point it on the map', size: 'sm', kind: 'ghost', icon: 'arrowRight', onClick: () => this.toggleMap() });
            b.dataset.k = 'map';
            b.setAttribute('aria-expanded', String(this.st.mapOpen));
            side.push(b);
        }
        parts.push(h('div', { class: 'dv-dir', dataset: { k: 'compass' } },
            compass ? this.fld('Facing', compass, { key: 'facing' }) : null,
            h('div', { class: 'dv-dir-side' }, side)));
        if (mixed) parts.push(h('p', { 'data-role': 'dir-note' }, `Your panels point ${new Set(arrays.map(a => `${a.azimuth}|${a.tilt}`)).size} different ways; turning the dial points them all together. Set each one under Advanced › Panels and wiring.`));
        if (this.st.mapOpen && !fixedAz) parts.push(this.mapHost(first.azimuth));
        const id = this.persistentId();
        if (id && !this.isDirty()) parts.push(h('a', { class: 'link-btn', href: `#orientation?scenario=${encodeURIComponent(id)}` }, ui.icon('sun'), 'Find the best direction for this option'));
        return { body: h('div', { class: 'stack-sm' }, parts), aside: mixed ? 'mixed' : `${fmt.compass(first.azimuth)} · ${Math.round(first.tilt)}°` };
    },

    mapHost(azimuth) {
        const { ui } = this.ctx;
        if (!this.mapBox) {
            this.mapBox = ui.h('div', { class: 'map-box dv-map', 'aria-label': 'Satellite view: drag the handle to the way the panels face' });
            const s = this.ctx.data.summary();
            import('../map.js')
                .then(m => m.createAzimuthPicker(this.mapBox, { lat: s.lat, lon: s.lon, azimuth, onChange: az => this.setDirection({ azimuth: az }, { fromMap: true }) }))
                .then(p => { this.picker = p; })
                .catch(err => {
                    this.mapBox?.replaceChildren(ui.h('div', { class: 'notice notice-warn' }, ui.icon('alert'), ui.h('span', null, `The map didn’t load: ${err?.message || err}`)));
                });
        } else {
            this.picker?.setAzimuth?.(azimuth);
        }
        return this.mapBox;
    },

    toggleMap() {
        this.st.mapOpen = !this.st.mapOpen;
        this.renderEditor();
    },

    /* step 03 — battery / the power station */
    stepBattery() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const cat = this.st.catalog;
        if (d.route === 'reference') return null;
        const base = this.baseLoadW();
        const b = d.battery;

        // the power station IS the product (route ups) or the battery IS the product (an add-on bought alone)
        if (this.batteryIsProduct()) {
            const main = this.mainProduct();
            const parts = [];
            if (b.coupling === 'ups') {
                const ded = b.ups?.dedicatedW;
                parts.push(this.fld('Server power on the power station', ui.numberInput({
                    value: finite(ded) ? ded : null, min: 0, max: 5000, step: 10, unit: 'W', allowEmpty: true, placeholder: finite(base) ? `${Math.round(base)} (your always-on load)` : 'your always-on load',
                    onChange: v => this.change(x => { x.battery.ups.dedicatedW = v == null ? 'baseload' : v; return x; }),
                }), { key: 'dedicatedW', hint: `Your always-on load is ${finite(base) ? fmt.w(base) : 'not known yet'} — use less if some of it isn’t the servers (fridge, router…). Leave empty to use it all.` }));
                parts.push(h('p', { class: 'dv-p' }, h('b', null, `${fmt.num(b.capacityKwh, 2)} kWh`), ` · charges at up to ${fmt.w(b.ups?.chargeW ?? b.acChargeW)} · outlets up to ${fmt.w(b.ups?.outletMaxW ?? b.acOutputW)}`,
                    main?.upsSwitchMs ? ` · ${main.upsSwitchMs} ms switchover` : '', main?.hid ? ' · USB shutdown signal' : '', '.'));
                if (main?.smartPlugOnly) parts.push(h('p', { class: 'dv-p' }, 'It has no price-aware schedule of its own: automate it with a smart plug on its mains lead (Home Assistant or similar).'));
            } else {
                parts.push(h('p', { class: 'dv-p' }, h('b', null, `${fmt.num(b.capacityKwh, 2)} kWh`), ` · charges at up to ${fmt.w(b.maxChargeW)} · gives up to ${fmt.w(b.maxDischargeW)}. It works on its own, charging from the grid in cheap half-hours.`));
            }
            return { title: b.coupling === 'ups' ? 'The power station' : 'The battery', body: h('div', { class: 'stack-sm' }, parts), aside: `${fmt.num(b.capacityKwh, 2)} kWh` };
        }

        const main = this.mainProduct();
        const builtin = b && b.coupling === 'dc' && main?.kind === 'battery-inverter';
        const bp = this.batteryProduct();
        const options = [];
        const packs = builtin ? this.expansionPacks() : [];
        if (builtin) {
            options.push({ value: 'builtin', label: `Built in: ${fmt.num(main.battery?.capacityKwh ?? b.capacityKwh, 2)} kWh` });
            packs.forEach((x, i) => options.push({ value: `exp:${i}`, label: `Built in + ${x.short} (+${fmt.num(x.kwh, 2)} kWh, ${fmt.gbp(x.priceGbp)})`, group: 'Add the maker’s extra battery' }));
        } else options.push({ value: 'none', label: 'No battery' });
        const addons = cat.kits.filter(k => k.kind === 'battery-addon' && k.battery).sort((x, y) => (y.onSale !== false) - (x.onSale !== false) || (x.priceGbp ?? 0) - (y.priceGbp ?? 0));
        if (!builtin) {
            for (const k of addons) options.push({ value: `kit:${k.id}`, label: `${k.name}${kwhTag(k.name, k.battery.capacityKwh, fmt)} · ${fmt.gbp(k.priceGbp)}${k.onSale === false ? ' · not on sale' : ''}`, group: 'Home batteries (wired in)' });
            for (const s of [...cat.stations].filter(s => s.onSale !== false).sort((x, y) => x.priceGbp - y.priceGbp)) options.push({ value: `station:${s.id}`, label: `${s.name}${kwhTag(s.name, s.capacityKwh, fmt)} · ${fmt.gbp(s.priceGbp)}`, group: 'Power stations (run the servers)' });
        }
        let value = builtin ? this.expansionValue(packs) : !b ? 'none' : bp ? `${bp.kind === 'power-station' ? 'station' : 'kit'}:${bp.id}` : 'custom';
        if (value === 'custom') options.push({ value: 'custom', label: `Custom: ${fmt.num(b.capacityKwh, 2)} kWh (set under Advanced)` });
        if (!options.some(o => o.value === value)) {
            options.push({ value, label: bp ? bp.name : 'Current battery' });
        }
        const parts = [this.fld('Battery', ui.select({ options, value, onChange: v => (builtin ? this.setExpansion(v, packs) : this.setBattery(v)), ariaLabel: 'Battery' }), {
            key: 'battery',
            hint: builtin ? `This unit’s battery sits between the panels and its inverter — it can’t be left out${packs.length ? ', but you can add the maker’s extra battery' : ''}.`
                : d.route === 'plugin' ? 'Plug-in batteries aren’t legal yet — choosing one shows the fixes (electrician, or plan for future rules). A power station on its own socket is the exception.'
                    : 'Batteries are wired in by an electrician today; a power station just plugs into a socket.',
        })];
        if (b?.coupling === 'ups') {
            const ded = b.ups?.dedicatedW;
            parts.push(this.fld('Server power on the power station', ui.numberInput({
                value: finite(ded) ? ded : null, min: 0, max: 5000, step: 10, unit: 'W', allowEmpty: true, placeholder: finite(base) ? `${Math.round(base)} (your always-on load)` : 'your always-on load',
                onChange: v => this.change(x => { x.battery.ups.dedicatedW = v == null ? 'baseload' : v; return x; }),
            }), { key: 'dedicatedW', hint: `Your always-on load is ${finite(base) ? fmt.w(base) : 'not known yet'} — use less if some of it isn’t the servers.` }));
            if (bp?.pvWireablePanels > 0) {
                const count = countOf(b.ups?.pvArrays);
                const opts = Array.from({ length: bp.pvWireablePanels + 1 }, (_, i) => ({ value: String(i), label: i === 0 ? 'None' : `${i} × ${cat.parts?.panel?.includedPanels?.wp ?? 460} W` }));
                parts.push(this.fld('Panels on its own solar inputs', ui.select({ options: opts, value: String(count), onChange: v => this.setStationPanels(+v) }), { key: 'stationPanels2', hint: 'Not grid-tied, so they don’t count towards the plug-in limits.' }));
            }
        }
        parts.push(this.laterBlock());
        const aside = b ? `${fmt.num(b.capacityKwh, 2)} kWh` : d.upgrade ? `later, yr ${d.upgrade.atYear}` : 'none';
        return { title: 'Battery', body: h('div', { class: 'stack-sm' }, parts), aside };
    },

    /** Priced expansion packs of the draft's all-in-one unit (catalog `expansion`), with a short name. */
    expansionPacks() {
        const main = this.mainProduct();
        return (main?.expansion || []).filter(x => finite(x.priceGbp) && x.kwh > 0)
            .map(x => ({ ...x, short: String(x.model).split('(')[0].trim() || 'extra battery' }));
    },
    /** Which expansion choice the draft is at: 'builtin', 'exp:<i>', or 'custom' after an Advanced edit. */
    expansionValue(packs) {
        const d = this.st.draft;
        const base = this.mainProduct()?.battery?.capacityKwh ?? d.battery.capacityKwh;
        const near = (a, b) => Math.abs(a - b) < 1e-6;
        const line = d.costs.find(c => c.label.startsWith('Extra battery: '));
        if (!line && near(d.battery.capacityKwh, base)) return 'builtin';
        const i = packs.findIndex(x => line?.label === `Extra battery: ${x.short}` && near(d.battery.capacityKwh, base + x.kwh));
        return i >= 0 ? `exp:${i}` : 'custom';
    },
    setExpansion(value, packs) {
        const base = this.mainProduct()?.battery?.capacityKwh;
        this.change(d => {
            d.costs = d.costs.filter(c => !c.label.startsWith('Extra battery: '));
            if (!finite(base)) return d;
            const i = value.startsWith('exp:') ? +value.slice(4) : -1;
            const x = packs[i];
            d.battery.capacityKwh = base + (x ? x.kwh : 0);
            if (x) d.costs.push({ label: `Extra battery: ${x.short}`, gbp: x.priceGbp, year: 0, kind: 'hardware' });
            return d;
        });
    },

    /** "Add one later" — a staged plan (System.upgrade): which battery, which year, under which route. */
    laterBlock() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const cat = this.st.catalog;
        const addons = cat.kits.filter(k => k.kind === 'battery-addon' && k.battery);
        if (!addons.length) return null;
        const u = d.upgrade;
        if (u && !this.st.later) {
            const cost = u.costs.reduce((s, c) => s + c.gbp, 0);
            const edit = ui.button({ label: 'Change', size: 'sm', onClick: () => { this.st.later = this.laterDraft(); this.pendingFocus = 'laterProduct'; this.renderEditor(); } });
            edit.dataset.k = 'laterEdit';
            return h('div', { class: 'dv-later' },
                h('div', { class: 'dv-later-title' }, 'Bought later'),
                h('p', { class: 'dv-p' }, h('b', null, `End of year ${u.atYear}: ${u.label}`), ` · ${fmt.gbp(cost)} · ${u.route === 'whatif' ? 'as a plug-in battery, if they’re legalised' : u.route === 'hardwired' ? 'wired in by an electrician' : 'same route'}`),
                u.route === 'whatif' ? h('div', { class: 'hint-warn' }, ui.icon('alert'), 'This step needs plug-in batteries to become legal (hoped for early 2027).') : null,
                h('div', { class: 'dv-row' }, edit, ui.button({ label: 'Drop it from the plan', size: 'sm', kind: 'ghost', onClick: () => { this.pendingFocus = 'laterOpen'; this.setLater(null); } })));
        }
        if (!this.st.later) {
            if (d.battery) return null;
            const b = ui.button({ label: 'Add one later…', size: 'sm', kind: 'ghost', icon: 'arrowRight', onClick: () => { this.st.later = this.laterDraft(); this.pendingFocus = 'laterProduct'; this.renderEditor(); } });
            b.dataset.k = 'laterOpen';
            return h('div', null, b);
        }
        const L = this.st.later;
        const opts = addons.map(k => ({ value: k.id, label: `${k.name}${kwhTag(k.name, k.battery.capacityKwh, fmt)} · ${fmt.gbp(k.priceGbp)}` }));
        const how = ui.segmented({
            ariaLabel: 'How it would be connected', size: 'sm', value: L.how,
            options: [{ value: 'whatif', label: 'Plug-in, if legalised' }, { value: 'hardwired', label: 'Electrician' }],
            onChange: v => { L.how = v; },
        });
        return h('div', { class: 'dv-later' },
            h('div', { class: 'dv-later-title' }, 'Add a battery later'),
            this.fld('Which battery', ui.select({ options: opts, value: L.productId, onChange: v => { L.productId = v; } }), { key: 'laterProduct' }),
            h('div', { class: 'dv-fields' },
                this.fld('Bought at the end of year', ui.numberInput({ value: L.year, min: 1, max: 10, step: 1, onChange: v => { L.year = Math.round(v); } }), { key: 'laterYear' }),
                this.fld('Connected', how, { key: 'laterHow', wide: true })),
            h('p', { class: 'dv-p' }, 'Bought at the end of that year at today’s price; from the next year the savings include it. Plug-in batteries are hoped for in early 2027.'),
            h('div', { class: 'dv-row' },
                ui.button({ label: d.upgrade ? 'Update the plan' : 'Add to the plan', size: 'sm', kind: 'primary', onClick: () => { const plan = { ...L }; this.st.later = null; this.pendingFocus = 'laterEdit'; this.setLater(plan); } }),
                ui.button({ label: 'Cancel', size: 'sm', kind: 'ghost', onClick: () => { this.st.later = null; this.pendingFocus = d.upgrade ? 'laterEdit' : 'laterOpen'; this.renderEditor(); } })));
    },

    laterDraft() {
        const cat = this.st.catalog;
        const d = this.st.draft;
        const u = d.upgrade;
        const addons = cat.kits.filter(k => k.kind === 'battery-addon' && k.battery);
        const fromU = u ? addons.find(k => u.label === `Add ${k.name}`) : null;
        const pref = fromU ?? addons.find(k => k.id === 'thunder-vault-hibattery-1920ac') ?? addons[0];
        return { productId: pref?.id, year: u?.atYear ?? 1, how: u?.route === 'hardwired' ? 'hardwired' : d.route === 'plugin' || d.route === 'whatif' ? 'whatif' : 'hardwired' };
    },

    /* step 04 — automation */
    stepAutomation() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const strat = d.battery?.strategy ?? d.upgrade?.battery?.strategy ?? 'threshold';
        const seg = ui.segmented({
            ariaLabel: 'Automation', value: strat,
            options: [{ value: 'threshold', label: 'Realistic', title: STRATEGIES.threshold }, { value: 'optimal', label: 'Best case', title: STRATEGIES.optimal }],
            onChange: v => this.setStrategy(v),
        });
        const res = this.st.result;
        const sameSys = res && sig(res.system) === sig(normalizeSystem(d));
        const bx = sameSys ? res.battery : null;
        const parts = [this.fld(strat === 'threshold' || strat === 'optimal' ? STRATEGIES[strat] : `Using: ${STRATEGIES[strat] || strat}`, seg, { key: 'strategy', hint: STRATEGY_HINT[strat] })];
        if (bx) {
            const noun = d.battery?.coupling === 'ups' ? 'The power station' : 'The battery';
            const says = v => [v < -0.5 ? 'costs ' : 'adds ', h('b', null, `${fmt.gbp(Math.abs(v))}/yr`)];
            parts.push(h('p', { class: 'dv-p' }, `${noun} `, says(bx.thresholdGbp), ' with realistic automation and ', says(bx.optimalGbp), ' with perfect timing.'));
        }
        if (strat !== 'threshold' && strat !== 'optimal') parts.push(h('p', { class: 'dv-p' }, 'Other strategies are under Advanced › Automation details.'));
        return h('div', { class: 'stack-sm' }, parts);
    },

    /* step 05 — costs */
    stepCosts(adv) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const now = d.costs.map((c, i) => ({ c, i })).filter(x => x.c.year === 0);
        const later = d.costs.map((c, i) => ({ c, i })).filter(x => x.c.year > 0);
        const row = ({ c, i }) => h('div', { class: 'dv-cost', dataset: { k: `cost.${i}` } },
            h('div', { class: 'dv-cost-label' }, c.label, c.kind === 'install' ? h('small', null, this.st.catalog.electrician?.note?.replace(/^We assumed /, 'Assumed ') ?? '') : null),
            ui.numberInput({ value: c.gbp, min: 0, max: 100000, step: 10, unit: '£', dp: 2, ariaLabel: `Price: ${c.label}`, onChange: v => this.change(x => { x.costs[i].gbp = v; return x; }) }));
        const total = now.reduce((s, x) => s + x.c.gbp, 0);
        const u = d.upgrade;
        return h('div', { class: 'dv-costs' },
            now.length ? now.map(row) : h('p', { class: 'dv-p' }, 'Nothing to buy.'),
            h('div', { class: 'dv-cost-total' }, h('span', null, 'Today'), h('b', null, fmt.gbp(total, { dp: total % 1 ? 2 : 0 }))),
            later.length ? later.map(({ c }) => h('p', { class: 'dv-p' }, `Year ${c.year}: ${c.label} — ${fmt.gbp(c.gbp)}`)) : null,
            u ? h('p', { class: 'dv-p' }, `End of year ${u.atYear}: ${u.label} — ${fmt.gbp(u.costs.reduce((s, c) => s + c.gbp, 0))}`) : null,
            adv ? h('p', { class: 'dv-p' }, 'Rename, add or remove lines, or move one to a later year, under Advanced › Costs.') : null);
    },

    /* step 06 — export */
    stepExport() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const auto = this.autoExportKind();
        const k = d.export.kind;
        const value = k === auto ? 'auto' : k;
        const options = [{ value: 'auto', label: `From the kit: ${EXPORTS[auto]}` },
            ...Object.entries(EXPORTS).filter(([kk]) => kk !== auto).map(([kk, label]) => ({ value: kk, label }))];
        const sel = ui.select({
            options, value, ariaLabel: 'Export payments',
            onChange: v => this.change(x => { x.export = { kind: v === 'auto' ? auto : v, flatP: x.export.flatP || 15 }; return x; }),
        });
        const parts = [this.fld('Paid for what you send to the grid', sel, { key: 'export', hint: EXPORT_HINT[k] })];
        if (k === 'flat') parts.push(this.numF('Flat export price', ['export', 'flatP'], { unit: 'p/kWh', min: 0, max: 100, step: 0.5, dp: 2 }));
        const res = this.st.result;
        if (res?.headline && sig(res.system) === sig(normalizeSystem(d))) {
            const hl = res.headline;
            parts.push(h('p', { class: 'dv-p' }, `Sends about ${fmt.kwh(hl.exportKwh)} a year to the grid${hl.exportIncomeGbp > 0.05 ? `, earning ${fmt.gbp(hl.exportIncomeGbp, { dp: hl.exportIncomeGbp < 10 ? 2 : 0 })}` : ''} — your always-on load uses the rest.`));
        }
        return h('div', { class: 'stack-sm' }, parts);
    },

    /* ── advanced ───────────────────────────────────────────────────────── */

    advanced() {
        const { ui } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const sec = (id, summary, body) => ui.details({
            summary, body, open: this.st.open.has(id), className: 'dv-sec',
            onToggle: open => { if (open) this.st.open.add(id); else this.st.open.delete(id); },
        });
        const list = [];
        if (d.arrays.length) list.push(sec('arrays', 'Panels and wiring', this.advArrays(['arrays'], d.arrays, d.inverter?.inputs.length ?? 1)));
        if (d.battery?.ups?.pvArrays?.length) list.push(sec('stationArrays', 'Panels on the power station', this.advArrays(['battery', 'ups', 'pvArrays'], d.battery.ups.pvArrays, Math.max(1, d.battery.ups.pvInputs.length))));
        if (d.inverter) list.push(sec('inverter', 'Inverter', this.advInverter()));
        if (d.battery) list.push(sec('battery', d.battery.coupling === 'ups' ? 'Power station details' : 'Battery details', this.advBattery()));
        if (d.battery || d.upgrade?.battery) list.push(sec('auto', 'Automation details', this.advAutomation()));
        list.push(sec('costs', 'Costs', this.advCosts()));
        if (d.upgrade) list.push(sec('later', 'Bought later', this.advLater()));
        list.push(sec('money', 'Money assumptions for this page', this.advMoney()));
        list.push(sec('other', 'Your load', h('div', { class: 'dv-fields' },
            this.numF('Change your always-on load by', ['loadAdjustW'], { unit: 'W', min: -5000, max: 5000, step: 10, wide: true, hint: 'Negative to model switching servers off as well (e.g. −100). Leave at 0 normally.' }))));
        return h('div', { class: 'dv-adv' }, h('div', { class: 'dv-adv-title' }, 'Advanced'), list);
    },

    advArrays(path, arrays, nInputs) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const inputs = Array.from({ length: Math.max(1, nInputs) }, (_, q) => ({ value: q, label: `Solar input ${q + 1}` }));
        const cards = arrays.map((a, i) => {
            const p = [...path, i];
            const remove = ui.button({ label: 'Remove', size: 'sm', kind: 'ghost', ariaLabel: `Remove ${a.name}`, onClick: () => { this.pendingFocus = `${path.join('.')}.add`; this.change(d => { at(d, path).splice(i, 1); return d; }); } });
            return h('div', { class: 'dv-sub' },
                h('div', { class: 'dv-sub-head' }, h('span', { class: 'dv-sub-title' }, `${a.name} · ${a.count} × ${fmt.num(a.wp)} W · ${fmt.compass(a.azimuth)} ${Math.round(a.tilt)}°`), arrays.length > 1 || path[0] !== 'arrays' ? remove : null),
                h('div', { class: 'dv-fields' },
                    this.numF('Panels', [...p, 'count'], { min: 0, max: 200, step: 1 }),
                    this.numF('Watts each', [...p, 'wp'], { unit: 'W', min: 0, max: 2000, step: 5 }),
                    nInputs > 1 ? this.selF('Wired to', [...p, 'input'], inputs) : null,
                    this.numF('Facing', [...p, 'azimuth'], { unit: '°', min: 0, max: 359, step: 5, hint: `${fmt.compass(a.azimuth)} · 180° is due south` }),
                    this.numF('Tilt from flat', [...p, 'tilt'], { unit: '°', min: 0, max: 90, step: 1 }),
                    this.selF('Mounting', [...p, 'mounting'], MOUNTINGS),
                    this.numF('Shading', [...p, 'shadingPct'], { unit: '%', min: 0, max: 100, step: 1, hint: 'Lost to shade over a year. 3% is our default; set 0 if you give a horizon.', after: d => { const arr = at(d, p); arr.shadingExplicit = true; return d; } }),
                    this.textF('Horizon', [...p, 'horizon'], {
                        wide: true, placeholder: 'e.g. 5, 5, 10, 25, 30, 10, 5, 5', inputmode: 'text',
                        format: v => (v || []).join(', '),
                        parse: v => { const t = v.trim(); if (!t) return []; const xs = t.split(/[\s,;]+/).map(Number); return xs.every(x => Number.isFinite(x) && x >= 0 && x <= 90) ? xs : undefined; },
                        hint: 'Heights of what blocks the sky, in degrees, evenly round from north clockwise (any number of values).',
                    }),
                    this.numF('Rear-side gain', [...p, 'bifaciality'], { min: 0, max: 1, step: 0.05, dp: 2, hint: '0 = front only (our default). Bifacial panels are ~0.7, but the rear model is inferred.' }),
                    this.selF('Panel model', [...p, 'dcModel'], [{ value: 'pvwatts', label: 'Standard' }, { value: 'huld2025', label: 'Huld 2025' }], { hint: 'Huld 2025 models dim light better.' }),
                    this.numF('Heat loss', [...p, 'tempCoeffPct'], { unit: '%/°C', min: -1, max: 0, step: 0.01, dp: 2 }),
                    this.numF('Ground reflection', [...p, 'albedo'], { min: 0, max: 1, step: 0.05, dp: 2, hint: '0.2 grass, 0.6 snow.' })));
        });
        const add = ui.button({
            label: 'Add another set of panels', size: 'sm', icon: 'arrowRight',
            onClick: () => this.change(d => {
                const list = at(d, path);
                const last = list[list.length - 1] ?? {};
                const used = new Set(list.map(x => x.input));
                let input = 0;
                while (used.has(input) && input < nInputs - 1) input++;
                list.push({ ...clone(last), id: `${path[0] === 'arrays' ? 'a' : 's'}${Date.now().toString(36).slice(-4)}`, name: `Panels ${list.length + 1}`, count: 1, input });
                return d;
            }),
        });
        add.dataset.k = `${path.join('.')}.add`;
        return h('div', { class: 'stack-sm' }, cards, h('div', null, add));
    },

    advInverter() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const inputs = d.inverter.inputs.map((x, q) => h('div', { class: 'dv-sub' },
            h('div', { class: 'dv-sub-head' }, h('span', { class: 'dv-sub-title' }, `Solar input ${q + 1}`),
                d.inverter.inputs.length > 1 ? ui.button({ label: 'Remove', size: 'sm', kind: 'ghost', ariaLabel: `Remove solar input ${q + 1}`, onClick: () => (this.pendingFocus = 'inverter.add') && this.change(s => { s.inverter.inputs.splice(q, 1); for (const a of s.arrays) a.input = Math.min(a.input, s.inverter.inputs.length - 1); return s; }) }) : null),
            h('div', { class: 'dv-fields' },
                this.numF('Panels up to', ['inverter', 'inputs', q, 'maxDcW'], { unit: 'W', min: 0, max: 100000, step: 10 }),
                this.numF('Output up to', ['inverter', 'inputs', q, 'maxAcW'], { unit: 'W', min: 0, max: 100000, step: 10 }))));
        return h('div', { class: 'stack-sm' },
            h('div', { class: 'dv-fields' },
                this.numF('Most it sends to the house', ['inverter', 'acLimitW'], { unit: 'W', min: 0, max: 20000, step: 50, hint: `Anything above is lost to the ${fmt.num(d.inverter.acLimitW)} W limit.` }),
                this.numF('Efficiency', ['inverter', 'etaNom'], { unit: '%', scale: 100, min: 50, max: 100, step: 0.1, dp: 1 }),
                this.numF('Standby draw', ['inverter', 'standbyW'], { unit: 'W', min: 0, max: 100, step: 0.5, dp: 1 }),
                this.togF('Its output can be limited remotely', ['inverter', 'supportsPowerLimit']),
                this.togF('Switch it off when export prices go negative', ['canCurtail'], { hint: 'Only works if its output can be limited remotely.' })),
            inputs,
            h('div', { dataset: { k: 'inverter.add' } }, ui.button({ label: 'Add a solar input', size: 'sm', icon: 'arrowRight', onClick: () => this.change(s => { const last = s.inverter.inputs[s.inverter.inputs.length - 1] ?? { maxDcW: 1000, maxAcW: 400 }; s.inverter.inputs.push({ ...last }); return s; }) })));
    },

    advBattery() {
        const { ui } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const b = d.battery;
        const P = k => ['battery', k];
        const U = k => ['battery', 'ups', k];
        const common = [
            this.numF('Capacity', P('capacityKwh'), { unit: 'kWh', min: 0, max: 200, step: 0.1, dp: 3 }),
            this.numF('Lowest charge level', P('minSocPct'), { unit: '%', min: 0, max: 95, step: 1, hint: 'Kept in reserve, never used.' }),
        ];
        if (b.coupling === 'ups') {
            return h('div', { class: 'dv-fields' }, ...common,
                this.numF('Server power on it', U('dedicatedW'), { unit: 'W', min: 0, max: 5000, step: 10, allowEmpty: true, empty: 'baseload', placeholder: 'always-on load' }),
                this.numF('Outlets carry up to', U('outletMaxW'), { unit: 'W', min: 0, max: 10000, step: 50 }),
                this.numF('Charges at up to', U('chargeW'), { unit: 'W', min: 0, max: 10000, step: 50 }),
                this.numF('Mains input limit', U('inputLimitW'), { unit: 'W', min: 0, max: 10000, step: 10, hint: 'A 13 A plug carries about 2,990 W, shared by the servers and the charger.' }),
                this.numF('Inverter efficiency', U('etaInv'), { unit: '%', scale: 100, min: 50, max: 100, step: 0.5, dp: 1 }),
                this.numF('Charger efficiency', U('chargeEff'), { unit: '%', scale: 100, min: 50, max: 100, step: 0.5, dp: 1 }),
                this.numF('Losses while running the servers', U('fixedLossW'), { unit: 'W', min: 0, max: 200, step: 1, allowEmpty: true, empty: null, placeholder: 'not measured', hint: 'Empty = not measured: we assume 20 W (small units) or 30 W.' }),
                this.numF('Overhead while passing mains through', U('bypassW'), { unit: 'W', min: 0, max: 100, step: 1 }),
                this.selF('Bypass', U('bypass'), [{ value: 'auto', label: 'On — servers on mains until it’s worth using the battery' }, { value: 'disabled', label: 'Off — servers always on its inverter' }], { wide: true, hint: 'Turning bypass off costs a lot in conversion losses; it is here to price that.' }),
                this.numF('Rated cycles', P('cycles'), { min: 100, max: 100000, step: 100 }),
                this.numF('Lasts up to', P('lifeYears'), { unit: 'yrs', min: 1, max: 40, step: 1 }));
        }
        const eff = b.coupling === 'dc'
            ? [this.numF('Charge efficiency', P('effCharge'), { unit: '%', scale: 100, min: 50, max: 100, step: 0.5, dp: 1 }), this.numF('Discharge efficiency', P('effDischarge'), { unit: '%', scale: 100, min: 50, max: 100, step: 0.5, dp: 1 })]
            : [this.numF('Charge efficiency (AC)', P('acEffCharge'), { unit: '%', scale: 100, min: 50, max: 100, step: 0.5, dp: 1 }), this.numF('Discharge efficiency (AC)', P('acEffDischarge'), { unit: '%', scale: 100, min: 50, max: 100, step: 0.5, dp: 1 })];
        return h('div', { class: 'dv-fields' }, ...common,
            this.numF('Charges at up to', P('maxChargeW'), { unit: 'W', min: 0, max: 20000, step: 50 }),
            this.numF('Gives up to', P('maxDischargeW'), { unit: 'W', min: 0, max: 20000, step: 50 }),
            this.numF('Charges from the grid at', P('acChargeW'), { unit: 'W', min: 0, max: 20000, step: 50, hint: '0 = only from your solar.' }),
            this.numF('Standby draw', P('standbyW'), { unit: 'W', min: 0, max: 200, step: 1 }),
            ...eff,
            this.numF('Rated cycles', P('cycles'), { min: 100, max: 100000, step: 100 }),
            this.numF('Lasts up to', P('lifeYears'), { unit: 'yrs', min: 1, max: 40, step: 1 }),
            this.togF('May send stored energy to the grid', P('allowGridExport'), { hint: 'Off by default: plug-in and most home batteries don’t export.' }));
    },

    advAutomation() {
        const { ui } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const b = d.battery ?? d.upgrade?.battery;
        const root = d.battery ? ['battery'] : ['upgrade', 'battery'];
        const P = k => [...root, k];
        const ups = b.coupling === 'ups';
        const ids = ups ? ['threshold', 'schedule', 'optimal', 'self'] : ['threshold', 'smart', 'optimal', 'schedule', 'self', 'fixed'];
        const parts = [this.selF('Strategy', P('strategy'), ids.map(id => ({ value: id, label: STRATEGIES[id] })), { wide: true, hint: STRATEGY_HINT[b.strategy], after: x => { if (x.battery && x.upgrade?.battery) x.upgrade.battery.strategy = x.battery.strategy; return x; } })];
        const clock = (label, path) => this.textF(label, path, {
            inputmode: 'numeric', maxLength: 5, placeholder: 'HH:MM',
            parse: v => (/^([01]?\d|2[0-4]):[0-5]\d$/.test(v.trim()) ? v.trim().padStart(5, '0') : undefined),
        });
        if (b.strategy === 'schedule') {
            parts.push(
                this.numF('Only charge from the grid below', [...root, 'schedule', 'chargeBelowP'], { unit: 'p/kWh', min: -100, max: 200, step: 0.5, dp: 2, allowEmpty: true, empty: null, placeholder: 'any price', wide: true }),
                clock('Charge from', [...root, 'schedule', 'chargeWindow', 0]), clock('Charge until', [...root, 'schedule', 'chargeWindow', 1]),
                clock('Run the house from', [...root, 'schedule', 'dischargeWindow', 0]), clock('Until', [...root, 'schedule', 'dischargeWindow', 1]));
        }
        if (b.strategy === 'fixed') parts.push(this.numF('Steady output', P('fixedOutputW'), { unit: 'W', min: 0, max: 10000, step: 10, allowEmpty: true, empty: null, placeholder: 'always-on load' }));
        if (b.strategy === 'smart') parts.push(clock('Re-plan each day at', P('replanAt')));
        if (b.strategy === 'threshold') parts.push(this.togF('Assume a perfect solar forecast', P('pvForecast'), { get: x => at(x, P('pvForecast')) === 'perfect', set: (x, v) => put(x, P('pvForecast'), v ? 'perfect' : 'persistence'), hint: 'Off: it guesses tomorrow’s solar from today’s (what a simple rule can do).' }));
        parts.push(this.numF('Wear cost', P('wearPPerKwh'), { unit: 'p/kWh', min: 0, max: 50, step: 0.5, dp: 1, hint: 'Stops it cycling for tiny gains. Not counted in the £ shown.' }));
        if (b.strategy === 'optimal' || b.strategy === 'smart') parts.push(this.numF('Charge-level step', P('deltaKwh'), { unit: 'kWh', min: 0.005, max: 1, step: 0.005, dp: 3, hint: 'Finer is slower. 0.025 kWh is the default.' }));
        return h('div', { class: 'dv-fields' }, parts);
    },

    advCosts() {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        const kinds = [{ value: 'hardware', label: 'Hardware' }, { value: 'install', label: 'Installation' }, { value: 'other', label: 'Other' }];
        const rows = d.costs.map((c, i) => h('div', { class: 'dv-sub' },
            h('div', { class: 'dv-line' }, this.textF('What', ['costs', i, 'label'], { maxLength: 120 }), this.numF('Price', ['costs', i, 'gbp'], { unit: '£', min: -100000, max: 100000, step: 10, dp: 2 })),
            h('div', { class: 'dv-line-meta' },
                this.numF('In year', ['costs', i, 'year'], { min: 0, max: 40, step: 1 }),
                this.selF('Kind', ['costs', i, 'kind'], kinds),
                ui.button({ label: 'Remove', size: 'sm', kind: 'ghost', ariaLabel: `Remove cost: ${c.label}`, onClick: () => { this.pendingFocus = 'costs.add'; this.change(x => { x.costs.splice(i, 1); return x; }); } }))));
        const total = d.costs.filter(c => c.year === 0).reduce((s, c) => s + c.gbp, 0);
        const add = ui.button({ label: 'Add a cost', size: 'sm', icon: 'arrowRight', onClick: () => this.change(x => { x.costs.push({ label: 'Extra cost', gbp: 50, year: 0, kind: 'other' }); return x; }) });
        add.dataset.k = 'costs.add';
        return h('div', { class: 'stack-sm' }, rows, h('div', { class: 'dv-cost-total' }, h('span', null, 'Today'), h('b', null, fmt.gbp(total, { dp: total % 1 ? 2 : 0 }))), h('div', null, add));
    },

    advLater() {
        const { ui } = this.ctx;
        const h = ui.h;
        const d = this.st.draft;
        return h('div', { class: 'stack-sm' },
            h('div', { class: 'dv-fields' },
                this.numF('Bought at the end of year', ['upgrade', 'atYear'], { min: 1, max: 30, step: 1 }),
                this.selF('Then counts as', ['upgrade', 'route'], [{ value: 'whatif', label: 'Future rules' }, { value: 'hardwired', label: 'Electrician' }]),
                this.textF('Called', ['upgrade', 'label'], { wide: true, maxLength: 80 })),
            h('div', { class: 'dv-costs' }, d.upgrade.costs.map((c, i) => h('div', { class: 'dv-cost', dataset: { k: `upgrade.costs.${i}` } },
                h('div', { class: 'dv-cost-label' }, c.label),
                ui.numberInput({ value: c.gbp, min: 0, max: 100000, step: 10, unit: '£', dp: 2, ariaLabel: `Price: ${c.label}`, onChange: v => this.change(x => { x.upgrade.costs[i].gbp = v; return x; }) })))),
            h('div', null, ui.button({ label: 'Drop it from the plan', size: 'sm', kind: 'ghost', onClick: () => { this.pendingFocus = 'laterOpen'; this.setLater(null); } })));
    },

    advMoney() {
        const { ui, store, fmt } = this.ctx;
        const h = ui.h;
        const f = this.financeView();
        const over = this.st.fin;
        const setF = (k, v) => {
            this.st.fin = { ...this.st.fin, [k]: v };
            this.renderHead();
            this.renderEditor();
            this.scheduleRun(0, { user: true });
        };
        const { y, m0 } = installParts(firstOfNextMonth());
        const months = Array.from({ length: 13 }, (_, k) => {
            const idx = m0 + k;
            const yr = y + Math.floor(idx / 12);
            const mm = idx % 12;
            return { value: `${yr}-${String(mm + 1).padStart(2, '0')}-01`, label: `${MONTHS[mm]} ${yr}` };
        });
        if (!months.some(o => o.value === f.installDate)) months.unshift({ value: f.installDate, label: fmt.month(f.installDate) });
        const num = (label, k, o) => {
            const inp = ui.numberInput({ value: finite(f[k]) ? f[k] * (o.scale ?? 1) : null, min: o.min, max: o.max, step: o.step, unit: o.unit, dp: o.dp, onChange: v => setF(k, v / (o.scale ?? 1)) });
            return this.fld(label, inp, { key: `fin.${k}`, hint: o.hint });
        };
        const tog = (label, k, hint) => {
            const t = ui.toggle({ label, hint, checked: !!f[k], onChange: v => setF(k, v) });
            return h('div', { class: 'dv-wide', dataset: { k: `fin.${k}` } }, t);
        };
        const changed = Object.keys(over).length > 0;
        return h('div', { class: 'stack-sm' },
            h('p', { class: 'dv-p' }, 'These only change the figures on this page. The defaults for every option live in ', h('a', { href: '#method' }, 'Method › Assumptions'), '.'),
            h('div', { class: 'dv-fields' },
                this.fld('Bought in', ui.select({ options: months, value: f.installDate, onChange: v => setF('installDate', v) }), { key: 'fin.installDate' }),
                num('Years counted', 'years', { min: 1, max: 30, step: 1, unit: 'yrs' }),
                num('Discount rate', 'discountRate', { scale: 100, min: 0, max: 20, step: 0.5, dp: 1, unit: '%', hint: 'What money is worth to you each year.' }),
                num('Electricity prices rise', 'escalation', { scale: 100, min: -10, max: 15, step: 0.5, dp: 1, unit: '%/yr' }),
                num('Panels age', 'pvAnnualDeg', { scale: 100, min: 0, max: 3, step: 0.1, dp: 1, unit: '%/yr' }),
                num('New micro-inverter after', 'microReplaceYear', { min: 1, max: 40, step: 1, unit: 'yrs' }),
                tog('VAT on electricity goes back to 5% in April 2027', 'vatReturns'),
                tog('Buy a new battery when it wears out', 'replaceBattery')),
            changed ? h('div', { class: 'dv-row' },
                ui.button({
                    label: 'Use these for every option', size: 'sm', onClick: () => {
                        const { vatReturns, ...rest } = this.st.fin;
                        this.st.fin = {};
                        store.update('settings', s => ({ ...s, finance: { ...(s.finance || {}), ...rest }, ...(vatReturns === undefined ? {} : { vatReturns }) }));
                        this.ctx.ui.toast('Saved as your defaults — every option now uses them.', { tone: 'good' });
                    },
                }),
                ui.button({ label: 'Back to your defaults', size: 'sm', kind: 'ghost', onClick: () => { this.st.fin = {}; this.renderHead(); this.renderEditor(); this.scheduleRun(0, { user: true }); } })) : null);
    },

    /* ── results ────────────────────────────────────────────────────────── */

    chart(key, create, host, spec) {
        const v = this.v;
        const pref = `design.table.${key}`;
        const full = { ...spec, table: !!this.ctx.store.get().ui?.chartTables?.[pref], onTable: on => { if (!!this.ctx.store.get().ui?.chartTables?.[pref] !== on) this.ctx.store.set({ ui: { chartTables: { [pref]: on } } }); } };
        const c = v.charts[key];
        if (c) c.update(full);
        else v.charts[key] = create(host, full);
        host.querySelector('.chart-toggle')?.setAttribute('aria-label', `Table: ${spec.title || spec.ariaLabel}`);
    },
    dropChart(key) {
        const c = this.v?.charts[key];
        if (c) { c.destroy(); delete this.v.charts[key]; }
    },

    renderResultsWaiting() {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        p.readout.replaceChildren(h('div', { class: 'dv-readout-top' }, h('div', { class: 'dv-eyebrow', id: 'dv-money' }, 'Money'), p.status),
            h('div', { class: 'stack-sm', style: { marginTop: '14px' } }, ui.skeleton({ height: 64 }), ui.skeleton({ lines: 2 })),
            h('div', { class: 'tiles' }, ['Pays back in', 'Ahead after 10 years', 'Costs today'].map(label => ui.statTile({ label, loading: true }))));
        for (const k of ['dayFlows', 'dayPrices', 'monthly', 'cash', 'battery']) this.dropChart(k);
        p.dayFlows.replaceChildren(ui.skeleton({ height: 260 }));
        p.monthly.replaceChildren(ui.skeleton({ height: 220 }));
        p.cash.replaceChildren(ui.skeleton({ height: 240 }));
    },

    renderRunError() {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = this.v?.parts;
        if (!p) return;
        const err = this.st.runError;
        // the figures left on screen belong to the last build that worked, not to what's in the editor
        this.v.root.classList.toggle('is-error', !!err && !!this.st.result);
        if (!err) { p.runError.hidden = true; p.runError.replaceChildren(); return; }
        p.runError.hidden = false;
        p.runError.replaceChildren(h('div', { class: 'notice notice-bad', role: 'alert' }, ui.icon('alert'),
            h('div', { class: 'dv-err' },
                h('span', null, `Couldn’t work this option out: ${err?.message || err}`),
                h('span', { class: 'muted' }, this.st.result ? 'The figures below are from the last build that worked.' : 'Try changing the build, or start from a ready-made option.'),
                ui.button({ label: 'Try again', size: 'sm', icon: 'refresh', onClick: () => this.scheduleRun(0, { user: false }) }))));
        if (!this.st.result) this.renderResultsWaiting();
        else if (!this.st.banded) this.renderReadout(this.st.result);   // drop the band's spinner
    },

    renderResults() {
        const res = this.st.result;
        if (!this.v || !res) return;
        this.renderRunError();
        this.renderPrintHead(res);
        this.renderReadout(res);
        this.renderEnergy(res);
        this.renderDetails(res);
        this.renderMonthly(res);
        this.renderCash(res);
        this.renderBatteryCard(res);
        this.renderNotes(res);
        if (!this.v.parts.bar.contains(document.activeElement)) this.renderBarSafe();
        // the automation and export steps quote the run's figures
        const k = this.v.parts.steps;
        if (k.querySelector('[data-step="automation"], [data-step="export"]') && !k.contains(document.activeElement)) this.renderEditor();
    },

    buildLine(sys) {
        const { fmt } = this.ctx;
        const out = [];
        const group = arrays => {
            const m = new Map();
            for (const a of arrays) {
                if (!(a.count > 0)) continue;
                const k = `${Math.round(a.azimuth)}|${Math.round(a.tilt)}|${a.wp}`;
                const g = m.get(k) || { ...a, count: 0 };
                g.count += a.count;
                m.set(k, g);
            }
            return [...m.values()].map(g => `${g.count} × ${fmt.num(g.wp)} W facing ${fmt.compass(g.azimuth)} at ${Math.round(g.tilt)}°`).join(' + ');
        };
        if (sys.arrays.length) out.push(group(sys.arrays));
        if (sys.inverter && sys.arrays.length) out.push(`${fmt.num(sys.inverter.acLimitW)} W out`);
        const b = sys.battery;
        if (b?.coupling === 'ups') {
            const own = b.ups?.pvArrays?.length ? ` + ${group(b.ups.pvArrays)} on its own inputs` : '';
            out.push(`${fmt.num(b.capacityKwh, 2)} kWh power station running ${finite(b.ups?.dedicatedW) ? fmt.w(b.ups.dedicatedW) : 'your always-on load'}${own}`);
        } else if (b) out.push(`${fmt.num(b.capacityKwh, 2)} kWh battery`);
        else if (sys.route !== 'reference') out.push('no battery');
        if (b) out.push(STRATEGIES[b.strategy]?.split(' (')[0] ?? b.strategy);
        if (sys.arrays.length) out.push(sys.export.kind === 'flat' ? `export paid at ${fmt.p(sys.export.flatP)}` : sys.export.kind === 'none' ? 'no export payments' : EXPORTS[sys.export.kind]);
        if (sys.upgrade) out.push(`then ${sys.upgrade.label.replace(/^Add /, 'add ')} at the end of year ${sys.upgrade.atYear}`);
        if (sys.loadAdjustW) out.push(sys.loadAdjustW < 0 ? `always-on load cut by ${fmt.w(-sys.loadAdjustW)}` : `always-on load up by ${fmt.w(sys.loadAdjustW)}`);
        return out.filter(Boolean);
    },

    /** Print only: the option's name, route and cost lines (the editor and toolbar don't print). */
    renderPrintHead(res) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const sys = res.system;
        const now = sys.costs.filter(c => c.year === 0);
        const total = now.reduce((a, c) => a + c.gbp, 0);
        const money = v => fmt.gbp(v, { dp: Math.abs(v % 1) > 0.004 ? 2 : 0 });
        this.v.parts.print.replaceChildren(
            h('h2', null, this.st.draft?.name || sys.name),
            h('div', null, (ROUTES[sys.route] || ROUTES.plugin).label, ' · ', this.buildLine(sys).join(' · ')),
            h('table', null, h('tbody', null,
                now.map(c => h('tr', null, h('td', null, c.label), h('td', null, money(c.gbp)))),
                h('tr', { class: 'total' }, h('td', null, 'Today'), h('td', null, money(total))),
                sys.upgrade ? h('tr', null, h('td', null, `End of year ${sys.upgrade.atYear}: ${sys.upgrade.label}`), h('td', null, money(sys.upgrade.costs.reduce((a, c) => a + c.gbp, 0)))) : null)));
    },

    renderReadout(res) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const hl = res.headline || {};
        const fin = res.finance || {};
        const sys = res.system;
        const legal = res.rules?.errors?.length ? { tone: 'bad', label: 'Not allowed as built' } : LEGAL[res.rules?.legal] || null;
        const sav = hl.savingsGbp;
        const free = !(hl.capexGbp > 0);
        const fy = this.financeView();
        let band;
        if (this.st.banded && res.band && res.band.savingsGbp?.length && Math.max(...res.band.savingsGbp) - Math.min(...res.band.savingsGbp) > 0.005) {
            band = dvBandStrip(h, fmt, { values: res.band.savingsGbp, years: res.band.years, p10: res.band.p10, p90: res.band.p90, typical: sav, actual: hl.actualGbp, weather: this.ctx.data.summary()?.weatherBasis });
        } else if (this.st.banded || !res.weather || !(hl.pvKwh > 0)) {
            band = h('p', { class: 'dv-band-note' }, hl.pvKwh > 0 ? 'Weather makes little difference to this option.' : 'No solar, so the weather doesn’t change this figure.');
        } else if (this.st.runError) {
            band = null;   // the band was still on its way when a later run failed: nothing is coming
        } else {
            band = h('div', { class: 'dv-band-wait' }, h('span', { class: 'dv-status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Adding the 2006–2025 weather years…'));
        }
        const paySub = free ? null : this.st.banded && finite(hl.paybackP10Years) && finite(hl.paybackP90Years) && Math.abs(hl.paybackP10Years - hl.paybackP90Years) > 0.05
            ? `${fmt.num(Math.min(hl.paybackP90Years, hl.paybackP10Years), 1)}–${fmt.num(Math.max(hl.paybackP90Years, hl.paybackP10Years), 1)} yrs as the weather varies`
            : finite(fin.discountedPaybackYears) ? `${fmt.years(fin.discountedPaybackYears)} counting the value of money` : hl.paybackYears == null && !free ? `not within ${fy.years} years` : null;
        const fig = h('div', { class: ['dv-fig', sav < 0 && 'is-neg'], tabindex: '-1' }, fmt.gbp(sav), h('small', null, 'a year'));
        p.readout.replaceChildren(...[
            h('div', { class: 'dv-readout-top' },
                h('div', null, h('div', { class: 'dv-eyebrow', id: 'dv-money' }, sav < 0 ? 'Costs you, first year' : 'Saves you, first year'), p.status),
                h('div', { class: 'dv-badges' }, ui.badge({ text: (ROUTES[sys.route] || ROUTES.plugin).label, tone: sys.route }),
                    // the route badge already says "not legal yet" for a future-rules build
                    legal && res.rules?.legal !== 'reference' && !(sys.route === 'whatif' && legal === LEGAL.whatif) ? ui.badge({ text: legal.label, tone: legal.tone }) : null,
                    sys.upgrade?.route === 'whatif' && sys.route !== 'whatif' ? ui.badge({ text: 'Later step: future rules', tone: 'whatif' }) : null,
                    // a hindsight strategy makes this figure a ceiling, not a forecast
                    sys.battery && (sys.battery.strategy === 'optimal' || sys.battery.strategy === 'smart')
                        ? ui.badge({ text: sys.battery.strategy === 'optimal' ? 'Best case: perfect timing' : 'Assumes a perfect solar forecast', tone: 'warn' }) : null)),
            fig,
            res.rules?.errors?.length ? h('div', { class: 'dv-fig-warn' }, ui.icon('alert'), 'You couldn’t buy this as built — see the fixes in the build panel. Figures are for planning.') : null,
            h('div', { class: 'dv-fig-sub' }, hl.pvKwh > 0.5
                ? `Typical weather, ${yearSpan(fy.installDate)}. With the last 12 months’ sunshine: ${fmt.gbp(hl.actualGbp)}; as billed over those months: ${fmt.gbp(hl.billedGbp)}.`
                : `Your first year, ${yearSpan(fy.installDate)}. As billed over the last 12 months: ${fmt.gbp(hl.billedGbp)}.`),
            band,
            h('div', { class: 'tiles' },
                ui.statTile({ label: 'Pays back in', value: free ? 'No cost' : fmt.years(hl.paybackYears), tone: free ? 'default' : hl.paybackYears == null ? 'bad' : hl.paybackYears <= 7 ? 'good' : hl.paybackYears <= 12 ? 'warn' : 'bad', sub: paySub, help: 'Years until the money saved covers what you paid, with prices rising and panels ageing as set in the assumptions.' }),
                ui.statTile({ label: 'Ahead after 10 years', value: fmt.gbp(hl.net10Gbp), tone: hl.net10Gbp > 0 ? 'good' : 'bad', sub: `${fmt.gbp(hl.npv10Gbp)} in today’s money`, help: 'Everything saved in the first 10 years minus everything spent, including any replacements.' }),
                ui.statTile({ label: 'Costs today', value: fmt.gbp(hl.capexGbp), sub: sys.upgrade ? `+ ${fmt.gbp(sys.upgrade.costs.reduce((s, c) => s + c.gbp, 0))} at the end of year ${sys.upgrade.atYear}` : (sys.costs.some(c => c.kind === 'install') ? 'includes the electrician' : null) })),
            h('div', { class: 'dv-build', 'aria-label': 'The build' }, this.buildLine(sys).map(t => h('span', null, t))),
        ].filter(Boolean));
    },

    /**
     * Pence saved per kWh of solar made. With a battery the saving also holds what it earns by
     * charging in cheap half-hours (and loses on standby), which isn't the solar's doing: count
     * the panels alone plus the battery's storing-solar share instead.
     */
    solarPPerKwh(res) {
        const hl = res.headline || {};
        if (!(hl.pvKwh > 0)) return null;
        const b = res.battery;
        const gbp = b && finite(b.baseGbp) ? b.baseGbp + Math.max(0, b.split?.fromSolarGbp ?? 0) : hl.savingsGbp;
        return (100 * gbp) / hl.pvKwh;
    },

    renderEnergy(res) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const hl = res.headline || {};
        const T = res.typical?.annual || {};
        if (!(hl.pvKwh > 0.5)) { p.energy.replaceChildren(); return; }
        const lost = (T.clippedKwh || 0) + (T.curtailedKwh || 0) + (T.upsPvWastedKwh || 0);
        const lim = res.system.inverter?.acLimitW;
        const lostWhy = [T.clippedKwh > 0.5 ? (finite(lim) && res.system.route === 'plugin' ? `to the ${fmt.num(lim)} W limit` : 'to the inverter’s limits') : null,
            T.curtailedKwh > 0.5 ? 'switched off at negative prices' : null, T.upsPvWastedKwh > 0.5 ? 'with the station already full' : null].filter(Boolean).join(', ');
        const perKwh = this.solarPPerKwh(res);
        p.energy.replaceChildren(
            h('div', { class: 'dv-group' }, 'Energy'),
            h('div', { class: 'tiles', style: { marginTop: '14px' } },
                ui.statTile({ label: 'Solar made', value: fmt.num(hl.pvKwh), unit: 'kWh a year', sub: T.pvAcKwh > 0.5 ? `${fmt.p(perKwh)} saved per kWh · ${fmt.pct(hl.peakGenSharePct)} of it 4–7pm` : `${fmt.p(perKwh)} saved per kWh · all into the power station` }),
                ui.statTile({ label: 'Used at home', value: fmt.pct(hl.selfUsePct, { dp: hl.selfUsePct > 99 && hl.selfUsePct < 100 ? 1 : undefined }), tone: hl.selfUsePct >= 90 ? 'good' : 'default', sub: hl.exportKwh > 0.5 ? `${fmt.kwh(hl.exportKwh)} sent to the grid${hl.exportUnpaidKwh > 0.5 ? ` (${fmt.kwh(hl.exportUnpaidKwh)} unpaid)` : ''}` : 'Nothing sent to the grid' }),
                ui.statTile({ label: 'Lost', value: fmt.num(lost), unit: 'kWh a year', tone: lost > 0.05 * hl.pvKwh ? 'warn' : 'default', sub: lost > 0.5 ? lostWhy : 'Nothing clipped or switched off' })));
    },

    renderDetails(res) {
        const { ui, fmt } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const hl = res.headline || {};
        const fin = res.finance || {};
        const T = res.typical?.annual || {};
        const sys = res.system;
        const fy = this.financeView();
        const rows = [];
        const row = (label, value, sub) => rows.push(h('div', null, h('dt', null, label, sub ? h('small', null, sub) : null), h('dd', null, value)));
        const kw = v => (!(Math.abs(v || 0) >= 0.05) ? 'None' : fmt.kwh(Math.max(0, v)));
        row('Value over its life', fmt.gbp(hl.npvGbp), `${fy.years} years at ${fmt.pct(fy.discountRate * 100)} a year (NPV)`);
        row('Value over 10 years', fmt.gbp(hl.npv10Gbp), 'in today’s money');
        if (fin.irr != null) row('Return on the money', fmt.pct(fin.irr * 100, { dp: 1 }), 'a year (IRR)');
        if (fin.lcoePPerKwh != null) row('Cost of each solar kWh', fmt.p(fin.lcoePPerKwh), 'over its life (LCOE)');
        if (fin.lcosPPerKwh != null) row('Cost of each stored kWh', fmt.p(fin.lcosPPerKwh), 'over its life (LCOS)');
        const gridPv = T.pvAcKwh > 0.5;
        if (hl.pvKwh > 0.5) {
            const lim = sys.inverter?.acLimitW;
            if (sys.inverter) row(finite(lim) ? `Lost to the ${fmt.num(lim)} W limit` : 'Lost to inverter limits', kw(T.clippedKwh));
            if (sys.canCurtail || T.curtailedKwh > 0) row('Switched off at negative prices', kw(T.curtailedKwh));
            if (T.upsPvWastedKwh > 0.05) row('Station solar wasted (already full)', fmt.kwh(T.upsPvWastedKwh));
            if (gridPv) {
                row('Sent to the grid, paid', kw((hl.exportKwh || 0) - (hl.exportUnpaidKwh || 0)), hl.exportIncomeGbp > 0.005 ? `earning ${fmt.gbp(hl.exportIncomeGbp, { dp: 2 })}` : null);
                row('Sent to the grid, unpaid', kw(hl.exportUnpaidKwh));
            }
            row('Each kWh made is worth', fmt.p(this.solarPPerKwh(res)), res.battery ? 'the solar’s share of the saving, not the battery’s cheap-slot charging' : null);
            if (gridPv) row('Made between 4 and 7pm', fmt.pct(hl.peakGenSharePct));
        }
        row('Share of your use it covers', fmt.pct(T.selfSufficiencyPct));
        if (sys.battery) {
            const unit = sys.battery.coupling === 'ups' ? 'Power station' : 'Battery';
            row(`${unit} full cycles`, fmt.num(T.battCycles, 0), 'a year');
            if (T.gridChargeKwh > 0.05) row('Charged from the grid', fmt.kwh(T.gridChargeKwh), 'a year');
            if (fin.batteryEndYear != null) row(`${unit} wears out`, `year ${fin.batteryEndYear}`, fin.batteryEndYear < fy.years ? (fy.replaceBattery ? 'bought again then' : 'savings from it stop then') : null);
        }
        row('With the last 12 months’ weather', fmt.gbp(hl.actualGbp), 'first year');
        row('As billed, last 12 months', fmt.gbp(hl.billedGbp), 'your real prices, VAT and all');
        if (this.st.banded && res.band) row('Range over 2006–2025 weather', fmt.range(Math.min(...res.band.savingsGbp), Math.max(...res.band.savingsGbp), v => fmt.gbp(v)));
        const det = ui.details({
            className: 'dv-details', open: !!this.ctx.store.get().ui?.chartTables?.['design.details'],
            summary: h('span', null, 'Details'),
            body: h('dl', { class: 'dv-dl' }, rows),
            onToggle: open => this.ctx.store.set({ ui: { chartTables: { 'design.details': open } } }),
        });
        p.details.replaceChildren(det);
    },

    renderMonthly(res) {
        const { charts, fmt } = this.ctx;
        const p = this.v.parts;
        const fy = this.financeView();
        const opts = { installDate: fy.installDate, vatReturns: fy.vatReturns };
        const typ = scaleTo(firstYearMonths(res.typical?.monthly, opts), res.headline?.savingsGbp);
        const act = scaleTo(firstYearMonths(res.actual?.monthly, opts), res.headline?.actualGbp);
        p.monthlySub.textContent = `First year, ${yearSpan(fy.installDate)}. Solid: typical weather. Outline: the last 12 months’ sunshine.`;
        const same = res.weather?.typicalIsActual || typ.every((r, i) => Math.abs(r.gbp - act[i].gbp) < 0.01);
        this.chart('monthly', charts.createBars, p.monthly, {
            title: 'Saved each month', ariaLabel: 'Money saved each month of the first year, typical weather and the last 12 months’ weather',
            categories: typ.map(r => r.key), height: 220,
            x: { format: k => MONTHS[+k.slice(5, 7) - 1], tipFormat: k => fmt.month(k), label: 'Month' },
            y: { format: v => fmt.gbp(v, { dp: Math.abs(v) < 10 && Math.abs(v % 1) > 1e-9 ? 1 : 0 }) },
            series: [
                { key: 'typ', label: 'Typical weather', color: 'pv', values: typ.map(r => r.gbp), format: v => fmt.gbp(v, { dp: 2 }) },
                ...(same ? [] : [{ key: 'act', label: 'Last 12 months’ weather', color: 'pv', outline: true, values: act.map(r => r.gbp), format: v => fmt.gbp(v, { dp: 2 }) }]),
            ],
        });
    },

    renderCash(res) {
        const { charts, fmt } = this.ctx;
        const p = this.v.parts;
        const fin = res.finance;
        if (!fin?.years?.length) { this.dropChart('cash'); p.cash.replaceChildren(); return; }
        const fy = this.financeView();
        const years = fin.years.map(r => r.y);
        const series = [{ key: 'typ', label: 'Typical weather', color: 'pv', values: fin.years.map(r => r.cumulativeGbp), area: true, format: v => fmt.gbp(v) }];
        const fb = this.st.banded ? res.financeBand : null;
        if (fb?.p10?.years && fb?.p90?.years && Math.abs(fb.p90.year1Gbp - fb.p10.year1Gbp) > 0.5) {
            series.push({ key: 'p10', label: 'A dull year, every year', color: 'muted', dash: true, values: fb.p10.years.map(r => r.cumulativeGbp), format: v => fmt.gbp(v) });
            series.push({ key: 'p90', label: 'A sunny year, every year', color: 'muted', dash: [2, 3], values: fb.p90.years.map(r => r.cumulativeGbp), format: v => fmt.gbp(v) });
        }
        // events in priority order; one that would crowd an earlier marker goes into the subtitle instead
        const events = [];
        if (finite(fin.paybackYears) && fin.paybackYears > 0 && fin.paybackYears <= fy.years) events.push({ x: fin.paybackYears, label: `pays back · ${fmt.years(fin.paybackYears)}` });
        const sys = res.system;
        for (const r of fin.years) {
            if (r.y < 1 || !(r.outlayGbp > 0.5)) continue;
            const what = sys.upgrade && r.y === sys.upgrade.atYear ? 'adds the battery'
                : fin.batteryEndYear != null && r.y === fin.batteryEndYear + 1 ? (sys.battery?.coupling === 'dc' ? 'new inverter' : 'new battery') : 'new micro-inverter';
            events.push({ x: r.y, label: `${what} · ${fmt.gbp(r.outlayGbp)}`, text: `${what} in year ${r.y} (${fmt.gbp(r.outlayGbp)})` });
        }
        const unit = sys.battery?.coupling === 'ups' ? 'power station' : 'battery';
        if (fin.batteryEndYear != null && fin.batteryEndYear < fy.years && !fy.replaceBattery) events.push({ x: fin.batteryEndYear, label: `${unit} ends · yr ${fin.batteryEndYear}`, text: `the ${unit} wears out in year ${fin.batteryEndYear}` });
        const markers = [];
        const folded = [];
        for (const e of events) {
            if (markers.some(m => Math.abs(m.x - e.x) < 2.2)) folded.push(e.text || e.label);
            else markers.push({ x: e.x, label: e.label });
        }
        p.cashSub.textContent = `Cumulative, in pounds of each year: prices rising ${fmt.pct(fy.escalation * 100, { dp: 1 })} a year, panels ageing ${fmt.pct(fy.pvAnnualDeg * 100, { dp: 1 })} a year.${series.length > 1 ? ' Dashed: the dullest and sunniest 1-in-10 weather, every year.' : ''}${folded.length ? ` Also: ${folded.join('; ')}.` : ''}`;
        this.chart('cash', charts.createLine, p.cash, {
            title: 'Money back, year by year', ariaLabel: 'Cumulative money saved minus money spent, by year after buying',
            height: 250,
            x: { values: years, type: 'linear', label: 'Years after you buy it', format: v => `${v}`, tipFormat: v => (v === 0 ? 'The day you buy it' : `End of year ${v}`) },
            y: { format: v => fmt.gbp(v, { compact: true }) },
            series, markers,
        });
    },

    renderBatteryCard(res) {
        const { ui, fmt, charts } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const b = res.battery;
        if (!b) { this.dropChart('battery'); p.battery.replaceChildren(); return; }
        const sys = res.system;
        const ups = sys.battery?.coupling === 'ups';
        const total = b.totalGbp;
        const split = b.split || {};
        const solo = Math.abs(b.baseGbp || 0) < 0.5;
        const ownSolar = (split.fromSolarGbp || 0) > 0.5;
        // a unit that costs more in standby and conversion losses than it saves says so plainly
        const why = total < -0.5
            ? (ups ? 'its standby and conversion losses cost more than it saves by running the servers through the 4–7pm peak'
                : 'its standby power costs more than it saves by moving use to cheap half-hours')
            : ownSolar && split.fromSolarGbp > (split.fromGridGbp || 0)
                ? (ups ? 'the servers run on its own panels’ solar, stored for when they need it' : 'mostly by storing solar for later')
                : ups ? 'the servers run on stored cheap energy through the 4–7pm peak' : 'it charges in cheap half-hours and runs the house through dear ones';
        const lede = solo
            ? [h('b', null, total < -0.5 ? `It costs you ${fmt.gbp(-total)} a year` : `${fmt.gbp(total)} a year`), ` on its own — ${why}.`]
            : [total < -0.5 ? 'Takes ' : 'Adds ', h('b', null, `${fmt.gbp(Math.abs(total))} a year`), ` ${total < -0.5 ? 'off' : 'to'} the panels alone (${fmt.gbp(b.baseGbp)} → ${fmt.gbp(b.systemGbp)}).`];
        const gridShare = total > 0 ? split.fromGridGbp / total : 0;
        const extra = [];
        const close = Math.abs((b.optimalGbp ?? 0) - (b.thresholdGbp ?? 0)) < 1;
        if (close) extra.push(' Perfect timing would add almost nothing more — realistic Agile-aware automation already gets close to the best case.');
        else {
            extra.push(b.strategy === 'threshold' ? ` That’s with Agile-aware automation; with perfect timing it could reach ${fmt.gbp(b.optimalGbp)}.`
                : b.strategy === 'optimal' ? ` That’s with perfect timing; realistic Agile-aware automation gets ${fmt.gbp(b.thresholdGbp)}.`
                    : ` Agile-aware automation would get ${fmt.gbp(b.thresholdGbp)}; perfect timing ${fmt.gbp(b.optimalGbp)}.`);
        }
        if (!solo && total > 0 && gridShare >= 0.6) extra.push(` Your servers already use almost all the solar, so for you ${ups ? 'a power station' : 'a battery'} is mostly a separate decision from solar.`);
        const host = h('div', { class: 'dv-untitled' });
        const fin = res.finance || {};
        const card = ui.card({
            eyebrow: ups ? 'The power station' : 'The battery',
            title: ups ? 'What the power station adds' : 'What the battery adds',
            subtitle: STRATEGIES[b.strategy] || b.strategy,
            body: h('div', null,
                h('p', { class: 'dv-lede' }, lede, extra),
                host,
                h('div', { class: 'dv-batt-facts' },
                    h('span', null, h('b', null, fmt.num(b.cyclesPerYear, 0)), ' full cycles a year'),
                    b.gridChargeKwh > 0.05 ? h('span', null, h('b', null, fmt.kwh(b.gridChargeKwh)), ' charged from the grid') : null,
                    fin.batteryEndYear != null ? h('span', null, 'wears out in ', h('b', null, `year ${fin.batteryEndYear}`)) : null)),
        });
        this.dropChart('battery');   // its host is about to be replaced
        p.battery.replaceChildren(card);
        this.chart('battery', charts.createBars, host, {
            title: 'Where its money comes from', ariaLabel: 'The battery’s yearly value split into storing solar, charging in cheap slots and its own standby power',
            horizontal: true, categories: ['Storing solar', 'Cheap grid slots', 'Standby power'],
            x: { tipFormat: c => ({ 'Storing solar': 'Storing your own solar for later', 'Cheap grid slots': 'Charging in cheap Agile half-hours', 'Standby power': 'Its own standby power' })[c] ?? c },
            y: { format: v => fmt.gbp(v) },
            series: [{ key: 'v', label: '£ a year', color: 'battery', values: [split.fromSolarGbp, split.fromGridGbp, split.standbyGbp], format: v => fmt.gbp(v, { dp: 2 }) }],
        });
    },

    renderNotes(res) {
        const { ui } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const sys = res.system || {};
        // build-time notes from kits.js that an edit can make untrue
        const own = (sys.notes || []).filter(n => !(/network operator approves/.test(n) && sys.export?.kind !== 'prime')
            && !(/^We assumed £\d+ \(range/.test(n) && !sys.costs?.some(c => c.kind === 'install')));
        // catalog notes can carry engineer words the rest of the page avoids (UX critique copy swaps)
        const plain = n => String(n).replace(/\bMPPTs\b/g, 'solar inputs').replace(/\bMPPT\b/g, 'solar-input');
        const notes = [...own, ...(res.typical?.warnings || []), ...((res.finance?.flags || []).map(f => FLAG_TEXT[f]).filter(Boolean))].map(plain);
        const uniq = [...new Set(notes)];
        if (!uniq.length) { p.notes.replaceChildren(); return; }
        p.notes.replaceChildren(ui.card({ eyebrow: 'Good to know', title: 'Notes on this option', body: h('ul', { class: 'dv-notes' }, uniq.map(n => h('li', null, n))) }));
    },

    /* ── a day in the life ──────────────────────────────────────────────── */

    renderDayTools() {
        const { ui, data } = this.ctx;
        const h = ui.h;
        const p = this.v.parts;
        const s = data.summary();
        const seg = ui.segmented({
            ariaLabel: 'Which day', size: 'sm', value: this.st.which,
            options: [{ value: 'summer', label: 'Summer' }, { value: 'winter', label: 'Winter' }, { value: 'date', label: 'Pick a date' }],
            onChange: v => {
                this.st.which = v;
                if (v === 'date' && !this.st.date) this.st.date = this.st.day?.date ?? s?.to ?? null;
                this.renderDayTools();
                this.loadDay();
            },
        });
        const parts = [seg];
        if (this.st.which === 'date') {
            const inp = ui.textInput({ type: 'date', value: this.st.date || '', ariaLabel: 'Date', onChange: v => { if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { this.st.date = v; this.loadDay(); } } });
            if (s?.from) inp.min = s.from;
            if (s?.to) inp.max = s.to;
            parts.push(inp);
        }
        p.dayTools.replaceChildren(...parts);
    },

    renderDay() {
        const { charts, fmt, ui } = this.ctx;
        const h = ui.h;
        const p = this.v?.parts;
        if (!p) return;
        p.dayWrap.classList.remove('is-stale');
        if (this.st.dayError) {
            this.dropChart('dayFlows');
            this.dropChart('dayPrices');
            p.dayFlows.replaceChildren(h('div', { class: 'notice notice-warn' }, ui.icon('alert'), h('span', null, this.st.which === 'date' ? `No data for that date — pick one between ${fmt.date(Date.parse(`${this.ctx.data.summary()?.from}T12:00:00Z`))} and ${fmt.date(Date.parse(`${this.ctx.data.summary()?.to}T12:00:00Z`))}.` : `Couldn’t draw the day: ${this.st.dayError?.message || this.st.dayError}`)));
            p.dayPrices.replaceChildren();
            p.dayNote.replaceChildren();
            return;
        }
        const day = this.st.day;
        if (!day) return;
        if (!p.dayFlows.querySelector('.chart')) p.dayFlows.replaceChildren();
        const sys = this.st.result?.system ?? this.st.draft;
        const L = dayLayers(day.slots);
        const x = day.slots.map(s => s.time);
        const date = fmt.date(Date.parse(`${day.date}T12:00:00Z`), { year: true });
        p.daySub.textContent = (day.which === 'summer' ? `A clear day near midsummer — ${date}` : day.which === 'winter' ? `A clear day near midwinter — ${date}` : date)
            + '. Average watts each half-hour, typical weather.';
        const lim = sys?.inverter?.acLimitW;
        const lostLabel = finite(lim) && sys.route === 'plugin' ? `Lost to the ${fmt.num(lim)} W limit` : 'Lost to the inverter’s limits';
        const ups = sys?.battery?.coupling === 'ups';
        const stationPv = ups && countOf(sys.battery.ups?.pvArrays) > 0;
        const wf = v => fmt.w(Math.abs(v));
        const series = [
            { key: 'solar', label: 'Solar used at home', color: 'pv', values: L.solar },
            { key: 'batt', label: stationPv ? 'From the power station (its solar + stored)' : ups ? 'From the power station' : 'From the battery', color: 'battery', values: L.batt },
            { key: 'grid', label: 'From the grid', color: 'import', values: L.grid },
            { key: 'exp', label: 'Sent to the grid', color: 'export', values: L.exp },
            { key: 'chg', label: ups ? 'Charging the power station' : 'Charging the battery', color: 'battery', values: L.chg },
            { key: 'lost', label: lostLabel, color: 'clipped', values: L.lost },
        ].filter(s => s.key === 'grid' || anyNonZero(s.values)).map(s => ({ ...s, format: wf }));
        series.push({ key: 'use', label: 'Your use', color: '--chart-front', values: L.use, line: true, format: wf });
        this.chart('dayFlows', charts.createStackedArea, p.dayFlows, {
            title: `How your use was met, ${date}`, ariaLabel: `Half-hourly energy on ${date}: above zero how your home’s use was met, below zero what went elsewhere`,
            x: { values: x, tipFormat: (v, i) => `${v}–${x[i + 1] ?? '24:00'}` }, height: 260, total: false,
            y: { label: 'watts', format: v => fmt.num(v) },
            series,
            bands: [{ from: '16:00', to: '19:00', label: '4–7pm', legend: false }],
        });
        const prices = [{ key: 'price', label: 'Import price', color: 'price', values: L.price, format: v => fmt.p(v) }];
        if (L.xprice.some(v => Math.abs(v) > 0.01)) prices.push({ key: 'xprice', label: 'Export price', color: 'export', values: L.xprice, format: v => fmt.p(v) });
        this.chart('dayPrices', charts.createLine, p.dayPrices, {
            title: `Prices, ${date}`, ariaLabel: `Half-hourly prices on ${date}`,
            x: { values: x, tipFormat: (v, i) => `${v}–${x[i + 1] ?? '24:00'}` }, height: 150, legendMin: 2, endLabels: false,
            y: { label: 'p/kWh', format: v => fmt.num(v, 0), zero: true },
            series: prices,
            bands: [{ from: '16:00', to: '19:00' }],
            printTable: false,   // 48 rows of prices would add two pages; the chart prints
        });
        p.dayNote.replaceChildren(h('p', { class: 'dv-band-note' }, 'Above zero: how your home’s use was met. Below zero: where the rest went. Prices as billed that day.',
            stationPv ? ' The power station’s own panels charge it directly, so their solar shows up as what it gives the servers.' : ''));
    },
};
