'use strict';

// Devnet launch flow, server side. The server builds an UNSIGNED token-launch transaction for the
// creator's wallet to sign. It holds no keys: the only secret it generates is the new token's mint
// keypair, which signs once here and is then discarded. Fee presets come from devnet/presets.json,
// which lists one on-chain config per preset. Mainnet is refused on purpose until a security review.
//
// The Meteora SDK is loaded only when someone launches, so a problem with it can never stop the
// website from starting.

const fs = require('fs');

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

function loadPresets(file, cluster) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || j.network !== cluster || !j.presets || typeof j.presets !== 'object') return null;
    const ok = {};
    for (const id of Object.keys(j.presets)) {
      const p = j.presets[id];
      if (p && typeof p.config === 'string' && B58_RE.test(p.config)) ok[id] = { config: p.config, totalPct: p.totalPct, creatorSharePct: p.creatorSharePct };
    }
    const threshold = Number(j.thresholdSol);
    return Object.keys(ok).length ? { network: cluster, thresholdSol: Number.isFinite(threshold) && threshold > 0 ? threshold : null, presets: ok } : null;
  } catch (err) {
    return null;
  }
}

async function loadReal() {
  const [sdk, web3, spl, bnMod] = await Promise.all([
    import('@meteora-ag/dynamic-bonding-curve-sdk'),
    import('@solana/web3.js'),
    import('@solana/spl-token'),
    import('bn.js')
  ]);
  return { sdk, web3, spl, BN: bnMod.default || bnMod };
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

function createLauncher(opts) {
  const o = opts || {};
  const cluster = o.cluster || 'devnet';
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new Error('Unknown cluster "' + cluster + '". Use devnet or mainnet-beta.');
  const isMain = cluster === 'mainnet-beta';
  if (isMain && o.allowMainnet !== true) throw new Error('Mainnet is switched off. Set MAINNET_ENABLED=yes to allow real-money launches.');
  const presets = o.presets === undefined ? loadPresets(o.presetsFile, cluster) : o.presets;
  const rpcUrl = o.rpcUrl || (isMain ? '' : 'https://api.devnet.solana.com');
  const load = o.load || loadReal;
  const logger = o.logger || console;
  const allow = createLimiter(o.maxPerMinute || 10, 60000, o.now || Date.now);
  const allowRead = createLimiter(o.maxReadsPerMinute || 120, 60000, o.now || Date.now);
  const presetConfigs = new Map(presets ? Object.keys(presets.presets).map(id => [presets.presets[id].config, id]) : []);

  if (isMain && !rpcUrl) throw new Error('Mainnet needs LAUNCH_RPC_URL set to a dedicated mainnet RPC.');
  if (isMain && /devnet|testnet/i.test(rpcUrl)) throw new Error('LAUNCH_CLUSTER is mainnet-beta but LAUNCH_RPC_URL looks like devnet.');
  if (!isMain && /mainnet/i.test(rpcUrl)) throw new Error('LAUNCH_CLUSTER is devnet but LAUNCH_RPC_URL looks like mainnet.');

  function info() {
    const out = { enabled: Boolean(presets), cluster, presets: presets ? Object.keys(presets.presets) : [] };
    if (presets) {
      // What each preset charges and shares, so the page can say it without a second copy of the numbers.
      out.terms = {};
      for (const id of out.presets) out.terms[id] = { totalPct: presets.presets[id].totalPct, creatorSharePct: presets.presets[id].creatorSharePct };
      out.thresholdSol = presets.thresholdSol;
    }
    return out;
  }

  // Returns { status, body }. Never throws.
  async function prepare(input, ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };

    const b = input && typeof input === 'object' ? input : {};
    // Own properties only, so names like __proto__ or constructor are not presets.
    const preset = typeof b.preset === 'string' && Object.prototype.hasOwnProperty.call(presets.presets, b.preset) ? presets.presets[b.preset] : null;
    if (!preset) return { status: 400, body: { error: 'bad_preset' } };
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
    // An optional first buy by the creator, put in the same transaction as the launch.
    const firstBuySol = b.firstBuySol === undefined || b.firstBuySol === null || b.firstBuySol === '' ? 0 : Number(b.firstBuySol);
    if (!Number.isFinite(firstBuySol) || firstBuySol < 0 || (firstBuySol > 0 && (firstBuySol < MIN_BUY_SOL || firstBuySol > MAX_BUY_SOL))) return { status: 400, body: { error: 'bad_amount' } };
    const base = String((ctx && ctx.baseUrl) || '').replace(/\/+$/, '');
    const uri = base + '/meta.json?n=' + encodeURIComponent(name) + '&s=' + encodeURIComponent(symbol) + (artId ? '&i=' + artId : '');
    if (!/^https?:\/\//.test(base) || uri.length > MAX_URI) return { status: 400, body: { error: 'uri_too_long' } };

    try {
      const { sdk, web3, spl, BN } = await load();
      const connection = new web3.Connection(rpcUrl, 'confirmed');
      const dbc = new sdk.DynamicBondingCurveClient(connection, 'confirmed');
      const creatorPk = new web3.PublicKey(b.creator);
      const configPk = new web3.PublicKey(preset.config);
      const baseMint = web3.Keypair.generate();

      // Meteora's docs put createPool under client.creator; older builds used client.pool.
      const svc = dbc.creator && dbc.creator.createPool ? dbc.creator : dbc.pool;
      const createPoolParam = {
        baseMint: baseMint.publicKey, config: configPk, name, symbol, uri,
        payer: creatorPk, poolCreator: creatorPk
      };
      let tx;
      if (firstBuySol > 0) {
        // The pool is created and the creator's buy is in the same transaction, so nobody can buy before the
        // creator. The pool does not exist yet, so there is nothing to front-run and no minimum is needed.
        const fb = [dbc.creator, dbc.pool].find(s => s && typeof s.createPoolWithFirstBuy === 'function');
        if (!fb || !BN) return { status: 501, body: { error: 'first_buy_unsupported' } };
        const out = await fb.createPoolWithFirstBuy({
          createPoolParam,
          firstBuyParam: {
            buyer: creatorPk, receiver: creatorPk, buyAmount: new BN(Math.floor(firstBuySol * 1e9)),
            minimumAmountOut: new BN(0), referralTokenAccount: null
          }
        });
        // Some SDK versions return the transaction itself, others an object holding it. Keep it one transaction.
        tx = out && out.createPoolTx ? out.createPoolTx : out;
        if (out && out.swapBuyTx && typeof tx.add === 'function') tx.add(out.swapBuyTx);
        if (!tx || typeof tx.serialize !== 'function') throw new Error('createPoolWithFirstBuy returned something unexpected');
      } else {
        tx = await svc.createPool(createPoolParam);
      }
      const latest = await connection.getLatestBlockhash('confirmed');
      tx.feePayer = creatorPk;
      tx.recentBlockhash = latest.blockhash;
      tx.partialSign(baseMint);

      const pool = sdk.deriveDbcPoolAddress(spl.NATIVE_MINT, baseMint.publicKey, configPk);
      return {
        status: 200,
        body: {
          transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
          mint: baseMint.publicKey.toBase58(),
          pool: pool.toBase58(),
          preset: b.preset,
          firstBuySol: firstBuySol > 0 ? firstBuySol : 0,
          cluster
        }
      };
    } catch (err) {
      logger.error('Launch prepare failed: ' + (err && err.message ? err.message : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }


  // ---- Reading the chain: whether a transaction landed, and where a curve stands ----

  async function status(sig, ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    if (typeof sig !== 'string' || !SIG_RE.test(sig)) return { status: 400, body: { error: 'bad_signature' } };
    try {
      const { web3 } = await load();
      const connection = new web3.Connection(rpcUrl, 'confirmed');
      const r = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
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

  // Loads a pool and checks it was made from one of our preset configs, so this only ever serves AnimalPad launches.
  async function readPool(address) {
    const { sdk, web3, spl, BN } = await load();
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    const dbc = new sdk.DynamicBondingCurveClient(connection, 'confirmed');
    const poolPk = new web3.PublicKey(address);
    const ps = await dbc.state.getPool(poolPk);
    if (!ps) return { error: 'pool_not_found' };
    // Different SDK versions nest the pool account differently; accept both.
    const v = ps.config ? ps : ps.poolState;
    const presetId = presetConfigs.get(v.config.toBase58());
    if (!presetId) return { error: 'not_an_animalpad_pool' };
    const cfg = await dbc.state.getPoolConfig(v.config);
    const raised = Number(v.quoteReserve.toString());
    const need = Number(cfg.migrationQuoteThreshold.toString());
    // The SDK's quote reads virtualPool.poolState, so it needs the wrapper form of the pool account.
    const quotePool = ps.poolState ? ps : { poolState: v };
    return { sdk, web3, spl, BN, connection, dbc, poolPk, v, quotePool, cfg, presetId, raised, need };
  }

  // The curve's state, with no rate limit. For the server's own use (the public list of launches).
  async function inspect(address) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (typeof address !== 'string' || !B58_RE.test(address)) return { status: 400, body: { error: 'bad_pool' } };
    try {
      const r = await readPool(address);
      if (r.error) return { status: 404, body: { error: r.error } };
      const migrated = Boolean(Number(r.v.isMigrated));
      return {
        status: 200,
        body: {
          address, preset: r.presetId,
          raisedSol: r.raised / 1e9, thresholdSol: r.need / 1e9,
          progress: r.need ? Math.min(1, r.raised / r.need) : 0,
          migrated, curveFull: migrated || (r.need > 0 && r.raised >= r.need), cluster
        }
      };
    } catch (err) {
      logger.error('Launch pool read failed: ' + (err && err.message ? err.message : 'unknown error'));
      return { status: 502, body: { error: 'pool_read_failed' } };
    }
  }

  async function pool(address, ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    return inspect(address);
  }

  // Builds an unsigned buy for the buyer's wallet to sign.
  async function buy(input, ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.pool !== 'string' || !B58_RE.test(b.pool)) return { status: 400, body: { error: 'bad_pool' } };
    if (typeof b.buyer !== 'string' || !B58_RE.test(b.buyer)) return { status: 400, body: { error: 'bad_buyer' } };
    const sol = Number(b.sol);
    if (!Number.isFinite(sol) || sol < MIN_BUY_SOL || sol > MAX_BUY_SOL) return { status: 400, body: { error: 'bad_amount' } };

    try {
      const r = await readPool(b.pool);
      if (r.error) return { status: 404, body: { error: r.error } };
      if (Boolean(Number(r.v.isMigrated))) return { status: 409, body: { error: 'migrated' } };
      if (r.need > 0 && r.raised >= r.need) return { status: 409, body: { error: 'curve_full' } };

      const lamports = Math.floor(sol * 1e9);
      const amountIn = new r.BN(lamports);
      const buyerPk = new r.web3.PublicKey(b.buyer);
      // A buy that would fill the curve must be a partial fill.
      const crossing = r.need - r.raised < lamports * 1.2;
      const swapMode = crossing ? r.sdk.SwapMode.PartialFill : r.sdk.SwapMode.ExactIn;
      let minimumAmountOut = new r.BN(0);
      // The quote sets the safety minimum (3% slippage). The SDK's quote has thrown on some devnet pools,
      // so devnet falls back to no minimum and logs it. On mainnet a failed quote stops the buy instead.
      try {
        const currentPoint = r.cfg.activationType === r.sdk.ActivationType.Slot
          ? new r.BN(await r.connection.getSlot())
          : new r.BN(Math.floor(Date.now() / 1000));
        const quote = r.dbc.pool.swapQuote2({
          virtualPool: r.quotePool, config: r.cfg, swapBaseForQuote: false, swapMode, amountIn, slippageBps: 300,
          hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint
        });
        minimumAmountOut = quote.minimumAmountOut;
      } catch (qerr) {
        logger.error('Launch buy quote failed' + (isMain ? ', buy refused: ' : ', sending with no minimum: ') + (qerr && qerr.stack ? qerr.stack : qerr));
        if (isMain) return { status: 502, body: { error: 'quote_failed' } };
      }
      const tx = await r.dbc.pool.swap2({
        owner: buyerPk, payer: buyerPk, pool: r.poolPk, swapBaseForQuote: false, swapMode, amountIn,
        minimumAmountOut, referralTokenAccount: null
      });
      const latest = await r.connection.getLatestBlockhash('confirmed');
      tx.feePayer = buyerPk;
      tx.recentBlockhash = latest.blockhash;
      return {
        status: 200,
        body: {
          transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
          partialFill: crossing, cluster
        }
      };
    } catch (err) {
      logger.error('Launch buy failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  // What the creator has earned on the curve and not yet claimed.
  async function fees(address, ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    if (typeof address !== 'string' || !B58_RE.test(address)) return { status: 400, body: { error: 'bad_pool' } };
    try {
      const r = await readPool(address);
      if (r.error) return { status: 404, body: { error: r.error } };
      const b = await r.dbc.state.getPoolFeeBreakdown(r.poolPk);
      const part = b && b.creator ? b.creator : {};
      const lamports = x => (x && typeof x.toString === 'function' ? Number(x.toString()) : 0) || 0;
      return {
        status: 200,
        body: {
          address, creator: r.v.creator.toBase58(),
          unclaimedSol: lamports(part.unclaimedQuoteFee) / 1e9,
          claimedSol: lamports(part.claimedQuoteFee) / 1e9,
          cluster
        }
      };
    } catch (err) {
      logger.error('Launch fees read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'fees_read_failed' } };
    }
  }

  // Builds an unsigned claim of the creator's trading fees. Only the wallet that launched the pool can use it.
  async function claim(input, ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.pool !== 'string' || !B58_RE.test(b.pool)) return { status: 400, body: { error: 'bad_pool' } };
    if (typeof b.creator !== 'string' || !B58_RE.test(b.creator)) return { status: 400, body: { error: 'bad_creator' } };
    try {
      const r = await readPool(b.pool);
      if (r.error) return { status: 404, body: { error: r.error } };
      if (r.v.creator.toBase58() !== b.creator) return { status: 403, body: { error: 'not_creator' } };
      const breakdown = await r.dbc.state.getPoolFeeBreakdown(r.poolPk);
      const unclaimed = breakdown && breakdown.creator && breakdown.creator.unclaimedQuoteFee;
      if (!unclaimed || Number(unclaimed.toString()) <= 0) return { status: 409, body: { error: 'nothing_to_claim' } };
      const creatorPk = new r.web3.PublicKey(b.creator);
      const MAX = new r.BN('18446744073709551615');
      const tx = await r.dbc.creator.claimCreatorTradingFeeToReceiver({
        creator: creatorPk, payer: creatorPk, pool: r.poolPk,
        maxBaseAmount: MAX, maxQuoteAmount: MAX, receiver: creatorPk
      });
      const latest = await r.connection.getLatestBlockhash('confirmed');
      tx.feePayer = creatorPk;
      tx.recentBlockhash = latest.blockhash;
      return {
        status: 200,
        body: { transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'), cluster }
      };
    } catch (err) {
      logger.error('Launch claim failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  // What the platform (the config's fee claimer) has earned on every curve and not yet claimed. Read-only,
  // and it is all public on-chain data. The wallet check happens on the chain, not here.
  async function partnerFees(ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allowRead((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    try {
      const { web3, sdk } = await load();
      const connection = new web3.Connection(rpcUrl, 'confirmed');
      const dbc = new sdk.DynamicBondingCurveClient(connection, 'confirmed');
      const pools = [];
      const claimers = new Set();
      for (const id of Object.keys(presets.presets)) {
        const configPk = new web3.PublicKey(presets.presets[id].config);
        const cfgRaw = await dbc.state.getPoolConfig(configPk);
        const cfg = cfgRaw && cfgRaw.account ? cfgRaw.account : cfgRaw;
        if (cfg && cfg.feeClaimer) claimers.add(cfg.feeClaimer.toBase58());
        const fees = await dbc.state.getPoolsFeesByConfig(configPk);
        for (const f of fees) {
          pools.push({
            pool: f.poolAddress.toBase58(), preset: id,
            waitingSol: Number(f.partnerQuoteFee.toString()) / 1e9,
            totalSol: Number(f.totalTradingQuoteFee.toString()) / 1e9
          });
        }
      }
      pools.sort((a, b) => b.waitingSol - a.waitingSol);
      return { status: 200, body: {
        feeClaimers: Array.from(claimers), pools,
        totalWaitingSol: pools.reduce((s, p) => s + p.waitingSol, 0), cluster
      } };
    } catch (err) {
      logger.error('Partner fee read failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'fees_read_failed' } };
    }
  }

  // An unsigned claim of the platform's share of one pool's trading fees. Only the config's fee claimer can
  // sign it, so asking for one for another wallet is refused here and would fail on-chain anyway.
  async function partnerClaim(input, ctx) {
    if (!presets) return { status: 503, body: { error: 'launch_unavailable' } };
    if (!allow((ctx && ctx.ip) || 'unknown')) return { status: 429, body: { error: 'rate_limited' } };
    const b = input && typeof input === 'object' ? input : {};
    if (typeof b.pool !== 'string' || !B58_RE.test(b.pool)) return { status: 400, body: { error: 'bad_pool' } };
    if (typeof b.claimer !== 'string' || !B58_RE.test(b.claimer)) return { status: 400, body: { error: 'bad_claimer' } };
    try {
      const r = await readPool(b.pool);
      if (r.error) return { status: 404, body: { error: r.error } };
      const claimer = r.cfg.feeClaimer && r.cfg.feeClaimer.toBase58();
      if (!claimer || claimer !== b.claimer) return { status: 403, body: { error: 'not_fee_claimer' } };
      const fees = await r.dbc.state.getPoolsFeesByConfig(r.v.config);
      const mine = fees.find(f => f.poolAddress.toBase58() === b.pool);
      if (!mine || !mine.partnerQuoteFee || Number(mine.partnerQuoteFee.toString()) <= 0) return { status: 409, body: { error: 'nothing_to_claim' } };
      const claimerPk = new r.web3.PublicKey(b.claimer);
      const MAX = new r.BN('18446744073709551615');
      const tx = await r.dbc.partner.claimPartnerTradingFeeToReceiver({
        feeClaimer: claimerPk, payer: claimerPk, pool: r.poolPk,
        maxBaseAmount: MAX, maxQuoteAmount: MAX, receiver: claimerPk
      });
      const latest = await r.connection.getLatestBlockhash('confirmed');
      tx.feePayer = claimerPk;
      tx.recentBlockhash = latest.blockhash;
      return { status: 200, body: {
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        waitingSol: Number(mine.partnerQuoteFee.toString()) / 1e9, cluster
      } };
    } catch (err) {
      logger.error('Partner claim failed: ' + (err && err.stack ? err.stack : 'unknown error'));
      return { status: 502, body: { error: 'prepare_failed' } };
    }
  }

  return { info, prepare, status, pool, inspect, buy, fees, claim, partnerFees, partnerClaim };
}

// Metadata for the token, read by wallets and explorers. Built from the link and the stored animal, so the
// page never has to host anything else. `art` is the stored record for the picture, if there is one.
function metadataFor(name, symbol, art, base, cluster) {
  const n = cleanText(name, 32);
  const s = typeof symbol === 'string' ? symbol.replace(/^\$/, '').trim().toUpperCase() : '';
  if (!n || !SYMBOL_RE.test(s)) return null;
  const description = art && art.description ? cleanText(art.description, 200) : (cluster === 'mainnet-beta' ? 'A coin launched on AnimalPad.' : 'A devnet test token launched on AnimalPad.');
  const meta = { name: n, symbol: s, description, image: art && art.id && base ? base + '/art/' + art.id + '.' + (art.ext === 'jpg' ? 'jpg' : 'png') : '' };
  // The creator's own links, in the field names wallets and explorers read.
  const links = art && art.links && typeof art.links === 'object' ? art.links : {};
  if (links.website) { meta.external_url = links.website; meta.website = links.website; }
  if (links.twitter) meta.twitter = links.twitter;
  if (links.telegram) meta.telegram = links.telegram;
  if (links.website || links.twitter || links.telegram) meta.extensions = Object.assign({}, links.website ? { website: links.website } : {}, links.twitter ? { twitter: links.twitter } : {}, links.telegram ? { telegram: links.telegram } : {});
  return meta;
}

module.exports = { createLauncher, loadPresets, metadataFor, cleanText };
