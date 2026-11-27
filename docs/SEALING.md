# Sealing an authored strategy

`node client/seal_authored.mjs strategies/FILE.cvs OWNER` takes a strategy in the source format of `docs/AUTHORING.md`, assembles it, and puts it on chain through the ordinary `register` and `seal` flows in `client/flows.mjs`. It then checks that what is sealed is what was written and that others cannot read it.

## What is secret

| Item | Where it lives | Secret |
|---|---|---|
| salt (32 random bytes) | `strategies.json` in the key folder (mode 0600, written before anything is sent); the sealed account; encrypted bundles | **yes**: it is what stops fingerprinting |
| bytecode | `strategies.json`; the sealed account | yes |
| unsalted source and code hashes | `strategies.json` (`artifact`) | yes: either lets anyone hash known strategies and recognise yours |
| ruleset, source format, work, division | `strategies.json` (`artifact`) | no; only the division is acted on (at Enter) |
| `sha256("CNCL-CODE-v1", salt, code)` | the public registry on base | public by design |

`client/artifact.mjs` builds the `artifact` record and prints nothing. A tool that exports it must drop the unsalted hashes (`publicView`). Logs carry the id, the commitment, work, division and pass or fail.

## What the script checks

1. The source assembles within the work cap; work, division and hashes are recomputed independently.
2. The registry is written on base and delegated; the sealed account is created in the rollup readable by its owner only, and the program recomputes the commitment.
3. The owner reads back exactly the authored bytecode and salt.
4. The other players, an anonymous caller and the arena authority get nothing, and the account does not exist on base.
5. The Seal transaction carries the code and salt. The rollup returns its body to the owner and redacts it for everyone else; the check searches for both in hex, base64 and base58. **This lasts only while the strategy is open** (see "Security considerations: sealing disclosure" in `program/LIFECYCLE.md`).
6. The public registry holds the id, owner and commitment, and no code, 8-byte window of it, salt or unsalted hash.
7. The source reassembles to the sealed bytes, and the commitment opens under the stored salt.
8. By simulation only, Enter is refused below the strategy's division (9005) and accepted at it. The test arenas are then cancelled and cleaned up.
9. No stored salt, nor the sealed code or its hashes, is found in the repository or the evidence folder.

Offline coverage: `tests/artifact.test.mjs` (in `tests/author.sh`) and `tests/svm/tests/authored.rs`, which runs every example through the real program.

## Afterwards

* While the strategy is sealed, the owner can rebuild its key-file entry from the sealed account. After a close, only a copy of the salt and bytecode opens the commitment: keep bundles (`docs/CUSTODY.md`).
* A strategy can be retired once it has no open entry (`closeStrategy`; `program/LIFECYCLE.md`). **Retiring it publishes it.**
