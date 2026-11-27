import { links } from "@/lib/links";
import styles from "./SiteFooter.module.css";

const GROUPS = [
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
                {g.items.map(i => <li key={i.href}><a className="ruled" href={i.href} target="_blank" rel="noopener noreferrer">{i.label}</a></li>)}
              </ul>
            </div>
          ))}
        </nav>
      </div>
    </footer>
  );
}
