// Prints, as JSON, the instructions the CLIENT's own builders (client/flows.mjs) produce for a fixed set of keys. tests/svm/tests/client_flows.rs runs them against the real program bytecode,
// so a wrong account order, flag or data layout in the client fails a test instead of a devnet run. No network, no key files: the caller supplies throwaway test keys.
// usage: CONCLAVE_PROGRAM_ID=.. CONCLAVE_SIGNER='[..]' CONCLAVE_OUT=.. node tests/client_ix.mjs '{"sid":"..","mint":"..","players":[..],"strategies":[{"owner":0,"id":".."}]}'
const input = JSON.parse(process.argv[2]);
const L = await import("../client/lib.mjs"); const F = await import("../client/flows.mjs"); const C = await import("../client/custody.mjs");
const mint = new L.PublicKey(input.mint); const players = input.players.map(p => ({ publicKey: new L.PublicKey(p) }));
const c = { mint, players, hub: L.hubPda(), validator: L.O.publicKey, ata(o) { return L.getAssociatedTokenAddressSync(mint, o, true); } };
const sid = BigInt(input.sid); const entries = input.strategies.map(s => ({ owner: s.owner, id: BigInt(s.id) }));
const json = ix => ({ data: Buffer.from(ix.data).toString("hex"), keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), s: k.isSigner, w: k.isWritable })) });
// CloseStrategy can only be built from a verified recovery bundle: make one for each strategy from the REAL program's sealed and registry accounts (given by the caller), written to disk, reopened and checked
const GENESIS = "11111111111111111111111111111111"; // the in-process SVM has no genesis hash; any fixed value, the same on both sides
const tickets = entries.map((e, i) => C.exportForClose({ file: input.bundleDir + "/" + e.id + C.BUNDLE_EXT, passphrase: input.passphrase, program: L.PROGRAM.toBase58(), cluster: { name: "svm", genesisHash: GENESIS }, id: e.id, owner: players[e.owner].publicKey.toBase58(), sealedData: Buffer.from(input.accounts[i].sealed, "hex"), registryData: Buffer.from(input.accounts[i].registry, "hex") }));
const out = {
  create: json(F.createSeasonIx(c, sid, { neps: 15, fee: 10, finals: true, division: 2, window: 1_000_000, seedTimeout: 1_000_000, grace: 1_000_000, minEntrants: 1 })),
  enter: entries.map(e => json(F.enterIx(c, sid, e.owner, e.id))), lock: json(F.lockIx(sid)), seed: json(F.seedIx(sid)), advance: json(F.advIx(sid, 1400)),
  settle: json(F.settleIx(c, sid, entries.map(e => e.id))), cancel: json(F.cancelIx(c, sid)), claim: entries.map((e, i) => json(F.claimIx(c, sid, i, players[e.owner].publicKey))),
  claimReadOnly: json(F.claimIx(c, sid, 0, players[entries[0].owner].publicKey, true)), publish: entries.map((e, i) => json(F.publishIx(sid, i, e.id))), closeClaims: json(F.closeClaimsIx(c, sid)), cleanup: json(F.cleanupIx(c, sid)),
  cancelReleasing: json(F.cancelIx(c, sid, L.O.publicKey, entries.map(e => e.id))), cleanupNaming: json(F.cleanupIx(c, sid, entries.map(e => e.id))),
  closeStrategy: entries.map((e, i) => json(F.closeStrategyIx(c, players[e.owner].publicKey, e.id, tickets[i]))), bundles: tickets.map(t => t.file), undelegateRegs: json(F.commitUndelegateIx(entries.map(e => L.regPda(e.id)))), closeRegistry: entries.map(e => json(F.closeRegistryIx(e.id, players[e.owner].publicKey))),
  claimsPda: L.claimsPda(sid).toBase58(), scoreCommit: L.scoreCommit(Buffer.alloc(32, 7), sid, 5n, -123n, 456n, 2, 15).toString("hex"),
};
process.stdout.write(JSON.stringify(out));
