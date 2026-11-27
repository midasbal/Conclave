import { links } from "@/lib/links";
import styles from "./SiteFooter.module.css";

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`page ${styles.inner}`}>
        <p className={styles.status}>Solana devnet. Not audited.</p>
        <nav aria-label="Project" className={styles.nav}>
          <a className="ruled" href={links.repo}>Repository</a>
          <a className="ruled" href={links.lifecycle}>Program specification</a>
          <a className="ruled" href={links.proofs}>Records and proofs</a>
          <a className="ruled" href={links.api}>Record API</a>
          <a className="ruled" href={links.x}>@wjmdiary on X</a>
        </nav>
      </div>
    </footer>
  );
}
