# X1 Randomness Protocol — Audit Report

**Date:** 2026-05-27 (V4.6 audit)  
**Scope:** Anchor program, keeper scripts, migration script, documentation  
**Protocol versions audited:** V4 (post-decentralisation), V4.2 (security hardening), V4.3 (full audit), V4.4–V4.5 (fee rebalancing), V4.6 (key separation)

---

## Summary

| Area | Issues Found | Issues Fixed | Status |
|------|-------------|-------------|--------|
| Anchor program (`lib.rs`) — V4 | 0 | 0 | ✅ PASS |
| Anchor program (`lib.rs`) — V4.2 | 9 | 9 | ✅ FIXED |
| Anchor program (`lib.rs`) — V4.3 | 3 | 3 | ✅ FIXED |
| Anchor program (`lib.rs`) — V4.6 | 6 | 6 | ✅ FIXED |
| Keeper crank (`run-round.js`) | 2 | 2 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) — V4.2 | 2 | 2 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) — V4.3 | 3 | 3 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) — V4.6 | 4 | 4 | ✅ FIXED |
| Tests (`mainnet-e2e.js`) — V4.6 | 3 | 3 | ✅ FIXED |
| Tests (`mainnet-e2e.js`) — V4.2/V4.3 | 2 | 2 | ✅ FIXED |
| Frontend library (`protocol.ts`) — V4.3 | 1 | 1 | ✅ FIXED |
| Frontend library (`protocol.ts`) — V4.6 | 2 | 2 | ✅ FIXED |
| Frontend constants (`constants.ts`) — V4.6 | 1 | 1 | ✅ FIXED |
| Frontend UI — home dashboard (`page.tsx`) — V4/V4.3 | 4 | 4 | ✅ FIXED |
| Frontend UI — docs (`docs/page.tsx`) — V4/V4.3 | 12 | 12 | ✅ FIXED |
| Frontend UI — docs (`docs/page.tsx`) — V4.6 | 7 | 7 | ✅ FIXED |
| Frontend UI — dApps (`dapps/page.tsx`) — V4/V4.3 | 2 | 2 | ✅ FIXED |
| Frontend UI — dApps (`dapps/page.tsx`) — V4.6 | 1 | 1 | ✅ FIXED |
| Frontend UI — request (`request/page.tsx`) | 3 | 3 | ✅ FIXED |
| Frontend UI — validators (`validators/page.tsx`) — V4/V4.3 | 2 | 2 | ✅ FIXED |
| Frontend UI — validators (`validators/page.tsx`) — V4.6 | 2 | 2 | ✅ FIXED |
| Frontend UI — rounds (`rounds/page.tsx`) — V4.3 | 1 | 1 | ✅ FIXED |
| Documentation (CLAUDE.md) — V4.3 | 2 | 2 | ✅ FIXED |
| README.md — V4/V4.3 | 7 | 7 | ✅ FIXED |
| README.md — V4.6 | 7 | 7 | ✅ FIXED |
| Obsolete file (`validator-daemon.ts`) | 1 | 0 | ⚠️ PRESENT |

**Total V4 audit:** 29 issues found, 28 fixed, 1 non-critical leftover.  
**Total V4.2 audit:** 15 additional issues found, 15 fixed.  
**Total V4.3 audit:** 17 additional issues found, 17 fixed.  
**Total V4.6 audit:** 33 additional issues found, 33 fixed (13 program/daemon/tests + 20 frontend/docs).

---

## Program (`programs/randomness-wrapper/src/lib.rs`)

### ✅ PASS — All checks clean

| Check | Result |
|-------|--------|
| `init_ee_round` uses protocol constants for n/m/binding_slot (not caller args) | ✅ |
| `commit_via_ee` enforces on-chain entropy-derived eligibility (`selector < COMMIT_SELECTION_THRESHOLD`) | ✅ |
| `ClaimValidatorFees` dust sweep sends to `protocol_config.authority`, not arbitrary wallets | ✅ |
| `ee_v4_program` address pinned to `ENTROPY_ENGINE_V4` in all CPI instructions | ✅ |
| `ee_round.owner == ENTROPY_ENGINE_V4` enforced in `finalize_via_ee` | ✅ |
| `distribute_fees` is idempotent — rejects if `fee_distributed == true` | ✅ |
| `claim_validator_reward` marks `ValidatorReveal.claimed = true` — single-claim per round | ✅ |
| `refund_request` verifies `fee_escrow.ee_v4_round_id` against EE round to prevent cross-round attack | ✅ |
| `request_randomness` output formula: `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` | ✅ |
| `STALENESS_HARD_LIMIT_SLOTS = 21_600` enforced on fast path (increased from 1_500 to reduce crank costs — pool warms on request or after ~2.25 hrs) | ✅ |
| `finalize_via_ee` explicitly checks `ee_data[140] == 2` (status=Finalized) after CPI | ✅ |
| `refund_request` requires `fee_escrow.ee_v4_round_id != 0` before allowing refund | ✅ |
| `claim_validator_reward` verifies EE round id matches `fee_escrow.ee_v4_round_id` | ✅ |

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
| ValidatorRegistration | 171 bytes (V4.6; was 139) | ✅ |
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
| 7 | High | Instructions table — `update_dapp_fee` "Who calls": "dApp authority" (V4/V4.3 audit incorrectly changed this to "Protocol authority") | **V4.6 correction:** reverted to "dApp authority" — Rust code enforces `dapp_registration.authority`, not protocol authority. |
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
| 7 | Medium | `update_dapp_fee` description in instructions table: "dApp authority" (V4 audit incorrectly changed to "Protocol authority") | **V4.6 correction:** reverted to "dApp authority" — matches Rust code. |

---

## V4.3 Full Security Audit (2026-05-18)

### Anchor Program — V4.3 findings (all fixed)

| ID | Severity | Instruction | Issue | Fix |
|----|----------|-------------|-------|-----|
| C-1 | Critical | `finalize_via_ee` | No explicit EE round status check after CPI. Relied on all-zero entropy as proxy for "not finalized." While CPI failure protects re-calls in practice, the intent was unclear and a 1-in-2^256 chance of valid all-zero entropy would have caused a false rejection. | Added `require!(ee_data[140] == 2, ...)` after CPI. Also consolidated the round ID length check to `>= 141`. |
| C-2 | Critical | `refund_request` | `fee_escrow.ee_v4_round_id == 0` before `aggregate_from_ee` links the escrow. The ID==0 state would match an EE round with id=0 (impossible for real rounds since they start at 1, but an explicit guard is required). | Added `require!(fee_escrow.ee_v4_round_id != 0, EeV4RoundNotFinalized)` — refunds require the escrow to already be linked to a finalized/cancelled EE round. |
| H-2 | High | `claim_validator_reward` | No check that the EE round passed matches the one linked to the fee escrow. An attacker who revealed in a different EE round (same protocol round) could attempt to use an unlinked EE round account to inflate `reveal_count` or drain escrow. | Added verification: read EE round id at offset 40 and require it equals `fee_escrow.ee_v4_round_id`. |

### Validator Daemon — V4.3 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| H-4 | High | `validator-daemon.js` `alreadyCommitted` | If a commit transaction failed (network error, not on-chain rejection), secrets were saved to disk but commit never landed. Next poll loaded secrets → `alreadyCommitted = true` → skipped commit → reveal failed (no on-chain commit). Daemon missed the round silently. | Removed `alreadyCommitted` flag. Now always attempts commit if before deadline; on-chain "already committed" error is caught and logged as confirmation. |
| M-4 | Medium | `validator-daemon.js` `ixClaimReward` | Extra `SystemProgram.programId` account in key list. The Rust `ClaimValidatorReward` struct has 4 accounts, not 5. Anchor ignored it but the account list was out of sync. | Removed the redundant `SystemProgram.programId` entry. |
| M-9 | Medium | `validator-daemon.js` console.log | Log message said `n=10` after `init_ee_round` — the old MAX_COMMITTEE_SIZE value. Protocol uses `n=2` (MIN_EE_M_THRESHOLD). | Changed log to `n=2, m=2`. |

### Frontend Library — V4.3 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| C-2 | Critical | `protocol.ts` `getAllDapps`, `getAllValidatorRegistrations`, `getValidatorReveals` | All three `getProgramAccounts` discriminator filters used base64 encoding for `memcmp.bytes`. Solana RPC requires base58. Validators and dApps pages likely returned empty results or unfiltered data. | Imported `bs58` from `"bs58"` and replaced all three filter bytes with `bs58.encode(disc)`. |

### Frontend UI — V4.3 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| M-2 | Medium | `page.tsx` (dashboard) | `ProtocolClient` instantiated directly in component body (`const client = new ProtocolClient()`). Created a new `Connection` and allocated WebSocket resources on every re-render (including the 3-second polling interval). | Changed to `const [client] = useState(() => new ProtocolClient())`. |
| M-8 | Medium | `rounds/page.tsx` | Fee escrow explorer link was broken: `href` evaluated to empty string, `onClick` blocked navigation, and the text was unrelated to navigation. | Replaced with a working `<a href="...escrow.pubkey">View FeeEscrow on Explorer →</a>` link and moved the EE entropy label to a plain `<span>`. |
| H-2 | Low | `docs/page.tsx` SDK example | `wrapperRoundPda` was listed as `isWritable: true` in the developer docs. The Rust struct does not mark `wrapper_round` as `#[account(mut)]` — it is read-only. | Changed to `isWritable: false`. |

### Documentation — V4.3 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| L-1 | Low | `CLAUDE.md` ValidatorRegistration constants | `MIN_COMMITTEE_SIZE = 3` in docs but the on-chain constant (and frontend) both use `2`. | Updated to `MIN_COMMITTEE_SIZE = 2`. |

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
| M-4 | Medium | `init_ee_round`, `commit_via_ee` | `register_validator` now checks node_pubkey, but `init_ee_round` and `commit_via_ee` did not. A validator could still use another's vote account after registration. | Added `node_pubkey == coordinator.key()` / `node_pubkey == contributor.key()` check in both handlers. **V4.6 note:** these checks were updated to use `validator_reg.identity` (instead of the signer key) so they remain correct after key rotation — see C-1 in V4.6 findings. |
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

## V4.6 Audit (2026-05-27)

### Anchor Program — V4.6 findings (all fixed)

| ID | Severity | Instruction | Issue | Fix |
|----|----------|-------------|-------|-----|
| C-1 | Critical | `commit_via_ee`, `init_ee_round` | M-4 fix (V4.2) checked `contributor.key()` / `coordinator.key()` against `node_pubkey`. After key rotation, contributor is the hot key but `node_pubkey` matches identity — check would fail. | Changed both checks to use `validator_reg.identity` (stable across rotations). |
| C-2 | Critical | `commit_via_ee` | Eligibility hash used `contributor.key()` (the signer, which changes after rotation). An operator who rotated their key would get a different selection probability. | Changed eligibility hash input to `validator_reg.identity`. Selection probability now stable across rotations. |
| H-1 | High | All instructions using `Account<ValidatorRegistration>` | After V4.6 program upgrade, existing 139-byte accounts cannot be deserialized as the now-171-byte struct. Every commit/reveal/refresh/init_ee_round fails with a deserialization error until migration runs. | Added permissionless `migrate_validator_registration` instruction using `UncheckedAccount` to avoid the chicken-and-egg: migration reallocates 139→171 bytes and writes `x1_randomness_authority = identity`. Migration script runs immediately post-upgrade; window < 30s for 9 validators. |
| H-2 | High | `refresh_validator_status` | Handler returned silent `Ok(())` on stake/vote failures, setting `active = false` without indicating why. Validator daemon would call refresh every 15s forever with no actionable feedback — 2960 txs/day of spam when stake account is activating. | Handler now returns `Err(InsufficientValidatorStake)` or `Err(ValidatorNotActivelyVoting)` explicitly. Daemon implements exponential backoff (60s × 2^n, max 900s) on refresh failures. |
| M-1 | Medium | `commit_via_ee`, `reveal_via_ee`, `init_ee_round` | `n=2, m=2` with 9 active validators meant 2 validators did all work every round with no selection lottery. If either of those 2 missed a round, `consecutive_misses=3` triggered deactivation. Validators had a 1-in-4.5 expected miss rate from commit window races. | Raised `EE_V4_N_CONTRIBUTORS=7`, `EE_V4_M_THRESHOLD=5`. 7 of 9 validators commit each round; 5 reveals suffice. Raised `VALIDATOR_MAX_CONSECUTIVE_MISSES=5` to give validators breathing room when 2 of 9 lose the commit race. |
| M-2 | Medium | `rotate_randomness_authority` | Hot key rotation must require the identity (cold) key to authorize. If the hot key were compromised, an attacker who held it must not be able to rotate to a new key they control — that would permanently sever the validator's access to their own registration. | `RotateRandomnessAuthority` context requires `identity: Signer`. Hot key cannot rotate; only identity can. `revoke_randomness_authority` resets the hot key back to identity (same context). |

### Validator Daemon — V4.6 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| H-3 | High | `validator-daemon.js` `sweepUnclaimedRewards` | After key rotation, new `ValidatorReveal` PDAs have `contributor == hotKey.publicKey`. The sweep scanned only by `identity.publicKey` — post-rotation rewards would never be claimed. | Sweep now builds scan pairs `[{identity, signer: identity}, {hotKey, signer: hotKey}]` (deduplicated when equal). Claims pre-rotation rewards with identity, post-rotation rewards with hot key. |
| H-4 | High | `validator-daemon.js` commit/reveal | Commitment hash was `SHA256(secret ‖ nonce ‖ identity.publicKey)`. After rotation, the signer is `hotKey` but hash still used `identity` — reveal would fail (hash mismatch on-chain). | All three commitment hash sites updated to use `hotKey.publicKey`. VR PDA derivation and contributor account key updated to match. |
| M-5 | Medium | `validator-daemon.js` WrongPhase check | WrongPhase → re-check contributor list compared slot against `identity.publicKey`. After rotation, commits land under `hotKey.publicKey` — check would always return `isContributor = false`, causing skip when we had actually committed. | Changed comparison to `hotKey.publicKey`. |
| L-1 | Low | `validator-daemon.js` | No `--deregister` flag. Operators could not cleanly remove their registration without writing custom scripts. | Added `--deregister` flag calling `deregister_validator` instruction (closes account, returns rent to identity). |

### Test Suite — V4.6 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| H-5 | High | `tests/mainnet-e2e.js` `buildInitEeRound` | Function accepted `nContributors, mThreshold, bindingSlot` as caller args and encoded them in the instruction data. V4.6 program ignores these bytes and derives n/m/binding_slot from protocol constants — but the test was sending 25 extra bytes, potentially misaligning instruction data parsing. | Removed all three params. Instruction data is now only `disc + u64le(eeRoundId)` (8+8=16 bytes), matching the Rust handler. |
| M-6 | Medium | `tests/mainnet-e2e.js` `buildDistributeFees` | `crank` account had `isSigner: false`. V4.5 requires `crank: Signer` (program transfers lamports directly to crank). Test would fail with a missing-signer error. | Changed `isSigner: true`. |
| L-2 | Low | `tests/mainnet-e2e.js` | `fee_distributed` read at offset 32. V4.5 added `ee_v4_round_id` (u64) at offset 32, shifting `fee_distributed` to offset 40. Test read the wrong byte — always saw `fee_distributed = false`. | Updated to offset 40 (3 occurrences). |

---

## V4.6 Frontend & Documentation Audit (2026-05-27)

### Frontend Library — V4.6 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| F-1 | High | `protocol.ts` `getValidatorRegistration`, `parseValReg`, `getAllValidatorRegistrations` | `ValidatorRegistration` deserialized as 139 bytes — size check `d.length < 139` and no reading of `x1_randomness_authority` at offset 139. After V4.6 deploy, all migrated accounts are 171 bytes with the hot key field appended. Frontend showed no hot key info and would pass 139-byte filters against now-171-byte accounts. | Updated `parseValReg` to conditionally read `x1_randomness_authority` at offset 139 when `d.length >= 171`. Added optional `x1RandomnessAuthority?: string` field to interface. Minimum size check stays at 139 for backward compatibility during migration window. |
| F-2 | Medium | `constants.ts` | Missing `EE_V4_N_CONTRIBUTORS`, `EE_V4_M_THRESHOLD`, `VALIDATOR_MAX_CONSECUTIVE_MISSES` constants. Pages hardcoded old values (n=2, 3 misses) or had no constant reference at all. | Added all three constants: `EE_V4_N_CONTRIBUTORS=7`, `EE_V4_M_THRESHOLD=5`, `VALIDATOR_MAX_CONSECUTIVE_MISSES=5`. |

### Frontend Docs Page — V4.6 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| D-1 | High | `docs/page.tsx` Architecture | EE V4 description said "n=2 currently; grows with validator set" | Updated to "n=7 validators … m=5 reveals suffice to finalize" |
| D-2 | High | `docs/page.tsx` Round Lifecycle | Step 1 commit_via_ee said "Currently n=2 validators per round" | Updated to "n=7 validators are selected per round; all 7 must commit before reveals begin" |
| D-3 | **High** | `docs/page.tsx` Instructions table | `update_dapp_fee` "Who calls" listed as "Protocol authority". **Code reality:** `update_dapp_fee` verifies `ctx.accounts.dapp_registration.authority == ctx.accounts.authority.key()` — the dApp authority (whoever registered the dApp), NOT the protocol authority. dApps can set their own fee override without waiting for the protocol owner. | Corrected "Who calls" to "dApp authority". Updated FAQ entry for update_dapp_fee accordingly. |
| D-4 | Medium | `docs/page.tsx` Instructions table | Missing V4.6 instructions: `migrate_validator_registration`, `rotate_randomness_authority`, `revoke_randomness_authority` | Added all three with correct descriptions and caller attribution |
| D-5 | High | `docs/page.tsx` Account Types | `ValidatorRegistration` shown as 139 bytes with "consecutive_misses: 3+ triggers deactivation" and no `x1_randomness_authority` field | Updated to 171 bytes, added `x1_randomness_authority` at offset 139, corrected "5+ triggers deactivation" |
| D-6 | High | `docs/page.tsx` Keeper section | Stats grid showed `n=2 (wrapper config; EE V4 hardcoded max is 10)` / `m=2` | Updated to `n=7` / `m=5 (5 of 7 reveals suffice to finalize)` |
| D-7 | Medium | `docs/page.tsx` Security section | Missing key separation security property (V4.6 hot key isolation) | Added entry describing V4.6 key separation: hot key scope, identity-only operations, eligibility hash stability |

### Frontend Validators Page — V4.6 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| V-1 | High | `validators/page.tsx` Liveness Requirements | "Consecutive miss limit: 3 misses → validator marked inactive" — hardcoded old constant | Changed to use `VALIDATOR_MAX_CONSECUTIVE_MISSES` from constants (now 5); updated code comment from "consecutive_misses >= 3" to ">= 5" |
| V-2 | High | `validators/page.tsx` Daemon Setup | Setup code block showed pre-V4.6 commands only: identity key for all operations, no `X1_RANDOMNESS_KEYPAIR`, no `--rotate-authority`, no `--deregister`. Post-V4.6, operators running identity keys for daily commit/reveal operations unnecessarily expose their cold key. | Rewrote setup block with all V4.6 commands: hot key daemon invocation, `--rotate-authority`, `--deregister`, and permissionless crank with `CRANK_KEYPAIR` |

### Frontend dApps Page — V4.6 findings (all fixed)

| ID | Severity | File | Issue | Fix |
|----|----------|------|-------|-----|
| A-1 | **High** | `dapps/page.tsx` Registration form | Warning box said "Fee tier is set by the protocol authority via `update_dapp_fee` after you register — you cannot set it yourself on-chain." This is wrong: the Rust instruction checks `dapp_registration.authority == authority.key()` — the dApp authority (caller). dApps can and should call `update_dapp_fee` themselves to set their premium tier. No protocol owner intervention needed. | Updated warning to: "Fee tier can be changed on-chain by calling `update_dapp_fee` — signed by the dApp authority (the wallet you register with)." |

### README.md — V4.6 findings (all fixed)

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| R-1 | High | Architecture diagram: "n=2 contributors per round" | Updated to "n=7, m=5 per round (V4.6)" |
| R-2 | High | Round lifecycle step 3: `n=MIN_EE_M_THRESHOLD(2), m=MIN_EE_M_THRESHOLD(2)` | Updated to `n=EE_V4_N_CONTRIBUTORS(7), m=EE_V4_M_THRESHOLD(5)` |
| R-3 | **High** | Instructions table: `update_dapp_fee` "Who calls: Protocol authority" | Corrected to "dApp authority" |
| R-4 | High | Accounts table: `EntropyPool` shown as "67 B" | Updated to "75 B (67 B pre-V4.3 migration)" |
| R-5 | High | Accounts table: `ValidatorRegistration` shown as "139 B" | Updated to "171 B (139 B pre-V4.6 migration)" + migration note |
| R-6 | High | ValidatorRegistration struct: 139 bytes, "3+ triggers deactivation", no `x1_randomness_authority` | Updated to 171 bytes, "5+ triggers deactivation", added hot key row, added migration warning |
| R-7 | High | Key Formulas: `game_seed output = SHA256(pool_entropy ‖ game_id)` — missing `payer` and `slot_hash` | Corrected to `SHA256(pool_entropy ‖ game_id ‖ payer ‖ slot_hash)` |
| R-8 | High | Key Formulas: validator eligibility uses `contributor_pubkey` — wrong after key rotation | Corrected to `validator_reg.identity` (stable across rotations) |
| R-9 | Medium | Economics: premium fee "set by protocol authority" | Corrected to "dApp authority" |
| R-10 | Medium | Validator daemon table: single-key description | Updated to reflect V4.6 hot key support |
| R-11 | Medium | Running a Validator: no V4.6 commands | Added `X1_RANDOMNESS_KEYPAIR`, `--rotate-authority`, `--deregister`, `CRANK_KEYPAIR` |
| R-12 | Medium | Missing V4.6 changelog section | Added complete V4.6 changelog with program changes, daemon changes, migration script, post-deploy sequence |

---

## Collusion & Security Model Notes

The following vectors were reviewed and are acceptable under the current design:

| Vector | Mitigated? | Notes |
|--------|-----------|-------|
| Last-revealer bias | Partial | Validator who reveals last gains marginal advantage. Slot hash mixed at finalize adds unpredictability no validator controls. |
| Pre-sharing secrets among validators | Partial | With n=7 of 9 validators committing and m=5 reveals required, 5+ colluding validators could bias the output. Lowering `COMMIT_SELECTION_THRESHOLD` as the validator set grows reduces expected committee size, making coordination harder. |
| Front-running after pool entropy is known | Mitigated | `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` — slot_hash at inclusion is unknown at submission time. |
| Single-validator round | Mitigated | `EE_V4_M_THRESHOLD = 5` enforced as a protocol constant in `init_ee_round`; EE V4 cancels rounds with fewer than M reveals. |
| Fake EE V4 program injection | Mitigated | All four CPI instructions enforce `address = ENTROPY_ENGINE_V4`. |
| Cross-round refund attack | Mitigated | `refund_request` verifies `fee_escrow.ee_v4_round_id` matches the EE round's stored ID, and now additionally requires `ee_v4_round_id != 0` (escrow must already be linked). |
| Reward claim against wrong EE round | Mitigated | `claim_validator_reward` now reads EE round ID at offset 40 and requires it matches `fee_escrow.ee_v4_round_id`. |

---

*Audit conducted as part of V4 decentralisation release.*
