// Read-only: prints where a pool stands (curve fill, migration progress). Changes nothing.
// Usage: node 07-inspect.mjs --pool <address>
import { PublicKey } from '@solana/web3.js';
import { client, readState, sol, arg, RPC_URL } from './lib.mjs';

const poolAddress = arg('pool', readState().pool);
if (!poolAddress) { console.error('Pass --pool <address>'); process.exit(1); }
const { dbc } = await client();
const ps = await dbc.state.getPool(new PublicKey(poolAddress));
if (!ps) { console.error('No pool at that address'); process.exit(1); }
const v = ps.config ? ps : ps.poolState;
const cfg = await dbc.state.getPoolConfig(v.config);
const show = x => (x && typeof x.toString === 'function' ? x.toString() : String(x));
console.log('pool                    ' + poolAddress);
console.log('rpc                     ' + RPC_URL.replace(/(api-key|key)=[^&]+/i, '$1=***'));
console.log('config                  ' + show(v.config));
console.log('top-level fields        ' + Object.keys(ps).join(','));
console.log('baseReserve            ' + show(v.baseReserve));
console.log('quoteReserve            ' + sol(Number(show(v.quoteReserve))) + ' SOL');
console.log('migrationQuoteThreshold ' + sol(Number(show(cfg.migrationQuoteThreshold))) + ' SOL');
console.log('isMigrated              ' + show(v.isMigrated));
console.log('migrationProgress       ' + show(v.migrationProgress) + '   (0 before curve done, 1 curve done, 2 ready to migrate, 3 migrated)');
console.log('migrationOption         ' + show(cfg.migrationOption) + '   migrationFeeOption ' + show(cfg.migrationFeeOption));
console.log('lockedVesting amount    ' + show(cfg.lockedVestingConfig && cfg.lockedVestingConfig.amountPerPeriod) + ' per period x ' + show(cfg.lockedVestingConfig && cfg.lockedVestingConfig.numberOfPeriod));

// Everything the pool account holds, for diagnosing odd numbers. Public data only.
if (process.argv.includes('--all')) {
  console.log('\nAll pool fields:');
  for (const [k, val] of Object.entries(v)) {
    if (val && typeof val === 'object' && !(typeof val.toString === 'function' && val.toString !== Object.prototype.toString)) continue;
    console.log('  ' + k.padEnd(28) + show(val));
  }
}
