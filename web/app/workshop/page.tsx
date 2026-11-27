import type { Metadata } from "next";
import { Workshop } from "@/components/workshop/Workshop";
import { Reference } from "@/components/workshop/Reference";
import { reading } from "@/lib/docsFont";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Workshop", description: "Write a Conclave strategy and test it in your browser. A local practice tool: nothing is sealed or on chain." };

export default function WorkshopPage() {
  return (
    <div className={`page ${styles.page} ${reading.variable}`}>
      <header className={styles.head}>
        <div>
          <h1>Workshop</h1>
          <p>Write a strategy and run it against seeded synthetic markets, on your own device. No wallet and no chain.</p>
        </div>
        <aside className={styles.notice} aria-label="What this tool is">
          <p><strong>A local practice tool. Nothing here is sealed or on chain, and a practice score does not predict a real result.</strong></p>
          <p>The page sends your strategy to no server. Drafts are saved in this browser&rsquo;s local storage.</p>
        </aside>
      </header>
      <noscript><p className={styles.noscript}>The Workshop needs JavaScript to assemble and run strategies. The language reference below can be read without it.</p></noscript>
      <Workshop reference={<Reference />} />
    </div>
  );
}
