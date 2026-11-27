// Constants, address derivation and a read-only JSON-RPC client. No keys, no signing, no transactions: nothing here can change the chain.
// The RPC URL may carry a provider's credential, so it is never printed or stored: only its host name is ever shown.
import { PublicKey } from "@solana/web3.js"; import bs58 from "bs58"; import crypto from "crypto";

export const PROGRAM_ID = "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne";
export const DELEGATION_PROGRAM_ID = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const DEFAULT_RPC = "https://api.devnet.solana.com";
export const RECEIPT_MAGIC = Buffer.from("RPCT");
export const ANY_VALIDATOR = "11111111111111111111111111111111";

export const key58 = bytes => bs58.encode(bytes);
export const unkey58 = s => Buffer.from(bs58.decode(s));
export const sha256 = (...parts) => crypto.createHash("sha256").update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest();
export const u64le = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const find = (seeds, program) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();
/** the only address a season's receipt can live at */
export const receiptAddress = (season, program) => find([Buffer.from("receipt"), u64le(season)], program);
/** the delegation program's own record of an account it holds: who owned it before, and which validator may commit it */
export const delegationRecordAddress = address => find([Buffer.from("delegation"), unkey58(address)], DELEGATION_PROGRAM_ID);

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** how fast to read, and how long to stay away after a refusal. The rollup (TEE) endpoints have banned this client for hurrying, so they are paced four times slower and a refusal keeps us away ten minutes */
export const rpcDefaults = host => /tee/i.test(host) ? { pause: 1000, banMs: 10 * 60_000 } : { pause: 250, banMs: 60_000 };
/** thrown, and never sent past, once an endpoint has said "too many requests" or has banned this client. `retryAt` is when reading may resume */
export class RateLimited extends Error { constructor(host, retryAt, why) { super(`${host} is rate limiting this client (${why}); no request will be sent before ${new Date(retryAt).toISOString()}`); this.name = "RateLimited"; this.retryAt = retryAt; } }
/** The reads the record builder needs, always at FINALIZED commitment. Anything with these methods can stand in as a source (the tests replay recorded devnet responses).
 *  Pacing: one request at a time, at least `pause` ms apart with some jitter (the rollup endpoints that ban a client that hurries are paced four times slower by default). A 429, or an answer that says "banned",
 *  opens a breaker: for `Retry-After` (or a long default) every call fails at once WITHOUT touching the network, so a loop that keeps trying cannot make a ban worse. */
export function rpcSource(url = DEFAULT_RPC, { pause, retries = 4, timeoutMs = 60_000, banMs } = {}) {
  const host = new URL(url).host; const d = rpcDefaults(host); pause ??= d.pause; banMs ??= d.banMs; let last = 0, blockedUntil = 0, sent = 0;
  async function call(method, params) {
    for (let attempt = 0; ; attempt++) {
      if (Date.now() < blockedUntil) throw new RateLimited(host, blockedUntil, "backing off");
      const wait = last + pause * (0.9 + Math.random() * 0.2) - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
      let status = 0, text = "", retryAfter = null;
      try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) }); status = r.status; retryAfter = r.headers.get("retry-after"); text = await r.text(); sent++; }
      catch (e) { if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; } throw new Error(`${method} on ${host}: no usable answer (${e.name})`); }
      if (status === 429 || /banned|temporarily blocked/i.test(text.slice(0, 300))) { const ms = retryAfter && /^\d+$/.test(retryAfter) ? Math.min(+retryAfter * 1000, 6 * 3600_000) : banMs; blockedUntil = Date.now() + ms; throw new RateLimited(host, blockedUntil, status === 429 ? "HTTP 429" : "banned"); }
      if (status >= 500) { if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; } throw new Error(`${method} on ${host}: HTTP ${status}`); }
      let body; try { body = JSON.parse(text); } catch { throw new Error(`${method} on ${host}: HTTP ${status}, not JSON`); }
      if (body.error) throw new Error(`${method} on ${host}: ${String(body.error.message ?? body.error.code).slice(0, 160)}`);
      return body.result;
    }
  }
  const account = (a, slot) => a ? { owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data[0], "base64"), slot } : null;
  const byMagic = async owner => { const r = await call("getProgramAccounts", [owner, { encoding: "base64", commitment: "finalized", withContext: true, filters: [{ memcmp: { offset: 0, bytes: key58(RECEIPT_MAGIC) } }] }]); const out = r.value.map(x => ({ address: x.pubkey, ...account(x.account, r.context.slot) })); out.contextSlot = r.context.slot; return out; };
  return {
    host, get requestsSent() { return sent; }, get blockedUntil() { return blockedUntil; },
    genesisHash: () => call("getGenesisHash", []),
    slot: () => call("getSlot", [{ commitment: "finalized" }]),
    receiptsOwnedBy: byMagic,
    async account(address) { const r = await call("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]); return r.value ? account(r.value, r.context.slot) : null; },
    /** newest first. `before` pages backwards; `until` stops at a signature already known, so only NEW signatures are fetched */
    signatures: (address, before, until) => call("getSignaturesForAddress", [address, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}), ...(until ? { until } : {}) }]),
    transaction: signature => call("getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 1 }]),
  };
}
