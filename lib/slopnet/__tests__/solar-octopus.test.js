import { describe, it, expect } from 'vitest';
import {
    OctopusClient, parseAccount, parseTariffCode, normaliseAccountNumber, expandRatesToSlots, mergeConsumption,
    fetchAgreementPrices, fetchProductPrices, fetchStandingCharges, fetchExportPrices, resolveRegion, REGIONS, CURRENT, AGILE_CAPS_INC,
    agileCapExc, AGILE_LINEAGE, fetchFlexibleRates,
} from '../../../projects/solar-calculator/js/octopus.js';
import { DataError } from '../../../projects/solar-calculator/js/dataset.js';
import { openCache } from '../../../projects/solar-calculator/js/cache.js';
import { localMidnightUtc } from '../../../projects/solar-calculator/js/time.js';
import {
    API, SLOT, json, html, rateEndpoint, consumptionEndpoint, halfHourly, interval, mockFetch, accountBody, consumptionRows,
} from './fixtures/solar/a2-octopus-mock.js';

const noSleep = () => Promise.resolve();
const KEY = 'sk_live_TESTKEY123';
const client = (routes, opts = {}) => {
    const f = mockFetch(routes, opts);
    return { c: new OctopusClient({ apiKey: KEY, fetch: f, sleep: opts.sleep ?? noSleep }), f };
};

describe('pure helpers', () => {
    it('normalises account numbers with the verified alphanumeric pattern', () => {
        expect(normaliseAccountNumber(' a-1a2b3c4d ')).toBe('A-1A2B3C4D');
        expect(normaliseAccountNumber('A-GHIJKLMN')).toBe('A-GHIJKLMN'); // not hex-only
        expect(normaliseAccountNumber('A-1234567')).toBeNull();
        expect(normaliseAccountNumber('B-12345678')).toBeNull();
        expect(normaliseAccountNumber('A-1234567_')).toBeNull();
        expect(normaliseAccountNumber(null)).toBeNull();
    });

    it('splits tariff codes and infers direction from the code', () => {
        expect(parseTariffCode('E-1R-AGILE-24-10-01-C')).toMatchObject({ product: 'AGILE-24-10-01', region: 'C', isAgile: true, isExport: false, registers: 1 });
        expect(parseTariffCode('E-1R-AGILE-OUTGOING-19-05-13-P')).toMatchObject({ product: 'AGILE-OUTGOING-19-05-13', region: 'P', isAgile: false, isExport: true });
        expect(parseTariffCode('E-2R-VAR-22-11-01-J')).toMatchObject({ product: 'VAR-22-11-01', region: 'J', registers: 2 });
        expect(parseTariffCode('E-1R-OUTGOING-PRIME-FIX-12M-26-06-23-C').isExport).toBe(true);
        expect(parseTariffCode('E-1R-AGILE-24-10-01-I')).toBeNull(); // no region I
        expect(parseTariffCode('nonsense')).toBeNull();
        expect(Object.keys(REGIONS)).toHaveLength(14);
        expect(CURRENT.agile).toBe('AGILE-24-10-01');
        expect(AGILE_CAPS_INC['AGILE-22-07-22']).toBe(55);
        // Ex-VAT caps as published on the rows (research/agile-versions-C-verified.json).
        expect(agileCapExc('AGILE-18-02-21')).toBe(33.33);
        expect(agileCapExc('AGILE-22-07-22')).toBe(52.38);
        expect(agileCapExc('AGILE-22-08-31')).toBe(74.28);
        expect(agileCapExc('AGILE-24-10-01')).toBe(Infinity);
        expect(AGILE_LINEAGE[0]).toBe(CURRENT.agile);
    });

    it('parses an account: current property, import vs export MPAN, mixed offsets, region', () => {
        const a = parseAccount(accountBody());
        expect(a.property.id).toBe(2); // moved_out_at null wins over the older property
        expect(a.importPoint.mpan).toBe('1200000000001');
        expect(a.exportPoint.mpan).toBe('1270000000002');
        expect(a.importPoint.serials).toEqual(['19L0000001', '23J0000002']);
        expect(a.agreements.map(x => x.product)).toEqual(['VAR-22-11-01', 'AGILE-24-10-01']);
        expect(a.agreements[0].fromMs).toBe(Date.parse('2023-03-31T23:00:00Z')); // '+01:00' honoured
        expect(a.agreements[1].toMs).toBe(Infinity);
        expect(a.region).toBe('C');
        expect(a.postcode).toBe('SW1A 1AA');
        expect(a.importChoices).toHaveLength(1);
    });

    it('expands interval records onto the slot grid with payment-method preference', () => {
        const start = Date.parse('2026-06-30T22:00:00Z');
        const rates = [
            { fromMs: Date.parse('2026-06-30T23:00:00Z'), toMs: Date.parse('2026-09-30T23:00:00Z'), exc: 26.4871, paymentMethod: 'NON_DIRECT_DEBIT' },
            { fromMs: Date.parse('2026-06-30T23:00:00Z'), toMs: Date.parse('2026-09-30T23:00:00Z'), exc: 25.0927, paymentMethod: 'DIRECT_DEBIT' },
            { fromMs: Date.parse('2026-09-30T23:00:00Z'), toMs: Infinity, exc: 28.0896, paymentMethod: 'NON_DIRECT_DEBIT' },
            { fromMs: Date.parse('2026-09-30T23:00:00Z'), toMs: Infinity, exc: 26.5956, paymentMethod: 'DIRECT_DEBIT' },
        ];
        const n = 48 * 100;
        const out = expandRatesToSlots(rates, start, n);
        expect(Number.isNaN(out[0]) && Number.isNaN(out[1])).toBe(true); // before the first record
        expect(out[2]).toBe(25.0927);
        const k = (Date.parse('2026-09-30T23:00:00Z') - start) / SLOT;
        expect(out[k - 1]).toBe(25.0927);
        expect(out[k]).toBe(26.5956); // open-ended DD record
        expect(out[n - 1]).toBe(26.5956);
        // null beats NON_DIRECT_DEBIT; Prime-style long records cover many slots.
        const prime = expandRatesToSlots([
            { fromMs: start, toMs: start + 6 * SLOT, exc: 16, paymentMethod: null },
            { fromMs: start, toMs: start + 6 * SLOT, exc: 99, paymentMethod: 'NON_DIRECT_DEBIT' },
            { fromMs: start + 6 * SLOT, toMs: start + 48 * SLOT, exc: 9, paymentMethod: null },
        ], start, 48);
        expect(Array.from(prime.slice(0, 7))).toEqual([16, 16, 16, 16, 16, 16, 9]);
    });

    it('merges a meter exchange: active meter wins, zeros yield, never sums', () => {
        const start = Date.parse('2026-01-01T00:00:00Z');
        const oldM = [], newM = [];
        for (let k = 0; k < 10; k++) oldM.push([start + k * SLOT, k < 6 ? 0.25 : 0]); // stale zeros after removal
        for (let k = 4; k < 12; k++) newM.push([start + k * SLOT, k === 4 ? 0 : 0.3]); // uncommissioned first reading
        const out = mergeConsumption([oldM, newM], start, 12);
        expect(Array.from(out)).toEqual([0.25, 0.25, 0.25, 0.25, 0.25, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
        // Order of the inputs doesn't matter; the latest-reading serial is the active one.
        expect(Array.from(mergeConsumption([newM, oldM], start, 12))).toEqual(Array.from(out));
        const gaps = mergeConsumption([[[start + SLOT, 0.1]]], start, 3);
        expect(Number.isNaN(gaps[0]) && gaps[1] === 0.1 && Number.isNaN(gaps[2])).toBe(true);
    });
});

describe('OctopusClient requests', () => {
    it('sends Basic auth (key as user, empty password) and never credentials:include', async () => {
        const { c, f } = client({ '/v1/accounts/': () => json(accountBody()) });
        await c.account('a-1a2b3c4d');
        const { url, init } = f.calls[0];
        expect(url.pathname).toBe('/v1/accounts/A-1A2B3C4D/');
        expect(init.headers.Authorization).toBe('Basic ' + Buffer.from(KEY + ':').toString('base64'));
        expect(init.credentials).not.toBe('include');
    });

    it('rejects malformed account numbers locally and maps the HTML 404 to ACCOUNT', async () => {
        const { c, f } = client({ '/v1/accounts/': () => html(404) });
        await expect(c.account('A-123')).rejects.toMatchObject({ code: 'ACCOUNT' });
        expect(f.calls).toHaveLength(0);
        const err = await c.account('A-ZZZZZZZZ').catch(e => e);
        expect(err).toBeInstanceOf(DataError);
        expect(err.code).toBe('ACCOUNT');
        expect(err.action).toBe('pickAccount');
    });

    it('maps 401 to AUTH with a checkKey action', async () => {
        const { c } = client({ '/v1/accounts/': () => json({ detail: 'Invalid API key.' }, 401) });
        const err = await c.account('A-1A2B3C4D').catch(e => e);
        expect(err.code).toBe('AUTH');
        expect(err.action).toBe('checkKey');
        expect(err.message).toMatch(/not valid/);
        expect(err.toJSON()).toMatchObject({ name: 'DataError', code: 'AUTH', retryable: false, action: 'checkKey' });
    });

    it('backs off on 429 (honouring Retry-After) and 5xx, then gives up with RATE_LIMIT / NETWORK', async () => {
        let n = 0;
        const sleeps = [];
        const sleep = ms => { sleeps.push(ms); return Promise.resolve(); };
        const { c } = client({ '/v1/electricity-meter-points/': () => (++n < 3 ? json({ detail: 'slow down' }, 429, { 'retry-after': '2' }) : json({ gsp: '_C' })) }, { sleep });
        expect(await c.meterPointGsp('1200000000001')).toBe('C');
        expect(sleeps).toEqual([2000, 2000]);

        const always = client({ '/v1/electricity-meter-points/': () => json({}, 429) });
        await expect(always.c.meterPointGsp('1')).rejects.toMatchObject({ code: 'RATE_LIMIT', retryable: true, action: 'retry' });
        expect(always.f.calls).toHaveLength(5);

        const down = client({ '/v1/electricity-meter-points/': () => json({}, 503) });
        await expect(down.c.meterPointGsp('1')).rejects.toMatchObject({ code: 'NETWORK', retryable: true });

        let flaky = 0;
        const net = new OctopusClient({ apiKey: KEY, sleep: noSleep, fetch: async () => { if (++flaky < 2) throw new TypeError('Failed to fetch'); return json({ gsp: '_A' }); } });
        expect(await net.meterPointGsp('1')).toBe('A');
        const dead = new OctopusClient({ apiKey: KEY, sleep: noSleep, fetch: async () => { throw new TypeError('Failed to fetch'); } });
        await expect(dead.meterPointGsp('1')).rejects.toMatchObject({ code: 'NETWORK' });
    });

    it('propagates aborts unchanged', async () => {
        const ac = new AbortController();
        ac.abort();
        const c = new OctopusClient({ apiKey: KEY, fetch: async () => json({}), signal: ac.signal });
        await expect(c.meterPointGsp('1')).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('pages consumption with page_size=25000/order_by=period, Number()s strings, normalises +0100 and dedupes', async () => {
        const from = Date.parse('2026-03-28T00:00:00Z'), to = Date.parse('2026-03-31T00:00:00Z');
        const rows = consumptionRows(from, to, ms => ((ms / SLOT) % 7) / 10, { asString: true, colonless: true });
        // Overlap semantics + duplicated record at a page boundary.
        rows.splice(100, 0, { ...rows[100] });
        const { c, f } = client({ '/v1/electricity-meter-points/': consumptionEndpoint(rows, { maxPage: 50 }) });
        const out = await c.consumption('1200000000001', 'Z18N/123', from, to);
        expect(out).toHaveLength(144);
        expect(out[0][0]).toBe(from);
        expect(out.every((r, i) => i === 0 || r[0] - out[i - 1][0] === SLOT)).toBe(true);
        expect(typeof out[5][1]).toBe('number');
        expect(out[5][1]).toBeCloseTo(((from / SLOT + 5) % 7) / 10, 12);
        const first = f.calls[0].url;
        expect(first.pathname).toBe('/v1/electricity-meter-points/1200000000001/meters/Z18N%2F123/consumption/');
        expect(first.searchParams.get('page_size')).toBe('25000');
        expect(first.searchParams.get('order_by')).toBe('period');
        expect(first.searchParams.get('period_from')).toBe('2026-03-28T00:00:00.000Z');
        expect(f.calls.length).toBe(3); // 145 rows / 50 per page, following absolute next links
        expect(f.calls.every(cl => cl.init.headers.Authorization)).toBe(true);
    });

    it('fetches unit rates page by page (1500, newest-first) one request at a time and sorts ascending', async () => {
        const from = Date.parse('2025-09-30T23:00:00Z'), to = Date.parse('2025-11-30T00:00:00Z');
        const rows = halfHourly(from, to, ms => (ms / SLOT) % 40);
        const { c, f } = client({ '/v1/products/': rateEndpoint(rows) }, { delayMs: 1 });
        const out = await c.unitRates('AGILE-24-10-01', 'E-1R-AGILE-24-10-01-C', from, to);
        expect(out).toHaveLength(rows.length);
        expect(out.every((r, i) => i === 0 || r.fromMs > out[i - 1].fromMs)).toBe(true);
        expect(f.calls).toHaveLength(Math.ceil(rows.length / 1500));
        expect(f.maxInFlight).toBe(1);
        expect(f.calls[0].url.searchParams.get('page_size')).toBe('1500');
        expect(f.calls[0].init.headers.Authorization).toBeUndefined(); // public endpoint, key not sent
    });

    it('encodes offsets with URLSearchParams (a raw + would be read as a space)', async () => {
        const { c, f } = client({ '/v1/products/': rateEndpoint([]) });
        await c.unitRates('AGILE-24-10-01', 'E-1R-AGILE-24-10-01-C', Date.parse('2026-01-01T00:00:00Z'), Date.parse('2026-01-02T00:00:00Z'));
        expect(f.calls[0].url.href).not.toMatch(/\+/);
    });

    it('refuses to send the key to a next link on another host', async () => {
        const { c } = client({ '/v1/electricity-meter-points/': () => json({ count: 2, next: 'https://evil.example/steal?page=2', results: [] }) });
        await expect(c.consumption('1', '2', 0, SLOT)).rejects.toMatchObject({ code: 'NETWORK' });
    });

    it('looks up regions: meter-point gsp and postcode GSP', async () => {
        const { c, f } = client({
            '/v1/electricity-meter-points/': url => (url.pathname.includes('999') ? json({ detail: 'Not found.' }, 404) : json({ gsp: '_H', mpan: '2000024512368' })),
            '/v1/industry/grid-supply-points/': url => json({ count: 1, next: null, results: url.searchParams.get('postcode') === 'SW1A1AA' ? [{ group_id: '_C' }] : [] }),
        });
        expect(await c.meterPointGsp('2000024512368')).toBe('H');
        expect(await c.meterPointGsp('999')).toBeNull();
        expect(await c.gspForPostcode('sw1a 1aa')).toEqual(['C']);
        expect(await c.gspForPostcode('ZZ99')).toEqual([]);
        expect(f.calls.every(cl => !cl.init.headers.Authorization)).toBe(true);
        const r = await resolveRegion(c, { agreements: [{ region: null }], mpan: '2000024512368' });
        expect(r).toEqual({ region: 'H', source: 'meter-point' });
        expect(await resolveRegion(c, { agreements: [{ region: 'P' }] })).toEqual({ region: 'P', source: 'tariff' });
        expect(await resolveRegion(c, { mpan: '999', postcode: 'SW1A 1AA' })).toEqual({ region: 'C', source: 'postcode' });
    });

    it('discovers account numbers over GraphQL and maps errors-in-200 to AUTH', async () => {
        const gql = async (url, init) => {
            const body = JSON.parse(init.body);
            if (body.query.includes('obtainKrakenToken')) {
                return body.variables.input.APIKey === KEY
                    ? json({ data: { obtainKrakenToken: { token: 'tok123' } } })
                    : json({ errors: [{ message: 'Invalid API key.', extensions: { errorCode: 'KT-CT-1139' } }], data: { obtainKrakenToken: null } });
            }
            if (init.headers.Authorization === 'tok123') {
                return json({ data: { viewer: { accounts: [{ number: 'A-1A2B3C4D' }, { number: 'a-9z9z9z9z' }] } } });
            }
            return json({ errors: [{ message: 'Unauthenticated', extensions: { errorCode: 'KT-CT-1112' } }] });
        };
        const { c } = client({ '/v1/graphql/': gql });
        expect(await c.findAccountNumbers()).toEqual(['A-1A2B3C4D', 'A-9Z9Z9Z9Z']);
        const bad = new OctopusClient({ apiKey: 'sk_live_wrong', fetch: mockFetch({ '/v1/graphql/': gql }), sleep: noSleep });
        await expect(bad.findAccountNumbers()).rejects.toMatchObject({ code: 'AUTH', action: 'checkKey' });

        // Token accepted only with the 'JWT ' prefix → retried once with it.
        const jwtOnly = async (url, init) => {
            const body = JSON.parse(init.body);
            if (body.query.includes('obtainKrakenToken')) return json({ data: { obtainKrakenToken: { token: 't' } } });
            return init.headers.Authorization === 'JWT t'
                ? json({ data: { viewer: { accounts: [{ number: 'A-00000001' }] } } })
                : json({ errors: [{ extensions: { errorCode: 'KT-CT-1112' } }] });
        };
        const j = new OctopusClient({ apiKey: KEY, fetch: mockFetch({ '/v1/graphql/': jwtOnly }), sleep: noSleep });
        expect(await j.findAccountNumbers()).toEqual(['A-00000001']);
    });
});

describe('pricing agreements', () => {
    const start = Date.parse('2025-12-31T00:00:00Z');
    const n = 48 * 40; // to 2026-02-09
    const end = start + n * SLOT;
    const agileF = ms => 10 + ((ms / SLOT) % 48) / 2; // 10 .. 33.5 exc
    const varRows = [
        interval('2025-09-30T23:00:00Z', '2026-01-10T00:00:00Z', 24.0, 'DIRECT_DEBIT'),
        interval('2025-09-30T23:00:00Z', '2026-01-10T00:00:00Z', 25.5, 'NON_DIRECT_DEBIT'),
        interval('2026-01-10T00:00:00Z', null, 25.0, 'DIRECT_DEBIT'),
        interval('2026-01-10T00:00:00Z', null, 26.5, 'NON_DIRECT_DEBIT'),
    ];
    const routes = (agileRows) => ({
        '/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standard-unit-rates/': rateEndpoint(varRows),
        '/v1/products/VAR-22-11-01/electricity-tariffs/E-1R-VAR-22-11-01-C/standing-charges/': rateEndpoint([
            interval('2025-01-01T00:00:00Z', null, 40.0, 'DIRECT_DEBIT'), interval('2025-01-01T00:00:00Z', null, 42.0, 'NON_DIRECT_DEBIT')]),
        '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/': rateEndpoint(agileRows),
        '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standing-charges/': rateEndpoint([interval('2024-09-30T23:00:00Z', null, 37.6525)]),
        '/v1/products/AGILE-22-07-22/electricity-tariffs/E-1R-AGILE-22-07-22-C/standard-unit-rates/': rateEndpoint(
            halfHourly(start, Date.parse('2026-01-20T00:00:00Z'), ms => Math.min(agileF(ms), 52.38))), // withdrawn on 20 Jan
        '/v1/products/AGILE-22-07-22/electricity-tariffs/E-1R-AGILE-22-07-22-C/standing-charges/': rateEndpoint([interval('2024-01-01T00:00:00Z', '2026-03-31T23:00:00Z', 30.36)]),
        '/v1/products/AGILE-23-12-06/electricity-tariffs/E-1R-AGILE-23-12-06-C/standard-unit-rates/': rateEndpoint(
            halfHourly(start, Date.parse('2026-01-20T00:00:00Z'), agileF)),
        '/v1/products/AGILE-23-12-06/electricity-tariffs/E-1R-AGILE-23-12-06-C/standing-charges/': rateEndpoint([interval('2024-01-01T00:00:00Z', null, 34.79)]),
    });
    const agileRows = halfHourly(start - 48 * SLOT, end + 48 * SLOT, agileF);
    const agr = (code, from, to) => {
        const t = parseTariffCode(code);
        return { code, product: t.product, region: t.region, isAgile: t.isAgile, fromMs: Date.parse(from), toMs: to ? Date.parse(to) : Infinity };
    };

    it('prices each agreement with its own tariff for exactly its validity (two products)', async () => {
        const { c, f } = client(routes(agileRows), { delayMs: 1 });
        const agreements = [agr('E-1R-VAR-22-11-01-C', '2023-03-31T23:00:00Z', '2026-01-15T00:00:00Z'), agr('E-1R-AGILE-24-10-01-C', '2026-01-15T00:00:00Z', null)];
        const p = await fetchAgreementPrices(c, { agreements, region: 'C', start, n, nowMs: Date.parse('2026-10-05T12:00:00Z') });
        const k15 = (Date.parse('2026-01-15T00:00:00Z') - start) / SLOT;
        const k10 = (Date.parse('2026-01-10T00:00:00Z') - start) / SLOT;
        expect(p.exc[0]).toBe(24.0); // DIRECT_DEBIT, not NON_DIRECT_DEBIT
        expect(p.exc[k10]).toBe(25.0);
        expect(p.exc[k15 - 1]).toBe(25.0);
        expect(p.exc[k15]).toBe(agileF(start + k15 * SLOT));
        expect(p.exc.some(Number.isNaN)).toBe(false);
        expect(p.tariffs.map(t => [t.product, t.fromMs, t.toMs])).toEqual([
            ['VAR-22-11-01', start, start + k15 * SLOT], ['AGILE-24-10-01', start + k15 * SLOT, end]]);
        expect(p.standing).toEqual([
            { fromMs: start, toMs: start + k15 * SLOT, pPerDayExc: 40.0 },
            { fromMs: start + k15 * SLOT, toMs: end, pPerDayExc: 37.6525 }]);
        // Forward basis = today's Agile applied to every slot, including the Flexible ones.
        expect(p.forward.kind).toBe('series');
        expect(p.forward.product).toBe('AGILE-24-10-01');
        expect(p.forward.rawExc[0]).toBe(agileF(start));
        expect(f.maxInFlight).toBe(1);
    });

    it('fills a withdrawn 100p-cap Agile version from AGILE-24-10-01 silently and caps + flags the others', async () => {
        const { c } = client(routes(agileRows));
        const now = Date.parse('2026-10-05T12:00:00Z');
        const same = await fetchAgreementPrices(c, { agreements: [agr('E-1R-AGILE-23-12-06-C', '2025-01-01T00:00:00Z', null)], region: 'C', start, n, nowMs: now });
        const kW = (Date.parse('2026-01-20T00:00:00Z') - start) / SLOT;
        expect(same.exc[kW + 3]).toBe(agileF(start + (kW + 3) * SLOT));
        expect(same.flags).toEqual([]);
        expect(same.notes.join(' ')).toMatch(/same 100p cap/);
        expect(same.standing[0].pPerDayExc).toBe(34.79); // its own standing charge, not 24-10-01's

        // 55p version, with a fallback price above its cap.
        const spiky = agileRows.map(r => (r.valid_from === '2026-01-25T17:00:00Z' ? { ...r, value_exc_vat: 80 } : r));
        const { c: c2 } = client(routes(spiky));
        const capped = await fetchAgreementPrices(c2, { agreements: [agr('E-1R-AGILE-22-07-22-C', '2025-01-01T00:00:00Z', null)], region: 'C', start, n, nowMs: now });
        const kSpike = (Date.parse('2026-01-25T17:00:00Z') - start) / SLOT;
        expect(capped.exc[kSpike]).toBe(52.38);
        expect(capped.flags).toContain('agile-version-approx');
        expect(capped.notes.join(' ')).toMatch(/approximated/);
        expect(capped.exc.some(Number.isNaN)).toBe(false);
    });

    it('prices Economy 7 history at its day rate (standard rates 400 on 2-rate tariffs)', async () => {
        const { c, f } = client({
            ...routes(agileRows),
            '/v1/products/VAR-22-11-01/electricity-tariffs/E-2R-VAR-22-11-01-C/day-unit-rates/': rateEndpoint([interval('2025-01-01T00:00:00Z', null, 30.9, 'DIRECT_DEBIT')]),
            '/v1/products/VAR-22-11-01/electricity-tariffs/E-2R-VAR-22-11-01-C/standard-unit-rates/': () => json({ detail: 'bad' }, 400),
            '/v1/products/VAR-22-11-01/electricity-tariffs/E-2R-VAR-22-11-01-C/standing-charges/': rateEndpoint([interval('2025-01-01T00:00:00Z', null, 45, 'DIRECT_DEBIT')]),
            '/v1/products/BAD-1/': () => json({ period_from: ['Enter a valid date/time.'] }, 400),
        });
        const p = await fetchAgreementPrices(c, {
            agreements: [agr('E-2R-VAR-22-11-01-C', '2024-01-01T00:00:00Z', '2026-01-15T00:00:00Z'), agr('E-1R-AGILE-24-10-01-C', '2026-01-15T00:00:00Z', null)],
            region: 'C', start, n, nowMs: Date.parse('2026-10-05T12:00:00Z'),
        });
        expect(p.exc[0]).toBe(30.9);
        expect(p.flags).toContain('economy7-day-rate');
        expect(f.calls.some(cl => cl.url.pathname.endsWith('/day-unit-rates/'))).toBe(true);
        // A 400 on a rate endpoint degrades to "no rows", never a failed load.
        expect(await c.unitRates('BAD-1', 'E-1R-BAD-1-C', start, end)).toEqual([]);
    });

    it('caps the forward series at the current version\'s cap (55p → 52.38p exc) when history is another tariff', async () => {
        const spiky = halfHourly(start - 48 * SLOT, end + 48 * SLOT, ms => (new Date(ms).getUTCHours() === 17 ? 80 : agileF(ms)));
        const { c } = client(routes(spiky));
        const p = await fetchAgreementPrices(c, {
            agreements: [agr('E-1R-VAR-22-11-01-C', '2023-03-31T23:00:00Z', '2026-01-15T00:00:00Z'), agr('E-1R-AGILE-22-07-22-C', '2026-01-15T00:00:00Z', null)],
            region: 'C', start, n, nowMs: Date.parse('2026-10-05T12:00:00Z'),
        });
        expect(p.forward).toMatchObject({ kind: 'series', product: 'AGILE-22-07-22' });
        expect(Math.max(...p.forward.rawExc)).toBe(52.38); // the withdrawn version's tail came from 24-10-01's 80p rows
        expect(Math.max(...p.exc)).toBe(52.38);
        expect(p.forward.rawExc.some(Number.isNaN)).toBe(false);
    });

    it('fills half-hours from before a product existed with the Agile version on sale then (no flat carry)', async () => {
        const s = Date.parse('2024-08-01T00:00:00Z'), m = 48 * 120; // to 2024-11-29: straddles AGILE-24-10-01's launch
        const launch = Date.parse('2024-09-30T23:00:00Z');
        const f = (ms) => 12 + ((ms / SLOT) % 48) / 2;
        const { c, f: calls } = client({
            '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/': rateEndpoint(halfHourly(launch, s + (m + 48) * SLOT, f)),
            '/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standing-charges/': rateEndpoint([interval('2024-09-30T23:00:00Z', null, 37.6525)]),
            '/v1/products/AGILE-24-04-03/electricity-tariffs/E-1R-AGILE-24-04-03-C/standard-unit-rates/': rateEndpoint(halfHourly(Date.parse('2024-04-02T23:00:00Z'), s + (m + 48) * SLOT, ms => f(ms) + 0.5)),
        });
        const p = await fetchProductPrices(c, { product: 'AGILE-24-10-01', region: 'C', start: s, n: m, nowMs: Date.parse('2026-10-05T12:00:00Z') });
        const k = (launch - s) / SLOT;
        expect(p.exc[0]).toBe(f(s) + 0.5);
        expect(p.exc[k - 1]).toBe(f(launch - SLOT) + 0.5);
        expect(p.exc[k]).toBe(f(launch));
        expect(new Set(Array.from(p.exc.slice(0, k))).size).toBeGreaterThan(40); // a real daily shape, not one carried price
        expect(p.notes.join(' ')).toMatch(/AGILE-24-04-03/);
        // Standing charge stretched over the days before the product published one.
        expect(p.standing[0]).toEqual({ fromMs: s, toMs: launch, pPerDayExc: 37.6525 });
        expect(p.standing.reduce((a, r) => a + r.toMs - r.fromMs, 0)).toBe(m * SLOT);
        // Only the gap range was requested from the older version.
        const older = calls.calls.filter(cl => cl.url.pathname.includes('AGILE-24-04-03'));
        expect(older.length).toBeGreaterThan(0);
        expect(Date.parse(older[0].url.searchParams.get('period_to'))).toBe(launch);
    });

    it('charges standing for days no agreement covers (borrowed from the nearest agreement)', async () => {
        const { c } = client(routes(agileRows));
        const p = await fetchAgreementPrices(c, { agreements: [agr('E-1R-AGILE-24-10-01-C', '2026-01-20T00:00:00Z', null)], region: 'C', start, n, nowMs: Date.parse('2026-10-05T12:00:00Z') });
        expect(p.tariffs[0]).toMatchObject({ product: 'AGILE-24-10-01', fromMs: start, assumed: true });
        expect(p.standing.reduce((a, r) => a + r.toMs - r.fromMs, 0)).toBe(n * SLOT);
        expect(p.forward.rawExc).toBe(p.exc); // every slot is already that product's price: no re-fetch
    });

    it('keeps a time-of-use tariff\'s daily pattern (by local clock) as the forward basis', async () => {
        // Octopus Go-style: 7p 00:30–05:30 local, 28p otherwise, published as two records a day.
        const rows = [];
        for (let d = Date.parse('2025-12-01T12:00:00Z'); d < Date.parse('2026-10-08T00:00:00Z'); d += 86_400_000) {
            const date = new Date(d).toISOString().slice(0, 10);
            const next = new Date(d + 86_400_000).toISOString().slice(0, 10);
            const a = localMidnightUtc(date) + 1_800_000, b = localMidnightUtc(date) + 5.5 * 3_600_000;
            rows.push(interval(new Date(a).toISOString(), new Date(b).toISOString(), 7, 'DIRECT_DEBIT'));
            rows.push(interval(new Date(b).toISOString(), new Date(localMidnightUtc(next) + 1_800_000).toISOString(), 28, 'DIRECT_DEBIT'));
        }
        const { c } = client({
            '/v1/products/GO-VAR-22-10-14/electricity-tariffs/E-1R-GO-VAR-22-10-14-C/standard-unit-rates/': rateEndpoint(rows),
            '/v1/products/GO-VAR-22-10-14/electricity-tariffs/E-1R-GO-VAR-22-10-14-C/standing-charges/': rateEndpoint([interval('2025-01-01T00:00:00Z', null, 45, 'DIRECT_DEBIT')]),
        });
        const p = await fetchAgreementPrices(c, { agreements: [agr('E-1R-GO-VAR-22-10-14-C', '2025-01-01T00:00:00Z', null)], region: 'C', start, n, nowMs: Date.parse('2026-10-05T12:00:00Z') });
        expect(p.forward).toMatchObject({ kind: 'series', product: 'GO-VAR-22-10-14', pattern: 'time-of-use' });
        // Winter window: 01:00 local = 01:00Z is cheap, 12:00Z dear; same local clock as today's (BST) pattern.
        const at = iso => (Date.parse(iso) - start) / SLOT;
        expect(p.forward.rawExc[at('2026-01-05T01:00:00Z')]).toBe(7);
        expect(p.forward.rawExc[at('2026-01-05T00:00:00Z')]).toBe(28);
        expect(p.forward.rawExc[at('2026-01-05T05:30:00Z')]).toBe(28);
        expect(p.forward.rawExc[at('2026-01-05T12:00:00Z')]).toBe(28);
        expect(new Set(p.forward.rawExc)).toEqual(new Set([7, 28]));
        expect(p.notes.join(' ')).toMatch(/time-of-use/);
    });

    it('fetchStandingCharges asks for standing charges only', async () => {
        const { c, f } = client(routes(agileRows));
        const s = await fetchStandingCharges(c, { agreements: [agr('E-1R-VAR-22-11-01-C', '2023-03-31T23:00:00Z', null)], region: 'C', start, n });
        expect(s.standing).toEqual([{ fromMs: start, toMs: end, pPerDayExc: 40.0 }]);
        expect(f.calls.every(cl => cl.url.pathname.endsWith('/standing-charges/'))).toBe(true);
        const none = await fetchStandingCharges(c, { agreements: [], region: 'C', start, n });
        expect(none.code).toBe('E-1R-VAR-22-11-01-C');
    });

    it('uses the current flat rate as the forward basis when today\'s tariff is not Agile', async () => {
        const { c } = client(routes(agileRows));
        const p = await fetchAgreementPrices(c, { agreements: [agr('E-1R-VAR-22-11-01-C', '2023-03-31T23:00:00Z', null)], region: 'C', start, n, nowMs: Date.parse('2026-10-05T12:00:00Z') });
        expect(p.forward).toMatchObject({ kind: 'flat', product: 'VAR-22-11-01', flatExc: 25.0 });
    });

    it('fetches export prices: Agile Outgoing floored at 0, Prime/fixed left for synthesis where absent', async () => {
        const s = Date.parse('2026-06-20T23:00:00Z');
        const m = 48 * 4;
        const { c } = client({
            '/v1/products/AGILE-OUTGOING-19-05-13/': rateEndpoint(halfHourly(s, s + m * SLOT, ms => ((ms / SLOT) % 10) - 2)),
            '/v1/products/OUTGOING-PRIME-FIX-12M-26-06-23/': rateEndpoint([
                interval('2026-06-22T23:00:00Z', '2026-06-23T15:00:00Z', 9), interval('2026-06-23T15:00:00Z', '2026-06-23T18:00:00Z', 16),
                interval('2026-06-23T18:00:00Z', '2026-06-24T15:00:00Z', 9)]),
            '/v1/products/OUTGOING-VAR-24-10-26/': rateEndpoint([interval('2026-03-01T00:00:00Z', null, 12.0)]),
        });
        const e = await fetchExportPrices(c, { region: 'C', start: s, n: m });
        expect(Math.min(...e.agile)).toBe(0);
        expect(Number.isNaN(e.prime[0])).toBe(true); // before Prime existed
        const k = (Date.parse('2026-06-23T15:30:00Z') - s) / SLOT;
        expect(e.prime[k]).toBe(16);
        expect(e.fixed[0]).toBe(12);

        const broken = client({ '/v1/products/': () => json({}, 500) });
        const e2 = await fetchExportPrices(broken.c, { region: 'C', start: s, n: m });
        expect(e2.agile).toBeNull();
        expect(e2.notes.length).toBeGreaterThan(0);
    });
});

describe('caching', () => {
    it('openCache falls back to memory, honours TTLs and never throws', async () => {
        const c = openCache('t1', { indexedDB: null });
        expect(await c.kind()).toBe('memory');
        expect(await c.get('missing')).toBeUndefined();
        await c.set('a', { x: Float64Array.of(1, 2) });
        expect((await c.get('a')).x[1]).toBe(2);
        await c.set('old', 1, { ttlMs: -1 });
        expect(await c.get('old')).toBeUndefined();
        await c.delete('a');
        expect(await c.get('a')).toBeUndefined();
        expect(await c.clear()).toBe(true);
        // The in-memory mirror is bounded (weather responses are MBs): oldest entries go first.
        const big = openCache('t3', { indexedDB: null });
        for (let i = 0; i < 60; i++) await big.set(`k${i}`, i);
        expect(await big.get('k0')).toBeUndefined();
        expect(await big.get('k59')).toBe(59);
        expect(await big.get('k20')).toBe(20);
        const broken = openCache('t2', { indexedDB: { open() { throw new Error('SecurityError'); } } });
        await broken.set('k', 1);
        expect(await broken.get('k')).toBe(1);
        expect(await broken.kind()).toBe('memory');
    });

    it('persists through IndexedDB across instances (structured clone, TTL, typed arrays)', async () => {
        // Minimal IDB fake: async requests, upgrade on first open, values structured-cloned.
        const dbs = new Map();
        const request = fn => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
        const factory = {
            open(name) {
                const r = {};
                queueMicrotask(() => {
                    const fresh = !dbs.has(name);
                    if (fresh) dbs.set(name, new Map());
                    const stores = dbs.get(name);
                    r.result = {
                        createObjectStore: n => stores.set(n, new Map()),
                        transaction(n) {
                            const m = stores.get(n);
                            return { objectStore: () => ({
                                get: k => request(() => structuredClone(m.get(k))),
                                put: (v, k) => request(() => { m.set(k, structuredClone(v)); return k; }),
                                delete: k => request(() => { m.delete(k); }),
                                clear: () => request(() => m.clear()),
                            }) };
                        },
                        close() {},
                    };
                    if (fresh) r.onupgradeneeded?.();
                    r.onsuccess?.();
                });
                return r;
            },
        };
        const a = openCache('persist', { indexedDB: factory });
        expect(await a.kind()).toBe('indexeddb');
        expect(await a.set('w', { ghi: Float32Array.of(1.5, 2.5) }, { ttlMs: 60_000 })).toBe(true);
        await a.set('gone', 1, { ttlMs: -1 });
        const b = openCache('persist', { indexedDB: factory }); // a reload: nothing in memory
        const got = await b.get('w');
        expect(got.ghi).toBeInstanceOf(Float32Array);
        expect(got.ghi[1]).toBe(2.5);
        expect(await b.get('gone')).toBeUndefined();
        await b.delete('w');
        expect(await openCache('persist', { indexedDB: factory }).get('w')).toBeUndefined();
    });

    it('caches rate pages for closed periods only', async () => {
        const from = Date.parse('2026-01-01T00:00:00Z'), to = Date.parse('2026-01-03T00:00:00Z');
        const f = mockFetch({ '/v1/products/': rateEndpoint(halfHourly(from, to + 10 * 48 * SLOT, () => 20)) });
        const cache = openCache('rates', { indexedDB: null });
        const c = new OctopusClient({ fetch: f, cache, nowMs: Date.parse('2026-10-05T00:00:00Z') });
        const a = await c.unitRates('AGILE-24-10-01', 'E-1R-AGILE-24-10-01-C', from, to);
        const b = await c.unitRates('AGILE-24-10-01', 'E-1R-AGILE-24-10-01-C', from, to);
        expect(b).toEqual(a);
        expect(f.calls).toHaveLength(1);
        const live = new OctopusClient({ fetch: f, cache, nowMs: to + 3600_000 }); // period not yet closed
        await live.unitRates('AGILE-24-10-01', 'E-1R-AGILE-24-10-01-C', from, to + SLOT);
        await live.unitRates('AGILE-24-10-01', 'E-1R-AGILE-24-10-01-C', from, to + SLOT);
        expect(f.calls).toHaveLength(3);
    });
});

describe('fetchFlexibleRates (the "same usage on Flexible" comparison)', () => {
    const start = Date.parse('2025-09-30T23:00:00Z');
    const n = 48 * 10;
    const end = start + n * SLOT;
    const q = Date.parse('2025-10-04T23:00:00Z');
    const fake = (unit, standing) => {
        const calls = [];
        return {
            calls,
            unitRates: async (product, code, a, b) => { calls.push(['unit', product, code, a, b]); return unit; },
            standingCharges: async (product, code, a, b) => { calls.push(['standing', product, code, a, b]); return standing; },
        };
    };
    it('one request each; Direct Debit records, clipped to the window and stretched over its edges', async () => {
        const c = fake([
            { fromMs: start + 3_600_000, toMs: q, exc: 24, paymentMethod: 'DIRECT_DEBIT' },
            { fromMs: start + 3_600_000, toMs: q, exc: 25, paymentMethod: 'NON_DIRECT_DEBIT' },
            { fromMs: q, toMs: Infinity, exc: 26, paymentMethod: 'DIRECT_DEBIT' },
        ], [{ fromMs: -Infinity, toMs: Infinity, exc: 41, paymentMethod: 'DIRECT_DEBIT' }]);
        const f = await fetchFlexibleRates(c, { region: 'C', start, n });
        expect(c.calls.map((x) => x.slice(0, 3))).toEqual([['unit', 'VAR-22-11-01', 'E-1R-VAR-22-11-01-C'], ['standing', 'VAR-22-11-01', 'E-1R-VAR-22-11-01-C']]);
        expect(f.unit).toEqual([{ fromMs: start, toMs: start + 3_600_000, exc: 24 }, { fromMs: start + 3_600_000, toMs: q, exc: 24 }, { fromMs: q, toMs: end, exc: 26 }]);
        expect(f.standing).toEqual([{ fromMs: start, toMs: end, pPerDayExc: 41 }]);
        expect(f).toMatchObject({ product: 'VAR-22-11-01', code: 'E-1R-VAR-22-11-01-C' });
    });
    it('null without unit rates (and no standing request is wasted)', async () => {
        const c = fake([], []);
        expect(await fetchFlexibleRates(c, { region: 'C', start, n })).toBeNull();
        expect(c.calls).toHaveLength(1);
    });
});
