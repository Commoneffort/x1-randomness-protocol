# X1 Randomness Protocol — Audit Report

**Date:** 2026-05-16  
**Scope:** Full codebase — Anchor program, keeper scripts, frontend, documentation  
**Protocol version at time of audit:** V4 (post-decentralisation refactor)

---

## Summary

| Area | Issues Found | Issues Fixed | Status |
|------|-------------|-------------|--------|
| Anchor program (`lib.rs`) | 0 | 0 | ✅ PASS |
| Keeper crank (`run-round.js`) | 0 | 0 | ✅ PASS |
| Validator daemon (`validator-daemon.js`) | 0 | 0 | ✅ PASS |
| Frontend library (`protocol.ts`, `constants.ts`, `pdas.ts`) | 0 | 0 | ✅ PASS |
| Frontend UI — home dashboard (`page.tsx`) | 3 | 3 | ✅ FIXED |
| Frontend UI — docs (`docs/page.tsx`) | 11 | 11 | ✅ FIXED |
| Frontend UI — dApps (`dapps/page.tsx`) | 2 | 2 | ✅ FIXED |
| Frontend UI — request (`request/page.tsx`) | 3 | 3 | ✅ FIXED |
| Frontend UI — validators (`validators/page.tsx`) | 2 | 2 | ✅ FIXED |
| Frontend UI — rounds (`rounds/page.tsx`) | 0 | 0 | ✅ PASS |
| README.md | 7 | 7 | ✅ FIXED |
| Obsolete file (`validator-daemon.ts`) | 1 | 0 | ⚠️ PRESENT |

**Total:** 29 issues found, 28 fixed, 1 non-critical leftover.

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
