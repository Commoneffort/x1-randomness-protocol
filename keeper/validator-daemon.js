#!/usr/bin/env node
/**
 * X1 Randomness Protocol — Validator Daemon
 *
 * Each X1 validator runs this daemon independently. It watches the chain for
 * new EE V4 rounds, checks on-chain eligibility (entropy-derived selection),
 * and submits commit/reveal autonomously. No keeper involvement — the validator
 * signs with its own identity key.
 *
 * After each successful reveal, the daemon also calls claim_validator_reward
 * once distribute_fees has run.
 *
 * Usage:
 *   VALIDATOR_KEYPAIR=/path/to/identity.json node validator-daemon.js [--loop]
 *
 * The identity keypair is the same key registered via register_validator.
 * Secrets are persisted to /tmp/vd-secrets-<pubkeyPrefix>.json before each
 * commit so they survive process restarts.
 */

const {
  Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  SYSVAR_SLOT_HASHES_PUBKEY, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs     = require("fs");

// ── Config ─────────────────────────────────────────────────────────────────────

const RPC        = process.env.RPC_URL || "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R");
const EE_V4      = new PublicKey("FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm");
const conn       = new Connection(RPC, "confirmed");

const keypairPath = process.env.VALIDATOR_KEYPAIR;
if (!keypairPath) {
  console.error("❌ VALIDATOR_KEYPAIR env var required");
  console.error("   Example: VALIDATOR_KEYPAIR=~/.config/solana/id.json node validator-daemon.js");
  process.exit(1);
}
const identity = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(keypairPath.replace(/^~/, process.env.HOME))))
);

const doLoop     = process.argv.includes("--loop");
const STATE_FILE = `/tmp/vd-secrets-${identity.publicKey.toBase58().slice(0, 8)}.json`;

console.log(`Validator   : ${identity.publicKey.toBase58()}`);
console.log(`RPC         : ${RPC}`);

// ── Helpers ────────────────────────────────────────────────────────────────────

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function findPda(seeds) { return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID); }
function readU64(d, o)  { return Number(d.readBigUInt64LE(o)); }

async function send(ix, label) {
  const tx = new Transaction();
  if (Array.isArray(ix)) { ix.forEach(i => tx.add(i)); } else { tx.add(ix); }
  tx.feePayer = identity.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const sig = await sendAndConfirmTransaction(conn, tx, [identity], { commitment: "confirmed" });
  console.log(`  ✓ ${label}: ${sig.slice(0, 20)}…`);
  return sig;
}

// ── PDAs ───────────────────────────────────────────────────────────────────────

function cfgPda()       { return findPda([Buffer.from("protocol-config")]); }
function poolPda()      { return findPda([Buffer.from("entropy-pool")]); }
function escrowPda(r)   { return findPda([Buffer.from("fee-escrow"),        u64le(r)]); }
function wrapperPda(r)  { return findPda([Buffer.from("wrapper-round"),     u64le(r)]); }
function valRegPda(id)  { return findPda([Buffer.from("val-reg"),            id.toBuffer()]); }
function vrPda(eeR, c)  { return findPda([Buffer.from("validator-reveal"),   eeR.toBuffer(), c.toBuffer()]); }
function eeRoundPda(coordinator, roundId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), coordinator.toBuffer(), u64le(roundId)], EE_V4
  );
}

// ── Secret persistence ─────────────────────────────────────────────────────────

function saveSecrets(eeRoundId, secret, nonce) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    eeRoundId,
    secret: secret.toString("hex"),
    nonce:  nonce.toString("hex"),
  }));
}
function loadSecrets(eeRoundId) {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE));
    if (d.eeRoundId === eeRoundId) {
      return { secret: Buffer.from(d.secret, "hex"), nonce: Buffer.from(d.nonce, "hex") };
    }
  } catch (_) {}
  return null;
}
function clearSecrets() {
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
}

// ── On-chain eligibility check ─────────────────────────────────────────────────
// Mirrors the Rust program logic in commit_via_ee so we can pre-check before
// sending a transaction that would fail.

function isEligible(poolEntropy, eeRoundId, contributorPubkey) {
  const roundInput = Buffer.concat([poolEntropy, u64le(eeRoundId)]);
  const roundSeed  = crypto.createHash("sha256").update(roundInput).digest();

  const valInput   = Buffer.concat([roundSeed, contributorPubkey.toBuffer()]);
  const valHash    = crypto.createHash("sha256").update(valInput).digest();

  // COMMIT_SELECTION_THRESHOLD = u64::MAX in the program — all validators eligible.
  // Read the first 8 bytes as a u64 and compare. With threshold = u64::MAX this
  // is always true, but the check is here for when the threshold is lowered.
  const THRESHOLD = BigInt("18446744073709551615"); // u64::MAX
  const selector  = valHash.readBigUInt64LE(0);
  return selector < THRESHOLD;
}

// ── Instructions ───────────────────────────────────────────────────────────────

function ixCommit(eeRoundId, eeRound, voteAccount, stakeAccount, commitment) {
  const [cfg] = cfgPda();
  const [pool] = poolPda();
  const [wr]  = wrapperPda(eeRoundId);
  const [reg] = valRegPda(identity.publicKey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                     isSigner: false, isWritable: false },
      { pubkey: pool,                    isSigner: false, isWritable: false },
      { pubkey: wr,                      isSigner: false, isWritable: false },
      { pubkey: eeRound,                 isSigner: false, isWritable: true  },
      { pubkey: identity.publicKey,      isSigner: true,  isWritable: true  },
      { pubkey: reg,                     isSigner: false, isWritable: true  },
      { pubkey: voteAccount,             isSigner: false, isWritable: false },
      { pubkey: stakeAccount,            isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EE_V4,                   isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("commit_via_ee"), commitment]),
  });
}

function ixReveal(eeRoundId, eeRound, secret, nonce) {
  const [cfg] = cfgPda();
  const [wr]  = wrapperPda(eeRoundId);
  const [vr]  = vrPda(eeRound, identity.publicKey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                     isSigner: false, isWritable: false },
      { pubkey: wr,                      isSigner: false, isWritable: false },
      { pubkey: eeRound,                 isSigner: false, isWritable: true  },
      { pubkey: vr,                      isSigner: false, isWritable: true  },
      { pubkey: identity.publicKey,      isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EE_V4,                   isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("reveal_via_ee"), secret, nonce]),
  });
}

function ixClaimReward(eeRound, protocolRound, insuranceFund) {
  const [cfg]    = cfgPda();
  const [escrow] = escrowPda(protocolRound);
  const [vr]     = vrPda(eeRound, identity.publicKey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: identity.publicKey,      isSigner: true,  isWritable: true  },
      { pubkey: vr,                      isSigner: false, isWritable: true  },
      { pubkey: escrow,                  isSigner: false, isWritable: true  },
      { pubkey: cfg,                     isSigner: false, isWritable: false },
      { pubkey: eeRound,                 isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("claim_validator_reward"),
  });
}

// ── Main ────────────────────────────────────────────────────────────────────────

async function runOnce() {
  // Read current protocol + pool state
  const [cfgAddr]  = cfgPda();
  const [poolAddr] = poolPda();
  const cfgAcct    = await conn.getAccountInfo(cfgAddr);
  const poolAcct   = await conn.getAccountInfo(poolAddr);
  if (!cfgAcct || !poolAcct) throw new Error("Protocol not initialised");

  const cfgData       = cfgAcct.data;
  const eeV4RoundId   = readU64(cfgData, 88);
  const currentRound  = readU64(cfgData, 72);
  const insuranceFund = new PublicKey(cfgData.slice(40, 72));
  const poolEntropy   = Buffer.from(poolAcct.data.slice(8, 40));

  console.log(`\n── Round ${currentRound} / EE ${eeV4RoundId} ──────────────────────────`);

  // Check registration
  const [regPda] = valRegPda(identity.publicKey);
  const regAcct  = await conn.getAccountInfo(regPda);
  if (!regAcct) {
    console.log("  Not registered. Run: node run-round.js --register");
    return;
  }
  const isActive = regAcct.data[137] !== 0;
  if (!isActive) {
    console.log("  Validator marked inactive — refresh status and reactivate");
    return;
  }
  const voteAccount  = new PublicKey(regAcct.data.slice(40, 72));
  const stakeAccount = new PublicKey(regAcct.data.slice(72, 104));

  // Check eligibility for this round
  if (!isEligible(poolEntropy, eeV4RoundId, identity.publicKey)) {
    console.log(`  Not selected for EE round ${eeV4RoundId} this cycle — waiting for next round`);
    return;
  }
  console.log(`  Selected for EE round ${eeV4RoundId}`);

  // Find EE round PDA — must exist (init'd by crank)
  // We don't know coordinator pubkey; scan wrapper-round PDA to find eeRoundPubkey
  const [eeWrAddr] = wrapperPda(eeV4RoundId);
  const eeWrAcct   = await conn.getAccountInfo(eeWrAddr);
  if (!eeWrAcct) {
    console.log(`  EE round ${eeV4RoundId} not initialised yet — waiting for crank`);
    return;
  }

  // Read coordinator from EE round wrapper: ee_v4_round_id is the round, we need
  // to find the EE round PDA. It's stored in protocol_config if init'd by crank.
  // We derive it: crank used payer as coordinator, so look it up via known coordinator.
  // Since any validator may have init'd the round, we read coordinator from EE round data.
  // The EE wrapper round was init'd by ixInitEeRound which stores the eer pubkey on-chain.
  // Read it from the EE WrapperRound PDA (we need the eeRoundPubkey).
  // The eeRoundPubkey = Pubkey::find_program_address(["round", coordinator, eeRoundId], EE_V4)
  // Coordinator is stored in EE round account at offset 8-40 (from the CPI we made).
  // But we don't have the EE round account yet without knowing the address.
  //
  // Solution: the wrapper round for eeV4RoundId was created by init_ee_round.
  // We can get the EE round address by reading the EE account directly.
  // The crank calls eeRoundPda(payerKey, eeRoundId). We'll try the most recently
  // registered active validator (the crank) as coordinator, falling back to a scan.
  // In practice, validators should query protocol config for the current EE round
  // address off-chain, or the crank can publish it. For now we derive from cfgData.

  // The coordinator address is in cfgData[8..40] (authority) — but that's the authority,
  // not the coordinator. We need to find the EE round by scanning.
  // Simplest reliable approach: query all EE V4 round accounts and find the one with
  // matching round_id. But that requires getProgramAccounts on EE_V4.
  let eeRoundPubkey = null;
  try {
    // Try known coordinators: registered validators
    const allRegs = await conn.getProgramAccounts(PROGRAM_ID, {
      filters: [{ memcmp: { offset: 0, bytes: Buffer.from([8,207,107,171,248,66,249,38]).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"") } }],
    });
    for (const reg of allRegs) {
      if (reg.account.data.length < 139) continue;
      const candidatePubkey = new PublicKey(reg.account.data.slice(8, 40));
      const [candidateEeRound] = PublicKey.findProgramAddressSync(
        [Buffer.from("round"), candidatePubkey.toBuffer(), u64le(eeV4RoundId)], EE_V4
      );
      const eeAcct = await conn.getAccountInfo(candidateEeRound);
      if (eeAcct) {
        eeRoundPubkey = candidateEeRound;
        break;
      }
    }
  } catch (_) {}

  if (!eeRoundPubkey) {
    console.log(`  Could not locate EE round account for round ${eeV4RoundId}`);
    return;
  }

  // Read binding_slot from EE round account
  const eeAcct = await conn.getAccountInfo(eeRoundPubkey);
  if (!eeAcct || eeAcct.data.length < 74) {
    console.log("  EE round account too small / unreadable");
    return;
  }
  const bindingSlot = Number(eeAcct.data.readBigUInt64LE(66));

  // ── Commit phase ────────────────────────────────────────────────────────────
  const [vrAddr] = vrPda(eeRoundPubkey, identity.publicKey);
  const vrAcct   = await conn.getAccountInfo(vrAddr);
  const revealed = !!vrAcct;

  const cur = await conn.getSlot("confirmed");
  const beforeBinding = cur < bindingSlot;

  if (beforeBinding && !revealed) {
    // Need to commit if we haven't yet
    let secrets = loadSecrets(eeV4RoundId);
    let alreadyCommitted = false;

    if (!secrets) {
      secrets = { secret: crypto.randomBytes(32), nonce: crypto.randomBytes(32) };
      saveSecrets(eeV4RoundId, secrets.secret, secrets.nonce);
      console.log("  Generated and persisted fresh secrets");
    } else {
      console.log("  Loaded persisted secrets");
      alreadyCommitted = true; // probably already committed, try reveal
    }

    if (!alreadyCommitted) {
      const commitment = crypto.createHash("sha256")
        .update(Buffer.concat([secrets.secret, secrets.nonce, identity.publicKey.toBuffer()]))
        .digest();
      try {
        await send(ixCommit(eeV4RoundId, eeRoundPubkey, voteAccount, stakeAccount, commitment), "commit_via_ee");
      } catch (e) {
        if (e.message?.includes("already") || e.message?.includes("0x0")) {
          console.log("  Already committed this round");
        } else if (e.message?.includes("NotSelectedForRound")) {
          console.log("  Selection check failed on-chain — not eligible this round");
          clearSecrets();
          return;
        } else {
          throw e;
        }
      }
    }
  }

  // ── Reveal phase ────────────────────────────────────────────────────────────
  if (!beforeBinding && !revealed) {
    const secrets = loadSecrets(eeV4RoundId);
    if (!secrets) {
      console.log("  Past binding slot but no secrets found — missed reveal window");
      return;
    }
    try {
      await send(ixReveal(eeV4RoundId, eeRoundPubkey, secrets.secret, secrets.nonce), "reveal_via_ee");
      clearSecrets();
    } catch (e) {
      if (e.message?.includes("already") || e.message?.includes("0x0")) {
        console.log("  Already revealed");
        clearSecrets();
      } else { throw e; }
    }
  }

  if (revealed) {
    console.log("  Already revealed this round");
    clearSecrets();
  }

  // ── Claim reward ────────────────────────────────────────────────────────────
  // Check if fees have been distributed for the protocol round linked to this EE round
  const [escrowAddr] = escrowPda(currentRound);
  const escrowAcct   = await conn.getAccountInfo(escrowAddr);
  if (escrowAcct && escrowAcct.data.length >= 42) {
    const feeDistributed = escrowAcct.data[40] !== 0;
    const vrAcctFresh    = await conn.getAccountInfo(vrAddr);
    if (feeDistributed && vrAcctFresh && vrAcctFresh.data.length >= 82) {
      const claimed = vrAcctFresh.data[80] !== 0;
      if (!claimed) {
        try {
          await send(ixClaimReward(eeRoundPubkey, currentRound, insuranceFund), "claim_validator_reward");
        } catch (e) {
          if (e.message?.includes("RewardAlreadyClaimed")) {
            console.log("  Reward already claimed");
          } else { console.warn(`  Claim failed: ${e.message}`); }
        }
      } else {
        console.log("  Reward already claimed for this round");
      }
    } else if (!feeDistributed) {
      console.log("  Fees not yet distributed — will claim after distribute_fees runs");
    }
  }
}

async function main() {
  if (doLoop) {
    const POLL_MS = 15_000; // check every 15s
    while (true) {
      try {
        await runOnce();
      } catch (e) {
        console.error(`\n❌ Error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  } else {
    await runOnce();
  }
}

main().catch(e => { console.error(`\n❌ Fatal: ${e.message}`); process.exit(1); });
