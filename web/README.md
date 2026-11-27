# Conclave web

The browser app. So far: the entry page, the shell around it (header, footer, 404), and a placeholder at `/app`.

Next.js (App Router) and TypeScript, with hand-written CSS modules. No component library. It reads no server and needs no environment variables or keys.

## Run it

Needs Node 20.9 or later.

```
cd web
npm ci
npm run dev                  # http://localhost:3000
npm run typecheck
npm run build && npm start   # the production build
```

## Deploy to Vercel

From the dashboard: add a new project, import the repository, set **Root Directory** to `web`, keep the detected Next.js preset and its default commands, add no environment variables, and deploy.

From the command line: `cd web && npx vercel` for a preview, `npx vercel --prod` for production. In this case the project's root directory is the folder you run it from, so leave the Root Directory setting empty.

## What is where

| Path | |
|---|---|
| `app/` | Routes: the entry page, `/app`, the 404, and the global tokens in `globals.css` |
| `components/` | Header, footer, the receipt exhibit, the seal mark, and the wallet provider and panel |
| `lib/` | Typefaces and outbound links |
| `data/exhibit.json` | One real devnet receipt (below) |

## The exhibit

`data/exhibit.json` is season 81980, taken from the first final copy in `../record-snapshots/record-snapshot-latest.json` and checked against that copy's bytes and hash. It is a fixed copy, not a live read. Do not edit it by hand. The season was run by this project with its own test wallets, and the page says so.

## Design rules

* One flat theme: paper, ink, and a red that belongs to the seal alone. No gradients, blur, glow or shadows.
* Libre Caslon for the page, IBM Plex Mono for what a machine wrote. Both are served from this site.
* Motion happens once, when the entry page loads: the five bars are drawn shut and the record is stamped. With reduced motion, nothing moves.

## Wallets

Wallet adapter is provided at the root with `autoConnect` off, and nothing is gated on it. Wallets that follow the Wallet Standard are listed when the browser announces them. The only connect control is on `/app`. The RPC endpoint is the public devnet node: no keyed URL may be put in browser code.

`next.config.ts` sets `agentRules: false`. Without it, `next dev` writes an `AGENTS.md` file into this folder.
