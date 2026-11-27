// The league's public record, for anyone. Rendered on the server from the record API; no wallet, no login.
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { RecordAsOf } from "@/components/RecordAsOf";
import { RecordUnavailable } from "@/components/RecordUnavailable";
import { readSeasons } from "@/lib/record";
import type { SeasonSummary } from "@/lib/record-types";
import { day, entrants, fee, outcome } from "@/lib/describe";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "The record" };

const FILTERS = [
  { key: "all", label: "All", keep: () => true },
  { key: "settled", label: "Settled", keep: (s: SeasonSummary) => s.kind === "settled" },
  { key: "cancelled", label: "Cancelled", keep: (s: SeasonSummary) => s.kind === "cancelled" },
];

export default async function RecordPage({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  await connection(); // rendered when asked for, never at build time; the reads themselves are cached (lib/record.ts)
  const { show } = await searchParams;
  const result = await readSeasons();
  // the list address never answers "not found" for a season; if it did, it is not the record API
  if (!result.ok) return <RecordUnavailable problem={result.problem === "not-found" ? "unexpected" : result.problem} retryHref="/app" />;

  const { seasons, asOf, page } = result.data;
  const filter = FILTERS.find(f => f.key === show) ?? FILTERS[0];
  const listed = seasons.filter(filter.keep);
  const count = (key: string) => seasons.filter(FILTERS.find(f => f.key === key)!.keep).length;

  return (
    <div className={`page ${styles.record}`}>
      <header className={styles.head}>
        <div>
          <h1>The record</h1>
          <p>
            Season receipts that the record service has read from <strong>Solana devnet</strong>, newest first. These are devnet seasons played with test stakes.
            Anyone can create one, so a listing here is a record that it happened and not an endorsement of it.
          </p>
        </div>
        <RecordAsOf asOf={asOf} now={Date.now()} />
      </header>

      <nav className={styles.filters} aria-label="Show seasons">
        {FILTERS.map(f => (
          <Link key={f.key} href={f.key === "all" ? "/app" : `/app?show=${f.key}`} aria-current={f.key === filter.key ? "true" : undefined} scroll={false}>
            {f.label} <span>{count(f.key)}</span>
          </Link>
        ))}
        {page.total > seasons.length && <p>Showing the newest {seasons.length} of {page.total}.</p>}
      </nav>

      {listed.length === 0 ? (
        <p className={styles.none}>{seasons.length === 0 ? "The record holds no season yet." : "No season of this kind is on record."}</p>
      ) : (
        <div className={styles.register}>
          <div className={styles.columns} aria-hidden="true">
            <span>Season</span><span>Opened</span><span>Outcome</span><span>Field</span><span>Entry fee</span><span>Receipt</span>
          </div>
          <ol>
            {listed.map(s => {
              const flagged = s.flags.some(f => !f.info);
              return (
                <li key={s.season}>
                  <Link href={`/app/season/${s.season}`} className={styles.row} prefetch={false}>
                    <span className={styles.number}><span className="sr-only">Season </span>{s.season}</span>
                    <span className={styles.opened}><span className="sr-only">, opened </span>{s.createdAt ? day(s.createdAt.unixTime) : "date unknown"}</span>
                    <span className={s.kind === "cancelled" ? styles.cancelled : styles.outcome}><span className="sr-only">, </span>{outcome(s)}</span>
                    <span className={styles.field}><span className="sr-only">, </span>{entrants(s.fieldSize)}</span>
                    <span className={styles.fee}><span className="sr-only">, entry fee </span>{fee(s.fee.perEntry)}</span>
                    <span className={styles.status}>
                      <span className="sr-only">, receipt </span>
                      {flagged ? <b className={styles.flagged}>Flagged</b> : s.status === "final" ? "Final" : <i>Provisional</i>}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <p className={styles.key}>
        <strong>Final</strong> means the receipt is closed and back on Solana. <strong>Provisional</strong> means it is still held in the rollup and can change.
        <strong> Flagged</strong> means the record service found something wrong with it, or with the saved copy, after first saving it.
      </p>
    </div>
  );
}
