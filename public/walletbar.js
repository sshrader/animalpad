/* Wallet button in the page header: connect, then a small menu to copy the address, change wallet
   or disconnect. It only shows the public address. */
(function () {
  'use strict';
  const W = window.AnimalWallet;
  const row = document.querySelector('.top .row');
  if (!W || !row) return;

  const wrap = document.createElement('div');
  wrap.className = 'wbar';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'wbtn';
  btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'wmenu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  wrap.appendChild(btn); wrap.appendChild(menu);
  const theme = document.getElementById('theme');
  row.insertBefore(wrap, theme || null);

  const short = a => a.slice(0, 4) + '…' + a.slice(-4);
  let note = '';

  function item(label, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'witem'; b.setAttribute('role', 'menuitem'); b.textContent = label;
    b.addEventListener('click', fn);
    menu.appendChild(b);
    return b;
  }

  function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }

  async function connect() {
    note = '';
    try { await W.connect(); } catch (err) {
      note = err && err.code === 'no_wallet' ? W.NO_WALLET : 'The wallet connection was not approved.';
      draw();
    }
  }

  function draw() {
    menu.textContent = '';
    const a = W.address;
    if (!a) {
      btn.textContent = 'Connect wallet';
      btn.classList.remove('on');
      if (note) { btn.title = note; }
      return;
    }
    btn.classList.add('on');
    btn.textContent = short(a);
    btn.title = a;
    item('Copy address', () => {
      const done = t => { copy.textContent = t; setTimeout(() => { copy.textContent = 'Copy address'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(a).then(() => done('Copied'), () => done('Copy failed'));
      else done('Copy not available');
    });
    const copy = menu.lastChild;
    item('Change wallet', async () => { close(); await W.disconnect(); await connect(); });
    item('Disconnect', async () => { close(); await W.disconnect(); });
  }

  btn.addEventListener('click', () => {
    if (!W.address) { connect(); return; }
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', e => { if (!wrap.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('animalpad:wallet', () => { note = ''; draw(); });
  draw();
})();
