I wrote and tested a plain-JS PV model (ES module, no dependencies) that turns hourly GHI/DHI, air temperature and wind into 30-minute AC energy for tilted or vertical plug-in panels: /home/zack/.claude/jobs/52762e7f/tmp/research/pv-reference.js. All test scripts pass.

The chain is: NOAA/Meeus sun position, Perez 1990 transposition (Hay-Davies as fallback), Martin-Ruiz incidence-angle losses, Faiman cell temperature, PVWatts DC with a low-light correction, a list of DC losses multiplied together, the PVWatts inverter curve with a per-input DC cap and an 800 W AC cap, an optional bifacial term and a horizon profile.

Accuracy:
- **Sun position:** 1990-2050 against NREL SPA (pvlib), mean error 0.003 deg and 99th percentile 0.011 deg.
- **Transposition code:** matches pvlib to 1e-4 W/m2.
- **Against PVGIS, London 2023:** a Muneer-plus-Huld setup built to mimic PVGIS lands within -0.6% to +0.5% of PVGIS's hourly power over the year. Perez gives +1.3% plane-of-array irradiance on S35. On W90 it gives +0.6% once ground reflection follows PVGIS's rule (reflect only diffuse while the sun is behind the panel), or +4.2% without that rule.

Hourly to half-hour: split each hour using a clear-sky shape (Ineichen) with 2-3 sub-samples per half-hour. Against a 1-minute synthetic truth this halves the half-hour error compared with copying the hourly value into both halves, and on W90 it cuts the 16:00-19:00 bias from +2.1% to +0.2%.

Things the implementer must know:
- PVGIS sends no CORS headers, so it cannot be called from the browser; it is used for fixtures only.
- Open-Meteo archive data is the mean of the preceding hour (checked by a clear-sky fit). PVGIS values stamped HH:10 behave as centred on HH:10.
- Open-Meteo's ERA5-based irradiance gives about 9-12% more yield on tilted or vertical panels than PVGIS's satellite data (SARAH3) for London 2023.
- With 2023 Agile prices and every kWh used in the house, south to south-south-west at 30-45 deg is still worth the most per year (about GBP 185-189 for an 800 Wp kit). Vertical west earns the highest price per kWh (23.5p) but produces about 48% less energy and is worth about GBP 117. Tilting west for the peak alone does not pay; a battery is the better way to shift energy into 16:00-19:00.
=====
# PV performance model for small plug-in systems: formulas, constants, reference JS and validation

How each claim was established:
- **[LIVE]**: checked with curl or by running code today (2026-10-05).
- **[SRC]**: read in primary source code or docs. This covers pvlib-python 0.16.1 (downloaded to `pvlib_src/`), the GRASS r.sun C source (PVGIS's engine), the NOAA calculator `main.js`, and the PVGIS methods page.
- **[INF]**: my inference.

All files are in `/home/zack/.claude/jobs/52762e7f/tmp/research/`.

---
## 0. Recommended default chain (what the app should run)

```
Open-Meteo hourly (timezone=GMT, wind_speed_unit=ms):
  shortwave_radiation (GHI), diffuse_radiation (DHI), temperature_2m, wind_speed_10m
   -> hourlyToHalfHourly(...)    clear-sky-index split, 2-3 sub-samples per half-hour, DNI recomputed
   -> per sample:
        sunPosition (NOAA, apparent zenith)
        poaIrradiance (Perez 1990, albedo 0.2; groundSelfShade=true if wall- or railing-mounted)
        horizon / shading (beam blocked by horizon profile; isotropic and horizon-band factors)
        effectiveIrradiance (Martin-Ruiz a_r 0.16 for beam and circumsolar, MR-diffuse for sky and ground)
        [+ bifaciality * (1 - rearShading) * rear POA]
        Faiman Tc (U0 26.9, U1 6.2 for 10 m wind; presets below)
        PVWatts DC (gamma from datasheet, Marion low-light k 0.005-0.01)
          * lossFactor (about 5.9%) * degradation
        per-MPPT DC cap -> PVWatts inverter efficiency (eta_nom 0.96) -> AC cap 800 W
        night: -standbyW
   -> mean over sub-samples * 0.5 h = Wh per half-hour (UTC tStart aligned to Agile periods)
```

Speed in node 24: splitting one year takes about 65 ms. Simulating one system-year takes about 30-150 ms (subSteps 2-3). A 61-orientation sweep on two data sources took 3.7 s. Sun positions and clear-sky values are computed once in the split and reused by every configuration.

---
## 1. Solar position (NOAA / Meeus, as in gml.noaa.gov/grad/solcalc/main.js) [SRC + LIVE test]

```
JD = ms/86400000 + 2440587.5 ;  T = (JD - 2451545)/36525            (UT; dT ignored, effect ~3e-5 deg)
L0 = (280.46646 + T(36000.76983 + 0.0003032 T)) mod 360               mean longitude
M  = 357.52911 + T(35999.05029 - 0.0001537 T)                        mean anomaly
e  = 0.016708634 - T(0.000042037 + 0.0000001267 T)
C  = sin M (1.914602 - T(0.004817 + 0.000014 T)) + sin 2M (0.019993 - 0.000101 T) + 0.000289 sin 3M
trueLong = L0 + C ;  v = M + C ;  R = 1.000001018(1 - e^2)/(1 + e cos v)  [AU]
Omega = 125.04 - 1934.136 T ;  lambda = trueLong - 0.00569 - 0.00478 sin Omega
eps0 = 23 + (26 + (21.448 - T(46.815 + T(0.00059 - 0.001813 T)))/60)/60 ;  eps = eps0 + 0.00256 cos Omega
decl = asin(sin eps * sin lambda)
y = tan^2(eps/2)
EoT[min] = 4 * deg( y sin2L0 - 2e sinM + 4ey sinM cos2L0 - 0.5y^2 sin4L0 - 1.25e^2 sin2M )
TST[min] = (minutesUTC + EoT + 4*lonE) mod 1440 ;  H = TST/4 - 180
cosZ = sin(lat) sin(decl) + cos(lat) cos(decl) cos H
azimuth(0=N, clockwise) = atan2(sin H, cos H sin lat - tan decl cos lat) + 180
```

Refraction (NOAA), with e = true elevation in degrees. The value is in arcsec, divided by 3600, and optionally multiplied by (P/1010)(283/(273+T)):
- e > 85: 0
- e > 5: 58.1/tan e - 0.07/tan^3 e + 0.000086/tan^5 e
- e > -0.575: 1735 + e(-518.2 + e(103.4 + e(-12.79 + 0.711e)))
- else: -20.774/tan e

Refraction is 0.48 deg at the horizon, 0.16 deg at 5 deg and 0.044 deg at 20 deg. Use the **apparent** zenith (refraction-corrected) for the irradiance work, airmass, Perez and AOI. That is pvlib's convention.

Test results [LIVE, `test-sunpos.mjs`, `results-sunpos.json`]:

| Check | Result |
|---|---|
| NOAA calculator code (8 cases, run in node) | Identical to about 1e-12 deg. This confirms the transcription. |
| NREL SPA report example (2003-10-17 19:30:30 UTC, 39.742476, -105.1786, 820 hPa, 11 C; published zenith 50.11162, azimuth 194.34024) | dZen +0.0007 deg, dAz +0.0023 deg |
| vs pvlib `spa_python`, London 2023 hourly, daylight (n=4412) | True zenith: mean 0.0027, p99 0.0098, max 0.013 deg. Azimuth: max 0.017 deg. Apparent zenith (85-90 deg): max 0.011 deg. |
| vs pvlib SPA, 10k random times 1990-2050, abs(lat) up to 70 | True zenith: mean 0.0032, p99 0.0112, max 0.0175 deg |
| vs PVGIS `H_sun` | Mean abs 0.11 deg, max 0.29 deg. PVGIS's own algorithm is coarser; this explains a 1.5% beam difference on W90 (section 9). |

Alternatives: SPA (Reda & Andreas 2008) is accurate to ±0.0003 deg but much larger code. PSA+ (Blanco 2020) is about 0.008 deg. NOAA is enough here.

---
## 2. Extraterrestrial, airmass, transposition [SRC; implementation checked vs pvlib LIVE]

**Extraterrestrial irradiance** (Spencer, as pvlib):
- I0 = 1366.1 (1.00011 + 0.034221 cos B + 0.00128 sin B + 0.000719 cos 2B + 0.000077 sin 2B)
- B = 2π(doy - 1)/365

**Kasten & Young 1989 airmass**, with Z the apparent zenith in degrees:
- AM = 1 / [cos Z + 0.50572 (96.07995 - Z)^-1.6364]
- Not defined for Z ≥ 90. Use the relative airmass (not pressure-corrected) in Perez.

**AOI**: cos θ = cos Z cos β + sin Z sin β cos(γs - γ). It can be negative.

**Perez 1990** (pvlib `perez`, model 'allsitescomposite1990'), with Z in radians:
- ε = [(DHI + DNI)/DHI + κZ³] / (1 + κZ³), with κ = 1.041
- Δ = DHI · AM / I0
- Pick the bin by ε (table below)
- F1 = max(0, f11 + f12Δ + f13Z)
- F2 = f21 + f22Δ + f23Z
- a = max(0, cos θ), b = max(cos 85°, cos Z)
- Sky = max(0, DHI[(1 - F1)(1 + cos β)/2 + F1·a/b + F2·sin β])
- Components: isotropic = DHI(1 - F1)(1 + cos β)/2; circumsolar = DHI·F1·a/b; horizon = DHI·F2·sin β

| bin | ε range | f11 | f12 | f13 | f21 | f22 | f23 |
|---|---|---|---|---|---|---|---|
| 1 | < 1.065 | -0.008 | 0.588 | -0.062 | -0.060 | 0.072 | -0.022 |
| 2 | 1.065-1.230 | 0.130 | 0.683 | -0.151 | -0.019 | 0.066 | -0.029 |
| 3 | 1.230-1.500 | 0.330 | 0.487 | -0.221 | 0.055 | -0.064 | -0.026 |
| 4 | 1.500-1.950 | 0.568 | 0.187 | -0.295 | 0.109 | -0.152 | -0.014 |
| 5 | 1.950-2.800 | 0.873 | -0.392 | -0.362 | 0.226 | -0.462 | 0.001 |
| 6 | 2.800-4.500 | 1.132 | -1.237 | -0.412 | 0.288 | -0.823 | 0.056 |
| 7 | 4.500-6.200 | 1.060 | -1.600 | -0.359 | 0.264 | -1.127 | 0.131 |
| 8 | ≥ 6.2 | 0.678 | -0.327 | -0.250 | 0.156 | -1.377 | 0.251 |

The bin lower edge is inclusive (np.digitize). If Z ≥ 90 while DHI > 0 (twilight), pvlib returns 0. The reference instead falls back to isotropic, DHI(1 + cos β)/2. Perez has small jumps between bins; pvlib `perez_driesse` is a continuous alternative if that ever matters.

**Hay-Davies** (fallback):
- Ai = DNI/I0
- Rb = max(cos θ, 0) / max(cos Z, 0.01745)
- Sky = DHI[(1 - Ai)(1 + cos β)/2 + Ai·Rb]

**Muneer 1990** is what PVGIS uses, taken from GRASS r.sun `drad()`. Include it only for PVGIS-parity tests.
- fg = sin β - β cos β - π sin²(β/2); r_sky = (1 + cos β)/2
- If the plane is in shade (cos θ ≤ 0 or sun down): fx = r_sky + 0.252271·fg
- Otherwise, with Kb = BHI/(I0 sin h) and N = 0.00263 - 0.712Kb - 0.6883Kb²:
  - h ≥ 0.1 rad: fx = (N·fg + r_sky)(1 - Kb) + Kb·cos θ / sin h
  - h < 0.1 rad: replace the last term with Kb·sin β·cos(γs - γ)/(0.1 - 0.008h)
- Sky = DHI·fx

**Ground-reflected**: GHI·ρ·(1 - cos β)/2, ρ = 0.2 by default.
- pvlib albedo table: grass 0.20, fresh grass 0.26, urban 0.18, concrete 0.30, asphalt 0.12, snow 0.65.
- **PVGIS rule** (found from the data [LIVE]): when the sun is behind the plane, PVGIS reflects **DHI only**, i.e. ρ·DHI·(1 - cos β)/2. Over the hours where W90 sat in shade but the sky had beam, ΣGr = 25214 against 0.1·ΣDHI = 25204.
- This is physically right for a wall or railing panel, because the ground in front sits in the building's shadow. The reference exposes it as `groundSelfShade`. Expose it in the UI as "mounted on a building".

**Sun behind the plane and vertical surfaces**:
- Beam = DNI·max(cos θ, 0), so it is 0 when the sun is behind.
- Perez circumsolar uses a = max(0, cos θ), so it is 0 when the sun is behind.
- Isotropic and horizon-band terms remain.
- Ground term is unchanged unless `groundSelfShade` is on.
- Beam IAM is 0 for AOI ≥ 90.
- For β = 90: sky view 0.5, ground view 0.5, cos θ = sin Z cos(Δaz), and the horizon band F2·sin β is at full weight. The b ≥ cos 85° floor keeps the circumsolar term bounded at low sun.

**Implementation check vs pvlib** [LIVE, `test-poa.mjs`]: with identical inputs (pvlib's sun position, DNI, dni_extra, albedo 0.2), the largest hourly difference is **≤ 0.0001 W/m²** for isotropic, Hay-Davies and Perez on both S35 and W90.

---
## 3. Hourly averages to half-hours [LIVE experiments]

**Time conventions** (verified LIVE with `test-timing.mjs`). I fitted the clear-sky integration window to a year of data and looked at morning/afternoon symmetry:
- **Open-Meteo archive**: stamp T is the mean over (T - 1h, T], i.e. period-ending. Best offset 0 to +10 min; AM/PM ratio 1.04 at 0.
- **PVGIS seriescalc**: stamp `YYYYMMDD:HH10` behaves as **centred on HH:10**, meaning the window is roughly HH:10 ± 30 min. Best offset +30 to +40 min.
  - Treating PVGIS stamps as HH:00-HH:59 shifts the data 20 min late, which put E90 22% low against W90 in my first run.
  - `H_sun` in PVGIS is evaluated at HH:10.

**Methods compared**:
- (a) The hourly value used for both halves, with the sun at the hour midpoint.
- (a2) The hourly irradiance, with the sun at each half-hour midpoint.
- (b) Clear-sky index: for each hour, sample the Ineichen clear-sky GHI at n sub-samples per half-hour. Then:
  - kt = GHI_h / mean(cs over the hour)
  - GHI_s = kt·cs_s
  - DHI_s = kd·GHI_s, with kd = DHI_h/GHI_h held constant
  - DNI_s = (GHI_s - DHI_s)/cos Z_s
  - Any beam left on samples with Z > 89° is moved to diffuse.
  - If mean cs < 1 W/m², spread the hour uniformly as diffuse.
  - Energy is conserved exactly.

**Test setup** (`test-halfhour.mjs`): a 1-minute synthetic year for London 2023. It is Ineichen clear-sky times a clear-sky index taken from PVGIS hourly data, with kt and kd interpolated between hour centres. The truth is averaged into Open-Meteo-style hourly values and rebuilt. System: 1 kWp on an 800 W micro.

| System | Method | Annual bias | Half-hour nRMSE | 16-19 h bias | Sunrise/sunset half-hours |
|---|---|---|---|---|---|
| S35 | (a) hour-mid | +0.02% | 12.0% | -0.23% | ×12 too much |
| S35 | **(b) 3 sub-samples** | +0.14% | **7.5%** | +0.03% | +1.8% |
| W90 | (a) hour-mid | +1.55% | 20.0% | +2.10% | ×10 |
| W90 | (a2) | +2.44% | 31.0% | +3.27% | ×10 |
| W90 | (b) 1 sub-sample | +0.46% | 9.9% | +0.56% | -49% |
| W90 | **(b) 3 sub-samples** | +0.24% | **9.8%** | +0.21% | +13% |
| SW45 | (a) hour-mid / **(b) 3 sub-samples** | +0.36% / +0.13% | 13.2 / **7.9%** | +1.16 / +0.13% | |
| E90 | (a) hour-mid / **(b) 3 sub-samples** | +0.98% / +0.78% | 18.5 / **11.5%** | ~0 | |

**Recommendation**:
- Use (b) with **subSteps = 2-3**. Going to 6 sub-samples adds nothing.
- Use monthly Linke turbidity, or a constant 3.5. Only the shape of the clear-sky curve matters, so Haurwitz (1098·cosZ·exp(-0.059/cosZ)) also works.
- pvlib monthly Linke turbidity [LIVE]:
  - London: 3.38, 4.33, 3.95, 3.65, 4.60, 4.94, 4.41, 4.30, 3.86, 3.45, 3.11, 3.15
  - Manchester: 3.26, 3.54, 3.45, 3.65, 3.80, 4.10, 4.20, 4.10, 3.66, 3.50, 2.91, 2.70
- Sunrise and sunset are handled automatically: sub-samples with the sun below the horizon get cs = 0.
- Temperature and wind are instantaneous at the stamps, so interpolate them linearly.
- Run the AC chain, including clipping, per sub-sample, then average.
- `hourlyToHalfHourly(records, site, {periodMinutes: 60|30})` also takes native 30-min inputs, such as the Open-Meteo satellite feed another agent saved.

**If only GHI is available**:
- Use **Erbs** at hourly resolution (implemented; matches pvlib to 1e-6):
  - kt = GHI/(I0·max(cosZ, 0.065)), clipped to [0, 1]
  - DF = 1 - 0.09kt if kt ≤ 0.22
  - DF = 0.9511 - 0.1604kt + 4.388kt² - 16.638kt³ + 12.336kt⁴ if kt ≤ 0.8
  - DF = 0.165 otherwise
  - DNI = 0 if Z > 87
- DISC/DIRINT (pvlib) and Engerer2 (Bright & Engerer 2019, JRSE 11:033701, which has coefficients for 1 min to 1 day) are more accurate, but I did not retrieve the Engerer2 coefficients.
- Open-Meteo already supplies DHI (ERA5 split), so no decomposition is needed. Do not reuse its DNI; recompute it per sample.

---
## 4. Incidence-angle modifier (IAM) [SRC; values match pvlib LIVE]

- **ASHRAE**: IAM = max(0, 1 - b0(1/cos θ - 1)), b0 = 0.05. It reaches 0 at 87.3 deg and is harsh at high AOI.
  - For diffuse light use the Brandemuehl-Beckman effective angles: θ_sky = 59.7 - 0.1388β + 0.001497β², θ_gnd = 90 - 0.5788β + 0.002693β².
- **Martin & Ruiz (recommended)**: IAM = (1 - exp(-cos θ/a_r)) / (1 - exp(-1/a_r)), a_r = 0.16. GRASS r.sun and PVGIS use 0.155.
- **MR diffuse**: IAM = 1 - exp(-(c1 + c2·x)·x/a_r), with c1 = 4/(3π) = 0.4244 and c2 = 0.5a_r - 0.154 (IEC 61853-3).
  - Sky: x = sin β + (π - β - sin β)/(1 + cos β)
  - Ground: x = sin β + (β - sin β)/(1 - cos β)
  - Sky and ground values are equal at β = 90.
- In the reference, circumsolar light gets the beam IAM (as PVsyst does). PVGIS reports AOI loss l_aoi of -3.1% (S35), -4.1% (W90) and -7% (N35).

---
## 5. Cell temperature [SRC]

**Faiman**: Tc = Ta + G_poa/(U0 + U1·ws), using the front POA global irradiance.

| Preset | U0 | U1 | Source / note |
|---|---|---|---|
| Free-standing c-Si | 26.9 | 6.2 | PVGIS docs; calibrated on ERA5 10 m wind, so it matches Open-Meteo `wind_speed_10m` [SRC] |
| Building-integrated | 20.0 | 3.2 | PVGIS docs [SRC] |
| Faiman 2008 / pvlib default | 25.0 | 6.84 | Wind at module height [SRC] |
| Balcony railing, open back | ~24 | ~5 | [INF] |
| Flush on wall | ~21 | ~3.5 | [INF] |

Alternative, PVsyst: Tc = Ta + α(1 - η)G/(Uc + Uv·ws), α = 0.9, η ≈ 0.2. Uc = 29 free-standing, 20 semi-integrated, 15 insulated.

PVGIS's combined temperature and low-irradiance loss l_tg:
- London S35: -4.8% free / -7.8% building
- W90: -8.5% / -10.4%

Vertical panels see lower irradiance, so heat matters less for them and low-light performance matters more.

**Power temperature coefficient γ (Pmax)**:
- Mono PERC: -0.34 to -0.35 %/K
- TOPCon: -0.29 to -0.30 %/K. Jinko Tiger Neo is -0.29 %/K and NOCT 45 ± 2 °C (datasheet via search).
- HJT: -0.24 to -0.26 %/K
- Back-contact (HPBC/ABC): -0.26 to -0.29 %/K
- NMOT is typically 42-45 °C.

---
## 6. DC power, losses, inverter [SRC]

**PVWatts DC**: P = Geff/1000 · Pdc0 · (1 + γ(Tc - 25)).
- Optional Marion low-light correction with k = 0.2 × (relative efficiency drop at 200 W/m²):
  - Geff ≤ 200: err = k(1 - (1 - G/200)⁴)
  - Geff < 1000: err = k(1000 - G)/800
  - Geff ≥ 1000: err = 0 (cap)
  - P -= Pdc0·err
- Use k ≈ 0.005-0.01 for modern modules [INF from typical datasheet low-light figures of 2-5%].

**Huld 2011 c-Si** (PVGIS's model, docs "CSi current"):
- P = Pdc0·G'·[1 + k1 ln G' + k2 ln²G' + k3 T' + k4 T' ln G' + k5 T' ln²G' + k6 T'²]
- k = [-0.017237, -0.040465, -0.004702, 0.000149, 0.000170, 0.000005]
- G' = G/1000, T' = Tm - 25
- It means -7.7% relative efficiency at 200 W/m² and -0.47%/K, i.e. older c-Si. It understates vertical panels with modern cells by about 3-7% (waterfall below).

**DC losses**, multiplied together as Π(1 - Li). PVWatts defaults total 14.08%: soiling 2, shading 3, mismatch 2, wiring 2, connections 0.5, LID 1.5, nameplate 1, availability 3. For plug-in kits [INF]:

| Loss | Suggested value |
|---|---|
| Soiling | 2% tilted, 1% vertical |
| Mismatch | 0.5-1% (one module per MPPT) |
| DC + AC wiring | 1% |
| LID / LeTID | 0.5-1% TOPCon/HJT, 1.5-2% PERC |
| Nameplate | 0% (positive tolerance) |
| Availability | 1% |
| **Total** | **≈ 5.9%** |

**Degradation**:
- TOPCon: 1% in year 1, then 0.4%/yr (Tiger Neo datasheet: 0.40%/yr linear over 30 yr)
- PERC: about 2%, then 0.55%/yr
- HJT: about 1%, then 0.25-0.3%/yr
- `degradationFactor(n)` uses mid-year values.

**Inverter (PVWatts)**:
- η = (η_nom/η_ref)(-0.0162ζ - 0.0059/ζ + 0.9858)
- ζ = Pdc/Pdc0, Pdc0 = Pac0/η_nom, η_nom = 0.96, η_ref = 0.9637
- Pac = clamp(η·Pdc, 0, Pac0). This is the AC clipping.
- Note: at low load a smaller Pac0 gives higher efficiency in this model. In the 1 kWp test, the 800 W cap came out +0.4% (W90) and -0.3% (S35) against a 1 kW inverter.

**Micro-inverter specifics**:
- Hoymiles HMS-800W-2T (product page): 2 MPPT, 2 × 14 A input, 16-60 V MPPT range, 65 V max, 800 VA, 96.7% max efficiency, 99.8% MPPT efficiency.
- Model the per-MPPT limit as a DC cap: `inputMaxDc` ≈ Imax × Vmp ≈ 14 × 34 ≈ 476 W per input.
- Micro-inverter night draw is tens of mW. The common "< 50 mW" figure is from memory, not verified, and is negligible either way. A WiFi gateway or a battery's standby (several W) is not negligible. Model it as `standbyW`, a negative half-hour energy at night.
- UK: secondary sources say plug-in solar is legal from 27 Aug 2026 at ≤ 800 VA AC with G98 notification (SI 2026/848; BS 7671 Amendment 4). Default Pac0 = 800.

---
## 7. Bifacial

Offer a simple option [INF; implemented]: Geff += φ·(1 - rearShading)·POA_rear, where POA_rear is the same transposition with tilt 180 - β and azimuth + 180.
- φ: PERC 0.70, TOPCon 0.80, HJT 0.85-0.90.
- `rearShading` lumps together rear IAM, structure shading and the facade: about 0.1-0.2 for a free-standing fence, 0.6-0.8 for a railing in front of a wall [INF].

London 2023 examples on PVGIS inputs (`results-bifacial-shading.json`), per kWp:

| Configuration | kWh |
|---|---|
| W90 monofacial | 535 |
| W90 bifacial, φ 0.8, rearShading 0.1 (east-west fence) | 1040 |
| W90 bifacial, φ 0.8, rearShading 0.6 (balcony) | 758 |
| S90 monofacial | 777 |
| S90 bifacial, φ 0.8, rearShading 0.1 | 1024 |
| S35 monofacial (for comparison) | 1099 |

The fence result is consistent with the common claim that vertical east-west bifacial roughly matches optimally tilted monofacial. The rear-side heating effect is ignored. pvlib `bifacial.infinite_sheds` would be overkill here.

---
## 8. Horizon and shading [implemented and tested]

**Horizon profile**: elevations for equal azimuth bins starting at north, interpolated linearly.
- **Beam and circumsolar** are set to 0 when the sun's apparent elevation is below the horizon at the sun's azimuth.
- **Isotropic sky** is multiplied by `horizonFactors().iso`, a one-off numerical integral of cos(incidence)·dΩ over the visible sky. Analytic checks pass to 0.003:
  - Flat plane, uniform horizon h: 1 - sin²h
  - Vertical plane: 1 - (2h + sin 2h)/π, which is 0.78 at 10 deg and 0.57 at 20 deg
- **Perez horizon band** (0-6.5 deg) is multiplied by `.band`.
- There are also simple `beamShading` and `diffuseShading` fractions for railings and trees.

W90 examples (`results-bifacial-shading.json`):
- Uniform 10 deg horizon: -16%
- A 25 deg building between 240 and 300 deg: -31%

PVGIS has a DEM horizon (`usehorizon=1`, `printhorizon` endpoint), but it has no CORS. Let the user enter 8-36 sector elevations instead.

---
## 9. PVGIS fixtures and validation [LIVE]

**API facts**:
- `https://re.jrc.ec.europa.eu/api/v5_3/` works; v5_4, v6 and v6_0 return 404.
- **No `Access-Control-Allow-Origin` header**, and OPTIONS returns "OPTIONS Method Not Allowed", so it cannot be called from the browser.
- Database: PVGIS-SARAH3 radiation plus ERA5 meteo, 2005-2023.
- Aspect convention: 0 = S, 90 = W, -90 = E, 180 = N, so `surfaceAzimuth = aspect + 180`.

`pvgis-fixtures.json` (1.5 MB) contains:
- `pvcalc[loc].orientations[name].{free, building}`: E_y, E_m[12], H_i_y, H_i_m, l_aoi, l_spec, l_tg, l_total, url
- `optimal`
- `seriescalc.london_{flat,S35,W90}_2023`: 8760 rows of [time, P, Gb_i, Gd_i, Gr_i, H_sun, T2m, WS10m, Int], with usehorizon=0, pvcalculation=1, loss=14
- Raw responses are in `raw/`.

Annual E_y in kWh/kWp (loss 14, horizon on):

| Orientation | London free | London building | London H_i_y | Manchester free | Manchester building |
|---|---|---|---|---|---|
| S35 | 1018.8 | 987.5 | 1260.9 | 886.1 | 861.0 |
| S90 | 742.9 | 724.3 | 929.3 | 646.4 | 631.3 |
| W90 (aspect 90) | 498.7 | 488.3 | 649.5 | 444.0 | 435.3 |
| E90 | 520.2 | 508.5 | 669.0 | 458.3 | 448.9 |
| W35 | 787.3 | 767.6 | 996.9 | 701.7 | 685.5 |
| E35 | 817.0 | 795.5 | 1026.8 | 717.4 | 700.2 |
| SW45 | 936.7 | 909.1 | 1165.9 | 820.6 | 798.1 |
| flat | 845.0 | 824.1 | 1070.0 | 744.7 | 727.8 |
| N35 | 540.6 | 532.4 | 719.2 | 494.1 | 487.2 |
| Optimal | 1022.9 (40°, aspect -6) | | | 888.1 (39°, -4) | |

Monthly E_m for London (kWh/kWp, Jan-Dec):
- S35: 41/53/87/115/119/123/123/110/95/69/48/36
- W90: 13/21/41/58/66/68/68/60/47/29/17/11
- SW45: 36/47/79/105/112/115/115/103/87/62/43/32

l_spec is +1.6 to +2.2%, a spectral gain in the UK.

**POA vs PVGIS, London 2023** (horizontal components from the flat series, my sun position at HH:10, `results-poa.json`). Annual difference vs PVGIS POA, with hourly RMSE as % of mean in brackets:

| Model | S35 | W90 | W90 with groundSelfShade |
|---|---|---|---|
| Isotropic | -4.58% | +1.27% | |
| Hay-Davies | -1.08% (1.7%) | +2.15% | -1.49% |
| **Perez** | **+1.32% (3.1%)** | +4.23% (13.3%) | **+0.59% (8.2%)** |
| Muneer (PVGIS clone) | -0.04% (0.4%) | +2.75% | **-0.88% (2.2%)** |

Component checks:
- Beam only: S35 -0.04%; W90 -1.52%. The W90 gap is PVGIS's sun position: using PVGIS H_sun brings each sun-height bucket within 0.6%.
- Ground: the albedo PVGIS used comes out at 0.1995 on S35, which confirms 0.2.

**Full chain vs PVGIS hourly P** (`results-chain.json`). The PVGIS clone is Muneer + groundSelfShade + MR a_r 0.155 + Faiman 26.9/6.2 + Huld + 14% loss:

| Orientation | Annual | Hourly RMSE | Monthly range |
|---|---|---|---|
| S35 | 1012.1 vs 1007.0 kWh/kWp (+0.51%) | 1.2% of mean | -0.2 to +0.8% |
| W90 | 499.9 vs 503.1 (-0.63%) | 2.0% | -2.9 to -0.2% |

Adding PVGIS's l_spec makes the match worse (+2.5%), so the seriescalc P **appears to exclude the spectral correction** [INF].

**Waterfall, PVGIS clone to app chain** (London 2023, `results-chain-waterfall.json`, kWh/kWp):

| Step | S35 | W90 |
|---|---|---|
| PVGIS clone | 1012 | 500 |
| + Perez | 1031 | 508 |
| + full-GHI ground reflection | 1031 | 528 |
| + PVWatts TOPCon (γ -0.30, k 0.005) | 1060 | 563 |
| + 5.9% DC losses | 1160 | 616 |
| + 96% micro-inverter | 1104 | 576 |
| + 800 W cap | 1101 | 581 |

That ends at +9.3% (S35) and +15.4% (W90) vs PVGIS P. Most of the gap is the loss assumption, the low-light model and inverter efficiency, not the irradiance.

**Data source**: the same pipeline on Open-Meteo archive (ERA5) vs PVGIS (SARAH3) inputs, London 2023 (`results-openmeteo.json`):
- GHI: 1128.5 vs 1093.1 kWh/m²
- DHI: 488.7 vs 598.2 (diffuse fraction 43% vs 55%)
- AC yield difference: S35 +8.9%, W90 +9.7%, E90 +9.3%, S90 +12.1%, SW45 +9.7%, W35 +5.6%, flat +3.0%

Treat ERA5 yields as optimistic by about 5-12%. Options are a user calibration factor, or satellite data. Open-Meteo `satellite-api.open-meteo.com` sends `access-control-allow-origin: *` [LIVE]. My probe found `satellite_radiation_seamless` data only from about 2026; for earlier dates the default model returned the same values as ERA5.

**Orientation sweep against Agile peak** (`results-orientation-sweep.json`):
- System: 2 × 400 Wp on an 800 W micro, London 2023, Agile region C 2023 import prices (AGILE-FLEX-22-11-25, mean 21.08 p/kWh), all output self-consumed.

| Orientation | kWh (ERA5) | Value | p/kWh |
|---|---|---|---|
| S45 | 959 | £189 | 19.7 |
| SSW45 (az 210) | 923 | £188 | 20.4 |
| SW45 | 881 | £183 | 20.8 |
| W45 | 685 | £148 | 21.6 |
| W90 | 497 | £117 | 23.5 |

West-facing panels earn about 20% more per kWh but produce 30-48% fewer kWh. Peak-hour pricing alone does not justify a west orientation; south-south-west (az 200-215) gives most of the peak energy at no annual cost. 2025-26 prices should be re-run by the economics workstream.

---
## 10. Reference implementation `pv-reference.js` (ES module, about 560 lines, no dependencies)

Exports:
- **Sun and clear sky**: `sunPosition(date, lat, lon, {pressureHpa, tempC, refraction})` returns {zenith (apparent), zenithTrue, elevation, azimuth (0=N clockwise), declination, eqTime, hourAngle, earthSunDist}. Also `refractionNOAA`, `dayOfYear`, `extraterrestrial`, `airmassKastenYoung`, `alt2pres`, `clearSkyIneichen(zenith, doy, linke, altitude)`, `clearSkyHaurwitz`, `erbs`.
- **Transposition**: `cosAoi`, `PEREZ_1990`, `PEREZ_EPS_EDGES`, `perezSkyDiffuse`, `hayDaviesSkyDiffuse`, `muneerSkyDiffuse`, `groundReflected`, and `poaIrradiance({ghi, dni, dhi, zenith, azimuth, tilt, surfaceAzimuth, albedo, dayOfYear, model: 'perez'|'haydavies'|'isotropic'|'muneer', groundSelfShade})`, which returns {poaGlobal, poaBeam, poaSky, poaGround, circumsolar, isotropic, horizon, cosInc, aoi}.
- **IAM**: `iamAshrae`, `iamMartinRuiz`, `iamMartinRuizDiffuse`, `effAngleSky`, `effAngleGround`, `effectiveIrradiance`.
- **Temperature**: `cellTempFaiman`, `FAIMAN_PRESETS`.
- **DC, losses, inverter**: `dcPowerPvwatts(gEff, tCell, pdc0, gamma, k)`, `dcPowerHuld`, `HULD_CSI`, `lossFactor`, `degradationFactor`, `acPowerPvwatts(pdc, pac0, etaNom, etaRef)`, and `microInverter(pdcInputs[], {pacMax, etaNom, etaRef, inputMaxDc, standbyW})`, which returns {ac, dcUsed, dcClippedInput, acClipped}.
- **Bifacial and horizon**: `rearPoa`, `horizonElevation`, `horizonFactors`.
- **Pipeline**: `hourlyToHalfHourly(records, site, {subSteps, linke, method, periodMinutes})` and `simulateHalfHours(halfHours, system)`, which returns [{tStart, acWh, dcWh, clippedWh, poaWh}].

`dcWh` and `clippedWh` are there so a DC-coupled battery model can take the clipped DC energy.

**Tests** (all pass; run with `node <file>` from the research directory):

| File | What it checks |
|---|---|
| `test-units.mjs` | 177/177 spot checks vs pvlib: Ineichen, Haurwitz, MR/ASHRAE IAMs, PVWatts inverter, Kasten-Young, Erbs, analytic horizon, sun-behind-plane |
| `test-sunpos.mjs` | Section 1 |
| `test-poa.mjs` | Sections 2 and 9 |
| `test-chain.mjs` | Section 9 and the waterfall |
| `test-halfhour.mjs` | Section 3 |
| `test-timing.mjs` | Time conventions |
| `test-openmeteo.mjs` | Data-source comparison |
| `test-sweep.mjs` | Orientation sweep |
| `test-bifacial-shading.mjs` | Sections 7-8 |

`make-pv-summary.mjs` writes `results-pv-summary.json`. The pvlib reference values were generated by `pvlib_reference.py` (temporary venv with pvlib 0.16.1) into `pvlib-reference-values.json`.

---
## 11. Constants quick list

| Constant | Value |
|---|---|
| κ (Perez) | 1.041 |
| Solar constant | 1366.1 (pvlib Spencer) |
| Kasten-Young | 0.50572, 96.07995, -1.6364 |
| Hay-Davies cosZ floor | 0.01745 |
| Perez b floor | cos 85° = 0.08716 |
| Muneer | N = 0.00263 - 0.712Kb - 0.6883Kb²; shaded 0.252271 |
| Martin-Ruiz | a_r 0.16 (PVGIS 0.155); c1 0.4244; c2 = 0.5a_r - 0.154 |
| ASHRAE | b0 0.05 |
| Faiman | 26.9/6.2 free, 20/3.2 building, 25/6.84 IEC |
| PVWatts inverter | η_nom 0.96, η_ref 0.9637; -0.0162, -0.0059, 0.9858 |
| Albedo | 0.2 |
| DNI cut-off | Z > 89° (cos 0.0175); beam moved to diffuse |

=====
- {"claim": "The PVGIS API (re.jrc.ec.europa.eu/api/v5_3/) sends no Access-Control-Allow-Origin header and answers OPTIONS with 'OPTIONS Method Not Allowed', so it cannot be called from browser JS. v5_4, v6 and v6_0 return 404.", "source": "live curl", "verified_live": true, "confidence": "high"}
- {"claim": "The Open-Meteo archive API sends access-control-allow-origin: *. Its hourly radiation is the mean over the preceding hour (clear-sky fit: best offset 0 to +10 min, AM/PM ratio 1.04).", "source": "live curl + test-timing.mjs", "verified_live": true, "confidence": "high"}
- {"claim": "PVGIS seriescalc values stamped YYYYMMDD:HH10 behave as centred on HH:10 (best clear-sky fit offset +30 to +40 min). H_sun is evaluated at HH:10 and differs from NREL SPA by up to 0.29 deg.", "source": "test-timing.mjs, test-sunpos.mjs on live PVGIS data", "verified_live": true, "confidence": "high"}
- {"claim": "NOAA/Meeus sun position vs NREL SPA (pvlib), 1990-2050 with abs(lat) up to 70: true zenith error mean 0.0032 deg, p99 0.011 deg, max 0.0175 deg. On the NREL SPA report example: dZen +0.0007 deg, dAz +0.0023 deg.", "source": "test-sunpos.mjs vs pvlib 0.16.1 spa", "verified_live": true, "confidence": "high"}
- {"claim": "The JS Perez, Hay-Davies and isotropic transposition matches pvlib get_total_irradiance to within 1e-4 W/m2 for every hour of 2023 on S35 and W90.", "source": "test-poa.mjs", "verified_live": true, "confidence": "high"}
- {"claim": "PVGIS uses the Muneer 1990 diffuse model (GRASS r.sun drad: shaded N=0.252271; sunlit N=0.00263-0.712Kb-0.6883Kb^2), Martin-Ruiz angular loss with a_r=0.155 and albedo 0.2. The JS Muneer clone reproduces PVGIS S35 POA to -0.04% annually (hourly RMSE 0.4%).", "source": "https://raw.githubusercontent.com/OSGeo/grass/main/raster/r.sun/rsunlib.c + test-poa.mjs", "verified_live": true, "confidence": "high"}
- {"claim": "When the sun is behind the plane, PVGIS computes ground-reflected irradiance from diffuse only (albedo*DHI*(1-cos b)/2). For W90 London 2023 that cuts Gr by 22% compared with using GHI.", "source": "live PVGIS seriescalc data analysis (debug-w90.mjs)", "verified_live": true, "confidence": "high"}
- {"claim": "Perez POA vs PVGIS POA, London 2023: S35 +1.32% annual (hourly RMSE 3.1%). W90 +4.23%, or +0.59% with the PVGIS ground self-shade rule.", "source": "test-poa.mjs", "verified_live": true, "confidence": "high"}
- {"claim": "A PVGIS-clone chain (Muneer + MR 0.155 + Faiman 26.9/6.2 + Huld c-Si + 14% loss) matches PVGIS hourly P within +0.51% (S35) and -0.63% (W90) annually, with hourly RMSE 1.2-2.0% of mean. Adding PVGIS's spectral factor makes the match worse, suggesting seriescalc P excludes spectral effects.", "source": "test-chain.mjs", "verified_live": true, "confidence": "medium"}
- {"claim": "PVGIS PVcalc London (loss 14, free-standing) E_y kWh/kWp: S35 1018.8, S90 742.9, W90 498.7, E90 520.2, W35 787.3, E35 817.0, SW45 936.7, flat 845.0, N35 540.6, optimal 40deg/aspect -6 1022.9. Manchester S35 886.1, W90 444.0.", "source": "live PVGIS API v5_3 (pvgis-fixtures.json)", "verified_live": true, "confidence": "high"}
- {"claim": "PVGIS Faiman coefficients: c-Si free-standing U0=26.9, U1=6.2; building-integrated U0=20.0, U1=3.2. Huld c-Si 'current' coefficients k1..k6 = -0.017237, -0.040465, -0.004702, 0.000149, 0.000170, 0.000005.", "source": "https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis/getting-started-pvgis/pvgis-data-sources-calculation-methods_en", "verified_live": false, "confidence": "high"}
- {"claim": "Splitting hourly averages into half-hours with the clear-sky index and 3 sub-samples halves the half-hour nRMSE compared with copying the hourly value into both halves (S35 12.0% to 7.5%, W90 20% to 9.8%). It cuts the W90 annual bias from +1.55% to +0.24% and the 16-19h bias from +2.1% to +0.2%.", "source": "test-halfhour.mjs (1-min synthetic truth)", "verified_live": true, "confidence": "high"}
- {"claim": "Open-Meteo archive (ERA5) London 2023: GHI 1128.5 kWh/m2 and DHI 488.7, against PVGIS SARAH3 GHI 1093.1 and DHI 598.2. The same pipeline gives 5.6-12.1% more AC energy on tilted/vertical planes with ERA5 inputs (S35 +8.9%, W90 +9.7%).", "source": "test-openmeteo.mjs on live-fetched data", "verified_live": true, "confidence": "high"}
- {"claim": "For an 800 Wp/800 W kit in London valued at 2023 Agile C import prices (all self-consumed), the best orientations are S45 (GBP 189/yr) and SSW45 (GBP 188/yr, with 56% more 16-19h energy than S45). W90 is worth GBP 117/yr despite a 23.5 p/kWh average price.", "source": "test-sweep.mjs with live Octopus AGILE-FLEX-22-11-25 rates", "verified_live": true, "confidence": "medium"}
- {"claim": "The Perez 1990 allsitescomposite coefficient table and epsilon bin edges (1.065, 1.23, 1.5, 1.95, 2.8, 4.5, 6.2) are as listed in pvlib _get_perez_coefficients.", "source": "https://raw.githubusercontent.com/pvlib/pvlib-python/main/pvlib/irradiance.py", "verified_live": false, "confidence": "high"}
- {"claim": "Hoymiles HMS-800W-2T: 2 MPPT, 2x14 A max input current, MPPT 16-60 V, 800 VA output, 96.70% max efficiency, 99.80% MPPT efficiency.", "source": "https://www.wattuneed.com/en/inverters-converters/27196-hoymiles-hms-800w-2t-microinverter-0768563818981.html", "verified_live": false, "confidence": "medium"}
- {"claim": "Jinko Tiger Neo: Pmax temperature coefficient -0.29%/C, 0.40%/yr linear degradation over 30 years, NOCT 45+-2 C.", "source": "web search of Jinko datasheets (solarproof.com.au JKM405-420N-54HL4-B)", "verified_live": false, "confidence": "medium"}
- {"claim": "UK plug-in solar is legal from 27 Aug 2026 at <=800 VA AC with G98 notification (SI 2026/848; BS 7671 Amendment 4).", "source": "https://www.cityplumbing.co.uk/blog/plug-in-solar-uk-2026 (secondary)", "verified_live": false, "confidence": "medium"}
- {"claim": "The Open-Meteo satellite radiation API (satellite-api.open-meteo.com/v1/archive) sends access-control-allow-origin: *. models=satellite_radiation_seamless returned data for 2026 dates but nulls for 2023-2025. The default model returned the same values as ERA5 for 2023.", "source": "live curl / probe_sat.py", "verified_live": true, "confidence": "medium"}
- {"claim": "Vertical bifacial (phi 0.8, rear shading 0.1): W90 front + E rear gives 1040 kWh/kWp in London 2023, against 535 monofacial W90 and 1099 monofacial S35. A balcony case (rear shading 0.6) gives 758.", "source": "test-bifacial-shading.mjs (model; rear shading values inferred)", "verified_live": true, "confidence": "low"}

ARTIFACTS: ["/home/zack/.claude/jobs/52762e7f/tmp/research/pv-reference.js", "/home/zack/.claude/jobs/52762e7f/tmp/research/pvgis-fixtures.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/raw", "/home/zack/.claude/jobs/52762e7f/tmp/research/fetch_pvgis.py", "/home/zack/.claude/jobs/52762e7f/tmp/research/pvlib_reference.py", "/home/zack/.claude/jobs/52762e7f/tmp/research/pvlib-reference-values.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/openmeteo-london-2023.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/agile-2023-C.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/fetch_agile_2023.py", "/home/zack/.claude/jobs/52762e7f/tmp/research/noaa_main.js", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-units.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-sunpos.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-poa.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-chain.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-halfhour.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-timing.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-openmeteo.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-sweep.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/test-bifacial-shading.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/debug-w90.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/make-pv-summary.mjs", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-pv-summary.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-units.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-sunpos.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-poa.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-chain.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-chain-waterfall.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-halfhour.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-timing.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-openmeteo.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-orientation-sweep.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/results-bifacial-shading.json", "/home/zack/.claude/jobs/52762e7f/tmp/research/pvlib_src"]
OPEN: [
 "ERA5 (Open-Meteo archive) gives about 9-12% higher tilted and vertical yields than PVGIS SARAH3 for London 2023. Should the app apply a default calibration factor (e.g. -7%), let the user set one, or prefer satellite data when the period is covered (Open-Meteo satellite_radiation_seamless appears to cover only about 2026)? This needs checking against ground truth (another agent's verify-irradiance/ Camborne and KNMI files may answer it).",
 "Engerer2 hourly coefficients (Bright & Engerer 2019) were not retrieved. Erbs is implemented as the GHI-only fallback.",
 "The Faiman presets for balcony railings and flush walls, the bifacial rearShading guidance (0.1-0.2 fence, 0.6-0.8 balcony) and the Marion low-light k of 0.005-0.01 are engineering inferences, not measured values.",
 "Hoymiles and APsystems night-time consumption (<50 mW) and CEC-weighted efficiency could not be confirmed from a primary datasheet (the PDF URL returned NoSuchKey). Gateway and battery standby power should come from the kit research.",
 "The UK 800 VA plug-in limit and the 27 Aug 2026 legality date come from secondary sources and should be cross-checked by the regulation or kit workstream.",
 "PVGIS seriescalc hourly P appears to exclude the spectral correction (inferred from the clone match). This only matters if the app compares itself against PVGIS P.",
 "The orientation valuation used 2023 Agile prices and assumed every kWh is self-consumed. It should be redone with the user's real base load, 2025-26 Agile prices, export tariff options and the battery model, which may favour SW or W more."
]