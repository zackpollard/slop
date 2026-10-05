# Solar Calculator

What would plug-in solar, a battery or a power station have saved *you*? This tool replays your
real half-hourly electricity use against your real Octopus tariff prices and satellite sunshine
for your home, half-hour by half-hour, and tells you what to buy, what it pays back and why.

Live at **[solar-calculator.slop.zackpollard.pro](https://solar-calculator.slop.zackpollard.pro)**.

Everything runs in the browser. Your Octopus API key is only ever sent to `api.octopus.energy`
and is kept in memory unless you tick "Remember on this device".

## What it answers

The **Verdict** tab answers the questions first, with the working one click away:

- **What should I buy?** Every option is simulated against your own year and ranked on 10-year value:
  the plug-in kits on sale in GB, electrician-installed solar + battery systems, and power stations
  running your servers. You get a best buy, a runner-up, payback, a weather range and the cash flow.
- **Should the panels face west for the 4–7pm Agile peak?** A sweep of every direction and tilt
  (the "solar rose") shows the trade-off: west makes fewer kWh but each is worth more. You get the
  best direction, the range that is within 3% of it, and the conditions that would flip the answer.
- **What does a battery add?** The extra saving over panels alone, split into storing your own solar
  and shifting cheap Agile slots, minus standby losses — realistic automation and a perfect-hindsight
  best case side by side.
- **Is a power station for the servers worth it?** Modelled with measured conversion losses: what
  Agile-aware charging earns, what a simple 4–7pm smart-plug cut earns, and why running servers
  through the inverter all day costs money.
- **How sure is this?** Confidence ratings and a tornado of what moves the payback most (weather
  year, shading, price level, price trend, always-on load, battery automation).
- **How much does my always-on load matter?** Savings and payback against base load, plus what
  simply cutting 100 W would save on its own.

The other tabs are the workings: **Usage** (always-on load, the 4–7pm share of your bill, load and
price profiles, heatmaps, monthly bills), **Compare** (leaderboard, options beaten on both price and
savings, step-ups, side-by-side pins, panel and battery sizing), **Design** (build or tweak any
system), **Orientation** (the solar rose and energy-vs-value chart) and **Method** (assumptions,
sources, regulations, exports).

## Getting your data in

- **Octopus account** — paste your API key (Octopus website → Your account → Personal details →
  API access). The account number is optional; the tool can find it. It reads your property,
  import meter(s), tariff agreements and the last year of half-hourly consumption, then prices each
  half-hour with *your* tariff history.
- **Example data** — a real year of London Agile prices and satellite sunshine with a synthetic
  household plus a server load you can slide.
- **CSV** — Octopus's "download your data" export or any `timestamp,kWh` file.
- **By hand** — base load and annual use, for a quick estimate.

## How it works

1. **Usage.** Half-hourly import readings, merged across meter exchanges, joined to every other
   series on UTC epoch milliseconds. Gaps are filled from the same half-hour and day type nearby and
   flagged; the always-on load is the median of each day's quietest readings.
2. **Prices.** Unit rates for each tariff agreement in force (Agile versions keep their own caps and
   standing charges), with VAT applied from a schedule because the API back-dates today's 0% rate on
   long records. A forward basis removes the 3.5p Agile levy cut in April 2026, applies 0% VAT until
   31 March 2027 and 5% after, and projects year one from the 1st of next month.
3. **Sunshine.** Open-Meteo's SARAH-3 satellite irradiance at 30-minute resolution, aligned to
   Octopus half-hours (with a correction for the satellite's scan timing), gaps filled from MSG and
   then the ECMWF IFS archive. The headline uses a **typical year**: each month scaled to its
   2006–2025 average at your grid cell. The last 12 months in London were sunnier than every one of
   the previous 20 years, so "as it happened" figures are shown second, and the 2006–2025 range gives
   the weather band.
4. **Panels.** NOAA sun position, Perez transposition, Martin–Ruiz angle losses, Faiman cell
   temperature, PVWatts DC with low-light losses, a loss stack and shading/horizon, three sub-samples
   per half-hour, then the micro-inverter: per-input DC and AC caps, the PVWatts efficiency curve and
   the 800 W plug-in limit applied sample by sample.
5. **Batteries and power stations.** DC-coupled, AC-coupled and UPS-style power stations, each with
   its own physics (shared inverter limit, conversion losses, bypass overhead, standby draw). Strategies:
   follow the load, fixed output, a simple timer, realistic Agile-aware day-ahead planning, a rolling
   re-plan when tomorrow's prices publish, and perfect-hindsight dynamic programming as the upper bound.
6. **Money.** Savings against your own bill, both as billed and on the forward basis; payback,
   discounted payback, NPV, IRR, LCOE/LCOS, panel degradation, battery ageing and end of life,
   inverter replacement and staged "add a battery later" plans.
7. **Rules.** GB's legal envelope as of October 2026 is enforced, with one-click fixes.

## The rules it applies (GB, October 2026)

- Plug-in solar has been legal since **27 August 2026** (SI 2026/848, DESNZ Interim Product
  Specification v2.0, Ofgem's G98 amendment): an ENA-listed complete kit, at most **800 VA** out and
  **2000 Wp** of panels (professional check advised above 960 Wp), up to 4 modules, one device per
  household, registered at [myplugin.solar](https://myplugin.solar/), no extension leads.
- **Plug-in batteries are not allowed.** Any grid-tied battery is a hardwired G98 install by an
  electrician (the tool adds about £350). Plug-in batteries can still be explored as "future rules".
- A **power station** that charges from a socket and powers the servers from its own outlets never
  runs in parallel with the grid, so it sits outside G98 — the tool treats it as an appliance.
- Export from plug-in kits is unpaid (no MCS certificate), except Octopus's own kits, which unlock
  **Outgoing Prime** (16p 4–7pm, 9p otherwise).

Prices and specifications in `data/kits.json` and `data/stations.json` were checked on 3–5 October
2026 and are editable in the Compare tab.

## Code

No build step: the page loads ES modules directly, and the engine runs in a module Web Worker.

| Module | Responsibility |
|--------|---------------|
| `js/time.js`, `js/vat.js` | UK clock changes, half-hour indexing, the VAT schedule |
| `js/sun.js`, `js/pv.js` | Sun position, clear sky, transposition, IAM, temperature, DC and inverter model |
| `js/weather.js` | Open-Meteo satellite/archive fetches, slot alignment, climatology |
| `js/octopus.js`, `js/csv.js`, `js/demo.js`, `js/dataset.js`, `js/cache.js` | Getting usage and prices in and building the half-hourly dataset |
| `js/system.js`, `js/battery.js`, `js/simulate.js`, `js/finance.js`, `js/insights.js` | Systems, dispatch, valuation, money, usage analysis |
| `js/kits.js`, `js/rules.js`, `js/scenarios.js`, `js/sweep.js`, `js/core.js` | Catalog, legal rules, the ready-made options, sweeps, the cached `SolarEngine` |
| `js/verdict.js` | The answer-first verdict |
| `js/worker.js`, `js/engine.js` | Worker transport (the API key never leaves the worker except to Octopus) |
| `js/app.js`, `js/store.js`, `js/ui.js`, `js/charts.js`, `js/map.js`, `js/views/*` | The page: routing, state, components, canvas charts, Leaflet map, tabs |

`gallery.html` is an unlinked dev page showing every component and chart with fake data.
`scripts/` holds dev-only tools: `build-demo.mjs` rebuilds `data/*.json` from the research
snapshots, and the `a1-*` scripts regenerate the physics test fixtures. Nothing in `scripts/` runs
in the browser.

## Tests

The engine is pure ES modules, so it is tested directly with vitest in `lib/slopnet`:

```bash
cd lib/slopnet && npm install && npx vitest run __tests__/solar-
```

Besides unit tests (sun position and transposition against pvlib, the alignment rules, Octopus
paging and VAT, battery energy conservation for every strategy, finance hand cases), the
acceptance tests replay the bundled demo year end to end and check published reference numbers:
Agile price statistics, PVGIS-consistent yields for eight orientations, power-station results and
the verdict.

## Data and credits

Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Solar radiation © EUMETSAT,
CM SAF SARAH-3 ([doi:10.5676/EUM_SAF_CM/SARAH/V003](https://doi.org/10.5676/EUM_SAF_CM/SARAH/V003))
and LSA SAF; temperature and wind from ECMWF IFS. Usage, tariffs and prices from the Octopus Energy
API. Postcode lookup by postcodes.io. Map imagery © Esri and © OpenStreetMap contributors. Not
affiliated with Octopus Energy. Estimates, not financial advice.

## Local development

```bash
cd projects/solar-calculator
python3 -m http.server 8000
```
