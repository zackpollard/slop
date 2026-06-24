# UniFi Store (parody)

A pixel-faithful-ish replica of the [UniFi Store](https://store.ui.com) with a **completely fake checkout**. Browse real UniFi products, fill a cart, "place an order", and get the full dopamine hit of buying — without spending a penny. For people whose UniFi addiction has become a serious (financial) problem.

> ⚠️ Unofficial fan parody. Not affiliated with Ubiquiti. Product names, prices, and imagery belong to Ubiquiti Inc. Nothing here is for sale, no payment is ever taken, nothing ships.

## Features

- **Real catalog** — 486 actual UniFi products across all 8 store categories (Cloud Gateways, Switching, WiFi, Physical Security, Door Access, Integrations, Advanced Hosting, Accessories), with real titles, descriptions, prices, stock status, and product photography.
- **Full store experience** — home hero carousel, category pages with series filters / sort / search, product detail pages with specs, and a live search overlay.
- **Cart** — slide-out drawer + full cart page, quantity controls, running totals.
- **Fake checkout** — contact + shipping + delivery method + payment, with card-brand detection and inline validation. A "⚡ Fill with test data" button for instant gratification. Always succeeds, charges $0.00.
- **Order confirmation** — confetti, an order number, and a reminder of how much money you *didn't* spend.
- **💙 Dopamine Dashboard** — your "Account" page: total pretend-spent (= total actually saved), orders placed, items hoarded, a UniFi *addiction level* meter with **level titles** (Window Shopper → … → Hyperscaler), unlockable achievements, deal/promo savings, and full order history. All persisted in `localStorage`.
- **🔥 Today's Deals** — a date-seeded set of daily flash discounts with a live countdown to midnight. Sale prices flow through cards, product pages, cart, and checkout.
- **Promo codes** — `DOPAMINE10`, `HOMELAB`, `FREESHIP`, `WHALE`, `BEAST` apply real discounts at checkout.
- **Compare** — pick up to 4 products (⇄ button), see a side-by-side spec table with differences highlighted, from real scraped specifications.
- **Real spec sheets & reviews** — full grouped technical specifications on every product page (from `specs.json`), plus deterministic star ratings and reviews.
- **🛠️ Rack & Setup Builder** — assemble a virtual 19″ rack from rack-mountable gear; live rack-unit, power-draw, PoE-budget, build-price and "annual electricity cost" math. Save/load named builds, add the whole build to cart.
- **📦 Order tracking** — order status advances over real elapsed time (Confirmed → Processing → Packed → Shipped → In transit → Out for delivery → Delivered), with a tracking number, progress bar, and live timeline. Nothing ships, obviously.
- **Advanced filters** — price buckets, in-stock-only, and on-sale filters in every category.

## How the catalog is built

The product data in `catalog.json` (486 products) and `specs.json` (full technical specs for the 237 products that have them, ~2 MB) were scraped once from the public `store.ui.com` Next.js pages — the `__NEXT_DATA__` JSON blob each category page ships (`scrape.py`), and the lighter `_next/data/<buildId>/…json` product endpoint for specs (`spec_scrape.py`). The spec scraper also derives rack units, power draw, and PoE budget (used by the rack builder). Product images hot-link directly from Ubiquiti's CDN (`cdn.ecomm.ui.com`), which serves them without referer protection. There is **no runtime call to any UniFi API** — the store works fully offline from the bundled JSON (`specs.json` is lazy-loaded only on product / compare / rack pages).

To refresh: re-run `python3 scrape.py` then `python3 spec_scrape.py` from the project directory and overwrite the two JSON files.

## Tech

Static HTML/CSS/JS — **no build step**. Vanilla ES modules, no framework, no dependencies (Inter font + product images via CDN). State lives in `localStorage`.

```
index.html          # app shell
catalog.json        # 486 scraped products
specs.json          # full technical specs (lazy-loaded, ~2 MB)
scrape.py           # regenerates catalog.json
spec_scrape.py      # regenerates specs.json (+ derived rack/power data)
css/style.css       # UniFi-style light theme
js/
├── data.js         # catalog/specs load, formatting, deals, ratings, promo codes
├── state.js        # cart, orders, dopamine stats, order tracking, compare (localStorage)
├── components.js   # header/footer, cart drawer, toasts, confetti, product cards, compare tray
├── views.js        # route views (home, category, product, cart, checkout, order, account, deals, compare, rack)
└── app.js          # hash router + bootstrap
```

## Local development

```bash
cd projects/unifi-store
python3 -m http.server 8000
# open http://localhost:8000
```

(ES modules require serving over HTTP, not opening `index.html` via `file://`.)
