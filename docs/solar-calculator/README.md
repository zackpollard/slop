# Solar Calculator — research notes

The facts `projects/solar-calculator` relies on, researched and then independently re-checked on
4–5 October 2026, mostly against live APIs and primary sources. Each topic has a report and a
verification; **where they disagree, the verification wins** (it lists every correction).

| Topic | Report | Verification | What the app takes from it |
|---|---|---|---|
| Octopus Energy REST API | [REPORT-octopus.md](REPORT-octopus.md) | [VERIFY-octopus.md](VERIFY-octopus.md) | Browser CORS, Basic auth, account/consumption/rates paging, Agile versions and caps, the retroactive 0% VAT on long records, region lookup |
| Historical sunshine | [REPORT-irradiance.md](REPORT-irradiance.md) | [VERIFY-irradiance.md](VERIFY-irradiance.md) | Open-Meteo SARAH-3 at 30 min with the scan-time alignment fix, MSG/IFS gap fill, always pass `models=`, the 2006–2025 climatology |
| PV physics | [REPORT-pv.md](REPORT-pv.md) | [VERIFY-pv.md](VERIFY-pv.md) | NOAA/Perez/Martin–Ruiz/Faiman/PVWatts chain matched to pvlib and PVGIS, per-input inverter caps, sub-sampling, shading defaults |
| UK plug-in solar market and rules | [REPORT-market.md](REPORT-market.md) | [VERIFY-market.md](VERIFY-market.md) | SI 2026/848 and the 800 VA / 2000 Wp envelope, the plug-in battery prohibition, the kit catalog and prices, Outgoing Prime for Octopus kits |
| Agile economics and battery dispatch | [REPORT-agile.md](REPORT-agile.md) | [VERIFY-agile.md](VERIFY-agile.md) | Price statistics and formula, the levy cut, base-load costing, dispatch physics and the DP, finance formulas |
| Power stations as a UPS for servers | [REPORT-ups.md](REPORT-ups.md) | [VERIFY-ups.md](VERIFY-ups.md) | Why a socket-charged station is outside G98, measured conversion losses, the station catalog |

Paths such as `research/…` point at working files (raw API responses, scripts, fixtures) that were
not committed; the app's bundled data in `projects/solar-calculator/data/` and the test fixtures in
`lib/slopnet/__tests__/fixtures/solar/` are the committed copies. Prices and regulations change —
re-check before relying on them after October 2026.
