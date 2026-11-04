// Read-only. Shows what a transaction did: who paid how much SOL, and which program instructions ran.
// Usage: node 12-tx-info.mjs <signature>      (same env as 06: CLUSTER, MAINNET_OK, RPC_URL)
import { connection, RPC_URL } from './lib.mjs';

const sig = process.argv[2];
if (!sig) { console.error('Usage: node 12-tx-info.mjs <transaction signature>'); process.exit(1); }
const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
if (!tx) { console.error('Transaction not found (wrong cluster, or not confirmed yet).'); process.exit(1); }
console.log('rpc          ' + RPC_URL.replace(/(api-key|key)=[^&]+/i, '$1=***'));
console.log('result       ' + (tx.meta.err ? 'FAILED ' + JSON.stringify(tx.meta.err) : 'success'));
console.log('fee          ' + tx.meta.fee / 1e9 + ' SOL');
const keys = tx.transaction.message.staticAccountKeys ? tx.transaction.message.staticAccountKeys : tx.transaction.message.accountKeys;
console.log('\nSOL balance changes (accounts that moved more than 0.000001 SOL):');
keys.forEach((k, i) => {
  const d = (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9;
  if (Math.abs(d) > 0.000001) console.log('  ' + k.toBase58() + '  ' + (d > 0 ? '+' : '') + d.toFixed(6));
});
console.log('\nProgram steps (from the log):');
(tx.meta.logMessages || []).filter(l => /Instruction:|invoke \[1\]|failed|Error/i.test(l)).forEach(l => console.log('  ' + l));
console.log('\ninstructions in the transaction: ' + (tx.transaction.message.compiledInstructions || tx.transaction.message.instructions).length);
