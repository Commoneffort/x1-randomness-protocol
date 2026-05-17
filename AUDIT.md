# X1 Randomness Protocol — Audit Report

**Date:** 2026-05-17 (updated)  
**Scope:** Full codebase — Anchor program, keeper scripts, frontend, documentation  
**Protocol versions audited:** V4 (post-decentralisation), V4.2 (security hardening)

---

## Summary

| Area | Issues Found | Issues Fixed | Status |
|------|-------------|-------------|--------|
| Anchor program (`lib.rs`) — V4 | 0 | 0 | ✅ PASS |
| Anchor program (`lib.rs`) — V4.2 | 9 | 9 | ✅ FIXED |
| Keeper crank (`run-round.js`) | 2 | 2 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) | 2 | 2 | ✅ FIXED |
| Tests (`mainnet-e2e.js`) | 2 | 2 | ✅ FIXED |
| Frontend library (`protocol.ts`, `constants.ts`, `pdas.ts`) | 0 | 0 | ✅ PASS |
| Frontend UI — home dashboard (`page.tsx`) | 3 | 3 | ✅ FIXED |
| Frontend UI — docs (`docs/page.tsx`) | 11 | 11 | ✅ FIXED |
| Frontend UI — dApps (`dapps/page.tsx`) | 2 | 2 | ✅ FIXED |
| Frontend UI — request (`request/page.tsx`) | 3 | 3 | ✅ FIXED |
| Frontend UI — validators (`validators/page.tsx`) | 2 | 2 | ✅ FIXED |
| Frontend UI — rounds (`rounds/page.tsx`) | 0 | 0 | ✅ PASS |
| README.md | 7 | 7 | ✅ FIXED |
| Obsolete file (`validator-daemon.ts`) | 1 | 0 | ⚠️ PRESENT |

**Total V4 audit:** 29 issues found, 28 fixed, 1 non-critical leftover.  
**Total V4.2 audit:** 15 additional issues found, 15 fixed.

---

## Program (`programs/randomness-wrapper/src/lib.rs`)

### ✅ PASS — All checks clean

| Check | Result |
|-------|--------|
| `init_ee_round` uses protocol constants for n/m/binding_slot (not caller args) | ✅ |
| `commit_via_ee` enforces on-chain entropy-derived eligibility (`selector < COMMIT_SELECTION_THRESHOLD`) | ✅ |
| `ClaimValidatorFees` dust sweep sends to `insurance_fund`, not `authority` | ✅ |
| `ee_v4_program` address pinned to `ENTROPY_ENGINE_V4` in all CPI instructions | ✅ |
| `ee_round.owner == ENTROPY_ENGINE_V4` enforced in `finalize_via_ee` | ✅ |
| `distribute_fees` is idempotent — rejects if `fee_distributed == true` | ✅ |
| `claim_validator_reward` marks `ValidatorReveal.claimed = true` — single-claim per round | ✅ |
| `refund_request` verifies `fee_escrow.ee_v4_round_id` against EE round to prevent cross-round attack | ✅ |
| `request_randomness` output formula: `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` | ✅ |
| `STALENESS_HARD_LIMIT_SLOTS = 1_500` enforced on fast path | ✅ |

---

## Keeper Crank (`keeper/run-round.js`)

### ✅ PASS — No issues

- Holds only the payer/crank key. No validator keys.
- `ixInitEeRound` passes only `ee_round_id` — n/m/binding_slot are derived on-chain.
- `ixDistributeFees` correctly reads `insurance_fund` from `cfgData[40:72]`.
- `--register` flag registers only the crank's own key (no `--key2`/`--key3`).
- Round lifecycle: advance → escrow → init_ee_round → wait → finalize → aggregate → distribute.

---

## Validator Daemon (`keeper/validator-daemon.js`)

### ✅ PASS — No issues

- Takes `VALIDATOR_KEYPAIR` env var — holds only the validator's own identity key.
- Mirrors on-chain eligibility check before submitting `commit_via_ee`.
- `ixCommit` includes `entropy_pool` PDA in account list (matches `CommitViaEe` context).
- Secrets persisted to `/tmp/vd-secrets-<prefix>.json` before commit — survives restart.
- Calls `claim_validator_reward` after `distribute_fees` runs.

### ⚠️ Non-critical: `validator-daemon.ts` still present

`keeper/validator-daemon.ts` is the old TypeScript daemon referencing a different program ID (`BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr`) and an obsolete committee-based IDL. It is completely superseded by `validator-daemon.js`. It should be archived or deleted to avoid confusion. Not a security issue — it will simply fail to run against the deployed program.

---

## Frontend Library (`src/lib/protocol.ts`)

### ✅ PASS — All account deserialization correct

| Account | Expected size | Verified |
|---------|---------------|----------|
| ProtocolConfig | 113 bytes | ✅ |
| EntropyPool | 67 bytes | ✅ |
| WrapperRound | 87 bytes | ✅ |
| FeeEscrow | 42 bytes (`pending_fees@8`, `round@16`, `original_fees@24`, `ee_v4_round_id@32`, `fee_distributed@40`, `bump@41`) | ✅ |
| DappRegistration | 145 bytes | ✅ |
| ValidatorReveal | 82 bytes | ✅ |
| ValidatorRegistration | 139 bytes | ✅ |
| RequestState | 202 bytes | ✅ |

---

## Frontend — Home Dashboard (`src/app/page.tsx`)

### Issues found and fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | Medium | Version string said "V3 — Live on X1 Mainnet" | Updated to V4 |
| 2 | High | SHA256 formula in entropy snapshot box: `SHA256(pool_entropy ‖ request_id)` — missing `slot_hash` | Added `‖ slot_hash` |
| 3 | Medium | "V3 Features" section with outdated feature list | Replaced with "V4 Features": permissionless cranks, on-chain selection, all fees to validators, liveness protection |

---

## Frontend — Documentation (`src/app/docs/page.tsx`)

### Issues found and fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | High | Version string "V3" in header | Updated to V4 |
| 2 | High | SHA256 formula in overview: `SHA256(round_entropy \|\| request_id)` | Corrected to `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` |
| 3 | High | Round lifecycle step 3: "Keeper calls finalize" | Corrected to "Any signer (permissionless crank)" |
| 4 | High | Instructions table — `advance_round` "Who calls": "Keeper" | Changed to "Anyone (permissionless)" |
| 5 | High | Instructions table — `finalize_via_ee` "Who calls": "Keeper" | Changed to "Anyone (permissionless)" |
| 6 | High | Instructions table — `aggregate_from_ee` "Who calls": "Keeper" | Changed to "Anyone (permissionless)" |
| 7 | High | Instructions table — `update_dapp_fee` "Who calls": "dApp authority" | Changed to "Protocol authority" |
| 8 | High | Instructions table — `init_ee_round` description says "m_threshold ≥ 2" as a caller param | Clarified that n/m/binding_slot are protocol constants, not caller args |
| 9 | Critical | FeeEscrow account layout showed 34 bytes with wrong offsets (`fee_distributed@32`, `bump@33`) | Corrected to 42 bytes: `ee_v4_round_id@32`, `fee_distributed@40`, `bump@41` |
| 10 | Medium | `ValidatorRegistration` account missing from accounts table and PDAs table | Added both entries (139 bytes, seeds `["val-reg", identity]`) |
| 11 | Medium | Fee Economics section: "Per-dApp override: Set by dApp authority" | Changed to "Set by protocol authority"; added premium tier; added note that game_seed fees flow to validators |
| 12 | Medium | Validator Node section step 1 mentions `n_contributors`, `m_threshold`, `binding_slot` as caller args | Updated: only `ee_round_id` is passed; n/m/binding_slot are protocol constants |
| 13 | Medium | Security section — `init_ee_round` entry described threshold as a caller constraint | Rewritten as constants; added new entry for on-chain validator selection |
| 14 | Medium | FAQ — "How do I earn rewards?": "Run the keeper daemon" | Updated to "Run validator-daemon.js with your identity keypair" |

---

## Frontend — dApp Registry (`src/app/dapps/page.tsx`)

### Issues found and fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | High | Fee tier selector presented as a real on-chain choice; no warning that `fee_override` is set by the protocol authority post-registration | Added yellow warning box: "Fee tier is set by the protocol authority via `update_dapp_fee` after you register — you cannot set it yourself on-chain" |
| 2 | Medium | Protocol Info section explained request fees but made no mention that game_seed fees also flow to validators | Added explicit note: "game_seed fees (0.001 XNT) also flow to validators via the same FeeEscrow mechanism" |

---

## Frontend — Request Page (`src/app/request/page.tsx`)

### Issues found and fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | High | Fee info bar: `SHA256(round_entropy \|\| request_id)` | Corrected to `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` |
| 2 | High | "How It Works" step 4: `SHA256(round_entropy \|\| request_id)` | Same correction |
| 3 | Medium | Comparison table "Verifiable output" row: `SHA256(entropy \|\| request_id)` | Corrected to `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` |

---

## Frontend — Validators & Rewards (`src/app/validators/page.tsx`)

### Issues found and fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | High | "How Validators Earn" step 2: "Run keeper software" — described the old centralised keeper that held all validator keys | Updated to "Run validator-daemon.js" — each validator runs their own independent daemon |
| 2 | Critical | "Keeper Setup" section showed completely obsolete commands: `--key2`/`--key3` flags (removed in V4) and described a centralised model where one process managed all validators | Replaced with "Validator Daemon Setup": correct `validator-daemon.js --loop` commands; clarified crank vs daemon separation |

---

## Frontend — Round History (`src/app/rounds/page.tsx`)

### ✅ PASS — No issues

Round lifecycle legend, fee display, and status badges are all accurate.

---

## README.md

### Issues found and fixed

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | Medium | "Randomness Wrapper V3" in deployed addresses table and architecture diagram | Updated to V4 |
| 2 | High | Round lifecycle step 3: `init_ee_round(ee_round_id, N, M, binding_slot)` shown as caller args | Corrected: only `ee_round_id` is passed |
| 3 | High | Instructions table: `init_ee_round(ee_round_id, N, M, binding_slot)` | Corrected to `init_ee_round(ee_round_id)` |
| 4 | Critical | FeeEscrow struct layout: "34 bytes — V3" with `fee_distributed@32`, `bump@33` | Corrected to 42 bytes: added `ee_v4_round_id@32`, `fee_distributed@40`, `bump@41` |
| 5 | High | Key Formulas table: fast path output = `SHA256(entropy_pool.current_entropy \|\| request_id)` — missing `slot_hash` | Added `‖ slot_hash` |
| 6 | Critical | Security section "Authority-Gated Round Initialization": stated `init_ee_round` is restricted to `protocol_config.authority` — **this was the V2.2 rule, reversed in V4** | Replaced with V4 reality: permissionless but constrained by sequential ID and protocol constants |
| 7 | Medium | `update_dapp_fee` description in instructions table: "dApp authority" | Corrected to "Protocol authority" |

---

## V4.2 Security Audit (2026-05-17)

### Anchor Program — V4.2 findings (all fixed)

| ID | Severity | Instruction | Issue | Fix |
|----|----------|-------------|-------|-----|
| C-1 | Critical | `request_randomness` | `fee_override` read from `dapp_info` without verifying account owner or discriminator. A 1-lamport account with a single `fee_override=0` byte at offset 136 bypasses fees entirely. | Added `dapp_info.owner == &ID` + discriminator check before reading field. |
| C-2 | Critical | `mark_validator_missed` | No check that the validator was registered before the EE round opened. Three old finalized/cancelled rounds = instant deactivation of any new validator. | Added `registered_slot < binding_slot − EE_V4_MIN_BINDING_SLOTS` guard. |
| H-1 | High | `register_validator` | No check that vote account's `node_pubkey` matches the signing identity. Validator could borrow a high-stake validator's vote + stake accounts to register with inflated credentials. | Added VoteState `node_pubkey` check at offset 4. |
| H-2 | High | `advance_round` | Permissionless caller could advance the protocol round while an EE round was in flight. Protocol WrapperRound for the new round would never receive the EE entropy — stall. | Added `current_wrapper_round.aggregated == true` check; added `current_wrapper_round` account to context. |
| M-1 | Medium | `deliver_callback` | `min_round_interval=0` skipped the interval check entirely (`if interval > 0`). Same subscriber could spam entropy pulls in a single round by calling repeatedly. | Changed to `effective_interval = min_round_interval.max(1)`. |
| M-3 | Medium | `aggregate_from_ee` | `fee_escrow.ee_v4_round_id` was never written during aggregation. `refund_request` validated this field — but it stayed 0 after the first round, allowing cross-round escrow mismatches. | Added `fee_escrow` account to `AggregateFromEe` context; write `ee_v4_round_id = resolved_ee_round_id` at end of handler. |
| M-4 | Medium | `init_ee_round`, `commit_via_ee` | `register_validator` now checks node_pubkey, but `init_ee_round` and `commit_via_ee` did not. A validator could still use another's vote account after registration. | Added `node_pubkey == coordinator.key()` / `node_pubkey == contributor.key()` check in both handlers. |
| M-2 | Medium | `validator-daemon.js` saveSecrets | Ephemeral commit secret written to `/tmp/vd-secrets-*.json` with default `0o644` permissions — world-readable. | Changed `writeFileSync` to use `{ mode: 0o600 }`. |
| L-5 | Low | `validator-daemon.js` send | Single-attempt transaction send with no retry. Transient RPC failures permanently miss the commit or reveal window. | Added 3-attempt retry loop with 5s delay and fresh blockhash per attempt. |

### Keeper Scripts — V4.2 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| H-2b | High | `run-round.js` `ixAdvanceRound` | Account list missing `current_wrapper_round` — the new H-2 constraint would have caused `advance_round` to fail with a missing account error. | Added `current_wrapper_round` at position 2 (between pool and new_wrapper_round). |
| M-3b | Medium | `run-round.js` `ixAggregateFromEe` | Account list missing `fee_escrow` — the new M-3 account would have caused `aggregate_from_ee` to fail. | Added `fee_escrow` at position 3 (between pool and ee_round), writable. |

### Test Suite — V4.2 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| H-2c | High | `tests/mainnet-e2e.js` `buildAdvanceRound` | Same missing account as run-round.js. | Added `current_wrapper_round` at position 2. |
| M-3c | Medium | `tests/mainnet-e2e.js` `buildAggregateFromEe` | Same missing account as run-round.js. | Added `fee_escrow` at position 3. |

---

## Collusion & Security Model Notes

The following vectors were reviewed and are acceptable under the current design:

| Vector | Mitigated? | Notes |
|--------|-----------|-------|
| Last-revealer bias | Partial | Validator who reveals last gains marginal advantage. Slot hash mixed at finalize adds unpredictability no validator controls. |
| Pre-sharing secrets among validators | Partial | 2-of-3 validators could pre-share secrets. Lowering `COMMIT_SELECTION_THRESHOLD` as the validator set grows reduces expected committee size, making coordination harder. |
| Front-running after pool entropy is known | Mitigated | `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` — slot_hash at inclusion is unknown at submission time. |
| Single-validator round | Mitigated | `MIN_EE_M_THRESHOLD = 2` enforced as a protocol constant in `init_ee_round`; EE V4 cancels rounds with fewer than M reveals. |
| Fake EE V4 program injection | Mitigated | All four CPI instructions enforce `address = ENTROPY_ENGINE_V4`. |
| Cross-round refund attack | Mitigated | `refund_request` verifies `fee_escrow.ee_v4_round_id` matches the EE round's stored ID. |

---

*Audit conducted as part of V4 decentralisation release.*
