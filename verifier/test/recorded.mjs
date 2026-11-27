// A source that remembers what a real RPC answered, and one that plays those answers back. The fixtures under test/fixtures are devnet responses saved this way (public data only).
// Transactions are cut down to the fields the verifier reads. Nothing in them is invented or edited.
import fs from "fs";
export function recorder(source) {
  const tape = { accounts: {}, signatures: {}, transactions: {}, listed: {} };
  const pack = a => a ? { owner: a.owner, lamports: a.lamports, slot: a.slot, data: a.data.toString("base64") } : null;
  return { tape, host: source.host,
    async genesisHash() { return (tape.genesis = await source.genesisHash()); },
    async receiptsOwnedBy(owner) { const r = await source.receiptsOwnedBy(owner); tape.listed[owner] = r.map(x => x.address); for (const x of r) tape.accounts[x.address] = pack(x); return r; },
    async account(a) { const r = await source.account(a); tape.accounts[a] = pack(r); return r; },
    async signatures(a, before) { const r = await source.signatures(a, before); tape.signatures[a + (before ? " " + before : "")] = r.map(({ signature, slot, blockTime, err }) => ({ signature, slot, blockTime, err })); return r; },
    async accounts(addrs) { const r = await source.accounts(addrs); addrs.forEach((a, i) => { tape.accounts[a] = pack(r[i]); }); return r; },
    async transaction(sig) { const t = await source.transaction(sig); tape.transactions[sig] = t && { slot: t.slot, blockTime: t.blockTime, transaction: { message: { accountKeys: t.transaction.message.accountKeys, instructions: t.transaction.message.instructions.map(({ programIdIndex, accounts, data }) => ({ programIdIndex, accounts, data })) } }, meta: { err: t.meta.err, loadedAddresses: t.meta.loadedAddresses, innerInstructions: (t.meta.innerInstructions ?? []).map(x => ({ instructions: x.instructions.map(({ programIdIndex, accounts, data }) => ({ programIdIndex, accounts, data })) })) } }; return t; },
  };
}
/** the older recordings (devnet-all and the staged ones) were made before the verifier read strategy registries, so they hold none. This lends them the registry answers of the later devnet-api recording: real devnet responses, read LATER than the rest of the tape.
 *  Only a lookup the tape itself cannot answer is taken from there; its listings, receipts and slot are untouched. A lookup in neither recording still fails. */
export function withRecordedRegistries(tape) {
  const later = JSON.parse(fs.readFileSync(new URL("./fixtures/devnet-api.json", import.meta.url))); const receipts = new Set(Object.values(later.listed).flat());
  return { ...tape, registryAccounts: Object.fromEntries(Object.entries(later.accounts).filter(([a]) => !receipts.has(a) && !(a in tape.accounts))) };
}
export function replay(tape, only = null) {
  const unpack = a => a ? { owner: a.owner, lamports: a.lamports, slot: a.slot, data: Buffer.from(a.data, "base64") } : null;
  const need = (map, k, what) => { if (!(k in map)) throw new Error(`the recording has no ${what} ${k}`); return map[k]; };
  const known = a => a in tape.accounts ? tape.accounts[a] : need(tape.registryAccounts ?? {}, a, "account");
  return { host: "recorded devnet responses",
    async genesisHash() { return tape.genesis; },
    async receiptsOwnedBy(owner) { const out = (tape.listed[owner] ?? []).filter(a => !only || only.includes(a)).map(a => ({ address: a, ...unpack(tape.accounts[a]) })); out.contextSlot = out.length ? Math.max(...out.map(x => x.slot ?? 0)) : null; return out; },
    async account(a) { return unpack(known(a)); },
    async accounts(addrs) { return addrs.map(a => unpack(known(a))); },
    async signatures(a, before, until) { return need(tape.signatures, a + (before ? " " + before : ""), "signature list for"); },
    async slot() { return Math.max(...Object.values(tape.accounts).filter(Boolean).map(x => x.slot ?? 0)); },
    async transaction(s) { return need(tape.transactions, s, "transaction"); },
  };
}
