/*
 * state.js — banner defaults, the four reference presets, and party persistence.
 */

export const STORAGE_KEY = 'slop.dnd-banners.v1';

export function defaultBanner(overrides = {}) {
    return deepMerge({
        name: 'New banner',
        text: { name: 'ARYN', lines: ['Elf', 'Ranger'] },
        font: { key: 'metamorphous', nameCase: 'upper', subCase: 'smallcaps', letterSpacing: 0.03, smallCapRatio: 0.78 },
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

export function deepMerge(base, patch) {
    if (patch === null || patch === undefined) return clone(base);
    if (Array.isArray(base) || Array.isArray(patch) || typeof patch !== 'object' || typeof base !== 'object') {
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

/* ── persistence ── */

export function loadParty() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.banners) || !data.banners.length) return null;
        return { banners: data.banners.map(b => defaultBanner(b)), active: data.active || 0 };
    } catch (err) {
        return null;
    }
}

export function saveParty(party) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(party));
    } catch (err) { /* private browsing, quota — not worth interrupting the user */ }
}

export function startingParty() {
    return loadParty() || { banners: PRESETS.map(p => presetBanner(p.id)), active: 0 };
}
