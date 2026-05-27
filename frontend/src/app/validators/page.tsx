"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useX1Wallet, useConnection } from "@/lib/X1WalletContext";
import { PublicKey, Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { ProtocolClient, ValidatorReveal, FeeEscrow, ValidatorRegistration } from "@/lib/protocol";
import { PROGRAM_ID, EE_V4_STAKE_LAMPORTS, FEE_VALIDATORS_PCT, DISC, ACCT_DISC, MIN_VALIDATOR_STAKE_XNT, VALIDATOR_MAX_INACTIVE_SLOTS, MIN_COMMITTEE_SIZE, VALIDATOR_MAX_CONSECUTIVE_MISSES, EE_V4_N_CONTRIBUTORS, EE_V4_M_THRESHOLD } from "@/lib/constants";
import { findFeeEscrowPda, findValRegPda } from "@/lib/pdas";

export default function ValidatorsPage() {
  const { connected, publicKey, signTransaction } = useX1Wallet();
  const { connection } = useConnection();
  const [client] = useState(() => new ProtocolClient());

  // ── Reward claiming state ──
  const [reveals, setReveals] = useState<ValidatorReveal[]>([]);
  const [escrows, setEscrows] = useState<Record<number, FeeEscrow | null>>({});
  const [loading, setLoading] = useState(false);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ── Registry state ──
  const [allValidators, setAllValidators] = useState<ValidatorRegistration[]>([]);
  const [myReg, setMyReg] = useState<ValidatorRegistration | null | undefined>(undefined);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [voteInput, setVoteInput] = useState("");
  const [stakeInput, setStakeInput] = useState("");
  const [regPending, setRegPending] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [regSuccess, setRegSuccess] = useState<string | null>(null);
  const [currentSlot, setCurrentSlot] = useState(0);

  const fetchReveals = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    try {
      const vrs = await client.getValidatorReveals(publicKey);
      setReveals(vrs);
      // Deduplicate rounds then fetch all escrows in one getMultipleAccountsInfo call
      const uniqueRounds = Array.from(new Set(vrs.map(vr => vr.protocolRound)));
      const escrowMap = await client.getMultipleFeeEscrows(uniqueRounds);
      setEscrows(escrowMap);
    } finally {
      setLoading(false);
    }
  }, [publicKey, client]);

  const fetchRegistry = useCallback(async () => {
    setRegistryLoading(true);
    try {
      const [all, slot] = await Promise.all([
        client.getAllValidatorRegistrations(),
        client.connection.getSlot("confirmed"),
      ]);
      all.sort((a, b) => Number(b.verifiedStake) - Number(a.verifiedStake));
      setAllValidators(all);
      setCurrentSlot(slot);
      if (publicKey) {
        const me = all.find(v => v.identity === publicKey.toBase58()) ?? null;
        setMyReg(me);
      } else {
        setMyReg(undefined);
      }
    } finally {
      setRegistryLoading(false);
    }
  }, [publicKey, client]);

  useEffect(() => {
    fetchRegistry();
    if (connected && publicKey) fetchReveals();
  }, [connected, publicKey, fetchRegistry, fetchReveals]);

  const registerValidator = useCallback(async () => {
    if (!connected || !publicKey || !signTransaction) return;
    setRegPending(true); setRegError(null); setRegSuccess(null);
    try {
      let votePk: PublicKey, stakePk: PublicKey;
      try { votePk  = new PublicKey(voteInput.trim()); }
      catch { throw new Error("Invalid vote account address"); }
      try { stakePk = new PublicKey(stakeInput.trim()); }
      catch { throw new Error("Invalid stake account address"); }

      const [regPda] = findValRegPda(publicKey);
      const ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: regPda,                   isSigner: false, isWritable: true },
          { pubkey: publicKey,                isSigner: true,  isWritable: true },
          { pubkey: votePk,                   isSigner: false, isWritable: false },
          { pubkey: stakePk,                  isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
        ],
        data: Buffer.from(DISC.register_validator),
      });
      const tx = new Transaction().add(ix);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      setRegSuccess(`Registered! Tx: ${sig.slice(0, 20)}…`);
      await fetchRegistry();
    } catch (e: any) {
      setRegError(e.message || "Registration failed");
    } finally {
      setRegPending(false);
    }
  }, [connected, publicKey, signTransaction, connection, voteInput, stakeInput, fetchRegistry]);

  const deregisterValidator = useCallback(async () => {
    if (!connected || !publicKey || !signTransaction) return;
    setRegPending(true); setRegError(null); setRegSuccess(null);
    try {
      const [regPda] = findValRegPda(publicKey);
      const ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: regPda,    isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true,  isWritable: true },
        ],
        data: Buffer.from(DISC.deregister_validator),
      });
      const tx = new Transaction().add(ix);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      setRegSuccess(`Deregistered. Tx: ${sig.slice(0, 20)}…`);
      await fetchRegistry();
    } catch (e: any) {
      setRegError(e.message || "Deregistration failed");
    } finally {
      setRegPending(false);
    }
  }, [connected, publicKey, signTransaction, connection, fetchRegistry]);

  const claimReward = useCallback(async (vr: ValidatorReveal) => {
    if (!connected || !publicKey || !signTransaction) return;
    setClaiming(vr.pubkey); setError(null); setSuccess(null);
    try {
      const eeRoundPubkey = new PublicKey(vr.eeRound);
      const [vrPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("validator-reveal"), eeRoundPubkey.toBuffer(), publicKey.toBuffer()],
        new PublicKey(PROGRAM_ID)
      );
      const [escrowPda] = findFeeEscrowPda(vr.protocolRound);
      const ix = new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: vrPda,         isSigner: false, isWritable: true },
          { pubkey: escrowPda,     isSigner: false, isWritable: true },
          { pubkey: eeRoundPubkey, isSigner: false, isWritable: false },
          { pubkey: publicKey,     isSigner: true,  isWritable: true },
        ],
        data: Buffer.from(DISC.claim_validator_reward),
      });
      const tx = new Transaction().add(ix);
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");
      setSuccess(`Claimed! Tx: ${sig.slice(0, 20)}…`);
      await fetchReveals();
    } catch (e: any) {
      setError(e.message || "Claim failed");
    } finally {
      setClaiming(null);
    }
  }, [connected, publicKey, signTransaction, connection, fetchReveals]);

  const slotAge = (slot: number) => {
    const diff = currentSlot - slot;
    if (diff < 0) return "just now";
    const secs = Math.round(diff * 375 / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  };

  // isStale is a display hint only — VALIDATOR_MAX_INACTIVE_SLOTS is a commit-eligibility
  // constraint, not a heartbeat. With the idle gate, validators go hundreds of slots between
  // rounds. A validator is truly offline only when active === false (consecutive_misses >= 5).
  const isStale = (v: ValidatorRegistration) =>
    currentSlot - v.lastActiveSlot > VALIDATOR_MAX_INACTIVE_SLOTS && !v.active;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Validators & Rewards</h1>
        <p className="mt-1 text-text-secondary">
          Register as a protocol validator, participate in entropy rounds, and claim your share of randomness fees.
        </p>
      </div>

      {/* Registry overview */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-3">Validator Registry</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            { k: "Registered", v: allValidators.length.toString() },
            { k: "Active", v: allValidators.filter(v => v.active).length.toString() },
            { k: "Min stake", v: `${MIN_VALIDATOR_STAKE_XNT.toLocaleString()} XNT` },
            { k: "Committee size", v: `n=${EE_V4_N_CONTRIBUTORS} commit, m=${EE_V4_M_THRESHOLD} reveal to finalize` },
          ].map(({ k, v }) => (
            <div key={k} className="p-3 bg-surface-elevated rounded-lg">
              <p className="text-xs text-text-muted">{k}</p>
              <p className="text-sm font-semibold text-text-primary mt-0.5">{v}</p>
            </div>
          ))}
        </div>

        {registryLoading ? (
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            Loading validators…
          </div>
        ) : allValidators.length === 0 ? (
          <p className="text-text-muted text-sm">No validators registered yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-text-muted border-b border-border">
                  <th className="pb-2 pr-4">Identity</th>
                  <th className="pb-2 pr-4">Stake</th>
                  <th className="pb-2 pr-4">Last Active</th>
                  <th className="pb-2 pr-4">Misses</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {allValidators.map(v => {
                  const stale = isStale(v);
                  const online = v.active;
                  return (
                    <tr key={v.identity} className="text-text-primary">
                      <td className="py-2 pr-4 font-mono text-xs">
                        {v.identity.slice(0, 8)}…{v.identity.slice(-4)}
                        {v.identity === publicKey?.toBase58() && (
                          <span className="ml-1 text-xs text-primary font-sans">(you)</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">{(v.verifiedStake / 1e9).toLocaleString()} XNT</td>
                      <td className="py-2 pr-4 text-text-secondary">{slotAge(v.lastActiveSlot)}</td>
                      <td className="py-2 pr-4">{v.consecutiveMisses}</td>
                      <td className="py-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full border ${
                          online
                            ? "bg-green-50 text-green-700 border-green-200"
                            : stale
                            ? "bg-red-50 text-red-700 border-red-200"
                            : "bg-yellow-50 text-yellow-700 border-yellow-200"
                        }`}>
                          {online ? "Active" : stale ? "Offline" : "Inactive"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Registration form */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-1">Register as Validator</h2>
        <p className="text-sm text-text-secondary mb-3">
          Requirements: ≥{MIN_VALIDATOR_STAKE_XNT.toLocaleString()} XNT delegated stake, active vote account voting within {VALIDATOR_MAX_INACTIVE_SLOTS} slots (~3 min). Stake is verified on-chain at registration and on each round refresh — offline validators are kicked automatically.
        </p>

        {/* Two registration paths */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm">
            <p className="font-semibold text-text-primary mb-1">Option A — Register here (no npm)</p>
            <p className="text-text-secondary text-xs">Connect your X1 Wallet below. The connected wallet address becomes your validator identity key on-chain. Use this if your identity key is in your browser wallet.</p>
          </div>
          <div className="p-3 bg-surface-elevated border border-border rounded-lg text-sm">
            <p className="font-semibold text-text-primary mb-1">Option B — Register on the server (no npm)</p>
            <p className="text-text-secondary text-xs mb-2">If your identity key lives on the validator server, run this single-file script — no <code className="font-mono">npm install</code> needed:</p>
            <pre className="text-xs font-mono text-text-primary whitespace-pre-wrap break-all">{`node keeper/register.js \\
  --keypair ~/.config/solana/identity.json \\
  --vote    <vote_pubkey> \\
  --stake   <stake_pubkey>`}</pre>
          </div>
        </div>

        {!connected ? (
          <p className="text-text-muted text-sm">Connect your X1 Wallet to register or deregister (Option A).</p>
        ) : myReg ? (
          <div className="space-y-3">
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">
              <p className="font-semibold">Registered</p>
              <div className="mt-1 space-y-1 text-xs font-mono">
                <p>Vote:  {myReg.voteAccount.slice(0, 20)}…</p>
                <p>Stake: {myReg.stakeAccount.slice(0, 20)}…</p>
                <p>Verified stake: {(myReg.verifiedStake / 1e9).toLocaleString()} XNT</p>
                <p>Status: {myReg.active ? "✓ active" : "✗ inactive — run: VALIDATOR_KEYPAIR=~/.config/solana/identity.json node keeper/validator-daemon.js --refresh (on your validator server)"}</p>
              </div>
            </div>
            {regSuccess && <div className="p-3 bg-green-50 rounded-lg text-green-700 text-sm">{regSuccess}</div>}
            {regError && <div className="p-3 bg-red-50 rounded-lg text-red-700 text-sm">{regError}</div>}
            <button
              onClick={deregisterValidator}
              disabled={regPending}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              {regPending ? "Processing…" : "Deregister"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Vote Account Address</label>
              <input
                type="text"
                value={voteInput}
                onChange={e => setVoteInput(e.target.value)}
                placeholder="Your X1 vote account pubkey"
                className="w-full px-3 py-2 text-sm font-mono bg-surface-elevated border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-text-primary placeholder:text-text-muted"
              />
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Stake Account Address</label>
              <input
                type="text"
                value={stakeInput}
                onChange={e => setStakeInput(e.target.value)}
                placeholder="Stake account delegated to your vote account (≥1000 XNT)"
                className="w-full px-3 py-2 text-sm font-mono bg-surface-elevated border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-text-primary placeholder:text-text-muted"
              />
            </div>
            {regSuccess && <div className="p-3 bg-green-50 rounded-lg text-green-700 text-sm">{regSuccess}</div>}
            {regError && <div className="p-3 bg-red-50 rounded-lg text-red-700 text-sm">{regError}</div>}
            <button
              onClick={registerValidator}
              disabled={regPending || !voteInput || !stakeInput}
              className="btn-primary text-sm disabled:opacity-50"
            >
              {regPending ? "Registering…" : "Register Validator"}
            </button>
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-4">How Validators Earn</h2>
        <div className="space-y-3">
          {[
            { step: "1", title: "Register", desc: `Call register_validator with your vote account and a stake account delegated to it. The program verifies ≥${MIN_VALIDATOR_STAKE_XNT.toLocaleString()} XNT stake and that you voted within ${VALIDATOR_MAX_INACTIVE_SLOTS} slots. No whitelist — fully permissionless.` },
            { step: "2", title: "Run validator-daemon.js", desc: `Each validator runs their own daemon independently. It monitors the chain, checks your on-chain entropy-based eligibility each round, and calls commit_via_ee (SHA256(secret ‖ nonce ‖ pubkey), stakes ${EE_V4_STAKE_LAMPORTS / 1e9} XNT, returned on reveal). n=${EE_V4_N_CONTRIBUTORS} validators are selected to commit each round; m=${EE_V4_M_THRESHOLD} reveals suffice to finalize (up to ${EE_V4_N_CONTRIBUTORS - EE_V4_M_THRESHOLD} non-reveals tolerated).` },
            { step: "3", title: "Reveal before reveal_deadline", desc: "After commit_deadline (~200 slots / ~75s), submit your preimage before reveal_deadline (~600 slots / ~3.75 min from round init). Stake returns immediately. A ValidatorReveal PDA is written recording your contribution. Miss the deadline and you forfeit the stake." },
            { step: "4", title: "Claim reward", desc: `After finalize + distribute_fees (crank earns 5%), call claim_validator_reward once per round. Pays: round_fees × ${FEE_VALIDATORS_PCT}% ÷ reveal_count. Example: 3 requests × 0.01 XNT × 95% ÷ 3 revealers = 0.0095 XNT each.` },
          ].map(({ step, title, desc }) => (
            <div key={step} className="flex gap-4">
              <div className="w-7 h-7 rounded-full bg-primary/10 text-primary font-bold text-sm flex items-center justify-center shrink-0">{step}</div>
              <div>
                <p className="font-medium text-text-primary font-mono text-sm">{title}</p>
                <p className="text-sm text-text-secondary mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Liveness rules */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-3">Liveness Requirements</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          {[
            { k: "Min stake", v: `${MIN_VALIDATOR_STAKE_XNT.toLocaleString()} XNT delegated to your vote account` },
            { k: "Max vote staleness", v: `${VALIDATOR_MAX_INACTIVE_SLOTS} slots (~3 min) — checked at every commit` },
            { k: "Consecutive miss limit", v: `${VALIDATOR_MAX_CONSECUTIVE_MISSES} misses → validator marked inactive, excluded from rounds` },
            { k: "Kick mechanism", v: "Any wallet calls mark_validator_missed; slashes are automatic on finalize" },
            { k: "Recover from inactive", v: "Run --refresh on your validator server: VALIDATOR_KEYPAIR=~/.config/solana/identity.json node keeper/validator-daemon.js --refresh (requires cold identity key)" },
            { k: "Committee size", v: `Minimum ${MIN_COMMITTEE_SIZE} validators per round — single-validator entropy is impossible` },
          ].map(({ k, v }) => (
            <div key={k} className="p-3 bg-surface-elevated rounded-lg">
              <p className="text-xs text-text-muted">{k}</p>
              <p className="text-sm font-medium text-text-primary mt-0.5">{v}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Validator daemon setup */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-3">Validator Daemon Setup</h2>
        <p className="text-sm text-text-secondary mb-4">
          Each validator runs their own daemon independently. The daemon holds only the validator&apos;s own key — no other validator&apos;s keys needed. On-chain entropy-derived eligibility determines who commits each round.
        </p>

        {/* Step 1: Register */}
        <div className="mb-4">
          <p className="text-sm font-semibold text-text-primary mb-2">Step 1 — Register (one-time, no npm required)</p>
          <p className="text-xs text-text-secondary mb-2">Use the form above (Option A), or run this directly on your server with Node.js only — no <code className="font-mono">npm install</code>:</p>
          <pre className="bg-surface-elevated border border-border rounded-lg p-4 text-sm font-mono text-text-primary overflow-x-auto whitespace-pre-wrap">{`# No npm needed — uses only built-in Node.js modules
node keeper/register.js \\
  --keypair ~/.config/solana/identity.json \\
  --vote    <your_vote_account_pubkey> \\
  --stake   <your_stake_account_pubkey>

# Check status
node keeper/register.js --status --keypair ~/.config/solana/identity.json

# Deregister
node keeper/register.js --deregister --keypair ~/.config/solana/identity.json`}</pre>
        </div>

        {/* Step 2: Hot key + rotate (on validator server) */}
        <div className="mb-4">
          <p className="text-sm font-semibold text-text-primary mb-2">Step 2 — Generate a hot key and rotate (on your validator server)</p>
          <p className="text-xs text-text-secondary mb-2">The daemon runs on a separate server with only the hot key. The identity key never leaves your validator.</p>
          <pre className="bg-surface-elevated border border-border rounded-lg p-4 text-sm font-mono text-text-primary overflow-x-auto whitespace-pre-wrap">{`# On your VALIDATOR server

# 0. Note your identity pubkey — you will need it in Step 3
solana-keygen pubkey ~/.config/solana/identity.json

# 1. Generate hot key
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/x1randomness-hotkey.json

# 2. Fund the hot key (~0.5 XNT is plenty for transaction fees)
solana transfer $(solana-keygen pubkey ~/.config/solana/x1randomness-hotkey.json) 0.5 \\
  --url https://rpc.mainnet.x1.xyz --keypair ~/.config/solana/identity.json

# 3. Pull latest daemon code (or clone if not already present)
#    Already have it?  cd x1-randomness-protocol && git pull
#    First time?       git clone https://github.com/Commoneffort/x1-randomness-protocol && cd x1-randomness-protocol/keeper && npm install

# 4. Rotate — identity key signs once, then stays offline forever
VALIDATOR_KEYPAIR=~/.config/solana/identity.json \\
  node keeper/validator-daemon.js --rotate-authority \\
  $(solana-keygen pubkey ~/.config/solana/x1randomness-hotkey.json)

# 5. Stop any daemon already running on this server (the new server takes over)
pkill -f validator-daemon.js || true

# 6. Copy ONLY the hot key to your randomness server (never copy identity.json!)
scp ~/.config/solana/x1randomness-hotkey.json user@randomness-server:~/.config/solana/`}</pre>
        </div>

        {/* Step 3: Set up randomness server */}
        <div className="mb-4">
          <p className="text-sm font-semibold text-text-primary mb-2">Step 3 — Set up the randomness server (separate machine)</p>
          <p className="text-xs text-text-secondary mb-2">Install Node.js, clone the repo, and start the daemon using only the hot key + your identity pubkey (no secret).</p>
          <pre className="bg-surface-elevated border border-border rounded-lg p-4 text-sm font-mono text-text-primary overflow-x-auto whitespace-pre-wrap">{`# ── On your RANDOMNESS SERVER ─────────────────────────────

# 1. Install Node.js 22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc   # or open a new shell
nvm install 22

# 2. Clone repo and install deps
git clone https://github.com/Commoneffort/x1-randomness-protocol
cd x1-randomness-protocol/keeper
npm install

# 3. The hot key should already be at ~/.config/solana/x1randomness-hotkey.json
#    (copied from validator server in Step 2)

# 4. Set up systemd service
# Replace AAAAAA...  with your validator identity pubkey (base58, public — no secret)
sudo tee /etc/systemd/system/x1randomness-validator.service << 'EOF'
[Unit]
Description=X1 Randomness Protocol Validator Daemon
After=network.target

[Service]
User=YOUR_USER
Environment=VALIDATOR_IDENTITY_PUBKEY=YOUR_IDENTITY_PUBKEY_BASE58
Environment=X1_RANDOMNESS_KEYPAIR=/home/YOUR_USER/.config/solana/x1randomness-hotkey.json
ExecStart=/home/YOUR_USER/.nvm/versions/node/v22.22.2/bin/node /home/YOUR_USER/x1-randomness-protocol/keeper/validator-daemon.js --loop
WorkingDirectory=/home/YOUR_USER/x1-randomness-protocol/keeper
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable x1randomness-validator
sudo systemctl start x1randomness-validator

# 5. Check logs
sudo journalctl -u x1randomness-validator -f`}</pre>
        </div>

        {/* Reactivation */}
        <div className="mb-3">
          <p className="text-sm font-semibold text-text-primary mb-2">Reactivation (if your validator goes inactive)</p>
          <p className="text-xs text-text-secondary mb-2">After 5 missed rounds the protocol marks your validator inactive. The daemon cannot fix this itself — run this on your validator server:</p>
          <pre className="bg-surface-elevated border border-border rounded-lg p-4 text-sm font-mono text-text-primary overflow-x-auto whitespace-pre-wrap">{`# On your VALIDATOR server (where identity.json lives)
VALIDATOR_KEYPAIR=~/.config/solana/identity.json \\
  node keeper/validator-daemon.js --refresh`}</pre>
        </div>

        <p className="text-xs text-text-muted">
          The identity key (cold) signs only registration, rotation, and reactivation — all one-time or rare operations.
          The hot key (on the randomness server) handles all daily operations: commit, reveal, open new rounds (<code className="font-mono">init_ee_round</code>), and claim rewards.
          The crank (<code className="font-mono">run-round.js</code>) is separate and permissionless — any wallet can run it and earn the 5% crank reward.
        </p>
      </div>

      {/* Reward claiming */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-3">Your Pending Rewards</h2>
        {!connected ? (
          <p className="text-text-muted text-sm">Connect your X1 Wallet to see your ValidatorReveal PDAs and pending rewards.</p>
        ) : loading ? (
          <div className="flex items-center gap-2 text-text-muted text-sm">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-primary" />
            Loading…
          </div>
        ) : reveals.length === 0 ? (
          <p className="text-text-muted text-sm">No ValidatorReveal PDAs found. Participate in a round to earn rewards.</p>
        ) : (
          <div className="space-y-3">
            {success && <div className="p-3 bg-green-50 rounded-lg text-green-700 text-sm">{success}</div>}
            {error && <div className="p-3 bg-red-50 rounded-lg text-red-700 text-sm">{error}</div>}
            {reveals.map(vr => {
              const escrow = escrows[vr.protocolRound];
              const canClaim = !vr.claimed && !!escrow?.feeDistributed;
              const isClaiming = claiming === vr.pubkey;
              return (
                <div key={vr.pubkey} className="p-3 bg-surface-elevated rounded-lg flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-text-primary text-sm">Round {vr.protocolRound}</span>
                      {vr.claimed ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-50 text-green-700 border border-green-200">Claimed</span>
                      ) : escrow?.feeDistributed ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">Claimable</span>
                      ) : (!escrow?.pendingFees && !escrow?.originalFees) ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-surface-elevated text-text-muted border border-border">Empty Round</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-50 text-yellow-700 border border-yellow-200">Awaiting Distribution</span>
                      )}
                    </div>
                    <p className="text-xs text-text-muted mt-1 font-mono truncate">
                      EE Round: {vr.eeRound.slice(0, 12)}…
                    </p>
                    {escrow && !vr.claimed && escrow.originalFees > 0 && (
                      <p className="text-xs text-text-secondary mt-0.5">
                        Est. share ≈ {client.formatXnt(Math.floor(escrow.originalFees * 95 / 100))} XNT ÷ reveal_count
                      </p>
                    )}
                  </div>
                  {canClaim && (
                    <button
                      onClick={() => claimReward(vr)}
                      disabled={isClaiming}
                      className="btn-primary text-sm shrink-0 disabled:opacity-50"
                    >
                      {isClaiming ? "Claiming…" : "Claim"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
