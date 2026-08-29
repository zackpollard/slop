/*
 * app.js — wiring: state <-> controls <-> geometry <-> preview and downloads.
 */

import { ICONS, ICON_CATEGORIES } from './icons.js';
import { FONTS, DEFAULT_FONT, loadFont, addCustomFont, customFonts } from './fonts.js';
import { buildBanner, iconRegions } from './banner.js';
import { Preview } from './preview.js';
import * as clip from './clip.js';
import { svgDocumentToContours } from './paths.js';
import { orientForPrint, translateParts, toBinarySTL, to3MF, download, slug } from './exporter.js';
import {
    startingParty, saveParty, defaultBanner, presetBanner, PRESETS,
    sanitiseParty, safeColor, setPath, getPath, clone,
} from './state.js';

const el = id => document.getElementById(id);
const party = startingParty();
let preview = null;
let latest = null;
let buildToken = 0;
let rebuildTimer = null;

const current = () => party.banners[party.active];
const iconCache = new Map();

/* ── icon resolution ── */

function resolveIcon(cfg) {
    // Custom icons are stored as the original SVG text, not as flattened contours: the
    // contours run to tens of thousands of numbers, which overflows localStorage and makes
    // an exported party file unreadable. Parsing is cached, so this costs nothing per frame.
    if (cfg.icon.custom && cfg.icon.custom.svg) {
        const key = `custom:${cfg.icon.custom.key}`;
        if (!iconCache.has(key)) {
            let acc = [];
            for (const shape of svgDocumentToContours(cfg.icon.custom.svg)) {
                const regions = clip.unionContours(shape.contours, shape.fillRule);
                if (regions.length) acc = acc.length ? clip.union(acc, regions) : regions;
            }
            iconCache.set(key, acc);
        }
        return { regions: iconCache.get(key) };
    }
    const icon = ICONS.find(i => i.id === cfg.icon.id);
    if (!icon) return { regions: [] };
    if (!iconCache.has(icon.id)) iconCache.set(icon.id, iconRegions(icon));
    return { regions: iconCache.get(icon.id) };
}

/* ── build ── */

function scheduleRebuild() {
    if (!saveParty(party) && !scheduleRebuild.warned) {
        scheduleRebuild.warned = true;
        toast('Could not save to this browser — export the JSON if you want to keep this party.', true);
    }
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, 70);
}

async function rebuild() {
    const token = ++buildToken;
    const cfg = current();
    let font = null;
    try {
        font = await loadFont(cfg.font.key);
    } catch (err) {
        if (cfg.font.key !== DEFAULT_FONT) {
            toast(`${err.message}. Falling back to the default font.`, true);
            try { font = await loadFont(DEFAULT_FONT); } catch (e2) { /* reported below */ }
        } else {
            toast(err.message, true);
        }
    }
    if (token !== buildToken) return;

    let built;
    try {
        built = buildBanner(cfg, { font, icon: resolveIcon(cfg) });
    } catch (err) {
        console.error(err);
        toast('Could not build that banner — try undoing the last change.', true);
        return;
    }
    if (token !== buildToken) return;

    latest = built;
    preview.setParts(built.parts, built.metrics, cfg);
    renderWarnings(built.warnings.concat(font ? [] : ['The font could not be downloaded, so lettering has been left off. Check your connection or upload a font file.']));
    renderMetrics(built);
    renderDownloads(built);
    renderPartyTabs();
}

/* ── rendering the chrome ── */

function renderWarnings(warnings) {
    const box = el('warnings');
    box.innerHTML = '';
    for (const w of warnings) {
        const d = document.createElement('div');
        d.className = 'warning';
        d.textContent = w;
        box.appendChild(d);
    }
}

function renderMetrics(built) {
    const m = built.metrics;
    const tris = built.parts.reduce((n, p) => n + p.positions.length / 9, 0);
    el('metrics').innerHTML = [
        `Banner <b>${m.width.toFixed(1)} × ${m.height.toFixed(1)} mm</b>`,
        `Bar span <b>${m.barWidth.toFixed(1)} mm</b>`,
        `Depth <b>${m.depth.toFixed(1)} mm</b>`,
        `Parts <b>${built.parts.length}</b>`,
        `Triangles <b>${tris.toLocaleString()}</b>`,
    ].join('');
    el('status').textContent = `${m.width.toFixed(0)} × ${m.height.toFixed(0)} mm · drag to orbit`;
}

function renderDownloads(built) {
    const cfg = current();
    const grid = el('download-grid');
    grid.innerHTML = '';
    const parts = orientForPrint(built.parts, cfg);
    el('print-hint').textContent = printHint(cfg, parts);
    // The banner these buttons describe is the one that was just built. Reading the name
    // at click time would label a download for whichever tab the user has since moved to.
    const base = slug(cfg.text.name);
    for (const part of parts) {
        const b = document.createElement('button');
        b.className = 'btn part-btn';
        b.append(swatch(part.color), document.createTextNode(part.label));
        b.onclick = () => {
            const name = `${base}-${part.key}.stl`;
            download(new Blob([toBinarySTL(part.positions, name)], { type: 'model/stl' }), name);
        };
        grid.appendChild(b);
    }
}

/** One line under the download buttons saying how this configuration wants to be printed. */
function printHint(cfg, parts) {
    const bits = [];
    bits.push(cfg.detail.style === 'raised'
        ? 'Prints face up, detail last'
        : 'Prints face down on a textured plate');
    bits.push(`${parts.length} part${parts.length === 1 ? '' : 's'}, sharing one origin`);
    if (cfg.detail.style !== 'engraved' && parts.some(p => p.key.startsWith('detail'))) {
        bits.push(`single extruder: filament change at ${changeHeight(cfg).toFixed(2)} mm`);
    }
    if (cfg.hanger.mode === 'separate') bits.push('bracket sits beside the banner, glue it on afterwards');
    return bits.join(' · ');
}

/**
 * The height at which a single-extruder print swaps filament.
 *
 * Inlaid and engraved detail is sunk into the front face, which prints first, so the swap
 * is at the pocket depth — capped, because banner.js keeps a 0.4 mm floor behind it.
 * Raised detail prints face up and sits on top of the finished plate, so the swap is at
 * the full plate thickness instead.
 */
function changeHeight(cfg) {
    return cfg.detail.style === 'raised'
        ? cfg.size.plateThickness
        : Math.min(cfg.detail.depth, cfg.size.plateThickness - 0.4);
}

function renderPartyTabs() {
    const tabs = el('party-tabs');
    tabs.innerHTML = '';
    party.banners.forEach((b, i) => {
        const t = document.createElement('button');
        t.className = 'party-tab' + (i === party.active ? ' active' : '');
        t.append(swatch(b.colors.plate), document.createTextNode(b.text.name || 'Untitled'));
        t.onclick = () => { party.active = i; refreshControls(); scheduleRebuild(); };
        tabs.appendChild(t);
    });
    el('btn-delete').disabled = party.banners.length <= 1;
}

/** Colour chips are built as elements, never interpolated: colours can arrive from an
 *  imported file, and a style attribute assembled by string is an injection point. */
function swatch(color, className = 'swatch') {
    const span = document.createElement('span');
    span.className = className;
    span.style.background = safeColor(color);
    return span;
}

/* ── control binding ── */

function readInput(input) {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number' || input.type === 'range') {
        const v = parseFloat(input.value);
        if (!isFinite(v)) return null;
        // Browsers do not enforce min/max on a typed number, and a negative overhang or a
        // zero thickness reaches the geometry as-is.
        const lo = parseFloat(input.min), hi = parseFloat(input.max);
        return Math.min(isFinite(hi) ? hi : Infinity, Math.max(isFinite(lo) ? lo : -Infinity, v));
    }
    return input.value;
}

function writeInput(input, value) {
    if (input.type === 'checkbox') input.checked = !!value;
    else if (document.activeElement !== input) input.value = value ?? '';
}

/**
 * Name every control for assistive technology.
 *
 * The sliders and number boxes sit next to a <span> caption rather than a <label>, and a
 * slider/number pair shares one caption, so nothing associates them automatically.
 */
function labelControls() {
    document.querySelectorAll('.field').forEach(field => {
        const caption = field.querySelector('.field-label');
        if (!caption) return;
        const name = caption.textContent.replace(/\s+/g, ' ').trim();
        const inputs = field.querySelectorAll('input[data-path], select[data-path]');
        inputs.forEach(input => {
            if (input.getAttribute('aria-label')) return;
            const kind = inputs.length > 1 && input.type === 'number' ? ' (value)'
                : inputs.length > 1 && input.type === 'range' ? ' (slider)' : '';
            input.setAttribute('aria-label', name + kind);
        });
    });
}

function bindControls() {
    labelControls();
    document.querySelectorAll('[data-path]').forEach(input => {
        const evt = input.type === 'number' ? 'change' : 'input';
        input.addEventListener(evt, () => {
            const value = readInput(input);
            if (value === null) return;
            party.banners[party.active] = setPath(current(), input.dataset.path, value);
            syncPath(input.dataset.path, input);
            scheduleRebuild();
        });
        if (input.type === 'number') {
            input.addEventListener('input', () => {
                const v = readInput(input);
                if (v === null) return;
                party.banners[party.active] = setPath(current(), input.dataset.path, v);
                syncPath(input.dataset.path, input);
                scheduleRebuild();
            });
        }
    });
}

function syncPath(path, except) {
    const value = getPath(current(), path);
    document.querySelectorAll(`[data-path="${path}"]`).forEach(other => {
        if (other !== except) writeInput(other, value);
    });
}

function refreshControls() {
    const cfg = current();
    document.querySelectorAll('[data-path]').forEach(input => writeInput(input, getPath(cfg, input.dataset.path)));
    renderSubLines();
    renderIconGrid();
    renderPartyTabs();
}

/* ── subtitle lines ── */

function renderSubLines() {
    const box = el('sub-lines');
    box.innerHTML = '';
    const lines = current().text.lines || [];
    lines.forEach((line, i) => {
        const row = document.createElement('div');
        row.className = 'sub-line';
        const input = document.createElement('input');
        input.type = 'text';
        input.value = line;
        input.maxLength = 28;
        input.placeholder = i === 0 ? 'Race' : 'Class';
        input.addEventListener('input', () => {
            const next = [...current().text.lines];
            next[i] = input.value;
            party.banners[party.active] = setPath(current(), 'text.lines', next);
            scheduleRebuild();
        });
        const rm = document.createElement('button');
        rm.className = 'btn btn-small btn-danger';
        rm.textContent = '×';
        rm.title = 'Remove line';
        rm.onclick = () => {
            const next = current().text.lines.filter((_, j) => j !== i);
            party.banners[party.active] = setPath(current(), 'text.lines', next);
            renderSubLines();
            scheduleRebuild();
        };
        row.append(input, rm);
        box.appendChild(row);
    });
    el('btn-add-line').disabled = lines.length >= 4;
}

/* ── icon picker ── */

function iconSvg(icon, size = 40) {
    const paths = icon.paths.map(d => `<path d="${d}"/>`).join('');
    return `<svg viewBox="${icon.viewBox || '0 0 512 512'}" width="${size}" height="${size}" fill-rule="${icon.fillRule || 'evenodd'}">${paths}</svg>`;
}

function renderCustomIcon() {
    const row = el('custom-icon');
    const custom = current().icon.custom;
    row.hidden = !custom;
    if (!custom) return;
    row.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = `Using ${custom.name}`;
    const clear = document.createElement('button');
    clear.className = 'btn btn-small';
    clear.textContent = 'Use a library icon';
    clear.onclick = () => {
        party.banners[party.active] = setPath(current(), 'icon.custom', null);
        renderIconGrid();
        scheduleRebuild();
    };
    row.append(label, clear);
}

function renderIconGrid() {
    renderCustomIcon();
    const grid = el('icon-grid');
    const q = el('icon-search').value.trim().toLowerCase();
    const cat = el('icon-category').value;
    const cfg = current();
    const matches = ICONS.filter(i =>
        (cat === 'all' || i.category === cat) &&
        (!q || i.name.toLowerCase().includes(q) || i.id.includes(q) || i.category.includes(q)));
    grid.innerHTML = '';
    if (!matches.length) {
        grid.innerHTML = '<p class="icon-empty">No icons match that search.</p>';
        return;
    }
    for (const icon of matches) {
        const cell = document.createElement('button');
        cell.className = 'icon-cell' + (!cfg.icon.custom && cfg.icon.id === icon.id ? ' active' : '');
        cell.title = icon.name;
        cell.setAttribute('aria-label', icon.name);
        cell.innerHTML = iconSvg(icon);
        cell.onclick = () => {
            party.banners[party.active] = setPath(setPath(current(), 'icon.id', icon.id), 'icon.custom', null);
            renderIconGrid();
            scheduleRebuild();
        };
        grid.appendChild(cell);
    }
}

/* ── presets ── */

function renderPresets() {
    const row = el('preset-row');
    row.innerHTML = '';
    for (const preset of PRESETS) {
        const b = document.createElement('button');
        b.className = 'preset';
        const banner = presetBanner(preset.id);
        b.append(swatch(banner.colors.plate, 'chip'), document.createTextNode(preset.label.split(' — ')[0]));
        b.title = preset.label;
        b.onclick = () => {
            party.banners[party.active] = presetBanner(preset.id);
            refreshControls();
            scheduleRebuild();
        };
        row.appendChild(b);
    }
    const blank = document.createElement('button');
    blank.className = 'preset';
    blank.append(swatch('#6d1a1d', 'chip'), document.createTextNode('Blank'));
    blank.onclick = () => {
        party.banners[party.active] = defaultBanner();
        refreshControls();
        scheduleRebuild();
    };
    row.appendChild(blank);
}

/* ── exports ── */

function partsForExport(cfg, built) {
    return orientForPrint(built.parts, cfg);
}

async function exportZip() {
    const cfg = current();
    const parts = partsForExport(cfg, latest);
    const zip = new window.JSZip();
    const base = slug(cfg.text.name);
    const folder = zip.folder(base);
    for (const part of parts) {
        folder.file(`${base}-${part.key}.stl`, toBinarySTL(part.positions, part.key));
    }
    folder.file('README.txt', printNotes(cfg, parts, base));
    download(await zip.generateAsync({ type: 'blob' }), `${base}-banner-stl.zip`);
}

function printNotes(cfg, parts, base) {
    const depth = changeHeight(cfg);
    const lines = [
        `Banner token: ${cfg.text.name}`,
        `${(cfg.text.lines || []).filter(Boolean).join(' / ')}`,
        '',
        `Banner        ${cfg.size.width} x ${cfg.size.height} mm, ${cfg.size.plateThickness} mm thick`,
        `Detail style  ${cfg.detail.style}`,
        `Hanger        ${cfg.hanger.mode}, fits a ${cfg.hanger.screenThickness} mm screen with ${cfg.hanger.clearance} mm clearance`,
        '',
        'Files:',
        ...parts.map(p => `  ${base}-${p.key}.stl — ${p.label} (${p.color})`),
        '',
        cfg.detail.style === 'raised'
            ? 'Print the banner FACE UP. Raised detail is the last thing printed.'
            : 'Print the banner FACE DOWN on a textured plate. The detail parts fill the pockets in the plate face.',
    ];
    if (cfg.hanger.mode === 'separate') {
        lines.push('The hanger bracket is a separate print, laid out beside the banner. Glue its flat',
            'flange to the back of the banner at the top once both are printed.');
    }
    if (parts.some(p => p.key.startsWith('detail'))) {
        lines.push('All parts share one origin, so load them together in your slicer and do not move them.',
            `Single-extruder printers: slice the plate alone and insert a filament change at ${depth.toFixed(2)} mm.`);
    } else {
        lines.push('Single part, single colour — nothing to align.');
    }
    return lines.join('\n');
}

async function exportPartyZip() {
    const zip = new window.JSZip();
    const used = new Set();
    for (const [i, cfg] of party.banners.entries()) {
        let built;
        try {
            built = buildBanner(cfg, { font: await loadFont(cfg.font.key).catch(() => null), icon: resolveIcon(cfg) });
        } catch (err) { continue; }
        const parts = partsForExport(cfg, built);
        // Two characters may well share a name; without this the second overwrites the first.
        let base = slug(cfg.text.name, `banner-${i + 1}`);
        if (used.has(base)) base = `${base}-${i + 1}`;
        used.add(base);
        const folder = zip.folder(base);
        for (const part of parts) folder.file(`${base}-${part.key}.stl`, toBinarySTL(part.positions, part.key));
        folder.file('README.txt', printNotes(cfg, parts, base));
    }
    download(await zip.generateAsync({ type: 'blob' }), 'banner-tokens.zip');
}

/** Lay the whole party out in a row so one 3MF drops straight onto the bed. */
async function exportPartyPlate() {
    const groups = [];
    for (const cfg of party.banners) {
        let built;
        try {
            built = buildBanner(cfg, { font: await loadFont(cfg.font.key).catch(() => null), icon: resolveIcon(cfg) });
        } catch (err) { continue; }
        const parts = partsForExport(cfg, built);
        // Measure what was actually produced. In separate-hanger mode orientForPrint parks
        // the bracket beside the banner, so a banner's footprint is much wider than the
        // banner itself — spacing by the bar span alone drops each bracket into the next
        // banner's plate.
        const box = partsBounds(parts);
        if (box) groups.push({ cfg, parts, box });
    }
    if (!groups.length) return;

    const GAP = 6;
    const total = groups.reduce((w, g) => w + (g.box.maxX - g.box.minX), 0) + GAP * (groups.length - 1);
    let cursor = -total / 2;
    const all = [];
    for (const { cfg, parts, box } of groups) {
        const dx = cursor - box.minX;
        for (const p of translateParts(parts, dx, 0)) {
            all.push({ ...p, key: `${slug(cfg.text.name)}-${p.key}`, label: `${cfg.text.name} — ${p.label}` });
        }
        cursor += (box.maxX - box.minX) + GAP;
    }
    download(await to3MF(all, 'Banner tokens'), 'banner-tokens-plate.3mf');
}

function partsBounds(parts) {
    let minX = Infinity, maxX = -Infinity;
    for (const part of parts) {
        for (let i = 0; i < part.positions.length; i += 3) {
            if (part.positions[i] < minX) minX = part.positions[i];
            if (part.positions[i] > maxX) maxX = part.positions[i];
        }
    }
    return minX === Infinity ? null : { minX, maxX };
}

/* ── files in ── */

/** Cheap content hash, so re-uploading an edited file of the same size is not mistaken
 *  for the one already cached. */
function hashText(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

function readFile(input, as = 'text') {
    return new Promise((resolve, reject) => {
        const file = input.files && input.files[0];
        if (!file) return reject(new Error('No file chosen'));
        const r = new FileReader();
        r.onload = () => resolve({ name: file.name, data: r.result });
        r.onerror = () => reject(new Error('Could not read that file'));
        if (as === 'buffer') r.readAsArrayBuffer(file); else r.readAsText(file);
    });
}

function toast(message, isError = false) {
    const t = el('toast');
    t.textContent = message;
    t.className = 'toast' + (isError ? ' error' : '');
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 2600);
}

/* ── boot ── */

function populateFontSelect() {
    const sel = el('font-select');
    sel.innerHTML = '';
    for (const f of [...FONTS, ...customFonts()]) {
        const o = document.createElement('option');
        o.value = f.key;
        o.textContent = f.note ? `${f.label} — ${f.note}` : f.label;
        sel.appendChild(o);
    }
    sel.value = current().font.key;
}

function populateCategories() {
    const sel = el('icon-category');
    sel.innerHTML = '<option value="all">All</option>';
    for (const c of ICON_CATEGORIES) {
        const o = document.createElement('option');
        o.value = c;
        o.textContent = c[0].toUpperCase() + c.slice(1);
        sel.appendChild(o);
    }
}

/**
 * An uploaded font lives only in memory, but its key is saved with the party. After a
 * reload the reference dangles, so put those banners back on the default face and say so
 * rather than letting them silently export in the wrong typeface.
 */
function normaliseFonts() {
    const known = new Set([...FONTS.map(f => f.key), ...customFonts().map(f => f.key)]);
    const orphaned = party.banners.filter(b => !known.has(b.font.key));
    for (const banner of orphaned) banner.font.key = DEFAULT_FONT;
    if (orphaned.length) {
        toast(`${orphaned.length === 1 ? 'A banner used' : `${orphaned.length} banners used`} an uploaded font, which browsers cannot keep. Reset to the default — upload the file again to restore it.`, true);
    }
}

/** An imported or older saved party may name an icon this build no longer ships. */
function normaliseIcons() {
    const fallback = ICONS.length ? ICONS[0].id : null;
    for (const banner of party.banners) {
        if (banner.icon.custom || ICONS.some(i => i.id === banner.icon.id)) continue;
        banner.icon.id = fallback;
    }
}

function init() {
    normaliseIcons();
    try {
        preview = new Preview(el('view'));
    } catch (err) {
        // No WebGL: keep the designer and the downloads working rather than dying here.
        preview = { setParts() {}, resetView() {}, setScreenVisible() {}, wantScreen: false };
        const viewport = el('view').parentElement;
        const note = document.createElement('p');
        note.className = 'viewport-fallback';
        note.textContent = '3D preview unavailable — this browser could not start WebGL. Everything else, including the downloads, still works.';
        viewport.appendChild(note);
        el('view').hidden = true;
    }
    normaliseFonts();
    populateFontSelect();
    populateCategories();
    renderPresets();
    bindControls();
    refreshControls();

    el('icon-search').addEventListener('input', renderIconGrid);
    el('icon-category').addEventListener('change', renderIconGrid);

    el('btn-add-line').onclick = () => {
        const next = [...(current().text.lines || []), ''];
        party.banners[party.active] = setPath(current(), 'text.lines', next);
        renderSubLines();
        scheduleRebuild();
    };

    el('btn-add').onclick = () => {
        party.banners.push(defaultBanner());
        party.active = party.banners.length - 1;
        normaliseIcons();
        refreshControls();
        scheduleRebuild();
    };
    el('btn-duplicate').onclick = () => {
        party.banners.splice(party.active + 1, 0, clone(current()));
        party.active += 1;
        refreshControls();
        scheduleRebuild();
    };
    el('btn-delete').onclick = () => {
        if (party.banners.length <= 1) return;
        party.banners.splice(party.active, 1);
        party.active = Math.min(party.active, party.banners.length - 1);
        refreshControls();
        scheduleRebuild();
    };

    el('btn-reset-view').onclick = () => preview.resetView(latest ? latest.metrics : null);
    el('chk-screen').onchange = e => { preview.wantScreen = e.target.checked; preview.setScreenVisible(e.target.checked); };

    el('icon-upload').addEventListener('change', async e => {
        try {
            const { name, data } = await readFile(e.target, 'text');
            if (!svgDocumentToContours(data).length) throw new Error('No filled shapes found in that SVG');
            party.banners[party.active] = setPath(current(), 'icon.custom', { key: hashText(data), name, svg: data });
            renderIconGrid();
            scheduleRebuild();
            toast(`Using ${name}`);
        } catch (err) {
            toast(err.message, true);
        }
        e.target.value = '';
    });

    el('font-upload').addEventListener('change', async e => {
        try {
            const { name, data } = await readFile(e.target, 'buffer');
            const key = addCustomFont(name.replace(/\.[^.]+$/, ''), data);
            populateFontSelect();
            party.banners[party.active] = setPath(current(), 'font.key', key);
            el('font-select').value = key;
            scheduleRebuild();
            toast(`Loaded ${name}`);
        } catch (err) {
            toast('That font could not be read. TTF and OTF work best.', true);
        }
        e.target.value = '';
    });

    el('btn-3mf').onclick = async () => {
        if (!latest) return;
        const cfg = current();
        download(await to3MF(partsForExport(cfg, latest), cfg.text.name), `${slug(cfg.text.name)}-banner.3mf`);
    };
    el('btn-zip').onclick = () => latest && exportZip();
    el('btn-stl-all').onclick = () => {
        if (!latest) return;
        const cfg = current();
        const merged = partsForExport(cfg, latest).flatMap(p => p.positions);
        const name = `${slug(cfg.text.name)}-banner-combined.stl`;
        download(new Blob([toBinarySTL(merged, name)], { type: 'model/stl' }), name);
    };
    el('btn-party-zip').onclick = () => exportPartyZip();
    el('btn-party-3mf').onclick = () => exportPartyPlate();

    el('btn-export-json').onclick = () => {
        download(new Blob([JSON.stringify(party, null, 2)], { type: 'application/json' }), 'banner-tokens.json');
    };
    el('btn-import').onclick = () => el('json-import').click();
    el('json-import').addEventListener('change', async e => {
        try {
            const { data } = await readFile(e.target, 'text');
            // Sanitise into a complete party first: nothing is replaced until the file has
            // produced something buildable, so a bad import cannot destroy the current work.
            const incoming = sanitiseParty(JSON.parse(data));
            if (!incoming) throw new Error('No banners in that file');
            party.banners = incoming.banners;
            party.active = incoming.active;
            normaliseIcons();
            normaliseFonts();
            refreshControls();
            scheduleRebuild();
            toast(`Imported ${incoming.banners.length} banner${incoming.banners.length === 1 ? '' : 's'}`);
        } catch (err) {
            toast('That JSON does not look like a saved party.', true);
        }
        e.target.value = '';
    });

    document.querySelectorAll('.card.collapsible button.toggle').forEach(button => {
        const card = button.closest('.card');
        button.addEventListener('click', () => {
            const collapsed = card.classList.toggle('collapsed');
            button.setAttribute('aria-expanded', String(!collapsed));
        });
    });

    preview.wantScreen = true;
    rebuild();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
