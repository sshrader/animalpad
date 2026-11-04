/* Wallet helpers shared by the launch and trade code: find Phantom, connect, sign and send a
   transaction the server prepared, and wait for it to land. The page never sees a private key.
   Devnet only. */
(function () {
  'use strict';

  const WEB3_URL = 'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.0/lib/index.iife.min.js';
  let address = null;

  function provider() {
    const p = window.phantom && window.phantom.solana;
    if (p && p.isPhantom) return p;
    if (window.solana && window.solana.isPhantom) return window.solana;
    return null;
  }

  function loadWeb3() {
    if (window.solanaWeb3) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = WEB3_URL;
      s.onload = () => (window.solanaWeb3 ? resolve() : reject(new Error('web3 missing')));
      s.onerror = () => reject(new Error('Could not load the wallet library.'));
      document.head.appendChild(s);
    });
  }

  async function connect() {
    const p = provider();
    if (!p) { const e = new Error('no_wallet'); e.code = 'no_wallet'; throw e; }
    const res = await p.connect();
    address = String(res && res.publicKey ? res.publicKey : p.publicKey);
    return address;
  }

  // Signs and sends a base64 transaction from the server. Returns the signature.
  async function signAndSend(b64) {
    const p = provider();
    if (!p) { const e = new Error('no_wallet'); e.code = 'no_wallet'; throw e; }
    await loadWeb3();
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const tx = window.solanaWeb3.Transaction.from(bytes);
    const sent = await p.signAndSendTransaction(tx);
    return sent && sent.signature ? sent.signature : String(sent);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Polls the server until the transaction is confirmed or failed, or time runs out.
  // Returns 'confirmed', 'failed' or 'pending'.
  async function confirm(signature, opts) {
    const o = opts || {};
    const tries = o.tries || 30;
    const gap = o.gapMs === undefined ? 2000 : o.gapMs;
    for (let i = 0; i < tries; i++) {
      await sleep(i === 0 ? Math.min(gap, 1000) : gap);
      try {
        const res = await fetch('/api/launch/status?sig=' + encodeURIComponent(signature), { headers: { Accept: 'application/json' } });
        const body = await res.json().catch(() => null);
        if (body && (body.state === 'confirmed' || body.state === 'failed')) return body.state;
      } catch (err) { /* keep trying */ }
    }
    return 'pending';
  }

  const NO_WALLET = 'No Phantom wallet found. Install Phantom, switch it to Devnet (Settings, Developer Settings, Testnet Mode), then reload.';

  window.AnimalWallet = { provider, connect, signAndSend, confirm, NO_WALLET, get address() { return address; } };
})();
