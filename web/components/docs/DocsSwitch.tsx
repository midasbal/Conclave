// The two audiences, side by side, as the record's filters are set.
import Link from "next/link";
import styles from "./DocPage.module.css";

const TABS = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/using", label: "Using Conclave" },
  { href: "/docs/technical", label: "Technical" },
] as const;

export function DocsSwitch({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav className={styles.switch} aria-label="Documentation">
      {TABS.map(t => <Link key={t.href} href={t.href} aria-current={t.href === current ? "page" : undefined}>{t.label}</Link>)}
    </nav>
  );
}
