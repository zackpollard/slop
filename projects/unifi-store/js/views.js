// views.js — route view renderers

import {
  Catalog, formatPrice, formatPriceShort, featureLabel, statusInfo, prettify,
  productsInCategory, relatedProducts, SHIPPING, TAX_RATE,
} from './data.js';
import * as Store from './state.js';
import {
  productCard, statusBadge, toast, modal, confettiBurst, openCart, escapeHtml, ICONS,
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
  scrollTop();
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
const catState = { sub: 'all', sort: 'featured', q: '' };

export function renderCategory(key) {
  const meta = Catalog.categoryByKey.get(key);
  if (!meta) { renderNotFound(); return; }
  catState.sub = 'all'; catState.sort = 'featured'; catState.q = '';
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
  const rel = relatedProducts(p, 4);
  let qty = 1;

  app().innerHTML = `<div class="wrap page">
    <div class="breadcrumb"><a href="#/">Home</a> › <a href="#/category/${p.category}">${meta?.title || ''}</a> › <span>${escapeHtml(p.title)}</span></div>
    <div class="pd">
      <div class="pd-media"><div class="pd-stage"><img src="${p.image}" alt="${escapeHtml(p.title)}"></div></div>
      <div class="pd-info">
        <h1>${escapeHtml(p.fullTitle || p.title)}</h1>
        <div class="pd-sku">${p.sku}</div>
        <div class="pd-price">${formatPrice(p.price)}</div>
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
        <div class="spec-table">
          ${specRow('Model', p.sku)}
          ${specRow('Category', meta?.title || '')}
          ${specRow('Series', prettify(p.subcategory, p.category))}
          ${specRow('Availability', info.label)}
          ${specRow('Price', formatPrice(p.price))}
        </div>
      </div>
    </div>

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
    toast({ title: `Added ${qty}× ${p.title}`, sub: formatPrice(p.price * qty), image: p.image, actionLabel: 'View cart', actionHash: '#/cart' });
  };
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
  const recompute = () => Store.totals(SHIPPING[shipMethod].cents);
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
        <div class="divider"></div>
        <div class="summary-row"><span>Subtotal</span><span id="s-sub">${formatPrice(t.subtotal)}</span></div>
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
  }

  document.getElementById('place-order').onclick = () => {
    if (!validateCheckout(form)) {
      toast({ title: 'Almost there', sub: 'Fix the highlighted fields (or hit “Fill with test data”)' });
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    processOrder({ shipMethod, data });
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

function processOrder({ shipMethod, data }) {
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

  confettiBurst();
  scrollTop();
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
        <div class="meter-label"><span>UniFi addiction level</span><span>${s.level}% · ${levelLabel}</span></div>
        <div class="meter"><i style="width:${Math.max(3, s.level)}%"></i></div>
      </div>
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
  return `<div class="order-row">
    <div class="or-head">
      <div><div class="or-no">${o.number}</div><div class="or-meta">${date} · ${o.items.reduce((n, i) => n + i.qty, 0)} item(s) · ${escapeHtml(o.shippingMethod)}</div></div>
      <div class="or-total">${formatPrice(o.total)}</div>
    </div>
    <div class="or-thumbs">${o.items.slice(0, 8).map(i => `<a href="#/product/${i.slug}"><img src="${i.image}" alt="${escapeHtml(i.title)}" title="${escapeHtml(i.title)}"></a>`).join('')}</div>
  </div>`;
}

// ============================================================ NOT FOUND
export function renderNotFound() {
  app().innerHTML = `<div class="wrap page"><div class="empty">
    <h3>Page not found</h3><p>That product or page doesn't exist (in this universe or the real one).</p>
    <a href="#/" class="btn btn-primary" style="margin-top:18px">Back to store</a></div></div>`;
  scrollTop();
}
