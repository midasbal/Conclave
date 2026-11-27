# The record service: capture, store, backup

The capture loop reads season receipts from base and keeps the **first final copy** of each. A closed receipt changes once, when ReleaseBond zeroes one field. The account can be read again later, but nobody can then show what it said before, or what happened to it in between. That makes capture the time-sensitive part. Everything here is off-chain and read-only: no key, no transaction, no reads from the rollup.

## The store

```
<store>/<genesis>/<program>/
  <receipt address>/first-final.json   written once, never replaced
                    flags.json         sticky: a flag is never removed
                    observed.json      history already read, delegation records seen
  _service/ledger.jsonl                hash-chained log
           state.json                  what has been processed, and what must be retried
           entries/<address>.json      the last decision about each address (cache)
           record.json  status.json    the current record, and the service's health
           lock                        which process is writing
```

| If lost | |
|---|---|
| `first-final.json` | Cannot be recreated as a first observation |
| `flags.json` | Gone: a flag is raised only when a change is seen |
| `observed.json` | History can be read again if the RPC still serves it. Delegation records seen while a receipt was delegated cannot |
| `ledger.jsonl` | The tamper evidence for the rest is gone |
| Everything else | Rebuilt by a full sweep |

**The ledger** records each first copy, flag, start, backup alarm and a daily heartbeat. Each line carries the hash of the one before, and the last hash (the head) appears in every record and snapshot. It exposes later changes to the log, but not a rewrite of the whole file: keep a head somewhere a rewriter cannot reach.

An archive made by the one-shot `record` command becomes a store with `store init`, which copies and verifies it without touching the original.

## The loop

```
node verifier/cli.mjs ingest --store DIR [--backup DIR] [--out FILE] [--poll-seconds 60] [--sweep-minutes 15] [--rpc URL]
node verifier/cli.mjs ingest --store DIR --once
```

The two intervals can also come from `CONCLAVE_POLL_SECONDS` and `CONCLAVE_SWEEP_MINUTES`. The deploy entrypoint defaults to 300 seconds and 60 minutes.

| | Poll | Sweep (and the first cycle) |
|---|---|---|
| Reads | two listings: the program's receipts and the delegation program's | the same |
| Processes | only accounts whose owner, lamports or bytes changed, fetching new signatures only | every known account, asking for new history for each |
| Catches | new, settled, closed and changed receipts; an archived account that has gone | also an account delegated and returned with the same bytes between polls |
| Cost | two requests when nothing changed | grows with the number of receipts (59 requests for 88 listed receipts, measured) |

Both use the same per-receipt code as the one-shot builder (`lib/builder.mjs`). Compared with the first copy, a later change is **flagged, never taken**.

**What a longer interval costs.** A receipt stays on base, so a late poll still captures it. But a copy first taken after ReleaseBond differs in the bond field, and a delegation record is seen only if a poll happens while the receipt is delegated. The validator then rests on transaction history alone.

**Beyond the receipt**, the record adds each season's `stakeToken` (from its `InitPool` transaction; `unknown` if there is none) and each strategy's registry status: `open`, `closed`, `retired` or `unknown`. A delegated registry shows base's last view, so its `open` means "not known to be closed". Each record also carries the slot it is current to, its build time, two archive digests (`recordSha256` ignores the bond field, so honest archives can be compared) and the ledger head.

**Reading rate.** One request at a time, at least 250 ms apart. A 429 or a ban response stops all requests until `Retry-After` (otherwise one minute; ten for a rollup host). Use a dedicated RPC: the shared public devnet node refused the first full listing with 429.

## When something fails

**A cycle that could not read something publishes nothing.** `status.json` says `degraded` or `rate-limited` with the reason, `/healthz` answers 503, the last record stays, and the failed read is retried until it succeeds.

* This covers the cluster check, listings, transaction history, pool reads, strategy registries, any error while processing a receipt, and a damaged or unreadable first copy. A transaction the node lists and then does not serve is a failed read.
* What was already read is kept. History, a found token and known registry statuses are not replaced by a problem note or `unknown`.
* **First copies are not held back.** A final receipt is saved before its history or pool is read, and one failing receipt does not stop the others. After three in a row, the cycle stops asking for histories and pools but keeps capturing. A rate limit stops the cycle at once.
* **The cost: one receipt that can never be read freezes the published record** at its last good state until an operator acts. Health names it. There is no override that publishes around it. On an empty store there is no record at all until one cycle succeeds.
* An RPC failure at startup is handled the same way: the process stays up, and nothing is read until the cluster has been verified. `--once` exits with the error.
* A record that cannot be written fails the cycle too. If `status.json` cannot be written either, only its age and the free-space check show the problem.
* A mirror that cannot be synced does not fail the cycle. It raises the `backup-sync-failed` alarm, is retried each cycle, and clears on success.

**Limits that are not treated as failures:**

| Case | What happens | Why |
|---|---|---|
| A receipt history over 5,000 transactions | Read to the limit and marked incomplete | Anyone can lengthen a history, so failing would let anyone stop publication |
| A pool with over 1,000 transactions | Only the newest 1,000 are searched, so `InitPool` can be reported absent when it exists | A limit of the reader, not yet paged |
| The node says a registry or delegation record does not exist, or returns an empty history | Taken as its answer | It cannot be told from the truth. A receipt not yet captured as final can show as rejected when its delegation record reads as absent |
| A receipt missing from a listing | Archived receipts are looked up anyway; one never seen goes unnoticed | One RPC cannot prove completeness |

The one-shot `record` command publishes what it could read and notes what it could not.

## Backup

A copy on the same disk as the store is not a backup. A mirror there still shows disagreement, but does not survive losing the disk.

1. **Mirror** (`--backup DIR`, or `store backup --store DIR --to DIR`). First copies are written to it once and never replaced; its ledger must be a prefix of the store's; it must not hold a flag the store lacks. Disagreements raise `backup-mismatch`, `ledger-diverged` or `flags-regressed`, and neither side is changed.
2. **Snapshot** (`store snapshot --store DIR --out FILE`). First copies, flags, observations and ledger in one public JSON file that verifies itself and restores exactly. `record-snapshots/record-snapshot-latest.json` is the committed one. It is only as current as its last refresh, which is manual.
3. **Offsite copy** of the mirror (`rsync -a --ignore-existing`, or `rclone copy`).

```
node verifier/cli.mjs store verify  --store DIR --backup DIR
node verifier/cli.mjs store restore --store NEW --from-backup DIR
node verifier/cli.mjs store restore --store NEW --snapshot FILE
```

Restore refuses a folder that already holds a store. **On an alarm, do not repair either side.** Copy both aside and compare them with a snapshot or offsite copy.

Someone who can write to the store, the mirror and every snapshot can rewrite them together. A published ledger head or committed snapshot is what makes that visible.

## Operations

* **One writer per store.** A lock is taken over only if its process is gone, it was written by another container or boot, or it carries this process's own pid but was not taken by it. It cannot tell a live writer in a different container from a dead one; the platform must prevent that.
* **A kill loses no saved copy.** The copy is written before its ledger line, and a missing line is added later. A last ledger line cut short is dropped at the next start; any other ledger damage refuses to start.
* SIGTERM and SIGINT finish the current cycle, then release the lock.
* One instance only. The API over the record is in `docs/API.md`.

## Observed on devnet (2026-11-26, an earlier version of the loop)

A season run while the loop watched (`client/proof5a.mjs`) appeared as provisional 9 s after its commit and was saved as a first copy when it returned to base. The copy equalled the finalized account byte for byte, and ReleaseBond then raised one information flag without changing the record. The failure rules above came later and have been exercised in tests and in one-cycle runs with no failures, not by watching a live season.
