'use strict';

// Launch flow on the pump.fun protocol, server side. The server builds UNSIGNED transactions for the
// creator's wallet to sign. It holds no keys: the only secret it generates is the new coin's mint keypair,
// which signs once here and is then discarded. A launch is up to three transactions, each built once the
// last one has landed: 1) create the coin, 2) split its creator fees between the creator and HatchPad,
// 3) the creator's optional first buy. Mainnet is refused until MAINNET_ENABLED=yes.
//
// web3.js is loaded only when someone launches, so a problem with it can never stop the website from starting.

const pump = require('./pump.js');

const SYMBOL_RE = /^[A-Za-z0-9]{1,10}$/;
const ART_ID_RE = /^[0-9a-f]{16}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;
const MAX_URI = 200; // the on-chain metadata URI limit
const MIN_BUY_SOL = 0.01;
const MAX_BUY_SOL = 5;

// Strips control, invisible format and separator characters: control, invisible format, and line separator characters.
function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Small in-memory limiter: each launch preparation makes an RPC call.
function createLimiter(max, windowMs, now) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter(x => t - x < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return false; }
    recent.push(t);
    hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => t - x < windowMs)) hits.delete(k);
    return true;
  };
}

async function loadReal() {
  return { web3: await import('@solana/web3.js') };
}

const CU = { create: 400000, split: 250000, buy: 300000, distribute: 300000 };

function createLauncher(opts) {
  const o = opts || {};
  const cluster = o.cluster || 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new Error('Unknown cluster "' + cluster + '". Use devnet or mainnet-beta.');
  const isMain = cluster === 'mainnet-beta';
  if (isMain && o.allowMainnet !== true) throw new Error('Mainnet is switched off. Set MAINNET_ENABLED=yes to allow real-money launches.');
  const rpcUrl = o.rpcUrl || (isMain ? '' : 'https://api.devnet.solana.com');
  const load = o.load || loadReal;
  const logger = o.logger || console;
  const allow = createLimiter(o.maxPerMinute || 10, 60000, o.now || Date.now);
  const allowRead = createLimiter(o.maxReadsPerMinute || 120, 60000, o.now || Date.now);
  const priorityMicro = Number.isFinite(Number(o.priorityMicroLamports)) ? Math.max(0, Math.floor(Number(o.priorityMicroLamports))) : (isMain ? 50000 : 0);

  if (isMain && !rpcUrl) throw new Error('Mainnet needs LAUNCH_RPC_URL set to a dedicated mainnet RPC.');
  if (isMain && /devnet|testnet/i.test(rpcUrl)) throw new Error('LAUNCH_CLUSTER is mainnet-beta but LAUNCH_RPC_URL looks like devnet.');
  if (!isMain && /mainnet/i.test(rpcUrl)) throw new Error('LAUNCH_CLUSTER is devnet but LAUNCH_RPC_URL looks like mainnet.');

  // The platform's cut of each coin's creator fees, paid to this wallet through pump.fun's fee sharing.
  const platformWallet = typeof o.platformWallet === 'string' && B58_RE.test(o.platformWallet) ? o.platformWallet : '';
  const platformPct = o.platformSharePct === undefined || o.platformSharePct === '' ? 20 : Number(o.platformSharePct);
  if (!Number.isInteger(platformPct) || platformPct < 1 || platformPct > 50) throw new Error('PLATFORM_SHARE_PCT must be a whole number from 1 to 50.');
  const enabled = Boolean(platformWallet);

  function info() {
    const out = { enabled, cluster, protocol: 'pump.fun' };
    if (enabled) out.split = { creatorPct: 100 - platformPct, platformPct };
    return out;
  }

  async function chain() {
    const { web3 } = await load();
    return { web3, connection: new web3.Connection(rpcUrl, 'confirmed'), B: pump.createBuilder(web3) };
  }

  let globalCache = null;
  async function readGlobal(c) {
    const now = (o.now || Date.now)();
    if (globalCache && now - globalCache.at < 60000) return globalCache.value;
    const acc = await c.connection.getAccountInfo(c.B.globalPda());
    if (!acc) throw new Error('pump.fun global account not found on this network');
    const value = pump.decodeAccount(pump.IDLS.pump, 'Global', acc.data, c.web3);
    globalCache = { at: now, value };
    return value;
  }

  async function readCurve(c, mint) {
    const acc = await c.connection.getAccountInfo(c.B.bondingCurveOf(mint));
    if (!acc || acc.owner.toBase58() !== pump.PUMP) return null;
    return pump.decodeAccount(pump.IDLS.pump, 'BondingCurve', acc.data, c.web3);
  }

  function budget(c, units) {
    const cb = c.web3.ComputeBudgetProgram;
    if (!cb) return [];
    const ixs = [cb.setComputeUnitLimit({ units })];
    if (priorityMicro > 0) ixs.push(cb.setComputeUnitPrice({ microLamports: priorityMicro }));
    return ixs;
  }

  async function toTx(c, ixs, payer, signers) {
    const tx = new c.web3.Transaction();
    ixs.forEach(ix => tx.add(ix));
    const latest = await c.connection.getLatestBlockhash('confirmed');
    tx.feePayer = payer;
    tx.recentBlockhash = latest.blockhash;
    (signers || []).forEach(k => tx.partialSign(k));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }

  const shares = creator => (creator === platformWallet
    ? [{ address: creator, bps: 10000 }]
    : [{ address: creator, bps: (100 - platformPct) * 100 }, { address: platformWallet, bps: platformPct * 100 }]);

  function parseBuy(v) {
    const n = v === undefined || v === null || v === '' ? 0 : Number(v);
    return Number.isFinite(n) && n >= 0 && (n === 0 || (n >= MIN_BUY_SOL && n <= MAX_BUY_SOL)) ? n : null;
  }

  // Step 1: create the coin. Returns { status, body }. Never throws.
  async function prepare(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };

    const b = input && typeof input === 'object' ? input : {};
    const name = cleanText(b.name, 32);
    if (!name) return { status: 400, body: { error: 'bad_name' } };
    const symbol = typeof b.symbol === 'string' ? b.symbol.replace(/^\$/, '').trim().toUpperCase() : '';
    if (!SYMBOL_RE.test(symbol)) return { status: 400, body: { error: 'bad_symbol' } };
    if (typeof b.creator !== 'string' || !B58_RE.test(b.creator)) return { status: 400, body: { error: 'bad_creator' } };

    let artId = '';
    if (b.art !== undefined && b.art !== null && b.art !== '') {
      artId = typeof b.art === 'string' && ART_ID_RE.test(b.art) ? b.art : '';
      if (!artId || !(ctx && typeof ctx.hasArt === 'function' && ctx.hasArt(artId))) return { status: 400, body: { error: 'bad_art' } };
    }
    // The founder picture (the HatchPad logo) can only be launched by the founder wallet, so nobody else can launch a coin that looks like the brand.
    if (artId && ctx && ctx.founder && artId === ctx.founder.id && b.creator !== ctx.founder.wallet) return { status: 403, body: { error: 'founder_only' } };
    const firstBuySol = parseBuy(b.firstBuySol);
    if (firstBuySol === null) return { status: 400, body: { error: 'bad_amount' } };
    const base = String((ctx && ctx.baseUrl) || '').replace(/\/+$/, '');
    const uri = base + '/meta.json?n=' + encodeURIComponent(name) + '&s=' + encodeURIComponent(symbol) + (artId ? '&i=' + artId : '');
    if (!/^https?:\/\//.test(base) || uri.length > MAX_URI) return { status: 400, body: { error: 'uri_too_long' } };

    try {
      const c = await chain();
      const creatorPk = new c.web3.PublicKey(b.creator);
      const mintKp = c.web3.Keypair.generate();
      const ix = c.B.createCoin({ mint: mintKp.publicKey, user: creatorPk, name, symbol, uri });
      const transaction = await toTx(c, budget(c, CU.create).concat([ix]), creatorPk, [mintKp]);
      const mint = mintKp.publicKey.toBase58();
      return { status: 200, body: { transaction, mint, pool: mint, curve: c.B.bondingCurveOf(mintKp.publicKey).toBase58(), firstBuySol, split: info().split, cluster } };
    } catch (err) {
      logger.error('Launch prepare failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  // Steps 2 and 3: after the coin exists, say what is left to sign. Reads the chain, so it can be asked again
  // after a closed tab. { step: 'waiting' | 'split' | 'buy' | 'done', transaction? }
  async function step(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.mint !== 'string' || !B58_RE.test(b.mint)) return { status: 400, body: { error: 'bad_mint' } };
    if (typeof b.creator !== 'string' || !B58_RE.test(b.creator)) return { status: 400, body: { error: 'bad_creator' } };
    const firstBuySol = parseBuy(b.firstBuySol);
    if (firstBuySol === null) return { status: 400, body: { error: 'bad_amount' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, b.mint);
      if (!curve) return { status: 200, body: { step: 'waiting' } };
      const creatorPk = new c.web3.PublicKey(b.creator);
      const sharing = c.B.sharingConfigOf(b.mint).toBase58();
      if (curve.creator === b.creator) {
        const ixs = [c.B.createSharingConfig({ mint: b.mint, payer: creatorPk }), c.B.setShares({ mint: b.mint, authority: creatorPk, shareholders: shares(b.creator) })];
        return { status: 200, body: { step: 'split', transaction: await toTx(c, budget(c, CU.split).concat(ixs), creatorPk), cluster } };
      }
      if (curve.creator !== sharing) return { status: 403, body: { error: 'not_creator' } };
      if (firstBuySol > 0) {
        let held = 0n;
        try {
          const bal = await c.connection.getTokenAccountBalance(c.B.ata(creatorPk, b.mint, pump.TOKEN_2022));
          held = BigInt(bal && bal.value ? bal.value.amount : 0);
        } catch (e) { held = 0n; }
        if (held === 0n && !curve.complete) {
          const t = await buildBuy(c, creatorPk, b.mint, curve, firstBuySol, 1000);
          return { status: 200, body: { step: 'buy', transaction: t, cluster } };
        }
      }
      return { status: 200, body: { step: 'done' } };
    } catch (err) {
      logger.error('Launch step failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  async function buildBuy(c, buyerPk, mint, curve, sol, slippageBps) {
    const glob = await readGlobal(c);
    const lamports = BigInt(Math.floor(sol * 1e9));
    const min = pump.minTokensForBuy(curve, lamports, slippageBps, pump.feeGuessBps(glob));
    if (min <= 0n) throw new Error('quote came out as zero');
    const recipients = Array.isArray(glob.buyback_fee_recipients) && glob.buyback_fee_recipients.length ? glob.buyback_fee_recipients : pump.BUYBACK_RECIPIENTS;
    const ixs = [
      c.B.createAtaIdempotent(buyerPk, buyerPk, mint, pump.TOKEN_2022),
      c.B.buyExactIn({ user: buyerPk, mint, lamports, minTokensOut: min, buybackRecipient: recipients[0] })
    ];
    return toTx(c, budget(c, CU.buy).concat(ixs), buyerPk);
  }

  async function status(sig, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    if (typeof sig !== 'string' || !SIG_RE.test(sig)) return { status: 400, body: { error: 'bad_signature' } };
    try {
      const c = await chain();
      const r = await c.connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const st = r && r.value && r.value[0];
      if (!st) return { status: 200, body: { state: 'pending' } };
      if (st.err) return { status: 200, body: { state: 'failed' } };
      const done = st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized';
      return { status: 200, body: { state: done ? 'confirmed' : 'pending' } };
    } catch (err) {
      logger.error('Launch status failed: ' + (err && err.message ? err.message : 'unknown error'));
      return { status: 502, body: { error: 'status_failed' } };
    }
  }

  // The curve's state, with no rate limit. For the server's own use (the public list of launches).
  // `mint` is the coin's token address; the curve address is derived from it.
  async function inspect(mint) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (typeof mint !== 'string' || !B58_RE.test(mint)) return { status: 400, body: { error: 'bad_pool' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, mint);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      const glob = await readGlobal(c);
      const need = Number(pump.solToFill(glob)) / 1e9;
      const startReal = Number(glob.initial_real_token_reserves) || 1;
      const left = Number(curve.real_token_reserves);
      const progress = Math.max(0, Math.min(1, 1 - left / startReal));
      const vt = Number(curve.virtual_token_reserves) || 1;
      const marketCapSol = (Number(curve.virtual_quote_reserves) / vt) * Number(curve.token_total_supply) / 1e9;
      const complete = Boolean(curve.complete);
      return {
        status: 200,
        body: {
          address: mint, curve: c.B.bondingCurveOf(mint).toBase58(), mint,
          raisedSol: Number(curve.real_quote_reserves) / 1e9, thresholdSol: need,
          progress: complete ? 1 : progress, marketCapSol,
          migrated: complete, curveFull: complete,
          splitOk: curve.creator === c.B.sharingConfigOf(mint).toBase58(), cluster
        }
      };
    } catch (err) {
      logger.error('Launch pool read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'pool_read_failed' } };
    }
  }

  async function pool(mint, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    return inspect(mint);
  }

  // Builds an unsigned buy for the buyer's wallet to sign.
  async function buy(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.pool !== 'string' || !B58_RE.test(b.pool)) return { status: 400, body: { error: 'bad_pool' } };
    if (typeof b.buyer !== 'string' || !B58_RE.test(b.buyer)) return { status: 400, body: { error: 'bad_buyer' } };
    const sol = Number(b.sol);
    if (!Number.isFinite(sol) || sol < MIN_BUY_SOL || sol > MAX_BUY_SOL) return { status: 400, body: { error: 'bad_amount' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, b.pool);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      if (curve.complete) return { status: 409, body: { error: 'migrated' } };
      const buyerPk = new c.web3.PublicKey(b.buyer);
      const transaction = await buildBuy(c, buyerPk, b.pool, curve, sol, 500);
      return { status: 200, body: { transaction, partialFill: false, cluster } };
    } catch (err) {
      logger.error('Launch buy failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: isMain && /quote/.test(String(err && err.message)) ? 'quote_failed' : 'prepare_failed' } };
    }
  }

  // Creator fees waiting for a coin: the part still on the curve plus what has been swept into the fee vault.
  async function pending(c, mint, curve) {
    let waiting = Number(curve.creator_fee || 0n);
    try {
      const vault = c.B.creatorVaultOf(curve.creator);
      const acc = await c.connection.getAccountInfo(vault);
      if (acc) {
        const rent = await c.connection.getMinimumBalanceForRentExemption(acc.data.length);
        waiting += Math.max(0, Number(acc.lamports) - rent);
      }
    } catch (e) { /* keep what the curve shows */ }
    return waiting / 1e9;
  }

  async function fees(mint, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    if (typeof mint !== 'string' || !B58_RE.test(mint)) return { status: 400, body: { error: 'bad_pool' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, mint);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      const splitOk = curve.creator === c.B.sharingConfigOf(mint).toBase58();
      return { status: 200, body: { mint, pendingSol: await pending(c, mint, curve), splitOk, creatorPct: 100 - platformPct, platformPct, cluster } };
    } catch (err) {
      logger.error('Launch fees read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'fees_read_failed' } };
    }
  }

  // Builds an unsigned payout of a coin's waiting creator fees to its shareholders. Anyone can send it: it only
  // moves money to the wallets in the coin's fee split, and the sender pays the network fee.
  async function distribute(input, ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.pool !== 'string' || !B58_RE.test(b.pool)) return { status: 400, body: { error: 'bad_pool' } };
    if (typeof b.payer !== 'string' || !B58_RE.test(b.payer)) return { status: 400, body: { error: 'bad_creator' } };
    try {
      const c = await chain();
      const curve = await readCurve(c, b.pool);
      if (!curve) return { status: 404, body: { error: 'pool_not_found' } };
      if (curve.complete) return { status: 409, body: { error: 'migrated' } };
      if (curve.creator !== c.B.sharingConfigOf(b.pool).toBase58()) return { status: 409, body: { error: 'split_not_set' } };
      const waiting = await pending(c, b.pool, curve);
      if (waiting < 0.00001) return { status: 409, body: { error: 'nothing_to_claim' } };
      const acc = await c.connection.getAccountInfo(c.B.sharingConfigOf(b.pool));
      const cfg = pump.decodeAccount(pump.IDLS.fees, 'SharingConfig', acc.data, c.web3);
      const holders = (cfg.shareholders || []).map(s => s.address);
      if (!holders.length) throw new Error('fee split has no shareholders');
      const payerPk = new c.web3.PublicKey(b.payer);
      const ixs = [
        c.B.sweepCreatorFee({ payer: payerPk, mint: b.pool, creator: curve.creator }),
        c.B.distribute({ payer: payerPk, mint: b.pool, shareholders: holders.map(a => new c.web3.PublicKey(a)) })
      ];
      return { status: 200, body: { transaction: await toTx(c, budget(c, CU.distribute).concat(ixs), payerPk), waitingSol: waiting, cluster } };
    } catch (err) {
      logger.error('Launch distribute failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  // What the platform has earned and not yet been paid, per coin. `mints` is the list of HatchPad launches.
  async function partnerFees(ctx) {
    if (!enabled) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    try {
      const c = await chain();
      const list = [];
      for (const mint of (ctx && ctx.mints) || []) {
        const curve = await readCurve(c, mint).catch(() => null);
        if (!curve || curve.creator !== c.B.sharingConfigOf(mint).toBase58()) continue;
        const total = await pending(c, mint, curve);
        list.push({ pool: mint, preset: '', waitingSol: total * platformPct / 100, totalSol: total });
      }
      list.sort((a, b) => b.waitingSol - a.waitingSol);
      return { status: 200, body: { feeClaimers: [platformWallet], pools: list, totalWaitingSol: list.reduce((s, p) => s + p.waitingSol, 0), cluster } };
    } catch (err) {
      logger.error('Partner fee read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'fees_read_failed' } };
    }
  }

  return { info, prepare, step, status, pool, inspect, buy, fees, distribute, partnerFees };
}

// Metadata for the token, read by wallets and explorers. Built from the link and the stored animal, so the
// page never has to host anything else. `art` is the stored record for the picture, if there is one.
function metadataFor(name, symbol, art, base, cluster) {
  const n = cleanText(name, 32);
  const s = typeof symbol === 'string' ? symbol.replace(/^\$/, '').trim().toUpperCase() : '';
  if (!n || !SYMBOL_RE.test(s)) return null;
  const description = art && art.description ? cleanText(art.description, 200) : (cluster === 'mainnet-beta' ? 'A coin launched on HatchPad.' : 'A devnet test token launched on HatchPad.');
  const meta = { name: n, symbol: s, description, image: art && art.id && base ? base + '/art/' + art.id + '.' + (art.ext === 'jpg' ? 'jpg' : 'png') : '' };
  // The creator's own links, in the field names wallets and explorers read.
  const links = art && art.links && typeof art.links === 'object' ? art.links : {};
  if (links.website) { meta.external_url = links.website; meta.website = links.website; }
  if (links.twitter) meta.twitter = links.twitter;
  if (links.telegram) meta.telegram = links.telegram;
  if (links.website || links.twitter || links.telegram) meta.extensions = Object.assign({}, links.website ? { website: links.website } : {}, links.twitter ? { twitter: links.twitter } : {}, links.telegram ? { telegram: links.telegram } : {});
  return meta;
}

module.exports = { createLauncher, metadataFor, cleanText };
