'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createArt } = require('../art.js');
const { createLauncher, metadataFor } = require('../launch.js');
const { createApp } = require('../server.js');

const quiet = { log() {}, error() {} };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(300, 7)]);
const CONFIG = 'CAAYwzGN4XjofFLZt4iwhMw9L8pH9BY379YjLUo3Qq8o';
const CREATOR = 'CFyapVaq8njp4N6Qqrw7XETB89GuLkLwHH6huUtcY4Ws';
const PRESETS = { network: 'devnet', presets: { standard: { config: CONFIG, totalPct: 1, creatorSharePct: 40 } } };

// A fake OpenAI. `opt` can break pieces of it.
function fakeOpenAI(opt) {
  const o = opt || {};
  const seen = [];
  const impl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, body, auth: init.headers.Authorization });
    const json = v => ({ ok: true, status: 200, json: async () => v });
    if (/images\/generations/.test(url)) {
      if (o.imageStatus) return { ok: false, status: o.imageStatus, json: async () => ({}) };
      return json({ data: [{ b64_json: (o.badImage ? Buffer.from('not a png at all, just text'.repeat(10)) : PNG).toString('base64') }] });
    }
    if (o.textStatus) return { ok: false, status: o.textStatus, json: async () => ({}) };
    return json({ choices: [{ message: { content: o.textContent || JSON.stringify({ name: 'Sleepy Heron', ticker: 'snooz', description: 'A heron that naps through every rally.' }) } }] });
  };
  return { impl, seen };
}

const make = (opt, extra) => {
  const f = fakeOpenAI(opt);
  return { f, art: createArt(Object.assign({ apiKey: 'sk-test', fetchImpl: f.impl, logger: quiet }, extra)) };
};

test('generate returns a stored picture with a name, ticker and description', async () => {
  const { f, art } = make();
  const r = await art.generate({ animal: 'a tired heron in a tiny crown' }, { ip: '1.1.1.1' });
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^[0-9a-f]{16}$/);
  assert.equal(r.body.imageUrl, '/art/' + r.body.id + '.png');
  assert.equal(r.body.name, 'Sleepy Heron');
  assert.equal(r.body.ticker, 'SNOOZ');
  assert.ok(art.get(r.body.id).equals(PNG));
  assert.equal(art.record(r.body.id).description, 'A heron that naps through every rally.');
  const img = f.seen.find(x => /images/.test(x.url));
  assert.equal(img.auth, 'Bearer sk-test');
  assert.equal(img.body.model, 'gpt-image-1');
  assert.match(img.body.prompt, /tired heron/);
  assert.match(img.body.prompt, /not based on any existing/);
  assert.equal(art.get('zzzz'), null);
});

test('the studio is off without a key and the key is never in a response', async () => {
  const art = createArt({ logger: quiet });
  assert.deepEqual(art.info(), { enabled: false });
  assert.equal((await art.generate({ animal: 'a heron' }, {})).status, 503);
  const { art: on } = make();
  assert.equal(JSON.stringify((await on.generate({ animal: 'a heron' }, {})).body).includes('sk-test'), false);
});

test('bad, blocked and abusive prompts are stopped before any paid call', async () => {
  const { f, art } = make();
  assert.equal((await art.generate({ animal: 'x' }, {})).body.error, 'bad_prompt');
  assert.equal((await art.generate({}, {})).body.error, 'bad_prompt');
  assert.equal((await art.generate({ animal: 'a yellow Pikachu on a skateboard' }, {})).body.error, 'blocked_prompt');
  assert.equal((await art.generate({ animal: 'elon musk as a frog' }, {})).body.error, 'blocked_prompt');
  assert.equal(f.seen.length, 0);
  const long = await art.generate({ animal: 'heron '.repeat(100) }, {});
  assert.equal(long.status, 200);
  assert.ok(f.seen[0].body.prompt.length < 400);
  const ctrl = await art.generate({ animal: 'a‮ heron\u0000 with hat' }, {});
  assert.equal(ctrl.status, 200);
  assert.ok(!/[‮\u0000]/.test(f.seen[2].body.prompt));
});

test('generation is limited per address per hour and per day', async () => {
  let t = 1000000000000;
  const { art } = make({}, { perIpPerHour: 2, dailyCap: 3, now: () => t });
  assert.equal((await art.generate({ animal: 'a heron' }, { ip: 'a' })).status, 200);
  assert.equal((await art.generate({ animal: 'a heron' }, { ip: 'a' })).status, 200);
  assert.equal((await art.generate({ animal: 'a heron' }, { ip: 'a' })).body.error, 'rate_limited');
  assert.equal((await art.generate({ animal: 'a heron' }, { ip: 'b' })).status, 200);
  assert.equal((await art.generate({ animal: 'a heron' }, { ip: 'c' })).body.error, 'daily_limit');
  t += 86400000 + 1;
  assert.equal((await art.generate({ animal: 'a heron' }, { ip: 'a' })).status, 200);
});

test('a failed image gives a generic error; a failed or unsafe name falls back', async () => {
  const bad = make({ imageStatus: 500 }).art;
  const r = await bad.generate({ animal: 'a heron' }, {});
  assert.deepEqual(r, { status: 502, body: { error: 'generation_failed' } });
  assert.equal((await make({ badImage: true }).art.generate({ animal: 'a heron' }, {})).status, 502);

  const noText = await make({ textStatus: 500 }).art.generate({ animal: 'a sleepy heron' }, {});
  assert.equal(noText.status, 200);
  assert.equal(noText.body.name, 'Sleepy Heron');
  assert.equal(noText.body.ticker, 'HERON');
  assert.equal(noText.body.description, 'A sleepy heron.');
  assert.match(noText.body.ticker, /^[A-Z0-9]{1,10}$/);

  const unsafe = await make({ textContent: JSON.stringify({ name: 'Pikachu Coin', ticker: 'PIKA', description: 'x' }) }).art.generate({ animal: 'a sleepy heron' }, {});
  assert.equal(unsafe.body.name, 'Sleepy Heron');
  const junk = await make({ textContent: 'not json' }).art.generate({ animal: 'a sleepy heron' }, {});
  assert.equal(junk.status, 200);
  const badTicker = await make({ textContent: JSON.stringify({ name: 'Ok', ticker: 'has space!', description: 'x' }) }).art.generate({ animal: 'a sleepy heron' }, {});
  assert.equal(badTicker.body.name, 'Sleepy Heron');
});

test('the store keeps only the most recent pictures', async () => {
  let n = 0;
  const f = async (url, init) => {
    const json = v => ({ ok: true, status: 200, json: async () => v });
    if (/images/.test(url)) return json({ data: [{ b64_json: Buffer.concat([PNG, Buffer.from(String(n++))]).toString('base64') }] });
    return json({ choices: [{ message: { content: JSON.stringify({ name: 'N', ticker: 'NNN', description: 'd' }) } }] });
  };
  const art = createArt({ apiKey: 'k', fetchImpl: f, logger: quiet, maxStored: 2, perIpPerHour: 100, dailyCap: 100 });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await art.generate({ animal: 'a heron' }, {})).body.id);
  assert.equal(art.get(ids[0]), null);
  assert.ok(art.get(ids[1]) && art.get(ids[2]));
});

test('metadata carries the picture and description when there is a stored animal', () => {
  const m = metadataFor('Sleepy Heron', 'snooz', { id: 'a'.repeat(16), description: 'Naps.' }, 'https://x.example');
  assert.deepEqual(m, { name: 'Sleepy Heron', symbol: 'SNOOZ', description: 'Naps.', image: 'https://x.example/art/' + 'a'.repeat(16) + '.png' });
  assert.equal(metadataFor('', 'X', null, ''), null);
  assert.equal(metadataFor('Ok', 'X', null, 'https://x.example').image, '');
});

test('prepare puts the picture id in the metadata link and refuses pictures that do not exist', async () => {
  const calls = [];
  class PublicKey { constructor(v) { this.v = v; } toBase58() { return this.v; } }
  const load = async () => ({
    sdk: { DynamicBondingCurveClient: class { constructor() { this.creator = { createPool: async p => { calls.push(p); return { partialSign() {}, serialize() { return Buffer.from('TX'); } }; } }; } }, deriveDbcPoolAddress: () => new PublicKey('PoolAddress11111111111111111111111111111111') },
    web3: { PublicKey, Keypair: { generate: () => ({ publicKey: new PublicKey('Mint1111111111111111111111111111111111111111') }) }, Connection: class { async getLatestBlockhash() { return { blockhash: 'B' }; } } },
    spl: { NATIVE_MINT: new PublicKey('So11111111111111111111111111111111111111112') }
  });
  const l = createLauncher({ presets: PRESETS, load, logger: quiet });
  const id = 'b'.repeat(16);
  const ctx = { ip: '9.9.9.9', baseUrl: 'https://animal.example', hasArt: x => x === id };
  const ok = await l.prepare({ preset: 'standard', name: 'Sleepy Heron', symbol: 'SNOOZ', creator: CREATOR, art: id }, ctx);
  assert.equal(ok.status, 200);
  assert.equal(calls[0].uri, 'https://animal.example/meta.json?n=Sleepy%20Heron&s=SNOOZ&i=' + id);
  assert.equal((await l.prepare({ preset: 'standard', name: 'A', symbol: 'A', creator: CREATOR, art: 'c'.repeat(16) }, ctx)).body.error, 'bad_art');
  assert.equal((await l.prepare({ preset: 'standard', name: 'A', symbol: 'A', creator: CREATOR, art: '../etc' }, ctx)).body.error, 'bad_art');
  assert.equal((await l.prepare({ preset: 'standard', name: 'A', symbol: 'A', creator: CREATOR, art: id }, { ip: '8.8.8.8', baseUrl: 'https://animal.example' })).body.error, 'bad_art');
});

async function withServer(opts, fn) {
  const srv = createApp(opts);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try { await fn(base); } finally { srv.closeAllConnections(); await new Promise(r => srv.close(r)); }
}

test('server: studio routes, picture serving and metadata with the picture', async () => {
  const { art } = make();
  await withServer({ art }, async base => {
    assert.deepEqual(await (await fetch(base + '/api/art/config')).json(), { enabled: true });
    assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, art: true });
    const res = await fetch(base + '/api/art/generate', { method: 'POST', body: JSON.stringify({ animal: 'a tired heron' }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const data = await res.json();
    const img = await fetch(base + data.imageUrl);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(img.headers.get('cache-control'), /immutable/);
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(PNG));
    assert.equal((await fetch(base + '/art/' + 'f'.repeat(16) + '.png')).status, 404);
    assert.equal((await fetch(base + '/art/../server.js')).status, 404);
    assert.equal((await fetch(base + '/art/abc.png')).status, 404);
    const meta = await (await fetch(base + '/meta.json?n=Sleepy%20Heron&s=SNOOZ&i=' + data.id)).json();
    assert.equal(meta.image, base + '/art/' + data.id + '.png');
    assert.equal(meta.description, data.description);
    const noArt = await (await fetch(base + '/meta.json?n=Ok&s=OK&i=' + 'e'.repeat(16))).json();
    assert.equal(noArt.image, '');
    assert.equal((await fetch(base + '/api/art/generate', { method: 'POST', body: '{nope' })).status, 400);
    assert.equal((await fetch(base + '/api/art/generate', { method: 'POST', body: JSON.stringify({ animal: 'x'.repeat(2000) }) })).status, 400);
    assert.equal((await fetch(base + '/api/art/generate')).status, 404);
  });
  await withServer({ art: createArt({ logger: quiet }) }, async base => {
    assert.deepEqual(await (await fetch(base + '/api/art/config')).json(), { enabled: false });
    assert.equal((await fetch(base + '/api/art/generate', { method: 'POST', body: JSON.stringify({ animal: 'a heron' }) })).status, 503);
  });
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('with a folder, pictures survive a restart; launched ones are kept and unlaunched ones expire', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  let t = 1700000000000;
  const f = fakeOpenAI();
  const mk = () => createArt({ apiKey: 'k', fetchImpl: f.impl, logger: quiet, dir, now: () => t, perIpPerHour: 100, dailyCap: 100 });
  const a = mk();
  const r = await a.generate({ animal: 'a heron' }, {});
  const id = r.body.id;
  assert.ok(fs.existsSync(path.join(dir, id + '.png')) && fs.existsSync(path.join(dir, id + '.json')));
  assert.equal(fs.readdirSync(dir).some(x => x.endsWith('.tmp')), false);

  const b = mk(); // a fresh server reading the same folder
  assert.ok(b.get(id).equals(PNG));
  assert.equal(b.record(id).name, 'Sleepy Heron');
  assert.equal(b.record(id).pinned, false);

  assert.equal(b.pin(id), true);
  assert.equal(b.pin('0'.repeat(16)), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')).pinned, true);
  assert.equal(mk().record(id).pinned, true);

  // a second picture that is never launched
  const png2 = Buffer.concat([PNG, Buffer.from('second')]);
  const f2 = async (url, init) => /images/.test(url)
    ? { ok: true, status: 200, json: async () => ({ data: [{ b64_json: png2.toString('base64') }] }) }
    : f.impl(url, init);
  const c = createArt({ apiKey: 'k', fetchImpl: f2, logger: quiet, dir, now: () => t, perIpPerHour: 100, dailyCap: 100 });
  const id2 = (await c.generate({ animal: 'a frog' }, {})).body.id;
  assert.notEqual(id2, id);
  t += 86400000 + 1000;
  const d = mk();
  d.prune();
  assert.equal(d.get(id2), null);
  assert.equal(fs.existsSync(path.join(dir, id2 + '.png')), false);
  assert.ok(d.get(id).equals(PNG), 'the launched picture is kept');
});

test('ids cannot reach other files, and a folder that cannot be used falls back to memory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'x');
  const a = createArt({ apiKey: 'k', fetchImpl: fakeOpenAI().impl, logger: quiet, dir });
  for (const bad of ['../secret', 'secret.txt', '..%2fsecret', '', null, 5, 'A'.repeat(16)]) assert.equal(a.record(bad), null);
  // the folder path is a file, so it cannot be a folder
  const logs = [];
  const filePath = path.join(dir, 'secret.txt');
  const m = createArt({ apiKey: 'k', fetchImpl: fakeOpenAI().impl, logger: { log() {}, error: x => logs.push(x) }, dir: filePath });
  const r = await m.generate({ animal: 'a heron' }, {});
  assert.equal(r.status, 200);
  assert.ok(m.get(r.body.id));
  assert.ok(logs.some(x => /not usable/.test(x)));
});

test('server: a launch pins its picture so it outlives the clean-up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  const art = createArt({ apiKey: 'k', fetchImpl: fakeOpenAI().impl, logger: quiet, dir });
  const id = (await art.generate({ animal: 'a heron' }, {})).body.id;
  class PublicKey { constructor(v) { this.v = v; } toBase58() { return this.v; } }
  const load = async () => ({
    sdk: { DynamicBondingCurveClient: class { constructor() { this.creator = { createPool: async () => ({ partialSign() {}, serialize() { return Buffer.from('TX'); } }) }; } }, deriveDbcPoolAddress: () => new PublicKey('PoolAddress11111111111111111111111111111111') },
    web3: { PublicKey, Keypair: { generate: () => ({ publicKey: new PublicKey('Mint1111111111111111111111111111111111111111') }) }, Connection: class { async getLatestBlockhash() { return { blockhash: 'B' }; } } },
    spl: { NATIVE_MINT: new PublicKey('So11111111111111111111111111111111111111112') }
  });
  const launcher = createLauncher({ presets: PRESETS, load, logger: quiet });
  await withServer({ art, launcher }, async base => {
    assert.equal(art.record(id).pinned, false);
    const res = await fetch(base + '/api/launch/prepare', { method: 'POST', body: JSON.stringify({ preset: 'standard', name: 'Sleepy Heron', symbol: 'SNOOZ', creator: CREATOR, art: id }) });
    assert.equal(res.status, 200);
    assert.equal(art.record(id).pinned, true);
    const bad = await fetch(base + '/api/launch/prepare', { method: 'POST', body: JSON.stringify({ preset: 'standard', name: 'X', symbol: 'X', creator: CREATOR, art: 'd'.repeat(16) }) });
    assert.equal(bad.status, 400);
  });
});

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
const ACCOUNT = 'eced019eb2eb8d3eeb8e612d116d980a';

// A fake Cloudflare Workers AI.
function fakeCloudflare(opt) {
  const o = opt || {};
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    const json = v => ({ ok: true, status: 200, json: async () => v });
    if (/\/ai\/run\/@cf\/meta\//.test(url)) {
      if (o.textFail) return { ok: false, status: 500, json: async () => ({}) };
      return json({ result: { response: o.chat || 'Sure! Here you go: {"name":"Crown Heron","ticker":"crown","description":"Rules the pond."} Enjoy.' }, success: true });
    }
    if (/\/ai\/run\//.test(url)) {
      if (o.fail) return { ok: false, status: 500, json: async () => ({}) };
      if (o.unsuccessful) return json({ success: false, errors: [{ message: 'nope' }] });
      return json({ result: { image: (o.notImage ? Buffer.from('plain text, not an image '.repeat(20)) : JPG).toString('base64') }, success: true });
    }
    return json({ choices: [] });
  };
  return { impl, seen };
}
const cfArt = (opt, extra) => {
  const f = fakeCloudflare(opt);
  return { f, art: createArt(Object.assign({ provider: 'cloudflare', apiKey: 'cf-token', accountId: ACCOUNT, fetchImpl: f.impl, logger: quiet }, extra)) };
};

test('cloudflare: calls Workers AI with the account, token and model, and accepts a JPEG', async () => {
  const { f, art } = cfArt();
  assert.deepEqual(art.info(), { enabled: true });
  assert.equal(art.provider, 'cloudflare');
  const r = await art.generate({ animal: 'a tired heron in a tiny crown' }, { ip: '1.1.1.1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.imageUrl, '/art/' + r.body.id + '.jpg');
  assert.equal(r.body.name, 'Crown Heron');
  assert.equal(r.body.ticker, 'CROWN');
  assert.ok(art.get(r.body.id).equals(JPG));
  assert.equal(art.record(r.body.id).ext, 'jpg');
  const img = f.seen.find(x => /flux/.test(x.url));
  assert.equal(img.url, 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + '/ai/run/@cf/black-forest-labs/flux-1-schnell');
  assert.equal(img.auth, 'Bearer cf-token');
  assert.equal(img.body.steps, 4);
  assert.match(img.body.prompt, /tired heron/);
  const chat = f.seen.find(x => /llama/.test(x.url));
  assert.equal(chat.url, 'https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + '/ai/run/@cf/meta/llama-3.1-8b-instruct');
  assert.equal(chat.auth, 'Bearer cf-token');
  assert.equal(chat.body.messages[1].content, 'Animal: a tired heron in a tiny crown');
  assert.equal(JSON.stringify(r.body).includes('cf-token'), false);
});

test('cloudflare: needs a valid account id and safe model names, and fails with generic errors', async () => {
  assert.deepEqual(createArt({ provider: 'cloudflare', apiKey: 'k', accountId: '', logger: quiet }).info(), { enabled: false });
  assert.deepEqual(createArt({ provider: 'cloudflare', apiKey: 'k', accountId: '../../x', logger: quiet }).info(), { enabled: false });
  assert.deepEqual(createArt({ provider: 'cloudflare', apiKey: '', accountId: ACCOUNT, logger: quiet }).info(), { enabled: false });
  assert.deepEqual(createArt({ provider: 'cloudflare', apiKey: 'k', accountId: ACCOUNT, imageModel: '@cf/../../admin', logger: quiet }).info(), { enabled: false });
  assert.deepEqual(createArt({ provider: 'cloudflare', apiKey: 'k', accountId: ACCOUNT, imageModel: 'gpt-image-1', logger: quiet }).info(), { enabled: false });
  assert.equal(createArt({ provider: 'cloudflare', apiKey: 'k', accountId: ACCOUNT, imageModel: '@cf/stabilityai/stable-diffusion-xl-base-1.0', logger: quiet }).info().enabled, true);
  for (const o of [{ fail: true }, { unsuccessful: true }, { notImage: true }]) {
    const r = await cfArt(o).art.generate({ animal: 'a heron' }, {});
    assert.deepEqual(r, { status: 502, body: { error: 'generation_failed' } });
  }
  const noJson = await cfArt({ chat: 'I cannot do that' }).art.generate({ animal: 'a sleepy heron' }, {});
  assert.equal(noJson.status, 200);
  assert.equal(noJson.body.name, 'Sleepy Heron');
  const asObject = await cfArt({ chat: undefined }, {}).art.generate({ animal: 'a heron' }, {});
  assert.equal(asObject.body.name, 'Crown Heron');
});

test('cloudflare: a JPEG is saved, served as image/jpeg, linked in metadata, and only at its own extension', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'art-'));
  const { art } = cfArt({}, { dir });
  const r = await art.generate({ animal: 'a heron' }, {});
  const id = r.body.id;
  assert.ok(fs.existsSync(path.join(dir, id + '.jpg')));
  assert.equal(fs.existsSync(path.join(dir, id + '.png')), false);
  const fresh = createArt({ provider: 'cloudflare', apiKey: 'cf-token', accountId: ACCOUNT, fetchImpl: fakeCloudflare().impl, logger: quiet, dir });
  assert.ok(fresh.get(id).equals(JPG));
  assert.equal(fresh.record(id).ext, 'jpg');
  await withServer({ art: fresh }, async base => {
    const img = await fetch(base + '/art/' + id + '.jpg');
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.ok(Buffer.from(await img.arrayBuffer()).equals(JPG));
    assert.equal((await fetch(base + '/art/' + id + '.png')).status, 404);
    const meta = await (await fetch(base + '/meta.json?n=Crown%20Heron&s=CROWN&i=' + id)).json();
    assert.equal(meta.image, base + '/art/' + id + '.jpg');
  });
});

test('when the studio is off, the reason names the setting and never its value', async () => {
  assert.equal(createArt({ provider: 'cloudflare', apiKey: '', accountId: ACCOUNT, logger: quiet }).reason, 'CLOUDFLARE_API_TOKEN is not set');
  assert.match(createArt({ provider: 'cloudflare', apiKey: 'secret-token', accountId: '', logger: quiet }).reason, /CLOUDFLARE_ACCOUNT_ID/);
  assert.match(createArt({ provider: 'cloudflare', apiKey: 'secret-token', accountId: '"abc"', logger: quiet }).reason, /32-character/);
  assert.match(createArt({ provider: 'cloudflare', apiKey: 'secret-token', accountId: ACCOUNT, imageModel: 'gpt-image-1', logger: quiet }).reason, /@cf\//);
  assert.equal(createArt({ apiKey: '', logger: quiet }).reason, 'OPENAI_API_KEY is not set');
  assert.equal(cfArt().art.reason, '');
  for (const a of [createArt({ provider: 'cloudflare', apiKey: 'secret-token', accountId: 'bad', logger: quiet })]) assert.equal(a.reason.includes('secret-token'), false);
  await withServer({ art: createArt({ provider: 'cloudflare', apiKey: 'secret-token', accountId: '', logger: quiet }) }, async base => {
    const h = await (await fetch(base + '/healthz')).json();
    assert.equal(h.art, false);
    assert.match(h.artReason, /CLOUDFLARE_ACCOUNT_ID/);
    assert.equal(JSON.stringify(h).includes('secret-token'), false);
  });
  await withServer({ art: cfArt().art }, async base => {
    assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, art: true });
  });
});

test('fallback names read well for typical descriptions', async () => {
  const fall = animal => cfArt({ textFail: true }).art.generate({ animal }, {}).then(r => r.body);
  const a = await fall('a tired heron wearing a crown');
  assert.deepEqual([a.name, a.ticker, a.description], ['Tired Heron', 'HERON', 'A tired heron wearing a crown.']);
  const b = await fall('an angry capybara with sunglasses');
  assert.deepEqual([b.name, b.ticker], ['Angry Capybara', 'CAPYBA']);
  const c = await fall('frog');
  assert.deepEqual([c.name, c.ticker], ['Frog', 'FROG']);
  const d = await fall('the sleepy red panda riding a bike');
  assert.deepEqual([d.name, d.ticker], ['Red Panda', 'PANDA']);
});

test('random ideas: different each time, read naturally, and none of the thousands of combinations is blocked', () => {
  const { ideas, MOODS, ANIMALS, EXTRAS } = require('../public/ideas.js');
  const { blockedWord } = require('../art.js');
  const a = ideas(3);
  assert.equal(a.length, 3);
  assert.equal(new Set(a).size, 3);
  assert.equal(ideas(30).length, 30);
  assert.equal(new Set(ideas(30)).size, 30);
  // a seeded generator is repeatable, and different seeds give different ideas
  const seeded = seed => () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  assert.deepEqual(ideas(3, seeded(7)), ideas(3, seeded(7)));
  assert.notDeepEqual(ideas(3, seeded(7)), ideas(3, seeded(8)));
  // "a" or "an" matches the next word
  for (const i of ideas(60)) assert.equal(/^an [aeiou]|^a [^aeiou ]/.test(i), true, i);
  assert.ok(MOODS.length * ANIMALS.length * EXTRAS.length > 5000);
  // every combination passes the same character and brand check that real prompts go through
  for (const m of MOODS) for (const an of ANIMALS) for (const x of EXTRAS) {
    const text = m + ' ' + an + ' ' + x;
    assert.equal(blockedWord(text), null, text);
  }
});
