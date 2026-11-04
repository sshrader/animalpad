'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLauncher, loadPresets, metadataFor } = require('../launch.js');
const { createApp } = require('../server.js');

const CONFIG = 'CAAYwzGN4XjofFLZt4iwhMw9L8pH9BY379YjLUo3Qq8o';
const CREATOR = 'CFyapVaq8njp4N6Qqrw7XETB89GuLkLwHH6huUtcY4Ws';
const PRESETS = { network: 'devnet', presets: { standard: { config: CONFIG, totalPct: 1, creatorSharePct: 40 } } };
const quiet = { log() {}, error() {} };

// Stand-ins for the Meteora SDK and web3.js, so these tests need neither installed.
function fakeLoad(calls) {
  class PublicKey { constructor(v) { this.v = v; } toBase58() { return this.v; } }
  const web3 = {
    PublicKey,
    Keypair: { generate: () => ({ publicKey: new PublicKey('MintKeyPair1111111111111111111111111111111') }) },
    Connection: class { async getLatestBlockhash() { return { blockhash: 'BLOCKHASH' }; } }
  };
  const sdk = {
    DynamicBondingCurveClient: class {
      constructor() {
        this.creator = {
          createPool: async params => {
            calls.push(params);
            return { partialSign(k) { this.signedBy = k.publicKey.toBase58(); }, serialize() { return Buffer.from('TX-BYTES'); } };
          }
        };
      }
    },
    deriveDbcPoolAddress: () => new PublicKey('PoolAddress11111111111111111111111111111111')
  };
  return async () => ({ sdk, web3, spl: { NATIVE_MINT: new PublicKey('So11111111111111111111111111111111111111112') } });
}

const ctx = { ip: '1.2.3.4', baseUrl: 'https://draftpad.example' };
const good = { preset: 'standard', name: 'Salt Lantern', symbol: '$lntrn', creator: CREATOR };

test('presets file: only devnet files with valid config addresses are accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dp-'));
  const write = (n, v) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(v)); return f; };
  assert.deepEqual(Object.keys(loadPresets(write('ok.json', PRESETS)).presets), ['standard']);
  assert.equal(loadPresets(write('main.json', Object.assign({}, PRESETS, { network: 'mainnet' }))), null);
  assert.equal(loadPresets(write('bad.json', { network: 'devnet', presets: { x: { config: 'nope' } } })), null);
  assert.equal(loadPresets(path.join(dir, 'missing.json')), null);
});

test('launching refuses to start against a mainnet RPC', () => {
  assert.throws(() => createLauncher({ presets: PRESETS, rpcUrl: 'https://api.mainnet-beta.solana.com' }), /devnet/);
});

test('prepare builds an unsigned transaction signed only by the new mint', async () => {
  const calls = [];
  const l = createLauncher({ presets: PRESETS, load: fakeLoad(calls), logger: quiet });
  const r = await l.prepare(good, ctx);
  assert.equal(r.status, 200);
  assert.equal(r.body.transaction, Buffer.from('TX-BYTES').toString('base64'));
  assert.equal(r.body.mint, 'MintKeyPair1111111111111111111111111111111');
  assert.equal(r.body.pool, 'PoolAddress11111111111111111111111111111111');
  assert.equal(r.body.cluster, 'devnet');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'Salt Lantern');
  assert.equal(calls[0].symbol, 'LNTRN');
  assert.equal(calls[0].config.toBase58(), CONFIG);
  assert.equal(calls[0].payer.toBase58(), CREATOR);
  assert.equal(calls[0].poolCreator.toBase58(), CREATOR);
  assert.equal(calls[0].uri, 'https://draftpad.example/meta.json?n=Salt%20Lantern&s=LNTRN');
});

test('prepare rejects bad input before touching the network', async () => {
  const calls = [];
  const l = createLauncher({ presets: PRESETS, load: fakeLoad(calls), logger: quiet, maxPerMinute: 1000 });
  const code = async over => (await l.prepare(Object.assign({}, good, over), ctx));
  assert.equal((await code({ preset: 'nope' })).body.error, 'bad_preset');
  assert.equal((await code({ preset: '__proto__' })).body.error, 'bad_preset');
  assert.equal((await code({ name: '' })).body.error, 'bad_name');
  assert.equal((await code({ name: '‮​' })).body.error, 'bad_name');
  assert.equal((await code({ symbol: 'has space' })).body.error, 'bad_symbol');
  assert.equal((await code({ symbol: 'WAYTOOLONGSYMBOL' })).body.error, 'bad_symbol');
  assert.equal((await code({ creator: 'not a key' })).body.error, 'bad_creator');
  assert.equal((await code({ creator: 5 })).body.error, 'bad_creator');
  assert.equal((await l.prepare('nope', ctx)).body.error, 'bad_preset');
  assert.equal((await l.prepare(good, { ip: 'x', baseUrl: '' })).body.error, 'uri_too_long');
  assert.equal((await code({ name: '你'.repeat(32) })).body.error, 'uri_too_long');
  assert.equal(calls.length, 0);
});

test('name text is cleaned of control and bidi characters', async () => {
  const calls = [];
  const l = createLauncher({ presets: PRESETS, load: fakeLoad(calls), logger: quiet });
  await l.prepare(Object.assign({}, good, { name: 'Salt‮  Lan​tern\u0007' }), ctx);
  assert.equal(calls[0].name, 'Salt Lantern');
});

test('prepare is rate limited per address, and failures are generic', async () => {
  const l = createLauncher({ presets: PRESETS, load: fakeLoad([]), logger: quiet, maxPerMinute: 2 });
  assert.equal((await l.prepare(good, ctx)).status, 200);
  assert.equal((await l.prepare(good, ctx)).status, 200);
  assert.equal((await l.prepare(good, ctx)).status, 429);
  assert.equal((await l.prepare(good, { ip: '9.9.9.9', baseUrl: ctx.baseUrl })).status, 200);

  const broken = createLauncher({ presets: PRESETS, logger: quiet, load: async () => { throw new Error('secret stack detail'); } });
  const r = await broken.prepare(good, ctx);
  assert.equal(r.status, 502);
  assert.deepEqual(r.body, { error: 'prepare_failed' });
});

test('without presets the launcher is off and says so', async () => {
  const l = createLauncher({ presets: null, logger: quiet });
  assert.deepEqual(l.info(), { enabled: false, cluster: 'devnet', presets: [] });
  assert.equal((await l.prepare(good, ctx)).status, 503);
});

test('metadata is built from the link and refuses junk', () => {
  assert.deepEqual(metadataFor('Salt Lantern', 'lntrn').symbol, 'LNTRN');
  assert.equal(metadataFor('', 'X'), null);
  assert.equal(metadataFor('Name', '<script>'), null);
  assert.equal(metadataFor(null, null), null);
  assert.equal(metadataFor('Name', 'OK').image, '');
});

async function withServer(opts, fn) {
  const srv = createApp(opts);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try { await fn('http://127.0.0.1:' + srv.address().port); } finally {
    srv.closeAllConnections();
    await new Promise(r => srv.close(r));
  }
}
const feed = { configured: false, get: async () => ({ status: 503, body: {} }) };

test('server: launch routes work, and POST is allowed nowhere else', async () => {
  const launcher = createLauncher({ presets: PRESETS, load: fakeLoad([]), logger: quiet });
  await withServer({ feed, launcher }, async base => {
    const cfg = await (await fetch(base + '/api/launch/config')).json();
    assert.deepEqual(cfg, { enabled: true, cluster: 'devnet', presets: ['standard'], terms: { standard: { totalPct: 1, creatorSharePct: 40 } } });

    const post = body => fetch(base + '/api/launch/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const ok = await post(JSON.stringify(good));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const data = await ok.json();
    assert.equal(data.cluster, 'devnet');
    assert.match(data.transaction, /^[A-Za-z0-9+/=]+$/);

    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post('x'.repeat(5000))).status, 400);
    assert.equal((await post(JSON.stringify(Object.assign({}, good, { preset: 'nope' })))).status, 400);

    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/trending', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/launch/prepare')).status, 404);
  });
});

test('server: launching is off without a launcher, and meta.json serves metadata', async () => {
  await withServer({ feed }, async base => {
    assert.equal((await (await fetch(base + '/api/launch/config')).json()).enabled, false);
    const r = await fetch(base + '/api/launch/prepare', { method: 'POST', body: '{}' });
    assert.equal(r.status, 503);
    const m = await fetch(base + '/meta.json?n=Salt%20Lantern&s=LNTRN');
    assert.equal(m.status, 200);
    assert.equal((await m.json()).symbol, 'LNTRN');
    assert.equal((await fetch(base + '/meta.json?n=x&s=%3Cb%3E')).status, 400);
  });
});

// ---- status, pool reads and buys ----

const POOL = 'FWUDZaaBrNJDGVzyTnKRhLgrjUeWU4mJdUvfBUmkxWZa';
const SIG = '3uQi5xA7Dneip5qac73zDZV4CqysWxAmup8Moy4Rc8L5ro99LVcyeSvYB4GduFNYBJ8yiJJZg8eawjqvkJHJoAHZ';

// A fake chain: one pool at a given fill level, plus a transaction status to report.
function fakeChain(o) {
  const opt = Object.assign({ raised: 0, need: 1e9, migrated: 0, poolConfig: CONFIG, sigStatus: null }, o);
  const seen = { swaps: [], quotes: [], claims: [], partnerClaims: [] };
  class PublicKey { constructor(v) { this.v = v; } toBase58() { return this.v; } }
  class BN { constructor(v) { this.v = v; } toString() { return String(this.v); } }
  const web3 = {
    PublicKey,
    Connection: class {
      async getLatestBlockhash() { return { blockhash: 'BLOCKHASH' }; }
      async getSlot() { return 1; }
      async getSignatureStatuses() { return { value: [opt.sigStatus] }; }
    }
  };
  const sdk = {
    SwapMode: { ExactIn: 'ExactIn', PartialFill: 'PartialFill' },
    ActivationType: { Slot: 'Slot', Timestamp: 'Timestamp' },
    DynamicBondingCurveClient: class {
      constructor() {
        this.state = {
          getPool: async () => (opt.noPool ? null : { config: new PublicKey(opt.poolConfig), quoteReserve: new BN(opt.raised), isMigrated: opt.migrated, creator: new PublicKey(opt.poolCreator || CREATOR) }),
          getPoolFeeBreakdown: async () => ({ creator: { unclaimedQuoteFee: new BN(opt.unclaimed === undefined ? 8502019 : opt.unclaimed), claimedQuoteFee: new BN(4) } }),
          getPoolConfig: async () => ({ migrationQuoteThreshold: new BN(opt.need), activationType: 'Timestamp', feeClaimer: new PublicKey(opt.feeClaimer || CREATOR) }),
          getPoolsFeesByConfig: async () => [{ poolAddress: new PublicKey(POOL), partnerQuoteFee: new BN(opt.partnerFee === undefined ? 3000000000 / 1000 : opt.partnerFee), totalTradingQuoteFee: new BN(10000000) }]
        };
        this.partner = {
          claimPartnerTradingFeeToReceiver: async p => { seen.partnerClaims.push(p); return { serialize() { return Buffer.from('PARTNER-CLAIM'); } }; }
        };
        this.creator = {
          claimCreatorTradingFeeToReceiver: async p => { seen.claims.push(p); return { serialize() { return Buffer.from('CLAIM-BYTES'); } }; }
        };
        this.pool = {
          swapQuote2: p => { if (opt.quoteThrows) throw new TypeError("Cannot read properties of undefined (reading 'quoteReserve')"); seen.quotes.push(p); return { minimumAmountOut: new BN(777) }; },
          swap2: async p => { seen.swaps.push(p); return { serialize() { return Buffer.from('SWAP-BYTES'); } }; }
        };
      }
    }
  };
  return { seen, load: async () => ({ sdk, web3, spl: {}, BN }) };
}
const buyer = CREATOR;
const buyBody = over => Object.assign({ pool: POOL, buyer, sol: 0.1 }, over);

test('status reports pending, confirmed and failed, and rejects junk signatures', async () => {
  const run = async sigStatus => createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ sigStatus }).load }).status(SIG, ctx);
  assert.deepEqual((await run(null)).body, { state: 'pending' });
  assert.deepEqual((await run({ confirmationStatus: 'processed' })).body, { state: 'pending' });
  assert.deepEqual((await run({ confirmationStatus: 'confirmed' })).body, { state: 'confirmed' });
  assert.deepEqual((await run({ confirmationStatus: 'finalized' })).body, { state: 'confirmed' });
  assert.deepEqual((await run({ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'x'] } })).body, { state: 'failed' });
  const l = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain().load });
  assert.equal((await l.status('short', ctx)).body.error, 'bad_signature');
  assert.equal((await l.status(null, ctx)).body.error, 'bad_signature');
  assert.equal((await l.status('0'.repeat(88), ctx)).status, 400);
});

test('pool read shows curve progress and only serves Draftpad pools', async () => {
  const l = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ raised: 250000000 }).load });
  const r = await l.pool(POOL, ctx);
  assert.equal(r.status, 200);
  assert.equal(r.body.progress, 0.25);
  assert.equal(r.body.raisedSol, 0.25);
  assert.equal(r.body.thresholdSol, 1);
  assert.equal(r.body.preset, 'standard');
  assert.equal(r.body.curveFull, false);
  assert.equal(r.body.migrated, false);

  const full = await createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ raised: 1e9 }).load }).pool(POOL, ctx);
  assert.equal(full.body.curveFull, true);
  assert.equal(full.body.progress, 1);
  const gone = await createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ migrated: 1 }).load }).pool(POOL, ctx);
  assert.equal(gone.body.migrated, true);
  assert.equal(gone.body.curveFull, true);

  const stranger = await createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ poolConfig: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }).load }).pool(POOL, ctx);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.error, 'not_an_animalpad_pool');
  assert.equal((await createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ noPool: true }).load }).pool(POOL, ctx)).body.error, 'pool_not_found');
  assert.equal((await createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain().load }).pool('nope', ctx)).body.error, 'bad_pool');
});

test('buy prepares an unsigned swap with a quoted minimum, and a partial fill when it would fill the curve', async () => {
  const chain = fakeChain({ raised: 0 });
  const l = createLauncher({ presets: PRESETS, logger: quiet, load: chain.load, maxPerMinute: 1000 });
  const ok = await l.buy(buyBody(), ctx);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transaction, Buffer.from('SWAP-BYTES').toString('base64'));
  assert.equal(ok.body.partialFill, false);
  assert.equal(chain.seen.swaps[0].swapMode, 'ExactIn');
  assert.equal(chain.seen.swaps[0].amountIn.toString(), '100000000');
  assert.equal(chain.seen.swaps[0].minimumAmountOut.toString(), '777');
  assert.ok(chain.seen.quotes[0].virtualPool.poolState, 'quote gets the pool in wrapper form');
  assert.equal(chain.seen.swaps[0].owner.toBase58(), buyer);
  assert.equal(chain.seen.swaps[0].swapBaseForQuote, false);

  const near = fakeChain({ raised: 950000000 });
  const filling = await createLauncher({ presets: PRESETS, logger: quiet, load: near.load }).buy(buyBody({ sol: 0.1 }), ctx);
  assert.equal(filling.body.partialFill, true);
  assert.equal(near.seen.swaps[0].swapMode, 'PartialFill');
  assert.equal(near.seen.swaps[0].minimumAmountOut.toString(), '0');
  assert.equal(near.seen.quotes.length, 0);
});

test('buy rejects bad input, other projects\' pools, full and migrated curves', async () => {
  const mk = o => createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain(o).load, maxPerMinute: 1000 });
  const l = mk();
  assert.equal((await l.buy(buyBody({ pool: 'x' }), ctx)).body.error, 'bad_pool');
  assert.equal((await l.buy(buyBody({ buyer: 'x' }), ctx)).body.error, 'bad_buyer');
  for (const sol of [0, 0.001, 6, -1, NaN, 'abc', null]) assert.equal((await l.buy(buyBody({ sol }), ctx)).body.error, 'bad_amount', String(sol));
  assert.equal((await l.buy('nope', ctx)).body.error, 'bad_pool');
  assert.equal((await mk({ poolConfig: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' }).buy(buyBody(), ctx)).body.error, 'not_an_animalpad_pool');
  assert.equal((await mk({ raised: 1e9 }).buy(buyBody(), ctx)).body.error, 'curve_full');
  assert.equal((await mk({ migrated: 1 }).buy(buyBody(), ctx)).body.error, 'migrated');
  assert.equal((await mk({ noPool: true }).buy(buyBody(), ctx)).status, 404);
});

test('buys are rate limited, and chain failures give a generic error', async () => {
  const l = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain().load, maxPerMinute: 1 });
  assert.equal((await l.buy(buyBody(), ctx)).status, 200);
  assert.equal((await l.buy(buyBody(), ctx)).status, 429);
  const broken = createLauncher({ presets: PRESETS, logger: quiet, load: async () => { throw new Error('rpc secret'); } });
  assert.deepEqual((await broken.buy(buyBody(), ctx)).body, { error: 'prepare_failed' });
  assert.deepEqual((await broken.pool(POOL, ctx)).body, { error: 'pool_read_failed' });
  assert.deepEqual((await broken.status(SIG, ctx)).body, { error: 'status_failed' });
});

test('server: status, pool and buy routes', async () => {
  const launcher = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ raised: 500000000, sigStatus: { confirmationStatus: 'confirmed' } }).load });
  await withServer({ feed, launcher }, async base => {
    assert.deepEqual(await (await fetch(base + '/api/launch/status?sig=' + SIG)).json(), { state: 'confirmed' });
    assert.equal((await fetch(base + '/api/launch/status?sig=bad')).status, 400);
    const pr = await fetch(base + '/api/launch/pool?address=' + POOL);
    assert.equal(pr.status, 200);
    assert.equal(pr.headers.get('cache-control'), 'no-store');
    assert.equal((await pr.json()).progress, 0.5);
    assert.equal((await fetch(base + '/api/launch/pool')).status, 400);
    const buy = await fetch(base + '/api/launch/buy', { method: 'POST', body: JSON.stringify(buyBody()) });
    assert.equal(buy.status, 200);
    assert.match((await buy.json()).transaction, /^[A-Za-z0-9+/=]+$/);
    assert.equal((await fetch(base + '/api/launch/buy', { method: 'POST', body: '{nope' })).status, 400);
    assert.equal((await fetch(base + '/api/launch/buy')).status, 404);
    assert.equal((await fetch(base + '/api/launch/status', { method: 'POST' })).status, 405);
  });
  await withServer({ feed }, async base => {
    assert.equal((await fetch(base + '/api/launch/status?sig=' + SIG)).status, 503);
    assert.equal((await fetch(base + '/api/launch/pool?address=' + POOL)).status, 503);
    assert.equal((await fetch(base + '/api/launch/buy', { method: 'POST', body: '{}' })).status, 503);
  });
});

test('buy still goes out with no minimum when the SDK quote throws, and says so in the log', async () => {
  const logs = [];
  const chain = fakeChain({ raised: 0, quoteThrows: true });
  const l = createLauncher({ presets: PRESETS, logger: { log() {}, error: m => logs.push(m) }, load: chain.load, maxPerMinute: 1000 });
  const ok = await l.buy(buyBody(), ctx);
  assert.equal(ok.status, 200);
  assert.equal(chain.seen.swaps[0].minimumAmountOut.toString(), '0');
  assert.ok(logs.some(m => /quote failed/.test(m) && /quoteReserve/.test(m)));
});

test('fees shows what the creator has earned and who the creator is', async () => {
  const l = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({}).load, maxReadsPerMinute: 1000 });
  const ok = await l.fees(POOL, ctx);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.creator, CREATOR);
  assert.equal(ok.body.unclaimedSol, 0.008502019);
  assert.equal(ok.body.claimedSol, 4e-9);
  assert.equal((await l.fees('nope', ctx)).status, 400);
  const other = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ poolConfig: 'So11111111111111111111111111111111111111112' }).load });
  assert.equal((await other.fees(POOL, ctx)).body.error, 'not_an_animalpad_pool');
});

test('claim builds an unsigned transaction only for the pool creator and only when there is something to claim', async () => {
  const chain = fakeChain({});
  const l = createLauncher({ presets: PRESETS, logger: quiet, load: chain.load, maxPerMinute: 1000 });
  const ok = await l.claim({ pool: POOL, creator: CREATOR }, ctx);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transaction, Buffer.from('CLAIM-BYTES').toString('base64'));
  assert.equal(chain.seen.claims[0].creator.toBase58(), CREATOR);
  assert.equal(chain.seen.claims[0].receiver.toBase58(), CREATOR);

  const stranger = await l.claim({ pool: POOL, creator: 'So11111111111111111111111111111111111111112' }, ctx);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, 'not_creator');
  assert.equal(chain.seen.claims.length, 1);

  const empty = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ unclaimed: 0 }).load, maxPerMinute: 1000 });
  assert.equal((await empty.claim({ pool: POOL, creator: CREATOR }, ctx)).body.error, 'nothing_to_claim');
  assert.equal((await l.claim({ pool: 'x', creator: CREATOR }, ctx)).status, 400);
  assert.equal((await l.claim({ pool: POOL, creator: 5 }, ctx)).status, 400);
});

test('server: fees and claim routes', async () => {
  const launcher = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({}).load });
  await withServer({ feed, launcher }, async base => {
    const f = await fetch(base + '/api/launch/fees?address=' + POOL);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('cache-control'), 'no-store');
    assert.equal((await f.json()).creator, CREATOR);
    assert.equal((await fetch(base + '/api/launch/fees')).status, 400);
    const c = await fetch(base + '/api/launch/claim', { method: 'POST', body: JSON.stringify({ pool: POOL, creator: CREATOR }) });
    assert.equal(c.status, 200);
    assert.match((await c.json()).transaction, /^[A-Za-z0-9+/=]+$/);
    const bad = await fetch(base + '/api/launch/claim', { method: 'POST', body: JSON.stringify({ pool: POOL, creator: 'So11111111111111111111111111111111111111112' }) });
    assert.equal(bad.status, 403);
    assert.equal((await fetch(base + '/api/launch/claim')).status, 404);
  });
  await withServer({ feed }, async base => {
    assert.equal((await fetch(base + '/api/launch/fees?address=' + POOL)).status, 503);
    assert.equal((await fetch(base + '/api/launch/claim', { method: 'POST', body: '{}' })).status, 503);
  });
});

test('partner fees: the list reads every pool under the configs, and a claim is built only for the fee claimer', async () => {
  const chain = fakeChain({});
  const l = createLauncher({ presets: PRESETS, logger: quiet, load: chain.load, maxPerMinute: 1000 });
  const list = await l.partnerFees(ctx);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.feeClaimers, [CREATOR]);
  assert.equal(list.body.pools.length, 1);
  assert.equal(list.body.pools[0].pool, POOL);
  assert.equal(list.body.pools[0].waitingSol, 0.003);
  assert.equal(list.body.totalWaitingSol, 0.003);
  const ok = await l.partnerClaim({ pool: POOL, claimer: CREATOR }, ctx);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transaction, Buffer.from('PARTNER-CLAIM').toString('base64'));
  assert.equal(chain.seen.partnerClaims[0].feeClaimer.toBase58(), CREATOR);
  assert.equal(chain.seen.partnerClaims[0].receiver.toBase58(), CREATOR);   // the money goes to the claimer itself
  const stranger = await l.partnerClaim({ pool: POOL, claimer: 'So11111111111111111111111111111111111111112' }, ctx);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, 'not_fee_claimer');
  assert.equal(chain.seen.partnerClaims.length, 1);
  const none = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ partnerFee: 0 }).load, maxPerMinute: 1000 });
  assert.equal((await none.partnerClaim({ pool: POOL, claimer: CREATOR }, ctx)).body.error, 'nothing_to_claim');
  assert.equal((await l.partnerClaim({ pool: 'x', claimer: CREATOR }, ctx)).status, 400);
  assert.equal((await l.partnerClaim({ pool: POOL, claimer: 5 }, ctx)).status, 400);
  const other = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({ poolConfig: 'So11111111111111111111111111111111111111112' }).load, maxPerMinute: 1000 });
  assert.equal((await other.partnerClaim({ pool: POOL, claimer: CREATOR }, ctx)).body.error, 'not_an_animalpad_pool');
});

test('server: admin fee routes and the /admin page', async () => {
  const launcher = createLauncher({ presets: PRESETS, logger: quiet, load: fakeChain({}).load });
  await withServer({ feed, launcher }, async base => {
    const f = await fetch(base + '/api/admin/fees');
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('cache-control'), 'no-store');
    assert.equal((await f.json()).pools[0].pool, POOL);
    const c = await fetch(base + '/api/admin/claim', { method: 'POST', body: JSON.stringify({ pool: POOL, claimer: CREATOR }) });
    assert.equal(c.status, 200);
    const bad = await fetch(base + '/api/admin/claim', { method: 'POST', body: JSON.stringify({ pool: POOL, claimer: 'So11111111111111111111111111111111111111112' }) });
    assert.equal(bad.status, 403);
    assert.equal((await fetch(base + '/api/admin/claim')).status, 404);
    const page = await fetch(base + '/admin');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /admin\.js/);
  });
  await withServer({ feed }, async base => {
    assert.equal((await fetch(base + '/api/admin/fees')).status, 503);
  });
});
