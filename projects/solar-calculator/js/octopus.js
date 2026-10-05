/*
 * octopus.js — Octopus Energy REST/GraphQL client + pure helpers.
 *
 * Every quirk below was verified live on 2026-10-05 (docs/solar-calculator/VERIFY-octopus.md):
 *   - CORS is `*` everywhere; auth is HTTP Basic with the key as the user name and an
 *     empty password. We never send `credentials: 'include'` (that makes the browser
 *     refuse the `*` CORS answer) and only ever attach the key to api.octopus.energy.
 *   - Account numbers match ^A-[0-9A-Z]{8}$ (NOT hex-only). Anything else is answered
 *     with an HTML 404 page, not JSON, so bodies are read as text and sniffed.
 *   - Consumption pages hold up to 25 000 rows; `consumption` can arrive as a string;
 *     `interval_start` carries local offsets ('Z', '+01:00', sometimes '+0100'); a query
 *     returns every record that OVERLAPS the period, so readings are deduped by epoch.
 *   - Rate endpoints silently cap page_size at 1500, ignore order_by and always answer
 *     newest-first, so we sort ourselves and follow the absolute `next` links one
 *     request at a time (a year of half-hourly Agile = 12 requests).
 *   - A raw '+' in a query string is read as a space (400 'Enter a valid date/time'),
 *     hence URLSearchParams everywhere.
 *   - Flat tariffs publish DIRECT_DEBIT and NON_DIRECT_DEBIT duplicates; Agile rows have
 *     payment_method null. We prefer DIRECT_DEBIT, then null, then anything else.
 *   - value_inc_vat on long/open records (standing charges, flat tariffs) is rewritten
 *     retroactively when VAT changes, so only value_exc_vat is ever read here.
 *   - GraphQL failures arrive as HTTP 200 with an `errors[]` array.
 */

import { SLOT_MS, parseOctopusTime, localParts, localMidnightUtc, buildLocalIndex } from './time.js';
import { DataError } from './dataset.js';

/** Base URL; the API key is only ever sent to this origin. */
export const API_BASE = 'https://api.octopus.energy';

/** GSP group letters → DNO region names (no I or O). */
export const REGIONS = Object.freeze({
    A: 'Eastern England', B: 'East Midlands', C: 'London', D: 'Merseyside & North Wales',
    E: 'West Midlands', F: 'North East England', G: 'North West England', H: 'Southern England',
    J: 'South East England', K: 'South Wales', L: 'South West England', M: 'Yorkshire',
    N: 'South Scotland', P: 'North Scotland',
});

/**
 * Rough population-weighted centre of each GSP region, used only when we cannot geocode
 * a postcode. Good to ~50 km, which moves annual irradiance by a few percent.
 */
export const REGION_CENTROIDS = Object.freeze({
    A: { lat: 52.20, lon: 0.55 }, B: { lat: 52.85, lon: -1.15 }, C: { lat: 51.507, lon: -0.128 },
    D: { lat: 53.25, lon: -3.05 }, E: { lat: 52.48, lon: -2.00 }, F: { lat: 54.85, lon: -1.60 },
    G: { lat: 53.60, lon: -2.55 }, H: { lat: 51.20, lon: -1.30 }, J: { lat: 51.20, lon: 0.55 },
    K: { lat: 51.65, lon: -3.40 }, L: { lat: 50.60, lon: -3.80 }, M: { lat: 53.80, lon: -1.40 },
    N: { lat: 55.85, lon: -3.80 }, P: { lat: 57.20, lon: -3.10 },
});

/** Product codes current on 2026-10-05. The newest Agile is re-discovered at runtime. */
export const CURRENT = Object.freeze({
    agile: 'AGILE-24-10-01',
    agileOutgoing: 'AGILE-OUTGOING-19-05-13',
    outgoingFixed: 'OUTGOING-VAR-24-10-26',
    outgoingPrime: 'OUTGOING-PRIME-FIX-12M-26-06-23',
    flexible: 'VAR-22-11-01',
});

/**
 * Agile price caps (p/kWh INC 5% VAT) per product version. They bind exactly in the
 * 16:00–19:00 peak this app cares about, so a version is only interchangeable with
 * AGILE-24-10-01 when its cap is also 100p (VERIFY-octopus: 0 of 17 520 slots differ).
 */
export const AGILE_CAPS_INC = Object.freeze({
    'AGILE-18-02-21': 35, 'AGILE-22-07-22': 55, 'AGILE-22-08-31': 78,
    'AGILE-23-12-06': 100, 'AGILE-24-04-03': 100, 'AGILE-24-10-01': 100, 'AGILE-BB-24-10-01': 100,
});

/**
 * Agile import versions newest first. Each still publishes its own history, so half-hours
 * from before the customer's version existed (an old CSV priced "as if on Agile") are taken
 * from the version that was on sale then rather than smeared with one carried price.
 */
export const AGILE_LINEAGE = Object.freeze([
    'AGILE-24-10-01', 'AGILE-24-04-03', 'AGILE-23-12-06', 'AGILE-22-08-31', 'AGILE-22-07-22', 'AGILE-18-02-21',
]);

/**
 * Ex-VAT cap of an Agile version in p/kWh, Infinity for the 100p versions (they never bind
 * differently from AGILE-24-10-01). Caps are published inc 5% VAT and the ex-VAT rows
 * truncate to 2 dp (33.33 / 52.38 / 74.28 observed).
 * @param {string} product
 * @returns {number}
 */
export function agileCapExc(product) {
    const cap = AGILE_CAPS_INC[product];
    return cap && cap !== 100 ? Math.floor(cap / 1.05 * 100) / 100 : Infinity;
}

/** Outgoing Prime has no rate rows before its launch; earlier history is synthesised. */
export const PRIME_FROM_MS = Date.parse('2026-06-22T23:00:00Z');
/** Outgoing (fixed) paid 15p until this instant, 12p after. */
export const OUTGOING_FIXED_CHANGE_MS = Date.parse('2026-03-01T00:00:00Z');

const ACCOUNT_RE = /^A-[0-9A-Z]{8}$/;
const TARIFF_RE = /^([EG])-(\d)R-(.+)-([A-HJ-NP])$/;
const MAX_RETRIES = 4;
const DAY_MS = 86_400_000;

/**
 * Trim and upper-case a typed account number; null when it can't be one.
 * @param {string|null|undefined} s
 * @returns {string|null}
 */
export function normaliseAccountNumber(s) {
    if (typeof s !== 'string') return null;
    const v = s.trim().toUpperCase().replace(/\s+/g, '');
    return ACCOUNT_RE.test(v) ? v : null;
}

/**
 * Split a tariff code such as 'E-1R-AGILE-24-10-01-C'.
 * @param {string} code
 * @returns {{ code, fuel: 'E'|'G', registers: number, product: string, region: string, isAgile: boolean, isExport: boolean }|null}
 */
export function parseTariffCode(code) {
    if (typeof code !== 'string') return null;
    const m = TARIFF_RE.exec(code.trim().toUpperCase());
    if (!m) return null;
    const product = m[3];
    // Direction is null on product-detail responses, so infer export from the code.
    const isExport = /OUTGOING|EXPORT/.test(product);
    return {
        code: m[0], fuel: m[1], registers: Number(m[2]), product, region: m[4],
        isAgile: /^AGILE-/.test(product) && !isExport, isExport,
    };
}

/** Parse an API timestamp; null/undefined → the given default (open-ended records). */
function timeOr(s, dflt) {
    if (s == null || s === '') return dflt;
    return parseOctopusTime(String(s));
}

/**
 * Normalise a GET /v1/accounts/{n}/ body and pick the property, import meter point and
 * export meter point the app should use.
 *
 * Property: moved_out_at null first, then the latest moved_in_at. Import point: the one
 * with an open (or most recent) agreement. `importChoices.length > 1` means the choice
 * was ambiguous and the UI may offer a picker.
 *
 * @param {object} raw
 * @returns {{ number: string, properties: object[], property: object|null, importPoint: object|null,
 *   importChoices: object[], exportPoint: object|null, agreements: object[], region: string|null, postcode: string|null }}
 */
export function parseAccount(raw) {
    const properties = (raw?.properties ?? []).map(p => {
        const points = (p.electricity_meter_points ?? []).map(mp => ({
            mpan: String(mp.mpan ?? ''),
            isExport: Boolean(mp.is_export),
            profileClass: mp.profile_class ?? null,
            serials: [...new Set((mp.meters ?? []).map(m => String(m.serial_number ?? '').trim()).filter(Boolean))],
            agreements: (mp.agreements ?? []).map(a => {
                const t = parseTariffCode(a.tariff_code);
                return {
                    code: String(a.tariff_code ?? ''),
                    product: t?.product ?? null,
                    region: t?.region ?? null,
                    isAgile: t?.isAgile ?? false,
                    fromMs: timeOr(a.valid_from, -Infinity),
                    toMs: timeOr(a.valid_to, Infinity),
                };
            }).filter(a => a.product).sort((x, y) => x.fromMs - y.fromMs),
        })).filter(mp => mp.mpan);
        return {
            id: p.id ?? null,
            postcode: p.postcode ? String(p.postcode).trim().toUpperCase() : null,
            address: [p.address_line_1, p.address_line_2, p.address_line_3, p.town].filter(Boolean).join(', '),
            movedInMs: timeOr(p.moved_in_at, -Infinity),
            movedOutMs: timeOr(p.moved_out_at, null),
            importPoints: points.filter(mp => !mp.isExport),
            exportPoints: points.filter(mp => mp.isExport),
        };
    });

    const ranked = properties.slice().sort((a, b) =>
        ((a.movedOutMs === null) === (b.movedOutMs === null) ? 0 : a.movedOutMs === null ? -1 : 1)
        || (b.movedInMs - a.movedInMs));
    const property = ranked[0] ?? null;

    const lastEnd = mp => mp.agreements.reduce((m, a) => Math.max(m, a.toMs), -Infinity);
    const importChoices = (property?.importPoints ?? []).slice().sort((a, b) => lastEnd(b) - lastEnd(a));
    const open = importChoices.filter(mp => lastEnd(mp) === Infinity);
    const importPoint = importChoices[0] ?? null;
    const exportPoint = (property?.exportPoints ?? []).slice().sort((a, b) => lastEnd(b) - lastEnd(a))[0] ?? null;
    const agreements = importPoint?.agreements ?? [];
    const latest = agreements[agreements.length - 1];
    return {
        number: String(raw?.number ?? ''),
        properties, property, importPoint,
        // Ambiguous only when several import points are all still on supply.
        importChoices: open.length > 1 ? open : [importPoint].filter(Boolean),
        exportPoint, agreements,
        region: latest?.region ?? null,
        postcode: property?.postcode ?? null,
    };
}

/**
 * Paint interval rate records onto the half-hour grid. A slot takes a record's value when
 * the record's [fromMs, toMs) contains the slot START. Duplicate records for one period
 * resolve by payment method (DIRECT_DEBIT > null > anything else), then by later fromMs.
 *
 * @param {Array<{ fromMs: number, toMs: number, exc: number, paymentMethod?: string|null }>} rates
 * @param {number} start  epoch ms of slot 0
 * @param {number} n
 * @returns {Float64Array} p/kWh exc VAT per slot; NaN where no record applies
 */
export function expandRatesToSlots(rates, start, n) {
    const out = new Float64Array(n).fill(NaN);
    const rank = pm => pm === 'DIRECT_DEBIT' ? 2 : pm == null ? 1 : 0;
    const ordered = rates.slice().sort((a, b) => rank(a.paymentMethod) - rank(b.paymentMethod) || a.fromMs - b.fromMs);
    const end = start + n * SLOT_MS;
    for (const r of ordered) {
        if (!Number.isFinite(r.exc)) continue;
        const from = Math.max(r.fromMs, start);
        const to = Math.min(r.toMs ?? Infinity, end);
        if (!(to > from)) continue;
        const i0 = Math.max(0, Math.ceil((from - start) / SLOT_MS));
        const i1 = Math.min(n, Math.ceil((to - start) / SLOT_MS));
        out.fill(r.exc, i0, i1);
    }
    return out;
}

/**
 * Merge readings from several meter serials of one MPAN onto the grid. A meter exchange
 * leaves the old and new serials both listed, sometimes with overlapping (duplicated or
 * zero) data, so values are NEVER summed: the active meter — the serial whose readings
 * run latest — wins each slot, except that its zero yields to another serial's positive
 * reading (an uncommissioned or removed meter reports zeros, a working one doesn't).
 *
 * @param {Array<Array<[number, number]>>} series  one ascending [ms, kWh] list per serial
 * @param {number} start
 * @param {number} n
 * @returns {Float64Array} kWh per slot; NaN where no serial has a reading
 */
export function mergeConsumption(series, start, n) {
    const ordered = series
        .filter(s => s && s.length)
        .map(s => ({ s, last: s[s.length - 1][0] }))
        .sort((a, b) => b.last - a.last || b.s.length - a.s.length)
        .map(x => x.s);
    const out = new Float64Array(n).fill(NaN);
    for (const s of ordered) {
        for (const [ms, kwh] of s) {
            const k = (ms - start) / SLOT_MS;
            if (!Number.isInteger(k) || k < 0 || k >= n || !Number.isFinite(kwh)) continue;
            const cur = out[k];
            if (Number.isNaN(cur) || (cur === 0 && kwh > 0)) out[k] = kwh;
        }
    }
    return out;
}

/** Exponential backoff with a little jitter, capped at 8 s. */
function backoffMs(attempt) {
    return Math.min(8000, 500 * 2 ** attempt) * (0.85 + 0.3 * Math.random());
}

function retryAfterMs(res) {
    const v = res.headers?.get?.('retry-after');
    if (!v) return null;
    const s = Number(v);
    if (Number.isFinite(s)) return Math.min(30_000, Math.max(0, s * 1000));
    const d = Date.parse(v);
    return Number.isFinite(d) ? Math.min(30_000, Math.max(0, d - Date.now())) : null;
}

function toIso(ms) {
    return new Date(ms).toISOString();
}

/** Thin REST/GraphQL client. One request in flight at a time per call chain. */
export class OctopusClient {
    /**
     * @param {{ apiKey?: string|null, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>,
     *   signal?: AbortSignal, onRequest?: (url: string) => void, cache?: { get, set }|null, nowMs?: number }} opts
     *   cache: optional cache.js store for PUBLIC rate pages of closed periods (never account data)
     */
    constructor({ apiKey = null, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), sleep, signal, onRequest, cache = null, nowMs = Date.now() } = {}) {
        this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : null;
        this.fetch = fetchImpl;
        this.sleep = sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
        this.signal = signal ?? null;
        this.onRequest = onRequest ?? null;
        this.cache = cache;
        this.nowMs = nowMs;
        this.requests = 0;
    }

    /** Authorization header value, or a DataError for an unusable key. */
    authHeader() {
        if (!this.apiKey) {
            throw new DataError('AUTH', 'An Octopus API key is needed to read your usage.', { action: 'checkKey' });
        }
        try {
            return 'Basic ' + btoa(this.apiKey + ':');
        } catch {
            throw new DataError('AUTH', 'That API key contains characters Octopus keys never have.', { action: 'checkKey' });
        }
    }

    /**
     * One HTTP exchange with retries on 429/5xx/network errors. Resolves to
     * `{ status, json, text }` for every other status; aborts propagate unchanged.
     */
    async request(url, { auth = false, method = 'GET', body = null, headers = {} } = {}) {
        const target = new URL(url, API_BASE);
        if (target.origin !== API_BASE) {
            // A `next` link pointing elsewhere must never receive the key.
            throw new DataError('NETWORK', `Refusing to follow an unexpected link to ${target.origin}.`, { retryable: false });
        }
        const h = { Accept: 'application/json', ...headers };
        if (auth) h.Authorization = this.authHeader();
        for (let attempt = 0; ; attempt++) {
            if (this.signal?.aborted) throw this.signal.reason ?? new DOMException('Aborted', 'AbortError');
            this.requests++;
            this.onRequest?.(target.href);
            let res;
            try {
                res = await this.fetch(target.href, {
                    method, headers: h, body, credentials: 'omit', signal: this.signal ?? undefined,
                });
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                if (attempt < MAX_RETRIES) { await this.sleep(backoffMs(attempt)); continue; }
                throw new DataError('NETWORK', `Couldn't reach Octopus (${e?.message ?? 'network error'}).`, { retryable: true, action: 'retry' });
            }
            if (res.status === 429 || res.status >= 500) {
                if (attempt < MAX_RETRIES) { await this.sleep(retryAfterMs(res) ?? backoffMs(attempt)); continue; }
                throw res.status === 429
                    ? new DataError('RATE_LIMIT', 'Octopus is rate-limiting requests. Wait a minute and try again.', { retryable: true, action: 'retry' })
                    : new DataError('NETWORK', `Octopus returned an error (${res.status}). Try again shortly.`, { retryable: true, action: 'retry' });
            }
            const text = await res.text();
            let json = null;
            const t = text.trimStart();
            if (t.startsWith('{') || t.startsWith('[')) {
                try { json = JSON.parse(text); } catch { json = null; }
            }
            return { status: res.status, json, text };
        }
    }

    /**
     * GET that must return JSON. 401 → AUTH; 404 → `notFound` (a DataError to throw, or
     * a value to return); other 4xx / non-JSON 200 → NETWORK.
     */
    async getJson(url, { auth = false, notFound } = {}) {
        const { status, json } = await this.request(url, { auth });
        if (status === 401) {
            throw new DataError('AUTH', json?.detail === 'Invalid API key.'
                ? 'Octopus says that API key is not valid.'
                : 'Octopus did not accept the API key.', { action: 'checkKey' });
        }
        if (status === 404) {
            if (notFound instanceof Error) throw notFound;
            if (notFound !== undefined) return notFound;
            throw new DataError('NETWORK', 'Octopus could not find that resource (404).', { retryable: false });
        }
        if (status === 403) {
            throw new DataError('ACCOUNT', 'This API key is not allowed to read that account.', { action: 'pickAccount' });
        }
        if (status < 200 || status >= 300 || json === null) {
            const detail = json?.detail ? `: ${json.detail}` : '';
            const err = new DataError('NETWORK', `Unexpected answer from Octopus (${status}${detail}).`, { retryable: status >= 500 || json === null, action: 'retry' });
            err.status = status;
            throw err;
        }
        return json;
    }

    /** Follow DRF pagination (`results` + absolute `next`) sequentially. */
    async paged(url, opts = {}) {
        const out = [];
        let next = url;
        for (let pages = 0; next; pages++) {
            if (pages > 400) throw new DataError('NETWORK', 'Octopus pagination did not end.', { retryable: true });
            const json = await this.getJson(next, opts);
            if (json === opts.notFound) return out;
            for (const r of json.results ?? []) out.push(r);
            next = json.next || null;
        }
        return out;
    }

    /**
     * Raw account body. Validates the number locally first because the API answers a
     * malformed one with an HTML 404 page.
     * @param {string} number
     */
    async account(number) {
        const num = normaliseAccountNumber(number);
        if (!num) {
            throw new DataError('ACCOUNT', 'Octopus account numbers look like A-1234ABCD.', { action: 'pickAccount' });
        }
        return this.getJson(`${API_BASE}/v1/accounts/${num}/`, {
            auth: true,
            notFound: new DataError('ACCOUNT', `Octopus has no account ${num} for this API key.`, { action: 'pickAccount' }),
        });
    }

    /**
     * POST a GraphQL document. Errors come back as HTTP 200 + `errors[]`.
     * @returns {Promise<object>} `data`
     */
    async graphql(query, variables = {}, token = null) {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers.Authorization = token;
        const { status, json } = await this.request(`${API_BASE}/v1/graphql/`, {
            method: 'POST', body: JSON.stringify({ query, variables }), headers,
        });
        const errs = json?.errors;
        if (Array.isArray(errs) && errs.length) {
            const code = errs[0]?.extensions?.errorCode ?? '';
            const err = new DataError(code === 'KT-CT-1139' || code === 'KT-CT-1112' || code === 'KT-CT-1124' ? 'AUTH' : 'ACCOUNT',
                code === 'KT-CT-1139' ? 'Octopus says that API key is not valid.' : `Octopus could not look up your account (${code || errs[0]?.message || 'error'}).`,
                { action: code === 'KT-CT-1139' ? 'checkKey' : 'pickAccount' });
            err.graphqlCode = code;
            throw err;
        }
        if (status !== 200 || !json?.data) {
            throw new DataError('NETWORK', `Unexpected GraphQL answer from Octopus (${status}).`, { retryable: true, action: 'retry' });
        }
        return json.data;
    }

    /**
     * Account numbers visible to the API key (Kraken token → viewer.accounts).
     * @returns {Promise<string[]>}
     */
    async findAccountNumbers() {
        if (!this.apiKey) this.authHeader();
        const t = await this.graphql(
            'mutation obtainKrakenToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token } }',
            { input: { APIKey: this.apiKey } });
        const token = t?.obtainKrakenToken?.token;
        if (!token) throw new DataError('AUTH', 'Octopus did not issue a token for that key.', { action: 'checkKey' });
        const q = 'query { viewer { accounts { number } } }';
        let data;
        try {
            data = await this.graphql(q, {}, token);
        } catch (e) {
            // The header format for Kraken tokens wasn't verifiable; raw first, then 'JWT '.
            if (e?.graphqlCode !== 'KT-CT-1112') throw e;
            data = await this.graphql(q, {}, 'JWT ' + token);
        }
        return [...new Set((data?.viewer?.accounts ?? []).map(a => normaliseAccountNumber(a?.number)).filter(Boolean))];
    }

    /**
     * Half-hourly import (or export) readings for one meter.
     * @returns {Promise<Array<[number, number]>>} ascending, deduped by slot start
     */
    async consumption(mpan, serial, fromMs, toMs) {
        const qs = new URLSearchParams({
            period_from: toIso(fromMs), period_to: toIso(toMs), page_size: '25000', order_by: 'period',
        });
        const rows = await this.paged(
            `${API_BASE}/v1/electricity-meter-points/${encodeURIComponent(mpan)}/meters/${encodeURIComponent(serial)}/consumption/?${qs}`,
            { auth: true, notFound: null });
        const byMs = new Map();
        for (const r of rows) {
            let ms;
            try { ms = parseOctopusTime(r.interval_start); } catch { continue; }
            const kwh = Number(r.consumption);
            if (!Number.isFinite(ms) || !Number.isFinite(kwh)) continue;
            if (!byMs.has(ms)) byMs.set(ms, kwh);
        }
        return [...byMs.entries()].sort((a, b) => a[0] - b[0]);
    }

    async #charges(kind, product, tariff, fromMs, toMs) {
        // Published prices for a period that ended days ago don't change (value_exc_vat), so
        // re-analysing the same window skips ~12 requests per product.
        const closed = this.cache && Number.isFinite(toMs) && toMs < this.nowMs - 2 * DAY_MS;
        const key = `octopus:${kind}:${tariff}:${fromMs}:${toMs}`;
        if (closed) {
            try {
                const hit = await this.cache.get(key);
                if (Array.isArray(hit)) return hit;
            } catch { /* a cache miss is fine */ }
        }
        const qs = new URLSearchParams({ period_from: toIso(fromMs), period_to: toIso(toMs), page_size: '1500' });
        let rows;
        try {
            rows = await this.paged(
                `${API_BASE}/v1/products/${encodeURIComponent(product)}/electricity-tariffs/${encodeURIComponent(tariff)}/${kind}/?${qs}`,
                { notFound: null });
        } catch (e) {
            // 400 = this tariff has no such rate type (e.g. standard rates on a 2-rate tariff):
            // treat as "no rows" so the caller's gap rules apply instead of failing the load.
            if (e?.status === 400) return [];
            throw e;
        }
        const out = rows.map(r => ({
            fromMs: timeOr(r.valid_from, -Infinity),
            toMs: timeOr(r.valid_to, Infinity),
            exc: Number(r.value_exc_vat),
            paymentMethod: r.payment_method ?? null,
        })).filter(r => Number.isFinite(r.exc)).sort((a, b) => a.fromMs - b.fromMs);
        if (closed && out.length) {
            try { await this.cache.set(key, out, { ttlMs: 7 * DAY_MS }); } catch { /* best effort */ }
        }
        return out;
    }

    /**
     * Unit rates exc VAT, ascending by fromMs (the API returns newest-first).
     * @returns {Promise<Array<{ fromMs, toMs, exc, paymentMethod }>>}
     */
    unitRates(product, tariff, fromMs, toMs) {
        // Economy 7 (E-2R-…) tariffs publish day/night rates instead of standard ones, and the
        // night hours depend on the meter, so their history is priced at the day rate.
        const kind = /^E-2R-/i.test(tariff) ? 'day-unit-rates' : 'standard-unit-rates';
        return this.#charges(kind, product, tariff, fromMs, toMs);
    }

    /** Standing charges (p/day exc VAT), ascending. Same shape as unitRates. */
    standingCharges(product, tariff, fromMs, toMs) {
        return this.#charges('standing-charges', product, tariff, fromMs, toMs);
    }

    /**
     * Region letter for an MPAN from the public meter-point endpoint (handles IDNO MPANs,
     * whose prefixes don't map to a region).
     * @returns {Promise<string|null>}
     */
    async meterPointGsp(mpan) {
        const j = await this.getJson(`${API_BASE}/v1/electricity-meter-points/${encodeURIComponent(mpan)}/`, { notFound: null });
        const g = j?.gsp ? String(j.gsp).replace(/^_/, '').toUpperCase() : null;
        return g && REGIONS[g] ? g : null;
    }

    /**
     * Region letters for a postcode (public; usually exactly one).
     * @returns {Promise<string[]>}
     */
    async gspForPostcode(pc) {
        const qs = new URLSearchParams({ postcode: String(pc ?? '').replace(/\s+/g, '').toUpperCase() });
        const j = await this.getJson(`${API_BASE}/v1/industry/grid-supply-points/?${qs}`, { notFound: null });
        return [...new Set((j?.results ?? []).map(r => String(r.group_id ?? '').replace(/^_/, '').toUpperCase()).filter(g => REGIONS[g]))];
    }

    /**
     * Newest Agile IMPORT product code on sale. Direction is only reliable on the list
     * endpoint (the detail endpoint returns null), and the list ignores page_size.
     * @returns {Promise<string>}
     */
    async latestAgileProduct() {
        try {
            const qs = new URLSearchParams({ brand: 'OCTOPUS_ENERGY', is_variable: 'true' });
            const rows = await this.paged(`${API_BASE}/v1/products/?${qs}`, { notFound: null });
            const agile = rows
                .filter(p => /^AGILE-/.test(p.code ?? '') && (p.direction ? p.direction === 'IMPORT' : !/OUTGOING|EXPORT/.test(p.code)))
                .filter(p => !/^AGILE-(BB|FLEX)-/.test(p.code))
                .sort((a, b) => Date.parse(b.available_from ?? 0) - Date.parse(a.available_from ?? 0));
            return agile[0]?.code ?? CURRENT.agile;
        } catch (e) {
            if (e?.name === 'AbortError') throw e;
            return CURRENT.agile;
        }
    }
}

/** Indexes in [i0, i1) still NaN in `exc`. */
function missingIn(exc, i0, i1) {
    const idx = [];
    for (let i = i0; i < i1; i++) if (Number.isNaN(exc[i])) idx.push(i);
    return idx;
}

/** Fill NaN holes in [i0, i1) by carrying the nearest known value (forward, then back). */
function carryFill(arr, i0, i1) {
    let last = NaN;
    for (let i = i0; i < i1; i++) {
        if (Number.isNaN(arr[i])) { if (!Number.isNaN(last)) arr[i] = last; } else last = arr[i];
    }
    last = NaN;
    for (let i = i1 - 1; i >= i0; i--) {
        if (Number.isNaN(arr[i])) { if (!Number.isNaN(last)) arr[i] = last; } else last = arr[i];
    }
}

/** Standing-charge records clipped to [a0, a1), payment-method preference applied. */
function clipStanding(records, a0, a1) {
    const rank = pm => pm === 'DIRECT_DEBIT' ? 2 : pm == null ? 1 : 0;
    const best = Math.max(-1, ...records.map(r => rank(r.paymentMethod)));
    return records
        .filter(r => rank(r.paymentMethod) === best)
        .map(r => ({ fromMs: Math.max(r.fromMs, a0), toMs: Math.min(r.toMs, a1), pPerDayExc: r.exc }))
        .filter(r => r.toMs > r.fromMs);
}

/**
 * Stretch clipped standing-charge records over [a0, a1): a leading or trailing hole (days
 * before a product existed, or after a withdrawn one stopped publishing) takes the nearest
 * record's rate, so monthly bills never silently drop the standing charge.
 */
function coverStanding(records, a0, a1) {
    if (!records.length) return records;
    const out = records.slice().sort((x, y) => x.fromMs - y.fromMs);
    if (out[0].fromMs > a0) out.unshift({ fromMs: a0, toMs: out[0].fromMs, pPerDayExc: out[0].pPerDayExc });
    const last = out[out.length - 1];
    if (last.toMs < a1) out.push({ fromMs: last.toMs, toMs: a1, pPerDayExc: last.pPerDayExc });
    return out;
}

function addDaysIso(date, k) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
}

/**
 * Fill NaN slots in [i0, i1) of an Agile price array from other Agile versions, newest
 * first: AGILE-24-10-01 (identical to every 100p version), then the versions that were on
 * sale earlier, for half-hours before `product` existed or after it stopped publishing.
 * Every borrowed price is clamped to `product`'s own ex-VAT cap, so a 55p-cap customer is
 * never priced above 52.38p exc — the caps bind exactly in the 16:00–19:00 peak.
 * Requests are sequential and only made while gaps remain.
 *
 * @returns {Promise<Map<string, number>>} slots filled per source product
 */
async function fillAgileGaps(client, arr, i0, i1, { product, region }, start, n) {
    const used = new Map();
    const capExc = agileCapExc(product);
    for (const src of AGILE_LINEAGE) {
        if (src === product) continue;
        const gaps = missingIn(arr, i0, i1);
        if (!gaps.length) break;
        const g0 = start + gaps[0] * SLOT_MS, g1 = start + (gaps[gaps.length - 1] + 1) * SLOT_MS;
        const fb = expandRatesToSlots(await client.unitRates(src, `E-1R-${src}-${region}`, g0, g1), start, n);
        let filled = 0;
        for (const i of gaps) if (!Number.isNaN(fb[i])) { arr[i] = Math.min(fb[i], capExc); filled++; }
        if (filled) used.set(src, filled);
    }
    return used;
}

/** Notes and flags describing which Agile versions stood in for `product`. */
function describeAgileFill(product, used, notes, flags) {
    const cap = AGILE_CAPS_INC[product];
    for (const [src, count] of used) {
        const days = (count / 48).toFixed(1);
        if (cap === 100 && AGILE_CAPS_INC[src] === 100) {
            notes.push(src === CURRENT.agile
                ? `${product} stopped publishing prices; ${days} days were taken from ${CURRENT.agile}, which has the same 100p cap and identical prices.`
                : `${days} days from before ${product} was on sale were priced with ${src}, the Agile version (same 100p cap) on sale then.`);
        } else {
            if (!flags.includes('agile-version-approx')) flags.push('agile-version-approx');
            notes.push(`${days} days of ${product} were approximated from ${src}${Number.isFinite(agileCapExc(product)) ? ` capped at your version's ${cap}p` : ''}. Peak prices may differ slightly.`);
        }
    }
}

/**
 * Today's price pattern for a non-Agile tariff, repeated over every slot by LOCAL
 * half-hour. Flat tariffs (Flexible, fixed, Tracker's one rate a day) come back as
 * `kind: 'flat'`; time-of-use tariffs (Go, Cosy, Flux, Intelligent) come back as a series
 * that keeps today's cheap and peak windows — flattening them to "the rate right now"
 * would hide the overnight window a battery is bought to use.
 */
async function currentRatePattern(client, current, { start, n, nowMs, fallbackExc }) {
    const recent = await client.unitRates(current.product, current.code, nowMs - 7 * DAY_MS, nowMs + 2 * DAY_MS);
    const today = localParts(nowMs).date;
    let prof = null;
    for (const back of [0, 1, 2]) {
        const d0 = localMidnightUtc(addDaysIso(today, -back));
        const m = Math.round((localMidnightUtc(addDaysIso(today, 1 - back)) - d0) / SLOT_MS);
        const vals = expandRatesToSlots(recent, d0, m);
        if (vals.some(Number.isNaN)) continue;
        const hh = buildLocalIndex(d0, m).hh;
        prof = new Float64Array(48).fill(NaN);
        for (let k = 0; k < m; k++) if (Number.isNaN(prof[hh[k]])) prof[hh[k]] = vals[k];
        // A 46-slot spring-forward day has no 01:00–02:00: borrow the neighbouring half-hour.
        for (let h = 1; h < 48; h++) if (Number.isNaN(prof[h])) prof[h] = prof[h - 1];
        for (let h = 46; h >= 0; h--) if (Number.isNaN(prof[h])) prof[h] = prof[h + 1];
        break;
    }
    const base = { code: current.code, product: current.product };
    if (!prof) {
        const now = expandRatesToSlots(recent, Math.floor(nowMs / SLOT_MS) * SLOT_MS, 1)[0];
        const latest = recent.filter(r => r.paymentMethod === 'DIRECT_DEBIT' || r.paymentMethod == null).pop() ?? recent[recent.length - 1];
        return { kind: 'flat', ...base, flatExc: Number.isFinite(now) ? now : latest?.exc ?? fallbackExc };
    }
    if (new Set(Array.from(prof, v => Math.round(v * 1e6))).size === 1) return { kind: 'flat', ...base, flatExc: prof[0] };
    const local = buildLocalIndex(start, n);
    const rawExc = new Float64Array(n);
    for (let t = 0; t < n; t++) rawExc[t] = prof[local.hh[t]];
    return { kind: 'series', ...base, rawExc, pattern: 'time-of-use' };
}

/**
 * Price the window with the customer's own agreements: each agreement's tariff code is
 * fetched for exactly its validity, withdrawn Agile versions are back-filled from
 * AGILE-24-10-01 (identical prices for the 100p-cap versions; capped and flagged for the
 * others), half-hours from before an Agile version existed come from the version on sale
 * then, and slots no agreement covers borrow the nearest agreement (flagged).
 *
 * Requests are strictly sequential.
 *
 * @param {OctopusClient} client
 * @param {{ agreements: Array<{ code, product, region, isAgile, fromMs, toMs }>, region: string, start: number, n: number, nowMs?: number }} p
 * @returns {Promise<{ exc: Float64Array, tariffs: Array<{ code, product, fromMs, toMs, assumed?: boolean }>,
 *   standing: Array<{ fromMs, toMs, pPerDayExc }>, notes: string[], flags: string[],
 *   forward: { kind: 'series'|'flat', code: string, product: string, rawExc?: Float64Array, flatExc?: number, pattern?: string } }>}
 *   forward: the tariff the customer is on today applied to every slot — an Agile series
 *   (capped at its version's cap), today's time-of-use pattern by local half-hour, or a flat rate.
 */
export async function fetchAgreementPrices(client, { agreements, region, start, n, nowMs = Date.now() }) {
    const end = start + n * SLOT_MS;
    const exc = new Float64Array(n).fill(NaN);
    const tariffs = [], standing = [], notes = [], flags = [];
    const usable = agreements.filter(a => a.product && a.toMs > start && a.fromMs < end)
        .sort((a, b) => a.fromMs - b.fromMs);
    if (!usable.length && agreements.length) {
        // No agreement overlaps the window (e.g. usage predates the account): borrow the nearest.
        const nearest = agreements.slice().sort((a, b) =>
            Math.min(Math.abs(a.fromMs - end), Math.abs(a.toMs - start)) - Math.min(Math.abs(b.fromMs - end), Math.abs(b.toMs - start)))[0];
        if (nearest?.product) usable.push({ ...nearest, fromMs: start, toMs: end, assumed: true });
    }
    if (!usable.length) {
        throw new DataError('ACCOUNT', 'No electricity tariff found on this account.', { action: 'pickAccount' });
    }
    const slotOf = ms => Math.min(n, Math.max(0, Math.ceil((ms - start) / SLOT_MS)));

    for (let ai = 0; ai < usable.length; ai++) {
        const a = usable[ai];
        const a0 = Math.max(a.fromMs, start), a1 = Math.min(a.toMs, end);
        const i0 = slotOf(a0), i1 = slotOf(a1);
        if (i1 <= i0) continue;
        const rates = await client.unitRates(a.product, a.code, a0, a1);
        const arr = expandRatesToSlots(rates, start, n);
        for (let i = i0; i < i1; i++) exc[i] = arr[i];
        if (/^E-2R-/i.test(a.code)) {
            if (!flags.includes('economy7-day-rate')) flags.push('economy7-day-rate');
            notes.push(`${a.code} is an Economy 7 tariff; that period is priced at its day rate (night hours vary by meter).`);
        }
        if (a.isAgile && missingIn(exc, i0, i1).length) {
            describeAgileFill(a.product, await fillAgileGaps(client, exc, i0, i1, { product: a.product, region: a.region ?? region }, start, n), notes, flags);
        }
        const gaps = missingIn(exc, i0, i1);
        if (gaps.length) {
            carryFill(exc, i0, i1);
            if (gaps.length > 2) notes.push(`${gaps.length} half-hours had no published ${a.product} price; the nearest price was used.`);
        }
        standing.push(...coverStanding(clipStanding(await client.standingCharges(a.product, a.code, a0, a1), a0, a1), a0, a1));
        tariffs.push({ code: a.code, product: a.product, fromMs: a0, toMs: a1, ...(a.assumed ? { assumed: true } : {}) });
    }

    // Slots between/around agreements: borrow the nearest agreement's tariff (unit rates
    // AND standing charges — leaving the standing charge out would understate the bills).
    const uncovered = missingIn(exc, 0, n);
    if (uncovered.length) {
        let i = 0;
        while (i < uncovered.length) {
            let j = i;
            while (j + 1 < uncovered.length && uncovered[j + 1] === uncovered[j] + 1) j++;
            const s0 = uncovered[i], s1 = uncovered[j] + 1;
            const ms0 = start + s0 * SLOT_MS, ms1 = start + s1 * SLOT_MS;
            const near = usable.slice().sort((x, y) =>
                Math.min(Math.abs(x.toMs - ms0), Math.abs(x.fromMs - ms1)) - Math.min(Math.abs(y.toMs - ms0), Math.abs(y.fromMs - ms1)))[0];
            const arr = expandRatesToSlots(await client.unitRates(near.product, near.code, ms0, ms1), start, n);
            for (let k = s0; k < s1; k++) exc[k] = arr[k];
            if (near.isAgile && missingIn(exc, s0, s1).length) {
                describeAgileFill(near.product, await fillAgileGaps(client, exc, s0, s1, { product: near.product, region: near.region ?? region }, start, n), notes, flags);
            }
            carryFill(exc, s0, s1);
            standing.push(...coverStanding(clipStanding(await client.standingCharges(near.product, near.code, ms0, ms1), ms0, ms1), ms0, ms1));
            tariffs.push({ code: near.code, product: near.product, fromMs: ms0, toMs: ms1, assumed: true });
            notes.push(`No tariff agreement covered ${((s1 - s0) / 48).toFixed(1)} days from ${toIso(ms0).slice(0, 10)}; priced with ${near.code}.`);
            i = j + 1;
        }
        carryFill(exc, 0, n);
    }
    tariffs.sort((x, y) => x.fromMs - y.fromMs);
    standing.sort((x, y) => x.fromMs - y.fromMs);

    // Forward basis = the tariff the customer is on now, applied to every past slot.
    const current = agreements.filter(a => a.product && a.fromMs <= nowMs).sort((a, b) => b.fromMs - a.fromMs)[0] ?? usable[usable.length - 1];
    let forward;
    if (current.isAgile) {
        // Every slot already priced by this product (borrowed ranges included) → reuse it.
        let rawExc = exc;
        if (!tariffs.every(t => t.product === current.product)) {
            const reg = current.region ?? region;
            rawExc = expandRatesToSlots(await client.unitRates(current.product, current.code, start, end), start, n);
            if (missingIn(rawExc, 0, n).length) await fillAgileGaps(client, rawExc, 0, n, { product: current.product, region: reg }, start, n);
            const capExc = agileCapExc(current.product);
            for (let i = 0; i < n; i++) if (Number.isNaN(rawExc[i])) rawExc[i] = Math.min(exc[i], capExc);
        }
        forward = { kind: 'series', code: current.code, product: current.product, rawExc };
    } else {
        forward = await currentRatePattern(client, current, { start, n, nowMs, fallbackExc: exc[n - 1] });
        if (forward.pattern) notes.push(`${current.code} is a time-of-use tariff; future savings use today's rates for each half-hour of the day.`);
    }
    return { exc, tariffs, standing, notes, flags, forward };
}

/**
 * Standing charges only (p/day exc VAT) for the window: the customer's agreements, or the
 * Flexible tariff for the region when there are none. Used by the flat price basis, which
 * needs the standing charge but none of a year's half-hourly unit rates.
 *
 * @param {OctopusClient} client
 * @param {{ agreements?: Array<{ code, product, fromMs, toMs }>|null, region: string, start: number, n: number }} p
 * @returns {Promise<{ standing: Array<{ fromMs, toMs, pPerDayExc }>, code: string }>}
 */
export async function fetchStandingCharges(client, { agreements, region, start, n }) {
    const end = start + n * SLOT_MS;
    let usable = (agreements ?? []).filter(a => a.product && a.toMs > start && a.fromMs < end).sort((a, b) => a.fromMs - b.fromMs);
    if (!usable.length) usable = [{ code: `E-1R-${CURRENT.flexible}-${region}`, product: CURRENT.flexible, fromMs: start, toMs: end }];
    const standing = [];
    for (const a of usable) {
        const a0 = Math.max(a.fromMs, start), a1 = Math.min(a.toMs, end);
        standing.push(...coverStanding(clipStanding(await client.standingCharges(a.product, a.code, a0, a1), a0, a1), a0, a1));
    }
    return { standing: standing.sort((x, y) => x.fromMs - y.fromMs), code: usable[usable.length - 1].code };
}

/**
 * The region's Octopus Flexible (standard variable) prices for the window, as interval records —
 * the "same usage on Flexible" comparison in insights. One request for the unit rates and one for
 * the standing charges (a year is a handful of quarterly records); Direct Debit records are
 * preferred, and the first/last record is stretched over any hole at the window's edges.
 *
 * @param {OctopusClient} client
 * @param {{ region: string, start: number, n: number, product?: string }} p
 * @returns {Promise<{ product: string, code: string, unit: Array<{ fromMs, toMs, exc }>, standing: Array<{ fromMs, toMs, pPerDayExc }> }|null>}
 *   null when Octopus has no unit rates for the window
 */
export async function fetchFlexibleRates(client, { region, start, n, product = CURRENT.flexible }) {
    const end = start + n * SLOT_MS;
    const code = `E-1R-${product}-${region}`;
    // clipStanding/coverStanding do the payment-method choice, clipping and edge stretching for
    // any interval records; unit rates are carried through them under the same field name
    const fit = recs => coverStanding(clipStanding(recs, start, end), start, end);
    const unit = fit(await client.unitRates(product, code, start, end)).map(r => ({ fromMs: r.fromMs, toMs: r.toMs, exc: r.pPerDayExc }));
    if (!unit.length) return null;
    const standing = fit(await client.standingCharges(product, code, start, end));
    return { product, code, unit, standing };
}

/**
 * Price the window as if on one product throughout (the 'agile' and 'flexible' bases,
 * CSV and manual sources). Returns the same shape as fetchAgreementPrices.
 *
 * @param {OctopusClient} client
 * @param {{ product: string, region: string, start: number, n: number, nowMs?: number }} p
 */
export async function fetchProductPrices(client, { product, region, start, n, nowMs = Date.now() }) {
    const code = `E-1R-${product}-${region}`;
    const t = parseTariffCode(code);
    return fetchAgreementPrices(client, {
        agreements: [{ code, product, region, isAgile: t?.isAgile ?? false, fromMs: start, toMs: Infinity }],
        region, start, n, nowMs,
    });
}

/**
 * Export prices for the window: Agile Outgoing (floored at 0p, never VAT'd), Outgoing
 * Prime rows where they exist, Outgoing fixed rows. Slots without rows stay NaN and are
 * synthesised by dataset.js. Failures here never block a dataset — export only matters
 * to the few scenarios that can be paid for it.
 *
 * @param {OctopusClient} client
 * @param {{ region: string, start: number, n: number }} p
 * @returns {Promise<{ agile: Float64Array|null, prime: Float64Array, fixed: Float64Array, notes: string[] }>}
 */
export async function fetchExportPrices(client, { region, start, n }) {
    const end = start + n * SLOT_MS;
    const notes = [];
    const nanArr = () => new Float64Array(n).fill(NaN);
    const attempt = async (label, fn) => {
        try { return await fn(); } catch (e) {
            if (e?.name === 'AbortError') throw e;
            notes.push(`${label} prices could not be fetched (${e?.message ?? e}).`);
            return null;
        }
    };
    let agile = await attempt('Agile Outgoing', async () => {
        const p = CURRENT.agileOutgoing;
        return expandRatesToSlots(await client.unitRates(p, `E-1R-${p}-${region}`, start, end), start, n);
    });
    if (agile) {
        let missing = 0;
        for (let i = 0; i < n; i++) {
            if (Number.isNaN(agile[i])) missing++;
            else if (agile[i] < 0) agile[i] = 0; // Agile Outgoing floors at exactly 0p
        }
        if (missing === n) { agile = null; notes.push('No Agile Outgoing prices were published for this period.'); }
        else if (missing) { carryFill(agile, 0, n); notes.push(`${missing} Agile Outgoing half-hours were missing; the nearest price was used.`); }
    }
    let prime = nanArr();
    if (end > PRIME_FROM_MS) {
        const got = await attempt('Outgoing Prime', async () => {
            const p = CURRENT.outgoingPrime;
            return expandRatesToSlots(await client.unitRates(p, `E-1R-${p}-${region}`, Math.max(start, PRIME_FROM_MS), end), start, n);
        });
        if (got) prime = got;
    }
    const fixed = await attempt('Outgoing', async () => {
        const p = CURRENT.outgoingFixed;
        return expandRatesToSlots(await client.unitRates(p, `E-1R-${p}-${region}`, start, end), start, n);
    }) ?? nanArr();
    return { agile, prime, fixed, notes };
}

/**
 * Region letter by the verified order of trust: agreement tariff-code suffix → public
 * meter-point lookup → postcode lookup. Never from the MPAN prefix (IDNO networks).
 *
 * @param {OctopusClient} client
 * @param {{ agreements?: Array<{ region }>, mpan?: string|null, postcode?: string|null }} p
 * @returns {Promise<{ region: string|null, source: 'tariff'|'meter-point'|'postcode'|null }>}
 */
export async function resolveRegion(client, { agreements = [], mpan = null, postcode = null }) {
    const fromTariff = agreements.slice().reverse().find(a => a.region && REGIONS[a.region])?.region;
    if (fromTariff) return { region: fromTariff, source: 'tariff' };
    if (mpan) {
        try {
            const g = await client.meterPointGsp(mpan);
            if (g) return { region: g, source: 'meter-point' };
        } catch (e) { if (e?.name === 'AbortError') throw e; }
    }
    if (postcode) {
        try {
            const gs = await client.gspForPostcode(postcode);
            if (gs.length) return { region: gs[0], source: 'postcode' };
        } catch (e) { if (e?.name === 'AbortError') throw e; }
    }
    return { region: null, source: null };
}
