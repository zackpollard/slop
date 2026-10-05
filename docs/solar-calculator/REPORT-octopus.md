The Octopus REST API works directly from a static browser app. I tested CORS live with curl and again in headless Chromium. Every endpoint returns `Access-Control-Allow-Origin: *`. The OPTIONS preflight for `Authorization` gets a 200 and lists `authorization` in Access-Control-Allow-Headers, and an authenticated `fetch()` from a page can read the 401 JSON body. Auth is HTTP Basic: `'Basic ' + btoa(apiKey + ':')`. Do not use `credentials:'include'`, because that fails against a `*` origin.

AGILE-24-10-01 is still the Agile import product on sale on 2026-10-05, and it covers the whole fixture window. Older versions (AGILE-22-07-22, 22-08-31, 23-12-06, 24-04-03) gave identical prices for every slot compared. The full year matched exactly (0 of 17,520 slots differ), so the version mostly doesn't matter from Oct 2024 on. The other codes are AGILE-OUTGOING-19-05-13 (Agile export), OUTGOING-VAR-24-10-26 (Outgoing Octopus: 15p, then 12p from 2026-03-01) and VAR-22-11-01 (Flexible Octopus).

There is a VAT change to handle. UK VAT on domestic electricity went from 5% to 0% on 1 Oct 2026 (00:00 BST = 2026-09-30T23:00Z) and is due to run until 31 Mar 2027. The API works out `value_inc_vat` using the VAT rate on the record's last day in force, or today for open-ended records. So long-lived records such as standing charges now show no VAT even for dates before October. The app should compute the VAT-inclusive price itself from `value_exc_vat` and a VAT schedule.

Page size limits: unit rates max 1,500 (silently capped), consumption max 25,000, products fixed at 100. Fetching a year takes 12 rate requests per tariff and 1 consumption request per meter. Unit rates always come newest-first and ignore `order_by`. All 14 region letters were checked live using city postcodes. There is also a public, no-auth endpoint `/v1/electricity-meter-points/{mpan}/` that returns the region (gsp).

The fixture `agile-C-12m.json` has 17,520 half-hour slots with no gaps. Mean 19.99p/kWh inc VAT. The 16:00–19:00 average is 34.83p against 17.87p for the rest of the day. 497 slots are negative, and the minimum is -11.28p.
=====
# Octopus Energy REST API: spec for the solar-calculator app (verified 2026-10-04/05)

Legend: **[LIVE]** = verified by curl or headless Chromium in this session · **[DOCS]** = official docs/OpenAPI · **[INFERRED]** = reasoning or community reports, not verified.

Primary sources:
- OpenAPI spec: `https://api.octopus.energy/v1/schema/?namespaces=default` (saved as `octopus-openapi-schema.yaml`)
- Endpoint guide: https://docs.octopus.energy/rest/guides/endpoints/
- API basics: https://docs.octopus.energy/rest/guides/api-basics/

---

## 1. CORS: direct browser calls work [LIVE]

curl with `Origin: https://solar-calculator.slop.zackpollard.pro`:

| Request | Result |
|---|---|
| `GET /v1/products/` and rate endpoints | 200, `access-control-allow-origin: *`, `vary: ... origin` |
| `OPTIONS /v1/accounts/A-12345678/` with `Access-Control-Request-Method: GET`, `Access-Control-Request-Headers: authorization` | **200**, `access-control-allow-origin: *`, `access-control-allow-headers: accept, authorization, content-type, user-agent, x-csrftoken, x-requested-with, X-Kraken-…`, `access-control-allow-methods: DELETE, GET, OPTIONS, PATCH, POST, PUT`, `access-control-max-age: 86400` |
| Same preflight on `/v1/electricity-meter-points/{mpan}/meters/{serial}/consumption/` | identical 200 |
| `GET /v1/accounts/…` with no auth | 401 `{"detail":"Authentication credentials were not provided."}` + `www-authenticate: Basic realm="api"` + ACAO `*` |
| `GET /v1/accounts/…` with a bad Basic key | 401 `{"detail":"Invalid API key."}` + ACAO `*` |
| `OPTIONS/POST /v1/graphql/` | also ACAO `*`, allows authorization and content-type |

**Real browser check [LIVE]:** a page at `http://127.0.0.1:8765` (`octopus-cors-test/index.html`) ran in headless Chromium. It fetched products, Agile rates, the GSP lookup and the meter-point endpoint (all 200, readable). It also sent account and consumption requests with `Authorization: Basic …` and a fake key. Both passed the preflight and returned a readable `401 {"detail":"Invalid API key."}`. There were no CORS errors.

Implementation notes:
- Use `fetch(url, { headers: { Authorization: 'Basic ' + btoa(key + ':') } })`. Leave `credentials` at the default or set `'omit'`. **`credentials:'include'` breaks**, because ACAO is `*`.
- No `Access-Control-Expose-Headers` is sent. JS can only read CORS-safelisted response headers, which is fine.
- Per the Fetch spec, cross-origin CORS requests never show the browser's Basic-auth dialog, even with `www-authenticate: Basic` [INFERRED from spec; consistent with the headless test].

## 2. Auth and the account endpoint

- **Auth [LIVE]:** HTTP Basic with the API key as username and an empty password. `curl -u "$KEY:"` sends `Authorization: Basic base64("sk_live_…:")`.
  - Only Basic is recognised: it returns "Invalid API key." for a bad key. `Token …`, `Bearer …` and `JWT …` headers return "Authentication credentials were not provided."
  - Keys look like `sk_live_…` (users get one from their Octopus dashboard, under personal details → API access) [INFERRED].
- **Account number format [LIVE]:** `^A-[0-9A-F]{8}$`. The URL router enforces it.
  - `A-ABCDEF12` → 401 JSON.
  - `a-12345678`, `A-1234`, `A-12345678X` → **404 with an HTML body (`text/html`)**. Upper-case and trim the input, and handle non-JSON error bodies.
- `GET /v1/accounts/` (list) → 401 without auth. It is only documented as a POST (create). The GraphQL `viewer { accounts { number } }` (after `obtainKrakenToken(input:{APIKey})`) could find the account number from just the key [DOCS/INFERRED; CORS for GraphQL verified, query not run].
- `GET /v1/accounts/{number}/` is **not in the OpenAPI spec**, but it exists: it returns 401 and `allow: GET, HEAD, OPTIONS`. Shape from the docs example [DOCS]:
```json
{ "number": "A-XXXXXXXX",
  "properties": [{
    "id": 1234567, "moved_in_at": "2020-11-30T00:00:00Z", "moved_out_at": null,
    "address_line_1": "…", "address_line_2": "", "address_line_3": "", "town": "LONDON", "county": "", "postcode": "W1 1AA",
    "electricity_meter_points": [{
      "mpan": "1000000000000", "profile_class": 1, "consumption_standard": 2560,
      "meters": [ {"serial_number": "1111111111", "registers": [{"identifier":"1","rate":"STANDARD","is_settlement_register":true}]},
                  {"serial_number": "2222222222", "registers": [...]} ],
      "agreements": [
        {"tariff_code":"E-1R-VAR-20-09-22-N","valid_from":"2020-12-17T00:00:00Z","valid_to":"2021-12-17T00:00:00Z"},
        {"tariff_code":"E-1R-VAR-21-09-29-N","valid_from":"2021-12-17T00:00:00Z","valid_to":"2023-04-01T00:00:00+01:00"},
        {"tariff_code":"E-1R-VAR-22-11-01-N","valid_from":"2023-04-01T00:00:00+01:00","valid_to":null}],
      "is_export": false }],
    "gas_meter_points": [{ "mprn": "…", "consumption_standard": 3448, "meters": [{"serial_number":"…"}], "agreements": [...] }]
  }]}
```
- Parsing rules:
  - Pick the property with `moved_out_at === null`; if there are several, take the latest `moved_in_at`.
  - The import MPAN is the one with `is_export:false`; the export MPAN has `is_export:true`. Export usually shares the import meter's serial [INFERRED].
  - Agreement `valid_from`/`valid_to` mix `Z` and `+01:00` offsets. `valid_to:null` means open-ended. Variable tariffs auto-extend; fixed ones roll onto variable [DOCS].
  - `meters[]` can include replaced meters and non-smart ones. Non-smart serials return an empty consumption list [DOCS].
- Illustrative fixture (fake IDs, clearly labelled): `octopus-account-example.illustrative.json`.

## 3. Consumption endpoint [DOCS; not run live, as no key was available]

`GET /v1/electricity-meter-points/{mpan}/meters/{serial}/consumption/` (Basic auth). Use `encodeURIComponent` on the serial; a raw space breaks the URL.

| Param | Meaning |
|---|---|
| `period_from` | inclusive datetime; can be used alone |
| `period_to` | exclusive; **requires `period_from`** (otherwise 400, verified on the rates endpoint: `{"period_from":["This field is required when providing a \`period_to\`."]}`) |
| `page_size` | default 100, **max 25000** ("a full year of half-hourly") |
| `order_by` | `period` (ascending) or `-period` (**default: newest first**) |
| `group_by` | `hour`, `day`, `week`, `month`, `quarter`; days use Europe/London local midnight |
| `page` | page number; follow the absolute `next` URL |

- **Response:** `{count, next, previous, results:[{consumption, interval_start, interval_end}]}`.
  - `consumption` is in **kWh** per half-hour, to 0.001 kWh. The OpenAPI types it as a string but the examples show numbers, so use `Number()`.
  - For an export MPAN, the same field holds exported kWh.
  - Octopus bills by rounding each half-hour to 0.01 kWh (round-half-even) before applying the price.
- **Timestamps:** consumption uses **local-offset ISO**: `Z` in GMT and `+01:00` in BST. One record even mixes them: `"interval_start":"2023-03-26T00:30:00Z","interval_end":"2023-03-26T02:00:00+01:00"`. Prices are always `Z`.
  - Older docs show `+0100` with no colon. V8 parses it, but Firefox and Safari may not, so normalise with `s.replace(/([+-]\d\d)(\d\d)$/,'$1:$2')`.
- **Boundary semantics:** consumption returns every record that *overlaps* `[from,to)`. With from=02:30Z and to=03:00Z it can return 2 records where the price endpoint returns 1 [DOCS]. Always dedupe by `interval_start`, converted to epoch ms.
- **Recommended request:** `?period_from=<ISO Z>&period_to=<ISO Z>&page_size=25000&order_by=period`. That is one request per meter per year, about 1.2 MB.
- **History depth [INFERRED]:** from when Octopus started supplying the half-hourly smart data. Probe with `?order_by=period&page_size=1` (no period) to get the earliest interval. Check `count` against the expected number of slots to find gaps.
- **Missing data [INFERRED/community]:**
  - Missing half-hours are simply absent; there are no null or zero placeholders.
  - SMETS2 data typically arrives the next day and can be ~48 h late. Some periods are back-filled later.
  - Do not trust the last 1–2 days.
- **Meter exchanges [INFERRED]:** fetch every serial on the MPAN and merge by slot. Never sum duplicates for the same slot. Process serials in order of their latest interval, ascending, so the active meter wins on any overlap.

## 4. Products and tariff codes

### Tariff code format [LIVE]
- `E-1R-{PRODUCT}-{REGION}`: single-register electricity.
- `E-2R-…`: Economy 7, with `/day-unit-rates/` and `/night-unit-rates/`.
- `G-1R-…`: gas.
- Parse with `/^E-(1R|2R)-(.+)-([A-P])$/`. The product is group 2, the region group 3.
- `GET /v1/products/{code}/` works for withdrawn products too (e.g. AGILE-FLEX-22-11-25 → 200).

### Product list
`/v1/products/?brand=OCTOPUS_ENERGY&is_variable=true` [LIVE, 15 results]. Notes:
- `page_size` is **ignored and fixed at 100**.
- `available_at=<ISO>` lists products on sale at that moment.
- `is_historical=true` lists withdrawn products only (6258 across all brands).
- Each item has a `direction` field: `IMPORT` or `EXPORT`.

### Agile import versions (Octopus brand)
`available_from`/`available_to` are the dates each version was on sale [LIVE]:

| Code | On sale | Latest rate published (region C) |
|---|---|---|
| AGILE-18-02-21 | 2017-01-01 → 2022-07-22 | still published; capped at 33.33p exc VAT (35p inc), so it differs at peaks |
| AGILE-22-07-22 | 2022-07-22 → 2022-08-29 | stops 2026-03-28T22:30Z |
| AGILE-22-08-31 | 2022-08-29 → 2022-10-06 | still published |
| AGILE-VAR-22-10-19 | 2022-10-19 → 2022-10-22 | – |
| AGILE-FLEX-22-11-25 | 2022-11-25 → 2023-12-11 | stops 2025-01-01T22:30Z |
| AGILE-23-12-06 | 2023-12-11 → 2024-04-03 | still published |
| AGILE-24-04-03 | 2024-04-03 → 2024-10-01 | still published |
| **AGILE-24-10-01** | **2024-10-01 → (on sale 2026-10-05, `available_to:null`)** | still published; full name "Agile Octopus October 2024 v1", term 12, cap 100p/kWh inc VAT |

- Bulb (BB) variants: AGILE-FLEX-BB-23-02-08, AGILE-BB-23-12-06, AGILE-BB-24-04-03 and AGILE-BB-24-10-01 stopped publishing on 2025-10-01.
- **Same prices across versions [LIVE]:**
  - AGILE-23-12-06 vs AGILE-24-10-01 for region C, 2025-09-30T23:00Z → 2026-09-30T23:00Z: **0 of 17,520 slots differ**.
  - 22-07-22, 22-08-31 and 24-04-03 were identical on sampled days in Oct 2024, Oct 2025 and Jan 2026.
  - So from Oct 2024 on, any of these versions gives the same half-hourly prices. Only AGILE-18-02-21 differs.
- **Current product rates start before the on-sale date [LIVE]:** AGILE-24-10-01 has rates from 2024-09-15T23:00Z. 35,998 rows to 2026-10-05T22:00Z, no gaps or duplicates, `payment_method:null` throughout.

### Export products and comparison products (region C) [LIVE]

| Purpose | Product | Tariff code | Rates |
|---|---|---|---|
| Agile export | AGILE-OUTGOING-19-05-13 | E-1R-AGILE-OUTGOING-19-05-13-C | half-hourly, no VAT; 12-month mean 11.17p, 16–19h mean 18.08p |
| Outgoing Octopus (flat) | OUTGOING-VAR-24-10-26 | E-1R-OUTGOING-VAR-24-10-26-C | 15.0p from 2024-10-25T23:00Z; **12.0p from 2026-03-01** |
| SEG | OUTGOING-SEG-FIX-12M-20-07-07 | …-C | 4.1p since 2022-02-01 |
| Prime Outgoing (new, 2026-06-23) | OUTGOING-PRIME-FIX-12M-26-06-23 | …-C | 16p for 16:00–19:00 local, 9p otherwise |
| Flexible Octopus (SVT comparison) | VAR-22-11-01 | E-1R-VAR-22-11-01-C | quarterly, DD + NON_DD rows (see §5) |
| 12M fixed (new) | OE-FIX-12M-26-10-02 | E-1R-OE-FIX-12M-26-10-02-C | 27.0519p, SC 41.3869p/day (0% VAT era) |

Other current import products: GO-VAR-22-10-14, COSY-22-12-08, FLUX-IMPORT-23-02-14 / FLUX-EXPORT-23-02-14, INTELLI-FLUX-IMPORT-23-07-14, SNUG-24-11-07.

To discover a newer Agile version at runtime, take products where `code` starts with `AGILE-`, `direction==='IMPORT'` and `brand==='OCTOPUS_ENERGY'`, then sort by `available_from` descending.

## 5. Unit rates and standing charges

`GET /v1/products/{P}/electricity-tariffs/{T}/standard-unit-rates/` and `…/standing-charges/` (no auth) [LIVE]:
- **Params:** `period_from` (inclusive), `period_to` (exclusive; needs `period_from`), `page_size` (**max 1500**: 1501, 2000 and 25000 all return 1500), `page`. Default page size 100.
- **Ordering:** always **newest first**. `order_by` is ignored on prices.
- **Overlap:** records overlapping `[from,to)` are returned. For example, 02:45–03:15 returns the 02:30 and 03:00 slots, and a quarterly flat rate starting months earlier is also returned.
- **Errors:**
  - from > to → 400 `{"period_from":["Must not be greater than \`period_to\`."]}`.
  - Bad date → 400 `{"period_from":["Enter a valid date/time."]}`.
  - **An unencoded `+01:00` in the query string also gives 400**, because `+` becomes a space. Use `toISOString()` (Z) or URLSearchParams.
  - Date-only or naive datetimes are read as **Europe/London local** (`period_from=2025-10-01` → 2025-09-30T23:00Z).
- **Record:** `{"value_exc_vat":13.97,"value_inc_vat":14.6685,"valid_from":"2025-10-01T00:00:00Z","valid_to":"2025-10-01T00:30:00Z","payment_method":null}`. Units are **p/kWh** (p/day for standing charges). Values are unrounded (inc = exc×1.05 exactly before Oct 2026).
- **Future, unpublished periods** → `{"count":0,"results":[]}`. At 00:44 BST on 5 Oct, rates reached 2026-10-05T22:00Z, i.e. the Agile day runs 23:00→23:00 local. Day-ahead prices are commonly published around 16:00 UK [INFERRED].
- **Response headers:** `cache-control: max-age=300`, `vary: Authorization, …`.
- **Request count:** 12 months = 17,520 slots = **12 requests** per tariff at page_size 1500 (measured: 12 requests, ~0.1–0.4 s each). 24 months = 24 requests.
- **DST [LIVE]:** the local day 2025-10-26 has 50 slots and 2026-03-29 has 46. Rates are always in UTC with no gaps.
- **Payment-method duplicates:** Agile and Outgoing use `payment_method:null`, so there are no duplicates. Flexible/fixed products return **two rows per period**, `DIRECT_DEBIT` and `NON_DIRECT_DEBIT`. Keep `DIRECT_DEBIT`, falling back to null; don't key on `valid_from` alone. In product detail, Flexible's tariff key is `"varying"` (it holds both methods), while Agile's is `"direct_debit_monthly"`.
- **Flexible Octopus C, DIRECT_DEBIT [LIVE]:**

  | Period | Unit rate exc / inc VAT (p/kWh) | Standing charge exc / inc (p/day) |
  |---|---|---|
  | 2025-09-30T23Z→2026-01-01 | 24.4112 / 25.63176 | 42.9498 / 45.09729 |
  | Jan–Mar 2026 | 25.7129 / 26.998545 | 43.6021 / 45.782205 |
  | Apr–Jun 2026 | 23.7107 / 24.896235 | 42.1768 / 44.28564 |
  | Jul–Sep 2026 | 25.0927 / 26.347335 | 39.5209 / 41.496945 |
  | from 2026-09-30T23Z | 26.5956 (no VAT) | 41.3869 (no VAT) |

- **Agile standing charge:**
  - One open record since 2024-09-30T23:00Z: region C **37.6525p/day exc VAT** (= 39.535125 inc 5%).
  - All regions, exc VAT: A 46.4649, B 52.2352, C 37.6525, D 62.7004, E 58.6296, F 66.7126, G 47.6032, H 59.2617, J 53.1292, K 59.1087, L 62.9201, M 63.1074, N 59.1606, P 57.0745.
  - Outgoing standing charge = 0.
- **The VAT change [LIVE + DOCS + news]:**
  - UK VAT on domestic **electricity** went 5% → **0% from 1 Oct 2026**. It is due to run until 31 Mar 2027; extension is "to be considered at the Autumn Budget". Announced 21 Jul 2026. Gas is not included.
  - Seen live: every half-hour from **2026-09-30T23:00:00Z** has `value_inc_vat == value_exc_vat`; 2026-09-30T22:30Z still has ×1.05. Flexible got new rows from 2026-09-30T23:00Z with inc == exc.
  - **Problem:** the OpenAPI `HistoricalCharge.value_inc_vat` description says it is grossed up "at the market reduced rate on the latest day this charge is in force that is not after today… Charges still in force use today."
  - So **open-ended or long records report today's 0% VAT for their whole span.** The Agile standing-charges endpoint shows 37.6525/37.6525 for 2024–2026, even though `/v1/products/AGILE-24-10-01/?tariffs_active_at=2026-01-15T00:00:00Z` correctly gives `standing_charge_inc_vat: 39.535125`.
  - **Fix:** compute `inc = exc × (1 + vat(t))` yourself with:
    ```js
    VAT = [
      { to: '2026-09-30T23:00Z', r: 0.05 },
      { to: '2027-03-31T23:00Z', r: 0 },
      { r: 0.05 }, // assumed revert; make it configurable
    ];
    ```
    For Agile half-hours this matches the API exactly (17,509 non-zero slots in the 12-month window have ratio 1.05; the 238 slots after the switch have 1.0). Export has no VAT.

## 6. Regions and GSP lookup [LIVE]

| Letter | Region | MPAN prefix (distributor ID) | Verified with |
|---|---|---|---|
| _A | Eastern England | 10 | NR1 1AA; MPAN 1013004420117 |
| _B | East Midlands | 11 | NG1 1AA |
| _C | London | 12 | SW1A 1AA; MPAN 1200023305967 |
| _D | Merseyside & North Wales | 13 | L1 1AA, SY23 1AA |
| _E | West Midlands | 14 | B1 1AA |
| _F | North East England | 15 | NE1 1AA |
| _G | North West England | 16 | M1 1AE |
| _H | Southern England | 20 | SO14 0AA; MPAN 2000024512368 |
| _J | South East England | 19 | BN1 1AA |
| _K | South Wales | 21 | CF10 1EP |
| _L | South West England | 22 | EX1 1AA |
| _M | Yorkshire | 23 | LS1 1AA |
| _N | South Scotland | 18 | EH1 1YZ |
| _P | North Scotland | 17 | IV1 1AA |

There is no _I or _O. MPAN prefixes 13–19 and 21–23 come from the standard distributor-ID mapping [INFERRED]; 10, 12 and 20 were confirmed live.

Lookups:
- `GET /v1/industry/grid-supply-points/?postcode=SW1A%201AA` → `{"count":1,"next":null,"previous":null,"results":[{"group_id":"_C"}]}`.
  - No auth needed. Accepts no-space, lower-case and outward-only (`SW1A`) postcodes.
  - An invalid postcode returns `count:0`. With no postcode it lists all 14 regions.
  - If `count>1`, ask the user to choose.
- **Public meter-point lookup (no auth):** `GET /v1/electricity-meter-points/{mpan}/` → `{"gsp":"_C","mpan":"1200023305967","profile_class":1}`, or 404 `{"detail":"Not found."}`. CORS `*`.

Region order of preference: the agreement tariff-code suffix, then the MPAN lookup, then the postcode lookup.

## 7. Rate limits and other gotchas

**Rate limits:**
- **No REST rate limit is documented**, and no rate-limit headers were seen.
- About 200 requests in roughly 10 minutes from one IP (including 24 back-to-back pages of 1500) got no 429s.
- A Home Assistant integration's FAQ cites "100 calls per hour, shared", but that relates to Kraken/GraphQL and Home Mini telemetry [INFERRED].
- Etiquette:
  - Make requests one at a time, not in parallel bursts.
  - Cache rate history (immutable once published) in IndexedDB, keyed by tariff and month.
  - Re-fetch only the last 2 days of consumption.
  - On 429 or 5xx, back off exponentially and honour `Retry-After` if it is readable.

**Gotchas:**
- Consumption defaults to newest-first (add `order_by=period`). Rates are always newest-first; sort them yourself.
- Page-size caps differ: rates 1500, consumption 25000, products 100 (fixed).
- Error bodies are JSON `{"detail":…}` (401) or field-error objects (400). A badly formatted account number gives an **HTML** 404.
- Time handling:
  - Use epoch-ms or 30-minute slot keys (`Math.floor(ms/1800000)`) internally.
  - Convert to Europe/London only for display and peak-window logic (16:00–19:00 local).
  - Local days can have 46, 48 or 50 slots.
- Product-detail price fields (`standard_unit_rate_inc_vat`) are a single snapshot at `tariffs_active_at`. Use the rate endpoints for history.

## 8. Using the actual tariff history (agreements)

Algorithm for a window `[W0, W1)` (inferred design based on the verified API behaviour):
1. Load the account and pick the import MPAN.
2. Sort `agreements` by `valid_from`. Clip each to the window (`valid_to:null` → W1).
3. Parse the tariff code to get product and region. For each clipped segment:
   - **Agile product** → fetch `standard-unit-rates` for that product and segment. These are half-hourly records.
   - **Flat/variable/fixed or ToU product (VAR, OE-FIX, GO, COSY, FLUX…)** → fetch `standard-unit-rates` for the segment. Filter `payment_method in (null,'DIRECT_DEBIT')`, adding a toggle for non-DD. Expand interval records (`valid_from ≤ t < valid_to ?? ∞`) onto the half-hour grid with a two-pointer sweep over the ascending list. GO, COSY and similar return alternating time-band records, and the same expansion handles them.
   - **E-2R** → day-unit-rates and night-unit-rates; mapping registers to times needs the meter's E7 hours, so treat it as approximate.
   - Fetch `standing-charges` per segment the same way.
4. Fill gaps: if a withdrawn Agile product stops publishing inside its segment, fill the gap from the current Agile product for the same region. Examples: AGILE-FLEX-22-11-25 stops 2025-01-01; AGILE-22-07-22 stops 2026-03-28. This is safe from Oct 2024 on, where prices are identical; flag anything earlier.
5. Apply VAT yourself (§5).
6. For "what if" comparisons, run the same consumption against:
   - Agile (current product for the region)
   - Flexible VAR-22-11-01
   - export options: Agile Outgoing, Outgoing fixed, SEG, Prime

   Export only counts if the user has an export MPAN or agreement. Plug-in kits usually have none, so default to 0p, with an option for SEG or Outgoing.

## 9. Minimal fetch layer (reference)
```js
const API='https://api.octopus.energy/v1';
const auth=k=>({Authorization:'Basic '+btoa(k.trim()+':')});
async function getJSON(url,key){
  const r=await fetch(url,{headers:key?auth(key):{}});            // no credentials:'include'
  const isJson=(r.headers.get('content-type')||'').includes('json');
  const body=isJson?await r.json():await r.text();
  if(!r.ok) throw Object.assign(new Error(body?.detail||`HTTP ${r.status}`),{status:r.status,body});
  return body;
}
async function getAll(url,key){const out=[];while(url){const d=await getJSON(url,key);out.push(...d.results);url=d.next;}return out;}
const q=o=>new URLSearchParams(o).toString();                         // encodes '+' safely
// rates:   getAll(`${API}/products/${p}/electricity-tariffs/${t}/standard-unit-rates/?${q({period_from:a.toISOString(),period_to:b.toISOString(),page_size:1500})}`)
// usage:   getAll(`${API}/electricity-meter-points/${mpan}/meters/${encodeURIComponent(sn)}/consumption/?${q({period_from,period_to,page_size:25000,order_by:'period'})}`, key)
const ms=s=>Date.parse(s.replace(/([+-]\d\d)(\d\d)$/,'$1:$2'));
```

## 10. Fixtures and data produced (in `research/`)

**`agile-C-12m.json`** (main demo fixture):
- Format: `[[iso_utc_valid_from, p_inc_vat], …]`.
- Window: 2025-09-30T23:00Z → 2026-09-30T23:00Z (UK local 1 Oct 2025 → 1 Oct 2026).
- 17,520 slots, sorted, deduped, 0 gaps.
- Covered entirely by **AGILE-24-10-01 / E-1R-AGILE-24-10-01-C**. All at 5% VAT.
- Metadata in `agile-C-12m.meta.json`.
- **Stats** (`agile-C-12m-stats.json`):
  - mean 19.99p, median 18.54p, min -11.277p, max 86.73p
  - 497 negative slots
  - **16:00–19:00 local mean 34.83p vs 17.87p for the rest of the day**
- **Monthly band means** (p/kWh inc VAT):

  | Month | 16–19h | 10–16h |
  |---|---|---|
  | Oct 25 | 33.8 | 14.4 |
  | Jan 26 | 37.3 | 21.0 |
  | Apr 26 | 27.9 | 8.1 |
  | Jun 26 | 32.5 | 11.9 |
  | Aug 26 | 38.8 | 17.7 |
  | Sep 26 | 44.4 | 15.4 |

  Weekday 16–19h mean 35.85p, weekend 32.27p.

Other files:
- `agile-outgoing-C-12m.json`: same window and format, AGILE-OUTGOING-19-05-13 (no VAT).
- `octopus-agile-sample.json`: raw API response for UK local 1–3 Oct 2025 (`period_from=2025-10-01T00:00:00%2B01:00`, `period_to=2025-10-04T00:00:00%2B01:00`); 144 rows, newest first.
- Raw dumps:
  - `agile-C-12m-raw.json`
  - `agile-outgoing-C-12m-raw.json`
  - `agile-24-10-01-C-all-raw.json` (full product history, 35,998 rows)
- `octopus-C-comparison-tariffs.json`: Flexible unit/standing, Agile standing, Outgoing fixed/SEG/Prime for region C.
- Product lists:
  - `products-variable.json`
  - `products-all-current.json`
  - `product-AGILE-24-10-01.json`
  - `octopus-products-historical-agile-var-outgoing.json`
- Docs:
  - `octopus-openapi-schema.yaml`
  - `octopus-docs/guides-endpoints.txt`
  - `octopus-docs/api-basics.txt`
- Examples:
  - `octopus-account-example.illustrative.json` (fake data, labelled)
  - `octopus-consumption-example.docs.json` (verbatim docs example)
- CORS test page: `octopus-cors-test/index.html`.
- Scripts:
  - `fetch_rates.py`
  - `build_fixture.py`
  - `analyze_rates.py`
  - `compare_versions.py`
  - `fetch_comparison.py`
  - `historical_products.py`
  - `peak_stats.py`

Sources:
- [Octopus REST endpoints guide](https://docs.octopus.energy/rest/guides/endpoints/)
- [Octopus API basics](https://docs.octopus.energy/rest/guides/api-basics/)
- [OpenAPI schema](https://api.octopus.energy/v1/schema/?namespaces=default)
- [British Gas: VAT cut on electricity](https://www.britishgas.co.uk/the-source/news/uk-vat-cut-on-electricity-bills.html)
- [NEA: government cuts VAT on electricity bills](https://www.nea.org.uk/news-insights/government-cuts-vat-on-electricity-bills/)
- [vatcalc](https://www.vatcalc.com/?p=51788)
- [BottlecapDave HA Octopus FAQ](https://bottlecapdave.github.io/HomeAssistant-OctopusEnergy/faq/)
=====
- {'claim': 'api.octopus.energy returns Access-Control-Allow-Origin: * on public and authenticated endpoints. OPTIONS preflight with Access-Control-Request-Headers: authorization returns 200 with authorization in Access-Control-Allow-Headers (max-age 86400). A real Chromium page could read the 401 JSON from authenticated fetches.', 'source': 'live curl + headless chromium', 'verified_live': True, 'confidence': 'high'}
- {'claim': "Auth is HTTP Basic with the API key as username and an empty password (Authorization: Basic base64('sk_live_...:')). 'Token', 'Bearer' and 'JWT' schemes give 'Authentication credentials were not provided.'", 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Account numbers must match ^A-[0-9A-F]{8}$. Malformed numbers return an HTML 404 rather than JSON. Unauthenticated requests return 401 {"detail":"Authentication credentials were not provided."}; a bad key returns 401 {"detail":"Invalid API key."}', 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'AGILE-24-10-01 (E-1R-AGILE-24-10-01-{A..P}) is still the Agile import product on sale on 2026-10-05 (available_to null). Its rates start 2024-09-15T23:00Z with no gaps.', 'source': 'https://api.octopus.energy/v1/products/?available_at=...', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Agile versions 22-07-22, 22-08-31, 23-12-06, 24-04-03 and 24-10-01 publish identical half-hourly prices from Oct 2024 onward. AGILE-23-12-06 vs AGILE-24-10-01 differ in 0 of 17,520 region C slots for Oct 2025 to Sep 2026. Only AGILE-18-02-21 differs, because of its 35p inc-VAT cap.', 'source': 'live curl comparison', 'verified_live': True, 'confidence': 'high'}
- {'claim': "UK VAT on domestic electricity is 0% from 2026-09-30T23:00Z (1 Oct 2026 BST), due to run to 31 Mar 2027. The API's value_inc_vat uses the VAT rate on the record's last day in force (today for open records), so open-ended standing charges show no VAT for 2024-2026. Compute inc VAT from value_exc_vat with a VAT schedule.", 'source': 'live curl + OpenAPI HistoricalCharge description + britishgas.co.uk/nea.org.uk/vatcalc.com', 'verified_live': True, 'confidence': 'high'}
- {'claim': "Unit rate/standing charge endpoints: page_size max 1500 (silently capped), default 100, always newest-first (order_by ignored), returns records overlapping [period_from, period_to). period_to without period_from gives 400. An unencoded '+' offset gives 400. Date-only or naive times are read as Europe/London. 12 months = 12 requests.", 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Consumption endpoint: page_size max 25000, default newest-first (order_by=period for ascending), group_by hour/day/week/month/quarter. Values are kWh per half-hour. interval_start/end use Z in GMT and +01:00 in BST. Records overlapping the period are returned. Non-smart meters return an empty list.', 'source': 'OpenAPI schema + https://docs.octopus.energy/rest/guides/endpoints/', 'verified_live': False, 'confidence': 'high'}
- {'claim': 'Account response shape: properties[].{postcode, moved_in_at, moved_out_at, electricity_meter_points[].{mpan, profile_class, consumption_standard, meters[].{serial_number, registers[]}, agreements[].{tariff_code, valid_from, valid_to}, is_export}}', 'source': 'https://docs.octopus.energy/rest/guides/endpoints/', 'verified_live': False, 'confidence': 'medium'}
- {'claim': 'GET /v1/industry/grid-supply-points/?postcode=SW1A%201AA returns {"count":1,...,"results":[{"group_id":"_C"}]} without auth. All 14 regions A-P were verified with city postcodes. GET /v1/electricity-meter-points/{mpan}/ is public and returns {gsp, mpan, profile_class}.', 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Region C Agile Oct 2025 to Sep 2026: mean 19.99p/kWh inc VAT, 16:00-19:00 local mean 34.83p vs 17.87p for the rest of the day, 497 negative slots, min -11.277p, max 86.73p. The Agile region C standing charge is 37.6525p/day exc VAT (39.535125 inc 5%).', 'source': 'live curl, computed', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'Export/comparison codes for region C: AGILE-OUTGOING-19-05-13 (half-hourly, no VAT), OUTGOING-VAR-24-10-26 (15p, then 12p from 2026-03-01), OUTGOING-SEG-FIX-12M-20-07-07 (4.1p), OUTGOING-PRIME-FIX-12M-26-06-23 (16p 4-7pm, 9p otherwise), VAR-22-11-01 Flexible (quarterly, with DIRECT_DEBIT and NON_DIRECT_DEBIT duplicate rows)', 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
- {'claim': 'No REST rate limit is documented and none was hit: about 200 requests in roughly 10 minutes, no 429s and no rate-limit headers. Rate responses carry cache-control max-age=300.', 'source': 'live curl', 'verified_live': True, 'confidence': 'medium'}
- {'claim': 'Local-day slot counts on the price endpoint: 50 on 2025-10-26 and 46 on 2026-03-29', 'source': 'live curl', 'verified_live': True, 'confidence': 'high'}
['research/agile-C-12m.json', 'research/agile-C-12m.meta.json', 'research/agile-C-12m-stats.json', 'research/agile-C-12m-raw.json', 'research/agile-outgoing-C-12m.json', 'research/agile-outgoing-C-12m-raw.json', 'research/octopus-agile-sample.json', 'research/agile-24-10-01-C-all-raw.json', 'research/octopus-C-comparison-tariffs.json', 'research/octopus-products-historical-agile-var-outgoing.json', 'research/products-variable.json', 'research/products-all-current.json', 'research/product-AGILE-24-10-01.json', 'research/octopus-openapi-schema.yaml', 'research/octopus-docs/guides-endpoints.txt', 'research/octopus-docs/api-basics.txt', 'research/octopus-account-example.illustrative.json', 'research/octopus-consumption-example.docs.json', 'research/octopus-cors-test/index.html', 'research/fetch_rates.py', 'research/build_fixture.py', 'research/analyze_rates.py', 'research/compare_versions.py', 'research/fetch_comparison.py', 'research/historical_products.py', 'research/peak_stats.py']
["The account endpoint's real response couldn't be verified (no API key). The shape comes from the official docs example; newer fields may exist, so parse defensively.", "Consumption behaviour couldn't be checked live: how gaps appear (assumed to be absent rows), whether old and new meter serials on one MPAN return duplicate data, and how far back history goes. All need checking with a real key.", 'Will 0% VAT on domestic electricity revert to 5% on 1 Apr 2027 or be extended? Make the VAT schedule configurable.', "REST rate limits are undocumented. The Home Assistant community figure of '100 calls/hour shared' probably applies to GraphQL/Kraken, not REST. Implement backoff on 429 regardless.", 'Exact daily publish time for next-day Agile prices (commonly about 16:00 UK) was not verified, as only one snapshot was observed.', 'Using GraphQL viewer{accounts{number}} to find the account number from just the API key is plausible (the endpoint is CORS-open), but the query was not run.']
