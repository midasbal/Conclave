// The first final copy of every receipt, kept for good. A reader who arrives late sees only the current bytes and cannot know what they were, so the builder saves them the first time it sees a receipt
// final, never writes that file again, and compares everything it sees later against it. Flags are kept for good: a receipt that changed and changed back stays flagged.
// This is a local folder. It protects against the CHAIN changing under you, not against someone who can edit your disk: publish or commit `digest` if others must be able to check your copies.
import fs from "fs"; import path from "path"; import crypto from "crypto";
import { sha256, DELEGATION_PROGRAM_ID } from "./chain.mjs";
import { RELEASE_FIELD } from "./receipt.mjs";

export const ALARMS = ["record-changed", "redelegated", "account-missing", "owner-changed", "multiple-delegations", "archive-damaged"];

export class Archive {
  constructor(dir, genesis, program) { this.root = path.join(dir, genesis, program); fs.mkdirSync(this.root, { recursive: true }); this.genesis = genesis; this.program = program; this.ledger = null; /* set by the service: every first copy and flag is then also written to its hash-chained ledger */ }
  dirOf(address) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error("not an address"); return path.join(this.root, address); }
  addresses() { return fs.readdirSync(this.root).filter(a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)).sort(); }
  readJson(address, name) { try { return JSON.parse(fs.readFileSync(path.join(this.dirOf(address), name), "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
  writeJson(address, name, value, { once = false } = {}) {
    const d = this.dirOf(address); fs.mkdirSync(d, { recursive: true }); const file = path.join(d, name), tmp = path.join(d, `.${name}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    const fd = fs.openSync(tmp, "wx"); try { fs.writeFileSync(fd, JSON.stringify(value, null, 1) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (once) { try { fs.linkSync(tmp, file); } finally { fs.unlinkSync(tmp); } } else fs.renameSync(tmp, file); // link fails if the file exists: a first copy is never replaced
  }
  /** the first final copy, or null. `damaged` if the file no longer agrees with its own hash or belongs elsewhere */
  first(address) {
    // only a file that reads but does not parse is damage. A read that fails (a disk error) is thrown: it says nothing about the copy, and calling it damage would raise a flag that is never removed
    let j; try { j = this.readJson(address, "first-final.json"); } catch (e) { if (!(e instanceof SyntaxError)) throw e; return { damaged: "the first copy cannot be parsed" }; }
    if (!j) return null; const data = Buffer.from(j.data ?? "", "base64");
    if (sha256(data).toString("hex") !== j.sha256 || j.address !== address || j.genesis !== this.genesis || j.program !== this.program) return { damaged: "the first copy does not match its own hash, address, cluster or program" };
    return { ...j, data };
  }
  saveFirst(address, { account, season, observedAt }) {
    const sha = sha256(account.data).toString("hex");
    this.writeJson(address, "first-final.json", { version: 1, genesis: this.genesis, program: this.program, address, season, sha256: sha, lamports: account.lamports, finalizedSlot: account.slot ?? null, observedAt, data: account.data.toString("base64") }, { once: true });
    this.ledger?.append({ type: "first-copy", address, season, sha256: sha, finalizedSlot: account.slot ?? null, observedAt });
  }
  flags(address) { return this.readJson(address, "flags.json") ?? []; }
  /** sticky and without repeats. Returns true if this flag is new */
  flag(address, f) { const all = this.flags(address); if (all.some(x => x.kind === f.kind && x.detail === f.detail)) return false; this.writeJson(address, "flags.json", [...all, f]); this.ledger?.append({ type: "flag", address, kind: f.kind, detail: f.detail, info: !!f.info }); return true; }
  seen(address) { return this.readJson(address, "observed.json") ?? { history: { examined: [], events: [] }, delegationRecords: [] }; }
  saveSeen(address, s) { this.writeJson(address, "observed.json", s); }
  /** hashes over every first copy this archive holds. `sha256` is over the exact bytes. `recordSha256` blanks the one field ReleaseBond zeroes, so two honest archives agree on it even if one first saw a
   *  receipt before its bond was released and the other after. Compare recordSha256 between archives; publish sha256 to commit to your own copies */
  digest() {
    const copies = this.addresses().map(a => [a, this.first(a)]).filter(([, f]) => f && !f.damaged);
    const over = lines => sha256(Buffer.from(lines.join("\n"))).toString("hex"); const [lo, hi] = RELEASE_FIELD;
    return { copies: copies.length, sha256: over(copies.map(([a, f]) => `${a} ${f.sha256}`)), recordSha256: over(copies.map(([a, f]) => { const d = Buffer.from(f.data); d.fill(0, lo, hi); return `${a} ${sha256(d).toString("hex")}`; })) };
  }
}

/** how the account now differs from the first final copy. Returns flags (possibly none) */
export function compareToFirst(firstData, current) {
  if (!current) return [{ kind: "account-missing", detail: "the account is gone" }];
  const out = [];
  if (current.owner === DELEGATION_PROGRAM_ID) out.push({ kind: "redelegated", detail: "the account is held by the delegation program again" });
  const a = firstData, b = current.data;
  if (a.equals(b)) return out;
  if (a.length !== b.length) return [...out, { kind: "record-changed", detail: `length ${a.length} to ${b.length}` }];
  const diff = []; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  const [lo, hi] = RELEASE_FIELD; const releaseOnly = diff.every(i => i >= lo && i < hi) && b.subarray(lo, hi).every(x => x === 0);
  if (releaseOnly) out.push({ kind: "bond-released", detail: "the releasable bond field went to zero, as ReleaseBond does. No result changed", info: true });
  else out.push({ kind: "record-changed", detail: `${diff.length} bytes differ, between offsets ${diff[0]} and ${diff.at(-1)}; now sha256 ${sha256(b).toString("hex")}` });
  return out;
}
