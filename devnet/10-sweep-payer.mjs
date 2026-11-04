// Sends everything left in the payer wallet file to another address (your own wallet).
// Usage: node 10-sweep-payer.mjs <destination public address> [--yes]
// Uses the same env as 06: CLUSTER, MAINNET_OK (mainnet), RPC_URL, PAYER_KEYPAIR.
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { connection, loadKeyFile, send, IS_MAIN } from './lib.mjs';

const dest = process.argv[2];
if (!dest || dest.startsWith('--')) { console.error('Usage: node 10-sweep-payer.mjs <destination public address> [--yes]'); process.exit(1); }
let to;
try { to = new PublicKey(dest); } catch (e) { console.error('That is not a valid address.'); process.exit(1); }
const payer = loadKeyFile(process.env.PAYER_KEYPAIR);
if (to.equals(payer.publicKey)) { console.error('The destination is the payer wallet itself.'); process.exit(1); }

const balance = await connection.getBalance(payer.publicKey, 'confirmed');
const blockhash = await connection.getLatestBlockhash('confirmed');
const probe = new Transaction({ feePayer: payer.publicKey, ...blockhash }).add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: 1 }));
const fee = (await connection.getFeeForMessage(probe.compileMessage(), 'confirmed')).value || 5000;
const amount = balance - fee;
console.log('Payer ' + payer.publicKey.toBase58() + ' holds ' + (balance / 1e9) + ' SOL. Network fee ' + (fee / 1e9) + ' SOL.');
if (amount <= 0) { console.log('Nothing to send.'); process.exit(0); }
console.log('Will send ' + (amount / 1e9) + ' SOL to ' + to.toBase58());
if (!process.argv.includes('--yes')) { console.log('Check the destination, then re-run with --yes.'); process.exit(0); }
await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: amount })), [payer], 'sweep');
console.log('Done. The payer wallet is now empty.');
