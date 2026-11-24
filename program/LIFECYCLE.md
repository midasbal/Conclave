# Season lifecycle and money safety (Phase 1a)

```
InitReceipt (base, bond) -> CreateSeason -> Enter... -> Lock -> RequestSeed -> Advance... -> Settle (+inline publish) -> Cleanup -> Commit+undelegate -> ReleaseBond (base)
                                                \-> Cancel (refund) -> Cleanup -> ...                       (seed timeout, under-minimum, creator, voided finals)
```

| Guard | Rule | Error |
|---|---|---|
| Entry window | `CreateSeason` records window, seed timeout, publish grace (slots) and a minimum entrant count. Enter is refused once the window has elapsed. | 9030 |
| Lock | The creator may lock any time. Anyone may lock after the window. A field below the minimum is cancelled by Lock, not run; the creator cannot cancel early this way. | 9031 under-filled before the window, 9032 stranger inside the window |
| Cancel | Creator while unlocked; anyone once locked and unseeded past the seed timeout; anyone once an under-minimum Lock cancelled it. Never once seeded. Refunds each entry fee exactly, once. A voided finals pays the reserve to the parent champion. A seed arriving after a cancel is refused. | 9033, 9034 (second refund) |
| Creation bond | `InitReceipt` posts a bond (>= 1,000,000 lamports) held in the season receipt; a receipt opens exactly one arena and only for the wallet that funded it. | 9050, 9051, 9052, 9053 |
| Hub accounting | CreateSeason and StartFinals measure the rent drawn from the shared hub. Cleanup measures what the close returned and tops the hub up from the bond for any shortfall. 25% of the bond is forfeited to the hub when a season is abandoned (under-minimum or creator cancel). The rest is releasable. | |
| Bond release | After Cleanup the receipt is committed and undelegated (only receipts in the closed state are accepted) and `ReleaseBond` on base pays the creator exactly once. | 9054, 9055 |
| Force publish | Settle publishes every entry whose strategy and registry accounts are appended. A transaction holds 9 entrants publishing inline at most (observed in `tests/svm/tests/money.rs`), so larger fields publish the rest with Publish. Cleanup no longer waits forever: past the publish grace an unpublished entry cannot block it. | |
| Solvency | Settle refuses unless pool bookkeeping equals fee x entrants exactly (9040) and the pool token account holds at least what is owed (9041); payouts must sum to the pot (9042). The balance check is `>=`, not `==`, because anyone can donate tokens to a pool address and an equality check would let them block settlement. Cancel applies the same checks. | 9040, 9041, 9042 |

Tests: `tests/svm/tests/money.rs` (10 tests), plus the existing lifecycle, edge, reject, meter and fuzz suites. Devnet: `client/lifecycle.mjs cancel|undermin|midsetup|leaked|recover`, `client/season.mjs` (happy path with finals), `client/canary.mjs`.

Known limits: sealed strategy accounts (about 19,744 lamports each) stay in the rollup and are not returned; a cleaner is not paid a bounty; seasons created by the pre-1a binary have no bond state and their bond cannot be released.
