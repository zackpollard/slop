# Accepted amendments (part of the spec — they WIN over SPEC.md where they conflict)

Two critic reports are accepted in full, with the overrides below:
- `/home/zack/.claude/jobs/52762e7f/tmp/CRITIQUE-engine.md` (engine semantics: price bases, epoch
  joins, slotUPS, curtailment flag, consistent PV physics in battery runs, no battery export by
  default, per-month annualisation, gap filling, finance formulas, weather-year mapping, sweep
  proxy + full re-evaluation, numeric acceptance tests T1–T8, invariants, shading double count,
  SoC resolution, capacity semantics, totals definitions, DST test vectors).
- `/home/zack/.claude/jobs/52762e7f/tmp/CRITIQUE-ux.md` (Verdict screen, per-scenario export,
  typical-year headline + weather band, default scenarios, UPS loss model & strategies, `threshold`
  strategy, plug-in rules with fixes, base-load curve & drift, mount spots, confidence & tornado,
  Compare rules, staged upgrades, Design simple/advanced, mobile, charts priority, next steps & print,
  pre-existing solar).

Read the relevant amendment text in those files before implementing a module. Interfaces are pinned
in `/home/zack/.claude/jobs/52762e7f/tmp/CONTRACTS.md` — those signatures are binding.

## Overrides / reconciliations

1. **Default battery strategy** is `threshold` (UX critique) for dc/ac/ups. Strategy ids:
   `self | fixed | schedule | threshold | smart | optimal` (+ ups-only `online` used only to compute
   the "don't disable bypass" penalty). For `ups`, `fixed` is a rules error; `self` requires own panels.
   Labels per the UX critique.
2. **UPS physics** = the engine critique's `slotUPS` (vertices A/B; no f>0 with c>0) with the UX
   critique's defaults (etaInv 0.94, chargeEff 0.88, fixedLossW catalog ?? (capacityKwh ≤ 2.5 ? 20 : 30),
   bypassW 8, reserve 10%). Use the verified power-station catalog
   (`research/ups/power-stations-verified.json`, 18 entries) and its VERIFY corrections: per-input PV
   limits are real (Voc ≤ 60 V, Isc ≤ 18–20 A → usually ONE panel per 11–60 V input); cap station PV at
   what can actually be wired; real charge rates must be ≥ the DC needed to carry the load in `online`.
3. **Weather basis**: headline = **typical year** (per-month irradiance scaling to the 2006–2025
   SARAH-3 climatology at the user's cell); secondary = actual last 12 months; band = p10/p50/p90 over
   2006–2025 via per-month **DC scaling** of cached DC (UX critique). Exact weather-year re-runs
   (engine critique mapping rules) are an optional Method-tab feature — implement LAST, only if time
   allows. Demo mode ships the London climatology inside `data/demo.json` so it works offline.
4. **Price bases** (engine critique): dataset carries `importPriceExc`, billed `importPrice`,
   `importPriceFwdExc` (Agile levy −3.333p exc before 2026-03-31T22:00Z), `exportPrices.{prime,fixed,agile}`
   (as paid) and their forward variants. Dispatch runs once on decision prices
   pD = importPriceFwdExc·1.05, xD = exportFwd; flows are valued twice (as billed, forward-by-month).
   Finance year 1 = the 12 months from the 1st of next month (default install 2026-11-01), VAT 0% to
   2027-03-31 then 5% (toggle). Export income never VAT'd.
5. **Tab order**: Verdict · Usage · Compare · Design · Orientation · Method · Data (Data reachable
   from the header chip and the connect card). First load with no data → Verdict shows the Connect card.
6. **Default scenarios** = UX critique's S01–S06, H1–H4, U1–U3, C1, W1–W3, R0–R1 + leaderboard rows.
   Before hard-coding any catalog id/price, check it exists in the verified catalogs and use the
   catalog's values (the critique's numbers are indicative). Bundles go in `data/bundles.json`.
7. **Scope guard**: features marked optional/phase-2 in the critiques (exact weather years, "check my
   savings after installing", map-based mount-spot drawing) come last. Mount spots are entered with a
   simple form (kind, compass, tilt); the Leaflet map is used for location (and an optional azimuth
   handle) — keep it.
8. **Catalog data in-app**: copy the verified catalogs into `projects/solar-calculator/data/`
   (`kits.json`, `stations.json`, `bundles.json`, `constants.json`) trimmed to the fields the app uses
   plus `priceSource`, `priceDate`, `notes`, `confidence`, `availableNow`/`availability`.
