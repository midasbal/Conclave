# Custody: what opens a strategy, and how not to lose it

A sealed strategy is opened by two things together: its 32-byte **salt** and its exact **bytecode**. The public commitment is `sha256("CNCL-CODE-v1", salt, code)`. With both you can prove a published result belongs to your strategy and replay it. With either one missing you cannot. All of this is client software; the program knows nothing about backups.

## Where they are

| Copy | Lasts until |
|---|---|
| The key file, `strategies.json` in the key folder | you lose the file or the disk |
| The sealed account in the rollup, readable only by the owner | the strategy is closed (it is wiped, but see below), or the rollup loses its state |
| A recovery bundle | you lose the file, or its passphrase |

## The key file

`register` writes the record **before it sends anything**. If the process dies at any later point, the secret is on disk and `resumeStrategy(c, id)` in `client/flows.mjs` finishes the job (register if needed, delegate, seal). A record is never removed because a send failed, since the send may have landed.

Writes are durable (temporary file, fsync, rename), one writer at a time, and a write that would drop or change a secret already in the file is refused. A file that cannot be parsed is never replaced. If a process is killed while writing, it can leave `strategies.json.lock`; the next write reports it and does nothing until you remove it.

The canary saves its disposable strategies the same way, before sending, into its own file: `canary-strategies.json` in the key folder. Where there is no key folder, as in CI, it uses a temporary file that is lost with the runner.

## The recovery bundle (`ID.cvbundle`)

One JSON file per strategy.

* **In the clear, and authenticated:** format and version, program, cluster name and genesis hash, id, owner, commitment, and the key-derivation and cipher settings. These are public facts, but they do say which strategy a file belongs to.
* **Encrypted:** salt, bytecode, source if available, name, ruleset version and the VM rules fingerprint of the machine that exported it. Padded to a multiple of 8,192 bytes, so the size does not tell which strategy it is.
* **Encryption:** AES-256-GCM. The key is scrypt(passphrase, random 16-byte salt) with N = 131072, r = 8, p = 1 (128 MiB per guess). A fresh salt and nonce on every export. The whole clear header is authenticated, so changing any of it makes the file fail to open. Cost settings read from a file are bounded before any work is done.
* **Passphrase:** at least 12 characters, normalised (NFKC). Length is the only rule enforced: **the strength of a bundle is the strength of its passphrase**, because anyone holding the file can guess offline. `new-passphrase` makes a random 160-bit one.

A bundle is never written inside the repository, and an existing bundle is never overwritten.

"Source if available" means a repository example in `strategies/` whose assembly is exactly the bytecode. Source kept anywhere else is not found. The bytecode alone is enough to open and replay.

## Commands

```
node client/custody_cli.mjs new-passphrase ../conclave-keys/bundle-passphrase.txt
node client/custody_cli.mjs export-all                    # a bundle for every strategy in the key file
node client/custody_cli.mjs recover --owner 3 [--id ID] [--restore]
node client/custody_cli.mjs verify FILE [--season S] [--offline]
node client/custody_cli.mjs rekey FILE...
```

Give the passphrase with `--passphrase-file`, `CONCLAVE_BUNDLE_PASSPHRASE_FILE`, or type it when asked. It is never taken as a command-line value. Bundles go to `bundles/` in the key folder unless you pass `--dir`.

* `export-all` checks each record against whatever the chain still holds (sealed account, registry, published receipt entries), writes `index.json` with public facts only, and exits non-zero on any disagreement. It reads one sealed account at a time, slowly, because the rollup bans clients that hurry.
* `recover` needs the owner's wallet and **not** the key file. Without `--id` it finds the owner's strategies through their open registries on base. Only strategies that are still sealed can be recovered. It writes new bundle files, so it needs a folder where they do not already exist, or the same passphrase.
* `verify --season` needs only the bundle, its passphrase and the public receipt. It replays the bytecode on the receipt's seeds and checks the score commitment, including after the strategy is closed. It needs the author module built (`docs/AUTHORING.md`) and a VM with the receipt's rules. **Showing someone this proof means giving them the salt and the bytecode.** On a format 3 receipt, a season's totals alone can be proved with that season's score salt, which opens neither the code commitment nor another season. That distinction matters only while the strategy is open (see below).
* `rekey` re-encrypts under a new passphrase. Older copies of the file still open with the old one.

## Export before close

**Closing publishes the strategy.** It wipes the sealed account, but makes the salt and bytecode readable by anyone from devnet's transaction history ("Security considerations: sealing disclosure" in `program/LIFECYCLE.md`). No backup protects against that.

`closeStrategy` in `client/flows.mjs` therefore refuses to run unless the caller passes `{ acknowledgeDisclosure: true }`, and prints `F.DISCLOSURE_WARNING` otherwise. It then requires a passphrase and, before sending anything, writes a bundle from the sealed account (or accepts a matching one), reads it back, opens it, and checks program, cluster, id, owner, salt, bytecode and commitment against the sealed account and the registry. `closeStrategyIx` cannot be built without the ticket this check issues, and refuses if the bundle has since changed or gone.

These guards cover users of this client only. Anyone can send CloseStrategy by hand with no backup and no warning, and the program cannot tell. The check also cannot ensure you will keep the file or remember the passphrase.

## How you can still lose it

* Every copy is lost: key file, bundles, and the sealed account (closed, or the rollup lost its state). There is no other way back.
* The passphrase is forgotten after the sealed account and key file are gone.
* Bundles and passphrase sit on one disk. By default both are in the key folder beside the key file, which is not a backup. Keep the bundles somewhere else, and the passphrase somewhere else again.
* A weak passphrase protects a bundle that someone else obtains.
* A compromised machine sees the key file, the passphrase and the decrypted bundle.
* A lost wallet cannot sign in to the rollup to recover. Bundles still open with the passphrase, but the strategy cannot be operated.
* The VM changes. The bundle always opens the commitment, but replaying an old score needs the VM rules it ran under (the receipt records their fingerprint). Ruleset 1 strategies do not run on the current VM.
* A bundle of a record that was never confirmed on chain shows only that its own salt and code agree.

## Tests

`tests/custody.test.mjs` (offline, real crypto, files and processes, including a registration killed at its first network request) and `tests/svm/tests/client_flows.rs` (bundles made from the real program's sealed accounts, closes built by the guarded client, then each score commitment reproduced from the bundle alone).
