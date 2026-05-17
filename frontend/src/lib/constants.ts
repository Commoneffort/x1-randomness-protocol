// X1 Randomness Protocol V4 Constants

export const PROGRAM_ID = "BSKTJpgAGHRaSMLA88chYPKuSuD9qbesEcHYmUrBWU7R";
export const ENTROPY_ENGINE_V4 = "FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm";

// RPC
export const RPC_URL = "https://rpc.mainnet.x1.xyz";

// Fee constants (lamports)
export const REQUEST_FEE_LAMPORTS         = 10_000_000;  // 0.01 XNT — standard tier
export const PREMIUM_REQUEST_FEE_LAMPORTS = 50_000_000;  // 0.05 XNT — premium tier (casinos/games)
export const GAME_SEED_FEE_LAMPORTS       = 1_000_000;   // 0.001 XNT
export const EE_V4_STAKE_LAMPORTS         = 10_000_000;  // 0.01 XNT (returned on valid reveal)

// Timing
export const SLOT_DURATION_MS = 375;               // ~375ms per slot on X1 mainnet
export const STALENESS_HARD_LIMIT_SLOTS = 1_500;   // ~10 min — pool considered dead past this
export const EE_V4_MIN_BINDING_SLOTS = 675;        // minimum binding slot offset

// Fee distribution
export const FEE_VALIDATORS_PCT = 90;
export const FEE_INSURANCE_PCT = 10;

// Anchor instruction discriminators: sha256("global:<name>")[:8]
export const DISC = {
  register_dapp:            Buffer.from([60,68,39,184,75,93,48,129]),
  unregister_dapp:          Buffer.from([36,230,112,150,210,101,90,243]),
  request_randomness:       Buffer.from([213,5,173,166,37,236,31,18]),
  game_seed:                Buffer.from([154,214,16,146,213,175,151,159]),
  set_fee:                  Buffer.from([18,154,24,18,237,214,19,80]),
  update_dapp_fee:          Buffer.from([170,224,111,179,148,124,31,81]),
  claim_validator_reward:   Buffer.from([255,194,143,228,188,239,126,109]),
  refund_request:           Buffer.from([209,53,99,171,128,139,169,155]),
  advance_round:            Buffer.from([230,88,119,80,54,4,212,250]),
  create_fee_escrow:        Buffer.from([254,195,157,38,44,238,132,87]),
  register_validator:       Buffer.from([118,98,251,58,81,30,13,240]),
  deregister_validator:     Buffer.from([141,36,209,110,154,252,220,211]),
  refresh_validator_status: Buffer.from([159,12,231,123,118,114,209,66]),
};

// Anchor account discriminators: sha256("account:<Name>")[:8]
export const ACCT_DISC = {
  DappRegistration:       Buffer.from([3,84,148,231,130,18,2,52]),
  WrapperRound:           Buffer.from([233,8,112,71,52,26,164,91]),
  FeeEscrow:              Buffer.from([244,221,184,35,66,174,39,186]),
  EntropyPool:            Buffer.from([27,58,82,79,166,202,159,93]),
  ProtocolConfig:         Buffer.from([207,91,250,28,152,179,215,209]),
  RequestState:           Buffer.from([106,141,109,114,88,187,109,5]),
  ValidatorReveal:        Buffer.from([77,28,28,161,178,110,69,39]),
  ValidatorRegistration:  Buffer.from([8,207,107,171,248,66,249,38]),
};

// Validator registry constants
export const MIN_VALIDATOR_STAKE_XNT = 1000;
export const MIN_VALIDATOR_STAKE_LAMPORTS = MIN_VALIDATOR_STAKE_XNT * 1_000_000_000;
export const VALIDATOR_MAX_INACTIVE_SLOTS = 500;
export const MIN_COMMITTEE_SIZE = 2;
