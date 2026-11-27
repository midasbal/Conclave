// User documentation. Every claim here is taken from the repository's documents and the code; the sources are linked at the foot of the page.
import type { Metadata } from "next";
import Link from "next/link";
import { DocPage, type Question, type Section } from "@/components/docs/DocPage";
import { Ledger, Warning } from "@/components/docs/Parts";
import { ExhibitSheet } from "@/components/Exhibit";
import { links } from "@/lib/links";

export const metadata: Metadata = { title: "Using Conclave" };

const SECTIONS: Section[] = [
  {
    id: "what",
    title: "What Conclave is",
    body: (
      <>
        <p>
          A league for trading strategies that stay sealed while they compete. A strategy is a short program. Its author seals it inside a private rollup on Solana.
          When a season locks, a random seed is drawn, every sealed strategy runs through the same made-up markets, and the prize pool is paid by rank.
        </p>
        <p>
          The markets are synthetic. Nothing trades on a real exchange. Everything runs on <strong>Solana devnet</strong>, a test network, with test stakes.
          It has not been audited.
        </p>
      </>
    ),
  },
  {
    id: "watching",
    title: "Watching the record",
    body: (
      <>
        <p>
          Open <Link href="/app">the record</Link>. It needs no wallet and no account. It lists the season receipts that the record service has read from devnet,
          newest first, and you can open any one of them.
        </p>
        <Ledger rows={[
          { term: "Final", text: "The receipt is closed and back on Solana." },
          { term: "Provisional", text: "The receipt is still held in the rollup, and can still change." },
          { term: "Cancelled", text: "The season did not produce a result. The page says why, and the receipt records the refunds." },
          { term: "Flagged", text: "After first saving the receipt, the record service found something wrong with it or with the saved copy, such as a change the program does not make." },
        ]} />
        <p>
          Each page says when the record was built. The record is only as current as the service that builds it, and the page warns you when it is behind.
          A listing is not an endorsement: the program lets any wallet create a season.
        </p>
      </>
    ),
  },
  {
    id: "writing",
    title: "Writing a strategy",
    body: (
      <>
        <p>
          A strategy is written in a small instruction language and runs once on every tick of a market. It reads signals about the market and about its own
          position, keeps a few numbers between ticks, and sets a position. Each instruction has a cost, and the total for a tick is capped. A season sets a
          ceiling on that cost, called its division.
        </p>
        <p>
          <strong>You can write and test strategies today without any chain, wallet or network</strong>, using the tools in the repository. The simulator runs the
          same virtual machine the program runs, over many generated markets, and reports the spread of results, not one lucky run.
        </p>
        <pre><code>{`cargo build --release
./target/release/conclave-author asm strategies/momentum.cvs   # cost, division, bytecode
./target/release/conclave-author sim strategies/momentum.cvs   # results over many markets`}</code></pre>
        <p>
          Start from the <a href={links.examples}>example strategies</a> and the <a href={links.authoring}>authoring guide</a>. A simulation cannot tell you who you
          will meet in a real season, or promise anything about its markets. There is no editor in this web app.
        </p>
      </>
    ),
  },
  {
    id: "entering",
    title: "Entering a season",
    body: (
      <>
        <Warning title="Today, outsiders cannot practically enter">
          <p>
            The program lets any wallet register a strategy. The obstacle is everything around it. This web app has no way to author or enter. The command-line scripts that do are built around the project&rsquo;s own test wallets. An entry fee is paid in a
            stake token that must be on an allowlist the program&rsquo;s authority controls, and the repository offers no faucet or other public way to get one.
          </p>
        </Warning>
        <p>This is how an entry works, for the seasons that have run:</p>
        <ol>
          <li><strong>Register.</strong> A salted commitment to your code goes on Solana. It identifies the code without revealing it.</li>
          <li><strong>Seal.</strong> The code and the salt go into the private rollup. The program checks that they match the commitment.</li>
          <li><strong>Read the terms, then enter.</strong> Each season publishes its fee, token, length, timing, field size and ruleset. Your entry goes through only if the fee, token and terms you send match that record.</li>
          <li><strong>Lock and run.</strong> The creator can lock the season at any time, and anyone can once its entry window has passed. A season that locks with too few entrants is cancelled. Otherwise a random seed is drawn and anyone can drive the run forward.</li>
          <li><strong>Settle.</strong> The program records what each entry is owed and writes the receipt.</li>
        </ol>
        <p>
          Some seasons have finals: the top three by season rank play 15 more episodes on a new seed, and the two totals together decide their order.
        </p>
      </>
    ),
  },
  {
    id: "sealing",
    title: "What sealing means, and where it ends",
    body: (
      <>
        <p>
          While your strategy is <strong>open</strong>, its code and salt are inside the private rollup and only your wallet is let read them. What is public is
          your wallet as its owner, a number for the strategy, and the commitment. Sealing, entering, running, settling and claiming do not publish your code.
        </p>
        <Warning title="Closing a strategy makes its code public, permanently">
          <p>
            Closing is how you retire a strategy and get back part of what it holds. It also removes the access rule that kept the transaction which sealed it private.
            From then on <strong>anyone can read your salt and code from devnet&rsquo;s own transaction history</strong>, without logging in. This cannot be undone.
          </p>
          <p>Only you can close your strategy, and not while any of its entries is open. No rival and no season result can force it. <a href={links.disclosure}>The full explanation</a>.</p>
        </Warning>
        <p>
          The privacy is provided by the rollup, not by the program alone, so it is only as good as the rollup and the enclave it runs in. What the rollup&rsquo;s operator can
          see, live data feeds and timing analysis have not been tested. Before a season locks, in tests with this project&rsquo;s client, other people could not see
          who had entered in the ways they tried. A sponsor who signs an entry for you does see that entry.
        </p>
        <p>
          Keep a backup of your salt and code. If you lose every copy there is no way to prove a result was yours. The tools can make an encrypted backup; see the
          {" "}<a href={links.custody}>custody guide</a>.
        </p>
      </>
    ),
  },
  {
    id: "receipt",
    title: "Reading a receipt",
    body: (
      <>
        <p>This is a real devnet season, run by the project with its own test wallets.</p>
        <ExhibitSheet titleId="docs-receipt-title" heading="h3" />
        <Ledger rows={[
          { term: "Final", text: "Where the entry placed. This decides the prizes." },
          { term: "Season", text: "Where it stood after the season and before the finals. Shown only when finals were played. In a cancelled season there are no ranks, and entries are numbered by seat." },
          { term: "Strategy", text: "The strategy’s number. The page keeps the full number, and the owner’s wallet, in the cell’s tooltip." },
          { term: "Code commitment", text: "A fingerprint of the salt and code together. It lets an owner prove later which code entered. Two different fingerprints tell you nothing about whether the code differs: the same code with a new salt looks unrelated." },
          { term: "Black bars", text: "The salt and code. A receipt never holds them. The bars do not promise that they are still secret: a strategy closed since then is public." },
          { term: "Stamp", text: "Final means a closed receipt back on Solana. Provisional and cancelled seasons are stamped as such." },
        ]} />
        <p>
          A receipt does not hold scores in the clear. For published results it holds a commitment to them. It also does not name the token the fee was paid in,
          the time, or the <strong>validator</strong> that ran the season. The record recovers the first two where it can from transaction history, and shows the
          validator it observed. Treat that as something you choose to trust.
        </p>
      </>
    ),
  },
  {
    id: "ranks",
    title: "What a rank means",
    body: (
      <>
        <p>
          A rank says where a strategy placed, by total score, in <strong>that field, on those markets</strong>. Everyone in a season faces the same ones.
          With finals, the top three are ordered by season total plus finals total.
        </p>
        <p>
          It does not say the strategy is skilled, or would win again. A season draws only some of the possible market types, strategies that are close can change places from one season
          to the next, and one person can create a season and fill it with their own wallets. Nothing on a receipt can tell a season filled that way from a contested one.
        </p>
        <p>This app shows no leaderboard.</p>
      </>
    ),
  },
  {
    id: "prizes",
    title: "Prizes and refunds",
    body: (
      <>
        <p>
          The pool is split 50, 30 and 20 percent among the first three places, or 60 and 40 with two entrants, and all of it goes to a sole entrant. Any remainder goes to the
          last paid place. A cancelled season refunds the fees.
        </p>
        <p>
          Settling a season does not send money. It <strong>records</strong> what each entry is owed. Each amount is then claimed with its own transaction.
          <strong> Anyone can send that claim</strong>, and it can only pay the entry owner&rsquo;s own token account, once. Claims never expire, and keep working if the program is paused.
        </p>
        <p>
          If your token account cannot receive the payment, only your claim waits. This web app has no claim button. In the seasons run so far, the project&rsquo;s scripts sent the claims.
        </p>
      </>
    ),
  },
];

const FAQ: Question[] = [
  { id: "faq-wallet", q: "Do I need a wallet?", a: <p>Not to read anything here. A wallet would be needed to author and enter, which this app does not do yet. The Connect button in the record only shares your address with the page. It signs nothing and sends nothing.</p> },
  { id: "faq-money", q: "Is real money involved?", a: <p>No. This is Solana devnet, a test network. The stake tokens are test tokens, and nothing trades on a real market.</p> },
  { id: "faq-enter", q: "Can I enter a season now?", a: <p>Not in practice. There is no entry flow in the app, the scripts are written around the project&rsquo;s own test wallets, and there is no public way to get the stake token. You can write and simulate strategies on your own machine.</p> },
  { id: "faq-see", q: "Can anyone else see my strategy?", a: <p>While it is open, other players and the public are not given access to it, and in the devnet checks they could not read it. The program does not enforce that by itself: the private rollup does, and what its operator can see has not been tested. Once you close the strategy, <a href="#sealing">anyone can read it</a>.</p> },
  { id: "faq-undo", q: "Can I delete a strategy and keep it private?", a: <p>No. The only way to retire it is to close it, and closing publishes its code. If you never close it, it stays in the rollup, and what it holds stays there too. Part of what registering a strategy costs never comes back, either way.</p> },
  { id: "faq-stuck", q: "What happens if a season stalls?", a: <p>Each waiting stage has a deadline, after which anyone can move it on: usually to a cancellation with refunds, or, if finals fail, to a payout by season rank. All of those steps happen in the rollup, so they assume the season&rsquo;s validator is still running. What happens to entry fees if it stops has not been shown.</p> },
  { id: "faq-claim", q: "Do I have to claim my prize myself, or by a deadline?", a: <p>Neither. Anyone can send your claim, the money can only go to your token account, and there is no deadline.</p> },
  { id: "faq-trust", q: "What am I trusting?", a: <p>The validator and its enclave to run the season honestly and keep it private; whoever holds the program&rsquo;s single upgrade key, who can change the program; an outside service to deliver the random seed; and the network node the record is read from. Nothing here checks the enclave&rsquo;s attestation, and nobody else re-runs a season. See <Link href="/docs/technical#trust">the technical page</Link>.</p> },
  { id: "faq-behind", q: "Why does a page say the record is behind?", a: <p>The pages are built from a record that a separate service keeps. If that service has not rebuilt it recently, newer seasons are missing from the page. The receipts themselves are on devnet regardless.</p> },
  { id: "faq-audit", q: "Has it been audited?", a: <p>No.</p> },
];

export default function UsingPage() {
  return (
    <DocPage
      path="/docs/using"
      title="Using Conclave"
      intro={<p>For anyone watching the league or thinking of playing in it. Plain language, including what it cannot promise.</p>}
      sections={SECTIONS}
      faqTitle="User questions"
      faq={FAQ}
      sources={[
        { label: "README", href: links.readme },
        { label: "Program specification (LIFECYCLE.md)", href: links.lifecycle },
        { label: "Authoring guide", href: links.authoring },
        { label: "Custody guide", href: links.custody },
        { label: "Records and proofs", href: links.proofs },
      ]}
    />
  );
}
