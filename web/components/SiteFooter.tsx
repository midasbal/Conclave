import { links } from "@/lib/links";
import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`page ${styles.inner}`}>
        <p className={styles.status}>Solana devnet. Not audited.</p>
        <nav aria-label="Project" className={styles.nav}>
          <a href={links.repo}>Repository</a>
          <a href={links.lifecycle}>Program specification</a>
          <a href={links.proofs}>Records and proofs</a>
          <a href={links.api}>Record API</a>
        </nav>
      </div>
    </footer>
  );
}
