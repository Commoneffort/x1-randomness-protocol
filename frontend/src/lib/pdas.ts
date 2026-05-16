import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

const PID = new PublicKey(PROGRAM_ID);

function u64le(n: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

export function findProtocolConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol-config")], PID);
}

export function findEntropyPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("entropy-pool")], PID);
}

export function findDappPda(dappId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("dapp"), dappId.toBuffer()], PID);
}

export function findWrapperRoundPda(round: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("wrapper-round"), u64le(round)], PID);
}

export function findFeeEscrowPda(round: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("fee-escrow"), u64le(round)], PID);
}

export function findRequestPda(requester: PublicKey, seed: Buffer): [PublicKey, number] {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  return PublicKey.findProgramAddressSync([Buffer.from("request"), requester.toBuffer(), seed], PID);
}

export function findReceiptPda(requestId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("receipt"), requestId], PID);
}

export function findAgentSubPda(authority: PublicKey, seed: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("agent-sub"), authority.toBuffer(), seed], PID);
}

export function findValidatorRevealPda(eeRound: PublicKey, contributor: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("validator-reveal"), eeRound.toBuffer(), contributor.toBuffer()],
    PID
  );
}

export function findValRegPda(identity: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("val-reg"), identity.toBuffer()],
    PID
  );
}
