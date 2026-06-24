import re, json, subprocess, sys, time

CATEGORIES = {
    "cloud-gateways":   "all-cloud-gateways",
    "switching":        "all-switching",
    "wifi":             "all-wifi",
    "physical-security":"all-physical-security",
    "door-access":      "all-door-access",
    "integrations":     "all-integrations",
    "advanced-hosting": "all-advanced-hosting",
    "accessories":      "accessories-cables-dacs",
}
CAT_TITLES = {
    "cloud-gateways":"Cloud Gateways","switching":"Switching","wifi":"WiFi",
    "physical-security":"Physical Security","door-access":"Door Access",
    "integrations":"Integrations","advanced-hosting":"Advanced Hosting",
    "accessories":"Accessories",
}

def fetch(slug):
    url = f"https://store.ui.com/us/en/category/{slug}"
    r = subprocess.run(["curl","-sS","--max-time","40", url], capture_output=True, text=True)
    html = r.stdout
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        return None
    return json.loads(m.group(1))

def clean_product(p, cat_key, subcat_id):
    price = (p.get("minDisplayPrice") or {}).get("amount")
    thumb = (p.get("thumbnail") or {}).get("url")
    feats = [t["name"].split("feature:",1)[1] for t in (p.get("tags") or [])
             if isinstance(t,dict) and t.get("name","").startswith("feature:")]
    return {
        "id": p.get("id"),
        "slug": p.get("slug"),
        "sku": p.get("displaySku") or p.get("name"),
        "title": p.get("shortTitle") or p.get("title"),
        "fullTitle": p.get("title"),
        "description": p.get("shortDescription"),
        "price": price,            # cents, USD
        "currency": (p.get("minDisplayPrice") or {}).get("currency","USD"),
        "status": p.get("status"),
        "image": thumb,
        "category": cat_key,
        "subcategory": subcat_id,
        "collectionSlug": p.get("collectionSlug"),
        "features": feats[:6],
    }

catalog = {}   # id -> product
cat_order = {}
for key, slug in CATEGORIES.items():
    data = fetch(slug)
    if not data:
        print(f"  ! {key}: no NEXT_DATA (slug {slug})", file=sys.stderr)
        continue
    subs = data.get("props",{}).get("pageProps",{}).get("subCategories") or []
    n=0
    for s in subs:
        for p in (s.get("products") or []):
            pid = p.get("id")
            if not pid: continue
            if pid not in catalog:
                catalog[pid] = clean_product(p, key, s.get("id"))
                n+=1
    print(f"  {key}: {len(subs)} subcats, {n} new products")
    time.sleep(0.3)

products = [p for p in catalog.values() if p['price']]
out = {
    "categories": [{"key":k,"title":CAT_TITLES[k]} for k in CATEGORIES],
    "products": products,
}
json.dump(out, open("catalog.json","w"), indent=1)
print(f"\nTOTAL: {len(products)} products across {len(CATEGORIES)} categories")
# price sanity + image presence
missing_img = sum(1 for p in products if not p["image"])
missing_price = sum(1 for p in products if not p["price"])
print(f"missing image: {missing_img}, missing price: {missing_price}")
from collections import Counter
c = Counter(p["category"] for p in products)
for k in CATEGORIES: print(f"  {k}: {c.get(k,0)}")
