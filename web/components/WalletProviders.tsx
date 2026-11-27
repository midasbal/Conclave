"use client";
// The wallet is wired at the root so any later page can use it. Nothing here asks for one: autoConnect is off, no page is gated,
// and no wallet is contacted until a visitor presses a connect button. Wallets that follow the Wallet Standard register themselves,
// so none is listed by name. The endpoint is the public devnet node: nothing with a key may ever ship to a browser.
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { ReactNode } from "react";

const ENDPOINT = "https://api.devnet.solana.com";
const NONE: never[] = [];

export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={ENDPOINT}>
      <WalletProvider wallets={NONE} autoConnect={false}>{children}</WalletProvider>
    </ConnectionProvider>
  );
}
