// What base's transaction history says happened to a receipt: when it was created, who delegated it to which validator, when its bond was released. This is the RPC's account of history, NOT something
// the receipt proves: a node can have pruned it, and a dishonest node could misreport it.
import { ANY_VALIDATOR } from "./chain.mjs";
import bs58 from "bs58";

/** the instructions of one transaction, top level and inner, in which OUR program acts on this account */
export function receiptEvents(tx, signature, address, program) {
  if (!tx || tx.meta?.err) return [];
  const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(x => x.instructions)];
  const out = [];
  for (const ix of all) {
    if (keys[ix.programIdIndex] !== program) continue;
    const acc = ix.accounts.map(i => keys[i]), data = Buffer.from(bs58.decode(ix.data)); const at = { signature, slot: tx.slot, time: tx.blockTime ?? null };
    // InitReceipt [payer, receipt, system]
    if (data[0] === 16 && acc[1] === address) out.push({ ...at, type: "created" });
    // Delegate, kind 2 [payer, system, account, owner program, buffer, record, metadata, delegation program, validator?]
    else if (data[0] === 2 && data[1] === 2 && acc[2] === address) out.push({ ...at, type: "delegated", by: acc[0], validator: acc[8] ?? null });
    // ReleaseBond [anyone, receipt, creator]
    else if (data[0] === 18 && acc[1] === address) out.push({ ...at, type: "bond-released" });
  }
  return out;
}

/** every successful transaction naming the address, with the events in the ones not already examined. `known` is {examined: [signature], events: []} from an earlier run */
export async function readHistory(source, address, program, known = { examined: [], events: [] }) {
  const seen = new Set(known.examined); const examined = [...known.examined], events = [...known.events]; const fresh = [];
  // `newest` is the newest signature of any kind an earlier read saw: asking for what came after it fetches only what is new
  let before, complete = true, newest = known.newest ?? null;
  for (let page = 0; ; page++) {
    const sigs = await source.signatures(address, before, known.newest ?? undefined); if (page === 0 && sigs.length) newest = sigs[0].signature;
    for (const s of sigs) if (!s.err && !seen.has(s.signature)) fresh.push(s);
    if (sigs.length < 1000) break; before = sigs.at(-1).signature; if (page >= 4) { complete = false; break; }
  }
  for (const s of fresh.reverse()) { const tx = await source.transaction(s.signature); if (!tx) { complete = false; continue; } events.push(...receiptEvents(tx, s.signature, address, program)); examined.push(s.signature); }
  events.sort((a, b) => a.slot - b.slot);
  return { examined, events, complete, newest: complete ? newest : known.newest ?? null };
}

/** The validator is a TRUST INPUT. The creator chooses it, it is what writes the receipt's results back to base, and the receipt does not record it. This reports what could be observed, and from where */
export function validatorOf(history, observed = []) {
  const note = "chosen by the creator and not recorded on the receipt. Treat it as something you decide to trust, not something the receipt proves";
  const fromTx = history ? [...new Set(history.events.filter(e => e.type === "delegated").map(e => e.validator ?? "unnamed"))] : [];
  const fromRecord = [...new Set(observed.map(o => o.validator))];
  const all = [...new Set([...fromTx, ...fromRecord])];
  const sources = [...(fromTx.length ? ["base transaction history"] : []), ...(fromRecord.length ? ["delegation record, seen while the receipt was delegated"] : [])];
  if (all.length === 0) return { key: null, status: "unknown", sources, note };
  if (all.includes("unnamed") || all.includes(ANY_VALIDATOR)) return { key: null, status: "unnamed: the delegation does not restrict which validator may commit", sources, note };
  if (all.length > 1) return { key: null, status: "conflicting", candidates: all, sources, note };
  return { key: all[0], status: "observed", sources, note };
}
