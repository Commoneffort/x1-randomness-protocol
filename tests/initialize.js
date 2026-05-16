// Initialize X1 Randomness Protocol
const { Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction } = require('@solana/web3.js');
const fs = require('fs');
const os = require('os');

const PROGRAM_ID = new PublicKey('BNKCFaDF32DkK9JwG4be5uEkaFDRgm5fMUEm43YxzWJr');
const LOCALNET = 'http://127.0.0.1:8899';

function loadWallet() {
  const keypairPath = `${os.homedir()}/.config/solana/id.json`;
  const secretKey = JSON.parse(fs.readFileSync(keypairPath, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}

function findProtocolConfigPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('protocol-config')], PROGRAM_ID);
}

function findEntropyPoolPda() {
  return PublicKey.findProgramAddressSync([Buffer.from('entropy-pool')], PROGRAM_ID);
}

// Discriminator for initialize instruction
const INITIALIZE_DISC = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);

async function main() {
  const conn = new Connection(LOCALNET, 'confirmed');
  const wallet = loadWallet();
  const treasury = Keypair.generate();
  const reserve = Keypair.generate();

  console.log('Wallet:', wallet.publicKey.toBase58());
  console.log('Treasury:', treasury.publicKey.toBase58());
  console.log('Reserve:', reserve.publicKey.toBase58());

  const [configPda, configBump] = findProtocolConfigPda();
  const [poolPda, poolBump] = findEntropyPoolPda();

  console.log('Config PDA:', configPda.toBase58(), 'bump:', configBump);
  console.log('Pool PDA:', poolPda.toBase58(), 'bump:', poolBump);

  // Check if already initialized
  const existing = await conn.getAccountInfo(configPda);
  if (existing) {
    console.log('Protocol already initialized!');
    console.log('Config size:', existing.data.length, 'bytes');
    return;
  }

  // Build initialize instruction
  // Accounts: protocolConfig, entropyPool, treasury, reserve, authority, systemProgram
  const keys = [
    { pubkey: configPda, isSigner: false, isWritable: true },
    { pubkey: poolPda, isSigner: false, isWritable: true },
    { pubkey: treasury.publicKey, isSigner: false, isWritable: false },
    { pubkey: reserve.publicKey, isSigner: false, isWritable: false },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  const ix = new TransactionInstruction({
    keys,
    programId: PROGRAM_ID,
    data: INITIALIZE_DISC,
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  const blockhash = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash.blockhash;

  const sig = await conn.sendTransaction(tx, [wallet]);
  await conn.confirmTransaction({ signature: sig, ...blockhash }, 'confirmed');

  console.log('Initialize TX:', sig);

  // Verify accounts created
  const configAcc = await conn.getAccountInfo(configPda);
  const poolAcc = await conn.getAccountInfo(poolPda);
  console.log('Config created:', configAcc ? configAcc.data.length + ' bytes' : 'NO');
  console.log('Pool created:', poolAcc ? poolAcc.data.length + ' bytes' : 'NO');
}

main().catch(e => { console.error(e); process.exit(1); });
