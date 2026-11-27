// One season's receipt, fetched by the verifier itself, with the same strictness the record builder applies and, if there is an archive, compared with its first copy.
import { delegationRecordAddress, receiptAddress, DELEGATION_PROGRAM_ID } from "./chain.mjs";
import { classify, seasonFromReceipt } from "./receipt.mjs";
import { Archive, compareToFirst } from "./archive.mjs";

export async function lookupSeason(source, season, { program, genesis, archiveDir = null }) {
  const cluster = await source.genesisHash(); if (cluster !== genesis) throw new Error(`this RPC serves cluster ${cluster}, not the expected ${genesis}`);
  const address = receiptAddress(season, program); const account = await source.account(address);
  const delegation = account?.owner === DELEGATION_PROGRAM_ID ? await source.account(delegationRecordAddress(address)) : null;
  let c = classify(address, account, { program, delegation }); const alarms = []; let from = "live base account";
  if (archiveDir) {
    const archive = new Archive(archiveDir, genesis, program); const first = archive.first(address);
    if (first?.damaged) alarms.push("archive-damaged");
    else if (first) {
      for (const f of [...archive.flags(address), ...compareToFirst(first.data, account)]) if (f.kind !== "bond-released" && !alarms.includes(f.kind)) alarms.push(f.kind);
      c = classify(address, { owner: program, data: first.data }, { program }); from = "the archive's first final copy, compared with the live account";
    }
  }
  if (c.class !== "final" && c.class !== "provisional") throw new Error(`no result to verify for season ${season}: ${c.class}${c.reason ? ", " + c.reason : ""}`);
  const R = c.receipt, data = seasonFromReceipt(R);
  return { season: { ...data, status: c.class }, seeds: { seedA: R.seedA, seedB: R.seedB, finalsSeedA: R.finals.seedA, finalsSeedB: R.finals.seedB }, receipt: { address, status: c.class, sha256: c.sha256, from, alarms } };
}
/** a proof about a receipt that can still change, or that has been flagged, is not a pass */
export function judge(result, receipt, { allowProvisional = false } = {}) {
  const blockers = [...receipt.alarms.map(a => "the receipt is flagged: " + a), ...(receipt.status !== "final" && !allowProvisional ? ["the receipt is PROVISIONAL: it can still change (pass --allow-provisional to accept that)"] : [])];
  return { ...result, verified: result.verified && blockers.length === 0, blockers, receipt };
}
