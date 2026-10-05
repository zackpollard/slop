Recommendation: get irradiance from the Open-Meteo Satellite Radiation API using the eumetsat_sarah3 model at temporal_resolution=native. That gives 30-minute GHI/DNI/DHI on a 0.05° grid, from 1983 to about 3 days ago, with CORS `*` (tested live). Get temperature and wind from the Open-Meteo Historical Weather (archive) API (best_match = ECMWF IFS, 9 km, hourly). Fill gaps and the most recent ~3 days from eumetsat_lsa_saf_msg, which is 15-minute, runs since 2025-01-01 and is about 2 hours behind real time. If both satellites miss a slot, use the archive's own radiation.

Correction to how the data is labelled. In general an Open-Meteo radiation value labelled L is the mean over (L-step, L]. I confirmed this three ways: GHI = DNI·cos(zenith) + DHI holds to 0.06 W/m² when the zenith is averaged over the preceding interval; fitting clear-sky days; and checking against KNMI ground pyranometers. SARAH-3 is the exception. Open-Meteo applies the (L-30, L] sun geometry, but the cloud information belongs to [L, L+30). I confirmed this against 8 KNMI stations (Apr–Aug 2026: hourly RMSE 16.1% with the fix vs 18.6% without) and against MSG/DWD over London. So for the Octopus slot [S, S+30) use SARAH-3 label S, scaled by meanCosZ(S,S+30)/meanCosZ(S-30,S). With that fix SARAH-3 is the most accurate source tested: bias -0.6% and r 0.975 against the ground stations. The archive (IFS) reads 5–7% high, with about 28% RMSE at hourly resolution.

Three calls fetch a full year in under 0.4 s: about 350 kB gzipped, and about 29 of the 10,000 weighted calls allowed per day per IP. Always use timezone=GMT. With Europe/London, Open-Meteo applies one fixed offset to the whole response and gets DST wrong. PVGIS has no CORS (its policy forbids browser AJAX calls) and its data runs 2005–2023, so I saved its outputs as validation references. NASA POWER allows CORS, but its solar data is about 3 months behind. Forecast.Solar allows CORS but offers forecasts only. Solcast, CAMS/SoDa, Renewables.ninja and PV_Live sent no CORS headers.

I saved a ready-to-use demo dataset: London, 17,520 half-hour slots, Oct 2025–Sep 2026, GHI 1205 kWh/m² (about 12% above the 2006–2025 SARAH-3 average of about 1072). There is also a working JS reference module that reproduces it within 0.5 W/m².
=====
# Historical irradiance and weather the browser can call, for a UK half-hourly PV simulation (verified 2026-10-05)

Everything marked **[live]** was tested from this machine with `curl` or Python on 2026-10-04 23:35–00:55 UTC, sending `Origin: https://solar-calculator.slop.zackpollard.pro`. **[docs]** means I read it on a provider page or in Open-Meteo source code on GitHub. **[inferred]** means my own analysis or interpretation. Scripts are in `/home/zack/.claude/jobs/52762e7f/tmp/research/scripts/`.

---
## 1. Recommendation

| Role | Source | Why |
|---|---|---|
| **Primary irradiance** | Open-Meteo **Satellite Radiation API**, `models=eumetsat_sarah3`, `temporal_resolution=native`: 30-min, 0.05° grid, 1983 → about 3 days ago | Native half-hour steps match Octopus slots. Most accurate source in the KNMI ground test (bias -0.6%, hourly RMSE 16.1% with the alignment fix). CORS `*`. |
| **Temperature and wind** | Open-Meteo **Historical Weather API** (`archive-api`), default `best_match` (= ECMWF IFS 9 km), hourly | The satellite API has no temperature or wind (it returns `"undefined"` units and nulls) **[live]** |
| **Fallback 1**: gaps and the last ~3 days | Satellite API `models=eumetsat_lsa_saf_msg`, native 15-min, since 2025-01-01, ~2 h behind real time | Bias +0.5%, hourly RMSE 18.7% against the ground stations. Land-only: no data for the Isles of Scilly. |
| **Fallback 2** | Archive `best_match` radiation, hourly | Always complete, but reads +5–7% high and has hourly RMSE of about 28% |

Do **not** use `satellite_radiation_seamless`. Before 2026-02 it silently returns ECMWF IFS values at hourly resolution, and nulls at native resolution **[live]**.

---
## 2. CORS results [live]

| Endpoint | GET with Origin | OPTIONS preflight | Usable from browser |
|---|---|---|---|
| `archive-api.open-meteo.com/v1/archive` | `access-control-allow-origin: *` | 200, `allow-headers: accept, authorization, content-type, ...`, `max-age: 600` | **Yes** |
| `historical-forecast-api.open-meteo.com/v1/forecast` | `*` | same | **Yes** |
| `satellite-api.open-meteo.com/v1/archive` | `*` | same | **Yes** |
| PVGIS `re.jrc.ec.europa.eu/api/v5_3/PVcalc` and `/seriescalc` | 200 but **no ACAO header** | `OPTIONS Method Not Allowed` | **No**. Policy page: "access to PVGIS APIs via AJAX is not allowed. Please, do not ask for changes in our CORS policy" |
| NASA POWER `power.larc.nasa.gov/api/temporal/hourly/point` | `*` | 404 (not needed for a simple GET) | Yes, but solar data is ~3 months behind |
| Forecast.Solar `api.forecast.solar/estimate/...` | `*` (also allows Authorization) | 200 | Yes, but forecast only. `/history` returns `'history' is not available with a 'Public' subscription`. Rate limit headers: `x-ratelimit-limit: 12`, `period: 3600`, zone = IP. |
| Solcast `api.solcast.com.au/data/historic/...` | 401, no ACAO | 204, **no ACAO** | No (tested without a valid key). The hobbyist tier is 10 calls/day, 2 rooftop sites, live estimated actuals and forecasts only, no history [docs]. |
| CAMS radiation (SoDa WPS) `api.soda-solardata.com/service/wps` | 400 XML, no ACAO | 405 | No. Also needs a registered email; 100 requests/day [docs]. |
| Met Office DataHub `data.hub.api.metoffice.gov.uk/sitespecific/v0/...` | 401 with `*` | 200, allows `authorization, apikey` | CORS works, but it serves **forecasts only**, no historical irradiance. MIDAS Open on CEDA needs a login (302 redirect to `Unauthenticated`). |
| Renewables.ninja `/api/data/pv` | 200, no ACAO | 405 | No |
| Sheffield Solar PV_Live `api.pvlive.uk/pvlive/api/v4/gsp/0` | 200, `vary: Origin`, **no ACAO** | 400 | No |
| Visual Crossing timeline | 401 with `*` | 200 | CORS works; needs an API key |

---
## 3. Open-Meteo endpoints in detail

### 3a. Historical Weather API: `https://archive-api.open-meteo.com/v1/archive`
- **Models** (`&models=`) [docs, source code `options.ts`]:
  - `best_match`: ECMWF IFS and ERA5
  - `ecmwf_ifs`: 9 km, 2017 onwards
  - `ecmwf_ifs_analysis_long_window`: no radiation [live]
  - `era5_seamless`, `era5` (0.25°), `era5_land` (0.1°, **no shortwave_radiation** [live])
  - `era5_ensemble`, `cerra` (5 km, ends June 2021)
- [live] For Oct 2025–Sep 2026 in London, `best_match` is byte-identical to `ecmwf_ifs` (grid cell 51.4938, -0.1630).
- **Radiation variables:**
  - `shortwave_radiation` (GHI), `direct_radiation`, `diffuse_radiation` (DHI), `direct_normal_irradiance` (DNI), `global_tilted_irradiance` (needs `&tilt=&azimuth=`), `terrestrial_radiation`
  - `*_instant` variants of all of the above
  - Docs wording: "Preceding hour mean"; "Instant" means the value at the indicated time.
- Other variables used: `temperature_2m`, `wind_speed_10m` (add `&wind_speed_unit=ms`), `cloud_cover`, `is_day`, `sunshine_duration`. Temperature and wind are instantaneous at the timestamp.
- **No minutely_15.** `end_date` must be ≤ today (UTC). Otherwise you get HTTP 400 `{"reason":"Parameter 'end_date' is out of allowed range from 1940-01-01 to 2026-10-04","error":true}` [live].
- **Max span:** no limit hit. Hourly temperature for 1940-01-01..2026-09-30 came back as 17.9 MB of JSON in 2.1 s [live].

### 3b. Historical Forecast API: `https://historical-forecast-api.open-meteo.com/v1/forecast`
- It stitches the first hours of each model run together. Coverage starts about 2022:
  - UKMO UK 2 km (`ukmo_uk_deterministic_2km`): since 2022-03-01
  - ICON-D2 (`dwd_icon_d2`): since 2022-11-24. London is inside its domain.
  - ECMWF IFS: since 2017
- **minutely_15** works. The docs say "Only available in Central Europe and North America. Other regions use interpolated hourly data."
- [live] UKV 15-min radiation for London is **smoothly interpolated and does not conserve energy**. On 2025-06-22 the hour ending 12:00 is 434 W/m² hourly, but the mean of its four 15-min values is 483 W/m². **Don't use it.**
- UKV hourly over 12 months against SARAH-3: r 0.950, -6.7% bias.

### 3c. Satellite Radiation API: `https://satellite-api.open-meteo.com/v1/archive` (exists in 2026) [live + docs + source]

| `models=` id | Satellite | Native step | Grid | Archive start (verified) | Latency (observed 2026-10-04 23:43Z) |
|---|---|---|---|---|---|
| `eumetsat_sarah3` | CM SAF SARAH-3 (MSG) | **30 min** | 0.05° | 1983 (data present 1983-01-01) | last value 2026-10-01T23:30, so **about 3 days** |
| `eumetsat_lsa_saf_msg` | LSA SAF MSG | 15 min | 0.05° (land only) | 2025-01-01 (2024 is all null) | last value 2026-10-04T23:00, ~2 h |
| `eumetsat_lsa_saf_iodc` | LSA SAF IODC | 15 min | 0.05° | 2025 | has gaps |
| `dwd_sis_europe_africa_v4` | DWD, MTG | 10 min | 0.025° | **2026-02-14T19:00** | ~20 min |
| `jma_jaxa_mtg_fci` | JAXA, MTG FCI | 10 min | 0.05° | 2025-01-01 | **stopped 2026-03-09** |
| `satellite_radiation_seamless` | auto | — | — | — | Falls back to IFS before 2026-02. Avoid. |

- **Variables:** the same radiation set as the archive, including `*_instant` and `global_tilted_irradiance` with `tilt`/`azimuth`, plus `shortwave_radiation_clear_sky` (DWD MTG only), `is_day` and `sunshine_duration`. Daily `shortwave_radiation_sum` (MJ/m²) also works [live].
- **Pitfalls [live]:**
  - Native data comes only from `hourly=...&temporal_resolution=native`, and the response key is still `"hourly"`.
  - `minutely_15=` silently returns no data block.
  - Asking for several models with native resolution in one request returns **HTTP 200 with a plain-text body** `Unexpected error while streaming data: cannotReturnModelsWithDifferentTimeIntervals`. Make one request per model and always try/catch the JSON parse.
  - MSG gives GHI=0 but **DNI, DHI and direct = null at night**. Treat null DNI as 0 and null DHI as GHI.
- **Coverage [live]:**
  - SARAH-3 has full non-null coverage at Lerwick, Inverness, Belfast, Penzance, the Isles of Scilly and Brighton.
  - MSG has no data at the Isles of Scilly (land mask).
  - In the last 12 months SARAH-3 is missing 8 whole days in London: 2026-02-13, 03-15..18, 03-31, 07-01, 07-20. MSG covers all of them except 3 slots.

### 3d. Azimuth convention for global_tilted_irradiance [docs + live]
- 0° = south, -90° = east, +90° = west, ±180° = north. Tilt 0° is horizontal, 90° is vertical. Set `azimuth=nan` or `tilt=nan` for trackers.
- Live check, vertical panels on 2026-07-12: `azimuth=-90` peaks in the morning; `+90` peaks in the afternoon (5.12 kWh/m² that day).
- Same convention as PVGIS `aspect`.
- Open-Meteo's GTI uses an **isotropic sky model, albedo 0.2, and the interval-mean sun position** (source `GlobalTilitedIrradiance.swift`). For SARAH-3 it would also inherit the timing quirk in §4. **Compute POA in-app from aligned GHI/DNI/DHI** (Perez or Hay-Davies) rather than using Open-Meteo's GTI.

### 3e. Timezone behaviour [live]
- `timezone=Europe/London` applies **one fixed `utc_offset_seconds` (3600 here) to the whole response**, even across the DST changes on 2025-10-26 and 2026-03-29. Every day still has exactly 48 half-hours, so local timestamps are wrong on one side of each change.
- **Always use `timezone=GMT`**, preferably with `timeformat=unixtime`: absolute epoch seconds, e.g. `1782000000` = 2026-06-21T00:00Z.
- ISO strings returned under GMT have no `Z`. Parse them as UTC: `Date.parse(t + ':00Z')`.

---
## 4. Time convention: what a timestamp means (the alignment test)

**Energy-balance check, London, 2025-06-21..22.** The table shows the RMS of GHI − (DNI·cosZ + DHI) in W/m², for daytime values with GHI > 50:

| Series | cosZ(t) | cosZ(t − step/2) | cosZ(t − step) | **mean cosZ over [t − step, t)** | mean cosZ over [t, t + step) |
|---|---|---|---|---|---|
| archive best_match, hourly | 27.8 | **0.61** | 28.8 | **0.06** | 53.3 |
| SARAH-3, 30 min | 13.7 | 0.14 | 14.0 | **0.05** | 27.0 |
| MSG, 15 min | 6.94 | 0.06 | 7.09 | **0.05** | 13.8 |
| HF UKV, 15 min | 5.89 | 0.06 | 6.01 | **0.05** | 11.7 |

So the answer to "use the sun at mid-interval (timestamp − 30 min)?" is yes. The balance holds to about 0.6 W/m² with the mid-interval sun, and exactly when using the zenith averaged over the preceding interval. This works because Open-Meteo derives DNI as direct / mean cosZ over (t − step, t]. GHI = direct + diffuse exactly (≤ 2 W/m² of rounding).

This check only proves Open-Meteo's *geometry* convention. Cloud timing needed separate tests:

- **Mean daily profile across the year (London, 12 months):**
  - archive: GHI centroid falls 28.8 min after solar noon (an end-labelled hourly mean predicts +30) → end-labelled, confirmed.
  - ERA5: +29.8.
- **Clear-sky fit on 95 clear days:** best shift was -2 min for the archive and -2 for ERA5. Both are consistent with backward means.
- **Ground truth from KNMI pyranometers** (hourly global radiation `Q`, J/cm², where hour HH covers (HH−1, HH] UT; W/m² = Q × 10000 / 3600). The POST endpoint `https://www.daggegevens.knmi.nl/klimatologie/uurgegevens` needs no key. I used 8 stations: De Bilt, Schiphol, Rotterdam, Eelde, Vlissingen, Maastricht, Eindhoven, Leeuwarden. Apr–Aug 2026, daylight hours pooled (~18.5k). "A" assumes label L covers (L−step, L]; "B" assumes label L covers [L, L+step) with the geometry rescaled.

| Source | Convention | r | Bias | MAE | RMSE |
|---|---|---|---|---|---|
| **SARAH-3** | **B (forward)** | **0.9750** | **-0.6%** | **10.2%** | **16.1%** |
| SARAH-3 | A (as documented) | 0.9682 | -0.8% | 11.8% | 18.6% |
| DWD MTG | A | 0.9767 | +5.2% | 11.3% | 16.8% |
| DWD MTG | B | 0.9761 | +5.2% | 11.4% | 16.8% |
| MSG | A | 0.9736 | +0.5% | 13.2% | 18.7% |
| MSG | B | 0.9717 | +0.4% | 13.5% | 19.0% |
| IFS (archive) | A | 0.9291 | +6.7% | 17.3% | 28.4% |
| IFS (archive) | B | 0.9110 | +5.8% | 19.8% | 30.5% |

- **Cross-correlating clearness index between satellites** (London, Apr–Aug 2026, 10-min steps):
  - SARAH-3 label L matches the DWD 10-min window ending L+10 best (r .902, against .854 at L).
  - It matches the MSG 15-min window ending L+15 best (.913, against .869 at L).
  - MSG and DWD peak against each other at offset 0.
- **Half-hour level, London, Mar–Sep 2026:**
  - Against MSG: SARAH-3 A gives r .950, B gives r .969.
  - Against DWD: A gives .951, B gives .972.
- **Explanation from the source code** (`EumetsatSarahDownloader.swift` / `Zensun.instantaneousSolarRadiationToBackwardsAverages`): Open-Meteo takes SARAH-3's *instantaneous* scan, which over the UK happens about 10 min after the slot time. It turns that scan's clearness index into a backward mean over (T−30, T] while keeping label T. So the geometry is backward but the cloud snapshot is forward.
- **PVGIS agrees:** PVGIS rows `YYYYMMDD:HH10` match Open-Meteo SARAH-3 labels HH:00 and HH:30 best (r 0.982, against 0.928 for HH:30 and HH+1:00). So treat a PVGIS row HH:10 as covering the hour [HH:00, HH+1:00) UTC.

**Rules for converting to Octopus slots.** Slot = [S, S+30 min) UTC, S on :00 or :30. mcz(a, b) is the mean of max(cosZ, 0) over [a, b).
- **SARAH-3:** use label **S**, scaled by f = mcz(S, S+30) / mcz(S−30, S), for GHI, DHI and direct. DNI stays unchanged.
  - If mcz(S−30, S) < 0.05 (the sunrise slot), use label S+30 unscaled.
  - If mcz(S, S+30) = 0, the slot gets 0.
- **MSG 15-min:** mean of labels S+15 and S+30.
- **DWD MTG 10-min:** mean of labels S+10, S+20 and S+30.
- **Archive hourly:** the slot sits inside the hour labelled H = floor_hour(S) + 1 h, which covers (H−1h, H]. Disaggregate keeping the clearness index constant: GHI_slot = GHI_H × mcz(S, S+30) / mcz(H−1h, H), and the same for DHI. DNI stays unchanged. This conserves energy because the two slots average to the hour value.
- **temperature_2m and wind_speed_10m:** linear interpolation between hourly labels at the slot midpoint S+15.
- **Request range:** `start_date` = first day, `end_date` = last day + 1 (capped at today UTC), so the end-labelled values for the last slots are included.
- **Self-check (recommended in the app):** you already fetch SARAH-3 and MSG. Compute the correlation of SARAH-3 A and B against MSG on overlapping daylight slots and pick the better one. That protects the app if Open-Meteo ever fixes the SARAH-3 labelling.

---
## 5. Limits, weighting, errors, licence

- **Free tier, per IP** [docs, and `RateLimiter.swift` defaults]:
  - 600 calls/min, 5,000 calls/hour, 10,000 calls/day, 300,000 calls/month
  - non-commercial use only
  - Every visitor's browser counts against its own IP.
- **Call weighting** (`ForecastApiResult.swift`): `weight = max(1, max(nVars/10, nVars/10 * days/14)) * locations`, where nVars = variables × models.
  - Recommended 12-month set: SARAH-3 with 3 variables over 366 days ≈ 7.8; MSG ≈ 7.8; archive with 5 variables ≈ 13.1. **About 29 weighted calls in total.**
  - A 20-year daily SARAH-3 sum is about 55.
- **Error responses:**
  - 400 JSON `{"error":true,"reason":...}`.
  - 429 with `"Minutely API request limit exceeded. Please try again in one minute."`, or the hourly or daily equivalents.
  - 503 `"The service is overloaded"`, or `"Too many concurrent requests"`.
  - Six parallel 12-month requests from one IP all succeeded [live].
- **Licence:** CC BY 4.0. Required attribution: `<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>` [docs]. For SARAH-3, EUMETSAT asks for "© 2026 EUMETSAT" and a CM SAF acknowledgement, citing DOI 10.5676/EUM_SAF_CM/SARAH/V003 [docs]. Suggested footer: *"Weather data by Open-Meteo.com (CC BY 4.0). Solar radiation: © EUMETSAT, CM SAF SARAH-3 (doi:10.5676/EUM_SAF_CM/SARAH/V003) and LSA SAF; temperature/wind: ECMWF IFS."*
- **Latency summary [live, at 2026-10-04 23:43Z]:**

| Source | Latest data |
|---|---|
| archive best_match / ecmwf_ifs | up to 2026-10-04T23:00. No delay, but the most recent hours are IFS forecast values. |
| ERA5 / era5_seamless | 2026-09-28T23:00, about 6 days behind |
| SARAH-3 | 2026-10-01T23:30, about 3 days behind |
| MSG | ~2 h |
| DWD MTG | ~20 min |
| NASA POWER, solar | 2026-06-30, about 3 months behind |
| NASA POWER, T2M | about 2 days behind |

---
## 6. Samples, the 12-month dataset, and how the sources compare

- **Archive hourly sample** (London 2025-06-21..22: GHI, direct, DHI, DNI, GTI at tilt 35°/azimuth 0°, instants, temperature, wind in m/s, cloud cover): `openmeteo-archive-sample.json`. 4.8 kB, 0.16 s.
- **15-min sample** (real satellite MSG 15-min; the HF UKV 15-min version is interpolated): `openmeteo-15min-sample.json`. Comparison files for the same days are in `samples/cmp-*.json`: ERA5, ERA5-Land, IFS, era5_seamless, SARAH-3 native and hourly, MSG, MTG FCI, HF UKV/ICON-D2/best 15-min, HF UKV hourly.
- **12-month London downloads (2025-10-01..2026-09-30):**

| File | Content | JSON | gzip | Time |
|---|---|---|---|---|
| `openmeteo-london-12m.json` | archive best_match hourly, 7 variables | 445 kB | 89 kB | 0.44 s |
| `openmeteo-london-12m-sarah3-30min.json` | SARAH-3 native, 4 variables | 663 kB | 105 kB | 0.32 s |
| `openmeteo-london-12m-msg-15min.json` | MSG native, 4 variables | 1.37 MB | 211 kB | 1.09 s |
| `samples/12m-hf-ukv-hourly.json` | Historical Forecast UKV hourly | 444 kB | — | 1.39 s |
| `samples/12m-archive-era5.json`, `samples/12m-archive-ecmwf_ifs.json` | archive per model | — | — | — |

- **Merged demo dataset:** `demo-london-12m-halfhourly.json` (350 kB). It is aligned to Octopus slots and built with the rules in §4.
  - Fields: `meta`, plus arrays `ghi`, `dni`, `dhi` (W/m²), `temp` (°C), `wind` (m/s) and `src` (0 = SARAH-3, 1 = MSG, 2 = IFS).
  - 17,520 slots starting 2025-10-01T00:00Z. Source counts: SARAH-3 17,136, MSG 382, IFS 2.
  - The three calls take 0.38 s in parallel.
- **Annual GHI, London, Oct 2025–Sep 2026** (kWh/m²):

| Source | GHI | Note |
|---|---|---|
| SARAH-3, corrected and gap-filled | 1205 | |
| MSG | 1203 | has gaps |
| IFS | 1256 | |
| ERA5 | 1173 | 2 days missing |
| UKV | 1117 | |

- **Monthly SARAH-3 values are also in the analysis output.**
- **2023 cross-check:** PVGIS-SARAH3 1093, Open-Meteo SARAH-3 1089, Open-Meteo IFS 1129.
- **Long-term context:** SARAH-3 annual GHI for London over 2006–2025 has a mean of about 1072 (range 1003–1157). The last 12 months were about 12% sunnier than average. The app should consider showing a "typical year" scaling. One call gets it: `daily=shortwave_radiation_sum&models=eumetsat_sarah3&start_date=2005-01-01&end_date=2025-12-31` (142 kB, 0.26 s).
- **Hourly agreement with SARAH-3 in London** (A-labelled, so these slightly understate the agreement):

| Source | r | Bias | RMSE |
|---|---|---|---|
| MSG | 0.974 | +1.3% | 20% |
| UKV | 0.950 | -6.7% | 27% |
| IFS | 0.943 | +5.0% | 29% |
| ERA5 | 0.933 | -1.3% | 31% |
| NASA POWER | 0.944 | +1.2% | 32% |

---
## 7. PVGIS (for validation only)

- Latest is `v5_3`. `v5_4`, `v6` and `v6_0` return 404 [live]. Rate limit is 30 calls/s per IP [docs].
- Years available: `startyear` must be between **2005 and 2023** for both PVGIS-SARAH3 and PVGIS-ERA5 [live error message].
- PVcalc defaults to `radiation_db: PVGIS-SARAH3`, `meteo_db: ERA5`, years 2005–2023.
- **London reference yields** (`peakpower=1`, `loss=14`) are saved in `pvgis/summary.json` and `pvgis/pvcalc_*.json`:

| Orientation | Tilt | Aspect | E_y (kWh/kWp) |
|---|---|---|---|
| south | 35° | 0 | 1019 |
| south, vertical | 90° | 0 | 743 |
| west | 35° | +90 | 787 |
| west, vertical | 90° | +90 | 499 |
| east | 35° | -90 | 817 |
| south-west | 35° | +45 | 947 |
| south-west | 60° | +45 | 887 |
| flat | 0° | — | 845 (horizontal irradiation H 1070 kWh/m²) |

- Hourly series for 2023: `pvgis/seriescalc_2023_south35.json` (E = 1007 kWh/kWp) and `pvgis/seriescalc_2023_horizontal.json`.
- Row format: `{"time":"20230621:1210","P":..,"Gb(i)":..,"Gd(i)":..,"Gr(i)":..,"H_sun":..,"T2m":..,"WS10M":..}`. Treat time HH:10 as the hour [HH:00, HH+1).

---
## 8. URL templates

```
SAT(model) = https://satellite-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={YYYY-MM-DD}&end_date={min(last+1d, todayUTC)}&timezone=GMT&timeformat=unixtime&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation&models={eumetsat_sarah3|eumetsat_lsa_saf_msg}&temporal_resolution=native
ARCHIVE   = https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date=...&end_date=...&timezone=GMT&timeformat=unixtime&hourly=shortwave_radiation,direct_normal_irradiance,diffuse_radiation,temperature_2m,wind_speed_10m&wind_speed_unit=ms
```

A working, tested browser ES module is in `weather-align-reference.mjs`. It has `buildUrls`, `fetchJson` (with non-JSON and error handling), `indexByTime`, `alignToSlots`, `cosZenith` (NOAA) and `meanCosZ`. Running it with `node weather-align-reference.mjs` refetches the data and reproduces the Python demo within 0.5 W/m².

**Gotchas:**
1. Always send `timezone=GMT`.
2. Fetch one model per request.
3. Response keys are `hourly` even for 10/15/30-min data.
4. Treat null MSG DNI/DHI at night as 0 / GHI.
5. Treat an HTTP 200 with a text body as an error.
6. Grid snaps:
   - SARAH-3 and MSG: 0.05° (London → 51.50, -0.15)
   - IFS: ~9 km (London → 51.494, -0.163)
   - ERA5: 0.25°
7. Show the attribution line from §5.
=====
- {"claim": "archive-api, historical-forecast-api and satellite-api.open-meteo.com all return access-control-allow-origin: * on GET, and OPTIONS preflight returns 200 with allow-headers including authorization, max-age 600", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "Open-Meteo Satellite Radiation API exists at https://satellite-api.open-meteo.com/v1/archive. Model ids are eumetsat_sarah3 (30-min, from 1983), eumetsat_lsa_saf_msg (15-min, from 2025-01-01), eumetsat_lsa_saf_iodc, dwd_sis_europe_africa_v4 (10-min, from 2026-02-14), jma_jaxa_mtg_fci (stopped 2026-03-09) and satellite_radiation_seamless. Native steps need hourly=...&temporal_resolution=native.", "source": "live curl + open-meteo-website options.ts", "verified_live": true, "confidence": "high"}
- {"claim": "satellite_radiation_seamless before Feb 2026 returns ECMWF IFS values (identical to the archive best_match), not SARAH-3. Specify models=eumetsat_sarah3 explicitly.", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "Open-Meteo radiation labelled L is the mean over (L-step, L]: GHI = DNI*meanCosZ(L-step..L) + DHI holds to 0.05-0.06 W/m2 RMS, against 28 W/m2 using cosZ at L for hourly data", "source": "live data + inferred analysis (scripts/analyse_alignment.py)", "verified_live": true, "confidence": "high"}
- {"claim": "Open-Meteo's SARAH-3 values carry cloud information for [L, L+30) while the sun geometry is for (L-30, L]. Using label S for Octopus slot [S, S+30), rescaled by meanCosZ(S,S+30)/meanCosZ(S-30,S), lowers hourly RMSE against 8 KNMI pyranometers from 18.6% to 16.1% (r 0.968 to 0.975)", "source": "live KNMI uurgegevens + Open-Meteo data; Open-Meteo source EumetsatSarahDownloader.swift/Zensun.swift", "verified_live": true, "confidence": "high"}
- {"claim": "Against KNMI ground stations (Apr-Aug 2026, hourly): SARAH-3 corrected bias -0.6% RMSE 16.1%; MSG +0.5% / 18.7%; DWD MTG +5.2% / 16.8%; archive IFS +6.7% / 28.4%", "source": "live KNMI + Open-Meteo (scripts/ground_truth_knmi.py)", "verified_live": true, "confidence": "high"}
- {"claim": "Latency at 2026-10-04 23:43Z: SARAH-3 last 2026-10-01T23:30 (~3 days); MSG ~2 h; DWD MTG ~20 min; ERA5 2026-09-28T23:00 (~6 days); archive best_match/IFS up to the current hour (recent hours are forecast); end_date > today UTC returns HTTP 400", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "timezone=Europe/London applies one fixed utc_offset_seconds (3600) to the whole response, so DST changes are wrong. Use timezone=GMT and preferably timeformat=unixtime.", "source": "live curl (scripts/tz_gti.py)", "verified_live": true, "confidence": "high"}
- {"claim": "global_tilted_irradiance azimuth: 0 = south, -90 = east, +90 = west, \u00b1180 = north. Open-Meteo GTI uses an isotropic sky with albedo 0.2.", "source": "docs + live check + GlobalTilitedIrradiance.swift", "verified_live": true, "confidence": "high"}
- {"claim": "Free-tier limits per IP: 600/min, 5000/hour, 10000/day, 300000/month. Weight = max(1, max(nVars/10, nVars/10*days/14)) per location. A 12-month 3-call fetch costs about 29 weighted calls.", "source": "open-meteo.com/en/terms + RateLimiter.swift + ForecastApiResult.swift", "verified_live": false, "confidence": "high"}
- {"claim": "No max date span hit: 1940-2026 hourly temperature returned in 2.1 s (17.9 MB). 12 months of SARAH-3 30-min data is 663 kB JSON / 105 kB gzip in 0.32 s.", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "Historical Forecast API minutely_15 for the UK (UKV) is interpolated from hourly and not energy-conserving (an hour's mean of 15-min values differs from the hourly value by up to \u00b111%)", "source": "live data (scripts/check15.py)", "verified_live": true, "confidence": "high"}
- {"claim": "The satellite API has no temperature/wind (returns undefined units/nulls); minutely_15= on the satellite API returns no data block; several models with native resolution in one request returns HTTP 200 with text 'cannotReturnModelsWithDifferentTimeIntervals'", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "MSG LSA SAF returns GHI=0 with DNI/DHI/direct null at night, and has no data over the Isles of Scilly (land mask); SARAH-3 covers the whole UK including Shetland and Scilly", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "PVGIS v5_3 sends no CORS headers (OPTIONS 'Method Not Allowed'); JRC policy forbids AJAX use; seriescalc years 2005-2023; v5_4/v6 return 404", "source": "live curl + JRC API docs page", "verified_live": true, "confidence": "high"}
- {"claim": "PVGIS London 1 kWp, 14% loss: south 35\u00b0 1019, vertical south 743, west 35\u00b0 787, vertical west 499, east 35\u00b0 817, south-west 35\u00b0 947 kWh/kWp/yr", "source": "live PVGIS v5_3 PVcalc", "verified_live": true, "confidence": "high"}
- {"claim": "NASA POWER hourly has CORS * but solar parameters are ~3 months behind (last valid 2026-06-30), timestamps mark the start of the hour in UTC, 1\u00b0 solar resolution; T2M ~2 days behind", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "Forecast.Solar public API has CORS * but is forecast only; /history needs a paid plan; limit 12 calls/hour per IP (from response headers)", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "Solcast, CAMS/SoDa, Renewables.ninja and Sheffield Solar PV_Live send no Access-Control-Allow-Origin header; not browser-callable", "source": "live curl (Solcast tested without a valid key)", "verified_live": true, "confidence": "medium"}
- {"claim": "London annual GHI Oct 2025-Sep 2026 is 1205 kWh/m2 (SARAH-3 corrected, gap-filled), about 12% above the 2006-2025 SARAH-3 mean of about 1072", "source": "live Open-Meteo satellite API", "verified_live": true, "confidence": "high"}
- {"claim": "Open-Meteo data is CC BY 4.0 with the attribution 'Weather data by Open-Meteo.com' linked; SARAH-3 needs \u00a9 EUMETSAT plus a CM SAF acknowledgement (DOI 10.5676/EUM_SAF_CM/SARAH/V003)", "source": "https://open-meteo.com/en/licence; EUMETSAT CM SAF licence pages", "verified_live": false, "confidence": "high"}

ARTIFACTS: ["/home/zack/.claude/jobs/52762e7f/tmp/research/openmeteo-archive-sample.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/openmeteo-15min-sample.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/openmeteo-london-12m.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/openmeteo-london-12m-sarah3-30min.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/openmeteo-london-12m-msg-15min.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/demo-london-12m-halfhourly.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/weather-align-reference.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/pvgis/summary.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/pvgis/seriescalc_2023_south35.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/pvgis/seriescalc_2023_horizontal.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/samples/knmi-hourly-Q-2026-04..08.txt", "/home/zack/.claude/jobs/52762e7f/tmp/research/samples/nasa-power-12m.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/samples/sarah3-london-daily-2005-2025.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/scripts/analyse_alignment.py", "/home/zack/.claude/jobs/52762e7f/tmp/research/scripts/ground_truth_knmi.py", "/home/zack/.claude/jobs/52762e7f/tmp/research/scripts/build_demo.py", "/home/zack/.claude/jobs/52762e7f/tmp/research/scripts/solar.py"]
OPEN: [
 "The SARAH-3 'forward cloud information' fix was checked against Dutch KNMI pyranometers and London satellite cross-checks, not a UK ground station (Met Office MIDAS Open needs a CEDA login). The fix is strongly supported but not tested at a UK site.",
 "Open-Meteo could change its SARAH-3 labelling at any time. Should the app run the suggested self-check at runtime (correlate SARAH-3 A vs B against MSG and pick the better)?",
 "Should the app scale results to a 'typical year' (the last 12 months were about 12% sunnier than the 2006\u20132025 average) or show both?",
 "The DWD MTG (10-min, from Feb 2026) source reads about 5\u20137% high against ground stations and SARAH-3. Should it be left out of the fallback chain (as recommended) or bias-corrected?",
 "Solcast CORS was only tested without a valid key (no CORS headers on 401/204). This doesn't matter, because the free tier has no history anyway.",
 "Open-Meteo's free tier is non-commercial only. The slop site seems to qualify (no ads or subscriptions), but the user should confirm."
]