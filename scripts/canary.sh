#!/usr/bin/env bash
# Manual devnet canary. Needs: node 22, rust (builds the local replay tool), and the throwaway wallet key
# (default ../conclave-keys/canary.json outside the repo, or CANARY_KEY with the JSON key array).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
cargo build --release --locked -q -p conclave-lab
[ -d client/node_modules ] || (cd client && npm ci --no-audit --no-fund >/dev/null)
exec node client/canary.mjs
