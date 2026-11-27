"use client";
// One Connect action. It opens a short menu of the wallets this browser actually announces; nothing is contacted before one is chosen.
// The wallet gates nothing: every page of the record is read without it. It is here for authoring and campaigning, which are not built yet.
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import styles from "./WalletMenu.module.css";

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

export function WalletMenu() {
  const { wallets, wallet, publicKey, connected, connecting, select, connect, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState<WalletName | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const found = wallets.filter(w => w.readyState === WalletReadyState.Installed);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }, []);

  // Choose first, connect once the provider holds that wallet: it starts listening to a wallet only after it has been selected,
  // so connecting in the same breath could finish before anyone is listening.
  useEffect(() => {
    if (!asked || wallet?.adapter.name !== asked) return;
    setAsked(null);
    connect().then(() => close(true), () => setProblem(`${asked} did not connect. Nothing was signed or sent.`));
  }, [asked, wallet, connect, close]);

  // opening moves focus into the menu; a press anywhere else closes it
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLElement>("[data-item]") ?? panel.current)?.focus();
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) close(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, connected, close]);

  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])];
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  return (
    <div ref={root} className={styles.root} onKeyDown={keys}
      onBlur={e => { if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) close(false); }}>
      <button ref={trigger} type="button" className={styles.trigger} aria-expanded={open} aria-controls={open ? panelId : undefined}
        onClick={() => { setProblem(null); setOpen(o => !o); }}>
        {connected && publicKey ? <span className={styles.mono}>{short(publicKey.toBase58())}</span> : "Connect wallet"}
        <svg className={styles.caret} viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>

      {open && (
        <div ref={panel} id={panelId} className={styles.panel} role="group" aria-label="Wallet" tabIndex={-1}>
          {connected && publicKey ? (
            <>
              <p className={styles.who}>{wallet?.adapter.name}<span className={styles.mono}>{publicKey.toBase58()}</span></p>
              <button type="button" data-item="" className={styles.item} onClick={() => { void disconnect(); close(true); }}>Disconnect</button>
            </>
          ) : found.length > 0 ? (
            <ul>
              {found.map(w => (
                <li key={w.adapter.name}>
                  <button type="button" data-item="" className={styles.item} disabled={connecting}
                    onClick={() => { setProblem(null); setAsked(w.adapter.name); select(w.adapter.name); }}>
                    {/* the wallet's own icon, as it announces it (a data URI) */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.adapter.icon} alt="" width="22" height="22" />
                    {w.adapter.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.none}>No Solana wallet was found in this browser.</p>
          )}
          <p className={styles.note}>Optional. Connecting shares your address with this page. It signs nothing and sends nothing.</p>
          <p role="status" className={styles.problem}>{problem}</p>
        </div>
      )}
    </div>
  );
}
