// Regression guard for the leak surface: no credential may be put into a URL by anything in the repo, no key material may be committed, and a rollup endpoint must never print its token.
import test from "node:test"; import assert from "node:assert/strict"; import fs from "node:fs"; import path from "node:path"; import util from "node:util"; import { fileURLToPath } from "node:url"; import { Endpoint } from "../../client/endpoint.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function walk(dir, out = []) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (["node_modules", "target", ".git", "evidence", "out", "test", "conformance"].includes(e.name)) continue; const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (/\.(mjs|js|sh|yml|yaml|md|json|rs|toml)$/.test(e.name) && !/package-lock/.test(e.name)) out.push(p); } return out; }
const files = [...walk(path.join(ROOT, "client")), ...walk(path.join(ROOT, "server")), ...walk(path.join(ROOT, "scripts")), ...walk(path.join(ROOT, ".github")), ...walk(path.join(ROOT, "program")).filter(f => !f.includes("/src/")), path.join(ROOT, "README.md"), ...fs.readdirSync(path.join(ROOT, "tests")).filter(f => f.endsWith(".sh")).map(f => path.join(ROOT, "tests", f))];
const rel = f => path.relative(ROOT, f);

test("nothing builds a URL with a token, key or secret in the query string", () => {
  const bad = /(\?|&)(token|access_token|id_token|jwt|api[-_]?key|apikey|secret|auth|sig|signature|key)=|token=\$\{|\?token\b/i; const hits = [];
  for (const f of files) { const t = fs.readFileSync(f, "utf8"); t.split("\n").forEach((l, i) => { if (bad.test(l) && !/credentials_in_url_refused|CREDENTIAL_PARAMS|never accept|refus/i.test(l)) hits.push(`${rel(f)}:${i + 1}: ${l.trim().slice(0, 110)}`); }); }
  assert.deepEqual(hits, [], "credentials in URLs leak through server logs, referrer headers and browser history"); });

test("no key material or provider URL with a key is committed", () => {
  const hits = []; for (const f of files) { const t = fs.readFileSync(f, "utf8"); if (/\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]/.test(t)) hits.push(rel(f) + ": a byte array that looks like a keypair"); if (/https?:\/\/[^\s"'`]*(api[-_]?key|apikey|access[-_]?token)=/i.test(t)) hits.push(rel(f) + ": URL with a key");
    if (/helius|quicknode|alchemy|triton|syndica|ankr/i.test(t) && /https?:\/\/[^\s"'`]*\.(helius|quiknode|alchemy|rpcpool|syndica|ankr)/i.test(t)) hits.push(rel(f) + ": a keyed provider URL"); if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) hits.push(rel(f) + ": PEM private key"); }
  assert.deepEqual(hits, []); });

test("the server reads its secret and upstream from the environment or a file, never a literal", () => {
  const cfg = fs.readFileSync(path.join(ROOT, "server/src/config.mjs"), "utf8"); assert.match(cfg, /process\.env\[`\$\{name\}_FILE`\]/); assert.ok(!/https?:\/\//.test(cfg.replace(/\/\/.*$/gm, "")), "no URL literal in the config loader");
  const env = fs.readFileSync(path.join(ROOT, "server/env.example"), "utf8"); assert.match(env, /^CONCLAVE_AUTH_SECRET=$/m, "the example carries no secret"); });

test("the repo ignores the files that would hold credentials", () => { const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"); for (const p of ["conclave-keys/", ".env", "*keypair*.json", "node_modules/", "evidence/"]) assert.ok(gi.split("\n").includes(p), `${p} must be ignored`); });

test("a rollup endpoint carries its token in a header and never prints it", () => {
  const tok = "SECRET-TEE-TOKEN-abcdef0123456789"; const e = new Endpoint("https://tee.example", tok); const printed = [String(e), `${e}`, JSON.stringify(e), JSON.stringify({ nested: [e, { e }] }), util.inspect(e, { depth: 6, showHidden: false }), util.inspect({ e }, { depth: 6 }), Object.keys(e).join(), JSON.stringify(Object.entries(e))].join("\n");
  assert.ok(!printed.includes(tok), "the token is not in any printed form"); assert.equal(String(e), "https://tee.example"); assert.deepEqual(Object.keys(e), ["url"]); assert.deepEqual(e.headers(), { Authorization: `Bearer ${tok}` }); assert.deepEqual(new Endpoint("https://tee.example").headers(), {}, "an endpoint with no token sends no credential"); });
