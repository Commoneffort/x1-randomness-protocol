#!/usr/bin/env node
/**
 * Who has upgraded to the V4.8 daemon?
 *
 * V4.8 requires `validator_reg` to be writable in `reveal_via_ee`; the pre-V4.8
 * daemon sends it read-only. Writability is recorded in the transaction message,
 * so each validator's most recent reveal says which daemon produced it — no
 * cooperation needed from the operator.
 *
 * IMPORTANT — the signal lags. A validator that restarted but has not revealed
 * since still reads "old", because the newest evidence on chain predates its
 * restart. Rounds are hours apart, so allow a full round before treating this as
 * the confirmation gate for the deploy.
 *
 *   node keeper/check-daemon-versions.js
 *   RPC_URL=https://rpc.mainnet.x1.xyz node keeper/check-daemon-versions.js
 */
const { Connection, PublicKey } = require("@solana/web3.js");
const crypto = require("crypto");

const RPC     = process.env.RPC_URL || "https://rpc.mainnet.x1.xyz";
const PROGRAM = new PublicKey("BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R");
const REVEAL  = crypto.createHash("sha256").update("global:reveal_via_ee")
                      .digest().subarray(0, 8).toString("hex");
const SCAN    = 40; // signatures per validator

// Legacy messages expose writability positionally; MessageV0 has the accessor.
function isWritable(msg, idx) {
  try { return msg.isAccountWritable(idx); } catch (_) {}
  const h = msg.header;
  const n = (msg.staticAccountKeys || msg.accountKeys).length;
  return idx < h.numRequiredSignatures - h.numReadonlySignedAccounts ||
         (idx >= h.numRequiredSignatures && idx < n - h.numReadonlyUnsignedAccounts);
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const regs = await conn.getProgramAccounts(PROGRAM, { filters: [{ dataSize: 171 }] });

  const rows = [];
  for (const { pubkey: reg, account } of regs) {
    const d        = account.data;
    const identity = new PublicKey(d.subarray(8, 40));
    const hot      = new PublicKey(d.subarray(139, 171));
    const active   = d[137] === 1;

    let daemon = "no reveal found", when = "—";
    for (const s of await conn.getSignaturesForAddress(reg, { limit: SCAN })) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) continue;
      const msg  = tx.transaction.message;
      const keys = msg.staticAccountKeys || msg.accountKeys;
      let hit = false;
      for (const ix of (msg.compiledInstructions || msg.instructions)) {
        if (!keys[ix.programIdIndex].equals(PROGRAM)) continue;
        const data = Buffer.from(ix.data, typeof ix.data === "string" ? "base64" : undefined);
        if (data.subarray(0, 8).toString("hex") !== REVEAL) continue;
        const idx = keys.findIndex(k => k.equals(reg));
        if (idx < 0) continue;
        daemon = isWritable(msg, idx) ? "V4.8" : "pre-V4.8";
        when   = new Date(s.blockTime * 1000).toISOString().replace("T", " ").slice(0, 16);
        hit = true;
        break;
      }
      if (hit) break;
    }
    rows.push({ identity: identity.toBase58(), hot: hot.toBase58(), active, daemon, when });
  }

  const rank = { "pre-V4.8": 0, "no reveal found": 1, "V4.8": 2 };
  rows.sort((a, b) => rank[a.daemon] - rank[b.daemon]);

  console.log("\nDaemon version by last reveal_via_ee  (RPC " + RPC + ")\n");
  console.log("identity       hot key      last reveal        active  daemon");
  console.log("-".repeat(72));
  for (const r of rows) {
    console.log(`${r.identity.slice(0, 12)}   ${r.hot.slice(0, 10)}   ` +
                `${r.when.padEnd(17)}  ${(r.active ? "yes" : "no").padEnd(6)}  ${r.daemon}`);
  }

  const n = k => rows.filter(r => r.daemon === k).length;
  console.log(`\n${n("V4.8")} on V4.8 · ${n("pre-V4.8")} still pre-V4.8 · ` +
              `${n("no reveal found")} with no reveal in the last ${SCAN} txs`);
  if (n("pre-V4.8") > 0) {
    console.log("\nDo NOT deploy while any active validator still reads pre-V4.8 —");
    console.log("their reveals would fail ConstraintMut. Rounds tolerate 2 (m=5 of n=7).");
  }
})().catch(e => { console.error(e.message); process.exit(1); });
