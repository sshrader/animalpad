// Read-only. Prints where each preset's curve starts and ends, as market cap, straight from the chain.
// Usage: node 11-curve-info.mjs [--sol-usd 150]      (same env as 06: CLUSTER, MAINNET_OK, RPC_URL)
// Reads devnet/presets.json, or devnet/presets.mainnet-beta.json when CLUSTER=mainnet-beta.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicKey } from '@solana/web3.js';
import { client, IS_MAIN, arg } from './lib.mjs';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), IS_MAIN ? 'presets.mainnet-beta.json' : 'presets.json');
const presets = JSON.parse(fs.readFileSync(file, 'utf8'));
const usd = Number(arg('sol-usd', 0)) || 0;
const { dbc } = await client();
const show = x => (x && typeof x.toString === 'function' ? x.toString() : String(x));
const TWO64 = 2 ** 64;
// Token has 6 decimals, SOL 9, 1 billion tokens: market cap in SOL = (sqrtPrice / 2^64)^2 * 10^6.
const mcap = sqrt => Math.pow(Number(show(sqrt)) / TWO64, 2) * 1e6;
const fmt = sol => sol.toFixed(2) + ' SOL' + (usd ? ' (~$' + Math.round(sol * usd).toLocaleString() + ')' : '');

console.log('Curves in ' + path.basename(file) + (usd ? ', at $' + usd + ' per SOL' : ' (add --sol-usd 150 to see dollars)') + '\n');
for (const id of Object.keys(presets.presets)) {
  const cfg = await dbc.state.getPoolConfig(new PublicKey(presets.presets[id].config));
  const pts = (cfg.curve || []).filter(p => p && Number(show(p.liquidity)) > 0);
  const last = pts.length ? pts[pts.length - 1] : null;
  console.log(id);
  console.log('  fills at                ' + (Number(show(cfg.migrationQuoteThreshold)) / 1e9) + ' SOL raised');
  console.log('  starts at market cap    ' + fmt(mcap(cfg.sqrtStartPrice)));
  if (last) console.log('  ends (graduates) at     ' + fmt(mcap(last.sqrtPrice)));
  console.log('  curve segments          ' + pts.length);
}
