// A free, send-nothing check of the pump.fun transactions HatchPad builds. It asks the network to SIMULATE them
// (no SOL is spent, nothing is signed) and prints whether the program accepted every account and argument.
//
// Usage (from this folder):
//   CLUSTER=mainnet-beta MAINNET_OK=yes RPC_URL=<mainnet rpc> node 11-check-pump.mjs <your wallet address> [<mint of any live pump.fun coin>]
//   node 11-check-pump.mjs <your wallet address>          (devnet, if pump.fun's program is on devnet)
//
// 1) "create": the transaction that creates a coin. The wallet needs about 0.02 SOL for the simulation to pass.
// 2) "buy" (only if you pass a live coin's mint): a 0.01 SOL buy of that coin, to check the buy accounts.
// The fee-split step can only be tested for real, on a coin that exists. See the README.
import { createRequire } from 'node:module';
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { connection, RPC_URL, CLUSTER, IS_MAIN } from './lib.mjs';

const require = createRequire(import.meta.url);
const { createLauncher } = require('../launch.js');

const wallet = process.argv[2];
const liveMint = process.argv[3];
try { new PublicKey(wallet); } catch (e) { console.error('Pass your wallet address as the first argument.'); process.exit(1); }

const launcher = createLauncher({
  cluster: CLUSTER, allowMainnet: IS_MAIN, rpcUrl: RPC_URL, platformWallet: wallet, platformSharePct: 20,
  load: async () => ({ web3: await import('@solana/web3.js') }), // use this folder's copy of web3.js
  maxPerMinute: 100, maxReadsPerMinute: 100, priorityMicroLamports: 0
});

async function simulate(label, b64) {
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  const v0 = new VersionedTransaction(tx.compileMessage());
  const r = await connection.simulateTransaction(v0, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const ok = !r.value.err;
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ok ? '  (' + r.value.unitsConsumed + ' compute units)' : '  ' + JSON.stringify(r.value.err)));
  if (!ok) (r.value.logs || []).slice(-12).forEach(l => console.log('      ' + l));
  return ok;
}

let allOk = true;
const made = await launcher.prepare({ name: 'Check Coin', symbol: 'CHECK', creator: wallet }, { ip: 'cli', baseUrl: 'https://example.com' });
if (made.status !== 200) { console.log('FAIL create: could not build it (' + made.body.error + ')'); allOk = false; }
else allOk = (await simulate('create coin', made.body.transaction)) && allOk;

if (liveMint) {
  const bought = await launcher.buy({ pool: liveMint, buyer: wallet, sol: 0.01 }, { ip: 'cli' });
  if (bought.status !== 200) { console.log('FAIL buy: could not build it (' + bought.body.error + ')'); allOk = false; }
  else allOk = (await simulate('buy 0.01 SOL of ' + liveMint, bought.body.transaction)) && allOk;
}
console.log(allOk ? '\nAll simulated transactions were accepted.' : '\nSomething was rejected. Send me the lines above.');
process.exit(allOk ? 0 : 1);
