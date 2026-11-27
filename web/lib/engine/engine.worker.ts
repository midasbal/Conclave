// The engine runs here, off the page's thread, so that a long run never freezes typing. It talks only to the page that started it.
// Its one request to the network is for the module itself, a fixed path on this site; nothing a user writes goes into it.
import { ENGINE } from "./build";
import { createEngine, hexToBytes, type Engine, type Exports } from "./core";

export type Request =
  | { id: number; op: "start" }
  | { id: number; op: "assemble"; source: string }
  | { id: number; op: "inspect"; source: string }
  | { id: number; op: "simulate"; code: string; worlds: number; episodes: number; base: string }
  | { id: number; op: "season"; codes: string[]; sa: string; sb: string; episodes: number };

export type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; fatal: boolean };

const RECYCLE_BYTES = 32 * 1024 * 1024; // the module never frees what ca_alloc hands out: past this, start a fresh instance
let compiled: WebAssembly.Module | null = null;
let engine: Engine | null = null;

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");
const digest = async (bytes: BufferSource) => hex(await crypto.subtle.digest("SHA-256", bytes));

async function instantiate() {
  const instance = await WebAssembly.instantiate(compiled!, {});
  engine = createEngine(instance.exports as unknown as Exports);
}

async function start() {
  const response = await fetch(ENGINE.path);
  if (!response.ok) throw new Error(`the engine file did not load (HTTP ${response.status})`);
  const bytes = await response.arrayBuffer();
  const found = await digest(bytes);
  if (found !== ENGINE.sha256) throw new Error("the engine file is not the expected build, so it was not run");
  compiled = await WebAssembly.compile(bytes);
  await instantiate();
  return { sha256: found, bytes: bytes.byteLength };
}

async function handle(m: Request): Promise<unknown> {
  if (m.op === "start") return start();
  if (!engine) throw new Error("the engine is not ready");
  if (engine.memoryBytes() > RECYCLE_BYTES) await instantiate();
  const e = engine!;
  switch (m.op) {
    case "assemble":
      return JSON.parse(e.assemble(m.source));
    case "inspect": {
      const a = JSON.parse(e.assemble(m.source));
      return { listing: e.listing(m.source), readBack: a.bytecode ? e.disassemble(hexToBytes(a.bytecode)) : null };
    }
    case "simulate": {
      const t0 = performance.now();
      const raw = e.simulate(hexToBytes(m.code), { worlds: m.worlds, episodes: m.episodes, base: BigInt(m.base), field: true });
      const ms = performance.now() - t0;
      return { report: JSON.parse(raw), raw, fingerprint: await digest(new TextEncoder().encode(raw)), ms };
    }
    case "season": {
      // the standing after each episode: an episode depends only on the seed and its number, so a season of k episodes is the first k of a longer one
      const t0 = performance.now();
      const codes = m.codes.map(hexToBytes);
      const totals: string[][] = [];
      let packs: [number, number] = [0, 0];
      for (let k = 1; k <= m.episodes; k++) {
        const r = e.season(codes, BigInt(m.sa), BigInt(m.sb), k);
        packs = r.packs;
        totals.push(r.totals);
      }
      return { packs, totals, ms: performance.now() - t0 };
    }
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const m = event.data;
  try {
    self.postMessage({ id: m.id, ok: true, result: await handle(m) } satisfies Reply);
  } catch (error) {
    // a trap leaves the instance in an unknown state: say so, and the page replaces this worker
    const fatal = error instanceof WebAssembly.RuntimeError || error instanceof RangeError;
    self.postMessage({ id: m.id, ok: false, error: error instanceof Error ? error.message : String(error), fatal } satisfies Reply);
  }
};
