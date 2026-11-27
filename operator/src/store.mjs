// What must survive a restart, in one JSON file on the volume: the day's total, the addresses already funded, and the transfers sent but not yet
// confirmed. A file that cannot be understood is never replaced: the service stops sending until a person has looked at it, because a fresh file would
// forget the day's total and let the cap be spent again.
import fs from "node:fs";
import path from "node:path";

export const STATE_FILE = "operator-state.json";
const fresh = day => ({ version: 1, day, spentLamports: 0, funded: {}, pending: {} });
const isMap = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function openStore(dir, today) {
  const file = path.join(dir, STATE_FILE);
  fs.mkdirSync(dir, { recursive: true });
  let state;
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw new Error(`the state file cannot be read (${e.code})`); }
  if (text === null) state = fresh(today());
  else {
    try { state = JSON.parse(text); } catch { throw new Error("the state file is not valid JSON; it is left as it is"); }
    if (state?.version !== 1 || typeof state.day !== "string" || !Number.isSafeInteger(state.spentLamports) || state.spentLamports < 0 || !isMap(state.funded) || !isMap(state.pending)) throw new Error("the state file does not have the expected shape; it is left as it is");
  }

  /** written to a temporary file, flushed, then renamed over the old one: a crash leaves the old state or the new, never part of one */
  function save() {
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = fs.openSync(temporary, "w", 0o600);
    try { fs.writeFileSync(handle, JSON.stringify(state)); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
    fs.renameSync(temporary, file);
    const folder = fs.openSync(dir, "r");
    try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); }
  }
  save(); // proves at once that the volume can be written

  return {
    file,
    get state() { return state; },
    /** a new UTC day starts the total again */
    roll() { if (state.day !== today()) { state.day = today(); state.spentLamports = 0; } },
    /** apply a change and keep it only if it reached the disk */
    commit(change) {
      const before = structuredClone(state);
      change(state);
      try { save(); } catch (e) { state = before; throw new Error(`the state could not be saved (${e.code ?? "unknown error"})`); }
    },
  };
}
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
