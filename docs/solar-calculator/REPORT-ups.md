The power-station route is legal in GB, but battery-only Agile arbitrage barely pays.

**Legality.** A power station that charges from a 13 A socket and runs the servers from its own outlets is not a "plug-in microgenerator". SI 2026/848 defines that term as a device "designed to operate in parallel with a distributor's network". It also excludes devices "designed to import electrical energy ... for the purpose of storing energy for later supply". So such a unit falls outside G98, ESQCR reg 22 and the plug-in battery prohibition. To the grid it is just an appliance; ESQCR reg 21 (switched alternative supply, never in parallel) is met by its internal transfer relay. Solar panels wired only into the unit's own DC input form an isolated system, outside G98, the IPS and SEG.

**Catalog.** 17 real UK units, priced live on 2026-10-05, are in research/ups/power-stations.json:
- EcoFlow: RIVER 3 Plus, DELTA 3 Classic, DELTA 3 Plus, DELTA 3 Max Plus, DELTA Pro 3
- Anker SOLIX: C1000 Gen 2, C2000 Gen 2, F3000
- BLUETTI: Elite 100 V2, Elite 200 V2, Elite 300, Elite 400, Apex 300
- Jackery: Explorer 1000 v2, 2000 v2, 3000 v2
- DJI: Power 2000

Every unit is a standby (offline) UPS with a bypass relay, switching in 10-20 ms; none in the current UK range is true online.

**Losses.** Notebookcheck drain tests show AC-to-AC round trips of only 0.62-0.77 at 200-260 W loads. Fitting P_dc = P_ac/0.94 + P0 to those tests gives effective fixed losses of 11 to 55 W, depending on the unit.

**Simulation.** I ran a half-hourly model on real Agile region C prices (Oct 2025 to Sep 2026) with a 500 W load:
- **Battery only:** a 2-3 kWh unit saves £60-100/yr with a realistic schedule (£100-150 with perfect foresight), which is a 12+ year payback.
- **With panels on the DC input:** adding 0.8-1.6 kWp lifts this to roughly £180-300/yr.
- **Avoid:** running loads through the inverter all day (bypass disabled) loses money on most units. Recharging straight after 19:00 makes the peak cut nearly worthless.

**Hardwired G98 alternative.** For comparison, the default install cost is about £400 (range £250-800), plus £450-1,200 if the consumer unit needs replacing.
=====
# UPS-style power station route: legality, UK products, modelling (2026-10-05)

## TL;DR
- **Legal.** A portable power station charged from a 13 A socket that powers the servers from its **own outlets** is not a plug-in microgenerator. It sits outside G98 and outside the plug-in battery prohibition. Rules still apply if you wire it into the house (a changeover switch needs an electrician), and you must never backfeed a socket.
- **No UK unit is a true online UPS.** Every current unit is a standby UPS with a bypass relay that switches in 10-20 ms. While the AC input is live, the outlets run from grid via the relay. Some units can be told to run from battery while grid-connected:
  - EcoFlow DELTA 3 Plus and DELTA 3 Max Plus: "Disable bypass", TOU mode and scheduled tasks.
  - Anker C1000/C2000 Gen 2 and F3000: TOU mode.
  - Jackery 3000 v2: Charging Plan and Self-powered mode.
  - Bluetti Apex 300: Time of Use mode.
  - Every unit: a smart plug that switches off the AC input.
- **Losses dominate.** Measured AC-to-AC round trip at a 200-260 W load is 0.62-0.77. Fixed inverter losses under load are 11-55 W. A unit sitting in bypass also has an unmeasured standby overhead (assumed 8 W, which costs £14/yr).
- **Economics on real Agile region C data, 500 W servers:**
  - Battery-only arbitrage: £60-100/yr with a realistic schedule (£100-150 with perfect foresight) for 2-3 kWh units costing £850-1,300, so a 10-15+ year payback. That is beyond realistic life (350-500 full cycles a year against 4,000-6,000 rated).
  - Adding 0.8-1.6 kWp of panels on the unit's own DC input gives about £180-300/yr (realistic) or £240-400 (perfect foresight).
  - For comparison, the prior research found a £470-670 plug-in kit (1.8 kWp, 800 W) saves £232/yr.
- **Recommended UK units:** EcoFlow DELTA 3 Plus (£599, 1 kWh, expandable) or DELTA 3 Max Plus (£1,099, 2 kWh, pre-order). They have the best control (TOU, scheduler, bypass-disable, HID/NUT shutdown, a Home Assistant integration) and 10 ms transfer. BLUETTI Elite 300 (£1,299, 3 kWh) is the most efficient unit measured at low load (fixed loss 11 W). Avoid the Anker F3800, BLUETTI Elite 400 and Anker C2000 Gen 2 for a small constant load: their fixed losses are 38-55 W.

---
## 1. Legality in GB, October 2026

### What the law actually says (checked live on legislation.gov.uk, plus local copies of the IPS and Ofgem texts)

- **SI 2026/848** (in force 27 Aug 2026) inserts this definition into both PSSR reg 8 and ESQCR reg 1(5):
  > "plug-in microgenerator" means a source of energy which generates electricity from the direct conversion of sunlight; has a maximum rated AC output not exceeding 800 watts; is intended for connection ... by means of a standard plug and socket; **is designed to operate in parallel with a distributor's network**; and **is not designed to import electrical energy from a low voltage consumer's installation for the purpose of storing energy for later supply** ...
- **ESQCR reg 22(1)**, as substituted on 27.8.2026: no person shall install or operate a source of energy *which may be connected in parallel* with a distributor's network unless it has protective equipment, meets BS requirements (or the IPS, for a plug-in microgenerator), and the DNO is notified. This parallel-operation rule is where the battery "ban" comes from:
  - No plug-in battery can satisfy the IPS route.
  - BS 1363 prohibits plugs for connecting generating devices, and PSSR 8(3A) only creates an approval route for plug-in microgenerators.
- **ESQCR reg 21** (switched alternative sources):
  > "Where a person operates a source of energy as a switched alternative to a distributor's network, he shall ensure that that source of energy cannot operate in parallel with that network and where the source of energy is part of a low voltage consumer's installation, that installation shall comply with British Standard Requirements."
  A power station's internal transfer relay (break-before-make) is exactly this. UPS product standards (IEC 62040-1, UL 1778) require backfeed protection. Jackery states IEC 62040 for the 1000 v2 and UL 1778 for the 2000 v2.
- **G98/NI Issue 2 (2026)** definitions (GB G98 Issue 2 Amd 1 uses the same definitions [INF]):
  - "Micro-generator": "A source of electrical energy ... able to be connected to an electric circuit in a Low Voltage electrical installation and **designed to operate in parallel** with a public Low Voltage Distribution Network".
  - Scope: "only ... Micro-generators that are designed to only operate in parallel ... installations designed to operate in parallel ... for short periods (i.e. less than 5 minutes per month) **or as an islanded installation** should refer to EREC G99".
  - Electricity Storage counts as a Micro-generator "when operating in an export mode".
- **IPS v2.0 scope** excludes "Plug-in battery systems; Plug-in solar PV devices integrated with battery systems". The instructions must warn that a kit "is not intended to be connected to, operated with, or used in conjunction with a battery energy storage system".
- **Government response (July 2026):** the framework "is not intended to permit battery storage systems, portable generators, or wider categories of plug-connected generation equipment".
- **Ofgem DCRP/MP/26/02 decision:** "Plug-in Electricity Storage devices will therefore remain prohibited from being sold, supplied, or used in the UK". This means G98 *Plug-in Micro-generators*, i.e. parallel-operating devices.

### Conclusions
- **Allowed, and outside G98, ESQCR 22 and the plug-in ban:** the unit charges from a socket like any appliance and feeds only equipment plugged into its own outlets. It never exports or runs in parallel. Power stations are openly sold by EcoFlow, Anker, Jackery, BLUETTI and DJI UK, and by Currys and Argos. pluginsolarhub (Aug 2026) draws the same line: "A portable power station supplying appliances from its own built-in sockets is one thing. A product intended to feed stored energy back into the fixed house wiring through a normal socket is a very different proposition." No DNO notification is needed [INF; G98 only covers parallel/export devices].
- **Not allowed:**
  - A male-to-male "suicide" lead backfeeding a socket. It breaches ESQCR 21/22 and BS 1363 and is lethal to line workers.
  - Feeding the power station's output into house circuits without a proper transfer switch. EcoFlow's Manual Transfer Switch and Smart Home Panel must be installed by an electrician (EcoFlow UK states this) and must comply with BS 7671 §551.6.
- **Grey area:** owning a separate import-only power station alongside a legal plug-in kit. The IPS warning targets batteries used *with the kit*. Keep them electrically independent: the kit's output must never connect to the station, and the station's PV input must have its own panels. No official guidance was found.
- **Solar into the unit's own DC input:** this is an isolated DC system with no grid connection. It is not a plug-in microgenerator (not in parallel), so the IPS, G98, MCS and SEG do not apply and the 800 VA / 2000 Wp caps do not apply.
  - Limits come from the unit's MPPT window. Most 400-500 W panels have Voc of 37-50 V, so an 11-60 V input takes one panel. DELTA Pro 3 HPV (30-150 V) and Anker F3000 High-PV (11-165 V) take 3-4 in series.
  - Roof mounting still falls under planning permitted-development rules and structural safety.
  - A permanent cable run into the house should follow BS 7671 Section 712 practice (DC isolator, PV cable, MC4) [INF].
- **Fire safety and insurance:**
  - LFP has the lowest thermal-runaway risk of the lithium chemistries.
  - **BS 7671:2018+A4:2026** was published 15 Apr 2026 and is **mandatory from 15 Oct 2026**, not 2 Oct as the prior report said. Its new Chapter 57 (stationary secondary batteries in fixed installations) does not cover plug-in portable units. Its location rules are still a sensible guide: not in escape routes, hallways or stairs, not in lofts or bedrooms, not in basements without an outside exit, and keep 1 m from openings if outside.
  - London Fire Brigade #ChargeSafe advice: keep away from exits, fit a smoke or heat alarm in the room, don't block vents.
  - Running 24/7 next to hot servers: keep the unit within 0-40 °C charge and -10/-20 to 40-45 °C discharge, and leave fan clearance.
  - Insurance: no UK insurer statement found. Declare it; undeclared lithium storage gives insurers grounds to dispute a claim (forum and secondary sources). Use only the maker's leads; no adaptors or extension reels for 2-3 kW charging.

## 2. Products, UK, prices live on 2026-10-05
Full data is in **`ups/power-stations.json`** (17 entries). Field conventions are in `power-stations.meta.json`.

| id | £ now (RRP) | kWh | AC out W | AC charge W (adjustable?) | PV W (V) | UPS ms | Can run from battery while grid-connected? | Measured losses |
|---|---|---|---|---|---|---|---|---|
| ecoflow-river-3-plus | 199 (279), sold out | 0.286 (+EB300 £99 / EB600 £259) | 600 | 360 | 220 (11-55) | <10 | app limits; smart plug | – |
| ecoflow-delta-3-classic | 399 (499) | 1.024 | 1800 | 1400 (yes) | 500 (11-60) | 10 | smart plug; Storm Guard | – |
| ecoflow-delta-3-plus | 599 (699) | 1.024 (EB £459, to 5 kWh) | 1800 | 1500 (100 W steps) | 2×500 (11-60) | <10 + HID/NUT | **TOU, scheduled tasks, backup reserve, disable grid bypass** | idle ~17 W [2ND]; nextpit 0.81 AC-to-AC (load unstated) |
| ecoflow-delta-3-max-plus | 1099 (1399), **pre-order, ships 30 Oct** | 2.048 (EB £799, to 10 kWh) | 3000 | 2300 (yes) | 1000 (11-60, 18 A) | 10 + HID | **Self-powered, TOU, scheduled task, "Bypass mode disabled"** (manual) | – |
| ecoflow-delta-pro-3 | 2599 (2799) | 4.096 (EB £1,679, to 12 kWh) | 4000 | 2900 (yes) | 2600 (HPV 30-150 / LPV 11-60) | 10 | backup reserve, TOU [2ND] | – |
| anker-solix-c1000-gen2 | 474 (999) | 1.024 | 2000 (bypass 1800) | 1200 / 1600 UltraFast | 600 (11-60) | 10 | **TOU mode** | idle ~14 W [2ND] |
| anker-solix-c2000-gen2 | 1099 (1500) | 2.048 (BP2000 ~£749) | 2400 | 2300 (yes) | 800 (11-60) | 10 | **TOU**, Storm Guard, Fast Charging Plan | **NBC: 0.68 AC-to-AC at 200 W, P0 ≈38 W**; Anker claims 9 W idle |
| anker-solix-f3000 | 1899 (2999) | 3.072 (EB ~£1,449, to 12 kWh) | 3600 | ~2990 (100 W steps) | 2400 (11-165 / 11-60) | 20 | TOU (UK FAQ) | **NBC: 0.72 at 200 W, P0 ≈29 W** |
| bluetti-elite-100-v2 | 399 (599) | 1.024 | 1800 | 1200 Turbo (modes) | 1000 | 10 | smart plug | – |
| bluetti-elite-200-v2 | 849 (1199) | 2.074 | 2600 | 2300 | 1000 (12-60, 20 A) | 15 | smart plug (PV-priority mode) | forum: +45-50 W grid overhead at about 240 W in PV-priority mode [unverified] |
| bluetti-elite-300 | 1299 (1599) | 3.014 | 2400 | 1200 std / ~2300 | 1200 | 10 | smart plug (no off-peak option, per NBC) | **NBC: 0.77 at 200 W, P0 ≈11 W (best)** |
| bluetti-elite-400 | 1599 (1899) | 3.84 | 2600 | 2300 | ? | <15 | smart plug | **NBC: 0.71 at 250 W, P0 ≈45 W** |
| bluetti-apex-300 | 1499 (1899) | 2.765 (B300K £1,399; B500K £1,999) | 3840 | ? | 4000 | 20 | **Backup / Self-consumption / Time of Use / Custom** | Bluetti claims 20 W idle |
| jackery-explorer-1000-v2 | 419 (899) | 1.07 | 1500 | 1400 emergency / ~260 quiet | 400 [INF] | ≤20 (IEC 62040) | smart plug | nextpit 0.88 (load unstated); idle ~10-12 W [2ND] |
| jackery-explorer-2000-v2 | 807 (1399) | 2.042 | 2200 | ~1800 | 400 | 20 (UL 1778) | smart plug | nextpit 0.90 (load unstated) |
| jackery-explorer-3000-v2 | 1499 (2299) | 3.072 | 3600 | ~1800 | 1000 (≤60) | ≤20 | **Charging Plan** (off-peak windows) + Self-powered mode | – |
| dji-power-2000 | 912 Camera World (DJI £1,099) | 2.048 (to 22 kWh) | 3000 | fast | 1800 | 10 | smart plug | – |

**Notes on the table**
- Cycle ratings:
  - 3,000 cycles: RIVER 3
  - 4,000 cycles: DELTA 3 Plus, DELTA Pro 3, Anker, Jackery (Jackery to 70%), Bluetti Elite 100 V2, DJI
  - 6,000 cycles: Bluetti Elite 200 V2, Elite 300, Apex 300
- Warranty is 5 years for most units; Jackery and EcoFlow give 3 years plus 2 more on registration.
- Not listed: Bluetti AC180, AC200L, AC300, AC500 and EP500 are gone from the UK store (EP500 and AC300 were the only online-UPS-capable units). Zendure SuperBase is not on zendure.co.uk. The Anker F3800 is not in the UK range, and measured only 62% AC-to-AC at 260 W. The DELTA 2 Max and Jackery 2000 Plus are sold out.

**Server caveat:** ATX 3.1 PSUs only need about 12 ms hold-up at full load (17 ms in ATX 3.0). A 20 ms transfer (F3000, Apex 300, Jackery) can reboot a heavily loaded server, so prefer 10 ms units. With EcoFlow's bypass-disable or scheduled modes there may be no transfer gap at all, but this is unverified. Use HID/NUT (DELTA 3 Plus, DELTA 3 Max Plus) for clean shutdown.

## 3. Modelling notes for the half-hourly simulator
### State machine per slot (Δt = 0.5 h). Dedicated load L (servers) is served only by the unit.
1. **BYPASS** (AC input live, relay closed):
   - grid = (L + P_byp + P_in)·Δt
   - SoC += (P_in·η_ch + PV_dc)·Δt, clipped at full. PV beyond the clip is **wasted** (no export).
   - P_in ∈ [0, P_ch,max], where the max is user-capped. Total input must stay ≤ 10 A and within the 13 A smart-plug rating (keep L + P_in ≤ 2.9 kW).
2. **BATTERY** (smart plug off, bypass disabled, or a TOU or self-powered mode active):
   - DC draw = (L/η_inv + P0)·Δt. PV covers the draw first and the battery the rest.
   - PV surplus charges the battery. Grid = 0, or P_in for an "online" unit that charges while inverting.
3. **Reserve:** if SoC would fall below the reserve, the unit must revert to bypass. Model a forced fallback; with a smart-plug cut that needs a Home Assistant automation, otherwise the servers die when the unit empties.

### Default parameters
| parameter | default | range | evidence |
|---|---|---|---|
| η_ch (AC to cells) | 0.88 | 0.82-0.88 | Notebookcheck full-charge Wh: F3000 0.883, C2000G2 0.871, Elite 300 0.874 (1200 W; 0.85 at 2300 W), Elite 400 0.873, F3800 0.822 |
| η_inv | 0.94 | 0.92-0.95 | fit choice; fitted P0 barely depends on it |
| P0, fixed loss in battery mode | 20 W (1-2 kWh), 30 W (3-4 kWh) | 10-55 W | fitted: Elite 300 11, F3000 29, C2000G2 38, Elite 400 45, F3800 ~55 (`loss-fits.json`) |
| P_byp, overhead in bypass | 8 W | 3-20 W | **not measured anywhere**; each 10 W costs about £17.5/yr |
| idle, AC on and no load | 10-20 W | | secondary, low confidence; do not use for under-load losses |
| usable DC | nominal | 0.97-1.0 × nominal | NBC fits |
| reserve | 10% | | |
| wear | 2 p per DC kWh | | as in the prior report |
| resulting AC-to-AC round trip at L | η_ch·L/(L + P0·η_inv) | | e.g. 0.88 × 500/(500 + 19) = 0.85 is too high; measured 0.68-0.77 at 200 W, so use P0 |

**Does running in battery mode all the time cost more than bypass?** Yes, a lot. In bypass, grid feeds the load directly at about 100% plus P_byp. Running "online" (bypass disabled with charging) sends every server kWh through η_ch·η_inv and P0. In the simulation, online operation of a 2 kWh unit at 500 W changed the annual bill by **−£75 to −£129/yr** relative to no battery (it made things worse). Only the most efficient units (Elite 300, DELTA Pro 3 class) broke even. Use battery mode only in expensive slots.

**Scheduling options:**
- EcoFlow (DELTA 3 Plus, DELTA 3 Max Plus, likely DELTA Pro 3): TOU mode, scheduled tasks, backup reserve, bypass-disable.
- Anker (C1000/C2000 Gen 2, F3000): TOU.
- Jackery (3000 v2): Charging Plan.
- Bluetti (Apex 300): Time of Use mode.
- None of these apps takes Agile prices directly. Home Assistant can, via tolwi/hassio-ecoflow-cloud (EcoFlow private or official API) or thomluther/hacs-anker-solix.
- Universal fallback: a smart plug on the AC input switched by HA from Agile prices. Off means battery mode (one UPS transfer); on means bypass plus recharge.
- A forum test found the DELTA 2 Max still bypasses whenever AC is present, even with programmed charge times, so a timer or smart plug was needed there.

## 4. Simulation results (real Agile C, 2025-10-01 to 2026-10-01, PVGIS 2023 London)
Savings are in £/yr against grid-only supply of the same constant load. Script: `ups/scripts/sim_ups.py`; full results in `ups/sim-results.json`.
- **Peak-cut 19:00:** plug off 16:00-19:00, recharge from 19:00.
- **Peak-cut night:** plug off 16:00-19:00, charge 00:00-06:00.
- **Heuristic:** daily Agile thresholds plus self-powered when PV ≥ half the load.
- **DP:** perfect-foresight dynamic programming (upper bound).

| Load / unit | PV on DC input | Peak-cut 19:00 | Peak-cut night | Heuristic | DP | Online (bypass off) |
|---|---|---|---|---|---|---|
| 500 W (baseline £876) DELTA 3 Plus 1 kWh | none | −5 | 19 (battery runs out daily) | 43 | 53 | −217 |
| 500 W DELTA 3 Max Plus 2 kWh | none | 18 | 64 | 90 | 104 | −75 |
| 500 W DELTA 3 Max Plus 2 kWh | 0.8 kWp S35 | 52 | 89 | 181 | 238 | |
| 500 W DELTA 3 Max Plus 2 kWh | 1.6 kWp S35 | 80 | 109 | 273 | 349 | |
| 500 W DELTA 3 Max Plus 2 kWh | 0.8 kWp W90 | 68 | 101 | 141 | 182 | |
| 500 W C2000 Gen 2 (P0 38) | none | 11 | 59 | 86 | 98 | −129 |
| 500 W Elite 300 (P0 11) | none / 0.8 S35 | 16 / 51 | 64 / 89 | 99 / 190 | 133 / 269 | +6 |
| 500 W DELTA Pro 3 4 kWh | none / 1.6 S35 | 8 / 72 | 57 / 103 | 95 / 293 | 148 / 398 | +19 |
| 300 W (baseline £525) DELTA 3 Max Plus | none / 0.8 S35 | 2 / 35 | 31 / 55 | 51 / 151 | 77 / 206 | −7 |
| 800 W (baseline £1,401) DELTA 3 Max Plus | none | 14 | 63 (2 kWh too small for 3 h) | 104 | 121 | −332 |
| 800 W Elite 300 | none / 1.6 S35 | 40 / 109 | 113 / 162 | 153 / 350 | 174 / 439 | |

**Takeaways**
1. Charge timing matters as much as discharge. Recharging right after 19:00 wipes out the peak saving.
2. Battery-only payback is 10-15+ years: about £1,100 for £90/yr. That exceeds realistic life at 350-500 full cycles a year.
3. Solar on the DC input is what makes the route pay, at roughly £100-200 per 0.8 kWp. That PV goes through battery and inverter losses but has no 800 W cap.
4. Size the battery to cover 3 h × (L/η + P0) plus the reserve. That is 1.8 kWh for 500 W and 2.9 kWh for 800 W.
5. The plug-in kit (prior research: £232/yr for £470-670) should come first. A power station with its own panels is a separate, additive project.

## 5. Comparison with the hardwired G98 battery route
- **Hardware** (prior catalog): Anker Solarbank 4 E5000 Pro £1,699 (5 kWh, 2.5 kW); EcoFlow STREAM Ultra £899 (1.92 kWh) or Ultra X £1,299; Zendure SolarFlow 2400 Pro £1,099.
- **Benchmark** (prior Agile report): an AC-coupled 5.12 kWh unit (85% round trip, about 6-10 W standby) on DP saves £185/yr battery-only and £429/yr with 1.8 kWp. It serves the whole house, can use Octopus's non-MCS export route, and has about 85% round trip against 70-77% for power stations at server loads.
- **Install-cost defaults** (no specific hardwiring quotes exist):
  - Electrician £40-60/h outside London (£55-75 in London); day rate £220-400 (£300-450 in London) (Fantastic Services 2026).
  - New dedicated radial circuit about £200-450.
  - Consumer-unit replacement, if the board is old: £450-750 (£700-1,200 in London).
  - G98 notification: no DNO fee (installer submits) [2ND/INF].
  - Turnkey installed systems: £2,500-10,500, with labour about 20% (bookabuilderuk, zigaflow, trade2base June 2026: 5 kWh £2,500-4,500).
- **Simulator default:** `installCostGbp` = 400 (range 250-800); `consumerUnitUpgradeGbp` = 0 (optional 450-1,200); CT meter fitting included.
- **The power-station route avoids** the electrician, G98 and the 800 W cap on PV, and doubles as a server UPS. It costs more in conversion losses, serves only the servers, and cannot export.

## 6. Files
- `ups/power-stations.json`: catalog, 17 entries, with extra fields pvVoltageRange, bypassDisableable, fixedLossW, touMode, rrpGbp, availability, installRoute.
- `ups/power-stations.meta.json`: field conventions and excluded models.
- `ups/loss-fits.json`, `scripts/fit_losses.py`: P0 and η fits from Notebookcheck tests.
- `ups/sim-results.json`, `scripts/sim_ups.py`: the simulation, with peak-cut, peak-cut-night, heuristic, DP and online strategies.
- `ups/raw/`: ESQCR reg 21/22 XML, SI 2026/848 XML, G98/NI Issue 2 PDF and text, EcoFlow DELTA 3 Max Plus, DELTA 3 Max and DELTA 3 Plus manuals, Shopify JSON.
- `ups/pages/`: fetched page text.

## 7. Sources
- **Legal:**
  - https://www.legislation.gov.uk/uksi/2026/848/made
  - https://www.legislation.gov.uk/uksi/2002/2665/regulation/21
  - https://www.legislation.gov.uk/uksi/2002/2665/regulation/22
  - https://www.nienetworks.co.uk/getattachment/37ea48b5-f4e9-436f-863f-ce9fd9cfc509/ENA-EREC-G98-NI-Issue-2.pdf
  - IPS v2.0 and Ofgem DCRP/MP/26/02 (local copies in sources/)
  - Government response, July 2026 (sources/gov-response-july-2026.txt)
  - https://www.pluginsolarhub.co.uk/plug-in-battery-storage-uk.html
  - https://coolpowerco.co.uk/battery-storage-rules-october-2026/
  - https://niceic.com/amendment-four
- **Products:**
  - EcoFlow: uk.ecoflow.com/products.json and product pages
  - DELTA 3 Max Plus manual: cdn.solarpowersupply.eu/files/EcoFlow DELTA 3 Max Plus Portable Power Station_User Manual-20260202.pdf
  - DELTA 3 Plus manual (Estonian): droon.ee/wp-content/uploads/2025/09/EcoFlow-DELTA-3-Plus_User-Manual_EST.pdf
  - Anker: ankersolix.com/uk/products/{c1000-gen2, c2000-gen2, c2000-gen-2-expansion-battery, f3000, f3000-expansion-battery}
  - BLUETTI: bluettipower.co.uk/products/{elite-100-v2, elite-200-v2, elite-300, elite-400}-portable-power-station.js and apex-300-home-battery-backup.js
  - Jackery: uk.jackery.com/products.json and product pages
  - DJI: cameraworld.co.uk/dji-power-2000-uk.html
- **Tests:**
  - notebookcheck.net/…Anker-Solix-F3000-review.1230949.0.html
  - notebookcheck.com C2000 Gen 2 (1230097), F3800 (879808), Bluetti Elite 300 (1243566), Elite 400 (1264708)
  - nextpit.de: Jackery 1000 v2 and 2000 v2, EcoFlow DELTA 3 Plus
  - akkudoktor.net/t/ecoflow-delta-2-max-bypass-funktion/17106
- **Hold-up time:** lttlabs.com PSU timing (2026-04-08); knowledge.seasonic.com ATX 3.0 vs 3.1.
- **Costs:**
  - fantasticservices.com/cost-guides/electrical/electrician
  - trade2base.com/blog/solar-battery-storage-costs-uk
  - bookabuilderuk.com home battery storage installation cost 2026
- **Home Assistant:** github.com/tolwi/hassio-ecoflow-cloud; github.com/thomluther/hacs-anker-solix; github.com/anker-charging/ha-anker-solix-official

=====
- {"claim": "SI 2026/848 defines a 'plug-in microgenerator' (in both PSSR reg 8 and ESQCR reg 1(5)) as solar-only, \u2264800 W AC, connected by standard plug, 'designed to operate in parallel with a distributor's network', and 'not designed to import electrical energy ... for the purpose of storing energy for later supply'. A power station that only imports and feeds its own outlets therefore falls outside the definition.", "source": "https://www.legislation.gov.uk/uksi/2026/848/made/data.xml (local copy ups/raw/si-2026-848.xml)", "verified_live": true, "confidence": "high"}
- {"claim": "ESQCR reg 21: 'Where a person operates a source of energy as a switched alternative to a distributor's network, he shall ensure that that source of energy cannot operate in parallel with that network ...'. Reg 22(1)(c), substituted 27.8.2026, requires plug-in microgenerators to comply with the IPS, and other parallel sources to meet British Standard Requirements.", "source": "https://www.legislation.gov.uk/uksi/2002/2665/regulation/21 and /22 (data.xml)", "verified_live": true, "confidence": "high"}
- {"claim": "G98/NI Issue 2 (2026) defines a Micro-generator as a source 'designed to operate in parallel with a public Low Voltage Distribution Network'. Installations designed for short parallel operation (<5 min/month) or islanded operation go to G99. Electricity Storage counts only 'when operating in an export mode'.", "source": "https://www.nienetworks.co.uk/getattachment/37ea48b5-f4e9-436f-863f-ce9fd9cfc509/ENA-EREC-G98-NI-Issue-2.pdf (GB G98 wording assumed identical)", "verified_live": true, "confidence": "medium"}
- {"claim": "The government response says the plug-in framework 'is not intended to permit battery storage systems, portable generators, or wider categories of plug-connected generation equipment'. Ofgem says Plug-in Electricity Storage devices 'remain prohibited from being sold, supplied, or used'. Both refer to parallel/export (plug-in micro-generator) devices.", "source": "sources/gov-response-july-2026.txt; sources/ofgem-g98-decision.txt", "verified_live": true, "confidence": "high"}
- {"claim": "BS 7671:2018+A4:2026 was published 15 Apr 2026 and becomes mandatory on 15 Oct 2026 (the prior report said 2 Oct). Its new Chapter 57 covers stationary batteries in fixed installations and does not cover plug-in portable power stations.", "source": "https://niceic.com/amendment-four ; https://coolpowerco.co.uk/battery-storage-rules-october-2026/ (search summaries)", "verified_live": false, "confidence": "medium"}
- {"claim": "EcoFlow DELTA 3 Max Plus manual (2026-02-02) documents: bypass mode (AC output fed from grid via a bypass circuit while charging), a 'Bypass mode disabled' setting, TOU mode, Scheduled task mode, Self-powered mode and Storm Guard. UK AC input is 10 A.", "source": "https://cdn.solarpowersupply.eu/files/EcoFlow DELTA 3 Max Plus Portable Power Station_User Manual-20260202.pdf", "verified_live": true, "confidence": "high"}
- {"claim": "The EcoFlow DELTA 3 Plus is a standby UPS with 10 ms transfer. It has TOU mode, scheduled tasks, backup reserve and 'disable grid bypass', plus USB-C HID and PowerManager/NUT support for NAS and server shutdown. AC charge rate is settable from 100 to 1500 W.", "source": "droon.ee EcoFlow-DELTA-3-Plus_User-Manual_EST.pdf; uk.ecoflow.com delta-3-series page; nextpit.de ecoflow-delta-3-plus-test", "verified_live": true, "confidence": "high"}
- {"claim": "On the EcoFlow DELTA 2 Max, AC outlets are always fed by grid bypass when AC input is present, even with programmed charge times. Forcing battery use needs a timer or smart plug on the input.", "source": "https://akkudoktor.net/t/ecoflow-delta-2-max-bypass-funktion/17106", "verified_live": true, "confidence": "medium"}
- {"claim": "Notebookcheck drain tests at low load (results are usable AC energy as a share of nominal capacity, and charge efficiency):\n- Anker F3000: 81% at 200 W, 91% at 1800 W; AC charge 88%.\n- Anker C2000 Gen 2: 79% at 200 W, 90% at 1800 W; charge 87%.\n- Bluetti Elite 300: 88% at 200 W; charge 87%.\n- Bluetti Elite 400: 82% at 250 W; charge 87%.\n- Anker F3800: 75% at 260 W; charge 82% (62% AC-to-AC).", "source": "notebookcheck.net F3000 review 1230949; notebookcheck.com 1230097, 1243566, 1264708, 879808", "verified_live": true, "confidence": "high"}
- {"claim": "Fitting P_dc = P_ac/0.94 + P0 to the two-load tests gives effective fixed losses in battery mode of: Elite 300 about 11 W, F3000 about 29 W, C2000 Gen 2 about 38 W, Elite 400 about 45 W, F3800 about 55 W. AC-to-AC round trip at 200-260 W is 0.62-0.77.", "source": "derived: ups/scripts/fit_losses.py -> ups/loss-fits.json", "verified_live": false, "confidence": "medium"}
- {"claim": "UK prices on 2026-10-05 (GBP inc VAT):\n- EcoFlow: DELTA 3 Classic \u00a3399, DELTA 3 Plus \u00a3599, DELTA 3 Max Plus \u00a31,099 (pre-order, ships 30 Oct), DELTA Pro 3 \u00a32,599.\n- Anker: C1000 Gen 2 \u00a3474, C2000 Gen 2 \u00a31,099, F3000 \u00a31,899.\n- BLUETTI: Elite 100 V2 \u00a3399, Elite 200 V2 \u00a3849, Elite 300 \u00a31,299, Elite 400 \u00a31,599, Apex 300 \u00a31,499.\n- Jackery: Explorer 1000 v2 \u00a3419, 2000 v2 \u00a3807, 3000 v2 \u00a31,499.\n- DJI: Power 2000 \u00a3912 (Camera World).", "source": "uk.ecoflow.com/products.json; ankersolix.com/uk product JSON-LD; bluettipower.co.uk/products/*.js; uk.jackery.com/products.json; cameraworld.co.uk", "verified_live": true, "confidence": "high"}
- {"claim": "Simulation on real Agile region C prices (Oct 2025 to Sep 2026) with a constant 500 W load and a 2 kWh power station:\n- Battery-only arbitrage: \u00a364/yr (smart-plug peak cut with night charging), \u00a390/yr (price heuristic), \u00a3104/yr (perfect-foresight DP).\n- With 0.8 kWp S35 panels on the unit's DC input: \u00a389 / \u00a3181 / \u00a3238 per year.\n- Running bypass-disabled ('online') all the time: \u2212\u00a375 to \u2212\u00a3129/yr (worse than no battery).", "source": "derived: ups/scripts/sim_ups.py -> ups/sim-results.json (inputs: agile-econ/sim-inputs.json)", "verified_live": false, "confidence": "medium"}
- {"claim": "Every power station in the current UK range is a standby UPS with a bypass relay, switching in 10-20 ms. None is a true online double-conversion UPS (the online-capable Bluetti EP500 and AC300 are no longer on the UK store). ATX 3.1 PSUs only require about 12 ms hold-up at full load, so 20 ms units risk server reboots.", "source": "manufacturer UK pages; lttlabs.com PSU timing 2026-04-08; knowledge.seasonic.com ATX 3.0 vs 3.1", "verified_live": true, "confidence": "medium"}
- {"claim": "App scheduling on the UK units:\n- Anker C1000 Gen 2: Standard and TOU modes.\n- Anker C2000 Gen 2: Standard, TOU, Storm Guard, Fast Charging Plan.\n- Anker F3000: TOU (UK FAQ).\n- Jackery 3000 v2: Charging Plan and Self-powered Mode.\n- Bluetti Apex 300: Backup, Self-consumption, Time of Use, Custom.\n- Bluetti Elite 100 V2, 200 V2 and 300 and Jackery 1000 v2 and 2000 v2: no off-peak scheduling, so use a smart plug.", "source": "ankersolix.com/uk product FAQs; uk.jackery.com explorer-3000-v2 page; bluetti search results; notebookcheck Elite 300", "verified_live": true, "confidence": "medium"}
- {"claim": "UK electrician rates (2026): \u00a340-60/h and \u00a3220-400/day outside London; \u00a355-75/h and \u00a3300-450/day in London. Consumer unit replacement costs \u00a3450-750 (\u00a3700-1,200 in London). A new dedicated circuit costs about \u00a3200-450. Installed home batteries cost \u00a32,500-10,500 in total, with labour about 20%.", "source": "https://www.fantasticservices.com/cost-guides/electrical/electrician/ ; trade2base.com/blog/solar-battery-storage-costs-uk ; bookabuilderuk.com", "verified_live": true, "confidence": "medium"}

ARTIFACTS: "research/ups/power-stations.json"
OPEN: [
 "Bypass overhead is not measured anywhere: how many watts does each unit draw on top of the load while it sits in bypass at 100% SoC 24/7? The simulation assumes 8 W, and each 10 W costs about \u00a317.5/yr. The user could measure this with a metering smart plug.",
 "When EcoFlow switches to battery under TOU, a scheduled task or 'disable bypass', is the change seamless or a relay transfer of about 10 ms? This decides whether app scheduling is safer for servers than a smart-plug cut.",
 "Does the IPS warning ('not ... used in conjunction with a battery energy storage system') cover a separate, import-only power station in the same home as a legal plug-in kit? No official guidance was found; keep the two electrically independent.",
 "Measured losses at 300-800 W are missing for the units with the best controls (EcoFlow DELTA 3 Plus, DELTA 3 Max Plus, DELTA Pro 3) and for Jackery and DJI. nextpit's AC-to-AC figures (0.81-0.90) do not state the load.",
 "A BLUETTI forum report claims the Elite 200 V2 draws an extra 45-50 W from the grid at about 240 W load in PV-priority mode. It is unverified because the forum has moved.",
 "BLUETTI Apex 300 UK unit: are its outlets BS 1363 sockets, and what is its AC charge rate? Price for the B500K, and for the DJI Power 2000 expansion battery, are also missing.",
 "Do the Home Assistant EcoFlow integrations (public or private API) expose the TOU, backup-reserve and bypass-disable controls for the DELTA 3 Plus and DELTA 3 Max Plus, so Agile-driven automation can work without a smart plug?",
 "No UK insurer statement exists on large LFP power stations running 24/7 indoors. The advice is to declare it.",
 "No published quotes exist for an electrician to hardwire an EcoFlow STREAM or Anker Solarbank 4 Pro. The \u00a3400 default (range \u00a3250-800) is derived from circuit and day-rate pricing."
]