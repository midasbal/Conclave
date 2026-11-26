#!/usr/bin/env bash
# Internal: clean-builds the program in the directory this script's checkout is visible at, prints the sha256. Use scripts/repro-build.sh.
set -euo pipefail
cd "$1/program"; rm -rf target
LOG="$(mktemp)"; cargo build-sbf -- --locked >"$LOG" 2>&1 || { tail -20 "$LOG" >&2; exit 1; }
# cargo-build-sbf prints a stack frame overflow and still exits 0; such a binary faults at run time, so it is not a build
if grep -qE "overwrites values in the frame|Stack offset|exceeded max offset" "$LOG"; then echo "SBF stack frame overflow: build rejected" >&2; exit 1; fi
rm -f "$LOG"
rm -f target/deploy/*-keypair.json; sha256sum target/deploy/conclave.so | cut -d' ' -f1
