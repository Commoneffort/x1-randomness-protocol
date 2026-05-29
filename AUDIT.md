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
| Anchor program (`lib.rs`) — V4.7 | 6 | 6 | ✅ FIXED |
| Keeper crank (`run-round.js`) — V4.2 | 2 | 2 | ✅ FIXED |
| Keeper crank (`run-round.js`) — V4.7 | 2 | 2 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) — V4.2 | 2 | 2 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) — V4.3 | 3 | 3 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) — V4.6 | 4 | 4 | ✅ FIXED |
| Validator daemon (`validator-daemon.js`) — V4.7 | 4 | 4 | ✅ FIXED |
| Cancel script (`cancel-ee-round.js`) — V4.7 | 1 | 1 | ✅ FIXED |
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
| Open: `FeeEscrow` no close path after distribution — V4.7 | 1 | 0 | ⚠️ DEFERRED |

**Total V4 audit:** 29 issues found, 28 fixed, 1 non-critical leftover.  
**Total V4.2 audit:** 15 additional issues found, 15 fixed.  
**Total V4.3 audit:** 17 additional issues found, 17 fixed.  
**Total V4.6 audit:** 33 additional issues found, 33 fixed (13 program/daemon/tests + 20 frontend/docs).  
**Piotr's external audit (2026-05-27) — 2 issues, 2 fixed:** StakeDeactivating error propagation (program + daemon) fixed in post-V4.6 patch; stale daemon comment corrected.  
**Post-V4.6 patch audit (2026-05-27) — 16 issues, 16 fixed:** Hot-key-only daemon mode completion (6 daemon issues), docs/fee economics stale "protocol authority" text, eligibility hash formula in security section, validator credential binding description, FAQ update, README separate-server setup, CLAUDE.md env vars, AUDIT.md stale references.  
**Complete repo audit (2026-05-27) — 4 issues found, 4 fixed:** Dead `ixClaimReward` function removed; unused `totalUnclaimed` variable removed; all-hot-key-only protocol stall documented in CLAUDE.md; stale test account lists noted (test-only, no production impact).  
**V4.7 full security audit (2026-05-29) — 15 issues found, 14 fixed, 1 deferred:** Critical `hasFees()` offset bug locking all validator rewards; `mark_validator_missed` spam-deactivation attack (no idempotency); false deactivation after hot-key rotation; orphaned queue-path requests; cancelled-round refunds blocked; crank stall on cancelled EE rounds; reveal window off-by-75-slots; eligibility gate blocking lifecycle; `game_seed` staleness; hot-key authority validation; rent leak on `ValidatorReveal`. Deferred: `FeeEscrow` no close path after distribution.

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

- Takes `VALIDATOR_KEYPAIR` (full mode) or `VALIDATOR_IDENTITY_PUBKEY` (hot-key-only mode) — holds only the validator's own key(s).
- Mirrors on-chain eligibility check before submitting `commit_via_ee`.
- `ixCommit` includes `entropy_pool` PDA in account list (matches `CommitViaEe` context).
- Secrets persisted to `~/.config/x1randomness/vd-secrets-<pubkeyPrefix>.json` (mode `0o600`) before commit — survives restart. **Note: V4.2 audit moved this from `/tmp/` to this path.**
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
| H-3 | High | `validator-daemon.js` `sweepUnclaimedRewards` | After key rotation, new `ValidatorReveal` PDAs have `contributor == hotKey.publicKey`. The sweep scanned only by `identity.publicKey` — post-rotation rewards would never be claimed. | In full mode: scans identity (pre-rotation) and, if different, hot key (post-rotation). In hot-key-only mode: scans hot key only (identity secret not available to sign claims). |
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

## Post-V4.6 Patch Audit (2026-05-27) — Hot-key-only daemon mode

**Scope:** `keeper/validator-daemon.js` hot-key-only mode completion + `frontend/src/app/validators/page.tsx` + `README.md` + `CLAUDE.md`

### Summary

| Area | Issues Found | Issues Fixed | Status |
|------|-------------|-------------|--------|
| Validator daemon — hot-key-only mode | 4 | 4 | ✅ FIXED |
| Frontend docs (`docs/page.tsx`) | 4 | 4 | ✅ FIXED |
| README.md | 2 | 2 | ✅ FIXED |
| CLAUDE.md | 4 | 4 | ✅ FIXED |
| AUDIT.md stale references | 2 | 2 | ✅ FIXED |

### Validator Daemon — hot-key-only mode findings

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| H-1 | High | `ixCommit` used `identity.publicKey` for `valRegPda` derivation. In hot-key-only mode `identity` is `null` — daemon would crash on any commit attempt. | Changed to `identityPubkey` throughout `ixCommit`, `ixRefreshValidatorStatus`, `ixCancelEeRound`. |
| H-2 | High | `sweepUnclaimedRewards` (V4.6 H-3 fix) used `identity.publicKey` directly — null crash in hot-key-only mode. | Guarded: full mode scans identity + hot key; hot-key-only mode scans hot key only. |
| H-3 | High | Next-round `init_ee_round` block (line ~700) had no `hotKeyOnlyMode` guard. Would crash with null identity when trying to open the next EE round. | Added `hotKeyOnlyMode` guard: logs "waiting for another validator" and returns. `send()` calls explicitly pass `[identity]`. |
| M-1 | Medium | `send()` default signers was `[identity]` — null in hot-key-only mode. Any code path that fell through to the default would crash silently at tx signing. | Changed default to `[identity ?? hotKey]`. `hotKey` is always non-null. |
| M-2 | Medium | `coordinator.equals(identity.publicKey)` in cancel_round check — null crash in hot-key-only mode. `ixCancelEeRound` also put `identity.publicKey` as signer key without null guard. | Changed to `identityPubkey`; added hot-key-only guard that logs instruction to run `cancel-ee-round.js` on validator server instead of crashing. |
| L-1 | Low | No `--refresh` flag. Validators who went inactive in hot-key-only mode had no documented way to reactivate. | Added `--refresh` flag: calls `refresh_validator_status` with identity key; blocked in hot-key-only mode with clear error. Added to hotKeyOnlyMode guard list. |

### Frontend docs (`docs/page.tsx`) — findings

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| D-1 | High | Fee Economics grid: "Premium request fee — set by **protocol authority** via update_dapp_fee." Wrong — `update_dapp_fee` checks `dapp_registration.authority` (the dApp authority). This error persisted through V4.3 and V4.6 audits (Instructions table was corrected but Fee Economics grid was not). | Changed to "set by **dApp authority** via update_dapp_fee — no protocol owner intervention needed." |
| D-2 | Medium | Security section "On-chain validator selection": `SHA256(round_seed ‖ contributor_pubkey)`. Stale — V4.6 changed the eligibility hash input from `contributor.key()` to `validator_reg.identity`. | Corrected to `SHA256(round_seed ‖ validator_reg.identity)` with note that this is stable across hot-key rotations. |
| D-3 | Medium | Security section "Validator credential binding": "matches the signing identity" — ambiguous post-V4.6. After hot-key rotation, the commit signer is the hot key, not the identity. The check actually goes against `validator_reg.identity`. | Rewritten to: "init_ee_round and commit_via_ee verify node_pubkey matches `validator_reg.identity` (the registered cold key) — not the transaction signer." |
| D-4 | Low | FAQ "How do I earn rewards as a validator?": described single-machine setup with identity keypair only. Hot-key-only mode and separate server architecture not mentioned. | Updated to describe recommended separate-server approach with `VALIDATOR_IDENTITY_PUBKEY`. |

### README.md — findings

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| R-1 | High | Step 3 "Set up a hot key" still showed `VALIDATOR_KEYPAIR + X1_RANDOMNESS_KEYPAIR` on the same machine. No mention of separate randomness server, `VALIDATOR_IDENTITY_PUBKEY`, `scp`, or `--refresh`. | Replaced with full separate-server setup: generate + fund + rotate on validator server; scp hot key; run on randomness server with `VALIDATOR_IDENTITY_PUBKEY`; `--refresh` recovery. |
| R-2 | Medium | V4.6 changelog daemon section missing `VALIDATOR_IDENTITY_PUBKEY`, `--refresh`, hot-key-only mode description. | Added all three. Updated reward sweep description to cover both modes. |

### CLAUDE.md — findings

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| C-1 | High | `VALIDATOR_KEYPAIR` listed as "required" in env vars. Now optional when `VALIDATOR_IDENTITY_PUBKEY` is set. | Changed description to "Required in full mode; omit in hot-key-only mode." |
| C-2 | High | `VALIDATOR_IDENTITY_PUBKEY` env var missing entirely from daemon env vars table and example commands. | Added entry: base58 public key for hot-key-only mode; requires `X1_RANDOMNESS_KEYPAIR`. |
| C-3 | Medium | No hot-key-only mode example command in "Running the daemons" section. | Added separate-server example with `VALIDATOR_IDENTITY_PUBKEY + X1_RANDOMNESS_KEYPAIR`. |
| C-4 | Medium | `--refresh` flag not documented in commands section or env vars. | Added to example commands with note it must run on validator server. |

### AUDIT.md — stale reference fixes

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| A-1 | Low | Daemon PASS section said secrets at `/tmp/vd-secrets-*.json` — path was updated in V4.2 to `~/.config/x1randomness/vd-secrets-<prefix>.json` but AUDIT.md carried the old text. | Updated to correct path with clarifying note. |
| A-2 | Low | V4.6 H-3 fix description said "scan pairs `[{identity}, {hotKey}]` (deduplicated when equal)" — oversimplified; hot-key-only mode only scans hotKey. | Updated description to cover both modes. |

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

---

## External Audit — Piotr (2026-05-27) — Post-V4.6 patch

External audit submitted 2026-05-27. Review against V4.6 code performed same day.

### Finding 1 — Silent `refresh_validator_status` failure

**As reported:** `refresh_validator_status` returned `Ok(())` even when stake/vote checks failed, setting `active = false` silently. Daemon could not distinguish success from failure without re-reading the account.

**Post-V4.6 status:** ✅ **FIXED in V4.6.** Handler now returns explicit `InsufficientValidatorStake` (0x178c) or `ValidatorNotActivelyVoting` (0x178d). Daemon correctly interprets these and applies exponential backoff (`60 * 2^n` seconds, max 900s).

### Finding 2 — `StakeDeactivating` misidentified as `InsufficientValidatorStake`

**As reported:** Sentinel validator (604k XNT, stake deactivating) triggered an unhelpful error: operator found 604k XNT on the account (well above 1000 XNT minimum) but the program reported insufficient stake. Root cause: `Err(_) => false` catch-all in the stake match swallowed `StakeDeactivating` from `parse_stake_account` and mapped it to `stake_ok = false`, which then returned `InsufficientValidatorStake`. Operator had no way to diagnose the real cause.

**Post-V4.6 status:** ⚠️ **Present in V4.6 as shipped.** Fixed in post-V4.6 patch (this session, 2026-05-27):

- **`lib.rs`** — `refresh_validator_status` catch-all replaced with direct error propagation:
  ```rust
  // Before
  let stake_ok = match parse_stake_account(&stake_data) {
      Ok((voter, lamports)) => voter == reg.vote_account && lamports >= MIN_VALIDATOR_STAKE,
      Err(_) => false,   // StakeDeactivating silently became InsufficientValidatorStake
  };
  // After
  match parse_stake_account(&stake_data) {
      Ok((voter, lamports)) => {
          if voter != reg.vote_account || lamports < MIN_VALIDATOR_STAKE {
              return err!(RandomnessError::InsufficientValidatorStake);
          }
      }
      Err(e) => return Err(e),   // StakeDeactivating (0x1792) propagates correctly
  }
  ```
- **`validator-daemon.js`** — Added `StakeDeactivating` (0x1792) branch with actionable message: *"Stake is deactivating — re-delegate or use a new stake account."* Fixed stale backoff comment that incorrectly said "program returns Ok(()) even when stake/vote checks fail" (true pre-V4.6, false now).

*Audit conducted as part of V4 decentralisation release.*

---

## Complete Repo Audit — 2026-05-27 (post hot-key-only mode)

**Scope:** Full line-by-line re-audit of all keeper scripts and program handlers following the hot-key-only daemon mode implementation. Triggered after significant structural changes (identity/hot-key separation, `--refresh` flag, new `VALIDATOR_IDENTITY_PUBKEY` env var).

**Files audited:**
- `keeper/validator-daemon.js` (1017 lines)
- `keeper/run-round.js` (577 lines)
- `keeper/register.js` (344 lines)
- `programs/randomness-wrapper/src/lib.rs` — key instruction handlers: `commit_via_ee`, `reveal_via_ee`, `init_ee_round`, `claim_validator_reward`, `refresh_validator_status`, account struct layouts
- `tests/mainnet-e2e.js` — instruction builder account lists

### All-account cross-check: JS daemon vs Rust structs

Every account array in the daemon was verified against the corresponding Rust `#[derive(Accounts)]` struct:

| Instruction | JS accounts | Rust accounts | Match? |
|-------------|-------------|---------------|--------|
| `commit_via_ee` | 10 (cfg, pool, wr, ee_round, contributor/hot_key, val_reg, vote, stake, system, ee_v4) | 10 | ✅ |
| `reveal_via_ee` | 7 (cfg, wr, ee_round, validator_reveal, contributor/hot_key, system, ee_v4) | 7 | ✅ |
| `init_ee_round` | 9 (cfg, wr, ee_round, coordinator, coordinator_reg, vote, stake, system, ee_v4) | 9 | ✅ |
| `refresh_validator_status` | 3 (reg, vote, stake) | 3 (permissionless — no signer) | ✅ |
| inline claim (sweep) | 4 (vr, escrow, ee_round, contributor/hot_key) | 4 | ✅ |

### Identity/hot-key correctness

| Check | Result |
|-------|--------|
| `isEligible()` uses `identityPubkey` for hash (stable across rotations) | ✅ |
| Rust `commit_via_ee` uses `validator_reg.identity` (not signer) for eligibility hash | ✅ |
| Rust `commit_via_ee` verifies vote account's `node_pubkey == validator_reg.identity` (not hot key) | ✅ |
| `init_ee_round` blocked in hot-key-only mode; other validators can call it | ✅ |
| `cancel_round` blocked in hot-key-only mode with actionable warning | ✅ |
| `--refresh` blocked in hot-key-only mode | ✅ |
| `send()` default signers `[identity ?? hotKey]` safe when identity is null | ✅ |
| `sweepUnclaimedRewards` scanPairs handles both full and hot-key-only mode | ✅ |
| Secrets file keyed by identity pubkey in both modes | ✅ |

### register.js

| Check | Result |
|-------|--------|
| `register_validator` account list (reg_pda, identity, vote, stake, system) | ✅ |
| `deregister_validator` account list (reg_pda, identity) | ✅ |
| PDA derivation `["val-reg", identity]` matches Rust | ✅ |
| `parseRegistration` reads V4.6 layout (171 bytes); safely reads `hotKey` at offset 139 when `data.length >= 171` | ✅ |
| Keypair loading uses PKCS#8 DER wrapper for Ed25519 seed (correct) | ✅ |

### Findings

**LOW-1 — Dead `ixClaimReward` function (validator-daemon.js, lines 379-393)**
Function was defined but never called — `sweepUnclaimedRewards` builds the claim instruction inline. The inline version is identical and correct. The dead function was removed.
**Status: FIXED**

**LOW-2 — Unused `totalUnclaimed` variable (validator-daemon.js)**
`let totalUnclaimed = 0` was declared and incremented per-pair but never read or logged. Variable removed.
**Status: FIXED**

**LOW-3 — Daemon incorrectly blocked `init_ee_round` in hot-key-only mode (validator-daemon.js)**
The Rust `InitEeRound` constraint explicitly accepts both identity and hot key as coordinator signer: `coordinator_reg.identity == coordinator.key() || coordinator_reg.x1_randomness_authority == coordinator.key()`. The daemon incorrectly guarded both first-init and next-round-init blocks with `if (hotKeyOnlyMode) { ... return; }`, preventing hot-key-only daemons from ever opening rounds. The `ixInitEeRound` function also derived the `val-reg` PDA from the coordinator signer key instead of always using `identityPubkey` (the PDA seed is always the cold identity). Fixed: removed both guards; `ixInitEeRound` now always uses `identityPubkey` for the val-reg PDA; both init call sites use `hotKey` as coordinator+signer in hot-key-only mode and `identity` in full mode. Cancel-round coordinator check also updated to recognise when the hot key was the coordinator (hot-key-only daemon can now cancel its own stuck rounds directly).
**Status: FIXED**

**LOW-4 — Stale test account lists (tests/mainnet-e2e.js, no production impact)**
`buildCommitViaEe` and `buildInitEeRound` in the test file are missing accounts added in V4.6: `entropy_pool`, `validator_reg`, `vote_account`, `stake_account` for commit; real vote/stake accounts (not dummy) for init_ee_round. Additionally, `payer` (protocol authority key) is not a registered validator, so tests 10-13 (commit/reveal/finalize) would fail against the live program regardless.

The production daemon `ixCommit`, `ixReveal`, and `ixInitEeRound` have the correct account lists (verified above). The tests are not run in CI and serve as integration probes — updating them requires a registered test validator key and is a low-priority task.
**Status: NOTED (not fixed — test-only, no production path affected)**

### Result: protocol flow is correct post hot-key-only implementation

The hot-key-only mode implementation is sound. `identityPubkey` is used wherever the on-chain program uses `validator_reg.identity` (PDA seeds, eligibility check). `hotKey` is used wherever the program checks `x1_randomness_authority` (signing for commit/reveal/claim). The separation is enforced consistently in both the daemon and the Rust program.

---

## V4.7 Full Security Audit — 2026-05-29

**Trigger:** Operator report of stuck rounds and unexplained XNT drain on validator hot keys. Multi-angle automated audit covering the full repository — Rust program, crank, validator daemon, cancel script, and frontend.

**Audit method:** 9 independent automated finders (line-by-line diff, removed-behavior, cross-file callers, language pitfalls, economic attacks, validator selection logic, daemon lifecycle, gap sweep) × parallel agents. All findings verified before inclusion.

**Program deployed:** V4.7 — `BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R`
**Deploy tx:** `8T3xQASVC1mRwPaS82QUoKy6K9NQ1g6U2eTr78FPV4rtnXX6Z9PEgvbt39MS99yvrYeHJkL9WDhtMoGoFMnbh28`
**Commit:** `8e33402`

### Summary

| Area | Issues Found | Fixed | Open |
|------|-------------|-------|------|
| Anchor program (`lib.rs`) | 8 | 7 | 1 |
| Keeper crank (`run-round.js`) | 2 | 2 | 0 |
| Validator daemon (`validator-daemon.js`) | 4 | 4 | 0 |
| Cancel script (`cancel-ee-round.js`) | 1 | 1 | 0 |
| **Total** | **15** | **14** | **1** |

The summary table in the top-level header has been updated to reflect this audit.

---

### Anchor Program — V4.7 findings

| ID | Severity | Instruction | Issue | Fix |
|----|----------|-------------|-------|-----|
| A7-C1 | **Critical** | `run-round.js hasFees()` | Read `original_fees` at byte offset 24, which is only written inside `distribute_fees` itself and is therefore always 0 before distribution. `hasFees()` always returned false. The crank skipped `distribute_fees` every round with "No fees (no requests this round)", leaving all validator rewards locked since commit `1753b1d`. | Changed `readBigUInt64LE(24)` to `readBigUInt64LE(8)` (`pending_fees`, set by every `request_randomness` call). |
| A7-H1 | **High** | `mark_validator_missed` | No per-(validator, EE round) idempotency guard. All checks (binding_slot guard, EE round ownership, reveal PDA lamports==0) pass identically on repeated calls with the same accounts. An attacker could call the instruction 5 times in a single block to instantly deactivate any validator. Cost to attacker: gas only. | Added `ValidatorMissRecord` PDA (`seeds: [b"miss-record", ee_round, identity]`). Anchor `init` constraint rejects the instruction if the PDA already exists — one miss per (validator, round) enforced. Caller pays rent for the 9-byte record. |
| A7-H2 | **High** | `reveal_via_ee` / `mark_validator_missed` | `reveal_via_ee` seeded `ValidatorReveal` PDA with `contributor.key()` (the actual signer), which could be identity OR hot key. `mark_validator_missed` derived the expected PDA using `x1_randomness_authority`. If a rotated validator called `reveal_via_ee` with their identity key (allowed by the constraint), the reveal PDA landed at `[identity]` but `mark_validator_missed` looked at `[x1_randomness_authority]` — different address, lamports==0, false miss recorded. After 5 rounds, validator deactivated. | `RevealViaEe` now requires `contributor.key() == validator_reg.x1_randomness_authority` (new `validator_reg` account enforces this). PDA seed changed to `x1_randomness_authority` — always deterministic. `mark_validator_missed` also accepts the identity-keyed PDA as a fallback to handle reveals made before this upgrade. `ValidatorReveal.contributor` now stores `x1_randomness_authority` (not the signer key). |
| A7-H3 | **High** | `request_randomness` (queue path) | Queue-path `RequestState` accounts (`fulfilled=false`) created when the pool was stale had no fulfillment or recovery path once the EE round that serviced their protocol round completed successfully. `refund_request` requires `!fee_distributed` (blocked after success). `close_request` requires `fulfilled==true` (blocked). No `fulfill_queued_request` instruction existed. Requester paid the fee and received neither output nor refund — funds permanently trapped in the RequestState and escrow. | Added permissionless `fulfill_queued_request` instruction: delivers `SHA256(pool_entropy ‖ request_id ‖ slot_hash)` to any unfulfilled `RequestState` once the pool is warm and fresh (staleness guard matches fast path). Requester or any crank can call it. Increments `total_requests_served`. |
| A7-M1 | **Medium** | `create_fee_escrow` / `refund_request` | `create_fee_escrow` stamped `fee_escrow.ee_v4_round_id` with `protocol_config.ee_v4_round_id` at creation time (the previous EE round ID, call it K). The EE round that actually services this protocol round is K+1 (opened by `init_ee_round`). If K+1 was cancelled, `aggregate_from_ee` never ran, so the escrow retained the stale ID K. `refund_request` required `ee_round_id_in_account == fee_escrow.ee_v4_round_id`, so K+1 ≠ K — refunds permanently blocked for all cancelled rounds. Queued user fees frozen with no recourse. | `init_ee_round` now stamps `fee_escrow.ee_v4_round_id = ee_round_id` at round-open time. Fee escrow immediately holds the correct EE round ID. `refund_request` now matches correctly when that round is cancelled. |
| A7-M2 | **Medium** | `game_seed` | No pool staleness guard. `entropy_available` stays true indefinitely after first aggregation. A watcher who monitors the public `current_entropy` value can pre-compute all `game_seed` outputs for remaining slot hashes in the sysvar window once the pool is stale (>21,600 slots old), enabling outcome prediction and bet-timing attacks. `request_randomness` had a matching guard; `game_seed` did not. | Added staleness check: `slots_since_agg <= STALENESS_HARD_LIMIT_SLOTS` (21,600 slots) before computing output. Pool must be both available and fresh. |
| A7-L1 | **Low** | `rotate_randomness_authority` | No validation on `new_authority`. Setting `new_authority = Pubkey::default()` (all-zeros) or `SystemProgram::id()` made `mark_validator_missed` always succeed (no one can create a reveal PDA seeded by these keys), effectively self-bricking the validator's miss-resistance. | Added `require!(new_authority != Pubkey::default() && new_authority != System::id())`. |
| A7-L2 | **Low** | `claim_validator_reward` | `ValidatorReveal` PDA (82 bytes, ~0.00146 XNT rent) was never closed after claim — `claimed` was set to `true` but the account remained open with no close instruction. At 5 reveals/round × ~10 rounds/day, this permanently locked ~0.073 XNT/day across all validators with no reclaim path. | Added `close = contributor` to the `validator_reveal` account in `ClaimValidatorReward`. Rent returns to contributor on each successful claim. |

**Open finding (not fixed — future upgrade):**

| ID | Severity | Issue | Status |
|----|----------|-------|--------|
| A7-F1 | **Low** | `FeeEscrow` (42 bytes, ~0.001 XNT rent) can never be closed after `distribute_fees` sets `fee_distributed = true`. `close_escrow` requires `!fee_distributed`. The escrow must remain open until all validators have called `claim_validator_reward`, but no cleanup instruction exists afterward. Rent accumulates at ~0.01 XNT/day. Fix requires a `close_distributed_escrow` instruction gated on `pending_fees == 0 && fee_distributed == true`. Deferred — low cost per round; worth batching with next protocol upgrade. | Open |

---

### Keeper Crank — V4.7 findings (all fixed)

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| A7-C1 | Critical | `hasFees()` reads wrong offset — see program findings above. | Fixed in `run-round.js`. |
| A7-M3 | **Medium** | `aggregate_from_ee` error handler caught only `"already"` and `"0x0"`. When called on a cancelled EE round (status=3), the program returns `EeV4RoundNotFinalized` — not caught — crank threw and entered an infinite retry loop every 30 seconds, blocking `advance_round` and all forward protocol progress indefinitely. | Added `"EeV4RoundNotFinalized"` and `"0x1775"` to the catch list in both step-1b and step-7. Cancelled rounds now log and continue rather than crashing. Applied to both occurrences in `runRound()`. |

---

### Validator Daemon — V4.7 findings (all fixed)

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| A7-M4 | **Medium** | `isEligible()` check at line 461 returned early from `runOnce()` for non-selected validators, preventing execution of all round lifecycle code (cancel stuck rounds, open next EE round, clear stale secrets, sweep rewards). In the worst case, if all selected validators were offline, no validator would ever call `cancel_round` or `init_ee_round`, permanently stalling the protocol even after slot-hash expiry. | Moved eligibility check from a function-level gate to a per-section guard. Non-selected validators now execute the full lifecycle (cancel, init-next-round, sweep rewards); only the commit block is gated by `eligible`. |
| A7-M5 | **Medium** | Daemon used `bindingSlot` (offset 66, `init_slot + 675`) as the reveal window boundary. The actual `reveal_deadline` is at offset 58 (`init_slot + ~600`), approximately 75 slots (~28 seconds) earlier. Reveals submitted in the gap between `reveal_deadline` and `bindingSlot` failed on-chain with `WrongPhase`, clearing secrets and recording a miss — even though the validator had committed correctly. | Read `revealDeadline` from offset 58. Reveal section now uses `cur >= commitDeadline && cur < revealDeadline` as the window check. `eeAcct` is also re-read fresh immediately before the reveal section to avoid stale status from the (possibly long) commit section. |
| A7-M6 | **Medium** | `ixReveal` did not include the `validator_reg` account. The V4.7 `RevealViaEe` struct adds `validator_reg` to enforce `contributor == x1_randomness_authority`. Existing daemon would fail with account count mismatch. | Added `{ pubkey: reg, isSigner: false, isWritable: false }` at position 5 in `ixReveal`'s key list. |
| A7-L3 | **Low** | `ixInitEeRound` did not include the `fee_escrow` account. The V4.7 `InitEeRound` struct adds `fee_escrow` as a required writable account for the EE round ID stamp. | Added `fee_escrow` (writable) at position 7 in `ixInitEeRound`. Function now takes `protocolRound` as a parameter to derive the escrow PDA. Both call sites updated. |

---

### Cancel Script — V4.7 findings (all fixed)

| ID | Severity | Issue | Fix |
|----|----------|-------|-----|
| A7-L4 | **Low** | `cancel-ee-round.js` checked `coordinator.equals(identity.publicKey)` and exited with an error if the round was opened by a hot key. In hot-key-only mode (the recommended setup), the EE round PDA is seeded by the hot key. Operators with a stuck CommitPhase round opened by a hot key had no manual escape hatch — they had to wait for the slot-hash expiry path in the daemon (~512 slots / ~3.2 minutes after binding slot). | Added `X1_RANDOMNESS_KEYPAIR` env var support. Script now accepts either `VALIDATOR_KEYPAIR` (cold identity) or `X1_RANDOMNESS_KEYPAIR` (hot key) as the coordinator keypair. Usage header updated with both invocation forms. |

---

### Security Model — V4.7 additions

| Vector | Mitigated? | Notes |
|--------|-----------|-------|
| Spam deactivation via `mark_validator_missed` | ✅ Mitigated (V4.7) | `ValidatorMissRecord` PDA enforces one miss per (validator, EE round). Cost to create: ~0.00064 XNT rent, paid by caller. Cannot be called twice for the same round. |
| False deactivation via identity-keyed reveal | ✅ Mitigated (V4.7) | `RevealViaEe` enforces `contributor == x1_randomness_authority`. Reveal PDA address is now deterministic regardless of which key was used pre-upgrade. |
| Queued request fees permanently locked | ✅ Mitigated (V4.7) | `fulfill_queued_request` allows delivery to orphaned `RequestState` accounts once pool is warm. |
| Pre-computation of `game_seed` from stale pool | ✅ Mitigated (V4.7) | Staleness guard prevents use of entropy older than 21,600 slots. |
| WrapperRound PDA collision (protocol round = EE round ID) | ⚠️ Latent | Protocol round is ~2,383; EE round IDs are ~397,000. Collision at ~394,617 more protocol rounds. Not imminent. Both PDA types share the same seed prefix and discriminator. Fix requires differentiating seed prefixes in a future upgrade. |
| `getProgramAccounts` EE scan hardcodes `dataSize: 838` | ⚠️ Latent | Any EE V4 upgrade changing round account size silently breaks all validator lookups. Monitor EE V4 program upgrades; update constant before upgrading. |

---

## Validator Upgrade Guide — V4.7

**Required action for all validators.** The V4.7 program adds a required account (`validator_reg`) to `reveal_via_ee` and a required account (`fee_escrow`) to `init_ee_round`. Daemons running the pre-V4.7 code will send the wrong account list and every commit/reveal/init transaction will fail.

**Deadline:** Upgrade before the next EE round starts. If your daemon is already running, it will begin failing at the next commit attempt.

---

### Who needs to do what

| Role | Action required |
|------|----------------|
| All validators running `validator-daemon.js` | Pull latest code and restart daemon — **mandatory** |
| Operator running `run-round.js` crank | Pull latest code and restart crank — **mandatory** (hasFees bug fix) |
| Any operator using `cancel-ee-round.js` | Pull latest code — now supports hot key as coordinator |

---

### Upgrade procedure

#### Option A — systemd (recommended for production)

```bash
# 1. Pull the latest code
cd ~/x1-randomness-protocol
git pull

# 2. Install/update dependencies (if keeper/package.json changed)
cd keeper && npm install && cd ..

# 3. Restart the validator daemon
sudo systemctl restart x1randomness-validator

# 4. Confirm it is running and not erroring
sudo systemctl status x1randomness-validator
sudo journalctl -u x1randomness-validator -n 50 --no-pager
```

#### Option B — nohup (manual)

```bash
# 1. Pull latest code
cd ~/x1-randomness-protocol
git pull
cd keeper && npm install && cd ..

# 2. Kill the running daemon
pkill -f validator-daemon.js || true

# 3. Restart in hot-key-only mode (recommended — identity key stays on validator server)
VALIDATOR_IDENTITY_PUBKEY=<your_identity_pubkey_base58> \
X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json \
nohup node keeper/validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# OR restart in full mode (identity key on this machine)
VALIDATOR_KEYPAIR=~/.config/solana/identity.json \
nohup node keeper/validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# 4. Watch the first few polls
tail -f /tmp/validator-daemon.log
```

#### Crank upgrade (owlx1 server)

```bash
cd ~/x1-randomness-protocol
git pull
pkill -f run-round.js || true
CRANK_KEYPAIR=~/.config/solana/x1randomness-key.json \
nohup node keeper/run-round.js --loop > /tmp/crank.log 2>&1 &
tail -f /tmp/crank.log
```

---

### Recommended systemd unit files

#### Validator daemon — hot-key-only mode (separate randomness server)

Save to `/etc/systemd/system/x1randomness-validator.service`:

```ini
[Unit]
Description=X1 Randomness Protocol — Validator Daemon
Documentation=https://github.com/Commoneffort/x1-randomness-protocol
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/x1-randomness-protocol/keeper

# Hot-key-only mode: identity key stays on the validator server.
# Replace YOUR_IDENTITY_PUBKEY with the base58 output of:
#   solana-keygen pubkey ~/.config/solana/identity.json
Environment=VALIDATOR_IDENTITY_PUBKEY=YOUR_IDENTITY_PUBKEY_BASE58
Environment=X1_RANDOMNESS_KEYPAIR=/home/YOUR_USER/.config/solana/x1randomness-hotkey.json

# Optional: stagger multiple daemons to reduce init_ee_round races
# Environment=POLL_MS=13000   # use 13000 on one server, 17000 on another

# Node binary path — adjust for your nvm installation
ExecStart=/home/YOUR_USER/.nvm/versions/node/v22.22.2/bin/node \
  /home/YOUR_USER/x1-randomness-protocol/keeper/validator-daemon.js --loop

Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=x1randomness-validator

# Prevent runaway restarts
StartLimitIntervalSec=300
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
```

#### Validator daemon — full mode (identity key on same machine)

```ini
[Unit]
Description=X1 Randomness Protocol — Validator Daemon (full mode)
Documentation=https://github.com/Commoneffort/x1-randomness-protocol
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/x1-randomness-protocol/keeper

Environment=VALIDATOR_KEYPAIR=/home/YOUR_USER/.config/solana/identity.json
# Optional hot key (V4.6+): if set, identity only signs init_ee_round and refresh
# Environment=X1_RANDOMNESS_KEYPAIR=/home/YOUR_USER/.config/solana/x1randomness-hotkey.json

ExecStart=/home/YOUR_USER/.nvm/versions/node/v22.22.2/bin/node \
  /home/YOUR_USER/x1-randomness-protocol/keeper/validator-daemon.js --loop

Restart=always
RestartSec=15
StandardOutput=journal
StandardError=journal
SyslogIdentifier=x1randomness-validator

StartLimitIntervalSec=300
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
```

#### Crank

```ini
[Unit]
Description=X1 Randomness Protocol — Crank
Documentation=https://github.com/Commoneffort/x1-randomness-protocol
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER/x1-randomness-protocol/keeper

Environment=CRANK_KEYPAIR=/home/YOUR_USER/.config/solana/x1randomness-key.json

ExecStart=/home/YOUR_USER/.nvm/versions/node/v22.22.2/bin/node \
  /home/YOUR_USER/x1-randomness-protocol/keeper/run-round.js --loop

Restart=always
RestartSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=x1randomness-crank

StartLimitIntervalSec=300
StartLimitBurst=5

[Install]
WantedBy=multi-user.target
```

#### Apply systemd changes

```bash
# After creating or editing a unit file:
sudo systemctl daemon-reload
sudo systemctl enable x1randomness-validator   # auto-start on boot
sudo systemctl start x1randomness-validator

# Check status
sudo systemctl status x1randomness-validator

# View live logs
sudo journalctl -u x1randomness-validator -f

# Restart after a git pull upgrade
sudo systemctl restart x1randomness-validator && \
  sudo journalctl -u x1randomness-validator -n 30 --no-pager
```

---

### Verify the upgrade is working

After restarting, look for these lines in the log within the first two poll cycles:

```
── Round XXXX / EE XXXXXX ──────────────────────────
  Selected for EE round XXXXXX        ← eligibility passes
  commit_via_ee: <sig>…               ← account list accepted by new program
```

If you see instead:
```
  Error: Transaction simulation failed: Error processing Instruction 0
```
Your daemon is still sending the old account list. Confirm `git pull` ran and restart.

If you see:
```
  Not selected for EE round XXXXXX — will still manage round lifecycle
```
That is correct — non-selected validators now execute the full lifecycle, which is the V4.7 fix for the `isEligible()` gate bug.

---

### Recovering locked rewards from before V4.7

The `hasFees()` bug caused `distribute_fees` to be skipped for all rounds since commit `1753b1d`. Rewards are sitting in FeeEscrow accounts with `fee_distributed = false`. Once the crank is upgraded, it will call `distribute_fees` on the current round normally. For past rounds with locked fees, the crank does not retroactively process them — those escrows will be swept by the protocol authority via `claim_validator_fees` (dust sweep) in a future maintenance pass.

Validators do not need to take any action for past rounds. Future rounds after V4.7 will distribute normally.
