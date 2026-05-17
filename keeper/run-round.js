#!/usr/bin/env node
/**
 * X1 Randomness Protocol — Protocol Crank
 *
 * Advances the protocol through its lifecycle by calling permissionless
 * on-chain instructions. This process holds NO validator keys and has NO
 * special authority — any node can run an identical crank.
 *
 * Validators commit and reveal independently using their own validator-daemon.
 *
 * Usage:
 *   node run-round.js [--loop] [--register]
 *
 * Env / keypair:
 *   Payer: ~/.config/solana/x1randomness-key.json  (pays rent for PDAs, gas only)
 *
 * Round lifecycle managed here:
 *   1. advance_round          — opens new protocol round (permissionless)
 *   2. create_fee_escrow      — creates fee bucket for the round (permissionless)
 *   3. [wait for a registered validator to call init_ee_round via validator-daemon]
 *   4. [validators commit independently via validator-daemon]
 *   5. [wait for binding_slot]
 *   6. [validators reveal independently via validator-daemon]
 *   7. finalize_via_ee        — finalize EE V4 (permissionless, after binding_slot)
 *   8. aggregate_from_ee      — mix EE entropy into pool (permissionless)
 *   9. distribute_fees        — split fees to validators + insurance fund (permissionless)
 */

// rpc-websockets dropped CommonClient and WebSocket from its main exports;
// @solana/web3.js requires both. Inject into the module cache before web3.js loads.
// CommonClient is always the parent class of Client — get it via prototype chain.
// WebSocket factory: try internal paths first, fall back to 'ws'.
{
  const rws = require("rpc-websockets");
  if (!rws.CommonClient) {
    rws.CommonClient = Object.getPrototypeOf(rws.Client);
  }
  if (!rws.WebSocket) {
    const candidates = [
      "rpc-websockets/dist/lib/client/websocket",
      "rpc-websockets/dist/lib/client/websocket.js",
      "ws",
    ];
    for (const p of candidates) {
      try { const m = require(p); rws.WebSocket = m.default || m; if (rws.WebSocket) break; } catch (_) {}
    }
  }
}

const {
  Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  SYSVAR_SLOT_HASHES_PUBKEY, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs     = require("fs");
const os     = require("os");

// ── Config ─────────────────────────────────────────────────────────────────────

const RPC        = "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R");
const EE_V4      = new PublicKey("FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm");
const STAKE_PROG = new PublicKey("Stake11111111111111111111111111111111111111");
const conn       = new Connection(RPC, "confirmed");

const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/x1randomness-key.json`)))
);

const args       = process.argv.slice(2);
const doLoop     = args.includes("--loop");
const doRegister = args.includes("--register");

// ── Helpers ────────────────────────────────────────────────────────────────────

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function findPda(seeds) { return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID); }
function eeRoundPda(coordinator, roundId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), coordinator.toBuffer(), u64le(roundId)], EE_V4
  );
}
function valRegPda(identity) {
  return findPda([Buffer.from("val-reg"), identity.toBuffer()]);
}

async function send(ix, signers, label) {
  const tx = new Transaction();
  if (Array.isArray(ix)) { ix.forEach(i => tx.add(i)); } else { tx.add(ix); }
  tx.feePayer = payer.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  console.log(`  ✓ ${label}: ${sig.slice(0, 20)}…`);
  return sig;
}

function readU64(d, o) { return Number(d.readBigUInt64LE(o)); }

// ── PDAs ───────────────────────────────────────────────────────────────────────

function cfgPda()      { return findPda([Buffer.from("protocol-config")]); }
function poolPda()     { return findPda([Buffer.from("entropy-pool")]); }
function escrowPda(r)  { return findPda([Buffer.from("fee-escrow"), u64le(r)]); }
function wrapperPda(r) { return findPda([Buffer.from("wrapper-round"), u64le(r)]); }

// ── Validator helpers ──────────────────────────────────────────────────────────

async function getValidatorVoteAndStake(identity) {
  const { current, delinquent } = await conn.getVoteAccounts("confirmed");
  const all   = [...current, ...delinquent];
  const entry = all.find(v => v.nodePubkey === identity.toBase58());
  if (!entry) throw new Error(`No vote account found for ${identity.toBase58()}`);

  const stakeAccts = await conn.getProgramAccounts(STAKE_PROG, {
    filters: [{ dataSize: 200 }, { memcmp: { offset: 124, bytes: entry.votePubkey } }],
  });
  if (!stakeAccts.length) throw new Error(`No delegated stake account found for ${identity.toBase58()}`);
  stakeAccts.sort((a, b) => b.account.lamports - a.account.lamports);
  return {
    voteAccount:  new PublicKey(entry.votePubkey),
    stakeAccount: stakeAccts[0].pubkey,
    stake:        stakeAccts[0].account.lamports,
    lastVote:     entry.lastVote,
  };
}

async function getRegisteredAccounts(identity) {
  const [regPda] = valRegPda(identity);
  const acct = await conn.getAccountInfo(regPda);
  if (!acct) throw new Error(`${identity.toBase58().slice(0, 12)}… not registered`);
  const vote   = new PublicKey(acct.data.slice(40, 72));
  const stake  = new PublicKey(acct.data.slice(72, 104));
  const active = acct.data[137] !== 0;
  if (!active) throw new Error(`Validator ${identity.toBase58().slice(0, 12)}… is inactive — run refresh_validator_status first`);
  return { voteAccount: vote, stakeAccount: stake };
}

// ── Instructions ───────────────────────────────────────────────────────────────

function ixRegisterValidator(identity, voteAccount, stakeAccount) {
  const [reg] = valRegPda(identity);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: reg,                     isSigner: false, isWritable: true },
      { pubkey: identity,                isSigner: true,  isWritable: true },
      { pubkey: voteAccount,             isSigner: false, isWritable: false },
      { pubkey: stakeAccount,            isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("register_validator"),
  });
}

function ixRefreshValidatorStatus(identity, voteAccount, stakeAccount) {
  const [reg] = valRegPda(identity);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: reg,          isSigner: false, isWritable: true },
      { pubkey: voteAccount,  isSigner: false, isWritable: false },
      { pubkey: stakeAccount, isSigner: false, isWritable: false },
    ],
    data: disc("refresh_validator_status"),
  });
}

function ixAdvanceRound(newRound) {
  const [cfg] = cfgPda(); const [pool] = poolPda(); const [wr] = wrapperPda(newRound);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                     isSigner: false, isWritable: true },
      { pubkey: pool,                    isSigner: false, isWritable: true },
      { pubkey: wr,                      isSigner: false, isWritable: true },
      { pubkey: payer.publicKey,         isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("advance_round"),
  });
}

function ixCreateFeeEscrow(round) {
  const [cfg] = cfgPda(); const [escrow] = escrowPda(round);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: escrow,                  isSigner: false, isWritable: true },
      { pubkey: cfg,                     isSigner: false, isWritable: false },
      { pubkey: payer.publicKey,         isSigner: true,  isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("create_fee_escrow"), u64le(round)]),
  });
}

// init_ee_round: n, m, and binding_slot are now derived on-chain from protocol
// constants (MAX_COMMITTEE_SIZE=10, MIN_EE_M_THRESHOLD=2, EE_V4_MIN_BINDING_SLOTS=675).
// The payer acts as coordinator — it pays rent for the EE round PDA but has no
// special authority over the round outcome.
function ixInitEeRound(coordinatorKey, coordinatorVote, coordinatorStake, eeRoundId) {
  const [cfg] = cfgPda();
  const [wr]  = wrapperPda(eeRoundId);
  const [eer] = eeRoundPda(coordinatorKey, eeRoundId);
  const [reg] = valRegPda(coordinatorKey);
  return {
    ix: new TransactionInstruction({ programId: PROGRAM_ID,
      keys: [
        { pubkey: cfg,                     isSigner: false, isWritable: true },
        { pubkey: wr,                      isSigner: false, isWritable: true },
        { pubkey: eer,                     isSigner: false, isWritable: true },
        { pubkey: coordinatorKey,          isSigner: true,  isWritable: true },
        { pubkey: reg,                     isSigner: false, isWritable: false },
        { pubkey: coordinatorVote,         isSigner: false, isWritable: false },
        { pubkey: coordinatorStake,        isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: EE_V4,                   isSigner: false, isWritable: false },
      ],
      // Only ee_round_id arg — n/m/binding_slot derived on-chain
      data: Buffer.concat([disc("init_ee_round"), u64le(eeRoundId)]),
    }),
    eeRoundPubkey: eer,
  };
}

function ixFinalizeViaEe(eeRoundId, eeRound) {
  const [cfg] = cfgPda(); const [wr] = wrapperPda(eeRoundId); const [pool] = poolPda();
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                       isSigner: false, isWritable: false },
      { pubkey: wr,                        isSigner: false, isWritable: true },
      { pubkey: pool,                      isSigner: false, isWritable: true },
      { pubkey: eeRound,                   isSigner: false, isWritable: true },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey,           isSigner: true,  isWritable: false },
      { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
      { pubkey: EE_V4,                     isSigner: false, isWritable: false },
    ],
    data: disc("finalize_via_ee"),
  });
}

function ixAggregateFromEe(protocolRound, eeRound) {
  const [cfg] = cfgPda(); const [wr] = wrapperPda(protocolRound); const [pool] = poolPda();
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                       isSigner: false, isWritable: false },
      { pubkey: wr,                        isSigner: false, isWritable: true },
      { pubkey: pool,                      isSigner: false, isWritable: true },
      { pubkey: eeRound,                   isSigner: false, isWritable: false },
      { pubkey: SYSVAR_SLOT_HASHES_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey,           isSigner: true,  isWritable: false },
      { pubkey: SystemProgram.programId,   isSigner: false, isWritable: false },
    ],
    data: disc("aggregate_from_ee"),
  });
}

function ixDistributeFees(round, insuranceFund) {
  const [cfg] = cfgPda(); const [wr] = wrapperPda(round); const [escrow] = escrowPda(round);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                     isSigner: false, isWritable: false },
      { pubkey: wr,                      isSigner: false, isWritable: false },
      { pubkey: escrow,                  isSigner: false, isWritable: true },
      { pubkey: insuranceFund,           isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("distribute_fees"),
  });
}

// ── Main round logic ────────────────────────────────────────────────────────────

async function runRound() {
  console.log("═══════════════════════════════════════════════");
  console.log("  X1 Randomness — Protocol Crank");
  console.log("═══════════════════════════════════════════════");

  const [cfgAddr] = cfgPda();
  const cfgAcct   = await conn.getAccountInfo(cfgAddr);
  if (!cfgAcct) throw new Error("Protocol config not found — is the program initialized?");
  const cfgData        = cfgAcct.data;
  const currentRound   = readU64(cfgData, 72);
  const eeV4RoundId    = readU64(cfgData, 88);
  const insuranceFund  = new PublicKey(cfgData.slice(40, 72));
  const nextRound      = currentRound + 1;
  // Validators call init_ee_round, so eeV4RoundId is the round THEY just opened.
  // The crank's job is to finalize eeV4RoundId, then wait for validators to open
  // eeV4RoundId+1 for the next protocol round. Use eeV4RoundId (not +1) for steps 3-6.
  const thisEeId       = eeV4RoundId;
  const nextEeId       = eeV4RoundId + 1;

  const bal = await conn.getBalance(payer.publicKey);
  console.log(`\nCrank key   : ${payer.publicKey.toBase58()}`);
  console.log(`Balance     : ${(bal / LAMPORTS_PER_SOL).toFixed(4)} XNT`);
  console.log(`Protocol    : round ${currentRound} → ${nextRound}`);
  console.log(`EE V4       : finalizing ${thisEeId}, next will be ${nextEeId}`);
  console.log(`Insurance   : ${insuranceFund.toBase58().slice(0, 12)}…\n`);

  // ── Optional: register crank key as validator ──────────────────────────────
  if (doRegister) {
    console.log("[0] Registering crank key as validator…");
    const [regPda] = valRegPda(payer.publicKey);
    if (await conn.getAccountInfo(regPda)) {
      console.log("  ↳ Already registered");
    } else {
      const { voteAccount, stakeAccount, stake, lastVote } = await getValidatorVoteAndStake(payer.publicKey);
      const slot = await conn.getSlot("confirmed");
      if (slot - lastVote > 500) throw new Error(`Vote account stale (${slot - lastVote} slots)`);
      if (stake < 1000 * LAMPORTS_PER_SOL) throw new Error(`Stake too low: ${stake / 1e9} XNT`);
      await send(
        ixRegisterValidator(payer.publicKey, voteAccount, stakeAccount),
        [payer], "register_validator"
      );
    }
  }

  // ── Step 1+2: Advance round + create fee escrow (atomic) ──────────────────
  console.log(`[1-2] Advance round → ${nextRound} + create fee escrow`);
  const [newWrAddr]  = wrapperPda(nextRound);
  const [escrowAddr] = escrowPda(nextRound);
  const needAdvance  = !await conn.getAccountInfo(newWrAddr);
  const needEscrow   = !await conn.getAccountInfo(escrowAddr);
  if (needAdvance || needEscrow) {
    const ixs = [];
    if (needAdvance) ixs.push(ixAdvanceRound(nextRound));
    if (needEscrow)  ixs.push(ixCreateFeeEscrow(nextRound));
    await send(ixs, [payer], `advance_round + create_fee_escrow(${nextRound})`);
  } else {
    console.log(`  ↳ Already exists`);
  }

  // ── Step 3: Wait for thisEeId WrapperRound (already created by a validator daemon) ──
  // Validators call init_ee_round independently. eeV4RoundId is the round they just
  // opened. The crank waits for that WrapperRound PDA then finalizes it.
  console.log(`\n[3] Waiting for validator daemon to init EE round ${thisEeId}…`);
  console.log(`    (Any registered validator running validator-daemon.js will call init_ee_round)`);
  const [eeWrAddr] = wrapperPda(thisEeId);
  let eeRoundPubkey = null;

  {
    let waited = false;
    while (!await conn.getAccountInfo(eeWrAddr)) {
      if (!waited) { process.stdout.write("  Polling"); waited = true; }
      process.stdout.write(".");
      await new Promise(r => setTimeout(r, 5000));
    }
    if (waited) console.log();
    console.log(`  ↳ EE round ${thisEeId} initialized by a validator daemon`);
  }

  // Scan EE_V4 accounts to find the actual EE round pubkey (coordinator unknown)
  {
    const bs58 = require("bs58");
    const roundIdBase58 = bs58.encode(u64le(thisEeId));
    const eeAccounts = await conn.getProgramAccounts(EE_V4, {
      filters: [
        { dataSize: 838 },
        { memcmp: { offset: 40, bytes: roundIdBase58 } },
      ],
    });
    if (!eeAccounts.length) throw new Error(`Could not locate EE round account for id=${thisEeId}`);
    eeRoundPubkey = eeAccounts[0].pubkey;
    console.log(`  EE round account: ${eeRoundPubkey.toBase58().slice(0, 12)}…`);
  }

  // ── Step 4: Read binding_slot from EE round account ───────────────────────
  let bindingSlot = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const eeAcct = await conn.getAccountInfo(eeRoundPubkey);
    if (eeAcct && eeAcct.data.length >= 74) {
      bindingSlot = Number(eeAcct.data.readBigUInt64LE(66));
      if (bindingSlot > 0) break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!bindingSlot) throw new Error("Could not read binding_slot from EE round account");
  console.log(`\n[4] Waiting for validators to commit (binding_slot=${bindingSlot})`);
  console.log(`    Validators run validator-daemon independently — crank waits.`);

  // ── Step 5: Wait for binding slot ─────────────────────────────────────────
  let cur = await conn.getSlot("confirmed");
  if (cur < bindingSlot) {
    const slotsLeft = bindingSlot - cur;
    console.log(`\n[5] Waiting ${slotsLeft} slots (~${Math.ceil(slotsLeft * 0.375)}s) for binding slot…`);
    while (cur < bindingSlot) {
      await new Promise(r => setTimeout(r, 8000));
      cur = await conn.getSlot("confirmed");
      const rem = bindingSlot - cur;
      if (rem > 0) process.stdout.write(`\r  slot ${cur}/${bindingSlot} — ${rem} remaining (~${Math.ceil(rem * 0.375)}s)   `);
    }
    console.log(`\n  ✓ Binding slot reached`);
  } else {
    console.log(`\n[5] Binding slot already passed`);
  }

  // ── Step 6: Finalize ───────────────────────────────────────────────────────
  console.log(`\n[6] finalize_via_ee (EE round ${thisEeId})`);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await send(ixFinalizeViaEe(thisEeId, eeRoundPubkey), [payer], "finalize_via_ee");
      break;
    } catch (e) {
      if (e.message?.includes("0x177d") || e.message?.includes("BindingSlot")) {
        const s = await conn.getSlot("confirmed");
        process.stdout.write(`\r  slot ${s}: still too early, retrying in 10s…`);
        await new Promise(r => setTimeout(r, 10000));
      } else { throw e; }
    }
  }

  // ── Step 7: Aggregate ──────────────────────────────────────────────────────
  console.log(`\n[7] aggregate_from_ee (protocol round ${nextRound})`);
  await send(ixAggregateFromEe(nextRound, eeRoundPubkey), [payer], "aggregate_from_ee");

  // ── Step 8: Distribute fees ────────────────────────────────────────────────
  console.log(`\n[8] distribute_fees (round ${nextRound})`);
  try {
    await send(ixDistributeFees(nextRound, insuranceFund), [payer], "distribute_fees");
  } catch (e) {
    if (e.message?.includes("FeeEscrowInsufficient") || e.message?.includes("0x177f")) {
      console.log(`  ↳ No fees to distribute (no requests this round — ok)`);
    } else if (e.message?.includes("AlreadyDistributed")) {
      console.log(`  ↳ Already distributed`);
    } else { throw e; }
  }

  // ── Done ───────────────────────────────────────────────────────────────────
  const [poolAddr]   = poolPda();
  const poolData     = (await conn.getAccountInfo(poolAddr)).data;
  const entropy      = poolData.slice(8, 40).toString("hex");
  const poolSlot     = readU64(poolData, 49);
  console.log(`\n═══════════════════════════════════════════════`);
  console.log(`  Round ${nextRound} complete`);
  console.log(`  Pool entropy : ${entropy.slice(0, 32)}…`);
  console.log(`  Aggregated   : slot ${poolSlot}`);
  console.log(`  Validators claim rewards independently via validator-daemon`);
  console.log(`═══════════════════════════════════════════════\n`);
}

async function main() {
  if (doLoop) {
    while (true) {
      try {
        await runRound();
      } catch (e) {
        console.error(`\n❌ Round failed: ${e.message}`);
      }
      console.log("Waiting 30s before next round…");
      await new Promise(r => setTimeout(r, 30000));
    }
  } else {
    await runRound();
  }
}

main().catch(e => { console.error(`\n❌ Error: ${e.message}`); process.exit(1); });
