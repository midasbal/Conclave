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

## Access guards and admin recovery (Phase 1b)

One config account (PDA `["config"]`, delegated to the rollup so changes act on the next transaction) holds the authority, a pause flag and up to 8 allowed stake mints. `InitConfig` (base) can only be signed by the program's upgrade authority, checked against the ProgramData account, and that key becomes the config authority. **The authority is a single key for now; moving it to a multisig is `Admin` sub-command 4 (set authority), no program change.**

| Guard | Rule | Error |
|---|---|---|
| Pause | `Admin 0` / `Admin 1`, authority only. While paused CreateSeason and Enter are refused. Settle, Cancel, refunds, Publish, Cleanup, Lock, seeding and Advance keep working, so a pause stops new risk without trapping funds in live seasons. | 9060 paused, 9062 not the authority |
| Stake-mint allowlist | `Admin 2` / `3`, authority only, 8 mints at most. CreateSeason refuses a mint that is not listed (a mint with a freeze authority, a transfer hook, or any other surprise stays out unless the authority lists it). Finals inherit the season's mint. | 9061 not allowed, 9064 list full |
| Config integrity | The config must be this program's PDA with the config magic; a copy at another address is refused. | 9063 |
| RecoverBond | Authority only, in the rollup. Acts only on a receipt that is not closed, whose season header was written by Settle or Cancel, whose season id matches, and whose arena no longer exists. It moves no lamports: it marks the receipt closed with the whole bond releasable, and the existing `ReleaseBond` then pays the creator recorded on the receipt. A live arena, a fresh or merely opened receipt, a closed receipt, a mismatched arena or receipt are all refused. The authority can never receive the bond. | 9070 |

Not done: reclaiming the sealed-strategy accounts a failed or cancelled season leaves in the rollup (about 19,744 lamports each). It needs an entered-season marker on the strategy (Enter would have to write it) so a strategy still needed for Publish is never closed, plus a close path verified on the rollup; that is a design change, not a cheap addition. The hub stays short by that amount per strategy ever sealed.

Large fields: devnet season with 20 entrants, 3 published inline by Settle and 17 through Publish, `client/bigfield.mjs`. One Commit of a receipt plus 16 registries is rejected by the Magic program (observed), so commit registries in chunks of 4.
