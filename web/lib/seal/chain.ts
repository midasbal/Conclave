// The transactions that put a sealed strategy on devnet, ported from client/flows.mjs (register, delegIx, seal) and client/lib.mjs (addresses).
// Nothing here signs or holds a key. Seeds, account order and data layouts must match program/src/lib.rs.
import { Buffer } from "buffer";
import { PublicKey, SystemProgram, ComputeBudgetProgram, Transaction, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { PROGRAM_ID } from "@/lib/links";

export const BASE_RPC = "https://api.devnet.solana.com";
export const TEE_RPC = "https://devnet-tee.magicblock.app";

export const PROGRAM = new PublicKey(PROGRAM_ID);
export const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
/** a rollup blockhash was measured valid at 30 s and gone by 60 s: lastValidBlockHeight sits about 5,950 blocks ahead, at about 104 blocks a second */
export const ROLLUP_BLOCKHASH_SECONDS = 55;

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false): AccountMeta => ({ pubkey, isWritable, isSigner });
export const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const pda = (seeds: (Uint8Array | string)[], program = PROGRAM) =>
  PublicKey.findProgramAddressSync(seeds.map(s => (typeof s === "string" ? Buffer.from(s) : Buffer.from(s))), program)[0];

export const registryAddress = (id: bigint) => pda(["reg", u64(id)]);
export const sealedAddress = (id: bigint) => pda(["strat", u64(id)]);

const instruction = (tag: number, keys: AccountMeta[], ...data: Uint8Array[]) =>
  new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.concat([Buffer.from([tag]), ...data.map(d => Buffer.from(d))]) });

/** sha256("CNCL-CODE-v1" || salt || code): the only thing about the code that is public */
export async function codeCommitment(salt: Uint8Array, code: Uint8Array): Promise<Uint8Array> {
  const input = Buffer.concat([Buffer.from("CNCL-CODE-v1"), Buffer.from(salt), Buffer.from(code)]);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

/** 1 Register (Solana). The owner pays the registry's rent and 2,000,000 lamports it will later spend on the sealed account's rent */
export function registerInstruction(owner: PublicKey, id: bigint, commitment: Uint8Array) {
  return instruction(1, [meta(owner, true, true), meta(registryAddress(id), true), meta(SystemProgram.programId)], u64(id), commitment);
}

/** 2 Delegate (Solana), kind 1: hands the registry to the rollup run by `validator` */
export function delegateInstruction(owner: PublicKey, id: bigint, validator: PublicKey) {
  const account = registryAddress(id);
  return instruction(
    2,
    [
      meta(owner, true, true),
      meta(SystemProgram.programId),
      meta(account, true),
      meta(PROGRAM),
      meta(pda(["buffer", account.toBytes()]), true),
      meta(pda(["delegation", account.toBytes()], DELEGATION_PROGRAM), true),
      meta(pda(["delegation-metadata", account.toBytes()], DELEGATION_PROGRAM), true),
      meta(DELEGATION_PROGRAM),
      meta(validator),
    ],
    Uint8Array.of(1),
    u64(id),
  );
}

export type SealAddresses = { permission: PublicKey; vault: PublicKey; permissionProgram: PublicKey };

/** 3 SealStrategy (rollup). Its data carries the salt and the code in plain form: whoever is shown this transaction is shown the strategy */
export function sealInstruction(owner: PublicKey, id: bigint, salt: Uint8Array, code: Uint8Array, a: SealAddresses) {
  return instruction(
    3,
    [meta(owner, false, true), meta(sealedAddress(id), true), meta(a.permission, true), meta(a.vault, true), meta(MAGIC_PROGRAM), meta(a.permissionProgram), meta(registryAddress(id), true)],
    u64(id),
    salt,
    code,
  );
}

export function transactionOf(feePayer: PublicKey, blockhash: string, ...instructions: TransactionInstruction[]) {
  const tx = new Transaction();
  tx.add(...instructions);
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  return tx;
}
/** the compute limit the client asks for in the rollup */
export const computeLimit = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

export type Returned = {
  /** every difference between what was asked and what the wallet gave back, in words */
  changes: string[];
  /** safe to send: the fee payer is unchanged, every instruction asked for (compute budget aside) is there unaltered and in order, and the signatures verify */
  sendable: boolean;
  signatureValid: boolean;
};

const same = (a: TransactionInstruction, b: TransactionInstruction) =>
  a.programId.equals(b.programId) && Buffer.from(a.data).equals(Buffer.from(b.data)) && a.keys.length === b.keys.length && a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey));

/** A wallet may change a transaction before signing it. This compares what came back with what was handed over. */
export function compareReturned(asked: Transaction, got: Transaction): Returned {
  const changes: string[] = [];
  const payerSame = !!got.feePayer && !!asked.feePayer && got.feePayer.equals(asked.feePayer);
  if (!payerSame) changes.push("the fee payer was changed");
  if (got.recentBlockhash !== asked.recentBlockhash) changes.push("the blockhash was replaced (a rollup does not know a blockhash from another cluster)");
  // a wallet may reasonably set its own compute budget: that is reported, but what must come back unaltered is every other instruction
  const budget = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId);
  const wanted = asked.instructions.filter(ix => !budget(ix));
  const askedBudget = asked.instructions.filter(budget);
  const gotBudget = got.instructions.filter(budget);
  if (askedBudget.length !== gotBudget.length || askedBudget.some((ix, i) => !same(ix, gotBudget[i]))) changes.push(`the compute budget instructions were changed (asked for ${askedBudget.length}, got ${gotBudget.length})`);
  let next = 0;
  const added: string[] = [];
  for (const ix of got.instructions.filter(i => !budget(i))) {
    if (next < wanted.length && same(wanted[next], ix)) next += 1;
    else added.push(ix.programId.toBase58());
  }
  const intact = next === wanted.length;
  if (!intact) changes.push("an instruction that was asked for is missing or altered");
  if (added.length) changes.push(`${added.length} instruction(s) not asked for, of program(s) ${added.join(", ")}`);
  let signatureValid = false;
  try { signatureValid = got.verifySignatures(); } catch { signatureValid = false; }
  if (!signatureValid) changes.push("the signatures do not verify");
  return { changes, sendable: payerSame && intact && signatureValid, signatureValid };
}

export type Sealed = { length: number; owner: PublicKey; id: bigint; commitment: Uint8Array; salt: Uint8Array; code: Uint8Array };

/** the sealed account, as parseSealedAccount in client/artifact.mjs reads it */
export function parseSealed(data: Uint8Array): Sealed {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 136 || view.getUint32(0, true) !== 0x53545254) throw new Error("not a sealed strategy account");
  const length = view.getUint16(4, true);
  return { length, owner: new PublicKey(data.slice(8, 40)), id: view.getBigUint64(40, true), commitment: data.slice(48, 80), salt: data.slice(104, 136), code: data.slice(136, 136 + length) };
}
