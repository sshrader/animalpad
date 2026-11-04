'use strict';
// An in-memory stand-in for web3.js plus a few chain accounts, so the launcher can be tested end to end
// without a network. Accounts are real pump.fun layouts, encoded from the IDL.
const crypto = require('node:crypto');
const base = require('./fakeweb3.js');
const pump = require('../pump.js');
const { PublicKey, TransactionInstruction } = base;

const ZERO = '11111111111111111111111111111111';

function defaultFor(t) {
  if (t === 'bool') return false;
  if (t === 'pubkey') return ZERO;
  if (t && t.array) return Array.from({ length: t.array[1] }, () => defaultFor(t.array[0]));
  return 0n;
}

// Encodes an account of a pump IDL type. Fields not in `values` are zero.
function makeAccount(idl, typeName, values) {
  const disc = idl.accounts.find(a => a.name === typeName).discriminator;
  const fields = idl.types.find(t => t.name === typeName).type.fields;
  const parts = [Buffer.from(disc)];
  for (const f of fields) {
    const v = values && values[f.name] !== undefined ? values[f.name] : defaultFor(f.type);
    try { parts.push(pump.encodeValue(idl, f.type, typeof v === 'string' && f.type === 'pubkey' ? new PublicKey(v) : (Array.isArray(v) && f.type.array ? v.map(x => new PublicKey(x)) : v))); } catch (e) { break; }
  }
  return Buffer.concat(parts);
}

const GLOBAL = {
  fee_basis_points: 95n, creator_fee_basis_points: 30n,
  initial_virtual_token_reserves: 1073000000000000n, initial_virtual_sol_reserves: 30000000000n,
  initial_real_token_reserves: 793100000000000n, token_total_supply: 1000000000000000n,
  buyback_fee_recipients: pump.BUYBACK_RECIPIENTS
};
const CURVE = {
  virtual_token_reserves: 1073000000000000n, virtual_quote_reserves: 30000000000n, real_token_reserves: 793100000000000n,
  real_quote_reserves: 0n, token_total_supply: 1000000000000000n, complete: false
};

// `state` is mutated by the tests: state.accounts (address -> { data, lamports, owner }), state.tokens (address -> amount string),
// state.statuses (signature -> status), state.sent (what was asked for).
function fakeLoad(state) {
  state.accounts = state.accounts || new Map();
  state.tokens = state.tokens || new Map();
  state.statuses = state.statuses || new Map();
  state.sent = state.sent || [];
  state.tables = state.tables || new Map();
  class Keypair { static generate() { const publicKey = new PublicKey(crypto.randomBytes(32)); return { publicKey }; } }
  class Transaction {
    constructor() { this.instructions = []; this.signers = []; }
    add(ix) { this.instructions.push(ix); return this; }
    partialSign(k) { this.signers.push(k.publicKey.toBase58()); }
    serialize() {
      return Buffer.from(JSON.stringify({
        feePayer: this.feePayer && this.feePayer.toBase58(), blockhash: this.recentBlockhash, signers: this.signers,
        instructions: this.instructions.map(i => ({ program: i.programId.toBase58(), keys: i.keys.length, data: i.data.toString('hex') }))
      }));
    }
  }
  class TransactionMessage {
    constructor(o) { this.o = o; }
    compileToV0Message(tables) { return { o: this.o, tables }; }
  }
  class VersionedTransaction {
    constructor(msg) { this.msg = msg; this.signers = []; }
    sign(keys) { keys.forEach(k => this.signers.push(k.publicKey.toBase58())); }
    serialize() {
      const o = this.msg.o;
      return Buffer.from(JSON.stringify({
        v0: true, tables: this.msg.tables.length, feePayer: o.payerKey.toBase58(), blockhash: o.recentBlockhash, signers: this.signers,
        instructions: o.instructions.map(i => ({ program: i.programId.toBase58(), keys: i.keys.length, data: i.data.toString('hex') }))
      }));
    }
  }
  class Connection {
    async getAddressLookupTable(pk) { const t = state.tables && state.tables.get(pk.toBase58()); return { value: t || null }; }
    async getAccountInfo(pk) { const a = state.accounts.get(pk.toBase58()); return a ? { data: a.data, lamports: a.lamports || 1000000, owner: new PublicKey(a.owner || pump.PUMP) } : null; }
    async getLatestBlockhash() { return { blockhash: 'BLOCKHASH' }; }
    async getSignatureStatuses(sigs) { return { value: sigs.map(s => state.statuses.get(s) || null) }; }
    async getTokenAccountBalance(pk) { const v = state.tokens.get(pk.toBase58()); if (v === undefined) throw new Error('could not find account'); return { value: { amount: v } }; }
    async getMinimumBalanceForRentExemption() { return 1000000; }
  }
  const ComputeBudgetProgram = {
    setComputeUnitLimit: ({ units }) => new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from('limit' + units) }),
    setComputeUnitPrice: ({ microLamports }) => new TransactionInstruction({ programId: new PublicKey('ComputeBudget111111111111111111111111111111'), keys: [], data: Buffer.from('price' + microLamports) })
  };
  const web3 = { PublicKey, Keypair, Transaction, Connection, TransactionInstruction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction };
  const B = pump.createBuilder(web3);
  // Helpers for tests
  state.web3 = web3; state.B = B;
  state.putGlobal = () => state.accounts.set(B.globalPda().toBase58(), { data: makeAccount(pump.IDLS.pump, 'Global', GLOBAL) });
  state.putCurve = (mint, over) => state.accounts.set(B.bondingCurveOf(mint).toBase58(), { data: makeAccount(pump.IDLS.pump, 'BondingCurve', Object.assign({}, CURVE, over)) });
  state.putSharing = (mint, holders) => {
    // SharingConfig: discriminator, bump, version, status (1 = Active), mint, admin, admin_revoked, shareholders (vec)
    const disc = Buffer.from(pump.IDLS.fees.accounts.find(x => x.name === 'SharingConfig').discriminator);
    const vec = Buffer.concat([Buffer.from([holders.length, 0, 0, 0])].concat(holders.map(h => Buffer.concat([new PublicKey(h.address).toBuffer(), Buffer.from([h.bps & 255, h.bps >> 8])]))));
    const data = Buffer.concat([disc, Buffer.from([255, 1, 1]), new PublicKey(mint).toBuffer(), Buffer.alloc(32, 9), Buffer.from([1]), vec]);
    state.accounts.set(B.sharingConfigOf(mint).toBase58(), { data, owner: pump.PUMP_FEES });
  };
  return async () => ({ web3 });
}

module.exports = { fakeLoad, makeAccount, GLOBAL, CURVE };
