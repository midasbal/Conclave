import type { Metadata } from "next";
import { SealFlow } from "@/components/seal/SealFlow";
import { reading } from "@/lib/docsFont";
import { links } from "@/lib/links";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Seal a strategy", description: "Seal a strategy on Solana devnet with a temporary key made in your browser. No wallet and no SOL needed." };

export default function SealPage() {
  return (
    <div className={`page ${styles.page} ${reading.variable}`} data-tip-root="">
      <header className={styles.head}>
        <h1>Seal a strategy</h1>
        <p>Put your strategy&rsquo;s commitment on Solana devnet and its code into a private rollup. A temporary key made in this browser owns it. No wallet and no SOL are needed.</p>
        <noscript><p className={styles.noscript}>Sealing needs JavaScript: the key that owns your strategy is made, and signs, in your browser.</p></noscript>
      </header>
      <aside className={styles.know} aria-labelledby="know-title">
        <h2 id="know-title">Before you seal</h2>
        <ul>
          <li><strong>You keep the only copy.</strong> Before anything happens you save a claim ticket. It is the only proof of ownership and the only copy of the salt and code. We never store it.</li>
          <li><strong>Sealing sends your code off this device,</strong> with its salt, into MagicBlock&rsquo;s private rollup. Privacy rests on the rollup and its enclave. This app does not check the enclave&rsquo;s attestation, and what its operator can see has not been tested.</li>
          <li><strong>Closing a sealed strategy would make its code public, permanently.</strong> This app never closes one. <a href={links.disclosure} target="_blank" rel="noopener noreferrer">Why</a>.</li>
          <li>This is devnet, a test network, and nothing here is audited. Sealing does not enter a competition: this app cannot enter a season yet.</li>
        </ul>
      </aside>
      <SealFlow />
    </div>
  );
}
