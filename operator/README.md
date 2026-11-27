# The operator: paying a visitor's devnet cost

A visitor with no wallet and no SOL can still seal a strategy: the browser makes a fresh key to own it, and this service sends that key's address a small amount of devnet SOL. It is the **only service that holds a spendable key**. The record service (`../server`, `../verifier`) stays read-only and key-less, and the two share nothing at run time.

It receives a public address and nothing else. It never sees the visitor's secret key, the strategy or the salt.

## HTTP

| | |
|---|---|
| `GET /health` | `200` whenever the process is up. The platform's deploy check |
| `GET /healthz` | `200` only when the settings are complete, the node is devnet, the key is not the program's upgrade authority, and the wallet holds at least one top-up and its fee. Otherwise `503`, naming what fails. Shows the operator's public address and balance and today's total |
| `POST /drip` | Body `{"pubkey": "..."}` and no other field. `200 {"status":"funded","signature","lamports"}` only once the cluster has confirmed the transfer, or `200 {"status":"already-funded","balanceLamports"}`. Errors are `{"error":{"code","message","retryable"}}` |

| Code | Status | Meaning |
|---|---|---|
| `bad-request`, `bad-address`, `too-large` | 400, 413, 415 | Not a request this service takes. A program-derived address or an account that is not a plain wallet is refused |
| `unauthorized` | 401 | A shared secret is set and was not given |
| `already-used` | 409 | This address was funded once and its balance is now below the threshold |
| `in-progress` | 409 | Another request for the address is running |
| `rate-limited`, `ip-limit`, `daily-cap` | 429 | A limit |
| `rpc-unavailable`, `transfer-failed`, `transfer-expired` | 502 | Try again |
| `not-ready`, `not-devnet`, `wrong-key`, `operator-empty`, `state-unwritable`, `program-unreadable` | 503 | The operator cannot send |
| `not-confirmed` | 504 | Sent, not yet confirmed. Ask again for the same address: it is not sent twice |

## It fails closed

* Nothing is sent unless the node's genesis hash is devnet's, and the key differs from the program's upgrade authority (both read from the chain).
* If the recipient's balance, the operator's balance or a blockhash cannot be read, nothing is sent. If the state file cannot be written, nothing is sent.
* Each transfer is signed and written to the volume as pending, with its signature, and its amount counted against the day, **before** it is sent. A repeat request asks the chain what became of that signature. A second transfer is possible only once the first can never land (its blockhash has expired) or has failed.
* A state file that cannot be understood is left alone and the service stops sending. A new file would forget the day's total.

## What the limits are worth

| Limit | Default | Strength |
|---|---|---|
| Daily cap, top-ups plus fees, by UTC day, kept on the volume | 0.3 SOL (29 top-ups of 0.01) | **The real backstop** |
| Sends per caller address per hour | 5 | Soft. The address is only as true as whoever reported it, addresses are cheap to change, and the count restarts with the process |
| Requests per caller address, and in all, per hour | 60, 600 | Soft; they protect the RPC key's credits |
| Once per recipient address; balance gate | | Weak against abuse: a visitor makes a fresh key for every seal. They stop repeats, not people |

Someone determined can spend the whole day's cap. What they can take is bounded by the cap, and what they can ever take is bounded by what the wallet holds, so **fund it with little and top it up**.

## The caller's address

The web app's server calls this service (`web/app/api/drip/route.ts`). It sends the visitor's address in `x-forwarded-for` and again in `x-conclave-client-ip`. **Set `OPERATOR_SHARED_SECRET` here and in the web app.** With it, only a caller that holds the secret gets any answer from `/drip`, and `x-conclave-client-ip` is believed. The second header exists because how Railway's edge treats `x-forwarded-for` is not established (`../docs/DEPLOY_RAILWAY.md`): if it rewrote it, every visitor would look like the web app's server. Without the secret, anyone who finds this service can call it directly and claim any address.

## Deploy on Railway

1. In the project, **add a new service** from the same repository. Do not add anything to the record service.
2. In the new service's settings set **Root Directory** to `operator`, and the **config file path** to `/operator/railway.json`.
3. **Attach a new volume** to it (any mount path, for example `/data`).
4. Variables: `OPERATOR_SECRET_KEY` (a JSON array of 64 numbers, or base58; mark it sealed), `OPERATOR_RPC_URL` (`https://devnet.helius-rpc.com/?api-key=...`), `OPERATOR_SHARED_SECRET` (24 characters or more, random). Use a wallet made for this and nothing else: **not the payer or upgrade key**.
5. Give it a public domain, fund the wallet with devnet SOL, and check `/healthz` answers 200. It shows the address to fund.
6. In the record service, consider setting **watch paths** so that a change under `operator/` does not redeploy, and restart, the capture loop.

One replica only: the lock on spending is inside one process.

## Settings

**Do not set the top-up below 0.0075 SOL.** A seal costs its owner 6,261,520 lamports (measured on devnet on 2026-11-27), and what is left in the new key's account must still cover that account's own rent (about 650,000 lamports at devnet's rate then) or be exactly nothing, so a smaller top-up can leave a transaction that fails part way. The default, 0.01, leaves about 0.0037 SOL in each temporary key.

See `env.example`. A top-up above 0.05 SOL is refused as a setting. The RPC URL carries its key; only its host is ever logged.

## Tests

```
npm test                     # no key, no network: settings, parsing, the state file on a real disk, and the real HTTP server
node --test test/devnet.test.mjs   # real devnet, public addresses only: every refusal before signing, and recovery of pending transfers
OPERATOR_SECRET_KEY=... OPERATOR_RPC_URL=... npm run live   # real transfers: one top-up (0.01 SOL) is spent
```

`npm run live` starts the operator on this machine with a temporary state folder, so it changes nothing on a deployed one. Its recipient is 32 random bytes that form a valid address for which no secret key exists, so **the 0.01 SOL it sends cannot be recovered** (set `LIVE_RECIPIENT` to an address of yours to keep it).
