/*
 * banner.js — turns a banner config into printable parts.
 *
 * Coordinate frame (millimetres):
 *   x = 0 is the banner centre line
 *   y = 0 is the banner's top edge, going negative downwards
 *   z = 0 is the FRONT face; the plate occupies z = [-thickness, 0] and the hanger
 *         reaches further back into negative z.
 * Raised detail sticks out into +z; inlaid/engraved detail cuts into -z.
 */

import * as clip from './clip.js';
import { extrudeRegions, triangulateCap, invertWinding, mapPositions, appendPositions } from './solid.js';
import { bannerOutline, roundedRect, stadium } from './shapes.js';
import { svgPathsToContours, transformContours } from './paths.js';
import { layoutLine } from './fonts.js';

const EDGE_MARGIN = 0.9;   // mm of plate that detail may never encroach on
// Outline simplification tolerance. Scaled to the smallest lettering on the banner:
// collapsing 12 micron steps is free on a 5 mm capital but can fold a 1.5 mm one through
// itself, so small type gets a proportionally finer tolerance.
const cleanEpsFor = cfg => Math.max(0.002, Math.min(0.012,
    cfg.size.height * Math.min(cfg.layout.nameSize, cfg.layout.subSize) * 0.0025));

/* ── icon outlines ── */

/**
 * Fill each <path> independently, then union the results — the way a browser paints them.
 *
 * Evaluating every subpath from every path together under one even-odd rule instead turns
 * any overlap BETWEEN two paths into a hole. An icon drawn as overlapping pieces then
 * prints with gaps that were never in the artwork, and nothing on screen shows it, because
 * the SVG preview in the picker paints the paths separately and gets the union.
 */
export function iconRegions(icon) {
    if (!icon || !icon.paths || !icon.paths.length) return [];
    const rule = icon.fillRule || 'evenodd';
    let acc = [];
    for (const d of icon.paths) {
        const contours = svgPathsToContours([d]);
        if (!contours.length) continue;
        const regions = clip.unionContours(contours, rule);
        if (regions.length) acc = acc.length ? clip.union(acc, regions) : regions;
    }
    return acc;
}

/** Scale/translate regions so they fit a box, preserving aspect ratio. */
function fitRegions(regions, { cx, cy, maxWidth, maxHeight, flipX = false }) {
    const b = clip.regionsBounds(regions);
    if (!b || b.width <= 0 || b.height <= 0) return [];
    const s = Math.min(maxWidth / b.width, maxHeight / b.height);
    const sx = flipX ? -s : s;
    const midX = (b.minX + b.maxX) / 2, midY = (b.minY + b.maxY) / 2;
    return clip.transformRegions(regions, { sx, sy: s, dx: cx - midX * sx, dy: cy - midY * s });
}

/* ── hanger ── */

function hangerBarPlan(cfg, backZ, frontZ) {
    const { width } = cfg.size;
    const h = cfg.hanger;
    const barW = width + 2 * Math.max(0, h.overhang);
    const plan = h.roundEnds
        ? stadium(-barW / 2, barW / 2, backZ, frontZ)
        : roundedRect(-barW / 2, barW / 2, backZ, frontZ, Math.min(1.2, (frontZ - backZ) / 2));
    return [{ outer: plan, holes: [] }];
}

/** Map a shape drawn in the x/z plane (extruded along y) into model space. */
const armFrame = yTop => (u, v, w) => [u, yTop - w, v];

function buildAttachedHanger(cfg) {
    const h = cfg.hanger;
    const t = cfg.size.plateThickness;
    const backZ = -(t + h.screenThickness + h.clearance);
    const plan = hangerBarPlan(cfg, backZ, 0);
    let pos = extrudeRegions(plan, { z0: 0, z1: h.thickness });
    pos = mapPositions(pos, armFrame(0));

    appendPositions(pos, buildHangerLip(cfg, backZ));
    return pos;
}

/**
 * The tab at the far edge of the bar that drops down behind the screen.
 *
 * Drawn as a side profile in the y/z plane and extruded along x. Its underside is
 * chamfered at 45 degrees so it prints without support, and the chamfer is clamped to the
 * drop: a tab shallower than its own thickness becomes a triangular ridge rather than a
 * profile folded through itself. Clipper resolves the result either way, so the wedge and
 * trapezoid cases both come out as clean rings.
 */
function buildHangerLip(cfg, backZ) {
    const h = cfg.hanger;
    if (!(h.lip > 0)) return [];
    const drop = h.lip;
    const lipT = Math.min(2.0, h.thickness, drop);
    const barW = cfg.size.width + 2 * Math.max(0, h.overhang);
    const profile = [
        { x: -h.thickness, y: backZ },
        { x: -h.thickness, y: backZ + lipT },
        { x: -h.thickness - drop + lipT, y: backZ + lipT },
        { x: -h.thickness - drop, y: backZ },
    ];
    const regions = clip.unionContours([profile], 'nonzero');
    if (!regions.length) return [];
    const lip = extrudeRegions(regions, { z0: -barW / 2, z1: barW / 2 });
    return mapPositions(lip, (u, v, w) => [w, u, v]);
}

function buildSeparateHanger(cfg) {
    const h = cfg.hanger;
    const t = cfg.size.plateThickness;
    const ft = h.flangeThickness;
    const fh = h.flangeHeight;
    const fw = Math.max(6, cfg.size.width - 3);
    const backZ = -(t + ft + h.screenThickness + h.clearance);

    // Glue flange, flat against the back of the banner.
    const flange = [{ outer: roundedRect(-fw / 2, fw / 2, -fh, 0, Math.min(2.5, fh / 3)), holes: [] }];
    let pos = extrudeRegions(flange, { z0: -t - ft, z1: -t, chamferBottom: 0.3 });

    // Bar, reaching back over the screen from the flange's outer face.
    const plan = hangerBarPlan(cfg, backZ, -t);
    const bar = extrudeRegions(plan, { z0: 0, z1: h.thickness });
    appendPositions(pos, mapPositions(bar, armFrame(0)));
    appendPositions(pos, buildHangerLip(cfg, backZ));
    return pos;
}

/* ── text block ── */

function buildTextLines(cfg, font, contentW) {
    const { height } = cfg.size;
    const L = cfg.layout;
    const lines = [];

    const push = (text, capHeight, textCase, part, role) => {
        if (!String(text ?? '').trim()) return;
        const laid = layoutLine(font, text, {
            capHeightMm: capHeight,
            letterSpacingEm: cfg.font.letterSpacing,
            textCase,
            smallCapRatio: cfg.font.smallCapRatio,
            maxWidthMm: contentW,
        });
        if (laid) lines.push({ ...laid, part, role, source: String(text).trim() });
    };

    push(cfg.text.name, height * L.nameSize, cfg.font.nameCase, cfg.parts.name, 'name');
    for (const sub of cfg.text.lines || []) {
        push(sub, height * L.subSize, cfg.font.subCase, cfg.parts.sub, 'sub');
    }
    return lines;
}

/* ── assembly ── */

export function buildBanner(cfg, { font, icon }) {
    const warnings = [];
    const { width, height, plateThickness: t } = cfg.size;
    const L = cfg.layout;
    const notchY = -(height - (cfg.size.tailStyle === 'none' ? 0 : cfg.size.tailDepth));
    // The artwork is hard-clipped to the plate eroded by EDGE_MARGIN later on, so fitting
    // text to a wider column than that would silently shave the ends off long lines.
    const contentW = Math.max(2, Math.min(width * (1 - 2 * L.sideMargin), width - 2 * EDGE_MARGIN - 0.2));

    /* plate outline, with convex corners rounded by an open (erode then dilate) */
    let plate = clip.unionContours([bannerOutline({
        width, height,
        tailDepth: cfg.size.tailDepth,
        tailStyle: cfg.size.tailStyle,
    })], 'nonzero');
    if (cfg.size.cornerRadius > 0.05) {
        const r = Math.min(cfg.size.cornerRadius, width / 6);
        const eroded = clip.offsetRegions(plate, -r);
        if (clip.regionsArea(eroded) > 0) plate = clip.offsetRegions(eroded, r);
    }
    let plateInner = clip.offsetRegions(plate, -EDGE_MARGIN);
    if (!plateInner.length) {
        plateInner = plate;
        warnings.push('This banner is too small to keep a margin around the artwork — detail may run to the edge.');
    }

    /* icon */
    const elements = [];
    let iconBottom = -height * L.iconTop;
    if (icon && icon.regions && icon.regions.length && cfg.icon.show !== false) {
        const boxTop = -height * L.iconTop;
        const boxH = height * L.iconHeight;
        const placed = fitRegions(icon.regions, {
            cx: width * (cfg.layout.iconOffsetX || 0),
            cy: boxTop - boxH / 2,
            maxWidth: contentW * (cfg.layout.iconWidthScale ?? 1),
            maxHeight: boxH,
            flipX: cfg.icon.flipX,
        });
        if (placed.length) {
            elements.push({ regions: placed, part: cfg.parts.icon, kind: 'icon' });
            const b = clip.regionsBounds(placed);
            iconBottom = b.minY;
        }
    }

    /* text block, centred in whatever room is left between the icon and the notch */
    const lines = font ? buildTextLines(cfg, font, contentW) : [];
    if (lines.length) {
        const gapAfterName = height * L.nameGap;
        const gapBetweenSubs = height * L.lineGap;
        let blockH = 0;
        lines.forEach((ln, i) => {
            blockH += ln.height;
            if (i < lines.length - 1) blockH += (lines[i].role === 'name' ? gapAfterName : gapBetweenSubs);
        });

        const spaceTop = iconBottom - height * L.iconGap;
        const spaceBottom = notchY + height * L.bottomPad;
        const space = spaceTop - spaceBottom;
        let blockScale = 1;
        if (space <= 0) {
            warnings.push('There is no room left for text between the icon and the tail. Shrink the icon, raise the banner height, or reduce the gaps.');
        } else if (blockH > space) {
            blockScale = space / blockH;
            warnings.push('Text was scaled down to fit — shorten a line, raise the banner height, or shrink the icon.');
        }
        const scaledH = blockH * blockScale;
        let cursorTop = L.textAnchor === 'top'
            ? spaceTop
            : spaceTop - (space - scaledH) / 2;

        lines.forEach((ln, i) => {
            const h = ln.height * blockScale;
            const baselineY = cursorTop - h - ln.bottom * blockScale;
            const regions = clip.unionContours(
                transformContours(ln.contours, {
                    sx: blockScale, sy: blockScale,
                    dx: -(ln.width * blockScale) / 2, dy: baselineY,
                }), 'nonzero');
            if (regions.length) elements.push({ regions, part: ln.part, kind: 'text', role: ln.role });
            cursorTop -= h + (ln.role === 'name' ? gapAfterName : gapBetweenSubs) * blockScale;
            // Shrink-to-fit is the normal way a long line lands on a narrow banner; only
            // say something once it is small enough to look out of place.
            if (ln.fit < 0.88) {
                warnings.push(`"${ln.source}" was shrunk to ${Math.round(ln.fit * 100)}% to fit the banner width.`);
            }
        });
    }

    /* group into colour parts, then resolve overlaps and the outline halo */
    const collect = key => {
        let acc = [];
        for (const el of elements) if (el.part === key) acc = acc.length ? clip.union(acc, el.regions) : el.regions;
        return acc;
    };
    let partA = collect('a');
    let partB = collect('b');

    if (cfg.detail.outline.enabled && cfg.detail.outline.width > 0.01) {
        const around = cfg.detail.outline.around === 'b' ? partB : partA;
        if (around.length) {
            const grown = clip.offsetRegions(around, cfg.detail.outline.width, 'round');
            const halo = clip.difference(grown, around);
            if (cfg.detail.outline.into === 'b') partB = partB.length ? clip.union(partB, halo) : halo;
            else partA = partA.length ? clip.union(partA, halo) : halo;
        }
    }

    // Part B wins where they overlap, then everything is trimmed to the plate.
    if (partA.length && partB.length) partA = clip.difference(partA, partB);
    if (partA.length) partA = clip.intersection(partA, plateInner);
    if (partB.length) partB = clip.intersection(partB, plateInner);

    // Simplify once, here, so every consumer below shares identical vertices.
    const cleanEps = cleanEpsFor(cfg);
    partA = clip.cleanRegions(partA, cleanEps);
    partB = clip.cleanRegions(partB, cleanEps);
    const detailAll = partA.length && partB.length ? clip.union(partA, partB) : (partA.length ? partA : partB);

    /* geometry */
    const style = cfg.detail.style;
    // A pocket has to leave a floor behind it; a raised relief is free to be any height.
    const depth = style === 'raised' ? cfg.detail.depth : Math.min(cfg.detail.depth, t - 0.4);
    if (depth < cfg.detail.depth - 1e-6) {
        warnings.push(`Detail depth was capped at ${depth.toFixed(2)} mm so the plate keeps a 0.4 mm floor behind the pockets. Thicken the plate for a deeper inlay.`);
    }
    const parts = [];

    let platePos;
    if (style === 'raised' || !detailAll.length) {
        platePos = extrudeRegions(plate, { z0: -t, z1: 0, chamferTop: cfg.detail.plateChamfer, chamferBottom: cfg.detail.plateChamfer });
    } else {
        // Growing by the part clearance can push a pocket past the plate edge, and
        // buildPlateWithPockets assumes every pocket is strictly interior.
        let pocket = detailAll;
        if (cfg.detail.gap > 0) {
            pocket = clip.offsetRegions(detailAll, cfg.detail.gap);
            const keepInside = clip.offsetRegions(plate, -0.3);
            if (keepInside.length) pocket = clip.intersection(pocket, keepInside);
        }
        platePos = buildPlateWithPockets(plate, pocket, t, depth, cfg.detail.plateChamfer);
    }

    if (cfg.hanger.mode === 'attached') appendPositions(platePos, buildAttachedHanger(cfg));
    parts.push({ key: 'plate', label: 'Banner plate', color: cfg.colors.plate, positions: platePos });

    if (style !== 'engraved') {
        const z0 = style === 'raised' ? 0 : -depth;
        const z1 = style === 'raised' ? depth : 0;
        const chamfer = style === 'raised' ? cfg.detail.chamfer : 0;
        if (partA.length) {
            parts.push({
                key: 'detail-a', label: 'Detail (colour 1)', color: cfg.colors.a,
                positions: extrudeRegions(partA, { z0, z1, chamferTop: chamfer }),
            });
        }
        if (partB.length) {
            parts.push({
                key: 'detail-b', label: 'Detail (colour 2)', color: cfg.colors.b,
                positions: extrudeRegions(partB, { z0, z1, chamferTop: chamfer }),
            });
        }
    }

    if (cfg.hanger.mode === 'separate') {
        parts.push({ key: 'hanger', label: 'Hanger bracket (glue on)', color: cfg.colors.plate, positions: buildSeparateHanger(cfg) });
    }

    /* printability */
    if (detailAll.length) {
        const thin = thinFeatureRatio(detailAll, cfg.print.minFeature);
        if (thin > 0.3) {
            warnings.push(`${Math.round(thin * 100)}% of the artwork is finer than ${cfg.print.minFeature} mm, which is around one extrusion width. It will probably still print, but expect those strokes to come out soft — a heavier font, shorter lines or a wider banner would sharpen them.`);
        }
    }
    if (style === 'raised' && cfg.hanger.mode === 'attached') {
        warnings.push('Raised detail prints face-up, but an attached hanger points backwards — it will need supports. Switch the hanger to "separate bracket", or use inlay detail.');
    }
    if (cfg.hanger.mode !== 'none' && cfg.hanger.thickness < 1.6) {
        warnings.push('A hanger bar under 1.6 mm thick is fragile.');
    }

    return {
        parts: parts.filter(p => p.positions.length),
        warnings: [...new Set(warnings)],
        regions: { plate, partA, partB, detailAll },
        metrics: {
            width, height,
            barWidth: cfg.hanger.mode === 'none' ? width : width + 2 * cfg.hanger.overhang,
            depth: cfg.hanger.mode === 'none' ? t : t + cfg.hanger.screenThickness + cfg.hanger.clearance,
        },
    };
}

/**
 * A plate with blind pockets sunk into its front face, built as one watertight solid
 * rather than two stacked prisms so slicers never see ambiguous overlapping shells.
 */
function buildPlateWithPockets(plate, pockets, thickness, depth, chamfer) {
    // The front face and the pocket walls are both derived from the SAME boolean result.
    // Deriving them separately is what cracks the mesh: two pockets that touch get merged
    // into one mouth by the difference but stay two rings in the pocket set, so the face
    // and the walls disagree about where the boundary runs.
    const front = clip.difference(plate, pockets);
    const pos = extrudeRegions(plate, { z0: -thickness, z1: 0, chamferBottom: chamfer, caps: { top: false } });
    appendPositions(pos, triangulateCap(front, 0, false));
    const cavities = cavitiesFromFront(front);
    if (cavities.length) {
        // An inverted prism gives inward-facing walls and a floor that looks up.
        appendPositions(pos, invertWinding(extrudeRegions(cavities, { z0: -depth, z1: 0, caps: { top: false } })));
    }
    return pos;
}

/**
 * Read the pockets back out of the holed front face.
 *
 * Every hole of a front-face region is a pocket mouth, at any nesting depth. Every front
 * region that sits inside one of those mouths is an island of plate left standing in the
 * pocket — the counter of an "O" — and becomes a hole of that cavity.
 */
function cavitiesFromFront(front) {
    const cavities = [];
    for (const region of front) {
        for (const hole of region.holes) {
            const outer = clip.orient(hole, true);
            cavities.push({ outer, holes: [], area: Math.abs(clip.signedArea(outer)) });
        }
    }
    if (!cavities.length) return [];
    for (const region of front) {
        const probe = interiorPoint(region.outer);
        let host = null;
        for (const cavity of cavities) {
            if (pointInRing(probe, cavity.outer) && (!host || cavity.area < host.area)) host = cavity;
        }
        if (host) host.holes.push(clip.orient(region.outer, false));
    }
    return cavities.map(({ outer, holes }) => ({ outer, holes }));
}

/**
 * A point strictly inside a simple ring.
 *
 * Ring vertices themselves are useless for containment tests: where two shapes touch, a
 * vertex of one lies exactly on the boundary of the other and ray casting there is a coin
 * flip. The lowest-then-leftmost vertex of a CCW ring is always convex, so stepping a
 * hair along its bisector lands inside no matter how the shape is arranged.
 */
function interiorPoint(ring) {
    const n = ring.length;
    let k = 0;
    for (let i = 1; i < n; i++) {
        if (ring[i].y < ring[k].y || (ring[i].y === ring[k].y && ring[i].x < ring[k].x)) k = i;
    }
    const c = ring[k], p = ring[(k - 1 + n) % n], q = ring[(k + 1) % n];
    const norm = (a, b) => {
        const dx = a.x - b.x, dy = a.y - b.y, len = Math.hypot(dx, dy) || 1;
        return { x: dx / len, y: dy / len, len };
    };
    const u = norm(p, c), v = norm(q, c);
    const bx = u.x + v.x, by = u.y + v.y;
    const blen = Math.hypot(bx, by);
    if (blen < 1e-9) return c; // degenerate spike; nothing better to offer
    const step = Math.min(u.len, v.len) * 1e-3;
    return { x: c.x + (bx / blen) * step, y: c.y + (by / blen) * step };
}

function pointInRing(pt, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > pt.y) !== (b.y > pt.y) &&
            pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

/** Fraction of the filled area that survives neither erosion nor re-dilation by w/2. */
function thinFeatureRatio(regions, w) {
    const total = clip.regionsArea(regions);
    if (total <= 0) return 0;
    const opened = clip.offsetRegions(clip.offsetRegions(regions, -w / 2), w / 2);
    return Math.max(0, (total - clip.regionsArea(opened)) / total);
}
