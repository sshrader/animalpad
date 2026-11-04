// Builds a curve and creates the DBC config (the "partner" config every Draftpad launch will use).
// Usage: node 01-create-config.mjs [--sheet ../launch-sheet.json]
//   env THRESHOLD_SOL (default 5)   SOL raised on the curve before migration. Kept small so devnet SOL is enough.
//   env SUPPLY_ON_MIGRATION (default 20)   percent of supply sold on the curve before migration
import { Keypair } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { client, loadKey, send, writeState, arg, fromSheet, makeCurve } from './lib.mjs';

const partner = loadKey('partner');
const { sdk, dbc } = await client();
const terms = fromSheet(arg('sheet'));
terms.ignored.forEach(x => console.log('Not applied in this run: ' + x));

const thresholdSol = Number(process.env.THRESHOLD_SOL || 5);
const supplyOnMigration = Number(process.env.SUPPLY_ON_MIGRATION || 20);

const curve = makeCurve(sdk, {
  steadyFeeBps: terms.steadyFeeBps,
  creatorSharePct: terms.creatorSharePct,
  startFeeBps: Number(process.env.START_FEE_BPS || 5000),
  thresholdSol,
  supplyOnMigration
});

const config = Keypair.generate();
// SDK 2.x uses createConfig2; older builds only have createConfig.
const create = (dbc.partner.createConfig2 || dbc.partner.createConfig).bind(dbc.partner);
const tx = await create({
  config: config.publicKey,
  feeClaimer: partner.publicKey,
  leftoverReceiver: partner.publicKey,
  payer: partner.publicKey,
  quoteMint: NATIVE_MINT,
  ...curve
});

await send(tx, [partner, config], 'create config');
// A new config starts a new launch, so forget the previous pool.
writeState({ config: config.publicKey.toBase58(), thresholdSol, pool: null, baseMint: null, creator: null, name: terms.name || null, symbol: terms.symbol || null });
console.log('Config: ' + config.publicKey.toBase58());
console.log('Steady fee ' + terms.steadyFeeBps + ' bps, creator share ' + terms.creatorSharePct + '%, migrates at ' + thresholdSol + ' SOL.');
