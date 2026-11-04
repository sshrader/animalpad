// Buys from the curve with the buyer wallet until it reaches the migration threshold.
// Usage: node 03-buy.mjs [--step 1] [--max 20] [--pool <address>]   (step = SOL per buy, max = most buys)
// --pool buys from any pool, for example one launched from the website. It defaults to the pool from step 2.
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { client, connection, loadKey, send, readState, sol, arg } from './lib.mjs';

const state = readState();
const poolAddress = arg('pool', state.pool);
if (!poolAddress) { console.error('No pool yet. Run: npm run pool, or pass --pool <address>'); process.exit(1); }

const buyer = loadKey('buyer');
const { sdk, dbc } = await client();
const pool = new PublicKey(poolAddress);
const stepSol = Number(arg('step', 1));
const maxBuys = Number(arg('max', 20));

// Different SDK versions nest the pool account differently; accept both.
const vp = s => (s && s.config ? s : s.poolState);

async function progress() {
  const ps = await dbc.state.getPool(pool);
  const v = vp(ps);
  const cfg = await dbc.state.getPoolConfig(v.config);
  const raised = Number(v.quoteReserve.toString());
  const need = Number(cfg.migrationQuoteThreshold.toString());
  return { ps, cfg, v, pct: need ? raised / need : 0, raised, need };
}

for (let i = 1; i <= maxBuys; i++) {
  const p = await progress();
  console.log('Progress ' + (p.pct * 100).toFixed(1) + '% (' + sol(p.raised).toFixed(3) + ' of ' + sol(p.need).toFixed(3) + ' SOL)');
  if (p.pct >= 1 || p.v.isMigrated || p.v.isMigrated === 1) { console.log('Curve is full. Next: npm run migrate'); break; }

  const remaining = p.need - p.raised;
  const wantLamports = Math.floor(stepSol * 1e9);
  const crossing = remaining < wantLamports * 1.2;
  const swapMode = crossing ? sdk.SwapMode.PartialFill : sdk.SwapMode.ExactIn;
  const amountIn = new BN(wantLamports);
  const currentPoint = p.cfg.activationType === sdk.ActivationType.Slot
    ? new BN(await connection.getSlot())
    : new BN(Math.floor(Date.now() / 1000));

  // The SDK's partial-fill quote failed on its own (TypeError inside beginSwapQuote), so the buy that
  // crosses the threshold skips the quote and accepts any output. Fine on devnet; never do this on mainnet.
  let minimumAmountOut;
  if (crossing) {
    minimumAmountOut = new BN(0);
  } else {
    const quote = dbc.pool.swapQuote2({
      virtualPool: p.v, config: p.cfg, swapBaseForQuote: false, swapMode,
      amountIn, slippageBps: 300, hasReferral: false,
      eligibleForFirstSwapWithMinFee: false, currentPoint
    });
    minimumAmountOut = quote.minimumAmountOut;
  }

  const tx = await dbc.pool.swap2({
    owner: buyer.publicKey, payer: buyer.publicKey, pool,
    swapBaseForQuote: false, swapMode, amountIn,
    minimumAmountOut, referralTokenAccount: null
  });
  await send(tx, [buyer], 'buy ' + i + (crossing ? ' (partial fill)' : ''));
}
