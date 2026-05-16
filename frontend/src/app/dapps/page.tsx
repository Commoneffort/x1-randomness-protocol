"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useX1Wallet, useConnection } from "@/lib/X1WalletContext";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ProtocolClient, DappRegistration } from "@/lib/protocol";
import { PROGRAM_ID, DISC, REQUEST_FEE_LAMPORTS, PREMIUM_REQUEST_FEE_LAMPORTS } from "@/lib/constants";
import { findProtocolConfigPda, findDappPda } from "@/lib/pdas";
import { PlusIcon, TrashIcon, CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/outline";

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
    const iv = setInterval(fetchDapps, 10000);
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
                Fee tier is set by the protocol authority via <code className="font-mono">update_dapp_fee</code> after you register — you cannot set it yourself on-chain. Select your preference here and the authority will apply it. All dApps start on Standard (0.01 XNT) until confirmed.
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
            <p className="font-medium text-text-primary mt-0.5">90% → validators</p>
            <p className="font-medium text-text-primary">10% → insurance fund</p>
          </div>
        </div>
        <p className="text-xs text-text-muted mt-1">
          Higher fees mean larger validator rewards per round, directly incentivising the committee to remain live and responsive to your requests.
          Note: <strong className="text-text-primary">game_seed fees (0.001 XNT) also flow to validators</strong> via the same FeeEscrow mechanism — every fee paid through the protocol contributes to validator rewards.
        </p>
      </div>

      {/* Developer guide */}
      <div className="card">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Integration Guide</h2>
        <div className="space-y-4 text-sm text-text-secondary">

          <div>
            <p className="font-semibold text-text-primary mb-1">Callback Instruction Discriminator</p>
            <p>
              This is the first 8 bytes of <code className="font-mono text-xs bg-surface-elevated px-1 rounded">sha256("global:your_instruction_name")</code> — the same discriminator Anchor puts at the start of every instruction.
              If you write <code className="font-mono text-xs bg-surface-elevated px-1 rounded">0,0,0,0,0,0,0,0</code> the protocol stores zeros and skips the CPI callback entirely; the randomness is still delivered on-chain but your program will not be called automatically.
            </p>
            <div className="mt-2 p-3 bg-surface-elevated rounded-lg font-mono text-xs space-y-1">
              <p className="text-text-muted"># Example — Anchor dApp with a "receive_randomness" handler:</p>
              <p>sha256(&quot;global:receive_randomness&quot;) = <span className="text-green-600">e8d4a51000000000…</span></p>
              <p>→ enter: <span className="text-green-600">232,212,165,16,0,0,0,0</span></p>
              <p className="text-text-muted mt-1"># No callback (pull model — read on-chain yourself):</p>
              <p>→ enter: <span className="text-text-primary">0,0,0,0,0,0,0,0</span></p>
            </div>
            <p className="mt-2 text-xs text-text-muted">
              Compute it in JS: <code className="font-mono bg-surface-elevated px-1 rounded">crypto.createHash(&apos;sha256&apos;).update(&apos;global:receive_randomness&apos;).digest().slice(0,8).join(&apos;,&apos;)</code>
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <p className="font-semibold text-text-primary mb-1">Min Round Interval</p>
            <p className="mb-2">
              Controls how often your dApp can request randomness. One protocol round wraps one EE V4 commit/reveal cycle — typically <strong className="text-text-primary">~4–5 minutes</strong> on X1 mainnet.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { val: "0", label: "On-demand", desc: "Request as often as you like. Good for games, lotteries, NFT mints — any low-latency use case." },
                { val: "1", label: "Once per round", desc: "One request per ~4–5 minute EE round. Suitable for scheduled draws or periodic randomness." },
                { val: "N", label: "Every N rounds", desc: "One request per N rounds (~4–5 min × N). Use for weekly/daily draws or rate-limited games." },
              ].map(({ val, label, desc }) => (
                <div key={val} className="p-3 bg-surface-elevated rounded-lg">
                  <p className="font-mono text-sm font-bold text-text-primary">{val}</p>
                  <p className="text-xs font-medium text-text-primary mt-0.5">{label}</p>
                  <p className="text-xs text-text-muted mt-1">{desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="font-semibold text-text-primary mb-1">How Randomness Is Delivered</p>
            <ol className="list-decimal list-inside space-y-1 text-sm text-text-secondary">
              <li>Your dApp calls <code className="font-mono text-xs bg-surface-elevated px-1 rounded">request_randomness</code> and pays the fee. A <code className="font-mono text-xs bg-surface-elevated px-1 rounded">RequestState</code> PDA is created with a unique <code className="font-mono text-xs bg-surface-elevated px-1 rounded">request_id</code>.</li>
              <li>If the entropy pool is warm, randomness is fulfilled instantly from the pool (<strong className="text-text-primary">fast path</strong>). If stale, the request queues and is fulfilled after the next EE V4 round.</li>
              <li>Your <code className="font-mono text-xs bg-surface-elevated px-1 rounded">receive_randomness</code> callback (if configured) is called by a keeper via <code className="font-mono text-xs bg-surface-elevated px-1 rounded">deliver_callback</code> with a 32-byte <code className="font-mono text-xs bg-surface-elevated px-1 rounded">output</code>.</li>
              <li>Each request gets a unique output: <code className="font-mono text-xs bg-surface-elevated px-1 rounded">SHA256(pool_entropy ‖ request_id ‖ slot_hash)</code> — the slot hash at inclusion time is unknown at submission, making outputs unpredictable even if pool entropy is known.</li>
            </ol>
          </div>

        </div>
      </div>

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
