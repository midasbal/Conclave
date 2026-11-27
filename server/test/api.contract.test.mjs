// The v1 contract, enforced. A store is built by the real capture loop over responses recorded from devnet (verifier/test/fixtures/devnet-api.json: 29 final seasons, 120 strategies), a real server is started on top of
// it, and EVERY response is validated against the schema with ajv, a complete JSON Schema validator. Anything not described by the schema fails: the contract cannot drift without schema.mjs (and the committed openapi.v1.json) changing.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url"; import Ajv2020 from "ajv/dist/2020.js";
import { defs, routes, openapi } from "../src/api/schema.mjs"; import { check } from "../src/api/validate.mjs"; import { NOTICE } from "../src/api/notices.mjs"; import { evaluate } from "../../verifier/policy/official.mjs";
import { load, buildStore, startApi, EXAMPLE_RULES, keysOf, stringsOf, storeFiles, tmp } from "./api_helpers.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const TAPE = load("api"); const ajv = new Ajv2020({ strict: true, allErrors: false });
const validators = {}; const validate = (def, v) => { validators[def] ??= ajv.compile({ $defs: defs, $ref: `#/$defs/${def}` }); const ok = validators[def](v); const mine = check({ $ref: `#/$defs/${def}` }, v); assert.equal(!mine, ok, `ajv and the server's own validator disagree on ${def}: ajv ${ok ? "accepts" : JSON.stringify(validators[def].errors?.[0])}, server ${mine ?? "accepts"}`); return ok ? null : `${validators[def].errors[0].instancePath} ${validators[def].errors[0].message}`; };
const dir = await buildStore(TAPE); const A = await startApi({ dir }); const json = async (p, h) => { const r = await A.get(p, h); return { r, body: r.status === 304 ? null : await r.json() }; };
const route = id => routes.find(r => r.id === id); const record = () => storeFiles(dir).record();
test.after(() => A.close());

test("the contract compiles under strict ajv, and nothing in it can carry a strategy's secrets", () => {
  for (const name of Object.keys(defs)) ajv.compile({ $defs: defs, $ref: `#/$defs/${name}` });
  const walk = (s, out = []) => { if (Array.isArray(s)) s.forEach(x => walk(x, out)); else if (s && typeof s === "object") { for (const k of Object.keys(s.properties ?? {})) out.push(k); Object.values(s).forEach(x => walk(x, out)); } return out; };
  const fields = walk(defs); assert.ok(fields.length > 150); assert.deepEqual(fields.filter(f => /^(salt|sealedsalt|code|bytecode|source|secret|passphrase|privatekey|seed)$/i.test(f)), [], "no field of any response or request is a secret");
  for (const d of Object.values(defs)) if (d.type === "object") assert.equal(d.additionalProperties, false, "every object is closed: an extra field is a contract failure");
  for (const r of routes) { if (r.response) assert.ok(defs[r.response], r.id); if (r.request) assert.ok(defs[r.request], r.id); }
});
test("the committed OpenAPI document is exactly what the schema generates", () => { assert.deepEqual(JSON.parse(fs.readFileSync(path.join(here, "..", "openapi.v1.json"), "utf8")), JSON.parse(JSON.stringify(openapi())), "run: node server/bin/gen-openapi.mjs"); });
test("every route in the contract is served, and the server serves no v1 route that the contract does not list", async () => {
  const ids = new Set(); const r = await json("/v1/openapi.json"); const doc = r.body; assert.equal(doc.openapi, "3.1.0");
  for (const [p, ops] of Object.entries(doc.paths)) for (const [m, op] of Object.entries(ops)) ids.add(op.operationId);
  assert.deepEqual([...ids].sort(), routes.map(x => x.id).sort()); assert.equal((await A.get("/v1/nothing")).status, 404); assert.equal((await A.get("/v1/seasons/1/extra")).status, 404);
});

test("every GET response of the whole record validates against the schema, and every permalink in it resolves", async () => {
  const seen = new Map(); const queue = ["/v1/leaderboard", "/v1/seasons?limit=200", "/v1/legacy", "/v1/status", "/v1/proofs"]; let n = 0;
  const defFor = p => p === "/v1/leaderboard" ? "Leaderboard" : p.startsWith("/v1/seasons?") ? "SeasonList" : /^\/v1\/seasons\/\d+$/.test(p) ? "SeasonDetail" : p.startsWith("/v1/strategies/") ? "StrategyPage" : p.startsWith("/v1/wallets/") ? "WalletPage" : p.startsWith("/v1/commitments/") ? "CommitmentPage" : p === "/v1/legacy" ? "Legacy" : p === "/v1/status" ? "Status" : "ProofLevels";
  while (queue.length) { const p = queue.shift(); if (seen.has(p)) continue; const { r, body } = await json(p); assert.equal(r.status, 200, p); const why = validate(defFor(p), body); assert.equal(why, null, `${p}: ${why}`); seen.set(p, body); n++;
    for (const s of stringsOf(body)) if (/^\/v1\/(seasons|strategies|wallets|commitments)\/[^/?]+$/.test(s) && !seen.has(s)) queue.push(s); }
  const rec = record(); const has = p => seen.has(p);
  assert.ok(rec.seasons.every(s => has(`/v1/seasons/${s.season}`)), "every season has a page"); assert.ok(Object.keys(rec.views.strategies).every(id => has(`/v1/strategies/${id}`)), "every strategy"); assert.ok(Object.keys(rec.views.wallets).every(w => has(`/v1/wallets/${w}`)), "every wallet"); assert.ok(Object.keys(rec.views.commitments).every(c => has(`/v1/commitments/${c}`)), "every commitment");
  for (const [p, b] of seen) if (b.permalink && !p.includes("?")) assert.equal(b.permalink, p, "a page's permalink is the address it is served at");
  assert.equal(n, 5 + 29 + 120 + 6 + 120, `${n} responses validated: every page of the record`);
});

test("cache headers: public data is cacheable and revalidated by ETag; proofs, challenges and errors are never cached", async () => {
  for (const p of ["/v1/leaderboard", "/v1/seasons", `/v1/seasons/${record().seasons[0].season}`, "/v1/legacy"]) { const { r } = await json(p); assert.equal(r.headers.get("cache-control"), "public, max-age=30, s-maxage=60, stale-while-revalidate=300", p); assert.match(r.headers.get("etag"), /^"[0-9a-f]{32}"$/); assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8"); assert.equal(r.headers.get("x-content-type-options"), "nosniff"); }
  assert.equal((await A.get("/v1/status")).headers.get("cache-control"), "public, max-age=5"); assert.equal((await A.get("/v1/proofs")).headers.get("cache-control"), "public, max-age=3600"); assert.equal((await A.get("/v1/openapi.json")).headers.get("cache-control"), "public, max-age=3600");
  const first = await A.get("/v1/leaderboard"); const etag = first.headers.get("etag"); await first.arrayBuffer(); const again = await A.get("/v1/leaderboard", { "if-none-match": etag }); assert.equal(again.status, 304); assert.equal((await again.arrayBuffer()).byteLength, 0); assert.equal(again.headers.get("etag"), etag);
  assert.equal((await A.get("/v1/leaderboard", { "if-none-match": '"someotheretag"' })).status, 200); assert.equal((await A.get("/v1/leaderboard?limit=5")).headers.get("etag") === etag, false, "a different answer has a different ETag");
  for (const p of ["/v1/seasons/999999999999", "/v1/strategies/abc", "/v1/nothing"]) { const r = await A.get(p); assert.ok(r.status >= 400); assert.equal(r.headers.get("cache-control"), "no-store", p); const b = await r.json(); assert.equal(validate("ErrorBody", b), null); }
  const c = await A.post("/v1/proofs/wallet/challenges", { season: record().seasons[0].season, strategyId: record().seasons[0].entries[0].strategyId, askedBy: "cache test" }); assert.equal(c.headers.get("cache-control"), "no-store"); assert.equal(c.headers.get("etag"), null);
  assert.equal((await A.get(`/v1/seasons/${record().seasons[0].season}`)).headers.get("content-location"), `/v1/seasons/${record().seasons[0].season}`);
});
test("public data is readable from any origin, with a preflight that agrees", async () => {
  const r = await A.get("/v1/leaderboard", { origin: "https://anywhere.example" }); assert.equal(r.headers.get("access-control-allow-origin"), "*"); assert.equal(r.headers.get("vary"), null); assert.match(r.headers.get("access-control-expose-headers"), /ETag/);
  const o = await fetch(A.base + "/v1/proofs/recorded", { method: "OPTIONS", headers: { origin: "https://anywhere.example", "access-control-request-method": "POST" } }); assert.equal(o.status, 204); assert.equal(o.headers.get("access-control-allow-origin"), "*"); assert.match(o.headers.get("access-control-allow-methods"), /POST/);
});
test("a parameter or method the route does not take is refused, never ignored", async () => {
  assert.equal((await json("/v1/leaderboard?bogus=1")).body.error.type, "unknown_parameter"); assert.equal((await json("/v1/seasons/1?limit=3")).body.error.type, "unknown_parameter"); const r = await A.post("/v1/leaderboard", {}); assert.equal(r.status, 405); assert.equal(r.headers.get("allow"), "GET"); assert.equal((await A.get("/v1/proofs/recorded")).status, 405);
  assert.equal((await A.get("/v1/leaderboard?token=abc")).status, 400, "a credential in a URL is refused before anything else");
  for (const [p, code] of [["/v1/seasons/-1", "invalid_season"], ["/v1/seasons/18446744073709551616", "invalid_season"], ["/v1/strategies/x", "invalid_strategy"], ["/v1/wallets/notakey", "invalid_wallet"], ["/v1/commitments/ABC", "invalid_commitment"], ["/v1/seasons?limit=0", "invalid_limit"], ["/v1/seasons?limit=201", "invalid_limit"], ["/v1/seasons?status=maybe", "invalid_status"], ["/v1/seasons?creator=zz", "invalid_wallet"]]) { const { r, body } = await json(p); assert.equal(r.status, 400, p); assert.equal(body.error.type, code, p); }
  for (const [p, code] of [["/v1/seasons/12345", "season_not_in_record"], ["/v1/strategies/12345", "strategy_not_in_record"], ["/v1/wallets/11111111111111111111111111111111", "wallet_not_in_record"], ["/v1/commitments/" + "0".repeat(64), "commitment_not_in_record"]]) { const { r, body } = await json(p); assert.equal(r.status, 404, p); assert.equal(body.error.type, code); }
});

test("the leaderboard is the counting policy's output, with every excluded season, its reasons, and the exact rules in force", async () => {
  const rules = JSON.parse(fs.readFileSync(EXAMPLE_RULES, "utf8")); const out = evaluate(record(), rules); const { body } = await json("/v1/leaderboard?limit=500");
  assert.deepEqual(body.counted.map(s => s.season), out.counted); assert.deepEqual(body.excluded.map(x => [x.season, x.reasons]), out.excluded.map(x => [x.season, x.reasons])); assert.deepEqual(body.ranking.map(x => [x.strategyId, x.position, x.wins, x.podiums, x.beatenShare]), out.ranking.map(x => [x.strategyId, x.position, x.wins, x.podiums, x.beaten]));
  assert.equal(body.counted.length + body.excluded.length, record().seasons.length, "every season is either counted or excluded with a reason"); assert.ok(body.excluded.every(x => x.reasons.length > 0));
  assert.deepEqual(body.rules, { configured: true, name: rules.name, note: rules.note, trustedCreators: rules.trustedCreators, trustedValidators: rules.trustedValidators, countVoidedFinals: true }); assert.deepEqual(body.disclaimers, out.disclaimers);
  assert.match(body.rankingBasis, /one chosen convention, not a measurement of skill/); assert.ok(body.disclaimers.some(d => /None of them proves a field is not one person/.test(d))); const ids = body.notices.map(n => n.id); for (const id of ["counts-not-proof", "validator-trust-input", "fee-token", "sealing-disclosure"]) assert.ok(ids.includes(id), id);
  assert.ok(body.counted.length > 0 && body.excluded.some(x => x.reasons.includes("cancelled: it has no result")) && body.excluded.some(x => x.reasons.includes("creator is not on the trusted list")));
  const p1 = (await json("/v1/leaderboard?limit=3")).body; assert.equal(p1.ranking.length, 3); assert.deepEqual(p1.page, { limit: 3, offset: 0, total: out.ranking.length }); assert.deepEqual((await json("/v1/leaderboard?limit=3&offset=3")).body.ranking.map(x => x.position), [4, 5, 6]);
});
test("with no rules configured the leaderboard counts nothing, and says so", async () => {
  const B = await startApi({ dir, rulesFile: null }); const b = await (await B.get("/v1/leaderboard")).json(); await B.close(); assert.equal(b.rules.configured, false); assert.deepEqual(b.counted, []); assert.equal(b.ranking.length, 0); assert.ok(b.excluded.length === record().seasons.length);
  assert.ok(b.excluded.every(x => x.reasons.includes("creator is not on the trusted list"))); assert.equal(validate("Leaderboard", b), null);
});
test("a misspelt rule in the rules file is an error the leaderboard reports, never a silently relaxed rule", async () => {
  const f = path.join(tmp(), "rules.json"); fs.writeFileSync(f, JSON.stringify({ trustedCreators: [], trustedValidators: [], minWallets: 3 })); const B = await startApi({ dir, rulesFile: f }); const r = await B.get("/v1/leaderboard"); const b = await r.json(); await B.close(); assert.equal(r.status, 503); assert.equal(b.error.type, "rules_invalid");
});

test("seasons: filters, order and paging", async () => {
  const rec = record(); const all = (await json("/v1/seasons?limit=200&order=asc")).body; assert.deepEqual(all.seasons.map(s => s.season), rec.seasons.map(s => s.season)); assert.deepEqual((await json("/v1/seasons?limit=200")).body.seasons.map(s => s.season), rec.seasons.map(s => s.season).reverse(), "newest first by default");
  const cancelled = (await json("/v1/seasons?kind=cancelled&limit=200")).body; assert.equal(cancelled.page.total, rec.seasons.filter(s => s.kind === "cancelled").length); assert.ok(cancelled.seasons.every(s => s.kind === "cancelled"));
  const creator = rec.seasons[0].facts.creator; assert.ok((await json(`/v1/seasons?creator=${creator}&limit=200`)).body.seasons.every(s => s.creator === creator)); assert.deepEqual((await json("/v1/seasons?status=provisional")).body.seasons, []); const p2 = (await json("/v1/seasons?limit=5&offset=5&order=asc")).body; assert.deepEqual(p2.seasons.map(s => s.season), rec.seasons.slice(5, 10).map(s => s.season));
});

test("a season's raw facts are the receipt's, the validator is a trust input, and its flags are shown", async () => {
  const rec = record(); for (const s of rec.seasons) { const b = (await json(`/v1/seasons/${s.season}`)).body; assert.equal(b.summary.fieldSize, s.facts.fieldSize); assert.equal(b.summary.distinctEntrantWallets, s.facts.distinctEntrantWallets); assert.equal(b.summary.creator, s.facts.creator); assert.equal(b.summary.creatorIsAlsoAnEntrant, s.facts.creatorIsAlsoAnEntrant); assert.deepEqual(b.entries.map(e => e.strategyId), s.entries.map(e => e.strategyId)); assert.equal(b.receipt.address, s.address);
    assert.equal(b.summary.validator.trustInput, true); assert.ok(b.notices.some(n => n.id === "validator-trust-input")); assert.ok(b.notices.some(n => n.id === "fee-token")); assert.equal(b.summary.validator.status, "observed"); assert.equal(typeof b.summary.validator.key, "string"); assert.ok(b.summary.validator.sources.length > 0); }
  assert.ok(rec.seasons.every(s => s.flags.length === 0), "the recorded seasons carry no flag: their first copies were saved after the bond release");
});

test("the fee always carries its stake token: the mint where base history names it, an explicit unknown where it does not", async () => {
  const rec = record(); let observed = 0, unknown = 0; const all = (await json("/v1/seasons?limit=200")).body.seasons;
  for (const s of all) { assert.ok(s.fee.token && "mint" in s.fee.token && s.fee.token.note.length > 10, s.season); assert.ok(s.fee.unit.length > 20);
    if (s.fee.token.status === "observed") { observed++; assert.match(s.fee.token.mint, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); assert.match(s.fee.token.recoveredFrom, /InitPool transaction on base/); assert.ok(s.fee.unit.includes(s.fee.token.mint)); }
    else { unknown++; assert.equal(s.fee.token.mint, null); assert.equal(s.fee.token.recoveredFrom, null); assert.match(s.fee.unit, /unknown/); assert.equal(s.fieldSize, 0, "unknown only where no pool was ever made: a season with no entries"); } }
  assert.equal(observed, 23); assert.equal(unknown, 6); const lb = (await json("/v1/leaderboard")).body; for (const s of [...lb.counted, ...lb.excluded.map(x => x.summary)]) assert.ok(s.fee.token, "also inside the leaderboard");
  assert.ok(new Set(all.filter(s => s.fee.token.mint).map(s => s.fee.token.mint)).size >= 1);
});

test("a closed strategy is returned with the sealing-disclosure notice and its code is neither served nor linked", async () => {
  const rec = record(); const closed = Object.entries(rec.registries).filter(([, v]) => v.closed === true).map(([id]) => id); const open = Object.entries(rec.registries).filter(([, v]) => v.closed === false).map(([id]) => id); assert.ok(closed.length > 40 && open.length > 40, `${closed.length} closed, ${open.length} open in the recorded data`);
  for (const id of closed) { const b = (await json(`/v1/strategies/${id}`)).body; assert.equal(b.registry.closed, true); assert.equal(b.disclosure.closed, true); assert.match(b.disclosure.text, /permanently and publicly readable/); const n = b.notices.find(x => x.id === "sealing-disclosure"); assert.match(n.text, /has been closed/); assert.match(n.text, /does not serve or link them/); }
  for (const id of open.slice(0, 20)) { const b = (await json(`/v1/strategies/${id}`)).body; assert.equal(b.disclosure.closed, false); assert.ok(b.notices.some(x => x.id === "sealing-disclosure" && /never serves or links them/.test(x.text))); assert.equal(b.registry.delegated, true); assert.match(b.registry.note, /delegated to the rollup/); }
  const id = closed[0]; const b = (await json(`/v1/strategies/${id}`)).body; assert.deepEqual(b.results.final.map(r => r.season), rec.views.strategies[id].final.map(r => r.season)); assert.ok(b.results.final.every(r => r.owner && r.codeCommitment));
});
test("a wallet page and a commitment page carry their caveats", async () => {
  const rec = record(); const w = Object.keys(rec.views.wallets)[0]; const wb = (await json(`/v1/wallets/${w}`)).body; assert.ok(wb.notices.some(n => n.id === "owner-at-entry")); assert.ok(wb.notices.some(n => n.id === "sealing-disclosure")); assert.equal(wb.results.final.length, rec.views.wallets[w].final.length); assert.ok(wb.strategies.every(s => s.registry.status));
  const c = Object.keys(rec.views.commitments)[0]; const cb = (await json(`/v1/commitments/${c}`)).body; assert.match(cb.caveat, /same salt and bytecode/); assert.match(cb.caveat, /Different commitments say nothing/); assert.ok(cb.notices.some(n => n.id === "sealing-disclosure"));
});
test("pre-4A receipts are labelled not verified, and appear nowhere else", async () => {
  const b = (await json("/v1/legacy")).body; assert.equal(b.verified, false); assert.match(b.label, /Not verified history/); assert.equal(b.receipts.length, 46); assert.ok(b.receipts.every(r => /LEGACY/.test(r.label) && !("owner" in r))); assert.equal(b.unverifiable.length, 1); assert.ok(b.notices.some(n => n.id === "legacy-not-verified"));
  const legacySeasons = new Set(b.receipts.map(r => r.season)); const seasons = (await json("/v1/seasons?limit=200")).body.seasons; assert.ok(seasons.every(s => !legacySeasons.has(s.season)), "a legacy season is in no season list");
});

test("honesty, across every response: no secret field, no signature but the receipts' own, no link to a strategy's transactions", async () => {
  const rec = record(); const allowed = new Set(rec.seasons.flatMap(s => s.history.events.map(e => e.signature))); const queue = ["/v1/leaderboard", "/v1/seasons?limit=200", "/v1/legacy", "/v1/status", ...rec.seasons.map(s => `/v1/seasons/${s.season}`), ...Object.keys(rec.views.strategies).map(id => `/v1/strategies/${id}`), ...Object.keys(rec.views.wallets).map(w => `/v1/wallets/${w}`), ...Object.keys(rec.views.commitments).slice(0, 40).map(c => `/v1/commitments/${c}`)];
  let sigs = 0; for (const p of queue) { const b = (await json(p)).body; for (const k of keysOf(b)) assert.ok(!/^(salt|sealedsalt|code|bytecode|source|secret|passphrase|privatekey|seed)$/i.test(k), `${p} carries a field called ${k}`);
    for (const s of stringsOf(b)) { if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) { sigs++; assert.ok(allowed.has(s), `${p}: a signature that is not one of a receipt's own: ${s}`); } assert.ok(!/solscan|explorer\.solana|getTransaction|getSignaturesForAddress|\/strat\//i.test(s), `${p}: ${s.slice(0, 60)}`); assert.ok(!/Bearer |eyJ[A-Za-z0-9_-]{15,}\./.test(s), "no token anywhere"); } }
  assert.ok(sigs > 20, "signatures were checked: those of the receipts' own history");
  const strategyBodies = [(await json(`/v1/strategies/${Object.keys(rec.views.strategies)[0]}`)).body, (await json(`/v1/wallets/${Object.keys(rec.views.wallets)[0]}`)).body]; for (const b of strategyBodies) assert.ok(b.notices.some(n => n.id === "sealing-disclosure"), "every response about strategies carries the notice");
});

test("status: freshness, last build, archive digests, and the one live read it makes", async () => {
  const rec = record(); A.nowMs.v += 11_000; /* past the ten-second cache of the live slot */ A.rpc.seen.length = 0; A.rpc.setSlot(rec.currentTo.slot + 40); const { body } = await json("/v1/status"); assert.equal(validate("Status", body), null);
  assert.equal(body.store.usable, true); assert.equal(body.store.builtAt, rec.builtAt); assert.equal(body.store.currentTo.slot, rec.currentTo.slot); assert.equal(body.store.archive.sha256, rec.archive.sha256); assert.equal(body.store.archive.recordSha256, rec.archive.recordSha256); assert.equal(body.store.ledger.head, rec.ledger.head); assert.equal(body.store.counts.final, rec.counts.final);
  assert.equal(body.chain.currentSlot, rec.currentTo.slot + 40); assert.equal(body.chain.lagSlots, 40); assert.equal(body.chain.error, null); assert.equal(body.store.stale, false); assert.equal(body.store.ageSeconds, Math.floor((A.nowMs.v - Date.parse(rec.builtAt)) / 1000)); assert.equal(body.store.service.state, "ok"); assert.deepEqual(body.store.alarms, { record: [], backup: [] });
  await json("/v1/status"); assert.deepEqual(A.rpc.seen, ["getSlot"], "one finalized-slot read, cached for ten seconds");
  A.rpc.seen.length = 0; for (const p of ["/v1/leaderboard", "/v1/seasons", "/v1/legacy", `/v1/strategies/${Object.keys(rec.views.strategies)[0]}`]) await json(p); assert.deepEqual(A.rpc.seen, [], "every other route reads the store and nothing else");
});
test("status keeps answering when the chain is unreachable, when the record is old, and when there is no record", async () => {
  const B = await startApi({ dir, staleAfterSeconds: 30 }); B.rpc.setDown(true); const a = await (await B.get("/v1/status")).json(); assert.equal(a.chain.currentSlot, null); assert.equal(a.chain.error, "upstream_unavailable"); assert.equal(a.store.usable, true); assert.equal(a.store.stale, true, "60 s old against a 30 s limit"); assert.equal(validate("Status", a), null); await B.close();
  const empty = tmp(); const C = await startApi({ dir: empty }); const s = await (await C.get("/v1/status")).json(); assert.equal(s.store.usable, false); assert.equal(s.store.problem, "store_empty"); assert.equal(validate("Status", s), null); const r = await C.get("/v1/leaderboard"); assert.equal(r.status, 503); assert.equal((await r.json()).error.type, "store_empty"); await C.close();
  const D = await startApi({ dir: null }); const n = await (await D.get("/v1/status")).json(); assert.equal(n.store.configured, false); assert.equal((await D.get("/v1/seasons")).status, 404); assert.equal((await (await D.get("/v1/seasons")).json()).error.type, "store_not_configured"); await D.close();
});
test("a record in another format is refused with a reason, not misread", async () => {
  const d = await buildStore(TAPE, tmp(), { mutate: f => { const r = f.record(); r.version = 1; f.write(r); } }); const B = await startApi({ dir: d }); const r = await B.get("/v1/leaderboard"); assert.equal(r.status, 503); assert.equal((await r.json()).error.type, "store_format"); assert.equal((await (await B.get("/v1/status")).json()).store.problem, "store_format"); await B.close();
});
test("SYNTHETIC: a receipt the capture loop flagged shows as an alarm in the status and in the season", async () => {
  const addr = record().seasons.find(s => s.status === "final").address; const d = await buildStore(TAPE, tmp(), { mutate: f => { const r = f.record(); const s = r.seasons.find(x => x.address === addr); s.flags.push({ kind: "record-changed", detail: "3 bytes differ", info: false, firstSeenAt: "2026-11-27T05:00:00.000Z" }); const o = r.seasons.find(x => x.address !== addr); o.flags.push({ kind: "bond-released", detail: "the releasable bond went to zero", info: true, firstSeenAt: "2026-11-27T05:00:00.000Z" }); f.write(r); } });
  const B = await startApi({ dir: d }); const st = await (await B.get("/v1/status")).json(); assert.equal(st.store.alarms.record.length, 1); assert.equal(st.store.alarms.record[0].kind, "record-changed"); const s = await (await B.get(`/v1/seasons/${record().seasons.find(x => x.address === addr).season}`)).json(); assert.equal(s.summary.alarm, true); assert.equal(s.summary.flags[0].info, false); const info = await (await B.get(`/v1/seasons/${record().seasons.find(x => x.address !== addr).season}`)).json(); assert.deepEqual(info.summary.flags.map(f => [f.kind, f.info]), [["bond-released", true]]); assert.equal(info.summary.alarm, false, "an information flag is not an alarm"); assert.equal(validate("SeasonDetail", info), null); await B.close();
});

test("the API reads the store and holds no token and no secret: its code touches neither the rollup nor the session secret", () => {
  for (const f of fs.readdirSync(path.join(here, "..", "src", "api")).filter(f => f.endsWith(".mjs"))) { const src = fs.readFileSync(path.join(here, "..", "src", "api", f), "utf8"); assert.ok(!/devnet-tee|getAuthToken|auth\.mjs|session\.mjs|CONCLAVE_AUTH_SECRET|rollupUpstream|Authorization/i.test(src), `${f} reaches for a token or a secret`); assert.ok(!/console\.(log|error)|log\(/.test(src.replace(/\/\/.*$/gm, "")) || f === "index.mjs" && !/log\(/.test(src), `${f} logs`); }
});
test("the server's own validator agrees with ajv on responses and on corrupted copies of them", async () => {
  const sample = [["Leaderboard", "/v1/leaderboard"], ["SeasonDetail", `/v1/seasons/${record().seasons[3].season}`], ["StrategyPage", `/v1/strategies/${Object.keys(record().views.strategies)[0]}`], ["WalletPage", `/v1/wallets/${Object.keys(record().views.wallets)[0]}`], ["Status", "/v1/status"]]; let bad = 0;
  for (const [def, p] of sample) { const good = (await json(p)).body; assert.equal(validate(def, good), null); const mutate = (o, f) => { const c = JSON.parse(JSON.stringify(o)); f(c); return c; };
    const first = Object.keys(good).find(k => !["apiVersion"].includes(k) && typeof good[k] !== "object"); const variants = [mutate(good, c => { c.extraField = 1; }), mutate(good, c => { delete c[Object.keys(c)[1]]; }), mutate(good, c => { c.apiVersion = "v2"; }), ...(first ? [mutate(good, c => { c[first] = [c[first]]; })] : [])];
    for (const v of variants) { assert.notEqual(validate(def, v), null, `${def}: a corrupted copy was accepted`); bad++; } }
  assert.ok(bad >= 15);
});
