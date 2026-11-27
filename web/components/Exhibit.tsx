// A season receipt, as it is. Every value comes from data/exhibit.json, which was taken from the first final copy of a real devnet receipt
// in the repository's record snapshot and checked against its bytes. The black bars are not decoration: they stand where the salt and
// the code would be, and a receipt never holds either.
//
// The one piece of motion on the page happens here, once: the five bars are drawn shut, then the record is stamped.
import exhibit from "@/data/exhibit.json";
import { explorerAddress } from "@/lib/links";
import styles from "./Exhibit.module.css";

const short = (s: string, head: number, tail: number) => `${s.slice(0, head)}…${s.slice(-tail)}`;

/** an identifier cut in the middle. On a narrow screen the tail is dropped; the full value stays in the cell's title */
function Cut({ value, head, tail }: { value: string; head: number; tail: number }) {
  return <>{value.slice(0, head)}…<span className={styles.tail}>{value.slice(-tail)}</span></>;
}

export function Exhibit() {
  return (
    <figure className={styles.figure}>
      <div className={styles.stack}>
      <div className={styles.sheet}>
        <div className={styles.title}>
          <h2 id="exhibit-title">Season {exhibit.season}</h2>
          <p>Receipt on Solana devnet</p>
        </div>

        <dl className={styles.facts}>
          <div><dt>Opened</dt><dd><time dateTime={exhibit.openedOn}>{exhibit.openedOn}</time></dd></div>
          <div><dt>Episodes</dt><dd>{exhibit.episodes}, then {exhibit.finalsEpisodes} in finals</dd></div>
          <div><dt>Entry fee</dt><dd>{exhibit.entryFee} stake units</dd></div>
          <div><dt>Account</dt><dd><a href={explorerAddress(exhibit.receiptAddress)} title={exhibit.receiptAddress}>{short(exhibit.receiptAddress, 4, 4)}</a></dd></div>
        </dl>

        <table className={styles.table} aria-labelledby="exhibit-title">
          <thead>
            <tr>
              <th scope="col"><abbr title="Final rank">Final</abbr></th>
              <th scope="col"><abbr title="Rank after the season, before the finals">Season</abbr></th>
              <th scope="col">Strategy</th>
              <th scope="col">Code commitment</th>
              <th scope="col">Salt and code</th>
            </tr>
          </thead>
          <tbody>
            {exhibit.entries.map((entry, i) => (
              <tr key={entry.strategyId}>
                <td className={styles.rank}>{entry.finalRank}</td>
                <td>{entry.seasonRank}</td>
                <td title={`Strategy ${entry.strategyId}, entered by ${entry.owner}`}><Cut value={entry.strategyId} head={4} tail={4} /></td>
                <td title={entry.codeCommitment}><Cut value={entry.codeCommitment} head={6} tail={4} /></td>
                <td>
                  <span className={styles.bar} style={{ animationDelay: `${350 + i * 110}ms` }} />
                  <span className="sr-only">Not on the receipt</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className={styles.stamp}>
          <strong>Final</strong>
          <span>closed on devnet</span>
        </p>
      </div>
      </div>

      <figcaption className={styles.caption}>
        A real season the project ran with its own test wallets. The finals swapped second and third place.
        The black bars mark what a receipt never carries: it has each entry&rsquo;s owner and a commitment to its code, not the salt or the code.
      </figcaption>
    </figure>
  );
}
