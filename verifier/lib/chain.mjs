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
/** The reads the record builder needs, always at FINALIZED commitment. Anything with these methods can stand in as a source (the tests replay recorded devnet responses) */
export function rpcSource(url = DEFAULT_RPC, { pause = 250, retries = 6 } = {}) {
  const host = new URL(url).host; let last = 0;
  async function call(method, params) {
    for (let attempt = 0; ; attempt++) {
      const wait = last + pause - Date.now(); if (wait > 0) await sleep(wait); last = Date.now();
      let status = 0, body;
      try { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) }); status = r.status; body = await r.json(); }
      catch (e) { if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; } throw new Error(`${method} on ${host}: no usable answer (HTTP ${status || "none"}, ${e.name})`); }
      if (status === 429 || status >= 500) { if (attempt < retries) { await sleep(1000 * 2 ** attempt); continue; } }
      if (body.error) throw new Error(`${method} on ${host}: ${String(body.error.message ?? body.error.code).slice(0, 160)}`);
      return body.result;
    }
  }
  const account = (a, slot) => a ? { owner: a.owner, lamports: a.lamports, data: Buffer.from(a.data[0], "base64"), slot } : null;
  const byMagic = async owner => { const r = await call("getProgramAccounts", [owner, { encoding: "base64", commitment: "finalized", withContext: true, filters: [{ memcmp: { offset: 0, bytes: key58(RECEIPT_MAGIC) } }] }]); return r.value.map(x => ({ address: x.pubkey, ...account(x.account, r.context.slot) })); };
  return {
    host,
    genesisHash: () => call("getGenesisHash", []),
    receiptsOwnedBy: byMagic,
    async account(address) { const r = await call("getAccountInfo", [address, { encoding: "base64", commitment: "finalized" }]); return r.value ? account(r.value, r.context.slot) : null; },
    signatures: (address, before) => call("getSignaturesForAddress", [address, { limit: 1000, commitment: "finalized", ...(before ? { before } : {}) }]),
    transaction: signature => call("getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 1 }]),
  };
}
