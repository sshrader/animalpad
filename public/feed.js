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
    if (typeof c.imageUrl === 'string' && /^\/art\/[0-9a-f]{16}\.(png|jpg)$/.test(c.imageUrl)) {
      const im = document.createElement('img');
      im.src = c.imageUrl; im.alt = c.name + ' logo'; im.width = 160; im.height = 160; im.loading = 'lazy';
      d.appendChild(im);
    } else {
      const n = document.createElement('div');
      n.className = 'noimg'; n.textContent = (c.name || '?').charAt(0).toUpperCase();
      d.appendChild(n);
    }
    const top = document.createElement('div');
    top.className = 'top2';
    const name = document.createElement('strong'); name.textContent = c.name;
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

  async function load() {
    try {
      const res = await fetch('/api/launches', { headers: { Accept: 'application/json' } });
      const body = await res.json();
      const list = Array.isArray(body && body.launches) ? body.launches : [];
      const box = $('feed');
      box.textContent = '';
      list.forEach(c => box.appendChild(card(c)));
      $('feed-note').textContent = list.length ? '' : 'No launches yet. Draw an animal above and be the first.';
    } catch (err) {
      $('feed-note').textContent = 'Could not load the latest launches. Try again in a moment.';
    }
  }

  // New launches appear after the page launches one, and the list quietly refreshes while the tab is open.
  document.addEventListener('animalpad:launched', () => setTimeout(load, 4000));
  setInterval(() => { if (!document.hidden) load(); }, 60000);
  load();

  // Fee wording straight from the server's presets, so it can never disagree with what is deployed.
  fetch('/api/launch/config', { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(info => {
      const t = info && info.terms && info.terms.standard;
      if (!t || !Number.isFinite(t.totalPct) || !Number.isFinite(t.creatorSharePct)) return;
      let text = 'Every trade on the curve pays a ' + t.totalPct + '% fee, and the creator earns ' + t.creatorSharePct + '% of it. Claim it with the wallet that launched the token.';
      if (Number.isFinite(info.thresholdSol)) text += ' On this test version the curve fills at ' + info.thresholdSol + ' SOL.';
      $('fee-note-how').textContent = text;
    })
    .catch(() => { /* the generic sentence stays */ });
})();
