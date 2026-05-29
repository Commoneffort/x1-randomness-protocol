#!/usr/bin/env node
/**
 * X1 Randomness Protocol — Validator Daemon
 *
 * Each X1 validator runs this daemon independently. It watches the chain for
 * new EE V4 rounds, checks on-chain eligibility (entropy-derived selection),
 * and submits commit/reveal autonomously.
 *
 * After each successful reveal, the daemon also calls claim_validator_reward
 * once distribute_fees has run.
 *
 * ── Two operating modes ──────────────────────────────────────────────────────
 *
 * FULL MODE (identity key on this server):
 *   VALIDATOR_KEYPAIR=<identity.json> node validator-daemon.js [--loop]
 *   VALIDATOR_KEYPAIR=<identity.json> X1_RANDOMNESS_KEYPAIR=<hotkey.json> node validator-daemon.js [--loop]
 *   VALIDATOR_KEYPAIR=<identity.json> node validator-daemon.js --register
 *   VALIDATOR_KEYPAIR=<identity.json> node validator-daemon.js --deregister
 *   VALIDATOR_KEYPAIR=<identity.json> node validator-daemon.js --rotate-authority <hotkey_pubkey>
 *   Supports: commit, reveal, claim, init_ee_round, refresh_validator_status, register, deregister, rotate.
 *
 * HOT-KEY-ONLY MODE (identity key stays on the validator server — never touches this machine):
 *   VALIDATOR_IDENTITY_PUBKEY=<base58> X1_RANDOMNESS_KEYPAIR=<hotkey.json> node validator-daemon.js [--loop]
 *   Supports: commit, reveal, claim.
 *   Skips: init_ee_round (other validators handle it), refresh_validator_status (run manually on validator server).
 *   To reactivate after going inactive, run on the validator server:
 *     VALIDATOR_KEYPAIR=<identity.json> node validator-daemon.js --refresh
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Per-round commit entropy (secret + nonce) is persisted to
 * ~/.config/x1randomness/vd-secrets-<pubkeyPrefix>.json before each commit
 * so they survive process restarts. This file does NOT contain any signing key.
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
  SYSVAR_SLOT_HASHES_PUBKEY, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs     = require("fs");
const bs58   = require("bs58");
const os     = require("os");
const path   = require("path");

const STAKE_PROG = new PublicKey("Stake11111111111111111111111111111111111111");

// ── Config ─────────────────────────────────────────────────────────────────────

const RPC        = process.env.RPC_URL || "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R");
const EE_V4      = new PublicKey("FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm");
const conn       = new Connection(RPC, "confirmed");

const keypairPath      = process.env.VALIDATOR_KEYPAIR;
const identityPubkeyEnv = process.env.VALIDATOR_IDENTITY_PUBKEY;
const hotKeyPath       = process.env.X1_RANDOMNESS_KEYPAIR;

// Hot-key-only mode: identity secret key stays on the validator server.
// Requires VALIDATOR_IDENTITY_PUBKEY (base58 pubkey) + X1_RANDOMNESS_KEYPAIR (hot key path).
// Full mode: VALIDATOR_KEYPAIR (identity keypair path), X1_RANDOMNESS_KEYPAIR optional.
const hotKeyOnlyMode = !keypairPath && !!identityPubkeyEnv;

if (!keypairPath && !identityPubkeyEnv) {
  console.error("❌ Either VALIDATOR_KEYPAIR or VALIDATOR_IDENTITY_PUBKEY must be set.");
  console.error("");
  console.error("  Full mode (identity key on this server):");
  console.error("    VALIDATOR_KEYPAIR=~/.config/solana/identity.json node validator-daemon.js --loop");
  console.error("");
  console.error("  Hot-key-only mode (identity key stays on validator server):");
  console.error("    VALIDATOR_IDENTITY_PUBKEY=<base58> X1_RANDOMNESS_KEYPAIR=<hotkey.json> node validator-daemon.js --loop");
  process.exit(1);
}
if (hotKeyOnlyMode && !hotKeyPath) {
  console.error("❌ X1_RANDOMNESS_KEYPAIR is required in hot-key-only mode (VALIDATOR_KEYPAIR not set).");
  process.exit(1);
}

// identity is the full keypair in full mode, null in hot-key-only mode.
const identity = keypairPath
  ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath.replace(/^~/, os.homedir())))))
  : null;

// identityPubkey is the public key used for PDA derivation and eligibility checks.
const identityPubkey = identity
  ? identity.publicKey
  : new PublicKey(identityPubkeyEnv);

// Hot key: signs commit/reveal/claim. In full mode defaults to identity if not set.
const hotKey = hotKeyPath
  ? Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(hotKeyPath.replace(/^~/, os.homedir())))))
  : identity;

const doLoop            = process.argv.includes("--loop");
const doRegister        = process.argv.includes("--register");
const doDeregister      = process.argv.includes("--deregister");
const doRefresh         = process.argv.includes("--refresh");
const doRotateAuthority = process.argv.includes("--rotate-authority");
const rotateAuthorityTarget = doRotateAuthority
  ? process.argv[process.argv.indexOf("--rotate-authority") + 1]
  : null;

// Guard flags that require the identity keypair
if (hotKeyOnlyMode && (doRegister || doDeregister || doRotateAuthority || doRefresh)) {
  console.error("❌ --register, --deregister, --rotate-authority, and --refresh require VALIDATOR_KEYPAIR (identity key).");
  console.error("   Run these commands on your validator server where identity.json lives.");
  process.exit(1);
}

const STATE_FILE   = path.join(os.homedir(), ".config", "x1randomness", `vd-secrets-${identityPubkey.toBase58().slice(0, 8)}.json`);
const eeRoundCache = new Map(); // eeRoundId (number) → PublicKey; avoids repeated getProgramAccounts scans

// refresh_validator_status backoff — V4.6+ program returns explicit errors on failure.
// Backoff prevents hammering the RPC while waiting for stake to activate or vote to catch up.
let refreshFailCount     = 0;
let refreshCooldownUntil = 0; // ms timestamp; 0 = no cooldown

if (hotKeyOnlyMode) {
  console.log(`Mode        : hot-key-only (identity key is offline)`);
}
console.log(`Validator   : ${identityPubkey.toBase58()}`);
console.log(`Hot key     : ${hotKey.publicKey.toBase58()}`);
console.log(`RPC         : ${RPC}`);

// Minimum balance the signing key needs to cover the 0.01 XNT commit stake + tx fees.
// The stake is returned on reveal, so this is float not a recurring cost.
// Warn early so the operator can top up before missing a round.
const HOT_KEY_WARN_LAMPORTS  = 50_000_000;   // 0.05 XNT — warn below this
const HOT_KEY_MIN_LAMPORTS   = 10_100_000;   // 0.0101 XNT — below this commits will fail

async function checkHotKeyBalance() {
  const signerKey = hotKey.publicKey;
  const bal = await conn.getBalance(signerKey, "confirmed");
  if (bal < HOT_KEY_MIN_LAMPORTS) {
    console.warn(`  ⚠ CRITICAL: signing key (${signerKey.toBase58().slice(0, 8)}…) balance is ${(bal / 1e9).toFixed(4)} XNT — below minimum for commit stake (0.01 XNT). Commits will fail until funded.`);
  } else if (bal < HOT_KEY_WARN_LAMPORTS) {
    console.warn(`  ⚠ WARNING: signing key (${signerKey.toBase58().slice(0, 8)}…) balance is ${(bal / 1e9).toFixed(4)} XNT — top up soon (commit stake needs 0.01 XNT float).`);
  }
  return bal;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function findPda(seeds) { return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID); }
function readU64(d, o)  { return Number(d.readBigUInt64LE(o)); }

async function send(ix, label, signers = [identity ?? hotKey]) {
  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const tx = new Transaction();
      if (Array.isArray(ix)) { ix.forEach(i => tx.add(i)); } else { tx.add(ix); }
      tx.feePayer = signers[0].publicKey;
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const sig = await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
      console.log(`  ✓ ${label}: ${sig.slice(0, 20)}…`);
      return sig;
    } catch (e) {
      lastErr = e;
      // Don't retry deterministic simulation failures — they'll always fail the same way.
      const errText = e.message + JSON.stringify(e.logs ?? []);
      if (errText.includes("custom program error") || errText.includes("Error processing Instruction")) break;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`  ⚠ ${label} attempt ${attempt} failed: ${e.message} — retrying in 5s`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  throw lastErr;
}

// ── PDAs ───────────────────────────────────────────────────────────────────────

function cfgPda()       { return findPda([Buffer.from("protocol-config")]); }
function poolPda()      { return findPda([Buffer.from("entropy-pool")]); }
function escrowPda(r)   { return findPda([Buffer.from("fee-escrow"),        u64le(r)]); }
function wrapperPda(r)  { return findPda([Buffer.from("wrapper-round"),     u64le(r)]); }

// Returns true if there is work that requires a new EE round:
// either the pool is stale (fast-path blocked) or there are queued unfulfilled requests.
async function shouldRunEeRound() {
  const REQUEST_DISC = Buffer.from([106, 141, 109, 114, 88, 187, 109, 5]);
  const [pAddr] = poolPda();
  const poolData    = (await conn.getAccountInfo(pAddr)).data;
  const available   = poolData[48] !== 0;
  const lastAggSlot = readU64(poolData, 49);
  const nowSlot     = await conn.getSlot("confirmed");
  const slotsStale  = nowSlot - lastAggSlot;
  const poolFresh   = available && slotsStale < 21600;
  if (!poolFresh) return true;  // pool stale — must run
  const pending = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [
      { dataSize: 202 },
      { memcmp: { offset: 0,   bytes: bs58.encode(REQUEST_DISC) } },
      { memcmp: { offset: 152, bytes: bs58.encode(Buffer.from([0])) } },
    ],
    dataSlice: { offset: 0, length: 0 },
  });
  return pending.length > 0;
}
function valRegPda(id)  { return findPda([Buffer.from("val-reg"),            id.toBuffer()]); }
function vrPda(eeR, c)  { return findPda([Buffer.from("validator-reveal"),   eeR.toBuffer(), c.toBuffer()]); }
function eeRoundPda(coordinator, roundId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round"), coordinator.toBuffer(), u64le(roundId)], EE_V4
  );
}

// ── Secret persistence ─────────────────────────────────────────────────────────

function saveSecrets(eeRoundId, secret, nonce, committed = false, skipped = false) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    eeRoundId,
    secret: secret.toString("hex"),
    nonce:  nonce.toString("hex"),
    committed,
    skipped,
  }), { mode: 0o600 });
}
function saveSkipped(eeRoundId) {
  const dummy = Buffer.alloc(32);
  saveSecrets(eeRoundId, dummy, dummy, true, true);
}
function loadSecrets(eeRoundId) {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE));
    if (d.eeRoundId === eeRoundId) {
      return { secret: Buffer.from(d.secret, "hex"), nonce: Buffer.from(d.nonce, "hex"), committed: !!d.committed, skipped: !!d.skipped };
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
  const [reg] = valRegPda(identityPubkey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                     isSigner: false, isWritable: false },
      { pubkey: pool,                    isSigner: false, isWritable: false },
      { pubkey: wr,                      isSigner: false, isWritable: false },
      { pubkey: eeRound,                 isSigner: false, isWritable: true  },
      { pubkey: hotKey.publicKey,        isSigner: true,  isWritable: true  }, // contributor; hot key after rotation
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
  const [vr]  = vrPda(eeRound, hotKey.publicKey); // vr seeded by x1_randomness_authority = hot key
  const [reg] = valRegPda(identityPubkey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg,                     isSigner: false, isWritable: false },
      { pubkey: wr,                      isSigner: false, isWritable: false },
      { pubkey: eeRound,                 isSigner: false, isWritable: true  },
      { pubkey: vr,                      isSigner: false, isWritable: true  },
      { pubkey: hotKey.publicKey,        isSigner: true,  isWritable: true  }, // contributor = x1_randomness_authority
      { pubkey: reg,                     isSigner: false, isWritable: false }, // validator_reg: enforces contributor == x1_randomness_authority
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: EE_V4,                   isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("reveal_via_ee"), secret, nonce]),
  });
}

// init_ee_round: validator is the coordinator — pays rent for the EE round PDA
// but has no special authority over the round outcome. n/m/binding_slot are
// protocol constants derived on-chain.
// coordinatorKey is the signer (identity in full mode, hotKey in hot-key-only mode).
// val-reg PDA always uses identityPubkey regardless of which key signs.
function ixInitEeRound(coordinatorKey, coordinatorVote, coordinatorStake, eeRoundId, protocolRound) {
  const [cfg] = cfgPda();
  const [wr]  = wrapperPda(eeRoundId);
  const [eer] = eeRoundPda(coordinatorKey, eeRoundId);
  const [reg] = valRegPda(identityPubkey);  // always cold identity — PDA seed is identity, not hot key
  const [escrow] = escrowPda(protocolRound); // stamped with eeRoundId so refund_request works for cancelled rounds
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
        { pubkey: escrow,                  isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: EE_V4,                   isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([disc("init_ee_round"), u64le(eeRoundId)]),
    }),
    eeRoundPubkey: eer,
  };
}

function ixRefreshValidatorStatus(voteAccount, stakeAccount) {
  const [reg] = valRegPda(identityPubkey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: reg,          isSigner: false, isWritable: true },
      { pubkey: voteAccount,  isSigner: false, isWritable: false },
      { pubkey: stakeAccount, isSigner: false, isWritable: false },
    ],
    data: disc("refresh_validator_status"),
  });
}

// cancel_round is called directly on the EE_V4 program (not via wrapper).
// Only the coordinator can sign. contributors = ordered list of committed wallets
// (from ContributorEntry structs in the EE round account) — passed as remaining_accounts
// so they get their stake returned.
const CANCEL_ROUND_DISC = Buffer.from([82, 70, 134, 54, 46, 96, 148, 8]);
function ixCancelEeRound(eeRoundPubkey, coordinatorPubkey, contributorPubkeys) {
  const keys = [
    { pubkey: eeRoundPubkey,     isSigner: false, isWritable: true },
    { pubkey: coordinatorPubkey, isSigner: true,  isWritable: true },
    ...contributorPubkeys.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true })),
  ];
  return new TransactionInstruction({ programId: EE_V4, keys, data: CANCEL_ROUND_DISC });
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
  const poolEntropy   = Buffer.from(poolAcct.data.slice(8, 40));

  console.log(`\n── Round ${currentRound} / EE ${eeV4RoundId} ──────────────────────────`);
  await checkHotKeyBalance();

  // Check registration
  const [regPda] = valRegPda(identityPubkey);
  const regAcct  = await conn.getAccountInfo(regPda);
  if (!regAcct) {
    console.log("  Not registered. Run register.js or use the frontend at x1-randomness.vercel.app");
    return;
  }
  const voteAccount  = new PublicKey(regAcct.data.slice(40, 72));
  const stakeAccount = new PublicKey(regAcct.data.slice(72, 104));
  const isActive = regAcct.data[137] !== 0;
  if (!isActive) {
    if (hotKeyOnlyMode) {
      // Identity key is not on this server — cannot call refresh_validator_status here.
      // The operator must run this on the validator server:
      //   VALIDATOR_KEYPAIR=~/.config/solana/identity.json node validator-daemon.js --refresh
      console.log("  ⚠ Validator inactive. Identity key not on this server — cannot auto-refresh.");
      console.log(`  Run on your validator server: VALIDATOR_KEYPAIR=<identity.json> node validator-daemon.js --refresh`);
      return;
    }
    const now = Date.now();
    if (now < refreshCooldownUntil) {
      const waitSecs = Math.ceil((refreshCooldownUntil - now) / 1000);
      console.log(`  Validator inactive — refresh cooldown active (${waitSecs}s remaining); check stake/vote status`);
      return;
    }
    console.log("  Validator marked inactive — calling refresh_validator_status to reactivate");
    let refreshSucceeded = false;
    try {
      await send(ixRefreshValidatorStatus(voteAccount, stakeAccount), "refresh_validator_status");
      refreshSucceeded = true;
    } catch (e) {
      const msg = [e.message, ...(e.logs ?? [])].join(" ");
      if (msg.includes("StakeDeactivating") || msg.includes("0x1792")) {
        console.log("  ✗ Stake is deactivating — your stake account has left the active epoch. Re-delegate or use a new stake account.");
      } else if (msg.includes("InvalidStakeAccount") || msg.includes("0x178f")) {
        console.log("  ✗ Invalid stake account format — stake account may be uninitialized or corrupted. Check the account registered at --register time.");
      } else if (msg.includes("InsufficientValidatorStake") || msg.includes("0x178c")) {
        console.log("  ✗ Insufficient stake — check stake account balance (need ≥ 1000 XNT)");
      } else if (msg.includes("ValidatorNotActivelyVoting") || msg.includes("0x178d")) {
        console.log("  ✗ Not actively voting — check vote account recency");
      } else {
        // Unknown error or pre-V4.6 fallback — re-read account to check actual activation state.
        const freshReg = await conn.getAccountInfo(regPda);
        if (freshReg && freshReg.data[137] !== 0) {
          refreshSucceeded = true;
        }
      }
    }
    if (refreshSucceeded) {
      refreshFailCount = 0;
      refreshCooldownUntil = 0;
      console.log("  ✓ Reactivated — will participate from next round");
    } else {
      refreshFailCount++;
      const delaySecs = Math.min(60 * Math.pow(2, refreshFailCount - 1), 900);
      refreshCooldownUntil = Date.now() + delaySecs * 1000;
      console.log(`  ✗ Still inactive after refresh (attempt ${refreshFailCount}) — backing off ${delaySecs}s; check stake/vote account`);
    }
    return;
  }

  // Eligibility check gates only the commit action, not round lifecycle management.
  const eligible = isEligible(poolEntropy, eeV4RoundId, identityPubkey);
  if (eligible) {
    console.log(`  Selected for EE round ${eeV4RoundId}`);
  } else {
    console.log(`  Not selected for EE round ${eeV4RoundId} — will still manage round lifecycle`);
  }

  // Find EE round PDA — scan EE_V4 program accounts filtered by round_id at offset 40.
  // The EE round PDA seeds are ["round", coordinator, round_id_le8], but coordinator
  // is whoever called init_ee_round. We scan EE_V4 directly for accounts whose
  // round_id field matches rather than guessing the coordinator.
  const [eeWrAddr] = wrapperPda(eeV4RoundId);
  if (!await conn.getAccountInfo(eeWrAddr)) {
    if (!await shouldRunEeRound()) {
      console.log(`  EE round ${eeV4RoundId} not initialised — pool warm, no pending requests, idling`);
      return;
    }
    // Current EE round not yet initialized — open it (binding slot not set yet so safe).
    // Both identity (full mode) and hot key (hot-key-only mode) are accepted by the program.
    const initCoordKey    = hotKeyOnlyMode ? hotKey.publicKey : identityPubkey;
    const initCoordSigner = hotKeyOnlyMode ? hotKey : identity;
    console.log(`  EE round ${eeV4RoundId} not initialised — calling init_ee_round as coordinator`);
    const { ix: initIx, eeRoundPubkey: newEeRoundPubkey } = ixInitEeRound(initCoordKey, voteAccount, stakeAccount, eeV4RoundId, currentRound);
    try {
      await send(initIx, `init_ee_round(id=${eeV4RoundId})`, [initCoordSigner]);
      eeRoundCache.set(eeV4RoundId, newEeRoundPubkey);
    } catch (initErr) {
      // Another validator may have raced and won — check if the wrapper exists now.
      if (await conn.getAccountInfo(eeWrAddr)) {
        console.log(`  init_ee_round raced — another validator won, they will commit`);
        return;
      }
      throw initErr;
    }
    console.log(`  ✓ n=7, m=5, binding_slot=current+675 (derived on-chain)`);
    // Commit immediately — don't wait for the next poll; the 200-slot window (~75s)
    // can expire before the next iteration, especially if getProgramAccounts is slow.
    const firstSecrets = { secret: crypto.randomBytes(32), nonce: crypto.randomBytes(32) };
    saveSecrets(eeV4RoundId, firstSecrets.secret, firstSecrets.nonce);
    const firstCommitment = crypto.createHash("sha256")
      .update(Buffer.concat([firstSecrets.secret, firstSecrets.nonce, hotKey.publicKey.toBuffer()]))
      .digest();
    try {
      await send(ixCommit(eeV4RoundId, newEeRoundPubkey, voteAccount, stakeAccount, firstCommitment), "commit_via_ee", [hotKey]);
      saveSecrets(eeV4RoundId, firstSecrets.secret, firstSecrets.nonce, true);
      console.log(`  ✓ Committed to EE round ${eeV4RoundId} immediately after init`);
    } catch (commitErr) {
      console.log(`  ⚠ Immediate commit failed: ${commitErr.message} — will retry next poll`);
    }
    return;
  }

  let eeRoundPubkey = eeRoundCache.get(eeV4RoundId) || null;
  if (!eeRoundPubkey) {
    try {
      // round_id (u64 LE) at offset 40; scan once per new round_id, then cache.
      const roundIdBytes = u64le(eeV4RoundId);
      const roundIdBase58 = bs58.encode(roundIdBytes);
      const eeAccounts = await conn.getProgramAccounts(EE_V4, {
        filters: [
          { dataSize: 838 },
          { memcmp: { offset: 40, bytes: roundIdBase58 } },
        ],
      });
      if (eeAccounts.length > 0) {
        eeRoundPubkey = eeAccounts[0].pubkey;
        eeRoundCache.set(eeV4RoundId, eeRoundPubkey);
      }
    } catch (e) {
      console.log(`  EE round scan failed: ${e.message}`);
    }
  }

  if (!eeRoundPubkey) {
    console.log(`  Could not locate EE round account for round ${eeV4RoundId}`);
    return;
  }

  // Read slot fields from EE round account (see entropy_engine IDL Round struct):
  //   off 50: commit_deadline — commits must arrive before this slot
  //   off 58: reveal_deadline — reveals must arrive before this slot
  //   off 66: binding_slot    — finalize_via_ee allowed after this slot
  const eeAcct = await conn.getAccountInfo(eeRoundPubkey);
  if (!eeAcct || eeAcct.data.length < 74) {
    console.log("  EE round account too small / unreadable");
    return;
  }
  const commitDeadline  = Number(eeAcct.data.readBigUInt64LE(50));
  const revealDeadline  = Number(eeAcct.data.readBigUInt64LE(58)); // offset 58: reveals must land before this slot
  const bindingSlot     = Number(eeAcct.data.readBigUInt64LE(66));

  // ── Commit phase ────────────────────────────────────────────────────────────
  const [vrAddr] = vrPda(eeRoundPubkey, hotKey.publicKey); // VR PDA uses contributor = hot key after rotation
  const vrAcct   = await conn.getAccountInfo(vrAddr);
  const revealed = !!vrAcct;

  const cur = await conn.getSlot("confirmed");
  const beforeCommitDeadline = cur < commitDeadline;
  const inRevealWindow       = cur >= commitDeadline && cur < revealDeadline;
  const pastBinding          = cur >= bindingSlot;

  if (beforeCommitDeadline && !revealed && eligible) {
    // Re-read config to catch cases where another validator advanced the round mid-cycle
    const freshCfg = (await conn.getAccountInfo(cfgAddr)).data;
    const freshEeId = readU64(freshCfg, 88);
    if (freshEeId !== eeV4RoundId) {
      console.log(`  Config advanced (EE ${eeV4RoundId} → ${freshEeId}) mid-cycle — skipping commit`);
      return;
    }

    let secrets = loadSecrets(eeV4RoundId);
    if (secrets?.skipped) {
      console.log("  Already skipped this EE round (not a contributor) — waiting for next round");
      return;
    }

    if (!secrets) {
      secrets = { secret: crypto.randomBytes(32), nonce: crypto.randomBytes(32), committed: false };
      saveSecrets(eeV4RoundId, secrets.secret, secrets.nonce);
      console.log("  Generated and persisted fresh secrets");
    } else if (secrets.committed) {
      console.log("  Already committed this round (persisted state) — waiting for reveal window");
    } else {
      console.log("  Loaded persisted secrets — will re-attempt commit to confirm on-chain");
    }

    if (!secrets.committed) {
      // Attempt commit — idempotent on-chain. Re-attempt prevents the failure mode where a
      // network error drops the tx but leaves uncommitted secrets on disk.
      const commitment = crypto.createHash("sha256")
        .update(Buffer.concat([secrets.secret, secrets.nonce, hotKey.publicKey.toBuffer()]))
        .digest();
      try {
        await send(ixCommit(eeV4RoundId, eeRoundPubkey, voteAccount, stakeAccount, commitment), "commit_via_ee", [hotKey]);
        saveSecrets(eeV4RoundId, secrets.secret, secrets.nonce, true);
      } catch (e) {
        if (e.message?.includes("already") || e.message?.includes("0x0")) {
          console.log("  Already committed this round (on-chain confirmed)");
          saveSecrets(eeV4RoundId, secrets.secret, secrets.nonce, true);
        } else if (e.message?.includes("NotSelectedForRound")) {
          console.log("  Selection check failed on-chain — not eligible this round");
          clearSecrets();
          return;
        } else if (e.message?.includes("0x7d6") || e.message?.includes("ConstraintSeeds")) {
          console.log("  Config advanced before commit landed — round changed mid-cycle, retrying next poll");
          clearSecrets();
          return;
        } else if ([e.message, ...(e.logs ?? [])].some(s => s?.includes("0x1771") || s?.includes("WrongPhase"))) {
          // WrongPhase on commit means the round is in RevealPhase. Check if we actually
          // committed — another validator may have filled both slots before us.
          const eeDataFresh = (await conn.getAccountInfo(eeRoundPubkey))?.data;
          const commitCount = eeDataFresh ? eeDataFresh[74] : 0;
          let isContributor = false;
          for (let i = 0; i < commitCount; i++) {
            const base = 158 + i * 68;
            if (eeDataFresh && new PublicKey(eeDataFresh.slice(base, base + 32)).equals(hotKey.publicKey)) {
              isContributor = true;
              break;
            }
          }
          if (isContributor) {
            console.log("  WrongPhase — commit confirmed, round moved to RevealPhase");
            saveSecrets(eeV4RoundId, secrets.secret, secrets.nonce, true);
          } else {
            console.log("  WrongPhase — another pair filled EE round — not a contributor, skipping this EE round");
            saveSkipped(eeV4RoundId);
            return;
          }
        } else {
          throw e;
        }
      }
    }
  }

  // ── Init next EE round ───────────────────────────────────────────────────────
  // Open the next EE round when the current one is done. "Done" means:
  //   - Finalized (status=2) or Cancelled (status=3), OR
  //   - Stuck in RevealPhase (status=1) or CommitPhase (status=0) with slot hash
  //     expired (cur > binding_slot + 512) — finalization is permanently impossible
  //     and we must abandon. For CommitPhase, we attempt cancel_round first to
  //     return committed stakes; if that fails or we're not the coordinator, we
  //     proceed anyway to keep the protocol live.
  if (pastBinding) {
    const eeStatus = eeAcct.data[140]; // 0=CommitPhase, 1=RevealPhase, 2=Finalized, 3=Cancelled
    const slotHashExpired = cur > bindingSlot + 512;
    const roundDone = eeStatus === 2 || eeStatus === 3 || (eeStatus === 1 && slotHashExpired) || (eeStatus === 0 && slotHashExpired);

    // CommitPhase (status=0) past the binding slot is irrecoverable — not enough validators
    // committed to transition to RevealPhase. The coordinator must call cancel_round.
    if (eeStatus === 0) {
      const coordinator = new PublicKey(eeAcct.data.slice(8, 40));
      const commitCount = eeAcct.data[74];
      // We are the coordinator if we opened this round (identity in full mode, hot key in hot-key-only mode).
      const weAreCoordinator = coordinator.equals(identityPubkey) || coordinator.equals(hotKey.publicKey);
      const cancelSigner = coordinator.equals(hotKey.publicKey) ? hotKey : identity;
      if (weAreCoordinator && cancelSigner !== null) {
        console.log(`  ⚠ EE round ${eeV4RoundId} stuck in CommitPhase (${commitCount} commits) past binding slot — we are the coordinator, calling cancel_round`);
        // Collect committed contributors for stake refund (ContributorEntry at offset 158, 68 bytes each)
        const contributors = [];
        for (let i = 0; i < commitCount; i++) {
          const base = 158 + i * 68;
          contributors.push(new PublicKey(eeAcct.data.slice(base, base + 32)));
        }
        try {
          await send(ixCancelEeRound(eeRoundPubkey, cancelSigner.publicKey, contributors), `cancel_round(ee=${eeV4RoundId})`, [cancelSigner]);
          console.log(`  ✓ EE round ${eeV4RoundId} cancelled`);
        } catch (cancelErr) {
          if (cancelErr.message?.includes("0x3") || cancelErr.message?.includes("Cancelled")) {
            console.log(`  EE round ${eeV4RoundId} already cancelled`);
          } else {
            console.log(`  ⚠ cancel_round failed: ${cancelErr.message}`);
          }
        }
      } else if (coordinator.equals(identityPubkey) && hotKeyOnlyMode) {
        // We opened this round with the identity key on another server — cannot cancel from here.
        console.log(`  ⚠ EE round ${eeV4RoundId} stuck in CommitPhase (${commitCount} commits) — we are coordinator but identity key is on the validator server.${slotHashExpired ? " Slot hash expired, abandoning." : " Run cancel-ee-round.js there."}`);
      } else {
        if (slotHashExpired) {
          console.log(`  ⚠ EE round ${eeV4RoundId} stuck in CommitPhase (${commitCount} commits) — slot hash expired, coordinator (${coordinator.toBase58().slice(0,8)}…) did not cancel; abandoning to keep protocol live`);
        } else {
          console.log(`  ⚠ EE round ${eeV4RoundId} stuck in CommitPhase (${commitCount} commits) past binding slot — waiting for coordinator (${coordinator.toBase58().slice(0,8)}…) to call cancel_round`);
        }
      }
      if (!slotHashExpired) return;
      // Slot hash expired — fall through to roundDone path to open next round.
    }

    if (roundDone) {
      if (eeStatus === 1 && slotHashExpired) {
        console.log(`  EE round ${eeV4RoundId} stuck in RevealPhase — binding slot hash expired, abandoning`);
      } else if (eeStatus === 0 && slotHashExpired) {
        console.log(`  EE round ${eeV4RoundId} stuck in CommitPhase — binding slot hash expired, abandoning`);
      }
      const nextEeId = eeV4RoundId + 1;
      const [nextEeWrAddr] = wrapperPda(nextEeId);
      if (!await conn.getAccountInfo(nextEeWrAddr)) {
        if (!await shouldRunEeRound()) {
          console.log(`  EE round ${eeV4RoundId} done — pool warm, no pending requests, idling`);
        } else {
          // Both identity (full mode) and hot key (hot-key-only mode) are accepted by the program.
          const nextCoordKey    = hotKeyOnlyMode ? hotKey.publicKey : identityPubkey;
          const nextCoordSigner = hotKeyOnlyMode ? hotKey : identity;
          console.log(`  EE round ${eeV4RoundId} done (status=${eeStatus}) — opening next EE round ${nextEeId}`);
          const { ix: initIx, eeRoundPubkey: newEeRoundPubkey } = ixInitEeRound(nextCoordKey, voteAccount, stakeAccount, nextEeId, currentRound);
          try {
            await send(initIx, `init_ee_round(id=${nextEeId})`, [nextCoordSigner]);
            eeRoundCache.set(nextEeId, newEeRoundPubkey);
          } catch (initErr) {
            if (await conn.getAccountInfo(nextEeWrAddr)) {
              console.log(`  init_ee_round raced — another validator won, they will commit`);
              return;
            }
            throw initErr;
          }
          console.log(`  ✓ EE round ${nextEeId} opened — n=7, m=5, binding_slot=current+675`);
          // Commit immediately — don't return and wait for the next poll, the
          // 200-slot commit window (~75s) can expire before the daemon polls again.
          const freshSecrets = { secret: crypto.randomBytes(32), nonce: crypto.randomBytes(32) };
          saveSecrets(nextEeId, freshSecrets.secret, freshSecrets.nonce);
          const freshCommitment = crypto.createHash("sha256")
            .update(Buffer.concat([freshSecrets.secret, freshSecrets.nonce, hotKey.publicKey.toBuffer()]))
            .digest();
          try {
            await send(ixCommit(nextEeId, newEeRoundPubkey, voteAccount, stakeAccount, freshCommitment), "commit_via_ee", [hotKey]);
            saveSecrets(nextEeId, freshSecrets.secret, freshSecrets.nonce, true);
            console.log(`  ✓ Committed to EE round ${nextEeId} immediately after init`);
          } catch (commitErr) {
            console.log(`  ⚠ Immediate commit failed: ${commitErr.message} — will retry next poll`);
          }
          return;
        }
      }
    } else {
      console.log(`  EE round ${eeV4RoundId} status=${eeStatus} — waiting for finalization before opening next round`);
    }
  }

  // ── Reveal phase ────────────────────────────────────────────────────────────
  // Only attempt reveal when:
  //   - inside the reveal window (commit_deadline ≤ cur < reveal_deadline at offset 58)
  //   - EE round status is RevealPhase (1)
  // Using reveal_deadline (not binding_slot) prevents failed reveals in the
  // ~75-slot gap between reveal_deadline and binding_slot.
  // Re-read eeAcct here to get a fresh status after the potentially long commit section.
  const freshEeAcct   = await conn.getAccountInfo(eeRoundPubkey);
  const eeRoundStatus = freshEeAcct?.data[140] ?? eeAcct.data[140];
  if (inRevealWindow && !revealed && eeRoundStatus === 1) {
    const secrets = loadSecrets(eeV4RoundId);
    if (!secrets) {
      console.log("  In reveal window but no secrets found — missed commit phase");
      return;
    }
    if (secrets.skipped) {
      console.log("  Skipped this EE round (not a contributor) — waiting for next round");
      return;
    }
    try {
      await send(ixReveal(eeV4RoundId, eeRoundPubkey, secrets.secret, secrets.nonce), "reveal_via_ee", [hotKey]);
      clearSecrets();
    } catch (e) {
      if (e.message?.includes("already") || e.message?.includes("0x0")) {
        console.log("  Already revealed");
        clearSecrets();
      } else if ([e.message, ...(e.logs ?? [])].some(s => s?.includes("0x1771") || s?.includes("WrongPhase"))) {
        // Round transitioned out of RevealPhase between our check and the tx landing.
        console.log("  WrongPhase on reveal — round no longer in RevealPhase, clearing secrets");
        clearSecrets();
      } else if ([e.message, ...(e.logs ?? [])].some(s => s?.includes("0x1777") || s?.includes("ContributorNotFound"))) {
        // Secrets file had committed=true but skipped was not set (written by older code).
        // We are not a contributor for this EE round — mark skipped so we stop trying.
        console.log("  ContributorNotFound on reveal — not a contributor for this EE round, marking skipped");
        saveSkipped(eeV4RoundId);
      } else { throw e; }
    }
  }

  if (revealed) {
    console.log("  Already revealed this round");
    clearSecrets();
  }

  // Clear stale secrets only once the reveal deadline has passed and the round is no longer revealable.
  // !inRevealWindow is NOT sufficient — it's also true while waiting for all n validators to commit
  // (status=0, between commitDeadline and RevealPhase), which would delete secrets we still need.
  if (cur >= revealDeadline && !revealed && eeRoundStatus !== 1) {
    console.log(`  EE round ${eeV4RoundId} status=${eeRoundStatus} — cannot reveal, clearing stale secrets`);
    clearSecrets();
  }

  // ── Claim rewards (sweep all unclaimed) ─────────────────────────────────────
  await sweepUnclaimedRewards();

}

// ── Sweep unclaimed validator rewards ──────────────────────────────────────────
// The crank advances the round immediately after distribute_fees, so by the time
// the daemon polls, currentRound is already N+1. We must scan ALL unclaimed
// ValidatorReveal PDAs for this validator and claim any with fees distributed.
// After key rotation, old reveals have contributor==identity; new reveals have
// contributor==hotKey. We scan both and claim with the appropriate signer.
async function sweepUnclaimedRewards() {
  const REVEAL_DISC = crypto.createHash("sha256")
    .update("account:ValidatorReveal").digest().slice(0, 8);

  // Build scan list: [{contributor, signer}].
  // In full mode: scan identity (pre-rotation reveals) + hot key if different.
  // In hot-key-only mode: only scan hot key (identity secret not available to claim with).
  const scanPairs = [];
  if (identity !== null) {
    scanPairs.push({ contributor: identityPubkey, signer: identity });
  }
  if (hotKeyOnlyMode || !hotKey.publicKey.equals(identityPubkey)) {
    scanPairs.push({ contributor: hotKey.publicKey, signer: hotKey });
  }

  for (const { contributor, signer } of scanPairs) {
    const myReveals = await conn.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0,  bytes: bs58.encode(REVEAL_DISC) } },
        { memcmp: { offset: 8,  bytes: contributor.toBase58() } },
        { memcmp: { offset: 80, bytes: bs58.encode(Buffer.from([0])) } }, // claimed=false
      ],
    });
    if (!myReveals.length) continue;

    // Batch-fetch all fee escrows (chunks of 100 — RPC limit)
    const escrowAddrs = myReveals.map(r => escrowPda(readU64(r.account.data, 72))[0]);
    const escrowAccts = [];
    for (let i = 0; i < escrowAddrs.length; i += 100) {
      const chunk = await conn.getMultipleAccountsInfo(escrowAddrs.slice(i, i + 100));
      escrowAccts.push(...chunk);
    }

    let claimed = 0;
    for (let i = 0; i < myReveals.length; i++) {
      const d  = myReveals[i].account.data;
      const ea = escrowAccts[i];
      if (!ea || ea.data.length < 42) continue;
      const feeDistributed = ea.data[40] !== 0;
      const originalFees   = Number(ea.data.readBigUInt64LE(24));
      if (!feeDistributed || originalFees === 0) continue;

      const eeRoundKey    = new PublicKey(d.slice(40, 72));
      const protocolRound = readU64(d, 72);
      const vrPubkey      = myReveals[i].pubkey;
      const escrowPubkey  = escrowAddrs[i];
      const claimIx = new TransactionInstruction({ programId: PROGRAM_ID,
        keys: [
          { pubkey: vrPubkey,      isSigner: false, isWritable: true  },
          { pubkey: escrowPubkey,  isSigner: false, isWritable: true  },
          { pubkey: eeRoundKey,    isSigner: false, isWritable: false },
          { pubkey: contributor,   isSigner: true,  isWritable: true  },
        ],
        data: disc("claim_validator_reward"),
      });
      try {
        await send(claimIx, `claim_validator_reward(round=${protocolRound})`, [signer]);
        claimed++;
      } catch (e) {
        const msg = e.message ?? "";
        const silent = msg.includes("RewardAlreadyClaimed") || msg.includes("already")
                    || msg.includes("FeeEscrowInsufficient") || msg.includes("0x177f")
                    || msg.includes("InvalidEeV4RoundResult") || msg.includes("0x1784");
        if (!silent) console.warn(`  Sweep claim failed for round ${protocolRound}: ${e.message}`);
      }
    }

    if (claimed === 0 && myReveals.length > 0) {
      const withFees = myReveals.filter((_, i) => {
        const ea = escrowAccts[i];
        return ea && ea.data.length >= 42 && ea.data[40] !== 0 && Number(ea.data.readBigUInt64LE(24)) > 0;
      }).length;
      if (withFees === 0) {
        console.log(`  ${myReveals.length} unclaimed reveal(s) for ${contributor.toBase58().slice(0, 8)}… — all empty rounds, no fees to collect`);
      }
    }
  }
}

// ── Key rotation ────────────────────────────────────────────────────────────────

function ixRotateRandomnessAuthority(newAuthority) {
  const [reg] = valRegPda(identity.publicKey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: reg,                isSigner: false, isWritable: true  },
      { pubkey: identity.publicKey, isSigner: true,  isWritable: false },
    ],
    data: Buffer.concat([disc("rotate_randomness_authority"), new PublicKey(newAuthority).toBuffer()]),
  });
}

async function rotateAuthority(newAuthorityStr) {
  console.log(`\n[rotate-authority] Validator : ${identity.publicKey.toBase58()}`);
  let newAuthority;
  try { newAuthority = new PublicKey(newAuthorityStr); } catch (_) {
    console.error(`  ✗ Invalid pubkey: ${newAuthorityStr}`); process.exit(1);
  }
  console.log(`  New authority : ${newAuthority.toBase58()}`);
  await send(ixRotateRandomnessAuthority(newAuthority), "rotate_randomness_authority");
  console.log("  ✓ Authority rotated.");
  console.log(`  Set X1_RANDOMNESS_KEYPAIR=<path_to_hotkey> in your daemon config.`);
}

// ── Registration helpers ────────────────────────────────────────────────────────

async function getValidatorVoteAndStake(identityPubkey) {
  const voteAccounts = await conn.getVoteAccounts("confirmed");
  const entry = [...voteAccounts.current, ...voteAccounts.delinquent]
    .find(v => v.nodePubkey === identityPubkey.toBase58());
  if (!entry) throw new Error(`No vote account found for ${identityPubkey.toBase58()}`);

  const stakeAccts = await conn.getParsedProgramAccounts(STAKE_PROG, {
    filters: [{ memcmp: { offset: 124, bytes: entry.votePubkey } }],
  });
  if (!stakeAccts.length) throw new Error(`No delegated stake account found for ${identityPubkey.toBase58()}`);
  stakeAccts.sort((a, b) => b.account.lamports - a.account.lamports);
  return {
    voteAccount:  new PublicKey(entry.votePubkey),
    stakeAccount: stakeAccts[0].pubkey,
    stake:        stakeAccts[0].account.lamports,
    lastVote:     entry.lastVote,
  };
}

function ixRegisterValidator(voteAccount, stakeAccount) {
  const [reg] = valRegPda(identity.publicKey);
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: reg,                     isSigner: false, isWritable: true },
      { pubkey: identity.publicKey,      isSigner: true,  isWritable: true },
      { pubkey: voteAccount,             isSigner: false, isWritable: false },
      { pubkey: stakeAccount,            isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("register_validator"),
  });
}

function ixDeregisterValidator() {
  const [reg] = valRegPda(identity.publicKey);
  // DeregisterValidator: [validator_registration(mut, close=identity), identity(signer, mut)]
  return new TransactionInstruction({ programId: PROGRAM_ID,
    keys: [
      { pubkey: reg,                isSigner: false, isWritable: true },
      { pubkey: identity.publicKey, isSigner: true,  isWritable: true },
    ],
    data: disc("deregister_validator"),
  });
}

async function registerValidator() {
  console.log(`\n[register] Validator : ${identity.publicKey.toBase58()}`);
  const [regPda] = valRegPda(identity.publicKey);
  if (await conn.getAccountInfo(regPda)) {
    console.log("  Already registered.");
    return;
  }
  const { voteAccount, stakeAccount, stake, lastVote } = await getValidatorVoteAndStake(identity.publicKey);
  console.log(`  Vote account  : ${voteAccount.toBase58()}`);
  console.log(`  Stake account : ${stakeAccount.toBase58()}`);
  console.log(`  Stake         : ${(stake / 1e9).toFixed(2)} XNT`);
  const slot = await conn.getSlot("confirmed");
  if (slot - lastVote > 500) throw new Error(`Vote account stale (${slot - lastVote} slots since last vote)`);
  if (stake < 1000 * 1e9) throw new Error(`Stake too low: ${(stake / 1e9).toFixed(2)} XNT (need ≥ 1000 XNT)`);
  await send(ixRegisterValidator(voteAccount, stakeAccount), "register_validator");
  console.log("  ✓ Registered successfully");
}

async function deregisterValidator() {
  console.log(`\n[deregister] Validator : ${identity.publicKey.toBase58()}`);
  const [regPda] = valRegPda(identity.publicKey);
  if (!await conn.getAccountInfo(regPda)) {
    console.log("  Not registered.");
    return;
  }
  await send(ixDeregisterValidator(), "deregister_validator");
  console.log("  ✓ Deregistered — registration account closed, rent returned to identity");
}

async function main() {
  if (doRegister) {
    await registerValidator();
    return;
  }
  if (doDeregister) {
    await deregisterValidator();
    return;
  }
  if (doRefresh) {
    const [regPda] = valRegPda(identityPubkey);
    const regAcct  = await conn.getAccountInfo(regPda);
    if (!regAcct) { console.log("  Not registered."); return; }
    const voteAccount  = new PublicKey(regAcct.data.slice(40, 72));
    const stakeAccount = new PublicKey(regAcct.data.slice(72, 104));
    console.log(`\n[refresh] Validator  : ${identityPubkey.toBase58()}`);
    console.log(`  Vote account   : ${voteAccount.toBase58()}`);
    console.log(`  Stake account  : ${stakeAccount.toBase58()}`);
    await send(ixRefreshValidatorStatus(voteAccount, stakeAccount), "refresh_validator_status", [identity]);
    console.log("  ✓ Validator status refreshed — active flag re-checked on-chain");
    return;
  }
  if (doRotateAuthority) {
    if (!rotateAuthorityTarget) {
      console.error("Usage: node keeper/validator-daemon.js --rotate-authority <new_pubkey>");
      process.exit(1);
    }
    await rotateAuthority(rotateAuthorityTarget);
    return;
  }
  if (doLoop) {
    const POLL_MS = parseInt(process.env.POLL_MS, 10) || 15_000;
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
