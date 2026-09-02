/*
 * dom.js — tiny DOM + formatting helpers.
 * No dependencies. Everything here is pure and side-effect free unless noted.
 */

// ---- element building ----

/**
 * Build an element. Props support: class, id, text, html, style (object),
 * dataset (object), aria-* / data-* attributes, on* event handlers, and any
 * other attribute name. Children may be nodes, strings, arrays, or falsy
 * (skipped) so conditional children read naturally.
 */
export function el(tag, props = null, ...children) {
    const node = document.createElement(tag);

    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined || value === false) continue;

            if (key === 'class' || key === 'className') {
                node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
            } else if (key === 'text') {
                node.textContent = value;
            } else if (key === 'html') {
                node.innerHTML = value;
            } else if (key === 'style' && typeof value === 'object') {
                Object.assign(node.style, value);
            } else if (key === 'dataset' && typeof value === 'object') {
                Object.assign(node.dataset, value);
            } else if (key.startsWith('on') && typeof value === 'function') {
                node.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (value === true) {
                node.setAttribute(key, '');
            } else {
                node.setAttribute(key, String(value));
            }
        }
    }

    append(node, children);
    return node;
}

export function append(parent, children) {
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false || child === '') continue;
        parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return parent;
}

/** Build an SVG element — SVG needs createElementNS, plain el() will not do. */
export function svgEl(tag, props = null, ...children) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value === null || value === undefined || value === false) continue;
            if (key === 'text') node.textContent = value;
            else if (key.startsWith('on') && typeof value === 'function') {
                node.addEventListener(key.slice(2).toLowerCase(), value);
            } else node.setAttribute(key, String(value));
        }
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false || child === '') continue;
        node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) {
    if (node) while (node.firstChild) node.removeChild(node.firstChild);
    return node;
}

export function mount(container, ...children) {
    clear(container);
    append(container, children);
    return container;
}

/** Escape for interpolation into an innerHTML string. */
export function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function on(node, event, handler, opts) {
    node.addEventListener(event, handler, opts);
    return () => node.removeEventListener(event, handler, opts);
}

// ---- inline SVG icons ----

export const icon = (name, size = 20) => {
    const paths = ICONS[name] || '';
    const svg = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
        stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
        stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const wrap = document.createElement('span');
    wrap.className = 'icon';
    wrap.innerHTML = svg;
    return wrap.firstElementChild;
};

export const ICONS = {
    play: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    next: '<path d="M5 12h13M13 6l6 6-6 6"/>',
    prev: '<path d="M19 12H6M11 18l-6-6 6-6"/>',
    repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    volume: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    mute: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
    speech: '<path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4M8 22h8"/>',
    speechOff: '<path d="M9 9v2a3 3 0 0 0 5.1 2.1"/><path d="M15 10.5V5a3 3 0 0 0-5.9-.8"/><path d="M19 10v1a7 7 0 0 1-1.2 3.9"/><path d="M5 10v1a7 7 0 0 0 11.3 5.5"/><path d="M12 18v4M8 22h8"/><path d="M2 2l20 20"/>',
    expand: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    check: '<path d="M20 6L9 17l-5-5" stroke-width="2.4"/>',
    cross: '<path d="M18 6L6 18M6 6l12 12" stroke-width="2.2"/>',
    trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/>',
    print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke-width="2"/>',
    trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 9l5-5 5 5M12 4v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12"/>',
    home: '<path d="M3 10l9-7 9 7v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 21V12h6v9"/>',
    coffee: '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v7a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
    sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
};

// ---- formatting ----

export function fmtTime(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function ordinal(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
    switch (n % 10) {
        case 1: return `${n}st`;
        case 2: return `${n}nd`;
        case 3: return `${n}rd`;
        default: return `${n}th`;
    }
}

/** Cardinal numbers as words, for anything the host reads aloud. */
export function numberWord(n) {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
        'eight', 'nine', 'ten', 'eleven', 'twelve'];
    return words[n] ?? String(n);
}

export function plural(n, one, many = `${one}s`) {
    return `${n} ${n === 1 ? one : many}`;
}

/** Join a list the way a person says it: "a, b and c". */
export function listSentence(items) {
    const list = items.filter(Boolean);
    if (list.length === 0) return '';
    if (list.length === 1) return String(list[0]);
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** A score on screen: 13, or 13.5 — never 13.0 and never 13.500000000000002. */
export function fmtPoints(value) {
    const n = Math.round((Number(value) || 0) * 100) / 100;
    return Number.isInteger(n) ? String(n) : String(n);
}

/**
 * A score read aloud. A synthesiser saying "thirteen point five points" is
 * nobody's idea of a quizmaster, so halves are spoken as halves.
 */
export function spokenPoints(value) {
    const n = Math.round((Number(value) || 0) * 100) / 100;
    if (n === 0) return 'no points';
    if (n === 0.5) return 'half a point';
    if (n === 1) return 'one point';

    const whole = Math.floor(n);
    const fraction = Math.round((n - whole) * 100) / 100;
    if (fraction === 0) return `${whole} points`;
    if (fraction === 0.5) return `${whole} and a half points`;
    return `${n} points`;
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function uid(prefix = 'id') {
    return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function shuffle(input) {
    const arr = input.slice();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** Loose answer comparison used to suggest a mark to the host. */
export function answersMatch(given, expected) {
    const norm = (s) => String(s ?? '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\b(the|a|an|of|and)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return norm(given) === norm(expected) && norm(given) !== '';
}

// ---- storage (never throws — private mode, quota, disabled cookies) ----

export const storage = {
    get(key, fallback = null) {
        try {
            const raw = localStorage.getItem(key);
            return raw === null ? fallback : JSON.parse(raw);
        } catch {
            return fallback;
        }
    },
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch {
            return false;
        }
    },
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch { /* ignore */ }
    },
};

// ---- misc ----

export function prefersReducedMotion() {
    return typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** requestAnimationFrame-driven tween, returns a cancel function. */
export function tween(durationMs, onFrame, onDone) {
    let raf = 0;
    let start = 0;
    const step = (now) => {
        if (!start) start = now;
        const t = clamp((now - start) / durationMs, 0, 1);
        onFrame(t);
        if (t < 1) raf = requestAnimationFrame(step);
        else if (onDone) onDone();
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
}

export const easeOutCubic = (t) => 1 - (1 - t) ** 3;
