// Free check of the NEXT step (fee split or first buy) of a coin that already exists. Nothing is spent or signed.
// Usage (from this folder, devnet):  node 13-check-step.mjs <your wallet address> <coin mint> [first buy SOL]
import { createRequire } from 'node:module';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { connection, RPC_URL, CLUSTER, IS_MAIN } from './lib.mjs';

const require = createRequire(import.meta.url);
const { createLauncher } = require('../launch.js');
const [wallet, mint, buy] = [process.argv[2], process.argv[3], Number(process.argv[4] || 0)];
try { new PublicKey(wallet); new PublicKey(mint); } catch (e) { console.error('Usage: node 13-check-step.mjs <wallet> <mint> [firstBuySol]'); process.exit(1); }

const launcher = createLauncher({
  cluster: CLUSTER, allowMainnet: IS_MAIN, rpcUrl: RPC_URL, platformWallet: wallet, platformSharePct: 20,
  lookupTable: process.env.LAUNCH_LOOKUP_TABLE || undefined,
  load: async () => ({ web3: await import('@solana/web3.js') }),
  maxPerMinute: 100, maxReadsPerMinute: 100, priorityMicroLamports: 0
});
const r = await launcher.step({ mint, creator: wallet, firstBuySol: buy }, { ip: 'cli' });
console.log('step answer:', r.status, r.body.step || r.body.error);
if (!r.body.transaction) process.exit(0);
const tx = VersionedTransaction.deserialize(Buffer.from(r.body.transaction, 'base64'));
const s = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
console.log(s.value.err ? 'FAIL ' + JSON.stringify(s.value.err) : 'PASS (' + s.value.unitsConsumed + ' compute units)');
(s.value.logs || []).slice(-20).forEach(l => console.log('   ' + l));
