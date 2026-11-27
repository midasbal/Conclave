// The real thing: real transfers on devnet from the operator key in the environment. It starts the operator here, on a temporary state folder, so a
// deployed one is not touched. One top-up is spent (0.01 SOL by default).
//   OPERATOR_SECRET_KEY=... OPERATOR_RPC_URL=... npm run live
// This script never prints the key; it only checks that the operator's own output does not contain it.
// The recipient is a valid address for which no secret key exists, so what is sent to it cannot be recovered. LIVE_RECIPIENT overrides it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.OPERATOR_SECRET_KEY || !process.env.OPERATOR_RPC_URL) {
  console.error("BLOCKED: set OPERATOR_SECRET_KEY and OPERATOR_RPC_URL. This test makes real transfers and has no stand-in.");
  process.exit(2);
}
const TOPUP = Number(process.env.OPERATOR_TOPUP_SOL || 0.01);
function unownedAddress() { for (;;) { const key = new PublicKey(crypto.randomBytes(32)); if (PublicKey.isOnCurve(key.toBytes())) return key; } }
const first = process.env.LIVE_RECIPIENT ? new PublicKey(process.env.LIVE_RECIPIENT) : unownedAddress();
const second = unownedAddress();

const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => r(port)); }); });
const port = await freePort();
const url = `http://127.0.0.1:${port}`;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-live-"));
let output = "";
const start = () => {
  const child = spawn(process.execPath, ["bin/operator.mjs"], {
    cwd: root,
    // a cap with room for one top-up and not two, so that the second recipient meets it
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", OPERATOR_STATE_DIR: stateDir, OPERATOR_DAILY_CAP_SOL: String(TOPUP * 1.5), OPERATOR_SHARED_SECRET: "", RAILWAY_ENVIRONMENT: "", RAILWAY_PROJECT_ID: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", d => { output += d; });
  child.stderr.on("data", d => { output += d; });
  return child;
};
const up = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/health`)).ok) return; } catch { /* not yet */ } await new Promise(r => setTimeout(r, 200)); } throw new Error("the operator did not start"); };
const drip = async pubkey => { const r = await fetch(`${url}/drip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pubkey }) }); return { status: r.status, body: await r.json() }; };

let failed = 0;
const check = (ok, name, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  | " + detail : ""}`); };
const connection = new Connection(process.env.OPERATOR_RPC_URL, { commitment: "confirmed" });
let child = start();
try {
  await up();
  const healthz = await fetch(`${url}/healthz`);
  const health = await healthz.json();
  check(healthz.status === 200, "/healthz is 200 with the key loaded and funded", healthz.status === 200 ? `operator ${health.operator}, ${health.balanceLamports} lamports` : JSON.stringify(health.checks));
  if (healthz.status !== 200) throw new Error("not ready: nothing was sent");
  const operator = new PublicKey(health.operator);

  const sent = await drip(first.toBase58());
  check(sent.status === 200 && sent.body.status === "funded" && !!sent.body.signature, "drip to a throwaway address succeeds", JSON.stringify(sent.body));
  const tx = await connection.getParsedTransaction(sent.body.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const transfer = tx?.transaction.message.instructions.find(i => i.programId.equals(SystemProgram.programId))?.parsed;
  check(!!tx && !tx.meta.err && transfer?.type === "transfer" && transfer.info.source === operator.toBase58() && transfer.info.destination === first.toBase58() && transfer.info.lamports === sent.body.lamports, "confirmed on devnet: that transfer, from the operator, to that address, of that amount", `fee ${tx?.meta.fee} lamports`);
  const balance = await connection.getBalance(first, "confirmed");
  check(balance >= sent.body.lamports, "the recipient holds it", `${balance} lamports`);

  const before = await connection.getBalance(operator, "confirmed");
  const again = await drip(first.toBase58());
  const after = await connection.getBalance(operator, "confirmed");
  check(again.status === 200 && again.body.status === "already-funded" && before === after, "the balance gate skips a second call and nothing leaves the operator", JSON.stringify(again.body));

  const capped = await drip(second.toBase58());
  check(capped.status === 429 && capped.body.error?.code === "daily-cap" && (await connection.getBalance(second, "confirmed")) === 0, "past the daily cap the next address is refused and gets nothing", capped.body.error?.message ?? JSON.stringify(capped.body));

  child.kill("SIGTERM"); await new Promise(r => child.once("exit", r)); child = start(); await up();
  const restarted = await drip(second.toBase58());
  check(restarted.body.error?.code === "daily-cap", "the day's total survives a restart", restarted.body.error?.code ?? JSON.stringify(restarted.body));
} finally {
  child.kill("SIGTERM");
  const secret = process.env.OPERATOR_SECRET_KEY.trim();
  const rpcKey = new URL(process.env.OPERATOR_RPC_URL).searchParams.get("api-key");
  check(!output.includes(secret) && !output.includes(secret.slice(0, 24)) && !(rpcKey && output.includes(rpcKey)), "the operator's output holds neither the secret key nor the RPC key");
  console.log(`state folder: ${stateDir}\n== live: ${failed ? failed + " FAILED" : "all passed"}`);
  process.exitCode = failed ? 1 : 0;
}
