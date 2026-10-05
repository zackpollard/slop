/*
 * worker.js — hosts the engine off the main thread (contract §16).
 *
 * The Dataset and the SolarEngine live here and never cross to the page: the page sees summaries
 * and results only. That keeps the 17,520-slot arrays out of the UI thread, and it means the
 * Octopus API key, once posted in a `loadDataset` spec, is only ever used by fetches made from
 * this scope — which `guardedFetch` restricts to the APIs the app actually talks to.
 *
 * The same dispatcher runs inline (engine.js imports it) when module workers are unavailable,
 * so nothing here may assume a worker global except the bootstrap at the bottom.
 *
 * Protocol:  main → worker  { type: 'call', id, method, args } | { type: 'cancel', id }
 *            worker → main  { type: 'ready' } | { type: 'progress', id, value } | { type: 'result', id, value } | { type: 'error', id, error }
 * Cancellation is cooperative: a cancelled call throws at its next progress callback (and its
 * fetches are aborted); the verdict also polls an isCancelled() hook between options; synchronous
 * engine work that never reports progress runs to completion and its result is dropped.
 *
 * Methods (whitelist): loadDataset, ensureEngine, insights, runScenario, autoScenarios, verdict,
 * orientationSweep, answerOrientation, upsStrategies, tornado, weatherInfo, baseLoadCurve,
 * panelCountCurve, batterySizeCurve, typicalDay, exportCsv, setProjectBaseW, normalizeSystem,
 * validate, applyFix, catalog, buildSystem.
 *
 * Flaky networks: a module or catalog file that fails to download must not strand the page.
 *  - A failed dynamic import is remembered by the module map for the life of the worker, so asking
 *    for the same URL again fails at once without a request. need() retries under a URL the map
 *    hasn't seen (`?retry=n`) and remembers whichever import worked.
 *  - A dataset whose engine couldn't be built (the product list didn't download) is still kept —
 *    usage insights work without it — and every engine method rebuilds the engine on demand, so a
 *    later call (or `ensureEngine`, which the page uses to recover) succeeds once the network does.
 */

const MODULES = {
    dataset: './dataset.js',
    core: './core.js',
    kits: './kits.js',
    verdict: './verdict.js',
    rules: './rules.js',
    system: './system.js',
    insights: './insights.js',
    cache: './cache.js',
};

/* Every host the engine legitimately fetches from (mirrors the CSP connect-src in index.html). */
const ALLOWED_HOSTS = [/^api\.octopus\.energy$/, /(^|\.)open-meteo\.com$/, /^api\.postcodes\.io$/];
const PROGRESS_MIN_MS = 80;

/** Error type for engine/transport problems (DataError from dataset.js covers data problems). */
export class EngineError extends Error {
    /** @param {string} code @param {string} message @param {object} [extra] */
    constructor(code, message, extra = {}) {
        super(message);
        this.name = 'EngineError';
        this.code = code;
        Object.assign(this, extra);
    }
}

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError', code: 'CANCELLED' });

/* Usage that isn't meter readings: the example household, or a profile built from typed-in figures. */
const SYNTHETIC_SOURCES = new Set(['demo', 'manual']);

/**
 * Mark a coverage object ({ realPct, filledSlots, … }) whose usage is synthetic, so the page never
 * calls it "100% real readings": `synthetic` is 'demo' (the example household) or 'manual' (a
 * typical profile from the user's own figures). Readings from Octopus or a CSV are left alone.
 * @param {object|null|undefined} coverage
 * @param {string|null|undefined} source DatasetSummary.source
 * @returns {object|null|undefined} a new object when marked, else the input
 */
export function markUsageBasis(coverage, source) {
    if (!coverage || typeof coverage !== 'object' || !SYNTHETIC_SOURCES.has(source)) return coverage;
    return { ...coverage, synthetic: source };
}

const withUsageBasis = (summary, source = summary?.source) =>
    (summary && typeof summary === 'object' && summary.coverage ? { ...summary, coverage: markUsageBasis(summary.coverage, source) } : summary);

const plain = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
/* An optional trailing options object ({ finance, … }) — anything else becomes {}. */
const bag = o => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});

/**
 * Replace every occurrence of a secret (≥ 6 chars, e.g. the API key) in a string.
 * @param {any} text
 * @param {Iterable<string>} secrets
 * @returns {string}
 */
export function redactText(text, secrets = []) {
    let out = String(text ?? '');
    for (const k of secrets) if (k && k.length >= 6) out = out.split(k).join('•••');
    return out;
}

/**
 * Serialise any thrown value for postMessage, with secrets (the API key) scrubbed from the text.
 * @param {any} err
 * @param {Iterable<string>} [secrets]
 * @returns {{ name: string, code: string|null, message: string, step: string|null, retryable: boolean|null, action: string|null, choices: any[]|null }}
 */
export function serializeError(err, secrets = []) {
    const e = err && typeof err === 'object' ? err : { message: String(err) };
    const redact = s => redactText(s, secrets);
    let choices = null;
    try { choices = e.choices == null ? null : plain(e.choices); } catch { choices = null; }
    return {
        name: e.name || 'Error',
        code: e.code ?? null,
        message: redact(e.message || 'Something went wrong.'),
        step: e.step ?? null,
        retryable: typeof e.retryable === 'boolean' ? e.retryable : null,
        action: e.action ?? null,
        choices,
    };
}

async function readLocalFile(url) {
    // Only reachable from node (tests): browsers never hand us a file: URL.
    const fs = await import('node:fs/promises');
    const body = await fs.readFile(url);
    return new Response(body, { status: 200, headers: { 'content-type': url.pathname.endsWith('.json') ? 'application/json' : 'text/plain' } });
}

/**
 * Wrap fetch so engine code can only reach same-origin files and the allow-listed APIs, and
 * never sends cookies.
 * @param {typeof fetch} fetchImpl
 * @returns {typeof fetch}
 */
export function makeGuardedFetch(fetchImpl) {
    return async function guardedFetch(input, init = {}) {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
        const base = typeof location !== 'undefined' ? location.href : undefined;
        let url;
        try { url = new URL(raw, base); } catch { throw new TypeError(`Bad URL: ${raw}`); }
        if (url.protocol === 'file:') return readLocalFile(url);
        const sameOrigin = typeof location !== 'undefined' && url.origin === location.origin;
        if (!sameOrigin && !(url.protocol === 'https:' && ALLOWED_HOSTS.some(r => r.test(url.hostname)))) {
            throw new TypeError(`Blocked request to ${url.host} (not an allowed data source)`);
        }
        return fetchImpl(input, { ...init, credentials: 'omit' });
    };
}

const BUILD_KINDS = new Set(['kit', 'bundle', 'station', 'blank']);

/**
 * Build a System from a catalog product — or a blank custom plug-in build — exactly the way the
 * Design view's "Start from" does, so views never have to load and normalise the catalog on the
 * main thread. Pure: the kits.js / system.js exports and the normalised catalog are passed in.
 *
 * Defaults (all overridable through `opts`):
 *  - kit: an add-on battery comes alone; an all-in-one battery unit gets one loose catalog panel per
 *    solar input (1–4); a micro-inverter sold without panels gets two; a kit with panels comes as sold.
 *    Loose panels get the catalog frame on a ground/flat-roof spot.
 *  - station: no panels of its own unless `opts.panels` asks for them (capped at what can be wired).
 *  - blank: two 460 W panels on the generic 800 W dual-input micro-inverter, £600.
 * @param {object} kits kits.js module (kitToSystem, stationToSystem, bundleToSystem, findProduct, layoutPanels, mountingForSpot)
 * @param {{ normalizeSystem: Function }} system system.js module
 * @param {object} catalog normalised catalog (kits.normalizeCatalog)
 * @param {{ kind: 'kit'|'bundle'|'station'|'blank', id?: string, opts?: { id?: string, name?: string, spot?: object|null,
 *   dsSource?: string, exportKind?: string, strategy?: string, priceGbp?: number, dedicatedW?: 'baseload'|number,
 *   frames?: boolean, panels?: number|{ count: number, wp?: number, catalogId?: string, frameId?: string }|null } }} req
 * @returns {object} System (normalised)
 */
export function buildSystemFrom(kits, system, catalog, { kind, id, opts } = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!BUILD_KINDS.has(kind)) throw new EngineError('BAD_SPEC', `buildSystem: kind must be kit, bundle, station or blank (got ${kind}).`);
    const spot = o.spot ?? null;
    const list = { kit: catalog?.kits, bundle: catalog?.bundles, station: catalog?.stations }[kind];
    const product = kind === 'blank' ? null : (list || []).find(p => p?.id === id) ?? null;
    if (kind !== 'blank' && !product) throw new EngineError('UNKNOWN_PRODUCT', `There is no ${kind} "${id}" in the product list.`);
    const loose = (count, sp) => ({
        count, wp: catalog?.parts?.panel?.includedPanels?.wp ?? 460, catalogId: catalog?.parts?.panel?.id,
        frameId: kits.mountingForSpot(sp) === 'open' ? catalog?.parts?.frame?.id : undefined,
    });
    // Caller numbers are cleaned first: a fractional or NaN panel count used to reach layoutPanels
    // as `new Array(2.6)` and fail with a bare RangeError. Counts are whole and ≥ 0 (unusable →
    // the default); a wattage or price that isn't a positive / non-negative number is ignored.
    const whole = (v, dflt) => { const x = typeof v === 'string' && v.trim() === '' ? NaN : Number(v); return Number.isFinite(x) ? Math.max(0, Math.round(x)) : dflt; };
    const watts = v => { const x = Number(v); return v != null && Number.isFinite(x) && x > 0 ? x : undefined; };
    const price = Number.isFinite(Number(o.priceGbp)) && o.priceGbp !== null && o.priceGbp !== '' && Number(o.priceGbp) >= 0 ? Number(o.priceGbp) : undefined;
    const isObj = o.panels != null && typeof o.panels === 'object';
    // opts.panels: a count, or a partial loose-panel spec laid over the catalog's default panel
    // (objDflt: the count when that spec doesn't say)
    const panelsFor = (dflt, objDflt) => {
        if (o.panels === null) return null;
        if (isObj) {
            const n = whole(o.panels.count, objDflt);
            if (!(n > 0)) return null;
            const { count, wp, ...rest } = o.panels;
            const base = loose(n, spot);
            return { ...base, ...rest, count: n, wp: watts(wp) ?? base.wp };
        }
        const n = o.panels === undefined ? dflt : whole(o.panels, dflt);
        return n > 0 ? loose(n, spot) : null;
    };
    const dsSource = o.dsSource ?? 'octopus';

    if (kind === 'kit') {
        const base = { catalog, id: o.id, exportKind: o.exportKind, strategy: o.strategy, priceGbp: price, dsSource };
        if (product.kind === 'battery-addon') return kits.kitToSystem(product, { ...base, name: o.name });
        const dflt = product.kind === 'battery-inverter' ? Math.min(4, Math.max(1, product.inputs?.length || 1))
            : product.includedPanels ? 0 : 2;
        const panels = product.includedPanels && o.panels === undefined ? null : panelsFor(dflt, product.includedPanels?.count ?? (dflt || 2));
        const name = o.name ?? (panels && !product.includedPanels ? `${product.name} + ${panels.count} panel${panels.count === 1 ? '' : 's'}` : undefined);
        return kits.kitToSystem(product, { ...base, spot, panels, name });
    }
    if (kind === 'bundle') return kits.bundleToSystem(product, { catalog, spot, id: o.id, name: o.name, strategy: o.strategy });
    if (kind === 'station') {
        const n = whole(isObj ? o.panels.count : o.panels, 0);
        let panels = null;
        if (n > 0) {
            const { count, wp, ...rest } = isObj ? o.panels : {};
            panels = { spot, ...rest, count: n };
            if (watts(wp)) panels.wp = watts(wp);
        }
        return kits.stationToSystem(product, { catalog, id: o.id, name: o.name, strategy: o.strategy, dedicatedW: o.dedicatedW, frames: o.frames, panels });
    }
    // blank: a custom plug-in build on the generic dual-input 800 W micro-inverter
    const at = spot ?? { azimuth: 180, tilt: 35, kind: 'ground', shadingPct: 3, horizon: [] };
    const count = Math.max(1, whole(isObj ? o.panels.count : o.panels, 2));
    const wp = (isObj && watts(o.panels.wp)) || 460;
    return system.normalizeSystem({
        id: o.id ?? 'custom', name: o.name ?? 'My own plug-in build', route: 'plugin', spotId: at.id ?? null,
        arrays: kits.layoutPanels(count, wp, 2, { azimuth: at.azimuth ?? 180, tilt: at.tilt ?? 35, mounting: kits.mountingForSpot(at), shadingPct: at.shadingPct ?? 3, horizon: Array.isArray(at.horizon) ? at.horizon : [] }),
        costs: [{ label: 'Panels, micro-inverter and mounting', gbp: price ?? 600, year: 0, kind: 'hardware' }],
        notes: ['A custom build: only legal as a plug-in kit if this exact kit is on the ENA register.'],
    });
}

async function defaultCatalogLoader(fetchImpl) {
    const base = new URL('../data/', import.meta.url);
    const get = async name => {
        let res;
        try {
            res = await fetchImpl(new URL(`${name}.json`, base).href);
        } catch {
            throw new EngineError('CATALOG', `Couldn't download the product list (data/${name}.json). Check your connection and try again.`, { retryable: true });
        }
        if (!res.ok) throw new EngineError('CATALOG', `Couldn't download the product list (data/${name}.json, error ${res.status}). Try again in a moment.`, { retryable: true });
        try {
            return await res.json();
        } catch {
            throw new EngineError('CATALOG', `The product list (data/${name}.json) arrived incomplete. Try again.`, { retryable: true });
        }
    };
    const [kits, stations, bundles, constants] = await Promise.all(['kits', 'stations', 'bundles', 'constants'].map(get));
    // The data files wrap their arrays ({ kits: [...] }); hand normalizeCatalog the arrays, plus the
    // station-wide defaults and the raw files in case it wants their metadata.
    return {
        kits: Array.isArray(kits?.kits) ? kits.kits : kits,
        stations: Array.isArray(stations?.stations) ? stations.stations : stations,
        bundles: Array.isArray(bundles?.bundles) ? bundles.bundles : bundles,
        constants,
        stationDefaults: stations?.defaults ?? null,
        raw: { kits, stations, bundles },
    };
}

/**
 * Create the method dispatcher. In the worker it is bound to postMessage; engine.js uses it inline.
 * @param {{ post: (msg: object) => void, importer?: (spec: string) => Promise<object>, fetch?: typeof fetch,
 *   catalogLoader?: (fetch: typeof fetch) => Promise<object>, retryDelaysMs?: number[] }} opts
 *   importer/catalogLoader are injectable for tests; defaults import sibling modules and data/*.json.
 *   retryDelaysMs: the waits before each retry of a product list that failed to download while
 *   loading a dataset (default [400, 1500]).
 * @returns {{ handle(msg: object): Promise<void>, state(): { hasDataset: boolean, hasEngine: boolean } }}
 */
export function createDispatcher({ post, importer, fetch: fetchImpl, catalogLoader, retryDelaysMs = [400, 1500] } = {}) {
    const load = importer ?? (spec => import(spec));
    const baseFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis);
    const guardedFetch = makeGuardedFetch(baseFetch);
    const loadCatalog = catalogLoader ?? defaultCatalogLoader;
    const active = new Map();
    const secrets = new Set();
    const s = { ds: null, engine: null, catalog: null, catalogP: null, scenarios: null, cacheP: null, projectBaseW: null };
    let lastCommit = null;   // { id, prev } for the most recent loadDataset that replaced the dataset
    let rebuild = null;      // { ds, p } an engine being built for a dataset that has none yet
    const modules = new Map();        // key → the module, under whichever URL imported it
    const importFailures = new Map(); // key → failed imports so far (the next retry's cache-buster)

    /* Import a sibling module. After a failure, ask for a URL the module map hasn't cached as failed. */
    async function importModule(key) {
        if (modules.has(key)) return modules.get(key);
        let lastErr;
        for (let attempt = 0; attempt < 2; attempt++) {
            const n = importFailures.get(key) || 0;
            try {
                const mod = await load(n ? `${MODULES[key]}?retry=${n}` : MODULES[key]);
                modules.set(key, mod);
                return mod;
            } catch (err) {
                lastErr = err;
                importFailures.set(key, n + 1);
            }
        }
        throw lastErr;
    }

    async function need(key, names = []) {
        let mod;
        try {
            mod = await importModule(key);
        } catch (err) {
            // The browser's text carries the full module URL and says little; the console keeps it.
            console.warn(`solar: js/${MODULES[key].slice(2)} didn't load:`, err?.message || err);
            throw new EngineError('MISSING_MODULE',
                `Couldn’t download part of the calculator (js/${MODULES[key].slice(2)}). Check your connection and try again — if it keeps failing, reload the page.`,
                { retryable: true, action: 'reload' });
        }
        for (const n of names) {
            if (typeof mod?.[n] === 'undefined') throw new EngineError('MISSING_EXPORT', `js/${MODULES[key].slice(2)} doesn't export ${n}.`);
        }
        return mod;
    }

    async function getCache() {
        s.cacheP ??= need('cache', ['openCache']).then(m => m.openCache('solar-calculator')).catch(() => null);
        return s.cacheP;
    }

    async function getCatalog() {
        if (s.catalog) return s.catalog;
        s.catalogP ??= (async () => {
            const [{ normalizeCatalog }, raw] = await Promise.all([need('kits', ['normalizeCatalog']), loadCatalog(guardedFetch)]);
            s.catalog = normalizeCatalog(raw);
            return s.catalog;
        })();
        try {
            return await s.catalogP;
        } catch (err) {
            s.catalogP = null;   // let the next call retry (e.g. a flaky network)
            throw err;
        }
    }

    const noDataset = () => new EngineError('NO_DATASET', 'Load your data first.', { action: 'useDemo' });

    async function buildEngine(ds) {
        const [{ SolarEngine }, catalog] = await Promise.all([need('core', ['SolarEngine']), getCatalog()]);
        return new SolarEngine(ds, catalog);
    }

    /*
     * The engine for the current dataset — built now if the load couldn't build it (a product list
     * or module that failed to download). Concurrent callers share one build; a build for a dataset
     * that was replaced meanwhile is thrown away and the new one is built instead.
     */
    async function getEngine() {
        if (s.engine) return s.engine;
        if (!s.ds) throw noDataset();
        const ds = s.ds;
        if (rebuild?.ds !== ds) rebuild = { ds, p: buildEngine(ds) };
        const job = rebuild;
        let engine;
        try {
            engine = await job.p;
        } catch (err) {
            if (rebuild === job) rebuild = null;   // the next call tries again
            if (err?.name === 'AbortError') throw err;
            throw new EngineError('ENGINE_UNAVAILABLE', `Your data is loaded, but the simulation engine couldn’t start. ${err?.message || err}`,
                { retryable: err?.retryable ?? true, action: err?.action ?? null });
        }
        if (rebuild === job) rebuild = null;
        if (s.ds !== ds) return getEngine();
        if (!s.engine) {
            s.engine = engine;
            if (s.projectBaseW != null) engine.setProjectBaseW(s.projectBaseW);
        }
        return s.engine;
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function findScenario(id) {
        const list = s.scenarios || [];
        return list.find(x => x?.id === id) || null;
    }

    const methods = {
        async loadDataset(ctx, spec) {
            if (!spec || typeof spec !== 'object') throw new EngineError('BAD_SPEC', 'Nothing to load.');
            if (spec.apiKey) secrets.add(String(spec.apiKey));
            const { loadDataset } = await need('dataset', ['loadDataset']);
            const cache = await getCache();
            const ds = await loadDataset(spec, {
                fetch: guardedFetch, cache, signal: ctx.controller.signal,
                onProgress: p => ctx.progress(p, true),
            });
            ctx.check();
            let engine = null;
            let engineErr = null;
            // A product list that failed to download is worth a couple of quick retries before
            // settling for a dataset without its engine (which getEngine() can still build later).
            for (let attempt = 0; ; attempt++) {
                try {
                    engine = await buildEngine(ds);
                    break;
                } catch (err) {
                    engineErr = err;
                    const wait = retryDelaysMs[attempt];
                    if (err?.code !== 'CATALOG' || !(wait >= 0)) break;
                    await sleep(wait);
                    ctx.check();
                }
            }
            // Keep the dataset usable (usage insights work without the engine) and say why.
            if (!engine) console.warn('solar engine unavailable:', engineErr?.message || engineErr);
            ctx.check();
            // Remember what this load replaced: if the page cancels it after this point (its result
            // is already on the way but will be dropped), the page still believes in the previous
            // dataset, so the worker must go back to it — see handle('cancel').
            lastCommit = { id: ctx.id, prev: { ds: s.ds, engine: s.engine, scenarios: s.scenarios, projectBaseW: s.projectBaseW } };
            s.ds = ds;
            s.engine = engine;
            s.scenarios = null;
            // A new dataset starts at its own always-on load; the page sends its projection again.
            s.projectBaseW = null;
            if (engine) return withUsageBasis(engine.summary);
            const { summarize } = await need('dataset', ['summarize']);
            return withUsageBasis({ ...summarize(ds), engineUnavailable: true, engineError: serializeError(engineErr, secrets) });
        },

        /**
         * The summary of the current dataset once its engine is running — building the engine now if
         * the load couldn't (the page calls this to recover from a failed download). Rejects with
         * ENGINE_UNAVAILABLE (retryable) while it still can't be built.
         */
        async ensureEngine() {
            const engine = await getEngine();
            return withUsageBasis(engine.summary);
        },

        async insights() {
            let ins;
            if (s.engine) ins = s.engine.insights();
            else {
                if (!s.ds) throw noDataset();
                const { analyseUsage } = await need('insights', ['analyseUsage']);
                ins = analyseUsage(s.ds);
            }
            const source = s.ds?.meta?.source;
            return ins && typeof ins === 'object' && ins.coverage && SYNTHETIC_SOURCES.has(source)
                ? { ...ins, coverage: markUsageBasis(ins.coverage, source) } : ins;
        },

        runScenario: async (ctx, system, opts) => (await getEngine()).runScenario(system, opts ?? {}),

        async autoScenarios(ctx, opts) {
            s.scenarios = (await getEngine()).autoScenarios(opts ?? {});
            return s.scenarios;
        },

        /*
         * opts: { scenarios?, spots?, finance?, maxPaybackYears?, overrides?: { [scenarioId]: { priceGbp, costs? } }, … }.
         * The verdict polls isCancelled() between options, so a cancel stops it mid-stage instead of
         * at the next stage boundary (onPartial stays a cancellation point too).
         */
        async verdict(ctx, opts = {}) {
            const engine = await getEngine();
            const { buildVerdict } = await need('verdict', ['buildVerdict']);
            const { scenarios, spots, overrides, ...rest } = opts || {};
            const list = scenarios ?? (s.scenarios = engine.autoScenarios(spots ? { spots } : {}));
            ctx.check();
            return buildVerdict(engine, {
                ...rest,
                scenarios: list,
                finance: opts?.finance,
                ...(overrides && typeof overrides === 'object' ? { overrides } : {}),
                isCancelled: () => ctx.cancelled,
                onPartial: (stage, partial) => ctx.progress({ stage, verdict: partial }, true),
            });
        },

        orientationSweep: async (ctx, system, arrayId, opts) =>
            (await getEngine()).orientationSweep(system, arrayId, { ...(opts || {}), onProgress: p => ctx.progress(p) }),

        /* The verdict's heavy answers, for any system (B1 caches them per system + finance). */
        answerOrientation: async (ctx, system, opts) => (await getEngine()).answerOrientation(system, bag(opts)),
        upsStrategies: async (ctx, system, opts) => (await getEngine()).upsStrategies(system, bag(opts)),
        tornado: async (ctx, system, opts) => (await getEngine()).tornado(system, bag(opts)),
        weatherInfo: async () => (await getEngine()).weatherInfo(),

        /* Curves take an optional { finance } (the user's money settings); without it they use the defaults. */
        async baseLoadCurve(ctx, idsOrSystems, xs, opts) {
            const engine = await getEngine();
            const systems = (idsOrSystems || []).map(x => (typeof x === 'string' ? findScenario(x) : x)).filter(Boolean);
            return engine.baseLoadCurve(systems, xs ?? undefined, bag(opts));
        },

        panelCountCurve: async (ctx, system, opts) => (await getEngine()).panelCountCurve(system, bag(opts)),
        batterySizeCurve: async (ctx, system, opts) => (await getEngine()).batterySizeCurve(system, bag(opts)),
        typicalDay: async (ctx, system, which) => (await getEngine()).typicalDay(system, which),
        exportCsv: async (ctx, system) => (await getEngine()).exportCsv(system),

        /** A System built from a catalog product: { kind: 'kit'|'bundle'|'station'|'blank', id, opts } (see buildSystemFrom). */
        async buildSystem(ctx, req) {
            if (!req || typeof req !== 'object') throw new EngineError('BAD_SPEC', 'buildSystem needs { kind, id }.');
            const [kitsMod, systemMod, catalog] = await Promise.all([
                need('kits', ['kitToSystem', 'stationToSystem', 'bundleToSystem', 'layoutPanels', 'mountingForSpot']),
                need('system', ['normalizeSystem']), getCatalog()]);
            const opts = { ...(req.opts && typeof req.opts === 'object' ? req.opts : {}) };
            // Octopus kits come with Outgoing Prime for Octopus and demo data (kits.js rule).
            opts.dsSource ??= s.ds?.meta?.source ?? 'octopus';
            return buildSystemFrom(kitsMod, systemMod, catalog, { kind: req.kind, id: req.id, opts });
        },

        /* Kept even while the engine can't be built, and applied when it is. */
        setProjectBaseW(ctx, w) {
            if (!s.ds) throw noDataset();
            s.projectBaseW = Number.isFinite(w) ? w : null;
            s.engine?.setProjectBaseW(s.projectBaseW);
            return true;
        },

        async normalizeSystem(ctx, partial) {
            if (s.engine) return s.engine.normalizeSystem(partial);
            const { normalizeSystem } = await need('system', ['normalizeSystem']);
            return normalizeSystem(partial);
        },

        async validate(ctx, system) {
            if (s.engine) return s.engine.validate(system);
            const [{ validate }, catalog] = await Promise.all([need('rules', ['validate']), getCatalog()]);
            return validate(system, catalog);
        },

        async applyFix(ctx, system, action) {
            const [{ applyFix }, catalog] = await Promise.all([need('rules', ['applyFix']), getCatalog()]);
            return applyFix(system, action, catalog);
        },

        async catalog() {
            const cat = await getCatalog();
            // byId() and friends can't cross postMessage; send the data only (kits.findProduct works on it).
            const { kits, stations, bundles, constants, stationDefaults, electrician, limits, parts } = cat;
            return plain({ kits, stations, bundles, constants, stationDefaults, electrician, limits, parts });
        },
    };

    function makeCtx(id) {
        const ctx = {
            id,
            cancelled: false,
            controller: typeof AbortController !== 'undefined' ? new AbortController() : { signal: undefined, abort() {} },
            lastPost: 0,
            check() { if (ctx.cancelled) throw abortError(); },
            /* Progress doubles as the cancellation point: engine loops call it, and a cancelled call throws out of their stack. */
            progress(value, force = false) {
                ctx.check();
                const now = Date.now();
                const done = value && typeof value === 'object' && (value.pct >= 100 || value.done === true);
                if (!force && !done && now - ctx.lastPost < PROGRESS_MIN_MS) return;
                ctx.lastPost = now;
                // Step errors travel as progress text too ({ status: 'error', detail: e.message }), so
                // they get the same scrubbing as thrown errors.
                let v = value;
                if (secrets.size && v && typeof v === 'object' && typeof v.detail === 'string') v = { ...v, detail: redactText(v.detail, secrets) };
                else if (secrets.size && typeof v === 'string') v = redactText(v, secrets);
                try { post({ type: 'progress', id, value: v }); } catch { /* an uncloneable progress value is not worth failing the call */ }
            },
        };
        return ctx;
    }

    async function handle(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'cancel') {
            const ctx = active.get(msg.id);
            if (ctx) { ctx.cancelled = true; ctx.controller.abort(); }
            else if (lastCommit?.id === msg.id) {
                // A load that finished here but was cancelled by the page before its result
                // arrived: the page never adopted it, so neither may the worker.
                Object.assign(s, lastCommit.prev);
                lastCommit = null;
            }
            return;
        }
        if (msg.type !== 'call') return;
        const { id, method } = msg;
        const args = Array.isArray(msg.args) ? msg.args : [];
        if (!Object.prototype.hasOwnProperty.call(methods, method)) {
            post({ type: 'error', id, error: serializeError(new EngineError('UNKNOWN_METHOD', `Unknown engine method: ${method}`)) });
            return;
        }
        const ctx = makeCtx(id);
        active.set(id, ctx);
        try {
            const value = await methods[method](ctx, ...args);
            ctx.check();
            try {
                post({ type: 'result', id, value });
            } catch (err) {
                post({ type: 'error', id, error: serializeError(new EngineError('UNCLONEABLE', `The result of ${method} couldn't be sent to the page: ${err?.message || err}`)) });
            }
        } catch (err) {
            post({ type: 'error', id, error: serializeError(ctx.cancelled ? abortError() : err, secrets) });
        } finally {
            active.delete(id);
        }
    }

    return { handle, state: () => ({ hasDataset: !!s.ds, hasEngine: !!s.engine }) };
}

/* ── bootstrap when running as a module worker ─────────────────────────────── */
const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
if (inWorker) {
    const dispatcher = createDispatcher({ post: msg => self.postMessage(msg) });
    self.addEventListener('message', e => { dispatcher.handle(e.data); });
    self.postMessage({ type: 'ready' });
}
