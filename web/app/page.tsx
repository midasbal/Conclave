import Link from "next/link";
import { Exhibit } from "@/components/Exhibit";
import { links } from "@/lib/links";
import styles from "./page.module.css";

const STAGES = [
  {
    name: "Seal",
    body: "A strategy is a short program. Its code and a random salt go into a private rollup, where only its owner can read them while the strategy stays open. A salted commitment to the code is public from the start, so the code cannot be swapped later.",
  },
  {
    name: "Run",
    body: "The season locks and a verifiable random seed draws the markets. Every strategy runs through the same ones inside the rollup. Scoring is integer arithmetic, so an owner can replay their own result.",
  },
  {
    name: "Record",
    body: "The program records what each entry is owed, and each prize is claimed on its own. The season leaves a receipt on Solana: who entered, what they committed to, and how they ranked.",
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
            <Link href="/app" className={styles.enter}>Enter</Link>
            <p>Looking around needs no wallet.</p>
          </div>
        </div>
        <Exhibit />
      </section>

      <section id="season" className={`page ${styles.section}`} aria-labelledby="season-title">
        <h2 id="season-title">How a season runs</h2>
        <dl className={styles.ledger}>
          {STAGES.map(stage => (
            <div key={stage.name}>
              <dt>{stage.name}</dt>
              <dd>{stage.body}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="limits" className={`page ${styles.section}`} aria-labelledby="limits-title">
        <h2 id="limits-title">What it does not promise</h2>
        <dl className={styles.ledger}>
          <div>
            <dt>Secrecy for good</dt>
            <dd>
              A strategy is private only while it is open. Closing it makes its salt and code <a href={links.disclosure}>public, permanently</a>.
              What the rollup&rsquo;s operator can see has not been tested.
            </dd>
          </div>
          <div>
            <dt>Freedom from trust</dt>
            <dd>
              The season&rsquo;s validator runs the strategies inside its enclave. Nothing here checks its attestation, and no one else re-runs a season.
              One key can upgrade the program, and the seed comes from an outside oracle.
            </dd>
          </div>
          <div>
            <dt>A measure of skill</dt>
            <dd>
              Anyone can create a season and fill it with their own wallets. A rank says where a strategy placed in that field, and no more.
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
