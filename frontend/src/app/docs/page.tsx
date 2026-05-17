"use client";

import React from "react";
import Link from "next/link";
import {
  BoltIcon,
  ShieldCheckIcon,
  CubeIcon,
  ClockIcon,
  ServerIcon,
  DocumentTextIcon,
  QuestionMarkCircleIcon,
  CurrencyDollarIcon,
} from "@heroicons/react/24/outline";
import { PROGRAM_ID, REQUEST_FEE_LAMPORTS, GAME_SEED_FEE_LAMPORTS, EE_V4_STAKE_LAMPORTS, FEE_VALIDATORS_PCT, FEE_INSURANCE_PCT, STALENESS_HARD_LIMIT_SLOTS } from "@/lib/constants";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-xl font-semibold text-text-primary mb-4 border-b border-border pb-2">{title}</h2>
      <div className="space-y-3 text-sm text-text-secondary leading-relaxed">{children}</div>
    </section>
  );
}

function Code({ children }: { children: string }) {
  return <code className="bg-surface-elevated border border-border px-1.5 py-0.5 rounded text-text-primary font-mono text-xs">{children}</code>;
}

function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <div>
      {label && <p className="text-xs text-text-muted mb-1">{label}</p>}
      <pre className="bg-surface-elevated border border-border rounded-lg p-4 overflow-x-auto text-sm font-mono text-text-primary whitespace-pre-wrap">{children}</pre>
    </div>
  );
}

export default function DocsPage() {
  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-text-primary">Documentation</h1>
        <p className="mt-1 text-text-secondary">
          X1 Randomness Protocol V4 — on-demand verifiable randomness on X1 Mainnet
        </p>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-10">
        {[
          { href: "/request", icon: BoltIcon, title: "Request Randomness", sub: "On-chain entropy + game seeds" },
          { href: "/dapps", icon: CubeIcon, title: "dApp Registration", sub: "Register for callbacks & fee overrides" },
          { href: "/rounds", icon: ClockIcon, title: "Round History", sub: "EE V4 commit/reveal lifecycle" },
          { href: "/validators", icon: ServerIcon, title: "Validators & Rewards", sub: "Earn fees by contributing entropy" },
        ].map(({ href, icon: Icon, title, sub }) => (
          <Link key={href} href={href} className="card flex items-center gap-3 hover:border-primary/30 transition-colors">
            <div className="p-2 rounded-lg bg-primary/10 shrink-0"><Icon className="h-5 w-5 text-primary" /></div>
            <div>
              <p className="font-medium text-text-primary">{title}</p>
              <p className="text-sm text-text-secondary">{sub}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="space-y-10">

        {/* Overview */}
        <Section id="overview" title="Overview">
          <p>
            The <strong className="text-text-primary">X1 Randomness Protocol V4</strong> provides on-demand,
            verifiable randomness on X1 Mainnet. It wraps the EntropyEngine V4 commit/reveal scheme with a
            fully permissionless, decentralised architecture: no keeper authority, no committee manager —
            validators self-select based on on-chain entropy-derived eligibility.
          </p>
          <p>
            Every randomness output is deterministic and auditable:{" "}
            <Code>SHA256(pool_entropy ‖ request_id ‖ slot_hash)</Code>. The slot hash at transaction inclusion
            time is unknown at submission, making outputs unpredictable even if pool entropy is public.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
            {[
              { label: "Program ID", value: PROGRAM_ID, mono: true },
              { label: "EE V4 Program", value: "FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm", mono: true },
              { label: "Network", value: "X1 Mainnet (RPC: rpc.mainnet.x1.xyz)", mono: false },
            ].map(({ label, value, mono }) => (
              <div key={label} className="p-3 bg-surface-elevated rounded-lg border border-border">
                <p className="text-xs text-text-muted">{label}</p>
                <p className={`text-xs font-medium text-text-primary mt-0.5 break-all ${mono ? "font-mono" : ""}`}>{value}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Architecture */}
        <Section id="architecture" title="Architecture">
          <p>The protocol has two layers:</p>
          <div className="space-y-2 mt-1">
            {[
              {
                title: "Randomness Wrapper (this program)",
                desc: "Tracks protocol rounds (WrapperRound PDAs), collects request fees into FeeEscrow accounts, records validator reveals (ValidatorReveal PDAs), and manages fee distribution to validators.",
              },
              {
                title: "EntropyEngine V4 (external program, CPI)",
                desc: "Runs the commit/reveal cycle. Validators (n=2 currently; grows with validator set) stake 0.01 XNT each, commit a hashed secret before commit_deadline (~200 slots), then reveal before reveal_deadline (~600 slots). After the binding slot (~675 slots / ~4.2 min), finalize_via_ee produces entropy_output.",
              },
            ].map(({ title, desc }) => (
              <div key={title} className="p-3 bg-surface-elevated rounded-lg border border-border">
                <p className="font-medium text-text-primary">{title}</p>
                <p className="mt-1">{desc}</p>
              </div>
            ))}
          </div>
          <p className="mt-2">
            The wrapper calls EE V4 via CPI for <Code>commit_via_ee</Code>, <Code>reveal_via_ee</Code>,
            and <Code>finalize_via_ee</Code>. After finalization, <Code>aggregate_from_ee</Code> mixes
            the EE V4 entropy output with the latest SlotHash into the protocol's EntropyPool.
          </p>
        </Section>

        {/* Round Lifecycle */}
        <Section id="lifecycle" title="Round Lifecycle">
          <p>Each protocol round maps to one EE V4 commit/reveal cycle:</p>
          <div className="space-y-2 mt-2">
            {[
              { n: "1", color: "bg-blue-50 border-blue-200", label: "commit_via_ee", desc: "Validators stake 0.01 XNT and submit a hashed secret before commit_deadline (~200 slots after round init). Currently n=2 validators per round (grows with validator set; EE V4 max is 10)." },
              { n: "2", color: "bg-yellow-50 border-yellow-200", label: "reveal_via_ee", desc: "After commit_deadline (~200 slots) and before reveal_deadline (~600 slots), validators reveal their secret. This creates a ValidatorReveal PDA recording participation. The 0.01 XNT stake is returned on valid reveal." },
              { n: "3", color: "bg-green-50 border-green-200", label: "finalize_via_ee + aggregate_from_ee", desc: "Any signer calls finalize_via_ee to mark the EE V4 round done, then aggregate_from_ee to mix entropy into the pool: SHA256(ee_output ‖ slot_hash). Both are permissionless cranks. EntropyPool is now warm." },
              { n: "4", color: "bg-purple-50 border-purple-200", label: "distribute_fees", desc: "Permissionless crank. Takes 10% insurance cut, records original_fees on the FeeEscrow, marks fee_distributed = true. Validators can now claim their share." },
              { n: "5", color: "bg-orange-50 border-orange-200", label: "claim_validator_reward", desc: "Each validator calls this once per round to receive: original_fees × 90% ÷ reveal_count. Requires the ValidatorReveal PDA created at reveal time." },
            ].map(({ n, color, label, desc }) => (
              <div key={n} className={`flex gap-4 p-3 rounded-lg border ${color}`}>
                <div className="w-6 h-6 rounded-full bg-white border border-current flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">{n}</div>
                <div>
                  <p className="font-medium text-text-primary font-mono text-xs">{label}</p>
                  <p className="mt-0.5">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Instructions */}
        <Section id="instructions" title="Program Instructions">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-border rounded-lg">
              <thead>
                <tr className="bg-surface-elevated text-text-muted">
                  <th className="text-left py-2 px-3 border-b border-border font-medium">Instruction</th>
                  <th className="text-left py-2 px-3 border-b border-border font-medium">Description</th>
                  <th className="text-left py-2 px-3 border-b border-border font-medium">Who calls</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["initialize", "Create ProtocolConfig + EntropyPool PDAs", "Authority (once)"],
                  ["advance_round", "Increment current_round, create WrapperRound PDA", "Anyone (permissionless)"],
                  ["create_fee_escrow", "Create FeeEscrow PDA for a round (must precede first request)", "Anyone"],
                  ["init_ee_round", "Open next EE V4 round (id must be current+1; n/m/binding_slot are protocol constants, not caller args)", "Any registered active validator"],
                  ["commit_via_ee", "Stake 0.01 XNT + commit hashed secret; eligibility derived on-chain from pool entropy", "Validator (entropy-selected)"],
                  ["reveal_via_ee", "Reveal secret (≥675 slots after init), creates ValidatorReveal PDA", "Validator"],
                  ["finalize_via_ee", "Finalize the EE V4 round via CPI", "Anyone (permissionless)"],
                  ["aggregate_from_ee", "Mix EE V4 entropy + SlotHash into EntropyPool", "Anyone (permissionless)"],
                  ["request_randomness", `Request entropy output (${REQUEST_FEE_LAMPORTS / 1e9} XNT standard fee; premium dApps pay more)`, "Any wallet / dApp"],
                  ["game_seed", `Fast cheap seed from pool (${GAME_SEED_FEE_LAMPORTS / 1e9} XNT fee, warm pool only). Fee flows to validators.`, "Any wallet"],
                  ["distribute_fees", "Take 10% insurance cut; enable validator claims", "Anyone (permissionless)"],
                  ["claim_validator_reward", "Claim per-validator share from FeeEscrow", "Validator"],
                  ["deliver_callback", "CPI-call the dApp's callback program with entropy output", "Keeper/crank (must sign)"],
                  ["register_dapp", "Register dApp PDA for callbacks", "Any wallet"],
                  ["unregister_dapp", "Close dApp PDA, reclaim rent", "dApp authority"],
                  ["set_fee", "Update protocol-wide request fee", "Authority"],
                  ["update_dapp_fee", "Set per-dApp fee override (0 = use protocol default)", "Protocol authority"],
                  ["refund_request", "Refund fee if EE V4 round was cancelled (status = 3)", "Requester"],
                  ["close_request", "Close fulfilled RequestState PDA and reclaim rent", "Requester"],
                  ["verify_entropy", "Verify a fulfilled RequestState's output matches receipt", "Anyone"],
                ].map(([instr, desc, who]) => (
                  <tr key={instr} className="border-b border-border/50 hover:bg-surface-elevated/50">
                    <td className="py-2 px-3 font-mono text-primary">{instr}</td>
                    <td className="py-2 px-3 text-text-secondary">{desc}</td>
                    <td className="py-2 px-3 text-text-muted">{who}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Accounts */}
        <Section id="accounts" title="Account Types & Field Offsets">
          <p>All accounts use 8-byte Anchor discriminators at offset 0. Raw deserialization offsets:</p>
          <div className="space-y-4 mt-2">
            {[
              {
                name: "ProtocolConfig",
                size: "113 bytes",
                fields: [
                  ["8–39", "authority", "Pubkey"],
                  ["40–71", "insurance_fund", "Pubkey"],
                  ["72–79", "current_round", "u64"],
                  ["80–87", "current_round_start_slot", "u64"],
                  ["88–95", "ee_v4_round_id", "u64"],
                  ["96–103", "total_rounds", "u64"],
                  ["104–111", "request_fee", "u64 (lamports)"],
                  ["112", "bump", "u8"],
                ],
              },
              {
                name: "EntropyPool",
                size: "67 bytes",
                fields: [
                  ["8–39", "current_entropy", "[u8; 32] (hex)"],
                  ["40–47", "current_round", "u64"],
                  ["48", "entropy_available", "bool"],
                  ["49–56", "last_aggregated_slot", "u64"],
                  ["57–64", "total_requests_served", "u64"],
                  ["65", "ee_v4_entropy_included", "bool"],
                  ["66", "bump", "u8"],
                ],
              },
              {
                name: "WrapperRound",
                size: "87 bytes",
                fields: [
                  ["8–15", "round", "u64"],
                  ["16–23", "ee_v4_round_id", "u64"],
                  ["24–31", "start_slot", "u64"],
                  ["32", "aggregated", "bool"],
                  ["33–40", "aggregated_slot", "u64"],
                  ["41–72", "entropy_output", "[u8; 32]"],
                  ["73–76", "pending_requests", "u32"],
                  ["77–84", "total_fees", "u64"],
                  ["85", "ee_v4_entropy_included", "bool"],
                  ["86", "bump", "u8"],
                ],
              },
              {
                name: "FeeEscrow",
                size: "42 bytes",
                fields: [
                  ["8–15", "pending_fees", "u64 (lamports)"],
                  ["16–23", "round", "u64"],
                  ["24–31", "original_fees", "u64 — total before insurance cut"],
                  ["32–39", "ee_v4_round_id", "u64 — EE V4 round that services this protocol round"],
                  ["40", "fee_distributed", "bool"],
                  ["41", "bump", "u8"],
                ],
              },
              {
                name: "DappRegistration",
                size: "145 bytes",
                fields: [
                  ["8–39", "dapp_id", "Pubkey (PDA seed)"],
                  ["40–71", "callback_program", "Pubkey"],
                  ["72–79", "callback_instruction", "[u8; 8] discriminator"],
                  ["80–87", "min_round_interval", "u64"],
                  ["88–95", "last_served_round", "u64"],
                  ["96–103", "total_requests", "u64"],
                  ["104–135", "authority", "Pubkey"],
                  ["136–143", "fee_override", "u64 (0 = protocol default)"],
                  ["144", "bump", "u8"],
                ],
              },
              {
                name: "ValidatorReveal",
                size: "82 bytes",
                fields: [
                  ["8–39", "contributor", "Pubkey"],
                  ["40–71", "ee_round", "Pubkey"],
                  ["72–79", "protocol_round", "u64"],
                  ["80", "claimed", "bool"],
                  ["81", "bump", "u8"],
                ],
              },
              {
                name: "ValidatorRegistration",
                size: "139 bytes",
                fields: [
                  ["8–39", "identity", "Pubkey (validator identity key)"],
                  ["40–71", "vote_account", "Pubkey"],
                  ["72–103", "stake_account", "Pubkey"],
                  ["104–111", "verified_stake", "u64 (lamports) — re-verified on each refresh"],
                  ["112–119", "registered_slot", "u64"],
                  ["120–127", "last_active_slot", "u64 — updated on successful commit"],
                  ["128–135", "last_round_participated", "u64"],
                  ["136", "consecutive_misses", "u8 — 3+ triggers deactivation"],
                  ["137", "active", "bool"],
                  ["138", "bump", "u8"],
                ],
              },
              {
                name: "RequestState",
                size: "202 bytes",
                fields: [
                  ["8–39", "request_id", "[u8; 32]"],
                  ["40–71", "requester", "Pubkey"],
                  ["72–103", "seed", "[u8; 32]"],
                  ["104–135", "callback_program", "Pubkey"],
                  ["136–143", "callback_instruction", "[u8; 8] discriminator"],
                  ["144–151", "round", "u64"],
                  ["152", "fulfilled", "bool"],
                  ["153–184", "output", "[u8; 32]"],
                  ["185–192", "fee_paid", "u64"],
                  ["193–200", "created_slot", "u64"],
                  ["201", "bump", "u8"],
                ],
              },
            ].map(({ name, size, fields }) => (
              <div key={name} className="border border-border rounded-lg overflow-hidden">
                <div className="bg-surface-elevated px-3 py-2 flex items-center justify-between">
                  <span className="font-mono font-medium text-text-primary">{name}</span>
                  <span className="text-xs text-text-muted">{size}</span>
                </div>
                <table className="w-full text-xs">
                  <tbody>
                    {fields.map(([offset, field, type]) => (
                      <tr key={field} className="border-t border-border/50">
                        <td className="py-1.5 px-3 font-mono text-text-muted w-20">{offset}</td>
                        <td className="py-1.5 px-3 font-mono text-primary">{field}</td>
                        <td className="py-1.5 px-3 text-text-secondary">{type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </Section>

        {/* PDAs */}
        <Section id="pdas" title="PDA Seeds">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border border-border rounded-lg">
              <thead>
                <tr className="bg-surface-elevated text-text-muted">
                  <th className="text-left py-2 px-3 border-b border-border font-medium">Account</th>
                  <th className="text-left py-2 px-3 border-b border-border font-medium">Seeds</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["ProtocolConfig", `["protocol-config"]`],
                  ["EntropyPool", `["entropy-pool"]`],
                  ["WrapperRound", `["wrapper-round", round_as_u64_le]`],
                  ["FeeEscrow", `["fee-escrow", round_as_u64_le]`],
                  ["DappRegistration", `["dapp", dapp_id_pubkey]`],
                  ["ValidatorRegistration", `["val-reg", identity_pubkey]`],
                  ["ValidatorReveal", `["validator-reveal", ee_round_pubkey, contributor_pubkey]`],
                  ["RequestState", `["request", requester_pubkey, seed_bytes_32]`],
                ].map(([name, seeds]) => (
                  <tr key={name} className="border-b border-border/50">
                    <td className="py-2 px-3 font-mono text-primary">{name}</td>
                    <td className="py-2 px-3 font-mono text-text-secondary">{seeds}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Fee Economics */}
        <Section id="fees" title="Fee Economics">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { label: "Standard request fee", value: `${REQUEST_FEE_LAMPORTS / 1e9} XNT per request` },
              { label: "Premium request fee", value: "0.05 XNT per request (set by protocol authority via update_dapp_fee)" },
              { label: "Game seed fee", value: `${GAME_SEED_FEE_LAMPORTS / 1e9} XNT — flows to validators just like request fees` },
              { label: "EE V4 commit stake", value: `${EE_V4_STAKE_LAMPORTS / 1e9} XNT (returned on valid reveal)` },
              { label: "Validator share", value: `${FEE_VALIDATORS_PCT}% of round fees ÷ reveal_count` },
              { label: "Insurance fund", value: `${FEE_INSURANCE_PCT}% via distribute_fees` },
            ].map(({ label, value }) => (
              <div key={label} className="p-3 bg-surface-elevated rounded-lg border border-border">
                <p className="text-xs text-text-muted">{label}</p>
                <p className="font-medium text-text-primary mt-0.5">{value}</p>
              </div>
            ))}
          </div>
          <p className="mt-2">
            <strong className="text-text-primary">All fees — both randomness requests and game seeds — flow into the FeeEscrow PDA</strong> for the current round.
            After <Code>distribute_fees</Code> runs, <Code>original_fees</Code> is recorded and <Code>fee_distributed = true</Code>.
            Each validator who called <Code>reveal_via_ee</Code> in that round can then call <Code>claim_validator_reward</Code>{" "}
            to receive <Code>original_fees × 90% ÷ reveal_count</Code>. The remaining 10% goes to the insurance fund.
          </p>
        </Section>

        {/* SDK Integration */}
        <Section id="sdk" title="SDK Integration">
          <p>Use <Code>@solana/web3.js</Code> directly — no Anchor IDL required. All account data is raw-deserialized.</p>
          <CodeBlock label="Read the entropy pool">{`import { Connection, PublicKey } from "@solana/web3.js";

const connection = new Connection("https://rpc.mainnet.x1.xyz", "confirmed");
const PROGRAM_ID = new PublicKey("${PROGRAM_ID}");

// EntropyPool PDA
const [poolPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("entropy-pool")],
  PROGRAM_ID
);

const info = await connection.getAccountInfo(poolPda, "confirmed");
const d = Buffer.from(info.data);
const entropyHex = d.slice(8, 40).toString("hex");          // 32 bytes @ offset 8
const currentRound = Number(d.readBigUInt64LE(40));
const entropyAvailable = d[48] !== 0;
const lastAggregatedSlot = Number(d.readBigUInt64LE(49));`}</CodeBlock>
          <CodeBlock label="Build a request_randomness transaction">{`import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";

const DISC_REQUEST = Buffer.from([213, 5, 173, 166, 37, 236, 31, 18]);  // sha256("global:request_randomness")[:8]

// Derive PDAs
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("protocol-config")], PROGRAM_ID);
const [poolPda]   = PublicKey.findProgramAddressSync([Buffer.from("entropy-pool")], PROGRAM_ID);
const [escrowPda] = PublicKey.findProgramAddressSync([Buffer.from("fee-escrow"), u64le(currentRound)], PROGRAM_ID);
const [wrapperRoundPda] = PublicKey.findProgramAddressSync([Buffer.from("wrapper-round"), u64le(currentRound)], PROGRAM_ID);
const [requestPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("request"), requesterPubkey.toBuffer(), seedBytes32],
  PROGRAM_ID
);

const callbackProgram = new PublicKey("11111111111111111111111111111111"); // SystemProgram = no callback
const callbackInstruction = Buffer.alloc(8, 0);
const data = Buffer.concat([DISC_REQUEST, seedBytes32, callbackProgram.toBuffer(), callbackInstruction]);

const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: requestPda,      isSigner: false, isWritable: true },
    { pubkey: requesterPubkey, isSigner: true,  isWritable: true },
    { pubkey: configPda,       isSigner: false, isWritable: false },
    { pubkey: poolPda,         isSigner: false, isWritable: true },
    { pubkey: escrowPda,       isSigner: false, isWritable: true },
    { pubkey: wrapperRoundPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});`}</CodeBlock>
          <CodeBlock label="Poll for fulfillment (RequestState.fulfilled @ offset 152)">{`async function pollFulfillment(requestPda, connection, maxAttempts = 60) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const info = await connection.getAccountInfo(requestPda, "confirmed");
    if (!info || info.data.length < 202) continue;
    const d = Buffer.from(info.data);
    if (d[152]) {  // fulfilled = true
      const output = d.slice(153, 185).toString("hex");
      return output;
    }
  }
  return null;
}`}</CodeBlock>
        </Section>

        {/* Validator Daemon */}
        <Section id="keeper" title="Running a Validator Node">
          <p>
            As of V4, the full round lifecycle is <strong className="text-text-primary">permissionless and validator-driven</strong>.
            No protocol authority needs to act. Any X1 validator with a funded keypair can:
          </p>
          <div className="space-y-2 mt-2">
            {[
              { n: "1", title: "Start the next round", body: `Call advance_round + create_fee_escrow (permissionless, any signer), then init_ee_round(ee_round_id = current+1). n, m, and binding_slot are protocol constants — not caller args. First validator to land init_ee_round opens the commit window.` },
              { n: "2", title: "Commit", body: `Call commit_via_ee(SHA256(secret || nonce || pubkey)) before commit_deadline (~200 slots). Stake ${EE_V4_STAKE_LAMPORTS / 1e9} XNT. Currently n=2 validators per round (EE V4 max is 10).` },
              { n: "3", title: "Reveal", body: "After commit_deadline (~200 slots) and before reveal_deadline (~600 slots / ~3.75 min), call reveal_via_ee(secret, nonce). Stake is returned. Creates a ValidatorReveal PDA for fee claiming." },
              { n: "4", title: "Finalize + aggregate", body: "Call finalize_via_ee (permissionless), then aggregate_from_ee. Pool is now warm — queued requests are fulfilled." },
              { n: "5", title: "Claim reward", body: "Call distribute_fees (permissionless), then claim_validator_reward. Receive original_fees × 90% ÷ reveal_count." },
            ].map(({ n, title, body }) => (
              <div key={n} className="flex gap-3 p-3 bg-surface-elevated rounded-lg border border-border">
                <div className="w-6 h-6 rounded-full bg-primary/10 text-primary font-bold text-xs flex items-center justify-center shrink-0 mt-0.5">{n}</div>
                <div>
                  <p className="font-medium text-text-primary text-sm">{title}</p>
                  <p className="mt-0.5 text-xs">{body}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3">
            The only coordination needed is off-chain: validators watch for new <Code>init_ee_round</Code> transactions
            (or check whether <Code>ProtocolConfig.ee_v4_round_id</Code> has a corresponding non-aggregated WrapperRound)
            and commit before the <Code>commit_deadline</Code> set in the EE V4 round.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
            {[
              { k: "Validators per round", v: "n=2 (wrapper config; EE V4 hardcoded max is 10)" },
              { k: "Minimum reveal threshold", v: "m=2 (enforced by wrapper, prevents solo runs)" },
              { k: "Commit stake", v: `${EE_V4_STAKE_LAMPORTS / 1e9} XNT (returned on valid reveal)` },
              { k: "Binding slot minimum", v: "675 slots (~4.2 min after round init)" },
              { k: "Slash on non-reveal", v: `${EE_V4_STAKE_LAMPORTS / 1e9} XNT forfeited to EE V4 slash pool` },
              { k: "Reward per round", v: "original_fees × 90% ÷ reveal_count" },
            ].map(({ k, v }) => (
              <div key={k} className="p-3 bg-surface-elevated rounded-lg border border-border">
                <p className="text-xs text-text-muted">{k}</p>
                <p className="font-medium text-text-primary mt-0.5">{v}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Security */}
        <Section id="security" title="Security Properties">
          <div className="space-y-2">
            {[
              {
                title: "EE V4 program pinned",
                desc: `All four CPI instructions enforce address == FDyWtM9U... Cannot pass a counterfeit EE V4 program.`,
              },
              {
                title: "init_ee_round: sequential ID + constants-only params",
                desc: "ee_round_id must equal current+1 (prevents ID jumping). n_contributors, m_threshold, and binding_slot are hardcoded protocol constants — no caller can override committee size or threshold. Permissionless but fully constrained.",
              },
              {
                title: "On-chain validator selection",
                desc: "commit_via_ee enforces entropy-derived eligibility: SHA256(pool_entropy ‖ ee_round_id) → SHA256(round_seed ‖ contributor_pubkey) → compare low 8 bytes against COMMIT_SELECTION_THRESHOLD. No external actor can decide who commits.",
              },
              {
                title: "ee_round ownership enforced",
                desc: "finalize_via_ee checks ee_round.owner == EE V4. Prevents fake entropy injection via crafted accounts.",
              },
              {
                title: "SlotHash mixing",
                desc: "Both finalize_via_ee and aggregate_from_ee XOR in the latest SlotHash — not a predictable slot number.",
              },
              {
                title: "distribute_fees is idempotent",
                desc: "Sets fee_distributed = true and rejects if already set. claim_validator_reward requires fee_distributed == true.",
              },
              {
                title: "Pool staleness hard limit",
                desc: `request_randomness rejects pool entropy older than ${STALENESS_HARD_LIMIT_SLOTS.toLocaleString()} slots (~10 min) from the current slot.`,
              },
              {
                title: "Liveness protection",
                desc: "If an EE V4 round is cancelled (status byte 140 == 3), refund_request lets requesters recover their fee from the FeeEscrow.",
              },
            ].map(({ title, desc }) => (
              <div key={title} className="flex gap-3 p-3 bg-surface-elevated rounded-lg border border-border">
                <ShieldCheckIcon className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-text-primary">{title}</p>
                  <p className="mt-0.5">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* FAQ */}
        <Section id="faq" title="FAQ">
          <div className="space-y-3">
            {[
              {
                q: "How fast is a randomness request?",
                a: "Instant if the pool is warm (fast path). Otherwise, your request queues and is fulfilled after the next EE V4 round completes — typically 4–10 minutes.",
              },
              {
                q: "Can a validator bias the output?",
                a: "No. They commit a hash first. The reveal is verified against the commit, so they cannot change their secret after seeing others'. The SlotHash mixes in additional unpredictability no validator controls.",
              },
              {
                q: "What if fewer than the minimum validators reveal?",
                a: "The EE V4 round is cancelled (status = 3). The pool does not update. Requesters can call refund_request to recover their fee.",
              },
              {
                q: "How many validators participate per round?",
                a: "The wrapper sets n_contributors=2 and m_threshold=2 when opening each EE V4 round, meaning exactly 2 validators commit and reveal per round. This matches the current validator set size. EntropyEngine V4 is hardcoded to accept at most 10 contributors per round total. As the validator set grows, n will be increased to match.",
              },
              {
                q: "How do I earn rewards as a validator?",
                a: "Run validator-daemon.js with your identity keypair. It monitors the chain, checks your on-chain entropy-based eligibility each round, commits and reveals autonomously, and calls claim_validator_reward once fees are distributed. Each round pays: original_fees × 90% ÷ reveal_count.",
              },
              {
                q: "What does fee_override do for dApps?",
                a: "The protocol authority (not the dApp) can set a custom per-dApp fee via update_dapp_fee after registration. When a request comes in from that dApp, the override fee is charged instead of the protocol default. 0 means use the protocol default. Higher fees mean larger validator rewards per round, incentivising liveness.",
              },
              {
                q: "How does verify_entropy work?",
                a: "It requires a fulfilled RequestState PDA. The receipt's derived_output is copied from request_state.output — the actual stored value — and confirmed on-chain. Anyone can verify any output permissionlessly.",
              },
            ].map(({ q, a }) => (
              <div key={q} className="p-4 bg-surface-elevated rounded-lg border border-border">
                <p className="font-medium text-text-primary flex items-center gap-2">
                  <QuestionMarkCircleIcon className="h-4 w-4 text-primary shrink-0" />
                  {q}
                </p>
                <p className="mt-1 ml-6">{a}</p>
              </div>
            ))}
          </div>
        </Section>

        {/* Resources */}
        <Section id="resources" title="Resources">
          <div className="space-y-2">
            <a
              href={`https://explorer.x1.xyz/address/${PROGRAM_ID}`}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 text-primary hover:underline"
            >
              <DocumentTextIcon className="h-4 w-4 shrink-0" />
              X1 Randomness Protocol on X1 Explorer
            </a>
            <a
              href="https://explorer.x1.xyz/address/FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm"
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 text-primary hover:underline"
            >
              <DocumentTextIcon className="h-4 w-4 shrink-0" />
              EntropyEngine V4 on X1 Explorer
            </a>
            <a
              href="https://rpc.mainnet.x1.xyz"
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2 text-primary hover:underline"
            >
              <CurrencyDollarIcon className="h-4 w-4 shrink-0" />
              X1 Mainnet RPC
            </a>
          </div>
        </Section>
      </div>
    </div>
  );
}
