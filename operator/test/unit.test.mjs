// No key and no network. Real files on a real disk, and the real HTTP server on a real port, set up without a key (so that nothing could be sent).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig } from "../src/config.mjs";
import { parseSecretKey } from "../src/key.mjs";
import { parseAddress } from "../src/address.mjs";
import { addressKey, createWindow } from "../src/limits.mjs";
import { openStore, STATE_FILE } from "../src/store.mjs";
import { createRedactor } from "../src/redact.mjs";
import { createOperator } from "../src/server.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "operator-test-"));
const WALLET = "APUtAifQjb5jABveRQ2b6SUr9ctRtgnQsje4ma7P8LfW"; // a public wallet address
const env = extra => ({ OPERATOR_RPC_URL: "https://api.devnet.solana.com", OPERATOR_STATE_DIR: temp(), ...extra });

test("settings: what is missing or wrong is listed, and loading never throws", () => {
  const none = loadConfig({});
  assert.ok(none.problems.some(p => p.includes("OPERATOR_RPC_URL is not set")) && none.problems.some(p => p.includes("state directory")));
  assert.ok(loadConfig(env({ OPERATOR_RPC_URL: "https://devnet.helius-rpc.com/0000-not-a-parameter" })).problems.some(p => p.includes("without an api-key")));
  const helius = loadConfig(env({ OPERATOR_RPC_URL: "https://devnet.helius-rpc.com/?api-key=not-a-real-key" }));
  assert.deepEqual(helius.problems, []);
  assert.equal(helius.rpcHost, "devnet.helius-rpc.com");
  assert.ok(loadConfig(env({ OPERATOR_RPC_URL: "http://example.org/" })).problems.some(p => p.includes("https")));
  for (const [name, value] of [["OPERATOR_TOPUP_SOL", "1"], ["OPERATOR_TOPUP_SOL", "abc"], ["OPERATOR_DAILY_CAP_SOL", "-1"], ["OPERATOR_IP_PER_HOUR", "2.5"], ["OPERATOR_SHARED_SECRET", "short"]]) assert.ok(loadConfig(env({ [name]: value })).problems.some(p => p.includes(name)), `${name}=${value}`);
  assert.ok(loadConfig(env({ RAILWAY_ENVIRONMENT: "production" })).problems.some(p => p.includes("without a volume")));
  const defaults = loadConfig(env({}));
  assert.deepEqual([defaults.topupLamports, defaults.thresholdLamports, defaults.dailyCapLamports, defaults.sendsPerIpPerHour], [10_000_000, 10_000_000, 300_000_000, 5]);
});

test("the key: anything but a 64-byte secret key is refused, and the refusal repeats none of it", () => {
  for (const value of ["", "   ", "hello-this-is-not-a-key", "[1,2,3]", JSON.stringify(Array(64).fill(256)), JSON.stringify(Array(63).fill(7)), bs58.encode(new Uint8Array(32).fill(9)), "[not json"]) {
    const { keypair, problem } = parseSecretKey(value);
    assert.equal(keypair, null);
    assert.ok(problem.startsWith("OPERATOR_SECRET_KEY"));
    if (value.trim().length > 6) assert.ok(!problem.includes(value.trim().slice(0, 12)));
  }
});

test("addresses: a wallet address is accepted; a program-derived address and look-alikes are not", () => {
  assert.equal(parseAddress(WALLET)?.toBase58(), WALLET);
  const derived = PublicKey.findProgramAddressSync([Buffer.from("hub")], new PublicKey("HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne"))[0].toBase58();
  for (const bad of [derived, "", "abc", WALLET + "1", WALLET.slice(0, -3), WALLET.replace("A", "0"), 42, null, undefined, { toString: () => WALLET }]) assert.equal(parseAddress(bad), null, String(bad));
});

test("caller buckets: IPv4 as it is, IPv6 by its /64, anything else shared", () => {
  assert.equal(addressKey("203.0.113.9"), "203.0.113.9");
  assert.equal(addressKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(addressKey("2001:db8:1:2:3:4:5:6"), addressKey("2001:db8:1:2:ffff::1"));
  assert.notEqual(addressKey("2001:db8:1:2::1"), addressKey("2001:db8:1:3::1"));
  assert.equal(addressKey("not an address"), "unknown");
});

test("the hourly window slides", () => {
  let t = 0;
  const w = createWindow(2, () => t);
  w.add("a"); w.add("a");
  assert.ok(w.full("a") && !w.full("b"));
  t = 60 * 60 * 1000 + 1;
  assert.ok(!w.full("a"));
});

test("state: it survives a restart; a damaged file is left alone; a change that cannot be saved is undone", () => {
  const dir = temp();
  let day = "2030-01-01";
  const a = openStore(dir, () => day);
  a.commit(s => { s.spentLamports = 123; s.funded[WALLET] = { signature: "x" }; });
  const b = openStore(dir, () => day);
  assert.equal(b.state.spentLamports, 123);
  assert.ok(b.state.funded[WALLET]);
  day = "2030-01-02"; b.roll();
  assert.equal(b.state.spentLamports, 0);
  assert.ok(b.state.funded[WALLET], "the funded set is not reset by a new day");

  const file = path.join(dir, STATE_FILE);
  for (const damaged of ["{ not json", JSON.stringify({ version: 1, day: "x", spentLamports: -5, funded: {}, pending: {} })]) {
    fs.writeFileSync(file, damaged);
    assert.throws(() => openStore(dir, () => day), /left as it is/);
    assert.equal(fs.readFileSync(file, "utf8"), damaged);
  }

  const other = temp();
  const c = openStore(other, () => day);
  fs.rmSync(other, { recursive: true }); // the volume goes away
  assert.throws(() => c.commit(s => { s.spentLamports = 999; }), /could not be saved/);
  assert.equal(c.state.spentLamports, 0);
});

test("logs: the RPC key does not get through", () => {
  const redact = createRedactor(["https://devnet.helius-rpc.com/?api-key=abcdef12-3456-7890-abcd-ef1234567890"]);
  const line = redact(new Error("fetch https://devnet.helius-rpc.com/?api-key=abcdef12-3456-7890-abcd-ef1234567890 failed for key abcdef12-3456-7890-abcd-ef1234567890"));
  assert.ok(!line.includes("abcdef12-3456"), line);
});

async function started(extra) {
  const lines = [];
  const config = loadConfig(env(extra));
  const { server } = createOperator({ config, secretKey: undefined, log: l => lines.push(l) });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const drip = (body, headers = {}) => fetch(`${url}/drip`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { url, drip, lines, close: () => new Promise(r => server.close(r)) };
}
const code = async response => (await response.json()).error?.code;

test("HTTP without a key: /health is 200, /healthz is 503 and says why, /drip validates and then refuses", async () => {
  const s = await started({});
  try {
    assert.equal((await fetch(`${s.url}/health`)).status, 200);
    const healthz = await fetch(`${s.url}/healthz`);
    assert.equal(healthz.status, 503);
    assert.match(JSON.stringify(await healthz.json()), /OPERATOR_SECRET_KEY is not set/);
    const notReady = await s.drip({ pubkey: WALLET });
    assert.deepEqual([notReady.status, await code(notReady)], [503, "not-ready"]);
    assert.equal(await code(await s.drip({ pubkey: "nonsense" })), "bad-address");
    const extra = await s.drip({ pubkey: WALLET, secretKey: "PLANTED-SECRET-VALUE" });
    const text = await extra.text();
    assert.equal(extra.status, 400);
    assert.ok(!text.includes("PLANTED") && !s.lines.join().includes("PLANTED"), "an unexpected field is neither echoed nor logged");
    assert.equal((await s.drip("{broken")).status, 400);
    assert.equal((await s.drip({ pubkey: WALLET }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await s.drip({ pubkey: "1".repeat(3000) })).status, 413);
    assert.equal((await fetch(`${s.url}/drip`)).status, 405);
    assert.equal((await fetch(`${s.url}/other`)).status, 404);
  } finally { await s.close(); }
});

test("HTTP: the request limit counts by the forwarded address", async () => {
  const s = await started({ OPERATOR_REQUESTS_PER_IP_HOUR: "2" });
  try {
    const ask = ip => s.drip({ pubkey: WALLET }, { "x-forwarded-for": ip });
    assert.deepEqual([(await ask("203.0.113.1")).status, (await ask("203.0.113.1")).status, (await ask("203.0.113.1")).status, (await ask("203.0.113.2")).status], [503, 503, 429, 503]);
    // without a shared secret x-conclave-client-ip is not believed: this falls in x-forwarded-for's bucket, which is already full
    assert.equal((await s.drip({ pubkey: WALLET }, { "x-forwarded-for": "203.0.113.1", "x-conclave-client-ip": "203.0.113.77" })).status, 429);
  } finally { await s.close(); }
});

test("HTTP: with a shared secret, only its holder is answered, and its client-address header is the one counted", async () => {
  const secret = "test-only-shared-value-0123456789";
  const s = await started({ OPERATOR_SHARED_SECRET: secret, OPERATOR_REQUESTS_PER_IP_HOUR: "1" });
  try {
    assert.equal((await s.drip({ pubkey: WALLET })).status, 401);
    assert.equal((await s.drip({ pubkey: WALLET }, { "x-operator-secret": secret + "x" })).status, 401);
    const as = ip => s.drip({ pubkey: WALLET }, { "x-operator-secret": secret, "x-forwarded-for": "198.51.100.1", "x-conclave-client-ip": ip });
    assert.deepEqual([(await as("203.0.113.5")).status, (await as("203.0.113.5")).status, (await as("203.0.113.6")).status], [503, 429, 503]);
    assert.ok(!s.lines.join("\n").includes(secret));
  } finally { await s.close(); }
});
