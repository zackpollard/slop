/*
 * charts.js — canvas chart primitives (contract §20).
 *
 * Every chart: `create<Type>(el, spec) → { update(spec), destroy(), setTable(bool) }`.
 * Shared behaviour lives in `Chart`: DPR-correct canvas, ResizeObserver, an HTML tooltip layer
 * (values lead, labels follow), keyboard exploration (arrow keys move the hover; T toggles the
 * table), and a table-view twin so no value is ever hover-only. Colours come from CSS custom
 * properties (series tokens in css/style.css), so a chart never hard-codes a hex.
 *
 * Mark specs follow the dataviz rules: 2px lines, ≤24px bars with a 4px rounded data end and a
 * square baseline, ≥8px dots with a 2px surface ring, 2px surface gaps between touching fills,
 * hairline solid gridlines, one y-axis only — there is deliberately no way to ask for a second.
 *
 * Series `color` may be a token key ('pv', 'load', 'import', 'export', 'battery', 'price',
 * 'clipped', 'muted', route keys 'plugin'|'hardwired'|'ups'|'whatif'|'reference', 'cat1'…'cat8'),
 * a custom property ('--series-pv') or a literal CSS colour. Missing colours take cat1…cat8 in
 * order (never cycled past 8 — fold the tail into "Other" upstream).
 */

import { h, fmt, icon, table as uiTable } from './ui.js';

const live = new Set();
let printingNow = false;
const SERIES_KEYS = new Set(['pv', 'load', 'import', 'export', 'battery', 'price', 'clipped', 'muted']);
const ROUTE_KEYS = new Set(['plugin', 'hardwired', 'ups', 'whatif', 'reference']);
const ROUTE_LABELS = { plugin: 'Plug-in', hardwired: 'Electrician-installed', ups: 'Power station', whatif: 'Future rules', reference: 'Reference' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const LABEL_ROW_H = 18;   // a horizontal bar's name on its own line above the bar (narrow screens)
const MONO = (size, weight = 500) => `${weight} ${size}px "JetBrains Mono", ui-monospace, monospace`;
const SANS = (size, weight = 500) => `${weight} ${size}px Inter, system-ui, sans-serif`;
const finite = v => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ── scales & colour ────────────────────────────────────────────────────────── */

function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range));
    const f = range / 10 ** exp;
    const nf = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10);
    return nf * 10 ** exp;
}

/**
 * Round a data extent to clean tick values (1/2/5 × 10ⁿ).
 * @param {number} min @param {number} max @param {number} [count] target tick count
 * @returns {{ min: number, max: number, step: number, ticks: number[] }}
 */
export function niceScale(min, max, count = 5) {
    if (!finite(min) || !finite(max)) { min = 0; max = 1; }
    if (min > max) [min, max] = [max, min];
    if (min === max) {
        const d = min === 0 ? 1 : Math.abs(min) * 0.1;
        min -= min === 0 ? 0 : d;
        max += d;
    }
    // Step from the raw span (not a pre-rounded one): a 380–920 kWh axis should tick 200…1,000, not 0…1,000.
    const step = niceNum((max - min) / Math.max(1, count - 1), true);
    const lo = Math.floor(min / step + 1e-9) * step;
    const hi = Math.ceil(max / step - 1e-9) * step;
    if (!finite(step) || step <= 0 || !finite(lo) || !finite(hi)) return { min, max, step: max - min || 1, ticks: [min, max] };
    // Ticks by index, not by accumulating `v += step`: at large magnitudes (or a step below the
    // float spacing) the sum stops moving and the loop never ends. The cap is a backstop.
    const ticks = [];
    const nTicks = Math.min(200, Math.round((hi - lo) / step));
    for (let i = 0; i <= nTicks; i++) ticks.push(+(lo + i * step).toFixed(10));
    return { min: lo, max: hi, step, ticks };
}

const autoFormat = step => v => fmt.num(v, Math.max(0, Math.min(4, -Math.floor(Math.log10(step) + 1e-9))));

/**
 * A nice scale for a value axis that runs across the plot (tornado, horizontal bars), with only as
 * many tick labels as fit side by side along `plotW` px. The scale keeps its tight domain and its
 * gridlines; labels are thinned to every 2nd or 3rd tick (always including 0 when it is a tick).
 * Only if that isn't enough does it fall back to fewer, coarser ticks.
 * @param {number} min @param {number} max @param {number} plotW
 * @param {(v: number) => number} widthOf label width in px for a tick value
 * @param {{ maxCount?: number, gap?: number }} [opts]
 * @returns {{ min: number, max: number, step: number, ticks: number[], show: boolean[] }} show[i]: label tick i
 */
export function fitTicks(min, max, plotW, widthOf, { maxCount = 5, gap = 12 } = {}) {
    for (let count = maxCount; count >= 2; count--) {
        const hit = labelEvery(niceScale(min, max, count), plotW, widthOf, gap, [1, 2, 3]);
        if (hit) return hit;
    }
    const sc = niceScale(min, max, 2);
    return { ...sc, show: sc.ticks.map((_, i) => i === 0 || i === sc.ticks.length - 1) };
}

/* Label every k-th tick of `sc` (counted from 0 when it is a tick) for the smallest k in `ks` whose
   labels don't collide along plotW px; null when none fits. */
function labelEvery(sc, plotW, widthOf, gap, ks) {
    const span = sc.max - sc.min || 1;
    const pos = sc.ticks.map(v => ((v - sc.min) / span) * plotW);
    const w = sc.ticks.map(widthOf);
    const zero = sc.ticks.findIndex(v => Math.abs(v) < 1e-9);
    const anchor = zero >= 0 ? zero : 0;
    for (const k of ks) {
        const show = sc.ticks.map((_, i) => (i - anchor) % k === 0);
        const idx = show.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
        let fits = idx.length >= 2 || sc.ticks.length < 2;
        for (let j = 1; j < idx.length && fits; j++) {
            const a = idx[j - 1], b = idx[j];
            if (pos[b] - pos[a] < (w[a] + w[b]) / 2 + gap) fits = false;
        }
        if (fits) return { ...sc, show };
    }
    return null;
}

/**
 * Thin the labels of a scale whose domain is fixed (a chart with explicit y.min / y.max): the ticks
 * and gridlines stay, only every 2nd, 3rd, 4th or 6th label is kept (0 always, when it is a tick),
 * or just the two ends when even that collides.
 * @param {{ min: number, max: number, step: number, ticks: number[] }} sc
 * @param {number} plotW @param {(v: number) => number} widthOf
 * @param {{ gap?: number }} [opts]
 * @returns {{ min: number, max: number, step: number, ticks: number[], show: boolean[] }}
 */
export function thinScaleLabels(sc, plotW, widthOf, { gap = 12 } = {}) {
    return labelEvery(sc, plotW, widthOf, gap, [1, 2, 3, 4, 6])
        ?? { ...sc, show: sc.ticks.map((_, i) => i === 0 || i === sc.ticks.length - 1) };
}

/**
 * Thin a row of labelled ticks (e.g. month starts on a heatmap) so neighbours don't collide: the
 * smallest step from 1, 2, 3, 4, 6, 12 that leaves `gap` px between kept labels. Ticks are
 * [position px, label]; the first tick is always kept.
 * @param {Array<[number, string]>} ticks
 * @param {(label: string) => number} widthOf
 * @param {{ gap?: number }} [opts]
 * @returns {Array<[number, string]>}
 */
export function thinTicks(ticks, widthOf, { gap = 8 } = {}) {
    if (!ticks || ticks.length < 2) return ticks || [];
    const w = ticks.map(t => widthOf(t[1]));
    for (const step of [1, 2, 3, 4, 6, 12]) {
        let ok = true;
        for (let i = step; i < ticks.length && ok; i += step) if (ticks[i][0] - ticks[i - step][0] < (w[i] + w[i - step]) / 2 + gap) ok = false;
        if (ok) return ticks.filter((_, i) => i % step === 0);
    }
    return [ticks[0]];
}

/**
 * The value series of a chart spec as a lookup: null/undefined/NaN/±Infinity are gaps (null), never
 * zero (+null is 0, which used to draw a missing half-hour on the axis).
 * @param {ArrayLike<any>|undefined} values
 * @returns {(i: number) => number|null}
 */
export function valueLookup(values) {
    const v = values || [];
    return i => {
        if (i >= v.length) return null;
        const x = v[i];
        if (x == null || x === '') return null;
        const n = +x;
        return Number.isFinite(n) ? n : null;
    };
}

/* A range-band series ({ key, label, lo: number[], hi: number[], color }) rather than a line. */
const isBand = se => !!se && se.lo != null && se.hi != null && se.values == null;

function parseColor(c) {
    const s = String(c || '').trim();
    let m = /^#([0-9a-f]{3,8})$/i.exec(s);
    if (m) {
        let x = m[1];
        if (x.length <= 4) x = [...x].map(ch => ch + ch).join('');
        const n = parseInt(x.slice(0, 6), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255, x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
    }
    return [136, 136, 136, 1];
}
const rgba = (c, a = 1) => { const [r, g, b, a0] = parseColor(c); return `rgba(${r},${g},${b},${+(a0 * a).toFixed(3)})`; };

function rampLut(stops) {
    const cols = stops.map(parseColor);
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
        const t = (i / 255) * (cols.length - 1);
        const k = Math.min(cols.length - 2, Math.floor(t));
        const f = t - k;
        for (let c = 0; c < 3; c++) lut[i * 4 + c] = cols[k][c] + (cols[k + 1][c] - cols[k][c]) * f;
        lut[i * 4 + 3] = 255;
    }
    return lut;
}

/* Value → 0..1 position on a ramp; diverging scales put `mid` (default 0, or the centre) at 0.5. */
function scaler(scale, values) {
    let lo = scale?.min, hi = scale?.max;
    if (!finite(lo) || !finite(hi)) {
        let a = Infinity, b = -Infinity;
        for (const v of values) if (finite(v)) { if (v < a) a = v; if (v > b) b = v; }
        if (!finite(lo)) lo = finite(a) ? a : 0;
        if (!finite(hi)) hi = finite(b) ? b : 1;
    }
    if (hi === lo) hi = lo + 1;
    if (scale?.ramp === 'diverging') {
        const mid = finite(scale.mid) ? scale.mid : lo < 0 && hi > 0 ? 0 : (lo + hi) / 2;
        return { lo, hi, mid, t: v => (v <= mid ? 0.5 * clamp((v - lo) / (mid - lo || 1), 0, 1) : 0.5 + 0.5 * clamp((v - mid) / (hi - mid || 1), 0, 1)) };
    }
    return { lo, hi, t: v => clamp((v - lo) / (hi - lo), 0, 1) };
}

function polyline(ctx, pts) {   // straight segments: profiles are means, smoothing would invent peaks
    let pen = false;
    for (const p of pts) {
        if (!p) { pen = false; continue; }
        if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]);
    }
}

/* Bar path: rounded only at the data end, square on the baseline. */
function barPath(ctx, x0, y0, x1, y1, r, end /* 'top'|'bottom'|'right'|'left'|null */) {
    const w = x1 - x0, hgt = y1 - y0;
    r = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(hgt) / 2));
    ctx.beginPath();
    if (!end || r < 0.5) { ctx.rect(x0, y0, w, hgt); return; }
    if (end === 'top') {
        ctx.moveTo(x0, y1); ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r); ctx.lineTo(x1 - r, y0);
        ctx.arcTo(x1, y0, x1, y0 + r, r); ctx.lineTo(x1, y1);
    } else if (end === 'bottom') {
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r);
        ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r);
    } else if (end === 'right') {
        ctx.moveTo(x0, y0); ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r); ctx.lineTo(x1, y1 - r);
        ctx.arcTo(x1, y1, x1 - r, y1, r); ctx.lineTo(x0, y1);
    } else {
        ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r);
        ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r);
    }
    ctx.closePath();
}

/**
 * Lay out labels that sit in the strip above a plot (band names, marker names). Each label is
 * centred on its x, kept inside the chart, and put in row 0 (nearest the plot) or, if that would
 * overlap a label already there, row 1. Row 0 sits level with the top y-tick label, so it starts no
 * further left than the plot (`plotLeft`): on a phone "pays back · 2.7 yrs" used to print over
 * "£4,000". Markers are placed before bands (a band's name is also in the legend; a marker's isn't);
 * a label that fits in neither row is dropped rather than overprinted, and returned in `dropped` so
 * the chart can still name it.
 * @param {Array<{ text: string, x: number, kind: 'marker'|'band' }>} labels
 * @param {(text: string) => number} widthOf text width in px
 * @param {number} w chart width
 * @param {number} [yLabelW] width of the y-axis title at the top-left, which shares row 1's height
 * @param {number} [plotLeft] the plot's left edge (the y-tick labels sit left of it, level with row 0)
 * @returns {{ rows: number, placed: Array<{ text: string, kind: string, row: number, x0: number, x1: number }>,
 *   dropped: Array<{ text: string, x: number, kind: string }> }}
 */
export function layoutTopLabels(labels, widthOf, w, yLabelW = 0, plotLeft = 0) {
    const GAP = 8;
    const taken = [[], yLabelW > 0 ? [[0, yLabelW]] : []];
    const minX = [Math.max(2, plotLeft), 2];
    const placed = [];
    const dropped = [];
    const order = [...labels].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'marker' ? -1 : 1));
    for (const l of order) {
        const tw = widthOf(l.text);
        let spot = null;
        for (const row of [0, 1]) {
            if (row === 0 && tw > w - 2 - minX[0]) continue;   // no room right of the ticks: try the row above
            const x0 = clamp(l.x - tw / 2, minX[row], Math.max(minX[row], w - 2 - tw));
            const x1 = x0 + tw;
            if (!taken[row].some(([a, b]) => x0 < b + GAP && x1 > a - GAP)) { spot = { row, x0, x1 }; break; }
        }
        if (!spot) { dropped.push(l); continue; }
        taken[spot.row].push([spot.x0, spot.x1]);
        placed.push({ text: l.text, kind: l.kind, ...spot });
    }
    return { rows: placed.length ? 1 + Math.max(...placed.map(p => p.row)) : 0, placed, dropped };
}

function placeTopLabels(ctx, labels, w, yLabelW, plotLeft) {
    ctx.font = MONO(10, 500);
    return layoutTopLabels(labels, text => ctx.measureText(text).width, w, yLabelW, plotLeft);
}

function haloText(ctx, text, x, y, fill, halo) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = halo;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
}

function keyEl(kind, color) {
    const k = kind === 'line' ? 'key-line' : kind === 'dash' ? 'key-dash' : kind === 'dot' ? 'key-dot' : kind === 'ring' ? 'key-ring'
        : kind === 'outline' ? 'key-outline' : kind === 'band' ? 'key-band' : kind === 'range' ? 'key-range' : kind === 'hatch' ? 'key-hatch' : 'key-rect';
    const style = kind === 'dash' || kind === 'ring' || kind === 'outline' ? { borderColor: color }
        : kind === 'range' ? { borderColor: color, '--key-c': color }
            : kind === 'band' || kind === 'hatch' ? null : { background: color };
    return h('span', { class: ['key', k], style, 'aria-hidden': 'true' });
}

/* ── base ───────────────────────────────────────────────────────────────────── */

class Chart {
    constructor(el, spec, kind) {
        this.el = el;
        this.kind = kind;
        this.spec = spec || {};
        this.hover = null;
        this.showTable = !!this.spec.table;
        this.raf = 0;
        this.dpr = 1;
        this.fig = h('figure', { class: ['chart', `chart-${kind}`] });
        this.head = h('div', { class: 'chart-head' });
        this.canvas = h('canvas', { tabindex: 0, role: 'application', 'aria-roledescription': 'chart' });
        this.tip = h('div', { class: 'chart-tip', 'aria-hidden': 'true' });
        this.announcer = h('div', { class: 'sr-only', 'aria-live': 'polite' });
        this.plot = h('div', { class: 'chart-plot' }, this.canvas, this.tip, this.announcer);
        this.scaleHost = h('div', { class: 'chart-scale-host' });
        this.foot = h('div', { class: 'chart-foot' });
        this.tableHost = h('div', { class: 'chart-table', hidden: true });
        this.fig.append(this.head, this.plot, this.scaleHost, this.foot, this.tableHost);
        el.replaceChildren(this.fig);

        this.onMove = e => {
            const p = this.local(e);
            this.setHover(this.hitTest(p.x, p.y), false);
        };
        this.lastPointer = 'mouse';
        this.armed = null;   // touch: the point a first tap opened; a second tap on it picks
        this.onDown = e => { this.lastPointer = e.pointerType || 'mouse'; this.onMove(e); };
        this.onLeave = e => { if (e.pointerType !== 'touch') this.setHover(null, false); };
        /*
         * A phone has no hover, so a tap is how a tooltip is read: the first tap on a point only
         * shows it (and says a second tap picks it); a second tap on the same point picks. A mouse
         * click and the keyboard's Enter pick at once. (One tap on the Verdict's scatter used to
         * flash the tooltip and leave for Design in the same gesture.)
         */
        this.onClick = e => {
            const p = this.local(e);
            const hit = this.hitTest(p.x, p.y);
            const touch = (e.pointerType || this.lastPointer) === 'touch';
            if (hit == null) { if (touch) { this.armed = null; this.setHover(null, false); } return; }
            if (touch && this.spec.onPick) {
                const k = JSON.stringify(hit);
                if (this.armed !== k) {
                    this.armed = k;
                    this.setHover(hit, false);
                    this.placeTip();
                    return;
                }
            }
            this.armed = null;
            this.pick(hit);
        };
        this.onKey = e => this.key(e);
        this.onBlur = () => { this.armed = null; this.setHover(null, false); };
        this.canvas.addEventListener('pointermove', this.onMove);
        this.canvas.addEventListener('pointerdown', this.onDown);
        this.canvas.addEventListener('pointerleave', this.onLeave);
        this.canvas.addEventListener('click', this.onClick);
        this.canvas.addEventListener('keydown', this.onKey);
        this.canvas.addEventListener('blur', this.onBlur);
        this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.schedule()) : null;
        this.ro?.observe(this.plot);
        document.fonts?.ready?.then(() => this.schedule());
        live.add(this);
        this.printing = printingNow && this.printsTable();
        this.footExtra = null;
        this.footNext = null;
        this.chrome();
        this.render();
        if (this.showTable) this.setTable(true);
        else if (this.printing) this.buildTable();
    }

    /* public API */
    update(spec) {
        // Someone exploring with the keyboard keeps their place across a data update (e.g. Enter
        // picks a rose cell and the view re-renders); a mouse hover is dropped as before.
        const focused = typeof document !== 'undefined' && document.activeElement === this.canvas;
        const keep = focused ? this.hover : null;
        this.spec = spec || {};
        this.hover = keep != null ? this.clampHover(keep) : null;
        this.invalidate?.();
        this.chrome();
        this.render();
        if (this.showTable || this.printing) this.buildTable();
    }
    /** A hover position carried over to new data: kept if it still exists (clamped), else null. */
    clampHover() { return null; }
    destroy() {
        cancelAnimationFrame(this.raf);
        this.ro?.disconnect();
        live.delete(this);
        this.fig.remove();
    }
    setTable(on) {
        this.showTable = !!on;
        this.tableHost.hidden = !this.showTable;
        this.toggleBtn?.setAttribute('aria-pressed', String(this.showTable));
        if (this.showTable || this.printing) this.buildTable(); else this.tableHost.replaceChildren();
        this.spec.onTable?.(this.showTable);
    }
    /*
     * Paper has no hover, so every chart prints its table twin. The table is built into the still
     * hidden host; the print stylesheet un-hides .chart-table. Huge grids (a year of half-hours,
     * a 37-column sweep) are opted out by default — they would run to pages.
     */
    setPrint(on) {
        this.printing = !!on && this.printsTable();
        if (this.printing && !this.showTable) this.buildTable();
        else if (!this.printing && !this.showTable) this.tableHost.replaceChildren();
        this.render();
    }
    printTableDefault() { return true; }
    /* Whether the table twin goes on paper. One opted out stays off paper even when opened on screen
       (the figure's no-print-table class): a 309-row sweep left open added 15 pages to a print. */
    printsTable() { return this.spec.printTable ?? this.printTableDefault(); }

    /* Text the chart adds under itself (e.g. markers whose names found no room); set while drawing. */
    setFootExtra(text) { this.footNext = text || null; }
    renderFoot() {
        const s = this.spec;
        const extra = this.footExtra ? h('span', { class: 'chart-foot-extra' }, this.footExtra) : null;
        this.foot.replaceChildren(...[s.note || null, s.note && extra ? ' ' : null, extra].filter(x => x != null && x !== ''));
        this.foot.hidden = !s.note && !extra;
    }

    /* plumbing */
    schedule() {
        cancelAnimationFrame(this.raf);
        this.raf = requestAnimationFrame(() => this.render());
    }
    local(e) {
        const r = this.canvas.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    color(c, i = 0) {
        const st = this.styles;
        const v = name => st.getPropertyValue(name).trim();
        if (!c) return v(`--cat-${(Math.min(i, 7)) + 1}`) || '#888';
        if (c.startsWith('--')) return v(c) || '#888';
        const m = /^var\((--[^),]+)/.exec(c);
        if (m) return v(m[1]) || '#888';
        if (SERIES_KEYS.has(c)) return v(`--series-${c}`);
        if (ROUTE_KEYS.has(c)) return v(`--route-${c}`);
        const cat = /^cat-?([1-8])$/.exec(c);
        if (cat) return v(`--cat-${cat[1]}`);
        return c;
    }
    theme() {
        const st = this.styles;
        const v = (n, d) => st.getPropertyValue(n).trim() || d;
        return {
            surface: v('--chart-surface', '#1a1a16'), grid: v('--chart-grid', '#2a2a21'), axis: v('--chart-axis', '#3d3d30'),
            text: v('--chart-text', '#9a9686'), strong: v('--chart-text-strong', '#e8e4d4'), crosshair: v('--chart-crosshair', '#8a8676'),
            band: v('--chart-band', 'rgba(196,162,78,.08)'), bandText: v('--chart-band-text', '#b39a5c'), iso: v('--chart-iso', '#5d5a4e'),
            front: v('--chart-front', '#c9c4b0'), empty: v('--ramp-empty', '#141410'), accent: v('--accent', '#c4a24e'),
            hatch: v('--chart-hatch', 'rgba(232,228,212,0.62)'),
        };
    }
    ramp(scale) {
        const name = scale?.ramp === 'diverging' ? '--ramp-diverging' : scale?.hue === 'solar' || scale?.ramp === 'solar' ? '--ramp-solar' : '--ramp-sequential';
        const raw = this.styles.getPropertyValue(name).trim();
        const stops = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : ['#1d2633', '#3987e5', '#cde2fb'];
        const key = stops.join();
        if (this._rampKey !== key) { this._rampKey = key; this._lut = rampLut(stops); this._stops = stops; }
        return this._lut;
    }
    lutColor(lut, t) {
        const i = Math.round(clamp(t, 0, 1) * 255) * 4;
        return `rgb(${lut[i]},${lut[i + 1]},${lut[i + 2]})`;
    }
    defaultHeight() { return 260; }
    height(w) {
        const want = this.spec.height ?? this.defaultHeight(w);
        return Math.max(w < 480 ? 200 : 140, want);
    }
    render() {
        const w = Math.floor(this.plot.clientWidth);
        if (!w) return;
        const H = Math.round(this.height(w));
        const dpr = Math.min(3, window.devicePixelRatio || 1);
        if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(H * dpr)) {
            this.canvas.width = Math.round(w * dpr);
            this.canvas.height = Math.round(H * dpr);
        }
        this.canvas.style.height = `${H}px`;
        this.dpr = dpr;
        this.w = w; this.H = H;
        this.styles = getComputedStyle(this.fig);
        this.t = this.theme();
        const ctx = this.canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, H);
        ctx.textBaseline = 'alphabetic';
        this.footNext = null;
        try {
            this.draw(ctx, w, H);
        } catch (err) {
            console.error(`${this.kind} chart failed to draw`, err);
        }
        if (this.footNext !== this.footExtra) { this.footExtra = this.footNext; this.renderFoot(); }
        this.placeTip();
    }

    /* chrome: legend, table toggle, title, footnote, aria */
    chrome() {
        const s = this.spec;
        const items = this.legendItems();
        const legend = items.length >= (s.legendMin ?? 2)
            ? h('ul', { class: 'chart-legend' }, items.map(it => h('li', null, keyEl(it.kind, this.colorLater(it.color, it.index)), it.label)))
            : null;
        // Every chart has one of these, so the accessible name says which chart ("Table" stays first
        // so the visible label is in the name).
        const name = s.tableCaption || s.title || s.ariaLabel;
        this.toggleBtn = h('button', {
            type: 'button', class: 'chart-toggle', 'aria-pressed': String(this.showTable), title: 'Show the numbers as a table (T)',
            'aria-label': typeof name === 'string' && name ? `Table: ${name}` : null,
            on: { click: () => this.setTable(!this.showTable) },
        }, icon('table'), 'Table');
        const title = s.title ? h('div', { class: 'chart-title' }, s.title) : null;
        // Tools float right so the title and legend flow around them instead of being squeezed into a column.
        this.head.replaceChildren(...[h('div', { class: 'chart-tools' }, this.toggleBtn), title, legend].filter(Boolean));
        this.renderFoot();
        this.fig.classList.toggle('no-print-table', !this.printsTable());
        const label = s.ariaLabel || s.title || `${this.kind} chart`;
        this.canvas.setAttribute('aria-label', `${label}. Use the arrow keys to read values; press T for a table.`);
    }
    colorLater(c, i) {
        // Legend swatches resolve through CSS so they follow print/theme switches without JS.
        if (!c) return `var(--cat-${Math.min(i ?? 0, 7) + 1})`;
        if (c.startsWith('--')) return `var(${c})`;
        if (SERIES_KEYS.has(c)) return `var(--series-${c})`;
        if (ROUTE_KEYS.has(c)) return `var(--route-${c})`;
        const cat = /^cat-?([1-8])$/.exec(c);
        if (cat) return `var(--cat-${cat[1]})`;
        return c;
    }
    legendItems() { return []; }

    /* hover & keyboard */
    setHover(hv, fromKey) {
        const same = JSON.stringify(hv) === JSON.stringify(this.hover);
        this.hover = hv;
        if (!same) this.render();
        if (fromKey && hv != null) {
            const tipData = this.tipFor(hv);
            if (tipData) this.announcer.textContent = [tipData.title, ...(tipData.rows || []).map(r => `${r.label}: ${r.value}`)].filter(Boolean).join(', ');
        }
    }
    key(e) {
        if (e.key === 't' || e.key === 'T') { e.preventDefault(); this.setTable(!this.showTable); return; }
        if (e.key === 'Escape') { this.setHover(null, false); return; }
        if (e.key === 'Enter' || e.key === ' ') { if (this.hover != null) { e.preventDefault(); this.pick(this.hover); } return; }
        const map = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1], Home: ['home', 0], End: ['end', 0] };
        const d = map[e.key];
        if (!d) return;
        const next = this.step(this.hover, d[0], d[1]);
        if (next === undefined) return;
        e.preventDefault();
        this.setHover(next, true);
    }
    step() { return undefined; }
    pick() {}
    hitTest() { return null; }
    tipFor() { return null; }

    placeTip() {
        const hv = this.hover;
        const data = hv != null ? this.tipFor(hv) : null;
        if (!data) { this.tip.classList.remove('show'); return; }
        const rows = (data.rows || []).map(r => h('div', { class: 'tip-row' },
            r.color ? keyEl(r.kind || 'line', r.color) : h('span'),
            h('span', { class: 'tip-val' }, r.value),
            h('span', { class: 'tip-lab' }, r.label ?? '')));
        const armed = this.armed != null && this.armed === JSON.stringify(hv);
        this.tip.replaceChildren(
            data.title ? h('div', { class: 'tip-title' }, data.title) : '',
            ...rows,
            data.note ? h('div', { class: 'tip-note' }, data.note) : '',
            armed ? h('div', { class: 'tip-note tip-tap' }, this.spec.touchPickHint || 'Tap again to choose it') : '');
        this.tip.classList.add('show');
        const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
        const ax = data.x ?? 0, ay = data.y ?? 0;
        let x = ax + 14;
        if (x + tw > this.w - 4) x = ax - tw - 14;
        x = clamp(x, 4, Math.max(4, this.w - tw - 4));
        const y = clamp(ay - th / 2, 2, Math.max(2, this.H - th - 2));
        this.tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }

    buildTable() {
        const t = this.tableSpec();
        if (!t) { this.tableHost.replaceChildren(h('p', { class: 'muted' }, 'No data.')); return; }
        const s = this.spec;
        const caption = [s.tableCaption, s.title, s.ariaLabel].find(c => typeof c === 'string' && c) || `${this.kind} data`;
        this.tableHost.replaceChildren(uiTable({ columns: t.columns, rows: t.rows, dense: true, caption }));
    }
    tableSpec() { return null; }

    /* shared axis painters */
    yAxis(ctx, scale, left, right, y, format, opts = {}) {
        const t = this.t;
        ctx.font = MONO(10.5);
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of scale.ticks) {
            const py = Math.round(y(v)) + 0.5;
            ctx.strokeStyle = v === 0 ? t.axis : t.grid;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
            if (!opts.noLabels) { ctx.fillStyle = t.text; ctx.fillText(format(v), left - 8, py); }
        }
        ctx.textBaseline = 'alphabetic';
    }
    measureTicks(ctx, scale, format) {
        ctx.font = MONO(10.5);
        return Math.max(0, ...scale.ticks.map(v => ctx.measureText(format(v)).width));
    }
}

/* ── XY: line & stacked area ────────────────────────────────────────────────── */

class XYChart extends Chart {
    legendItems() {
        const s = this.spec;
        const items = (s.series || []).map((se, i) => ({
            label: se.label ?? se.key, color: se.color, index: i,
            kind: isBand(se) ? 'range' : this.stacked && !se.line ? 'rect' : se.dash ? 'dash' : 'line',
        }));
        for (const b of s.bands || []) if (b.label && b.legend !== false) items.push({ label: b.label, kind: 'band' });
        return items;
    }
    defaultHeight(w) { return w < 600 ? 220 : 260; }
    /* series stacked as fills (stacked charts only) — line overlays and range bands are not */
    isFill(se) { return this.stacked && !se.line && !isBand(se); }

    xInfo(n) {
        const x = this.spec.x || {};
        const type = x.type || 'category';
        const vals = x.values || Array.from({ length: n }, (_, i) => i);
        return { type, vals, n: vals.length || n };
    }
    seriesValues(se) { return valueLookup(se.values); }
    seriesLength(se) { return isBand(se) ? Math.max(se.lo?.length || 0, se.hi?.length || 0) : se.values?.length || 0; }
    pointCount() {
        const s = this.spec;
        return Math.max(s.x?.values?.length || 0, ...(s.series || []).map(se => this.seriesLength(se)));
    }
    clampHover(hv) {
        const n = this.pointCount();
        return n > 0 && Number.isInteger(hv) ? clamp(hv, 0, n - 1) : null;
    }
    yDomain(n) {
        const s = this.spec;
        let lo = Infinity, hi = -Infinity;
        const series = s.series || [];
        const take = v => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
        for (const se of series.filter(isBand)) {
            const a = valueLookup(se.lo), b = valueLookup(se.hi);
            for (let i = 0; i < n; i++) { take(a(i)); take(b(i)); }
        }
        if (this.stacked) {
            const stacked = series.filter(se => this.isFill(se));
            for (let i = 0; i < n; i++) {
                let pos = 0, neg = 0;
                for (const se of stacked) { const v = this.seriesValues(se, n)(i); if (v == null) continue; if (v >= 0) pos += v; else neg += v; }
                hi = Math.max(hi, pos); lo = Math.min(lo, neg);
            }
            for (const se of series.filter(x => x.line && !isBand(x))) for (let i = 0; i < n; i++) take(this.seriesValues(se, n)(i));
        } else {
            for (const se of series) if (!isBand(se)) for (let i = 0; i < n; i++) take(this.seriesValues(se, n)(i));
        }
        if (!finite(lo)) { lo = 0; hi = 1; }
        const y = s.y || {};
        if (y.zero !== false) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
        const sc = niceScale(finite(y.min) ? y.min : lo, finite(y.max) ? y.max : hi, this.H < 200 ? 4 : 5);
        if (finite(y.min)) sc.min = y.min;
        if (finite(y.max)) sc.max = y.max;
        sc.ticks = sc.ticks.filter(t => t >= sc.min - 1e-9 && t <= sc.max + 1e-9);
        return sc;
    }

    draw(ctx, w, H) {
        const s = this.spec;
        const series = s.series || [];
        const n = this.pointCount();
        this.n = n;
        if (!n) { this.empty(ctx, w, H); return; }
        const X = this.xInfo(n);
        const t = this.t;
        const yScale = this.yDomain(n);
        const yFmt = s.y?.format || autoFormat(yScale.step);
        const yLabelH = s.y?.label ? 16 : 0;
        // A shared minimum gutter keeps stacked charts (load above price) aligned on x.
        const left = Math.max(s.gutter ?? 48, Math.ceil(this.measureTicks(ctx, yScale, yFmt)) + 14);
        const xLabelH = s.x?.label ? 16 : 0;
        const bottom = H - 24 - xLabelH;

        // Direct end labels for 2–4 line series when there is room (dataviz: label ≤4, legend always).
        const lineSeries = series.filter(se => !isBand(se) && (!this.stacked || se.line));
        const endLabels = !this.stacked && s.endLabels !== false && lineSeries.length >= 2 && lineSeries.length <= 4 && w >= 520;
        ctx.font = SANS(11.5);
        const endW = endLabels ? Math.min(140, Math.max(...lineSeries.map(se => ctx.measureText(se.label ?? se.key ?? '').width))) + 22 : 0;
        const right = w - 10 - endW;
        const plotW = Math.max(10, right - left);

        let xpos, xmin = 0, xmax = 1, bw = plotW / n;
        if (X.type === 'category') {
            xpos = i => left + (i + 0.5) * bw;
        } else {
            xmin = Infinity; xmax = -Infinity;
            for (const v of X.vals) if (finite(+v)) { xmin = Math.min(xmin, +v); xmax = Math.max(xmax, +v); }
            if (!finite(xmin)) { xmin = 0; xmax = 1; }
            if (xmax === xmin) xmax = xmin + 1;
            xpos = i => left + ((+X.vals[i] - xmin) / (xmax - xmin)) * plotW;
        }
        const xAt = v => (X.type === 'category' ? left + v * bw : left + ((v - xmin) / (xmax - xmin)) * plotW);
        const bandIdx = v => (typeof v === 'string' && X.type === 'category' ? X.vals.indexOf(v) : +v);
        const bandSpans = (s.bands || []).map(b => {
            const a = bandIdx(b.from), z = bandIdx(b.to);
            if (!finite(a) || !finite(z)) return null;
            return { b, x0: clamp(xAt(Math.min(a, z)), left, right), x1: clamp(xAt(Math.max(a, z)), left, right) };
        }).filter(Boolean);
        const markerXs = (s.markers || []).map(m => {
            const xv = X.type === 'category' ? (typeof m.x === 'string' ? X.vals.indexOf(m.x) : +m.x) : +m.x;
            if (!finite(xv)) return null;
            const px = Math.round(X.type === 'category' ? xpos(xv) : xAt(xv)) + 0.5;
            return px < left - 1 || px > right + 1 ? null : { m, px };
        }).filter(Boolean);
        // Band and marker labels share the strip above the plot: place them before the plot's top is
        // fixed, so a collision can open a second row instead of overprinting ("you now" on a band).
        const topLabels = placeTopLabels(ctx, [
            ...markerXs.filter(o => o.m.label).map(o => ({ text: o.m.label, x: o.px, kind: 'marker' })),
            ...bandSpans.filter(o => o.b.label).map(o => ({ text: o.b.label, x: (o.x0 + o.x1) / 2, kind: 'band' })),
        ], w, s.y?.label ? (ctx.font = MONO(10.5), ctx.measureText(s.y.label).width + 10) : 0, left);
        // A marker whose name found no room above the plot is still named, under the chart
        // (four pinned paybacks on a phone left two dashed lines nobody could tell apart).
        const unlabelled = topLabels.dropped.filter(l => l.kind === 'marker').sort((a, b) => a.x - b.x).map(l => l.text);
        this.setFootExtra(unlabelled.length ? `Also marked: ${unlabelled.join('; ')}.` : null);
        const top = 8 + Math.max(yLabelH, topLabels.rows * 14);
        const y = v => bottom - ((v - yScale.min) / (yScale.max - yScale.min || 1)) * (bottom - top);
        this.geo = { left, right, top, bottom, xpos, n, X, bw };

        // bands (e.g. the 16:00–19:00 peak) sit behind everything
        for (const { x0, x1 } of bandSpans) {
            ctx.fillStyle = t.band;
            ctx.fillRect(x0, top, x1 - x0, bottom - top);
        }

        this.yAxis(ctx, yScale, left, right, y, yFmt);
        if (s.y?.label) {
            ctx.font = MONO(10.5);
            ctx.fillStyle = t.text;
            ctx.textAlign = 'left';
            ctx.fillText(s.y.label, 2, 11);
        }

        // series: range bands first (behind everything), then the stack, then the lines
        const cols = series.map((se, i) => this.color(se.color, i));
        series.forEach((se, i) => { if (isBand(se)) this.drawRange(ctx, se, cols[i], xpos, y, n); });
        if (this.stacked) this.drawStack(ctx, series, cols, xpos, y, n, yScale);
        series.forEach((se, i) => {
            if (isBand(se) || this.isFill(se)) return;
            const val = this.seriesValues(se, n);
            const pts = Array.from({ length: n }, (_, k) => { const v = val(k); return v == null ? null : [xpos(k), y(v)]; });
            if (se.area && !this.stacked) {
                ctx.beginPath();
                let run = [];
                const flush = () => {
                    if (run.length > 1) {
                        const base = y(clamp(0, yScale.min, yScale.max));
                        ctx.moveTo(run[0][0], base);
                        for (const p of run) ctx.lineTo(p[0], p[1]);
                        ctx.lineTo(run[run.length - 1][0], base);
                        ctx.closePath();
                    }
                    run = [];
                };
                for (const p of pts) { if (p) run.push(p); else flush(); }
                flush();
                ctx.fillStyle = rgba(cols[i], 0.12);
                ctx.fill();
            }
            ctx.beginPath();
            polyline(ctx, pts);
            ctx.strokeStyle = cols[i];
            ctx.lineWidth = se.width || 2;
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.setLineDash(se.dash ? (Array.isArray(se.dash) ? se.dash : [5, 4]) : []);
            ctx.stroke();
            ctx.setLineDash([]);
        });

        // vertical markers ('you now', 'payback')
        for (const { px } of markerXs) {
            ctx.strokeStyle = t.crosshair;
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 3]);
            ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.font = MONO(10, 500);
        ctx.textAlign = 'left';
        for (const l of topLabels.placed) {
            const ly = top - 4 - l.row * 13;
            if (l.kind === 'marker') haloText(ctx, l.text, l.x0, ly, t.strong, t.surface);
            else { ctx.fillStyle = t.bandText; ctx.fillText(l.text, l.x0, ly); }
        }

        // x ticks
        this.xAxis(ctx, X, left, right, bottom, xpos, xmin, xmax, plotW);
        if (s.x?.label) {
            ctx.font = MONO(10.5);
            ctx.fillStyle = t.text;
            ctx.textAlign = 'right';
            ctx.fillText(s.x.label, right, H - 3);
        }

        // end labels
        if (endLabels) {
            const placed = [];
            lineSeries.forEach(se => {
                const i = series.indexOf(se);
                const val = this.seriesValues(se, n);
                let k = n - 1;
                while (k >= 0 && val(k) == null) k--;
                if (k < 0) return;
                const py = y(val(k));
                if (placed.some(p => Math.abs(p - py) < 13)) return;   // colliding: the legend carries it
                placed.push(py);
                ctx.strokeStyle = cols[i]; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(right + 6, py); ctx.lineTo(right + 14, py); ctx.stroke();
                ctx.font = SANS(11.5);
                ctx.fillStyle = t.strong;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                let label = se.label ?? se.key ?? '';
                while (label.length > 3 && ctx.measureText(label).width > endW - 20) label = `${label.slice(0, -2)}…`;
                ctx.fillText(label, right + 18, py);
                ctx.textBaseline = 'alphabetic';
            });
        }

        // crosshair + hover dots
        if (this.hover != null && this.hover < n) {
            const px = Math.round(xpos(this.hover)) + 0.5;
            ctx.strokeStyle = t.crosshair;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
            series.forEach((se, i) => {
                if (isBand(se) || this.isFill(se)) return;
                const v = this.seriesValues(se, n)(this.hover);
                if (v == null) return;
                ctx.beginPath(); ctx.arc(px, y(v), 4, 0, Math.PI * 2);
                ctx.fillStyle = cols[i]; ctx.fill();
                ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
            });
            if (this.stacked) {
                let pos = 0, neg = 0;
                series.forEach((se, i) => {
                    if (!this.isFill(se)) return;
                    const v = this.seriesValues(se, n)(this.hover);
                    if (v == null || v === 0) return;
                    const y0 = v >= 0 ? pos : neg; const y1 = y0 + v;
                    if (v >= 0) pos = y1; else neg = y1;
                    ctx.beginPath(); ctx.arc(px, y(y1), 3.5, 0, Math.PI * 2);
                    ctx.fillStyle = cols[i]; ctx.fill();
                    ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
                });
            }
            this.tipAnchor = { x: px, y: top + (bottom - top) * 0.35 };
        }
    }

    drawStack(ctx, series, cols, xpos, y, n) {
        const t = this.t;
        const stacked = series.map((se, i) => ({ se, i })).filter(o => this.isFill(o.se));
        const pos = new Float64Array(n), neg = new Float64Array(n);
        const gaps = [];
        // Smooth joins by default; `steps: true` draws each half-hour as a flat step (useful when
        // the reader must see that 16:00 is a hard edge, at the cost of a busier picture).
        const step = (this.spec.x?.type || 'category') === 'category' && this.spec.steps === true;
        const bw = this.geo.bw;
        const zeroY = y(0);
        const vals = stacked.map(({ se }) => { const f = this.seriesValues(se, n); return Array.from({ length: n }, (_, k) => f(k)); });
        // A slot where no stacked layer has a value is a gap in the whole stack (missing, not zero).
        const runs = [];
        for (let k = 0, start = -1; k <= n; k++) {
            const has = k < n && vals.some(v => v[k] != null);
            if (has && start < 0) start = k;
            if (!has && start >= 0) { runs.push([start, k - 1]); start = -1; }
        }
        // Which side of zero each slot of a layer stacks on. A zero (or missing) slot sits on the
        // side of the layer's last non-zero value (or its first, before any), so an empty half-hour
        // of a below-zero layer stays below zero instead of jumping to the top of the positive stack.
        const sides = v => {
            const out = new Int8Array(n);
            let last = 0;
            for (let k = 0; k < n; k++) { if (v[k] > 0) last = 1; else if (v[k] < 0) last = -1; out[k] = last; }
            const first = out.find(x => x !== 0) || 1;
            for (let k = 0; k < n && out[k] === 0; k++) out[k] = first;
            return out;
        };
        stacked.forEach(({ i }, j) => {
            const v = vals[j];
            const side = sides(v);
            for (const [a, b] of runs) {
                const lower = [], upper = [], thick = [];
                for (let k = a; k <= b; k++) {
                    const val = v[k] ?? 0;
                    const below = val < 0 || (val === 0 && side[k] < 0);
                    const base = below ? neg[k] : pos[k];
                    const top = base + val;
                    if (below) neg[k] = top; else pos[k] = top;
                    const reps = step ? [xpos(k) - bw / 2, xpos(k) + bw / 2] : [xpos(k)];
                    for (const x of reps) {
                        lower.push([x, y(base)]);
                        upper.push([x, y(top)]);
                        thick.push(Math.abs(y(top) - y(base)) > 0.5 && base !== 0);
                    }
                }
                ctx.beginPath();
                upper.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
                for (let k = lower.length - 1; k >= 0; k--) ctx.lineTo(lower[k][0], lower[k][1]);
                ctx.closePath();
                // Full-strength fills: the palette was validated at full opacity, and at 80% over the
                // dark surface export↔clipped drops to CVD ΔE 5.5 (protan) — below the 6.0 floor.
                ctx.fillStyle = cols[i];
                ctx.fill();
                gaps.push({ lower, thick });
            }
        });
        // 2px surface gap where a layer sits on another — only where this layer actually has
        // thickness, otherwise the "gap" becomes a dark outline along the top of the stack.
        ctx.strokeStyle = t.surface;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (const { lower, thick } of gaps) {
            for (let k = 1; k < lower.length; k++) {
                if (!(thick[k] || thick[k - 1])) continue;
                if (Math.abs(lower[k][1] - zeroY) < 0.5 && Math.abs(lower[k - 1][1] - zeroY) < 0.5) continue;
                ctx.moveTo(lower[k - 1][0], lower[k - 1][1]);
                ctx.lineTo(lower[k][0], lower[k][1]);
            }
        }
        ctx.stroke();
    }

    /*
     * A range band (e.g. p10–p90): the area between lo and hi filled at ~15% of the series colour,
     * with hairline edges at 45% so it still reads where it is thin. Missing lo or hi breaks it.
     */
    drawRange(ctx, se, col, xpos, y, n) {
        const lo = valueLookup(se.lo), hi = valueLookup(se.hi);
        const runs = [];
        let run = [];
        for (let k = 0; k < n; k++) {
            const a = lo(k), b = hi(k);
            if (a == null || b == null) { if (run.length) runs.push(run); run = []; continue; }
            run.push([xpos(k), y(Math.min(a, b)), y(Math.max(a, b))]);
        }
        if (run.length) runs.push(run);
        for (const r of runs) {
            const pts = r.length === 1 ? [[r[0][0] - 2, r[0][1], r[0][2]], [r[0][0] + 2, r[0][1], r[0][2]]] : r;
            ctx.beginPath();
            pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[2]) : ctx.moveTo(p[0], p[2])));
            for (let k = pts.length - 1; k >= 0; k--) ctx.lineTo(pts[k][0], pts[k][1]);
            ctx.closePath();
            ctx.fillStyle = rgba(col, se.opacity ?? 0.15);
            ctx.fill();
            ctx.beginPath();
            polyline(ctx, pts.map(p => [p[0], p[1]]));
            polyline(ctx, pts.map(p => [p[0], p[2]]));
            ctx.strokeStyle = rgba(col, 0.45);
            ctx.lineWidth = 1;
            ctx.stroke();
        }
    }

    xAxis(ctx, X, left, right, bottom, xpos, xmin, xmax, plotW) {
        const t = this.t;
        const f = this.spec.x?.format;
        ctx.font = MONO(10.5);
        ctx.fillStyle = t.text;
        ctx.textBaseline = 'alphabetic';
        const ly = bottom + 16;
        if (X.type === 'category') {
            const labels = X.vals.map((v, i) => (f ? f(v, i) : String(v)));
            const maxW = Math.max(1, ...labels.map(l => ctx.measureText(l).width));
            const bw = plotW / X.n;
            const steps = [1, 2, 3, 4, 6, 8, 12, 16, 24, 48, 96, 168, 336];
            const k = steps.find(s => s * bw >= maxW + 10) || Math.ceil((maxW + 10) / bw);
            ctx.textAlign = 'center';
            for (let i = 0; i < X.n; i += k) {
                const px = xpos(i);
                if (px - maxW / 2 < left - 12 && i > 0) continue;
                ctx.fillText(labels[i], clamp(px, left + ctx.measureText(labels[i]).width / 2 - 8, right - ctx.measureText(labels[i]).width / 2 + 8), ly);
            }
        } else if (X.type === 'time') {
            const span = xmax - xmin;
            const ticks = [];
            const d0 = new Date(xmin);
            if (span > 62 * 864e5) {
                let d = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1);
                const every = span > 400 * 864e5 ? 3 : span > 200 * 864e5 ? 2 : 1;
                let m = 0;
                while (d <= xmax) {
                    const dd = new Date(d);
                    if (m % every === 0) ticks.push([d, MONTHS[dd.getUTCMonth()] + (dd.getUTCMonth() === 0 ? ` ${dd.getUTCFullYear()}` : '')]);
                    m++;
                    d = Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth() + 1, 1);
                }
            } else {
                const dayMs = 864e5;
                const every = Math.max(1, Math.ceil(span / dayMs / Math.max(2, plotW / 70)));
                for (let d = Math.ceil(xmin / dayMs) * dayMs; d <= xmax; d += every * dayMs) ticks.push([d, f ? f(d) : fmt.date(d, { year: false })]);
            }
            ctx.textAlign = 'center';
            for (const [v, lab] of ticks) {
                const px = left + ((v - xmin) / (xmax - xmin)) * plotW;
                ctx.fillText(lab, clamp(px, left + 14, right - 14), ly);
            }
        } else {
            const sc = niceScale(xmin, xmax, Math.max(3, Math.floor(plotW / 80)));
            const ff = f || autoFormat(sc.step);
            ctx.textAlign = 'center';
            for (const v of sc.ticks) {
                if (v < xmin - 1e-9 || v > xmax + 1e-9) continue;
                const px = left + ((v - xmin) / (xmax - xmin)) * plotW;
                ctx.fillText(ff(v), clamp(px, left + 10, right - 10), ly);
            }
        }
        ctx.strokeStyle = t.axis;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(left, Math.round(bottom) + 0.5); ctx.lineTo(right, Math.round(bottom) + 0.5); ctx.stroke();
    }

    empty(ctx, w, H) {
        ctx.font = SANS(13);
        ctx.fillStyle = this.t.text;
        ctx.textAlign = 'center';
        ctx.fillText(this.spec.emptyText || 'No data to plot yet.', w / 2, H / 2);
        this.geo = null;
    }

    hitTest(x) {
        const g = this.geo;
        if (!g || x < g.left - 6 || x > g.right + 6) return null;
        if (g.X.type === 'category') return clamp(Math.floor((x - g.left) / g.bw), 0, g.n - 1);
        let best = 0, bd = Infinity;
        for (let i = 0; i < g.n; i++) { const d = Math.abs(g.xpos(i) - x); if (d < bd) { bd = d; best = i; } }
        return best;
    }
    step(cur, dx) {
        if (!this.n) return undefined;
        if (dx === 'home') return 0;
        if (dx === 'end') return this.n - 1;
        if (!dx) return undefined;
        if (cur == null) return dx > 0 ? 0 : this.n - 1;
        return clamp(cur + dx, 0, this.n - 1);
    }
    xLabel(i) {
        const X = this.spec.x || {};
        const v = X.values ? X.values[i] : i;
        if (X.tipFormat) return X.tipFormat(v, i);
        if (X.format) return X.format(v, i);
        if (X.type === 'time') return fmt.date(+v);
        return String(v);
    }
    tipFor(i) {
        const s = this.spec;
        if (!this.geo || i == null) return null;
        const rows = [];
        let total = 0, anyTotal = false;
        const series = s.series || [];
        series.forEach((se, k) => {
            const f = se.format || s.y?.format || (x => fmt.num(x, Math.abs(x) < 10 ? 2 : 1));
            if (isBand(se)) {
                const a = valueLookup(se.lo)(i), b = valueLookup(se.hi)(i);
                rows.push({ color: this.colorLater(se.color, k), kind: 'range', value: a == null || b == null ? '—' : `${f(Math.min(a, b))}–${f(Math.max(a, b))}`, label: se.label ?? se.key });
                return;
            }
            const v = this.seriesValues(se, this.n)(i);
            if (this.isFill(se) && v != null) { total += v; anyTotal = true; }
            rows.push({ color: this.colorLater(se.color, k), kind: this.isFill(se) ? 'rect' : se.dash ? 'dash' : 'line', value: v == null ? '—' : f(v), label: se.label ?? se.key });
        });
        if (this.stacked && s.total !== false && anyTotal && series.filter(se => this.isFill(se)).length > 1) {
            const f = s.y?.format || (x => fmt.num(x, 2));
            rows.push({ value: f(total), label: s.totalLabel || 'Total' });
        }
        // Stacked charts list the top layer first so the tooltip reads in the same order as the picture.
        if (this.stacked) {
            const lines = rows.filter((r, k) => (series[k] ? !this.isFill(series[k]) : false));
            const fills = rows.filter((r, k) => (series[k] ? this.isFill(series[k]) : false)).reverse();
            const tot = rows.length > series.length ? [rows[rows.length - 1]] : [];
            return { title: this.xLabel(i), rows: [...lines, ...fills, ...tot], ...this.tipAnchor };
        }
        return { title: this.xLabel(i), rows, ...this.tipAnchor };
    }
    tableSpec() {
        const s = this.spec;
        const n = this.pointCount();
        if (!n) return null;
        const columns = [{ key: '_x', label: s.x?.label || '', sortable: false }];
        const fmtOf = se => v => (v == null ? '—' : (se.format || s.y?.format || (x => fmt.num(x, Math.abs(x) < 10 ? 2 : 1)))(v));
        (s.series || []).forEach((se, k) => {
            const label = se.label ?? se.key;
            // a range band reads as two columns: its low and high edge
            if (isBand(se)) {
                columns.push({ key: `s${k}lo`, label: `${label} (${se.loLabel || 'low'})`, align: 'right', sortable: false, format: fmtOf(se) });
                columns.push({ key: `s${k}hi`, label: `${label} (${se.hiLabel || 'high'})`, align: 'right', sortable: false, format: fmtOf(se) });
            } else columns.push({ key: `s${k}`, label, align: 'right', sortable: false, format: fmtOf(se) });
        });
        const rows = Array.from({ length: n }, (_, i) => {
            const r = { _x: this.xLabel(i) };
            (s.series || []).forEach((se, k) => {
                if (isBand(se)) { r[`s${k}lo`] = valueLookup(se.lo)(i); r[`s${k}hi`] = valueLookup(se.hi)(i); } else r[`s${k}`] = this.seriesValues(se, n)(i);
            });
            return r;
        });
        return { columns, rows };
    }
}

class LineChart extends XYChart { }
class StackedAreaChart extends XYChart { get stacked() { return true; } }

/* ── bars ───────────────────────────────────────────────────────────────────── */

class BarChart extends Chart {
    legendItems() {
        return (this.spec.series || []).map((se, i) => ({ label: se.label ?? se.key, color: se.color, index: i, kind: se.outline ? 'outline' : 'rect' }));
    }
    defaultHeight(w) {
        const s = this.spec;
        if (s.horizontal) {
            const per = s.stacked || (s.series || []).length < 2 ? 30 : 16 * (s.series || []).length + 14;
            return Math.max(120, (s.categories?.length || 0) * (per + (this.labelsAbove(w) ? LABEL_ROW_H : 0)) + 40);
        }
        return w < 600 ? 220 : 250;
    }
    catLabels() {
        const s = this.spec;
        return (s.categories || []).map((c, i) => (s.x?.format ? s.x.format(c, i) : String(c)));
    }
    /*
     * Horizontal bars on a narrow canvas: when a category name wouldn't fit the label column (40% of
     * the width), each name gets its own line above its bar instead of being cut to "Agile-aware (re…"
     * — on the Verdict those names are the answer. spec.labelsAbove: true/false forces it.
     */
    labelsAbove(w) {
        const s = this.spec;
        if (!s.horizontal) return false;
        if (typeof s.labelsAbove === 'boolean') return s.labelsAbove;
        if (!(w < 480)) return false;
        const ctx = this.canvas.getContext?.('2d');
        if (!ctx) return false;
        ctx.font = SANS(12.5);
        return this.catLabels().some(l => ctx.measureText(l).width + 12 > w * 0.4);
    }
    val(se, i) { return valueLookup(se.values)(i); }
    clampHover(hv) {
        const n = this.spec.categories?.length || 0;
        return n > 0 && Number.isInteger(hv) ? clamp(hv, 0, n - 1) : null;
    }
    /* data extent (always including 0: bars grow from the baseline) */
    domainRaw() {
        const s = this.spec;
        let lo = 0, hi = 0;
        const cats = s.categories || [];
        for (let i = 0; i < cats.length; i++) {
            if (s.stacked) {
                let p = 0, q = 0;
                for (const se of s.series || []) { const v = this.val(se, i); if (v == null) continue; if (v >= 0) p += v; else q += v; }
                hi = Math.max(hi, p); lo = Math.min(lo, q);
            } else for (const se of s.series || []) { const v = this.val(se, i); if (v != null) { hi = Math.max(hi, v); lo = Math.min(lo, v); } }
        }
        return { lo, hi };
    }
    domain() {
        const s = this.spec;
        const { lo, hi } = this.domainRaw();
        const y = s.y || {};
        const sc = niceScale(finite(y.min) ? y.min : lo, finite(y.max) ? y.max : hi, 5);
        if (finite(y.min)) sc.min = y.min;
        if (finite(y.max)) sc.max = y.max;
        sc.ticks = sc.ticks.filter(t => t >= sc.min - 1e-9 && t <= sc.max + 1e-9);
        return sc;
    }
    draw(ctx, w, H) {
        const s = this.spec;
        const cats = s.categories || [];
        const series = s.series || [];
        const t = this.t;
        if (!cats.length || !series.length) {
            ctx.font = SANS(13); ctx.fillStyle = t.text; ctx.textAlign = 'center';
            ctx.fillText(s.emptyText || 'No data to plot yet.', w / 2, H / 2);
            this.geo = null;
            return;
        }
        const sc = this.domain();
        const f = s.y?.format || autoFormat(sc.step);
        const cols = series.map((se, i) => this.color(se.color, i));
        const catLabel = (c, i) => (s.x?.format ? s.x.format(c, i) : String(c));
        if (s.horizontal) this.drawH(ctx, w, H, cats, series, cols, sc, s.y?.format, catLabel);
        else this.drawV(ctx, w, H, cats, series, cols, sc, f, catLabel);
    }
    segments(series, i) {
        // returns [{ k, v, a, b }] with stacked or grouped placement in value space
        const out = [];
        let p = 0, q = 0;
        series.forEach((se, k) => {
            const v = this.val(se, i);
            if (v == null) return;
            if (this.spec.stacked) {
                const a = v >= 0 ? p : q;
                const b = a + v;
                if (v >= 0) p = b; else q = b;
                out.push({ k, v, a, b });
            } else out.push({ k, v, a: 0, b: v });
        });
        return out;
    }
    drawV(ctx, w, H, cats, series, cols, sc, f, catLabel) {
        const s = this.spec, t = this.t;
        const yLabelH = s.y?.label ? 16 : 0;
        const top = 10 + yLabelH;
        const left = Math.max(s.gutter ?? 48, Math.ceil(this.measureTicks(ctx, sc, f)) + 14);
        const right = w - 8;
        const bottom = H - 24;
        const n = cats.length;
        const bw = (right - left) / n;
        const y = v => bottom - ((v - sc.min) / (sc.max - sc.min || 1)) * (bottom - top);
        const k = s.stacked ? 1 : series.length;
        const gap = 2;
        const barW = Math.max(2, Math.min(24, (bw * 0.72 - (k - 1) * gap) / k));
        const groupW = k * barW + (k - 1) * gap;
        this.geo = { left, right, top, bottom, bw, n, y, horizontal: false };

        if (this.hover != null) {
            ctx.fillStyle = 'rgba(255,255,255,0.035)';
            ctx.fillRect(left + this.hover * bw, top, bw, bottom - top);
        }
        this.yAxis(ctx, sc, left, right, y, f);
        if (s.y?.label) { ctx.font = MONO(10.5); ctx.fillStyle = t.text; ctx.textAlign = 'left'; ctx.fillText(s.y.label, 2, 11); }

        for (let i = 0; i < n; i++) {
            const cx = left + (i + 0.5) * bw;
            const segs = this.segments(series, i);
            const lastPos = [...segs].reverse().find(sg => sg.v > 0);
            const lastNeg = [...segs].reverse().find(sg => sg.v < 0);
            segs.forEach(sg => {
                const se = series[sg.k];
                const x0 = s.stacked ? cx - barW / 2 : cx - groupW / 2 + sg.k * (barW + gap);
                let ya = y(sg.a), yb = y(sg.b);
                // 2px surface gap between stacked segments: shave the far end of every segment but the outermost.
                const outer = sg === lastPos || sg === lastNeg;
                if (s.stacked && !outer && Math.abs(yb - ya) > 3) yb += sg.v >= 0 ? 2 : -2;
                const end = !s.stacked || outer ? (sg.v >= 0 ? 'top' : 'bottom') : null;
                barPath(ctx, x0, Math.min(ya, yb), x0 + barW, Math.max(ya, yb), 4, end);
                if (se.outline) {
                    ctx.fillStyle = rgba(cols[sg.k], 0.1); ctx.fill();
                    ctx.strokeStyle = cols[sg.k]; ctx.lineWidth = 1.5; ctx.stroke();
                } else {
                    ctx.fillStyle = cols[sg.k]; ctx.fill();
                }
            });
        }
        // baseline at 0
        ctx.strokeStyle = t.axis; ctx.lineWidth = 1;
        const zy = Math.round(y(clamp(0, sc.min, sc.max))) + 0.5;
        ctx.beginPath(); ctx.moveTo(left, zy); ctx.lineTo(right, zy); ctx.stroke();

        // category labels, thinned to fit
        ctx.font = MONO(10.5); ctx.fillStyle = t.text; ctx.textAlign = 'center';
        const labels = cats.map(catLabel);
        const maxW = Math.max(1, ...labels.map(l => ctx.measureText(l).width));
        const every = [1, 2, 3, 4, 6, 12, 24].find(e => e * bw >= maxW + 8) || Math.ceil((maxW + 8) / bw);
        for (let i = 0; i < n; i += every) ctx.fillText(labels[i], left + (i + 0.5) * bw, bottom + 16);
        this.tipAnchor = this.hover != null ? { x: left + (this.hover + 0.5) * bw + Math.min(bw / 2, 20), y: top + 30 } : null;
    }
    drawH(ctx, w, H, cats, series, cols, sc0, userFmt, catLabel) {
        const s = this.spec, t = this.t;
        const labels = cats.map(catLabel);
        // names above the bars only when each row still has room for its bar under the name
        const above = this.labelsAbove(w) && (H - 26) / Math.max(1, cats.length) - LABEL_ROW_H >= 12;
        const labH = above ? LABEL_ROW_H : 0;
        ctx.font = SANS(12.5);
        const labW = above ? 0 : Math.min(w * 0.4, Math.max(...labels.map(l => ctx.measureText(l).width)) + 12);
        const left = above ? 8 : labW + 8;
        const showVals = s.labels !== false && (s.stacked || series.length === 1);
        ctx.font = MONO(11);
        const fv = userFmt || autoFormat(sc0.step);
        const valW = showVals ? Math.max(...cats.map((_, i) => ctx.measureText(fv(this.segments(series, i).reduce((a, sg) => a + sg.v, 0))).width)) + 10 : 0;
        const right = w - 8 - valW;
        // The value axis runs across the plot: ask for as many ticks as fit side by side (a phone
        // gets 2–3, not 5 crowded ones). An explicit y.min / y.max keeps its domain and ticks; only
        // its labels are thinned.
        ctx.font = MONO(10.5);
        let sc;
        if (!finite(s.y?.min) && !finite(s.y?.max)) {
            const { lo, hi } = this.domainRaw();
            const fmtFor = v => (userFmt || autoFormat(sc0.step))(v);
            sc = fitTicks(lo, hi, right - left, v => ctx.measureText(fmtFor(v)).width, { maxCount: 5, gap: 14 });
        } else sc = thinScaleLabels(sc0, right - left, v => ctx.measureText(fv(v)).width, { gap: 14 });
        const f = userFmt || autoFormat(sc.step);
        const top = 4, bottom = H - 22;
        const n = cats.length;
        const bh = (bottom - top) / n;
        const x = v => left + ((v - sc.min) / (sc.max - sc.min || 1)) * (right - left);
        const k = s.stacked ? 1 : series.length;
        const gap = 2;
        const barH = Math.max(2, Math.min(24, ((bh - labH) * 0.7 - (k - 1) * gap) / k));
        const groupH = k * barH + (k - 1) * gap;
        this.geo = { left, right, top, bottom, bh, n, horizontal: true };

        if (this.hover != null) { ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fillRect(0, top + this.hover * bh, w, bh); }
        // vertical grid; tick labels stay inside the canvas (the last one used to be cut in half)
        ctx.font = MONO(10.5); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        sc.ticks.forEach((v, i) => {
            const px = Math.round(x(v)) + 0.5;
            ctx.strokeStyle = v === 0 ? t.axis : t.grid; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
            if (sc.show && !sc.show[i]) return;
            const half = ctx.measureText(f(v)).width / 2;
            ctx.fillStyle = t.text; ctx.fillText(f(v), clamp(px, half + 2, w - half - 2), H - 6);
        });
        for (let i = 0; i < n; i++) {
            const rowTop = top + i * bh;
            const cy = rowTop + labH + (bh - labH) / 2;
            ctx.font = SANS(12.5);
            let lab = labels[i];
            if (above) {
                // the name on its own line, full width, haloed over the gridlines
                while (lab.length > 4 && ctx.measureText(lab).width > w - 16) lab = `${lab.slice(0, -2)}…`;
                ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
                haloText(ctx, lab, left, rowTop + 13, t.strong, t.surface);
                ctx.textBaseline = 'middle';
            } else {
                ctx.fillStyle = t.strong; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
                while (lab.length > 4 && ctx.measureText(lab).width > labW - 6) lab = `${lab.slice(0, -2)}…`;
                ctx.fillText(lab, labW, cy);
            }
            const segs = this.segments(series, i);
            const lastPos = [...segs].reverse().find(sg => sg.v > 0);
            const lastNeg = [...segs].reverse().find(sg => sg.v < 0);
            for (const sg of segs) {
                const se = series[sg.k];
                const y0 = s.stacked ? cy - barH / 2 : cy - groupH / 2 + sg.k * (barH + gap);
                let xa = x(sg.a), xb = x(sg.b);
                const outer = sg === lastPos || sg === lastNeg;
                if (s.stacked && !outer && Math.abs(xb - xa) > 3) xb -= sg.v >= 0 ? 2 : -2;
                const end = !s.stacked || outer ? (sg.v >= 0 ? 'right' : 'left') : null;
                barPath(ctx, Math.min(xa, xb), y0, Math.max(xa, xb), y0 + barH, 4, end);
                if (se.outline) { ctx.fillStyle = rgba(cols[sg.k], 0.1); ctx.fill(); ctx.strokeStyle = cols[sg.k]; ctx.lineWidth = 1.5; ctx.stroke(); }
                else { ctx.fillStyle = cols[sg.k]; ctx.fill(); }
            }
            if (showVals && segs.length) {
                const tot = segs.reduce((a, sg) => a + sg.v, 0);
                const end = s.stacked ? x(segs.filter(sg => sg.v > 0).reduce((a, sg) => a + sg.v, 0)) : x(Math.max(0, tot));
                ctx.font = MONO(11); ctx.fillStyle = t.text; ctx.textAlign = 'left';
                ctx.fillText(fv(tot), end + 6, cy);
            }
            ctx.textBaseline = 'alphabetic';
        }
        this.tipAnchor = this.hover != null ? { x: Math.min(right, left + 40), y: top + this.hover * bh + labH + (bh - labH) / 2 } : null;
    }
    hitTest(x, y) {
        const g = this.geo;
        if (!g) return null;
        if (g.horizontal) { if (y < g.top || y > g.bottom) return null; return clamp(Math.floor((y - g.top) / g.bh), 0, g.n - 1); }
        if (x < g.left || x > g.right) return null;
        return clamp(Math.floor((x - g.left) / g.bw), 0, g.n - 1);
    }
    step(cur, dx, dy) {
        const n = this.spec.categories?.length || 0;
        if (!n) return undefined;
        if (dx === 'home') return 0;
        if (dx === 'end') return n - 1;
        const d = this.spec.horizontal ? dy || dx : dx;
        if (!d) return undefined;
        if (cur == null) return d > 0 ? 0 : n - 1;
        return clamp(cur + d, 0, n - 1);
    }
    pick(i) { this.spec.onPick?.(this.spec.categories[i], i); }
    tipFor(i) {
        const s = this.spec;
        if (!this.geo || i == null) return null;
        const f = s.y?.format || (x => fmt.num(x, Math.abs(x) < 10 ? 1 : 0));
        const rows = (s.series || []).map((se, k) => {
            const v = this.val(se, i);
            return { color: this.colorLater(se.color, k), kind: se.outline ? 'outline' : 'rect', value: v == null ? '—' : (se.format || f)(v), label: se.label ?? se.key };
        });
        if (s.stacked && rows.length > 1) {
            const tot = (s.series || []).reduce((a, se) => a + (this.val(se, i) ?? 0), 0);
            rows.reverse().push({ value: f(tot), label: s.totalLabel || 'Total' });
        }
        const c = s.categories[i];
        return { title: s.x?.tipFormat ? s.x.tipFormat(c, i) : s.x?.format ? s.x.format(c, i) : String(c), rows, ...this.tipAnchor };
    }
    tableSpec() {
        const s = this.spec;
        if (!s.categories?.length) return null;
        const f = s.y?.format || (x => fmt.num(x, Math.abs(x) < 10 ? 2 : 1));
        const columns = [{ key: '_c', label: s.x?.label || 'Category', sortable: false },
            ...(s.series || []).map((se, k) => ({ key: `s${k}`, label: se.label ?? se.key, align: 'right', format: v => (v == null ? '—' : (se.format || f)(v)) }))];
        const rows = s.categories.map((c, i) => {
            const r = { _c: s.x?.tipFormat ? s.x.tipFormat(c, i) : s.x?.format ? s.x.format(c, i) : String(c) };
            (s.series || []).forEach((se, k) => { r[`s${k}`] = this.val(se, i); });
            return r;
        });
        return { columns, rows };
    }
}

/* ── heatmap ────────────────────────────────────────────────────────────────── */

function dateTicks(labels) {
    // ISO date labels: tick the first of each month, labelled with the month.
    if (!labels?.length || !/^\d{4}-\d{2}-\d{2}$/.test(labels[0])) return null;
    const out = [];
    labels.forEach((l, i) => { if (l.endsWith('-01') || i === 0) out.push([i, MONTHS[+l.slice(5, 7) - 1]]); });
    if (out.length > 1 && out[1][0] - out[0][0] < 10) out.shift();
    return out;
}

class HeatmapChart extends Chart {
    printTableDefault() { return false; }
    defaultHeight(w) {
        const s = this.spec;
        const yCount = s.transpose ? s.rows : s.cols;
        void yCount;
        return w < 600 ? 220 : 280;
    }
    invalidate() { this.img = null; this.maskImg = null; }
    clampHover(hv) {
        const s = this.spec;
        if (!hv || !s.rows || !s.cols) return null;
        const { nx, ny } = this.dims();
        return { ix: clamp(hv.ix, 0, nx - 1), iy: clamp(hv.iy, 0, ny - 1) };
    }
    maskAt(ix, iy) {
        const s = this.spec;
        if (!s.mask) return false;
        const r = s.transpose ? ix : iy, c = s.transpose ? iy : ix;
        return !!s.mask[r * s.cols + c];
    }
    hasMask() {
        const m = this.spec.mask;
        if (!m || !m.length) return false;
        for (let i = 0; i < m.length; i++) if (m[i]) return true;
        return false;
    }
    /*
     * The mask overlay: masked cells hatched with alternating light and dark 135° stripes, so the
     * hatching shows on every ramp colour (a single ink vanishes on one end of the ramp). Built
     * once per data / size / theme at device resolution and drawn over the cells.
     */
    drawMask(ctx, left, top, pw, ph, nx, ny) {
        const dpr = this.dpr;
        const W = Math.max(1, Math.round(pw * dpr)), Hh = Math.max(1, Math.round(ph * dpr));
        const key = `${W}x${Hh}|${nx}x${ny}|${this.spec.transpose}|${this.t.surface}|${this.t.hatch}`;
        if (!this.maskImg || this.maskKey !== key) {
            const off = document.createElement('canvas');
            off.width = W; off.height = Hh;
            const o = off.getContext('2d');
            const cw = W / nx, ch = Hh / ny;
            o.fillStyle = '#fff';
            for (let iy = 0; iy < ny; iy++) {
                let run = -1;
                for (let ix = 0; ix <= nx; ix++) {
                    const m = ix < nx && this.maskAt(ix, iy);
                    if (m && run < 0) run = ix;
                    if (!m && run >= 0) { o.fillRect(Math.floor(run * cw), Math.floor(iy * ch), Math.ceil((ix - run) * cw), Math.ceil(ch)); run = -1; }
                }
            }
            const P = Math.max(4, Math.round(6 * dpr));
            const pat = document.createElement('canvas');
            pat.width = P; pat.height = P;
            const pc = pat.getContext('2d');
            const stripe = (off2, color, width) => {
                pc.strokeStyle = color; pc.lineWidth = width; pc.beginPath();
                for (const d of [-P, 0, P]) { pc.moveTo(d + off2, P); pc.lineTo(d + off2 + P, 0); }
                pc.stroke();
            };
            stripe(0, this.t.hatch, 1.2 * dpr);
            stripe(P / 2, rgba(this.t.surface, 0.7), 1.2 * dpr);
            o.globalCompositeOperation = 'source-in';
            o.fillStyle = o.createPattern(pat, 'repeat');
            o.fillRect(0, 0, W, Hh);
            this.maskImg = off;
            this.maskKey = key;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.maskImg, left, top, pw, ph);
    }
    dims() {
        const s = this.spec;
        // Without transpose: rows go down the y-axis, columns along x.
        return s.transpose ? { nx: s.rows, ny: s.cols, xl: s.rowLabels, yl: s.colLabels } : { nx: s.cols, ny: s.rows, xl: s.colLabels, yl: s.rowLabels };
    }
    valueAt(ix, iy) {
        const s = this.spec;
        const r = s.transpose ? ix : iy, c = s.transpose ? iy : ix;
        const v = s.values?.[r * s.cols + c];
        return finite(v) ? v : null;
    }
    draw(ctx, w, H) {
        const s = this.spec, t = this.t;
        if (!s.rows || !s.cols || !s.values) { this.geo = null; ctx.font = SANS(13); ctx.fillStyle = t.text; ctx.textAlign = 'center'; ctx.fillText('No data.', w / 2, H / 2); return; }
        const { nx, ny, xl, yl } = this.dims();
        const lut = this.ramp(s.scale);
        const sc = scaler(s.scale, s.values);
        this.sc = sc;
        const key = `${this._rampKey}|${sc.lo}|${sc.hi}|${s.transpose}`;
        if (!this.img || this.imgKey !== key) {
            const off = document.createElement('canvas');
            off.width = nx; off.height = ny;
            const octx = off.getContext('2d');
            const id = octx.createImageData(nx, ny);
            const empty = parseColor(t.empty);
            for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
                const v = this.valueAt(ix, iy);
                const o = (iy * nx + ix) * 4;
                if (v == null) { id.data[o] = empty[0]; id.data[o + 1] = empty[1]; id.data[o + 2] = empty[2]; id.data[o + 3] = 255; continue; }
                const li = Math.round(sc.t(v) * 255) * 4;
                id.data[o] = lut[li]; id.data[o + 1] = lut[li + 1]; id.data[o + 2] = lut[li + 2]; id.data[o + 3] = 255;
            }
            octx.putImageData(id, 0, 0);
            this.img = off;
            this.imgKey = key;
        }
        ctx.font = MONO(10.5);
        const yTicks = dateTicks(yl) || null;
        const yLabW = Math.max(28, ...(yTicks ? yTicks.map(x => ctx.measureText(x[1]).width) : (yl || []).slice(0, 200).map(l => ctx.measureText(String(l)).width)));
        const left = Math.ceil(Math.min(yLabW, 90)) + 10;
        const top = s.yLabel ? 18 : 6;
        const right = w - 6, bottom = H - 22;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.img, left, top, right - left, bottom - top);
        const cw = (right - left) / nx, ch = (bottom - top) / ny;
        this.geo = { left, right, top, bottom, cw, ch, nx, ny };
        this.masked = this.hasMask();
        if (this.masked) this.drawMask(ctx, left, top, right - left, bottom - top, nx, ny);

        // axes labels (month ticks thinned to every 2nd/3rd… month when they'd collide)
        ctx.fillStyle = t.text;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        if (yTicks) for (const [py, lab] of thinTicks(yTicks.map(([i, lab]) => [top + (i + 0.5) * ch, lab]), () => 11, { gap: 2 })) ctx.fillText(lab, left - 8, py);
        else if (yl) {
            const every = Math.max(1, Math.ceil(14 / ch));
            for (let i = 0; i < ny; i += every) ctx.fillText(String(yl[i]), left - 8, top + (i + 0.5) * ch);
        }
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'center';
        const xTicks = dateTicks(xl);
        if (xTicks) {
            const widthOf = lab => ctx.measureText(lab).width;
            for (const [px, lab] of thinTicks(xTicks.map(([i, lab]) => [left + (i + 0.5) * cw, lab]), widthOf, { gap: 8 })) {
                const half = widthOf(lab) / 2;
                ctx.fillText(lab, clamp(px, left + half, right - half), bottom + 15);
            }
        }
        else if (xl) {
            const maxW = Math.max(...xl.map(l => ctx.measureText(String(l)).width));
            const every = [1, 2, 3, 4, 6, 8, 12, 24].find(e => e * cw >= maxW + 10) || Math.ceil((maxW + 10) / cw);
            for (let i = 0; i < nx; i += every) ctx.fillText(String(xl[i]), clamp(left + (i + 0.5) * cw, left + maxW / 2, right - maxW / 2), bottom + 15);
        }
        if (s.yLabel) { ctx.textAlign = 'left'; ctx.fillText(s.yLabel, 2, 11); }

        if (this.hover) {
            const { ix, iy } = this.hover;
            ctx.strokeStyle = t.strong; ctx.lineWidth = 1.5;
            ctx.strokeRect(left + ix * cw - 0.5, top + iy * ch - 0.5, Math.max(2, cw) + 1, Math.max(2, ch) + 1);
            this.tipAnchor = { x: left + (ix + 0.5) * cw, y: top + (iy + 0.5) * ch };
        }
        this.drawScale(lut, sc);
    }
    drawScale(lut, sc) {
        const s = this.spec;
        const f = s.format || (v => fmt.num(v, 1));
        const stops = [];
        for (let i = 0; i <= 10; i++) { const k = Math.round((i / 10) * 255) * 4; stops.push(`rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]}) ${i * 10}%`); }
        const key = `${stops.join()}|${sc.lo}|${sc.hi}|${this.masked}|${s.maskLabel}|${s.scaleLabel}`;
        if (this.scaleKey === key) return;
        this.scaleKey = key;
        this.scaleHost.replaceChildren(h('div', { class: 'chart-scale' },
            h('span', null, f(sc.lo)),
            h('span', { class: 'chart-scale-bar', style: { background: `linear-gradient(90deg, ${stops.join(', ')})` } }),
            h('span', null, f(sc.hi)),
            s.scale?.ramp === 'diverging' && finite(sc.mid) ? h('span', { class: 'muted' }, `· mid ${f(sc.mid)}`) : null,
            s.scaleLabel ? h('span', null, s.scaleLabel) : null,
            this.masked ? h('span', { class: 'chart-scale-key' }, keyEl('hatch'), s.maskLabel || 'Estimated') : null));
    }
    hitTest(x, y) {
        const g = this.geo;
        if (!g || x < g.left || x > g.right || y < g.top || y > g.bottom) return null;
        return { ix: clamp(Math.floor((x - g.left) / g.cw), 0, g.nx - 1), iy: clamp(Math.floor((y - g.top) / g.ch), 0, g.ny - 1) };
    }
    step(cur, dx, dy) {
        const g = this.geo;
        if (!g) return undefined;
        if (dx === 'home') return { ix: 0, iy: cur?.iy ?? 0 };
        if (dx === 'end') return { ix: g.nx - 1, iy: cur?.iy ?? 0 };
        if (!cur) return { ix: 0, iy: 0 };
        return { ix: clamp(cur.ix + dx, 0, g.nx - 1), iy: clamp(cur.iy + dy, 0, g.ny - 1) };
    }
    pick(hv) { this.spec.onPick?.(this.spec.transpose ? hv.ix : hv.iy, this.spec.transpose ? hv.iy : hv.ix); }
    tipFor(hv) {
        if (!hv || !this.geo) return null;
        const s = this.spec;
        const { xl, yl } = this.dims();
        const v = this.valueAt(hv.ix, hv.iy);
        const f = s.format || (x => fmt.num(x, 1));
        const rowLab = s.transpose ? xl?.[hv.ix] : yl?.[hv.iy];
        const colLab = s.transpose ? yl?.[hv.iy] : xl?.[hv.ix];
        const fmtLab = l => (typeof l === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l) ? fmt.date(Date.parse(`${l}T12:00:00Z`)) : l ?? '');
        return {
            title: [fmtLab(rowLab), fmtLab(colLab)].filter(Boolean).join(' · '),
            rows: [{ color: v == null ? null : this.lutColor(this._lut, this.sc.t(v)), kind: 'rect', value: v == null ? 'no data' : f(v), label: s.valueLabel || '' }],
            note: this.maskAt(hv.ix, hv.iy) ? (s.maskLabel || 'Estimated') : null,
            ...this.tipAnchor,
        };
    }
    tableSpec() {
        const s = this.spec;
        if (!s.rows || !s.cols) return null;
        const f = s.format || (x => fmt.num(x, 1));
        const columns = [{ key: '_r', label: '', sortable: false },
            ...Array.from({ length: s.cols }, (_, c) => ({ key: `c${c}`, label: String(s.colLabels?.[c] ?? c), align: 'right', sortable: false, format: v => (v == null ? '—' : f(v)) }))];
        // masked cells keep their value with a marker, e.g. "0.42 (estimated)"
        const tag = ` (${String(s.maskLabel || 'Estimated').toLowerCase()})`;
        const columns2 = s.mask ? columns.map((col, k) => (k === 0 ? col : { ...col, format: (v, row) => (v == null ? '—' : `${f(v)}${row[`m${col.key}`] ? tag : ''}`) })) : columns;
        const rows = Array.from({ length: s.rows }, (_, r) => {
            const o = { _r: String(s.rowLabels?.[r] ?? r) };
            for (let c = 0; c < s.cols; c++) {
                const v = s.values[r * s.cols + c];
                o[`c${c}`] = finite(v) ? v : null;
                if (s.mask?.[r * s.cols + c]) o[`mc${c}`] = true;
            }
            return o;
        });
        return { columns: columns2, rows };
    }
}

/* ── polar: the solar rose ──────────────────────────────────────────────────── */

class PolarChart extends Chart {
    printTableDefault() { return false; }
    defaultHeight(w) {
        // The fan is half a disc: its height follows its radius (half the width), not the generic minimum.
        return this.half() ? clamp(w / 2 + 30, 160, 380) : Math.min(460, Math.max(260, w * 0.9));
    }
    height(w) { return this.spec.height ?? this.defaultHeight(w); }
    half() {
        const az = this.spec.azimuths || [];
        return az.length > 0 && az.every(a => a >= 85 && a <= 275);
    }
    legendItems() {
        const kinds = { best: 'Best', current: 'Current', pick: 'Your pick', reference: 'Reference' };
        const seen = new Map();
        for (const m of this.spec.markers || []) if (!seen.has(m.kind)) seen.set(m.kind, m);
        return [...seen.values()].filter(m => kinds[m.kind]).map(m => ({
            label: m.kind === 'best' ? 'Best (marked)' : kinds[m.kind], kind: m.kind === 'current' || m.kind === 'pick' ? 'ring' : 'dot',
            color: m.kind === 'best' || m.kind === 'pick' ? 'var(--accent)' : m.kind === 'current' ? 'var(--text)' : 'var(--text-2)',
        }));
    }
    clampHover(hv) {
        const a = this.spec.azimuths?.length || 0, b = this.spec.tilts?.length || 0;
        return hv && a && b ? { i: clamp(hv.i, 0, a - 1), j: clamp(hv.j, 0, b - 1) } : null;
    }
    grid() {
        const s = this.spec;
        const az = s.azimuths || [], ti = s.tilts || [];
        const azStep = az.length > 1 ? Math.min(...az.slice(1).map((a, i) => a - az[i]).filter(d => d > 0)) : 10;
        const tiStep = ti.length > 1 ? Math.min(...ti.slice(1).map((a, i) => a - ti[i]).filter(d => d > 0)) : 5;
        return { az, ti, azStep: finite(azStep) ? azStep : 10, tiStep: finite(tiStep) ? tiStep : 5 };
    }
    v(i, j) { const x = this.spec.values?.[i * (this.spec.tilts?.length || 0) + j]; return finite(x) ? x : null; }
    flatValue() {
        const { az, ti } = this.grid();
        const j = ti.indexOf(0);
        if (j < 0) return null;
        for (let i = 0; i < az.length; i++) { const x = this.v(i, j); if (x != null) return x; }
        return null;
    }
    draw(ctx, w, H) {
        const s = this.spec, t = this.t;
        const { az, ti, azStep, tiStep } = this.grid();
        if (!az.length || !ti.length) { this.geo = null; ctx.font = SANS(13); ctx.fillStyle = t.text; ctx.textAlign = 'center'; ctx.fillText('No sweep yet.', w / 2, H / 2); return; }
        const half = this.half();
        const pad = 30;
        const cx = w / 2;
        const R = half ? Math.max(40, Math.min(w / 2 - pad - 6, H - 26 - pad)) : Math.max(40, Math.min(w, H) / 2 - pad);
        const cy = half ? 24 : H / 2;
        const lut = this.ramp(s.scale ?? { hue: 'solar' });
        const vals = [];
        for (let i = 0; i < az.length; i++) for (let j = 0; j < ti.length; j++) { const x = this.v(i, j); if (x != null) vals.push(x); }
        const sc = scaler(s.scale ?? { hue: 'solar' }, vals);
        this.sc = sc;
        const rad = tilt => (clamp(tilt, 0, 90) / 90) * R;
        const ang = a => ((a - 90) * Math.PI) / 180;
        this.geo = { cx, cy, R, half, az, ti, azStep, tiStep };

        // backdrop: the full sweep envelope in the empty colour, so gaps read as "not computed"
        ctx.beginPath();
        if (half) { ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, 0, Math.PI); ctx.closePath(); } else ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = t.empty;
        ctx.fill();
        ctx.save();
        // The fan is a clean semicircle: E and W cells reach 5° past the flat edge, so clip them to it.
        if (half) { ctx.beginPath(); ctx.rect(0, cy, w, H - cy); ctx.clip(); }

        for (let i = 0; i < az.length; i++) {
            const a0 = ang(az[i] - azStep / 2), a1 = ang(az[i] + azStep / 2);
            for (let j = 0; j < ti.length; j++) {
                if (ti[j] === 0) continue;
                const x = this.v(i, j);
                if (x == null) continue;
                const r0 = rad(ti[j] - tiStep / 2), r1 = rad(ti[j] + tiStep / 2);
                ctx.beginPath();
                ctx.arc(cx, cy, r1, a0, a1);
                ctx.arc(cx, cy, r0, a1, a0, true);
                ctx.closePath();
                ctx.fillStyle = this.lutColor(lut, sc.t(x));
                ctx.fill();
                // a hair of the same colour hides anti-aliasing seams between neighbouring sectors
                ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.stroke();
            }
        }
        const flat = this.flatValue();
        if (flat != null) {
            ctx.beginPath();
            const r = rad(tiStep / 2);
            if (half) { ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, 0, Math.PI); ctx.closePath(); } else ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fillStyle = this.lutColor(lut, sc.t(flat));
            ctx.fill();
        }
        ctx.restore();

        // structure: tilt rings and compass spokes, drawn as faint surface-coloured lines over the cells
        ctx.strokeStyle = rgba(t.surface, 0.55);
        ctx.lineWidth = 1;
        for (const tr of [30, 60]) {
            ctx.beginPath();
            if (half) ctx.arc(cx, cy, rad(tr), 0, Math.PI); else ctx.arc(cx, cy, rad(tr), 0, Math.PI * 2);
            ctx.stroke();
        }
        const spokes = half ? [90, 135, 180, 225, 270] : [0, 45, 90, 135, 180, 225, 270, 315];
        for (const a of spokes) {
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(ang(a)), cy + R * Math.sin(ang(a))); ctx.stroke();
        }
        ctx.strokeStyle = t.axis;
        ctx.beginPath();
        if (half) { ctx.arc(cx, cy, R, 0, Math.PI); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); } else ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();

        // compass labels round the rim
        ctx.font = MONO(11, 600);
        ctx.fillStyle = t.strong;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const a of spokes) {
            const lab = fmt.compass(a);
            const lr = R + 15;
            let x = cx + lr * Math.cos(ang(a)), y = cy + lr * Math.sin(ang(a));
            if (half && (a === 90 || a === 270)) { y = cy + 10; x = cx + (a === 90 ? R + 15 : -R - 15); }
            ctx.fillText(lab, x, y);
        }
        // Tilt scale: above the flat edge in the fan (outside the cells, so always legible); up the
        // north spoke with a halo on the full rose.
        ctx.font = MONO(9.5);
        if (half) {
            ctx.fillStyle = t.text;
            ctx.textBaseline = 'alphabetic';
            for (const tr of [0, 30, 60, 90]) {
                ctx.textAlign = tr === 90 ? 'right' : 'center';
                ctx.fillText(tr === 0 ? 'flat' : `${tr}°`, tr === 90 ? cx + rad(tr) + 4 : cx + rad(tr), cy - 6);
            }
        } else {
            ctx.textAlign = 'left';
            for (const tr of [30, 60, 90]) haloText(ctx, `${tr}°`, cx + 4, cy - rad(tr) + 11, t.strong, t.surface);
        }
        ctx.textBaseline = 'alphabetic';

        // hover cell outline
        if (this.hover) {
            const { i, j } = this.hover;
            ctx.strokeStyle = t.strong;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (ti[j] === 0) {
                const r = rad(tiStep / 2);
                if (half) { ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, 0, Math.PI); ctx.closePath(); } else ctx.arc(cx, cy, r, 0, Math.PI * 2);
            } else {
                const a0 = ang(az[i] - azStep / 2), a1 = ang(az[i] + azStep / 2);
                ctx.arc(cx, cy, rad(ti[j] + tiStep / 2), a0, a1);
                ctx.arc(cx, cy, rad(ti[j] - tiStep / 2), a1, a0, true);
                ctx.closePath();
            }
            ctx.stroke();
            const am = ang(az[i]), rm = rad(ti[j]);
            this.tipAnchor = { x: cx + rm * Math.cos(am), y: cy + rm * Math.sin(am) };
        }

        // Markers on top; labels (with a surface halo) avoid every marker and each other.
        const marks = (s.markers || []).filter(m => finite(m.az) && finite(m.tilt)).map(m => {
            const am = ang(m.az), rm = rad(m.tilt);
            return { m, x: cx + rm * Math.cos(am), y: cy + rm * Math.sin(am) };
        });
        const placed = marks.map(({ x, y }) => [x - 7, y - 7, x + 7, y + 7]);
        for (const { m, x, y } of marks) {
            ctx.beginPath();
            if (m.kind === 'current' || m.kind === 'pick') {
                // the user's pick: a gold ring a size up, so it reads apart from 'current' (ink ring)
                ctx.arc(x, y, m.kind === 'pick' ? 8 : 6.5, 0, Math.PI * 2);
                ctx.lineWidth = 4; ctx.strokeStyle = t.surface; ctx.stroke();
                ctx.lineWidth = 2; ctx.strokeStyle = m.kind === 'pick' ? t.accent : t.strong; ctx.stroke();
            } else {
                ctx.arc(x, y, m.kind === 'best' ? 5.5 : 4, 0, Math.PI * 2);
                ctx.fillStyle = m.kind === 'best' ? t.accent : t.strong;
                ctx.fill();
                ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
            }
        }
        for (const { m, x, y } of marks) {
            if (m.label) {
                ctx.font = SANS(11.5, 600);
                const tw = ctx.measureText(m.label).width;
                const cands = [[x + 10, y + 4, 'left'], [x - 10, y + 4, 'right'], [x, y - 11, 'center'], [x, y + 19, 'center'],
                    [x + 8, y - 8, 'left'], [x - 8, y - 8, 'right'], [x + 8, y + 16, 'left'], [x - 8, y + 16, 'right']];
                for (const [lx, ly, al] of cands) {
                    const bx = al === 'left' ? lx : al === 'right' ? lx - tw : lx - tw / 2;
                    const box = [bx - 2, ly - 11, bx + tw + 2, ly + 3];
                    if (box[0] < 0 || box[2] > w || box[1] < 0 || box[3] > H) continue;
                    if (placed.some(p => !(box[2] < p[0] || box[0] > p[2] || box[3] < p[1] || box[1] > p[3]))) continue;
                    placed.push(box);
                    ctx.textAlign = al;
                    haloText(ctx, m.label, lx, ly, t.strong, t.surface);
                    break;
                }
            }
        }
        this.drawScale(lut, sc);
    }
    drawScale(lut, sc) {
        const s = this.spec;
        const f = s.format || (v => fmt.num(v, 0));
        const stops = [];
        for (let i = 0; i <= 10; i++) { const k = Math.round((i / 10) * 255) * 4; stops.push(`rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]}) ${i * 10}%`); }
        const key = `${stops.join()}|${sc.lo}|${sc.hi}|${s.metricLabel || ''}`;
        if (this.scaleKey === key) return;
        this.scaleKey = key;
        this.scaleHost.replaceChildren(h('div', { class: 'chart-scale' },
            s.metricLabel ? h('span', null, s.metricLabel) : null,
            h('span', null, f(sc.lo)),
            h('span', { class: 'chart-scale-bar', style: { background: `linear-gradient(90deg, ${stops.join(', ')})` } }),
            h('span', null, f(sc.hi))));
    }
    hitTest(x, y) {
        const g = this.geo;
        if (!g) return null;
        const dx = x - g.cx, dy = y - g.cy;
        const r = Math.hypot(dx, dy);
        if (r > g.R + 4) return null;
        if (g.half && dy < -4) return null;
        const tilt = (r / g.R) * 90;
        let a = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
        a = ((a % 360) + 360) % 360;
        let bi = -1, bd = Infinity;
        g.az.forEach((v, i) => { const d = Math.abs(((v - a + 540) % 360) - 180); if (d < bd) { bd = d; bi = i; } });
        if (bd > g.azStep && tilt > g.tiStep) return null;
        let bj = 0, bt = Infinity;
        g.ti.forEach((v, j) => { const d = Math.abs(v - tilt); if (d < bt) { bt = d; bj = j; } });
        return { i: bi, j: bj };
    }
    step(cur, dx, dy) {
        const g = this.geo;
        if (!g) return undefined;
        if (!cur) {
            const best = (this.spec.markers || []).find(m => m.kind === 'pick') || (this.spec.markers || []).find(m => m.kind === 'current') || (this.spec.markers || [])[0];
            if (best) {
                const i = g.az.reduce((b, v, k) => (Math.abs(v - best.az) < Math.abs(g.az[b] - best.az) ? k : b), 0);
                const j = g.ti.reduce((b, v, k) => (Math.abs(v - best.tilt) < Math.abs(g.ti[b] - best.tilt) ? k : b), 0);
                return { i, j };
            }
            return { i: Math.floor(g.az.length / 2), j: Math.floor(g.ti.length / 2) };
        }
        if (dx === 'home' || dx === 'end') return { i: dx === 'home' ? 0 : g.az.length - 1, j: cur.j };
        // Arrow keys follow the picture: in the fan, left is west (larger azimuth), down is steeper.
        const di = g.half ? -dx : dx;
        return { i: clamp(cur.i + di, 0, g.az.length - 1), j: clamp(cur.j + dy, 0, g.ti.length - 1) };
    }
    pick(hv) {
        const g = this.geo;
        if (!g || !hv) return;
        this.spec.onPick?.(g.az[hv.i], g.ti[hv.j]);
    }
    tipFor(hv) {
        const g = this.geo;
        if (!g || !hv) return null;
        const s = this.spec;
        const a = g.az[hv.i], tl = g.ti[hv.j];
        const v = tl === 0 ? this.flatValue() : this.v(hv.i, hv.j);
        const f = s.format || (x => fmt.num(x, 0));
        // tipLabel names the first row ('a year'); metricLabel ('£ a year') captions the scale
        const rows = [{ color: v == null ? null : this.lutColor(this._lut, this.sc.t(v)), kind: 'rect', value: v == null ? 'not computed' : f(v), label: s.tipLabel ?? s.metricLabel ?? '' }];
        if (s.tipRows) for (const r of s.tipRows(a, tl) || []) rows.push(r);
        const marks = (s.markers || []).filter(m => Math.abs(m.az - a) <= g.azStep / 2 && Math.abs(m.tilt - tl) <= g.tiStep / 2).map(m => m.label).filter(Boolean);
        return {
            title: tl === 0 ? 'Flat (0°)' : `${fmt.compass(a)} ${a}° · tilt ${tl}°`,
            rows, note: [marks.length ? marks.join(', ') : '', s.onPick ? 'Click to use this direction' : ''].filter(Boolean).join(' · ') || null,
            ...this.tipAnchor,
        };
    }
    tableSpec() {
        const s = this.spec;
        const { az, ti } = this.grid();
        if (!az.length) return null;
        const f = s.format || (x => fmt.num(x, 0));
        const columns = [{ key: '_t', label: 'Tilt', sortable: false },
            ...az.map((a, i) => ({ key: `a${i}`, label: `${fmt.compass(a)} ${a}°`, align: 'right', sortable: false, format: v => (v == null ? '—' : f(v)) }))];
        const rows = ti.map((tl, j) => {
            const r = { _t: `${tl}°` };
            az.forEach((_, i) => { r[`a${i}`] = tl === 0 ? this.flatValue() : this.v(i, j); });
            return r;
        });
        return { columns, rows };
    }
}

/* ── scatter ────────────────────────────────────────────────────────────────── */

class ScatterChart extends Chart {
    defaultHeight(w) { return w < 600 ? 260 : 340; }
    pointColor(p, i) { return this.color(p.color || p.route || null, i); }
    clampHover(hv) {
        const n = (this.spec.points || []).filter(p => finite(p.x) && finite(p.y)).length;
        return n > 0 && Number.isInteger(hv) ? clamp(hv, 0, n - 1) : null;
    }
    isHollow(p) { return !!p.hollow || p.route === 'whatif' || p.color === 'whatif'; }
    legendItems() {
        const s = this.spec;
        if (s.legend) return s.legend.map((l, i) => ({ label: l.label, color: l.color, index: i, kind: l.hollow ? 'ring' : l.kind || 'dot' }));
        const routes = [...new Set((s.points || []).map(p => p.route).filter(Boolean))];
        return routes.map(r => ({ label: ROUTE_LABELS[r] || r, color: r, kind: r === 'whatif' ? 'ring' : 'dot' }));
    }
    draw(ctx, w, H) {
        const s = this.spec, t = this.t;
        const pts = (s.points || []).filter(p => finite(p.x) && finite(p.y));
        if (!pts.length) { this.geo = null; ctx.font = SANS(13); ctx.fillStyle = t.text; ctx.textAlign = 'center'; ctx.fillText(s.emptyText || 'No options yet.', w / 2, H / 2); return; }
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of pts) {
            x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
            const lo = p.whisker && finite(p.whisker[0]) ? p.whisker[0] : p.y, hi = p.whisker && finite(p.whisker[1]) ? p.whisker[1] : p.y;
            y0 = Math.min(y0, p.y, lo); y1 = Math.max(y1, p.y, hi);
        }
        if (s.x?.zero !== false) x0 = Math.min(0, x0);
        if (s.y?.zero !== false) y0 = Math.min(0, y0);
        const xs = niceScale(finite(s.x?.min) ? s.x.min : x0, finite(s.x?.max) ? s.x.max : x1 + (x1 - x0) * 0.04, Math.max(3, Math.floor(w / 150)));
        const ys = niceScale(finite(s.y?.min) ? s.y.min : y0, finite(s.y?.max) ? s.y.max : y1 + (y1 - y0) * 0.06, 5);
        const xf = s.x?.format || autoFormat(xs.step), yf = s.y?.format || autoFormat(ys.step);
        const top = s.y?.label ? 22 : 10;
        const left = Math.max(s.gutter ?? 48, Math.ceil(this.measureTicks(ctx, ys, yf)) + 14);
        const right = w - 14;
        const bottom = H - 24 - (s.x?.label ? 14 : 0);
        const X = v => left + ((v - xs.min) / (xs.max - xs.min || 1)) * (right - left);
        const Y = v => bottom - ((v - ys.min) / (ys.max - ys.min || 1)) * (bottom - top);
        this.geo = { left, right, top, bottom, X, Y, pts };

        this.yAxis(ctx, ys, left, right, Y, yf);
        ctx.font = MONO(10.5); ctx.fillStyle = t.text; ctx.textAlign = 'center';
        for (const v of xs.ticks) {
            const px = Math.round(X(v)) + 0.5;
            ctx.strokeStyle = t.grid; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
            ctx.fillText(xf(v), clamp(px, left + 12, right - 12), bottom + 16);
        }
        if (s.y?.label) { ctx.textAlign = 'left'; ctx.fillText(s.y.label, 2, 12); }
        if (s.x?.label) { ctx.textAlign = 'right'; ctx.fillText(s.x.label, right, H - 3); }

        // isolines (e.g. "pays back in 5 yrs"), clipped to the plot
        ctx.save();
        ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
        const isoLabels = [];
        for (const iso of s.isolines || []) {
            const ip = (iso.points || []).filter(p => finite(p[0]) && finite(p[1]));
            if (ip.length < 2) continue;
            ctx.beginPath();
            ip.forEach((p, k) => (k ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
            ctx.strokeStyle = t.iso; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
            // Label where the curve meets the plot edge nearest the top: payback lines exit top/right,
            // iso-£ curves enter top-left — both away from the crowded bottom of the plot.
            const vis = [];
            for (let k = 1; k < ip.length; k++) {
                const ax = X(ip[k - 1][0]), ay = Y(ip[k - 1][1]), bx = X(ip[k][0]), by = Y(ip[k][1]);
                for (let q = 0; q <= 24; q++) {
                    const px = ax + ((bx - ax) * q) / 24, py = ay + ((by - ay) * q) / 24;
                    if (px >= left && px <= right && py >= top && py <= bottom) vis.push([px, py]);
                }
            }
            if (vis.length && iso.label) {
                const a = vis[0], b = vis[vis.length - 1];
                isoLabels.push([iso.label, a[1] <= b[1] ? a : b]);
            }
        }
        // Pareto front
        const front = (s.front || []).filter(p => finite(p[0]) && finite(p[1])).sort((a, b) => a[0] - b[0]);
        if (front.length > 1) {
            ctx.beginPath();
            front.forEach((p, k) => (k ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
            ctx.strokeStyle = rgba(t.front, 0.55); ctx.lineWidth = 1.5; ctx.stroke();
        }
        ctx.restore();
        ctx.font = MONO(10);
        const isoPlaced = [];
        for (const [lab, [px, py]] of isoLabels) {
            const tw = ctx.measureText(lab).width;
            const alignRight = px > right - tw - 8;
            const lx = alignRight ? px - 4 : px + 4;
            let ly = Math.max(top + 11, Math.min(bottom - 4, py + (py <= top + 2 ? 11 : -5)));
            const bx = alignRight ? lx - tw : lx;
            // Nudge down past an earlier iso label instead of overprinting it.
            for (const b of isoPlaced) if (!(bx + tw < b[0] || bx > b[2]) && Math.abs(ly - b[1]) < 12) ly = b[1] + 12;
            isoPlaced.push([bx, ly, bx + tw]);
            ctx.textAlign = alignRight ? 'right' : 'left';
            haloText(ctx, lab, lx, ly, t.text, t.surface);
        }

        // whiskers, then points (emphasised last so they sit on top)
        const order = pts.map((p, i) => ({ p, i })).sort((a, b) => (a.p.emphasis ? 1 : 0) - (b.p.emphasis ? 1 : 0));
        for (const { p, i } of order) {
            if (!p.whisker || !finite(p.whisker[0]) || !finite(p.whisker[1])) continue;
            const c = this.pointColor(p, i);
            const px = X(p.x);
            ctx.strokeStyle = rgba(c, 0.75); ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(px, Y(p.whisker[0])); ctx.lineTo(px, Y(p.whisker[1]));
            ctx.moveTo(px - 3, Y(p.whisker[0])); ctx.lineTo(px + 3, Y(p.whisker[0]));
            ctx.moveTo(px - 3, Y(p.whisker[1])); ctx.lineTo(px + 3, Y(p.whisker[1]));
            ctx.stroke();
        }
        const hoverIdx = this.hover;
        for (const { p, i } of order) {
            const c = this.pointColor(p, i);
            const px = X(p.x), py = Y(p.y);
            const r = (p.emphasis ? 6 : p.route === 'reference' ? 3.5 : 4.5) + (hoverIdx === pts.indexOf(p) ? 1.5 : 0);
            ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
            if (this.isHollow(p)) {
                ctx.fillStyle = t.surface; ctx.fill();
                ctx.lineWidth = 2; ctx.strokeStyle = c; ctx.stroke();
            } else {
                ctx.fillStyle = c; ctx.fill();
                ctx.lineWidth = 2; ctx.strokeStyle = t.surface; ctx.stroke();
            }
            if (p.emphasis) {
                ctx.beginPath(); ctx.arc(px, py, r + 3.5, 0, Math.PI * 2);
                ctx.lineWidth = 1.25; ctx.strokeStyle = rgba(t.strong, 0.7); ctx.stroke();
            }
        }
        // selective labels: emphasised points (and any with label + showLabel). They avoid each other
        // and the payback-line labels already drawn (a long name used to cover "pays back in 3 yrs").
        const placed = isoPlaced.map(([bx, ly, bx1]) => [bx - 2, ly - 11, bx1 + 2, ly + 3]);
        // The named points themselves (an emphasised one with its ring) are obstacles too, so a label
        // never sits on another named point ("S 35°" used to cover the "Best £" ring); each label
        // only ignores its own point.
        const named = order.filter(({ p }) => (p.emphasis || p.showLabel) && p.label);
        const dots = new Map(named.map(({ p }) => {
            const r = (p.emphasis ? 6 + 3.5 : p.route === 'reference' ? 3.5 : 4.5) + 1;
            const px = X(p.x), py = Y(p.y);
            return [p, [px - r, py - r, px + r, py + r]];
        }));
        ctx.font = SANS(11.5, 600);
        for (const { p } of [...order].reverse()) {
            if (!(p.emphasis || p.showLabel) || !p.label) continue;
            const px = X(p.x), py = Y(p.y);
            const tw = ctx.measureText(p.label).width;
            const others = [...dots].filter(([q]) => q !== p).map(([, b]) => b);
            const cands = [[px + 11, py + 4, 'left'], [px - 11, py + 4, 'right'], [px, py - 12, 'center'], [px, py + 19, 'center']];
            for (const [lx, ly, al] of cands) {
                const bx = al === 'left' ? lx : al === 'right' ? lx - tw : lx - tw / 2;
                const box = [bx - 2, ly - 11, bx + tw + 2, ly + 3];
                if (box[0] < left || box[2] > right || box[1] < top || box[3] > bottom) continue;
                if ([...placed, ...others].some(b => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]))) continue;
                placed.push(box);
                ctx.textAlign = al;
                haloText(ctx, p.label, lx, ly, t.strong, t.surface);
                break;
            }
        }
        if (hoverIdx != null && pts[hoverIdx]) this.tipAnchor = { x: X(pts[hoverIdx].x), y: Y(pts[hoverIdx].y) };
    }
    hitTest(x, y) {
        const g = this.geo;
        if (!g) return null;
        let best = null, bd = 24;   // nearest point within 24px: dots are 8–12px, targets must be bigger
        g.pts.forEach((p, i) => { const d = Math.hypot(g.X(p.x) - x, g.Y(p.y) - y); if (d < bd) { bd = d; best = i; } });
        return best;
    }
    step(cur, dx) {
        const g = this.geo;
        if (!g || !g.pts.length) return undefined;
        const order = g.pts.map((p, i) => i).sort((a, b) => g.pts[a].x - g.pts[b].x || g.pts[a].y - g.pts[b].y);
        if (dx === 'home') return order[0];
        if (dx === 'end') return order[order.length - 1];
        if (!dx) return undefined;
        if (cur == null) return order[dx > 0 ? 0 : order.length - 1];
        const k = order.indexOf(cur);
        return order[clamp(k + dx, 0, order.length - 1)];
    }
    pick(i) { const g = this.geo; if (g?.pts[i]) this.spec.onPick?.(g.pts[i]); }
    tipFor(i) {
        const g = this.geo;
        if (!g || i == null || !g.pts[i]) return null;
        const s = this.spec, p = g.pts[i];
        const xf = s.x?.format || (v => fmt.num(v, 0)), yf = s.y?.format || (v => fmt.num(v, 0));
        const rows = [
            { color: this.colorLater(p.color || p.route, i), kind: this.isHollow(p) ? 'ring' : 'dot', value: yf(p.y), label: s.y?.label || 'y' },
            { value: xf(p.x), label: s.x?.label || 'x' },
        ];
        if (p.whisker && finite(p.whisker[0]) && finite(p.whisker[1])) rows.push({ value: `${yf(p.whisker[0])}–${yf(p.whisker[1])}`, label: s.whiskerLabel || 'range' });
        if (p.extra) for (const r of p.extra) rows.push(r);
        return { title: p.label || '', rows, note: p.note || null, ...this.tipAnchor };
    }
    tableSpec() {
        const s = this.spec;
        const pts = (s.points || []).filter(p => finite(p.x) && finite(p.y));
        if (!pts.length) return null;
        const xf = s.x?.format || (v => fmt.num(v, 0)), yf = s.y?.format || (v => fmt.num(v, 0));
        const hasW = pts.some(p => p.whisker);
        const columns = [{ key: 'label', label: 'Option' },
            { key: 'x', label: s.x?.label || 'x', align: 'right', format: v => xf(v) },
            { key: 'y', label: s.y?.label || 'y', align: 'right', format: v => yf(v) }];
        if (hasW) columns.push({ key: 'w', label: s.whiskerLabel || 'Range', align: 'right', sortable: false, format: (v, r) => (r.whisker ? `${yf(r.whisker[0])}–${yf(r.whisker[1])}` : '—') });
        return { columns, rows: pts.map(p => ({ label: p.label || '', x: p.x, y: p.y, whisker: p.whisker })) };
    }
}

/* ── tornado ────────────────────────────────────────────────────────────────── */

class TornadoChart extends Chart {
    defaultHeight() { return Math.max(140, (this.spec.rows?.length || 0) * 38 + 46); }
    clampHover(hv) {
        const n = (this.spec.rows || []).filter(r => finite(r.low) || finite(r.high)).length;
        return n > 0 && Number.isInteger(hv) ? clamp(hv, 0, n - 1) : null;
    }
    legendItems() {
        const l = this.spec.legend || ['At the low setting', 'At the high setting'];
        return [{ label: l[0], color: '--tornado-low', kind: 'rect' }, { label: l[1], color: '--tornado-high', kind: 'rect' }];
    }
    draw(ctx, w, H) {
        const s = this.spec, t = this.t;
        const rows = (s.rows || []).filter(r => finite(r.low) || finite(r.high));
        if (!rows.length || !finite(s.center)) { this.geo = null; ctx.font = SANS(13); ctx.fillStyle = t.text; ctx.textAlign = 'center'; ctx.fillText('No sensitivity data yet.', w / 2, H / 2); return; }
        const f = s.format || (v => fmt.num(v, 1));
        let lo = s.center, hi = s.center;
        for (const r of rows) for (const v of [r.low, r.high]) if (finite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        ctx.font = SANS(12.5);
        const labW = Math.min(w * 0.36, Math.max(...rows.map(r => ctx.measureText(r.label).width)) + 12);
        const left = labW + 10, right = w - 12;
        const top = 22, bottom = H - 22;
        const bh = (bottom - top) / rows.length;
        const barH = Math.min(18, bh * 0.56);
        // Ticks thinned to what fits across the plot (5 crowded into 343 px read "2.2.4…").
        ctx.font = MONO(10.5);
        const tickW = v => ctx.measureText(f(v)).width;
        let sc = fitTicks(lo, hi, right - left, tickW, { maxCount: 5, gap: 12 });
        // Each bar's value label sits outside its end. Reserve room at both ends of the scale for
        // the longest one that would run off the plot (the bars get a little shorter instead), up to
        // 35% of the plot a side — always enough for the value alone, so no value is ever dropped.
        const texts = [];
        for (const r of rows) for (const [v, setting] of [[r.low, r.lowLabel], [r.high, r.highLabel]]) {
            if (finite(v) && v !== s.center) texts.push({ v, tw: ctx.measureText(setting ? `${setting} · ${f(v)}` : f(v)).width });
        }
        let x0 = left, x1 = right;
        for (let pass = 0; pass < 3; pass++) {
            const X0 = v => x0 + ((v - sc.min) / (sc.max - sc.min || 1)) * (x1 - x0);
            const cx0 = X0(s.center);
            let needL = 0, needR = 0;
            for (const { v, tw } of texts) {
                const xb = X0(v);
                if (xb > cx0) needR = Math.max(needR, xb + 6 + tw - (w - 4));
                else needL = Math.max(needL, (left - 4) - (xb - 6 - tw));
            }
            if (needL <= 0.5 && needR <= 0.5) break;
            const room = (right - left) * 0.35;   // never squeeze the bars below ~65% of the plot
            x0 = Math.min(left + room, x0 + Math.max(0, needL));
            x1 = Math.max(right - room, x1 - Math.max(0, needR));
        }
        // the labels now share a narrower axis: thin them for the width the bars actually got
        if (x1 - x0 < right - left - 0.5) sc = fitTicks(lo, hi, x1 - x0, tickW, { maxCount: 5, gap: 12 });
        const X = v => x0 + ((v - sc.min) / (sc.max - sc.min || 1)) * (x1 - x0);
        this.geo = { left, right, top, bottom, bh, rows };
        const cLow = this.color('--tornado-low'), cHigh = this.color('--tornado-high');

        if (this.hover != null) { ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.fillRect(0, top + this.hover * bh, w, bh); }
        ctx.font = MONO(10.5); ctx.textAlign = 'center';
        sc.ticks.forEach((v, i) => {
            const px = Math.round(X(v)) + 0.5;
            ctx.strokeStyle = t.grid; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke();
            if (sc.show && !sc.show[i]) return;
            const half = ctx.measureText(f(v)).width / 2;
            ctx.fillStyle = t.text; ctx.fillText(f(v), clamp(px, left + half, w - half - 2), H - 6);
        });
        const cx = Math.round(X(s.center)) + 0.5;
        rows.forEach((r, i) => {
            const cy = top + (i + 0.5) * bh;
            ctx.font = SANS(12.5); ctx.fillStyle = t.strong; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            let lab = r.label;
            while (lab.length > 4 && ctx.measureText(lab).width > labW - 4) lab = `${lab.slice(0, -2)}…`;
            ctx.fillText(lab, labW, cy);
            for (const [v, c, setting] of [[r.low, cLow, r.lowLabel], [r.high, cHigh, r.highLabel]]) {
                if (!finite(v) || v === s.center) continue;
                const xa = X(s.center), xb = X(v);
                barPath(ctx, Math.min(xa, xb), cy - barH / 2, Math.max(xa, xb), cy + barH / 2, 4, xb > xa ? 'right' : 'left');
                ctx.fillStyle = c; ctx.fill();
                // Value at the tip, best first: "setting · value" outside the bar; just the value
                // outside (the scale reserved room for that, so it always fits); the full text
                // inside a long bar (white on these mid-lightness fills). The setting is always in
                // the tooltip and the table.
                ctx.font = MONO(10.5);
                const out = xb > xa ? xb + 6 : xb - 6;
                const fitsOut = tw => (xb > xa ? out + tw <= w - 2 : out - tw >= left - 6);
                const full = setting ? `${setting} · ${f(v)}` : f(v);
                const fullW = ctx.measureText(full).width;
                const text = fitsOut(fullW) ? full : fitsOut(ctx.measureText(f(v)).width) ? f(v) : null;
                if (text) {
                    ctx.textAlign = xb > xa ? 'left' : 'right';
                    ctx.fillStyle = t.text;
                    ctx.fillText(text, out, cy);
                } else if (Math.abs(xb - xa) > fullW + 16) {
                    ctx.font = MONO(10.5, 600);
                    ctx.textAlign = xb > xa ? 'right' : 'left';
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(full, xb > xa ? xb - 7 : xb + 7, cy);
                }
            }
            ctx.textBaseline = 'alphabetic';
        });
        ctx.strokeStyle = t.strong; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(cx, top - 4); ctx.lineTo(cx, bottom); ctx.stroke();
        ctx.font = MONO(10.5, 600); ctx.textAlign = 'center';
        haloText(ctx, s.centerLabel || f(s.center), clamp(cx, left + 50, right - 50), top - 8, t.strong, t.surface);
        this.tipAnchor = this.hover != null ? { x: cx, y: top + (this.hover + 0.5) * bh } : null;
    }
    hitTest(x, y) { const g = this.geo; if (!g || y < g.top || y > g.bottom) return null; return clamp(Math.floor((y - g.top) / g.bh), 0, g.rows.length - 1); }
    step(cur, dx, dy) {
        const g = this.geo;
        if (!g) return undefined;
        const d = dy || dx;
        if (d === 'home') return 0;
        if (d === 'end') return g.rows.length - 1;
        if (!d) return undefined;
        if (cur == null) return d > 0 ? 0 : g.rows.length - 1;
        return clamp(cur + d, 0, g.rows.length - 1);
    }
    tipFor(i) {
        const g = this.geo;
        if (!g || i == null) return null;
        const s = this.spec, r = g.rows[i];
        const f = s.format || (v => fmt.num(v, 1));
        const swing = finite(r.low) && finite(r.high) ? Math.abs(r.high - r.low) : null;
        return {
            title: r.label,
            rows: [
                { color: 'var(--tornado-low)', kind: 'rect', value: f(r.low), label: r.lowLabel || 'low setting' },
                { color: 'var(--tornado-high)', kind: 'rect', value: f(r.high), label: r.highLabel || 'high setting' },
                { value: f(s.center), label: s.centerLabel ? 'central' : 'central value' },
            ],
            note: swing != null ? `Swing ${f(swing)}` : null,
            ...this.tipAnchor,
        };
    }
    tableSpec() {
        const s = this.spec;
        const f = s.format || (v => fmt.num(v, 1));
        if (!s.rows?.length) return null;
        return {
            columns: [
                { key: 'label', label: 'Driver' },
                { key: 'lowLabel', label: 'Low setting', sortable: false },
                { key: 'low', label: 'Result', align: 'right', format: v => f(v) },
                { key: 'highLabel', label: 'High setting', sortable: false },
                { key: 'high', label: 'Result', align: 'right', format: v => f(v) },
                { key: 'swing', label: 'Swing', align: 'right', format: v => f(v) },
            ],
            rows: s.rows.map(r => ({ ...r, lowLabel: r.lowLabel ?? '', highLabel: r.highLabel ?? '', swing: finite(r.low) && finite(r.high) ? Math.abs(r.high - r.low) : null })),
        };
    }
}

/* ── factories (contract §20) ───────────────────────────────────────────────── */

const api = c => ({ update: s => c.update(s), destroy: () => c.destroy(), setTable: b => c.setTable(b), get el() { return c.fig; } });

/**
 * Line chart. x: { values, format, tipFormat, label, type: 'category'|'linear'|'time' }; y: { label, format, min, max, zero };
 * series: [{ key, label, color, values, dash, area, format }] — null/NaN values are gaps, never zeros;
 *   a range band is a series with lo/hi instead of values: { key, label, color, lo: number[], hi: number[], format,
 *   loLabel, hiLabel, opacity } — filled at ~15% of its colour behind the lines, tooltip 'lo–hi', two table columns;
 * bands: [{ from, to, label }] (shaded x-ranges such as 4–7pm); markers: [{ x, label }];
 * optional: height, title, ariaLabel, tableCaption, note, endLabels (default on for 2–4 series), table, onTable(bool),
 * printTable (default true). A keyboard user's cursor survives update() while the chart has focus.
 * @param {HTMLElement} el @param {object} spec
 * @returns {{ update(spec: object): void, destroy(): void, setTable(on: boolean): void }}
 */
export function createLine(el, spec) { return api(new LineChart(el, spec, 'line')); }

/**
 * Stacked area: same spec as createLine; series stack in order (negatives stack below zero; a
 * zero half-hour of a below-zero layer stays below zero). A slot where every stacked layer is
 * null is a gap in the whole stack.
 * A series with `line: true` is drawn as an unstacked 2px line on top (e.g. total load).
 * Joins are smooth; `steps: true` (category x only) draws each slot as a flat step. `total: false` hides the tooltip total.
 * Fills are full-strength palette colours separated by 2px surface gaps (the validated encoding).
 * @param {HTMLElement} el @param {object} spec
 * @returns {{ update(spec: object): void, destroy(): void, setTable(on: boolean): void }}
 */
export function createStackedArea(el, spec) { return api(new StackedAreaChart(el, spec, 'area')); }

/**
 * Bars / columns. { categories, series: [{ key, label, color, values, outline }], stacked, horizontal, y: { label, format, min, max },
 * x: { format, tipFormat, label }, height, labels (horizontal value labels, default on), onPick(category, index) }.
 * @param {HTMLElement} el @param {object} spec
 * @returns {{ update(spec: object): void, destroy(): void, setTable(on: boolean): void }}
 */
export function createBars(el, spec) { return api(new BarChart(el, spec, 'bars')); }

/**
 * Heatmap. { rows, cols, values: Float32Array (row-major, NaN = no data), rowLabels, colLabels,
 * scale: { min, max, ramp: 'sequential'|'diverging'|'solar', hue?: 'solar', mid? }, format, height,
 * transpose (rows run along x — e.g. days across, half-hours down), valueLabel, yLabel, scaleLabel,
 * mask (Uint8Array, same layout as values: truthy cells are hatched), maskLabel (default 'Estimated':
 * the hatch's key, tooltip note and table marker) }.
 * ISO-date labels get month ticks automatically, thinned to every 2nd/3rd… month when they'd collide.
 * @param {HTMLElement} el @param {object} spec
 * @returns {{ update(spec: object): void, destroy(): void, setTable(on: boolean): void }}
 */
export function createHeatmap(el, spec) { return api(new HeatmapChart(el, spec, 'heatmap')); }

/**
 * The solar rose: azimuth around the dial (N up, E right), tilt as radius from flat at the centre to
 * vertical at the rim. If every azimuth lies within 90–270° only the southern fan is drawn.
 * { azimuths, tilts, values (az-major: values[i*tilts.length + j]), markers: [{ az, tilt, label, kind: 'best'|'current'|'pick'|'reference' }],
 *   format, metricLabel (scale caption), tipLabel (first tooltip row's label; default metricLabel), scale (default solar ramp),
 *   onPick(az, tilt), tipRows(az, tilt) → extra tooltip rows }. 'pick' (the user's choice) is a gold ring.
 * @param {HTMLElement} el @param {object} spec
 * @returns {{ update(spec: object): void, destroy(): void, setTable(on: boolean): void }}
 */
export function createPolar(el, spec) { return api(new PolarChart(el, spec, 'polar')); }

/**
 * Scatter. { points: [{ x, y, label, color | route, whisker: [lo, hi], emphasis, hollow, showLabel, extra: tipRows, note }],
 * x/y: { label, format, min, max, zero }, isolines: [{ points: [[x, y]…], label }], front: [[x, y]…], legend, onPick(point), height }.
 * Route keys colour points; 'whatif' draws a hollow ring and 'reference' a small muted dot.
 * @param {HTMLElement} el @param {object} spec
 * @returns {{ update(spec: object): void, destroy(): void, setTable(on: boolean): void }}
 */
export function createScatter(el, spec) { return api(new ScatterChart(el, spec, 'scatter')); }

/**
 * Tornado (sensitivity) chart: horizontal bars from `center` to each driver's low and high result.
 * { center, centerLabel, rows: [{ label, low, high, lowLabel, highLabel }], format, legend: [lowName, highName] }.
 * Ticks are thinned to the plot width and the scale leaves room for every bar-end label.
 * @param {HTMLElement} el @param {object} spec
 * @returns {{ update(spec: object): void, destroy(): void, setTable(on: boolean): void }}
 */
export function createTornado(el, spec) { return api(new TornadoChart(el, spec, 'tornado')); }

/** Redraw every live chart (e.g. after a theme-token change). */
export function rerenderAll() { for (const c of live) c.render(); }

/**
 * Enter or leave print mode: every chart redraws with the current (print) tokens and builds its
 * table twin so the numbers reach paper — heatmaps and the polar sweep only when their spec sets
 * printTable: true. The app calls this from beforeprint / afterprint.
 * @param {boolean} on
 */
export function setPrintMode(on) {
    printingNow = !!on;
    for (const c of live) c.setPrint(printingNow);
}
