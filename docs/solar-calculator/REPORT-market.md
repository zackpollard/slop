Plug-in solar became legal in Great Britain on 27 Aug 2026. Three things made it legal: SI 2026/848, the DESNZ Interim Product Specification v2.0 and Ofgem's approval of a G98 change on 11 Aug 2026. Confirmed rules: a device may output at most 800 VA / 3.5 A into an ordinary BS 1363 13 A socket. It must be a complete kit listed on the ENA register. Panels are capped at 2000 W DC, with a professional check advised above 960 W. G98 allows one device per household for now. You must register the device with your network operator (DNO) through ENA's myplugin.solar. Extension leads and adaptors are banned.
Batteries are excluded from the plug-in route. Plug-in batteries and solar-plus-battery kits "remain prohibited" (Ofgem). The IPS also says a compliant kit must not be used together with a battery. Every battery product on sale in the UK (EcoFlow STREAM, Anker Solarbank 4 Pro, Zendure SolarFlow 2400, Hoymiles HiBattery) has to be hardwired by a Part P electrician as a G98 microgenerator. Octopus hopes plug-in batteries will arrive in early 2027.
Export from plug-in kits is normally unpaid, because the Smart Export Guarantee needs an MCS or equivalent certificate. The one exception: Octopus's own kits (£450 for 1x460 W, £650 for 2x460 W) qualify for Outgoing Prime (16p/kWh from 16:00 to 19:00, 9p otherwise), but only when Octopus also supplies the home.
The catalog research/plugin-kits.json has 26 real entries: 11 microinverter kits or inverters, 5 all-in-one batteries, 3 AC-coupled battery add-ons, 3 panels and 4 mounts. Most prices were read live on 2026-10-05 from the sellers' own Shopify JSON or product pages. Compliant kits cost £336 to £990. Battery units cost £699 to £1,699.
For this user, servers running 24/7 mean almost all of an 800 W kit's output is used in the home. Orientation is the only way to shift a plug-in kit's output toward the 16:00 to 19:00 peak.
=====
# UK (GB) plug-in / balcony solar market, October 2026: research for the `solar-calculator` kit catalog

All prices include VAT unless marked. **[LIVE]** means I fetched it myself on 2026-10-05 with curl, Shopify `products.json` or a page fetch. **[DOC]** means a primary document (gov.uk, Ofgem or a manufacturer PDF). **[2ND]** means a secondary source (tracker or blog). **[INF]** means my own inference.

> CORS note: nothing here needs to be fetched at runtime. Retailer sites and the ENA register (a Cognito-authenticated React app at `connect-direct.energynetworks.org`) are not usable from a static page. Ship the catalog as a static, user-editable JSON file.

---
## 1. Legal and regulatory status in GB (as of 2026-10-05)

### Confirmed (primary documents)
| Item | Detail | Source |
|---|---|---|
| Legal instrument | **SI 2026/848**, *The Plugs and Sockets etc. (Safety) Regulations 1994 and Electricity Safety, Quality and Continuity Regulations 2002 (Amendment) Regulations 2026*. Made 16 Jul 2026, laid 17 Jul, **in force 27 Aug 2026**. Covers England, Wales and Scotland. NI is not covered (G98/NI) | legislation.gov.uk/uksi/2026/848 [DOC]; dates from jontracey.substack.com and plugsolarhub [2ND] |
| Product spec | **Plug-in Solar Device Interim Product Specification (IPS) v2.0, July 2026** (DESNZ). Based on DIN VDE V 0126-95:2025-12 | assets.publishing.service.gov.uk/media/6a60a03c47af652afa0c89f5/plug-in-solar-final-_interim-product-specification.pdf [DOC] (text: `sources/ips-v2.txt`) |
| Power limit | IPS §4.1: "maximum apparent power Smax supplied to the mains installation does not exceed **800 VA** and the maximum current does not exceed **3.5 A**". Single phase, ≤253 V, 50 Hz | IPS [DOC] |
| DC panel cap | Total PV module Pmax **≤ 2000 W**. Above **960 W** the manufacturer must advise a professional assessment of the wiring. **Up to 4 modules, no more than 2 in series** per string | IPS §4.1 and Fig. notes [DOC] |
| Socket | Standard **BS 1363** 13 A socket, using only the manufacturer's factory-fitted plug. Extension leads, multi-way adaptors, RCD adaptors and plug converters are prohibited. Users are told to check for modern RCBO protection; installs on old fuse boards need an electrician check | IPS §1, §6.2.3, §8 [DOC] |
| Kit requirement | Must be a **complete manufacturer kit**: PV module(s), grid-following inverter, plug lead and mounting system. There is a declaration of compliance and the kit is listed on the **ENA G98 Type Test Register**. No third-party certification is required | IPS; gov response p.47 [DOC] |
| Devices per home | The IPS allows one device per final circuit, **but G98 Issue 2 Amd 1 2026 limits it to one device per household** "unless and until that is amended". The government intends to move to one per circuit later | IPS §1 note; gov response pp.29, 44 [DOC] |
| G98 / DNO | Ofgem approved DCRP/MP/26/02 on **11 Aug 2026**. It defines "Plug-in Micro-generators" at ≤800 W registered capacity, one per Customer Installation. They may sit alongside wired micro-generators if the total stays ≤16 A/phase (otherwise G99 applies). There is a customer notification mechanism | ofgem.gov.uk/sites/default/files/2026-08/Ofgem-decision-to-Approve-DCRP-MP-26-02-...pdf [DOC] |
| Notification | **myplugin.solar** is operated by the Energy Networks Association. It says: "Registering your plug-in solar device is a legal requirement". You can only pick devices on the approved list, the limit is one device per household, and "If you already have a 3.68 kW G98 solar system ... you must use a qualified installer to apply for G99 approval. Any additional generation must be wired in" | https://myplugin.solar/ [LIVE] |
| **Batteries** | Excluded. IPS scope excludes "Plug-in battery systems" and "Plug-in solar PV devices integrated with battery systems". The instructions must warn that the device "is not intended to be connected to, operated with, or used in conjunction with a battery energy storage system". Ofgem: "Plug-in Electricity Storage devices will therefore remain prohibited from being sold, supplied, or used in the UK once DESNZ's current proposals are implemented" | IPS; Ofgem decision [DOC] |
| Building rules | Renters, leaseholders and managed buildings should get landlord or freeholder consent. Warnings against timber cladding or timber balconies and against buildings under external-wall remediation. Panels must not be fixed to party/boundary walls. Lightning-protection and fire-spread guidance applies. UKSOL requires professional advice for anything other than ground level | IPS §8 [DOC]; uksol.uk [LIVE] |
| BS 7671 | IPS cites BS 7671:2018+A4:2026, published 15 Apr 2026 and mandatory from 2 Oct 2026. Careful secondary sources say **A4 did not itself permit socket-connected generation** (§551.7 unchanged). Legality comes from SI 2026/848 plus the IPS. Several blogs wrongly claim A4 legalised it | pluginsolarexplained.co.uk/bs-7671-amendment-4 [2ND] |

### Proposed or not yet in force
- **One device per circuit** (would allow e.g. 2 x 800 W on two ring circuits): government intent, pending a G98 amendment.
- **Plug-in batteries**: the Energy Storage Association is running a safety review with DESNZ, with no timeline. Octopus: "hoping it'll be in early 2027" [LIVE octopus.energy/plug-in-solar-explore].
- The 2000 W DC cap is "kept under review". An enduring British Standard will eventually replace the IPS.

### Market status
- ENA register (secondary trackers): about **109 Compliant** plug-in devices from roughly 21–24 manufacturers by 3–4 Oct 2026. Only about 30 had a UK consumer listing [2ND pluginsolarexplained.co.uk/ena-register, /kits; pluginsolarregister.co.uk]. Official register: https://connect-direct.energynetworks.org/device-databases/search-gen?device_type_id=14 (JS app, login-backed API, not scrapable).
- No Lidl, Aldi or Iceland kit was on sale as of early October 2026. Retailers selling now: Screwfix (PowerXpress), Argos (UKSOL), City Plumbing, Octopus, EcoFlow direct, Thunder, PatioSun, Solarfy and Plug In Solar Ltd. Anker has no plug-in-solar record on the register; its UK product is the hardwired Solarbank 4 Pro.

## 2. Export payment (SEG): usually unpaid for plug-in
- SEG requires an MCS (or equivalent, e.g. Flexi-Orb) certified installation plus an export MPAN. Plug-in kits have no MCS certificate, so **export is normally £0** [2ND, consistent with Octopus FAQ: "we need a copy of the MCS certificate, the DNO Notification form and the DNO's response"].
- **Octopus exception [LIVE]**: if you buy the Octopus Plug-in Solar bundle *and* Octopus supplies the home, you get **Outgoing Prime: 16 p/kWh for 16:00–19:00, 9 p/kWh otherwise**, fixed for 12 months. You must first register on the ENA portal and wait for DNO approval. If the kit was bought elsewhere: "You won't be able to sign up for an Octopus export tariff for that system."
- **Open:** whether Outgoing Prime can be paired with an **Agile import**. Octopus's compatibility table is an image I could not read.
- Hardwired (G98) installs, including battery systems: Octopus says it is "one of the rare suppliers who offer Outgoing Octopus to customers without an MCS certificate" (competent-person sign-off route) [LIVE octopus.energy/blog/outgoing-faqs]. Other Outgoing variants are Outgoing Octopus 12 p flat and Agile Outgoing (`M*APX+B+C`, floored just above 0).
- **Simulator default:** export price = 0. Options: Outgoing Prime (Octopus kit only), 12 p flat, or Agile Outgoing (hardwired).

## 3. Kits and batteries available to UK buyers
Catalog: `research/plugin-kits.json` (26 entries). Summary:

### Compliant plug-in kits (no battery), all 800 VA AC
| id | Panels | Inverter (MPPT) | £ | Date / source |
|---|---|---|---|---|
| cityplumbing-dmegc-1x465-hiflow | 1x465 | Hoymiles HF-800-WB (1) | 336 | 3 Oct, tracker [2ND] |
| cityplumbing-dmegc-2x515-hiflow | 2x515 | HF-800-WB (1, panels in series) | 468 | 3 Oct, tracker + HUKD [2ND] |
| ecoflow-stream-facade-2x400 | 2x400 + 50° facade brackets | STREAM micro (2) | 449 | LIVE (pre-order) |
| octopus-plugin-solar-1x460 / 2x460 | 1x or 2x460 | Fox ESS M1-800-E (2) | 450 / 650 | LIVE |
| ecoflow-stream-micro-2x500 | 2x500 bifacial | STREAM micro (2) | 549 | LIVE (in stock) |
| solarfy-duo-910 | 2x455, 20° ballast | Hoymiles (n/s) | 599 | LIVE |
| powerxpress-920-marstek | 2x460 + 15–45° bracket | Marstek MI0800 (2) | 669 Screwfix (599 direct) | LIVE |
| patiosun-duo | 2x445 bifacial, ground stand | HF-800-WB (1) | 699 | LIVE |
| thunder-bolt-920 | 2x460 | 800 VA, 2 MPPT, 96.7% | 749.99 | LIVE |

Other prices seen: UKSOL Pro range at Argos (515 W £599, Duo 890 W £849, Plus 1030 W £899, Max 1260 W £989, APsystems EZ1-M) [2ND]; PatioSun Lite £449 and Max £749 [LIVE]; Thunder Bolt 460 £549.99 and Storm flexible 360/710 W £499.99/£699.99 [LIVE]; Perlight PowerPlug MAX 500/1000 £594/£810 [2ND].

**EcoFlow caveat [LIVE]:** EcoFlow UK pages still say the STREAM BKW DIY cable must be wired to the consumer unit by an electrician, and that plug cables "will be available" once the rules apply. Confirm what lead ships before relying on DIY plug-in.

### Battery systems (all require a hardwired Part P electrician install in GB)
| id | kWh | PV in (MPPT) | Grid-tie out | AC charge | Cycles / warranty | £ |
|---|---|---|---|---|---|---|
| ecoflow-stream-ultra | 1.92 LFP | 2000 W (4x500) | 800 W (1200 W outlet) | 1050 W | 6000 / 10 y | 899 |
| ecoflow-stream-ultra-x | 3.84 | 2000 W (4) | 800 W | 1200 W (PV 1500) | 6000 / 10 y | 1299 |
| ecoflow-stream-ac-pro (AC add-on) | 1.92 | none | 800 W | 1050 W | 6000 / 10 y | 699 |
| zendure-solarflow-2400-pro | 2.4 (+AB3000L 2.88 kWh £799; max 16.8) | 3000 W (4) | 2400 W bidirectional | 2400 W | n/s / 10 y | 1099 |
| zendure-solarflow-2400-ac-plus (AC) | 2.4 | none | 2400 W (800 default) | 2400 W | n/s / 10 y | 899 |
| anker-solarbank4-e5000-pro | 5.024 (+BP5000 £1,299; to 30) | 5000 W (4) | 2500 W (unlocked after install proof) | 2500 W | 10000 / 10 y | 1699 |
| thunder-vault-hibattery-1920ac (AC) | 1.92 | none | 800 VA | 1000 VA | ≥6000 / 10 y, **RTE 87%** | 1049.99 |
| hoymiles-hibattery-4020x | 4.02 (to 16.08) | 4000 W | 2500 VA | n/s | 8000 / 10 y | 1499 |

- Larger hardwired units also exist: EcoFlow STREAM 5000 (£1,599), STREAM AC 5000 (£1,499), Expansion Battery 5000 (£1,299).
- Only Hoymiles publishes a round-trip efficiency (87% max AC-coupled; 96.5% max bidirectional). All other `roundTripEff` values are null.

### Not UK-available (checked)
Anker Solarbank 2/3 (EU only; UK site sells only Solarbank 4 Pro), Growatt NOAH 2000 + NEO 800M-X (EU only), Bluetti Balco (DE/FR), Jackery balcony range (EU only). Zendure SolarFlow 800 is ENA-compliant as a kit but is not on zendure.co.uk (EU €299). Sunsynk is conventional hybrid inverters, not plug-in.

## 4. Loose panels and mounts
- Branded rigid panels: EcoFlow 2x500 W bifacial **£439** (£219.50 each, ~£0.44/Wp); 2x450 W £399; 2x520 W £449; Thunder 400 W £199.99 [LIVE].
- Trade rigid panels: ITS Technologies 460 W Astronergy bifacial **£67 + VAT (£80.40)**, about £0.17/Wp; Trina 465 W £65 + VAT; Longi 475 W £80 + VAT (some have a minimum order of 6) [LIVE].
- Flexible / lightweight: Thunder 180 W £149.99 (sale £142.49); Zendure 2x210 W £309 (sold out); EcoFlow 400 W portable £549 [LIVE]. Roughly 2–4x rigid cost per Wp.
- Mounts [LIVE]:
  - EcoFlow: adjustable facade bracket £49, fixed facade £15, flat-roof/garden frame £79, lattice balcony £59, semi-enclosed balcony £99, concrete balcony £129, pitched roof £129, balcony hook kit £89, 0–90° tilt mount £89 (sold out).
  - Zendure: 2 sets of balcony, wall or floor brackets £72.99.
  - Generic 15–30° tilt frame: £34 + VAT.
- Loose panels and inverters **cannot** form a compliant plug-in kit. They only make sense for hardwired builds, e.g. 4 cheap panels into STREAM Ultra, Solarbank 4 or SolarFlow 2400 Pro MPPT inputs. Maplin says loose EZ1-M or HF-800-WB inverters (£119.99) must be hardwired.

## 5. Catalog schema
Required fields as specified, plus these extras:
- `installRoute`: plug-in vs hardwired-electrician.
- `enaRef`.
- `coupling`: `dc` or `ac` (batteries).
- `inverterEff`: datasheet weighted or peak efficiency where known.

Conventions:
- `includedPanels` is also used on `panel` entries to show the pack size.
- `pvInputMaxW` for the single-MPPT HF-800-WB is derived as 80 V x 16 A = 1280 W (**[INF]**). For the Fox M1-800-E it is 2 x 670 Wp ("applicable module power").
- `expansion.priceGbp` is the extra cost per pack (standalone, or the bundle difference where noted).
- Unknown values are `null`. No prices were invented.

## 6. Control strategies used in practice (what the simulator should offer)
1. **Microinverter-only kits.** No time-shifting. AC out = min(PV DC x inverter efficiency, 800 W, optional app output cap). EcoFlow allows Maximum Output Power in the app; Hoymiles and APsystems apps also allow a limit. Output covers the instantaneous load first and the rest is exported (unpaid by default). **Orientation and tilt are the only levers** for 16:00–19:00 output; facade brackets give 50° or 90° tilt. Two-MPPT inverters (Fox, EcoFlow, Marstek, APsystems) allow a split layout such as one panel SW and one W. Single-MPPT HF-800-WB kits do not.
2. **Load-following / zero feed-in (needs a meter).** Meters: Anker Smart Meter Gen 2 (dual CT, adjusts within 3 s), Zendure Smart Meter 1CT-S (£84.99) or 3CT (£129), Shelly Pro 3EM (£149 at EcoFlow) or 3EM, EcoFlow Smart Meter (£99) or Dual CT (£159), EcoFlow and Zendure smart plugs that meter individual loads. The battery discharges to match net import and charges from PV surplus. CT meters sit in the consumer unit, so an electrician is needed anyway.
3. **Fixed schedule without a meter.** Anker "Custom Mode" (user-defined charge and discharge schedules; the only mode without a meter). EcoFlow and Zendure have similar time-based plans **[2ND/INF on exact naming]**. With a flat 24/7 server load, a constant-output schedule set at or below base load works like load-following without needing a CT clamp.
4. **Time-of-use windows.** Anker TOU Mode, Zendure TOU, EcoFlow TOU: charge in off-peak hours and discharge in peak hours.
5. **Dynamic-price automation.**
   - EcoFlow **AI-TOU** needs a paid subscription. It uses tariff data from "Nord Pool, Epex Spot, Rabot Energy, Octopus" and only cycles when the price spread beats the losses.
   - Anker Smart Mode and Dynamic Tariff Mode ("Compatible with Octopus and 870+ tariffs"): AI using weather, usage and prices. Can export stored energy at the best times if you are on an export plan.
   - Zendure ZENKI 2.0: charges at low or negative prices and discharges at peaks; "covering 25 major UK energy providers". Supports MQTT and Home Assistant.
6. **Grid charging power.** STREAM Ultra/Pro/AC Pro 1050 W; Ultra X 1200 W; Solarbank 4 Pro 2500 W; SolarFlow 2400 Pro/AC+ 2400 W; HiBattery 1920 AC 1000 VA.

**Recommended simulator modes:**
- `pv-only`
- `self-consumption` (charge from surplus; discharge = min(net load, maxDischargeW, acLimitW) above a reserve SoC)
- `fixed-schedule` (W per time window)
- `price-threshold / cheapest-N-slots` (grid charge at acChargeW, discharge in the most expensive slots, capped at load when export is unpaid)
- `perfect-foresight optimiser` as an upper bound. Agile day-ahead prices are published around 16:00 for the next day, so price foresight is realistic; PV foresight is not.

**Default parameters to use where specs are blank:**
- Round-trip efficiency 0.87 for AC-coupled batteries (Hoymiles figure). Use about 0.90 for the PV-to-battery-to-AC path in DC-coupled units **[INF]**.
- Reserve SoC 10% **[INF]**.
- Usable capacity = nominal unless stated **[INF]**.
- Grid-tie cap 800 W for EcoFlow STREAM and Hoymiles; 2400–2500 W for Zendure and Anker once hardwired.

## 7. Implications for this user (servers, Agile, peak 16:00–19:00)
- **Constant base load helps the plug-in case.** If server load is at or above about 800 W, nearly all plug-in output is used in the home (export is unpaid anyway). Each kWh then saves the Agile price of the half-hour it is generated in. Model it per half-hour against the real load: export = max(0, PV_AC − load).
- Biggest legal plug-in build: 1 device, ≤2000 Wp DC on 800 VA. Oversizing the DC side (e.g. 2x515 W) raises shoulder-hour and evening output at the cost of midday clipping. That supports a west or vertical layout for 16:00–19:00. The two-MPPT kits allow split azimuths.
- **A battery forces the hardwired route**: electrician install cost (not found; needs a user input), G98 notification, and the whole system wired in. Once hardwired, the 800 W limit no longer applies to Anker or Zendure (2.4–2.5 kW), cheap trade panels become usable, and Octopus's non-MCS export route may apply.
- EcoFlow STREAM units also have an AC outlet (1200 W from battery, about 2300 W with bypass). Plugging servers directly into it is a UPS-style way to use battery power without going through the 800 W grid-tie output **[INF; check the manual]**.
- Do not model plug-in kit plus AC-coupled battery as compliant: the IPS forbids using a compliant kit with a battery.

## 8. Verification log
- **[LIVE]** EcoFlow UK Shopify JSON (all STREAM, panel and bracket prices and SKUs); EcoFlow product-page spec tables; Zendure UK Shopify; PatioSun Shopify; Solarfy Shopify; Thunder site prices; Screwfix 396MG (£669, JSON `"price":669`); Anker SOLIX UK ae103 page (£1,699, specs, hardwire statement); Octopus plug-in page and Outgoing pages; myplugin.solar; ITS Technologies; Maplin.
- **[DOC]** IPS v2.0, the July 2026 government response, the Ofgem G98 decision, the Fox ESS M-series datasheet, and the Hoymiles HF-800-WB datasheet and site.
- **[2ND]** City Plumbing, UKSOL/Argos and Perlight prices, plus ENA register counts (pluginsolarexplained.co.uk, last checked 2026-10-03). Argos returned 403. The City Plumbing search page is not scrapable.

## 9. Key URLs
- IPS v2.0: https://assets.publishing.service.gov.uk/media/6a60a03c47af652afa0c89f5/plug-in-solar-final-_interim-product-specification.pdf
- Government response, July 2026: https://assets.publishing.service.gov.uk/media/6a58dd1e24d4d0ad06d945e1/plug-in-solar-government-response-july-2026.pdf
- Ofgem G98 decision: https://www.ofgem.gov.uk/sites/default/files/2026-08/Ofgem-decision-to-Approve-DCRP-MP-26-02-Proposed-Amendment-to-facilitate-Plug-in-Microgeneration.pdf
- SI: https://www.legislation.gov.uk/uksi/2026/848/contents/made
- Registration: https://myplugin.solar/
- ENA register: https://connect-direct.energynetworks.org/device-databases/search-gen?device_type_id=14
- Octopus: https://octopus.energy/plug-in-solar-explore/ , https://octopus.energy/smart/outgoing/ , https://octopus.energy/blog/outgoing-faqs/
- EcoFlow UK: https://uk.ecoflow.com/products.json , /products/stream-ultra-pro , /products/stream-ultra-x , /products/ecoflow-stream-microinverter-wn
- Anker: https://www.ankersolix.com/uk/products/ae103
- Zendure: https://zendure.co.uk/products/zendure-solarflow-2400-pro
- Thunder: https://www.thunderenergy.co.uk/ , /product-page/vault-ms-a2
- PatioSun: https://patiosun.myshopify.com/products/patiosun-duo
- Solarfy: https://solarfy.co.uk/products/solarfy-duo-910-plug-in-solar-kit-910-w-ena-registered-garden-flat-roof
- Screwfix: https://www.screwfix.com/search?search=396MG
- Tracker: https://www.pluginsolarexplained.co.uk/kits/

Local copies are under research/sources/ (PDF text, Shopify JSON, page text in pages/). The fetch helper scripts are in research/kits-scripts/.
=====
- {'claim': 'Plug-in solar became legal in England, Wales and Scotland on 27 Aug 2026 via SI 2026/848, which amends the Plugs and Sockets Regs 1994 and ESQCR 2002.', 'source': 'https://www.legislation.gov.uk/uksi/2026/848/contents/made ; https://jontracey.substack.com/p/plug-in-solar-becomes-legal-in-great', 'verified_live': False, 'confidence': 'high'}
- {'claim': 'IPS v2.0: max 800 VA and 3.5 A AC; total PV DC ≤2000 W; professional assessment advised above 960 W; up to 4 modules, max 2 in series; BS 1363 plug only; no extension leads or adaptors.', 'source': 'https://assets.publishing.service.gov.uk/media/6a60a03c47af652afa0c89f5/plug-in-solar-final-_interim-product-specification.pdf', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'G98 Issue 2 Amd 1 2026 (Ofgem approval 11 Aug 2026) limits plug-in to one device per household at ≤800 W. Plug-in electricity storage stays prohibited from sale, supply or use.', 'source': 'https://www.ofgem.gov.uk/sites/default/files/2026-08/Ofgem-decision-to-Approve-DCRP-MP-26-02-Proposed-Amendment-to-facilitate-Plug-in-Microgeneration.pdf', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'The IPS excludes plug-in batteries and battery-integrated PV, and requires a warning that the kit must not be used with a battery storage system.', 'source': 'IPS v2.0 §1 and §8 (local copy sources/ips-v2.txt)', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'DNO notification via myplugin.solar (operated by ENA) is described as a legal requirement; only listed devices can be selected; one device per household.', 'source': 'https://myplugin.solar/', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Plug-in export is normally unpaid because SEG needs an MCS or equivalent certificate. Octopus pays Outgoing Prime (16p 16:00-19:00, 9p otherwise) only if the kit was bought from Octopus and Octopus supplies the home.', 'source': 'https://octopus.energy/plug-in-solar-explore/ ; https://octopus.energy/smart/outgoing/', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Octopus Plug-in Solar bundles cost £450 (1x460 W) and £650 (2x460 W) including VAT and delivery, ENA ref OCTOQ/21124/V1/A5. The inverter is reportedly a Fox ESS M1-800-E (2 MPPT, 800 VA, 96% max efficiency).', 'source': 'https://octopus.energy/plug-in-solar-explore/ ; Fox EN-M-E datasheet V2.1 ; pluginsolarexplained tracker for inverter ID', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'EcoFlow UK: STREAM Ultra £899 (1.92 kWh, 4 MPPT 2000 W, 800 W grid-tie, 1050 W AC charge, 6000 cycles, 10 y); Ultra X £1,299 (3.84 kWh); AC Pro £699; microinverter + 2x500 W £549. All STREAM batteries must be hardwired by an electrician in the UK.', 'source': 'https://uk.ecoflow.com/products.json and product pages', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Anker Solarbank 4 E5000 Pro: £1,699 (5.024 kWh LFP, 5000 W PV across 4 MPPT, 2500 W AC charge and output, 10,000 cycles, 10 y warranty), BP5000 expansion about £1,299. Must be hardwired by a Part P electrician; G98 ref ANKER/19908/V1.', 'source': 'https://www.ankersolix.com/uk/products/ae103', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Zendure SolarFlow 2400 Pro: £1,099 (2.4 kWh, 3000 W DC across 4 MPPT, 2400 W bidirectional AC, hardwired). AB3000L 2.88 kWh is £799. 2400 AC+ is £899.', 'source': 'https://zendure.co.uk/products/zendure-solarflow-2400-pro ; https://zendure.co.uk/products.json', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Screwfix sells the PowerXpress 2x460 W plug-in kit (code 396MG) for £669; the same kit is £599 direct.', 'source': 'https://www.screwfix.com/search?search=396MG ; pluginsolarexplained tracker', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Cheapest compliant kits are City Plumbing DMEGC + Hoymiles HiFlow: 1x465 W £336, 2x515 W £468.', 'source': 'https://www.pluginsolarexplained.co.uk/kits/ (checked 2026-10-03); hotukdeals 4977516', 'verified_live': False, 'confidence': 'medium'}
- {'claim': 'Hoymiles HiBattery 1920 AC (sold by Thunder as Vault for £1,049.99): 1.92 kWh, 1000 VA charge/discharge, 800 VA max output, 87% max round-trip efficiency, ≥6000 cycles. Thunder requires a professional AC connection.', 'source': 'https://www.thunderenergy.co.uk/product-page/vault-ms-a2 ; hoymiles.com HiBattery 1920 AC page via search', 'verified_live': True, 'confidence': 'medium'}
- {'claim': 'Trade loose panels cost about £80 including VAT for 460 W (£67 + VAT, Astronergy bifacial). Branded consumer panels run about £0.44–0.55/Wp; flexible panels about £0.79/Wp.', 'source': 'https://www.itstechnologies.shop/products/460w-astronergy-astro-n7-2-0-topcon-n-type-all-black-bifacial-minimum-order-1 ; uk.ecoflow.com ; thunderenergy.co.uk', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'BS 7671 A4:2026 (published 15 Apr 2026, mandatory from 2 Oct 2026) did not itself permit socket-connected generation; legality comes from SI 2026/848 plus the IPS.', 'source': 'https://www.pluginsolarexplained.co.uk/bs-7671-amendment-4/', 'verified_live': False, 'confidence': 'medium'}
- {'claim': 'No Lidl, Aldi or Iceland plug-in kit was on sale in GB as of early October 2026.', 'source': 'pluginsolarexplained tracker; solarsnap/ukpluginsolar Lidl guides', 'verified_live': False, 'confidence': 'medium'}
['research/plugin-kits.json', 'research/sources/ips-v2.pdf', 'research/sources/ips-v2.txt', 'research/sources/gov-response-july-2026.pdf', 'research/sources/gov-response-july-2026.txt', 'research/sources/ofgem-g98-decision.pdf', 'research/sources/ofgem-g98-decision.txt', 'research/sources/octopus-plug-in-solar.txt', 'research/sources/ecoflow-uk-all.json', 'research/sources/ecoflow-uk-bkw.json', 'research/sources/zendure-uk-all.json', 'research/sources/patiosun-all.json', 'research/sources/solarfy-all.json', 'research/sources/itstech-all.json', 'research/sources/foxess-M-E-datasheet.txt', 'research/sources/hoymiles-hf-800-2wb.txt', 'research/sources/pages/', 'research/kits-scripts/fetchtext.py', 'research/kits-scripts/shopify.py', 'research/kits-scripts/shopprod.py']
["Can Octopus Outgoing Prime (or Outgoing Fixed 12p / Agile Outgoing) be paired with an Agile import tariff for the Octopus plug-in bundle? Octopus's compatibility table is an image I could not read; worth asking Octopus.", 'What does an electrician charge to hardwire a battery system (dedicated circuit + G98 notification)? No UK price data was found. The app needs this as a user-editable cost.', "The user's actual base load (W) and whether the servers could be fed from a battery unit's own AC outlet (EcoFlow STREAM 1200 W outlet) instead of the 800 W grid-tie path; this needs checking against the manual.", 'Round-trip efficiency, usable capacity and PV-to-battery charge caps are unpublished for EcoFlow STREAM, Anker Solarbank 4 Pro and Zendure 2400. The simulator needs defaults (suggested RTE 0.87–0.90, 10% reserve).', "Whether EcoFlow's ENA-registered STREAM kits currently ship with a BS 1363 plug lead. UK pages still say the DIY cable must be wired in by an electrician.", 'Timeline for legal plug-in batteries (Octopus hopes for early 2027) and for moving to one device per circuit (pending a G98 amendment); either would change which options are worth simulating.', 'The ENA type-test register API is login-backed and could not be queried directly. Register counts (about 109 compliant devices) come from secondary trackers.']
