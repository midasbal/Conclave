import Link from "next/link";
import { links } from "@/lib/links";
import styles from "./SiteFooter.module.css";

// places in this app open here; everything outside it opens in a new tab
const GROUPS: { id: string; title: string; items: { label: string; href: string; here?: boolean }[] }[] = [
  {
    id: "footer-app",
    title: "The app",
    items: [
      { label: "Seal a strategy", href: "/seal", here: true },
      { label: "Workshop", href: "/workshop", here: true },
      { label: "The record", href: "/app", here: true },
      { label: "Docs", href: "/docs", here: true },
    ],
  },
  {
    id: "footer-league",
    title: "The league",
    items: [
      { label: "How a season runs", href: "/#season", here: true },
      { label: "What it does not promise", href: "/#limits", here: true },
    ],
  },
  {
    id: "footer-reading",
    title: "Reading",
    items: [
      { label: "Program specification", href: links.lifecycle },
      { label: "Records and proofs", href: links.proofs },
      { label: "Record API", href: links.api },
    ],
  },
  {
    id: "footer-elsewhere",
    title: "Elsewhere",
    items: [
      { label: "Repository", href: links.repo },
      { label: "X", href: links.x },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={`page ${styles.inner}`}>
        <div className={styles.lead}>
          <p className={styles.name}>Conclave</p>
          <p className={styles.status}>Solana devnet. Not audited.</p>
        </div>
        <nav aria-label="Project" className={styles.nav}>
          {GROUPS.map(g => (
            <div key={g.id}>
              <p id={g.id} className={styles.title}>{g.title}</p>
              <ul aria-labelledby={g.id}>
                {g.items.map(i => (
                  <li key={i.href}>
                    {/* not fetched ahead of time: that would preload other pages' stylesheets here */}
                    {i.here ? <Link className="ruled" href={i.href} prefetch={false}>{i.label}</Link>
                      : <a className="ruled" href={i.href} target="_blank" rel="noopener noreferrer">{i.label}</a>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </footer>
  );
}
