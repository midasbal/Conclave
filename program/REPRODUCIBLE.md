# Reproducible program build

The deployed program (devnet `HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne`) is `524,776` bytes with sha256
`68d37e0fdf8a79c5d96ab78092f29b2fd954b1f06521d9d6c5ecabbddae499fb`, the hash recorded in `program/BUILD_HASH`. Anyone can rebuild that file from this source and compare. The built file is not committed (`target/` is ignored); the hash is.

Confirming it takes two checks:

1. **Source to hash.** CI's `reproducible-build` job (`.github/workflows/ci.yml`) runs `scripts/repro-build.sh --twice --check`: two clean builds must be identical and equal `program/BUILD_HASH`.
2. **Hash to chain.** That job does not read the chain. `scripts/verify-deployed.sh`, run after a build, compares the artifact with the program on devnet. The program data account is larger than the program (525,016 bytes at the 2026-11-27 upgrade); the script requires everything after the first 524,776 bytes to be zero.

## Recipe

Pinned inputs:

| Input | Pin |
|---|---|
| Solana CLI (provides `cargo-build-sbf`) | 3.1.9 (`release.anza.xyz/v3.1.9`) |
| SBF platform tools (compiler and core library) | v1.52, rustc 1.89.0, fetched by `cargo-build-sbf` |
| Dependencies | `program/Cargo.lock`, enforced with `--locked` |
| Build path | the workspace must be visible at one absolute path (see below) |

```
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.9/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
scripts/repro-build.sh --twice --check     # two clean builds, must be identical and equal program/BUILD_HASH
scripts/verify-deployed.sh                 # read-only: on-chain bytes equal the artifact, nothing but zeros after it
```

`solana-verify` (the Docker based verifier) is not used: it needs Docker, which this box does not have. The script above pins the same inputs without a container.

## The build path matters (observed)

The measurements below were made on an earlier build, so their hashes and sizes are not the current ones. The artifact depends on the absolute path of the workspace. Cargo includes the path of the path dependency (`crates/conclave-vm`) in the package id, and that feeds the symbol hashes. Observed on this machine, same source, same toolchain and lockfile:

| Build | sha256 prefix | Size |
|---|---|---|
| In place, twice, clean target each time | `1199d62c` both | 434,928 |
| Copy of the tree at another directory | `132a4450` | 434,928 |
| Same copy bind-mounted at the original path | `1199d62c` | 434,928 |
| Same, with a fresh `CARGO_HOME` (re-downloaded dependencies) | `1199d62c` | 434,928 |

No local path is embedded in the binary (`strings` finds none); the difference is symbol hashing, 13,149 bytes differ. So `scripts/repro-build.sh` always builds at the canonical path `/root/blitz-v10/conclave` (the path the deployed artifact was built at). When the checkout lives elsewhere it bind-mounts the checkout there inside a private mount namespace (needs root or sudo; nothing outside the build sees the mount). Override with `CONCLAVE_BUILD_PATH` only if you accept a different hash.

For the next release it is worth moving the canonical path to a neutral one such as `/build/conclave`; that changes the hash once, so do it together with a deploy and update `program/BUILD_HASH` and this file.

## What is checked, and what would disprove it

- Two clean builds hash the same: disproved by any difference between `build 1` and `build 2` in `scripts/repro-build.sh --twice`.
- The source tree builds to the recorded hash: `--check` fails if it differs from `program/BUILD_HASH`. This file records the hash of the current source, so any program change updates it (in the same change).
- The deployed program equals the artifact: `scripts/verify-deployed.sh` fails on any byte difference or trailing non-zero data.
- Not covered: a different host OS, CPU or Solana CLI patch version. Only this machine (Linux x86_64) and the GitHub runner in CI have been compared.
