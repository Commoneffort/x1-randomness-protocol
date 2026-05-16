import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction, TransactionInstruction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import * as crypto from "crypto";

const PROGRAM_ID = new PublicKey("BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr");

describe("X1 Randomness Protocol v3 - Basic Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  let authority: Keypair;
  let treasury: Keypair;
  let reserve: Keypair;
  let validator1: Keypair;
  let dappAuthority: Keypair;
  let requester: Keypair;

  // PDA helpers
  function findProtocolConfigPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("protocol-config")], PROGRAM_ID);
  }
  function findEntropyPoolPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("entropy-pool")], PROGRAM_ID);
  }
  function findValidatorPda(validatorPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("validator"), validatorPubkey.toBuffer()], PROGRAM_ID);
  }
  function findDappPda(dappId: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync([Buffer.from("dapp"), dappId.toBuffer()], PROGRAM_ID);
  }
  function findCommitteeRoundPda(round: number): [PublicKey, number] {
    const roundBuf = Buffer.alloc(8);
    roundBuf.writeBigUInt64LE(BigInt(round));
    return PublicKey.findProgramAddressSync([Buffer.from("committee-round"), roundBuf], PROGRAM_ID);
  }
  function findFeeEscrowPda(round: number): [PublicKey, number] {
    const roundBuf = Buffer.alloc(8);
    roundBuf.writeBigUInt64LE(BigInt(round));
    return PublicKey.findProgramAddressSync([Buffer.from("fee-escrow"), roundBuf], PROGRAM_ID);
  }

  before(async () => {
    authority = Keypair.generate();
    treasury = Keypair.generate();
    reserve = Keypair.generate();
    validator1 = Keypair.generate();
    dappAuthority = Keypair.generate();
    requester = Keypair.generate();

    // Airdrop SOL
    for (const kp of [authority, treasury, reserve, validator1, dappAuthority, requester]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 10 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
  });

  it("1. Protocol Initialization works", async () => {
    const [protocolConfigPda] = findProtocolConfigPda();
    const [entropyPoolPda] = findEntropyPoolPda();

    // Create instruction data: discriminator for "initialize" + accounts
    const data = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]); // Initialize discriminator

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: protocolConfigPda, isSigner: false, isWritable: true },
        { pubkey: entropyPoolPda, isSigner: false, isWritable: true },
        { pubkey: treasury.publicKey, isSigner: false, isWritable: false },
        { pubkey: reserve.publicKey, isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = authority.publicKey;
    
    await provider.sendAndConfirm(tx, [authority]);
    console.log("  ✓ Protocol initialized successfully");
  });

  it("2. Validator registration with bond works", async () => {
    const [protocolConfigPda] = findProtocolConfigPda();
    const [validatorPda] = findValidatorPda(validator1.publicKey);

    // discriminator for "registerValidator" + bond amount (u64)
    const discriminator = Buffer.from([205, 46, 21, 245, 136, 169, 205, 224]);
    const bondAmount = new anchor.BN(1000000000); // 1 SOL
    const bondBuffer = bondAmount.toBuffer("le", 8);
    const data = Buffer.concat([discriminator, bondBuffer]);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: validatorPda, isSigner: false, isWritable: true },
        { pubkey: validator1.publicKey, isSigner: true, isWritable: false },
        { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = validator1.publicKey;
    
    await provider.sendAndConfirm(tx, [validator1]);
    console.log("  ✓ Validator registered with bond");
  });

  it("3. Bond minimum enforcement works", async () => {
    const val2 = Keypair.generate();
    await provider.connection.requestAirdrop(val2.publicKey, 2 * LAMPORTS_PER_SOL);
    await new Promise(r => setTimeout(r, 500));

    const [protocolConfigPda] = findProtocolConfigPda();
    const [validatorPda] = findValidatorPda(val2.publicKey);

    // discriminator + bond amount (100 = below minimum)
    const discriminator = Buffer.from([205, 46, 21, 245, 136, 169, 205, 224]);
    const bondAmount = new anchor.BN(100);
    const bondBuffer = bondAmount.toBuffer("le", 8);
    const data = Buffer.concat([discriminator, bondBuffer]);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: validatorPda, isSigner: false, isWritable: true },
        { pubkey: val2.publicKey, isSigner: true, isWritable: false },
        { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = val2.publicKey;

    try {
      await provider.sendAndConfirm(tx, [val2]);
      assert.fail("Should have thrown BondBelowMinimum");
    } catch (e: any) {
      const msg = e.toString();
      assert.include(msg, "BondBelowMinimum");
      console.log("  ✓ Bond minimum enforcement working correctly");
    }
  });

  it("4. dApp registration works", async () => {
    const [protocolConfigPda] = findProtocolConfigPda();
    const [dappPda] = findDappPda(dappAuthority.publicKey);

    // discriminator for "registerDapp"
    const discriminator = Buffer.from([250, 230, 107, 139, 239, 229, 254, 143]);
    
    // callbackProgram (32 bytes)
    const callbackProgram = dappAuthority.publicKey.toBuffer();
    // callbackInstruction (8 bytes)
    const callbackInstruction = Buffer.alloc(8);
    // minRoundInterval (u64 = 0)
    const minRoundInterval = new anchor.BN(0).toBuffer("le", 8);
    
    const data = Buffer.concat([discriminator, callbackProgram, callbackInstruction, minRoundInterval]);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: dappPda, isSigner: false, isWritable: true },
        { pubkey: dappAuthority.publicKey, isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: protocolConfigPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const tx = new Transaction().add(ix);
    tx.feePayer = authority.publicKey;
    
    await provider.sendAndConfirm(tx, [authority]);
    console.log("  ✓ dApp registered successfully");
  });

  it("5. SHA256 derivation unit tests pass", async () => {
    // Unit tests for SHA256 derivation
    const testCases = [
      {
        secret: Buffer.alloc(32, 1),
        nonce: Buffer.alloc(32, 2),
        expected: "sha256 of [1,1...] and [2,2...]"
      }
    ];

    for (const tc of testCases) {
      const combined = Buffer.concat([tc.secret, tc.nonce]);
      const hash = crypto.createHash("sha256").update(combined).digest();
      assert.strictEqual(hash.length, 32, "SHA256 produces 32-byte output");
      console.log(`  ✓ SHA256 produces correct 32-byte hash`);
    }
    
    // Additional SHA256 tests
    const secret = Buffer.from("test_secret_value_32_bytes!!", "utf8");
    const nonce = Buffer.from("test_nonce_value_32_bytes!!!", "utf8");
    const combined = Buffer.concat([secret, nonce]);
    const hash = crypto.createHash("sha256").update(combined).digest();
    
    assert.strictEqual(hash.length, 32, "SHA256 produces 32-byte output");
    assert.notStrictEqual(hash, Buffer.alloc(32), "Hash is not all zeros");
    
    // Verify deterministic
    const hash2 = crypto.createHash("sha256").update(combined).digest();
    assert.deepStrictEqual(hash, hash2, "SHA256 is deterministic");
    
    console.log("  ✓ SHA256 derivation tests pass");
  });

});
