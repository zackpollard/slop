/*
 * ui.js — DOM helpers and the shared component set (contract §19).
 *
 * Every component returns a plain HTMLElement (sometimes with a couple of methods hung on it) and
 * styles itself through classes in css/style.css. Nothing here touches `document` at import time,
 * so `fmt` stays importable from node tests and from the worker-free parts of other modules.
 *
 * Untrusted text (CSV headers, API strings, account data) only ever reaches the DOM through
 * text nodes — there is no innerHTML anywhere in this file.
 */

import { getApiKey, setApiKey } from './store.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUS = '−';
const DASH = '—';

/* ── formatting ─────────────────────────────────────────────────────────────── */

const ok = v => typeof v === 'number' && Number.isFinite(v);
const grouped = (v, dp) => v.toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
// Rounding can turn −0.004 into "−0.00"; a sign only belongs on a number that survives rounding.
const signOf = (v, dp) => (Math.abs(v) < 0.5 * 10 ** -dp ? '' : v < 0 ? MINUS : '');
const stripZero = s => s.replace(/\.0+(?=\D*$)/, '');

const COMPASS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
let dateFmt = null;

/**
 * Number formatters used everywhere in the UI. All return '—' for null/NaN/±Infinity (except
 * `years`, where a missing payback means it never pays back). Negative values use a real minus.
 */
export const fmt = {
    /** £ with thousands separators: fmt.gbp(1234.5) → '£1,235'; { dp: 2 } → '£1,234.50'; { compact: true } → '£12.3k'. */
    gbp(v, { dp = 0, compact = false } = {}) {
        if (!ok(v)) return DASH;
        const a = Math.abs(v);
        if (compact && a >= 10_000) return `${signOf(v, 1)}£${stripZero(grouped(a / 1000, a >= 100_000 ? 0 : 1))}k`;
        return `${signOf(v, dp)}£${grouped(a, dp)}`;
    },
    /** Pence in, pounds out: fmt.gbpFromP(16450) → '£165'. */
    gbpFromP(p, opts) { return ok(p) ? fmt.gbp(p / 100, opts) : DASH; },
    /** p/kWh: fmt.p(24.31) → '24.3p'. */
    p(v, { dp = 1 } = {}) { return ok(v) ? `${signOf(v, dp)}${grouped(Math.abs(v), dp)}p` : DASH; },
    /** Energy with sensible precision: 0.42 → '0.42 kWh', 12.34 → '12.3 kWh', 1234 → '1,234 kWh'. */
    kwh(v, { dp } = {}) {
        if (!ok(v)) return DASH;
        const a = Math.abs(v);
        const d = dp ?? (a >= 100 ? 0 : a >= 1 ? 1 : 2);
        return `${signOf(v, d)}${grouped(a, d)} kWh`;
    },
    /** Power: 500 → '500 W', 12_345 → '12.3 kW'. */
    w(v, { dp } = {}) {
        if (!ok(v)) return DASH;
        const a = Math.abs(v);
        if (a >= 10_000) return `${signOf(v, 1)}${stripZero(grouped(a / 1000, dp ?? 1))} kW`;
        return `${signOf(v, dp ?? 0)}${grouped(a, dp ?? 0)} W`;
    },
    /** Percent from a 0–100 number: 42.4 → '42%', 4.25 → '4.3%', 5 → '5%'. */
    pct(v, { dp } = {}) {
        if (!ok(v)) return DASH;
        const a = Math.abs(v);
        const d = dp ?? (a < 10 ? 1 : 0);
        return `${signOf(v, d)}${dp == null ? stripZero(grouped(a, d)) : grouped(a, d)}%`;
    },
    /** Payback-style years: 6.43 → '6.4 yrs', null/Infinity/negative → 'never', >50 → '50+ yrs'. */
    years(v, { dp = 1 } = {}) {
        if (v == null || !Number.isFinite(v) || v < 0) return 'never';
        if (v > 50) return '50+ yrs';
        const s = grouped(v, dp);
        return `${s} ${Math.abs(v - 1) < 0.05 ? 'yr' : 'yrs'}`;
    },
    /** A UK calendar date: fmt.date(ms) → '5 Oct 2026' (Europe/London). */
    date(ms, { year = true } = {}) {
        if (!ok(ms)) return DASH;
        try {
            dateFmt ??= {
                y: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }),
                n: new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short' }),
            };
            return (year ? dateFmt.y : dateFmt.n).format(ms).replace('Sept', 'Sep');
        } catch {
            const d = new Date(ms);
            return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
        }
    },
    /** 'YYYY-MM' → 'Oct 2025'; a month0 number → 'Oct'. */
    month(key) {
        if (typeof key === 'number') return MONTHS[((key % 12) + 12) % 12] ?? DASH;
        const m = /^(\d{4})-(\d{2})/.exec(String(key ?? ''));
        return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : DASH;
    },
    /** 16-point compass name for a compass azimuth (0 = N, 90 = E): 202 → 'SSW'. */
    compass(az) {
        if (!ok(az)) return DASH;
        return COMPASS16[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
    },
    /** Grouped number: fmt.num(12345.678, 1) → '12,345.7'. */
    num(v, dp = 0) { return ok(v) ? `${signOf(v, dp)}${grouped(Math.abs(v), dp)}` : DASH; },
    /** A low–high pair with one formatter: fmt.range(120, 180, fmt.gbp) → '£120–£180'. */
    range(lo, hi, f = fmt.num) { return ok(lo) && ok(hi) ? `${f(lo)}–${f(hi)}` : DASH; },
};

/* ── element factory ────────────────────────────────────────────────────────── */

const PROP_KEYS = new Set(['value', 'checked', 'selected', 'indeterminate', 'textContent']);
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'line', 'polyline', 'polygon', 'rect', 'text', 'tspan', 'defs',
    'linearGradient', 'radialGradient', 'stop', 'title', 'ellipse', 'clipPath', 'mask', 'use']);

function classString(c) {
    if (!c) return '';
    if (Array.isArray(c)) return c.filter(Boolean).map(classString).join(' ');
    if (typeof c === 'object') return Object.entries(c).filter(([, v]) => v).map(([k]) => k).join(' ');
    return String(c);
}

function appendChildren(el, children) {
    for (const c of children) {
        if (c == null || c === false || c === true) continue;
        if (Array.isArray(c)) appendChildren(el, c);
        else if (c instanceof Node) el.appendChild(c);
        else el.appendChild(document.createTextNode(String(c)));
    }
}

/**
 * Create an element. `attrs`: class (string | array | {name: bool}), style (object or string),
 * on: { event: handler }, dataset: {}, aria-* / any attribute (true → present, false/null → absent),
 * value/checked/selected set as properties. Children may be nodes, strings, numbers, null or arrays.
 * SVG tags are created in the SVG namespace automatically.
 * @param {string} tag
 * @param {object|null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
    const isSvg = SVG_TAGS.has(tag);
    const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
    // A non-object second argument is a child — including falsy ones like 0, which must still render.
    if (attrs != null && attrs !== false && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
        children.unshift(attrs);
        attrs = null;
    }
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v == null || v === false) continue;
        if (k === 'class' || k === 'className') { const c = classString(v); if (c) el.setAttribute('class', c); }
        else if (k === 'style') {
            if (typeof v === 'string') el.setAttribute('style', v);
            else for (const [p, val] of Object.entries(v)) if (val != null) {
                if (p.startsWith('--')) el.style.setProperty(p, String(val)); else el.style[p] = val;
            }
        }
        else if (k === 'on') { for (const [ev, fn] of Object.entries(v)) if (fn) el.addEventListener(ev, fn); }
        else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v)) if (dv != null) el.dataset[dk] = dv; }
        else if (k === 'text') el.textContent = String(v);
        else if (PROP_KEYS.has(k) && !isSvg) el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    appendChildren(el, children);
    return el;
}

let uid = 0;
/** @param {string} [prefix] @returns {string} a document-unique id */
export function uniqueId(prefix = 'sc') { uid += 1; return `${prefix}-${uid}`; }

/**
 * Null-safe replaceChildren: null/false/true are dropped and arrays flattened (the native call
 * prints the text "null"). Strings and numbers become text nodes.
 * @param {Element} el
 * @param {...any} kids
 * @returns {Element} el
 */
export function put(el, ...kids) {
    el.replaceChildren();
    appendChildren(el, kids);
    return el;
}

const FOCUSABLE = 'input:not([type="hidden"]), select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])';

/**
 * The control to focus in (or at) a holder element: a checked radio of a radiogroup, else the
 * holder itself when focusable, else its first field, button or focusable element.
 * @param {Element|null} holder
 * @returns {HTMLElement|null}
 */
export function controlIn(holder) {
    if (!holder) return null;
    if (holder.matches?.(FOCUSABLE)) return holder;
    // two queries: a selector list matches in document order, so "checked radio, else first
    // control" in one call would return the group's first option
    return holder.querySelector?.('[role="radio"][aria-checked="true"]') ?? holder.querySelector?.(FOCUSABLE) ?? null;
}

const usable = el => !!el && el.isConnected !== false && !el.disabled && !el.closest?.('[hidden], [inert]')
    && (typeof el.offsetParent === 'undefined' || el.offsetParent !== null || el.getClientRects?.().length > 0);

/**
 * Re-render part of the page without dropping keyboard focus to <body>. Mark rebuildable controls
 * with `data-fk="<stable key>"` (on the control or a wrapper). keepFocus notes which [data-fk] holds
 * focus, runs build(), and — if that element was replaced — focuses its rebuilt twin.
 *   - `target` (a selector, element or function → element) is a deliberate new focus target that
 *     wins when it resolves (e.g. "the next field").
 *   - `fallback` (same forms) is used only when focus was inside `host` and no twin survived
 *     (disabled, hidden or gone) — typically the section heading (tabindex -1).
 * Focus outside `host` is never touched.
 * @param {HTMLElement} host
 * @param {() => void} build
 * @param {string|Element|(() => Element|null)|null} [target]
 * @param {{ fallback?: string|Element|(() => Element|null), preventScroll?: boolean }} [opts]
 * @returns {HTMLElement|null} the element focused, if any
 */
export function keepFocus(host, build, target = null, { fallback = null, preventScroll = true } = {}) {
    const doc = host?.ownerDocument ?? (typeof document !== 'undefined' ? document : null);
    const a = doc?.activeElement ?? null;
    const inside = !!(a && a !== doc.body && host.contains(a));
    const fk = inside ? a.closest?.('[data-fk]')?.dataset?.fk ?? null : null;
    build();
    const resolve = t => {
        const el = !t ? null : typeof t === 'string' ? host.querySelector(t) : typeof t === 'function' ? t() : t;
        // a heading with tabindex="-1" is a valid programmatic target; anything else resolves to its control
        return el && el.hasAttribute?.('tabindex') ? el : controlIn(el);
    };
    const focus = el => { try { el.focus({ preventScroll }); } catch { el.focus?.(); } return el; };
    const wanted = resolve(target);
    if (usable(wanted)) return focus(wanted);
    if (!inside) return null;
    if (a.isConnected !== false && host.contains(a) && usable(a)) return a;   // not rebuilt: leave it alone
    const esc = s => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
    const twin = fk != null ? controlIn(host.querySelector(`[data-fk="${esc(fk)}"]`)) : null;
    if (usable(twin)) return focus(twin);
    const fb = resolve(fallback);
    return fb ? focus(fb) : null;
}

/**
 * The `behavior` for scrollIntoView / scrollTo: 'smooth', or 'auto' (an instant jump) when the user
 * asks for reduced motion. The CSS reduced-motion rule can't reach a JS smooth scroll, so every
 * call site passes `{ behavior: scrollBehavior() }` instead of a hard-coded 'smooth'.
 * @returns {'smooth'|'auto'}
 */
export function scrollBehavior() {
    try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    } catch {
        return 'smooth';
    }
}

/* Small inline icon set (stroke icons on a 16px grid). */
const ICONS = {
    check: 'M3.5 8.5l3 3 6-7',
    x: 'M4 4l8 8M12 4l-8 8',
    info: 'M8 7.2v4.3M8 4.6v.1M8 14.5A6.5 6.5 0 1 0 8 1.5a6.5 6.5 0 0 0 0 13z',
    alert: 'M8 5.5v3.5M8 11.2v.1M7.1 2.3L1.6 12a1 1 0 0 0 .9 1.5h11a1 1 0 0 0 .9-1.5L8.9 2.3a1 1 0 0 0-1.8 0z',
    table: 'M2 3.5h12v9H2zM2 6.5h12M2 9.5h12M6 3.5v9',
    chart: 'M2 13.5h12M4 11V8M7 11V4.5M10 11V7M13 11V5.5',
    chevron: 'M5 6.5l3 3 3-3',
    external: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3.5h-9v-9H6',
    lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v6.5h-9z',
    refresh: 'M13 3v3.5H9.5M3 13V9.5h3.5M12.6 6.4A5 5 0 0 0 4 4.5L3 5.5M3.4 9.6A5 5 0 0 0 12 11.5l1-1',
    eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    eyeOff: 'M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.2 4.7C2.6 5.9 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.5-.4 3.5-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2.1',
    upload: 'M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v3h11v-3',
    download: 'M8 2.5v8M5 7.5l3 3 3-3M2.5 10.5v3h11v-3',
    pencil: 'M10.5 2.5l3 3L6 13H3v-3z',
    sun: 'M8 10.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9L13 13M3 13l1.1-1.1M11.9 4.1L13 3',
    arrowRight: 'M3 8h10M9 4l4 4-4 4',
    print: 'M4.5 6V2.5h7V6M4.5 11.5h-2v-5.5h11v5.5h-2M4.5 9.5h7v4h-7z',
};

/**
 * A 16px stroke icon.
 * @param {keyof ICONS} name
 * @param {{ size?: number, label?: string }} [opts] label makes it an image with that accessible name
 * @returns {SVGElement}
 */
export function icon(name, { size = 16, label } = {}) {
    const svg = h('svg', {
        class: 'icon', width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label || null,
    }, h('path', { d: ICONS[name] || ICONS.info }));
    return svg;
}

/**
 * A button (or a link styled as one when `href` is given).
 * @param {{ label: string|Node, onClick?: Function, kind?: 'default'|'primary'|'ghost'|'link'|'danger',
 *   size?: 'sm'|'md', icon?: string, href?: string, title?: string, disabled?: boolean, type?: string }} o
 * @returns {HTMLElement}
 */
export function button({ label, onClick, kind = 'default', size = 'md', icon: ic, href, title, disabled, type = 'button', ariaLabel } = {}) {
    const cls = ['btn', kind !== 'default' && `btn-${kind}`, size === 'sm' && 'btn-sm'];
    const kids = [ic ? icon(ic) : null, label != null ? h('span', null, label) : null];
    if (href) return h('a', { class: cls, href, title, 'aria-label': ariaLabel, on: { click: onClick } }, kids);
    return h('button', { class: cls, type, title, disabled: !!disabled, 'aria-label': ariaLabel, on: { click: onClick } }, kids);
}

/* ── display components ─────────────────────────────────────────────────────── */

/**
 * A figure tile: small label, large value, optional unit and sub-line.
 * @param {{ label: string, value: string|number|Node|null, unit?: string, sub?: string|Node, tone?: 'default'|'accent'|'good'|'warn'|'bad',
 *   help?: string, loading?: boolean }} o
 * @returns {HTMLElement}
 */
export function statTile({ label, value, unit, sub, tone = 'default', help, loading = false } = {}) {
    const lab = h('div', { class: 'stat-label' }, h('span', null, label));
    if (help) {
        const q = h('button', { class: 'help-dot', type: 'button', 'aria-label': `About: ${label}` }, '?');
        tooltip(q, help);
        lab.appendChild(q);
    }
    let val;
    if (loading) val = h('div', { class: 'stat-value' }, h('span', { class: 'shimmer shimmer-value' }));
    else val = h('div', { class: 'stat-value' },
        value instanceof Node ? value : value == null || value === '' ? DASH : String(value),
        unit ? h('span', { class: 'stat-unit' }, unit) : null);
    return h('div', { class: ['stat', `tone-${tone}`], 'aria-busy': loading ? 'true' : null },
        lab, val, sub != null && sub !== '' ? h('div', { class: 'stat-sub' }, sub) : null);
}

/**
 * A surface card with an optional header row.
 * @param {{ title?: string|Node, subtitle?: string|Node, eyebrow?: string, actions?: Node|Node[], body?: any,
 *   accent?: boolean, id?: string, level?: number, className?: string }} o
 * @returns {HTMLElement}
 */
export function card({ title, subtitle, eyebrow, actions, body, accent = false, id, level = 2, className } = {}) {
    const hasHead = title || subtitle || eyebrow || actions;
    const head = hasHead ? h('header', { class: 'card-head' },
        h('div', { class: 'card-titles' },
            eyebrow ? h('div', { class: 'card-eyebrow' }, eyebrow) : null,
            title ? h(`h${Math.min(6, Math.max(2, level))}`, { class: 'card-title' }, title) : null,
            subtitle ? h('p', { class: 'card-sub' }, subtitle) : null),
        actions ? h('div', { class: 'card-actions' }, actions) : null) : null;
    return h('section', { class: ['card', accent && 'card-accent', className], id },
        head, h('div', { class: 'card-body' }, body));
}

/**
 * Collapsible section built on <details>.
 * @param {{ summary: string|Node, body: any, open?: boolean, id?: string, className?: string, onToggle?: (open: boolean) => void }} o
 * @returns {HTMLDetailsElement}
 */
export function details({ summary, body, open = false, id, className, onToggle } = {}) {
    const d = h('details', { class: ['disclosure', className], id, open: !!open },
        h('summary', null, h('span', { class: 'disclosure-summary' }, summary), icon('chevron')),
        h('div', { class: 'disclosure-body' }, body));
    if (onToggle) d.addEventListener('toggle', () => onToggle(d.open));
    return d;
}

/**
 * A small pill. Tones: default, accent, good, warn, bad, info, and route tones plugin | hardwired | ups | whatif | reference
 * (which add a coloured dot keyed to the chart route colours).
 * @param {{ text: string, tone?: string, title?: string }} o
 * @returns {HTMLElement}
 */
export function badge({ text, tone = 'default', title } = {}) {
    const route = ['plugin', 'hardwired', 'ups', 'whatif', 'reference'].includes(tone);
    return h('span', { class: ['badge', `badge-${tone}`], title },
        route ? h('span', { class: 'badge-dot', 'aria-hidden': 'true' }) : null, text);
}

let tipEl = null;
function tipLayer() {
    if (!tipEl) {
        tipEl = h('div', { class: 'ui-tip', role: 'tooltip', 'aria-hidden': 'true' });
        document.body.appendChild(tipEl);
    }
    return tipEl;
}

/**
 * Attach a hover/focus tooltip to an element. The text is also set as the element's accessible
 * description (aria-description), so screen readers get it without hovering.
 * @param {HTMLElement} el
 * @param {string} text
 * @returns {{ setText(t: string): void, destroy(): void }}
 */
export function tooltip(el, text) {
    let current = text;
    el.setAttribute('aria-description', text);
    const show = () => {
        const tip = tipLayer();
        tip.textContent = current;
        tip.classList.add('show');
        const r = el.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        const x = Math.min(window.innerWidth - tw - 8, Math.max(8, r.left + r.width / 2 - tw / 2));
        const above = r.top - th - 8;
        tip.style.left = `${x}px`;
        tip.style.top = `${above > 8 ? above : r.bottom + 8}px`;
    };
    const hide = () => tipEl && tipEl.classList.remove('show');
    const onKey = e => { if (e.key === 'Escape') hide(); };
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerleave', hide);
    el.addEventListener('focus', show);
    el.addEventListener('blur', hide);
    el.addEventListener('keydown', onKey);
    return {
        setText(t) { current = t; el.setAttribute('aria-description', t); },
        destroy() {
            el.removeEventListener('pointerenter', show); el.removeEventListener('pointerleave', hide);
            el.removeEventListener('focus', show); el.removeEventListener('blur', hide);
            el.removeEventListener('keydown', onKey); el.removeAttribute('aria-description'); hide();
        },
    };
}

let toastHost = null;
/**
 * Show a transient message (announced politely to screen readers).
 * @param {string} message
 * @param {{ tone?: 'default'|'good'|'warn'|'bad', timeoutMs?: number, action?: { label: string, onClick: Function } }} [opts]
 * @returns {{ close(): void }}
 */
export function toast(message, { tone = 'default', timeoutMs = 4500, action } = {}) {
    if (!toastHost || !toastHost.isConnected) {
        toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
        document.body.appendChild(toastHost);
    }
    // Where focus was when the toast appeared: pressing its Undo or ✕ removes the button that has
    // focus, so focus goes back there instead of falling to <body>.
    const before = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    let timer = null;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        const hadFocus = el.contains(document.activeElement);
        el.classList.remove('show');
        setTimeout(() => el.remove(), 250);
        if (hadFocus && before && before.isConnected && !before.disabled) before.focus({ preventScroll: true });
    };
    const el = h('div', { class: ['toast-item', `tone-${tone}`] },
        tone !== 'default' ? icon(tone === 'good' ? 'check' : tone === 'bad' ? 'alert' : 'info') : null,
        h('span', { class: 'toast-msg' }, message),
        action ? h('button', { class: 'toast-action', type: 'button', on: { click: () => { action.onClick(); close(); } } }, action.label) : null,
        h('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', on: { click: close } }, icon('x')));
    toastHost.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    if (timeoutMs > 0) timer = setTimeout(close, timeoutMs);
    return { close };
}

/**
 * A modal dialog (native <dialog>: focus is trapped and Escape closes it).
 * @param {{ title: string, body: any, actions?: Array<{ label: string, primary?: boolean, danger?: boolean, onClick?: (close: Function) => (boolean|void) }>,
 *   onClose?: Function, wide?: boolean }} o
 * @returns {{ close(): void, el: HTMLElement }}
 */
export function modal({ title, body, actions = [{ label: 'Close', primary: true }], onClose, wide = false } = {}) {
    const titleId = uniqueId('dlg');
    const dlg = h('dialog', { class: ['modal', wide && 'modal-wide'], 'aria-labelledby': titleId });
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        if (typeof dlg.close === 'function' && dlg.open) dlg.close();
        dlg.remove();
        onClose?.();
    };
    const acts = actions.map(a => h('button', {
        type: 'button', class: ['btn', a.primary && 'btn-primary', a.danger && 'btn-danger'],
        on: { click: () => { if (a.onClick?.(close) !== false) close(); } },
    }, a.label));
    dlg.append(
        h('header', { class: 'modal-head' }, h('h2', { id: titleId }, title),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', on: { click: close } }, icon('x'))),
        h('div', { class: 'modal-body' }, body),
        acts.length ? h('footer', { class: 'modal-foot' }, acts) : null);
    dlg.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
    document.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    return { close, el: dlg };
}

/**
 * Loading placeholder: `lines` shimmering text bars, or a block of `height` px.
 * @param {{ lines?: number, height?: number }} [o]
 * @returns {HTMLElement}
 */
export function skeleton({ lines = 3, height } = {}) {
    if (height) return h('div', { class: 'skeleton skeleton-block shimmer', style: { height: `${height}px` }, 'aria-hidden': 'true' });
    const widths = [92, 78, 85, 64, 88, 70];
    return h('div', { class: 'skeleton', 'aria-hidden': 'true' },
        Array.from({ length: lines }, (_, i) => h('div', { class: 'shimmer skeleton-line', style: { width: `${widths[i % widths.length]}%` } })));
}

/**
 * A titled empty state with an optional call to action.
 * @param {{ title: string, body?: any, action?: Node|{ label: string, onClick?: Function, href?: string } }} o
 * @returns {HTMLElement}
 */
export function emptyState({ title, body, action } = {}) {
    const act = action instanceof Node ? action : action ? button({ ...action, kind: 'primary' }) : null;
    return h('div', { class: 'empty' }, horizonGlyph(), h('h3', { class: 'empty-title' }, title),
        body ? h('p', { class: 'empty-body' }, body) : null, act ? h('div', { class: 'empty-action' }, act) : null);
}

/* The app's mark: a horizon, the day's sun path and a sun sitting where 4–7pm would be. */
export function horizonGlyph({ size = 56 } = {}) {
    return h('svg', { class: 'glyph', width: size, height: size * 0.6, viewBox: '0 0 56 34', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 28h48', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', opacity: 0.5 }),
        h('path', { d: 'M8 28C12 10 44 10 48 28', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-dasharray': '2 3', opacity: 0.55 }),
        h('circle', { cx: 41.5, cy: 17.5, r: 4.2, fill: 'var(--accent)' }));
}

/**
 * A live checklist for multi-step work.
 *   set(key, status, detail) — an error row keeps its detail empty by default: the failure message
 *     belongs to the panel under the list, said once in full (opts.errorDetail: true prints it).
 *   settle(failedKey?) — the run stopped: mark failedKey (if any) as failed and put every row still
 *     spinning back to "waiting", so nothing spins for ever after an error or a cancel.
 *   status(key) — the row's current status.
 * @param {Array<{ key: string, label: string }>} steps
 * @param {{ errorDetail?: boolean }} [opts]
 * @returns {{ el: HTMLElement, set(key: string, status: 'pending'|'start'|'active'|'done'|'error'|'skip', detail?: string): void,
 *   settle(failedKey?: string|null): void, status(key: string): string|null }}
 */
export function progressList(steps, { errorDetail = false } = {}) {
    const rows = new Map();
    const el = h('ol', { class: 'progress-list', 'aria-live': 'polite' });
    const addRow = (key, label, pending) => {
        const ic = h('span', { class: 'pl-icon', 'aria-hidden': 'true' });
        const detail = h('span', { class: 'pl-detail' });
        const status = h('span', { class: 'sr-only' }, pending ? 'waiting' : '');
        const row = h('li', { class: ['pl-row', pending && 'is-pending'], dataset: { key } }, ic, h('span', { class: 'pl-label' }, label), status, detail);
        const r = { row, ic, detail, status, st: pending ? 'pending' : null };
        rows.set(key, r);
        el.appendChild(row);
        return r;
    };
    for (const s of steps) addRow(s.key, s.label, true);
    const api = {
        el,
        set(key, st, text) {
            // unknown step: append it rather than drop the information
            const r = rows.get(key) ?? addRow(key, LOAD_STEPS.find(s => s.key === key)?.label ?? key, false);
            const s = st === 'start' ? 'active' : st;
            r.st = s;
            r.row.className = `pl-row is-${s}`;
            r.ic.replaceChildren(s === 'done' ? icon('check') : s === 'error' ? icon('x') : '');
            r.status.textContent = { active: 'in progress', done: 'done', error: 'failed', skip: 'skipped', pending: 'waiting' }[s] || s;
            if (s === 'error' && !errorDetail) r.detail.textContent = '';
            else if (text != null) r.detail.textContent = text;
        },
        settle(failedKey = null) {
            if (failedKey) api.set(failedKey, 'error', '');
            for (const [key, r] of rows) if (r.st === 'active') api.set(key, 'pending', '');
        },
        status: key => rows.get(key)?.st ?? null,
    };
    return api;
}

/**
 * Two figures side by side for a direct comparison; the stronger one carries the accent rule.
 * (Promoted from the Usage view: peak vs off-peak price, load- vs time-weighted price.)
 * @param {Array<{ label: string|Node, value: string|Node, unit?: string, strong?: boolean }>} items
 * @param {{ className?: string }} [opts]
 * @returns {HTMLElement}
 */
export function figurePair(items = [], { className } = {}) {
    return h('div', { class: ['fig-pair', className] }, items.map(it => h('div', { class: ['fig-pair-item', it.strong && 'is-strong'] },
        h('div', { class: 'fig-pair-label' }, it.label),
        h('div', { class: 'fig-pair-fig' }, it.value == null || it.value === '' ? DASH : it.value, it.unit ? h('small', null, it.unit) : null))));
}

/* What the coverage chip says when the usage isn't meter readings at all (coverage.synthetic). */
const SYNTHETIC_USAGE = {
    demo: 'Example household · synthetic usage',
    manual: 'Typical usage · from your figures',
};

/**
 * The data-coverage chip: "100% real readings", or "53.7% real readings · 166 days estimated" in
 * amber below 95%, linking to the Data view. Usage that isn't meter readings (coverage.synthetic:
 * 'demo' | 'manual', or opts.source) says that instead — the example household is complete, but
 * none of it is real. null when the coverage is unknown.
 * @param {{ realPct?: number, extrapolatedSlots?: number, synthetic?: string }|null} coverage summary.coverage or insights.coverage
 * @param {{ href?: string, source?: string }} [opts] source: DatasetSummary.source, for coverage that isn't marked
 * @returns {HTMLAnchorElement|null}
 */
export function coverageChip(coverage, { href = '#data', source } = {}) {
    const synthetic = coverage?.synthetic || (source in SYNTHETIC_USAGE ? source : null);
    if (synthetic && coverage) {
        return h('a', { class: ['cov-chip', 'is-synthetic'], href, title: 'Not meter readings — see where this data came from' },
            h('span', { class: 'cov-chip-dot', 'aria-hidden': 'true' }), SYNTHETIC_USAGE[synthetic] || 'Synthetic usage, not meter readings');
    }
    const real = coverage?.realPct;
    if (!ok(real)) return null;
    const estDays = ok(coverage?.extrapolatedSlots) ? Math.round(coverage.extrapolatedSlots / 48) : 0;
    const text = `${fmt.pct(real, { dp: real >= 99.95 || real < 10 ? 0 : 1 })} real readings${estDays ? ` · ${fmt.num(estDays)} days estimated` : ''}`;
    return h('a', { class: ['cov-chip', real < 95 && 'is-warn'], href, title: 'See where your data came from' },
        h('span', { class: 'cov-chip-dot', 'aria-hidden': 'true' }), text);
}

/* ── form controls ──────────────────────────────────────────────────────────── */

const CONTROL_SEL = 'input, select, textarea, [role="radiogroup"], [role="slider"], [role="switch"]';

/**
 * Label + control + hint. The label is wired to the first focusable control inside `input`.
 * @param {{ label: string, hint?: string|Node, input: HTMLElement, inline?: boolean, id?: string }} o
 * @returns {HTMLElement}
 */
export function field({ label, hint, input, inline = false, id } = {}) {
    const control = input?.matches?.(CONTROL_SEL) ? input : input?.querySelector?.(CONTROL_SEL);
    const labelId = uniqueId('lbl');
    const hintId = hint ? uniqueId('hint') : null;
    let lab;
    if (control && /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName)) {
        control.id ||= uniqueId('ctl');
        lab = h('label', { class: 'field-label', for: control.id, id: labelId }, label);
    } else {
        lab = h('span', { class: 'field-label', id: labelId }, label);
        if (control) control.setAttribute('aria-labelledby', labelId);
    }
    if (control && hintId) control.setAttribute('aria-describedby', [control.getAttribute('aria-describedby'), hintId].filter(Boolean).join(' '));
    return h('div', { class: ['field', inline && 'field-inline'], id },
        lab, h('div', { class: 'field-control' }, input), hint ? h('div', { class: 'field-hint', id: hintId }, hint) : null);
}

const parseNum = s => {
    const t = String(s ?? '').trim().replace(/,/g, '').replace(MINUS, '-').replace(/[£p%]|kWh|W$/gi, '').trim();
    if (t === '') return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : NaN;
};

/**
 * A numeric text field (inputmode=decimal, so phones show a number pad without the
 * locale/scroll-wheel quirks of type=number). Arrow keys step; Shift ×10. Out-of-range values clamp.
 * Currency units ('£') sit before the number, every other unit after it.
 * @param {{ value?: number|null, min?: number, max?: number, step?: number, unit?: string, onChange?: (v: number|null) => void,
 *   placeholder?: string, dp?: number, ariaLabel?: string, id?: string, allowEmpty?: boolean, prefix?: boolean }} o
 * @returns {HTMLElement & { input: HTMLInputElement, getValue(): number|null, setValue(v: number|null): void }}
 */
export function numberInput({ value = null, min = -Infinity, max = Infinity, step = 1, unit, onChange, placeholder, dp, ariaLabel, id, allowEmpty = false, prefix = unit === '£' } = {}) {
    const decimals = dp ?? (String(step).split('.')[1]?.length || 0);
    const show = v => (v == null || !Number.isFinite(v) ? '' : String(+v.toFixed(Math.max(decimals, 0))));
    let current = value;
    const input = h('input', {
        type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'input input-num', value: show(value), placeholder, id,
        'aria-label': ariaLabel, spellcheck: 'false',
    });
    const commit = v => {
        input.removeAttribute('aria-invalid');
        if (v == null) {
            if (!allowEmpty) { input.value = show(current); return; }
            if (current !== null) { current = null; onChange?.(null); }
            return;
        }
        if (Number.isNaN(v)) { input.setAttribute('aria-invalid', 'true'); return; }
        const c = Math.min(max, Math.max(min, v));
        input.value = show(c);
        if (c !== current) { current = c; onChange?.(c); }
    };
    input.addEventListener('change', () => commit(parseNum(input.value)));
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { commit(parseNum(input.value)); return; }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const base = parseNum(input.value);
        const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
        commit((Number.isFinite(base) ? base : Number.isFinite(min) ? min : 0) + d);
    });
    const wrap = h('span', { class: ['num-wrap', unit && prefix && 'num-prefix'] }, input, unit ? h('span', { class: 'num-unit', 'aria-hidden': 'true' }, unit) : null);
    if (unit && !ariaLabel) input.setAttribute('aria-roledescription', `number in ${unit}`);
    wrap.input = input;
    wrap.getValue = () => current;
    wrap.setValue = v => { current = v; input.value = show(v); input.removeAttribute('aria-invalid'); };
    return wrap;
}

/**
 * A text input. With `reveal: true` (passwords) it is wrapped with a show/hide button and the
 * wrapper is returned (the input is `.input`); otherwise the input itself is returned.
 * @param {{ value?: string, placeholder?: string, type?: string, onChange?: (v: string) => void, onInput?: (v: string) => void,
 *   autocomplete?: string, inputmode?: string, name?: string, id?: string, maxLength?: number, ariaLabel?: string, reveal?: boolean, mono?: boolean }} o
 * @returns {HTMLElement}
 */
export function textInput({ value = '', placeholder, type = 'text', onChange, onInput, autocomplete = 'off', inputmode, name, id, maxLength, ariaLabel, reveal = false, mono = false } = {}) {
    const input = h('input', {
        type, class: ['input', mono && 'input-mono'], value: value ?? '', placeholder, autocomplete, inputmode, name, id,
        maxlength: maxLength, 'aria-label': ariaLabel, spellcheck: 'false', autocapitalize: 'off',
        on: { change: () => onChange?.(input.value), input: () => onInput?.(input.value) },
    });
    if (!reveal) return input;
    const btn = h('button', { type: 'button', class: 'reveal-btn', 'aria-label': 'Show key', 'aria-pressed': 'false' }, icon('eye'));
    btn.addEventListener('click', () => {
        const showing = input.type === 'text';
        input.type = showing ? 'password' : 'text';
        btn.setAttribute('aria-pressed', String(!showing));
        btn.setAttribute('aria-label', showing ? 'Show key' : 'Hide key');
        btn.replaceChildren(icon(showing ? 'eye' : 'eyeOff'));
    });
    const wrap = h('span', { class: 'reveal-wrap' }, input, btn);
    wrap.input = input;
    return wrap;
}

/**
 * A native select (optgroups from `group`).
 * @param {{ options: Array<{ value: string, label: string, group?: string, disabled?: boolean }>, value?: string, onChange?: (v: string) => void, id?: string, ariaLabel?: string }} o
 * @returns {HTMLSelectElement}
 */
export function select({ options = [], value, onChange, id, ariaLabel } = {}) {
    const el = h('select', { class: 'input select', id, 'aria-label': ariaLabel });
    const groups = new Map();
    for (const o of options) {
        const opt = h('option', { value: String(o.value), disabled: !!o.disabled }, o.label);
        if (o.group) {
            if (!groups.has(o.group)) { const g = h('optgroup', { label: o.group }); groups.set(o.group, g); el.appendChild(g); }
            groups.get(o.group).appendChild(opt);
        } else el.appendChild(opt);
    }
    if (value != null) el.value = String(value);
    el.addEventListener('change', () => onChange?.(el.value));
    return el;
}

/**
 * A segmented control (radio group with roving focus; arrow keys move and select).
 * @param {{ options: Array<{ value: any, label: string|Node, title?: string }>, value: any, onChange?: (v: any) => void, ariaLabel?: string, size?: 'sm'|'md' }} o
 * @returns {HTMLElement & { setValue(v: any): void }}
 */
export function segmented({ options = [], value, onChange, ariaLabel, size = 'md' } = {}) {
    const el = h('div', { class: ['segmented', size === 'sm' && 'segmented-sm'], role: 'radiogroup', 'aria-label': ariaLabel });
    let current = value;
    const btns = options.map((o, i) => {
        const b = h('button', { type: 'button', role: 'radio', class: 'seg', title: o.title, dataset: { i: String(i) } }, o.label);
        b.addEventListener('click', () => choose(i, true));
        return b;
    });
    const paint = () => btns.forEach((b, i) => {
        const on = options[i].value === current;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on || (!options.some(o => o.value === current) && i === 0) ? 0 : -1;
    });
    function choose(i, fire) {
        const v = options[i].value;
        if (v === current) return;
        current = v;
        paint();
        if (fire) onChange?.(v);
    }
    el.addEventListener('keydown', e => {
        const i = btns.indexOf(document.activeElement);
        if (i < 0) return;
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const n = (i + d + btns.length) % btns.length;
        btns[n].focus();
        choose(n, true);
    });
    el.append(...btns);
    paint();
    el.setValue = v => { current = v; paint(); };
    return el;
}

/**
 * An on/off switch built on a native checkbox (role=switch), so keyboard and forms just work.
 * @param {{ label: string|Node, checked?: boolean, onChange?: (v: boolean) => void, hint?: string }} o
 * @returns {HTMLLabelElement & { input: HTMLInputElement }}
 */
export function toggle({ label, checked = false, onChange, hint } = {}) {
    const input = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input', checked: !!checked });
    input.addEventListener('change', () => onChange?.(input.checked));
    const el = h('label', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-thumb' })),
        h('span', { class: 'switch-text' }, label, hint ? h('span', { class: 'switch-hint' }, hint) : null));
    el.input = input;
    return el;
}

/**
 * A checkbox with a label (for "Remember on this device"-style options).
 * @param {{ label: string|Node, checked?: boolean, onChange?: (v: boolean) => void }} o
 * @returns {HTMLLabelElement & { input: HTMLInputElement }}
 */
export function checkbox({ label, checked = false, onChange } = {}) {
    const input = h('input', { type: 'checkbox', class: 'check-input', checked: !!checked });
    input.addEventListener('change', () => onChange?.(input.checked));
    const el = h('label', { class: 'check' }, input, h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon('check')), h('span', null, label));
    el.input = input;
    return el;
}

/**
 * A range slider with a live readout.
 * @param {{ value: number, min: number, max: number, step?: number, onChange?: (v: number) => void, onInput?: (v: number) => void,
 *   format?: (v: number) => string, ariaLabel?: string }} o
 * @returns {HTMLElement & { input: HTMLInputElement, setValue(v: number): void }}
 */
export function slider({ value, min = 0, max = 100, step = 1, onChange, onInput, format = v => fmt.num(v), ariaLabel } = {}) {
    const input = h('input', { type: 'range', class: 'range', min, max, step, value, 'aria-label': ariaLabel });
    const out = h('output', { class: 'range-out' }, format(+value));
    const paint = () => {
        const pct = ((+input.value - min) / (max - min || 1)) * 100;
        input.style.setProperty('--pct', `${pct}%`);
        out.textContent = format(+input.value);
        input.setAttribute('aria-valuetext', out.textContent);
    };
    input.addEventListener('input', () => { paint(); onInput?.(+input.value); });
    input.addEventListener('change', () => onChange?.(+input.value));
    const el = h('div', { class: 'slider' }, input, out);
    paint();
    el.input = input;
    el.setValue = v => { input.value = v; paint(); };
    return el;
}

/**
 * A compass dial for panel direction (0 = N, clockwise). Drag, click or use the arrow keys
 * (±step; PageUp/PageDown ±45°). The shaded band is the sun's daytime track (E → S → W).
 * @param {{ azimuth: number, onChange?: (az: number) => void, size?: number, step?: number, label?: string }} o
 * @returns {HTMLElement & { setValue(az: number): void }}
 */
export function compassInput({ azimuth = 180, onChange, size = 200, step = 5, label = 'Panels face' } = {}) {
    const C = 100, R = 86;
    const pt = (az, r) => [C + r * Math.sin((az * Math.PI) / 180), C - r * Math.cos((az * Math.PI) / 180)];
    const arc = (a0, a1, r) => {
        const [x0, y0] = pt(a0, r), [x1, y1] = pt(a1, r);
        return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    const ticks = [];
    for (let a = 0; a < 360; a += 22.5) {
        const major = a % 90 === 0;
        const [x0, y0] = pt(a, R - (major ? 10 : 5)), [x1, y1] = pt(a, R);
        ticks.push(h('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'cmp-tick cmp-tick-major' : 'cmp-tick' }));
    }
    const labels = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, a]) => {
        const [x, y] = pt(a, R - 22);
        return h('text', { x, y, class: 'cmp-label', 'text-anchor': 'middle', 'dominant-baseline': 'central' }, t);
    });
    const needle = h('g', { class: 'cmp-needle' },
        h('line', { x1: C, y1: C, x2: C, y2: C - (R - 30), class: 'cmp-needle-line' }),
        h('path', { d: `M${C} ${C - (R - 26)}l-6 11h12z`, class: 'cmp-needle-head' }),
        h('circle', { cx: C, cy: C, r: 4.5, class: 'cmp-hub' }));
    const svg = h('svg', {
        class: 'compass-svg', viewBox: '0 0 200 200', width: size, height: size, tabindex: 0, role: 'slider',
        'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': 359,
    },
    h('circle', { cx: C, cy: C, r: R, class: 'cmp-face' }),
    h('path', { d: arc(90, 270, R - 4), class: 'cmp-sunband' }),
    ticks, labels, needle);
    const readout = h('div', { class: 'cmp-readout' });
    let current = Math.round(azimuth) % 360;
    const paint = () => {
        needle.setAttribute('transform', `rotate(${current} ${C} ${C})`);
        svg.setAttribute('aria-valuenow', String(current));
        svg.setAttribute('aria-valuetext', `${fmt.compass(current)}, ${current} degrees`);
        readout.replaceChildren(h('span', { class: 'cmp-name' }, fmt.compass(current)), h('span', { class: 'cmp-deg' }, `${current}°`));
    };
    const set = (az, fire) => {
        const v = ((Math.round(az / step) * step) % 360 + 360) % 360;
        if (v === current) return;
        current = v;
        paint();
        if (fire) onChange?.(v);
    };
    const fromPointer = e => {
        const r = svg.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
        if (Math.hypot(dx, dy) < 4) return;
        set((Math.atan2(dx, -dy) * 180) / Math.PI, true);
    };
    svg.addEventListener('pointerdown', e => { svg.setPointerCapture?.(e.pointerId); fromPointer(e); svg.focus(); });
    svg.addEventListener('pointermove', e => { if (svg.hasPointerCapture?.(e.pointerId)) fromPointer(e); });
    svg.addEventListener('keydown', e => {
        const d = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: 45, PageDown: -45 }[e.key];
        if (d == null) return;
        e.preventDefault();
        set(current + d, true);
    });
    paint();
    const el = h('div', { class: 'compass', style: { '--cmp-size': `${size}px` } }, svg, readout);
    el.setValue = az => { current = ((Math.round(az) % 360) + 360) % 360; paint(); };
    return el;
}

/* ── table ──────────────────────────────────────────────────────────────────── */

/**
 * A sortable data table that becomes a card list at ≤600 px (first column — or the column with
 * mobile:'title' — is the card title; columns with mobile:'hide' are dropped on phones).
 *
 * Groups: pass `groups` instead of `rows` to split the body into labelled sections, each its own
 * <tbody> (sorting applies within a group, groups keep their order): `{ key, title, note, rows,
 * divider, collapsible, collapsed, className }`. A group with a title gets a heading row; one with
 * `divider: true` and no title is set off by a dashed rule. A collapsible group's heading is a
 * button (aria-expanded) that hides or shows its rows; onToggle(key, open) reports it. Empty groups
 * are left out.
 * Header tooltips: a column's `help` text goes on its header (dotted underline, hover/focus tip,
 * and the accessible description). `note` (string or node) is printed under the table in
 * `.tbl-note`, whose links and link-buttons are 44 px tap targets on phones. `followSort: true`
 * makes the sorted column the card's primary figure on phones.
 * @param {{ columns: Array<{ key: string, label: string, align?: 'left'|'right'|'center', format?: (v: any, row: object) => string|Node,
 *   sortable?: boolean, sortValue?: (row: object) => any, width?: string, mobile?: 'title'|'primary'|'show'|'hide', help?: string }>,
 *   rows?: object[], groups?: Array<{ key?: string, title?: string|Node, note?: string|Node, rows: object[], divider?: boolean,
 *   collapsible?: boolean, collapsed?: boolean, className?: string }>, sortKey?: string, onRowClick?: (row: object) => void,
 *   rowAction?: string|((row: object) => string),
 *   rowClass?: (row: object) => string, emptyText?: string, caption?: string, dense?: boolean, note?: string|Node,
 *   followSort?: boolean, onSort?: (key: string) => void, onToggle?: (key: string, open: boolean) => void }} o
 *   sortKey: column key, prefixed with '-' for descending
 *   onRowClick: the row's title cell becomes a button that calls it (and a click anywhere on the row
 *   does too); rowAction is extra screen-reader text for that button, e.g. 'open it in Design'
 * @returns {HTMLElement & { update(rows: object[]): void, setGroups(groups: object[]): void, setSort(key: string): void, sortKey(): string|null }}
 */
export function table({ columns = [], rows = [], groups = null, sortKey, onRowClick, rowAction, rowClass, emptyText = 'Nothing to show yet.', caption, dense = false,
    note = null, followSort = false, onSort, onToggle } = {}) {
    let data = rows;
    let grouped = Array.isArray(groups) ? groups : null;
    let sort = sortKey || null;
    const open = new Map();   // group key → expanded (survives re-renders and updates)
    const titleCol = columns.find(c => c.mobile === 'title')?.key ?? columns[0]?.key;
    const tbl = h('table', { class: ['tbl', dense && 'tbl-dense', onRowClick && 'tbl-clickable', grouped && 'tbl-grouped'] });
    const wrap = h('div', { class: 'tbl-wrap' }, tbl, note != null && note !== '' ? h('div', { class: 'tbl-note' }, note) : null);
    const mobileOf = col => {
        if (col.key === titleCol) return 'title';
        if (followSort && sort) {
            const sk = sort.replace(/^-/, '');
            if (columns.some(c => c.key === sk && c.key !== titleCol)) return col.key === sk ? 'primary' : col.mobile === 'primary' ? 'show' : col.mobile || 'show';
        }
        return col.mobile || 'show';
    };

    const valueOf = (col, row) => (col.sortValue ? col.sortValue(row) : row[col.key]);
    const cmp = (a, b) => {
        if (a == null || (typeof a === 'number' && !Number.isFinite(a))) return 1;
        if (b == null || (typeof b === 'number' && !Number.isFinite(b))) return -1;
        return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));
    };
    function sorted(list) {
        if (!sort) return list;
        const desc = sort.startsWith('-');
        const col = columns.find(c => c.key === sort.replace(/^-/, ''));
        if (!col) return list;
        // Missing values always sink to the bottom, whichever way the column is sorted.
        return [...list].sort((x, y) => {
            const a = valueOf(col, x), b = valueOf(col, y);
            const missA = a == null || (typeof a === 'number' && !Number.isFinite(a));
            const missB = b == null || (typeof b === 'number' && !Number.isFinite(b));
            if (missA || missB) return missA === missB ? 0 : missA ? 1 : -1;
            return desc ? cmp(b, a) : cmp(a, b);
        });
    }
    /*
     * A clickable row's title is a real button (keyboard reachable, announced as something to press,
     * named by the title itself); the rest of the row stays a mouse convenience. Only a title that
     * already holds a control of its own falls back to a focusable row.
     */
    const CONTROL = 'a,button,input,select,textarea';
    const holdsControl = x => (Array.isArray(x) ? x.some(holdsControl)
        : x instanceof Node && x.nodeType === 1 && (x.matches(CONTROL) || !!x.querySelector(CONTROL)));
    const rowEl = (row, i) => {
        const tr = h('tr', { class: rowClass ? rowClass(row) : null });
        let asButton = null;
        for (const col of columns) {
            const raw = row[col.key];
            let v = col.format ? col.format(raw, row) : raw == null || (typeof raw === 'number' && !Number.isFinite(raw)) ? DASH
                : typeof raw === 'number' ? fmt.num(raw, Number.isInteger(raw) ? 0 : 1) : raw;
            if (onRowClick && col.key === titleCol && !holdsControl(v)) {
                const hint = typeof rowAction === 'function' ? rowAction(row) : rowAction;
                v = asButton = h('button', { type: 'button', class: 'tbl-row-btn', dataset: { fk: `tbl-row:${row?.id ?? i}` }, on: { click: () => onRowClick(row) } },
                    v, hint ? h('span', { class: 'sr-only' }, ` — ${hint}`) : null);
                // callers that put focus back on a re-rendered row (tr.focus()) land on its button
                const btn = asButton;
                tr.focus = opts => btn.focus(opts);
            }
            tr.appendChild(h(col.key === titleCol ? 'th' : 'td', {
                class: [`al-${col.align || 'left'}`, `m-${mobileOf(col)}`], scope: col.key === titleCol ? 'row' : null, dataset: { label: col.label },
            }, v));
        }
        if (onRowClick) {
            tr.addEventListener('click', e => { if (!e.target.closest(`${CONTROL},label`)) onRowClick(row); });
            if (!asButton) {
                tr.tabIndex = 0;
                tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) onRowClick(row); });
            }
        }
        return tr;
    };
    const emptyRow = () => h('tr', { class: 'tbl-empty' }, h('td', { colspan: columns.length }, emptyText));
    function groupBody(g, i) {
        const key = g.key ?? String(i);
        const list = sorted(Array.isArray(g.rows) ? g.rows : []);
        const titled = g.title != null && g.title !== '';
        // only a titled group has the heading button that opens it again, so an untitled one never collapses
        const collapsible = !!g.collapsible && titled;
        if (!open.has(key)) open.set(key, !(collapsible && g.collapsed));
        const isOpen = !collapsible || open.get(key);
        const bodyId = uniqueId('tg');
        const kids = [];
        if (titled) {
            const count = h('span', { class: 'tbl-group-count' }, `${list.length}`);
            const label = [h('span', { class: 'tbl-group-title' }, g.title), collapsible ? count : null];
            const head = collapsible
                ? h('button', {
                    type: 'button', class: 'tbl-group-toggle', 'aria-expanded': String(isOpen), 'aria-controls': bodyId, dataset: { fk: `tbl-group:${key}` },
                    on: { click: () => { open.set(key, !open.get(key)); keepFocus(wrap, render); onToggle?.(key, open.get(key)); } },
                }, icon('chevron'), label)
                : label;
            kids.push(h('tr', { class: 'tbl-group-head' }, h('th', { colspan: columns.length, scope: 'colgroup' },
                h('div', { class: 'tbl-group-line' }, head, g.note != null && g.note !== '' ? h('span', { class: 'tbl-group-note' }, g.note) : null))));
        }
        const rowsEls = isOpen ? list.map(rowEl) : [];
        return h('tbody', {
            class: ['tbl-group', g.divider && 'tbl-divider', !isOpen && 'is-collapsed', g.className], id: bodyId,
            dataset: { group: key }, 'aria-label': typeof g.title === 'string' ? g.title : null,
        }, kids, rowsEls);
    }
    function render() {
        const head = h('tr', null, columns.map(col => {
            const key = col.key;
            const active = sort && sort.replace(/^-/, '') === key;
            const dir = active ? (sort.startsWith('-') ? 'descending' : 'ascending') : 'none';
            const canSort = col.sortable !== false && columns.length > 1;
            const lab = col.help ? h('span', { class: 'th-help' }, col.label) : col.label;
            let inner;
            if (canSort) {
                inner = h('button', {
                    type: 'button', class: 'th-sort', dataset: { fk: `tbl-sort:${key}` },
                    on: { click: () => { sort = active && !sort.startsWith('-') ? `-${key}` : active ? key : (col.align === 'right' ? `-${key}` : key); keepFocus(wrap, render); onSort?.(sort); } },
                }, lab, h('span', { class: 'th-arrow', 'aria-hidden': 'true' }, active ? (dir === 'ascending' ? '▲' : '▼') : ''));
            } else inner = col.help ? h('span', { class: 'th-tip', tabindex: '0' }, lab) : lab;
            if (col.help && inner instanceof Node) tooltip(inner, col.help);
            return h('th', {
                scope: 'col', class: [`al-${col.align || 'left'}`, `m-${mobileOf(col)}`],
                style: col.width ? { width: col.width } : null, 'aria-sort': canSort ? dir : null,
            }, inner);
        }));
        let bodies;
        if (grouped) {
            bodies = grouped.map((g, i) => (g && (g.rows?.length || 0) > 0 ? groupBody(g, i) : null)).filter(Boolean);
            if (!bodies.length) bodies = [h('tbody', null, emptyRow())];
        } else {
            const list = sorted(data);
            bodies = [h('tbody', null, list.length ? list.map(rowEl) : emptyRow())];
        }
        tbl.replaceChildren(caption ? h('caption', { class: 'sr-only' }, caption) : '', h('thead', null, head), ...bodies);
    }
    render();
    wrap.update = r => { data = r; grouped = null; tbl.classList.remove('tbl-grouped'); render(); };
    wrap.setGroups = g => { grouped = Array.isArray(g) ? g : null; tbl.classList.toggle('tbl-grouped', !!grouped); render(); };
    wrap.setSort = k => { sort = k; render(); };
    wrap.sortKey = () => sort;
    return wrap;
}

/* ── the shared connect card ────────────────────────────────────────────────── */

const ACCOUNT_RE = /^A-[0-9A-Z]{8}$/;

/** Labels for loadDataset progress steps (contract §6 onProgress). */
export const LOAD_STEPS = [
    { key: 'account', label: 'Your account' },
    { key: 'usage', label: 'Your usage' },
    { key: 'prices', label: 'Agile prices' },
    { key: 'export', label: 'Export prices' },
    { key: 'weather', label: 'Sunshine: satellite' },
    { key: 'climatology', label: '20-year sunshine averages' },
    { key: 'build', label: 'Putting it together' },
];

/*
 * The steps each source actually reports (dataset.js). Listing a step a source never reports
 * leaves a row stuck on "waiting"; leaving out one it does report appends it out of order.
 * The demo ships its 20-year averages inside demo.json, so it has no climatology step.
 */
const STEPS_BY_KIND = {
    octopus: ['account', 'usage', 'prices', 'export', 'weather', 'climatology', 'build'],
    demo: ['usage', 'prices', 'weather', 'build'],
    csv: ['usage', 'prices', 'export', 'weather', 'climatology', 'build'],
    manual: ['usage', 'prices', 'export', 'weather', 'climatology', 'build'],
};

/**
 * The progress-list steps for a DatasetSpec kind, labelled for that source.
 * @param {string} kind 'octopus' | 'demo' | 'csv' | 'manual'
 * @returns {Array<{ key: string, label: string }>}
 */
export function loadStepsFor(kind) {
    const keys = STEPS_BY_KIND[kind] || STEPS_BY_KIND.octopus;
    return keys.map(k => ({ ...LOAD_STEPS.find(s => s.key === k) }));
}

/**
 * Turn a loadDataset progress event into the short detail text shown beside its step.
 * @param {{ step: string, status: string, detail?: string, count?: number, pct?: number }} p
 * @returns {string}
 */
export function progressDetail(p) {
    if (!p) return '';
    if (p.detail) return String(p.detail);
    if (p.step === 'usage' && p.count != null) return `${fmt.num(p.count)} half-hours${p.pct != null ? ` (${fmt.pct(p.pct)})` : ''}`;
    if (p.step === 'weather' && p.count != null) return `${fmt.num(p.count)} days`;
    if (p.count != null) return fmt.num(p.count);
    if (p.pct != null) return fmt.pct(p.pct);
    return '';
}

/**
 * Normalise a typed account number ("a-1234 abcd" → "A-1234ABCD").
 * @param {string} s
 * @returns {{ value: string|null, valid: boolean }}
 */
export function normalizeAccount(s) {
    const t = String(s ?? '').trim().toUpperCase().replace(/\s+/g, '');
    if (!t) return { value: null, valid: true };
    return { value: t, valid: ACCOUNT_RE.test(t) };
}

/**
 * The connect card shown wherever there is no dataset: Octopus API key (+ optional account),
 * remember-on-device, "Analyse my home", and routes to the demo, CSV upload and manual entry.
 * Actions go through ctx.data.load(spec); CSV/manual go to the Data view (#data?mode=…).
 * @param {{ store?: object, data?: { load: Function }, router?: { go: Function } }} ctx
 * @param {{ compact?: boolean }} [opts]
 * @returns {HTMLElement}
 */
export function connectCard(ctx = {}, { compact = false } = {}) {
    const state = ctx.store?.get?.() ?? null;
    const conn = state?.connection ?? {};
    let savedKey = null;
    try { savedKey = getApiKey(); } catch { savedKey = null; }

    const keyField = textInput({ type: 'password', placeholder: 'sk_live_…', value: savedKey || '', reveal: true, mono: true, autocomplete: 'off', name: 'octopus-key' });
    const keyIn = keyField.input;
    const acctIn = textInput({ placeholder: 'A-1234ABCD', value: conn.accountNumber || '', mono: true, name: 'octopus-account' });
    const remember = checkbox({ label: 'Remember on this device', checked: !!conn.rememberKey });
    const keyHint = h('span', { class: 'hint-warn', hidden: true }, icon('info'), ' Octopus keys usually start with sk_live_');
    const updateHint = () => { const v = keyIn.value.trim(); keyHint.hidden = !v || v.startsWith('sk_live_'); };
    keyIn.addEventListener('input', updateHint);
    updateHint();

    const errorBox = h('div', { class: 'connect-error', role: 'alert', hidden: true });
    const progressHost = h('div', { class: 'connect-progress' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, h('span', null, 'Analyse my home'), icon('arrowRight'));
    const demoW = conn.demoServerW || 500;
    const demoBtn = h('button', { type: 'button', class: 'link-btn' }, icon('sun'), ` Try with example data (London, ${demoW} W servers)`);
    let busy = false;

    const setBusy = b => {
        busy = b;
        submit.disabled = b;
        demoBtn.disabled = b;
        form.classList.toggle('is-busy', b);
        submit.firstChild.textContent = b ? 'Analysing…' : 'Analyse my home';
    };
    const showError = (message, actions = []) => {
        errorBox.replaceChildren(h('div', { class: 'connect-error-msg' }, icon('alert'), h('span', null, message)),
            actions.length ? h('div', { class: 'connect-error-actions' }, actions) : '');
        errorBox.hidden = false;
    };
    const clearError = () => { errorBox.hidden = true; errorBox.replaceChildren(); };

    async function run(spec) {
        if (busy) return;
        if (!ctx.data?.load) { toast('Loading data isn’t available on this page.', { tone: 'warn' }); return; }
        clearError();
        const pl = progressList(loadStepsFor(spec.kind));
        progressHost.replaceChildren(pl.el);
        setBusy(true);
        let failedStep = null;
        try {
            await ctx.data.load(spec, {
                onProgress: p => {
                    if (!p || !p.step) return;
                    if (p.status === 'error') failedStep = p.step;
                    pl.set(p.step, p.status, progressDetail(p));
                },
            });
        } catch (err) {
            pl.settle(err?.name === 'AbortError' ? null : failedStep ?? err?.step ?? null);
            if (err?.name === 'AbortError') return;
            handleError(err, spec);
        } finally {
            setBusy(false);
        }
    }

    function handleError(err, spec) {
        const msg = err?.message || 'Something went wrong while fetching your data.';
        const acts = [];
        const retry = button({ label: 'Retry', icon: 'refresh', size: 'sm', onClick: () => run(spec) });
        const demo = button({ label: 'Use example data', size: 'sm', kind: 'ghost', onClick: () => run({ kind: 'demo', serverW: demoW }) });
        switch (err?.action) {
            case 'checkKey':
                acts.push(button({ label: 'Check your key', size: 'sm', onClick: () => { keyIn.focus(); keyIn.select(); } }), demo);
                break;
            case 'setPostcode':
                acts.push(button({ label: 'Set your postcode', size: 'sm', href: '#data?mode=location' }), retry);
                break;
            case 'pickAccount':
                // Choices are account numbers (several accounts on one key) or import meter points
                // ({ mpan, serials }) when one property has more than one electricity meter.
                for (const c of err.choices || []) {
                    if (c && typeof c === 'object' && c.mpan) {
                        const label = `Meter ${c.mpan}${c.serials?.length ? ` (${c.serials.join(', ')})` : ''}`;
                        acts.push(button({ label, size: 'sm', onClick: () => run({ ...spec, mpan: c.mpan }) }));
                        continue;
                    }
                    const value = typeof c === 'string' ? c : c?.value ?? c?.number ?? c?.id;
                    if (!value) continue;
                    const label = typeof c === 'string' ? c : c.label ?? value;
                    acts.push(button({ label, size: 'sm', onClick: () => { acctIn.value = value; run({ ...spec, accountNumber: value }); } }));
                }
                if (!acts.length) acts.push(button({ label: 'Check your account number', size: 'sm', onClick: () => acctIn.focus() }));
                break;
            case 'useDemo':
                acts.push(demo);
                break;
            case 'reload':
                // a part of the calculator didn't download: Retry asks for it afresh; a reload is the
                // backstop when something it depends on failed too (an unremembered key survives it)
                acts.push(retry, button({ label: 'Reload the page', size: 'sm', kind: 'ghost', onClick: () => location.reload() }));
                break;
            default:
                if (err?.retryable !== false) acts.push(retry);
                acts.push(demo);
        }
        showError(msg, acts);
    }

    const form = h('form', { class: 'connect-form', novalidate: true, autocomplete: 'off' },
        field({ label: 'Octopus API key', input: keyField, hint: keyHint }),
        field({ label: 'Account number (optional — we can find it)', input: acctIn }),
        h('div', { class: 'connect-row' }, remember, submit),
        errorBox, progressHost);
    form.addEventListener('submit', e => {
        e.preventDefault();
        const key = keyIn.value.trim();
        const acct = normalizeAccount(acctIn.value);
        if (!key) { showError('Paste your Octopus API key — or try the example data below.'); keyIn.focus(); return; }
        if (!acct.valid) { showError('Account numbers look like A-1234ABCD.'); acctIn.focus(); return; }
        if (acct.value) acctIn.value = acct.value;
        try { setApiKey(key, remember.input.checked); } catch { /* storage blocked: key stays in memory */ }
        ctx.store?.set?.({ connection: { accountNumber: acct.value, rememberKey: remember.input.checked } });
        const loc = conn.location || {};
        const location = loc.postcode ? { postcode: loc.postcode } : Number.isFinite(loc.lat) && Number.isFinite(loc.lon) ? { lat: loc.lat, lon: loc.lon } : undefined;
        const spec = { kind: 'octopus', apiKey: key };
        if (acct.value) spec.accountNumber = acct.value;
        // the meter picked last time, while it's the same account (an unknown meter is ignored upstream)
        if (conn.mpan && (acct.value ?? null) === (conn.accountNumber ?? null)) spec.mpan = String(conn.mpan);
        if (location) spec.location = location;
        if (conn.priceBasis && conn.priceBasis !== 'mine') { spec.priceBasis = conn.priceBasis; if (conn.flatP != null) spec.flatP = conn.flatP; }
        if (conn.installedSolarDate) spec.installedSolarDate = conn.installedSolarDate;
        run(spec);
    });
    demoBtn.addEventListener('click', () => run({ kind: 'demo', serverW: demoW }));

    const links = h('div', { class: 'connect-links' },
        demoBtn,
        h('a', { class: 'link-btn', href: '#data?mode=csv' }, icon('upload'), ' Upload a CSV'),
        h('a', { class: 'link-btn', href: '#data?mode=manual' }, icon('pencil'), ' Enter usage by hand'));

    const help = details({
        summary: 'Where’s my API key?',
        body: [
            h('p', null, 'Octopus website → Your account → Personal details → API access. It’s only ever sent to api.octopus.energy.'),
            h('p', null, h('a', { href: 'https://octopus.energy/dashboard/new/accounts/personal-details/api-access', target: '_blank', rel: 'noopener noreferrer' },
                'Open the API access page', icon('external'))),
        ],
    });

    // Every view without data renders its own card (hidden views stay mounted), so ids must be unique.
    const titleId = uniqueId('connect-title');
    return h('section', { class: ['card', 'card-accent', 'connect-card', compact && 'connect-compact'], 'aria-labelledby': titleId },
        h('div', { class: 'connect-hero' },
            horizonGlyph({ size: 64 }),
            h('div', null,
                h('h2', { class: 'connect-title', id: titleId }, 'See what solar would have saved you'),
                h('p', { class: 'connect-lede' }, 'Uses your real half-hourly usage and Agile prices from Octopus, plus satellite sunshine for your home.'))),
        h('div', { class: 'connect-grid' },
            h('div', { class: 'connect-main' }, form),
            h('aside', { class: 'connect-side' },
                h('div', { class: 'connect-side-title' }, 'No Octopus account?'),
                links,
                help,
                h('p', { class: 'connect-privacy' }, icon('lock'), ' Your key stays in this browser. Nothing is uploaded anywhere else.'))));
}
