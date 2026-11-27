// Real devnet, no secret key anywhere. The dripper is given only a PUBLIC address as the operator's, which is enough for everything that happens before
// signing: the devnet and upgrade-key checks, the balance gate, the daily cap, the empty-wallet refusal, and what becomes of a transfer left pending
// (asked of the chain with a real confirmed signature, and with one that does not exist). Nothing here can send: there is nothing to sign with.
//   node --test test/devnet.test.mjs        OPERATOR_RPC_URL if set, otherwise the public devnet node
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { loadConfig, FEE_LAMPORTS } from "../src/config.mjs";
import { openStore, utcDay } from "../src/store.mjs";
import { createRedactor } from "../src/redact.mjs";
import { createDripper } from "../src/drip.mjs";

const url = process.env.OPERATOR_RPC_URL || "https://api.devnet.solana.com";
// the public node answers 429 to a burst: the tests are spaced out. A 429 that still happens fails the test, and the failure says so
beforeEach(() => new Promise(r => setTimeout(r, 4000)));
const connection = new Connection(url, { commitment: "confirmed" });
/** 32 random bytes that are a point on the curve: a valid address for which no secret key was ever made */
function unownedAddress() { for (;;) { const key = new PublicKey(crypto.randomBytes(32)); if (PublicKey.isOnCurve(key.toBytes())) return key; } }
const UPGRADE_AUTHORITY = new PublicKey("APUtAifQjb5jABveRQ2b6SUr9ctRtgnQsje4ma7P8LfW"); // public; it holds devnet SOL
/** the signature of the program's upgrade on devnet, recorded in program/LIFECYCLE.md: a real confirmed transaction */
const CONFIRMED = "ayJ1Xw6rqpEEQUsXKQUNZFfoYqJUHzPjhsbJb8yp471UsELDpqx6ZZ3QGdN1MFx91QDrH7trjNawbESmEKQ6q3M";

function dripper(operatorAddress, settings = {}, seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-devnet-"));
  const config = loadConfig({ OPERATOR_RPC_URL: url, OPERATOR_STATE_DIR: dir, OPERATOR_CONFIRM_TIMEOUT_SECONDS: "5", ...settings });
  assert.deepEqual(config.problems, []);
  const store = openStore(dir, utcDay);
  if (seed) store.commit(seed);
  const lines = [];
  return { store, lines, config, d: createDripper({ config, keypair: { publicKey: operatorAddress }, store, connection, redact: createRedactor([url]), log: l => lines.push(l) }) };
}
const refusal = code => e => e.code === code;
/** the refusal expected, or a failure that says what came instead and what the dripper logged */
async function refuses(promise, code, lines, why = "") {
  const outcome = await promise.then(v => ({ answered: v }), e => ({ code: e.code, message: e.message }));
  assert.equal(outcome.code, code, `${why} expected ${code}, got ${JSON.stringify(outcome)} | log: ${lines.join(" / ")}`);
}

test("an operator key that is the program's upgrade authority is refused, from the chain's own data", async () => {
  const { d } = dripper(UPGRADE_AUTHORITY);
  await assert.rejects(d.drip(unownedAddress(), "t"), refusal("wrong-key"));
});

test("the balance gate: an address that already holds the threshold is not sent anything", async () => {
  const { d, store } = dripper(unownedAddress());
  const answer = await d.drip(UPGRADE_AUTHORITY, "t");
  assert.equal(answer.status, "already-funded");
  assert.ok(answer.balanceLamports >= 10_000_000);
  assert.equal(store.state.spentLamports, 0);
});

test("an account that is not a plain wallet is refused", async () => {
  const { d } = dripper(unownedAddress(), { OPERATOR_THRESHOLD_SOL: "1" });
  await assert.rejects(d.drip(new PublicKey("SysvarC1ock11111111111111111111111111111111"), "t"), refusal("bad-address"));
});

test("the daily cap refuses before anything is signed, and counts what the day has already spent", async () => {
  const small = dripper(unownedAddress(), { OPERATOR_DAILY_CAP_SOL: "0.009" });
  await assert.rejects(small.d.drip(unownedAddress(), "t"), refusal("daily-cap"));
  const nearly = dripper(unownedAddress(), { OPERATOR_DAILY_CAP_SOL: "0.3" }, s => { s.spentLamports = 300_000_000 - 10_000_000 - FEE_LAMPORTS + 1; });
  await assert.rejects(nearly.d.drip(unownedAddress(), "t"), refusal("daily-cap"));
  const yesterday = dripper(unownedAddress(), {}, s => { s.day = "2000-01-01"; s.spentLamports = 300_000_000; });
  await assert.rejects(yesterday.d.drip(unownedAddress(), "t"), refusal("operator-empty"), "a new day starts the total again, so the next check is the wallet");
});

test("an operator wallet without the funds sends nothing and reserves nothing", async () => {
  const { d, store } = dripper(unownedAddress());
  await assert.rejects(d.drip(unownedAddress(), "t"), refusal("operator-empty"));
  assert.deepEqual([store.state.spentLamports, Object.keys(store.state.pending).length], [0, 0]);
});

test("an address funded once, now below the threshold, is not funded again", async () => {
  const address = unownedAddress();
  const { d } = dripper(unownedAddress(), {}, s => { s.funded[address.toBase58()] = { signature: CONFIRMED, lamports: 10_000_000 }; });
  await assert.rejects(d.drip(address, "t"), refusal("already-used"));
});

test("a pending transfer the chain has confirmed is reported as funded, without sending again", async () => {
  const address = unownedAddress();
  const { d, store } = dripper(unownedAddress(), {}, s => { s.spentLamports = 10_005_000; s.pending[address.toBase58()] = { signature: CONFIRMED, lamports: 10_000_000, lastValidBlockHeight: 1, day: s.day }; });
  const answer = await d.drip(address, "t");
  assert.deepEqual([answer.status, answer.signature], ["funded", CONFIRMED]);
  assert.deepEqual([store.state.spentLamports, Object.keys(store.state.pending).length, !!store.state.funded[address.toBase58()]], [10_005_000, 0, true]);
});

test("a pending transfer that can no longer land gives its reservation back", async () => {
  const address = unownedAddress();
  const nowhere = bs58.encode(crypto.randomBytes(64));
  const { d, store, lines } = dripper(unownedAddress(), {}, s => { s.spentLamports = 10_005_000; s.pending[address.toBase58()] = { signature: nowhere, lamports: 10_000_000, lastValidBlockHeight: 1, day: s.day }; });
  await refuses(d.drip(address, "t"), "operator-empty", lines, "released, and only then would it try to send again:");
  assert.deepEqual([store.state.spentLamports, Object.keys(store.state.pending).length], [0, 0]);
});

test("a pending transfer that might still land is never sent twice: not confirmed, and still reserved", async () => {
  const address = unownedAddress();
  const nowhere = bs58.encode(crypto.randomBytes(64));
  const height = await connection.getBlockHeight("confirmed");
  const { d, store } = dripper(unownedAddress(), {}, s => { s.spentLamports = 10_005_000; s.pending[address.toBase58()] = { signature: nowhere, lamports: 10_000_000, lastValidBlockHeight: height + 10_000, day: s.day }; });
  await assert.rejects(d.drip(address, "t"), e => e.code === "not-confirmed" && e.retryable);
  assert.deepEqual([store.state.spentLamports, store.state.pending[address.toBase58()]?.signature], [10_005_000, nowhere]);
});
