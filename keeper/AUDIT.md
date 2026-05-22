# Keeper & Protocol Audit — May 2026

Self-audit covering `validator-daemon.js`, `run-round.js`, `cancel-ee-round.js`, the on-chain program `lib.rs`, and all frontend files. Reflects current state after two rounds of fixes: commit `ba0a19c` (previous session) and the fixes applied in this session.

---

## On-Chain Program (`programs/randomness-wrapper/src/lib.rs`)

### No exploitable vulnerabilities found

Reviewed all instruction handlers. Key security properties verified:

**CPI integrity**
- All four CPI instructions into EE V4 enforce `ee_v4_program.key() == ENTROPY_ENGINE_V4` (hardcoded constant). A caller cannot substitute a fake program.
- `finalize_via_ee` enforces `ee_round.owner == ENTROPY_ENGINE_V4`. Prevents injecting crafted entropy via a fake account.

**Fee safety**
- `distribute_fees`: `fee_distributed` flag is checked first — idempotent, cannot be called twice to drain more than 5% to the crank.
- `claim_validator_reward`: `ValidatorReveal.claimed` is checked before transfer and set to `true` atomically. Cannot double-claim.
- `claim_validator_reward`: verifies `ee_round_id_in_account == fee_escrow.ee_v4_round_id`. Prevents a validator who revealed in an older EE round for the same protocol round from draining the escrow.

**Refund safety**
- `refund_request`: requires `fee_escrow.ee_v4_round_id != 0` (set by `aggregate_from_ee`). Blocks refunds before the EE round is linked to the escrow.
- `refund_request`: verifies the EE round ID in the account matches `fee_escrow.ee_v4_round_id`. Prevents cross-round refund replays.

**Entropy integrity**
- Both `finalize_via_ee` and `aggregate_from_ee` read from the `SlotHashes` sysvar — required account. The most-recent slot hash is unknown until after that slot completes, making the entropy mixing unpredictable at submission time.
- `request_randomness` output = `SHA256(pool_entropy ‖ request_id ‖ slot_hash)`. The slot hash at inclusion is unknown at submission — outputs are unpredictable even with known pool entropy.

**Round advancement**
- `advance_round` (H-2 fix): requires `WrapperRound[current_round].aggregated == true` before advancing. Prevents stranding an in-flight EE round with no matching protocol round.

**Validator selection**
- `commit_via_ee`: eligibility derived from `SHA256(entropy ‖ ee_round_id ‖ contributor.pubkey)`. No keeper can control or predict selection for future rounds. With `COMMIT_SELECTION_THRESHOLD = u64::MAX`, all active validators are eligible — this is intentional while the validator set is small, and will be tightened as it grows.

**Hardcoded offsets (EE V4)**
EE V4 (`FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm`) has **no upgrade authority** — it is permanently immutable. All raw offset reads in `lib.rs` and the keeper scripts are safe and cannot be invalidated by a program upgrade. This was misidentified as a risk in one third-party audit.

---

## `validator-daemon.js` — Bugs Fixed This Session

### Fix 1 — STATE_FILE in `/tmp` (slash risk on reboot)
**Severity:** Medium  
**Was:** `const STATE_FILE = \`/tmp/vd-secrets-${...}.json\`;`

On Linux, `/tmp` is typically a tmpfs and is cleared on reboot. If the host reboots during the commit window, the daemon restarts, finds no secrets file, generates new secrets, and fails to reveal with the original commitment — resulting in an unrecoverable commit with no matching reveal. The EE program slashes the 0.01 XNT stake.

**Fix:** Path moved to `~/.config/x1randomness/vd-secrets-<prefix>.json`. The directory is created with `mkdirSync({ recursive: true, mode: 0o700 })` before each write. File permissions remain `0o600`. The validator signing key is **not** stored in this file — only the per-round commit entropy (32-byte secret + 32-byte nonce).

---

### Fix 2 — Redundant commit transactions (retry storm)
**Severity:** Low  
**Was:** On every poll during the commit window (~75 seconds, 5 polls at 15s), the daemon attempted a commit transaction even after the previous one confirmed.

This is wasteful (unnecessary gas, unnecessary RPC load) but not dangerous because the on-chain program handles duplicate commits idempotently. However it creates log noise and increases the chance of a rate-limit error masking a real problem.

**Fix:** Added `committed` boolean to the secrets file. After a successful commit (or confirmed "already committed"), `committed: true` is written. Subsequent polls skip the commit attempt entirely and log `Already committed this round (persisted state)`. The flag is also set in the WrongPhase/isContributor code path. If secrets are absent or `committed: false`, the daemon still retries commit — preserving the safety property against dropped transactions.

---

### Fix 3 — `process.env.HOME` unreliable
**Severity:** Low  
**Was:** `keypairPath.replace(/^~/, process.env.HOME)`

`process.env.HOME` is not guaranteed to be set in all execution environments (e.g., systemd services with `PrivateUsers=yes`, Docker containers, sudo contexts). `os.homedir()` is the correct API — it reads from the password database entry, not just the environment.

**Fix:** Replaced with `os.homedir()` throughout. Added `const os = require("os");` and `const path = require("path");` at top level.

---

### Fix 4 — POLL_MS hardcoded
**Severity:** Low  
**Was:** `const POLL_MS = 15_000;` — hardcoded inside `main()`, not configurable.

Operators running multiple validators cannot stagger poll intervals to reduce the chance of simultaneous `init_ee_round` races and RPC rate pressure. Two validators polling at exactly the same interval will consistently race.

**Fix:** `const POLL_MS = parseInt(process.env.POLL_MS, 10) || 15_000;` — defaults to 15s, overridable via env var. Operators can stagger: `POLL_MS=13000` on validator A, `POLL_MS=17000` on validator B.

---

### Fix 5 — EE round pubkey re-scanned every poll
**Severity:** Low  
**Was:** `conn.getProgramAccounts(EE_V4, { filters: [...] })` called on every `runOnce()` invocation while an EE round was in progress.

`getProgramAccounts` is an expensive RPC call. Calling it at every 15s poll for the duration of a ~675-slot round (~4.2 minutes) = ~17 redundant scans per round. This increases RPC rate-limit risk.

**Fix:** Added `eeRoundCache = new Map()` (module-level). The EE round pubkey is cached on first successful scan and on each `init_ee_round`. Cache is keyed by `eeV4RoundId` (a number). Old entries are never evicted (the Map holds a few entries across the daemon's lifetime — negligible memory cost).

---

## `validator-daemon.js` — Bugs Fixed in `ba0a19c`

### Bug 1 — Reveal WrongPhase not caught from `e.logs`
The EE program emits `0x1771` in `e.logs`, not `e.message`. Reveal catch only checked `e.message` — missed the error and threw fatal. Fixed to check `[e.message, ...(e.logs ?? [])].some(...)`.

### Bug 2 — Reveal attempted past `binding_slot`
`reveal_deadline = init+600`, `binding_slot = init+675`. When `pastBinding && eeRoundStatus === 1`, the old reveal condition `!beforeCommitDeadline && !revealed && eeRoundStatus === 1` was met — sending a reveal that always fails. Fixed by adding `&& !pastBinding` to the reveal guard.

### Bug 3 — `init_ee_round` race threw unhandled error
Two validators simultaneously calling `init_ee_round` — the loser got a constraint error that propagated as fatal. Fixed: on `init_ee_round` failure, re-check if the wrapper PDA exists. If yes: "raced — another validator won", return cleanly. If no: re-throw.

---

## `run-round.js` — Bugs Fixed in `ba0a19c`

### Bug 4 — `send()` had no retry
Single-attempt send — any transient RPC error aborted the full round iteration. Fixed: 3-attempt retry with 5s delay; deterministic simulation failures break immediately.

### Bug 5 — Cancelled EE round caused infinite retry loop
When the validator daemon auto-cancelled a stuck CommitPhase round, `finalize_via_ee` on a status=3 round threw WrongPhase → `runRound()` restarted → tried finalize again → infinite loop. Fixed: check EE status before attempting finalize. status=3: skip finalize, attempt `aggregate_from_ee` directly.

### Bug 6 — Step 3 poll had no progress log
Polling loops printed dots with no time feedback. Fixed: timestamped status line every 2 minutes.

---

## `cancel-ee-round.js` — Fixed This Session

**Was:** Hardcoded `TARGET_EE_ID = 394871n` and stale "EE round 394862 cancelled" comment. Also used `process.env.HOME`.

**Fix:**
- `TARGET_EE_ID` now read from `EE_ROUND_ID` env var (required). Script exits with usage message if not set.
- Final log line is now dynamic: `EE round ${TARGET_EE_ID} cancelled — validator daemons will now open EE round ${TARGET_EE_ID + 1n}.`
- `process.env.HOME` → `os.homedir()`
- `const os = require("os");` added.

---

## Frontend (`src/`)

No vulnerabilities found. Verified:

- All account field offsets in `protocol.ts` match the Rust struct layouts in CLAUDE.md exactly.
- `getProgramAccounts` memcmp filters use `bs58.encode(disc)` — correct encoding.
- `distribute_fees` account parser correctly handles both V4.5 (5 accounts, crank at index 3) and legacy V4.4 (6 accounts, crank at index 4).
- `FeeEscrow` offset 40 = `fee_distributed`, offset 24 = `original_fees` — matches Rust struct.
- `ValidatorReveal` offset 8 = `contributor`, offset 80 = `claimed` — matches Rust struct.
- `getRequestsByRequester` fetches only the `fulfilled` byte (offset 152, length 1) via `dataSlice` — efficient.

---

## Third-Party Audit Review

Two external audits were reviewed. Valid findings were acted on above. Invalid findings:

**R-2 (Strontium / Theo): "claim_validator_reward sends 5 accounts"**  
WRONG. Both `ixClaimReward()` in `validator-daemon.js` and the `ClaimValidatorReward` struct in `lib.rs` use exactly 4 accounts: `validator_reveal`, `fee_escrow`, `ee_round`, `contributor`. This finding was based on pre-`ba0a19c` code.

**R-4 (Theo): "hardcoded EE V4 offsets are dangerous"**  
INVALID. EE V4 (`FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm`) has no upgrade authority and is permanently immutable. There is no upgrade path that could invalidate these offsets.

**R-5 (Theo): "'Stop Claude' bytecode injection**  
INVALID. Flagged as a social-engineering / AI hallucination. No such bytecode exists in the repository (grepped all files). The audit document addressed a "Jimmy" (not the actual operator), confirming it was generated for a different context. No external URLs were fetched as instructed.

**O-6 (Theo): "No sweep for unclaimed rewards"**  
WRONG. `sweepUnclaimedRewards()` has existed in `validator-daemon.js` since `ba0a19c`. It scans all `ValidatorReveal` PDAs with `claimed=false`, batch-fetches escrows, and claims any with `fee_distributed=true`.

---

## Remaining Operational Notes

### Dual ValidatorReveal PDAs per contributor (expected)
Some protocol rounds have two `ValidatorReveal` PDAs per contributor (one from an abandoned EE round, one from the successful one). `sweepUnclaimedRewards()` attempts both — one fails with `InvalidEeV4RoundResult` (0x1784, EE round ID mismatch), one succeeds. No funds are lost. The failure log is low-priority noise.

### No explicit `reveal_deadline` read
The daemon approximates the reveal window as `commitDeadline ≤ cur < bindingSlot`. This is correct since `revealDeadline = init+600 < bindingSlot = init+675`. The 75-slot gap between `revealDeadline` and `bindingSlot` where a reveal would technically fail is handled by the WrongPhase catch in the reveal block.

### Poll jitter (mitigated)
Validators can now set `POLL_MS` independently to stagger polling. Remaining risk: two validators starting at the same time with the same `POLL_MS` will still occasionally race on `init_ee_round`. The race is handled gracefully — the loser returns cleanly — but the collision is still wasteful. Low priority with only 2 validators.
