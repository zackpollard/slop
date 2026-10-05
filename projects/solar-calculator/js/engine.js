/*
 * engine.js — promise client for the engine worker (contract §16).
 *
 *   const engine = createEngine();
 *   const summary = await engine.call('loadDataset', spec, { onProgress: p => … });
 *   const job = engine.call('verdict', opts, { onProgress: v => render(v.verdict) });
 *   job.cancel();                       // rejects job with an AbortError and tells the worker to stop
 *
 * The worker is a module worker. Where module workers are unsupported, or the worker script fails
 * before it says it's ready, the same dispatcher (worker.js) runs inline on the main thread — slower
 * and blocking, but the app still works. Messages are structured-cloned in both modes, so a view
 * that accidentally passes a function fails the same way in development as in production.
 *
 * A module that failed to download stays failed in the worker's module map, and worker.js's
 * cache-busting retry can't reach a module imported by another (dataset.js is imported back by
 * octopus.js and csv.js). So when a call fails with MISSING_MODULE before any dataset lives in the
 * worker — nothing to lose — the worker is replaced by a fresh one (a fresh module map) and the call
 * replayed, once per call. After a dataset has loaded, the error goes to the page (whose message
 * offers a reload).
 */

/**
 * @typedef {Promise<any> & { id: number, cancel(): void }} EngineCall
 * @typedef {{ call(method: string, ...args: any[]): EngineCall, onProgress(id: number, fn: (v: any) => void): () => void,
 *   terminate(): void, readonly mode: 'worker'|'inline', ready: Promise<'worker'|'inline'> }} EngineClient
 */

const OPTION_KEYS = new Set(['onProgress', 'signal']);

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError', code: 'CANCELLED' });

/**
 * Rebuild an Error from the serialised form `{ name, code, message, step, retryable, action, choices }`.
 * @param {object} e
 * @returns {Error}
 */
export function reviveError(e) {
    const err = new Error(e?.message || 'Engine error');
    err.name = e?.name || 'EngineError';
    for (const k of ['code', 'step', 'retryable', 'action', 'choices']) err[k] = e?.[k] ?? null;
    return err;
}

const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : v);

function isOptionsBag(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
    const keys = Object.keys(x);
    return keys.length > 0 && keys.every(k => OPTION_KEYS.has(k)) && (typeof x.onProgress === 'function' || (x.signal && typeof x.signal.aborted === 'boolean'));
}

/**
 * Start the engine.
 * @param {{ inThread?: boolean, createDispatcher?: Function }} [opts]
 *   inThread forces inline mode; createDispatcher replaces worker.js's factory (tests).
 * @returns {EngineClient}
 */
export function createEngine({ inThread = false, createDispatcher = null } = {}) {
    const pending = new Map();
    const listeners = new Map();
    let nextId = 1;
    let mode = 'worker';
    let worker = null;
    let workerReady = false;
    let inline = null;            // Promise<dispatcher>
    let terminated = false;
    let datasetLoaded = false;   // a dataset lives in this worker: replacing the worker would lose it
    let resolveReady;
    const ready = new Promise(r => { resolveReady = r; });

    function deliver(msg, from) {
        if (!msg || typeof msg !== 'object') return;
        if (from && from !== worker) return;   // a replaced worker's late messages
        if (msg.type === 'ready') { workerReady = true; resolveReady('worker'); return; }
        const p = pending.get(msg.id);
        if (!p) return;   // cancelled or unknown: drop late messages
        if (msg.type === 'progress') {
            try { p.onProgress?.(msg.value); } catch (err) { console.error('progress handler failed', err); }
            for (const fn of listeners.get(msg.id) || []) { try { fn(msg.value); } catch (err) { console.error(err); } }
            return;
        }
        if (msg.type === 'error' && msg.error?.code === 'MISSING_MODULE' && worker && !datasetLoaded && !p.respawned) {
            p.respawned = true;
            respawn();
            return;
        }
        pending.delete(msg.id);
        listeners.delete(msg.id);
        if (msg.type === 'result') {
            if (p.msg?.method === 'loadDataset') datasetLoaded = true;
            p.resolve(msg.value);
        } else p.reject(reviveError(msg.error));
    }

    /* Start a module worker; null when this browser can't run one. */
    function spawn() {
        let moduleOk = false;
        // Browsers without module workers never read `type`, so this getter is the feature test.
        const w = new Worker(new URL('./worker.js', import.meta.url), { get type() { moduleOk = true; return 'module'; } });
        if (!moduleOk) { w.terminate(); return null; }
        w.addEventListener('message', e => deliver(e.data, w));
        w.addEventListener('error', e => {
            if (w !== worker) return;
            if (!workerReady) { e.preventDefault?.(); failover('worker failed to start'); return; }
            console.error('engine worker error', e.message || e);
        });
        w.addEventListener('messageerror', () => console.error('engine worker sent an unreadable message'));
        return w;
    }

    /* Replace the worker with a fresh one (a fresh module map) and send it everything still unanswered. */
    function respawn() {
        const old = worker;
        let w = null;
        try { w = spawn(); } catch { w = null; }
        if (!w) { failover('worker could not be restarted'); return; }
        worker = w;
        workerReady = false;
        try { old?.terminate(); } catch { /* already gone */ }
        console.info('solar engine worker restarted after a module failed to download');
        for (const p of pending.values()) { try { w.postMessage(p.msg); } catch { /* cloned fine the first time */ } }
    }

    function startInline(reason) {
        if (inline) return inline;
        mode = 'inline';
        if (reason) console.info(`solar engine running on the main thread (${reason})`);
        inline = (async () => {
            const factory = createDispatcher ?? (await import('./worker.js')).createDispatcher;
            return factory({
                // Mirror postMessage: clone, and deliver asynchronously so callers never see re-entrancy.
                post: msg => { const c = clone(msg); queueMicrotask(() => deliver(c)); },
            });
        })();
        inline.then(() => resolveReady('inline'), err => {
            for (const [id, p] of pending) { pending.delete(id); p.reject(err); }
        });
        return inline;
    }

    function failover(reason) {
        try { worker?.terminate(); } catch { /* already gone */ }
        worker = null;
        startInline(reason);
        // Replay everything the dead worker never answered.
        for (const p of pending.values()) inline.then(d => d.handle(clone(p.msg)));
    }

    if (inThread || createDispatcher || typeof Worker === 'undefined') {
        startInline(inThread || createDispatcher ? null : 'no Worker support');
    } else {
        try {
            const w = spawn();
            if (!w) startInline('module workers unsupported');
            else worker = w;
        } catch (err) {
            startInline(`worker blocked: ${err?.message || err}`);
        }
    }

    function send(msg) {
        if (terminated) throw Object.assign(new Error('Engine terminated'), { name: 'EngineError', code: 'TERMINATED' });
        if (worker) worker.postMessage(msg);
        else {
            const c = clone(msg);     // throws DataCloneError for functions, like postMessage would
            inline.then(d => d.handle(c));
        }
    }

    return {
        get mode() { return mode; },
        ready,

        call(method, ...args) {
            let opts = null;
            if (args.length && isOptionsBag(args[args.length - 1])) opts = args.pop();
            const id = nextId++;
            const msg = { type: 'call', id, method, args };
            let entry;
            const promise = new Promise((resolve, reject) => {
                entry = { resolve, reject, onProgress: opts?.onProgress, msg };
                pending.set(id, entry);
            });
            try {
                send(msg);
            } catch (err) {
                pending.delete(id);
                entry.reject(err);
            }
            promise.id = id;
            promise.cancel = () => {
                const p = pending.get(id);
                if (!p) return;
                pending.delete(id);
                listeners.delete(id);
                try { if (worker) worker.postMessage({ type: 'cancel', id }); else inline?.then(d => d.handle({ type: 'cancel', id })); } catch { /* engine gone */ }
                p.reject(abortError());
            };
            if (opts?.signal) {
                if (opts.signal.aborted) promise.cancel();
                else opts.signal.addEventListener('abort', () => promise.cancel(), { once: true });
            }
            return promise;
        },

        onProgress(id, fn) {
            if (!listeners.has(id)) listeners.set(id, new Set());
            listeners.get(id).add(fn);
            return () => listeners.get(id)?.delete(fn);
        },

        terminate() {
            terminated = true;
            try { worker?.terminate(); } catch { /* fine */ }
            worker = null;
            for (const [id, p] of pending) { pending.delete(id); p.reject(Object.assign(new Error('Engine terminated'), { name: 'EngineError', code: 'TERMINATED' })); }
            listeners.clear();
        },
    };
}
