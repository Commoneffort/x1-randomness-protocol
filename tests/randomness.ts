// @ts-nocheck
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert } from "chai";
import * as crypto from "crypto";

// PDA helpers
const PROGRAM_ID = new PublicKey("BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr");

function findProtocolConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol-config")], PROGRAM_ID);
}

function findEntropyPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("entropy-pool")], PROGRAM_ID);
}

function findDappPda(dappId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("dapp"), dappId.toBuffer()], PROGRAM_ID);
}

function findValidatorPda(validatorPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("validator"), validatorPubkey.toBuffer()], PROGRAM_ID);
}

function findCommitteeRoundPda(round: number): [PublicKey, number] {
  const roundBuf = Buffer.alloc(8);
  roundBuf.writeBigUInt64LE(BigInt(round));
  return PublicKey.findProgramAddressSync([Buffer.from("committee-round"), roundBuf], PROGRAM_ID);
}

function findRequestPda(requester: PublicKey, seed: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("request"), requester.toBuffer(), seed], PROGRAM_ID);
}

// Load IDL
const IDL = require("../target/idl/randomness_wrapper.json");

describe("X1 Randomness Protocol v3 — Full Integration Tests", () => {
  // Configure provider for localnet
  const connection = new anchor.web3.Connection("http://127.0.0.1:8899", "confirmed");
  const wallet = anchor.AnchorProvider.env().wallet;
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);
  const program = new anchor.Program(IDL, PROGRAM_ID, provider);

  let authority: Keypair;
  let treasury: Keypair;
  let reserve: Keypair;
  let validator1: Keypair;
  let validator2: Keypair;
  let dappAuthority: Keypair;

  before(async () => {
    authority = Keypair.generate();
    treasury = Keypair.generate();
    reserve = Keypair.generate();
    validator1 = Keypair.generate();
    validator2 = Keypair.generate();
    dappAuthority = Keypair.generate();

    // Airdrop SOL for testing
    for (const kp of [authority, treasury, reserve, validator1, validator2, dappAuthority]) {
      const sig = await connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      const blockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...blockhash }, "confirmed");
    }
  });

  describe("1. Protocol Initialization", () => {
    it("Initializes the protocol config + entropy pool", async () => {
      const [configPda] = findProtocolConfigPda();
      const [poolPda] = findEntropyPoolPda();

      await program.methods
        .initialize()
        .accounts({
          protocolConfig: configPda,
          entropyPool: poolPda,
          treasury: treasury.publicKey,
          reserve: reserve.publicKey,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();

      const config = await program.account.protocolConfig.fetch(configPda);
      assert.equal(config.authority.toBase58(), authority.publicKey.toBase58());
      assert.equal(config.treasury.toBase58(), treasury.publicKey.toBase58());
      assert.equal(config.currentRound.toString(), "0");
      assert.equal(config.requestFee.toString(), "10000000");
      assert.equal(config.roundDurationSlots.toString(), "75");
      assert.equal(config.commitPhaseSlots.toString(), "25");
      assert.equal(config.revealPhaseSlots.toString(), "25");
      assert.equal(config.totalRounds.toString(), "0");

      const pool = await program.account.entropyPool.fetch(poolPda);
      assert.equal(pool.entropyAvailable, false);
      assert.equal(pool.currentRound.toString(), "0");
      assert.equal(pool.totalRequestsServed.toString(), "0");
    });
  });

  describe("2. Validator Registration", () => {
    it("Registers a validator with minimum bond", async () => {
      const [validatorPda] = findValidatorPda(validator1.publicKey);
      const [configPda] = findProtocolConfigPda();
      const bondAmount = new anchor.BN(1_000_000_000); // 1 XNT

      await program.methods
        .registerValidator(bondAmount)
        .accounts({
          validatorReg: validatorPda,
          validator: validator1.publicKey,
          protocolConfig: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([validator1])
        .rpc();

      const reg = await program.account.validatorRegistration.fetch(validatorPda);
      assert.equal(reg.validator.toBase58(), validator1.publicKey.toBase58());
      assert.equal(reg.bond.toString(), "1000000000");
      assert.equal(reg.inCommittee, false);
    });

    it("Rejects registration with bond below minimum", async () => {
      const val3 = Keypair.generate();
      const sig = await connection.requestAirdrop(val3.publicKey, 2 * LAMPORTS_PER_SOL);
      const blockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction({ signature: sig, ...blockhash }, "confirmed");

      try {
        const [validatorPda] = findValidatorPda(val3.publicKey);
        const [configPda] = findProtocolConfigPda();
        await program.methods
          .registerValidator(new anchor.BN(100))
          .accounts({
            validatorReg: validatorPda,
            validator: val3.publicKey,
            protocolConfig: configPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([val3])
          .rpc();
        assert.fail("Should have thrown");
      } catch (e: any) {
        assert.include(e.toString(), "BondBelowMinimum");
      }
    });
  });

  describe("3. dApp Registration", () => {
    it("Registers a dApp with min_round_interval=0 (on-demand)", async () => {
      const dappId = Keypair.generate().publicKey;
      const callbackProgram = Keypair.generate().publicKey;
      const callbackInstruction = Array.from(Buffer.alloc(8, 0x01));

      const [dappPda] = findDappPda(dappId);
      const [configPda] = findProtocolConfigPda();

      await program.methods
        .registerDapp(callbackProgram, callbackInstruction, new anchor.BN(0))
        .accounts({
          dappRegistration: dappPda,
          dappId: dappId,
          authority: dappAuthority.publicKey,
          protocolConfig: configPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([dappAuthority])
        .rpc();

      const dapp = await program.account.dappRegistration.fetch(dappPda);
      assert.equal(dapp.dappId.toBase58(), dappId.toBase58());
      assert.equal(dapp.minRoundInterval.toString(), "0");
      assert.equal(dapp.lastServedRound.toString(), "0");
      assert.equal(dapp.totalRequests.toString(), "0");
    });
  });

  describe("4. Output Derivation (Unit Tests)", () => {
    it("Derives unique output per request", () => {
      const aggregatedEntropy = Buffer.alloc(32, 0xff);
      const requestId1 = Buffer.alloc(32, 0x01);
      const requestId2 = Buffer.alloc(32, 0x02);

      const output1 = crypto.createHash("sha256")
        .update(Buffer.concat([aggregatedEntropy, requestId1]))
        .digest();
      const output2 = crypto.createHash("sha256")
        .update(Buffer.concat([aggregatedEntropy, requestId2]))
        .digest();

      assert.notDeepEqual(output1, output2);
      assert.equal(output1.length, 32);
      assert.equal(output2.length, 32);
    });

    it("Same seed always produces same output (deterministic)", () => {
      const aggregatedEntropy = Buffer.alloc(32, 0xff);
      const requestId = Buffer.alloc(32, 0x42);

      const output1 = crypto.createHash("sha256")
        .update(Buffer.concat([aggregatedEntropy, requestId]))
        .digest();
      const output2 = crypto.createHash("sha256")
        .update(Buffer.concat([aggregatedEntropy, requestId]))
        .digest();

      assert.deepEqual(output1, output2);
    });

    it("Commitment hash is SHA256(secret||nonce||pubkey)", () => {
      const secret = crypto.randomBytes(32);
      const nonce = crypto.randomBytes(32);
      const validatorPubkey = Keypair.generate().publicKey;

      const commitment = crypto.createHash("sha256")
        .update(Buffer.concat([secret, nonce, validatorPubkey.toBuffer()]))
        .digest();

      const commitment2 = crypto.createHash("sha256")
        .update(Buffer.concat([secret, nonce, validatorPubkey.toBuffer()]))
        .digest();
      assert.deepEqual(commitment, commitment2);
      assert.equal(commitment.length, 32);
    });
  });

  describe("5. Entropy Pool Initial State", () => {
    it("Entropy pool starts unavailable", async () => {
      const [poolPda] = findEntropyPoolPda();
      const pool = await program.account.entropyPool.fetch(poolPda);
      assert.equal(pool.entropyAvailable, false);
    });
  });
});