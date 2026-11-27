"use client";
// Client-side only because it marks where you are, and offers the wallet inside the app and nowhere else.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletMenu } from "./WalletMenu";
import styles from "./SiteHeader.module.css";

export function SiteNav() {
  const path = usePathname();
  const inside = path === "/app" || path.startsWith("/app/");
  const docs = path === "/docs" || path.startsWith("/docs/");
  return (
    <div className={styles.tools}>
      <nav aria-label="Main" className={styles.nav}>
        <Link className="ruled" href="/app" aria-current={inside ? "page" : undefined}>The record</Link>
        <Link className="ruled" href="/docs" aria-current={docs ? "page" : undefined}>Docs</Link>
        <Link className="ruled" href="/#season">How it runs</Link>
        <Link className="ruled" href="/#limits">Limits</Link>
      </nav>
      {inside && <WalletMenu />}
    </div>
  );
}
