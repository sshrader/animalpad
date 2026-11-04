'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLauncher, metadataFor } = require('../launch.js');
const { createApp } = require('../server.js');
const pump = require('../pump.js');
const { fakeLoad } = require('./fakechain.js');

const quiet = { log() {}, error() {} };
const key = () => new (require('./fakeweb3.js').PublicKey)(crypto.randomBytes(32)).toBase58();
const CREATOR = key(), PLATFORM = key(), OTHER = key();
const ctx = { ip: '1.2.3.4', baseUrl: 'https://hatchpad.example' };
const good = { name: 'Salt Lantern', symbol: '$lntrn', creator: CREATOR };
const SIG = '3uQi5xA7Dneip5qac73zDZV4CqysWxAmup8Moy4Rc8L5ro99LVcyeSvYB4GduFNYBJ8yiJJZg8eawjqvkJHJoAHZ';

function make(extra, state) {
  const st = state || {};
  const load = fakeLoad(st);
  st.putGlobal();
  const launcher = createLauncher(Object.assign({ platformWallet: PLATFORM, load, logger: quiet, maxPerMinute: 1000, maxReadsPerMinute: 1000 }, extra));
  return { launcher, st };
}
const tx = b64 => JSON.parse(Buffer.from(b64, 'base64').toString());

test('mainnet needs the explicit switch, a mainnet-looking RPC and matches the cluster', () => {
  const rpc = 'https://mainnet.helius-rpc.com/?api-key=x';
  const base = { platformWallet: PLATFORM };
  assert.throws(() => createLauncher(Object.assign({ cluster: 'mainnet-beta', rpcUrl: rpc }, base)), /switched off/);
  assert.throws(() => createLauncher(Object.assign({ cluster: 'mainnet-beta', allowMainnet: true }, base)), /LAUNCH_RPC_URL/);
  assert.throws(() => createLauncher(Object.assign({ cluster: 'mainnet-beta', allowMainnet: true, rpcUrl: 'https://api.devnet.solana.com' }, base)), /devnet/);
  assert.throws(() => createLauncher(Object.assign({ rpcUrl: 'https://api.mainnet-beta.solana.com' }, base)), /mainnet/);
  assert.throws(() => createLauncher(Object.assign({ cluster: 'moon' }, base)), /Unknown cluster/);
  assert.equal(createLauncher(Object.assign({ cluster: 'mainnet-beta', allowMainnet: true, rpcUrl: rpc }, base)).info().cluster, 'mainnet-beta');
});

test('the fee split is validated, and launching is off without a platform wallet', () => {
  assert.throws(() => createLauncher({ platformWallet: PLATFORM, platformSharePct: 0 }), /PLATFORM_SHARE_PCT/);
  assert.throws(() => createLauncher({ platformWallet: PLATFORM, platformSharePct: 80 }), /PLATFORM_SHARE_PCT/);
  assert.throws(() => createLauncher({ platformWallet: PLATFORM, platformSharePct: 2.5 }), /PLATFORM_SHARE_PCT/);
  const on = createLauncher({ platformWallet: PLATFORM });
  assert.deepEqual(on.info(), { enabled: true, cluster: 'devnet', protocol: 'pump.fun', split: { creatorPct: 80, platformPct: 20 } });
  assert.equal(createLauncher({ platformWallet: PLATFORM, platformSharePct: '30' }).info().split.creatorPct, 70);
  assert.equal(createLauncher({}).info().enabled, false);
});

test('prepare builds an unsigned create transaction signed only by the new mint', async () => {
  const { launcher } = make();
  const r = await launcher.prepare(good, ctx);
  assert.equal(r.status, 200);
  const t = tx(r.body.transaction);
  assert.equal(t.feePayer, CREATOR);
  assert.deepEqual(t.signers, [r.body.mint]);
  assert.equal(t.instructions.filter(i => i.program === pump.PUMP).length, 1);
  assert.equal(r.body.pool, r.body.mint);
  assert.equal(r.body.cluster, 'devnet');
  assert.deepEqual(r.body.split, { creatorPct: 80, platformPct: 20 });
  // the ticker is cleaned, and the metadata link carries name and symbol
  const create = t.instructions.find(i => i.program === pump.PUMP);
  assert.ok(Buffer.from(create.data, 'hex').includes(Buffer.from('LNTRN')));
  assert.ok(Buffer.from(create.data, 'hex').includes(Buffer.from('https://hatchpad.example/meta.json?n=Salt%20Lantern&s=LNTRN')));
});

test('prepare puts the picture id in the metadata link and refuses pictures that do not exist', async () => {
  const { launcher } = make();
  const id = 'b'.repeat(16);
  const c = Object.assign({ hasArt: x => x === id }, ctx);
  const ok = await launcher.prepare(Object.assign({ art: id }, good), c);
  assert.equal(ok.status, 200);
  assert.ok(Buffer.from(tx(ok.body.transaction).instructions.find(i => i.program === pump.PUMP).data, 'hex').toString('latin1').includes('&i=' + id));
  assert.equal((await launcher.prepare(Object.assign({ art: 'c'.repeat(16) }, good), c)).body.error, 'bad_art');
  assert.equal((await launcher.prepare(Object.assign({ art: '../etc' }, good), c)).body.error, 'bad_art');
  assert.equal((await launcher.prepare(Object.assign({ art: id }, good), ctx)).body.error, 'bad_art');
});

test('prepare rejects bad input before touching the network', async () => {
  const { launcher, st } = make();
  const bad = async (over, err) => { const r = await launcher.prepare(Object.assign({}, good, over), ctx); assert.equal(r.status, 400); assert.equal(r.body.error, err); };
  await bad({ name: '' }, 'bad_name');
  await bad({ name: '‮​' }, 'bad_name');
  await bad({ symbol: 'WAYTOOLONGSYMBOL' }, 'bad_symbol');
  await bad({ symbol: '<b>' }, 'bad_symbol');
  await bad({ creator: 'nope' }, 'bad_creator');
  await bad({ creator: undefined }, 'bad_creator');
  await bad({ firstBuySol: 0.001 }, 'bad_amount');
  await bad({ firstBuySol: 50 }, 'bad_amount');
  await bad({ firstBuySol: 'abc' }, 'bad_amount');
  const long = await launcher.prepare(Object.assign({}, good, { name: 'N'.repeat(32) }), { ip: 'x', baseUrl: 'https://' + 'a'.repeat(180) + '.example.com' });
  assert.equal(long.body.error, 'uri_too_long');
  assert.equal((await launcher.prepare(good, { ip: 'x', baseUrl: '' })).status, 400);
  assert.equal((await launcher.prepare(null, ctx)).status, 400);
  assert.equal(st.sent.length, 0);
});

test('name text is cleaned of control and bidi characters', async () => {
  const { launcher } = make();
  const r = await launcher.prepare(Object.assign({}, good, { name: 'Sa‮lt\u0000 ​Lantern' }), ctx);
  assert.equal(r.status, 200);
  assert.ok(Buffer.from(tx(r.body.transaction).instructions.find(i => i.program === pump.PUMP).data, 'hex').includes(Buffer.from('Salt Lantern')));
});

test('prepare is rate limited per address, and failures are generic', async () => {
  const { launcher } = make({ maxPerMinute: 2 });
  assert.equal((await launcher.prepare(good, ctx)).status, 200);
  assert.equal((await launcher.prepare(good, ctx)).status, 200);
  assert.equal((await launcher.prepare(good, ctx)).status, 429);
  assert.equal((await launcher.prepare(good, { ip: '9.9.9.9', baseUrl: ctx.baseUrl })).status, 200);
  const broken = createLauncher({ platformWallet: PLATFORM, logger: quiet, load: async () => { throw new Error('secret rpc key in message'); } });
  const r = await broken.prepare(good, ctx);
  assert.equal(r.status, 502);
  assert.equal(JSON.stringify(r.body).includes('secret'), false);
});

test('the founder picture can only be launched by the founder wallet', async () => {
  const { launcher } = make();
  const id = 'f'.repeat(16);
  const c = Object.assign({ hasArt: x => x === id, founder: { id, wallet: CREATOR } }, ctx);
  assert.equal((await launcher.prepare(Object.assign({ art: id }, good, { creator: OTHER }), c)).body.error, 'founder_only');
  assert.equal((await launcher.prepare(Object.assign({ art: id }, good), c)).status, 200);
});

test('step: waits for the coin, then asks for the fee split, then the first buy, then is done', async () => {
  const { launcher, st } = make();
  const mint = key();
  const input = { mint, creator: CREATOR, firstBuySol: 0.5 };
  assert.equal((await launcher.step(input, ctx)).body.step, 'waiting');

  st.putCurve(mint, { creator: CREATOR });
  const split = await launcher.step(input, ctx);
  assert.equal(split.body.step, 'split');
  const t = tx(split.body.transaction);
  assert.equal(t.feePayer, CREATOR);
  assert.equal(t.instructions.filter(i => i.program === pump.PUMP_FEES).length, 2); // create sharing config + set shares
  // 80/20 as the second instruction's data: vec of 2 shareholders
  const set = Buffer.from(t.instructions.filter(i => i.program === pump.PUMP_FEES)[1].data, 'hex');
  assert.equal(set.readUInt32LE(8), 2);
  assert.equal(set.readUInt16LE(8 + 4 + 32), 8000);
  assert.equal(set.readUInt16LE(8 + 4 + 34 + 32), 2000);
  assert.ok(t.instructions.filter(i => i.program === pump.PUMP_FEES)[1].keys >= 20, 'the current shareholder is passed along');

  st.putCurve(mint, { creator: st.B.sharingConfigOf(mint).toBase58() });
  const buy = await launcher.step(input, ctx);
  assert.equal(buy.body.step, 'buy');
  const bt = tx(buy.body.transaction);
  assert.equal(bt.instructions.filter(i => i.program === pump.PUMP).length, 1);
  const buyData = Buffer.from(bt.instructions.filter(i => i.program === pump.PUMP)[0].data, 'hex');
  assert.equal(buyData.readBigUInt64LE(8), 500000000n);
  assert.ok(buyData.readBigUInt64LE(16) > 0n);

  st.tokens.set(st.B.ata(CREATOR, mint, pump.TOKEN_2022).toBase58(), '123456');
  assert.equal((await launcher.step(input, ctx)).body.step, 'done');
  assert.equal((await launcher.step({ mint, creator: CREATOR }, ctx)).body.step, 'done');
});

test('step: a split of 100% when the creator is the platform wallet, and nobody else can build steps for another creator', async () => {
  const { launcher, st } = make();
  const mint = key();
  st.putCurve(mint, { creator: PLATFORM });
  const own = await launcher.step({ mint, creator: PLATFORM }, ctx);
  assert.equal(own.body.step, 'split');
  const set = Buffer.from(tx(own.body.transaction).instructions.filter(i => i.program === pump.PUMP_FEES)[1].data, 'hex');
  assert.equal(set.readUInt32LE(8), 1);
  assert.equal(set.readUInt16LE(8 + 4 + 32), 10000);
  const stranger = await launcher.step({ mint, creator: OTHER }, ctx);
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, 'not_creator');
  assert.equal((await launcher.step({ mint: 'x', creator: CREATOR }, ctx)).body.error, 'bad_mint');
  assert.equal((await launcher.step({ mint, creator: 'x' }, ctx)).body.error, 'bad_creator');
  assert.equal((await launcher.step({ mint, creator: CREATOR, firstBuySol: 99 }, ctx)).body.error, 'bad_amount');
});

test('status reports pending, confirmed and failed, and rejects junk signatures', async () => {
  const { launcher, st } = make();
  assert.equal((await launcher.status(SIG, ctx)).body.state, 'pending');
  st.statuses.set(SIG, { confirmationStatus: 'processed' });
  assert.equal((await launcher.status(SIG, ctx)).body.state, 'pending');
  st.statuses.set(SIG, { confirmationStatus: 'confirmed' });
  assert.equal((await launcher.status(SIG, ctx)).body.state, 'confirmed');
  st.statuses.set(SIG, { err: {}, confirmationStatus: 'confirmed' });
  assert.equal((await launcher.status(SIG, ctx)).body.state, 'failed');
  assert.equal((await launcher.status('nope', ctx)).status, 400);
});

test('inspect shows curve progress, market cap and whether the fee split is in place', async () => {
  const { launcher, st } = make();
  const mint = key();
  assert.equal((await launcher.inspect(mint)).status, 404);
  st.putCurve(mint, { creator: CREATOR, real_token_reserves: 396550000000000n, real_quote_reserves: 20000000000n });
  const r = await launcher.inspect(mint);
  assert.equal(r.status, 200);
  assert.equal(r.body.address, mint);
  assert.ok(Math.abs(r.body.progress - 0.5) < 0.001);
  assert.equal(r.body.raisedSol, 20);
  assert.ok(r.body.thresholdSol > 84 && r.body.thresholdSol < 86);
  assert.ok(r.body.marketCapSol > 27 && r.body.marketCapSol < 29, String(r.body.marketCapSol));
  assert.equal(r.body.splitOk, false);
  assert.equal(r.body.migrated, false);
  st.putCurve(mint, { creator: st.B.sharingConfigOf(mint).toBase58(), complete: true, real_token_reserves: 0n });
  const done = await launcher.inspect(mint);
  assert.equal(done.body.splitOk, true);
  assert.equal(done.body.curveFull, true);
  assert.equal(done.body.progress, 1);
  assert.equal((await launcher.inspect('nope')).status, 400);
  // an account that is not owned by pump.fun is not a coin
  st.accounts.set(st.B.bondingCurveOf(mint).toBase58(), Object.assign({}, st.accounts.get(st.B.bondingCurveOf(mint).toBase58()), { owner: key() }));
  assert.equal((await launcher.inspect(mint)).status, 404);
});

test('buy prepares an unsigned buy with a safety minimum, and refuses full or missing coins', async () => {
  const { launcher, st } = make();
  const mint = key();
  const body = over => Object.assign({ pool: mint, buyer: CREATOR, sol: 0.1 }, over);
  assert.equal((await launcher.buy(body(), ctx)).status, 404);
  st.putCurve(mint, { creator: key() });
  const r = await launcher.buy(body(), ctx);
  assert.equal(r.status, 200);
  const t = tx(r.body.transaction);
  assert.equal(t.feePayer, CREATOR);
  const ix = t.instructions.filter(i => i.program === pump.PUMP)[0];
  const d = Buffer.from(ix.data, 'hex');
  assert.equal(d.readBigUInt64LE(8), 100000000n);
  const minOut = d.readBigUInt64LE(16);
  const noFee = pump.tokensForQuote(1073000000000000n, 30000000000n, 100000000n);
  assert.ok(minOut > 0n && minOut < noFee, 'the minimum is below the fee-free quote');
  assert.ok(minOut > noFee * 90n / 100n, 'but not absurdly loose');
  assert.equal(ix.keys, 17);
  assert.equal((await launcher.buy(body({ sol: 0.001 }), ctx)).body.error, 'bad_amount');
  assert.equal((await launcher.buy(body({ sol: 99 }), ctx)).body.error, 'bad_amount');
  assert.equal((await launcher.buy(body({ pool: 'x' }), ctx)).body.error, 'bad_pool');
  assert.equal((await launcher.buy(body({ buyer: 'x' }), ctx)).body.error, 'bad_buyer');
  st.putCurve(mint, { creator: key(), complete: true });
  assert.equal((await launcher.buy(body(), ctx)).body.error, 'migrated');
});

test('buys are rate limited, and chain failures give a generic error', async () => {
  const { launcher, st } = make({ maxPerMinute: 1 });
  const mint = key();
  st.putCurve(mint, { creator: key() });
  assert.equal((await launcher.buy({ pool: mint, buyer: CREATOR, sol: 0.1 }, ctx)).status, 200);
  assert.equal((await launcher.buy({ pool: mint, buyer: CREATOR, sol: 0.1 }, ctx)).status, 429);
  const broken = createLauncher({ platformWallet: PLATFORM, logger: quiet, load: async () => { throw new Error('secret'); } });
  const r = await broken.buy({ pool: mint, buyer: CREATOR, sol: 0.1 }, ctx);
  assert.equal(r.status, 502);
  assert.equal(JSON.stringify(r.body).includes('secret'), false);
});

test('fees adds what waits on the curve to what sits in the fee vault', async () => {
  const { launcher, st } = make();
  const mint = key();
  const sharing = st.B.sharingConfigOf(mint).toBase58();
  st.putCurve(mint, { creator: sharing, creator_fee: 2000000n });
  st.accounts.set(st.B.creatorVaultOf(sharing).toBase58(), { data: Buffer.alloc(0), lamports: 1000000 + 3000000 });
  const r = await launcher.fees(mint, ctx);
  assert.equal(r.status, 200);
  assert.equal(r.body.pendingSol, 0.005);
  assert.equal(r.body.splitOk, true);
  assert.equal(r.body.platformPct, 20);
  st.putCurve(mint, { creator: CREATOR });
  assert.equal((await launcher.fees(mint, ctx)).body.splitOk, false);
  assert.equal((await launcher.fees('nope', ctx)).status, 400);
  assert.equal((await launcher.fees(key(), ctx)).status, 404);
});

test('distribute builds a sweep and payout to the shareholders in the stored order, only when there is something to send', async () => {
  const { launcher, st } = make();
  const mint = key();
  const sharing = st.B.sharingConfigOf(mint).toBase58();
  const body = over => Object.assign({ pool: mint, payer: OTHER }, over);
  assert.equal((await launcher.distribute(body(), ctx)).status, 404);
  st.putCurve(mint, { creator: CREATOR, creator_fee: 5000000n });
  assert.equal((await launcher.distribute(body(), ctx)).body.error, 'split_not_set');
  st.putCurve(mint, { creator: sharing, creator_fee: 0n });
  st.putSharing(mint, [{ address: CREATOR, bps: 8000 }, { address: PLATFORM, bps: 2000 }]);
  assert.equal((await launcher.distribute(body(), ctx)).body.error, 'nothing_to_claim');
  st.putCurve(mint, { creator: sharing, creator_fee: 5000000n });
  const r = await launcher.distribute(body(), ctx);
  assert.equal(r.status, 200);
  assert.equal(r.body.waitingSol, 0.005);
  const t = tx(r.body.transaction);
  assert.equal(t.feePayer, OTHER);
  const pumpIx = t.instructions.filter(i => i.program === pump.PUMP);
  assert.equal(pumpIx.length, 2);
  assert.equal(pumpIx[0].keys, 13);      // sweep_creator_fee
  assert.equal(pumpIx[1].keys, 12 + 2);  // distribute_creator_fees_v2 + two shareholders
  st.putCurve(mint, { creator: sharing, creator_fee: 5000000n, complete: true });
  assert.equal((await launcher.distribute(body(), ctx)).body.error, 'migrated');
  assert.equal((await launcher.distribute(body({ payer: 'x' }), ctx)).status, 400);
});

test('partner fees: the platform share of every coin that has its split in place', async () => {
  const { launcher, st } = make();
  const a = key(), b = key(), c = key();
  const sA = st.B.sharingConfigOf(a).toBase58();
  st.putCurve(a, { creator: sA, creator_fee: 10000000n });
  st.putCurve(b, { creator: CREATOR, creator_fee: 99000000n }); // split never set: not counted
  const r = await launcher.partnerFees({ ip: 'z', mints: [a, b, c] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.feeClaimers, [PLATFORM]);
  assert.equal(r.body.pools.length, 1);
  assert.equal(r.body.pools[0].pool, a);
  assert.ok(Math.abs(r.body.pools[0].waitingSol - 0.002) < 1e-9);
  assert.ok(Math.abs(r.body.totalWaitingSol - 0.002) < 1e-9);
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
  const { launcher, st } = make();
  await withServer({ feed, launcher }, async base => {
    const cfg = await (await fetch(base + '/api/launch/config')).json();
    assert.deepEqual(cfg, { enabled: true, cluster: 'devnet', protocol: 'pump.fun', split: { creatorPct: 80, platformPct: 20 } });
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const ok = await post('/api/launch/prepare', JSON.stringify(good));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const data = await ok.json();
    assert.match(data.transaction, /^[A-Za-z0-9+/=]+$/);
    assert.equal((await post('/api/launch/prepare', '{not json')).status, 400);
    assert.equal((await post('/api/launch/prepare', 'x'.repeat(5000))).status, 400);
    // the next-step route
    st.putCurve(data.mint, { creator: CREATOR });
    const step = await (await post('/api/launch/step', JSON.stringify({ mint: data.mint, creator: CREATOR }))).json();
    assert.equal(step.step, 'split');
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/launch/prepare')).status, 404);
  });
});

test('server: launching is off without a launcher, and meta.json serves metadata', async () => {
  await withServer({ feed }, async base => {
    assert.equal((await (await fetch(base + '/api/launch/config')).json()).enabled, false);
    assert.equal((await fetch(base + '/api/launch/prepare', { method: 'POST', body: '{}' })).status, 503);
    const m = await fetch(base + '/meta.json?n=Salt%20Lantern&s=LNTRN');
    assert.equal(m.status, 200);
    assert.equal((await m.json()).symbol, 'LNTRN');
    assert.equal((await fetch(base + '/meta.json?n=x&s=%3Cb%3E')).status, 400);
  });
});

test('server: status, pool, fees, buy and payout routes', async () => {
  const { launcher, st } = make();
  const mint = key();
  const sharing = st.B.sharingConfigOf(mint).toBase58();
  st.putCurve(mint, { creator: sharing, creator_fee: 5000000n });
  st.putSharing(mint, [{ address: CREATOR, bps: 8000 }, { address: PLATFORM, bps: 2000 }]);
  st.statuses.set(SIG, { confirmationStatus: 'finalized' });
  await withServer({ feed, launcher }, async base => {
    assert.equal((await (await fetch(base + '/api/launch/status?sig=' + SIG)).json()).state, 'confirmed');
    assert.equal((await fetch(base + '/api/launch/status?sig=junk')).status, 400);
    const pool = await fetch(base + '/api/launch/pool?address=' + mint);
    assert.equal(pool.status, 200);
    assert.equal((await pool.json()).splitOk, true);
    const fees = await (await fetch(base + '/api/launch/fees?address=' + mint)).json();
    assert.equal(fees.pendingSol, 0.005);
    const post = (p, o) => fetch(base + p, { method: 'POST', body: JSON.stringify(o) });
    assert.equal((await post('/api/launch/buy', { pool: mint, buyer: CREATOR, sol: 0.1 })).status, 200);
    const claim = await post('/api/launch/claim', { pool: mint, creator: OTHER });
    assert.equal(claim.status, 200);
    assert.equal(tx((await claim.json()).transaction).feePayer, OTHER, 'the wallet that asks pays the network fee');
    const asPayer = await post('/api/launch/claim', { pool: mint, payer: CREATOR });
    assert.equal(tx((await asPayer.json()).transaction).feePayer, CREATOR);
  });
  await withServer({ feed }, async base => {
    assert.equal((await fetch(base + '/api/launch/status?sig=' + SIG)).status, 503);
    assert.equal((await fetch(base + '/api/launch/pool?address=' + mint)).status, 503);
    assert.equal((await fetch(base + '/api/launch/fees?address=' + mint)).status, 503);
    assert.equal((await fetch(base + '/api/launch/buy', { method: 'POST', body: '{}' })).status, 503);
  });
});

test('server: admin fee routes and the /admin page', async () => {
  const { launcher, st } = make();
  const mint = key();
  const sharing = st.B.sharingConfigOf(mint).toBase58();
  st.putCurve(mint, { creator: sharing, creator_fee: 5000000n });
  st.putSharing(mint, [{ address: CREATOR, bps: 8000 }, { address: PLATFORM, bps: 2000 }]);
  const launches = { list: async () => [{ pool: mint }] };
  await withServer({ feed, launcher, launches }, async base => {
    const f = await fetch(base + '/api/admin/fees');
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('cache-control'), 'no-store');
    const body = await f.json();
    assert.equal(body.pools[0].pool, mint);
    assert.deepEqual(body.feeClaimers, [PLATFORM]);
    const c = await fetch(base + '/api/admin/claim', { method: 'POST', body: JSON.stringify({ pool: mint, claimer: PLATFORM }) });
    assert.equal(c.status, 200);
    assert.equal((await fetch(base + '/api/admin/claim')).status, 404);
    const page = await fetch(base + '/admin');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /admin\.js/);
  });
  await withServer({ feed }, async base => {
    assert.equal((await fetch(base + '/api/admin/fees')).status, 503);
  });
});
