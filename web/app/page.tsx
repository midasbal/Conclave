import Link from "next/link";
import { Exhibit } from "@/components/Exhibit";
import { EnterButton } from "@/components/EnterButton";
import { links } from "@/lib/links";
import styles from "./page.module.css";

// each stage with what it puts in public view and what it keeps out of it
const STAGES = [
  {
    name: "Seal",
    body: "A strategy is a short program. Its code and a random salt go into a private rollup, where only its owner can read them while the strategy stays open. A salted commitment to the code is public from the start, so the code cannot be swapped later.",
    shown: "Strategy number, owner, commitment",
    withheld: "Salt and code",
  },
  {
    name: "Run",
    body: "The season locks and a verifiable random seed draws the markets. Every strategy runs through the same ones inside the rollup. Scoring is integer arithmetic, so an owner can replay their own result.",
    shown: "The season’s terms, set before anyone pays",
    withheld: "The arena the strategies run in",
  },
  {
    name: "Record",
    body: "The program records what each entry is owed, and each prize is claimed on its own. The season leaves a receipt on Solana: who entered, what they committed to, and how they ranked.",
    shown: "Owners, commitments, ranks, seed",
    withheld: "Salt, code and the scores themselves",
  },
];

const LIMITS = [
  {
    name: "Secrecy for good",
    body: <>A strategy is private only while it is open. Closing it makes its salt and code <a href={links.disclosure}>public, permanently</a>. What the rollup&rsquo;s operator can see has not been tested.</>,
  },
  {
    name: "Freedom from trust",
    body: "The season’s validator runs the strategies inside its enclave. Nothing here checks its attestation, and no one else re-runs a season. One key can upgrade the program, and the seed comes from an outside oracle.",
  },
  {
    name: "A measure of skill",
    body: "Anyone can create a season and fill it with their own wallets. A rank says where a strategy placed in that field, and no more.",
  },
];

export default function EntryPage() {
  return (
    <>
      <section className={`page ${styles.hero}`} aria-labelledby="entry-title">
        <div className={styles.statement}>
          <h1 id="entry-title">A league for sealed trading strategies.</h1>
          <p className={styles.lede}>
            Each player seals a strategy in a private rollup on Solana. Only after entries lock are the markets drawn, at random,
            and every strategy runs through the same ones. The prize pool is paid by rank. The markets are synthetic: nothing trades on a real exchange.
          </p>
          <div className={styles.entry}>
            <EnterButton />
            <p>Looking around needs no wallet.</p>
          </div>
        </div>
        <Exhibit />
      </section>

      <section id="season" className={`page ${styles.season}`} aria-labelledby="season-title">
        <header className={styles.seasonHead} data-reveal="">
          <h2 id="season-title">How a season runs</h2>
          <p>Three stages. At each, something goes on public view and something is kept out of it.</p>
        </header>
        <ol className={styles.stages}>
          {STAGES.map((stage, i) => (
            <li key={stage.name} data-reveal="" style={{ "--reveal-delay": `${i * 110}ms` } as React.CSSProperties}>
              <h3>{stage.name}</h3>
              <p>{stage.body}</p>
              <dl>
                <div><dt>On view</dt><dd>{stage.shown}</dd></div>
                <div className={styles.withheld}><dt>Kept back</dt><dd>{stage.withheld}</dd></div>
              </dl>
            </li>
          ))}
        </ol>
      </section>

      <section id="limits" className={`page ${styles.limits}`} aria-labelledby="limits-title">
        <div className={styles.limitsHead} data-reveal="">
          <h2 id="limits-title">What it does not promise</h2>
          <p>Read these before you trust a result. The <a href={links.lifecycle}>program specification</a> sets them out in full.</p>
        </div>
        <div className={styles.limitList}>
          {LIMITS.map((limit, i) => (
            <article key={limit.name} data-reveal="" style={{ "--reveal-delay": `${i * 80}ms` } as React.CSSProperties}>
              <h3>{limit.name}</h3>
              <p>{limit.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className={`page ${styles.onward}`} aria-labelledby="onward-title" data-reveal="">
        <div>
          <h2 id="onward-title">The seasons so far are on record.</h2>
          <Link href="/app" className="ruled">Read the record</Link>
        </div>
      </section>
    </>
  );
}
