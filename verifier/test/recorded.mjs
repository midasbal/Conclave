// A source that remembers what a real RPC answered, and one that plays those answers back. The fixtures under test/fixtures are devnet responses saved this way (public data only).
// Transactions are cut down to the fields the verifier reads. Nothing in them is invented or edited.
export function recorder(source) {
  const tape = { accounts: {}, signatures: {}, transactions: {}, listed: {} };
  const pack = a => a ? { owner: a.owner, lamports: a.lamports, slot: a.slot, data: a.data.toString("base64") } : null;
  return { tape, host: source.host,
    async genesisHash() { return (tape.genesis = await source.genesisHash()); },
    async receiptsOwnedBy(owner) { const r = await source.receiptsOwnedBy(owner); tape.listed[owner] = r.map(x => x.address); for (const x of r) tape.accounts[x.address] = pack(x); return r; },
    async account(a) { const r = await source.account(a); tape.accounts[a] = pack(r); return r; },
    async signatures(a, before) { const r = await source.signatures(a, before); tape.signatures[a + (before ? " " + before : "")] = r.map(({ signature, slot, blockTime, err }) => ({ signature, slot, blockTime, err })); return r; },
    async transaction(sig) { const t = await source.transaction(sig); tape.transactions[sig] = t && { slot: t.slot, blockTime: t.blockTime, transaction: { message: { accountKeys: t.transaction.message.accountKeys, instructions: t.transaction.message.instructions.map(({ programIdIndex, accounts, data }) => ({ programIdIndex, accounts, data })) } }, meta: { err: t.meta.err, loadedAddresses: t.meta.loadedAddresses, innerInstructions: (t.meta.innerInstructions ?? []).map(x => ({ instructions: x.instructions.map(({ programIdIndex, accounts, data }) => ({ programIdIndex, accounts, data })) })) } }; return t; },
  };
}
export function replay(tape, only = null) {
  const unpack = a => a ? { owner: a.owner, lamports: a.lamports, slot: a.slot, data: Buffer.from(a.data, "base64") } : null;
  const need = (map, k, what) => { if (!(k in map)) throw new Error(`the recording has no ${what} ${k}`); return map[k]; };
  return { host: "recorded devnet responses",
    async genesisHash() { return tape.genesis; },
    async receiptsOwnedBy(owner) { return (tape.listed[owner] ?? []).filter(a => !only || only.includes(a)).map(a => ({ address: a, ...unpack(tape.accounts[a]) })); },
    async account(a) { return unpack(need(tape.accounts, a, "account")); },
    async signatures(a, before) { return need(tape.signatures, a + (before ? " " + before : ""), "signature list for"); },
    async transaction(s) { return need(tape.transactions, s, "transaction"); },
  };
}
