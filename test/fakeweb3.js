'use strict';
// A small stand-in for @solana/web3.js so the pump.fun instruction logic can be tested without installing it.
// Addresses derived here are NOT real Solana PDAs (no curve check); real addresses are checked by devnet/13-simulate-pump.mjs.
const crypto = require('node:crypto');
const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58enc(buf) {
  let n = BigInt('0x' + (buf.length ? Buffer.from(buf).toString('hex') : '0'));
  let s = '';
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b === 0) s = '1' + s; else break; }
  return s;
}
function b58dec(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex;
  let buf = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let z = 0; for (const c of s) { if (c === '1') z++; else break; }
  buf = Buffer.concat([Buffer.alloc(z), buf]);
  return Buffer.concat([Buffer.alloc(Math.max(0, 32 - buf.length)), buf]);
}
class PublicKey {
  constructor(v) { this.b = typeof v === 'string' ? b58dec(v) : Buffer.from(v); if (this.b.length !== 32) throw new Error('bad key length ' + this.b.length); }
  toBuffer() { return this.b; }
  toBase58() { return b58enc(this.b); }
  toString() { return this.toBase58(); }
  equals(o) { return this.b.equals(o.b); }
  static findProgramAddressSync(seeds, program) {
    const h = crypto.createHash('sha256').update(Buffer.concat(seeds.concat([program.toBuffer()]))).digest();
    return [new PublicKey(h), 255];
  }
}
class TransactionInstruction { constructor(o) { Object.assign(this, o); } }
module.exports = { PublicKey, TransactionInstruction, b58enc, b58dec };
