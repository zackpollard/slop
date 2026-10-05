# solar-calculator — build spec

> Binding companions: `AMENDMENTS.md` (accepted critique amendments; they win over this file) and
> `CONTRACTS.md` (module signatures). Same directory.

Project dir: `projects/solar-calculator/` in the slop monorepo. Worktree root:
`/home/zack/Source/slop/.claude/worktrees/solar-calculator` (branch `feat/solar-calculator`).
Live URL will be `https://solar-calculator.slop.zackpollard.pro`.

Research (verified live on 2026-10-05) lives in `/home/zack/.claude/jobs/52762e7f/tmp/research/`.
Read the relevant `REPORT-*.md` and `VERIFY-*.md` (verifier corrections WIN over the report)
before implementing a module. Reference implementations you should port (not import) from:

| Reference | What it is | Status |
|---|---|---|
| `research/pv-reference-verified.js` | NOAA sun position, Perez/Hay-Davies/Muneer, IAM, Faiman, PVWatts DC+inverter (+`inputMaxAc` per-input AC caps), Huld/HULD_CSI_2025, bifacial, horizon, clear-sky split | Tested vs pvlib (≤1e-11 W/m²) and PVGIS (±0.7%). Use THIS, not `pv-reference.js` |
| `research/weather-align-reference.mjs` | Open-Meteo SARAH-3 + MSG + archive fetch & alignment to Octopus slots | Reproduces Python pipeline within 0.5 W/m² |
| `research/agile-econ/dispatch.mjs` | Slot physics (DC/AC coupled), DP + rolling horizon, rule controllers | Benchmarked; one bug: Int8Array policy overflow (use Int16Array) |
| `research/plugin-kits-verified.json` | 29-entry UK kit catalog (verified) | Use verified copy, not `plugin-kits.json` |
| `research/ups/power-stations-verified.json` | power station catalog (if present; else `power-stations.json`) | |
| `research/plugin-market-constants.verified.json` | legal limits, install costs, export tariff codes | |
| `research/agile-C-12m.json`, `research/demo-london-12m-halfhourly.json` | real 12-month London prices + aligned irradiance | demo + test fixtures |
| `research/pvgis-fixtures.json`, `research/pvlib-reference-values.json` | validation fixtures | tests |

## 0. Purpose (the user's words, paraphrased)

UK homeowner on **Octopus Agile** (half-hourly prices). Servers run 24/7 → high constant base
load. Considering **plug-in solar** (panels + 800 W micro-inverter into a socket) possibly with a
**battery**, and wants *data* before buying: use their **real half-hourly consumption** (Octopus
API) and the **real Agile prices** for the same half-hours, plus **historical weather for their
location**, to simulate what each kit / orientation / battery combination would have saved, and
the payback. They suspect pointing panels **west / vertical** to generate into the **16:00–19:00**
Agile peak might beat south in £ even while losing kWh — the tool must answer that with their data
(research says: with everything self-consumed S/SSW usually wins, W90 earns ~20% more per kWh but
makes 30–48% less; but the 800 W cap, oversizing to 2000 Wp, base load level and export tariff can
change the answer — the tool must show it, not assume it). "All of this and more."

## 1. Facts the product must respect (verified, Oct 2026)

**Regulation (GB):**
- Plug-in solar legal since **27 Aug 2026** (SI 2026/848 + DESNZ IPS v2.0 + G98 amendment).
  Limits: **≤800 VA AC** (3.5 A), **≤2000 Wp DC**, ≤4 modules (≤2 in series), complete
  ENA-listed kit only, **one device per household**, register at myplugin.solar, BS 1363 socket,
  no extension leads; professional check advised >960 Wp.
- **Plug-in batteries are prohibited** (SI definition limb (e), IPS scope, Ofgem decision). Any
  grid-tied battery = **hardwired G98** install by an electrician (default £350, range £150–600,
  +£400–900 if consumer unit needs replacing). Hardwired G98 total ≤16 A/phase (≈3.68 kW).
  Octopus hopes plug-in batteries arrive early 2027 → offer a clearly-flagged "what-if" mode.
- A **portable power station used like a UPS** (charges from a socket, powers the servers from its
  own outlets, never runs in parallel with the grid) is outside G98 — a legal way to shift the server
  load (see `research/REPORT-ups.md` + `VERIFY-ups.md`; catalog `research/ups/power-stations-verified.json`).
- Export: statutory SEG needs MCS → **plug-in export is unpaid by default**. Exception: Octopus's own
  kits (£450 1×460 W, £650 2×460 W) unlock Octopus export tariffs incl. **Outgoing Prime**
  (16p 16:00–19:00 local, 9p otherwise) — compatible with Agile import (verified).
- Installer-supplied panels/batteries: 0% VAT (to 31 Mar 2027); DIY kit prices include 20% VAT.

**Octopus API** (all CORS `*`, Basic auth `btoa(key + ':')`, never `credentials:'include'`):
- Account: `GET /v1/accounts/{A-XXXXXXXX}/` (regex `^A-[0-9A-Z]{8}$` after trim+uppercase; malformed →
  HTML 404). Pick property with `moved_out_at === null` (latest `moved_in_at`). Import MPAN
  `is_export:false`; meters[] may include replaced/non-smart meters; agreements[] with
  tariff_code/valid_from/valid_to (mixed `Z`/`+01:00` offsets, null = open).
- Key-only discovery (optional): GraphQL `obtainKrakenToken(input:{APIKey})` then
  `viewer{accounts{number}}`; errors come as HTTP 200 + `errors[]`.
- Consumption: `/v1/electricity-meter-points/{mpan}/meters/{encodeURIComponent(serial)}/consumption/?period_from&period_to&page_size=25000&order_by=period`
  kWh per half-hour; `consumption` may be a string → `Number()`; interval_start has local offsets
  (normalise `+0100` → `+01:00`); overlap semantics → dedupe by epoch ms; missing slots are absent;
  last 1–2 days unreliable; merge multiple serials by slot (never sum duplicates; active meter wins).
- Unit rates: `/v1/products/{P}/electricity-tariffs/{T}/standard-unit-rates/?period_from&period_to&page_size=1500`
  (page_size capped 1500, always newest-first, follow absolute `next`; year = 12 requests);
  use URLSearchParams (a raw `+` breaks); `payment_method` null for Agile, DD/NON_DD duplicates for
  flat tariffs (prefer `DIRECT_DEBIT`, then null). Expand interval records onto the half-hour grid.
- **VAT**: compute inc-VAT yourself from `value_exc_vat` with a schedule:
  5% until `2026-09-30T23:00Z`, 0% until `2027-03-31T23:00Z`, then 5% (configurable). The API's
  `value_inc_vat` on long/open records (standing charges) is retroactively wrong.
- Always price with the **user's agreement tariff codes** (Agile versions differ: caps 35p/55p/78p/100p;
  standing charges differ). Region: tariff-code suffix → `GET /v1/electricity-meter-points/{mpan}/`
  (`gsp`, public) → `GET /v1/industry/grid-supply-points/?postcode=` (public). Never from MPAN prefix.
- Current products: Agile import `AGILE-24-10-01`; Agile Outgoing `AGILE-OUTGOING-19-05-13`
  (floor 0, no VAT); Outgoing fixed `OUTGOING-VAR-24-10-26` (15p → 12p from 2026-03-01);
  Outgoing Prime `OUTGOING-PRIME-FIX-12M-26-06-23` (no rows before 2026-06-23 → synthesise by
  local clock for earlier history); Flexible `VAR-22-11-01`. Discover the newest Agile at runtime from
  `/v1/products/?brand=OCTOPUS_ENERGY&is_variable=true` (`code` starts `AGILE-`, direction IMPORT
  from the list endpoint only).
- Agile day runs 23:00→23:00 local; next-day prices publish ~16:00 (16:00–20:00).
- Region letters: A Eastern, B East Midlands, C London, D Merseyside & N Wales, E West Midlands,
  F North East, G North West, H Southern, J South East, K South Wales, L South West, M Yorkshire,
  N South Scotland, P North Scotland.

**Weather (Open-Meteo; CORS `*`; free non-commercial; attribution required):**
- Primary irradiance: `https://satellite-api.open-meteo.com/v1/archive?...&models=eumetsat_sarah3&temporal_resolution=native&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation&timezone=GMT&timeformat=unixtime`
  (30-min, ~3 days latency). **Always pass `models=` explicitly** (omitting it silently returns IFS);
  check response lat/lon sit on a 0.05° grid. One model per request.
- Gap/tail fill: same with `models=eumetsat_lsa_saf_msg` (15-min, since 2025-01-01, ~2 h latency;
  daytime nulls = missing; night DNI/DHI null → 0/GHI).
- Temperature/wind + final fallback radiation: `https://archive-api.open-meteo.com/v1/archive?...&models=ecmwf_ifs&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation,temperature_2m,wind_speed_10m&wind_speed_unit=ms&timezone=GMT&timeformat=unixtime`
  (explicit `models=`; IFS radiation reads ~+7% high vs ground truth → when IFS is used as the
  radiation fallback multiply GHI/DHI by 0.93 and record it in `wxSource`).
- **The SARAH-3 labelling rule is ONE shared decision** (it moves W90 yield ~6.6% and 16–19 energy ~8%):
  weather.js produces Octopus-aligned slot means using the verified rule; pv.js consumes those slot
  means as covering exactly [S, S+30) and never re-interprets labels. Gap-fill MSG → IFS; never zero-fill.
- Alignment to Octopus slot [S, S+30): SARAH-3 label **S** scaled by `mcz(S,S+30)/mcz(S−30,S)` for
  GHI/DHI (DNI unchanged; clamp factor ≤3; sunrise rule per report); MSG mean of labels S+15,S+30;
  archive hourly label H=floor_hour(S)+1h disaggregated by mean-cosZ ratio; temperature & wind
  linearly interpolated at S+15. Request `end_date` = last day + 1 (≤ today UTC). Detect SARAH-3's last
  valid slot at runtime. A 200 response with a text body is an error.
- Attribution footer: "Weather data by Open-Meteo.com (CC BY 4.0). Solar radiation © EUMETSAT, CM SAF
  SARAH-3 (doi:10.5676/EUM_SAF_CM/SARAH/V003) and LSA SAF; temperature/wind ECMWF IFS."
- Climatology for "typical year": `daily=shortwave_radiation_sum&models=eumetsat_sarah3&start_date=2006-01-01&end_date=2025-12-31`
  → per-month mean (fill null days with that month's mean — never sum nulls as 0) → per-month
  scale factors (last 12 months were +12% sunnier in London, +32% July, −14% Oct).
- Postcode → lat/lon: `https://api.postcodes.io/postcodes/{postcode}` (CORS) — verify CORS when
  implementing; fall back to map click / manual lat-lon.

**PV physics defaults** (from `REPORT-pv.md` §0/§11 as corrected by `VERIFY-pv.md`): NOAA sun position
(apparent zenith), Perez 1990 (albedo 0.2; `groundSelfShade` when building/railing-mounted), Martin-Ruiz
IAM a_r 0.16 (+ diffuse variants), Faiman (26.9/6.2 free-standing; 20/3.2 building; ~24/5 railing;
~21/3.5 flush wall), PVWatts DC with γ from panel (default −0.30%/K TOPCon) + low-light k 0.0064 (≈ PVGIS
crystSi2025; offer `HULD_CSI_2025` as an alternative DC model), DC loss ≈ 5.9% multiplicative **plus a
shading loss input that defaults to 3%** (balcony/garden installs are rarely unshaded), degradation 1% yr1
then 0.4%/yr, PVWatts inverter curve (η_nom 0.96 weighted; 0.965 for Hoymiles; use peak−0.5pt if only
peak is known), per-MPPT DC caps **and per-input AC caps** (dual-input micros behave as 2 × 400 W channels),
AC cap 800 W, optional bifacial φ with rear shading, horizon profile (sector elevations) + beam/diffuse
shading fractions. Sub-samples: 3 per half-hour (at +5, +15, +25 min) with the clear-sky-index split
preserving the slot mean; run the AC chain incl. clipping per sub-sample then average (matters for
vertical/E/W planes; ~no difference for S35). Sweeps may use 1 sub-sample. Expected accuracy to state in
the UI: ±20–27% per half-hour, ~±1–2% annual bias from irradiance; plus weather-year variability (below).

**Weather-year variability.** The last 12 months in London were ~12% sunnier than the 2006–2025 mean.
Payback must not rest on one year: (a) "typical year" per-month scaling from the SARAH-3 daily
climatology (cheap, one call), and (b) on demand, re-run the simulation with each of the previous
N (default 5) years of SARAH-3 + IFS weather mapped onto the dataset's calendar (same month/day/slot,
Feb 29 handled) and show a min/median/max band for savings and payback. Note in the UI that swapping
weather years breaks the sunny-day ↔ cheap-price correlation (~4% optimistic on value per kWh).

**Orientation reality check (verified, 2025-26 SARAH-3 + Agile C, 2×400 Wp all self-consumed):** SSW45
£165, SW45 £164, S45 £161.5, W45 £143.5, W90 £114, E90+W90 split £104. The tool must reproduce this
class of result from the user's own data and make the trade-off legible (kWh lost vs p/kWh gained), and
show where the answer flips (e.g. low base load → more export; Outgoing Prime paying 16p at peak;
oversized DC on an 800 W cap; battery present).

**Agile economics** (REPORT-agile + VERIFY-agile): negative import prices exist (~2.8% of slots, mid-day)
— never clamp; PV displacing import in a negative slot is a small loss. DP with N=41 SoC levels is
within 0.7% of N=321 and runs ~70 ms/yr; use N=41 for sweeps, 81–101 for headline figures. Rolling
horizon re-plan at 16:00 (or conservative 20:00) over [replan, 23:00 next day), commit 24 h, terminal
value = median(horizon price)·η_d·η_inv. Wear cost 2p/kWh in the DP objective only (tie-breaker);
**exclude wear from reported £** (battery cost is capex). Battery standby default 10 W (counts!).
Base load = median over days of mean of each day's 4 lowest positive half-hours (all 48 slots, drop
days <44 slots); cross-check with the 5th percentile.

## 2. Repo conventions (hard rules)

- Static HTML/CSS/JS, **no build step, no npm in the shipped app**, CDN-only externals (cdnjs
  preferred). Leaflet from cdnjs like `projects/roof-calculator`.
- Dark theme, accent `#c4a24e`, Inter (body) + JetBrains Mono (numbers/labels) via Google Fonts.
- Layout like `projects/dnd-banners/` & `projects/pub-quiz/`: `index.html`, `css/`, `js/`, `data/`.
- **Engine modules are pure ES modules**: no DOM, no `window`/`document`/`localStorage` at import time or
  inside engine functions (they run in a Web Worker and in vitest/node). Fetching modules take an
  injectable `fetch` (default `globalThis.fetch`).
- Tests: vitest in `lib/slopnet/` (`cd lib/slopnet && npm test`). Engine tests go in
  `lib/slopnet/__tests__/solar-*.test.js`, importing via `../../../projects/solar-calculator/js/...`.
  Fixtures in `lib/slopnet/__tests__/fixtures/solar/` (keep them small: trim to what tests need;
  gzip is not available — prefer a few days / a month of data, or derive synthetic data in-test).
  The existing 724 tests must keep passing.
- Code style: match `projects/dnd-banners/js/*` — small focused modules, JSDoc on exported functions,
  no frameworks. Comments explain *why* (physics conventions, API quirks), not what.

## 3. Architecture

```
projects/solar-calculator/
├── index.html            app shell (single page, tabbed views); CSP meta; attribution footer
├── README.md
├── css/style.css         design tokens + components
├── data/demo.json        compact real 12-month London Agile + aligned weather for demo mode
└── js/
    ├── time.js           UK DST + slot helpers (no Intl dependency in hot paths)
    ├── vat.js            VAT schedule
    ├── sun.js            sun position, extraterrestrial, airmass, clear-sky, cos-zenith means
    ├── weather.js        Open-Meteo fetch (SARAH-3/MSG/archive), alignment, climatology
    ├── pv.js             sky precompute (orientation-independent), POA, IAM, temp, DC, inverter
    ├── octopus.js        REST client: account discovery, consumption, rates, standing charges, region
    ├── csv.js            consumption CSV import (Octopus export + generic)
    ├── demo.js           synthetic household load (server base load + household profile), seeded
    ├── dataset.js        orchestrates sources → aligned Dataset; gap filling; quality report
    ├── cache.js          IndexedDB cache (graceful no-op when unavailable)
    ├── battery.js        slot physics (dc/ac/ups), rule controllers, DP + rolling horizon
    ├── simulate.js       System × Dataset → SimResult
    ├── finance.js        lifetime cash flows, payback, NPV, IRR, LCOE/LCOS
    ├── insights.js       usage analysis: base load, peak share, profiles, heatmaps, tariff compare
    ├── sweep.js          orientation sweep, panel-count & battery-size curves, kit ranking
    ├── kits.js           catalog (from verified research JSON) + kit → System mapping
    ├── rules.js          legal-envelope checks → warnings/errors per System
    ├── worker.js         module Web Worker hosting the engine (dataset cached in worker)
    ├── engine.js         promise client for worker.js (falls back to in-thread)
    ├── store.js          app state + persistence (localStorage for settings; cache.js for data)
    ├── ui.js             DOM helpers & components (stat tile, field, segmented, toast, modal...)
    ├── charts.js         canvas chart primitives (themed, tooltips, table-view twins)
    ├── map.js            Leaflet location picker + per-array azimuth handle
    ├── app.js            bootstrap, tab routing (hash), wiring
    └── views/
        ├── data.js       Data tab
        ├── usage.js      Usage tab
        ├── design.js     Design tab
        ├── orientation.js Orientation tab
        ├── compare.js    Compare tab
        └── method.js     Method & assumptions tab (+ export)
```

### 3.1 Core types (JSDoc typedefs in the owning module)

Units: energy **kWh per slot**, power **W**, prices **p/kWh** (inc VAT unless the name says Exc),
money **pence** internally (format to £ at the UI edge). Slot Δt = 0.5 h. Time = **UTC epoch ms**
of slot start aligned to :00/:30.

```js
/** Dataset — built once by dataset.js; immutable afterwards. Transferable to the worker. */
{
  start, n,                 // slot 0 start (ms UTC), slot count
  lat, lon,
  load: Float64Array,       // kWh/slot household demand (import meter, pre-solar)
  loadFilled: Uint8Array,   // 1 = gap-filled slot
  importPrice: Float64Array,// p/kWh inc VAT as billed (per VAT schedule)
  exportPrice: Float64Array,// p/kWh for the chosen export tariff (0 if none)
  ghi, dni, dhi: Float32Array, // W/m² slot means, Octopus-aligned
  tempC, windMs: Float32Array, // at slot midpoint
  wxSource: Uint8Array,     // 0 SARAH-3, 1 MSG, 2 IFS archive, 3 demo
  local: { hh: Uint8Array /*0..47 wall clock*/, day: Int32Array /*local day idx*/,
           month: Uint8Array /*0..11*/, dow: Uint8Array /*0=Mon*/, peak: Uint8Array /*16:00–19:00*/ },
  days: [{ date: 'YYYY-MM-DD', first, count }],
  monthScale?: Float64Array(12), // typical-year irradiance factors (1 = actual)
  meta: { source: 'octopus'|'csv'|'demo'|'manual', region, importTariffs: [{code, from, to}],
          exportTariff: {kind, code?}, standingChargePPerDay, vat, weather: {...}, quality: {...}, notes: [] }
}

/** PvArray — one plane of panels on one MPPT input (or a string). */
{ id, name, count, wp, tilt /*deg*/, azimuth /*deg compass: 0 N, 90 E, 180 S, 270 W*/,
  mounting: 'open'|'roof'|'railing'|'wall', groundSelfShade: boolean, albedo: 0.2,
  tempCoeffPct: -0.30, bifaciality: 0, rearShading: 0.6, dcModel: 'pvwatts'|'huld2025',
  shadingPct: 3 /* lumped default loss */, beamShadingPct: 0, diffuseShadingPct: 0,
  horizon: number[] /* sector elevations from N, may be [] */,
  mppt: 0 /* inverter input index this array is wired to; validate < inverter.mppts.length */ }

/** System */
{
  id, name, route: 'plugin'|'hardwired'|'ups'|'whatif',
  inverter: null | { acLimitW: 800, mppts: [{ maxDcW, maxAcW /* per-input AC cap, e.g. 400 on HMS-800 */ }],
                     etaNom: 0.96, standbyW: 0 },
  arrays: PvArray[],                       // arrays wired to the grid-tied inverter
  battery: null | {
    coupling: 'dc' /*behind the PV inverter, shares acLimitW*/ | 'ac' /*own inverter on house bus*/ | 'ups' /*serves dedicated load only*/,
    usableKwh, minSocPct: 10, maxChargeW, maxDischargeW, acChargeW /*0 = no grid charging*/,
    effCharge: 0.96, effDischarge: 0.96, acChargeEff: 0.93,      // dc
    acEffCharge: 0.92, acEffDischarge: 0.92, acOutputW,           // ac & ups
    standbyW: 10,
    ups: { dedicatedW: 'baseload'|number, outletMaxW, pvArrays: PvArray[], pvMaxDcW },  // ups only
    strategy: 'self'|'fixed'|'schedule'|'smart'|'optimal',
    fixedOutputW, schedule: { chargeBelowP: 12, chargeWindow: ['23:00','07:00'], dischargeWindow: ['16:00','19:00'], dischargeAboveP: null },
    replanAt: '16:00'|'20:00', wearPPerKwh: 2, socLevels: 41,
  },
  curtailWhenNegative: false,              // only if the inverter supports scheduled output limits
  export: { kind: 'none'|'prime'|'fixed'|'agile'|'flat', flatP?: number },
  costs: { items: [{ label, gbp }] },      // capex lines (kit, extra panels, mounts, electrician, meter…)
  finance?: { overrides },
}

/** SimResult (energies kWh, money pence) */
{
  slots: { pvAc, clipped, selfUse, gridImport, gridExport, gridCharge, battIn, battOut, soc, curtailed, savingP } /* Float32Array each */,
  totals: { days, loadKwh, pvDcKwh, pvAcKwh, clippedKwh, curtailedKwh, selfUseKwh, exportKwh, importKwh,
            baselineCostP, newCostP, savingsP, exportIncomeP, gridChargeKwh, battInKwh, battOutKwh,
            battCycles, standbyKwh, selfConsumptionPct, selfSufficiencyPct,
            pvValuePPerKwh /*savings attributable per pvAc kWh*/, peakGenSharePct, peakImportCutPct },
  annual: { ...totals ×365/days },
  monthly: [{ key: 'YYYY-MM', days, loadKwh, pvAcKwh, exportKwh, clippedKwh, baselineCostP, newCostP, savingsP }],
  profile: { load, pvAc, gridImport, gridExport, battNet, importPrice, savingsP } /* 48-slot local means */,
  byMonthProfile: { pvAc: Float32Array(12*48) },   // for the "peak share by month" chart
  warnings: string[],
}
```

### 3.2 Engine semantics

**Baseline vs new cost.** baseline = Σ load·importPrice. new = Σ import·importPrice − export·exportPrice
(grid charging is part of import). savings = baseline − new. Standing charges excluded from savings
(shown in bills only). Standby draws (battery, power station idle, inverter night draw) are part of
`new` load. Annualise by ×365/days.

**PV pipeline (pv.js).** `prepareSky(ds, {subSteps})` precomputes, per slot × sub-sample: apparent
zenith cos/sin, sun azimuth, extraterrestrial DNI, airmass, the sub-sample GHI/DNI/DHI from the
clear-sky-index split, Perez F1/F2 (orientation-independent), cell-temp inputs. Then
`arrayDc(sky, ds, array)` → Float32Array(n·subSteps) DC W per sub-sample (POA → IAM → shading/horizon
→ bifacial → Faiman → PVWatts DC → DC losses; degradation applied in finance, not here).
`inverterAc(dcSub[], inverter, subSteps)` → { dcKwh, acKwh, clippedKwh } per slot (per-MPPT DC caps →
PVWatts efficiency → AC cap per sub-sample → averaged ×Δt). Orientation sweep re-uses `sky`.

**Battery (battery.js).** Port `slotDC`/`slotAC` from `dispatch.mjs` and add `slotUPS`:
- UPS = battery + inverter with its own outlets serving a dedicated load D_t = min(L_t, dedicatedW·Δt)
  (dedicatedW: 'baseload' → estimated base load). Sources for D: own PV (DC → inverter), battery,
  grid bypass. Charging: own PV first (otherwise wasted), then grid (≤acChargeW, acChargeEff). Never
  exports; surplus own PV is wasted; battery output ≤ D and ≤ outletMaxW. Idle draw always (from grid).
  House bus: g = (L−D) + D_bypass + gridChargeAC − pvAC_gridTied.
- Any battery coexists with the grid-tied PV unit; dc coupling shares the PV inverter's AC cap.
- Strategies: `self` (follow load / zero export; ups: discharge whenever it can serve D, charge only
  from own PV), `fixed` (constant output W), `schedule` (TOU rules; ups: the "smart plug cuts AC input
  during 16–19" pattern), `smart` (rolling DP; label "assumes PV forecast is perfect over ~31 h"),
  `optimal` (full-horizon DP; label "upper bound").
- DP: policy array Int16Array; N from `socLevels`; terminal value per spec §1; report wear separately.

**Finance (finance.js).** Year y = 1..Y (default 20; inverter replace year 12 £150 if micro; battery EOL
at 70% SoH or 15 y). Sav_y = [Sav_pv·deg_pv(y) + Sav_batt·SoH_y/SoH_1]·(1+e)^(y−1) − O&M; where
Sav_batt = savings(system) − savings(system without battery) (marginal). Discount r 4% nominal, e 2%;
toggles: VAT returns to 5% from Apr 2027 (×1.05 on future prices if historical basis was 0%... keep
simple: apply VAT ratio by year). Outputs: simple & discounted payback (interpolated), NPV, IRR
(bisection on [−0.99, 1], "n/a" if no bracket), lifetime savings, ROI, LCOE (PV), LCOS (battery),
cumulative cash-flow series for charting.

**Insights (insights.js).** Base load (W, p10/p90, monthly medians, kWh/yr, £/yr at the user's prices,
£ in 16–19), share of kWh and £ in 16–19, average daily load profile vs average price profile (48),
load-weighted average price vs time-weighted mean (how well the user already shifts), heatmaps
(day × 48) for load and price, monthly bills (energy + standing), Agile vs Flexible comparison if
Flexible rates are fetched, negative-price slot count & money earned/lost.

**Sweeps (sweep.js).**
- `orientationSweep(ds, sky, system, arrayId, {azStep:10, tiltStep:5, strategy})` → grid of
  {az, tilt, acKwh, savingsP, valuePPerKwh, peakSharePct} (use `self`/no-battery for speed; with a DP
  battery use the `fixed`/`self` proxy and label it).
- `panelCountCurve` (1..max allowed by route), `batterySizeCurve` (0..N kWh), `kitRanking(catalog)`
  — each a list of {x, savingsP, capexGbp, paybackYears, npv}. Marginal £/yr per extra panel / kWh.
- Splits: E/W or SW/W split of an even panel count across two MPPTs.

**Rules (rules.js).** Validate a System against its route; return `{errors[], warnings[]}`:
plugin → acLimit ≤800, DC ≤2000 Wp, ≤4 modules, no battery (error unless route 'whatif'), >960 Wp
warning (professional check), one device; hardwired → total AC ≤3680 W, electrician cost line
required; ups → not grid-tied, dedicated load ≤ outlet rating; whatif → banner "not legal in GB
today (Oct 2026)". Export 'prime' only valid with an Octopus kit (warn otherwise).

## 4. UI

Single page, tabs (hash-routed): **Data · Usage · Design · Orientation · Compare · Method**. Sticky
header: app name, dataset status chip (source, date range, region, location), scenario picker.
Responsive down to 375 px. Keyboard accessible. Every chart has a table-view twin (dataviz rule).

1. **Data** — connect, in order of preference:
   (a) Octopus: API key (+ account number; or "find my account" via GraphQL), remember-on-this-device
   checkbox (default off; key in memory/sessionStorage otherwise), privacy note (key only ever sent to
   api.octopus.energy); discovered property/MPAN/serial/tariff history shown for confirmation.
   (b) CSV upload (Octopus "Download your data" CSV + generic `start,kWh`).
   (c) Demo (bundled real London data + synthetic household with configurable server load).
   (d) Manual profile (base load W + other annual kWh + profile shape).
   Location: postcode (from account or typed) → lat/lon; or map click (Leaflet satellite tiles like
   roof-calculator). Date range (default the last 365 complete days with data; max 2 years).
   Import price basis (your tariff history | Agile current | Flexible | flat p), export tariff,
   VAT treatment, weather year (actual | typical-year per-month scaling). Fetch button with per-source
   progress + quality summary (coverage %, gap-filled slots, weather source mix, latency notes).
2. **Usage** — headline: base load W and its annual £ ("your always-on load costs £X/yr; £Y of it
   between 4 and 7pm"); 16–19 share; load vs price profile (two stacked charts sharing x, NOT dual
   axis); heatmaps; monthly bill bars; negative-price slots; Agile vs Flexible.
3. **Design** — scenario editor: start from a catalog kit or blank; route selector (plug-in /
   hardwired / UPS / what-if) with rules feedback; arrays (count, Wp, tilt, azimuth with compass dial
   + "pick on map", mounting, shading/horizon, bifacial); inverter; battery & strategy; export
   tariff; costs. Live results: annual £ saved, payback, NPV, IRR, generation, self-consumption,
   clipped/curtailed/exported/wasted kWh, value per kWh, 16–19 share; typical-day charts (pick any
   date; summer/winter quick picks) showing load / PV / battery / grid; monthly savings; cumulative
   cash flow; "what the battery adds" (marginal).
4. **Orientation** — the "solar rose": polar heatmap, azimuth around, tilt as radius (flat centre,
   vertical edge); metric toggle (£ saved | kWh | p per kWh | 16–19 share); markers for best £, best
   kWh, current; click to apply. Hour-of-day generation comparison of current vs best-£ vs best-kWh
   vs W90; monthly 16–19 share (note: no 16–19 sun Nov–Feb). Split-orientation comparisons.
5. **Compare** — kit leaderboard (catalog incl. availability, route, editable price) ranked by
   payback/NPV/10-yr savings using the user's orientation; panel-count and battery-size curves with
   marginal value vs marginal cost; saved scenarios side by side (table + bars).
6. **Method** — assumptions & sources (physics chain, data sources & attribution, regulation summary
   with dates & links, known limitations: perfect-foresight labels, 30-min clipping, satellite
   accuracy ±, weather-year variability), export (CSV of half-hourly results; JSON of settings/
   scenarios — never including the API key), reset.

Design language: dark (#0f0f0c page, #1a1a16 surfaces, #2e2e24 borders, #e8e4d4 text, #9a9686 muted),
accent #c4a24e; Inter + JetBrains Mono; data-dense but calm; stat tiles with proportional figures,
tables with tabular-nums. Fixed semantic series colours (validate with the dataviz validator against
the dark surface): solar/PV, load, grid import, export, battery, price — consistent in every chart.
No dual-axis charts. CSP meta restricting connect-src to: api.octopus.energy, *.open-meteo.com,
api.postcodes.io, tile servers' img-src; script-src self + cdnjs; style-src self + 'unsafe-inline' +
fonts.googleapis.com + cdnjs; font-src fonts.gstatic.com; worker-src self.

## 5. Quality bar

- Engine tests: sun position vs reference values; POA vs pvlib values; annual yields vs PVGIS fixtures
  within stated tolerances; alignment rules; DST days (46/50 slots); octopus pagination/dedupe/VAT/
  agreement splitting with mocked fetch; CSV parsing; battery energy conservation (in − out − losses
  = ΔSoC) for every strategy; DP ≥ every rule strategy; dc-coupled battery never exceeds AC cap;
  UPS never exports; finance formulas against hand-computed cases; insights base load on synthetic data.
- Determinism: same inputs → identical outputs (seeded demo).
- Performance: full simulate (no battery) < 150 ms; DP N=41 < 200 ms; orientation sweep (684 configs,
  1 sub-sample, no battery) < 3 s in the worker; UI never blocks.
- Robustness: network failures surface actionable messages; partial data (missing weather days, meter
  gaps) handled and reported; no NaN anywhere in results.
