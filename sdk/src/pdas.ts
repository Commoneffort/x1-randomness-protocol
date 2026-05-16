import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

export function findProtocolConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol-config")],
    new PublicKey(PROGRAM_ID)
  );
}

export function findEntropyPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("entropy-pool")],
    new PublicKey(PROGRAM_ID)
  );
}

export function findDappPda(dappId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("dapp"), dappId.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

export function findCommitteeRoundPda(round: number): [PublicKey, number] {
  const roundBuf = Buffer.alloc(8);
  roundBuf.writeBigUInt64LE(BigInt(round));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("committee-round"), roundBuf],
    new PublicKey(PROGRAM_ID)
  );
}

export function findFeeEscrowPda(round: number): [PublicKey, number] {
  const roundBuf = Buffer.alloc(8);
  roundBuf.writeBigUInt64LE(BigInt(round));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee-escrow"), roundBuf],
    new PublicKey(PROGRAM_ID)
  );
}

export function findValidatorPda(validatorPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("validator"), validatorPubkey.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

/**
 * Find the RequestState PDA.
 * Seeds: ["request", requester_pubkey, seed_32_bytes]
 */
export function findRequestPda(
  requester: PublicKey,
  seed: Buffer
): [PublicKey, number] {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  return PublicKey.findProgramAddressSync(
    [Buffer.from("request"), requester.toBuffer(), seed],
    new PublicKey(PROGRAM_ID)
  );
}

/**
 * Compute the deterministic request ID (not the PDA, but the logical ID stored in RequestState).
 * request_id = SHA256(callback_program || callback_instruction || seed || requester)
 */
export function computeRequestId(
  callbackProgram: PublicKey,
  callbackInstruction: Buffer,
  seed: Buffer,
  requester: PublicKey
): Buffer {
  const crypto = require("crypto");
  const preimage = Buffer.concat([
    callbackProgram.toBuffer(),
    callbackInstruction,
    seed,
    requester.toBuffer(),
  ]);
  return crypto.createHash("sha256").update(preimage).digest();
}