// One reading page: its sections, then its own FAQ. The contents list is built from the same data as the page, so the two cannot disagree.
// The FAQ uses the browser's own disclosure element: it works from the keyboard and without JavaScript.
import type { ReactNode } from "react";
import { DocsSwitch } from "./DocsSwitch";
import styles from "./DocPage.module.css";

export type Section = { id: string; title: string; body: ReactNode };
export type Question = { id: string; q: string; a: ReactNode };
export type Source = { label: string; href: string };

type Props = { path: "/docs/using" | "/docs/technical"; title: string; intro: ReactNode; sections: Section[]; faqTitle: string; faq: Question[]; sources: Source[] };

export function DocPage({ path, title, intro, sections, faqTitle, faq, sources }: Props) {
  const contents = [...sections.map(s => ({ id: s.id, title: s.title })), { id: "faq", title: faqTitle }];
  const list = (
    <ol>
      {contents.map(c => <li key={c.id}><a href={`#${c.id}`}>{c.title}</a></li>)}
    </ol>
  );
  return (
    <div className={`page ${styles.doc}`}>
      <DocsSwitch current={path} />
      <div className={styles.columns}>
        {/* a rail beside the text on a wide screen; above it, closed until asked for, on a narrow one */}
        <nav className={styles.rail} aria-label="On this page">
          <p>On this page</p>
          {list}
        </nav>
        <details className={styles.fold}>
          <summary>On this page</summary>
          <nav aria-label="On this page">{list}</nav>
        </details>

        <article className={styles.article}>
          <header>
            <h1>{title}</h1>
            <div className={styles.intro}>{intro}</div>
          </header>

          {sections.map(s => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
              <h2 id={`${s.id}-h`}>{s.title}</h2>
              {s.body}
            </section>
          ))}

          <section id="faq" aria-labelledby="faq-h">
            <h2 id="faq-h">{faqTitle}</h2>
            <div className={styles.faq}>
              {faq.map(item => (
                <details key={item.id} id={item.id}>
                  <summary><h3>{item.q}</h3></summary>
                  <div className={styles.answer}>{item.a}</div>
                </details>
              ))}
            </div>
          </section>

          <footer className={styles.sources}>
            <p>Where this comes from. If this page and a document below disagree, the document and the code are right.</p>
            <ul>{sources.map(s => <li key={s.href}><a href={s.href}>{s.label}</a></li>)}</ul>
          </footer>
        </article>
      </div>
    </div>
  );
}
