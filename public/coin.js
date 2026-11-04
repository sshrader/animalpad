/* One coin's page: its picture, description, links, how full its curve is, and where to trade it. */
(function () {
  'use strict';

  // Light or dark, remembered from the main page.
  const root = document.documentElement;
  const themeBtn = document.getElementById('theme');
  function syncTheme() {
    const light = root.dataset.theme === 'light';
    themeBtn.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
    themeBtn.setAttribute('aria-pressed', light ? 'true' : 'false');
  }
  themeBtn.addEventListener('click', () => {
    const light = root.dataset.theme !== 'light';
    if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
    try { localStorage.setItem('animalpad-theme', light ? 'light' : 'dark'); } catch (e) { /* still works */ }
    syncTheme();
  });
  syncTheme();

  const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const pool = (location.pathname.split('/')[2] || '');
  const box = document.getElementById('cp');

  function add(parent, tag, text, cls) {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    parent.appendChild(n);
    return n;
  }

  function safeUrl(u) {
    try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (e) { return ''; }
  }

  function link(parent, href, text) {
    const a = add(parent, 'a', text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
    return a;
  }

  function when(ms) {
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  }

  function render(c) {
    document.title = c.name + ' · AnimalPad';
    box.textContent = '';
    const grid = add(box, 'div', undefined, 'coinpage');

    if (/^\/art\/[0-9a-f]{16}\.(png|jpg)$/.test(c.imageUrl || '')) {
      const im = add(grid, 'img', undefined, 'pic');
      im.src = c.imageUrl; im.alt = c.name + ' logo'; im.width = 320; im.height = 320;
    } else {
      add(grid, 'div', (c.name || '?').charAt(0).toUpperCase(), 'pic noimg');
    }

    const body = add(grid, 'div', undefined, 'cp-body');
    const h = add(body, 'h1', c.name + ' ');
    add(h, 'span', '$' + c.symbol, 'sym');
    if (c.description) add(body, 'p', c.description, 'cp-desc');

    const pct = Math.round(Math.max(0, Math.min(1, Number(c.progress) || 0)) * 100);
    const bar = add(body, 'div', undefined, 'tbar');
    bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', 'Curve ' + pct + '% full');
    add(bar, 'i').style.width = pct + '%';
    add(body, 'p', c.migrated ? 'This coin has moved to its regular trading pool.'
      : c.curveFull ? 'The curve is full. It is ready to move to a trading pool.'
      : pct + '% full · ' + Number(c.raisedSol).toFixed(3) + ' of ' + Number(c.thresholdSol).toFixed(3) + ' SOL raised', 'hint');

    const links = c.links || {};
    const out = [['website', 'Website'], ['twitter', 'X'], ['telegram', 'Telegram']]
      .map(k => [safeUrl(links[k[0]]), k[1]]).filter(k => k[0]);
    if (out.length) {
      const row = add(body, 'div', undefined, 'cp-links');
      out.forEach(k => link(row, k[0], k[1]));
    }

    const acts = add(body, 'div', undefined, 'cp-actions');
    const t = add(acts, 'a', 'Trade this coin', 'btn go');
    t.href = '/?pool=' + encodeURIComponent(c.pool) + '#trade';

    const f = add(body, 'dl', undefined, 'facts');
    function fact(label, node) { add(f, 'dt', label); const dd = add(f, 'dd'); if (typeof node === 'string') dd.textContent = node; else dd.appendChild(node); }
    fact('Launched', when(c.createdAt));
    const ex = a => 'https://explorer.solana.com/address/' + encodeURIComponent(a) + '?cluster=devnet';
    [['Token address', c.mint], ['Pool address', c.pool], ['Creator wallet', c.creator]].forEach(x => {
      if (!B58.test(x[1] || '')) return;
      const s = document.createElement('span');
      link(s, ex(x[1]), x[1]);
      fact(x[0], s);
    });
  }

  function problem(text) {
    box.textContent = '';
    add(box, 'p', text, 'hint');
  }

  if (!B58.test(pool)) { problem('That is not a valid coin address.'); return; }
  fetch('/api/launches/' + pool, { cache: 'no-store', headers: { Accept: 'application/json' } })
    .then(r => r.json().then(b => ({ status: r.status, body: b })))
    .then(r => {
      if (r.status === 200) render(r.body);
      else if (r.status === 404) problem('No coin found here. It may not be on the chain yet. Try again in a few seconds.');
      else problem('Could not load this coin. Try again in a moment.');
    })
    .catch(() => problem('Could not load this coin. Try again in a moment.'));
})();
