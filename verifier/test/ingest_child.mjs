// Run by ingest.test.mjs: a capture loop over recorded devnet responses, slowed so that a test can kill it in the middle of a cycle.
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { Ingest } from "../lib/ingest.mjs"; import { replay, withLaterReads } from "./recorded.mjs";
const here = path.dirname(fileURLToPath(import.meta.url)); const tape = withLaterReads(JSON.parse(fs.readFileSync(path.join(here, "fixtures", "devnet-all.json")))); const delay = Number(process.env.DELAY_MS ?? 15);
const slow = s => new Proxy(s, { get: (t, k) => typeof t[k] === "function" && ["account", "signatures", "transaction"].includes(k) ? async (...a) => { await new Promise(r => setTimeout(r, delay)); return t[k](...a); } : t[k] });
const ing = new Ingest(slow(replay(tape)), { dir: process.env.STORE, sweepMs: 3600_000 }); await ing.open(); console.log("started"); await ing.cycle(); console.log("finished"); ing.close();
