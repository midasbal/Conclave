# Conclave

A sealed-strategy league on Solana. Players write a secret trading strategy, seal it inside a private rollup, and compete across many synthetic markets generated from a verifiable random seed.

Each strategy is a short program for a small deterministic virtual machine. It is created private from its first instant and only its owner can read it. When a season locks, a VRF seed is drawn and the league runs every sealed strategy through the same set of seeded worlds inside the enclave. Skill is measured across the whole ensemble of worlds rather than a single live market, scores are computed in fixed-point integer math so any owner can replay their own result locally, and a prize pool is paid out by rank. A finals stage replays the top strategies in fresh worlds to decide the champion.

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
crates/conclave-conformance        one pure function that runs a test vector, shared by every build target
crates/conclave-conformance-tools  corpus generator and fuzzer
tests/                conformance corpus, runners for WASM and SBF, and the SBF harness program
program/              the on-chain program (SBF)
client/               Node scripts that drive the program on devnet
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

The conformance script needs the Solana CLI tools for the SBF leg and runs a local validator. `crates/conclave-vm/PANIC_FREEDOM.md` lists the bound that keeps every VM operation from aborting.

## Keys

No keypair is stored in this repository. The client reads its keys from a folder next to the repository root, `../conclave-keys/` by default, or from the folder named by `CONCLAVE_KEYS`. It expects these files, each a standard Solana keypair JSON:

- `payer.json`: funds transactions and is the program upgrade authority
- `conclave-program.json`: the program address keypair
- `players.json`: a JSON array of keypair arrays used as test players
- `strategies.json`: written by the client, it holds each strategy's secret salt and code; losing it means you can no longer prove or reveal a sealed strategy

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
