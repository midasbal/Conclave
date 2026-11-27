# Campaign: authored strategies through a real season

`node client/campaign.mjs` (needs the project's keys, the WASM author module and a funded payer) takes six strategies from `strategies/` (work 4 to 31, all within division 32), seals each (reusing one already sealed from the same source and owner), and runs them through one live devnet season with no finals, from InitReceipt to ReleaseBond. It is an end-to-end check that authoring, chain and payouts agree.

| It checks | How |
|---|---|
| The forecast and the chain are one VM | the same bytes are assembled, forecast, sealed and run; on-chain totals equal a WASM replay of `conclave-vm` on the receipt's seed words, bit for bit |
| Ranks follow scores | on-chain total, local replay, published rank (descending, ties to the earlier entry) and the owner's private record agree; the replay alone gives the same ranking |
| The field's order is stable | 300 simulated seasons from a fixed seed stream: the mean-rank orders of two disjoint halves agree (Spearman above 0.5). The live season's own correlation with that order is printed, not asserted: for this field about a quarter of single seasons fall at or below 0.5 with nothing wrong |
| The receipt leaks nothing | commitments match the registry and open under the owner's salt; score commitments are salted per season; no code, salt or unsalted code hash appears; the public coarse view lists ids and ranks only |
| Money is exact | each entry is owed its final rank's prize (50/30/20, remainder to the last paid rank); amounts sum to the pot and equal the claims; each owner's net change is exactly fees against prizes |
| The lifecycle closes | the arena's rent returns to the hub and the whole creator bond is released |

The checks are pure functions in `client/campaign_lib.mjs`, tested offline with corrupted inputs in `tests/campaign.test.mjs`.

**Last live run:** 2026-11-26, 57 of 57, after a run at 56 of 57. The failure was an earlier ranking check that asserted one season's correlation, since replaced by the stability check above. The current script has not been run live, and neither run used the current program build.

## Limits

* The pool's token balance cannot be read by anyone but the program, so solvency is shown from the owners' balances and the program's own assertions at Settle and at each Claim.
* Season totals are owner-private on chain. This script prints them for its example strategies on purpose. Do not do that with strategies you want kept private.
* Absolute scores move with the season's two world packs. A field whose leaders are statistically close will reorder from season to season.
