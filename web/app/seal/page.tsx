import type { Metadata } from "next";
import { SealExperiment } from "@/components/seal/SealExperiment";
import { reading } from "@/lib/docsFont";
import { links } from "@/lib/links";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Seal experiment", description: "An experiment on Solana devnet: can a browser wallet sign what sealing a strategy needs?", robots: { index: false, follow: false } };

export default function SealPage() {
  return (
    <div className={`page ${styles.page} ${reading.variable}`} data-tip-root="">
      <header className={styles.head}>
        <p className={styles.kind}>Experiment, not the finished feature</p>
        <h1>Can your wallet seal a strategy?</h1>
        <p>This page tests one thing on Solana devnet: whether a browser wallet will sign the three things sealing needs. It seals a throwaway strategy and reads it back.</p>
        <noscript><p>This experiment needs JavaScript.</p></noscript>
      </header>
      <aside className={styles.warning} aria-labelledby="warning-title">
        <h2 id="warning-title">What sealing exposes</h2>
        <ul>
          <li><strong>Your wallet is handed the strategy in plain form.</strong> To sign the Seal it receives the code and salt. What it, or any service it uses to preview transactions, does with them is not known. Finding out is part of this test.</li>
          <li><strong>Closing a sealed strategy makes its code and salt public, permanently</strong>, to anyone, from devnet&rsquo;s transaction history. This page never closes anything. <a href={links.disclosure} target="_blank" rel="noopener noreferrer">Why</a>.</li>
          <li><strong>Privacy rests on the rollup&rsquo;s enclave.</strong> This page does not check its attestation, and what its operator can see has not been tested.</li>
          <li><strong>Never use a strategy you care about, or a wallet that holds anything of value.</strong></li>
        </ul>
      </aside>
      <SealExperiment />
    </div>
  );
}
