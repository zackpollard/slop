// data.js — catalog loading, indexing, and formatting helpers

export const TAX_RATE = 0.0825; // fake estimated sales tax

export const SHIPPING = {
  standard: { id: 'standard', name: 'Standard Shipping', sub: 'Arrives in 3–5 business days', cents: 0 },
  express:  { id: 'express',  name: 'Express Shipping',  sub: 'Arrives in 1–2 business days', cents: 2999 },
};

// Top-level category taglines (cosmetic, store-accurate flavour)
const CATEGORY_TAGLINE = {
  'cloud-gateways':    'Routing, security & the UniFi platform',
  'switching':         'PoE and aggregation, Lite to Enterprise',
  'wifi':              'Access points for every space',
  'physical-security': 'Cameras, NVRs, doorbells & sensors',
  'door-access':       'Readers, hubs, intercoms & kits',
  'integrations':      'VoIP, IoT, storage & connectivity',
  'advanced-hosting':  'Servers for self-hosting UniFi',
  'accessories':       'Cables, mounts, modules & power',
};

// acronyms / special-casing for prettifying slugs
const ACRONYMS = {
  xg: 'XG', poe: 'PoE', wan: 'WAN', nvr: 'NVR', ptz: 'PTZ', iot: 'IoT',
  sfp: 'SFP', dac: 'DAC', dacs: 'DACs', ai: 'AI', voip: 'VoIP', hd: 'HD',
  ups: 'UPS', led: 'LED', usb: 'USB', rj45: 'RJ45', '2': '2', '5g': '5G',
  lte: 'LTE', etherlighting: 'Etherlighting', wifi: 'WiFi', gbe: 'GbE',
};

const PHRASE = {
  'professional-max-xg': 'Professional Max & XG',
  'dome-turret': 'Dome & Turret',
  'sensors-alarms': 'Sensors & Alarms',
  'cables-dacs': 'Cables & DACs',
  'modules-fiber': 'Modules & Fiber',
  'poe-power': 'PoE & Power',
  'power-tech': 'Power Tech',
  'mega-capacity': 'Mega Capacity',
  'special-devices': 'Special Devices',
  'wifi-integrated': 'WiFi-Integrated',
  'enterprise-scale': 'Enterprise Scale',
  'large-scale': 'Large Scale',
  'starter-kit': 'Starter Kits',
};

export function prettify(slug, categoryKey) {
  if (!slug) return '';
  let s = slug;
  if (categoryKey && s.startsWith(categoryKey + '-')) s = s.slice(categoryKey.length + 1);
  if (PHRASE[s]) return PHRASE[s];
  // also try matching the tail after category strip against phrase keys
  return s.split('-').map(w => ACRONYMS[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

export function featureLabel(raw) {
  // tags look like "48-ports", "25g-sfp28", "throughput-rate:79"
  let s = String(raw).split(':')[0];
  return s.split('-').map(w => ACRONYMS[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

export function formatPrice(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatPriceShort(cents) {
  const n = cents / 100;
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return formatPrice(cents);
}

// ---- catalog store ----
export const Catalog = {
  products: [],
  byId: new Map(),
  bySlug: new Map(),
  categories: [],        // [{key,title,tagline,count,heroImage,subcategories:[{id,label,count}]}]
  categoryByKey: new Map(),
};

export async function loadCatalog() {
  const res = await fetch('catalog.json');
  const raw = await res.json();
  Catalog.products = raw.products;
  for (const p of raw.products) {
    Catalog.byId.set(p.id, p);
    Catalog.bySlug.set(p.slug, p);
  }
  // build category metadata
  for (const c of raw.categories) {
    const items = raw.products.filter(p => p.category === c.key);
    const subMap = new Map();
    for (const p of items) {
      if (!subMap.has(p.subcategory)) subMap.set(p.subcategory, []);
      subMap.get(p.subcategory).push(p);
    }
    const subcategories = [...subMap.entries()]
      .map(([id, list]) => ({ id, label: prettify(id, c.key), count: list.length }))
      .sort((a, b) => b.count - a.count);
    // hero image: pick the priciest available product (usually the flagship)
    const hero = [...items].sort((a, b) => b.price - a.price).find(p => p.status === 'Available') || items[0];
    const meta = {
      key: c.key,
      title: c.title,
      tagline: CATEGORY_TAGLINE[c.key] || '',
      count: items.length,
      heroImage: hero ? hero.image : '',
      subcategories,
    };
    Catalog.categories.push(meta);
    Catalog.categoryByKey.set(c.key, meta);
  }
  return Catalog;
}

export function productsInCategory(key) {
  return Catalog.products.filter(p => p.category === key);
}

export function relatedProducts(p, n = 4) {
  return Catalog.products
    .filter(x => x.subcategory === p.subcategory && x.id !== p.id)
    .concat(Catalog.products.filter(x => x.category === p.category && x.subcategory !== p.subcategory && x.id !== p.id))
    .slice(0, n);
}

export function searchProducts(q, limit = 8) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const terms = q.split(/\s+/);
  const scored = [];
  for (const p of Catalog.products) {
    const hay = (p.title + ' ' + p.sku + ' ' + p.description + ' ' + p.category).toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (!hay.includes(t)) { score = -1; break; }
      if (p.title.toLowerCase().includes(t)) score += 3;
      if (p.sku.toLowerCase().includes(t)) score += 2;
      score += 1;
    }
    if (score > 0) scored.push([score, p]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(s => s[1]);
}

export const STATUS = {
  Available:  { cls: 'in',   label: 'In stock', badge: null },
  SoldOut:    { cls: 'out',  label: 'Sold out', badge: { cls: 'soldout', text: 'Sold Out' } },
  ComingSoon: { cls: 'soon', label: 'Coming soon', badge: { cls: 'coming', text: 'Coming Soon' } },
};
export function statusInfo(s) { return STATUS[s] || STATUS.Available; }

// ============================================================
//  v2: deterministic helpers, deals, ratings, promos, specs
// ============================================================

function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function todayKey(d = new Date()) { return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

// ---- deterministic ratings ----
export function rating(p) {
  const r = mulberry32(hashStr(p.id + ':rating'));
  const stars = Math.round((3.7 + r() * 1.3) * 10) / 10; // 3.7–5.0
  const count = 18 + Math.floor(r() * 880);
  return { stars, count };
}

const REVIEW_SNIPPETS = [
  ['Rock solid', 'Dropped it into my rack and forgot it existed. Exactly what you want.'],
  ['My wife does not understand', 'But the controller dashboard is beautiful and that is what matters.'],
  ['One does not simply buy one', 'Now I need the matching switch. And the AP. Send help.'],
  ['Overkill for my apartment', 'Absolutely worth it. The blinkenlights alone justify the price.'],
  ['Bye bye money', 'Bought it, regret nothing, eyeing the next one already.'],
  ['Just works', 'Adopted in seconds, zero drama. UniFi tax is real but earned.'],
  ['Homelab approved', 'Quiet, cool, and the build quality is unreasonably good.'],
  ['Instant upgrade', 'Coverage and throughput jumped immediately. No notes.'],
];
export function reviews(p) {
  const r = mulberry32(hashStr(p.id + ':reviews'));
  const { stars, count } = rating(p);
  const n = 3;
  const used = new Set();
  const out = [];
  const names = ['rack_enthusiast', 'homelab_dan', 'PoE_Paul', 'subnet_sally', 'cmd_line_chris', 'fiber_fiona', 'unifi_uncle', 'vlan_vera'];
  for (let i = 0; i < n; i++) {
    let idx = Math.floor(r() * REVIEW_SNIPPETS.length);
    while (used.has(idx)) idx = (idx + 1) % REVIEW_SNIPPETS.length;
    used.add(idx);
    const s = Math.max(4, Math.min(5, Math.round(stars + (r() - 0.4))));
    out.push({ name: names[Math.floor(r() * names.length)], stars: s, title: REVIEW_SNIPPETS[idx][0], body: REVIEW_SNIPPETS[idx][1] });
  }
  return { stars, count, list: out };
}

// ---- daily deals / flash sale (date-seeded, stable per day) ----
const DEAL_COUNT = 8;
let _dealCache = null, _dealDay = null;
function dealMap() {
  const k = todayKey();
  if (_dealDay === k && _dealCache) return _dealCache;
  const rnd = mulberry32(hashStr('deals:' + k));
  const pool = Catalog.products.filter(p => p.status === 'Available' && p.price >= 5000);
  const shuffled = pool.map(p => [rnd(), p]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
  const map = new Map();
  for (const p of shuffled.slice(0, DEAL_COUNT)) {
    const pct = [10, 15, 20, 25, 30][Math.floor(mulberry32(hashStr(p.id + k))() * 5)];
    map.set(p.id, pct);
  }
  _dealCache = map; _dealDay = k;
  return map;
}
export function saleInfo(p) {
  const pct = dealMap().get(p.id);
  if (!pct) return null;
  const salePrice = Math.round(p.price * (100 - pct) / 100 / 100) * 100; // round to whole dollars
  return { pct, originalPrice: p.price, salePrice };
}
export function effectivePrice(p) { const s = saleInfo(p); return s ? s.salePrice : p.price; }
export function dealProducts() { return [...dealMap().keys()].map(id => Catalog.byId.get(id)).filter(Boolean); }
export function msUntilMidnight() { const n = new Date(); const m = new Date(n); m.setHours(24, 0, 0, 0); return m - n; }

// ---- promo codes (applied at checkout) ----
export const PROMO_CODES = {
  DOPAMINE10: { type: 'pct', value: 10, label: '10% off your order' },
  HOMELAB: { type: 'pct', value: 15, label: '15% off everything' },
  FREESHIP: { type: 'freeship', label: 'Free express shipping' },
  WHALE: { type: 'fixed', value: 10000, min: 100000, label: '$100 off orders over $1,000' },
  BEAST: { type: 'pct', value: 25, min: 150000, label: '25% off orders over $1,500' },
};
export function validatePromo(code) {
  const key = (code || '').trim().toUpperCase();
  const c = PROMO_CODES[key];
  return c ? { code: key, ...c } : null;
}

// ---- specs (lazy-loaded, ~2MB) ----
export const Specs = { map: null };
export async function loadSpecs() {
  if (Specs.map) return Specs.map;
  try { const r = await fetch('specs.json'); Specs.map = await r.json(); }
  catch { Specs.map = {}; }
  return Specs.map;
}
export function getSpecs(id) { return Specs.map ? Specs.map[id] : null; }
export function hasSpecs(id) { return !!(Specs.map && Specs.map[id]); }

// rows of a spec section worth displaying (items that actually carry a value)
export function specRows(section) {
  return section.items.filter(it => it.value != null && it.value !== '');
}
// a compact set of headline spec rows for compare (isUsedInCompare, capped)
export function compareRows(spec, limit = 14) {
  const rows = [];
  for (const sec of spec.sections) {
    for (const it of sec.items) {
      if (it.compare && it.value) rows.push({ section: sec.label, label: it.label, value: it.value });
    }
  }
  return rows.slice(0, limit);
}
