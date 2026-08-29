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
    setPath, getPath, clone,
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
            const g = svgDocumentToContours(cfg.icon.custom.svg);
            const a = clip.unionContours(g.evenodd || [], 'evenodd');
            const b = clip.unionContours(g.nonzero || [], 'nonzero');
            iconCache.set(key, a.length && b.length ? clip.union(a, b) : (a.length ? a : b));
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
    for (const part of parts) {
        const b = document.createElement('button');
        b.className = 'btn part-btn';
        b.innerHTML = `<span class="swatch" style="background:${part.color}"></span>${part.label}`;
        b.onclick = () => {
            const name = `${slug(current().text.name)}-${part.key}.stl`;
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
    if (cfg.detail.style !== 'engraved' && parts.length > 1) {
        bits.push(`single extruder: filament change at ${Math.min(cfg.detail.depth, cfg.size.plateThickness - 0.4).toFixed(2)} mm`);
    }
    if (cfg.hanger.mode === 'separate') bits.push('bracket sits beside the banner, glue it on afterwards');
    return bits.join(' · ');
}

function renderPartyTabs() {
    const tabs = el('party-tabs');
    tabs.innerHTML = '';
    party.banners.forEach((b, i) => {
        const t = document.createElement('button');
        t.className = 'party-tab' + (i === party.active ? ' active' : '');
        t.innerHTML = `<span class="swatch" style="background:${b.colors.plate}"></span>${escapeHtml(b.text.name || 'Untitled')}`;
        t.onclick = () => { party.active = i; refreshControls(); scheduleRebuild(); };
        tabs.appendChild(t);
    });
    el('btn-delete').disabled = party.banners.length <= 1;
}

const escapeHtml = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* ── control binding ── */

function readInput(input) {
    if (input.type === 'checkbox') return input.checked;
    if (input.type === 'number' || input.type === 'range') {
        const v = parseFloat(input.value);
        return isFinite(v) ? v : null;
    }
    return input.value;
}

function writeInput(input, value) {
    if (input.type === 'checkbox') input.checked = !!value;
    else if (document.activeElement !== input) input.value = value ?? '';
}

function bindControls() {
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
        b.innerHTML = `<span class="chip" style="background:${banner.colors.plate}"></span>${escapeHtml(preset.label.split(' — ')[0])}`;
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
    blank.innerHTML = '<span class="chip" style="background:#6d1a1d"></span>Blank';
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
    folder.file('README.txt', printNotes(cfg, parts));
    download(await zip.generateAsync({ type: 'blob' }), `${base}-banner-stl.zip`);
}

function printNotes(cfg, parts) {
    return [
        `Banner token: ${cfg.text.name}`,
        `${(cfg.text.lines || []).filter(Boolean).join(' / ')}`,
        '',
        `Banner        ${cfg.size.width} x ${cfg.size.height} mm, ${cfg.size.plateThickness} mm thick`,
        `Detail style  ${cfg.detail.style} (${cfg.detail.depth} mm deep)`,
        `Hanger        ${cfg.hanger.mode}, fits a ${cfg.hanger.screenThickness} mm screen with ${cfg.hanger.clearance} mm clearance`,
        '',
        'Files:',
        ...parts.map(p => `  ${p.key}.stl — ${p.label} (${p.color})`),
        '',
        cfg.detail.style === 'raised'
            ? 'Print the banner FACE UP. Raised detail is the last thing printed.'
            : 'Print the banner FACE DOWN on a textured plate. The detail parts fill the pockets in the plate face.',
        'All parts share one origin, so load them together in your slicer and do not move them.',
        cfg.detail.style !== 'raised'
            ? `Single-extruder printers: slice the plate alone and insert a filament change at ${cfg.detail.depth} mm.`
            : '',
    ].join('\n');
}

async function exportPartyZip() {
    const zip = new window.JSZip();
    for (const cfg of party.banners) {
        let built;
        try {
            built = buildBanner(cfg, { font: await loadFont(cfg.font.key).catch(() => null), icon: resolveIcon(cfg) });
        } catch (err) { continue; }
        const parts = partsForExport(cfg, built);
        const base = slug(cfg.text.name, `banner-${party.banners.indexOf(cfg) + 1}`);
        const folder = zip.folder(base);
        for (const part of parts) folder.file(`${base}-${part.key}.stl`, toBinarySTL(part.positions, part.key));
        folder.file('README.txt', printNotes(cfg, parts));
    }
    download(await zip.generateAsync({ type: 'blob' }), 'banner-tokens.zip');
}

/** Lay the whole party out in a row so one 3MF drops straight onto the bed. */
async function exportPartyPlate() {
    const all = [];
    let x = 0;
    for (const cfg of party.banners) {
        let built;
        try {
            built = buildBanner(cfg, { font: await loadFont(cfg.font.key).catch(() => null), icon: resolveIcon(cfg) });
        } catch (err) { continue; }
        const parts = partsForExport(cfg, built);
        const span = built.metrics.barWidth;
        x += span / 2;
        for (const p of translateParts(parts, x, 0)) {
            all.push({ ...p, key: `${slug(cfg.text.name)}-${p.key}`, label: `${cfg.text.name} — ${p.label}` });
        }
        x += span / 2 + 6;
    }
    if (!all.length) return;
    const mid = x / 2;
    download(await to3MF(all.map(p => ({ ...p, positions: translateParts([p], -mid, 0)[0].positions })), 'Banner tokens'),
        'banner-tokens-plate.3mf');
}

/* ── files in ── */

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

function init() {
    preview = new Preview(el('view'));
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
            const contours = svgDocumentToContours(data);
            if (!contours.evenodd.length && !contours.nonzero.length) throw new Error('No filled shapes found in that SVG');
            party.banners[party.active] = setPath(current(), 'icon.custom', { key: `${name}:${data.length}`, name, svg: data });
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
            const parsed = JSON.parse(data);
            const banners = Array.isArray(parsed) ? parsed : parsed.banners;
            if (!Array.isArray(banners) || !banners.length) throw new Error('No banners in that file');
            party.banners = banners.map(b => defaultBanner(b));
            party.active = 0;
            refreshControls();
            scheduleRebuild();
            toast(`Imported ${banners.length} banner${banners.length === 1 ? '' : 's'}`);
        } catch (err) {
            toast('That JSON does not look like a saved party.', true);
        }
        e.target.value = '';
    });

    document.querySelectorAll('.card.collapsible h2.toggle').forEach(h => {
        h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
    });

    preview.wantScreen = true;
    rebuild();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
