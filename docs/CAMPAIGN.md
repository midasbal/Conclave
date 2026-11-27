# A field of authored strategies through a real season

`node client/campaign.mjs` takes six strategies written in the 2a source format (`momentum`, `calm_trend`, `ema_cross`, `mean_reversion`, `quick_fade`, `trend_stop`; work 4 to 31, all within division 32), seals each through the 2b flow (reusing one already sealed from the same source and owner), and runs them through one real season on devnet using only the Phase 1 flows: InitReceipt, InitPool, CreateSeason, Enter, Lock, RequestSeed (VRF), Advance, Settle with inline publish, Claim (one per paid entry), Commit, CloseClaims, Cleanup, undelegate and ReleaseBond. The season is never cancelled and has no finals. (Any devnet figures recorded for this campaign come from the previous build, which paid inside Settle; it has not yet been re-run on the pull-payout build.)

## What it shows, and how

| Claim | Check |
|---|---|
| One field, one division | every strategy's work is at most 32; no two share bytecode; the season is a division-32 arena that accepted all six at Enter |
| The author's pre-seal view and the chain are one VM | the bytes assembled from source, the bytes the forecast ran, and the bytes sealed and run on chain are the same; the season's on-chain totals equal a replay by the WASM build of `conclave-vm` using the season's own seed words (read from the receipt), bit for bit |
| Ranks are the scores | for every entrant: on-chain total = local replay total; published rank = the rank that total earns (descending, ties to the earlier entry); the owner's private record carries the same rank; in rank order the scores never increase; the local replay alone, with no chain data, gives the same ranking |
| Skill, not luck | the same field is run over 300 seasons by the same VM from a fixed seed stream. The check is that the long-run order is reproducible (two disjoint halves of those seasons agree, Spearman above 0.5). The realised season's correlation with that order, and its percentile among the simulated seasons, are printed as information and are not a pass or fail: one season is one noisy draw, and for the example field about a quarter of draws fall at or below 0.5 with nothing wrong |
| Receipt is clean | every code commitment equals the public registry's and opens under the owner's salt; every entry has a score commitment equal to the hash, under the season's derived score salt, of (season, id, season total, finals total, episodes, finals episodes) and not the unsalted hash of its totals; no entrant's code, salt, code window or unsalted code hash appears in the receipt; the public coarse view (`server/src/receipt.mjs`) lists id, final rank and season rank per entry |
| Owed equals claimed | each entry is owed exactly the prize of its final rank, the amounts sum to the pot, and after the claims the claimed total equals the owed total |
| Payouts exact and solvent | each owner is debited exactly fee x its entries; the prizes are 50/30/20 of the pot with the remainder on the last paid rank; each owner is credited exactly the prizes of its entries' ranks; paid out equals paid in; net changes sum to zero |
| Lifecycle closes cleanly | Cleanup returns the arena rent exactly (hub before CreateSeason equals hub after Cleanup); the creator bond is released in full, nothing forfeited |

The checks are pure functions in `client/campaign_lib.mjs`, tested offline with corrupted inputs in `tests/campaign.test.mjs` (CI: `tests/author.sh`).

## Limits

- **The pool's own balance cannot be read by anyone but the program** (no one can authenticate as the pool address, and its ATA address does not exist as a readable account inside the rollup; the eSPL record reads 0 throughout). Solvency is therefore shown from the owners' observed balances, plus the program's own assertions: at Settle (bookkeeping equals fee x entrants, the pool holds the pot, amounts owed equal the pot) and at every Claim (the pool covers everything unclaimed).
- Season totals are owner-private on chain (only salted commitments are public). This script prints them for its example strategies on purpose; do not do that for strategies you want kept private.
- Absolute scores move with the season's two world packs and move all entrants together; ranks compare entrants in the same worlds. A field whose top entrants are statistically close will reshuffle them from season to season (see the stability table).
