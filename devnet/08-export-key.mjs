// Prints a devnet key as the base58 "private key" text that Phantom's Import Private Key box accepts.
// Usage: node 08-export-key.mjs partner
// Needs no packages. Run it on your own computer, never paste the output anywhere except your wallet.
// Only use this for throwaway DEVNET keys. A mainnet fee claimer should be a fresh wallet or a Ledger.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2] || 'partner';
if (!/^[a-z0-9_-]+$/i.test(name)) { console.error('Use a key name like: partner'); process.exit(1); }
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'keys', name + '.json');
if (!fs.existsSync(file)) { console.error('No key file at ' + file); process.exit(1); }
const bytes = Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8')));
if (bytes.length !== 64) { console.error('That file is not a 64-byte Solana key.'); process.exit(1); }

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b === 0) out = '1' + out; else break; }
  return out;
}

console.log('Key file: ' + file);
console.log('Wallet address (last 32 bytes of the key): ' + base58(bytes.slice(32)));
console.log('\nPrivate key for Phantom > Import Private Key (keep it secret, devnet only):\n');
console.log(base58(bytes));
