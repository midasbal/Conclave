// The record builder: read every receipt from base, keep the first final copy of each, flag whatever changes afterwards, and assemble the career record. It ranks nothing: see ../policy.
import { PROGRAM_ID, DELEGATION_PROGRAM_ID, DEVNET_GENESIS, delegationRecordAddress, receiptAddress, sha256 } from "./chain.mjs";
import { classify, readDelegationRecord, seasonFromReceipt } from "./receipt.mjs";
import { readHistory, validatorOf } from "./history.mjs";
import { Archive, compareToFirst, ALARMS } from "./archive.mjs";
import { buildViews } from "./views.mjs";

export const RECORD_VERSION = 1;

export async function buildRecord(source, { archiveDir, program = PROGRAM_ID, genesis = DEVNET_GENESIS, now = () => new Date().toISOString(), log = () => {} }) {
  const cluster = await source.genesisHash(); if (cluster !== genesis) throw new Error(`this RPC serves cluster ${cluster}, not the expected ${genesis}`);
  const archive = new Archive(archiveDir, genesis, program);
  const listed = new Map();
  for (const owner of [program, DELEGATION_PROGRAM_ID]) for (const a of await source.receiptsOwnedBy(owner)) listed.set(a.address, a);
  // everything ever archived is looked up again, whether or not this listing mentions it
  for (const address of archive.addresses()) if (!listed.has(address)) { const a = await source.account(address); listed.set(address, a ? { address, ...a } : null); }
  log(`${listed.size} candidate accounts (listed or previously archived)`);

  const seasons = [], legacy = [], rejected = [], newFlags = []; let empty = 0, firstCopies = 0;
  for (const address of [...listed.keys()].sort()) {
    const account = listed.get(address);
    const delegation = account?.owner === DELEGATION_PROGRAM_ID ? await source.account(delegationRecordAddress(address)) : null;
    const c = classify(address, account, { program, delegation });
    let first = archive.first(address);
    const raise = f => { const flag = { ...f, firstSeenAt: now() }; if (archive.flag(address, flag)) newFlags.push({ address, ...flag }); };
    if (!first) {
      if (c.class === "rejected") { rejected.push({ address, reason: c.reason }); continue; }
      if (c.class === "legacy") { legacy.push(legacyRow(c)); continue; }
      if (c.class === "empty") { empty++; continue; }
    }
    if (first?.damaged) { raise({ kind: "archive-damaged", detail: first.damaged }); rejected.push({ address, reason: "its archived first copy is damaged, so nothing about it can be relied on: " + first.damaged }); continue; }

    const seen = archive.seen(address);
    const held = readDelegationRecord(delegation);
    if (held && held.originalOwner === program && !seen.delegationRecords.some(o => o.validator === held.validator)) seen.delegationRecords.push({ validator: held.validator, seenAt: now() });
    let history = null, historyProblem = null;
    try { history = await readHistory(source, address, program, seen.history); seen.history = { examined: history.examined, events: history.events }; if (!history.complete) historyProblem = "base did not serve the whole transaction history"; }
    catch (e) { historyProblem = "transaction history could not be read: " + e.message; history = { ...seen.history }; }
    archive.saveSeen(address, seen);
    const delegations = history.events.filter(e => e.type === "delegated");
    if (delegations.length > 1) raise({ kind: "multiple-delegations", detail: `delegated ${delegations.length} times: ${delegations.map(d => d.signature).join(" ")}` });

    if (!first && c.class === "final") {
      archive.saveFirst(address, { account, season: c.receipt.season.toString(), observedAt: now() }); first = archive.first(address); firstCopies++;
    }
    // counting is not enough: a node that has dropped the first delegation would show only the second. Any delegation after the copy was taken is one too many
    const after = first ? delegations.filter(d => first.finalizedSlot !== null && d.slot > first.finalizedSlot) : [];
    if (after.length) raise({ kind: "redelegated", detail: `delegated again after the first final copy: ${after.map(d => d.signature).join(" ")}` });
    let data, status, current;
    if (first) {
      // the record is built from the FIRST final copy. What is there now is only compared with it
      for (const f of compareToFirst(first.data, account)) raise(f);
      const asFirst = classify(address, { owner: program, data: first.data }, { program });
      if (asFirst.class !== "final") { rejected.push({ address, reason: "its archived first copy is not a final receipt: " + (asFirst.reason ?? asFirst.class) }); continue; }
      data = asFirst; status = "final"; current = account ? { owner: account.owner, sha256: sha256(account.data).toString("hex") } : null;
    } else { data = c; status = "provisional"; current = { owner: account.owner, sha256: c.sha256 }; }

    const flags = archive.flags(address).map(({ kind, detail, info, firstSeenAt }) => ({ kind, detail, info: !!info && !ALARMS.includes(kind), firstSeenAt }));
    const created = history.events.find(e => e.type === "created");
    seasons.push({
      ...seasonFromReceipt(data.receipt), address, status,
      copy: first ? { from: "the first final copy this archive saw", sha256: first.sha256, savedAt: first.observedAt, finalizedSlot: first.finalizedSlot } : { from: "current base state, still delegated: it can still change", sha256: data.sha256 },
      current,
      validator: validatorOf(history, seen.delegationRecords),
      createdAt: created?.time ? { unixTime: created.time, source: "base transaction history (receipts carry no time)" } : null,
      history: { problem: historyProblem, events: history.events.map(({ type, slot, signature, validator }) => ({ type, slot, signature, ...(validator !== undefined ? { validator } : {}) })) },
      flags,
    });
  }
  seasons.sort((a, b) => (a.createdAt?.unixTime ?? Infinity) - (b.createdAt?.unixTime ?? Infinity) || a.season.localeCompare(b.season, "en", { numeric: true }));
  for (const s of seasons) if (receiptAddress(s.season, program) !== s.address) throw new Error("internal: season at the wrong address");
  const { views, anomalies } = buildViews(seasons);
  return {
    version: RECORD_VERSION, genesis, program, builtAt: now(), source: source.host ?? "local", archive: archive.digest(),
    trust: [
      "A receipt says what the Conclave program, run by the validator the creator chose, committed to base. Reading it does not verify that execution.",
      "The program can be upgraded by its upgrade authority. The validator is not recorded on the receipt.",
      "Accounts and history come from one RPC node. It could leave receipts out; archived ones are rechecked individually, but a receipt never listed cannot be noticed.",
    ],
    counts: { final: seasons.filter(s => s.status === "final").length, provisional: seasons.filter(s => s.status === "provisional").length, legacy: legacy.length, empty, rejected: rejected.length, firstCopiesSavedNow: firstCopies, flagsRaisedNow: newFlags.length },
    seasons, views, anomalies, newFlags,
    legacy: { label: "LEGACY. Not verified history: these earlier layouts record no owner, and a commitment only where a result was published. They are in none of the views and no ranking.", receipts: legacy },
    rejected,
  };
}
const legacyRow = c => ({ address: c.address, season: c.season, format: c.format, size: c.size, delegated: c.delegated, label: "LEGACY: no recorded owner", entries: c.entries });
