/*
 * verdict.js — the answer-first screen's data (CONTRACTS §15, UX critique "Verdict").
 *
 * buildVerdict(engine, opts) runs every option on the user's own data and turns the results into
 * one decision: what to buy, what it saves in a typical year, when it pays back, how sure that is,
 * and plain answers to the six questions the user actually has (west vs south, battery, power
 * station for the servers, growing later, confidence, always-on load).
 *
 * It runs in the worker (worker.js → methods.verdict) and streams partial verdicts through
 * onPartial(stage, verdict) after each stage, so the page can draw the best buy long before the
 * 20-year weather bands and the orientation sweeps are done:
 *   'usage'   context + usage (insights, the free 'cut 100 W' yardstick)
 *   'plugin'  every solar-only option (plug-in and wired-in panels, no storage) → the best buy
 *   'all'     batteries, power stations, combinations, future-rules plans → ranking, dominance,
 *             badges, the battery / power-station / growth answers
 *   'bands'   2006–2025 weather band per option → whiskers, payback range, confidence levels
 *   'answers' orientation (sweep + flips), payback tornado, always-on-load curve
 * Between options it yields to the event loop, so other engine calls and a cancel can get in.
 *
 * Money basis: every £/yr is the engine's first ownership year on the forward basis (install on
 * the 1st of next month, VAT 0% to 31 Mar 2027 then 5%, export never VAT'd). The usage tiles are
 * the last 12 months as billed; the per-100 W yardstick used against options is the forward one
 * (row R1), so "same as switching off N W" compares like with like (B1 note on V3).
 *
 * The best buy answers the solar question: the best eligible option WITHOUT storage. For an
 * always-on household the battery is a separate decision (UX critique battery amendment: the
 * servers already use almost all the solar), so batteries and power stations are answered as
 * add-ons — answers.battery / answers.ups — and, when one earns more over ten years, as the
 * card's "going bigger" line (stepUp). Only when no storage-free option pays back does the best
 * buy fall back to the best option of any kind.
 *
 * Copy strings may contain **…** around the figure that matters; views render it as emphasis
 * and other consumers can strip the asterisks.
 *
 * Pure module (worker-safe): no DOM, no fetch.
 */

import { findProduct, pluginKits } from './kits.js';
import { compass16 } from './sweep.js';

/** Stage names in the order onPartial reports them (CONTRACTS §15). */
export const STAGES = Object.freeze(['usage', 'plugin', 'all', 'bands', 'answers']);

/** "Within £25 of NPV → take the lower capex" (UX critique best-buy rule). */
const NPV_TIE_GBP = 25;
/** Battery answer: an incremental payback this short is a clear "pays". */
const BATTERY_PAYS_YEARS = 7;
/** Always-on-load grid (W) for the curves; the user's own and recent base load are added. One grid
 *  for every curve so they share an x axis (and a table) on the page. */
const CURVE_XS = [0, 150, 300, 450, 600, 800, 1000, 1500];
const PLUGIN_SHADE_FROM_W = 800;

const LINKS = {
    ips: 'https://assets.publishing.service.gov.uk/media/6a60a03c47af652afa0c89f5/plug-in-solar-final-_interim-product-specification.pdf',
    register: 'https://myplugin.solar/',
    si: 'https://www.legislation.gov.uk/uksi/2026/848/made',
    vat: 'https://www.gov.uk/guidance/vat-on-energy-saving-materials-and-heating-equipment-notice-7086',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MINUS = '−';

/* ── small pure helpers ─────────────────────────────────────────────────────── */

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const isAbort = (err) => err?.name === 'AbortError';

/** Plain JSON-safe copy (typed arrays → arrays, NaN/±Infinity → null). */
const plain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v, (k, x) => (ArrayBuffer.isView(x) ? Array.from(x) : x))));

function grouped(v, dp) {
    return Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
/** '£1,234' / '−£12' (a sign only when it survives rounding). */
function gbp(v, dp = 0) {
    if (!finite(v)) return '—';
    const neg = v < 0 && Math.round(Math.abs(v) * 10 ** dp) !== 0;
    return `${neg ? MINUS : ''}£${grouped(v, dp)}`;
}
const num = (v, dp = 0) => (finite(v) ? `${v < 0 && Math.round(Math.abs(v) * 10 ** dp) ? MINUS : ''}${grouped(v, dp)}` : '—');
const pct = (v) => (finite(v) ? `${Math.round(v)}%` : '—');
/** '2.7 years' / '1 year' / 'never'. */
function years(v, unit = 'years') {
    if (!finite(v) || v < 0) return 'never';
    const s = v.toFixed(1).replace(/\.0$/, '');
    return `${s} ${s === '1' ? unit.replace(/s$/, '') : unit}`;
}
const yrs = (v) => years(v, 'yrs');
/** '10 years' / '1 year' for a whole number of years. */
const nYears = (n) => `${num(n)} year${n === 1 ? '' : 's'}`;
const em = (s) => `**${s}**`;
/** 'YYYY-MM-DD' → '1 Oct 2025'. */
function day(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
}
const round10 = (v) => (finite(v) ? Math.round(v / 10) * 10 : null);
/**
 * How the last 12 months' sunshine ranks against the 2006–2025 years, said the right way round:
 * 'sunnier than every one of the last 20 years', 'duller than 15 of the last 20 years'. null when
 * there is no climatology to compare with.
 * @param {{ pctVsAverage: number|null, sunnierThanYears: number|null, yearsCompared: number }} wx
 */
export function sunshineRank(wx, { sameMonths = false } = {}) {
    const of = wx?.yearsCompared;
    const k = wx?.sunnierThanYears;
    if (!finite(of) || of <= 0 || !finite(k)) return null;
    const sunnier = finite(wx.pctVsAverage) ? wx.pctVsAverage >= 0 : k >= of / 2;
    const n = sunnier ? k : of - k;
    const word = sunnier ? 'sunnier' : 'duller';
    const months = sameMonths ? 'the same months of ' : '';
    if (n <= 0) return `about as sunny as ${months}the last ${of} years`;
    return n >= of ? `${word} than ${months}every one of the last ${of} years` : `${word} than ${months}${n} of the last ${of} years`;
}
const byNpv = (a, b) => (b.npv10Gbp - a.npv10Gbp) || (a.capexGbp - b.capexGbp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const LEVELS = ['low', 'medium', 'high'];
const minLevel = (...ls) => LEVELS[Math.min(...ls.map((l) => LEVELS.indexOf(l)).filter((i) => i >= 0))] ?? 'low';

/** Catalog products a system was built from (kit first). */
function productsOf(catalog, sys) {
    const ids = [sys.kitId, ...(sys.sourceIds ?? [])].filter((x, i, a) => typeof x === 'string' && a.indexOf(x) === i);
    return ids.map((id) => findProduct(catalog, id)).filter(Boolean);
}

/** The panels that decide where a system faces: grid-tied arrays first, else a power station's own. */
function panelsOf(sys) {
    const list = sys.arrays?.length ? sys.arrays : sys.battery?.ups?.pvArrays ?? [];
    if (!list.length) return null;
    const count = list.reduce((s, a) => s + a.count, 0);
    const wp = list.reduce((s, a) => s + a.count * a.wp, 0);
    const a = list[0];
    return { count, wp, azimuth: a.azimuth, tilt: a.tilt, compass: compass16(a.azimuth), mounting: a.mounting,
        shadingPct: a.shadingPct, shadingExplicit: !!a.shadingExplicit, sameWay: list.every((x) => x.azimuth === a.azimuth && x.tilt === a.tilt), station: !sys.arrays?.length };
}

/**
 * Dominance among comparable rows (UX critique Compare §2): s is beaten by t when t costs no more
 * and saves no less, one of them strictly. Future-rules plans, reference points and rows with
 * rule errors neither beat nor are beaten; a product that is not on sale (availableNow false) can
 * be beaten but never beats another — you can't step down to something you can't buy (as
 * Compare's markDominance). Returns id → id of the strongest row that beats it.
 * @param {Array<{ id: string, legal: string, capexGbp: number, savings: { typical: number }, npv10Gbp: number, errors?: any[], availableNow?: boolean|null }>} rows
 * @returns {Map<string, string>}
 */
export function dominance(rows) {
    const EPS = 1e-6;
    const pool = rows.filter((r) => (r.legal === 'ok' || r.legal === 'check') && !(r.errors?.length) && finite(r.capexGbp) && finite(r.savings?.typical));
    const out = new Map();
    for (const s of pool) {
        let best = null;
        for (const t of pool) {
            if (t === s || t.availableNow === false) continue;
            const cheaper = t.capexGbp < s.capexGbp - EPS;
            const saves = t.savings.typical > s.savings.typical + EPS;
            if (t.capexGbp <= s.capexGbp + EPS && t.savings.typical >= s.savings.typical - EPS && (cheaper || saves)) {
                if (!best || byNpv(t, best) < 0) best = t;
            }
        }
        if (best) out.set(s.id, best.id);
    }
    return out;
}

/**
 * Lowest always-on load (W) at which a curve pays back within `maxYears`, linearly interpolated on
 * the payback RATE (1/years; "never" = 0) so a never → pays crossing interpolates too. 0 when it
 * already pays at the first point; null when it never does.
 * @param {Array<{ x: number, paybackYears: number|null }>} points
 * @param {number} maxYears
 * @returns {number|null}
 */
export function breakEvenW(points, maxYears = 10) {
    const pts = (points ?? []).filter((p) => finite(p.x)).slice().sort((a, b) => a.x - b.x);
    const rate = (p) => (finite(p.paybackYears) && p.paybackYears > 0 ? 1 / p.paybackYears : finite(p.paybackYears) && p.paybackYears === 0 ? Infinity : 0);
    const want = 1 / maxYears;
    for (let i = 0; i < pts.length; i++) {
        const r = rate(pts[i]);
        if (r + 1e-12 < want) continue;
        if (i === 0) return pts[0].x;
        const r0 = rate(pts[i - 1]);
        if (!finite(r) || r === r0) return pts[i].x;
        const f = (want - r0) / (r - r0);
        return pts[i - 1].x + f * (pts[i].x - pts[i - 1].x);
    }
    return null;
}

/**
 * Confidence level of one option (UX critique "How sure"): the lowest of data, weather and model;
 * notes never lower it.
 * @param {Object} row ranked row (route, legal, battery, savings p10/p50/p90, panels)
 * @param {{ coveragePct: number, days: number, station?: Object|null, products?: Object[], batteryRange?: { threshold: number, optimal: number }|null,
 *   hasBand?: boolean }} ctx  hasBand false = the engine has no 2006–2025 years to build a weather range from
 * @returns {{ level: 'high'|'medium'|'low', data: Object, weather: Object, model: Object, reasons: string[], notes: string[] }}
 */
export function confidenceFor(row, { coveragePct = 100, days = 365, station = null, products = [], batteryRange = null, hasBand = true } = {}) {
    const cov = finite(coveragePct) ? coveragePct : 0;
    const data = cov >= 95 && days >= 330 ? { level: 'high', reason: null }
        : cov >= 80 && days >= 180 ? { level: 'medium', reason: days < 330 ? `only ${Math.round(days)} days of your data` : `${Math.round(100 - cov)}% of your half-hours are estimated` }
            : { level: 'low', reason: days < 180 ? `only ${Math.round(days)} days of your data` : `${Math.round(100 - cov)}% of your half-hours are estimated` };
    let weather;
    const s = row.savings ?? {};
    if (!row.panels) weather = { level: 'high', reason: null };
    else if (!hasBand) weather = { level: 'medium', reason: 'without a 20-year sunshine record for your home we can’t say how much the weather moves it' };
    else if (!finite(s.p10) || !finite(s.p90) || !finite(s.p50)) weather = { level: 'medium', reason: 'weather range not computed yet', pending: true };
    else {
        const spread = s.p50 > 0 ? (s.p90 - s.p10) / s.p50 : Infinity;
        weather = { level: spread <= 0.15 ? 'high' : spread <= 0.30 ? 'medium' : 'low', spread,
            reason: spread <= 0.15 ? null : `the weather alone moves it between ${gbp(s.p10)} and ${gbp(s.p90)} a year` };
    }
    let model;
    if (row.legal === 'whatif' || row.route === 'whatif') model = { level: 'low', reason: 'not legal today' };
    else if (row.route === 'reference') model = { level: 'high', reason: null };
    else if (row.battery?.coupling === 'ups') {
        model = station && station.fixedLossW == null
            ? { level: 'low', reason: `this unit’s losses aren’t measured; we assume ${num(station.assumedP0W)} W` }
            : { level: 'medium', reason: 'power-station losses vary from unit to unit' };
    } else if (row.battery) {
        model = { level: 'medium', reason: batteryRange && finite(batteryRange.threshold) && finite(batteryRange.optimal)
            ? `depends on how well it’s automated: ${gbp(batteryRange.threshold)} realistic vs ${gbp(batteryRange.optimal)} best case`
            : 'depends on how well the battery is automated' };
    } else model = { level: 'high', reason: null };
    const notes = [];
    if (row.panels && !row.panels.shadingExplicit && Math.abs((row.panels.shadingPct ?? 3) - 3) < 1e-9) notes.push('assumes 3% shading — a tree or wall can cost 10–30%');
    const secondary = products.some((p) => typeof p.confidence === 'string'
        && (/^medium\b/i.test(p.confidence) || /\b(medium|low|unknown) \((?=[^)]*(price|spec))/i.test(p.confidence)));
    if (secondary) notes.push('price/specs from a secondary source');
    const level = minLevel(data.level, weather.level, model.level);
    const reasons = [data, weather, model].filter((x) => x.level !== 'high' && x.reason).map((x) => x.reason);
    return { level, data, weather, model, reasons, notes };
}

/* ── row building ───────────────────────────────────────────────────────────── */

function rowOf(engine, sys, r, ctx) {
    const hd = r.headline;
    const fin = r.finance;
    const products = productsOf(engine.catalog, sys);
    const off = products.find((p) => p.onSale === false);
    const pre = products.find((p) => p.preorder);
    const panels = panelsOf(sys);
    const spot = sys.spotId ? (engine.spots ?? []).find((s) => s.id === sys.spotId) : null;
    if (panels && spot) { panels.spotId = spot.id; panels.spotName = spot.name; }
    const dates = products.map((p) => p.priceDate).filter(Boolean).sort();
    const ref = sys.route === 'reference';
    const row = {
        id: sys.id,
        name: sys.name,
        route: sys.route,
        featured: !!sys.featured,
        kitId: sys.kitId ?? null,
        legal: r.rules.legal,
        errors: r.rules.errors.map((e) => ({ code: e.code, message: e.message })),
        warnings: r.rules.warnings.filter((w) => w.code !== 'WHATIF').map((w) => ({ code: w.code, message: w.message })),
        banner: r.rules.banner ?? null,
        capexGbp: hd.capexGbp,
        savings: { typical: hd.savingsGbp, actual: hd.actualGbp, billed: hd.billedGbp, p10: hd.p10Gbp, p50: hd.p50Gbp, p90: hd.p90Gbp },
        payback: {
            typical: ref && !(hd.savingsGbp > 0) ? null : hd.paybackYears,
            p10: hd.paybackP10Years, p90: hd.paybackP90Years, discounted: fin.discountedPaybackYears ?? null,
        },
        npv10Gbp: hd.npv10Gbp,
        npv20Gbp: fin.npvGbp,
        net10Gbp: hd.net10Gbp,
        irr: fin.irr ?? null,
        selfUsePct: hd.selfUsePct,
        exportIncomeGbp: hd.exportIncomeGbp,
        exportKwh: hd.exportKwh,
        exportUnpaidKwh: hd.exportUnpaidKwh,
        exportKind: sys.export?.kind ?? 'none',
        pvKwh: hd.pvKwh,
        peakGenSharePct: hd.peakGenSharePct,
        peakGenShareAllPct: hd.peakGenShareAllPct ?? hd.peakGenSharePct,
        equivalentWattsCut: ctx.gbpPer100W > 0 ? round10(hd.savingsGbp / (ctx.gbpPer100W / 100)) : null,
        battery: sys.battery ? { coupling: sys.battery.coupling, capacityKwh: sys.battery.capacityKwh, strategy: sys.battery.strategy } : null,
        panels,
        // capexGbp is what you pay up front; a staged plan's later purchase is listed separately
        upgrade: sys.upgrade ? { atYear: sys.upgrade.atYear, label: sys.upgrade.label,
            costGbp: (sys.upgrade.costs ?? []).reduce((t, c) => t + (finite(c.gbp) ? c.gbp : 0), 0) } : null,
        availableNow: off ? false : products.some((p) => p.availableNow === true) ? true : null,
        availability: (off ?? pre)?.availability || (off ? 'not on sale right now' : null),
        preorder: !!pre,
        priceDate: dates[dates.length - 1] ?? null,
        notes: [...(sys.notes ?? [])],
        hasBand: !!r.band,
        confidence: null,
        badges: [],
        dominatedBy: null,
    };
    if (r.battery) {
        // the engine reports every battery figure on the headline's basis (finance year 1, the
        // battery's share aged): baseGbp + totalGbp is the row's own saving
        const bx = r.battery;
        row.batteryValue = {
            baseGbp: bx.baseGbp, totalGbp: bx.totalGbp,
            split: { fromSolarGbp: bx.split.fromSolarGbp, fromGridGbp: bx.split.fromGridGbp, standbyGbp: bx.split.standbyGbp },
            thresholdGbp: bx.thresholdGbp, optimalGbp: bx.optimalGbp,
            thresholdSystemGbp: bx.thresholdSystemGbp, optimalSystemGbp: bx.optimalSystemGbp,
            cyclesPerYear: bx.cyclesPerYear,
        };
    }
    if (ctx.overridden?.has(sys.id)) row.priceOverride = true;
    return row;
}

/** The power station in a system — U* rows are built around one (kitId), C1 adds one to a kit. */
function stationOf(catalog, sys) {
    if (sys?.battery?.coupling !== 'ups') return null;
    return productsOf(catalog, sys).find((p) => p.kind === 'power-station') ?? null;
}

/**
 * The user's own prices (Compare's price editor) applied to a system, the way Compare stores them:
 * `costs` replaces the cost lines outright (Compare saves the whole edited list); `priceGbp` sets
 * the upfront total, each year-0 line scaled in proportion (pennies; the rounding goes on the
 * largest line so the total is exact) or one 'Your price' line when there were none. Later-year
 * lines and a staged plan's later costs are never touched (Compare edits upfront lines only).
 * Reference rows have no price. Invalid overrides are ignored.
 * @param {Object} sys normalised System
 * @param {{ priceGbp?: number, costs?: Object[] }|null|undefined} o
 * @returns {Object|null} the re-priced System, or null when nothing applies
 */
export function applyPriceOverride(sys, o) {
    if (!o || typeof o !== 'object' || sys.route === 'reference') return null;
    // Compare saves the whole list it edited, so an empty one never comes from it: it would make
    // the build free, and is ignored like any other invalid list (priceGbp still applies)
    if (Array.isArray(o.costs) && o.costs.length && o.costs.every((c) => c && finite(Number(c.gbp)) && Number(c.gbp) >= 0)) {
        return { ...sys, costs: o.costs.map((c) => ({ ...c, gbp: Number(c.gbp) })) };
    }
    const want = Number(o.priceGbp);
    if (!finite(want) || want < 0) return null;
    const up = sys.costs.map((c, i) => ({ c, i })).filter(({ c }) => !(Number(c.year) > 0));
    const total = up.reduce((s, { c }) => s + c.gbp, 0);
    if (!(total > 0)) return { ...sys, costs: [...sys.costs, { label: 'Your price', gbp: Math.round(want * 100) / 100, year: 0, kind: 'hardware' }] };
    const costs = sys.costs.map((c) => ({ ...c }));
    let big = up[0].i;
    let sum = 0;
    for (const { c, i } of up) {
        costs[i].gbp = Math.round(((c.gbp * want) / total) * 100) / 100;
        sum += costs[i].gbp;
        if (c.gbp > sys.costs[big].gbp) big = i;
    }
    costs[big].gbp = Math.round((costs[big].gbp + want - sum) * 100) / 100;
    return { ...sys, costs };
}

/** A product name without a trailing "(electrician)" — for copy that already says so. */
const plainName = (name) => String(name ?? '').replace(/\s*\(electrician\)\s*$/i, '');

/* ── the builder ────────────────────────────────────────────────────────────── */

/** The error a cancelled verdict throws (the worker's own cancellation error has the same shape). */
const cancelled = () => Object.assign(new Error('Cancelled'), { name: 'AbortError', code: 'CANCELLED' });

/**
 * Build the verdict for the engine's dataset.
 * @param {Object} engine SolarEngine (core.js)
 * @param {{ scenarios?: Object[], finance?: Object, maxPaybackYears?: number, tieBandPct?: number,
 *   onPartial?: (stage: string, partial: Object) => void, nowMs?: number, isCancelled?: () => boolean,
 *   overrides?: Object<string, { priceGbp?: number, costs?: Object[] }> }} [opts]
 *   scenarios default to engine.autoScenarios(); nowMs only stamps generatedAtMs (default now).
 *   isCancelled is checked between options (and between the answers): once it returns true the
 *   build stops there and rejects with an AbortError. overrides are the user's own prices by
 *   scenario id, applied as Compare stores them (applyPriceOverride); those rows carry
 *   priceOverride: true and context.priceOverrides lists their ids.
 * @returns {Promise<Object>} Verdict { stage, done, context, usage, ranked, excluded, bestBuyId, runnerUpId, stepUp,
 *   headline, answers: { orientation, battery, ups, growth, confidence, baseLoad }, tornado, scatter, generatedAtMs }
 */
export async function buildVerdict(engine, { scenarios, finance = {}, maxPaybackYears = 10, tieBandPct = 3, onPartial, nowMs, isCancelled, overrides } = {}) {
    if (!engine) throw new Error('buildVerdict needs an engine');
    const fin = finance && typeof finance === 'object' ? finance : {};
    const maxYears = finite(maxPaybackYears) && maxPaybackYears > 0 ? maxPaybackYears : 10;
    const check = () => { if (typeof isCancelled === 'function' && isCancelled()) throw cancelled(); };
    /** Between options: let other work in, then stop here if the caller has cancelled. */
    const pause = async () => { check(); await tick(); check(); };
    check();
    const overridden = new Set();
    const list = (Array.isArray(scenarios) && scenarios.length ? scenarios : engine.autoScenarios()).map((s) => {
        const sys = engine.normalizeSystem(s);
        const o = overrides && typeof overrides === 'object' && Object.prototype.hasOwnProperty.call(overrides, sys.id) ? overrides[sys.id] : null;
        const priced = o ? applyPriceOverride(sys, o) : null;
        if (!priced) return sys;
        overridden.add(sys.id);
        return engine.normalizeSystem(priced);
    });
    const byId = new Map(list.map((s) => [s.id, s]));
    const summary = engine.summary;
    const ins = engine.insights();
    const fo = engine.financeOptions(fin);
    const stamp = finite(nowMs) ? nowMs : Date.now();

    const V = {
        stage: null, done: false, pending: [...STAGES],
        context: null, usage: null, ranked: [], excluded: [],
        bestBuyId: null, runnerUpId: null, stepUp: null, headline: null,
        answers: { orientation: null, battery: null, ups: null, growth: null, confidence: null, baseLoad: null },
        tornado: null, scatter: null, generatedAtMs: stamp,
    };
    const results = new Map();     // id → ScenarioResult (no band, then with band)
    const rows = new Map();        // id → row
    const emit = (stage) => {
        V.stage = stage;
        V.pending = STAGES.slice(STAGES.indexOf(stage) + 1);
        V.done = stage === STAGES[STAGES.length - 1];
        onPartial?.(stage, plain(V));
    };
    const run = (sys, withBand) => {
        const r = engine.runScenario(sys, { withBand, finance: fin });
        results.set(sys.id, r);
        return r;
    };

    /* ── stage 1: usage ── */
    const bl = ins.baseLoad ?? {};
    let r1 = list.find((s) => s.route === 'reference' && s.loadAdjustW < 0) ?? null;
    const r1Res = run(r1 ?? { id: '__cut100', name: 'Cut 100 W of always-on load', route: 'reference', arrays: [], costs: [], loadAdjustW: -100 }, false);
    const per100 = r1Res.headline.savingsGbp * (100 / Math.abs(r1Res.system.loadAdjustW || -100));
    if (!r1) results.delete('__cut100');
    const ctxRow = { gbpPer100W: per100, overridden };
    const cov = summary.coverage ?? {};
    const coveragePct = finite(cov.realPct) ? cov.realPct : 100;
    const estDays = finite(cov.extrapolatedSlots) ? Math.round(cov.extrapolatedSlots / 48) : 0;
    const wb = summary.weatherBasis ?? {};
    const installDate = fo.installDate;
    const [iy, im] = installDate.split('-').map(Number);
    const endM = ((im - 1 + 11) % 12);
    const endY = iy + Math.floor((im - 1 + 11) / 12);
    const firstYearLabel = `${MONTHS[im - 1]} ${iy} – ${MONTHS[endM]} ${endY}`;
    const catalogDates = [...(engine.catalog?.kits ?? []), ...(engine.catalog?.stations ?? []), ...(engine.catalog?.bundles ?? [])]
        .map((p) => p.priceDate).filter(Boolean).sort();
    const where = summary.postcode || summary.regionName || (summary.region ? `region ${summary.region}` : 'your home');
    // Without the 2006–2025 record the engine's "typical" year is simply the last 12 months.
    const typicalYear = !!wb.hasClimatology;
    const fullYear = !(summary.days < 330);
    const line = [
        `${num(summary.days)} days of your half-hourly use (${day(summary.from)} – ${day(summary.to)})`,
        summary.tariffCode,
        typicalYear ? `typical-year sunshine for ${where}` : `${fullYear ? 'your last 12 months’' : 'the same days’'} sunshine at ${where}`,
        finite(engine.projectBaseW) ? `projected with ${num(engine.projectBaseW)} W always-on` : null,
    ].filter(Boolean).join(' · ');
    let weatherNote = null;
    if (wb.hasClimatology && finite(wb.pctVsAverage)) {
        const rank = sunshineRank(wb, { sameMonths: !fullYear });
        const rel = Math.round(wb.pctVsAverage) === 0 ? 'about as sunny as' : wb.pctVsAverage > 0 ? `${pct(wb.pctVsAverage)} sunnier than` : `${pct(-wb.pctVsAverage)} duller than`;
        weatherNote = `${fullYear ? 'Your last 12 months were' : `Your ${num(summary.days)} days were`} ${rel} the 2006–2025 average${rank ? ` (${rank})` : ''}, so every figure uses a typical year’s sunshine instead.`;
    } else if (!wb.hasClimatology) {
        weatherNote = `We couldn’t get the 20-year sunshine record for your home, so every figure uses the sunshine ${fullYear ? 'of your last 12 months' : 'during your data'} and there is no weather range.`;
    }
    V.context = {
        days: summary.days, from: summary.from, to: summary.to, source: summary.source,
        tariffCode: summary.tariffCode ?? null, tariffCodes: (summary.tariffs ?? []).map((t) => t.code),
        region: summary.region ?? null, regionName: summary.regionName ?? null, postcode: summary.postcode ?? null,
        locationSource: summary.locationSource ?? null,
        coveragePct, estimatedDays: estDays, serverW: summary.serverW ?? null,
        projectBaseW: finite(engine.projectBaseW) ? engine.projectBaseW : null,
        weather: { hasClimatology: !!wb.hasClimatology, typicalYear, fullYear, hasBand: (engine.bandYears?.length ?? 0) > 0,
            pctVsAverage: wb.pctVsAverage ?? null, sunnierThanYears: wb.sunnierThanYears ?? null, yearsCompared: wb.yearsCompared ?? 0 },
        weatherNote,
        line,
        firstYear: { installDate, label: firstYearLabel },
        finance: { installDate, years: fo.years, discountRate: fo.discountRate, escalation: fo.escalation, vatReturns: fo.vatReturns !== false,
            pvAnnualDeg: fo.pvAnnualDeg },
        maxPaybackYears: maxYears,
        tieBandPct,
        pricesChecked: catalogDates[catalogDates.length - 1] ?? null,
        options: list.length,
        priceOverrides: [...overridden],
    };
    V.usage = {
        baseLoadW: bl.w ?? null, recentBaseW: bl.recentW ?? null, driftPct: bl.driftPct ?? 0,
        driftFlag: finite(bl.driftPct) && Math.abs(bl.driftPct) >= 15,
        baseLoadKwhYr: bl.kwhYr ?? null, baseLoadSharePct: bl.sharePct ?? null,
        baseLoadCostGbp: bl.costBilledGbpYr ?? null, baseLoadPeakCostGbp: bl.costPeakGbpYr ?? null,
        gbpPer100WBilled: bl.gbpPer100W ?? null, gbpPer100W: per100,
        peakKwhPerDay: ins.peak?.kwhPerDay ?? null,
        energyCostGbp: ins.totals?.energyGbp ?? null, standingGbp: ins.totals?.standingGbp ?? null, loadKwh: ins.totals?.kwh ?? null,
    };
    for (const s of list.filter((x) => x.route === 'reference')) {
        const r = results.get(s.id) ?? run(s, false);
        rows.set(s.id, rowOf(engine, s, r, ctxRow));
    }
    emit('usage');
    await pause();

    /* ── stage 2: solar-only options → the best buy ── */
    const solarOnly = (s) => !s.battery && (s.route === 'plugin' || s.route === 'hardwired');
    for (const s of list.filter(solarOnly)) {
        rows.set(s.id, rowOf(engine, s, run(s, false), ctxRow));
        await pause();
    }
    const decide = () => decideRows(engine, rows, { maxYears });
    Object.assign(V, decide());
    V.headline = headlineFor(engine, V, rows, byId, results, { maxYears, per100 });
    emit('plugin');
    await pause();

    /* ── stage 3: storage, combinations, future rules ── */
    for (const s of list) {
        if (rows.has(s.id)) continue;
        rows.set(s.id, rowOf(engine, s, run(s, false), ctxRow));
        await pause();
    }
    Object.assign(V, decide());
    V.headline = headlineFor(engine, V, rows, byId, results, { maxYears, per100 });
    V.answers.battery = guard(() => batteryAnswer(engine, V, rows, results, ins));
    V.answers.ups = guard(() => upsAnswer(engine, V, rows, byId, results, fin));
    V.answers.growth = guard(() => growthAnswer(engine, V, rows));
    V.scatter = scatterOf(V, rows);
    emit('all');
    await pause();

    /* ── stage 4: weather bands ── */
    const order = [V.bestBuyId, V.runnerUpId, V.stepUp?.id, ...V.ranked.map((r) => r.id)].filter((x, i, a) => x && a.indexOf(x) === i);
    for (const id of order) {
        const s = byId.get(id);
        if (!s) continue;
        const r = run(s, true);
        const row = rowOf(engine, s, r, ctxRow);
        row.confidence = confidenceFor(row, confidenceCtx(engine, s, row, summary, coveragePct));
        rows.set(id, row);
        await pause();
    }
    Object.assign(V, decide());
    V.headline = headlineFor(engine, V, rows, byId, results, { maxYears, per100 });
    V.scatter = scatterOf(V, rows);
    if (V.answers.battery?.status === 'ready') V.answers.battery = guard(() => batteryAnswer(engine, V, rows, results, ins));
    V.answers.confidence = guard(() => confidenceAnswer(V, rows, null));
    emit('bands');
    await pause();

    /* ── stage 5: orientation, tornado, always-on load ── */
    // the best buy, or — when nothing qualifies — the option that comes closest
    const best = focusOf(V, rows);
    const bestSys = best ? byId.get(best.id) : null;
    const orientSys = bestSys?.arrays?.length ? bestSys : byId.get('S01') ?? (best?.panels ? bestSys : null);
    V.answers.orientation = guard(() => orientationAnswer(engine, orientSys, rows.get(orientSys?.id), { tieBandPct, finance: fin }));
    await pause();
    if (bestSys) {
        V.tornado = guard(() => {
            const t = engine.tornado(bestSys, { finance: fin });
            return { id: t.id, center: t.center, rows: t.rows.map((x) => ({ ...x })) };
        });
        if (V.tornado?.status === 'error') V.tornado = null;
    }
    V.answers.confidence = guard(() => confidenceAnswer(V, rows, V.tornado));
    await pause();
    V.answers.baseLoad = guard(() => baseLoadAnswer(engine, V, rows, byId, { maxYears, finance: fin, per100 }));
    emit('answers');
    return plain(V);
}

/** Run an answer builder; an AbortError propagates, anything else becomes { status: 'error' }. */
function guard(fn) {
    try {
        return fn();
    } catch (err) {
        if (isAbort(err)) throw err;
        return { status: 'error', message: String(err?.message || err) };
    }
}

function confidenceCtx(engine, sys, row, summary, coveragePct) {
    const products = productsOf(engine.catalog, sys);
    const station = stationOf(engine.catalog, sys);
    const bv = row.batteryValue;
    return {
        coveragePct, days: summary.days, station, products,
        batteryRange: bv ? { threshold: bv.thresholdSystemGbp, optimal: bv.optimalSystemGbp } : null,
        hasBand: (engine.bandYears?.length ?? 0) > 0,
    };
}

/* ── ranking, best buy, badges ──────────────────────────────────────────────── */

/**
 * Order rows (legal ok/check by 10-year NPV → reference points → future-rules plans), split off
 * rows with rule errors, mark dominance and badges, and pick the best buy, runner-up and step-up.
 */
function decideRows(engine, rows, { maxYears }) {
    const all = [...rows.values()];
    const excluded = all.filter((r) => r.errors.length && r.legal !== 'whatif');
    const ok = all.filter((r) => !excluded.includes(r));
    const main = ok.filter((r) => r.legal === 'ok' || r.legal === 'check').sort(byNpv);
    const ref = ok.filter((r) => r.legal === 'reference').sort((a, b) => (a.savings.typical - b.savings.typical) || (a.id < b.id ? -1 : 1));
    const what = ok.filter((r) => r.legal === 'whatif').sort(byNpv);
    const ranked = [...main, ...ref, ...what];

    const dom = dominance(ranked);
    for (const r of ranked) { r.dominatedBy = dom.get(r.id) ?? null; r.badges = []; }

    const base = (r) => r.legal === 'ok' && !r.errors.length && r.availableNow !== false && r.route !== 'reference';
    const pays = (r) => finite(r.payback.typical) && r.payback.typical <= maxYears && r.capexGbp > 0;
    const solar = (r) => !r.battery && (r.route === 'plugin' || r.route === 'hardwired');
    const eligibleAny = main.filter((r) => base(r) && pays(r));
    let pool = eligibleAny.filter(solar);
    if (!pool.length) pool = eligibleAny;
    const pickBest = (cands) => {
        if (!cands.length) return null;
        const top = cands.slice().sort(byNpv)[0];
        return cands.filter((r) => r.npv10Gbp >= top.npv10Gbp - NPV_TIE_GBP).sort((a, b) => (a.capexGbp - b.capexGbp) || byNpv(a, b))[0];
    };
    let best = pickBest(pool);
    // storage that is cheaper AND worth more beats the storage-free pick outright
    if (best) {
        const cheaperBetter = eligibleAny.filter((r) => r !== best && r.capexGbp <= best.capexGbp && r.npv10Gbp > best.npv10Gbp + NPV_TIE_GBP);
        if (cheaperBetter.length) { best = pickBest(cheaperBetter); pool = eligibleAny; }
    }
    let runnerUp = null;
    let stepUp = null;
    if (best) {
        const others = pool.filter((r) => r !== best);
        const close = others.filter((r) => finite(r.payback.typical) && r.payback.typical <= best.payback.typical + 1)
            .sort((a, b) => (a.capexGbp - b.capexGbp) || byNpv(a, b));
        runnerUp = close[0] ?? others.slice().sort(byNpv)[0] ?? null;
        const bigger = eligibleAny.filter((r) => r !== best && r.npv10Gbp > best.npv10Gbp + NPV_TIE_GBP).sort(byNpv)[0] ?? null;
        if (bigger) {
            const dC = bigger.capexGbp - best.capexGbp;
            const dS = bigger.savings.typical - best.savings.typical;
            stepUp = { id: bigger.id, deltaCapexGbp: dC, deltaSavingsGbp: dS, deltaNpv10Gbp: bigger.npv10Gbp - best.npv10Gbp,
                deltaNet10Gbp: finite(bigger.net10Gbp) && finite(best.net10Gbp) ? bigger.net10Gbp - best.net10Gbp : null,
                incrementalPaybackYears: dS > 0 ? (dC > 0 ? dC / dS : 0) : null };
        }
    }
    const badge = (r, key, label) => { if (r && !r.badges.some((b) => b.key === key)) r.badges.push({ key, label }); };
    badge(best, 'best', 'Best buy');
    if (stepUp) badge(rows.get(stepUp.id), 'most', 'Most over 10 yrs');
    const fastest = eligibleAny.slice().sort((a, b) => (a.payback.typical - b.payback.typical) || byNpv(a, b))[0];
    const lowest = eligibleAny.slice().sort((a, b) => (a.capexGbp - b.capexGbp) || byNpv(a, b))[0];
    badge(fastest, 'fastest', 'Fastest payback');
    badge(lowest, 'lowest', 'Lowest outlay');
    return {
        ranked,
        excluded: excluded.map((r) => ({ id: r.id, name: r.name, route: r.route, errors: r.errors })),
        bestBuyId: best?.id ?? null,
        runnerUpId: runnerUp?.id ?? null,
        stepUp,
        counts: { ranked: ranked.length, dominated: ranked.filter((r) => r.dominatedBy).length, whatif: what.length, reference: ref.length },
    };
}

/* ── best-buy card text ─────────────────────────────────────────────────────── */

function facingText(p) {
    if (!p) return null;
    if (p.tilt >= 85) return `On a ${p.compass}-facing wall`;
    return `Facing ${p.compass} at ${Math.round(p.tilt)}°`;
}

function nextSteps(engine, row, sys) {
    const steps = [];
    const p = row.panels;
    const products = productsOf(engine.catalog, sys);
    const where = p ? `${p.tilt >= 85 ? `on a ${p.compass}-facing wall` : `facing ${p.compass} at ${Math.round(p.tilt)}°`}${p.spotName ? ` (${p.spotName.replace(/\s*\(.*\)\s*$/, '').toLowerCase()})` : ''}` : null;
    if (row.route === 'plugin') {
        steps.push({ text: 'Check the socket’s circuit has RCD/RCBO protection — plug straight in, no extension leads or adaptors.', href: LINKS.ips, label: 'Product specification' });
        if (where) steps.push({ text: `Mount the panels ${where}.`, href: null, label: null });
        steps.push({ text: 'Register it at myplugin.solar — it’s a legal requirement.', href: LINKS.register, label: 'myplugin.solar' });
        if (p && p.wp > 960) steps.push({ text: 'Ask an electrician to check the circuit (advised above 960 W of panels).', href: LINKS.ips, label: 'Why 960 W' });
        if (row.exportKind === 'prime' || products.some((x) => x.octopus)) steps.push({ text: 'After your network operator approves it, switch on Outgoing Prime in your Octopus account.', href: null, label: null });
    } else if (row.route === 'hardwired') {
        const el = engine.catalog?.electrician ?? { gbp: 350, cuLow: 400, cuHigh: 900 };
        steps.push({ text: `Get quotes from a Part P electrician for a dedicated circuit + G98 notification (we assumed ${gbp(el.gbp)}; +${gbp(el.cuLow ?? 400)}–${gbp(el.cuHigh ?? 900).replace('£', '')} if your consumer unit needs replacing).`, href: null, label: null });
        const hw = sys.costs.filter((c) => c.kind === 'hardware' && (c.year ?? 0) === 0).reduce((s, c) => s + c.gbp, 0);
        if (hw > 0) steps.push({ text: `Buying the kit through the installer may qualify for 0% VAT until 31 Mar 2027 — about ${gbp(hw / 6)} less.`, href: LINKS.vat, label: 'VAT Notice 708/6' });
        if (where) steps.push({ text: `Mount the panels ${where}.`, href: null, label: null });
    } else if (row.route === 'ups') {
        const st = stationOf(engine.catalog, sys);
        const auto = st?.touMode ? 'its time-of-use mode' : 'a smart plug on its mains lead driven by Agile prices (e.g. Home Assistant)';
        steps.push({ text: `Put the servers on the power station’s outlets, keep bypass on, and set up ${auto}.`, href: null, label: null });
        if (where) steps.push({ text: `Stand its panels ${where}.`, href: null, label: null });
    }
    if (row.availableNow === false || row.preorder) steps.push({ text: `Delivery: ${row.availability || 'not on sale right now'}.`, href: null, label: null });
    return steps;
}

function headlineFor(engine, V, rows, byId, results, { maxYears, per100 }) {
    const best = V.bestBuyId ? rows.get(V.bestBuyId) : null;
    if (!best) {
        const cands = V.ranked.filter((r) => (r.legal === 'ok' || r.legal === 'check') && !r.errors.length && r.capexGbp > 0);
        const closest = cands.filter((r) => finite(r.payback.typical)).sort((a, b) => a.payback.typical - b.payback.typical)[0] ?? null;
        return {
            kind: 'none',
            title: `Nothing here pays back within ${nYears(maxYears)} on your data.`,
            lede: closest
                ? `Closest: the ${closest.name}, which pays back in ${years(closest.payback.typical)}. Cutting 100 W of always-on load would save ${em(gbp(per100))}/yr for nothing.`
                : `None of these options pays for itself within ${nYears(V.context?.finance?.years ?? 20)}. Cutting 100 W of always-on load would save ${em(gbp(per100))}/yr for nothing.`,
            // the option the answers below talk about: the closest to paying back, else the least bad by NPV
            closestId: (closest ?? cands.slice().sort(byNpv)[0])?.id ?? null,
            why: null, equivalent: null, weatherNote: null, runnerUp: null, stepUp: null, nextSteps: [], cashflow: null,
        };
    }
    const sys = byId.get(best.id);
    const s = best.savings;
    const range = finite(s.p10) && finite(s.p90) && Math.abs(s.p90 - s.p10) >= 0.5 ? ` (${gbp(s.p10)}–${gbp(s.p90)} depending on the weather)` : '';
    const face = facingText(best.panels);
    const wx = V.context.weather;
    const basis = !best.panels ? '' : wx.typicalYear ? ' in a typical year' : wx.fullYear === false ? ' with the sunshine your data had' : ' with your last 12 months’ sunshine';
    const lede = `${face ? `${face}, it` : 'It'} would save about ${em(`${gbp(s.typical)}/yr`)}${basis}${range} and pay for itself in ${em(years(best.payback.typical))}.`;
    let why = null;
    const prime = best.exportKind === 'prime';
    if (best.panels && best.selfUsePct >= 95) {
        why = `Your always-on load uses ${pct(best.selfUsePct)} of what it makes, so export payments barely matter${prime ? ` — Outgoing Prime adds only ${gbp(best.exportIncomeGbp)}/yr` : ''}.`;
    } else if (best.panels && best.pvKwh > 0 && best.exportUnpaidKwh >= 0.05 * best.pvKwh) {
        why = `${num(best.exportUnpaidKwh)} kWh/yr would go to the grid unpaid.`;
    } else if (prime) {
        why = `Includes ${gbp(best.exportIncomeGbp)}/yr from Outgoing Prime.`;
    }
    const equivalent = finite(best.equivalentWattsCut) && best.equivalentWattsCut > 0 ? `Same as permanently switching off ${em(`${num(best.equivalentWattsCut)} W`)} of servers.` : null;
    let weatherNote = null;
    // only when the headline really is a typical year: otherwise "as it happened" is the headline
    if (best.panels && finite(s.actual) && wx.typicalYear) {
        const rank = sunshineRank(wx, { sameMonths: wx.fullYear === false });
        const rel = finite(wx.pctVsAverage) ? ` (${wx.pctVsAverage >= 0 ? '+' : MINUS}${Math.abs(Math.round(wx.pctVsAverage))}% vs average)` : '';
        weatherNote = `${wx.fullYear === false ? 'With the sunshine your data actually had, scaled to a year' : 'Last 12 months as it happened'}: ${gbp(s.actual)}/yr${rank ? ` — ${rank}${rel}` : ''}.`;
    }
    const ru = V.runnerUpId ? rows.get(V.runnerUpId) : null;
    const runnerUp = ru
        ? (ru.capexGbp < best.capexGbp
            ? `Spending less? ${ru.name} costs ${em(gbp(ru.capexGbp))} and pays back in ${years(ru.payback.typical, 'yrs')}.`
            : `Close second: ${ru.name}, ${gbp(ru.capexGbp)}, pays back in ${years(ru.payback.typical, 'yrs')}.`)
        : null;
    let stepUp = null;
    if (V.stepUp) {
        const b = rows.get(V.stepUp.id);
        const how = b.route === 'hardwired' ? 'With an electrician, the ' : b.route === 'ups' ? 'With a power station, the ' : 'The ';
        // "ahead after 10 years" in plain pounds, like the card's readout above it
        const dNet = finite(b.net10Gbp) && finite(best.net10Gbp) ? b.net10Gbp - best.net10Gbp : null;
        const ahead = finite(dNet) && dNet > 0 ? ` — ${gbp(dNet)} further ahead after 10 years` : '';
        stepUp = `Going bigger? ${how}${plainName(b.name)} (${gbp(b.capexGbp)}) saves ${em(`${gbp(b.savings.typical)}/yr`)}${ahead}. The extra ${gbp(V.stepUp.deltaCapexGbp)} pays back in ${years(V.stepUp.incrementalPaybackYears, 'yrs')}.`;
    }
    const r = results.get(best.id) ?? {};
    const cum = (f) => (f?.years ?? []).map((y) => y.cumulativeGbp);
    return {
        kind: 'buy',
        title: `Buy the ${best.name}.`,
        name: best.name,
        lede,
        why,
        equivalent,
        weatherNote,
        runnerUp,
        stepUp,
        nextSteps: nextSteps(engine, best, sys),
        cashflow: { years: (r.finance?.years ?? []).map((y) => y.y), cumulativeGbp: cum(r.finance),
            p10: r.financeBand ? cum(r.financeBand.p10) : null, p90: r.financeBand ? cum(r.financeBand.p90) : null,
            batteryEndYear: r.finance?.batteryEndYear ?? null },
    };
}

/* ── the cost-vs-saving scatter ─────────────────────────────────────────────── */

function scatterOf(V, rows) {
    const pts = V.ranked.filter((r) => finite(r.capexGbp) && finite(r.savings.typical));
    const front = pts.filter((r) => (r.legal === 'ok' || r.legal === 'check') && !r.dominatedBy && !r.errors.length)
        .sort((a, b) => a.capexGbp - b.capexGbp).map((r) => [r.capexGbp, r.savings.typical]);
    const xMax = Math.max(0, ...pts.map((r) => r.capexGbp));
    return {
        points: pts.map((r) => ({ id: r.id, label: r.name, route: r.route, x: r.capexGbp, y: r.savings.typical,
            whisker: finite(r.savings.p10) && finite(r.savings.p90) ? [r.savings.p10, r.savings.p90] : null,
            emphasis: r.id === V.bestBuyId, showLabel: r.id === V.runnerUpId || r.id === V.stepUp?.id || r.id === 'R1',
            dominated: !!r.dominatedBy })),
        front,
        isolines: [2, 3, 5, 10].map((n) => ({ n, label: `pays back in ${n} yrs`, points: [[0, 0], [xMax * 1.1 || 1, (xMax * 1.1 || 1) / n]] })),
    };
}

/* ── answers ────────────────────────────────────────────────────────────────── */

function orientationAnswer(engine, sys, row, { tieBandPct, finance }) {
    if (!sys) return { status: 'none', summary: 'No panels to point in these options.', body: [] };
    const a = engine.answerOrientation(sys, { tieBandPct, finance });
    const kw = (p) => num(p.kwh);
    const tie = a.tie;
    const out = {
        status: 'ready', forId: sys.id, forName: sys.name,
        best: a.best, s35: a.s35, w45: a.w45, w90: a.w90, ssw45: a.ssw45, current: a.current,
        tie, tieBandPct: a.tieBandPct, westPays: a.westPays, flips: a.flips, checked: a.checked, compass: a.compass,
        proxyNote: a.proxyNote,
        cells: a.cells.map((c) => ({ az: c.az, tilt: c.tilt, kwh: c.kwh, gbp: c.gbp, pPerKwh: c.pPerKwh, peakSharePct: c.peakSharePct, peakShareAllPct: c.peakShareAllPct ?? c.peakSharePct })),
    };
    const body = [];
    if (!a.westPays) {
        out.summary = `No — face them ${a.compass}.`;
        const less = a.best.kwh > 0 ? (100 * (a.best.kwh - a.w90.kwh)) / a.best.kwh : 0;
        const worth = a.w90.pPerKwh > a.best.pPerKwh
            ? `Each of those kWh is worth more (${num(a.w90.pPerKwh, 1)}p vs ${num(a.best.pPerKwh, 1)}p) because ${pct(a.w90.peakSharePct)} lands in the 4–7pm peak, but that doesn’t make up for the lost energy: ${em(`${gbp(a.w90.gbp)} vs ${gbp(a.best.gbp)} a year`)}.`
            : `And they wouldn’t even be worth more per kWh (${num(a.w90.pPerKwh, 1)}p vs ${num(a.best.pPerKwh, 1)}p): ${em(`${gbp(a.w90.gbp)} vs ${gbp(a.best.gbp)} a year`)}.`;
        body.push(`On a west-facing wall they’d make ${kw(a.w90)} kWh/yr instead of ${kw(a.best)} (${pct(less)} less). ${worth} There’s little or no sun after 4pm from November to February.`);
        if (tie) {
            const azs = tie.azMin === tie.azMax ? compass16(tie.azMin) : `${compass16(tie.azMin)} to ${compass16(tie.azMax)}`;
            const tl = tie.tiltMin === tie.tiltMax ? `${tie.tiltMin}°` : `${tie.tiltMin}–${tie.tiltMax}°`;
            body.push(`Anything from ${em(`${azs} at ${tl}`)} is within ${a.tieBandPct}% of the best — pick what fits.`);
        }
    } else {
        out.summary = `Yes — for you, west pays: ${a.compass} ${Math.round(a.best.tilt)}°.`;
        body.push(`${em(`${a.compass} ${Math.round(a.best.tilt)}°`)} makes ${gbp(a.best.gbp)}/yr vs ${gbp(a.s35.gbp)} facing south.`);
    }
    if (a.flips.length) {
        for (const f of a.flips) body.push(`This changes if ${f.text}: best becomes ${f.compass} ${f.tilt}° (${gbp(f.gbp)}/yr).`);
    } else if (a.checked.length) {
        const words = { C1: 'a lower always-on load with Outgoing Prime', C2: 'Outgoing Prime', C3: 'more panels on the same inverter', C4: 'a battery' };
        const parts = a.checked.filter((c) => c !== 'C2' || !a.checked.includes('C1')).map((c) => words[c]).filter(Boolean);
        const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}` : parts[0];
        if (list) body.push(`${list[0].toUpperCase()}${list.slice(1)} wouldn’t change it.`);
    }
    out.body = body;
    return out;
}

function batteryAnswer(engine, V, rows, results, ins) {
    const legalBatt = V.ranked.filter((r) => r.battery && r.battery.coupling !== 'ups' && r.legal === 'ok' && !r.errors.length && r.route !== 'whatif');
    const B = legalBatt.slice().sort(byNpv)[0] ?? null;
    const P = V.ranked.filter((r) => r.route === 'plugin' && !r.battery && r.legal === 'ok' && !r.errors.length).sort(byNpv)[0]
        ?? (V.bestBuyId ? rows.get(V.bestBuyId) : null);
    if (!B) return { status: 'none', summary: 'No battery option to compare on your data.', body: [] };
    const res = results.get(B.id);
    const bx = B.batteryValue;
    if (!bx || !res) return { status: 'none', summary: 'No battery option to compare on your data.', body: [] };
    const sys = res.system;
    const dC = P ? B.capexGbp - P.capexGbp : B.capexGbp;
    const dS = P ? B.savings.typical - P.savings.typical : B.savings.typical;
    const inc = dS > 0 ? dC / dS : null;
    const life = sys.battery?.lifeYears ?? 15;
    const verdict = finite(inc) && inc <= BATTERY_PAYS_YEARS ? 'pays' : finite(inc) && inc <= life ? 'marginal' : 'doesNotPay';
    const split = { ...bx.split };
    const gross = Math.max(0, split.fromGridGbp) + Math.max(0, split.fromSolarGbp);
    const gridPct = gross > 0 ? (100 * Math.max(0, split.fromGridGbp)) / gross : 0;
    const solarPct = gross > 0 ? 100 - gridPct : 0;
    const mostlyGrid = bx.totalGbp > 0 && split.fromGridGbp >= 0.6 * bx.totalGbp;
    const peak = ins.peak?.kwhPerDay ?? null;
    const summary = finite(inc)
        ? `The best battery system saves ${em(`${gbp(dS)}/yr`)} more for ${gbp(dC)} more — the extra pays back in ${em(years(inc))}.`
        : `The best battery system wouldn’t save more than the ${P?.name ?? 'best plug-in kit'}.`;
    const body = [];
    body.push(`The ${plainName(B.name)}${B.route === 'hardwired' ? ', wired in by an electrician,' : ''} against the ${P?.name ?? 'best plug-in kit'}: ${gbp(B.capexGbp)} vs ${gbp(P?.capexGbp ?? 0)}, ${gbp(B.savings.typical)}/yr vs ${gbp(P?.savings.typical ?? 0)}/yr.`);
    body.push(`The battery itself adds ${em(`${gbp(bx.totalGbp)}/yr`)}${B.panels ? ' to its own panels' : ''}: ${pct(gridPct)} of that comes from charging in cheap Agile slots and ${pct(solarPct)} from storing your own solar, minus ${gbp(Math.abs(split.standbyGbp))}/yr of standby power.`);
    if (mostlyGrid) body.push('Your servers already use almost all the solar, so for you a battery is mostly a separate decision from solar.');
    if (finite(peak)) body.push(`Your home uses ${num(peak, 1)} kWh between 4 and 7pm each day; usable capacity much beyond that earns less per kWh (see the battery-size curve in Compare).`);
    body.push(`Any battery has to be wired in by an electrician today — plug-in batteries aren’t legal yet (Octopus hopes for early 2027). With perfect timing the battery’s ${gbp(bx.totalGbp)}/yr could reach ${gbp(bx.optimalGbp)}/yr.`);
    return {
        status: 'ready', bestId: B.id, bestName: B.name, vsId: P?.id ?? null, vsName: P?.name ?? null,
        deltaCapexGbp: dC, deltaSavingsGbp: dS, incrementalPaybackYears: inc,
        split, batteryTotalGbp: bx.totalGbp, thresholdGbp: bx.thresholdGbp, optimalGbp: bx.optimalGbp,
        gridPct, solarPct, mostlyGrid, peakKwhPerDay: peak, lifeYears: life, cyclesPerYear: bx.cyclesPerYear,
        verdict, summary, body,
    };
}

function upsAnswer(engine, V, rows, byId, results, finance) {
    const ups = V.ranked.filter((r) => r.route === 'ups' && r.legal === 'ok' && !r.errors.length);
    const serverOnly = ups.filter((r) => !r.panels).sort(byNpv);
    const withPanels = ups.filter((r) => r.panels).sort(byNpv)[0] ?? null;
    const main = serverOnly[0] ?? withPanels;
    if (!main) return { status: 'none', summary: 'No power station option on your data.', body: [] };
    const sys = byId.get(main.id);
    const raw = engine.upsStrategies(sys, { finance });
    const station = stationOf(engine.catalog, sys);
    const pb = main.payback.typical;
    // upsStrategies is on the headline's basis (its realistic figure is the station's headline);
    // the row's own saving is used so the answer reads exactly as the options table does
    const st = { ...raw, realisticGbp: main.savings.typical };
    const r = st.realisticGbp;
    const summary = finite(pb)
        ? `A power station running your servers saves ${em(`${gbp(r)}/yr`)} (pays back in ${years(pb, 'yrs')}).`
        : Math.abs(r) < 0.5 ? 'A power station running your servers saves nothing on your data.'
            : r < 0 ? `A power station running your servers would cost ${em(`${gbp(-r)}/yr`)} more than it saves.`
                : `A power station running your servers saves ${em(`${gbp(r)}/yr`)} — it never pays for itself.`;
    const body = [];
    body.push(`That’s the ${main.name.replace(/^Power station( for the servers)?:\s*/i, '')} (${gbp(main.capexGbp)}) with Agile-aware automation; up to ${gbp(st.bestCaseGbp)} if timed perfectly.`);
    body.push(st.peakCutGbp >= 0.5
        ? `Just cutting its mains with a smart plug from 4–7pm only saves ${gbp(st.peakCutGbp)}/yr — conversion losses eat most of the price gap.`
        : `Just cutting its mains with a smart plug from 4–7pm ${st.peakCutGbp <= -0.5 ? `loses ${gbp(-st.peakCutGbp)}/yr` : 'saves nothing'} — conversion losses eat the price gap.`);
    if (finite(st.onlinePenaltyGbp) && st.onlinePenaltyGbp < -0.5) body.push(`Don’t disable the bypass to run the servers through the inverter all the time: that costs ${em(`${gbp(-st.onlinePenaltyGbp)}/yr`)} more.`);
    if (withPanels && withPanels.id !== main.id) {
        const n = withPanels.panels?.count ?? 2;
        const wpb = withPanels.payback.typical;
        body.push(`With ${n} panel${n === 1 ? '' : 's'} on its own solar inputs (no 800 W limit, nothing to register): ${em(`${gbp(withPanels.savings.typical)}/yr`)}, ${finite(wpb) ? `paying back in ${years(wpb, 'yrs')}` : 'but it never pays back'}.`);
    }
    const sw = finite(st.switchMs) ? `${num(st.switchMs)} ms switchover` : null;
    body.push(`Bonus: it’s a real UPS for the servers${sw || st.hid ? ` (${[sw, st.hid ? 'USB HID for clean shutdown' : null].filter(Boolean).join('; ')})` : ''}.`);
    return {
        status: 'ready', bestId: main.id, bestName: main.name,
        realisticGbp: st.realisticGbp, bestCaseGbp: st.bestCaseGbp, peakCutGbp: st.peakCutGbp,
        onlineGbp: st.onlineGbp, onlinePenaltyGbp: st.onlinePenaltyGbp, paybackYears: pb, capexGbp: main.capexGbp,
        withPanels: withPanels ? { id: withPanels.id, name: withPanels.name, gbp: withPanels.savings.typical, paybackYears: withPanels.payback.typical, capexGbp: withPanels.capexGbp } : null,
        switchMs: st.switchMs ?? null, hid: !!st.hid, automation: station?.touMode ? 'tou' : station?.smartPlugOnly ? 'smartPlug' : 'app',
        summary, body,
    };
}

function growthAnswer(engine, V, rows) {
    const kits = pluginKits(engine.catalog);
    const size = (k) => k.includedPanels.count * k.includedPanels.wp;
    const biggest = kits.slice().sort((a, b) => size(b) - size(a))[0] ?? null;
    const okRow = (r) => r.legal === 'ok' && !r.errors.length;
    const hw = V.ranked.filter((r) => r.route === 'hardwired' && !r.battery && okRow(r)).sort(byNpv)[0] ?? null;
    const st = V.ranked.filter((r) => r.route === 'ups' && r.panels && okRow(r)).sort(byNpv)[0] ?? null;
    const w3 = rows.get('W3') ?? null;
    const w3base = w3 ? V.ranked.find((r) => r.kitId === w3.kitId && r.route === 'plugin' && !r.battery && !/^[WC]/.test(r.id)) ?? null : null;
    const w2 = rows.get('W2') ?? null;
    const items = [];
    items.push(`You can only have one plug-in kit, and you can’t add panels to it (it must match its ENA registration).${biggest ? ` The biggest kit on sale here is ${em(`${num(size(biggest))} W`)}.` : ''}`);
    if (hw) items.push(`An electrician-installed system can sit alongside it up to 3.68 kW in total (16 A per phase), as long as there’s no battery while you keep the plug-in kit: best here ${hw.name}, ${gbp(hw.capexGbp)}, ${em(`${gbp(hw.savings.typical)}/yr`)} on its own (together they’d save less — your always-on load can only use so much at once).`);
    if (st) items.push(`A power station with its own panels isn’t connected to the grid: ${st.name}, ${em(`${gbp(st.savings.typical)}/yr`)}.`);
    const future = [];
    if (w3 && w3base) future.push(`a second kit (one per circuit, proposed) would add ${em(`${gbp(w3.savings.typical - w3base.savings.typical)}/yr`)}`);
    if (w2) future.push(`adding a plug-in battery later makes the whole plan pay back in ${years(w2.payback.typical, 'yrs')}`);
    if (future.length) items.push(`If the rules change: ${future.join(', and ')}.`);
    return {
        status: 'ready',
        summary: 'One plug-in kit per home, used as sold — but there are other ways to grow.',
        maxWp: biggest ? size(biggest) : null, maxKitName: biggest?.name ?? null,
        hardwired: hw ? { id: hw.id, name: hw.name, capexGbp: hw.capexGbp, savingsGbp: hw.savings.typical } : null,
        station: st ? { id: st.id, name: st.name, capexGbp: st.capexGbp, savingsGbp: st.savings.typical } : null,
        secondKit: w3 && w3base ? { id: w3.id, baseId: w3base.id, addGbp: w3.savings.typical - w3base.savings.typical } : null,
        laterBattery: w2 ? { id: w2.id, paybackYears: w2.payback.typical, atYear: w2.upgrade?.atYear ?? null } : null,
        body: items,
    };
}

/** The option the answers are about: the best buy, else the one that comes closest to paying back. */
function focusOf(V, rows) {
    const id = V.bestBuyId ?? V.headline?.closestId ?? null;
    return id ? rows.get(id) ?? null : null;
}

function confidenceAnswer(V, rows, tornado) {
    const best = focusOf(V, rows);
    if (!best) return { status: 'none', summary: 'There’s no option to rate.', body: [] };
    const c = best.confidence;
    if (!c) return { status: 'pending', summary: null, body: [] };
    const label = { high: 'High', medium: 'Medium', low: 'Low' }[c.level];
    const s = best.savings;
    const about = best.id === V.bestBuyId ? 'How sure' : `How sure about the ${best.name}`;
    const summary = finite(s.p10) && finite(s.p90) && Math.abs(s.p90 - s.p10) >= 0.5
        ? `${about}: ${em(label)}. Weather alone moves it between ${gbp(s.p10)} and ${gbp(s.p90)} a year.`
        : `${about}: ${em(label)}.`;
    const body = [];
    const top = (tornado?.rows ?? []).slice(0, 2);
    for (const t of top) body.push(`${t.label} moves payback from ${years(t.low)} to ${years(t.high)}.`);
    if (c.reasons.length) body.push(`What holds it back: ${c.reasons.join('; ')}.`);
    if (c.notes.length) body.push(`Worth knowing: ${c.notes.join('; ')}.`);
    body.push('Model accuracy: about ±2% a year from satellite sunshine; single half-hours can be off by 20–27%, which averages out.');
    return { status: tornado ? 'ready' : 'partial', forId: best.id, level: c.level, parts: { data: c.data, weather: c.weather, model: c.model },
        p10: s.p10, p90: s.p90, summary, body };
}

function baseLoadAnswer(engine, V, rows, byId, { maxYears, finance, per100 }) {
    const best = focusOf(V, rows);
    const plug = best && !best.battery ? best
        : V.ranked.filter((r) => r.route === 'plugin' && !r.battery && r.legal === 'ok' && !r.errors.length).sort(byNpv)[0] ?? null;
    const batt = V.answers.battery?.bestId ? rows.get(V.answers.battery.bestId) : null;
    const ups = V.answers.ups?.bestId ? rows.get(V.answers.ups.bestId) : null;
    const want = [plug, batt, ups].filter((r, i, a) => r && a.indexOf(r) === i);
    if (!want.length) return { status: 'none', summary: null, body: [] };
    // The load every figure uses: the projection when one is set (Usage → "use today's W"),
    // else the measured always-on load. The curves run on absolute loads (withBaseLoad from the
    // measured data), so their point at this x is the headline.
    const measured = V.usage.baseLoadW;
    const projected = V.context?.projectBaseW ?? null;
    const bl = finite(projected) ? projected : measured;
    const recent = V.usage.recentBaseW;
    const extra = [bl, measured, recent].filter(finite).map((v) => Math.round(v));
    const curves = [];
    for (const r of want) {
        const sys = byId.get(r.id);
        const xs = [...new Set([...CURVE_XS, ...extra])].sort((a, b) => a - b);
        const [c] = engine.baseLoadCurve([sys], xs, { finance });
        if (!c) continue;
        curves.push({ id: c.id, name: c.name, route: r.route, points: c.points.map((p) => ({ x: p.x, savingsGbp: p.savingsGbp, paybackYears: p.paybackYears, selfUsePct: p.selfUsePct, exportKwh: p.exportKwh, pvKwh: p.pvKwh })),
            breakEvenW: breakEvenW(c.points, maxYears) });
    }
    const main = curves.find((c) => c.id === plug?.id) ?? curves[0];
    const be = main?.breakEvenW;
    const name = plug?.name ?? main?.name ?? 'the best option';
    const yours = finite(projected) ? `projected ${num(bl)} W` : `${num(bl)} W`;
    const p0 = main?.points.find((p) => p.x === 0) ?? null;
    const pbUser = plug?.payback.typical ?? null;
    const tag = finite(projected) ? ' (projected)' : '';
    let summary;
    let kind;
    if (finite(be) && be <= 0.5 && finite(p0?.paybackYears) && finite(pbUser) && pbUser > 0) {
        // pays back even with no always-on load: say how much the load speeds it up
        kind = p0.paybackYears / pbUser >= 1.3 ? 'speeds' : 'either';
        summary = kind === 'speeds'
            ? `Your ${em(`${num(bl)} W`)} always-on load${tag} cuts the payback from ${years(p0.paybackYears)} to ${em(years(pbUser))}.`
            : `Solar pays back whatever your always-on load — ${years(pbUser)} at your ${yours}, ${years(p0.paybackYears)} with none.`;
    } else if (finite(be) && finite(bl) && be < 0.7 * bl) {
        kind = 'why';
        summary = `Your ${em(`${num(bl)} W`)} always-on load${tag} is why solar works for you.`;
    } else if (finite(be)) {
        kind = 'just';
        summary = 'Solar only just pays at your always-on load.';
    } else {
        kind = 'never';
        summary = `Solar doesn’t pay back within ${nYears(maxYears)} at any always-on load we tried.`;
    }
    const body = [];
    if (finite(projected) && finite(measured) && Math.abs(projected - measured) >= 1) {
        body.push(`Every figure uses the ${num(projected)} W you chose for the forecast; your data shows ${num(measured)} W over the year.`);
    }
    if (kind === 'speeds') {
        body.push(`The ${name} would pay back within ${nYears(maxYears)} even with no always-on load at all, but your load uses its output as it’s made — that’s what makes it fast.`);
    } else if (kind === 'why' || kind === 'just') {
        body.push(`Below ${em(`${num(round10(be))} W`)} the ${name} would take more than ${nYears(maxYears)} to pay back.`);
    }
    const billed = V.usage.gbpPer100WBilled;
    if (finite(per100) && plug) body.push(`Every 100 W you remove saves ${em(gbp(per100))} in your first year on its own${finite(billed) && Math.abs(billed - per100) >= 1 ? ` (${gbp(billed)} at last year’s prices and VAT)` : ''} — compare the ${plug.name} at ${gbp(plug.savings.typical)}/yr.`);
    body.push(`Above about ${PLUGIN_SHADE_FROM_W} W a plug-in kit’s output is all used at home, so more always-on load adds little.`);
    return {
        status: 'ready', userBaseW: bl, measuredBaseW: measured, projectedBaseW: finite(projected) ? projected : null, recentBaseW: recent, curves,
        breakEvenW: Object.fromEntries(curves.map((c) => [c.id, c.breakEvenW])),
        forId: main?.id ?? null, shadeFromW: PLUGIN_SHADE_FROM_W, kind, summary, body,
    };
}
