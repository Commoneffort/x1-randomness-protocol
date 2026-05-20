"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useX1Wallet, useConnection } from "@/lib/X1WalletContext";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { ProtocolClient } from "@/lib/protocol";
import { PROGRAM_ID, REQUEST_FEE_LAMPORTS, GAME_SEED_FEE_LAMPORTS, DISC, SLOT_HASHES_SYSVAR, STALENESS_HARD_LIMIT_SLOTS } from "@/lib/constants";
import { findProtocolConfigPda, findRequestPda, findEntropyPoolPda, findFeeEscrowPda, findWrapperRoundPda } from "@/lib/pdas";
import { BoltIcon, CubeIcon, CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/outline";

type Tab = "randomness" | "gameseed";

export default function RequestPage() {
  const { connection } = useConnection();
  const { connected, publicKey, signTransaction } = useX1Wallet();
  const [client] = useState(() => new ProtocolClient());
  const [tab, setTab] = useState<Tab>("randomness");

  // Pool state
  const [entropyAvailable, setEntropyAvailable] = useState(false);
  const [currentRound, setCurrentRound] = useState<number>(0);
  const [poolSlotsStale, setPoolSlotsStale] = useState<number>(0);

  // Randomness request state
  const [seed, setSeed] = useState("");
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [requestResult, setRequestResult] = useState<{
    signature: string;
    requestPda: string;
    output: string | null;
    fulfilled: boolean;
    queued: boolean;
  } | null>(null);

  // Game seed state
  const [gameId, setGameId] = useState("");
  const [gameSeedLoading, setGameSeedLoading] = useState(false);
  const [gameSeedResult, setGameSeedResult] = useState<{ sig: string; output: string } | null>(null);
  const [gameSeedError, setGameSeedError] = useState<string | null>(null);

  // Request lookup state
  const [lookupAddr, setLookupAddr] = useState("");
  const [lookupResult, setLookupResult] = useState<{ total: number; fulfilled: number } | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [myStats, setMyStats] = useState<{ total: number; fulfilled: number } | null>(null);

  useEffect(() => {
    const fetchStatus = async () => {
      const [pool, slot] = await Promise.all([
        client.getEntropyPool(),
        client.connection.getSlot("confirmed"),
      ]);
      if (pool) {
        setEntropyAvailable(pool.entropyAvailable);
        setCurrentRound(pool.currentRound);
        setPoolSlotsStale(slot - pool.lastAggregatedSlot);
      }
    };
    fetchStatus();
    const iv = setInterval(fetchStatus, 3000);
    return () => clearInterval(iv);
  }, [client]);

  useEffect(() => {
    if (!publicKey) { setMyStats(null); return; }
    client.getRequestsByRequester(publicKey).then(setMyStats);
  }, [client, publicKey]);

  const handleLookup = async () => {
    if (!lookupAddr.trim()) return;
    setLookupLoading(true); setLookupResult(null);
    try {
      const pk = new PublicKey(lookupAddr.trim());
      const result = await client.getRequestsByRequester(pk);
      setLookupResult(result);
    } catch {
      setLookupResult(null);
    } finally {
      setLookupLoading(false);
    }
  };

  const generateSeed = () => {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    setSeed(Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join(""));
  };

  const generateGameId = () => {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    setGameId(Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join(""));
  };

  const requestRandomness = useCallback(async () => {
    if (!connected || !publicKey || !signTransaction) { setError("Connect your wallet first"); return; }
    if (!seed || seed.length !== 64) { setError("Seed must be 64 hex characters (32 bytes)"); return; }
    setLoading(true); setError(null); setSuccess(null); setRequestResult(null);
    try {
      const seedBytes = Buffer.from(seed.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));

      const [configPda] = findProtocolConfigPda();
      const [poolPda] = findEntropyPoolPda();
      const [requestPda] = findRequestPda(publicKey, seedBytes);

      const config = await client.getProtocolConfig();
      if (!config) throw new Error("Protocol not initialized");
      const round = config.currentRound;
      const [escrowPda] = findFeeEscrowPda(round);
      const [wrapperRoundPda] = findWrapperRoundPda(round);

      // request_randomness(seed, callback_program, callback_instruction)
      const callbackProgram = new PublicKey(PROGRAM_ID);
      const callbackInstruction = Buffer.alloc(8, 0);
      const data = Buffer.concat([
        Buffer.from(DISC.request_randomness),
        seedBytes,
        callbackProgram.toBuffer(),
        callbackInstruction,
      ]);

      const slotHashesPubkey = new PublicKey(SLOT_HASHES_SYSVAR);
      const tx = new Transaction().add(new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: requestPda,        isSigner: false, isWritable: true },
          { pubkey: publicKey,         isSigner: true,  isWritable: true },
          { pubkey: configPda,         isSigner: false, isWritable: false },
          { pubkey: poolPda,           isSigner: false, isWritable: true },
          { pubkey: escrowPda,         isSigner: false, isWritable: true },
          { pubkey: wrapperRoundPda,   isSigner: false, isWritable: false },
          { pubkey: slotHashesPubkey,  isSigner: false, isWritable: false },
          // dapp_registration: pass SystemProgram as opt-out (no fee override)
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      }));

      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;
      const signed = await signTransaction(tx);
      const signature = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(signature, "confirmed");

      // Check immediately — fast path fulfills in the same tx, so RequestState.fulfilled
      // will already be true by the time we read it here.
      const immediateState = await client.getRequestState(requestPda);
      if (immediateState?.fulfilled) {
        setRequestResult({
          signature,
          requestPda: requestPda.toBase58(),
          output: immediateState.output,
          fulfilled: true,
          queued: false,
        });
        return;
      }

      // Queue path: pool was stale, request is pending until a keeper runs the EE V4 cycle.
      setRequestResult({
        signature,
        requestPda: requestPda.toBase58(),
        output: null,
        fulfilled: false,
        queued: true,
      });

      // Still poll in case a keeper runs soon.
      setPolling(true);
      let attempts = 0;
      const iv = setInterval(async () => {
        attempts++;
        try {
          const state = await client.getRequestState(requestPda);
          if (state?.fulfilled) {
            setRequestResult(prev => prev ? { ...prev, output: state.output, fulfilled: true, queued: false } : null);
            setPolling(false);
            clearInterval(iv);
          }
        } catch {}
        if (attempts >= 60) { setPolling(false); clearInterval(iv); }
      }, 5000);
    } catch (err: any) {
      setError(err.message || "Request failed");
    } finally {
      setLoading(false);
    }
  }, [connected, publicKey, signTransaction, seed, client, connection]);

  const requestGameSeed = useCallback(async () => {
    if (!connected || !publicKey || !signTransaction) { setGameSeedError("Connect your wallet first"); return; }
    if (!gameId || gameId.length !== 64) { setGameSeedError("Game ID must be 64 hex characters (32 bytes)"); return; }
    setGameSeedLoading(true); setGameSeedError(null); setGameSeedResult(null);
    try {
      const gameIdBytes = Buffer.from(gameId.match(/.{1,2}/g)!.map(b => parseInt(b, 16)));

      const [poolPda] = findEntropyPoolPda();
      const [configPda] = findProtocolConfigPda();
      const config = await client.getProtocolConfig();
      if (!config) throw new Error("Protocol not initialized");
      const [escrowPda] = findFeeEscrowPda(config.currentRound);

      const data = Buffer.concat([Buffer.from(DISC.game_seed), gameIdBytes]);
      const slotHashesPubkey = new PublicKey(SLOT_HASHES_SYSVAR);

      const tx = new Transaction().add(new TransactionInstruction({
        programId: new PublicKey(PROGRAM_ID),
        keys: [
          { pubkey: poolPda,           isSigner: false, isWritable: true  },
          { pubkey: configPda,         isSigner: false, isWritable: false },
          { pubkey: escrowPda,         isSigner: false, isWritable: true  },
          { pubkey: publicKey,         isSigner: true,  isWritable: true  },
          { pubkey: slotHashesPubkey,  isSigner: false, isWritable: false },
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

      // Parse the 32-byte return value from the Program return: log line.
      let outputHex = "";
      try {
        const txData = await connection.getTransaction(sig, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        const returnPrefix = `Program return: ${PROGRAM_ID} `;
        const returnLog = txData?.meta?.logMessages?.find(l => l.startsWith(returnPrefix));
        if (returnLog) {
          const b64 = returnLog.slice(returnPrefix.length).trim();
          outputHex = Buffer.from(b64, "base64").toString("hex");
        }
      } catch {}
      setGameSeedResult({ sig, output: outputHex || "(parse failed — see tx logs)" });
    } catch (err: any) {
      setGameSeedError(err.message || "Game seed request failed");
    } finally {
      setGameSeedLoading(false);
    }
  }, [connected, publicKey, signTransaction, gameId, currentRound, client, connection]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Request Randomness</h1>
        <p className="mt-1 text-text-secondary">
          Get verifiable on-chain randomness from the X1 Randomness Protocol.
        </p>
      </div>

      {/* Pool status */}
      {(() => {
        const isStaleHard = poolSlotsStale > STALENESS_HARD_LIMIT_SLOTS;
        const isWarm = entropyAvailable && !isStaleHard;
        const color = isWarm ? "border-l-green-400" : isStaleHard ? "border-l-red-400" : "border-l-yellow-400";
        const dot = isWarm ? "bg-green-400 animate-pulse" : isStaleHard ? "bg-red-400" : "bg-yellow-400";
        return (
          <div className={`card border-l-4 ${color}`}>
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full shrink-0 ${dot}`} />
              <div>
                <p className="font-medium text-text-primary">
                  {isWarm
                    ? "Fast Path Active — Entropy Pool Warm"
                    : isStaleHard
                    ? "Pool Stale — Queue Path Only"
                    : "Queue Path — Entropy Pool Empty"}
                </p>
                <p className="text-sm text-text-secondary">
                  {isWarm
                    ? `Randomness delivered from pool instantly (round ${currentRound})`
                    : isStaleHard
                    ? `Pool is ${poolSlotsStale.toLocaleString()} slots stale (~${Math.round(poolSlotsStale * 375 / 60000)}m). Requests will queue — a keeper must run the EE V4 commit/reveal/finalize cycle to fulfill them.`
                    : `Requests queue until the next EE V4 commit/reveal cycle completes`}
                </p>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Request stats lookup */}
      <div className="card">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Request History by Address</h2>
        {myStats && publicKey && (
          <div className="mb-3 p-3 bg-surface-elevated rounded-lg flex items-center gap-4 text-sm">
            <div>
              <p className="text-xs text-text-muted">Your wallet ({publicKey.toBase58().slice(0,8)}…)</p>
              <p className="font-medium text-text-primary">{myStats.total} requests · {myStats.fulfilled} fulfilled</p>
            </div>
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            value={lookupAddr}
            onChange={e => setLookupAddr(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleLookup(); }}
            placeholder="Any wallet or dApp address (base58)"
            className="input-field flex-1 font-mono text-sm"
          />
          <button
            onClick={handleLookup}
            disabled={lookupLoading || !lookupAddr.trim()}
            className="btn-secondary shrink-0"
          >
            {lookupLoading ? "…" : "Lookup"}
          </button>
        </div>
        {lookupResult && (
          <div className="mt-3 p-3 bg-surface-elevated rounded-lg text-sm">
            <p className="font-mono text-xs text-text-muted mb-1">{lookupAddr.slice(0,12)}…</p>
            <p className="font-medium text-text-primary">
              {lookupResult.total} requests · {lookupResult.fulfilled} fulfilled · {lookupResult.total - lookupResult.fulfilled} pending
            </p>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-surface-elevated rounded-lg p-1 w-fit border border-border">
        <button
          onClick={() => setTab("randomness")}
          className={`flex items-center gap-2 px-4 py-1.5 rounded text-sm font-medium transition-colors ${tab === "randomness" ? "bg-white text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"}`}
        >
          <BoltIcon className="h-4 w-4" /> Randomness Request
        </button>
        <button
          onClick={() => setTab("gameseed")}
          className={`flex items-center gap-2 px-4 py-1.5 rounded text-sm font-medium transition-colors ${tab === "gameseed" ? "bg-white text-text-primary shadow-sm" : "text-text-muted hover:text-text-primary"}`}
        >
          <CubeIcon className="h-4 w-4" /> Game Seed
        </button>
      </div>

      {tab === "randomness" && (
        <>
          <div className="card">
            <h2 className="text-lg font-semibold text-text-primary mb-4">Request On-Chain Randomness</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Seed <span className="text-text-muted">(32 bytes hex — personalizes your output)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text" value={seed} onChange={e => setSeed(e.target.value)}
                    placeholder="64 hex characters"
                    className="input-field flex-1 font-mono text-sm"
                  />
                  <button onClick={generateSeed} className="btn-secondary shrink-0">Generate</button>
                </div>
              </div>
              <div className="p-3 bg-surface-elevated rounded-lg text-sm text-text-secondary">
                Fee: <strong className="text-text-primary">{REQUEST_FEE_LAMPORTS / 1e9} XNT</strong>
                {" · "}Output: <code className="text-xs bg-surface-elevated px-1 rounded">SHA256(pool_entropy ‖ request_id ‖ slot_hash)</code>
              </div>
              {error && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-sm">
                  <XCircleIcon className="h-4 w-4 shrink-0" /> {error}
                </div>
              )}
              {!connected ? (
                <div className="p-4 bg-yellow-50 rounded-lg text-center text-yellow-700 text-sm">
                  Connect your X1 Wallet to request randomness
                </div>
              ) : (
                <button
                  onClick={requestRandomness}
                  disabled={loading || !seed || seed.length !== 64}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {loading ? "Submitting…" : "Request Randomness"}
                </button>
              )}
            </div>
          </div>

          {requestResult && (
            <div className="card space-y-3">
              <h2 className="text-lg font-semibold text-text-primary">Request Submitted</h2>
              <div className="p-3 bg-surface-elevated rounded-lg">
                <p className="text-xs text-text-muted mb-1">Transaction</p>
                <a
                  href={`https://explorer.x1.xyz/tx/${requestResult.signature}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-primary hover:underline font-mono text-xs break-all"
                >
                  {requestResult.signature}
                </a>
              </div>
              <div className="p-3 bg-surface-elevated rounded-lg">
                <p className="text-xs text-text-muted mb-1">Request PDA</p>
                <p className="font-mono text-xs text-text-primary break-all">{requestResult.requestPda}</p>
              </div>
              {requestResult.queued && !requestResult.fulfilled && (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-800 text-sm space-y-1">
                  <p className="font-medium">Queue path — pool was stale at submission time</p>
                  <p>This request will be fulfilled once a keeper runs the full EE V4 cycle:</p>
                  <ol className="list-decimal ml-5 space-y-0.5 text-xs mt-1">
                    <li><code className="bg-yellow-100 px-1 rounded">advance_round</code> — create new protocol round</li>
                    <li><code className="bg-yellow-100 px-1 rounded">init_ee_round</code> — open a new EE V4 commit window</li>
                    <li><code className="bg-yellow-100 px-1 rounded">commit_via_ee</code> / <code className="bg-yellow-100 px-1 rounded">reveal_via_ee</code> — validators stake &amp; reveal</li>
                    <li><code className="bg-yellow-100 px-1 rounded">finalize_via_ee</code> + <code className="bg-yellow-100 px-1 rounded">aggregate_from_ee</code> — pool warmed, queued requests fulfilled</li>
                  </ol>
                  {polling && (
                    <div className="flex items-center gap-2 mt-2 text-yellow-700">
                      <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-yellow-600 shrink-0" />
                      <span className="text-xs">Watching for fulfillment…</span>
                    </div>
                  )}
                </div>
              )}
              {!requestResult.queued && polling && (
                <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-2 text-blue-700 text-sm">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
                  Confirming fulfillment…
                </div>
              )}
              {requestResult.fulfilled && requestResult.output && (
                <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircleIcon className="h-4 w-4 text-green-600" />
                    <p className="text-sm font-medium text-green-700">Randomness Fulfilled</p>
                  </div>
                  <p className="font-mono text-xs text-text-primary break-all select-all bg-white p-2 rounded border border-green-200">
                    {requestResult.output}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="card">
            <h2 className="text-sm font-semibold text-text-primary mb-3">How It Works</h2>
            <div className="space-y-2 text-sm text-text-secondary">
              {[
                ["1", "Generate a 32-byte seed. This personalizes your random output — two requests with the same round entropy but different seeds get different outputs."],
                ["2", `Pay ${REQUEST_FEE_LAMPORTS / 1e9} XNT. Fees go into the round's FeeEscrow and are distributed 95% to validators / 5% to crank runner after the round.`],
                ["3", "If the pool is warm (fast path), your output is derived from existing pool entropy immediately. Otherwise, the request queues for the next EE V4 round."],
                ["4", "Output: SHA256(pool_entropy ‖ request_id ‖ slot_hash) — the slot hash is unknown at submission time, making outputs unpredictable even with known pool entropy. Deterministic and verifiable on-chain."],
              ].map(([n, text]) => (
                <div key={n} className="flex gap-3">
                  <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{n}</span>
                  <p>{text}</p>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {tab === "gameseed" && (
        <>
          <div className="card">
            <h2 className="text-lg font-semibold text-text-primary mb-2">Game Seed</h2>
            <p className="text-sm text-text-secondary mb-4">
              Get a fast, cheap random seed for in-game use. Costs {GAME_SEED_FEE_LAMPORTS / 1e9} XNT (vs {REQUEST_FEE_LAMPORTS / 1e9} XNT for a full randomness request).
              Game seeds use pool entropy directly — no queue.
            </p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  Game ID <span className="text-text-muted">(32 bytes hex — your game session identifier)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text" value={gameId} onChange={e => setGameId(e.target.value)}
                    placeholder="64 hex characters"
                    className="input-field flex-1 font-mono text-sm"
                  />
                  <button onClick={generateGameId} className="btn-secondary shrink-0">Generate</button>
                </div>
              </div>
              <div className="p-3 bg-surface-elevated rounded-lg text-sm text-text-secondary">
                Fee: <strong className="text-text-primary">{GAME_SEED_FEE_LAMPORTS / 1e9} XNT</strong>
                {" · "}Requires warm entropy pool (fast path only)
              </div>
              {gameSeedError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700 text-sm">
                  <XCircleIcon className="h-4 w-4 shrink-0" /> {gameSeedError}
                </div>
              )}
              {!entropyAvailable && (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-yellow-700 text-sm">
                  Entropy pool is empty — game_seed requires a warm pool. Wait for the next round to aggregate.
                </div>
              )}
              {!connected ? (
                <div className="p-4 bg-yellow-50 rounded-lg text-center text-yellow-700 text-sm">
                  Connect your X1 Wallet to request a game seed
                </div>
              ) : (
                <button
                  onClick={requestGameSeed}
                  disabled={gameSeedLoading || !gameId || gameId.length !== 64 || !entropyAvailable}
                  className="btn-primary w-full disabled:opacity-50"
                >
                  {gameSeedLoading ? "Submitting…" : "Get Game Seed"}
                </button>
              )}
            </div>
          </div>

          {gameSeedResult && (
            <div className="card space-y-3">
              <div className="flex items-center gap-2">
                <CheckCircleIcon className="h-5 w-5 text-green-600" />
                <h2 className="text-lg font-semibold text-text-primary">Game Seed Issued</h2>
              </div>
              <div className="p-3 bg-surface-elevated rounded-lg">
                <p className="text-xs text-text-muted mb-1">Transaction</p>
                <a
                  href={`https://explorer.x1.xyz/tx/${gameSeedResult.sig}`}
                  target="_blank" rel="noopener noreferrer"
                  className="text-primary hover:underline font-mono text-xs break-all"
                >
                  {gameSeedResult.sig}
                </a>
              </div>
              <div className="p-3 bg-surface-elevated rounded-lg">
                <p className="text-xs text-text-muted mb-1">Output — SHA256(pool_entropy ‖ game_id ‖ payer ‖ slot_hash)</p>
                <p className="font-mono text-xs text-text-primary break-all select-all bg-white p-2 rounded border border-border">
                  {gameSeedResult.output}
                </p>
              </div>
            </div>
          )}

          <div className="card">
            <h2 className="text-sm font-semibold text-text-primary mb-3">Game Seed vs Full Randomness Request</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-text-muted text-xs border-b border-border">
                    <th className="py-2 pr-4">Feature</th>
                    <th className="py-2 pr-4">Game Seed</th>
                    <th className="py-2">Randomness Request</th>
                  </tr>
                </thead>
                <tbody className="text-text-secondary">
                  {[
                    ["Fee", `${GAME_SEED_FEE_LAMPORTS / 1e9} XNT`, `${REQUEST_FEE_LAMPORTS / 1e9} XNT`],
                    ["Latency", "Instant (fast path only)", "Instant (warm) or ~4–10 min (queue)"],
                    ["Verifiable output", "SHA256(pool_entropy ‖ game_id ‖ payer ‖ slot_hash)", "SHA256(pool_entropy ‖ request_id ‖ slot_hash)"],
                    ["Use case", "In-game RNG, loot drops", "Lottery, NFT traits, auditable RNG"],
                    ["Requires warm pool", "Yes", "No (queues if cold)"],
                  ].map(([feat, gs, rr]) => (
                    <tr key={feat} className="border-b border-border/50">
                      <td className="py-2 pr-4 text-text-primary font-medium">{feat}</td>
                      <td className="py-2 pr-4">{gs}</td>
                      <td className="py-2">{rr}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
