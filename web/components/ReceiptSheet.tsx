// A season receipt laid out as a sheet. The landing exhibit and each season's page are this one component, so they cannot drift apart.
// The black bars stand where a strategy's salt and code would be. They are not decoration: a receipt never holds either.
import type { ReactNode } from "react";
import styles from "./ReceiptSheet.module.css";

export type ReceiptRow = { key: string; rank: number | null; seasonRank: number | null; slot: number; strategyId: string; owner: string; commitment: string };
export type Stamp = { word: string; note: string; tone: "final" | "plain" };
export type Fact = { label: string; value: ReactNode };

type Props = {
  titleId: string;
  title: string;
  heading?: "h1" | "h2" | "h3";
  subtitle: string;
  facts: Fact[];
  rows: ReceiptRow[];
  /** "finals": final rank and season rank. "season": one rank. "none": a cancelled season has no ranks, so entries are numbered by seat */
  ranks: "finals" | "season" | "none";
  stamp: Stamp;
  emptyNote?: string;
  /** play the sealing once, when the sheet is first on screen (components/Motion.tsx) */
  sealing?: boolean;
};

/** an identifier cut in the middle. On a narrow screen the tail is dropped; the full value stays in the cell's title */
function Cut({ value, head, tail }: { value: string; head: number; tail: number }) {
  return <>{value.slice(0, head)}…<span className={styles.tail}>{value.slice(-tail)}</span></>;
}

export function ReceiptSheet({ titleId, title, heading: Heading = "h2", subtitle, facts, rows, ranks, stamp, emptyNote, sealing }: Props) {
  return (
    <div className={styles.stack} {...(sealing ? { "data-seal": "" } : {})}>
      <div className={styles.sheet}>
        <div className={styles.title}>
          <Heading id={titleId}>{title}</Heading>
          <p>{subtitle}</p>
        </div>

        <dl className={styles.facts}>
          {facts.map(f => (
            <div key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></div>
          ))}
        </dl>

        {rows.length === 0 ? (
          <p className={styles.empty}>{emptyNote}</p>
        ) : (
          <table className={styles.table} aria-labelledby={titleId}>
            <thead>
              <tr>
                {ranks === "finals" && <th scope="col"><abbr title="Final rank">Final</abbr></th>}
                {ranks === "finals" && <th scope="col"><abbr title="Rank after the season, before the finals">Season</abbr></th>}
                {ranks === "season" && <th scope="col">Rank</th>}
                {ranks === "none" && <th scope="col">Seat</th>}
                <th scope="col">Strategy</th>
                <th scope="col">Code commitment</th>
                <th scope="col">Salt and code</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={row.key}>
                  <td className={styles.rank}>{ranks === "none" ? row.slot + 1 : row.rank ?? "none"}</td>
                  {ranks === "finals" && <td>{row.seasonRank ?? "none"}</td>}
                  <td title={`Strategy ${row.strategyId}, entered by ${row.owner}`}><Cut value={row.strategyId} head={4} tail={4} /></td>
                  <td title={row.commitment}><Cut value={row.commitment} head={6} tail={4} /></td>
                  <td>
                    <span data-bar="" className={styles.bar} style={{ "--i": i } as React.CSSProperties} />
                    <span className="sr-only">Not on the receipt</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p data-stamp="" className={`${styles.stamp} ${stamp.tone === "final" ? styles.final : styles.plain}`}>
          <strong>{stamp.word}</strong>
          <span>{stamp.note}</span>
        </p>
      </div>
    </div>
  );
}
