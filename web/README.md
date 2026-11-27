# Conclave web

The browser app. So far: the entry page, the shell around it (header, footer, 404), and a spectator view of the public record at `/app`.

Next.js (App Router) and TypeScript, with hand-written CSS modules. No component library. It holds no keys. `/app` reads the record API (`../docs/API.md`) from the server.

## Run it

Needs Node 20.9 or later.

```
cd web
npm ci
cp .env.example .env.local   # then set CONCLAVE_API_URL (below)
npm run dev                  # http://localhost:3000
npm run typecheck
npm run build && npm start   # the production build
```

## Environment

| Variable | |
|---|---|
| `CONCLAVE_API_URL` | The base address of the record API, without `/v1` (a trailing `/v1` is tolerated), for example the Railway service's public address. Read on the server only: it has no `NEXT_PUBLIC_` prefix, so it never reaches a browser. Unset, `/app` says the record is not connected; the entry page does not use it |

To try it without a deployed service, run the API over a local store from the repository root and point the app at it:

```
CONCLAVE_RECORD_ONLY=1 CONCLAVE_STORE_DIR=/path/to/store HOST=127.0.0.1 PORT=8791 node server/bin/serve.mjs
CONCLAVE_API_URL=http://127.0.0.1:8791 npm run dev
```

## Reading the record

`/app` lists seasons and `/app/season/<number>` shows one receipt. Both are rendered per request. Each API address is read at most once a minute (`REVALIDATE_SECONDS` in `lib/record.ts`), and only successful answers are cached. If a refresh fails, the last good answer keeps being served; pages show when the record was built and say so when it is more than 20 minutes old. With nothing cached and no usable answer, the page says what is wrong and shows no sample data. The list asks for the API's largest page, 200 seasons, and says when there are more.

## Deploy to Vercel

From the dashboard: add a new project, import the repository, set **Root Directory** to `web`, and keep the detected Next.js preset and its default commands. Under **Settings, Environment Variables** add `CONCLAVE_API_URL` for Production (and Preview if previews should show the record), then deploy. A change to a variable applies to the next deployment, so redeploy after changing it.

From the command line: `cd web && npx vercel env add CONCLAVE_API_URL production`, then `npx vercel` for a preview or `npx vercel --prod` for production. In this case the project's root directory is the folder you run it from, so leave the Root Directory setting empty.

## What is where

| Path | |
|---|---|
| `app/` | Routes: the entry page, `/app`, `/app/season/[season]`, the not-found pages, and the global tokens in `globals.css` |
| `components/` | Header, footer, the receipt sheet (shared by the exhibit and the season pages), the seal mark, motion, and the wallet provider and menu |
| `lib/` | Typefaces, outbound links, the server-side record reader and its types, and the record's codes in words |
| `data/exhibit.json` | One real devnet receipt (below) |

## The exhibit

`data/exhibit.json` is season 81980, taken from the first final copy in `../record-snapshots/record-snapshot-latest.json` and checked against that copy's bytes and hash. It is a fixed copy, not a live read. Do not edit it by hand. The season was run by this project with its own test wallets, and the page says so.

## Design rules

* One flat theme: warm grey paper, soft ink, and a red that belongs to the seal alone. Text pairs hold at least 5.9:1. No gradients, blur, glow or shadows.
* Libre Caslon for the page, IBM Plex Mono for what a machine wrote. Both are served from this site.
* One large motion: when the exhibit is first on screen it is sealed, over about three seconds (`components/ReceiptSheet.module.css`). Sections of the entry page enter once as they are scrolled to; links, rows and the Enter button answer pointer and keyboard. With reduced motion nothing moves. Without JavaScript, or if it fails to load, everything is shown at once.

## Wallets

Wallet adapter is provided at the root with `autoConnect` off, and nothing is gated on it. Wallets that follow the Wallet Standard are listed when the browser announces them. One Connect action sits in the header inside `/app` and opens a menu of the wallets found. It gates nothing. The RPC endpoint is the public devnet node: no keyed URL may be put in browser code.

`next.config.ts` sets `agentRules: false`. Without it, `next dev` writes an `AGENTS.md` file into this folder.
