#!/usr/bin/env node
/**
 * V4.6 post-upgrade migration: grow all ValidatorRegistration accounts from
 * 139 bytes → 171 bytes and set x1_randomness_authority = identity.
 *
 * Must be run immediately after the V4.6 program upgrade.
 * Until all accounts are migrated, commit/reveal/refresh/init_ee_round will fail
 * because the program can't deserialize the old 139-byte layout.
 *
 * Usage:
 *   PAYER_KEYPAIR=~/.config/solana/x1randomness-key.json node keeper/migrate-v46.js
 */

{
  const rws = require("rpc-websockets");
  if (!rws.CommonClient && rws.Client) rws.CommonClient = Object.getPrototypeOf(rws.Client);
  if (!rws.WebSocket) {
    for (const p of ["rpc-websockets/dist/lib/client/websocket", "ws"]) {
      try { const m = require(p); rws.WebSocket = m.default || m; if (rws.WebSocket) break; } catch (_) {}
    }
  }
}

const {
  Connection, PublicKey, Keypair, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const bs58   = require("bs58");

const RPC        = process.env.RPC_URL || "https://rpc.mainnet.x1.xyz";
const PROGRAM_ID = new PublicKey("BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R");
const conn       = new Connection(RPC, "confirmed");

const payerPath = process.env.PAYER_KEYPAIR;
if (!payerPath) {
  console.error("PAYER_KEYPAIR env var required");
  console.error("Example: PAYER_KEYPAIR=~/.config/solana/x1randomness-key.json node keeper/migrate-v46.js");
  process.exit(1);
}
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(payerPath.replace(/^~/, os.homedir()))))
);

function disc(name) {
  return crypto.createHash("sha256").update(`global:${name}`).digest().slice(0, 8);
}

// Discriminator for ValidatorRegistration account: sha256("account:ValidatorRegistration")[:8]
const VAL_REG_DISC = crypto.createHash("sha256")
  .update("account:ValidatorRegistration").digest().slice(0, 8);

async function main() {
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`RPC  : ${RPC}`);
  console.log(`\nScanning for ValidatorRegistration accounts…`);

  // Scan all ValidatorRegistration PDAs — both old (139) and new (171) sizes.
  const accounts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(VAL_REG_DISC) } }],
  });

  console.log(`Found ${accounts.length} ValidatorRegistration account(s)`);

  let migrated = 0;
  let alreadyDone = 0;
  let failed = 0;

  for (const { pubkey, account } of accounts) {
    const dataLen = account.data.length;
    const identity = new PublicKey(account.data.slice(8, 40));

    if (dataLen >= 171) {
      const authority = new PublicKey(account.data.slice(139, 171));
      console.log(`  ${identity.toBase58().slice(0, 8)}… — already migrated (171 bytes), authority=${authority.toBase58().slice(0, 8)}…`);
      alreadyDone++;
      continue;
    }

    console.log(`  ${identity.toBase58().slice(0, 8)}… — migrating (${dataLen} bytes)…`);

    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey,                         isSigner: false, isWritable: true  }, // validator_registration
        { pubkey: identity,               isSigner: false, isWritable: false }, // identity (CHECK)
        { pubkey: payer.publicKey,        isSigner: true,  isWritable: true  }, // payer
        { pubkey: SystemProgram.programId,isSigner: false, isWritable: false }, // system_program
      ],
      data: disc("migrate_validator_registration"),
    });

    try {
      const tx = new Transaction().add(ix);
      tx.feePayer = payer.publicKey;
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      console.log(`    ✓ ${sig.slice(0, 20)}…`);
      migrated++;
    } catch (e) {
      const msg = (e.message ?? "") + JSON.stringify(e.logs ?? []);
      if (msg.includes("AlreadyMigrated")) {
        console.log(`    already migrated (on-chain)`);
        alreadyDone++;
      } else {
        console.error(`    ✗ FAILED: ${e.message}`);
        failed++;
      }
    }
  }

  console.log(`\n─────────────────────────────`);
  console.log(`Migrated   : ${migrated}`);
  console.log(`Already done: ${alreadyDone}`);
  console.log(`Failed     : ${failed}`);

  if (failed > 0) {
    console.error("\n❌ Some migrations failed — do NOT rotate keys until all accounts are migrated.");
    process.exit(1);
  } else {
    console.log("\n✓ All accounts migrated. Validators can now run V4.6 daemon.");
    console.log("  To set a hot key: VALIDATOR_KEYPAIR=<identity> node validator-daemon.js --rotate-authority <hotkey_pubkey>");
  }
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
