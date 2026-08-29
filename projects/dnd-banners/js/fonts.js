/*
 * fonts.js — font catalogue and text-to-outline layout.
 *
 * Real glyph outlines are needed (not canvas text), so the TTFs are fetched from the
 * Google Fonts repo via jsDelivr and parsed with opentype.js. Text is sized by CAP HEIGHT
 * rather than em size: cap height is stable across strings and fonts, so a 4 mm name is
 * actually 4 mm of ink whichever face is picked.
 */

import { commandsToContours, contoursBounds, transformContours } from './paths.js';

const GF = 'https://cdn.jsdelivr.net/gh/google/fonts@main/';

export const FONTS = [
    { key: 'germania-one', label: 'Germania One', note: 'closest to the reference tokens', url: GF + 'ofl/germaniaone/GermaniaOne-Regular.ttf' },
    { key: 'almendra', label: 'Almendra Bold', note: 'heavy storybook serif', url: GF + 'ofl/almendra/Almendra-Bold.ttf' },
    { key: 'metamorphous', label: 'Metamorphous', note: 'lighter fantasy serif', url: GF + 'ofl/metamorphous/Metamorphous-Regular.ttf' },
    { key: 'cinzel', label: 'Cinzel', note: 'roman inscriptional caps', url: GF + 'ofl/cinzel/Cinzel%5Bwght%5D.ttf' },
    { key: 'cinzel-decorative', label: 'Cinzel Decorative', note: 'ornate caps', url: GF + 'ofl/cinzeldecorative/CinzelDecorative-Bold.ttf' },
    { key: 'marcellus-sc', label: 'Marcellus SC', note: 'elegant small caps', url: GF + 'ofl/marcellussc/MarcellusSC-Regular.ttf' },
    { key: 'grenze-gotisch', label: 'Grenze Gotisch', note: 'condensed gothic', url: GF + 'ofl/grenzegotisch/GrenzeGotisch%5Bwght%5D.ttf' },
    { key: 'pirata-one', label: 'Pirata One', note: 'blackletter', url: GF + 'ofl/pirataone/PirataOne-Regular.ttf' },
    { key: 'uncial-antiqua', label: 'Uncial Antiqua', note: 'celtic uncial', url: GF + 'ofl/uncialantiqua/UncialAntiqua-Regular.ttf' },
    { key: 'eagle-lake', label: 'Eagle Lake', note: 'calligraphic', url: GF + 'ofl/eaglelake/EagleLake-Regular.ttf' },
    { key: 'rye', label: 'Rye', note: 'western slab', url: GF + 'ofl/rye/Rye-Regular.ttf' },
    { key: 'caudex', label: 'Caudex Bold', note: 'sturdy serif', url: GF + 'ofl/caudex/Caudex-Bold.ttf' },
    { key: 'cormorant-unicase', label: 'Cormorant Unicase', note: 'unicase serif', url: GF + 'ofl/cormorantunicase/CormorantUnicase-Bold.ttf' },
    { key: 'spectral-sc', label: 'Spectral SC Bold', note: 'readable small caps', url: GF + 'ofl/spectralsc/SpectralSC-Bold.ttf' },
    { key: 'black-ops-one', label: 'Black Ops One', note: 'stencil', url: GF + 'ofl/blackopsone/BlackOpsOne-Regular.ttf' },
    { key: 'bebas-neue', label: 'Bebas Neue', note: 'tall condensed sans', url: GF + 'ofl/bebasneue/BebasNeue-Regular.ttf' },
    { key: 'oswald', label: 'Oswald', note: 'condensed sans', url: GF + 'ofl/oswald/Oswald%5Bwght%5D.ttf' },
    { key: 'noto-sans', label: 'Noto Sans', note: 'plain sans', url: GF + 'ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf' },
];

export const DEFAULT_FONT = 'germania-one';

const cache = new Map();      // key -> Promise<Font>
const custom = new Map();     // key -> Font (user uploaded)

export function customFonts() {
    return [...custom.keys()].map(key => ({ key, label: key.replace(/^custom:/, ''), note: 'uploaded', custom: true }));
}

export async function loadFont(key) {
    if (custom.has(key)) return custom.get(key);
    if (cache.has(key)) return cache.get(key);
    const entry = FONTS.find(f => f.key === key);
    if (!entry) throw new Error(`Unknown font "${key}"`);
    const p = (async () => {
        const res = await fetch(entry.url);
        if (!res.ok) throw new Error(`Could not download ${entry.label} (HTTP ${res.status})`);
        const buf = await res.arrayBuffer();
        return window.opentype.parse(buf);
    })();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    return p;
}

export function addCustomFont(name, arrayBuffer) {
    const font = window.opentype.parse(arrayBuffer);
    const key = `custom:${name}`;
    custom.set(key, font);
    return key;
}

/**
 * Cap height in font units, measured from the actual 'H' so it is never a guess.
 * Only the ink above the baseline counts — an ornate face whose H carries a descending
 * flourish would otherwise be sized as if the flourish were part of the capital, and
 * every line set in it would come out noticeably small.
 */
function capUnits(font) {
    try {
        const bb = font.charToGlyph('H').getBoundingBox();
        if (bb && isFinite(bb.y2) && bb.y2 > 1) return bb.y2;
    } catch (err) { /* fall through */ }
    return font.ascender * 0.7;
}

const isLower = ch => ch !== ch.toUpperCase() && ch === ch.toLowerCase();

/** Uppercasing can lengthen a character (German sharp s becomes SS); glyph lookup takes
 *  one character, so leave those as typed rather than silently dropping half of them. */
const upper = ch => {
    const up = ch.toUpperCase();
    return [...up].length === 1 ? up : ch;
};

/**
 * Build the glyph run for a line. Small caps are synthesised by scaling the uppercase
 * glyph of any originally-lowercase letter — that is what the reference tokens do, and it
 * works with every font rather than only true small-caps faces.
 */
function buildRun(font, text, textCase, smallCapRatio) {
    const run = [];
    for (const ch of text) {
        if (textCase === 'smallcaps') {
            run.push({ ch: upper(ch), scale: isLower(ch) ? smallCapRatio : 1 });
        } else if (textCase === 'upper') {
            run.push({ ch: upper(ch), scale: 1 });
        } else {
            run.push({ ch, scale: 1 });
        }
    }
    return run;
}

/**
 * Lay out one line of text.
 *
 * Returns contours in millimetres with the baseline on y = 0 and the ink starting at
 * x = 0, plus the measured ink box. `maxWidthMm` shrinks the whole line to fit rather
 * than clipping it, which is how long subtitles like "CROSSBOW FIGHTER" stay on the banner.
 */
export function layoutLine(font, text, {
    capHeightMm = 4,
    letterSpacingEm = 0.02,
    textCase = 'upper',
    smallCapRatio = 0.78,
    maxWidthMm = Infinity,
} = {}) {
    const str = String(text ?? '').trim();
    if (!str) return null;

    const upm = font.unitsPerEm;
    const cap = capUnits(font);
    const run = buildRun(font, str, textCase, smallCapRatio);
    const tracking = letterSpacingEm * upm;

    let cursor = 0;
    let commands = [];
    let prevGlyph = null;
    for (let i = 0; i < run.length; i++) {
        const { ch, scale } = run[i];
        const glyph = font.charToGlyph(ch);
        if (prevGlyph) {
            let kern = 0;
            try { kern = font.getKerningValue(prevGlyph, glyph) || 0; } catch (err) { kern = 0; }
            cursor += kern * scale + tracking;
        }
        if (ch !== ' ') {
            const path = glyph.getPath(cursor, 0, upm * scale);
            commands = commands.concat(path.commands);
        }
        // A zero advance is legitimate (combining marks); only a missing one needs a default.
        cursor += (glyph.advanceWidth ?? upm * 0.5) * scale;
        prevGlyph = glyph;
    }

    const raw = commandsToContours(commands, upm / 4);
    const box = contoursBounds(raw);
    if (!box) return null;

    const wanted = capHeightMm / cap;
    let scale = wanted;
    if (box.width * scale > maxWidthMm) scale = maxWidthMm / box.width;

    const contours = transformContours(raw, { sx: scale, sy: scale, dx: -box.minX * scale, dy: 0 });
    return {
        contours,
        width: box.width * scale,
        height: box.height * scale,
        top: box.maxY * scale,
        bottom: box.minY * scale,
        capHeight: cap * scale,
        fit: scale / wanted,
    };
}
