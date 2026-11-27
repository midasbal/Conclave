// The operator's HTTP surface: GET /health, GET /healthz, POST /drip. Request bodies are never logged.
import http from "node:http";
import crypto from "node:crypto";
import { Connection } from "@solana/web3.js";
import { FEE_LAMPORTS } from "./config.mjs";
import { parseSecretKey } from "./key.mjs";
import { parseAddress } from "./address.mjs";
import { createWindow, addressKey } from "./limits.mjs";
import { openStore, utcDay } from "./store.mjs";
import { createRedactor } from "./redact.mjs";
import { createDripper, Refusal } from "./drip.mjs";

const MAX_BODY = 1024;
const HEALTH_CACHE_MS = 20_000;

const digest = value => crypto.createHash("sha256").update(value).digest();

export function createOperator({ config, secretKey, log = line => console.log(line), now = () => Date.now() }) {
  const { keypair, problem: keyProblem } = parseSecretKey(secretKey);
  const redact = createRedactor([config.rpcUrl, config.sharedSecret, secretKey]);
  let store = null, storeProblem = null;
  if (config.stateDir) { try { store = openStore(config.stateDir, () => utcDay(now())); } catch (e) { storeProblem = redact(e); } }
  const problems = [...config.problems, ...(keyProblem ? [keyProblem] : []), ...(storeProblem ? [storeProblem] : [])];
  const connection = config.rpcUrl ? new Connection(config.rpcUrl, { commitment: "confirmed", disableRetryOnRateLimit: true }) : null;
  const dripper = !problems.length && connection && store ? createDripper({ config, keypair, store, connection, redact, log, now }) : null;

  const perIp = createWindow(config.requestsPerIpPerHour, now);
  const overall = createWindow(config.requestsPerHour, now);

  let cached = null;
  async function readiness() {
    if (cached && now() - cached.at < HEALTH_CACHE_MS) return cached.value;
    const checks = [{ name: "configuration", ok: problems.length === 0, detail: problems.join("; ") || "complete" }];
    let funded = false, balance = null;
    if (dripper) {
      try {
        await dripper.prove();
        checks.push({ name: "devnet-and-key", ok: true, detail: "devnet, and the key is not the upgrade authority" });
        balance = await dripper.operatorBalance();
        funded = balance >= config.topupLamports + FEE_LAMPORTS;
        checks.push({ name: "funded", ok: funded, detail: funded ? "holds at least one top-up" : "does not hold one top-up and its fee" });
      } catch (e) {
        checks.push({ name: "devnet-and-key", ok: false, detail: e instanceof Refusal ? e.message : "the check could not be made" });
      }
    }
    const value = {
      ok: !!dripper && funded && checks.every(c => c.ok),
      checks,
      operator: keypair ? keypair.publicKey.toBase58() : null,
      balanceLamports: balance,
      topupLamports: config.topupLamports,
      dailyCapLamports: config.dailyCapLamports,
      spentTodayLamports: dripper ? dripper.spentToday() : null,
      pendingTransfers: dripper ? dripper.pendingCount() : null,
      sharedSecretRequired: !!config.sharedSecret,
      rpcHost: config.rpcHost,
    };
    cached = { at: now(), value };
    return value;
  }

  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  const refuse = (res, r) => send(res, r.status, { error: { code: r.code, message: r.message, retryable: r.retryable } });

  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    // past the limit nothing more is kept, but the rest is still read, so that the caller is told why instead of finding the connection cut
    req.on("data", chunk => { size += chunk.length; if (size <= MAX_BODY) parts.push(chunk); else if (size > 64 * MAX_BODY) req.destroy(); });
    req.on("end", () => (size > MAX_BODY ? reject(new Refusal(413, "too-large", "The request is too large.")) : resolve(Buffer.concat(parts).toString("utf8"))));
    req.on("error", reject);
  });

  /** who is asking. A forwarded address is only a claim: it is taken from our own proxy's header when the caller proved it is that proxy, and otherwise
   *  from x-forwarded-for, which anyone calling this service directly can write as they like. The limit it feeds is a soft one */
  function callerKey(req, trusted) {
    const first = name => String(req.headers[name] ?? "").split(",")[0].trim();
    const claimed = (trusted ? first("x-conclave-client-ip") : "") || first("x-forwarded-for") || req.socket.remoteAddress || "";
    return addressKey(claimed);
  }

  async function handleDrip(req, res) {
    let trusted = false;
    if (config.sharedSecret) {
      const given = String(req.headers["x-operator-secret"] ?? "");
      if (!crypto.timingSafeEqual(digest(given), digest(config.sharedSecret))) throw new Refusal(401, "unauthorized", "Not authorized.");
      trusted = true;
    }
    const ip = callerKey(req, trusted);
    if (perIp.full(ip) || overall.full("all")) throw new Refusal(429, "rate-limited", "Too many requests. Try again later.", true);
    perIp.add(ip); overall.add("all");

    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) throw new Refusal(415, "bad-request", "Send JSON.");
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { throw e instanceof Refusal ? e : new Refusal(400, "bad-request", "The body is not valid JSON."); }
    // the one field there is. Anything else is refused unread, so that a secret sent by mistake is never accepted, stored or logged
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => k !== "pubkey")) throw new Refusal(400, "bad-request", "Send only a pubkey.");
    const recipient = parseAddress(body.pubkey);
    if (!recipient) throw new Refusal(400, "bad-address", "That is not a Solana wallet address.");
    if (!dripper) throw new Refusal(503, "not-ready", "Funding is not available: the operator is not set up.");
    send(res, 200, await dripper.drip(recipient, ip));
  }

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    void (async () => {
      try {
        if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
        if (req.method === "GET" && path === "/healthz") { const r = await readiness(); return send(res, r.ok ? 200 : 503, r); }
        if (path === "/drip") {
          if (req.method !== "POST") return send(res, 405, { error: { code: "method", message: "Use POST.", retryable: false } });
          return await handleDrip(req, res);
        }
        return send(res, 404, { error: { code: "not-found", message: "Not found.", retryable: false } });
      } catch (e) {
        if (e instanceof Refusal) { if (!res.headersSent) refuse(res, e); return; }
        log(`request failed: ${redact(e)}`);
        if (!res.headersSent) refuse(res, new Refusal(500, "internal", "The operator failed. Try again.", true));
      }
    })();
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;

  const startupLines = [
    `conclave operator | rpc host ${config.rpcHost ?? "none"} | key ${keypair ? "loaded, address " + keypair.publicKey.toBase58() : "not loaded"}`,
    `top-up ${config.topupLamports} lamports, daily cap ${config.dailyCapLamports}, ${config.sendsPerIpPerHour} sends per address per hour | shared secret ${config.sharedSecret ? "required" : "NOT SET: anyone who finds this service can call it, with any claimed address"}`,
    ...problems.map(p => `not ready: ${p}`),
  ];
  return { server, readiness, startupLines };
}
