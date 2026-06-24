// app.js — bootstrap + hash router

import { loadCatalog, Catalog } from './data.js';
import * as Store from './state.js';
import {
  renderChrome, updateCartBadge, renderDrawer, closeCart, toast, renderCompareTray,
} from './components.js';
import {
  renderHome, renderCategory, renderProduct, renderCart, renderCheckout,
  renderOrder, renderAccount, renderNotFound, renderDeals, renderCompare, renderRack,
} from './views.js';

function route() {
  closeCart();
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean); // ['category','wifi']
  const [seg, arg] = parts;

  switch (seg) {
    case undefined: renderHome(); break;
    case 'category': arg ? renderCategory(arg) : renderHome(); break;
    case 'product': renderProduct(decodeURIComponent(arg || '')); break;
    case 'cart': renderCart(); break;
    case 'checkout': renderCheckout(); break;
    case 'order': renderOrder(decodeURIComponent(arg || '')); break;
    case 'account': renderAccount(); break;
    case 'deals': renderDeals(); break;
    case 'compare': renderCompare(); break;
    case 'rack': renderRack(); break;
    default: renderNotFound();
  }
  highlightNav(seg, arg);
}

function highlightNav(seg, arg) {
  document.querySelectorAll('#site-header .nav a').forEach(a => {
    a.classList.toggle('active', seg === 'category' && a.dataset.cat === arg);
  });
}

// global click delegation: add-to-cart from anywhere, drawer-closing links
function wireGlobal() {
  document.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add && !add.disabled) {
      const p = Catalog.byId.get(add.dataset.add);
      if (p) {
        Store.addToCart(p.id, 1);
        toast({ title: `Added to cart`, sub: p.title, image: p.image, actionLabel: 'Checkout', actionHash: '#/checkout' });
      }
      return;
    }
    const cmp = e.target.closest('[data-compare]');
    if (cmp) {
      const p = Catalog.byId.get(cmp.dataset.compare);
      if (p) {
        const was = Store.inCompare(p.id);
        const ok = Store.toggleCompare(p.id);
        if (!ok) toast({ title: `Compare is full (max ${Store.COMPARE_MAX})`, sub: 'Remove one to add another' });
        else if (!was) toast({ title: 'Added to compare', sub: p.title, image: p.image, actionLabel: 'Compare', actionHash: '#/compare' });
        // reflect toggle state on any matching buttons
        document.querySelectorAll(`[data-compare="${p.id}"].cmp-btn`).forEach(b => b.classList.toggle('on', Store.inCompare(p.id)));
      }
      return;
    }
    if (e.target.closest('[data-close-cart]')) closeCart();
  });

  // keep cart badge + drawer + compare tray in sync with state
  Store.onChange(() => {
    updateCartBadge();
    renderCompareTray();
    if (document.getElementById('cart-drawer').classList.contains('open')) renderDrawer();
  });

  window.addEventListener('hashchange', route);
}

async function main() {
  try {
    await loadCatalog();
  } catch (err) {
    document.getElementById('app').innerHTML =
      `<div class="wrap page"><div class="empty"><h3>Couldn't load the catalog</h3><p>${err}</p></div></div>`;
    return;
  }
  renderChrome();
  wireGlobal();
  route();
}

main();
