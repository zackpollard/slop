/*
 * celebrate.js — canvas celebration effects for the big moments of the night.
 *
 * One <canvas>, one shared requestAnimationFrame loop, zero dependencies, no
 * assets and no network. Confetti bursts, two side cannons, a slow rain, a gold
 * sparkle pass and a soft full-screen flash are all drawn from a single flat
 * particle pool that is allocated once and then recycled for the rest of the
 * quiz.
 *
 * Two things this file takes seriously, because a quiz runs for ninety minutes
 * on someone's laptop:
 *   * the loop stops itself the moment there is nothing left to draw — no idle
 *     rAF burning battery between rounds;
 *   * nothing is allocated per frame. Particles are pooled and killed by
 *     swap-remove, the draw order comes out of reusable typed arrays, and the
 *     per-particle transform is one setTransform call with no save/restore.
 *
 * Nothing here throws out of a public method. A missing canvas, a canvas that
 * is display:none at construction time, a browser with no 2d context — all of
 * them degrade to silence, and `supported` says so.
 *
 * Public API
 *   new Celebrate(canvas)      canvas may be null
 *   .resize()                  DPR-aware; call on window resize
 *   .burst(opts)               one-shot confetti burst
 *   .cannons(opts)             two side cannons firing inward — the winner
 *   .rain(opts)                continuous fall; returns a stop() function
 *   .sparkle(opts)             subtle gold twinkle for a correct answer
 *   .pulse(color, opts)        soft full-screen colour flash
 *   .stop()                    clear everything, cancel the frame
 *   .running                   true while the loop is scheduled
 *   .supported                 false when there is no usable canvas
 *   .reducedMotion             true when the OS asks for less movement
 *   .count                     live particle count (diagnostics)
 */

// ---- palette & tuning ----

/** Site theme: brass gold, cream chalk, bottle green, warm red, white. */
export const PALETTE = ['#c4a24e', '#e8e4d4', '#4a9e6e', '#c45e4e', '#ffffff'];

/** Warmer subset used for the sparkle pass and the winner cannons. */
export const GOLDS = ['#c4a24e', '#e0bd6a', '#e8e4d4', '#ffffff'];

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const CAP = 420;            // hard ceiling on live particles
const MAX_COLORS = 24;      // distinct fillStyles tracked for batching
const MAX_DT = 1 / 24;      // clamp long frames (tab wake-ups, GC pauses)
const DPR_CAP = 2;          // more than 2x costs fill rate and buys nothing
const RAIN_BUDGET = 260;    // rain stops emitting past this, leaving room for a burst

// All speeds/accelerations below are "reference" units, multiplied by a scale
// derived from the canvas height so a burst looks the same on a phone and on a
// 65" telly. The cannons are the exception — they aim off the box directly.
const GRAVITY = 620;        // px/s^2
const DRAG = 3.4;           // linear damping, 1/s (terminal fall ~ g/DRAG)

// Cannon aim, as a fraction of the canvas box each side should cover. Two
// cannons overlap in the middle, so a little over half the width each is
// plenty; the vertical figure is deliberately over 1 because gravity eats a
// good part of the climb before the piece gets there.
const CANNON_DRAG = 0.92;   // cannon pieces are launched hard, so drag a touch less
const CANNON_REACH_X = 0.62;
const CANNON_REACH_Y = 1.15;
const FADE_IN = 0.09;       // seconds, stops particles popping into existence

const SHAPE_RECT = 0;
const SHAPE_CIRCLE = 1;
const SHAPE_RIBBON = 2;
const SHAPE_STAR = 3;

const SHAPE_CODES = {
    rect: SHAPE_RECT,
    square: SHAPE_RECT,
    circle: SHAPE_CIRCLE,
    dot: SHAPE_CIRCLE,
    ribbon: SHAPE_RIBBON,
    streamer: SHAPE_RIBBON,
    star: SHAPE_STAR,
    sparkle: SHAPE_STAR,
};

const DEFAULT_SHAPES = [SHAPE_RECT, SHAPE_CIRCLE, SHAPE_RIBBON];
const STAR_SHAPES = [SHAPE_STAR];

// ---- small helpers ----

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

/** Pick usable colour strings, falling back to the theme palette. */
function colorList(value, fallback) {
    if (!Array.isArray(value) || value.length === 0) return fallback;
    const out = [];
    for (const c of value) {
        if (typeof c === 'string' && c.trim()) out.push(c.trim());
    }
    return out.length ? out : fallback;
}

/** Map shape names to internal codes, falling back to the default mix. */
function shapeCodes(value, fallback) {
    if (!Array.isArray(value) || value.length === 0) return fallback;
    const out = [];
    for (const s of value) {
        const code = SHAPE_CODES[String(s).toLowerCase()];
        if (code !== undefined && !out.includes(code)) out.push(code);
    }
    return out.length ? out : fallback;
}

/** #rgb / #rrggbb / #rrggbbaa -> 'rgba(r, g, b, a)'. Returns null otherwise. */
function hexToRgba(color, alpha) {
    if (typeof color !== 'string') return null;
    let h = color.trim();
    if (h.charCodeAt(0) !== 35) return null;   // '#'
    h = h.slice(1);
    if (h.length === 3 || h.length === 4) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    } else if (h.length === 8) {
        h = h.slice(0, 6);
    }
    if (h.length !== 6 || !/^[0-9a-f]{6}$/i.test(h)) return null;
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const now = () => (typeof performance === 'object' && performance && performance.now
    ? performance.now()
    : Date.now());

// ---- particle ----

/**
 * One flat, monomorphic record. Every field is set in the constructor so the
 * shape never changes and the engine can keep them all in one hidden class.
 */
class Particle {
    constructor() {
        this.x = 0; this.y = 0;             // position, CSS px
        this.vx = 0; this.vy = 0;           // velocity, CSS px/s
        this.w = 0; this.h = 0;             // size, CSS px
        this.rot = 0; this.vr = 0;          // z rotation (in the screen plane)
        this.tilt = 0; this.vTilt = 0;      // x rotation (edge-on flip)
        this.sy = 1;                        // cos(tilt), cached for the draw pass
        this.drag = DRAG;
        this.grav = GRAVITY;
        this.wob = 0;                       // flutter acceleration amplitude
        this.wobPhase = 0;
        this.wobSpeed = 0;
        this.life = 0;
        this.ttl = 1;
        this.fade = 0.4;                    // seconds of fade at the end of life
        this.alpha = 1;
        this.ci = 0;                        // colour index into #colors
        this.shape = SHAPE_RECT;
        this.spark = 0;                     // 1 = twinkling star, drawn additively
    }
}

// ---- engine ----

export class Celebrate {
    #canvas = null;
    #ctx = null;

    #dpr = 1;
    #w = 0;                 // CSS px
    #h = 0;
    #pw = 0;                // device px (backing store)
    #ph = 0;
    #scale = 1;             // speed/gravity scale from the canvas height
    #sized = false;
    #dirty = true;
    #ro = null;
    #mq = null;

    #pool = [];
    #live = 0;
    #rr = 0;                // round-robin cursor used when the pool is full

    #colors = [];
    #colorIds = new Map();
    #counts = new Int32Array(MAX_COLORS * 2 + 2);
    #order = new Int32Array(CAP);

    #emitters = [];         // rain
    #queue = [];            // delayed volleys

    #flash = { on: false, t: 0, dur: 0, peak: 0, color: '' };
    #grad = null;
    #gradKey = '';

    #raf = 0;
    #last = 0;

    /** @param {HTMLCanvasElement|null} canvas */
    constructor(canvas) {
        this.#canvas = canvas || null;

        try {
            if (this.#canvas && typeof this.#canvas.getContext === 'function') {
                this.#ctx = this.#canvas.getContext('2d', { alpha: true });
            }
        } catch {
            this.#ctx = null;
        }

        try {
            this.#mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        } catch {
            this.#mq = null;
        }

        // The canvas is very often display:none or unstyled at construction
        // time, so a zero box here is expected — resize() just marks itself
        // unsized and the first effect tries again.
        try {
            this.resize();
        } catch {
            this.#sized = false;
        }

        // Catches layout changes the window 'resize' event never sees
        // (sidebars, big-screen mode, the canvas being revealed).
        try {
            if (this.#canvas && typeof ResizeObserver === 'function') {
                this.#ro = new ResizeObserver(() => { this.#dirty = true; });
                this.#ro.observe(this.#canvas);
            }
        } catch {
            this.#ro = null;
        }
    }

    // ---- capability flags ----

    /** False when there is no canvas or no 2d context: every effect no-ops. */
    get supported() {
        return !!this.#ctx && typeof requestAnimationFrame === 'function';
    }

    /** True when the OS asks for reduced motion. Read live, never cached. */
    get reducedMotion() {
        try {
            return !!(this.#mq && this.#mq.matches);
        } catch {
            return false;
        }
    }

    get running() {
        return this.#raf !== 0;
    }

    /** Live particle count — handy in the console, not needed by the app. */
    get count() {
        return this.#live;
    }

    // ---- sizing ----

    /**
     * Match the backing store to the CSS box and the device pixel ratio.
     * Safe to call at any time, including before the canvas has a size; a zero
     * box simply leaves the engine unsized until something asks again.
     */
    resize() {
        this.#dirty = false;
        const canvas = this.#canvas;
        if (!canvas || !this.#ctx) { this.#sized = false; return; }

        let cssW = 0;
        let cssH = 0;
        try {
            const rect = canvas.getBoundingClientRect();
            cssW = rect.width;
            cssH = rect.height;
        } catch {
            cssW = 0;
            cssH = 0;
        }

        // Fall back to the layout box in case the element is inside a
        // transformed ancestor with a collapsed client rect.
        if (!(cssW > 0) || !(cssH > 0)) {
            cssW = canvas.clientWidth || 0;
            cssH = canvas.clientHeight || 0;
        }

        if (!(cssW > 0) || !(cssH > 0)) {
            // display:none, detached, or zero-sized. Nothing to draw on.
            this.#sized = false;
            this.#w = 0;
            this.#h = 0;
            return;
        }

        const dpr = clamp(this.#ratio(), 1, DPR_CAP);
        const pw = Math.max(1, Math.round(cssW * dpr));
        const ph = Math.max(1, Math.round(cssH * dpr));

        this.#w = cssW;
        this.#h = cssH;
        this.#dpr = dpr;
        this.#sized = true;
        // Scale from the height, not the diagonal: every arc here is driven by
        // gravity, so height is what decides whether a fountain looks right and
        // how long a piece takes to fall. Using the diagonal makes a narrow
        // phone screen fall in slow motion, which quietly piles up particles.
        this.#scale = clamp(cssH / 760, 0.72, 1.9);

        // Writing width/height clears the canvas, so only touch it on a real
        // change — resize events fire in floods while a window is dragged.
        if (pw !== this.#pw || ph !== this.#ph) {
            this.#pw = pw;
            this.#ph = ph;
            try {
                canvas.width = pw;
                canvas.height = ph;
            } catch {
                this.#sized = false;
            }
            this.#grad = null;
            this.#gradKey = '';
        }
    }

    // ---- effects ----

    /**
     * One-shot confetti burst.
     * @param {object} [opts]
     * @param {number} [opts.count=120]
     * @param {string[]} [opts.colors]           CSS colours; defaults to PALETTE
     * @param {{x:number,y:number}} [opts.origin] fractions of the canvas box
     * @param {number} [opts.spread=70]          cone width in degrees
     * @param {number} [opts.power=1]            launch speed multiplier
     * @param {string[]} [opts.shapes]           'rect' | 'circle' | 'ribbon' | 'star'
     * @param {number} [opts.angle=90]           launch direction, 90 = straight up
     * @param {number} [opts.scale=1]            particle size multiplier
     */
    burst(opts = {}) {
        if (!this.#ready()) return;
        const o = opts || {};

        if (this.reducedMotion) {
            this.#calmFade(colorList(o.colors, PALETTE)[0], 0.7, 0.2);
            return;
        }

        const count = Math.round(clamp(num(o.count, 120), 0, CAP));
        if (count <= 0) return;

        this.#emit(count, this.#params({
            origin: o.origin,
            colors: colorList(o.colors, PALETTE),
            shapes: shapeCodes(o.shapes, DEFAULT_SHAPES),
            angle: num(o.angle, 90),
            spread: num(o.spread, 70),
            // Tuned so the top of the fountain lands near the top of the frame:
            // launch much harder and the burst spends a second off-screen.
            speed: 1250 * clamp(num(o.power, 1), 0.1, 4),
            speedMin: 0.42,
            scale: clamp(num(o.scale, 1), 0.3, 3),
            ttl: 3.4,
            spreadX: 0.02,
            spreadY: 0.02,
        }));

        this.#wake();
    }

    /**
     * Two side cannons firing inward and upward, in three staggered volleys —
     * the winner moment. Everything is queued through the frame loop, so
     * stop() genuinely stops it (no stray timers land afterwards).
     * @param {object} [opts]
     * @param {number} [opts.count=220]  total particles across both sides
     * @param {string[]} [opts.colors]
     * @param {number} [opts.power=1]
     * @param {number} [opts.spread=38]
     * @param {number} [opts.volleys=3]
     */
    cannons(opts = {}) {
        if (!this.#ready()) return;
        const o = opts || {};

        if (this.reducedMotion) {
            this.#calmFade(colorList(o.colors, GOLDS)[0], 0.95, 0.24);
            return;
        }

        const colors = colorList(o.colors, PALETTE);
        const shapes = shapeCodes(o.shapes, DEFAULT_SHAPES);
        const power = clamp(num(o.power, 1), 0.1, 3);
        const spread = num(o.spread, 38);
        const volleys = Math.round(clamp(num(o.volleys, 3), 1, 6));
        const total = Math.round(clamp(num(o.count, 220), 0, CAP * 2));
        if (total <= 0) return;

        // Aim from the actual box rather than from one size scalar: reach needs
        // the width, height needs the height, and a single scaled speed cannot
        // serve both (a phone would fire everything out through the ceiling).
        // Under linear drag a piece coasts roughly v0 / k before it stops, so
        // solve for the launch that lands inside the frame on any aspect ratio.
        const kEff = DRAG * CANNON_DRAG * 0.8;
        const vx0 = CANNON_REACH_X * this.#w * kEff * power;
        const vy0 = CANNON_REACH_Y * this.#h * kEff * power;
        const speed = Math.hypot(vx0, vy0);
        const aim = Math.atan2(vy0, vx0) / DEG;

        // Front-load the first volley: the bang should be the biggest.
        const weights = [];
        let sum = 0;
        for (let v = 0; v < volleys; v++) {
            const wgt = 1 / (1 + v * 0.8);
            weights.push(wgt);
            sum += wgt;
        }

        for (let v = 0; v < volleys; v++) {
            const n = Math.max(1, Math.round((total * weights[v]) / sum / 2));
            const delay = v * 0.22;
            const jitter = 1 + v * 0.06;

            for (const side of [0, 1]) {
                const params = this.#params({
                    origin: { x: side === 0 ? 0.015 : 0.985, y: 0.94 },
                    colors,
                    shapes,
                    angle: side === 0 ? aim : 180 - aim,
                    spread,
                    speed: speed * jitter,
                    abs: true,
                    speedMin: 0.55,
                    scale: 1,
                    ttl: 4.2,
                    dragMul: CANNON_DRAG,
                    spreadX: 0.01,
                    spreadY: 0.03,
                });

                if (delay <= 0) this.#emit(n, params);
                else this.#queue.push({ t: delay, n, o: params });
            }
        }

        // A soft gold wash under the first volley, so the moment lands even on
        // a projector where individual pieces read small.
        this.#pulseInternal(GOLDS[0], 0.9, 0.16);
        this.#wake();
    }

    /**
     * Start a continuous confetti fall. Returns a stop() function; calling it
     * twice is harmless. Never runs under reduced motion — it returns a no-op
     * so callers do not have to check.
     * @param {object} [opts]
     * @param {number} [opts.rate=42]        particles per second
     * @param {number} [opts.duration=Infinity] seconds before it stops itself
     * @param {string[]} [opts.colors]
     * @param {number} [opts.drift=0]        sideways drift, -1..1
     * @param {number} [opts.scale=1]
     * @returns {() => void}
     */
    rain(opts = {}) {
        const noop = () => {};
        if (!this.#ready() || this.reducedMotion) return noop;
        const o = opts || {};

        const params = this.#params({
            origin: { x: 0.5, y: -0.04 },
            colors: colorList(o.colors, PALETTE),
            shapes: shapeCodes(o.shapes, DEFAULT_SHAPES),
            angle: -90,                       // downward
            spread: 26,
            speed: 110,
            speedMin: 0.35,
            // Lighter than a burst: rain should drift down, not drop.
            gravity: 0.6,
            scale: clamp(num(o.scale, 1), 0.3, 3),
            ttl: 12,
            spreadX: 1.05,
            spreadY: 0.01,
            driftX: clamp(num(o.drift, 0), -1, 1) * 150,
        });

        const emitter = {
            rate: clamp(num(o.rate, 42), 0, 160),
            acc: 0,
            life: 0,
            ttl: Math.max(0, num(o.duration, Infinity)),
            params,
            dead: false,
        };

        this.#emitters.push(emitter);
        this.#wake();

        return () => { emitter.dead = true; };
    }

    /**
     * A subtle gold twinkle over the answer reveal. Small four-point stars that
     * drift, breathe and go out — no gravity, nothing flying about.
     * @param {object} [opts]
     * @param {number} [opts.count=26]
     * @param {{x:number,y:number}} [opts.origin]
     * @param {number} [opts.spread=0.42]  radius as a fraction of the short side
     * @param {string[]} [opts.colors]
     * @param {number} [opts.scale=1]
     */
    sparkle(opts = {}) {
        if (!this.#ready()) return;
        const o = opts || {};

        if (this.reducedMotion) {
            this.#calmFade(colorList(o.colors, GOLDS)[0], 0.6, 0.14);
            return;
        }

        const count = Math.round(clamp(num(o.count, 26), 0, 200));
        if (count <= 0) return;

        const spread = clamp(num(o.spread, 0.42), 0.02, 1.2);
        const params = this.#params({
            origin: o.origin || { x: 0.5, y: 0.44 },
            colors: colorList(o.colors, GOLDS),
            shapes: STAR_SHAPES,
            angle: 90,
            spread: 150,
            speed: 46,
            speedMin: 0.2,
            scale: clamp(num(o.scale, 1), 0.3, 3),
            ttl: 1.5,
            gravity: -0.04,
            dragMul: 0.6,
            spark: 1,
            spreadX: spread * 1.5,
            spreadY: spread * 0.9,
            ellipse: true,
        });

        this.#emit(count, params);
        this.#wake();
    }

    /**
     * A soft full-screen colour flash: bright at the edges, clear in the middle
     * so whatever is on the telly stays readable. Used for time-up.
     * @param {string} [color]
     * @param {object} [opts]
     * @param {number} [opts.duration=0.62] seconds
     * @param {number} [opts.strength=0.32] peak alpha, 0..1
     */
    pulse(color, opts = {}) {
        if (!this.#ready()) return;
        const o = opts || {};
        this.#pulseInternal(
            typeof color === 'string' && color.trim() ? color.trim() : PALETTE[0],
            clamp(num(o.duration, 0.62), 0.08, 4),
            clamp(num(o.strength, 0.32), 0, 0.85),
        );
        this.#wake();
    }

    /** Clear everything and cancel the animation frame. Always safe. */
    stop() {
        if (this.#raf) {
            try {
                cancelAnimationFrame(this.#raf);
            } catch { /* ignore */ }
            this.#raf = 0;
        }
        this.#hardReset();
        this.#clear();
    }

    // ---- internals: state ----

    /** devicePixelRatio, defensively — some embedders do odd things to it. */
    #ratio() {
        try {
            return num(window.devicePixelRatio, 1) || 1;
        } catch {
            return 1;
        }
    }

    #ready() {
        if (!this.supported) return false;
        if (this.#dirty || !this.#sized) this.resize();
        return this.#sized;
    }

    #hardReset() {
        this.#live = 0;
        this.#rr = 0;
        this.#emitters.length = 0;
        this.#queue.length = 0;
        this.#flash.on = false;
        this.#grad = null;
        this.#gradKey = '';
        this.#colors.length = 0;
        this.#colorIds.clear();
    }

    #clear() {
        const ctx = this.#ctx;
        if (!ctx || !this.#pw || !this.#ph) return;
        try {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.clearRect(0, 0, this.#pw, this.#ph);
        } catch { /* ignore */ }
    }

    #wake() {
        if (this.#raf || !this.supported) return;
        this.#last = now();
        try {
            this.#raf = requestAnimationFrame(this.#frame);
        } catch {
            this.#raf = 0;
        }
    }

    /** Register a colour and get its batching index. Bounded, cleared on idle. */
    #colorId(color) {
        let id = this.#colorIds.get(color);
        if (id === undefined) {
            if (this.#colors.length >= MAX_COLORS) return 0;
            id = this.#colors.length;
            this.#colors.push(color);
            this.#colorIds.set(color, id);
        }
        return id;
    }

    #pulseInternal(color, duration, strength) {
        const f = this.#flash;
        // A second flash while one is running restarts it rather than stacking.
        f.on = true;
        f.t = 0;
        f.dur = duration;
        f.peak = strength;
        if (f.color !== color) {
            f.color = color;
            this.#grad = null;
        }
    }

    /** Reduced-motion stand-in: a brief, calm opacity fade. No particles. */
    #calmFade(color, duration, strength) {
        this.#pulseInternal(color || PALETTE[0], duration, strength);
        this.#wake();
    }

    // ---- internals: spawning ----

    /**
     * Build one reusable emit descriptor. Called once per effect (never per
     * particle, and never per frame — rain keeps its descriptor on the
     * emitter), so the shape can stay readable.
     */
    #params(cfg) {
        const colors = cfg.colors;
        const cids = new Array(colors.length);
        for (let i = 0; i < colors.length; i++) cids[i] = this.#colorId(colors[i]);

        const ox = clamp(num(cfg.origin && cfg.origin.x, 0.5), -0.5, 1.5);
        const oy = clamp(num(cfg.origin && cfg.origin.y, 0.4), -0.5, 1.5);

        return {
            ox,
            oy,
            xr: num(cfg.spreadX, 0.02),         // fractions of the canvas box
            yr: num(cfg.spreadY, 0.02),
            ellipse: !!cfg.ellipse,
            angle: -num(cfg.angle, 90) * DEG,   // 90 = up, canvas y grows down
            spread: Math.abs(num(cfg.spread, 70)) * DEG,
            speed: num(cfg.speed, 1200),
            // true = speed is already in px/s and must not be scaled again
            abs: !!cfg.abs,
            speedMin: clamp(num(cfg.speedMin, 0.45), 0, 1),
            driftX: num(cfg.driftX, 0),
            driftY: num(cfg.driftY, 0),
            gravity: num(cfg.gravity, 1),
            dragMul: num(cfg.dragMul, 1),
            scale: num(cfg.scale, 1),
            ttl: num(cfg.ttl, 3),
            spark: cfg.spark ? 1 : 0,
            cids,
            shapes: cfg.shapes,
        };
    }

    #emit(n, o) {
        const pool = this.#pool;
        const W = this.#w;
        const H = this.#h;
        const short = Math.min(W, H);
        const scale = o.scale * clamp(this.#scale, 0.85, 1.7);
        const cids = o.cids;
        const shapes = o.shapes;
        const speedScale = this.#scale;
        const launchScale = o.abs ? 1 : speedScale;

        for (let k = 0; k < n; k++) {
            let p;
            if (this.#live < CAP) {
                p = pool[this.#live];
                if (!p) { p = new Particle(); pool[this.#live] = p; }
                this.#live++;
            } else {
                // Full: recycle in a rolling fashion so the newest effect is
                // always visible rather than being silently dropped.
                if (this.#rr >= CAP) this.#rr = 0;
                p = pool[this.#rr++];
            }

            // position
            if (o.ellipse) {
                const a = Math.random() * TAU;
                const r = Math.sqrt(Math.random());
                p.x = W * o.ox + Math.cos(a) * r * short * o.xr * 0.5;
                p.y = H * o.oy + Math.sin(a) * r * short * o.yr * 0.5;
            } else {
                p.x = W * o.ox + (Math.random() - 0.5) * W * o.xr;
                p.y = H * o.oy + (Math.random() - 0.5) * H * o.yr;
            }

            // velocity
            const ang = o.angle + (Math.random() - 0.5) * o.spread;
            const sp = o.speed * launchScale * (o.speedMin + Math.random() * (1 - o.speedMin));
            p.vx = Math.cos(ang) * sp + o.driftX * speedScale;
            p.vy = Math.sin(ang) * sp + o.driftY * speedScale;

            // shape & size
            const shape = shapes.length === 1
                ? shapes[0]
                : shapes[(Math.random() * shapes.length) | 0];
            p.shape = shape;
            if (shape === SHAPE_RIBBON) {
                p.w = rand(4, 7) * scale;
                p.h = p.w * rand(2.6, 4.4);
            } else if (shape === SHAPE_CIRCLE) {
                p.w = rand(6, 11) * scale;
                p.h = p.w;
            } else if (shape === SHAPE_STAR) {
                p.w = rand(3.5, 9) * scale;
                p.h = p.w;
            } else {
                p.w = rand(7, 12) * scale;
                p.h = p.w * rand(0.5, 1.15);
            }

            // Bigger pieces carry more mass, so they cut through the air a
            // little better — this is what stops confetti looking uniform.
            const bulk = clamp(10 / (5 + p.w), 0.55, 1.35);
            p.drag = DRAG * o.dragMul * bulk * rand(0.85, 1.18);
            // Gravity scales with the canvas alongside launch speed, so an arc
            // takes the same *time* on a phone as it does on a 65" telly.
            p.grav = GRAVITY * o.gravity * rand(0.88, 1.14) * speedScale / bulk;

            // rotation on two axes: z spins in the plane, tilt flips edge-on
            p.rot = Math.random() * TAU;
            p.vr = rand(-7, 7) * (shape === SHAPE_STAR ? 0.25 : 1);
            p.tilt = Math.random() * TAU;
            p.vTilt = rand(3, 9) * (Math.random() < 0.5 ? -1 : 1);
            p.sy = 1;

            // flutter
            p.wob = rand(90, 260) * speedScale * (o.spark ? 0.25 : 1);
            p.wobPhase = Math.random() * TAU;
            p.wobSpeed = rand(3.5, 8);

            p.life = 0;
            p.ttl = o.ttl * rand(0.75, 1.25);
            p.fade = o.spark ? p.ttl * 0.75 : Math.min(1.1, p.ttl * 0.42);
            p.alpha = 0;
            p.spark = o.spark;
            p.ci = cids.length === 1 ? cids[0] : cids[(Math.random() * cids.length) | 0];
        }
    }

    // ---- internals: the loop ----

    #frame = (t) => {
        this.#raf = 0;

        if (!this.supported) return;

        // A DPR change (window dragged to another monitor) is cheap to spot.
        const dpr = clamp(this.#ratio(), 1, DPR_CAP);
        if (this.#dirty || dpr !== this.#dpr) this.resize();

        if (!this.#sized) {
            // Hidden mid-run — printing, a display:none parent. Do not burn
            // frames drawing into nothing, and wipe the backing store so the
            // last frame is not still sitting there when it reappears.
            this.#hardReset();
            this.#clear();
            return;
        }

        const dt = clamp((t - this.#last) / 1000, 0, MAX_DT);
        this.#last = t;

        this.#tickQueue(dt);
        this.#tickEmitters(dt);
        this.#step(dt);
        this.#tickFlash(dt);
        this.#draw();

        const busy = this.#live > 0
            || this.#flash.on
            || this.#queue.length > 0
            || this.#emitters.length > 0;

        if (busy) {
            try {
                this.#raf = requestAnimationFrame(this.#frame);
            } catch {
                this.#raf = 0;
            }
        } else {
            // Idle: one last clear, drop the colour registry, and let the
            // browser go back to sleep until the next big moment.
            this.#clear();
            this.#colors.length = 0;
            this.#colorIds.clear();
        }
    };

    #tickQueue(dt) {
        const q = this.#queue;
        for (let i = q.length - 1; i >= 0; i--) {
            const item = q[i];
            item.t -= dt;
            if (item.t <= 0) {
                q.splice(i, 1);
                this.#emit(item.n, item.o);
            }
        }
    }

    #tickEmitters(dt) {
        const list = this.#emitters;
        if (list.length === 0) return;

        // A mid-session switch to reduced motion kills any running rain.
        if (this.reducedMotion) { list.length = 0; return; }

        for (let i = list.length - 1; i >= 0; i--) {
            const em = list[i];
            em.life += dt;
            if (em.dead || em.life >= em.ttl) {
                list.splice(i, 1);
                continue;
            }
            em.acc += em.rate * dt;
            if (em.acc >= 1) {
                const n = Math.min(em.acc | 0, 40);
                em.acc -= n;
                // Rain is open-ended, so it is not allowed to fill the pool and
                // starve a burst fired over the top of it.
                if (this.#live < RAIN_BUDGET) this.#emit(n, em.params);
            }
        }
    }

    #step(dt) {
        const pool = this.#pool;
        const W = this.#w;
        const H = this.#h;
        const killY = H + 90;
        const killL = -140;
        const killR = W + 140;

        let live = this.#live;
        let i = 0;

        while (i < live) {
            const p = pool[i];
            p.life += dt;

            // integrate: gravity, linear drag, and a sideways flutter
            p.vx += (p.wob * Math.sin(p.wobPhase) - p.drag * p.vx) * dt;
            p.vy += (p.grav - p.drag * p.vy) * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.rot += p.vr * dt;
            p.tilt += p.vTilt * dt;
            p.wobPhase += p.wobSpeed * dt;

            const left = p.ttl - p.life;
            const dead = left <= 0 || p.y > killY || p.x < killL || p.x > killR;
            if (dead) {
                // swap-remove: the dead object stays in the pool for reuse
                live--;
                pool[i] = pool[live];
                pool[live] = p;
                continue;
            }

            // fade out, fade in, and the light catching a turning face
            let a = left < p.fade ? left / p.fade : 1;
            if (p.life < FADE_IN) a *= p.life / FADE_IN;

            if (p.spark) {
                p.sy = 1;
                a *= 0.42 + 0.58 * Math.abs(Math.sin(p.wobPhase * 1.6));
            } else {
                const sy = Math.cos(p.tilt);
                p.sy = sy;
                a *= 0.58 + 0.42 * Math.abs(sy);
            }
            p.alpha = a;

            i++;
        }

        this.#live = live;
    }

    #tickFlash(dt) {
        const f = this.#flash;
        if (!f.on) return;
        f.t += dt;
        if (f.t >= f.dur) f.on = false;
    }

    // ---- internals: drawing ----

    #draw() {
        const ctx = this.#ctx;
        const dpr = this.#dpr;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, this.#pw, this.#ph);

        const live = this.#live;
        if (live > 0) {
            const order = this.#buildOrder(live);
            const pool = this.#pool;
            const colors = this.#colors;
            const nc = colors.length;
            let lastCi = -1;
            let additive = false;

            for (let k = 0; k < live; k++) {
                const p = pool[order[k]];

                // Sparkles sort into the tail of the order, so the composite
                // mode flips exactly once per frame.
                if (!additive && p.spark) {
                    ctx.globalCompositeOperation = 'lighter';
                    additive = true;
                    lastCi = -1;
                }

                const key = p.spark ? nc + p.ci : p.ci;
                if (key !== lastCi) {
                    ctx.fillStyle = colors[p.ci] || PALETTE[0];
                    lastCi = key;
                }

                ctx.globalAlpha = p.alpha;

                // translate(x, y) * rotate(rot) * scale(1, sy), folded into one
                // setTransform along with the device pixel ratio. No save/restore.
                const c = Math.cos(p.rot);
                const s = Math.sin(p.rot);
                const sy = p.sy;
                ctx.setTransform(
                    c * dpr, s * dpr,
                    -s * sy * dpr, c * sy * dpr,
                    p.x * dpr, p.y * dpr,
                );

                switch (p.shape) {
                    case SHAPE_RECT:
                        ctx.fillRect(p.w * -0.5, p.h * -0.5, p.w, p.h);
                        break;

                    case SHAPE_CIRCLE:
                        ctx.beginPath();
                        ctx.arc(0, 0, p.w * 0.5, 0, TAU);
                        ctx.fill();
                        break;

                    case SHAPE_RIBBON: {
                        const hw = p.w * 0.5;
                        const hh = p.h * 0.5;
                        const bend = Math.sin(p.wobPhase) * p.w * 1.15;
                        ctx.beginPath();
                        ctx.moveTo(-hw, -hh);
                        ctx.quadraticCurveTo(-hw + bend, 0, -hw, hh);
                        ctx.lineTo(hw, hh);
                        ctx.quadraticCurveTo(hw + bend, 0, hw, -hh);
                        ctx.closePath();
                        ctx.fill();
                        break;
                    }

                    default: {
                        // four-point twinkle: control points pulled to the
                        // centre give the pinched, classy star
                        const r = p.w;
                        const q = r * 0.11;
                        ctx.beginPath();
                        ctx.moveTo(0, -r);
                        ctx.quadraticCurveTo(q, -q, r, 0);
                        ctx.quadraticCurveTo(q, q, 0, r);
                        ctx.quadraticCurveTo(-q, q, -r, 0);
                        ctx.quadraticCurveTo(-q, -q, 0, -r);
                        ctx.fill();
                        break;
                    }
                }
            }

            if (additive) ctx.globalCompositeOperation = 'source-over';
        }

        if (this.#flash.on) this.#drawFlash();

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
    }

    /**
     * Counting sort of the live particles by (spark, colour) into a reusable
     * Int32Array, so the draw pass sets fillStyle once per colour instead of
     * once per particle. Allocation-free after the first call.
     */
    #buildOrder(live) {
        const pool = this.#pool;
        const nc = Math.max(1, this.#colors.length);
        const buckets = nc * 2;

        let counts = this.#counts;
        if (counts.length < buckets + 1) {
            counts = new Int32Array(buckets + 8);
            this.#counts = counts;
        }
        counts.fill(0, 0, buckets);

        for (let i = 0; i < live; i++) {
            const p = pool[i];
            counts[p.spark ? nc + p.ci : p.ci]++;
        }

        let running = 0;
        for (let b = 0; b < buckets; b++) {
            const c = counts[b];
            counts[b] = running;
            running += c;
        }

        let order = this.#order;
        if (order.length < live) {
            order = new Int32Array(Math.max(live, CAP));
            this.#order = order;
        }

        for (let i = 0; i < live; i++) {
            const p = pool[i];
            order[counts[p.spark ? nc + p.ci : p.ci]++] = i;
        }

        return order;
    }

    #drawFlash() {
        const ctx = this.#ctx;
        const f = this.#flash;
        const W = this.#w;
        const H = this.#h;

        // fast in, slow out — a soft breath rather than a strobe
        const t = clamp(f.t / f.dur, 0, 1);
        const env = t < 0.18 ? t / 0.18 : 1 - (t - 0.18) / 0.82;
        const alpha = f.peak * env * env;
        if (alpha <= 0.002) return;

        const key = `${f.color}|${W}|${H}`;
        if (!this.#grad || this.#gradKey !== key) {
            this.#grad = this.#makeGradient(f.color, W, H);
            this.#gradKey = key;
        }

        ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = alpha;
        ctx.fillStyle = this.#grad || f.color;
        ctx.fillRect(0, 0, W, H);
    }

    #makeGradient(color, W, H) {
        try {
            const cx = W * 0.5;
            const cy = H * 0.5;
            const g = this.#ctx.createRadialGradient(
                cx, cy, Math.min(W, H) * 0.12,
                cx, cy, Math.hypot(W, H) * 0.6,
            );
            const clear = hexToRgba(color, 0) || 'transparent';
            const mid = hexToRgba(color, 0.45) || color;
            g.addColorStop(0, clear);
            g.addColorStop(0.55, mid);
            g.addColorStop(1, color);
            return g;
        } catch {
            return null;
        }
    }
}

export default Celebrate;
