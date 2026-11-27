// Sealing, with a temporary key as the owner. The key signs everything here, in this browser; no wallet is asked for anything. What leaves the browser:
//   /api/drip     the key's PUBLIC address
//   Solana devnet  two signed transactions (Register, Delegate), which hold the commitment and not the code
//   the enclave    a signature over its login text, then the signed Seal, which holds the salt and code; and reads carrying the login token in a header
// Every step first asks the chain whether it is already done, so running again, after a failure or from a saved ticket, carries on from where it stopped.
import { Buffer } from "buffer";
import { ed25519 } from "@noble/curves/ed25519";
import { Connection, PublicKey, type Transaction } from "@solana/web3.js";
import {
  BASE_RPC, TEE_RPC, DELEGATION_PROGRAM, PROGRAM, computeLimit, delegateInstruction, enclaveLogin, parseSealed, registerInstruction,
  registryAddress, sealAddresses, sealInstruction, sealedAddress, transactionOf,
} from "./chain";
import { toHex, type Check, type Claim, type Receipt } from "./ticket";

export const STEPS = ["fund", "register", "delegate", "login", "seal", "verify"] as const;
export type StepId = (typeof STEPS)[number];
export type StepReport = { state: "working" | "done"; detail: string; signature?: string | null };

/** a key that has not registered needs the two payments (6,261,520 lamports, measured) and enough left over to stay rent-exempt */
const NEEDS_FOR_ALL = 7_000_000;
/** with the registry already paid for, only the delegation (2,956,040 measured) and the same margin */
const NEEDS_TO_DELEGATE = 3_700_000;

export const CHECK_NAMES = {
  owner: "The sealed account's owner is your temporary key.",
  id: "The strategy number matches.",
  commitment: "The public commitment matches.",
  salt: "The salt reads back exactly.",
  code: "The code reads back exactly.",
  withheld: "The sealed account is withheld without a valid login, and a forged token gets 401.",
} as const;

export class SealError extends Error {
  /** retryable: trying again may work. It is false where the same request would be refused again today */
  constructor(public step: StepId, message: string, public retryable = true) {
    super(message);
  }
}

/** what a run learns and keeps for the next one */
export type Progress = { signatures: Receipt["transactions"]; funded: boolean };
export const freshProgress = (): Progress => ({ signatures: { funding: null, register: null, delegate: null, seal: null }, funded: false });

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Rpc = { status: number; body: { result?: any; error?: unknown } | null };
/** one JSON-RPC call to the rollup. A token travels in a header, never in the address */
async function rollupCall(method: string, params: unknown[], token?: string): Promise<Rpc> {
  const response = await fetch(TEE_RPC, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: response.status, body: await response.json().catch(() => null) };
}
async function rollup<T>(method: string, params: unknown[] = [], token?: string): Promise<T> {
  const { status, body } = await rollupCall(method, params, token);
  if (!body || body.error !== undefined || body.result === undefined) throw new Error(`the rollup did not answer ${method} (HTTP ${status}${body?.error ? ", " + JSON.stringify(body.error).slice(0, 120) : ""})`);
  return body.result as T;
}
async function rollupAccount(address: PublicKey, token: string) {
  const r = await rollup<{ value: { lamports: number; data: [string, string] } | null }>("getAccountInfo", [address.toBase58(), { encoding: "base64" }], token);
  return r.value ? { lamports: r.value.lamports, data: new Uint8Array(Buffer.from(r.value.data[0], "base64")) } : null;
}

/** a copy of a real token with one character of its end changed: a forgery, which the enclave must refuse */
function forge(token: string) {
  const at = token.length - 12;
  return token.slice(0, at) + (token[at] === "A" ? "B" : "A") + token.slice(at + 1);
}

/** Asks for the account with no login and with a forged one. It passes only on answers that show it was withheld; a request that failed to get an
 *  answer proves nothing and is an error to try again, never a pass */
async function withheld(sealed: PublicKey, token: string): Promise<boolean> {
  const params = [sealed.toBase58(), { encoding: "base64" }];
  const bare = await rollupCall("getAccountInfo", params);
  const forged = await rollupCall("getAccountInfo", params, forge(token));
  const bareAnswered = bare.status === 401 || (bare.status === 200 && bare.body?.result !== undefined);
  if (!bareAnswered) throw new Error(`the no-login request got no usable answer (HTTP ${bare.status})`);
  if (forged.status !== 401 && forged.status !== 200) throw new Error(`the forged-token request got no usable answer (HTTP ${forged.status})`);
  return !bare.body?.result?.value && forged.status === 401;
}

type Drip = { status?: string; signature?: string; error?: { code?: string; message?: string; retryable?: boolean } };

export async function seal(claim: Claim, progress: Progress, report: (step: StepId, r: StepReport) => void): Promise<Receipt> {
  const base = new Connection(BASE_RPC, "confirmed");
  const owner = claim.owner.publicKey;
  const registry = registryAddress(claim.id);
  const sealed = sealedAddress(claim.id);
  let step: StepId = "fund";
  const working = (detail: string) => report(step, { state: "working", detail });
  const done = (detail: string, signature?: string | null) => report(step, { state: "done", detail, signature });

  const readRegistry = async () => {
    const account = await base.getAccountInfo(registry, "confirmed");
    if (!account) return null;
    // delegated or not, base keeps the data: it must be this owner's and this commitment, or the number is taken
    if (account.data.length >= 80 && (!new PublicKey(account.data.subarray(8, 40)).equals(owner) || toHex(account.data.subarray(48, 80)) !== toHex(claim.commitment))) throw new SealError(step, "This strategy number is registered to something else. Start again with a new key.", false);
    return account;
  };
  const sendToSolana = async (instruction: Transaction["instructions"][number]) => {
    const { blockhash, lastValidBlockHeight } = await base.getLatestBlockhash("confirmed");
    const tx = transactionOf(owner, blockhash, instruction);
    tx.sign(claim.owner);
    const signature = await base.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    const result = await base.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (result.value.err) throw new Error(`the transaction failed on devnet: ${JSON.stringify(result.value.err)}`);
    return signature;
  };

  try {
    // 1. funds
    working("Checking what the temporary key holds.");
    const registered = await readRegistry();
    const needs = !registered ? NEEDS_FOR_ALL : registered.owner.equals(PROGRAM) ? NEEDS_TO_DELEGATE : 0;
    let balance = await base.getBalance(owner, "confirmed");
    if (balance > 0 || registered) progress.funded = true;
    if (balance >= needs) done(needs === 0 ? "Nothing more to pay." : "The temporary key is already funded.", progress.signatures.funding);
    else {
      working("Asking the site to send the temporary key devnet SOL. Only its public address is sent.");
      let response: Response, answer: Drip | null;
      try {
        response = await fetch("/api/drip", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pubkey: owner.toBase58() }) });
        answer = (await response.json().catch(() => null)) as Drip | null;
      } catch { throw new SealError(step, "The funding request could not be sent. Check your connection and try again."); }
      if (!response.ok || (answer?.status !== "funded" && answer?.status !== "already-funded")) throw new SealError(step, answer?.error?.message ?? "The funding service gave no usable answer.", answer?.error?.retryable ?? true);
      if (answer.status === "funded") progress.signatures.funding = answer.signature ?? null;
      progress.funded = true;
      working("Funded. Waiting for the public devnet node to show it.");
      for (let i = 0; i < 40 && (balance = await base.getBalance(owner, "confirmed")) < needs; i++) await wait(1500);
      if (balance < needs) throw new SealError(step, "The funds were sent but the public devnet node does not show them yet. Try again shortly.");
      done("The temporary key is funded.", progress.signatures.funding);
    }

    // 2. register
    step = "register";
    working("Putting the commitment on Solana devnet.");
    if (await readRegistry()) done("The registry is on chain.", progress.signatures.register);
    else {
      progress.signatures.register = await sendToSolana(registerInstruction(owner, claim.id, claim.commitment));
      done("Registered.", progress.signatures.register);
    }

    // 3. delegate
    step = "delegate";
    working("Handing the registry to the private rollup.");
    const { identity } = await rollup<{ identity: string }>("getIdentity");
    const now = await readRegistry();
    if (now?.owner.equals(DELEGATION_PROGRAM)) done("The registry is delegated.", progress.signatures.delegate);
    else {
      progress.signatures.delegate = await sendToSolana(delegateInstruction(owner, claim.id, new PublicKey(identity)));
      done("Delegated.", progress.signatures.delegate);
    }

    // 4. log in. The token lives in this variable and nowhere else
    step = "login";
    working("Signing the enclave's login text with the temporary key.");
    const { token } = await enclaveLogin(TEE_RPC, owner, async message => ed25519.sign(message, claim.owner.secretKey.slice(0, 32)));
    done("Logged in to the enclave.");

    // 5. seal
    step = "seal";
    working("Waiting for the rollup to hold the registry.");
    if (await rollupAccount(sealed, token)) done("The strategy is sealed.", progress.signatures.seal);
    else {
      let held = await rollupAccount(registry, token);
      for (let i = 0; !held && i < 60; i++) { await wait(1000); held = await rollupAccount(registry, token); }
      if (!held) throw new SealError(step, "The rollup does not show the delegated registry yet. Try again shortly.");
      working("Sending the code and salt into the private rollup.");
      const { value } = await rollup<{ value: { blockhash: string } }>("getLatestBlockhash", [], token);
      const tx = transactionOf(owner, value.blockhash, computeLimit(), sealInstruction(owner, claim.id, claim.salt, claim.code, sealAddresses(sealed)));
      tx.sign(claim.owner);
      const signature = await rollup<string>("sendTransaction", [tx.serialize().toString("base64"), { encoding: "base64", skipPreflight: true }], token);
      let landed = false;
      for (let i = 0; !landed && i < 150; i++) {
        const status = (await rollup<{ value: ({ confirmationStatus?: string; err: unknown } | null)[] }>("getSignatureStatuses", [[signature]], token)).value[0];
        if (status?.confirmationStatus) {
          if (status.err) throw new SealError(step, `The rollup ran the Seal and it failed: ${JSON.stringify(status.err)}`);
          landed = true;
        } else await wait(200);
      }
      if (!landed) throw new SealError(step, "The rollup did not confirm the Seal. Try again: it is not sealed twice.");
      progress.signatures.seal = signature;
      done("Sealed.", signature);
    }

    // 6. read it back
    step = "verify";
    working("Reading the sealed account back, and asking for it without a valid login.");
    const own = await rollupAccount(sealed, token);
    if (!own) throw new SealError(step, "The sealed account was not returned to its owner. Try again.");
    const read = parseSealed(own.data);
    const checks: Check[] = [
      { name: CHECK_NAMES.owner, ok: read.owner.equals(owner) },
      { name: CHECK_NAMES.id, ok: read.id === claim.id },
      { name: CHECK_NAMES.commitment, ok: toHex(read.commitment) === toHex(claim.commitment) },
      { name: CHECK_NAMES.salt, ok: toHex(read.salt) === toHex(claim.salt) },
      { name: CHECK_NAMES.code, ok: toHex(read.code) === toHex(claim.code) },
      { name: CHECK_NAMES.withheld, ok: await withheld(sealed, token) },
    ];
    const failed = checks.filter(c => !c.ok);
    if (failed.length) throw new SealError(step, `A check did not pass: ${failed.map(c => c.name).join(" ")}`);
    done("All six checks pass.");
    return { sealedAt: new Date().toISOString(), registry: registry.toBase58(), sealedAccount: sealed.toBase58(), validator: identity, transactions: { ...progress.signatures }, checks };
  } catch (e) {
    if (e instanceof SealError) throw e;
    const text = reason(e);
    throw new SealError(step, /429|Too Many Requests/i.test(text) ? "The public devnet node is limiting requests. Wait a moment and try again." : /Failed to fetch|NetworkError|fetch failed/i.test(text) ? "A network request failed. Check your connection and try again." : text.slice(0, 300));
  }
}
