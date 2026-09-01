/*
 * shapes.js — the primitive 2D outlines the banner is made of.
 * All contours are returned counter-clockwise (positive area).
 */

export function roundedRect(x0, x1, y0, y1, r, segs = 6) {
    const w = x1 - x0, h = y1 - y0;
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    if (rad < 1e-4) return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
    const pts = [];
    const corner = (cx, cy, a0) => {
        for (let i = 0; i <= segs; i++) {
            const a = a0 + (Math.PI / 2) * (i / segs);
            pts.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
        }
    };
    corner(x1 - rad, y0 + rad, -Math.PI / 2);
    corner(x1 - rad, y1 - rad, 0);
    corner(x0 + rad, y1 - rad, Math.PI / 2);
    corner(x0 + rad, y0 + rad, Math.PI);
    return pts;
}

/** Rectangle with semicircular caps on the left and right ends — the hanger bar profile. */
export function stadium(x0, x1, y0, y1, segs = 14) {
    const r = (y1 - y0) / 2;
    const cy = (y0 + y1) / 2;
    if (x1 - x0 <= 2 * r + 1e-6) return roundedRect(x0, x1, y0, y1, Math.min(r, (x1 - x0) / 2), segs);
    const pts = [{ x: x0 + r, y: y0 }, { x: x1 - r, y: y0 }];
    for (let i = 1; i < segs; i++) {
        const a = -Math.PI / 2 + Math.PI * (i / segs);
        pts.push({ x: x1 - r + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    pts.push({ x: x1 - r, y: y1 }, { x: x0 + r, y: y1 });
    for (let i = 1; i < segs; i++) {
        const a = Math.PI / 2 + Math.PI * (i / segs);
        pts.push({ x: x0 + r + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return pts;
}

/**
 * The banner silhouette: a rectangle whose bottom edge is cut into a swallowtail —
 * a point at each bottom corner with a V notched up between them.
 * Top edge sits on y = 0, the tail tips reach y = -height.
 */
export function bannerOutline({ width, height, tailDepth = 0, tailStyle = 'swallowtail' }) {
    const hw = width / 2;
    const pts = [{ x: -hw, y: 0 }];
    if (tailStyle === 'point' && tailDepth > 0) {
        pts.push({ x: -hw, y: -(height - tailDepth) }, { x: 0, y: -height }, { x: hw, y: -(height - tailDepth) });
    } else if (tailStyle === 'swallowtail' && tailDepth > 0) {
        pts.push({ x: -hw, y: -height }, { x: 0, y: -(height - tailDepth) }, { x: hw, y: -height });
    } else {
        pts.push({ x: -hw, y: -height }, { x: hw, y: -height });
    }
    pts.push({ x: hw, y: 0 });
    return pts;
}
