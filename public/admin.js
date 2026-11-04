/* Platform fee claiming. Lists what each coin has earned for the fee claimer and claims it with the
   claimer's wallet. The server prepares each claim; the wallet signs it. Nothing secret lives here. */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const W = window.AnimalWallet;
  const root = document.documentElement;
  const themeBtn = $('theme');
  themeBtn.addEventListener('click', () => {
    const light = root.dataset.theme !== 'light';
    if (light) root.dataset.theme = 'light'; else delete root.dataset.theme;
    try { localStorage.setItem('animalpad-theme', light ? 'light' : 'dark'); } catch (e) { /* still works */ }
  });

  let wallet = '';
  let data = null;      // the last fee list from the server
  let names = {};       // pool -> coin name, for the coins the public list knows
  let busy = false;

  const fmt = n => Number(n).toFixed(6);
  const say = (t, bad) => { const s = $('status'); s.textContent = t; s.className = 'dl-status' + (bad ? ' bad' : ''); };
  const note = t => { const n = $('note'); n.textContent = t; n.hidden = !t; };
  const WHY = {
    not_fee_claimer: 'This wallet is not the fee claimer, so it cannot claim.',
    nothing_to_claim: 'Nothing to claim on that coin right now.',
    rate_limited: 'Too many requests. Wait a minute.',
    not_an_animalpad_pool: 'That pool is not an AnimalPad coin.',
    fees_read_failed: 'The server could not read the fees from devnet. The free public devnet RPC often refuses this lookup. Set LAUNCH_RPC_URL on the server to a dedicated devnet RPC address (Helius or QuickNode have free ones), and check the server log for "Partner fee read failed".',
    launch_unavailable: 'Launching is not switched on for this site, so there are no fees to read.'
  };

  function row(p) {
    const li = document.createElement('li');
    const who = document.createElement('div'); who.className = 'who';
    const b = document.createElement('b'); b.textContent = names[p.pool] || 'Coin';
    const a = document.createElement('span'); a.textContent = p.pool;
    who.appendChild(b); who.appendChild(a);
    const amt = document.createElement('div'); amt.className = 'amt';
    amt.textContent = fmt(p.waitingSol) + ' SOL waiting · ' + fmt(p.totalSol) + ' all-time';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn'; btn.textContent = 'Claim';
    btn.disabled = busy || !(p.waitingSol > 0);
    btn.addEventListener('click', () => claim([p]));
    li.appendChild(who); li.appendChild(amt); li.appendChild(btn);
    return li;
  }

  function render() {
    const allowed = Boolean(wallet && data && data.feeClaimers.indexOf(wallet) !== -1);
    $('connect').hidden = Boolean(wallet);
    $('who').textContent = wallet ? 'Connected ' + wallet.slice(0, 4) + '…' + wallet.slice(-4) : '';
    if (wallet && data && !allowed) {
      note('This wallet is not the fee claimer, so it cannot claim. The fee claimer is ' + data.feeClaimers.join(', ') + '. Connect that wallet in Phantom.');
    } else if (!data || allowed) note('');
    $('body').hidden = !allowed;
    if (!allowed) return;
    const waiting = data.pools.filter(p => p.waitingSol > 0);
    $('total').textContent = fmt(data.totalWaitingSol);
    $('count').textContent = String(data.pools.length);
    $('claim-all').disabled = busy || !waiting.length;
    $('reload').disabled = busy;
    const list = $('list');
    list.textContent = '';
    data.pools.forEach(p => list.appendChild(row(p)));
  }

  async function load(keepStatus) {
    if (!keepStatus) say('Loading…');
    try {
      const [res, pub] = await Promise.all([
        fetch('/api/admin/fees', { cache: 'no-store', headers: { Accept: 'application/json' } }),
        fetch('/api/launches', { cache: 'no-store' }).then(r => r.json()).catch(() => null)
      ]);
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        say(WHY[body && body.error] || (body ? 'Could not load the fees (' + (body.error || res.status) + '). Try again.' : 'The server did not answer with fee data (HTTP ' + res.status + '). It may still be deploying. Wait a minute and refresh.'), true);
        return;
      }
      data = body;
      names = {};
      ((pub && pub.launches) || []).forEach(c => { names[c.pool] = c.name + ' $' + c.symbol; });
      if (!keepStatus) say('');
    } catch (e) { say('Could not load the fees. Try again.', true); }
    render();
  }

  async function claim(list) {
    if (busy || !wallet) return;
    busy = true; render();
    let claimed = 0, total = 0;
    try {
      for (const p of list) {
        if (!(p.waitingSol > 0)) continue;
        say('Preparing the claim for ' + (names[p.pool] || p.pool.slice(0, 6) + '…') + '…');
        const res = await fetch('/api/admin/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pool: p.pool, claimer: wallet }) });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body || typeof body.transaction !== 'string') {
          if (body && body.error === 'nothing_to_claim') continue;
          say(WHY[body && body.error] || 'Could not prepare that claim. Try again.', true);
          break;
        }
        say('Approve the claim in your wallet…');
        const sig = await W.signAndSend(body.transaction);
        say('Sent. Waiting for devnet to confirm…');
        const state = await W.confirm(sig);
        if (state !== 'confirmed') { say(state === 'failed' ? 'A claim failed on-chain. Refresh and try again.' : 'Not confirmed yet. Refresh in a minute.', true); break; }
        claimed++; total += body.waitingSol || 0;
      }
      if (claimed) say('Claimed ✓ ' + claimed + ' coin' + (claimed === 1 ? '' : 's') + ', about ' + fmt(total) + ' SOL, sent to your wallet.');
    } catch (err) {
      const m = err && err.message ? String(err.message) : '';
      say(err && err.code === 'no_wallet' ? W.NO_WALLET : /reject|denied|cancel/i.test(m) ? 'You declined the transaction.' : 'The claim did not go through. Check that your wallet is on Devnet.', true);
    }
    busy = false;
    await load(true);
  }

  async function connect() {
    try {
      wallet = await W.connect();
      await load();
    } catch (err) {
      say(err && err.code === 'no_wallet' ? W.NO_WALLET : 'Wallet connection was not approved.', true);
    }
  }

  $('connect').addEventListener('click', connect);
  $('claim-all').addEventListener('click', () => claim((data && data.pools) || []));
  $('reload').addEventListener('click', load);
  load();
})();
