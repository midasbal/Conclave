"use client";
// The seal page: bring a strategy in, save its claim ticket, seal it. The owner is a temporary key made here and kept only in this page's memory and in
// the file the visitor downloads. A connected wallet is shown and never asked to sign: this component takes only its address from the wallet.
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Keypair } from "@solana/web3.js";
import { BACKUP, DRAFT, Workshop } from "@/components/workshop/Workshop";
import type { Assembly } from "@/lib/engine/types";
import { codeCommitment, registryAddress } from "@/lib/seal/chain";
import { freshProgress, seal, SealError, STEPS, type Progress, type StepId, type StepReport } from "@/lib/seal/flow";
import { fromHex, keypairFileName, keypairText, parseTicket, sameClaim, ticketFileName, ticketText, toHex, type Claim, type Receipt } from "@/lib/seal/ticket";
import { explorerAddress, explorerTransaction } from "@/lib/links";
import styles from "./SealFlow.module.css";

const TITLES: Record<StepId, string> = {
  fund: "Fund the temporary key",
  register: "Register on Solana",
  delegate: "Hand the registry to the rollup",
  login: "Log in to the enclave",
  seal: "Seal the strategy",
  verify: "Read it back and check",
};

type Attempt = { claim: Claim; progress: Progress; resumed: "prepared" | "sealed" | null };
type Steps = Partial<Record<StepId, StepReport>>;
type Failure = { step: StepId; message: string; retryable: boolean };

const STAGES = ["Strategy", "Claim ticket", "Seal"] as const;

/** where the visitor is among the three stages. It only shows what the state below already says: it is not a control */
function Stages({ at }: { at: number }) {
  return (
    <ol className={styles.rail} aria-label="Stages">
      {STAGES.map((name, i) => (
        <li key={name} data-state={i < at ? "done" : i === at ? "current" : "ahead"} aria-current={i === at ? "step" : undefined}>
          {name}{i < at && <span className="sr-only">, done</span>}
        </li>
      ))}
    </ol>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** a button that opens the file chooser: the file is read here, in the page, and goes nowhere */
function ChooseFile({ label, disabled, onFile, testid }: { label: string; disabled?: boolean; onFile: (text: string) => void; testid: string }) {
  const change = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so that choosing the same file again is noticed
    if (!file) return;
    onFile(file.size > 200_000 ? "" : await file.text());
  };
  return (
    <label className={styles.choose} aria-disabled={disabled}>
      <input type="file" accept=".json,application/json" disabled={disabled} onChange={e => void change(e)} data-testid={testid} />
      <span>{label}</span>
    </label>
  );
}

export function SealFlow() {
  const { publicKey, wallet } = useWallet(); // the address and the wallet's name, for display. Nothing else of the wallet is taken
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [saved, setSaved] = useState(false);
  const [matched, setMatched] = useState<{ ok: boolean; message: string } | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [steps, setSteps] = useState<Steps>({});
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [completedSaved, setCompletedSaved] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [resumeProblem, setResumeProblem] = useState<string | null>(null);
  const [draftGone, setDraftGone] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const funded = attempt?.progress.funded ?? false;
  const ready = !!attempt && saved && !!matched?.ok && agreed;
  const started = Object.keys(steps).length > 0;

  // leaving would lose something that is only in this page: a run in flight, an unfinished funded one, or a finished ticket not yet saved
  useEffect(() => {
    if (!(running || (funded && !receipt) || (receipt && !completedSaved))) return;
    const hold = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [running, funded, receipt, completedSaved]);

  const reset = () => {
    setAttempt(null); setSaved(false); setMatched(null); setAgreed(false); setSteps({}); setFailure(null); setReceipt(null); setCompletedSaved(false); setDiscarding(false); setResumeProblem(null);
  };
  const toTop = () => requestAnimationFrame(() => top.current?.scrollIntoView({ block: "start" }));

  // the temporary key, the salt and the strategy number are made now, before anything is funded or sent, so that the ticket can be saved first
  const prepare = async (source: string, assembly: Assembly) => {
    if (!assembly.ok || !assembly.bytecode) return;
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const id = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
    const code = fromHex(assembly.bytecode);
    const claim: Claim = { createdAt: new Date().toISOString(), owner: Keypair.generate(), id, salt, code, commitment: await codeCommitment(salt, code), source, name: assembly.name, ruleset: assembly.ruleset };
    reset();
    setAttempt({ claim, progress: freshProgress(), resumed: null });
    toTop();
  };

  const resume = async (text: string) => {
    setResumeProblem(null);
    try {
      const opened = await parseTicket(text);
      const progress = freshProgress();
      if (opened.receipt) { progress.signatures = { ...progress.signatures, ...opened.receipt.transactions }; progress.funded = true; }
      reset();
      setAttempt({ claim: opened.claim, progress, resumed: opened.status });
      // choosing the file is the proof that a readable copy exists
      setSaved(true);
      setMatched({ ok: true, message: "Read from your saved ticket." });
      toTop();
    } catch (e) {
      setResumeProblem(e instanceof Error ? e.message : "The file could not be read.");
    }
  };

  const confirmSaved = async (text: string) => {
    if (!attempt) return;
    try {
      const opened = await parseTicket(text);
      setMatched(sameClaim(opened.claim, attempt.claim)
        ? { ok: true, message: "This is the ticket for this seal: its key, salt and code match what is in this page." }
        : { ok: false, message: "That is a claim ticket, but not the one for this seal. Choose the file you have just downloaded." });
    } catch (e) {
      setMatched({ ok: false, message: e instanceof Error ? e.message : "The file could not be read." });
    }
  };

  const run = async () => {
    if (!attempt || !ready || running) return;
    setRunning(true);
    setFailure(null);
    setSteps({});
    try {
      const result = await seal(attempt.claim, attempt.progress, (step, report) => setSteps(s => ({ ...s, [step]: report })));
      setReceipt(result);
    } catch (e) {
      setFailure(e instanceof SealError ? { step: e.step, message: e.message, retryable: e.retryable } : { step: "fund", message: e instanceof Error ? e.message : String(e), retryable: true });
    } finally {
      setRunning(false);
    }
  };

  const identity = (
    <p className={styles.identity} data-testid="identity">
      {publicKey ? <>Connected wallet: {wallet?.adapter.name} <code>{publicKey.toBase58()}</code>. Shown for identity only. It does not own what you seal here, and it is not asked to sign anything.</>
        : <>No wallet is needed. If you connect one, its address is shown here and nothing else changes: it signs nothing.</>}
    </p>
  );

  if (!attempt) {
    return (
      <div ref={top}>
        {identity}
        <Stages at={0} />
        <section key="write" className={styles.block} aria-labelledby="write-title">
          <h2 id="write-title">1. Bring in your strategy</h2>
          <p className={styles.read}>This is the Workshop&rsquo;s editor and engine, with the draft you left there. Simulate it as often as you like, then choose <strong>Use this strategy</strong>.</p>
          <Workshop sealing={{ onUse: (source, assembly) => void prepare(source, assembly) }} />
        </section>
        <section key="resume" className={styles.block} aria-labelledby="resume-title">
          <h2 id="resume-title">Continue from a claim ticket</h2>
          <p className={styles.read}>If a seal stopped part way, or you want to check a sealed strategy again, choose its claim ticket. It is read in this page and not uploaded. Nothing already done is done twice.</p>
          <ChooseFile label="Choose a claim ticket" onFile={t => void resume(t)} testid="resume-file" />
          {resumeProblem && <p className={styles.bad} role="alert">{resumeProblem}</p>}
        </section>
      </div>
    );
  }

  const { claim } = attempt;
  const sealedNow = receipt !== null;

  return (
    <div ref={top}>
      {identity}
      {/* on to the third stage once the gate is open, or a run has begun; all three are behind you once there is a receipt */}
      <Stages at={sealedNow ? STAGES.length : ready || started || running ? 2 : 1} />

      <section key="what" className={styles.block} aria-labelledby="what-title">
        <h2 id="what-title">The strategy</h2>
        <p className={styles.read}><strong>{claim.name ?? "Unnamed strategy"}</strong>. {(claim.code.length - 4) / 4} instructions, {claim.code.length} bytes. It is fixed now: the ticket holds exactly this code.</p>
        <details className={styles.source}>
          <summary>Show the source</summary>
          <pre>{claim.source}</pre>
        </details>
        {!sealedNow && !running && (discarding ? (
          <div className={styles.confirm} role="alertdialog" aria-label="Leave this attempt">
            <p>{funded
              ? "This key may hold devnet SOL, and may already have a registry or a sealed strategy. Leaving deletes nothing on chain: only your claim ticket can act as its owner afterwards. Keep it."
              : "Nothing has been funded or sent. Leaving discards this key, and any ticket you downloaded for it will control nothing."}</p>
            <button type="button" className="plain-button" onClick={() => { reset(); toTop(); }}>Leave this attempt</button>
            <button type="button" className="plain-button" onClick={() => setDiscarding(false)}>Stay</button>
          </div>
        ) : <button type="button" className={`plain-button ${styles.small}`} onClick={() => setDiscarding(true)}>Change the strategy or start over</button>)}
      </section>

      {!sealedNow && (
        <section key="ticket" className={styles.block} aria-labelledby="ticket-title">
          <h2 id="ticket-title">2. Save your claim ticket</h2>
          <div className={styles.stern}>
            <p><strong>This file is the only proof of ownership, and the only copy of the salt and code. We never store it. If you lose it, you lose the strategy.</strong></p>
            <p>It contains a secret key. Anyone who has the file owns the strategy and can read its code. Keep it private, and do not put it in a code repository or send it to anyone.</p>
          </div>
          {attempt.resumed && <p className={styles.read} role="status">{attempt.resumed === "sealed" ? "This ticket says its strategy is sealed. Running checks it on devnet again." : "This ticket is from an unfinished seal. Running carries on from wherever it stopped."}</p>}

          <ol className={styles.todo}>
            <li data-done={saved}>
              <h3>Download it</h3>
              <button type="button" className={styles.go} onClick={() => { download(ticketFileName(claim, false), ticketText(claim)); setSaved(true); }} disabled={running}>
                {saved ? "Download the claim ticket again" : "Download the claim ticket"}
              </button>
              <p className={styles.mono}>{ticketFileName(claim, false)}</p>
            </li>
            <li data-done={!!matched?.ok}>
              <h3>Select the file you just saved</h3>
              <p>The page reads it from your disk and checks that it matches. This shows you have a copy that can be read. Nothing is uploaded.</p>
              <ChooseFile label="Select the saved ticket" disabled={!saved || running} onFile={t => void confirmSaved(t)} testid="verify-file" />
              {matched && <p className={matched.ok ? styles.good : styles.bad} role={matched.ok ? "status" : "alert"} data-testid="matched">{matched.message}</p>}
            </li>
            <li data-done={agreed}>
              <h3>Acknowledge</h3>
              <label className={styles.agree}>
                <input type="checkbox" checked={agreed} disabled={!saved || running} onChange={e => setAgreed(e.target.checked)} />
                <span>I have saved the claim ticket somewhere safe. I understand that it is the only proof of ownership and the only copy of the salt and code, that Conclave never stores it, and that losing it loses the strategy.</span>
              </label>
            </li>
          </ol>
          <p className={styles.read}>
            Optional, for the command line: <button type="button" className={`plain-button ${styles.small}`} onClick={() => download(keypairFileName(claim), keypairText(claim.owner))} disabled={!saved || running}>Export a Solana keypair file</button>{" "}
            It is the same secret key in the standard format. It holds neither the salt nor the code, so it does not replace the ticket.
          </p>
        </section>
      )}

      <section key="seal" className={styles.block} aria-labelledby="seal-title">
        <h2 id="seal-title">{sealedNow ? "Sealed" : "3. Seal it"}</h2>
        {!sealedNow && (
          <>
            <p className={styles.read}>
              The temporary key signs every step in this page. No wallet is asked. We send it 0.01 devnet SOL: sealing uses about 0.0063 of it, and the rest stays in the key, which your ticket controls.
            </p>
            <p className={styles.mono}>Temporary key: {claim.owner.publicKey.toBase58()}</p>
          </>
        )}
        {(started || running) && (
          <ol className={styles.steps}>
            {STEPS.map(id => {
              const r = steps[id];
              const state = failure?.step === id ? "failed" : r?.state ?? "waiting";
              return (
                <li key={id} data-step={id} data-state={state}>
                  <span className={styles.badge}>{state === "waiting" ? "Waiting" : state === "working" ? "Working" : state === "done" ? "Done" : "Stopped"}</span>
                  <div>
                    <strong>{TITLES[id]}</strong>
                    {r && <p>{r.detail}</p>}
                    {r?.signature && (id === "seal" ? <p className={styles.mono}>Rollup signature {r.signature}</p> : <p><a href={explorerTransaction(r.signature)} target="_blank" rel="noopener noreferrer">Transaction on the explorer</a></p>)}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className="sr-only" role="status">{running ? "Sealing." : sealedNow ? "The strategy is sealed and all six checks pass." : ""}</p>

        {failure && !running && (
          <div className={styles.failure} role="alert" data-testid="failure">
            <p><strong>{TITLES[failure.step]}: {failure.message}</strong></p>
            {funded
              ? <p><strong>Your temporary key already holds the funds.</strong> Nothing is lost: the key is in the claim ticket you saved. Try again here and the run carries on from where it stopped. If you close this page, come back and choose your ticket under &ldquo;Continue from a claim ticket&rdquo;.</p>
              : <p>Your claim ticket is still valid and the key has not changed. Trying again first checks what the key holds, so it is not paid twice.</p>}
            {!failure.retryable && <p>The same request is likely to be refused again for now. Keep your ticket and come back later.</p>}
          </div>
        )}

        {!sealedNow && (
          <>
            <button type="button" className={styles.seal} onClick={() => void run()} disabled={!ready || running} data-testid="seal-button">
              {running ? "Sealing..." : failure ? "Try again" : "Seal this strategy"}
            </button>
            {!ready && <p className={styles.read}>Seal is off until the ticket is downloaded, the saved file is selected and matches, and you have ticked the acknowledgement.</p>}
          </>
        )}
      </section>

      {receipt && (
        <>
          <section className={styles.receipt} aria-labelledby="receipt-title" data-testid="receipt">
            <header><h2 id="receipt-title">Seal receipt</h2><p>Solana devnet</p></header>
            <ul className={styles.checks}>{receipt.checks.map(c => <li key={c.name} data-ok={c.ok}><span>{c.ok ? "Pass" : "Fail"}</span>{c.name}</li>)}</ul>
            <dl>
              <div><dt>Sealed at</dt><dd>{receipt.sealedAt}</dd></div>
              <div><dt>Strategy number</dt><dd>{claim.id.toString()}</dd></div>
              <div><dt>Owner</dt><dd>{claim.owner.publicKey.toBase58()}</dd></div>
              <div><dt>Public commitment</dt><dd>{toHex(claim.commitment)}</dd></div>
              <div><dt>Registry</dt><dd><a href={explorerAddress(registryAddress(claim.id).toBase58())} target="_blank" rel="noopener noreferrer">{receipt.registry}</a></dd></div>
              <div><dt>Sealed account</dt><dd>{receipt.sealedAccount}</dd></div>
              <div><dt>Rollup validator</dt><dd>{receipt.validator}</dd></div>
              {([["Funding", receipt.transactions.funding], ["Register", receipt.transactions.register], ["Delegate", receipt.transactions.delegate]] as const).map(([label, s]) => (
                <div key={label}><dt>{label}</dt><dd>{s ? <a href={explorerTransaction(s)} target="_blank" rel="noopener noreferrer">{s}</a> : "done in an earlier run, signature not kept"}</dd></div>
              ))}
              <div><dt>Seal, in the rollup</dt><dd>{receipt.transactions.seal ?? "done in an earlier run, signature not kept"}</dd></div>
            </dl>
          </section>
          <section className={styles.block} aria-labelledby="keep-title">
            <h2 id="keep-title">Keep the completed ticket</h2>
            <p className={styles.read}>It holds what the first ticket held, and now the receipt. <strong>It is still the only proof of ownership and the only copy of the salt and code. We never store it.</strong></p>
            <button type="button" className={styles.go} onClick={() => { download(ticketFileName(claim, true), ticketText(claim, receipt)); setCompletedSaved(true); }}>Download the completed claim ticket</button>
            <p className={styles.mono}>{ticketFileName(claim, true)}</p>
            <p><button type="button" className={`plain-button ${styles.small}`} onClick={() => download(keypairFileName(claim), keypairText(claim.owner))}>Export a Solana keypair file</button></p>
            <p className={styles.read}>
              {draftGone ? "The draft has been deleted from this browser." : <>The draft you wrote is still saved in this browser&rsquo;s local storage, in plain text.{" "}
                <button type="button" className={`plain-button ${styles.small}`} onClick={() => { try { window.localStorage.removeItem(DRAFT); window.localStorage.removeItem(BACKUP); setDraftGone(true); } catch { /* storage is unavailable */ } }}>Delete the draft from this browser</button></>}
            </p>
            <p className={styles.read}>Sealing does not enter a competition. This app cannot enter a season yet, and it never closes a strategy: closing would publish the code and salt for good.</p>
            <button type="button" className="plain-button" onClick={() => { reset(); setDraftGone(false); toTop(); }}>Seal another strategy</button>
          </section>
        </>
      )}
    </div>
  );
}
