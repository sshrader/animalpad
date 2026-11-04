'use strict';

// Static server plus the animal studio and devnet launch API for AnimalPad.
// Railway sets PORT; locally it falls back to 3000.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLauncher, metadataFor, cleanText } = require('./launch');
const { createLaunches } = require('./launches');
const { createArt, ID_RE, normalizeLinks, blockedWord } = require('./art');

const PUBLIC_DIR = path.join(__dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};
const JSON_TYPE = { 'Content-Type': 'application/json; charset=utf-8' };
const TEXT_TYPE = { 'Content-Type': 'text/plain; charset=utf-8' };

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'X-Content-Type-Options': 'nosniff' }, headers));
  res.end(body);
}

// Reads a small JSON body. Resolves null when it is too large or not JSON.
function readJson(req, maxBytes) {
  return new Promise(resolve => {
    let size = 0;
    const chunks = [];
    let over = false;
    req.on('data', c => {
      size += c.length;
      if (over) return; // keep draining so the client gets an answer, but stop storing
      if (size > maxBytes) { over = true; chunks.length = 0; resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (err) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

// The public address of this site, used inside token metadata links.
function baseUrlFor(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(host)) return '';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return proto + '://' + host;
}

const sortKeys = o => Object.keys(o).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {});

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createApp(opts) {
  const art = opts.art || createArt({});
  const launches = opts.launches || null;
  const launcher = opts.launcher || null;

  return http.createServer((req, res) => {
    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch (err) {
      return send(res, 400, 'Bad request', TEXT_TYPE);
    }
    if (pathname.indexOf('\0') !== -1) {
      return send(res, 400, 'Bad request', TEXT_TYPE);
    }

    // The POST routes: each asks the server to prepare an unsigned transaction for the wallet to sign.
    if (req.method === 'POST' && pathname === '/api/art/generate') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      readJson(req, 1024).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        return art.generate(body, { ip: clientIp(req) }).then(r => send(res, r.status, JSON.stringify(r.body), noStore));
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    const POSTS = { '/api/launch/prepare': 'prepare', '/api/launch/buy': 'buy', '/api/launch/claim': 'claim' };
    if (req.method === 'POST' && Object.prototype.hasOwnProperty.call(POSTS, pathname)) {
      const action = POSTS[pathname];
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store', Connection: 'close' });
      if (!launcher) return send(res, 503, JSON.stringify({ error: 'launch_unavailable' }), noStore);
      readJson(req, 4096).then(body => {
        if (!body) return send(res, 400, JSON.stringify({ error: 'bad_request' }), noStore);
        // The creator's links are checked first, so nothing half-valid is stored or published.
        let links = {};
        if (action === 'prepare' && body.links !== undefined) {
          links = normalizeLinks(body.links);
          if (links === null || (Object.keys(links).length && !(typeof body.art === 'string' && art.record(body.art)))) {
            return send(res, 400, JSON.stringify({ error: 'bad_links' }), noStore);
          }
          // Once a launch has been prepared for this picture its links are frozen. The same links again
          // (a retry after declining in the wallet) are fine; different ones are refused, not ignored.
          const rec = typeof body.art === 'string' ? art.record(body.art) : null;
          if (rec && rec.pinned && JSON.stringify(sortKeys(links)) !== JSON.stringify(sortKeys(rec.links || {}))) {
            return send(res, 409, JSON.stringify({ error: 'links_locked' }), noStore);
          }
        }
        // Names and tickers go on a public list, so they get the same character-and-brand check as prompts.
        if (action === 'prepare' && blockedWord(String(body.name || '') + ' ' + String(body.symbol || ''))) {
          return send(res, 400, JSON.stringify({ error: 'blocked_name' }), noStore);
        }
        return launcher[action](body, { ip: clientIp(req), baseUrl: baseUrlFor(req), hasArt: id => Boolean(art.get(id)) })
          .then(r => {
            if (action === 'prepare' && r.status === 200 && launches) {
              launches.record({ pool: r.body.pool, mint: r.body.mint, name: cleanText(body.name, 32), symbol: String(body.symbol || '').replace(/^\$/, '').trim().toUpperCase(), creator: body.creator, art: body.art, preset: body.preset });
            }
            if (action === 'prepare' && r.status === 200 && typeof body.art === 'string') {
              // Links are saved, then the picture is kept for good and its links are frozen.
              if (Object.keys(links).length) art.setLinks(body.art, links);
              art.pin(body.art);
            }
            send(res, r.status, JSON.stringify(r.body), noStore);
          });
      }).catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', Object.assign({ Allow: 'GET, HEAD' }, TEXT_TYPE));
    }

    // Whether launching is switched on, so the page knows whether to offer it.
    if (pathname === '/api/launch/config') {
      const info = launcher ? launcher.info() : { enabled: false, cluster: 'devnet', presets: [] };
      return send(res, 200, JSON.stringify(info), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
    }

    // Read-only chain lookups for the page: did a transaction land, and where does a curve stand.
    if (pathname === '/api/launch/status' || pathname === '/api/launch/pool' || pathname === '/api/launch/fees') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' });
      if (!launcher) return send(res, 503, JSON.stringify({ error: 'launch_unavailable' }), noStore);
      const ctx = { ip: clientIp(req) };
      const run = pathname === '/api/launch/status' ? launcher.status(url.searchParams.get('sig'), ctx)
        : pathname === '/api/launch/fees' ? launcher.fees(url.searchParams.get('address'), ctx)
        : launcher.pool(url.searchParams.get('address'), ctx);
      run.then(r => send(res, r.status, req.method === 'HEAD' ? '' : JSON.stringify(r.body), noStore))
        .catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), noStore));
      return;
    }

    // The public list of launches that exist on-chain, newest first.
    if (pathname === '/api/launches') {
      const noStore = Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=15' });
      if (!launches) return send(res, 200, JSON.stringify({ launches: [] }), noStore);
      launches.list().then(items => send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({ launches: items }), noStore))
        .catch(() => send(res, 500, JSON.stringify({ error: 'server_error' }), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' })));
      return;
    }

    // Whether the animal studio is switched on, so the page knows whether to offer it.
    if (pathname === '/api/art/config') {
      return send(res, 200, JSON.stringify(art.info()), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
    }

    // A generated animal picture, kept in memory by its id.
    const m = /^\/art\/([0-9a-f]{16})\.(png|jpg)$/.exec(pathname);
    if (m) {
      const rec = art.record(m[1]);
      if (!rec || rec.ext !== m[2]) return send(res, 404, 'Not found', TEXT_TYPE);
      return send(res, 200, req.method === 'HEAD' ? '' : rec.png, { 'Content-Type': m[2] === 'jpg' ? 'image/jpeg' : 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
    }

    // Token metadata read by wallets and explorers. Built from the link and the stored animal.
    if (pathname === '/meta.json') {
      const id = url.searchParams.get('i');
      const rec = id && ID_RE.test(id) ? art.record(id) : null;
      const meta = metadataFor(url.searchParams.get('n'), url.searchParams.get('s'), rec, baseUrlFor(req));
      if (!meta) return send(res, 400, JSON.stringify({ error: 'bad_metadata' }), JSON_TYPE);
      return send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify(meta), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'public, max-age=3600' }));
    }

    // Health check for the host platform.
    if (pathname === '/healthz') {
      const body = { ok: true, art: art.info().enabled };
      if (art.reason) body.artReason = art.reason;
      return send(res, 200, JSON.stringify(body), JSON_TYPE);
    }

    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(PUBLIC_DIR, pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      return send(res, 403, 'Forbidden', TEXT_TYPE);
    }

    fs.readFile(file, (err, data) => {
      if (err) {
        return send(res, 404, 'Not found', TEXT_TYPE);
      }
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      send(res, 200, req.method === 'HEAD' ? '' : data, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    });
  });
}

module.exports = { createApp };

if (require.main === module) {
  const PORT = Number(process.env.PORT) || 3000;
  const env = name => String(process.env[name] || '').trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  // Railway volumes mount at a path you choose; /data is the usual one.
  // DATA_DIR (the volume's mount path) is the simplest setting; ART_DIR overrides just the pictures.
  const dataDir = env('DATA_DIR') || (fs.existsSync('/data') ? '/data' : '');
  const artDir = env('ART_DIR') || (dataDir ? path.join(dataDir, 'art') : '');
  // IMAGE_PROVIDER=cloudflare uses Workers AI (needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN).
  // Anything else uses OpenAI (needs OPENAI_API_KEY). IMAGE_MODEL and TEXT_MODEL override the defaults.
  // Settings pasted into a host's form often carry stray spaces, line breaks or quotes; strip them.
  const cloudflare = env('IMAGE_PROVIDER').toLowerCase() === 'cloudflare';
  const art = createArt({
    dir: artDir,
    provider: cloudflare ? 'cloudflare' : 'openai',
    apiKey: cloudflare ? env('CLOUDFLARE_API_TOKEN') : env('OPENAI_API_KEY'),
    accountId: env('CLOUDFLARE_ACCOUNT_ID'),
    imageModel: env('IMAGE_MODEL') || env('OPENAI_IMAGE_MODEL') || undefined,
    textModel: env('TEXT_MODEL') || env('OPENAI_TEXT_MODEL') || undefined,
    perIpPerHour: Number(process.env.ART_PER_IP_PER_HOUR) || undefined,
    dailyCap: Number(process.env.ART_DAILY_CAP) || undefined
  });
  const launcher = createLauncher({
    presetsFile: path.join(__dirname, 'devnet', 'presets.json'),
    rpcUrl: process.env.LAUNCH_RPC_URL || undefined
  });
  const launchesFile = env('LAUNCHES_FILE') || (dataDir ? path.join(dataDir, 'launches.json') : '');
  const launches = createLaunches({
    file: launchesFile,
    inspect: address => launcher.inspect(address),
    artRecord: id => art.record(id),
    hidden: env('HIDE_POOLS').split(',').map(x => x.trim()).filter(Boolean)
  });
  const server = createApp({ art, launcher, launches });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('AnimalPad listening on port ' + PORT + (art.info().enabled ? ' (animal studio on, ' + art.provider + ')' : ' (animal studio OFF: ' + art.reason + '; provider ' + art.provider + ')') + (artDir ? ' (pictures saved in ' + artDir + ')' : ' (pictures in memory only: no volume)') +
      (launcher.info().enabled ? ' (devnet launch on)' : ' (devnet launch off: no devnet/presets.json)') + (launchesFile ? ' (launch list saved in ' + launchesFile + ')' : ' (launch list in memory only)'));
  });
  // Railway stops containers with SIGTERM; close cleanly.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
