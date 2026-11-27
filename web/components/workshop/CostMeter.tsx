// What the strategy costs: instructions and work units against their limits of 64, and the smallest division it fits. The numbers are the assembler's.
import type { Assembly } from "@/lib/engine/types";
import type { HelpKey } from "@/lib/workshop/help";
import { HelpTip } from "./HelpTip";
import styles from "./CostMeter.module.css";

const LIMIT = 64;

function Meter({ label, help, used, marks }: { label: string; help: HelpKey; used: number; marks?: number[] }) {
  const over = used > LIMIT;
  return (
    <div className={styles.row}>
      <p><span>{label}<HelpTip term={help} /></span><strong>{used}<small> of {LIMIT}</small></strong></p>
      <div className={styles.track} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={LIMIT} aria-valuenow={Math.min(used, LIMIT)} aria-valuetext={over ? `${used}, over the limit of ${LIMIT}` : `${used} of ${LIMIT}`}>
        <i className={over ? styles.over : undefined} style={{ transform: `scaleX(${Math.min(used / LIMIT, 1)})` }} />
        {marks?.map(m => <b key={m} style={{ left: `${(m / LIMIT) * 100}%` }} />)}
      </div>
    </div>
  );
}

export function CostMeter({ assembly }: { assembly: Assembly | null }) {
  const over = assembly !== null && (assembly.work > LIMIT || assembly.ops.length > LIMIT);
  const partial = assembly !== null && assembly.errors.length > 0 && !over;
  return (
    <section className={styles.meter} aria-label="Cost">
      <Meter label="Instructions" help="instructions" used={assembly?.ops.length ?? 0} />
      <Meter label="Work units per tick" help="work" used={assembly?.work ?? 0} marks={[16, 32]} />
      <p className={styles.division}>
        <span>Division<HelpTip term="division" /></span>
        <strong data-testid="division">{assembly === null ? "..." : over ? "over the cap" : partial ? "not yet known" : assembly.division}</strong>
      </p>
      <p className={styles.note}>
        {over ? "Over the limit: a strategy like this is refused." : partial ? "Counted from the lines that assemble so far." : "A strategy can enter a season whose division is at or above its own. The marks are at 16 and 32."}
      </p>
    </section>
  );
}
