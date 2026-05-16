import json

idl = {
    "version": "0.1.0",
    "name": "randomness_wrapper",
    "instructions": [
        {
            "name": "initialize",
            "accounts": [
                {"name": "protocolConfig", "isMut": True, "isSigner": False},
                {"name": "entropyPool", "isMut": True, "isSigner": False},
                {"name": "treasury", "isMut": False, "isSigner": False},
                {"name": "reserve", "isMut": False, "isSigner": False},
                {"name": "authority", "isMut": True, "isSigner": True},
                {"name": "systemProgram", "isMut": False, "isSigner": False},
            ],
            "args": [],
        },
        {
            "name": "register_validator",
            "accounts": [
                {"name": "validatorReg", "isMut": True, "isSigner": False},
                {"name": "validator", "isMut": True, "isSigner": True},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
                {"name": "systemProgram", "isMut": False, "isSigner": False},
            ],
            "args": [
                {"name": "bondAmount", "type": "u64"},
            ],
        },
        {
            "name": "register_dapp",
            "accounts": [
                {"name": "dappRegistration", "isMut": True, "isSigner": False},
                {"name": "dappId", "isMut": False, "isSigner": False},
                {"name": "authority", "isMut": True, "isSigner": True},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
                {"name": "systemProgram", "isMut": False, "isSigner": False},
            ],
            "args": [
                {"name": "callbackProgram", "type": "publicKey"},
                {"name": "callbackInstruction", "type": {"array": ["u8", 8]}},
                {"name": "minRoundInterval", "type": "u64"},
            ],
        },
        {
            "name": "unregister_dapp",
            "accounts": [
                {"name": "dappRegistration", "isMut": True, "isSigner": False},
                {"name": "authority", "isMut": True, "isSigner": True},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
            ],
            "args": [],
        },
        {
            "name": "request_randomness",
            "accounts": [
                {"name": "requestState", "isMut": True, "isSigner": False},
                {"name": "dappRegistration", "isMut": False, "isSigner": False},
                {"name": "entropyPool", "isMut": True, "isSigner": False},
                {"name": "feeEscrow", "isMut": True, "isSigner": False},
                {"name": "requester", "isMut": True, "isSigner": True},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
                {"name": "systemProgram", "isMut": False, "isSigner": False},
            ],
            "args": [
                {"name": "seed", "type": {"array": ["u8", 32]}},
                {"name": "callbackProgram", "type": "publicKey"},
                {"name": "callbackInstruction", "type": {"array": ["u8", 8]}},
            ],
        },
        {
            "name": "commit",
            "accounts": [
                {"name": "committeeRound", "isMut": True, "isSigner": False},
                {"name": "validatorReg", "isMut": True, "isSigner": False},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
                {"name": "validator", "isMut": False, "isSigner": True},
            ],
            "args": [
                {"name": "secretHash", "type": {"array": ["u8", 32]}},
            ],
        },
        {
            "name": "reveal",
            "accounts": [
                {"name": "committeeRound", "isMut": True, "isSigner": False},
                {"name": "validatorReg", "isMut": False, "isSigner": False},
                {"name": "validator", "isMut": False, "isSigner": True},
            ],
            "args": [
                {"name": "secret", "type": {"array": ["u8", 32]}},
                {"name": "nonce", "type": {"array": ["u8", 32]}},
            ],
        },
        {
            "name": "advance_round",
            "accounts": [
                {"name": "protocolConfig", "isMut": True, "isSigner": False},
                {"name": "entropyPool", "isMut": True, "isSigner": False},
                {"name": "committeeRound", "isMut": True, "isSigner": False},
                {"name": "feeEscrow", "isMut": True, "isSigner": False},
                {"name": "systemProgram", "isMut": False, "isSigner": False},
            ],
            "args": [],
        },
        {
            "name": "aggregate_and_callback",
            "accounts": [
                {"name": "committeeRound", "isMut": True, "isSigner": False},
                {"name": "requestState", "isMut": True, "isSigner": False},
                {"name": "entropyPool", "isMut": True, "isSigner": False},
                {"name": "dappRegistration", "isMut": False, "isSigner": False},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
                {"name": "feeEscrow", "isMut": False, "isSigner": False},
            ],
            "args": [],
        },
        {
            "name": "slash_non_revealers",
            "accounts": [
                {"name": "committeeRound", "isMut": True, "isSigner": False},
                {"name": "protocolConfig", "isMut": True, "isSigner": False},
            ],
            "args": [],
        },
        {
            "name": "distribute_fees",
            "accounts": [
                {"name": "feeEscrow", "isMut": True, "isSigner": False},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
                {"name": "treasury", "isMut": True, "isSigner": False},
                {"name": "reserve", "isMut": True, "isSigner": False},
            ],
            "args": [],
        },
        {
            "name": "withdraw_bond",
            "accounts": [
                {"name": "validatorReg", "isMut": True, "isSigner": False},
                {"name": "validator", "isMut": True, "isSigner": True},
                {"name": "protocolConfig", "isMut": False, "isSigner": False},
            ],
            "args": [],
        },
        {
            "name": "update_authority",
            "accounts": [
                {"name": "protocolConfig", "isMut": True, "isSigner": False},
                {"name": "authority", "isMut": False, "isSigner": True},
            ],
            "args": [
                {"name": "newAuthority", "type": "publicKey"},
            ],
        },
        {
            "name": "update_fees",
            "accounts": [
                {"name": "protocolConfig", "isMut": True, "isSigner": False},
                {"name": "authority", "isMut": False, "isSigner": True},
            ],
            "args": [
                {"name": "newFee", "type": "u64"},
            ],
        },
    ],
    "accounts": [
        {
            "name": "ProtocolConfig",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "authority", "type": "publicKey"},
                    {"name": "treasury", "type": "publicKey"},
                    {"name": "reserve", "type": "publicKey"},
                    {"name": "currentRound", "type": "u64"},
                    {"name": "currentRoundStartSlot", "type": "u64"},
                    {"name": "roundDurationSlots", "type": "u64"},
                    {"name": "commitPhaseSlots", "type": "u64"},
                    {"name": "revealPhaseSlots", "type": "u64"},
                    {"name": "revealThreshold", "type": "u32"},
                    {"name": "committeeSize", "type": "u32"},
                    {"name": "minBond", "type": "u64"},
                    {"name": "requestFee", "type": "u64"},
                    {"name": "totalRounds", "type": "u64"},
                    {"name": "bump", "type": "u8"},
                ],
            },
        },
        {
            "name": "EntropyPool",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "currentEntropy", "type": {"array": ["u8", 32]}},
                    {"name": "currentRound", "type": "u64"},
                    {"name": "entropyAvailable", "type": "bool"},
                    {"name": "lastAggregatedSlot", "type": "u64"},
                    {"name": "totalRequestsServed", "type": "u64"},
                    {"name": "bump", "type": "u8"},
                ],
            },
        },
        {
            "name": "DappRegistration",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "dappId", "type": "publicKey"},
                    {"name": "callbackProgram", "type": "publicKey"},
                    {"name": "callbackInstruction", "type": {"array": ["u8", 8]}},
                    {"name": "minRoundInterval", "type": "u64"},
                    {"name": "lastServedRound", "type": "u64"},
                    {"name": "totalRequests", "type": "u64"},
                    {"name": "authority", "type": "publicKey"},
                    {"name": "bump", "type": "u8"},
                ],
            },
        },
        {
            "name": "RequestState",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "requestId", "type": {"array": ["u8", 32]}},
                    {"name": "requester", "type": "publicKey"},
                    {"name": "seed", "type": {"array": ["u8", 32]}},
                    {"name": "callbackProgram", "type": "publicKey"},
                    {"name": "callbackInstruction", "type": {"array": ["u8", 8]}},
                    {"name": "round", "type": "u64"},
                    {"name": "fulfilled", "type": "bool"},
                    {"name": "output", "type": {"array": ["u8", 32]}},
                    {"name": "feePaid", "type": "u64"},
                    {"name": "createdSlot", "type": "u64"},
                    {"name": "bump", "type": "u8"},
                ],
            },
        },
        {
            "name": "CommitteeRound",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "round", "type": "u64"},
                    {"name": "startSlot", "type": "u64"},
                    {"name": "entropyOutput", "type": {"array": ["u8", 32]}},
                    {"name": "entropySet", "type": "bool"},
                    {"name": "committee", "type": {"vec": "publicKey"}},
                    {"name": "commitments", "type": {"vec": {"array": ["u8", 32]}}},
                    {"name": "committed", "type": {"vec": "bool"}},
                    {"name": "reveals", "type": {"vec": {"array": ["u8", 32]}}},
                    {"name": "revealed", "type": {"vec": "bool"}},
                    {"name": "commitCount", "type": "u32"},
                    {"name": "revealCount", "type": "u32"},
                    {"name": "aggregated", "type": "bool"},
                    {"name": "aggregatedSlot", "type": "u64"},
                    {"name": "pendingRequests", "type": "u32"},
                    {"name": "requests", "type": {"vec": {"array": ["u8", 32]}}},
                    {"name": "totalFees", "type": "u64"},
                    {"name": "bump", "type": "u8"},
                ],
            },
        },
        {
            "name": "ValidatorRegistration",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "validator", "type": "publicKey"},
                    {"name": "bond", "type": "u64"},
                    {"name": "roundsParticipated", "type": "u64"},
                    {"name": "roundsMissed", "type": "u64"},
                    {"name": "inCommittee", "type": "bool"},
                    {"name": "bump", "type": "u8"},
                ],
            },
        },
        {
            "name": "FeeEscrow",
            "type": {
                "kind": "struct",
                "fields": [
                    {"name": "pendingFees", "type": "u64"},
                    {"name": "round", "type": "u64"},
                    {"name": "bump", "type": "u8"},
                ],
            },
        },
    ],
    "errors": [
        {"code": 6000, "name": "InsufficientFee", "msg": "Insufficient fee provided"},
        {"code": 6001, "name": "CommitmentMismatch", "msg": "Invalid commitment: hash mismatch"},
        {"code": 6002, "name": "ValidatorNotRegistered", "msg": "Validator not registered"},
        {"code": 6003, "name": "AlreadyCommitted", "msg": "Validator already committed this round"},
        {"code": 6004, "name": "AlreadyRevealed", "msg": "Validator already revealed this round"},
        {"code": 6005, "name": "NotInCommittee", "msg": "Validator not in current committee"},
        {"code": 6006, "name": "RoundNotAggregatable", "msg": "Round not yet aggregatable"},
        {"code": 6007, "name": "RoundAlreadyAggregated", "msg": "Round already aggregated"},
        {"code": 6008, "name": "BondBelowMinimum", "msg": "Bond amount below minimum"},
        {"code": 6009, "name": "ValidatorInCommittee", "msg": "Cannot withdraw: validator in active committee"},
        {"code": 6010, "name": "NoNonRevealers", "msg": "No non-revealers to slash"},
        {"code": 6011, "name": "FeeEscrowInsufficient", "msg": "Fee escrow balance insufficient"},
        {"code": 6012, "name": "RequestNotFulfilled", "msg": "Request not yet fulfilled"},
        {"code": 6013, "name": "Unauthorized", "msg": "Unauthorized"},
        {"code": 6014, "name": "Overflow", "msg": "Arithmetic overflow"},
        {"code": 6015, "name": "NotInCommitPhase", "msg": "Not in commit phase"},
        {"code": 6016, "name": "NotInRevealPhase", "msg": "Not in reveal phase"},
        {"code": 6017, "name": "RoundNotExpired", "msg": "Round not yet expired"},
        {"code": 6018, "name": "EntropyPoolNotAvailable", "msg": "Entropy pool not available"},
        {"code": 6019, "name": "DappNotRegistered", "msg": "DApp not registered"},
        {"code": 6020, "name": "DappAlreadyRegistered", "msg": "DApp already registered"},
        {"code": 6021, "name": "RoundIntervalNotMet", "msg": "Round interval not met"},
        {"code": 6022, "name": "NoPendingRequests", "msg": "No pending requests"},
    ],
    "metadata": {"origin": "anchor"},
}

with open('target/idl/randomness_wrapper.json', 'w') as f:
    json.dump(idl, f, indent=2)

print(f"IDL written: {len(idl['instructions'])} instructions, {len(idl['accounts'])} accounts, {len(idl['errors'])} errors")