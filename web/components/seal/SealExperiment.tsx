"use client";
// An experiment: can a browser wallet sign what sealing needs? One step to a button, so that each wallet prompt can be watched on its own. After each
// signature the page says what came back. The enclave token lives only in memory: it is never shown, logged, stored or put in an address.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { getAuthToken, permissionPdaFromAccount, EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { HelpTip } from "@/components/workshop/HelpTip";
import { SEAL_HELP } from "@/lib/seal/help";
import { TEST_STRATEGY } from "@/lib/seal/test-strategy";
import {
  ROLLUP_BLOCKHASH_SECONDS, TEE_RPC, DELEGATION_PROGRAM, codeCommitment, compareReturned, computeLimit, delegateInstruction, parseSealed,
  registerInstruction, registryAddress, sealInstruction, sealedAddress, transactionOf, u64,
} from "@/lib/seal/chain";
import { explorerAddress, explorerTransaction } from "@/lib/links";
import styles from "./SealExperiment.module.css";

type StepId = "register" | "delegate" | "login" | "seal" | "read";
type State = { status: "waiting" | "working" | "done" | "failed"; result?: string[]; signature?: string };
const ORDER: StepId[] = ["register", "delegate", "login", "seal", "read"];
const NEEDED_LAMPORTS = 8_000_000;
const FRESH: Record<StepId, State> = { register: { status: "waiting" }, delegate: { status: "waiting" }, login: { status: "waiting" }, seal: { status: "waiting" }, read: { status: "waiting" } };

type Attempt = { id: bigint; salt: Uint8Array; commitment: Uint8Array; code: Uint8Array; owner: PublicKey };

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const sol = (lamports: number) => `${(lamports / 1e9).toFixed(6)} SOL (${lamports.toLocaleString("en-US")} lamports)`;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const words = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** one JSON-RPC call to the rollup. The token travels in a header, never in the address */
async function rollup<T>(method: string, params: unknown[] = [], token?: string): Promise<T> {
  const response = await fetch(TEE_RPC, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error !== undefined) throw new Error(`rollup ${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}
type Info = { value: { lamports: number; data: [string, string] } | null };
async function rollupAccount(address: PublicKey, token?: string) {
  const r = await rollup<Info>("getAccountInfo", [address.toBase58(), { encoding: "base64" }], token);
  return r.value ? { lamports: r.value.lamports, data: new Uint8Array(Buffer.from(r.value.data[0], "base64")) } : null;
}

export function SealExperiment() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, signMessage, wallet, connected } = useWallet();
  const [agreed, setAgreed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [steps, setSteps] = useState(FRESH);
  const [balance, setBalance] = useState<number | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const token = useRef<string | null>(null);
  const started = useRef(Date.now());
  const busy = ORDER.some(s => steps[s].status === "working");

  const note = useCallback((line: string) => setLog(l => [...l, `+${((Date.now() - started.current) / 1000).toFixed(1)}s ${line}`]), []);
  const refresh = useCallback(async () => {
    if (!publicKey) { setBalance(null); return; }
    try { setBalance(await connection.getBalance(publicKey, "confirmed")); } catch { setBalance(null); }
  }, [connection, publicKey]);
  useEffect(() => { void refresh(); }, [refresh]);

  // a different wallet is a different owner: nothing carries over
  const address = publicKey?.toBase58() ?? null;
  useEffect(() => {
    token.current = null;
    setAttempt(a => (a && a.owner.toBase58() !== address ? null : a));
    setSteps(FRESH);
  }, [address]);

  const prepare = async () => {
    if (!publicKey) return;
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const id = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
    const code = new Uint8Array(Buffer.from(TEST_STRATEGY.bytecode, "hex"));
    const commitment = await codeCommitment(salt, code);
    token.current = null;
    started.current = Date.now();
    setSteps(FRESH);
    setCopied(false);
    setAttempt({ id, salt, code, commitment, owner: publicKey });
    setLog([]);
    note(`Conclave seal experiment, devnet, ${new Date().toISOString()}`);
    note(`wallet: ${wallet?.adapter.name ?? "unknown"} | offers signTransaction: ${!!signTransaction} | offers signMessage: ${!!signMessage}`);
    note(`owner ${publicKey.toBase58()} | strategy ${id} | registry ${registryAddress(id).toBase58()}`);
    note(`THROWAWAY test strategy, bytecode ${TEST_STRATEGY.bytecode}`);
    note(`THROWAWAY salt ${hex(salt)} | commitment ${hex(commitment)}`);
  };

  /** hands a transaction to the wallet, and says what came back */
  const sign = async (label: string, build: () => Transaction, countdownSeconds?: number) => {
    if (!signTransaction) throw new Error("this wallet does not offer signTransaction, so it cannot sign for an app that sends the transaction itself");
    const asked = build();
    note(`${label}: asking the wallet to sign (instructions: ${asked.instructions.length}, size ${asked.serialize({ requireAllSignatures: false, verifySignatures: false }).length} bytes)`);
    const t0 = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (countdownSeconds) {
      setCountdown(countdownSeconds);
      timer = setInterval(() => setCountdown(Math.max(0, countdownSeconds - Math.round((Date.now() - t0) / 1000))), 500);
    }
    let got: Transaction;
    try {
      got = await signTransaction(build()); // a second copy: a wallet may change the object it is given
    } finally {
      if (timer) clearInterval(timer);
      setCountdown(null);
    }
    const seconds = (Date.now() - t0) / 1000;
    const back = compareReturned(asked, got);
    note(`${label}: wallet signed after ${seconds.toFixed(1)}s | ${back.changes.length ? "CHANGED: " + back.changes.join("; ") : "returned exactly what was asked, signed"}`);
    if (!back.sendable) throw new Error(`not sent. The wallet returned something else: ${back.changes.join("; ")}`);
    return { got, back, seconds };
  };

  const sendBase = async (label: string, tx: Transaction, lastValidBlockHeight: number) => {
    const signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    note(`${label}: sent to Solana devnet, signature ${signature}`);
    const result = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight }, "confirmed");
    if (result.value.err) throw new Error(`${label} failed on chain: ${JSON.stringify(result.value.err)}`);
    return signature;
  };

  const baseStep = async (label: string, make: (a: Attempt) => Promise<Transaction["instructions"][number]>) => {
    const a = attempt!;
    const ix = await make(a);
    const before = await connection.getBalance(a.owner, "confirmed");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const { got, back } = await sign(label, () => transactionOf(a.owner, blockhash, ix));
    const signature = await sendBase(label, got, lastValidBlockHeight);
    const cost = before - (await connection.getBalance(a.owner, "confirmed"));
    note(`${label}: confirmed | cost to the wallet ${sol(cost)}`);
    return { signature, result: [back.changes.length ? `The wallet changed the transaction: ${back.changes.join("; ")}.` : "The wallet returned the transaction unchanged.", `Cost to your wallet: ${sol(cost)}.`] };
  };

  const actions: Record<StepId, () => Promise<Omit<State, "status">>> = {
    register: async () => {
      const a = attempt!;
      const existing = await connection.getAccountInfo(registryAddress(a.id), "confirmed");
      if (existing) { note("Register: the registry is already there"); return { result: ["Already done: the registry is on chain."] }; }
      return baseStep("Register", async x => registerInstruction(x.owner, x.id, x.commitment));
    },
    delegate: async () => {
      const a = attempt!;
      const existing = await connection.getAccountInfo(registryAddress(a.id), "confirmed");
      if (existing?.owner.equals(DELEGATION_PROGRAM)) { note("Delegate: the registry is already delegated"); return { result: ["Already done: the registry is delegated."] }; }
      const { identity } = await rollup<{ identity: string }>("getIdentity");
      note(`Delegate: the rollup's validator identity is ${identity}`);
      return baseStep("Delegate", async x => delegateInstruction(x.owner, x.id, new PublicKey(identity)));
    },
    login: async () => {
      if (!signMessage) throw new Error("this wallet does not offer signMessage, which the enclave login needs");
      const a = attempt!;
      let shown = "";
      const t0 = Date.now();
      note("Login: asking the wallet to sign the enclave's text");
      const session = await getAuthToken(TEE_RPC, a.owner, async message => {
        shown = new TextDecoder().decode(message);
        note(`Login: text to sign, ${message.length} bytes: ${JSON.stringify(shown)}`);
        return signMessage(message);
      });
      token.current = session.token;
      note(`Login: the enclave accepted the signature after ${((Date.now() - t0) / 1000).toFixed(1)}s (token kept in memory only, not logged)`);
      return { result: ["The enclave accepted your signature.", `The text you signed: “${shown}”`] };
    },
    seal: async () => {
      const a = attempt!;
      const t = token.current;
      if (!t) throw new Error("log in to the enclave first");
      if (await rollupAccount(sealedAddress(a.id), t)) { note("Seal: the sealed account is already there"); return { result: ["Already done: the strategy is sealed."] }; }
      // wait for the rollup to hold the delegated registry before asking for a signature, so that the blockhash is fresh when the wallet opens
      let registry = await rollupAccount(registryAddress(a.id), t);
      for (let i = 0; !registry && i < 60; i++) { await wait(1000); registry = await rollupAccount(registryAddress(a.id), t); }
      if (!registry) throw new Error("the rollup does not show the delegated registry yet; try again shortly");
      const sealedAt = sealedAddress(a.id);
      const addresses = { permission: permissionPdaFromAccount(sealedAt), vault: EPHEMERAL_VAULT_ID, permissionProgram: PERMISSION_PROGRAM_ID };
      const { value } = await rollup<{ value: { blockhash: string } }>("getLatestBlockhash", [], t);
      const asked = Date.now();
      const { got, back, seconds } = await sign("Seal", () => transactionOf(a.owner, value.blockhash, computeLimit(), sealInstruction(a.owner, a.id, a.salt, a.code, addresses)), ROLLUP_BLOCKHASH_SECONDS);
      const signature = await rollup<string>("sendTransaction", [got.serialize().toString("base64"), { encoding: "base64", skipPreflight: true }], t);
      note(`Seal: sent to the rollup ${((Date.now() - asked) / 1000).toFixed(1)}s after its blockhash was taken, signature ${signature}`);
      type Statuses = { value: ({ confirmationStatus?: string; err: unknown } | null)[] };
      for (let i = 0; i < 100; i++) {
        const status = (await rollup<Statuses>("getSignatureStatuses", [[signature]], t)).value[0];
        if (status?.confirmationStatus) {
          if (status.err) throw new Error(`the rollup ran the Seal and it failed: ${JSON.stringify(status.err)}`);
          const after = await rollupAccount(registryAddress(a.id), t);
          const rent = after ? registry.lamports - after.lamports : null;
          note(`Seal: confirmed in the rollup | the registry paid ${rent === null ? "an unread amount" : sol(rent)}`);
          return { signature: undefined, result: [back.changes.length ? `The wallet changed the transaction: ${back.changes.join("; ")}.` : "The wallet returned the transaction unchanged.", `You signed after ${seconds.toFixed(1)} s. Rollup signature: ${signature}`, rent === null ? "" : `Paid by the registry, not your wallet: ${sol(rent)}.`].filter(Boolean) };
        }
        await wait(150);
      }
      const valid = (await rollup<{ value: boolean }>("isBlockhashValid", [value.blockhash, {}], t)).value;
      throw new Error(valid ? "the rollup has not reported a status for the Seal yet" : `the Seal was not accepted, and its blockhash has expired. A rollup blockhash lasts under a minute: sign sooner, and try this step again`);
    },
    read: async () => {
      const a = attempt!;
      const t = token.current;
      if (!t) throw new Error("log in to the enclave first");
      const own = await rollupAccount(sealedAddress(a.id), t);
      if (!own) throw new Error("the sealed account was not returned to its owner");
      const s = parseSealed(own.data);
      const checks: [string, boolean][] = [
        ["owner is your wallet", s.owner.equals(a.owner)],
        ["strategy number matches", s.id === a.id],
        ["commitment matches", hex(s.commitment) === hex(a.commitment)],
        ["salt reads back exactly", hex(s.salt) === hex(a.salt)],
        ["code reads back exactly", hex(s.code) === hex(a.code)],
      ];
      const anonymous = await rollupAccount(sealedAddress(a.id)).then(v => v === null).catch(() => true);
      checks.push(["a request with no login is not shown the account", anonymous]);
      for (const [name, ok] of checks) note(`Read back: ${ok ? "ok" : "FAILED"}: ${name}`);
      if (checks.some(c => !c[1])) throw new Error("the read-back did not match: " + checks.filter(c => !c[1]).map(c => c[0]).join("; "));
      return { result: checks.map(([name]) => `Confirmed: ${name}.`) };
    },
  };

  const run = async (step: StepId) => {
    setSteps(s => ({ ...s, [step]: { status: "working" } }));
    try {
      const done = await actions[step]();
      setSteps(s => ({ ...s, [step]: { status: "done", ...done } }));
    } catch (e) {
      note(`${step}: FAILED | ${words(e)}`);
      setSteps(s => ({ ...s, [step]: { status: "failed", result: [words(e)] } }));
    }
    void refresh();
  };

  // what to look for in the wallet's preview of the Seal
  const sealData = useMemo(() => (attempt ? Buffer.concat([Buffer.from([3]), Buffer.from(u64(attempt.id)), Buffer.from(attempt.salt), Buffer.from(attempt.code)]) : null), [attempt]);
  const next = ORDER.find(s => steps[s].status !== "done");
  const enough = balance !== null && balance >= NEEDED_LAMPORTS;
  const registered = steps.register.status === "done";

  const copy = async () => {
    try { await navigator.clipboard.writeText(log.join("\n")); setCopied(true); } catch { setCopied(false); }
  };

  const STEPS: { id: StepId; title: React.ReactNode; what: string; cost: React.ReactNode; wallet: string; button: string }[] = [
    { id: "register", title: <>Register<HelpTip {...SEAL_HELP.registry} /></>, what: "Creates the public registry on Solana devnet, holding the commitment.", cost: <>About 0.0033 SOL, held in the registry, plus the network fee.</>, wallet: "A devnet transaction to sign.", button: "Sign Register" },
    { id: "delegate", title: <>Delegate<HelpTip {...SEAL_HELP.delegate} /></>, what: "Hands the registry to the private rollup.", cost: <>About 0.003 SOL plus the network fee.</>, wallet: "A second devnet transaction to sign.", button: "Sign Delegate" },
    { id: "login", title: <>Log in to the enclave<HelpTip {...SEAL_HELP.login} /></>, what: "Signs the rollup's login text. No transaction is made.", cost: "Free.", wallet: "A message to sign, as readable text.", button: "Sign the login message" },
    { id: "seal", title: <>Seal<HelpTip {...SEAL_HELP.seal} /></>, what: "Sends the code and salt into the private rollup. This is the step under test.", cost: <>No fee to your wallet in the project&rsquo;s runs. The registry pays 20,000 lamports<HelpTip {...SEAL_HELP.lamports} /> of rent.</>, wallet: `A transaction for the rollup, which your wallet's own network does not know. You have about ${ROLLUP_BLOCKHASH_SECONDS} seconds to approve it.`, button: "Sign the Seal" },
    { id: "read", title: "Read it back", what: "Reads the sealed account with your login and compares it with what was sent. Also asks with no login.", cost: "Free.", wallet: "Nothing: your wallet is not asked.", button: "Read the sealed strategy" },
  ];

  return (
    <>
      <section className={styles.block} aria-labelledby="before-title">
        <h2 id="before-title">Before you start</h2>
        <ul className={styles.list}>
          <li>Use a wallet kept only for testing, set to <strong>devnet</strong><HelpTip {...SEAL_HELP.devnet} />, holding at least 0.008 SOL from a devnet faucet.</li>
          <li>The whole attempt spends about 0.0063 SOL. This page never closes a strategy, so none of it comes back.</li>
          <li>Keep this page open until the end. The salt<HelpTip {...SEAL_HELP.salt} /> is not saved anywhere.</li>
        </ul>
        <label className={styles.agree}>
          <input type="checkbox" checked={agreed} disabled={busy} onChange={e => setAgreed(e.target.checked)} />
          <span>I mark the strategy shown below as <strong>throwaway</strong>, for this test only, and I am using a devnet test wallet.</span>
        </label>
        <div className={styles.status} data-testid="wallet-status">
          {!connected || !publicKey ? <p>No wallet connected. Use <strong>Connect wallet</strong> at the top of the page.</p> : (
            <dl>
              <div><dt>Wallet</dt><dd>{wallet?.adapter.name} <code>{publicKey.toBase58()}</code></dd></div>
              <div><dt>Signs transactions</dt><dd>{signTransaction ? "offered" : "NOT offered: the experiment cannot continue with this wallet"}</dd></div>
              <div><dt>Signs messages</dt><dd>{signMessage ? "offered" : "NOT offered: the enclave login cannot be done with this wallet"}</dd></div>
              <div><dt>Devnet balance</dt><dd>{balance === null ? "not read" : sol(balance)} {balance !== null && !enough && !registered && "(not enough: get devnet SOL from faucet.solana.com)"} <button type="button" className="plain-button" onClick={() => void refresh()}>Refresh</button></dd></div>
            </dl>
          )}
        </div>
      </section>

      <section className={styles.block} aria-labelledby="what-title">
        <h2 id="what-title">What will be sealed</h2>
        <p className={styles.read}>Only this built-in strategy. It does nothing useful and is public on this page. Nothing from your Workshop is read, and there is no way to put your own strategy here.</p>
        <pre className={styles.code}>{TEST_STRATEGY.source}</pre>
        <button type="button" className={styles.go} onClick={() => void prepare()} disabled={!agreed || !publicKey || !signTransaction || !signMessage || !enough || busy}>
          {attempt ? "Start a new test (a new salt, and the costs again)" : "Prepare the test"}
        </button>
        {attempt && sealData && (
          <div className={styles.look} data-testid="look-for">
            <h3>Look for these when your wallet asks you to sign the Seal</h3>
            <p className={styles.read}>If the wallet or its preview shows any of them, it has the strategy in readable form. These are throwaway values.</p>
            <dl>
              <div><dt>Salt, hex<HelpTip {...SEAL_HELP.salt} /></dt><dd><code>{hex(attempt.salt)}</code></dd></div>
              <div><dt>Code, hex</dt><dd><code>{TEST_STRATEGY.bytecode}</code></dd></div>
              <div><dt>Whole instruction data, base58</dt><dd><code data-testid="seal-b58">{bs58.encode(sealData)}</code></dd></div>
              <div><dt>The same, base64</dt><dd><code>{sealData.toString("base64")}</code></dd></div>
              <div><dt>The same, hex</dt><dd><code>{sealData.toString("hex")}</code></dd></div>
              <div><dt>Public commitment<HelpTip {...SEAL_HELP.commitment} /></dt><dd><code>{hex(attempt.commitment)}</code></dd></div>
              <div><dt>Registry</dt><dd><a href={explorerAddress(registryAddress(attempt.id).toBase58())} target="_blank" rel="noopener noreferrer"><code>{registryAddress(attempt.id).toBase58()}</code></a></dd></div>
            </dl>
          </div>
        )}
      </section>

      <section className={styles.block} aria-labelledby="steps-title">
        <h2 id="steps-title">Five steps, one at a time</h2>
        <ol className={styles.steps}>
          {STEPS.map(s => {
            const st = steps[s.id];
            const isNext = next === s.id;
            return (
              <li key={s.id} data-step={s.id} data-status={st.status} className={isNext && attempt ? styles.next : undefined}>
                <div className={styles.stepHead}>
                  <h3>{s.title}</h3>
                  <span className={styles.badge}>{st.status === "waiting" ? "Not done" : st.status === "working" ? "Working" : st.status === "done" ? "Done" : "Failed"}</span>
                </div>
                <p>{s.what}</p>
                <dl className={styles.facts}>
                  <div><dt>Cost</dt><dd>{s.cost}</dd></div>
                  <div><dt>Your wallet should show</dt><dd>{s.wallet}</dd></div>
                </dl>
                {s.id === "seal" && countdown !== null && <p className={styles.countdown} role="timer">Waiting for your wallet. About {countdown} s left before the rollup&rsquo;s blockhash expires.</p>}
                {st.result && <ul className={styles.result} role={st.status === "failed" ? "alert" : "status"}>{st.result.map(r => <li key={r}>{r}</li>)}</ul>}
                {st.signature && <p className={styles.link}><a href={explorerTransaction(st.signature)} target="_blank" rel="noopener noreferrer">See the transaction on the explorer</a></p>}
                {attempt && isNext && (
                  <button type="button" className={styles.go} onClick={() => void run(s.id)} disabled={busy || !agreed || !connected}>
                    {st.status === "working" ? "Working..." : st.status === "failed" ? "Try this step again" : s.button}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        {steps.read.status === "done" && <p className={styles.finish} role="status"><strong>All five steps worked with this wallet.</strong> That shows it can sign them. It does not show what the wallet did with the strategy it was given.</p>}
      </section>

      <section className={styles.block} aria-labelledby="log-title">
        <h2 id="log-title">Test log</h2>
        <p className={styles.read}>Everything the page saw, to copy into your report. It contains the throwaway salt and your wallet&rsquo;s address, and never the enclave token.</p>
        <pre className={styles.code} data-testid="log">{log.length ? log.join("\n") : "Nothing yet."}</pre>
        <button type="button" className="plain-button" onClick={() => void copy()} disabled={!log.length}>{copied ? "Copied" : "Copy the log"}</button>
      </section>
    </>
  );
}
