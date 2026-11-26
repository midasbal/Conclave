// Recovery bundles from the command line. Reads the chain, never writes to it. Never prints a salt, the bytecode, the source, an unsalted hash, or a passphrase. See docs/CUSTODY.md.
//   node client/custody_cli.mjs new-passphrase FILE                      write a fresh random passphrase to FILE (0600; refuses to overwrite)
//   node client/custody_cli.mjs export-all  [--dir D]                    a verified bundle for every strategy in the key file, each checked against what the chain still holds
//   node client/custody_cli.mjs recover --owner N [--id ID] [--dir D] [--restore]
//                                                                         rebuild bundles from SEALED accounts, using only the owner's wallet (--restore puts the records back in the key file)
//   node client/custody_cli.mjs verify FILE [--season S] [--offline]     open a bundle, check it against the chain, and (with --season) replay it against that season's public receipt
//   node client/custody_cli.mjs rekey FILE...                            re-encrypt under a new passphrase (--new-passphrase-file, or asked twice)
// Passphrase: --passphrase-file F, or CONCLAVE_BUNDLE_PASSPHRASE_FILE, or asked on the terminal. It is never taken from the command line itself.
import fs from "fs"; import path from "path"; import crypto from "crypto";
import * as C from "./custody.mjs";
const [cmd, ...rest] = process.argv.slice(2); const has = n => rest.includes(n); const val = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const files = () => rest.filter((a, i) => !a.startsWith("--") && !["--dir", "--owner", "--id", "--season", "--passphrase-file", "--new-passphrase-file"].includes(rest[i - 1]));
const die = (m, code = 2) => { console.error(m); process.exit(code); };
if (!["new-passphrase", "export-all", "recover", "verify", "rekey"].includes(cmd)) die("usage: custody_cli.mjs new-passphrase|export-all|recover|verify|rekey (see the header of client/custody_cli.mjs)");

function askHidden(q) { if (!process.stdin.isTTY) die("no passphrase: use --passphrase-file, CONCLAVE_BUNDLE_PASSPHRASE_FILE, or run on a terminal");
  return new Promise(res => { process.stderr.write(q); const inp = process.stdin; inp.setRawMode(true); inp.resume(); inp.setEncoding("utf8"); let s = "";
    const on = ch => { for (const k of ch) { if (k === "\r" || k === "\n") { inp.setRawMode(false); inp.pause(); inp.off("data", on); process.stderr.write("\n"); return res(s); } if (k === "\u0003") process.exit(130); if (k === "\u007f" || k === "\b") s = s.slice(0, -1); else s += k; } }; inp.on("data", on); }); }
async function passphrase({ creating = false, flag = "--passphrase-file", env = "CONCLAVE_BUNDLE_PASSPHRASE_FILE", label = "bundle passphrase" } = {}) { const f = val(flag) ?? (env ? process.env[env] : undefined); if (f) return C.passphraseFromFile(f);
  const a = await askHidden(`${label}: `); if (creating && a !== await askHidden(`${label} again: `)) die("the two entries differ; nothing was written"); return a; }

if (cmd === "new-passphrase") { const f = files()[0] ?? die("name the file to create"); C.assertOutsideRepo(f); C.writeDurable(path.resolve(f), C.newPassphrase() + "\n", { noClobber: true }); console.log(`wrote a new 160-bit passphrase to ${f} (mode 0600). Put a copy somewhere that does not share this disk's fate: without it the bundles cannot be opened.`); process.exit(0); }

if (cmd === "rekey") { const list = files(); if (!list.length) die("name the bundle files"); const old = await passphrase(); const next = await passphrase({ creating: true, flag: "--new-passphrase-file", env: null, label: "NEW passphrase" });
  for (const f of list) { const o = C.openBundle(fs.readFileSync(f), old); const fields = { program: o.public.program, cluster: o.public.cluster, id: o.public.id, owner: o.public.owner, salt: o.salt, code: o.code, source: o.source, name: o.name, vmPins: o.vmPins };
    const tmp = `${f}.rekey-${process.pid}`; C.writeBundle(tmp, fields, next); fs.renameSync(tmp, f); const back = C.openBundle(fs.readFileSync(f), next); if (back.public.commitment !== o.public.commitment) die("re-encrypted bundle does not match", 1); console.log(`re-encrypted ${f} (strategy ${o.public.id}); the old passphrase no longer opens it. Copies made earlier still open with the old one.`); }
  process.exit(0); }

if (cmd === "verify" && has("--offline")) { const o = C.openBundle(fs.readFileSync(files()[0]), await passphrase()); console.log(`opens and is intact. strategy ${o.public.id}, owner ${o.public.owner}, program ${o.public.program}, cluster ${o.public.cluster.name}, commitment ${o.public.commitment}, ruleset ${o.ruleset}, source ${o.source ? "included" : "not included"}. The salt and bytecode open the commitment. Not checked against any chain.`); process.exit(0); }

// everything below reads the chain
const L = await import("./lib.mjs"); const F = await import("./flows.mjs");
const sleep = L.sleep; const hex = b => Buffer.from(b).toString("hex"); const M_REG = 0x5245_4753, M_STRAT = 0x5354_5254, M_RCPT = 0x5443_5052;
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const tee = async kp => new L.Endpoint(L.TEE, await L.tokenFor(L.TEE, kp));
/** every season receipt on base (closed or delegated), as id -> [{ season, commitment }] for published entries */
async function receiptCommitments() { const bs58 = (await import("bs58")).default; const out = new Map();
  for (const owner of [L.PROGRAM.toBase58(), L.DLP.toBase58()]) for (const size of [1728, 1792, 1824]) { const r = await L.rpc(L.BASE_URL, "getProgramAccounts", [owner, { encoding: "base64", filters: [{ dataSize: size }, { memcmp: { offset: 0, bytes: bs58.encode(Buffer.from([0x52, 0x50, 0x43, 0x54])) } }] }]); if (r.error) throw new Error("receipt scan failed: " + JSON.stringify(r.error));
      const at = size === 1824 ? 224 : size === 1792 ? 192 : 128; for (const a of r.result) { const d = Buffer.from(a.account.data[0], "base64"); if (d.readUInt32LE(0) !== M_RCPT) continue; for (let i = 0; i < Math.min(d[5], 20); i++) { const e = at + i * 80; const commit = d.subarray(e + 8, e + 40); if (commit.every(b => b === 0)) continue; const id = d.readBigUInt64LE(e).toString(); (out.get(id) ?? out.set(id, []).get(id)).push({ season: d.readBigUInt64LE(8).toString(), commitment: hex(commit) }); } } }
  return out; }

if (cmd === "export-all") {
  const dir = path.resolve(val("--dir") ?? F.bundleDir()); const pass = await passphrase({ creating: true }); const players = L.players(); const recs = L.loadStrats(); const before = crypto.createHash("sha256").update(fs.readFileSync(L.stratFile())).digest("hex");
  const cluster = await F.clusterInfo(); const pins = F.vmPins(); console.log(`${recs.length} strategies in the key file; bundles go to ${dir}; cluster ${cluster.name}`);
  const regs = new Map(); for (const part of chunks(recs, 100)) { const r = await L.rpc(L.BASE_URL, "getMultipleAccounts", [part.map(x => L.regPda(BigInt(x.id)).toBase58()), { encoding: "base64" }]); if (r.error) die("registry read failed: " + JSON.stringify(r.error), 1); r.result.value.forEach((a, i) => { if (a) regs.set(part[i].id, Buffer.from(a.data[0], "base64")); }); }
  const receipts = await receiptCommitments(); const eps = []; for (const p of players) eps.push(await tee(p));
  const index = []; const tally = {}; let n = 0;
  for (const rec of recs) { const salt = Buffer.from(rec.salt, "hex"), code = Buffer.from(rec.code, "hex"), commit = L.codeCommit(salt, code); const owner = players[rec.owner].publicKey.toBase58(); const agree = [], differ = [];
    // 1. the sealed account, read with the owner's token: the strongest evidence, the very bytes the chain runs
    const rr = await L.rpc(eps[rec.owner], "getAccountInfo", [L.stratPda(BigInt(rec.id)).toBase58(), { encoding: "base64" }]); if (rr.error) die(`stopping: the rollup refused a read (${JSON.stringify(rr.error).slice(0, 120)}). Nothing is lost; run again later.`, 1); await sleep(300);
    const sd = rr.result?.value ? Buffer.from(rr.result.value.data[0], "base64") : null; if (sd && sd.length >= 396 && sd.readUInt32LE(0) === M_STRAT) { try { const s = C.fromSealedAccount(sd); (s.salt.equals(salt) && s.code.equals(code) && s.owner === owner && s.id === rec.id ? agree : differ).push("sealed"); } catch { differ.push("sealed"); } }
    // 2. the registry on base (its data is the same while delegated); 3. the commitments published on season receipts
    const reg = regs.get(rec.id); if (reg && reg.length >= 128 && reg.readUInt32LE(0) === M_REG) { const g = C.parseRegistry(reg); (g.commitment.equals(commit) && g.owner === owner ? agree : differ).push("registry"); }
    const rcs = receipts.get(rec.id) ?? []; if (rcs.length) (rcs.every(x => x.commitment === hex(commit)) ? agree : differ).push("receipt");
    const status = differ.length ? "MISMATCH" : agree[0] ?? "key-file-only";
    const r = C.writeBundle(F.bundlePath(rec.id, dir), { program: L.PROGRAM.toBase58(), cluster, id: rec.id, owner, salt, code, source: await F.sourceFor(code), name: rec.name, vmPins: pins }, pass);
    // reopened from disk by writeBundle; check the opened copy against the commitment the chain holds, where it holds one
    if (r.opened.public.commitment !== hex(commit)) die(`bundle for ${rec.id} does not carry the record's commitment`, 1);
    index.push({ id: rec.id, owner, commitment: hex(commit), status, agrees: agree, differs: differ, seasons: rcs.map(x => x.season), hasSource: !!r.opened.source, ruleset: r.opened.ruleset, file: path.basename(r.file), sha256: crypto.createHash("sha256").update(fs.readFileSync(r.file)).digest("hex"), reused: r.reused }); tally[status] = (tally[status] ?? 0) + 1;
    if (++n % 25 === 0) console.log(`  ${n}/${recs.length}`); }
  C.writeDurable(path.join(dir, "index.json"), JSON.stringify({ cluster, program: L.PROGRAM.toBase58(), strategies: index }, null, 1)); // public facts only: ids, owners, commitments, file hashes
  const count = f => index.filter(f).length;
  console.log(`bundles: ${index.length} written and reopened from disk (${count(x => x.reused)} already existed and matched)`);
  console.log(`checked against the chain, by strongest source: ${JSON.stringify(tally)}`);
  console.log(`  sealed account agrees ${count(x => x.agrees.includes("sealed"))} | registry agrees ${count(x => x.agrees.includes("registry"))} | a published receipt entry agrees ${count(x => x.agrees.includes("receipt"))} | any disagreement ${count(x => x.differs.length)}`);
  console.log(`  source included ${count(x => x.hasSource)} | ruleset ${JSON.stringify(index.reduce((m, x) => (m[x.ruleset] = (m[x.ruleset] ?? 0) + 1, m), {}))}`);
  console.log(`key file unchanged: ${crypto.createHash("sha256").update(fs.readFileSync(L.stratFile())).digest("hex") === before}`);
  process.exit(count(x => x.differs.length) ? 1 : 0);
}

if (cmd === "recover") {
  const i = Number(val("--owner")); const c = await F.ctx(); if (!Number.isInteger(i) || !c.players[i]) die("--owner N (index of the owner's wallet in players.json)"); const owner = c.players[i].publicKey.toBase58(); const dir = path.resolve(val("--dir") ?? F.bundleDir()); const pass = await passphrase({ creating: true });
  let ids = val("--id") ? [val("--id")] : null;
  if (!ids) { ids = []; const seen = new Set(); for (const prog of [L.PROGRAM.toBase58(), L.DLP.toBase58()]) { const r = await L.rpc(L.BASE_URL, "getProgramAccounts", [prog, { encoding: "base64", filters: [{ dataSize: 128 }, { memcmp: { offset: 8, bytes: owner } }] }]); if (r.error) die("registry search failed: " + JSON.stringify(r.error), 1); for (const a of r.result) { const d = Buffer.from(a.account.data[0], "base64"); if (d.readUInt32LE(0) !== M_REG) continue; const id = d.readBigUInt64LE(40).toString(); if (!seen.has(id)) { seen.add(id); ids.push(id); } } } console.log(`${ids.length} open registries name this owner on base`); }
  let ok = 0; const failed = [];
  for (const id of ids) { try { const r = await F.recoverBundle(c, i, BigInt(id), { dir, passphrase: pass, restore: has("--restore") }); ok++; console.log(`strategy ${id}: recovered from the sealed account, bundle verified: ${r.file}`); } catch (e) { failed.push(id); console.log(`strategy ${id}: NOT recovered: ${e.message}`); } await sleep(300); }
  console.log(`${ok} recovered, ${failed.length} not`); process.exit(failed.length && val("--id") ? 1 : 0);
}

if (cmd === "verify") {
  const o = C.openBundle(fs.readFileSync(files()[0]), await passphrase()); const id = BigInt(o.public.id); const checks = []; const check = (n, ok) => { checks.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${n}`); };
  check("the bundle opens and its salt and bytecode open its commitment", true);
  for (const x of C.checkOpening(o, { program: L.PROGRAM.toBase58(), genesisHash: (await F.clusterInfo()).genesisHash })) check(x.name, x.ok);
  const reg = await L.base.getAccountInfo(L.regPda(id)); if (reg && reg.data.readUInt32LE(0) === M_REG) { const g = C.parseRegistry(reg.data); check("the registry on base holds this commitment and owner", hex(g.commitment) === o.public.commitment && g.owner === o.public.owner); } else console.log("note: no open registry on base for this id (closed, or never created)");
  const season = val("--season");
  if (season) { const a = await L.base.getAccountInfo(L.receiptPda(BigInt(season))); if (!a) die("no receipt for that season", 1); const R = L.parseReceipt(a.data); const k = R.entries.findIndex(e => e.id === id); if (k < 0) die("this strategy is not on that receipt", 1); const e = R.entries[k];
    check("the receipt is back on base (owned by the program) and closed", a.owner.equals(L.PROGRAM) && a.data[144] === 2); if (!e.published) { console.log("note: this entry was never published, so the receipt carries no commitment to compare"); }
    else { check("the receipt's code commitment for this entry is the bundle's", hex(e.commit) === o.public.commitment);
      const A = await (await import("./author.mjs")).load(); const pins = F.vmPins(); if (pins) check("the receipt's VM rules are the ones this machine replays with", hex(R.pins) === pins);
      // each entry's run depends only on its own bytecode and the season's worlds, so one strategy replays alone
      const total = A.season([o.code], R.seedA, R.seedB, R.neps).totals[0]; const played = e.finalist && R.finals.status === 1; const ftotal = played ? A.season([o.code], R.finals.seedA, R.finals.seedB, R.finals.neps).totals[0] : 0n;
      check("replaying the bundle's bytecode on the receipt's seeds reproduces the on-chain score commitment (season and finals totals)", L.scoreCommit(o.salt, R.season, id, total, ftotal, R.neps, played ? R.finals.neps : 0).equals(e.score)); } }
  console.log(`${checks.filter(Boolean).length}/${checks.length} checks passed for strategy ${id}`); process.exit(checks.every(Boolean) ? 0 : 1);
}
