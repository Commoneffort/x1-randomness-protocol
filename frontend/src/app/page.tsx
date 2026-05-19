"use client";

import React, { useEffect, useState } from "react";
import {
  BoltIcon,
  ClockIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  CubeIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { ProtocolClient, ProtocolConfig, EntropyPool } from "@/lib/protocol";
import { REQUEST_FEE_LAMPORTS, GAME_SEED_FEE_LAMPORTS, SLOT_DURATION_MS, STALENESS_HARD_LIMIT_SLOTS } from "@/lib/constants";

function StatCard({
  title, value, sub, icon: Icon, accent,
}: {
  title: string; value: string; sub?: string;
  icon: React.ElementType; accent: "blue" | "green" | "yellow" | "purple";
}) {
  const colors = {
    blue:   "text-blue-600 bg-blue-50",
    green:  "text-green-600 bg-green-50",
    yellow: "text-yellow-600 bg-yellow-50",
    purple: "text-purple-600 bg-purple-50",
  };
  return (
    <div className="card animate-fade-in">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-text-secondary">{title}</p>
          <p className="mt-2 text-3xl font-bold text-text-primary">{value}</p>
          {sub && <p className="mt-1 text-sm text-text-muted">{sub}</p>}
        </div>
        <div className={`p-3 rounded-lg ${colors[accent]}`}>
          <Icon className="h-6 w-6" />
        </div>
      </div>
    </div>
  );
}

function PoolStatus({ pool, currentSlot }: { pool: EntropyPool; currentSlot: number }) {
  const slotsStale = currentSlot - pool.lastAggregatedSlot;
  const isStale = slotsStale > STALENESS_HARD_LIMIT_SLOTS;
  const isWarm = pool.entropyAvailable && !isStale;

  return (
    <div className={`card border-l-4 ${isWarm ? "border-l-green-400" : "border-l-yellow-400"}`}>
      <div className="flex items-center gap-4">
        <div className={`w-3 h-3 rounded-full ${isWarm ? "bg-green-400 animate-pulse" : "bg-yellow-400"}`} />
        <div className="flex-1">
          <p className="font-semibold text-text-primary">
            {isWarm ? "Entropy Pool Warm — Fast Path Active" : "Entropy Pool Stale — Queue Path"}
          </p>
          <p className="text-sm text-text-secondary mt-0.5">
            {isWarm
              ? `Randomness delivered instantly from pool (round ${pool.currentRound})`
              : `Pool last updated ${slotsStale.toLocaleString()} slots ago — new requests queue for next EE V4 round`}
          </p>
        </div>
        <div className="text-right hidden sm:block">
          <p className="text-xs text-text-muted">Age</p>
          <p className="text-sm font-mono font-medium text-text-primary">
            {Math.round(slotsStale * SLOT_DURATION_MS / 1000)}s
          </p>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [config, setConfig] = useState<ProtocolConfig | null>(null);
  const [pool, setPool] = useState<EntropyPool | null>(null);
  const [currentSlot, setCurrentSlot] = useState(0);
  const [loading, setLoading] = useState(true);

  const [client] = useState(() => new ProtocolClient());

  const fetchData = async () => {
    try {
      const [cfg, pl, slot] = await Promise.all([
        client.getProtocolConfig(),
        client.getEntropyPool(),
        client.connection.getSlot("confirmed"),
      ]);
      setConfig(cfg);
      setPool(pl);
      setCurrentSlot(slot);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 3000);
    return () => clearInterval(iv);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text-primary">Protocol Dashboard</h1>
        <p className="mt-1 text-text-secondary">
          X1 Randomness Protocol V4 — Live on X1 Mainnet
        </p>
      </div>

      {pool && <PoolStatus pool={pool} currentSlot={currentSlot} />}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Current Round"
          value={config?.currentRound.toString() ?? "—"}
          sub={`Total rounds: ${config?.totalRounds ?? "—"}`}
          icon={ClockIcon} accent="blue"
        />
        <StatCard
          title="Entropy Pool"
          value={pool?.entropyAvailable ? "Available" : "Empty"}
          sub={`Round ${pool?.currentRound ?? "—"}`}
          icon={pool?.entropyAvailable ? CheckCircleIcon : ExclamationTriangleIcon}
          accent={pool?.entropyAvailable ? "green" : "yellow"}
        />
        <StatCard
          title="Requests Served"
          value={pool?.totalRequestsServed.toLocaleString() ?? "—"}
          sub={`+${pool?.totalGameSeeds.toLocaleString() ?? "—"} game seeds`}
          icon={BoltIcon} accent="purple"
        />
        <StatCard
          title="Current Slot"
          value={currentSlot.toLocaleString()}
          sub="X1 mainnet"
          icon={ClockIcon} accent="blue"
        />
      </div>

      {/* Protocol Details */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-4">Protocol Configuration</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[
            { label: "Program ID", value: "BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R", mono: true },
            { label: "EE V4 Program", value: "FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm", mono: true },
            { label: "Authority", value: config ? config.authority : "—", mono: true },
            { label: "Request Fee", value: `${REQUEST_FEE_LAMPORTS / 1e9} XNT` },
            { label: "Game Seed Fee", value: `${GAME_SEED_FEE_LAMPORTS / 1e9} XNT` },
            { label: "Slot Duration", value: `${SLOT_DURATION_MS}ms (~2.67 slots/s)` },
            { label: "EE V4 Binding Delay", value: "~675 slots (~4.2 min)" },
            { label: "Pool Staleness Limit", value: "21,600 slots (~2.25 hr)" },
            { label: "Fee Split", value: "90% validators / 10% insurance" },
          ].map(({ label, value, mono }) => (
            <div key={label} className="p-3 bg-surface-elevated rounded-lg">
              <p className="text-xs text-text-muted">{label}</p>
              <p className={`text-sm font-medium text-text-primary mt-0.5 truncate ${mono ? "font-mono" : ""}`}>{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Entropy snapshot */}
      {pool?.entropyAvailable && (
        <div className="card">
          <h2 className="text-lg font-semibold text-text-primary mb-3">Current Entropy Snapshot</h2>
          <div className="space-y-3">
            <div className="p-3 bg-surface-elevated rounded-lg">
              <p className="text-xs text-text-muted mb-1">Pool Entropy (hex) — round {pool.currentRound}</p>
              <p className="font-mono text-xs text-text-primary break-all select-all">{pool.currentEntropy}</p>
            </div>
            <div className="flex gap-2 flex-wrap text-xs text-text-muted">
              <span>Last aggregated slot: <strong className="text-text-primary">{pool.lastAggregatedSlot.toLocaleString()}</strong></span>
              <span>·</span>
              <span>EE V4 entropy included: <strong className="text-text-primary">{pool.eeV4EntropyIncluded ? "yes" : "no"}</strong></span>
            </div>
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 space-y-1">
              <p className="font-semibold">What is this?</p>
              <p>
                This is the <strong>accumulated source entropy</strong> for the current round — a SHA-256 chain of RANDAO slot hashes mixed with EE V4 VDF output.
                It is <em>not</em> directly usable randomness for a dApp.
              </p>
              <p>
                Every randomness request gets a <strong>unique, isolated output</strong>: <code className="font-mono bg-blue-100 px-1 rounded">SHA256(pool_entropy ‖ request_id ‖ slot_hash)</code>.
                The slot hash at inclusion time is unknown at submission — outputs are unpredictable even if pool entropy is public.
                Two dApps requesting in the same round receive completely different values.
              </p>
              <p className="text-blue-600">
                dApps never read this value directly — they receive their output via the <code className="font-mono bg-blue-100 px-1 rounded">RequestState</code> PDA or a CPI callback.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* V4 Feature Highlights */}
      <div className="card">
        <h2 className="text-lg font-semibold text-text-primary mb-4">V4 Features</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            { icon: ShieldCheckIcon, title: "Fully Permissionless", desc: "No keeper authority. advance_round, finalize_via_ee, aggregate_from_ee, and distribute_fees are all open cranks any wallet can call." },
            { icon: BoltIcon, title: "On-Chain Validator Selection", desc: "commit_via_ee eligibility is derived from pool entropy — no external actor can control who participates in a round." },
            { icon: CubeIcon, title: "Per-Validator Rewards", desc: "Both request fees and game seed fees flow to validators. 90% split by reveal_count via claim_validator_reward; 10% to insurance." },
            { icon: CheckCircleIcon, title: "Liveness Protection", desc: "refund_request lets users recover fees if an EE V4 round is cancelled. Validators who miss reveals forfeit their 0.01 XNT stake." },
          ].map(({ icon: Icon, title, desc }) => (
            <div key={title} className="flex gap-3 p-3 bg-surface-elevated rounded-lg">
              <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                <Icon className="h-5 w-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-text-primary text-sm">{title}</p>
                <p className="text-xs text-text-secondary mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
