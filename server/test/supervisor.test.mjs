// The Railway entrypoint: two processes as one unit. These tests run REAL child processes (node -e scripts) under the real supervise(), and check by pid, with kill(pid, 0), that nothing is left running.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path"; import { supervise } from "../../deploy/supervise.mjs"; import { plan, preflight } from "../../deploy/supervisor.mjs"; import { tmp } from "./api_helpers.mjs";
const node = process.execPath; const spec = (name, code, extra = {}) => ({ name, command: node, args: ["-e", code], env: process.env, ...extra });
const FOREVER = `console.log("pid", process.pid); setInterval(() => {}, 1000)`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidFrom = lines => { const l = lines.find(x => /\bpid \d+/.test(x)); return l && Number(/pid (\d+)/.exec(l)[1]); };
const waitFor = async (f, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } throw new Error("timed out"); };
const gone = async pid => waitFor(() => !alive(pid));

test("when one process exits non-zero the other is stopped and the unit exits 1: no orphan", async () => {
  const lines = []; const sup = supervise([spec("ingest", FOREVER), spec("api", `setTimeout(() => process.exit(3), 300)`)], { log: l => lines.push(l), graceMs: 2000 });
  const pid = await waitFor(() => pidFrom(lines)); assert.ok(alive(pid)); assert.equal(await sup.done, 1); await gone(pid); assert.ok(lines.some(l => /api exited \(code 3\)/.test(l)), lines.join("|"));
});
test("when one process exits 0 the unit still exits non-zero: a daemon that finishes is a failure", async () => {
  const lines = []; const sup = supervise([spec("ingest", `setTimeout(() => process.exit(0), 200)`), spec("api", FOREVER)], { log: l => lines.push(l), graceMs: 2000 });
  const pid = await waitFor(() => pidFrom(lines)); assert.equal(await sup.done, 1); await gone(pid);
});
test("a process killed by a signal ends the unit too (the out-of-memory case)", async () => {
  const lines = []; const sup = supervise([spec("ingest", `setTimeout(() => process.kill(process.pid, "SIGKILL"), 300)`), spec("api", FOREVER)], { log: l => lines.push(l), graceMs: 2000 });
  const pid = await waitFor(() => pidFrom(lines)); assert.equal(await sup.done, 1); await gone(pid); assert.ok(lines.some(l => /signal SIGKILL/.test(l)));
});
test("a process that cannot start ends the unit, and the ones not yet started are never started", async () => {
  const lines = []; const sup = supervise([{ name: "ingest", command: "/no/such/binary", args: [] }, spec("api", FOREVER)], { log: l => lines.push(l), graceMs: 1000 }); assert.equal(await sup.done, 1); assert.ok(!lines.some(l => /pid \d+/.test(l)), "the second process was not started");
});
test("a requested shutdown (the platform's SIGTERM) stops both, lets them finish, and exits 0", async () => {
  const lines = []; const clean = `console.log("pid", process.pid); process.on("SIGTERM", () => { console.log("draining"); setTimeout(() => process.exit(0), 150); }); setInterval(() => {}, 1000)`;
  const sup = supervise([spec("ingest", clean), spec("api", clean)], { log: l => lines.push(l), graceMs: 3000 }); await waitFor(() => lines.filter(l => /pid \d+/.test(l)).length === 2); const pids = lines.filter(l => /pid \d+/.test(l)).map(l => Number(/pid (\d+)/.exec(l)[1]));
  sup.shutdown("SIGTERM"); assert.equal(await sup.done, 0); for (const p of pids) await gone(p); assert.equal(lines.filter(l => /draining/.test(l)).length, 2, "each was asked to stop and finished by itself");
});
test("a process that ignores SIGTERM is killed after the grace period, and the unit still ends", async () => {
  const lines = []; const stubborn = `console.log("pid", process.pid); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`;
  const sup = supervise([spec("ingest", stubborn), spec("api", `setTimeout(() => process.exit(1), 300)`)], { log: l => lines.push(l), graceMs: 400 }); const pid = await waitFor(() => pidFrom(lines)); const t0 = Date.now(); assert.equal(await sup.done, 1); await gone(pid);
  assert.ok(lines.some(l => /did not stop within 400 ms, killing it/.test(l)), lines.join("|")); assert.ok(Date.now() - t0 >= 300);
});
test("output is passed through with the process name in front", async () => {
  const lines = []; await supervise([spec("api", `console.log("hello"); console.error("oops"); process.exit(0)`)], { log: l => lines.push(l) }).done; assert.ok(lines.includes("[api] hello") && lines.includes("[api] oops"), lines.join("|"));
});

const ENV = { CONCLAVE_VERIFIER_RPC: "https://devnet.example/?api-key=SECRET-KEY-123", RAILWAY_VOLUME_MOUNT_PATH: "/data" };
test("plan: the Railway defaults, five-minute poll and hourly sweep, the store on the volume, the API on 0.0.0.0, record-only", () => {
  const p = plan(ENV); assert.equal(p.store, "/data/store"); assert.equal(p.poll, 300); assert.equal(p.sweep, 60); assert.equal(p.stale, 660);
  const [ing, api] = p.children; assert.deepEqual(ing.args.slice(1), ["ingest", "--store", "/data/store", "--poll-seconds", "300", "--sweep-minutes", "60"]);
  assert.equal(api.env.HOST, "0.0.0.0"); assert.equal(api.env.CONCLAVE_RECORD_ONLY, "1"); assert.equal(api.env.CONCLAVE_CLIENT_IP, "global"); assert.equal(api.env.CONCLAVE_STALE_AFTER_SECONDS, "660"); assert.equal(ing.env.CONCLAVE_VERIFIER_RPC, ENV.CONCLAVE_VERIFIER_RPC);
});
test("plan: every default is an environment variable; an explicit value always wins", () => {
  const p = plan({ ...ENV, CONCLAVE_STORE_DIR: "/vol/s", CONCLAVE_POLL_SECONDS: "60", CONCLAVE_SWEEP_MINUTES: "15", CONCLAVE_STALE_AFTER_SECONDS: "999", HOST: "127.0.0.1", CONCLAVE_CLIENT_IP: "x-real-ip", CONCLAVE_BACKUP_DIR: "/mirror" });
  assert.equal(p.store, "/vol/s"); assert.equal(p.stale, 999); assert.deepEqual(p.children[0].args.slice(3), ["/vol/s", "--poll-seconds", "60", "--sweep-minutes", "15", "--backup", "/mirror"]); assert.equal(p.children[1].env.HOST, "127.0.0.1"); assert.equal(p.children[1].env.CONCLAVE_CLIENT_IP, "x-real-ip");
});
test("plan: a missing RPC or store is refused by name; nonsense numbers are refused; no secret is on a command line; the daemon gets no server secret", () => {
  assert.throws(() => plan({ RAILWAY_VOLUME_MOUNT_PATH: "/data" }), /CONCLAVE_VERIFIER_RPC is required/); assert.throws(() => plan({ CONCLAVE_VERIFIER_RPC: "x" }), /CONCLAVE_STORE_DIR is required/);
  assert.throws(() => plan({ ...ENV, CONCLAVE_POLL_SECONDS: "5" }), /CONCLAVE_POLL_SECONDS must be a number of at least 30/); assert.throws(() => plan({ ...ENV, CONCLAVE_SWEEP_MINUTES: "abc" }), /CONCLAVE_SWEEP_MINUTES/);
  const p = plan({ ...ENV, CONCLAVE_AUTH_SECRET: "S".repeat(40) }); for (const c of p.children) assert.ok(!c.args.join(" ").includes("SECRET-KEY") && !c.args.join(" ").includes("S".repeat(10)), "nothing secret in argv"); assert.equal(p.children[0].env.CONCLAVE_AUTH_SECRET, undefined);
});
test("preflight: a usable folder passes and leaves nothing behind; one that cannot be written, or that cannot make a hard link, fails saying what to do", () => {
  const dir = path.join(tmp(), "store"); preflight(dir); assert.deepEqual(fs.readdirSync(dir), [], "the probe files are gone");
  const file = path.join(tmp(), "afile"); fs.writeFileSync(file, "x"); assert.throws(() => preflight(path.join(file, "store")), /cannot be used: ENOTDIR[\s\S]*RAILWAY_RUN_UID=0/);
  const d2 = path.join(tmp(), "s2"); assert.throws(() => preflight(d2, { linkFn: () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); } }), /cannot be used: EPERM/); assert.deepEqual(fs.readdirSync(d2), [], "a failed probe cleans up too");
});
