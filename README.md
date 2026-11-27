# Conclave

A sealed-strategy league on Solana. A player writes a trading strategy as a short program for a small deterministic virtual machine and seals it inside a private rollup. When a season locks, a verifiable random seed is drawn, every sealed strategy runs through the same synthetic markets inside the enclave, and a prize pool is paid by rank.

It runs on **Solana devnet** only. It has **not been audited**. Account layouts and interfaces can still change.

## How a season works

1. **Seal.** The owner registers a salted commitment on Solana and seals the salt and bytecode into the rollup, where only the owner can read them while the strategy stays open.
2. **Create and enter.** The creator opens a season and chooses the validator. Its terms (fee, token, length, timing, field size, ruleset, creator) are written to a public record, and an Enter pays only into the exact terms its entrant read.
3. **Run.** After Lock, a VRF seed picks the market worlds. Anyone can advance the run. Scoring is fixed-point integer arithmetic, so an owner can replay their own result from the seed. With finals, the top three by season rank play 15 more episodes on a fresh seed, and the two totals together decide their order.
4. **Settle and claim.** The program records what each entry is owed. Each prize or refund is claimed separately, by anyone, to the entrant's own token account.
5. **Receipt.** Each season leaves a receipt on Solana with every entry's owner and code commitment, the ranks, and score commitments for the published entries.

`program/LIFECYCLE.md` is the full specification: states, bounds, deadlines, instructions and account layouts.

## Integrity model

### What the program enforces, if it runs as written

* **The code cannot be swapped.** A sealed strategy is checked against its public commitment, and the receipt records the commitment that entered.
* **Entrants pay only into terms they read.** Enter refuses a fee, token or terms hash that does not match the season's record.
* **The program controls the pool.** Payouts follow the recorded ranks, solvency is checked when amounts are recorded and at every claim, and claims never expire.
* **Waits have exits.** Each waiting state has a deadline after which anyone can move the season on. These exits are rollup transactions: they assume the validator is still running.
* **An entry that got in can be published.** A strategy cannot be closed while it has an open entry.

### What you have to trust

* **The validator and its enclave.** They execute the program, hold the secrets and write results back. The season's creator chooses the validator, the receipt does not record which, and no tool here verifies an enclave attestation. Results are not re-executed by anyone else.
* **The upgrade authority.** The program is upgradeable. One key holds that power; it also controls pause, the stake-token allowlist and bond recovery.
* **The VRF oracle.** It could withhold a seed it dislikes. In the season phase that leads to refunds; in the finals it voids them and pays by season rank.
* **The creator,** for the choice of validator, and for the field: one person can create a season and fill it with their own wallets. Its stake token must be one the authority has allowlisted, not any token the creator chooses.

### What it does not guarantee

* **Privacy ends when a strategy is closed.** Closing makes its salt and bytecode **permanently readable by anyone** from devnet's transaction history. Only the owner can close it. See "Security considerations: sealing disclosure" in `program/LIFECYCLE.md`.
* **Privacy against everyone.** What the rollup operator or enclave can see, live feeds, and timing analysis are untested. On devnet, with this client, neither the creator, another entrant, a stranger nor an anonymous caller could learn who had entered before Lock from the accounts and history queries tried. A sponsor who signs someone's Enter does see that entry.
* **That a ranking means skill.** Nothing on a receipt separates a farmed season from a real one. A leaderboard is only as good as the list of creators and validators it trusts.

## Records and proofs

`verifier/` is a standalone, read-only tool. It rebuilds a career record from receipts, keeps the first final copy of each, applies a separate counting policy, and offers four levels of proof. What each level shows and does not show is in [`verifier/README.md`](verifier/README.md). A capture loop keeps the first copies ([`docs/RECORD_SERVICE.md`](docs/RECORD_SERVICE.md)) and a read-only API serves the record ([`docs/API.md`](docs/API.md)).

## Status

| | |
|---|---|
| Program on devnet | Deployed; `program/BUILD_HASH` records the build's SHA-256 |
| Shown on devnet | Seasons with finals, per-entry claims, refunds, the finals seed-timeout void, strategy reclaim, registry-paid rent, public terms. Some guards and void paths are shown only in the in-process test suite; `program/LIFECYCLE.md` says which were observed |
| Capture daemon | Running continuously on Railway against a dedicated Helius devnet endpoint; as of 2026-11-27 it had completed about 20 capture cycles and the service was healthy. It has not yet watched a new season live, from open to settle, through this build: no new season has been run since the deploy |
| Hosting | The record service and its API are hosted on Railway ([`docs/DEPLOY_RAILWAY.md`](docs/DEPLOY_RAILWAY.md)). The web app is live on Vercel at [conclave-league.vercel.app](https://conclave-league.vercel.app) |
| Leaderboard | No counting rules are configured, so it counts nothing |
| Web app | Built in [`web/`](web/README.md): the entry page, a spectator view of the record and the docs. It cannot author or enter yet |

The seasons on devnet so far are this project's own tests.

## Repository layout

| Path | Contents |
|---|---|
| `program/` | The on-chain program (native Solana, no Anchor). `PANIC_PASS.md` covers its hardening |
| `crates/conclave-vm` | The strategy VM and world generator (`no_std`, integer only). The program and the local tools share it |
| `crates/conclave-author` | Strategy source format, assembler and ensemble simulator, native and WASM ([`docs/AUTHORING.md`](docs/AUTHORING.md)) |
| `crates/conclave-lab` | Local reference simulator and strategy pool builder |
| `crates/conclave-conformance`, `-tools` | Test-vector runner, corpus generator and fuzzer |
| `strategies/` | Example strategies |
| `client/` | Node scripts that drive the program on devnet, including strategy custody ([`docs/CUSTODY.md`](docs/CUSTODY.md)) and the canary |
| `verifier/` | Record builder, capture loop, counting policy and proof verifier |
| `server/` | Record API, and wallet-session auth with a key-holding RPC proxy ([`server/README.md`](server/README.md)) |
| `deploy/` | Entrypoint that runs the capture loop and the API as one unit |
| `web/` | Next.js web app: entry page, spectator view of the record, and docs ([`web/README.md`](web/README.md)) |
| `tests/` | Conformance corpus, in-process SVM suite, client and tooling tests |
| `scripts/`, `.github/workflows/` | Reproducible build, deployed-equals-artifact check, canary, CI |

## Building

Versions used: Rust 1.94, Solana CLI 3.1.9 with `cargo-build-sbf` (platform-tools v1.52), Node.js 22.

```
cargo build --release                      # host crates
./target/release/conclave-lab              # strategy pool, written to ./out (CONCLAVE_OUT)
(cd program && cargo build-sbf)            # target/deploy/conclave.so
(cd client && npm ci)
```

## Tests

```
tests/conformance.sh                       # host, WASM and SBF must agree bit for bit on the corpus
tests/author.sh                            # assembler and simulator, native against WASM
tests/svm.sh                               # the real program bytecode in an in-process SVM (SVM_FUZZ_ITERS to fuzz longer)
(cd server && npm ci && npm test)          # needs the verifier's dependencies installed
(cd verifier && npm ci && npm test)        # offline, over recorded devnet responses
cargo build --profile fuzz -p conclave-conformance-tools --features cov && ./target/fuzz/cc-fuzz --seconds 60
scripts/repro-build.sh --twice --check     # two clean builds, equal to program/BUILD_HASH
scripts/verify-deployed.sh                 # read-only: devnet bytes equal the artifact
scripts/canary.sh                          # a minimal live season under a throwaway wallet
```

`.github/workflows/ci.yml` lists the exact CI steps; it uses no secrets and no chain. The SVM suite replaces the rollup services (Magic, permission, VRF, eSPL, delegation) with stand-ins that do not move lamports or model privacy. Rent behaviour and enclave privacy are only checked on devnet. `crates/conclave-vm/PANIC_FREEDOM.md` records the bounds that keep VM operations from aborting. `program/REPRODUCIBLE.md` gives the build recipe, its dependence on the build path, and how to check the deployed program against `program/BUILD_HASH`.

The scheduled canary needs one repository secret, `CANARY_KEY`. Locally it reads `conclave-keys/canary.json` and refuses to run as the payer or upgrade authority.

## Keys

No keypair is stored in this repository. The client reads `../conclave-keys/`, or the folder in `CONCLAVE_KEYS`:

* `payer.json`: pays transactions; the program's upgrade authority
* `conclave-program.json`: the program address
* `players.json`: test player keypairs
* `strategies.json`: each strategy's secret salt and code, written before registration is sent. Back it up with encrypted bundles (`docs/CUSTODY.md`)

Keep that folder out of version control and out of shared backups.

## Deploying the program

```
solana program deploy program/target/deploy/conclave.so \
  --program-id ../conclave-keys/conclave-program.json \
  -k ../conclave-keys/payer.json -u devnet
```

An upgrade can need the program data account extended first, and some require that no season is open. Read the upgrade notes in `program/LIFECYCLE.md` before deploying.

## License

[MIT](LICENSE).
