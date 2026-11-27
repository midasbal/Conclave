// Server configuration comes from the environment (or *_FILE paths), never from the repo. Nothing here is printed.
import fs from "node:fs";
const read = (name) => { const f = process.env[`${name}_FILE`]; if (f) return fs.readFileSync(f, "utf8").trim(); return process.env[name]; };
/** how the client address is found, for the rate limiter.
 *  socket    the address of the connection itself. Right when the server is reached directly.
 *  global    one bucket for every caller. For a platform proxy whose forwarding headers are not established (see docs/DEPLOY_RAILWAY.md): no caller can spoof its way out of a limit, and no caller is told apart either.
 *  x-real-ip, xff-first   the address a proxy put in that header, when the operator has verified the proxy overwrites it. CONCLAVE_TRUST_PROXY=1 is the old name for xff-first. */
export const CLIENT_IP_MODES = ["socket", "global", "x-real-ip", "xff-first"];
/** the startup line: says what was actually loaded, and never a value. Neither an upstream URL (it may carry a provider key) nor the secret is printed */
export function startupLine(c) {
  const upstream = !c.upstream ? "none" : c.recordOnly ? "configured (used only for the /v1/status freshness read; not printed)" : "configured (not printed)";
  const secret = c.recordOnly ? (c.secret ? "set but not used" : "none") : "loaded (not printed)";
  return `conclave-server listening on ${c.host}:${c.port} mode=${c.recordOnly ? "record-only" : "full"} upstream=${upstream} secret=${secret} rollup=${c.rollupUpstream ? "configured (not printed)" : "none"} client-ip=${c.clientIp} origins=${c.origins.length} record-api=${c.storeDir ? "store configured" : "no store"}${c.recordOnly ? "" : ` audience=${c.audience}`}`;
}
export function loadConfig() {
  const recordOnly = process.env.CONCLAVE_RECORD_ONLY === "1";
  const secret = read("CONCLAVE_AUTH_SECRET"); const upstream = read("CONCLAVE_RPC_UPSTREAM") || (recordOnly ? read("CONCLAVE_VERIFIER_RPC") : undefined);
  // record-only: the public, read-only record API and nothing else. It needs no auth secret and no rollup, and it serves no route that calls the chain for a caller (it asks the RPC for one slot, now and then, for the freshness field)
  if (!recordOnly) {
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error("CONCLAVE_AUTH_SECRET (or _FILE) must be at least 32 bytes: openssl rand -base64 48");
    if (!upstream) throw new Error("CONCLAVE_RPC_UPSTREAM (or _FILE) is required: the RPC/indexer URL, including its API key if the provider uses one");
  } else if (!process.env.CONCLAVE_STORE_DIR) throw new Error("CONCLAVE_RECORD_ONLY=1 serves the record store, so CONCLAVE_STORE_DIR is required");
  const clientIp = process.env.CONCLAVE_CLIENT_IP || (process.env.CONCLAVE_TRUST_PROXY === "1" ? "xff-first" : "socket");
  if (!CLIENT_IP_MODES.includes(clientIp)) throw new Error(`CONCLAVE_CLIENT_IP must be one of ${CLIENT_IP_MODES.join(", ")}`);
  const g = clientIp === "global"; // with one bucket for everybody the per-client defaults would throttle everybody together: the defaults rise, and an operator can set any of them
  const num = (name, def) => +(process.env[name] || def);
  // optional: the rollup endpoint for public rollup-only accounts (the claims account). Without it /public/claims answers 404
  return { recordOnly, secret: secret ?? null, upstream: upstream ?? null, rollupUpstream: recordOnly ? null : read("CONCLAVE_ROLLUP_UPSTREAM") || null, audience: process.env.CONCLAVE_AUDIENCE || "conclave-api", programId: process.env.CONCLAVE_PROGRAM_ID || "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne",
    origins: (process.env.CONCLAVE_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean), port: +(process.env.PORT || 8787), host: process.env.HOST || "127.0.0.1", clientIp,
    limits: { auth: num("RATE_AUTH_PER_MIN", 20), open: num("RATE_OPEN_PER_MIN", 60), player: num("RATE_PLAYER_PER_MIN", 120), api: num("RATE_API_PER_MIN", g ? 3000 : 300), challenge: num("RATE_CHALLENGE_PER_MIN", g ? 300 : 30),
      gpaPlayer: num("RATE_GPA_PLAYER_PER_MIN", 4), gpaGlobal: num("RATE_GPA_GLOBAL_PER_MIN", 6) }, gpaCacheSeconds: num("CONCLAVE_GPA_CACHE_SECONDS", 60),
    // the record API: the store the capture loop writes (verifier/lib/ingest.mjs), and the counting rules in force
    storeDir: process.env.CONCLAVE_STORE_DIR || null, rulesFile: process.env.CONCLAVE_RULES_FILE || null, genesis: process.env.CONCLAVE_GENESIS || "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", staleAfterSeconds: num("CONCLAVE_STALE_AFTER_SECONDS", 300),
    pollSecondsDefault: num("CONCLAVE_POLL_SECONDS", 300), minFreeMb: num("CONCLAVE_MIN_FREE_MB", 64) };
}
