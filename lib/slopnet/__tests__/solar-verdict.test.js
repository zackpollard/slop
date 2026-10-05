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
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SolarEngine } from '../../../projects/solar-calculator/js/core.js';
import { buildVerdict, dominance, breakEvenW, confidenceFor, sunshineRank, STAGES, applyPriceOverride, pickRunnerUp, storageLife, stationVerdict } from '../../../projects/solar-calculator/js/verdict.js';
import { createDispatcher } from '../../../projects/solar-calculator/js/worker.js';
import { installFakeDom } from './solar-fake-dom.js';
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
/** A stage may be reported more than once (an early answer inside the next one): the distinct run. */
const distinct = (stages) => stages.filter((s, i) => s !== stages[i - 1]);

beforeAll(async () => {
    let t = performance.now();
    scenarios = engine.autoScenarios();
    timings.autoScenariosMs = performance.now() - t;
    t = performance.now();
    const t0 = t;
    V = await buildVerdict(engine, {
        scenarios, nowMs: NOW,
        onPartial: (stage, p) => {
            // ms from the start to the first report of each stage
            timings[`at_${stage}_ms`] ??= Math.round(performance.now() - t0);
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
        // a stage can be re-reported with an early answer, but the order never goes back
        expect(distinct(partials.map((p) => p[0]))).toEqual([...STAGES]);
        const idx = partials.map(([s]) => STAGES.indexOf(s));
        for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThanOrEqual(idx[i - 1]);
        for (const [stage, p] of partials) {
            expect(p.stage).toBe(stage);
            expect(JSON.parse(JSON.stringify(p))).toEqual(p);
        }
        const [, usage] = partials[0];
        expect(usage.ranked.every((r) => r.route === 'reference')).toBe(true);
        expect(usage.usage.baseLoadW).toBeGreaterThan(0);
        const [, plugin] = partials[1];
        expect(plugin.ranked.every((r) => !r.battery && ['plugin', 'hardwired', 'reference'].includes(r.route))).toBe(true);
        expect(partials.filter(([, p]) => p.done)).toHaveLength(1);
        expect(partials[partials.length - 1][1].done).toBe(true);
        expect(JSON.stringify(partials[partials.length - 1][1])).toBe(JSON.stringify(V));
    });

    it('answers the headline question (west vs south) straight after the best buy, before any battery is run', () => {
        // perf finding: Q1 used to wait for every weather band; it needs only the best buy
        const early = partials.find(([, p]) => p.answers.orientation);
        expect(early[0]).toBe('plugin');
        const o = early[1].answers.orientation;
        expect(o.status).toBe('ready');
        expect(o.forId).toBe(V.bestBuyId);
        expect(o.checksPending).toBe(true);           // "this changes if…" comes with the other answers
        expect(o.checked).toEqual([]);
        expect(early[1].ranked.some((r) => r.battery)).toBe(false);
        // the same direction as the finished answer, which adds the checks
        expect(o.summary).toBe(V.answers.orientation.summary);
        expect(o.best).toEqual(V.answers.orientation.best);
        expect(V.answers.orientation.checksPending).toBe(false);
        expect(V.answers.orientation.checked.length).toBeGreaterThan(0);
    });

    it('the card\'s options get their weather band (and "How sure" its tornado) before the rest of the table', () => {
        const mid = partials.find(([s, p]) => s === 'all' && p.answers.confidence);
        expect(mid).toBeTruthy();
        const p = mid[1];
        expect(p.answers.confidence.status).toBe('ready');
        expect(p.tornado.id).toBe(V.bestBuyId);
        for (const id of [V.bestBuyId, V.runnerUpId, V.stepUp?.id].filter(Boolean)) expect(finite(row(id, p).savings.p10), id).toBe(true);
        expect(p.ranked.some((r) => r.legal !== 'reference' && r.savings.p10 == null)).toBe(true);
        expect(JSON.stringify(p.tornado)).toBe(JSON.stringify(V.tornado));
    });

    it('the best buy never flips once shown, and its typical-year saving never changes basis', () => {
        const shown = partials.slice(1).map(([, p]) => p);
        for (const p of shown) {
            expect(p.bestBuyId).toBe(V.bestBuyId);
            expect(row(V.bestBuyId, p).savings.typical).toBe(row(V.bestBuyId).savings.typical);
        }
        // the weather band arrives after the storage rows, not before
        const first = (stage) => partials.find(([s]) => s === stage)[1];
        expect(row(V.bestBuyId, first('plugin')).savings.p10).toBeNull();
        expect(row(V.bestBuyId, first('all')).savings.p10).toBeNull();
        expect(row(V.bestBuyId, first('bands')).savings.p10).toBeLessThanOrEqual(row(V.bestBuyId).savings.typical);
        expect(row(V.bestBuyId).savings.p90).toBeGreaterThanOrEqual(row(V.bestBuyId).savings.p10);
    });

    it('meets the time budget: best buy fast, full verdict well inside 20 s (2× slack for parallel tests)', () => {
        expect(timings.at_plugin_ms).toBeLessThan(6000 * 2);
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
        // never an option the same page lists as beaten on both price and savings (D2 finding:
        // 'Close second: Solarfy Duo' was beaten by the best buy itself)
        for (const [, p] of partials) if (p.runnerUpId) expect(row(p.runnerUpId, p).dominatedBy, p.stage).toBeNull();
        expect(ru.dominatedBy).toBeNull();
        if (ru.capexGbp < best.capexGbp) expect(V.headline.runnerUp).toMatch(/^Spending less\? /);
        else {
            expect(ru.npv10Gbp).toBeGreaterThanOrEqual(best.npv10Gbp - 25);
            expect(V.headline.runnerUp).toMatch(/^Close second: /);
        }
        expect(V.headline.runnerUp).toContain(ru.name);
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
        expect(u.summary).toMatch(/^A power station (running|for) your servers /);
    });

    it('power station: graded on its 10-year value and its life, not payback alone (D2 finding)', () => {
        const u = V.answers.ups;
        const U = row(u.bestId);
        expect(u.verdict).toBe(stationVerdict(U));
        expect(u.npv10Gbp).toBe(U.npv10Gbp);
        expect(u.net10Gbp).toBe(U.net10Gbp);
        expect(u.endYear).toBe(U.batteryEndYear);
        expect(u.wearsOutEarly).toBe(storageLife(U).early);
        // the summary says what the grade is
        if (u.verdict === 'doesNotPay' && finite(U.payback.typical)) expect(u.summary).toMatch(/isn’t worth it on your data/);
        if (u.verdict === 'marginal') expect(u.summary).toMatch(/only \*\*breaks even\*\*/);
        if (u.wearsOutEarly) expect(u.summary + u.body.join(' ')).toContain(`year ${U.batteryEndYear}`);
        // the station with its own panels: an early end (and what it leaves after 10 years) is said
        const W = row(u.withPanels.id);
        expect(u.withPanels).toMatchObject({ npv10Gbp: W.npv10Gbp, net10Gbp: W.net10Gbp, endYear: W.batteryEndYear, verdict: stationVerdict(W) });
        const line = u.body.find((l) => l.startsWith('With '));
        if (storageLife(W).early) {
            expect(line).toContain(`wears out in year ${W.batteryEndYear}`);
            expect(line).toMatch(/after 10 years you’re .+ in today’s money/);
        }
        // Q4 says the same about the same station
        const g = V.answers.growth;
        const gl = g.body.find((l) => l.startsWith('A power station with its own panels'));
        expect(g.station.wearsOutEarly).toBe(storageLife(row(g.station.id)).early);
        if (g.station.wearsOutEarly) expect(gl).toContain(`wears out in year ${row(g.station.id).batteryEndYear}`);
    });

    it('every storage row carries the year it wears out, from its own cash flow', () => {
        const withBatt = V.ranked.filter((r) => r.battery);
        expect(withBatt.length).toBeGreaterThan(5);
        for (const r of withBatt.slice(0, 6)) {
            const res = engine.runScenario(scenarios.find((s) => s.id === r.id), { withBand: false });
            expect(r.batteryEndYear, r.id).toBe(res.finance.batteryEndYear);
            expect(r.batteryReplaced).toBe(false);   // default: no new battery when it wears out
        }
        for (const r of V.ranked.filter((x) => !x.battery)) expect(r.batteryEndYear).toBeNull();
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
        // stop three options into 'all' (after the early west-vs-south answer is re-reported as 'plugin')
        const p = buildVerdict(spy, { scenarios, nowMs: NOW, onPartial: (st, v) => { stages.push(st); if (st === 'plugin' && v.answers.orientation) stop = runs + 3; },
            isCancelled: () => runs >= stop });
        await expect(p).rejects.toMatchObject({ name: 'AbortError' });
        expect(distinct(stages)).toEqual(['usage', 'plugin']); // stopped inside 'all', not at its end
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

describe('runner-up and power-station grading (D2 findings)', () => {
    const r = (id, capexGbp, typical, pb, npv10Gbp, o = {}) => ({ id, capexGbp, savings: { typical }, payback: { typical: pb }, npv10Gbp, dominatedBy: null, ...o });

    it('pickRunnerUp: never a beaten row; "Spending less?" the next cheaper one by NPV when nothing is close', () => {
        // the demo at 500 W as the journey found it: the only option within a year of the best
        // buy's payback is not on sale, so the old fallback took the next row by NPV — Solarfy,
        // which the best buy beats on both price and savings
        const best = r('S05', 468, 172, 2.66, 1044);
        const solarfy = r('L-solarfy-duo-910', 599, 153, 3.79, 742, { dominatedBy: 'S05' });
        const octopus = r('S01', 650, 152, 4.13, 684, { dominatedBy: 'S05' });
        const s06 = r('S06', 336, 77, 4.2, 342);
        expect(pickRunnerUp(best, [best, solarfy, octopus, s06]).id).toBe('S06');
        // a cheaper option paying back within a year wins, cheapest first
        const s07 = r('S07', 400, 150, 2.7, 950);
        const s08 = r('S08', 380, 125, 3.1, 700);
        expect(pickRunnerUp(best, [best, s06, s07, s08]).id).toBe('S08');
        // a dearer option counts only when it is worth as much (NPV within £25: 'Close second')
        const tied = r('T', 520, 185, 2.9, 1030);
        expect(pickRunnerUp(best, [best, tied]).id).toBe('T');
        expect(pickRunnerUp(best, [best, r('D', 520, 180, 2.9, 1000)])).toBeNull();
        // nothing else eligible, or no best buy: none
        expect(pickRunnerUp(best, [best, solarfy])).toBeNull();
        expect(pickRunnerUp(null, [s06])).toBeNull();
    });

    it('storageLife and stationVerdict: wear-out inside 10 years, graded on the 10-year value', () => {
        expect(storageLife({ battery: { coupling: 'ups' }, batteryEndYear: 5 })).toEqual({ endYear: 5, early: true, replaced: false });
        expect(storageLife({ battery: { coupling: 'ups' }, batteryEndYear: 10 })).toMatchObject({ early: false });
        expect(storageLife({ battery: { coupling: 'dc' }, batteryEndYear: 7, batteryReplaced: true })).toMatchObject({ early: false, replaced: true });
        expect(storageLife({ battery: null, batteryEndYear: null })).toMatchObject({ endYear: null, early: false });
        // the finding's two stations: one breaks even (npv10 £0.14), one is £88 behind
        expect(stationVerdict({ payback: { typical: 4.4 }, npv10Gbp: 0.14 })).toBe('marginal');
        expect(stationVerdict({ payback: { typical: 7.51 }, npv10Gbp: -88.39 })).toBe('doesNotPay');
        expect(stationVerdict({ payback: { typical: 4.7 }, npv10Gbp: 64 })).toBe('pays');
        expect(stationVerdict({ payback: { typical: null }, npv10Gbp: 50 })).toBe('doesNotPay');
    });

    it('a station that pays back just before it wears out is "not worth it", with the year and the 10-year loss', async () => {
        // the shape of the finding (pays back in 7.5 yrs, worn out in year 8, £88 behind), built from
        // whichever server-only station wears out first on the demo, priced so its 10-year value is
        // clearly negative while it still pays back
        const stations = scenarios.filter((s) => s.route === 'ups' && !(s.battery?.ups?.pvArrays?.length) && !/^[WC]/.test(s.id));
        const runs = stations.map((s) => ({ s, res: engine.runScenario(s, { withBand: false }) }))
            .filter(({ res }) => finite(res.finance.batteryEndYear) && res.finance.batteryEndYear < 10 && res.headline.savingsGbp > 50);
        expect(runs.length).toBeGreaterThan(0);
        const { s, res } = runs.sort((a, b) => b.res.headline.savingsGbp - a.res.headline.savingsGbp)[0];
        const hd = res.headline;
        const gap = hd.net10Gbp - hd.npv10Gbp;          // the discounting: how far below plain pounds
        expect(gap).toBeGreaterThan(60);
        const deficit = Math.min(80, gap / 2);           // npv10 = −deficit, net10 = gap − deficit > 0
        const price = hd.capexGbp + hd.npv10Gbp + deficit;
        const few = scenarios.filter((x) => ['S05', 'S06', 'R0', 'R1'].includes(x.id));
        const v = await buildVerdict(engine, { scenarios: [...few, s], nowMs: NOW, overrides: { [s.id]: { priceGbp: price } } });
        const u = v.answers.ups;
        const U = v.ranked.find((x) => x.id === s.id);
        expect(u.bestId).toBe(s.id);
        expect(U.npv10Gbp).toBeCloseTo(-deficit, 0);
        expect(finite(U.payback.typical)).toBe(true);
        expect(U.payback.typical).toBeLessThanOrEqual(U.batteryEndYear);
        expect(u.verdict).toBe('doesNotPay');
        expect(u.wearsOutEarly).toBe(true);
        const end = U.batteryEndYear;
        expect(u.summary).toBe(`A power station for your servers isn’t worth it on your data: it saves £${Math.round(U.savings.typical)}/yr but wears out in year ${end}, **£${Math.round(deficit)} behind** after 10 years in today’s money.`);
        expect(u.body[1]).toMatch(new RegExp(`^Its battery is worn out by year ${end} \\(about [\\d,]+ full cycles a year\\), so the saving stops then: after 10 years you’re £[\\d,]+ ahead in plain pounds but £${Math.round(deficit)} behind in today’s money\\.$`));
        // and the table row says why its 10-yr value is low
        expect(U.batteryEndYear).toBeLessThan(10);
    }, 90000);
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
        expect(distinct(stages)).toEqual([...STAGES]);
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

/* ── the Verdict and Usage views on the real demo verdict (fake DOM, stub charts) ── */

describe('verdict view: reading order, focus across streamed stages, phone cards (D2 findings)', () => {
    let dom, ui, verdictView, usageView;
    beforeAll(async () => {
        dom = installFakeDom();
        ui = await import('../../../projects/solar-calculator/js/ui.js');
        verdictView = (await import('../../../projects/solar-calculator/js/views/verdict.js')).default;
        usageView = (await import('../../../projects/solar-calculator/js/views/usage.js')).default;
    });
    afterAll(() => dom.restore());

    const settle = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
    const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
    const stubCharts = () => {
        const kind = () => () => ({ update() {}, destroy() {}, setTable() {} });
        return { createLine: kind(), createBars: kind(), createHeatmap: kind(), createScatter: kind(), createTornado: kind(), createStackedArea: kind() };
    };
    const stubStore = () => {
        let s = { settings: {}, ui: { chartTables: {} }, scenarios: { saved: [] }, connection: {} };
        return { get: () => s, set(patch) { s = { ...s, ...patch, ui: { ...s.ui, ...(patch.ui ?? {}), chartTables: { ...s.ui.chartTables, ...(patch.ui?.chartTables ?? {}) } } }; } };
    };
    /** matchMedia whose answers the test sets; the view's 'change' listeners run on set(). */
    const media = () => {
        const list = {};
        const make = (q) => (list[q] ??= { media: q, matches: false, fns: new Set(), addEventListener(t, fn) { this.fns.add(fn); }, removeEventListener(t, fn) { this.fns.delete(fn); } });
        const width = (w) => { make('(max-width: 600px)').matches = w <= 600; make('(max-width: 1023px)').matches = w <= 1023; };
        return {
            make, width,
            set(w) { width(w); for (const m of Object.values(list)) for (const fn of [...m.fns]) fn({ matches: m.matches }); },
        };
    };
    async function mount(w = 1440) {
        const mm = media();
        mm.width(w);
        window.matchMedia = mm.make;
        const summary = { ...engine.summary, id: 'demo-test', source: 'octopus' };
        let feed = null;
        const ctx = {
            ui, fmt: ui.fmt, charts: stubCharts(), store: stubStore(), router: { go: vi.fn() },
            data: {
                on: () => () => {}, summary: () => summary, status: () => 'ready', insights: async () => engine.insights(),
                verdict: ({ onPartial } = {}) => { feed = onPartial; return new Promise(() => {}); },
            },
        };
        const el = document.body.appendChild(ui.h('div'));
        const view = Object.create(verdictView);
        view.mount(el, ctx);
        await settle();
        return { view, el, mm, feed: (i) => feed(partials[i][0], partials[i][1]) };
    }
    const blocks = (view) => view.v.grid.querySelectorAll('.vd-block').map((b) => /vd-b-(\w+)/.exec(b.className)[1]);

    it('the DOM is in the order on screen at every width (no CSS order), and a resize keeps focus', async () => {
        const { view, el, mm, feed } = await mount(1440);
        partials.forEach((_, i) => feed(i));
        expect(blocks(view)).toEqual(['tiles', 'best', 'questions', 'scatter', 'options', 'assume']);
        expect(view.v.grid.querySelectorAll('.vd-col')).toHaveLength(2);
        const link = view.v.parts.best.querySelector('[data-fk="best:details"]');
        link.focus();
        mm.set(800);
        expect(blocks(view)).toEqual(['tiles', 'best', 'options', 'questions', 'scatter', 'assume']);
        expect(view.v.grid.querySelectorAll('.vd-col')).toHaveLength(0);
        expect(document.activeElement).toBe(link);
        mm.set(375);
        // the critique's phone order: best buy → options → questions → tiles → chart
        expect(blocks(view)).toEqual(['best', 'options', 'questions', 'tiles', 'scatter', 'assume']);
        expect(document.activeElement.dataset.fk).toBe('best:details');
        mm.set(1440);
        expect(blocks(view)).toEqual(['tiles', 'best', 'questions', 'scatter', 'options', 'assume']);
        // the skeleton a reload shows is laid out the same way
        expect(view.skeletonPage().querySelectorAll('.vd-col')).toHaveLength(2);
        mm.width(375);
        expect(view.skeletonPage().querySelectorAll('.vd-col')).toHaveLength(0);
        el.remove();
    });

    it('keyboard focus survives every later stage on the best-buy card and in an open question', async () => {
        const { view, el, feed } = await mount(1440);
        const firstPlugin = partials.findIndex(([s]) => s === 'plugin');
        for (let i = 0; i <= firstPlugin; i++) feed(i);
        const details = view.v.parts.best.querySelector('[data-fk="best:details"]');
        expect(details).toBeTruthy();
        details.focus();
        const firstAll = partials.findIndex(([s]) => s === 'all');
        for (let i = firstPlugin + 1; i <= firstAll; i++) feed(i);
        expect(document.activeElement.dataset.fk).toBe('best:details');
        expect(document.activeElement.isConnected).toBe(true);
        // a link inside the open power-station question, as soon as it is there
        const q = view.v.parts.questions.ups;
        q.d.open = true;
        const qLink = q.link.querySelector('a');
        qLink.focus();
        for (let i = firstAll + 1; i < partials.length; i++) feed(i);
        expect(document.activeElement).toBe(qLink);          // not even rebuilt: nothing on it changed
        // and the card again, through the bands (confidence badge, weather range) to the end
        const before = view.v.parts.best.querySelector('[data-fk="best:details"]');
        before.focus();
        view.v.bestSig = null;                                // force a rebuild of the same card
        view.fillBest(V);
        expect(before.isConnected).toBe(false);
        expect(document.activeElement).not.toBe(before);
        expect(document.activeElement.dataset.fk).toBe('best:details');
        expect(document.activeElement.isConnected).toBe(true);
        // a control that is gone from the new card hands focus to the card's heading
        const ru = view.v.parts.best.querySelector('[data-fk="best:runner-up"]');
        ru.focus();
        view.fillBest({ ...V, runnerUpId: null, headline: { ...V.headline, runnerUp: null } });
        expect(document.activeElement.classList.contains('vd-best-title')).toBe(true);
        el.remove();
    });

    it('the card offers no runner-up the table lists as beaten; rows that wear out early say so', async () => {
        const { view, el, feed } = await mount(1440);
        partials.forEach((_, i) => feed(i));
        const card = text(view.v.parts.best);
        expect(card).toContain(V.headline.runnerUp.replace(/\*\*/g, ''));
        expect(row(V.runnerUpId).dominatedBy).toBeNull();
        const early = V.ranked.filter((r) => r.battery && finite(r.batteryEndYear) && r.batteryEndYear < 10 && !r.dominatedBy && ['ok', 'check'].includes(r.legal));
        expect(early.length).toBeGreaterThan(0);
        for (const r of early) expect(text(view.v.parts.optBody.querySelector(`tr[data-id="${r.id}"]`))).toContain(`wears out in year ${r.batteryEndYear}`);
        const lasting = V.ranked.find((r) => r.battery && finite(r.batteryEndYear) && r.batteryEndYear >= 10 && !r.dominatedBy && ['ok', 'check'].includes(r.legal));
        if (lasting) expect(text(view.v.parts.optBody.querySelector(`tr[data-id="${lasting.id}"]`))).not.toContain('wears out');
        el.remove();
    });

    it('phone cards label the saving "/yr" and show the 10-yr value the list is ordered by', async () => {
        const { view, el, feed } = await mount(375);
        partials.forEach((_, i) => feed(i));
        const tr = view.v.parts.optBody.querySelector('tbody[data-group="main"] tr[data-id]');
        expect(text(tr.querySelector('.m-primary'))).toMatch(/^Saves £[\d,]+\/yr/);
        const npv = tr.querySelectorAll('td').find((td) => td.dataset.label === '10-yr value');
        expect(npv.classList.contains('m-show')).toBe(true);
        expect(text(npv)).toMatch(/£[\d,]+/);
        el.remove();
    });

    it('Usage: £ per 100 W is last year\'s cost; the "switch off and save" figure is the Verdict\'s forward one', async () => {
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        const summary = { ...engine.summary, id: 'demo-test', source: 'octopus' };
        let ready = null;
        const listeners = new Map();
        const ctx = {
            ui, fmt: ui.fmt, charts: stubCharts(), store: stubStore(), router: { go: vi.fn() },
            data: { on: (evt, fn) => { listeners.set(evt, fn); return () => {}; }, summary: () => summary, status: () => 'ready', insights: async () => engine.insights(), verdictIfReady: () => ready },
        };
        const el = document.body.appendChild(ui.h('div'));
        const view = Object.create(usageView);
        view.mount(el, ctx);
        await settle(8);
        const rows = () => el.querySelectorAll('.uv-readout-row').map((r) => `${text(r.querySelector('dt'))} ${text(r.querySelector('dd'))}`);
        const billed = Math.round(engine.insights().baseLoad.gbpPer100W);
        expect(rows()).toContain(`Each 100 W cost you £${billed}/yr`);
        expect(rows().join(' ')).not.toMatch(/saves?\b/);
        ready = V;
        listeners.get('verdict')();
        expect(rows()).toContain(`Switch 100 W off and you’d save £${Math.round(V.usage.gbpPer100W)}/yr`);
        // the same figure as the Verdict's yardstick row (and Q6, and Compare)
        expect(Math.abs(row('R1').savings.typical - V.usage.gbpPer100W)).toBeLessThan(0.5);
        el.remove();
    });
});
