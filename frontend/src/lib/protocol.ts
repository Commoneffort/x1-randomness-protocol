import { Connection, PublicKey, Commitment } from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require("bs58") as { encode: (buf: Uint8Array | Buffer) => string };
import { RPC_URL, SLOT_DURATION_MS, ACCT_DISC } from "./constants";
import {
  findProtocolConfigPda,
  findEntropyPoolPda,
  findWrapperRoundPda,
  findFeeEscrowPda,
  findDappPda,
  findValRegPda,
} from "./pdas";

// ── Raw-deserialized account types ────────────────────────────────────────────
// Offsets match the Anchor-generated binary layout for each struct.

export interface ProtocolConfig {
  authority: string;       // Pubkey base58
  insuranceFund: string;
  currentRound: number;
  currentRoundStartSlot: number;
  eeV4RoundId: number;
  totalRounds: number;
  requestFee: number;      // lamports
  bump: number;
}

export interface EntropyPool {
  currentEntropy: string;  // hex
  currentRound: number;
  entropyAvailable: boolean;
  lastAggregatedSlot: number;
  totalRequestsServed: number;
  eeV4EntropyIncluded: boolean;
  bump: number;
}

export interface WrapperRound {
  round: number;
  eeV4RoundId: number;
  startSlot: number;
  aggregated: boolean;
  aggregatedSlot: number;
  entropyOutput: string;   // hex
  pendingRequests: number;
  totalFees: number;       // lamports
  eeV4EntropyIncluded: boolean;
  bump: number;
  pubkey: string;          // PDA base58
}

export interface FeeEscrow {
  pendingFees: number;     // lamports
  round: number;
  originalFees: number;    // lamports (set at distribute_fees time)
  eeV4RoundId: number;     // EE V4 round that services this protocol round
  feeDistributed: boolean;
  bump: number;
  pubkey: string;          // PDA base58
}

export interface DappRegistration {
  dappId: string;          // Pubkey base58
  callbackProgram: string;
  callbackInstruction: number[];
  minRoundInterval: number;
  lastServedRound: number;
  totalRequests: number;
  authority: string;
  feeOverride: number;     // 0 = use protocol default
  bump: number;
  pubkey: string;          // PDA base58
}

export interface ValidatorReveal {
  contributor: string;     // Pubkey base58
  eeRound: string;
  protocolRound: number;
  claimed: boolean;
  bump: number;
  pubkey: string;          // PDA base58
}

export interface ValidatorRegistration {
  identity: string;          // Pubkey base58
  voteAccount: string;
  stakeAccount: string;
  verifiedStake: number;     // lamports
  registeredSlot: number;
  lastActiveSlot: number;
  lastRoundParticipated: number;
  consecutiveMisses: number;
  active: boolean;
  bump: number;
  pubkey: string;            // PDA base58
}

export interface RequestState {
  requestId: string;       // hex
  requester: string;
  seed: string;            // hex
  callbackProgram: string;
  round: number;
  fulfilled: boolean;
  output: string;          // hex
  feePaid: number;
  createdSlot: number;
  bump: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readU64(data: Buffer, offset: number): number {
  return Number(data.readBigUInt64LE(offset));
}
function readBool(data: Buffer, offset: number): boolean {
  return data[offset] !== 0;
}
function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.slice(offset, offset + 32)).toBase58();
}
function readHex(data: Buffer, offset: number, len: number): string {
  return data.slice(offset, offset + len).toString("hex");
}

// ── ProtocolClient ────────────────────────────────────────────────────────────

export class ProtocolClient {
  public connection: Connection;

  constructor() {
    this.connection = new Connection(RPC_URL, "confirmed" as Commitment);
  }

  private async fetchRaw(pubkey: PublicKey): Promise<Buffer | null> {
    const info = await this.connection.getAccountInfo(pubkey, "confirmed");
    if (!info) return null;
    return Buffer.from(info.data);
  }

  async getProtocolConfig(): Promise<ProtocolConfig | null> {
    const [pda] = findProtocolConfigPda();
    const d = await this.fetchRaw(pda);
    if (!d || d.length < 113) return null;
    return {
      authority:             readPubkey(d, 8),
      insuranceFund:         readPubkey(d, 40),
      currentRound:          readU64(d, 72),
      currentRoundStartSlot: readU64(d, 80),
      eeV4RoundId:           readU64(d, 88),
      totalRounds:           readU64(d, 96),
      requestFee:            readU64(d, 104),
      bump:                  d[112],
    };
  }

  async getEntropyPool(): Promise<EntropyPool | null> {
    const [pda] = findEntropyPoolPda();
    const d = await this.fetchRaw(pda);
    if (!d || d.length < 67) return null;
    return {
      currentEntropy:       readHex(d, 8, 32),
      currentRound:         readU64(d, 40),
      entropyAvailable:     readBool(d, 48),
      lastAggregatedSlot:   readU64(d, 49),
      totalRequestsServed:  readU64(d, 57),
      eeV4EntropyIncluded:  readBool(d, 65),
      bump:                 d[66],
    };
  }

  async getWrapperRound(round: number): Promise<WrapperRound | null> {
    const [pda] = findWrapperRoundPda(round);
    const d = await this.fetchRaw(pda);
    if (!d || d.length < 87) return null;
    return {
      round:                readU64(d, 8),
      eeV4RoundId:          readU64(d, 16),
      startSlot:            readU64(d, 24),
      aggregated:           readBool(d, 32),
      aggregatedSlot:       readU64(d, 33),
      entropyOutput:        readHex(d, 41, 32),
      pendingRequests:      d.readUInt32LE(73),
      totalFees:            readU64(d, 77),
      eeV4EntropyIncluded:  readBool(d, 85),
      bump:                 d[86],
      pubkey:               pda.toBase58(),
    };
  }

  async getFeeEscrow(round: number): Promise<FeeEscrow | null> {
    const [pda] = findFeeEscrowPda(round);
    const d = await this.fetchRaw(pda);
    if (!d || d.length < 42) return null;
    return {
      pendingFees:    readU64(d, 8),
      round:          readU64(d, 16),
      originalFees:   readU64(d, 24),
      eeV4RoundId:    readU64(d, 32),
      feeDistributed: readBool(d, 40),
      bump:           d[41],
      pubkey:         pda.toBase58(),
    };
  }

  async getDappRegistration(dappId: PublicKey): Promise<DappRegistration | null> {
    const [pda] = findDappPda(dappId);
    const d = await this.fetchRaw(pda);
    if (!d || d.length < 145) return null;
    return this.parseDapp(d, pda);
  }

  private parseDapp(d: Buffer, pda: PublicKey): DappRegistration {
    return {
      dappId:              readPubkey(d, 8),
      callbackProgram:     readPubkey(d, 40),
      callbackInstruction: Array.from(d.slice(72, 80)),
      minRoundInterval:    readU64(d, 80),
      lastServedRound:     readU64(d, 88),
      totalRequests:       readU64(d, 96),
      authority:           readPubkey(d, 104),
      feeOverride:         readU64(d, 136),
      bump:                d[144],
      pubkey:              pda.toBase58(),
    };
  }

  async getAllDapps(): Promise<DappRegistration[]> {
    try {
      const disc = ACCT_DISC.DappRegistration;
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey(require("./constants").PROGRAM_ID),
        {
          commitment: "confirmed",
          filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
          dataSlice: undefined,
        }
      );
      return accounts
        .filter(a => a.account.data.length >= 145)
        .map(a => this.parseDapp(Buffer.from(a.account.data), a.pubkey));
    } catch {
      return [];
    }
  }

  async getAllWrapperRounds(limit = 15): Promise<WrapperRound[]> {
    const config = await this.getProtocolConfig();
    if (!config) return [];
    const rounds: WrapperRound[] = [];
    for (let i = 0; i < limit; i++) {
      const n = config.currentRound - i;
      if (n < 0) break;
      const wr = await this.getWrapperRound(n);
      if (wr) rounds.push(wr);
    }
    return rounds;
  }

  async getRequestState(requestPda: PublicKey): Promise<RequestState | null> {
    const d = await this.fetchRaw(requestPda);
    if (!d || d.length < 202) return null;
    return {
      requestId:           readHex(d, 8, 32),
      requester:           readPubkey(d, 40),
      seed:                readHex(d, 72, 32),
      callbackProgram:     readPubkey(d, 104),
      round:               readU64(d, 144),
      fulfilled:           readBool(d, 152),
      output:              readHex(d, 153, 32),
      feePaid:             readU64(d, 185),
      createdSlot:         readU64(d, 193),
      bump:                d[201],
    };
  }

  async getValidatorRegistration(identity: PublicKey): Promise<ValidatorRegistration | null> {
    const [pda] = findValRegPda(identity);
    const d = await this.fetchRaw(pda);
    if (!d || d.length < 139) return null;
    return this.parseValReg(d, pda);
  }

  private parseValReg(d: Buffer, pda: PublicKey): ValidatorRegistration {
    return {
      identity:               readPubkey(d, 8),
      voteAccount:            readPubkey(d, 40),
      stakeAccount:           readPubkey(d, 72),
      verifiedStake:          readU64(d, 104),
      registeredSlot:         readU64(d, 112),
      lastActiveSlot:         readU64(d, 120),
      lastRoundParticipated:  readU64(d, 128),
      consecutiveMisses:      d[136],
      active:                 readBool(d, 137),
      bump:                   d[138],
      pubkey:                 pda.toBase58(),
    };
  }

  async getAllValidatorRegistrations(): Promise<ValidatorRegistration[]> {
    try {
      const disc = ACCT_DISC.ValidatorRegistration;
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey(require("./constants").PROGRAM_ID),
        {
          commitment: "confirmed",
          filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
        }
      );
      return accounts
        .filter(a => a.account.data.length >= 139)
        .map(a => this.parseValReg(Buffer.from(a.account.data), a.pubkey));
    } catch {
      return [];
    }
  }

  async getValidatorReveals(contributor: PublicKey): Promise<ValidatorReveal[]> {
    try {
      const disc = ACCT_DISC.ValidatorReveal;
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey(require("./constants").PROGRAM_ID),
        {
          commitment: "confirmed",
          filters: [
            { memcmp: { offset: 0, bytes: bs58.encode(disc) } },
            { memcmp: { offset: 8, bytes: contributor.toBase58() } },
          ],
        }
      );
      return accounts
        .filter(a => a.account.data.length >= 82)
        .map(a => {
          const d = Buffer.from(a.account.data);
          return {
            contributor: readPubkey(d, 8),
            eeRound:     readPubkey(d, 40),
            protocolRound: readU64(d, 72),
            claimed:     readBool(d, 80),
            bump:        d[81],
            pubkey:      a.pubkey.toBase58(),
          } as ValidatorReveal;
        });
    } catch {
      return [];
    }
  }

  // ── Formatting helpers ──────────────────────────────────────────────────────

  formatXnt(lamports: number): string {
    return (lamports / 1_000_000_000).toFixed(4);
  }

  formatSlotAge(slot: number, currentSlot: number): string {
    const diff = currentSlot - slot;
    if (diff < 0) return "future";
    const secs = Math.round(diff * SLOT_DURATION_MS / 1000);
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  }

  truncateAddr(addr: string): string {
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  }

  truncateHex(hex: string): string {
    if (hex.length <= 16) return hex;
    return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
  }
}
