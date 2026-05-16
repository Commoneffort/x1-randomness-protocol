/**
 * X1 Randomness Protocol - Validator Commit/Reveal Daemon
 * 
 * Runs alongside X1 validators to participate in the randomness protocol committee.
 * Handles commit/reveal phases for each round with automatic recovery.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Commitment,
  clusterApiUrl,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import winston from "winston";
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// IDL - copied from target/idl
const IDL = {
  "version": "0.1.0",
  "name": "randomness_wrapper",
  "instructions": [
    {
      "name": "commit",
      "accounts": [
        { "name": "validator", "isMut": false, "isSigner": true },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "validatorReg", "isMut": true, "isSigner": false },
        { "name": "committeeRound", "isMut": true, "isSigner": false }
      ],
      "args": [{ "name": "secretHash", "type": { "array": ["u8", 32] } }]
    },
    {
      "name": "reveal",
      "accounts": [
        { "name": "validator", "isMut": false, "isSigner": true },
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "validatorReg", "isMut": false, "isSigner": false },
        { "name": "committeeRound", "isMut": true, "isSigner": false }
      ],
      "args": [
        { "name": "secret", "type": { "array": ["u8", 32] } },
        { "name": "nonce", "type": { "array": ["u8", 32] } }
      ]
    }
  ],
  "accounts": [
    {
      "name": "ProtocolConfig",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "authority", "type": "publicKey" },
          { "name": "treasury", "type": "publicKey" },
          { "name": "reserve", "type": "publicKey" },
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
    }
  ]
};

const PROGRAM_ID = "BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr";

// Constants
const COMMIT_PHASE_SLOTS = 25;  // slots 0-24
const REVEAL_PHASE_SLOTS = 25;  // slots 25-49
const POLL_INTERVAL_MS = 1000;   // Check every second

// Logger setup
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    winston.format.printf(({ level, message, timestamp, ...metadata }) => {
      let msg = `${timestamp} [${level}]: ${message}`;
      if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
      }
      return msg;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "validator-daemon.log" }),
  ],
});

// Types
interface RoundSecrets {
  round: number;
  secret: Buffer;
  nonce: Buffer;
  commitment: Buffer;
  committed: boolean;
  revealed: boolean;
  txSignatureCommit?: string;
  txSignatureReveal?: string;
}

interface ValidatorState {
  currentRound: number;
  currentRoundStartSlot: number;
  roundDurationSlots: number;
  commitPhaseSlots: number;
  revealPhaseSlots: number;
  isInCommittee: boolean;
}

// PDA helpers
function findProtocolConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol-config")],
    new PublicKey(PROGRAM_ID)
  );
}

function findCommitteeRoundPda(round: number): [PublicKey, number] {
  const roundBuf = Buffer.alloc(8);
  roundBuf.writeBigUInt64LE(BigInt(round));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("committee-round"), roundBuf],
    new PublicKey(PROGRAM_ID)
  );
}

function findValidatorPda(validatorPubkey: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("validator"), validatorPubkey.toBuffer()],
    new PublicKey(PROGRAM_ID)
  );
}

function computeCommitment(secret: Buffer, nonce: Buffer, validatorPubkey: PublicKey): Buffer {
  return crypto.createHash("sha256")
    .update(Buffer.concat([secret, nonce, validatorPubkey.toBuffer()]))
    .digest();
}

// Validator Daemon Class
class ValidatorDaemon {
  private connection: Connection;
  private keypair: Keypair;
  private program: Program;
  private provider: AnchorProvider;
  
  private secrets: Map<number, RoundSecrets> = new Map();
  private processedRounds: Set<number> = new Set();
  private validatorState: ValidatorState = {
    currentRound: 0,
    currentRoundStartSlot: 0,
    roundDurationSlots: 75,
    commitPhaseSlots: 25,
    revealPhaseSlots: 25,
    isInCommittee: false,
  };

  private running = false;
  private lastSlot = 0;

  constructor(connection: Connection, keypair: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
    
    const wallet = new Wallet(keypair);
    this.provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed" as Commitment,
    });
    
    this.program = new Program(IDL as any, new PublicKey(PROGRAM_ID), this.provider);
  }

  async start(): Promise<void> {
    logger.info("Starting Validator Daemon", {
      validator: this.keypair.publicKey.toBase58(),
      rpc: this.connection.rpcEndpoint,
    });

    this.running = true;
    
    // Initial sync
    await this.syncState();
    
    // Main loop
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        logger.error("Error in main tick:", { error: (error as Error).message });
      }
      await this.sleep(POLL_INTERVAL_MS);
    }
  }

  stop(): void {
    logger.info("Stopping Validator Daemon");
    this.running = false;
  }

  private async tick(): Promise<void> {
    const currentSlot = await this.connection.getSlot("confirmed");
    
    if (currentSlot !== this.lastSlot) {
      this.lastSlot = currentSlot;
      await this.syncState();
      
      const slotInRound = currentSlot - this.validatorState.currentRoundStartSlot;
      const round = this.validatorState.currentRound;
      
      // Check if we need to handle a new round
      if (!this.processedRounds.has(round)) {
        await this.handleNewRound(round);
      }
      
      // Check commit phase (slots 0-24)
      if (slotInRound >= 0 && slotInRound < this.validatorState.commitPhaseSlots) {
        await this.handleCommitPhase(round, currentSlot, slotInRound);
      }
      
      // Check reveal phase (slots 25-49)
      if (slotInRound >= this.validatorState.commitPhaseSlots && 
          slotInRound < this.validatorState.commitPhaseSlots + this.validatorState.revealPhaseSlots) {
        await this.handleRevealPhase(round, currentSlot, slotInRound);
      }
      
      // Clean up old secrets
      this.cleanupOldSecrets(round);
    }
  }

  private async syncState(): Promise<void> {
    try {
      const [configPda] = findProtocolConfigPda();
      const config: any = await this.program.account.protocolConfig.fetch(configPda);
      
      this.validatorState.currentRound = (config.currentRound as BN).toNumber();
      this.validatorState.currentRoundStartSlot = (config.currentRoundStartSlot as BN).toNumber();
      this.validatorState.roundDurationSlots = (config.roundDurationSlots as BN).toNumber();
      this.validatorState.commitPhaseSlots = (config.commitPhaseSlots as BN).toNumber();
      this.validatorState.revealPhaseSlots = (config.revealPhaseSlots as BN).toNumber();
      
      // Check if validator is in committee
      const [validatorPda] = findValidatorPda(this.keypair.publicKey);
      try {
        const validatorReg: any = await this.program.account.validatorRegistration.fetch(validatorPda);
        this.validatorState.isInCommittee = validatorReg.inCommittee as boolean;
      } catch {
        this.validatorState.isInCommittee = false;
      }
    } catch (error) {
      logger.warn("Failed to sync state:", { error: (error as Error).message });
    }
  }

  private async handleNewRound(round: number): Promise<void> {
    logger.info("New round detected", { round, validator: this.keypair.publicKey.toBase58() });
    
    if (!this.validatorState.isInCommittee) {
      logger.info("Validator not in committee, skipping", { round });
      this.processedRounds.add(round);
      return;
    }
    
    // Generate secrets for this round
    const secret = crypto.randomBytes(32);
    const nonce = crypto.randomBytes(32);
    const commitment = computeCommitment(secret, nonce, this.keypair.publicKey);
    
    const roundSecrets: RoundSecrets = {
      round,
      secret,
      nonce,
      commitment,
      committed: false,
      revealed: false,
    };
    
    this.secrets.set(round, roundSecrets);
    this.processedRounds.add(round);
    
    logger.info("Generated secrets for round", {
      round,
      commitment: commitment.toString("hex").slice(0, 16) + "...",
    });
  }

  private async handleCommitPhase(round: number, currentSlot: number, slotInRound: number): Promise<void> {
    const roundSecrets = this.secrets.get(round);
    if (!roundSecrets || roundSecrets.committed) return;
    
    if (!this.validatorState.isInCommittee) {
      logger.warn("Validator not in committee, cannot commit", { round });
      return;
    }
    
    try {
      const [configPda] = findProtocolConfigPda();
      const [roundPda] = findCommitteeRoundPda(round);
      const [validatorPda] = findValidatorPda(this.keypair.publicKey);
      
      const tx = await this.program.methods
        .commit(Array.from(roundSecrets.commitment))
        .accounts({
          validator: this.keypair.publicKey,
          protocolConfig: configPda,
          validatorReg: validatorPda,
          committeeRound: roundPda,
        })
        .rpc();
      
      roundSecrets.committed = true;
      roundSecrets.txSignatureCommit = tx;
      
      logger.info("Commit submitted", {
        round,
        slot: currentSlot,
        slotInRound,
        tx: tx,
      });
    } catch (error) {
      // Check if already committed
      const errorMsg = (error as Error).message;
      if (errorMsg.includes("AlreadyCommitted") || errorMsg.includes("0x6003")) {
        logger.info("Already committed this round", { round });
        roundSecrets.committed = true;
      } else if (errorMsg.includes("NotInCommittee") || errorMsg.includes("0x6005")) {
        logger.warn("Not in committee for this round", { round });
        this.validatorState.isInCommittee = false;
      } else {
        logger.error("Commit failed:", { round, error: errorMsg });
      }
    }
  }

  private async handleRevealPhase(round: number, currentSlot: number, slotInRound: number): Promise<void> {
    const roundSecrets = this.secrets.get(round);
    if (!roundSecrets || !roundSecrets.committed || roundSecrets.revealed) return;
    
    try {
      const [configPda] = findProtocolConfigPda();
      const [roundPda] = findCommitteeRoundPda(round);
      const [validatorPda] = findValidatorPda(this.keypair.publicKey);
      
      const tx = await this.program.methods
        .reveal(Array.from(roundSecrets.secret), Array.from(roundSecrets.nonce))
        .accounts({
          validator: this.keypair.publicKey,
          protocolConfig: configPda,
          validatorReg: validatorPda,
          committeeRound: roundPda,
        })
        .rpc();
      
      roundSecrets.revealed = true;
      roundSecrets.txSignatureReveal = tx;
      
      logger.info("Reveal submitted", {
        round,
        slot: currentSlot,
        slotInRound,
        tx: tx,
      });
    } catch (error) {
      // Check if already revealed
      const errorMsg = (error as Error).message;
      if (errorMsg.includes("AlreadyRevealed") || errorMsg.includes("0x6004")) {
        logger.info("Already revealed this round", { round });
        roundSecrets.revealed = true;
      } else if (errorMsg.includes("CommitmentMismatch") || errorMsg.includes("0x6001")) {
        logger.error("Commitment mismatch - secrets may be corrupted", { round });
      } else {
        logger.error("Reveal failed:", { round, error: errorMsg });
      }
    }
  }

  private cleanupOldSecrets(currentRound: number): void {
    // Keep last 10 rounds of secrets for recovery
    const minRound = currentRound - 10;
    for (const [round, _] of this.secrets) {
      if (round < minRound) {
        this.secrets.delete(round);
        this.processedRounds.delete(round);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main
async function main() {
  const keypairPath = process.env.VALIDATOR_KEYPAIR_PATH;
  const rpcUrl = process.env.RPC_URL || "https://rpc.mainnet.x1.xyz";
  
  if (!keypairPath) {
    logger.error("VALIDATOR_KEYPAIR_PATH environment variable required");
    process.exit(1);
  }
  
  // Load keypair
  let keypair: Keypair;
  try {
    const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    keypair = Keypair.fromSecretKey(new Uint8Array(keypairData));
  } catch (error) {
    logger.error("Failed to load keypair:", { error: (error as Error).message });
    process.exit(1);
  }
  
  logger.info("Validator keypair loaded", {
    publicKey: keypair.publicKey.toBase58(),
  });
  
  // Setup connection
  const connection = new Connection(rpcUrl, "confirmed");
  
  // Test connection
  try {
    const version = await connection.getVersion();
    logger.info("Connected to RPC", { version, rpcUrl });
  } catch (error) {
    logger.error("Failed to connect to RPC:", { error: (error as Error).message, rpcUrl });
    process.exit(1);
  }
  
  // Create and start daemon
  const daemon = new ValidatorDaemon(connection, keypair);
  
  // Handle graceful shutdown
  process.on("SIGINT", () => daemon.stop());
  process.on("SIGTERM", () => daemon.stop());
  
  await daemon.start();
}

main().catch((error) => {
  logger.error("Fatal error:", { error: (error as Error).message });
  process.exit(1);
});
