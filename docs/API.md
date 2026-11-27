# The record API (v1)

A public, read-only HTTP API under `/v1`, served by `server/` from the record the capture loop writes (`docs/RECORD_SERVICE.md`). The web app, live at [conclave-league.vercel.app](https://conclave-league.vercel.app), reads it.

* **It reads the store, not the chain.** A request costs one stat of two files unless the loop has written a new record. The single exception is the freshness field of `/v1/status`, which asks the RPC for one finalized slot (cached ten seconds).
* **The `/v1` code uses no token and no secret.** It never talks to the rollup, never sees a wallet key, and has no field that could carry a strategy's salt or bytecode. (A full server in the same process also holds an auth secret for its login routes; record-only mode needs none.)
* **Everything in it comes from public receipts**, plus two facts read from public base data: the stake token of a season (its `InitPool` transaction) and whether a strategy has been closed (its registry account). The receipt itself carries neither.

## The contract

The contract is `server/src/api/schema.mjs`: JSON Schema for every response and request, and the route table. Nothing else describes the API. The router takes its routes and cache policy from it, `server/openapi.v1.json` (OpenAPI 3.1) is generated from it (`node server/bin/gen-openapi.mjs`) and committed, and `GET /v1/openapi.json` serves it. Every object is closed (`additionalProperties: false`): a field that is not in the schema is a test failure, so the API cannot grow a field, or lose one, without this file and the committed OpenAPI document changing in the same commit.

The contract tests (`server/test/api.contract.test.mjs`, `api.proofs.test.mjs`) build a store with the real capture loop over responses recorded from devnet, start the server, and validate every page of that record against the schema with ajv. The server's own small request validator is checked against ajv on every response and on corrupted copies.

## Permalinks

All ids are text. A page is served at one address, repeated in its `permalink` field and in a `Content-Location` header, and every link inside a response is such an address.

| Permalink | What it is |
|---|---|
| `/v1/seasons/{season}` | a season: decimal id |
| `/v1/strategies/{id}` | a strategy by its permanent id: decimal |
| `/v1/wallets/{pubkey}` | a wallet: base58 |
| `/v1/commitments/{commitment}` | a code commitment: 64 lowercase hex characters |

An id of the wrong form is `400`; a well-formed id that is on no receipt is `404`. Trailing slashes are not accepted. A query parameter a route does not take is `400` (`unknown_parameter`), never silently ignored.

## Endpoints

Every `GET` response is JSON with `apiVersion`, `asOf` (the slot the record is current to, when it was built, the record version, the archive digests and the ledger head), `permalink` and `notices`.

| Endpoint | Returns |
|---|---|
| `GET /v1/leaderboard?limit&offset` | the counting policy's output: the **ranking**, every **counted** season, every **excluded** season with each reason it was excluded, the **exact rules in force**, the ranking's basis, and the policy's disclaimers. With no rules configured it counts nothing and says so |
| `GET /v1/seasons?status&kind&creator&order&limit&offset` | every season with its raw facts: field size, fee (with its token), creator, distinct wallets, whether the creator also entered, validator, flags. Newest first by default; `limit` up to 200 |
| `GET /v1/seasons/{season}` | one season: the above, plus episodes, finals, division, bond, the receipt's address and first-copy hash, its history events, and every entry |
| `GET /v1/strategies/{id}` | the strategy's full history (final and provisional kept apart), the **owner at each entry**, its code commitments, its **registry status** (open, closed, retired), and the sealing-disclosure notice |
| `GET /v1/wallets/{pubkey}` | the results where this wallet is the owner recorded on the receipt |
| `GET /v1/commitments/{commitment}` | results grouped by commitment, with the caveat that **only the same salt and bytecode share one** |
| `GET /v1/legacy` | receipts of earlier builds, labelled `verified: false`, with the receipts whose address could not be verified |
| `GET /healthz` (not under `/v1`) | a health check that answers 503, naming each failing check, unless the capture loop, the record, the ledger and the volume are all as they should be (`docs/DEPLOY_RAILWAY.md`) |
| `GET /v1/status` | freshness (record age, current slot, lag against the chain, stale or not), last build, the capture loop's state and last error, **alarms** (flagged receipts, backup alarms) and the archive digests |
| `GET /v1/proofs`, `POST /v1/proofs/...` | see Proofs |
| `GET /v1/openapi.json` | this contract |

Errors are `{ "apiVersion": "v1", "error": { "type": "...", "message": "..." } }`. `503` means there is no usable record (`store_empty`, `store_format`, `store_unreadable`) or the rules file is unusable; `/v1/status` still answers and says why.

**Failure text in public answers.** `/v1/status` and `/healthz` name the step that failed and a generic reason, for example `reading transaction history (receipt <address>): the RPC answered HTTP 503` or `writing the record: the disk is full`. The text is built from fixed phrases plus at most a receipt address, an HTTP status number and a count (`verifier/lib/public_error.mjs`), so file paths, host names and an RPC's own error text cannot appear. The full message is in the service log, and in `status.json` on the server's own disk. Receipt flags are not rewritten: they describe public chain data.

## Caching

The data is public and changes at most once per capture-loop poll, so it is shareable and revalidated:

| Response | `Cache-Control` |
|---|---|
| leaderboard, seasons, strategies, wallets, commitments, legacy | `public, max-age=30, s-maxage=60, stale-while-revalidate=300`, with an `ETag`; `If-None-Match` answers `304` |
| status | `public, max-age=5` |
| proofs list, OpenAPI | `public, max-age=3600` |
| every proof request, every challenge, every error | `no-store` |

Any origin may read (`Access-Control-Allow-Origin: *`; nothing is credentialed), with a matching preflight. `/v1` has its own rate limits (default 300 a minute per client address; 30 a minute for issuing challenges). `CONCLAVE_CLIENT_IP` sets how a caller is identified (`docs/DEPLOY_RAILWAY.md`). A credential in a URL is refused, as on every route.

## What every response keeps to

Enforced by the schema and checked by tests over the recorded data.

* **The fee always carries its stake token.** The receipt records a fee as a bare number. Every `fee` object has a `token`: the mint recovered from the season's `InitPool` transaction on base (`status: "observed"`, with where it was recovered from), or `mint: null` with `status: "unknown"` and the reason. A season abandoned before its pool was made has no token to name, and says so. A `unit` sentence says what the number is in.
* **The validator is a trust input.** Every season's validator has `trustInput: true`, the sources it was recovered from, and a notice: it is chosen by the creator, is not on the receipt, and no attestation has been checked.
* **A strategy is never returned without the sealing-disclosure notice**, and a closed one carries the stronger form: its salt and bytecode are permanently readable by anyone from devnet's own transaction history. The API **never serves or links them**: no field of any response is named `salt`, `code`, `bytecode` or `source` (a test walks the whole schema), no route looks up a strategy's transactions, and a test scans every response for any signature that is not one of a receipt's own history events. Whether a strategy is closed comes from its registry on base; a delegated registry shows base's last view, and the response says so.
* **A ranking is never more than it is.** The leaderboard returns the excluded seasons with their reasons and the rules as configured. The policy sets no wallet or fee minimum, and says that counts do not prove a field is not one person.
* **Legacy receipts** are `verified: false`, in `/v1/legacy` only, in no season list, view or ranking.
* **A provisional result** is marked, kept apart from final ones, and never counted.

## Proofs

| Level | Where | Endpoint |
|---|---|---|
| 1 recorded | server, stateless | `POST /v1/proofs/recorded` `{season, strategyId, codeCommitment?, allowProvisional?}` |
| 2 wallet | server, challenge and verify | `POST /v1/proofs/wallet/challenges`, then `POST /v1/proofs/wallet/verify` |
| 3 totals | server, stateless | `POST /v1/proofs/totals` `{season, strategyId, total, finalsTotal, scoreSalt, allowProvisional?}` |
| 4 code | **your browser or the CLI. Never the server** | none |

Each result has `verified`, every check, `blockers`, what the level `establishes` (only if it verified) and what it `doesNot` establish, and the receipt it was checked against (its status and where it was read from). A season that is provisional, or flagged with an alarm, is never a pass. Level 1 trusts the system; level 3 does not say which code produced the totals; see `verifier/README.md` for what each level does and does not prove. The proofs list (`GET /v1/proofs`) carries the same statements.

**Level 2.** `POST /v1/proofs/wallet/challenges` with `{season, strategyId, askedBy}` (`askedBy`: who is asking, 3 to 120 printable characters) returns a challenge and the exact bytes to sign (`signThis.bytes`, base64). They start with `0xff`, so they can never be a Solana transaction. The entering wallet signs them as a message with its ed25519 key. `POST /v1/proofs/wallet/verify` with `{nonce, signature}` (hex, 128 characters) checks that signature against the owner **the receipt records at that entry**. The challenge is the server's own copy, so nothing the prover echoes back is trusted but the signature. It lives ten minutes and is **single-use**: it is removed the first time it is answered, whether or not the signature was right, and an unknown, used or expired challenge all get the same `404`. A wallet proof says the answerer could obtain a signature from that wallet at that moment; it does not show authorship, current ownership or identity.

**The challenge store is in memory and serves one instance.** Two instances behind a balancer cannot redeem each other's challenges, and a single use could be spent twice. Before running more than one instance, back `ChallengeStore` (`server/src/api/challenges.mjs`: `put`, `take`, `size`; `take` must be an atomic read-and-delete) with a shared store such as Redis. The same holds for the rate-limit buckets and the session nonce store. This is also written at the top of that file.

**Level 4 is never accepted server-side.** It needs the sealed salt and the bytecode, which this server must never receive. It runs in the user's browser on the existing WASM build of the conclave VM (`crates/conclave-author`), or with `node verifier/cli.mjs verify-code`. `POST /v1/proofs/code` answers `422 level_4_not_accepted`. Every proof endpoint also refuses, `400 secret_field_refused`, any request carrying a field named `salt`, `sealedSalt`, `code`, `bytecode`, `source`, `passphrase`, `privateKey`, `secret` or `seed`, before reading anything else. Request bodies are never logged (a log line is the method, the path and the status) and nothing is stored but the challenge.

**Level 3 costs privacy.** A score salt is not the sealed salt and opens neither the code commitment nor another season, but sending it here tells the operator that season's totals. To keep them to yourself, check offline (`verify-totals`).

## Running it

Deployment, health checks, record-only mode and rate-limit settings are in `docs/DEPLOY_RAILWAY.md`.

```
node verifier/cli.mjs ingest --store DIR --backup DIR        # the capture loop (docs/RECORD_SERVICE.md)
CONCLAVE_STORE_DIR=DIR CONCLAVE_RULES_FILE=rules.json node server/bin/serve.mjs
```

| Setting | |
|---|---|
| `CONCLAVE_RECORD_ONLY=1` | serve the record API alone: no auth secret and no upstream needed, and the login, player and chain-proxy routes answer `403 disabled_in_record_only_mode` |
| `CONCLAVE_STORE_DIR` | the store the capture loop writes. Without it `/v1` answers `404 store_not_configured` |
| `CONCLAVE_RULES_FILE` | the counting rules in force, as JSON (`verifier/policy/rules.example.json` shows the form; its trusted creator is this project's own test key, an example only). Without it the leaderboard counts nothing |
| `CONCLAVE_STALE_AFTER_SECONDS` | when `/v1/status` calls the record stale (default 300; the deploy entrypoint sets twice the poll interval plus 60) |
| `RATE_API_PER_MIN`, `RATE_CHALLENGE_PER_MIN` | limits per client address |

The server imports the verifier's code (`../verifier`), so the verifier's dependencies must be installed beside it (`cd verifier && npm ci`). The record must be version 2 (written by this version's capture loop): an older record is refused with `503 store_format` rather than misread.

## Not here

TLS and a reverse proxy, more than one instance (see above), reading the rollup, and accounts or logins. A new field is a change to `schema.mjs`, the generated OpenAPI file and the tests in one commit.
