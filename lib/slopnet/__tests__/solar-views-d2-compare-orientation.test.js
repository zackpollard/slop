/*
 * solar-views-d2-compare-orientation — wave D2 fixes in the Compare and Orientation views:
 *   - compare: 'Value per kWh made' is Design's figure (the solar's share of the saving, not the
 *     battery's cheap-slot charging), checked on synthetic results and on the engine's own run;
 *   - orientation: the answer card's "little or no sun after 4pm" months come from the west-wall
 *     run (the season card's rule), not a fixed November–February;
 *   - CSS: the phone card layout drops the desktop name column's 190 px floor, and no text in
 *     either view is coloured --faint (3.3:1).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './solar-fake-dom.js';
import designView from '../../../projects/solar-calculator/js/views/design.js';
import { rowModel, solarPPerKwh } from '../../../projects/solar-calculator/js/views/compare.js';
import orientationView, { darkMonths, darkMonthsPhrase } from '../../../projects/solar-calculator/js/views/orientation.js';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';
import { sliceDemo, loadCatalog } from './fixtures/solar/b1-load.js';

const src = name => readFileSync(fileURLToPath(new URL(`../../../projects/solar-calculator/js/views/${name}`, import.meta.url)), 'utf8');

/* ── compare: value per kWh made ───────────────────────────────────────────── */

describe('compare: value per kWh made is the solar’s share, as in Design', () => {
    const res = (headline, battery = null) => ({
        headline: { capexGbp: 1000, savingsGbp: 0, ...headline },
        battery, typical: { annual: {} }, rules: { legal: 'ok', errors: [], warnings: [] }, finance: {},
    });
    const entry = { sys: { id: 'H3', route: 'hardwired', costs: [], battery: { coupling: 'dc' } }, kind: 'auto' };

    it('a battery’s cheap-slot charging and standby are left out (H3 on the demo year: 25.1p, not 30.4p)', () => {
        // the demo-year H3 split: base 258.23, fromSolar 198.83, fromGrid 112.19, standby −15.71
        const r = res({ savingsGbp: 553.54, pvKwh: 1819.3 }, { baseGbp: 258.23, split: { fromSolarGbp: 198.83, fromGridGbp: 112.19, standbyGbp: -15.71 } });
        const row = rowModel(entry, r);
        expect(row.pPerKwh).toBeCloseTo((100 * (258.23 + 198.83)) / 1819.3, 9);
        expect(row.pPerKwh).toBeCloseTo(25.12, 1);
        expect(row.pPerKwh).toBeCloseTo(designView.solarPPerKwh(r), 9);
        expect(row.pPerKwhSplit).toBe(true);
    });

    it('panels alone: the headline saving ÷ kWh made; a negative storing-solar share counts as nothing', () => {
        const plain = res({ savingsGbp: 172, pvKwh: 1045 });
        expect(rowModel({ sys: { id: 'S01', route: 'plugin', costs: [] }, kind: 'auto' }, plain).pPerKwh).toBeCloseTo(100 * 172 / 1045, 9);
        expect(solarPPerKwh(plain)).toBeCloseTo(designView.solarPPerKwh(plain), 9);
        const neg = res({ savingsGbp: 90, pvKwh: 500 }, { baseGbp: 80, split: { fromSolarGbp: -3, fromGridGbp: 15, standbyGbp: -2 } });
        expect(solarPPerKwh(neg)).toBeCloseTo(16, 9);
        expect(solarPPerKwh(neg)).toBeCloseTo(designView.solarPPerKwh(neg), 9);
    });

    it('no panels, no figure (a station without its own panels, a run still in flight)', () => {
        expect(solarPPerKwh(res({ savingsGbp: 50, pvKwh: 0 }, { baseGbp: 0, split: { fromSolarGbp: 0 } }))).toBeNull();
        expect(solarPPerKwh(null)).toBeNull();
        expect(rowModel(entry, null).pPerKwh).toBeNull();
    });

    describe('on the engine’s run (demo March slice)', () => {
        let eng;
        beforeAll(() => {
            eng = new SolarEngine(sliceDemo('2026-03-01T00:00:00Z', 28), loadCatalog());
        });

        it('a battery that charges from the grid: Compare and Design give one number, below the whole saving ÷ kWh', () => {
            const sys = eng.autoScenarios().find(s => s.id === 'H3');
            expect(sys?.battery).toBeTruthy();
            const r = eng.runScenario(sys, { withBand: false });
            // the slice's H3 earns ~£9.6 charging in cheap slots (and loses ~£1.3 on standby)
            expect(r.battery.split.fromGridGbp + r.battery.split.standbyGbp).toBeGreaterThan(1);
            const row = rowModel({ sys, kind: 'auto' }, r);
            expect(row.pPerKwh).toBeCloseTo(designView.solarPPerKwh(r), 9);
            expect(row.pPerKwh).toBeLessThan((100 * r.headline.savingsGbp) / r.headline.pvKwh - 1);
        });
    });
});

/* ── orientation: the dark months ──────────────────────────────────────────── */

describe('orientation: months with little or no sun after 4pm', () => {
    it('darkMonthsPhrase words a darkMonths run', () => {
        expect(darkMonthsPhrase([10, 11, 0])).toBe('from November to January');
        expect(darkMonthsPhrase([11])).toBe('in December');
        expect(darkMonthsPhrase([])).toBe('');
        // the demo year's west wall: February is back to 13% at 4–7pm
        const west = [1, 13, 20, 25, 27, 28, 28, 26, 22, 9, 2, 0.4];
        expect(darkMonthsPhrase(darkMonths(west, 5))).toBe('from November to January');
    });

    describe('the answer card', () => {
        let dom, ui;
        beforeAll(async () => {
            dom = installFakeDom();
            ui = await import('../../../projects/solar-calculator/js/ui.js');
        });
        afterAll(() => dom.restore());

        const monthly = shares => shares.map((s, m) => ({ month0: m, pvAcKwh: 100, peakPvAcKwh: s, upsPvKwh: 0, peakUpsPvKwh: 0 }));
        function view(runs) {
            const v = Object.create(orientationView);
            const parts = { answer: document.createElement('div'), side: document.createElement('div'), heroFoot: document.createElement('div') };
            const best = { az: 200, tilt: 40, kwh: 1061, gbp: 172, pPerKwh: 16.2, peakSharePct: 6 };
            const w90 = { az: 270, tilt: 90, kwh: 573, gbp: 122, pPerKwh: 21.3, peakSharePct: 24 };
            Object.assign(v, {
                ctx: { ui, fmt: ui.fmt, store: { get: () => ({ settings: {} }) }, data: { verdictIfReady: () => null } },
                v: { parts }, sweep: { cells: [] }, runs: new Map(runs), runKey: 'k', flips: null,
                sel: { id: 'S01', partial: false, station: false, arrayId: '*', battery: null, tg: { index: -1, station: false }, sys: { arrays: [] } },
                answer: () => ({ best, w90, s35: null, current: null, tie: null, tieBandPct: 3, westPays: false, flips: null, checked: [], source: 'sweep' }),
            });
            v.fillAnswer();
            return parts.answer.textContent.replace(/\s+/g, ' ');
        }

        it('names the months the west-wall run is dark (November to January on the demo year), not a fixed November to February', () => {
            const text = view([['W90', { typical: { monthly: monthly([1, 13, 20, 25, 27, 28, 28, 26, 22, 9, 2, 0.4]) } }]]);
            expect(text).toContain('There’s little or no sun after 4pm from November to January.');
            expect(text).not.toContain('February');
        });

        it('follows the data when February is dark too', () => {
            const text = view([['W90', { typical: { monthly: monthly([1, 3, 20, 25, 27, 28, 28, 26, 22, 9, 2, 0.4]) } }]]);
            expect(text).toContain('from November to February.');
        });

        it('says nothing about the season until the west-wall run is in (loadFlips redraws the card after it)', () => {
            const text = view([]);
            expect(text).toContain('No — face them');
            expect(text).not.toContain('after 4pm');
        });
    });
});

/* ── CSS ───────────────────────────────────────────────────────────────────── */

describe('compare and orientation CSS', () => {
    const rule = (css, sel) => {
        const at = css.indexOf(`${sel} {`);
        return at < 0 ? null : css.slice(at, css.indexOf('}', at) + 1);
    };

    it('the phone card layout drops the name column’s 190 px floor (it ran under the range strip at 360 px)', () => {
        const css = src('compare.js');
        const phone = css.slice(css.indexOf('@media (max-width: 600px) {'));
        expect(rule(css, '.cv-board th.c-name')).toContain('min-width: 190px');
        expect(rule(phone, '.cv-board th.c-name')).toContain('min-width: 0');
    });

    it('no text is coloured --faint (3.3:1): help text, scale labels, ranks and the pick tag use --muted', () => {
        const cmp = src('compare.js'), ori = src('orientation.js');
        for (const [css, sel] of [[cmp, '.cv-sbs tbody th .cv-sbs-help'], [cmp, '.cv-scale'], [ori, '.ov-top-rank'], [ori, '.ov-pick-tag']]) {
            const r = rule(css, sel);
            expect(r, sel).toContain('color: var(--muted)');
            expect(r, sel).not.toContain('--faint');
        }
    });
});
