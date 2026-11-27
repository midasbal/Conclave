// One season's receipt, drawn as the landing exhibit is, followed by the rest of what the record says about it and what that rests on.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ReceiptSheet, type Fact, type Stamp } from "@/components/ReceiptSheet";
import { RecordAsOf } from "@/components/RecordAsOf";
import { RecordUnavailable } from "@/components/RecordUnavailable";
import { readSeason } from "@/lib/record";
import type { SeasonDetail } from "@/lib/record-types";
import { day, entrants, fee, minute, outcome, short, units } from "@/lib/describe";
import { explorerAddress, explorerTransaction, links } from "@/lib/links";
import styles from "./page.module.css";

type Props = { params: Promise<{ season: string }> };
const ID = /^[0-9]{1,20}$/;
const EVENT = { created: "Receipt created", delegated: "Handed to the rollup", "bond-released": "Creator’s bond released" } as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { season } = await params;
  return { title: ID.test(season) ? `Season ${season}` : "No such season" };
}

/** the stamp says what kind of record this is. The seal's red is kept for a settled season whose receipt is final */
function stampFor({ summary: s }: SeasonDetail): Stamp {
  if (s.status === "provisional") return { word: "Provisional", note: "still in the rollup", tone: "plain" };
  if (s.kind === "cancelled") return { word: "Cancelled", note: "closed on devnet", tone: "plain" };
  return { word: "Final", note: "closed on devnet", tone: "final" };
}

export default async function SeasonPage({ params }: Props) {
  const { season } = await params;
  if (!ID.test(season)) notFound();
  await connection();
  const result = await readSeason(season);
  if (!result.ok) {
    if (result.problem === "not-found") notFound();
    return <RecordUnavailable problem={result.problem} retryHref={`/app/season/${season}`} />;
  }

  const d = result.data;
  const s = d.summary;
  const ranks = s.kind === "cancelled" ? "none" : s.finals === "played" ? "finals" : "season";
  const entries = [...d.entries].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.slot - b.slot);
  const flags = s.flags.filter(f => !f.info);
  const episodes = d.facts.episodes === null ? "not recorded" : s.finals === "played" ? `${d.facts.episodes}, then ${d.facts.finalsEpisodes} in finals` : String(d.facts.episodes);
  const facts: Fact[] = [
    { label: "Opened", value: s.createdAt ? <time dateTime={day(s.createdAt.unixTime)}>{day(s.createdAt.unixTime)}</time> : "unknown" },
    { label: "Episodes", value: episodes },
    { label: "Entry fee", value: fee(s.fee.perEntry) },
    { label: "Account", value: <a href={explorerAddress(d.receipt.address)} title={d.receipt.address}>{short(d.receipt.address)}</a> },
  ];

  return (
    <div className={`page ${styles.season}`}>
      <p className={styles.back}><Link href="/app" className="ruled">All seasons</Link></p>

      <div className={styles.layout} data-arrive="">
        <div className={styles.receipt}>
          {flags.length > 0 && (
            <div className={styles.alarm} role="alert">
              <h2>This receipt is flagged.</h2>
              <ul>{flags.map(f => <li key={f.kind + f.detail}><strong>{f.kind}</strong>: {f.detail}</li>)}</ul>
              <p>What is shown below is the first final copy that was saved.</p>
            </div>
          )}
          <ReceiptSheet
            heading="h1"
            titleId="receipt-title"
            title={`Season ${s.season}`}
            subtitle={outcome(s)}
            facts={facts}
            ranks={ranks}
            stamp={stampFor(d)}
            emptyNote="No one had entered when this season was cancelled."
            rows={entries.map(e => ({ key: String(e.slot), rank: e.rank, seasonRank: e.seasonRank, slot: e.slot, strategyId: e.strategyId, owner: e.owner, commitment: e.codeCommitment }))}
          />
          <p className={styles.caption}>
            A devnet season, with test stakes. The black bars mark what the receipt does not carry: it has each entry&rsquo;s owner and a commitment to its code,
            not the salt or the code. A strategy&rsquo;s owner can still make both <a href={links.disclosure}>public</a> by closing it.
          </p>
        </div>

        <aside className={styles.margin} aria-label="The rest of the record">
          <RecordAsOf asOf={d.asOf} now={Date.now()} />
          <dl className={styles.notes}>
            <div>
              <dt>Field</dt>
              <dd>
                {entrants(s.fieldSize)}{s.fieldSize > 0 && ` from ${s.distinctEntrantWallets} ${s.distinctEntrantWallets === 1 ? "wallet" : "wallets"}`}.
                {s.creatorIsAlsoAnEntrant ? " The creator entered too." : " The creator did not enter."} More wallets do not show more people.
              </dd>
            </div>
            <div>
              <dt>Creator</dt>
              <dd><span className={styles.mono}>{s.creator}</span></dd>
            </div>
            <div>
              <dt>Validator, taken on trust</dt>
              <dd>
                {s.validator.key ? <span className={styles.mono}>{s.validator.key}</span> : <span>Not established ({s.validator.status}).</span>}
                <span>The creator chose it to run the season. The receipt does not name it, and no attestation has been checked.</span>
              </dd>
            </div>
            <div>
              <dt>Stake</dt>
              <dd>
                {s.fee.token.mint
                  ? <><span>Recorded as owed: {units(s.fee.totalOwed)}{d.facts.totalRefunded !== "0" && `, of which refunds: ${units(d.facts.totalRefunded)}`}. The devnet token, as transaction history names it:</span><span className={styles.mono}>{s.fee.token.mint}</span></>
                  : <span>The token is not known.</span>}
              </dd>
            </div>
            <div>
              <dt>First final copy</dt>
              <dd>
                <span className={styles.mono}>{d.receipt.copy.sha256}</span>
                <span>{s.status === "final" ? `SHA-256 of the receipt as first saved${d.receipt.copy.savedAt ? ` on ${minute(d.receipt.copy.savedAt)}` : ""}.` : "SHA-256 of its current state, which can still change."}</span>
              </dd>
            </div>
            {d.receipt.events.length > 0 && (
              <div>
                <dt>History</dt>
                <dd>
                  <ol>
                    {d.receipt.events.map(e => (
                      <li key={e.signature}>{EVENT[e.type]} <a className={styles.mono} href={explorerTransaction(e.signature)} title={e.signature}>{short(e.signature)}</a></li>
                    ))}
                  </ol>
                </dd>
              </div>
            )}
          </dl>
        </aside>
      </div>
    </div>
  );
}
