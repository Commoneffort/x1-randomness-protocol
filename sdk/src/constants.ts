export const PROGRAM_ID = "BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr";
export const ENTROPY_ENGINE_V4 = "FDyWtM9UBNfXNuc5oZJ1V86d3dz635WnqMfX8x5Uifbm";
export const REQUEST_FEE_LAMPORTS = 10_000_000; // 0.01 XNT
export const COMMITTEE_SIZE = 21;
export const MIN_VALIDATOR_BOND = 1_000_000_000; // 1 XNT

// Fast round constants
export const ROUND_SLOTS = 75;              // ~30 seconds at 400ms/slot
export const COMMIT_PHASE_SLOTS = 25;       // slots 0-24 (~10 seconds)
export const REVEAL_PHASE_SLOTS = 25;       // slots 25-49 (~10 seconds)
export const MIN_REVEAL_THRESHOLD = 14;     // 14/21 validators needed
export const SLOT_DURATION_MS = 400;         // X1 slot time