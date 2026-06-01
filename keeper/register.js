#!/usr/bin/env node
// keeper/register.js — zero npm-dependency validator registration / deregistration
//
// Requires Node.js ≥ 15. No npm install needed — uses only built-in modules.
//
// Usage:
//   # Register
//   node register.js \
//     --keypair ~/.config/solana/identity.json \
//     --vote    <vote_account_pubkey> \
//     --stake   <stake_account_pubkey> \
//     [--rpc    https://rpc.mainnet.x1.xyz]
//
//   # Deregister
//   node register.js --deregister \
//     --keypair ~/.config/solana/identity.json \
//     [--rpc    https://rpc.mainnet.x1.xyz]
//
//   # Check registration status
//   node register.js --status \
//     --keypair ~/.config/solana/identity.json \
//     [--rpc    https://rpc.mainnet.x1.xyz]
//
//   VALIDATOR_KEYPAIR env var can replace --keypair.

'use strict';
const { createHash, createPrivateKey, sign: edSign } = require('node:crypto');
const { ed25519: _ed } = require('@noble/curves/ed25519');
const fs   = require('node:fs');
const https = require('node:https');
const http  = require('node:http');

// ── Protocol constants ────────────────────────────────────────────────────────
const PROGRAM_ID   = 'BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R';
const SYSTEM_PROG  = '11111111111111111111111111111111';
const DEFAULT_RPC  = 'https://rpc.mainnet.x1.xyz';
const MIN_STAKE_XNT = 1000;

// ── CLI args ──────────────────────────────────────────────────────────────────
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}
const keypairPath  = arg('--keypair') ?? process.env.VALIDATOR_KEYPAIR ?? null;
const voteArg      = arg('--vote');
const stakeArg     = arg('--stake');
const rpcUrl       = arg('--rpc') ?? DEFAULT_RPC;
const doDeregister = process.argv.includes('--deregister');
const doStatus     = process.argv.includes('--status');

if (!keypairPath) {
  console.error('Error: --keypair <path> or VALIDATOR_KEYPAIR env var required.');
  console.error('');
  console.error('Register:    node register.js --keypair <path> --vote <pubkey> --stake <pubkey>');
  console.error('Deregister:  node register.js --deregister --keypair <path>');
  console.error('Status:      node register.js --status --keypair <path>');
  process.exit(1);
}
if (!doDeregister && !doStatus && (!voteArg || !stakeArg)) {
  console.error('Error: --vote and --stake are required for registration.');
  process.exit(1);
}

// ── Base58 ────────────────────────────────────────────────────────────────────
const B58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP   = Object.fromEntries([...B58_ALPHA].map((c, i) => [c, BigInt(i)]));

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    if (!(c in B58_MAP)) throw new Error(`Invalid base58 character: '${c}' in "${s}"`);
    n = n * 58n + B58_MAP[c];
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  const leading = s.match(/^1*/)[0].length;
  return Buffer.from([...new Uint8Array(leading), ...bytes]);
}

function b58encode(buf) {
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { const r = n % 58n; s = B58_ALPHA[Number(r)] + s; n = (n - r) / 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}

// ── Compact-U16 (Solana array-length encoding) ────────────────────────────────
function compactU16(n) {
  if (n < 128)   return Buffer.from([n]);
  if (n < 16384) return Buffer.from([0x80 | (n & 0x7f), n >> 7]);
  return Buffer.from([0x80 | (n & 0x7f), 0x80 | ((n >> 7) & 0x7f), n >> 14]);
}

// ── Keypair loading ───────────────────────────────────────────────────────────
function loadKeypair(path) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Cannot read keypair at ${path}: ${e.message}`); }
  const bytes = Buffer.from(raw);
  if (bytes.length !== 64) throw new Error(`Keypair must be 64 bytes (got ${bytes.length}). Is this a Solana JSON keypair?`);
  const seed   = bytes.subarray(0, 32);
  const pubkey = Buffer.from(bytes.subarray(32, 64));
  // PKCS#8 DER wrapper for an Ed25519 private key seed (RFC 8410)
  const privkey = createPrivateKey({
    format: 'der', type: 'pkcs8',
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
  });
  return { privkey, pubkey };
}

// ── PDA derivation ────────────────────────────────────────────────────────────
function isOnCurve(bytes) {
  try { _ed.ExtendedPoint.fromHex(bytes); return true; } catch { return false; }
}

function findPda(seeds, programIdB58) {
  const progBytes = b58decode(programIdB58);
  for (let nonce = 255; nonce >= 0; nonce--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Buffer.from([nonce]));
    h.update(progBytes);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const candidate = h.digest();
    if (!isOnCurve(candidate)) return [candidate, nonce];
  }
  throw new Error('Could not find a valid PDA nonce (this should never happen)');
}

// ── Anchor instruction discriminant ──────────────────────────────────────────
function disc(name) {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

// ── Solana JSON-RPC ───────────────────────────────────────────────────────────
function rpcCall(url, method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const u    = new URL(url);
    const lib  = u.protocol === 'https:' ? https : http;
    const req  = lib.request({
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.error) reject(new Error(`RPC ${method} error: ${json.error.message}`));
          else resolve(json.result);
        } catch (e) { reject(new Error(`RPC parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Transaction builder ───────────────────────────────────────────────────────
// ixAccounts: [{pubkey: Buffer, isSigner, isWritable}] in Anchor struct order (program excluded)
// Signs with signer.privkey.
function buildAndSignTx(blockhash, ixAccounts, programIdB58, ixData, signer) {
  const programPk = b58decode(programIdB58);

  // Sort accounts into the four Solana categories
  const ws  = ixAccounts.filter(a => a.isSigner  && a.isWritable);
  const rs  = ixAccounts.filter(a => a.isSigner  && !a.isWritable);
  const wns = ixAccounts.filter(a => !a.isSigner && a.isWritable);
  const rns = ixAccounts.filter(a => !a.isSigner && !a.isWritable);

  // Append program ID as the last readonly non-signer
  const orderedAccts = [
    ...ws, ...rs, ...wns, ...rns,
    { pubkey: programPk, isSigner: false, isWritable: false },
  ];

  const numSig              = ws.length + rs.length;       // always 1 for us
  const numReadonlySigned   = rs.length;
  const numReadonlyUnsigned = rns.length + 1;              // +1 for program

  const header = Buffer.from([numSig, numReadonlySigned, numReadonlyUnsigned]);

  const acctKeysBuf = Buffer.concat([
    compactU16(orderedAccts.length),
    ...orderedAccts.map(a => a.pubkey),
  ]);

  const blockhashBuf = b58decode(blockhash);

  // Map each instruction account (Anchor struct order) to its index in orderedAccts
  const programIdx  = orderedAccts.length - 1;
  const acctIdxBytes = ixAccounts.map(a => {
    const idx = orderedAccts.findIndex(o => o.pubkey.equals(a.pubkey));
    if (idx < 0) throw new Error(`Account not found in ordered list: ${b58encode(a.pubkey)}`);
    return idx;
  });

  const ixBuf = Buffer.concat([
    Buffer.from([programIdx]),
    compactU16(acctIdxBytes.length),
    Buffer.from(acctIdxBytes),
    compactU16(ixData.length),
    ixData,
  ]);

  const message = Buffer.concat([
    header,
    acctKeysBuf,
    blockhashBuf,
    compactU16(1),  // one instruction
    ixBuf,
  ]);

  const sig = edSign(null, message, signer.privkey);

  return Buffer.concat([compactU16(numSig), sig, message]);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseRegistration(data) {
  if (!data || data.length < 138) return null;
  return {
    active:         data[137] !== 0,
    verifiedStake:  Number(data.readBigUInt64LE(104)) / 1e9,
    consecutiveMisses: data[136],
    voteAccount:    b58encode(data.subarray(40, 72)),
    stakeAccount:   b58encode(data.subarray(72, 104)),
    hotKey:         data.length >= 171 ? b58encode(data.subarray(139, 171)) : null,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const identity = loadKeypair(keypairPath);
  const identityPk = identity.pubkey;

  const [regPdaBytes] = await findPda(
    [Buffer.from('val-reg'), identityPk],
    PROGRAM_ID
  );
  const regPdaB58 = b58encode(regPdaBytes);
  const regPdaBuf = Buffer.from(regPdaBytes);

  console.log(`Identity : ${b58encode(identityPk)}`);
  console.log(`Reg PDA  : ${regPdaB58}`);
  console.log(`RPC      : ${rpcUrl}`);
  console.log('');

  // Fetch current registration state
  const acctInfo = await rpcCall(rpcUrl, 'getAccountInfo', [regPdaB58, { encoding: 'base64' }]);
  const existing = acctInfo?.value
    ? parseRegistration(Buffer.from(acctInfo.value.data[0], 'base64'))
    : null;

  // ── Status ──
  if (doStatus) {
    if (!existing) {
      console.log('Status: NOT registered');
    } else {
      console.log(`Status          : ${existing.active ? '✓ active' : '✗ inactive'}`);
      console.log(`Verified stake  : ${existing.verifiedStake.toLocaleString()} XNT`);
      console.log(`Vote account    : ${existing.voteAccount}`);
      console.log(`Stake account   : ${existing.stakeAccount}`);
      console.log(`Consecutive miss: ${existing.consecutiveMisses}`);
      if (existing.hotKey) console.log(`Hot key (V4.6)  : ${existing.hotKey}`);
    }
    return;
  }

  // ── Deregister ──
  if (doDeregister) {
    if (!existing) { console.log('Not registered — nothing to deregister.'); return; }
    console.log('Sending deregister_validator…');
    const ixAccounts = [
      { pubkey: regPdaBuf,   isSigner: false, isWritable: true },
      { pubkey: identityPk,  isSigner: true,  isWritable: true },
    ];
    const { blockhash } = (await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const tx  = buildAndSignTx(blockhash, ixAccounts, PROGRAM_ID, disc('deregister_validator'), identity);
    const sig = await rpcCall(rpcUrl, 'sendTransaction', [
      tx.toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
    console.log(`✓ Deregistered!  Tx: ${sig}`);
    return;
  }

  // ── Register ──
  if (existing) {
    console.log(`Already registered (${existing.active ? 'active' : 'inactive'}).`);
    console.log('To deregister first: node register.js --deregister --keypair ...');
    process.exit(0);
  }

  let votePk, stakePk;
  try { votePk  = b58decode(voteArg);  } catch { throw new Error(`Invalid vote account pubkey: ${voteArg}`); }
  try { stakePk = b58decode(stakeArg); } catch { throw new Error(`Invalid stake account pubkey: ${stakeArg}`); }

  console.log(`Vote   : ${voteArg}`);
  console.log(`Stake  : ${stakeArg}`);
  console.log('');
  console.log(`Sending register_validator (requires ≥${MIN_STAKE_XNT.toLocaleString()} XNT delegated stake)…`);

  const ixAccounts = [
    { pubkey: regPdaBuf,             isSigner: false, isWritable: true  },
    { pubkey: identityPk,            isSigner: true,  isWritable: true  },
    { pubkey: votePk,                isSigner: false, isWritable: false },
    { pubkey: stakePk,               isSigner: false, isWritable: false },
    { pubkey: b58decode(SYSTEM_PROG), isSigner: false, isWritable: false },
  ];

  const { blockhash } = (await rpcCall(rpcUrl, 'getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
  const tx  = buildAndSignTx(blockhash, ixAccounts, PROGRAM_ID, disc('register_validator'), identity);
  const sig = await rpcCall(rpcUrl, 'sendTransaction', [
    tx.toString('base64'),
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);

  console.log(`✓ Registered!    Tx: ${sig}`);
  console.log('');
  console.log('Next steps:');
  console.log('  cd x1-randomness-protocol/keeper && npm install');
  console.log(`  VALIDATOR_KEYPAIR=${keypairPath} node validator-daemon.js --loop`);
  console.log('');
  console.log('  Or generate a hot key first (recommended):');
  console.log('  solana-keygen new --no-bip39-passphrase -o ~/.config/solana/x1randomness-hotkey.json');
  console.log(`  VALIDATOR_KEYPAIR=${keypairPath} node validator-daemon.js \\`);
  console.log('    --rotate-authority $(solana-keygen pubkey ~/.config/solana/x1randomness-hotkey.json)');
  console.log(`  VALIDATOR_KEYPAIR=${keypairPath} \\`);
  console.log('    X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json \\');
  console.log('    node validator-daemon.js --loop');
}

main().catch(e => { console.error(`\nError: ${e.message}`); process.exit(1); });
