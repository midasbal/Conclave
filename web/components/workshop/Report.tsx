// The engine's ensemble report, set out as a record. Every figure is the engine's; the sentences say what each one is, and no more.
import type { Ensemble, SimResult } from "@/lib/engine/types";
import { pct, vol, whole } from "@/lib/workshop/format";
import styles from "./Report.module.css";

type Props = { result: SimResult; stale: boolean; repeat: "first" | "same" | "different" };

const ROWS: { label: string; get: (e: Ensemble) => string }[] = [
  { label: "Median season total", get: e => vol(e.season_total.p50) },
  { label: "Mean", get: e => vol(e.season_total.mean) },
  { label: "90% interval for the mean", get: e => `${vol(e.ci90_mean[0])} to ${vol(e.ci90_mean[1])}` },
  { label: "Worlds ending ahead", get: e => pct(e.season_total.positive_share) },
  { label: "Worst world", get: e => vol(e.season_total.min) },
  { label: "1 in 20 worse than", get: e => vol(e.season_total.p5) },
  { label: "1 in 4 worse than", get: e => vol(e.season_total.p25) },
  { label: "1 in 4 better than", get: e => vol(e.season_total.p75) },
  { label: "1 in 20 better than", get: e => vol(e.season_total.p95) },
  { label: "Best world", get: e => vol(e.season_total.max) },
  { label: "Episodes hitting the ruin floor", get: e => `${(e.ruin_rate * 100).toFixed(1)}%` },
];

export function Report({ result, stale, repeat }: Props) {
  const r = result.report;
  const z = Math.abs(r.dev_vs_holdout_z);
  return (
    <article className={styles.report} aria-labelledby="report-title">
      {stale && <p className={styles.stale} role="status">This report is for an earlier version of the strategy. Run it again to see the current one.</p>}
      <header className={styles.head}>
        <div>
          <h2 id="report-title">Practice report</h2>
          <p className={styles.sub}>{r.config.worlds} seeded worlds of {r.config.episodes} episodes, on this device. {r.ops} instructions, {r.work} work units.</p>
        </div>
        <p className={styles.score}>
          <span>Median season total</span>
          <strong data-testid="score">{vol(r.dev.season_total.p50)}</strong>
          <span>vol-units</span>
        </p>
      </header>
      <p className={styles.units}>
        <strong>Vol-units are not money.</strong> They measure gain or loss against how much the market was moving. The engine counts in fixed point,
        where 65,536 raw units make one vol-unit; this report shows them already divided.
      </p>

      <section aria-labelledby="against-title">
        <h3 id="against-title">Against the built-in field</h3>
        {r.field ? (
          <>
            <p className={styles.rank}>
              Median rank <strong data-testid="rank">{whole(r.field.median_rank)}</strong> of {r.field.size}. In the middle half of worlds it placed from {whole(r.field.p25_rank)} to {whole(r.field.p75_rank)}.
              It finished in the top half in {pct(r.field.top_half_share)} of worlds and in the top tenth in {pct(r.field.top_tenth_share)}.
            </p>
            <p className={styles.fine}>The field is {r.field.size - 1} reference strategies built into the engine, run on the same worlds. They are not the eight examples, and they are not players.</p>
          </>
        ) : <p>The engine returned no field for this run.</p>}
      </section>

      <section aria-labelledby="unseen-title">
        <h3 id="unseen-title">Two sets of worlds</h3>
        <table className={styles.table}>
          <thead><tr><th scope="col">Season total, vol-units</th><th scope="col">Practice worlds</th><th scope="col">Unseen worlds</th></tr></thead>
          <tbody>{ROWS.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.get(r.dev)}</td><td>{row.get(r.holdout)}</td></tr>)}</tbody>
        </table>
        <p className={styles.fine}>
          The practice worlds are the same on every run. The unseen worlds are seeded from your bytecode, so any change to the instructions draws new ones. The two means are{" "}
          {z.toFixed(1)} standard errors apart; the engine warns at 2. If you keep editing until these look good too, they stop being unseen.
        </p>
      </section>

      <section aria-labelledby="warnings-title">
        <h3 id="warnings-title">Weakness warnings</h3>
        {r.fragility.length > 0 && <p className={styles.fine}>These are the engine&rsquo;s own words. Where it says money, it means vol-units.</p>}
        {r.fragility.length ? <ul className={styles.warnings} data-testid="warnings">{r.fragility.map(f => <li key={f}>{f}</li>)}</ul>
          : <p data-testid="warnings">The engine raised none. That is not evidence that the strategy is good.</p>}
      </section>

      <details className={styles.more}>
        <summary>More from the engine</summary>
        <div>
          <p>
            Measured as a share of the best practice world&rsquo;s total, the gap between that world and the median is {Math.round(r.luck_gap_pct)}%. That is how much quoting one good
            seed could overstate. The strategy held a position {pct(r.held_share)} of the time, changed it by {r.turnover_per_tick.toFixed(3)} per tick on average, and trading costs took{" "}
            {pct(r.cost_share_of_gross)} of gross profit.
          </p>
          <table className={styles.table}>
            <caption>Each market pack on its own, {r.config.pack_episodes} episodes each. A season draws two of the six.</caption>
            <thead><tr><th scope="col">Pack</th><th scope="col">Mean per episode</th><th scope="col">Episodes ahead</th><th scope="col">Ruined</th></tr></thead>
            <tbody>{r.packs.map(p => <tr key={p.pack}><th scope="row">{p.pack}</th><td>{vol(p.mean, 2)}</td><td>{pct(p.win_rate)}</td><td>{(p.ruin_rate * 100).toFixed(1)}%</td></tr>)}</tbody>
          </table>
          {r.regimes && (
            <table className={styles.table}>
              <caption>By the hidden market regime behind each tick, in the practice worlds. A strategy cannot see these names.</caption>
              <thead><tr><th scope="col">Regime</th><th scope="col">Share of ticks</th><th scope="col">In a position</th><th scope="col">Per tick</th></tr></thead>
              <tbody>{r.regimes.map(g => <tr key={g.regime}><th scope="row">{g.name}</th><td>{pct(g.tick_share)}</td><td>{pct(g.held_share)}</td><td>{vol(g.pnl_per_tick, 4)}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      </details>

      <footer className={styles.print}>
        <p>
          {repeat === "same" ? <strong data-testid="repeat">Identical to the previous run of this bytecode, byte for byte. </strong>
            : repeat === "different" ? <strong data-testid="repeat">This differs from the previous run of the same bytecode. That should not happen. </strong> : null}
          The same bytecode always gives the same report. This one&rsquo;s fingerprint:
        </p>
        <code data-testid="fingerprint">{result.fingerprint}</code>
        <p>Base seed {r.config.base}. Computed in {result.ms < 1000 ? `${Math.max(1, Math.round(result.ms))} ms` : `${(result.ms / 1000).toFixed(1)} s`}.</p>
      </footer>
    </article>
  );
}
