# Conclave server: session auth and key-safe RPC access

Foundation for the browser app (Phase 7): the auth and access primitives, not a UI. Nothing here changes the on-chain program.

## What it replaces

The old client put the rollup (TEE) token in the query string of every rollup URL. Credentials in a URL leak through server and proxy logs, `Referer` headers and browser history. Observed on this repo, and fixed:

| Where | Before | Now |
|---|---|---|
| `client/flows.mjs` (every rollup call) | the 30-day token in the URL query string | `Endpoint` object: bare URL plus `Authorization: Bearer` header; the token is non-enumerable and never prints (`client/endpoint.mjs`) |
| TEE auth challenge (`GET /auth/challenge?pubkey=`) | pubkey in a query string | unchanged, it is MagicBlock's endpoint; it carries a public key only, not a secret |
| RPC and indexer keys | no provider key exists in the repo yet | server-side only (below); a test fails the build if one appears |
| Logs and evidence | no token in any evidence file (checked) | server logs carry method, path, status and a pubkey prefix only |

Also observed: the real TEE honors `Authorization: Bearer` for private reads (owner token returns the sealed strategy, another player's token or no credential returns nothing), and its tokens live 30 days, set by the TEE.

## The session token

A player proves control of a wallet by signing a message. No password, no gas (a message signature is not a transaction).

1. `POST /auth/challenge {pubkey}` returns `{message, nonce, issued, expires, audience}`. The server stores the nonce against that pubkey.
2. The wallet signs the UTF-8 bytes of `message` (ed25519, wallet `signMessage`).
3. `POST /auth/token {pubkey, nonce, signature}` (signature base58). The server rebuilds the message from its own record, verifies, burns the nonce, returns `{token, tokenType: "Bearer", issuedAt, expiresAt, ttl}`.
4. Gated requests send `Authorization: Bearer <token>`.

The signed message (LF line endings, no trailing newline):

```
CNCL-AUTH-v1
audience: <audience>
pubkey: <base58 player pubkey>
nonce: <64 hex chars>
issued: <unix seconds>
expires: <unix seconds>
```

- Domain separation: the first line is a constant; this signature is not a valid transaction and a signature made for another protocol is not a valid login.
- Binding: audience (one service), pubkey (one player), nonce (one use), expiry (a time limit). The client cannot choose any of them: the server rebuilds the message.
- Replay: a nonce is redeemed once, atomically, and is burned on the first attempt even if the signature is wrong; challenges live 120 s.
- Token: `v1.<payload>.<mac>`, payload `{v, sub, aud, iat, exp, jti}`, mac = HMAC-SHA256 under a server secret with a domain tag. Bound to `sub`; every gated route takes identity from the token and nowhere else.
- TTL: 900 s (15 minutes). The client (`client/session.mjs`) renews by signing a new challenge when fewer than 30 s remain, or once after a 401 `token_expired`; concurrent callers share one login. The client also refuses to sign any message that is not exactly this format for its own pubkey and audience with a validity of at most 10 minutes.
- Tokens are never accepted in a URL: any request carrying `token`, `access_token`, `key`, `api_key`, `jwt`, `auth`, `sig` and similar parameters gets 400 before anything else happens.

## Gated versus open

| Route | Access | Notes |
|---|---|---|
| `GET /health`, `POST /auth/challenge`, `POST /auth/token` | open | auth routes limited per client address |
| `GET /public/receipt/:season` | open | coarse view: kind, state, finals status, amount owed in total, entrants, published, per-entry id, final rank, season rank (receipts of the previous build show rank and wins). No commitments |
| `GET /public/claims/:season` | open | owed versus claimed per entry slot (receipt order), read from the rollup (`CONCLAVE_ROLLUP_UPSTREAM`; 404 without it). No wallet addresses. The account closes once everything is claimed, and then this route answers 404 |
| `POST /public/rpc` | open | `getSlot`, `getLatestBlockhash`, `getAccountInfo`, `getMultipleAccounts`; limited per client address |
| `GET /me` | token | the token's pubkey and expiry |
| `GET /me/strategies` | token | the player's registries, base and delegated (the keyed `getProgramAccounts` query runs server-side) |
| `POST /me/rpc` | token | wider allowlist (adds `getProgramAccounts` for this program only, `getTransaction`, `getSignaturesForAddress`, `simulateTransaction`, `sendTransaction`, ...); limited per pubkey |

Private reads through the TEE (a player's sealed strategy) go from the client straight to the TEE with the TEE token in an `Authorization` header. The TEE needs no API key, so there is nothing for a proxy to hide; a server-side TEE proxy is not built.

## RPC and indexer keys

The upstream URL (which may embed a provider key) and the token secret come from the environment or `*_FILE` paths (`server/env.example`), never from the repo and never from a client-visible URL. The server never echoes the upstream URL (failures return a bare 502), never forwards the player's `Authorization` header, and per-pubkey token buckets protect the key from one player. `CONCLAVE_RPC_UPSTREAM` is the only place a key lives.

## Tests

`cd server && npm test` (CI job `server-and-auth`): 20 tests with real ed25519 keys and real HMAC. They cover the exact message, signature rejection (wrong key, altered message, wrong pubkey, foreign protocol), replay including two concurrent redemptions, challenge expiry, session expiry with the client re-signing, forged and edited tokens, wrong audience, identity-from-token, gating, credentials-in-URL refusal, method allowlists, per-pubkey and per-address rate limits, upstream-key hygiene in responses and logs, headers and CORS, and a static scan that fails the build if any file puts a credential in a URL or commits key material. `server/test/live.mjs` is the manual live check with real player keys against devnet and the real TEE.

The upstream in the CI tests is a local HTTP server that returns fixed JSON-RPC answers and records what it receives; nothing about the auth is stubbed.

## Deferred

- Shared state: the nonce store and rate-limit buckets are in memory, so one process only. Several instances need a shared store (Redis or similar); the interfaces are small.
- No revocation list: a stolen token is good for at most 15 minutes. A `jti` deny list is the next step if that is not enough.
- Not deployed anywhere: `bin/serve.mjs` runs locally. TLS, a reverse proxy, `CONCLAVE_TRUST_PROXY` behind it, and secret rotation are deployment work.
- The browser wallet adapter glue (Phase 7): `Session` takes any `signMessage(bytes)`.
- The TEE's own 30-day token cannot be shortened by us; keep it in memory only.
