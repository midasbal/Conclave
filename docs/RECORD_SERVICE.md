# The record service: capture, store, backup

The verifier (`verifier/`) turns on-chain receipts into a career record. Reading receipts can be repeated by anyone at any time. **Saving the first final copy of each receipt cannot**: the receipt later changes once (ReleaseBond zeroes one field), and a reader who arrives late cannot reconstruct what it said when it closed. So the one thing that is time-sensitive, and irreplaceable, is the capture. This document covers the loop that does it, the store it writes, and how that store is backed up.

Everything here is off-chain and read-only on the chain. It needs no key and sends no transaction.

## What is irreplaceable and what is not

| In the store | If lost |
|---|---|
| `<address>/first-final.json` | **Gone for good.** This is the first final copy. |
| `<address>/flags.json` | Gone: flags are sticky and are only raised when a change is seen. |
| `<address>/observed.json` | Partly rebuildable (transaction history can be read again if the RPC still serves it). The delegation records seen while a receipt was delegated cannot be recovered. |
| `_service/ledger.jsonl` | Gone: the tamper-evidence for everything above. |
| `_service/entries/`, `state.json`, `record.json`, `status.json` | Rebuilt by the next full sweep. |

## The store

```
<store>/<genesis>/<program>/
  <receipt address>/first-final.json   written once, never replaced
                    flags.json         sticky; a flag is never removed
                    observed.json      history already read, delegation records seen
  _service/ledger.jsonl                hash-chained log of everything the archive did
           state.json                  fingerprints of the accounts last processed
           entries/<address>.json      what each address was last decided to be (cache)
           record.json  status.json    the current record, and the service's own health
           lock                        which process is writing
```

The 4B archive format is unchanged, so an existing archive becomes a store with `store init` (its files are copied, verified byte for byte, and never touched).

**The ledger** is an append-only log in which each line carries the hash of the line before it. A line cannot be removed, changed or reordered without breaking every hash after it. It records each first copy saved, each flag raised, each start, a once-a-day heartbeat (so that "nothing changed since" is itself on the record) and every backup alarm. Its last hash, the **head**, commits to the whole history: it appears in every record and in the snapshot. Like the archive it protects against changes made *after* a line was written, not against someone who can rewrite the whole file: keep a head somewhere they cannot reach.

## The loop

```
node verifier/cli.mjs ingest --store DIR [--backup DIR] [--out FILE] [--poll-seconds 60] [--sweep-minutes 15] [--rpc URL]
node verifier/cli.mjs ingest --store DIR --once          # one cycle, then print the counts and digests
```

| | Fast poll (every `--poll-seconds`) | Full sweep (every `--sweep-minutes`, and on the first cycle) |
|---|---|---|
| Reads | the two paged listings of receipts on base (the program's and the delegation program's) | the same listings |
| Per account | unchanged fingerprint (owner, lamports, bytes): **nothing more** | every known account is processed again |
| Per changed account | delegation record, **new signatures only** (`until` the newest already seen), classification, first copy, flags, validator | the same, plus the history of **every** receipt asks for what is new |
| Catches | a new receipt, a settled one, a closed one, any change of bytes or owner, an archived account that has gone | what a fingerprint cannot: an account delegated and returned between two polls with the same bytes, and anything a poll missed |
| Cost | two requests when nothing changed | about one request per receipt |

A delegation that leaves the bytes as they were is therefore noticed within the sweep interval, not the poll interval.

Both run the **same per-address code as the one-shot builder** (`lib/builder.mjs`, `processAddress`), so the record is the same record: a test builds one from the same recorded devnet responses both ways and compares them.

**Freshness.** Every record carries `currentTo` (the finalized slot its listings were served at, and when), `builtAt`, `archive` (`sha256` over the exact first-copy bytes, and `recordSha256`, which blanks the one field ReleaseBond changes, so two honest archives agree on it), `ledger` (line count and head) and `service` (cycle number, last sweep, what this cycle did). `_service/status.json` adds the process, any last error, the next sweep, and the backup state. Anyone can rebuild with `record` and compare the digests.

**When the RPC fails.** The record stays at its last good state and `status.json` says `degraded` with the error. A server error backs off (up to five minutes). A rate limit waits until the time the endpoint named and sends nothing meanwhile.

## What a version 2 record adds

The receipt carries neither of these, so the capture loop recovers them from public base data and says where each came from. Both can be `unknown`, which is a real answer.

* **`stakeToken` on every season.** The receipt records a fee as a bare number. The mint it is paid in is named once, in the season's `InitPool` transaction on base (`[payer, eata, pool, mint, ...]`). The loop reads that transaction the first time it processes a season and remembers the mint; a season with no pool (abandoned before one was made) is `unknown` and asked again at each sweep. A read that fails is never remembered as "no token", and a rate limit stops the cycle. On devnet: 23 seasons name a token (the project's one stake mint), the 6 abandoned ones do not.
* **`registries` for every strategy in the record.** The registry is public on base. `open` (a registry delegated to the rollup shows base's last view, which the record says), `closed` (closed, not yet removed), `retired` (shrunk to the permanent marker) or `unknown`. A close done in the rollup is not visible on base until the registry returns to base, so `open` on a delegated registry means "not known to be closed". Read in one batched request at every sweep, and at once for any strategy not seen before. On devnet: 54 retired, 66 open and delegated.

Records of version 1 (before this) are not read by the API; the first cycle of this version rewrites the record.

## What 4B guarantees, and that capture keeps

| 4B rule | In the capture |
|---|---|
| Classification: only a closed, format 3, program-owned receipt at its own address is final; a delegated one is provisional | the same function |
| The first final copy is saved once and the record is built from it | saved with a hard link that cannot replace; the ledger records it; a copy on disk with no ledger line (a process killed in between) is given one, marked `recovered` |
| A later change is **flagged, never taken** | `compareToFirst` runs on every changed account; the record keeps reading the first copy; flags are sticky and are written to the ledger |
| Re-delegation, multiple delegations, a missing account, an owner change | flagged the same way (the sweep catches the same-bytes case) |
| The three views and the policy | built from the same descriptors by the same code |

## Reading rate

Reads are one at a time, at least 250 ms apart with jitter (a rollup (TEE) host defaults to 1 s: it has banned this client before for hurrying). A `429`, or an answer that says the client is banned, **opens a breaker**: for `Retry-After` (otherwise one minute, ten for a TEE host) every call fails immediately without touching the network, so a loop that keeps trying cannot deepen a ban. The capture loop in this phase reads **base only**: it never reads the rollup.

Use a dedicated RPC for a running service. **Observed:** the shared public devnet RPC answered the first full listing with HTTP 429, and the breaker stopped after that single request and reported when reading could resume.

## Backup

The first copies cannot be rebuilt, so the store is backed up three ways. **None of them is a backup if it sits on the same disk as the store.**

1. **A mirror** (`--backup DIR`, or `store backup --store DIR --to DIR`): the same layout, written after any cycle that saved a copy, raised a flag or changed the ledger, and at every sweep. Point it at **a different volume or host** (a mounted disk, a synced folder). It is a witness, not a blind copy:
   * `first-final.json` is copied once and **never replaced**. If the two ever differ: alarm `backup-mismatch`, neither is touched.
   * the mirror's ledger must be a **prefix** of the store's, otherwise: alarm `ledger-diverged`, nothing overwritten.
   * a flag the mirror holds that the store has lost: alarm `flags-regressed`.
   * a `MANIFEST.json` lists every mirrored file with its hash, and the ledger head.
   Alarms are written to the ledger once each, shown in `status.json` (`state: "backup-alarm"`) and printed.
2. **A snapshot** (`store snapshot --store DIR --out FILE`): all of the irreplaceable material as one JSON file (first copies, flags, observations, the ledger; public data, no secrets, about 170 KB for 29 receipts). It verifies on its own and restores exactly. **Commit it to the repository** (`record-snapshots/record-snapshot-latest.json` is the current one), or keep it offsite. Refresh it whenever a first copy has been saved; each version extends the previous ledger, so versions can be compared. A snapshot cannot be forged to agree with its own digest unless the ledger is rewritten too: it checks both directions (every copy is on the ledger with that hash, and every first copy the ledger remembers is in the snapshot).
3. **An offsite copy of the mirror**, for example `rsync -a --ignore-existing` (never overwrite) or `rclone copy` to object storage. The first-copy files are immutable, so a plain copy is safe.

**Check it, and rehearse the restore.**

```
node verifier/cli.mjs store verify  --store DIR --backup DIR     # first copies against their hashes and the ledger; the mirror against its manifest
node verifier/cli.mjs store restore --store NEW --from-backup DIR
node verifier/cli.mjs store restore --store NEW --snapshot FILE  # both refuse a folder that already holds a store, and verify what they rebuilt
```

**On an alarm:** do not "fix" either side. Copy both aside, find which one matches a snapshot or an offsite copy, and treat the one that does not as damaged. A `first-final.json` that differs from its ledger hash fails `store verify` even if its own hash field was rewritten.

**Limits.** The archive and the ledger protect against changes **after** a first copy was saved. They cannot show what a receipt looked like before the first capture, and a first copy is only as early as the first poll that saw the account closed. Someone with write access to the store, the mirror and every snapshot can rewrite all of them together. Publishing a ledger head (or committing the snapshot) is what makes a rewrite visible.

## Operations

* One writer per store. A second `ingest` on the same store is refused while the first is alive; a stale lock is taken over: its process is gone, or it was written by another container or boot, or it carries this process's own pid (a container restarts at low pids and a killed predecessor's number can come round again). The lock cannot tell a live writer in a different container from a dead one; where that matters the platform must (`docs/DEPLOY_RAILWAY.md`).
* Cadence: `--poll-seconds` and `--sweep-minutes` default to 60 and 15, or to `CONCLAVE_POLL_SECONDS` and `CONCLAVE_SWEEP_MINUTES` when set. The Railway deployment runs 300 and 60. `status.json` records the poll interval (`pollMs`) so a health check can tell a late loop from a slow one.
* An RPC that fails at startup does not stop the daemon: opening the store reads the disk only, and the check of the cluster the RPC serves is the first step of a cycle, so it is retried with everything else. Nothing is read or captured until it has passed; `--once` still fails with the error.
* A strategy registry that cannot be read fails the cycle like any other read: the status says `degraded` (or `rate-limited`) with the reason, the last record stays as it was (known registry statuses are never overwritten with `unknown`), and the same read is retried until it succeeds. First copies saved earlier in that cycle are kept and appear in the next record. The one-shot `record` command still records such a registry as `unknown`.
* A kill at any moment loses nothing: the first copy is written before its ledger line, and the next start adds any line that is missing. A ledger line cut short by the kill is dropped on the next start; any other damage refuses to start.
* SIGTERM and SIGINT finish the cycle in progress, then stop and release the lock.
* The HTTP API over the record is in `docs/API.md`. **Not built here:** reading the rollup, and more than one instance.

## Observed on devnet

* First full pass over 75 receipts, with the history cache from the 4B archive: **21.6 s** (the first one-shot build had taken about four minutes). A poll with nothing changed: **1.3 s**. A sweep: about 25 s.
* A real season run while the daemon watched (`client/proof5a.mjs`): seen as provisional **9 s** after its commit, seen again when republished with no flag, and **saved as a first copy** when it came back to base. That copy equals the finalized base account byte for byte, and is on the ledger once. ReleaseBond then became one information flag, and the record kept reading the first copy. The mirror matched, with no alarm.
* The shared public RPC refused with HTTP 429 and the breaker held: see Reading rate.
