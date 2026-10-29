/*
 * True Tribute — the shop page's side of "Upload your photo"
 * (shopify/true-tribute-try.liquid). Opens the tool's customer page
 * (https://true-b.vercel.app/try) in a window over the product page, and:
 *
 *  - tells it the product and the variant chosen (metal), and passes back a
 *    sign-in kept from last time, so a returning customer skips the code;
 *  - keeps the sign-in it is given, in this site's own storage;
 *  - when the customer picks a design, adds it to the product form as hidden
 *    fields (_tt_design, _tt_phone) and a visible "Design" reference, so the
 *    store's own Add to Cart / Buy Now (and Magic Checkout) carry it to the
 *    order; the phone is also saved on the cart.
 *
 * Messages are only accepted from, and only sent to, the tool's address.
 * Closing the window hides it: a design being made keeps going.
 */
(function () {
  var root = document.querySelector('.tt-try');
  if (!root) return;
  var TOOL = root.getAttribute('data-tool');
  var KEY = 'true-tribute:customer';
  var variants = [];
  try { variants = JSON.parse(root.querySelector('[data-tt-variants]').textContent || '[]'); } catch (e) {}
  var form = document.querySelector('form[action*="/cart/add"]');
  // The store's own product section ("Newproduct") has no room for extra
  // blocks, so the button is rendered in a section of its own and moved to
  // just above Add to Cart / Buy Now; the emptied section is hidden.
  var buttons = form && form.querySelector('.pd-buttons');
  if (buttons) {
    var host = root.closest('.shopify-section');
    buttons.parentNode.insertBefore(root, buttons);
    if (host && !host.contains(root)) host.style.display = 'none';
  }
  var overlay = null;
  var frame = null;

  function session() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function variant() {
    var input = form && form.querySelector('[name="id"]');
    var id = input ? String(input.value) : '';
    for (var i = 0; i < variants.length; i++) if (String(variants[i].id) === id) return { id: id, title: variants[i].title };
    return id ? { id: id, title: '' } : null;
  }
  function send(message) {
    if (!frame || !frame.contentWindow) return;
    message.source = 'true-tribute-shop';
    frame.contentWindow.postMessage(message, TOOL);
  }
  function open() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'tt-try__overlay';
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      frame = document.createElement('iframe');
      frame.className = 'tt-try__frame';
      frame.title = 'See your pendant';
      frame.allow = 'camera';
      frame.src = TOOL + '/try?shop=' + encodeURIComponent(location.hostname);
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
    } else {
      send({ type: 'init', product: { handle: root.getAttribute('data-handle'), title: root.getAttribute('data-title') }, variant: variant(), session: session() });
    }
    overlay.hidden = false;
    document.documentElement.style.overflow = 'hidden';
  }
  function close() {
    if (overlay) overlay.hidden = true;
    document.documentElement.style.overflow = '';
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

  window.addEventListener('message', function (event) {
    if (event.origin !== TOOL || !event.data || event.data.source !== 'true-tribute') return;
    var data = event.data;
    if (data.type === 'ready') {
      send({ type: 'init', product: { handle: root.getAttribute('data-handle'), title: root.getAttribute('data-title') }, variant: variant(), session: session() });
    } else if (data.type === 'session') {
      try {
        if (data.session) localStorage.setItem(KEY, JSON.stringify(data.session));
        else localStorage.removeItem(KEY);
      } catch (e) {}
    } else if (data.type === 'use-design') {
      field('_tt_design', data.job);
      field('_tt_phone', data.phone);
      if (data.ref) field('Design', data.ref);
      // On the cart too, for the order and for checkout.
      fetch('/cart/update.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ attributes: { 'Mobile (design)': data.phone } }) }).catch(function () {});
      var note = root.querySelector('[data-tt-note]');
      note.textContent = '✓ Your design ' + (data.ref || '') + ' is added. Now choose Add to Cart or Buy Now.';
      note.hidden = false;
      close();
      var buy = form && form.querySelector('[type="submit"]');
      if (buy && buy.scrollIntoView) buy.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (data.type === 'close') {
      close();
    }
  });

  if (form) form.addEventListener('change', function () { send({ type: 'init', variant: variant() }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
  root.querySelector('[data-tt-open]').addEventListener('click', open);
})();
