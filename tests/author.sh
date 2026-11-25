#!/usr/bin/env bash
# The authoring front, end to end and keyless: assembler and simulator tests (native), then the WASM build against the native CLI and the conformance WASM.
#   tests/author.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
echo "== native: assembler, simulator, ABI, authored corpus (host leg)"; cargo test --release -p conclave-author --features corpus 2>&1 | grep -E "^test result: .* [1-9][0-9]* passed|FAILED|panicked|^error" ; test "${PIPESTATUS[0]}" = 0
echo "== wasm vs native vs conformance wasm"; cargo build --release -q -p conclave-author; cargo build --release -q --target wasm32-unknown-unknown -p conclave-author -p conclave-conformance; node tests/author_wasm.mjs
echo "== sealed artifact (offline): commitment, source equals sealed, registry hygiene, custody, salt discipline"; [ -d client/node_modules ] || (cd client && npm ci --no-audit --no-fund >/dev/null); node --test tests/artifact.test.mjs 2>&1 | grep -E "^# (tests|pass|fail)|^not ok"; node --test tests/artifact.test.mjs >/dev/null 2>&1
echo "author tests: PASS"
