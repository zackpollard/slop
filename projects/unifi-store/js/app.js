// app.js — bootstrap + hash router

import { loadCatalog, Catalog } from './data.js';
import * as Store from './state.js';
import {
  renderChrome, updateCartBadge, renderDrawer, closeCart, toast,
} from './components.js';
import {
  renderHome, renderCategory, renderProduct, renderCart, renderCheckout,
  renderOrder, renderAccount, renderNotFound,
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
    if (e.target.closest('[data-close-cart]')) closeCart();
  });

  // keep cart badge + open drawer in sync with state
  Store.onChange(() => {
    updateCartBadge();
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
