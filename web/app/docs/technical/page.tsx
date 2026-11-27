// Technical documentation. Every claim here is taken from the repository's documents and the program source; the sources are linked at the foot of the page.
import type { Metadata } from "next";
import Link from "next/link";
import { DocPage, type Question, type Section } from "@/components/docs/DocPage";
import { Commands, Digest, Flow, Ledger, Warning } from "@/components/docs/Parts";
import { links, explorerAddress, PROGRAM_ID, BUILD_SHA256 } from "@/lib/links";

export const metadata: Metadata = { title: "Technical documentation" };

const SECTIONS: Section[] = [
  {
    id: "architecture",
    title: "Architecture",
    body: (
      <>
        <Ledger rows={[
          { term: "Program", text: <>A native Solana program, without Anchor, on devnet at <a href={explorerAddress(PROGRAM_ID)}><code>{PROGRAM_ID}</code></a>. It holds the season lifecycle, the money rules and the receipt. It is upgradeable.</> },
          { term: "Strategy VM", text: <>A <code>no_std</code>, integer-only virtual machine and market generator (<code>crates/conclave-vm</code>). The program and the local tools are built from the same code.</> },
          { term: "Private rollup", text: "MagicBlock’s rollup on a trusted execution environment (TEE). Accounts are delegated to it from Solana. Sealed strategies and the running arena live there behind access permissions, and the strategies execute there." },
          { term: "Randomness", text: "A VRF request to one pinned oracle queue. The seed arrives after the season locks and draws the market worlds." },
          { term: "Record service", text: "A read-only capture loop reads season receipts from Solana, keeps the first final copy of each in a store with a hash-chained ledger, and builds the record. It holds no key and never reads the rollup." },
          { term: "Record API", text: <>A public HTTP API under <code>/v1</code> that serves that record. Its <a href={links.api}>contract</a> is a closed JSON Schema. This web app reads it from its own server.</> },
        ]} />
        <h3>A season on chain</h3>
        <Flow label="A season on chain" stages={[
          { stage: "Open", steps: [{ name: "InitReceipt" }, { name: "CreateSeason" }, { name: "Enter", note: "once per entry" }] },
          { stage: "Run", steps: [{ name: "Lock" }, { name: "RequestSeed" }, { name: "Advance", note: "repeated" }] },
          { stage: "With finals", steps: [{ name: "RequestSeed" }, { name: "Advance", note: "repeated" }] },
          { stage: "Settle", steps: [{ name: "Settle", note: "records what is owed" }, { name: "Claim", note: "per entry" }, { name: "CloseClaims" }] },
          { stage: "Wind down", steps: [{ name: "Publish", note: "per entry" }, { name: "Cleanup" }, { name: "Commit and undelegate" }, { name: "ReleaseBond" }] },
          { stage: "If cancelled", steps: [{ name: "Cancel", note: "records refunds" }, { name: "Claim" }, { name: "CloseClaims" }, { name: "Cleanup" }] },
        ]} />
        <p>
          Settle and Cancel move no tokens. They write a claims account, and each claim is its own transaction that anyone may send. The program checks that the pool
          holds what is owed when amounts are recorded and at every claim. Each season also writes a public <strong>terms record</strong>, and Enter sends the fee, the mint
          and the hash of the record it read, so the program refuses an entry into any other terms.
        </p>
        <p>
          Waiting states have deadlines counted in rollup slots, after which anyone can move the season on. Those exits are rollup transactions: they assume the
          validator is still running. A season whose season phase has finished is never refundable. States, bounds, instructions, error codes and account layouts are in
          the <a href={links.lifecycle}>specification</a>.
        </p>
      </>
    ),
  },
  {
    id: "determinism",
    title: "The VM, determinism and local replay",
    body: (
      <>
        <p>
          Scoring uses fixed-point integer arithmetic. A strategy runs once per tick within a work cap of 64 units, with 16 registers that are zeroed at each episode.
          A season draws 2 of 6 market packs from its seed. These rules are <a href={links.ruleset}>ruleset 2</a>; changing any of them makes a new ruleset, and a receipt
          records a fingerprint of the rules it ran under.
        </p>
        <p>
          The same source compiles natively, to WebAssembly and to Solana&rsquo;s SBF. A conformance corpus must come out bit for bit the same on all three. That is
          agreement on the corpus, not a proof for every input.
        </p>
        <p>
          So an owner, with the salt, the code and the receipt&rsquo;s seeds, can <strong>replay their own result</strong> on their own machine and compare it with the
          published score commitment:
        </p>
        <Commands lines={[{ cmd: "node client/custody_cli.mjs verify ID.cvbundle --season SEASON" }]} />
        <p>
          Replay cannot check a <em>ranking</em>. Places depend on every competitor&rsquo;s totals, which would take every competitor&rsquo;s salt and code. Nobody else
          re-executes a season. A replay also needs the VM rules the season ran under: strategies of ruleset 1 do not run on the current VM.
        </p>
      </>
    ),
  },
  {
    id: "sealing",
    title: "Sealing and its limits",
    body: (
      <>
        <p>
          Registering publishes <code>sha256(&quot;CNCL-CODE-v1&quot;, salt, code)</code>. Sealing sends the salt and bytecode to the rollup in the data of the
          <code> SealStrategy</code> instruction. The program recomputes the commitment and stores them in an account whose permission has one member, the owner. The rollup
          also redacts that transaction&rsquo;s body from everyone who is not a member.
        </p>
        <p>
          A second private account, the roster, collects each entry&rsquo;s commitment. Owners and commitments appear on the receipt only at Settle or Cancel.
        </p>
        <Warning title="CloseStrategy ends privacy, permanently">
          <p>
            The Seal transaction is the one place the plaintext appears in a transaction body, and its redaction hangs on the permission. <code>CloseStrategy</code> destroys
            the permission, after which the salt and bytecode can be read from devnet&rsquo;s transaction history with no token at all. This was observed on devnet. No fix
            was found on the current TEE. <a href={links.disclosure}>Security considerations</a>.
          </p>
        </Warning>
        <p>
          Only the owner can close, and never while an entry is open. The repository&rsquo;s client refuses to close without an explicit acknowledgement and a verified
          backup bundle; a hand-built instruction skips both.
        </p>
        <h3>Not enforced by the program, or not tested</h3>
        <ul>
          <li>The read filtering is the rollup&rsquo;s behaviour. It could change with the rollup.</li>
          <li>What the rollup operator and the enclave can see is untested. So are live feeds, timing and traffic analysis, and any RPC method that was not tried.</li>
          <li>Before Lock, with this client, an anonymous caller, a stranger and the creator could not learn the field from the accounts and history queries tried. Whoever signs an Enter for someone else, as fee payer or otherwise, does see it. The program does not control who pays.</li>
          <li>The in-process test suite replaces the rollup&rsquo;s services with stand-ins that do not model privacy.</li>
        </ul>
      </>
    ),
  },
  {
    id: "trust",
    title: "What you have to trust",
    body: (
      <Ledger rows={[
        { term: "Validator and enclave", text: "They execute the program, hold the secrets and write results back. The creator chooses the validator. The receipt does not record it, no tool in the repository verifies an enclave attestation, and results are not re-executed. The record shows a validator it observed in history, which proves nothing about what ran." },
        { term: "Upgrade authority", text: "One key can replace the program. The same project key also controls pause, the stake-token allowlist and bond recovery. Pause stops new seasons and entries, not claims or the paths that wind a season up." },
        { term: "VRF oracle", text: "It cannot be forced to deliver, and is assumed to know a value before delivering it. Withholding a season seed leads to refunds. Withholding a finals seed voids the finals and pays by season rank. The VRF program’s proof verification has not been reviewed here. The pinned queue is shared with other applications." },
        { term: "RPC node", text: "The record is read from one node. It could leave a receipt out, and history such as the validator, the fee’s token and the time is its word." },
        { term: "Record operator", text: "The first final copy protects against changes after it was saved, and shows nothing about before. Someone who can edit the store can rewrite a copy, its hash and the whole ledger." },
        { term: "Season creator", text: "Picks the validator, and can fill the field with their own wallets. The fee’s token must be on the program’s allowlist." },
      ]} />
    ),
  },
  {
    id: "proofs",
    title: "The four proof levels",
    body: (
      <>
        <p>
          The <a href={links.proofs}>verifier</a> fetches the receipt itself and never accepts receipt bytes from the prover. A provisional receipt fails unless explicitly
          allowed. A level shows exactly what its row says, and no more.
        </p>
        <h3>1. Recorded</h3>
        <Ledger rows={[
          { term: "You give", text: "Nothing." },
          { term: "Establishes", text: "The receipt lists this strategy number with this commitment, owner and ranks." },
          { term: "Does not", text: "Show the result is correct: it trusts the program, the upgrade authority, the validator and the RPC. It says nothing about who is showing it, or about the code." },
        ]} />
        <h3>2. Wallet</h3>
        <Ledger rows={[
          { term: "You give", text: "A signature over the verifier’s fresh challenge." },
          { term: "Establishes", text: "At that moment, the prover could get a signature from the wallet that entered." },
          { term: "Does not", text: "Show authorship, knowledge of the code, current ownership or identity. A prover can ask the real key holder to sign." },
        ]} />
        <h3>3. Totals</h3>
        <Ledger rows={[
          { term: "You give", text: "That season’s score salt and the totals." },
          { term: "Establishes", text: "The published score commitment binds these totals." },
          { term: "Does not", text: "Show which code produced them, or that they were computed correctly, or that the presenter owns the entry: the reveal can be passed on. The sealed salt and the code commitment stay closed." },
        ]} />
        <h3>4. Code</h3>
        <Ledger rows={[
          { term: "You give", text: "The sealed salt and the bytecode." },
          { term: "Establishes", text: "They open the code commitment, and replaying them on the receipt’s seeds reproduces the score commitment." },
          { term: "Does not", text: "Show the ranking is right, or authorship, or ownership. It hands over the strategy: the receiver can seal a copy, and can present the same reveal." },
        ]} />
        <p>
          Levels 3 and 4 need a <strong>published</strong> entry to bind totals. For an unpublished entry, and every entry of a cancelled season, level 4 can only show that
          the code opens the commitment. The API checks levels 1 to 3. It never accepts level 4, which runs only on the verifier&rsquo;s own machine. Sending a level 3
          reveal to the API tells its operator those totals; it can be checked offline instead.
        </p>
      </>
    ),
  },
  {
    id: "record",
    title: "The record and its API",
    body: (
      <>
        <p>
          The first time the capture loop sees a receipt final, it saves the bytes and never writes that file again. Later reads are compared with it. A difference is
          <strong> flagged, never taken</strong>, and a flag is permanent. The one expected change, ReleaseBond zeroing one field, is marked as information.
        </p>
        <p>
          If a cycle cannot read something it needs, it publishes nothing, keeps the last good record and reports itself degraded. Completeness cannot be proved: a receipt
          the node never lists goes unnoticed.
        </p>
        <p>
          The API serves seasons, strategies, wallets and commitments, all from public data. No response has a field for a salt or code. Results that are provisional are kept
          apart from final ones, and legacy receipts are marked unverified. With no counting rules configured, its leaderboard counts nothing.
        </p>
        <p>
          Ranking is a separate policy over the record. The official one counts only creators and validators on a trusted list and adds up, over counted seasons, the share of
          other entrants placed below. Because it is a sum, entering more seasons can outrank playing better in fewer. This app shows no leaderboard.
        </p>
      </>
    ),
  },
  {
    id: "reproduce",
    title: "Reproducing the build and verifying the deployed program",
    body: (
      <>
        <p>The repository records this SHA-256 for the deployed build, 524,776 bytes:</p>
        <Digest value={BUILD_SHA256} />
        <p>Confirming it takes two checks, and neither is enough alone. Pinned inputs: Solana CLI 3.1.9, platform tools v1.52, and the committed lockfile.</p>
        <Commands lines={[
          { cmd: "scripts/repro-build.sh --twice --check", note: "source to hash: two clean builds" },
          { cmd: "scripts/verify-deployed.sh", note: "hash to chain: read-only" },
        ]} />
        <ul>
          <li>The first requires two clean builds to be identical and to equal <code>program/BUILD_HASH</code>. It does not read the chain. A CI job runs the same command.</li>
          <li>The second compares the built file with the program data on devnet. That account is larger than the program, and everything after the program&rsquo;s bytes must be zero.</li>
          <li><strong>The build path matters.</strong> The result depends on the workspace&rsquo;s absolute path, so the script builds at one fixed path, bind-mounting a checkout from elsewhere. That needs root or sudo.</li>
          <li>Other host systems and other Solana CLI patch versions are not covered.</li>
          <li>A match shows what is deployed at the time you check. The upgrade authority can change it afterwards.</li>
        </ul>
        <p><a href={links.reproducible}>The full recipe</a>.</p>
      </>
    ),
  },
];

const FAQ: Question[] = [
  { id: "faq-onchain", q: "Do strategies run on Solana itself?", a: <p>No. They run in the program inside the private rollup. Strategies are registered on Solana, and season receipts are committed back to it. What comes back is as trustworthy as the validator that wrote it.</p> },
  { id: "faq-rerun", q: "Can I re-run a whole season and check the winner?", a: <p>No. That needs every entrant&rsquo;s salt and bytecode. You can replay an entry whose salt and code you have, and compare its totals with that entry&rsquo;s published commitment.</p> },
  { id: "faq-attest", q: "Is the TEE attested?", a: <p>Nothing in the repository verifies an attestation. Relying on the enclave is an assumption, and the record&rsquo;s validator field is something it observed, not something it proved.</p> },
  { id: "faq-grind", q: "Can anyone pick the seed?", a: <p>Not the creator or an entrant through the program: only the pinned VRF queue&rsquo;s callback sets it, and each phase has its own callback. The oracle itself can withhold, with the results described <a href="#trust">above</a>, and its proof verification has not been reviewed here.</p> },
  { id: "faq-commit", q: "Do matching commitments detect copied strategies?", a: <p>Only exact reuse of the same salt and bytecode. Identical code under a new salt has an unrelated commitment, so different commitments tell you nothing.</p> },
  { id: "faq-svm", q: "What do the tests not cover?", a: <p>The in-process suite runs the real program bytecode, but its stand-ins for the rollup services model neither privacy nor all of rent. Some guards and void paths have been shown only there, not on devnet; the specification says which were observed. Mainnet has not been used.</p> },
  { id: "faq-upgrade", q: "Is the program frozen?", a: <p>Not on chain. It is upgradeable by one key. Layouts and interfaces can still change, and some past upgrades required that no season be open.</p> },
  { id: "faq-api", q: "Do I need the hosted API to check a result?", a: <p>No. The verifier is standalone and read-only: it rebuilds the record from an RPC of your choice. What it cannot recreate is somebody else&rsquo;s first copy.</p> },
  { id: "faq-audit", q: "Has any of this been audited?", a: <p>No independent audit. The tests and the devnet observations are the project&rsquo;s own.</p> },
];

export default function TechnicalPage() {
  return (
    <DocPage
      path="/docs/technical"
      title="Technical documentation"
      intro={<p>For developers and careful readers: how it is built, what each check establishes, and where trust comes in. <Link href="/docs/using">Using Conclave</Link> covers the same ground in plain language.</p>}
      sections={SECTIONS}
      faqTitle="Technical questions"
      faq={FAQ}
      sources={[
        { label: "README", href: links.readme },
        { label: "Program specification (LIFECYCLE.md)", href: links.lifecycle },
        { label: "Records and proofs (verifier/README.md)", href: links.proofs },
        { label: "Record API", href: links.api },
        { label: "Record service", href: links.records },
        { label: "Ruleset", href: links.ruleset },
        { label: "Reproducible build", href: links.reproducible },
      ]}
    />
  );
}
