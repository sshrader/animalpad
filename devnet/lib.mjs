// Shared helpers for the devnet spike. Keys live in devnet/keys/ and state in devnet/state.json.
// Both are git-ignored. Never paste a key file's contents into chat or commit it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, Keypair, sendAndConfirmTransaction } from '@solana/web3.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = path.join(HERE, 'keys');
const STATE = path.join(HERE, 'state.json');

export const CLUSTER = process.env.CLUSTER || 'devnet';
export const IS_MAIN = CLUSTER === 'mainnet-beta';
if (CLUSTER !== 'devnet' && !IS_MAIN) { console.error('CLUSTER must be devnet or mainnet-beta.'); process.exit(1); }
export const RPC_URL = process.env.RPC_URL || (IS_MAIN ? '' : 'https://api.devnet.solana.com');
if (IS_MAIN) {
  if (process.env.MAINNET_OK !== 'yes') { console.error('Mainnet spends real money. Set MAINNET_OK=yes to continue.'); process.exit(1); }
  if (!RPC_URL || /devnet|testnet/i.test(RPC_URL)) { console.error('Set RPC_URL to a mainnet RPC address.'); process.exit(1); }
} else if (/mainnet/i.test(RPC_URL)) {
  console.error('RPC_URL looks like mainnet but CLUSTER is devnet.');
  process.exit(1);
}
export const connection = new Connection(RPC_URL, 'confirmed');
export const EXPLORER_SUFFIX = IS_MAIN ? '' : '?cluster=devnet';

export function loadKey(name) {
  const file = path.join(KEYS, name + '.json');
  if (!fs.existsSync(file)) {
    console.error('Missing ' + file + '. Run: npm run keys');
    process.exit(1);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

// Loads a keypair from an explicit file path (used for the mainnet payer, kept outside the repo).
export function loadKeyFile(file) {
  if (!file || !fs.existsSync(file)) { console.error('Set PAYER_KEYPAIR to the path of a funded keypair JSON file kept outside this repo.'); process.exit(1); }
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

export async function send(tx, signers, label) {
  tx.feePayer = signers[0].publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' });
  console.log(label + ': https://explorer.solana.com/tx/' + sig + EXPLORER_SUFFIX);
  return sig;
}

export const sol = lamports => Number(lamports) / 1e9;

export function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}
