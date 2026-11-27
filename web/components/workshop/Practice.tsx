"use client";
// One season played out: the strategy beside the eight examples, in the chain's own loop, on a seed of the player's choosing. The seed is a practice
// seed, not a random draw from the chain.
import { useState } from "react";
import type { EngineClient } from "@/lib/engine/client";
import type { Assembly, SeasonResult } from "@/lib/engine/types";
import { EXAMPLES } from "@/lib/workshop/examples";
import { fromFixed, vol } from "@/lib/workshop/format";
import { HelpTip } from "./HelpTip";
import styles from "./Practice.module.css";

type Played = { result: SeasonResult; names: string[]; seed: string; episodes: number; code: string };

/** the two season seed words, taken from the practice seed's text */
async function seedWords(seed: string): Promise<[string, string]> {
  const hash = new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`conclave-practice:${seed}`)));
  return [hash.getBigUint64(0, true).toString(), hash.getBigUint64(8, true).toString()];
}

/** places by total, highest first; a tie goes to the earlier entry, and yours is entered last */
function standings(totals: string[]) {
  return totals.map((raw, i) => ({ i, raw, value: BigInt(raw) })).sort((a, b) => (a.value === b.value ? a.i - b.i : a.value > b.value ? -1 : 1));
}

export function Practice({ engine, assembly, ready }: { engine: () => EngineClient | null; assembly: Assembly | null; ready: boolean }) {
  const [seed, setSeed] = useState("1");
  const [episodes, setEpisodes] = useState("15");
  const [played, setPlayed] = useState<Played | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const count = Number(episodes);
  const countOk = Number.isInteger(count) && count >= 1 && count <= 100;
  const canPlay = ready && !busy && countOk && !!assembly?.ok && !!assembly.bytecode;

  const play = async () => {
    const client = engine();
    if (!client || !assembly?.bytecode) return;
    setBusy(true);
    setProblem(null);
    try {
      const rivals = [];
      for (const example of EXAMPLES) {
        const a = await client.assemble(example.source);
        if (!a.bytecode) throw new Error(`the example "${example.name}" did not assemble`);
        rivals.push(a.bytecode);
      }
      const [sa, sb] = await seedWords(seed);
      const result = await client.season([...rivals, assembly.bytecode], sa, sb, count);
      setPlayed({ result, names: [...EXAMPLES.map(e => e.name), "Yours"], seed, episodes: count, code: assembly.bytecode });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const mine = EXAMPLES.length;
  const final = played ? standings(played.result.totals[played.result.totals.length - 1]) : [];
  const place = final.findIndex(s => s.i === mine) + 1;

  return (
    <div className={styles.practice}>
      <form className={styles.controls} onSubmit={e => { e.preventDefault(); if (canPlay) void play(); }}>
        <div className={styles.field}>
          <p><label htmlFor="practice-seed">Practice seed</label><HelpTip term="seed" /></p>
          <input id="practice-seed" value={seed} onChange={e => setSeed(e.target.value.slice(0, 40))} spellCheck={false} />
        </div>
        <button type="button" className="plain-button" onClick={() => setSeed(String(crypto.getRandomValues(new Uint32Array(1))[0]))}>New seed</button>
        <div className={styles.field}>
          <p><label htmlFor="practice-episodes">Episodes, 1 to 100</label><HelpTip term="episodes" /></p>
          <input id="practice-episodes" value={episodes} onChange={e => setEpisodes(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))} inputMode="numeric" aria-invalid={!countOk} />
        </div>
        <button type="submit" className={styles.play} disabled={!canPlay}>{busy ? "Playing..." : "Play a practice season"}</button>
      </form>
      {!assembly?.ok && <p className={styles.fine}>The strategy has to assemble before it can play.</p>}
      {problem && <p role="alert">{problem}</p>}

      {played && (
        <div className={styles.sheet} data-testid="season">
          <p className={styles.summary} role="status">
            Seed &ldquo;{played.seed}&rdquo; drew market packs {played.result.packs[0]} and {played.result.packs[1]}. After {played.episodes} {played.episodes === 1 ? "episode" : "episodes"},
            yours placed <strong>{place} of {final.length}</strong>.{played.code !== assembly?.bytecode && " The strategy has changed since this season was played."}
          </p>
          <table className={styles.table}>
            <thead><tr><th scope="col">Place</th><th scope="col">Strategy</th><th scope="col">Vol-units</th><th scope="col" className={styles.raw}>Fixed point</th></tr></thead>
            <tbody>
              {final.map((s, k) => (
                <tr key={s.i} className={s.i === mine ? styles.mine : undefined}>
                  <td>{k + 1}</td><th scope="row">{played.names[s.i]}</th><td>{vol(fromFixed(s.raw))}</td><td className={styles.raw}>{s.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <details className={styles.course}>
            <summary>Episode by episode</summary>
            <table className={styles.table}>
              <thead><tr><th scope="col">After episode</th><th scope="col">Your total</th><th scope="col">Your place</th><th scope="col">In front</th></tr></thead>
              <tbody>
                {played.result.totals.map((totals, k) => {
                  const order = standings(totals);
                  return (
                    <tr key={k}><td>{k + 1}</td><td>{vol(fromFixed(totals[mine]))}</td><td>{order.findIndex(s => s.i === mine) + 1}</td><th scope="row">{played.names[order[0].i]}</th></tr>
                  );
                })}
              </tbody>
            </table>
          </details>
          <p className={styles.fine}>
            One season is one draw. Another seed can order these nine very differently, which is why the report above looks across many. A tie goes to the earlier entry, and yours is entered last.
          </p>
        </div>
      )}
    </div>
  );
}
