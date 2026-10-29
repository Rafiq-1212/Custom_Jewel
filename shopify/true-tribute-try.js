/*
 * True Tribute — the shop page's side of "Upload your photo"
 * (shopify/true-tribute-try.liquid). On every page of the shop:
 *
 *  - On a photo product's page, the button opens the tool's customer page
 *    (https://true-b.vercel.app/try) in a window over the product page, tells
 *    it the product, its metals and the variant chosen, and passes back a
 *    sign-in kept from last time, so a returning customer skips the code.
 *  - A design being made is kept here after every step. If the customer
 *    closes the window or goes to another page, the tool page is started
 *    again out of sight to carry on, and a notice in the bottom right says
 *    how it is going; when it is ready, the notice takes them back to the
 *    product with their design open.
 *  - Add to Cart / Buy Now in the window put the design on the product form
 *    as hidden fields (_tt_design, _tt_phone) and a visible "Design"
 *    reference, switch the page to the metal they chose, and press the
 *    shop's own button, so its pricing and Magic Checkout carry on as usual.
 *
 * Messages are only accepted from, and only sent to, the tool's address.
 */
(function () {
  // The snippet is on product pages and in the footer: run once.
  if (window.__trueTributeTry) return;
  window.__trueTributeTry = true;
  var config = document.querySelector('[data-tt-tool]');
  if (!config) return;
  var TOOL = config.getAttribute('data-tt-tool');
  var KEY = 'true-tribute:customer';
  var PENDING = 'true-tribute:pending';
  // When the page carrying a design on last said so: one page at a time does.
  var BEAT = 'true-tribute:beat';

  var root = document.querySelector('.tt-try');
  var form = root ? document.querySelector('form[action*="/cart/add"]') : null;
  var variants = [];
  try { if (root) variants = JSON.parse(root.querySelector('[data-tt-variants]').textContent || '[]'); } catch (e) {}

  // The store's own product section ("Newproduct") has no room for extra
  // blocks, so the button is rendered in a section of its own and moved to
  // just above Add to Cart / Buy Now; sections left empty are hidden.
  var buttons = form && form.querySelector('.pd-buttons');
  if (root && buttons) buttons.parentNode.insertBefore(root, buttons);
  document.querySelectorAll('[data-tt-tool]').forEach(function (el) {
    var host = el.closest('.shopify-section');
    if (host && !host.querySelector('.tt-try')) host.style.display = 'none';
  });

  var overlay = null;
  var frame = null;
  var ready = false;
  var worker = false;
  var toast = null;

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function store(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }
  function working(p) { return Boolean(p && (p.step === 'drawing' || p.step === 'photo')); }
  // ponytail: two tabs opened in the same few seconds may both carry it on; a lock would stop that if it matters.
  function beatFresh() { var b = read(BEAT); return Boolean(b && Date.now() - b < 9000); }

  function variant() {
    var input = form && form.querySelector('[name="id"]');
    var id = input ? String(input.value) : '';
    for (var i = 0; i < variants.length; i++) if (String(variants[i].id) === id) return { id: id, title: variants[i].title };
    return id ? { id: id, title: '' } : null;
  }
  function metals() {
    var list = [];
    for (var i = 0; i < variants.length; i++) {
      var m = /gold/i.test(variants[i].title) ? 'gold' : /silver/i.test(variants[i].title) ? 'silver' : null;
      if (m && list.indexOf(m) < 0) list.push(m);
    }
    return list;
  }
  function context() {
    return {
      type: 'init',
      product: root ? { handle: root.getAttribute('data-handle'), title: root.getAttribute('data-title') } : null,
      variant: variant(),
      session: read(KEY),
      metals: metals(),
      url: root ? location.origin + location.pathname : null,
      pending: read(PENDING),
      worker: worker,
    };
  }
  function send(message) {
    if (!frame || !frame.contentWindow) return;
    message.source = 'true-tribute-shop';
    frame.contentWindow.postMessage(message, TOOL);
  }

  function ensureFrame() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'tt-try__overlay';
    overlay.hidden = true;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    frame = document.createElement('iframe');
    frame.className = 'tt-try__frame';
    frame.title = 'See your pendant';
    frame.allow = 'camera';
    frame.src = TOOL + '/try?shop=' + encodeURIComponent(location.hostname);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
  }
  function open() {
    ensureFrame();
    overlay.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    if (ready) send(context());
    showToast();
  }
  function close() {
    if (overlay) overlay.hidden = true;
    document.documentElement.style.overflow = '';
    showToast();
  }
  // Back to the product the design was made for, with it open.
  function view() {
    var p = read(PENDING);
    if (!p || (root && p.handle === root.getAttribute('data-handle')) || !p.url) {
      if (root) open();
      return;
    }
    location.href = p.url + '#tt-open';
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  // The notice in the bottom right, while a design is made out of sight and once it is ready.
  function showToast() {
    var p = read(PENDING);
    var show = p && p.step && (!overlay || overlay.hidden);
    if (!show) {
      if (toast) toast.hidden = true;
      return;
    }
    if (!toast) {
      toast = el('div', 'tt-toast');
      toast.setAttribute('role', 'status');
      toast.addEventListener('click', view);
      document.body.appendChild(toast);
    }
    toast.hidden = false;
    toast.textContent = '';
    var session = read(KEY);
    if (p.step === 'done' && p.photo !== false && session) {
      var img = el('img', 'tt-toast__img');
      img.alt = '';
      img.src = TOOL + '/api/try/image?job=' + encodeURIComponent(p.job) + '&kind=photo&metal=' + p.metal + '&token=' + encodeURIComponent(session.token);
      img.onerror = function () { img.remove(); };
      toast.appendChild(img);
    } else if (working(p)) {
      toast.appendChild(el('span', 'tt-toast__spin'));
    }
    var text = el('div', 'tt-toast__text');
    if (p.step === 'done') {
      text.appendChild(el('strong', '', 'Your pendant is ready!'));
      text.appendChild(el('span', '', (p.ref ? 'Design ' + p.ref + ' · ' : '') + 'Tap to see it and buy'));
    } else if (p.step === 'failed') {
      text.appendChild(el('strong', '', "Your design couldn't be finished"));
      text.appendChild(el('span', '', 'Tap to try again'));
    } else {
      text.appendChild(el('strong', '', 'Making your pendant…'));
      text.appendChild(el('span', '', "Keep browsing. We'll tell you here when it's ready."));
    }
    toast.appendChild(text);
    if (!working(p)) {
      var dismiss = el('button', 'tt-toast__close', '×');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.addEventListener('click', function (e) {
        e.stopPropagation();
        store(PENDING, null);
        showToast();
      });
      toast.appendChild(dismiss);
    }
  }

  // Picks a design up when no other page is carrying it on.
  function elect() {
    var p = read(PENDING);
    if (working(p) && !worker && !beatFresh()) {
      worker = true;
      store(BEAT, Date.now());
      ensureFrame();
      if (ready) send(context());
    }
    showToast();
  }

  function field(name, value) {
    if (!form) return;
    var input = form.querySelector('input[name="properties[' + name + ']"]');
    if (!input) {
      input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'properties[' + name + ']';
      form.appendChild(input);
    }
    input.value = value;
  }
  // The page's own metal choice (Silver / Gold / Gold-plated), set to the one chosen in the window.
  function chooseMetal(metal) {
    var current = document.querySelector('input[name="metal_type"]:checked');
    if (current && /gold/i.test(current.value) === (metal === 'gold')) return false;
    var radios = document.querySelectorAll('input[name="metal_type"]');
    for (var i = 0; i < radios.length; i++) {
      if (metal === 'gold' ? /^gold$/i.test(radios[i].value) : /silver/i.test(radios[i].value)) {
        radios[i].click();
        return true;
      }
    }
    return false;
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== TOOL || !event.data || event.data.source !== 'true-tribute') return;
    var data = event.data;
    if (data.type === 'ready') {
      ready = true;
      send(context());
    } else if (data.type === 'session') {
      store(KEY, data.session || null);
    } else if (data.type === 'pending') {
      store(PENDING, data.pending || null);
      worker = working(data.pending);
      store(BEAT, worker ? Date.now() : null);
      showToast();
    } else if (data.type === 'beat') {
      if (worker) store(BEAT, Date.now());
    } else if (data.type === 'size') {
      if (frame && window.innerWidth >= 750) frame.style.height = Math.min(Number(data.height) || 560, window.innerHeight * 0.92) + 'px';
    } else if (data.type === 'use-design') {
      field('_tt_design', data.job);
      field('_tt_phone', data.phone);
      if (data.ref) field('Design', data.ref);
      // On the cart too, for the order and for checkout.
      fetch('/cart/update.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attributes: { 'Mobile (design)': data.phone } }) }).catch(function () {});
      var p = read(PENDING);
      if (p && p.job === data.job) store(PENDING, null);
      var switched = data.metal ? chooseMetal(data.metal) : false;
      var note = root && root.querySelector('[data-tt-note]');
      if (note) {
        note.textContent = '✓ Your design ' + (data.ref || '') + ' is added' + (data.metal ? ', in ' + (data.metal === 'gold' ? 'gold' : 'silver') : '') + '.';
        note.hidden = false;
      }
      close();
      // After a metal switch the page updates its variant first.
      setTimeout(function () {
        var button = data.then === 'buy' ? document.getElementById('pdBuyNow') || (form && form.querySelector('.shopify-payment-button__button')) : data.then === 'cart' ? form && form.querySelector('button[name="add"], [type="submit"]') : null;
        if (button) button.click();
        else {
          var buy = form && form.querySelector('[type="submit"]');
          if (buy && buy.scrollIntoView) buy.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, switched ? 500 : 0);
    } else if (data.type === 'go') {
      try {
        var to = new URL(String(data.url), location.href);
        if (to.origin === location.origin) location.href = to.origin + to.pathname + '#tt-open';
      } catch (e) {}
    } else if (data.type === 'close') {
      close();
    }
  });

  window.addEventListener('storage', function (e) {
    if (e.key !== PENDING) return;
    showToast();
    if (ready) send({ type: 'init', pending: read(PENDING), worker: worker });
  });
  window.addEventListener('pagehide', function () { if (worker) store(BEAT, null); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && !overlay.hidden) close(); });
  if (root) {
    document.addEventListener('change', function () { send({ type: 'init', variant: variant() }); });
    root.querySelector('[data-tt-open]').addEventListener('click', open);
    if (location.hash === '#tt-open') {
      history.replaceState(null, '', location.pathname + location.search);
      open();
    }
  }
  elect();
  setInterval(elect, 4000);
})();
