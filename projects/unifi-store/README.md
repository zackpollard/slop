# UniFi Store (parody)

A pixel-faithful-ish replica of the [UniFi Store](https://store.ui.com) with a **completely fake checkout**. Browse real UniFi products, fill a cart, "place an order", and get the full dopamine hit of buying — without spending a penny. For people whose UniFi addiction has become a serious (financial) problem.

> ⚠️ Unofficial fan parody. Not affiliated with Ubiquiti. Product names, prices, and imagery belong to Ubiquiti Inc. Nothing here is for sale, no payment is ever taken, nothing ships.

## Features

- **Real catalog** — 486 actual UniFi products across all 8 store categories (Cloud Gateways, Switching, WiFi, Physical Security, Door Access, Integrations, Advanced Hosting, Accessories), with real titles, descriptions, prices, stock status, and product photography.
- **Full store experience** — home hero carousel, category pages with series filters / sort / search, product detail pages with specs, and a live search overlay.
- **Cart** — slide-out drawer + full cart page, quantity controls, running totals.
- **Fake checkout** — contact + shipping + delivery method + payment, with card-brand detection and inline validation. A "⚡ Fill with test data" button for instant gratification. Always succeeds, charges $0.00.
- **Order confirmation** — confetti, an order number, and a reminder of how much money you *didn't* spend.
- **💙 Dopamine Dashboard** — your "Account" page: total pretend-spent (= total actually saved), orders placed, items hoarded, a UniFi *addiction level* meter, unlockable achievements, and full order history. All persisted in `localStorage`.

## How the catalog is built

The product data in `catalog.json` was scraped once from the public `store.ui.com` category pages (the `__NEXT_DATA__` JSON blob each Next.js page ships). Product images are hot-linked directly from Ubiquiti's CDN (`cdn.ecomm.ui.com`), which serves them without referer protection. There is **no runtime call to any UniFi API** — the store works fully offline from the bundled JSON.

To refresh the catalog, re-run `scrape.py` (kept in the project's git history / scratchpad) against the live category pages and overwrite `catalog.json`.

## Tech

Static HTML/CSS/JS — **no build step**. Vanilla ES modules, no framework, no dependencies (Inter font + product images via CDN). State lives in `localStorage`.

```
index.html          # app shell
catalog.json        # 486 scraped products
css/style.css       # UniFi-style light theme
js/
├── data.js         # catalog load + indexing + formatting
├── state.js        # cart, orders, dopamine stats (localStorage)
├── components.js   # header/footer, cart drawer, toasts, confetti, product cards
├── views.js        # route views (home, category, product, cart, checkout, order, account)
└── app.js          # hash router + bootstrap
```

## Local development

```bash
cd projects/unifi-store
python3 -m http.server 8000
# open http://localhost:8000
```

(ES modules require serving over HTTP, not opening `index.html` via `file://`.)
