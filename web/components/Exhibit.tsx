// The landing page's exhibit: one real devnet receipt. Every value comes from data/exhibit.json, taken from the first final copy of the receipt in the
// repository's record snapshot and checked against its bytes. It is a fixed copy, not a live read.
import exhibit from "@/data/exhibit.json";
import { explorerAddress } from "@/lib/links";
import { ReceiptSheet } from "./ReceiptSheet";
import styles from "./Exhibit.module.css";

/** the exhibit's receipt on its own, so that the docs can explain the very same sheet */
export function ExhibitSheet({ titleId, sealing, heading }: { titleId: string; sealing?: boolean; heading?: "h2" | "h3" }) {
  return (
    <ReceiptSheet
      sealing={sealing}
      heading={heading}
      titleId={titleId}
      title={`Season ${exhibit.season}`}
      subtitle="Receipt on Solana devnet"
      ranks="finals"
      stamp={{ word: "Final", note: "closed on devnet", tone: "final" }}
      facts={[
        { label: "Opened", value: <time dateTime={exhibit.openedOn}>{exhibit.openedOn}</time> },
        { label: "Episodes", value: `${exhibit.episodes}, then ${exhibit.finalsEpisodes} in finals` },
        { label: "Entry fee", value: `${exhibit.entryFee} stake units` },
        { label: "Account", value: <a href={explorerAddress(exhibit.receiptAddress)} title={exhibit.receiptAddress}>{`${exhibit.receiptAddress.slice(0, 4)}…${exhibit.receiptAddress.slice(-4)}`}</a> },
      ]}
      rows={exhibit.entries.map((e, i) => ({ key: e.strategyId, rank: e.finalRank, seasonRank: e.seasonRank, slot: i, strategyId: e.strategyId, owner: e.owner, commitment: e.codeCommitment }))}
    />
  );
}

export function Exhibit() {
  return (
    <figure className={styles.figure}>
      <ExhibitSheet titleId="exhibit-title" sealing />
      <figcaption className={styles.caption}>
        A real season the project ran with its own test wallets. The finals swapped second and third place.
        The black bars mark what a receipt never carries: it has each entry&rsquo;s owner and a commitment to its code, not the salt or the code.
      </figcaption>
    </figure>
  );
}
