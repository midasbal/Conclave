"use client";
// Client-side only because it marks where you are, and offers the wallet inside the app and nowhere else.
// Three places to read and work in, and one thing to do: sealing is the only filled control in the header.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletMenu } from "./WalletMenu";
import styles from "./SiteHeader.module.css";

export function SiteNav() {
  const path = usePathname();
  const inside = path === "/app" || path.startsWith("/app/");
  const docs = path === "/docs" || path.startsWith("/docs/");
  const workshop = path === "/workshop";
  const sealing = path === "/seal";
  return (
    <nav aria-label="Main" className={styles.tools}>
      {/* the Workshop and the seal page are not fetched ahead of time: that would preload their stylesheets on pages that never use them, which the browser reports */}
      <div className={styles.links}>
        <Link className="ruled" href="/workshop" prefetch={false} aria-current={workshop ? "page" : undefined}>Workshop</Link>
        <Link className="ruled" href="/app" aria-current={inside ? "page" : undefined}>The record</Link>
        <Link className="ruled" href="/docs" aria-current={docs ? "page" : undefined}>Docs</Link>
      </div>
      {/* in the record, and on the seal page, where a connected wallet is shown and never asked to sign */}
      {(inside || sealing) && <div className={styles.wallet}><WalletMenu /></div>}
      <Link className={styles.seal} href="/seal" prefetch={false} aria-current={sealing ? "page" : undefined}>Seal<span className={styles.rest}> a strategy</span></Link>
    </nav>
  );
}
