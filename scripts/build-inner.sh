#!/usr/bin/env bash
# Internal: clean-builds the program in the directory this script's checkout is visible at, prints the sha256. Use scripts/repro-build.sh.
set -euo pipefail
cd "$1/program"; rm -rf target
cargo build-sbf -- --locked >/dev/null 2>&1 || { cargo build-sbf -- --locked 2>&1 | tail -20 >&2; exit 1; }
rm -f target/deploy/*-keypair.json; sha256sum target/deploy/conclave.so | cut -d' ' -f1
