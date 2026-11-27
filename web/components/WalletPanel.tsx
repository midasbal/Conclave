"use client";
// Optional, and written to say exactly what pressing it does. Only wallets the browser actually announces are offered.
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { useEffect, useState } from "react";
import styles from "./WalletPanel.module.css";

export function WalletPanel() {
  const { wallets, wallet, publicKey, connected, connecting, select, connect, disconnect } = useWallet();
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState<WalletName | null>(null);
  const found = wallets.filter(w => w.readyState === WalletReadyState.Installed);

  // Choose first, connect once the provider holds that wallet: it starts listening to a wallet only after it has been selected,
  // so connecting in the same breath could finish before anyone is listening.
  useEffect(() => {
    if (!asked || wallet?.adapter.name !== asked) return;
    setAsked(null);
    connect().catch(() => setProblem(`${asked} did not connect. Nothing was signed or sent.`));
  }, [asked, wallet, connect]);

  function choose(name: WalletName) {
    setProblem(null);
    setAsked(name);
    select(name);
  }

  return (
    <section className={styles.panel} aria-labelledby="wallet-title">
      <h2 id="wallet-title">Wallet, optional</h2>
      <p>You will need one to author or enter a strategy. Connecting shares your address with this page. It signs nothing and sends nothing.</p>
      {connected && publicKey ? (
        <div className={styles.row}>
          <p className={styles.address}><span>{wallet?.adapter.name}</span> {publicKey.toBase58()}</p>
          <button type="button" onClick={() => void disconnect()}>Disconnect</button>
        </div>
      ) : found.length > 0 ? (
        <ul className={styles.row}>
          {found.map(w => (
            <li key={w.adapter.name}>
              <button type="button" disabled={connecting} onClick={() => choose(w.adapter.name)}>Connect {w.adapter.name}</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.none}>No Solana wallet was found in this browser.</p>
      )}
      <p role="status" className={styles.problem}>{problem}</p>
    </section>
  );
}
