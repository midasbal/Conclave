// The strategy language, rendered on the server: it can be read without script. The instruction entries are the engine's own (lib/workshop/instructions.ts);
// the signals are described from the VM's code (crates/conclave-vm/src/lib.rs); the rest follows docs/AUTHORING.md and the ruleset.
import Link from "next/link";
import { INSTRUCTIONS, WORK_NOTE } from "@/lib/workshop/instructions";
import { Ledger } from "@/components/docs/Parts";
import { links } from "@/lib/links";
import styles from "./Reference.module.css";

const MARKET = [
  ["U1", "This tick’s return."],
  ["CUM", "The cumulative return since the episode began."],
  ["T5", "The trend over the last 5 ticks: their summed return, scaled for the window’s length."],
  ["T10", "The same over 10 ticks."],
  ["T20", "The same over 20 ticks."],
  ["MOM", "The summed return of the last 20 ticks, measured against the slower volatility estimate."],
  ["VOLR", "The faster volatility estimate divided by the slower one: above 1 when the market has just become livelier."],
  ["ZSC", "How far the cumulative return stands from its own moving average, in units of five times the volatility."],
  ["TLEFT", "The share of the episode still to come, falling to 0 at the last tick."],
];
const SEAT = [
  ["POS", "Your current position, from -1 to 1."],
  ["CASH", "Closed trades’ gains and losses, less all trading costs so far."],
  ["PNL", "Your total gain or loss in this episode, the open trade included."],
  ["DD", "Your drawdown: how far PNL is below its peak in this episode."],
];

export function Reference() {
  return (
    <section id="reference" className={styles.reference} aria-labelledby="reference-title">
      <header>
        <h2 id="reference-title">Strategy language</h2>
        <p>Source format 1, ruleset 2. A strategy runs once on every tick of a market; an episode is 150 ticks. The same description, with what the simulator measures, is in the <a href={links.authoring}>authoring guide</a>; how it fits the program is in the <Link href="/docs/technical#determinism">technical docs</Link>.</p>
      </header>

      <details open>
        <summary><h3>Writing a program</h3></summary>
        <div>
          <ul>
            <li>The first statement is the header: <code>conclave-strategy 1 ruleset 2</code>.</li>
            <li><code>name</code>, <code>author</code> and <code>note</code> are optional, each with one quoted string of plain ASCII, at most 80 characters. They are not part of the bytecode.</li>
            <li>One instruction to a line: <code>[destination =] instruction operands</code>. <code>#</code> starts a comment.</li>
          </ul>
        </div>
      </details>
      <details>
        <summary><h3>Registers and numbers</h3></summary>
        <div>
          <ul>
            <li>There are 16 registers, <code>r0</code> to <code>r15</code>. Give them names: a name takes the lowest free register when it is first written. Writing <code>r0</code> to <code>r15</code> yourself reserves that one.</li>
            <li><code>free NAME</code> releases a register.</li>
            <li>Registers keep their values from tick to tick within an episode and start at 0 in each one. <code>state NAME</code> declares one you mean to read before writing it in the same tick; reading a name that does not exist yet is an error.</li>
            <li>Numbers are plain decimals, stored in fixed point: <code>const</code> to 1/256 (from -128 to 127.99609375), and the thresholds of <code>gti</code>, <code>lti</code> and <code>thr</code> to 1/32 (from -4 to 3.96875). A value that cannot be stored exactly raises a warning that shows what was kept.</li>
            <li>Results of arithmetic saturate at the limits of the number type; they do not wrap.</li>
          </ul>
        </div>
      </details>
      <details>
        <summary><h3>Market and position signals</h3></summary>
        <div>
          <p>Read one with <code>sig NAME</code>. Returns are measured against recent volatility, in vol-units.</p>
          <h4>The market, the same for every strategy</h4>
          <Ledger rows={MARKET.map(([term, text]) => ({ term, text }))} />
          <h4>Your own seat</h4>
          <Ledger rows={SEAT.map(([term, text]) => ({ term, text }))} />
        </div>
      </details>
      <details>
        <summary><h3>Instructions</h3></summary>
        <div>
          {INSTRUCTIONS.map(g => (
            <div key={g.group} className={styles.group}>
              <h4>{g.group}</h4>
              <dl>{g.ops.map(o => <div key={o.usage}><dt><code>{o.usage}</code></dt><dd>{o.does}</dd></div>)}</dl>
            </div>
          ))}
        </div>
      </details>
      <details>
        <summary><h3>Position and stops</h3></summary>
        <div>
          <ul>
            <li>A position is a direction and a size. <code>pos a</code> sets both from one number between -1 and 1; <code>long</code>, <code>short</code>, <code>flat</code> and <code>size</code> set them separately. What the seat holds after a tick earns or loses on the next one.</li>
            <li>The position is held to at most 1 in either direction, whatever the program computes.</li>
            <li><code>stopset a</code> sets how much the open trade may lose, in vol-units, before the seat is flattened. It stays flat until <code>stopclr</code> is given a nonzero value.</li>
          </ul>
        </div>
      </details>
      <details>
        <summary><h3>Limits and costs</h3></summary>
        <div>
          <Ledger rows={[
            { term: "Instructions", text: "At most 64." },
            { term: "Work", text: `At most 64 units a tick. By instruction: ${WORK_NOTE.replace("work per instruction: ", "").split(" ; ")[0]}, where n is the window.` },
            { term: "Divisions", text: "16, 32 and 64 work units. A strategy can enter a season whose division is at or above its own." },
            { term: "Trading cost", text: "0.15 vol-units for each unit of change in position." },
            { term: "Ruin floor", text: "An episode that reaches -60 vol-units ends the seat’s trading for the rest of that episode." },
            { term: "Tick gap", text: "A single tick’s move counts for at most 24 vol-units." },
            { term: "Markets", text: "A season draws 2 of 6 market packs from its seed, and each episode uses one of the two." },
          ]} />
          <p>These rules are <a href={links.ruleset}>ruleset 2</a>. Changing any of them makes a new ruleset.</p>
        </div>
      </details>
    </section>
  );
}
