// Auto-generated type definitions for X1 Randomness Protocol v3
// Matches the hand-written IDL in target/idl/randomness_wrapper.json

export interface ProtocolConfig {
  authority: PublicKey;
  treasury: PublicKey;
  reserve: PublicKey;
  currentRound: BN;
  currentRoundStartSlot: BN;
  roundDurationSlots: BN;
  commitPhaseSlots: BN;
  revealPhaseSlots: BN;
  revealThreshold: number;
  committeeSize: number;
  minBond: BN;
  requestFee: BN;
  totalRounds: BN;
  bump: number;
}

export interface EntropyPool {
  currentEntropy: number[];
  currentRound: BN;
  entropyAvailable: boolean;
  lastAggregatedSlot: BN;
  totalRequestsServed: BN;
  bump: number;
}

export interface DappRegistration {
  dappId: PublicKey;
  callbackProgram: PublicKey;
  callbackInstruction: number[];
  minRoundInterval: BN;
  lastServedRound: BN;
  totalRequests: BN;
  authority: PublicKey;
  bump: number;
}

export interface RequestState {
  requestId: number[];
  requester: PublicKey;
  seed: number[];
  callbackProgram: PublicKey;
  callbackInstruction: number[];
  round: BN;
  fulfilled: boolean;
  output: number[];
  feePaid: BN;
  createdSlot: BN;
  bump: number;
}

export interface CommitteeRound {
  round: BN;
  startSlot: BN;
  entropyOutput: number[];
  entropySet: boolean;
  committee: PublicKey[];
  commitments: number[][];
  committed: boolean[];
  reveals: number[][];
  revealed: boolean[];
  commitCount: number;
  revealCount: number;
  aggregated: boolean;
  aggregatedSlot: BN;
  pendingRequests: number;
  requests: number[][];
  totalFees: BN;
  bump: number;
}

export interface ValidatorRegistration {
  validator: PublicKey;
  bond: BN;
  roundsParticipated: BN;
  roundsMissed: BN;
  inCommittee: boolean;
  bump: number;
}

export interface FeeEscrow {
  pendingFees: BN;
  round: BN;
  bump: number;
}

import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";