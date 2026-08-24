# Validator guide — X1 Randomness Protocol

For operators running a node in the randomness validator set.

- **Program:** `BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R`
- **Entropy Engine V4:** `FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm`
- **RPC:** `https://rpc.mainnet.x1.xyz`
- **Repo:** `https://github.com/Commoneffort/x1-randomness-protocol`

---

## What you actually run

One process: `keeper/validator-daemon.js`. It watches the chain and, when a
round is open and you are selected, commits, reveals, and claims your share of
the fees. Nothing else is required of you.

You do **not** run the program. The program lives on chain — a protocol upgrade
is deployed once, by the upgrade authority, and takes effect for everyone at
that instant. Pulling this repo never changes which program you talk to.

There is also `keeper/run-round.js` (the "crank"), which advances rounds. It is
permissionless and holds no authority — anyone may run it, and one or two
instances for the whole network is enough. You do not need to run it, though a
second independent crank is welcome for redundancy.

---

## Requirements

- An X1 validator with a vote account and **≥ 1000 XNT** of active stake
  (`MIN_VALIDATOR_STAKE`). Stake is re-verified at every refresh.
- Node.js 18+.
- A small XNT balance on the signing key for transaction fees and the
  0.01 XNT commit bond (the bond is returned in full when you reveal).

---

## First-time registration

Run this on the machine holding your validator identity key:

```bash
git clone https://github.com/Commoneffort/x1-randomness-protocol
cd x1-randomness-protocol

node keeper/register.js \
  --keypair ~/.config/solana/identity.json \
  --vote    <your_vote_account_pubkey> \
  --stake   <your_stake_account_pubkey>

# confirm
node keeper/register.js --status --keypair ~/.config/solana/identity.json
```

`register.js` uses only Node built-ins — no `npm install` needed for this step.

### Then rotate to a hot key (strongly recommended)

So your validator identity secret never has to sit on the randomness machine:

```bash
# on the validator server, where identity.json lives
solana-keygen new --no-bip39-passphrase -o ~/.config/solana/x1randomness-hotkey.json

VALIDATOR_KEYPAIR=~/.config/solana/identity.json \
  node keeper/validator-daemon.js --rotate-authority \
  $(solana-keygen pubkey ~/.config/solana/x1randomness-hotkey.json)
```

Copy **only** `x1randomness-hotkey.json` to the machine that will run the daemon.

The hot key can commit, reveal, and claim rewards. It **cannot** register,
refresh, deregister, or rotate — those still require the identity key. Your
selection probability is hashed from your *identity*, not the hot key, so
rotating never changes how often you are picked.

---

## Running the daemon

**Hot-key-only mode — recommended.** The identity secret stays on the validator
server; the randomness box holds only the hot key.

```bash
cd x1-randomness-protocol/keeper && npm install && cd ..

VALIDATOR_IDENTITY_PUBKEY=<your_identity_pubkey_base58> \
X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json \
nohup node keeper/validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &
```

**Full mode** — identity key on the same machine. Simpler, less safe:

```bash
VALIDATOR_KEYPAIR=~/.config/solana/identity.json \
nohup node keeper/validator-daemon.js --loop > /tmp/validator-daemon.log 2>&1 &
```

Prefer a systemd unit or pm2 over `nohup` so the daemon survives a reboot.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `VALIDATOR_IDENTITY_PUBKEY` | hot-key mode | Base58 identity pubkey. Pairs with `X1_RANDOMNESS_KEYPAIR`. |
| `X1_RANDOMNESS_KEYPAIR` | hot-key mode | Path to the hot keypair used for commit/reveal/claim. |
| `VALIDATOR_KEYPAIR` | full mode | Path to the identity keypair. |
| `POLL_MS` | no | Poll interval, default 15000. **Please set a distinct value** — see below. |
| `RPC_URL` | no | Default `https://rpc.mainnet.x1.xyz`. |

**Stagger your `POLL_MS`.** Whichever daemon notices first opens the round and
pays its rent. If every operator polls on the same 15 s boundary you all race
and waste fees. Pick something off-grid and unique — `POLL_MS=13000`,
`17000`, `19000`, `23000`.

### Per-round secrets

`~/.config/x1randomness/vd-secrets-<pubkeyPrefix>.json`, mode `0600`, holds the
current round's 32-byte commit entropy and nonce and nothing else. It does not
contain any signing key. Losing it mid-round costs you that round's reveal and
bond, nothing more.

---

## What normal operation looks like

**Long idle stretches are correct.** The protocol only opens a round when there
is a queued request or the entropy pool has gone stale (21 600 slots, ≈ 2.25 h).
A daemon printing *"pool warm, no pending requests, idling"* for hours is
healthy and is deliberately spending nothing.

**Being left out of a round is not a fault.** The committee is
`EE_V4_N_CONTRIBUTORS = 7` and there are more than seven active validators, so
commit slots fill first-come and someone is excluded from every round. Which
someone rotates. Missing a round you were never selected for is not a miss, is
not held against you, and cannot deactivate you.

**Finalization needs 5 of 7** (`EE_V4_M_THRESHOLD = 5`), so two of the seven can
fail to reveal without stalling the round.

### Checking your own status

```bash
node keeper/register.js --status --keypair ~/.config/solana/identity.json
```

Look at `active`, `consecutive_misses`, and `last_active_slot`. Or watch the
validators page on the dashboard.

A validator deactivates at `VALIDATOR_MAX_CONSECUTIVE_MISSES = 5`. Reactivate
with, on the validator server:

```bash
VALIDATOR_KEYPAIR=~/.config/solana/identity.json \
  node keeper/validator-daemon.js --refresh
```

This succeeds only if your vote is live and your stake still qualifies.

### Rewards

95 % of each round's fees are split among the validators who revealed; you claim
your own share, and the daemon does it automatically. The remaining 5 % goes to
whoever cranked `distribute_fees`. Your 0.01 XNT commit bond comes back in full
on a valid reveal.

---

## How protocol upgrades are coordinated

Upgrades come in two kinds, and the difference decides whether you have to do
anything.

### Kind A — program-only. You do nothing.

The on-chain program changes but no account layout and no instruction account
list changes. Your daemon keeps working across the deploy without a restart.
You will be told an upgrade happened; there is no action for you.

*Example: V4.7.1 (2026-08-24), which hardened `mark_validator_missed`.*

### Kind B — coordinated. Daemon changes required.

The instruction account lists change, so daemon and program must agree. These
are scheduled in advance and always follow the same order:

1. **Announcement** — a dated notice naming the change, the git commit, and the
   deploy window.
2. **Every operator updates first**, inside the window:
   ```bash
   cd x1-randomness-protocol
   git pull
   cd keeper && npm install && cd ..
   pkill -f validator-daemon.js
   # then re-run your usual start command from "Running the daemon" above
   ```
   Confirm you are on the announced commit: `git rev-parse --short HEAD`.
3. **Deploy happens after everyone confirms.** The upgrade authority deploys and
   posts the deploy slot.

**Why operators go first, and why that is safe:** these upgrades add accounts,
or widen an existing account from read-only to writable. Anchor checks that a
required-writable account *is* writable; it does **not** reject an account that
is writable when the program only needed to read it. So a new daemon talking to
the old program is fine, while an old daemon talking to the new program fails
every reveal. Updating daemons first therefore gives zero downtime; deploying
first would break the set until the last operator caught up.

If you miss the window, you simply pull and restart late — you lose the rounds
in between, and your bond for any round you commit to but cannot reveal.

### Next scheduled upgrade: V4.8

`reveal_via_ee` will reset `consecutive_misses` to 0 on a successful reveal.
Today misses only ever accumulate over the life of a registration, and are
cleared only by `register_validator` or `refresh_validator_status`. This is a
Kind B upgrade: `validator_reg` becomes writable in `reveal_via_ee`, so daemons
must be updated before the deploy. See `docs/V4.8-SPEC.md`. **Not yet
scheduled — no action required until announced.**

---

## Troubleshooting

**"My node is not committing."** In order:

1. Is the daemon alive? `pgrep -af validator-daemon.js`
2. Is it idling on purpose? A warm pool with no requests means no rounds. Check
   the log for the idle message.
3. Is *any* round advancing? If no round has opened for hours and the pool is
   stale, the crank is stuck — that is a network-wide symptom, not yours.
4. Are you simply the one excluded this round? Normal, see above.
5. `node keeper/register.js --status …` — are you `active`?

**Dashboard says "not committing" but you are fine.** The page flags a validator
only after roughly two full round intervals of silence. During a long idle
stretch nobody commits, because there is nothing to commit to.

**A round is stuck and you opened it.** Rounds do not need to be cancelled for
the protocol to advance — the daemon abandons a stuck round once the slot hash
expires and opens the next one. Cancelling only recovers the committed bonds:

```bash
EE_ROUND_ID=<id> X1_RANDOMNESS_KEYPAIR=~/.config/solana/x1randomness-hotkey.json \
  node keeper/cancel-ee-round.js     # or VALIDATOR_KEYPAIR= if you opened it in full mode
```

**Leaving the set.** `node keeper/register.js --deregister --keypair ~/.config/solana/identity.json`.
Self-only — it takes `identity: Signer`, so nobody can deregister you.
