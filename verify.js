'use strict';

// Website verification. A creator proves they control the website on their coin by putting a short code
// on it; the server looks for that code and, if it finds it, marks the coin's website as verified.
//
// The server fetches a web address that the creator typed, so the fetch is locked down: https only, port 443,
// a public address only (checked at the moment of connecting, so a DNS trick cannot swap it afterwards),
// no redirects, a short timeout and a small size limit.
const crypto = require('crypto');
const dns = require('dns');
const https = require('https');
const net = require('net');

const MAX_BYTES = 16 * 1024;
const TIMEOUT_MS = 6000;

// True only for addresses on the public internet.
function isPublicAddress(addr) {
  if (net.isIPv4(addr)) {
    const p = addr.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;   // carrier-grade NAT
    if (p[0] === 169 && p[1] === 254) return false;                // link-local, cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return false;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
    if (p[0] >= 224) return false;                                 // multicast and reserved
    return true;
  }
  if (net.isIPv6(addr)) {
    const a = addr.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPublicAddress(mapped[1]);
    if (a === '::' || a === '::1') return false;
    if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a)) return false; // unique-local, link-local, multicast
    if (a.startsWith('2001:db8')) return false;
    return true;
  }
  return false;
}

// Resolves a name for the connection and refuses anything that is not a public address.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = (addrs || []).filter(a => isPublicAddress(a.address));
    if (!list.length || list.length !== addrs.length) return cb(new Error('blocked_address'));
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

// Reads at most MAX_BYTES of a page. Resolves { status, text }, or { status: 0 } for any failure.
function fetchText(urlString, lookup) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(urlString); } catch (e) { return resolve({ status: 0 }); }
    if (u.protocol !== 'https:' || (u.port && u.port !== '443') || u.username || u.password) return resolve({ status: 0 });
    if (net.isIP(u.hostname) || !u.hostname.includes('.')) return resolve({ status: 0 });
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    const req = https.get({
      protocol: 'https:', hostname: u.hostname, port: 443, path: u.pathname + u.search, lookup: lookup || safeLookup,
      headers: { 'User-Agent': 'HatchPad-verify/1', Accept: 'text/html,text/plain' }, timeout: TIMEOUT_MS
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return finish({ status: res.statusCode }); }
      let size = 0;
      const chunks = [];
      res.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) { res.destroy(); return finish({ status: 200, text: Buffer.concat(chunks).toString('utf8') }); }
        chunks.push(c);
      });
      res.on('end', () => finish({ status: 200, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish({ status: 0 }));
    });
    req.on('timeout', () => { req.destroy(); finish({ status: 0 }); });
    req.on('error', () => finish({ status: 0 }));
    setTimeout(() => { req.destroy(); finish({ status: 0 }); }, TIMEOUT_MS + 1000).unref();
  });
}

function createVerifier(opts) {
  const o = opts || {};
  const secret = o.secret || crypto.randomBytes(32).toString('hex');
  const fetcher = o.fetchText || (u => fetchText(u));

  // The code for one coin. It is not secret (it ends up on a public website), it just has to be specific to the coin.
  function code(pool, creator) {
    return 'hatchpad-' + crypto.createHmac('sha256', secret).update(String(pool) + ':' + String(creator)).digest('hex').slice(0, 20);
  }

  // Where to look: a plain file on the site, or the address the coin links to.
  function places(website) {
    let u;
    try { u = new URL(website); } catch (e) { return []; }
    if (u.protocol !== 'https:') return [];
    return [u.origin + '/.well-known/hatchpad-verify.txt', u.href];
  }

  // Returns { status: 200, body: { verified } } or an error result.
  async function check(coin) {
    const website = coin && coin.links && coin.links.website;
    if (!website) return { status: 400, body: { error: 'no_website' } };
    const where = places(website);
    if (!where.length) return { status: 400, body: { error: 'needs_https' } };
    const want = code(coin.pool, coin.creator);
    for (const w of where) {
      const r = await fetcher(w);
      if (r.status === 200 && typeof r.text === 'string' && r.text.includes(want)) return { status: 200, body: { verified: true } };
    }
    return { status: 200, body: { verified: false } };
  }

  return { code, places, check };
}

module.exports = { createVerifier, isPublicAddress, safeLookup, fetchText };
