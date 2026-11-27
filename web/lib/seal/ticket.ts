// The claim ticket: one file that holds everything about one sealed strategy that exists nowhere else. It is the only proof of ownership (the owner's
// secret key) and the only copy of the salt and code. It is made and read in the browser and is never sent anywhere. The screens that will enter a
// season or read results take it back with parseTicket, so its shape is versioned.
import { Keypair } from "@solana/web3.js";
import { PROGRAM_ID } from "@/lib/links";
import { codeCommitment } from "./chain";

export const TICKET_KIND = "conclave-claim-ticket";
export const TICKET_VERSION = 1;
/** the longest program the VM takes: a 4-byte header and 64 instructions of 4 bytes */
const MAX_CODE_BYTES = 260;
const MAX_FILE_BYTES = 200_000;

export type Check = { name: string; ok: boolean };

export type Receipt = {
  sealedAt: string;
  registry: string;
  sealedAccount: string;
  validator: string;
  /** a signature is null when this run found the step already done, which happens after a retry or a resumed seal */
  transactions: { funding: string | null; register: string | null; delegate: string | null; seal: string | null };
  checks: Check[];
};

/** what is fixed before anything is funded or sent */
export type Claim = {
  createdAt: string;
  owner: Keypair;
  id: bigint;
  salt: Uint8Array;
  code: Uint8Array;
  commitment: Uint8Array;
  source: string;
  name: string | null;
  ruleset: number;
};

export type Opened = { claim: Claim; status: "prepared" | "sealed"; receipt: Receipt | null };

export const toHex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], x => parseInt(x, 16));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** the file's text. With a receipt the ticket says the strategy is sealed; without one it says only that it was prepared */
export function ticketText(claim: Claim, receipt: Receipt | null = null): string {
  const file = {
    kind: TICKET_KIND,
    version: TICKET_VERSION,
    cluster: "devnet",
    warning: "SECRET. This file is the only proof of ownership of this strategy and the only copy of its salt and code. Conclave never stores it. Whoever has it owns the strategy; if it is lost, the strategy is lost.",
    program: PROGRAM_ID,
    createdAt: claim.createdAt,
    status: receipt ? "sealed" : "prepared",
    owner: { publicKey: claim.owner.publicKey.toBase58(), secretKey: Array.from(claim.owner.secretKey) },
    strategy: { id: claim.id.toString(), salt: toHex(claim.salt), code: toHex(claim.code), commitment: toHex(claim.commitment), ruleset: claim.ruleset, name: claim.name, source: claim.source },
    receipt,
  };
  return JSON.stringify(file, null, 2) + "\n";
}

/** the owner's key alone, in the form the Solana command line tools read. It holds neither the salt nor the code */
export const keypairText = (owner: Keypair) => JSON.stringify(Array.from(owner.secretKey)) + "\n";

export const ticketFileName = (claim: Claim, sealed: boolean) => `conclave-claim-ticket-${claim.id}${sealed ? "-sealed" : ""}.json`;
export const keypairFileName = (claim: Claim) => `conclave-owner-${claim.owner.publicKey.toBase58().slice(0, 8)}-keypair.json`;

/** reads a ticket and proves it holds together. Its errors say what is wrong and never repeat anything from the file */
export async function parseTicket(text: string): Promise<Opened> {
  const refuse = (why: string): never => { throw new Error(why); };
  if (text.length > MAX_FILE_BYTES) refuse("The file is too large to be a claim ticket.");
  let f: any;
  try { f = JSON.parse(text); } catch { refuse("The file is not valid JSON."); }
  if (Array.isArray(f)) refuse("This is a keypair file, not a claim ticket. Choose the claim ticket: its name begins conclave-claim-ticket.");
  if (f?.kind !== TICKET_KIND) refuse("This file is not a Conclave claim ticket.");
  if (f.version !== TICKET_VERSION) refuse("This claim ticket is of a version this app does not read.");
  if (f.cluster !== "devnet" || f.program !== PROGRAM_ID) refuse("This claim ticket is for another cluster or program.");
  if (f.status !== "prepared" && f.status !== "sealed") refuse("The ticket's status is not one this app knows.");

  const secret = f.owner?.secretKey;
  if (!Array.isArray(secret) || secret.length !== 64 || !secret.every((n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 255)) refuse("The ticket's owner key is not a 64-number secret key.");
  let owner!: Keypair;
  try { owner = Keypair.fromSecretKey(Uint8Array.from(secret)); } catch { refuse("The ticket's owner key is damaged."); }
  if (owner.publicKey.toBase58() !== f.owner.publicKey) refuse("The ticket's owner address does not belong to its secret key.");

  const s = f.strategy;
  if (typeof s?.id !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(s.id) || BigInt(s.id) > BigInt("18446744073709551615")) refuse("The ticket's strategy number is not valid.");
  if (typeof s.salt !== "string" || !/^[0-9a-f]{64}$/.test(s.salt)) refuse("The ticket's salt is not 32 bytes.");
  if (typeof s.code !== "string" || !/^([0-9a-f]{2}){4,}$/.test(s.code) || s.code.length > MAX_CODE_BYTES * 2) refuse("The ticket's code is not a program.");
  if (typeof s.source !== "string" || !Number.isInteger(s.ruleset) || typeof f.createdAt !== "string") refuse("The ticket is incomplete.");
  const claim: Claim = { createdAt: f.createdAt, owner, id: BigInt(s.id), salt: fromHex(s.salt), code: fromHex(s.code), commitment: fromHex(typeof s.commitment === "string" ? s.commitment : ""), source: s.source, name: typeof s.name === "string" ? s.name : null, ruleset: s.ruleset };
  if (!sameBytes(await codeCommitment(claim.salt, claim.code), claim.commitment)) refuse("The ticket's commitment does not match its salt and code.");

  const r = f.receipt;
  if (f.status === "sealed" && !(r && typeof r.sealedAt === "string" && r.transactions && Array.isArray(r.checks))) refuse("The ticket says it is sealed but its receipt is missing.");
  return { claim, status: f.status, receipt: f.status === "sealed" ? (r as Receipt) : null };
}

/** whether a ticket read back from disk is the one for what is in memory: the same key, number, salt, code and commitment */
export function sameClaim(a: Claim, b: Claim): boolean {
  return sameBytes(a.owner.secretKey, b.owner.secretKey) && a.id === b.id && sameBytes(a.salt, b.salt) && sameBytes(a.code, b.code) && sameBytes(a.commitment, b.commitment);
}
