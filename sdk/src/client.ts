// @ts-nocheck
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import { PROGRAM_ID, REQUEST_FEE_LAMPORTS, SLOT_DURATION_MS } from "./constants";
import {
  findProtocolConfigPda,
  findCommitteeRoundPda,
  findFeeEscrowPda,
  findRequestPda,
  findValidatorPda,
  findEntropyPoolPda,
  findDappPda,
  computeRequestId,
} from "./pdas";

// IDL — hand-crafted to match program v3
// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL: Idl = require("../../target/idl/randomness_wrapper.json");

export interface RequestRandomnessParams {
  seed: Buffer; // 32 bytes
  callbackProgram: PublicKey;
  callbackInstruction: Buffer; // 8 bytes discriminator
}

export interface RequestState {
  requestId: Buffer;
  requester: PublicKey;
  seed: Buffer;
  callbackProgram: PublicKey;
  callbackInstruction: Buffer;
  round: BN;
  fulfilled: boolean;
  output: Buffer;
  feePaid: BN;
  createdSlot: BN;
}

export interface CommitteeRound {
  round: BN;
  startSlot: BN;
  entropyOutput: Buffer;
  entropySet: boolean;
  committee: PublicKey[];
  commitments: Buffer[];
  committed: boolean[];
  reveals: Buffer[];
  revealed: boolean[];
  commitCount: number;
  revealCount: number;
  aggregated: boolean;
  aggregatedSlot: BN;
  pendingRequests: number;
  requests: Buffer[];
  totalFees: BN;
}

export interface ValidatorRegistration {
  validator: PublicKey;
  bond: BN;
  roundsParticipated: BN;
  roundsMissed: BN;
  inCommittee: boolean;
}

export interface EntropyPoolState {
  currentEntropy: Buffer;
  currentRound: BN;
  entropyAvailable: boolean;
  lastAggregatedSlot: BN;
  totalRequestsServed: BN;
}

export interface DappRegistrationState {
  dappId: PublicKey;
  callbackProgram: PublicKey;
  callbackInstruction: Buffer;
  minRoundInterval: BN;
  lastServedRound: BN;
  totalRequests: BN;
  authority: PublicKey;
}

export interface RoundTiming {
  currentSlot: BN;
  roundStartSlot: BN;
  commitDeadlineSlot: BN;
  revealDeadlineSlot: BN;
  roundEndSlot: BN;
  commitDeadlineMs: number;
  revealDeadlineMs: number;
  aggregateEstimateMs: number;
  roundEndMs: number;
  inCommitPhase: boolean;
  inRevealPhase: boolean;
  inBufferPhase: boolean;
}

export class RandomnessClient {
  public program: Program;
  public provider: AnchorProvider;
  public connection: Connection;

  constructor(provider: AnchorProvider) {
    this.provider = provider;
    this.connection = provider.connection;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.program = new Program(IDL as any, new PublicKey(PROGRAM_ID), provider) as any;
  }

  /** Initialize the protocol (admin only, run once) — creates ProtocolConfig + EntropyPool */
  async initialize(treasury: PublicKey, reserve: PublicKey): Promise<string> {
    const [configPda] = findProtocolConfigPda();
    const [poolPda] = findEntropyPoolPda();
    return this.program.methods
      .initialize()
      .accounts({
        protocolConfig: configPda,
        entropyPool: poolPda,
        treasury,
        reserve,
        authority: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Register a dApp with callback and round interval */
  async registerDapp(
    dappId: PublicKey,
    callbackProgram: PublicKey,
    callbackInstruction: Buffer,
    minRoundInterval: BN
  ): Promise<string> {
    const [dappPda] = findDappPda(dappId);
    const [configPda] = findProtocolConfigPda();
    return this.program.methods
      .registerDapp(callbackProgram, Array.from(callbackInstruction), minRoundInterval)
      .accounts({
        dappRegistration: dappPda,
        dapp_id: dappId,
        authority: this.provider.wallet.publicKey,
        protocolConfig: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Unregister a dApp and reclaim rent */
  async unregisterDapp(dappId: PublicKey): Promise<string> {
    const [dappPda] = findDappPda(dappId);
    return this.program.methods
      .unregisterDapp()
      .accounts({
        dappRegistration: dappPda,
        authority: this.provider.wallet.publicKey,
      })
      .rpc();
  }

  /** Request randomness from the protocol (fast path or queue path) */
  async requestRandomness(params: RequestRandomnessParams): Promise<{
    signature: string;
    requestPda: PublicKey;
  }> {
    const [configPda] = findProtocolConfigPda();
    const config = await this.program.account.protocolConfig.fetch(configPda);
    const currentRound = config.currentRound.toNumber();

    const [requestPda] = findRequestPda(
      this.provider.wallet.publicKey,
      params.seed
    );

    const [roundPda] = findCommitteeRoundPda(currentRound);
    const [escrowPda] = findFeeEscrowPda(currentRound);
    const [poolPda] = findEntropyPoolPda();

    const signature = await this.program.methods
      .requestRandomness(
        Array.from(params.seed),
        params.callbackProgram,
        Array.from(params.callbackInstruction),
      )
      .accounts({
        requestState: requestPda,
        requester: this.provider.wallet.publicKey,
        protocolConfig: configPda,
        entropyPool: poolPda,
        feeEscrow: escrowPda,
        committeeRound: roundPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { signature, requestPda };
  }

  /** Request randomness — tries fast path first, transparently handles queue */
  async requestRandomnessFast(seed: Buffer): Promise<{
    signature: string;
    requestPda: PublicKey;
  }> {
    // Use the program's callback_program/callback_instruction defaults for simple usage
    const defaultCallbackProgram = this.program.programId;
    const defaultCallbackInstruction = Buffer.alloc(8, 0);
    return this.requestRandomness({
      seed,
      callbackProgram: defaultCallbackProgram,
      callbackInstruction: defaultCallbackInstruction,
    });
  }

  /** Get the current entropy pool state */
  async getEntropyPool(): Promise<EntropyPoolState> {
    const [poolPda] = findEntropyPoolPda();
    const account = await this.program.account.entropyPool.fetch(poolPda);
    return {
      currentEntropy: Buffer.from(account.currentEntropy),
      currentRound: account.currentRound,
      entropyAvailable: account.entropyAvailable,
      lastAggregatedSlot: account.lastAggregatedSlot,
      totalRequestsServed: account.totalRequestsServed,
    };
  }

  /** Get a dApp registration state */
  async getDappRegistration(dappId: PublicKey): Promise<DappRegistrationState> {
    const [dappPda] = findDappPda(dappId);
    const account = await this.program.account.dappRegistration.fetch(dappPda);
    return {
      dappId: account.dappId,
      callbackProgram: account.callbackProgram,
      callbackInstruction: Buffer.from(account.callbackInstruction),
      minRoundInterval: account.minRoundInterval,
      lastServedRound: account.lastServedRound,
      totalRequests: account.totalRequests,
      authority: account.authority,
    };
  }

  /** Get a request's state */
  async getRequest(requestPda: PublicKey): Promise<RequestState> {
    const account = await this.program.account.requestState.fetch(requestPda);
    return {
      requestId: Buffer.from(account.requestId),
      requester: account.requester,
      seed: Buffer.from(account.seed),
      callbackProgram: account.callbackProgram,
      callbackInstruction: Buffer.from(account.callbackInstruction),
      round: account.round,
      fulfilled: account.fulfilled,
      output: Buffer.from(account.output),
      feePaid: account.feePaid,
      createdSlot: account.createdSlot,
    };
  }

  /** Get current round status */
  async getRoundStatus(round?: number): Promise<CommitteeRound> {
    if (round === undefined) {
      const [configPda] = findProtocolConfigPda();
      const config = await this.program.account.protocolConfig.fetch(configPda);
      round = config.currentRound.toNumber();
    }

    const [roundPda] = findCommitteeRoundPda(round);
    const account = await this.program.account.committeeRound.fetch(roundPda);
    return {
      round: account.round,
      startSlot: account.startSlot,
      entropyOutput: Buffer.from(account.entropyOutput),
      entropySet: account.entropySet,
      committee: account.committee,
      commitments: account.commitments.map((c: number[]) => Buffer.from(c)),
      committed: account.committed,
      reveals: account.reveals.map((r: number[]) => Buffer.from(r)),
      revealed: account.revealed,
      commitCount: account.commitCount,
      revealCount: account.revealCount,
      aggregated: account.aggregated,
      aggregatedSlot: account.aggregatedSlot,
      pendingRequests: account.pendingRequests,
      requests: account.requests.map((r: number[]) => Buffer.from(r)),
      totalFees: account.totalFees,
    };
  }

  /** Get round timing info in human-readable format */
  async getRoundTiming(): Promise<RoundTiming> {
    const [configPda] = findProtocolConfigPda();
    const config = await this.program.account.protocolConfig.fetch(configPda);
    const currentSlot = await this.connection.getSlot();
    const roundStartSlot = config.currentRoundStartSlot.toNumber();
    const commitPhaseSlots = config.commitPhaseSlots.toNumber();
    const revealPhaseSlots = config.revealPhaseSlots.toNumber();
    const roundDurationSlots = config.roundDurationSlots.toNumber();

    const commitDeadlineSlot = roundStartSlot + commitPhaseSlots;
    const revealDeadlineSlot = roundStartSlot + commitPhaseSlots + revealPhaseSlots;
    const roundEndSlot = roundStartSlot + roundDurationSlots;

    const slotsElapsed = currentSlot - roundStartSlot;
    const msElapsed = slotsElapsed * SLOT_DURATION_MS;

    const commitDeadlineMs = commitPhaseSlots * SLOT_DURATION_MS - msElapsed;
    const revealDeadlineMs = (commitPhaseSlots + revealPhaseSlots) * SLOT_DURATION_MS - msElapsed;
    const roundEndMs = roundDurationSlots * SLOT_DURATION_MS - msElapsed;
    // Aggregation typically happens right after reveal phase ends
    const aggregateEstimateMs = revealDeadlineMs + 2000; // ~2 sec buffer

    return {
      currentSlot: new BN(currentSlot),
      roundStartSlot: config.currentRoundStartSlot,
      commitDeadlineSlot: new BN(commitDeadlineSlot),
      revealDeadlineSlot: new BN(revealDeadlineSlot),
      roundEndSlot: new BN(roundEndSlot),
      commitDeadlineMs: Math.max(0, commitDeadlineMs),
      revealDeadlineMs: Math.max(0, revealDeadlineMs),
      aggregateEstimateMs: Math.max(0, aggregateEstimateMs),
      roundEndMs: Math.max(0, roundEndMs),
      inCommitPhase: currentSlot >= roundStartSlot && currentSlot < commitDeadlineSlot,
      inRevealPhase: currentSlot >= commitDeadlineSlot && currentSlot < revealDeadlineSlot,
      inBufferPhase: currentSlot >= revealDeadlineSlot && currentSlot < roundEndSlot,
    };
  }

  /** Crank round advancement */
  async advanceRound(): Promise<string> {
    const [configPda] = findProtocolConfigPda();
    const [poolPda] = findEntropyPoolPda();
    const config = await this.program.account.protocolConfig.fetch(configPda);
    const nextRound = config.currentRound.toNumber() + 1;
    const [nextRoundPda] = findCommitteeRoundPda(nextRound);

    return this.program.methods
      .advanceRound()
      .accounts({
        protocolConfig: configPda,
        entropyPool: poolPda,
        newCommitteeRound: nextRoundPda,
        caller: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Register as a validator with a bond */
  async registerValidator(bondAmount: BN): Promise<string> {
    const [validatorPda] = findValidatorPda(this.provider.wallet.publicKey);
    const [configPda] = findProtocolConfigPda();

    return this.program.methods
      .registerValidator(bondAmount)
      .accounts({
        validatorReg: validatorPda,
        validator: this.provider.wallet.publicKey,
        protocolConfig: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Submit a commitment for the current round */
  async commit(secretHash: Buffer): Promise<string> {
    const [configPda] = findProtocolConfigPda();
    const config = await this.program.account.protocolConfig.fetch(configPda);
    const currentRound = config.currentRound.toNumber();
    const [roundPda] = findCommitteeRoundPda(currentRound);
    const [validatorPda] = findValidatorPda(this.provider.wallet.publicKey);

    return this.program.methods
      .commit(Array.from(secretHash))
      .accounts({
        validator: this.provider.wallet.publicKey,
        protocolConfig: configPda,
        validatorReg: validatorPda,
        committeeRound: roundPda,
      })
      .rpc();
  }

  /** Reveal a secret for the current round */
  async reveal(secret: Buffer, nonce: Buffer): Promise<string> {
    const [configPda] = findProtocolConfigPda();
    const config = await this.program.account.protocolConfig.fetch(configPda);
    const currentRound = config.currentRound.toNumber();
    const [roundPda] = findCommitteeRoundPda(currentRound);
    const [validatorPda] = findValidatorPda(this.provider.wallet.publicKey);

    return this.program.methods
      .reveal(Array.from(secret), Array.from(nonce))
      .accounts({
        validator: this.provider.wallet.publicKey,
        protocolConfig: configPda,
        validatorReg: validatorPda,
        committeeRound: roundPda,
      })
      .rpc();
  }

  /** Trigger aggregation and callbacks for a completed round */
  async aggregateAndCallback(round: number): Promise<string> {
    const [configPda] = findProtocolConfigPda();
    const [roundPda] = findCommitteeRoundPda(round);
    const [escrowPda] = findFeeEscrowPda(round);
    const [poolPda] = findEntropyPoolPda();

    return this.program.methods
      .aggregateAndCallback()
      .accounts({
        protocolConfig: configPda,
        committeeRound: roundPda,
        entropyPool: poolPda,
        feeEscrow: escrowPda,
        caller: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Distribute fees for a completed round */
  async distributeFees(round: number): Promise<string> {
    const [configPda] = findProtocolConfigPda();
    const config = await this.program.account.protocolConfig.fetch(configPda);
    const [roundPda] = findCommitteeRoundPda(round);
    const [escrowPda] = findFeeEscrowPda(round);

    return this.program.methods
      .distributeFees()
      .accounts({
        protocolConfig: configPda,
        round: roundPda,
        feeEscrow: escrowPda,
        treasury: config.treasury,
        reserve: config.reserve,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Compute the expected randomness output for a request */
  static computeOutput(aggregatedEntropy: Buffer, requestId: Buffer): Buffer {
    const crypto = require("crypto");
    return crypto.createHash("sha256")
      .update(Buffer.concat([aggregatedEntropy, requestId]))
      .digest();
  }

  /** Compute a commitment hash: SHA256(secret || nonce || validatorPubkey) */
  static computeCommitment(secret: Buffer, nonce: Buffer, validatorPubkey: PublicKey): Buffer {
    const crypto = require("crypto");
    return crypto.createHash("sha256")
      .update(Buffer.concat([secret, nonce, validatorPubkey.toBuffer()]))
      .digest();
  }

  /** Close a fulfilled request and reclaim rent */
  async closeRequest(requestPda: PublicKey): Promise<string> {
    return this.program.methods
      .closeRequest()
      .accounts({
        requestState: requestPda,
        requester: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }
}