// READ-ONLY and KEYLESS. Records what a full build against devnet asks of the RPC, including the stake-token and registry reads, as test/fixtures/devnet-api.json. The API contract tests replay it.
// Public data only: receipts, their history, pool transactions, registry accounts. Run again to refresh the recording.   node test/capture_api_fixture.mjs [rpc url]
import fs from "fs"; import os from "os"; import path from "path"; import { fileURLToPath } from "url";
import { rpcSource } from "../lib/chain.mjs"; import { buildRecord } from "../lib/builder.mjs"; import { recorder } from "./recorded.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const rec = recorder(rpcSource(process.argv[2] ?? "https://rpc.magicblock.app/devnet"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capture-")); const r = await buildRecord(rec, { archiveDir: dir, log: m => console.error(m) });
fs.writeFileSync(path.join(here, "fixtures", "devnet-api.json"), JSON.stringify(rec.tape) + "\n"); fs.rmSync(dir, { recursive: true });
const tok = {}; for (const s of r.seasons) { const k = s.stakeToken.status + ":" + (s.stakeToken.mint ?? "-").slice(0, 6); tok[k] = (tok[k] ?? 0) + 1; }
const reg = {}; for (const v of Object.values(r.registries)) reg[v.status + (v.delegated ? "+delegated" : "")] = (reg[v.status + (v.delegated ? "+delegated" : "")] ?? 0) + 1;
console.log(JSON.stringify(r.counts)); console.log("stake tokens:", JSON.stringify(tok)); console.log("registries:", JSON.stringify(reg), "| strategies", Object.keys(r.registries).length);
