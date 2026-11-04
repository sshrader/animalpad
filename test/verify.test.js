'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createVerifier, isPublicAddress, safeLookup, fetchText } = require('../verify.js');
const { createLaunches } = require('../launches.js');
const { createApp } = require('../server.js');
const { createArt } = require('../art.js');

const quiet = { log() {}, error() {} };
const POOL = 'FWUDZaaBrNJDGVzyTnKRhLgrjUeWU4mJdUvfBUmkxWZa', MINT = 'DojAhuYsxpdukJMuhZX7MYML2967tBCGfJPeByxs5DQX';
const CREATOR = 'CFyapVaq8njp4N6Qqrw7XETB89GuLkLwHH6huUtcY4Ws';

test('only public internet addresses are allowed', () => {
  ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'].forEach(a => assert.equal(isPublicAddress(a), true, a));
  ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '198.18.0.1',
   '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'ff02::1', 'not-an-ip'].forEach(a => assert.equal(isPublicAddress(a), false, a));
  assert.equal(isPublicAddress('172.32.0.1'), true);
});

test('the lookup refuses a name that points at a private address', async () => {
  const err = await new Promise(resolve => safeLookup('localhost', {}, e => resolve(e)));
  assert.match(String(err && err.message), /blocked_address/);
});

test('the fetch refuses anything but a plain https site on a name', async () => {
  for (const u of ['http://example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://example.com:8443/', 'https://user:pw@example.com/', 'ftp://example.com/', 'nonsense']) {
    assert.deepEqual(await fetchText(u), { status: 0 }, u);
  }
});

test('the code is specific to the coin, and the check finds it on the site', async () => {
  const seen = [];
  const pages = {};
  const v = createVerifier({ secret: 's', fetchText: async u => { seen.push(u); return pages[u] ? { status: 200, text: pages[u] } : { status: 404 }; } });
  const coin = { pool: POOL, creator: CREATOR, links: { website: 'https://crown.example/about' } };
  const code = v.code(POOL, CREATOR);
  assert.match(code, /^animalpad-[0-9a-f]{20}$/);
  assert.notEqual(code, v.code('other', CREATOR));
  assert.notEqual(code, createVerifier({ secret: 't' }).code(POOL, CREATOR));
  assert.deepEqual((await v.check(coin)).body, { verified: false });
  assert.deepEqual(seen, ['https://crown.example/.well-known/animalpad-verify.txt', 'https://crown.example/about']);
  pages['https://crown.example/.well-known/animalpad-verify.txt'] = 'hello ' + code + '\n';
  assert.deepEqual((await v.check(coin)).body, { verified: true });
  delete pages['https://crown.example/.well-known/animalpad-verify.txt'];
  pages['https://crown.example/about'] = '<p>animalpad-0000000000000000000a</p>'; // someone else's code
  assert.deepEqual((await v.check(coin)).body, { verified: false });
  pages['https://crown.example/about'] = '<footer>' + code + '</footer>';
  assert.deepEqual((await v.check(coin)).body, { verified: true });
  assert.equal((await v.check({ pool: POOL, creator: CREATOR, links: {} })).body.error, 'no_website');
  assert.equal((await v.check({ pool: POOL, creator: CREATOR, links: { website: 'http://plain.example' } })).body.error, 'needs_https');
});

async function withServer(opts, fn) {
  const srv = createApp(Object.assign({ art: createArt({ logger: quiet }) }, opts));
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try { await fn(base); } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
}

test('server: unverified websites get a code, a passing check is remembered, and checks are rate limited', async () => {
  const id = 'a'.repeat(16);
  const rec = { id, ext: 'png', description: 'A heron.', links: { website: 'https://crown.example' } };
  const launches = createLaunches({ inspect: async () => ({ status: 200, body: { progress: 0.1, raisedSol: 0.1, thresholdSol: 1 } }), artRecord: i => (i === id ? rec : null), logger: quiet, listTtlMs: 0 });
  launches.record({ pool: POOL, mint: MINT, name: 'Crown Heron', symbol: 'CROWN', creator: CREATOR, art: id, preset: 'standard' });
  let live = false;
  const verifier = createVerifier({ secret: 's', fetchText: async () => (live ? { status: 200, text: createVerifier({ secret: 's' }).code(POOL, CREATOR) } : { status: 404 }) });
  await withServer({ launches, verifier }, async base => {
    const get = async () => (await fetch(base + '/api/launches/' + POOL)).json();
    const first = await get();
    assert.equal(first.siteVerified, false);
    assert.equal(first.verifyCode, verifier.code(POOL, CREATOR));
    const post = body => fetch(base + '/api/coin/verify', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post({ pool: 'bad' })).status, 400);
    assert.equal((await post({ pool: 'B'.repeat(43) })).status, 404);
    const miss = await post({ pool: POOL });
    assert.deepEqual(await miss.json(), { verified: false });
    assert.equal((await post({ pool: POOL })).status, 429);          // the same coin again within 20 seconds
    assert.equal((await get()).siteVerified, false);
  });
  await withServer({ launches, verifier }, async base => {
    live = true;
    const ok = await fetch(base + '/api/coin/verify', { method: 'POST', body: JSON.stringify({ pool: POOL }) });
    assert.deepEqual(await ok.json(), { verified: true });
    const after = await (await fetch(base + '/api/launches/' + POOL)).json();
    assert.equal(after.siteVerified, true);
    assert.equal(after.verifyCode, undefined);
  });
});
