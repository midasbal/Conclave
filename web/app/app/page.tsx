import type { Metadata } from "next";
import Link from "next/link";
import { WalletPanel } from "@/components/WalletPanel";

export const metadata: Metadata = { title: "Inside" };

export default function AppPage() {
  return (
    <div className="page room">
      <div className="notice">
        <h1>Nothing is on view yet.</h1>
        <p>
          Seasons, strategies and the leaderboard will be read here, by anyone, without a wallet. This part of the app has not been built.
        </p>
        <p><Link href="/">Back to the entrance</Link></p>
      </div>
      <WalletPanel />
    </div>
  );
}
