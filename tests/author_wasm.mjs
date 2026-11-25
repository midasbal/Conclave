// The author tool's WASM build against everything it must agree with:
//   1. the native CLI, byte for byte (assembler JSON, cost listing, ensemble JSON, human report)
//   2. the conformance WASM (cc_run, the module the corpus legs run): the same TRACE vector gives the same episode PnL as the author module's own episode runner
//   3. the host, because the native CLI is the same Rust and the authored corpus (tests/conformance/authored.bin) pins host, WASM and SBF together
// Needs: cargo build --release -p conclave-author && cargo build --release --target wasm32-unknown-unknown -p conclave-author -p conclave-conformance
import fs from "fs"; import path from "path"; import { execFileSync } from "child_process"; import { fileURLToPath } from "url"; import { load } from "../client/author.mjs";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."); const NATIVE = path.join(root, "target/release/conclave-author"); const CONF = path.join(root, "target/wasm32-unknown-unknown/release/conclave_conformance.wasm");
const A = await load(); const files = fs.readdirSync(path.join(root, "strategies")).filter(f => f.endsWith(".cvs")).sort().map(f => path.join(root, "strategies", f));
let bad = 0, n = 0; const check = (name, ok, detail = "") => { n++; if (!ok) { bad++; console.log(`FAIL ${name} ${detail}`); } };
const native = (...args) => execFileSync(NATIVE, args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
const { instance } = await WebAssembly.instantiate(fs.readFileSync(CONF), {}); const C = instance.exports; const inP = C.cc_alloc(4096), outP = C.cc_alloc(4096);
const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; }; const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const traceVector = (pack, sa, sb, ep, nt, code) => Buffer.concat([Buffer.from([2, pack]), u64(sa), u64(sb), u32(ep), Buffer.from([nt, 1, 0]), Buffer.from([code.length & 255, code.length >> 8]), Buffer.from(code)]);
const confPnl = input => { new Uint8Array(C.memory.buffer, inP, input.length).set(input); const m = C.cc_run(inP, input.length, outP); const out = Buffer.from(new Uint8Array(C.memory.buffer, outP, m)); return out.readBigInt64LE(16); };
for (const file of files) { const name = path.basename(file); const src = fs.readFileSync(file, "utf8");
  // 1. native vs WASM
  check(`${name} assemble json`, A.assemble(src, { raw: true }) === native("asm", file, "--json").trimEnd());
  check(`${name} cost listing`, "\n" + A.listing(src) === "\n" + native("asm", file).split("\n").slice(1).join("\n"));
  const a = A.assemble(src); const code = A.hexToBytes(a.bytecode); check(`${name} bytecode validates`, a.ok && code.length === 4 + 4 * a.ops.length);
  check(`${name} ensemble json`, A.simulate(code, { worlds: 12, episodes: 6, raw: true }) === native("sim", file, "--json", "--worlds", "12", "--episodes", "6").trimEnd());
  check(`${name} ensemble text`, A.simulate(code, { worlds: 12, episodes: 6, text: true }) === native("sim", file, "--worlds", "12", "--episodes", "6").split("\n\n").slice(1).join("\n\n"));
  check(`${name} single seed text`, A.simulate(code, { worlds: 12, episodes: 6, single: 5, text: true }).includes("SINGLE SEED 5") && A.simulate(code, { worlds: 12, episodes: 6, single: 5, text: true }).includes("Do not read skill into it"));
  // 2. author WASM episode runner vs conformance WASM on the same TRACE vector (full 150 ticks)
  let eps = 0; for (let pack = 0; pack < 6; pack++) for (const [sa, sb, ep] of [[1n, 2n, 0], [0xDEADBEEFn, 77n, 3]]) { const want = confPnl(traceVector(pack, sa, sb, ep, 150, code)); const got = BigInt(A.trace(code, pack, sa, sb, ep)); eps++; check(`${name} pack ${pack} sa ${sa} ep ${ep}: author wasm vs conformance wasm`, got === want, `${got} vs ${want}`); }
  check(`${name} ${eps} episodes compared`, eps === 12); }
// 3. a whole field in one season: the author module's season export against the conformance module's SEASON vector (the chain's loop), strategy by strategy
{ const codes = files.map(f => A.hexToBytes(A.assemble(fs.readFileSync(f, "utf8")).bytecode)); for (const [sa, sb, neps] of [[11n, 22n, 3], [0xABCDEF01n, 31337n, 7], [12345678901234n, 5n, 5]]) { const mine = A.season(codes, sa, sb, neps);
    const input = Buffer.concat([Buffer.from([3]), u64(sa), u64(sb), Buffer.from([neps, 150, codes.length]), ...codes.flatMap(c => [Buffer.from([c.length & 255, c.length >> 8]), Buffer.from(c)])]); new Uint8Array(C.memory.buffer, inP, input.length).set(input); const m = C.cc_run(inP, input.length, outP); const out = Buffer.from(new Uint8Array(C.memory.buffer, outP, m));
    check(`season ${sa}/${sb}: both packs agree`, mine.packs[0] === out[0] && mine.packs[1] === out[1]); mine.totals.forEach((t, i) => check(`season ${sa}/${sb} strategy ${i}: author wasm total == conformance wasm total`, t === out.readBigInt64LE(2 + 16 + 8 * i), `${t}`)); } }
// the disassembler and errors through WASM
const mom = A.assemble(fs.readFileSync(path.join(root, "strategies/momentum.cvs"), "utf8")); check("disassemble round trip", A.assemble(A.disassemble(A.hexToBytes(mom.bytecode))).bytecode === mom.bytecode);
const over = A.assemble("conclave-strategy 1 ruleset 2\nz = zw 32\nw = wsum 12\n" + "x = sig T5\n".repeat(12) + "pos x\n"); check("over the cap is refused through WASM", !over.ok && over.work === 65 && over.bytecode === null && over.errors[0].msg.includes("over the cap of 64"));
check("a malformed source is an error object, not a crash", A.assemble("garbage").ok === false && A.assemble("\u0000\u0001").ok === false);
console.log(`author wasm: ${n - bad}/${n} checks agree with the native CLI and the conformance WASM`); process.exit(bad ? 1 : 0);
