// Runs several processes as one unit. If ANY of them exits, for any reason, the others are stopped and this process exits non-zero, so the container's restart policy brings the whole unit back.
// There is no restart of a single child on purpose: one process coming back alone beside a survivor is how a half-working container goes unnoticed.
import { spawn } from "node:child_process"; import readline from "node:readline";

/**
 * children: [{ name, command, args, env, cwd }]. graceMs: how long a child gets after SIGTERM before SIGKILL. log: where its own lines go (a child's output is passed through with "[name] " in front).
 * Returns { done, shutdown }. `done` resolves to the exit code: 1 when a child ended the run, 0 when shutdown() was asked for from outside and every child stopped.
 */
export function supervise(children, { graceMs = 25_000, log = line => console.error(line), spawnFn = spawn } = {}) {
  const live = new Map(); let ending = null, asked = false, finished = false, resolveDone; const done = new Promise(r => { resolveDone = r; });
  const finish = code => { if (finished) return; finished = true; resolveDone(code); };
  const stopAll = () => {
    for (const [, c] of live) if (c.proc.exitCode === null && c.proc.signalCode === null) c.proc.kill("SIGTERM");
    const hard = setTimeout(() => { for (const [name, c] of live) if (c.proc.exitCode === null && c.proc.signalCode === null) { log(`supervisor: ${name} did not stop within ${graceMs} ms, killing it`); c.proc.kill("SIGKILL"); } }, graceMs); hard.unref();
    const check = () => { if (live.size === 0) { clearTimeout(hard); finish(asked && !ending.child ? 0 : 1); } }; stopAll.check = check; check();
  };
  const begin = (why, child) => { if (ending) return; ending = { why, child }; log(`supervisor: ${why}; stopping the rest`); stopAll(); };
  for (const spec of children) {
    if (ending) break; // one already failed to start: do not start the rest
    let proc; try { proc = spawnFn(spec.command, spec.args ?? [], { env: spec.env ?? process.env, cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { log(`supervisor: ${spec.name} could not start (${e.message})`); begin(`${spec.name} could not start`, spec.name); continue; }
    live.set(spec.name, { proc, spec });
    for (const stream of [proc.stdout, proc.stderr]) if (stream) readline.createInterface({ input: stream }).on("line", l => log(`[${spec.name}] ${l}`));
    let gone = false; const exited = (code, signal) => { if (gone) return; gone = true; live.delete(spec.name); if (!ending) begin(`${spec.name} exited (${signal ? "signal " + signal : "code " + code})`, spec.name); else stopAll.check?.(); };
    proc.on("error", e => { log(`supervisor: ${spec.name}: ${e.message}`); exited(1, null); });
    proc.on("exit", exited);
  }
  if (live.size === 0 && !ending) finish(0);
  return { done, shutdown: why => { asked = true; begin(why ?? "shutdown requested", null); }, get children() { return [...live.keys()]; } };
}
