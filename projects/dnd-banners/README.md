# D&D Banner Tokens

Generates the little heraldic banners that hook over the top of a DM screen to track
initiative order, and exports them as printable **STL** or **3MF** files.

Live at **[dnd-banners.slop.zackpollard.pro](https://dnd-banners.slop.zackpollard.pro)**.

Everything happens in the browser — geometry, triangulation and file writing included.
Nothing is uploaded anywhere.

## What it makes

A banner is a flat plate with a swallowtail bottom, an icon, a name and up to four
subtitle lines, and a bar across the top that rests on the DM screen while the banner
hangs down the front.

Four presets reproduce the hand-made tokens the tool was built from — Ivan the Goliath
Barbarian, Juniper the Elf Druid, Quin the Human Crossbow Fighter, and the DM's own
Elite banner with its red-on-cream daemon skull.

## Detail styles

| Style | What it is | How to print it |
|-------|-----------|-----------------|
| **Inlay** (default) | Icon and lettering are sunk flush into the front face, and separate parts fill those pockets | Face **down** on a textured plate. The plate texture becomes the banner surface. |
| **Raised** | Detail stands proud of the face with a chamfered edge | Face **up**. Pair with the separate hanger bracket, or the attached bar needs supports. |
| **Engraved** | Detail is recessed and nothing fills it | Single colour, single part, either way up. |

With an AMS/MMU, download the **3MF**: every part is in one file, already aligned and
coloured. With a single extruder, download the STLs and insert a filament change at the
detail depth (0.6 mm by default).

## Hanger

The bar spans wider than the banner so it cannot twist on the screen, and it reaches back
by the screen thickness plus your clearance. Measure your screen — most fold-out card
screens are 2–3 mm — and leave about 1–1.5 mm of clearance.

- **Attached** — one piece. The bar prints as a wall standing off the plate, no supports.
- **Separate bracket** — an L-shaped glue-on piece that prints flat on its flange.
- **None** — just the banner.

## How it works

No build step; the page loads ES modules directly.

| Module | Responsibility |
|--------|---------------|
| `js/clip.js` | Polygon booleans, offsets and simplification (ClipperLib) |
| `js/solid.js` | Extrusion, chamfers and cap triangulation |
| `js/paths.js` | SVG and font outlines flattened to contours |
| `js/fonts.js` | Font catalogue, cap-height sizing, synthesised small caps |
| `js/shapes.js` | Banner silhouette, rounded rectangles, the hanger bar profile |
| `js/banner.js` | Layout and assembly — config in, printable parts out |
| `js/exporter.js` | Print orientation, binary STL, 3MF packaging |
| `js/preview.js` | three.js viewport |
| `js/state.js` | Defaults, the four presets, sanitising and persistence |
| `js/icons.js` | Generated icon library |
| `js/app.js` | Controls, party management, zip bundles, downloads |

### Geometry notes

The parts have to survive a slicer, so a few things are deliberate:

- **Cap triangulation uses poly2tri**, a constrained Delaunay triangulator, rather than ear
  clipping. Ear clipping bridges each hole out to the outer ring, and a line of lettering
  hands it a dozen holes whose vertices sit on a shared baseline — those bridges overlap
  and leave cracks along the pocket rims.
- **The front face and the pocket walls come from the same boolean.** Deriving them
  separately is what cracks the mesh: two pockets that touch get merged into one mouth by
  the difference but stay two rings in the pocket set, so the face and the walls end up
  disagreeing about where the boundary runs.
- **Outlines are simplified once**, before anything is extruded. The tolerance scales with
  the smallest lettering, because a tolerance that is free on a 5 mm capital will fold a
  1.5 mm one through itself.
- **Artwork is then grown by two microns.** Clipper will happily return two shapes meeting
  at a single point — an icon whose horn grazes its skull — and a constrained triangulator
  cannot accept a coordinate that appears in two constraints. The growth fuses such
  contacts into one ring, three orders of magnitude below what a printer resolves.
- **Chamfers are rejected where they would not fit.** A miter offset on a letter stem
  thinner than twice the chamfer folds the ring inside out, so the result is checked
  against Clipper and the edge is left square when it fails.

`projects/dnd-banners` has no tests in-repo; the geometry was validated with a headless
harness that asserts every exported part is closed and consistently wound — every directed
edge appearing exactly once alongside its reverse — across the full matrix of detail
styles, hanger modes, tail shapes, lip depths, part clearances, extreme sizes and every
icon in the library.

Saved and imported parties are coerced to the shape of the defaults and clamped to ranges
that still produce geometry, so a hand-edited or truncated file degrades to an odd-looking
banner rather than a broken app.

## Icon library

Icons live in `js/icons.js` as filled SVG subpaths on a 512×512 canvas with `evenodd` fill.
They are drawn chunky on purpose — nothing thinner than about 16 units survives being
printed at 12–16 mm. You can also upload your own SVG; strokes are ignored, so outline it
to a filled path first.

## Libraries (all from CDN, no install)

- [three.js](https://threejs.org/) — preview and SVG path parsing
- [ClipperLib](http://www.angusj.com/delphi/clipper.php) — polygon booleans and offsets
- [poly2tri](https://github.com/r3mi/poly2tri.js) — constrained Delaunay triangulation
- [opentype.js](https://opentype.js.org/) — glyph outlines
- [JSZip](https://stuk.github.io/jszip/) — 3MF and bundle packaging
- Fonts from [Google Fonts](https://github.com/google/fonts) via jsDelivr

## Local development

```bash
cd projects/dnd-banners
python3 -m http.server 8000
```

Then open <http://localhost:8000>. It must be served over HTTP — ES modules will not load
from `file://`.
