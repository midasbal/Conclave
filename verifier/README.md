# Verifier: a career record you can rebuild yourself, and four kinds of proof

A standalone, read-only tool over the season receipts on Solana. It needs no key and sends no transaction. (One owner-side command, `sign-challenge`, reads the owner's own key to sign a challenge.)

```
cd verifier && npm ci
node cli.mjs record --archive ../record-archive --out ../record-archive/record.json
node cli.mjs rank   --record ../record-archive/record.json --rules policy/rules.example.json
npm test                      # offline, over recorded devnet responses
```

Reading and proof levels 1 to 3 need only this folder's dependencies and `client/layouts.mjs`. Level 4 also needs the VM (`cargo build --release --target wasm32-unknown-unknown -p conclave-author`). Making a reveal from a recovery bundle needs the client's dependencies (`cd client && npm ci`).

The default RPC is the public devnet node. Use `--rpc` or `CONCLAVE_VERIFIER_RPC` for another. The tool prints and stores only the host name.

## What it reads, and what it accepts

All reads are at **finalized** commitment, and the cluster's genesis hash is checked first.

| Class | Rule |
|---|---|
| **final** | owned by the Conclave program, format 3 (2,464 bytes, byte 146 = 3), written by Settle or Cancel, **closed**, at the address `["receipt", season]` of the season it names |
| **provisional** | the same result, but the account is still held by the delegation program. Accepted only if the delegation program's record for that address names Conclave as the original owner. A validator can still change it, even if it already says closed |
| empty | format 3 with no result yet |
| legacy | the earlier layouts, at a verifiable address |
| rejected | anything else, with the reason: another owner, wrong address, inconsistent contents, or an address that cannot be verified |

A settled season that is still open is always delegated (the program only lets a closed receipt come back), so a provisional result is never "owned by the Conclave program" on base. That is why the delegation record is required.

## Running it continuously

`node cli.mjs ingest --store DIR --backup DIR` is the capture loop: a fast poll every minute, a full sweep every fifteen, the first final copy of every receipt saved exactly once into a managed store with a hash-chained ledger, a mirror, and a committable snapshot. Every record it writes says the slot it is current to. How it works, how it is backed up and how to restore: [`docs/RECORD_SERVICE.md`](../docs/RECORD_SERVICE.md). The one-shot `record` below is the same builder run once.

## The first final copy

A late reader sees only current bytes. So the first time the builder sees a receipt final, it saves the bytes in the archive folder and **never writes that file again**. The record is built from that copy. On every later run, each archived receipt is looked up again (whether or not the RPC lists it) and compared:

| Flag | Meaning |
|---|---|
| `bond-released` (information) | only offsets 184 to 191 changed, to zero. This is what ReleaseBond does, and the only change the program makes to a closed receipt |
| `record-changed` | any other byte differs |
| `redelegated` | held by the delegation program again, or history shows a delegation newer than the copy |
| `multiple-delegations` | history shows more than one delegation (the program allows one) |
| `account-missing`, `owner-changed` | the account is gone or belongs to something else |
| `archive-damaged` | the saved copy no longer matches its own hash. Nothing about that receipt is used |

Flags are permanent: a receipt changed and changed back stays flagged.

**What the archive cannot do.** (The service adds a ledger, a backup mirror and a snapshot: see `docs/RECORD_SERVICE.md`.) It protects you from changes **after** your first copy. It cannot show what happened before. It is a local folder: someone who can edit your disk can rewrite a copy and its hash together. `record` prints two digests. Publish `digest` to commit to your exact copies. Compare `recordDigest` between archives: it blanks the bond field, so two honest archivers agree even if one first saw a receipt before ReleaseBond and the other after. Keep the folder: it cannot be rebuilt.

## Three views

Each view lists `final` and `provisional` results separately.

* **By strategy id.** The permanent id, so a history stays together if a strategy is ever transferred. Each result names the owner at entry, and the view lists all of them. No transfer instruction exists today.
* **By wallet.** The owner written on each receipt at that entry. It is not who owns the strategy now, and one person can use many wallets.
* **By code commitment.** `sha256(salt, bytecode)`. Equal commitments mean the same salt **and** bytecode. **Different commitments tell you nothing**: identical code under a new salt looks unrelated. This is not a search for copied code.

An id should only ever carry one commitment (retired ids cannot be registered again on this build). The record reports an anomaly if one carries two.

## Legacy receipts (formats 1 and 2)

They record no owner, and a commitment only where a result was published. Older builds also let a stranger delegate a receipt. They are listed in a separate section marked **LEGACY. Not verified history**, with ids and published commitments only. They are in no view and no ranking. Official records start at format 3. A legacy receipt whose season cannot be read from its own bytes is rejected, because its address cannot be checked.

## Facts, and the counting policy

For every season the record gives: field size, distinct entrant wallets, distinct code commitments, published entries, creator, whether the creator also entered, fee per entry, total owed and refunded, kind, finals status and reason, episodes, division, VM rules, bond and forfeit, validator, creation time, and flags.

Two limits come from the receipt itself:

* **The fee has no unit.** It is `total owed / entries`, in base units of a stake token that the receipt does not name. A fee of 10 may be worth nothing.
* **The receipt carries no time.** `createdAt` comes from transaction history.

Ranking is a **separate module**, [`policy/official.mjs`](policy/official.mjs): a pure function of the record and a rules file. It never changes the record. Edit it, or run your own with `rank --policy ./mine.mjs`.

The official policy counts a season only if it is final, has no alarm flag, comes from a creator **on your trusted list**, has an observed validator **on your trusted list**, has a result, and has at least two entries. It orders strategies by the sum, over counted seasons, of the share of other entrants placed below them, then by wins. It lists every excluded season with its reasons.

**It sets no minimum fee or wallet count, on purpose.** The system is permissionless: anyone can create a season and fill it with their own wallets and a token of their own. Such a minimum is only a price for farming, never proof against it. Those numbers are there for a reader to judge with. The trusted-creator list is the whole of the protection. `policy/rules.example.json` trusts this project's own test key to show the mechanics; those seasons are tests. An unknown rule name is an error, so a typo cannot silently relax a rule.

## The validator is a trust input

The creator chooses the validator. It is what writes a delegated receipt's results back to base, and **the receipt does not record it**. The builder reports what it could observe, and from where:

* the creator's `Delegate` transaction in base history, which names the validator. This depends on the RPC still serving it, and serving it honestly;
* the delegation record, if the builder ran while the receipt was delegated. It is then remembered in the archive.

The statuses are `observed`, `unknown`, `unnamed` (the delegation did not restrict who may commit) and `conflicting`. Only `observed` can be trusted by a rule, and only if you list that key. **Observing a key proves nothing about what ran.** This tool does not verify any TEE attestation. A trusted validator means one you have decided to believe. The program's upgrade authority is a second trust input.

## The four proof levels

The verifier **fetches the receipt itself**; it never accepts receipt bytes from the prover. With `--archive` it reads the first final copy, compares the live account, and fails if that receipt carries an alarm. Without it, it reads the live account and cannot see earlier changes. A provisional receipt fails unless you pass `--allow-provisional`.

| Level | The prover gives | It establishes | It does **not** establish |
|---|---|---|---|
| 1 recorded | nothing | the receipt lists this id with this commitment, owner and ranks | that the result is correct: this **trusts the system** (program, upgrade authority, validator, RPC). Nothing about who is showing it. Nothing about the code |
| 2 wallet | a signature over your fresh challenge | at that time, the prover could get a signature from the wallet that entered | authorship, knowledge of the code, current ownership, or identity. A prover can ask the real key holder to sign (name yourself in `--asked-by` so the signer sees who is asking) |
| 3 totals | that season's score salt and the totals | the published score commitment binds these totals | which code produced them, or that they were computed correctly. Not that the presenter owns the entry: the reveal can be passed on. The sealed salt and code commitment stay closed, and other seasons are untouched |
| 4 code | the sealed salt and the bytecode | they open the code commitment, and replaying them on the receipt's seeds reproduces the score commitment | **the ranking**: ranks and finals places depend on every competitor's totals, which would need every competitor's salt and code. Not authorship or ownership. **The reveal hands over the strategy**: the receiver can seal a copy and compete with it, and can present the same reveal |

Levels 3 and 4 need a **published** entry to bind totals. An entry never published, and every entry of a cancelled season, has no score commitment: level 4 can then only show that the code opens the commitment, and says so. Levels combine: add level 2 to level 3 or 4 to tie a reveal to a challenge answered by the entering wallet. That still does not prove the two came from one person.

```
# level 1
node cli.mjs verify-recorded --season S --id ID [--commitment HEX] --archive DIR
# level 2:  verifier, then owner, then verifier. A challenge works once and expires in 10 minutes
node cli.mjs challenge --season S --id ID --asked-by "who is asking" --store issued/ --out challenge.json
node cli.mjs sign-challenge --challenge challenge.json --key OWNER-KEYPAIR.json --out response.json
node cli.mjs verify-wallet --response response.json --store issued/
# levels 3 and 4: the owner makes the reveal from a recovery bundle (docs/CUSTODY.md)
node cli.mjs reveal-totals --season S --bundle ID.cvbundle --passphrase-file F --out /outside/the/repo/totals.json
node cli.mjs verify-totals --proof totals.json
node cli.mjs reveal-code   --season S --bundle ID.cvbundle --passphrase-file F --out /outside/the/repo/code.json
node cli.mjs verify-code   --proof code.json
```

Reveal files are secrets: they are written with mode 0600, are never overwritten, and cannot be written inside this repository. The signed challenge bytes start with `0xff`, so they can never be a Solana transaction. Single use is enforced by the verifier's own `--store` folder.

## Limits

* **Completeness is not provable.** One RPC lists the accounts. It could leave one out. Archived receipts are rechecked individually, but a receipt never listed goes unnoticed. Comparing two RPCs helps.
* **History is the RPC's word.** Validator and creation time come from it, and old history can be pruned.
* **Nothing is re-executed** below level 4, and level 4 re-executes one strategy.
* Only devnet has been read.

## Tests

* `npm test`: classification, the archive and every flag, legacy handling, the three views, the facts and the policy, over responses recorded from devnet (`test/fixtures`), including one real receipt followed from provisional to bond-released. Altered inputs are marked SYNTHETIC.
* `tests/svm/tests/verifier_4b.rs`: receipts written by the real program bytecode with throwaway keys, so all four levels run with their secrets, against an independent score oracle, including the program's real ReleaseBond and a voided-finals season.
* `client/proof4b.mjs`: the live devnet run (needs the project's keys).
