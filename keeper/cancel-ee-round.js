#!/usr/bin/env node
// Cancels a stuck EE V4 round that never reached RevealPhase.
// Must be run by the round's coordinator (the validator who called init_ee_round).
// Usage: VALIDATOR_KEYPAIR=~/.config/solana/identity.json node /tmp/cancel-ee-round.js

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs   = require("fs");
const path = require("path");

// ── patch rpc-websockets if needed ──────────────────────────────────────────
{
  const rws = require("rpc-websockets");
  if (!rws.CommonClient && rws.Client) rws.CommonClient = Object.getPrototypeOf(rws.Client);
  if (!rws.WebSocket) {
    for (const p of ["rpc-websockets/dist/lib/client/websocket","ws"]) {
      try { const m = require(p); rws.WebSocket = m.default || m; if (rws.WebSocket) break; } catch(_) {}
    }
  }
}

const EE_V4 = new PublicKey("FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm");
const CANCEL_DISC = Buffer.from([82, 70, 134, 54, 46, 96, 148, 8]);

const RPC = "https://rpc.mainnet.x1.xyz";

const keypairPath = process.env.VALIDATOR_KEYPAIR;
if (!keypairPath) { console.error("VALIDATOR_KEYPAIR env var required"); process.exit(1); }
const identity = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath.replace("~", process.env.HOME), "utf8")))
);

const conn = new Connection(RPC, "confirmed");

function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

async function main() {
  const bs58 = require("bs58");

  // Find EE round 394730 (the stuck round)
  const TARGET_EE_ID = 394744n;
  console.log(`Looking for EE round ${TARGET_EE_ID}…`);

  const accts = await conn.getProgramAccounts(EE_V4, {
    filters: [
      { dataSize: 838 },
      { memcmp: { offset: 40, bytes: bs58.encode(u64le(Number(TARGET_EE_ID))) } },
    ],
  });

  if (!accts.length) {
    console.error("EE round not found — maybe already cancelled?");
    process.exit(0);
  }

  const eeRound = accts[0].pubkey;
  const d = accts[0].account.data;
  const coordinator = new PublicKey(d.slice(8, 40));
  const status = d[140];
  const commitCount = d[74];

  console.log("EE round:   ", eeRound.toBase58());
  console.log("Coordinator:", coordinator.toBase58());
  console.log("Status:     ", status, "(0=CommitPhase, 2=Finalized, 3=Cancelled)");
  console.log("Commits:    ", commitCount);

  if (status !== 0) {
    console.log(`Status is ${status} — not in CommitPhase. Nothing to cancel.`);
    process.exit(0);
  }

  if (!coordinator.equals(identity.publicKey)) {
    console.error(`You are ${identity.publicKey.toBase58()} but coordinator is ${coordinator.toBase58()}.`);
    console.error("Only the coordinator can cancel. Run this script as the coordinator validator.");
    process.exit(1);
  }

  // Collect contributor wallets in order (remaining_accounts)
  const contributors = [];
  for (let i = 0; i < commitCount; i++) {
    const base = 158 + i * 68;  // ContributorEntry: pubkey(32)+commitment(32)+4 flags = 68 bytes
    contributors.push(new PublicKey(d.slice(base, base + 32)));
  }
  console.log("Contributors to refund:", contributors.map(p => p.toBase58()));

  const keys = [
    { pubkey: eeRound,            isSigner: false, isWritable: true },
    { pubkey: identity.publicKey, isSigner: true,  isWritable: true },
  ];

  // remaining_accounts: contributor wallets in order, writable
  const remainingKeys = contributors.map(pk => ({ pubkey: pk, isSigner: false, isWritable: true }));

  const ix = new TransactionInstruction({
    programId: EE_V4,
    keys: [...keys, ...remainingKeys],
    data: CANCEL_DISC,
  });

  const tx = new Transaction().add(ix);
  console.log("\nSending cancel_round…");
  const sig = await sendAndConfirmTransaction(conn, tx, [identity], { commitment: "confirmed" });
  console.log("✓ cancel_round:", sig);
  console.log("EE round 394730 cancelled — validator daemons will now open EE round 394731.");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
