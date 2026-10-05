/*
 * solar-worker — the engine transport: worker.js dispatcher + engine.js client (inline mode).
 *
 * The dispatcher is driven with stub modules so the protocol is tested independently of the
 * engine agents' code: method whitelist, progress forwarding, cooperative cancellation, error
 * serialisation (API key redacted), catalog stripping, and graceful degradation when modules are
 * missing. One smoke test runs the real dataset.js demo path through the dispatcher.
 */
import { describe, it, expect, vi } from 'vitest';
import { createDispatcher, serializeError, makeGuardedFetch } from '../../../projects/solar-calculator/js/worker.js';
import { createEngine, reviveError } from '../../../projects/solar-calculator/js/engine.js';

const KEY = 'sk_live_TESTKEY123456';

function stubModules(overrides = {}) {
    const engineCalls = [];
    class SolarEngine {
        constructor(ds, catalog) { this.ds = ds; this.catalog = catalog; }
        get summary() { return { id: this.ds.id, n: this.ds.n, days: this.ds.n / 48 }; }
        insights() { return { baseLoad: { w: 420 }, heatmap: { load: new Float32Array([1, 2, 3]) } }; }
        runScenario(system, opts) { engineCalls.push(['runScenario', system, opts]); return { id: system.id, savings: 165 }; }
        autoScenarios() { return [{ id: 'S01' }, { id: 'S03' }]; }
        baseLoadCurve(systems, xs) { return systems.map(s => ({ id: s.id, points: (xs || []).map(x => ({ x })) })); }
        orientationSweep(system, arrayId, { onProgress }) {
            for (let i = 0; i <= 10; i++) onProgress({ pct: i * 10 });
            return { cells: [{ az: 180, tilt: 35, gbp: 165 }] };
        }
        setProjectBaseW(w) { engineCalls.push(['setProjectBaseW', w]); }
        normalizeSystem(p) { return { ...p, normalized: 'engine' }; }
        validate() { return { legal: 'ok', errors: [], warnings: [] }; }
        typicalDay() { return { date: '2026-06-21', slots: [] }; }
        exportCsv() { return 'a,b\n1,2\n'; }
        panelCountCurve() { return []; }
        batterySizeCurve() { return []; }
    }
    const mods = {
        './dataset.js': {
            async loadDataset(spec, ctx) {
                ctx.onProgress({ step: 'account', status: 'start' });
                if (spec.fail) throw Object.assign(new Error(`Octopus rejected key ${spec.apiKey}`), { name: 'DataError', code: 'AUTH', action: 'checkKey', retryable: false, step: 'account' });
                ctx.onProgress({ step: 'account', status: 'done' });
                ctx.onProgress({ step: 'usage', status: 'done', count: 17520, pct: 100 });
                return { id: 'ds-1', n: 17520 };
            },
            summarize: ds => ({ id: ds.id, n: ds.n, fromSummarize: true }),
        },
        './core.js': { SolarEngine },
        './kits.js': { normalizeCatalog: raw => ({ ...raw, byId: id => raw.kits.find(k => k.id === id) }) },
        './verdict.js': {
            async buildVerdict(engine, { scenarios, onPartial }) {
                onPartial('usage', { stage: 'usage' });
                onPartial('plugin', { stage: 'plugin', n: scenarios.length });
                return { bestBuyId: 'S01', ranked: scenarios.map(s => ({ id: s.id })) };
            },
        },
        './rules.js': { validate: () => ({ legal: 'check' }), applyFix: (s, a) => ({ ...s, fixed: a }) },
        './system.js': { normalizeSystem: p => ({ ...p, normalized: 'system' }) },
        './insights.js': { analyseUsage: ds => ({ fromInsights: ds.id }) },
        './cache.js': { openCache: () => ({ get: async () => undefined, set: async () => true }) },
        ...overrides,
    };
    const importer = vi.fn(async spec => {
        if (!(spec in mods) || mods[spec] == null) throw new Error(`Cannot find module '${spec}'`);
        return mods[spec];
    });
    const catalogLoader = vi.fn(async () => ({ kits: [{ id: 'k1' }], stations: [], bundles: [], constants: { plugInRules: { acMaxVA: 800 } } }));
    return { importer, catalogLoader, engineCalls };
}

function harness(overrides) {
    const msgs = [];
    const m = stubModules(overrides);
    const d = createDispatcher({ post: msg => msgs.push(structuredClone(msg)), importer: m.importer, catalogLoader: m.catalogLoader, fetch: async () => { throw new Error('no network in tests'); } });
    const call = async (id, method, ...args) => { await d.handle({ type: 'call', id, method, args }); return msgs.filter(x => x.id === id); };
    return { d, msgs, call, ...m };
}

describe('dispatcher protocol', () => {
    it('rejects methods that are not on the whitelist', async () => {
        const { call } = harness();
        const out = await call(1, 'constructor');
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe('error');
        expect(out[0].error.code).toBe('UNKNOWN_METHOD');
        const out2 = await call(2, '__proto__');
        expect(out2[0].error.code).toBe('UNKNOWN_METHOD');
    });

    it('ignores junk messages', async () => {
        const { d, msgs } = harness();
        await d.handle(null);
        await d.handle('hello');
        await d.handle({ type: 'nope', id: 9 });
        expect(msgs).toEqual([]);
    });

    it('loads a dataset, forwards progress in order, and returns the summary', async () => {
        const { call, d } = harness();
        const out = await call(1, 'loadDataset', { kind: 'octopus', apiKey: KEY });
        const progress = out.filter(m => m.type === 'progress').map(m => `${m.value.step}:${m.value.status}`);
        expect(progress).toEqual(['account:start', 'account:done', 'usage:done']);
        const res = out.find(m => m.type === 'result');
        expect(res.value).toEqual({ id: 'ds-1', n: 17520, days: 365 });
        expect(d.state()).toEqual({ hasDataset: true, hasEngine: true });
    });

    it('serialises data errors with the API key scrubbed from the message', async () => {
        const { call } = harness();
        const out = await call(1, 'loadDataset', { kind: 'octopus', apiKey: KEY, fail: true });
        const err = out.find(m => m.type === 'error').error;
        expect(err).toMatchObject({ name: 'DataError', code: 'AUTH', action: 'checkKey', retryable: false, step: 'account' });
        expect(err.message).not.toContain(KEY);
        expect(err.message).toContain('•••');
    });

    it('runs engine methods once a dataset is loaded, and refuses before', async () => {
        const { call, engineCalls } = harness();
        const early = await call(1, 'runScenario', { id: 'S01' });
        expect(early[0].error.code).toBe('NO_DATASET');
        await call(2, 'loadDataset', { kind: 'demo' });
        const run = await call(3, 'runScenario', { id: 'S01' }, { withBand: false });
        expect(run[0]).toEqual({ type: 'result', id: 3, value: { id: 'S01', savings: 165 } });
        expect(engineCalls[0]).toEqual(['runScenario', { id: 'S01' }, { withBand: false }]);
        const ins = await call(4, 'insights');
        expect(ins[0].value.heatmap.load).toBeInstanceOf(Float32Array);
        const sb = await call(5, 'setProjectBaseW', 350);
        expect(sb[0].value).toBe(true);
        expect(engineCalls.at(-1)).toEqual(['setProjectBaseW', 350]);
        await call(6, 'setProjectBaseW', null);
        expect(engineCalls.at(-1)).toEqual(['setProjectBaseW', null]);
    });

    it('verdict streams partial verdicts as progress and resolves ids for baseLoadCurve', async () => {
        const { call } = harness();
        await call(1, 'loadDataset', { kind: 'demo' });
        const out = await call(2, 'verdict', {});
        const stages = out.filter(m => m.type === 'progress').map(m => m.value.stage);
        expect(stages).toEqual(['usage', 'plugin']);
        expect(out.at(-1).value.bestBuyId).toBe('S01');
        const curve = await call(3, 'baseLoadCurve', ['S01', 'missing', { id: 'X' }], [0, 500]);
        expect(curve[0].value.map(c => c.id)).toEqual(['S01', 'X']);
    });

    it('throttles chatty progress but always delivers the final 100%', async () => {
        const { call } = harness();
        await call(1, 'loadDataset', { kind: 'demo' });
        const out = await call(2, 'orientationSweep', { id: 'S01' }, 'a1');
        const pcts = out.filter(m => m.type === 'progress').map(m => m.value.pct);
        expect(pcts[0]).toBe(0);
        expect(pcts.at(-1)).toBe(100);
        expect(pcts.length).toBeLessThan(11);
        expect(out.at(-1).type).toBe('result');
    });

    it('cancellation is cooperative: the next progress callback throws an AbortError', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const { d, msgs } = harness({
            './dataset.js': {
                async loadDataset(spec, ctx) {
                    ctx.onProgress({ step: 'usage', status: 'start' });
                    await gate;
                    ctx.onProgress({ step: 'usage', status: 'done' });   // throws: cancelled
                    return { id: 'never', n: 1 };
                },
                summarize: ds => ds,
            },
        });
        const p = d.handle({ type: 'call', id: 7, method: 'loadDataset', args: [{ kind: 'demo' }] });
        await new Promise(r => setTimeout(r, 0));
        await d.handle({ type: 'cancel', id: 7 });
        release();
        await p;
        const out = msgs.filter(m => m.id === 7);
        expect(out.filter(m => m.type === 'progress')).toHaveLength(1);
        expect(out.at(-1).type).toBe('error');
        expect(out.at(-1).error.name).toBe('AbortError');
        expect(d.state().hasDataset).toBe(false);
    });

    it('reports a missing module clearly and keeps the dataset when only the engine is missing', async () => {
        const { call, d } = harness({ './core.js': null });
        const out = await call(1, 'loadDataset', { kind: 'demo' });
        expect(out.at(-1).value).toEqual({ id: 'ds-1', n: 17520, fromSummarize: true, engineUnavailable: true });
        expect(d.state()).toEqual({ hasDataset: true, hasEngine: false });
        const ins = await call(2, 'insights');
        expect(ins[0].value).toEqual({ fromInsights: 'ds-1' });
        const run = await call(3, 'runScenario', { id: 'S01' });
        expect(run[0].error.code).toBe('ENGINE_UNAVAILABLE');

        const h2 = harness({ './verdict.js': null });
        await h2.call(1, 'loadDataset', { kind: 'demo' });
        const v = await h2.call(2, 'verdict', {});
        expect(v[0].error.code).toBe('MISSING_MODULE');
        expect(v[0].error.message).toContain('js/verdict.js');
    });

    it('catalog() sends plain data without functions and caches the load', async () => {
        const { call, catalogLoader } = harness();
        const a = await call(1, 'catalog');
        const b = await call(2, 'catalog');
        expect(a[0].value).toEqual({ kits: [{ id: 'k1' }], stations: [], bundles: [], constants: { plugInRules: { acMaxVA: 800 } } });
        expect(b[0].value).toEqual(a[0].value);
        expect(catalogLoader).toHaveBeenCalledTimes(1);
    });

    it('normalizeSystem / validate / applyFix work without a dataset', async () => {
        const { call } = harness();
        expect((await call(1, 'normalizeSystem', { id: 'x' }))[0].value).toEqual({ id: 'x', normalized: 'system' });
        expect((await call(2, 'validate', { id: 'x' }))[0].value).toEqual({ legal: 'check' });
        expect((await call(3, 'applyFix', { id: 'x' }, 'makeHardwired'))[0].value).toEqual({ id: 'x', fixed: 'makeHardwired' });
        await call(4, 'loadDataset', { kind: 'demo' });
        expect((await call(5, 'normalizeSystem', { id: 'y' }))[0].value).toEqual({ id: 'y', normalized: 'engine' });
    });

    it('turns an uncloneable result into an error instead of crashing', async () => {
        const msgs = [];
        const m = stubModules({ './system.js': { normalizeSystem: () => ({ fn() {} }) } });
        const d = createDispatcher({ post: msg => msgs.push(structuredClone(msg)), importer: m.importer, catalogLoader: m.catalogLoader });
        await d.handle({ type: 'call', id: 1, method: 'normalizeSystem', args: [{}] });
        expect(msgs[0].type).toBe('error');
        expect(msgs[0].error.code).toBe('UNCLONEABLE');
    });
});

describe('helpers', () => {
    it('serializeError handles non-errors and uncloneable choices', () => {
        expect(serializeError('boom')).toMatchObject({ name: 'Error', message: 'boom', code: null });
        const e = serializeError({ name: 'DataError', message: 'x', choices: [{ number: 'A-1' }] });
        expect(e.choices).toEqual([{ number: 'A-1' }]);
        expect(reviveError(e)).toBeInstanceOf(Error);
        expect(reviveError(e).name).toBe('DataError');
    });

    it('guarded fetch only reaches allow-listed hosts and never sends cookies', async () => {
        const seen = [];
        const gf = makeGuardedFetch(async (url, init) => { seen.push([String(url), init.credentials]); return new Response('{}'); });
        await gf('https://api.octopus.energy/v1/products/');
        await gf('https://satellite-api.open-meteo.com/v1/archive?x=1');
        await gf('https://api.postcodes.io/postcodes/SW1A1AA');
        await expect(gf('https://evil.example.com/steal')).rejects.toThrow(/Blocked/);
        await expect(gf('http://api.octopus.energy/v1/')).rejects.toThrow(/Blocked/);
        expect(seen.every(([, c]) => c === 'omit')).toBe(true);
        expect(seen).toHaveLength(3);
    });
});

describe('engine client (inline mode)', () => {
    it('calls, streams progress, and revives errors', async () => {
        const m = stubModules();
        const { createDispatcher: real } = await import('../../../projects/solar-calculator/js/worker.js');
        const engine = createEngine({ createDispatcher: opts => real({ ...opts, importer: m.importer, catalogLoader: m.catalogLoader }) });
        expect(engine.mode).toBe('inline');
        const seen = [];
        const summary = await engine.call('loadDataset', { kind: 'demo' }, { onProgress: p => seen.push(p.step) });
        expect(summary.id).toBe('ds-1');
        expect(seen).toEqual(['account', 'account', 'usage']);
        await expect(engine.call('nope')).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
        await expect(engine.call('loadDataset', { kind: 'octopus', apiKey: KEY, fail: true })).rejects.toMatchObject({ name: 'DataError', code: 'AUTH' });
        expect(await engine.ready).toBe('inline');
    });

    it('a plain object last argument is an argument, not options', async () => {
        const m = stubModules();
        const { createDispatcher: real } = await import('../../../projects/solar-calculator/js/worker.js');
        const engine = createEngine({ createDispatcher: opts => real({ ...opts, importer: m.importer, catalogLoader: m.catalogLoader }) });
        await engine.call('loadDataset', { kind: 'demo' });
        await engine.call('runScenario', { id: 'S01' }, { withBand: false });
        expect(m.engineCalls[0][2]).toEqual({ withBand: false });
    });

    it('cancel() rejects at once with AbortError and late results are dropped', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const m = stubModules({ './system.js': { normalizeSystem: async p => { await gate; return p; } } });
        const { createDispatcher: real } = await import('../../../projects/solar-calculator/js/worker.js');
        const engine = createEngine({ createDispatcher: opts => real({ ...opts, importer: m.importer, catalogLoader: m.catalogLoader }) });
        const job = engine.call('normalizeSystem', { id: 'slow' });
        expect(typeof job.cancel).toBe('function');
        job.cancel();
        await expect(job).rejects.toMatchObject({ name: 'AbortError' });
        release();
        await new Promise(r => setTimeout(r, 5));
        // AbortSignal works too
        const ac = new AbortController();
        const job2 = engine.call('normalizeSystem', { id: 'slow2' }, { signal: ac.signal });
        ac.abort();
        await expect(job2).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects functions in arguments like postMessage would', async () => {
        const m = stubModules();
        const { createDispatcher: real } = await import('../../../projects/solar-calculator/js/worker.js');
        const engine = createEngine({ createDispatcher: opts => real({ ...opts, importer: m.importer, catalogLoader: m.catalogLoader }) });
        await expect(engine.call('normalizeSystem', { cb() {} })).rejects.toThrow();
    });

    it('terminate() rejects everything pending', async () => {
        const m = stubModules({ './system.js': { normalizeSystem: () => new Promise(() => {}) } });
        const { createDispatcher: real } = await import('../../../projects/solar-calculator/js/worker.js');
        const engine = createEngine({ createDispatcher: opts => real({ ...opts, importer: m.importer, catalogLoader: m.catalogLoader }) });
        const job = engine.call('normalizeSystem', {});
        engine.terminate();
        await expect(job).rejects.toMatchObject({ code: 'TERMINATED' });
        await expect(engine.call('catalog')).rejects.toMatchObject({ code: 'TERMINATED' });
    });
});

describe('real modules', () => {
    it('loads the shipped demo through the dispatcher', async () => {
        const msgs = [];
        const d = createDispatcher({ post: msg => msgs.push(msg) });
        await d.handle({ type: 'call', id: 1, method: 'loadDataset', args: [{ kind: 'demo', serverW: 500 }] });
        const res = msgs.find(m => m.id === 1 && m.type !== 'progress');
        expect(res.type, JSON.stringify(res.error)).toBe('result');
        expect(res.value.n).toBe(17520);
        expect(msgs.some(m => m.type === 'progress' && m.value.step === 'usage')).toBe(true);
        expect(d.state().hasDataset).toBe(true);
    }, 30000);
});

describe('worker-side safety', () => {
    it('scrubs the API key from progress text as well as from errors', async () => {
        const { call } = harness({
            './dataset.js': {
                async loadDataset(spec, ctx) {
                    ctx.onProgress({ step: 'account', status: 'error', detail: `401 for key ${spec.apiKey}` });
                    return { id: 'ds-k', n: 48 };
                },
                summarize: ds => ds,
            },
        });
        const out = await call(1, 'loadDataset', { kind: 'octopus', apiKey: KEY });
        const p = out.find(m => m.type === 'progress');
        expect(p.value.detail).toBe('401 for key •••');
        expect(JSON.stringify(out)).not.toContain(KEY);
    });

    it('a load the page cancelled after it committed (result already in flight) is rolled back', async () => {
        // Race: load B finishes in the worker and posts its result, but the page cancels B (a newer
        // load started) before that result arrives, so the page drops it and keeps showing A. The
        // worker must not keep answering with B's engine.
        const built = [];
        const m = stubModules({
            './dataset.js': { async loadDataset(spec) { return { id: spec.tag, n: 48 }; }, summarize: ds => ds },
        });
        const msgs = [];
        const d = createDispatcher({
            post: msg => msgs.push(structuredClone(msg)),
            importer: async spec => {
                const mod = await m.importer(spec);
                if (spec !== './core.js') return mod;
                return { SolarEngine: class extends mod.SolarEngine { constructor(ds, c) { super(ds, c); built.push(ds.id); } insights() { return { of: this.ds.id }; } } };
            },
            catalogLoader: m.catalogLoader,
        });
        const run = async (id, method, ...args) => { await d.handle({ type: 'call', id, method, args }); return msgs.filter(x => x.id === id).at(-1); };
        await run(1, 'loadDataset', { tag: 'A' });
        expect((await run(2, 'loadDataset', { tag: 'B' })).value.id).toBe('B');
        await d.handle({ type: 'cancel', id: 2 });
        expect((await run(3, 'insights')).value).toEqual({ of: 'A' });
        // A repeated cancel, or a cancel of a non-load call, changes nothing.
        await d.handle({ type: 'cancel', id: 2 });
        await d.handle({ type: 'cancel', id: 3 });
        expect((await run(4, 'insights')).value).toEqual({ of: 'A' });
        // A later load that isn't cancelled sticks.
        await run(5, 'loadDataset', { tag: 'C' });
        expect((await run(6, 'insights')).value).toEqual({ of: 'C' });
        expect(built).toEqual(['A', 'B', 'C']);
    });
});

describe('wave D1b: worker methods', () => {
    function engineHarness(extra = {}, overrides = {}) {
        const seen = [];
        class Engine {
                    constructor(ds) { this.ds = ds; }
                    get summary() { return { id: this.ds.id }; }
                    autoScenarios() { return [{ id: 'S01' }]; }
                    answerOrientation(sys, opts) { seen.push(['answerOrientation', sys.id, opts]); return { best: { az: 210 } }; }
                    upsStrategies(sys, opts) { seen.push(['upsStrategies', sys.id, opts]); return { realisticGbp: 102 }; }
                    tornado(sys, opts) { seen.push(['tornado', sys.id, opts]); return { rows: [] }; }
                    weatherInfo() { seen.push(['weatherInfo']); return { pctVsAverage: 12 }; }
                    panelCountCurve(sys, opts) { seen.push(['panelCountCurve', sys.id, opts]); return []; }
                    batterySizeCurve(sys, opts) { seen.push(['batterySizeCurve', sys.id, opts]); return []; }
                    baseLoadCurve(systems, xs, opts) { seen.push(['baseLoadCurve', systems.map(x => x.id), xs, opts]); return []; }
        }
        Object.assign(Engine.prototype, extra);
        const m = stubModules({ './core.js': { SolarEngine: Engine }, ...overrides });
        const msgs = [];
        const d = createDispatcher({ post: msg => msgs.push(structuredClone(msg)), importer: m.importer, catalogLoader: m.catalogLoader });
        const call = async (id, method, ...args) => { await d.handle({ type: 'call', id, method, args }); return msgs.filter(x => x.id === id); };
        return { d, msgs, call, seen };
    }

    it('whitelists answerOrientation, upsStrategies, tornado and weatherInfo', async () => {
        const { call, seen } = engineHarness();
        await call(1, 'loadDataset', { kind: 'demo' });
        const fin = { finance: { discountRate: 0.05 } };
        expect((await call(2, 'answerOrientation', { id: 'S05' }, { ...fin, flips: false })).at(-1).value).toEqual({ best: { az: 210 } });
        expect((await call(3, 'upsStrategies', { id: 'U1' }, fin)).at(-1).value).toEqual({ realisticGbp: 102 });
        expect((await call(4, 'tornado', { id: 'S05' }, { ...fin, top: 3 })).at(-1).value).toEqual({ rows: [] });
        expect((await call(5, 'weatherInfo')).at(-1).value).toEqual({ pctVsAverage: 12 });
        expect(seen).toEqual([
            ['answerOrientation', 'S05', { finance: { discountRate: 0.05 }, flips: false }],
            ['upsStrategies', 'U1', fin],
            ['tornado', 'S05', { ...fin, top: 3 }],
            ['weatherInfo'],
        ]);
        // a missing options argument reaches the engine as {}
        await call(6, 'tornado', { id: 'S05' });
        expect(seen.at(-1)).toEqual(['tornado', 'S05', {}]);
    });

    it('forwards an optional { finance } to the three curves', async () => {
        const { call, seen } = engineHarness();
        await call(1, 'loadDataset', { kind: 'demo' });
        await call(2, 'autoScenarios');
        const fin = { finance: { escalation: 0.03, vatReturns: false } };
        await call(3, 'panelCountCurve', { id: 'S01' }, fin);
        await call(4, 'batterySizeCurve', { id: 'H1' }, fin);
        await call(5, 'baseLoadCurve', ['S01', { id: 'X' }], [0, 500], fin);
        await call(6, 'baseLoadCurve', ['S01'], null, fin);
        await call(7, 'panelCountCurve', { id: 'S01' });
        expect(seen).toEqual([
            ['panelCountCurve', 'S01', fin],
            ['batterySizeCurve', 'H1', fin],
            ['baseLoadCurve', ['S01', 'X'], [0, 500], fin],
            ['baseLoadCurve', ['S01'], undefined, fin],
            ['panelCountCurve', 'S01', {}],
        ]);
    });

    it('verdict forwards overrides and an isCancelled hook that flips when the call is cancelled', async () => {
        let release;
        const gate = new Promise(r => { release = r; });
        const got = {};
        const { d, msgs } = engineHarness({}, {
            './verdict.js': {
                async buildVerdict(engine, opts) {
                    got.overrides = opts.overrides;
                    got.hasKey = 'overrides' in opts;
                    got.before = opts.isCancelled();
                    if (got.overrides) await gate;
                    got.after = opts.isCancelled();
                    return { stoppedEarly: opts.isCancelled() };
                },
            },
        });
        await d.handle({ type: 'call', id: 1, method: 'loadDataset', args: [{ kind: 'demo' }] });
        const ov = { S05: { priceGbp: 400, costs: [{ label: 'Kit', gbp: 400, year: 0, kind: 'hardware' }] } };
        const p = d.handle({ type: 'call', id: 2, method: 'verdict', args: [{ overrides: ov, finance: {} }] });
        await new Promise(r => setTimeout(r, 0));
        await d.handle({ type: 'cancel', id: 2 });
        release();
        await p;
        expect(got).toEqual({ overrides: ov, hasKey: true, before: false, after: true });
        expect(msgs.filter(m => m.id === 2).at(-1).error.name).toBe('AbortError');
        // no overrides → no overrides key at all, and an uncancelled run reports false throughout
        await d.handle({ type: 'call', id: 3, method: 'verdict', args: [{}] });
        expect(got).toMatchObject({ hasKey: false, before: false, after: false });
        expect(msgs.filter(m => m.id === 3).at(-1).value).toEqual({ stoppedEarly: false });
    });

    it('catalog() also carries electrician, limits, parts and the station defaults', async () => {
        const msgs = [];
        const d = createDispatcher({ post: msg => msgs.push(msg) });
        await d.handle({ type: 'call', id: 1, method: 'catalog', args: [] });
        const cat = msgs.find(m => m.id === 1).value;
        expect(Object.keys(cat).sort()).toEqual(['bundles', 'constants', 'electrician', 'kits', 'limits', 'parts', 'stationDefaults', 'stations']);
        expect(cat.electrician.gbp).toBeGreaterThan(0);
        expect(cat.limits.plugin.acMaxW).toBe(800);
        expect(cat.parts.panel?.id).toBeTruthy();
        expect(() => structuredClone(cat)).not.toThrow();
    });

    it('buildSystem builds kits, bundles, stations and a blank build the way Design does', async () => {
        const msgs = [];
        const d = createDispatcher({ post: msg => msgs.push(msg) });
        let id = 0;
        const call = async (method, ...args) => { id += 1; await d.handle({ type: 'call', id, method, args }); return msgs.filter(m => m.id === id).at(-1); };
        const cat = (await call('catalog')).value;
        const kits = await import('../../../projects/solar-calculator/js/kits.js');
        const full = cat;   // the plain normalised catalog (findProduct works on it)
        const spot = { id: 'roof', kind: 'flatroof', azimuth: 200, tilt: 30, shadingPct: 3, horizon: [] };

        // a kit sold with panels: exactly kitToSystem
        const plug = cat.kits.find(k => k.kind === 'microinverter' && k.includedPanels && k.octopus);
        const a = (await call('buildSystem', { kind: 'kit', id: plug.id, opts: { id: 'draft', spot } })).value;
        expect(a).toEqual(JSON.parse(JSON.stringify(kits.kitToSystem(plug, { catalog: full, spot, id: 'draft', dsSource: 'octopus' }))));
        expect(a.export.kind).toBe('prime');

        // an all-in-one battery unit: one loose catalog panel per solar input (1–4), framed on a flat roof
        const unit = cat.kits.find(k => k.kind === 'battery-inverter' && k.inputs.length >= 2);
        const b = (await call('buildSystem', { kind: 'kit', id: unit.id, opts: { spot } })).value;
        const n = Math.min(4, unit.inputs.length);
        expect(b.name).toBe(`${unit.name} + ${n} panels`);
        expect(b.arrays.reduce((t, x) => t + x.count, 0)).toBe(n);
        expect(b.sourceIds).toEqual([unit.id, cat.parts.panel.id, cat.parts.frame.id]);
        // an explicit panel count wins, and the name is singular for one
        const b1 = (await call('buildSystem', { kind: 'kit', id: unit.id, opts: { spot, panels: 1 } })).value;
        expect(b1.name).toBe(`${unit.name} + 1 panel`);

        // a station with two of its own panels; a bundle; a blank build
        const st = cat.stations.find(x => x.pvWireablePanels >= 2);
        const c = (await call('buildSystem', { kind: 'station', id: st.id, opts: { panels: 2, spot, strategy: 'optimal' } })).value;
        expect(c.route).toBe('ups');
        expect(c.battery.strategy).toBe('optimal');
        expect(c.battery.ups.pvArrays.reduce((t, x) => t + x.count, 0)).toBe(2);
        const bun = cat.bundles[0];
        const e = (await call('buildSystem', { kind: 'bundle', id: bun.id, opts: { spot } })).value;
        expect(e).toEqual(JSON.parse(JSON.stringify(kits.bundleToSystem(bun.id, { catalog: full, spot }))));
        const blank = (await call('buildSystem', { kind: 'blank', opts: { id: 'draft', spot } })).value;
        expect(blank).toMatchObject({ id: 'draft', route: 'plugin', name: 'My own plug-in build' });
        expect(blank.arrays.map(x => [x.azimuth, x.tilt, x.input])).toEqual([[200, 30, 0], [200, 30, 1]]);

        // bad requests
        expect((await call('buildSystem', { kind: 'kit', id: 'no-such-kit' })).error.code).toBe('UNKNOWN_PRODUCT');
        expect((await call('buildSystem', { kind: 'station', id: plug.id })).error.code).toBe('UNKNOWN_PRODUCT');   // right id, wrong kind
        expect((await call('buildSystem', { kind: 'spaceship', id: 'x' })).error.code).toBe('BAD_SPEC');
        expect((await call('buildSystem', null)).error.code).toBe('BAD_SPEC');
    });

    it('review: buildSystem cleans awkward panel counts, wattages and prices instead of failing with a bare RangeError', async () => {
        const msgs = [];
        const d = createDispatcher({ post: msg => msgs.push(msg) });
        let id = 0;
        const call = async (method, ...args) => { id += 1; await d.handle({ type: 'call', id, method, args }); return msgs.filter(m => m.id === id).at(-1); };
        const cat = (await call('catalog')).value;
        const micro = cat.kits.find(k => k.kind === 'microinverter' && !k.includedPanels);
        const unit = cat.kits.find(k => k.kind === 'battery-inverter');
        const st = cat.stations.find(x => x.pvWireablePanels >= 2);
        const panelsOf = v => [...v.arrays, ...(v.battery?.ups?.pvArrays || [])];
        const count = v => panelsOf(v).reduce((t, a) => t + a.count, 0);
        const sane = v => panelsOf(v).every(a => Number.isInteger(a.count) && a.wp > 0) && v.costs.every(c => Number.isFinite(c.gbp));
        const cases = [
            [{ kind: 'kit', id: unit.id, opts: { panels: { count: 2.6 } } }, 3],     // was: RangeError "Invalid array length"
            [{ kind: 'kit', id: unit.id, opts: { panels: { count: 'x', wp: 'abc' } } }, Math.min(4, unit.inputs.length)],
            [{ kind: 'kit', id: micro.id, opts: { panels: NaN } }, 2],
            [{ kind: 'kit', id: micro.id, opts: { panels: '3', priceGbp: 'abc' } }, 3],
            [{ kind: 'station', id: st.id, opts: { panels: { count: 1.4, wp: -5 } } }, 1],
            [{ kind: 'station', id: st.id, opts: { panels: NaN } }, 0],
            [{ kind: 'blank', opts: { panels: NaN } }, 2],                            // was: RangeError
            [{ kind: 'blank', opts: { panels: { count: 3, wp: 'abc' }, priceGbp: -1, spot: { azimuth: 90, tilt: 90, kind: 'wall', horizon: 'bad' } } }, 3],
        ];
        for (const [req, want] of cases) {
            const r = await call('buildSystem', req);
            expect(r.type, JSON.stringify(req)).toBe('result');
            expect(count(r.value), JSON.stringify(req)).toBe(want);
            expect(sane(r.value), JSON.stringify(req)).toBe(true);
        }
        // a bad price falls back to the catalog's; a good one is used
        const dflt = (await call('buildSystem', { kind: 'kit', id: micro.id })).value.costs[0].gbp;
        expect((await call('buildSystem', { kind: 'kit', id: micro.id, opts: { priceGbp: 'abc' } })).value.costs[0].gbp).toBe(dflt);
        expect((await call('buildSystem', { kind: 'blank', opts: { priceGbp: -1 } })).value.costs[0].gbp).toBe(600);
        expect((await call('buildSystem', { kind: 'blank', opts: { priceGbp: 455 } })).value.costs[0].gbp).toBe(455);
    });

    it('buildSystem takes the dataset source for the export default (a CSV dataset gets no Prime)', async () => {
        const msgs = [];
        const m = stubModules({ './dataset.js': { async loadDataset() { return { id: 'csv-1', n: 48, meta: { source: 'csv' } }; }, summarize: ds => ds } });
        const realMods = {
            './kits.js': () => import('../../../projects/solar-calculator/js/kits.js'),
            './system.js': () => import('../../../projects/solar-calculator/js/system.js'),
        };
        const importer = spec => (realMods[spec] ? realMods[spec]() : m.importer(spec));
        const d = createDispatcher({ post: msg => msgs.push(msg), importer });
        await d.handle({ type: 'call', id: 1, method: 'loadDataset', args: [{ kind: 'csv' }] });
        await d.handle({ type: 'call', id: 2, method: 'catalog', args: [] });
        const plug = msgs.find(x => x.id === 2).value.kits.find(k => k.kind === 'microinverter' && k.includedPanels && k.octopus);
        await d.handle({ type: 'call', id: 3, method: 'buildSystem', args: [{ kind: 'kit', id: plug.id }] });
        expect(msgs.find(x => x.id === 3).value.export.kind).toBe('none');
        await d.handle({ type: 'call', id: 4, method: 'buildSystem', args: [{ kind: 'kit', id: plug.id, opts: { dsSource: 'demo' } }] });
        expect(msgs.find(x => x.id === 4).value.export.kind).toBe('prime');
    });
});

/*
 * A stand-in for a browser module Worker: it runs the real dispatcher (with stub modules) "in
 * another thread" — every message is structured-cloned and delivered on a later task, like
 * postMessage — so engine.js's worker-mode code path runs as it does in the browser.
 */
function installFakeWorker({ failBeforeReady = false, classicOnly = false } = {}) {
    const created = [];
    class FakeWorker extends EventTarget {
        constructor(url, opts) {
            super();
            this.url = String(url);
            this.type = opts?.type;              // reading opts.type is engine.js's feature test
            this.sent = [];
            this.terminated = false;
            created.push(this);
            const m = stubModules();
            this.dispatcher = createDispatcher({
                post: msg => {
                    const c = structuredClone(msg);
                    setTimeout(() => { if (!this.terminated) this.dispatchEvent(Object.assign(new Event('message'), { data: c })); }, 0);
                },
                importer: m.importer, catalogLoader: m.catalogLoader,
            });
            setTimeout(() => {
                if (failBeforeReady) this.dispatchEvent(Object.assign(new Event('error', { cancelable: true }), { message: 'SyntaxError in worker.js' }));
                else this.dispatchEvent(Object.assign(new Event('message'), { data: { type: 'ready' } }));
            }, 0);
        }
        postMessage(msg) {
            const c = structuredClone(msg);      // throws DataCloneError for functions, like the real thing
            this.sent.push(c);
            if (!failBeforeReady) setTimeout(() => { if (!this.terminated) this.dispatcher.handle(c); }, 0);
        }
        terminate() { this.terminated = true; }
    }
    // A browser without module workers never reads `type` from the options bag.
    globalThis.Worker = classicOnly ? class extends FakeWorker { constructor(url) { super(url, {}); } } : FakeWorker;
    return { created, restore: () => { delete globalThis.Worker; } };
}

describe('engine client (worker mode, fake Worker)', () => {
    it('ready handshake, results with typed arrays, progress, cancel message, clone errors', async () => {
        const fw = installFakeWorker();
        try {
            const engine = createEngine();
            expect(engine.mode).toBe('worker');
            expect(fw.created[0].url).toMatch(/\/js\/worker\.js$/);
            expect(fw.created[0].type).toBe('module');
            expect(await engine.ready).toBe('worker');
            const steps = [];
            const summary = await engine.call('loadDataset', { kind: 'demo' }, { onProgress: p => steps.push(p.step) });
            expect(summary).toEqual({ id: 'ds-1', n: 17520, days: 365 });
            expect(steps).toEqual(['account', 'account', 'usage']);
            expect((await engine.call('insights')).heatmap.load).toBeInstanceOf(Float32Array);
            // cancel(): rejects at once and tells the worker
            const job = engine.call('orientationSweep', { id: 'S01' }, 'a1');
            job.cancel();
            await expect(job).rejects.toMatchObject({ name: 'AbortError' });
            expect(fw.created[0].sent.at(-1)).toEqual({ type: 'cancel', id: job.id });
            // functions can't cross: postMessage's clone throws, the call rejects
            await expect(engine.call('normalizeSystem', { f() {} })).rejects.toThrow();
            // and the worker keeps working afterwards
            expect(await engine.call('normalizeSystem', { id: 'z' })).toEqual({ id: 'z', normalized: 'engine' });
            engine.terminate();
            expect(fw.created[0].terminated).toBe(true);
        } finally { fw.restore(); }
    });

    it('fails over to inline mode when the worker dies before it is ready, replaying pending calls', async () => {
        const fw = installFakeWorker({ failBeforeReady: true });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const engine = createEngine();
            expect(engine.mode).toBe('worker');
            // Both were posted to the dying worker; the real inline dispatcher must answer them.
            const unknown = engine.call('nope');
            const sys = engine.call('normalizeSystem', { name: 'Balcony' });
            await expect(unknown).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
            const out = await sys;
            expect(out.name).toBe('Balcony');
            expect(Array.isArray(out.arrays)).toBe(true);
            expect(engine.mode).toBe('inline');
            expect(await engine.ready).toBe('inline');
            expect(fw.created[0].terminated).toBe(true);
            expect(info.mock.calls.some(c => /worker failed to start/.test(String(c[0])))).toBe(true);
        } finally { fw.restore(); info.mockRestore(); }
    });

    it('uses the inline engine when module workers are unsupported', async () => {
        const fw = installFakeWorker({ classicOnly: true });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const engine = createEngine();
            expect(engine.mode).toBe('inline');
            expect(fw.created[0].terminated).toBe(true);
            await expect(engine.call('nope')).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' });
        } finally { fw.restore(); info.mockRestore(); }
    });

    it('an error after ready is logged, not failed over', async () => {
        const fw = installFakeWorker();
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const engine = createEngine();
            await engine.ready;
            fw.created[0].dispatchEvent(Object.assign(new Event('error'), { message: 'late' }));
            expect(engine.mode).toBe('worker');
            expect(await engine.call('normalizeSystem', { id: 'q' })).toEqual({ id: 'q', normalized: 'system' });
            expect(err).toHaveBeenCalled();
        } finally { fw.restore(); err.mockRestore(); }
    });
});
