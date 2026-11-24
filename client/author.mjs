// Author tool, Node/browser-style path: the real conclave-vm compiled to WASM (crates/conclave-author), no native code, no chain, no network.
//   node client/author.mjs asm FILE [--json]
//   node client/author.mjs sim FILE [--worlds N] [--episodes N] [--base HEX] [--no-field] [--single-seed N] [--json]
//   node client/author.mjs disasm HEX
// Build the module first:  cargo build --release --target wasm32-unknown-unknown -p conclave-author
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
const here = path.dirname(fileURLToPath(import.meta.url));
export const WASM_PATH = process.env.CONCLAVE_AUTHOR_WASM || path.join(here, "../target/wasm32-unknown-unknown/release/conclave_author.wasm");
export async function load(file = WASM_PATH) {
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(file), {}); const X = instance.exports; const enc = new TextEncoder(), dec = new TextDecoder();
  const put = bytes => { const p = X.ca_alloc(bytes.length || 1); new Uint8Array(X.memory.buffer, p, bytes.length).set(bytes); return p; };            // memory can grow between calls: always take a fresh view
  const out = n => dec.decode(new Uint8Array(X.memory.buffer, X.ca_out(), n)); const outBytes = n => new Uint8Array(X.memory.buffer, X.ca_out(), n).slice();
  const hexToBytes = h => Uint8Array.from(h.match(/../g) || [], b => parseInt(b, 16));
  return {
    assemble: (src, { raw = false } = {}) => { const b = enc.encode(src); const t = out(X.ca_assemble(put(b), b.length)); return raw ? t : JSON.parse(t); },
    listing: src => { const b = enc.encode(src); return out(X.ca_listing(put(b), b.length)); },
    disassemble: code => { const n = X.ca_disassemble(put(code), code.length); return out(n); },
    /** code: Uint8Array of bytecode. text=true returns the human report, otherwise the parsed JSON report */
    simulate: (code, { worlds = 48, episodes = 12, base = 0xC0DEC1A55E110001n, field = true, single = null, text = false, raw = false } = {}) => {
      const h = new DataView(new ArrayBuffer(22)); h.setUint8(0, text ? 1 : 0); h.setUint32(1, worlds, true); h.setUint32(5, episodes, true); h.setBigUint64(9, BigInt(base), true); h.setUint8(17, (field ? 1 : 0) | (single !== null ? 2 : 0)); h.setUint32(18, single ?? 0, true);
      const inp = new Uint8Array(22 + code.length); inp.set(new Uint8Array(h.buffer), 0); inp.set(code, 22); const n = X.ca_simulate(put(inp), inp.length); const s = out(n); if (s.startsWith("ERROR")) throw new Error(s); return text || raw ? s : JSON.parse(s); },
    /** final PnL (Q16.16, BigInt) of one episode, seeded exactly like the conformance TRACE vector */
    trace: (code, pack, sa, sb, ep) => { const p = put(code); const a = BigInt(sa), b = BigInt(sb); return X.ca_trace(p, code.length, pack, Number(a & 0xffffffffn), Number(a >> 32n), Number(b & 0xffffffffn), Number(b >> 32n), ep); },
    hexToBytes, raw: X,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, file, ...rest] = process.argv.slice(2); const A = await load(); const flag = n => rest.includes(n); const val = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === "disasm") { const t = A.disassemble(A.hexToBytes(file || "")); console.log(t.startsWith("ERROR") ? t : t.trimEnd()); process.exit(t.startsWith("ERROR") ? 1 : 0); }
  if (!file || !["asm", "sim"].includes(cmd)) { console.error("usage: author.mjs asm|sim FILE | disasm HEX"); process.exit(2); }
  const src = fs.readFileSync(file, "utf8"); const a = A.assemble(src);
  if (cmd === "asm") { if (flag("--json")) console.log(A.assemble(src, { raw: true })); else { console.log(`${file}: ${a.name ?? ""}`); process.stdout.write(A.listing(src)); } process.exit(a.ok ? 0 : 1); }
  if (!a.ok) { process.stdout.write(A.listing(src)); process.exit(1); }
  const opts = { worlds: val("--worlds") ? +val("--worlds") : 48, episodes: val("--episodes") ? +val("--episodes") : 12, field: !flag("--no-field"), single: val("--single-seed") !== undefined ? +val("--single-seed") : null, base: val("--base") ? BigInt("0x" + val("--base").replace(/^0x/, "")) : 0xC0DEC1A55E110001n };
  if (flag("--json")) console.log(A.simulate(A.hexToBytes(a.bytecode), { ...opts, raw: true }));
  else { process.stdout.write(A.listing(src)); console.log(); process.stdout.write(A.simulate(A.hexToBytes(a.bytecode), { ...opts, text: true })); }
}
