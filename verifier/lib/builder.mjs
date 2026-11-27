// The record builder: read every receipt from base, keep the first final copy of each, flag whatever changes afterwards, and assemble the career record. It ranks nothing: see ../policy.
import { PROGRAM_ID, DELEGATION_PROGRAM_ID, DEVNET_GENESIS, delegationRecordAddress, receiptAddress, sha256 } from "./chain.mjs";
import { classify, readDelegationRecord, seasonFromReceipt } from "./receipt.mjs";
import { readHistory, validatorOf } from "./history.mjs"; import { readPoolMint, stakeToken, readRegistryStatuses } from "./enrich.mjs";
import { Archive, compareToFirst, ALARMS } from "./archive.mjs";
import { buildViews } from "./views.mjs";

export const RECORD_VERSION = 2; // 2: each season names its stake token (or says it is unknown), and the record says which strategies are closed

/** Everything the record needs about ONE address, decided from the account as it is now, the archive, and base's history. The first-final-copy rule, the flags and the validator are all here, so that a full
 *  build and an incremental refresh (lib/ingest.mjs) run exactly the same code. Returns what the address is: a season, a legacy row, an empty receipt, or a rejection with its reason. */
export async function processAddress(ctx, address, account) {
  const { source, archive, program, now, newFlags } = ctx;
  const delegation = account?.owner === DELEGATION_PROGRAM_ID ? await source.account(delegationRecordAddress(address)) : null;
  const c = classify(address, account, { program, delegation });
  let first = archive.first(address);
  const raise = f => { const flag = { ...f, firstSeenAt: now() }; if (archive.flag(address, flag)) newFlags.push({ address, ...flag }); };
  if (!first) {
    if (c.class === "rejected") return { kind: "rejected", row: { address, reason: c.reason } };
    if (c.class === "legacy") return { kind: "legacy", row: legacyRow(c) };
    if (c.class === "empty") return { kind: "empty" };
  }
  if (first?.damaged) { raise({ kind: "archive-damaged", detail: first.damaged }); return { kind: "rejected", row: { address, reason: "its archived first copy is damaged, so nothing about it can be relied on: " + first.damaged }, failed: [`the first copy of ${address} on disk is damaged: ${first.damaged}`] }; }

  const seen = archive.seen(address);
  const held = readDelegationRecord(delegation);
  // a delegation record can only be seen while the receipt is delegated, so it is saved at once, before any read that can fail or be rate limited
  if (held && held.originalOwner === program && !seen.delegationRecords.some(o => o.validator === held.validator)) { seen.delegationRecords.push({ validator: held.validator, seenAt: now() }); archive.saveSeen(address, seen); }
  // THE FIRST COPY COMES FIRST. It needs nothing but the account in hand, and it is the one thing that cannot be read again later: no history or pool read stands between a final receipt and its saved copy
  let savedFirst = false;
  if (!first && c.class === "final") {
    archive.saveFirst(address, { account, season: c.receipt.season.toString(), observedAt: now() }); first = archive.first(address); savedFirst = true; ctx.firstCopies++;
  }
  // what could not be read. The one-shot builder publishes with the problem noted in the record; the capture loop does not publish at all while this is non-empty (lib/ingest.mjs)
  const failed = [];
  let history = null, historyProblem = null;
  if (ctx.skipReads) { historyProblem = "transaction history was not read in this cycle"; history = { ...seen.history }; failed.push(`the transaction history of ${address} was not read: ${ctx.skipReads}`); }
  else try {
    history = await readHistory(source, address, program, seen.history); seen.history = { examined: history.examined, events: history.events, newest: history.newest }; if (!history.complete) historyProblem = "base did not serve the whole transaction history";
    // a transaction the node lists and then does not serve is a failed read. (A history longer than the page limit is not: anyone can make a receipt's history that long, and it is only noted)
    if (history.unserved) failed.push(`reading the transaction history of ${address}: base did not serve ${history.unserved} listed transaction(s)`);
  } catch (e) { if (e.name === "RateLimited") throw e; historyProblem = "transaction history could not be read: " + e.message; history = { ...seen.history }; failed.push(`reading the transaction history of ${address}: ${e.message}`); }
  // the stake token: named once, in the season's InitPool transaction on base. Remembered once found; "none found" is asked again next time
  const sid = first ? (first.data.length >= 16 ? first.data.readBigUInt64LE(8) : null) : c.receipt?.season; let poolProblem = null; // from the receipt bytes, not from a text field
  if (sid != null && !seen.pool?.mint) {
    if (ctx.skipReads) { poolProblem = "the pool's transactions were not read in this cycle"; failed.push(`the pool's transactions for ${address} were not read: ${ctx.skipReads}`); }
    else try { const f = await readPoolMint(source, program, sid); seen.pool = f ? { mint: f.mint, signature: f.signature, slot: f.slot, time: f.time } : { mint: null }; }
    catch (e) { if (e.name === "RateLimited") throw e; poolProblem = "the pool's transactions could not be read: " + e.message; failed.push(`reading the pool's transactions for ${address}: ${e.message}`); }
  }
  archive.saveSeen(address, seen);
  const delegations = history.events.filter(e => e.type === "delegated");
  if (delegations.length > 1) raise({ kind: "multiple-delegations", detail: `delegated ${delegations.length} times: ${delegations.map(d => d.signature).join(" ")}` });

  // counting is not enough: a node that has dropped the first delegation would show only the second. Any delegation after the copy was taken is one too many
  const after = first ? delegations.filter(d => first.finalizedSlot !== null && d.slot > first.finalizedSlot) : [];
  if (after.length) raise({ kind: "redelegated", detail: `delegated again after the first final copy: ${after.map(d => d.signature).join(" ")}` });
  let data, status, current;
  if (first) {
    // the record is built from the FIRST final copy. What is there now is only compared with it
    for (const f of compareToFirst(first.data, account)) raise(f);
    const asFirst = classify(address, { owner: program, data: first.data }, { program });
    if (asFirst.class !== "final") return { kind: "rejected", row: { address, reason: "its archived first copy is not a final receipt: " + (asFirst.reason ?? asFirst.class) }, ...(failed.length ? { failed } : {}) };
    data = asFirst; status = "final"; current = account ? { owner: account.owner, sha256: sha256(account.data).toString("hex") } : null;
  } else { data = c; status = "provisional"; current = { owner: account.owner, sha256: c.sha256 }; }

  const flags = archive.flags(address).map(({ kind, detail, info, firstSeenAt }) => ({ kind, detail, info: !!info && !ALARMS.includes(kind), firstSeenAt }));
  const created = history.events.find(e => e.type === "created");
  return { kind: "season", savedFirst, ...(failed.length ? { failed } : {}), season: {
    ...seasonFromReceipt(data.receipt), address, status, stakeToken: stakeToken(seen.pool?.mint ? seen.pool : null, poolProblem),
    copy: first ? { from: "the first final copy this archive saw", sha256: first.sha256, savedAt: first.observedAt, finalizedSlot: first.finalizedSlot } : { from: "current base state, still delegated: it can still change", sha256: data.sha256 },
    current,
    validator: validatorOf(history, seen.delegationRecords),
    createdAt: created?.time ? { unixTime: created.time, source: "base transaction history (receipts carry no time)" } : null,
    history: { problem: historyProblem, events: history.events.map(({ type, slot, signature, validator }) => ({ type, slot, signature, ...(validator !== undefined ? { validator } : {}) })) },
    flags,
  } };
}
export const newContext = (source, archive, { program, now = () => new Date().toISOString() }) => ({ source, archive, program, now, newFlags: [], firstCopies: 0 });

/** descriptors: what processAddress returned for every address, in any order. `currentTo`: the slot and time the underlying reads were served at. `extra`: more fields for the record (the service adds its own) */
export function assembleRecord(descriptors, { archive, genesis, program, now = () => new Date().toISOString(), source, ctx, currentTo = null, registries = {}, registriesAt = null, extra = {} }) {
  const seasons = [], legacy = [], rejected = []; let empty = 0;
  for (const d of descriptors) { if (d.kind === "season") seasons.push(d.season); else if (d.kind === "legacy") legacy.push(d.row); else if (d.kind === "rejected") rejected.push(d.row); else empty++; }
  seasons.sort((a, b) => (a.createdAt?.unixTime ?? Infinity) - (b.createdAt?.unixTime ?? Infinity) || a.season.localeCompare(b.season, "en", { numeric: true }));
  legacy.sort((a, b) => a.address < b.address ? -1 : 1); rejected.sort((a, b) => a.address < b.address ? -1 : 1);
  for (const s of seasons) if (receiptAddress(s.season, program) !== s.address) throw new Error("internal: season at the wrong address");
  const { views, anomalies } = buildViews(seasons);
  return {
    version: RECORD_VERSION, genesis, program, builtAt: now(), currentTo, source: source?.host ?? "local", archive: archive.digest(), ...(archive.ledger ? { ledger: archive.ledger.summary() } : {}),
    trust: [
      "A receipt says what the Conclave program, run by the validator the creator chose, committed to base. Reading it does not verify that execution.",
      "The program can be upgraded by its upgrade authority. The validator is not recorded on the receipt.",
      "Accounts and history come from one RPC node. It could leave receipts out; archived ones are rechecked individually, but a receipt never listed cannot be noticed.",
    ],
    counts: { final: seasons.filter(s => s.status === "final").length, provisional: seasons.filter(s => s.status === "provisional").length, legacy: legacy.length, empty, rejected: rejected.length, firstCopiesSavedNow: ctx?.firstCopies ?? 0, flagsRaisedNow: ctx?.newFlags.length ?? 0 },
    seasons, views, anomalies, registries, registriesAt, newFlags: ctx?.newFlags ?? [], ...extra,
    legacy: { label: "LEGACY. Not verified history: these earlier layouts record no owner, and a commitment only where a result was published. They are in none of the views and no ranking.", receipts: legacy },
    rejected,
  };
}

/** one full build: list, then process every address. The service (lib/ingest.mjs) does the same work incrementally */
export async function buildRecord(source, { archiveDir, program = PROGRAM_ID, genesis = DEVNET_GENESIS, now = () => new Date().toISOString(), log = () => {} }) {
  const cluster = await source.genesisHash(); if (cluster !== genesis) throw new Error(`this RPC serves cluster ${cluster}, not the expected ${genesis}`);
  const archive = new Archive(archiveDir, genesis, program);
  const listed = new Map(); const slots = [];
  for (const owner of [program, DELEGATION_PROGRAM_ID]) { const got = await source.receiptsOwnedBy(owner); if (got.contextSlot != null) slots.push(got.contextSlot); for (const a of got) listed.set(a.address, a); }
  // everything ever archived is looked up again, whether or not this listing mentions it
  for (const address of archive.addresses()) if (!listed.has(address)) { const a = await source.account(address); listed.set(address, a ? { address, ...a } : null); }
  log(`${listed.size} candidate accounts (listed or previously archived)`);
  const ctx = newContext(source, archive, { program, now }); const descriptors = [];
  for (const address of [...listed.keys()].sort()) descriptors.push(await processAddress(ctx, address, listed.get(address)));
  const ids = [...new Set(descriptors.filter(d => d.kind === "season").flatMap(d => d.season.entries.map(e => e.strategyId)))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const registries = await readRegistryStatuses(source, program, ids);
  return assembleRecord(descriptors, { archive, genesis, program, now, source, ctx, currentTo: slots.length ? { slot: Math.min(...slots), at: now() } : null, registries, registriesAt: { at: now() } });
}
const legacyRow = c => ({ address: c.address, season: c.season, format: c.format, size: c.size, delegated: c.delegated, label: "LEGACY: no recorded owner", entries: c.entries });
