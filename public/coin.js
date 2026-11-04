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

  function render(c, cfg) {
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
    const mood = c.mood && /^[a-z]{3,12}$/.test(c.mood.key) ? c.mood : null;
    if (mood) {
      const m = add(body, 'span', mood.label, 'mood');
      m.dataset.mood = mood.key;
      const pic = grid.querySelector('.pic'); if (pic) pic.dataset.mood = mood.key;
    }
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
      out.forEach(k => {
        link(row, k[0], k[1]);
        if (k[1] === 'Website' && c.siteVerified) add(row, 'span', 'Verified by the creator', 'verified');
      });
    }
    if (c.verifyCode && safeUrl((links.website || ''))) startVerify(body, c, links.website);

    const acts = add(body, 'div', undefined, 'cp-actions');
    const t = add(acts, 'a', 'Trade this coin', 'btn go');
    t.href = '/?pool=' + encodeURIComponent(c.pool) + '#trade';
    const tw = add(acts, 'a', 'Share on X', 'btn');
    tw.href = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(c.name + ' ($' + c.symbol + ') on AnimalPad, a devnet test coin') + '&url=' + encodeURIComponent(location.origin + '/coin/' + c.pool);
    tw.target = '_blank'; tw.rel = 'noopener noreferrer';
    // A Blink: a link that opens a buy for this coin in a Blink-aware viewer, with no need to visit this site.
    const blink = 'https://dial.to/?action=' + encodeURIComponent('solana-action:' + location.origin + '/api/actions/trade/' + c.pool) + '&cluster=devnet';
    const cp = add(acts, 'button', 'Copy buy link', 'btn'); cp.type = 'button';
    cp.addEventListener('click', () => {
      const done = () => { cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy buy link'; }, 2000); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(blink).then(done, () => { cp.textContent = 'Copy failed'; });
      else cp.textContent = 'Copy not available';
    });

    const f = add(body, 'dl', undefined, 'facts');
    function fact(label, node) { add(f, 'dt', label); const dd = add(f, 'dd'); if (typeof node === 'string') dd.textContent = node; else dd.appendChild(node); }
    startChat(box, c);
    const terms = cfg && cfg.terms && cfg.terms.standard;
    if (terms && Number.isFinite(terms.totalPct) && Number.isFinite(terms.creatorSharePct)) {
      fact('Trading fee', terms.totalPct + '% of every trade. The creator earns ' + terms.creatorSharePct + '% of it.');
    }
    if (Number(c.devBuySol) > 0) fact('Creator first buy', 'The creator bought ' + Number(c.devBuySol) + ' SOL worth in the launch transaction, before anyone else could.');
    fact('Launched', when(c.createdAt));
    const ex = a => 'https://explorer.solana.com/address/' + encodeURIComponent(a) + '?cluster=devnet';
    [['Token address', c.mint], ['Pool address', c.pool], ['Creator wallet', c.creator]].forEach(x => {
      if (!B58.test(x[1] || '')) return;
      const s = document.createElement('span');
      link(s, ex(x[1]), x[1]);
      fact(x[0], s);
    });
  }

  // Talk to the mascot. Each reply comes from the server; nothing typed here is ever rendered as HTML.
  function startChat(parent, c) {
    const wrap = add(parent, 'div', undefined, 'chat');
    add(wrap, 'h2', 'Talk to ' + c.name);
    const log = add(wrap, 'div', undefined, 'chat-log');
    log.setAttribute('aria-live', 'polite');
    const row = add(wrap, 'form', undefined, 'chat-row');
    const input = add(row, 'input');
    input.type = 'text'; input.maxLength = 200; input.placeholder = 'Say hi to ' + c.name;
    input.setAttribute('aria-label', 'Message to ' + c.name);
    const send = add(row, 'button', 'Send', 'btn go'); send.type = 'submit';
    add(wrap, 'p', 'An AI cartoon animal. It does not give advice and can say silly things.', 'hint');
    const history = [];
    const say = (text, cls) => { add(log, 'p', text, cls); log.scrollTop = log.scrollHeight; };
    const ERR = { rate_limited: 'Too many messages. Wait a bit and try again.', daily_limit: 'The mascots are resting for today.', art_unavailable: 'Chat is switched off on this site.' };
    row.addEventListener('submit', e => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || send.disabled) return;
      input.value = ''; send.disabled = true;
      say(text, 'me');
      fetch('/api/coin/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool: c.pool, message: text, history: history.slice(-6) }) })
        .then(r => r.json().then(b => ({ ok: r.ok, body: b })))
        .then(r => {
          if (r.ok && r.body && typeof r.body.reply === 'string') {
            say(r.body.reply, 'bot');
            history.push({ role: 'user', content: text }, { role: 'assistant', content: r.body.reply });
          } else say(ERR[r.body && r.body.error] || 'No answer right now. Try again in a moment.', 'bot');
        })
        .catch(() => say('No answer right now. Try again in a moment.', 'bot'))
        .finally(() => { send.disabled = false; input.focus(); });
    });
  }

  // The creator proves the website is theirs by putting this coin's code on it.
  function startVerify(parent, c, website) {
    const d = add(parent, 'details', undefined, 'verify');
    add(d, 'summary', 'Is this your website? Verify it');
    const b = add(d, 'div', undefined, 'verify-body');
    let host = '';
    try { host = new URL(website).origin; } catch (e) { return; }
    add(b, 'p', 'Put this code on your website, then press Check. Either save it as a text file at ' + host + '/.well-known/animalpad-verify.txt, or add it anywhere on the page you linked (' + website + ').', 'hint');
    const code = add(b, 'code', c.verifyCode, 'vcode');
    const row = add(b, 'div', undefined, 'row');
    const check = add(row, 'button', 'Check my website', 'btn'); check.type = 'button';
    const msg = add(row, 'span', '', 'dl-status');
    msg.setAttribute('role', 'status');
    const WHY = { rate_limited: 'Wait a moment before checking again.', needs_https: 'The website link needs to start with https://.', no_website: 'This coin has no website.' };
    check.addEventListener('click', () => {
      check.disabled = true; msg.textContent = 'Checking…';
      fetch('/api/coin/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool: c.pool }) })
        .then(r => r.json())
        .then(r => {
          if (r && r.verified === true) { msg.textContent = 'Verified. Reloading…'; setTimeout(() => location.reload(), 800); return; }
          msg.textContent = (r && WHY[r.error]) || 'The code was not found on your site yet. Check that it is public, then try again.';
          check.disabled = false;
        })
        .catch(() => { msg.textContent = 'Could not check right now. Try again.'; check.disabled = false; });
    });
  }

  function problem(text) {
    box.textContent = '';
    add(box, 'p', text, 'hint');
  }

  if (!B58.test(pool)) { problem('That is not a valid coin address.'); return; }
  const getCfg = fetch('/api/launch/config', { headers: { Accept: 'application/json' } }).then(r => r.json()).catch(() => null);
  fetch('/api/launches/' + pool, { cache: 'no-store', headers: { Accept: 'application/json' } })
    .then(r => r.json().then(b => ({ status: r.status, body: b })))
    .then(async r => {
      if (r.status === 200) render(r.body, await getCfg);
      else if (r.status === 404) problem('No coin found here. It may not be on the chain yet. Try again in a few seconds.');
      else problem('Could not load this coin. Try again in a moment.');
    })
    .catch(() => problem('Could not load this coin. Try again in a moment.'));
})();
