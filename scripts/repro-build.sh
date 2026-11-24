#!/usr/bin/env bash
# Reproducible build of the on-chain program. Prints the sha256 of program/target/deploy/conclave.so.
#
# Why this script exists: the SBF artifact depends on the absolute path of the workspace (cargo folds the path of
# path dependencies into the package id, which feeds the symbol hashes). Same source, same toolchain, same
# dependency versions, different directory gives a different (equal-sized) binary. The recipe therefore builds at a
# canonical path, using a private bind mount when the checkout lives somewhere else.
#
#   scripts/repro-build.sh            build at the canonical path, print the hash
#   scripts/repro-build.sh --twice    clean build two times and fail unless both hashes are identical
#   scripts/repro-build.sh --check    also fail unless the hash equals program/BUILD_HASH
#
# Environment: CONCLAVE_BUILD_PATH overrides the canonical path (default below, the path the deployed binary was built at).
# Needs: Solana CLI 3.1.9 (cargo-build-sbf, platform-tools v1.52, rustc 1.89 inside it) on PATH, and root or sudo when a mount is needed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; CANON="${CONCLAVE_BUILD_PATH:-/root/blitz-v10/conclave}"
TWICE=0; CHECK=0; for a in "$@"; do case "$a" in --twice) TWICE=1;; --check) CHECK=1;; *) echo "unknown argument $a" >&2; exit 2;; esac; done
want_version="solana-cargo-build-sbf 3.1.9"; got="$(cargo build-sbf --version 2>&1 | head -1)"
[ "$got" = "$want_version" ] || { echo "toolchain mismatch: expected '$want_version', found '$got'" >&2; exit 2; }
build() { if [ "$ROOT" = "$CANON" ]; then "$ROOT/scripts/build-inner.sh" "$CANON"; else
  SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -E env PATH=$PATH"
  $SUDO mkdir -p "$CANON"; $SUDO unshare -m bash -c "mount --bind '$ROOT' '$CANON' && '$CANON/scripts/build-inner.sh' '$CANON'"; fi; }
h1="$(build)"; echo "build 1: $h1"
if [ "$TWICE" = 1 ]; then h2="$(build)"; echo "build 2: $h2"; [ "$h1" = "$h2" ] || { echo "NOT REPRODUCIBLE: two clean builds differ" >&2; exit 1; }; fi
echo "size: $(stat -c %s "$ROOT/program/target/deploy/conclave.so") bytes"
if [ "$CHECK" = 1 ]; then exp="$(tr -d ' \n' < "$ROOT/program/BUILD_HASH")"; [ "$h1" = "$exp" ] || { echo "BUILD HASH MISMATCH: built $h1, program/BUILD_HASH says $exp" >&2; exit 1; }; echo "matches program/BUILD_HASH"; fi
