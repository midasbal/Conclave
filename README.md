# Conclave

A sealed-strategy league on Solana. Players write a secret trading strategy, seal it inside a private rollup, and compete across many synthetic markets generated from a verifiable random seed.

Each strategy is a short program for a small deterministic virtual machine. It is created private from its first instant and only its owner can read it, for as long as it stays open: closing it is the one action that ends this, making that strategy's salt and bytecode permanently and publicly readable from devnet's own transaction history (`program/LIFECYCLE.md`, "Security considerations: sealing disclosure"). When a season locks, a VRF seed is drawn and the league runs every sealed strategy through the same set of seeded worlds inside the enclave. Skill is measured across the whole ensemble of worlds rather than a single live market, scores are computed in fixed-point integer math so any owner can replay their own result locally, and a prize pool is paid out by rank. In a season with finals, the top three by season rank play 15 more episodes on a fresh seed, and season plus finals score decides their order. Prizes are recorded on chain and claimed per entry (the client claims them all automatically). The two-phase finals and per-entry claims are deployed on devnet. So is reclaiming a sealed strategy: its owner can close it once no entry is open, the hub gets back the rent it paid, and the owner gets back the registry balance, but see the disclosure note above: closing is the owner's own choice, and only it triggers the leak. The season receipt records every entry's owner and code commitment, and a closed strategy's id is retired for good. With this client the field is private before Lock: each entrant alone signs and pays for its own Enter, and on devnet neither the creator, another entrant, a stranger nor an anonymous caller could learn who else had entered, from the accounts or transaction history they tried. A sponsor who signs someone's Enter does see that entry. Live feeds, what the rollup operator can see and timing analysis are untested; see `program/LIFECYCLE.md`.

## Records and proofs

`verifier/` is a standalone, read-only tool: it rebuilds a career record from the on-chain receipts, keeps the first final copy of each, applies a separate counting policy, and checks four levels of proof. A capture loop keeps those first copies in a managed, backed-up store (`docs/RECORD_SERVICE.md`). What each level does and does not show, and what has to be trusted (including the validator, which receipts do not record), is in [`verifier/README.md`](verifier/README.md).

## Status

Early build, running on Solana devnet. Interfaces and account layouts will change. Nothing here has been audited.

## Stack

- Solana, with a native (non-Anchor) on-chain program
- MagicBlock Ephemeral Rollups for fast execution, with ephemeral accounts that exist only inside the rollup
- MagicBlock Private Ephemeral Rollups (TEE) with the permission program for owner-only account access
- MagicBlock VRF for the season seed
- Ephemeral SPL Token for the entry fees and prize pool

## Repository layout

```
crates/conclave-vm    strategy VM and world generator (no_std, integer only, no floats)
crates/conclave-lab   local reference simulator, strategy assembler and strategy pool builder
verifier/             record builder, counting policy and proof verifier over the receipts (read-only)
crates/conclave-author     strategy source format, assembler with exact work accounting, ensemble simulator (native CLI and WASM); see docs/AUTHORING.md
strategies/           example strategies in the source format
crates/conclave-conformance        one pure function that runs a test vector, shared by every build target
crates/conclave-conformance-tools  corpus generator and fuzzer
tests/                conformance corpus, runners for WASM and SBF, and the SBF harness program
program/              the on-chain program (SBF), PANIC_PASS.md documents its hardening
tests/svm/            in-process SVM suite that runs the compiled program: lifecycle, edge cases, rejections, metering, fuzz
client/               Node scripts that drive the program on devnet, and the devnet canary (client/canary.mjs)
scripts/              reproducible build, deployed-equals-artifact check, canary runner
.github/workflows/    CI (keyless) and the scheduled devnet canary
```

`conclave-vm` is the single source of truth for execution. The on-chain program and the local simulator both depend on it, so a season replayed locally produces the same scores as the chain.

## Building

Toolchain versions used so far:

- Rust stable 1.94 for the host crates
- Solana CLI 3.1.9 with `cargo-build-sbf` (platform-tools v1.52, rustc 1.89) for the program
- Node.js 22

Host crates and the local simulator:

```
cargo build --release
./target/release/conclave-lab          # writes the strategy pool to ./out (override with CONCLAVE_OUT)
```

On-chain program:

```
cd program
cargo build-sbf                        # target/deploy/conclave.so
```

Client scripts:

```
cd client
npm install
```

## Tests

```
tests/conformance.sh                   # host, WASM and SBF must agree bit for bit on the whole corpus
cargo build --profile fuzz -p conclave-conformance-tools --features cov
./target/fuzz/cc-fuzz --seconds 60     # random programs, returns and states; reports any panic or divergence
```

```
tests/author.sh                      # assembler, simulator and the WASM build against the native CLI and the conformance WASM
```

The authored path is also part of the conformance gate: `tests/conformance/authored.bin` pins what the assembler emits for every example strategy and runs it on host, WASM and SBF.

```
tests/svm.sh                           # real program bytecode in an in-process SVM: lifecycle, 1 to 20 entrants, rejections, metering, parsing fuzz
SVM_FUZZ_ITERS=200000 tests/svm.sh     # longer fuzz
```

```
scripts/repro-build.sh --twice --check # two clean SBF builds must hash the same and equal program/BUILD_HASH
scripts/verify-deployed.sh             # read-only: the program on devnet equals the artifact byte for byte
scripts/canary.sh                      # minimal v2 season on devnet under the throwaway canary wallet
```

`docs/AUTHORING.md`, `docs/SEALING.md` and `docs/CAMPAIGN.md` cover writing, testing, sealing and campaigning a strategy. `program/LIFECYCLE.md` describes the season state machine, bounds and deadlines, the two-phase finals, pull payouts and the money guards (cancel and refund, creation bond, hub accounting, solvency) and the access guards (pause, stake-mint allowlist, bond recovery; one authority key for now, multisig deferred). `program/REPRODUCIBLE.md` has the pinned recipe and the one thing to know: the SBF artifact depends on the absolute build path, so the script builds at a canonical path. The canary needs `conclave-keys/canary.json` (or `CANARY_KEY` in the environment) and refuses to run as the payer or the upgrade authority. CI (`.github/workflows/ci.yml`) uses no secrets and no chain. The scheduled canary workflow needs one repository secret, `CANARY_KEY`, set by you.

The SVM suite replaces the rollup-native services (Magic, permission, VRF, eSPL, delegation) with small stand-in programs; the program, System, SPL Token and ATA programs are real. Rent refunds and TEE privacy are checked on devnet only.

The conformance script needs the Solana CLI tools for the SBF leg and runs a local validator. `crates/conclave-vm/PANIC_FREEDOM.md` lists the bound that keeps every VM operation from aborting.

## Keys

No keypair is stored in this repository. The client reads its keys from a folder next to the repository root, `../conclave-keys/` by default, or from the folder named by `CONCLAVE_KEYS`. It expects these files, each a standard Solana keypair JSON:

- `payer.json`: funds transactions and is the program upgrade authority
- `conclave-program.json`: the program address keypair
- `players.json`: a JSON array of keypair arrays used as test players
- `strategies.json`: written by the client before it sends a registration, it holds each strategy's secret salt and code. Back it up with encrypted recovery bundles (`docs/CUSTODY.md`): once a strategy is closed, a copy of its salt and code is the only way to prove or replay it

Keep that folder outside version control and out of any backup that is shared.

## Deploying

The program is deployed as an upgradeable program. With a funded devnet payer:

```
solana program deploy program/target/deploy/conclave.so \
  --program-id ../conclave-keys/conclave-program.json \
  -k ../conclave-keys/payer.json -u devnet
```

## License

Not yet chosen.
