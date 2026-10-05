/*
 * views/data.js — "Your data": the full connect flow, then a ledger of every choice made for you.
 *
 * No data (or "Change source"): pick a source — Octopus account, a CSV file, usage entered by hand,
 * or the example household — fill the one short form it needs, and watch a progress list with an
 * action on whichever step fails. Octopus keys that see several accounts (or a property with more
 * than one import meter) get a picker step instead of an error.
 *
 * With data: the provenance ledger. Each automatic choice — location, prices, the period, solar
 * you already have, how much of the year is real readings, which satellite the sunshine came
 * from — is listed with what it means, and the ones you can change open an inline editor that
 * re-fetches from that step (DataHub.load with navigate:false) while the old figures stay visible.
 *
 * View-specific components (prefixed da- — not dv-, which is Design's — styles injected once as #style-data):
 *   sourcePicker()   a radio group of four source cards with roving focus
 *   meter()          a thin proportion bar whose legend prints every value (no hover-only data)
 *   locationFields() postcode + optional map pin (map.js) + optional electricity region
 *   runPanel()       progress list + per-step failure actions + the account/meter picker
 */

const STYLE_ID = 'style-data';

const CSS = `
.da-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.da-connect { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 20px; align-items: start; }
.da-sources { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 20px; }
.da-source {
    position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 5px; min-height: 92px; min-width: 0;
    padding: 12px 14px 13px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--sunk);
    color: var(--text-2); text-align: left; cursor: pointer; transition: border-color .15s, background .15s, color .15s;
}
.da-source:hover { border-color: var(--border-strong); color: var(--text); }
.da-source[aria-checked='true'] { border-color: var(--accent); background: var(--accent-dim); color: var(--text); }
.da-source[aria-checked='true']::after {
    content: ''; position: absolute; top: 12px; right: 12px; width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim);
}
.da-source-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; padding-right: 14px; }
.da-source-title .icon { color: var(--accent); }
.da-source-sub { font-size: 12.5px; line-height: 1.42; color: var(--muted); }
.da-source-tag { font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin-top: auto; }
.da-form { display: grid; gap: 16px; }
.da-form-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.da-submit-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.da-lede { color: var(--muted); font-size: 14px; max-width: 64ch; }
.da-lede b { color: var(--text-2); font-weight: 600; }
.da-sum { font-family: var(--font-mono); font-size: 12.5px; color: var(--text-2); padding: 10px 12px; border: 1px solid var(--hairline); border-radius: var(--radius-sm); background: var(--sunk); }
.da-sum b { color: var(--text); font-weight: 600; }
.da-streams { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; }
.da-stream { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 2px 12px; padding: 12px 0; border-top: 1px solid var(--hairline); }
.da-stream:first-child { border-top: 0; padding-top: 0; }
.da-stream-n { grid-row: span 2; font-family: var(--font-mono); font-size: 11px; color: var(--accent); padding-top: 2px; }
.da-stream-t { font-size: 14px; font-weight: 600; color: var(--text); }
.da-stream-d { font-size: 12.5px; color: var(--muted); line-height: 1.5; }
.da-stream-d .mono { color: var(--text-2); font-size: 11.5px; }
.da-privacy { display: flex; gap: 8px; align-items: flex-start; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--hairline); font-size: 12.5px; color: var(--muted); }
.da-privacy .icon { margin-top: 2px; color: var(--accent); }

.da-drop {
    position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
    min-height: 136px; padding: 18px; border: 1.5px dashed var(--border-strong); border-radius: var(--radius);
    background: var(--sunk); color: var(--text-2); text-align: center; cursor: pointer; transition: border-color .15s, background .15s;
}
.da-drop:hover, .da-drop.is-over { border-color: var(--accent); background: var(--accent-dim); color: var(--text); }
.da-drop:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
.da-drop input { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
.da-drop .icon { color: var(--accent); width: 22px; height: 22px; }
.da-drop-t { font-weight: 600; font-size: 14.5px; }
.da-drop-s { font-size: 12.5px; color: var(--muted); max-width: 46ch; }
.da-file { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--sunk); }
.da-file-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.da-file-name { font-family: var(--font-mono); font-size: 13px; color: var(--text); overflow-wrap: anywhere; }
.da-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px 16px; margin: 0; }
.da-facts dt { font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.da-facts dd { margin: 2px 0 0; font-family: var(--font-mono); font-size: 13px; color: var(--text); }
.da-warns { margin: 0; padding-left: 18px; font-size: 12.5px; color: var(--warn); display: grid; gap: 3px; }

.da-loc { display: grid; gap: 10px; }
.da-loc-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: end; }
.da-map { height: 280px; }

.da-run { display: grid; gap: 12px; }
.da-run:empty { display: none; }
.da-run-box { padding: 12px 14px; border: 1px solid var(--hairline); border-radius: var(--radius-sm); background: var(--sunk); }
.da-fail { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid rgba(217, 112, 95, 0.45); border-radius: var(--radius-sm); background: var(--bad-dim); }
.da-fail-step { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--bad); }
.da-fail-msg { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; color: var(--text); }
.da-fail-msg .icon { color: var(--bad); margin-top: 2px; }
.da-fail-acts { display: flex; gap: 8px; flex-wrap: wrap; }
.da-fail:focus, .da-pick:focus { outline: 2px solid var(--accent); outline-offset: 2px; }
.da-more-now { color: var(--accent); font-weight: 500; }
.da-pick { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: var(--accent-dim); }
.da-pick-t { font-weight: 600; font-size: 14.5px; }
.da-pick-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.da-pick-opt { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--sunk); cursor: pointer; }
.da-pick-opt:hover { border-color: var(--border-strong); }
.da-pick-opt:has(input:checked) { border-color: var(--accent); }
.da-pick-opt input { accent-color: var(--accent); width: 16px; height: 16px; margin: 0; flex: none; }
.da-pick-main { font-family: var(--font-mono); font-size: 13.5px; color: var(--text); }
.da-pick-sub { font-size: 12px; color: var(--muted); }

.da-ledger { display: grid; }
.da-row { display: grid; grid-template-columns: 148px minmax(0, 1fr) auto; gap: 4px 18px; align-items: start; padding: 14px 0; border-top: 1px solid var(--hairline); }
.da-row:first-child { border-top: 0; padding-top: 0; }
.da-key { font-family: var(--font-mono); font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); padding-top: 4px; }
.da-val { min-width: 0; color: var(--text); font-size: 14.5px; overflow-wrap: anywhere; }
.da-val .mono { font-size: 13px; color: var(--text-2); }
.da-hint { margin-top: 3px; font-size: 12.5px; line-height: 1.5; color: var(--muted); }
.da-hint.is-warn { color: var(--warn); }
.da-act { justify-self: end; }
.da-act .btn[aria-expanded='true'] { border-color: var(--accent-line); color: var(--accent); }
.da-editor { grid-column: 1 / -1; display: grid; gap: 14px; margin-top: 10px; padding: 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: var(--sunk); }
.da-editor-acts { display: flex; gap: 8px; flex-wrap: wrap; }
.da-tariffs { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; }
.da-tariffs li { font-family: var(--font-mono); font-size: 12px; color: var(--text-2); }
.da-tariffs li span { color: var(--muted); }
.da-notes { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; color: var(--text-2); }
.da-stale { opacity: .45; pointer-events: none; transition: opacity .2s; }

.da-meter { display: flex; gap: 2px; height: 10px; margin-top: 8px; border-radius: 5px; overflow: hidden; background: var(--surface-3); }
.da-meter > span { display: block; min-width: 3px; }
.da-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; padding: 0; list-style: none; font-size: 12.5px; color: var(--text-2); }
.da-legend li { display: inline-flex; align-items: center; gap: 6px; }
.da-legend i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.da-legend b { font-family: var(--font-mono); font-size: 12px; font-weight: 500; color: var(--text); }
.da-device { display: grid; gap: 14px; }
.da-device-state { display: flex; gap: 10px; align-items: flex-start; font-size: 14px; color: var(--text-2); }
.da-device-state .icon { color: var(--accent); margin-top: 2px; }
.da-device-acts { display: flex; gap: 8px; flex-wrap: wrap; }

@media (max-width: 1023px) {
    .da-connect { grid-template-columns: minmax(0, 1fr); }
    .da-sources { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 600px) {
    .da-form-2 { grid-template-columns: minmax(0, 1fr); }
    .da-sources { gap: 8px; margin-bottom: 16px; }
    .da-source { min-height: 64px; padding: 10px 12px; gap: 3px; }
    .da-source-title { font-size: 13.5px; }
    .da-source-sub { display: none; }
    .da-submit-row .btn { width: 100%; }
    .da-row { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; }
    .da-key { grid-column: 1 / -1; padding-top: 0; }
    .da-loc-row { grid-template-columns: minmax(0, 1fr); }
    .da-map { height: 240px; }
    .da-head-actions .btn { flex: 1; }
    .da-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media print { .da-act, .da-editor, .da-device-acts, .da-device-card { display: none !important; } }
`;

/* Region letters → names (GSP groups; the same table octopus.js uses for pricing). */
const REGIONS = {
    A: 'Eastern England', B: 'East Midlands', C: 'London', D: 'Merseyside & North Wales', E: 'West Midlands',
    F: 'North East England', G: 'North West England', H: 'Southern England', J: 'South East England', K: 'South Wales',
    L: 'South West England', M: 'Yorkshire', N: 'South Scotland', P: 'North Scotland',
};
const BASIS_LABEL = { mine: 'Your own tariffs', agile: 'Agile today', flexible: 'Flexible Octopus', flat: 'A flat price' };
const BASIS_HINT = {
    mine: 'Every half-hour priced on the tariff you were actually on at the time.',
    agile: 'Every half-hour priced at what Agile Octopus (the version on sale now) charged for it in your region.',
    flexible: 'Priced on Flexible Octopus, the standard variable tariff.',
    flat: 'One price for every half-hour — useful to compare with a fixed tariff.',
};
/* How forward years are priced, per basis (the levy only ever applied to Agile half-hours). */
const FORWARD_HINT = {
    mine: 'Forward years use your current tariff at today’s rates; Agile half-hours from before April 2026 also lose the 3.5p levy removed that month. VAT is 0% until 31 Mar 2027. ',
    agile: 'Forward years use today’s prices: Agile half-hours from before April 2026 are lowered by the 3.5p levy removed that month, and VAT is 0% until 31 Mar 2027. ',
    flexible: 'Forward years use today’s Flexible rate for every half-hour, with VAT at 0% until 31 Mar 2027. ',
    flat: 'Forward years use the same flat price, with VAT at 0% until 31 Mar 2027. ',
};
const LOCATION_SOURCE = {
    postcode: 'Located from your postcode.',
    outcode: 'Located from the first half of your postcode (within a couple of km).',
    latlon: 'Located from the pin you dropped on the map.',
    'region-centroid': 'Sunshine is for the centre of your region, not your home — set your postcode or drop a pin on the map for your own.',
    demo: 'The example home in central London.',
};
const WX_SOURCES = [
    { label: 'SARAH-3 satellite', color: 'var(--series-pv)' },
    { label: 'MSG satellite (15-min)', color: 'var(--cat-1)' },
    { label: 'ECMWF IFS model ×0.93', color: 'var(--cat-2)' },
    { label: 'Example-data fill', color: 'var(--series-muted)' },
    { label: 'Interpolated', color: 'var(--faint)' },
];
const SOURCES = [
    { value: 'octopus', title: 'Octopus account', sub: 'Your real half-hours and the tariffs you were on.', tag: 'Most accurate', icon: 'lock' },
    { value: 'csv', title: 'CSV file', sub: 'An Octopus download or any start, kWh file.', icon: 'upload' },
    { value: 'manual', title: 'Enter by hand', sub: 'Your always-on watts and yearly use.', icon: 'pencil' },
    { value: 'demo', title: 'Example data', sub: 'A London home with servers, real prices and sunshine.', tag: 'Instant', icon: 'sun' },
];
const MAX_CSV_BYTES = 25 * 1024 * 1024;

/* Survives re-renders and tab switches, never a page reload: the CSV text is only ever in memory.
 * (The meter picked on an account and a region chosen by hand live in store.connection — mpan,
 * region — which DataHub.load writes, so they survive a reload too.) */
const mem = { csv: null };

const finite = v => typeof v === 'number' && Number.isFinite(v);
const isoDay = s => (s ? Date.parse(`${s}T12:00:00Z`) : NaN);
const isAbort = err => err?.name === 'AbortError';
const SLOT_MS = 1_800_000;
const DAY_MS = 86_400_000;

/** 812 → '812 bytes', 64 kB, 1.3 MB. */
function fileSize(bytes) {
    if (!(bytes >= 0)) return '';
    if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('en-GB', { maximumFractionDigits: bytes < 10_240 ? 1 : 0 })} kB`;
    return `${(bytes / 1024 / 1024).toLocaleString('en-GB', { maximumFractionDigits: 1 })} MB`;
}

/** Shorten a long file name in the middle, keeping its extension: 'my-very-long…2026-10-03.csv'. */
function shortName(name, max = 40) {
    const s = String(name || '');
    if (s.length <= max) return s;
    const tail = Math.min(18, Math.floor(max / 2));
    return `${s.slice(0, max - tail - 1)}…${s.slice(-tail)}`;
}

/** Stable JSON for comparing specs (sorted keys). */
function specKey(spec) {
    const walk = v => (v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined && v[k] !== null && v[k] !== '').map(k => [k, walk(v[k])]))
        : v);
    return JSON.stringify(walk(spec));
}

function injectStyle() {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

/** '2025-10-01T00:30Z' → '1 Oct 2025, 01:30' in London time. */
let slotFmt = null;
function fmtSlot(ms) {
    try {
        slotFmt ??= new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        return slotFmt.format(ms).replace('Sept', 'Sep');
    } catch { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
}

function tariffName(code = '') {
    const c = String(code).toUpperCase();
    if (/AGILE-OUTGOING/.test(c)) return 'Agile Outgoing';
    if (/AGILE/.test(c)) return 'Agile Octopus';
    if (/(^|-)VAR-|FLEX/.test(c)) return 'Flexible Octopus';
    if (/^FLAT-/.test(c)) return 'Flat price';
    if (/GO-/.test(c)) return 'Octopus Go';
    if (/COSY/.test(c)) return 'Cosy Octopus';
    if (/FLUX/.test(c)) return 'Octopus Flux';
    if (/INTELLI/.test(c)) return 'Intelligent Octopus';
    if (/TRACKER|SILVER/.test(c)) return 'Octopus Tracker';
    if (/FIX/.test(c)) return 'Fixed tariff';
    return 'Tariff';
}

/**
 * Sample a CSV for the preview without parsing the whole file on the page: the parser runs on
 * the first and last 800 lines (format, period ends, resolution and warnings), and the line count
 * gives the size. The full file is parsed in the engine worker when it is loaded.
 * @param {string} text
 * @returns {Promise<object>}
 */
async function previewCsv(text) {
    const { parseConsumptionCsv } = await import('../csv.js');
    const lines = text.split(/\r\n|\r|\n/);
    const count = lines.reduce((n, l) => n + (l.trim() ? 1 : 0), 0);
    const sampled = lines.length > 1600;
    const sample = sampled ? lines.slice(0, 800).concat(lines.slice(-800)).join('\n') : text;
    const out = parseConsumptionCsv(sample);
    const warnings = out.warnings.filter(w => !(sampled && /absent|duplicate/i.test(w)));
    const res = out.warnings.find(w => /hourly|minutes/.test(w));
    const resolution = !res ? 'Half-hourly' : /hourly/.test(res) ? 'Hourly (split in two)' : `Every ${/(\d+)-minute|every (\d+) minutes/i.exec(res)?.slice(1).find(Boolean) ?? '?'} min (added up)`;
    const first = out.rows[0][0], last = out.rows[out.rows.length - 1][0];
    const readings = Math.max(0, count - (out.format === 'headerless' ? 0 : 1));
    // Rows are half-hour slot starts, so the file covers first → last + one half-hour.
    const days = Math.max(1, Math.round((last + SLOT_MS - first) / DAY_MS));
    return { format: out.format, first, last, days, lines: readings, resolution, warnings, head: out.rows.slice(0, 5), sampled };
}

/** Delete the cached downloads (weather and public price pages) kept in IndexedDB. */
function deleteCacheDb() {
    return new Promise(resolve => {
        try {
            const req = indexedDB.deleteDatabase('solar-calculator');
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
            // The worker's open handle closes itself on versionchange; don't wait on it forever.
            req.onblocked = () => setTimeout(() => resolve(true), 1200);
        } catch { resolve(false); }
    });
}

/**
 * The existing-solar date the account's own readings suggest (dataset.js existingGenerationHint:
 * an export meter registered during the year, or a year that had to stop where the readings turn
 * into runs of 0 kWh), with the sign in words — or null when a date is already set or there is
 * no sign. Pure, exported for tests.
 * @param {object|null} summary DatasetSummary
 * @param {object|null} conn store.connection
 * @param {(ms: number) => string} dateText formats a day (ms at noon UTC)
 * @returns {{ date: string, why: string|null }|null}
 */
export function suggestedInstall(summary, conn, dateText) {
    const g = summary?.existingGeneration;
    const date = g?.suggestedInstallDate;
    if (conn?.installedSolarDate || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !finite(isoDay(date))) return null;
    const why = date === g.exportSince ? `Your account has had an export meter since ${dateText(isoDay(date))}.`
        : date === g.zeroTailFrom ? `Your readings after ${dateText(isoDay(date) - DAY_MS)} are mostly 0 kWh.`
            : null;
    return { date, why };
}

export default {
    id: 'data',
    title: 'Your data',

    mount(el, ctx) {
        injectStyle();
        this.el = el;
        this.ctx = ctx;
        this.charts = [];
        this.maps = [];
        this.token = 0;
        this.busy = false;
        this.pending = false;
        this.connectOpen = false;
        this.editing = null;
        this.params = {};
        this.lastCategory = null;
        const conn = ctx.store.get().connection;
        this.mode = conn.kind && conn.kind !== 'octopus' ? conn.kind : 'octopus';
        this.draft = {
            key: '', account: conn.accountNumber || '', remember: !!conn.rememberKey,
            postcode: conn.location?.postcode || '', lat: conn.location?.lat ?? null, lon: conn.location?.lon ?? null,
            region: conn.region || '', basis: conn.priceBasis || 'mine', flatP: conn.flatP ?? 25,
            installed: conn.installedSolarDate || '', baseW: conn.manual?.baseW ?? 400, otherKwhYr: conn.manual?.otherKwhYr ?? 2700,
            serverW: conn.demoServerW || 500,
        };
        this.offs = [
            ctx.data.on('dataset', () => this.render()),
            ctx.data.on('status', () => { if (this.category() !== this.lastCategory) this.render(); }),
        ];
        this.render();
    },

    show(params) {
        const p = params || {};
        const changed = JSON.stringify(p) !== JSON.stringify(this.params);
        this.params = p;
        if (!changed) return;
        const mode = p.mode;
        const summary = this.ctx.data.summary();
        if (p.edit) {
            // Deep link to one ledger editor (#data?edit=prices). On a cold load the data is still
            // arriving, so it is applied when the ledger first renders.
            this.pendingEdit = p.edit;
            this.connectOpen = false;
            if (summary) this.render();
            return;
        }
        if (!mode && summary && this.connectOpen && !this.busy) {
            // A plain #data visit (the header chip) means "show me my data", not the last form.
            this.connectOpen = false;
            this.render();
            return;
        }
        if (mode === 'location' && summary && summary.source !== 'demo') {
            this.editing = 'location';
            this.connectOpen = false;
        } else if (['octopus', 'csv', 'manual', 'demo', 'location'].includes(mode)) {
            this.mode = mode === 'location' ? (['csv', 'manual'].includes(this.mode) ? this.mode : 'octopus') : mode;
            // Also when data is still arriving (a cold load): the link asked for this form.
            this.connectOpen = true;
            this.focusPostcode = mode === 'location';
        }
        this.render();
    },

    hide() {},

    unmount() {
        this.offs?.forEach(off => off());
        this.destroyWidgets();
    },

    destroyWidgets() {
        this.charts.forEach(c => c.destroy());
        this.charts = [];
        this.maps.forEach(m => { try { m.destroy(); } catch { /* map already gone */ } });
        this.maps = [];
    },

    /** Which screen the view is on; status events only re-render when this changes. */
    category() {
        const { data } = this.ctx;
        if (this.busy) return 'busy';
        const summary = data.summary();
        if (summary && !this.connectOpen) return 'loaded';
        if (!summary && data.status() === 'loading') return 'loading';
        return 'connect';
    },

    render() {
        if (this.busy) { this.pending = true; return; }
        this.pending = false;
        const { ui, data } = this.ctx;
        const token = ++this.token;
        this.destroyWidgets();
        this.lastCategory = this.category();
        const summary = data.summary();
        if (this.lastCategory === 'loading') {
            this.el.replaceChildren(this.head(null),
                ui.card({ body: ui.h('div', { class: 'stack-sm', 'aria-live': 'polite' },
                    ui.h('div', { class: 'row' }, ui.h('span', { class: 'spinner', 'aria-hidden': 'true' }), ui.h('span', null, 'Loading your data…')),
                    ui.skeleton({ lines: 5 })) }));
            return;
        }
        if (this.lastCategory === 'connect') { this.renderConnect(summary); return; }
        this.renderLoaded(summary, token);
    },

    head(summary) {
        const { ui, fmt } = this.ctx;
        const actions = [];
        if (summary && !this.connectOpen) {
            actions.push(ui.button({ label: 'Change source', icon: 'refresh', onClick: () => { this.connectOpen = true; this.mode = summary.source === 'demo' ? 'octopus' : summary.source; this.render(); } }));
            actions.push(ui.button({ label: 'See the verdict', kind: 'primary', icon: 'arrowRight', href: '#verdict' }));
        } else if (summary && this.connectOpen) {
            actions.push(ui.button({ label: 'Back to your data', kind: 'ghost', onClick: () => { this.connectOpen = false; this.render(); } }));
        }
        const now = summary
            ? `${this.sourceLine(summary, { short: true })} · ${fmt.date(isoDay(summary.from))} – ${fmt.date(isoDay(summary.to))} · ${summary.regionName || `Region ${summary.region}`}`
            : null;
        const lede = !summary
            ? 'Everything the calculator knows about your home comes from here. Nothing leaves your browser except requests to Octopus, the weather service and the postcode lookup.'
            : this.connectOpen ? `Now using: ${now}. The new data replaces it once it has loaded.` : now;
        const title = !summary ? 'Connect your home' : this.connectOpen ? 'Use different data' : 'Where the numbers come from';
        return ui.h('div', { class: 'view-head' },
            ui.h('div', null,
                ui.h('div', { class: 'view-kicker' }, 'Your data'),
                ui.h('h1', { class: 'view-title' }, title),
                ui.h('p', { class: 'view-lede' }, lede)),
            actions.length ? ui.h('div', { class: 'da-head-actions no-print' }, actions) : null);
    },

    /** A short name for the price basis, sized for a stat tile. */
    priceShort(summary) {
        const c = this.ctx.store.get().connection;
        if (summary.source !== 'demo' && summary.priceBasis === 'flat') return this.ctx.fmt.p(c.flatP ?? NaN, { dp: 1 }).replace('—', 'Flat');
        if (summary.source !== 'demo' && summary.priceBasis === 'flexible') return 'Flexible';
        return tariffName(summary.tariffCode).replace(/ Octopus$|^Octopus /, '').replace(/ tariff$/, '') || 'Agile';
    },

    sourceLine(summary, { short = false } = {}) {
        const c = this.ctx.store.get().connection;
        switch (summary.source) {
            case 'octopus': return `Octopus account${c.accountNumber ? ` ${c.accountNumber}` : ''}`;
            case 'demo': return `Example household · ${this.ctx.fmt.w(summary.serverW ?? c.demoServerW ?? 500)} servers`;
            case 'csv': return mem.csv?.name ? `CSV file · ${short ? shortName(mem.csv.name) : mem.csv.name}` : 'CSV file';
            case 'manual': return 'Usage entered by hand';
            default: return summary.source || 'Your data';
        }
    },

    /* ── connect flow ─────────────────────────────────────────────────────── */

    renderConnect(summary) {
        const { ui } = this.ctx;
        this.runHost = ui.h('div', { class: 'da-run', 'aria-live': 'polite' });
        const formHost = ui.h('div');
        const picker = this.sourcePicker(v => {
            this.mode = v;
            this.runHost.replaceChildren();
            this.destroyWidgets();
            formHost.replaceChildren(this.formFor(v));
        });
        formHost.appendChild(this.formFor(this.mode));
        const main = ui.card({
            title: 'Where should your usage come from?',
            subtitle: 'Pick one. You can switch at any time — your settings and saved scenarios stay.',
            body: [picker, formHost, this.runHost],
        });
        this.el.replaceChildren(this.head(summary), ui.h('div', { class: 'da-connect' }, main, this.streamsCard()));
        if (this.focusPostcode) {
            this.focusPostcode = false;
            requestAnimationFrame(() => {
                const opts = this.el.querySelector('.da-options');
                if (opts) opts.open = true;
                const pc = this.el.querySelector('input[name="postcode"]');
                pc?.focus();
            });
        }
    },

    /** Four source cards acting as one radio group (arrow keys move and select). */
    sourcePicker(onChange) {
        const { ui } = this.ctx;
        const group = ui.h('div', { class: 'da-sources', role: 'radiogroup', 'aria-label': 'Data source' });
        const cards = SOURCES.map(s => ui.h('button', {
            type: 'button', role: 'radio', class: 'da-source', dataset: { v: s.value },
            on: { click: () => choose(s.value, true) },
        },
        ui.h('span', { class: 'da-source-title' }, ui.icon(s.icon), s.title),
        ui.h('span', { class: 'da-source-sub' }, s.sub),
        s.tag ? ui.h('span', { class: 'da-source-tag' }, s.tag) : null));
        const paint = () => cards.forEach(c => {
            const on = c.dataset.v === this.mode;
            c.setAttribute('aria-checked', String(on));
            c.tabIndex = on ? 0 : -1;
        });
        const choose = (v, fire) => {
            if (v === this.mode) return;
            if (this.busy) return;
            this.mode = v;
            paint();
            if (fire) onChange(v);
        };
        group.addEventListener('keydown', e => {
            const i = cards.indexOf(document.activeElement);
            const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (i < 0 || !d) return;
            e.preventDefault();
            const n = (i + d + cards.length) % cards.length;
            cards[n].focus();
            choose(cards[n].dataset.v, true);
        });
        group.append(...cards);
        paint();
        return group;
    },

    formFor(mode) {
        if (mode === 'csv') return this.csvForm();
        if (mode === 'manual') return this.manualForm();
        if (mode === 'demo') return this.demoForm();
        return this.octopusForm();
    },

    /** The right-hand card: the four data streams, where each comes from, and the privacy promise. */
    streamsCard() {
        const { ui } = this.ctx;
        const item = (n, t, d) => ui.h('li', { class: 'da-stream' }, ui.h('span', { class: 'da-stream-n' }, n), ui.h('span', { class: 'da-stream-t' }, t), ui.h('span', { class: 'da-stream-d' }, d));
        return ui.card({
            eyebrow: 'What we fetch',
            title: 'Four streams, joined by the half-hour',
            body: [
                ui.h('ol', { class: 'da-streams' },
                    item('01', 'Your usage', ['Half-hourly kWh from your smart meter, for the latest full year. ', ui.h('span', { class: 'mono' }, 'api.octopus.energy')]),
                    item('02', 'Your prices', ['The tariffs you were on, plus Agile and export rates for your region. ', ui.h('span', { class: 'mono' }, 'api.octopus.energy')]),
                    item('03', 'Your sunshine', ['Satellite irradiance for your home every half-hour, and 20 years of averages. ', ui.h('span', { class: 'mono' }, 'open-meteo.com')]),
                    item('04', 'Your location', ['Postcode to map position and electricity region. ', ui.h('span', { class: 'mono' }, 'api.postcodes.io')])),
                ui.h('p', { class: 'da-privacy' }, ui.icon('lock'),
                    ui.h('span', null, 'Your API key stays in this browser and is only ever sent to api.octopus.energy. Nothing is uploaded to us — there is no “us” server.')),
            ],
        });
    },

    /** Price basis control; Octopus users can also keep their own tariffs. */
    basisFields(kind) {
        const { ui } = this.ctx;
        const d = this.draft;
        const opts = (kind === 'octopus' ? ['mine'] : []).concat(['agile', 'flexible', 'flat']);
        if (!opts.includes(d.basis)) d.basis = opts[0];
        const flat = ui.field({
            label: 'Flat price (today’s p/kWh)',
            hint: 'VAT on electricity is 0% until 31 Mar 2027, so today’s price is the same with or without it.',
            input: ui.numberInput({ value: d.flatP, min: 1, max: 150, step: 0.1, unit: 'p', onChange: v => { d.flatP = v; this.paintMore?.(); } }),
        });
        flat.hidden = d.basis !== 'flat';
        const hint = ui.h('span', null, BASIS_HINT[d.basis]);
        const seg = ui.segmented({
            ariaLabel: 'Price my usage as if on', value: d.basis,
            options: opts.map(v => ({ value: v, label: v === 'mine' ? 'My tariffs' : BASIS_LABEL[v] })),
            onChange: v => { d.basis = v; flat.hidden = v !== 'flat'; hint.textContent = BASIS_HINT[v]; this.paintMore?.(); },
        });
        return ui.h('div', { class: 'stack-sm' }, ui.field({ label: 'Price my usage as if on', input: seg, hint }), flat);
    },

    installedField() {
        const { ui } = this.ctx;
        const d = this.draft;
        const set = v => { d.installed = v; this.paintMore?.(); };
        return ui.field({
            label: 'Already have solar or a battery? Installed on',
            hint: 'Readings from that date on are net of your own generation, so they are left out. At least 180 days must remain.',
            input: ui.textInput({ type: 'date', value: d.installed, name: 'installed', onChange: set, onInput: set }),
        });
    },

    /**
     * The summary line of a form's "More options" disclosure. A choice already made inside it (a
     * postcode, an install date, a price basis carried over from last time) is named on the line,
     * so a collapsed disclosure never hides what the next load will use.
     */
    moreSummary(base, kind) {
        const { ui, fmt } = this.ctx;
        const now = ui.h('span', { class: 'da-more-now' });
        const paint = () => {
            const d = this.draft;
            const parts = [];
            if (kind === 'octopus' && String(d.postcode || '').trim()) parts.push(String(d.postcode).trim().toUpperCase());
            if (kind !== 'manual' && d.installed) parts.push(`solar since ${fmt.date(isoDay(d.installed))}`);
            const def = kind === 'octopus' ? 'mine' : 'agile';
            if (d.basis && d.basis !== def) parts.push(d.basis === 'flat' ? `a flat ${fmt.p(d.flatP)}` : BASIS_LABEL[d.basis]);
            now.textContent = parts.length ? ` · now: ${parts.join(', ')}` : '';
        };
        paint();
        this.paintMore = paint;
        return ui.h('span', null, base, now);
    },

    /**
     * Postcode, an optional map pin and the electricity region. With a postcode the pin is ignored;
     * the region is only needed when neither can be looked up.
     */
    locationFields({ withRegion = true, required = false } = {}) {
        const { ui } = this.ctx;
        const d = this.draft;
        const mapHost = ui.h('div', { class: 'da-map', hidden: true });
        const pinNote = ui.h('div', { class: 'field-hint' });
        const paintPin = () => { pinNote.textContent = finite(d.lat) && finite(d.lon) ? `Pinned at ${d.lat.toFixed(5)}, ${d.lon.toFixed(5)}${d.postcode ? ' — your postcode takes priority' : ''}.` : ''; };
        paintPin();
        const pc = ui.textInput({
            value: d.postcode, placeholder: 'SW1A 1AA', name: 'postcode', autocomplete: 'postal-code', mono: true,
            onInput: v => { d.postcode = v.toUpperCase(); paintPin(); this.paintMore?.(); },
        });
        pc.style.textTransform = 'uppercase';
        let mapOpen = false;
        const mapBtn = ui.button({
            label: 'Pick on the map', kind: 'ghost',
            onClick: async () => {
                mapOpen = !mapOpen;
                mapHost.hidden = !mapOpen;
                mapBtn.querySelector('span').textContent = mapOpen ? 'Hide the map' : 'Pick on the map';
                if (!mapOpen || mapHost.dataset.ready) return;
                mapHost.dataset.ready = '1';
                try {
                    const { createLocationMap } = await import('../map.js');
                    const m = await createLocationMap(mapHost, { lat: d.lat, lon: d.lon, onChange: p => { d.lat = p.lat; d.lon = p.lon; paintPin(); } });
                    this.maps.push(m);
                } catch (err) {
                    mapHost.dataset.ready = '';
                    ui.toast(err?.message || 'Couldn’t load the map.', { tone: 'warn' });
                }
            },
        });
        const kids = [
            ui.h('div', { class: 'da-loc-row' },
                ui.field({ label: required ? 'Your postcode' : 'Postcode (optional — we use the one on your account)', input: pc }),
                mapBtn),
            pinNote, mapHost,
        ];
        if (withRegion) {
            kids.push(ui.field({
                label: 'Electricity region (optional)',
                hint: 'We work it out from your postcode or pin; pick it here if that fails.',
                input: ui.select({
                    value: d.region, ariaLabel: 'Electricity region',
                    options: [{ value: '', label: 'Work it out for me' }].concat(Object.entries(REGIONS).map(([k, v]) => ({ value: k, label: `${k} · ${v}` }))),
                    onChange: v => { d.region = v; },
                }),
            }));
        }
        return ui.h('div', { class: 'da-loc' }, kids);
    },

    locationSpec() {
        const d = this.draft;
        const pc = String(d.postcode || '').trim();
        if (pc) return { postcode: pc };
        if (finite(d.lat) && finite(d.lon)) return { lat: d.lat, lon: d.lon };
        return null;
    },

    octopusForm() {
        const { ui, store } = this.ctx;
        const d = this.draft;
        let saved = null;
        try { saved = store.getApiKey(); } catch { saved = null; }
        if (!d.key && saved) d.key = saved;
        const keyField = ui.textInput({ type: 'password', placeholder: 'sk_live_…', value: d.key, reveal: true, mono: true, name: 'octopus-key', onInput: v => { d.key = v; paintHint(); } });
        const keyHint = ui.h('span', { class: 'hint-warn', hidden: true }, ui.icon('info'), ' Octopus keys usually start with sk_live_');
        const paintHint = () => { const v = d.key.trim(); keyHint.hidden = !v || v.startsWith('sk_live_'); };
        paintHint();
        const acct = ui.textInput({ placeholder: 'A-1234ABCD', value: d.account, mono: true, name: 'octopus-account', onInput: v => { d.account = v; } });
        const remember = ui.checkbox({ label: 'Remember my key on this device', checked: d.remember, onChange: v => { d.remember = v; } });
        const submit = ui.h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, ui.h('span', null, 'Analyse my home'), ui.icon('arrowRight'));
        const form = ui.h('form', { class: 'da-form', novalidate: true, autocomplete: 'off' },
            ui.h('div', { class: 'da-form-2' },
                ui.field({ label: 'Octopus API key', input: keyField, hint: keyHint }),
                ui.field({ label: 'Account number (optional — we can find it)', input: acct, hint: 'Leave it blank and we’ll look it up from your key.' })),
            ui.details({
                summary: 'Where’s my API key?',
                body: [
                    ui.h('p', null, 'Octopus website → Your account → Personal details → API access. Copy the key that starts with sk_live_.'),
                    ui.h('p', null, ui.h('a', { href: 'https://octopus.energy/dashboard/new/accounts/personal-details/api-access', target: '_blank', rel: 'noopener noreferrer' }, 'Open the API access page', ui.icon('external'))),
                ],
            }),
            (() => {
                const body = ui.h('div', { class: 'da-form' }, this.locationFields({ withRegion: false }), this.installedField(), this.basisFields('octopus'));
                return ui.details({ className: 'da-options', summary: this.moreSummary('More options — postcode, existing solar, how to price your usage', 'octopus'), body });
            })(),
            ui.h('div', { class: 'da-submit-row' }, remember, submit));
        form.addEventListener('submit', e => {
            e.preventDefault();
            if (this.busy) return;
            const key = d.key.trim();
            const a = ui.normalizeAccount(d.account);
            if (!key) { this.showFormError('Paste your Octopus API key — or pick another source above.', () => keyField.input.focus()); return; }
            if (!a.valid) { this.showFormError('Account numbers look like A-1234ABCD.', () => acct.focus()); return; }
            if (a.value) { d.account = a.value; acct.value = a.value; }
            try { store.setApiKey(key, d.remember); } catch { /* storage blocked: key stays in memory */ }
            const before = store.get().connection;
            store.set({ connection: { accountNumber: a.value, rememberKey: d.remember } });
            const spec = { kind: 'octopus', apiKey: key };
            if (a.value) spec.accountNumber = a.value;
            // the meter picked last time, while it's the same account (an unknown meter is ignored upstream)
            if (before.kind === 'octopus' && before.mpan && (a.value ?? null) === (before.accountNumber ?? null)) spec.mpan = String(before.mpan);
            const loc = this.locationSpec();
            if (loc) spec.location = loc;
            if (d.basis !== 'mine') { spec.priceBasis = d.basis; if (d.basis === 'flat') spec.flatP = d.flatP; }
            if (d.installed) spec.installedSolarDate = d.installed;
            this.connect(spec);
        });
        return form;
    },

    csvForm() {
        const { ui, fmt } = this.ctx;
        const d = this.draft;
        const preview = ui.h('div');
        const input = ui.h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', 'aria-label': 'Choose a CSV file of your half-hourly usage' });
        const drop = ui.h('label', { class: 'da-drop' },
            input, ui.icon('upload'),
            ui.h('span', { class: 'da-drop-t' }, 'Drop your CSV here, or choose a file'),
            ui.h('span', { class: 'da-drop-s' }, 'Octopus: My energy → Download your data → half-hourly consumption. Any file with a start time and kWh (or Wh) per reading works too.'));
        // Back after a reload with a CSV last time: the file itself is never stored, so say why it's gone.
        const again = !mem.csv && this.ctx.store.get().connection.kind === 'csv' && !this.ctx.data.summary()
            ? ui.h('div', { class: 'notice' }, ui.icon('info'), ui.h('span', null, 'Last time you used a CSV file. Files are never stored, so choose it again — your postcode and settings are remembered.'))
            : null;
        const paint = () => {
            const f = mem.csv;
            if (again) again.hidden = !!f;
            if (!f) { preview.replaceChildren(); drop.hidden = false; return; }
            drop.hidden = true;
            const p = f.preview;
            const head = ui.h('div', { class: 'da-file-head' },
                ui.h('span', { class: 'da-file-name' }, `${f.name} · ${fileSize(f.size)}`),
                ui.button({
                    label: 'Choose another file', size: 'sm', kind: 'ghost',
                    // The button goes with the preview, so focus moves to the file chooser it opens.
                    onClick: () => { mem.csv = null; input.value = ''; paint(); input.focus(); try { input.click(); } catch { /* picker blocked: the drop zone has focus */ } },
                }));
            if (f.error) {
                preview.replaceChildren(ui.h('div', { class: 'da-file' }, head,
                    ui.h('div', { class: 'notice notice-bad' }, ui.icon('alert'), ui.h('span', null, f.error))));
                return;
            }
            if (!p) { preview.replaceChildren(ui.h('div', { class: 'da-file' }, head, ui.skeleton({ lines: 3 }))); return; }
            const fmtLabel = { octopus: 'Octopus download', generic: 'Start time + kWh', headerless: 'No header (time, kWh)' }[p.format] || p.format;
            const facts = ui.h('dl', { class: 'da-facts' },
                ...[['Format', fmtLabel], ['Readings', `≈ ${fmt.num(p.lines)}`], ['Resolution', p.resolution],
                    ['First', fmtSlot(p.first)], ['Last', fmtSlot(p.last)], ['Spans', `${fmt.num(p.days)} days`]]
                    .flatMap(([k, v]) => [ui.h('div', null, ui.h('dt', null, k), ui.h('dd', null, v))]));
            const rows = p.head.map(([ms, kwh]) => ({ t: fmtSlot(ms), kwh }));
            const tbl = ui.table({
                caption: 'First half-hours in the file', dense: true,
                columns: [{ key: 't', label: 'Half-hour starting', sortable: false }, { key: 'kwh', label: 'Used', align: 'right', sortable: false, mobile: 'primary', format: v => fmt.kwh(v, { dp: 3 }) }],
                rows,
            });
            const short = p.days < 330 ? ui.h('div', { class: 'notice notice-warn' }, ui.icon('alert'),
                ui.h('span', null, p.days < 14 ? 'This file covers less than two weeks — at least 14 days of readings are needed.'
                    : `This file covers ${p.days} days. Missing months will be estimated from the nearest weeks, so savings are less certain.`))
                : p.days > 366 ? ui.h('p', { class: 'field-hint' }, `The latest 365 complete days are used; the ${fmt.num(p.days - 365)} days before that are left out.`) : null;
            preview.replaceChildren(ui.h('div', { class: 'da-file' }, head, facts, short,
                p.warnings.length ? ui.h('ul', { class: 'da-warns' }, p.warnings.slice(0, 6).map(w => ui.h('li', null, w))) : null,
                tbl));
        };
        const take = async file => {
            if (!file) return;
            if (file.size > MAX_CSV_BYTES) {
                mem.csv = { name: file.name, size: file.size, text: null, error: 'That file is over 25 MB — export a year or two of half-hourly data instead.' };
                paint();
                return;
            }
            mem.csv = { name: file.name, size: file.size, text: null, preview: null };
            paint();
            const entry = mem.csv;
            try {
                entry.text = await file.text();
                entry.preview = await previewCsv(entry.text);
            } catch (err) {
                entry.error = err?.message || 'That file couldn’t be read.';
            }
            if (mem.csv === entry) paint();
        };
        input.addEventListener('change', () => take(input.files?.[0]));
        drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('is-over'); });
        drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
        drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('is-over'); take(e.dataTransfer?.files?.[0]); });
        paint();

        const submit = ui.h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, ui.h('span', null, 'Analyse this file'), ui.icon('arrowRight'));
        const form = ui.h('form', { class: 'da-form', novalidate: true, autocomplete: 'off' },
            again, drop, preview,
            this.locationFields({ required: true }),
            (() => {
                const body = ui.h('div', { class: 'da-form' }, this.installedField(), this.basisFields('csv'));
                return ui.details({ summary: this.moreSummary('More options — existing solar, how to price your usage', 'csv'), body });
            })(),
            ui.h('div', { class: 'da-submit-row' }, ui.h('span', { class: 'field-hint' }, 'The file is read in your browser and never uploaded.'), submit));
        form.addEventListener('submit', e => {
            e.preventDefault();
            if (this.busy) return;
            if (!mem.csv?.text || mem.csv.error) { this.showFormError('Choose a CSV file of your half-hourly usage first.', () => input.focus()); return; }
            const loc = this.locationSpec();
            if (!loc) { this.showFormError('Enter your postcode or drop a pin, so we can fetch the sunshine for your home.', () => form.querySelector('input[name="postcode"]')?.focus()); return; }
            const spec = { kind: 'csv', text: mem.csv.text, location: loc, priceBasis: d.basis };
            if (d.region) spec.region = d.region;
            if (d.basis === 'flat') spec.flatP = d.flatP;
            if (d.installed) spec.installedSolarDate = d.installed;
            this.connect(spec);
        });
        return form;
    },

    manualForm() {
        const { ui, fmt } = this.ctx;
        const d = this.draft;
        const sum = ui.h('div', { class: 'da-sum', 'aria-live': 'polite' });
        const paint = () => {
            const base = Math.max(0, d.baseW || 0), other = Math.max(0, d.otherKwhYr || 0);
            const baseKwh = base * 8.76;
            const total = baseKwh + other;
            sum.replaceChildren(
                'About ', ui.h('b', null, fmt.kwh(total)), ' a year — ',
                ui.h('b', null, fmt.w(base)), ' always on is ', ui.h('b', null, fmt.pct(total > 0 ? (100 * baseKwh) / total : 0)), ' of it.');
        };
        paint();
        const submit = ui.h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, ui.h('span', null, 'Build my profile'), ui.icon('arrowRight'));
        const form = ui.h('form', { class: 'da-form', novalidate: true, autocomplete: 'off' },
            ui.h('p', { class: 'da-lede' }, 'No smart meter data? Tell us two numbers and we’ll build a typical year: your ', ui.h('b', null, 'always-on load'),
                ' (servers, fridge, router — check a plug-in meter or your lowest overnight reading) plus ', ui.h('b', null, 'everything else'), ' you use in a year.'),
            ui.h('div', { class: 'da-form-2' },
                ui.field({ label: 'Always-on load', hint: 'Watts, around the clock.', input: ui.numberInput({ value: d.baseW, min: 0, max: 5000, step: 10, unit: 'W', onChange: v => { d.baseW = v; paint(); } }) }),
                ui.field({ label: 'Everything else per year', hint: 'A typical home uses 2,700 kWh before any servers.', input: ui.numberInput({ value: d.otherKwhYr, min: 0, max: 30000, step: 100, unit: 'kWh', onChange: v => { d.otherKwhYr = v; paint(); } }) })),
            sum,
            this.locationFields({ required: true }),
            (() => {
                const body = this.basisFields('manual');
                return ui.details({ summary: this.moreSummary('More options — how to price your usage', 'manual'), body });
            })(),
            ui.h('div', { class: 'da-submit-row' }, ui.h('span', { class: 'field-hint' }, 'The shape of the day is a typical UK household; only the totals are yours.'), submit));
        form.addEventListener('submit', e => {
            e.preventDefault();
            if (this.busy) return;
            if (!(d.baseW > 0 || d.otherKwhYr > 0)) { this.showFormError('Enter your always-on load or your other yearly use.'); return; }
            const loc = this.locationSpec();
            if (!loc) { this.showFormError('Enter your postcode or drop a pin, so we can fetch the sunshine for your home.', () => form.querySelector('input[name="postcode"]')?.focus()); return; }
            const spec = { kind: 'manual', baseW: d.baseW || 0, otherKwhYr: d.otherKwhYr || 0, location: loc, priceBasis: d.basis };
            if (d.region) spec.region = d.region;
            if (d.basis === 'flat') spec.flatP = d.flatP;
            this.connect(spec);
        });
        return form;
    },

    demoForm() {
        const { ui, fmt } = this.ctx;
        const d = this.draft;
        const out = ui.h('b', null, fmt.w(d.serverW));
        const sl = ui.slider({
            value: d.serverW, min: 0, max: 2000, step: 50, ariaLabel: 'Server load in the example home', format: v => fmt.w(v),
            onInput: v => { d.serverW = v; out.textContent = fmt.w(v); },
            onChange: v => { d.serverW = v; },
        });
        const submit = ui.button({ label: 'Load the example', kind: 'primary', icon: 'arrowRight', onClick: () => { if (!this.busy) this.connect({ kind: 'demo', serverW: d.serverW }); } });
        submit.classList.add('btn-lg');
        return ui.h('div', { class: 'da-form' },
            ui.h('p', { class: 'da-lede' }, 'A real London year — Agile prices and satellite sunshine from 1 Oct 2025 to 30 Sep 2026 — with a ',
                ui.h('b', null, 'synthetic household'), ' of 2,700 kWh a year plus servers running 24/7. It loads instantly and works offline.'),
            ui.field({ label: 'Servers in the example home', hint: ['Always-on load on top of the household: ', out, '.'], input: sl }),
            ui.h('div', { class: 'da-submit-row' }, ui.h('span', { class: 'field-hint' }, 'Swap in your own data whenever you like.'), submit));
    },

    showFormError(message, focus) {
        const { ui } = this.ctx;
        this.runHost?.replaceChildren(ui.h('div', { class: 'da-fail', role: 'alert' },
            ui.h('div', { class: 'da-fail-msg' }, ui.icon('alert'), ui.h('span', null, message))));
        focus?.();
    },

    /**
     * Load a dataset from the connect panel: progress list, then the verdict (DataHub navigates).
     * @param {object} spec DatasetSpec
     */
    async connect(spec) {
        const { ui, data, store } = this.ctx;
        if (this.busy) return;
        const host = this.runHost;
        const pl = ui.progressList(ui.loadStepsFor(spec.kind));
        host.replaceChildren(ui.h('div', { class: 'da-run-box' }, pl.el));
        const form = this.el.querySelector('.da-form');
        form?.classList.add('da-stale');
        this.el.querySelectorAll('.da-source, button[type="submit"]').forEach(b => { b.disabled = true; });
        this.busy = true;
        const run = { failed: null };
        try {
            await data.load(spec, { onProgress: this.progressHandler(pl, run) });
            store.set({ connection: this.extraConnection(spec) });
            this.connectOpen = false;
            this.editing = null;
            this.busy = false;
            this.render();
            return;
        } catch (err) {
            this.busy = false;
            if (isAbort(err)) { this.render(); return; }
            // A key Octopus rejected has already been dropped from storage (DataHub.load); it stays
            // in the field to correct. The device card must stop saying it is kept.
            if (err?.code === 'AUTH') this.paintDevice();
            pl.settle(run.failed || err?.step || null);
            form?.classList.remove('da-stale');
            this.el.querySelectorAll('.da-source, button[type="submit"]').forEach(b => { b.disabled = false; });
            const panel = this.failure(err, spec, { onRetry: s => this.connect(s) });
            host.appendChild(panel);
            this.reveal(panel);
        } finally {
            this.busy = false;
            if (this.pending && this.category() !== 'connect') this.render();
            this.pending = false;
        }
    },

    /**
     * Connection fields DataHub.load doesn't persist itself. It writes the price basis, flat price,
     * existing-solar date, meter and region from the spec; it only adds a location, never clears
     * one — so a load without a location (the account's own postcode) clears the stored one here.
     */
    extraConnection(spec) {
        const extra = {};
        if (spec.kind === 'demo') return extra;
        if (!spec.location) extra.location = { postcode: null, lat: null, lon: null };
        return extra;
    },

    /**
     * loadDataset progress → the progress list (ui.progressList keeps an error row's detail empty:
     * the failure panel underneath says it once, in full). Remembers which step failed, for
     * pl.settle() when the run stops.
     */
    progressHandler(pl, run) {
        const { ui } = this.ctx;
        return p => {
            if (!p?.step) return;
            if (p.status === 'error') run.failed = p.step;
            pl.set(p.step, p.status, ui.progressDetail(p));
        };
    },

    /**
     * Bring a failure (or picker) panel on screen. When the control the user pressed has gone
     * (an editor replaced by its progress list), focus moves to the panel so keyboard and
     * screen-reader users land on the message rather than the top of the page.
     */
    reveal(panel) {
        requestAnimationFrame(() => {
            if (!panel.isConnected) return;
            const r = panel.getBoundingClientRect();
            if (r.top < 70 || r.bottom > window.innerHeight - 8) panel.scrollIntoView({ block: 'center', behavior: this.ctx.ui.scrollBehavior() });
            const a = document.activeElement;
            if (!a || a === document.body || !a.isConnected || a.disabled) {
                const first = panel.querySelector('input[type="radio"]:checked');
                if (first) first.focus({ preventScroll: true });
                else { panel.tabIndex = -1; panel.focus({ preventScroll: true }); }
            }
        });
    },

    /**
     * Open one ledger editor and focus its first field. It starts from what is loaded, except
     * when reopened from a failed re-fetch (keepDraft), where the value that failed stays to be fixed.
     */
    openEditor(id, { keepDraft = false } = {}) {
        if (!keepDraft) this.syncDraft();
        this.editing = id;
        this.rerenderLedger();
    },

    /** Put the cursor in the API key (or account) field, opening the Octopus form if it isn't on screen. */
    gotoKey(which = 'key') {
        const sel = which === 'account' ? 'input[name="octopus-account"]' : 'input[name="octopus-key"]';
        const now = this.el.querySelector(sel);
        if (now?.isConnected && !now.closest('[hidden]')) { now.focus(); if (which === 'key') now.select?.(); return; }
        this.connectOpen = true;
        this.mode = 'octopus';
        this.editing = null;
        this.render();
        requestAnimationFrame(() => { const el = this.el.querySelector(sel); el?.focus(); if (which === 'key') el?.select?.(); });
    },

    /** Put the cursor in a postcode field: the open form's, or the location editor's when data is loaded. */
    gotoPostcode() {
        const pc = this.el.querySelector('input[name="postcode"]');
        if (pc?.isConnected) {
            const opts = pc.closest('details');
            if (opts) opts.open = true;
            pc.focus();
            return;
        }
        if (this.ctx.data.summary() && !this.connectOpen) this.openEditor('location', { keepDraft: true });
    },

    /**
     * A failed load: which step, what Octopus/the weather service said, and what to do next.
     * Several accounts or meters become a picker instead. From a ledger editor (onEdit given) the
     * user's current data is still loaded, so the actions are about fixing the change — not
     * swapping their data for the example.
     * @param {object} err
     * @param {object} spec
     * @param {{ onRetry: (spec: object) => void, onEdit?: () => void, editLabel?: string }} o
     */
    failure(err, spec, { onRetry, onEdit = null, editLabel = 'Change it' }) {
        const { ui } = this.ctx;
        const inLedger = !!onEdit;
        const step = err?.step ? ui.LOAD_STEPS.find(s => s.key === err.step)?.label || err.step : null;
        const acts = [];
        const retry = () => ui.button({ label: 'Retry', icon: 'refresh', size: 'sm', onClick: () => onRetry(spec) });
        const demo = () => (spec.kind === 'demo' || inLedger ? null : ui.button({ label: 'Use example data', icon: 'sun', size: 'sm', kind: 'ghost', onClick: () => this.switchTo('demo', true) }));
        const csv = () => (inLedger ? null : ui.button({ label: 'Upload a CSV instead', icon: 'upload', size: 'sm', kind: 'ghost', onClick: () => this.switchTo('csv') }));
        const manual = () => (inLedger ? null : ui.button({ label: 'Enter usage by hand', icon: 'pencil', size: 'sm', kind: 'ghost', onClick: () => this.switchTo('manual') }));
        const choices = Array.isArray(err?.choices) ? err.choices : [];
        if (err?.action === 'pickAccount' && choices.length) return this.picker(err, spec, choices, onRetry);
        if (inLedger && err?.action !== 'setPostcode') acts.push(ui.button({ label: editLabel, size: 'sm', onClick: onEdit }));
        switch (err?.action) {
            case 'checkKey':
                acts.push(ui.button({ label: 'Check your key', size: 'sm', onClick: () => this.gotoKey('key') }), demo());
                break;
            case 'pickAccount':
                acts.push(ui.button({ label: 'Check your account number', size: 'sm', onClick: () => this.gotoKey('account') }), demo());
                break;
            case 'setPostcode':
                acts.push(ui.button({ label: 'Set your postcode', size: 'sm', onClick: () => this.gotoPostcode() }), retry());
                break;
            case 'useDemo':
                if (err?.retryable) acts.push(retry());
                if (spec.kind === 'octopus') acts.push(csv(), manual());
                acts.push(demo());
                break;
            default:
                if (err?.retryable !== false) acts.push(retry());
                acts.push(demo());
        }
        return ui.h('div', { class: 'da-fail', role: 'alert' },
            step ? ui.h('div', { class: 'da-fail-step' }, `Stopped at: ${step}`) : null,
            ui.h('div', { class: 'da-fail-msg' }, ui.icon('alert'), ui.h('span', null, err?.message || 'Something went wrong while fetching your data.')),
            ui.h('div', { class: 'da-fail-acts' }, acts.filter(Boolean)));
    },

    /** Several accounts on one key, or several import meters on one property: pick one and carry on. */
    picker(err, spec, choices, onRetry) {
        const { ui } = this.ctx;
        const meters = choices.some(c => c && typeof c === 'object' && c.mpan);
        const name = ui.uniqueId('pick');
        let chosen = null;
        const opts = choices.map((c, i) => {
            const value = meters ? String(c.mpan) : typeof c === 'string' ? c : c?.value ?? c?.number ?? c?.id;
            if (!value) return null;
            const main = meters ? `Meter point ${value}` : value;
            const sub = meters ? (c.serials?.length ? `Meter serial${c.serials.length > 1 ? 's' : ''} ${c.serials.join(', ')}` : '') : (typeof c === 'object' && c?.label) || '';
            const radio = ui.h('input', { type: 'radio', name, value, on: { change: () => { chosen = value; go.disabled = false; } } });
            if (i === 0) { radio.checked = true; chosen = value; }
            return ui.h('li', null, ui.h('label', { class: 'da-pick-opt' }, radio,
                ui.h('span', null, ui.h('span', { class: 'da-pick-main' }, main), sub ? ui.h('span', { class: 'da-pick-sub' }, ` · ${sub}`) : null)));
        }).filter(Boolean);
        const go = ui.button({
            label: 'Continue', kind: 'primary', icon: 'arrowRight',
            onClick: () => {
                if (!chosen) return;
                if (meters) onRetry({ ...spec, mpan: chosen });
                else {
                    this.draft.account = chosen;
                    this.ctx.store.set({ connection: { accountNumber: chosen } });
                    const acctIn = this.el.querySelector('input[name="octopus-account"]');
                    if (acctIn) acctIn.value = chosen;
                    onRetry({ ...spec, accountNumber: chosen });
                }
            },
        });
        return ui.h('div', { class: 'da-pick', role: 'group', 'aria-label': meters ? 'Pick your electricity meter' : 'Pick your account' },
            ui.h('div', { class: 'da-pick-t' }, meters ? 'This home has more than one electricity meter — which one is yours?' : 'Your key can see more than one account — which one?'),
            ui.h('p', { class: 'field-hint' }, meters ? 'Pick the meter on your main supply — its serial number is printed on the meter itself.' : 'Pick the account for the home you want to analyse.'),
            ui.h('ul', { class: 'da-pick-list' }, opts),
            ui.h('div', null, go));
    },

    switchTo(mode, run = false) {
        if (this.busy) return;
        this.mode = mode;
        if (this.ctx.data.summary()) this.connectOpen = true;
        if (run && mode === 'demo') {
            this.render();
            this.connect({ kind: 'demo', serverW: this.draft.serverW || 500 });
            return;
        }
        this.render();
        requestAnimationFrame(() => this.el.querySelector('.da-source[aria-checked="true"]')?.focus());
    },

    /* ── loaded: the ledger ───────────────────────────────────────────────── */

    renderLoaded(summary, token) {
        const { ui, fmt, data } = this.ctx;
        let scrollTo = null;
        if (this.pendingEdit) {
            const editable = { prices: summary.source !== 'demo', location: summary.source !== 'demo', installed: ['octopus', 'csv'].includes(summary.source), servers: summary.source === 'demo', usage: summary.source === 'manual' };
            if (editable[this.pendingEdit]) { this.editing = this.pendingEdit; scrollTo = this.pendingEdit; }
            this.pendingEdit = null;
        }
        const conn = this.ctx.store.get().connection;
        const src = summary.source;
        const metered = src === 'octopus' || src === 'csv';
        const cov = summary.coverage || {};
        const wx = summary.weather || {};
        const counts = Array.isArray(wx.counts) ? wx.counts : [];
        const totalWx = counts.reduce((a, b) => a + (b || 0), 0);
        const satPct = totalWx ? (100 * ((counts[0] || 0) + (counts[1] || 0))) / totalWx : null;
        const filled = (cov.filledSlots || 0) + (cov.extrapolatedSlots || 0);
        // coverage.days is the window; how many of those days are real comes from realPct.
        const realDays = finite(cov.realPct) ? Math.round((summary.days * cov.realPct) / 100) : summary.days;
        const usageSub = src === 'manual' ? 'A typical year built from your two numbers'
            : src === 'demo' ? 'A synthetic household, every half-hour'
                : finite(cov.realPct) && cov.realPct < 90 ? `Only about ${fmt.num(realDays)} days are real readings; the rest is estimated`
                    : `${fmt.pct(cov.realPct)} real readings${filled ? ` · ${fmt.num(filled)} half-hours filled` : ''}`;
        const tiles = ui.h('div', { class: 'tiles' },
            ui.statTile({
                label: 'Usage', value: fmt.num(summary.days), unit: 'days', sub: usageSub,
                tone: metered && finite(cov.realPct) && cov.realPct < 90 ? 'warn' : 'default',
            }),
            ui.statTile({
                label: 'Always-on load', value: fmt.num(summary.baseLoadW), unit: 'W',
                sub: src === 'manual' && finite(conn.manual?.baseW) ? `You entered ${fmt.w(conn.manual.baseW)}; this is the profile’s quietest hours` : 'Median of each day’s four lowest half-hours',
            }),
            ui.statTile({
                label: 'Prices', value: this.priceShort(summary),
                sub: `${summary.source === 'demo' ? 'Real Agile half-hours' : BASIS_LABEL[summary.priceBasis] || 'Your prices'} · ${summary.regionName || `region ${summary.region}`}`,
            }),
            ui.statTile({
                label: 'Sunshine', value: satPct == null ? '—' : satPct >= 100 ? '100%' : fmt.pct(Math.min(satPct, 99.9), { dp: 1 }), unit: 'satellite',
                sub: wx.sarahLastMs ? `SARAH-3 to ${fmt.date(wx.sarahLastMs)}` : 'Half-hourly, for your home',
                tone: satPct != null && satPct < 95 ? 'warn' : 'default',
            }));

        const ledger = this.ledger(summary);
        // A profile built by hand has no readings to count; the example's are synthetic and say so.
        const monthsHost = src === 'manual' ? null : ui.h('div', null, ui.skeleton({ height: 220 }));
        const readings = monthsHost ? ui.card({
            title: 'Readings by month',
            subtitle: src === 'demo' ? 'Days in the example year — the household is synthetic, so every half-hour is there' : 'Days of real meter readings, and days we filled from similar days',
            body: monthsHost,
        }) : null;
        const sunshine = ui.card({ title: 'Where the sunshine came from', subtitle: 'Each half-hour’s irradiance, by source', body: this.sunshineBody(summary) });
        const device = ui.card({ title: 'Your key and this device', className: 'da-device-card', body: this.deviceBody(summary) });
        this.ledgerEl = ledger;
        this.el.replaceChildren(
            this.head(summary),
            ui.h('div', { class: 'stack' },
                tiles,
                ui.h('div', { class: 'grid-main' },
                    ui.card({ eyebrow: 'Details', title: 'Every choice we made for you', subtitle: 'Change any of them and we re-fetch from that step.', body: ledger }),
                    ui.h('div', { class: 'stack' }, readings, sunshine, device))));

        if (scrollTo) requestAnimationFrame(() => this.el.querySelector(`[data-row="${scrollTo}"]`)?.scrollIntoView({ block: 'center' }));
        // After a re-fetch from a ledger row, keyboard focus goes back to that row's button.
        if (this.focusRow) {
            const id = this.focusRow;
            this.focusRow = null;
            requestAnimationFrame(() => this.el.querySelector(`[data-row="${id}"] .da-act .btn`)?.focus({ preventScroll: true }));
        }

        if (!monthsHost) return;
        data.insights().then(ins => {
            if (token !== this.token) return;
            this.renderMonths(monthsHost, ins);
        }, err => {
            if (isAbort(err) || token !== this.token) return;
            monthsHost.replaceChildren(ui.h('div', { class: 'notice notice-warn' }, ui.icon('alert'), ui.h('span', null, err?.message || 'Couldn’t analyse the readings.')));
        });
    },

    renderMonths(host, ins) {
        const { ui, fmt, charts } = this.ctx;
        const hm = ins?.heatmap;
        if (!hm || !hm.dates?.length) { host.replaceChildren(ui.h('p', { class: 'muted' }, 'No readings to show.')); return; }
        const months = new Map();
        for (let d = 0; d < hm.days; d++) {
            const key = String(hm.dates[d]).slice(0, 7);
            let m = months.get(key);
            if (!m) { m = { real: 0, filled: 0 }; months.set(key, m); }
            for (let k = 0; k < 48; k++) {
                const i = d * 48 + k;
                if (Number.isFinite(hm.load[i])) m.real++;
                else if (hm.filled[i]) m.filled++;
            }
        }
        const keys = [...months.keys()];
        const demo = this.ctx.data.summary()?.source === 'demo';
        host.replaceChildren();
        this.charts.push(charts.createBars(host, {
            title: null, ariaLabel: demo ? 'Days of the synthetic example household in each month' : 'Days of real and filled meter readings in each month', stacked: true, height: 220,
            categories: keys,
            x: { label: 'Month', format: k => fmt.month(k).replace(/ \d{2}(\d{2})$/, ' ’$1'), tipFormat: k => fmt.month(k) },
            y: { label: 'days', format: v => fmt.num(v, v < 10 && v % 1 ? 1 : 0) },
            series: [
                { key: 'real', label: demo ? 'Example household' : 'Real readings', color: 'load', values: keys.map(k => months.get(k).real / 48) },
                { key: 'filled', label: 'Filled or estimated', color: 'muted', values: keys.map(k => months.get(k).filled / 48) },
            ],
        }));
    },

    sunshineBody(summary) {
        const { ui, fmt } = this.ctx;
        const wx = summary.weather || {};
        const counts = Array.isArray(wx.counts) ? wx.counts : [];
        const total = counts.reduce((a, b) => a + (b || 0), 0);
        const parts = WX_SOURCES.map((s, i) => ({ ...s, n: counts[i] || 0 })).filter(p => p.n > 0);
        const meter = this.meter(parts.map(p => ({ label: p.label, color: p.color, value: p.n, text: `${fmt.pct((100 * p.n) / total, { dp: (100 * p.n) / total < 1 ? 2 : 1 })} · ${fmt.num(p.n)}` })),
            'Share of half-hours by sunshine source');
        const notes = [];
        notes.push(ui.h('p', { class: 'da-hint' }, 'SARAH-3 is the 30-minute satellite record (about 3 days behind). The newest days come from the 15-minute MSG satellite; if neither has a half-hour, the ECMWF IFS weather model fills it, scaled by 0.93 because it reads about 7% high.'));
        if (wx.sarahLastMs) notes.push(ui.h('p', { class: 'da-hint' }, `Latest SARAH-3 half-hour: ${fmtSlot(wx.sarahLastMs)}.`));
        if (finite(wx.gridLat) && finite(wx.gridLon)) notes.push(ui.h('p', { class: 'da-hint' }, `Satellite grid cell ${fmt.num(wx.gridLat, 2)}°, ${fmt.num(wx.gridLon, 2)}° (about 5 km across).`));
        // weather.js's own notes already count the model half-hours; only a real share earns a warning.
        if (wx.ifsScaled && total && (counts[2] || 0) / total >= 0.01) {
            notes.push(ui.h('p', { class: 'da-hint is-warn' }, `${fmt.pct((100 * counts[2]) / total, { dp: 1 })} of half-hours had no satellite data and use the weather model, which is less accurate for any single hour.`));
        }
        for (const n of (wx.notes || []).filter(n => !/^Prices:|Weather data by/i.test(n))) notes.push(ui.h('p', { class: 'da-hint' }, n));
        return total ? [meter, ...notes] : ui.h('p', { class: 'muted' }, 'No weather details for this dataset.');
    },

    /** A proportion bar; its legend prints every value, so nothing is hover-only. */
    meter(parts, label) {
        const { ui } = this.ctx;
        const total = parts.reduce((a, p) => a + p.value, 0) || 1;
        return ui.h('div', null,
            ui.h('div', { class: 'da-meter', role: 'img', 'aria-label': `${label}: ${parts.map(p => `${p.label} ${p.text}`).join('; ')}` },
                parts.map(p => ui.h('span', { style: { flex: `${p.value / total} 1 0`, background: p.color }, title: `${p.label}: ${p.text}` }))),
            ui.h('ul', { class: 'da-legend', 'aria-hidden': 'true' },
                parts.map(p => ui.h('li', null, ui.h('i', { style: { background: p.color } }), p.label, ui.h('b', null, p.text)))));
    },

    deviceBody(summary) {
        const { ui, store } = this.ctx;
        let key = null;
        try { key = store.getApiKey(); } catch { key = null; }
        const conn = store.get().connection;
        const state = !key ? 'No Octopus API key is stored in this browser.'
            : conn.rememberKey ? 'Your API key is remembered on this device until you forget it.'
                // sessionStorage, not memory: a browser that restores tabs (Ctrl+Shift+T, "continue where
                // you left off") restores it too, and app.js reconnects with it — so don't promise "forgotten"
                : 'Your API key is kept in this tab’s session storage, not remembered on this device. Closing the tab usually clears it, but a browser that restores tabs can bring it back — use Forget my key to remove it now.';
        // data-fk: refreshDevice() rebuilds the card, and focus goes back to the same control
        const fk = (el, k) => { el.dataset.fk = k; return el; };
        const acts = [];
        if (key) {
            acts.push(fk(ui.toggle({
                label: 'Remember my key on this device', checked: !!conn.rememberKey,
                onChange: v => { store.setApiKey(key, v); ui.toast(v ? 'Your key will be remembered on this device.' : 'Your key is no longer remembered on this device — it’s kept in this tab’s session storage.', { tone: 'good' }); this.refreshDevice(); },
            }), 'dev-remember'));
        }
        const btns = [];
        if (key) {
            btns.push(fk(ui.button({
                label: 'Forget my key', icon: 'x', size: 'sm',
                onClick: () => {
                    store.clearApiKey();
                    store.set({ connection: { rememberKey: false } });
                    ui.toast('Your API key has been removed from this browser. The data already loaded stays until you leave.', { tone: 'good', timeoutMs: 6000 });
                    this.refreshDevice();
                },
            }), 'dev-forget-key'));
        }
        btns.push(fk(ui.button({ label: 'Forget this device…', size: 'sm', kind: 'danger', onClick: () => this.forgetDevice() }), 'dev-forget-device'));
        return ui.h('div', { class: 'da-device' },
            ui.h('div', { class: 'da-device-state' }, ui.icon('lock'), ui.h('span', null, state)),
            acts.length ? acts : null,
            ui.h('div', { class: 'da-device-acts' }, btns),
            ui.h('p', { class: 'da-hint' }, 'To also clear your settings and saved scenarios, use ', ui.h('a', { href: '#method?s=reset' }, 'Method → Reset everything'), '.'));
    },

    /**
     * Rebuild the device card after a change (ui.keepFocus): focus goes back to the rebuilt twin of
     * the control that was pressed, or — when that control has gone (Forget my key) — the card's
     * first control. After the "Forget this device" dialog, focus that fell to <body> lands there too.
     */
    refreshDevice() {
        const { ui } = this.ctx;
        const host = this.el.querySelector('.da-device');
        const s = this.ctx.data.summary();
        if (!host || !s) return;
        const fresh = this.deviceBody(s);
        const first = () => fresh.querySelector('input, button');
        if (host.parentElement) ui.keepFocus(host.parentElement, () => host.replaceWith(fresh), null, { fallback: first });
        else host.replaceWith(fresh);
        requestAnimationFrame(() => {
            const a = document.activeElement;
            if (a && a !== document.body && a.isConnected && !a.closest('dialog')) return;
            first()?.focus({ preventScroll: true });
        });
    },

    /**
     * Rebuild the device card in place, without moving focus: for a change made elsewhere (a key
     * Octopus rejected is dropped while the user is in a form or editor, not on this card).
     */
    paintDevice() {
        const host = this.el?.querySelector('.da-device');
        const s = this.ctx.data.summary();
        if (!host || !s || host.contains(document.activeElement)) return;
        host.replaceWith(this.deviceBody(s));
    },

    forgetDevice() {
        const { ui, store } = this.ctx;
        ui.modal({
            title: 'Forget this device?',
            body: [
                ui.h('p', null, 'This removes your Octopus API key, account number, meter, postcode and existing-solar date from this browser, and deletes the cached weather and price downloads.'),
                ui.h('p', { style: { marginTop: '10px' } }, 'Your saved scenarios and assumptions stay. The data on screen stays until you close the tab.'),
            ],
            actions: [
                { label: 'Cancel' },
                {
                    label: 'Forget this device', danger: true,
                    onClick: () => {
                        store.clearApiKey();
                        store.set({ connection: { accountNumber: null, rememberKey: false, location: { postcode: null, lat: null, lon: null }, installedSolarDate: null, mpan: null } });
                        this.draft.key = '';
                        this.draft.account = '';
                        this.draft.postcode = '';
                        this.draft.lat = null;
                        this.draft.lon = null;
                        this.draft.installed = '';
                        deleteCacheDb().then(() => ui.toast('This device has forgotten your key, account and cached downloads.', { tone: 'good', timeoutMs: 6000 }));
                        this.refreshDevice();
                    },
                },
            ],
        });
    },

    /** The provenance ledger: one row per automatic choice, with an inline editor where it can change. */
    ledger(summary) {
        const { ui, fmt, store } = this.ctx;
        const conn = store.get().connection;
        const src = summary.source;
        const canRefetch = src !== 'demo';
        const rows = [];
        const row = (id, key, value, hint, editable, editor) => {
            const open = this.editing === id && editable;
            const edId = `da-ed-${id}`;
            const act = editable ? ui.button({
                label: open ? 'Close' : 'Change', size: 'sm', kind: 'ghost',
                // Every row's button reads "Change": the accessible name says which choice.
                ariaLabel: `${open ? 'Close' : 'Change'} ${key.toLowerCase()}`,
                onClick: () => { if (this.busy) return; if (open) this.closeEditor(id); else this.openEditor(id); },
            }) : null;
            if (act) { act.setAttribute('aria-expanded', String(open)); act.setAttribute('aria-controls', edId); act.dataset.fk = `row-${id}`; }
            rows.push(ui.h('div', { class: 'da-row', dataset: { row: id } },
                ui.h('div', { class: 'da-key' }, key),
                ui.h('div', { class: 'da-val' }, value, hint ? (Array.isArray(hint) ? hint : [hint]).filter(Boolean).map(x => (x instanceof Node ? x : ui.h('div', { class: 'da-hint' }, x))) : null),
                ui.h('div', { class: 'da-act' }, act),
                open ? ui.h('div', { class: 'da-editor', id: edId }, editor()) : null));
        };

        // Source
        const srcHint = {
            octopus: 'Half-hourly readings from your smart meter via the Octopus API.',
            demo: 'Real London prices and sunshine with a synthetic household. Your own data replaces it completely.',
            csv: mem.csv?.text ? 'Read from the file in your browser.' : 'Files aren’t kept between visits — upload it again to change anything below.',
            manual: 'A typical household’s daily shape, scaled to your two numbers below. No meter readings are used.',
        }[src];
        rows.push(ui.h('div', { class: 'da-row' },
            ui.h('div', { class: 'da-key' }, 'Source'),
            ui.h('div', { class: 'da-val' }, this.sourceLine(summary), ui.h('div', { class: 'da-hint' }, srcHint)),
            ui.h('div', { class: 'da-act' })));

        if (src === 'manual') {
            row('usage', 'Usage', `${fmt.w(conn.manual?.baseW)} always on + ${fmt.kwh(conn.manual?.otherKwhYr)} a year of everything else`,
                'Change either number and the profile is rebuilt.', true, () => this.usageEditor());
        }
        if (src === 'demo') {
            row('servers', 'Servers', fmt.w(summary.serverW ?? conn.demoServerW ?? 500), 'Always-on load added to the example household. Try your own figure.', true, () => this.demoEditor(summary));
        }

        // Location
        const where = summary.postcode
            ? [ui.h('span', null, summary.postcode), ' ', ui.h('span', { class: 'mono' }, `${fmt.num(summary.lat, 4)}, ${fmt.num(summary.lon, 4)}`)]
            : ui.h('span', { class: 'mono' }, `${fmt.num(summary.lat, 4)}, ${fmt.num(summary.lon, 4)}`);
        const locWarn = summary.locationSource === 'region-centroid';
        row('location', 'Location', where,
            ui.h('div', { class: ['da-hint', locWarn && 'is-warn'] }, LOCATION_SOURCE[summary.locationSource] || 'Used for the sun’s path and the satellite sunshine.'),
            canRefetch, () => this.locationEditor(summary));

        // Region
        rows.push(ui.h('div', { class: 'da-row' },
            ui.h('div', { class: 'da-key' }, 'Region'),
            ui.h('div', { class: 'da-val' }, ui.h('span', { class: 'mono' }, summary.region || '?'), ' · ', summary.regionName || REGIONS[summary.region] || 'Unknown',
                ui.h('div', { class: 'da-hint' }, src === 'octopus' ? 'From your tariff code — it sets which regional Agile prices apply.' : 'Sets which regional Agile and export prices apply.')),
            ui.h('div', { class: 'da-act' })));

        // Period
        // coverage.days counts the whole window, so real days come from the share of real half-hours.
        const realDays = finite(summary.coverage?.realPct) ? (summary.days * summary.coverage.realPct) / 100 : summary.days;
        rows.push(ui.h('div', { class: 'da-row' },
            ui.h('div', { class: 'da-key' }, 'Period'),
            ui.h('div', { class: 'da-val' }, `${fmt.date(isoDay(summary.from))} – ${fmt.date(isoDay(summary.to))}`, ' ', ui.h('span', { class: 'mono' }, `${fmt.num(summary.days)} days`),
                ui.h('div', { class: 'da-hint' }, src === 'demo' ? 'The year the example prices and sunshine were recorded.'
                    : src === 'manual' ? 'A typical year ending a few days ago, so the prices and sunshine are recent.'
                        : `The latest 365 complete days with readings${conn.installedSolarDate ? ', ending before your existing solar' : ''}${realDays < 330 ? ' — shorter histories are filled in from the nearest weeks' : ''}.`)),
            ui.h('div', { class: 'da-act' })));

        // Prices
        const tariffs = summary.tariffs || [];
        const tariffList = tariffs.length ? ui.h('ul', { class: 'da-tariffs' }, tariffs.slice(-6).map(t => ui.h('li', null,
            `${tariffName(t.code)} `, ui.h('span', null, `${t.code} · ${fmt.date(t.fromMs, { year: true })} – ${fmt.date(Math.max(t.fromMs, (t.toMs ?? t.fromMs) - 1), { year: true })}${t.assumed ? ' · assumed' : ''}`)))) : null;
        const basisValue = src === 'demo' ? 'Agile Octopus, London' : BASIS_LABEL[summary.priceBasis] || summary.priceBasis || '—';
        row('prices', 'Prices', basisValue,
            [ui.h('div', { class: 'da-hint' }, src === 'demo' ? 'Real Agile half-hourly prices for London.' : BASIS_HINT[summary.priceBasis] || ''),
                tariffList,
                ui.h('div', { class: 'da-hint' }, FORWARD_HINT[src === 'demo' ? 'agile' : summary.priceBasis] || FORWARD_HINT.mine,
                    ui.h('a', { href: '#method?s=prices' }, 'How prices are valued'), '.')],
            canRefetch, () => this.pricesEditor(summary));

        // Existing solar
        if (src === 'octopus' || src === 'csv') {
            // The account's own readings can say when solar went in: name the sign, and the editor
            // opens with that date filled in.
            const sug = suggestedInstall(summary, conn, ms => fmt.date(ms));
            row('installed', 'Existing solar', conn.installedSolarDate ? `Installed ${fmt.date(isoDay(conn.installedSolarDate))}` : sug ? 'None set' : 'None',
                conn.installedSolarDate ? 'Readings from that date on are left out, because they are net of your own generation.'
                    : sug ? `${sug.why ? `${sug.why} If solar or a battery went in around then` : `If solar or a battery went in around ${fmt.date(isoDay(sug.date))}`}, tell us when — the date is filled in for you.`
                        : 'If you already have panels or a battery, tell us when they went in — readings after that undercount your real use.',
                true, () => this.installedEditor(summary));
        }

        // Coverage
        const cov = summary.coverage || {};
        const n = summary.n || 1;
        const filledN = cov.filledSlots || 0, extN = cov.extrapolatedSlots || 0;
        const realN = Math.max(0, n - filledN - extN);
        const covParts = [
            { label: 'Real readings', color: 'var(--series-load)', value: realN, text: fmt.pct((100 * realN) / n, { dp: realN / n > 0.995 ? 0 : 1 }) },
            { label: 'Filled from similar days', color: 'var(--series-muted)', value: filledN, text: `${fmt.num(filledN)} half-hours` },
            { label: 'Estimated (outside your readings)', color: 'var(--faint)', value: extN, text: `${fmt.num(extN)} half-hours` },
        ].filter(p => p.value > 0);
        // A built profile (by hand, or the example household) has no meter readings to count.
        const coverageVal = src === 'manual'
            ? ['No meter readings — a typical profile', ui.h('div', { class: 'da-hint' }, 'Every half-hour comes from the profile built from your numbers, so there are no gaps to fill. Savings are an estimate of a typical home with your totals, not of your actual days.')]
            : src === 'demo'
                ? ['A synthetic household — no meter readings', ui.h('div', { class: 'da-hint' }, 'The example household’s usage is generated for every half-hour; the prices and the sunshine are real.')]
                : [`${fmt.pct(cov.realPct, { dp: cov.realPct > 99.5 ? 0 : 1 })} of half-hours are real readings`,
                    this.meter(covParts, 'Half-hours by kind'),
                    ui.h('div', { class: 'da-hint' }, filledN + extN === 0 ? 'Every half-hour in the period has a reading.'
                        : 'Gaps are filled from the same half-hour on similar days nearby (never with zeros). Usage figures only use real readings; savings use the filled year.')];
        rows.push(ui.h('div', { class: 'da-row' },
            ui.h('div', { class: 'da-key' }, 'Coverage'),
            ui.h('div', { class: 'da-val' }, coverageVal),
            ui.h('div', { class: 'da-act' })));

        // Notes
        const notes = (summary.notes || []).filter(Boolean);
        if (notes.length) {
            rows.push(ui.h('div', { class: 'da-row' },
                ui.h('div', { class: 'da-key' }, 'Notes'),
                ui.h('div', { class: 'da-val' }, ui.h('ul', { class: 'da-notes' }, notes.slice(0, 8).map(t => ui.h('li', null, t)))),
                ui.h('div', { class: 'da-act' })));
        }
        return ui.h('div', { class: 'da-ledger', 'aria-live': 'polite' }, rows);
    },

    /**
     * Rebuild the ledger in place. An open editor gets focus on its first field; with no editor
     * open, focus goes back to `focusRow`'s Change button (the control that closed it is gone).
     */
    rerenderLedger({ focusRow = null } = {}) {
        const s = this.ctx.data.summary();
        if (!s || !this.ledgerEl) { this.render(); return; }
        this.maps.forEach(m => { try { m.destroy(); } catch { /* gone */ } });
        this.maps = [];
        const fresh = this.ledger(s);
        const old = this.ledgerEl;
        const swap = () => { old.replaceWith(fresh); this.ledgerEl = fresh; };
        // ui.keepFocus: an open editor's first field, else the row asked for, else the rebuilt twin
        // of whatever had focus in the ledger (row buttons carry data-fk)
        const target = () => fresh.querySelector('.da-editor')?.querySelector('input, select, button')
            ?? (focusRow ? fresh.querySelector(`[data-row="${focusRow}"] .da-act .btn`) : null);
        if (old.parentElement) this.ctx.ui.keepFocus(old.parentElement, swap, target, { preventScroll: false });
        else swap();
    },

    /** Close an editor without changing anything: the draft goes back to what is loaded. */
    closeEditor(id = this.editing) {
        this.editing = null;
        this.syncDraft();
        this.rerenderLedger({ focusRow: id });
    },

    /** Reset the editable draft to the stored connection, so an abandoned edit can't leak into later forms. */
    syncDraft() {
        const c = this.ctx.store.get().connection;
        const s = this.ctx.data.summary();
        const d = this.draft;
        d.postcode = c.location?.postcode || '';
        d.lat = c.location?.lat ?? null;
        d.lon = c.location?.lon ?? null;
        d.basis = (s && s.source !== 'demo' ? s.priceBasis : null) || c.priceBasis || 'mine';
        d.flatP = c.flatP ?? 25;
        d.installed = c.installedSolarDate || '';
        d.installedHinted = false;          // the existing-solar editor may fill in a suggested date again
        d.region = c.region || '';
        d.serverW = s?.source === 'demo' ? s.serverW ?? c.demoServerW ?? 500 : c.demoServerW || 500;
        d.baseW = c.manual?.baseW ?? 400;
        d.otherKwhYr = c.manual?.otherKwhYr ?? 2700;
    },

    editorActions(label, onApply) {
        const { ui } = this.ctx;
        return ui.h('div', { class: 'da-editor-acts' },
            ui.button({ label, kind: 'primary', icon: 'refresh', onClick: onApply }),
            ui.button({ label: 'Cancel', kind: 'ghost', onClick: () => this.closeEditor() }));
    },

    demoEditor() {
        const { ui, fmt } = this.ctx;
        const d = this.draft;
        const box = ui.h('div', { class: 'stack-sm' });
        box.append(
            ui.field({
                label: 'Servers in the example home',
                input: ui.slider({ value: d.serverW, min: 0, max: 2000, step: 50, ariaLabel: 'Server load', format: v => fmt.w(v), onInput: v => { d.serverW = v; }, onChange: v => { d.serverW = v; } }),
            }),
            this.editorActions('Reload the example', () => this.refetch({ kind: 'demo', serverW: d.serverW }, box, { row: 'servers', editLabel: 'Try another figure' })));
        return box;
    },

    locationEditor(summary) {
        const { ui } = this.ctx;
        const d = this.draft;
        if (!d.postcode && summary.postcode && summary.locationSource !== 'region-centroid') d.postcode = summary.postcode;
        const box = ui.h('div', { class: 'stack-sm' });
        box.append(
            this.locationFields({ withRegion: summary.source !== 'octopus', required: summary.source !== 'octopus' }),
            this.editorActions('Use this location', () => {
                const loc = this.locationSpec();
                if (!loc && summary.source !== 'octopus') { ui.toast('Enter a postcode or drop a pin first.', { tone: 'warn' }); return; }
                // CSV / by hand: the region picked here goes with the new location ('' = work it out)
                const over = summary.source === 'octopus' ? { location: loc } : { location: loc, region: d.region || null };
                this.refetch(over, box, { row: 'location', editLabel: 'Try another postcode' });
            }));
        return box;
    },

    pricesEditor(summary) {
        const d = this.draft;
        const box = this.ctx.ui.h('div', { class: 'stack-sm' });
        box.append(this.basisFields(summary.source), this.editorActions('Re-price my usage', () => {
            const o = { priceBasis: d.basis };
            if (d.basis === 'flat') o.flatP = d.flatP;
            this.refetch(o, box, { row: 'prices', editLabel: 'Pick another price' });
        }));
        return box;
    },

    /** Manual source: the two numbers the profile is built from. */
    usageEditor() {
        const { ui, fmt } = this.ctx;
        const d = this.draft;
        const sum = ui.h('div', { class: 'da-sum', 'aria-live': 'polite' });
        const paint = () => {
            const base = Math.max(0, d.baseW || 0), other = Math.max(0, d.otherKwhYr || 0);
            sum.replaceChildren('About ', ui.h('b', null, fmt.kwh(base * 8.76 + other)), ' a year in total.');
        };
        paint();
        const box = ui.h('div', { class: 'stack-sm' });
        box.append(
            ui.h('div', { class: 'da-form-2' },
                ui.field({ label: 'Always-on load', hint: 'Watts, around the clock.', input: ui.numberInput({ value: d.baseW, min: 0, max: 5000, step: 10, unit: 'W', onChange: v => { d.baseW = v; paint(); } }) }),
                ui.field({ label: 'Everything else per year', hint: 'A typical home uses 2,700 kWh before any servers.', input: ui.numberInput({ value: d.otherKwhYr, min: 0, max: 30000, step: 100, unit: 'kWh', onChange: v => { d.otherKwhYr = v; paint(); } }) })),
            sum,
            this.editorActions('Rebuild my profile', () => {
                if (!(d.baseW > 0 || d.otherKwhYr > 0)) { ui.toast('Enter your always-on load or your other yearly use.', { tone: 'warn' }); return; }
                this.refetch({ baseW: d.baseW || 0, otherKwhYr: d.otherKwhYr || 0 }, box, { row: 'usage', editLabel: 'Change the numbers' });
            }));
        return box;
    },

    installedEditor(summary = this.ctx.data.summary()) {
        const { ui, fmt } = this.ctx;
        const d = this.draft;
        const conn = this.ctx.store.get().connection;
        const had = conn.installedSolarDate;
        const opts = { row: 'installed', editLabel: 'Pick another date' };
        // No date set but the account's readings suggest one: fill it in once per opening (a date
        // the user then clears stays cleared through re-renders).
        const sug = suggestedInstall(summary, conn, ms => fmt.date(ms));
        if (sug && !d.installed && !d.installedHinted) d.installed = sug.date;
        d.installedHinted = true;
        // (the row above names the sign; this only says where the date came from)
        const box = ui.h('div', { class: 'stack-sm' },
            sug ? ui.h('div', { class: 'da-hint' }, `The date below is filled in from your account — change it if your solar or battery went in on another day.`) : null);
        box.append(this.installedField(), ui.h('div', { class: 'da-editor-acts' },
            ui.button({ label: 'Re-fetch my usage', kind: 'primary', icon: 'refresh', onClick: () => this.refetch({ installedSolarDate: d.installed || null }, box, opts) }),
            had ? ui.button({ label: 'I have no solar', kind: 'ghost', onClick: () => { d.installed = ''; this.refetch({ installedSolarDate: null }, box, opts); } }) : null,
            ui.button({ label: 'Cancel', kind: 'ghost', onClick: () => this.closeEditor() })));
        return box;
    },

    /**
     * Build the spec to re-fetch the current source with some choices changed. Returns null (and
     * explains) when something needed isn't to hand: the key for Octopus, the file for a CSV.
     * With quiet, it only returns null — used to compare a change against what is loaded.
     * @param {object} over  choices to change (location, priceBasis, flatP, installedSolarDate, serverW,
     *   baseW, otherKwhYr, and from a picker: mpan, accountNumber)
     * @param {{ quiet?: boolean }} [o]
     */
    specFor(over, { quiet = false } = {}) {
        const { store, data, ui } = this.ctx;
        const conn = store.get().connection;
        const summary = data.summary();
        const kind = over.kind || summary?.source || conn.kind;
        if (kind === 'demo') return { kind: 'demo', serverW: over.serverW ?? summary?.serverW ?? conn.demoServerW ?? 500 };
        const prevLoc = conn.location?.postcode ? { postcode: conn.location.postcode }
            : finite(conn.location?.lat) && finite(conn.location?.lon) ? { lat: conn.location.lat, lon: conn.location.lon } : null;
        const location = 'location' in over ? over.location : prevLoc;
        // The basis on screen wins over the stored one: they differ when a reload couldn't repeat it.
        const shown = summary && summary.source === kind ? summary.priceBasis : null;
        const basis = over.priceBasis ?? shown ?? conn.priceBasis ?? (kind === 'octopus' ? 'mine' : 'agile');
        const flatP = over.flatP ?? conn.flatP;
        const installed = 'installedSolarDate' in over ? over.installedSolarDate : conn.installedSolarDate;
        let spec;
        if (kind === 'octopus') {
            let key = null;
            try { key = store.getApiKey(); } catch { key = null; }
            if (!key) {
                if (quiet) return null;
                ui.toast('Paste your API key again to re-fetch — it wasn’t remembered on this device.', { tone: 'warn', timeoutMs: 7000 });
                this.gotoKey('key');
                return null;
            }
            spec = { kind: 'octopus', apiKey: key };
            const acct = over.accountNumber || conn.accountNumber;
            if (acct) spec.accountNumber = acct;
            // the meter picked last time belongs to the stored account; a picker's choice wins
            const mpan = over.mpan ?? ((acct ?? null) === (conn.accountNumber ?? null) ? conn.mpan : null);
            if (mpan) spec.mpan = String(mpan);
        } else if (kind === 'csv') {
            if (!mem.csv?.text) {
                if (quiet) return null;
                ui.toast('Upload the file again to change this — files aren’t kept between visits.', { tone: 'warn', timeoutMs: 7000 });
                this.connectOpen = true;
                this.mode = 'csv';
                this.editing = null;
                this.render();
                return null;
            }
            spec = { kind: 'csv', text: mem.csv.text };
        } else if (kind === 'manual') {
            spec = { kind: 'manual', baseW: over.baseW ?? conn.manual?.baseW ?? 400, otherKwhYr: over.otherKwhYr ?? conn.manual?.otherKwhYr ?? 2700 };
        } else return null;
        if (location) spec.location = location;
        else if (kind !== 'octopus') spec.location = { lat: summary?.lat, lon: summary?.lon };
        // a region chosen by hand (CSV / by hand): the editor's choice, else the one loaded
        const region = 'region' in over ? over.region : conn.region;
        if (kind !== 'octopus' && region) spec.region = region;
        if (basis && !(kind === 'octopus' && basis === 'mine')) spec.priceBasis = basis;
        if (basis === 'flat' && finite(flatP)) spec.flatP = flatP;
        if (installed && kind !== 'manual') spec.installedSolarDate = installed;
        return spec;
    },

    /**
     * Re-fetch with some choices changed, from the ledger. The old figures stay (dimmed) meanwhile.
     * A failure leaves the loaded data alone and offers to change the value again (onEdit).
     * @param {object} over  see specFor
     * @param {HTMLElement} box  the editor body (replaced by the progress list)
     * @param {{ row?: string, editLabel?: string }} [o]  the ledger row, and the label of its "edit again" action
     */
    async refetch(over, box, { row = this.editing, editLabel = 'Change it' } = {}) {
        const { ui, data, store } = this.ctx;
        if (this.busy) return;
        const spec = this.specFor(over);
        if (!spec) return;
        // Nothing would change: close the editor rather than download everything again.
        const current = this.specFor({}, { quiet: true });
        if (current && specKey(current) === specKey(spec)) {
            ui.toast('Nothing to change — that’s what is loaded already.');
            this.closeEditor(row);
            return;
        }
        const pl = ui.progressList(ui.loadStepsFor(spec.kind));
        box.replaceChildren(ui.h('div', { class: 'da-run-box', 'aria-live': 'polite' }, pl.el));
        const rows = [...(this.ledgerEl?.querySelectorAll('.da-row') || [])].filter(r => !r.contains(box));
        rows.forEach(r => r.classList.add('da-stale'));
        this.el.querySelectorAll('.tiles, .grid-main > .stack').forEach(x => x.classList.add('da-stale'));
        this.busy = true;
        const state = { failed: null };
        try {
            await data.load(spec, { navigate: false, onProgress: this.progressHandler(pl, state) });
            const extra = this.extraConnection(spec);
            if ('location' in over && !over.location && spec.kind === 'octopus') extra.location = { postcode: null, lat: null, lon: null };
            store.set({ connection: extra });
            this.editing = null;
            this.busy = false;
            this.focusRow = row;
            this.syncDraft();
            this.render();
            ui.toast('Updated. Every result will use the new data.', {
                tone: 'good', timeoutMs: 6000, action: { label: 'See the verdict', onClick: () => this.ctx.router.go('verdict') },
            });
        } catch (err) {
            this.busy = false;
            if (isAbort(err)) { this.render(); return; }
            rows.forEach(r => r.classList.remove('da-stale'));
            this.el.querySelectorAll('.da-stale').forEach(x => x.classList.remove('da-stale'));
            // a key Octopus rejected is dropped from storage (DataHub.load): the device card says so
            if (err?.code === 'AUTH') this.paintDevice();
            pl.settle(state.failed || err?.step || null);
            const panel = this.failure(err, spec, {
                // A picker's choice (meter or account) comes back in the spec it retries with.
                onRetry: s => this.refetch({ ...over, ...(s?.mpan ? { mpan: s.mpan } : {}), ...(s?.accountNumber ? { accountNumber: s.accountNumber } : {}) }, box, { row, editLabel }),
                onEdit: () => this.openEditor(row, { keepDraft: true }),
                editLabel,
            });
            box.appendChild(panel);
            box.appendChild(ui.h('div', { class: 'da-editor-acts' },
                ui.button({ label: 'Keep my current data', kind: 'ghost', onClick: () => this.closeEditor(row) })));
            this.reveal(panel);
        } finally {
            this.busy = false;
            // Status events while busy only asked for a re-render; success already rendered, and a
            // re-render after a failure would throw away the failure panel.
            this.pending = false;
        }
    },
};
