/* The "Recently launched" list, and the fee wording that comes from the server's own settings. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }

  function card(c) {
    const d = document.createElement('div');
    d.className = 'coin';
    // Only pictures from this site are shown.
    const page = '/coin/' + encodeURIComponent(c.pool);
    const pic = document.createElement('a');
    pic.href = page; pic.setAttribute('aria-label', 'Open ' + c.name); pic.style.display = 'block';
    if (typeof c.imageUrl === 'string' && /^\/art\/[0-9a-f]{16}\.(png|jpg)$/.test(c.imageUrl)) {
      const im = document.createElement('img');
      im.src = c.imageUrl; im.alt = c.name + ' logo'; im.width = 160; im.height = 160; im.loading = 'lazy';
      pic.appendChild(im);
    } else {
      const n = document.createElement('div');
      n.className = 'noimg'; n.textContent = (c.name || '?').charAt(0).toUpperCase();
      pic.appendChild(n);
    }
    d.appendChild(pic);
    const top = document.createElement('div');
    top.className = 'top2';
    const name = document.createElement('strong');
    const nl = document.createElement('a'); nl.href = page; nl.textContent = c.name; nl.style.color = 'inherit'; nl.style.textDecoration = 'none';
    name.appendChild(nl);
    const sym = document.createElement('span'); sym.className = 'sym'; sym.textContent = '$' + c.symbol;
    top.appendChild(name); top.appendChild(sym);
    d.appendChild(top);

    const bar = document.createElement('div'); bar.className = 'tbar'; bar.setAttribute('role', 'img');
    const pct = Math.round(Math.max(0, Math.min(1, Number(c.progress) || 0)) * 100);
    bar.setAttribute('aria-label', 'Curve ' + pct + '% full');
    const fill = document.createElement('i'); fill.style.width = pct + '%'; bar.appendChild(fill);
    d.appendChild(bar);

    const meta = document.createElement('div'); meta.className = 'meta';
    meta.textContent = c.migrated ? 'Moved to its trading pool' : c.curveFull ? 'Curve full' : pct + '% full · ' + Number(c.raisedSol).toFixed(2) + ' SOL';
    d.appendChild(meta);
    const when = document.createElement('div'); when.className = 'meta'; when.textContent = ago(Number(c.createdAt));
    d.appendChild(when);

    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn'; b.textContent = 'Trade';
    b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('animalpad:open-pool', { detail: { pool: c.pool } })));
    d.appendChild(b);
    return d;
  }

  const SVGNS = 'http://www.w3.org/2000/svg';
  let thresholdSol = null;

  function el(name, attrs, parent) {
    const n = document.createElementNS(SVGNS, name);
    Object.keys(attrs || {}).forEach(k => n.setAttribute(k, attrs[k]));
    if (parent) parent.appendChild(n);
    return n;
  }

  // The recent coins, placed on the bonding curve by how far along each one is.
  function drawCurve(list) {
    const box = $('curvebox'), svg = $('curve');
    if (!list.length) { box.hidden = true; return; }
    box.hidden = false;
    Array.from(svg.querySelectorAll(':scope > :not(title)')).forEach(n => n.remove());
    const L = 46, R = 22, T = 34, B = 34, W = 640, H = 280;
    const X = p => L + p * (W - L - R);
    const Y = p => H - B - Math.pow(p, 1.8) * (H - B - T);
    for (let i = 0; i <= 4; i++) {
      const p = i / 4;
      el('line', { class: 'grid', x1: X(p), x2: X(p), y1: T - 10, y2: H - B }, svg);
      const t = el('text', { class: 'axis', x: X(p), y: H - B + 18, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, svg);
      t.textContent = Number.isFinite(thresholdSol) ? (Math.round(p * thresholdSol * 100) / 100) + ' SOL' : Math.round(p * 100) + '%';
    }
    const ylab = el('text', { class: 'axis', x: 4, y: T - 14 }, svg); ylab.textContent = 'Price';
    let d = '', a = '';
    for (let i = 0; i <= 60; i++) { const p = i / 60; d += (i ? 'L' : 'M') + X(p).toFixed(1) + ' ' + Y(p).toFixed(1); }
    a = d + 'L' + X(1) + ' ' + (H - B) + 'L' + X(0) + ' ' + (H - B) + 'Z';
    el('path', { class: 'area', d: a }, svg);
    el('path', { class: 'line', d: d }, svg);
    el('circle', { class: 'goal', cx: X(1), cy: Y(1), r: 6 }, svg);
    const g = el('text', { class: 'goal-t', x: X(1) - 26, y: Y(1) - 14, 'text-anchor': 'end' }, svg);
    g.textContent = 'Curve full: moves to a trading pool';

    // Nearby coins get nudged upward so they do not sit on top of each other.
    const coins = list.slice(0, 14).map(c => ({ c, p: Math.max(0, Math.min(1, Number(c.progress) || 0)) })).sort((x, y) => x.p - y.p);
    const placed = [];
    coins.forEach(({ c, p }) => {
      const cx = X(p);
      let cy = Y(p) - 18;
      let tries = 0;
      while (placed.some(q => Math.hypot(q.x - cx, q.y - cy) < 30) && tries++ < 12) cy -= 16;
      placed.push({ x: cx, y: cy });
      const pct = Math.round(p * 100);
      const g2 = el('g', { class: 'pin', tabindex: '0', role: 'button', 'aria-label': c.name + ', ' + pct + '% full. Open its page.' }, svg);
      el('title', {}, g2).textContent = c.name + ' $' + c.symbol + ' · ' + pct + '% full';
      el('circle', { class: 'ring', cx: cx, cy: cy, r: 15 }, g2);
      if (typeof c.imageUrl === 'string' && /^\/art\/[0-9a-f]{16}\.(png|jpg)$/.test(c.imageUrl)) {
        const id = 'clip' + placed.length;
        const cp = el('clipPath', { id: id }, g2);
        el('circle', { cx: cx, cy: cy, r: 12 }, cp);
        el('image', { href: c.imageUrl, x: cx - 12, y: cy - 12, width: 24, height: 24, 'clip-path': 'url(#' + id + ')', preserveAspectRatio: 'xMidYMid slice' }, g2);
      } else {
        el('text', {x: cx, y: cy}, g2).textContent = (c.name || '?').charAt(0).toUpperCase();
      }
      const open = () => { location.href = '/coin/' + encodeURIComponent(c.pool); };
      g2.addEventListener('click', open);
      g2.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  let lastList = [];

  async function load() {
    try {
      const res = await fetch('/api/launches', { cache: 'no-store', headers: { Accept: 'application/json' } });
      const body = await res.json();
      const list = Array.isArray(body && body.launches) ? body.launches : [];
      const box = $('feed');
      box.textContent = '';
      list.forEach(c => box.appendChild(card(c)));
      lastList = list;
      drawCurve(list);
      $('feed-note').textContent = list.length ? '' : 'No launches yet. Draw an animal above and be the first.';
    } catch (err) {
      $('feed-note').textContent = 'Could not load the latest launches. Try again in a moment.';
    }
  }

  // New launches appear after the page launches one, and the list quietly refreshes while the tab is open.
  document.addEventListener('animalpad:launched', () => [3000, 8000, 16000, 30000, 60000].forEach(ms => setTimeout(load, ms)));
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  load();

  // Fee wording straight from the server's presets, so it can never disagree with what is deployed.
  fetch('/api/launch/config', { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(info => {
      const t = info && info.terms && info.terms.standard;
      if (!t || !Number.isFinite(t.totalPct) || !Number.isFinite(t.creatorSharePct)) return;
      let text = 'Every trade on the curve pays a ' + t.totalPct + '% fee, and the creator earns ' + t.creatorSharePct + '% of it. Claim it with the wallet that launched the token.';
      if (Number.isFinite(info.thresholdSol)) { thresholdSol = info.thresholdSol; drawCurve(lastList); }
      if (Number.isFinite(info.thresholdSol)) text += ' On this test version the curve fills at ' + info.thresholdSol + ' SOL.';
      $('fee-note-how').textContent = text;
    })
    .catch(() => { /* the generic sentence stays */ });
})();
