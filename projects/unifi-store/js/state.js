// state.js — cart + orders persisted to localStorage, with a tiny pub/sub

import { Catalog, TAX_RATE } from './data.js';

const KEYS = { cart: 'unifi_cart', orders: 'unifi_orders', intro: 'unifi_seen_intro' };

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function write(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

const listeners = new Set();
export function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit() { for (const cb of listeners) cb(); }

// ---------------- cart ----------------
let cart = read(KEYS.cart, []); // [{id, qty}]

export function getCart() { return cart; }
export function cartCount() { return cart.reduce((n, l) => n + l.qty, 0); }

export function addToCart(id, qty = 1) {
  const existing = cart.find(l => l.id === id);
  if (existing) existing.qty += qty;
  else cart.push({ id, qty });
  write(KEYS.cart, cart); emit();
}
export function setQty(id, qty) {
  const l = cart.find(l => l.id === id);
  if (!l) return;
  l.qty = Math.max(1, qty);
  write(KEYS.cart, cart); emit();
}
export function removeFromCart(id) {
  cart = cart.filter(l => l.id !== id);
  write(KEYS.cart, cart); emit();
}
export function clearCart() { cart = []; write(KEYS.cart, cart); emit(); }

// resolved line items joined with catalog data
export function cartLines() {
  return cart
    .map(l => { const p = Catalog.byId.get(l.id); return p ? { product: p, qty: l.qty, lineTotal: p.price * l.qty } : null; })
    .filter(Boolean);
}
export function cartSubtotal() { return cartLines().reduce((s, l) => s + l.lineTotal, 0); }

export function totals(shippingCents = 0) {
  const subtotal = cartSubtotal();
  const tax = Math.round(subtotal * TAX_RATE);
  return { subtotal, tax, shipping: shippingCents, total: subtotal + tax + shippingCents };
}

// ---------------- orders ----------------
let orders = read(KEYS.orders, []);

export function getOrders() { return orders; }

export function placeOrder({ shippingCents, address, payment, shippingMethod }) {
  const lines = cartLines().map(l => ({
    id: l.product.id, slug: l.product.slug, title: l.product.title, sku: l.product.sku,
    image: l.product.image, price: l.product.price, qty: l.qty, category: l.product.category,
  }));
  const t = totals(shippingCents);
  const date = new Date().toISOString();
  const number = makeOrderNumber();
  const order = { id: number, number, date, items: lines, ...t, address, payment, shippingMethod };
  orders = [order, ...orders];
  write(KEYS.orders, orders);
  clearCart();
  return order;
}

export function getOrder(number) { return orders.find(o => o.number === number); }

function makeOrderNumber() {
  const n = Math.floor(10000000 + Math.random() * 89999999);
  return 'UI-' + n;
}

// ---------------- dopamine stats ----------------
const ACHIEVEMENTS = [
  { id: 'first',     icon: '🎉', name: 'First Hit',        test: s => s.orderCount >= 1,        desc: 'Placed your first fake order' },
  { id: 'grand',     icon: '💸', name: 'Grand Total',      test: s => s.totalSpent >= 100000,   desc: 'Spent over $1,000 of nothing' },
  { id: 'fivek',     icon: '🤑', name: 'Five Figures Soon', test: s => s.totalSpent >= 500000,  desc: 'Over $5,000 "spent"' },
  { id: 'tenk',      icon: '🏦', name: 'Whale Mode',       test: s => s.totalSpent >= 1000000,  desc: 'Over $10,000 "spent"' },
  { id: 'fifty',     icon: '🐋', name: 'Hyperscaler',      test: s => s.totalSpent >= 5000000,  desc: 'Over $50,000 "spent"' },
  { id: 'items25',   icon: '📦', name: 'Hoarder',          test: s => s.itemCount >= 25,        desc: 'Ordered 25+ items' },
  { id: 'orders10',  icon: '🔁', name: 'Repeat Offender',  test: s => s.orderCount >= 10,       desc: 'Placed 10+ orders' },
  { id: 'beast',     icon: '🐉', name: 'Beast Mode',       test: (s, o) => hasSku(o, 'UDM-Beast'), desc: 'Ordered the Dream Machine Beast' },
  { id: 'cameras',   icon: '📷', name: 'Surveillance State', test: s => (s.byCategory['physical-security'] || 0) >= 5, desc: '5+ Physical Security items' },
];

function hasSku(orders, sku) {
  return orders.some(o => o.items.some(i => i.sku === sku));
}

export function stats() {
  const orderCount = orders.length;
  let itemCount = 0, totalSpent = 0;
  const byCategory = {};
  const skuCounts = {};
  for (const o of orders) {
    totalSpent += o.total;
    for (const i of o.items) {
      itemCount += i.qty;
      byCategory[i.category] = (byCategory[i.category] || 0) + i.qty;
      skuCounts[i.sku] = (skuCounts[i.sku] || 0) + i.qty;
    }
  }
  const favCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const topSku = Object.entries(skuCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // addiction level: scaled to $25k = 100%
  const level = Math.min(100, Math.round((totalSpent / 100) / 250));
  const s = { orderCount, itemCount, totalSpent, byCategory, favCategory, topSku, level };
  const achievements = ACHIEVEMENTS.map(a => ({ ...a, unlocked: a.test(s, orders) }));
  return { ...s, achievements };
}

// ---------------- intro banner ----------------
export function seenIntro() { return read(KEYS.intro, false); }
export function dismissIntro() { write(KEYS.intro, true); }
