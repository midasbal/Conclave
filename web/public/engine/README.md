# The engine the Workshop runs

`conclave_author-20d30f39.wasm` is the strategy assembler and simulator (`crates/conclave-author`) with the frozen strategy VM (`crates/conclave-vm`) compiled into it, built for WebAssembly. It is committed so that the app can be served without Rust. It is not the on-chain program: that is a separate build for Solana, whose hash is in `program/BUILD_HASH` (`68d37e0f...`).

| | |
|---|---|
| Size | 256,285 bytes (about 91 KB gzipped) |
| SHA-256 | `20d30f391d0e0b1161643c5d2aec896e4159b44c70773698f897d3300aff7e7c` |
| Ruleset | 2 |
| Built with | rustc 1.94.1, cargo 1.94.1, target `wasm32-unknown-unknown` |
| Imports | none |

```
cargo build --release --locked --target wasm32-unknown-unknown -p conclave-author
sha256sum target/wasm32-unknown-unknown/release/conclave_author.wasm
```

The VM sources it was built from:

```
3653fcbbc0ac6ab98f8ea7f1d5e3ad9bb4a29d87851e708a837b21902a4a8455  crates/conclave-vm/Cargo.toml
be99f26648ba48f5df3a042435f5b01420a083af6250104d59f6d2194679a015  crates/conclave-vm/src/lib.rs
2ca605059c76102aab3cd740f08428787c13402343068ee908f79082b31c257b  crates/conclave-vm/src/world.rs
```

## What was checked, on 2026-11-27

* **Source to file.** Two builds into empty target folders, from the sources above with the committed lockfile, each gave this file byte for byte. Both ran on one machine with the workspace at one path. Another machine or path has not been tried.
* **Same behaviour.** `tests/author_wasm.mjs`: 182 of 182 checks agreed with a fresh native build and the conformance module.
* **Same VM rules as on devnet.** The rules fingerprint (`conclave-lab pins`) of a fresh build is the one recorded in the devnet receipt of season 81980.
* **In a browser.** In headless Chromium, the report for each of the eight examples hashed to the same SHA-256 as the native `conclave-author sim --json` output.

The file contains one path from the machine that built it (`/root/.cargo/...`, in an error location from the `sha2` library).

## How the app uses it

`lib/engine/build.ts` names the file and its hash. The worker (`lib/engine/engine.worker.ts`) hashes what it downloads and runs it only if the two match. `lib/engine/core.ts` is the browser form of `client/author.mjs`.

## Replacing it

A change to either crate does not reach the app until this file is replaced. Build it, rename it with the first eight characters of its hash, update `lib/engine/build.ts` and this note, and run `tests/author.sh`. To check a file in place: `CONCLAVE_AUTHOR_WASM=web/public/engine/NAME.wasm node tests/author_wasm.mjs`, after the builds `tests/author.sh` makes. No CI job compares this file with the sources yet.

Two other things are copies and need the same care: `lib/workshop/examples.ts` holds `strategies/*.cvs` byte for byte, and `lib/workshop/instructions.ts` holds the output of `conclave-author ops`.
