// Creates one on-chain config for each fee preset on the page (low, standard, creator-first) and
// saves their addresses to devnet/presets.json. The launch flow reuses these configs, so creators
// never need a config of their own. Re-running skips presets that already exist unless --force.
// Usage: node 06-create-presets.mjs [--force]
//   env THRESHOLD_SOL (default 20)   SOL raised on the curve before migration
//   env START_FEE_BPS (default 2500) launch-time fee that decays to the steady fee (25%)
//   env SUPPLY_ON_MIGRATION (default 20)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import L from '../public/logic.js';
import { PublicKey } from '@solana/web3.js';
import { client, loadKey, loadKeyFile, send, makeCurve, IS_MAIN, CLUSTER, arg } from './lib.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), IS_MAIN ? 'presets.mainnet-beta.json' : 'presets.json');
const force = process.argv.includes('--force');
const thresholdSol = Number(process.env.THRESHOLD_SOL || 20);
const startFeeBps = Number(process.env.START_FEE_BPS || 2500);
const supplyOnMigration = Number(process.env.SUPPLY_ON_MIGRATION || 20);

// Devnet uses the local partner key for everything. Mainnet needs only the PUBLIC address that will earn
// the platform's share (--fee-claimer, ideally a Ledger or multisig address). Its private key is never used
// here. A separate funded "payer" key file pays the small account rent and signs.
const claimerArg = arg('fee-claimer', process.env.FEE_CLAIMER || '');
if (IS_MAIN && !claimerArg) { console.error('Pass --fee-claimer <public address> (or set FEE_CLAIMER).'); process.exit(1); }
const payer = IS_MAIN ? loadKeyFile(process.env.PAYER_KEYPAIR) : loadKey('partner');
const feeClaimer = claimerArg ? new PublicKey(claimerArg) : payer.publicKey;
if (IS_MAIN && (!(thresholdSol >= 1) || thresholdSol > 1000)) { console.error('THRESHOLD_SOL looks wrong: ' + thresholdSol); process.exit(1); }
console.log('Cluster ' + CLUSTER + ', curve fills at ' + thresholdSol + ' SOL, fee claimer ' + feeClaimer.toBase58());
if (IS_MAIN && !process.argv.includes('--yes')) { console.error('These settings cannot be changed later. Re-run with --yes to create them.'); process.exit(1); }
const { sdk, dbc } = await client();
const create = (dbc.partner.createConfig2 || dbc.partner.createConfig).bind(dbc.partner);

const saved = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const out = { network: CLUSTER, thresholdSol, startFeeBps, supplyOnMigration, feeClaimer: feeClaimer.toBase58(), presets: saved.presets || {} };

for (const pr of L.PRESETS) {
  if (out.presets[pr.id] && !force) { console.log(pr.id + ': already created, ' + out.presets[pr.id].config); continue; }
  const curve = makeCurve(sdk, { steadyFeeBps: Math.round(pr.total * 100), creatorSharePct: pr.share, startFeeBps, thresholdSol, supplyOnMigration });
  const config = Keypair.generate();
  const tx = await create({
    config: config.publicKey, feeClaimer, leftoverReceiver: feeClaimer,
    payer: payer.publicKey, quoteMint: NATIVE_MINT, ...curve
  });
  await send(tx, [payer, config], 'create ' + pr.id);
  out.presets[pr.id] = { config: config.publicKey.toBase58(), totalPct: pr.total, creatorSharePct: pr.share };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2)); // save after each one so a failure keeps progress
  console.log(pr.id + ': ' + config.publicKey.toBase58());
}
fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
console.log('\nSaved ' + FILE);
console.log('These are public addresses. Commit and push ' + path.basename(FILE) + ' so the server can use them.');
