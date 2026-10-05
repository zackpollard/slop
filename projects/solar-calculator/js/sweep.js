/*
 * sweep.js — orientation grids and the cell loop behind the solar rose (CONTRACTS §14).
 *
 * The rose is a cheap proxy (engine critique, sweep amendment): one sub-sample per half-hour, no
 * battery, the system's own export tariff and curtailment flag, valued on the forward basis. The
 * engine then re-runs a handful of starred configurations at full fidelity, battery included.
 * Tilt 0 is one configuration however many azimuths the grid has, so it is evaluated once.
 */

/**
 * Orientation grid: every azimuth step × tilt step, plus a single flat (tilt 0) cell.
 * @param {{ azStep?: number, tiltStep?: number, azMin?: number, azMax?: number, tiltMin?: number, tiltMax?: number,
 *   includeFlat?: boolean, tilts?: number[]|null }} [opts] tilts overrides the tilt steps
 * @returns {Array<{ az: number, tilt: number }>} az-major, flat cell first (az 180)
 */
export function orientationGrid({ azStep = 10, tiltStep = 5, azMin = 0, azMax = 350, tiltMin = 5, tiltMax = 90, includeFlat = true, tilts = null } = {}) {
    const out = [];
    const tl = tilts ? tilts.filter((t) => t > 0) : [];
    if (!tilts) for (let t = tiltMin; t <= tiltMax + 1e-9; t += tiltStep) if (t > 0) tl.push(Math.round(t * 1000) / 1000);
    const flat = includeFlat && (tilts ? tilts.includes(0) || tiltMin <= 0 : true);
    // a flat panel has no direction: one cell, labelled south so it sorts with the southern sector
    if (flat) out.push({ az: 180, tilt: 0 });
    for (let a = azMin; a <= azMax + 1e-9; a += azStep) {
        const az = ((Math.round(a * 1000) / 1000) % 360 + 360) % 360;
        for (const tilt of tl) out.push({ az, tilt });
    }
    return out;
}

/**
 * Distinct azimuths and tilts of a grid (ascending), for the rose axes.
 * @param {Array<{ az: number, tilt: number }>} grid
 * @returns {{ azimuths: number[], tilts: number[] }}
 */
export function gridAxes(grid) {
    const az = [...new Set(grid.filter((c) => c.tilt > 0).map((c) => c.az))].sort((a, b) => a - b);
    const tilts = [...new Set(grid.map((c) => c.tilt))].sort((a, b) => a - b);
    return { azimuths: az, tilts };
}

/**
 * Smallest angle between two compass directions.
 * @param {number} a degrees
 * @param {number} b degrees
 * @returns {number} 0..180
 */
export function azDiff(a, b) {
    const d = Math.abs((((a - b) % 360) + 360) % 360);
    return d > 180 ? 360 - d : d;
}

/**
 * Evaluate every grid cell with the engine's proxy model.
 * @param {Object} engine SolarEngine (uses its internal proxy evaluator)
 * @param {Object} system System
 * @param {string} arrayId the array being re-pointed (others stay as they are)
 * @param {Array<{ az: number, tilt: number }>} grid
 * @param {{ onProgress?: (p: { done: number, total: number, pct: number }) => void, ds?: Object, subSteps?: number,
 *   weather?: 'typical'|'actual', finance?: Object, keepBattery?: boolean }} [opts]
 * @returns {Array<{ az: number, tilt: number, kwh: number, gbp: number, pPerKwh: number, peakSharePct: number }>}
 */
export function sweepCells(engine, system, arrayId, grid, opts = {}) {
    return runSteps(sweepCellsSteps(engine, system, arrayId, grid, opts));
}

/**
 * sweepCells as a step generator: it yields after every cell (a place the caller may pause) and
 * returns the cells. runSteps() runs it straight through; runStepsAsync() pauses it.
 * @returns {Generator<undefined, Array<Object>>}
 */
export function* sweepCellsSteps(engine, system, arrayId, grid, opts = {}) {
    const ctx = engine._proxyContext(system, arrayId, opts);
    const out = new Array(grid.length);
    const total = grid.length;
    for (let i = 0; i < total; i++) {
        const { az, tilt } = grid[i];
        out[i] = { az, tilt, ...ctx.evaluate(az, tilt) };
        if (opts.onProgress && (i % 25 === 24 || i === total - 1)) opts.onProgress({ done: i + 1, total, pct: (100 * (i + 1)) / total });
        yield;
    }
    return out;
}

const clock = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/**
 * Run a step generator to the end in one go (its yields are only places it could have paused).
 * @template T
 * @param {Generator<unknown, T>} gen
 * @returns {T}
 */
export function runSteps(gen) {
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
}

/**
 * Run a step generator cooperatively: whenever sliceMs has passed since the last pause it awaits
 * yieldFn() (default: a macrotask) before the next step, so an engine running on the page's own
 * thread leaves the page room to paint and take input. A yieldFn that throws (a cancelled job)
 * stops the run there.
 * @template T
 * @param {Generator<unknown, T>} gen
 * @param {{ yieldFn?: () => Promise<unknown>, sliceMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function runStepsAsync(gen, { yieldFn, sliceMs = 30 } = {}) {
    const pause = typeof yieldFn === 'function' ? yieldFn : () => new Promise((resolve) => setTimeout(resolve, 0));
    const slice = Number.isFinite(sliceMs) && sliceMs >= 0 ? sliceMs : 30;
    let t = clock();
    try {
        let r = gen.next();
        while (!r.done) {
            if (clock() - t >= slice) {
                await pause();
                t = clock();
            }
            r = gen.next();
        }
        return r.value;
    } finally {
        gen.return?.(undefined);
    }
}

/**
 * Cell with the largest value of `key` (first wins ties).
 * @param {Array<Object>} cells
 * @param {string} key
 * @returns {Object|null}
 */
export function bestBy(cells, key) {
    let best = null;
    for (const c of cells) if (best === null || c[key] > best[key]) best = c;
    return best;
}

/**
 * Cells inside an azimuth/tilt window (the azimuth range does not wrap; a flat cell has no
 * direction, so only its tilt is checked).
 * @param {Array<Object>} cells
 * @param {{ azMin?: number, azMax?: number, tiltMin?: number, tiltMax?: number }} [win]
 * @returns {Array<Object>}
 */
export function restrict(cells, { azMin = 0, azMax = 360, tiltMin = 0, tiltMax = 90 } = {}) {
    return cells.filter((c) => c.tilt >= tiltMin && c.tilt <= tiltMax && (c.tilt === 0 || (c.az >= azMin && c.az <= azMax)));
}

/**
 * Grid neighbours of a cell: one azimuth or tilt step away (azimuth wraps at 360°).
 * @param {Array<Object>} cells
 * @param {{ az: number, tilt: number }} c
 * @param {{ azStep?: number, tiltStep?: number }} [steps]
 * @returns {Array<Object>}
 */
export function neighbours(cells, c, { azStep = 10, tiltStep = 5 } = {}) {
    return cells.filter((x) => {
        if (x === c || (x.az === c.az && x.tilt === c.tilt)) return false;
        const dA = azDiff(x.az, c.az);
        const dT = Math.abs(x.tilt - c.tilt);
        // the flat cell touches every azimuth of the first tilt ring
        if (c.tilt === 0) return x.tilt <= tiltStep + 1e-9;
        if (x.tilt === 0) return c.tilt <= tiltStep + 1e-9;
        return (dA <= azStep + 1e-9 && dT === 0) || (dA === 0 && dT <= tiltStep + 1e-9);
    });
}

/**
 * Bounding box of the cells within `pct`% of the best value — the "anything in here is fine" band.
 * Azimuths are reported as the contiguous range around the best (the box never wraps through north).
 * @param {Array<Object>} cells
 * @param {Object} best
 * @param {number} pct
 * @param {string} [key='gbp']
 * @returns {{ azMin: number, azMax: number, tiltMin: number, tiltMax: number, count: number }}
 */
export function tieBox(cells, best, pct, key = 'gbp') {
    const floor = best[key] - (Math.abs(best[key]) * pct) / 100;
    const ok = cells.filter((c) => c[key] >= floor);
    const tilted = ok.filter((c) => c.tilt > 0);
    let azMin = best.az, azMax = best.az;
    for (const c of tilted) {
        // signed offset from the best direction keeps an S-centred range from wrapping through N
        let d = c.az - best.az;
        if (d > 180) d -= 360;
        if (d < -180) d += 360;
        azMin = Math.min(azMin, best.az + d);
        azMax = Math.max(azMax, best.az + d);
    }
    const tl = ok.map((c) => c.tilt);
    return {
        azMin: ((azMin % 360) + 360) % 360,
        azMax: ((azMax % 360) + 360) % 360,
        tiltMin: tl.length ? Math.min(...tl) : best.tilt,
        tiltMax: tl.length ? Math.max(...tl) : best.tilt,
        count: ok.length,
    };
}

/**
 * Linear-interpolated percentile (numpy default) of a numeric list.
 * @param {ArrayLike<number>} values
 * @param {number} q 0..1
 * @returns {number}
 */
export function percentile(values, q) {
    const a = Float64Array.from(values).sort();
    if (!a.length) return NaN;
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

/**
 * 16-point compass name for an azimuth (0 = N).
 * @param {number} az degrees
 * @returns {string}
 */
export function compass16(az) {
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return names[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}
