// Makes two throwaway devnet wallets (partner/creator and buyer) and tries a small airdrop.
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { connection, makeKey, sol } from './lib.mjs';

for (const name of ['partner', 'buyer']) {
  const { kp, created } = makeKey(name);
  console.log((created ? 'Created ' : 'Found   ') + name.padEnd(8) + kp.publicKey.toBase58());
  try {
    if (created) await connection.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
  } catch (err) {
    console.log('  airdrop refused (rate limit is common): ' + (err.message || err).toString().slice(0, 80));
  }
  const bal = await connection.getBalance(kp.publicKey);
  console.log('  balance ' + sol(bal).toFixed(3) + ' SOL');
}
console.log('\nIf a balance is low, fund each address at https://faucet.solana.com (choose devnet).');
console.log('Partner needs about 1 SOL. Buyer needs roughly the migration threshold plus fees (default 5 SOL, so ask for 6+).');
