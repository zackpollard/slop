/*
 * solar-fake-dom — just enough of a DOM (and a recording 2-D canvas) to drive the solar
 * calculator's ui.js components, app.js's re-run bar and charts.js charts in node.
 *
 * Elements, text nodes, attributes, classList, dataset, style, events (bubbling), focus /
 * activeElement, isConnected, and a selector engine for the selectors the app actually uses:
 * compound simple selectors (tag, #id, .class, [attr], [attr="v"], :not(simple)) joined by
 * descendant combinators, in comma lists. Canvas getContext('2d') returns a context that records
 * every call (ctx.calls) and measures text at 6 px per character.
 *
 *   const dom = installFakeDom();   // sets globalThis.document/window/… ; dom.restore() undoes it
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

class FakeNode {
    constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
    get isConnected() {
        let n = this;
        while (n) { if (n === n.ownerDocument?.documentElement) return true; n = n.parentNode; }
        return false;
    }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); if (v != null && v !== '') this.appendChild(this.ownerDocument.createTextNode(String(v))); }
    appendChild(node) {
        if (node.nodeType === 11) { for (const c of [...node.childNodes]) this.appendChild(c); return node; }
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        this.childNodes.push(node);
        return node;
    }
    removeChild(node) {
        const i = this.childNodes.indexOf(node);
        if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
        if (this.ownerDocument && this.ownerDocument._active && (this.ownerDocument._active === node || node.contains?.(this.ownerDocument._active))) this.ownerDocument._active = null;
        return node;
    }
    insertBefore(node, ref) {
        if (!ref) return this.appendChild(node);
        node.parentNode?.removeChild(node);
        node.parentNode = this;
        this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
        return node;
    }
    append(...kids) { for (const k of kids) this.appendChild(typeof k === 'string' ? this.ownerDocument.createTextNode(k) : k); }
    replaceChildren(...kids) { for (const c of [...this.childNodes]) this.removeChild(c); this.append(...kids); }
    remove() { this.parentNode?.removeChild(this); }
    contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
}

class FakeText extends FakeNode {
    constructor(doc, text) { super(doc); this.nodeType = 3; this.data = String(text); }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
}

class FakeClassList {
    constructor(el) { this.el = el; }
    _get() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
    _set(list) { this.el.setAttribute('class', [...new Set(list)].join(' ')); }
    add(...c) { this._set([...this._get(), ...c]); }
    remove(...c) { this._set(this._get().filter(x => !c.includes(x))); }
    contains(c) { return this._get().includes(c); }
    toggle(c, force) { const on = force ?? !this.contains(c); if (on) this.add(c); else this.remove(c); return on; }
}

const camelToData = k => `data-${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`;
const dataToCamel = a => a.slice(5).replace(/-([a-z])/g, (_, m) => m.toUpperCase());

class FakeElement extends FakeNode {
    constructor(doc, tag, ns = null) {
        super(doc);
        this.nodeType = 1;
        this.namespaceURI = ns;
        this.tagName = ns === SVG_NS ? tag : String(tag).toUpperCase();
        this.localName = String(tag).toLowerCase();
        this.attrs = new Map();
        this.listeners = new Map();
        this.classList = new FakeClassList(this);
        const styleStore = {};
        this.style = new Proxy(styleStore, {
            get: (t, k) => (k === 'setProperty' ? (p, v) => { t[p] = String(v); } : k === 'getPropertyValue' ? p => t[p] ?? '' : k === 'removeProperty' ? p => { delete t[p]; } : t[k] ?? ''),
            set: (t, k, v) => { t[k] = v; return true; },
        });
        const el = this;
        this.dataset = new Proxy({}, {
            get: (_, k) => (typeof k === 'string' ? el.getAttribute(camelToData(k)) ?? undefined : undefined),
            set: (_, k, v) => { el.setAttribute(camelToData(k), String(v)); return true; },
            deleteProperty: (_, k) => { el.removeAttribute(camelToData(k)); return true; },
            ownKeys: () => [...el.attrs.keys()].filter(a => a.startsWith('data-')).map(dataToCamel),
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
        });
        this.value = '';
        this.checked = false;
        this.width = 300;
        this.height = 150;
        this._clientWidth = 600;
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] ?? null; }
    get firstElementChild() { return this.children[0] ?? null; }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get tabIndex() { const t = this.getAttribute('tabindex'); return t == null ? (/^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(this.tagName) ? 0 : -1) : +t; }
    set tabIndex(v) { this.setAttribute('tabindex', String(v)); }
    get open() { return this.hasAttribute('open'); }
    set open(v) { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); }
    get clientWidth() { return this._clientWidth; }
    get offsetWidth() { return 0; }
    get offsetHeight() { return 0; }
    get offsetParent() { return undefined; }
    getBoundingClientRect() { return { left: 0, top: 0, right: this._clientWidth, bottom: 100, width: this._clientWidth, height: 100 }; }
    getClientRects() { return [this.getBoundingClientRect()]; }
    setAttribute(k, v) { this.attrs.set(String(k).toLowerCase(), String(v)); }
    getAttribute(k) { const v = this.attrs.get(String(k).toLowerCase()); return v === undefined ? null : v; }
    hasAttribute(k) { return this.attrs.has(String(k).toLowerCase()); }
    removeAttribute(k) { this.attrs.delete(String(k).toLowerCase()); }
    toggleAttribute(k, force) { const on = force ?? !this.hasAttribute(k); if (on) this.setAttribute(k, ''); else this.removeAttribute(k); return on; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(ev) {
        ev.target ??= this;
        let stopped = false;
        ev.stopPropagation = () => { stopped = true; };
        ev.preventDefault ??= () => { ev.defaultPrevented = true; };
        for (let n = this; n && !stopped; n = ev.bubbles === false ? null : n.parentNode) {
            for (const fn of [...(n.listeners?.get(ev.type) || [])]) fn.call(n, ev);
        }
        return !ev.defaultPrevented;
    }
    click() { if (!this.disabled) this.dispatchEvent({ type: 'click', bubbles: true }); }
    focus() {
        if (!this.isConnected) return;
        const prev = this.ownerDocument._active;
        if (prev === this) return;
        this.ownerDocument._active = this;
        prev?.dispatchEvent?.({ type: 'blur', bubbles: false });
        this.dispatchEvent({ type: 'focus', bubbles: false });
    }
    blur() { if (this.ownerDocument._active === this) { this.ownerDocument._active = null; this.dispatchEvent({ type: 'blur', bubbles: false }); } }
    matches(sel) { return parseList(sel).some(chain => matchChain(this, chain)); }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
        const list = parseList(sel);
        const out = [];
        const walk = n => { for (const c of n.childNodes) if (c.nodeType === 1) { if (list.some(ch => matchChain(c, ch))) out.push(c); walk(c); } };
        walk(this);
        return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
    getContext(kind) { if (kind !== '2d') return null; this._ctx ??= recordingContext(this); return this._ctx; }
    // <dialog>
    showModal() { this.setAttribute('open', ''); }
    close() { this.removeAttribute('open'); }
    setPointerCapture() {}
    hasPointerCapture() { return false; }
    scrollIntoView() {}
    select() {}
}

/* ── selector engine ─────────────────────────────────────────────────────────── */

function splitTop(s, sep) {
    const out = [];
    let depth = 0, quote = null, cur = '';
    for (const ch of s) {
        if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        if (ch === ')' || ch === ']') depth--;
        if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

const parseCache = new Map();
function parseList(sel) {
    if (parseCache.has(sel)) return parseCache.get(sel);
    const list = splitTop(sel, ',').map(part => splitTop(part, ' ').filter(t => t !== '>').map(parseCompound));
    parseCache.set(sel, list);
    return list;
}

function parseCompound(s) {
    const parts = [];
    let i = 0;
    const tag = /^[a-zA-Z*][\w-]*/.exec(s);
    if (tag) { if (tag[0] !== '*') parts.push({ t: 'tag', v: tag[0].toLowerCase() }); i = tag[0].length; }
    while (i < s.length) {
        const ch = s[i];
        if (ch === '.' || ch === '#') {
            const m = /^[\w-]+/.exec(s.slice(i + 1));
            parts.push({ t: ch === '.' ? 'class' : 'id', v: m[0] });
            i += 1 + m[0].length;
        } else if (ch === '[') {
            const end = findClose(s, i, '[', ']');
            const body = s.slice(i + 1, end);
            const m = /^([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*)))?$/.exec(body.trim());
            parts.push({ t: 'attr', k: m[1].toLowerCase(), op: m[2] || null, v: m[3] ?? m[4] ?? m[5] ?? null });
            i = end + 1;
        } else if (s.startsWith(':not(', i)) {
            const end = findClose(s, i + 4, '(', ')');
            parts.push({ t: 'not', list: parseList(s.slice(i + 5, end)) });
            i = end + 1;
        } else throw new Error(`fake-dom: unsupported selector "${s}"`);
    }
    return parts;
}

function findClose(s, start, open, close) {
    let depth = 0, quote = null;
    for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === open) depth++;
        if (ch === close && --depth === 0) return i;
    }
    throw new Error(`fake-dom: unbalanced selector "${s}"`);
}

function matchCompound(el, parts) {
    for (const p of parts) {
        if (p.t === 'tag' && el.localName !== p.v) return false;
        if (p.t === 'class' && !el.classList.contains(p.v)) return false;
        if (p.t === 'id' && el.getAttribute('id') !== p.v) return false;
        if (p.t === 'attr') {
            const v = el.getAttribute(p.k);
            if (v == null) return false;
            if (p.op === '=' && v !== p.v) return false;
            if (p.op === '^=' && !v.startsWith(p.v)) return false;
        }
        if (p.t === 'not' && p.list.some(chain => matchChain(el, chain))) return false;
    }
    return true;
}

function matchChain(el, chain) {
    if (!matchCompound(el, chain[chain.length - 1])) return false;
    let k = chain.length - 2;
    for (let n = el.parentNode; k >= 0 && n && n.nodeType === 1; n = n.parentNode) if (matchCompound(n, chain[k])) k--;
    return k < 0;
}

/* ── canvas ──────────────────────────────────────────────────────────────────── */

function recordingContext(canvas) {
    const calls = [];
    const state = { font: '10px sans-serif', fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, textAlign: 'start', textBaseline: 'alphabetic',
        globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, lineJoin: 'miter', lineCap: 'butt' };
    const ctx = new Proxy(state, {
        get(t, k) {
            if (k === 'calls') return calls;
            if (k === 'canvas') return canvas;
            if (k === 'measureText') return text => ({ width: String(text).length * 6 });
            if (k === 'createImageData') return (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
            if (k === 'createPattern') return () => ({ pattern: true });
            if (k === 'createLinearGradient') return () => ({ addColorStop() {} });
            if (k in t) return t[k];
            return (...args) => { calls.push([k, ...args]); };
        },
        set(t, k, v) { t[k] = v; calls.push([`=${String(k)}`, v]); return true; },
    });
    return ctx;
}

/* ── document & globals ──────────────────────────────────────────────────────── */

export function createDocument() {
    const doc = {
        _active: null,
        createElement: tag => new FakeElement(doc, tag),
        createElementNS: (ns, tag) => new FakeElement(doc, tag, ns),
        createTextNode: text => new FakeText(doc, text),
        createDocumentFragment: () => { const f = new FakeElement(doc, '#fragment'); f.nodeType = 11; return f; },
        get activeElement() { return doc._active && doc._active.isConnected ? doc._active : doc.body; },
        getElementById: id => doc.documentElement.querySelector(`#${id}`),
        querySelector: sel => doc.documentElement.querySelector(sel),
        querySelectorAll: sel => doc.documentElement.querySelectorAll(sel),
        addEventListener() {},
        removeEventListener() {},
        readyState: 'complete',
    };
    doc.documentElement = new FakeElement(doc, 'html');
    doc.head = doc.documentElement.appendChild(new FakeElement(doc, 'head'));
    doc.body = doc.documentElement.appendChild(new FakeElement(doc, 'body'));
    return doc;
}

/**
 * Install the fake DOM as globals for the duration of a test file.
 * @param {{ cssVars?: Record<string, string> }} [opts] custom properties getComputedStyle reports
 * @returns {{ document: object, restore(): void, flush(): void }}
 */
export function installFakeDom({ cssVars = {} } = {}) {
    const doc = createDocument();
    const saved = {};
    const rafQueue = [];
    const globals = {
        document: doc,
        Node: FakeNode,
        window: { devicePixelRatio: 1, innerWidth: 1024, innerHeight: 800, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
        getComputedStyle: () => ({ getPropertyValue: name => cssVars[name] ?? '' }),
        requestAnimationFrame: fn => { rafQueue.push(fn); return rafQueue.length; },
        cancelAnimationFrame: () => {},
    };
    for (const [k, v] of Object.entries(globals)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); }
    return {
        document: doc,
        /** run queued animation frames (render passes) */
        flush() { while (rafQueue.length) rafQueue.shift()(); },
        restore() {
            for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; }
        },
    };
}
