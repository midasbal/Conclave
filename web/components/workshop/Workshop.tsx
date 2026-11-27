"use client";
// The Workshop: write, assemble, run. Everything happens in this browser. The source is held in this component, in the engine's worker and, as a draft,
// in local storage. Nothing here sends it anywhere: there is no request that carries it, no address that holds it and no form that posts it.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EngineClient, type Status } from "@/lib/engine/client";
import type { Assembly, Diagnostic, SimResult } from "@/lib/engine/types";
import { ENGINE } from "@/lib/engine/build";
import { EXAMPLES } from "@/lib/workshop/examples";
import { Editor } from "./Editor";
import { CostMeter } from "./CostMeter";
import { Report } from "./Report";
import { Practice } from "./Practice";
import { StartHere } from "./StartHere";
import { HelpTip } from "./HelpTip";
import styles from "./Workshop.module.css";

export const DRAFT = "conclave.workshop.draft.v1";
export const BACKUP = "conclave.workshop.backup.v1";
/** the run the command line tool makes by default, so that a report here can be reproduced with `conclave-author sim` */
const RUN = { worlds: 48, episodes: 12, base: "0xc0dec1a55e110001" };

const isExample = (s: string) => EXAMPLES.some(e => e.source === s);

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch { return false; }
}

type Shown = { result: SimResult; repeat: "first" | "same" | "different" };

/**
 * reference: the language reference, shown on the Workshop's own page.
 * sealing: set on the seal page, which uses this same editor, engine and report to bring a strategy in. It leaves out the Workshop's introduction,
 * practice season and reference, and offers to carry the assembled strategy on. Both pages share the saved draft.
 */
export function Workshop({ reference, sealing }: { reference?: ReactNode; sealing?: { onUse: (source: string, assembly: Assembly) => void } }) {
  const [source, setSource] = useState<string>(EXAMPLES[0].source);
  const [loaded, setLoaded] = useState(false); // true once the saved draft, if any, is in the editor: nothing is saved before that
  const [saved, setSaved] = useState(true);
  const [backup, setBackup] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ state: "starting" });
  const [checked, setChecked] = useState<{ source: string; assembly: Assembly } | null>(null);
  const [inspection, setInspection] = useState<{ source: string; listing: string; readBack: string | null } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [shown, setShown] = useState<Shown | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const client = useRef<EngineClient | null>(null);
  const prints = useRef(new Map<string, string>());
  const editor = useRef<HTMLTextAreaElement>(null);
  const reportAt = useRef<HTMLDivElement>(null);
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    const engine = new EngineClient(setStatus);
    client.current = engine;
    engine.start();
    return () => { engine.stop(); client.current = null; };
  }, []);

  useEffect(() => {
    const draft = read(DRAFT);
    if (draft !== null) setSource(draft);
    setBackup(read(BACKUP));
    setLoaded(true);
  }, []);

  // the draft is kept shortly after typing stops, and at once if the page is being left
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => setSaved(write(DRAFT, source)), 300);
    return () => clearTimeout(timer);
  }, [source, loaded]);
  useEffect(() => {
    if (!loaded) return;
    const keep = () => { write(DRAFT, latest.current); };
    window.addEventListener("pagehide", keep);
    return () => { window.removeEventListener("pagehide", keep); keep(); };
  }, [loaded]);

  const ready = status.state === "ready";
  const restarts = status.state === "ready" ? status.restarts : 0;

  // assemble as the source changes
  useEffect(() => {
    if (!ready || !loaded) return;
    let current = true;
    const timer = setTimeout(() => {
      client.current?.assemble(source).then(assembly => { if (current) setChecked({ source, assembly }); })
        .catch((e: Error) => { if (current) setProblem(e.message); });
    }, 120);
    return () => { current = false; clearTimeout(timer); };
  }, [source, ready, restarts, loaded]);

  const assembly = checked?.assembly ?? null;
  const fresh = checked?.source === source;

  useEffect(() => {
    if (!inspecting || !ready || !fresh) return;
    let current = true;
    client.current?.inspect(source).then(r => { if (current) setInspection({ source, ...r }); }).catch((e: Error) => { if (current) setProblem(e.message); });
    return () => { current = false; };
  }, [inspecting, ready, fresh, source]);

  const run = useCallback(async () => {
    const engine = client.current;
    if (!engine || running || !ready) return;
    setRunning(true);
    setProblem(null);
    try {
      const a = await engine.assemble(latest.current); // always the text as it stands, not the last debounced copy
      setChecked({ source: latest.current, assembly: a });
      if (!a.ok || !a.bytecode || !a.code_sha256) { editor.current?.focus(); return; }
      const result = await engine.simulate(a.bytecode, RUN.worlds, RUN.episodes, RUN.base);
      const before = prints.current.get(a.code_sha256);
      prints.current.set(a.code_sha256, result.fingerprint);
      setShown({ result, repeat: before === undefined ? "first" : before === result.fingerprint ? "same" : "different" });
      requestAnimationFrame(() => reportAt.current?.scrollIntoView({ block: "start" }));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [running, ready]);

  const change = (value: string) => { setSource(value); setProblem(null); };

  const load = (id: string) => {
    const example = EXAMPLES.find(e => e.id === id);
    if (!example) return;
    // work of your own is set aside before an example replaces it
    if (source.trim() !== "" && !isExample(source)) { setBackup(source); write(BACKUP, source); }
    change(example.source);
  };
  const restore = () => {
    if (backup === null) return;
    const current = source;
    change(backup);
    if (current.trim() !== "" && !isExample(current)) { setBackup(current); write(BACKUP, current); }
    else { setBackup(null); write(BACKUP, null); }
  };

  const jump = (d: Diagnostic) => {
    const box = editor.current;
    if (!box) return;
    const lines = source.split("\n");
    const start = lines.slice(0, d.line - 1).reduce((n, l) => n + l.length + 1, 0);
    const at = start + Math.min(Math.max(d.col - 1, 0), lines[d.line - 1]?.length ?? 0);
    box.focus({ preventScroll: true });
    box.setSelectionRange(at, at);
    box.closest("div")?.querySelector(`[data-line="${d.line}"]`)?.scrollIntoView({ block: "center" });
  };

  const example = EXAMPLES.find(e => e.source === source);
  const aim = example ? /^note "(.*)"$/m.exec(example.source)?.[1] : undefined;
  const errors = fresh && assembly ? assembly.errors : [];
  const warnings = fresh && assembly ? assembly.warnings : [];
  const canRun = ready && !running && loaded && !(fresh && assembly && !assembly.ok);

  const diagnostics = (list: Diagnostic[], kind: "Error" | "Warning") => list.map((d, i) => (
    <li key={`${kind}-${d.line}-${d.col}-${i}`} className={kind === "Error" ? styles.isError : undefined}>
      <button type="button" onClick={() => jump(d)}>
        <strong>{kind}, line {d.line}, column {d.col}</strong>
        <span>{d.msg}</span>
      </button>
    </li>
  ));

  return (
    <>
      {!sealing && <StartHere isExample={isExample(source)} canRun={canRun} running={running} onRun={() => void run()} />}

      <p className={styles.engine} data-needs-script="" data-testid="engine" data-state={status.state} role="status">
        {status.state === "starting" && "Starting the engine..."}
        {status.state === "ready" && <>Engine ready. conclave-vm, ruleset {ENGINE.ruleset}<HelpTip term="ruleset" />, build <code title={status.sha256}>{status.sha256.slice(0, 8)}</code>, checked before it ran.{status.restarts > 0 && " It stopped and was started again."}</>}
        {status.state === "failed" && <>The engine is not running: {status.reason}. <button type="button" className="plain-button" onClick={() => client.current?.start()}>Try again</button></>}
      </p>

      <div className={styles.bench}>
        <section className={styles.desk} aria-label="Editor">
          <div className={styles.toolbar}>
            <label data-needs-script="">
              <span className="sr-only">Load an example</span>
              <select value="" onChange={e => load(e.target.value)} disabled={!loaded}>
                <option value="" disabled>Load an example</option>
                {EXAMPLES.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
            {sealing ? <a className="ruled" href="/workshop#reference" target="_blank" rel="noopener noreferrer">Language reference (new tab)</a> : <a className="ruled" href="#reference">Language reference</a>}
          </div>
          {backup !== null && backup !== source && (
            <p className={styles.backup} role="status">
              Your earlier draft was set aside. <button type="button" className="plain-button" onClick={restore}>Restore it</button>
            </p>
          )}
          <p className={styles.now} data-testid="now-editing">
            {example ? <>In the editor: the example <strong>{example.name}</strong>.{aim ? ` ${aim}` : ""}</> : <>In the editor: <strong>your own draft</strong>.</>}{" "}
            Each line is one step, and text after # is a comment.
          </p>
          <Editor ref={editor} value={source} errors={errors} warnings={warnings} readOnly={!loaded} onChange={change} onRun={() => void run()} />
          <p className={styles.saved} data-needs-script="">
            {!saved ? "This browser would not save the draft. Copy your work before leaving the page." : sealing ? "Your draft is saved in this browser's local storage, as plain text. It leaves this browser only if you seal it." : "Your draft is saved in this browser's local storage, as plain text. It is not sent anywhere."}
          </p>
        </section>

        <div className={styles.side} data-needs-script="">
          <CostMeter assembly={assembly} />
          <div className={styles.actions}>
            <button type="button" className={styles.run} onClick={() => void run()} disabled={!canRun}>{running ? "Running..." : "Run simulation"}</button>
            <p>48 worlds of 12 episodes. Ctrl or Command and Enter also runs.</p>
          </div>
          {problem && <p className={styles.problem} role="alert">{problem}</p>}
          {sealing ? (
            <div className={styles.actions}>
              <button type="button" className={styles.run} onClick={() => { if (fresh && assembly?.ok) sealing.onUse(source, assembly); }} disabled={!(fresh && assembly?.ok)}>Use this strategy</button>
              <p>Takes the strategy as it stands to the next step. Simulating it first is worth the second it takes.</p>
            </div>
          ) : fresh && assembly?.ok ? (
            <p className={styles.handoff}>
              {/* not fetched ahead of time: that would preload the seal page's stylesheet here */}
              <Link href="/seal" prefetch={false} className="ruled">Seal this strategy on devnet</Link>
              <span>No wallet and no SOL needed. It leaves this practice tool.</span>
            </p>
          ) : null}
          <div id="diagnostics" className={styles.diagnostics} aria-live="polite">
            {errors.length > 0 && <ul data-testid="errors">{diagnostics(errors, "Error")}</ul>}
            {warnings.length > 0 && <ul data-testid="asm-warnings">{diagnostics(warnings, "Warning")}</ul>}
            {fresh && assembly?.ok && <p className={styles.good}>Assembles: {assembly.bytecode!.length / 2} bytes of bytecode.</p>}
          </div>
          <details className={styles.inspect} onToggle={e => setInspecting(e.currentTarget.open)}>
            <summary>What the engine will run</summary>
            {inspection && inspection.source === source ? (
              <>
                <p>Cost, line by line:</p>
                <pre>{inspection.listing}</pre>
                {inspection.readBack && <><p>The bytecode read back as source:</p><pre>{inspection.readBack}</pre></>}
              </>
            ) : <p>Reading...</p>}
          </details>
        </div>
      </div>

      <div ref={reportAt} className={styles.results}>
        <p className="sr-only" role="status">{running ? "Running the simulation." : shown ? "The practice report is ready." : ""}</p>
        {shown && <Report result={shown.result} repeat={shown.repeat} stale={!fresh || assembly?.code_sha256 !== shown.result.report.code_sha256} />}
      </div>

      {!sealing && <section className={styles.block} data-needs-script="" aria-labelledby="practice-title">
        <header>
          <h2 id="practice-title">Practice season</h2>
          <p>Your strategy and the eight examples play one season together on markets drawn from a seed you choose, in the same loop the program runs. It is a practice seed, not a draw from the chain.</p>
        </header>
        <Practice engine={() => client.current} assembly={fresh ? assembly : null} ready={ready} />
      </section>}

      {reference}
    </>
  );
}
