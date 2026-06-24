// views.js — route view renderers

import {
  Catalog, formatPrice, formatPriceShort, featureLabel, statusInfo, prettify,
  productsInCategory, relatedProducts, SHIPPING, TAX_RATE,
  effectivePrice, saleInfo, dealProducts, msUntilMidnight, validatePromo, PROMO_CODES,
  loadSpecs, getSpecs, hasSpecs, specRows, compareRows, reviews, rating,
} from './data.js';
import * as Store from './state.js';
import {
  productCard, statusBadge, toast, modal, confettiBurst, openCart, escapeHtml, ICONS,
  priceHTML, stars,
} from './components.js';

const app = () => document.getElementById('app');
const scrollTop = () => window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

// ============================================================ HOME
export function renderHome() {
  const heroPicks = pickHeroProducts();
  app().innerHTML = `
    <section class="hero">
      <div id="hero-track"></div>
      <div class="hero-dots" id="hero-dots"></div>
    </section>

    <div class="wrap">
      <section class="section deals-section">
        <div class="section-head">
          <h2>🔥 Today's Deals</h2>
          <div class="deal-countdown">Ends in <span id="deal-timer">--:--:--</span> · <a class="btn-link" href="#/deals">See all deals →</a></div>
        </div>
        <div class="grid">${dealProducts().slice(0, 6).map(productCard).join('')}</div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Shop by category</h2></div>
        <div class="tiles">${Catalog.categories.map(categoryTile).join('')}</div>
      </section>

      <section class="section">
        <div class="section-head"><h2>What's new</h2><a class="btn-link" href="#/category/wifi">Browse WiFi →</a></div>
        <div class="grid">${flagshipRow().map(productCard).join('')}</div>
      </section>

      <section class="section">
        <div class="section-head"><h2>Freshly stocked</h2><a class="btn-link" href="#/category/accessories">All accessories →</a></div>
        <div class="grid">${freshRow().map(productCard).join('')}</div>
      </section>
    </div>`;

  startHero(heroPicks);
  startDealCountdown();
  scrollTop();
}

let dealTimer = null;
function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
function startDealCountdown() {
  clearInterval(dealTimer);
  const tick = () => {
    const el = document.getElementById('deal-timer');
    if (!el) { clearInterval(dealTimer); return; }
    el.textContent = fmtCountdown(msUntilMidnight());
  };
  tick();
  dealTimer = setInterval(tick, 1000);
}

function categoryTile(c) {
  return `<a class="tile" href="#/category/${c.key}">
    <h3>${c.title}</h3>
    <div class="count">${c.count} products</div>
    <span class="go">Shop ${c.title} →</span>
    <img class="ti-img" src="${c.heroImage}" alt="" loading="lazy">
  </a>`;
}

function pickHeroProducts() {
  const wanted = ['UDM-Beast', 'EF-Core', 'UNAS-Pro', 'U7-Pro-Max'];
  const bySku = new Map(Catalog.products.map(p => [p.sku, p]));
  const picks = [];
  for (const sku of wanted) if (bySku.has(sku)) picks.push(bySku.get(sku));
  // top up from flagship categories by priciest available
  for (const key of ['cloud-gateways', 'wifi', 'physical-security']) {
    const top = productsInCategory(key).filter(p => p.status === 'Available').sort((a, b) => b.price - a.price)[0];
    if (top && !picks.includes(top)) picks.push(top);
  }
  return picks.slice(0, 4);
}

function flagshipRow() {
  // one priciest available product from several categories
  const out = [];
  for (const key of ['wifi', 'switching', 'cloud-gateways', 'physical-security', 'door-access', 'integrations']) {
    const p = productsInCategory(key).filter(x => x.status === 'Available').sort((a, b) => b.price - a.price)[0];
    if (p) out.push(p);
  }
  return out;
}

function freshRow() {
  return productsInCategory('accessories').filter(p => p.status === 'Available').slice(0, 6);
}

let heroTimer = null;
function startHero(picks) {
  const track = document.getElementById('hero-track');
  const dots = document.getElementById('hero-dots');
  if (!track || !picks.length) return;
  let i = 0;
  const eyebrowOf = p => Catalog.categoryByKey.get(p.category)?.title || 'New';
  const draw = () => {
    const p = picks[i];
    track.innerHTML = `<div class="hero-slide">
      <div class="hero-copy">
        <div class="eyebrow">${eyebrowOf(p)}</div>
        <h1>${escapeHtml(p.title)}</h1>
        <p>${escapeHtml(p.description || '')}</p>
        <div class="price">${formatPrice(p.price)}</div>
        <div class="hero-actions">
          <button class="btn btn-primary btn-lg" data-add="${p.id}">Add to Cart</button>
          <a class="btn btn-ghost btn-lg" href="#/product/${p.slug}">Learn More</a>
        </div>
      </div>
      <div class="hero-media"><img src="${p.image}" alt="${escapeHtml(p.title)}"></div>
    </div>`;
    dots.innerHTML = picks.map((_, k) => `<button class="${k === i ? 'active' : ''}" data-slide="${k}" aria-label="Slide ${k + 1}"></button>`).join('');
  };
  draw();
  dots.onclick = e => { const b = e.target.closest('[data-slide]'); if (b) { i = +b.dataset.slide; draw(); restart(); } };
  const next = () => { i = (i + 1) % picks.length; draw(); };
  const restart = () => { clearInterval(heroTimer); heroTimer = setInterval(next, 5500); };
  restart();
}

// ============================================================ CATEGORY
const catState = { sub: 'all', sort: 'featured', q: '', price: 'all', inStock: false, onSale: false };
const PRICE_BUCKETS = [
  { id: 'all', label: 'Any price' },
  { id: 'u100', label: 'Under $100', test: c => c < 10000 },
  { id: '100-300', label: '$100 – $300', test: c => c >= 10000 && c < 30000 },
  { id: '300-1000', label: '$300 – $1,000', test: c => c >= 30000 && c < 100000 },
  { id: '1000+', label: '$1,000+', test: c => c >= 100000 },
];

export function renderCategory(key) {
  const meta = Catalog.categoryByKey.get(key);
  if (!meta) { renderNotFound(); return; }
  Object.assign(catState, { sub: 'all', sort: 'featured', q: '', price: 'all', inStock: false, onSale: false });
  const all = productsInCategory(key);

  app().innerHTML = `<div class="wrap page">
    <div class="breadcrumb"><a href="#/">Home</a> › <span>${meta.title}</span></div>
    <h1 class="page-title">${meta.title}</h1>
    <p class="page-sub">${meta.tagline} · ${meta.count} products</p>

    <div class="layout" style="margin-top:24px">
      <aside class="sidebar">
        <div class="filter-group">
          <h4>Series</h4>
          <div class="filter-list" id="sub-filters">
            <button class="active" data-sub="all">All ${meta.title}<span class="n">${all.length}</span></button>
            ${meta.subcategories.map(s => `<button data-sub="${s.id}">${s.label}<span class="n">${s.count}</span></button>`).join('')}
          </div>
        </div>
        <div class="filter-group">
          <h4>Price</h4>
          <div class="filter-list" id="price-filters">
            ${PRICE_BUCKETS.map(b => `<button class="${b.id === 'all' ? 'active' : ''}" data-price="${b.id}">${b.label}</button>`).join('')}
          </div>
        </div>
        <div class="filter-group">
          <h4>Filters</h4>
          <label class="toggle"><input type="checkbox" id="f-instock"> In stock only</label>
          <label class="toggle"><input type="checkbox" id="f-onsale"> On sale 🔥</label>
        </div>
      </aside>
      <div>
        <div class="toolbar">
          <span class="count-label" id="result-count"></span>
          <div style="display:flex;gap:10px">
            <input class="select" id="cat-search" placeholder="Filter…" style="min-width:160px" autocomplete="off">
            <select class="select" id="sort-select">
              <option value="featured">Featured</option>
              <option value="price-asc">Price: Low to High</option>
              <option value="price-desc">Price: High to Low</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
        </div>
        <div id="cat-grid"></div>
      </div>
    </div>
  </div>`;

  const drawGrid = () => {
    let list = all.slice();
    if (catState.sub !== 'all') list = list.filter(p => p.subcategory === catState.sub);
    if (catState.price !== 'all') {
      const bucket = PRICE_BUCKETS.find(b => b.id === catState.price);
      if (bucket?.test) list = list.filter(p => bucket.test(effectivePrice(p)));
    }
    if (catState.inStock) list = list.filter(p => p.status === 'Available');
    if (catState.onSale) list = list.filter(p => saleInfo(p));
    if (catState.q.trim()) {
      const q = catState.q.toLowerCase();
      list = list.filter(p => (p.title + ' ' + p.sku + ' ' + p.description).toLowerCase().includes(q));
    }
    list = sortList(list, catState.sort);
    document.getElementById('result-count').textContent = `${list.length} product${list.length === 1 ? '' : 's'}`;
    const grid = document.getElementById('cat-grid');
    if (!list.length) { grid.innerHTML = `<div class="empty"><h3>No matches</h3><p>Try a different series or search.</p></div>`; return; }

    if (catState.sub === 'all' && !catState.q.trim() && catState.sort === 'featured') {
      // grouped by series
      grid.innerHTML = meta.subcategories.map(s => {
        const items = list.filter(p => p.subcategory === s.id);
        if (!items.length) return '';
        return `<h2 class="subsection-title">${s.label}</h2><div class="grid">${items.map(productCard).join('')}</div>`;
      }).join('');
    } else {
      grid.innerHTML = `<div class="grid">${list.map(productCard).join('')}</div>`;
    }
  };
  drawGrid();

  const subs = document.getElementById('sub-filters');
  subs.addEventListener('click', e => {
    const b = e.target.closest('[data-sub]'); if (!b) return;
    subs.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); catState.sub = b.dataset.sub; drawGrid();
  });
  document.getElementById('sort-select').addEventListener('change', e => { catState.sort = e.target.value; drawGrid(); });
  let deb; document.getElementById('cat-search').addEventListener('input', e => {
    clearTimeout(deb); deb = setTimeout(() => { catState.q = e.target.value; drawGrid(); }, 160);
  });
  const prices = document.getElementById('price-filters');
  prices.addEventListener('click', e => {
    const b = e.target.closest('[data-price]'); if (!b) return;
    prices.querySelectorAll('button').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); catState.price = b.dataset.price; drawGrid();
  });
  document.getElementById('f-instock').addEventListener('change', e => { catState.inStock = e.target.checked; drawGrid(); });
  document.getElementById('f-onsale').addEventListener('change', e => { catState.onSale = e.target.checked; drawGrid(); });
  scrollTop();
}

function sortList(list, sort) {
  if (sort === 'price-asc') return list.sort((a, b) => a.price - b.price);
  if (sort === 'price-desc') return list.sort((a, b) => b.price - a.price);
  if (sort === 'name') return list.sort((a, b) => a.title.localeCompare(b.title));
  return list; // featured = source order
}

// ============================================================ PRODUCT
export function renderProduct(slug) {
  const p = Catalog.bySlug.get(slug);
  if (!p) { renderNotFound(); return; }
  const meta = Catalog.categoryByKey.get(p.category);
  const info = statusInfo(p.status);
  const sold = p.status === 'SoldOut';
  const sale = saleInfo(p);
  const rev = reviews(p);
  const rel = relatedProducts(p, 4);
  const cmp = Store.inCompare(p.id);
  let qty = 1;

  const priceBlock = sale
    ? `<span class="now">${formatPrice(sale.salePrice)}</span> <span class="was">${formatPrice(sale.originalPrice)}</span> <span class="save-pill">Save ${sale.pct}%</span>`
    : formatPrice(p.price);

  app().innerHTML = `<div class="wrap page">
    <div class="breadcrumb"><a href="#/">Home</a> › <a href="#/category/${p.category}">${meta?.title || ''}</a> › <span>${escapeHtml(p.title)}</span></div>
    <div class="pd">
      <div class="pd-media"><div class="pd-stage"><img src="${p.image}" alt="${escapeHtml(p.title)}"></div></div>
      <div class="pd-info">
        <h1>${escapeHtml(p.fullTitle || p.title)}</h1>
        <div class="pd-sku">${p.sku}</div>
        <button class="pd-rating" id="pd-rating">${stars(rev.stars)}<span>${rev.stars} · ${rev.count} reviews</span></button>
        <div class="pd-price ${sale ? 'on-sale' : ''}">${priceBlock}</div>
        <div class="pd-tax">Excl. tax · free returns on nothing you bought</div>
        <p class="pd-desc">${escapeHtml(p.description || '')}</p>
        <div class="pd-status"><span class="dot ${info.cls}"></span>${info.label}</div>
        ${p.features?.length ? `<div class="feature-chips">${p.features.map(f => `<span class="chip">${escapeHtml(featureLabel(f))}</span>`).join('')}</div>` : ''}
        <div class="pd-buy">
          <div class="qty">
            <button id="q-dec" aria-label="Decrease">−</button><span id="q-val">1</span><button id="q-inc" aria-label="Increase">+</button>
          </div>
          <button class="btn btn-primary btn-lg" id="pd-add" style="flex:1" ${sold ? 'disabled' : ''}>${sold ? 'Sold Out' : 'Add to Cart'}</button>
        </div>
        <button class="btn btn-ghost btn-block" id="pd-compare">${cmp ? '✓ In compare' : '⇄ Add to compare'}</button>
        <div class="spec-table">
          ${specRow('Model', p.sku)}
          ${specRow('Category', meta?.title || '')}
          ${specRow('Series', prettify(p.subcategory, p.category))}
          ${specRow('Availability', info.label)}
        </div>
      </div>
    </div>

    <section class="section" id="pd-specs"><div class="section-head"><h2>Technical specifications</h2></div><div class="spec-loading">Loading specs…</div></section>

    <section class="section" id="reviews">
      <div class="section-head"><h2>Reviews</h2></div>
      <div class="reviews-summary">
        <div class="rs-big">${rev.stars}<span>/5</span></div>
        <div>${stars(rev.stars)}<div class="rs-count">Based on ${rev.count} totally real reviews</div></div>
      </div>
      <div class="review-list">${rev.list.map(r => `
        <div class="review"><div class="rv-head">${stars(r.stars)}<b>${escapeHtml(r.title)}</b></div>
        <p>${escapeHtml(r.body)}</p><div class="rv-by">— ${escapeHtml(r.name)}, verified non-buyer</div></div>`).join('')}
      </div>
    </section>

    ${rel.length ? `<section class="section">
      <div class="section-head"><h2>You might also obsess over</h2></div>
      <div class="rel-grid">${rel.map(productCard).join('')}</div>
    </section>` : ''}
  </div>`;

  const valEl = document.getElementById('q-val');
  document.getElementById('q-dec').onclick = () => { qty = Math.max(1, qty - 1); valEl.textContent = qty; };
  document.getElementById('q-inc').onclick = () => { qty = qty + 1; valEl.textContent = qty; };
  if (!sold) document.getElementById('pd-add').onclick = () => {
    Store.addToCart(p.id, qty);
    toast({ title: `Added ${qty}× ${p.title}`, sub: formatPrice(effectivePrice(p) * qty), image: p.image, actionLabel: 'View cart', actionHash: '#/cart' });
  };
  document.getElementById('pd-rating').onclick = () => document.getElementById('reviews')?.scrollIntoView({ behavior: 'smooth' });
  const cmpBtn = document.getElementById('pd-compare');
  cmpBtn.onclick = () => {
    const ok = Store.toggleCompare(p.id);
    if (!ok) { toast({ title: `Compare is full (max ${Store.COMPARE_MAX})`, sub: 'Remove one to add another' }); return; }
    cmpBtn.innerHTML = Store.inCompare(p.id) ? '✓ In compare' : '⇄ Add to compare';
  };

  // lazy-load + render full spec sheet
  loadSpecs().then(() => {
    const el = document.getElementById('pd-specs');
    if (!el) return;
    const spec = getSpecs(p.id);
    if (!spec || !spec.sections.length) { el.remove(); return; }
    el.querySelector('.spec-loading')?.remove();
    const body = spec.sections.map(sec => {
      const rows = specRows(sec);
      if (!rows.length) return '';
      return `<div class="spec-block"><h3>${escapeHtml(sec.label || '')}</h3>
        <div class="spec-grid">${rows.map(r => `<div class="srow">
          <span class="sk">${escapeHtml(r.label)}</span>
          <span class="sv">${escapeHtml(r.value).replace(/\n/g, '<br>')}</span></div>`).join('')}</div></div>`;
    }).join('');
    el.insertAdjacentHTML('beforeend', `<div class="spec-sheet">${body}</div>`);
  });
  scrollTop();
}

function specRow(k, v) { return `<div class="row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`; }

// ============================================================ CART (full page)
export function renderCart() {
  const lines = Store.cartLines();
  if (!lines.length) {
    app().innerHTML = `<div class="wrap page"><div class="empty">
      ${ICONS.cart}<h3>Your cart is empty</h3>
      <p>You haven't queued up any dopamine yet.</p>
      <a href="#/" class="btn btn-primary" style="margin-top:18px">Start shopping</a></div></div>`;
    scrollTop(); return;
  }
  const t = Store.totals(0);
  app().innerHTML = `<div class="wrap page">
    <h1 class="page-title">Your Cart</h1>
    <div class="checkout" style="margin-top:24px">
      <div>
        ${lines.map(cartPageLine).join('')}
        <a href="#/" class="btn-link" style="display:inline-block;margin-top:10px">← Continue shopping</a>
      </div>
      <aside class="co-summary">
        <h3>Order Summary</h3>
        <div class="summary-row"><span>Subtotal</span><span>${formatPrice(t.subtotal)}</span></div>
        <div class="summary-row"><span>Estimated tax</span><span>${formatPrice(t.tax)}</span></div>
        <div class="summary-row"><span>Shipping</span><span>Calculated at checkout</span></div>
        <div class="summary-row total"><span>Total</span><span>${formatPrice(t.total)}</span></div>
        <a href="#/checkout" class="btn btn-primary btn-block btn-lg" style="margin-top:16px">Proceed to Checkout</a>
        <div class="saved-note" style="margin-top:14px">💙 Checking out “costs” you ${formatPrice(t.total)} and charges you $0.00.</div>
      </aside>
    </div>
  </div>`;

  app().querySelectorAll('[data-qdec]').forEach(b => b.onclick = () => { Store.setQty(b.dataset.qdec, qtyOf(b.dataset.qdec) - 1); renderCart(); });
  app().querySelectorAll('[data-qinc]').forEach(b => b.onclick = () => { Store.setQty(b.dataset.qinc, qtyOf(b.dataset.qinc) + 1); renderCart(); });
  app().querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { Store.removeFromCart(b.dataset.remove); renderCart(); });
  scrollTop();
}
function qtyOf(id) { return Store.getCart().find(l => l.id === id)?.qty || 1; }

function cartPageLine(l) {
  const p = l.product;
  return `<div class="line" style="grid-template-columns:90px 1fr auto">
    <a class="thumb" href="#/product/${p.slug}" style="width:90px;height:90px"><img src="${p.image}" alt=""></a>
    <div>
      <a class="t" href="#/product/${p.slug}" style="font-size:15px">${escapeHtml(p.title)}</a>
      <div class="s">${p.sku} · ${formatPrice(p.price)} each</div>
      <div class="lq"><button data-qdec="${p.id}">−</button><span>${l.qty}</span><button data-qinc="${p.id}">+</button></div>
    </div>
    <div class="rt"><div class="lp" style="font-size:16px">${formatPrice(l.lineTotal)}</div>
      <button class="rm" data-remove="${p.id}">Remove</button></div>
  </div>`;
}

// ============================================================ CHECKOUT
const TEST_DATA = {
  email: 'definitely.not.buying@example.com', first: 'Dopamine', last: 'Enjoyer',
  address: '101 Ubiquiti Way', city: 'New York', state: 'NY', zip: '10001',
  card: '4242 4242 4242 4242', exp: '12/29', cvc: '424',
};

export function renderCheckout() {
  const lines = Store.cartLines();
  if (!lines.length) { location.hash = '#/cart'; return; }
  let shipMethod = 'standard';
  let promo = null;
  const recompute = () => Store.totals(SHIPPING[shipMethod].cents, promo);
  let t = recompute();

  app().innerHTML = `<div class="wrap page">
    <div class="co-steps">
      <div class="st done"><span class="num">${ICONS.check}</span>Cart</div><div class="sep"></div>
      <div class="st active"><span class="num">2</span>Checkout</div><div class="sep"></div>
      <div class="st"><span class="num">3</span>Confirmation</div>
    </div>
    <div class="checkout">
      <form id="checkout-form" novalidate>
        <div class="co-card">
          <h3>Contact</h3>
          <div class="field"><label>Email</label><input name="email" type="email" placeholder="you@example.com"><div class="err">Enter a valid email</div></div>
        </div>
        <div class="co-card">
          <h3>Shipping address</h3>
          <p class="hint">Where we would ship it, if any of this were real.</p>
          <div class="row-2">
            <div class="field"><label>First name</label><input name="first"><div class="err">Required</div></div>
            <div class="field"><label>Last name</label><input name="last"><div class="err">Required</div></div>
          </div>
          <div class="field"><label>Address</label><input name="address"><div class="err">Required</div></div>
          <div class="row-3">
            <div class="field"><label>City</label><input name="city"><div class="err">Required</div></div>
            <div class="field"><label>State</label><input name="state" maxlength="2" placeholder="NY"><div class="err">Required</div></div>
            <div class="field"><label>ZIP</label><input name="zip" inputmode="numeric"><div class="err">Required</div></div>
          </div>
        </div>
        <div class="co-card">
          <h3>Delivery</h3>
          <div id="ship-opts">
            ${Object.values(SHIPPING).map(s => shipOpt(s, s.id === shipMethod)).join('')}
          </div>
        </div>
        <div class="co-card">
          <h3>Payment ${ICONS.lock ? '' : ''}</h3>
          <p class="hint">🔒 Encrypted, tokenized, and then immediately thrown away. We charge nobody.</p>
          <div class="field"><label>Card number</label>
            <div class="card-input-wrap">
              <input name="card" inputmode="numeric" placeholder="4242 4242 4242 4242" autocomplete="off">
              <span class="card-brand" id="card-brand"></span>
            </div>
            <div class="err">Enter a card number</div>
          </div>
          <div class="row-2">
            <div class="field"><label>Expiry (MM/YY)</label><input name="exp" placeholder="12/29" maxlength="5"><div class="err">MM/YY</div></div>
            <div class="field"><label>CVC</label><input name="cvc" inputmode="numeric" placeholder="123" maxlength="4"><div class="err">3–4 digits</div></div>
          </div>
          <button type="button" class="btn-link" id="fill-test">⚡ Fill with test data</button>
        </div>
      </form>

      <aside class="co-summary">
        <h3>Order Summary</h3>
        <div id="co-lines">${lines.map(miniLine).join('')}</div>
        <div class="promo-box">
          <input id="promo-input" placeholder="Promo code" autocomplete="off">
          <button class="btn btn-ghost" id="promo-apply">Apply</button>
        </div>
        <div id="promo-msg" class="promo-msg hint">Psst… try <b>DOPAMINE10</b></div>
        <div class="divider"></div>
        <div class="summary-row"><span>Subtotal</span><span id="s-sub">${formatPrice(t.subtotal)}</span></div>
        <div class="summary-row discount-row" id="discount-row" hidden><span>Discount</span><span id="s-discount">−$0.00</span></div>
        <div class="summary-row"><span>Estimated tax (${(TAX_RATE * 100).toFixed(2)}%)</span><span id="s-tax">${formatPrice(t.tax)}</span></div>
        <div class="summary-row"><span>Shipping</span><span id="s-ship">${t.shipping ? formatPrice(t.shipping) : 'Free'}</span></div>
        <div class="summary-row total"><span>Total</span><span id="s-total">${formatPrice(t.total)}</span></div>
        <button class="btn btn-primary btn-block btn-lg" id="place-order" style="margin-top:16px">Place Order · <span id="btn-total">${formatPrice(t.total)}</span></button>
        <p class="disclaimer">By placing this order you agree that absolutely nothing happens, no payment is taken, and no hardware ships. You just feel good.</p>
      </aside>
    </div>
  </div>`;

  const form = document.getElementById('checkout-form');

  // shipping option selection
  document.getElementById('ship-opts').addEventListener('click', e => {
    const opt = e.target.closest('[data-ship]'); if (!opt) return;
    shipMethod = opt.dataset.ship;
    document.querySelectorAll('#ship-opts .ship-opt').forEach(o => o.classList.toggle('sel', o.dataset.ship === shipMethod));
    t = recompute(); updateSummary(t);
  });

  // card brand detection
  const cardInput = form.card;
  cardInput.addEventListener('input', () => {
    cardInput.value = formatCardNumber(cardInput.value);
    document.getElementById('card-brand').textContent = cardBrand(cardInput.value);
  });
  form.exp.addEventListener('input', () => { form.exp.value = formatExp(form.exp.value); });

  document.getElementById('fill-test').onclick = () => {
    for (const [k, v] of Object.entries(TEST_DATA)) if (form[k]) form[k].value = v;
    document.getElementById('card-brand').textContent = cardBrand(TEST_DATA.card);
    form.querySelectorAll('.field').forEach(f => f.classList.remove('invalid'));
    toast({ title: 'Test data loaded', sub: 'Smash that Place Order button' });
  };

  function updateSummary(t) {
    document.getElementById('s-sub').textContent = formatPrice(t.subtotal);
    document.getElementById('s-tax').textContent = formatPrice(t.tax);
    document.getElementById('s-ship').textContent = t.shipping ? formatPrice(t.shipping) : 'Free';
    document.getElementById('s-total').textContent = formatPrice(t.total);
    document.getElementById('btn-total').textContent = formatPrice(t.total);
    const dr = document.getElementById('discount-row');
    if (t.discount > 0) { dr.hidden = false; document.getElementById('s-discount').textContent = '−' + formatPrice(t.discount); }
    else dr.hidden = true;
  }

  const applyPromo = () => {
    const code = document.getElementById('promo-input').value;
    const msg = document.getElementById('promo-msg');
    const v = validatePromo(code);
    if (!v) { promo = null; msg.className = 'promo-msg bad'; msg.textContent = `“${code}” is not a valid code`; }
    else if (!Store.promoEligible(v)) { promo = null; msg.className = 'promo-msg bad'; msg.textContent = `${v.code} needs a higher subtotal (${formatPrice(v.min)}+)`; }
    else { promo = v; msg.className = 'promo-msg good'; msg.textContent = `✓ ${v.code} — ${v.label}`; }
    t = recompute(); updateSummary(t);
  };
  document.getElementById('promo-apply').onclick = applyPromo;
  document.getElementById('promo-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyPromo(); } });

  document.getElementById('place-order').onclick = () => {
    if (!validateCheckout(form)) {
      toast({ title: 'Almost there', sub: 'Fix the highlighted fields (or hit “Fill with test data”)' });
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    processOrder({ shipMethod, data, promo });
  };
  scrollTop();
}

function shipOpt(s, sel) {
  return `<div class="ship-opt ${sel ? 'sel' : ''}" data-ship="${s.id}">
    <span class="radio"></span>
    <div><div class="so-name">${s.name}</div><div class="so-sub">${s.sub}</div></div>
    <span class="so-price">${s.cents ? formatPrice(s.cents) : 'Free'}</span>
  </div>`;
}
function miniLine(l) {
  return `<div class="mini-line"><img src="${l.product.image}" alt="">
    <div><div class="mt">${escapeHtml(l.product.title)}</div><div class="mq">Qty ${l.qty}</div></div>
    <span class="mp">${formatPrice(l.lineTotal)}</span></div>`;
}

function validateCheckout(form) {
  let ok = true;
  const setBad = (name, bad) => { const f = form[name]?.closest('.field'); if (f) f.classList.toggle('invalid', bad); if (bad) ok = false; };
  setBad('email', !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.value.trim()));
  for (const n of ['first', 'last', 'address', 'city', 'zip']) setBad(n, !form[n].value.trim());
  setBad('state', form.state.value.trim().length < 2);
  setBad('card', form.card.value.replace(/\D/g, '').length < 15);
  setBad('exp', !/^\d{2}\/\d{2}$/.test(form.exp.value.trim()));
  setBad('cvc', form.cvc.value.replace(/\D/g, '').length < 3);
  return ok;
}

function processOrder({ shipMethod, data, promo }) {
  const overlay = document.createElement('div');
  overlay.className = 'processing';
  const steps = ['Authorizing card…', 'Definitely not charging you…', 'Reserving warehouse space…', 'Finalizing dopamine…'];
  overlay.innerHTML = `<div class="box"><div class="spinner"></div><p id="proc-msg">${steps[0]}</p></div>`;
  document.body.appendChild(overlay);
  let s = 0;
  const iv = setInterval(() => { s++; if (steps[s]) overlay.querySelector('#proc-msg').textContent = steps[s]; }, 480);

  setTimeout(() => {
    clearInterval(iv);
    overlay.remove();
    const order = Store.placeOrder({
      shippingCents: SHIPPING[shipMethod].cents,
      shippingMethod: SHIPPING[shipMethod].name,
      promo,
      address: { name: `${data.first} ${data.last}`, line1: data.address, city: data.city, state: data.state.toUpperCase(), zip: data.zip, email: data.email },
      payment: { brand: cardBrand(data.card) || 'Card', last4: data.card.replace(/\D/g, '').slice(-4) },
    });
    location.hash = `#/order/${order.number}`;
  }, 2000);
}

// card helpers
function formatCardNumber(v) { return v.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim(); }
function formatExp(v) { v = v.replace(/\D/g, '').slice(0, 4); return v.length >= 3 ? v.slice(0, 2) + '/' + v.slice(2) : v; }
function cardBrand(v) {
  const n = v.replace(/\D/g, '');
  if (/^4/.test(n)) return 'VISA';
  if (/^(5[1-5]|2[2-7])/.test(n)) return 'MASTERCARD';
  if (/^3[47]/.test(n)) return 'AMEX';
  if (/^6/.test(n)) return 'DISCOVER';
  return n ? 'CARD' : '';
}

// ============================================================ ORDER CONFIRMATION
export function renderOrder(number) {
  const order = Store.getOrder(number);
  if (!order) { renderNotFound(); return; }
  const date = new Date(order.date);
  const eta = new Date(date.getTime() + (order.shippingMethod?.includes('Express') ? 2 : 5) * 86400000);
  const fmtDate = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  app().innerHTML = `<div class="wrap page"><div class="confirm">
    <div class="check">${ICONS.check}</div>
    <h1>Order placed! 🎉</h1>
    <div class="order-no">Confirmation <b>${order.number}</b> · a receipt was not emailed to ${escapeHtml(order.address.email)}</div>
    <div class="charged">💳 $0.00 actually charged to your ${escapeHtml(order.payment.brand)} ····${order.payment.last4}</div>
    <div class="saved-big">You just experienced <b>${formatPrice(order.total)}</b> of shopping and kept <b>${formatPrice(order.total)}</b> in your bank account.</div>
    <div class="delivery">📦 Estimated delivery: <b>never</b> — but in fantasy land, ${fmtDate(eta)}.</div>

    <div class="track-card" id="track-card"></div>

    <div class="confirm-card">
      <div class="ch">
        <div><div class="l">Ship to</div><div class="v">${escapeHtml(order.address.name)}</div></div>
        <div><div class="l">Address</div><div class="v">${escapeHtml(order.address.line1)}, ${escapeHtml(order.address.city)} ${escapeHtml(order.address.state)} ${escapeHtml(order.address.zip)}</div></div>
        <div><div class="l">Method</div><div class="v">${escapeHtml(order.shippingMethod)}</div></div>
        <div><div class="l">Placed</div><div class="v">${fmtDate(date)}</div></div>
      </div>
      <div class="confirm-items">${order.items.map(orderItem).join('')}</div>
      <div class="ch" style="border-top:1px solid var(--line)">
        <div></div>
        <div style="text-align:right;min-width:200px">
          <div class="summary-row"><span>Subtotal</span><span>${formatPrice(order.subtotal)}</span></div>
          ${order.discount > 0 ? `<div class="summary-row"><span>Discount${order.promo ? ` (${order.promo.code})` : ''}</span><span>−${formatPrice(order.discount)}</span></div>` : ''}
          <div class="summary-row"><span>Tax</span><span>${formatPrice(order.tax)}</span></div>
          <div class="summary-row"><span>Shipping</span><span>${order.shipping ? formatPrice(order.shipping) : 'Free'}</span></div>
          <div class="summary-row total"><span>Total</span><span>${formatPrice(order.total)}</span></div>
        </div>
      </div>
    </div>

    <div class="confirm-actions">
      <a href="#/" class="btn btn-primary btn-lg">Order something else</a>
      <a href="#/account" class="btn btn-ghost btn-lg">View Dopamine Dashboard</a>
    </div>
  </div></div>`;

  startOrderTracking(order);
  confettiBurst();
  scrollTop();
}

let trackTimer = null;
function relTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function trackCardHTML(order) {
  const t = Store.orderTracking(order);
  const cur = t.stages[t.current];
  const pct = Math.round((t.current / (t.stages.length - 1)) * 100);
  const nextAt = t.current < t.stages.length - 1 ? t.stages[t.current + 1].at : null;
  return `<div class="track-head">
      <div><div class="track-status">${cur.icon} ${cur.label}</div>
        <div class="track-no">Tracking № ${t.number} · ${order.shippingMethod}</div></div>
      <div class="track-eta">${t.delivered ? '🎉 Delivered (emotionally)' : nextAt ? 'Next update ' + relTime(nextAt) : ''}</div>
    </div>
    <div class="track-bar"><i style="width:${pct}%"></i></div>
    <div class="track-steps">
      ${t.stages.map((s, i) => {
        const reached = i <= t.current;
        return `<div class="tstep ${reached ? 'on' : ''} ${i === t.current ? 'cur' : ''}">
          <span class="tstep-ic">${reached ? '✓' : s.icon}</span>
          <div class="tstep-body"><div class="tstep-l">${s.label}</div>
          <div class="tstep-t">${reached ? relTime(s.at) : 'pending'}</div></div></div>`;
      }).join('')}
    </div>`;
}
function startOrderTracking(order) {
  clearInterval(trackTimer);
  const draw = () => {
    const el = document.getElementById('track-card');
    if (!el) { clearInterval(trackTimer); return; }
    el.innerHTML = trackCardHTML(order);
  };
  draw();
  trackTimer = setInterval(draw, 3000);
}

function orderItem(i) {
  return `<div class="line" style="grid-template-columns:60px 1fr auto;padding:12px 0">
    <a class="thumb" href="#/product/${i.slug}" style="width:60px;height:60px"><img src="${i.image}" alt=""></a>
    <div><a class="t" href="#/product/${i.slug}">${escapeHtml(i.title)}</a><div class="s">${i.sku} · Qty ${i.qty}</div></div>
    <div class="lp">${formatPrice(i.price * i.qty)}</div></div>`;
}

// ============================================================ ACCOUNT / DOPAMINE DASHBOARD
export function renderAccount() {
  const s = Store.stats();
  const orders = Store.getOrders();
  const favCat = s.favCategory ? Catalog.categoryByKey.get(s.favCategory)?.title : '—';
  const levelLabel = s.level >= 90 ? 'Send help' : s.level >= 60 ? 'Severe' : s.level >= 30 ? 'Concerning' : s.level > 0 ? 'Mild' : 'Untouched';

  app().innerHTML = `<div class="wrap page">
    <section class="dash-hero">
      <h1>💙 Dopamine Dashboard</h1>
      <p>Everything you've “bought”, none of what you paid. This is a safe space.</p>
      <div class="stat-grid">
        <div class="stat"><div class="v">${formatPriceShort(s.totalSpent)}</div><div class="l">Pretend-spent</div></div>
        <div class="stat"><div class="v">${formatPriceShort(s.totalSpent)}</div><div class="l">Actually saved</div></div>
        <div class="stat"><div class="v">${s.orderCount}</div><div class="l">Orders placed</div></div>
        <div class="stat"><div class="v">${s.itemCount}</div><div class="l">Items hoarded</div></div>
      </div>
      <div class="meter-wrap">
        <div class="meter-label"><span>UniFi addiction level · 🏅 ${s.title}</span><span>${s.level}% · ${levelLabel}</span></div>
        <div class="meter"><i style="width:${Math.max(3, s.level)}%"></i></div>
      </div>
      ${s.dealSavings > 0 ? `<div class="dash-savings">🔥 You've pocketed an extra <b>${formatPrice(s.dealSavings)}</b> from deals &amp; promo codes (on top of the everything you saved by not buying).</div>` : ''}
    </section>

    <section class="section">
      <div class="section-head"><h2>Achievements</h2><span class="count-label">${s.achievements.filter(a => a.unlocked).length}/${s.achievements.length} unlocked</span></div>
      <div class="ach-grid">${s.achievements.map(a => `
        <div class="ach ${a.unlocked ? '' : 'locked'}">
          <div class="ic">${a.unlocked ? a.icon : '🔒'}</div>
          <div><div class="at">${a.name}</div><div class="ad">${a.desc}</div></div>
        </div>`).join('')}</div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Order history</h2>${s.favCategory ? `<span class="count-label">Favourite: ${favCat}${s.topSku ? ' · most-ordered: ' + s.topSku : ''}</span>` : ''}</div>
      ${orders.length ? orders.map(orderRow).join('') : `<div class="empty"><h3>No orders yet</h3><p>Your dopamine journey hasn't started.</p><a href="#/" class="btn btn-primary" style="margin-top:16px">Browse the store</a></div>`}
      ${orders.length ? `<button class="btn btn-ghost" id="clear-history" style="margin-top:8px">Clear history</button>` : ''}
    </section>
  </div>`;

  const clear = document.getElementById('clear-history');
  if (clear) clear.onclick = () => modal({
    title: 'Clear order history?',
    body: '<p>This wipes every fake order and resets your dopamine stats. Your real bank balance is unaffected (as always).</p>',
    actions: [
      { label: 'Cancel' },
      { label: 'Clear everything', primary: true, onClick: () => { localStorage.removeItem('unifi_orders'); renderAccount(); } },
    ],
  });
  scrollTop();
}

function orderRow(o) {
  const date = new Date(o.date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const t = Store.orderTracking(o);
  const cur = t.stages[t.current];
  return `<div class="order-row">
    <div class="or-head">
      <div><div class="or-no"><a href="#/order/${o.number}">${o.number}</a></div>
        <div class="or-meta">${date} · ${o.items.reduce((n, i) => n + i.qty, 0)} item(s) · ${escapeHtml(o.shippingMethod)}</div></div>
      <div style="text-align:right">
        <span class="track-pill ${t.delivered ? 'done' : ''}">${cur.icon} ${cur.label}</span>
        <div class="or-total">${formatPrice(o.total)}</div>
      </div>
    </div>
    <div class="or-thumbs">${o.items.slice(0, 8).map(i => `<a href="#/product/${i.slug}"><img src="${i.image}" alt="${escapeHtml(i.title)}" title="${escapeHtml(i.title)}"></a>`).join('')}</div>
  </div>`;
}

// ============================================================ DEALS
export function renderDeals() {
  const deals = dealProducts();
  app().innerHTML = `<div class="wrap page">
    <div class="breadcrumb"><a href="#/">Home</a> › <span>Deals</span></div>
    <h1 class="page-title">🔥 Today's Deals</h1>
    <p class="page-sub">${deals.length} hand-picked discounts that reset at midnight. Resistance is futile.</p>
    <div class="deal-banner">Deals reset in <span id="deal-timer-big">--:--:--</span></div>
    <div class="grid" style="margin-top:22px">${deals.map(productCard).join('')}</div>
  </div>`;
  clearInterval(dealTimer);
  const tick = () => { const el = document.getElementById('deal-timer-big'); if (!el) { clearInterval(dealTimer); return; } el.textContent = fmtCountdown(msUntilMidnight()); };
  tick(); dealTimer = setInterval(tick, 1000);
  scrollTop();
}

// ============================================================ COMPARE
export function renderCompare() {
  app().innerHTML = `<div class="wrap page">
    <div class="breadcrumb"><a href="#/">Home</a> › <span>Compare</span></div>
    <h1 class="page-title">Compare products</h1>
    <div id="compare-body"><div class="spec-loading">Loading specs…</div></div>
  </div>`;
  loadSpecs().then(drawCompare);
  // re-render while mounted when compare selection changes; auto-unsubscribe on leave
  const off = Store.onChange(() => { if (document.getElementById('compare-body')) drawCompare(); else off(); });
  scrollTop();
}
function drawCompare() {
  const body = document.getElementById('compare-body');
  if (!body) return;
  const products = Store.getCompare().map(id => Catalog.byId.get(id)).filter(Boolean);
  if (products.length < 1) {
    body.innerHTML = `<div class="empty"><h3>Nothing to compare yet</h3>
      <p>Hit the <b>⇄</b> button on any product to add it here (up to ${Store.COMPARE_MAX}).</p>
      <a href="#/category/switching" class="btn btn-primary" style="margin-top:16px">Browse products</a></div>`;
    return;
  }
  const specced = products.map(p => getSpecs(p.id));
  // union of compare-flagged spec labels, preserving first-seen order
  const rowMap = new Map();
  products.forEach((p, i) => {
    const sp = specced[i]; if (!sp) return;
    for (const sec of sp.sections) for (const it of sec.items)
      if (it.compare && it.value && !rowMap.has(it.label)) rowMap.set(it.label, sec.label);
  });
  const valueOf = (i, label) => {
    const sp = specced[i]; if (!sp) return null;
    for (const sec of sp.sections) for (const it of sec.items) if (it.label === label && it.value) return it.value;
    return null;
  };
  const baseRow = (label, vals) => {
    const present = vals.filter(v => v != null && v !== '');
    const diff = new Set(present.map(v => String(v))).size > 1;
    return `<tr class="${diff ? 'diff' : ''}"><th>${escapeHtml(label)}</th>${vals.map(v =>
      `<td>${v == null || v === '' ? '<span class="muted">—</span>' : escapeHtml(String(v)).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`;
  };

  const header = `<tr><th class="cmp-corner">${products.length}/${Store.COMPARE_MAX}</th>${products.map(p => `<th class="cmp-col">
      <button class="cmp-remove" data-compare="${p.id}" aria-label="Remove">${ICONS.close}</button>
      <a href="#/product/${p.slug}"><img src="${p.image}" alt=""></a>
      <a class="cmp-title" href="#/product/${p.slug}">${escapeHtml(p.title)}</a>
      <div class="cmp-price">${priceHTML(p)}</div>
      <button class="btn btn-primary btn-sm" data-add="${p.id}" ${p.status === 'SoldOut' ? 'disabled' : ''}>Add to cart</button>
    </th>`).join('')}</tr>`;

  const baseline = [
    baseRow('Price', products.map(p => formatPrice(effectivePrice(p)))),
    baseRow('Rating', products.map(p => rating(p).stars + ' ★')),
    baseRow('Availability', products.map(p => statusInfo(p.status).label)),
    baseRow('Category', products.map(p => Catalog.categoryByKey.get(p.category)?.title || '')),
  ].join('');

  let specBody = '', lastSection = null;
  for (const [label, section] of rowMap) {
    if (section !== lastSection) { specBody += `<tr class="cmp-section"><th colspan="${products.length + 1}">${escapeHtml(section || '')}</th></tr>`; lastSection = section; }
    specBody += baseRow(label, products.map((_, i) => valueOf(i, label)));
  }
  const anySpecs = specced.some(Boolean);

  body.innerHTML = `<div class="compare-actions">
      <span class="count-label">Rows where products differ are highlighted.</span>
      <button class="btn btn-ghost" id="cmp-clear-all">Clear all</button>
    </div>
    <div class="compare-scroll"><table class="compare-table">
      <thead>${header}</thead>
      <tbody>${baseline}${anySpecs ? specBody : `<tr><td colspan="${products.length + 1}" class="muted" style="padding:20px">No detailed specs available for these products.</td></tr>`}</tbody>
    </table></div>`;
  document.getElementById('cmp-clear-all').onclick = () => { Store.clearCompare(); drawCompare(); };
}

// ============================================================ RACK BUILDER
const RACK_KEY = 'unifi_rack';
const UNIT_PX = 28;
const KWH_COST = 0.30; // $/kWh, fake
function getRack() { try { return JSON.parse(localStorage.getItem(RACK_KEY)) || []; } catch { return []; } }
function setRack(ids) { localStorage.setItem(RACK_KEY, JSON.stringify(ids)); }

export function renderRack() {
  app().innerHTML = `<div class="wrap page"><div class="spec-loading">Loading rack-mountable gear…</div></div>`;
  loadSpecs().then(drawRack);
  scrollTop();
}
function rackmountList() {
  return Catalog.products
    .map(p => ({ p, d: getSpecs(p.id)?.derived }))
    .filter(x => x.d && x.d.rackmount && x.d.rackUnits)
    .sort((a, b) => a.p.category.localeCompare(b.p.category) || b.p.price - a.p.price);
}
function drawRack() {
  const all = rackmountList();
  const byId = new Map(all.map(x => [x.p.id, x]));
  let rack = getRack().filter(id => byId.has(id));
  setRack(rack);

  const items = rack.map(id => byId.get(id));
  const usedU = items.reduce((n, x) => n + x.d.rackUnits, 0);
  const power = items.reduce((n, x) => n + (x.d.maxPowerW || 0), 0);
  const poe = items.reduce((n, x) => n + (x.d.poeBudgetW || 0), 0);
  const price = items.reduce((n, x) => n + effectivePrice(x.p), 0);
  const rackH = Math.max(12, usedU + 3);
  const yearlyKwh = power * 24 * 365 / 1000;
  const yearlyCost = yearlyKwh * KWH_COST;

  // rack visual: stack items, then empty Us
  let slotsHTML = '', uLeft = rackH;
  for (const x of items) {
    slotsHTML += `<div class="rack-item" style="height:${x.d.rackUnits * UNIT_PX}px" title="${escapeHtml(x.p.title)}">
      <img src="${x.p.image}" alt="">
      <span class="ri-name">${escapeHtml(x.p.title)}</span>
      <span class="ri-meta">${x.d.rackUnits}U · ${x.d.maxPowerW ? x.d.maxPowerW + 'W' : '—'}</span>
      <button class="ri-rm" data-rack-rm="${x.p.id}" aria-label="Remove">${ICONS.close}</button></div>`;
    uLeft -= x.d.rackUnits;
  }
  for (let i = 0; i < uLeft; i++) slotsHTML += `<div class="rack-empty" style="height:${UNIT_PX}px">Empty</div>`;
  const ruler = Array.from({ length: rackH }, (_, i) => `<span style="height:${UNIT_PX}px">${rackH - i}</span>`).join('');

  // palette grouped by category
  const groups = {};
  for (const x of all) (groups[x.p.category] = groups[x.p.category] || []).push(x);
  const palette = Object.entries(groups).map(([cat, list]) => `
    <div class="pal-group"><h4>${Catalog.categoryByKey.get(cat)?.title || cat}</h4>
      ${list.map(x => `<button class="pal-item" data-rack-add="${x.p.id}">
        <img src="${x.p.image}" alt=""><span class="pi-t">${escapeHtml(x.p.title)}</span>
        <span class="pi-m">${x.d.rackUnits}U · ${formatPrice(effectivePrice(x.p))}</span>
        <span class="pi-plus">${ICONS.plus}</span></button>`).join('')}
    </div>`).join('');

  app().innerHTML = `<div class="wrap page">
    <div class="breadcrumb"><a href="#/">Home</a> › <span>Rack Builder</span></div>
    <h1 class="page-title">🛠️ Rack &amp; Setup Builder</h1>
    <p class="page-sub">Drag your dream homelab together. Watch the U's, power draw, and (imaginary) electricity bill climb.</p>

    <div class="rack-layout">
      <div class="rack-stage">
        <div class="rack">
          <div class="rack-ruler">${ruler}</div>
          <div class="rack-slots">${slotsHTML}</div>
        </div>
        ${usedU === 0 ? `<div class="rack-hint">← your rack is empty. Add gear from the right →</div>` : ''}
      </div>

      <div class="rack-side">
        <div class="rack-stats">
          <div class="rs-row"><span>Rack units</span><b>${usedU}U used</b></div>
          <div class="rs-row"><span>Power draw</span><b>${power} W</b></div>
          <div class="rs-row"><span>PoE budget</span><b>${poe ? poe + ' W' : '—'}</b></div>
          <div class="rs-row"><span>Est. running cost</span><b>~${'$' + yearlyCost.toFixed(0)}/yr</b></div>
          <div class="rs-row total"><span>Build price</span><b>${formatPrice(price)}</b></div>
          <button class="btn btn-primary btn-block btn-lg" id="rack-cart" ${items.length ? '' : 'disabled'} style="margin-top:12px">Add ${items.length} item${items.length === 1 ? '' : 's'} to cart</button>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-ghost" id="rack-save" ${items.length ? '' : 'disabled'} style="flex:1">Save build</button>
            <button class="btn btn-ghost" id="rack-clear" ${items.length ? '' : 'disabled'} style="flex:1">Clear</button>
          </div>
          <div id="rack-saved"></div>
        </div>
        <div class="rack-palette">
          <input class="select" id="rack-search" placeholder="Filter gear…" style="width:100%;margin-bottom:12px" autocomplete="off">
          <div id="rack-pal">${palette}</div>
        </div>
      </div>
    </div>
  </div>`;

  // wire
  app().querySelectorAll('[data-rack-add]').forEach(b => b.onclick = () => {
    const x = byId.get(b.dataset.rackAdd);
    rack.push(b.dataset.rackAdd); setRack(rack); drawRack();
    toast({ title: 'Added to rack', sub: `${x.p.title} · ${x.d.rackUnits}U`, image: x.p.image });
  });
  app().querySelectorAll('[data-rack-rm]').forEach(b => b.onclick = () => {
    const idx = rack.indexOf(b.dataset.rackRm);
    if (idx >= 0) rack.splice(idx, 1);
    setRack(rack); drawRack();
  });
  document.getElementById('rack-clear').onclick = () => { rack = []; setRack(rack); drawRack(); };
  document.getElementById('rack-cart').onclick = () => {
    const counts = {};
    rack.forEach(id => counts[id] = (counts[id] || 0) + 1);
    for (const [id, qty] of Object.entries(counts)) Store.addToCart(id, qty);
    toast({ title: `Added ${rack.length} items to cart`, sub: formatPrice(price), actionLabel: 'Checkout', actionHash: '#/checkout' });
  };
  document.getElementById('rack-save').onclick = () => saveRackBuild(rack);
  renderSavedBuilds();
  const search = document.getElementById('rack-search');
  search.addEventListener('input', () => {
    const q = search.value.toLowerCase();
    app().querySelectorAll('.pal-item').forEach(el => {
      const id = el.dataset.rackAdd; const x = byId.get(id);
      el.style.display = (x.p.title + ' ' + x.p.sku).toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

const BUILDS_KEY = 'unifi_rack_builds';
function getBuilds() { try { return JSON.parse(localStorage.getItem(BUILDS_KEY)) || []; } catch { return []; } }
function saveRackBuild(ids) {
  const name = prompt('Name this build:', 'Homelab v1');
  if (!name) return;
  const builds = getBuilds().filter(b => b.name !== name);
  builds.unshift({ name, ids: ids.slice() });
  localStorage.setItem(BUILDS_KEY, JSON.stringify(builds));
  renderSavedBuilds();
  toast({ title: 'Build saved', sub: name });
}
function renderSavedBuilds() {
  const el = document.getElementById('rack-saved');
  if (!el) return;
  const builds = getBuilds();
  if (!builds.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="saved-builds"><h4>Saved builds</h4>${builds.map(b => `
    <div class="saved-build"><button class="sb-load" data-build="${escapeHtml(b.name)}">${escapeHtml(b.name)} <span>(${b.ids.length})</span></button>
    <button class="sb-del" data-build-del="${escapeHtml(b.name)}" aria-label="Delete">${ICONS.close}</button></div>`).join('')}</div>`;
  el.querySelectorAll('[data-build]').forEach(b => b.onclick = () => {
    const build = getBuilds().find(x => x.name === b.dataset.build);
    if (build) { setRack(build.ids.slice()); drawRack(); }
  });
  el.querySelectorAll('[data-build-del]').forEach(b => b.onclick = () => {
    localStorage.setItem(BUILDS_KEY, JSON.stringify(getBuilds().filter(x => x.name !== b.dataset.buildDel)));
    renderSavedBuilds();
  });
}

// ============================================================ NOT FOUND
export function renderNotFound() {
  app().innerHTML = `<div class="wrap page"><div class="empty">
    <h3>Page not found</h3><p>That product or page doesn't exist (in this universe or the real one).</p>
    <a href="#/" class="btn btn-primary" style="margin-top:18px">Back to store</a></div></div>`;
  scrollTop();
}
