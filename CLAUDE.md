# CLAUDE.md

Guidance for Claude Code working in this repository.

## Build

Use plain `anchor build` — the `--tools-version` flag is no longer supported by the installed `cargo-build-sbf` version and will fail:

```bash
anchor build
```

IDL generation fails with an `anchor-syn` compile error (proc-macro API). This is expected and harmless — the `.so` compiles correctly in the same invocation; ignore the IDL error.

### Cargo.lock pins

If `Cargo.lock` is regenerated for any reason, immediately re-pin:

```bash
cargo update -p "proc-macro-crate@3.2.0" --precise 3.2.0
cargo update -p blake3 --precise 1.7.0
```

Failure to re-pin causes edition2024 compile errors that have nothing to do with the program logic.

## Deploy / Upgrade

```bash
solana program deploy \
  target/deploy/randomness_wrapper.so \
  --keypair ~/.config/solana/x1randomness-key.json \
  --program-id target/deploy/randomness_wrapper-keypair.json \
  --url https://rpc.mainnet.x1.xyz
```

- **Program ID:** `BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R`
- **Deploy/upgrade authority:** `EFZhMW1Y1NFQgaiWATYwpaJ2kaw7aPZbJYfdeZQhXR2F` (`~/.config/solana/x1randomness-key.json`)
- **RPC:** `https://rpc.mainnet.x1.xyz`
- **EE V4:** `FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm`

Each program upgrade costs approximately 1.25–1.5 XNT from the payer wallet. Check balance before upgrading (`solana balance ~/.config/solana/x1randomness-key.json --url https://rpc.mainnet.x1.xyz`).

## Test

```bash
npm install       # first time only
node tests/mainnet-e2e.js
```

The suite runs 21 instructions against the live mainnet program. Budget ~5–10 minutes — the EE V4 commit/reveal cycle waits for a binding slot (~675 slots ≈ 4.2 minutes at X1's ~375ms/slot). The test probes the minimum binding slot automatically (300→450→675) and then polls until the slot passes before finalizing.

## Decentralisation design (V4)

The protocol has **no manager, no keeper authority, and no validator selection committee**. Every instruction is either:
- **Permissionless crank** — callable by any signer when on-chain conditions are met
- **Self-signed by the actor** — validators sign their own commit/reveal; dApps sign their own requests

### Round lifecycle (no central operator)

```
advance_round          — any signer, when MIN_SLOTS_BETWEEN_ROUNDS elapsed
create_fee_escrow      — any signer, for valid round
init_ee_round          — any registered active validator (first wins, pays rent as coordinator)
                         n=MIN_EE_M_THRESHOLD(2), m=MIN_EE_M_THRESHOLD(2),
                         binding_slot=current+EE_V4_MIN_BINDING_SLOTS(675) — derived on-chain
                         NOTE: n was changed from MAX_COMMITTEE_SIZE(10) to MIN_EE_M_THRESHOLD(2)
                         because the EE program requires ALL n validators to commit before
                         transitioning to RevealPhase. With n=10 and <10 validators, rounds
                         can never complete. n=m=2 means both validators fill the round.
commit_via_ee          — any eligible validator (eligibility derived from entropy, not caller choice)
                         must commit BEFORE commit_deadline (EE round offset 50)
reveal_via_ee          — validators who committed; must reveal AFTER commit_deadline (offset 50)
                         and BEFORE reveal_deadline (offset 58). reveal_deadline ≠ binding_slot!
finalize_via_ee        — any signer, AFTER binding_slot (offset 66, not reveal_deadline)
aggregate_from_ee      — any signer, after finalization
distribute_fees        — any signer, after aggregation
claim_validator_reward — each validator claims their own share independently
```

### On-chain validator selection (commit_via_ee)

Eligibility is derived deterministically from pool entropy — no keeper can control who participates:

```
round_seed  = SHA256(entropy_pool.current_entropy ‖ ee_v4_round_id)
val_hash    = SHA256(round_seed ‖ contributor.pubkey)
selector    = val_hash[0..8] as u64
eligible    = selector < COMMIT_SELECTION_THRESHOLD
```

`COMMIT_SELECTION_THRESHOLD = u64::MAX` currently (all active validators eligible). Lower this constant as the validator set grows to cap expected committee size probabilistically.

### Keeper vs validator daemon

| Process | Keys held | Purpose |
|---|---|---|
| `run-round.js` (crank) | Crank key only | Calls permissionless on-chain cranks. Zero protocol authority. |
| `validator-daemon.js` | Own identity key only | Each validator runs independently. Monitors chain, commits, reveals, claims rewards. |

The crank has no special power — any node can replace it. Stopping the crank delays round advancement but cannot corrupt randomness.

**Running the daemons:**
```bash
# Crank — owlx1 server (uses deploy key):
CRANK_KEYPAIR=~/.config/solana/x1randomness-key.json nohup node run-round.js --loop > /tmp/crank.log 2>&1 &

# Crank — xen_cat server (uses identity key, redundant):
CRANK_KEYPAIR=~/.config/solana/identity.json nohup node run-round.js --loop > /tmp/crank.log 2>&1 &

# Validator daemon (one per validator, uses identity key):
VALIDATOR_KEYPAIR=~/.config/solana/identity.json nohup node validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# First-time validator registration:
VALIDATOR_KEYPAIR=~/.config/solana/identity.json node validator-daemon.js --register
```

**Idle gate (V4.3):** Both the crank and validator daemon check before opening any new EE round: if the entropy pool is warm (< 21 600 slots stale) AND there are no unfulfilled `RequestState` accounts on-chain, they idle and re-poll without sending any transactions. A round starts automatically when a queued request appears or the pool goes stale. Running both processes costs nothing when the protocol is idle. The 21 600-slot threshold matches `STALENESS_HARD_LIMIT_SLOTS` and reduces crank cost from ~43 → ~3 XNT/month.

**init_ee_round responsibility**: The validator daemon calls `init_ee_round` (NOT the crank). The daemon gates this call on the current EE round being Finalized (status=2) or Cancelled (status=3) — it will NOT advance to the next EE round while the current one is still in progress. The crank polls for the EE WrapperRound PDA in step 3 and waits for a validator daemon to create it.

## Security constraints (added V2.2 — do not remove)

- **`ee_v4_program`** — all four CPI instructions enforce `address = ENTROPY_ENGINE_V4`. Cannot pass a fake program.
- **`ee_round` ownership** — `finalize_via_ee` enforces `ee_round.owner == ENTROPY_ENGINE_V4`. Prevents fake entropy injection via crafted accounts.
- **`init_ee_round`** — permissionless. Protected by: (1) `ee_round_id` must equal `protocol_config.ee_v4_round_id + 1` (strictly sequential), and (2) n/m/binding_slot are **protocol constants**, not caller-supplied — caller cannot override committee size or threshold.
- **On-chain validator selection** — `commit_via_ee` enforces entropy-derived eligibility. No external actor can decide who commits.
- **Slot hash mixing** — both `finalize_via_ee` and `aggregate_from_ee` read the most-recent hash from the SlotHashes sysvar. SlotHashes account is **required** in both instructions.
- **`request_randomness` output** — `SHA256(pool_entropy ‖ request_id ‖ slot_hash)`. Slot hash is unknown at submission time, preventing pre-computation even with known pool entropy.
- **`fee_distributed` flag** — `distribute_fees` is idempotent. `claim_validator_reward` requires `fee_distributed == true`.
- **`claim_validator_fees` (dust sweep)** — recipient restricted to `insurance_fund`, not authority personal wallet.
- **`verify_entropy`** — requires a fulfilled `RequestState`. `derived_output` copied from stored value, not recomputed.
- **Staleness hard limit** — pool entropy older than `STALENESS_HARD_LIMIT_SLOTS` (21 600 slots ≈ 2.25 hours) routes `request_randomness` to the queue path instead of the fast path. Matches the keeper idle gate threshold.
- **`deliver_callback`** — requires a `caller: Signer` (permissionless crank but must sign).

## Architecture notes

### Two WrapperRound types

There are two distinct WrapperRound PDA types sharing the same seed prefix:

| Creator | Seeds | `round` field | Purpose |
|---------|-------|---------------|---------|
| `advance_round` | `["wrapper-round", protocol_round]` | protocol round number | Tracks pending requests and fees |
| `init_ee_round` | `["wrapper-round", ee_round_id]` | `ee_round_id` | Maps EE V4 round to wrapper |

The protocol WrapperRound's `ee_v4_round_id` field is 0 until `aggregate_from_ee` links them.

### Fee distribution requires two aggregation steps

```
finalize_via_ee()        → marks EE WrapperRound aggregated + warms EntropyPool
aggregate_from_ee()      → marks PROTOCOL WrapperRound aggregated
distribute_fees()        → requires protocol WrapperRound.aggregated == true
```

`distribute_fees` will return `RoundNotAggregatable` if `aggregate_from_ee` has not been called on the protocol WrapperRound after EE finalization.

### Per-validator reward flow (V3)

```
reveal_via_ee()          → creates ValidatorReveal PDA [b"validator-reveal", ee_round, contributor]
distribute_fees()        → records original_fees on FeeEscrow before insurance cut
claim_validator_reward() → pays original_fees × 90% ÷ reveal_count to contributor
                           reads reveal_count from EE V4 round data at offset 75
```

Each validator gets one claim per round. `claim_validator_reward` marks `ValidatorReveal.claimed = true` and rejects if already set.

### EE V4 binding slot minimum

675 slots minimum on X1 mainnet (~4.2 minutes). Error code `0x177d` (`BindingSlotTooSoon`) means the offset is too small.

### Bond mechanics

The 0.01 XNT commit stake is:
- **Taken** at `commit_via_ee` (transferred from contributor to EE round account)
- **Fully returned** at `reveal_via_ee` (transferred back to contributor)
- After finalization the EE round account holds only its rent-exempt minimum (no residual stake)

## Account field offsets (for raw deserialization in tests)

### WrapperRound (87 bytes)

| Offset | Field |
|--------|-------|
| 32 | `aggregated` (bool) |

### RequestState (202 bytes)

| Offset | Field |
|--------|-------|
| 152 | `fulfilled` (bool) |
| 153–184 | `output` ([u8; 32]) |

### FeeEscrow (42 bytes — V3 added `original_fees`, security fixes added `ee_v4_round_id`)

| Offset | Field |
|--------|-------|
| 8 | `pending_fees` (u64) |
| 16 | `round` (u64) |
| 24 | `original_fees` (u64) — total fees before insurance cut; used for per-validator share |
| 32 | `ee_v4_round_id` (u64) — EE V4 round that services this protocol round |
| 40 | `fee_distributed` (bool) |
| 41 | `bump` (u8) |

> **Note:** `fee_distributed` moved from offset 32 → 40 when `ee_v4_round_id` was added. `refund_request` verifies the EE round's stored round_id matches `fee_escrow.ee_v4_round_id` to prevent cross-round refund attacks.

### ValidatorRegistration (139 bytes — added Model 2)

Seeds: `[b"val-reg", identity.key()]`

| Offset | Field |
|--------|-------|
| 8–39   | `identity` (Pubkey) |
| 40–71  | `vote_account` (Pubkey) |
| 72–103 | `stake_account` (Pubkey) |
| 104–111 | `verified_stake` (u64) — lamports, re-verified at each refresh |
| 112–119 | `registered_slot` (u64) |
| 120–127 | `last_active_slot` (u64) — updated on successful commit |
| 128–135 | `last_round_participated` (u64) |
| 136    | `consecutive_misses` (u8) — 3+ triggers deactivation |
| 137    | `active` (bool) |
| 138    | `bump` (u8) |

Constants: `MIN_VALIDATOR_STAKE = 1000 XNT`, `VALIDATOR_MAX_INACTIVE_SLOTS = 500`, `MIN_COMMITTEE_SIZE = 2`

### ValidatorReveal (82 bytes — added V3)

| Offset | Field |
|--------|-------|
| 8–39 | `contributor` (Pubkey) |
| 40–71 | `ee_round` (Pubkey) |
| 72–79 | `protocol_round` (u64) |
| 80 | `claimed` (bool) |
| 81 | `bump` (u8) |

Seeds: `[b"validator-reveal", ee_round.key(), contributor.key()]`

### DappRegistration (145 bytes — V3 added `fee_override`)

| Offset | Field |
|--------|-------|
| 8–39 | `dapp_id` (Pubkey) |
| 40–71 | `callback_program` (Pubkey) |
| 72–79 | `callback_instruction` ([u8; 8]) |
| 80–87 | `min_round_interval` (u64) |
| 88–95 | `last_served_round` (u64) |
| 96–103 | `total_requests` (u64) |
| 104–135 | `authority` (Pubkey) |
| 136–143 | `fee_override` (u64) — 0 = use protocol default |
| 144 | `bump` (u8) |

### EE V4 Round (838 bytes, cross-program read)

Full field layout (Borsh/Anchor, no padding):

| Offset | Field | Notes |
|--------|-------|-------|
| 8–39 | `coordinator` (Pubkey) | validator who called init_ee_round |
| 40–47 | `round_id` (u64) | |
| 48 | `n_contributors` (u8) | currently 2 (= MIN_EE_M_THRESHOLD) |
| 49 | `m_threshold` (u8) | currently 2 |
| 50–57 | `commit_deadline` (u64) | last slot for commits; init_slot + COMMIT_DEADLINE_SLOTS(200) |
| 58–65 | `reveal_deadline` (u64) | last slot for reveals; commit_deadline + REVEAL_DEADLINE_SLOTS(400) |
| 66–73 | `binding_slot` (u64) | slot for finalize_via_ee; passed by wrapper at init |
| 74 | `commit_count` (u8) | |
| 75 | `reveal_count` (u8) | used by `claim_validator_reward` to compute per-validator share |
| 76–107 | `entropy_accumulator` ([u8; 32]) | |
| 108–139 | `entropy_output` ([u8; 32]) | |
| 140 | `status` (u8) | 0=CommitPhase, 1=RevealPhase, 2=Finalized, 3=Cancelled |
| 141–148 | `slash_pool` (u64) | |
| 149–156 | `finalized_slot` (u64) | |
| 157 | `bump` (u8) | |
| 158+ | `contributors` ([ContributorEntry; 10]) | each entry = 68 bytes |

**Critical timing**: commit window ends at `commit_deadline` (off 50). Reveal window is `commit_deadline → reveal_deadline` (off 50–58). `binding_slot` (off 66) is ~75 slots after `reveal_deadline` and gates `finalize_via_ee`. The daemon must use `commit_deadline` (not `binding_slot`) to determine when to switch from commit to reveal phase.

**Phase transition**: status transitions from CommitPhase→RevealPhase only when `commit_count == n_contributors`. With n=2, both registered validators must commit. If the reveal window expires without enough reveals, call `cancel_round` on the EE program directly (coordinator must sign + pass committed contributor wallets as remaining_accounts).

**cancel_round** (EE program direct call, not via wrapper):
- Required when: status=CommitPhase (0) and round is stuck (reveal window passed, not enough commits)
- Signer: round coordinator (validator who called init_ee_round)  
- remaining_accounts: committed contributor wallets in order (for stake refund)
- Script: `/tmp/cancel-ee-round.js`

## Fee economics

| Item | Amount |
|------|--------|
| Standard request fee | 0.01 XNT (default for all dApps) |
| Premium request fee | 0.05 XNT (high-volume dApps — set via `update_dapp_fee`) |
| Game seed fee | 0.001 XNT |
| EE V4 stake | 0.01 XNT (fully returned on valid reveal) |
| Insurance fund | 10% of round fees via `distribute_fees` |
| Validator share | 90% ÷ reveal_count via `claim_validator_reward` |

Premium tier is set by the protocol authority calling `update_dapp_fee` after a dApp registers. Validators earn more per round from premium dApps, directly incentivising liveness for high-value use cases.
