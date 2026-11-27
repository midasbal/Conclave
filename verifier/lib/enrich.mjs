// Two facts a season's receipt does not carry, recovered from public base data and stored beside the record. Neither is proof of anything about the season; both say where they came from, and "unknown" is a real answer.
//   stake token   the mint the entry fees are paid in. The receipt holds the fee as a bare number. The mint is named once, in the season's InitPool transaction on base.
//   registry      whether a strategy has been closed. The registry is public on base; CloseStrategy marks it closed and CloseRegistry later shrinks it to a permanent marker.
import { poolAddress, registryAddress, DELEGATION_PROGRAM_ID, RECEIPT_MAGIC } from "./chain.mjs";
import { poolEvents } from "./history.mjs";

export const REG_MAGIC = 0x5245_4753, REG_CLOSED_MAGIC = 0x5845_4752, REG_DEAD_MAGIC = 0x4447_4552, REG_SIZE = 128, MARKER_SIZE = 8;

/** the season's stake token from its InitPool transaction. `null` if base history holds none. Throws RateLimited (and anything else the caller must not mistake for "none") */
export async function readPoolMint(source, program, season) {
  const pool = poolAddress(season, program); const sigs = await source.signatures(pool);
  let unserved = 0;
  for (const s of [...sigs].reverse()) { if (s.err) continue; const tx = await source.transaction(s.signature); if (!tx) { unserved++; continue; } const e = poolEvents(tx, s.signature, pool, program)[0]; if (e) return e; }
  if (unserved) throw new Error(`base did not serve ${unserved} listed transaction(s) of the pool, so whether it holds an InitPool is not known`); // never "there is none" when part of it was not seen
  return null;
}
export function stakeToken(found, problem = null) {
  if (found?.mint) return { mint: found.mint, status: "observed", source: `the season's InitPool transaction on base (${found.signature})`, note: "recovered from base history, not from the receipt: it relies on the RPC still serving that transaction" };
  return { mint: null, status: "unknown", source: null, note: problem ?? "no InitPool transaction was found for this season (a season abandoned before its pool was made has no stake token to name), so the unit of its fee is unknown" };
}

/** what a registry account on base says about its strategy */
export function classifyRegistry(account, program) {
  if (!account) return { status: "unknown", closed: null, delegated: false, note: "no registry account on base" };
  const d = account.data, magic = d.length >= 4 ? d.readUInt32LE(0) : null, delegated = account.owner === DELEGATION_PROGRAM_ID;
  if (account.owner !== program && !delegated) return { status: "unknown", closed: null, delegated: false, note: "the account at the registry address is not the program's" };
  if (account.owner === program && d.length === MARKER_SIZE && magic === REG_DEAD_MAGIC) return { status: "retired", closed: true, delegated: false, note: "the strategy was closed and its registry removed; only a permanent marker is left" };
  if (magic === REG_CLOSED_MAGIC) return { status: "closed", closed: true, delegated, note: "the strategy was closed; its registry is waiting to be removed" };
  if (magic === REG_MAGIC && d.length >= REG_SIZE) return { status: "open", closed: false, delegated, note: delegated ? "the registry is delegated to the rollup, so base shows it as it was when delegated: a close done in the rollup is not visible here until the registry returns to base" : "the strategy has not been closed" };
  return { status: "unknown", closed: null, delegated, note: "the registry could not be read" };
}

/** statuses for strategy ids. `source.accounts` reads them in batches when the source has it. A failure other than a rate limit leaves the status unknown instead of failing the cycle */
/** strict (the capture loop): a registry that cannot be read is an error, so that nothing already known is overwritten with "unknown" and the failure shows. Without it (the one-shot builder) such a registry is recorded as "unknown", which says so in the record */
export async function readRegistryStatuses(source, program, ids, { strict = false } = {}) {
  const out = {}; const addrs = ids.map(id => registryAddress(id, program));
  let got = null; try { got = source.accounts ? await source.accounts(addrs) : null; } catch (e) { if (e.name === "RateLimited") throw e; }
  for (const [i, id] of ids.entries()) {
    let a = got?.[i], failed = false; // no batch read (or it failed): ask one by one, and keep what can be read
    if (got === null) { try { a = await source.account(addrs[i]); } catch (e) { if (e.name === "RateLimited") throw e; if (strict) throw new Error(`reading the strategy registries: ${e.message}`); failed = true; } }
    out[id] = failed ? { status: "unknown", closed: null, delegated: false, slot: null, note: "the registry could not be read" } : { ...classifyRegistry(a, program), slot: a?.slot ?? null };
  }
  return out;
}
