import Link from "next/link";
import { SealMark } from "./SealMark";
import { SiteNav } from "./SiteNav";
import styles from "./SiteHeader.module.css";

export function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={`page ${styles.inner}`}>
        <Link href="/" className={styles.brand}>
          <SealMark />
          <span>Conclave</span>
        </Link>
        <SiteNav />
      </div>
    </header>
  );
}
