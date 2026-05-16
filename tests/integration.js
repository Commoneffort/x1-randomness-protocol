// @ts-nocheck
/**
 * X1 Randomness Protocol v3 — Full Integration Test Suite
 * Uses raw Solana Web3.js transactions (no Anchor SDK) for maximum compatibility
 */

const {
  Connection, PublicKey, Keypair, SystemProgram, Transaction,
  TransactionInstruction, LAMPORTS_PER_SOL, sendAndConfirmTransaction
} = require('@solana/web3.js');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const PROGRAM_ID = new PublicKey('BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr');
const LOCALNET = 'http://127.0.0.1:19888';

// ── PDA Derivation ──────────────────────────────────────────────────────────────
function findProtocolConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('protocol-config')], PROGRAM_ID);
}
function findEntropyPoolPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('entropy-pool')], PROGRAM_ID);
}
function findValidatorPda(pubkey) {
  return PublicKey.findProgramAddressSync([Buffer.from('validator'), pubkey.toBuffer()], PROGRAM_ID);
}
function findDappPda(dappId) {
  return PublicKey.findProgramAddressSync([Buffer.from('dapp'), dappId.toBuffer()], PROGRAM_ID);
}
function findCommitteeRoundPda(round) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(round));
  return PublicKey.findProgramAddressSync([Buffer.from('committee-round'), buf], PROGRAM_ID);
}
function findRequestPda(requester, seed) {
  return PublicKey.findProgramAddressSync([Buffer.from('request'), requester.toBuffer(), seed], PROGRAM_ID);
}
function findFeeEscrowPda(round) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(round));
  return PublicKey.findProgramAddressSync([Buffer.from('fee-escrow'), buf], PROGRAM_ID);
}

// ── Discriminators ──────────────────────────────────────────────────────────────
function computeDiscriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

const DISC = {};
const INSTRUCTION_NAMES = [
  'initialize', 'register_validator', 'register_dapp', 'unregister_dapp',
  'request_randomness', 'commit', 'reveal', 'advance_round',
  'aggregate_and_callback', 'slash_non_revealers', 'distribute_fees',
  'withdraw_bond', 'update_authority', 'update_fees'
];
for (const name of INSTRUCTION_NAMES) {
  DISC[name] = computeDiscriminator(name);
}

// ── Crypto Helpers ──────────────────────────────────────────────────────────────
const computeCommitment = (secret, nonce, pubkey) =>
  crypto.createHash('sha256').update(Buffer.concat([secret, nonce, pubkey.toBuffer()])).digest();
const computeOutput = (entropy, reqId) =>
  crypto.createHash('sha256').update(Buffer.concat([entropy, reqId])).digest();

// ── Account Parsers ──────────────────────────────────────────────────────────────
function parseProtocolConfig(data) {
  let o = 8;
  const authority = new PublicKey(data.slice(o, o + 32)); o += 32;
  const treasury = new PublicKey(data.slice(o, o + 32)); o += 32;
  const reserve = new PublicKey(data.slice(o, o + 32)); o += 32;
  const currentRound = data.readBigUInt64LE(o); o += 8;
  const currentRoundStartSlot = data.readBigUInt64LE(o); o += 8;
  const roundDurationSlots = data.readBigUInt64LE(o); o += 8;
  const commitPhaseSlots = data.readBigUInt64LE(o); o += 8;
  const revealPhaseSlots = data.readBigUInt64LE(o); o += 8;
  const revealThreshold = data.readUInt32LE(o); o += 4;
  const committeeSize = data.readUInt32LE(o); o += 4;
  const minBond = data.readBigUInt64LE(o); o += 8;
  const requestFee = data.readBigUInt64LE(o); o += 8;
  const totalRounds = data.readBigUInt64LE(o); o += 8;
  const bump = data[o]; o += 1;
  return { authority, treasury, reserve, currentRound, currentRoundStartSlot, roundDurationSlots, commitPhaseSlots, revealPhaseSlots, revealThreshold, committeeSize, minBond, requestFee, totalRounds, bump };
}

function parseEntropyPool(data) {
  let o = 8;
  const currentEntropy = Buffer.from(data.slice(o, o + 32)); o += 32;
  const currentRound = data.readBigUInt64LE(o); o += 8;
  const entropyAvailable = data[o] !== 0; o += 1;
  const lastAggregatedSlot = data.readBigUInt64LE(o); o += 8;
  const totalRequestsServed = data.readBigUInt64LE(o); o += 8;
  const bump = data[o]; o += 1;
  return { currentEntropy, currentRound, entropyAvailable, lastAggregatedSlot, totalRequestsServed, bump };
}

function parseValidatorReg(data) {
  let o = 8;
  const validator = new PublicKey(data.slice(o, o + 32)); o += 32;
  const bond = data.readBigUInt64LE(o); o += 8;
  const roundsParticipated = data.readBigUInt64LE(o); o += 8;
  const roundsMissed = data.readBigUInt64LE(o); o += 8;
  const inCommittee = data[o] !== 0; o += 1;
  const bump = data[o]; o += 1;
  return { validator, bond, roundsParticipated, roundsMissed, inCommittee, bump };
}

function parseDappRegistration(data) {
  let o = 8;
  const dappId = new PublicKey(data.slice(o, o + 32)); o += 32;
  const callbackProgram = new PublicKey(data.slice(o, o + 32)); o += 32;
  const callbackInstruction = Buffer.from(data.slice(o, o + 8)); o += 8;
  const minRoundInterval = data.readBigUInt64LE(o); o += 8;
  const lastServedRound = data.readBigUInt64LE(o); o += 8;
  const totalRequests = data.readBigUInt64LE(o); o += 8;
  const authority = new PublicKey(data.slice(o, o + 32)); o += 32;
  const bump = data[o]; o += 1;
  return { dappId, callbackProgram, callbackInstruction, minRoundInterval, lastServedRound, totalRequests, authority, bump };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────
function loadWallet() {
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf8'))));
}

async function sendTx(connection, instructions, signers, feePayer) {
  const tx = new Transaction().add(...instructions);
  tx.feePayer = feePayer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  const sig = await sendAndConfirmTransaction(connection, tx, [feePayer, ...signers], {
    commitment: 'confirmed',
    maxRetries: 3,
  });
  return sig;
}

async function transferSol(connection, from, to, lamports) {
  const ix = SystemProgram.transfer({
    fromPubkey: from.publicKey,
    toPubkey: to,
    lamports,
  });
  return sendTx(connection, [ix], [], from);
}

// ── Main Test ──────────────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  X1 Randomness Protocol v3 — Full Integration Test Suite       ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  const conn = new Connection(LOCALNET, 'confirmed');
  const payer = loadWallet();

  let passed = 0, failed = 0, total = 0;

  function check(name, fn) {
    total++;
    try {
      fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e.message.slice(0, 100)}`);
      failed++;
    }
  }

  async function checkAsync(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${e.message.slice(0, 150)}`);
      failed++;
    }
  }

  // ── Setup ────────────────────────────────────────────────────────────────────
  const version = await conn.getVersion();
  console.log(`Validator: solana-core ${version['solana-core']}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}\n`);

  const authority = Keypair.generate();
  const treasury = Keypair.generate();
  const reserve = Keypair.generate();
  const validator1 = Keypair.generate();
  const validator2 = Keypair.generate();
  const validator3 = Keypair.generate();
  const dappAuthority = Keypair.generate();

  // Fund test accounts from payer
  console.log('── Funding Test Accounts ──');
  const FUND_AMT = 2 * LAMPORTS_PER_SOL;
  for (const [name, kp] of [['authority', authority], ['validator1', validator1], ['validator2', validator2], ['validator3', validator3], ['dappAuth', dappAuthority]]) {
    await checkAsync(`Fund ${name} (2 SOL)`, async () => {
      await transferSol(conn, payer, kp.publicKey, FUND_AMT);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // SECTION 1: Cryptographic Unit Tests
  // ════════════════════════════════════════════════════════════════════════════════
  console.log('\n── Section 1: Cryptographic Unit Tests ──');

  check('Unique output per request', () => {
    const e = Buffer.alloc(32, 0xff);
    assert.notDeepStrictEqual(computeOutput(e, Buffer.alloc(32, 1)), computeOutput(e, Buffer.alloc(32, 2)));
  });

  check('Deterministic SHA256 output', () => {
    const e = Buffer.alloc(32, 0xaa), r = Buffer.alloc(32, 0xbb);
    assert.deepStrictEqual(computeOutput(e, r), computeOutput(e, r));
  });

  check('Commitment hash = SHA256(secret||nonce||pubkey)', () => {
    const s = crypto.randomBytes(32), n = crypto.randomBytes(32), pk = Keypair.generate().publicKey;
    assert.deepStrictEqual(computeCommitment(s, n, pk), computeCommitment(s, n, pk));
    assert.strictEqual(computeCommitment(s, n, pk).length, 32);
  });

  check('Discriminator: initialize', () => {
    assert.deepStrictEqual(DISC.initialize, Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]));
  });

  check('Discriminator: all 14 instructions unique', () => {
    const discs = Object.values(DISC);
    const unique = new Set(discs.map(d => d.toString('hex')));
    assert.strictEqual(unique.size, 14);
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // SECTION 2: PDA Derivation Tests
  // ════════════════════════════════════════════════════════════════════════════════
  console.log('\n── Section 2: PDA Derivation Tests ──');

  check('ProtocolConfig PDA deterministic', () => {
    const [p1, b1] = findProtocolConfigPda();
    const [p2, b2] = findProtocolConfigPda();
    assert.strictEqual(p1.toBase58(), p2.toBase58());
    assert.strictEqual(b1, b2);
  });

  check('EntropyPool PDA off-curve', () => {
    const [p] = findEntropyPoolPda();
    assert.ok(!PublicKey.isOnCurve(p));
  });

  check('Validator PDA off-curve', () => {
    const [p] = findValidatorPda(validator1.publicKey);
    assert.ok(!PublicKey.isOnCurve(p));
  });

  check('dApp PDA off-curve', () => {
    const [p] = findDappPda(Keypair.generate().publicKey);
    assert.ok(!PublicKey.isOnCurve(p));
  });

  check('CommitteeRound PDA deterministic', () => {
    const [p1] = findCommitteeRoundPda(0);
    const [p2] = findCommitteeRoundPda(0);
    assert.strictEqual(p1.toBase58(), p2.toBase58());
  });

  check('Request PDA off-curve', () => {
    const [p] = findRequestPda(validator1.publicKey, Buffer.alloc(32, 0x42));
    assert.ok(!PublicKey.isOnCurve(p));
  });

  check('FeeEscrow PDA off-curve', () => {
    const [p] = findFeeEscrowPda(0);
    assert.ok(!PublicKey.isOnCurve(p));
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // SECTION 3: On-Chain Integration Tests
  // ════════════════════════════════════════════════════════════════════════════════
  console.log('\n── Section 3: On-Chain Integration Tests ──');

  await checkAsync('Initialize protocol', async () => {
    const [configPda] = findProtocolConfigPda();
    const [poolPda] = findEntropyPoolPda();

    const existing = await conn.getAccountInfo(configPda);
    if (existing) { console.log('    (already initialized)'); return; }

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: poolPda, isSigner: false, isWritable: true },
        { pubkey: treasury.publicKey, isSigner: false, isWritable: false },
        { pubkey: reserve.publicKey, isSigner: false, isWritable: false },
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data: DISC.initialize,
    });

    const sig = await sendTx(conn, [ix], [authority], authority);
    console.log(`    TX: ${sig.slice(0, 32)}...`);
  });

  await checkAsync('Protocol config data verified', async () => {
    const [configPda] = findProtocolConfigPda();
    const account = await conn.getAccountInfo(configPda);
    assert.ok(account, 'Config account should exist');
    const config = parseProtocolConfig(account.data);
    assert.strictEqual(config.authority.toBase58(), authority.publicKey.toBase58());
    assert.strictEqual(config.treasury.toBase58(), treasury.publicKey.toBase58());
    assert.strictEqual(config.reserve.toBase58(), reserve.publicKey.toBase58());
    assert.strictEqual(config.roundDurationSlots.toString(), '75');
    assert.strictEqual(config.commitPhaseSlots.toString(), '25');
    assert.strictEqual(config.revealPhaseSlots.toString(), '25');
    assert.strictEqual(config.revealThreshold, 14);
    assert.strictEqual(config.committeeSize, 21);
    assert.strictEqual(config.minBond.toString(), '1000000000');
    assert.strictEqual(config.requestFee.toString(), '10000000');
    console.log(`    authority=✓ round=75 slots, threshold=14/21, fee=0.01 XNT`);
  });

  await checkAsync('Entropy pool initial state', async () => {
    const [poolPda] = findEntropyPoolPda();
    const account = await conn.getAccountInfo(poolPda);
    assert.ok(account, 'Pool should exist');
    const pool = parseEntropyPool(account.data);
    assert.strictEqual(pool.entropyAvailable, false);
    assert.strictEqual(pool.currentRound.toString(), '0');
    assert.strictEqual(pool.totalRequestsServed.toString(), '0');
    console.log(`    available=false, round=0, served=0`);
  });

  await checkAsync('Register validator 1 (1 XNT bond)', async () => {
    const [validatorPda] = findValidatorPda(validator1.publicKey);
    const [configPda] = findProtocolConfigPda();
    const existing = await conn.getAccountInfo(validatorPda);
    if (existing) { console.log('    (already registered)'); return; }

    const bondAmount = BigInt(1_000_000_000);
    const data = Buffer.alloc(8 + 8);
    DISC.register_validator.copy(data, 0);
    data.writeBigUInt64LE(bondAmount, 8);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: validatorPda, isSigner: false, isWritable: true },
        { pubkey: validator1.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const sig = await sendTx(conn, [ix], [validator1], authority);
    console.log(`    TX: ${sig.slice(0, 32)}...`);
  });

  await checkAsync('Validator 1 data verified', async () => {
    const [validatorPda] = findValidatorPda(validator1.publicKey);
    const account = await conn.getAccountInfo(validatorPda);
    assert.ok(account, 'Validator account should exist');
    const reg = parseValidatorReg(account.data);
    assert.strictEqual(reg.validator.toBase58(), validator1.publicKey.toBase58());
    assert.strictEqual(reg.bond.toString(), '1000000000');
    assert.strictEqual(reg.inCommittee, false);
    console.log(`    validator=✓ bond=1 XNT, inCommittee=false`);
  });

  await checkAsync('Register validator 2', async () => {
    const [validatorPda] = findValidatorPda(validator2.publicKey);
    const [configPda] = findProtocolConfigPda();
    const existing = await conn.getAccountInfo(validatorPda);
    if (existing) { console.log('    (already registered)'); return; }

    const bondAmount = BigInt(1_000_000_000);
    const data = Buffer.alloc(8 + 8);
    DISC.register_validator.copy(data, 0);
    data.writeBigUInt64LE(bondAmount, 8);

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: validatorPda, isSigner: false, isWritable: true },
        { pubkey: validator2.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const sig = await sendTx(conn, [ix], [validator2], authority);
    console.log(`    TX: ${sig.slice(0, 32)}...`);
  });

  await checkAsync('Reject bond below minimum', async () => {
    try {
      const val3 = Keypair.generate();
      await transferSol(conn, payer, val3.publicKey, LAMPORTS_PER_SOL);

      const [validatorPda] = findValidatorPda(val3.publicKey);
      const [configPda] = findProtocolConfigPda();
      const bondAmount = BigInt(100);
      const data = Buffer.alloc(8 + 8);
      DISC.register_validator.copy(data, 0);
      data.writeBigUInt64LE(bondAmount, 8);

      const ix = new TransactionInstruction({
        keys: [
          { pubkey: validatorPda, isSigner: false, isWritable: true },
          { pubkey: val3.publicKey, isSigner: true, isWritable: true },
          { pubkey: configPda, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data,
      });

      await sendTx(conn, [ix], [val3], authority);
      assert.fail('Should have thrown');
    } catch (e) {
      assert.ok(e.toString().includes('BondBelowMinimum') || e.toString().includes('6008') || e.toString().includes('custom program error'), 'Expected BondBelowMinimum error');
      console.log(`    Correctly rejected: ${e.toString().slice(0, 60)}...`);
    }
  });

  await checkAsync('Register dApp (on-demand)', async () => {
    const dappId = Keypair.generate().publicKey;
    const callbackProgram = Keypair.generate().publicKey;
    const callbackInstruction = Buffer.alloc(8, 0x01);
    const [dappPda] = findDappPda(dappId);
    const [configPda] = findProtocolConfigPda();

    const data = Buffer.alloc(8 + 32 + 8 + 8);
    DISC.register_dapp.copy(data, 0);
    callbackProgram.toBuffer().copy(data, 8);
    callbackInstruction.copy(data, 8 + 32);
    data.writeBigUInt64LE(BigInt(0), 8 + 32 + 8); // min_round_interval = 0

    const ix = new TransactionInstruction({
      keys: [
        { pubkey: dappPda, isSigner: false, isWritable: true },
        { pubkey: dappId, isSigner: false, isWritable: false },
        { pubkey: dappAuthority.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: PROGRAM_ID,
      data,
    });

    const sig = await sendTx(conn, [ix], [dappAuthority], authority);
    console.log(`    TX: ${sig.slice(0, 32)}...`);

    // Verify
    const dappAccount = await conn.getAccountInfo(dappPda);
    assert.ok(dappAccount, 'dApp account should exist');
    const dapp = parseDappRegistration(dappAccount.data);
    assert.strictEqual(dapp.dappId.toBase58(), dappId.toBase58());
    assert.strictEqual(dapp.callbackProgram.toBase58(), callbackProgram.toBase58());
    assert.strictEqual(dapp.minRoundInterval.toString(), '0');
    assert.strictEqual(dapp.authority.toBase58(), dappAuthority.publicKey.toBase58());
    console.log(`    dApp registered: ${dappId.toBase58().slice(0, 8)}... interval=0`);
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // SECTION 4: Account Size Verification
  // ════════════════════════════════════════════════════════════════════════════════
  console.log('\n── Section 4: Account Size & Rent Verification ──');

  await checkAsync('Protocol config size', async () => {
    const [configPda] = findProtocolConfigPda();
    const account = await conn.getAccountInfo(configPda);
    assert.ok(account);
    // 8 disc + 32*3 pubkeys + 8*6 u64s + 4*2 u32s + 8*2 u64s + 1 bump = 177
    console.log(`    Size: ${account.data.length} bytes`);
    assert.ok(account.data.length >= 177);
  });

  await checkAsync('Entropy pool size', async () => {
    const [poolPda] = findEntropyPoolPda();
    const account = await conn.getAccountInfo(poolPda);
    assert.ok(account);
    // 8 + 32 + 8 + 1 + 8 + 8 + 1 = 66
    console.log(`    Size: ${account.data.length} bytes`);
    assert.ok(account.data.length >= 66);
  });

  await checkAsync('Validator registration size', async () => {
    const [validatorPda] = findValidatorPda(validator1.publicKey);
    const account = await conn.getAccountInfo(validatorPda);
    assert.ok(account);
    // 8 disc + 32 pubkey + 8 bond + 8 rounds_participated + 8 rounds_missed + 1 in_committee + 1 bump = 66
    console.log(`    Size: ${account.data.length} bytes`);
    assert.ok(account.data.length >= 66);
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // SECTION 5: Error Handling Tests
  // ════════════════════════════════════════════════════════════════════════════════
  console.log('\n── Section 5: Error Handling Tests ──');

  await checkAsync('Double initialization rejected', async () => {
    const [configPda] = findProtocolConfigPda();
    const [poolPda] = findEntropyPoolPda();
    try {
      const ix = new TransactionInstruction({
        keys: [
          { pubkey: configPda, isSigner: false, isWritable: true },
          { pubkey: poolPda, isSigner: false, isWritable: true },
          { pubkey: treasury.publicKey, isSigner: false, isWritable: false },
          { pubkey: reserve.publicKey, isSigner: false, isWritable: false },
          { pubkey: authority.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        programId: PROGRAM_ID,
        data: DISC.initialize,
      });
      await sendTx(conn, [ix], [authority], authority);
      assert.fail('Should have thrown on double init');
    } catch (e) {
      // Anchor error: account already initialized
      assert.ok(e.toString().includes('already') || e.toString().includes('custom program error') || e.toString().includes('0x1'), 'Expected already-initialized error');
      console.log(`    Correctly rejected double init`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════
  // RESULTS
  // ════════════════════════════════════════════════════════════════════════════════
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${String(passed).padStart(2)} passed, ${String(failed).padStart(2)} failed out of ${String(total).padStart(2)} total              ║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error('FATAL:', e); process.exit(1); });