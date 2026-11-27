// Server configuration comes from the environment (or *_FILE paths), never from the repo. Nothing here is printed.
import fs from "node:fs";
const read = (name) => { const f = process.env[`${name}_FILE`]; if (f) return fs.readFileSync(f, "utf8").trim(); return process.env[name]; };
export function loadConfig() {
  const secret = read("CONCLAVE_AUTH_SECRET"); const upstream = read("CONCLAVE_RPC_UPSTREAM");
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error("CONCLAVE_AUTH_SECRET (or _FILE) must be at least 32 bytes: openssl rand -base64 48");
  if (!upstream) throw new Error("CONCLAVE_RPC_UPSTREAM (or _FILE) is required: the RPC/indexer URL, including its API key if the provider uses one");
  // optional: the rollup endpoint for public rollup-only accounts (the claims account). Without it /public/claims answers 404
  return { secret, upstream, rollupUpstream: read("CONCLAVE_ROLLUP_UPSTREAM") || null, audience: process.env.CONCLAVE_AUDIENCE || "conclave-api", programId: process.env.CONCLAVE_PROGRAM_ID || "HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne",
    origins: (process.env.CONCLAVE_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean), port: +(process.env.PORT || 8787), host: process.env.HOST || "127.0.0.1", trustProxy: process.env.CONCLAVE_TRUST_PROXY === "1",
    limits: { auth: +(process.env.RATE_AUTH_PER_MIN || 20), open: +(process.env.RATE_OPEN_PER_MIN || 60), player: +(process.env.RATE_PLAYER_PER_MIN || 120), api: +(process.env.RATE_API_PER_MIN || 300), challenge: +(process.env.RATE_CHALLENGE_PER_MIN || 30) },
    // the record API: the store the capture loop writes (verifier/lib/ingest.mjs), and the counting rules in force
    storeDir: process.env.CONCLAVE_STORE_DIR || null, rulesFile: process.env.CONCLAVE_RULES_FILE || null, genesis: process.env.CONCLAVE_GENESIS || "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", staleAfterSeconds: +(process.env.CONCLAVE_STALE_AFTER_SECONDS || 300) };
}
