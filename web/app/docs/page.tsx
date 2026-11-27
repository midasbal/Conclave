import type { Metadata } from "next";
import Link from "next/link";
import { DocsSwitch } from "@/components/docs/DocsSwitch";
import { links } from "@/lib/links";
import { reading } from "@/lib/docsFont";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Docs" };

const DOORS = [
  {
    href: "/docs/using",
    title: "Using Conclave",
    body: "What it is, how to watch the record, what sealing does and where it ends, how to read a receipt, and how prizes are claimed.",
    covers: ["Watching the record", "Writing and entering", "Sealing and disclosure", "Reading a receipt", "Ranks and prizes", "User questions"],
  },
  {
    href: "/docs/technical",
    title: "Technical",
    body: "How it is put together, what each proof establishes, how to replay a result, and how to check that the deployed program is the published one.",
    covers: ["Architecture", "VM and determinism", "Private rollup and randomness", "Four proof levels", "Reproducible build", "Technical questions"],
  },
];

export default function DocsHome() {
  return (
    <div className={`page ${styles.home} ${reading.variable}`}>
      <DocsSwitch current="/docs" />
      <header className={styles.head}>
        <h1>Documentation</h1>
        <p>
          Conclave runs on Solana devnet and has not been audited. These pages say what it does, what you have to trust to believe it, and what has not been tested.
        </p>
      </header>
      <div className={styles.doors}>
        {DOORS.map((d, i) => (
          // the entrance belongs to the wrapper, so that it does not take over the card's own movement under the pointer
          <div key={d.href} className={styles.slot} data-reveal="" style={{ "--reveal-delay": `${i * 90}ms` } as React.CSSProperties}>
            <Link href={d.href} className={styles.door}>
              <h2>{d.title}</h2>
              <p>{d.body}</p>
              <ul>{d.covers.map(c => <li key={c}>{c}</li>)}</ul>
            </Link>
          </div>
        ))}
      </div>
      <p className={styles.full} data-reveal="">
        The full sources are in the <a href={links.repo}>repository</a>: the <a href={links.lifecycle}>program specification</a>, <a href={links.proofs}>records and proofs</a>, and the <a href={links.api}>record API</a>.
      </p>
    </div>
  );
}
