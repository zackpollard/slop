/*
 * exporter.js — print orientation, binary STL, and colour-preserving 3MF.
 */

import { mapPositions, boundsOf } from './solid.js';

/**
 * Re-orient parts for the bed.
 *
 * Inlay and engraved detail is cut into the front face, so the banner prints FACE DOWN:
 * the textured build plate becomes the visible surface and a filament change at the
 * detail depth gives two colours. That is rotated 180 degrees about X, which also swings
 * the hanger bar up into the air where it belongs.
 *
 * Raised detail has to print face up instead, and the separate bracket prints on its
 * glue flange with the bar standing up.
 */
export function orientForPrint(parts, cfg) {
    const faceDown = cfg.detail.style !== 'raised';
    const t = cfg.size.plateThickness;

    const banner = [];
    const loose = [];
    for (const part of parts) {
        if (part.key === 'hanger') {
            loose.push({ ...part, positions: mapPositions(part.positions, (x, y, z) => [x, y, -(z + t)], true) });
        } else if (faceDown) {
            banner.push({ ...part, positions: mapPositions(part.positions, (x, y, z) => [x, -y, -z]) });
        } else {
            banner.push({ ...part, positions: part.positions.slice() });
        }
    }

    // The banner parts must keep their alignment, so they share one translation. The
    // glue-on bracket is a different print orientation entirely, so it is normalised on
    // its own and then parked beside the banner — otherwise a 3MF drops it inside the
    // banner, where no slicer can separate them.
    normaliseGroup(banner);
    const bannerBox = groupBounds(banner);
    let cursor = bannerBox ? bannerBox.maxX + 6 : 0;
    for (const part of loose) {
        normaliseGroup([part]);
        const box = boundsOf(part.positions);
        if (!box) continue;
        const dx = cursor + box.x / 2;
        part.positions = mapPositions(part.positions, (x, y, z) => [x + dx, y, z]);
        cursor += box.x + 6;
    }
    return [...banner, ...loose];
}

function groupBounds(parts) {
    let box = null;
    for (const p of parts) {
        const b = boundsOf(p.positions);
        if (!b) continue;
        box = box ? {
            minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), minZ: Math.min(box.minZ, b.minZ),
            maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY), maxZ: Math.max(box.maxZ, b.maxZ),
        } : b;
    }
    return box;
}

function normaliseGroup(parts) {
    const box = groupBounds(parts);
    if (!box) return;
    const dx = -(box.minX + box.maxX) / 2, dy = -(box.minY + box.maxY) / 2, dz = -box.minZ;
    for (const p of parts) p.positions = mapPositions(p.positions, (x, y, z) => [x + dx, y + dy, z + dz]);
}

/** Shift a whole banner's parts, for laying several out on one plate. */
export function translateParts(parts, dx, dy) {
    return parts.map(p => ({ ...p, positions: mapPositions(p.positions, (x, y, z) => [x + dx, y + dy, z]) }));
}

/* ── binary STL ── */

function triangleNormal(p, i) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz);
    return len < 1e-12 ? null : [nx / len, ny / len, nz / len];
}

export function toBinarySTL(positions, name = 'banner') {
    const keep = [];
    for (let i = 0; i < positions.length; i += 9) {
        if (triangleNormal(positions, i)) keep.push(i);
    }
    const buf = new ArrayBuffer(84 + keep.length * 50);
    const dv = new DataView(buf);
    const header = `slop dnd-banners :: ${name}`.slice(0, 79);
    for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
    dv.setUint32(80, keep.length, true);
    let o = 84;
    for (const i of keep) {
        const n = triangleNormal(positions, i);
        dv.setFloat32(o, n[0], true); dv.setFloat32(o + 4, n[1], true); dv.setFloat32(o + 8, n[2], true);
        o += 12;
        for (let k = 0; k < 9; k++) { dv.setFloat32(o, positions[i + k], true); o += 4; }
        dv.setUint16(o, 0, true); o += 2;
    }
    return buf;
}

/* ── 3MF (keeps the colours and keeps every part in one aligned file) ── */

function meshXml(positions) {
    const index = new Map();
    const verts = [];
    const tris = [];
    const key = (x, y, z) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    for (let i = 0; i < positions.length; i += 9) {
        if (!triangleNormal(positions, i)) continue;
        const ids = [];
        for (let k = 0; k < 9; k += 3) {
            const x = positions[i + k], y = positions[i + k + 1], z = positions[i + k + 2];
            const kk = key(x, y, z);
            let id = index.get(kk);
            if (id === undefined) {
                id = verts.length;
                index.set(kk, id);
                verts.push(`<vertex x="${+x.toFixed(4)}" y="${+y.toFixed(4)}" z="${+z.toFixed(4)}"/>`);
            }
            ids.push(id);
        }
        if (ids[0] !== ids[1] && ids[1] !== ids[2] && ids[0] !== ids[2]) {
            tris.push(`<triangle v1="${ids[0]}" v2="${ids[1]}" v3="${ids[2]}"/>`);
        }
    }
    return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`;
}

const xmlEscape = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const hex8 = c => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
    return '#' + (m ? m[1].toUpperCase() : 'CCCCCC') + 'FF';
};

export function to3MF(parts, modelName = 'banner') {
    const materials = parts.map(p => `<base name="${xmlEscape(p.label || p.key)}" displaycolor="${hex8(p.color)}"/>`).join('');
    const objects = parts.map((p, i) =>
        `<object id="${i + 2}" name="${xmlEscape(p.label || p.key)}" type="model" pid="1" pindex="${i}">${meshXml(p.positions)}</object>`).join('');
    const items = parts.map((p, i) => `<item objectid="${i + 2}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`).join('');
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Title">${xmlEscape(modelName)}</metadata>
<metadata name="Application">slop dnd-banners</metadata>
<resources><basematerials id="1">${materials}</basematerials>${objects}</resources>
<build>${items}</build>
</model>`;

    const zip = new window.JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`);
    zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`);
    zip.folder('3D').file('3dmodel.model', model);
    return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}

/* ── download plumbing ── */

export function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function slug(text, fallback = 'banner') {
    const s = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return s || fallback;
}
