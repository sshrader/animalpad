'use strict';

// The public list of launches. A launch is written down when the server prepares it, but it only shows
// in the list once the pool is confirmed to exist on-chain, so abandoned attempts and spam never appear.
// With a file (a Railway volume) the list survives restarts; without one it lives in memory.
const fs = require('fs');
const path = require('path');

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ART_ID = /^[0-9a-f]{16}$/;

function createLaunches(opts) {
  const o = opts || {};
  const file = o.file || '';
  const inspect = o.inspect;          // address -> { status, body }, from the launcher
  const artRecord = o.artRecord || (() => null);
  const now = o.now || Date.now;
  const logger = o.logger || console;
  const max = o.max || 500;
  const unverifiedTtlMs = o.unverifiedTtlMs || 86400000;
  const listTtlMs = o.listTtlMs === undefined ? 20000 : o.listTtlMs;
  const pageSize = o.pageSize || 24;
  const hidden = new Set(o.hidden || []);

  let cache = null; // { at, items }
  let running = null;
  let entries = [];
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j)) entries = j.filter(valid);
    } catch (err) { /* no file yet, or unreadable: start empty */ }
  }

  function valid(e) {
    return e && typeof e === 'object' && B58.test(e.pool || '') && B58.test(e.mint || '') && typeof e.name === 'string' && typeof e.symbol === 'string' && B58.test(e.creator || '') && Number.isFinite(e.createdAt);
  }

  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(entries));
      fs.renameSync(tmp, file);
    } catch (err) { logger.error('Launch list save failed: ' + (err && err.message)); }
  }

  // Writes a prepared launch down. Returns false if it is not well formed.
  function record(e) {
    const entry = {
      pool: e && e.pool, mint: e && e.mint, name: e && e.name, symbol: e && e.symbol, creator: e && e.creator,
      art: e && ART_ID.test(e.art || '') ? e.art : '', preset: e && typeof e.preset === 'string' ? e.preset : '',
      createdAt: now(), verified: false
    };
    if (!valid(entry)) return false;
    const i = entries.findIndex(x => x.pool === entry.pool);
    if (i !== -1) return true; // a retry of the same launch
    entries.push(entry);
    cache = null; // show it as soon as it is on-chain
    if (entries.length > max) entries = entries.slice(entries.length - max);
    save();
    return true;
  }

  
  async function build() {
    const newest = entries.slice().sort((a, b) => b.createdAt - a.createdAt).filter(e => !hidden.has(e.pool)).slice(0, pageSize * 2);
    const items = [];
    let changed = false;
    let failed = false;
    let pending = false; // a recent launch that is not on-chain yet
    const queue = newest.slice();
    // A few at a time, so the list is quick without hammering the RPC.
    async function worker() {
      for (let e = queue.shift(); e; e = queue.shift()) {
        const r = await inspect(e.pool);
        if (r.status === 200) {
          if (!e.verified) { e.verified = true; changed = true; }
          const rec = e.art ? artRecord(e.art) : null;
          items.push({
            pool: e.pool, mint: e.mint, name: e.name, symbol: e.symbol, creator: e.creator, preset: e.preset, createdAt: e.createdAt,
            imageUrl: rec ? '/art/' + rec.id + '.' + (rec.ext === 'jpg' ? 'jpg' : 'png') : '',
            raisedSol: r.body.raisedSol, thresholdSol: r.body.thresholdSol, progress: r.body.progress,
            migrated: r.body.migrated, curveFull: r.body.curveFull
          });
        } else if (r.status === 404) {
          if (now() - e.createdAt < 600000) pending = true;
          // Not on-chain. If it has been that way for a day it was never sent, so forget it.
          if (!e.verified && now() - e.createdAt > unverifiedTtlMs) { entries = entries.filter(x => x.pool !== e.pool); changed = true; }
        } else {
          failed = true; // the RPC had a problem; do not drop anything
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (changed) save();
    items.sort((a, b) => b.createdAt - a.createdAt);
    return { items: items.slice(0, pageSize), failed, pending };
  }

  // The list for the page. Cached for a short time, and the last good one is kept if the RPC fails.
  async function list() {
    if (cache && now() - cache.at < listTtlMs) return cache.items;
    if (!running) {
      running = build().then(r => {
        if (r.pending && !r.failed) cache = { at: now() - listTtlMs + Math.min(listTtlMs, 4000), items: r.items }; // look again in a few seconds
        else if (!r.failed || !cache) cache = { at: now(), items: r.items };
        else cache = { at: now() - listTtlMs + Math.min(listTtlMs, 5000), items: cache.items }; // retry soon, keep what we had
        return cache.items;
      }).catch(err => {
        logger.error('Launch list failed: ' + (err && err.message));
        return cache ? cache.items : [];
      }).finally(() => { running = null; });
    }
    return running;
  }

  // How the mascot feels, from how full its curve is.
  function moodFor(r) {
    if (r.migrated) return { key: 'graduated', label: 'Graduated' };
    if (r.curveFull || r.progress >= 1) return { key: 'ready', label: 'Ready to graduate' };
    if (r.progress >= 0.75) return { key: 'excited', label: 'Excited' };
    if (r.progress >= 0.25) return { key: 'awake', label: 'Awake' };
    return { key: 'sleepy', label: 'Sleepy' };
  }

  // One launch for its own page: the same facts as the list, plus the description and links.
  async function detail(pool) {
    if (!B58.test(pool || '')) return { status: 400, body: { error: 'bad_pool' } };
    const e = entries.find(x => x.pool === pool);
    if (!e || hidden.has(pool)) return { status: 404, body: { error: 'not_found' } };
    const r = await inspect(pool);
    if (r.status === 404) return { status: 404, body: { error: 'not_found' } };
    if (r.status !== 200) return { status: 502, body: { error: 'pool_read_failed' } };
    const rec = e.art ? artRecord(e.art) : null;
    return { status: 200, body: {
      pool: e.pool, mint: e.mint, name: e.name, symbol: e.symbol, creator: e.creator, createdAt: e.createdAt,
      description: rec && typeof rec.description === 'string' ? rec.description : '',
      links: rec && rec.links && typeof rec.links === 'object' ? rec.links : {},
      imageUrl: rec ? '/art/' + rec.id + '.' + (rec.ext === 'jpg' ? 'jpg' : 'png') : '',
      raisedSol: r.body.raisedSol, thresholdSol: r.body.thresholdSol, progress: r.body.progress,
      migrated: r.body.migrated, curveFull: r.body.curveFull,
      mood: moodFor(r.body),
      siteVerified: Boolean(e.siteVerified && rec && rec.links && e.siteVerified === rec.links.website)
    } };
  }

  // Remembers that the coin's website was proven to be the creator's. Stored with the address that was checked.
  function setSiteVerified(pool, website) {
    const e = entries.find(x => x.pool === pool);
    if (!e || typeof website !== 'string' || !website) return false;
    e.siteVerified = website;
    save();
    return true;
  }

  return { record, list, detail, setSiteVerified, size: () => entries.length };
}

module.exports = { createLaunches };
