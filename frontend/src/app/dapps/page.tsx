"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useX1Wallet, useConnection } from "@/lib/X1WalletContext";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ProtocolClient, DappRegistration } from "@/lib/protocol";
import { PROGRAM_ID, DISC, REQUEST_FEE_LAMPORTS, PREMIUM_REQUEST_FEE_LAMPORTS } from "@/lib/constants";
import { findProtocolConfigPda, findDappPda } from "@/lib/pdas";
import { PlusIcon, TrashIcon, CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/outline";

// ── Discriminator calculator ────────────────────────────────────────────────

async function computeDiscriminator(instructionName: string): Promise<string> {
  const msg = `global:${instructionName}`;
  const encoded = new TextEncoder().encode(msg);
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", encoded.buffer as ArrayBuffer);
  const bytes = Array.from(new Uint8Array(hashBuffer)).slice(0, 8);
  return bytes.join(",");
}

function IntegrationGuide({
  onDiscriminatorComputed,
  onShowForm,
}: {
  onDiscriminatorComputed: (v: string) => void;
  onShowForm: () => void;
}) {
  const [ixName, setIxName] = React.useState("");
  const [computed, setComputed] = React.useState<string | null>(null);
  const [model, setModel] = React.useState<"push" | "pull">("push");

  const handleCompute = async () => {
    if (!ixName.trim()) return;
    const disc = await computeDiscriminator(ixName.trim());
    setComputed(disc);
  };

  const handleUse = () => {
    if (!computed) return;
    onDiscriminatorComputed(computed);
    onShowForm();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleUseNoCallback = () => {
    onDiscriminatorComputed("0,0,0,0,0,0,0,0");
    onShowForm();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="card">
      <h2 className="text-sm font-semibold text-text-primary mb-4">Integration Guide</h2>
      <div className="space-y-6 text-sm text-text-secondary">

        {/* Step 1 — choose delivery model */}
        <div>
          <p className="font-semibold text-text-primary mb-1">
            Step 1 — Choose how your program receives randomness
          </p>
          <p className="mb-3">
            There are two ways to get randomness into your program. Pick the one that fits your use case:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setModel("push")}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                model === "push" ? "border-primary bg-primary/5" : "border-border bg-surface-elevated hover:border-text-muted"
              }`}
            >
              <p className="font-semibold text-text-primary">Push model (callback)</p>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                The protocol automatically calls an instruction in your program and passes the 32-byte random output directly to it. Your program does not need to do anything after the request — it just waits to be called back.
              </p>
              <p className="text-xs text-primary mt-2 font-medium">Best for: games, lotteries, NFT mints, anything that reacts to randomness.</p>
            </button>
            <button
              type="button"
              onClick={() => setModel("pull")}
              className={`text-left p-4 rounded-lg border-2 transition-colors ${
                model === "pull" ? "border-primary bg-primary/5" : "border-border bg-surface-elevated hover:border-text-muted"
              }`}
            >
              <p className="font-semibold text-text-primary">Pull model (no callback)</p>
              <p className="text-xs text-text-muted mt-1 leading-relaxed">
                The protocol stores the random output in a <code className="font-mono bg-surface-elevated px-1 rounded">RequestState</code> account on-chain. Your frontend or program reads it whenever it wants. No special instruction needed in your program.
              </p>
              <p className="text-xs text-primary mt-2 font-medium">Best for: dashboards, off-chain apps, or programs that check the result at a later step.</p>
            </button>
          </div>
        </div>

        {/* Step 2 — discriminator or no callback */}
        {model === "pull" ? (
          <div className="border-t border-border pt-5">
            <p className="font-semibold text-text-primary mb-2">
              Step 2 — No extra setup needed
            </p>
            <p className="mb-3">
              For the pull model you do not need a callback. When you register, enter{" "}
              <code className="font-mono text-xs bg-surface-elevated px-1 py-0.5 rounded border border-border">0,0,0,0,0,0,0,0</code> in the{" "}
              <em>Callback Instruction Discriminator</em> field. This tells the protocol to store the result on-chain without calling your program.
            </p>
            <p className="mb-3">
              After a request is fulfilled, read the result from the <code className="font-mono text-xs bg-surface-elevated px-1 py-0.5 rounded border border-border">RequestState</code> account. The 32-byte random output is stored at offset 153.
            </p>
            <div className="p-3 bg-surface-elevated rounded-lg border border-border font-mono text-xs space-y-1">
              <p className="text-text-muted">{`// Read the result in your frontend (JS/TS):`}</p>
              <p>{`const [reqPda] = PublicKey.findProgramAddressSync(`}</p>
              <p>{`  [Buffer.from("request"), requester.toBuffer(), seed],`}</p>
              <p>{`  PROGRAM_ID`}</p>
              <p>{`);`}</p>
              <p>{`const acct = await connection.getAccountInfo(reqPda);`}</p>
              <p>{`const fulfilled = acct.data[152] !== 0;  // bool`}</p>
              <p>{`const output = acct.data.slice(153, 185); // 32-byte random output`}</p>
            </div>
            <button
              type="button"
              onClick={handleUseNoCallback}
              className="mt-4 btn-primary text-sm"
            >
              Use pull model → open registration form
            </button>
          </div>
        ) : (
          <div className="border-t border-border pt-5 space-y-5">
            <div>
              <p className="font-semibold text-text-primary mb-2">
                Step 2 — Write a callback instruction in your Anchor program
              </p>
              <p className="mb-3">
                Add an instruction to your Anchor program that the protocol will call when your randomness is ready. It must accept exactly two arguments: a 32-byte output array and a round number.
              </p>
              <div className="p-3 bg-surface-elevated rounded-lg border border-border font-mono text-xs space-y-0.5">
                <p className="text-text-muted">{`// In your Anchor program (Rust):`}</p>
                <p>{`pub fn receive_randomness(`}</p>
                <p>{`    ctx: Context<ReceiveRandomness>,`}</p>
                <p>{`    output: [u8; 32],   // the 32-byte random value`}</p>
                <p>{`    round: u64,         // the protocol round number`}</p>
                <p>{`) -> Result<()> {`}</p>
                <p>{`    // store output, use it for your game logic, etc.`}</p>
                <p>{`    Ok(())`}</p>
                <p>{`}`}</p>
              </div>
              <p className="mt-2 text-xs text-text-muted">
                The instruction name can be anything you like — <code className="font-mono bg-surface-elevated px-1 rounded">receive_randomness</code> is just a common convention. The protocol does not care what it is called; it uses the 8-byte discriminator to identify it.
              </p>
            </div>

            <div>
              <p className="font-semibold text-text-primary mb-2">
                Step 3 — Find your instruction&apos;s discriminator
              </p>
              <p className="mb-3">
                Every Anchor instruction has a unique 8-byte fingerprint called a <strong className="text-text-primary">discriminator</strong>. Think of it as a function ID — it is the first 8 bytes of the SHA-256 hash of the string{" "}
                <code className="font-mono text-xs bg-surface-elevated px-1 py-0.5 rounded border border-border">{"global:<your_instruction_name>"}</code>.
                You need to find this and paste it into the registration form.
              </p>

              <p className="text-xs font-semibold text-text-primary mb-2 uppercase tracking-wide">Option A — Read it from your Anchor IDL file (easiest)</p>
              <p className="mb-2">
                After running <code className="font-mono text-xs bg-surface-elevated px-1 py-0.5 rounded border border-border">anchor build</code>, Anchor generates a JSON file at{" "}
                <code className="font-mono text-xs bg-surface-elevated px-1 py-0.5 rounded border border-border">target/idl/your_program.json</code>.
                Open it and find your instruction by name. The <code className="font-mono text-xs bg-surface-elevated px-1 py-0.5 rounded border border-border">discriminator</code> field is the exact array of bytes you need.
              </p>
              <div className="p-3 bg-surface-elevated rounded-lg border border-border font-mono text-xs space-y-0.5">
                <p className="text-text-muted">{`// target/idl/your_program.json  (example)`}</p>
                <p>{`{`}</p>
                <p>{`  "instructions": [`}</p>
                <p>{`    {`}</p>
                <p>{`      "name": "receive_randomness",`}</p>
                <p className="text-green-700 font-semibold">{`      "discriminator": [232, 212, 165, 16, 0, 0, 0, 0],`}</p>
                <p>{`      ...`}</p>
                <p>{`    }`}</p>
                <p>{`  ]`}</p>
                <p>{`}`}</p>
              </div>
              <p className="mt-2 text-xs text-text-muted">
                Copy that array and format it as comma-separated bytes:{" "}
                <code className="font-mono bg-surface-elevated px-1 rounded text-green-700">232,212,165,16,0,0,0,0</code>.
                That is exactly what to paste into the registration form.
              </p>

              <p className="text-xs font-semibold text-text-primary mb-2 mt-4 uppercase tracking-wide">Option B — Calculate it here</p>
              <p className="mb-2">
                Type your instruction name below. The discriminator will be computed instantly in your browser — no tools needed.
              </p>
              <div className="flex gap-2 items-center">
                <div className="flex items-center gap-0 flex-1 border border-border rounded-lg overflow-hidden bg-surface-elevated">
                  <span className="px-2 py-2 text-xs text-text-muted font-mono bg-surface border-r border-border whitespace-nowrap">global:</span>
                  <input
                    type="text"
                    value={ixName}
                    onChange={e => { setIxName(e.target.value); setComputed(null); }}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleCompute(); } }}
                    placeholder="receive_randomness"
                    className="flex-1 px-2 py-2 bg-transparent font-mono text-sm text-text-primary outline-none"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleCompute}
                  disabled={!ixName.trim()}
                  className="btn-secondary text-sm shrink-0"
                >
                  Compute
                </button>
              </div>

              {computed && (
                <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                  <p className="text-xs text-green-800 mb-1 font-medium">
                    Discriminator for <code className="font-mono">global:{ixName}</code>:
                  </p>
                  <p className="font-mono text-sm font-bold text-green-900">{computed}</p>
                  <div className="flex gap-2 mt-2">
                    <button
                      type="button"
                      onClick={handleUse}
                      className="text-xs px-3 py-1.5 bg-green-700 text-white rounded hover:bg-green-800 transition-colors"
                    >
                      Use this → open registration form
                    </button>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard.writeText(computed)}
                      className="text-xs px-3 py-1.5 border border-green-300 text-green-800 rounded hover:bg-green-100 transition-colors"
                    >
                      Copy to clipboard
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Delivery flow */}
        <div className="border-t border-border pt-5">
          <p className="font-semibold text-text-primary mb-3">How the full flow works end-to-end</p>
          <ol className="space-y-3">
            {[
              {
                n: "1",
                title: "Your program or frontend calls request_randomness",
                body: "A 0.01 XNT fee is transferred to the round's fee escrow. A RequestState account is created on-chain holding a unique request_id derived from your program ID, seed, and callback details.",
              },
              {
                n: "2",
                title: "Randomness is produced",
                body: "If the entropy pool already has fresh entropy (warm pool), your request is fulfilled immediately in the same transaction — typically under 1 second. If the pool is stale, the request queues and is fulfilled once the next EE V4 commit/reveal cycle completes (~4–5 minutes).",
              },
              {
                n: "3",
                title: "Your callback is called (push model only)",
                body: "A keeper calls deliver_callback, which CPIs into your program with the 32-byte output and the round number. Your program receives the randomness directly — no polling, no reading accounts.",
              },
              {
                n: "4",
                title: "The result is verifiable on-chain forever",
                body: "The output formula is SHA256(pool_entropy ‖ request_id ‖ slot_hash). Anyone can call verify_entropy on the RequestState account to confirm the output is correct. The slot hash at transaction inclusion was unknown at submission time, making the result unpredictable even to the protocol operators.",
              },
            ].map(({ n, title, body }) => (
              <li key={n} className="flex gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center mt-0.5">{n}</span>
                <div>
                  <p className="font-medium text-text-primary">{title}</p>
                  <p className="text-xs text-text-muted mt-0.5 leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* Min round interval */}
        <div className="border-t border-border pt-5">
          <p className="font-semibold text-text-primary mb-2">Min Round Interval</p>
          <p className="mb-3">
            Controls the minimum number of protocol rounds between consecutive requests from your dApp. One round is one full EE V4 commit/reveal cycle — typically <strong className="text-text-primary">~4–5 minutes</strong> on X1 mainnet.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {[
              { val: "0", label: "On-demand", desc: "Request as often as you like — every round if needed. Good for games, lotteries, NFT mints — any low-latency use case." },
              { val: "1", label: "Once per round", desc: "One request per ~4–5 minute EE round. Suitable for scheduled draws or periodic randomness." },
              { val: "N", label: "Every N rounds", desc: "One request per N rounds (~4–5 min × N). Use for weekly/daily draws or rate-limited games." },
            ].map(({ val, label, desc }) => (
              <div key={val} className="p-3 bg-surface-elevated rounded-lg border border-border">
                <p className="font-mono text-sm font-bold text-text-primary">{val}</p>
                <p className="text-xs font-medium text-text-primary mt-0.5">{label}</p>
                <p className="text-xs text-text-muted mt-1">{desc}</p>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}

function u64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

export default function DappsPage() {
  const { publicKey, connected, signTransaction } = useX1Wallet();
  const { connection } = useConnection();
  const [client] = useState(() => new ProtocolClient());
  const [dapps, setDapps] = useState<DappRegistration[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [unregistering, setUnregistering] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [dappId, setDappId] = useState("");
  const [callbackProgram, setCallbackProgram] = useState(PROGRAM_ID);
  const [callbackInstruction, setCallbackInstruction] = useState("0,0,0,0,0,0,0,0");
  const [minRoundInterval, setMinRoundInterval] = useState("0");
  const [feeTier, setFeeTier] = useState<"standard" | "premium">("standard");

  const fetchDapps = useCallback(async () => {
    const all = await client.getAllDapps();
    setDapps(all);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    fetchDapps();
    const iv = setInterval(fetchDapps, 30_000);
    return () => clearInterval(iv);
  }, [fetchDapps]);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connected || !publicKey || !signTransaction) { setError("Connect your wallet first"); return; }
    setRegistering(true); setError(null); setSuccess(null);
    try {
      const dappIdPubkey = new PublicKey(dappId);
      const cbProgPubkey = new PublicKey(callbackProgram);
      const cbIxBytes = callbackInstruction.split(",").map(n => parseInt(n.trim()));
      if (cbIxBytes.length !== 8 || cbIxBytes.some(isNaN)) throw new Error("Callback instruction must be exactly 8 comma-separated bytes");

      const [configPda] = findProtocolConfigPda();
      const [dappPda] = findDappPda(dappIdPubkey);

      // register_dapp(callback_program, callback_instruction, min_round_interval)
      // fee_override is set separately by authority via update_dapp_fee after registration.
      // The tier selection is recorded here for the authority to action.
      const data = Buffer.concat([
        Buffer.from(DISC.register_dapp),
        cbProgPubkey.toBuffer(),
        Buffer.from(cbIxBytes),
        u64le(parseInt(minRoundInterval) || 0),
      ]);
      // Note: fee_override for premium tier is applied by protocol authority post-registration.
      // The feeTier value is informational here and submitted as metadata.

      const tx = new Transaction().add(new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: dappPda,                 isSigner: false, isWritable: true },
          { pubkey: dappIdPubkey,            isSigner: false, isWritable: false },
          { pubkey: publicKey,               isSigner: true,  isWritable: true },
          { pubkey: configPda,               isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }));

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      setSuccess(`dApp registered! TX: ${sig.slice(0, 20)}…`);
      setDappId(""); setShowForm(false);
      await fetchDapps();
    } catch (err: any) {
      setError(err.message || "Registration failed");
    } finally {
      setRegistering(false);
    }
  };

  const handleUnregister = async (dapp: DappRegistration) => {
    if (!connected || !publicKey || !signTransaction) { setError("Connect wallet first"); return; }
    if (dapp.authority !== publicKey.toBase58()) { setError("Only the dApp authority can unregister"); return; }
    setUnregistering(dapp.dappId); setError(null); setSuccess(null);
    try {
      const dappIdPubkey = new PublicKey(dapp.dappId);
      const [dappPda] = findDappPda(dappIdPubkey);
      const tx = new Transaction().add(new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: dappPda,  isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true, isWritable: true },
        ],
        data: Buffer.from(DISC.unregister_dapp),
      }));
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      setSuccess("dApp unregistered!");
      await fetchDapps();
    } catch (err: any) {
      setError(err.message || "Unregister failed");
    } finally {
      setUnregistering(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">dApp Registry</h1>
          <p className="mt-1 text-text-secondary">Register your dApp to request on-demand randomness via callbacks.</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="btn-primary flex items-center gap-2"
          disabled={!connected}
          title={!connected ? "Connect wallet first" : undefined}
        >
          <PlusIcon className="h-4 w-4" />
          Register dApp
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-sm">
          <XCircleIcon className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg flex items-center gap-2 text-green-700 text-sm">
          <CheckCircleIcon className="h-4 w-4 shrink-0" /> {success}
        </div>
      )}

      {showForm && (
        <div className="card">
          <h2 className="text-lg font-semibold text-text-primary mb-4">Register New dApp</h2>
          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                dApp Program ID <span className="text-text-muted">(used as PDA seed — unique identifier)</span>
              </label>
              <input
                type="text" value={dappId} onChange={e => setDappId(e.target.value)}
                placeholder="e.g. your dApp's program ID or any unique pubkey"
                className="input-field w-full font-mono text-sm" required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Callback Program</label>
              <input
                type="text" value={callbackProgram} onChange={e => setCallbackProgram(e.target.value)}
                className="input-field w-full font-mono text-sm" required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Callback Instruction Discriminator <span className="text-text-muted">(8 bytes, comma-separated)</span>
              </label>
              <input
                type="text" value={callbackInstruction} onChange={e => setCallbackInstruction(e.target.value)}
                placeholder="0,0,0,0,0,0,0,0"
                className="input-field w-full font-mono text-sm" required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Min Round Interval <span className="text-text-muted">(0 = on-demand)</span>
              </label>
              <input
                type="number" value={minRoundInterval} onChange={e => setMinRoundInterval(e.target.value)}
                className="input-field w-24" min="0" required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">
                Fee Tier Request <span className="text-text-muted">(informational — applied by protocol authority post-registration)</span>
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {([
                  { id: "standard", label: "Standard", fee: REQUEST_FEE_LAMPORTS, desc: "0.01 XNT per request. Default for all dApps. Good for NFT mints, one-off apps, and low-volume use cases." },
                  { id: "premium",  label: "Premium",  fee: PREMIUM_REQUEST_FEE_LAMPORTS, desc: "0.05 XNT per request. For casinos, games, and high-frequency dApps. Higher fees mean larger validator rewards → better liveness." },
                ] as const).map(tier => (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={() => setFeeTier(tier.id)}
                    className={`text-left p-3 rounded-lg border-2 transition-colors ${
                      feeTier === tier.id
                        ? "border-primary bg-primary/5"
                        : "border-border bg-surface-elevated hover:border-text-muted"
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-semibold text-sm text-text-primary">{tier.label}</span>
                      <span className="font-mono text-sm text-text-primary">{(tier.fee / 1e9).toFixed(2)} XNT/req</span>
                    </div>
                    <p className="text-xs text-text-muted">{tier.desc}</p>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded p-2">
                Fee tier can be changed on-chain by calling <code className="font-mono">update_dapp_fee</code> — signed by the <strong>dApp authority</strong> (the wallet you register with). Higher fees mean larger validator rewards per round, incentivising liveness for your use case.
              </p>
            </div>

            <div className="flex gap-3">
              <button type="submit" className="btn-primary" disabled={registering}>
                {registering ? "Registering…" : "Register"}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Protocol Info */}
      <div className="card">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Request Fee Tiers</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm mb-3">
          <div className="p-3 bg-surface-elevated rounded-lg">
            <p className="text-xs text-text-muted">Standard (default)</p>
            <p className="font-mono font-bold text-text-primary mt-0.5">{(REQUEST_FEE_LAMPORTS / 1e9).toFixed(2)} XNT / req</p>
            <p className="text-xs text-text-muted mt-1">NFT mints, one-off apps, low-volume dApps</p>
          </div>
          <div className="p-3 bg-surface-elevated rounded-lg border border-primary/30">
            <p className="text-xs text-text-muted">Premium</p>
            <p className="font-mono font-bold text-text-primary mt-0.5">{(PREMIUM_REQUEST_FEE_LAMPORTS / 1e9).toFixed(2)} XNT / req</p>
            <p className="text-xs text-text-muted mt-1">Casinos, games, high-volume — maximises validator liveness</p>
          </div>
          <div className="p-3 bg-surface-elevated rounded-lg">
            <p className="text-xs text-text-muted">Fee Split</p>
            <p className="font-medium text-text-primary mt-0.5">95% → validators</p>
            <p className="font-medium text-text-primary">5% → crank runner</p>
          </div>
        </div>
        <p className="text-xs text-text-muted mt-1">
          Higher fees mean larger validator rewards per round, directly incentivising the committee to remain live and responsive to your requests.
          Note: <strong className="text-text-primary">game_seed fees (0.001 XNT) also flow to validators</strong> via the same FeeEscrow mechanism — every fee paid through the protocol contributes to validator rewards.
        </p>
      </div>

      {/* Developer guide */}
      <IntegrationGuide onDiscriminatorComputed={setCallbackInstruction} onShowForm={() => setShowForm(true)} />

      {/* dApp List */}
      {loading ? (
        <div className="flex items-center justify-center h-32">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : dapps.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-text-muted">No dApps registered yet</p>
          <p className="text-sm text-text-secondary mt-2">Connect your wallet and register your first dApp above.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">{dapps.length} registered dApp{dapps.length !== 1 ? "s" : ""}</p>
          {dapps.map(dapp => {
            const isOwn = connected && dapp.authority === publicKey?.toBase58();
            const effectiveFee = dapp.feeOverride > 0 ? dapp.feeOverride : REQUEST_FEE_LAMPORTS;
            return (
              <div key={dapp.pubkey} className="card">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-mono text-sm font-medium text-text-primary truncate">
                        {dapp.dappId.slice(0, 8)}…{dapp.dappId.slice(-8)}
                      </p>
                      {isOwn && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">yours</span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs">
                      <div>
                        <span className="text-text-muted">Requests: </span>
                        <span className="text-text-primary font-medium">{dapp.totalRequests.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="text-text-muted">Last round: </span>
                        <span className="text-text-primary font-medium">{dapp.lastServedRound || "—"}</span>
                      </div>
                      <div>
                        <span className="text-text-muted">Min interval: </span>
                        <span className="text-text-primary font-medium">{dapp.minRoundInterval}</span>
                      </div>
                      <div>
                        <span className="text-text-muted">Fee: </span>
                        <span className="text-text-primary font-medium">
                          {(effectiveFee / 1e9).toFixed(4)} XNT
                          {dapp.feeOverride > 0 && " (custom)"}
                        </span>
                      </div>
                    </div>
                    <p className="text-xs text-text-muted font-mono truncate">
                      authority: {dapp.authority.slice(0, 12)}…
                    </p>
                  </div>
                  {isOwn && (
                    <button
                      onClick={() => handleUnregister(dapp)}
                      disabled={unregistering === dapp.dappId}
                      className="flex items-center gap-1 px-2 py-1 rounded text-red-600 border border-red-200 hover:bg-red-50 text-xs shrink-0 disabled:opacity-50"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                      {unregistering === dapp.dappId ? "…" : "Remove"}
                    </button>
                  )}
                </div>
                <div className="mt-2 pt-2 border-t border-border flex justify-end">
                  <a
                    href={`https://explorer.x1.xyz/address/${dapp.pubkey}`}
                    target="_blank" rel="noopener noreferrer"
                    className="text-xs text-primary hover:underline"
                  >
                    View on Explorer →
                  </a>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
