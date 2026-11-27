// The proof endpoints over real recorded receipts. Levels 1 and 3 are stateless; level 2 issues single-use, expiring challenges; level 4 is refused. Where a test needs a secret that no committed fixture can hold (a wallet we control as the
// owner, a score salt) it edits a COPY of the store's record and says SYNTHETIC: the receipt data around it is the recorded devnet data.
import test from "node:test"; import assert from "node:assert/strict"; import nacl from "tweetnacl"; import bs58 from "bs58"; import crypto from "node:crypto"; import Ajv2020 from "ajv/dist/2020.js";
import { defs } from "../src/api/schema.mjs"; import * as P from "../../verifier/lib/proofs.mjs"; import { load, buildStore, startApi, storeFiles, tmp, keysOf } from "./api_helpers.mjs";
const ajv = new Ajv2020({ strict: true }); const valid = (def, v) => { const f = ajv.compile({ $defs: defs, $ref: `#/$defs/${def}` }); assert.ok(f(v), `${def}: ${JSON.stringify(f.errors?.[0])}`); };
const TAPE = load("api"); const dir = await buildStore(TAPE); const A = await startApi({ dir }); const rec = storeFiles(dir).record(); test.after(() => A.close());
const settled = rec.seasons.find(s => s.kind === "settled" && s.status === "final" && s.entries.some(e => e.published)); const cancelled = rec.seasons.find(s => s.kind === "cancelled" && s.entries.length > 0);
const jpost = async (p, b, h) => { const r = await A.post(p, b, h); return { r, body: await r.json() }; };

test("level 1 verifies every entry of a real season against the first final copy, and says what it does and does not establish", async () => {
  for (const e of settled.entries) { const { r, body } = await jpost("/v1/proofs/recorded", { season: settled.season, strategyId: e.strategyId, codeCommitment: e.codeCommitment }); assert.equal(r.status, 200); valid("ProofResult", body); assert.equal(body.verified, true); assert.equal(body.level, "recorded"); assert.equal(body.entry.owner, e.owner); assert.equal(body.receipt.status, "final"); assert.match(body.receipt.from, /first final copy/); assert.ok(body.establishes.length > 0); assert.ok(body.doesNot.length >= 3); assert.deepEqual(body.blockers, []); }
  const e = settled.entries[0]; const wrong = (await jpost("/v1/proofs/recorded", { season: settled.season, strategyId: e.strategyId, codeCommitment: "11".repeat(32) })).body; assert.equal(wrong.verified, false); assert.deepEqual(wrong.establishes, [], "a failed check establishes nothing"); assert.ok(wrong.checks.some(c => !c.ok));
  const other = (await jpost("/v1/proofs/recorded", { season: settled.season, strategyId: "1", codeCommitment: e.codeCommitment })).body; assert.equal(other.verified, false); assert.equal(other.entry, null);
  const gone = await jpost("/v1/proofs/recorded", { season: "12345", strategyId: e.strategyId }); assert.equal(gone.r.status, 404); assert.equal(gone.body.error.type, "season_not_in_record");
  assert.match(JSON.stringify((await jpost("/v1/proofs/recorded", { season: settled.season, strategyId: e.strategyId })).body.doesNot), /trusts the system/);
});
test("level 1 is not a pass for a receipt that can still change, unless the caller says it accepts that", async () => {
  const d = await buildStore(load("provisional"), tmp()); const B = await startApi({ dir: d }); const s = storeFiles(d).record().seasons[0]; assert.equal(s.status, "provisional"); const e = s.entries[0];
  const no = await (await B.post("/v1/proofs/recorded", { season: s.season, strategyId: e.strategyId })).json(); assert.equal(no.verified, false); assert.ok(no.blockers.some(b => /PROVISIONAL/.test(b))); assert.equal(no.receipt.status, "provisional"); assert.deepEqual(no.establishes, []);
  const yes = await (await B.post("/v1/proofs/recorded", { season: s.season, strategyId: e.strategyId, allowProvisional: true })).json(); assert.equal(yes.verified, true); assert.deepEqual(yes.blockers, []); assert.equal(yes.receipt.status, "provisional"); valid("ProofResult", yes); await B.close();
});
test("SYNTHETIC: a receipt carrying an alarm flag passes no proof", async () => {
  const d = await buildStore(TAPE, tmp(), { mutate: f => { const r = f.record(); r.seasons.find(s => s.season === settled.season).flags.push({ kind: "redelegated", detail: "x", info: false, firstSeenAt: "2026-11-27T05:00:00.000Z" }); f.write(r); } });
  const B = await startApi({ dir: d }); const b = await (await B.post("/v1/proofs/recorded", { season: settled.season, strategyId: settled.entries[0].strategyId })).json(); assert.equal(b.verified, false); assert.deepEqual(b.blockers, ["the receipt is flagged: redelegated"]); assert.deepEqual(b.receipt.alarms, ["redelegated"]); await B.close();
});

test("level 3 refuses a salt that is not the score salt, totals that are not the entry's, and an entry with nothing to bind", async () => {
  const e = settled.entries.find(x => x.published); const base = { season: settled.season, strategyId: e.strategyId, total: "1000", finalsTotal: "0", scoreSalt: crypto.randomBytes(32).toString("hex") };
  const r = await jpost("/v1/proofs/totals", base); assert.equal(r.r.status, 200); valid("ProofResult", r.body); assert.equal(r.body.verified, false); assert.ok(r.body.checks.some(c => /binds these totals/.test(c.name) && !c.ok)); assert.deepEqual(r.body.claimed, { total: "1000", finalsTotal: "0" });
  const un = settled.entries.find(x => !x.published); if (un) { const b = (await jpost("/v1/proofs/totals", { ...base, strategyId: un.strategyId })).body; assert.equal(b.verified, false); assert.ok(b.checks.some(c => /published/.test(c.name) && !c.ok)); }
  const c = cancelled.entries[0]; const b = (await jpost("/v1/proofs/totals", { ...base, season: cancelled.season, strategyId: c.strategyId })).body; assert.equal(b.verified, false); assert.ok(b.checks.some(x => /played, not cancelled/.test(x.name) && !x.ok));
  for (const [what, body] of [["salt not hex", { ...base, scoreSalt: "zz".repeat(32) }], ["salt short", { ...base, scoreSalt: "ab".repeat(8) }], ["total not decimal", { ...base, total: "1e3" }], ["a missing field", { season: base.season, strategyId: base.strategyId }], ["an extra field", { ...base, extra: 1 }]]) { const x = await jpost("/v1/proofs/totals", body); assert.equal(x.r.status, 400, what); assert.equal(x.body.error.type, "invalid_request", what); valid("ErrorBody", x.body); }
  assert.equal((await jpost("/v1/proofs/totals", { ...base, total: "99999999999999999999" })).r.status, 400, "out of the signed 64-bit range");
  assert.match(JSON.stringify((await (await A.get("/v1/proofs")).json()).levels[2].doesNot), /tells its operator that season's totals/, "the levels list says what sending a score salt costs");
});
test("SYNTHETIC: with a score salt we hold, level 3 verifies the totals it binds and nothing else", async () => {
  const salt = crypto.randomBytes(32); const e = settled.entries.find(x => x.published); const fneps = e.finalist ? 15 : 0; const total = "123456", finals = e.finalist ? "7890" : "0";
  const d = await buildStore(TAPE, tmp(), { mutate: f => { const r = f.record(); const s = r.seasons.find(x => x.season === settled.season); s.entries.find(x => x.strategyId === e.strategyId).scoreCommitment = P.scoreCommit(salt, s.season, e.strategyId, BigInt(total), BigInt(finals), s.facts.episodes, fneps).toString("hex"); f.write(r); } });
  const B = await startApi({ dir: d }); const body = { season: settled.season, strategyId: e.strategyId, total, finalsTotal: finals, scoreSalt: salt.toString("hex") }; const ok = await (await B.post("/v1/proofs/totals", body)).json(); valid("ProofResult", ok); assert.equal(ok.verified, true); assert.equal(ok.level, "totals"); assert.ok(ok.establishes.length > 0); assert.ok(ok.doesNot.some(x => /Not which code produced the totals/.test(x)));
  assert.equal((await (await B.post("/v1/proofs/totals", { ...body, total: "123457" })).json()).verified, false); assert.equal((await (await B.post("/v1/proofs/totals", { ...body, scoreSalt: crypto.randomBytes(32).toString("hex") })).json()).verified, false);
  const sealed = salt; assert.equal((await (await B.post("/v1/proofs/totals", { ...body, scoreSalt: P.scoreSaltOf(sealed, settled.season).toString("hex") })).json()).verified, false, "a sealed salt offered as the score salt is not the score salt"); await B.close();
});

test("level 4 is never accepted: the server refuses it, refuses any request that carries a salt, bytecode or key, and never logs or keeps a body", async () => {
  const salt = "5ec2e7" + crypto.randomBytes(29).toString("hex"), code = "0102030405060708090a" + crypto.randomBytes(20).toString("hex"); const before = A.challenges.size(); A.logs.length = 0;
  const r = await jpost("/v1/proofs/code", { season: settled.season, strategyId: settled.entries[0].strategyId, salt, code }); assert.equal(r.r.status, 422); assert.equal(r.body.error.type, "level_4_not_accepted"); assert.match(r.body.error.message, /browser|verifier CLI/); valid("ErrorBody", r.body); assert.equal(r.r.headers.get("cache-control"), "no-store");
  for (const path of ["/v1/proofs/recorded", "/v1/proofs/totals", "/v1/proofs/wallet/challenges", "/v1/proofs/wallet/verify"]) for (const field of ["salt", "sealedSalt", "code", "bytecode", "source", "passphrase", "privateKey", "secret"]) { const x = await jpost(path, { season: settled.season, strategyId: settled.entries[0].strategyId, [field]: salt }); assert.equal(x.r.status, 400, `${path} ${field}`); assert.equal(x.body.error.type, "secret_field_refused", `${path} ${field}`); }
  assert.equal(A.challenges.size(), before, "nothing was stored"); const logged = A.logs.join("\n"); assert.ok(!logged.includes(salt) && !logged.includes(code) && !/5ec2e7/.test(logged), "no body is logged"); assert.ok(A.logs.every(l => /^(GET|POST|OPTIONS) \/v1\/[a-z/]+ \d{3} /.test(l)), "a log line is the method, the path and the status");
  const lv = await (await A.get("/v1/proofs")).json(); valid("ProofLevels", lv); assert.deepEqual(lv.levels.map(l => [l.level, l.where, l.endpoint === null]), [[1, "server", false], [2, "server", false], [3, "server", false], [4, "browser-or-cli", true]]); assert.match(lv.level4, /never accepted by this server/); assert.match(lv.level4, /never receives a salt or a bytecode/);
  assert.ok(!keysOf(lv).has("salt") && !keysOf(lv).has("code"));
});

const challengeFor = async (S = A, who = settled) => { const e = who.entries[0]; const r = await S.post("/v1/proofs/wallet/challenges", { season: who.season, strategyId: e.strategyId, askedBy: "api test verifier" }); return { r, body: await r.json(), e }; };
const sign = (body, kp) => Buffer.from(nacl.sign.detached(Buffer.from(body.signThis.bytes, "base64"), kp.secretKey)).toString("hex");
test("level 2 issues a challenge that is single-use and expires, and says exactly what to sign", async () => {
  const { r, body, e } = await challengeFor(); assert.equal(r.status, 200); valid("ChallengeIssued", body); assert.equal(body.singleUse, true); assert.equal(body.challenge.strategyId, e.strategyId); assert.equal(body.challenge.season, settled.season); assert.equal(body.challenge.askedBy, "api test verifier"); assert.match(body.challenge.nonce, /^[0-9a-f]{64}$/);
  const bytes = Buffer.from(body.signThis.bytes, "base64"); assert.equal(bytes[0], 0xff, "the signed bytes start 0xff: never a valid transaction"); assert.equal(bytes.subarray(1).toString(), body.signThis.text); assert.deepEqual(bytes, P.challengeMessage(body.challenge)); assert.match(body.signThis.text, /It is not a transaction/);
  assert.equal(Date.parse(body.expiresAt) - Date.parse(body.challenge.issuedAt), 10 * 60_000, "ten minutes"); assert.ok(A.challenges.size() >= 1);
});
test("level 2 refuses a wallet that is not the owner, burns the challenge on that first attempt, and answers a second try the same as an unknown one", async () => {
  const { body } = await challengeFor(); const wrong = nacl.sign.keyPair(); const a = await jpost("/v1/proofs/wallet/verify", { nonce: body.challenge.nonce, signature: sign(body, wrong) }); assert.equal(a.r.status, 200); valid("ProofResult", a.body); assert.equal(a.body.verified, false); assert.ok(a.body.checks.some(c => /signature is by the wallet/.test(c.name) && !c.ok)); assert.equal(a.body.level, "wallet");
  const again = await jpost("/v1/proofs/wallet/verify", { nonce: body.challenge.nonce, signature: sign(body, wrong) }); assert.equal(again.r.status, 404); assert.equal(again.body.error.type, "challenge_not_found");
  const unknown = await jpost("/v1/proofs/wallet/verify", { nonce: "ab".repeat(32), signature: "00".repeat(64) }); assert.equal(unknown.r.status, 404); assert.deepEqual(unknown.body.error, again.body.error, "used, unknown and expired are one answer");
});
test("level 2 challenges expire after ten minutes", async () => {
  const { body } = await challengeFor(); const held = A.challenges.size(); A.nowMs.v += 10 * 60_000 + 1000; const x = await jpost("/v1/proofs/wallet/verify", { nonce: body.challenge.nonce, signature: "00".repeat(64) }); assert.equal(x.r.status, 404); assert.equal(x.body.error.type, "challenge_not_found"); assert.equal(A.challenges.size(), held - 1, "an expired challenge that is asked for is removed from the store, not left to be tried again");
});
test("level 2 asks for a real entry, a plain-text asker, and never accepts the wrong shape", async () => {
  const e = settled.entries[0]; const st = (b) => jpost("/v1/proofs/wallet/challenges", b);
  assert.equal((await st({ season: "999", strategyId: e.strategyId, askedBy: "someone" })).r.status, 404); const no = await st({ season: settled.season, strategyId: "7", askedBy: "someone" }); assert.equal(no.r.status, 404); assert.equal(no.body.error.type, "strategy_not_on_season");
  for (const askedBy of ["ab", "x".repeat(121), "line\nbreak", "café verifier"]) { const x = await st({ season: settled.season, strategyId: e.strategyId, askedBy }); assert.equal(x.r.status, 400, JSON.stringify(askedBy)); }
  assert.equal((await jpost("/v1/proofs/wallet/verify", { nonce: "short", signature: "00".repeat(64) })).r.status, 400); assert.equal((await jpost("/v1/proofs/wallet/verify", { nonce: "ab".repeat(32), signature: "not hex" })).r.status, 400);
});
test("SYNTHETIC: a wallet we hold as the owner verifies, exactly once; another wallet, another asker's signature and a challenge for another entry do not", async () => {
  const kp = nacl.sign.keyPair(), pub = bs58.encode(kp.publicKey); const d = await buildStore(TAPE, tmp(), { mutate: f => { const r = f.record(); r.seasons.find(s => s.season === settled.season).entries[0].owner = pub; f.write(r); } });
  const B = await startApi({ dir: d }); const e = settled.entries[0]; const ask = async s => (await B.post("/v1/proofs/wallet/challenges", { season: settled.season, strategyId: s.strategyId, askedBy: "owner proof test" })).json();
  const c1 = await ask(e); const ok = await (await B.post("/v1/proofs/wallet/verify", { nonce: c1.challenge.nonce, signature: sign(c1, kp) })).json(); valid("ProofResult", ok); assert.equal(ok.verified, true); assert.equal(ok.entry.owner, pub); assert.equal(ok.level, "wallet"); assert.ok(ok.doesNot.some(x => /authorship|wrote the strategy|control/i.test(x)));
  assert.equal((await B.post("/v1/proofs/wallet/verify", { nonce: c1.challenge.nonce, signature: sign(c1, kp) })).status, 404, "answered once");
  const c2 = await ask(e), c3 = await ask(e); const moved = await (await B.post("/v1/proofs/wallet/verify", { nonce: c3.challenge.nonce, signature: sign(c2, kp) })).json(); assert.equal(moved.verified, false, "a signature made for one challenge is no answer to another");
  const other = settled.entries[1]; const c4 = await ask(other); assert.equal((await (await B.post("/v1/proofs/wallet/verify", { nonce: c4.challenge.nonce, signature: sign(c4, kp) })).json()).verified, false, "the same wallet is not the owner of a different entry");
  await B.close();
});
test("two answers sent at the same moment: exactly one is taken, the other finds the challenge gone", async () => {
  const kp = nacl.sign.keyPair(), pub = bs58.encode(kp.publicKey); const d = await buildStore(TAPE, tmp(), { mutate: f => { const r = f.record(); r.seasons.find(s => s.season === settled.season).entries[0].owner = pub; f.write(r); } }); const B = await startApi({ dir: d });
  const c = await (await B.post("/v1/proofs/wallet/challenges", { season: settled.season, strategyId: settled.entries[0].strategyId, askedBy: "race test" })).json(); const send = () => B.post("/v1/proofs/wallet/verify", { nonce: c.challenge.nonce, signature: sign(c, kp) });
  const got = await Promise.all([send(), send(), send(), send()]); assert.deepEqual(got.map(r => r.status).sort(), [200, 404, 404, 404]); await B.close();
});
test("the challenge store is capped and rate limited, and its code says it serves one instance", async () => {
  const B = await startApi({ dir, challengeMax: 3 }); const e = settled.entries[0]; const ask = () => B.post("/v1/proofs/wallet/challenges", { season: settled.season, strategyId: e.strategyId, askedBy: "cap test" });
  for (let i = 0; i < 3; i++) assert.equal((await ask()).status, 200); const full = await ask(); assert.equal(full.status, 503); assert.equal((await full.json()).error.type, "too_many_challenges"); B.nowMs.v += 11 * 60_000; assert.equal((await ask()).status, 200, "expired challenges make room"); await B.close();
  const L = await startApi({ dir, limits: { auth: 1000, open: 1000, player: 1000, api: 1000, challenge: 2 } }); const ask2 = () => L.post("/v1/proofs/wallet/challenges", { season: settled.season, strategyId: e.strategyId, askedBy: "rate test" }); assert.equal((await ask2()).status, 200); assert.equal((await ask2()).status, 200); const lim = await ask2(); assert.equal(lim.status, 429); assert.ok(lim.headers.get("retry-after")); await L.close();
  const fs = await import("node:fs"); const src = fs.readFileSync(new URL("../src/api/challenges.mjs", import.meta.url), "utf8"); assert.match(src, /IN MEMORY, so it is correct for ONE instance only/); assert.match(src, /shared store/); const doc = fs.readFileSync(new URL("../../docs/API.md", import.meta.url), "utf8"); assert.match(doc, /one instance/i);
});
