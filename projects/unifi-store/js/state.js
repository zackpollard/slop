// state.js — cart + orders persisted to localStorage, with a tiny pub/sub

import { Catalog, TAX_RATE, effectivePrice, saleInfo } from './data.js';

const KEYS = { cart: 'unifi_cart', orders: 'unifi_orders', intro: 'unifi_seen_intro', compare: 'unifi_compare' };

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

// resolved line items joined with catalog data (sale-aware)
export function cartLines() {
  return cart
    .map(l => {
      const p = Catalog.byId.get(l.id);
      if (!p) return null;
      const unit = effectivePrice(p);
      return { product: p, qty: l.qty, unit, lineTotal: unit * l.qty, sale: saleInfo(p) };
    })
    .filter(Boolean);
}
export function cartSubtotal() { return cartLines().reduce((s, l) => s + l.lineTotal, 0); }
export function cartSaleSavings() {
  return cartLines().reduce((s, l) => s + (l.product.price - l.unit) * l.qty, 0);
}

export function totals(shippingCents = 0, promo = null) {
  const subtotal = cartSubtotal();
  let discount = 0, shipping = shippingCents;
  if (promo && !(promo.min && subtotal < promo.min)) {
    if (promo.type === 'pct') discount = Math.round(subtotal * promo.value / 100);
    else if (promo.type === 'fixed') discount = Math.min(promo.value, subtotal);
    else if (promo.type === 'freeship') shipping = 0;
  }
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round(taxable * TAX_RATE);
  return { subtotal, discount, tax, shipping, total: taxable + tax + shipping };
}
export function promoEligible(promo) {
  return !!promo && !(promo.min && cartSubtotal() < promo.min);
}

// ---------------- orders ----------------
let orders = read(KEYS.orders, []);

export function getOrders() { return orders; }

export function placeOrder({ shippingCents, address, payment, shippingMethod, promo }) {
  const lines = cartLines().map(l => ({
    id: l.product.id, slug: l.product.slug, title: l.product.title, sku: l.product.sku,
    image: l.product.image, price: l.unit, listPrice: l.product.price, qty: l.qty, category: l.product.category,
  }));
  const t = totals(shippingCents, promo);
  const date = new Date().toISOString();
  const number = makeOrderNumber();
  const order = {
    id: number, number, date, items: lines, ...t,
    promo: promo && promoEligible(promo) ? { code: promo.code, label: promo.label } : null,
    address, payment, shippingMethod,
  };
  orders = [order, ...orders];
  write(KEYS.orders, orders);
  clearCart();
  return order;
}

// ---------------- order tracking (derived from order date + method) ----------------
const TRACK_STAGES = [
  { key: 'confirmed', label: 'Order confirmed', icon: '✅', off: 0 },
  { key: 'processing', label: 'Processing at warehouse', icon: '🏭', off: 25 },
  { key: 'packed', label: 'Packed & labeled', icon: '📦', off: 150 },
  { key: 'shipped', label: 'Shipped', icon: '🚚', off: 900 },
  { key: 'transit', label: 'In transit', icon: '🛣️', off: 3600 },
  { key: 'out', label: 'Out for delivery', icon: '🛵', off: 7200 },
  { key: 'delivered', label: 'Delivered (in spirit)', icon: '🎁', off: 10800 },
];
export function orderTracking(order) {
  const express = (order.shippingMethod || '').includes('Express');
  const factor = express ? 0.5 : 1;
  const placed = new Date(order.date).getTime();
  const stages = TRACK_STAGES.map(s => ({ ...s, at: placed + s.off * factor * 1000 }));
  const now = Date.now();
  let current = 0;
  for (let i = 0; i < stages.length; i++) if (stages[i].at <= now) current = i;
  return { stages, current, delivered: now >= stages[stages.length - 1].at, number: trackingNumber(order) };
}
function trackingNumber(order) {
  const h = Math.abs([...order.number].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  return '1ZUI' + String(h).padStart(9, '0').slice(0, 9);
}

// ---------------- compare selection ----------------
let compare = read(KEYS.compare, []);
export const COMPARE_MAX = 4;
export function getCompare() { return compare; }
export function inCompare(id) { return compare.includes(id); }
export function toggleCompare(id) {
  if (compare.includes(id)) compare = compare.filter(x => x !== id);
  else if (compare.length < COMPARE_MAX) compare.push(id);
  else return false;
  write(KEYS.compare, compare); emit(); return true;
}
export function clearCompare() { compare = []; write(KEYS.compare, compare); emit(); }

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

const LEVEL_TITLES = [
  [0, 'Window Shopper'], [50000, 'Prosumer'], [200000, 'Homelab Hero'],
  [500000, 'Rack Addict'], [1500000, 'Datacenter Dad'], [5000000, 'Hyperscaler'],
];
export function levelTitle(totalSpent) {
  let t = LEVEL_TITLES[0][1];
  for (const [min, name] of LEVEL_TITLES) if (totalSpent >= min) t = name;
  return t;
}

export function stats() {
  const orderCount = orders.length;
  let itemCount = 0, totalSpent = 0, dealSavings = 0;
  const byCategory = {};
  const skuCounts = {};
  for (const o of orders) {
    totalSpent += o.total;
    dealSavings += (o.discount || 0);
    for (const i of o.items) {
      itemCount += i.qty;
      dealSavings += ((i.listPrice || i.price) - i.price) * i.qty;
      byCategory[i.category] = (byCategory[i.category] || 0) + i.qty;
      skuCounts[i.sku] = (skuCounts[i.sku] || 0) + i.qty;
    }
  }
  const favCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const topSku = Object.entries(skuCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // addiction level: scaled to $25k = 100%
  const level = Math.min(100, Math.round((totalSpent / 100) / 250));
  const s = { orderCount, itemCount, totalSpent, dealSavings, byCategory, favCategory, topSku, level, title: levelTitle(totalSpent) };
  const achievements = ACHIEVEMENTS.map(a => ({ ...a, unlocked: a.test(s, orders) }));
  return { ...s, achievements };
}

// ---------------- intro banner ----------------
export function seenIntro() { return read(KEYS.intro, false); }
export function dismissIntro() { write(KEYS.intro, true); }
