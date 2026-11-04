// Makes the shared address lookup table that lets HatchPad create a coin and make the creator's first buy in ONE
// transaction. Run it once per network. It costs about 0.01 SOL of rent, paid from the payer file, and the table
// is FROZEN at the end so nobody (including you) can change it afterwards. The server refuses a table that is not frozen.
//
// Usage (from this folder):
//   $env:CLUSTER="mainnet-beta"; $env:MAINNET_OK="yes"; $env:RPC_URL="<mainnet rpc>"; $env:PAYER_KEYPAIR="<path to payer.json>"
//   node 12-make-lookup-table.mjs <platform fee wallet address> [--yes] [--no-freeze]
// Without --yes it only lists the addresses it would store. Then put the printed address in LAUNCH_LOOKUP_TABLE.
import { createRequire } from 'node:module';
import { AddressLookupTableProgram, PublicKey, Transaction } from '@solana/web3.js';
import { connection, loadKeyFile, send, IS_MAIN, CLUSTER, RPC_URL, sol } from './lib.mjs';

const require = createRequire(import.meta.url);
const { createLauncher } = require('../launch.js');

const platform = process.argv[2];
try { new PublicKey(platform); } catch (e) { console.error('Pass the platform fee wallet address as the first argument.'); process.exit(1); }
const yes = process.argv.includes('--yes');
const freeze = !process.argv.includes('--no-freeze');

const launcher = createLauncher({
  cluster: CLUSTER, allowMainnet: IS_MAIN, rpcUrl: RPC_URL, platformWallet: platform,
  load: async () => ({ web3: await import('@solana/web3.js') })
});
const addresses = await launcher.lookupAddresses();
console.log('Cluster ' + CLUSTER + '. The table would hold ' + addresses.length + ' shared addresses:');
addresses.forEach(a => console.log('  ' + a));
if (!yes) { console.log('\nNothing was created. Re-run with --yes to create' + (freeze ? ' and freeze' : '') + ' the table.'); process.exit(0); }

const payer = loadKeyFile(process.env.PAYER_KEYPAIR);
const balance = await connection.getBalance(payer.publicKey);
console.log('\nPayer ' + payer.publicKey.toBase58() + ' has ' + sol(balance) + ' SOL.');
if (balance < 15_000_000) { console.error('Needs at least 0.015 SOL.'); process.exit(1); }

const slot = await connection.getSlot('finalized'); // a finalized slot is already in the network's recent-slot list
const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot });
await send(new Transaction().add(createIx), [payer], 'create table');
const keys = addresses.map(a => new PublicKey(a));
for (let i = 0; i < keys.length; i += 20) {
  await send(new Transaction().add(AddressLookupTableProgram.extendLookupTable({ payer: payer.publicKey, authority: payer.publicKey, lookupTable: table, addresses: keys.slice(i, i + 20) })), [payer], 'add addresses ' + (i + 1) + '-' + Math.min(i + 20, keys.length));
}
if (freeze) await send(new Transaction().add(AddressLookupTableProgram.freezeLookupTable({ authority: payer.publicKey, lookupTable: table })), [payer], 'freeze table');
console.log('\nDone. Set this in Railway:\n  LAUNCH_LOOKUP_TABLE=' + table.toBase58() + (freeze ? '' : '\n(Not frozen: the server will ignore it until you freeze it.)'));
