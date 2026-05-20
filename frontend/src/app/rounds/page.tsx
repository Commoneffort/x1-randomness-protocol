"use client";

import React, { useEffect, useState } from "react";
import { ProtocolClient, WrapperRound, FeeEscrow } from "@/lib/protocol";
import { SLOT_DURATION_MS } from "@/lib/constants";

function StatusBadge({ aggregated }: { aggregated: boolean }) {
  return aggregated ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700 border border-green-200">
      <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Aggregated
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200">
      <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" /> Pending
    </span>
  );
}

function EscrowBadge({ escrow }: { escrow: FeeEscrow | null }) {
  if (!escrow) return <span className="text-xs text-text-muted">—</span>;
  if (escrow.feeDistributed) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">
        Distributed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-surface-elevated text-text-secondary border border-border">
      Held
    </span>
  );
}

export default function RoundsPage() {
  const [client] = useState(() => new ProtocolClient());
  const [rounds, setRounds] = useState<WrapperRound[]>([]);
  const [escrows, setEscrows] = useState<Record<number, FeeEscrow | null>>({});
  const [currentSlot, setCurrentSlot] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  const fetchData = async () => {
    const [slot, wrs] = await Promise.all([
      client.connection.getSlot("confirmed"),
      client.getAllWrapperRounds(15),
    ]);
    setCurrentSlot(slot);
    setRounds(wrs);

    // Fetch fee escrows in parallel
    const escrowMap: Record<number, FeeEscrow | null> = {};
    await Promise.all(wrs.map(async wr => {
      escrowMap[wr.round] = await client.getFeeEscrow(wr.round);
    }));
    setEscrows(escrowMap);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const iv = setInterval(fetchData, 5000);
    return () => clearInterval(iv);
  }, [client]);

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
        <h1 className="text-2xl font-bold text-text-primary">Round History</h1>
        <p className="mt-1 text-text-secondary">
          Each protocol round wraps an EntropyEngine V4 commit/reveal cycle and collects randomness fees.
        </p>
      </div>

      {/* Legend */}
      <div className="card">
        <h2 className="text-sm font-semibold text-text-primary mb-3">Round Lifecycle</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm text-text-secondary">
          <div className="flex gap-2 items-start">
            <span className="w-2.5 h-2.5 mt-1 rounded-full bg-yellow-400 shrink-0" />
            <div><strong className="text-text-primary">Pending</strong> — EE V4 round in progress (commit → reveal → finalize)</div>
          </div>
          <div className="flex gap-2 items-start">
            <span className="w-2.5 h-2.5 mt-1 rounded-full bg-green-500 shrink-0" />
            <div><strong className="text-text-primary">Aggregated</strong> — Entropy mixed into pool; distribute_fees can now run</div>
          </div>
          <div className="flex gap-2 items-start">
            <span className="w-2.5 h-2.5 mt-1 rounded-full bg-blue-500 shrink-0" />
            <div><strong className="text-text-primary">Distributed</strong> — 5% to crank taken; validators can claim 95% share</div>
          </div>
        </div>
      </div>

      {rounds.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-text-muted">No rounds found</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rounds.map(wr => {
            const escrow = escrows[wr.round] ?? null;
            const isExpanded = expanded === wr.round;
            const slotAge = currentSlot - wr.startSlot;
            const ageSecs = Math.round(slotAge * SLOT_DURATION_MS / 1000);
            const ageStr = ageSecs < 60 ? `${ageSecs}s ago`
              : ageSecs < 3600 ? `${Math.floor(ageSecs / 60)}m ago`
              : `${Math.floor(ageSecs / 3600)}h ago`;

            return (
              <div key={wr.round} className="card">
                <button
                  onClick={() => setExpanded(isExpanded ? null : wr.round)}
                  className="w-full text-left"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${wr.aggregated ? "bg-green-500" : "bg-yellow-400 animate-pulse"}`} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-text-primary">Round {wr.round}</span>
                          <StatusBadge aggregated={wr.aggregated} />
                          <EscrowBadge escrow={escrow} />
                        </div>
                        <p className="text-xs text-text-muted mt-0.5">
                          EE V4 round {wr.eeV4RoundId || "—"} · started {ageStr}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-right shrink-0">
                      <div className="hidden sm:block">
                        <p className="text-xs text-text-muted">Fees</p>
                        <p className="text-sm font-medium text-text-primary">
                          {escrow ? client.formatXnt(escrow.pendingFees) : "—"} XNT
                        </p>
                      </div>
                      <svg className={`h-4 w-4 text-text-muted transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="mt-4 pt-4 border-t border-border space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <div className="p-3 bg-surface-elevated rounded-lg">
                        <p className="text-xs text-text-muted">Start Slot</p>
                        <p className="font-mono text-sm text-text-primary">{wr.startSlot.toLocaleString()}</p>
                      </div>
                      <div className="p-3 bg-surface-elevated rounded-lg">
                        <p className="text-xs text-text-muted">Aggregated Slot</p>
                        <p className="font-mono text-sm text-text-primary">
                          {wr.aggregated ? wr.aggregatedSlot.toLocaleString() : "—"}
                        </p>
                      </div>
                      <div className="p-3 bg-surface-elevated rounded-lg">
                        <p className="text-xs text-text-muted">EE V4 Round ID</p>
                        <p className="font-mono text-sm text-text-primary">{wr.eeV4RoundId || "—"}</p>
                      </div>
                      {escrow && (
                        <>
                          <div className="p-3 bg-surface-elevated rounded-lg">
                            <p className="text-xs text-text-muted">Total Fees</p>
                            <p className="text-sm text-text-primary">{client.formatXnt(escrow.originalFees || escrow.pendingFees)} XNT</p>
                          </div>
                          <div className="p-3 bg-surface-elevated rounded-lg">
                            <p className="text-xs text-text-muted">Remaining in Escrow</p>
                            <p className="text-sm text-text-primary">{client.formatXnt(escrow.pendingFees)} XNT</p>
                          </div>
                          <div className="p-3 bg-surface-elevated rounded-lg">
                            <p className="text-xs text-text-muted">Fee Status</p>
                            <p className="text-sm text-text-primary">{escrow.feeDistributed ? "Distributed (95% validators + 5% crank)" : "Held (pending distribution)"}</p>
                          </div>
                        </>
                      )}
                    </div>

                    {wr.aggregated && wr.entropyOutput !== "0".repeat(64) && (
                      <div className="p-3 bg-surface-elevated rounded-lg">
                        <p className="text-xs text-text-muted mb-1">Entropy Output (hex)</p>
                        <p className="font-mono text-xs text-text-primary break-all select-all bg-white p-2 rounded border border-border">
                          {wr.entropyOutput}
                        </p>
                      </div>
                    )}

                    <div className="flex gap-3">
                      <a
                        href={`https://explorer.x1.xyz/address/${wr.pubkey}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-xs text-primary hover:underline"
                      >
                        View WrapperRound on Explorer →
                      </a>
                      {escrow && (
                        <a
                          href={`https://explorer.x1.xyz/address/${escrow.pubkey}`}
                          target="_blank" rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline"
                        >
                          View FeeEscrow on Explorer →
                        </a>
                      )}
                      <span className="text-xs text-text-muted">
                        EE V4 entropy included: {wr.eeV4EntropyIncluded ? "yes" : "no"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
