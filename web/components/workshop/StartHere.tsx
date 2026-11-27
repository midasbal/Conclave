// What a first visitor reads before the editor: three plain steps and one button that does the second.
import { HelpTip } from "./HelpTip";
import styles from "./StartHere.module.css";

export function StartHere({ isExample, canRun, running, onRun }: { isExample: boolean; canRun: boolean; running: boolean; onRun: () => void }) {
  return (
    <section className={styles.start} data-needs-script="" aria-labelledby="start-title">
      <h2 id="start-title">Start here</h2>
      <ol>
        <li>
          <strong>Pick a strategy</strong>
          <span>{isExample ? "An example is already in the editor. Keep it, or load another." : "Your own draft is in the editor. You can also load an example."}</span>
        </li>
        <li>
          <strong>Run it</strong>
          <span>It plays through made-up markets, here on your own device.</span>
        </li>
        <li>
          <strong>See how it did</strong>
          <span>
            You get a score<HelpTip term="volUnits" /> and a rank against a built-in field<HelpTip term="field" />. Then change something and run it again.
          </span>
        </li>
      </ol>
      <button type="button" className={styles.go} onClick={onRun} disabled={!canRun}>
        {running ? "Running..." : isExample ? "Run this example" : "Run your strategy"}
      </button>
    </section>
  );
}
