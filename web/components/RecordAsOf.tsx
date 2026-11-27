// When the record was built. Said on every page that shows it, because a cached or lagging record looks exactly like a current one.
import type { AsOf } from "@/lib/record-types";
import { age, minute } from "@/lib/describe";
import styles from "./RecordAsOf.module.css";

// the service rebuilds its record every few minutes when it is running; past this, say plainly that it is behind
const BEHIND_AFTER_MS = 20 * 60 * 1000;

export function RecordAsOf({ asOf, now }: { asOf: AsOf; now: number }) {
  const behind = now - Date.parse(asOf.builtAt);
  return (
    <div className={styles.asof}>
      <p>Record built <time dateTime={asOf.builtAt}>{minute(asOf.builtAt)}</time></p>
      {behind > BEHIND_AFTER_MS && <p className={styles.behind}>It has not been rebuilt for {age(behind)}. Anything newer is missing from this page.</p>}
    </div>
  );
}
