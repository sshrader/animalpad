'use strict';

// Builds and reads pump.fun instructions straight from pump.fun's published IDL files (idl/pump.json and
// idl/pump_fees.json, copied from github.com/pump-fun/pump-public-docs). Nothing here talks to the network:
// it turns "what we want to do" into instructions, and reads accounts that someone else fetched.
// web3.js is passed in, so tests can run with a small stand-in.

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
const WSOL = 'So11111111111111111111111111111111111111112';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'; // the classic SPL Token program, used by wrapped SOL

// pump.fun's published buyback fee recipients (docs/FEE_RECIPIENTS.md). Any one is accepted by the program.
// The live list is also in the Global account, which we prefer when it is available.
const BUYBACK_RECIPIENTS = [
  '5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7',
  'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR',
  '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL',
  '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'
];

const IDLS = { pump: require('./idl/pump.json'), fees: require('./idl/pump_fees.json') };

// ---- Borsh, just the types the instructions and accounts we use need ----

function u64Bytes(v) {
  let n = BigInt(v);
  if (n < 0n || n > 0xffffffffffffffffn) throw new Error('u64 out of range');
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function encodeValue(idl, type, value) {
  if (type === 'string') { const s = Buffer.from(String(value), 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(s.length); return Buffer.concat([l, s]); }
  if (type === 'pubkey') return Buffer.from(typeof value.toBuffer === 'function' ? value.toBuffer() : value);
  if (type === 'bool') return Buffer.from([value ? 1 : 0]);
  if (type === 'u8') return Buffer.from([Number(value)]);
  if (type === 'u16') { const b = Buffer.alloc(2); b.writeUInt16LE(Number(value)); return b; }
  if (type === 'u32') { const b = Buffer.alloc(4); b.writeUInt32LE(Number(value)); return b; }
  if (type === 'u64') return u64Bytes(value);
  if (type && type.array) {
    if (value.length !== type.array[1]) throw new Error('Array must have ' + type.array[1] + ' items');
    return Buffer.concat(value.map(v => encodeValue(idl, type.array[0], v)));
  }
  if (type === 'i64') { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b; }
  if (type && type.vec) {
    const l = Buffer.alloc(4); l.writeUInt32LE(value.length);
    return Buffer.concat([l].concat(value.map(v => encodeValue(idl, type.vec, v))));
  }
  if (type && type.option) return value === null || value === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), encodeValue(idl, type.option, value)]);
  if (type && type.defined) {
    const t = idl.types.find(x => x.name === type.defined.name);
    if (!t || !t.type || t.type.kind !== 'struct') throw new Error('Cannot encode ' + type.defined.name);
    const fields = t.type.fields;
    return Buffer.concat(fields.map((f, i) => (typeof f === 'string' ? encodeValue(idl, f, Array.isArray(value) ? value[i] : value) : encodeValue(idl, f.type, value[f.name]))));
  }
  throw new Error('Cannot encode type ' + JSON.stringify(type));
}

// Reads fields in order and stops, keeping what it has, at the first type it does not know.
function decodeFields(idl, fields, buf, off, web3) {
  const out = {};
  let o = off;
  for (const f of fields) {
    const t = f.type;
    let v;
    try {
    if (t === 'u64') { v = buf.readBigUInt64LE(o); o += 8; }
    else if (t === 'i64') { v = buf.readBigInt64LE(o); o += 8; }
    else if (t === 'u128' || t === 'i128') { const lo = buf.readBigUInt64LE(o); const hi = t === 'u128' ? buf.readBigUInt64LE(o + 8) : buf.readBigInt64LE(o + 8); v = (BigInt(hi) << 64n) + lo; o += 16; }
    else if (t === 'u32') { v = buf.readUInt32LE(o); o += 4; }
    else if (t === 'u16') { v = buf.readUInt16LE(o); o += 2; }
    else if (t === 'u8') { v = buf.readUInt8(o); o += 1; }
    else if (t === 'bool') { v = buf.readUInt8(o) !== 0; o += 1; }
    else if (t === 'pubkey') { v = new web3.PublicKey(buf.subarray(o, o + 32)).toBase58(); o += 32; }
    else if (t && t.defined && ((idl.types.find(x => x.name === t.defined.name) || {}).type || {}).kind === 'enum') { v = buf.readUInt8(o); o += 1; } // plain enum variants take one byte
    else if (t && t.array && t.array[0] === 'pubkey') {
      v = [];
      for (let i = 0; i < t.array[1]; i++) { v.push(new web3.PublicKey(buf.subarray(o, o + 32)).toBase58()); o += 32; }
    } else if (t && t.vec && t.vec.defined && (idl.types.find(x => x.name === t.vec.defined.name) || {}).type) {
      const sub = idl.types.find(x => x.name === t.vec.defined.name).type;
      if (sub.kind !== 'struct') break;
      const n = buf.readUInt32LE(o); o += 4;
      v = [];
      for (let i = 0; i < n; i++) { const r = decodeFields(idl, sub.fields, buf, o, web3); v.push(r.value); o = r.offset; }
    } else break;
    } catch (err) {
      if (err instanceof RangeError) break; // an older, shorter account: the missing trailing fields read as zero
      throw err;
    }
    out[f.name] = v;
  }
  return { value: out, offset: o };
}

function decodeAccount(idl, typeName, data, web3) {
  const acc = idl.accounts.find(a => a.name === typeName);
  const t = idl.types.find(x => x.name === typeName);
  if (!acc || !t) throw new Error('Unknown account type ' + typeName);
  const buf = Buffer.from(data);
  if (buf.length < 8 || !acc.discriminator.every((b, i) => buf[i] === b)) throw new Error('Not a ' + typeName + ' account');
  return decodeFields(idl, t.type.fields, buf, 8, web3).value;
}

// ---- Instruction builder driven by the IDL ----

function createBuilder(web3) {
  const { PublicKey, TransactionInstruction } = web3;
  const pk = v => (typeof v === 'string' ? new PublicKey(v) : v);
  const idlOf = key => { const i = IDLS[key]; if (!i) throw new Error('Unknown IDL ' + key); return i; };

  function ata(owner, mint, tokenProgram) {
    return PublicKey.findProgramAddressSync([pk(owner).toBuffer(), pk(tokenProgram || TOKEN_2022).toBuffer(), pk(mint).toBuffer()], new PublicKey(ATA_PROGRAM))[0];
  }

  function resolveAccounts(idlKey, ixName, given, lenient) {
    const idl = idlOf(idlKey);
    const ix = idl.instructions.find(i => i.name === ixName);
    if (!ix) throw new Error('No instruction ' + ixName);
    const programId = new PublicKey(idl.address);
    const have = {};
    for (const d of ix.accounts) if (given && given[d.name]) have[d.name] = pk(given[d.name]);
    const tryPda = d => {
      const seeds = [];
      for (const s of d.pda.seeds) {
        if (s.kind === 'const') seeds.push(Buffer.from(s.value));
        else if (s.kind === 'account') {
          const k = s.path.indexOf('.') >= 0 ? (given && given[s.path] ? pk(given[s.path]) : null) : have[s.path];
          if (!k) return null;
          seeds.push(k.toBuffer());
        } else throw new Error('Unsupported seed kind ' + s.kind + ' in ' + ixName + '.' + d.name);
      }
      let prog = programId;
      if (d.pda.program) {
        if (d.pda.program.kind === 'const') prog = new PublicKey(Buffer.from(d.pda.program.value));
        else { const k = have[d.pda.program.path]; if (!k) return null; prog = k; }
      }
      return PublicKey.findProgramAddressSync(seeds, prog)[0];
    };
    let moved = true;
    while (moved) {
      moved = false;
      for (const d of ix.accounts) {
        if (have[d.name]) continue;
        // Optional accounts are only sent when the caller passes them (for example the pool of a coin that has moved).
        if (d.optional) continue;
        if (d.address) { have[d.name] = new PublicKey(d.address); moved = true; }
        else if (d.pda) { const k = tryPda(d); if (k) { have[d.name] = k; moved = true; } }
        else if (d.name === 'program') { have[d.name] = programId; moved = true; }
      }
    }
    let last = ix.accounts.length - 1;
    while (last >= 0 && !have[ix.accounts[last].name] && ix.accounts[last].optional) last--;
    const keys = [];
    for (let i = 0; i <= last; i++) {
      const d = ix.accounts[i];
      const k = have[d.name];
      if (!k) {
        if (lenient) continue;
        if (!d.optional) throw new Error('Cannot work out account "' + d.name + '" for ' + ixName + '. Pass it in.');
        keys.push({ pubkey: programId, isSigner: false, isWritable: false });
        continue;
      }
      keys.push({ pubkey: k, isSigner: Boolean(d.signer), isWritable: Boolean(d.writable) });
    }
    return { ix, keys, programId, have };
  }

  function instruction(idlKey, ixName, args, given, remaining) {
    const idl = idlOf(idlKey);
    const { ix, keys, programId, have } = resolveAccounts(idlKey, ixName, given);
    const a = args || {};
    let lastArg = -1;
    ix.args.forEach((d, i) => { if (a[d.name] !== undefined) lastArg = i; });
    const parts = [Buffer.from(ix.discriminator)];
    for (let i = 0; i <= lastArg; i++) {
      const d = ix.args[i];
      if (a[d.name] === undefined) throw new Error('Missing argument "' + d.name + '" for ' + ixName);
      parts.push(encodeValue(idl, d.type, a[d.name]));
    }
    // Trailing optional arguments (OptionBool and friends) may be left off the end: a missing one reads as false/0.
    for (let i = lastArg + 1; i < ix.args.length; i++) {
      const t = ix.args[i].type;
      if (!(t && t.defined && /^Option/.test(t.defined.name))) throw new Error('Missing argument "' + ix.args[i].name + '" for ' + ixName);
    }
    const extra = (remaining || []).map(r => ({ pubkey: pk(r.pubkey), isSigner: Boolean(r.isSigner), isWritable: r.isWritable !== false }));
    return { instruction: new TransactionInstruction({ programId, keys: keys.concat(extra), data: Buffer.concat(parts) }), accounts: have };
  }

  // ---- Addresses ----
  const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program || PUMP))[0];
  const bondingCurveOf = mint => pda([Buffer.from('bonding-curve'), pk(mint).toBuffer()]);
  const sharingConfigOf = mint => pda([Buffer.from('sharing-config'), pk(mint).toBuffer()], PUMP_FEES);
  const creatorVaultOf = creator => pda([Buffer.from('creator-vault'), pk(creator).toBuffer()]);
  const globalPda = () => pda([Buffer.from('global')]);

  function createAtaIdempotent(payer, owner, mint, tokenProgram) {
    const address = ata(owner, mint, tokenProgram);
    return new TransactionInstruction({
      programId: new PublicKey(ATA_PROGRAM),
      keys: [
        { pubkey: pk(payer), isSigner: true, isWritable: true }, { pubkey: address, isSigner: false, isWritable: true },
        { pubkey: pk(owner), isSigner: false, isWritable: false }, { pubkey: pk(mint), isSigner: false, isWritable: false },
        { pubkey: new PublicKey(SYSTEM), isSigner: false, isWritable: false }, { pubkey: pk(tokenProgram || TOKEN_2022), isSigner: false, isWritable: false }
      ],
      data: Buffer.from([1])
    });
  }

  // ---- The instructions HatchPad uses ----

  function createCoin({ mint, user, name, symbol, uri }) {
    const given = { mint, user, mayhem_token_vault: null };
    // The Mayhem token vault is the Token-2022 account of the Mayhem sol_vault for this mint.
    const first = resolveAccounts('pump', 'create_v2', { mint, user }, true);
    given.mayhem_token_vault = ata(first.have.sol_vault, mint, TOKEN_2022);
    return instruction('pump', 'create_v2', { name, symbol, uri, creator: pk(user), is_mayhem_mode: false }, given).instruction;
  }

  function createSharingConfig({ mint, payer }) {
    return instruction('fees', 'create_fee_sharing_config', {}, { payer, mint }).instruction;
  }

  // update_fee_shares_v2 pays out whatever is waiting to the CURRENT shareholders before it swaps in the new list,
  // so those wallets must be passed after the fixed accounts, in the order stored on-chain. A brand new split
  // config holds just the creator (docs/instructions/CREATOR_FEE_SHARING.md), which is what Sparkpad's working
  // launch passes too (currentShareholders: [creator]).
  function setShares({ mint, authority, shareholders, currentShareholders }) {
    const total = shareholders.reduce((s, x) => s + x.bps, 0);
    if (total !== 10000) throw new Error('Shares must add up to 10000 bps');
    const sharingConfig = sharingConfigOf(mint);
    const current = (currentShareholders && currentShareholders.length ? currentShareholders : [authority]).map(a => ({ pubkey: a, isWritable: true }));
    return instruction('fees', 'update_fee_shares_v2',
      { shareholders: shareholders.map(s => ({ address: pk(s.address), share_bps: s.bps })) },
      { authority, mint, quote_mint: WSOL, token_program: TOKEN, sharing_config: sharingConfig },
      current
    ).instruction;
  }

  function tradeAccounts({ user, mint, buybackRecipient }) {
    return {
      user, base_mint: mint, quote_mint: WSOL, base_token_program: TOKEN_2022, quote_token_program: TOKEN,
      associated_base_user: ata(user, mint, TOKEN_2022),
      associated_quote_user: ata(user, WSOL, TOKEN),
      buyback_fee_recipient: buybackRecipient || BUYBACK_RECIPIENTS[0]
    };
  }

  function buyExactIn({ user, mint, lamports, minTokensOut, buybackRecipient }) {
    return instruction('pump', 'buy_exact_quote_in_v3', { spendable_quote_in: lamports, min_tokens_out: minTokensOut }, tradeAccounts({ user, mint, buybackRecipient })).instruction;
  }

  function sell({ user, mint, amount, minLamportsOut, buybackRecipient }) {
    return instruction('pump', 'sell_v3', { amount, min_sol_output: minLamportsOut }, tradeAccounts({ user, mint, buybackRecipient })).instruction;
  }

  function sweepCreatorFee({ payer, mint, creator }) {
    return instruction('pump', 'sweep_creator_fee', {}, {
      payer, base_mint: mint, quote_mint: WSOL, quote_token_program: TOKEN,
      recipient: creatorVaultOf(creator)
    }).instruction;
  }

  // Pays the coin's waiting creator fees out to its shareholders, in the order stored in the sharing config.
  function distribute({ payer, mint, shareholders }) {
    const sharingConfig = sharingConfigOf(mint);
    return instruction('pump', 'distribute_creator_fees_v2', { initialize_ata: false }, {
      payer, mint, quote_mint: WSOL, quote_token_program: TOKEN,
      'bonding_curve.creator': sharingConfig
    }, shareholders.map(a => ({ pubkey: a, isWritable: true }))).instruction;
  }

  return {
    ata, bondingCurveOf, sharingConfigOf, creatorVaultOf, globalPda, createAtaIdempotent,
    createCoin, createSharingConfig, setShares, buyExactIn, sell, sweepCreatorFee, distribute, instruction, resolveAccounts
  };
}

// ---- Curve maths (BigInt), the constant-product formula the program uses ----

function tokensForQuote(vToken, vQuote, quoteIn) {
  return (BigInt(quoteIn) * BigInt(vToken)) / (BigInt(vQuote) + BigInt(quoteIn));
}
function quoteForTokens(vToken, vQuote, tokensIn) {
  return (BigInt(tokensIn) * BigInt(vQuote)) / (BigInt(vToken) + BigInt(tokensIn));
}

// A deliberately generous fee guess, so a slippage minimum never fails because we guessed the fee too low.
// Real fees are read by the program; this only sets the floor the wallet protects the buyer with.
function feeGuessBps(global) {
  const g = global ? Number(global.fee_basis_points || 0n) + Number(global.creator_fee_basis_points || 0n) : 0;
  return Math.max(300, g + 100);
}

// Minimum tokens for spending `lamports`, after the fee guess and the buyer's slippage.
function minTokensForBuy(curve, lamports, slippageBps, feeBps) {
  const afterFee = (BigInt(lamports) * BigInt(10000 - feeBps)) / 10000n;
  let out = tokensForQuote(curve.virtual_token_reserves, curve.virtual_quote_reserves, afterFee);
  if (out > BigInt(curve.real_token_reserves)) out = BigInt(curve.real_token_reserves);
  return (out * BigInt(10000 - slippageBps)) / 10000n;
}

function minLamportsForSell(curve, tokens, slippageBps, feeBps) {
  const gross = quoteForTokens(curve.virtual_token_reserves, curve.virtual_quote_reserves, tokens);
  const net = (gross * BigInt(10000 - feeBps)) / 10000n;
  return (net * BigInt(10000 - slippageBps)) / 10000n;
}

// SOL that must be spent in total to buy every real token on the curve (fees excluded).
function solToFill(curveOrGlobal) {
  const vt = BigInt(curveOrGlobal.initial_virtual_token_reserves || curveOrGlobal.virtual_token_reserves);
  const vq = BigInt(curveOrGlobal.initial_virtual_sol_reserves || curveOrGlobal.initial_virtual_quote_reserves || curveOrGlobal.virtual_quote_reserves);
  const real = BigInt(curveOrGlobal.initial_real_token_reserves || curveOrGlobal.real_token_reserves);
  const left = vt - real; // virtual tokens still on the curve when every real token is sold
  return left > 0n ? (vq * vt) / left - vq : 0n;
}

module.exports = {
  PUMP, PUMP_FEES, WSOL, TOKEN_2022, ATA_PROGRAM, BUYBACK_RECIPIENTS, IDLS,
  createBuilder, encodeValue, decodeAccount, decodeFields, u64Bytes,
  tokensForQuote, quoteForTokens, feeGuessBps, minTokensForBuy, minLamportsForSell, solToFill
};
