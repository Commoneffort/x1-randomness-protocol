import { Idl } from "@coral-xyz/anchor";

export const IDL: Idl = {
  "version": "0.1.0",
  "name": "randomness_wrapper",
  "instructions": [
    {
      "name": "initialize",
      "accounts": [
        { "name": "protocolConfig", "isMut": true, "isSigner": false },
        { "name": "entropyPool", "isMut": true, "isSigner": false },
        { "name": "insuranceFund", "isMut": false, "isSigner": false },
        { "name": "authority", "isMut": true, "isSigner": true },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "registerValidator",
      "accounts": [
        { "name": "validatorReg", "isMut": true, "isSigner": false },
        { "name": "validator", "isMut": true, "isSigner": true },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": [{ "name": "bondAmount", "type": "u64" }]
    },
    {
      "name": "registerDapp",
      "accounts": [
        { "name": "dappRegistration", "isMut": true, "isSigner": false },
        { "name": "dappId", "isMut": false, "isSigner": false },
        { "name": "authority", "isMut": true, "isSigner": true },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": [
        { "name": "callbackProgram", "type": "publicKey" },
        { "name": "callbackInstruction", "type": { "array": ["u8", 8] } },
        { "name": "minRoundInterval", "type": "u64" }
      ]
    },
    {
      "name": "unregisterDapp",
      "accounts": [
        { "name": "dappRegistration", "isMut": true, "isSigner": false },
        { "name": "authority", "isMut": true, "isSigner": true },
        { "name": "protocolConfig", "isMut": false, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "requestRandomness",
      "accounts": [
        { "name": "requestState", "isMut": true, "isSigner": false },
        { "name": "dappRegistration", "isMut": false, "isSigner": false },
        { "name": "entropyPool", "isMut": true, "isSigner": false },
        { "name": "feeEscrow", "isMut": true, "isSigner": false },
        { "name": "requester", "isMut": true, "isSigner": true },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": [
        { "name": "seed", "type": { "array": ["u8", 32] } },
        { "name": "callbackProgram", "type": "publicKey" },
        { "name": "callbackInstruction", "type": { "array": ["u8", 8] } }
      ]
    },
    {
      "name": "commit",
      "accounts": [
        { "name": "committeeRound", "isMut": true, "isSigner": false },
        { "name": "validatorReg", "isMut": true, "isSigner": false },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "validator", "isMut": false, "isSigner": true }
      ],
      "args": [{ "name": "secretHash", "type": { "array": ["u8", 32] } }]
    },
    {
      "name": "reveal",
      "accounts": [
        { "name": "committeeRound", "isMut": true, "isSigner": false },
        { "name": "validatorReg", "isMut": false, "isSigner": false },
        { "name": "validator", "isMut": false, "isSigner": true }
      ],
      "args": [
        { "name": "secret", "type": { "array": ["u8", 32] } },
        { "name": "nonce", "type": { "array": ["u8", 32] } }
      ]
    },
    {
      "name": "advanceRound",
      "accounts": [
        { "name": "protocolConfig", "isMut": true, "isSigner": false },
        { "name": "entropyPool", "isMut": true, "isSigner": false },
        { "name": "committeeRound", "isMut": true, "isSigner": false },
        { "name": "feeEscrow", "isMut": true, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "aggregateAndCallback",
      "accounts": [
        { "name": "committeeRound", "isMut": true, "isSigner": false },
        { "name": "requestState", "isMut": true, "isSigner": false },
        { "name": "entropyPool", "isMut": true, "isSigner": false },
        { "name": "dappRegistration", "isMut": false, "isSigner": false },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "feeEscrow", "isMut": false, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "slashNonRevealers",
      "accounts": [
        { "name": "committeeRound", "isMut": true, "isSigner": false },
        { "name": "protocolConfig", "isMut": true, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "distributeFees",
      "accounts": [
        { "name": "feeEscrow", "isMut": true, "isSigner": false },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "insuranceFund", "isMut": true, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "withdrawBond",
      "accounts": [
        { "name": "validatorReg", "isMut": true, "isSigner": false },
        { "name": "validator", "isMut": true, "isSigner": true },
        { "name": "protocolConfig", "isMut": false, "isSigner": false }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "ProtocolConfig",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "authority", "type": "publicKey" },
          { "name": "insurance_fund", "type": "publicKey" },
          { "name": "currentRound", "type": "u64" },
          { "name": "currentRoundStartSlot", "type": "u64" },
          { "name": "roundDurationSlots", "type": "u64" },
          { "name": "commitPhaseSlots", "type": "u64" },
          { "name": "revealPhaseSlots", "type": "u64" },
          { "name": "revealThreshold", "type": "u32" },
          { "name": "committeeSize", "type": "u32" },
          { "name": "minBond", "type": "u64" },
          { "name": "requestFee", "type": "u64" },
          { "name": "totalRounds", "type": "u64" },
          { "name": "bump", "type": "u8" }
        ]
      }
    },
    {
      "name": "EntropyPool",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "currentEntropy", "type": { "array": ["u8", 32] } },
          { "name": "currentRound", "type": "u64" },
          { "name": "entropyAvailable", "type": "bool" },
          { "name": "lastAggregatedSlot", "type": "u64" },
          { "name": "totalRequestsServed", "type": "u64" },
          { "name": "bump", "type": "u8" }
        ]
      }
    },
    {
      "name": "DappRegistration",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "dappId", "type": "publicKey" },
          { "name": "callbackProgram", "type": "publicKey" },
          { "name": "callbackInstruction", "type": { "array": ["u8", 8] } },
          { "name": "minRoundInterval", "type": "u64" },
          { "name": "lastServedRound", "type": "u64" },
          { "name": "totalRequests", "type": "u64" },
          { "name": "authority", "type": "publicKey" },
          { "name": "bump", "type": "u8" }
        ]
      }
    },
    {
      "name": "RequestState",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "requestId", "type": { "array": ["u8", 32] } },
          { "name": "requester", "type": "publicKey" },
          { "name": "seed", "type": { "array": ["u8", 32] } },
          { "name": "callbackProgram", "type": "publicKey" },
          { "name": "callbackInstruction", "type": { "array": ["u8", 8] } },
          { "name": "round", "type": "u64" },
          { "name": "fulfilled", "type": "bool" },
          { "name": "output", "type": { "array": ["u8", 32] } },
          { "name": "feePaid", "type": "u64" },
          { "name": "createdSlot", "type": "u64" },
          { "name": "bump", "type": "u8" }
        ]
      }
    },
    {
      "name": "CommitteeRound",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "round", "type": "u64" },
          { "name": "startSlot", "type": "u64" },
          { "name": "entropyOutput", "type": { "array": ["u8", 32] } },
          { "name": "entropySet", "type": "bool" },
          { "name": "committee", "type": { "vec": "publicKey" } },
          { "name": "commitments", "type": { "vec": { "array": ["u8", 32] } } },
          { "name": "committed", "type": { "vec": "bool" } },
          { "name": "reveals", "type": { "vec": { "array": ["u8", 32] } } },
          { "name": "revealed", "type": { "vec": "bool" } },
          { "name": "commitCount", "type": "u32" },
          { "name": "revealCount", "type": "u32" },
          { "name": "aggregated", "type": "bool" },
          { "name": "aggregatedSlot", "type": "u64" },
          { "name": "pendingRequests", "type": "u32" },
          { "name": "requests", "type": { "vec": { "array": ["u8", 32] } } },
          { "name": "totalFees", "type": "u64" },
          { "name": "bump", "type": "u8" }
        ]
      }
    },
    {
      "name": "ValidatorRegistration",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "validator", "type": "publicKey" },
          { "name": "bond", "type": "u64" },
          { "name": "roundsParticipated", "type": "u64" },
          { "name": "roundsMissed", "type": "u64" },
          { "name": "inCommittee", "type": "bool" },
          { "name": "bump", "type": "u8" }
        ]
      }
    },
    {
      "name": "FeeEscrow",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "pendingFees", "type": "u64" },
          { "name": "round", "type": "u64" },
          { "name": "bump", "type": "u8" }
        ]
      }
    }
  ]
};
