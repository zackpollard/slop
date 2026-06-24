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
