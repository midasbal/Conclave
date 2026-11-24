#!/usr/bin/env bash
# Compare the program deployed on devnet with a locally built artifact. Read-only and keyless: no wallet is used.
#   scripts/repro-build.sh && scripts/verify-deployed.sh
# Environment: PROGRAM_ID (default: the Conclave devnet program), RPC_URL (default devnet), SO (default program/target/deploy/conclave.so).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; PROGRAM_ID="${PROGRAM_ID:-HZ3b6zexePfH5cXT5qaKKHfA8B29xwBGGYgu84WgMdne}"; RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"; SO="${SO:-$ROOT/program/target/deploy/conclave.so}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
solana program dump "$PROGRAM_ID" "$TMP/onchain.so" -u "$RPC_URL" >/dev/null
N="$(stat -c %s "$SO")"; M="$(stat -c %s "$TMP/onchain.so")"
[ "$M" -ge "$N" ] || { echo "on-chain data ($M bytes) is shorter than the artifact ($N bytes)" >&2; exit 1; }
a="$(sha256sum "$SO" | cut -d' ' -f1)"; b="$(head -c "$N" "$TMP/onchain.so" | sha256sum | cut -d' ' -f1)"; pad="$(tail -c +$((N+1)) "$TMP/onchain.so" | tr -d '\0' | wc -c)"
echo "artifact $a ($N bytes)"; echo "on-chain $b (first $N of $M bytes; non-zero bytes after the program: $pad)"
[ "$a" = "$b" ] && [ "$pad" = 0 ] && echo "DEPLOYED == ARTIFACT" || { echo "DEPLOYED != ARTIFACT" >&2; exit 1; }
