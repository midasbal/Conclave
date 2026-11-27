// The way in is drawn as a pair of doors: a label and a leaf beside it, shut against each other with a hairline seam.
// Pointing at it, or reaching it by keyboard, opens the seam a little; pressing it shuts it again.
import Link from "next/link";
import styles from "./EnterButton.module.css";

export function EnterButton() {
  return (
    <Link href="/app" className={styles.enter}>
      <span className={styles.label}>Enter</span>
      <span className={styles.leaf} aria-hidden="true">
        <svg viewBox="0 0 20 12" width="20" height="12"><path d="M0 6h17M12.5 1.2 17.8 6l-5.3 4.8" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </span>
    </Link>
  );
}
