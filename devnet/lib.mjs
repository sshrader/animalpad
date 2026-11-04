// Shared helpers for the devnet spike. Keys live in devnet/keys/ and state in devnet/state.json.
// Both are git-ignored. Never paste a key file's contents into chat or commit it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = path.join(HERE, 'keys');
const STATE = path.join(HERE, 'state.json');

export const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
export const connection = new Connection(RPC_URL, 'confirmed');

if (/mainnet/i.test(RPC_URL)) {
  console.error('RPC_URL looks like mainnet. These scripts are for devnet only.');
  process.exit(1);
}

export function loadKey(name) {
  const file = path.join(KEYS, name + '.json');
  if (!fs.existsSync(file)) {
    console.error('Missing ' + file + '. Run: npm run keys');
    process.exit(1);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

export function makeKey(name) {
  fs.mkdirSync(KEYS, { recursive: true });
  const file = path.join(KEYS, name + '.json');
  if (fs.existsSync(file)) return { kp: loadKey(name), created: false };
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return { kp, created: true };
}

export function readState() {
  return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
}
export function writeState(patch) {
  const next = Object.assign(readState(), patch);
  fs.writeFileSync(STATE, JSON.stringify(next, null, 2));
  return next;
}

export async function client() {
  const sdk = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  return { sdk, dbc: new sdk.DynamicBondingCurveClient(connection, 'confirmed') };
}

export async function send(tx, signers, label) {
  tx.feePayer = signers[0].publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
  console.log(label + ': https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
  return sig;
}

export const sol = lamports => Number(lamports) / 1e9;

export function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

// Reads the "Copy settings" JSON from the Draftpad launch sheet and maps what DBC can express.
// Fees: the page has one trading fee and a "creator keeps X%" share, which matches DBC: one fee curve that
// decays from a high starting fee to a steady fee, split between partner and creator. Confirmed on devnet.
export function fromSheet(file) {
  if (!file) return { steadyFeeBps: 80, creatorSharePct: 37, ignored: [] };
  const sheet = JSON.parse(fs.readFileSync(file, 'utf8'));
  const total = Number(sheet.fees && sheet.fees.totalPct);
  const share = Number(sheet.fees && sheet.fees.creatorSharePct);
  const creator = Number(sheet.fees && sheet.fees.creatorPct);
  if (!(total > 0) || !((share >= 0) || (creator >= 0))) throw new Error('The sheet has no fees block. Use "Copy settings" on a staged launch.');
  const ignored = [];
  if (sheet.walletCapFirst10Min && sheet.walletCapFirst10Min !== 'none') ignored.push('walletCapFirst10Min (no native DBC feature found)');
  if (sheet.vampOffer) ignored.push('vampOffer (needs the separate claim program)');
  if (sheet.pairsAgainst && sheet.pairsAgainst !== 'SOL') ignored.push('pairsAgainst ' + sheet.pairsAgainst + ' (first run is SOL only)');
  return {
    steadyFeeBps: Math.round(total * 100),
    creatorSharePct: share >= 0 ? Math.round(share) : Math.round((creator / total) * 100),
    name: sheet.token && sheet.token.name,
    symbol: sheet.token && String(sheet.token.ticker || '').replace(/^\$/, ''),
    ignored
  };
}

// Meteora renamed a few options between SDK versions. Try the names from the current docs first.
const pick = (obj, ...names) => { for (const n of names) if (obj && obj[n] !== undefined) return obj[n]; return undefined; };

// The curve every Draftpad launch uses. Only the fee settings and the migration size vary.
//   steadyFeeBps     the trading fee once the anti-sniper decay has finished
//   creatorSharePct  percent of the fee the creator keeps
//   startFeeBps      the fee at launch, decaying down to the steady fee
//   thresholdSol     SOL raised on the curve before it migrates
//   supplyOnMigration  percent of supply sold on the curve before migration
export function makeCurve(sdk, o) {
  const authority = pick(sdk.TokenAuthorityOption, 'PartnerUpdateAuthority', 'Immutable');
  const updateAuthority = pick(sdk.TokenUpdateAuthorityOption, 'PartnerUpdateAuthority', 'Immutable');
  return sdk.buildCurve({
    token: {
      tokenType: pick(sdk.TokenType, 'SPLToken', 'SPL'),
      tokenBaseDecimal: sdk.TokenDecimal.SIX,
      tokenQuoteDecimal: sdk.TokenDecimal.NINE,
      ...(authority !== undefined ? { tokenAuthorityOption: authority } : {}),
      ...(updateAuthority !== undefined ? { tokenUpdateAuthority: updateAuthority } : {}),
      totalTokenSupply: 1_000_000_000,
      leftover: 1_000
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: sdk.BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: o.startFeeBps,
          endingFeeBps: o.steadyFeeBps,
          numberOfPeriod: 60,
          totalDuration: 60
        }
      },
      dynamicFeeEnabled: true,
      collectFeeMode: sdk.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: o.creatorSharePct,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false
    },
    migration: {
      migrationOption: sdk.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: sdk.MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0
    },
    activationType: sdk.ActivationType.Timestamp,
    percentageSupplyOnMigration: o.supplyOnMigration,
    migrationQuoteThreshold: o.thresholdSol
  });
}
