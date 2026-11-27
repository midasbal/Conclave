# Deploying the capture daemon and the record API on Railway

One Railway service runs both, in one container, beside one volume: the capture daemon (`verifier/cli.mjs ingest`) writes the store, and the record API (`server/bin/serve.mjs`, record-only mode) reads it. They share a container because a volume can be attached to one service only. `deploy/supervisor.mjs` starts both and, if either one exits for any reason, stops the other and exits non-zero, so Railway restarts the whole unit.

**Status.** Built and tested locally. **Not yet done: the image build on Railway, and a dry run against the real RPC and the delegation-program scan.** Statements about Railway below are marked *(verified)* when they come from Railway's own documentation as read on 2026-11-27, *(staff reply)* when they come from a Railway employee's reply in the community forum, and *(unverified)* when neither.

## What is in the repository

| File | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | The image: node 22, `verifier/` and `server/` with production dependencies only, `client/layouts.mjs`, `deploy/`. Runs as root, exec-form `CMD`, so the supervisor is PID 1. **Not built here: no container tooling on the machine that wrote it.** What it copies was checked instead by running the record API from a tree containing only those paths. |
| `railway.json` | `builder: DOCKERFILE`, health check path `/health`, restart policy `ALWAYS`. Railway marks config-as-code as deprecated, with existing files working until 2027-01-01 *(verified)*, so the same settings are listed below to set in the dashboard. |
| `deploy/supervisor.mjs`, `deploy/supervise.mjs` | The entrypoint, and the generic "run these as one unit" part of it. |

## Set up

1. Create the service from this repository (root directory: the repository root). Railway uses `Dockerfile` when it is in the root directory *(unverified: not on any page read)*.
2. Add a volume to the service and mount it at `/data`. Railway exposes the mount path as `RAILWAY_VOLUME_MOUNT_PATH` *(verified)*. The store is written to `$RAILWAY_VOLUME_MOUNT_PATH/store` unless `CONCLAVE_STORE_DIR` says otherwise.
3. Set the variables below.
4. Settings, if `railway.json` is not used: builder Dockerfile; health check path `/health`; restart policy Always.

A volume is mounted as root, and Railway says to set `RAILWAY_RUN_UID=0` if the image runs as another user *(verified)*. This image already runs as root; set the variable anyway, as the platform's own statement of intent.

## Variables

| Variable | Secret? | Default | Meaning |
|---|---|---|---|
| `CONCLAVE_VERIFIER_RPC` | **yes** (carries the provider key) | none, **required** | The dedicated devnet RPC URL the daemon reads. Also used for the API's one freshness read (`getSlot`, at most once every ten seconds). The code never prints or stores the URL, only its host. |
| `RAILWAY_VOLUME_MOUNT_PATH` | no | set by Railway | Where the volume is mounted. |
| `CONCLAVE_STORE_DIR` | no | `$RAILWAY_VOLUME_MOUNT_PATH/store` | The store. Required if there is no volume. |
| `CONCLAVE_POLL_SECONDS` | no | `300` | The daemon's poll interval (minimum 30). |
| `CONCLAVE_SWEEP_MINUTES` | no | `60` | The daemon's full-sweep interval. |
| `CONCLAVE_STALE_AFTER_SECONDS` | no | `2 x poll + 60` (660) | The age after which the record counts as stale, in `/v1/status` and `/healthz`. |
| `CONCLAVE_CLIENT_IP` | no | `global` | How a caller is told apart for rate limiting. See below. |
| `RATE_API_PER_MIN`, `RATE_CHALLENGE_PER_MIN` | no | `3000`, `300` with `global` (else `300`, `30`) | The record API's limits per caller (per everybody, with `global`). |
| `CONCLAVE_RULES_FILE` | no | none | The counting rules in force, a JSON file inside the image or on the volume. Without it the leaderboard counts nothing, and says so. Which rules to run is a decision, not a default. |
| `CONCLAVE_ALLOWED_ORIGINS` | no | none | Browser origins allowed by CORS for the non-`/v1` routes (`/v1` is open to any origin). |
| `CONCLAVE_MIN_FREE_MB` | no | `64` | `/healthz` fails below this much free space on the volume. |
| `CONCLAVE_BACKUP_DIR` | no | none | Optional: a mirror folder. **On the same volume this is a consistency witness, not a backup.** Not configured here. |
| `HOST` | no | `0.0.0.0` | Where the API binds. `PORT` is injected by Railway *(verified)*. |
| `RAILWAY_RUN_UID` | no | none | Set to `0` (above). |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | no | Railway's default is 0 *(verified)* | The wait between SIGTERM and SIGKILL. Set 30 or more, so a redeploy lets a cycle in progress finish. The supervisor stops its children inside that window. |

Not set in this deployment: `CONCLAVE_AUTH_SECRET`, `CONCLAVE_RPC_UPSTREAM`, `CONCLAVE_ROLLUP_UPSTREAM`. The record-only API needs none of them, and refuses the routes that would (below). **Secrets are set in Railway's variables, never in the repository.** The supervisor passes the RPC URL to the daemon as an environment variable, never on a command line.

## Cadence and RPC credit

The daemon polls every five minutes (two `getProgramAccounts` calls: the program's receipts and the delegation program's, filtered on the receipt magic) and sweeps hourly (about one signature-history request per known receipt). We control when seasons settle, and a receipt waits on base until someone calls ReleaseBond, so a slow poll loses nothing. At the recorded size (about 75 receipts) that is roughly 3,000 requests a day. **Inferred, not measured:** if a provider charges 10 credits for each, that is under 1M a month, near a free tier's allowance, and it grows with the number of receipts. The daemon counts the requests it sends; measure a real day in the dry run before choosing a tier.

## The health endpoints

* `/health`: the HTTP server is up. Railway calls the health check path **once, when a deployment starts**, and does not monitor it afterwards *(verified)*, so `/health` is deliberately cheap and does not depend on the daemon.
* `/healthz`: **the real check, for an external monitor.** `200` only when all six hold, `503` with every check named otherwise:
  1. `store-readable`: `record.json` and `status.json` parse.
  2. `capture-loop-alive`: `status.json` was written within two poll intervals plus a minute (the loop writes its own interval into `status.json`), and the loop has not reported `stopped`.
  3. `record-fresh`: the record is younger than `CONCLAVE_STALE_AFTER_SECONDS`.
  4. `no-error-or-alarm`: the last cycle succeeded, no receipt carries a flag that is not merely informational, the backup (if any) raised no alarm.
  5. `ledger-matches-status`: the hash-chained ledger verifies, and the head `status.json` reports is the hash at that line. A ledger that is *ahead* by a few lines (appended during a running cycle) passes; one that is shorter, changed, or at a different head fails.
  6. `volume-free-space`.

  It reads files and the volume only: no RPC call, no write. `/v1/status` is unchanged: it always answers 200 and describes the trouble.

## Record-only mode

`CONCLAVE_RECORD_ONLY=1` (the supervisor sets it). The server starts with no auth secret and no upstream, serves `/v1`, `/health` and `/healthz`, and refuses everything that logs a player in or asks the chain on a caller's behalf with `403 disabled_in_record_only_mode`:

* `/auth/challenge`, `/auth/token` (login).
* `/me`, `/me/strategies`, `/me/rpc` (player routes).
* `/public/receipt/{season}`, `/public/claims/{season}`, `/public/rpc` (they call the RPC for the caller; `/public/rpc` is an open relay to the provider key).

The wallet-proof challenge under `/v1/proofs/wallet/challenges` is part of the record API and needs no secret, so it stays. Its challenges are held in memory and serve one instance (`docs/API.md`).

## Client address and the rate limit

Behind Railway's proxy every connection arrives from the proxy, so the connection's own address is useless for telling callers apart, and a header is only worth trusting if the proxy overwrites it. **I could not establish how Railway sets `X-Forwarded-For`.** Railway's page on limits, where it would be documented, returned 404. A Railway employee wrote that the edge strips `X-Forwarded-For`, that its first value is the real connecting IP, and that `X-Real-IP` is a single source of truth *(staff reply, 2026-06-12)*. In the same thread a community member wrote that the edge appends and does not strip, and a later user reported seeing only Railway and CDN addresses in it. The thread is open.

So the default is `CONCLAVE_CLIENT_IP=global`: **one bucket for every caller, and the limit raised** (3,000 a minute for `/v1`, 300 for challenges). No header can buy a caller its own bucket, so nothing can be spoofed, and nobody is throttled by their neighbours at ordinary volume. The cost: one caller who sends 3,000 requests a minute starves everyone for that minute.

To switch to per-caller limiting after the dry run (`x-real-ip` or `xff-first`), prove the proxy overwrites the header: with that mode set, send more than `RATE_API_PER_MIN` requests to `/v1/openapi.json` from one machine, each with a different made-up `X-Forwarded-For` (or `X-Real-IP`) value. If you still get `429`, the proxy replaced your header and it is safe. If you never do, the header is yours to forge: go back to `global`.

## The routes that spend RPC credit per request

Only in a full (not record-only) server. In record-only mode none of them exists.

| Route | Upstream cost of one answer |
|---|---|
| `GET /me/strategies` | two `getProgramAccounts` (the program's registries, the delegation program's) |
| `POST /me/rpc` with `getProgramAccounts` | one |

(`/me/rpc` also relays `getSignaturesForAddress` and `getTransaction`, and `/public/rpc`, `/public/receipt` and `/public/claims` make single lookups: cheap, behind the ordinary per-caller limits, not covered by the scan budget.)

They are answered from a cache (`CONCLAVE_GPA_CACHE_SECONDS`, 60), identical concurrent calls share one upstream request, and a cache **miss** is taken from the caller's own bucket (`RATE_GPA_PLAYER_PER_MIN`, 4) and from one bucket for everybody (`RATE_GPA_GLOBAL_PER_MIN`, 6, two of which one `/me/strategies` miss uses). A hit costs nothing, an upstream error is never cached, and a refusal is `429` with `Retry-After` before anything reaches the provider.

## Redeploys, restarts, and what survives

* A volume allows one deployment mounted at a time, so a redeploy has a short outage even with a health check *(verified)*.
* The daemon's data is safe across a restart: a first copy is written with a hard link that cannot replace, then its ledger line; on start any copy without a line gets one, marked `recovered`, and a torn last line is dropped.
* A killed container leaves its lock file. The lock records the process, the container (host name) and the boot, and is treated as stale when it was written by a process that is gone, by another container or boot, or carries **our own pid** (a container restarts at low pids, so the number comes round again). A live writer in this container, and a second open inside one process, are still refused. What the lock cannot do is tell a live writer in a *different* container from a dead one: that is prevented by Railway mounting the volume to one deployment at a time.
* The supervisor checks the volume before anything starts: it writes and syncs a file and makes a hard link to it (the first-copy path needs one), and fails with the reason if that cannot be done.

## What this does not cover

* **No off-platform backup.** The store lives on the volume. The committed `record-snapshots/` file is the manual cold copy, and the old store on the previous host stays untouched until you decide otherwise.
* Moving the existing store onto the volume (`store restore --snapshot` into an empty store, then `store verify`) is a separate step.
* More than one instance (the wallet-proof challenges, rate buckets and the lock all assume one).
* Whether the provider serves the delegation-program scan on its plan, and the real credit use, are the dry run's job.
