/*
 * state.js — banner defaults, the four reference presets, and party persistence.
 */

const STORAGE_KEY = 'slop.dnd-banners.v1';

export function defaultBanner(overrides = {}) {
    return deepMerge({
        name: 'New banner',
        text: { name: 'ARYN', lines: ['Elf', 'Ranger'] },
        font: { key: 'germania-one', nameCase: 'upper', subCase: 'smallcaps', letterSpacing: 0.03, smallCapRatio: 0.78 },
        icon: { id: 'longbow', flipX: false, show: true, custom: null },
        size: {
            width: 30, height: 62, tailDepth: 9, tailStyle: 'swallowtail',
            cornerRadius: 1.2, plateThickness: 2.4,
        },
        layout: {
            sideMargin: 0.10, iconTop: 0.115, iconHeight: 0.40, iconGap: 0.035,
            iconWidthScale: 1, iconOffsetX: 0,
            nameSize: 0.070, subSize: 0.048, nameGap: 0.020, lineGap: 0.013,
            bottomPad: 0.045, textAnchor: 'center',
        },
        detail: {
            style: 'inlay', depth: 0.6, chamfer: 0.2, plateChamfer: 0.35, gap: 0,
            outline: { enabled: false, width: 0.7, around: 'b', into: 'a' },
        },
        hanger: {
            mode: 'attached', screenThickness: 3, clearance: 1.4, thickness: 2.6,
            overhang: 11, roundEnds: true, lip: 0, flangeThickness: 1.6, flangeHeight: 12,
        },
        parts: { icon: 'a', name: 'a', sub: 'a' },
        colors: { plate: '#6d1a1d', a: '#e8dfc8', b: '#b32a2b' },
        print: { minFeature: 0.4 },
    }, overrides);
}

/* The four tokens from the reference photographs, reproduced as selectable starting points. */
export const PRESETS = [
    {
        id: 'ivan',
        label: 'Ivan — Goliath Barbarian',
        banner: {
            name: 'Ivan',
            text: { name: 'Ivan', lines: ['Goliath', 'Barbarian'] },
            icon: { id: 'battle-axe' },
            colors: { plate: '#6e1c1e', a: '#e8dfc8', b: '#b32a2b' },
        },
    },
    {
        id: 'juniper',
        label: 'Juniper — Elf Druid',
        banner: {
            name: 'Juniper',
            text: { name: 'Juniper', lines: ['Elf', 'Druid'] },
            icon: { id: 'druid-leaf' },
            colors: { plate: '#6f6b33', a: '#ded6c0', b: '#b32a2b' },
        },
    },
    {
        id: 'elite',
        label: 'Elite — Dungeon Master',
        banner: {
            name: 'Elite',
            text: { name: 'Elite', lines: ['Dungeon', 'Master'] },
            icon: { id: 'daemon-skull' },
            parts: { icon: 'b', name: 'b', sub: 'a' },
            detail: { outline: { enabled: true, width: 0.7, around: 'b', into: 'a' } },
            colors: { plate: '#2f2b2c', a: '#ded6c8', b: '#b32a2b' },
        },
    },
    {
        id: 'quin',
        label: 'Quin — Human Crossbow Fighter',
        banner: {
            name: 'Quin',
            text: { name: 'Quin', lines: ['Human', 'Crossbow Fighter'] },
            icon: { id: 'striking-arrows' },
            colors: { plate: '#8f8b9c', a: '#e5decd', b: '#b32a2b' },
        },
    },
];

export function presetBanner(id) {
    const preset = PRESETS.find(p => p.id === id);
    return preset ? defaultBanner(preset.banner) : defaultBanner();
}

function deepMerge(base, patch) {
    if (patch === null || patch === undefined) return clone(base);
    // typeof null is "object", so a null default (icon.custom, say) has to be excluded
    // explicitly or the merge tries to write properties onto it.
    if (base === null || typeof base !== 'object' || typeof patch !== 'object'
        || Array.isArray(base) || Array.isArray(patch)) {
        return clone(patch);
    }
    const out = clone(base);
    for (const [k, v] of Object.entries(patch)) {
        out[k] = (k in base) ? deepMerge(base[k], v) : clone(v);
    }
    return out;
}

export function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone);
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = clone(val);
    return out;
}

/** Set a value at a dotted path, returning a new object. */
export function setPath(obj, path, value) {
    const out = clone(obj);
    const keys = path.split('.');
    let cur = out;
    for (let i = 0; i < keys.length - 1; i++) {
        if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
        cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = value;
    return out;
}

export function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/* ── sanitising ── */

export const safeColor = (c) => (/^#[0-9a-f]{6}$/i.test(String(c ?? '').trim())
    ? String(c).trim().toLowerCase() : '#cccccc');

/** Coerce a value to the shape of the corresponding default. */
function coerce(value, template) {
    if (typeof template === 'number') {
        const n = Number(value);
        return Number.isFinite(n) ? n : template;
    }
    if (typeof template === 'boolean') return value === true || value === 'true';
    if (typeof template === 'string') return typeof value === 'string' ? value : template;
    if (Array.isArray(template)) return Array.isArray(value) ? value : template;
    if (template && typeof template === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(template)) out[k] = coerce(value ? value[k] : undefined, v);
        return out;
    }
    return value;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Turn arbitrary JSON into a banner this app can actually build.
 *
 * Saved parties and imported files are just text: a field can be the wrong type, absurd,
 * or hostile. Everything is coerced to the shape of the defaults and clamped to a range
 * that still produces geometry, so a bad file degrades to an odd-looking banner rather
 * than a broken app or a persisted crash.
 */
export function sanitiseBanner(raw) {
    const merged = defaultBanner(raw && typeof raw === 'object' ? raw : {});
    const b = coerce(merged, defaultBanner());

    b.name = String(b.name || 'Banner').slice(0, 60);
    b.text.name = String(merged.text?.name ?? '').slice(0, 40);
    b.text.lines = (Array.isArray(merged.text?.lines) ? merged.text.lines : [])
        .slice(0, 4).map(l => String(l ?? '').slice(0, 60));

    const custom = merged.icon?.custom;
    b.icon.custom = (custom && typeof custom === 'object' && typeof custom.svg === 'string')
        ? { key: String(custom.key ?? ''), name: String(custom.name ?? 'icon.svg'), svg: custom.svg }
        : null;

    b.size.width = clamp(b.size.width, 8, 200);
    b.size.height = clamp(b.size.height, 15, 400);
    b.size.plateThickness = clamp(b.size.plateThickness, 0.6, 20);
    b.size.cornerRadius = clamp(b.size.cornerRadius, 0, b.size.width / 4);
    b.size.tailDepth = clamp(b.size.tailDepth, 0, b.size.height * 0.6);
    if (!['swallowtail', 'point', 'none'].includes(b.size.tailStyle)) b.size.tailStyle = 'swallowtail';

    if (!['inlay', 'raised', 'engraved'].includes(b.detail.style)) b.detail.style = 'inlay';
    b.detail.depth = clamp(b.detail.depth, 0.05, 10);
    b.detail.gap = clamp(b.detail.gap, 0, 2);
    b.detail.chamfer = clamp(b.detail.chamfer, 0, 4);
    b.detail.plateChamfer = clamp(b.detail.plateChamfer, 0, 4);
    b.detail.outline.width = clamp(b.detail.outline.width, 0.05, 6);

    if (!['attached', 'separate', 'none'].includes(b.hanger.mode)) b.hanger.mode = 'attached';
    b.hanger.screenThickness = clamp(b.hanger.screenThickness, 0, 60);
    b.hanger.clearance = clamp(b.hanger.clearance, 0, 20);
    b.hanger.thickness = clamp(b.hanger.thickness, 0.4, 20);
    b.hanger.overhang = clamp(b.hanger.overhang, 0, 120);
    b.hanger.lip = clamp(b.hanger.lip, 0, 40);
    b.hanger.flangeThickness = clamp(b.hanger.flangeThickness, 0.4, 10);
    b.hanger.flangeHeight = clamp(b.hanger.flangeHeight, 2, 100);

    for (const key of ['sideMargin', 'iconTop', 'iconHeight', 'iconGap', 'nameSize', 'subSize',
        'nameGap', 'lineGap', 'bottomPad']) {
        b.layout[key] = clamp(b.layout[key], 0, 0.9);
    }
    b.layout.iconWidthScale = clamp(b.layout.iconWidthScale, 0.05, 2);
    b.layout.iconOffsetX = clamp(b.layout.iconOffsetX, -0.5, 0.5);
    if (!['center', 'top'].includes(b.layout.textAnchor)) b.layout.textAnchor = 'center';
    b.print.minFeature = clamp(b.print.minFeature, 0.05, 10);

    for (const key of ['plate', 'a', 'b']) b.colors[key] = safeColor(b.colors[key]);
    for (const key of ['icon', 'name', 'sub']) if (b.parts[key] !== 'b') b.parts[key] = 'a';
    for (const key of ['nameCase', 'subCase']) {
        if (!['upper', 'smallcaps', 'as-typed'].includes(b.font[key])) b.font[key] = 'upper';
    }
    b.font.letterSpacing = clamp(b.font.letterSpacing, -0.1, 0.6);
    b.font.smallCapRatio = clamp(b.font.smallCapRatio, 0.4, 1);
    return b;
}

/** Sanitise a whole party, returning null when there is nothing usable in it. */
export function sanitiseParty(data) {
    const list = Array.isArray(data) ? data : (data && data.banners);
    if (!Array.isArray(list) || !list.length) return null;
    const banners = list.slice(0, 60).map(sanitiseBanner);
    const active = Number.isInteger(data?.active) ? clamp(data.active, 0, banners.length - 1) : 0;
    return { banners, active };
}

/* ── persistence ── */

function loadParty() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        return sanitiseParty(JSON.parse(raw));
    } catch (err) {
        return null;
    }
}

export function saveParty(party) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(party));
        return true;
    } catch (err) {
        return false; // private browsing or quota — the caller decides whether to say so
    }
}

export function startingParty() {
    return loadParty() || { banners: PRESETS.map(p => presetBanner(p.id)), active: 0 };
}
