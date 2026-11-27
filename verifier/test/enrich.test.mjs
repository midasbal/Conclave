// The two facts the record takes from public base data beyond the receipt: the stake token of each season, and whether each strategy is closed. Over the real devnet recording (test/fixtures/devnet-api.json).
// Altered inputs are marked SYNTHETIC.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "fs"; import os from "os"; import path from "path"; import { fileURLToPath } from "url";
import { Ingest } from "../lib/ingest.mjs"; import { buildRecord } from "../lib/builder.mjs"; import { classifyRegistry, readRegistryStatuses, readPoolMint, stakeToken, REG_DEAD_MAGIC, REG_CLOSED_MAGIC } from "../lib/enrich.mjs";
import { poolEvents } from "../lib/history.mjs"; import { PROGRAM_ID, DELEGATION_PROGRAM_ID, DEVNET_GENESIS, poolAddress, registryAddress, RateLimited } from "../lib/chain.mjs"; import { replay } from "./recorded.mjs";
const _made = []; process.on("exit", () => { for (const d of _made) fs.rmSync(d, { recursive: true, force: true }); }); /* every temporary folder this file makes is removed when its process ends */
const here = path.dirname(fileURLToPath(import.meta.url)); const TAPE = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "devnet-api.json"))); const tmp = () => (() => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "enrich-test-")); _made.push(d); return d; })(); const clone = x => JSON.parse(JSON.stringify(x));
const unpack = a => a && { owner: a.owner, lamports: a.lamports, slot: a.slot, data: Buffer.from(a.data, "base64") };
function spy(source) { const calls = { accounts: [], account: [], signatures: [], transaction: [] }; return { calls, host: source.host, genesisHash: () => source.genesisHash(), slot: () => source.slot(), receiptsOwnedBy: o => source.receiptsOwnedBy(o), async account(a) { calls.account.push(a); return source.account(a); }, async accounts(a) { calls.accounts.push(a.length); return source.accounts(a); }, async signatures(...a) { calls.signatures.push(a); return source.signatures(...a); }, async transaction(g) { calls.transaction.push(g); return source.transaction(g); } }; }
const record = await buildRecord(replay(TAPE), { archiveDir: tmp(), now: () => "2026-11-27T05:00:00.000Z" });

test("the stake token of a season is the mint its InitPool transaction names; a season with no pool says it does not know", () => {
  const by = {}; for (const s of record.seasons) (by[s.stakeToken.status] ??= []).push(s); assert.equal(by.observed.length, 23); assert.equal(by.unknown.length, 6);
  for (const s of by.observed) { assert.match(s.stakeToken.mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); assert.match(s.stakeToken.source, /InitPool transaction on base \([1-9A-HJ-NP-Za-km-z]{80,90}\)/); assert.match(s.stakeToken.note, /not from the receipt/); }
  for (const s of by.unknown) { assert.equal(s.stakeToken.mint, null); assert.equal(s.stakeToken.source, null); assert.equal(s.facts.fieldSize, 0, "a season with no entries made no pool"); assert.match(s.stakeToken.note, /abandoned before its pool was made/); }
  assert.equal(new Set(by.observed.map(s => s.stakeToken.mint)).size, 1, "every recorded season pays in the project's one stake token");
});
test("the mint is read from the InitPool instruction's own accounts, and only from a transaction that succeeded", () => {
  const season = record.seasons.find(s => s.stakeToken.status === "observed"); const pool = poolAddress(season.season, PROGRAM_ID); const sig = season.stakeToken.source.match(/\(([^)]+)\)/)[1]; const tx = TAPE.transactions[sig];
  const ev = poolEvents(tx, sig, pool, PROGRAM_ID); assert.equal(ev.length, 1); assert.equal(ev[0].mint, season.stakeToken.mint); assert.deepEqual(poolEvents(tx, sig, "11111111111111111111111111111111", PROGRAM_ID), [], "not another pool"); assert.deepEqual(poolEvents(tx, sig, pool, DELEGATION_PROGRAM_ID), [], "not another program");
  const failed = clone(tx); failed.meta.err = { InstructionError: [0, "Custom"] }; assert.deepEqual(poolEvents(failed, sig, pool, PROGRAM_ID), [], "SYNTHETIC: a failed transaction names nothing"); assert.deepEqual(poolEvents(null, sig, pool, PROGRAM_ID), []);
});
test("a season is not charged a token that was only found later, and once found the mint is remembered and never read again", async () => {
  const dir = tmp(); let a = await new Ingest(replay(TAPE), { dir, sweepMs: 0 }).open(); await a.cycle(); a.close(); const s = spy(replay(TAPE)); a = await new Ingest(s, { dir, sweepMs: 0 }).open(); await a.cycle(); a.close();
  const poolCalls = new Set(record.seasons.map(x => poolAddress(x.season, PROGRAM_ID))); const asked = s.calls.signatures.filter(c => poolCalls.has(c[0])).map(c => c[0]);
  assert.equal(asked.length, 6, "a second sweep asks again only for the six seasons whose token is unknown"); assert.ok(s.calls.transaction.length === 0, "and fetches no transaction a second time");
});
test("a rate limit while reading a pool is not 'unknown': it stops the cycle, and any other failure is reported as unknown and asked again", async () => {
  const base = replay(TAPE); const season = record.seasons.find(s => s.stakeToken.status === "observed"); const pool = poolAddress(season.season, PROGRAM_ID);
  const limited = { ...base, signatures: (a, ...r) => a === pool ? Promise.reject(new RateLimited("t", Date.now() + 1000, "HTTP 429")) : base.signatures(a, ...r) };
  await assert.rejects(() => buildRecord(limited, { archiveDir: tmp() }), e => e.name === "RateLimited");
  const broken = { ...base, signatures: (a, ...r) => a === pool ? Promise.reject(new Error("upstream 502")) : base.signatures(a, ...r) }; const dir = tmp(); const r = await buildRecord(broken, { archiveDir: dir }); const s = r.seasons.find(x => x.season === season.season);
  assert.equal(s.stakeToken.status, "unknown"); assert.match(s.stakeToken.note, /could not be read: upstream 502/); const seenFile = JSON.parse(fs.readFileSync(path.join(dir, DEVNET_GENESIS, PROGRAM_ID, s.address, "observed.json"))); assert.equal(seenFile.pool, undefined, "a failure is never remembered as 'no token'");
  assert.equal((await buildRecord(replay(TAPE), { archiveDir: dir })).seasons.find(x => x.season === season.season).stakeToken.status, "observed", "and the next read finds it");
});

test("a registry account says whether its strategy is closed: open, closed, or retired to a marker", () => {
  const regs = Object.entries(record.registries); const retired = regs.filter(([, v]) => v.status === "retired"), open = regs.filter(([, v]) => v.status === "open"); assert.equal(retired.length, 54); assert.equal(open.length, 66); assert.ok(open.every(([, v]) => v.delegated === true && /delegated to the rollup/.test(v.note)));
  const [id] = retired[0]; const acct = unpack(TAPE.accounts[registryAddress(id, PROGRAM_ID)]); assert.equal(acct.data.length, 8); assert.equal(acct.data.readUInt32LE(0), REG_DEAD_MAGIC); assert.deepEqual(classifyRegistry(acct, PROGRAM_ID), { status: "retired", closed: true, delegated: false, note: "the strategy was closed and its registry removed; only a permanent marker is left" });
  const live = unpack(TAPE.accounts[registryAddress(open[0][0], PROGRAM_ID)]); assert.equal(live.owner, DELEGATION_PROGRAM_ID); assert.equal(classifyRegistry(live, PROGRAM_ID).status, "open");
  const own = { ...live, owner: PROGRAM_ID }; const c = classifyRegistry(own, PROGRAM_ID); assert.deepEqual([c.status, c.closed, c.delegated], ["open", false, false]);
  const closed = { ...own, data: Buffer.from(own.data) }; closed.data.writeUInt32LE(REG_CLOSED_MAGIC, 0); const k = classifyRegistry(closed, PROGRAM_ID); assert.deepEqual([k.status, k.closed], ["closed", true]); /* SYNTHETIC: a registry closed in the rollup and back on base, before CloseRegistry */
  assert.equal(classifyRegistry(null, PROGRAM_ID).status, "unknown"); assert.equal(classifyRegistry({ owner: "11111111111111111111111111111111", data: acct.data }, PROGRAM_ID).status, "unknown", "another program's account is not a registry"); assert.equal(classifyRegistry({ ...own, data: Buffer.alloc(40) }, PROGRAM_ID).status, "unknown");
});
test("a registry that cannot be read is 'unknown', never 'open'; and a rate limit is passed on", async () => {
  const ids = Object.keys(record.registries).slice(0, 3); const base = replay(TAPE);
  const broken = { ...base, accounts: () => Promise.reject(new Error("boom")), account: () => Promise.reject(new Error("boom")) }; const r = await readRegistryStatuses(broken, PROGRAM_ID, ids); assert.deepEqual(Object.values(r).map(v => v.status), ["unknown", "unknown", "unknown"]); assert.ok(Object.values(r).every(v => v.closed === null));
  const limited = { ...base, accounts: () => Promise.reject(new RateLimited("t", Date.now() + 1000, "429")) }; await assert.rejects(() => readRegistryStatuses(limited, PROGRAM_ID, ids), e => e.name === "RateLimited");
  const partial = { ...base, accounts: undefined, account: a => a === registryAddress(ids[1], PROGRAM_ID) ? Promise.reject(new Error("one bad")) : base.account(a) }; const p = await readRegistryStatuses(partial, PROGRAM_ID, ids); assert.equal(p[ids[1]].status, "unknown"); assert.notEqual(p[ids[0]].status, "unknown", "one unreadable registry does not hide the others");
});
test("the capture loop reads registries in one batched read: all of them at a sweep, only the strategies it has not seen at a poll, and none when nothing is new", async () => {
  const dir = tmp(); const s = spy(replay(TAPE)); const a = await new Ingest(s, { dir, sweepMs: 3600_000 }).open(); const first = await a.cycle(); assert.deepEqual(s.calls.accounts, [120], "all 120 strategies in one batched read (the RPC source splits it into requests of 100)"); assert.equal(Object.keys(first.record.registries).length, 120);
  s.calls.accounts.length = 0; const poll = await a.cycle(); assert.equal(poll.sweep, false); assert.deepEqual(s.calls.accounts, [], "a poll with nothing new reads no registry");
  // SYNTHETIC: a season of a strategy never seen before appears; the poll must learn that strategy's registry at once
  const st = a.state; const gone = Object.keys(st.registries)[7]; delete st.registries[gone]; a.store.writeState(st); await a.cycle(); assert.deepEqual(s.calls.accounts, [1], "one registry, read at a poll, because it is missing");
  s.calls.accounts.length = 0; const sweep = await a.cycle({ sweep: true }); assert.deepEqual(s.calls.accounts, [120]); assert.ok(sweep.record.registriesAt.slot > 0); a.close();
});
test("the record says it is version 2, and a one-shot build and the capture loop agree on both facts", async () => {
  assert.equal(record.version, 2); const a = await new Ingest(replay(TAPE), { dir: tmp(), now: () => "2026-11-27T05:00:00.000Z" }).open(); const r = (await a.cycle()).record; a.close();
  assert.deepEqual(r.registries, Object.fromEntries(Object.entries(record.registries).map(([k, v]) => [k, v]))); assert.deepEqual(r.seasons.map(s => s.stakeToken), record.seasons.map(s => s.stakeToken));
});
