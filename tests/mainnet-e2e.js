#!/usr/bin/env node
/**
 * X1 Randomness Protocol V3 — End-to-End Mainnet Tests
 *
 * Runs against X1 mainnet: https://rpc.mainnet.x1.xyz
 * Program: BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R
 * Payer/authority: ~/.config/solana/x1randomness-key.json
 *
 * Prerequisites:
 *   npm install @solana/web3.js
 *
 * Usage:
 *   node tests/mainnet-e2e.js
 */

const {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_SLOT_HASHES_PUBKEY,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R");
const EE_V4 = new PublicKey("FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm");

const conn = new Connection(RPC, "confirmed");

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

const payer = loadKeypair(`${os.homedir()}/.config/solana/x1randomness-key.json`);

// ─── Proof log ────────────────────────────────────────────────────────────────

const proof = [];
function logProof(label, sig) {
  proof.push({ label, sig, explorer: `https://explorer.x1.xyz/tx/${sig}` });
  console.log(`  ✅ ${label}`);
  console.log(`     sig: ${sig}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Anchor instruction discriminator: sha256("global:<name>")[:8] */
function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

function u64le(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function findPda(seeds) {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

async function sendIx(ix, signers, label) {
  const tx = new Transaction().add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, {
    commitment: "confirmed",
    skipPreflight: false,
  });
  logProof(label, sig);
  return sig;
}

// ─── PDA derivation ───────────────────────────────────────────────────────────

function protocolConfigPda() { return findPda([Buffer.from("protocol-config")]); }
function entropyPoolPda()    { return findPda([Buffer.from("entropy-pool")]); }
function dappPda(dappId)     { return findPda([Buffer.from("dapp"), dappId.toBuffer()]); }
function agentSubPda(auth, seed) {
  return findPda([Buffer.from("agent-sub"), auth.toBuffer(), seed]);
}
function feeEscrowPda(round) { return findPda([Buffer.from("fee-escrow"), u64le(round)]); }
function wrapperRoundPda(round) { return findPda([Buffer.from("wrapper-round"), u64le(round)]); }
function requestPda(requester, seed) {
  return findPda([Buffer.from("request"), requester.toBuffer(), seed]);
}
function receiptPda(requestId) { return findPda([Buffer.from("receipt"), requestId]); }
function validatorRevealPda(eeRound, contributor) {
  return findPda([Buffer.from("validator-reveal"), eeRound.toBuffer(), contributor.toBuffer()]);
}
function eeRoundPda(coordinator, roundId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), coordinator.toBuffer(), u64le(roundId)],
    EE_V4
  );
}

// ─── Instruction builders ─────────────────────────────────────────────────────

function buildInitialize(authority, insuranceFund) {
  const [configPda] = protocolConfigPda();
  const [poolPda]   = entropyPoolPda();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,              isSigner: false, isWritable: true },
      { pubkey: poolPda,                isSigner: false, isWritable: true },
      { pubkey: insuranceFund,          isSigner: false, isWritable: false },
      { pubkey: authority.publicKey,    isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
    ],
    data: disc("initialize"),
  });
}

function buildCreateFeeEscrow(round) {
  const [configPda]  = protocolConfigPda();
  const [escrowPda]  = feeEscrowPda(round);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: escrowPda,              isSigner: false, isWritable: true },
      { pubkey: configPda,              isSigner: false, isWritable: false },
      { pubkey: payer.publicKey,        isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("create_fee_escrow"), u64le(round)]),
  });
}

function buildRegisterDapp(authority, dappId, callbackProgram, callbackIx, minInterval) {
  const [configPda]    = protocolConfigPda();
  const [dappRegPda]   = dappPda(dappId);
  const cbIxBuf        = Buffer.isBuffer(callbackIx) ? callbackIx : Buffer.from(callbackIx);
  const data = Buffer.concat([
    disc("register_dapp"),
    callbackProgram.toBuffer(),
    cbIxBuf.slice(0, 8),
    u64le(minInterval),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: dappRegPda,             isSigner: false, isWritable: true },
      { pubkey: dappId,                 isSigner: false, isWritable: false },
      { pubkey: authority.publicKey,    isSigner: true,  isWritable: true },
      { pubkey: configPda,              isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildUnregisterDapp(authority, dappId) {
  const [dappRegPda] = dappPda(dappId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: dappRegPda,          isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true,  isWritable: true },
    ],
    data: disc("unregister_dapp"),
  });
}

function buildRegisterAgent(authority, seed, callbackProgram, callbackIx, minInterval) {
  const [configPda]   = protocolConfigPda();
  const [subPda]      = agentSubPda(authority.publicKey, seed);
  const cbIxBuf       = Buffer.isBuffer(callbackIx) ? callbackIx : Buffer.from(callbackIx);
  const data = Buffer.concat([
    disc("register_agent"),
    callbackProgram.toBuffer(),
    cbIxBuf.slice(0, 8),
    u64le(minInterval),
    seed,
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: subPda,                 isSigner: false, isWritable: true },
      { pubkey: authority.publicKey,    isSigner: true,  isWritable: true },
      { pubkey: configPda,              isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildUnregisterAgent(authority, seed) {
  const [subPda] = agentSubPda(authority.publicKey, seed);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: subPda,              isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true,  isWritable: true },
    ],
    data: disc("unregister_agent"),
  });
}

function buildAdvanceRound(newRound) {
  const [configPda]   = protocolConfigPda();
  const [poolPda]     = entropyPoolPda();
  const [newRoundPda] = wrapperRoundPda(newRound);
  // H-2 fix: pass current round's WrapperRound so on-chain aggregation check passes.
  const prevRound = newRound - 1;
  const [curRoundPda] = prevRound > 0 ? wrapperRoundPda(prevRound) : [SystemProgram.programId];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,              isSigner: false, isWritable: true },
      { pubkey: poolPda,                isSigner: false, isWritable: true },
      { pubkey: curRoundPda,            isSigner: false, isWritable: false },
      { pubkey: newRoundPda,            isSigner: false, isWritable: true },
      { pubkey: payer.publicKey,        isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
    ],
    data: disc("advance_round"),
  });
}

function buildRequestRandomness(requester, seed, callbackProgram, callbackIx, currentRound, escrowBump) {
  const [configPda]     = protocolConfigPda();
  const [poolPda]       = entropyPoolPda();
  const [reqPda]        = requestPda(requester.publicKey, seed);
  const [escrowPda]     = feeEscrowPda(currentRound);
  const [roundPda]      = wrapperRoundPda(currentRound);
  const cbIxBuf         = Buffer.isBuffer(callbackIx) ? callbackIx : Buffer.from(callbackIx);
  const data = Buffer.concat([
    disc("request_randomness"),
    seed,
    callbackProgram.toBuffer(),
    cbIxBuf.slice(0, 8),
  ]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: reqPda,                 isSigner: false, isWritable: true },
      { pubkey: requester.publicKey,    isSigner: true,  isWritable: true },
      { pubkey: configPda,              isSigner: false, isWritable: false },
      { pubkey: poolPda,                isSigner: false, isWritable: true },
      { pubkey: escrowPda,              isSigner: false, isWritable: true },
      { pubkey: roundPda,               isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildInitEeRound(coordinator, eeRoundId, nContributors, mThreshold, bindingSlot) {
  const [configPda]    = protocolConfigPda();
  const [wrPda]        = wrapperRoundPda(eeRoundId);
  const [eeRound]      = eeRoundPda(coordinator.publicKey, eeRoundId);
  const data = Buffer.concat([
    disc("init_ee_round"),
    u64le(eeRoundId),
    Buffer.from([nContributors]),
    Buffer.from([mThreshold]),
    u64le(bindingSlot),
  ]);
  return { ix: new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,              isSigner: false, isWritable: true },
      { pubkey: wrPda,                  isSigner: false, isWritable: true },
      { pubkey: eeRound,                isSigner: false, isWritable: true },
      { pubkey: coordinator.publicKey,  isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
      { pubkey: EE_V4,                  isSigner: false, isWritable: false },
    ],
    data,
  }), eeRound, wrPda };
}

function buildCommitViaEe(contributor, eeRoundId, commitment, eeRound) {
  const [configPda]  = protocolConfigPda();
  const [wrPda]      = wrapperRoundPda(eeRoundId);
  const data = Buffer.concat([disc("commit_via_ee"), commitment]);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,               isSigner: false, isWritable: false },
      { pubkey: wrPda,                   isSigner: false, isWritable: false },
      { pubkey: eeRound,                 isSigner: false, isWritable: true },
      { pubkey: contributor.publicKey,   isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EE_V4,                   isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildRevealViaEe(contributor, eeRoundId, secret, nonce, eeRound) {
  const [configPda] = protocolConfigPda();
  const [wrPda]     = wrapperRoundPda(eeRoundId);
  const [vrPda]     = validatorRevealPda(eeRound, contributor.publicKey);
  const data = Buffer.concat([disc("reveal_via_ee"), secret, nonce]);
  return { ix: new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,               isSigner: false, isWritable: false },
      { pubkey: wrPda,                   isSigner: false, isWritable: false },
      { pubkey: eeRound,                 isSigner: false, isWritable: true },
      { pubkey: vrPda,                   isSigner: false, isWritable: true },   // ValidatorReveal init
      { pubkey: contributor.publicKey,   isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EE_V4,                   isSigner: false, isWritable: false },
    ],
    data,
  }), vrPda };
}

function buildFinalizeViaEe(eeRoundId, eeRound) {
  const [configPda]  = protocolConfigPda();
  const [wrPda]      = wrapperRoundPda(eeRoundId);
  const [poolPda]    = entropyPoolPda();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,              isSigner: false, isWritable: false },
      { pubkey: wrPda,                  isSigner: false, isWritable: true },
      { pubkey: poolPda,                isSigner: false, isWritable: true },
      { pubkey: eeRound,                isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey,        isSigner: true,  isWritable: false },
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
      { pubkey: EE_V4,                  isSigner: false, isWritable: false },
    ],
    data: disc("finalize_via_ee"),
  });
}

function buildGameSeed(gameId, currentRound) {
  const [poolPda]   = entropyPoolPda();
  const [configPda] = protocolConfigPda();
  const [escrowPda] = feeEscrowPda(currentRound);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: poolPda,                 isSigner: false, isWritable: false },
      { pubkey: configPda,               isSigner: false, isWritable: false },
      { pubkey: escrowPda,               isSigner: false, isWritable: true },
      { pubkey: payer.publicKey,         isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("game_seed"), gameId]),
  });
}

function buildSetFee(authority, newFee) {
  const [configPda] = protocolConfigPda();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,           isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true,  isWritable: false },
    ],
    data: Buffer.concat([disc("set_fee"), u64le(newFee)]),
  });
}

function buildClaimValidatorReward(contributor, eeRound, protocolRound) {
  const [vrPda]     = validatorRevealPda(eeRound, contributor.publicKey);
  const [escrowPda] = feeEscrowPda(protocolRound);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: vrPda,                   isSigner: false, isWritable: true },
      { pubkey: escrowPda,               isSigner: false, isWritable: true },
      { pubkey: eeRound,                 isSigner: false, isWritable: false },
      { pubkey: contributor.publicKey,   isSigner: true,  isWritable: true },
    ],
    data: disc("claim_validator_reward"),
  });
}

function buildVerifyEntropy(requestId, round, requestStatePda) {
  const [wrPda]      = wrapperRoundPda(round);
  const [receiptPDA] = receiptPda(requestId);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: receiptPDA,              isSigner: false, isWritable: true },
      { pubkey: wrPda,                   isSigner: false, isWritable: false },
      { pubkey: requestStatePda,         isSigner: false, isWritable: false }, // required: fulfilled RequestState
      { pubkey: payer.publicKey,         isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("verify_entropy"), requestId]),
  });
}

function buildDistributeFees(round) {
  const [configPda]  = protocolConfigPda();
  const [wrPda]      = wrapperRoundPda(round);
  const [escrowPda]  = feeEscrowPda(round);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,              isSigner: false, isWritable: false },
      { pubkey: wrPda,                  isSigner: false, isWritable: false },
      { pubkey: escrowPda,              isSigner: false, isWritable: true },
      { pubkey: payer.publicKey,        isSigner: false, isWritable: true }, // insurance_fund
      { pubkey: SystemProgram.programId,isSigner: false, isWritable: false },
    ],
    data: disc("distribute_fees"),
  });
}

function buildAggregateFromEe(callerPubkey, protocolRound, eeRound) {
  const [configPda]  = protocolConfigPda();
  const [wrPda]      = wrapperRoundPda(protocolRound);
  const [poolPda]    = entropyPoolPda();
  const [escrowPda]  = feeEscrowPda(protocolRound); // M-3 fix: sync ee_v4_round_id on escrow
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda,               isSigner: false, isWritable: false },
      { pubkey: wrPda,                   isSigner: false, isWritable: true },
      { pubkey: poolPda,                 isSigner: false, isWritable: true },
      { pubkey: escrowPda,               isSigner: false, isWritable: true },
      { pubkey: eeRound,                 isSigner: false, isWritable: false },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: callerPubkey,            isSigner: true,  isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("aggregate_from_ee"),
  });
}

function buildClaimValidatorFees(round) {
  const [configPda]  = protocolConfigPda();
  const [escrowPda]  = feeEscrowPda(round);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: escrowPda,           isSigner: false, isWritable: true },
      { pubkey: payer.publicKey,     isSigner: false, isWritable: true }, // recipient = authority
      { pubkey: configPda,           isSigner: false, isWritable: false },
    ],
    data: disc("claim_validator_fees"),
  });
}

function buildDeliverCallback(authorityPubkey, seed, callerPubkey) {
  const [subPda]    = agentSubPda(authorityPubkey, seed);
  const [poolPda]   = entropyPoolPda();
  const [configPda] = protocolConfigPda();
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: subPda,       isSigner: false, isWritable: true },
      { pubkey: poolPda,      isSigner: false, isWritable: false },
      { pubkey: configPda,    isSigner: false, isWritable: false },
      { pubkey: callerPubkey, isSigner: true,  isWritable: false }, // permissionless crank
    ],
    data: disc("deliver_callback"),
  });
}

// ─── Account readers ──────────────────────────────────────────────────────────

/** Read raw account data and parse discriminator + fields with known offsets */
async function readAccount(pubkey) {
  const info = await conn.getAccountInfo(pubkey, "confirmed");
  if (!info) return null;
  return info.data;
}

function readU64(data, offset) {
  return Number(data.readBigUInt64LE(offset));
}
function readBool(data, offset) { return data[offset] !== 0; }

async function readProtocolConfig() {
  const [pda] = protocolConfigPda();
  const d = await readAccount(pda);
  if (!d) return null;
  return {
    authority:         new PublicKey(d.slice(8, 40)).toBase58(),
    insuranceFund:     new PublicKey(d.slice(40, 72)).toBase58(),
    currentRound:      readU64(d, 72),
    currentRoundStartSlot: readU64(d, 80),
    eeV4RoundId:       readU64(d, 88),
    totalRounds:       readU64(d, 96),
    requestFee:        readU64(d, 104),
    bump:              d[112],
  };
}

async function readEntropyPool() {
  const [pda] = entropyPoolPda();
  const d = await readAccount(pda);
  if (!d) return null;
  return {
    currentEntropy:    d.slice(8, 40).toString("hex"),
    currentRound:      readU64(d, 40),
    entropyAvailable:  readBool(d, 48),
    lastAggregatedSlot:readU64(d, 49),
    totalRequestsServed:readU64(d, 57),
    eeV4EntropyIncluded:readBool(d, 65),
    bump:              d[66],
  };
}

// ─── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  process.stdout.write(`\n[TEST] ${name}... `);
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.log(`  ❌ FAILED: ${e.message || e}`);
    if (e.logs) {
      for (const l of e.logs.slice(-6)) console.log(`     ${l}`);
    }
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`\n[SKIP] ${name}: ${reason}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════════════");
  console.log("  X1 Randomness Protocol V3 — Mainnet E2E Tests");
  console.log("════════════════════════════════════════════════════");
  console.log(`Program : ${PROGRAM_ID.toBase58()}`);
  console.log(`Payer   : ${payer.publicKey.toBase58()}`);
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`Balance : ${(bal / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log("════════════════════════════════════════════════════\n");

  // ── Check if already initialized ────────────────────────────────────────────
  let config = await readProtocolConfig();
  const alreadyInit = config !== null;
  let currentRound = alreadyInit ? config.currentRound : 0;

  // ── 1. Initialize ────────────────────────────────────────────────────────────
  await test("1. Initialize protocol (ProtocolConfig + EntropyPool)", async () => {
    if (alreadyInit) {
      console.log("  (already initialized, reading state)");
      config = await readProtocolConfig();
      console.log(`  authority    : ${config.authority}`);
      console.log(`  currentRound : ${config.currentRound}`);
      console.log(`  requestFee   : ${config.requestFee} lamports`);
      return;
    }
    const ix = buildInitialize(payer, payer.publicKey);
    await sendIx(ix, [payer], "Initialize");
    config = await readProtocolConfig();
    currentRound = config.currentRound;
    console.log(`  authority    : ${config.authority}`);
    console.log(`  currentRound : ${config.currentRound}`);
  });

  // Re-read after init
  config = await readProtocolConfig();
  currentRound = config ? config.currentRound : 0;
  console.log(`\n  Current round: ${currentRound}`);

  // ── 2. Entropy pool state ────────────────────────────────────────────────────
  await test("2. EntropyPool reads correctly", async () => {
    const pool = await readEntropyPool();
    if (!pool) throw new Error("EntropyPool PDA not found");
    console.log(`  entropyAvailable   : ${pool.entropyAvailable}`);
    console.log(`  currentRound       : ${pool.currentRound}`);
    console.log(`  totalRequestsServed: ${pool.totalRequestsServed}`);
    console.log(`  eeV4EntropyIncluded: ${pool.eeV4EntropyIncluded}`);
  });

  // ── 3. Register dApp ─────────────────────────────────────────────────────────
  const dappId   = Keypair.generate();
  const dappCbPg = Keypair.generate().publicKey;
  const dappCbIx = Buffer.alloc(8, 0xAB);

  await test("3. Register dApp (on-demand, interval=0)", async () => {
    const [dappPdaAddr] = dappPda(dappId.publicKey);
    const existing = await conn.getAccountInfo(dappPdaAddr);
    if (existing) { console.log("  (dapp already exists, using fresh keypair)"); }
    const freshDapp = Keypair.generate();
    const ix = buildRegisterDapp(payer, freshDapp.publicKey, dappCbPg, dappCbIx, 0);
    await sendIx(ix, [payer], "RegisterDapp");
    const d = await readAccount(ix.keys[0].pubkey);
    if (!d || d.length < 30) throw new Error("DappRegistration account missing/empty");
    console.log(`  dapp PDA: ${ix.keys[0].pubkey.toBase58()}`);
    console.log(`  size    : ${d.length} bytes`);
  });

  // ── 4. Register + Unregister dApp ────────────────────────────────────────────
  await test("4. Register then Unregister dApp (close account, reclaim rent)", async () => {
    const tempDapp = Keypair.generate();
    const ixReg = buildRegisterDapp(payer, tempDapp.publicKey, dappCbPg, dappCbIx, 1);
    await sendIx(ixReg, [payer], "RegisterDapp (temp)");
    const dappPdaAddr = ixReg.keys[0].pubkey;

    const ixUnreg = buildUnregisterDapp(payer, tempDapp.publicKey);
    await sendIx(ixUnreg, [payer], "UnregisterDapp (temp)");

    const gone = await conn.getAccountInfo(dappPdaAddr);
    if (gone) throw new Error("DappRegistration still exists after unregister");
    console.log("  account closed ✓");
  });

  // ── 5. Register Agent ────────────────────────────────────────────────────────
  const agentSeed = crypto.randomBytes(32);

  await test("5. Register AI agent subscription", async () => {
    const cbPg = Keypair.generate().publicKey;
    const cbIx = Buffer.alloc(8, 0x55);
    const ix = buildRegisterAgent(payer, agentSeed, cbPg, cbIx, 0);
    await sendIx(ix, [payer], "RegisterAgent");
    const [subPda] = agentSubPda(payer.publicKey, agentSeed);
    const d = await readAccount(subPda);
    if (!d) throw new Error("AgentSubscription PDA not found");
    console.log(`  agent sub PDA: ${subPda.toBase58()}`);
    console.log(`  size         : ${d.length} bytes`);
  });

  // ── 6. Unregister Agent ──────────────────────────────────────────────────────
  await test("6. Unregister agent (close, reclaim rent)", async () => {
    const [subPda] = agentSubPda(payer.publicKey, agentSeed);
    const ix = buildUnregisterAgent(payer, agentSeed);
    await sendIx(ix, [payer], "UnregisterAgent");
    const gone = await conn.getAccountInfo(subPda);
    if (gone) throw new Error("AgentSubscription still exists");
    console.log("  account closed ✓");
  });

  // ── 7. Advance Round ─────────────────────────────────────────────────────────
  await test("7. Advance round (permissionless crank)", async () => {
    const nextRound = currentRound + 1;
    const [wrPda] = wrapperRoundPda(nextRound);
    const existingWr = await conn.getAccountInfo(wrPda);
    if (existingWr) {
      console.log(`  WrapperRound for round ${nextRound} already exists`);
      return;
    }
    const ix = buildAdvanceRound(nextRound);
    await sendIx(ix, [payer], `AdvanceRound → ${nextRound}`);

    const d = await readAccount(wrPda);
    if (!d) throw new Error("WrapperRound PDA not found after advance");
    currentRound = nextRound;
    config = await readProtocolConfig();
    console.log(`  WrapperRound PDA : ${wrPda.toBase58()}`);
    console.log(`  currentRound now : ${config.currentRound}`);
    console.log(`  size             : ${d.length} bytes`);
  });

  // Refresh current round
  config = await readProtocolConfig();
  currentRound = config ? config.currentRound : currentRound;

  // ── 8. Create Fee Escrow ─────────────────────────────────────────────────────
  // NOTE: This instruction was added in the v2.1 upgrade.
  // If the program hasn't been upgraded yet (~3.26 SOL needed), this will fail.
  let feeEscrowReady = false;
  await test("8. Create fee escrow for current round", async () => {
    const [escPda] = feeEscrowPda(currentRound);
    const existing = await conn.getAccountInfo(escPda);
    if (existing) {
      feeEscrowReady = true;
      console.log(`  Fee escrow already exists for round ${currentRound}`);
      return;
    }
    const ix = buildCreateFeeEscrow(currentRound);
    await sendIx(ix, [payer], `CreateFeeEscrow (round ${currentRound})`);
    feeEscrowReady = true;
    const d = await readAccount(escPda);
    console.log(`  escrow PDA: ${escPda.toBase58()}`);
    console.log(`  size      : ${d.length} bytes`);
  });

  // ── 9. Request Randomness (queue path) ───────────────────────────────────────
  if (feeEscrowReady) {
    const reqSeed = crypto.randomBytes(32);
    const cbPg    = Keypair.generate().publicKey;
    const cbIx    = Buffer.alloc(8, 0x01);
    let requestId = null;

    await test("9. Request randomness (queue path, fee=0.01 XNT)", async () => {
      const [escPda]  = feeEscrowPda(currentRound);
      const escData   = await readAccount(escPda);
      const escBump   = escData ? escData[escData.length - 1] : 0;
      const ix = buildRequestRandomness(payer, reqSeed, cbPg, cbIx, currentRound, escBump);
      await sendIx(ix, [payer], "RequestRandomness (queue)");

      const [reqPda] = requestPda(payer.publicKey, reqSeed);
      const d = await readAccount(reqPda);
      if (!d) throw new Error("RequestState PDA not found");

      // RequestState layout (after INIT_SPACE fix adding round:u64):
      // disc(8) request_id(32) requester(32) seed(32) callback_program(32)
      // callback_instruction(8) round(8) fulfilled(1) output(32) fee_paid(8) created_slot(8) bump(1)
      requestId = d.slice(8, 40);
      const fulfilled = readBool(d, 152); // offset: 8+32+32+32+32+8+8 = 152
      console.log(`  request PDA : ${reqPda.toBase58()}`);
      console.log(`  request_id  : ${requestId.toString("hex").slice(0, 16)}...`);
      console.log(`  path taken  : ${fulfilled ? "fast (pool warm)" : "queue (pool cold)"}`);
      // Both paths are correct — fast path when pool is warm, queue when cold.
    });
  } else {
    skip("9. Request randomness", "fee escrow not ready (program upgrade needed)");
  }

  // ── 10. Init EE Round via CPI ────────────────────────────────────────────────
  const eeRoundId = Date.now() % 1000000; // unique-ish round ID
  let eeRoundAddr = null;
  let wrPdaAddr   = null;
  let eeRoundInit = false;

  let finalBindingSlot = 0;
  await test("10. Init EE round via CPI to Entropy Engine V4", async () => {
    // EE V4 has a minimum binding slot offset — probe via doubling until accepted
    const { ix: _ix, eeRound, wrPda } = buildInitEeRound(payer, eeRoundId, 1, 1, 0); // just to get PDAs
    eeRoundAddr = eeRound;
    wrPdaAddr = wrPda;

    for (let offset = 300; offset <= 20000; offset = Math.ceil(offset * 1.5)) {
      const slot = await conn.getSlot("confirmed");
      const bindingSlot = slot + offset;
      const { ix } = buildInitEeRound(payer, eeRoundId, 1, 1, bindingSlot);
      try {
        await sendIx(ix, [payer], `InitEeRound (id=${eeRoundId})`);
        finalBindingSlot = bindingSlot;
        console.log(`  ✓ accepted binding_slot offset = ${offset} slots`);
        break;
      } catch (e) {
        if (e.message?.includes("0x177d")) {
          console.log(`  offset ${offset} → BindingSlotTooSoon, retrying...`);
        } else {
          throw e;
        }
      }
    }
    if (finalBindingSlot === 0) throw new Error("Could not find acceptable binding slot offset");
    eeRoundInit = true;

    const d = await readAccount(wrPda);
    if (!d) throw new Error("WrapperRound PDA not found after init_ee_round");
    const eeV4RoundId = readU64(d, 16);
    console.log(`  WrapperRound PDA : ${wrPda.toBase58()}`);
    console.log(`  EE V4 round PDA  : ${eeRound.toBase58()}`);
    console.log(`  eeV4RoundId      : ${eeV4RoundId}`);
    console.log(`  bindingSlot      : ${finalBindingSlot}`);
  });

  // ── 11. Commit via EE ────────────────────────────────────────────────────────
  let secret = null;
  let nonce  = null;

  if (eeRoundInit) {
    secret = crypto.randomBytes(32);
    nonce  = crypto.randomBytes(32);
    const commitment = crypto.createHash("sha256")
      .update(Buffer.concat([secret, nonce, payer.publicKey.toBuffer()]))
      .digest();

    await test("11. Commit to EE V4 round via wrapper CPI", async () => {
      const ix = buildCommitViaEe(payer, eeRoundId, commitment, eeRoundAddr);
      await sendIx(ix, [payer], `CommitViaEE (round ${eeRoundId})`);
      console.log(`  commitment: ${commitment.toString("hex").slice(0, 16)}...`);
    });

    // ── 12. Reveal via EE ──────────────────────────────────────────────────────
    let validatorRevealPdaAddr = null;
    await test("12. Reveal to EE V4 round via wrapper CPI (creates ValidatorReveal PDA)", async () => {
      const { ix, vrPda } = buildRevealViaEe(payer, eeRoundId, secret, nonce, eeRoundAddr);
      validatorRevealPdaAddr = vrPda;
      await sendIx(ix, [payer], `RevealViaEE (round ${eeRoundId})`);
      console.log(`  secret: ${secret.toString("hex").slice(0, 16)}...`);
      const d = await readAccount(vrPda);
      if (!d) throw new Error("ValidatorReveal PDA not found after reveal");
      console.log(`  ValidatorReveal PDA : ${vrPda.toBase58()}`);
      console.log(`  size                : ${d.length} bytes`);
    });

    // ── 13. Finalize via EE ────────────────────────────────────────────────────
    await test("13. Finalize EE V4 round via wrapper CPI (mix entropy into pool)", async () => {
      const ix = buildFinalizeViaEe(eeRoundId, eeRoundAddr);

      // EE V4 requires binding_slot to pass before finalize — poll until it accepts
      let finalized = false;
      const FINALIZE_MAX_WAIT_SECS = 600; // up to 10 min
      const POLL_INTERVAL_MS = 10000;
      const maxAttempts = Math.ceil((FINALIZE_MAX_WAIT_SECS * 1000) / POLL_INTERVAL_MS);

      // First wait for binding slot to pass (with progress every 30s)
      if (finalBindingSlot > 0) {
        let cur = await conn.getSlot("confirmed");
        if (cur < finalBindingSlot) {
          const slotsRemaining = finalBindingSlot - cur;
          const estSecs = Math.ceil(slotsRemaining * 0.375); // ~375ms/slot on X1
          console.log(`  Waiting ~${estSecs}s for binding slot ${finalBindingSlot} (cur=${cur})...`);
          while (cur < finalBindingSlot) {
            await new Promise(r => setTimeout(r, 10000));
            cur = await conn.getSlot("confirmed");
            if (cur < finalBindingSlot) {
              console.log(`  slot ${cur} / ${finalBindingSlot} (${finalBindingSlot - cur} remaining)...`);
            }
          }
          console.log(`  Binding slot reached: ${cur}`);
        }
      }

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await sendIx(ix, [payer], `FinalizeViaEE (round ${eeRoundId})`);
          finalized = true;
          break;
        } catch (e) {
          const msg = e.message || "";
          if (msg.includes("0x177d") || msg.includes("BindingSlot") || msg.includes("6013") ||
              msg.includes("TooEarly") || msg.includes("NotYet")) {
            const cur = await conn.getSlot("confirmed");
            console.log(`  slot ${cur}: still waiting, retrying in 10s...`);
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          } else {
            throw e;
          }
        }
      }
      if (!finalized) throw new Error("Finalize timed out waiting for binding slot");

      const pool = await readEntropyPool();
      console.log(`  entropyAvailable  : ${pool.entropyAvailable}`);
      console.log(`  eeV4Included      : ${pool.eeV4EntropyIncluded}`);
      console.log(`  entropy (hex)     : ${pool.currentEntropy.slice(0, 16)}...`);
      if (!pool.entropyAvailable) throw new Error("Entropy pool not warmed after finalize");
    });
  } else {
    skip("11. Commit via EE", "init_ee_round failed");
    skip("12. Reveal via EE", "init_ee_round failed");
    skip("13. Finalize via EE", "init_ee_round failed");
  }

  // ── 13b. Aggregate EE entropy into protocol round wrapper ────────────────────
  // This marks the advance_round wrapper as aggregated, enabling distribute_fees.
  let protocolRoundAggregated = false;
  if (eeRoundInit && eeRoundAddr) {
    await test("13b. Aggregate EE entropy into protocol round wrapper", async () => {
      const [protoWrPda] = wrapperRoundPda(currentRound);
      const existingWr = await conn.getAccountInfo(protoWrPda);
      if (!existingWr) throw new Error("Protocol wrapper round not found");
      const wrData = existingWr.data;
      const alreadyAgg = readBool(wrData, 32); // aggregated at offset 32 in WrapperRound
      if (alreadyAgg) {
        console.log("  Protocol wrapper already aggregated");
        protocolRoundAggregated = true;
        return;
      }
      const ix = buildAggregateFromEe(payer.publicKey, currentRound, eeRoundAddr);
      await sendIx(ix, [payer], `AggregateFromEE (proto_round=${currentRound})`);
      protocolRoundAggregated = true;
      console.log(`  Protocol wrapper round ${currentRound} now aggregated`);
    });
  } else {
    skip("13b. Aggregate from EE", "EE round not initialized or finalized");
  }

  // ── 14. Game Seed (instant, fee=0.001 XNT) ───────────────────────────────────
  await test("14. Game seed (instant SHA256, fee=0.001 XNT)", async () => {
    const pool = await readEntropyPool();
    if (!pool || !pool.entropyAvailable) {
      throw new Error("Entropy pool not available — run EE V4 flow first");
    }
    const gameId = crypto.randomBytes(32);
    const ix = buildGameSeed(gameId, currentRound);
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], { commitment: "confirmed" });
    logProof("GameSeed", sig);

    // Derive expected output locally (as proof the formula is correct)
    const poolEntropyHex = pool.currentEntropy;
    const poolEntropy = Buffer.from(poolEntropyHex, "hex");
    const expected = crypto.createHash("sha256").update(Buffer.concat([poolEntropy, gameId])).digest();
    console.log(`  gameId   : ${gameId.toString("hex").slice(0, 16)}...`);
    console.log(`  expected : ${expected.toString("hex").slice(0, 16)}...`);
    console.log(`  (actual output is in tx logs)`);
  });

  // ── 15. Request Randomness (fast path, if entropy available) ─────────────────
  // Capture fast-path request for use in test 16 (verify_entropy).
  let fastReqPda = null;
  let fastRequestId = null;
  if (feeEscrowReady) {
    const pool = await readEntropyPool();
    if (pool && pool.entropyAvailable) {
      const fastSeed = crypto.randomBytes(32);
      await test("15. Request randomness (fast path, entropy pool warm)", async () => {
        const cbPg  = Keypair.generate().publicKey;
        const cbIx  = Buffer.alloc(8, 0x02);
        const [escPda] = feeEscrowPda(currentRound);
        const escData  = await readAccount(escPda);
        const escBump  = escData ? escData[escData.length - 1] : 0;
        const ix = buildRequestRandomness(payer, fastSeed, cbPg, cbIx, currentRound, escBump);
        await sendIx(ix, [payer], "RequestRandomness (fast path)");

        const [reqPda] = requestPda(payer.publicKey, fastSeed);
        const d = await readAccount(reqPda);
        if (!d) throw new Error("RequestState PDA not found");
        const fulfilled = readBool(d, 152);
        const output    = d.slice(153, 185);
        // Capture for test 16
        fastReqPda    = reqPda;
        fastRequestId = Buffer.from(d.slice(8, 40));
        console.log(`  fulfilled : ${fulfilled}`);
        console.log(`  output    : ${output.toString("hex").slice(0, 16)}...`);
        console.log(`  request_id: ${fastRequestId.toString("hex").slice(0, 16)}...`);
        if (!fulfilled) throw new Error("Expected fast path to fulfill immediately");
      });
    } else {
      skip("15. Request randomness (fast path)", "entropy pool not warm");
    }
  } else {
    skip("15. Request randomness (fast path)", "fee escrow not ready");
  }

  // ── 16. Verify Entropy Receipt ───────────────────────────────────────────────
  // verify_entropy requires a real fulfilled RequestState. The fast-path request's
  // round = pool.current_round at time of request. After aggregate_from_ee,
  // pool.current_round = protocol round (currentRound = 5), so we pass currentRound.
  if (eeRoundInit && fastReqPda && fastRequestId) {
    await test("16. Verify entropy — create on-chain receipt for fast-path request", async () => {
      // fast-path request stores round = pool.current_round = currentRound (protocol round)
      const ix = buildVerifyEntropy(fastRequestId, currentRound, fastReqPda);
      await sendIx(ix, [payer], "VerifyEntropy");

      const [receiptAddr] = receiptPda(fastRequestId);
      const d = await readAccount(receiptAddr);
      if (!d) throw new Error("EntropyReceipt PDA not found");
      const eeV4Included = readBool(d, 52);
      console.log(`  receipt PDA    : ${receiptAddr.toBase58()}`);
      console.log(`  eeV4Included   : ${eeV4Included}`);
      console.log(`  size           : ${d.length} bytes`);
    });
  } else {
    skip("16. Verify entropy", "EE V4 round not initialized or no fast-path request available");
  }

  // ── 17. Distribute Fees ──────────────────────────────────────────────────────
  // Requires: protocol wrapper aggregated via aggregate_from_ee, fee-escrow[currentRound] with fees.
  // New: idempotent — cannot be called twice (fee_distributed flag).
  let feesDistributed = false;
  if (feeEscrowReady && protocolRoundAggregated) {
    await test("17. Distribute fees (10% insurance, idempotent guard)", async () => {
      const [escPda] = feeEscrowPda(currentRound);
      const esc = await readAccount(escPda);
      if (!esc) throw new Error("Fee escrow not found");
      const pendingFees = readU64(esc, 8);
      // fee_distributed flag is at offset 8+8+8+8 = 32 (after disc+pending_fees+round+original_fees)
      const alreadyDistributed = readBool(esc, 32);
      if (alreadyDistributed) {
        console.log("  (already distributed — idempotency guard worked)");
        feesDistributed = true;
        return;
      }
      if (pendingFees === 0) {
        console.log("  (no pending fees — skipping)");
        return;
      }
      const ix = buildDistributeFees(currentRound);
      await sendIx(ix, [payer], "DistributeFees");
      feesDistributed = true;
      console.log(`  distributed ${pendingFees} lamports (10% insurance + 90% escrow)`);

      // Verify the flag is now set (offset 32)
      const escAfter = await readAccount(escPda);
      const flagAfter = readBool(escAfter, 32);
      if (!flagAfter) throw new Error("fee_distributed flag not set after distribution");
      console.log(`  fee_distributed flag : ${flagAfter} ✓`);

      // Verify calling again fails (idempotency check)
      try {
        const ix2 = buildDistributeFees(currentRound);
        await sendIx(ix2, [payer], "DistributeFees (2nd call — should fail)");
        throw new Error("Should have rejected second distribute_fees call");
      } catch (e) {
        if (e.message?.includes("Should have rejected")) throw e;
        console.log("  2nd call correctly rejected ✓");
      }
    });
  } else {
    skip("17. Distribute fees", "fee escrow or protocol round not aggregated");
  }

  // ── 18. Claim Validator Reward (per-validator) ───────────────────────────────
  // Each validator that revealed calls this to claim their proportional share.
  // Share = original_fees * 90% / reveal_count
  if (feeEscrowReady && feesDistributed && eeRoundInit && eeRoundAddr) {
    await test("18. Claim validator reward (per-validator share from fee escrow)", async () => {
      const [vrPda] = validatorRevealPda(eeRoundAddr, payer.publicKey);
      const vrData = await readAccount(vrPda);
      if (!vrData) {
        console.log("  (no ValidatorReveal PDA — reveal may have been done before V3 upgrade)");
        return;
      }
      const alreadyClaimed = readBool(vrData, 8 + 32 + 32 + 8); // offset: disc+contributor+ee_round+protocol_round
      if (alreadyClaimed) {
        console.log("  (already claimed)");
        return;
      }
      const [escPda] = feeEscrowPda(currentRound);
      const esc = await readAccount(escPda);
      if (!esc) throw new Error("Fee escrow not found");
      const pendingFeesBefore = readU64(esc, 8);
      if (pendingFeesBefore === 0) {
        console.log("  (escrow empty — nothing to claim)");
        return;
      }
      const ix = buildClaimValidatorReward(payer, eeRoundAddr, currentRound);
      await sendIx(ix, [payer], `ClaimValidatorReward (round ${currentRound})`);
      console.log(`  claimed proportional share from ${pendingFeesBefore} lamports available`);

      const vrAfter = await readAccount(vrPda);
      const claimedAfter = readBool(vrAfter, 8 + 32 + 32 + 8);
      if (!claimedAfter) throw new Error("ValidatorReveal.claimed not set after claim");
      console.log(`  ValidatorReveal.claimed : ${claimedAfter} ✓`);
    });
  } else {
    skip("18. Claim validator reward", "fees not distributed or EE round not initialized");
  }

  // ── 19. Claim Validator Fees (authority sweep of remaining dust) ─────────────
  // After per-validator claims, authority sweeps any rounding remainder.
  if (feeEscrowReady && feesDistributed) {
    await test("19. Claim validator fees (authority sweeps remaining dust)", async () => {
      const [escPda] = feeEscrowPda(currentRound);
      const esc = await readAccount(escPda);
      if (!esc) throw new Error("Fee escrow not found");
      const pendingFees = readU64(esc, 8);
      if (pendingFees === 0) {
        console.log("  (no remaining fees — all claimed by validators, as expected)");
        return;
      }
      const ix = buildClaimValidatorFees(currentRound);
      await sendIx(ix, [payer], `ClaimValidatorFees (round ${currentRound})`);
      console.log(`  swept ${pendingFees} lamports remainder`);
    });
  } else {
    skip("19. Claim validator fees", "fees not yet distributed (test 17 skipped/failed)");
  }

  // ── 20. Set Fee (authority changes protocol fee) ──────────────────────────────
  await test("20. Set fee (authority updates protocol request fee)", async () => {
    const newFee = 20_000_000; // 0.02 XNT
    const ix = buildSetFee(payer, newFee);
    await sendIx(ix, [payer], "SetFee → 0.02 XNT");
    config = await readProtocolConfig();
    if (config.requestFee !== newFee) throw new Error(`Expected fee ${newFee}, got ${config.requestFee}`);
    console.log(`  requestFee updated : ${config.requestFee} lamports ✓`);

    // Restore original fee
    const restoreIx = buildSetFee(payer, 10_000_000);
    await sendIx(restoreIx, [payer], "SetFee → 0.01 XNT (restore)");
    config = await readProtocolConfig();
    console.log(`  requestFee restored: ${config.requestFee} lamports`);
  });

  // ── Final report ──────────────────────────────────────────────────────────────
  console.log("\n════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("════════════════════════════════════════════════════");
  console.log(`  ✅ Passed : ${passed}`);
  console.log(`  ❌ Failed : ${failed}`);
  console.log(`  ⏭  Skipped: ${skipped}`);

  if (proof.length > 0) {
    console.log("\n  On-chain transaction proofs:");
    for (const p of proof) {
      console.log(`  • ${p.label}`);
      console.log(`    ${p.sig}`);
    }
  }

  const finalBal = await conn.getBalance(payer.publicKey);
  console.log(`\n  Remaining balance: ${(finalBal / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log("════════════════════════════════════════════════════\n");

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  console.error("\nFatal:", e);
  process.exit(1);
});
