// Creates one on-chain config for each fee preset on the page (low, standard, creator-first) and
// saves their addresses to devnet/presets.json. The launch flow reuses these configs, so creators
// never need a config of their own. Re-running skips presets that already exist unless --force.
// Usage: node 06-create-presets.mjs [--force]
//   env THRESHOLD_SOL (default 1)    SOL raised on the curve before migration (devnet-sized)
//   env START_FEE_BPS (default 2500) launch-time fee that decays to the steady fee (25%)
//   env SUPPLY_ON_MIGRATION (default 20)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import L from '../public/logic.js';
import { client, loadKey, send, makeCurve } from './lib.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'presets.json');
const force = process.argv.includes('--force');
const thresholdSol = Number(process.env.THRESHOLD_SOL || 1);
const startFeeBps = Number(process.env.START_FEE_BPS || 2500);
const supplyOnMigration = Number(process.env.SUPPLY_ON_MIGRATION || 20);

const partner = loadKey('partner');
const { sdk, dbc } = await client();
const create = (dbc.partner.createConfig2 || dbc.partner.createConfig).bind(dbc.partner);

const saved = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const out = { network: 'devnet', thresholdSol, startFeeBps, supplyOnMigration, feeClaimer: partner.publicKey.toBase58(), presets: saved.presets || {} };

for (const pr of L.PRESETS) {
  if (out.presets[pr.id] && !force) { console.log(pr.id + ': already created, ' + out.presets[pr.id].config); continue; }
  const curve = makeCurve(sdk, { steadyFeeBps: Math.round(pr.total * 100), creatorSharePct: pr.share, startFeeBps, thresholdSol, supplyOnMigration });
  const config = Keypair.generate();
  const tx = await create({
    config: config.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey,
    payer: partner.publicKey, quoteMint: NATIVE_MINT, ...curve
  });
  await send(tx, [partner, config], 'create ' + pr.id);
  out.presets[pr.id] = { config: config.publicKey.toBase58(), totalPct: pr.total, creatorSharePct: pr.share };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2)); // save after each one so a failure keeps progress
  console.log(pr.id + ': ' + config.publicKey.toBase58());
}
fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
console.log('\nSaved ' + FILE);
console.log('These are public addresses. Commit and push devnet/presets.json so the server can use them.');
