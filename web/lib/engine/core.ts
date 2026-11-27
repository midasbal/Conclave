// The browser port of client/author.mjs: the same calls on the same module, with typed arrays and DataView where the Node loader used Buffer.
// The module's convention: reserve input with ca_alloc, copy it in, call, then read as many bytes at ca_out() as the call returned.
// Memory can grow during any call, so a view of it is never kept across one.
export type Exports = {
  memory: WebAssembly.Memory;
  ca_alloc(n: number): number;
  ca_out(): number;
  ca_assemble(ptr: number, len: number): number;
  ca_listing(ptr: number, len: number): number;
  ca_disassemble(ptr: number, len: number): number;
  ca_simulate(ptr: number, len: number): number;
  ca_season(ptr: number, len: number): number;
  ca_episode(ptr: number, len: number, pack: number, esLo: number, esHi: number): bigint;
  ca_trace(ptr: number, len: number, pack: number, saLo: number, saHi: number, sbLo: number, sbHi: number, ep: number): bigint;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LOW = BigInt("0xffffffff");
const HALF = BigInt(32);
const halves = (v: bigint): [number, number] => [Number(v & LOW), Number(v >> HALF)];

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("not hexadecimal");
  return Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16));
}

export function createEngine(x: Exports) {
  const put = (bytes: Uint8Array) => {
    const ptr = x.ca_alloc(bytes.length || 1);
    new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
    return ptr;
  };
  const out = (length: number) => decoder.decode(new Uint8Array(x.memory.buffer, x.ca_out(), length).slice());
  const refuse = (text: string) => {
    if (text.startsWith("ERROR")) throw new Error(text.replace(/^ERROR\s*/, ""));
    return text;
  };
  const withText = (call: (p: number, n: number) => number, text: string) => {
    const bytes = encoder.encode(text);
    return out(call(put(bytes), bytes.length));
  };

  return {
    memoryBytes: () => x.memory.buffer.byteLength,
    /** JSON text */
    assemble: (source: string) => withText(x.ca_assemble, source),
    /** the cost table, as text */
    listing: (source: string) => withText(x.ca_listing, source),
    /** bytecode back to canonical source */
    disassemble: (code: Uint8Array) => refuse(out(x.ca_disassemble(put(code), code.length))),
    /** the ensemble report as the engine's own JSON text */
    simulate(code: Uint8Array, o: { worlds: number; episodes: number; base: bigint; field: boolean }) {
      const input = new Uint8Array(22 + code.length);
      const header = new DataView(input.buffer, 0, 22);
      header.setUint8(0, 0); // JSON, not the text report
      header.setUint32(1, o.worlds, true);
      header.setUint32(5, o.episodes, true);
      header.setBigUint64(9, o.base, true);
      header.setUint8(17, o.field ? 1 : 0);
      header.setUint32(18, 0, true);
      input.set(code, 22);
      return refuse(out(x.ca_simulate(put(input), input.length)));
    },
    /** several strategies through one season, the chain's own loop. Totals are raw fixed point, as decimal strings, in input order */
    season(codes: Uint8Array[], sa: bigint, sb: bigint, episodes: number): { packs: [number, number]; totals: string[] } {
      const input = new Uint8Array(21 + codes.reduce((sum, c) => sum + 2 + c.length, 0));
      const view = new DataView(input.buffer);
      view.setBigUint64(0, sa, true);
      view.setBigUint64(8, sb, true);
      view.setUint32(16, episodes, true);
      view.setUint8(20, codes.length);
      let at = 21;
      for (const code of codes) {
        view.setUint16(at, code.length, true);
        input.set(code, at + 2);
        at += 2 + code.length;
      }
      return JSON.parse(refuse(out(x.ca_season(put(input), input.length))));
    },
    /** one episode's raw final PnL, given the episode seed */
    episode(code: Uint8Array, pack: number, episodeSeed: bigint) {
      return x.ca_episode(put(code), code.length, pack, ...halves(episodeSeed));
    },
    /** one episode's raw final PnL, seeded as the conformance TRACE vector is */
    trace(code: Uint8Array, pack: number, sa: bigint, sb: bigint, episode: number) {
      return x.ca_trace(put(code), code.length, pack, ...halves(sa), ...halves(sb), episode);
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
