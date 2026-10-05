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
 * @param {{ engine: object, store: object, onNavigate?: (tab: string) => void }} deps
 * @returns {object} DataHub
 */
export function createDataHub({ engine, store: st, onNavigate }) {
    const listeners = new Map();
    const inflight = new Set();
    let status = 'empty';                // 'empty' | 'loading' | 'ready' | 'error'
    let loadJob = null;
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
        const opts = { finance: financeOpts(), maxPaybackYears: s.maxPaybackYears ?? 10 };
        if (s.spots?.length) opts.spots = s.spots;
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
                const spots = st.get().settings.spots;
                const job = track(engine.call('autoScenarios', spots?.length ? { spots } : {}));
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
                if (Number.isFinite(pb) && !summary.engineUnavailable) await engine.call('setProjectBaseW', pb).catch(() => {});
                // A newer load() started while we waited: it owns the store and the status now.
                if (loadJob !== job) throw Object.assign(new Error('Cancelled'), { name: 'AbortError', code: 'CANCELLED' });
                st.set({ dataset: summary, connection: connectionFor(spec) });
                // Status first: views re-rendering on 'dataset' must not still see 'loading'.
                setStatus('ready');
                hub.invalidate('dataset');
                if (navigate) onNavigate?.('verdict');
                return summary;
            } catch (err) {
                if (err?.name === 'AbortError') { if (loadJob === job) setStatus(st.get().dataset ? 'ready' : prev === 'error' ? 'error' : 'empty'); }
                else setStatus(st.get().dataset ? 'ready' : 'error');
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
        if (pb !== lastProjectBaseW && state.dataset && !state.dataset.engineUnavailable) {
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

function placeholderView(id, title, err) {
    const missing = /fetch|import|find module|404|load/i.test(String(err?.message || err || ''));
    let off = null;
    return {
        id, title,
        mount(el, ctx) {
            const render = () => {
                // A connect card on screen reports its own progress and errors: never swap it out mid-load.
                const showingCard = !!el.querySelector('.connect-card');
                if (!ctx.data.summary() && showingCard) return;
                if (ctx.data.status() === 'loading') { el.replaceChildren(ui.card({ body: ui.skeleton({ lines: 5 }) })); return; }
                if (!ctx.data.summary() && id !== 'method' && id !== 'data') { el.replaceChildren(ui.connectCard(ctx)); return; }
                el.replaceChildren(ui.card({
                    className: 'placeholder-card',
                    body: ui.emptyState({
                        title: missing ? `${title} is on its way` : `${title} couldn’t load`,
                        body: missing ? 'This part of the calculator hasn’t been built yet. The other tabs work with your data.'
                            : `Something broke while loading this view: ${err?.message || err}`,
                        action: id === 'verdict' ? { label: 'See your data', href: '#data' } : { label: 'Back to the verdict', href: '#verdict' },
                    }),
                }));
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
        replace(tab, params) { history.replaceState(null, '', buildHash(tab, params)); route(); },
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

    async function loadView(id) {
        const meta = ROUTES.find(r => r.id === id) || { id, title: id };
        try {
            const mod = await import(`./views/${id}.js`);
            const def = mod.default;
            if (!def || typeof def.mount !== 'function') throw new Error(`views/${id}.js has no default export with mount()`);
            return def;
        } catch (err) {
            console.warn(`view ${id} unavailable:`, err?.message || err);
            return placeholderView(id, meta.title, err);
        }
    }

    async function show(id, params) {
        const meta = ROUTES.find(r => r.id === id);
        currentId = id;
        for (const a of tabsEl.querySelectorAll('.tab')) {
            const on = a.dataset.tab === id;
            if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
            if (on && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
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
        await v.ready;
        if (currentId !== id) return;
        try { v.def?.show?.(params); } catch (err) { console.error(`view ${id} show() failed`, err); }
    }

    function route() {
        const { tab, params, known } = parseHash(location.hash);
        if (!known && location.hash && location.hash !== '#') history.replaceState(null, '', buildHash(tab, params));
        const tabChanged = tab !== lastTab;
        lastTab = tab;
        show(tab, params);
        if (tabChanged) window.scrollTo({ top: 0 });
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

    store.set({ ui: { tab: store.get().ui.tab } });
    if (!store.persistOk()) ui.toast('This browser won’t let the calculator save settings — they’ll reset when you close the tab.', { tone: 'warn', timeoutMs: 7000 });

    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) window.__solar = { engine, store, data: hub, router, ui, charts };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
}
