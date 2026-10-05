/*
 * a2-octopus-mock.js — an in-memory fake of the parts of api.octopus.energy (and
 * api.postcodes.io) that octopus.js / dataset.js talk to, reproducing the verified quirks:
 * rate endpoints page at 1500 and always answer newest-first with absolute `next` links,
 * overlap semantics on period_from/period_to, HTML 404 for malformed account numbers,
 * 401 JSON for bad keys, GraphQL errors as HTTP 200.
 */

export const API = 'https://api.octopus.energy';
export const SLOT = 1_800_000;

const iso = ms => new Date(ms).toISOString().replace('.000Z', 'Z');

/** JSON response helper. */
export function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** HTML response (what the router returns for malformed account numbers). */
export function html(status = 404) {
    return new Response('<!doctype html><html><body><h1>Not Found</h1></body></html>', { status, headers: { 'content-type': 'text/html' } });
}

/**
 * Serve rate rows like Octopus: overlap filter, newest-first, pages of `pageSize`.
 * @param {Array<{ value_exc_vat, valid_from, valid_to, payment_method }>} rows
 */
export function rateEndpoint(rows, { pageSize = 1500 } = {}) {
    return (url) => {
        const p = url.searchParams;
        const from = p.get('period_from') ? Date.parse(p.get('period_from')) : -Infinity;
        const to = p.get('period_to') ? Date.parse(p.get('period_to')) : Infinity;
        const sel = rows.filter(r => {
            const a = Date.parse(r.valid_from);
            const b = r.valid_to ? Date.parse(r.valid_to) : Infinity;
            return b > from && a < to;
        }).sort((x, y) => Date.parse(y.valid_from) - Date.parse(x.valid_from));
        const page = Number(p.get('page') ?? 1);
        const size = Math.min(pageSize, Number(p.get('page_size') ?? 100));
        const slice = sel.slice((page - 1) * size, page * size);
        let next = null;
        if (page * size < sel.length) {
            const u = new URL(url.href);
            u.searchParams.set('page', String(page + 1));
            next = u.href;
        }
        return json({ count: sel.length, next, previous: null, results: slice });
    };
}

/** Serve consumption rows (ascending) with page_size (capped at maxPage) and absolute next links. */
export function consumptionEndpoint(rows, { maxPage = 25000 } = {}) {
    return (url) => {
        const p = url.searchParams;
        const from = p.get('period_from') ? Date.parse(p.get('period_from')) : -Infinity;
        const to = p.get('period_to') ? Date.parse(p.get('period_to')) : Infinity;
        const sel = rows.filter(r => {
            const a = Date.parse(r.interval_start.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
            return a + SLOT > from && a < to;
        });
        const page = Number(p.get('page') ?? 1);
        const size = Math.min(maxPage, Number(p.get('page_size') ?? 100));
        const slice = sel.slice((page - 1) * size, page * size);
        let next = null;
        if (page * size < sel.length) {
            const u = new URL(url.href);
            u.searchParams.set('page', String(page + 1));
            next = u.href;
        }
        return json({ count: sel.length, next, previous: null, results: slice });
    };
}

/** Half-hourly rate rows over [fromMs, toMs) with value f(ms). */
export function halfHourly(fromMs, toMs, f, paymentMethod = null) {
    const out = [];
    for (let ms = fromMs; ms < toMs; ms += SLOT) {
        out.push({ value_exc_vat: f(ms), value_inc_vat: f(ms) * 1.05, valid_from: iso(ms), valid_to: iso(ms + SLOT), payment_method: paymentMethod });
    }
    return out;
}

/** One interval rate row. */
export function interval(fromIso, toIso, exc, paymentMethod = null) {
    return { value_exc_vat: exc, value_inc_vat: exc * 1.05, valid_from: fromIso, valid_to: toIso, payment_method: paymentMethod };
}

/**
 * Build a fetch mock from a route table. Keys are path prefixes on api.octopus.energy (or
 * full origins+paths for other hosts); values are (url: URL, init) => Response | Promise.
 * Records every call and the maximum concurrency.
 */
export function mockFetch(routes, { delayMs = 0 } = {}) {
    const calls = [];
    let inFlight = 0, maxInFlight = 0;
    const fetchImpl = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        calls.push({ url, init });
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
            await new Promise(r => setTimeout(r, delayMs));
            const key = Object.keys(routes)
                .filter(k => (k.startsWith('http') ? url.href.startsWith(k) : url.origin === API && url.pathname.startsWith(k)))
                .sort((a, b) => b.length - a.length)[0];
            if (!key) return json({ detail: 'Not found.' }, 404);
            return await routes[key](url, init);
        } finally {
            inFlight--;
        }
    };
    fetchImpl.calls = calls;
    Object.defineProperty(fetchImpl, 'maxInFlight', { get: () => maxInFlight });
    return fetchImpl;
}

/** Account body shaped like the documented example, with a meter exchange and an export MPAN. */
export function accountBody({ agreements, serials = ['19L0000001', '23J0000002'], number = 'A-1A2B3C4D' } = {}) {
    return {
        number,
        properties: [
            {
                id: 1, moved_in_at: '2015-01-01T00:00:00Z', moved_out_at: '2020-11-29T00:00:00Z',
                address_line_1: 'Old House', postcode: 'E1 6AN',
                electricity_meter_points: [{ mpan: '1200000000099', meters: [{ serial_number: 'OLD' }], agreements: [{ tariff_code: 'E-1R-VAR-19-04-12-C', valid_from: '2019-01-01T00:00:00Z', valid_to: '2020-11-29T00:00:00Z' }], is_export: false }],
            },
            {
                id: 2, moved_in_at: '2020-11-30T00:00:00Z', moved_out_at: null,
                address_line_1: '1 Example Street', town: 'LONDON', postcode: 'sw1a 1aa',
                electricity_meter_points: [
                    {
                        mpan: '1200000000001', profile_class: 1,
                        meters: serials.map(s => ({ serial_number: s, registers: [{ identifier: '1', rate: 'STANDARD', is_settlement_register: true }] })),
                        agreements: agreements ?? [
                            { tariff_code: 'E-1R-VAR-22-11-01-C', valid_from: '2023-04-01T00:00:00+01:00', valid_to: '2026-01-15T00:00:00Z' },
                            { tariff_code: 'E-1R-AGILE-24-10-01-C', valid_from: '2026-01-15T00:00:00Z', valid_to: null },
                        ],
                        is_export: false,
                    },
                    {
                        mpan: '1270000000002', profile_class: 8, meters: [{ serial_number: '23J0000002' }],
                        agreements: [{ tariff_code: 'E-1R-OUTGOING-VAR-24-10-26-C', valid_from: '2025-06-01T00:00:00+01:00', valid_to: null }],
                        is_export: true,
                    },
                ],
                gas_meter_points: [],
            },
        ],
    };
}

/** Consumption rows in the API's shape; offsets alternate between Z and +01:00 in BST like the docs. */
export function consumptionRows(fromMs, toMs, f, { asString = false, colonless = false } = {}) {
    const rows = [];
    for (let ms = fromMs; ms < toMs; ms += SLOT) {
        const v = f(ms);
        if (v === null) continue;
        rows.push({ consumption: asString ? String(v) : v, interval_start: localIso(ms, colonless), interval_end: localIso(ms + SLOT, colonless) });
    }
    return rows;
}

/** ISO with the UK offset of that instant (BST → '+01:00', or '+0100' when colonless). */
export function localIso(ms, colonless = false) {
    const y = new Date(ms).getUTCFullYear();
    const lastSun = (m) => { const d = new Date(Date.UTC(y, m + 1, 0)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime() + 3_600_000; };
    const bst = ms >= lastSun(2) && ms < lastSun(9);
    if (!bst) return iso(ms);
    const local = new Date(ms + 3_600_000).toISOString().slice(0, 19);
    return local + (colonless ? '+0100' : '+01:00');
}
