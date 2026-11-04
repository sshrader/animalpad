// Migrates a full curve to a DAMM v2 pool. On devnet the automatic keeper does not run, so this is manual.
// Usage: node 04-migrate.mjs [--pool <address>]  (--pool targets a pool launched from the website)
//        node 04-migrate.mjs            (uses the config key for migration fee option 0, 25 bps, matching step 1)
//        DAMM_V2_CONFIG=<address> node 04-migrate.mjs   (override)
// Meteora's docs list 7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd for option 0 without saying whether it
// is the same on devnet. If it is rejected, send me the error text.
import { PublicKey } from '@solana/web3.js';
import { client, loadKey, send, readState, arg } from './lib.mjs';

const state = readState();
const poolAddress = arg('pool', state.pool);
if (!poolAddress) { console.error('No pool yet. Run: npm run pool, or pass --pool <address>'); process.exit(1); }
const dammConfig = process.env.DAMM_V2_CONFIG || '7F6dnUcRuyM2TwR8myT1dYypFXpPSxqwKNSFNkxyNESd';
console.log('DAMM v2 config: ' + dammConfig);

const payer = loadKey('partner');
const { dbc } = await client();

const res = await dbc.migration.migrateToDammV2({
  payer: payer.publicKey,
  pool: new PublicKey(poolAddress),
  dammConfig: new PublicKey(dammConfig)
});
// The SDK returns { transaction, ... }. Some migration steps may need extra signers.
const tx = res.transaction || res;
// The migration creates position NFTs, so the SDK may hand back extra keypairs that must sign.
const extra = [...(res.signers || []), ...Object.values(res)].filter(v => v && v.secretKey && v.publicKey);
await send(tx, [payer, ...extra], 'migrate to DAMM v2');
console.log('Migrated. Check the pool and token on https://explorer.solana.com/?cluster=devnet');
