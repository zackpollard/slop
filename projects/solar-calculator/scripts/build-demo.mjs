#!/usr/bin/env node
/*
 * build-demo.mjs — DEV-ONLY. Rebuilds the bundled data files from the verified research
 * snapshots. Nothing here runs in the browser and nothing imports it; the outputs are
 * committed so the app needs no build step.
 *
 *   node projects/solar-calculator/scripts/build-demo.mjs [researchDir]
 *
 * researchDir (or $SOLAR_RESEARCH_DIR) is the folder of research snapshots the data was built
 * from; it is not committed (docs/solar-calculator/README.md). Outputs (in projects/solar-calculator/data/):
 *
 *   demo.json      12 months of real London (region C) half-hours on the LOCAL-day window
 *                  [2025-09-30T23:00Z, 2026-09-30T23:00Z) = 17 520 slots = 365 local days:
 *                    importExc   AGILE-24-10-01 value_exc_vat (verify-octopus fresh pull)
 *                    exportAgile AGILE-OUTGOING-19-05-13 (no VAT, floors at 0)
 *                    ghi/dni/dhi/tempC/windMs/wxSource  Open-Meteo SARAH-3 (+MSG/IFS fill)
 *                  plus the 2006–2025 SARAH-3 monthly climatology for the same grid cell, and
 *                  the region's Octopus Flexible (VAR-22-11-01, Direct Debit) unit rates and
 *                  standing charges for the window (flexible-C-*.json), for the Usage tab's
 *                  "same usage on Flexible" comparison.
 *                  Every series is joined on UTC epoch ms. The weather file starts at
 *                  2025-10-01T00:00Z (UTC midnight), two slots after the price file, so the
 *                  two leading night slots get ghi = dni = dhi = 0, the 00:00Z temperature
 *                  and wind, and wxSource 3 ('demo'). An index zip would shift the sun an
 *                  hour against the prices.
 *   kits.json      verified plug-in / battery kit catalog, trimmed + structured pvInputs
 *   stations.json  verified power-station catalog, trimmed + structured pvInputs
 *   constants.json legal limits, install costs and export tariffs
 * bundles.json is hand-written (prices read off the verified catalog; never parsed from notes).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// SOLAR_DATA_OUT writes elsewhere (e.g. to diff a rebuild against the committed files first)
const OUT = process.env.SOLAR_DATA_OUT ?? join(HERE, '..', 'data');
const R = process.argv[2] ?? process.env.SOLAR_RESEARCH_DIR;
if (!R) {
    console.error('usage: node projects/solar-calculator/scripts/build-demo.mjs <researchDir>  (or set SOLAR_RESEARCH_DIR)');
    process.exit(1);
}
const SLOT = 1_800_000;
const START = Date.parse('2025-09-30T23:00:00Z');
const N = 17_520;
const BUILD_DATE = '2026-10-05';

const read = p => JSON.parse(readFileSync(join(R, p), 'utf8'));
const r2 = x => Math.round(x * 100) / 100;
const r1 = x => Math.round(x * 10) / 10;
const fail = msg => { console.error('build-demo: ' + msg); process.exit(1); };

// ───────────────────────────── demo.json ─────────────────────────────

function buildDemo() {
    const fresh = read('verify-octopus/agile-24-10-01-C-12m-fresh.json'); // [iso, exc, inc]
    const inc = new Map(read('agile-C-12m.json').map(([iso, p]) => [Date.parse(iso), p]));
    const out = new Map(read('agile-outgoing-C-12m.json').map(([iso, p]) => [Date.parse(iso), p]));
    const exc = new Map(fresh.map(([iso, e, i]) => {
        const ms = Date.parse(iso);
        // Cross-check the two independent pulls: inc must equal exc × 1.05 in this window.
        if (Math.abs(i - (inc.get(ms) ?? NaN)) > 1e-9 || Math.abs(e * 1.05 - i) > 1e-6) fail(`price mismatch at ${iso}`);
        return [ms, e];
    }));
    const wx = read('demo-london-12m-halfhourly.json');
    const wxStart = Date.parse(wx.meta.start_utc);

    const cols = { importExc: [], exportAgile: [], ghi: [], dni: [], dhi: [], tempC: [], windMs: [], wxSource: [] };
    for (let t = 0; t < N; t++) {
        const ms = START + t * SLOT;
        const e = exc.get(ms), x = out.get(ms);
        if (e === undefined || x === undefined) fail(`missing price at ${new Date(ms).toISOString()}`);
        if (Math.abs(r2(e) - e) > 1e-9) fail(`exc not 2 dp at ${ms}`);
        cols.importExc.push(r2(e));
        cols.exportAgile.push(r2(Math.max(0, x)));
        const k = (ms - wxStart) / SLOT; // epoch join, never the loop index
        if (k < 0) {
            cols.ghi.push(0); cols.dni.push(0); cols.dhi.push(0);
            cols.tempC.push(r1(wx.temp[0])); cols.windMs.push(r1(wx.wind[0]));
            cols.wxSource.push(3);
        } else {
            if (k >= wx.meta.n) fail(`weather ends before ${new Date(ms).toISOString()}`);
            cols.ghi.push(Math.round(wx.ghi[k])); cols.dni.push(Math.round(wx.dni[k])); cols.dhi.push(Math.round(wx.dhi[k]));
            cols.tempC.push(r1(wx.temp[k])); cols.windMs.push(r1(wx.wind[k]));
            cols.wxSource.push(wx.src[k]);
        }
    }

    const clim = climatologyFromDaily(read('samples/sarah3-london-daily-2005-2025.json'));
    const verified = read('samples/sarah3-london-annual-2006-2025-verified.json');
    for (let m = 0; m < 12; m++) {
        const want = verified.monthly_climatology_2006_2025_kwh_m2[String(m + 1).padStart(2, '0')];
        if (Math.abs(clim.monthlyKwhM2[m] - want) > 0.06) fail(`climatology month ${m + 1}: ${clim.monthlyKwhM2[m]} vs ${want}`);
    }
    const annualGhi = cols.ghi.reduce((a, b) => a + b, 0) * 0.5 / 1000;

    const head = {
        version: 1,
        generatedAt: `${BUILD_DATE}T00:00:00Z`,
        description: 'Real London (region C) Agile prices, Agile Outgoing prices and satellite sunshine for 1 Oct 2025 – 30 Sep 2026, on the Octopus half-hour grid. Usage is synthesised in the app (js/demo.js).',
        start: START, startIso: new Date(START).toISOString(), n: N, slotMinutes: 30,
        from: '2025-10-01', to: '2026-09-30',
        lat: wx.meta.location.latitude, lon: wx.meta.location.longitude, altitude: 16,
        weatherGrid: { lat: wx.meta.grid_cells.sarah3[0], lon: r2(wx.meta.grid_cells.sarah3[1]) },
        region: 'C', postcode: 'SW1A 1AA',
        tariffCode: 'E-1R-AGILE-24-10-01-C', exportTariffCode: 'E-1R-AGILE-OUTGOING-19-05-13-C',
        standingPPerDayExc: 37.6525,
        flexible: flexibleBlock(),
        units: { importExc: 'p/kWh exc VAT', exportAgile: 'p/kWh (no VAT)', ghi: 'W/m² slot mean', tempC: '°C at slot midpoint', windMs: 'm/s at 10 m' },
        wxSourceCodes: { 0: 'SARAH-3', 1: 'LSA SAF MSG', 2: 'ECMWF IFS', 3: 'demo (no data, night)', 4: 'interpolated' },
        annualGhiKwhM2: Math.round(annualGhi * 10) / 10,
        attribution: 'Prices: Octopus Energy API (Agile Octopus AGILE-24-10-01, Agile Outgoing and Flexible Octopus VAR-22-11-01, London). Weather data by Open-Meteo.com (CC BY 4.0). Solar radiation © EUMETSAT, CM SAF SARAH-3 (doi:10.5676/EUM_SAF_CM/SARAH/V003) and LSA SAF; temperature/wind ECMWF IFS.',
        climatology: clim,
    };
    // One key per line so diffs stay readable; arrays stay on one line each.
    const lines = Object.entries(head).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
    for (const [k, v] of Object.entries(cols)) lines.push(`${JSON.stringify(k)}:${JSON.stringify(v)}`);
    const text = `{\n${lines.join(',\n')}\n}\n`;
    writeFileSync(join(OUT, 'demo.json'), text);
    console.log(`demo.json: ${(text.length / 1024).toFixed(1)} kB, annual GHI ${annualGhi.toFixed(2)} kWh/m²`);
}

/**
 * Region C Octopus Flexible (VAR-22-11-01) for the demo window: the Direct Debit records that
 * overlap it, ascending, as { from, to (null = open), exc } — p/kWh and p/day exc VAT (the app
 * applies VAT by its own schedule). inc must equal exc × (1 + VAT at the record's start).
 */
function flexibleBlock() {
    const END = START + N * SLOT;
    const pick = (file) => {
        const recs = read(file).filter(r => r.payment_method === 'DIRECT_DEBIT')
            .map(r => ({ from: r.valid_from, to: r.valid_to ?? null, exc: r.value_exc_vat, inc: r.value_inc_vat }))
            .filter(r => Date.parse(r.from) < END && (r.to === null || Date.parse(r.to) > START))
            .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
        if (!recs.length) fail(`${file}: no Direct Debit records in the window`);
        for (const r of recs) {
            const vat = Date.parse(r.from) >= Date.parse('2026-09-30T23:00:00Z') ? 0 : 0.05;
            if (Math.abs(r.exc * (1 + vat) - r.inc) > 1e-4) fail(`${file}: inc ≠ exc × ${1 + vat} at ${r.from}`);
        }
        for (let i = 1; i < recs.length; i++) if (recs[i - 1].to !== recs[i].from) fail(`${file}: gap or overlap at ${recs[i].from}`);
        return recs.map(({ from, to, exc }) => ({ from, to, exc }));
    };
    return {
        product: 'VAR-22-11-01', code: 'E-1R-VAR-22-11-01-C', paymentMethod: 'DIRECT_DEBIT',
        unit: pick('flexible-C-unit-rates.json'),
        standing: pick('flexible-C-standing-charges.json'),
    };
}

/** Monthly SARAH-3 sums per year (null days filled with that month-year's mean), 2006–2025. */
function climatologyFromDaily(json) {
    const { time, shortwave_radiation_sum: mj } = json.daily;
    const acc = new Map(); // 'YYYY-MM' → { sum, have, days }
    for (let i = 0; i < time.length; i++) {
        const key = time[i].slice(0, 7);
        const a = acc.get(key) ?? { sum: 0, have: 0 };
        if (mj[i] != null) { a.sum += mj[i] / 3.6; a.have++; }
        acc.set(key, a);
    }
    const years = [];
    const ym = [];
    for (let y = 2006; y <= 2025; y++) {
        years.push(y);
        for (let m = 1; m <= 12; m++) {
            const a = acc.get(`${y}-${String(m).padStart(2, '0')}`);
            const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
            if (!a || !a.have) fail(`no SARAH-3 data for ${y}-${m}`);
            ym.push(r2(a.sum / a.have * dim));
        }
    }
    const monthly = Array.from({ length: 12 }, (_, m) => r2(years.reduce((s, _y, i) => s + ym[i * 12 + m], 0) / years.length));
    return {
        monthlyKwhM2: monthly, years, yearMonthlyKwhM2: ym,
        gridLat: json.latitude, gridLon: r2(json.longitude),
        source: 'Open-Meteo satellite-api eumetsat_sarah3 daily shortwave_radiation_sum, 2006–2025, null days filled with the month-year mean',
    };
}

// ───────────────────────────── catalogs ─────────────────────────────

const KIT_FIELDS = ['id', 'brand', 'model', 'kind', 'coupling', 'installRoute', 'enaRef', 'enaStatus', 'acLimitW', 'pvInputMaxW',
    'mppts', 'includedPanels', 'batteryKwh', 'usableKwh', 'maxChargeW', 'maxDischargeW', 'acChargeW', 'roundTripEff',
    'inverterEff', 'inverterEffBasis', 'cycles', 'warrantyYears', 'expansion', 'exportTariff', 'priceGbp', 'priceDate',
    'priceSource', 'availableNow', 'confidence', 'notes'];

/**
 * Per-input PV limits transcribed by hand from each entry's verified notes (datasheet
 * figures). vocMaxV/iscMaxA decide how many ordinary 400–500 W panels fit per input.
 * Missing entries = not published.
 */
const KIT_PV_INPUTS = {
    'octopus-plugin-solar-1x460': { count: 2, maxDcW: 670, vMinV: 31, vMaxV: 45, vocMaxV: 60, iMaxA: 20 },
    'octopus-plugin-solar-2x460': { count: 2, maxDcW: 670, vMinV: 31, vMaxV: 45, vocMaxV: 60, iMaxA: 20 },
    'ecoflow-stream-micro-2x500': { count: 2, maxDcW: 600, vMinV: 16, vMaxV: 60, vocMaxV: 65, iMaxA: 16 },
    'ecoflow-stream-facade-2x400': { count: 2, maxDcW: 600, vMinV: 16, vMaxV: 60, vocMaxV: 65, iMaxA: 16 },
    'cityplumbing-dmegc-1x465-hiflow': { count: 1, maxDcW: 1280, vMinV: 16, vMaxV: 96, vocMaxV: 100, iMaxA: 16 },
    'cityplumbing-dmegc-2x515-hiflow': { count: 1, maxDcW: 1280, vMinV: 16, vMaxV: 96, vocMaxV: 100, iMaxA: 16 },
    'powerxpress-920-marstek': { count: 2, maxDcW: null, vMinV: 22, vMaxV: 60, vocMaxV: 55, iMaxA: 15 },
    'patiosun-duo': { count: 1, maxDcW: 1280, vMinV: 16, vMaxV: 96, vocMaxV: 100, iMaxA: 16 },
    'thunder-bolt-920': { count: 2, maxDcW: null, vMinV: 16, vMaxV: 60, vocMaxV: 65, iMaxA: null },
    'hoymiles-hf-800-wb-loose': { count: 1, maxDcW: 1280, vMinV: 16, vMaxV: 96, vocMaxV: 100, iMaxA: 16 },
    'ecoflow-stream-ultra': { count: 4, maxDcW: 500, vMinV: 15, vMaxV: 60, vocMaxV: 60, iMaxA: 14 },
    'ecoflow-stream-ultra-x': { count: 4, maxDcW: 500, vMinV: null, vMaxV: 60, vocMaxV: 60, iMaxA: null },
    'anker-solarbank4-e5000-pro': { count: 4, maxDcW: 1250, vMinV: 16, vMaxV: 50, vocMaxV: 60, iMaxA: null },
    'zendure-solarflow-2400-pro': { count: 4, maxDcW: 750, vMinV: 14, vMaxV: null, vocMaxV: 55, iMaxA: 22.5 },
    'ecoflow-stream-5000': { count: 4, maxDcW: 1250, vMinV: null, vMaxV: 60, vocMaxV: 60, iMaxA: null },
};

function pvInputsOf(spec) {
    if (!spec) return null;
    const { count, ...one } = spec;
    return Array.from({ length: count }, () => ({ ...one }));
}

function buildKits() {
    const kits = read('plugin-kits-verified.json').map(k => {
        const o = {};
        for (const f of KIT_FIELDS) if (k[f] !== undefined) o[f] = k[f];
        const pv = pvInputsOf(KIT_PV_INPUTS[k.id]);
        if (pv) o.pvInputs = pv;
        return o;
    });
    write('kits.json', { version: 1, source: 'plugin-kits-verified.json snapshot, verified live 2026-10-05 (see docs/solar-calculator/VERIFY-market.md)', priceDate: BUILD_DATE, kits });
}

const STATION_FIELDS = ['id', 'brand', 'model', 'kind', 'usableKwh', 'acOutputW', 'acChargeW', 'acChargeAdjustable', 'acInputLimitW',
    'pvInputMaxW', 'pvVoltageRange', 'pvWireableTypical', 'upsSwitchMs', 'passThrough', 'bypassDisableable', 'idleW', 'acAcEff',
    'fixedLossW', 'cycles', 'warrantyYears', 'touMode', 'scheduling', 'controlPaths', 'feasibleStrategies', 'expansion',
    'priceGbp', 'rrpGbp', 'priceDate', 'priceSource', 'availability', 'installRoute', 'confidence', 'notes'];

/**
 * Wireable PV per station, from the verified pvVoltageRange / pvWireableTypical text
 * (VERIFY-ups: per-input Voc/Isc limits mean ONE ordinary panel per 11–60 V input).
 * panels = how many typical 400–450 W panels can actually be connected.
 */
const STATION_PV = {
    'ecoflow-river-3-plus': { inputs: [{ maxDcW: 220, vMinV: 11, vocMaxV: 55, iMaxA: 13 }], panels: 0, note: 'one small (≤220 W) panel only' },
    'ecoflow-delta-3-classic': { inputs: [{ maxDcW: 500, vMinV: 11, vocMaxV: 60, iMaxA: null }], panels: 1 },
    'ecoflow-delta-3-plus': { inputs: [{ maxDcW: 500, vMinV: 11, vocMaxV: 60, iMaxA: null }, { maxDcW: 500, vMinV: 11, vocMaxV: 60, iMaxA: null }], panels: 2 },
    'ecoflow-delta-3-max-plus': { inputs: [{ maxDcW: 500, vMinV: 11, vocMaxV: 60, iMaxA: 18 }, { maxDcW: 500, vMinV: 11, vocMaxV: 60, iMaxA: 18 }], panels: 2 },
    'ecoflow-delta-pro-3': { inputs: [{ maxDcW: 1600, vMinV: 30, vocMaxV: 150, iMaxA: 15 }, { maxDcW: 1000, vMinV: 11, vocMaxV: 60, iMaxA: 20 }], panels: 4 },
    'anker-solix-c1000-gen2': { inputs: [{ maxDcW: 600, vMinV: 11, vocMaxV: 60, iMaxA: 14.5 }], panels: 1 },
    'anker-solix-c2000-gen2': { inputs: [{ maxDcW: 800, vMinV: 11, vocMaxV: 60, iMaxA: 17 }], panels: 1 },
    'anker-solix-f3000': { inputs: [{ maxDcW: 1600, vMinV: 11, vocMaxV: 165, iMaxA: null }, { maxDcW: 800, vMinV: 11, vocMaxV: 60, iMaxA: null }], panels: 4 },
    'bluetti-elite-100-v2': { inputs: [{ maxDcW: 1000, vMinV: 12, vocMaxV: 60, iMaxA: null }], panels: 1 },
    'bluetti-elite-200-v2': { inputs: [{ maxDcW: 1000, vMinV: 12, vocMaxV: 60, iMaxA: 20 }], panels: 1 },
    'bluetti-elite-300': { inputs: [{ maxDcW: 1200, vMinV: 12, vocMaxV: 60, iMaxA: 22 }], panels: 1 },
    'bluetti-elite-400': { inputs: [{ maxDcW: 1000, vMinV: 12, vocMaxV: 60, iMaxA: null }], panels: 1 },
    'bluetti-apex-300': { inputs: [{ maxDcW: 1200, vMinV: 12, vocMaxV: 60, iMaxA: 20 }, { maxDcW: 1200, vMinV: 12, vocMaxV: 60, iMaxA: 20 }], panels: 2 },
    'jackery-explorer-1000-v2': { inputs: [{ maxDcW: 400, vMinV: 12, vocMaxV: 60, iMaxA: null }], panels: 1 },
    'jackery-explorer-2000-v2': { inputs: [{ maxDcW: 400, vMinV: 12, vocMaxV: 60, iMaxA: null }], panels: 1 },
    'jackery-explorer-3000-v2': { inputs: [{ maxDcW: 1000, vMinV: null, vocMaxV: 60, iMaxA: null }], panels: 1, note: 'input count unverified (1–2 panels)' },
    'dji-power-2000': { inputs: [], panels: 0, note: 'needs the separate DJI 1.8 kW solar charger (extra cost)' },
    'bluetti-ac300-b300k': { inputs: [], panels: 0, note: 'PV voltage window unverified' },
};

function buildStations() {
    const stations = read('ups/power-stations-verified.json').map(s => {
        const o = {};
        for (const f of STATION_FIELDS) if (s[f] !== undefined) o[f] = s[f];
        o.availableNow = /in stock/i.test(s.availability ?? '') && !/^base SKU sold out/i.test(s.availability ?? '');
        o.preorder = /pre-?order/i.test(s.availability ?? '');
        const pv = STATION_PV[s.id];
        if (!pv) fail(`no PV table entry for station ${s.id}`);
        o.pvInputs = pv.inputs;
        o.pvWireablePanels = pv.panels;
        if (pv.note) o.pvNote = pv.note;
        return o;
    });
    const meta = read('ups/power-stations-verified.meta.json');
    write('stations.json', {
        version: 1,
        source: 'power-stations-verified.json snapshot, verified live 2026-10-05 with the corrections in docs/solar-calculator/VERIFY-ups.md',
        priceDate: BUILD_DATE,
        conventions: {
            usableKwh: meta.conventions?.usableKwh, fixedLossW: meta.conventions?.fixedLossW,
            bypassOverheadW: meta.conventions?.bypassOverheadW, roundTripFormula: meta.conventions?.roundTripFormula,
            pvInputs: 'Per-input limits transcribed from pvVoltageRange; pvWireablePanels = typical 400–450 W panels that can actually be connected (VERIFY-ups).',
            availableNow: "true when availability says 'in stock' (derived)",
        },
        defaults: { etaInv: 0.94, chargeEff: 0.88, bypassW: 8, fixedLossWSmall: 20, fixedLossWLarge: 30, fixedLossSmallMaxKwh: 2.5, reservePct: 10 },
        stations,
    });
}

function buildConstants() {
    const c = read('plugin-market-constants.verified.json');
    delete c.enaRegister?.snapshot;
    write('constants.json', { version: 1, source: 'plugin-market-constants.verified.json snapshot, verified 2026-10-05 (see docs/solar-calculator/VERIFY-market.md)', ...c });
}

function write(name, obj) {
    const text = JSON.stringify(obj, null, 1) + '\n';
    writeFileSync(join(OUT, name), text);
    console.log(`${name}: ${(text.length / 1024).toFixed(1)} kB`);
}

buildDemo();
buildKits();
buildStations();
buildConstants();
