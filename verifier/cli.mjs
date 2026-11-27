#!/usr/bin/env node
// The Conclave verifier. Read-only: it needs no key, sends no transaction, and reads receipts from base itself. See README.md.
import fs from "fs"; import path from "path"; import { fileURLToPath, pathToFileURL } from "url"; import { execFileSync } from "child_process";
import { rpcSource, PROGRAM_ID, DEVNET_GENESIS, DEFAULT_RPC } from "./lib/chain.mjs";
import { buildRecord } from "./lib/builder.mjs";
import { lookupSeason, judge } from "./lib/lookup.mjs";
import * as P from "./lib/proofs.mjs";
import { readJson, writeJson, writeSecret, assertOutsideRepo } from "./lib/files.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: node cli.mjs <command>
  record      --archive DIR --out FILE                                   build the career record once; keeps the first final copy of every receipt in DIR
  ingest      --store DIR [--backup DIR] [--out FILE] [--poll-seconds 60] [--sweep-minutes 15] [--once]   the capture loop (docs/RECORD_SERVICE.md)
  store       init --from OLD_ARCHIVE --store DIR | verify --store DIR [--backup DIR] | backup --store DIR --to DIR | snapshot --store DIR --out FILE | restore --store DIR (--snapshot FILE | --from-backup DIR)
  view        --record FILE (--strategy ID | --wallet KEY | --commitment HEX)
  season      --record FILE --season S                                   the raw facts of one season
  rank        --record FILE --rules FILE [--policy MODULE] [--out FILE]  apply a counting policy (default policy/official.mjs)
 level 1      verify-recorded --season S --id ID [--commitment HEX]
 level 2      challenge --season S --id ID --asked-by TEXT --store DIR --out FILE      (verifier)
              sign-challenge --challenge FILE --key KEYPAIR.json --out FILE           (owner; the only command that touches a key)
              verify-wallet --response FILE --store DIR                               (verifier; each challenge works once)
 level 3      reveal-totals --season S --bundle FILE --passphrase-file F --out FILE   (owner)
              verify-totals --proof FILE
 level 4      reveal-code --season S --bundle FILE --passphrase-file F --out FILE     (owner)
              verify-code --proof FILE
 common: --rpc URL (default ${DEFAULT_RPC}, or CONCLAVE_VERIFIER_RPC)  --archive DIR  --program ID  --genesis HASH  --allow-provisional`;
const [cmd, ...rest] = process.argv.slice(2);
const val = (name, required = false) => { const i = rest.indexOf(name); const v = i >= 0 ? rest[i + 1] : undefined; if (required && !v) { console.error(`missing ${name}\n${USAGE}`); process.exit(2); } return v; };
const has = n => rest.includes(n);
const program = val("--program") ?? PROGRAM_ID, genesis = val("--genesis") ?? DEVNET_GENESIS;
const source = () => rpcSource(val("--rpc") ?? process.env.CONCLAVE_VERIFIER_RPC ?? DEFAULT_RPC);
const find = season => lookupSeason(source(), season, { program, genesis, archiveDir: val("--archive") ?? null });
const author = async () => { try { return await (await import("../client/author.mjs")).load(); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const localVmRules = () => { try { return execFileSync(path.join(here, "../target/release/conclave-lab"), ["pins"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return null; } };
function report(r) {
  console.log(`LEVEL "${r.level}": ${r.verified ? "VERIFIED" : "NOT VERIFIED"}`);
  for (const c of r.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}`);
  for (const b of r.blockers ?? []) console.log(`  FAIL ${b}`);
  const w = r.receipt; console.log(`  receipt ${w.address} (${w.status}; read from ${w.from}; sha256 ${w.sha256})`);
  if (r.entry) console.log(`  entry: strategy ${r.entry.strategyId}, slot ${r.entry.slot}, owner at entry ${r.entry.owner}, rank ${r.entry.rank ?? "none"} (season rank ${r.entry.seasonRank ?? "none"}), published ${r.entry.published}\n  code commitment ${r.entry.codeCommitment}`);
  if (r.replay) console.log(`  replayed totals: season ${r.replay.total}, finals ${r.replay.finalsTotal}; bound to the receipt: ${r.totalsBoundToReceipt ? "yes" : "NO"}`);
  if (r.claimed) console.log(`  claimed totals: season ${r.claimed.total}, finals ${r.claimed.finalsTotal}`);
  for (const n of r.notes ?? []) console.log(`  note: ${n}`);
  if (r.verified) { console.log("  establishes:"); for (const t of r.establishes) console.log("   + " + t); }
  console.log("  does NOT establish:"); for (const t of r.doesNot) console.log("   - " + t);
  process.exitCode = r.verified ? 0 : 1;
}
const opts = { allowProvisional: has("--allow-provisional") };
const sameChain = p => { if (p.genesis !== genesis || p.program !== program) throw new Error("this proof is for another cluster or program"); };

async function main() {
  if (cmd === "record") {
    const record = await buildRecord(source(), { archiveDir: val("--archive", true), program, genesis, log: m => console.error(m) });
    writeJson(val("--out", true), record);
    console.log(JSON.stringify(record.counts)); console.log(`archive: ${record.archive.copies} first final copies | digest ${record.archive.sha256} | record digest (comparable between archives) ${record.archive.recordSha256}`);
    for (const f of record.newFlags) console.log(`${f.info ? "note" : "ALARM"} ${f.address}: ${f.kind}: ${f.detail}`);
    for (const x of record.rejected) console.log(`rejected ${x.address}: ${x.reason}`);
    if (record.seasons.some(s => s.flags.some(f => !f.info))) process.exitCode = 1;
  } else if (cmd === "ingest") {
    const { Ingest } = await import("./lib/ingest.mjs"); const ing = new Ingest(source(), { dir: val("--store", true), backupDir: val("--backup") ?? null, publishTo: val("--out") ?? null, program, genesis, sweepMs: Number(val("--sweep-minutes") ?? 15) * 60_000, log: m => console.error(`${new Date().toISOString()} ${m}`) });
    await ing.open(); const stop = new AbortController(); for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { console.error(`${sig}: finishing the cycle in progress, then stopping`); stop.abort(); });
    try { await ing.run({ pollMs: Number(val("--poll-seconds") ?? 60) * 1000, once: has("--once"), signal: stop.signal, onCycle: r => console.error(`${new Date().toISOString()} slot ${r.slot}: ${r.sweep ? "sweep" : "poll"}, processed ${r.processed}, unchanged ${r.skipped}, new first copies ${r.newFirstCopies}, new flags ${r.newFlags.length}`) }); if (has("--once")) { const c = ing.last.counts; console.log(JSON.stringify(c)); console.log(`current to slot ${ing.last.currentTo.slot} | archive ${ing.last.archive.copies} first copies, digest ${ing.last.archive.sha256}, record digest ${ing.last.archive.recordSha256} | ledger ${ing.last.ledger.entries} lines, head ${ing.last.ledger.head}`); if (ing.last.seasons.some(s => s.flags.some(f => !f.info))) process.exitCode = 1; } }
    finally { try { ing.writeStatus({ state: "stopped", at: new Date().toISOString() }); } catch { /* the store may not be writable any more */ } ing.close(); }
  } else if (cmd === "store") {
    const sub = rest[0]; const S = await import("./lib/store.mjs"), M = await import("./lib/mirror.mjs"); const dir = val("--store", true); const rootOf = d => path.join(d, genesis, program);
    if (sub === "init") { const r = S.importArchive(val("--from", true), dir, genesis, program); console.log(`imported ${r.first} first copies, ${r.flags} flag files, ${r.observed} observation files into ${rootOf(dir)}; the source folder was only read`); const v = S.verifyStore(dir, genesis, program); console.log(v.ok ? `verified: ${v.copies} first copies, ledger ${v.ledger.entries} lines` : "PROBLEMS:\n  " + v.problems.join("\n  ")); process.exitCode = v.ok ? 0 : 1; }
    else if (sub === "verify") { const v = S.verifyStore(dir, genesis, program); console.log(v.ok ? `store ok: ${v.copies} first copies, ledger ${v.ledger.entries} lines, head ${v.ledger.head}` : "STORE PROBLEMS:\n  " + v.problems.join("\n  ")); let ok = v.ok; if (val("--backup")) { const b = M.verifyMirror(rootOf(val("--backup")), genesis, program, rootOf(dir)); console.log(b.ok ? `backup ok: ${b.copies} first copies, synced ${b.syncedAt}, ledger ${b.ledger.entries} lines` : "BACKUP PROBLEMS:\n  " + b.problems.join("\n  ")); ok &&= b.ok; } process.exitCode = ok ? 0 : 1; }
    else if (sub === "backup") { const st = new S.Store(dir, genesis, program); const r = M.syncMirror(st.root, rootOf(val("--to", true))); console.log(`copied ${r.copied.length} files; ${r.alarms.length} alarms; manifest digest ${r.manifest.digest}`); for (const a of r.alarms) console.log(`ALARM ${a.kind} ${a.address ?? ""}: ${a.detail}`); process.exitCode = r.alarms.length ? 1 : 0; }
    else if (sub === "snapshot") { const st = new S.Store(dir, genesis, program); const snap = M.makeSnapshot(st.root, genesis, program); writeJson(val("--out", true), snap); console.log(`${Object.keys(snap.copies).length} first copies, ledger ${snap.ledger.length} lines, digest ${snap.digest}`); }
    else if (sub === "restore") { if (val("--snapshot")) { const r = M.restoreSnapshot(readJson(val("--snapshot")), dir); console.log(`restored ${r.copies} first copies and ${r.ledgerEntries} ledger lines into ${r.root}`); } else { const from = rootOf(val("--from-backup", true)); const b = M.verifyMirror(from, genesis, program); if (!b.ok) throw new Error("the backup does not verify: " + b.problems.join("; ")); const to = rootOf(dir); if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error(`${to} is not empty: restore only into a folder with no store`); fs.cpSync(from, to, { recursive: true, filter: s => !s.endsWith("MANIFEST.json") }); console.log(`restored ${b.copies} first copies from the backup`); }
      const v = S.verifyStore(dir, genesis, program); console.log(v.ok ? `restored store verifies: ${v.copies} first copies, ledger head ${v.ledger.head}` : "PROBLEMS:\n  " + v.problems.join("\n  ")); process.exitCode = v.ok ? 0 : 1; }
    else throw new Error("store: init | verify | backup | snapshot | restore");
  } else if (cmd === "view") {
    const r = readJson(val("--record", true)); const pick = [["--strategy", "strategies"], ["--wallet", "wallets"], ["--commitment", "commitments"]].find(([f]) => val(f)); if (!pick) throw new Error("say --strategy, --wallet or --commitment");
    console.log(JSON.stringify(r.views[pick[1]][val(pick[0])] ?? null, null, 1));
  } else if (cmd === "season") {
    const s = readJson(val("--record", true)).seasons.find(s => s.season === val("--season", true)); console.log(JSON.stringify(s ?? null, null, 1));
  } else if (cmd === "rank") {
    const policy = await import(pathToFileURL(path.resolve(val("--policy") ?? path.join(here, "policy/official.mjs")))); const out = policy.evaluate(readJson(val("--record", true)), readJson(val("--rules", true)));
    if (val("--out")) writeJson(val("--out"), out);
    console.log(`policy ${out.policy.name} v${out.policy.version} with rules "${out.rules.name}"`); console.log(`counted ${out.counted.length} seasons, excluded ${out.excluded.length}`);
    const why = {}; for (const x of out.excluded) for (const r of x.reasons) why[r] = (why[r] ?? 0) + 1; for (const [k, n] of Object.entries(why)) console.log(`  excluded because ${k}: ${n}`);
    for (const x of out.ranking.slice(0, 15)) console.log(`  ${String(x.position).padStart(3)}. strategy ${x.strategyId}  seasons ${x.seasons}  wins ${x.wins}  podiums ${x.podiums}  beaten-share ${x.beaten}`);
    for (const d of out.disclaimers) console.log("  * " + d);
  } else if (cmd === "verify-recorded") {
    const f = await find(val("--season", true)); report(judge(P.verifyRecorded(f.season, { id: val("--id", true), codeCommitment: val("--commitment") }), f.receipt, opts));
  } else if (cmd === "challenge") {
    const f = await find(val("--season", true)); if (!P.entryOf(f.season, { id: val("--id", true) })) throw new Error("that receipt does not list this strategy");
    const c = P.makeChallenge({ genesis, program, season: f.season.season, id: val("--id", true), askedBy: val("--asked-by", true) });
    writeJson(path.join(val("--store", true), c.nonce + ".json"), c, { flag: "wx" }); writeJson(val("--out", true), c);
    console.log("challenge written. It expires at " + c.expiresAt + " and can be answered once");
  } else if (cmd === "sign-challenge") {
    const c = readJson(val("--challenge", true)); console.log(P.challengeMessage(c).subarray(1).toString());
    const key = Uint8Array.from(readJson(val("--key", true))); writeJson(val("--out", true), P.signChallenge(c, key)); key.fill(0); console.log("signed");
  } else if (cmd === "verify-wallet") {
    const response = readJson(val("--response", true)); if (!/^[0-9a-f]{64}$/.test(response.nonce ?? "")) throw new Error("not a wallet response");
    const store = val("--store", true); const file = path.join(store, response.nonce + ".json"), used = path.join(store, response.nonce + ".used");
    if (!fs.existsSync(file)) throw new Error("this verifier never issued that challenge");
    if (fs.existsSync(used)) throw new Error("that challenge has already been used");
    const issued = readJson(file); const f = await find(issued.season); const r = judge(P.verifyWallet(f.season, issued, response, { genesis, program }), f.receipt, opts);
    if (r.verified) fs.writeFileSync(used, new Date().toISOString() + "\n", { flag: "wx" }); report(r);
  } else if (cmd === "reveal-totals" || cmd === "reveal-code") {
    const level = cmd === "reveal-code" ? "code" : "totals"; const out = assertOutsideRepo(val("--out", true));
    const R = await import("./lib/prover.mjs"); const C = await import("../client/custody.mjs");
    const secret = await R.openOwnBundle(val("--bundle", true), C.passphraseFromFile(val("--passphrase-file", true))); if (secret.program !== program || secret.genesis !== genesis) throw new Error("the bundle is for another cluster or program");
    const f = await find(val("--season", true)); writeSecret(out, R.makeReveal(level, f, secret, { genesis, program, author: await author(), localVmRules: localVmRules() }));
    console.log(`written to ${out} (mode 0600). ${level === "code" ? "It holds your sealed salt and bytecode: whoever receives it can copy your strategy." : "It holds this season's score salt and totals. It does not hold your sealed salt or code."}`);
  } else if (cmd === "verify-totals") {
    const p = readJson(val("--proof", true)); if (p.type !== "conclave-totals-reveal") throw new Error("not a totals reveal"); sameChain(p);
    const f = await find(p.season); report(judge(P.verifyTotals(f.season, { id: p.strategyId, slot: p.slot, total: p.total, finalsTotal: p.finalsTotal, scoreSalt: p.scoreSalt }), f.receipt, opts));
  } else if (cmd === "verify-code") {
    const p = readJson(val("--proof", true)); if (p.type !== "conclave-code-reveal") throw new Error("not a code reveal"); sameChain(p);
    const f = await find(p.season); report(judge(P.verifyCode(f.season, f.seeds, { id: p.strategyId, slot: p.slot, salt: p.salt, code: p.code }, { author: await author(), localVmRules: localVmRules() }), f.receipt, opts));
  } else { console.log(USAGE); process.exitCode = cmd ? 2 : 0; }
}
main().catch(e => { console.error("error: " + e.message); process.exit(2); });
