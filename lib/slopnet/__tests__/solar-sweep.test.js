import { describe, it, expect } from 'vitest';
import {
    orientationGrid, gridAxes, bestBy, restrict, neighbours, tieBox, percentile, azDiff, compass16, sweepCells,
    sweepCellsSteps, runSteps, runStepsAsync,
} from '../../../projects/solar-calculator/js/sweep.js';

describe('orientationGrid', () => {
    it('engine-critique grid: az 0–350 step 10 × tilt 5–90 step 5 plus tilt 0 once = 649 cells', () => {
        const g = orientationGrid({ azStep: 10, tiltStep: 5 });
        expect(g.length).toBe(36 * 18 + 1);
        expect(g.filter((c) => c.tilt === 0)).toEqual([{ az: 180, tilt: 0 }]);
        const keys = new Set(g.map((c) => `${c.az}|${c.tilt}`));
        expect(keys.size).toBe(g.length);
        expect(Math.max(...g.map((c) => c.az))).toBe(350);
        expect(Math.min(...g.filter((c) => c.tilt > 0).map((c) => c.tilt))).toBe(5);
    });
    it('restricted ranges, explicit tilt lists and no flat cell', () => {
        const g = orientationGrid({ azStep: 15, azMin: 90, azMax: 270, tilts: [15, 30, 45, 60, 90], includeFlat: false });
        expect(g.length).toBe(13 * 5);
        expect(g.some((c) => c.tilt === 0)).toBe(false);
        const withFlat = orientationGrid({ azMin: 90, azMax: 270, tilts: [0, 30] });
        expect(withFlat.filter((c) => c.tilt === 0).length).toBe(1);
        // placement grid for a ground spot (15–45°) has no flat cell
        expect(orientationGrid({ azMin: 90, azMax: 270, tiltMin: 15, tiltMax: 45, includeFlat: false }).length).toBe(19 * 7);
    });
    it('gridAxes lists distinct azimuths of tilted cells and every tilt', () => {
        const { azimuths, tilts } = gridAxes(orientationGrid({ azStep: 90, tiltStep: 45, tiltMin: 45 }));
        expect(azimuths).toEqual([0, 90, 180, 270]);
        expect(tilts).toEqual([0, 45, 90]);
    });
});

describe('cell helpers', () => {
    const cells = [
        { az: 180, tilt: 0, gbp: 120, kwh: 900 },
        { az: 170, tilt: 30, gbp: 150, kwh: 1000 },
        { az: 180, tilt: 30, gbp: 152, kwh: 1010 },
        { az: 190, tilt: 30, gbp: 154, kwh: 1005 },
        { az: 200, tilt: 30, gbp: 155, kwh: 990 },
        { az: 200, tilt: 35, gbp: 153, kwh: 985 },
        { az: 270, tilt: 90, gbp: 110, kwh: 520 },
        { az: 350, tilt: 30, gbp: 60, kwh: 500 },
        { az: 0, tilt: 30, gbp: 59, kwh: 498 },
    ];
    it('bestBy picks the maximum (first on ties)', () => {
        expect(bestBy(cells, 'gbp')).toBe(cells[4]);
        expect(bestBy(cells, 'kwh')).toBe(cells[2]);
        expect(bestBy([], 'gbp')).toBe(null);
    });
    it('restrict keeps the window and the flat cell', () => {
        const r = restrict(cells, { azMin: 90, azMax: 270, tiltMin: 0, tiltMax: 90 });
        expect(r.map((c) => c.az)).toEqual([180, 170, 180, 190, 200, 200, 270]);
        expect(restrict(cells, { tiltMin: 15 }).some((c) => c.tilt === 0)).toBe(false);
    });
    it('neighbours are one step in azimuth or tilt, wrapping through north', () => {
        const nb = neighbours(cells, cells[4], { azStep: 10, tiltStep: 5 });
        expect(nb.map((c) => `${c.az}/${c.tilt}`).sort()).toEqual(['190/30', '200/35']);
        const north = neighbours(cells, cells[7], { azStep: 10, tiltStep: 5 });
        expect(north.map((c) => `${c.az}/${c.tilt}`)).toEqual(['0/30']);
        // the flat cell touches the first tilt ring only
        expect(neighbours(cells, cells[0], { tiltStep: 30 }).length).toBe(6);
    });
    it('tieBox is the bounding box of cells within pct of the best, never wrapping through north', () => {
        const box = tieBox(cells, cells[4], 3);
        expect(box).toEqual({ azMin: 180, azMax: 200, tiltMin: 30, tiltMax: 35, count: 4 });
        const wide = tieBox(cells, cells[4], 25);
        expect(wide.azMin).toBe(170);
        expect(wide.azMax).toBe(200);
        expect(wide.tiltMin).toBe(0);
    });
    it('percentile is numpy-linear; azDiff and compass16', () => {
        expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
        expect(percentile([10, 0, 20], 0.25)).toBe(5);
        expect(percentile(Array.from({ length: 20 }, (_, i) => i), 0.1)).toBeCloseTo(1.9, 12);
        expect(Number.isNaN(percentile([], 0.5))).toBe(true);
        expect(azDiff(350, 10)).toBe(20);
        expect(azDiff(90, 270)).toBe(180);
        expect([0, 22.5, 180, 202.5, 225, 270, 359].map(compass16)).toEqual(['N', 'NNE', 'S', 'SSW', 'SW', 'W', 'N']);
    });
});

describe('sweepCells', () => {
    it('drives the engine proxy once per cell and reports progress', () => {
        const calls = [];
        const engine = {
            _proxyContext: (sys, id, opts) => ({ evaluate: (az, tilt) => { calls.push([az, tilt, id, opts.finance]); return { kwh: az + tilt, gbp: az - tilt, pPerKwh: 1, peakSharePct: 2 }; } }),
        };
        const prog = [];
        const grid = orientationGrid({ azStep: 90, tiltStep: 45, tiltMin: 45 });
        const out = sweepCells(engine, {}, 'a0', grid, { onProgress: (p) => prog.push(p), finance: { years: 10 } });
        expect(out.length).toBe(grid.length);
        expect(out[1]).toEqual({ az: 0, tilt: 45, kwh: 45, gbp: -45, pPerKwh: 1, peakSharePct: 2 });
        expect(calls.every((c) => c[2] === 'a0' && c[3].years === 10)).toBe(true);
        expect(prog[prog.length - 1]).toEqual({ done: grid.length, total: grid.length, pct: 100 });
    });
});

describe('step generators (the inline engine pauses between cells)', () => {
    const engine = { _proxyContext: () => ({ evaluate: (az, tilt) => ({ kwh: az + tilt, gbp: az - tilt, pPerKwh: 1, peakSharePct: 2 }) }) };
    const grid = orientationGrid({ azStep: 90, tiltStep: 45, tiltMin: 45 });
    it('sweepCellsSteps yields after every cell; runSteps gives exactly what sweepCells gives', () => {
        const gen = sweepCellsSteps(engine, {}, 'a0', grid);
        let pauses = 0;
        let r = gen.next();
        while (!r.done) { pauses++; r = gen.next(); }
        expect(pauses).toBe(grid.length);
        expect(r.value).toEqual(sweepCells(engine, {}, 'a0', grid));
        expect(runSteps(sweepCellsSteps(engine, {}, 'a0', grid))).toEqual(r.value);
    });
    it('runStepsAsync pauses once a slice has passed, and a pause that throws (a cancel) stops the run', async () => {
        let pauses = 0;
        const out = await runStepsAsync(sweepCellsSteps(engine, {}, 'a0', grid), { sliceMs: 0, yieldFn: async () => { pauses++; } });
        expect(out).toEqual(sweepCells(engine, {}, 'a0', grid));
        expect(pauses).toBe(grid.length);
        // a long slice never pauses on a fast sweep
        let none = 0;
        await runStepsAsync(sweepCellsSteps(engine, {}, 'a0', grid), { sliceMs: 1e6, yieldFn: async () => { none++; } });
        expect(none).toBe(0);
        let after = 0;
        const counting = (function* () { for (let i = 0; i < 5; i++) { yield; after++; } return 'done'; }());
        const abort = Object.assign(new Error('cancelled'), { name: 'AbortError' });
        await expect(runStepsAsync(counting, { sliceMs: 0, yieldFn: async () => { throw abort; } })).rejects.toBe(abort);
        expect(after).toBe(0);
        expect(counting.next()).toEqual({ value: undefined, done: true });
    });
});
