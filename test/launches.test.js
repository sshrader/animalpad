'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLaunches } = require('../launches.js');
const { createLauncher } = require('../launch.js');
const { createArt } = require('../art.js');
const { createApp } = require('../server.js');

const quiet = { log() {}, error() {} };
const CREATOR = 'CFyapVaq8njp4N6Qqrw7XETB89GuLkLwHH6huUtcY4Ws';
// Valid-looking base58 addresses that differ from each other.
const addr = n => 'DojAhuYsxpdukJMuhZX7MYML2967tBCGfJPeByxs5D' + String(n).padStart(2, '1').slice(-2).replace(/0/g, 'a');
const entry = (n, extra) => Object.assign({ pool: addr(n) + 'Q'.repeat(0), mint: addr(n + 50), name: 'Animal ' + n, symbol: 'AN' + n, creator: CREATOR, art: '', preset: 'standard' }, extra);

// A fake chain: pools in `onChain` exist, everything else is "not found".
const chain = (onChain, opt) => async address => {
  if (opt && opt.broken) return { status: 502, body: { error: 'pool_read_failed' } };
  return onChain.has(address)
    ? { status: 200, body: { address, raisedSol: 0.25, thresholdSol: 1, progress: 0.25, migrated: false, curveFull: false } }
    : { status: 404, body: { error: 'pool_not_found' } };
};

test('only launches that exist on-chain are listed, newest first', async () => {
  let t = 1000000;
  const onChain = new Set([entry(1).pool, entry(3).pool]);
  const l = createLaunches({ inspect: chain(onChain), now: () => t, logger: quiet, listTtlMs: 0 });
  for (const n of [1, 2, 3]) { assert.equal(l.record(entry(n)), true); t += 1000; }
  const items = await l.list();
  assert.deepEqual(items.map(x => x.name), ['Animal 3', 'Animal 1']);
  assert.equal(items[0].raisedSol, 0.25);
  assert.equal(items[0].progress, 0.25);
  assert.equal(items[0].imageUrl, '');
  // pool 2 shows up once it lands on-chain
  onChain.add(entry(2).pool);
  assert.deepEqual((await l.list()).map(x => x.name), ['Animal 3', 'Animal 2', 'Animal 1']);
});

test('bad entries are refused, retries are not duplicated, and the picture link comes from the art store', async () => {
  const l = createLaunches({ inspect: chain(new Set([entry(1).pool])), artRecord: id => (id === 'a'.repeat(16) ? { id, ext: 'jpg' } : null), logger: quiet, listTtlMs: 0 });
  assert.equal(l.record(null), false);
  assert.equal(l.record(entry(1, { pool: 'nope' })), false);
  assert.equal(l.record(entry(1, { creator: 'x' })), false);
  assert.equal(l.record(entry(1, { name: 5 })), false);
  assert.equal(l.record(entry(1, { art: 'a'.repeat(16) })), true);
  assert.equal(l.record(entry(1)), true);
  assert.equal(l.size(), 1);
  assert.equal((await l.list())[0].imageUrl, '/art/' + 'a'.repeat(16) + '.jpg');
  const bad = createLaunches({ inspect: chain(new Set([entry(1).pool])), logger: quiet, listTtlMs: 0 });
  bad.record(entry(1, { art: '../../etc/passwd' }));
  assert.equal((await bad.list())[0].imageUrl, '');
});

test('launches never sent are forgotten after a day, but a chain error never drops anything', async () => {
  let t = 1000000;
  const l = createLaunches({ inspect: chain(new Set()), now: () => t, logger: quiet, listTtlMs: 0, unverifiedTtlMs: 5000 });
  l.record(entry(1));
  assert.deepEqual(await l.list(), []);
  assert.equal(l.size(), 1);
  t += 6000;
  assert.deepEqual(await l.list(), []);
  assert.equal(l.size(), 0);
  const e = createLaunches({ inspect: chain(new Set(), { broken: true }), now: () => t, logger: quiet, listTtlMs: 0, unverifiedTtlMs: 1 });
  e.record(entry(1));
  t += 10000;
  await e.list();
  assert.equal(e.size(), 1);
});

test('the last good list is kept when the chain is unreachable, and results are cached briefly', async () => {
  let t = 1000000, calls = 0, broken = false;
  const inspect = async a => { calls++; return broken ? { status: 502, body: {} } : chain(new Set([entry(1).pool]))(a); };
  const l = createLaunches({ inspect, now: () => t, logger: quiet, listTtlMs: 20000 });
  l.record(entry(1));
  assert.equal((await l.list()).length, 1);
  const n = calls;
  await l.list(); await l.list();
  assert.equal(calls, n, 'cached');
  t += 21000; broken = true;
  assert.equal((await l.list()).length, 1, 'stale list kept');
});

test('hidden pools are left out, and the list is capped', async () => {
  const onChain = new Set([1, 2, 3].map(n => entry(n).pool));
  const l = createLaunches({ inspect: chain(onChain), hidden: [entry(2).pool], logger: quiet, listTtlMs: 0, pageSize: 2 });
  let t = 1;
  const l2 = createLaunches({ inspect: chain(onChain), hidden: [entry(2).pool], logger: quiet, listTtlMs: 0, pageSize: 2, now: () => t++ });
  for (const n of [1, 2, 3]) l2.record(entry(n));
  assert.deepEqual((await l2.list()).map(x => x.name), ['Animal 3', 'Animal 1']);
  const capped = createLaunches({ inspect: chain(onChain), logger: quiet, max: 2, now: () => t++ });
  for (const n of [1, 2, 3]) capped.record(entry(n));
  assert.equal(capped.size(), 2);
  assert.ok(l);
});

test('with a file the list survives a restart, and a damaged file is ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ln-'));
  const file = path.join(dir, 'sub', 'launches.json');
  const onChain = new Set([entry(1).pool]);
  const a = createLaunches({ file, inspect: chain(onChain), logger: quiet, listTtlMs: 0 });
  a.record(entry(1));
  await a.list();
  assert.equal(fs.readdirSync(path.dirname(file)).some(f => f.endsWith('.tmp')), false);
  const b = createLaunches({ file, inspect: chain(onChain), logger: quiet, listTtlMs: 0 });
  assert.equal(b.size(), 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].verified, true);
  fs.writeFileSync(file, '{ not json');
  assert.equal(createLaunches({ file, inspect: chain(onChain), logger: quiet }).size(), 0);
  fs.writeFileSync(file, JSON.stringify([{ pool: 'bad' }, entry(1, { createdAt: 5 })]));
  assert.equal(createLaunches({ file, inspect: chain(onChain), logger: quiet }).size(), 1);
});

async function withServer(opts, fn) {
  const srv = createApp(opts);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try { await fn(base); } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
}

test('server: /api/launches lists launches, and a prepared launch is recorded and checked for blocked names', async () => {
  const CONFIG = 'CAAYwzGN4XjofFLZt4iwhMw9L8pH9BY379YjLUo3Qq8o';
  const PRESETS = { network: 'devnet', presets: { standard: { config: CONFIG, totalPct: 1, creatorSharePct: 40 } } };
  const POOL = 'FWUDZaaBrNJDGVzyTnKRhLgrjUeWU4mJdUvfBUmkxWZa', MINT = 'DojAhuYsxpdukJMuhZX7MYML2967tBCGfJPeByxs5DQX';
  class PublicKey { constructor(v) { this.v = v; } toBase58() { return this.v; } }
  const load = async () => ({
    sdk: { DynamicBondingCurveClient: class { constructor() { this.creator = { createPool: async () => ({ partialSign() {}, serialize() { return Buffer.from('TX'); } }) }; } }, deriveDbcPoolAddress: () => new PublicKey(POOL) },
    web3: { PublicKey, Keypair: { generate: () => ({ publicKey: new PublicKey(MINT) }) }, Connection: class { async getLatestBlockhash() { return { blockhash: 'B' }; } } },
    spl: { NATIVE_MINT: new PublicKey('So11111111111111111111111111111111111111112') }
  });
  const launcher = createLauncher({ presets: PRESETS, load, logger: quiet, maxPerMinute: 1000 });
  const onChain = new Set();
  const launches = createLaunches({ inspect: chain(onChain), logger: quiet, listTtlMs: 0 });
  const art = createArt({ logger: quiet });
  await withServer({ art, launcher, launches }, async base => {
    assert.deepEqual(await (await fetch(base + '/api/launches')).json(), { launches: [] });
    const post = name => fetch(base + '/api/launch/prepare', { method: 'POST', body: JSON.stringify({ preset: 'standard', name, symbol: 'SNOOZ', creator: CREATOR }) });
    assert.equal((await post('Pikachu Coin')).status, 400);
    assert.equal(launches.size(), 0);
    assert.equal((await post('Sleepy Heron')).status, 200);
    assert.equal(launches.size(), 1);
    // prepared but not on-chain yet: not listed
    assert.deepEqual((await (await fetch(base + '/api/launches')).json()).launches, []);
    onChain.add(POOL);
    const body = await (await fetch(base + '/api/launches')).json();
    assert.equal(body.launches.length, 1);
    assert.equal(body.launches[0].name, 'Sleepy Heron');
    assert.equal(body.launches[0].symbol, 'SNOOZ');
    assert.equal(body.launches[0].pool, POOL);
  });
  // no registry: an empty list, not an error
  await withServer({ art, launcher }, async base => {
    assert.deepEqual(await (await fetch(base + '/api/launches')).json(), { launches: [] });
  });
});
