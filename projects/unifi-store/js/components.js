// components.js — chrome (header/footer/topbar), cart drawer, toasts, confetti, modal, cards

import { Catalog, formatPrice, statusInfo, searchProducts } from './data.js';
import * as Store from './state.js';

export const ICONS = {
  cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2.5 3h2.2l2.1 12.3a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.2L21 7H6"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6L9 17l-5-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M3 12h18M3 18h18"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M21 8l-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};

const LOGO = `<a href="#/" class="logo" aria-label="UniFi Store home">
  <span class="mark">Ui</span>
  <span class="name"><b>UniFi</b></span>
  <span class="tag">Store</span>
</a>`;

// ---------------- chrome ----------------
export function renderChrome() {
  renderTopbar();
  renderHeader();
  renderFooter();
  renderIntroBanner();
  wireHeader();
  updateCartBadge();
}

function renderTopbar() {
  document.getElementById('topbar').innerHTML = `<div class="wrap">
    <a href="https://www.ui.com" target="_blank" rel="noopener">UI.com</a>
    <a href="#/" class="active">Store</a>
    <a href="https://community.ui.com" target="_blank" rel="noopener" class="hide-sm">Community</a>
    <a href="https://ui.com/download" target="_blank" rel="noopener" class="hide-sm">Download</a>
    <span class="spacer"></span>
    <div class="tb-right">
      <a href="#/account" class="hide-sm">💙 Dopamine Dashboard</a>
      <a href="#/account">Account</a>
    </div>
  </div>`;
}

function renderHeader() {
  const nav = Catalog.categories.map(c =>
    `<a href="#/category/${c.key}" data-cat="${c.key}">${c.title}</a>`).join('');
  document.getElementById('site-header').innerHTML = `<div class="wrap hd">
    ${LOGO}
    <nav class="nav">${nav}</nav>
    <div class="hd-actions">
      <span class="region" title="Shipping to United States"><span class="flag">🇺🇸</span><span class="hide-sm">United States</span></span>
      <button class="icon-btn" id="btn-search" aria-label="Search">${ICONS.search}</button>
      <a class="icon-btn" href="#/account" aria-label="Account">${ICONS.user}</a>
      <button class="icon-btn" id="btn-cart" aria-label="Cart" data-open-cart>${ICONS.cart}<span class="cart-badge" id="cart-badge" hidden>0</span></button>
      <button class="icon-btn hamburger" id="btn-menu" aria-label="Menu">${ICONS.menu}</button>
    </div>
  </div>`;
}

function renderFooter() {
  const cats = Catalog.categories.slice(0, 6).map(c => `<a href="#/category/${c.key}">${c.title}</a>`).join('');
  document.getElementById('site-footer').innerHTML = `<div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        ${LOGO}
        <p>A pixel-perfect-ish parody of the UniFi Store where the checkout is fake, the dopamine is real, and your bank account stays intact.</p>
      </div>
      <div class="foot-col"><h5>Shop</h5>${cats}</div>
      <div class="foot-col"><h5>Account</h5>
        <a href="#/account">Order History</a>
        <a href="#/account">Dopamine Dashboard</a>
        <a href="#/cart">Cart</a>
      </div>
      <div class="foot-col"><h5>Resources</h5>
        <a href="https://help.ui.com" target="_blank" rel="noopener">Help Center</a>
        <a href="https://ui.com/download" target="_blank" rel="noopener">Downloads</a>
        <a href="https://community.ui.com" target="_blank" rel="noopener">Community</a>
      </div>
      <div class="foot-col"><h5>The Real Thing</h5>
        <a href="https://store.ui.com" target="_blank" rel="noopener">store.ui.com ↗</a>
        <a href="https://github.com/zackpollard/slop" target="_blank" rel="noopener">Source on GitHub</a>
      </div>
    </div>
    <div class="foot-bottom">
      <span>© Ubiquiti Inc. trademarks &amp; product imagery belong to Ubiquiti. This is an unofficial fan parody — nothing here is for sale.</span>
      <span>No money changes hands. Ever. That's the whole point.</span>
    </div>
  </div>`;
}

function renderIntroBanner() {
  if (Store.seenIntro()) return;
  const bar = document.createElement('div');
  bar.className = 'intro-banner';
  bar.innerHTML = `<span>💙 <b>Heads up:</b> this is a parody store. Nothing is real, no card is charged, nothing ships. Just the pure dopamine of checkout.</span>
    <button id="intro-dismiss">Got it</button>`;
  document.getElementById('topbar').before(bar);
  bar.querySelector('#intro-dismiss').addEventListener('click', () => { Store.dismissIntro(); bar.remove(); });
}

function wireHeader() {
  document.getElementById('btn-cart').addEventListener('click', openCart);
  document.getElementById('btn-search').addEventListener('click', toggleSearch);
  document.getElementById('btn-menu').addEventListener('click', toggleMobileNav);
}

// ---------------- cart badge ----------------
export function updateCartBadge() {
  const badge = document.getElementById('cart-badge');
  if (!badge) return;
  const n = Store.cartCount();
  badge.textContent = n;
  badge.hidden = n === 0;
}

// ---------------- search overlay ----------------
let searchOpen = false;
function toggleSearch() {
  searchOpen ? closeSearch() : openSearch();
}
function openSearch() {
  closeSearch();
  searchOpen = true;
  const pop = document.createElement('div');
  pop.className = 'search-pop';
  pop.id = 'search-pop';
  pop.innerHTML = `<div class="wrap">
    <input class="search-input" id="search-input" placeholder="Search the store… try “U7”, “camera”, “PoE”" autocomplete="off">
    <div class="search-results" id="search-results"></div>
    <p class="search-hint">Press Esc to close</p>
  </div>`;
  document.getElementById('site-header').appendChild(pop);
  const input = pop.querySelector('#search-input');
  const results = pop.querySelector('#search-results');
  const render = () => {
    const list = searchProducts(input.value, 8);
    if (!input.value.trim()) { results.innerHTML = ''; return; }
    if (!list.length) { results.innerHTML = `<p class="search-hint">No products match “${escapeHtml(input.value)}”.</p>`; return; }
    results.innerHTML = list.map(p => `<div class="sr-row" data-nav="#/product/${p.slug}">
      <img src="${p.image}" alt="" loading="lazy"><div><div class="t">${escapeHtml(p.title)}</div><div class="s">${p.sku}</div></div>
      <div class="p">${formatPrice(p.price)}</div></div>`).join('');
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => { if (e.key === 'Escape') closeSearch(); });
  results.addEventListener('click', e => {
    const row = e.target.closest('[data-nav]');
    if (row) { location.hash = row.dataset.nav; closeSearch(); }
  });
  setTimeout(() => input.focus(), 30);
}
function closeSearch() {
  searchOpen = false;
  document.getElementById('search-pop')?.remove();
}

// ---------------- mobile nav ----------------
function toggleMobileNav() {
  const existing = document.getElementById('mobile-nav');
  if (existing) { existing.remove(); return; }
  const m = document.createElement('div');
  m.id = 'mobile-nav';
  m.className = 'search-pop';
  m.innerHTML = `<div class="wrap"><div class="filter-list">${
    Catalog.categories.map(c => `<button data-nav="#/category/${c.key}" style="font-size:16px;padding:12px 10px">${c.title}<span class="n">${c.count}</span></button>`).join('')
  }<button data-nav="#/account" style="font-size:16px;padding:12px 10px">💙 Dopamine Dashboard</button></div></div>`;
  document.getElementById('site-header').appendChild(m);
  m.addEventListener('click', e => {
    const b = e.target.closest('[data-nav]');
    if (b) { location.hash = b.dataset.nav; m.remove(); }
  });
}

// ---------------- cart drawer ----------------
export function openCart() {
  renderDrawer();
  const drawer = document.getElementById('cart-drawer');
  const scrim = document.getElementById('drawer-scrim');
  scrim.hidden = false;
  void drawer.offsetWidth; // force reflow so the slide-in transition runs (no rAF race with route close)
  drawer.classList.add('open');
  scrim.classList.add('show');
  drawer.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  scrim.onclick = closeCart;
}
export function closeCart() {
  const drawer = document.getElementById('cart-drawer');
  const scrim = document.getElementById('drawer-scrim');
  drawer.classList.remove('open');
  scrim.classList.remove('show');
  drawer.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
  setTimeout(() => { scrim.hidden = true; }, 220);
}

export function renderDrawer() {
  const drawer = document.getElementById('cart-drawer');
  if (drawer.getAttribute('aria-hidden') === 'true' && !drawer.classList.contains('open')) {
    // still render content so it's ready, but only if currently open we visually update
  }
  const lines = Store.cartLines();
  const count = Store.cartCount();
  if (!lines.length) {
    drawer.innerHTML = `<div class="drawer-head"><h3>Your Cart</h3>
      <button class="icon-btn" id="drawer-close" aria-label="Close">${ICONS.close}</button></div>
      <div class="empty-cart">${ICONS.cart}<h3 style="color:var(--ink)">Your cart is empty</h3>
      <p>Go fill it with things you will never pay for.</p>
      <a href="#/" class="btn btn-primary" id="drawer-shop" style="margin-top:16px">Start shopping</a></div>`;
    drawer.querySelector('#drawer-close').onclick = closeCart;
    drawer.querySelector('#drawer-shop').onclick = closeCart;
    return;
  }
  const t = Store.totals(0);
  drawer.innerHTML = `<div class="drawer-head"><h3>Your Cart · ${count}</h3>
    <button class="icon-btn" id="drawer-close" aria-label="Close">${ICONS.close}</button></div>
    <div class="drawer-body">${lines.map(drawerLine).join('')}</div>
    <div class="drawer-foot">
      <div class="saved-note">💙 You'll “save” ${formatPrice(t.total)} by not buying this.</div>
      <div class="summary-row"><span>Subtotal</span><span>${formatPrice(t.subtotal)}</span></div>
      <div class="summary-row"><span>Estimated tax</span><span>${formatPrice(t.tax)}</span></div>
      <div class="summary-row total"><span>Total</span><span>${formatPrice(t.total)}</span></div>
      <a href="#/checkout" class="btn btn-primary btn-block btn-lg" id="drawer-checkout" style="margin-top:14px">Checkout</a>
      <button class="btn btn-ghost btn-block" id="drawer-view" style="margin-top:8px">View full cart</button>
    </div>`;
  drawer.querySelector('#drawer-close').onclick = closeCart;
  drawer.querySelector('#drawer-checkout').onclick = closeCart;
  drawer.querySelector('#drawer-view').onclick = () => { location.hash = '#/cart'; closeCart(); };
  drawer.querySelectorAll('[data-qdec]').forEach(b => b.onclick = () => Store.setQty(b.dataset.qdec, lineQty(b.dataset.qdec) - 1));
  drawer.querySelectorAll('[data-qinc]').forEach(b => b.onclick = () => Store.setQty(b.dataset.qinc, lineQty(b.dataset.qinc) + 1));
  drawer.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => Store.removeFromCart(b.dataset.remove));
}
function lineQty(id) { return Store.getCart().find(l => l.id === id)?.qty || 1; }

function drawerLine(l) {
  const p = l.product;
  return `<div class="line">
    <a class="thumb" href="#/product/${p.slug}" data-close-cart><img src="${p.image}" alt="" loading="lazy"></a>
    <div>
      <a class="t" href="#/product/${p.slug}" data-close-cart>${escapeHtml(p.title)}</a>
      <div class="s">${p.sku}</div>
      <div class="lq"><button data-qdec="${p.id}" aria-label="Decrease">−</button><span>${l.qty}</span><button data-qinc="${p.id}" aria-label="Increase">+</button></div>
    </div>
    <div class="rt"><div class="lp">${formatPrice(l.lineTotal)}</div>
      <button class="rm" data-remove="${p.id}">Remove</button></div>
  </div>`;
}

// ---------------- toast ----------------
export function toast({ title, sub, image, actionLabel, actionHash, timeout = 3200 }) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${image ? `<img src="${image}" alt="">` : `<span style="color:var(--green)">${ICONS.check}</span>`}
    <div><div class="tt">${escapeHtml(title)}</div>${sub ? `<div class="ts">${escapeHtml(sub)}</div>` : ''}</div>
    ${actionLabel ? `<a href="${actionHash}">${escapeHtml(actionLabel)}</a>` : ''}`;
  root.appendChild(el);
  const kill = () => { el.style.transition = 'opacity .2s, transform .2s'; el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; setTimeout(() => el.remove(), 200); };
  const tid = setTimeout(kill, timeout);
  el.querySelector('a')?.addEventListener('click', () => { clearTimeout(tid); kill(); });
}

// ---------------- modal ----------------
export function modal({ title, body, actions }) {
  const scrim = document.createElement('div');
  scrim.className = 'modal-scrim';
  scrim.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h3>${title}</h3><div>${body}</div>
    <div class="modal-actions"></div></div>`;
  const close = () => scrim.remove();
  const actionsEl = scrim.querySelector('.modal-actions');
  (actions || [{ label: 'OK', primary: true }]).forEach(a => {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.primary ? 'btn-primary' : 'btn-ghost');
    b.textContent = a.label;
    b.onclick = () => { close(); a.onClick && a.onClick(); };
    actionsEl.appendChild(b);
  });
  scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
  document.getElementById('modal-root').appendChild(scrim);
  return close;
}

// ---------------- product card ----------------
export function statusBadge(p) {
  const info = statusInfo(p.status).badge;
  return info ? `<span class="badge ${info.cls}">${info.text}</span>` : '';
}

export function productCard(p) {
  const sold = p.status === 'SoldOut';
  return `<div class="card">
    ${statusBadge(p)}
    <a class="imgwrap" href="#/product/${p.slug}"><img src="${p.image}" alt="${escapeHtml(p.title)}" loading="lazy" decoding="async"></a>
    <a class="ttl" href="#/product/${p.slug}">${escapeHtml(p.title)}</a>
    <p class="desc">${escapeHtml(p.description || '')}</p>
    <div class="foot">
      <span class="price">${formatPrice(p.price)}</span>
      <button class="add" data-add="${p.id}" ${sold ? 'disabled title="Sold out"' : 'title="Add to cart"'} aria-label="Add ${escapeHtml(p.title)} to cart">${ICONS.plus}</button>
    </div>
  </div>`;
}

// ---------------- confetti ----------------
export function confettiBurst(duration = 2600) {
  const canvas = document.getElementById('confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.style.display = 'block';
  const resize = () => { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  resize();
  const colors = ['#006fff', '#39d98a', '#ffd166', '#ff6b6b', '#9b5cff', '#00c2ff'];
  const N = 160;
  const parts = Array.from({ length: N }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 120,
    y: innerHeight * 0.32,
    vx: (Math.random() - 0.5) * 11,
    vy: Math.random() * -13 - 4,
    g: 0.28 + Math.random() * 0.12,
    s: 5 + Math.random() * 7,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.995;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
    }
    if (t < duration) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, innerWidth, innerHeight); canvas.style.display = 'none'; }
  }
  requestAnimationFrame(frame);
}

// ---------------- util ----------------
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
