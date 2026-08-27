//! Randomness Wrapper V2 — Service Layer over EntropyEngine V4
//!
//! This program provides the dApp-facing service layer (dApp registration,
//! entropy pool, game seeds, callbacks, fee distribution, agent subscriptions)
//! while delegating all commit/reveal/finalize/slash operations to the
//! on-chain EntropyEngine V4 program via CPI.
//!
//! Architecture:
//!   - EE V4 handles: round init, commit, reveal, finalize, slash, cancel
//!   - Wrapper handles: dApp reg, entropy pool, request randomness, game seeds,
//!     agent subscriptions, callback delivery, fee escrow, entropy receipts

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::solana_program::program::invoke;

declare_id!("BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R");

// ── Constants ────────────────────────────────────────────────────────────────

pub const ENTROPY_ENGINE_V4: Pubkey = pubkey!("FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm");
pub const RANDOMNESS_FEE_LAMPORTS: u64 = 10_000_000;
pub const MAX_SUBSCRIPTIONS: u32 = 100;
pub const EE_V4_STAKE: u64 = 10_000_000; // matches EE V4 STAKE_LAMPORTS
pub const MIN_SLOTS_BETWEEN_ROUNDS: u64 = 75;
pub const STALENESS_THRESHOLD_SLOTS: u64 = 300;
pub const STALENESS_HARD_LIMIT_SLOTS: u64 = 21_600;
pub const GAME_SEED_FEE_LAMPORTS: u64 = 1_000_000;
pub const MIN_EE_M_THRESHOLD: u8 = 2;

// ── Validator registry constants ─────────────────────────────────────────────
/// 1 000 XNT minimum stake to register as a protocol validator.
pub const MIN_VALIDATOR_STAKE: u64 = 1_000 * 1_000_000_000;
/// If a validator's last vote is older than this many slots they are considered
/// offline at check time. 500 slots ≈ 3 minutes at ~375 ms/slot.
pub const VALIDATOR_MAX_INACTIVE_SLOTS: u64 = 500;
/// After this many consecutive rounds without revealing, the validator is
/// automatically marked inactive by mark_validator_missed.
/// Raised from 3 → 5 for n=7: with 9 validators and 7 commit slots, 2 validators
/// miss each round on average, so threshold 3 deactivated unlucky validators too aggressively.
pub const VALIDATOR_MAX_CONSECUTIVE_MISSES: u8 = 5;
/// Minimum number of distinct validators that must commit in any EE V4 round.
pub const MIN_COMMITTEE_SIZE: u8 = 2;
/// Maximum committee size per EE V4 round — up to 10 validators may commit.
pub const MAX_COMMITTEE_SIZE: u8 = 10;
/// Minimum binding slot offset for EE V4 rounds (~4.2 min at 375 ms/slot).
pub const EE_V4_MIN_BINDING_SLOTS: u64 = 675;
/// Premium per-request fee for high-volume dApps (casinos, games). Set via
/// update_dapp_fee. Standard fee is RANDOMNESS_FEE_LAMPORTS (0.01 XNT).
pub const PREMIUM_REQUEST_FEE_LAMPORTS: u64 = 50_000_000; // 0.05 XNT
/// Eligibility threshold for commit_via_ee. Derived from pool entropy + round id
/// + validator pubkey. u64::MAX means all active validators are eligible (default
/// while the validator set is small). Lower this as the set grows to cap committee
/// size probabilistically — e.g. u64::MAX/10*7 targets ~70% eligibility.
pub const COMMIT_SELECTION_THRESHOLD: u64 = u64::MAX;
/// Number of commit slots per EE V4 round.
///
/// n=7 with 8 validators running means a tolerance of exactly one: a single
/// outage still fills the round (rounds 407331–407336 each filled 7/7 with
/// nothing spare), a second leaves `commit_count` short of n, so the round never
/// leaves CommitPhase and must be cancelled. Lowering n to 6 would restore a
/// tolerance of two; that is deliberately *not* done — the committee size is held
/// at 7 and liveness headroom is to come from adding validators instead.
///
/// The consequence is that (active − n) validators are excluded from each round,
/// rotating. That is routine, not a fault, and must never be recorded as one —
/// see `mark_validator_missed`, which refuses to mark a validator that was not in
/// the committee.
///
/// Never set above MAX_COMMITTEE_SIZE (10) — the size of EE V4's ContributorEntry
/// array — and never below EE_V4_M_THRESHOLD.
pub const EE_V4_N_CONTRIBUTORS: u8 = 7;
/// Reveal threshold — minimum reveals required to finalise the EE round.
/// m=5 of n=7 means the round survives up to 2 non-reveals after the commit phase.
pub const EE_V4_M_THRESHOLD: u8 = 5;

// Verified on-chain layout constants (X1/Solana, confirmed against live accounts):
// VoteState: 4-byte version prefix | node_pubkey[4..36] | authorized_withdrawer[36..68]
//   | commission[68] | votes_len u64[69..77] | LandedVote×N from [77]
//   LandedVote = latency u8(1) + slot u64(8) + confirmation_count u32(4) = 13 bytes
// StakeState: tag u32[0..4] | Meta[4..124] | Delegation: voter_pubkey[124..156]
//   | stake u64[156..164] | activation_epoch[164..172] | deactivation_epoch[172..180]
pub const VOTE_VOTES_LEN_OFFSET: usize = 69; // VoteState V3 (disc 2): votes len u64 offset
pub const VOTE_ENTRY_SIZE: usize = 13; // LandedVote (latency u8 + slot u64 + conf u32)
pub const VOTE_SLOT_OFFSET_IN_ENTRY: usize = 1; // after latency byte
// VoteState V4 (SIMD-0185, discriminant 3). A larger header precedes the votes VecDeque:
//   4(disc)+32(node)+32(withdrawer)+32(inflation_rewards_collector)+32(block_revenue_collector)
//   +2(inflation_bps)+2(block_bps)+8(pending_delegator_rewards) = 144, then
//   Option<bls_pubkey_compressed> (1-byte tag; +48 if Some), then votes len (u64).
pub const VOTE_V4_BLS_OPTION_OFFSET: usize = 144;
pub const VOTE_V4_VOTES_LEN_OFFSET_NONE: usize = 145; // bls = None
pub const VOTE_V4_BLS_SOME_EXTRA: usize = 48; // added when bls = Some
pub const VOTE_STATE_V3: u32 = 2;
pub const VOTE_STATE_V4: u32 = 3;
pub const MAX_LOCKOUT_HISTORY: usize = 64; // sanity cap on decoded vote count (tower holds <=31)
// EE V4 Round contributor table. `contributors: [ContributorEntry; 10]` starts at
// offset 158; each entry is 68 bytes:
//   pubkey[0..32] | commitment[32..64] | revealed u8[64] | 3 bytes reserved
// `commit_count` (offset 74) says how many entries are populated.
//
// Verified against 263 live rounds with 0 < reveal_count < commit_count: the number
// of entries with revealed == 1 equals reveal_count in every one, and the flagged
// positions vary between rounds (0111111, 1111110, 1011111), so this is a genuine
// per-contributor flag rather than an artefact of the count.
//
// This table is the protocol's permanent, authoritative record of who committed and
// who revealed. Unlike the ValidatorReveal PDA it is never closed, which is the
// whole reason `mark_validator_missed` proves absence from here.
pub const EE_CONTRIBUTORS_OFFSET: usize = 158;
pub const EE_CONTRIBUTOR_ENTRY_SIZE: usize = 68;
pub const EE_CONTRIBUTOR_REVEALED_OFFSET: usize = 64;
pub const EE_COMMIT_COUNT_OFFSET: usize = 74;

pub const STAKE_TAG_OFFSET: usize = 0;
pub const STAKE_VOTER_PUBKEY_OFFSET: usize = 124;
pub const STAKE_LAMPORTS_OFFSET: usize = 156;
pub const STAKE_DEACTIVATION_EPOCH_OFFSET: usize = 172;
pub const STAKE_VARIANT_ACTIVE: u32 = 2;
pub const DEACTIVATION_EPOCH_NONE: u64 = u64::MAX;
/// Offset of node_pubkey (32 bytes) in VoteState account data (after 4-byte version tag).
pub const VOTE_NODE_PUBKEY_OFFSET: usize = 4;
/// Anchor account discriminator for DappRegistration: sha256("account:DappRegistration")[:8]
pub const DAPP_REGISTRATION_DISC: [u8; 8] = [3, 84, 148, 231, 130, 18, 2, 52];

// ── EE V4 CPI Shims ──────────────────────────────────────────────────────────
// These mirror EntropyEngine V4's instruction interface for CPI calls.

/// Discriminators for EE V4 instructions (Anchor format: sha256("global:<method>")[..8])

fn anchor_disc(method: &str) -> [u8; 8] {
    let h = hash(method.as_bytes()).to_bytes();
    let mut arr = [0u8; 8];
    arr.copy_from_slice(&h[..8]);
    arr
}


#[error_code]
pub enum RandomnessError {
    #[msg("Insufficient fee provided")]
    InsufficientFee,
    #[msg("Entropy pool not available")]
    EntropyPoolNotAvailable,
    #[msg("DApp not registered")]
    DappNotRegistered,
    #[msg("DApp already registered")]
    DappAlreadyRegistered,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Round not yet aggregatable")]
    RoundNotAggregatable,
    #[msg("Round already aggregated")]
    RoundAlreadyAggregated,
    #[msg("No pending requests")]
    NoPendingRequests,
    #[msg("Request not yet fulfilled")]
    RequestNotFulfilled,
    #[msg("Agent subscription not found")]
    AgentSubscriptionNotFound,
    #[msg("Agent already subscribed")]
    AgentAlreadySubscribed,
    #[msg("Subscription limit reached")]
    SubscriptionLimitReached,
    #[msg("Round interval not met")]
    RoundIntervalNotMet,
    #[msg("CPI to EntropyEngine V4 failed")]
    EeV4CpiFailed,
    #[msg("Fee escrow balance insufficient")]
    FeeEscrowInsufficient,
    #[msg("Invalid callback instruction discriminator")]
    InvalidCallbackDiscriminator,
    #[msg("CPI callback failed")]
    CallbackFailed,
    #[msg("EE V4 round not found")]
    EeV4RoundNotFound,
    #[msg("EE V4 round not finalized")]
    EeV4RoundNotFinalized,
    #[msg("Invalid EE V4 round result")]
    InvalidEeV4RoundResult,
    #[msg("Round advancement too early")]
    RoundAdvanceTooEarly,
    #[msg("EE V4 round was cancelled — request can be refunded")]
    EeRoundCancelled,
    #[msg("Validator reward already claimed")]
    RewardAlreadyClaimed,
    #[msg("Request already fulfilled — cannot refund")]
    RequestAlreadyFulfilled,
    #[msg("Validator already registered")]
    ValidatorAlreadyRegistered,
    #[msg("Validator not registered")]
    ValidatorNotRegistered,
    #[msg("Validator is inactive — refresh status or re-register")]
    ValidatorInactive,
    #[msg("Insufficient validator stake — minimum 1000 XNT required")]
    InsufficientValidatorStake,
    #[msg("Validator not actively voting")]
    ValidatorNotActivelyVoting,
    #[msg("Stake account is not delegated to the provided vote account")]
    StakeNotDelegatedToVote,
    #[msg("Invalid stake account format")]
    InvalidStakeAccount,
    #[msg("Invalid vote account format")]
    InvalidVoteAccount,
    #[msg("Committee too small — minimum 3 validators required")]
    CommitteeTooSmall,
    #[msg("Stake is deactivating — cannot use as proof")]
    StakeDeactivating,
    #[msg("Validator not selected for this round")]
    NotSelectedForRound,
    #[msg("Account discriminator mismatch — wrong account at this address")]
    AccountDiscriminatorMismatch,
    #[msg("Account already migrated to current layout")]
    AlreadyMigrated,
}

// ── State ─────────────────────────────────────────────────────────────────────

#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub insurance_fund: Pubkey,
    pub current_round: u64,
    pub current_round_start_slot: u64,
    pub ee_v4_round_id: u64,         // Tracks which EE V4 round we're consuming
    pub total_rounds: u64,
    pub request_fee: u64,
    pub bump: u8,
}
impl ProtocolConfig {
    pub const INIT_SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1;
}

#[account]
pub struct EntropyPool {
    pub current_entropy: [u8; 32],
    pub current_round: u64,
    pub entropy_available: bool,
    pub last_aggregated_slot: u64,
    pub total_requests_served: u64,
    pub ee_v4_entropy_included: bool,
    pub bump: u8,
    pub total_game_seeds: u64,  // appended in V4.3 — offset 67, realloc on first game_seed call
}
impl EntropyPool {
    pub const INIT_SPACE: usize = 8 + 32 + 8 + 1 + 8 + 8 + 1 + 1 + 8;
}

#[account]
pub struct DappRegistration {
    pub dapp_id: Pubkey,
    pub callback_program: Pubkey,
    pub callback_instruction: [u8; 8],
    pub min_round_interval: u64,
    pub last_served_round: u64,
    pub total_requests: u64,
    pub authority: Pubkey,
    pub fee_override: u64,      // 0 = use protocol default; non-zero overrides request fee for this dApp
    pub bump: u8,
}
impl DappRegistration {
    // disc(8)+dapp_id(32)+callback_program(32)+callback_instruction(8)+min_round_interval(8)
    // +last_served_round(8)+total_requests(8)+authority(32)+fee_override(8)+bump(1) = 145
    pub const INIT_SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 32 + 8 + 1;
}

#[account]
pub struct ValidatorReveal {
    pub contributor: Pubkey,
    pub ee_round: Pubkey,
    pub protocol_round: u64,
    pub claimed: bool,
    pub bump: u8,
}
impl ValidatorReveal {
    // disc(8)+contributor(32)+ee_round(32)+protocol_round(8)+claimed(1)+bump(1) = 82
    pub const INIT_SPACE: usize = 8 + 32 + 32 + 8 + 1 + 1;
}

/// Idempotency guard for mark_validator_missed: one record per (EE round, validator identity).
/// Seeds: [b"miss-record", ee_round_pubkey, identity]
#[account]
pub struct ValidatorMissRecord {
    pub bump: u8,
}
impl ValidatorMissRecord {
    pub const INIT_SPACE: usize = 8 + 1; // disc(8) + bump(1)
}

/// On-chain record for a registered protocol validator.
/// Seeds: [b"val-reg", identity.key()]
#[account]
pub struct ValidatorRegistration {
    /// The cold identity key — used to register, rotate authority, and prove vote ownership.
    pub identity: Pubkey,
    /// Their X1 vote account.
    pub vote_account: Pubkey,
    /// The stake account used as 1000 XNT proof (checked at register + refresh).
    pub stake_account: Pubkey,
    /// Lamports verified at last check.
    pub verified_stake: u64,
    pub registered_slot: u64,
    /// Updated each time refresh_validator_status succeeds.
    pub last_active_slot: u64,
    /// Protocol round of last successful reveal.
    pub last_round_participated: u64,
    /// Incremented by mark_validator_missed; reset to 0 on successful reveal.
    pub consecutive_misses: u8,
    /// False if deactivated due to misses or failed refresh.
    pub active: bool,
    pub bump: u8,
    /// Hot key for daily operations (commit / reveal / init_ee_round / claim).
    /// Set via rotate_randomness_authority (signed by identity).
    /// Reset to identity via revoke_randomness_authority.
    /// Appended in V4.6 — pre-existing accounts default to identity after migrate_validator_registration.
    pub x1_randomness_authority: Pubkey,
}
impl ValidatorRegistration {
    // disc(8)+identity(32)+vote(32)+stake(32)+verified_stake(8)+registered_slot(8)
    // +last_active_slot(8)+last_round_participated(8)+consecutive_misses(1)+active(1)+bump(1)
    // +x1_randomness_authority(32) = 171
    pub const INIT_SPACE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 32;
}

#[account]
pub struct RequestState {
    pub request_id: [u8; 32],
    pub requester: Pubkey,
    pub seed: [u8; 32],
    pub callback_program: Pubkey,
    pub callback_instruction: [u8; 8],
    pub round: u64,
    pub fulfilled: bool,
    pub output: [u8; 32],
    pub fee_paid: u64,
    pub created_slot: u64,
    pub bump: u8,
}
impl RequestState {
    // disc(8) + request_id(32) + requester(32) + seed(32) + callback_program(32)
    // + callback_instruction(8) + round(8) + fulfilled(1) + output(32)
    // + fee_paid(8) + created_slot(8) + bump(1) = 202
    pub const INIT_SPACE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 32 + 8 + 8 + 1;
}

#[account]
pub struct FeeEscrow {
    pub pending_fees: u64,
    pub round: u64,
    pub original_fees: u64,       // total fees before crank cut; used for per-validator 95% share calc
    pub ee_v4_round_id: u64,      // EE V4 round that services this protocol round
    pub fee_distributed: bool,    // true once distribute_fees has run; claim requires this
    pub bump: u8,
}
impl FeeEscrow {
    // disc(8)+pending_fees(8)+round(8)+original_fees(8)+ee_v4_round_id(8)+fee_distributed(1)+bump(1) = 42
    pub const INIT_SPACE: usize = 8 + 8 + 8 + 8 + 8 + 1 + 1;
}

/// Wrapper-side round record — lightweight, just tracks which EE V4 round
/// this maps to and which requests are pending.
#[account]
pub struct WrapperRound {
    pub round: u64,
    pub ee_v4_round_id: u64,         // The EE V4 round ID this wraps
    pub start_slot: u64,
    pub aggregated: bool,
    pub aggregated_slot: u64,
    pub entropy_output: [u8; 32],     // Final entropy after mixing
    pub pending_requests: u32,
    pub total_fees: u64,
    pub ee_v4_entropy_included: bool,
    pub bump: u8,
}
impl WrapperRound {
    pub const MAX_REQUESTS: usize = 256;
    pub const INIT_SPACE: usize = 8 + 8 + 8 + 8 + 1 + 8 + 32 + 4 + 8 + 1 + 1;
}

#[account]
pub struct AgentSubscription {
    pub callback_program: Pubkey,
    pub callback_instruction: [u8; 8],
    pub min_round_interval: u64,
    pub last_served_round: u64,
    pub total_callbacks: u64,
    pub authority: Pubkey,
    pub seed: [u8; 32],
    pub bump: u8,
}
impl AgentSubscription {
    pub const INIT_SPACE: usize = 8 + 32 + 8 + 8 + 8 + 8 + 32 + 32 + 1;
}

#[account]
pub struct EntropyReceipt {
    pub round: u64,
    pub entropy_output: [u8; 32],
    pub reveal_count: u32,
    pub committee_size: u32,
    pub aggregated_slot: u64,
    pub ee_v4_included: bool,
    pub request_id: [u8; 32],
    pub derived_output: [u8; 32],
    pub bump: u8,
}
impl EntropyReceipt {
    pub const INIT_SPACE: usize = 8 + 8 + 32 + 4 + 4 + 8 + 1 + 32 + 32 + 1;
}

// ── Instructions ──────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = ProtocolConfig::INIT_SPACE,
        seeds = [b"protocol-config"],
        bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = authority,
        space = EntropyPool::INIT_SPACE,
        seeds = [b"entropy-pool"],
        bump,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    /// CHECK: Insurance fund wallet
    pub insurance_fund: AccountInfo<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(callback_program: Pubkey, callback_instruction: [u8; 8], min_round_interval: u64)]
pub struct RegisterDapp<'info> {
    #[account(
        init,
        payer = authority,
        space = DappRegistration::INIT_SPACE,
        seeds = [b"dapp", dapp_id.key().as_ref()],
        bump,
    )]
    pub dapp_registration: Account<'info, DappRegistration>,
    /// CHECK: dApp program ID — used as PDA seed
    pub dapp_id: AccountInfo<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnregisterDapp<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"dapp", dapp_registration.dapp_id.as_ref()],
        bump = dapp_registration.bump,
        constraint = dapp_registration.authority == authority.key() @ RandomnessError::Unauthorized,
    )]
    pub dapp_registration: Account<'info, DappRegistration>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(seed: [u8; 32], callback_program: Pubkey, callback_instruction: [u8; 8])]
pub struct RequestRandomness<'info> {
    #[account(
        init,
        payer = requester,
        space = RequestState::INIT_SPACE,
        seeds = [b"request", requester.key().as_ref(), &seed],
        bump,
    )]
    pub request_state: Account<'info, RequestState>,
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    #[account(
        mut,
        seeds = [b"fee-escrow", &protocol_config.current_round.to_le_bytes()],
        bump = fee_escrow.bump,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: Wrapper round PDA (may be uninitialized for fast-path)
    pub wrapper_round: AccountInfo<'info>,
    /// CHECK: SlotHashes sysvar — mixed into fast-path output so it cannot be pre-computed.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
    /// CHECK: Optional dApp registration — if provided and has a non-zero fee_override,
    /// that fee is used instead of the protocol default. Pass System Program ID to opt out.
    pub dapp_registration: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

// ── Validator registry contexts ───────────────────────────────────────────────

#[derive(Accounts)]
pub struct RegisterValidator<'info> {
    #[account(
        init,
        payer = identity,
        space = ValidatorRegistration::INIT_SPACE,
        seeds = [b"val-reg", identity.key().as_ref()],
        bump,
    )]
    pub validator_registration: Account<'info, ValidatorRegistration>,
    /// The validator's signing wallet (pays rent, becomes identity).
    #[account(mut)]
    pub identity: Signer<'info>,
    /// CHECK: Vote account — must be owned by the Vote program; activity checked in handler.
    pub vote_account: AccountInfo<'info>,
    /// CHECK: Stake account — must be owned by the Stake program; ≥1000 XNT delegated to vote_account.
    pub stake_account: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeregisterValidator<'info> {
    #[account(
        mut,
        close = identity,
        seeds = [b"val-reg", identity.key().as_ref()],
        bump = validator_registration.bump,
        constraint = validator_registration.identity == identity.key() @ RandomnessError::Unauthorized,
    )]
    pub validator_registration: Account<'info, ValidatorRegistration>,
    #[account(mut)]
    pub identity: Signer<'info>,
}

/// Migrates a pre-V4.6 ValidatorRegistration (139 bytes) to 171 bytes.
/// Permissionless — anyone may pay rent for any validator's account realloc.
/// Sets x1_randomness_authority = identity (default; change via rotate_randomness_authority).
#[derive(Accounts)]
pub struct MigrateValidatorRegistration<'info> {
    /// CHECK: Manually verified in handler — 139-byte ValidatorRegistration PDA.
    #[account(mut, owner = crate::ID @ RandomnessError::Unauthorized)]
    pub validator_registration: UncheckedAccount<'info>,
    /// CHECK: The validator's identity key — used to derive and verify the PDA.
    pub identity: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Rotate the hot key allowed to sign commits/reveals on behalf of this validator.
/// Must be signed by the validator's cold identity key.
#[derive(Accounts)]
pub struct RotateRandomnessAuthority<'info> {
    #[account(
        mut,
        seeds = [b"val-reg", identity.key().as_ref()],
        bump = validator_registration.bump,
        constraint = validator_registration.identity == identity.key() @ RandomnessError::Unauthorized,
    )]
    pub validator_registration: Account<'info, ValidatorRegistration>,
    pub identity: Signer<'info>,
}

/// Permissionless crank — anyone can refresh any validator's status.
/// Updates verified_stake, last_active_slot, and active flag.
#[derive(Accounts)]
pub struct RefreshValidatorStatus<'info> {
    #[account(
        mut,
        seeds = [b"val-reg", validator_registration.identity.as_ref()],
        bump = validator_registration.bump,
    )]
    pub validator_registration: Account<'info, ValidatorRegistration>,
    /// CHECK: The validator's vote account — re-checked for activity.
    pub vote_account: AccountInfo<'info>,
    /// CHECK: The validator's stake account — re-checked for ≥1000 XNT.
    pub stake_account: AccountInfo<'info>,
}

/// Permissionless — called after a round finalises to penalise validators who
/// were part of the active set but did not reveal (no ValidatorReveal PDA exists).
/// The miss_record PDA is created per-(validator, EE round) to enforce idempotency:
/// calling this twice for the same round/validator fails because the PDA already exists.
#[derive(Accounts)]
pub struct MarkValidatorMissed<'info> {
    #[account(
        mut,
        seeds = [b"val-reg", validator_registration.identity.as_ref()],
        bump = validator_registration.bump,
    )]
    pub validator_registration: Account<'info, ValidatorRegistration>,
    /// CHECK: The finalised EE V4 round — used to verify the round completed
    /// without this validator's reveal.
    #[account(constraint = ee_round.owner == &ENTROPY_ENGINE_V4 @ RandomnessError::Unauthorized)]
    pub ee_round: AccountInfo<'info>,
    /// CHECK: ValidatorReveal PDA that would exist if this validator revealed.
    /// Must be passed as the expected PDA address; we verify it does NOT exist.
    pub expected_reveal_pda: AccountInfo<'info>,
    /// Idempotency guard — created once per (validator, EE round). Anchor's init
    /// constraint rejects the transaction if this PDA already exists, preventing
    /// spam-deactivation via repeated calls with the same round.
    #[account(
        init,
        payer = caller,
        space = ValidatorMissRecord::INIT_SPACE,
        seeds = [b"miss-record", ee_round.key().as_ref(), validator_registration.identity.as_ref()],
        bump,
    )]
    pub miss_record: Account<'info, ValidatorMissRecord>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// CPI: Initialize an EE V4 round via the wrapper.
/// - ee_round_id must equal protocol_config.ee_v4_round_id + 1
/// - n, m, and binding_slot are derived from protocol constants — not caller-supplied
/// - any registered active validator may be coordinator (first to call wins, pays rent)
#[derive(Accounts)]
#[instruction(ee_round_id: u64)]
pub struct InitEeRound<'info> {
    #[account(
        mut,
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = coordinator,
        space = WrapperRound::INIT_SPACE,
        seeds = [b"wrapper-round", ee_round_id.to_le_bytes().as_ref()],
        bump,
    )]
    pub wrapper_round: Account<'info, WrapperRound>,
    /// CHECK: EE V4 Round PDA.
    #[account(mut)]
    pub ee_round: AccountInfo<'info>,
    #[account(mut)]
    pub coordinator: Signer<'info>,
    /// Coordinator must be a registered, active validator.
    /// Seeds use the stored identity; signer may be identity OR x1_randomness_authority.
    #[account(
        seeds = [b"val-reg", coordinator_reg.identity.as_ref()],
        bump = coordinator_reg.bump,
        constraint = coordinator_reg.active @ RandomnessError::ValidatorInactive,
        constraint = (
            coordinator_reg.identity == coordinator.key() ||
            coordinator_reg.x1_randomness_authority == coordinator.key()
        ) @ RandomnessError::Unauthorized,
    )]
    pub coordinator_reg: Account<'info, ValidatorRegistration>,
    /// CHECK: Coordinator's vote account — live activity checked in handler.
    pub coordinator_vote: AccountInfo<'info>,
    /// CHECK: Coordinator's stake account — live stake checked in handler.
    pub coordinator_stake: AccountInfo<'info>,
    /// Fee escrow for the current protocol round — stamped with this EE round ID
    /// so refund_request can verify the correct EE round for cancelled-round refunds.
    #[account(
        mut,
        seeds = [b"fee-escrow", &protocol_config.current_round.to_le_bytes()],
        bump = fee_escrow.bump,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    pub system_program: Program<'info, System>,
    /// CHECK: Must be the canonical EntropyEngine V4 program.
    #[account(address = ENTROPY_ENGINE_V4 @ RandomnessError::Unauthorized)]
    pub ee_v4_program: AccountInfo<'info>,
}

/// CPI: Commit to an EE V4 round via the wrapper.
/// Contributor must be a registered active validator with sufficient stake and
/// a live vote recorded within VALIDATOR_MAX_INACTIVE_SLOTS.
#[derive(Accounts)]
pub struct CommitViaEe<'info> {
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    /// Entropy pool — current entropy seeds the on-chain validator selection check.
    #[account(
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    #[account(
        seeds = [b"wrapper-round", &protocol_config.ee_v4_round_id.to_le_bytes()],
        bump = wrapper_round.bump,
    )]
    pub wrapper_round: Account<'info, WrapperRound>,
    /// CHECK: EE V4 Round PDA.
    #[account(mut)]
    pub ee_round: AccountInfo<'info>,
    #[account(mut)]
    pub contributor: Signer<'info>,
    /// Contributor's registration — must be active.
    /// Seeds use the stored identity (stable), not the signer (which may be the hot key).
    /// Signer may be identity OR x1_randomness_authority — both are accepted.
    #[account(
        mut,
        seeds = [b"val-reg", validator_reg.identity.as_ref()],
        bump = validator_reg.bump,
        constraint = validator_reg.active @ RandomnessError::ValidatorInactive,
        constraint = (
            validator_reg.identity == contributor.key() ||
            validator_reg.x1_randomness_authority == contributor.key()
        ) @ RandomnessError::Unauthorized,
    )]
    pub validator_reg: Account<'info, ValidatorRegistration>,
    /// CHECK: Contributor's vote account — live activity verified in handler.
    pub vote_account: AccountInfo<'info>,
    /// CHECK: Contributor's stake account — live stake verified in handler.
    pub stake_account: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Must be the canonical EntropyEngine V4 program.
    #[account(address = ENTROPY_ENGINE_V4 @ RandomnessError::Unauthorized)]
    pub ee_v4_program: AccountInfo<'info>,
}

/// CPI: Reveal to an EE V4 round via the wrapper.
/// Creates a ValidatorReveal PDA so this contributor can later claim their fee share.
/// The PDA is seeded by x1_randomness_authority (not contributor.key()) so that
/// mark_validator_missed always knows the correct address regardless of which key signed.
#[derive(Accounts)]
pub struct RevealViaEe<'info> {
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        seeds = [b"wrapper-round", &protocol_config.ee_v4_round_id.to_le_bytes()],
        bump = wrapper_round.bump,
    )]
    pub wrapper_round: Account<'info, WrapperRound>,
    /// CHECK: EE V4 Round PDA — EE V4 validates the correct PDA internally.
    #[account(mut)]
    pub ee_round: AccountInfo<'info>,
    #[account(
        init,
        payer = contributor,
        space = ValidatorReveal::INIT_SPACE,
        seeds = [b"validator-reveal", ee_round.key().as_ref(), validator_reg.x1_randomness_authority.as_ref()],
        bump,
    )]
    pub validator_reveal: Account<'info, ValidatorReveal>,
    #[account(mut)]
    pub contributor: Signer<'info>,
    /// Contributor's registration — enforces that contributor == x1_randomness_authority,
    /// keeping the ValidatorReveal PDA address consistent with mark_validator_missed.
    #[account(
        mut,
        seeds = [b"val-reg", validator_reg.identity.as_ref()],
        bump = validator_reg.bump,
        constraint = validator_reg.active @ RandomnessError::ValidatorInactive,
        constraint = validator_reg.x1_randomness_authority == contributor.key() @ RandomnessError::Unauthorized,
    )]
    pub validator_reg: Account<'info, ValidatorRegistration>,
    pub system_program: Program<'info, System>,
    /// CHECK: Must be the canonical EntropyEngine V4 program.
    #[account(address = ENTROPY_ENGINE_V4 @ RandomnessError::Unauthorized)]
    pub ee_v4_program: AccountInfo<'info>,
}

/// CPI: Finalize an EE V4 round via the wrapper, then mix entropy into our pool.
#[derive(Accounts)]
pub struct FinalizeViaEe<'info> {
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"wrapper-round", &protocol_config.ee_v4_round_id.to_le_bytes()],
        bump = wrapper_round.bump,
        constraint = !wrapper_round.aggregated @ RandomnessError::RoundAlreadyAggregated,
    )]
    pub wrapper_round: Account<'info, WrapperRound>,
    #[account(
        mut,
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    /// CHECK: EE V4 Round PDA — must be owned by EE V4 to prevent fake entropy injection.
    #[account(
        mut,
        constraint = ee_round.owner == &ENTROPY_ENGINE_V4 @ RandomnessError::InvalidEeV4RoundResult,
    )]
    pub ee_round: AccountInfo<'info>,
    /// CHECK: SlotHashes sysvar — used for unpredictable mixing salt.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: Must be the canonical EntropyEngine V4 program.
    #[account(address = ENTROPY_ENGINE_V4 @ RandomnessError::Unauthorized)]
    pub ee_v4_program: AccountInfo<'info>,
}

/// Aggregate entropy from an already-finalized EE V4 round into our pool.
/// Used when the wrapper didn't call finalize itself (e.g., EE V4 round
/// was finalized externally) and needs to consume the result.
#[derive(Accounts)]
pub struct AggregateFromEe<'info> {
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"wrapper-round", &wrapper_round.round.to_le_bytes()],
        bump = wrapper_round.bump,
        constraint = !wrapper_round.aggregated @ RandomnessError::RoundAlreadyAggregated,
        constraint = wrapper_round.round == protocol_config.current_round @ RandomnessError::Unauthorized,
    )]
    pub wrapper_round: Account<'info, WrapperRound>,
    #[account(
        mut,
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    /// Fee escrow for this protocol round — updated with the actual EE round ID so
    /// stale cancelled-round refunds are blocked once aggregation succeeds.
    #[account(
        mut,
        seeds = [b"fee-escrow", &wrapper_round.round.to_le_bytes()],
        bump = fee_escrow.bump,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: EE V4 Round account — must be owned by EE V4 program and finalized.
    #[account(
        constraint = ee_round.owner == &ENTROPY_ENGINE_V4 @ RandomnessError::InvalidEeV4RoundResult,
    )]
    pub ee_round: AccountInfo<'info>,
    /// CHECK: SlotHashes sysvar — used for unpredictable mixing salt.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdvanceRound<'info> {
    #[account(
        mut,
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    /// CHECK: Current round's WrapperRound — must be aggregated (entropy mixed) before
    /// advancing. Prevents permanently stalling aggregate_from_ee for in-flight EE rounds.
    /// Pass the PDA for protocol_config.current_round. For round 0 pass SystemProgram.
    pub current_wrapper_round: AccountInfo<'info>,
    /// CHECK: PDA for new wrapper round
    #[account(mut)]
    pub new_wrapper_round: AccountInfo<'info>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimValidatorFees<'info> {
    #[account(
        mut,
        seeds = [b"fee-escrow", &fee_escrow.round.to_le_bytes()],
        bump = fee_escrow.bump,
        constraint = fee_escrow.pending_fees > 0 @ RandomnessError::FeeEscrowInsufficient,
        // distribute_fees must have run first — prevents bypassing the crank cut.
        constraint = fee_escrow.fee_distributed @ RandomnessError::RoundNotAggregatable,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: Dust is swept to the protocol authority wallet.
    #[account(
        mut,
        constraint = recipient.key() == protocol_config.authority @ RandomnessError::Unauthorized,
    )]
    pub recipient: AccountInfo<'info>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
}

#[derive(Accounts)]
pub struct DistributeFees<'info> {
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        seeds = [b"wrapper-round", &wrapper_round.round.to_le_bytes()],
        bump = wrapper_round.bump,
        constraint = wrapper_round.aggregated @ RandomnessError::RoundNotAggregatable,
    )]
    pub wrapper_round: Account<'info, WrapperRound>,
    #[account(
        mut,
        seeds = [b"fee-escrow", &wrapper_round.round.to_le_bytes()],
        bump = fee_escrow.bump,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// Crank runner receives 5% reward for calling this instruction.
    #[account(mut)]
    pub crank: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Closes a fee escrow that has zero pending fees and was never distributed.
/// Used for failed/cancelled rounds where all requests were refunded.
#[derive(Accounts)]
pub struct CloseEscrow<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"fee-escrow", &fee_escrow.round.to_le_bytes()],
        bump = fee_escrow.bump,
        constraint = fee_escrow.pending_fees == 0 @ RandomnessError::FeeEscrowInsufficient,
        constraint = !fee_escrow.fee_distributed @ RandomnessError::RoundAlreadyAggregated,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ RandomnessError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CloseRequest<'info> {
    #[account(
        mut,
        close = requester,
        constraint = request_state.fulfilled @ RandomnessError::RequestNotFulfilled,
        constraint = request_state.requester == requester.key() @ RandomnessError::Unauthorized,
    )]
    pub request_state: Account<'info, RequestState>,
    #[account(mut)]
    pub requester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ── Agent Subscription Accounts ──────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(callback_program: Pubkey, callback_instruction: [u8; 8], min_round_interval: u64, seed: [u8; 32])]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentSubscription::INIT_SPACE,
        seeds = [b"agent-sub", authority.key().as_ref(), seed.as_ref()],
        bump,
    )]
    pub agent_subscription: Account<'info, AgentSubscription>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnregisterAgent<'info> {
    #[account(
        mut,
        close = authority,
        seeds = [b"agent-sub", agent_subscription.authority.as_ref(), agent_subscription.seed.as_ref()],
        bump = agent_subscription.bump,
        constraint = agent_subscription.authority == authority.key() @ RandomnessError::Unauthorized,
    )]
    pub agent_subscription: Account<'info, AgentSubscription>,
    #[account(mut)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct GameSeed<'info> {
    #[account(
        mut,
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
        realloc = EntropyPool::INIT_SPACE,
        realloc::payer = payer,
        realloc::zero = false,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"fee-escrow", &protocol_config.current_round.to_le_bytes()],
        bump = fee_escrow.bump,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: SlotHashes sysvar — prevents grinding game seeds by mixing in unpredictable state.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

/// Permissionless crank: fulfills a queue-path RequestState that was created when the
/// pool was stale. Once the pool is warm again, anyone can call this to deliver the
/// entropy output and unlock the request (enabling close_request to reclaim rent).
#[derive(Accounts)]
pub struct FulfillQueuedRequest<'info> {
    #[account(
        mut,
        constraint = !request_state.fulfilled @ RandomnessError::RoundAlreadyAggregated,
    )]
    pub request_state: Account<'info, RequestState>,
    #[account(
        mut,
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
        constraint = entropy_pool.entropy_available @ RandomnessError::EntropyPoolNotAvailable,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    /// CHECK: SlotHashes sysvar — mixed into output for unpredictability.
    #[account(address = anchor_lang::solana_program::sysvar::slot_hashes::ID)]
    pub slot_hashes: AccountInfo<'info>,
    pub caller: Signer<'info>,
}

/// One-time migration: expands the pre-V4.3 EntropyPool from 67 → 75 bytes to add
/// the `total_game_seeds` counter. Permissionless and idempotent — safe to call twice.
#[derive(Accounts)]
pub struct MigrateEntropyPool<'info> {
    #[account(
        mut,
        seeds = [b"entropy-pool"],
        bump,
    )]
    /// CHECK: Pre-V4.3 account cannot be deserialized by Anchor as EntropyPool (67 vs 75 bytes).
    /// Discriminator and size are verified in the handler; realloc is performed manually.
    pub entropy_pool: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(request_id: [u8; 32])]
pub struct VerifyEntropy<'info> {
    #[account(
        init,
        payer = caller,
        space = EntropyReceipt::INIT_SPACE,
        seeds = [b"receipt", request_id.as_ref()],
        bump,
    )]
    pub entropy_receipt: Account<'info, EntropyReceipt>,
    #[account(
        seeds = [b"wrapper-round", &wrapper_round.round.to_le_bytes()],
        bump = wrapper_round.bump,
        constraint = wrapper_round.aggregated @ RandomnessError::RoundNotAggregatable,
    )]
    pub wrapper_round: Account<'info, WrapperRound>,
    /// The RequestState proving this request was genuinely served.
    /// Verified: request_id matches and request is fulfilled.
    #[account(
        constraint = request_state.request_id == request_id @ RandomnessError::Unauthorized,
        constraint = request_state.fulfilled @ RandomnessError::RequestNotFulfilled,
    )]
    pub request_state: Account<'info, RequestState>,
    #[account(mut)]
    pub caller: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DeliverCallback<'info> {
    #[account(
        mut,
        seeds = [b"agent-sub", agent_subscription.authority.as_ref(), agent_subscription.seed.as_ref()],
        bump = agent_subscription.bump,
    )]
    pub agent_subscription: Account<'info, AgentSubscription>,
    #[account(
        seeds = [b"entropy-pool"],
        bump = entropy_pool.bump,
        constraint = entropy_pool.entropy_available @ RandomnessError::EntropyPoolNotAvailable,
    )]
    pub entropy_pool: Account<'info, EntropyPool>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    // Permissionless crank — anyone may trigger, but a signer is required so
    // the action is attributable and not submittable without a fee-paying account.
    pub caller: Signer<'info>,
}

/// Initialize the fee escrow for a given round.
/// Must be called before the first request_randomness in each round.
/// Permissionless — anyone can pay to create it.
#[derive(Accounts)]
#[instruction(round: u64)]
pub struct CreateFeeEscrow<'info> {
    #[account(
        init,
        payer = payer,
        space = FeeEscrow::INIT_SPACE,
        seeds = [b"fee-escrow", round.to_le_bytes().as_ref()],
        bump,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    #[account(
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetFee<'info> {
    #[account(
        mut,
        seeds = [b"protocol-config"],
        bump = protocol_config.bump,
        constraint = protocol_config.authority == authority.key() @ RandomnessError::Unauthorized,
    )]
    pub protocol_config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateDappFee<'info> {
    #[account(
        mut,
        seeds = [b"dapp", dapp_registration.dapp_id.as_ref()],
        bump = dapp_registration.bump,
        constraint = dapp_registration.authority == authority.key() @ RandomnessError::Unauthorized,
    )]
    pub dapp_registration: Account<'info, DappRegistration>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimValidatorReward<'info> {
    #[account(
        mut,
        close = contributor,
        seeds = [b"validator-reveal", validator_reveal.ee_round.as_ref(), contributor.key().as_ref()],
        bump = validator_reveal.bump,
        constraint = !validator_reveal.claimed @ RandomnessError::RewardAlreadyClaimed,
        constraint = validator_reveal.contributor == contributor.key() @ RandomnessError::Unauthorized,
    )]
    pub validator_reveal: Account<'info, ValidatorReveal>,
    #[account(
        mut,
        seeds = [b"fee-escrow", &validator_reveal.protocol_round.to_le_bytes()],
        bump = fee_escrow.bump,
        constraint = fee_escrow.fee_distributed @ RandomnessError::RoundNotAggregatable,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: EE V4 Round account — must be owned by EE V4; read reveal_count at offset 75.
    #[account(
        constraint = ee_round.owner == &ENTROPY_ENGINE_V4 @ RandomnessError::InvalidEeV4RoundResult,
        constraint = ee_round.key() == validator_reveal.ee_round @ RandomnessError::Unauthorized,
    )]
    pub ee_round: AccountInfo<'info>,
    #[account(mut)]
    pub contributor: Signer<'info>,
}

#[derive(Accounts)]
pub struct RefundRequest<'info> {
    #[account(
        mut,
        close = requester,
        constraint = !request_state.fulfilled @ RandomnessError::RequestAlreadyFulfilled,
        constraint = request_state.requester == requester.key() @ RandomnessError::Unauthorized,
    )]
    pub request_state: Account<'info, RequestState>,
    #[account(
        mut,
        seeds = [b"fee-escrow", &request_state.round.to_le_bytes()],
        bump = fee_escrow.bump,
        // Refund only allowed before distribute_fees runs (i.e. round wasn't successful)
        constraint = !fee_escrow.fee_distributed @ RandomnessError::RoundAlreadyAggregated,
    )]
    pub fee_escrow: Account<'info, FeeEscrow>,
    /// CHECK: EE V4 Round account — must be owned by EE V4 and status == Cancelled (3).
    #[account(
        constraint = ee_round.owner == &ENTROPY_ENGINE_V4 @ RandomnessError::InvalidEeV4RoundResult,
    )]
    pub ee_round: AccountInfo<'info>,
    #[account(mut)]
    pub requester: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ── Program ──────────────────────────────────────────────────────────────────

#[program]
pub mod randomness_wrapper {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.protocol_config;
        config.authority = ctx.accounts.authority.key();
        config.insurance_fund = ctx.accounts.insurance_fund.key();
        config.current_round = 0;
        config.current_round_start_slot = 0;
        config.ee_v4_round_id = 0;
        config.total_rounds = 0;
        config.request_fee = RANDOMNESS_FEE_LAMPORTS;
        config.bump = ctx.bumps.protocol_config;

        let pool = &mut ctx.accounts.entropy_pool;
        pool.current_entropy = [0u8; 32];
        pool.current_round = 0;
        pool.entropy_available = false;
        pool.last_aggregated_slot = 0;
        pool.total_requests_served = 0;
        pool.ee_v4_entropy_included = false;
        pool.bump = ctx.bumps.entropy_pool;

        Ok(())
    }

    pub fn create_fee_escrow(ctx: Context<CreateFeeEscrow>, round: u64) -> Result<()> {
        require!(
            round == ctx.accounts.protocol_config.current_round
                || round == ctx.accounts.protocol_config.current_round.saturating_add(1),
            RandomnessError::Unauthorized
        );
        let escrow = &mut ctx.accounts.fee_escrow;
        escrow.round = round;
        escrow.bump = ctx.bumps.fee_escrow;
        escrow.pending_fees = 0;
        escrow.original_fees = 0;
        escrow.ee_v4_round_id = ctx.accounts.protocol_config.ee_v4_round_id;
        escrow.fee_distributed = false;
        Ok(())
    }

    pub fn register_dapp(
        ctx: Context<RegisterDapp>,
        callback_program: Pubkey,
        callback_instruction: [u8; 8],
        min_round_interval: u64,
    ) -> Result<()> {
        let dapp = &mut ctx.accounts.dapp_registration;
        dapp.dapp_id = ctx.accounts.dapp_id.key();
        dapp.callback_program = callback_program;
        dapp.callback_instruction = callback_instruction;
        dapp.min_round_interval = min_round_interval;
        dapp.last_served_round = 0;
        dapp.total_requests = 0;
        dapp.authority = ctx.accounts.authority.key();
        dapp.fee_override = 0;
        dapp.bump = ctx.bumps.dapp_registration;
        Ok(())
    }

    pub fn unregister_dapp(_ctx: Context<UnregisterDapp>) -> Result<()> {
        Ok(())
    }

    pub fn request_randomness(
        ctx: Context<RequestRandomness>,
        seed: [u8; 32],
        callback_program: Pubkey,
        callback_instruction: [u8; 8],
    ) -> Result<()> {
        let mut id_preimage = Vec::new();
        id_preimage.extend_from_slice(callback_program.as_ref());
        id_preimage.extend_from_slice(&callback_instruction);
        id_preimage.extend_from_slice(&seed);
        id_preimage.extend_from_slice(ctx.accounts.requester.key.as_ref());
        let request_id = hash(&id_preimage).to_bytes();

        let fee = {
            let protocol_fee = ctx.accounts.protocol_config.request_fee;
            let dapp_info = &ctx.accounts.dapp_registration;
            if dapp_info.key() != System::id() && !dapp_info.data_is_empty() {
                // Validate ownership and discriminator — prevents fee bypass via crafted accounts.
                require!(dapp_info.owner == &ID, RandomnessError::Unauthorized);
                let dapp_data = dapp_info.try_borrow_data()?;
                require!(dapp_data.len() >= 145, RandomnessError::Unauthorized);
                require!(&dapp_data[..8] == &DAPP_REGISTRATION_DISC, RandomnessError::Unauthorized);
                let override_fee = u64::from_le_bytes(
                    dapp_data[136..144].try_into().unwrap_or([0u8; 8])
                );
                if override_fee > 0 {
                    // Fee override must not be below the protocol minimum.
                    require!(override_fee >= protocol_fee, RandomnessError::InsufficientFee);
                    override_fee
                } else {
                    protocol_fee
                }
            } else {
                protocol_fee
            }
        };
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.requester.to_account_info(),
                    to: ctx.accounts.fee_escrow.to_account_info(),
                },
            ),
            fee,
        )?;

        // Update per-dApp counters if a real (writable) dApp registration was passed.
        {
            let dapp_info = &ctx.accounts.dapp_registration;
            if dapp_info.key() != System::id() && !dapp_info.data_is_empty() && dapp_info.is_writable {
                let current_round = ctx.accounts.protocol_config.current_round;
                let mut data = dapp_info.try_borrow_mut_data()?;
                // last_served_round at offset 88
                let last_served = u64::from_le_bytes(data[88..96].try_into().unwrap());
                let _ = last_served; // read to confirm layout; overwrite below
                data[88..96].copy_from_slice(&current_round.to_le_bytes());
                // total_requests at offset 96
                let total = u64::from_le_bytes(data[96..104].try_into().unwrap());
                let new_total = total.saturating_add(1);
                data[96..104].copy_from_slice(&new_total.to_le_bytes());
            }
        }

        let current_slot = Clock::get()?.slot;

        // Fast path: entropy pool is warm and entropy is fresh enough.
        // If entropy is dangerously stale we fall through to the queue path rather
        // than rejecting the request entirely — the caller gets queued for the next round.
        let pool_fresh = ctx.accounts.entropy_pool.entropy_available && {
            let slots_since = current_slot.saturating_sub(
                ctx.accounts.entropy_pool.last_aggregated_slot
            );
            if slots_since > STALENESS_HARD_LIMIT_SLOTS {
                msg!("Entropy pool too stale ({} slots). Queuing request for next round.", slots_since);
                false
            } else {
                if slots_since > STALENESS_THRESHOLD_SLOTS {
                    msg!("WARNING: Entropy pool stale ({} slots old). Consider advancing round.", slots_since);
                }
                true
            }
        };
        if pool_fresh {

            let slot_hash = read_slot_hash(&ctx.accounts.slot_hashes)?;
            let output = hash(
                &[&ctx.accounts.entropy_pool.current_entropy[..], &request_id[..], &slot_hash[..]].concat()
            ).to_bytes();

            let request = &mut ctx.accounts.request_state;
            request.request_id = request_id;
            request.requester = ctx.accounts.requester.key();
            request.seed = seed;
            request.callback_program = callback_program;
            request.callback_instruction = callback_instruction;
            request.round = ctx.accounts.entropy_pool.current_round;
            request.fulfilled = true;
            request.output = output;
            request.fee_paid = fee;
            request.created_slot = current_slot;
            request.bump = ctx.bumps.request_state;

            ctx.accounts.entropy_pool.total_requests_served =
                ctx.accounts.entropy_pool.total_requests_served.checked_add(1)
                    .ok_or(error!(RandomnessError::Overflow))?;

            ctx.accounts.fee_escrow.pending_fees = ctx.accounts.fee_escrow.pending_fees
                .checked_add(fee).ok_or(error!(RandomnessError::Overflow))?;

            return Ok(());
        }

        // Queue path
        let request = &mut ctx.accounts.request_state;
        request.request_id = request_id;
        request.requester = ctx.accounts.requester.key();
        request.seed = seed;
        request.callback_program = callback_program;
        request.callback_instruction = callback_instruction;
        request.round = ctx.accounts.protocol_config.current_round;
        request.fulfilled = false;
        request.output = [0u8; 32];
        request.fee_paid = fee;
        request.created_slot = current_slot;
        request.bump = ctx.bumps.request_state;

        ctx.accounts.fee_escrow.pending_fees = ctx.accounts.fee_escrow.pending_fees
            .checked_add(fee).ok_or(error!(RandomnessError::Overflow))?;

        Ok(())
    }

    // ── Validator registry instructions ───────────────────────────────────

    /// Register as a protocol validator. Verifies ≥ 1000 XNT stake delegated to
    /// the provided vote account and that the vote account voted recently.
    pub fn register_validator(ctx: Context<RegisterValidator>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let vote_data = ctx.accounts.vote_account.try_borrow_data()?;
        let stake_data = ctx.accounts.stake_account.try_borrow_data()?;

        // Verify accounts are owned by the correct programs.
        require!(
            ctx.accounts.vote_account.owner == &anchor_lang::solana_program::vote::program::id(),
            RandomnessError::InvalidVoteAccount
        );
        require!(
            ctx.accounts.stake_account.owner == &anchor_lang::solana_program::stake::program::id(),
            RandomnessError::InvalidStakeAccount
        );

        // Verify the caller owns this vote account: node_pubkey at offset 4 must match identity.
        require!(vote_data.len() >= VOTE_NODE_PUBKEY_OFFSET + 32, RandomnessError::InvalidVoteAccount);
        let node_pubkey = Pubkey::from(
            <[u8; 32]>::try_from(&vote_data[VOTE_NODE_PUBKEY_OFFSET..VOTE_NODE_PUBKEY_OFFSET + 32])
                .map_err(|_| error!(RandomnessError::InvalidVoteAccount))?
        );
        require!(node_pubkey == ctx.accounts.identity.key(), RandomnessError::Unauthorized);

        let (voter_pubkey, staked_lamports) = parse_stake_account(&stake_data)?;
        require!(
            voter_pubkey == ctx.accounts.vote_account.key(),
            RandomnessError::StakeNotDelegatedToVote
        );
        require!(staked_lamports >= MIN_VALIDATOR_STAKE, RandomnessError::InsufficientValidatorStake);

        let last_vote = parse_last_vote_slot(&vote_data)?;
        require!(
            current_slot.saturating_sub(last_vote) < VALIDATOR_MAX_INACTIVE_SLOTS,
            RandomnessError::ValidatorNotActivelyVoting
        );

        let reg = &mut ctx.accounts.validator_registration;
        reg.identity = ctx.accounts.identity.key();
        reg.vote_account = ctx.accounts.vote_account.key();
        reg.stake_account = ctx.accounts.stake_account.key();
        reg.verified_stake = staked_lamports;
        reg.registered_slot = current_slot;
        reg.last_active_slot = current_slot;
        reg.last_round_participated = 0;
        reg.consecutive_misses = 0;
        reg.active = true;
        reg.bump = ctx.bumps.validator_registration;
        reg.x1_randomness_authority = ctx.accounts.identity.key(); // defaults to identity

        msg!("Validator registered: {} stake={} XNT", ctx.accounts.identity.key(), staked_lamports / 1_000_000_000);
        Ok(())
    }

    /// Remove your own validator registration and reclaim rent.
    pub fn deregister_validator(_ctx: Context<DeregisterValidator>) -> Result<()> {
        Ok(())
    }

    /// Migrate a pre-V4.6 ValidatorRegistration (139 bytes) to 171 bytes.
    /// Permissionless — anyone may pay for the realloc on behalf of any validator.
    /// Sets x1_randomness_authority = identity. Call rotate_randomness_authority afterward
    /// to set a different hot key.
    pub fn migrate_validator_registration(ctx: Context<MigrateValidatorRegistration>) -> Result<()> {
        let acct_info = ctx.accounts.validator_registration.to_account_info();

        // Verify this is the canonical PDA for the given identity.
        let (expected_pda, _) = Pubkey::find_program_address(
            &[b"val-reg", ctx.accounts.identity.key().as_ref()],
            ctx.program_id,
        );
        require!(acct_info.key() == expected_pda, RandomnessError::Unauthorized);

        let current_len = acct_info.data_len();
        if current_len >= ValidatorRegistration::INIT_SPACE {
            return err!(RandomnessError::AlreadyMigrated);
        }
        // Sanity: must be the exact old size.
        require!(current_len == 139, RandomnessError::Unauthorized);

        // Verify stored identity matches the passed identity key.
        {
            let data = acct_info.try_borrow_data()?;
            let stored_id = Pubkey::from(
                <[u8; 32]>::try_from(&data[8..40])
                    .map_err(|_| error!(RandomnessError::Unauthorized))?
            );
            require!(stored_id == ctx.accounts.identity.key(), RandomnessError::Unauthorized);
        }

        // Top up lamports if realloc requires more rent-exempt balance.
        let rent = Rent::get()?;
        let required = rent.minimum_balance(ValidatorRegistration::INIT_SPACE);
        let current_lamports = acct_info.lamports();
        if required > current_lamports {
            let diff = required - current_lamports;
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    ctx.accounts.payer.key,
                    acct_info.key,
                    diff,
                ),
                &[
                    ctx.accounts.payer.to_account_info(),
                    acct_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Realloc to 171 bytes; false = preserve existing data in first 139 bytes.
        acct_info.realloc(ValidatorRegistration::INIT_SPACE, false)?;

        // Write x1_randomness_authority = identity in the new bytes (offset 139..171).
        {
            let mut data = acct_info.try_borrow_mut_data()?;
            let id_bytes = ctx.accounts.identity.key().to_bytes();
            data[139..171].copy_from_slice(&id_bytes);
        }

        msg!("Migrated validator_registration for {}", ctx.accounts.identity.key());
        Ok(())
    }

    /// Set a hot key allowed to sign commits/reveals on behalf of this validator.
    /// Must be called by the cold identity key. The hot key never needs to touch
    /// the identity wallet — it only needs to hold enough XNT for gas.
    pub fn rotate_randomness_authority(
        ctx: Context<RotateRandomnessAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(new_authority != Pubkey::default(), RandomnessError::Unauthorized);
        require!(new_authority != anchor_lang::solana_program::system_program::id(), RandomnessError::Unauthorized);
        ctx.accounts.validator_registration.x1_randomness_authority = new_authority;
        msg!("Rotated x1_randomness_authority for {} to {}", ctx.accounts.identity.key(), new_authority);
        Ok(())
    }

    /// Reset x1_randomness_authority back to identity (disables hot key separation).
    /// Must be called by the cold identity key.
    pub fn revoke_randomness_authority(ctx: Context<RotateRandomnessAuthority>) -> Result<()> {
        let id = ctx.accounts.validator_registration.identity;
        ctx.accounts.validator_registration.x1_randomness_authority = id;
        msg!("Revoked x1_randomness_authority for {} — reset to identity", id);
        Ok(())
    }

    /// Permissionless crank. Re-checks stake and vote activity; sets active = false
    /// if either check fails. Anyone can call this on any validator at any time.
    pub fn refresh_validator_status(ctx: Context<RefreshValidatorStatus>) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let vote_data = ctx.accounts.vote_account.try_borrow_data()?;
        let stake_data = ctx.accounts.stake_account.try_borrow_data()?;

        let reg = &mut ctx.accounts.validator_registration;

        // Verify the provided accounts match what the validator registered.
        require!(
            ctx.accounts.vote_account.key() == reg.vote_account,
            RandomnessError::InvalidVoteAccount
        );
        require!(
            ctx.accounts.stake_account.key() == reg.stake_account,
            RandomnessError::InvalidStakeAccount
        );

        // Propagate parse_stake_account errors directly so callers receive the exact
        // diagnosis (StakeDeactivating, InvalidStakeAccount, etc.) rather than the
        // misleading InsufficientValidatorStake that a catch-all Err(_)=>false would produce.
        let verified_lamports = match parse_stake_account(&stake_data) {
            Ok((voter, lamports)) => {
                if voter != reg.vote_account || lamports < MIN_VALIDATOR_STAKE {
                    return err!(RandomnessError::InsufficientValidatorStake);
                }
                lamports
            }
            Err(e) => return Err(e),
        };
        let vote_ok = match parse_last_vote_slot(&vote_data) {
            Ok(last_vote) => current_slot.saturating_sub(last_vote) < VALIDATOR_MAX_INACTIVE_SLOTS,
            Err(_) => false,
        };

        if !vote_ok {
            return err!(RandomnessError::ValidatorNotActivelyVoting);
        }
        reg.active = true;
        reg.consecutive_misses = 0;
        reg.last_active_slot = current_slot;
        reg.verified_stake = verified_lamports;
        Ok(())
    }

    /// Permissionless. Called after a round finalises to record that a registered
    /// validator did not reveal. After VALIDATOR_MAX_CONSECUTIVE_MISSES, deactivates them.
    pub fn mark_validator_missed(ctx: Context<MarkValidatorMissed>) -> Result<()> {
        // Verify the EE round is finalized (status == 2) or cancelled (== 3).
        let ee_data = ctx.accounts.ee_round.try_borrow_data()?;
        require!(ee_data.len() > 141, RandomnessError::InvalidEeV4RoundResult);
        let status = ee_data[140];
        require!(status == 2 || status == 3, RandomnessError::EeV4RoundNotFinalized);

        // C-2: Reject historical rounds opened before the validator registered.
        // Without this an attacker submits 3 old finalized/cancelled EE rounds the
        // validator never had a chance to participate in, accumulating 3 misses instantly.
        require!(ee_data.len() >= 74, RandomnessError::InvalidEeV4RoundResult);
        let binding_slot = u64::from_le_bytes(
            ee_data[66..74].try_into().map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?
        );
        let approx_init_slot = binding_slot.saturating_sub(EE_V4_MIN_BINDING_SLOTS);
        require!(
            ctx.accounts.validator_registration.registered_slot < approx_init_slot,
            RandomnessError::Unauthorized
        );

        // Derive the expected ValidatorReveal PDA on-chain — attacker cannot fake this.
        // reveal_via_ee now enforces contributor == x1_randomness_authority, so both
        // the PDA seed and this derivation always use the same key.
        let reg = &ctx.accounts.validator_registration;
        let (expected_pda_hot, _) = Pubkey::find_program_address(
            &[b"validator-reveal", ctx.accounts.ee_round.key().as_ref(), reg.x1_randomness_authority.as_ref()],
            ctx.program_id,
        );
        // Also accept identity-seeded PDA for reveals made before V4.7 upgrade.
        let (expected_pda_identity, _) = Pubkey::find_program_address(
            &[b"validator-reveal", ctx.accounts.ee_round.key().as_ref(), reg.identity.as_ref()],
            ctx.program_id,
        );
        let pda_key = ctx.accounts.expected_reveal_pda.key();
        require!(
            pda_key == expected_pda_hot || pda_key == expected_pda_identity,
            RandomnessError::Unauthorized
        );

        // Verify the expected ValidatorReveal PDA does NOT exist (no lamports = not created).
        // Kept as a cheap first filter: if the PDA is still there they certainly
        // revealed. Its *absence*, however, proves nothing — see below.
        require!(
            ctx.accounts.expected_reveal_pda.lamports() == 0,
            RandomnessError::Unauthorized // PDA exists → they did reveal, not a miss
        );

        // A miss is "committed and then failed to reveal" — nothing else.
        //
        // This used to rest entirely on the check above, and that was a remote
        // denial-of-service on the whole validator set. `claim_validator_reward`
        // closes the ValidatorReveal PDA (`close = contributor`), so the moment a
        // validator collected a reward it destroyed the only evidence that it had
        // revealed, and that round became permanently markable against it. Since
        // the daemon claims automatically, nearly every past round qualified: with
        // 2 795 finalized rounds on chain and miss-record rent at 0.000954 XNT,
        // anyone could deactivate a validator for 0.005 XNT and the entire
        // registry for 0.043 XNT, in one burst, using rounds those validators had
        // completed correctly.
        //
        // The EE round's own contributor table is the durable record and is never
        // closed, so absence is proved from there instead:
        //
        //   not in the table          → never in the committee. With n < the active
        //                               set, exclusion is routine and is NOT a miss.
        //   in the table, revealed=1  → did the work. Not a miss, whatever became
        //                               of the PDA.
        //   in the table, revealed=0  → committed and did not reveal. A real miss.
        {
            let reg = &ctx.accounts.validator_registration;
            let commit_count = ee_data[EE_COMMIT_COUNT_OFFSET] as usize;
            require!(
                commit_count <= MAX_COMMITTEE_SIZE as usize,
                RandomnessError::InvalidEeV4RoundResult
            );
            let table_end = EE_CONTRIBUTORS_OFFSET
                .checked_add(commit_count.checked_mul(EE_CONTRIBUTOR_ENTRY_SIZE)
                    .ok_or(error!(RandomnessError::InvalidEeV4RoundResult))?)
                .ok_or(error!(RandomnessError::InvalidEeV4RoundResult))?;
            require!(ee_data.len() >= table_end, RandomnessError::InvalidEeV4RoundResult);

            let mut committed = false;
            let mut revealed  = false;
            for i in 0..commit_count {
                let base = EE_CONTRIBUTORS_OFFSET + i * EE_CONTRIBUTOR_ENTRY_SIZE;
                let who = Pubkey::from(
                    <[u8; 32]>::try_from(&ee_data[base..base + 32])
                        .map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?
                );
                // Either key may appear: the hot key signs commits today, and rounds
                // from before the V4.6 rotation carry the identity.
                if who == reg.x1_randomness_authority || who == reg.identity {
                    committed = true;
                    revealed  = ee_data[base + EE_CONTRIBUTOR_REVEALED_OFFSET] == 1;
                    break;
                }
            }

            require!(committed, RandomnessError::NotSelectedForRound);
            require!(!revealed, RandomnessError::Unauthorized);
        }

        ctx.accounts.miss_record.bump = ctx.bumps.miss_record;

        let reg = &mut ctx.accounts.validator_registration;
        reg.consecutive_misses = reg.consecutive_misses.saturating_add(1);
        if reg.consecutive_misses >= VALIDATOR_MAX_CONSECUTIVE_MISSES {
            reg.active = false;
            msg!(
                "Validator {} deactivated after {} consecutive misses",
                reg.identity, reg.consecutive_misses
            );
        }
        Ok(())
    }

    // ── EE V4 CPI Instructions ────────────────────────────────────────────

    /// Initialize an EE V4 round via CPI.
    /// Only registered active validators may open a round.
    /// n_contributors = EE_V4_N_CONTRIBUTORS and m_threshold = EE_V4_M_THRESHOLD;
    /// both are protocol constants, never caller-supplied.
    pub fn init_ee_round(
        ctx: Context<InitEeRound>,
        ee_round_id: u64,
    ) -> Result<()> {
        require!(
            ee_round_id == ctx.accounts.protocol_config.ee_v4_round_id.saturating_add(1),
            RandomnessError::Unauthorized
        );

        // n=7 commit slots, m=5 reveal threshold. With 9 registered validators,
        // 7 fill each round and up to 2 non-reveals still allow finalization.
        // Constants are tuned for the current validator set size — see EE_V4_N_CONTRIBUTORS.
        let n_contributors: u8 = EE_V4_N_CONTRIBUTORS;
        let m_threshold:    u8 = EE_V4_M_THRESHOLD;
        let current_slot       = Clock::get()?.slot;
        let binding_slot: u64  = current_slot.saturating_add(EE_V4_MIN_BINDING_SLOTS);
        {
            let vote_data = ctx.accounts.coordinator_vote.try_borrow_data()?;
            let stake_data = ctx.accounts.coordinator_stake.try_borrow_data()?;
            // Verify coordinator owns this vote account.
            require!(vote_data.len() >= VOTE_NODE_PUBKEY_OFFSET + 32, RandomnessError::InvalidVoteAccount);
            let node_pubkey = Pubkey::from(
                <[u8; 32]>::try_from(&vote_data[VOTE_NODE_PUBKEY_OFFSET..VOTE_NODE_PUBKEY_OFFSET + 32])
                    .map_err(|_| error!(RandomnessError::InvalidVoteAccount))?
            );
            // Vote account's node_pubkey must match the registered identity (not the hot key signer).
            require!(node_pubkey == ctx.accounts.coordinator_reg.identity, RandomnessError::Unauthorized);
            let (voter, lamports) = parse_stake_account(&stake_data)?;
            require!(voter == ctx.accounts.coordinator_vote.key(), RandomnessError::StakeNotDelegatedToVote);
            require!(lamports >= MIN_VALIDATOR_STAKE, RandomnessError::InsufficientValidatorStake);
            let last_vote = parse_last_vote_slot(&vote_data)?;
            require!(
                current_slot.saturating_sub(last_vote) < VALIDATOR_MAX_INACTIVE_SLOTS,
                RandomnessError::ValidatorNotActivelyVoting
            );
        }

        // Verify ee_round is a valid PDA derived from EE V4 program
        let expected_ee_round = Pubkey::find_program_address(
            &[
                b"round",
                ctx.accounts.coordinator.key().as_ref(),
                &ee_round_id.to_le_bytes(),
            ],
            &ENTROPY_ENGINE_V4,
        ).0;
        require!(
            ctx.accounts.ee_round.key() == expected_ee_round,
            RandomnessError::InvalidEeV4RoundResult
        );

        // Build CPI instruction data for EE V4 initialize_round
        // Anchor format: 8-byte discriminator + serialized args
        let disc = anchor_disc("global:initialize_round");
        let mut ix_data = Vec::with_capacity(8 + 8 + 1 + 1 + 8);
        ix_data.extend_from_slice(&disc);
        ix_data.extend_from_slice(&ee_round_id.to_le_bytes());
        ix_data.extend_from_slice(&[n_contributors]);
        ix_data.extend_from_slice(&[m_threshold]);
        ix_data.extend_from_slice(&binding_slot.to_le_bytes());

        let ee_program = ctx.accounts.ee_v4_program.key();
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ee_program,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.ee_round.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.coordinator.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(System::id(), false),
            ],
            data: ix_data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts.ee_round.to_account_info(),
                ctx.accounts.coordinator.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        ).map_err(|e| {
            msg!("EE V4 init_round CPI failed: {:?}", e);
            error!(RandomnessError::EeV4CpiFailed)
        })?;

        // Track in our wrapper round
        // round = ee_round_id so PDA seeds [b"wrapper-round", round] stay consistent
        let wrapper_round = &mut ctx.accounts.wrapper_round;
        wrapper_round.round = ee_round_id;
        wrapper_round.ee_v4_round_id = ee_round_id;
        wrapper_round.start_slot = current_slot;
        wrapper_round.aggregated = false;
        wrapper_round.aggregated_slot = 0;
        wrapper_round.entropy_output = [0u8; 32];
        wrapper_round.pending_requests = 0;
        wrapper_round.total_fees = 0;
        wrapper_round.ee_v4_entropy_included = false;
        wrapper_round.bump = ctx.bumps.wrapper_round;

        // Update protocol config to track current EE V4 round
        ctx.accounts.protocol_config.ee_v4_round_id = ee_round_id;

        // Stamp the fee escrow with the correct EE round ID so refund_request can
        // validate against the right round if it gets cancelled.
        ctx.accounts.fee_escrow.ee_v4_round_id = ee_round_id;

        Ok(())
    }

    /// Commit to an EE V4 round via CPI.
    /// Live-checks stake and vote activity at commit time — no mercy if offline.
    pub fn commit_via_ee(ctx: Context<CommitViaEe>, commitment: [u8; 32]) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        {
            let vote_data = ctx.accounts.vote_account.try_borrow_data()?;
            let stake_data = ctx.accounts.stake_account.try_borrow_data()?;

            // Verify accounts match registration.
            require!(
                ctx.accounts.vote_account.key() == ctx.accounts.validator_reg.vote_account,
                RandomnessError::InvalidVoteAccount
            );
            require!(
                ctx.accounts.stake_account.key() == ctx.accounts.validator_reg.stake_account,
                RandomnessError::InvalidStakeAccount
            );

            // Verify the vote account belongs to the registered identity (not the hot key signer).
            require!(vote_data.len() >= VOTE_NODE_PUBKEY_OFFSET + 32, RandomnessError::InvalidVoteAccount);
            let node_pubkey = Pubkey::from(
                <[u8; 32]>::try_from(&vote_data[VOTE_NODE_PUBKEY_OFFSET..VOTE_NODE_PUBKEY_OFFSET + 32])
                    .map_err(|_| error!(RandomnessError::InvalidVoteAccount))?
            );
            require!(node_pubkey == ctx.accounts.validator_reg.identity, RandomnessError::Unauthorized);

            let (voter, lamports) = parse_stake_account(&stake_data)?;
            require!(voter == ctx.accounts.vote_account.key(), RandomnessError::StakeNotDelegatedToVote);
            require!(lamports >= MIN_VALIDATOR_STAKE, RandomnessError::InsufficientValidatorStake);

            let last_vote = parse_last_vote_slot(&vote_data)?;
            require!(
                current_slot.saturating_sub(last_vote) < VALIDATOR_MAX_INACTIVE_SLOTS,
                RandomnessError::ValidatorNotActivelyVoting
            );

            // Update registration with confirmed active slot.
            let reg = &mut ctx.accounts.validator_reg;
            reg.last_active_slot = current_slot;
            reg.verified_stake = lamports;
        }

        // On-chain deterministic selection: derived from pool entropy + round id +
        // contributor pubkey. No keeper can control who is eligible — the selection
        // seed changes every round as entropy updates, and is unknown until the
        // previous round finalises. COMMIT_SELECTION_THRESHOLD = u64::MAX means all
        // active validators are currently eligible; lower it as the set grows.
        {
            let round_id = ctx.accounts.protocol_config.ee_v4_round_id;
            let mut seed_input = Vec::with_capacity(40);
            seed_input.extend_from_slice(&ctx.accounts.entropy_pool.current_entropy);
            seed_input.extend_from_slice(&round_id.to_le_bytes());
            let round_seed = hash(&seed_input).to_bytes();

            let mut val_input = Vec::with_capacity(64);
            val_input.extend_from_slice(&round_seed);
            // Use the stable identity key (not the potentially-rotated hot key) so that
            // eligibility is consistent across key rotations and matches the JS daemon check.
            val_input.extend_from_slice(ctx.accounts.validator_reg.identity.as_ref());
            let val_hash = hash(&val_input).to_bytes();

            let selector = u64::from_le_bytes(val_hash[..8].try_into().unwrap());
            require!(selector < COMMIT_SELECTION_THRESHOLD, RandomnessError::NotSelectedForRound);
        }

        // Verify ee_round is the canonical PDA for the current EE round.
        {
            let ee_data = ctx.accounts.ee_round.try_borrow_data()?;
            require!(ee_data.len() >= 48, RandomnessError::InvalidEeV4RoundResult);
            let coordinator_bytes: [u8; 32] = ee_data[8..40].try_into()
                .map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?;
            let coordinator = Pubkey::from(coordinator_bytes);
            let ee_round_id = u64::from_le_bytes(
                ee_data[40..48].try_into()
                    .map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?
            );
            require!(
                ee_round_id == ctx.accounts.protocol_config.ee_v4_round_id,
                RandomnessError::InvalidEeV4RoundResult
            );
            let (expected_ee_round, _) = Pubkey::find_program_address(
                &[b"round", coordinator.as_ref(), &ee_round_id.to_le_bytes()],
                &ENTROPY_ENGINE_V4,
            );
            require!(
                ctx.accounts.ee_round.key() == expected_ee_round,
                RandomnessError::InvalidEeV4RoundResult
            );
        }

        let disc = anchor_disc("global:commit");
        let mut ix_data = Vec::with_capacity(8 + 32);
        ix_data.extend_from_slice(&disc);
        ix_data.extend_from_slice(&commitment);

        let ee_program = ctx.accounts.ee_v4_program.key();
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ee_program,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.ee_round.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.contributor.key(), true),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(System::id(), false),
            ],
            data: ix_data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts.ee_round.to_account_info(),
                ctx.accounts.contributor.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        ).map_err(|e| {
            msg!("EE V4 commit CPI failed: {:?}", e);
            error!(RandomnessError::EeV4CpiFailed)
        })?;

        Ok(())
    }

    /// Reveal to an EE V4 round via CPI.
    /// Records the contributor's reveal so they can later claim their fee share.
    pub fn reveal_via_ee(ctx: Context<RevealViaEe>, secret: [u8; 32], nonce: [u8; 32]) -> Result<()> {
        // Verify ee_round is the canonical PDA for the current EE round.
        {
            let ee_data = ctx.accounts.ee_round.try_borrow_data()?;
            require!(ee_data.len() >= 48, RandomnessError::InvalidEeV4RoundResult);
            let coordinator_bytes: [u8; 32] = ee_data[8..40].try_into()
                .map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?;
            let coordinator = Pubkey::from(coordinator_bytes);
            let ee_round_id = u64::from_le_bytes(
                ee_data[40..48].try_into()
                    .map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?
            );
            require!(
                ee_round_id == ctx.accounts.protocol_config.ee_v4_round_id,
                RandomnessError::InvalidEeV4RoundResult
            );
            let (expected_ee_round, _) = Pubkey::find_program_address(
                &[b"round", coordinator.as_ref(), &ee_round_id.to_le_bytes()],
                &ENTROPY_ENGINE_V4,
            );
            require!(
                ctx.accounts.ee_round.key() == expected_ee_round,
                RandomnessError::InvalidEeV4RoundResult
            );
        }

        let disc = anchor_disc("global:reveal");
        let mut ix_data = Vec::with_capacity(8 + 32 + 32);
        ix_data.extend_from_slice(&disc);
        ix_data.extend_from_slice(&secret);
        ix_data.extend_from_slice(&nonce);

        let ee_program = ctx.accounts.ee_v4_program.key();
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ee_program,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.ee_round.key(), false),  // mutable: lamport transfer out
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.contributor.key(), true), // mutable: receives refund
            ],
            data: ix_data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts.ee_round.to_account_info(),
                ctx.accounts.contributor.to_account_info(),
            ],
        ).map_err(|e| {
            msg!("EE V4 reveal CPI failed: {:?}", e);
            error!(RandomnessError::EeV4CpiFailed)
        })?;

        // Record this contributor's reveal so they can claim their share of round fees.
        // contributor is stored as x1_randomness_authority (matches the PDA seed and
        // the address claim_validator_reward and mark_validator_missed expect).
        let vr = &mut ctx.accounts.validator_reveal;
        vr.contributor = ctx.accounts.validator_reg.x1_randomness_authority;
        vr.ee_round = ctx.accounts.ee_round.key();
        vr.protocol_round = ctx.accounts.protocol_config.current_round;
        vr.claimed = false;
        vr.bump = ctx.bumps.validator_reveal;

        // V4.8: a completed reveal is the only honest evidence of liveness, so it
        // is what clears the miss counter. Before this, `consecutive_misses` was
        // reset only by register_validator and refresh_validator_status, so misses
        // accumulated for the life of a registration — a validator that missed one
        // round, then revealed correctly for months, was still one step closer to
        // deactivation with nothing having gone wrong in between. The counter is
        // supposed to mean "misses in a row, right now", and only this path can
        // truthfully say the run has ended.
        let ee_round_id  = ctx.accounts.protocol_config.ee_v4_round_id;
        let current_slot = Clock::get()?.slot;
        let reg = &mut ctx.accounts.validator_reg;
        reg.consecutive_misses      = 0;
        reg.last_round_participated = ee_round_id;
        reg.last_active_slot        = current_slot;

        Ok(())
    }

    /// Finalize an EE V4 round via CPI, then mix the result into our entropy pool.
    pub fn finalize_via_ee(ctx: Context<FinalizeViaEe>) -> Result<()> {
        // CPI into EE V4 finalize
        let disc = anchor_disc("global:finalize");
        let mut ix_data = Vec::with_capacity(8);
        ix_data.extend_from_slice(&disc);

        let ee_program = ctx.accounts.ee_v4_program.key();
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: ee_program,
            accounts: vec![
                anchor_lang::solana_program::instruction::AccountMeta::new(ctx.accounts.ee_round.key(), false),
                anchor_lang::solana_program::instruction::AccountMeta::new_readonly(ctx.accounts.slot_hashes.key(), false),
            ],
            data: ix_data,
        };

        invoke(
            &ix,
            &[
                ctx.accounts.ee_round.to_account_info(),
                ctx.accounts.slot_hashes.to_account_info(),
            ],
        ).map_err(|e| {
            msg!("EE V4 finalize CPI failed: {:?}", e);
            error!(RandomnessError::EeV4CpiFailed)
        })?;

        // After finalize, read the EE V4 round's entropy_output and mix into our pool
        // EE V4 Round layout (after 8-byte discriminator):
        //   coordinator: Pubkey (32) @ offset 8
        //   round_id: u64 (8) @ offset 40
        //   ... entropy_output: [u8; 32] @ offset 8+32+8+1+1+8+8+8+1+1+32 = 8+99 = 107
        //   Actually let's read from the account data directly
        let ee_data = ctx.accounts.ee_round.try_borrow_data()?;

        // Verify round_id and status after successful CPI.
        require!(ee_data.len() >= 141, RandomnessError::InvalidEeV4RoundResult);
        let ee_round_id = u64::from_le_bytes(
            ee_data[40..48].try_into().map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?
        );
        require!(
            ee_round_id == ctx.accounts.wrapper_round.ee_v4_round_id,
            RandomnessError::InvalidEeV4RoundResult
        );
        // Explicit status check — CPI guarantees this but we verify defensively.
        require!(ee_data[140] == 2, RandomnessError::EeV4RoundNotFinalized);

        let ee_entropy = extract_ee_entropy(&ee_data)?;

        let current_slot = Clock::get()?.slot;
        // Use the most-recent slot hash from the SlotHashes sysvar rather than
        // hash(slot_number), which is fully predictable. The slot hash is derived
        // from PoH and cannot be known before the slot is completed.
        let slot_hash = read_slot_hash(&ctx.accounts.slot_hashes)?;

        // Mix: SHA256(ee_entropy ‖ slot_hash ‖ round_number ‖ 0xEE)
        let mut entropy_data = Vec::with_capacity(73);
        entropy_data.extend_from_slice(&ee_entropy);
        entropy_data.extend_from_slice(&slot_hash);
        entropy_data.extend_from_slice(&ctx.accounts.wrapper_round.round.to_le_bytes());
        entropy_data.extend_from_slice(&[0xEE_u8; 1]);

        let aggregated_entropy = hash(&entropy_data).to_bytes();

        // Update wrapper round
        let wrapper_round = &mut ctx.accounts.wrapper_round;
        wrapper_round.aggregated = true;
        wrapper_round.entropy_output = aggregated_entropy;
        wrapper_round.aggregated_slot = current_slot;
        wrapper_round.ee_v4_entropy_included = true;

        // Update entropy pool
        let pool = &mut ctx.accounts.entropy_pool;
        pool.current_entropy = aggregated_entropy;
        pool.current_round = wrapper_round.round;
        pool.entropy_available = true;
        pool.last_aggregated_slot = current_slot;
        pool.ee_v4_entropy_included = true;

        emit!(EntropyAggregatedEvent {
            round: wrapper_round.round,
            ee_v4_round_id: wrapper_round.ee_v4_round_id,
            entropy_output: aggregated_entropy,
            ee_v4_entropy_included: true,
            aggregated_slot: current_slot,
        });

        Ok(())
    }

    /// Aggregate entropy from an already-finalized EE V4 round.
    /// Use this when EE V4 was finalized externally (not via the wrapper).
    pub fn aggregate_from_ee(ctx: Context<AggregateFromEe>) -> Result<()> {
        // Read EE V4 round data
        let ee_data = ctx.accounts.ee_round.try_borrow_data()?;

        // Verify the round_id matches what we expect.
        // Accepts both: EE wrapper (ee_v4_round_id already set on wrapper_round)
        // and protocol wrapper (ee_v4_round_id=0, fall back to protocol_config.ee_v4_round_id).
        let resolved_ee_round_id = if ee_data.len() >= 48 {
            let mut ee_round_id_bytes = [0u8; 8];
            ee_round_id_bytes.copy_from_slice(&ee_data[40..48]);
            let ee_round_id = u64::from_le_bytes(ee_round_id_bytes);
            let expected = if ctx.accounts.wrapper_round.ee_v4_round_id != 0 {
                ctx.accounts.wrapper_round.ee_v4_round_id
            } else {
                ctx.accounts.protocol_config.ee_v4_round_id
            };
            require!(
                ee_round_id == expected,
                RandomnessError::InvalidEeV4RoundResult
            );
            ee_round_id
        } else {
            ctx.accounts.protocol_config.ee_v4_round_id
        };

        let ee_entropy = extract_ee_entropy(&ee_data)?;

        // Verify EE V4 round is finalized (status byte check)
        // EE V4 RoundStatus: CommitPhase=0, RevealPhase=1, Finalized=2, Cancelled=3
        // Layout: 8(disc)+32(coordinator)+8(round_id)+1+1+8+8+8+1+1+32(accum)+32(output) = 140
        require!(
            ee_data.len() > 140,
            RandomnessError::InvalidEeV4RoundResult
        );
        let status = ee_data[140];
        require!(status == 2, RandomnessError::EeV4RoundNotFinalized); // Finalized = 2

        let current_slot = Clock::get()?.slot;
        // Use the most-recent slot hash from the SlotHashes sysvar rather than
        // hash(slot_number), which is fully predictable. The slot hash is derived
        // from PoH and cannot be known before the slot is completed.
        let slot_hash = read_slot_hash(&ctx.accounts.slot_hashes)?;

        let mut entropy_data = Vec::with_capacity(73);
        entropy_data.extend_from_slice(&ee_entropy);
        entropy_data.extend_from_slice(&slot_hash);
        entropy_data.extend_from_slice(&ctx.accounts.wrapper_round.round.to_le_bytes());
        entropy_data.extend_from_slice(&[0xEE_u8; 1]);

        let aggregated_entropy = hash(&entropy_data).to_bytes();

        let wrapper_round = &mut ctx.accounts.wrapper_round;
        wrapper_round.aggregated = true;
        wrapper_round.entropy_output = aggregated_entropy;
        wrapper_round.aggregated_slot = current_slot;
        wrapper_round.ee_v4_entropy_included = true;
        wrapper_round.ee_v4_round_id = resolved_ee_round_id; // record in case it was 0

        // M-3: Stamp the fee escrow with the actual EE round ID that serviced this
        // protocol round. refund_request validates this field — without the stamp,
        // a cancelled-round refund could replay against a different EE round's escrow.
        ctx.accounts.fee_escrow.ee_v4_round_id = resolved_ee_round_id;

        let pool = &mut ctx.accounts.entropy_pool;
        pool.current_entropy = aggregated_entropy;
        pool.current_round = wrapper_round.round;
        pool.entropy_available = true;
        pool.last_aggregated_slot = current_slot;
        pool.ee_v4_entropy_included = true;

        emit!(EntropyAggregatedEvent {
            round: wrapper_round.round,
            ee_v4_round_id: resolved_ee_round_id,
            entropy_output: aggregated_entropy,
            ee_v4_entropy_included: true,
            aggregated_slot: current_slot,
        });

        Ok(())
    }

    pub fn advance_round(ctx: Context<AdvanceRound>) -> Result<()> {
        let config = &mut ctx.accounts.protocol_config;
        let current_slot = Clock::get()?.slot;

        // Guard against round spam: require stale entropy or sufficient time elapsed
        if config.current_round_start_slot != 0 && config.total_rounds > 0 {
            let slots_elapsed = current_slot.saturating_sub(config.current_round_start_slot);
            let pool_stale = !ctx.accounts.entropy_pool.entropy_available
                || (current_slot.saturating_sub(ctx.accounts.entropy_pool.last_aggregated_slot) > MIN_SLOTS_BETWEEN_ROUNDS * 2);
            require!(
                pool_stale || slots_elapsed >= MIN_SLOTS_BETWEEN_ROUNDS * 2,
                RandomnessError::RoundAdvanceTooEarly
            );
        }

        // H-2: Require the current round's WrapperRound to be aggregated before advancing.
        // Without this, a permissionless caller can advance mid-round, permanently stranding
        // the in-flight EE round with no matching protocol WrapperRound to aggregate into.
        if config.current_round > 0 {
            let (expected_pda, _) = Pubkey::find_program_address(
                &[b"wrapper-round", &config.current_round.to_le_bytes()],
                &ID,
            );
            require!(
                ctx.accounts.current_wrapper_round.key() == expected_pda,
                RandomnessError::Unauthorized
            );
            let wr_data = ctx.accounts.current_wrapper_round.try_borrow_data()?;
            // offset 32 = aggregated bool; non-empty account that isn't aggregated blocks advance
            if wr_data.len() > 32 {
                require!(wr_data[32] != 0, RandomnessError::RoundNotAggregatable);
            }
        }

        let new_round = config.current_round.checked_add(1)
            .ok_or(error!(RandomnessError::Overflow))?;

        let new_round_bytes = new_round.to_le_bytes();
        let (new_wr_pda, new_wr_bump) = Pubkey::find_program_address(
            &[b"wrapper-round", &new_round_bytes],
            &ID,
        );

        if ctx.accounts.new_wrapper_round.key() != new_wr_pda {
            return Err(error!(RandomnessError::Unauthorized));
        }

        let rent_lamports = Rent::get()?.minimum_balance(WrapperRound::INIT_SPACE);
        let space = WrapperRound::INIT_SPACE as u64;

        // Transfer lamports from caller to the new PDA account
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.caller.to_account_info(),
                    to: ctx.accounts.new_wrapper_round.to_account_info(),
                },
            ),
            rent_lamports,
        )?;

        // Allocate space and assign ownership via invoke_signed (PDA signs for itself)
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"wrapper-round",
            &new_round_bytes,
            &[new_wr_bump],
        ]];

        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::allocate(&new_wr_pda, space),
            &[ctx.accounts.new_wrapper_round.to_account_info(), ctx.accounts.system_program.to_account_info()],
            signer_seeds,
        )?;

        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::system_instruction::assign(&new_wr_pda, &ID),
            &[ctx.accounts.new_wrapper_round.to_account_info(), ctx.accounts.system_program.to_account_info()],
            signer_seeds,
        )?;

        // Write the account data manually — Anchor discriminator + initial fields
        {
            let mut data = ctx.accounts.new_wrapper_round.try_borrow_mut_data()?;
            // Zero out all data first
            for b in data.iter_mut() {
                *b = 0;
            }
            // Anchor discriminator for WrapperRound
            // Anchor discriminator for WrapperRound: sha256("account:WrapperRound")[..8]
            // Computed at build time to avoid trait import issues
            let disc_bytes = hash("account:WrapperRound".as_bytes()).to_bytes();
            let mut disc = [0u8; 8];
            disc.copy_from_slice(&disc_bytes[..8]);
            data[0..8].copy_from_slice(&disc);
            // round at offset 8
            data[8..16].copy_from_slice(&new_round.to_le_bytes());
            // ee_v4_round_id at offset 16 (will be set when init_ee_round is called)
            // start_slot at offset 24
            data[24..32].copy_from_slice(&current_slot.to_le_bytes());
            // bump at last byte
            data[space as usize - 1] = new_wr_bump;
        }

        config.current_round = new_round;
        config.current_round_start_slot = current_slot;
        config.total_rounds = config.total_rounds.checked_add(1)
            .ok_or(error!(RandomnessError::Overflow))?;

        Ok(())
    }

    /// Sweep any remaining fees (rounding dust after all validators claimed) to the protocol authority.
    /// Individual validators should use claim_validator_reward instead.
    pub fn claim_validator_fees(ctx: Context<ClaimValidatorFees>) -> Result<()> {
        let escrow = &mut ctx.accounts.fee_escrow;
        let amount = escrow.pending_fees;
        if amount == 0 {
            return Err(error!(RandomnessError::FeeEscrowInsufficient));
        }

        // Transfer all remaining fees to the protocol authority (recipient)
        **escrow.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.recipient.try_borrow_mut_lamports()? += amount;

        escrow.pending_fees = 0;

        emit!(ValidatorFeesClaimedEvent {
            round: escrow.round,
            amount,
            recipient: ctx.accounts.recipient.key(),
        });

        Ok(())
    }

    pub fn distribute_fees(ctx: Context<DistributeFees>) -> Result<()> {
        let escrow = &mut ctx.accounts.fee_escrow;

        // One-shot: prevents repeatedly calling this to drain more than 5% to crank.
        require!(!escrow.fee_distributed, RandomnessError::RoundAlreadyAggregated);

        let total_fees = escrow.pending_fees;
        require!(total_fees > 0, RandomnessError::FeeEscrowInsufficient);

        // Snapshot original_fees before crank cut — validators use this for their 95% share calc.
        escrow.original_fees = total_fees;

        // 5% to crank runner (one-time, never re-enterable); 95% stays for validators.
        let crank_share = total_fees
            .checked_mul(5)
            .ok_or(error!(RandomnessError::Overflow))? / 100;

        **escrow.to_account_info().try_borrow_mut_lamports()? -= crank_share;
        **ctx.accounts.crank.try_borrow_mut_lamports()? += crank_share;

        // 95% stays in escrow for validators — mark as distributed so claim is now unlocked.
        escrow.pending_fees = total_fees
            .checked_sub(crank_share)
            .ok_or(error!(RandomnessError::Overflow))?;
        escrow.fee_distributed = true;

        Ok(())
    }

    // ── Agent Subscription Instructions ────────────────────────────────────

    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        callback_program: Pubkey,
        callback_instruction: [u8; 8],
        min_round_interval: u64,
        seed: [u8; 32],
    ) -> Result<()> {
        let sub = &mut ctx.accounts.agent_subscription;
        sub.callback_program = callback_program;
        sub.callback_instruction = callback_instruction;
        sub.min_round_interval = min_round_interval;
        sub.last_served_round = 0;
        sub.total_callbacks = 0;
        sub.authority = ctx.accounts.authority.key();
        sub.seed = seed;
        sub.bump = ctx.bumps.agent_subscription;

        Ok(())
    }

    pub fn unregister_agent(_ctx: Context<UnregisterAgent>) -> Result<()> {
        Ok(())
    }

    pub fn deliver_callback(ctx: Context<DeliverCallback>) -> Result<()> {
        let sub = &mut ctx.accounts.agent_subscription;
        let pool = &ctx.accounts.entropy_pool;
        let config = &ctx.accounts.protocol_config;

        // M-1: Enforce at least 1 round between callbacks even when min_round_interval=0.
        // A zero interval allows the same caller to drain the pool's entropy in the same
        // round by calling deliver_callback repeatedly until sub.last_served_round catches up.
        let effective_interval = sub.min_round_interval.max(1);
        let rounds_since_last = config.current_round.saturating_sub(sub.last_served_round);
        if rounds_since_last < effective_interval {
            return Err(error!(RandomnessError::RoundIntervalNotMet));
        }

        let mut preimage = Vec::with_capacity(72);
        preimage.extend_from_slice(&pool.current_entropy);
        preimage.extend_from_slice(sub.callback_program.as_ref());
        preimage.extend_from_slice(&sub.seed);
        let derived_output = hash(&preimage).to_bytes();

        let mut ix_data = Vec::with_capacity(48);
        ix_data.extend_from_slice(&sub.callback_instruction);
        ix_data.extend_from_slice(&derived_output);
        ix_data.extend_from_slice(&pool.current_round.to_le_bytes());

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: sub.callback_program,
            accounts: vec![],
            data: ix_data,
        };

        anchor_lang::solana_program::program::invoke(&ix, &[])
            .map_err(|_| error!(RandomnessError::CallbackFailed))?;

        sub.last_served_round = config.current_round;
        sub.total_callbacks = sub.total_callbacks.checked_add(1)
            .ok_or(error!(RandomnessError::Overflow))?;

        emit!(CallbackDeliveredEvent {
            callback_program: sub.callback_program,
            derived_output,
            round: config.current_round,
            total_callbacks: sub.total_callbacks,
        });

        Ok(())
    }

    pub fn game_seed(ctx: Context<GameSeed>, game_id: [u8; 32]) -> Result<[u8; 32]> {
        require!(ctx.accounts.entropy_pool.entropy_available, RandomnessError::EntropyPoolNotAvailable);
        // Reject stale pool — same threshold as request_randomness fast path.
        // Without this, a watcher who knows the public pool entropy can precompute
        // game_seed outputs by trying all remaining slot hashes in the sysvar window.
        let slots_since_agg = Clock::get()?.slot
            .saturating_sub(ctx.accounts.entropy_pool.last_aggregated_slot);
        require!(slots_since_agg <= STALENESS_HARD_LIMIT_SLOTS, RandomnessError::EntropyPoolNotAvailable);

        // Collect game seed fee into the current round's escrow.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.fee_escrow.to_account_info(),
                },
            ),
            GAME_SEED_FEE_LAMPORTS,
        )?;
        ctx.accounts.fee_escrow.pending_fees = ctx.accounts.fee_escrow.pending_fees
            .checked_add(GAME_SEED_FEE_LAMPORTS)
            .ok_or(error!(RandomnessError::Overflow))?;

        let slot_hash = read_slot_hash(&ctx.accounts.slot_hashes)?;
        let output = {
            let pool = &ctx.accounts.entropy_pool;
            let mut preimage = Vec::with_capacity(128);
            preimage.extend_from_slice(&pool.current_entropy);
            preimage.extend_from_slice(&game_id);
            preimage.extend_from_slice(ctx.accounts.payer.key.as_ref());
            preimage.extend_from_slice(&slot_hash);
            hash(&preimage).to_bytes()
        };

        let pool = &mut ctx.accounts.entropy_pool;
        pool.total_game_seeds = pool.total_game_seeds
            .checked_add(1).ok_or(error!(RandomnessError::Overflow))?;

        emit!(GameSeedEvent {
            game_id,
            seed: output,
            pool_round: pool.current_round,
            pool_slot: pool.last_aggregated_slot,
        });

        Ok(output)
    }

    /// Fulfill a queue-path request that was created when the entropy pool was stale.
    /// Permissionless — anyone can call this once the pool is warm again.
    /// Produces the same output formula as the fast path:
    ///   SHA256(pool_entropy ‖ request_id ‖ slot_hash_NOW)
    pub fn fulfill_queued_request(ctx: Context<FulfillQueuedRequest>) -> Result<()> {
        let slots_since_agg = Clock::get()?.slot
            .saturating_sub(ctx.accounts.entropy_pool.last_aggregated_slot);
        require!(slots_since_agg <= STALENESS_HARD_LIMIT_SLOTS, RandomnessError::EntropyPoolNotAvailable);

        let slot_hash = read_slot_hash(&ctx.accounts.slot_hashes)?;
        let output = hash(
            &[
                &ctx.accounts.entropy_pool.current_entropy[..],
                &ctx.accounts.request_state.request_id[..],
                &slot_hash[..],
            ].concat()
        ).to_bytes();

        let request = &mut ctx.accounts.request_state;
        request.fulfilled = true;
        request.output = output;

        ctx.accounts.entropy_pool.total_requests_served = ctx.accounts.entropy_pool.total_requests_served
            .checked_add(1).ok_or(error!(RandomnessError::Overflow))?;

        Ok(())
    }

    /// One-time migration: expands EntropyPool from 67 → 75 bytes (adds total_game_seeds).
    /// Permissionless. Idempotent — returns AlreadyMigrated if already 75 bytes.
    /// Must be called once before any game_seed call after the V4.3 upgrade.
    pub fn migrate_entropy_pool(ctx: Context<MigrateEntropyPool>) -> Result<()> {
        let pool_info = ctx.accounts.entropy_pool.to_account_info();
        {
            let data = pool_info.try_borrow_data()?;
            require!(data.len() != EntropyPool::INIT_SPACE, RandomnessError::AlreadyMigrated);
            require!(data.len() == 67, RandomnessError::InvalidEeV4RoundResult);
            // EntropyPool discriminator: sha256("account:EntropyPool")[0..8]
            require!(
                data[0..8] == [27u8, 58, 82, 79, 166, 202, 159, 93],
                RandomnessError::AccountDiscriminatorMismatch
            );
        }

        // Fund the account for 8 extra bytes of rent-exemption.
        let rent = Rent::get()?;
        let extra_lamports = rent
            .minimum_balance(EntropyPool::INIT_SPACE)
            .saturating_sub(pool_info.lamports());
        if extra_lamports > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: pool_info.clone(),
                    },
                ),
                extra_lamports,
            )?;
        }

        // Grow to 75 bytes; zero the new 8 bytes so total_game_seeds starts at 0.
        pool_info.realloc(EntropyPool::INIT_SPACE, false)?;
        let mut data = pool_info.try_borrow_mut_data()?;
        for i in 67..EntropyPool::INIT_SPACE {
            data[i] = 0;
        }

        Ok(())
    }

    pub fn verify_entropy(ctx: Context<VerifyEntropy>, request_id: [u8; 32]) -> Result<()> {
        let round = &ctx.accounts.wrapper_round;
        let request = &ctx.accounts.request_state;

        // Sanity-check: the wrapper_round that produced this request must be the one supplied.
        // For fast-path requests, request.round == pool.current_round at request time,
        // which equals wrapper_round.round for the EE wrapper that warmed the pool.
        // Callers must supply the wrapper_round that matches the request's round.
        require!(
            request.round == round.round,
            RandomnessError::InvalidEeV4RoundResult
        );

        let receipt = &mut ctx.accounts.entropy_receipt;
        receipt.round = round.round;
        receipt.entropy_output = round.entropy_output;
        receipt.reveal_count = 0; // EE V4 tracks this internally
        receipt.committee_size = 0;
        receipt.aggregated_slot = round.aggregated_slot;
        receipt.ee_v4_included = round.ee_v4_entropy_included;
        receipt.request_id = request_id;
        // Use the actual stored output from the RequestState — the canonical proof.
        receipt.derived_output = request.output;
        receipt.bump = ctx.bumps.entropy_receipt;

        emit!(EntropyVerifiedEvent {
            round: round.round,
            entropy_output: round.entropy_output,
            derived_output: receipt.derived_output,
            ee_v4_included: round.ee_v4_entropy_included,
        });

        Ok(())
    }

    /// Update the protocol-wide request fee. Authority-only.
    pub fn set_fee(ctx: Context<SetFee>, new_fee: u64) -> Result<()> {
        ctx.accounts.protocol_config.request_fee = new_fee;
        Ok(())
    }

    /// Set a per-dApp fee override. Use 0 to revert to the protocol default.
    /// Callable by the dApp's registered authority.
    pub fn update_dapp_fee(ctx: Context<UpdateDappFee>, fee_override: u64) -> Result<()> {
        ctx.accounts.dapp_registration.fee_override = fee_override;
        Ok(())
    }

    /// Claim a validator's proportional share of round fees.
    /// Share = original_fees * 95% / reveal_count.
    /// Requires distribute_fees to have run and the validator to have a ValidatorReveal PDA.
    pub fn claim_validator_reward(ctx: Context<ClaimValidatorReward>) -> Result<()> {
        // Read reveal_count from EE V4 round data (offset 75, u8).
        let ee_data = ctx.accounts.ee_round.try_borrow_data()?;
        require!(ee_data.len() > 76, RandomnessError::InvalidEeV4RoundResult);
        let reveal_count = ee_data[75] as u64;
        require!(reveal_count > 0, RandomnessError::InvalidEeV4RoundResult);

        // Verify this EE round is the one that served the protocol round in the fee escrow.
        // Prevents a validator who revealed in a different (older) EE round for this same
        // protocol round from draining the escrow.
        require!(ee_data.len() >= 48, RandomnessError::InvalidEeV4RoundResult);
        let ee_round_id_in_account = u64::from_le_bytes(
            ee_data[40..48].try_into()
                .map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?
        );
        require!(
            ee_round_id_in_account == ctx.accounts.fee_escrow.ee_v4_round_id,
            RandomnessError::InvalidEeV4RoundResult
        );

        let escrow = &mut ctx.accounts.fee_escrow;
        // Per-validator share = 95% of pre-crank total / number of revealers.
        let validator_share = escrow.original_fees
            .checked_mul(95).ok_or(error!(RandomnessError::Overflow))?
            .checked_div(100).ok_or(error!(RandomnessError::Overflow))?
            .checked_div(reveal_count).ok_or(error!(RandomnessError::Overflow))?;

        require!(escrow.pending_fees >= validator_share, RandomnessError::FeeEscrowInsufficient);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= validator_share;
        **ctx.accounts.contributor.try_borrow_mut_lamports()? += validator_share;

        escrow.pending_fees = escrow.pending_fees
            .checked_sub(validator_share).ok_or(error!(RandomnessError::Overflow))?;

        ctx.accounts.validator_reveal.claimed = true;

        emit!(ValidatorRewardClaimedEvent {
            contributor: ctx.accounts.contributor.key(),
            protocol_round: ctx.accounts.validator_reveal.protocol_round,
            amount: validator_share,
        });

        Ok(())
    }

    /// Refund a queued request whose EE V4 round was cancelled (threshold not met).
    /// Returns the fee_paid from the escrow to the requester and closes the RequestState.
    pub fn refund_request(ctx: Context<RefundRequest>) -> Result<()> {
        // Verify EE V4 round is Cancelled (status byte == 3 at offset 140)
        // and belongs to this protocol round's fee escrow.
        {
            // Guard: escrow must be linked to an EE round before refunds are allowed.
            // ee_v4_round_id is set by aggregate_from_ee; if 0, the round never completed
            // and the correct flow is to wait or use a legitimate cancelled-round refund.
            // A zero escrow id also means any EE round id == 0 would match, which is
            // impossible for real rounds (they start at 1) but we reject it explicitly.
            require!(
                ctx.accounts.fee_escrow.ee_v4_round_id != 0,
                RandomnessError::EeV4RoundNotFinalized
            );

            let ee_data = ctx.accounts.ee_round.try_borrow_data()?;
            require!(ee_data.len() > 140, RandomnessError::InvalidEeV4RoundResult);
            let status = ee_data[140];
            require!(status == 3, RandomnessError::EeV4RoundNotFinalized); // 3 = Cancelled

            // Verify the EE round belongs to this protocol round's fee escrow.
            require!(ee_data.len() >= 48, RandomnessError::InvalidEeV4RoundResult);
            let ee_round_id_in_account = u64::from_le_bytes(
                ee_data[40..48].try_into()
                    .map_err(|_| error!(RandomnessError::InvalidEeV4RoundResult))?
            );
            require!(
                ee_round_id_in_account == ctx.accounts.fee_escrow.ee_v4_round_id,
                RandomnessError::InvalidEeV4RoundResult
            );
        }

        let fee = ctx.accounts.request_state.fee_paid;
        let escrow = &mut ctx.accounts.fee_escrow;
        require!(escrow.pending_fees >= fee, RandomnessError::FeeEscrowInsufficient);

        **escrow.to_account_info().try_borrow_mut_lamports()? -= fee;
        **ctx.accounts.requester.try_borrow_mut_lamports()? += fee;

        escrow.pending_fees = escrow.pending_fees
            .checked_sub(fee).ok_or(error!(RandomnessError::Overflow))?;

        // request_state is closed by Anchor's `close = requester` constraint, returning rent.

        Ok(())
    }

    pub fn close_request(_ctx: Context<CloseRequest>) -> Result<()> {
        Ok(())
    }

    pub fn close_escrow(_ctx: Context<CloseEscrow>) -> Result<()> {
        Ok(())
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Read the most-recent slot hash from the SlotHashes sysvar.
///
/// SlotHashes format: u64 count (LE) followed by N entries of (u64 slot, [u8;32] hash).
/// The first entry is the most recently completed slot — not predictable before that slot
/// finishes, making it a much stronger salt than hash(current_slot_number).
fn read_slot_hash(slot_hashes_info: &AccountInfo) -> Result<[u8; 32]> {
    let data = slot_hashes_info.try_borrow_data()?;
    // Need at least 8 (count) + 8 (slot) + 32 (hash) = 48 bytes
    if data.len() < 48 {
        return Err(error!(RandomnessError::InvalidEeV4RoundResult));
    }
    let count = u64::from_le_bytes(data[0..8].try_into().unwrap());
    if count == 0 {
        return Err(error!(RandomnessError::InvalidEeV4RoundResult));
    }
    // Entry 0: bytes 8..15 = slot, bytes 16..48 = hash
    let mut slot_hash = [0u8; 32];
    slot_hash.copy_from_slice(&data[16..48]);
    Ok(slot_hash)
}

/// Extract entropy_output from EE V4 Round account data.
/// EE V4 Round layout (after 8-byte Anchor discriminator):
///   coordinator: Pubkey (32 bytes)     @ 8
///   round_id: u64 (8 bytes)            @ 40
///   n_contributors: u8 (1 byte)        @ 48
///   m_threshold: u8 (1 byte)           @ 49
///   commit_deadline: u64 (8 bytes)    @ 50
///   reveal_deadline: u64 (8 bytes)    @ 58
///   binding_slot: u64 (8 bytes)       @ 66
///   commit_count: u8 (1 byte)         @ 74
///   reveal_count: u8 (1 byte)         @ 75
///   entropy_accumulator: [u8; 32]    @ 76
///   entropy_output: [u8; 32]         @ 108
fn extract_ee_entropy(data: &[u8]) -> Result<[u8; 32]> {
    const ENTROPY_OUTPUT_OFFSET: usize = 108; // Already includes discriminator in Anchor account data
    if data.len() < ENTROPY_OUTPUT_OFFSET + 32 {
        return Err(error!(RandomnessError::InvalidEeV4RoundResult));
    }
    let mut entropy = [0u8; 32];
    entropy.copy_from_slice(&data[ENTROPY_OUTPUT_OFFSET..ENTROPY_OUTPUT_OFFSET + 32]);
    // Check it's not all zeros (uninitialized)
    if entropy == [0u8; 32] {
        return Err(error!(RandomnessError::EeV4RoundNotFinalized));
    }
    Ok(entropy)
}

/// Parse a Solana/X1 stake account and return (voter_pubkey, active_staked_lamports).
///
/// Layout (bincode): tag u32 | Meta(120 bytes) | Delegation: voter_pubkey(32) @ 124
///   | stake u64 @ 156 | activation_epoch u64 @ 164 | deactivation_epoch u64 @ 172
///
/// Offsets verified against live X1 mainnet accounts.
fn parse_stake_account(data: &[u8]) -> Result<(Pubkey, u64)> {
    require!(data.len() >= 180, RandomnessError::InvalidStakeAccount);
    let tag = u32::from_le_bytes(data[STAKE_TAG_OFFSET..STAKE_TAG_OFFSET + 4].try_into().unwrap());
    require!(tag == STAKE_VARIANT_ACTIVE, RandomnessError::InvalidStakeAccount);

    let voter_bytes: [u8; 32] = data[STAKE_VOTER_PUBKEY_OFFSET..STAKE_VOTER_PUBKEY_OFFSET + 32]
        .try_into().map_err(|_| error!(RandomnessError::InvalidStakeAccount))?;
    let voter_pubkey = Pubkey::from(voter_bytes);

    let lamports = u64::from_le_bytes(
        data[STAKE_LAMPORTS_OFFSET..STAKE_LAMPORTS_OFFSET + 8]
            .try_into().map_err(|_| error!(RandomnessError::InvalidStakeAccount))?
    );

    let deactivation_epoch = u64::from_le_bytes(
        data[STAKE_DEACTIVATION_EPOCH_OFFSET..STAKE_DEACTIVATION_EPOCH_OFFSET + 8]
            .try_into().map_err(|_| error!(RandomnessError::InvalidStakeAccount))?
    );
    require!(deactivation_epoch == DEACTIVATION_EPOCH_NONE, RandomnessError::StakeDeactivating);

    Ok((voter_pubkey, lamports))
}

/// Parse a Solana/X1 vote account and return the last voted slot.
///
/// Layout: version u32(4) | node_pubkey(32) | authorized_withdrawer(32) | commission u8(1)
///   | votes_len u64 @ 69 | LandedVote×N from @ 77
///   LandedVote = latency u8(1) + slot u64(8) + confirmation_count u32(4) = 13 bytes
///
/// Returns the slot of the most recent (last) vote entry.
/// Offsets verified against live X1 mainnet accounts.
fn parse_last_vote_slot(data: &[u8]) -> Result<u64> {
    require!(data.len() >= 4, RandomnessError::InvalidVoteAccount);
    let version = u32::from_le_bytes(
        data[0..4].try_into().map_err(|_| error!(RandomnessError::InvalidVoteAccount))?
    );

    // Locate the votes VecDeque length prefix. The header size differs by version:
    //   V3 (disc 2): votes len u64 at offset 69
    //   V4 (disc 3, SIMD-0185): votes len u64 at 145 (bls None) or 193 (bls Some)
    let len_offset = match version {
        VOTE_STATE_V3 => VOTE_VOTES_LEN_OFFSET,
        VOTE_STATE_V4 => {
            require!(data.len() > VOTE_V4_BLS_OPTION_OFFSET, RandomnessError::InvalidVoteAccount);
            let bls_some = data[VOTE_V4_BLS_OPTION_OFFSET] == 1;
            VOTE_V4_VOTES_LEN_OFFSET_NONE + if bls_some { VOTE_V4_BLS_SOME_EXTRA } else { 0 }
        }
        _ => return Err(error!(RandomnessError::InvalidVoteAccount)),
    };
    let votes_start = len_offset + 8;

    require!(data.len() >= votes_start, RandomnessError::InvalidVoteAccount);
    let count = u64::from_le_bytes(
        data[len_offset..len_offset + 8]
            .try_into().map_err(|_| error!(RandomnessError::InvalidVoteAccount))?
    ) as usize;
    require!(count > 0, RandomnessError::ValidatorNotActivelyVoting);
    // Defensive: a valid vote tower holds at most MAX_LOCKOUT_HISTORY lockouts. Reject
    // anything larger rather than trusting a possibly-misparsed length (prevents the
    // (count-1)*ENTRY_SIZE overflow that bricked init on the V3→V4 vote-format change).
    require!(count <= MAX_LOCKOUT_HISTORY, RandomnessError::InvalidVoteAccount);

    // Checked arithmetic throughout — a malformed account returns an error, never panics.
    let last_entry_base = count
        .checked_sub(1).ok_or(error!(RandomnessError::InvalidVoteAccount))?
        .checked_mul(VOTE_ENTRY_SIZE).ok_or(error!(RandomnessError::InvalidVoteAccount))?
        .checked_add(votes_start).ok_or(error!(RandomnessError::InvalidVoteAccount))?;
    let slot_offset = last_entry_base
        .checked_add(VOTE_SLOT_OFFSET_IN_ENTRY).ok_or(error!(RandomnessError::InvalidVoteAccount))?;
    require!(data.len() >= slot_offset + 8, RandomnessError::InvalidVoteAccount);

    let slot = u64::from_le_bytes(
        data[slot_offset..slot_offset + 8]
            .try_into().map_err(|_| error!(RandomnessError::InvalidVoteAccount))?
    );
    Ok(slot)
}

// ── Events ──────────────────────────────────────────────────────────────────

#[event]
pub struct GameSeedEvent {
    pub game_id: [u8; 32],
    pub seed: [u8; 32],
    pub pool_round: u64,
    pub pool_slot: u64,
}

#[event]
pub struct EntropyVerifiedEvent {
    pub round: u64,
    pub entropy_output: [u8; 32],
    pub derived_output: [u8; 32],
    pub ee_v4_included: bool,
}

#[event]
pub struct CallbackDeliveredEvent {
    pub callback_program: Pubkey,
    pub derived_output: [u8; 32],
    pub round: u64,
    pub total_callbacks: u64,
}

#[event]
pub struct ValidatorFeesClaimedEvent {
    pub round: u64,
    pub amount: u64,
    pub recipient: Pubkey,
}

#[event]
pub struct EntropyAggregatedEvent {
    pub round: u64,
    pub ee_v4_round_id: u64,
    pub entropy_output: [u8; 32],
    pub ee_v4_entropy_included: bool,
    pub aggregated_slot: u64,
}

#[event]
pub struct ValidatorRewardClaimedEvent {
    pub contributor: Pubkey,
    pub protocol_round: u64,
    pub amount: u64,
}