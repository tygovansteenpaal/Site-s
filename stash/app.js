(() => {
  'use strict';

  const D = window.STASH;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = n => `<i data-lucide="${n}"></i>`;
  const paint = () => window.lucide && window.lucide.createIcons();
  const game = id => D.games.find(g => g.id === id);
  const cat = id => D.categories.find(c => c.id === id);
  const offer = id => D.listings.find(l => l.id === id);
  const view = $('#view');

  const money = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: D.store.currency });
  function price(v) {
    // Unit prices below a cent need more precision.
    if (v < 0.1) return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: D.store.currency, maximumFractionDigits: 4 }).format(v);
    return money.format(v);
  }
  const lineTotal = (o, q) => Math.round(o.price * q * 100) / 100;
  const defaultQty = o => o.unit ? o.min : 1;

  // ==========================================================================
  // Cart (localStorage, guarded)
  // ==========================================================================
  const CART_KEY = 'stash.cart';
  let cart = [];
  try { cart = JSON.parse(localStorage.getItem(CART_KEY) || '[]').filter(l => offer(l.id)); } catch { cart = []; }
  function saveCart() {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* storage blocked */ }
    const n = cart.length;
    $('#cartCount').textContent = n || '';
  }
  function addToCart(id, qty) {
    const o = offer(id);
    const q = clampQty(o, qty);
    const existing = cart.find(l => l.id === id);
    if (existing) existing.qty = o.unit ? clampQty(o, existing.qty + q) : 1;
    else cart.push({ id, qty: q });
    saveCart();
    const btn = $('#cartBtn');
    btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
    toast(`Added to cart. <a href="#/cart">View cart</a>`);
  }
  function clampQty(o, q) {
    if (!o.unit) return 1;
    q = Math.round(+q / o.step) * o.step || o.min;
    return Math.max(o.min, Math.min(o.max, q));
  }

  let toastT;
  function toast(html) {
    const t = $('#toast');
    t.innerHTML = html;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 3200);
  }

  // ==========================================================================
  // Shared pieces
  // ==========================================================================
  function gtag(g) {
    return `<span class="gtag" style="background:${g.color}">${esc(g.short)}</span>`;
  }

  function cover(o, big = true) {
    const g = game(o.game);
    return `<div class="cover" style="background:${g.color}">
      <span class="lines"></span>
      ${big ? `<span class="big">${esc(g.short)}</span>` : ''}
      <span class="tag">${esc(cat(o.cat).name)}</span>
      <span class="game">${esc(g.name)}</span>
    </div>`;
  }

  function card(o) {
    return `<a class="card" href="#/o/${o.id}">
      ${cover(o)}
      <div class="card-body">
        <div class="card-title">${esc(o.title)}</div>
        <div class="card-meta">
          <span class="price">${price(o.price)}${o.unit ? `<small>/ ${esc(o.unit)}</small>` : ''}</span>
          <span class="deliv">${icon('zap')}${esc(o.delivery)}</span>
        </div>
      </div>
    </a>`;
  }

  function renderNav(active) {
    const html = D.categories.map(c => {
      const games = [...new Set(D.listings.filter(l => l.cat === c.id).map(l => l.game))];
      return `<div class="cat-wrap"><a class="cat ${active === c.id ? 'on' : ''}" href="#/c/${c.id}">${esc(c.name)}${icon('chevron-down')}</a>
        <div class="drop">${games.map(gid => {
          const n = D.listings.filter(l => l.cat === c.id && l.game === gid).length;
          return `<a href="#/c/${c.id}?game=${gid}">${esc(game(gid).name)}<span>${n}</span></a>`;
        }).join('')}<a href="#/c/${c.id}">All ${esc(c.name.toLowerCase())}<span>${D.listings.filter(l => l.cat === c.id).length}</span></a></div></div>`;
    }).join('') + `<a class="cat ${active === 'faq' ? 'on' : ''}" href="#/faq">How it works</a>`;
    $('#cats').innerHTML = html;
  }

  // ==========================================================================
  // Views
  // ==========================================================================
  function home() {
    const games = D.games.filter(g => D.listings.some(l => l.game === g.id));
    const fast = D.listings.filter(l => /instant|min/i.test(l.delivery)).slice(0, 8);
    const tickerItems = D.listings.slice(0, 8).map(l => `<span><b>${esc(game(l.game).short)}</b> ${esc(l.title)} / ${price(l.price)}</span>`).join('');
    return `
      <section class="hero"><div class="wrap hero-grid">
        <h1><span class="ln"><i>LEVEL UP</i></span><span class="ln"><i>WITHOUT</i></span><span class="ln"><i>THE GRIND<em>.</em></i></span></h1>
        <div class="hero-side">
          <p>Accounts, coins, items and boosting from one seller. No middlemen, no bots answering your messages. You talk to me, I deliver.</p>
          <div class="hero-actions"><a class="btn primary" href="#/c/accounts">Browse accounts ${icon('arrow-right')}</a><a class="btn" href="#/faq">How it works</a></div>
          <div class="stats">
            <div><span class="label">Listings</span><b>${D.listings.length}</b></div>
            <div><span class="label">Games</span><b>${games.length}</b></div>
            <div><span class="label">Sellers</span><b>1</b></div>
          </div>
        </div>
      </div></section>
      <div class="ticker"><div class="ticker-track">${tickerItems}${tickerItems}</div></div>

      <section class="wrap section">
        <div class="section-head"><h2><small>01</small>Shop by category</h2></div>
        <div class="panels">${D.categories.map(c => {
          const gs = [...new Set(D.listings.filter(l => l.cat === c.id).map(l => l.game))];
          return `<div class="panel"><h3><a href="#/c/${c.id}">${esc(c.name)}</a><span class="label">${D.listings.filter(l => l.cat === c.id).length}</span></h3><p>${esc(c.blurb)}</p>
            <ul>${gs.map(gid => `<li><a href="#/c/${c.id}?game=${gid}">${gtag(game(gid))}${esc(game(gid).name)}</a></li>`).join('')}</ul></div>`;
        }).join('')}
          <div class="panel"><h3><a href="#/faq">Questions</a></h3><p>How paying, delivery and warranty work.</p><ul><li><a href="#/faq">${icon('circle-help')}Read the FAQ</a></li><li><a href="mailto:${esc(D.store.contact)}">${icon('mail')}Email me</a></li></ul></div>
        </div>
      </section>

      <section class="wrap section">
        <div class="section-head"><h2><small>02</small>Fast delivery</h2><a href="#/c/accounts">See all</a></div>
        <div class="grid">${fast.map(card).join('')}</div>
      </section>

      <section class="wrap section">
        <div class="section-head"><h2><small>03</small>How it works</h2></div>
        <ol class="steps">
          <li><b>Pick your offer</b><span>Add what you want to your cart. Quantities for coins and boosts.</span></li>
          <li><b>Send the request</b><span>Fill in your details. Your order request lands in my inbox.</span></li>
          <li><b>Pay</b><span>I confirm stock and send payment details for the method you chose.</span></li>
          <li><b>Get it delivered</b><span>Delivery starts right after payment. Warranty starts on delivery.</span></li>
        </ol>
        <div class="trust">
          <div>${icon('shield-check')}<h3>Warranty on accounts</h3><p>Lose access inside the warranty window and you get a replacement or a refund.</p></div>
          <div>${icon('user-round')}<h3>One seller</h3><p>Every order goes through me. Same person from first message to delivery.</p></div>
          <div>${icon('clock')}<h3>Honest delivery times</h3><p>The time on each listing is what it actually takes, measured on past orders.</p></div>
        </div>
      </section>`;
  }

  function listing(catId, params) {
    const c = cat(catId);
    if (!c) return notFound();
    const all = D.listings.filter(l => l.cat === catId);
    const games = [...new Set(all.map(l => l.game))];
    const sel = (params.get('game') || '').split(',').filter(Boolean);
    const fast = params.get('fast') === '1';
    const min = parseFloat(params.get('min')) || 0;
    const max = parseFloat(params.get('max')) || Infinity;
    const sort = params.get('sort') || 'popular';
    let list = all.filter(l => (!sel.length || sel.includes(l.game)) && (!fast || /instant|min/i.test(l.delivery)) && l.price >= min && l.price <= max);
    if (sort === 'low') list.sort((a, b) => a.price - b.price);
    if (sort === 'high') list.sort((a, b) => b.price - a.price);

    const chips = [
      ...sel.map(g => `<a class="chip" href="${link(catId, params, { game: sel.filter(x => x !== g).join(',') })}">${esc(game(g).name)}${icon('x')}</a>`),
      fast ? `<a class="chip" href="${link(catId, params, { fast: '' })}">Fast delivery${icon('x')}</a>` : '',
      params.get('min') || params.get('max') ? `<a class="chip" href="${link(catId, params, { min: '', max: '' })}">Price${icon('x')}</a>` : '',
    ].join('');

    return `<div class="wrap">
      <div class="crumbs"><a href="#/">Stash</a>/<span>${esc(c.name)}</span>${sel.length === 1 ? `/<span>${esc(game(sel[0]).name)}</span>` : ''}</div>
      <div class="page-head"><div><h1>${sel.length === 1 ? esc(game(sel[0]).name) + ' ' : ''}${esc(c.name)}</h1><p>${esc(c.blurb)}</p></div>
        <button class="btn filter-toggle" data-act="filters">${icon('sliders-horizontal')}Filters</button></div>
      <div class="listing">
        <aside class="filters" id="filters">
          <div class="filter"><span class="label">Game</span>${games.map(g => `<label class="chk"><input type="checkbox" data-filter="game" value="${g}" ${sel.includes(g) ? 'checked' : ''}>${esc(game(g).name)}<span class="n">${all.filter(l => l.game === g).length}</span></label>`).join('')}</div>
          <div class="filter"><span class="label">Delivery</span><label class="chk"><input type="checkbox" data-filter="fast" ${fast ? 'checked' : ''}>Instant or within the hour</label></div>
          <div class="filter"><span class="label">Price (${D.store.currency})</span><div class="range"><input type="number" min="0" placeholder="Min" data-filter="min" value="${params.get('min') || ''}"><input type="number" min="0" placeholder="Max" data-filter="max" value="${params.get('max') || ''}"></div></div>
        </aside>
        <section>
          <div class="toolbar"><span class="label"><b>${list.length}</b> ${list.length === 1 ? 'offer' : 'offers'}</span>
            <select class="select" data-filter="sort">
              <option value="popular" ${sort === 'popular' ? 'selected' : ''}>Recommended</option>
              <option value="low" ${sort === 'low' ? 'selected' : ''}>Price: low to high</option>
              <option value="high" ${sort === 'high' ? 'selected' : ''}>Price: high to low</option>
            </select></div>
          ${chips ? `<div class="chips">${chips}</div>` : ''}
          ${list.length ? `<div class="grid">${list.map(card).join('')}</div>` : `<div class="none"><h3>NOTHING HERE</h3><p>No offers match these filters.</p></div>`}
        </section>
      </div>
    </div>`;
  }

  function link(catId, params, changes) {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) v ? p.set(k, v) : p.delete(k);
    const q = p.toString();
    return `#/c/${catId}${q ? '?' + q : ''}`;
  }

  function offerPage(id) {
    const o = offer(id);
    if (!o) return notFound();
    const g = game(o.game), c = cat(o.cat);
    const related = D.listings.filter(l => l.id !== o.id && (l.game === o.game || l.cat === o.cat)).slice(0, 4);
    const q = defaultQty(o);
    return `<div class="wrap">
      <div class="crumbs"><a href="#/">Stash</a>/<a href="#/c/${c.id}">${esc(c.name)}</a>/<a href="#/c/${c.id}?game=${g.id}">${esc(g.name)}</a></div>
      <div class="offer">
        <div>
          ${cover(o)}
          <h1>${esc(o.title)}</h1>
          <p class="desc">${esc(o.desc)}</p>
          <dl class="attrs">${Object.entries(o.attrs).map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        </div>
        <aside class="buy" data-id="${o.id}">
          <div><span class="label">${o.unit ? 'Price per ' + esc(o.unit) : 'Price'}</span><div class="price">${price(o.price)}</div></div>
          ${o.unit ? `<div><span class="label">Quantity (${esc(o.unit)})</span>
            <div class="qty" style="margin-top:8px"><button data-act="dec" aria-label="Less">${icon('minus')}</button><input id="qty" type="number" value="${q}" min="${o.min}" max="${o.max}" step="${o.step}"><button data-act="inc" aria-label="More">${icon('plus')}</button></div>
            <div class="unit" style="margin-top:8px">Min ${o.min} / max ${o.max}. Total <b id="qtyTotal">${price(lineTotal(o, q))}</b></div></div>` : ''}
          <button class="btn primary full" data-act="buy">${icon('zap')}Buy now</button>
          <button class="btn full" data-act="add">${icon('shopping-bag')}Add to cart</button>
          <div class="facts">
            <div><span class="label">Delivery</span><b>${esc(o.delivery)}</b></div>
            <div><span class="label">Warranty</span><b>${esc(o.warranty)}</b></div>
            <div><span class="label">Game</span><b>${esc(g.name)}</b></div>
            <div><span class="label">Category</span><b>${esc(c.name)}</b></div>
          </div>
          <div class="seller"><span class="av">TS</span><div><b>${esc(D.store.owner)}</b><span>Sole seller / replies by email</span></div></div>
        </aside>
      </div>
      ${related.length ? `<section class="section"><div class="section-head"><h2>More like this</h2></div><div class="grid">${related.map(card).join('')}</div></section>` : ''}
    </div>`;
  }

  function cartPage() {
    if (!cart.length) {
      return `<div class="wrap"><div class="done"><span class="label">Cart</span><h1>EMPTY<span style="color:var(--accent)">.</span></h1><p>Nothing in here yet.</p><div class="actions"><a class="btn primary" href="#/">Start shopping</a></div></div></div>`;
    }
    const total = cart.reduce((s, l) => s + lineTotal(offer(l.id), l.qty), 0);
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('stash.buyer') || '{}'); } catch { saved = {}; }
    return `<div class="wrap">
      <div class="crumbs"><a href="#/">Stash</a>/<span>Cart</span></div>
      <div class="page-head"><div><h1>Your cart</h1><p>${cart.length} ${cart.length === 1 ? 'item' : 'items'}</p></div></div>
      <div class="cart">
        <div class="cart-list">${cart.map(l => {
          const o = offer(l.id), g = game(o.game);
          return `<div class="line" data-id="${o.id}">
            <a href="#/o/${o.id}" class="thumb" style="background:${g.color}">${esc(g.short)}</a>
            <div><a class="t" href="#/o/${o.id}">${esc(o.title)}</a><div class="s">${esc(g.name)} / ${esc(cat(o.cat).name)} / ${esc(o.delivery)}</div></div>
            <div class="line-wrap">
              ${o.unit ? `<div class="qty"><button data-act="ldec">${icon('minus')}</button><input type="number" value="${l.qty}" data-act="lqty" min="${o.min}" max="${o.max}" step="${o.step}"><button data-act="linc">${icon('plus')}</button></div>` : '<span></span>'}
              <span class="lp">${price(lineTotal(o, l.qty))}</span>
            </div>
            <button class="rm" data-act="rm" title="Remove">${icon('x')}</button>
          </div>`;
        }).join('')}</div>
        <form class="checkout" id="checkout" novalidate>
          <h2>Order request</h2>
          <div class="sum"><span>Subtotal</span><span>${price(total)}</span></div>
          <div class="sum"><span>Fees</span><span>${price(0)}</span></div>
          <div class="sum total"><span>Total</span><b>${price(total)}</b></div>
          <label class="field"><span class="label">Name</span><input name="name" required value="${esc(saved.name || '')}" autocomplete="name"><span class="msg">Fill in your name.</span></label>
          <label class="field"><span class="label">Email</span><input name="email" type="email" required value="${esc(saved.email || '')}" autocomplete="email"><span class="msg">Enter a valid email address.</span></label>
          <label class="field"><span class="label">Discord or in-game name (optional)</span><input name="handle" value="${esc(saved.handle || '')}"></label>
          <label class="field"><span class="label">Payment method</span><select name="pay">${D.store.payment.map(p => `<option ${saved.pay === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select></label>
          <label class="field"><span class="label">Notes (optional)</span><textarea name="notes" placeholder="Platform, region, anything I should know"></textarea></label>
          <label class="consent"><input type="checkbox" name="ok" required><span>I understand that some games do not allow trading, and I buy at my own risk.</span></label>
          <button class="btn primary full" style="margin-top:18px" type="submit">${icon('send')}Send order request</button>
          <p class="fine">No payment is taken here. I reply by email with payment details after confirming stock.</p>
        </form>
      </div>
    </div>`;
  }

  function donePage(code) {
    let order = null;
    try { order = JSON.parse(sessionStorage.getItem('stash.order.' + code) || 'null'); } catch { order = null; }
    const mail = order ? mailto(order) : `mailto:${D.store.contact}`;
    return `<div class="wrap"><div class="done">
      <span class="label">Order request ready</span>
      <h1>ALMOST<br>THERE<span style="color:var(--accent)">.</span></h1>
      <p>Your email app should have opened with the order filled in. Hit send and I will reply with payment details.</p>
      <p>Your order code:</p>
      <span class="code">${esc(code)}</span>
      <div class="actions">
        <a class="btn primary" href="${esc(mail)}">${icon('mail')}Open email again</a>
        ${order ? `<button class="btn" data-act="copy-order" data-code="${esc(code)}">${icon('copy')}Copy order text</button>` : ''}
        <a class="btn" href="#/">Back to shop</a>
      </div>
      <p class="fine" style="margin-top:24px">Email not opening? Send the order text to ${esc(D.store.contact)}.</p>
    </div></div>`;
  }

  function faqPage() {
    return `<div class="wrap">
      <div class="crumbs"><a href="#/">Stash</a>/<span>How it works</span></div>
      <div class="page-head"><div><h1>How it works</h1><p>Short answers to the questions everyone asks.</p></div></div>
      <section class="section" style="padding-top:24px"><div class="faq">${D.faq.map(([q, a], i) => `<details ${i === 0 ? 'open' : ''}><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div></section>
    </div>`;
  }

  function notFound() {
    return `<div class="wrap"><div class="done"><span class="label">404</span><h1>NOT IN<br>STOCK<span style="color:var(--accent)">.</span></h1><p>This page does not exist, or the offer was sold.</p><div class="actions"><a class="btn primary" href="#/">Back to shop</a></div></div></div>`;
  }

  // ==========================================================================
  // Orders
  // ==========================================================================
  function orderText(order) {
    const lines = order.items.map(i => `- ${i.title} (${i.game})${i.unit ? ` x ${i.qty} ${i.unit}` : ''}: ${price(i.total)}`);
    return [
      `Order ${order.code}`,
      '',
      ...lines,
      '',
      `Total: ${price(order.total)}`,
      `Payment: ${order.pay}`,
      '',
      `Name: ${order.name}`,
      `Email: ${order.email}`,
      order.handle ? `Discord / in-game: ${order.handle}` : null,
      order.notes ? `Notes: ${order.notes}` : null,
    ].filter(l => l !== null).join('\n');
  }
  function mailto(order) {
    return `mailto:${D.store.contact}?subject=${encodeURIComponent(`Stash order ${order.code}`)}&body=${encodeURIComponent(orderText(order))}`;
  }

  function submitOrder(form) {
    let ok = true;
    for (const f of ['name', 'email']) {
      const input = form[f];
      const valid = input.value.trim() && (f !== 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.value.trim()));
      input.closest('.field').classList.toggle('err', !valid);
      if (!valid) ok = false;
    }
    if (!form.ok.checked) { form.ok.closest('.consent').style.color = 'var(--accent)'; ok = false; }
    if (!ok) return;
    const code = 'ST-' + Date.now().toString(36).toUpperCase().slice(-5) + Math.random().toString(36).slice(2, 4).toUpperCase();
    const items = cart.map(l => {
      const o = offer(l.id);
      return { id: o.id, title: o.title, game: game(o.game).name, qty: l.qty, unit: o.unit, total: lineTotal(o, l.qty) };
    });
    const order = {
      code, items, total: items.reduce((s, i) => s + i.total, 0),
      name: form.name.value.trim(), email: form.email.value.trim(), handle: form.handle.value.trim(),
      pay: form.pay.value, notes: form.notes.value.trim(),
    };
    try {
      localStorage.setItem('stash.buyer', JSON.stringify({ name: order.name, email: order.email, handle: order.handle, pay: order.pay }));
      sessionStorage.setItem('stash.order.' + code, JSON.stringify(order));
    } catch { /* storage blocked */ }
    cart = [];
    saveCart();
    location.hash = '#/done/' + code;
    window.location.href = mailto(order);
  }

  // ==========================================================================
  // Search
  // ==========================================================================
  const sInput = $('#searchInput'), suggest = $('#suggest');
  let sIndex = -1;
  function runSearch() {
    const q = sInput.value.trim().toLowerCase();
    if (!q) { suggest.hidden = true; return; }
    const games = D.games.filter(g => g.name.toLowerCase().includes(q) && D.listings.some(l => l.game === g.id));
    const offers = D.listings.filter(l => `${l.title} ${game(l.game).name} ${cat(l.cat).name}`.toLowerCase().includes(q)).slice(0, 7);
    let html = '';
    if (games.length) html += `<span class="label">Games</span>` + games.map(g => `<a href="#/c/${D.listings.find(l => l.game === g.id).cat}?game=${g.id}">${gtag(g)}${esc(g.name)}</a>`).join('');
    if (offers.length) html += `<span class="label">Offers</span>` + offers.map(o => `<a href="#/o/${o.id}">${gtag(game(o.game))}${esc(o.title)}<span class="price">${price(o.price)}</span></a>`).join('');
    suggest.innerHTML = html || `<span class="label">No results for "${esc(q)}"</span>`;
    suggest.hidden = false;
    sIndex = -1;
  }
  sInput.addEventListener('input', runSearch);
  sInput.addEventListener('focus', runSearch);
  sInput.addEventListener('keydown', e => {
    const items = $$('a', suggest);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      sIndex = (sIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((a, i) => a.classList.toggle('on', i === sIndex));
    }
    if (e.key === 'Enter') {
      const a = items[sIndex] || items.find(x => x.getAttribute('href').startsWith('#/o/')) || items[0];
      if (a) { location.hash = a.getAttribute('href'); sInput.blur(); }
    }
    if (e.key === 'Escape') { suggest.hidden = true; sInput.blur(); }
  });
  document.addEventListener('click', e => { if (!e.target.closest('#search')) suggest.hidden = true; });
  suggest.addEventListener('click', e => { if (e.target.closest('a')) { suggest.hidden = true; sInput.value = ''; } });

  // ==========================================================================
  // Events
  // ==========================================================================
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'filters') { $('#filters').classList.toggle('open'); return; }

    const buy = b.closest('.buy');
    if (buy) {
      const o = offer(buy.dataset.id);
      const input = $('#qty');
      if (act === 'inc' || act === 'dec') {
        input.value = clampQty(o, +input.value + (act === 'inc' ? o.step : -o.step));
        $('#qtyTotal').textContent = price(lineTotal(o, +input.value));
      }
      if (act === 'add') addToCart(o.id, input ? +input.value : 1);
      if (act === 'buy') { addToCart(o.id, input ? +input.value : 1); location.hash = '#/cart'; }
      return;
    }

    const line = b.closest('.line');
    if (line) {
      const item = cart.find(l => l.id === line.dataset.id);
      const o = offer(item.id);
      if (act === 'rm') cart = cart.filter(l => l !== item);
      if (act === 'linc') item.qty = clampQty(o, item.qty + o.step);
      if (act === 'ldec') item.qty = clampQty(o, item.qty - o.step);
      saveCart();
      route();
      return;
    }

    if (act === 'copy-order') {
      try {
        const order = JSON.parse(sessionStorage.getItem('stash.order.' + b.dataset.code));
        navigator.clipboard.writeText(orderText(order)).then(() => toast('Order text copied.'));
      } catch { toast('Could not copy. Select the text manually.'); }
    }
  });

  document.addEventListener('change', e => {
    const el = e.target;
    if (el.id === 'qty') {
      const o = offer(el.closest('.buy').dataset.id);
      el.value = clampQty(o, el.value);
      $('#qtyTotal').textContent = price(lineTotal(o, +el.value));
    }
    if (el.dataset.act === 'lqty') {
      const item = cart.find(l => l.id === el.closest('.line').dataset.id);
      item.qty = clampQty(offer(item.id), el.value);
      saveCart();
      route();
    }
    if (el.dataset.filter) {
      const [, path, query] = location.hash.match(/^#\/c\/([^?]+)\??(.*)$/) || [];
      if (!path) return;
      const p = new URLSearchParams(query);
      const f = el.dataset.filter;
      if (f === 'game') {
        const vals = $$('[data-filter="game"]:checked').map(x => x.value);
        vals.length ? p.set('game', vals.join(',')) : p.delete('game');
      } else if (f === 'fast') {
        el.checked ? p.set('fast', '1') : p.delete('fast');
      } else {
        el.value ? p.set(f, el.value) : p.delete(f);
      }
      const q = p.toString();
      history.replaceState(null, '', `#/c/${path}${q ? '?' + q : ''}`);
      route({ keepScroll: true });
    }
  });

  document.addEventListener('submit', e => {
    if (e.target.id === 'checkout') { e.preventDefault(); submitOrder(e.target); }
  });
  document.addEventListener('input', e => {
    const f = e.target.closest('.field.err');
    if (f) f.classList.remove('err');
  });

  // ==========================================================================
  // Router
  // ==========================================================================
  function route({ keepScroll = false } = {}) {
    const hash = location.hash || '#/';
    const [path, query = ''] = hash.slice(1).split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query);
    let html, active = '', title = 'Stash';
    if (!parts.length) { html = home(); }
    else if (parts[0] === 'c') { html = listing(parts[1], params); active = parts[1]; title = `${cat(parts[1])?.name || 'Shop'} / Stash`; }
    else if (parts[0] === 'o') { html = offerPage(parts[1]); const o = offer(parts[1]); active = o?.cat; title = o ? `${o.title} / Stash` : 'Stash'; }
    else if (parts[0] === 'cart') { html = cartPage(); title = 'Cart / Stash'; }
    else if (parts[0] === 'done') { html = donePage(parts[1] || ''); title = 'Order / Stash'; }
    else if (parts[0] === 'faq') { html = faqPage(); active = 'faq'; title = 'How it works / Stash'; }
    else html = notFound();
    const y = scrollY;
    view.innerHTML = html;
    renderNav(active);
    document.title = title;
    paint();
    scrollTo(0, keepScroll ? y : 0);
  }

  // ==========================================================================
  // Boot
  // ==========================================================================
  $('#ribbon').hidden = !D.store.sampleStock;
  $('#footMail').href = `mailto:${D.store.contact}`;
  $('#footCats').innerHTML = D.categories.map(c => `<a href="#/c/${c.id}">${esc(c.name)}</a>`).join('');
  saveCart();
  addEventListener('hashchange', () => route());
  route();
})();
