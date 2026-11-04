// Makes a throwaway wallet file for paying the mainnet config rent, and prints its PUBLIC address to fund.
// Usage: node 09-new-payer.mjs <path>   (choose a path OUTSIDE this repo, e.g. D:\keys\payer.json)
// It refuses to overwrite a file and refuses paths inside this repo. Never share or commit the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';

const target = process.argv[2];
if (!target) { console.error('Usage: node 09-new-payer.mjs <path to a new .json file outside the repo>'); process.exit(1); }
const file = path.resolve(target);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (file.toLowerCase().startsWith(repo.toLowerCase() + path.sep)) { console.error('Choose a path outside the repo folder.'); process.exit(1); }
if (fs.existsSync(file)) { console.error(file + ' already exists. Not overwriting.'); process.exit(1); }
fs.mkdirSync(path.dirname(file), { recursive: true });
const kp = Keypair.generate();
fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
console.log('Saved ' + file);
console.log('Send about 0.1 SOL to this address (it is public, safe to share):');
console.log(kp.publicKey.toBase58());
