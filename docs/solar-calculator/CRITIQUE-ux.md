I walked through §4 as the user would: a homelab owner on Agile, with an API key and servers running 24/7. The engine in the spec is strong. The UI is built around the tools, though, so the user has to put the answer together themselves.

**The four critical gaps:**
1. **No answer-first screen.** Nothing says "buy X, it saves £Y a year, it pays back in Z years". Nothing answers "does west pay?", "what does a battery add?" or "is the UPS route worth it?".
2. **Export price is set per dataset, not per scenario.** Octopus kits should get Outgoing Prime and other kits nothing, so a single dataset-wide export price makes the kit ranking wrong.
3. **The headline weather year is a toggle.** The last 12 months in London (1204.6 kWh/m²) were sunnier than any year from 2006 to 2025 (maximum 1156.6), so "actual" overstates savings by about 12%. The 20-year weather band only runs on demand and is slow.
4. **There is no default set of options.** The user has to build every scenario by hand.

**Major problems:**
- **UPS model.** It uses generic 0.92 efficiencies, and its 'schedule' strategy is the smart-plug "cut the mains 4–7pm" pattern. The research shows that pattern earns about £0 or less (−£4.54 a year at 500 W). The realistic Agile-aware rule earns about £43 and perfect timing about £53, while running the servers through the inverter all the time (bypass disabled) costs £217 a year more. The spec also relies on REPORT-ups.md, which doesn't exist.
- **No realistic battery strategy.** The battery strategy list has no realistic implementable option. Nothing splits a battery's value into storing solar versus shifting cheap grid power. That split matters most for this user, because the servers already use almost all the solar.
- **Plug-in legal limits not enforced.** You can't add panels to a registered kit, single-input kits can't face two directions, and the panel-count curve suggests builds that aren't legal.
- **Missing analyses.** Base-load sensitivity and drift (homelab load changes) are missing, as are where panels can actually be mounted, a tie band, flip conditions for the orientation answer, staged "add a battery later" purchases, a confidence rating with a tornado chart, and Pareto / step-up comparison.
- **Data screen too heavy.** It has about 10 decisions before the first result; it should take 2 clicks.

**Minor:** forward VAT for year 1, Simple and Advanced design modes in plain language, mobile priorities, which charts are essential, next steps plus print, and partial-year or post-install data.

Every amendment below gives exact formulas, signatures, UI wording and acceptance tests. The default scenarios are built from the verified catalogs: plugin-kits-verified.json, ups/power-stations.json and plugin-market-constants.verified.json.

### [critical] §4 UI — new item 0 'Verdict' (first tab after data loads) + §3 Architecture (add js/scenarios.js, js/verdict.js, js/views/verdict.js) + §3.1 types
PROBLEM: The spec has six tool tabs (Data, Usage, Design, Orientation, Compare, Method) but no screen that answers the user's question. After fetching, the user lands among tools: they must build scenarios, understand routes and compare them by hand. Nothing tells them 'buy X, it saves £Y/yr, pays back in Z years'. Nothing answers 'does west pay?', 'what does a battery add?', 'is a UPS for the servers worth it?', 'how sure is this?', 'how much does my base load matter?' or 'can I add more later?'.
AMENDMENT: ### 4.0 Verdict (new; route #verdict)
When the data pipeline finishes (Octopus, CSV, demo or manual), navigate to #verdict. With no data loaded, #verdict shows the Connect card (A-Data). New tab order: Verdict · Usage · Compare · Design · Orientation · Method · Data.

Engine: js/verdict.js is pure (no DOM) and runs in the worker.
/** @returns {Verdict} */
export function buildVerdict(ds, scenarios, results, ins, opts = { maxPaybackYears: 10, tieBandPct: 3 })
`results` is a Map<scenarioId, ScenarioResult>. Each ScenarioResult is { sim (typical weather), simActual, band:{p10,p50,p90} (£/yr), finance, financeBand:{p10,p90} (payback), rules:{errors,warnings}, decomposition? }.

/** Verdict */
{ context:{ days, from, to, tariffCodes, region, postcode, coveragePct, weatherNote },
  usage:{ baseLoadW, recentBaseW, baseLoadKwhYr, baseLoadSharePct, baseLoadCostGbp, baseLoadPeakCostGbp, gbpPer100W, peakKwhPerDay, energyCostGbp, standingGbp },
  ranked:[{ id, name, route, legal:'ok'|'check'|'whatif'|'reference', capexGbp, savings:{typical,actual,p10,p90}, payback:{typical,p10,p90}, npv10Gbp, npv20Gbp, net10Gbp, selfUsePct, exportIncomeGbp, equivalentWattsCut, confidence:{level,reasons[]}, badges:[], dominatedBy, availableNow }],
  bestBuyId, runnerUpId,
  answers:{ orientation, battery, ups, growth, confidence, baseLoad } }  // shapes are defined in the amendments for those sections

Formulas:
- baseLoadCostGbp = Σ_t importPrice_t·baseLoadW/1000·0.5/100 × 365/days
- gbpPer100W = 100·baseLoadCostGbp/baseLoadW
- peakKwhPerDay = mean over complete local days of Σ_{peak slots} load_t
- equivalentWattsCut = round to the nearest 10 of savings.typical/(gbpPer100W/100)
- net10Gbp = Σ_{y=1..10} CF_y − C0 (nominal)
- npv10Gbp = −C0 + Σ_{y=1..10} CF_y/(1+r)^y (no residual value). Rank on 10 years because micro-inverter and battery warranties are about 10 years and future Agile prices are unknown. NPV over 20 years stays in Compare.
- Ranking: rows with legal ok/check/reference, sorted by npv10Gbp descending; then a divider 'Not legal yet — for planning'; then whatif rows sorted by npv10Gbp.
- bestBuy = argmax npv10Gbp over rows with legal==='ok', no rule errors, availableNow!==false and payback.typical ≤ maxPaybackYears. If two rows are within £25 of NPV, take the lower capex. runnerUp = the cheapest other eligible row whose payback ≤ bestBuy payback + 1 year; otherwise the next row by NPV.
- Badges: 'Best value', 'Fastest payback' (lowest payback.typical among eligible rows), 'Lowest outlay'.

Layout. At ≥1024 px use two columns: blocks 1–3 left, 4–5 right. Mobile order is set in the mobile amendment.
1. Context line (mono, muted): '{days} days of your half-hourly use ({from} – {to}) · {tariffCode} · typical-year sunshine for {postcode}', plus a chip '{coveragePct}% real data' linking to #data. In demo mode, add an inline slider 'Server load {W} W' that re-runs the verdict.
2. Three stat tiles:
   - 'Always-on load {baseLoadW} W', sub '{baseLoadKwhYr} kWh/yr · {baseLoadSharePct}% of your use'
   - 'It costs £{baseLoadCostGbp}/yr', sub '£{baseLoadPeakCostGbp} of it 4–7pm · £{gbpPer100W} per 100 W'
   - 'Your electricity, last 12 months £{energyCostGbp}', sub '+ £{standingGbp} standing charges'
3. Best-buy card (accent border).
   - Headline 'Buy the {name}.' then 'Facing {compass} at {tilt}°, it would save about £{typical}/yr in a typical year (£{p10}–£{p90} depending on the weather) and pay for itself in {payback} years.'
   - Mini stats: Cost · Saves/yr · Payback · Ahead after 10 yrs.
   - Why line, using the first condition that is true:
     · selfUsePct ≥ 95: 'Your always-on load uses {selfUsePct}% of what it makes, so export payments barely matter[ — Outgoing Prime adds only £{exportIncome}/yr].'
     · unpaid export ≥ 5% of output: '{exportKwh} kWh/yr would go to the grid unpaid.'
     · export is Prime: 'Includes £{exportIncome}/yr from Outgoing Prime.'
   - Then 'Same as permanently switching off {equivalentWattsCut} W of servers.'
   - Route badge, availability, Next steps (see that amendment), and buttons [See the details] (#design?scenario=id) and [Compare].
   - Runner-up line: 'Spending less? {name} costs £{capex} and pays back in {payback} yrs.'
   - If no row is eligible: 'Nothing here pays back within {maxPaybackYears} years on your data.' / 'Closest: {name}, {payback} years. Cutting 100 W of always-on load would save £{gbpPer100W}/yr for nothing.'
4. Ranked options table (cards below 600 px). Columns: Option · Route · Cost · Saves/yr (typical, with a p10–p90 bar) · Payback · Ahead after 10 yrs · Confidence. Dominated rows are collapsed under 'Show {n} options beaten on both price and savings'. Reference rows pinned last: 'Do nothing' and 'Cut 100 W of always-on load'. The cost-vs-saving scatter sits below the table.
5. 'Your questions' accordion. Each collapsed header shows a one-line answer and links to a detail tab: 'Should the panels face west for the 4–7pm peak?', 'What does a battery add?', 'Is a power station for the servers worth it?', 'Can I add more later?', 'How sure is this?', 'How much does my always-on load matter?'.

Progressive rendering: tiles appear immediately → best buy and plug-in rows (no band yet) → battery and UPS rows and answers → bands, tornado and base-load curve. Show skeletons until each block is ready. A figure must never switch between typical and actual weather.

Acceptance tests (lib/slopnet/__tests__/solar-verdict.test.js, using projects/solar-calculator/data/demo.json and a seeded demo load with serverW 500):
V1 bestBuyId is route 'plugin', legal 'ok', has no rule errors and payback.typical ≤ 10.
V2 Only whatif rows may have rule errors, and every whatif row comes after every other row.
V3 Row R1 ('cut 100 W'): savings.typical = gbpPer100W ± £0.50.
V4 Running twice with the same inputs gives deep-equal JSON.
V5 With every price ×10, bestBuyId === null and the 'nothing pays back' text is shown.

### [critical] §3.1 Dataset/System types + §3.2 Baseline vs new cost + §4 item 1 Data (export tariff)
PROBLEM: Dataset.exportPrice holds ONE export series for 'the chosen export tariff', set on the Data tab, while System.export.kind holds another. Export eligibility depends on the kit: only Octopus-bought kits get Outgoing Prime (16p from 4–7pm, 9p otherwise); every other plug-in kit is paid nothing. With one dataset-wide series, the kit leaderboard and the verdict either credit every kit with Prime or credit none, so Octopus and City Plumbing kits are ranked on the wrong basis. Prime also shifts the orientation answer toward west, so the error carries through.
AMENDMENT: §3.1 Dataset — replace
  exportPrice: Float64Array,// p/kWh for the chosen export tariff (0 if none)
with
  exportPrices: { prime: Float64Array, fixed: Float64Array, agile: Float64Array|null }, // p/kWh, no VAT. Prime is synthesised 16/9 by local clock before 2026-06-23. agile is null if not fetched.
Delete meta.exportTariff.
§3.2: x_t = kind==='none' ? 0 : kind==='flat' ? system.export.flatP : ds.exportPrices[kind][t].
§4 Data: remove the export-tariff control. Export is set per scenario in Design under 'Export payments': None (default for most kits) | Outgoing Prime — 16p 4–7pm, 9p otherwise (Octopus kits only) | Outgoing 12p flat | Agile Outgoing | Custom p.
kits.js defaults:
- Octopus kits → 'prime' when ds.meta.source is 'octopus' or 'demo'. Add the note 'Starts after your network operator approves the kit'.
- Every other plug-in kit → 'none'.
- Hardwired → 'none', with a toggle to 'fixed' labelled 'Octopus may offer Outgoing 12p without MCS — unconfirmed'.
- UPS → never exports.
rules.js warnings:
- 'prime' on a non-Octopus kit: 'Octopus only pays export on plug-in kits bought from Octopus.'
- 'fixed' or 'agile' on route 'plugin': 'Plug-in kits can't get the Smart Export Guarantee (no MCS certificate).'
Acceptance: on one dataset with a constant 100 W load, simulate S01 (Octopus 2×460, prime) and then S05 (City Plumbing 2×515, none). S01 exportIncomeP > 0. S05 exportIncomeP === 0. Simulating S05 after S01 gives results bit-identical to simulating S05 alone.

### [critical] §1 'Weather-year variability' + §3.1 Dataset.monthScale + §4 item 1 Data ('weather year' control)
PROBLEM: The headline depends on a Data-tab toggle (actual vs typical), and the band over N years must be requested and downloads 5 years of SARAH-3 + IFS. In the verified research, the last 12 months in London had 1204.6 kWh/m² of sunshine, above every year from 2006 to 2025 (max 1156.6, mean 1076.5; +32% in July and +23% in August). An 'actual' headline overstates savings by about 12%, and an 'actual' payback is outside the 20-year range. The user's 'how confident is this?' needs a band by default, not on request.
AMENDMENT: Replace the Data-tab 'weather year' control and Dataset.monthScale with the following.
- Simulate every scenario twice. 'typical' is the headline everywhere: verdict, Compare, Design tiles and finance. 'actual' is shown as a secondary figure.
- Typical weather uses per-month scaling of irradiance before the PV chain: ghi, dhi and dni ×= sTyp[month(t)].
  · sTyp[m] = Gclim[m]/Gact[m], clamped to [0.5, 2].
  · Gact[m] = Σ ghi_t·0.5/1000 (kWh/m²) over calendar month m of ds.
  · Gclim[m] = the 2006–2025 SARAH-3 monthly mean at the user's grid cell, from the existing daily climatology call. Fill null days with that month's mean; never sum nulls as 0.
- Band (always on, computed in the background):
  · For each year Y from 2006 to 2025, scale the cached DC sub-samples by GY[m]/Gact[m]. Scale DC, not irradiance.
  · Re-run inverterAc and dispatch only (battery DP at N=21).
  · SimResult gains variants: { typical: Totals, actual: Totals, band: { years: Int16Array, savingsP: Float64Array, p10, p50, p90 } }.
  · Finance gains payback at the p10 and p90 savings.
- simulate option: { weather: 'typical'|'actual'|{ dcScale: Float32Array(12) } }.
- Keep the exact re-run with real past weather years as an opt-in in Method: 'Exact weather years (downloads ~{n} MB)', with its note about the broken sunny-day/cheap-price link. Monthly rescaling keeps the day-level correlation, so that note does not apply to the default band.
UI copy:
- Label 'Typical year', tooltip: 'Your usage and prices from the last 12 months, with each month's sunshine scaled to its 2006–2025 average at your home.'
- Secondary line: 'Last 12 months as it happened: £{actual}/yr — sunnier than {k} of the last 20 years ({+pct}% vs average).' Here k = number of years with ΣGY < ΣGact, and pct = ΣGact/ΣGclim − 1.
- Band: '£{p10}–£{p90} across 2006–2025 weather'.
Acceptance:
(1) With all factors = 1, typical === actual bit-for-bit.
(2) On demo.json, DC-level scaling and irradiance-level scaling at factors 0.7 and 1.3 differ by < 1.5% in annual pvAcKwh, for both S35 and W90.
(3) On demo (London), S01 actual savings ≥ band.p90.
(4) band.p10 ≤ band.p50 ≤ band.p90.

### [critical] §3 Architecture — new js/scenarios.js (default scenarios) + kits.js catalog normalisation
PROBLEM: The spec ranks 'kitRanking(catalog)' at 'the user's orientation' but never says which complete options to generate. It doesn't cover panels for battery-inverters that ship without them, electrician costs, UPS units, combinations, what-ifs, or reference points. The verified catalog also has traps: the EcoFlow 2×500 ships hardwired, the facade kit is not purchasable, mppts/usableKwh/inverterEff can be null, efficiency bases are mixed, and the power-station catalog has an availability string instead of availableNow. Without a defined default set, the 2-click verdict is impossible and different builds will rank different things.
AMENDMENT: ### js/scenarios.js
/** @returns {Scenario[]} */ export function autoScenarios(kits, stations, ds, ins, spots, opts)
Scenario = System & { featured:boolean, legal:'ok'|'check'|'whatif'|'reference', sourceIds:string[] }

Placement: each array goes on bestSpotFor(scenario), using the spots from the orientation amendment.
- For free-direction spots, run a 1-sub-sample sweep (az 90–270 step 10; tilt within the spot's range, step 5) and pick the best typical £. The headline run then uses 3 sub-samples.
- Default spots: 'Ground or flat-roof frame' (any az, tilt 15–45, mounting open) and 'West-facing wall' (az 270, tilt 90, mounting wall).
Battery headline strategy: 'threshold', and also run 'optimal' for the best-case figure. Export as in the export amendment.

Featured scenarios (always computed; capex in £; prices from the catalog and editable):
S01 Octopus 2×460 W | octopus-plugin-solar-2x460 | 650 | plugin/ok | both panels on the best spot; prime
S02 Octopus 2×460 W, one panel west | panel 1 on the best spot (input 0), panel 2 at az 270 and the same tilt (input 1) | 650 | plugin/ok | only for kits with mppts ≥ 2
S03 Octopus 2×460 W on a west wall | az 270, tilt 90, wall | 650 | plugin/ok | the user's 4–7pm hypothesis; always shown
S04 Octopus 1×460 W | octopus-plugin-solar-1x460 | 450 | plugin/ok | prime
S05 City Plumbing 2×515 W | cityplumbing-dmegc-2x515-hiflow | 468 | plugin/ok | 1 input (both face the same way); >960 Wp warning
S06 City Plumbing 1×465 W | cityplumbing-dmegc-1x465-hiflow | 336 | plugin/ok
H1 EcoFlow STREAM Ultra + 4×500 W (electrician) | bundle £1,499 + electrician £350 | 1,849 | hardwired/ok | 1.92 kWh dc, 800 W out, 4 inputs × 500 W, acChargeW 1050, maxChargeW 1050 (assumed)
H2 Zendure SolarFlow 2400 Pro + 4×460 W | zendure-solarflow-2400-pro 1,099 + 4×astronergy-460w-bifacial-trade 80.40 + 4×its-adjustable-tilt-frame-15-30 40.80 + 350 | 1,933.80 | hardwired/ok | 2.4 kWh, 2400 W AC (no 800 W cap)
H3 Anker Solarbank 4 Pro 5 kWh + 4×460 W | 1,699 + 321.60 + 163.20 + 350 | 2,533.80 | hardwired/ok | 5.024 kWh, 2500 W (check panel Voc ≤ 50 V)
H4 Battery only: EcoFlow STREAM AC 5000 | ecoflow-stream-ac-5000 1,499 + 350 | 1,849 | hardwired/ok | no panels, ac coupling, pure Agile shifting
U1 Power station for the servers: DELTA 3 Plus 1 kWh | ecoflow-delta-3-plus | 599 | ups/ok | built-in TOU; USB-C HID/NUT
U2 Power station for the servers: BLUETTI Elite 300 3 kWh | bluetti-elite-300 + cost line 'Smart plug for automation' £0 (enter yours) | 1,299 | ups/ok | lowest measured loss (11 W); no TOU
U3 DELTA 3 Plus + 2×460 W on its own solar inputs | 599 + 2×80.40 + 2×40.80 | 841.40 | ups/ok | off-grid PV, one panel per 11–60 V input
C1 {best plug-in kit} + U3 | sum of both | plugin+ups/check | see the UPS amendment for the legal note
W1 Octopus 2×460 + plug-in battery (if legalised) | S01 + a battery with the HiBattery 1920 AC spec as plug-in (1.92 kWh, 1000 W in, 800 W out, RTE 0.87, 10 W standby) £1,049.99, no electrician | 1,699.99 | whatif
W2 Octopus 2×460 now, add a plug-in battery later | S01 + upgrade {atYear:1, battery as W1, £1,049.99} | whatif
W3 Two plug-in kits (if 'one per circuit' is allowed) | 2× the best plug-in kit; the second goes on the next-best spot | whatif
R0 Do nothing | 0 | reference
R1 Cut 100 W of always-on load | load − 0.05 kWh/slot | 0 | reference

Leaderboard (Compare, and 'show all' on the verdict), each on its best spot:
- powerxpress-920-marstek £669, patiosun-duo £699, thunder-bolt-920 £749.99.
- solarfy-duo-910 £599: mppts unknown, so treat as 1 input with a warning.
- ecoflow-stream-micro-2x500 → route hardwired, £549 + £350.
- ecoflow-stream-facade-2x400 shown greyed, 'Not on sale now'.
- ecoflow-stream-ultra-x + 4×500 bundle £1,649 + £350.
- Every in-stock station in power-stations.json, without PV.

kits.js normalisation:
- Route: installRoute starting 'plug-in' → plugin. Starting 'hardwired' → hardwired, plus the cost line 'Electrician: dedicated circuit + G98 notification' £350 (range £150–600; '+£400–900 if your consumer unit needs replacing').
- Stations: availableNow = /in stock/i.test(availability). preorder = /pre-?order/i, shown as a badge.
- inverterEff null → 0.955, flagged 'assumed'. If inverterEffBasis is 'peak', subtract 0.005.
- mppts null → 1, with a warning.
- usableKwh null → batteryKwh (minSoc is applied once, in the physics). maxChargeW null → acChargeW.
- Bundles go in data/bundles.json: [{id:'ecoflow-stream-ultra+4x500', base:'ecoflow-stream-ultra', panels:{count:4,wp:500}, priceGbp:1499}, {id:'ecoflow-stream-ultra-x+4x500', base:'ecoflow-stream-ultra-x', panels:{count:4,wp:500}, priceGbp:1649}]. Never parse prices out of `notes`.

Acceptance (solar-scenarios.test.js):
- At least 18 scenarios, with unique ids.
- capexGbp === Σ year-0 cost items.
- Every non-whatif scenario has no rule errors.
- Every plugin scenario has acLimitW 800, DC ≤ 2000 Wp, ≤ 4 modules and no grid-tied battery.
- S02 is absent for single-input kits.
- H4.arrays.length === 0.
- Σ gridExport of the UPS part of U* and C1 is 0.
- On demo, Octopus scenarios use prime and every other plug-in kit uses none.

### [major] §1 UPS bullet + §3.1 battery.ups + §3.2 slotUPS & strategies + rules.js + verdict answers.ups
PROBLEM: The spec models the UPS route with the generic AC-coupled defaults (acEffCharge/acEffDischarge 0.92, standbyW 10). Its UPS 'schedule' strategy is 'the smart plug cuts AC input during 16–19'. The UPS research (ups/scripts/sim_ups.py, loss-fits.json, sim-results.json) contradicts both. Measured AC-to-AC efficiency at server-like loads is 0.68–0.77, fixed losses while inverting are 11–45 W, and bypass overhead is about 8 W. For a DELTA 3 Plus with a 500 W load and no PV, the 4–7pm smart-plug cut saves −£4.54/yr, the Agile price-threshold rule saves £43.41, perfect DP saves £52.73, and disabling bypass costs −£216.61. With the spec's model, 'is the UPS route worth it?' gets the wrong answer, and the default strategy is the one that earns nothing. The spec also points to REPORT-ups.md, which does not exist, and to power-stations-verified.json, which also does not exist.
AMENDMENT: Replace 'see research/REPORT-ups.md once written' with the following, and port slotUPS from research/ups/scripts/sim_ups.py.
Per-slot physics (D = energy for the dedicated server load):
- Bypass: grid = D·Δt + bypassOverheadW·Δt/1000, plus chargeDC/acChargeEff while charging.
- Battery: dcDrawn = D/ηinv + fixedLossW·Δt/1000. Own PV is used first; grid = 0.
Defaults (these replace acEff*/standbyW for coupling 'ups'):
- ηinv 0.94; acChargeEff 0.88 (fits 0.871–0.883); reserve 10%.
- fixedLossW = catalog fixedLossW ?? (usableKwh ≤ 2 ? 20 : 30); sensitivity 10–45.
- bypassOverheadW 8; sensitivity 3–20.
- life = min(15, 2×warrantyYears) years; editable.
New fields:
- ups.bypass: 'auto' (default) | 'disabled' (used for the penalty figure).
- ups.dedicatedW defaults to ins.baseLoadW, labelled 'Server power on the power station (W)', hint 'Your always-on load is {baseLoadW} W — use less if some of it isn't the servers (fridge, router…)'.
- rules: dedicatedW > station.acOutputW → error.
UPS strategies:
- 'threshold' (default): sim_ups run_heur with PV headroom, as in the battery amendment.
- 'schedule': label 'Smart plug cuts the mains 4–7pm'; falls back to grid at the reserve.
- 'optimal': DP over {bypass, bypass+charge, battery}.
- 'self': charge from own PV only.
Legal copy:
- Route ups: 'No grid connection — a power station is an appliance, not generation; nothing to register.'
- C1 (plug-in kit + power station) is legal:'check': 'Check first: plug-in kits' instructions forbid using them “in conjunction with a battery”. A power station that only charges from a normal socket is arguably just a load, but nobody has confirmed this.'
- rules.js: route 'plugin' with battery.coupling 'ups' → warning, not error.
answers.ups, for U = the best of U1–U3 by npv10:
{ bestId, realisticGbp: sav(threshold), bestCaseGbp: sav(optimal), peakCutGbp: sav(schedule), onlinePenaltyGbp: sav(optimal, bypass:'disabled') − sav(optimal), paybackYears, withPanels:{ id:'U3', gbp, paybackYears }, switchMs, hid }
Copy:
- Collapsed: 'A power station running your servers saves £{realistic}/yr (pays back in {n} yrs).'
- Body: 'That's with Agile-aware automation; up to £{bestCase} if timed perfectly. Just cutting its mains with a smart plug from 4–7pm only saves £{peakCut}/yr — conversion losses eat most of the price gap. Don't disable the bypass to run the servers through the inverter all the time: that costs £{−onlinePenalty}/yr more. With 2 panels on its own solar inputs (no 800 W limit, nothing to register): £{withPanels.gbp}/yr, {withPanels.payback} yrs. Bonus: it's a real UPS for the servers ({switchMs} ms switchover[; USB HID for clean shutdown]).'
Acceptance (demo prices, constant 500 W, no PV; DELTA 3 Plus with C 1000 Wh, Pch 500 W, ηch 0.88, ηinv 0.94, P0 17 W, Pbyp 8 W, which matches sim-results.json):
- optimal (N=81) = £52.7 ± 5%
- schedule ≤ £5
- schedule ≤ threshold ≤ optimal
- bypass 'disabled' < −£150
- Σ gridExport === 0 for every strategy

### [major] §3.2 Battery (strategies, finance EOL) + §4 Design + verdict answers.battery
PROBLEM: The strategies (self/fixed/schedule/smart/optimal) don't include the realistic rule a homelab owner would automate. 'smart' and 'optimal' assume perfect foresight, and REPORT-agile shows that dispatch.mjs priceAware without PV headroom fills the battery from the grid and then wastes the next day's PV. Nothing splits a battery's value into storing solar versus shifting cheap grid power. For this user that split is the key fact: the servers absorb nearly all plug-in output, so the battery's value is mostly grid shifting and the battery is a separate decision from solar. Battery savings after end of life are undefined.
AMENDMENT: 1. Add strategy 'threshold', the default for every battery and UPS. Port it from dispatch.mjs controllers.priceAware and add PV headroom. For each Agile day d (23:00→23:00 local):
   - m = ceil(usable·ηout/(Pdis·Δt)). The m most expensive slots of d are discharge slots.
   - n = ceil(usable/(ηin·Pchg·Δt)).
   - surplusFcst_d = Σ_{t∈d−1} max(0, pvAc_t − load_t). This is persistence (yesterday's surplus). Option pvForecast:'perfect' uses day d instead.
   - gridTarget_d = max(socMin, socMax − 0.8·surplusFcst_d·ηin).
   - Grid-charge in the n cheapest slots between the previous day's last discharge slot and today's first discharge slot. Only charge while soc < gridTarget_d and p_t/RTE + wear < the mean price of today's discharge slots.
   - Before the first discharge slot, store PV surplus and never discharge. After the last one, run self-consumption.
   Labels:
   - threshold: 'Agile-aware automation (realistic)'
   - smart: 'Agile-aware with a perfect solar forecast'
   - optimal: 'Perfect hindsight (best case)'
   - schedule: 'Simple timer: charge overnight, run 4–7pm'
   - self: 'Follow my usage', with the note 'With a flat server load, a fixed output equal to your always-on load does the same without a CT clamp'.
   Headline figures use threshold. Show 'up to £{optimal}/yr with perfect timing' beside them.
2. End of life: after EOL (SoH < 70%, 15 y, or the station life from the UPS amendment), Sav_batt = 0 unless finance.replaceBattery (default false). The cash-flow chart marks 'battery ends (yr N)'.
3. answers.battery. B = the best legal battery scenario (H1–H4) by npv10; P = the best plug-in scenario. B0 = B with battery:null. Bng = B with acChargeW:0.
   batteryTotal = sav(B) − sav(B0)
   fromSolar = sav(Bng) − sav(B0) + standbyCost(Bng)
   fromGrid = sav(B) − sav(Bng)
   standby = −standbyCost(B), where standbyCost = Σ standby kWh × import price
   fromSolar + fromGrid + standby ≡ batteryTotal
   Δcapex = capex(B) − capex(P); Δsav = sav(B) − sav(P); incrementalPayback = Δsav > 0 ? Δcapex/Δsav : ∞
   verdict = ≤ 7 yrs 'pays' | ≤ battery life 'marginal' | else 'doesNotPay'
   Shape: { bestId, vsId, deltaCapexGbp, deltaSavingsGbp, incrementalPaybackYears, split:{fromSolarGbp, fromGridGbp, standbyGbp}, optimalGbp, peakKwhPerDay, verdict }
   Copy:
   - Collapsed: 'A battery adds £{Δsav}/yr for £{Δcapex} more — the extra pays back in {n} years.'
   - Body: '{gridPct}% of that comes from charging in cheap Agile slots and {solarPct}% from storing your own solar, minus £{standby}/yr of standby power.'
   - Add only if fromGrid ≥ 60% of batteryTotal: 'Your servers already use almost all the solar, so for you a battery is mostly a separate decision from solar.'
   - 'Your home uses {peakKwhPerDay} kWh between 4 and 7pm each day; usable capacity much beyond that earns less per kWh (see the battery-size curve).'
   - 'Any battery has to be wired in by an electrician today — plug-in batteries aren't legal yet (Octopus hopes for early 2027). With perfect timing it could reach £{optimal}/yr.'
Acceptance (demo, 2 kWh dc battery + 1.8 kWp S35, constant 500 W):
(a) sav(self) ≤ sav(threshold) ≤ sav(optimal) + £1, and sav(threshold) ≥ 0.85·sav(optimal). Research: priceAware £336 vs DP £378.
(b) The split sums to batteryTotal within 1p.
(c) With acChargeW 0, fromGrid === 0.

### [major] §3.3 Rules + §3 sweep.panelCountCurve / 'Splits' + §4 Design
PROBLEM: Several engine outputs would advise illegal or physically wrong builds:
- panelCountCurve runs '1..max allowed by route', which implies adding panels to a plug-in kit. A kit must be the complete ENA-registered product, so that is not allowed.
- 'Splits: E/W or SW/W … across two MPPTs' would also be offered for single-input HiFlow kits (City Plumbing, PatioSun Duo). Those wire both panels in series, so splitting gives large mismatch losses that the per-input engine would not see.
- Adding a battery to a plug-in design just errors, with no way forward.
- 'One device per household' has no rule code.
AMENDMENT: rules.js returns {code, message, fixes[]}.
Errors on route 'plugin':
- PLUGIN_KIT_ALTERED: total count or Wp differs from the catalog kit's includedPanels. Message: 'Plug-in kits must be used exactly as sold — they're registered on the ENA list as a complete kit, so you can't add or swap panels.' Fixes: [Choose a bigger kit] [Make it electrician-installed].
- PLUGIN_SINGLE_INPUT_MIXED: two arrays on the same input with |Δaz| > 10° or |Δtilt| > 5°. Message: '{inverter} has one solar input, so both panels must face the same way.' Applies to cityplumbing-*-hiflow, patiosun-duo and hoymiles-hf-800-wb-loose. If mppts is null, warn instead.
- PLUGIN_BATTERY: a battery with coupling ≠ 'ups'. Message: 'Plug-in batteries aren't legal in GB yet (SI 2026/848; Ofgem: “remain prohibited”).' Fixes: [Make it electrician-installed (+£350)] [Plan it as a future plug-in battery].
- PLUGIN_TWO_DEVICES: more than one plug-in inverter. Message: 'Only one plug-in kit per home (G98).' Fix: [Plan it under future rules].
Warnings:
- DC > 960 Wp: 'Get the circuit checked by an electrician — advised above 960 W of panels.'
- availableNow === false: 'Not on sale right now.'
- spot.groundLevel === false: 'Above ground level — get professional advice.'
- battery.coupling 'ups' on route 'plugin': legal 'check'.
Custom (non-catalog) plug-in systems are allowed only after ticking 'I've checked this exact kit is on the ENA register'.
panelCountCurve on route 'plugin': the x-values are the plug-in kit sizes actually on sale, at their real prices (460, 465, 890, 910, 920, 1030 Wp). Use 1..N panels only for the hardwired and UPS routes.
Splits apply only to kits with mppts ≥ 2: octopus-*, thunder-bolt-920, powerxpress-920-marstek, ecoflow-*.
Acceptance:
- Octopus 2×460 with a 3rd panel → PLUGIN_KIT_ALTERED.
- City Plumbing 2×515 with one panel at 180° and one at 270° → PLUGIN_SINGLE_INPUT_MIXED.
- The same split on Octopus 2×460 → no error.
- Applying any fix produces a System with no errors.

### [major] §3.2 Insights + dataset.js + sweep.js + verdict answers.baseLoad + §4 Usage
PROBLEM: The user's main lever, a high 24/7 base load, is reported as a number but never used as an input. Nothing shows how savings change with base load, the base load below which a kit stops paying back, or the comparison with simply cutting server watts. In region C, 100 W of always-on load costs £175/yr, about as much as a whole 800 W kit saves. Homelab loads also drift as servers are added or retired. A full-year median then misstates future savings, and the spec has no way to project with today's load.
AMENDMENT: 1. insights.baseLoad adds:
   - recentBaseW = median of the daily base values over the last 60 complete days
   - driftPct = (recentBaseW − baseLoadW)/baseLoadW
2. dataset.js:
/** load'_t = max(0, load_t + (targetW − baseW)·0.5/1000); every other array is shared */
export function withBaseLoad(ds, baseW, targetW)
3. If |driftPct| ≥ 0.15, Usage and the verdict context show 'Your always-on load changed: {baseLoadW} W over the year, {recentBaseW} W in the last 2 months.' with a button [Use today's {recentBaseW} W for the forecast]. This sets a persisted projectBaseW. All scenario and verdict figures then use withBaseLoad(ds, baseLoadW, projectBaseW), and the context line adds 'projected with {projectBaseW} W always-on'.
4. sweep.baseLoadCurve(ds, scenarios, xs):
   - xs = [0,100,200,300,400,500,600,800,1000,1200,1500] ∪ {baseLoadW, recentBaseW}
   - Run for the best plug-in, best hardwired battery and best UPS scenarios.
   - Returns [{x, savingsGbp, paybackYears, selfUsePct}].
   - Reuse cached DC; batteries at N=21.
5. answers.baseLoad = { curve, userBaseW, breakEvenW:{[id]: the lowest x with payback ≤ 10, linearly interpolated; null if none} }
   Copy:
   - Collapsed: 'Your {baseLoadW} W always-on load is why solar works for you' when breakEvenW(bestBuy) < 0.7·baseLoadW; otherwise 'Solar only just pays at your always-on load'.
   - Body: a line chart, x = always-on load (W), y = £/yr, one line per scenario. Vertical markers 'you now' and 'last 2 months'. Shade x ≥ 800 with the label 'a plug-in kit's output is all used here'.
   - Text: 'Below {breakEvenW} W the {name} would take more than 10 years to pay back.' and 'Every 100 W you remove saves £{gbpPer100W}/yr on its own — compare {bestBuy} at £{sav}/yr.'
Acceptance:
- No-battery plug-in savings are non-decreasing in x.
- At x ≥ 1000 W, exportKwh ≤ 1% of pvAcKwh for every 800 W plug-in kit.
- withBaseLoad(ds, b, b).load deep-equals ds.load.

### [major] §3.1 (new MountSpot type) + map.js + sweep.js + §4 item 4 Orientation + verdict answers.orientation
PROBLEM: The orientation work assumes the user can point panels anywhere. A real home has a few physical places for them (garden, flat roof, a west wall, a balcony), and the spec has no way to enter them, so 'best £' may be a place the user can't use. The answer is also given as one optimum. In the research, S, SSW and SW are within 1–2% of each other, so the useful answer is a range ('anything from S to SW at 30–45° is fine'). 'Show where the answer flips' has no computation behind it. The polar rose is good for exploring but does not show the kWh-versus-p/kWh trade-off the user asked about.
AMENDMENT: /** MountSpot — where panels can physically go (settings; up to 4) */
{ id, name, kind:'ground'|'flatroof'|'wall'|'railing'|'pitched', azimuth:number|null /*null = I can choose*/, tilt:number|null, tiltRange:[min,max], maxPanels, shadingPct:3, horizon:[], groundLevel:boolean }
Defaults by kind:
- ground/flatroof: az null, tilt 15–45, mounting open
- wall: tilt 90, az required, mounting wall
- railing: tilt 60–90, mounting railing
- pitched: az and tilt required, mounting roof, hardwired only
With no spots set, use 'Ground or flat-roof frame (any direction, 15–45°)' and 'West-facing wall (vertical)'. Show 'We assumed: {spots}. [Tell us where panels can go]', using the map picker in map.js.

answers.orientation, for S01's kit:
- Sweep with 1 sub-sample: az 90–270 step 10, tilt 15–90 step 5. Confirm the named points with 3 sub-samples.
- Shape: { best:{az,tilt,gbp,kwh,pPerKwh,peakSharePct}, s35, w45, w90, tie:{azMin,azMax,tiltMin,tiltMax}, westPays, flips:[{condition,az,tilt,gbp}] }
- tie = bounding box of the grid cells with gbp ≥ (1 − tieBandPct/100)·best.gbp
- westPays = best.az ≥ 240
- flips: re-run a coarse sweep (az 90–270 step 15 × tilt {15,30,45,60,90}) under each condition:
  · C1: withBaseLoad(…,150) + export 'prime'
  · C2: export 'prime' at the user's own load
  · C3: the same inverter with 4×500 Wp
  · C4: + a 2 kWh battery with 'self' as the proxy strategy
  Report a condition when |az − best.az| ≥ 30° or westPays changes.
Copy when westPays is false:
- Collapsed: 'No — face them {compass(best.az)}.'
- Body: 'On a west-facing wall they'd make {w90.kwh} kWh/yr instead of {best.kwh} ({pctLess}% less). Each of those kWh is worth more ({w90.pPerKwh}p vs {best.pPerKwh}p) because {w90.peakSharePct}% lands in the 4–7pm peak, but that doesn't make up for the lost energy: £{w90.gbp} vs £{best.gbp} a year. There's little or no sun after 4pm from November to February. Anything from {compass(tie.azMin)} to {compass(tie.azMax)} at {tie.tiltMin}–{tie.tiltMax}° is within {tieBandPct}% of the best — pick what fits.'
- Then either 'This changes if {condition}: best becomes {compass} {tilt}° (£{gbp}/yr).' or 'A lower always-on load with Outgoing Prime, more panels on the same inverter, or a battery wouldn't change it.'
Condition texts:
- C1: 'your always-on load were ~150 W and you had Outgoing Prime'
- C2: 'you had Outgoing Prime'
- C3: 'you had 2000 W of panels on the 800 W inverter (no such kit is on sale yet)'
- C4: 'you add a battery'
When westPays is true: 'Yes — for you, west pays: {compass} {tilt}° makes £{best.gbp}/yr vs £{s35.gbp} facing south.'
compass = 16-point names.
New essential chart, 'Energy vs value':
- x = kWh/yr made; y = value in p/kWh (savings ÷ kWh made).
- Faint dots for every sweep cell. Labelled dots for Best £, Best kWh, S35, SSW45, W45, W90 and Current.
- Dashed iso-£ curves y = 100·G/x for G = £50, £100, … (a dot's £/yr = x·y/100).
Acceptance (demo, constant 2000 W load, S01 kit):
- westPays === false
- w90.gbp/best.gbp ∈ [0.60, 0.80]
- w90.pPerKwh > best.pPerKwh
- w90.peakSharePct > 30
- best.az ∈ [170, 235]
(Verified research: SSW45 £165.4, SW45 £163.9, S45 £161.5, W90 £114.0.)

### [major] §4 item 1 Data (connect flow, defaults, progress) + tab order + time budget
PROBLEM: Before seeing anything, the user has to decide: connection method, account, location, date range, import price basis, export tariff, VAT treatment, weather year, then press Fetch. Most of these have one right default for this user, and two (export and weather) are wrong as dataset settings (see the export and weather amendments). There is no stated order or time budget for the roughly 30 simulations behind a verdict, so the first useful screen could take a long time.
AMENDMENT: Connect card (shown on every tab until data exists):
- Title: 'See what solar would have saved you'
- Body: 'Uses your real half-hourly usage and Agile prices from Octopus, plus satellite sunshine for your home.'
- Fields: 'Octopus API key' (password field with show/hide) and 'Account number (optional — we can find it)' with placeholder A-1234ABCD.
- Checkbox 'Remember on this device', off by default.
- Primary button: 'Analyse my home'.
- Links: 'Try with example data (London, 500 W servers)' · 'Upload a CSV' · 'Enter usage by hand'.
- Disclosure 'Where's my API key?': 'Octopus website → Your account → Personal details → API access. It's only ever sent to api.octopus.energy.'
- Non-blocking hint if the trimmed key doesn't start with sk_live_: 'Octopus keys usually start with sk_live_'.
Auto-defaults, with no questions asked:
- Property: moved_out_at null and the latest moved_in_at.
- Import MPAN and the active meter.
- Tariff history from agreements; region from the tariff-code suffix.
- Location: property postcode → postcodes.io. Fallback is the GSP centroid with the warning 'Using the centre of your region — set your postcode for accurate sunshine'.
- Dates: the last 365 complete local days, ending on the latest day with ≥ 44 slots.
- Weather: typical and actual both computed; spots and finance at their defaults.
Only prompt when the choice is ambiguous: more than one account, property or import meter point gives a single picker step.
Progress list (✓ or spinner, with counts):
- 'Your usage: {n} half-hours ({pct}%)'
- 'Agile prices: {n}'
- 'Sunshine: satellite, {d} days'
- '20-year sunshine averages'
- 'Simulating {k} options…'
Each failed step offers an action: Check your key / Retry / Use example data. When everything finishes, go to #verdict.
After fetching, the Data tab shows a 'Details' disclosure listing every auto choice with [Change]. A change re-runs from that step.
Move off the Data tab:
- Export → per scenario.
- Weather year → both computed.
- 'Import price basis' → Method › Assumptions: 'Price my usage as if on: my tariffs (default) | Agile today | Flexible | flat p'.
- VAT → Method.
Demo mode: serverW 500, with the slider on the verdict context line.
Time budget (worker; 2020 laptop):
- Usage tiles plus best buy without the band: ≤ 6 s after the last fetch.
- Full verdict: ≤ 20 s.
- Cache PV DC by array geometry, key `${tilt}|${az}|${mounting}|${shadingPct}|${bifaciality}|${wp}|${count}`, and reuse it for sweeps, bands, the tornado and base-load curves.
- Cache scenario results by hash(dataset id + scenario JSON + finance).

### [major] verdict answers.confidence + ranked[].confidence + §4 (tornado chart)
PROBLEM: Section 1 gives a per-half-hour accuracy of ±20–27% and says weather years vary, but the spec never turns this into a confidence statement or says which unknowns move the answer. The user asks 'how confident is this?' and gets no level, no band by default, and no ranking of what matters: weather, shading at the user's own spot, future Agile prices, base-load changes, or how well the battery is automated.
AMENDMENT: Confidence level per scenario = the lowest of these four:
- data: coveragePct ≥ 95 && days ≥ 330 → high; ≥ 80 && ≥ 180 → medium; otherwise low ('{100−coveragePct}% of your half-hours are estimated').
- weather: (p90−p10)/p50 ≤ 0.15 → high; ≤ 0.30 → medium; otherwise low.
- model:
  · plug-in or hardwired without a battery → high
  · battery → medium ('depends on how well it's automated: £{threshold} realistic vs £{optimal} best case')
  · ups → medium; low if the station's fixedLossW is null ('this unit's losses aren't measured; we assume {P0} W')
  · whatif → low ('not legal today')
- notes, which never lower the level:
  · shading left at the 3% default → 'assumes 3% shading — a tree or wall can cost 10–30%'
  · catalog confidence 'medium' → 'price/specs from a secondary source'
Tornado, computed for bestBuy and for the scenario open in Design. Each driver gives the payback at its low and high setting:
1. Weather year: band p10 / p90.
2. Shading 0% / 15%: cached DC ×(1−s)/(1−shadingPct/100).
3. Agile price level: import prices ×0.8 / ×1.2. Linear when there is no battery and no export; otherwise re-simulate.
4. Price trend e = 0% / 4% a year (finance only).
5. Always-on load −30% / +30% (withBaseLoad).
6. Automation, battery and UPS only: threshold / optimal.
Sort by |high − low| and show the top 5 as horizontal bars around the central payback, with a table twin.
Copy:
- Collapsed: 'How sure: {level}. Weather alone moves it between £{p10} and £{p90} a year.'
- Body: the top two drivers as '{driver} moves payback from {low} to {high} years.'
- Always add: 'Model accuracy: about ±2% a year from satellite sunshine; single half-hours can be off by 20–27%, which averages out.'
Acceptance:
- Rows are sorted by swing, descending.
- The weather row equals the band's payback at p10 and p90.
- The central value equals ranked payback.typical.
- The level is computed deterministically from the inputs listed.

### [major] §4 item 5 Compare
PROBLEM: Compare is specified as 'kit leaderboard … ranked by payback/NPV/10-yr savings' plus 'saved scenarios side by side', with no comparison rules. A user deciding between options needs to know:
- which options are beaten on both price and savings;
- whether stepping up to a dearer option is worth the extra money;
- that every row uses the same data, weather basis and finance.
None of this is defined, and battery-size curves treat kWh as continuous when real batteries come in fixed expansion packs with fixed prices.
AMENDMENT: 1. Leaderboard: all autoScenarios (featured and leaderboard) plus user-saved scenarios.
   - Columns: Option · Route · Cost · Saves/yr (typical, with a p10–p90 whisker) · Payback · Ahead after 10 yrs · NPV 20 yrs · Confidence · On sale.
   - Sort: NPV 10 yrs (default) | Payback | Cost | Saves/yr.
   - Filter chips: Plug-in · Electrician · Power station · Future rules · Only on sale now.
   - Header: 'All options: your last {days} days, typical-year sunshine, {e}% price rise/yr, {r}% discount rate'.
2. Dominance, among non-whatif rows: s is dominated by t if capex_t ≤ capex_s and sav_t ≥ sav_s, with at least one strict. Dominated rows are greyed and sorted last, with 'Beaten by {t}: cheaper and saves more'.
3. Step-ups: sort the non-dominated legal rows by capex. For each consecutive pair show 'From {a} to {b}: +£{Δcapex} for +£{Δsav}/yr — the extra pays back in {Δcapex/Δsav} yrs' (or 'never').
4. Side by side, 2–4 pins. Default pins: bestBuy, S03 (west wall), best battery, best UPS.
   Rows: Upfront cost (of which installation) · Saves in year 1 (typical) · Weather range · Last 12 months as it happened · Payback (simple / discounted) · Ahead after 10 yrs · NPV 20 yrs · Made kWh/yr · Used at home % · Exported kWh (paid / unpaid) · Lost kWh (800 W limit + switched off + power-station surplus) · Value per kWh made (p) · Made 4–7pm % · Battery cycles/yr · How it's installed (route + steps) · Confidence.
   The best value in each row is shown in the accent colour. With exactly 2 pins, add a 'Difference' column and the step-up sentence.
5. Battery-size curve: use the selected system's real expansion steps from catalog expansion[] with their prices (e.g. +AB3000L 2.88 kWh £799). y = marginal £/yr against marginal £ cost. The plug-in panel curve follows the plug-in rules amendment.
Acceptance:
- No row is dominated by itself or by a whatif row.
- Step-up deltas equal the row differences.
- Pins persist in localStorage (try/catch; works without it).

### [major] §3.1 CostItem/System.upgrade + finance.js + verdict answers.growth
PROBLEM: The user said 'plug-in solar & inverter sets with potentially a battery addition', which is a staged plan: panels now, battery later (plug-in batteries may become legal in 2027). They will also ask 'what if I add a second kit later?'. The spec's finance has one capex at year 0 and no notion of a later purchase. Nothing explains the legal ways to grow: one plug-in kit per home and no extra panels, but a wired system alongside up to 16 A/phase, a power station with its own panels, or the proposed one-kit-per-circuit rule.
AMENDMENT: CostItem = { label, gbp, year: 0 }. year > 0 means bought later, in nominal £ in that year.
System.upgrade?: { atYear: 1..10, label, battery?: Battery, addArrays?: PvArray[], route?: 'hardwired'|'whatif', costs: CostItem[] }
Finance:
- The upgrade is bought at the end of year atYear; its costs are discounted by (1+r)^atYear.
- Stage-2 savings (the system with the upgrade merged, simulated once) apply from year atYear+1.
- The battery SoH/EOL clock starts at atYear.
Design and Compare get an 'Add later…' action on every scenario card: choose a catalog battery, a what-if plug-in battery or an extra hardwired array, plus the year.
answers.growth:
- Collapsed: 'One plug-in kit per home, used as sold — but there are other ways to grow.'
- Bullets:
  · 'You can only have one plug-in kit, and you can't add panels to it (it must match its ENA registration). The biggest kit on sale here is {maxWp} W.'
  · 'An electrician-installed system can sit alongside it up to 3.68 kW in total (16 A per phase), as long as there's no battery while you keep the plug-in kit: best here {hardwiredBest.name}, £{capex}, £{sav}/yr.'
  · 'A power station with its own panels isn't connected to the grid: {U3.name}, £{sav}/yr.'
  · 'If the rules change: a second kit (one per circuit, proposed) would add £{W3.sav − bestBuy.sav}/yr, and adding a plug-in battery later (W2) makes the whole plan pay back in {W2.payback} yrs.'
Acceptance:
- NPV(W2) = NPV(S01) + Σ_{y≥atYear+1}(Sav2_y − Sav1_y)/(1+r)^y − 1049.99/(1+r)^atYear, within ±£1.
- An upgrade with atYear beyond the horizon gives the same finance as no upgrade.

### [minor] §3.2 Finance (VAT sentence) + §3.1 Dataset/SimResult
PROBLEM: 'keep simple: apply VAT ratio by year' is undefined. The dataset was billed at 5% VAT, but year 1 forward is 0% until 31 Mar 2027 and 5% afterwards. Export income has no VAT, so scaling total savings by a VAT ratio is wrong whenever export is paid (Octopus Prime). The verdict's '£/yr' must state which year it means.
AMENDMENT: Dataset gains importPriceExc: Float64Array.
SimResult.monthly[] gains:
- importSavingsExcP = Σ (load_t − gridImport_t)·importPriceExc_t. Grid charging and standby are included through gridImport.
- exportIncomeP (no VAT).
'Last 12 months' figures use the VAT actually charged in each slot.
Projection:
- Year y covers the 12 months starting on the 1st of the month after today; y=1 is Nov 2026 – Oct 2027.
- Sav_y = Σ_k [importSavingsExcP[cm_k]·(1+vat(D_k)) + exportIncomeP[cm_k]] × deg_y × (1+e)^(y−1). The battery part is additionally × SoH_y/SoH_1.
- vat() comes from vat.js: 0% until 2027-03-31T23:00Z, then 5%. Toggle 'Assume VAT on electricity returns to 5% in April 2027', default on.
Verdict wording: 'saves £X in your first year (Nov 2026 – Oct 2027)'.
Acceptance:
- With e=0, deg=1 and 5% VAT throughout, Sav_1 equals the as-billed 12-month savings within 0.5%.
- With the default schedule and a flat monthly profile, Sav_1 = savExc·(5/12 + 7/12·1.05) + export, within 0.5%.

### [minor] §4 item 3 Design (field set, labels, jargon)
PROBLEM: The Design editor shows every physics and dispatch knob at once: mounting, horizon, bifacial, DC model, per-input caps, 5 strategies, replanAt, socLevels, wear. The route and strategy names (plugin/hardwired/ups/whatif, self/fixed/schedule/smart/optimal, MPPT, SoC, clipping, curtailment) are engineer jargon, and adding a battery to a plug-in kit leads to an error with no way forward.
AMENDMENT: Split the editor.
Simple (default):
- Start from: kit or station dropdown, grouped by route label
- Where: spot dropdown, or compass + tilt
- Battery: None / catalog battery / Add later…
- Automation: Realistic / Best case
- Price £ (editable)
- Export: auto from the kit
Advanced (<details>, remembered per device): mounting, shading %, horizon, bifacial, DC model, inverter limits and efficiency, per-input wiring, battery efficiencies/standby/min charge, strategy variants, replan time, SoC levels, wear, cost lines, finance overrides.
Route labels and one-liners:
- plugin: 'Plug into a socket (DIY)' — 'Legal since 27 Aug 2026 · up to 800 W out and 2000 W of panels · one per home · register at myplugin.solar'
- hardwired: 'Wired in by an electrician' — 'Needed for any battery today · about £350 to install · up to 3.68 kW'
- ups: 'Power station for the servers' — 'Charges from a socket and runs the servers from its own outlets · no grid connection, nothing to register'
- whatif: 'Future rules (not legal yet)' — 'Plug-in batteries (hoped for 2027) or more than one kit per home'
Results are grouped:
- Money: Saves/yr (typical) · Payback · Ahead after 10 yrs
- Energy: Made kWh · Used at home % · Lost kWh
- Details (collapsed): NPV, IRR, LCOE/LCOS, lost to the 800 W limit, switched off at negative prices, exported paid/unpaid, p per kWh made, 4–7pm share, cycles
UI copy swaps:
- self-consumption → 'used at home'
- clipping → 'lost to the 800 W limit'
- curtailed → 'switched off at negative prices'
- MPPT → 'solar input'
- SoC → 'charge level'
- G98 and ESQCR appear only in Method.

### [minor] §4 header ('Responsive down to 375 px') — mobile priorities
PROBLEM: 'Responsive down to 375 px' gives no priorities. The verdict, ranked table, side-by-side compare, polar rose and data-dense tile rows need explicit mobile behaviour, or the answer ends up below the fold behind tiles and wide tables.
AMENDMENT: Mobile (≤ 600 px):
- Header 44 px: app name plus the dataset chip collapsed to '{region} · {days} d' (tap → #data). The scenario picker moves into Design and Compare.
- Tabs: sticky and horizontally scrollable (scroll-snap); the active tab scrolls into view.
- Verdict order: context line (≤ 2 lines) → best-buy card → top 5 option cards ('Show all {n}') → Your questions (collapsed) → usage tiles → cost-vs-saving chart (collapsed, 'Show chart').
- Stat tiles: at most 2 per row; figures 24 px mono.
- Every table becomes a card list: title, primary figure right-aligned, and 2 secondary figures. No horizontal page scroll anywhere.
- Charts: width = viewport − 32 px, minimum height 200 px, tap for tooltips, and a 'Table' toggle.
- Below 480 px the solar rose is replaced by a 'Top 10 directions' list, with the rose behind 'Show rose'.
- Inputs: single column; number fields use inputmode='decimal'; compass dial ≥ 200 px; touch targets ≥ 44 px; a sticky bottom 'Re-run' bar appears when inputs have changed.
Acceptance (agent-browser at 375×812, demo data):
- On every tab, document.documentElement.scrollWidth ≤ 375.
- On #verdict, the bottom of the best-buy card is within 1.5 viewport heights of the page top.
- All tap targets are ≥ 44×44 px.

### [minor] §4 Charts (new subsection: essential vs optional)
PROBLEM: The spec lists many charts with equal priority: heatmaps, negative-price counts, Agile vs Flexible, monthly 16–19 share, the polar rose, hour-of-day lines, panel and battery curves. Some of them answer the user's questions and others are noise. The key decision chart (cost vs saving with payback lines) and the trade-off chart (kWh vs p/kWh) are missing.
AMENDMENT: Essential (rendered by default, each with a table twin):
- Verdict: 'Cost vs yearly saving' scatter. x = capex £, y = typical £/yr, coloured by route, Pareto front joined, p10–p90 whiskers. Dashed payback isolines y = x/n for n = 2, 3, 5, 10, labelled 'pays back in n yrs'. Also the tornado and the base-load curve inside their question cards.
- Usage: the 48-slot average load profile stacked above the 48-slot average price profile (shared x, 16–19 shaded); always-on load monthly median with a p10–p90 band; monthly bill bars (energy + standing).
- Design: typical-day stacked area (used at home, battery, grid import, export, lost to the 800 W limit) with Summer / Winter / Pick a date; monthly savings bars (typical solid, last 12 months as an outline); cumulative cash flow with the weather band and a payback marker.
- Orientation: Energy vs value scatter; solar rose (£); hour-of-day generation lines (current / best £ / W90).
- Compare: side-by-side table; battery-size steps; base-load curve.
Optional, under 'More charts': load and price heatmaps, negative-price slots, Agile vs Flexible, monthly 4–7pm share, clipping by month, panel-count curve.
Never: dual axes, pies, 3D.

### [minor] §4 Verdict best-buy card ('Next steps') + Method/Verdict export (print)
PROBLEM: The user wants data to back up a purchase, and may need to show it to someone else. The spec exports only CSV and JSON. After the verdict there is no 'what do I do now': socket and RCD check, mounting direction, the myplugin.solar registration (a legal requirement), the >960 Wp check, Octopus Prime sign-up after DNO approval, electrician quotes, or 0% VAT through an installer.
AMENDMENT: 'Next steps' are generated from the scenario, and each step links to its source.
plugin:
1. 'Check the socket's circuit has RCD/RCBO protection — plug straight in, no extension leads or adaptors.'
2. 'Mount it facing {compass} at {tilt}° ({spot.name}).'
3. 'Register it at myplugin.solar — it's a legal requirement.'
4. If DC > 960 Wp: 'Ask an electrician to check the circuit (advised above 960 W of panels).'
5. Octopus kit: 'After your network operator approves it, switch on Outgoing Prime in your Octopus account.'
6. Pre-order or not available: 'Delivery: {availability}.'
hardwired:
- 'Get quotes from a Part P electrician for a dedicated circuit + G98 notification (we assumed £350; +£400–900 if your consumer unit needs replacing).'
- 'Buying the kit through the installer may qualify for 0% VAT until 31 Mar 2027 — about £{hardware/6} less.'
ups:
- 'Put the servers on the power station's outlets, keep bypass on, and set up {its TOU mode | a smart plug on its mains lead driven by Agile prices, e.g. Home Assistant}.'
Print: a 'Save as PDF' button on Verdict and Compare.
- @media print uses a light background, keeps the accent for headings, and prints chart table twins below each chart.
- Includes the context line, an assumptions block, and 'Prices checked 5 Oct 2026'.
- Never includes the API key or account number.

### [minor] §4 item 1 Data › Details + dataset.js (pre-existing solar, partial year)
PROBLEM: Two data traps would quietly corrupt the answer:
- After any solar is installed, the meter reads import net of solar, so including that period understates demand. The research notes this, but the UI never asks.
- With less than a year of history, the spec annualises by ×365/days, which is seasonally biased: summer-only data inflates solar value.
AMENDMENT: Data › Details adds 'Already have solar or a battery? Installed on [date]'. Slots from that date are dropped from load, because they are net of generation. At least 180 days must remain; otherwise show the error 'Not enough usage from before your install'.
If days < 330:
- Annualise per calendar month instead of ×365/days.
- Fill each missing month with the nearest available month's weekday/weekend 48-slot mean profile (loadFilled = 1).
- The verdict context says '{k} months of your usage are estimated', and confidence is at most medium.
Phase 2 (optional): Method › 'Check my savings after installing': compare the scenario's predicted import reduction from the install date with the metered import.