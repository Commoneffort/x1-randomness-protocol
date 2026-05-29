import { Connection, PublicKey, Commitment } from "@solana/web3.js";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bs58 = require("bs58") as { encode: (buf: Uint8Array | Buffer) => string };
import { RPC_URL, SLOT_DURATION_MS, ACCT_DISC } from "./constants";

// ── Rate-limit-aware fetch wrapper ────────────────────────────────────────────
// web3.js does not read Retry-After or x-ratelimit-* headers on 429s — it just
// doubles the timeout and retries. This wrapper reads those headers and waits the
// correct amount before retrying, up to MAX_RETRIES times.

const MAX_RETRIES = 4;

async function rateLimitFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  let backoffMs = 500; // only grows when server gives no Retry-After header
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 429) return res;
    if (attempt === MAX_RETRIES) return res;

    // Prefer the most specific header the server provides.
    // Only fall back to doubling backoff when the server gives us nothing.
    const resetMs  = res.headers.get("x-ratelimit-reset-ms") ?? res.headers.get("x-ratelimit-reset");
    const retrySec = res.headers.get("retry-after");
    let waitMs: number | null = null;
    if (resetMs)   { const v = Number(resetMs);   if (Number.isFinite(v) && v > 0) waitMs = v;          }
    if (!waitMs && retrySec) { const v = Number(retrySec); if (Number.isFinite(v) && v > 0) waitMs = v * 1000; }

    if (waitMs !== null) {
      await new Promise(r => setTimeout(r, waitMs));
      // Server told us exactly how long — don't grow backoff for next fallback
    } else {
      await new Promise(r => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
  }
  return fetch(input, init);
}
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
  totalGameSeeds: number;
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
  identity: string;                  // Pubkey base58
  voteAccount: string;
  stakeAccount: string;
  verifiedStake: number;             // lamports
  registeredSlot: number;
  lastActiveSlot: number;
  lastRoundParticipated: number;
  consecutiveMisses: number;
  active: boolean;
  bump: number;
  x1RandomnessAuthority?: string;    // Pubkey base58 — hot key (V4.6); equals identity until rotated
  pubkey: string;                    // PDA base58
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
    this.connection = new Connection(RPC_URL, {
      commitment: "confirmed" as Commitment,
      fetch: rateLimitFetch,
    });
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
      totalGameSeeds:       d.length >= 75 ? readU64(d, 67) : 0,
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
    return this.parseFeeEscrow(d, pda);
  }

  // Fetch multiple escrows in a single getMultipleAccountsInfo call instead of N parallel getAccountInfo calls.
  async getMultipleFeeEscrows(rounds: number[]): Promise<Record<number, FeeEscrow | null>> {
    if (!rounds.length) return {};
    try {
      const pdas = rounds.map(r => findFeeEscrowPda(r)[0]);
      const infos = await this.connection.getMultipleAccountsInfo(pdas, "confirmed");
      const result: Record<number, FeeEscrow | null> = {};
      infos.forEach((info, i) => {
        const d = info ? Buffer.from(info.data) : null;
        result[rounds[i]] = (d && d.length >= 42) ? this.parseFeeEscrow(d, pdas[i]) : null;
      });
      return result;
    } catch {
      return {};
    }
  }

  private parseFeeEscrow(d: Buffer, pda: PublicKey): FeeEscrow {
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
    try {
      const config = await this.getProtocolConfig();
      if (!config) return [];
      const roundNums: number[] = [];
      for (let i = 0; i < limit; i++) {
        const n = config.currentRound - i;
        if (n < 0) break;
        roundNums.push(n);
      }
      const pdas = roundNums.map(n => findWrapperRoundPda(n)[0]);
      const infos = await this.connection.getMultipleAccountsInfo(pdas, "confirmed");
      return infos
        .map((info, idx) => {
          if (!info || info.data.length < 87) return null;
          const d = Buffer.from(info.data);
          return {
            round:               readU64(d, 8),
            eeV4RoundId:         readU64(d, 16),
            startSlot:           readU64(d, 24),
            aggregated:          readBool(d, 32),
            aggregatedSlot:      readU64(d, 33),
            entropyOutput:       readHex(d, 41, 32),
            pendingRequests:     d.readUInt32LE(73),
            totalFees:           readU64(d, 77),
            eeV4EntropyIncluded: readBool(d, 85),
            bump:                d[86],
            pubkey:              pdas[idx].toBase58(),
          } as WrapperRound;
        })
        .filter((wr): wr is WrapperRound => wr !== null);
    } catch {
      return [];
    }
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
      // V4.6: x1_randomness_authority hot key at offset 139 (accounts are 171 bytes post-migration)
      x1RandomnessAuthority:  d.length >= 171 ? readPubkey(d, 139) : undefined,
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

  async getAllFeeEscrows(): Promise<FeeEscrow[]> {
    try {
      const disc = ACCT_DISC.FeeEscrow;
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey(require("./constants").PROGRAM_ID),
        {
          commitment: "confirmed",
          filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
        }
      );
      return accounts
        .filter(a => a.account.data.length >= 42)
        .map(a => this.parseFeeEscrow(Buffer.from(a.account.data), a.pubkey));
    } catch {
      return [];
    }
  }

  // Returns total, successful, and failed (non-aggregated and old) WrapperRound counts.
  // sinceRound: only count rounds >= this number (ROUND_STATS_BASELINE_ROUND excludes history).
  // maxRound: upper bound — pass ProtocolConfig.currentRound to exclude EE WrapperRounds, which
  //   share the same discriminator but have round numbers in the hundreds of thousands.
  // Uses dataSlice to minimise data transfer — only fetches round + startSlot + aggregated (25 bytes).
  async getAllWrapperRoundStats(currentSlot: number, sinceRound = 0, maxRound = Number.MAX_SAFE_INTEGER): Promise<{ total: number; failed: number; successful: number }> {
    try {
      const disc = ACCT_DISC.WrapperRound;
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey(require("./constants").PROGRAM_ID),
        {
          commitment: "confirmed",
          filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
          dataSlice: { offset: 8, length: 25 }, // round (u64,8) + eeV4RoundId (u64,8) + startSlot (u64,8) + aggregated (bool,1)
        }
      );
      let total = 0, failed = 0;
      for (const a of accounts) {
        const d = Buffer.from(a.account.data);
        if (d.length < 25) continue;
        const round      = Number(d.readBigUInt64LE(0));  // original offset 8
        const startSlot  = Number(d.readBigUInt64LE(16)); // original offset 24
        const aggregated = d[24] !== 0;                   // original offset 32
        if (round < sinceRound || round > maxRound) continue; // exclude pre-baseline and EE WrapperRounds
        total++;
        // A round is definitively failed when non-aggregated and too old to still be in progress.
        // Max round duration: commit (200) + reveal (600) + binding (675) + expiry grace (512) ≈ 2000 slots.
        if (!aggregated && startSlot < currentSlot - 2000) failed++;
      }
      return { total, failed, successful: total - failed };
    } catch {
      return { total: 0, failed: 0, successful: 0 };
    }
  }

  async getRequestsByRequester(requester: PublicKey): Promise<{ total: number; fulfilled: number }> {
    try {
      const disc = ACCT_DISC.RequestState;
      const accounts = await this.connection.getProgramAccounts(
        new PublicKey(require("./constants").PROGRAM_ID),
        {
          commitment: "confirmed",
          dataSlice: { offset: 152, length: 1 }, // only fetch the fulfilled byte to minimise data
          filters: [
            { memcmp: { offset: 0,  bytes: bs58.encode(disc) } },
            { memcmp: { offset: 40, bytes: requester.toBase58() } },
          ],
        }
      );
      const fulfilled = accounts.filter(a => a.account.data[0] !== 0).length;
      return { total: accounts.length, fulfilled };
    } catch {
      return { total: 0, fulfilled: 0 };
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
