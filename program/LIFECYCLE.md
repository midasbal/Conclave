# Season lifecycle and money safety (v2: pull payouts, two-phase finals)

```
InitReceipt (base, bond) -> CreateSeason -> Enter... -> Lock -> RequestSeed -> Advance...            season phase
   finals on, 2+ entrants: (Advance moves the arena into the finals by itself) -> RequestSeed -> Advance...   finals phase
   -> Settle (+inline publish): RECORDS what each entry is owed -> Claim (per entry) -> CloseClaims
   -> Publish... -> Cleanup -> Commit+undelegate -> ReleaseBond (base)
   Cancel (RECORDS refunds) -> Claim -> CloseClaims, Cleanup      (seed timeout, season deadline, under-minimum, creator)
   later, by the owner, when no entry is open: CloseStrategy -> Commit+undelegate the registry -> CloseRegistry (base)
```

Slot figures below use about 103.5 rollup slots per second, observed on devnet on 2026-11-26. Deadlines are counted in slots, so a change in the rollup's slot rate changes their length in time.

## Bounds, fixed at CreateSeason

| Parameter | Range | Error |
|---|---|---|
| Season episodes | 1 to 100 | 9100 |
| Season episodes **with finals** | at least 15, the finals length, so the season weighs at least as much as the finals | 9104 |
| Slots per tick (the pace, used by both phases) | 1 to 100 | 9101 |
| Paced run of **both phases**, (season episodes + 15 if finals) x 150 x slots per tick | at most 720,000 slots (about 116 minutes). With finals at pace 100 that is at most 33 season episodes; at 100 season episodes the pace is at most 41 | 9102 |
| Flags | only the finals bit (value 2) | 9103 |
| Entry window (how long buy-ins can wait before anyone may Lock) | 1 to 25,000,000 slots (about 2.8 days) | 9035 |
| Season seed timeout (after Lock) | 1 to 1,000,000 slots (about 2.7 hours) | 9035 |
| Finals seed timeout | fixed at 360,000 slots, nobody's choice | |
| Publish grace | at least 180,000 slots (about 29 minutes), so an unpublished result cannot be dropped right after Settle; at most 200,000,000. It delays only the arena cleanup (hub rent and the creator's own bond), never an entrant's money | 9105 below the floor, 9035 above the cap |

**Longest possible wait for a buy-in.** Entry window + seed timeout + season deadline + finals seed timeout + finals deadline is under 3.5 days at 103.5 slots per second for every combination the bounds allow (`tests/svm/tests/money.rs` computes the maximum). Each of those steps ends in a permissionless exit, so after it anyone can move the season on; the money then waits only to be claimed. A creator who sets the longest waits and disappears still cannot keep a buy-in: anyone locks at the end of the window and anyone cancels at the end of the seed timeout.

## Deadlines, calculated by the program

`phase_deadline(start, episodes, spt) = start + ticks x spt + 360,000 + ticks x 40`, with `ticks = episodes x 150` and `start` the slot the phase's seed arrived.

* `ticks x spt` is the earliest the clock gate lets the phase finish.
* `ticks x 40` is four times what one sequential cranker needs in the worst case (20 seats at the work cap: 7.9 ticks per Advance, measured in `tests/svm/tests/meter.rs`; about 78 slots per Advance, from past devnet drive times).
* `360,000` (about 58 minutes) absorbs an outage.
* Season phase: from 366,150 slots (1 episode, pace 1) to at most 1,680,000 slots (about 4.5 hours).
* Finals phase (15 episodes, the season's pace): 452,250 to 675,000 slots (73 to 109 minutes).
* Finals seed: must arrive within 360,000 slots of the end of the season phase.

From the deadline slot on, Advance refuses (9113). A season phase that finished before its deadline stays finished; finals that finished before theirs count however late Settle is called. So the outcome is decided by the clock, and nobody can choose between finishing a phase and the fallback. A seed that arrives at or after its timeout is refused (9112).

| State | Permissionless exit |
|---|---|
| Open, unlocked | after the entry window anyone may Lock (the creator may cancel while unlocked) |
| Locked, no seed | Cancel after the seed timeout (reason 2) |
| Season phase running | Advance until done; at the season deadline anyone Cancels and everyone is refundable (reason 7) |
| Waiting for the finals seed | at 360,000 slots anyone Settles, finals void (reason 4) |
| Finals running | Advance until done; at the finals deadline anyone Settles, finals void (reason 5) |
| Season phase finished | never refundable (Cancel answers 9033) |

## Finals

The only choice is whether a season has finals, made at CreateSeason. The format is fixed: 15 episodes, the top 3 by season rank qualify (both with two entrants).

* **Transition.** The Advance call that finishes the season phase freezes the season ranks (season total descending, ties to the earlier entry), marks the qualifiers and puts the arena in the finals phase. No instruction starts the finals. VRF needs its own transaction, so someone (anyone) sends RequestSeed once more; if nobody does, the finals seed timeout voids the finals.
* **Run.** Same arena, same sealed bytecode, no re-submission. A fresh VRF seed through a separate callback (so a season-phase answer can never seed the finals) and packs drawn again from that seed (they can coincide with the season's by chance). Only qualifiers run.
* **Result.** The top 3 are ordered by season total plus finals total, ties to the better season rank. Everyone else keeps the season rank. 50/30/20 of the whole pot follows the final ranks (60/40 with two entrants, 100 with one), remainder on the last paid rank.
* **Void** (reason 4 seed timeout, 5 deadline, 6 fewer than two qualifiers): the whole pot follows the frozen season ranks, partial finals scores are zeroed, and the receipt is marked voided.
* **What the cushion is worth.** The season total is carried in as a lead. Its weight against 15 finals episodes depends on the season length the creator chose.

## Pull payouts and the claims account

Settle and Cancel move no tokens and name no entrant's token account. They write what each entry is owed into the season's **claims account** (PDA `["claims", season]`, ephemeral, no permission account so that it is public, rent drawn from the hub at CreateSeason so recording can never fail for want of hub funds).

| Instruction | Rule |
|---|---|
| Claim (tag 22) `[claims, pool, pool_ata, owner_ata, token_program]`, data: slot | Anyone. Pays that entry's amount to its owner's associated token account, once. A claim with nothing left to pay succeeds and moves nothing. No config account is read, so pause cannot block it. No expiry. |
| CloseClaims (tag 23) `[crank, hub, claims, vault, magic]` | Anyone, only when every recorded amount is paid (9083). Returns the claims rent to the hub. |

On-chain solvency assertions:

* At record (Settle and Cancel): pool bookkeeping equals fee x entrants (9040), the pool token account holds at least the pot (9041; `>=` so a donation cannot block a season), and the amounts owed sum to the pot (9042).
* At every Claim: the amount is no larger than everything still unclaimed (9042) and the pool holds **everything** still unclaimed (9041), so a short pool cannot be drained by whoever claims first.

An entrant whose token account cannot be paid (closed, or withdrawn from the rollup) delays only its own claim. The arena and the creator's bond close without waiting for claims. A client must send one claim per transaction.

**The no-expiry tradeoff.** There is no deadline for claiming and no way to sweep an unclaimed amount. CloseClaims refuses (9083) unless every entry is marked paid **and** the claimed total equals the owed total, so it can never close over somebody's money. The price: an entrant who never claims, or never makes the token account payable again, keeps that season's claims account alive, with its hub rent, and keeps that amount in the season's pool for as long as they like. It costs the hub that rent and costs nobody else anything: other seasons have their own pools and claims accounts, and every other entrant of this one is unaffected. Because anyone can send a claim, this needs the entrant to keep their own account unpayable; simply doing nothing does not delay a payment once somebody cranks it. We chose this over an expiry because an expiry would turn a delay into a loss.

## Publish

Each (season, entry) is published at most once: the mark is in that season's arena slot and receipt entry (9120), so publishing a strategy in another season never reopens an earlier one, and the publish counters cannot exceed the number of entries. Cleanup checks every entry's own mark and refuses inside the grace while any is unpublished (9123). The registry records the **final** rank and adds the **season-phase** total.

The score commitment is `sha256("CNCL-SCORE-v2", salt, season, id, season_total, finals_total, episodes, finals_episodes)`; the last two finals fields are zero for an entry that did not play the finals. The owner's sealed record holds the final rank, the season total and, for strategies sealed since this build, the finals total (older sealed accounts are 8 bytes shorter, stay usable, and their owners get the finals total by replaying the finals seed).

## Strategy reclaim and the open-entry guard

**Deployed on devnet** (see Observed on devnet).

**Who pays.** The hub pays each sealed strategy's rent at Seal (20,000 lamports; 19,744 at the old size). An owner cannot pay it from their own wallet: the rollup refuses to debit an account that is not delegated to it. Observed on the devnet TEE by simulation (a 1 lamport debit of an owner wallet answers `Immutable`, a 0 lamport one succeeds); the validator engine source and MagicBlock's documentation say the same. A rent purse per owner (a delegated program account) could be built but would add custody and four or five new steps. So the hub pays and gets the rent back when the strategy is closed. **A strategy that is never closed keeps the hub's rent.**

**The counter.** Two bytes of the sealed account that no earlier build ever wrote (offsets 6 and 7) hold the number of open entries. An arena slot that holds one unit of that count carries a bit (4).

| Path | Effect |
|---|---|
| Enter | count + 1 and sets the slot's bit (Enter takes the strategy writable, and the strategy's registry writable: see below) |
| Publish, separate or inline at Settle | count - 1 for that slot |
| Cancel | releases every strategy named after its fixed accounts. Naming them is optional: a refund never depends on a strategy account |
| Cleanup | releases every strategy named after the receipt, and refuses (9131) while any slot still holds a unit, because the arena is the only record of it |

The count moves down only where the slot's bit is set, and the bit is cleared with it. So nothing releases twice, and entries made by an earlier build (no bit) never take a unit that a newer season holds.

**Which strategies to name.** The arena is private, so a client works from what it knows. The receipt lists every entry id after Settle or Cancel and marks the published ones. For a settled season name the unpublished entries. Send Cancel with all of the season's strategies, and Cleanup then needs none. Do not name a strategy its owner has already closed.

**CloseStrategy** (tag 24, in the rollup, the owner signs; works while paused): refused while the count is not zero (9130). It wipes and closes the sealed account and its permission, with the rent going to the hub, and marks the registry closed. A closed registry is refused by Seal, Publish and Delegate. Then `Commit` with undelegate (now also accepts a closed registry, still refuses a live one, 9055) and **CloseRegistry** (tag 25, base, anyone may send it) which removes the account and pays all its lamports to the owner recorded on it, who paid them at Register (9132 otherwise). That return is the owner's reason to close.

**What the guard does not do.**

* It does not force publication. If nobody publishes an entry before the grace ends, Cleanup still drops that publication and releases the count. The grace is at least 180,000 slots (9105), which is the least time anyone, Publish being permissionless, has to publish it first.
* Closing removes the registry and with it the career figures (seasons, best rank, total). Each season's receipt keeps the strategy id, final rank, season rank and, for published entries, both commitments.
* After CloseRegistry the id is free: anyone, the same owner included, can Register it again with empty figures. Anything that reads a record by id must also check the commitment, and for a person's history the owner at that time.
* A registry that was never delegated to this rollup cannot be marked closed there, so such a strategy cannot be closed until its owner delegates the registry.
* A registry that is registered but never sealed has no close instruction, so what its owner paid at Register stays in it.

**Only a publishable strategy may enter.** Publish writes the registry, and Seal only reads it, so an owner who registers and never delegates can still seal (observed). Enter therefore takes the strategy's own registry and requires it **writable** (9133: read-only, another registry, a closed one, or one naming another owner). The program cannot see whether an account is delegated. The rule that makes this a guard is the rollup's: it refuses any transaction that marks writable an account it does not hold, even when nothing changes it (observed on the devnet TEE, by simulation and then with real transactions: `InvalidWritableAccount`). A delegated registry stays delegated until its owner closes the strategy, which an open entry forbids, so an entry that got in can always be published.

**Upgrading to this build.** No account changes size and the arena magic is unchanged. Old strategies read a count of zero. Seasons opened by the previous build can still publish, cancel and clean up, and never decrement anything; a strategy entered only in such a season is NOT protected by the counter, so deploy with no season open. A client whose Enter does not pass the strategy and its registry writable stops working, and so does one that asks for a grace under 180,000 slots.

**Done on devnet on 2026-11-26** (build sha256 `0ea300bf...`, 504,536 bytes, program data extended by 12,648 bytes, on-chain bytes equal to the artifact). Every receipt of a build that requires one was closed beforehand, so no season was open.

## Randomness queue

RequestSeed accepts only `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` (9110). The previous build accepted any queue the VRF program accepted, including delegated queues that showed no activity.

**Residual trust.** The program relies on the oracle that serves this queue staying online and delivering honestly. It cannot force a delivery. We assume the oracle knows a value before it delivers it, so it could withhold one it dislikes: in the season phase that ends in refunds, in the finals it ends in a void, which pays by season rank and so favours the season leader. We have not reviewed the VRF program's proof verification. The queue is shared with other applications; we have not tested whether it can be filled. If the queue is retired, the program needs an upgrade.

## Other guards

| Guard | Rule | Error |
|---|---|---|
| Entry window, Lock | As before: Enter is refused after the window; the creator may lock any time, anyone after the window; Lock cancels an under-minimum field | 9030, 9031, 9032 |
| Cancel | Creator while unlocked; anyone for an unseeded season past the seed timeout, a season phase past its deadline, or after an under-minimum Lock; once only | 9033, 9034 |
| Creation bond | `InitReceipt` posts a bond held in the season receipt; a receipt opens exactly one arena | 9050 to 9053 |
| Hub accounting | The arena's rent is measured at CreateSeason and topped up from the bond at Cleanup if the close returns less. The claims account's rent is measured separately and does not touch the bond. 25% of the bond is forfeited when a season is abandoned (under-minimum or creator cancel). A void or a missed deadline forfeits nothing | |
| Bond release | After Cleanup: commit and undelegate the receipt, then `ReleaseBond` on base | 9054, 9055 |

## Error codes added or changed

| Code | Meaning |
|---|---|
| 9080 | nothing recorded yet (Claim, CloseClaims) |
| 9081 | claim slot out of range |
| 9082 | claims account invalid or not this season's |
| 9083 | amounts still outstanding |
| 9084 | claim destination is not the entry owner's token account |
| 9085 | amounts already recorded |
| 9100 to 9103 | creation bounds (table above) |
| 9110 | not the pinned VRF queue |
| 9111 | no seed can be requested in this state |
| 9112 | seed arrived after its timeout |
| 9113 | phase deadline passed |
| 9114 | nothing to advance |
| 9115 | not ready to settle |
| 9116 | already settled or cancelled |
| 9120 | this entry is already published for this season |
| 9121 | publish before Settle |
| 9122 | cleanup before the season is settled, or cancelled and recorded |
| 9123 | unpublished entries inside the grace |
| 9130 | the strategy has an open entry and cannot be closed |
| 9131 | Cleanup was not given the strategy of an entry that is still counted |
| 9132 | not a closed registry of this owner (CloseRegistry) |
| 9133 | Enter was not given the strategy's own open registry, writable |
| 9105 | publish grace under 180,000 slots |

Instruction tag 14 (the old StartFinals) is retired and answers InvalidInstructionData.

## Account layouts

* **Arena** (size unchanged, magic changed to `ARN3` so the new build refuses old arenas). Header: finals seed at 1112 (32 bytes), flags2 at 1144, published count at 1145, season-phase end slot at 1272. Slot (440 bytes, unchanged): season rank u8 at 42, bits at 43 (1 finalist, 2 published), final rank at 44, season total at 48, finals total at 56. Flags: 1 locked, 2 seed requested, 4 seeded, 8 done, 16 settled, 32 season phase done, 64 finals seed requested, 128 finals seeded.
* **Claims** (new): 72-byte header (state, entry count, capacity, kind, season, mint, owed total, claimed total, rent) plus 48 bytes per seat (owner, owed, done).
* **Receipt** (1792 to 1824 bytes). Header grows from 192 to 224: finals seed words, finals packs, finals status, qualifier count, finals episodes, total owed. Entry: final rank at 72, season rank at 76, published at 78, finalist at 79.
* **Sealed strategy** (396 to 404 bytes): the finals total is appended. 396-byte accounts remain valid.

## Upgrading from the previous build

1. Deploy only with **no season open**: every arena must be settled or cancelled and cleaned up. An old arena left open would be refused by the new build, with its money in it.
2. Closed receipts of the old size can still be committed, undelegated, recovered and released: the money fields did not move.
3. Old clients stop working (CreateSeason, Settle and Cancel take different accounts; StartFinals is gone).

**Done on devnet on 2026-11-26** (build sha256 `928fe971...`, 491,888 bytes, program data extended by 12,592 bytes, on-chain bytes equal to the artifact). Before it, one old season was still open: a fee-0 metering arena from 2026-11-24, created before receipts existed, so a receipt scan could not see it; probing the season numbers in the logs found it. It was closed with the old program (a late receipt and pool, Settle, Cleanup, RecoverBond). That search covers every receipt and every season number the logs imply. A few early test scripts used random season numbers they did not log, with fee 0; an arena of theirs, if one is left, holds no entry money, and the new program refuses it.

## Observed on devnet

* The pinned queue answered both seed requests of the same season.
* A paid five-entry season drew 363,520 lamports from the hub (arena and permission 328,576, claims account 34,944 for 20 seats) and CloseClaims plus Cleanup returned all of it. The claims account is readable with no token.
* An owner can undelegate its own token account in the rollup. A Claim to it is then rejected (`InvalidWritableAccount`) while every other entry's claim goes through, and Settle, Cleanup and the bond release are unaffected. A wallet other than the owner (the payer) delegated the account again on base, after which the waiting claim paid in full.
* A sealed strategy account of the new size costs the hub 20,000 lamports.
* A four-entry season whose finals seed was never requested became voidable after the 360,000-slot timeout. Past it, a finals seed request was refused (9111) and so was a refund (9033). A Settle signed by a wallet outside the season paid the whole pot 50/30/20 by the frozen season ranks, the receipt was marked voided with reason finals seed timeout, and every claim paid. The other void reasons have been exercised only in the SVM tests.
* **Reclaim, on the `0ea300bf` build.** Four strategies sealed for a paid finals season cost the hub 20,000 lamports each. Their counts went to 1 at Enter; CloseStrategy was refused (9130) after Enter, after the run, and after a Settle that left an entry unpublished; the counts went to 0 as entries were published. After the season each strategy closed, each close returned exactly 20,000 to the hub, and the hub ended at exactly its starting balance. Each registry came back to base and CloseRegistry returned its 3,300,480 lamports to the owner, the amount paid at Register.
* In a cancelled season Cancel named no strategy and left the counts at 1; Cleanup was refused (9131) with none and with two of three named; a wallet owning none of the three then ran Cleanup naming all of them.
* A 404-byte and a 396-byte strategy sealed by earlier builds read a count of 0, entered, published and closed (20,000 and 19,744 back to the hub).
* A registry registered and not delegated: Seal succeeded, Enter was refused by the rollup (`InvalidWritableAccount`), passing it read-only was refused by the program (9133), and CloseStrategy failed too. After the owner delegated it the same strategy entered, published and closed.
* A publish grace of 1, 600 and 179,999 slots was refused (9105); 180,000 was accepted.

## Tests

`tests/svm/tests/`: `findings_3a.rs` (each Phase 3a defect, reversed into a regression test), `grief_3a.rs` (an unpayable account delays only itself), `money.rs`, `lifecycle.rs`, `edge.rs`, `reject.rs`, `admin.rs`, `meter.rs`, `fuzz.rs` (parsing, corrupted state, and a money check and an open-entry count check after every accepted mutated transaction), `authored.rs`, `reclaim.rs` (the counter on every path, close, the dodge attempts, the hub made whole with rent modelled, and an upgrade over the previous program's bytecode that is ignored unless that binary is supplied), `client_flows.rs` (the client's own instruction builders against the program; ignored unless node is available) and `vrf_3a.rs` (the real VRF program; ignored unless its bytes are supplied).

The stand-ins move no lamports. With `model_rent` the harness applies ephemeral rent from the calls the program really made, right after each transaction, so balances between transactions are exact but the program's own in-instruction rent figures read zero there. Delegation is not modelled.

**Stack frames.** `cargo-build-sbf` reports an overflowing stack frame as text and still exits 0, and the program then faults at run time. This happened while building the reclaim. `tests/svm.sh` and the reproducible build now fail on that message; the instructions that grew live in functions of their own.

Known limits: on the deployed build, sealed strategy accounts (20,000 lamports each; 19,744 at the old size) stay in the rollup, and with the new build they stay until their owner closes them; a cranker is not paid.

## Access guards and admin recovery

One config account (PDA `["config"]`, delegated to the rollup so changes act on the next transaction) holds the authority, a pause flag and up to 8 allowed stake mints. `InitConfig` (base) can only be signed by the program's upgrade authority, checked against the ProgramData account, and that key becomes the config authority. **The authority is a single key for now; moving it to a multisig is `Admin` sub-command 4 (set authority), no program change.**

| Guard | Rule | Error |
|---|---|---|
| Pause | `Admin 0` / `Admin 1`, authority only. While paused CreateSeason and Enter are refused. Lock, seeding in both phases, Advance, Settle, Cancel, Claim, CloseClaims, Publish and Cleanup keep working, so a pause stops new risk without trapping funds | 9060 paused, 9062 not the authority |
| Stake-mint allowlist | `Admin 2` / `3`, authority only, 8 mints at most. CreateSeason refuses a mint that is not listed (a mint with a freeze authority, a transfer hook or any other surprise stays out unless the authority lists it) | 9061 not allowed, 9064 list full |
| Config integrity | The config must be this program's PDA with the config magic; a copy at another address is refused | 9063 |
| RecoverBond | Authority only, in the rollup. Acts only on a receipt that is not closed, whose season header was written by Settle or Cancel, whose season id matches, and whose arena no longer exists. It moves no lamports; `ReleaseBond` then pays the creator recorded on the receipt, never the authority | 9070 |

Large fields: one Commit of a receipt plus 16 registries is rejected by the Magic program (observed on devnet), so commit registries in chunks of 4.
