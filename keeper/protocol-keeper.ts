/**
 * X1 Randomness Protocol - Protocol Keeper Bot
 * 
 * A cron-like service that advances the protocol by:
 * - Monitoring round expiration and calling advance_round
 * - Triggering fee distribution after round aggregation
 * - Tracking entropy pool state
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Commitment,
} from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, BN } from "@coral-xyz/anchor";
import * as fs from "fs";
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
      "name": "advanceRound",
      "accounts": [
        { "name": "protocolConfig", "isMut": true, "isSigner": false },
        { "name": "entropyPool", "isMut": true, "isSigner": false },
        { "name": "newCommitteeRound", "isMut": true, "isSigner": false },
        { "name": "caller", "isMut": true, "isSigner": true },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "aggregateAndCallback",
      "accounts": [
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "committeeRound", "isMut": true, "isSigner": false },
        { "name": "entropyPool", "isMut": true, "isSigner": false },
        { "name": "feeEscrow", "isMut": true, "isSigner": false },
        { "name": "caller", "isMut": false, "isSigner": true },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": []
    },
    {
      "name": "distributeFees",
      "accounts": [
        { "name": "protocolConfig", "isMut": false, "isSigner": false },
        { "name": "round", "isMut": false, "isSigner": false },
        { "name": "feeEscrow", "isMut": true, "isSigner": false },
        { "name": "treasury", "isMut": true, "isSigner": false },
        { "name": "reserve", "isMut": true, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
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

const PROGRAM_ID = "BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr";

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
    new winston.transports.File({ filename: "protocol-keeper.log" }),
  ],
});

// PDA helpers
function findProtocolConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("protocol-config")],
    new PublicKey(PROGRAM_ID)
  );
}

function findEntropyPoolPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("entropy-pool")],
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

function findFeeEscrowPda(round: number): [PublicKey, number] {
  const roundBuf = Buffer.alloc(8);
  roundBuf.writeBigUInt64LE(BigInt(round));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("fee-escrow"), roundBuf],
    new PublicKey(PROGRAM_ID)
  );
}

// Types
interface ProtocolState {
  currentRound: number;
  currentRoundStartSlot: number;
  roundDurationSlots: number;
  totalRounds: number;
  authority: PublicKey;
  treasury: PublicKey;
  reserve: PublicKey;
}

interface EntropyPoolState {
  currentRound: number;
  entropyAvailable: boolean;
  lastAggregatedSlot: number;
  totalRequestsServed: number;
}

interface RoundState {
  round: number;
  startSlot: number;
  commitCount: number;
  revealCount: number;
  aggregated: boolean;
  revealThreshold: number;
  totalFees: number;
}

// Protocol Keeper Class
class ProtocolKeeper {
  private connection: Connection;
  private keypair: Keypair;
  private program: Program;
  private provider: AnchorProvider;
  
  private protocolState: ProtocolState = {
    currentRound: 0,
    currentRoundStartSlot: 0,
    roundDurationSlots: 75,
    totalRounds: 0,
    authority: PublicKey.default,
    treasury: PublicKey.default,
    reserve: PublicKey.default,
  };
  
  private entropyPool: EntropyPoolState = {
    currentRound: 0,
    entropyAvailable: false,
    lastAggregatedSlot: 0,
    totalRequestsServed: 0,
  };
  
  private processedRounds: Set<number> = new Set();
  private aggregatedRounds: Set<number> = new Set();
  private feesDistributedRounds: Set<number> = new Set();
  
  private running = false;
  private checkIntervalMs: number;

  constructor(connection: Connection, keypair: Keypair, checkIntervalMs: number) {
    this.connection = connection;
    this.keypair = keypair;
    this.checkIntervalMs = checkIntervalMs;
    
    const wallet = new Wallet(keypair);
    this.provider = new AnchorProvider(connection, wallet, {
      commitment: "confirmed" as Commitment,
    });
    
    this.program = new Program(IDL as any, new PublicKey(PROGRAM_ID), this.provider);
  }

  async start(): Promise<void> {
    logger.info("Starting Protocol Keeper", {
      keeper: this.keypair.publicKey.toBase58(),
      rpc: this.connection.rpcEndpoint,
      checkInterval: this.checkIntervalMs,
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
      await this.sleep(this.checkIntervalMs);
    }
  }

  stop(): void {
    logger.info("Stopping Protocol Keeper");
    this.running = false;
  }

  private async tick(): Promise<void> {
    const currentSlot = await this.connection.getSlot("confirmed");
    
    // Sync state periodically
    await this.syncState();
    
    const { currentRound, currentRoundStartSlot, roundDurationSlots } = this.protocolState;
    const roundEndSlot = currentRoundStartSlot + roundDurationSlots;
    
    // Log current state
    logger.debug("Keeper tick", {
      currentSlot,
      currentRound,
      currentRoundStartSlot,
      roundEndSlot,
      slotsRemaining: roundEndSlot - currentSlot,
      entropyAvailable: this.entropyPool.entropyAvailable,
    });
    
    // Check if current round has expired - advance if so
    if (currentSlot >= roundEndSlot) {
      await this.advanceRound();
      return; // Re-sync after advancing
    }
    
    // Check if we can aggregate the current round
    await this.checkAndAggregate(currentRound, currentSlot);
    
    // Check for fee distribution on completed rounds
    await this.checkFeeDistribution();
    
    // Log entropy pool status changes
    this.logEntropyPoolStatus();
  }

  private async syncState(): Promise<void> {
    try {
      const [configPda] = findProtocolConfigPda();
      const config: any = await this.program.account.protocolConfig.fetch(configPda);
      
      this.protocolState = {
        currentRound: (config.currentRound as BN).toNumber(),
        currentRoundStartSlot: (config.currentRoundStartSlot as BN).toNumber(),
        roundDurationSlots: (config.roundDurationSlots as BN).toNumber(),
        totalRounds: (config.totalRounds as BN).toNumber(),
        authority: config.authority as PublicKey,
        treasury: config.treasury as PublicKey,
        reserve: config.reserve as PublicKey,
      };
      
      const [poolPda] = findEntropyPoolPda();
      const pool: any = await this.program.account.entropyPool.fetch(poolPda);
      
      this.entropyPool = {
        currentRound: (pool.currentRound as BN).toNumber(),
        entropyAvailable: pool.entropyAvailable as boolean,
        lastAggregatedSlot: (pool.lastAggregatedSlot as BN).toNumber(),
        totalRequestsServed: (pool.totalRequestsServed as BN).toNumber(),
      };
    } catch (error) {
      logger.warn("Failed to sync state:", { error: (error as Error).message });
    }
  }

  private async advanceRound(): Promise<void> {
    const { currentRound } = this.protocolState;
    const nextRound = currentRound + 1;
    
    logger.info("Attempting to advance round", {
      fromRound: currentRound,
      toRound: nextRound,
    });
    
    try {
      const [configPda] = findProtocolConfigPda();
      const [poolPda] = findEntropyPoolPda();
      const [nextRoundPda] = findCommitteeRoundPda(nextRound);
      
      const tx = await this.program.methods
        .advanceRound()
        .accounts({
          protocolConfig: configPda,
          entropyPool: poolPda,
          newCommitteeRound: nextRoundPda,
          caller: this.keypair.publicKey,
          systemProgram: PublicKey.default,
        })
        .rpc();
      
      logger.info("Round advanced", {
        fromRound: currentRound,
        toRound: nextRound,
        tx,
      });
      
      // Add to processed rounds
      this.processedRounds.add(currentRound);
      
      // Re-sync to get new state
      await this.syncState();
    } catch (error) {
      const errorMsg = (error as Error).message;
      if (errorMsg.includes("RoundNotExpired") || errorMsg.includes("0x6017")) {
        logger.debug("Round not yet expired, skipping advance");
      } else {
        logger.error("Failed to advance round:", { error: errorMsg });
      }
    }
  }

  private async checkAndAggregate(round: number, currentSlot: number): Promise<void> {
    if (this.aggregatedRounds.has(round)) return;
    
    try {
      const [roundPda] = findCommitteeRoundPda(round);
      const roundAccount: any = await this.program.account.committeeRound.fetch(roundPda);
      
      const roundState: RoundState = {
        round: (roundAccount.round as BN).toNumber(),
        startSlot: (roundAccount.startSlot as BN).toNumber(),
        commitCount: roundAccount.commitCount as number,
        revealCount: roundAccount.revealCount as number,
        aggregated: roundAccount.aggregated as boolean,
        revealThreshold: this.protocolState.roundDurationSlots > 0 ? 14 : 0, // Default threshold
        totalFees: (roundAccount.totalFees as BN).toNumber(),
      };
      
      // Skip if already aggregated
      if (roundState.aggregated) {
        logger.info("Round already aggregated", { round });
        this.aggregatedRounds.add(round);
        return;
      }
      
      // Check if we have enough reveals to aggregate
      const revealPhaseEnd = roundState.startSlot + 25 + 25; // commit + reveal phase
      
      if (currentSlot >= revealPhaseEnd && roundState.revealCount >= 14) {
        await this.aggregateRound(round);
      } else if (currentSlot >= revealPhaseEnd) {
        logger.warn("Reveal phase ended but threshold not met", {
          round,
          reveals: roundState.revealCount,
          threshold: 14,
        });
      }
    } catch (error) {
      // Round account may not exist yet
      if ((error as Error).message.includes("could not find account")) {
        logger.debug("Round account not yet created", { round });
      } else {
        logger.error("Failed to check round for aggregation:", { round, error: (error as Error).message });
      }
    }
  }

  private async aggregateRound(round: number): Promise<void> {
    logger.info("Aggregating round", { round });
    
    try {
      const [configPda] = findProtocolConfigPda();
      const [roundPda] = findCommitteeRoundPda(round);
      const [escrowPda] = findFeeEscrowPda(round);
      const [poolPda] = findEntropyPoolPda();
      
      const tx = await this.program.methods
        .aggregateAndCallback()
        .accounts({
          protocolConfig: configPda,
          committeeRound: roundPda,
          entropyPool: poolPda,
          feeEscrow: escrowPda,
          caller: this.keypair.publicKey,
          systemProgram: PublicKey.default,
        })
        .rpc();
      
      this.aggregatedRounds.add(round);
      
      logger.info("Round aggregated", { round, tx });
      
      // Re-sync to update entropy pool
      await this.syncState();
      
      // Log entropy refresh
      if (this.entropyPool.entropyAvailable) {
        logger.info("Entropy pool refreshed", {
          round: this.entropyPool.currentRound,
          totalRequestsServed: this.entropyPool.totalRequestsServed,
        });
      }
    } catch (error) {
      const errorMsg = (error as Error).message;
      if (errorMsg.includes("RoundAlreadyAggregated") || errorMsg.includes("0x6007")) {
        logger.info("Round already aggregated (concurrent)", { round });
        this.aggregatedRounds.add(round);
      } else if (errorMsg.includes("RoundNotAggregatable") || errorMsg.includes("0x6006")) {
        logger.warn("Round not aggregatable yet", { round });
      } else {
        logger.error("Failed to aggregate round:", { round, error: errorMsg });
      }
    }
  }

  private async checkFeeDistribution(): Promise<void> {
    // Check last few rounds for fee distribution
    const { currentRound, totalRounds } = this.protocolState;
    const startRound = Math.max(1, currentRound - 5);
    
    for (let round = startRound; round < currentRound; round++) {
      if (this.feesDistributedRounds.has(round)) continue;
      
      try {
        const [roundPda] = findCommitteeRoundPda(round);
        const roundAccount: any = await this.program.account.committeeRound.fetch(roundPda);
        
        if (roundAccount.aggregated && (roundAccount.totalFees as BN).toNumber() > 0) {
          await this.distributeFees(round);
        }
      } catch (error) {
        // Round may not exist
      }
    }
  }

  private async distributeFees(round: number): Promise<void> {
    logger.info("Distributing fees", { round });
    
    try {
      const [configPda] = findProtocolConfigPda();
      const [roundPda] = findCommitteeRoundPda(round);
      const [escrowPda] = findFeeEscrowPda(round);
      
      const tx = await this.program.methods
        .distributeFees()
        .accounts({
          protocolConfig: configPda,
          round: roundPda,
          feeEscrow: escrowPda,
          treasury: this.protocolState.treasury,
          reserve: this.protocolState.reserve,
          systemProgram: PublicKey.default,
        })
        .rpc();
      
      this.feesDistributedRounds.add(round);
      
      logger.info("Fees distributed", { round, tx });
    } catch (error) {
      const errorMsg = (error as Error).message;
      if (errorMsg.includes("FeeEscrowInsufficient") || errorMsg.includes("0x600b")) {
        logger.debug("No fees to distribute", { round });
        this.feesDistributedRounds.add(round);
      } else {
        logger.error("Failed to distribute fees:", { round, error: errorMsg });
      }
    }
  }

  private lastEntropyLogged = false;
  private logEntropyPoolStatus(): void {
    if (this.entropyPool.entropyAvailable !== this.lastEntropyLogged) {
      if (this.entropyPool.entropyAvailable) {
        logger.info("Entropy pool is now available", {
          round: this.entropyPool.currentRound,
          totalRequestsServed: this.entropyPool.totalRequestsServed,
        });
      } else {
        logger.info("Entropy pool is empty", {
          round: this.entropyPool.currentRound,
        });
      }
      this.lastEntropyLogged = this.entropyPool.entropyAvailable;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Main
async function main() {
  const keypairPath = process.env.KEEPER_KEYPAIR_PATH;
  const rpcUrl = process.env.RPC_URL || "https://rpc.mainnet.x1.xyz";
  const checkIntervalMs = parseInt(process.env.CHECK_INTERVAL_MS || "2000", 10);
  
  if (!keypairPath) {
    logger.error("KEEPER_KEYPAIR_PATH environment variable required");
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
  
  logger.info("Keeper keypair loaded", {
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
  
  // Create and start keeper
  const keeper = new ProtocolKeeper(connection, keypair, checkIntervalMs);
  
  // Handle graceful shutdown
  process.on("SIGINT", () => keeper.stop());
  process.on("SIGTERM", () => keeper.stop());
  
  await keeper.start();
}

main().catch((error) => {
  logger.error("Fatal error:", { error: (error as Error).message });
  process.exit(1);
});
