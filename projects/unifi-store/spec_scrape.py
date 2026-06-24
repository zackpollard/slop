#!/usr/bin/env python3
"""Scrape full technical specifications for every product in catalog.json.

Pulls each product's `technicalSpecification.sections` from the store.ui.com
Next.js data endpoint and writes `specs.json` keyed by product id, plus a
`derived` block (rack units, power draw, PoE budget, weight) used by the rack
builder and comparison tool. Run after scrape.py. No secrets, read-only.
"""
import re, json, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

CATALOG = json.load(open('catalog.json'))
PRODUCTS = CATALOG['products']

def build_id():
    html = subprocess.run(["curl", "-sS", "--max-time", "30",
                           "https://store.ui.com/us/en/products/udm-beast"],
                          capture_output=True, text=True).stdout
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    return json.loads(m.group(1))['buildId']

BUILD = build_id()
print(f"buildId={BUILD}", file=sys.stderr)

def fetch(p):
    slug = p['slug']
    url = f"https://store.ui.com/_next/data/{BUILD}/us/en/products/{slug}.json?slug={slug}"
    for attempt in range(3):
        r = subprocess.run(["curl", "-sS", "--max-time", "40", url], capture_output=True, text=True)
        try:
            data = json.loads(r.stdout)
        except Exception:
            time.sleep(0.5); continue
        pp = data.get('pageProps') or {}
        prods = (pp.get('collection') or {}).get('products') or []
        prod = next((x for x in prods if x.get('id') == p['id']), None) \
            or next((x for x in prods if x.get('slug') == slug), None)
        if not prod:
            return p['id'], None
        return p['id'], extract(prod)
    return p['id'], None

def extract(prod):
    spec = prod.get('technicalSpecification') or {}
    sections = []
    flat = {}  # label -> first value (for derived parsing)
    for sec in (spec.get('sections') or []):
        label = (sec.get('section') or {}).get('label')
        items = []
        for f in (sec.get('features') or []):
            feat = f.get('feature') or {}
            val = f.get('value')
            entry = {'label': feat.get('label'), 'value': val,
                     'note': f.get('note'), 'group': feat.get('parentId'),
                     'compare': bool(f.get('isUsedInCompare'))}
            items.append(entry)
            if val and feat.get('label') not in flat:
                flat[feat['label']] = val
        if items:
            sections.append({'label': label, 'items': items})
    return {'sections': sections, 'derived': derive(flat)}

def derive(v):
    def num_w(s, agg=max):
        nums = [float(x) for x in re.findall(r'(\d+(?:\.\d+)?)\s*W', s or '')]
        return agg(nums) if nums else None
    ff = v.get('Form Factor', '') or ''
    m = re.search(r'\((\d+)\s*U\)', ff)
    rack_units = int(m.group(1)) if m else None
    rackmount = 'rack' in ff.lower() or 'rackmount' in ff.lower().replace(' ', '')
    # fallback: derive U from dimensions height (mm)
    if rackmount and rack_units is None:
        dim = v.get('Dimensions', '') or ''
        dm = re.search(r'x\s*([\d.]+)\s*mm', dim)
        if dm:
            rack_units = max(1, round(float(dm.group(1)) / 44.45))
        else:
            rack_units = 1
    weight = None
    wm = re.search(r'(\d+(?:\.\d+)?)\s*kg', v.get('Weight', '') or '')
    if wm: weight = float(wm.group(1))
    poe = re.search(r'(\d+(?:\.\d+)?)\s*W', v.get('Total PoE Availability', '') or '')
    return {
        'formFactor': ff or None,
        'rackmount': rackmount,
        'rackUnits': rack_units,
        'maxPowerW': num_w(v.get('Max. Power Consumption'), max),
        'poeBudgetW': float(poe.group(1)) if poe else None,
        'weightKg': weight,
        'dimensions': v.get('Dimensions'),
    }

specs = {}
done = 0
with ThreadPoolExecutor(max_workers=6) as ex:
    futs = {ex.submit(fetch, p): p for p in PRODUCTS}
    for fut in as_completed(futs):
        pid, data = fut.result()
        if data and data['sections']:
            specs[pid] = data
        done += 1
        if done % 25 == 0:
            print(f"  {done}/{len(PRODUCTS)} ({len(specs)} with specs)", file=sys.stderr)

json.dump(specs, open('specs.json', 'w'), separators=(',', ':'))
withrack = sum(1 for s in specs.values() if s['derived']['rackmount'])
withpower = sum(1 for s in specs.values() if s['derived']['maxPowerW'])
print(f"\nDONE: {len(specs)}/{len(PRODUCTS)} products with specs; "
      f"{withrack} rackmount, {withpower} with power data", file=sys.stderr)
print(f"specs.json size: {len(json.dumps(specs))} bytes", file=sys.stderr)
