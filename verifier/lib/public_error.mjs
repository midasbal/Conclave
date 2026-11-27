// What the PUBLIC may be told about a failure. A raw message can carry anything: a file path from the disk, a host name, or whatever text an RPC put in its error. So nothing of it is passed through.
// The public text is built only from the fixed phrases below, plus at most a receipt address (public chain data), an HTTP status number and a count. A message this does not recognise gets the generic phrase.
// The full message stays where it belongs: in the service's log, and in status.json on the server's own disk.
const ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}";
const isAddress = v => typeof v === "string" && new RegExp(`^${ADDRESS}$`).test(v);

/** [how our own message begins, the step it names]. The first group, where there is one, is the receipt address */
const STEPS = [
  [new RegExp(`^reading the transaction history of (${ADDRESS}): `), "reading transaction history"],
  [new RegExp(`^the transaction history of (${ADDRESS}) was not read: `), "reading transaction history"],
  [new RegExp(`^reading the pool's transactions for (${ADDRESS}): `), "reading the stake token pool"],
  [new RegExp(`^the pool's transactions for (${ADDRESS}) were not read: `), "reading the stake token pool"],
  [new RegExp(`^the first copy of (${ADDRESS}) on disk is damaged: `), "reading a first final copy"],
  [new RegExp(`^processing (${ADDRESS}): `), "processing a receipt"],
  [/^reading the strategy registries: /, "reading the strategy registries"],
  [/^writing the record: /, "writing the record"],
  [/^writing the published copy of the record \(--out\): /, "writing the published copy of the record"],
  [/^(?=getGenesisHash on |this RPC serves cluster )/, "checking the RPC's cluster"],
  [/^(?=getProgramAccounts on )/, "listing the receipts"],
];
/** the phases of a cycle (lib/ingest.mjs), for a failure whose message names no step: a rate limit says who refused, not what was being read. Only these exact words are accepted */
export const PHASES = ["checking the RPC's cluster", "listing the receipts", "processing the receipts", "reading the strategy registries", "writing the record"];
export const GENERIC_REASON = "an unexpected error (the service log has the detail)";

/** rest: what follows the step in our message. whole: the message, for the shapes that are told apart by their beginning */
function reasonOf(rest, whole, rateLimited) {
  if (rateLimited || /^\S+ is rate limiting this client /.test(rest)) return "the RPC rate limited the request";
  if (/^this RPC serves cluster /.test(whole)) return "the RPC serves another cluster";
  if (/on disk is damaged: /.test(whole)) return "the copy on disk is damaged";
  if (/^base did not serve \d+ listed transaction\(s\)/.test(rest)) return "the RPC did not serve a transaction it listed";
  if (/ was not read: | were not read: /.test(whole)) return "not attempted after repeated failures";
  if (/^(ENOSPC|EDQUOT)\b/.test(rest)) return "the disk is full";
  if (/^E[A-Z0-9]{2,}\b/.test(rest)) return "a file could not be read or written";
  if (/^\w+ on \S+: no usable answer /.test(rest)) return "the RPC could not be reached";
  const http = /^\w+ on \S+: HTTP ([1-5]\d\d)\b/.exec(rest); if (http) return `the RPC answered HTTP ${http[1]}`;
  if (/^\w+ on \S+: /.test(rest)) return "the RPC returned an error";
  return GENERIC_REASON;
}

/** the failed step and a generic reason, as one line. `rateLimited`: the status's own rate-limit mark. `phase`: where the cycle was, used only if the message names no step */
export function publicFailure(message, { rateLimited = false, phase = null } = {}) {
  const whole = String(message ?? ""); let step = PHASES.includes(phase) ? phase : "the capture cycle", receipt = null, rest = whole;
  for (const [pattern, name] of STEPS) { const m = pattern.exec(whole); if (m) { step = name; receipt = m[1] ?? null; rest = whole.slice(m[0].length); break; } }
  const more = / \(and (\d{1,6}) more read failure\(s\) in this cycle\)$/.exec(whole);
  return `${step}${receipt ? ` (receipt ${receipt})` : ""}: ${reasonOf(rest, whole, rateLimited)}${more ? ` (and ${more[1]} more read failure(s) in this cycle)` : ""}`;
}

const SYNC_FAILED = "the backup mirror could not be synced: ";
const ALARM_TEXT = {
  "backup-mismatch": "a first final copy in the backup differs from the store's; neither was touched",
  "flags-regressed": "the backup holds a flag the store no longer has",
  "ledger-diverged": "the backup's ledger is not a prefix of the store's; nothing was overwritten",
};
/** a backup alarm for the public: a known kind with a fixed sentence */
export function publicBackupAlarm(a) {
  const address = isAddress(a?.address) ? a.address : null;
  if (a?.kind === "backup-sync-failed") { const d = String(a.detail ?? ""); return { kind: a.kind, address, detail: SYNC_FAILED + reasonOf(d.startsWith(SYNC_FAILED) ? d.slice(SYNC_FAILED.length) : d, d, false) }; }
  return Object.hasOwn(ALARM_TEXT, a?.kind) ? { kind: a.kind, address, detail: ALARM_TEXT[a.kind] } : { kind: "backup-alarm", address, detail: "the backup raised an alarm (the service log has the detail)" };
}
/** an operating system error code (ENOENT, EACCES) is generic; the message that comes with it is not */
/** the same, from the error as status.json records it */
export const publicStatusError = e => publicFailure(e?.message, { rateLimited: !!e?.rateLimited, phase: e?.phase });
export const publicCode = e => (typeof e?.code === "string" && /^E[A-Z0-9]{2,20}$/.test(e.code) ? e.code : "unreadable");
