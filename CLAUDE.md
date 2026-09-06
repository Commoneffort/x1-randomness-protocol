# CLAUDE.md

Guidance for Claude Code working in this repository.

## Operator docs

- `VALIDATORS.md` — validator-facing guide: registration, hot-key rotation,
  running the daemon, what normal idle behaviour looks like, and the two kinds
  of upgrade (program-only vs coordinated).
- `docs/V4.8-SPEC.md` — the next coordinated upgrade (reset `consecutive_misses`
  on reveal). Specified, not scheduled. Daemons update **before** the deploy.

## Build

Use plain `anchor build` — the `--tools-version` flag is no longer supported by the installed `cargo-build-sbf` version and will fail:

```bash
anchor build
```

IDL generation fails with an `anchor-syn` compile error (proc-macro API). This is expected and harmless — the `.so` compiles correctly in the same invocation; ignore the IDL error.

### Cargo.lock pins

If `Cargo.lock` is regenerated for any reason, immediately re-pin:

`Cargo.lock` is **not tracked**, so every clean build re-resolves and picks up
whatever has been published since. `cargo-build-sbf` bundles rustc **1.84.1**,
which cannot parse `edition2024` manifests, so the resolution has to be walked
back by hand. The `--precise` selector names the version *currently in the lock*,
not the one you want — `-p proc-macro-crate@3.5.0 --precise 3.2.0`, not
`-p "proc-macro-crate@3.2.0"`, which silently matches nothing.

Working set as of 2026-08-24 (apply in this order — `proc-macro-crate` first,
because it drags `toml_edit` → `indexmap` → `hashbrown` up with it):

```bash
cargo update -p blake3 --precise 1.7.0                          # else digest 0.11 → block-buffer 0.12
cargo update -p proc-macro-crate@3.5.0 --precise 3.2.0          # else toml_edit 0.25 → indexmap ^2.13
cargo update -p indexmap@2.14.0 --precise 2.7.1                 # else hashbrown 0.17
cargo update -p unicode-segmentation@1.13.2 --precise 1.12.0    # requires rustc 1.85
```

Each failure names its own offender (`requires rustc 1.85.0`, or `feature
edition2024 is required`), so if a new one appears, pin it the same way and add
it here. A successful build prints `Compiling randomness-wrapper` then
`Finished \`release\` profile`; the `anchor-syn`/`source_file` error *after*
that is the IDL step and is expected — see above.

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

An upgrade **net** costs well under 0.1 XNT, but `solana program deploy` first
stages the whole `.so` in a buffer account and needs that rent *available* up
front — **~5.03 XNT for a 721 KB program** — refunded when the buffer is closed
at the end of the deploy. Budget for the buffer, not the net. Check the balance
first (`solana balance ~/.config/solana/x1randomness-key.json --url https://rpc.mainnet.x1.xyz`);
the deploy aborts if it is short. Measured 2026-08-24: 6.106 → 6.040 XNT
across a full upgrade cycle (net 0.066).

### V4.8 — deployed slot 76974985

**Coordinated upgrade.** `reveal_via_ee` resets `consecutive_misses` and stamps
`last_round_participated` / `last_active_slot`. `validator_reg` became `mut`, so
daemons had to pass it writable *before* the deploy — see `docs/V4.8-SPEC.md`
for the ordering argument and `VALIDATORS.md` for the operator steps.

No account layout change and no migration: all three fields already existed in
the 171-byte `ValidatorRegistration`.

Deploy sig: `4xUDZpzBTCCnpZ1FEJq1DMS2to2QV1F5H3E4zTKaABaCoxrCVtW26oL3SiNGBbsRwj7rVq8RTBBEB1nfJPPLqdLt`

### V4.7.1 — deployed 2026-08-24, slot 73906137

**No coordination required. Validators need to do nothing.** Program-only change:
no account layout changed, no instruction account list changed, so every running
`validator-daemon.js` keeps working untouched across the upgrade.

`mark_validator_missed` now proves a miss from the EE round's own contributor
table instead of from the absence of the `ValidatorReveal` PDA. This closes the
remote DoS described under "NEVER BUILD A GENERAL `mark_validator_missed` CRANK"
below — `claim_validator_reward` closes that PDA, so claiming a reward used to
convert an honest round into markable evidence of a miss.

Verified by simulation against the deployed program (validator `8byEUEZ2…`):

| EE round | in committee | revealed | reveal PDA | result |
|---|---|---|---|---|
| 407330 | yes | yes | closed by claim | rejected `0x1774` Unauthorized |
| 407331 | no (n=7 < 8 active) | — | absent | rejected `0x1793` NotSelectedForRound |
| 399967 | yes | no | absent | **markable** — genuine miss preserved |

The third row is the point: a genuinely dead node is still evictable, so
`mark_validator_missed` remains usable for its one legitimate purpose.

`EE_V4_N_CONTRIBUTORS` stays 7 and `EE_V4_M_THRESHOLD` stays 5.

Deployed bytes verified byte-identical to `target/deploy/randomness_wrapper.so`
(sha256 `5e4248a0…`) by `solana program dump`.

### V4.7 post-upgrade sequence (2026-05-29)

No on-chain migration required. Restart daemons and crank immediately — old V4.6 daemons will fail reveals and inits because `reveal_via_ee` and `init_ee_round` have new required accounts.

```bash
# All validators: git pull and restart
cd ~/x1-randomness-protocol && git pull && cd keeper && npm install && cd ..
pkill -f validator-daemon.js

# Recommended: hot-key-only mode (identity pubkey, not the secret key)
VALIDATOR_IDENTITY_PUBKEY=<your_identity_pubkey_base58> \
X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json \
nohup node keeper/validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# owlx1 server specifically (hot-key-only):
VALIDATOR_IDENTITY_PUBKEY=8byEUEZ2sMfP6RPX9VD8JCvCQK3F5FG2LytcR9TkVWag \
X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json \
nohup node keeper/validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# Crank restart (owlx1):
pkill -f run-round.js
CRANK_KEYPAIR=~/.config/solana/x1randomness-key.json \
nohup node keeper/run-round.js --loop > /tmp/crank.log 2>&1 &
```

**What changed in V4.7 that breaks old daemons:**
- `reveal_via_ee` — added `validator_reg` account (position 5 in key list). Old daemon sends 7 accounts, program now requires 8. Reveals rejected.
- `init_ee_round` — added `fee_escrow` account (position 7 in key list). Old daemon sends 9 accounts, program now requires 10. Round-opening rejected.
- No account migration needed (new PDAs like `ValidatorMissRecord` are created on demand, not pre-migrated).

**Locked rewards from pre-V4.7:** The `hasFees()` bug (offset 24 instead of 8) caused the crank to skip `distribute_fees` every round since commit `1753b1d`. Rewards accumulated in FeeEscrow accounts with `fee_distributed = false`. The upgraded crank will distribute normally going forward. Locked pre-V4.7 escrows will be swept by the protocol authority via `claim_validator_fees` in a future maintenance pass.

### V4.6 post-upgrade sequence

After deploying V4.6, run these steps immediately (before any validator daemon activity):

```bash
# 1. Run the migration — reallocates all ValidatorRegistration accounts 139→171 bytes
PAYER_KEYPAIR=~/.config/solana/x1randomness-key.json node keeper/migrate-v46.js

# 2. Restart all validator daemons
pkill -f validator-daemon.js
VALIDATOR_KEYPAIR=~/.config/solana/identity.json nohup node keeper/validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# 3. Optionally rotate to a hot key (can be done any time after migration)
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/x1randomness-hotkey.json
VALIDATOR_KEYPAIR=~/.config/solana/identity.json node keeper/validator-daemon.js --rotate-authority $(solana-keygen pubkey ~/.config/solana/x1randomness-hotkey.json)
```

**Why immediate migration matters:** Until `migrate_validator_registration` is called for each account, ALL instructions that use `Account<ValidatorRegistration>` (commit, refresh, init_ee_round, mark_validator_missed) will fail with a deserialization error. The migration window should be < 30 seconds for 9 validators.

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
                         n=EE_V4_N_CONTRIBUTORS(7), m=EE_V4_M_THRESHOLD(5),
                         binding_slot=current+EE_V4_MIN_BINDING_SLOTS(675) — derived on-chain
                         NOTE: n=7 requires 7 of 9 active validators to commit per round;
                         m=5 means 5 reveals suffice to finalize (2 may miss the reveal window).
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
val_hash    = SHA256(round_seed ‖ validator_reg.identity)   ← identity, not hot key
selector    = val_hash[0..8] as u64
eligible    = selector < COMMIT_SELECTION_THRESHOLD
```

Using `identity` (not the signing key) keeps selection probability stable across hot-key rotations.

`COMMIT_SELECTION_THRESHOLD = u64::MAX` currently (all active validators eligible). Lower this constant as the validator set grows to cap expected committee size probabilistically.

### Keeper vs validator daemon

| Process | Keys held | Purpose |
|---|---|---|
| `run-round.js` (crank) | Crank key only | Calls permissionless on-chain cranks. Zero protocol authority. |
| `validator-daemon.js` | Identity key (or hot key post-V4.6) | Each validator runs independently. Monitors chain, commits, reveals, claims rewards. |

The crank has no special power — any node can replace it. Stopping the crank delays round advancement but cannot corrupt randomness.

**Running the daemons:**
```bash
# Crank — owlx1 server (uses deploy key):
CRANK_KEYPAIR=~/.config/solana/x1randomness-key.json nohup node run-round.js --loop > /tmp/crank.log 2>&1 &

# Crank — xen_cat server (uses identity key, redundant):
CRANK_KEYPAIR=~/.config/solana/identity.json nohup node run-round.js --loop > /tmp/crank.log 2>&1 &

# Validator daemon (one per validator, uses identity key):
VALIDATOR_KEYPAIR=~/.config/solana/identity.json nohup node validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# Validator daemon with hot key — separate randomness server (recommended, V4.6+):
# Run this on a dedicated machine; identity.json stays on the validator server only.
VALIDATOR_IDENTITY_PUBKEY=<identity_pubkey_base58> X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json nohup node validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# Full mode (identity + hot key on same machine, less recommended):
VALIDATOR_KEYPAIR=~/.config/solana/identity.json X1_RANDOMNESS_KEYPAIR=~/.config/solana/hotkey.json nohup node validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &

# First-time validator registration (no npm needed — uses only Node.js built-ins):
node keeper/register.js \
  --keypair ~/.config/solana/identity.json \
  --vote    <vote_account_pubkey> \
  --stake   <stake_account_pubkey>

# Check registration status:
node keeper/register.js --status --keypair ~/.config/solana/identity.json

# Deregister a validator (also no npm needed):
node keeper/register.js --deregister --keypair ~/.config/solana/identity.json

# Post-V4.6 upgrade: run migration immediately after deploying the new .so
PAYER_KEYPAIR=~/.config/solana/x1randomness-key.json node keeper/migrate-v46.js

# Rotate to a hot key (after migration, on validator server):
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/x1randomness-hotkey.json
VALIDATOR_KEYPAIR=~/.config/solana/identity.json node validator-daemon.js --rotate-authority $(solana-keygen pubkey ~/.config/solana/x1randomness-hotkey.json)

# Reactivate an inactive validator (run on validator server where identity.json lives):
VALIDATOR_KEYPAIR=~/.config/solana/identity.json node validator-daemon.js --refresh
```

**Validator daemon env vars:**
- `VALIDATOR_KEYPAIR` — path to identity keypair (cold key). Required in full mode; omit in hot-key-only mode. Used for `init_ee_round`, `refresh_validator_status`, `rotate_randomness_authority`, `register_validator`, `deregister_validator`.
- `VALIDATOR_IDENTITY_PUBKEY` — base58 public key of the validator identity. Use instead of `VALIDATOR_KEYPAIR` in hot-key-only mode (identity secret key stays on the validator server). Requires `X1_RANDOMNESS_KEYPAIR`.
- `X1_RANDOMNESS_KEYPAIR` — optional (V4.6+); path to hot keypair for commit/reveal/claim. If unset, identity key is used for all operations. Required in hot-key-only mode.
- `POLL_MS` — optional; poll interval in milliseconds (default 15000). Stagger multiple validators to reduce `init_ee_round` races: `POLL_MS=13000` on one, `POLL_MS=17000` on another.
- `RPC_URL` — optional; RPC endpoint (default `https://rpc.mainnet.x1.xyz`)

**Per-round secrets file:** `~/.config/x1randomness/vd-secrets-<pubkeyPrefix>.json` — stores only the 32-byte commit entropy and nonce for the current EE round. Created with mode `0o600`; directory with `0o700`. Does NOT contain the validator signing key.

**Idle gate (V4.3):** Both the crank and validator daemon check before opening any new EE round: if the entropy pool is warm (< 21 600 slots stale) AND there are no unfulfilled `RequestState` accounts on-chain, they idle and re-poll without sending any transactions. A round starts automatically when a queued request appears or the pool goes stale. Running both processes costs nothing when the protocol is idle. The 21 600-slot threshold matches `STALENESS_HARD_LIMIT_SLOTS` and reduces crank cost from ~43 → ~3 XNT/month.

**init_ee_round responsibility**: The validator daemon calls `init_ee_round` (NOT the crank). The daemon gates this call on the current EE round being Finalized (status=2) or Cancelled (status=3) — it will NOT advance to the next EE round while the current one is still in progress. The crank polls for the EE WrapperRound PDA in step 3 and waits for a validator daemon to create it.

**Hot-key-only mode — `init_ee_round` supported**: The Rust program accepts either the cold identity key OR the hot key (`x1_randomness_authority`) as the coordinator signer for `init_ee_round`. Daemons in hot-key-only mode use the hot key as coordinator — the EE round PDA is seeded by the signer key, but the `val-reg` account lookup still uses the cold identity (PDA seed `["val-reg", identity]`). All validators can open rounds regardless of whether they run in full or hot-key-only mode.

## ⚠ NEVER BUILD A GENERAL `mark_validator_missed` CRANK

**Resolved in V4.8 (slot 76974985) — kept because the reasoning still governs
`mark_validator_missed`, and because a crank across the registry is still a bad
idea.** `reveal_via_ee` now resets `consecutive_misses`, so misses are no longer
cumulative for the lifetime of a registration: any validator that reveals clears
its own counter. What follows describes the hazard as it stood before that, and
why the eviction path is shaped the way it is.

`EE_V4_N_CONTRIBUTORS` (7) is smaller than the active validator set, so commit
slots fill first-come and a *different* validator is shut out of every round.
A crank that called `mark_validator_missed` across the registry would give each
excluded validator a permanent miss, the exclusion would rotate, and **every
validator would hit `VALIDATOR_MAX_CONSECUTIVE_MISSES` (5) and deactivate in
roughly forty rounds — a few days.** This has never happened only because no
such crank exists. Do not write one.

### It is worse than an internal footgun — it is a remote DoS

`mark_validator_missed` is an on-chain instruction on a permissionless program.
**Nothing about the attack requires this repository.** Anyone who knows the
program ID can derive the discriminator and call it.

And it does not take forty rounds. `claim_validator_reward` closes the
`ValidatorReveal` PDA (`close = contributor`), while `mark_validator_missed`
proves a miss only by checking `expected_reveal_pda.lamports() == 0`. So **once
a validator claims its reward, the proof that it revealed is destroyed and that
round becomes retroactively markable as a miss.** Claiming is automatic in
`validator-daemon.js` (`sweepUnclaimedRewards`), so nearly every historical
round qualifies.

Measured on mainnet 2026-08-24: 2 795 finalized EE rounds available as
ammunition, `miss_record` rent 0.000954 XNT, so **0.0048 XNT deactivates one
validator and 0.043 XNT deactivates the entire set**, in a single burst of ~45
transactions. Verified concretely: round 407330, `8byEUEZ2…` was a contributor
and revealed, yet is markable because it has claimed.

Calling it on a *single* named dead validator is safe and is the only
permissionless way to evict a node whose operator is unreachable
(`deregister_validator` takes `identity: Signer`, so it is self-only).

**Mitigation in place:** `run-round.js` runs `resetAccumulatedMisses()` every
crank cycle (throttled to 5 min). It scans the registry and calls the
permissionless `refresh_validator_status` on any validator with
`consecutive_misses > 0`, which resets the counter — but only succeeds if that
validator's vote is live and its stake still qualifies, so a genuinely dead node
stays evictable. Since a validator can gain at most one miss per round (the
miss-record PDA is seeded by round *and* identity) and rounds are hours apart,
five can never be reached *from ordinary round exclusion* while any crank is
running. The guard is adaptive: it backs off to 5 minutes while every counter
reads zero and re-checks every cycle as soon as one does not.

**This is a keeper-side guard, not a fix.** It holds only while a crank is up,
and against a deliberate attacker it bounds the damage to one crank cycle of
downtime per burst rather than preventing it. The real fix needs a program
change, and there are two parts to it:

1. ~~reset `consecutive_misses` in `reveal_via_ee`~~ — **done in V4.8**
   (slot 76974985).
2. ~~stop `claim_validator_reward` closing the `ValidatorReveal` PDA, or have
   `mark_validator_missed` prove absence some other way~~ — **done in V4.7.1**,
   which proves a miss from the EE round's contributor table, so closing the PDA
   is harmless.

Both parts are now shipped. `resetAccumulatedMisses()` stays in `run-round.js`
as a backstop for counters accrued before V4.8 and for validators whose reveals
fail for unrelated reasons; it is nearly free while every counter reads zero.

## Security constraints (added V2.2 — do not remove)

- **`ee_v4_program`** — all four CPI instructions enforce `address = ENTROPY_ENGINE_V4`. Cannot pass a fake program.
- **`ee_round` ownership** — `finalize_via_ee` enforces `ee_round.owner == ENTROPY_ENGINE_V4`. Prevents fake entropy injection via crafted accounts.
- **`init_ee_round`** — permissionless. Protected by: (1) `ee_round_id` must equal `protocol_config.ee_v4_round_id + 1` (strictly sequential), and (2) n/m/binding_slot are **protocol constants**, not caller-supplied — caller cannot override committee size or threshold.
- **On-chain validator selection** — `commit_via_ee` enforces entropy-derived eligibility. No external actor can decide who commits.
- **Slot hash mixing** — both `finalize_via_ee` and `aggregate_from_ee` read the most-recent hash from the SlotHashes sysvar. SlotHashes account is **required** in both instructions.
- **`request_randomness` output** — `SHA256(pool_entropy ‖ request_id ‖ slot_hash)`. Slot hash is unknown at submission time, preventing pre-computation even with known pool entropy.
- **`fee_distributed` flag** — `distribute_fees` is idempotent. `claim_validator_reward` requires `fee_distributed == true`.
- **`claim_validator_fees` (dust sweep)** — recipient restricted to `protocol_config.authority`, not arbitrary wallets.
- **`verify_entropy`** — requires a fulfilled `RequestState`. `derived_output` copied from stored value, not recomputed.
- **Staleness hard limit** — pool entropy older than `STALENESS_HARD_LIMIT_SLOTS` (21 600 slots ≈ 2.25 hours) routes `request_randomness` to the queue path instead of the fast path. Matches the keeper idle gate threshold.
- **`deliver_callback`** — requires a `caller: Signer` (permissionless crank but must sign).
- **Key separation (V4.6)** — `rotate_randomness_authority` requires the `identity` cold key to sign. The hot key (`x1_randomness_authority`) can sign `commit_via_ee`, `reveal_via_ee`, `claim_validator_reward`. It cannot register, refresh, deregister, or rotate — those still require the identity key. Eligibility hash always uses `identity`, not the hot key, so selection is stable across rotations.
- **`reveal_via_ee` enforces `contributor == x1_randomness_authority` (V4.7)** — the ValidatorReveal PDA is seeded by `x1_randomness_authority` (not the raw signer key), making the PDA address deterministic and consistent with `mark_validator_missed`. `validate_reg` is a required account in the instruction.
- **`mark_validator_missed` idempotency (V4.7)** — a `ValidatorMissRecord` PDA (`seeds: [b"miss-record", ee_round, identity]`) is created per call. Anchor's `init` constraint rejects repeated calls for the same (validator, round) pair, preventing spam-deactivation attacks.
- **`game_seed` staleness guard (V4.7)** — rejects pool entropy older than `STALENESS_HARD_LIMIT_SLOTS` (21,600 slots), matching the `request_randomness` fast-path limit. Prevents outcome pre-computation from known stale entropy.
- **`fulfill_queued_request` (V4.7)** — new permissionless instruction that delivers entropy to `RequestState` accounts stuck with `fulfilled=false` after a successful round. Resolves queue-path requests that would otherwise be permanently unresolvable.
- **NEVER reduce `MIN_EE_M_THRESHOLD`** — a stuck round is recoverable via `cancel_round`; biasable randomness is not. Do not lower thresholds to unstick a round.

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

### Per-validator reward flow (V4.5, updated V4.7)

```
reveal_via_ee()          → creates ValidatorReveal PDA [b"validator-reveal", ee_round, x1_randomness_authority]
                           (V4.7: seed changed from contributor.key() to x1_randomness_authority for determinism)
distribute_fees()        → records original_fees on FeeEscrow; pays 5% to crank immediately
claim_validator_reward() → pays original_fees × 95% ÷ reveal_count to contributor
                           reads reveal_count from EE V4 round data at offset 75
                           (V4.7: closes ValidatorReveal PDA on claim — returns ~0.00146 XNT rent)
```

Each validator gets one claim per round. `claim_validator_reward` closes the `ValidatorReveal` PDA (V4.7) and rejects if already claimed.

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

### EntropyPool (75 bytes — V4.3 appended `total_game_seeds`)

Seeds: `[b"entropy-pool"]`

| Offset | Field |
|--------|-------|
| 8–39   | `current_entropy` ([u8; 32]) |
| 40–47  | `current_round` (u64) |
| 48     | `entropy_available` (bool) |
| 49–56  | `last_aggregated_slot` (u64) |
| 57–64  | `total_requests_served` (u64) |
| 65     | `ee_v4_entropy_included` (bool) |
| 66     | `bump` (u8) |
| 67–74  | `total_game_seeds` (u64) — appended V4.3; account was 67 bytes before migration |

> **Note:** Existing accounts were 67 bytes until `migrate_entropy_pool` was called (mainnet: 2026-05-19). Any raw deserializer must check `data.len() >= 75` before reading offset 67.

### FeeEscrow (42 bytes — V3 added `original_fees`, security fixes added `ee_v4_round_id`)

| Offset | Field |
|--------|-------|
| 8 | `pending_fees` (u64) |
| 16 | `round` (u64) |
| 24 | `original_fees` (u64) — total fees before crank cut (V4.5); used for per-validator 95% share |
| 32 | `ee_v4_round_id` (u64) — EE V4 round that services this protocol round |
| 40 | `fee_distributed` (bool) |
| 41 | `bump` (u8) |

> **Note:** `fee_distributed` moved from offset 32 → 40 when `ee_v4_round_id` was added. `refund_request` verifies the EE round's stored round_id matches `fee_escrow.ee_v4_round_id` to prevent cross-round refund attacks.

### ValidatorRegistration (171 bytes — V4.6 grew from 139)

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
| 136    | `consecutive_misses` (u8) — 5+ triggers deactivation (V4.6; was 3) |
| 137    | `active` (bool) |
| 138    | `bump` (u8) |
| 139–170 | `x1_randomness_authority` (Pubkey) — hot key for commit/reveal; equals identity until `rotate_randomness_authority` is called. **Appended V4.6.** |

> **Migration (V4.6):** Existing 139-byte accounts must be migrated immediately after upgrading the program. Run `PAYER_KEYPAIR=~/.config/solana/x1randomness-key.json node keeper/migrate-v46.js`. Until migrated, ALL instructions that deserialize `ValidatorRegistration` will fail. Any raw deserializer must check `data.len() >= 171` before reading offset 139.

Constants: `MIN_VALIDATOR_STAKE = 1000 XNT`, `VALIDATOR_MAX_INACTIVE_SLOTS = 500`, `MIN_COMMITTEE_SIZE = 2`, `VALIDATOR_MAX_CONSECUTIVE_MISSES = 5`

### ValidatorReveal (82 bytes — added V3)

| Offset | Field |
|--------|-------|
| 8–39 | `contributor` (Pubkey) — stores `x1_randomness_authority` (V4.7; was the raw signer key before) |
| 40–71 | `ee_round` (Pubkey) |
| 72–79 | `protocol_round` (u64) |
| 80 | `claimed` (bool) |
| 81 | `bump` (u8) |

Seeds: `[b"validator-reveal", ee_round.key(), x1_randomness_authority.key()]`

> **V4.7 change:** Seed was previously `contributor.key()` (the raw signer, which could be identity or hot key). Now always uses `x1_randomness_authority` so `mark_validator_missed` can derive the address deterministically. `reveal_via_ee` enforces `contributor == x1_randomness_authority`. PDA is **closed on claim** (V4.7) — rent returned to contributor.

### ValidatorMissRecord (9 bytes — added V4.7)

Seeds: `[b"miss-record", ee_round.key(), identity.key()]`

| Offset | Field |
|--------|-------|
| 8 | `bump` (u8) |

Created by `mark_validator_missed` as an idempotency guard. One record per (validator, EE round). The Anchor `init` constraint prevents calling the instruction twice for the same pair.

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
| 48 | `n_contributors` (u8) | currently 7 (= EE_V4_N_CONTRIBUTORS) |
| 49 | `m_threshold` (u8) | currently 5 (= EE_V4_M_THRESHOLD) |
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

**Phase transition**: status transitions from CommitPhase→RevealPhase only when `commit_count == n_contributors`. With n=7, all 7 selected validators must commit before reveals can begin. Finalization requires m=5 reveals. If the reveal window expires without enough reveals, call `cancel_round` on the EE program directly (coordinator must sign + pass committed contributor wallets as remaining_accounts).

**cancel_round** (EE program direct call, not via wrapper):
- Required when: status=CommitPhase (0) and round is stuck (reveal window passed, not enough commits)
- Signer: round coordinator (validator who called init_ee_round)
- remaining_accounts: committed contributor wallets in order (for stake refund)
- Script: `keeper/cancel-ee-round.js` — accepts identity key OR hot key depending on which opened the round:
  ```bash
  # If round was opened with identity key (full mode):
  EE_ROUND_ID=<id> VALIDATOR_KEYPAIR=~/.config/solana/identity.json node cancel-ee-round.js
  # If round was opened with hot key (hot-key-only mode):
  EE_ROUND_ID=<id> X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json node cancel-ee-round.js
  ```

**Stuck rounds and protocol liveness (V4.7):** When a round gets stuck (CommitPhase or RevealPhase) and the slot hash expires (`cur > binding_slot + 512` ≈ 7.4 min after binding), the V4.7 daemon abandons it and opens the next EE round regardless. The stuck round becomes an orphan — committed stakes stay locked in the EE round PDA until the coordinator manually calls `cancel_round`. The protocol keeps progressing. Rounds do NOT need to be cancelled for the protocol to advance; cancellation is only needed to recover committed stakes.

## Fee economics

| Item | Amount |
|------|--------|
| Standard request fee | 0.01 XNT (default for all dApps) |
| Premium request fee | 0.05 XNT (high-volume dApps — set via `update_dapp_fee`) |
| Game seed fee | 0.001 XNT |
| EE V4 stake | 0.01 XNT (fully returned on valid reveal) |
| Crank reward | 5% to `distribute_fees` caller (V4.5) — paid immediately from FeeEscrow |
| Insurance fund | removed in V4.5 (was 5% in V4.4) |
| Validator share | 95% ÷ reveal_count via `claim_validator_reward` (was 90% in V4.4) |

Premium tier is set by the protocol authority calling `update_dapp_fee` after a dApp registers. Validators earn more per round from premium dApps, directly incentivising liveness for high-value use cases.

**Crank reward (V4.5):** `distribute_fees` pays 5% of `original_fees` immediately to the caller (`crank` account in the Accounts struct). Any wallet running `run-round.js` earns this reward. The `crank` account must be a `Signer` with `isWritable: true` — the program transfers lamports directly from the FeeEscrow. No extra PDA or claim step needed.

**No insurance fund (V4.5):** The insurance_fund account was removed from `DistributeFees`. The `insurance_fund` field still exists in `ProtocolConfig` on-chain (layout unchanged) but is no longer used for fee distribution. Dust from rounding errors flows to the protocol authority via `claim_validator_fees` instead.
