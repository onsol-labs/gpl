import * as anchor from "@project-serum/anchor";
import {
  PublicKey,
  LAMPORTS_PER_SOL,
  Keypair,
  SystemProgram,
  Connection,
} from "@solana/web3.js";

import { GplCompression } from "../../target/types/gpl_compression";
import { GplCore } from "../../target/types/gpl_core";
import { GplSession } from "../../target/types/gpl_session";

import pkg from "js-sha3";

import {
  getConcurrentMerkleTreeAccountSize,
  SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  SPL_NOOP_PROGRAM_ID,
  ValidDepthSizePair,
  MerkleTree,
  ConcurrentMerkleTreeAccount,
} from "@solana/spl-account-compression";

const { keccak_256 } = pkg;

const provider = anchor.getProvider();

export const gpl_core = anchor.workspace.GplCore as anchor.Program<GplCore>;

export const gpl_compression = anchor.workspace
  .GplCompression as anchor.Program<GplCompression>;

export const gpl_session = anchor.workspace
  .GplSession as anchor.Program<GplSession>;

export async function new_session(
  user: PublicKey,
  targetProgram: PublicKey,
  authority?: Keypair
): Promise<{ sessionPDA: PublicKey; sessionSigner: Keypair }> {
  const sessionSigner = Keypair.generate();
  const sessionTx = gpl_session.methods.createSession(true, null).accounts({
    authority: user,
    sessionSigner: sessionSigner.publicKey,
    targetProgram,
  });
  const sessionPubKeys = await sessionTx.pubkeys();
  const sessionPDA = sessionPubKeys.sessionToken as PublicKey;

  if (authority !== undefined) {
    await sessionTx.signers([sessionSigner, authority]).rpc();
  } else {
    await sessionTx.signers([sessionSigner]).rpc();
  }

  return { sessionPDA, sessionSigner };
}

export function assert_tree(
  onChainTree: ConcurrentMerkleTreeAccount,
  offChainTree: MerkleTree
): boolean {
  const right = new PublicKey(onChainTree.getCurrentRoot()).toBase58();
  const left = new PublicKey(offChainTree.getRoot()).toBase58();
  return right === left;
}

export interface TreeInfo {
  merkleTree: PublicKey;
  treeConfigPDA: PublicKey;
  offChainTree: MerkleTree;
}

export async function airdrop(key: PublicKey) {
  const airdropSig = await provider.connection.requestAirdrop(
    key,
    1 * LAMPORTS_PER_SOL
  );
  return provider.connection.confirmTransaction(airdropSig);
}

export function hash(data: Buffer): Buffer {
  return Buffer.from(keccak_256.arrayBuffer(data));
}

async function find_asset_id(
  merkleTree: PublicKey,
  seedHash: Buffer
): Promise<PublicKey> {
  const [asset_id] = await PublicKey.findProgramAddress(
    [Buffer.from("asset"), merkleTree.toBuffer(), seedHash],
    gpl_compression.programId
  );
  return asset_id;
}

export async function to_leaf(
  merkleTree: PublicKey,
  name: any,
  data: any,
  seeds: Buffer[]
): Promise<Buffer> {
  const seedHash = hash(Buffer.concat(seeds));
  const assetId = await find_asset_id(merkleTree, seedHash);
  const dataSerialized = await gpl_core.coder.accounts.encode(name, data);
  const dataHash = hash(dataSerialized);
  const leaf = Buffer.concat([assetId.toBuffer(), seedHash, dataHash]);
  return hash(leaf);
}

export async function setupTree(
  payer: Keypair,
  depthSizePair: ValidDepthSizePair,
  connection: Connection
): Promise<TreeInfo> {
  const merkleTreeKeypair = Keypair.generate();
  const merkleTree = merkleTreeKeypair.publicKey;
  const space = getConcurrentMerkleTreeAccountSize(
    depthSizePair.maxDepth,
    depthSizePair.maxBufferSize
  );

  const allocTreeIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: merkleTree,
    lamports: await connection.getMinimumBalanceForRentExemption(space),
    space: space,
    programId: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
  });

  const treeInitTx = gpl_compression.methods
    .initializeTree(depthSizePair.maxDepth, depthSizePair.maxBufferSize)
    .accounts({
      authority: payer.publicKey,
      merkleTree: merkleTree,
      logWrapper: SPL_NOOP_PROGRAM_ID,
      compressionProgram: SPL_ACCOUNT_COMPRESSION_PROGRAM_ID,
    });

  const treeConfigPDA = (await treeInitTx.pubkeys()).treeConfig;
  await treeInitTx
    .preInstructions([allocTreeIx])
    .signers([payer, merkleTreeKeypair])
    .rpc();

  const leaves = Array(2 ** depthSizePair.maxDepth).fill(Buffer.alloc(32));

  const offChainTree = new MerkleTree(leaves);

  return { merkleTree, treeConfigPDA, offChainTree };
}
