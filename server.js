'use strict';

// Static server plus the animal studio and devnet launch API for AnimalPad.
// Railway sets PORT; locally it falls back to 3000.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLauncher, metadataFor } = require('./launch');
const { createArt, ID_RE } = require('./art');

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

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function createApp(opts) {
  const art = opts.art || createArt({});
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
        return launcher[action](body, { ip: clientIp(req), baseUrl: baseUrlFor(req), hasArt: id => Boolean(art.get(id)) })
          .then(r => send(res, r.status, JSON.stringify(r.body), noStore));
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

    // Whether the animal studio is switched on, so the page knows whether to offer it.
    if (pathname === '/api/art/config') {
      return send(res, 200, JSON.stringify(art.info()), Object.assign({}, JSON_TYPE, { 'Cache-Control': 'no-store' }));
    }

    // A generated animal picture, kept in memory by its id.
    const m = /^\/art\/([0-9a-f]{16})\.png$/.exec(pathname);
    if (m) {
      const png = art.get(m[1]);
      if (!png) return send(res, 404, 'Not found', TEXT_TYPE);
      return send(res, 200, req.method === 'HEAD' ? '' : png, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
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
      return send(res, 200, JSON.stringify({ ok: true, art: art.info().enabled }), JSON_TYPE);
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
  const art = createArt({
    apiKey: process.env.OPENAI_API_KEY || '',
    base: process.env.OPENAI_BASE || undefined,
    imageModel: process.env.OPENAI_IMAGE_MODEL || undefined,
    textModel: process.env.OPENAI_TEXT_MODEL || undefined,
    perIpPerHour: Number(process.env.ART_PER_IP_PER_HOUR) || undefined,
    dailyCap: Number(process.env.ART_DAILY_CAP) || undefined
  });
  const launcher = createLauncher({
    presetsFile: path.join(__dirname, 'devnet', 'presets.json'),
    rpcUrl: process.env.LAUNCH_RPC_URL || undefined
  });
  const server = createApp({ art, launcher });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('AnimalPad listening on port ' + PORT + (art.info().enabled ? ' (animal studio on)' : ' (animal studio off: set OPENAI_API_KEY)') +
      (launcher.info().enabled ? ' (devnet launch on)' : ' (devnet launch off: no devnet/presets.json)'));
  });
  // Railway stops containers with SIGTERM; close cleanly.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
}
