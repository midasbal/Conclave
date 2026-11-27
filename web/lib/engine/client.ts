// The page's side of the engine. It owns the worker: if the worker throws, traps or stops answering, it is thrown away and a new one is started.
import type { Reply, Request } from "./engine.worker";
import type { Assembly, SeasonResult, SimResult } from "./types";

export type Status =
  | { state: "starting" }
  | { state: "ready"; sha256: string; bytes: number; restarts: number }
  | { state: "failed"; reason: string };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type Body = Request extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

const TIMEOUT_MS = 60_000;
const MAX_RESTARTS_PER_MINUTE = 3;

export class EngineRestarted extends Error {
  constructor() {
    super("The engine stopped and was started again. Run it once more.");
  }
}

export class EngineClient {
  private worker: Worker | null = null;
  private ready: Promise<void> = Promise.resolve();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private restarts: number[] = [];
  private restartCount = 0;
  private closed = false;

  constructor(private onStatus: (s: Status) => void) {}

  start() {
    this.closed = false;
    this.restarts = [];
    this.spawn();
  }

  stop() {
    this.closed = true;
    this.discard(new Error("the engine was closed"));
  }

  private spawn() {
    this.onStatus({ state: "starting" });
    const worker = new Worker(new URL("./engine.worker.ts", import.meta.url));
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const waiting = this.pending.get(reply.id);
      if (!waiting) return;
      this.pending.delete(reply.id);
      clearTimeout(waiting.timer);
      if (reply.ok) waiting.resolve(reply.result);
      else if (reply.fatal) {
        waiting.reject(new EngineRestarted());
        this.crashed();
      } else waiting.reject(new Error(reply.error));
    };
    const broke = () => { if (this.worker === worker) this.crashed(); };
    worker.onerror = broke;
    worker.onmessageerror = broke;
    this.ready = this.send({ op: "start" }).then(result => {
      const r = result as { sha256: string; bytes: number };
      this.onStatus({ state: "ready", ...r, restarts: this.restartCount });
    });
    this.ready.catch((e: Error) => {
      if (this.worker !== worker || this.closed) return;
      this.discard(e);
      this.onStatus({ state: "failed", reason: e.message });
    });
  }

  private discard(reason: Error) {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  private crashed() {
    if (this.closed) return;
    this.discard(new EngineRestarted());
    const now = Date.now();
    this.restarts = [...this.restarts.filter(t => now - t < 60_000), now];
    if (this.restarts.length > MAX_RESTARTS_PER_MINUTE) {
      this.onStatus({ state: "failed", reason: "the engine kept stopping" });
      return;
    }
    this.restartCount += 1;
    this.spawn();
  }

  private send(body: Body): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("the engine is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) this.crashed(); }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...body, id });
    });
  }

  private async call<T>(body: Body): Promise<T> {
    await this.ready;
    return (await this.send(body)) as T;
  }

  assemble(source: string) { return this.call<Assembly>({ op: "assemble", source }); }
  inspect(source: string) { return this.call<{ listing: string; readBack: string | null }>({ op: "inspect", source }); }
  simulate(code: string, worlds: number, episodes: number, base: string) { return this.call<SimResult>({ op: "simulate", code, worlds, episodes, base }); }
  season(codes: string[], sa: string, sb: string, episodes: number) { return this.call<SeasonResult>({ op: "season", codes, sa, sb, episodes }); }
}
