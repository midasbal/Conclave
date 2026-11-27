import type { Metadata } from "next";
import { Workshop } from "@/components/workshop/Workshop";
import { Reference } from "@/components/workshop/Reference";
import { reading } from "@/lib/docsFont";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Workshop", description: "Write a Conclave strategy and test it in your browser. A local practice tool: nothing is sealed or on chain." };

export default function WorkshopPage() {
  return (
    <div className={`page ${styles.page} ${reading.variable}`} data-tip-root="">
      <header className={styles.head} data-arrive="">
        <div>
          <h1>Workshop</h1>
          <p className={styles.lede}>Write a short trading strategy, run it, and see how it scores and ranks against a built-in field. All on your own device, with no wallet.</p>
          <p className={styles.what}>A strategy is a few lines that decide, at each step of a made-up market, whether to bet that it rises, bet that it falls, or stay out.</p>
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
