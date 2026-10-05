Agile region C over 2025-10-01 to 2026-10-01 (17,520 real half-hours from AGILE-24-10-01, the only Agile import product live in that window) averaged 19.99p/kWh including 5% VAT. The 16:00-19:00 peak averaged 34.83p against 17.87p for the rest of the day, 2.84% of slots were negative (minimum -11.28p) and the 100p cap was never reached (maximum 86.73p).
- **Your 500 W base load:** a constant 500 W cost £875.69/yr on Agile, against £1,137.29 on Flexible Octopus (direct debit) over the same year. That works out to about £175 per year for every 100 W of base load.
- **Battery arbitrage:** moving 1 kWh from the cheapest 3 hours overnight to the 16:00-19:00 peak was worth 19.4p/kWh on average (16.7p net at 85% round-trip efficiency). Summer midday is now cheaper than overnight.
- **Pricing formula:** I confirmed it from the data. Import excluding VAT = 2.00×wholesale + 12p (16:00-19:00) − 3.333p from 1 April 2026; that cut is 3.5p including VAT. Agile Outgoing ≈ 0.95×wholesale + 1.30p, or + 7.23p in the peak, and never goes below 0. The Outgoing constants are fitted from the data, not published by Octopus.
- **VAT:** VAT on domestic electricity is 0% from 1 Oct 2026 to 31 Mar 2027. The API's value_inc_vat already equals value_exc_vat from that date.
- **Panel direction:** facing panels west to catch the peak does not pay off here. West-vertical earns 23.2p per kWh it makes, against 17.8p for south at 35°, but it makes half the energy. Per kWp, south-west 35° (£180/yr) ≈ south 35° (£179) > west-vertical (£117).
- **Dispatch:** I built and benchmarked a JS reference with five strategies, ending in an optimal DP. A full-year DP takes 30-560 ms at N=21-161 state-of-charge levels; N=41 is within 0.7% of N=321. Re-planning daily at 16:00 matches perfect foresight for a 2 kWh battery and is within 1-4% for 5 kWh.
- **Benchmark results** (1.8 kWp south at 35°, 800 W inverter, export unpaid): solar only saves £232/yr. Adding a 2 kWh DC battery saves £314 with simple self-consumption and £378 with the optimal DP plus grid charging.
- **UK rules:** the government's plug-in solar specification (DESNZ v2.0, July 2026) explicitly excludes plug-in batteries and solar kits with built-in batteries. A secondary source also says plug-in solar cannot get export payments yet.
=====
# Agile economics and battery dispatch for the solar-calculator: research report

Everything below was checked live on 2026-10-05 against the real Octopus data unless marked [doc] (read in documentation) or [inferred]. Paths to the files are at the end.

---
## 0. Data access (verified live)

| Item | Finding |
|---|---|
| Products | Only one Agile import product was live during the window, `AGILE-24-10-01` (checked with `/v1/products/?available_at=` on 2025-10-01, 2026-01-15, 2026-04-01 and 2026-07-01). The export product is `AGILE-OUTGOING-19-05-13`. The flat tariff is `VAR-22-11-01` (Flexible Octopus). Older versions `AGILE-23-12-06` and `AGILE-24-04-03` still publish rates **identical** to `AGILE-24-10-01` for region C (checked for 2026-09-16). `AGILE-FLEX-22-11-25` returns nothing. The app should still use each agreement's `tariff_code` and its valid_from/valid_to dates from the account endpoint. |
| Unit rates URL | `https://api.octopus.energy/v1/products/AGILE-24-10-01/electricity-tariffs/E-1R-AGILE-24-10-01-C/standard-unit-rates/?period_from=2025-09-30T23:00:00Z&period_to=2026-09-30T23:00:00Z&page_size=1500` |
| Paging | `page_size` is **silently capped at 1500**: asking for 25000 still returns 1500 rows plus a `next` link. A full year is 17,520 rows = 12 pages at about 0.33 s each. Results come **newest first**. You can fetch the pages in parallel because `count` gives the total up front. |
| Row shape | `{value_exc_vat, value_inc_vat, valid_from, valid_to, payment_method}`. `payment_method` is `null` on every Agile row (17,520 of 17,520), so there are no direct-debit/non-direct-debit duplicates and all 17,520 `valid_from` values are unique. Flexible **does** have both `DIRECT_DEBIT` and `NON_DIRECT_DEBIT` rows per period, so filter to `DIRECT_DEBIT`. |
| CORS | Public GETs return `access-control-allow-origin: *`. An OPTIONS preflight with `Access-Control-Request-Headers: authorization` on `/v1/electricity-meter-points/.../consumption/` returns 200 with `access-control-allow-headers: accept, authorization, ...` and `access-control-max-age: 86400`, so authenticated browser calls work. PVGIS (`re.jrc.ec.europa.eu`) sends **no** ACAO header and cannot be called from the browser. |
| VAT change | Every row from `2026-09-30T23:00Z` (00:00 BST on 1 Oct) has `value_inc_vat == value_exc_vat`. Before that, inc = 1.05 × exc. This matches gov.uk "Breathing space on your energy bill" (published 26 Aug 2026): **0% VAT on domestic electricity, covering unit rates and standing charges, from 1 Oct 2026, funded to 31 Mar 2027.** Always use `value_inc_vat` per slot. For projections, add an option to bring back the 1.05 factor from April 2027. |
| Current flat rate (region C, direct debit) | Flexible `VAR-22-11-01`: **26.5956 p/kWh** and standing charge **41.3869 p/day** from 2026-10-01 (0% VAT). The four quarters of the analysis year, including VAT, were 25.63, 27.00, 24.90 and 26.35 p. Agile region C standing charge: **37.6525 p/day**. Ofgem cap for Oct-Dec 2026 [doc]: 26.32 p/kWh and 54.83 p/day, excluding VAT. |
| Fixed Outgoing (`OUTGOING-VAR-24-10-26`, region C) | 15 p/kWh until 2026-03-01, then **12 p/kWh**. |
| Publication | The last published slot (seen at 00:40 BST on 5 Oct) ends at 23:00 BST on 5 Oct. Agile "days" run **23:00 to 23:00 UK time**. Octopus [doc]: "Between 4-8pm every day (usually nearer 4pm), your unit rates are updated for the next 24 hours." So at about 16:00 on day D, prices are known up to 23:00 on day D+1, which is 31 h or 62 slots ahead (60 or 64 on clock-change days). |

## 1. Agile pricing mechanics (2026)

**Import** [doc: octopus.energy/blog/agile-pricing-explained, which carries an April 2026 update]:
`price_exVAT = min(95, D×W + P×[16:00 ≤ local < 19:00] − 3.333×[t ≥ 2026-04-01])`, then `price_incVAT = price_exVAT × (1 + VAT)`.
- W is the wholesale day-ahead price in p/kWh. Secondary sources say it is the EPEX GB half-hourly auction; Agile prices do differ between the two halves of each hour.
- The 95p cap gives 100p including 5% VAT ("Price Cap Protect 100p/kWh"). With 0% VAT it is unclear whether the cap is now 95p or 100p. It does not matter in practice: the maximum seen was 86.73p.
- April 2026: "Agile half-hourly unit rates will automatically be 3.5 p/kWh lower after 1 April 2026" (Government levy removal). 3.5p including VAT is 3.333p excluding VAT.
- D/P values by region, from the blog: A East England 2.10/13, B East Midlands 2.00/14, **C London 2.00/12**, D Merseyside & N Wales 2.20/13, E West Midlands 2.10/12, F North East 2.10/12, G North West 2.10/12, H Southern 2.10/12, J South East 2.20/12, K South Wales 2.20/12, L South West 2.30/11, M Yorkshire 2.00/13, N South Scotland 2.10/13, P North Scotland 2.40/12.
- **Negative prices ("Plunge Pricing")** are passed through with no floor: the minimum seen was −11.28p including VAT (−10.74 excluding) on 2026-04-05 at 12:30. VAT applies to negative prices too: inc = 1.05 × exc.

**Checked against the data:**
- I regressed import (excluding VAT) on Agile Outgoing for the same slot. The slope is **2.1053 = 2.00/0.95** in every subset, with RMSE 0.007p.
- Off-peak intercepts: −2.734 before April and −6.077 after. The shift of −3.343 matches the 3.333p levy cut.
- Cross-check against Nord Pool N2EX hourly prices (Sept 2026; only about the last 30 days are served without auth): import off-peak ≈ 2.02×N2EX − 3.62, import peak ≈ 1.95×N2EX + 9.50.

**Agile Outgoing** [inferred from the fit; I found no official published constants]: `export = max(0, 0.95×W + 1.30)` off-peak and `max(0, 0.95×W + 7.23)` from 16:00 to 19:00, so the peak uplift is about 5.93p. Export has no VAT. It **floors at 0**: 34 slots sat at exactly 0.00 while import was ≤ 0, and the minimum seen was 0.0. The maximum seen was 42.35p.

## 2. A year of real data, region C, 2025-10-01 to 2026-10-01 local (prices include 5% VAT unless stated)

Overall:
- Mean 19.99p (19.04p excluding VAT), median 18.54p, standard deviation 9.49p.
- **16:00-19:00 mean 34.83p, rest of day 17.87p, so the peak premium is 16.96p.**
- Negative slots: 497 (2.837%). Slots at or below zero: 508 (2.90%). Below 10p: 9.34%. Above 35p: 6.35%.
- Percentiles (p): p0 −11.28, p1 −3.51, p5 3.38, p10 10.50, p25 15.43, p50 18.54, p75 24.36, p90 32.55, p95 36.37, p99 46.55, p100 86.73.
- Season, winter (Nov-Feb): mean 18.85p, peak 34.28p, rest 16.64p, 0.035% negative.
- Season, summer (May-Aug): mean 21.19p, peak 33.87p, rest 19.38p, 2.74% negative.
- Agile Outgoing: mean 11.17p, 16:00-19:00 mean 18.08p, rest 10.18p.

Mean price by local half-hour (p/kWh; each row is HH:00 / HH:30):

| hour | all | winter Nov-Feb | summer May-Aug | Outgoing |
|---|---|---|---|---|
| 00 | 17.10/17.37 | 14.17/15.29 | 20.46/20.09 | 9.83/9.96 |
| 01 | 16.77/16.39 | 14.81/13.89 | 19.35/19.35 | 9.68/9.51 |
| 02 | 16.36/15.79 | 13.92/13.48 | 19.12/18.49 | 9.50/9.24 |
| 03 | 15.88/15.48 | 13.57/13.17 | 18.56/18.20 | 9.28/9.10 |
| 04 | 16.09/15.82 | 13.57/13.34 | 18.91/18.59 | 9.38/9.25 |
| 05 | 17.22/17.35 | 14.41/14.25 | 19.80/19.82 | 9.88/9.94 |
| 06 | 18.57/20.16 | 15.90/17.03 | 20.14/21.56 | 10.50/11.21 |
| 07 | 19.61/21.01 | 17.52/19.32 | 19.99/20.89 | 10.97/11.60 |
| 08 | 19.48/19.55 | 18.63/19.50 | 19.12/18.83 | 10.91/10.94 |
| 09 | 18.58/17.73 | 18.80/18.60 | 17.96/17.12 | 10.50/10.12 |
| 10 | 16.93/16.17 | 18.02/17.79 | 16.45/15.61 | 9.75/9.41 |
| 11 | 15.58/15.11 | 17.54/17.44 | 14.99/14.51 | 9.15/8.94 |
| 12 | 15.03/14.80 | 17.42/17.44 | 14.42/14.11 | 8.90/8.80 |
| 13 | 14.86/14.55 | 17.77/17.62 | 13.98/13.57 | 8.83/8.69 |
| 14 | 14.87/14.94 | 18.14/18.25 | 13.68/13.57 | 8.83/8.86 |
| 15 | 15.52/16.65 | 18.56/20.13 | 14.14/14.70 | 9.13/9.63 |
| **16** | **30.60/32.85** | 33.10/35.15 | 28.98/30.05 | 16.17/17.18 |
| **17** | **34.57/36.13** | 34.50/34.86 | 33.12/34.69 | 17.97/18.67 |
| **18** | **37.26/37.58** | 34.46/33.60 | 37.68/38.72 | 19.18/19.33 |
| 19 | 24.73/24.12 | 19.89/18.66 | 27.56/27.77 | 13.28/13.01 |
| 20 | 23.57/22.61 | 18.36/17.27 | 27.56/27.50 | 12.76/12.33 |
| 21 | 22.57/20.91 | 17.86/16.41 | 26.92/26.01 | 12.31/11.56 |
| 22 | 20.26/18.32 | 16.34/14.68 | 24.41/22.80 | 11.26/10.38 |
| 23 | 18.67/17.56 | 15.65/14.64 | 22.05/21.34 | 10.55/10.04 |

What this shows:
- In summer the cheapest time is **midday** (11:00-15:00, about 13.6p), cheaper than overnight (about 18.5p), because of solar oversupply.
- In summer, 19:00-23:00 stays expensive (22-28p).
- In winter the cheapest time is overnight (about 13.2p).

Monthly figures (p/kWh). "Peak − midday" is the 16:00-19:00 mean minus the 11:00-14:00 mean. The Outgoing column is mean / 16:00-19:00 mean.

| month | mean | 16-19 | rest | 11-14 | 00-07 | peak − midday | % negative | min | max | Outgoing |
|---|---|---|---|---|---|---|---|---|---|---|
| 2025-10 | 16.52 | 33.84 | 14.05 | 14.06 | 11.31 | 19.78 | 3.49 | −4.20 | 59.22 | 8.80/16.84 |
| 2025-11 | 17.95 | 34.75 | 15.55 | 16.37 | 12.98 | 18.37 | 0 | 0.21 | 58.65 | 9.45/17.25 |
| 2025-12 | 17.39 | 31.94 | 15.31 | 16.69 | 12.85 | 15.25 | 0.13 | −0.21 | 39.28 | 9.20/15.98 |
| 2026-01 | 21.54 | 37.32 | 19.28 | 20.47 | 16.70 | 16.85 | 0 | 2.31 | 63.84 | 11.07/18.41 |
| 2026-02 | 18.45 | 33.01 | 16.37 | 16.48 | 14.84 | 16.53 | 0 | 3.99 | 38.47 | 9.67/16.46 |
| 2026-03 | 21.55 | 39.19 | 19.03 | 16.47 | 17.82 | 22.73 | 0.34 | −0.21 | 52.92 | 11.08/19.26 |
| 2026-04 | 15.45 | 27.89 | 13.67 | 7.77 | 14.04 | 20.12 | 10.07 | −11.28 | 41.24 | 9.92/15.73 |
| 2026-05 | 20.06 | 32.25 | 18.32 | 15.46 | 17.80 | 16.79 | 0 | 9.93 | 39.75 | 11.99/17.71 |
| 2026-06 | 18.97 | 32.51 | 17.04 | 11.68 | 16.44 | 20.83 | 4.38 | −8.54 | 76.50 | 11.50/17.82 |
| 2026-07 | 20.52 | 31.90 | 18.90 | 12.32 | 19.84 | 19.58 | 4.70 | −6.58 | 49.84 | 12.20/17.55 |
| 2026-08 | 25.15 | 38.78 | 23.20 | 17.51 | 23.66 | 21.28 | 1.95 | −4.16 | 68.65 | 14.29/20.66 |
| 2026-09 | 26.18 | 44.42 | 23.57 | 14.42 | 24.13 | 30.00 | 9.10 | −5.04 | 86.73 | 14.76/23.21 |

**Cost of a constant 500 W base load (4,380 kWh/yr, standing charges excluded):**
- Agile as billed: **£875.69**, which is 19.99p average. At 0% VAT the same year would be £833.99.
- Flexible direct debit over the same year as billed: **£1,137.29** (25.97p average). Agile saved £261.61.
- At the current Flexible rate of 26.5956p: £1,164.89, against Agile at 0% VAT £833.99, a difference of £330.90.
- About £175.14/yr per 100 W. 21.8% of the Agile cost (£190.70) falls in the 16:00-19:00 window.

**What a battery could earn from arbitrage.** For each day, take the mean of the six 16:00-19:00 slots minus the mean of the 6 cheapest slots between 23:00 the night before and 07:00:

| month | peak | cheapest 3h overnight | spread | spread using cheapest 3h at any time (19:00 the day before to 16:00) | net value at 85% round trip |
|---|---|---|---|---|---|
| 2025-10 | 33.84 | 10.00 | 23.83 | 24.06 | 22.07 |
| 2025-11 | 34.75 | 11.79 | 22.96 | 23.04 | 20.88 |
| 2025-12 | 31.94 | 11.75 | 20.19 | 20.25 | 18.12 |
| 2026-01 | 37.32 | 15.68 | 21.64 | 21.74 | 18.87 |
| 2026-02 | 33.01 | 13.88 | 19.13 | 19.23 | 16.68 |
| 2026-03 | 39.19 | 15.77 | 23.43 | 25.31 | 20.65 |
| 2026-04 | 27.89 | 12.38 | 15.51 | 21.76 | 13.32 |
| 2026-05 | 32.25 | 16.73 | 15.52 | 17.79 | 12.57 |
| 2026-06 | 32.51 | 14.99 | 17.52 | 22.35 | 14.87 |
| 2026-07 | 31.90 | 18.14 | 13.76 | 20.44 | 10.56 |
| 2026-08 | 38.78 | 22.23 | 16.55 | 22.54 | 12.63 |
| 2026-09 | 44.42 | 21.91 | 22.51 | 31.36 | 18.64 |

- Annual means: spread 19.38p; 22.49p using the "any time" window; net 16.65p at 85% round trip.
- The net value was negative on 0 of 365 days.
- Delivering 1 kWh every day is worth about **£60.77/yr** (85% round trip, before wear and standby). From April to September the cheapest charging slots are at midday, not overnight.

**What panel orientation is worth** (PVGIS v5.3 hourly London 2023, 1 kWp, 14% loss, matched onto the price year by month/day/UTC hour; see `agile-econ/orientation-value.json`):

| orientation | kWh/kWp/yr | generation-weighted import price (p) | £/kWp/yr if all self-used | share made 16:00-19:00 | £/yr, 0.8 kWp feeding a 500 W load |
|---|---|---|---|---|---|
| SW35 | 944 | 19.05 | 179.88 | 20.8% | 141.51 |
| S35 | 1007 | 17.80 | 179.23 | 14.0% | 140.81 |
| SW60 | 880 | 19.68 | 173.22 | 23.4% | 136.07 |
| W35 | 795 | 20.04 | 159.25 | 25.9% | 125.98 |
| flat | 850 | 17.94 | 152.39 | 15.8% | 121.44 |
| W60 | 697 | 21.42 | 149.33 | 31.5% | 117.47 |
| E35 | 811 | 16.95 | 137.57 | 7.5% | 108.88 |
| SW90 | 660 | 20.55 | 135.61 | 26.7% | 108.16 |
| S90 | 720 | 17.52 | 126.15 | 10.7% | 100.17 |
| W90 | 503 | 23.18 | 116.61 | 38.2% | 93.04 |
| E90 | 510 | 17.48 | 89.10 | 5.4% | 71.09 |

Turning panels toward the peak raises the value of each kWh by up to 30%, but loses more energy than that. South-west at a moderate tilt is the sweet spot. West-vertical (a balcony railing) earns about 35% less than south at 35°.

There is a timing caveat. PVGIS hourly values are stamped at HH:10 UTC, and I applied each value to both half-hours of that hour, so the 16:00-19:00 shares could be off by about 20 minutes. The PV-modelling research should settle how to align them.

## 3. Battery dispatch model and strategies

### 3.1 What happens in each half-hour slot (Δt = 0.5 h; energies in kWh per slot)

Inputs for slot t:
- L_t: AC load, including the battery unit's standby draw.
- S_t: DC PV energy at the MPPT.
- p_t: import price. x_t: export price (0 if unpaid or zero-export).
- A: inverter AC cap (0.8 kW). A′ = A·Δt/η_inv is the maximum DC energy the inverter can take.

**DC-coupled (one micro-inverter for PV and battery).** Decisions: c_pv (PV into the battery), c_g (DC into the battery from grid via an AC charger, if fitted), d (DC out of the battery), u (PV DC sent to the inverter), and curtailment.
- DC bus balance: S_t = c_pv + u + curt.
- Battery: Δs = η_c·(c_pv + c_g) − d/η_d. Charging and discharging never happen in the same slot.
- Inverter: η_inv·(u + d) ≤ A·Δt. **PV above the cap can still go into the battery** but can never reach AC directly.
- Grid: g = L_t + c_g/η_acdc − η_inv·(u + d). Import I = max(g, 0), export E = max(−g, 0); E = 0 in zero-export mode.
- Slot cost = p_t·I − x_t·E + w·d, where w is a wear cost.
- For a given Δs ≥ 0, fill b = Δs/η_c from the cheapest sources first:
  1. PV that would be clipped (free),
  2. PV that would be exported (η_inv·x),
  3. PV that would serve the load (η_inv·p),
  4. grid (p/η_acdc).

  Then set u to whichever of {min(r, A′), min(r, A′, L/η_inv), 0} costs least. The 0 option allows deliberate curtailment when p < 0, because importing then pays you.
- For Δs < 0: d = −Δs·η_d must satisfy d ≤ A′ (otherwise infeasible), and u = min(S, A′ − d), which curtails PV while discharging.

**AC-coupled (separate PV inverter and battery inverter; e.g. Marstek Venus E or a hard-wired GivEnergy/Fox).**
- PV_ac = min(η_inv·S, A_pv·Δt).
- Charging: AC in = Δs/η_ch,ac, limited to P_ch·Δt. If the battery may not charge from the grid, AC in ≤ max(0, PV_ac − L).
- Discharging: AC out = −Δs·η_dis,ac, limited to P_dis·Δt.
- g = L − PV_ac + AC in − AC out.
- PV clipped by its own inverter is lost; only a DC-coupled battery can capture it.
- Each battery kWh goes through two conversions (measured AC round trip about 80-85%, see section 4).

### 3.2 Strategies, simplest first (reference code in `agile-econ/dispatch.mjs`)
- **(a) Self-consumption / zero export.** Target AC output = min(L_t, A·Δt). PV surplus charges the battery; the battery covers any shortfall up to the cap.
- **(b) Fixed constant output of W watts.** PV first, surplus to the battery, shortfall from the battery. When the battery is full, PV passes through up to the cap (Anker-style). With a **flat 500 W server load, a fixed 500 W output equals smart-meter self-consumption** (£313.0 vs £313.7/yr), so no smart meter or CT clamp is needed. A fixed 300 W loses about £22/yr.
- **(c) Time-of-use windows.** Within 23:00-07:00, charge at full power from PV and grid whenever p_t ≤ X. Hold (store PV surplus, never discharge) until 16:00. Discharge following the load from 16:00 to 19:00, then run as self-consumption until the next charging window.
- **(d) Price-aware heuristic using the known day-ahead prices.**
  1. For each day, mark the m most expensive slots for discharge, where m = ⌈usable kWh·η_out / (P_dis·Δt)⌉.
  2. Mark grid charging in the n cheapest slots between the end of the previous discharge block and the first discharge slot, but only where p_lo/RTE + w < the mean price of the discharge slots.
  3. Hold before the discharge block; free-run after it.

  Lesson from the benchmark: this rule fills the battery from the grid and then wastes the next day's PV (it exported 219 kWh at zero value). A heuristic must **reserve headroom for the forecast PV surplus** before charging from the grid.
- **(e) Optimal dispatch by dynamic programming over a discretised state of charge (SoC).**
  - States: s_i = s_min + i·δ for i = 0..N−1, with δ = (s_max − s_min)/(N−1), s_min = SoCmin·Cap·SoH and s_max = SoCmax·Cap·SoH.
  - Moves: k ∈ [−k_dn, k_up], with k_up = ⌊min(P_ch·Δt·η_c, …)/δ⌋ and k_dn = ⌊min(P_dis·Δt, A·Δt/η_inv)/(η_d·δ)⌋.
  - Slot cost f_t(kδ) is the minimum slot cost from 3.1. It does not depend on i, so evaluate it only **K = k_up + k_dn + 1 times per slot**.
  - **Bellman recursion:** V_T(i) = −τ·(s_i − s_min); V_t(i) = min over k with 0 ≤ i+k ≤ N−1 of [ f_t(kδ) + V_{t+1}(i+k) ]; π_t(i) = argmin. Then roll forward from i₀.
  - Infeasible moves cost +∞.
  - Negative import prices are handled automatically: f_t falls as grid charging rises, and u = 0 (curtail) wins whenever p_t < 0 and the load would otherwise be covered by PV.
  - Wear cost: add w per DC kWh discharged.
  - SoC-dependent limits (e.g. charge taper above 90%) can be added by making the feasibility check depend on i.
  - **Terminal value τ:** use 0 for the full year starting at s_min. For a rolling horizon, τ = median(known-horizon price)·η_d·η_inv worked best (see below).
  - **Rolling horizon matching publication:** re-plan every day at 16:00 local (half-hour index 32) over [16:00 D, 23:00 D+1), which is 62 slots; commit the decisions from 16:00 D to 16:00 D+1. On the first day, plan from t = 0. Use perfect-foresight PV within the horizon, or a forecast.

  Benchmark (1.8 kWp south 35°, AC charging, 2p wear, 366 re-plans):

  | battery | perfect foresight | rolling, τ = 0 | rolling, τ = cheapest 6 slots | rolling, τ = median × η |
  |---|---|---|---|---|
  | 2 kWh | £377.65 | £377.66 (identical: the battery empties every evening, so days are independent) | £377.66 | £377.11 |
  | 5 kWh | £437.11 | £418.51 | £427.42 | £432.40 |

  Show results as "perfect-foresight upper bound" next to a realistic heuristic.

**DP runtime** (Node 24, single thread, 17,520 slots, 2 kWh with an 800 W cap so K ≈ N/2; times include slot-cost evaluation):

| N | K | ms | annual cost | gap to N=321 |
|---|---|---|---|---|
| 21 | 10 | 29-31 | £500.94 | +£6.2 |
| 41 | 20 | 64-75 | £498.03 | +£3.3 (0.7%) |
| 81 | 41 | 194-221 | £496.58 | +£1.9 |
| 161 | 81 | 520-562 | £495.11 | +£0.4 |
| 321 | 163 | 1,567-2,539 | £494.70 | – |

- Complexity is O(T·N·K), roughly O(T·N²·P·Δt/usable).
- **Recommendation:** N = 41 for parameter sweeps (inside a Web Worker; about 60 runs take about 5 s). N = 81-161 for the final "best" figure.
- Choose δ of about 20-50 Wh. For large batteries behind 800 W, K/N is small, so N = 101 stays cheap.
- Keep the policy as an Int8Array(T·N), which is 1.7 MB at N = 101.

### 3.3 Benchmark on real prices
Setup:
- Load: constant 500 W plus standby (10 W for the DC unit, 6 W for the AC unit).
- PV: PVGIS 2023, mapped onto the price year.
- Inverter efficiency 0.95. Battery charge/discharge efficiency 0.96 each. AC charger 0.93. Minimum SoC 10%.
- Export unpaid unless stated.
- No-battery baseline cost: £875.69.

| scenario | annual cost | saving | full cycles/yr |
|---|---|---|---|
| PV 0.9 kWp S35 only | £718.92 | £156.77 | – |
| PV 0.9 kWp W90 only | £771.69 | £104.00 | – |
| PV 1.8 kWp S35 only (Agile Outgoing paid) | £643.40 (£608.60) | £232.28 (£267.09) | – |
| PV 1.8 kWp W90 only | £713.17 | £162.52 | – |
| PV 1.8 kWp flat only | £653.68 | £222.01 | – |
| DC 2 kWh + 1.8 kWp S35, (a) self-consumption | £561.98 | £313.71 | 184 |
| (b) fixed 500 W / fixed 300 W | £562.68 / £583.77 | £313.01 / £291.92 | 186 / 229 |
| (c) TOU without AC charging | £554.27 | £321.42 | 182 |
| (e) DP without AC charging | £522.98 | £352.70 | 283 |
| (c) TOU, X = 12p, with AC charging | £545.03 | £330.66 | 219 |
| (d) price-aware with AC charging | £539.51 | £336.18 | 339 |
| **(e) DP with AC charging, wear 2p** | **£498.03** | **£377.65** | 399 |
| DC 2 kWh + 1.8 kWp W90, (a) / DP with AC charging | £692.32 / £606.91 | £183.37 / £268.78 | 74 / 381 |
| DC 2 kWh, no PV, DP with AC charging (pure arbitrage) | £773.34 | £102.35 | 382 |
| AC 5.12 kWh (2.5 kW charge / 0.8 kW discharge, 85% round trip), no PV, DP | £690.54 | £185.14 | 281 |
| AC 5.12 kWh + separate 1.8 kWp S35, DP | £446.54 | £429.15 | 260 |
| DC 5 kWh + 1.8 kWp S35, DP with AC charging | £438.58 | £437.11 | 240 |

All savings above are net of the battery's standby energy. Going forward, prices are about 4.8% lower while VAT is 0%.

## 4. Degradation, efficiency and standby (inputs to the economics)
- **Cycle claims** [doc]:
  - Anker Solarbank 3 Pro: "6,000 cycles to 70%", 15-year service life, 10-year warranty (Notebookcheck review).
  - Zendure SolarFlow 800 Pro: 6,000 cycles to 70%, 10 years.
  - Growatt NOAH 2000: 6,000 cycles to 80%.
  - Marstek Venus E Gen 3: 6,000 cycles, 10-year warranty. Techtest suggests 2,000-3,000 full cycles is realistic for standard LFP.
- **Cycles per year from the simulation:** 180-400 equivalent full cycles (EFC). Calendar life (10-15 years) therefore limits life before 6,000 cycles does.
- **Capacity model** [inferred defaults]:
  - SoH(y) = 1 − a_cal·y − b_cyc·EFC_cum(y).
  - a_cal = 1.5%/yr (sensitivity 1-3%; LFP calendar fade grows with temperature and SoC and follows roughly √t, per Naumann et al. 2018, J. Energy Storage 17).
  - b_cyc = (1 − EOL_SoH)/N_cyc, e.g. 0.30/6000 = 5e-5 per EFC.
  - End of life when SoH < 0.70, or at year L_cal = 15.
  - Re-run (or scale) the battery's yearly benefit by SoH_y.
- **Wear cost per kWh** for the DP objective:
  - Full throughput cost: w = C_bat / (Cap_usable × N_cyc × SoH_avg), e.g. £700 / (1.73 × 6000 × 0.85) ≈ 7.9p/kWh.
  - When calendar life binds first, the marginal wear is only w_marg = max(0, C_bat/(Cap·N_cyc) − C_bat/(Cap·EFC_yr·L_cal)), which is about 0.
  - Default **w = 2p/kWh** (sensitivity 0-8p). It also stops the DP cycling on spreads of a penny or less.
- **Round-trip efficiency, measured:**
  - Anker Solarbank 3 Pro (Notebookcheck): battery to AC at 400 W gave 2,127 Wh, "around 88%". AC charge 2,651 Wh in → **about 80% AC-to-AC**.
  - Marstek Venus E Gen 3 (techtest.org): **about 85% AC-to-AC**, about 4.9 of 5.12 kWh usable at 800 W.
  - Defaults:
    - DC-coupled: η_c = η_d = 0.96, inverter 0.95, so PV → battery → AC ≈ 0.875.
    - AC charger: 0.93, so AC → AC ≈ 0.81.
    - AC-coupled: η_ch,ac = η_dis,ac = 0.92, so about 0.85.
  - Inverter efficiency falls at low output (around 100 W); optionally use an efficiency curve.
- **Standby draw:**
  - Marstek Venus E: 5-6 W measured at the socket (techtest).
  - EcoFlow PowerStream: about 10-11 W; Anker Solarbank 3 Pro: about 9.5 W (both secondary sources).
  - **Default 10 W → 87.6 kWh/yr ≈ £17.5/yr at 20p.** That is about 17% of a 2 kWh battery's pure-arbitrage value. Add it to L_t as a constant; some units sleep when empty, which you could model with a "sleep below SoCmin" option.
  - LFP self-discharge (about 2-3% per month) is negligible next to standby.

## 5. Financial metrics (y = 1..Y; r = discount rate; e = electricity price escalation)
- **Yearly saving:** Sav_y = [Sav_pv,1·(1−d_pv)^(y−1) + Sav_bat,1·SoH_y/SoH_1]·(1+e)^(y−1) − O&M_y. Optionally apply a VAT step: ×1.05 from April 2027 if the VAT relief lapses.
- **Cash flows:** CF_0 = −C_0 (kit + battery + mounting + electrician). CF_y = Sav_y − R_y, where R_y covers replacements: micro-inverter in year 12-15, battery at end of life.
- **Simple payback:** C_0/Sav_1, or the first n with Σ_{y≤n} CF_y ≥ C_0 (interpolate the fraction of the final year).
- **Discounted payback:** the first n with Σ_{y≤n} CF_y/(1+r)^y ≥ C_0.
- **NPV:** −C_0 + Σ_{y=1..Y} CF_y/(1+r)^y + Residual/(1+r)^Y.
- **IRR:** the r* where NPV(r*) = 0. Solve by bisection on [−0.99, 1]. Replacement outflows can give more than one sign change, so report "n/a" if there is no bracket.
- **LCOE (PV):** [C_pv + Σ R_y/(1+r)^y] / Σ E_y/(1+r)^y, with E_y = AC kWh generated (or kWh self-consumed for "cost per useful kWh"). Compare it with the generation-weighted Agile price it displaces: about 17.8p for S35 and 23.2p for W90.
- **LCOS (battery):** [C_bat + PV(replacements) + PV(standby cost)] / Σ discharged_kWh_y/(1+r)^y.
- **UK defaults (Oct 2026):**
  - Nominal discount rate r = 4% (Bank Rate 3.75%, held 17 Sep 2026; savings-rate opportunity cost). Offer 3.5%, the Green Book STPR, and 0%.
  - e = 2%/yr nominal (CPI was 3.1% in Aug 2026); sensitivity 0-5%. Alternatively work in real terms with r = 1% and e = 0%; be consistent either way.
  - Panel degradation 0.5%/yr (0.4% for n-type TOPCon; first year 1-2% for PERC).
  - Horizon Y = 20 years (panels last 25-30).
  - Micro-inverter replacement in year 12 (£120-200).
  - Battery end of life at 70% SoH or 15 years.

## 6. Estimating the base load from half-hourly data
```js
// consumption: [{interval_start, consumption /*kWh*/}] from the Octopus consumption endpoint (UTC), possibly with gaps
function baseLoad(consumption, {k = 4, minSlots = 44} = {}) {
  const byDay = groupBy(consumption, r => londonDate(r.interval_start));          // local Europe/London days (46/48/50 slots)
  const daily = [];
  for (const [day, rows] of byDay) {
    if (rows.length < minSlots) continue;                                        // drop incomplete days
    const kw = rows.map(r => r.consumption * 2).filter(v => v > 0).sort((a,b)=>a-b); // kWh/30min -> kW; zeros = outage/glitch
    if (kw.length < minSlots) continue;
    daily.push({day, kW: mean(kw.slice(0, k))});                                 // mean of the k lowest slots (2 h), robust to 1 odd reading
  }
  const v = daily.map(d => d.kW).sort((a,b)=>a-b);
  return { baseKW: quantile(v, 0.5), p10: quantile(v, 0.1), p90: quantile(v, 0.9), days: daily.length,
           monthly: medianBy(daily, d => d.day.slice(0,7)), series: daily };
}
```
- Use the minimum over **all 48 slots** of each day, not a fixed 01:00-05:00 window. Agile users move dishwashers and EV charging into cheap overnight or midday slots, so a night window would overstate the base load.
- Cross-check against the 5th percentile of all half-hours in the year.
- Show the monthly medians as a trend; server load drifts with cooling and hardware changes.
- Report the base load alongside its cost:
  - base kW;
  - kWh/yr = kW·8760;
  - share of total consumption;
  - **annual cost under Agile = Σ_t price_t·baseKW·0.5 over the trailing 12 months of real prices.** This equals baseKW × 8760 × the time-weighted mean price: £1.7514 per W per year in region C at 5% VAT;
  - cost during 16:00-19:00 alone (21.8% of the total);
  - the same load on Flexible, for comparison.
- The base load also limits how much plug-in PV you can use yourself: in any slot you only use min(PV_ac, load). With a 500 W base, an 800 W kit at midday exports or clips the excess unless a battery or other loads absorb it.

## 7. UK rules that affect the recommendation
- **DESNZ "Plug-in Solar Device Interim Product Specification" v2.0 (July 2026)** [primary PDF downloaded]:
  - Covers ≤ 800 VA and ≤ 3.5 A AC, ≤ 2,000 W of panel DC power, and one device per household under G98 Issue 2 Amendment 1 2026.
  - States it "does not apply to … Plug-in battery systems; Plug-in solar PV devices integrated with battery systems".
  - Instructions must warn that the device "is not intended to be connected to, operated with, or used in conjunction with a battery energy storage system".
  - In force from 27 Aug 2026 under SI 2026/848 [secondary].
- **Consequence:** model plug-in solar plus a battery as a technical "what if" only. Under the current rules, a legal battery is a hard-wired installation using the AC-coupled topology in 3.1. Socket-connected storage falls outside the plug-in route.
- **Export payments:** plug-in solar reportedly cannot get Smart Export Guarantee payments, because a DIY install cannot be MCS certified (expected around 2027) [secondary, fuseenergy.com]. So **default export value = 0** and offer Agile Outgoing or Fixed 12p as options.

## Files
- `/home/zack/.claude/jobs/52762e7f/tmp/research/agile-analysis.json`: the main analysis. It contains the overall statistics, 48-value profiles (all, winter, summer, export), the seasonal and monthly tables, the 500 W costs, the monthly arbitrage table, the formula check, the orientation values and the full dispatch benchmark with runtime.
- `.../research/agile-econ/agile-import-C-2025-10-01_2026-10-01.json`, `agile-outgoing-C-...json`: the raw 17,520-row extracts. `flexible-C-unit-rates.json`, `flexible-C-standing-charges.json`, `agile-C-standing-charges.json`, `outgoing-fixed-C-unit-rates.json` hold the tariff rates. Note: these are copies of downloads that sit directly in `research/`, a folder other agents also write to.
- `.../agile-econ/dispatch.mjs`: reference JS implementation of the slot physics (`slotDC`, `slotAC`), strategies (a)-(d) (`controllers`), the DP (`dpPlan`, `runDP` with rolling horizon) and `runNoBattery`.
- `.../agile-econ/bench.mjs` and `dispatch-bench-results.json`: the benchmark runner and its output.
- `.../agile-econ/analyse_agile.py`, `formula_fit.py`, `n2ex_fit.py`, `orientation_value.py`, `prep_sim_inputs.py`, `merge_analysis.py`: the analysis scripts.
- Supporting data:
  - `sim-inputs.json`: aligned price and PV arrays.
  - `orientation-value.json`.
  - `pvgis/`: 12 PVGIS hourly series fetched by curl.
  - `n2ex-hourly-2026-08-09.json`: Nord Pool N2EX prices. Despite the name, it covers 2026-09-06 to 09-30.
  - `plugin-solar-ips.pdf/.txt`: the DESNZ specification.
=====
- {'claim': 'Only one Agile import product, AGILE-24-10-01, was live from 2025-10-01 to 2026-10-01. Its region C rates (E-1R-AGILE-24-10-01-C) give 17,520 unique half-hours with payment_method=null on every row, so there are no direct-debit duplicates.', 'source': 'live curl https://api.octopus.energy/v1/products/?available_at=... and the standard-unit-rates endpoint', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'standard-unit-rates silently caps page_size at 1500 (12 pages per year) and returns rows newest first; responses send Access-Control-Allow-Origin: *.', 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'An OPTIONS preflight on the Octopus consumption endpoint with Access-Control-Request-Headers: authorization returns 200, lists authorization in allow-headers and sets max-age 86400. PVGIS sends no ACAO header.', 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Domestic electricity VAT is 0% from 2026-10-01 (funded to 2027-03-31). From 2026-09-30T23:00Z the Octopus API returns value_inc_vat == value_exc_vat; earlier rows are ×1.05.', 'source': 'https://www.gov.uk/government/news/breathing-space-on-your-energy-bill + live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Agile import formula, ex VAT: min(95, D·W + P·[16:00-19:00] − 3.333 from 2026-04-01). London has D=2.00 and P=12. The cap is 100p including VAT and the levy cut is 3.5p including VAT.', 'source': 'https://octopus.energy/blog/agile-pricing-explained/ + regression on live data (slope 2.1053=2.00/0.95, intercept shift −3.343)', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Agile Outgoing ≈ max(0, 0.95·W + 1.30) off-peak and max(0, 0.95·W + 7.23) from 16:00-19:00. It floors at 0p and the maximum seen was 42.35p.', 'source': 'inferred from regression of live import vs export rates and N2EX cross-check', 'verified_live': True, 'confidence': 'medium'}
- {'claim': 'Next-day Agile prices are published between 16:00 and 20:00, usually near 16:00, and cover 23:00 to 23:00 UK time.', 'source': 'https://octopus.energy/smart/agile/ + live data (latest slot ends 23:00 BST)', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Agile region C, 2025-10..2026-09, including VAT: mean 19.99p, median 18.54p, 16:00-19:00 mean 34.83p vs 17.87p for the rest of the day, 2.837% of slots negative, minimum −11.28p, maximum 86.73p.', 'source': 'live curl data, /home/zack/.claude/jobs/52762e7f/tmp/research/agile-analysis.json', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'A constant 500 W load cost £875.69/yr on Agile C as billed, against £1,137.29 on Flexible direct debit over the same year (£261.61 saved). That is about £175 per 100 W per year, with 21.8% of the cost falling 16:00-19:00.', 'source': 'computed from live API rates', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Flexible Octopus region C direct debit from 2026-10-01: 26.5956 p/kWh and 41.3869 p/day standing charge (0% VAT). Agile region C standing charge: 37.6525 p/day.', 'source': 'live curl VAR-22-11-01 / AGILE-24-10-01 endpoints', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Moving 1 kWh from the cheapest 3h overnight to 16:00-19:00 was worth a 19.38p/kWh spread on average (16.65p net at 85% round trip). Summer midday is cheaper than overnight.', 'source': 'computed from live data', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Per kWp, PV value from self-use at Agile prices: SW35 £179.9, S35 £179.2, W35 £159.3, W90 £116.6. West-vertical earns 23.2p per kWh it makes vs 17.8p for S35, but makes half the energy.', 'source': 'PVGIS v5.3 2023 London hourly (curl) × live Agile C prices', 'verified_live': True, 'confidence': 'medium'}
- {'claim': 'Full-year DP (17,520 slots) in Node 24 takes about 30 ms at N=21, 64-75 ms at N=41, about 200 ms at N=81, about 540 ms at N=161 and 1.6-2.5 s at N=321. N=41 is within 0.7% of N=321.', 'source': 'live benchmark /home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/bench.mjs', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Benchmark with a 1.8 kWp S35 array, 800 W inverter, 500 W load and unpaid export: PV only saves £232/yr. Adding a 2 kWh DC battery saves £314 with self-consumption and £378 with the optimal DP plus grid charging. A battery doing pure arbitrage with no PV saves £102/yr.', 'source': 'live benchmark on real prices + PVGIS 2023 PV', 'verified_live': True, 'confidence': 'medium'}
- {'claim': 'DESNZ Plug-in Solar Device Interim Product Specification v2.0 (July 2026) covers ≤800 VA, ≤3.5 A and ≤2000 W of panels, one device per household. It excludes plug-in batteries and solar kits with built-in batteries, and requires a warning against using the device with battery storage.', 'source': 'https://assets.publishing.service.gov.uk/media/6a60a03c47af652afa0c89f5/plug-in-solar-final-_interim-product-specification.pdf', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Plug-in solar cannot currently get Smart Export Guarantee payments because a DIY install is not MCS certified (expected to change around 2027).', 'source': 'https://www.fuseenergy.com/blog/plug-in-solar-legislation', 'verified_live': False, 'confidence': 'medium'}
- {'claim': 'Measured round trips: Anker Solarbank 3 Pro about 80% AC-to-AC (88% battery-to-AC at 400 W); Marstek Venus E Gen 3 about 85% AC-to-AC with 5-6 W standby. Other units are reported at about 9.5-11 W standby.', 'source': 'notebookcheck.net Solarbank 3 Pro review (curl); techtest.org Venus E Gen 3 test', 'verified_live': False, 'confidence': 'medium'}
- {'claim': 'Older Agile versions AGILE-23-12-06 and AGILE-24-04-03 publish rates identical to AGILE-24-10-01 for region C (checked for 2026-09-16).', 'source': 'live curl', 'verified_live': True, 'confidence': 'medium'}
['/home/zack/.claude/jobs/52762e7f/tmp/research/agile-analysis.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/dispatch.mjs', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/bench.mjs', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/dispatch-bench-results.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/orientation-value.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/analyse_agile.py', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/formula_fit.py', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/n2ex_fit.py', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/orientation_value.py', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/prep_sim_inputs.py', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/merge_analysis.py', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/sim-inputs.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/agile-import-C-2025-10-01_2026-10-01.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/agile-outgoing-C-2025-10-01_2026-10-01.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/flexible-C-unit-rates.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/flexible-C-standing-charges.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/agile-C-standing-charges.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/outgoing-fixed-C-unit-rates.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/n2ex-hourly-2026-08-09.json', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/pvgis', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/plugin-solar-ips.pdf', '/home/zack/.claude/jobs/52762e7f/tmp/research/agile-econ/plugin-solar-ips.txt']
['Which region is the user in? The analysis assumes C (London); the app should take the region from the GSP of the meter point or the tariff code.', 'Octopus has not published the Agile Outgoing constants (0.95, +1.30, +7.23 at peak, floor 0); they come from a fit. Are they region-specific? Only region C was checked.', 'With VAT at 0%, is the Agile cap still 100p or 95p? The window never got near it, so it does not matter in practice.', 'How should the PVGIS hourly HH:10 UTC timestamps map onto Agile half-hours? This affects the 16:00-19:00 share for west-facing arrays and needs settling with the PV-modelling research.', 'Under DESNZ spec v2.0 a battery cannot be plug-in. Does the user accept a hard-wired AC-coupled battery (G98/G99, electrician), or should the app treat plug-in batteries as a not-currently-compliant what-if?', 'Can plug-in solar get export payments (SEG / Outgoing)? The secondary source says no until about 2027, so the default export value should be 0.', 'Can the inverter be curtailed during negative prices (e.g. via an inverter power-limit API)? The DP assumes it can; add a toggle.', 'Wear-cost and calendar-fade defaults (2p/kWh, 1.5%/yr) are estimates informed by the literature, not measurements; expose them as sliders.', 'The price-aware heuristic (d) needs PV-forecast headroom logic to come close to the DP. A persistence or clear-sky-index forecast would be a reasonable realistic baseline.']
