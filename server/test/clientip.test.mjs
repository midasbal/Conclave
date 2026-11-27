// How a caller's address is found for the rate limiter, and what each mode does when a caller lies in a forwarding header. Real HTTP over a real local port: the socket address is 127.0.0.1 for every request, so the only thing that can tell callers apart is a header.
import test from "node:test"; import assert from "node:assert/strict"; import http from "node:http"; import { createApp } from "../src/server.mjs"; import { loadConfig } from "../src/config.mjs"; import { PROGRAM } from "./helpers.mjs";
async function serve(clientIp, extra = {}) { const app = createApp({ recordOnly: true, programId: PROGRAM, clientIp, limits: { api: 3 }, api: { handle: async (req, res, { limit, ip }) => { if (req.url === "/v1/ping") { if (!limit("api", ip)) return true; /* the real API does exactly this first */ res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return true; } return false; } }, now: () => 1_800_000_000, ...extra });
  await new Promise(r => app.listen(0, "127.0.0.1", r)); app.unref(); return { base: `http://127.0.0.1:${app.address().port}`, close: () => new Promise(r => app.close(r)) }; }
// keep-alive off, so each request is its own connection and the socket address is the only constant
const hit = (base, headers = {}) => new Promise((res, rej) => { const r = http.request(base + "/v1/ping", { headers, agent: false }, x => { x.resume(); x.on("end", () => res(x.statusCode)); }); r.on("error", rej); r.end(); });
const burst = async (base, headersList) => { const out = []; for (const h of headersList) out.push(await hit(base, h)); return out; };

test("socket: the address of the connection decides, and a spoofed header changes nothing", async () => {
  const s = await serve("socket"); try { assert.deepEqual(await burst(s.base, [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }, { "x-real-ip": "3.3.3.3" }, { "x-forwarded-for": "4.4.4.4" }]), [200, 200, 200, 429]); } finally { await s.close(); }
});
test("global: one bucket for everybody; no header can buy a caller its own bucket", async () => {
  const s = await serve("global"); try { assert.deepEqual(await burst(s.base, [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }, { "x-real-ip": "3.3.3.3" }, { "x-forwarded-for": "4.4.4.4, 5.5.5.5" }, {}]), [200, 200, 200, 429, 429]); } finally { await s.close(); }
});
test("xff-first: only for a proxy known to overwrite the header: separate callers get separate buckets, a malformed value falls back to the socket address", async () => {
  const s = await serve("xff-first"); try {
    assert.deepEqual(await burst(s.base, [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "1.1.1.1, 9.9.9.9" }, { "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }]), [200, 200, 200, 429, 200], "the FIRST entry is the caller");
    const junk = ["not an address!", "<script>", "x".repeat(60)]; assert.deepEqual(await burst(s.base, [...junk, ...junk]), [200, 200, 200, 429, 429, 429], "garbage is never used as a key: it all lands in the socket bucket");
  } finally { await s.close(); }
});
test("x-real-ip: the header the proxy sets decides; a forwarded-for chain is ignored", async () => {
  const s = await serve("x-real-ip"); try { assert.deepEqual(await burst(s.base, [{ "x-real-ip": "7.7.7.7" }, { "x-real-ip": "7.7.7.7" }, { "x-real-ip": "7.7.7.7", "x-forwarded-for": "8.8.8.8" }, { "x-real-ip": "7.7.7.7", "x-forwarded-for": "9.9.9.9" }, { "x-real-ip": "6.6.6.6" }]), [200, 200, 200, 429, 200]); } finally { await s.close(); }
});
test("trustProxy:true, the old spelling, is xff-first", async () => {
  const s = await serve("socket", { trustProxy: true }); try { assert.deepEqual(await burst(s.base, [{ "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "2.2.2.2" }, { "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "1.1.1.1" }, { "x-forwarded-for": "1.1.1.1" }]), [200, 200, 200, 200, 429]); } finally { await s.close(); }
});
test("config: the mode, its defaults, and the raised limits that go with one shared bucket", () => {
  const save = { ...process.env }; try {
    for (const k of Object.keys(process.env)) if (/^(CONCLAVE_|RATE_)/.test(k)) delete process.env[k]; process.env.CONCLAVE_RECORD_ONLY = "1"; process.env.CONCLAVE_STORE_DIR = "/d";
    let c = loadConfig(); assert.equal(c.clientIp, "socket"); assert.equal(c.limits.api, 300); assert.equal(c.limits.challenge, 30);
    process.env.CONCLAVE_CLIENT_IP = "global"; c = loadConfig(); assert.equal(c.clientIp, "global"); assert.equal(c.limits.api, 3000); assert.equal(c.limits.challenge, 300);
    process.env.RATE_API_PER_MIN = "1234"; assert.equal(loadConfig().limits.api, 1234, "an explicit value always wins");
    process.env.CONCLAVE_CLIENT_IP = "bogus"; assert.throws(() => loadConfig(), /CONCLAVE_CLIENT_IP must be one of/); delete process.env.CONCLAVE_CLIENT_IP; process.env.CONCLAVE_TRUST_PROXY = "1"; assert.equal(loadConfig().clientIp, "xff-first");
  } finally { for (const k of Object.keys(process.env)) if (!(k in save)) delete process.env[k]; Object.assign(process.env, save); }
});
