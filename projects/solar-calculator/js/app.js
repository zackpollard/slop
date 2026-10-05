/*
 * app.js — bootstrap, hash router, view registry and the DataHub (contract §18).
 *
 * Views are separate modules (js/views/<id>.js) loaded on first visit and kept mounted; switching
 * tabs only hides/shows them, so charts and scroll positions survive. Every view gets the same ctx:
 *   { store, engine, ui, charts, fmt, router: { go, params, current }, data: DataHub, shell }
 *
 * The DataHub is the only thing that talks to the engine on a view's behalf for shared results.
 * It memoises insights / verdict / scenario runs by key, cancels in-flight work when the dataset or
 * settings change (views should ignore AbortError), and emits events so views can re-render:
 *   'dataset' | 'settings' | 'scenarios' | 'overrides' (Compare's price overrides changed) | 'verdict' | 'status'
 */

import { store, getApiKey } from './store.js';
import * as ui from './ui.js';
import * as charts from './charts.js';
import { createEngine } from './engine.js';

export const TABS = [
    { id: 'verdict', title: 'Verdict' },
    { id: 'usage', title: 'Usage' },
    { id: 'compare', title: 'Compare' },
    { id: 'design', title: 'Design' },
    { id: 'orientation', title: 'Orientation' },
    { id: 'method', title: 'Method' },
];
const EXTRA_ROUTES = [{ id: 'data', title: 'Your data' }];
const ROUTES = [...TABS, ...EXTRA_ROUTES];
const SOURCE_LABEL = { octopus: 'Octopus', demo: 'Example data', csv: 'CSV upload', manual: 'Entered by hand' };

/* ── router helpers (pure) ──────────────────────────────────────────────────── */

/**
 * Parse '#design?scenario=S01' → { tab: 'design', params: { scenario: 'S01' }, known: true }.
 * Unknown or empty routes fall back to the verdict.
 * @param {string} hash
 * @returns {{ tab: string, params: Record<string, string>, known: boolean }}
 */
export function parseHash(hash) {
    const raw = String(hash || '').replace(/^#\/?/, '');
    const q = raw.indexOf('?');
    const path = (q < 0 ? raw : raw.slice(0, q)).toLowerCase();
    const query = q < 0 ? '' : raw.slice(q + 1);
    const known = ROUTES.some(r => r.id === path);
    const params = {};
    try { for (const [k, v] of new URLSearchParams(query)) params[k] = v; } catch { /* malformed query: ignore */ }
    return { tab: known ? path : 'verdict', params, known };
}

/**
 * Build a hash from a tab and params (null/empty params are dropped).
 * @param {string} tab
 * @param {Record<string, any>} [params]
 * @returns {string}
 */
export function buildHash(tab, params = {}) {
    const entries = Object.entries(params || {}).filter(([, v]) => v != null && v !== '');
    const q = new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
    return `#${tab}${q ? `?${q}` : ''}`;
}

/**
 * Deterministic JSON (sorted keys; typed arrays as arrays) for cache keys.
 * @param {any} v
 * @returns {string}
 */
export function stableKey(v) {
    const seen = new WeakSet();
    const walk = x => {
        if (x === undefined) return null;
        if (x === null || typeof x !== 'object') return typeof x === 'number' && !Number.isFinite(x) ? String(x) : x;
        if (ArrayBuffer.isView(x)) return Array.from(x);
        if (seen.has(x)) return '[cycle]';
        seen.add(x);
        if (Array.isArray(x)) return x.map(walk);
        const out = {};
        for (const k of Object.keys(x).sort()) if (typeof x[k] !== 'function') out[k] = walk(x[k]);
        return out;
    };
    return JSON.stringify(walk(v));
}

/* ── DataHub ────────────────────────────────────────────────────────────────── */

const noDataset = () => Object.assign(new Error('Load your data first.'), { name: 'EngineError', code: 'NO_DATASET', action: 'useDemo' });
const SCENARIO_MEMO_MAX = 80;
/* After a load whose engine couldn't start (a download failed), try again after these waits. */
export const ENGINE_RECOVERY_DELAYS_MS = [2000, 6000, 15000, 30000, 60000];

/**
 * Did Octopus turn the API key down? An AUTH error whose remedy is "check your key": a 401, the
 * GraphQL invalid-key code (KT-CT-1139), no token issued, or a key no Octopus key could be. Not a
 * token-header hiccup (AUTH with 'pickAccount') or "no account for this key" (ACCOUNT) — the key
 * itself was accepted there.
 * @param {any} err
 * @returns {boolean}
 */
export function keyRejected(err) {
    return err?.code === 'AUTH' && (err.action ?? 'checkKey') === 'checkKey';
}

/**
 * The price overrides Compare saved, as the verdict takes them: { [scenarioId]: { priceGbp, costs } }.
 * Compare's convention (views/compare.js): a saved System with the auto scenario's id plus
 * { priceOverride: true, overrideOf: id } whose `costs` carry the user's prices; the first saved
 * entry per id wins (mergeSystems). priceGbp is the year-0 total of those costs, as Compare shows it.
 * @param {object[]} saved store.scenarios.saved
 * @returns {Record<string, { priceGbp: number, costs: object[] }>}
 */
export function priceOverrides(saved) {
    const out = {};
    const seen = new Set();
    for (const s of Array.isArray(saved) ? saved : []) {
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || seen.has(s.id)) continue;
        seen.add(s.id);
        if (!s.priceOverride) continue;
        const costs = (Array.isArray(s.costs) ? s.costs : []).filter(c => c && typeof c === 'object').map(c => ({ ...c }));
        const priceGbp = costs.filter(c => !(Number(c.year) > 0)).reduce((a, c) => a + (Number(c.gbp) || 0), 0);
        out[s.id] = { priceGbp: Math.round(priceGbp * 100) / 100, costs };
    }
    return out;
}

/**
 * The spec that reloads last visit's data without asking, or null when it can't: an Octopus key
 * that wasn't remembered, a manual entry without a location, and every CSV (the file itself is
 * never stored). Carries the user's price basis (and flat price), region and picked meter so a
 * reload prices the data exactly as before.
 * @param {object} conn store.connection
 * @param {string|null} [apiKey] the remembered Octopus key, if any
 * @returns {object|null} DatasetSpec
 */
export function autoReloadSpec(conn, apiKey = null) {
    const c = conn || {};
    const loc = c.location || {};
    const location = loc.postcode ? { postcode: loc.postcode } : Number.isFinite(loc.lat) && Number.isFinite(loc.lon) ? { lat: loc.lat, lon: loc.lon } : null;
    const priced = (spec, dflt) => {
        // 'mine' (the account's own tariffs) only exists for Octopus; elsewhere the default is Agile.
        const b = c.priceBasis;
        if (b && b !== dflt && !(b === 'mine' && spec.kind !== 'octopus')) spec.priceBasis = b;
        if (spec.priceBasis === 'flat' && Number.isFinite(c.flatP)) spec.flatP = c.flatP;
        return spec;
    };
    if (c.kind === 'demo') return { kind: 'demo', serverW: c.demoServerW || 500 };
    if (c.kind === 'octopus') {
        if (!apiKey) return null;
        const spec = { kind: 'octopus', apiKey };
        if (c.accountNumber) spec.accountNumber = c.accountNumber;
        if (c.mpan) spec.mpan = String(c.mpan);
        if (location) spec.location = location;
        if (c.installedSolarDate) spec.installedSolarDate = c.installedSolarDate;
        return priced(spec, 'mine');
    }
    if (c.kind === 'manual' && location && Number.isFinite(c.manual?.baseW)) {
        const spec = { kind: 'manual', baseW: c.manual.baseW, otherKwhYr: c.manual.otherKwhYr ?? 2700, location };
        if (typeof c.region === 'string' && /^[A-P]$/.test(c.region)) spec.region = c.region;
        return priced(spec, 'agile');
    }
    return null;
}

/* What DataHub.load remembers about a spec, so autoReloadSpec can rebuild it (the API key never). */
function connectionFor(spec) {
    const conn = { kind: spec.kind };
    if (spec.kind === 'demo') { conn.demoServerW = spec.serverW ?? 500; return conn; }
    if (spec.kind === 'manual') conn.manual = { baseW: spec.baseW, otherKwhYr: spec.otherKwhYr };
    if (spec.location) conn.location = { postcode: spec.location.postcode ?? null, lat: spec.location.lat ?? null, lon: spec.location.lon ?? null };
    if (spec.accountNumber) conn.accountNumber = spec.accountNumber;
    conn.priceBasis = spec.priceBasis || (spec.kind === 'octopus' ? 'mine' : 'agile');
    conn.flatP = conn.priceBasis === 'flat' && Number.isFinite(spec.flatP) ? spec.flatP : null;
    conn.installedSolarDate = spec.installedSolarDate || null;
    conn.mpan = spec.kind === 'octopus' && spec.mpan ? String(spec.mpan) : null;
    // stored as autoReloadSpec reads it back: one region letter A–P ('c' and '_C' count too)
    const region = typeof spec.region === 'string' ? spec.region.trim().replace(/^_/, '').toUpperCase() : '';
    conn.region = spec.kind !== 'octopus' && /^[A-P]$/.test(region) ? region : null;
    return conn;
}

/**
 * The shared data layer for views.
 *
 * A dataset can arrive without its engine (summary.engineUnavailable, with summary.engineError
 * saying why) when part of the calculator or the product list failed to download. The hub then
 * keeps trying in the background (ENGINE_RECOVERY_DELAYS_MS, and retryEngine() for a Retry button
 * or the browser coming back online); when the engine starts, the summary is replaced and
 * 'dataset' fires, so every view re-renders with the engine.
 * @param {{ engine: object, store: object, onNavigate?: (tab: string) => void,
 *   recoveryDelaysMs?: number[] }} deps
 * @returns {object} DataHub
 */
export function createDataHub({ engine, store: st, onNavigate, recoveryDelaysMs = ENGINE_RECOVERY_DELAYS_MS }) {
    const listeners = new Map();
    const inflight = new Set();
    let status = 'empty';                // 'empty' | 'loading' | 'ready' | 'error'
    let loadJob = null;
    let recovery = null;                 // { ds, attempt, timer } while an engine-less dataset waits for its engine
    let retryJob = null;
    let memoInsights = null;
    let memoAuto = null;
    let memoVerdict = null;
    const memoScenarios = new Map();
    let lastSettingsKey = stableKey(st.get().settings);
    let lastProjectBaseW = st.get().settings.projectBaseW;

    const emit = (evt, payload) => {
        for (const fn of [...(listeners.get(evt) || [])]) {
            try { fn(payload); } catch (err) { console.error(`'${evt}' listener failed`, err); }
        }
    };
    const setStatus = s => { if (s !== status) { status = s; emit('status', s); } };
    const track = job => {
        inflight.add(job);
        job.then(() => inflight.delete(job), () => inflight.delete(job));
        return job;
    };
    const financeOpts = () => {
        const s = st.get().settings;
        return { ...(s.finance || {}), vatReturns: s.vatReturns !== false };
    };
    const settingsSig = () => {
        const s = st.get().settings;
        return stableKey({ f: financeOpts(), spots: s.spots, pb: s.projectBaseW, max: s.maxPaybackYears });
    };
    const dsId = () => st.get().dataset?.id ?? null;
    /* The user's mount spots, always as a list ([] = the engine's defaults). */
    const spotList = () => { const sp = st.get().settings.spots; return Array.isArray(sp) ? sp : []; };
    // Shared memo promises are handed out as derived promises so one caller can't cancel another's.
    const share = p => p.then(v => v);
    const overrides = () => priceOverrides(st.get().scenarios?.saved);
    const verdictKey = ov => `${dsId()}|${settingsSig()}|${stableKey(ov)}`;
    let lastOverridesSig = stableKey(overrides());

    /*
     * Run the verdict into `entry` (a memo entry whose promise callers already hold). A restart —
     * the user changed a price on Compare while it ran — swaps the job underneath: the old job's
     * late messages are ignored, and the callers' promise and onPartial listeners carry on with the
     * new one.
     */
    function startVerdict(entry, ov) {
        const s = st.get().settings;
        // Spots always go, as a list: an empty one says "our default spots" explicitly, so the
        // engine never keeps the spots of an earlier call.
        const opts = { finance: financeOpts(), maxPaybackYears: s.maxPaybackYears ?? 10, spots: spotList() };
        if (Object.keys(ov).length) opts.overrides = ov;
        entry.partials = [];
        const job = track(engine.call('verdict', opts, {
            onProgress: v => {
                if (entry.job !== job || !v || !v.stage) return;
                entry.partials.push([v.stage, v.verdict]);
                for (const fn of entry.listeners) { try { fn(v.stage, v.verdict); } catch (err) { console.error(err); } }
            },
        }));
        entry.job = job;
        job.then(v => {
            if (entry.job !== job) return;
            entry.done = true;
            entry.value = v;
            entry.listeners.clear();
            entry.resolve(v);
            if (memoVerdict === entry) emit('verdict', v);
        }, err => {
            if (entry.job !== job) return;
            if (memoVerdict === entry) memoVerdict = null;
            entry.reject(err);
        });
    }

    function clearMemos() {
        memoInsights = null;
        memoAuto = null;
        memoVerdict = null;
        memoScenarios.clear();
    }

    function stopRecovery() {
        if (recovery?.timer) clearTimeout(recovery.timer);
        recovery = null;
    }
    /* Queue the next automatic attempt to start the engine for the dataset on hand, if it has none. */
    function scheduleRecovery() {
        const d = st.get().dataset;
        if (!d?.engineUnavailable) { stopRecovery(); return; }
        if (recovery?.ds !== d.id) { stopRecovery(); recovery = { ds: d.id, attempt: 0, timer: null }; }
        if (recovery.timer) return;
        const wait = recoveryDelaysMs[recovery.attempt];
        if (!(wait >= 0)) return;   // automatic tries used up: retryEngine() (a Retry button, 'online') still works
        const r = recovery;
        r.timer = setTimeout(() => {
            r.timer = null;
            r.attempt++;
            if (recovery !== r) return;
            hub.retryEngine().catch(() => { if (recovery === r) scheduleRecovery(); });
        }, wait);
    }

    const hub = {
        /** @returns {object|null} the DatasetSummary, or null before data is loaded */
        summary: () => st.get().dataset,

        /** @returns {'empty'|'loading'|'ready'|'error'} */
        status: () => status,

        /** Usage analysis for the loaded dataset (memoised). */
        insights() {
            if (!dsId()) return Promise.reject(noDataset());
            if (!memoInsights) {
                const job = track(engine.call('insights'));
                memoInsights = job;
                job.catch(() => { if (memoInsights === job) memoInsights = null; });
            }
            return share(memoInsights);
        },

        /** Default scenarios for the dataset (memoised). */
        autoScenarios() {
            if (!dsId()) return Promise.reject(noDataset());
            if (!memoAuto) {
                const job = track(engine.call('autoScenarios', { spots: spotList() }));
                memoAuto = job;
                job.catch(() => { if (memoAuto === job) memoAuto = null; });
            }
            return share(memoAuto);
        },

        /**
         * The verdict, streamed: onPartial(stage, partialVerdict) fires for 'usage' → 'plugin' → 'all'
         * → 'bands' → 'answers'. A second caller while it runs gets the latest partial replayed.
         * The user's own prices from Compare (priceOverrides) go to the worker as opts.overrides, so
         * the Verdict and Compare price every option the same way.
         * @param {{ onPartial?: (stage: string, v: object) => void }} [opts]
         */
        verdict({ onPartial } = {}) {
            if (!dsId()) return Promise.reject(noDataset());
            const ov = overrides();
            const key = verdictKey(ov);
            if (memoVerdict?.key === key) {
                if (onPartial) {
                    if (!memoVerdict.done) memoVerdict.listeners.add(onPartial);
                    const last = memoVerdict.partials[memoVerdict.partials.length - 1];
                    if (last && !memoVerdict.done) queueMicrotask(() => onPartial(last[0], last[1]));
                }
                return share(memoVerdict.promise);
            }
            const entry = { key, listeners: new Set(onPartial ? [onPartial] : []), partials: [], done: false };
            entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
            entry.promise.catch(() => {});
            memoVerdict = entry;
            startVerdict(entry, ov);
            return share(entry.promise);
        },

        /**
         * Peek at the verdict without starting one. Default: the finished Verdict for the current
         * data, settings and prices, else null. With { wait: true }: a promise of the verdict when
         * one is finished or running for the current inputs, else null (still never starts one).
         * @param {{ wait?: boolean }} [opts]
         * @returns {object|null|Promise<object>}
         */
        verdictIfReady({ wait = false } = {}) {
            if (!dsId() || !memoVerdict || memoVerdict.key !== verdictKey(overrides())) return null;
            if (memoVerdict.done) return wait ? Promise.resolve(memoVerdict.value) : memoVerdict.value;
            return wait ? share(memoVerdict.promise) : null;
        },

        /** The user's money settings as the engine takes them ({ ...settings.finance, vatReturns }). */
        finance: () => financeOpts(),

        /**
         * The solar-rose sweep for one array of a system ('*' = every array), with the user's finance
         * merged under opts.finance. Tracked like every hub job: invalidate() (a new dataset or a
         * settings change) cancels it — ignore the AbortError. Not memoised; the returned promise
         * has cancel().
         * @param {object} system
         * @param {string} [arrayId]
         * @param {{ onProgress?: (p: { pct: number, done?: number, total?: number }) => void, signal?: AbortSignal, finance?: object }} [opts]
         * @returns {Promise<object> & { cancel(): void }} SweepResult
         */
        orientationSweep(system, arrayId = '*', { onProgress, signal, finance, ...rest } = {}) {
            if (!dsId()) return Promise.reject(noDataset());
            const opts = { ...rest, finance: { ...financeOpts(), ...(finance || {}) } };
            const ctl = {};
            if (typeof onProgress === 'function') ctl.onProgress = onProgress;
            if (signal) ctl.signal = signal;
            const args = ['orientationSweep', system, arrayId ?? '*', opts];
            return track(Object.keys(ctl).length ? engine.call(...args, ctl) : engine.call(...args));
        },

        /**
         * Run (or reuse) one scenario. The user's finance settings are merged under opts.finance.
         * @param {object} system
         * @param {object} [opts] runScenario options ({ withBand, finance, includeSlots, fidelity })
         */
        scenario(system, opts = {}) {
            if (!dsId()) return Promise.reject(noDataset());
            const merged = { ...opts, finance: { ...financeOpts(), ...(opts.finance || {}) } };
            const key = `${dsId()}|${settingsSig()}|${stableKey(system)}|${stableKey(merged)}`;
            let job = memoScenarios.get(key);
            if (!job) {
                job = track(engine.call('runScenario', system, merged));
                memoScenarios.set(key, job);
                job.catch(() => { if (memoScenarios.get(key) === job) memoScenarios.delete(key); });
                if (memoScenarios.size > SCENARIO_MEMO_MAX) memoScenarios.delete(memoScenarios.keys().next().value);
            } else {
                memoScenarios.delete(key);   // refresh LRU position
                memoScenarios.set(key, job);
            }
            return share(job);
        },

        /**
         * Drop cached results and cancel in-flight work. reason 'dataset' | 'settings' | 'scenarios' also emits that event.
         * @param {string} [reason]
         */
        invalidate(reason = 'settings') {
            for (const job of inflight) job.cancel?.();
            inflight.clear();
            clearMemos();
            if (['dataset', 'settings', 'scenarios'].includes(reason)) emit(reason, st.get().dataset);
        },

        /**
         * Start the engine for a dataset that arrived without it (summary.engineUnavailable). On
         * success the summary is replaced (no engineUnavailable) and 'dataset' fires. Rejects with
         * the engine's error (retryable) while it still can't start; resolves to the summary as is
         * when there is nothing to recover.
         * @returns {Promise<object>} DatasetSummary
         */
        async retryEngine() {
            const d = st.get().dataset;
            if (!d) throw noDataset();
            if (!d.engineUnavailable) return d;
            if (!retryJob) {
                retryJob = (async () => {
                    try {
                        const summary = await engine.call('ensureEngine');
                        // A newer load replaced the data meanwhile: it owns the store now.
                        if (st.get().dataset !== d) return st.get().dataset;
                        stopRecovery();
                        st.set({ dataset: summary });
                        setStatus('ready');
                        hub.invalidate('dataset');
                        return summary;
                    } finally {
                        retryJob = null;
                    }
                })();
            }
            return share(retryJob);
        },

        /** Subscribe to 'dataset' | 'settings' | 'scenarios' | 'overrides' | 'verdict' | 'status'. Returns off(). */
        on(evt, fn) {
            if (!listeners.has(evt)) listeners.set(evt, new Set());
            listeners.get(evt).add(fn);
            return () => listeners.get(evt)?.delete(fn);
        },

        /**
         * Load a dataset (contract §6 DatasetSpec) and make it current; navigates to #verdict unless navigate:false.
         * @param {object} spec
         * @param {{ onProgress?: (p: object) => void, navigate?: boolean }} [opts]
         * @returns {Promise<object>} DatasetSummary
         */
        async load(spec, { onProgress, navigate = true } = {}) {
            loadJob?.cancel();
            const prev = status;
            setStatus('loading');
            const job = engine.call('loadDataset', spec, { onProgress: p => onProgress?.(p) });
            loadJob = job;
            try {
                const summary = await job;
                // The worker now holds the new dataset. Results memoised (or still running) for the
                // old one must go before anything can pair them with the new summary.
                for (const j of inflight) j.cancel?.();
                inflight.clear();
                clearMemos();
                const pb = st.get().settings.projectBaseW;
                lastProjectBaseW = pb;
                // The worker keeps it even without an engine, and applies it when the engine starts.
                if (Number.isFinite(pb)) await engine.call('setProjectBaseW', pb).catch(() => {});
                // A newer load() started while we waited: it owns the store and the status now.
                if (loadJob !== job) throw Object.assign(new Error('Cancelled'), { name: 'AbortError', code: 'CANCELLED' });
                st.set({ dataset: summary, connection: connectionFor(spec) });
                // Status first: views re-rendering on 'dataset' must not still see 'loading'.
                setStatus('ready');
                hub.invalidate('dataset');
                scheduleRecovery();
                if (navigate) onNavigate?.('verdict');
                return summary;
            } catch (err) {
                if (err?.name === 'AbortError') { if (loadJob === job) setStatus(st.get().dataset ? 'ready' : prev === 'error' ? 'error' : 'empty'); }
                else setStatus(st.get().dataset ? 'ready' : 'error');
                // A key Octopus turned down is no use to keep, in this tab or on this device —
                // whichever path loaded it (the Data form, a re-fetch, the reload at start-up). Only
                // the key this load used: one stored since (a corrected paste) is left alone.
                if (spec?.kind === 'octopus' && keyRejected(err)) {
                    try { if (st.getApiKey?.() === spec.apiKey) st.clearApiKey?.(); } catch { /* storage blocked: nothing kept */ }
                }
                throw err;
            } finally {
                if (loadJob === job) loadJob = null;
            }
        },
    };

    // Settings changes: push the projected base load into the engine, then invalidate.
    st.subscribe(state => {
        const sig = stableKey(state.settings);
        if (sig === lastSettingsKey) return;
        lastSettingsKey = sig;
        const pb = state.settings.projectBaseW;
        if (pb !== lastProjectBaseW && state.dataset) {
            lastProjectBaseW = pb;
            engine.call('setProjectBaseW', Number.isFinite(pb) ? pb : null).catch(() => {});
        }
        hub.invalidate('settings');
    }, ['settings']);
    // Saved scenarios: a changed price override changes the verdict's input. A verdict still running
    // restarts with the new prices (same promise and listeners for its callers); a finished one is
    // simply no longer current — verdictIfReady() says null and the next verdict() runs afresh.
    // 'overrides' fires before 'scenarios' so a listener that asks for the verdict gets the new one.
    st.subscribe(state => {
        const ov = overrides();
        const sig = stableKey(ov);
        if (sig !== lastOverridesSig) {
            lastOverridesSig = sig;
            const e = memoVerdict;
            if (e && !e.done && dsId() && e.key.startsWith(`${dsId()}|${settingsSig()}|`)) {
                const old = e.job;
                e.key = verdictKey(ov);
                startVerdict(e, ov);
                old?.cancel?.();
            }
            emit('overrides', ov);
        }
        emit('scenarios', state.scenarios);
    }, ['scenarios']);

    return hub;
}

/* ── shell ──────────────────────────────────────────────────────────────────── */

/**
 * What a tab shows when its module couldn't be used.
 *  - download: the import failed (a network problem — every view exists). Offers Try again (a fresh
 *    import under a new URL: a failed import stays failed in the module map) and, once that has
 *    failed too, a page reload.
 *  - otherwise the module loaded but broke while mounting: say so, with the error.
 * @param {string} id @param {string} title
 * @param {any} err
 * @param {{ download?: boolean, attempts?: number, onRetry?: () => void, reload?: () => void }} [opts]
 */
export function placeholderView(id, title, err, { download = false, attempts = 1, onRetry, reload = () => location.reload() } = {}) {
    let off = null;
    const what = id === 'data' ? 'the data page' : `the ${title} tab`;
    return {
        id, title, failed: download,
        mount(el, ctx) {
            const render = () => {
                // A connect card on screen reports its own progress and errors: never swap it out mid-load.
                const showingCard = !!el.querySelector('.connect-card');
                if (!ctx.data.summary() && showingCard) return;
                if (ctx.data.status() === 'loading') { el.replaceChildren(ui.card({ body: ui.skeleton({ lines: 5 }) })); return; }
                if (!ctx.data.summary() && id !== 'method' && id !== 'data') { el.replaceChildren(ui.connectCard(ctx)); return; }
                let state;
                if (download) {
                    const again = attempts > 1;
                    state = {
                        title: `Couldn’t download ${what}`,
                        body: again
                            ? 'It failed again. Reloading the page fetches the calculator afresh — your data and settings are kept.'
                            : 'Check your connection, then try again. The other tabs still work with your data.',
                        action: ui.h('div', { class: 'empty-actions' },
                            ui.button({ label: 'Try again', icon: 'refresh', kind: again ? 'default' : 'primary', onClick: () => onRetry?.() }),
                            again ? ui.button({ label: 'Reload the page', kind: 'primary', onClick: () => reload() }) : null),
                    };
                } else {
                    state = {
                        title: `${title} couldn’t load`,
                        body: `Something broke while showing ${what}: ${err?.message || err}`,
                        action: id === 'verdict' ? { label: 'See your data', href: '#data' } : { label: 'Back to the verdict', href: '#verdict' },
                    };
                }
                el.replaceChildren(ui.card({ className: 'placeholder-card', body: ui.emptyState(state) }));
            };
            render();
            off = [ctx.data.on('dataset', render), ctx.data.on('status', render)];
        },
        unmount() { off?.forEach(f => f()); },
    };
}

function chipContent(chip, summary, status) {
    chip.className = 'ds-chip';
    let long, short;
    if (status === 'loading') {
        chip.classList.add('is-loading');
        long = 'Loading your data…';
        short = 'Loading…';
    } else if (!summary) {
        chip.classList.add('is-empty');
        long = 'No data yet · connect';
        short = 'Connect';
    } else {
        chip.classList.add(summary.source === 'demo' ? 'is-demo' : 'is-ready');
        const d = s => (s ? ui.fmt.date(Date.parse(`${s}T12:00:00Z`)) : '?');
        const where = summary.postcode || summary.regionName || (summary.region ? `Region ${summary.region}` : '');
        long = [SOURCE_LABEL[summary.source] || summary.source, `${d(summary.from)} – ${d(summary.to)}`, where].filter(Boolean).join(' · ');
        short = `${summary.region || '?'} · ${Math.round(summary.days || 0)} d`;
    }
    chip.replaceChildren(
        ui.h('span', { class: 'ds-dot', 'aria-hidden': 'true' }),
        ui.h('span', { class: 'ds-text ds-long' }, long),
        ui.h('span', { class: 'ds-text ds-short' }, short));
    chip.setAttribute('aria-label', `Your data: ${long}. Open the data page.`);
}

/**
 * The sticky "inputs changed — re-run" bar (ctx.shell.rerun). While it shows, <html> gets the
 * `rerun-open` class, whose scroll-padding-bottom keeps focused and scrolled-to controls clear of it.
 * @param {HTMLElement} el the bar's host (#rerun-bar)
 * @param {{ root?: HTMLElement, raf?: (fn: Function) => void, delay?: (fn: Function, ms: number) => void }} [env]
 * @returns {{ show(o: { text?: string, actionLabel?: string, dismissLabel?: string, onRun?: Function, onDismiss?: Function }): void, hide(): void, isOpen(): boolean }}
 */
export function createRerunBar(el, { root = typeof document !== 'undefined' ? document.documentElement : null, raf = fn => requestAnimationFrame(fn), delay = (fn, ms) => setTimeout(fn, ms) } = {}) {
    let open = false;
    const bar = {
        /**
         * actionLabel runs (default 'Re-run'); dismissLabel (default 'Not now') only appears with
         * onDismiss — say what it does when it isn't "keep my edits for later", e.g. 'Discard'.
         */
        show({ text = 'Inputs changed', actionLabel = 'Re-run', dismissLabel = 'Not now', onRun, onDismiss } = {}) {
            el.replaceChildren(ui.h('div', { class: 'shell' },
                ui.h('div', { class: 'rerun-text' }, ui.icon('refresh'), ui.h('span', null, text)),
                ui.h('div', { class: 'rerun-actions' },
                    onDismiss ? ui.button({ label: dismissLabel, kind: 'ghost', size: 'sm', onClick: () => { bar.hide(); onDismiss(); } }) : null,
                    ui.button({ label: actionLabel, kind: 'primary', size: 'sm', onClick: () => { bar.hide(); onRun?.(); } }))));
            el.hidden = false;
            open = true;
            root?.classList.add('rerun-open');
            raf(() => { if (open) el.classList.add('show'); });
        },
        hide() {
            open = false;
            el.classList.remove('show');
            root?.classList.remove('rerun-open');
            delay(() => { if (!el.classList.contains('show')) el.hidden = true; }, 260);
        },
        isOpen: () => open,
    };
    return bar;
}

function boot() {
    const $ = id => document.getElementById(id);
    const root = $('view-root');
    const chip = $('ds-chip');
    const tabsEl = $('tabs');
    const rerunEl = $('rerun-bar');
    if (!root) return;

    const engine = createEngine();
    const views = new Map();
    let currentId = null;
    let lastTab = null;

    const router = {
        /** Navigate to a tab with optional params (e.g. go('design', { scenario: 'S01' })). */
        go(tab, params) {
            const hash = buildHash(tab, params);
            if (location.hash === hash) route(); else location.hash = hash;
        },
        /** Replace the current history entry (for param changes that shouldn't add Back steps). */
        replace(tab, params) { history.replaceState(history.state, '', buildHash(tab, params)); route(); },
        params: () => parseHash(location.hash).params,
        current: () => currentId,
    };

    const hub = createDataHub({ engine, store, onNavigate: tab => router.go(tab) });

    const shell = {
        /** The sticky bottom bar for "inputs changed — re-run": show({ text, actionLabel, dismissLabel, onRun, onDismiss }), hide(). */
        rerun: createRerunBar(rerunEl),
        /** Set the document title suffix for the current view. */
        setTitle(t) { document.title = t ? `${t} · Solar calculator` : 'Solar calculator'; },
    };

    const ctx = { store, engine, ui, charts, fmt: ui.fmt, router, data: hub, shell };

    const importFailures = new Map();   // view id → failed imports so far (the next retry's cache-buster)

    async function loadView(id) {
        const meta = ROUTES.find(r => r.id === id) || { id, title: id };
        const n = importFailures.get(id) || 0;
        let mod;
        try {
            // A failed dynamic import stays failed in the module map for the life of the page, so a
            // retry has to ask for a URL the map hasn't seen.
            mod = await import(n ? `./views/${id}.js?retry=${n}` : `./views/${id}.js`);
        } catch (err) {
            console.warn(`view ${id} didn't download:`, err?.message || err);
            importFailures.set(id, n + 1);
            return placeholderView(id, meta.title, err, { download: true, attempts: n + 1, onRetry: () => router.go(id, router.params()) });
        }
        const def = mod?.default;
        if (!def || typeof def.mount !== 'function') return placeholderView(id, meta.title, new Error(`views/${id}.js has no default export with mount()`));
        return def;
    }

    /* Keep the active tab in view in the (scrollable, on phones) tab strip. Scrolls the strip itself:
       element.scrollIntoView moved the page's sequential-focus starting point to the tab, so the
       first Tab after a load skipped the skip link, the brand and the data chip. */
    function revealTab(a) {
        if (!(tabsEl.scrollWidth > tabsEl.clientWidth)) return;
        const strip = tabsEl.getBoundingClientRect();
        const r = a.getBoundingClientRect();
        const left = r.left - strip.left + tabsEl.scrollLeft;
        const right = left + r.width;
        let to = null;
        if (left < tabsEl.scrollLeft + 16) to = left - 16;
        else if (right > tabsEl.scrollLeft + tabsEl.clientWidth - 16) to = right - tabsEl.clientWidth + 16;
        if (to != null) tabsEl.scrollTo({ left: Math.max(0, to), behavior: ui.scrollBehavior() });
    }

    const focusLost = () => {
        const a = document.activeElement;
        return !a || a === document.body || a === document.documentElement || !!a.closest?.('[hidden]');
    };
    /*
     * A view that is still filling in (Design builds its option after the first paint) can replace
     * what the router just focused or scrolled to. For a few seconds after a navigation the router
     * follows it: a replaced heading is focused again while focus has nowhere else to be, and a
     * restored position is re-applied as the page grows — until the user scrolls, types or leaves.
     */
    let settleStop = null;
    const SETTLE_MS = 4000;
    function settle(el, { focus, scrollY }) {
        settleStop?.();
        const headingIn = () => el.querySelector('.view-title') || el.querySelector('h1, h2, .empty-title') || el;
        const focusHeading = () => {
            const t = headingIn();
            if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '-1');
            try { t.focus({ preventScroll: true }); } catch { t.focus?.(); }
            return t;
        };
        let target = focus ? focusHeading() : null;
        let wantY = scrollY;
        const reachY = () => { if (wantY == null) return; window.scrollTo(0, wantY); if (Math.abs(window.scrollY - wantY) <= 1) wantY = null; };
        reachY();
        if (!target && wantY == null) return;
        const watchers = [];
        const stop = () => { for (const off of watchers) off(); watchers.length = 0; if (settleStop === stop) settleStop = null; };
        settleStop = stop;
        const userMoved = () => { wantY = null; };
        for (const evt of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
            window.addEventListener(evt, userMoved, { passive: true, once: true });
            watchers.push(() => window.removeEventListener(evt, userMoved));
        }
        const onChange = () => {
            if (el.hidden) { stop(); return; }
            if (target && !target.isConnected) {
                if (focusLost()) target = focusHeading(); else target = null;
            }
            reachY();
            if (!target && wantY == null) stop();
        };
        if (typeof MutationObserver !== 'undefined') {
            const mo = new MutationObserver(onChange);
            mo.observe(el, { childList: true, subtree: true });
            watchers.push(() => mo.disconnect());
        }
        const timer = setTimeout(stop, SETTLE_MS);
        watchers.push(() => clearTimeout(timer));
    }

    /**
     * Show a view. opts.scrollY: where to put the page (undefined = leave it); opts.focus: move focus
     * to the view's heading when the navigation left it nowhere (on <body>, or inside the view just
     * hidden) — a tab-bar link keeps its focus.
     */
    async function show(id, params, { scrollY, focus = false } = {}) {
        const meta = ROUTES.find(r => r.id === id);
        currentId = id;
        for (const a of tabsEl.querySelectorAll('.tab')) {
            const on = a.dataset.tab === id;
            if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
            if (on) revealTab(a);
        }
        // #data has no tab: the header chip is its way in, so it carries the "you are here".
        if (id === 'data') chip?.setAttribute('aria-current', 'page'); else chip?.removeAttribute('aria-current');
        if (TABS.some(t => t.id === id) && store.get().ui.tab !== id) store.set({ ui: { tab: id } });
        shell.setTitle(meta?.title);

        for (const [vid, v] of views) {
            if (vid === id || v.el.hidden) continue;
            v.el.hidden = true;
            try { v.def?.hide?.(); } catch (err) { console.error(err); }
        }
        let v = views.get(id);
        // A tab whose module didn't download tries again on every visit (and from its Try again button).
        if (v?.def?.failed) {
            try { v.def.unmount?.(); } catch (err) { console.error(err); }
            v.el.remove();
            views.delete(id);
            v = null;
        }
        if (!v) {
            const el = ui.h('section', { class: 'view', dataset: { view: id }, 'aria-label': meta?.title || id });
            el.appendChild(ui.card({ body: ui.skeleton({ lines: 5 }) }));
            root.appendChild(el);
            v = { el, def: null, ready: null };
            views.set(id, v);
            v.ready = loadView(id).then(def => {
                v.def = def;
                v.el.replaceChildren();
                try { def.mount(v.el, ctx); } catch (err) {
                    console.error(`view ${id} failed to mount`, err);
                    v.def = placeholderView(id, meta?.title || id, err);
                    v.el.replaceChildren();
                    v.def.mount(v.el, ctx);
                }
            });
        }
        v.el.hidden = false;
        // A view kept mounted still has its height, so the saved position can be restored at once.
        if (scrollY != null) window.scrollTo(0, scrollY);
        await v.ready;
        if (currentId !== id) return;
        try { v.def?.show?.(params); } catch (err) { console.error(`view ${id} show() failed`, err); }
        // show() may re-render or grow the page (a first visit): settle focus and position on it.
        settle(v.el, { focus: focus && focusLost(), scrollY });
    }

    /*
     * Scroll positions belong to history entries. Every entry the router sees gets a key in
     * history.state; the position is recorded against the entry being left. Coming back to an
     * entry (Back/Forward — popstate can't tell those from a link click, a key can) restores where
     * the user was; a new entry for another tab starts at the top. The browser's own restoration is
     * off: it ran before the router swapped views, so it was capped by the old view's height and
     * then overwritten.
     */
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch { /* read-only in odd embeds */ }
    const positions = new Map();   // entry key → scrollY when the user left that entry
    let currentKey = null;
    let entrySeq = 0;
    let lastRouted = null;         // the hash route() last handled
    let booting = true;
    const entryKey = () => {
        let k = history.state?.scKey;
        if (!k) {
            k = `e${Date.now().toString(36)}${++entrySeq}`;
            try { history.replaceState({ ...(history.state || {}), scKey: k }, ''); } catch { /* state not writable: no restoring */ }
        }
        return k;
    };

    /**
     * Route the current hash. An anchor that isn't a route (the skip link's #main, when its click
     * handler didn't run) only moves focus — the view, its params and the URL stay as they were.
     */
    function route() {
        settleStop?.();
        const raw = String(location.hash || '').replace(/^#\/?/, '');
        const { tab, params, known } = parseHash(location.hash);
        if (!known && raw) {
            const anchor = document.getElementById(raw.split('?')[0]);
            if (anchor && lastRouted != null) {
                history.replaceState(history.state, '', lastRouted);
                try { anchor.focus(); } catch { /* not focusable */ }
                return;
            }
        }
        if (!known && location.hash && location.hash !== '#') history.replaceState(history.state, '', buildHash(tab, params));
        lastRouted = location.hash;
        if (currentKey) positions.set(currentKey, window.scrollY);
        const key = entryKey();
        const returning = key !== currentKey && positions.has(key);
        currentKey = key;
        const tabChanged = tab !== lastTab;
        lastTab = tab;
        const scrollY = returning ? positions.get(key) : tabChanged ? 0 : undefined;
        show(tab, params, { scrollY, focus: !booting });
    }

    const paintChip = () => chipContent(chip, store.get().dataset, hub.status());
    hub.on('status', paintChip);
    store.subscribe(paintChip, ['dataset']);
    paintChip();

    // Printing: light tokens, chart table twins built, every <details> open, then put it all back.
    // matchMedia('print') is the fallback for browsers/paths that skip before/afterprint.
    const reopened = [];
    let printing = false;
    const enterPrint = () => {
        if (printing) return;
        printing = true;
        document.documentElement.dataset.print = '';
        for (const d of document.querySelectorAll('details:not([open])')) { d.open = true; reopened.push(d); }
        charts.setPrintMode(true);
    };
    const leavePrint = () => {
        if (!printing) return;
        printing = false;
        delete document.documentElement.dataset.print;
        while (reopened.length) reopened.pop().open = false;
        charts.setPrintMode(false);
    };
    window.addEventListener('beforeprint', enterPrint);
    window.addEventListener('afterprint', leavePrint);
    try { window.matchMedia?.('print').addEventListener?.('change', e => (e.matches ? enterPrint() : leavePrint())); } catch { /* old Safari: before/afterprint only */ }

    window.addEventListener('hashchange', route);
    // A navigation to the URL already showing can replace its history entry without a hashchange,
    // and may clear its state: keep the entry's scroll key so Back to it still restores.
    window.addEventListener('popstate', () => {
        if (history.state?.scKey || !currentKey || location.hash !== lastRouted) return;
        try { history.replaceState({ ...(history.state || {}), scKey: currentKey }, ''); } catch { /* not writable */ }
    });
    // The skip link is an in-page jump, not a route: it must not change the view, its params or
    // the URL (a #main hash used to fall back to the Verdict from every other tab).
    document.querySelector('.skip-link')?.addEventListener('click', e => {
        const main = document.getElementById('main');
        if (!main) return;
        e.preventDefault();
        main.focus();
    });
    // A dataset whose engine couldn't start (a download failed) recovers as soon as the network is back.
    window.addEventListener('online', () => { if (store.get().dataset?.engineUnavailable) hub.retryEngine().catch(() => {}); });
    if (!location.hash) history.replaceState(null, '', buildHash(store.get().ui.tab || 'verdict'));
    route();

    // Bring back what the user had last time (demo is offline and instant; Octopus only if the key is to hand).
    let savedKey = null;
    try { savedKey = getApiKey(); } catch { savedKey = null; }
    const conn = store.get().connection;
    const spec = autoReloadSpec(conn, savedKey);
    if (spec) {
        hub.load(spec, { navigate: false }).catch(err => {
            if (err?.name === 'AbortError') return;
            ui.toast(`Couldn’t reload your data: ${err?.message || err}`, { tone: 'warn', timeoutMs: 8000, action: { label: 'Open data', onClick: () => router.go('data') } });
        });
    } else if (conn.kind === 'csv' && !['data', 'method'].includes(parseHash(location.hash).tab)) {
        // A CSV can't come back on its own (the file is never stored): go where it can be chosen
        // again — the Data view's CSV form says why ("Last time you used a CSV file…").
        router.replace('data', { mode: 'csv' });
    }
    // From here on, a navigation that leaves focus nowhere moves it to the new view's heading
    // (the first route leaves it alone, so the first Tab still reaches the skip link).
    booting = false;

    store.set({ ui: { tab: store.get().ui.tab } });
    if (!store.persistOk()) ui.toast('This browser won’t let the calculator save settings — they’ll reset when you close the tab.', { tone: 'warn', timeoutMs: 7000 });

    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) window.__solar = { engine, store, data: hub, router, ui, charts };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
}
