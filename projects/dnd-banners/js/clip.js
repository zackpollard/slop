/*
 * clip.js — polygon boolean/offset helpers on top of ClipperLib.
 *
 * Everything in this project is ultimately "a set of closed 2D contours extruded in Z".
 * Glyph outlines overlap each other, hand-authored SVG icons self-intersect, and the
 * inlay mode needs plate-minus-detail — so every contour set goes through Clipper before
 * it is handed to the extruder. Clipper works on integers, so coordinates (millimetres)
 * are scaled by SCALE on the way in and back down on the way out.
 */

const C = () => window.ClipperLib;

export const SCALE = 1000; // 1 clipper unit = 1 micron

/** Contour: Array<{x, y}> in mm. Path: Array<{X, Y}> in clipper units. */

export function toClipper(contours) {
    return contours.map(c => c.map(p => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })));
}

export function fromClipper(paths) {
    return paths.map(p => p.map(pt => ({ x: pt.X / SCALE, y: pt.Y / SCALE })));
}

export function signedArea(contour) {
    let a = 0;
    for (let i = 0, n = contour.length; i < n; i++) {
        const p = contour[i], q = contour[(i + 1) % n];
        a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
}

/** Force a contour to the requested winding. CCW = positive signed area. */
export function orient(contour, ccw) {
    return (signedArea(contour) >= 0) === ccw ? contour : contour.slice().reverse();
}

function execute(subject, clip, clipType, subjFill, clipFill) {
    const lib = C();
    const cl = new lib.Clipper();
    if (subject.length) cl.AddPaths(subject, lib.PolyType.ptSubject, true);
    if (clip && clip.length) cl.AddPaths(clip, lib.PolyType.ptClip, true);
    const tree = new lib.PolyTree();
    cl.Execute(clipType, tree, subjFill, clipFill);
    return tree;
}

/**
 * A "region" is the normalised result of a boolean op: an array of
 * { outer: Contour, holes: Contour[] } with outers CCW and holes CW.
 * That is exactly what the extruder and the triangulator want.
 */
function treeToRegions(tree) {
    const regions = [];
    const walk = (node) => {
        for (const child of node.Childs()) {
            if (!child.IsHole()) {
                const outer = orient(fromClipper([child.Contour()])[0], true);
                const holes = [];
                for (const h of child.Childs()) {
                    if (h.IsHole() && h.Contour().length >= 3) {
                        holes.push(orient(fromClipper([h.Contour()])[0], false));
                    }
                }
                if (outer.length >= 3) regions.push({ outer, holes });
            }
            walk(child);
        }
    };
    walk(tree);
    return regions;
}

/**
 * Union a set of raw contours into clean regions.
 * `fillRule` mirrors SVG: 'evenodd' (default for icon art) or 'nonzero'.
 */
export function unionContours(contours, fillRule = 'evenodd') {
    const lib = C();
    const usable = contours.filter(c => c && c.length >= 3);
    if (!usable.length) return [];
    const fill = fillRule === 'nonzero' ? lib.PolyFillType.pftNonZero : lib.PolyFillType.pftEvenOdd;
    // Simplify first: this is what rescues self-intersecting hand-authored paths.
    const simplified = lib.Clipper.SimplifyPolygons(toClipper(usable), fill);
    return treeToRegions(execute(simplified, null, lib.ClipType.ctUnion,
        lib.PolyFillType.pftNonZero, lib.PolyFillType.pftNonZero));
}

/** Flatten regions back to a flat contour list (outers + holes) for further ops. */
export function regionsToContours(regions) {
    const out = [];
    for (const r of regions) { out.push(r.outer); for (const h of r.holes) out.push(h); }
    return out;
}

function booleanOp(aRegions, bRegions, clipType) {
    const lib = C();
    const a = toClipper(regionsToContours(aRegions));
    const b = toClipper(regionsToContours(bRegions));
    if (!a.length) return clipType === lib.ClipType.ctUnion ? bRegions.slice() : [];
    if (!b.length) return clipType === lib.ClipType.ctIntersection ? [] : aRegions.slice();
    return treeToRegions(execute(a, b, clipType,
        lib.PolyFillType.pftNonZero, lib.PolyFillType.pftNonZero));
}

export const union = (a, b) => booleanOp(a, b, C().ClipType.ctUnion);
export const difference = (a, b) => booleanOp(a, b, C().ClipType.ctDifference);
export const intersection = (a, b) => booleanOp(a, b, C().ClipType.ctIntersection);

/**
 * Grow (delta > 0) or shrink (delta < 0) regions by `delta` mm.
 * Used for the outline halo, for print-tolerance tweaks, and for the
 * "will this survive printing?" thin-feature check.
 */
export function offsetRegions(regions, delta, joinType = 'round') {
    if (!regions.length) return [];
    if (Math.abs(delta) < 1e-6) return regions;
    const lib = C();
    const jt = joinType === 'miter' ? lib.JoinType.jtMiter
        : joinType === 'square' ? lib.JoinType.jtSquare
            : lib.JoinType.jtRound;
    const co = new lib.ClipperOffset(2.0, 0.25 * SCALE / 100);
    co.AddPaths(toClipper(regionsToContours(regions)), jt, lib.EndType.etClosedPolygon);
    const tree = new lib.PolyTree();
    co.Execute(tree, delta * SCALE);
    return treeToRegions(tree);
}

/**
 * Drop vertices that sit closer together than `epsMm` and collapse collinear runs.
 *
 * Glyph and icon outlines arrive heavily oversampled — a 4 mm letter can carry 200
 * points — which bloats the exported mesh and gives the triangulator far more work than
 * the shape warrants. Cleaning happens once, before anything is extruded, so the pocket
 * walls, the pocket mouths and the inlay parts all share the exact same vertices.
 */
export function cleanRegions(regions, epsMm = 0.01) {
    if (!regions.length) return regions;
    const lib = C();
    const out = [];
    for (const region of regions) {
        const cleaned = fromClipper(lib.Clipper.CleanPolygons(
            toClipper([region.outer, ...region.holes]), epsMm * SCALE));
        const outer = cleaned[0];
        if (!outer || outer.length < 3) continue;
        out.push({
            outer: orient(outer, true),
            holes: cleaned.slice(1).filter(h => h && h.length >= 3).map(h => orient(h, false)),
        });
    }
    // Dropping vertices can make a tight curve cross itself. Re-resolving the whole set
    // repairs that, and is cheap next to the work it saves downstream.
    return unionContours(regionsToContours(out), 'nonzero');
}

/** Total filled area in mm². Cheap way to detect "this shrank to nothing". */
export function regionsArea(regions) {
    let a = 0;
    for (const r of regions) {
        a += Math.abs(signedArea(r.outer));
        for (const h of r.holes) a -= Math.abs(signedArea(h));
    }
    return a;
}

export function regionsBounds(regions) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of regions) {
        for (const p of r.outer) {
            if (p.x < minX) minX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.x > maxX) maxX = p.x;
            if (p.y > maxY) maxY = p.y;
        }
    }
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function transformRegions(regions, { sx = 1, sy = 1, dx = 0, dy = 0 } = {}) {
    const map = c => c.map(p => ({ x: p.x * sx + dx, y: p.y * sy + dy }));
    // A negative scale flips winding, so re-orient after transforming.
    const flipped = (sx * sy) < 0;
    return regions.map(r => ({
        outer: flipped ? orient(map(r.outer), true) : map(r.outer),
        holes: r.holes.map(h => flipped ? orient(map(h), false) : map(h)),
    }));
}
