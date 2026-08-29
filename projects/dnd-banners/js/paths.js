/*
 * paths.js — outline sources. Everything here returns raw contours (Array<{x,y}>)
 * in a Y-up coordinate system, ready to be unioned by clip.js.
 */

import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

const svgLoader = new SVGLoader();

/**
 * Flatten SVG <path> data into contours. SVG is Y-down, so Y is negated on the way out.
 * SVGLoader is used rather than a hand-rolled parser because it already handles relative
 * commands, implicit lineto, smooth curves and elliptical arcs.
 */
export function svgPathsToContours(pathData, { divisions = 16 } = {}) {
    const body = pathData.map(d => `<path d="${String(d).replace(/"/g, '')}" />`).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>`;
    let parsed;
    try {
        parsed = svgLoader.parse(svg);
    } catch (err) {
        return [];
    }
    const contours = [];
    for (const shapePath of parsed.paths) {
        for (const sub of shapePath.subPaths) {
            let pts;
            try { pts = sub.getPoints(divisions); } catch (err) { continue; }
            if (pts && pts.length >= 3) contours.push(pts.map(p => ({ x: p.x, y: -p.y })));
        }
    }
    return contours;
}

/* ── bezier sampling for font outlines ── */

function sampleCubic(out, p0, p1, p2, p3, steps) {
    for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        out.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
    }
}

function sampleQuad(out, p0, p1, p2, steps) {
    for (let i = 1; i <= steps; i++) {
        const t = i / steps, u = 1 - t;
        const a = u * u, b = 2 * u * t, c = t * t;
        out.push({ x: a * p0.x + b * p1.x + c * p2.x, y: a * p0.y + b * p1.y + c * p2.y });
    }
}

function stepsFor(points, unitsPerMm, tolMm = 0.04) {
    let len = 0;
    for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    const lenMm = len / (unitsPerMm || 1);
    return Math.max(2, Math.min(40, Math.ceil(lenMm / tolMm)));
}

/**
 * opentype.js command list -> contours. opentype emits screen coordinates (Y down),
 * so Y is negated here too. `unitsPerMm` only tunes curve sampling density.
 */
export function commandsToContours(commands, unitsPerMm = 100) {
    const contours = [];
    let current = null;
    let cursor = { x: 0, y: 0 };
    const flip = p => ({ x: p.x, y: -p.y });

    for (const cmd of commands) {
        switch (cmd.type) {
            case 'M':
                if (current && current.length >= 3) contours.push(current);
                current = [flip(cmd)];
                cursor = { x: cmd.x, y: cmd.y };
                break;
            case 'L':
                if (!current) break;
                current.push(flip(cmd));
                cursor = { x: cmd.x, y: cmd.y };
                break;
            case 'C': {
                if (!current) break;
                const p0 = cursor, p1 = { x: cmd.x1, y: cmd.y1 }, p2 = { x: cmd.x2, y: cmd.y2 }, p3 = { x: cmd.x, y: cmd.y };
                const raw = [];
                sampleCubic(raw, p0, p1, p2, p3, stepsFor([p0, p1, p2, p3], unitsPerMm));
                for (const p of raw) current.push(flip(p));
                cursor = p3;
                break;
            }
            case 'Q': {
                if (!current) break;
                const p0 = cursor, p1 = { x: cmd.x1, y: cmd.y1 }, p2 = { x: cmd.x, y: cmd.y };
                const raw = [];
                sampleQuad(raw, p0, p1, p2, stepsFor([p0, p1, p2], unitsPerMm));
                for (const p of raw) current.push(flip(p));
                cursor = p2;
                break;
            }
            case 'Z':
                if (current && current.length >= 3) contours.push(current);
                current = null;
                break;
            default:
                break;
        }
    }
    if (current && current.length >= 3) contours.push(current);
    return contours;
}

/**
 * Flatten a whole user-supplied SVG document. SVGLoader resolves transforms and the
 * primitive shapes (rect/circle/polygon/...), so an exported icon from any editor works.
 * Contours are grouped by fill rule because the two cannot be unioned together.
 */
export function svgDocumentToContours(svgText) {
    let parsed;
    try {
        parsed = svgLoader.parse(svgText);
    } catch (err) {
        return { evenodd: [], nonzero: [] };
    }
    const groups = { evenodd: [], nonzero: [] };
    for (const shapePath of parsed.paths) {
        // Stroke-only geometry has no area to extrude, and taking its outline as a filled
        // region would silently contradict what the upload control promises.
        const fill = shapePath.userData?.style?.fill;
        if (fill === 'none' || fill === 'transparent') continue;
        const rule = shapePath.userData?.style?.fillRule === 'nonzero' ? 'nonzero' : 'evenodd';
        for (const sub of shapePath.subPaths) {
            let pts;
            try { pts = sub.getPoints(16); } catch (err) { continue; }
            if (pts && pts.length >= 3) groups[rule].push(pts.map(p => ({ x: p.x, y: -p.y })));
        }
    }
    return groups;
}

export function contoursBounds(contours) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of contours) {
        for (const p of c) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function transformContours(contours, { sx = 1, sy = 1, dx = 0, dy = 0 } = {}) {
    return contours.map(c => c.map(p => ({ x: p.x * sx + dx, y: p.y * sy + dy })));
}
