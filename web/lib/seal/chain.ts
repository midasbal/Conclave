// What puts a sealed strategy on devnet: the three instructions, the enclave login and the sealed account's layout. Ported from client/flows.mjs
// (register, delegIx, seal) and client/lib.mjs (addresses); the login and the permission address replace the MagicBlock SDK. Nothing here holds a key:
// whoever calls enclaveLogin passes the signing function. Seeds, account order and data layouts must match program/src/lib.rs.
// A rollup blockhash lasts under a minute (about 5,950 blocks at about 104 a second, measured), so sign and send promptly.
import { Buffer } from "buffer";
import bs58 from "bs58";
import { PublicKey, SystemProgram, ComputeBudgetProgram, Transaction, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { PROGRAM_ID } from "@/lib/links";

export const BASE_RPC = "https://api.devnet.solana.com";
export const TEE_RPC = "https://devnet-tee.magicblock.app";

export const PROGRAM = new PublicKey(PROGRAM_ID);
export const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");

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

/** MagicBlock's permission program and ephemeral rent vault, on devnet */
export const PERMISSION_PROGRAM = new PublicKey("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
export const EPHEMERAL_VAULT = new PublicKey("MagicVau1t999999999999999999999999999999999");

/** the accounts SealStrategy needs besides the strategy's own: the permission that lets only the owner read the sealed account lives at
 *  ["permission:", sealed account] under the permission program */
export function sealAddresses(sealed: PublicKey): SealAddresses {
  return { permission: pda(["permission:", sealed.toBytes()], PERMISSION_PROGRAM), vault: EPHEMERAL_VAULT, permissionProgram: PERMISSION_PROGRAM };
}

const SESSION_MS = 1000 * 60 * 60 * 24 * 30;

/**
 * The enclave login: ask for a text to sign, sign it, send the signature back, receive a token. Two requests, the same ones, in the same order and with
 * the same failures, as getAuthToken in @magicblock-labs/ephemeral-rollups-sdk 0.18.0, which this replaces. The address in the first request is public.
 * The token it returns is a credential: keep it in memory and send it in an Authorization header, never in an address.
 */
export async function enclaveLogin(rpcUrl: string, publicKey: PublicKey, signMessage: (message: Uint8Array) => Promise<Uint8Array>): Promise<{ token: string; expiresAt: number }> {
  const query = new URLSearchParams({ pubkey: publicKey.toString() });
  const first = await fetch(`${rpcUrl}/auth/challenge?${query.toString()}`);
  const { challenge, error } = (await first.json()) as { challenge?: unknown; error?: unknown };
  if (typeof error === "string" && error.length > 0) throw new Error(`Failed to get challenge: ${error}`);
  if (typeof challenge !== "string" || challenge.length === 0) throw new Error("No challenge received");

  const signature = bs58.encode(await signMessage(new TextEncoder().encode(challenge)));
  const second = await fetch(`${rpcUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: publicKey.toString(), challenge, signature }),
  });
  const answer = (await second.json()) as { token?: unknown; expiresAt?: number; error?: unknown };
  if (second.status !== 200) throw new Error(`Failed to authenticate: ${answer.error}`);
  if (typeof answer.token !== "string" || answer.token.length === 0) throw new Error("No token received");
  return { token: answer.token, expiresAt: answer.expiresAt ?? Date.now() + SESSION_MS };
}

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

export type Sealed = { length: number; owner: PublicKey; id: bigint; commitment: Uint8Array; salt: Uint8Array; code: Uint8Array };

/** the sealed account, as parseSealedAccount in client/artifact.mjs reads it */
export function parseSealed(data: Uint8Array): Sealed {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 136 || view.getUint32(0, true) !== 0x53545254) throw new Error("not a sealed strategy account");
  const length = view.getUint16(4, true);
  return { length, owner: new PublicKey(data.slice(8, 40)), id: view.getBigUint64(40, true), commitment: data.slice(48, 80), salt: data.slice(104, 136), code: data.slice(136, 136 + length) };
}
