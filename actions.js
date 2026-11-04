'use strict';

// Solana Actions ("Blinks"): lets a wallet or a Blink viewer show a coin and build a buy for it.
// The server only prepares an unsigned buy; the person's wallet signs it. Devnet only, like the rest.
// Spec: https://solana.com/docs/advanced/actions
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const AMOUNTS = [0.05, 0.1, 0.5];
const MIN_SOL = 0.01, MAX_SOL = 5;

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding',
  'Access-Control-Expose-Headers': 'X-Action-Version, X-Blockchain-Ids',
  'X-Action-Version': '2.4',
  'X-Blockchain-Ids': DEVNET,
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function createActions(opts) {
  const launches = opts.launches;
  const launcher = opts.launcher;
  const isMain = opts.cluster === 'mainnet-beta';
  const HEADERS_C = Object.assign({}, HEADERS, { 'X-Blockchain-Ids': isMain ? MAINNET : DEVNET });

  // Maps a coin page link to its action, so a pasted /coin/<pool> link can unfurl as a Blink.
  function rules() {
    return { rules: [
      { pathPattern: '/coin/*', apiPath: '/api/actions/trade/*' },
      { pathPattern: '/api/actions/**', apiPath: '/api/actions/**' }
    ] };
  }

  const absolute = (base, p) => (/^https?:\/\//.test(p) ? p : base.replace(/\/+$/, '') + p);

  async function describe(pool, base) {
    if (!launches || !B58.test(pool)) return { status: 404, body: { message: 'Coin not found.' } };
    const d = await launches.detail(pool);
    if (d.status !== 200) return { status: 404, body: { message: 'Coin not found.' } };
    const c = d.body;
    const pct = Math.round(Math.max(0, Math.min(1, Number(c.progress) || 0)) * 100);
    const href = amount => absolute(base, '/api/actions/trade/' + pool + '?amount=' + amount);
    const out = {
      type: 'action',
      icon: absolute(base, c.imageUrl || '/icon.svg'),
      title: c.name + ' ($' + c.symbol + ')',
      description: (c.description ? c.description + ' ' : '') + 'Devnet test coin, ' + pct + '% of the way to a full curve. Test SOL only.',
      label: 'Buy',
      links: { actions: AMOUNTS.map(a => ({ type: 'transaction', label: 'Buy ' + a + ' SOL', href: href(a) })).concat([{
        type: 'transaction', label: 'Buy', href: absolute(base, '/api/actions/trade/' + pool + '?amount={amount}'),
        parameters: [{ name: 'amount', label: 'SOL amount', required: true, type: 'number', min: MIN_SOL, max: MAX_SOL }]
      }]) }
    };
    if (c.migrated || c.curveFull) {
      out.disabled = true;
      out.error = { message: c.migrated ? 'This coin has moved to its trading pool.' : 'The curve is full.' };
    }
    return { status: 200, body: out };
  }

  async function transact(pool, amount, body, ctx) {
    if (!launcher || !launches || !B58.test(pool)) return { status: 404, body: { message: 'Coin not found.' } };
    const account = body && typeof body.account === 'string' ? body.account : '';
    if (!B58.test(account)) return { status: 400, body: { message: 'A wallet address is needed.' } };
    const sol = Number(amount);
    if (!Number.isFinite(sol) || sol < MIN_SOL || sol > MAX_SOL) return { status: 400, body: { message: 'Pick an amount from ' + MIN_SOL + ' to ' + MAX_SOL + ' SOL.' } };
    const d = await launches.detail(pool);
    if (d.status !== 200) return { status: 404, body: { message: 'Coin not found.' } };
    const r = await launcher.buy({ pool, buyer: account, sol }, ctx);
    if (r.status !== 200) {
      const why = { rate_limited: 'Too many requests. Wait a minute.', migrated: 'This coin has moved to its trading pool.', curve_full: 'The curve is full.' };
      return { status: r.status >= 500 ? 502 : 400, body: { message: why[r.body && r.body.error] || 'Could not prepare the buy. Try again.' } };
    }
    return { status: 200, body: { type: 'transaction', transaction: r.body.transaction, message: 'Buy ' + sol + ' SOL of ' + d.body.name + (isMain ? '.' : ' (devnet test coins).') } };
  }

  return { describe, transact, rules, HEADERS: HEADERS_C };
}

module.exports = { createActions, HEADERS, DEVNET, MAINNET };
