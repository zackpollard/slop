/*
 * solar-verdict — the Verdict (projects/solar-calculator/js/verdict.js) on the shipped demo year
 * (real London Agile prices and SARAH-3 sunshine, a seeded household with 500 W of servers).
 *
 * UX critique acceptance V1–V5, the progressive stages (CONTRACTS §15: usage → plugin → all →
 * bands → answers, best buy never flips, typical-year figures never switch basis), and the
 * acceptance of every answer the verdict gives: orientation, battery, power station, growth,
 * confidence + tornado, always-on load. The pure helpers (dominance, break-even, confidence
 * levels) are checked on hand-made inputs, and one test drives the real worker dispatcher.
 *
 * The whole file runs about four full verdicts on one shared engine (the engine caches runs, so
 * the second pass and the ×10-price pass reuse physics); budget < 60 s.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';
import { buildVerdict, dominance, breakEvenW, confidenceFor, sunshineRank, STAGES, applyPriceOverride } from '../../../projects/solar-calculator/js/verdict.js';
import { createDispatcher } from '../../../projects/solar-calculator/js/worker.js';
import { loadCatalog, loadDemo, NOW } from './fixtures/solar/b1-load.js';

const cat = loadCatalog();
const demo = loadDemo({ serverW: 500 });
const engine = new SolarEngine(demo, cat, { nowMs: NOW });
const timings = {};

let scenarios;
let V;               // the demo verdict
const partials = []; // [stage, partial] as streamed
const row = (id, v = V) => v.ranked.find((r) => r.id === id);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

beforeAll(async () => {
    let t = performance.now();
    scenarios = engine.autoScenarios();
    timings.autoScenariosMs = performance.now() - t;
    t = performance.now();
    let last = t;
    V = await buildVerdict(engine, {
        scenarios, nowMs: NOW,
        onPartial: (stage, p) => {
            const now = performance.now();
            timings[`stage_${stage}_ms`] = Math.round(now - last);
            last = now;
            partials.push([stage, p]);
        },
    });
    timings.verdictMs = performance.now() - t;
}, 120000);

describe('UX critique V1–V5 (demo, 500 W servers)', () => {
    it('V1: the best buy is a legal plug-in kit with no rule errors that pays back within 10 years', () => {
        expect(V.bestBuyId).toBeTruthy();
        const b = row(V.bestBuyId);
        expect(b.route).toBe('plugin');
        expect(b.legal).toBe('ok');
        expect(b.errors).toHaveLength(0);
        expect(b.payback.typical).toBeLessThanOrEqual(10);
        expect(b.availableNow).not.toBe(false);
        expect(b.badges.map((x) => x.key)).toContain('best');
        expect(V.headline.kind).toBe('buy');
        expect(V.headline.title).toBe(`Buy the ${b.name}.`);
    });

    it('V2: only future-rules rows may have rule errors, and they all come after every other row', () => {
        const firstWhatif = V.ranked.findIndex((r) => r.legal === 'whatif');
        expect(firstWhatif).toBeGreaterThan(0);
        V.ranked.forEach((r, i) => {
            if (r.legal !== 'whatif') {
                expect(r.errors).toHaveLength(0);
                expect(i).toBeLessThan(firstWhatif);
            } else expect(i).toBeGreaterThanOrEqual(firstWhatif);
        });
        // reference points are pinned after the ranked options and before the planning rows
        const firstRef = V.ranked.findIndex((r) => r.legal === 'reference');
        expect(V.ranked.slice(0, firstRef).every((r) => r.legal === 'ok' || r.legal === 'check')).toBe(true);
        expect(V.ranked.slice(firstRef, firstWhatif).every((r) => r.legal === 'reference')).toBe(true);
        expect(V.excluded).toEqual([]);
    });

    it('V3: "cut 100 W of always-on load" saves exactly the per-100 W yardstick (± £0.50)', () => {
        const r1 = row('R1');
        expect(r1).toBeTruthy();
        expect(Math.abs(r1.savings.typical - V.usage.gbpPer100W)).toBeLessThan(0.5);
        expect(r1.equivalentWattsCut).toBe(100);
        // the tiles stay on the as-billed basis (last 12 months)
        expect(V.usage.gbpPer100WBilled).toBeCloseTo(engine.insights().baseLoad.gbpPer100W, 6);
    });

    it('V4: running twice with the same inputs gives deep-equal JSON', async () => {
        const t = performance.now();
        const again = await buildVerdict(engine, { scenarios, nowMs: NOW });
        timings.secondRunMs = performance.now() - t;
        expect(JSON.stringify(again)).toBe(JSON.stringify(V));
    }, 60000);

    it('V5: with every catalog price ×10 nothing is recommended and the "nothing pays back" text is shown', async () => {
        const x10 = scenarios.map((s) => ({
            ...s,
            costs: s.costs.map((c) => ({ ...c, gbp: c.gbp * 10 })),
            upgrade: s.upgrade ? { ...s.upgrade, costs: s.upgrade.costs.map((c) => ({ ...c, gbp: c.gbp * 10 })) } : null,
        }));
        const t = performance.now();
        const v = await buildVerdict(engine, { scenarios: x10, nowMs: NOW });
        timings.x10Ms = performance.now() - t;
        expect(v.bestBuyId).toBeNull();
        expect(v.runnerUpId).toBeNull();
        expect(v.headline.kind).toBe('none');
        expect(v.headline.title).toBe('Nothing here pays back within 10 years on your data.');
        expect(v.headline.lede).toMatch(/Cutting 100 W of always-on load would save \*\*£\d+\*\*\/yr for nothing/);
        expect(v.ranked.some((r) => r.badges.some((b) => b.key === 'best'))).toBe(false);
        // with nothing to recommend, the answers talk about the option that comes closest
        expect(v.headline.closestId).toBeTruthy();
        expect(v.tornado.id).toBe(v.headline.closestId);
        expect(v.answers.confidence.forId).toBe(v.headline.closestId);
        expect(v.answers.confidence.summary).toMatch(/^How sure about the /);
        expect(v.answers.baseLoad.status).toBe('ready');
    }, 90000);
});

describe('progressive stages (CONTRACTS §15)', () => {
    it('streams usage → plugin → all → bands → answers, each a complete JSON-safe snapshot', () => {
        expect(partials.map((p) => p[0])).toEqual([...STAGES]);
        for (const [stage, p] of partials) {
            expect(p.stage).toBe(stage);
            expect(JSON.parse(JSON.stringify(p))).toEqual(p);
        }
        const [, usage] = partials[0];
        expect(usage.ranked.every((r) => r.route === 'reference')).toBe(true);
        expect(usage.usage.baseLoadW).toBeGreaterThan(0);
        const [, plugin] = partials[1];
        expect(plugin.ranked.every((r) => !r.battery && ['plugin', 'hardwired', 'reference'].includes(r.route))).toBe(true);
        expect(partials[partials.length - 1][1].done).toBe(true);
        expect(JSON.stringify(partials[partials.length - 1][1])).toBe(JSON.stringify(V));
    });

    it('the best buy never flips once shown, and its typical-year saving never changes basis', () => {
        const shown = partials.slice(1).map(([, p]) => p);
        for (const p of shown) {
            expect(p.bestBuyId).toBe(V.bestBuyId);
            expect(row(V.bestBuyId, p).savings.typical).toBe(row(V.bestBuyId).savings.typical);
        }
        // the weather band arrives at 'bands', not before
        expect(row(V.bestBuyId, shown[0]).savings.p10).toBeNull();
        expect(row(V.bestBuyId, shown[2]).savings.p10).toBeLessThanOrEqual(row(V.bestBuyId).savings.typical);
        expect(row(V.bestBuyId).savings.p90).toBeGreaterThanOrEqual(row(V.bestBuyId).savings.p10);
    });

    it('meets the time budget: best buy fast, full verdict well inside 20 s (2× slack for parallel tests)', () => {
        expect(timings.stage_usage_ms + timings.stage_plugin_ms).toBeLessThan(6000 * 2);
        expect(timings.verdictMs).toBeLessThan(20000 * 2);
    });
});

describe('ranking, dominance, badges, best-buy card', () => {
    it('ranks legal options by 10-year NPV and keeps the best-buy rules', () => {
        const main = V.ranked.filter((r) => r.legal === 'ok' || r.legal === 'check');
        for (let i = 1; i < main.length; i++) expect(main[i - 1].npv10Gbp).toBeGreaterThanOrEqual(main[i].npv10Gbp - 1e-9);
        const best = row(V.bestBuyId);
        // nothing storage-free and eligible beats it by more than the £25 tie band
        const eligible = main.filter((r) => r.legal === 'ok' && !r.battery && ['plugin', 'hardwired'].includes(r.route)
            && r.availableNow !== false && finite(r.payback.typical) && r.payback.typical <= 10);
        for (const r of eligible) expect(r.npv10Gbp).toBeLessThanOrEqual(best.npv10Gbp + 25);
        // the not-on-sale kit is ranked but never recommended
        expect(eligible.every((r) => r.availableNow !== false)).toBe(true);
    });

    it('runner-up and step-up follow the critique rules', () => {
        const best = row(V.bestBuyId);
        const ru = row(V.runnerUpId);
        expect(ru).toBeTruthy();
        expect(ru.id).not.toBe(best.id);
        if (V.stepUp) {
            const s = row(V.stepUp.id);
            expect(s.npv10Gbp).toBeGreaterThan(best.npv10Gbp + 25);
            expect(V.stepUp.deltaCapexGbp).toBeCloseTo(s.capexGbp - best.capexGbp, 9);
            expect(V.stepUp.deltaSavingsGbp).toBeCloseTo(s.savings.typical - best.savings.typical, 9);
            expect(V.stepUp.incrementalPaybackYears).toBeCloseTo(V.stepUp.deltaCapexGbp / V.stepUp.deltaSavingsGbp, 9);
            expect(s.badges.map((b) => b.key)).toContain('most');
            expect(V.headline.stepUp).toMatch(/^Going bigger\?/);
        }
    });

    it('dominance: never by itself, a future-rules plan or a reference point; the dominator really is cheaper-and-better', () => {
        for (const r of V.ranked) {
            if (!r.dominatedBy) continue;
            expect(r.dominatedBy).not.toBe(r.id);
            const t = row(r.dominatedBy);
            expect(['ok', 'check']).toContain(t.legal);
            expect(['ok', 'check']).toContain(r.legal);
            expect(t.capexGbp).toBeLessThanOrEqual(r.capexGbp + 1e-6);
            expect(t.savings.typical).toBeGreaterThanOrEqual(r.savings.typical - 1e-6);
        }
        expect(row(V.bestBuyId).dominatedBy).toBeNull();
        expect(V.ranked.filter((r) => r.legal === 'whatif' || r.legal === 'reference').every((r) => r.dominatedBy === null)).toBe(true);
        expect(V.counts.dominated).toBe(V.ranked.filter((r) => r.dominatedBy).length);
    });

    it('equivalent watts and the why line follow the formulas', () => {
        const b = row(V.bestBuyId);
        expect(b.equivalentWattsCut).toBe(Math.round(b.savings.typical / (V.usage.gbpPer100W / 100) / 10) * 10);
        expect(V.headline.equivalent).toContain(`${b.equivalentWattsCut} W`);
        if (b.selfUsePct >= 95) expect(V.headline.why).toMatch(/^Your always-on load uses \d+% of what it makes/);
        expect(V.headline.lede).toMatch(/would save about \*\*£\d+\/yr\*\* in a typical year \(£\d+–£\d+ depending on the weather\) and pay for itself in \*\*[\d.]+ years?\*\*/);
        // last 12 months were sunnier than every year 2006–2025 on demo: actual ≥ p90
        expect(b.savings.actual).toBeGreaterThanOrEqual(b.savings.p90);
        expect(V.headline.weatherNote).toMatch(/sunnier than every one of the last 20 years \(\+12% vs average\)/);
    });

    it('next steps for a plug-in kit: RCD check, mounting, registration, >960 W check', () => {
        const b = row(V.bestBuyId);
        const steps = V.headline.nextSteps.map((s) => s.text);
        expect(steps[0]).toMatch(/RCD\/RCBO/);
        expect(steps.some((s) => /^Mount the panels facing [NESW]{1,3} at \d+°/.test(s))).toBe(true);
        expect(steps.some((s) => /myplugin\.solar/.test(s))).toBe(true);
        expect(steps.some((s) => /960 W/.test(s))).toBe(b.panels.wp > 960);
        expect(V.headline.nextSteps.find((s) => /myplugin/.test(s.text)).href).toBe('https://myplugin.solar/');
    });

    it('the going-bigger line and staged plans speak in plain pounds, like the card', () => {
        if (V.stepUp) {
            const b = row(V.bestBuyId);
            const s = row(V.stepUp.id);
            expect(V.stepUp.deltaNet10Gbp).toBeCloseTo(s.net10Gbp - b.net10Gbp, 9);
            expect(V.headline.stepUp).toContain(`£${Math.round(V.stepUp.deltaNet10Gbp).toLocaleString('en-GB')} further ahead after 10 years`);
        }
        // a staged plan's later purchase is carried separately from the up-front cost
        const w2 = row('W2');
        expect(w2.upgrade.atYear).toBeGreaterThan(0);
        expect(w2.upgrade.costGbp).toBeGreaterThan(0);
        expect(w2.capexGbp).toBeCloseTo(row('S01').capexGbp, 9);
    });

    it('the cash-flow strip starts at −capex and crosses zero at the payback year', () => {
        const b = row(V.bestBuyId);
        const cf = V.headline.cashflow;
        expect(cf.cumulativeGbp[0]).toBeCloseTo(-b.capexGbp, 6);
        const cross = cf.cumulativeGbp.findIndex((v) => v >= 0);
        expect(cross).toBe(Math.ceil(b.payback.typical));
        expect(cf.p10.length).toBe(cf.cumulativeGbp.length);
    });

    it('context line and usage tiles carry the critique fields', () => {
        expect(V.context.line).toMatch(/^365 days of your half-hourly use \(1 Oct 2025 – 30 Sep 2026\) · E-1R-AGILE-.+ · typical-year sunshine for /);
        expect(V.context.firstYear.label).toBe('Nov 2026 – Oct 2027');
        expect(V.context.coveragePct).toBeGreaterThan(95);
        for (const k of ['baseLoadW', 'baseLoadKwhYr', 'baseLoadSharePct', 'baseLoadCostGbp', 'baseLoadPeakCostGbp', 'gbpPer100W', 'peakKwhPerDay', 'energyCostGbp', 'standingGbp']) {
            expect(finite(V.usage[k])).toBe(true);
        }
        expect(V.usage.baseLoadCostGbp).toBeCloseTo(V.usage.gbpPer100WBilled * V.usage.baseLoadW / 100, 6);
    });
});

describe('answers acceptance (demo)', () => {
    it('orientation: south-ish wins, west earns more per kWh but less in total; tie band holds the best', () => {
        const o = V.answers.orientation;
        expect(o.status).toBe('ready');
        expect(o.forId).toBe(V.bestBuyId);
        expect(o.westPays).toBe(false);
        expect(o.best.az).toBeGreaterThanOrEqual(170);
        expect(o.best.az).toBeLessThanOrEqual(235);
        expect(o.w90.pPerKwh).toBeGreaterThan(o.best.pPerKwh);
        expect(o.w90.peakSharePct).toBeGreaterThan(30);
        const ratio = o.w90.gbp / o.best.gbp;
        expect(ratio).toBeGreaterThan(0.6);
        expect(ratio).toBeLessThan(0.8);
        expect(o.tie.azMin).toBeLessThanOrEqual(o.best.az);
        expect(o.tie.azMax).toBeGreaterThanOrEqual(o.best.az);
        expect(o.tie.tiltMin).toBeLessThanOrEqual(o.best.tilt);
        expect(o.tie.tiltMax).toBeGreaterThanOrEqual(o.best.tilt);
        expect(o.summary).toBe(`No — face them ${o.compass}.`);
        expect(o.body[0]).toMatch(/On a west-facing wall they’d make [\d,]+ kWh\/yr instead of [\d,]+ \(\d+% less\)/);
        expect(o.body.join(' ')).toMatch(/is within 3% of the best — pick what fits/);
        expect(o.cells.length).toBeGreaterThan(100);
    });

    it('battery: split sums to the battery total, incremental payback and verdict follow the formulas', () => {
        const b = V.answers.battery;
        expect(b.status).toBe('ready');
        const B = row(b.bestId);
        const P = row(b.vsId);
        expect(B.battery).toBeTruthy();
        expect(B.battery.coupling).not.toBe('ups');
        expect(P.route).toBe('plugin');
        const { fromSolarGbp, fromGridGbp, standbyGbp } = b.split;
        expect(Math.abs(fromSolarGbp + fromGridGbp + standbyGbp - b.batteryTotalGbp)).toBeLessThan(0.01);
        expect(b.deltaCapexGbp).toBeCloseTo(B.capexGbp - P.capexGbp, 9);
        expect(b.deltaSavingsGbp).toBeCloseTo(B.savings.typical - P.savings.typical, 9);
        expect(b.incrementalPaybackYears).toBeCloseTo(b.deltaCapexGbp / b.deltaSavingsGbp, 9);
        expect(b.verdict).toBe(b.incrementalPaybackYears <= 7 ? 'pays' : b.incrementalPaybackYears <= b.lifeYears ? 'marginal' : 'doesNotPay');
        expect(b.thresholdGbp).toBeLessThanOrEqual(b.optimalGbp + 1);
        // battery money is on the row's own first-year basis: battery-less part + battery part = row
        expect(B.batteryValue.baseGbp + b.batteryTotalGbp).toBeCloseTo(B.savings.typical, 6);
        expect(b.gridPct + b.solarPct).toBeCloseTo(100, 9);
    });

    it('power station: realistic = the table figure; smart-plug ≤ realistic ≤ perfect; bypass-off costs more', () => {
        const u = V.answers.ups;
        expect(u.status).toBe('ready');
        const U = row(u.bestId);
        expect(U.route).toBe('ups');
        expect(U.panels).toBeNull();
        expect(u.realisticGbp).toBe(U.savings.typical);
        expect(u.peakCutGbp).toBeLessThanOrEqual(u.realisticGbp + 1e-9);
        expect(u.realisticGbp).toBeLessThanOrEqual(u.bestCaseGbp + 1e-9);
        expect(u.onlinePenaltyGbp).toBeLessThan(0);
        expect(row(u.withPanels.id).panels).toBeTruthy();
        expect(u.withPanels.gbp).toBe(row(u.withPanels.id).savings.typical);
        expect(u.summary).toMatch(/^A power station running your servers saves \*\*£\d+\/yr\*\*/);
    });

    it('growth: the biggest kit, a wired-in system alongside, the station with panels, the future-rules deltas', () => {
        const g = V.answers.growth;
        expect(g.status).toBe('ready');
        expect(g.maxWp).toBe(1030);
        expect(row(g.hardwired.id).route).toBe('hardwired');
        expect(row(g.hardwired.id).battery).toBeNull();
        expect(row(g.station.id).panels).toBeTruthy();
        expect(g.secondKit.addGbp).toBeCloseTo(row('W3').savings.typical - row(g.secondKit.baseId).savings.typical, 9);
        expect(row(g.secondKit.baseId).kitId).toBe(row('W3').kitId);
        expect(g.laterBattery.paybackYears).toBe(row('W2').payback.typical);
        expect(g.body).toHaveLength(4);
    });

    it('confidence: deterministic level; tornado sorted by swing, weather row = band paybacks, centre = ranked payback', () => {
        const c = V.answers.confidence;
        const b = row(V.bestBuyId);
        expect(c.status).toBe('ready');
        expect(c.level).toBe(b.confidence.level);
        expect(c.level).toBe(confidenceFor(b, { coveragePct: V.context.coveragePct, days: V.context.days }).level);
        expect(c.level).toBe('high');
        const t = V.tornado;
        expect(t.id).toBe(V.bestBuyId);
        expect(t.center).toBe(b.payback.typical);
        for (let i = 1; i < t.rows.length; i++) expect(t.rows[i - 1].swing).toBeGreaterThanOrEqual(t.rows[i].swing);
        const w = t.rows.find((x) => x.key === 'weather');
        if (w) {
            expect(w.low).toBeCloseTo(b.payback.p10, 9);
            expect(w.high).toBeCloseTo(b.payback.p90, 9);
        }
        expect(c.summary).toBe(`How sure: **High**. Weather alone moves it between £${Math.round(b.savings.p10)} and £${Math.round(b.savings.p90)} a year.`);
        expect(c.body[c.body.length - 1]).toMatch(/^Model accuracy: about ±2% a year/);
    });

    it('always-on load: plug-in savings never fall as load rises, exports vanish above 1 kW, break-even interpolates', () => {
        const a = V.answers.baseLoad;
        expect(a.status).toBe('ready');
        const plug = a.curves.find((c) => c.id === V.bestBuyId);
        expect(plug).toBeTruthy();
        for (let i = 1; i < plug.points.length; i++) expect(plug.points[i].savingsGbp).toBeGreaterThanOrEqual(plug.points[i - 1].savingsGbp - 1e-6);
        const xs = plug.points.map((p) => p.x);
        expect(xs).toContain(Math.round(V.usage.baseLoadW));
        for (const c of a.curves) expect(a.breakEvenW[c.id]).toBe(breakEvenW(c.points, 10));
        const at1k = plug.points.filter((p) => p.x >= 1000);
        expect(at1k.length).toBeGreaterThan(0);
        for (const p of at1k) expect(p.exportKwh).toBeLessThanOrEqual(0.01 * p.pvKwh + 1e-9);
        expect(a.summary).toMatch(/always-on load is why solar works for you|always-on load cuts the payback from|pays back whatever your always-on load|only just pays|doesn’t pay back/);
        // on demo the kit pays back even with no load: the answer says how much the load speeds it up
        expect(a.kind).toBe('speeds');
        const p0 = plug.points.find((p) => p.x === 0).paybackYears;
        expect(a.summary).toBe(`Your **${Math.round(V.usage.baseLoadW)} W** always-on load cuts the payback from ${p0.toFixed(1).replace(/\.0$/, '')} years to **${row(V.bestBuyId).payback.typical.toFixed(1).replace(/\.0$/, '')} years**.`);
        expect(a.curves.map((c) => c.id)).toEqual(expect.arrayContaining([V.answers.battery.bestId, V.answers.ups.bestId]));
    });
});

describe('your own prices, cancelling, power stations beside a kit (D1a)', () => {
    it('C1 (a kit plus a power station) is rated on the station\'s own losses: medium, never "we assume undefined W"', () => {
        const c1 = row('C1');
        expect(c1.confidence.model.level).toBe('medium');
        expect(c1.confidence.reasons.join(' ')).not.toMatch(/undefined/);
        // every battery figure is the engine's own (headline basis): no rescaling left
        for (const r of V.ranked.filter((x) => x.batteryValue)) {
            expect(r.batteryValue.scale).toBeUndefined();
            expect(r.batteryValue.baseGbp + r.batteryValue.totalGbp).toBeCloseTo(r.savings.typical, 6);
        }
    });
    it('overrides: the user\'s own price is used for that option (priceGbp or Compare\'s whole cost list), and marked', async () => {
        const s05 = scenarios.find((s) => s.id === 'S05');
        const costs = s05.costs.map((c) => ({ ...c, gbp: c.gbp + 100 }));
        const v = await buildVerdict(engine, { scenarios, nowMs: NOW, overrides: { S05: { priceGbp: 120 }, S01: { costs }, R1: { priceGbp: 5 }, nope: { priceGbp: 1 } } });
        const a = row('S05', v);
        expect(a.capexGbp).toBeCloseTo(120, 9);
        expect(a.priceOverride).toBe(true);
        expect(a.payback.typical).toBeCloseTo(row('S05').payback.typical * (120 / row('S05').capexGbp), 1);
        expect(row('S01', v).capexGbp).toBeCloseTo(costs.reduce((t, c) => t + c.gbp, 0), 9);
        expect(row('R1', v).capexGbp).toBe(0); // a yardstick has no price
        expect(row('R1', v).priceOverride).toBeUndefined();
        expect(v.context.priceOverrides.sort()).toEqual(['S01', 'S05']);
        expect(row('S05').priceOverride).toBeUndefined();
    }, 60000);
    it('isCancelled stops the build between options, mid-stage, with an AbortError', async () => {
        let runs = 0;
        let stop = Infinity;
        const spy = Object.create(engine);
        spy.runScenario = (...a) => { runs++; return engine.runScenario(...a); };
        const stages = [];
        const p = buildVerdict(spy, { scenarios, nowMs: NOW, onPartial: (st) => { stages.push(st); if (st === 'plugin') stop = runs + 3; },
            isCancelled: () => runs >= stop });
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        expect(stages).toEqual(['usage', 'plugin']); // stopped inside 'all', not at its end
        expect(runs).toBe(stop);
        await expect(buildVerdict(engine, { scenarios, isCancelled: () => true })).rejects.toMatchObject({ name: 'AbortError' });
    }, 60000);
    it('applyPriceOverride: proportional upfront lines to the penny, later lines untouched, bad input ignored', () => {
        const sys = { id: 'x', route: 'hardwired', costs: [{ label: 'Kit', gbp: 300, year: 0 }, { label: 'Electrician', gbp: 100, year: 0, kind: 'install' }, { label: 'Inverter', gbp: 150, year: 12 }] };
        const r = applyPriceOverride(sys, { priceGbp: 333.33 });
        expect(r.costs.filter((c) => !c.year).reduce((t, c) => t + c.gbp, 0)).toBeCloseTo(333.33, 9);
        expect(r.costs[1]).toMatchObject({ label: 'Electrician', kind: 'install', gbp: 83.33 });
        expect(r.costs[2]).toEqual(sys.costs[2]);
        expect(applyPriceOverride({ ...sys, costs: [] }, { priceGbp: 50 }).costs).toEqual([{ label: 'Your price', gbp: 50, year: 0, kind: 'hardware' }]);
        expect(applyPriceOverride({ id: 'r', route: 'reference', costs: [] }, { priceGbp: 5 })).toBeNull();
        for (const bad of [null, {}, { priceGbp: -1 }, { priceGbp: 'x' }, { costs: [{ gbp: -2 }] }, { costs: [] }]) expect(applyPriceOverride(sys, bad)).toBeNull();
        // an empty list never comes from Compare (it saves the list it edited): it must not make the build free
        expect(applyPriceOverride(sys, { costs: [], priceGbp: 400 }).costs.filter((c) => !c.year).reduce((t, c) => t + c.gbp, 0)).toBeCloseTo(400, 9);
    });
});

describe('pure helpers', () => {
    const mk = (id, capexGbp, typical, legal = 'ok', npv10Gbp = 10 * typical - capexGbp) => ({ id, legal, capexGbp, savings: { typical }, npv10Gbp, errors: [] });

    it('dominance: cheaper-and-better beats; ties and future-rules / reference rows never do', () => {
        const rows = [mk('a', 500, 170), mk('b', 650, 155), mk('c', 650, 155), mk('d', 400, 200, 'whatif'), mk('r', 0, 157, 'reference'), mk('e', 2000, 450), mk('f', 300, 60)];
        const d = dominance(rows);
        expect(d.get('b')).toBe('a');
        expect(d.get('c')).toBe('a');
        expect(d.has('a')).toBe(false);           // only the whatif row (ignored) beats it
        expect(d.has('e')).toBe(false);
        expect(d.has('f')).toBe(false);
        expect(d.has('d')).toBe(false);
        expect(d.has('r')).toBe(false);
        // identical rows don't beat each other
        expect(dominance([mk('x', 100, 50), mk('y', 100, 50)]).size).toBe(0);
        // a product that is not on sale can be beaten but never beats (as Compare): you can't step
        // down to it; the next best row on sale is named instead
        const off = { ...mk('off', 300, 200), availableNow: false };
        const d2 = dominance([off, mk('g', 400, 180), mk('h', 500, 150), { ...mk('off2', 900, 100), availableNow: false }]);
        expect(d2.has('g')).toBe(false);
        expect(d2.get('h')).toBe('g');
        expect(d2.get('off2')).toBe('g');
        expect(d2.has('off')).toBe(false);
    });
    it('verdict rows: nothing is beaten by an option that is not on sale', () => {
        const all = [...V.ranked, ...(V.excluded ?? [])];
        for (const r of all.filter((x) => x.dominatedBy)) expect(row(r.dominatedBy).availableNow, `${r.id} beaten by ${r.dominatedBy}`).not.toBe(false);
    });

    it('breakEvenW: 0 when it pays at the first point, interpolated on the payback rate, null when never', () => {
        expect(breakEvenW([{ x: 0, paybackYears: 6 }, { x: 500, paybackYears: 3 }], 10)).toBe(0);
        // rate 0 (never) at 0 W, 1/5 at 400 W → reaches 1/10 half-way
        expect(breakEvenW([{ x: 0, paybackYears: null }, { x: 400, paybackYears: 5 }], 10)).toBeCloseTo(200, 9);
        // 20 yrs → 5 yrs between 100 and 300 W: rates 0.05 → 0.2, 0.1 is a third of the way
        expect(breakEvenW([{ x: 300, paybackYears: 5 }, { x: 100, paybackYears: 20 }], 10)).toBeCloseTo(100 + 200 / 3, 9);
        expect(breakEvenW([{ x: 0, paybackYears: null }, { x: 1000, paybackYears: 14 }], 10)).toBeNull();
    });

    it('sunshineRank: says it the right way round, and qualifies partial years', () => {
        expect(sunshineRank({ pctVsAverage: 12, sunnierThanYears: 20, yearsCompared: 20 })).toBe('sunnier than every one of the last 20 years');
        expect(sunshineRank({ pctVsAverage: -9, sunnierThanYears: 0, yearsCompared: 20 })).toBe('duller than every one of the last 20 years');
        expect(sunshineRank({ pctVsAverage: -2, sunnierThanYears: 6, yearsCompared: 20 })).toBe('duller than 14 of the last 20 years');
        expect(sunshineRank({ pctVsAverage: 3, sunnierThanYears: 15, yearsCompared: 20 }, { sameMonths: true })).toBe('sunnier than the same months of 15 of the last 20 years');
        expect(sunshineRank({ pctVsAverage: null, sunnierThanYears: null, yearsCompared: 0 })).toBeNull();
    });

    it('confidenceFor: no 20-year record means the weather part is medium, with the reason', () => {
        const plug = { route: 'plugin', legal: 'ok', battery: null, panels: { shadingPct: 3 }, savings: { p10: null, p50: null, p90: null } };
        const c = confidenceFor(plug, { coveragePct: 99, days: 365, hasBand: false });
        expect(c.level).toBe('medium');
        expect(c.weather.reason).toMatch(/20-year sunshine record/);
        expect(c.weather.pending).toBeUndefined();
    });

    it('confidenceFor: the lowest of data, weather and model; notes never lower it', () => {
        const plug = { route: 'plugin', legal: 'ok', battery: null, panels: { shadingPct: 3, shadingExplicit: false }, savings: { p10: 95, p50: 100, p90: 105 } };
        const hi = confidenceFor(plug, { coveragePct: 99, days: 365 });
        expect(hi.level).toBe('high');
        expect(hi.notes).toContain('assumes 3% shading — a tree or wall can cost 10–30%');
        expect(confidenceFor(plug, { coveragePct: 85, days: 365 }).level).toBe('medium');
        expect(confidenceFor(plug, { coveragePct: 99, days: 200 }).level).toBe('medium');
        expect(confidenceFor(plug, { coveragePct: 60, days: 365 }).level).toBe('low');
        expect(confidenceFor({ ...plug, savings: { p10: 80, p50: 100, p90: 105 } }, { coveragePct: 99, days: 365 }).level).toBe('medium');
        expect(confidenceFor({ ...plug, savings: { p10: 60, p50: 100, p90: 105 } }, { coveragePct: 99, days: 365 }).level).toBe('low');
        expect(confidenceFor({ ...plug, battery: { coupling: 'dc' } }, { coveragePct: 99, days: 365 }).level).toBe('medium');
        expect(confidenceFor({ ...plug, battery: { coupling: 'ups' } }, { coveragePct: 99, days: 365, station: { fixedLossW: null, assumedP0W: 30 } }).model.reason)
            .toBe('this unit’s losses aren’t measured; we assume 30 W');
        expect(confidenceFor({ ...plug, route: 'whatif', legal: 'whatif' }, { coveragePct: 99, days: 365 }).level).toBe('low');
        expect(confidenceFor(plug, { coveragePct: 99, days: 365, products: [{ confidence: 'medium' }] }).level).toBe('high');
    });
});

describe('projected always-on load (Usage → "use today’s W")', () => {
    it('every figure and the always-on-load answer use the projection, not the measured load', async () => {
        const few = scenarios.filter((s) => ['S05', 'S06', 'R0', 'R1'].includes(s.id));
        engine.setProjectBaseW(300);
        try {
            const v = await buildVerdict(engine, { scenarios: few, nowMs: NOW });
            expect(v.context.projectBaseW).toBe(300);
            expect(v.context.line).toMatch(/· projected with 300 W always-on$/);
            const a = v.answers.baseLoad;
            expect(a.projectedBaseW).toBe(300);
            expect(a.userBaseW).toBe(300);
            expect(a.measuredBaseW).toBeCloseTo(V.usage.baseLoadW, 9);
            expect(a.summary).toMatch(/^Your \*\*300 W\*\* always-on load \(projected\)/);
            expect(a.body[0]).toMatch(/^Every figure uses the 300 W you chose for the forecast; your data shows 564 W/);
            // the curve's point at the projected load is the headline figure
            const s05 = v.ranked.find((r) => r.id === 'S05');
            const at = a.curves.find((c) => c.id === 'S05').points.find((p) => p.x === 300);
            expect(at.savingsGbp).toBeCloseTo(s05.savings.typical, 6);
            expect(a.body.join(' ')).not.toMatch(/564 W it takes/);
        } finally {
            engine.setProjectBaseW(null);
        }
    }, 90000);
});

describe('through the real worker dispatcher', () => {
    it('worker.verdict streams { stage, verdict } progress and returns the same shape', async () => {
        const msgs = [];
        const d = createDispatcher({ post: (m) => msgs.push(structuredClone(m)) });
        await d.handle({ type: 'call', id: 1, method: 'loadDataset', args: [{ kind: 'demo', serverW: 500 }] });
        expect(msgs.find((m) => m.id === 1 && m.type === 'result')).toBeTruthy();
        const few = scenarios.filter((s) => ['S05', 'S06', 'R0', 'R1'].includes(s.id));
        await d.handle({ type: 'call', id: 2, method: 'verdict', args: [{ scenarios: few, maxPaybackYears: 10, finance: { vatReturns: true } }] });
        const stages = msgs.filter((m) => m.id === 2 && m.type === 'progress').map((m) => m.value.stage);
        expect(stages).toEqual([...STAGES]);
        const res = msgs.find((m) => m.id === 2 && m.type === 'result');
        expect(res, JSON.stringify(msgs.find((m) => m.id === 2 && m.type === 'error'))).toBeTruthy();
        expect(res.value.ranked.map((r) => r.id).sort()).toEqual(['R0', 'R1', 'S05', 'S06']);
        expect(res.value.bestBuyId).toBe('S05');
        expect(res.value.answers.battery.status).toBe('none');
    }, 60000);

    it('reports timings', () => {
        console.log('verdict timings (ms):', Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])));
        expect(timings.verdictMs).toBeGreaterThan(0);
    });
});
