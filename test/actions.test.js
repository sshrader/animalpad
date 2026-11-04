'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server.js');
const { createArt } = require('../art.js');

const POOL = 'FWUDZaaBrNJDGVzyTnKRhLgrjUeWU4mJdUvfBUmkxWZa';
const WALLET = 'CFyapVaq8njp4N6Qqrw7XETB89GuLkLwHH6huUtcY4Ws';
const quiet = { log() {}, error() {} };

function fakes(over) {
  const calls = [];
  const launches = {
    list: async () => [], record: () => true,
    detail: async pool => pool === POOL
      ? { status: 200, body: Object.assign({ pool, name: 'Walrusco', symbol: 'WRCS', description: 'A walrus.', imageUrl: '/art/' + 'a'.repeat(16) + '.png', progress: 0.4, migrated: false, curveFull: false }, over) }
      : { status: 404, body: { error: 'not_found' } }
  };
  const launcher = {
    info: () => ({ enabled: true }),
    buy: async (input) => { calls.push(input); return { status: 200, body: { transaction: 'VFg=' } }; }
  };
  return { launches, launcher, calls };
}

async function withServer(opts, fn) {
  const srv = createApp(Object.assign({ art: createArt({ logger: quiet }) }, opts));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try { await fn(base); } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
}

test('actions: discovery file, CORS preflight and devnet headers', async () => {
  await withServer(fakes(), async base => {
    const j = await fetch(base + '/actions.json');
    assert.equal(j.status, 200);
    assert.equal(j.headers.get('access-control-allow-origin'), '*');
    assert.equal(j.headers.get('x-blockchain-ids'), 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    assert.equal((await j.json()).rules[0].pathPattern, '/coin/*');
    const o = await fetch(base + '/api/actions/trade/' + POOL, { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.match(o.headers.get('access-control-allow-headers'), /Content-Type/);
  });
});

test('actions: GET describes the coin with buy buttons and an absolute icon', async () => {
  await withServer(fakes(), async base => {
    const r = await fetch(base + '/api/actions/trade/' + POOL);
    assert.equal(r.status, 200);
    const a = await r.json();
    assert.equal(a.type, 'action');
    assert.equal(a.title, 'Walrusco ($WRCS)');
    assert.match(a.icon, /^http:\/\/127\.0\.0\.1:\d+\/art\/a{16}\.png$/);
    assert.equal(a.links.actions.length, 4);
    assert.match(a.links.actions[0].href, /\/api\/actions\/trade\/.+\?amount=0\.05$/);
    assert.equal(a.links.actions[3].parameters[0].name, 'amount');
    assert.equal(a.disabled, undefined);
    assert.equal((await fetch(base + '/api/actions/trade/' + 'B'.repeat(43))).status, 404);
  });
  await withServer(fakes({ curveFull: true }), async base => {
    const a = await (await fetch(base + '/api/actions/trade/' + POOL)).json();
    assert.equal(a.disabled, true);
    assert.match(a.error.message, /full/);
  });
});

test('actions: POST returns an unsigned buy for the given wallet, and refuses bad input', async () => {
  const f = fakes();
  await withServer(f, async base => {
    const post = (q, body) => fetch(base + '/api/actions/trade/' + POOL + q, { method: 'POST', body: JSON.stringify(body) });
    const ok = await post('?amount=0.1', { account: WALLET });
    assert.equal(ok.status, 200);
    const t = await ok.json();
    assert.equal(t.type, 'transaction');
    assert.equal(t.transaction, 'VFg=');
    assert.deepEqual([f.calls[0].pool, f.calls[0].buyer, f.calls[0].sol], [POOL, WALLET, 0.1]);
    assert.equal((await post('?amount=999', { account: WALLET })).status, 400);
    assert.equal((await post('?amount=abc', { account: WALLET })).status, 400);
    assert.equal((await post('', { account: WALLET })).status, 400);
    assert.equal((await post('?amount=0.1', { account: 'nope' })).status, 400);
    assert.equal((await post('?amount=0.1', {})).status, 400);
    const bad = await post('?amount=0.1', { account: WALLET }).then(() => fetch(base + '/api/actions/trade/' + POOL, { method: 'DELETE' }));
    assert.equal(bad.status, 405);
  });
  const down = fakes();
  down.launcher.buy = async () => ({ status: 409, body: { error: 'curve_full' } });
  await withServer(down, async base => {
    const r = await fetch(base + '/api/actions/trade/' + POOL + '?amount=0.1', { method: 'POST', body: JSON.stringify({ account: WALLET }) });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /full/);
  });
});
