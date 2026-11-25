# Sealing an authored strategy

`node client/seal_authored.mjs strategies/FILE.cvs OWNER` takes a strategy written in the 2a source format and puts it on chain through the existing `register` and `seal` flows (`client/flows.mjs`); nothing on the program side is new.

## The artifact

| Field | Where it lives | Secret? |
|---|---|---|
| salt (32 random bytes) | `strategies.json` in the key folder (outside the repo, mode 0600), and inside the sealed account in the rollup | **yes, it is the secret that stops fingerprinting** |
| bytecode | `strategies.json`, the sealed account | yes |
| source hash, code hash (unsalted sha256) | `strategies.json` (`artifact`) | yes: published, either one lets anyone hash the known preset strategies and recognise yours |
| ruleset, source format, work, division, division index | `strategies.json` (`artifact`) | not secret, but only the division is ever acted on (Enter's gate) |
| salted commitment `sha256("CNCL-CODE-v1", salt, code)` | the public registry entry on base | public by design |

The `strategies.json` entry keeps the shape it always had (`id owner name salt code`) with an `artifact` object added. `client/artifact.mjs` builds it and never prints; `tests/artifact.test.mjs` checks that nothing it does prints, and that no logging line in it or in the sealing script interpolates the salt, the code, its hashes or the bytecode. Logs carry the id, the commitment, work and division, and pass/fail booleans.

## What the script does and checks

1. Assemble the source with the WASM author tool; refuse anything that does not assemble or is over the cap; recompute the work, division and hashes independently.
2. `F.register` (registry on base, salted commitment, delegated) and `F.seal` (sealed account created in the TEE with owner-only permission, program recomputes the commitment).
3. The owner reads the sealed account back through the header `Endpoint` and gets exactly the authored bytecode and the stored salt.
4. Every other reader (each other player, no token, the arena authority) gets nothing; the sealed account does not exist on base.
5. The Seal transaction itself carries the code and the salt. The TEE returns it to the owner in full and to everyone else redacted (signature and header only); the check looks for the salt and the code as hex, base64 and base58 in every encoding.
6. The public registry holds the id, the owner and the commitment, and none of: the code, any 8-byte window of it, the salt, or any of four unsalted hashes of the code.
7. Source equals sealed: the source assembles again to the sealed bytes, hashes equal, the commitment opens under the stored salt, and the sealed code disassembles and reassembles to itself.
8. Division: Enter is simulated against an arena one division below and an arena at the artifact's division. The first is refused with 9005, the second accepted. Nothing is entered; the arenas are cancelled and cleaned and their bonds released.
9. Search: every salt in `strategies.json`, plus the sealed code's hex and its unsalted hashes, is looked for in the repository and the evidence folder.

Offline and in CI: `tests/artifact.test.mjs` (commitment known answer from an independent implementation, the proof and its failure cases, registry checks with deliberately dirty registries, custody mode, salt discipline), and `tests/svm/tests/authored.rs` (every example through the real program: salted register, seal, what the registry holds, wrong salt and edited code refused, 9001 at the cap, and for every example the smallest division Enter accepts equals the artifact's division).

## Limits

- Only the owner can read the sealed strategy back; the salt is therefore only as safe as the key folder, which is not backed up here. Losing `strategies.json` means the owner can no longer prove a commitment (the sealed copy in the rollup still exists while it lives).
- The unsalted hashes in the artifact record are private. If a tool ever exports an artifact for sharing, it must drop them (`publicView` in `client/artifact.mjs` does).
- Entering a campaign and running it with an authored strategy is the next phase; here Enter is only simulated.
