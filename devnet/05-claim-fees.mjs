// Shows the trading fees earned on the curve and claims the partner (platform) and creator shares.
// Usage: node 05-claim-fees.mjs
// The platform share goes to the partner wallet. The creator share goes to the wallet that launched the
// token (state.creator, set in step 2; partner if none).
// Only fees earned on the curve (before migration) are covered here. Fees after migration come from
// the DAMM v2 pool's locked liquidity position, which is a separate step.
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';
import { client, connection, loadKey, send, readState, sol, arg } from './lib.mjs';

const state = readState();
const poolAddress = arg('pool', state.pool);
if (!poolAddress) { console.error('No pool yet. Run the earlier steps first, or pass --pool <address>.'); process.exit(1); }

const partnerWallet = loadKey('partner');
const creatorName = state.creator || 'partner';
const creatorWallet = loadKey(creatorName);
const pool = new PublicKey(poolAddress);
const { dbc } = await client();
const MAX = new BN('18446744073709551615');

const show = (v) => (v && typeof v.toString === 'function') ? v.toString() : String(v);

// The breakdown call and its field names come from Meteora's docs; print whatever it returns.
try {
  const b = await dbc.state.getPoolFeeBreakdown(pool);
  console.log('Fee breakdown (lamports for SOL-quoted fees):');
  console.log(JSON.stringify(b, (k, v) => (v && v.type === 'BN') || (v && v._bn) || (v && typeof v.toString === 'function' && v.constructor && v.constructor.name === 'BN') ? v.toString() : v, 2));
} catch (err) {
  console.log('Could not read the fee breakdown: ' + (err.message || err));
}

const beforeP = await connection.getBalance(partnerWallet.publicKey);
const beforeC = await connection.getBalance(creatorWallet.publicKey);

async function claim(label, build, signer) {
  try {
    const tx = await build();
    await send(tx, [signer], label);
  } catch (err) {
    console.log(label + ' failed: ' + (err.message || err));
  }
}

await claim('claim partner (platform) fees', () => dbc.partner.claimPartnerTradingFeeToReceiver({
  feeClaimer: partnerWallet.publicKey, payer: partnerWallet.publicKey, pool,
  maxBaseAmount: MAX, maxQuoteAmount: MAX, receiver: partnerWallet.publicKey
}), partnerWallet);

await claim('claim creator fees', () => dbc.creator.claimCreatorTradingFeeToReceiver({
  creator: creatorWallet.publicKey, payer: creatorWallet.publicKey, pool,
  maxBaseAmount: MAX, maxQuoteAmount: MAX, receiver: creatorWallet.publicKey
}), creatorWallet);

const afterP = await connection.getBalance(partnerWallet.publicKey);
const afterC = await connection.getBalance(creatorWallet.publicKey);
console.log('Partner wallet SOL: ' + sol(beforeP).toFixed(6) + ' -> ' + sol(afterP).toFixed(6));
if (creatorName !== 'partner') console.log('Creator (' + creatorName + ') SOL: ' + sol(beforeC).toFixed(6) + ' -> ' + sol(afterC).toFixed(6) + '  (this wallet also bought, so its balance includes that spending)');
console.log('Network fees are included in these changes. Fees paid as wrapped SOL sit in a token account instead; check the explorer links.');
