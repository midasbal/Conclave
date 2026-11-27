#!/usr/bin/env node
// The entrypoint of the Railway container: the capture daemon and the record API, as one unit (a Railway service gets one volume, so both run here, beside the same store).
// Configuration comes from the environment only; docs/DEPLOY_RAILWAY.md lists every variable and says which are secrets. Nothing secret is placed on a command line: the RPC URL reaches the daemon as an environment variable.
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { fileURLToPath, pathToFileURL } from "node:url";
import { supervise } from "./supervise.mjs";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const num = (env, name, def, min) => { const v = env[name] === undefined || env[name] === "" ? def : Number(env[name]); if (!Number.isFinite(v) || v < min) throw new Error(`${name} must be a number of at least ${min} (got "${env[name]}")`); return v; };

/** what to run, from the environment. Throws, naming the variable, when something required is missing. */
export function plan(env = process.env) {
  const rpc = env.CONCLAVE_VERIFIER_RPC; if (!rpc) throw new Error("CONCLAVE_VERIFIER_RPC is required: the dedicated devnet RPC URL the capture daemon reads (it holds a provider key, so set it as a secret). The public devnet RPC rate-limits this daemon.");
  const store = env.CONCLAVE_STORE_DIR || (env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, "store") : null);
  if (!store) throw new Error("CONCLAVE_STORE_DIR is required (or attach a Railway volume, whose mount path is RAILWAY_VOLUME_MOUNT_PATH): the capture daemon writes its store there");
  // the Railway default: poll every five minutes, sweep every hour (about the free RPC tier). We control when seasons settle, so a slow poll loses nothing: a receipt waits on base until ReleaseBond.
  const poll = num(env, "CONCLAVE_POLL_SECONDS", 300, 30), sweep = num(env, "CONCLAVE_SWEEP_MINUTES", 60, 1);
  // the record is built every cycle, so it is "stale" only after two missed polls and a minute
  const stale = num(env, "CONCLAVE_STALE_AFTER_SECONDS", 2 * poll + 60, 1);
  const common = { ...env, CONCLAVE_STORE_DIR: store, CONCLAVE_POLL_SECONDS: String(poll), CONCLAVE_SWEEP_MINUTES: String(sweep), CONCLAVE_STALE_AFTER_SECONDS: String(stale) };
  const ingestEnv = { ...common }; delete ingestEnv.CONCLAVE_AUTH_SECRET; // the daemon never needs the server's secret
  const apiEnv = { ...common, CONCLAVE_RECORD_ONLY: "1", HOST: env.HOST || "0.0.0.0", CONCLAVE_CLIENT_IP: env.CONCLAVE_CLIENT_IP || "global" };
  const backup = env.CONCLAVE_BACKUP_DIR ? ["--backup", env.CONCLAVE_BACKUP_DIR] : [];
  return { store, poll, sweep, stale, children: [
    { name: "ingest", command: process.execPath, args: [path.join(root, "verifier", "cli.mjs"), "ingest", "--store", store, "--poll-seconds", String(poll), "--sweep-minutes", String(sweep), ...backup], env: ingestEnv, cwd: root },
    { name: "api", command: process.execPath, args: [path.join(root, "server", "bin", "serve.mjs")], env: apiEnv, cwd: root } ] };
}

/** the volume must take the store's kind of writes before anything starts: create the folder, write and fsync a file, make a HARD LINK to it (the first final copy of a receipt is saved with one, so that it can never be replaced), remove both. A volume that is root-owned under a non-root process fails here, saying so, instead of a daemon that runs and records nothing. */
export function preflight(dir, { linkFn = fs.linkSync } = {}) {
  const why = e => `the store folder ${dir} cannot be used: ${e.code ?? ""} ${e.message}. On Railway the volume is mounted as root: run the service as root (RAILWAY_RUN_UID=0) or give its user the folder.`;
  const a = path.join(dir, `.preflight-${crypto.randomBytes(4).toString("hex")}`), b = a + ".link";
  try { fs.mkdirSync(dir, { recursive: true }); const fd = fs.openSync(a, "wx"); try { fs.writeSync(fd, "ok"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } linkFn(a, b); if (fs.readFileSync(b, "utf8") !== "ok") throw new Error("the link did not read back"); }
  catch (e) { throw new Error(e.message.startsWith("the store folder") ? e.message : why(e)); }
  finally { for (const f of [a, b]) { try { fs.rmSync(f, { force: true }); } catch { /* nothing was made, or it is already gone */ } } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let p; try { p = plan(); preflight(p.store); } catch (e) { console.error(`supervisor: ${e.message}`); process.exit(2); }
  console.error(`supervisor: store ${p.store}, poll every ${p.poll} s, sweep every ${p.sweep} min, record stale after ${p.stale} s; starting the capture daemon and the record API`);
  const drain = Number(process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS || 0); // the platform's own SIGTERM-to-SIGKILL window; the supervisor never waits longer than it was given
  const sup = supervise(p.children, { graceMs: Math.max(5, (drain || 30) - 3) * 1000 });
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => sup.shutdown(sig));
  process.exit(await sup.done);
}
