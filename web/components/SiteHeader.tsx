import Link from "next/link";
import { SealMark } from "./SealMark";
import { links } from "@/lib/links";
import styles from "./SiteHeader.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={`page ${styles.inner}`}>
        <Link href="/" className={styles.brand}>
          <SealMark />
          <span>Conclave</span>
        </Link>
        <nav aria-label="Main" className={styles.nav}>
          <Link href="/#season">How a season runs</Link>
          <Link href="/#limits">Limits</Link>
          <a href={links.repo}>Source</a>
        </nav>
      </div>
    </header>
  );
}
