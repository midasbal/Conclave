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

/** a sequence of instructions, set as ledger lines of named stages: it wraps between steps at any width, where a block of preformatted text would not */
export function Flow({ label, stages }: { label: string; stages: { stage: string; steps: { name: string; note?: string }[] }[] }) {
  return (
    <dl className={styles.flow} aria-label={label}>
      {stages.map(s => (
        <div key={s.stage}>
          <dt>{s.stage}</dt>
          <dd>
            <ol>
              {s.steps.map((step, i) => (
                <li key={`${step.name}-${i}`}>
                  <code>{step.name}</code>
                  {step.note && <span>{step.note}</span>}
                </li>
              ))}
            </ol>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** commands to type. Each is set on its own line and wraps only between its words, with what it does written above it as a shell comment, so a copy still runs */
export function Commands({ lines }: { lines: { cmd: string; note?: string }[] }) {
  return (
    <pre className={styles.commands}>
      <code>
        {lines.map(l => (
          <span key={l.cmd} className={styles.command}>
            {l.note && <span className={styles.note}># {l.note}{"\n"}</span>}
            <span className={styles.line}>
              {l.cmd.split(" ").map((word, i) => <span key={i}>{i > 0 && " "}<span className={styles.word}>{word}</span></span>)}
            </span>
          </span>
        ))}
      </code>
    </pre>
  );
}

/** one long hexadecimal value, shown whole: it breaks in the middle first, and copies without a space */
export function Digest({ value }: { value: string }) {
  const half = Math.ceil(value.length / 2);
  return (
    <pre className={styles.digest}><code>{value.slice(0, half)}<wbr />{value.slice(half)}</code></pre>
  );
}
