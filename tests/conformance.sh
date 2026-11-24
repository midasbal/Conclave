#!/usr/bin/env bash
# Conformance gate: the same corpus through the VM compiled to host, WASM and SBF, all three must be bit-identical.
# Needs: rust (host + wasm32-unknown-unknown), the Solana CLI tools (cargo-build-sbf, solana-test-validator, solana-keygen), node.
#   tests/conformance.sh            run the gate
#   tests/conformance.sh --regen    regenerate the golden corpus first (a VM change must be reviewed as a ruleset change)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"; TMP="$(mktemp -d)"; trap 'kill $VAL 2>/dev/null || true; rm -rf "$TMP"' EXIT; VAL=""
if [ "${1:-}" = "--regen" ]; then cargo run --release -q -p conclave-conformance-tools --bin cc-gen -- tests/conformance/corpus.bin; cargo run --release -q -p conclave-author --features corpus --bin ca-corpus -- strategies tests/conformance/authored.bin; fi
echo "== host"; cargo test --release -p conclave-conformance-tools >"$TMP/host.log" 2>&1 || { cat "$TMP/host.log"; exit 1; }; grep -E "^test .* \.\.\. |test result: .* [1-9][0-9]* passed" "$TMP/host.log"
# authored path: the strategies in strategies/*.cvs, assembled by the author tool, must be current in tests/conformance/authored.bin and reproduce on the host
echo "== host (authored path)"; cargo test --release -p conclave-author --features corpus >"$TMP/author.log" 2>&1 || { cat "$TMP/author.log"; exit 1; }; grep -E "test result: .* [1-9][0-9]* passed" "$TMP/author.log"
echo "== wasm"; cargo build --release -q --target wasm32-unknown-unknown -p conclave-conformance; [ -d tests/node_modules ] || (cd tests && npm ci --no-audit --no-fund >/dev/null); node tests/run_wasm.mjs
echo "== wasm (authored path)"; node tests/run_wasm.mjs tests/conformance/authored.bin
echo "== sbf"; (cd tests/sbf && cargo build-sbf >/dev/null 2>&1 && rm -f target/deploy/*-keypair.json); solana-keygen new --no-bip39-passphrase --silent -o "$TMP/p.json" >/dev/null; export SBF_PROGRAM_ID="$(solana-keygen pubkey "$TMP/p.json")"
solana-test-validator --reset --quiet --ledger "$TMP/ledger" --bpf-program "$SBF_PROGRAM_ID" tests/sbf/target/deploy/conclave_sbf_harness.so --rpc-port 8923 >"$TMP/val.log" 2>&1 & VAL=$!
for i in $(seq 1 60); do curl -s localhost:8923 -X POST -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' | grep -q ok && break; sleep 1; done
SBF_RPC=http://127.0.0.1:8923 node tests/run_sbf.mjs
echo "== sbf (authored path)"; SBF_RPC=http://127.0.0.1:8923 node tests/run_sbf.mjs tests/conformance/authored.bin; echo "conformance gate: PASS"
