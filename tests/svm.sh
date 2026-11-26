#!/usr/bin/env bash
# Program-level SVM suite: the real compiled program bytecode in an in-process SVM (magicblock-litesvm), full lifecycle, edge cases, rejections, metering and fuzz.
# Needs: rust, the Solana CLI tools (cargo-build-sbf).
#   tests/svm.sh                      build the program and stand-ins, run the suite
#   SVM_FUZZ_ITERS=200000 tests/svm.sh   longer fuzz runs (default 20000 per fuzz test)
#   CONCLAVE_SO=/path/to/other.so     run the suite against another build of the program
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
# cargo-build-sbf reports an overflowing stack frame as text and still exits 0, and the program then faults at run time: treat it as a failed build. The source is touched so a cached build cannot hide the message.
touch program/src/lib.rs; LOG="$(mktemp)"; (cd program && cargo build-sbf >"$LOG" 2>&1) || { cat "$LOG" >&2; exit 1; }
if grep -qE "overwrites values in the frame|Stack offset|exceeded max offset" "$LOG"; then grep -E "overwrites values in the frame|Stack offset|exceeded max offset" "$LOG" | sort | uniq -c >&2; echo "SBF stack frame overflow: build rejected" >&2; exit 1; fi
rm -f "$LOG" program/target/deploy/*-keypair.json
(cd tests/svm/standins && cargo build-sbf >/dev/null 2>&1 && rm -f target/deploy/*-keypair.json)
cd tests/svm && cargo test --release 2>&1 | grep -E "^test |test result|FUZZ|FINDING|METER|panicked|error" | grep -v "DOES NOT ASSEMBLE"
