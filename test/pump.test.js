'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const web3 = require('./fakeweb3.js');
const P = require('../pump.js');

const B = P.createBuilder(web3);
const rnd = () => new web3.PublicKey(require('node:crypto').randomBytes(32));
const user = rnd(), mint = rnd(), platform = rnd();

test('create_v2 has the 16 accounts and the right data layout', () => {
  const ix = B.createCoin({ mint, user, name: 'Foxy', symbol: 'FOX', uri: 'https://x.test/meta.json' });
  assert.equal(ix.programId.toBase58(), P.PUMP);
  assert.equal(ix.keys.length, 16);
  assert.deepEqual([...ix.data.subarray(0, 8)], [214, 144, 76, 236, 95, 139, 49, 180]);
  assert.equal(ix.keys[0].pubkey.toBase58(), mint.toBase58());
  assert.ok(ix.keys[0].isSigner && ix.keys[5].isSigner); // mint and user sign
  assert.equal(ix.keys[5].pubkey.toBase58(), user.toBase58());
  // name, symbol, uri, creator, is_mayhem_mode=false, nothing after it
  const d = ix.data.subarray(8);
  assert.equal(d.readUInt32LE(0), 4);
  assert.equal(d.subarray(4, 8).toString(), 'Foxy');
  assert.equal(d.length, 4 + 4 + 4 + 3 + 4 + 24 + 32 + 1);
  assert.equal(d[d.length - 1], 0);
});

test('fee sharing: platform and creator shares must add to 100%', () => {
  const ok = B.setShares({ mint, authority: user, shareholders: [{ address: user, bps: 8000 }, { address: platform, bps: 2000 }] });
  assert.equal(ok.programId.toBase58(), P.PUMP_FEES);
  // vec of 2 shareholders: u32 + 2 * (32 + 2)
  assert.equal(ok.data.length, 8 + 4 + 2 * 34);
  assert.throws(() => B.setShares({ mint, authority: user, shareholders: [{ address: user, bps: 8000 }, { address: platform, bps: 1000 }] }), /10000/);
  // the current shareholders (just the creator, on a new split) ride along after the fixed accounts
  const fixed = B.resolveAccounts('fees', 'update_fee_shares_v2', { authority: user, mint, quote_mint: P.WSOL, token_program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }).keys.length;
  assert.equal(ok.keys.length, fixed + 1);
  assert.equal(ok.keys[fixed].pubkey.toBase58(), user.toBase58());
  assert.equal(ok.keys[fixed].isWritable, true);
  const cfg = B.createSharingConfig({ mint, payer: user });
  assert.equal(cfg.data.length, 8);
  assert.equal(cfg.keys.length, 10); // the three optional pool accounts are left off
});

test('buy and sell use the 17-account v3 layout', () => {
  const buy = B.buyExactIn({ user, mint, lamports: 1000000000n, minTokensOut: 5n });
  assert.equal(buy.keys.length, 17);
  assert.deepEqual([...buy.data.subarray(0, 8)], [225, 247, 80, 30, 213, 179, 132, 136]);
  assert.equal(buy.data.length, 8 + 16);
  const sell = B.sell({ user, mint, amount: 10n, minLamportsOut: 1n });
  assert.equal(sell.keys.length, 17);
  assert.equal(sell.data.length, 8 + 16);
});

test('sweep and distribute build, with the shareholders passed after the fixed accounts', () => {
  const sweep = B.sweepCreatorFee({ payer: user, mint, creator: B.sharingConfigOf(mint) });
  assert.equal(sweep.keys.length, 13);
  const dist = B.distribute({ payer: user, mint, shareholders: [user, platform] });
  assert.equal(dist.keys.length, 12 + 2);
  assert.equal(dist.keys[12].pubkey.toBase58(), user.toBase58());
  assert.equal(dist.keys[13].pubkey.toBase58(), platform.toBase58());
});

test('curve maths: a buy then a sell round-trips to less than was put in, and a fill costs about 85 SOL', () => {
  const vt = 1073000000000000n, vq = 30000000000n, real = 793100000000000n;
  const out = P.tokensForQuote(vt, vq, 1000000000n);
  assert.ok(out > 0n);
  const back = P.quoteForTokens(vt - out, vq + 1000000000n, out);
  assert.ok(back <= 1000000000n);
  const fill = Number(P.solToFill({ initial_virtual_token_reserves: vt, initial_virtual_sol_reserves: vq, initial_real_token_reserves: real })) / 1e9;
  assert.ok(fill > 84 && fill < 86, String(fill));
  const min = P.minTokensForBuy({ virtual_token_reserves: vt, virtual_quote_reserves: vq, real_token_reserves: real }, 1000000000n, 500, 300);
  assert.ok(min > 0n && min < out);
});

test('decodes the BondingCurve account', () => {
  const idl = P.IDLS.pump;
  const f = idl.types.find(t => t.name === 'BondingCurve').type.fields;
  const disc = idl.accounts.find(a => a.name === 'BondingCurve').discriminator;
  const buf = Buffer.alloc(8 + 5 * 8 + 1 + 32);
  Buffer.from(disc).copy(buf);
  buf.writeBigUInt64LE(111n, 8); buf.writeBigUInt64LE(222n, 16); buf.writeBigUInt64LE(333n, 24);
  user.toBuffer().copy(buf, 8 + 41);
  const c = P.decodeAccount(idl, 'BondingCurve', buf, web3);
  assert.equal(c.virtual_token_reserves, 111n);
  assert.equal(c.real_token_reserves, 333n);
  assert.equal(c.complete, false);
  assert.equal(c.creator, user.toBase58());
  assert.ok(f.length > 6);
  assert.throws(() => P.decodeAccount(idl, 'BondingCurve', Buffer.alloc(100), web3), /Not a BondingCurve/);
});
