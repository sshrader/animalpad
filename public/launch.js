/* Devnet launch, page side. After a launch is staged, this connects the creator's wallet, asks the
   server for an unsigned token-launch transaction, and has the wallet sign and send it, then waits
   for the result. The page never sees a private key. Devnet only. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const W = window.AnimalWallet;

  let enabled = false;
  let offered = [];
  let staged = null;
  let wallet = null; // base58 address once connected
  let busy = false;

  function say(text, bad) {
    const el = $('dl-status');
    el.textContent = text;
    el.className = 'dl-status' + (bad ? ' bad' : '');
  }

  function render() {
    const show = enabled && staged && offered.indexOf(staged.preset) !== -1;
    $('devnet-launch').hidden = !show;
    $('dl-hint').hidden = Boolean(show);
    if (!show) return;
    $('dl-connect').hidden = Boolean(wallet);
    $('dl-go').hidden = !wallet;
    $('dl-go').disabled = busy;
    $('dl-connect').disabled = busy;
  }

  function strip(label, value) {
    const d = document.createElement('div');
    d.className = 'castrip';
    const l = document.createElement('span'); l.className = 'calab'; l.textContent = label;
    const c = document.createElement('code'); c.className = 'cavalue'; c.textContent = value;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ca-copy'; b.dataset.ca = value; b.textContent = 'Copy';
    b.setAttribute('aria-label', 'Copy ' + label);
    d.appendChild(l); d.appendChild(c); d.appendChild(b);
    return d;
  }

  function showResult(r, signature) {
    const box = $('dl-result');
    box.innerHTML = '';
    box.appendChild(strip('MINT', r.mint));
    box.appendChild(strip('POOL', r.pool));
    const links = document.createElement('div');
    [['Transaction', 'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + AnimalNet.suffix],
     ['Token', 'https://explorer.solana.com/address/' + encodeURIComponent(r.mint) + AnimalNet.suffix]].forEach((x, i) => {
      const a = document.createElement('a');
      a.href = x[1]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = x[0] + ' ↗';
      if (i) links.appendChild(document.createTextNode('  '));
      links.appendChild(a);
    });
    box.appendChild(links);
    box.hidden = false;
  }

  async function connect() {
    busy = true; render();
    try {
      wallet = await W.connect();
      say('Connected ' + wallet.slice(0, 4) + '…' + wallet.slice(-4) + '.' + (AnimalNet.main ? '' : ' Phantom must be set to Devnet.'));
    } catch (err) {
      say(err && err.code === 'no_wallet' ? W.NO_WALLET : 'Wallet connection was not approved.', true);
    }
    busy = false; render();
  }

  async function launch() {
    if (!wallet || !staged || busy) return;
    busy = true; render();
    $('dl-result').hidden = true;
    try {
      const buyText = $('l-buy').value.trim();
      const firstBuy = buyText === '' ? 0 : Number(buyText);
      if (!Number.isFinite(firstBuy) || firstBuy < 0 || (firstBuy > 0 && (firstBuy < 0.01 || firstBuy > 5))) {
        say('Buy at launch must be left empty, or be from 0.01 to 5 SOL.', true);
        busy = false; render();
        return;
      }
      const links = {};
      [['website', 'l-web'], ['twitter', 'l-x'], ['telegram', 'l-tg']].forEach(p => { const v = $(p[1]).value.trim(); if (v) links[p[0]] = v; });
      say('Preparing the transaction…');
      const res = await fetch('/api/launch/prepare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: staged.preset, name: staged.name, symbol: staged.symbol, art: staged.art, creator: wallet, links: links, firstBuySol: firstBuy })
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || typeof data.transaction !== 'string') {
        const why = { rate_limited: 'Too many launches. Wait a minute.', bad_name: 'That name is not allowed.', bad_symbol: 'Use 1 to 10 letters or digits for the ticker.', bad_art: 'That picture is no longer available. Make a new one.', bad_amount: 'Buy at launch must be from 0.01 to 5 SOL, or left empty.', first_buy_unsupported: 'Buying at launch is not supported by this version of the curve library. Leave it empty.', bad_links: 'Check your links. A website needs https://, and X and Telegram take a handle like @yourcoin.', links_locked: 'Your links are locked because a launch was already started with this animal. Put the earlier links back, or draw a new animal to change them.', uri_too_long: 'That name is too long.', launch_unavailable: 'Launching is not switched on for this site.' };
        say((data && why[data.error]) || 'Could not prepare the launch. Try again.', true);
        busy = false; render();
        return;
      }
      say('Approve the transaction in your wallet…');
      const signature = await W.signAndSend(data.transaction);
      showResult(data, signature);
      say('Sent. Waiting for the network to confirm…');
      const state = await W.confirm(signature);
      if (state === 'confirmed') {
        say('Confirmed ✓ Your token is live. Trade it in the card below.');
        document.dispatchEvent(new CustomEvent('animalpad:launched', { detail: { pool: data.pool } }));
      } else if (state === 'failed') {
        say('The transaction failed on-chain. Check the transaction link for the reason. Nothing was created.', true);
      } else {
        say('Not confirmed yet. Check the transaction link in a minute.', true);
      }
    } catch (err) {
      const m = err && err.message ? String(err.message) : '';
      say(err && err.code === 'no_wallet' ? W.NO_WALLET
        : /reject|denied|cancel/i.test(m) ? 'You declined the transaction.'
        : 'The launch did not go through. Check that your wallet is on ' + (AnimalNet.main ? 'Solana mainnet and has enough SOL.' : 'Devnet and has test SOL.'), true);
    }
    busy = false; render();
  }

  document.addEventListener('animalpad:reset', () => { staged = null; $('dl-result').hidden = true; say(''); render(); });

  $('dl-connect').addEventListener('click', connect);
  $('dl-go').addEventListener('click', launch);

  document.addEventListener('animalpad:staged', e => {
    staged = e.detail;
    $('dl-result').hidden = true;
    say('');
    render();
  });

  fetch('/api/launch/config', { headers: { Accept: 'application/json' } })
    .then(r => r.json())
    .then(info => {
      enabled = Boolean(info && info.enabled && Array.isArray(info.presets));
      offered = enabled ? info.presets : [];
      render();
    })
    .catch(() => { enabled = false; });
})();
