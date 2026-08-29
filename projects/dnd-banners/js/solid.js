/*
 * solid.js — turns 2D regions into watertight triangle soup.
 *
 * Every part of a banner (plate, hanger arm, relief detail) is an extrusion of a set of
 * regions along Z, optionally chamfered at either end. Chamfers use a per-vertex miter
 * offset rather than a Clipper offset so that ring topology and vertex correspondence are
 * preserved — a Clipper offset can split or delete a ring, which leaves the side walls
 * with nothing to stitch to.
 */

import { ShapeUtils, Vector2 } from 'three';
import { unionContours, regionsArea } from './clip.js';

const EPS = 1e-7;

function ringArea(ring) {
    let a = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
}

function ringPerimeter(ring) {
    let len = 0;
    for (let i = 0, n = ring.length; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        len += Math.hypot(q.x - p.x, q.y - p.y);
    }
    return len;
}

/**
 * Inset a whole region, refusing to do so when the shape is too slender to survive it.
 * A 0.2 mm chamfer on a 0.4 mm letter stroke would fold the ring through itself and
 * produce duplicated edges, so the chamfer is first clamped to a fraction of the
 * region's inradius (2*area/perimeter) and then rejected outright if any ring flips
 * orientation or all but vanishes. Callers fall back to a square edge.
 */
function safeInset(rings, d) {
    let area = 0, perimeter = 0;
    rings.forEach((r, i) => {
        area += (i === 0 ? 1 : -1) * Math.abs(ringArea(r));
        perimeter += ringPerimeter(r);
    });
    if (area <= 0 || perimeter <= 0) return null;
    const limit = 0.35 * (2 * area / perimeter);
    const inset = Math.min(d, limit);
    if (inset <= 1e-4) return null;

    const out = [];
    for (const ring of rings) {
        const before = ringArea(ring);
        const moved = insetRing(ring, inset);
        const after = ringArea(moved);
        if (Math.sign(after) !== Math.sign(before) || Math.abs(after) < Math.abs(before) * 0.15) return null;
        out.push(moved);
    }

    // A miter offset can still fold a ring through itself where the shape is locally much
    // thinner than the global inradius suggests — a letter stem, say. Clipper resolves any
    // self-intersection, so if its idea of the area disagrees with the raw shoelace sum, or
    // the ring count changes, the chamfer is not safe here and the caller squares the edge.
    const resolved = unionContours(out, 'nonzero');
    const shoelace = out.reduce((sum, r) => sum + ringArea(r), 0);
    if (resolved.length !== 1 || resolved[0].holes.length !== out.length - 1) return null;
    if (Math.abs(regionsArea(resolved) - shoelace) > Math.abs(shoelace) * 0.02) return null;
    return out;
}

function dedupe(ring) {
    const out = [];
    for (const p of ring) {
        const last = out[out.length - 1];
        if (!last || Math.abs(last.x - p.x) > EPS || Math.abs(last.y - p.y) > EPS) out.push({ x: p.x, y: p.y });
    }
    while (out.length > 1) {
        const a = out[0], b = out[out.length - 1];
        if (Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS) out.pop(); else break;
    }
    return out;
}

/**
 * Move every vertex of a ring `d` mm into the material.
 *
 * Rings arrive with a consistent winding (outer CCW, holes CW), which means the material
 * is always to the LEFT of the direction of travel, so the inward normal of edge p->q is
 * (-dy, dx). Each vertex moves along the bisector of its two edge normals, scaled by
 * 1/cos(half-angle) so that flat faces stay flat. Very sharp spikes would send that scale
 * to infinity, so it is clamped.
 */
function insetRing(ring, d) {
    const n = ring.length;
    if (n < 3 || d <= 0) return ring;
    const normals = [];
    for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const dx = q.x - p.x, dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        normals.push({ x: -dy / len, y: dx / len });
    }
    const out = [];
    for (let i = 0; i < n; i++) {
        const n1 = normals[(i - 1 + n) % n]; // normal of the edge arriving at i
        const n2 = normals[i];               // normal of the edge leaving i
        let mx = n1.x + n2.x, my = n1.y + n2.y;
        const mlen = Math.hypot(mx, my);
        if (mlen < 1e-6) { // 180 degree spike — fall back to one edge normal
            out.push({ x: ring[i].x + n2.x * d, y: ring[i].y + n2.y * d });
            continue;
        }
        mx /= mlen; my /= mlen;
        const cos = mx * n1.x + my * n1.y;
        const scale = Math.min(1 / Math.max(cos, 1e-3), 4);
        out.push({ x: ring[i].x + mx * d * scale, y: ring[i].y + my * d * scale });
    }
    return out;
}

function pushTri(pos, a, b, c) {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
}

function addWalls(pos, lower, upper) {
    for (let r = 0; r < lower.rings.length; r++) {
        const A = lower.rings[r], B = upper.rings[r];
        const n = A.length;
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const a0 = [A[i].x, A[i].y, lower.z], a1 = [A[j].x, A[j].y, lower.z];
            const b0 = [B[i].x, B[i].y, upper.z], b1 = [B[j].x, B[j].y, upper.z];
            pushTri(pos, a0, a1, b1);
            pushTri(pos, a0, b1, b0);
        }
    }
}

/**
 * Triangulate one polygon-with-holes into triangles of {x,y} points.
 *
 * poly2tri is preferred because it produces a true constrained Delaunay triangulation:
 * every interior edge is shared by exactly two triangles and every boundary edge belongs
 * to exactly one. Ear clipping bridges each hole to the outer ring instead, and with the
 * many collinear holes a line of lettering produces, those bridges can overlap and leave
 * the extruded solid with cracked edges. Ear clipping stays as a fallback for the rare
 * input poly2tri rejects.
 */
function triangulatePolygon(outer, holes) {
    const P2T = typeof window !== 'undefined' && window.poly2tri;
    if (P2T) {
        // Straight through first; on the rare rejection, retry with a sub-micron jitter.
        // poly2tri refuses exactly-collinear constraint points, which lines of lettering
        // sitting on a shared baseline produce readily. The jitter only perturbs what the
        // sweep sees — the triangles come back carrying their original coordinates — so
        // the emitted vertices still match the extruded walls exactly.
        for (const spread of [0, 2e-4]) {
            try {
                const prep = ring => ring.map((p, i) => {
                    const a = i * 2.399963229728653; // golden angle: deterministic, well spread
                    const pt = spread
                        ? new P2T.Point(p.x + Math.cos(a) * spread, p.y + Math.sin(a) * spread)
                        : new P2T.Point(p.x, p.y);
                    pt._x0 = p.x; pt._y0 = p.y;
                    return pt;
                });
                const ctx = new P2T.SweepContext(prep(outer));
                for (const hole of holes) ctx.addHole(prep(hole));
                ctx.triangulate();
                return ctx.getTriangles().map(t => t.getPoints().map(
                    pt => (pt._x0 === undefined ? { x: pt.x, y: pt.y } : { x: pt._x0, y: pt._y0 })));
            } catch (err) {
                if (spread) console.warn('poly2tri rejected a face: ' + (err && err.message) + ' — falling back to ear clipping');
            }
        }
    }
    const o = outer.map(p => new Vector2(p.x, p.y));
    const h = holes.map(r => r.map(p => new Vector2(p.x, p.y)));
    let faces;
    try {
        faces = ShapeUtils.triangulateShape(o, h);
    } catch (err) {
        console.warn('cap triangulation failed', err);
        return [];
    }
    const verts = o.concat(...h);
    return faces.map(f => [verts[f[0]], verts[f[1]], verts[f[2]]]).filter(t => t[0] && t[1] && t[2]);
}

function addCap(pos, level, facingDown) {
    const rings = level.rings;
    if (!rings.length) return;
    for (const [a, b, c] of triangulatePolygon(rings[0], rings.slice(1))) {
        const cross = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
        if (Math.abs(cross) < 1e-9) continue; // zero-area sliver, nothing to render or print
        // Triangulators do not all agree on output winding, so orient each triangle here.
        const ccw = cross > 0;
        const pa = [a.x, a.y, level.z], pb = [b.x, b.y, level.z], pc = [c.x, c.y, level.z];
        if (ccw !== facingDown) pushTri(pos, pa, pb, pc); else pushTri(pos, pa, pc, pb);
    }
}

/** Triangulate regions as a single flat face at height `z`. */
export function triangulateCap(regions, z, facingDown = false) {
    const pos = [];
    for (const region of regions) {
        const rings = [region.outer, ...region.holes].map(dedupe).filter(r => r.length >= 3);
        if (rings.length) addCap(pos, { z, rings }, facingDown);
    }
    return pos;
}

/** Flip every triangle's winding — used to turn a solid into a cavity. */
export function invertWinding(pos) {
    const out = pos.slice();
    for (let t = 0; t < out.length; t += 9) {
        for (let k = 0; k < 3; k++) {
            const tmp = out[t + 3 + k]; out[t + 3 + k] = out[t + 6 + k]; out[t + 6 + k] = tmp;
        }
    }
    return out;
}

/**
 * Extrude regions from z0 to z1.
 * `chamferTop` / `chamferBottom` are inset distances in mm (0 disables).
 * `caps` can omit either end, for callers that supply their own face.
 * Returns a plain array of triangle vertex coordinates.
 */
export function extrudeRegions(regions, { z0, z1, chamferTop = 0, chamferBottom = 0, caps = {} } = {}) {
    const wantBottom = caps.bottom !== false;
    const wantTop = caps.top !== false;
    const pos = [];
    if (z1 <= z0) return pos;
    const maxChamfer = (z1 - z0) * 0.49;
    const cTop = Math.max(0, Math.min(chamferTop, maxChamfer));
    const cBot = Math.max(0, Math.min(chamferBottom, maxChamfer));

    for (const region of regions) {
        const rings = [region.outer, ...region.holes].map(dedupe).filter(r => r.length >= 3);
        if (!rings.length) continue;

        const bottomInset = cBot > 0 ? safeInset(rings, cBot) : null;
        const topInset = cTop > 0 ? safeInset(rings, cTop) : null;

        const levels = [];
        if (bottomInset) {
            levels.push({ z: z0, rings: bottomInset });
            levels.push({ z: z0 + cBot, rings });
        } else {
            levels.push({ z: z0, rings });
        }
        if (topInset) {
            levels.push({ z: z1 - cTop, rings });
            levels.push({ z: z1, rings: topInset });
        } else {
            levels.push({ z: z1, rings });
        }

        for (let i = 0; i + 1 < levels.length; i++) addWalls(pos, levels[i], levels[i + 1]);
        if (wantBottom) addCap(pos, levels[0], true);
        if (wantTop) addCap(pos, levels[levels.length - 1], false);
    }
    return pos;
}

/**
 * Remap a triangle soup into another frame. `fn(x, y, z)` returns [x, y, z].
 * Set `flipWinding` when the mapping is left-handed (mirrors), so faces keep facing out.
 */
export function mapPositions(pos, fn, flipWinding = false) {
    const out = new Array(pos.length);
    for (let i = 0; i < pos.length; i += 3) {
        const [x, y, z] = fn(pos[i], pos[i + 1], pos[i + 2]);
        out[i] = x; out[i + 1] = y; out[i + 2] = z;
    }
    if (flipWinding) {
        for (let t = 0; t < out.length; t += 9) {
            for (let k = 0; k < 3; k++) {
                const tmp = out[t + 3 + k]; out[t + 3 + k] = out[t + 6 + k]; out[t + 6 + k] = tmp;
            }
        }
    }
    return out;
}

/** Append one triangle soup onto another without blowing the argument limit. */
export function appendPositions(dst, src) {
    for (let i = 0; i < src.length; i++) dst.push(src[i]);
    return dst;
}

export function boundsOf(pos) {
    if (!pos.length) return null;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    return { minX, minY, minZ, maxX, maxY, maxZ, x: maxX - minX, y: maxY - minY, z: maxZ - minZ };
}
