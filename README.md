# X1 Randomness Protocol

On-demand verifiable randomness on X1 Mainnet. A fully permissionless, decentralised wrapper around EntropyEngine V4 — no keeper authority, no committee manager. Validators self-select based on on-chain entropy-derived eligibility. dApps get unique, unpredictable outputs with fee collection, game seed support, per-validator rewards, and on-chain verification receipts.

## Deployed Addresses

| Component | Address |
|-----------|---------|
| Randomness Wrapper V4 | `BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R` |
| Entropy Engine V4 | `FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm` |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                  dApp / User                              │
│    request_randomness(seed, callback)  — 0.01 XNT         │
│    game_seed(game_id)                 — 0.001 XNT         │
│                                                           │
│    Fast path: sub-second (entropy pool warm)              │
│    Queue path: waits for next round aggregation           │
└──────────────────┬───────────────────────────────────────┘
                   │ fee → FeeEscrow[current_round]
                   ▼
┌──────────────────────────────────────────────────────────┐
│       Randomness Wrapper V4 (BSKTJp...)                   │
│                                                           │
│  ┌────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ EntropyPool │  │ WrapperRound │  │  FeeEscrow  │      │
│  │ (hot cache) │  │ (EE V4 map)  │  │  per round  │      │
│  └────────────┘  └──────────────┘  └──────────────┘      │
│  ┌────────────────┐  ┌───────────────────────┐           │
│  │ DappRegistration│  │ ValidatorRegistration │           │
│  └────────────────┘  └───────────────────────┘           │
│  ┌──────────────────┐  ┌──────────────────┐              │
│  │  ValidatorReveal │  │   RequestState   │              │
│  └──────────────────┘  └──────────────────┘              │
│                                                           │
│  Request output = SHA256(                                 │
│    pool_entropy,                                         │
│    request_id,                                           │
│    slot_hash,          ← unknown at submission time       │
│  )                                                        │
└──────────────────┬───────────────────────────────────────┘
                   │ CPI (commit/reveal/finalize)
                   ▼
┌──────────────────────────────────────────────────────────┐
│  Entropy Engine V4 (FDyWt...)                             │
│  Immutable · RANDAO + VDF · Perpetual round cycle        │
│  Max 10 contributors per round · SHA256-chain accumulator │
│  Commit stake 0.01 XNT (returned on valid reveal)        │
└──────────────────────────────────────────────────────────┘
```

## Decentralisation Design

The protocol has **no keeper authority, no committee manager, and no validator selection committee**. Every instruction is either a permissionless crank or self-signed by the actor:

| Instruction | Who calls |
|-------------|-----------|
| `advance_round` | Anyone |
| `create_fee_escrow` | Anyone |
| `init_ee_round` | Any registered active validator (first wins; n/m/binding_slot are **protocol constants**, not caller args) |
| `commit_via_ee` | Any validator whose eligibility hash passes the on-chain threshold |
| `reveal_via_ee` | Validators who committed |
| `finalize_via_ee` | Anyone |
| `aggregate_from_ee` | Anyone |
| `distribute_fees` | Anyone |
| `claim_validator_reward` | Each validator independently |

### On-Chain Validator Selection

Eligibility for `commit_via_ee` is derived deterministically from pool entropy — no external actor can control who participates:

```
round_seed = SHA256(entropy_pool.current_entropy ‖ ee_v4_round_id)
val_hash   = SHA256(round_seed ‖ contributor.pubkey)
selector   = val_hash[0..8] as u64
eligible   = selector < COMMIT_SELECTION_THRESHOLD   // currently u64::MAX (all eligible)
```

Lowering `COMMIT_SELECTION_THRESHOLD` as the validator set grows caps expected committee size probabilistically.

### Keeper vs Validator Daemon

| Process | Keys held | Purpose |
|---------|-----------|---------|
| `run-round.js` (crank) | Crank key only | Calls permissionless on-chain cranks. Zero protocol authority. |
| `validator-daemon.js` | Own identity key only | Each validator runs independently. Monitors chain, commits, reveals, claims rewards. |

The crank has no special power — any node can replace it. Stopping the crank delays round advancement but cannot corrupt randomness.

## Complete Round Lifecycle

### 1. Advance the protocol round (permissionless)

```
advance_round()
  → increments protocol_config.current_round
  → creates WrapperRound PDA [b"wrapper-round", new_round]
```

### 2. Create fee escrow for the new round

```
create_fee_escrow(round)
  → creates FeeEscrow PDA [b"fee-escrow", round]
  → must be called before any request_randomness in this round
```

### 3. Initialize an EE V4 round (any registered validator, first wins)

```
init_ee_round(ee_round_id)
  → n=MAX_COMMITTEE_SIZE(10), m=MIN_EE_M_THRESHOLD(2),
    binding_slot=current_slot+EE_V4_MIN_BINDING_SLOTS(675) — all derived on-chain
  → CPIs initialize_round into EE V4
  → creates WrapperRound PDA [b"wrapper-round", ee_round_id]
  → sets protocol_config.ee_v4_round_id = ee_round_id
```

### 4. Validators commit (entropy-selected)

```
commit_via_ee(commitment)
  → on-chain eligibility check: SHA256(pool_entropy ‖ round_id) → SHA256(round_seed ‖ pubkey) < threshold
  → CPIs commit into EE V4
  → transfers 0.01 XNT stake from contributor to EE round account
  → commitment = SHA256(secret ‖ nonce ‖ contributor_pubkey)
```

### 5. Validators reveal

```
reveal_via_ee(secret, nonce)
  → CPIs reveal into EE V4
  → verifies commitment, accumulates entropy via SHA256-chain
  → returns 0.01 XNT stake to contributor
  → creates ValidatorReveal PDA [b"validator-reveal", ee_round, contributor]
```

### 6. Finalize (permissionless)

```
finalize_via_ee()
  → CPIs finalize into EE V4 (binds slot hash, produces entropy_output)
  → mixes: SHA256(ee_entropy ‖ slot_hash) into EntropyPool
  → marks the EE WrapperRound as aggregated
```

### 7. Aggregate into protocol round (permissionless)

```
aggregate_from_ee(protocol_wrapper_round, ee_round)
  → reads finalized EE V4 round (no CPI, just account data)
  → verifies status == Finalized and round_id matches protocol_config.ee_v4_round_id
  → marks the advance_round WrapperRound as aggregated
  → updates EntropyPool — requests can now be fulfilled
```

### 8. Distribute fees (permissionless)

```
distribute_fees()
  → requires protocol WrapperRound.aggregated == true
  → records original_fees = pending_fees on FeeEscrow
  → sends 10% of pending_fees to insurance_fund
  → sets fee_distributed = true (idempotent — rejects on re-entry)
  → 90% stays in FeeEscrow for validators to claim
```

### 9. Claim validator reward

```
claim_validator_reward()
  → requires ValidatorReveal PDA created at reveal time
  → requires fee_escrow.fee_distributed == true
  → reads reveal_count from EE V4 round data at offset 75
  → pays: original_fees × 90% ÷ reveal_count to contributor
  → marks ValidatorReveal.claimed = true (rejects on re-entry)
```

### 10. Request randomness (any time, fast or queue path)

```
request_randomness(seed, callback_program, callback_instruction)
  → transfers fee from requester to FeeEscrow[current_round]
  → Fast path (pool warm): output = SHA256(pool_entropy ‖ request_id ‖ slot_hash) — same tx
  → Queue path (pool cold): stores RequestState PDA, fulfilled after next aggregation
```

## Instructions

### Service Layer

| Instruction | Description | Who |
|-------------|-------------|-----|
| `initialize` | Bootstrap ProtocolConfig + EntropyPool | Authority (once) |
| `register_dapp` | Register dApp with callback and frequency config | Any wallet |
| `unregister_dapp` | Remove dApp registration, reclaim rent | dApp authority |
| `create_fee_escrow(round)` | Create FeeEscrow PDA for a round | Anyone |
| `request_randomness(seed, callback)` | Request entropy — instant if pool warm, queued if cold | Any wallet / dApp |
| `game_seed(game_id)` | Fast seed from pool entropy — warm pool only | Any wallet |
| `advance_round` | Move to next protocol round | Anyone (permissionless) |
| `distribute_fees` | Take 10% insurance cut; record original_fees; enable validator claims | Anyone (permissionless) |
| `claim_validator_reward` | Per-validator fee claim — original_fees × 90% ÷ reveal_count | Validator |
| `set_fee(new_fee)` | Update protocol-wide request fee | Authority |
| `update_dapp_fee(fee_override)` | Set per-dApp fee override, 0 = protocol default | Protocol authority |
| `refund_request` | Refund fee if EE V4 round was cancelled (status byte 140 == 3) | Requester |
| `deliver_callback` | Push entropy via CPI to registered dApp callback | Crank (must sign) |
| `verify_entropy(request_id)` | Create on-chain EntropyReceipt from fulfilled RequestState | Anyone |
| `close_request` | Close fulfilled RequestState, reclaim rent | Requester |
| `register_validator` | Register identity + vote + stake accounts | Validator |
| `deregister_validator` | Remove validator registration | Validator |
| `refresh_validator_status` | Re-verify stake and liveness; reactivate if back online | Validator |

### CPI Layer (delegates to EE V4)

| Instruction | Description |
|-------------|-------------|
| `init_ee_round(ee_round_id)` | Initialize EE V4 round; n/m/binding_slot are protocol constants |
| `commit_via_ee(commitment)` | Validator commits — eligibility derived on-chain; transfers 0.01 XNT stake |
| `reveal_via_ee(secret, nonce)` | Validator reveals — returns stake, accumulates entropy, creates ValidatorReveal PDA |
| `finalize_via_ee` | Finalize EE V4 round + mix entropy (using SlotHashes sysvar) into EntropyPool |
| `aggregate_from_ee` | Read pre-finalized EE V4 round into protocol WrapperRound; requires SlotHashes sysvar |

## Accounts / PDAs

| Account | Seeds | Size | Description |
|---------|-------|------|-------------|
| `ProtocolConfig` | `["protocol-config"]` | 113 B | Global config, authority, current round, EE V4 round tracking |
| `EntropyPool` | `["entropy-pool"]` | 67 B | Hot entropy cache — fast path served from here |
| `WrapperRound` (protocol) | `["wrapper-round", round]` | 87 B | Created by `advance_round`. Tracks pending requests and fees. |
| `WrapperRound` (EE) | `["wrapper-round", ee_round_id]` | 87 B | Created by `init_ee_round`. Tracks EE V4 mapping and aggregation status. |
| `FeeEscrow` | `["fee-escrow", round]` | 42 B | Fee accumulation per protocol round |
| `DappRegistration` | `["dapp", dapp_id]` | 145 B | Per-dApp callback, frequency config, fee override |
| `ValidatorRegistration` | `["val-reg", identity]` | 139 B | Validator identity, vote/stake accounts, liveness tracking |
| `ValidatorReveal` | `["validator-reveal", ee_round, contributor]` | 82 B | Created at reveal time; used to claim per-validator reward |
| `RequestState` | `["request", requester, seed]` | 202 B | Individual randomness request (queue path) |
| `EntropyReceipt` | `["receipt", request_id]` | — | Trustless provenance verification receipt |

## Key Formulas

| Item | Formula |
|------|---------|
| Request ID | `SHA256(callback_program ‖ callback_instruction ‖ seed ‖ requester)` |
| Fast/queue path output | `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` |
| Aggregated entropy | `SHA256(ee_v4_entropy ‖ slot_hash)` |
| EE V4 commitment | `SHA256(secret ‖ nonce ‖ contributor_pubkey)` |
| Game seed output | `SHA256(pool_entropy ‖ game_id)` |
| Validator eligibility | `SHA256(SHA256(pool_entropy ‖ ee_round_id) ‖ contributor_pubkey)[0..8] < COMMIT_SELECTION_THRESHOLD` |
| Per-validator reward | `original_fees × 90% ÷ reveal_count` |

## Economics

| Item | Amount |
|------|--------|
| Standard request fee | 0.01 XNT (default for all dApps) |
| Premium request fee | 0.05 XNT (set by protocol authority via `update_dapp_fee`) |
| Game seed fee | 0.001 XNT — flows to validators via FeeEscrow, same as request fees |
| EE V4 stake (per commit) | 0.01 XNT — returned in full on valid reveal; forfeited on miss |
| Insurance fund | 10% of round fees via `distribute_fees` |
| Validator share | 90% ÷ reveal_count via `claim_validator_reward` |

All fees — both `request_randomness` and `game_seed` — accumulate in the round's `FeeEscrow` PDA and are distributed to validators after each round via `distribute_fees` + `claim_validator_reward`.

## Struct Layouts

### WrapperRound (87 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 8 | `round` (u64) |
| 16 | 8 | `ee_v4_round_id` (u64) |
| 24 | 8 | `start_slot` (u64) |
| 32 | 1 | `aggregated` (bool) |
| 33 | 8 | `aggregated_slot` (u64) |
| 41 | 32 | `entropy_output` ([u8; 32]) |
| 73 | 4 | `pending_requests` (u32) |
| 77 | 8 | `total_fees` (u64) |
| 85 | 1 | `ee_v4_entropy_included` (bool) |
| 86 | 1 | `bump` (u8) |

### FeeEscrow (42 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 8 | `pending_fees` (u64) |
| 16 | 8 | `round` (u64) |
| 24 | 8 | `original_fees` (u64) — total before insurance cut; used for per-validator calc |
| 32 | 8 | `ee_v4_round_id` (u64) — EE V4 round that services this protocol round |
| 40 | 1 | `fee_distributed` (bool) — set by `distribute_fees`; required before `claim_validator_reward` |
| 41 | 1 | `bump` (u8) |

### ValidatorRegistration (139 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 32 | `identity` (Pubkey) |
| 40 | 32 | `vote_account` (Pubkey) |
| 72 | 32 | `stake_account` (Pubkey) |
| 104 | 8 | `verified_stake` (u64) — re-verified on each refresh |
| 112 | 8 | `registered_slot` (u64) |
| 120 | 8 | `last_active_slot` (u64) — updated on successful commit |
| 128 | 8 | `last_round_participated` (u64) |
| 136 | 1 | `consecutive_misses` (u8) — 3+ triggers deactivation |
| 137 | 1 | `active` (bool) |
| 138 | 1 | `bump` (u8) |

### ValidatorReveal (82 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 32 | `contributor` (Pubkey) |
| 40 | 32 | `ee_round` (Pubkey) |
| 72 | 8 | `protocol_round` (u64) |
| 80 | 1 | `claimed` (bool) |
| 81 | 1 | `bump` (u8) |

### DappRegistration (145 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 32 | `dapp_id` (Pubkey) |
| 40 | 32 | `callback_program` (Pubkey) |
| 72 | 8 | `callback_instruction` ([u8; 8]) |
| 80 | 8 | `min_round_interval` (u64) |
| 88 | 8 | `last_served_round` (u64) |
| 96 | 8 | `total_requests` (u64) |
| 104 | 32 | `authority` (Pubkey) |
| 136 | 8 | `fee_override` (u64) — 0 = protocol default |
| 144 | 1 | `bump` (u8) |

### RequestState (202 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 32 | `request_id` ([u8; 32]) |
| 40 | 32 | `requester` (Pubkey) |
| 72 | 32 | `seed` ([u8; 32]) |
| 104 | 32 | `callback_program` (Pubkey) |
| 136 | 8 | `callback_instruction` ([u8; 8]) |
| 144 | 8 | `round` (u64) |
| 152 | 1 | `fulfilled` (bool) |
| 153 | 32 | `output` ([u8; 32]) |
| 185 | 8 | `fee_paid` (u64) |
| 193 | 8 | `created_slot` (u64) |
| 201 | 1 | `bump` (u8) |

### EE V4 Round (838 bytes, cross-program read)

| Offset | Size | Field |
|--------|------|-------|
| 0 | 8 | Anchor discriminator |
| 8 | 32 | `coordinator` (Pubkey) |
| 40 | 8 | `round_id` (u64) |
| 48 | 1 | `n_contributors` (u8) |
| 49 | 1 | `m_threshold` (u8) |
| 50 | 8 | `commit_deadline` (u64) |
| 58 | 8 | `reveal_deadline` (u64) |
| 66 | 8 | `binding_slot` (u64) |
| 74 | 1 | `commit_count` (u8) |
| **75** | **1** | **`reveal_count`** (u8) ← read by `claim_validator_reward` |
| 76 | 32 | `entropy_accumulator` ([u8; 32]) |
| **108** | **32** | **`entropy_output`** ([u8; 32]) ← extracted by wrapper |
| **140** | **1** | **`status`** (Finalized=2, Cancelled=3) ← verified by wrapper |
| 141 | 8 | `slash_pool` (u64) |
| 149 | 8 | `finalized_slot` (u64) |
| 157 | 1 | `bump` (u8) |
| 158 | 680 | `contributors[10]` |

## Build

Requires Solana platform-tools v1.52.

```bash
anchor build -- --tools-version v1.52
```

IDL generation emits a version mismatch warning (anchor-lang 0.30.1 vs anchor-cli 0.31.0). The `.so` compiles correctly regardless.

**If Cargo.lock is regenerated**, re-pin these crates immediately:

```bash
cargo update -p "proc-macro-crate" --precise 3.2.0
cargo update -p blake3 --precise 1.7.0
```

## Deploy / Upgrade

```bash
solana program deploy \
  target/deploy/randomness_wrapper.so \
  --keypair ~/.config/solana/x1randomness-key.json \
  --program-id target/deploy/randomness_wrapper-keypair.json \
  --url https://rpc.mainnet.x1.xyz
```

Check balance before deploying (~1.25–1.5 XNT per upgrade):

```bash
solana balance ~/.config/solana/x1randomness-key.json --url https://rpc.mainnet.x1.xyz
```

## Test

End-to-end mainnet test suite (runs against live program, requires funded payer):

```bash
npm install          # first time only
node tests/mainnet-e2e.js
```

Tests 21 instructions in sequence. The EE V4 commit/reveal/finalize cycle waits ~4–5 minutes for the binding slot (automatic, with progress output).

## Running a Validator

```bash
cd keeper && npm install

# Register your validator (one-time)
node run-round.js --register

# Run your personal validator daemon (holds only your identity key)
VALIDATOR_KEYPAIR=/path/to/identity.json node validator-daemon.js --loop

# Optionally run the permissionless crank (anyone can run this)
node run-round.js --loop
```

Requirements: ≥1,000 XNT delegated stake, active vote account voting within 500 slots.

## Security Model

### EE V4 Program Identity
All four CPI instructions enforce `ee_v4_program.key() == ENTROPY_ENGINE_V4`. Passing a stub program is rejected.

### EE Round Account Ownership
`finalize_via_ee` and `aggregate_from_ee` require `ee_round.owner == &ENTROPY_ENGINE_V4`. A crafted account at an arbitrary address cannot inject entropy.

### Sequential Round ID
`init_ee_round` requires `ee_round_id == protocol_config.ee_v4_round_id + 1`. ID jumping and round hijacking are rejected.

### Protocol Constants (not caller args)
`n_contributors`, `m_threshold`, and `binding_slot` in `init_ee_round` are derived from protocol constants — no caller can override committee size, threshold, or timing.

### On-Chain Validator Selection
`commit_via_ee` enforces entropy-derived eligibility — no external actor decides who participates. Selection is deterministic from pool entropy.

### Slot Hash Mixing
Both `finalize_via_ee` and `aggregate_from_ee` read the current slot hash from the SlotHashes sysvar. Slot hashes are not knowable before the slot completes, resisting output pre-computation.

### Request Output Unpredictability
`request_randomness` output = `SHA256(pool_entropy ‖ request_id ‖ slot_hash)`. The slot hash at inclusion is unknown at submission, so outputs cannot be pre-computed even with known pool entropy.

### Fee Distribution Integrity
`distribute_fees` sets `fee_distributed = true` and rejects re-entry. `claim_validator_reward` requires `fee_distributed == true`. `original_fees` is recorded at distribution time so per-validator shares are correct even as `pending_fees` decreases.

### Single-Claim Guard
`claim_validator_reward` sets `ValidatorReveal.claimed = true` and rejects if already set.

### Cross-Round Refund Protection
`refund_request` verifies `fee_escrow.ee_v4_round_id` matches the EE round's stored ID. Requesters cannot claim refunds from a different round's escrow.

### Liveness Protection
If an EE V4 round is cancelled (status byte 140 == 3), `refund_request` lets requesters recover their fee. Validators who miss reveals forfeit their 0.01 XNT stake to the EE V4 slash pool.

### Staleness Hard Limit
`request_randomness` rejects the fast path when pool entropy is older than 1,500 slots (~10 minutes), routing the request through the queue instead.

### Insurance Fund Separation
`claim_validator_fees` (dust sweep) sends residual lamports to `insurance_fund`, not to the authority's personal wallet.

## Changelog

### V4 (2026-05-16) — fully decentralised

- **Permissionless `init_ee_round`** — any registered active validator can start the next EE V4 round. n/m/binding_slot are now protocol constants, not caller args. Protected by sequential ID requirement.
- **On-chain validator selection** — `commit_via_ee` now enforces entropy-derived eligibility via `COMMIT_SELECTION_THRESHOLD`. No keeper can control who commits.
- **Keeper rewritten as pure crank** — `run-round.js` holds only its own key, has zero protocol authority. Removed `--key2`/`--key3` flags entirely.
- **Validator daemon** — new `validator-daemon.js` for each validator to run independently with their own identity key.
- **Premium fee tier** — 0.05 XNT/request set by protocol authority via `update_dapp_fee`; standard 0.01 XNT remains default.
- **`claim_validator_fees` dust sweep** — recipient changed from `authority` to `insurance_fund`.

### V3 (2026-05-15) — deployed to mainnet

- Per-validator fee rewards via `ValidatorReveal` PDAs and `claim_validator_reward`.
- Game seed fee (0.001 XNT) now flows to validators via FeeEscrow.
- Per-dApp fee override via `update_dapp_fee`.
- `set_fee` instruction for protocol authority.
- Liveness protection: `refund_request` for cancelled rounds.
- FeeEscrow grew from 26 → 34 bytes (`original_fees` added). Later extended to 42 bytes in V4 (`ee_v4_round_id` added).
- Validator registration system: `register_validator`, `deregister_validator`, `refresh_validator_status`.

### V2.2 (2026-05-14) — security audit

- [CRITICAL] `ee_v4_program` address not validated — fixed.
- [CRITICAL] `ee_round` ownership unchecked in `finalize_via_ee` — fixed.
- [CRITICAL] `distribute_fees` re-enterable — fixed with `fee_distributed` flag.
- [HIGH] Slot mixing used `hash(slot_number)` — replaced with SlotHashes sysvar.
- [HIGH] `verify_entropy` created receipts for arbitrary request IDs — fixed.
- [MEDIUM] Stale entropy served indefinitely — `STALENESS_HARD_LIMIT_SLOTS` added.

### V2.1 (2026-05-14)

- Fixed `create_fee_escrow` — FeeEscrow PDA was never initialized.
- Fixed `RequestState::INIT_SPACE` — was 8 bytes too small.
- Fixed `init_ee_round` — `WrapperRound.round` now stores `ee_round_id`.
- Fixed `aggregate_from_ee` — now accepts protocol WrapperRound.

### V2 (2026-05-12)

- Delegated commit/reveal/finalize to EE V4 via CPI.
- Added `WrapperRound`, `aggregate_from_ee`, `claim_validator_fees`.

### V1

- Original single-program architecture with inline committee management.

## License

MIT
