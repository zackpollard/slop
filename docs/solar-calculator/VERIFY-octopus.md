CORRECTIONS
- {"claim": "Account numbers must match ^A-[0-9A-F]{8}$ (the URL router enforces it)", "problem": "Wrong. The router accepts upper-case alphanumerics, not only hex. A client that validates with the hex regex would wrongly reject real account numbers that contain G-Z.", "corrected": "Use ^A-[0-9A-Z]{8}$ after trimming and upper-casing the input. Lower-case input, wrong length or other characters give an HTML 404 (text/html).", "evidence": "Live (verify-octopus/v1.py, v2.py). These return 401 JSON, so they matched the route: A-GHIJKLMN, A-ZZZZZZZZ, A-0000000Z, A-ABCDEF12. These return 404 text/html: a-12345678, A-abcdef12, A-1234567a, A-1234567-, A-1234567_, A-123456789, A-12345, B-12345678."}
- {"claim": "Agile versions 22-07-22, 22-08-31, 23-12-06, 24-04-03 and 24-10-01 publish identical half-hourly prices from Oct 2024 on. Only AGILE-18-02-21 differs. (The fixture meta's cross_check says 22-07-22, 22-08-31 and 24-04-03 'matched on every sampled day'.)", "problem": "False over the full year. Each version has its own price cap, and the caps bind exactly at the 16:00-19:00 peak this app cares about. Day sampling missed it.", "corrected": "Region C, 2025-09-30T23Z to 2026-09-30T23Z, compared on value_exc_vat:\n- 23-12-06 and 24-04-03 are identical to 24-10-01 (0 of 17,520 differ). All three cap at 100p inc VAT (95.23p exc).\n- 22-08-31 differs in 3 slots, e.g. 2026-09-22T16:30Z. Its cap is 78p inc VAT (74.28p exc).\n- 22-07-22 differs in 11 of the 8,592 slots it publishes before stopping at 2026-03-28T22:30Z. Its cap is 55p inc VAT (52.38p exc).\n- 18-02-21 differs in 1,112 slots. Its cap is 35p inc VAT (33.33p exc).\n\nAlways price with the customer's actual agreement tariff code. Only substitute AGILE-24-10-01 when the customer's version is one of the 100p-cap versions.", "evidence": "Live full-year pulls of every version (verify-octopus/v4.py). Caps are quoted from each product's description ('The unit rate is capped at 55p/kWh (including VAT)', 78p, 100p) and match the observed maxima: 54.999, 77.994 and 99.9915 inc VAT (verify-octopus/v5.py). Corrected meta: /home/zack/.claude/jobs/52762e7f/tmp/research/agile-C-12m.meta-verified.json."}
- {"claim": "The Agile version mostly doesn't matter from Oct 2024 on. The Agile region C standing charge is 37.6525p/day exc VAT.", "problem": "37.6525 is right only for AGILE-24-10-01. Every Agile version has its own standing charge, and the gap is up to about 7p/day, or about \u00a327/yr.", "corrected": "Region C standing charges, exc VAT, in p/day:\n- AGILE-18-02-21: 20.0\n- AGILE-22-07-22: 30.36 (ends 2026-03-31T23:00Z)\n- AGILE-22-08-31: 30.36\n- AGILE-FLEX-22-11-25: 30.01 (ended 2025-01-01)\n- AGILE-23-12-06: 34.79\n- AGILE-24-04-03: 36.88\n- AGILE-24-10-01: 37.6525\n- AGILE-BB-24-10-01: 37.6525 (ended 2025-09-30T23Z)\n\nFetch standing-charges for the customer's own tariff code. Never assume the current product's value.", "evidence": "Live standing-charges endpoint for each version (verify-octopus/v4.py). Summary file: /home/zack/.claude/jobs/52762e7f/tmp/research/agile-versions-C-verified.json."}
- {"claim": "Each product item has a direction field: IMPORT or EXPORT", "problem": "This only holds on the /v1/products/ list. The product-detail endpoint returned direction: null (seen for OUTGOING-PRIME-FIX-12M-26-06-23).", "corrected": "Read direction from the list endpoint (/v1/products/ or ?available_at=...). Do not rely on it from /v1/products/{code}/. Fall back to the code (contains OUTGOING or EXPORT means export).", "evidence": "Live: the list shows OUTGOING-PRIME-FIX-12M-26-06-23 as EXPORT, but GET /v1/products/OUTGOING-PRIME-FIX-12M-26-06-23/ gave direction None (verify-octopus/v3.py, v8.py)."}
- {"claim": "MPAN prefix (distributor ID) to region mapping table: 10=A ... 23=M", "problem": "The mapping is correct for the 14 DNO IDs. But MPANs on IDNO networks (independent networks, common on new-build estates) start with other distributor IDs (e.g. 24-37), which don't map to a region. A prefix-only lookup would fail or misassign those.", "corrected": "Never derive the region from the MPAN prefix. Use this order: the agreement tariff-code suffix, then GET /v1/electricity-meter-points/{mpan}/ (public, returns gsp), then the postcode lookup. Treat the prefix table as display-only.", "evidence": "Inferred from UK MPAN structure (IDNO distributor IDs). The meter-point endpoint was confirmed live to return gsp directly: 1200023305967 gives _C, 1013004420117 gives _A, 2000024512368 gives _H, and an unknown MPAN gives 404 {\"detail\":\"Not found.\"}, all with ACAO *."}

CONFIRMED
- CORS (curl with an Origin header). Every endpoint returns access-control-allow-origin: *. OPTIONS preflight on /v1/accounts/A-12345678/ and /consumption/ with Access-Control-Request-Headers: authorization returns 200, lists authorization in allow-headers, sets max-age 86400, and allows DELETE, GET, OPTIONS, PATCH, POST, PUT. /v1/graphql/ preflight also returns 200 with ACAO *.
- Real browser (my own page in headless Chromium at http://127.0.0.1:8799). Basic-auth fetch with default credentials and with credentials:'omit' both read a 401 {"detail":"Invalid API key."}. credentials:'include' fails with TypeError 'Failed to fetch'. The malformed-account HTML 404 is readable. GraphQL POST is readable. URLSearchParams-encoded +01:00 works. Date.parse handles both '+0100' and 'HH:mmZ' in Chromium.
- Auth (live). Basic base64('key:') gives 'Invalid API key.' for a bad key. Token, Bearer and JWT schemes give 'Authentication credentials were not provided.' No auth gives 401 with www-authenticate: Basic realm="api".
- Rate paging (live). Default page is 100. page_size 1500, 1501, 2000 and 25000 all return 1500 rows. Results are always newest-first: order_by=period, -period and valid_from are all ignored. A year needs 12 requests. The next URL is absolute and keeps the query params.
- Rate query rules (live):
- period_to without period_from gives 400 'This field is required when providing a `period_to`.'
- from > to gives 400.
- An unencoded + offset gives 400 'Enter a valid date/time.'; %2B works.
- Date-only or naive times are read as Europe/London.
- 02:45Z to 03:15Z returns the 02:30 and 03:00 slots, so overlapping records are returned. This contradicts the docs' 'exact period' wording, and the report has it right.
- Future periods return count 0.
- AGILE-24-10-01 is the only Agile IMPORT product in /v1/products/?available_at=2026-10-05 (available_to null, full_name 'Agile Octopus October 2024 v1', term 12, description says cap 100p inc VAT). Its product key is direct_debit_monthly; VAR-22-11-01's key is 'varying'. The product list ignores page_size (page_size=5 returned 42). is_historical=true gives 6258 products. brand=OCTOPUS_ENERGY&is_variable=true gives 15.
- AGILE-24-10-01 region C has 35,998 rows with the latest valid_from 2026-10-05T21:30Z (valid_to 22:00Z, i.e. 23:00 BST). That count matches a gap-free series from 2024-09-15T23:00Z.
- VAT switch (live). Agile C 2026-09-30T22:30Z has inc/exc ratio 1.05. From 2026-09-30T23:00Z inc == exc. The open-ended Agile standing charge shows 37.6525/37.6525 for a Jan 2026 window, while ?tariffs_active_at=2026-01-15 gives standing_charge_inc_vat 39.535125. The OpenAPI HistoricalCharge.value_inc_vat description is quoted correctly (schema lines 2362-2371).
- VAT policy (primary source). gov.uk Revenue and Customs Brief 'temporary zero rate of VAT for domestic electricity in Great Britain' (published 8 Sep 2026): 0% from 1 Oct 2026 to 31 Mar 2027, Great Britain only (Northern Ireland stays at 5%), gas excluded, and bills spanning 1 Oct apportioned by date of consumption. The report's VAT schedule boundaries (2026-09-30T23:00Z and 2027-03-31T23:00Z) are correct UTC instants.
- Agile standing charges exc VAT for AGILE-24-10-01, all 14 regions (A 46.4649 ... P 57.0745), each one open record from 2024-09-30T23:00Z. These match the report exactly.
- Flexible VAR-22-11-01 C, DIRECT_DEBIT unit and standing-charge table matches exactly, including new open rows from 2026-09-30T23Z (26.5956 unit, 41.3869 standing, inc == exc). NON_DIRECT_DEBIT duplicate rows are confirmed.
- Export and comparison tariffs:
- OUTGOING-VAR-24-10-26: 15.0p, then 12.0p from 2026-03-01T00:00Z.
- SEG-FIX: 4.1p since 2022-02-01.
- PRIME outgoing: 16p for 15:00Z-18:00Z (16-19 BST), 9p otherwise.
- OE-FIX-12M-26-10-02: 27.0519p unit, 41.3869p/day standing.
- Outgoing, SEG and Prime standing charges are 0.
- Fixtures. agile-C-12m.json matches a fresh live pull exactly (0 of 17,520 differ, 0 gaps, 0 duplicates). Independent node/Intl recompute: mean 19.9929, median 18.543, min -11.277, max 86.73, 497 negative slots (508 at or below 0), 16-19 local mean 34.830 vs 17.873 for the rest of the day, weekday peak 35.85 vs weekend 32.27. The monthly band table matches. Local days 2025-10-26 and 2026-03-29 have 50 and 46 slots.
- agile-outgoing-C-12m.json matches live exactly (0 diffs, exc == inc everywhere). Mean 11.17, 16-19h 18.082, rest 10.183.
- GSP postcode lookup (no auth): all 14 regions with the stated postcodes; lower-case, no-space and outward-only postcodes work; an invalid postcode gives an empty result; no postcode lists 14 regions.
- The consumption endpoint without auth gives 401 JSON. With a bad key it gives 401 'Invalid API key.'. Preflight returns 200. OpenAPI says page_size max 25000, -period by default, group_by hour/day/week/month/quarter, and types consumption as a string. The docs show mixed Z/+01:00 offsets, overlap semantics and half-even rounding to 0.01 kWh for billing.
- GraphQL (introspection, live). Mutation obtainKrakenToken(input: ObtainJSONWebTokenInput{APIKey, refreshToken, ...}) returns {token, payload, refreshToken, refreshExpiresIn}. AccountUserType.accounts is [AccountInterface] and is not deprecated. A fake key gets HTTP 200 with errors[0].extensions.errorCode KT-CT-1139. viewer without auth gives errorCode KT-CT-1112. So looking up the account number from just the key is feasible client-side.
MISSING
- Negative import prices: 497 slots in the 12-month window, down to -11.28p. The savings engine must not clamp prices at 0. Solar that displaces import during a negative slot is a small loss, not a saving. A battery can be modelled to grid-charge at negative or very cheap prices, which matters more for a battery decision than solar does.
- Agile Outgoing has a floor of 0p (12-month min exactly 0.0, 34 slots at 0), unlike Agile import. If export is modelled, don't mirror import's negative prices onto export.
- Price caps differ by Agile version (55p, 78p, 100p, 35p inc VAT) and bind in the 16:00-19:00 window. That is exactly the window the west/vertical orientation idea targets, so the peak-value numbers depend on the customer's actual version.
- It is unknown how the Agile 100p inc-VAT cap behaves under 0% VAT (still 95.23p exc, or 100p exc). It only matters for forward projections after Oct 2026. Flag it as an assumption.
- After plug-in solar is installed, the meter's import consumption is net of solar generation. The baseline for 'before' must come from data before installation. A plug-in kit has no export MPAN, so any exported surplus is unpaid and invisible in the API. The app should not treat net consumption from after installation as gross demand.
- VAT zero rate scope: Great Britain only (Northern Ireland stays at 5%; Octopus GSP regions are GB only, so this is mostly moot). It covers standing charges too, according to the secondary sources. Apportion by the time of consumption, which per-slot VAT already does. Reverting to 5% from 2027-04-01 is 'expected' per secondary sources, not legislated, so keep the schedule configurable as the report says.
- Only long or open-ended records get the wrong value_inc_vat. These are standing charges, flat Outgoing/SEG/Flexible open rows, and fixed products crossing 1 Oct 2026. Per-half-hour Agile rows ending before the switch carry the correct ×1.05, because each row's VAT is set by its own last day. Computing from value_exc_vat everywhere is still the simplest correct approach.
- The product-detail endpoint has direction=null (see correction). Use the list endpoint, or parse the code, to pick import vs export products.
- GraphQL errors arrive as HTTP 200 with an errors[] array (not 4xx), so the fetch wrapper must check body.errors. The format of the Authorization header for the Kraken token (raw token vs a 'JWT ' prefix) was NOT verified; both were rejected only because the token was fake. Try the raw token first.
- Security and UX of the API key: it exposes name, address and meter IDs. Send it only to api.octopus.energy in the Authorization header, never in a URL. Keep it in memory by default, with an opt-in 'remember' option. Rate responses send 'vary: Authorization' and cache-control max-age=300, so a re-fetch within 5 minutes may come from the browser HTTP cache.
ADDITIONAL
## Verification summary (octopus-api)

I re-ran nearly everything live on 2026-10-05, using curl/Python with an Origin header and a separate headless-Chromium page of my own. The core claims hold up: CORS is `*` everywhere, Basic auth works, the page-size caps and newest-first ordering are as described, the VAT switch at 2026-09-30T23:00Z is real, the region lookups work, and the main fixture and its stats reproduce exactly.

### What was wrong (details in `corrections`)
1. **Account-number regex is too strict.** The real router pattern is `^A-[0-9A-Z]{8}$`, not hex-only.
2. **"All Agile versions are identical from Oct 2024" is false at the peak.** Each version has its own price cap:
   - AGILE-22-07-22 is capped at 55p, so it differs in 11 slots.
   - AGILE-22-08-31 is capped at 78p, so it differs in 3 slots.
   - AGILE-23-12-06, AGILE-24-04-03 and AGILE-24-10-01 are all capped at 100p and are identical.
   - The fixture meta's `cross_check` text was wrong; the corrected copy is `/home/zack/.claude/jobs/52762e7f/tmp/research/agile-C-12m.meta-verified.json`.
3. **Standing charges differ by Agile version**: from 20.0 to 37.6525p/day exc VAT in region C. The app must use the customer's actual tariff code. Reference file: `/home/zack/.claude/jobs/52762e7f/tmp/research/agile-versions-C-verified.json`.
4. **`direction` is null in product detail.** Only the product list carries it.
5. **The MPAN-prefix region mapping fails for IDNO MPANs.** Use the public `/v1/electricity-meter-points/{mpan}/` lookup instead.

### Open questions now answered
- **GraphQL lookup of the account number from the key alone is feasible.** It is CORS-open and introspection confirms `obtainKrakenToken(input:{APIKey})` → `{token, refreshToken, refreshExpiresIn}` and `viewer { accounts { number } }`. The token header format is still unconfirmed.
- **VAT end date is confirmed by a primary source** (gov.uk Revenue and Customs Brief, 8 Sep 2026): the zero rate runs 1 Oct 2026 to 31 Mar 2027, GB only. Reverting to 5% is expected, not legislated.

### Still unverifiable without a real API key
- The live account response shape. The docs example matches the report.
- How gaps appear in consumption data, how meter-exchange duplicates behave, and how far back history goes.
- Whether the consumption `page_size=25000` cap holds. It is in the docs only.

### Files from this verification
- Scripts: `/home/zack/.claude/jobs/52762e7f/tmp/research/verify-octopus/v1.py` through `v8.py`, plus `stats.mjs`
- My Chromium CORS test page: `/home/zack/.claude/jobs/52762e7f/tmp/research/verify-octopus/cors-page/index.html`
- Fresh 12-month pull of AGILE-24-10-01 region C, as `[iso, exc, inc]`: `/home/zack/.claude/jobs/52762e7f/tmp/research/verify-octopus/agile-24-10-01-C-12m-fresh.json`

### Sources
- [gov.uk Revenue and Customs Brief: temporary zero rate of VAT for domestic electricity in Great Britain](https://www.gov.uk/government/publications/revenue-and-customs-brief-10-2026-temporary-zero-rate-of-vat-for-domestic-electricity-in-great-britain/temporary-zero-rate-of-vat-for-domestic-electricity-in-great-britain)
- [vatcalc](https://www.vatcalc.com/?p=51788)
- [Fuse Energy: electricity VAT cut](https://www.fuseenergy.com/news/electricity-vat-cut)
- [Octopus OpenAPI schema](https://api.octopus.energy/v1/schema/?namespaces=default)
- [Octopus REST endpoints guide](https://docs.octopus.energy/rest/guides/endpoints/)