// Small set pieces the docs share.
import type { ReactNode } from "react";
import styles from "./Parts.module.css";

/** something a reader must not miss, set the way the record sets what is withheld: on solid ink */
export function Warning({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className={styles.warning}>
      <p className={styles.warningTitle}>{title}</p>
      {children}
    </aside>
  );
}

/** terms and what they mean, as ruled ledger lines */
export function Ledger({ rows }: { rows: { term: string; text: ReactNode }[] }) {
  return (
    <dl className={styles.ledger}>
      {rows.map(r => <div key={r.term}><dt>{r.term}</dt><dd>{r.text}</dd></div>)}
    </dl>
  );
}
