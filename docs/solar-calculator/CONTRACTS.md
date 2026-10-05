# solar-calculator — binding module contracts

Everything under `projects/solar-calculator/`. Engine modules (all except `app.js`, `store.js`,
`ui.js`, `charts.js`, `map.js`, `engine.js`, `views/*`) are **pure ES modules**: no DOM, no
`window`/`document`/`localStorage`, runnable in a Web Worker and in node/vitest. Network functions take
an injectable `fetch`. Every exported function has a JSDoc block. If you need something not in this
file, add it to YOUR module and document it in your final report — never change another module's
signature.

## 0. Naming & units

- Suffixes are mandatory on numeric fields: `…P` pence, `…Gbp` pounds, `…Kwh`, `…W`, `…Pct` (0–100),
  `…Ms` epoch ms, `…Deg`. Prices without suffix are p/kWh (`importPrice`, `pD`).
- Slot = 30 min, `SLOT_MS = 1_800_000`, `DT_H = 0.5`. Slot `t` covers `[start + t·SLOT_MS, +SLOT_MS)` UTC.
- Arrays: per-slot `Float64Array(n)` unless stated; per-sub-sample `Float32Array(n·subSteps)` where
  sub-sample `j` of slot `t` is index `t·subSteps + j`, centred at `start + t·SLOT_MS + (j+0.5)·SLOT_MS/subSteps`.
- Local time = Europe/London via `time.js` rules (no Intl in hot paths). Calendar months are LOCAL.
- Compass azimuth everywhere in app types: 0 = N, 90 = E, 180 = S, 270 = W (convert for physics).

## 1. time.js (A1)

```js
export const SLOT_MS, DT_H
export function ukOffsetMs(ms): 0 | 3_600_000          // BST: last Sun Mar 01:00Z → last Sun Oct 01:00Z
export function localParts(ms): { year, month /*1-12*/, day, minutes /*0..1439*/, hh /*0..47*/, dow /*0=Mon*/, date /*'YYYY-MM-DD'*/ }
export function localMidnightUtc(date: 'YYYY-MM-DD'): number
export function utcDate(ms): 'YYYY-MM-DD'
export function parseOctopusTime(s: string): number     // normalises '+0100' → '+01:00'; throws on NaN
export function floorSlot(ms): number
/** @returns {LocalIndex} */
export function buildLocalIndex(start, n): {
  hh: Uint8Array, day: Int32Array /*0-based local-day index*/, month: Uint8Array /*0..11*/,
  monthKey: Int32Array /*year*12 + month0*/, dow: Uint8Array, peak: Uint8Array /*hh 32..37*/,
  days: Array<{ date, first, count }>, months: Array<{ key /*'YYYY-MM'*/, monthKey, month0, first, count, dim /*days in month*/ }>
}
```
Test vectors: engine critique §"time.js — DST/local bucketing rules".

## 2. vat.js (A1)

```js
export const DEFAULT_VAT_SCHEDULE: Array<{ untilMs: number, rate: number }>  // 0.05 → 2026-09-30T23:00Z, 0 → 2027-03-31T23:00Z, 0.05 → Infinity
export function vatAt(ms, schedule = DEFAULT_VAT_SCHEDULE): number
export function withVat(excArray: Float64Array, start, schedule?): Float64Array
```

## 3. sun.js (A1)

```js
export function sunPosition(ms, lat, lon): { zenithDeg /*apparent*/, zenithTrueDeg, elevationDeg, azimuthDeg /*0=N cw*/, cosZ /*apparent*/, declinationDeg }
export function dayOfYear(ms): number
export function extraterrestrial(doy): number            // W/m², Spencer, 1366.1
export function airmassKastenYoung(zenithDeg): number    // NaN for ≥90
export function clearSkyIneichen(zenithDeg, doy, linke, altitudeM): { ghi, dni, dhi }
export function meanCosZ(aMs, bMs, lat, lon, samples = 10): number   // mean of max(cosZtrue,0)
export const LINKE = { london: Float64Array(12), manchester: Float64Array(12) }  // and a default 3.5 fallback
```

## 4. weather.js (A1)

```js
/** @typedef {{ ghi: Float32Array, dni: Float32Array, dhi: Float32Array, tempC: Float32Array, windMs: Float32Array, wxSource: Uint8Array /*0 SARAH-3,1 MSG,2 IFS×0.93,3 demo,4 interpolated*/, meta: { counts: number[], sarahLastMs, ifsScaled: boolean, gridLat, gridLon, notes: string[] } }} WeatherSeries */
export function buildUrls({ lat, lon, start, n }): { sarah3: string, msg: string, archive: string }
export async function fetchWeather({ lat, lon, start, n, fetch, cache, onProgress, signal }): Promise<WeatherSeries>
export function alignToSlots({ sarah3, msg, archive } /* parsed Open-Meteo JSON objects or null */, lat, lon, start, n): WeatherSeries  // pure
/** @typedef {{ monthlyKwhM2: Float64Array /*12, mean of 2006–2025 monthly sums*/, years: Int16Array, yearMonthlyKwhM2: Float64Array /*years.length*12*/, gridLat, gridLon }} Climatology */
export async function fetchClimatology({ lat, lon, fetch, cache }): Promise<Climatology>
export function climatologyFromDaily(json): Climatology   // pure; nulls filled per month-year mean
```
`start_date` = UTC date of the first slot; `end_date` = UTC date of last slot + 1 day, capped at today
UTC. Always explicit `models=`. Long all-source gaps throw `DataError('WEATHER', …)` (see §8).

## 5. pv.js (A1)

```js
export const DEFAULT_LOSSES = { soiling: 2, mismatch: 1, wiring: 1, lid: 1, availability: 1 }  // % each, multiplicative
export const FAIMAN = { open: [26.9, 6.2], roof: [20, 3.2], railing: [24, 5], wall: [21, 3.5] }
export function lossFactor(losses = DEFAULT_LOSSES): number
/** Orientation-independent geometry, cached per (start,n,lat,lon,altitude,subSteps). */
export function prepareGeometry({ start, n, lat, lon, altitude = 0 }, { subSteps = 3 }): Geometry
// Geometry { subSteps, n, m, cosZ, zenithDeg, sunAzDeg, dniExtra, airmass, monthOfSub: Uint8Array(m), csWeight: Float32Array(m) }
/** Irradiance split into sub-samples (clear-sky-index, slot mean preserved) + Perez F1/F2 + temp/wind at sub-samples. */
export function prepareSky(ds /*Dataset or {ghi,dni,dhi,tempC,windMs,start,n}*/, geom, { monthScale = null /*Float64Array(12) indexed by local month0*/ } = {}): Sky
// Sky { geom, ghi, dni, dhi, F1, F2, tempC, windMs: Float32Array(m), scaleKey: string }
export function arrayKey(array): string                     // all fields that affect DC
export function arrayDcW(sky, array, { losses = DEFAULT_LOSSES } = {}): Float32Array  // DC W per sub-sample
/** Sum arrays per input, apply per-input caps, PVWatts efficiency, AC cap per sub-sample, average to slots. */
export function inverterAc(geom, dcByInput: Float32Array[], inverter): PvSlots
// PvSlots { dcRawKwh, dcInvKwh, acKwh, clippedDcKwh, standbyKwh, etaPv: Float64Array(n) }  (definitions: engine critique)
export function dcToSlotsKwh(geom, dcW: Float32Array, maxDcW = Infinity): Float64Array   // for UPS own PV (no inverter)
export function scaleDcByMonth(geom, dcW: Float32Array, factors: Float64Array /*12*/): Float32Array
```
Inverter: `{ acLimitW: 800, etaNom: 0.96, inputs: [{ maxDcW, maxAcW }], standbyW: 0, supportsPowerLimit: false }`.
PvArray: see §9.

## 6. Dataset — dataset.js / octopus.js / csv.js / demo.js / cache.js (A2)

```js
/** @typedef {Object} Dataset
 * id: string (stable hash: source + range + lat/lon + tariffs + serverW)
 * start, n, lat, lon, altitude
 * load: Float64Array            kWh/slot after gap filling (pre-solar demand)
 * loadFilled: Uint8Array        0 real, 1 filled, 2 extrapolated
 * importPriceExc: Float64Array  p/kWh exc VAT from the user's own agreement tariffs (or chosen basis)
 * importPrice: Float64Array     as billed inc VAT (vat.js schedule)
 * importPriceFwdExc: Float64Array  levy-adjusted forward basis (engine critique)
 * exportPrices:    { prime: Float64Array, fixed: Float64Array, agile: Float64Array|null }  as paid, no VAT
 * exportPricesFwd: { prime: Float64Array, fixed: Float64Array, agile: Float64Array|null }
 * standing: Array<{ fromMs, toMs, pPerDayExc }>
 * ghi, dni, dhi, tempC, windMs: Float32Array; wxSource: Uint8Array
 * local: LocalIndex (time.js)
 * climatology: Climatology | null
 * meta: { source: 'octopus'|'csv'|'demo'|'manual', region /*'A'..'P'*/, postcode, locationSource,
 *         tariffs: Array<{ code, product, fromMs, toMs }>, priceBasis: 'mine'|'agile'|'flexible'|'flat',
 *         serverW?, coverage: { realPct, filledSlots, extrapolatedSlots, days }, weather: WeatherSeries.meta,
 *         notes: string[], createdAtMs }
 */
export function summarize(ds): DatasetSummary   // { id, start, n, days, from, to, region, postcode, lat, lon, source, coverage, tariffs, notes, weather }
export function buildDataset(parts): Dataset    // pure: aligns everything by epoch ms, fills gaps, builds price variants
export function fillGaps(loadWithNaN: Float64Array, local, baseLoadW): { load, filled }
export function withBaseLoad(ds, baseW, targetW): Dataset   // shares all arrays except load; new id
export function demoDatasetFromJson(json, { serverW = 500, seed = 1 } = {}): Dataset   // pure (tests read file via fs)
export async function loadDataset(spec: DatasetSpec, { fetch, cache, onProgress, signal }): Promise<Dataset>
// DatasetSpec = { kind:'octopus', apiKey, accountNumber?, location?, priceBasis?, flatP?, installedSolarDate? }
//             | { kind:'demo', serverW } | { kind:'csv', text, location, region } | { kind:'manual', baseW, otherKwhYr, location, region }
// location = { postcode } | { lat, lon }
```
`onProgress({ step: 'account'|'usage'|'prices'|'export'|'weather'|'climatology'|'build', status: 'start'|'done'|'error', detail, count, pct })`.

`octopus.js`: `class OctopusClient({ apiKey, fetch })` with `account(number)`, `findAccountNumbers()`,
`consumption(mpan, serial, fromMs, toMs)` → `Array<[ms, kWh]>` ascending deduped,
`unitRates(product, tariff, fromMs, toMs)` / `standingCharges(...)` → `Array<{ fromMs, toMs, exc, paymentMethod }>`
ascending, `meterPointGsp(mpan)`, `gspForPostcode(pc)` → letters[]; plus pure helpers
`parseAccount(raw)`, `parseTariffCode(code)`, `expandRatesToSlots(rates, start, n)`, `mergeConsumption(series[], start, n)`,
`REGIONS`, `CURRENT` (product codes). `csv.js`: `parseConsumptionCsv(text)` → `{ rows: Array<[ms,kWh]>, format, warnings }`.
`demo.js`: `syntheticLoad(local, { serverW, householdKwhYr = 2700, seed })`. `cache.js`: `openCache(name)` →
`{ get, set, delete, clear }` (Promise; IndexedDB; in-memory fallback; never throws).

`data/demo.json` (built by A2 from research files, joined by epoch ms): `{ version, start, n, lat, lon,
region:'C', postcode, tariffCode, importExc: number[] (2 dp), exportAgile: number[], ghi/dni/dhi: int[],
tempC/windMs: number[] (1 dp), wxSource: int[], climatology: {...}, standingPPerDayExc, attribution }`.

## 7. insights.js (A3)

```js
export function estimateBaseLoad(ds): { w, p10, p90, recentW, driftPct, days, dailyW: Float64Array /*NaN = dropped*/, monthly: Array<{ key, w }> }
export function analyseUsage(ds): Insights
// Insights { baseLoad: {...estimateBaseLoad, kwhYr, sharePct, costBilledGbpYr, costPeakGbpYr, gbpPer100W},
//   peak: { kwhSharePct, costSharePct, kwhPerDay }, profiles: { load, priceBilled: Float64Array(48), loadCounts: Uint16Array(48) },
//   monthlyBills: Array<{ key, kwh, energyGbp, standingGbp }>, heatmap: { days, dates: string[], load: Float32Array(days*48), price: Float32Array(days*48) },
//   loadWeightedPriceP, timeWeightedPriceP, negative: { slots, kwh, gbp }, totals: { kwh, energyGbp, standingGbp, days }, coverage }
```

## 8. Errors (A2 defines in dataset.js, everyone uses)

```js
export class DataError extends Error { constructor(code /*'AUTH'|'ACCOUNT'|'NO_SMART_DATA'|'NETWORK'|'RATE_LIMIT'|'WEATHER'|'LOCATION'|'TOO_LITTLE_DATA'|'CSV'*/, message, { step, retryable, action /*'checkKey'|'retry'|'useDemo'|'setPostcode'|'pickAccount'*/, choices } = {}) }
```
Errors crossing the worker are serialised as `{ name, code, message, step, retryable, action, choices }`.

## 9. System schema — system.js (A3)

```js
/** PvArray */ { id, name, count, wp, tilt, azimuth /*compass*/, input: 0, mounting: 'open'|'roof'|'railing'|'wall',
  groundSelfShade /*default: mounting is railing|wall*/, albedo: 0.2, tempCoeffPct: -0.30, dcModel: 'pvwatts'|'huld2025',
  lowLightK: 0.0064, bifaciality: 0, rearShading: 0.6, shadingPct: 3, beamShadingPct: 0, diffuseShadingPct: 0, horizon: number[] }
/** Battery */ { coupling: 'dc'|'ac'|'ups', capacityKwh, minSocPct: 10, maxChargeW, maxDischargeW, acChargeW: 0,
  effCharge: 0.96, effDischarge: 0.96, acChargeEff: 0.93, acEffCharge: 0.92, acEffDischarge: 0.92, acOutputW,
  standbyW: 10, allowGridExport: false, strategy: 'threshold', fixedOutputW: null,
  schedule: { chargeBelowP: null, chargeWindow: ['00:00','06:00'], dischargeWindow: ['16:00','19:00'] },
  replanAt: '16:00', wearPPerKwh: 2, deltaKwh: 0.025, cycles: 6000, lifeYears: 15, pvForecast: 'persistence',
  ups: null | { dedicatedW: 'baseload'|number, outletMaxW, etaInv: 0.94, chargeEff: 0.88, chargeW, fixedLossW,
                bypassW: 8, bypass: 'auto'|'disabled', pvArrays: PvArray[], pvInputs: [{ maxDcW }] } }
/** CostItem */ { label, gbp, year: 0, kind: 'hardware'|'install'|'other' }
/** Upgrade */ { atYear, label, battery?: Battery, addArrays?: PvArray[], route?: 'hardwired'|'whatif', costs: CostItem[] }
/** System */ { id, name, route: 'plugin'|'hardwired'|'ups'|'whatif'|'reference', kitId: null, sourceIds: [],
  arrays: PvArray[], inverter: Inverter|null, battery: Battery|null,
  export: { kind: 'none'|'prime'|'fixed'|'agile'|'flat', flatP: 0 }, canCurtail: false,
  loadAdjustW: 0 /* e.g. −100 for 'cut 100 W' reference */, costs: CostItem[], upgrade: Upgrade|null,
  spotId: null, featured: false, notes: [] }

export function normalizeSystem(partial): System   // fills defaults recursively, clamps ranges, never throws
export function systemKey(system): string          // stable key (sorted keys) excluding id/name/featured/notes
export function capexGbp(system, { year = 0 } = {}): number
export const DEFAULTS = { array, battery, inverter, ups }
```

## 10. battery.js (A3)

```js
/** DispatchInputs */ { n, load /*incl. loadAdjust*/, pvAc /*no-battery acKwh*/, dcInvKwh, clippedDcKwh, etaPv,
  upsPvDc: Float64Array|null, dedicated: Float64Array|null /*D_t*/, pD, xD, local, acLimitW, etaNom, canCurtail }
/** Flows */ { imp, exp, gridChg, battIn, battOut, battOutAc, soc, pvDirectAc, curtailed, upsPvWasted, standby,
  upsConversionLoss, bypassOverhead: Float64Array(n), wearP: number, cycles: number }
export function noBatteryFlows(inp): Flows
export function dispatch(inp, battery /*normalised*/, opts = {}): Flows
export function slotDC(delta, s, c), slotAC(delta, s, c), slotUPS(delta, s, c)   // exported for tests; return {cost, imp, exp, ...} | null
export function dpPlan(...), STRATEGY_LABELS
```

## 11. simulate.js (A3)

```js
/** Values flows two ways; aggregates; annualises per calendar month. */
export function simulate(ds, pv: PvSlots | null, system, { upsPvDc = null, includeSlots = false } = {}): SimResult
// SimResult { totals: Totals, annual: Totals, monthly: Array<MonthRow>, profile: Profile48, warnings: string[], slots?: Flows & { pvAc } }
// Totals (definitions per engine critique): days, loadKwh, pvDcKwh, pvAcKwh, pvDirectAcKwh, clippedKwh, curtailedKwh,
//   upsPvWastedKwh, exportKwh, exportUnpaidKwh, importKwh, gridChargeKwh, battInKwh, battOutKwh, battOutAcKwh, battCycles,
//   standbyKwh, baselineBilledP, newBilledP, savingsBilledP, exportIncomeBilledP, impSavFwdExcP, expIncFwdP, wearP,
//   selfConsumptionPct, selfSufficiencyPct, peakGenSharePct, peakImportCutPct, filledSharePct, savingsFilledP
// MonthRow { key, month0, coveredDays, dim, loadKwh, pvAcKwh, importKwh, exportKwh, clippedKwh, savingsBilledP, impSavFwdExcP, expIncFwdP }
// Profile48 { load, pvAc, imp, exp, battNet, priceBilled, savingsBilledP: Float64Array(48) }
export function annualise(monthly): Totals-additive-subset
```

## 12. finance.js (A3)

```js
export const DEFAULT_FINANCE = { installDate: '2026-11-01', years: 20, discountRate: 0.04, escalation: 0.02,
  vatSchedule: DEFAULT_VAT_SCHEDULE, vatReturns: true, pvAnnualDeg: 0.004, pvFirstYearDeg: 0,
  microReplaceYear: 12, microReplaceGbp: 150, batteryCalendarFade: 0.015, batteryEolSoh: 0.7,
  replaceBattery: false, omGbpPerYear: 0 }
/** MonthlyFwd = Array(12) indexed by month0: { impSavFwdExcP, expIncFwdP } annualised to the full month */
export function project({ costs: CostItem[], pvMonthly: MonthlyFwd, battMonthly: MonthlyFwd|null,
  standbyCostFwdP = 0, battery = null /*{ coupling, efcPerYear, cycles, lifeYears }*/, hasMicro = true,
  upgrade = null /*{ atYear, costs, stage2PvMonthly, stage2BattMonthly, battery }*/, opts = DEFAULT_FINANCE }): Finance
// Finance { capexGbp, year1Gbp, years: Array<{ y, pvGbp, battGbp, savingsGbp, outlayGbp, cashFlowGbp, cumulativeGbp, discountedCumulativeGbp, soh }>,
//   paybackYears|null, discountedPaybackYears|null, npvGbp, npv10Gbp, net10Gbp, irr|null, roiPct, lcoePPerKwh|null, lcosPPerKwh|null,
//   batteryEndYear|null, flags: string[] }
export function npv(cashFlows, r), irr(cashFlows), paybackYears(cashFlows)
```
Hand-computed test cases: engine critique §Finance.

## 13. core.js — SolarEngine (B1)

```js
export class SolarEngine {
  constructor(ds, catalog /* normalised, kits.js */)
  get summary(): DatasetSummary
  insights(): Insights                                   // cached
  setProjectBaseW(w | null): void                        // all later runs use withBaseLoad(ds, baseLoadW, w)
  normalizeSystem(partial): System
  validate(system): RulesResult
  runScenario(system, { withBand = true, finance = {}, includeSlots = false, fidelity = 'full' } = {}): ScenarioResult
  autoScenarios({ spots } = {}): System[]
  orientationSweep(system, arrayId, { onProgress } = {}): SweepResult
  baseLoadCurve(systems, xs?): Array<{ id, points: Array<{ x, savingsGbp, paybackYears, selfUsePct }> }>
  panelCountCurve(system): Array<{ x, label, capexGbp, savingsGbp, paybackYears, marginalGbp }>
  batterySizeCurve(system): Array<{ x /*kWh*/, label, capexGbp, savingsGbp, paybackYears, marginalGbp }>
  typicalDay(system, which /*'summer'|'winter'|'YYYY-MM-DD'*/): { date, slots: Array<{ t, hh, load, pvAc, battNet, imp, exp, soc, price }> }
  exportCsv(system): string
}
// ScenarioResult { id, system, rules: RulesResult, typical: SimResult, actual: SimResult, pvOnly: SimResult|null /*typical, battery removed*/,
//   band: { years: number[], savingsGbp: number[], p10, p50, p90 } | null, finance: Finance, financeBand: { p10: Finance, p90: Finance } | null,
//   battery?: { split: { fromSolarGbp, fromGridGbp, standbyGbp }, optimalGbp, thresholdGbp } }
// SweepResult { azimuths, tilts, cells: Array<{ az, tilt, kwh, gbp, pPerKwh, peakSharePct }>, starred: Array<{ key /*'bestGbp'|'bestKwh'|'current'|'W90'|'S35'|'SSW45'|…*/, az, tilt, kwh, gbp, pPerKwh, peakSharePct }>, proxyNote }
```
Caches: geometry per subSteps; sky per (monthScale key); DC per (arrayKey, sky); PvSlots per
(input set, inverter); ScenarioResult per (systemKey, finance, projectBaseW). Weather basis for
`typical` = monthScale from climatology; `actual` = no scaling; band via `scaleDcByMonth`.

## 14. kits.js / rules.js / scenarios.js / sweep.js (B1)

```js
// kits.js
export function normalizeCatalog({ kits, stations, bundles, constants }): Catalog   // { kits: Kit[], stations: Station[], bundles, constants, byId(id) }
export function kitToSystem(kit, { spot, catalog, exportKind }): System
export function stationToSystem(station, { dedicatedW, panels /*{count, wp, spot}*/, catalog }): System
// rules.js
export function validate(system, catalog): RulesResult   // { legal: 'ok'|'check'|'whatif'|'reference', errors: Issue[], warnings: Issue[] }
// Issue { code, message, fixes: Array<{ label, action }> }
export function applyFix(system, action, catalog): System
// scenarios.js
export function autoScenarios(engine, catalog, { spots }): System[]
export const DEFAULT_SPOTS: MountSpot[]
// MountSpot { id, name, kind: 'ground'|'flatroof'|'wall'|'railing'|'pitched', azimuth: number|null, tilt: number|null, tiltRange: [min,max], maxPanels, shadingPct: 3, horizon: [], groundLevel: true }
// sweep.js
export function orientationGrid({ azStep = 10, tiltStep = 5 }): Array<{ az, tilt }>   // tilt 0 once
export function sweepCells(engine, system, arrayId, grid, opts): Array<cell>        // used by core
```

## 15. verdict.js (C-verdict)

```js
export async function buildVerdict(engine, { scenarios /*System[]*/, finance, onPartial }): Verdict
// Verdict per UX critique §Verdict: { context, usage, ranked: VerdictRow[], bestBuyId, runnerUpId,
//   answers: { orientation, battery, ups, growth, confidence, baseLoad }, tornado: { id, rows }, generatedAtMs }
```
`onPartial(stage, partialVerdict)` is called after: 'usage', 'plugin', 'all', 'bands', 'answers'.

## 16. Worker protocol — worker.js / engine.js (U0 builds the transport; engine methods are B1's)

Main → worker:
- `{ type: 'call', id, method, args }` · `{ type: 'cancel', id }`
Worker → main:
- `{ type: 'progress', id, value }` · `{ type: 'result', id, value }` · `{ type: 'error', id, error }`

Worker methods (whitelist): `loadDataset(spec)` → `DatasetSummary` (builds and keeps the Dataset and a
`SolarEngine` inside the worker; the API key never leaves the worker except to api.octopus.energy),
`insights()`, `runScenario(system, opts)`, `autoScenarios(opts)`, `verdict(opts)` (progress = partial
verdicts), `orientationSweep(system, arrayId)`, `baseLoadCurve(ids|systems, xs)`, `panelCountCurve(system)`,
`batterySizeCurve(system)`, `typicalDay(system, which)`, `exportCsv(system)`, `setProjectBaseW(w)`,
`normalizeSystem(partial)`, `validate(system)`, `applyFix(system, action)`, `catalog()`.

```js
// engine.js
export function createEngine({ inThread = false } = {}): EngineClient
// EngineClient { call(method, ...args): Promise & { cancel() }, onProgress(id, fn), terminate(), mode: 'worker'|'inline' }
// call(method, ...args, { onProgress }) — if the last arg is an object with only onProgress, it is the options bag.
```
Worker is `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`; fallback inline
(dynamic import of the same dispatcher) when module workers are unavailable. Results are plain
structured-clone data (typed arrays allowed). Functions never cross.

## 17. store.js (U0)

```js
export const store = {
  get(): State, set(patch: Partial<State>), update(key, fn), subscribe(fn, keys?): () => void,
}
// State { version: 1,
//   connection: { kind: null|'octopus'|'demo'|'csv'|'manual', accountNumber, rememberKey: false, location: { postcode, lat, lon }, demoServerW: 500, manual: { baseW, otherKwhYr }, installedSolarDate: null, priceBasis: 'mine', flatP: null },
//   dataset: DatasetSummary|null,   // not persisted
//   settings: { finance: Partial<DEFAULT_FINANCE>, projectBaseW: null, spots: MountSpot[], vatReturns: true, maxPaybackYears: 10 },
//   scenarios: { saved: System[], pinned: string[], activeId: null },
//   ui: { tab: 'verdict', designMode: 'simple', chartTables: {} } }
export function getApiKey(): string|null; export function setApiKey(key, remember): void; export function clearApiKey(): void
```
Persistence: localStorage `solar-calculator:v1` (everything except `dataset`); key in
`solar-calculator:key` only when `rememberKey`, else sessionStorage. All storage access in try/catch.

## 18. App shell / views (U0 shell; C agents views)

```js
// views/<id>.js
export default { id, title, mount(el, ctx), show?(params), hide?(), unmount?() }
// ctx { store, engine: EngineClient, ui, charts, fmt, router: { go(tab, params), params() }, data: DataHub }
// DataHub (app.js): { summary(): DatasetSummary|null, insights(): Promise<Insights>, verdict({ onPartial }): Promise<Verdict>,
//   scenario(system, opts): Promise<ScenarioResult>, autoScenarios(): Promise<System[]>, invalidate(reason), on(event /*'dataset'|'settings'|'scenarios'|'verdict'*/, fn): off,
//   load(spec, { onProgress }): Promise<DatasetSummary> }
```
Routes: `#verdict #usage #compare #design?scenario=<id> #orientation?scenario=<id> #method #data`.
Every view handles "no dataset" by rendering `ui.connectCard(ctx)` (U0 provides it; the Data view owns
the full connect flow but the card is shared).

## 19. ui.js (U0)

```js
export function h(tag, attrs?, ...children): HTMLElement   // attrs: class, style (object), on: { evt: fn }, dataset, aria-*, any attr; children: Node|string|null|array
export function statTile({ label, value, unit, sub, tone /*'default'|'accent'|'good'|'warn'|'bad'*/, help }): HTMLElement
export function card({ title, subtitle, actions, body, accent = false, id }): HTMLElement
export function field({ label, hint, input, inline }), numberInput({ value, min, max, step, unit, onChange }), textInput({...}),
  select({ options: [{ value, label, group? }], value, onChange }), segmented({ options, value, onChange }), toggle({ label, checked, onChange }),
  compassInput({ azimuth, onChange, size = 200 }), slider({ value, min, max, step, onChange, format })
export function table({ columns: [{ key, label, align, format, sortable, width }], rows, sortKey, onRowClick, rowClass, emptyText }): HTMLElement  // card list ≤600px
export function details({ summary, body, open, id }), badge({ text, tone }), tooltip(el, text),
  toast(message, { tone, timeoutMs }), modal({ title, body, actions }) /* → { close } */, skeleton({ lines, height }),
  progressList(steps: [{ key, label }]) /* → { el, set(key, status, detail) } */, connectCard(ctx), emptyState({ title, body, action })
export const fmt = { gbp(v, { dp = 0 }), gbpFromP(p, { dp }), p(v /*p/kWh*/), kwh(v), w(v), pct(v), years(v /*null → 'never'*/), date(ms), month(key), compass(az /*16-point*/), num(v, dp) }
```

## 20. charts.js (U0)

All charts: `create<Type>(el, spec) → { update(spec), destroy(), setTable(bool) }`. Canvas with DPR
scaling, ResizeObserver, HTML tooltip layer, keyboard focus (arrow keys move the hover), a table-view
twin (toggle button rendered by the chart), colours from CSS custom properties (`--series-pv`, `--series-load`,
`--series-import`, `--series-export`, `--series-battery`, `--series-price`, `--series-clipped`, `--series-muted`,
route colours `--route-plugin|hardwired|ups|whatif|reference`). No dual axes ever.

```js
createLine(el, { x: { values, format, label, type: 'category'|'linear'|'time' }, y: { label, format, min, max, zero }, series: [{ key, label, color, values, dash, area }], bands: [{ from, to, label }], markers: [{ x, label }], height })
createStackedArea(el, same + { series stacked in order })
createBars(el, { categories, series: [{ key, label, color, values, outline }], stacked, horizontal, y, height })
createHeatmap(el, { rows, cols, values: Float32Array, rowLabels, colLabels, scale: { min, max, ramp: 'sequential'|'diverging' }, format, height })
createPolar(el, { azimuths, tilts, values /*az-major*/, markers: [{ az, tilt, label, kind }], format, onPick(az, tilt) })
createScatter(el, { points: [{ x, y, label, color, whisker: [lo, hi], emphasis }], x, y, isolines: [{ points: [[x,y]...], label }], front: [[x,y]...], height })
createTornado(el, { center, centerLabel, rows: [{ label, low, high, lowLabel, highLabel }], format })
```
Validate the series palette with the dataviz validator (dark surface) and record the result in a CSS comment.

## 21. Ownership & files

| Agent | Files it owns (creates) | Tests (lib/slopnet/__tests__/) |
|---|---|---|
| A1 physics | js/time.js, js/vat.js, js/sun.js, js/weather.js, js/pv.js | solar-time, solar-vat, solar-sun, solar-weather, solar-pv |
| A2 data | js/dataset.js, js/octopus.js, js/csv.js, js/demo.js, js/cache.js, data/demo.json, data/kits.json, data/stations.json, data/bundles.json, data/constants.json, scripts/build-demo.mjs (dev-only) | solar-octopus, solar-csv, solar-dataset, solar-demo |
| A3 economics | js/system.js, js/battery.js, js/simulate.js, js/finance.js, js/insights.js | solar-battery, solar-simulate, solar-finance, solar-insights |
| U0 UI foundation | index.html, css/style.css, js/ui.js, js/charts.js, js/store.js, js/engine.js, js/worker.js (dispatcher), js/map.js, js/app.js, views/_template.js, gallery.html (dev page showing every component/chart with fake data) | solar-store (node, localStorage stub) |
| B1 decision | js/core.js, js/kits.js, js/rules.js, js/scenarios.js, js/sweep.js | solar-core, solar-rules, solar-scenarios, solar-sweep, solar-acceptance (T1–T8 on demo.json) |
| C agents | js/verdict.js + js/views/verdict.js; js/views/usage.js; js/views/design.js; js/views/orientation.js; js/views/compare.js; js/views/data.js + js/views/method.js | solar-verdict (verdict agent) |

Fixtures: `lib/slopnet/__tests__/fixtures/solar/<agent-prefix>-*.json`, each < 150 kB.
Never edit a file you don't own; if you must, stop and report what you need instead.
