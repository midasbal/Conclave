# Season lifecycle and money safety (pull payouts, two-phase finals, registry-paid strategies, public terms)

This file describes the program deployed on devnet (build `68d37e0f...`). Sections headed "Upgrading to ..." or "Done on devnet" are the history of one earlier build each and say which; where a later section differs from an earlier one, the later one is current.

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
| CloseClaims (tag 23) `[crank, hub, claims, vault, magic, terms]` | Anyone, only when every recorded amount is paid (9083). Returns the claims rent and the season's terms record rent to the hub. The terms account must be named (9150). |

On-chain solvency assertions:

* At record (Settle and Cancel): pool bookkeeping equals fee x entrants (9040), the pool token account holds at least the pot (9041; `>=` so a donation cannot block a season), and the amounts owed sum to the pot (9042).
* At every Claim: the amount is no larger than everything still unclaimed (9042) and the pool holds **everything** still unclaimed (9041), so a short pool cannot be drained by whoever claims first.

An entrant whose token account cannot be paid (closed, or withdrawn from the rollup) delays only its own claim. The arena and the creator's bond close without waiting for claims. A client must send one claim per transaction.

**The no-expiry tradeoff.** There is no deadline for claiming and no way to sweep an unclaimed amount. CloseClaims refuses (9083) unless every entry is marked paid **and** the claimed total equals the owed total, so it can never close over somebody's money. The price: an entrant who never claims, or never makes the token account payable again, keeps that season's claims account alive, with its hub rent, and keeps that amount in the season's pool for as long as they like. It costs the hub that rent and costs nobody else anything: other seasons have their own pools and claims accounts, and every other entrant of this one is unaffected. Because anyone can send a claim, this needs the entrant to keep their own account unpayable; simply doing nothing does not delay a payment once somebody cranks it. We chose this over an expiry because an expiry would turn a delay into a loss.

## Publish

Each (season, entry) is published at most once: the mark is in that season's arena slot and receipt entry (9120), so publishing a strategy in another season never reopens an earlier one, and the publish counters cannot exceed the number of entries. Cleanup checks every entry's own mark and refuses inside the grace while any is unpublished (9123). The registry records the **final** rank and adds the **season-phase** total.

The score commitment is `sha256("CNCL-SCORE-v3", score_salt, season, id, season_total, finals_total, episodes, finals_episodes)`, where `score_salt` is derived from the sealed salt for that season (see "Score salt" below; the v2 form, keyed by the sealed salt itself, exists only on format 2 receipts). The last two finals fields are zero for an entry that did not play the finals. The owner's sealed record holds the final rank, the season total and, for strategies sealed since the finals build, the finals total (older sealed accounts are 8 bytes shorter, stay usable, and their owners get the finals total by replaying the finals seed).

## Strategy reclaim and the open-entry guard

**Deployed on devnet** (the reclaim build of 2026-11-26 is under "Observed on devnet"; the Phase 6 build of 2026-11-27 is under "Phase 6").

**Who pays.** Since the Phase 6 build the strategy's own **registry** pays the sealed account's rent and its permission's at Seal (20,000 lamports), and is repaid when the strategy is closed. The registry is a program-owned PDA that is already delegated to the rollup (Enter and Publish need that) and already holds the 2,000,000 lamports the owner put in at Register above its rent: the rollup's Magic program, which collects the rent, checks only that the sponsor signed (the program signs for the registry with its own seeds), is writable (the rollup grants write access only to a delegated account) and holds the amount; it checks nothing about the sponsor's owner. An owner's wallet could not be the sponsor (the rollup refuses to debit an account that is not delegated to it: observed on the devnet TEE by simulation, a 1 lamport debit of an owner wallet answers `Immutable`). **A strategy that is never closed keeps 20,000 lamports of its own owner's money, not the hub's.** The hub still pays for seasons (arena, roster, claims account, terms record) and gets that back; strategies of earlier builds were paid for by the hub and still repay it (see Phase 6 below).

**The counter.** Two bytes of the sealed account that no earlier build ever wrote (offsets 6 and 7) hold the number of open entries. An arena slot that holds one unit of that count carries a bit (4).

| Path | Effect |
|---|---|
| Enter | count + 1 and sets the slot's bit (Enter takes the strategy writable, and the strategy's registry writable: see below) |
| Publish, separate or inline at Settle | count - 1 for that slot |
| Cancel | releases every strategy named after its fixed accounts. Naming them is optional: a refund never depends on a strategy account |
| Cleanup | releases every strategy named after the receipt, and refuses (9131) while any slot still holds a unit, because the arena is the only record of it |

The count moves down only where the slot's bit is set, and the bit is cleared with it. So nothing releases twice, and entries made by an earlier build (no bit) never take a unit that a newer season holds.

**Which strategies to name.** The arena is private, so a client works from what it knows. The receipt lists every entry id after Settle or Cancel and marks the published ones. For a settled season name the unpublished entries. Send Cancel with all of the season's strategies, and Cleanup then needs none. Do not name a strategy its owner has already closed.

**CloseStrategy** (tag 24, in the rollup, the owner signs; works while paused): refused while the count is not zero (9130). It wipes and closes the sealed account and its permission, with the rent going to whoever paid it (the registry, or for a strategy of an earlier build the hub: see Phase 6 below), and marks the registry closed. A closed registry is refused by Seal, Publish and Delegate. Then `Commit` with undelegate (now also accepts a closed registry, still refuses a live one, 9055) and **CloseRegistry** (tag 25, base, anyone may send it) which removes the account and pays all its lamports to the owner recorded on it, who paid them at Register (9132 otherwise). That return is the owner's reason to close.

**What the guard does not do.**

* It does not force publication. If nobody publishes an entry before the grace ends, Cleanup still drops that publication and releases the count. The grace is at least 180,000 slots (9105), which is the least time anyone, Publish being permissionless, has to publish it first.
* Closing removes the registry and with it the career figures (seasons, best rank, total). Each season's receipt keeps the strategy id, final rank, season rank and, for published entries, both commitments.
* After CloseRegistry the id is free: anyone, the same owner included, can Register it again with empty figures. Anything that reads a record by id must also check the commitment, and for a person's history the owner at that time.
* A registry that was never delegated to this rollup cannot be marked closed there, so such a strategy cannot be closed until its owner delegates the registry.
* A registry that is registered but never sealed has no close instruction, so what its owner paid at Register stays in it.

**Only a publishable strategy may enter.** Publish writes the registry, and Seal only reads it, so an owner who registers and never delegates can still seal (observed). Enter therefore takes the strategy's own registry and requires it **writable** (9133: read-only, another registry, a closed one, or one naming another owner). Since the Phase 6 build Seal requires the same of its registry (9133), so a strategy whose registry is not delegated can no longer be sealed. The program cannot see whether an account is delegated. The rule that makes this a guard is the rollup's: it refuses any transaction that marks writable an account it does not hold, even when nothing changes it (observed on the devnet TEE, by simulation and then with real transactions: `InvalidWritableAccount`). A delegated registry stays delegated until its owner closes the strategy, which an open entry forbids, so an entry that got in can always be published.

**Upgrading to the reclaim build (`0ea300bf`, historical).** No account changes size and the arena magic is unchanged. Old strategies read a count of zero. Seasons opened by the previous build can still publish, cancel and clean up, and never decrement anything; a strategy entered only in such a season is NOT protected by the counter, so deploy with no season open. A client whose Enter does not pass the strategy and its registry writable stops working, and so does one that asks for a grace under 180,000 slots.

**Done on devnet on 2026-11-26** (the reclaim build, sha256 `0ea300bf...`, 504,536 bytes, program data extended by 12,648 bytes, on-chain bytes equal to the artifact). Every receipt of a build that requires one was closed beforehand, so no season was open.

## Security considerations: sealing disclosure

**The real guarantee is narrower than "private": a strategy is private only while it is open.**

**The mechanism.** The salt and bytecode exist as plaintext in exactly one place: the `SealStrategy` instruction's own data (`idb | salt[32] | code`, tag 3). The rollup redacts that transaction's body to anyone who is not a member of the strategy's permission. That permission is created once, at Seal, with the owner as its only member, and destroyed once, at `CloseStrategy` (tag 24); no instruction ever replaces its member list. Once that permission is gone, the rollup's redaction has nothing left to key off, and the Seal transaction's full body, salt and bytecode included, becomes readable by anyone, with no token at all, from devnet's own transaction history. Observed on devnet: four already-closed strategies, read by four different viewers each (anonymous, a fresh stranger token, the owner's own token, another player's token), all returned the full plaintext body; the same lookup on an open strategy stays redacted to everyone but the owner.

**The scope, stated plainly.** Sealing, entering, running, settling, claiming and cleanup never put a secret into a transaction body, and never touch a strategy's permission. **Only `CloseStrategy` does either.** So the only action that ends a strategy's privacy is closing it.

**Who controls it.** Only the strategy's own owner can close it, by signing CloseStrategy, and the guard in "Strategy reclaim" above (9130) refuses that while any entry is still open. **No rival, and no season outcome, can force a strategy's code public.** The decision, and its timing, belong entirely to the owner.

**What it means downstream:**

* The retire-and-reclaim flow (Strategy reclaim, above) is the normal way to close a strategy and recover its rent. Every strategy retired that way is handed to the world for free, whether or not anyone ever asks for a proof.
* `verify --season` in `client/custody_cli.mjs`, and the verifier's level 3 and level 4 proofs (`verifier/README.md`), let an owner choose to reveal a score salt or a sealed salt and bytecode. That choice is moot once the strategy is closed: the salt and bytecode are already public through this mechanism, with no bundle and no reveal needed.
* README.md's and this file's description of a sealed strategy as "private" holds only up to the moment it is closed.

**No fix for this exists on MagicBlock's current TEE.** Nothing in the SDK or the TEE's RPC surface delivers a secret into the rollup's execution without it passing through a recorded transaction, and the one encryption primitive the SDK offers (`encrypt_ed25519_recipient`, keyed to the validator's own identity) is wired into base-layer delegation scheduling and SPL private transfers, not into redaction of a rollup transaction's own history; adopting it would add no trust beyond what the TEE already requires, and would not change what gets recorded once the program actually executes with the plaintext. A program-level mitigation is left as future work; it was not attempted here.

**Minimal honest mitigation, done here (client only, no program change):** `closeStrategy` in `client/flows.mjs` refuses to run at all unless its caller passes `{ acknowledgeDisclosure: true }`, and states this section's guarantee in full (`F.DISCLOSURE_WARNING`) if it does not. This cannot stop a close built by hand or by another client; it only stops this client from doing one silently.

## Receipts and identity

**Deployed on devnet** (build `7bd612e7...`, 2026-11-26; later builds keep everything below); what was seen there is at the end of this section. Everything in this section replaces what the sections before it say where they differ.

**Two gaps, closed.** Each was reproduced against the deployed bytecode before it was fixed (`tests/svm/tests/gaps_4a.rs`).

* `Delegate` of a receipt checked neither the creator nor the state, with the validator chosen by the caller. A stranger could hand a creator's fresh receipt, bond and all, to a validator of its choosing, or re-delegate a closed one so that ReleaseBond failed. Now only the receipt's **creator** may delegate it, and only while it is **fresh** (9140). The creator still chooses the validator; the receipt does not record which one.
* `Cleanup` skipped the bond accounting when the receipt was missing or read-only, so anyone allowed to clean up could strand the bond and skip the forfeit and the hub top-up. Now Cleanup requires the season's own receipt, writable and open, before it closes anything (9141).

**Cancel requires the receipt too.** Cancel used to write the receipt only if it could. It runs once, so whoever sent it could leave a season with no record of its field. It now requires this season's receipt, writable. A refund therefore depends on the receipt, which is in the rollup for as long as its arena is.

**The roster.** CreateSeason creates a second private account, PDA `["roster", season]` (16 bytes plus 32 per seat, permission with no members). Enter copies the entry's code commitment into it from the sealed account it is already reading. The arena has no room: 20 commitments would take it past the 10,240-byte limit. The hub pays the roster and its permission (27,008 lamports for 20 seats), counted in the season's rent, and Cleanup closes both.

**The receipt records who, for every entry.** Settle and Cancel write, for every entry whether or not it is ever published, the **owner** at entry (from the arena) and the **code commitment** (from the roster). Publish now only adds the score commitment, and refuses a strategy whose commitment is not the one recorded (9022). Nothing about the field is on the receipt before Settle or Cancel.

| Receipt | Size | Byte 146 | Owners | Commitments |
|---|---|---|---|---|
| Format 3 (this build) | 2,464 | 3 | 20 x 32 bytes from offset 1,824 | every entry, from Settle or Cancel |
| Format 2 | 1,824 | 0 | none | published entries only |
| Format 1 | 1,728 or 1,792 | 0 | none | published entries only |

Only a format 3 receipt can open a season or be delegated. Earlier ones keep their bond paths (RecoverBond, commit and undelegate, ReleaseBond) and stay readable by the client and server parsers. A format 3 receipt costs its creator the rent of 640 more bytes, and receipts are never closed.

**Score salt.** `score_salt = sha256("CNCL-SSALT-v1", salt, season)` and `score = sha256("CNCL-SCORE-v3", score_salt, season, id, season_total, finals_total, episodes, finals_episodes)`. To prove a season's totals an owner gives the season's score salt and the totals (`scoreSalt` and `scoreCommitWith` in `client/lib.mjs`). That does not reveal the sealed salt, does not open the code commitment, and opens no other season. It does not show which code produced the totals: that takes the sealed salt and the code, and a replay. Format 2 receipts keep the old rule, where proving a total hands out the sealed salt. The code commitment is unchanged.

**Permanent id marker.** CloseRegistry now shrinks the registry to an 8-byte account (magic `REGD`) that no instruction removes, and pays the owner everything above its rent. The address stays taken, so the id cannot be registered again. Registries removed by the previous build left no marker: **their ids are free**.

**What this does not do.** The marker retires an id, not a strategy: whoever knows the salt and code can seal them again under a new id. Attribution says who entered and with what commitment, not that the commitment's code is original. Reading the roster is prevented by the rollup's permission, which the SVM does not model.

**The field before Lock.** With this client it is private: the roster and the arena are not readable, nothing about the field is on the receipt, and **each entrant alone signs, pays for and submits its own Enter**, under its own rollup token (`enter` in `client/flows.mjs`). The last part matters because the rollup shows a wallet the signatures of the transactions it signed. A wallet that signs other people's Enters can match the signature lists of the arena and roster against those of the public registries, and so rebuild the field. **Any sponsor who signs an Enter, as fee payer or otherwise, sees that entry**, a season creator included. The program does not enforce who pays: a client that has the creator or a service sponsor entries gives that wallet those entries. `tests/svm/tests/client_flows.rs` fails if `flows.enter` ever sends an Enter with another signer or under another token.

**Observed on devnet** (`client/proof4a.mjs`, 2026-11-26; the history results are from the rerun after the client change). Upgraded in place; the program data was extended by 10,240 bytes (the loader's minimum), so 2,176 zero bytes follow the 512,600-byte artifact. No season was open and no fresh older receipt existed.

* **Reading the roster.** After five entries and before Lock, an anonymous caller, a stranger with its own token, the creator and an entrant all got nothing from `getAccountInfo`, `getMultipleAccounts`, `getProgramAccounts` and a simulation asked to return the account. The receipt, rollup and base, named no entry.
* **History, through the client's `enter`** (each entrant signs, pays and sends). 29 addresses were asked for their signatures by each viewer: the season accounts, config, program, token program, pool and its token account, and every entrant's registry, strategy, wallet and token account. An anonymous caller and a stranger were shown no Enter, and their arena and roster lists were empty. The creator's arena and roster lists held CreateSeason and nothing else, and none of its lists held an Enter. Each of the five entrants was shown its own Enter and no other. No viewer could read any Enter's body, **not even the entrant that signed it**; the same check did read a public transaction's body for its signer. As sent, every Enter had one signature, the entrant's, who was the fee payer; the fee was 0 and the entrant's base balance did not change. `getBlock` returned nothing usable (HTTP 403 on the call tried by hand). On base, nothing touched an entrant's registry.
* **Why the payer matters.** An earlier run, with a client in which the creator paid every Enter, showed the creator all five entries in the signature lists (bodies still redacted).
* **Live feeds: untested.** The rollup's websocket delivered slot notifications but no log or account notification, with or without a token, not even for a public control transaction. Its silence about the entries shows nothing.
* **Not covered:** what the rollup operator and the enclave itself can see, timing or traffic analysis, and any RPC method not listed here. The filtering is the rollup's behaviour, not something the program enforces, and could change with it.
* **The 2,464-byte receipt** was delegated, committed, undelegated and released. Magic refused one Commit of the receipt with 20, 16 or 12 registries (custom error 2684354562) and accepted the receipt with 10; 11 was not tried. The client commits in chunks of 4.
* A stranger's Delegate of a fresh receipt, and Delegate of a closed one by a stranger and by the creator, failed with 9140. Cleanup with the receipt read-only or replaced, including by another season's, failed with 9141, and with no receipt account with NotEnoughAccountKeys.
* A paid five-entry finals season showed every owner and commitment on the base receipt with two entries unpublished. A separate process given the receipt, one season's score salt and the totals verified them. The hub ended at its starting balance.
* A 20-seat season cancelled on a seed timeout refunded every entrant exactly. Before the Cancel, taking the open receipt out of the rollup (9055), delegating it from base, and a Cancel with the receipt read-only (9020), missing, or with a wrong roster (9142) all failed.
* **Cleanup at a full field fits only with one signature.** Naming 20 strategies it is 1,168 bytes (97,344 compute units) when the crank pays its own fee, as sent on devnet. With a separate fee payer it is 1,264 bytes, over the 1,232 limit. Whoever cranks a full field must pay its own fee, and an added instruction has 64 bytes at most.
* CloseRegistry left an 8-byte marker holding 690,880 lamports and paid the owner 2,609,600. Registering the id again (old owner and stranger), sealing it, delegating the marker and CloseRegistry on it all failed.
* **What a strategy costs its owner for good:** 3,641,920 lamports plus base transaction fees: the 690,880 in the marker and 2,951,040 paid at delegation. The latter funds the delegation record and metadata accounts; at undelegation the delegation program paid it to its validator fee vault (2,655,936) and protocol fee vault (295,104).

**Upgrading to the receipts build (`7bd612e7`, historical).** The arena magic changes to `ARN4`, so every arena of the previous build is refused outright: **deploy with no season open**, or that season and its money are stuck, and its strategies stay counted. A fresh format 2 receipt (InitReceipt with no season yet) could neither open a season nor be delegated afterwards, so there must be none. Old strategies and registries work unchanged, including a registry closed but not yet removed. CreateSeason, Enter, Settle, Cancel and Cleanup take new accounts, so **the client of this build does not work against the previous program, and the previous client does not work against this one**.

## Randomness queue

RequestSeed accepts only `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` (9110). The previous build accepted any queue the VRF program accepted, including delegated queues that showed no activity.

**Residual trust.** The program relies on the oracle that serves this queue staying online and delivering honestly. It cannot force a delivery. We assume the oracle knows a value before it delivers it, so it could withhold one it dislikes: in the season phase that ends in refunds, in the finals it ends in a void, which pays by season rank and so favours the season leader. We have not reviewed the VRF program's proof verification. The queue is shared with other applications; we have not tested whether it can be filled. If the queue is retired, the program needs an upgrade.

## Other guards

| Guard | Rule | Error |
|---|---|---|
| Entry window, Lock | As before: Enter is refused after the window; the creator may lock any time, anyone after the window; Lock cancels an under-minimum field | 9030, 9031, 9032 |
| Cancel | Creator while unlocked; anyone for an unseeded season past the seed timeout, a season phase past its deadline, or after an under-minimum Lock; once only | 9033, 9034 |
| Creation bond | `InitReceipt` posts a bond held in the season receipt; a receipt opens exactly one arena | 9050 to 9053 |
| Hub accounting | The arena's rent is measured at CreateSeason and topped up from the bond at Cleanup if the close returns less. The claims account's and the terms record's rents are measured separately and do not touch the bond. 25% of the bond is forfeited when a season is abandoned (under-minimum or creator cancel). A void or a missed deadline forfeits nothing | |
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
| 9133 | Enter or Seal was not given the strategy's own open registry, writable |
| 9134 | Seal: the registry does not hold the rent and still stay rent-exempt |
| 9150 | the terms record is missing, not this season's, malformed, or does not say what the arena does |
| 9151 | Enter: the fee, the stake mint or the terms hash the entrant sent is not the terms record's |
| 9140 | this wallet may not delegate this receipt (creator only, fresh only, format 3) |
| 9141 | Cleanup was not given this season's open receipt, writable |
| 9142 | not this season's roster |
| 9105 | publish grace under 180,000 slots |

Instruction tag 14 (the old StartFinals) is retired and answers InvalidInstructionData.

## Account layouts

* **Arena** (magic `ARN4`, set by the receipts build, so the program refuses arenas of earlier generations; size unchanged since). Header: finals seed at 1112 (32 bytes), flags2 at 1144, published count at 1145, season-phase end slot at 1272. Slot (440 bytes, unchanged): season rank u8 at 42, bits at 43 (1 finalist, 2 published), final rank at 44, season total at 48, finals total at 56. Flags: 1 locked, 2 seed requested, 4 seeded, 8 done, 16 settled, 32 season phase done, 64 finals seed requested, 128 finals seeded.
* **Claims** (new): 72-byte header (state, entry count, capacity, kind, season, mint, owed total, claimed total, rent) plus 48 bytes per seat (owner, owed, done).
* **Receipt** (1792 to 1824 bytes). Header grows from 192 to 224: finals seed words, finals packs, finals status, qualifier count, finals episodes, total owed. Entry: final rank at 72, season rank at 76, published at 78, finalist at 79.
* **Sealed strategy** (396 to 404 bytes): the finals total is appended. 396-byte accounts remain valid. Bytes 6..8 are the open-entry count in the low 15 bits and the **payer flag** in the top bit (0x8000): set at Seal by this build (the registry paid), never set on a strategy of an earlier build (the hub paid). No size change.
* **Terms record** (new, 184 bytes, ephemeral, public, PDA `["terms", season]`, rent from the hub): 0 magic `TERM` | 4 version (1) | 8 season | 16 creator | 48 stake mint | 80 fee | 88 episodes u32 | 92 slots per tick u32 | 96 entry window | 104 seed timeout | 112 publish grace | 120 seats | 121 minimum entrants | 122 flags (2 = finals) | 123 division | 128 ruleset pins (48 bytes) | 176 hub rent drawn (outside the hash). The hash an entrant sends to Enter is `sha256("CNCL-TERMS-v1" || bytes 4..176)`.

## Phase 6: the registry pays for a sealed strategy, and every season states its terms in public

Two changes, one upgrade. Both are off the money path of a season: no entrant's fee, claim or prize moves differently.

**1. Registry-paid rent (SealStrategy, tag 3).** Accounts `[owner(s), strat(w), permission(w), vault(w), magic, permission_program, reg(w)]`; the hub is no longer in the instruction. The registry is the sponsor of both the sealed account's create and its permission's, signed with `["reg", id, bump]`. Before anything is created the program refuses a registry that is not writable (9133: in the rollup a registry that was never delegated cannot be written, so a strategy whose registry is not delegated can no longer be sealed, which also closes the earlier gap where it could be sealed and then never enter or be closed), and one that would not stay rent-exempt after paying: it must hold the minimum for its own size plus both rents (9134). After the last CPI the real balance is checked once more against the same minimum, so a rent that came out higher than estimated reverts the whole instruction. The sealed account is marked with the payer flag.

**2. The payer flag and the migration (CloseStrategy, tag 24).** A strategy sealed before this build was paid for by the hub; one sealed after it, by its registry. Closing repays whoever paid, and the sealed account says who: bit 15 of the two bytes at offset 6 (the open-entry count keeps the low 15 bits; reaching 32,767 open entries is refused like any overflow). Flag set: the registry is the sponsor of the permission close and the account close and is repaid. Flag absent: the hub is, exactly as before, and the hub account must be the real hub. The account list of CloseStrategy is unchanged and the hub is passed either way; for a flagged strategy it is not read. Old strategies never gain the flag (nothing but Seal writes it), so the two kinds coexist for as long as old strategies stay open.

**3. The public terms record.** CreateSeason takes one more account, `terms`, and creates it in the same transaction as the arena: the season's fee, stake mint, length, pace, finals flag, entry window, seed timeout, publish grace, seats, minimum entrants, division, ruleset pins and creator, with no permission account, so anyone can read it before paying. The hub pays its rent (7,808 lamports), measured on its own like the claims account's, never drawn from the creator's bond. **Enter** takes it read-only as its last account, and instruction data of exactly 72 bytes: the fee the entrant expects, the stake mint it expects, and the hash of the record it read. Before a single token moves the program checks that the record is this season's, that it says what the arena does on every term (9150), and that the three values the entrant sent are the record's (9151). An entrant therefore pays only into terms it has read, whatever the creator or anyone else does later: the record is written once and nothing rewrites it. **CloseClaims** closes it with the claims account (Cleanup is not touched: at a full field it has 64 bytes of headroom). A season of an earlier build never had a record; CloseClaims accepts that address only when it holds nothing.

| Instruction | Accounts after this build | Data |
|---|---|---|
| Seal (3) | owner(s), strat(w), permission(w), vault(w), magic, permission_program, reg(w) | id, salt, code (unchanged) |
| CreateSeason (5) | the 12 of before, then terms(w) | unchanged |
| Enter (6) | the 9 of before, then terms | fee u64, mint[32], terms hash[32] (new) |
| CloseClaims (23) | crank(s), hub(w), claims(w), vault(w), magic, terms(w) | none |
| CloseStrategy (24) | unchanged | none |

**Upgrading to this build.** (a) The program data account must be extended first: this artifact is larger than the 514,776 bytes the deployed program has room for. (b) Deploy with **no season open**: a season created by the previous build has no terms record, so Enter into it is refused (9150). It can still be wound up with this build (cancel, claims, CloseClaims with nothing at the terms address, Cleanup); `tests/svm/tests/migrate_6.rs` does exactly this with the real previous bytecode. (c) Strategies sealed before the upgrade keep working and are repaid to the hub when closed; new ones are repaid to their registry. (d) Old clients stop working: Seal, CreateSeason, Enter and CloseClaims take different accounts and Enter takes data.

**Deployed on devnet 2026-11-27** (slot 526779926, build sha256 `68d37e0f...`, 524,776 bytes, program data extended by 10,240 to 525,016, on-chain bytes equal to the artifact; upgrade signature `ayJ1Xw6rqpEEQUsXKQUNZFfoYqJUHzPjhsbJb8yp471UsELDpqx6ZZ3QGdN1MFx91QDrH7trjNawbESmEKQ6q3M`). Observed, by `client/proof6_seal.mjs` and `client/proof6.mjs` (45 checks), the canary (37 checks) and the client scripts:

* **The rollup serves the new program a short while after the upgrade.** The first Seal, sent within minutes of the deploy, reached the previous program and failed with `NotEnoughAccountKeys` (it wants the hub as the second account). A simulation, which changes nothing, then showed the new account list accepted and the old one refused (Custom 555), and the same Seal succeeded.
* **The registry is accepted as the rent sponsor, in one transaction for the sealed account and its permission.** Seal `4GHVxyPZwn6io6tuHUAQt1sjiRhRQe1vkh6x9msjxP5GdtUwXQYCriHfqjgnJTGxutt3gE1gaL364S8hQxGova3m`: the registry went from 3,300,480 to 3,280,480 lamports (the 20,000 it was debited), the hub did not move, and the sealed account carries bytes 6..8 = 0x8000.
* **Migration.** CloseStrategy of a strategy sealed by the previous build (`5BeNCG8o...`, flag absent): the hub +20,000, its registry unchanged. Of strategies sealed by this build (flag set; `4mzwVPXj...`, `5kCh59AX...`, `2WF7VN4w...`): each registry +20,000 and the hub unchanged.
* **Terms record.** Created at CreateSeason, readable with no token, equal to what the creator asked for, rent 7,808 from the hub. Enter with a fee other than the record's, a fee of zero, another mint, or a hash with one bit flipped is refused with 9151; with another season's terms record, or an account that is not a terms record, 9150; with the previous build's Enter (no data), InvalidInstructionData. None moved a token or took a seat. The three matching Enters took exactly the fee. The payer flag read 0x8000, then 0x8001 while entered, then 0x8000 after publish. CloseClaims closed the terms record with the claims account, and the hub ended whole (plus the 25% of an abandoned season's bond).
* **Guards.** An undelegated registry passed read-only is refused by the program (9133, `41f3xWsK...`); passed writable the rollup itself refuses before the program runs (`InvalidWritableAccount`, `5VLCL4of...`). Nothing was created. The same strategy sealed after its registry was delegated.
* **Not shown on devnet:** 9134 (no instruction can take a registry below its floor, so it is shown in the SVM at the exact boundary only), the open-entry count reaching 32,767, and CloseClaims for a season of the previous build with no terms record (no such claims account was left on devnet; shown on the real previous bytecode in `migrate_6.rs`).

## Upgrading from the build before the receipts build (historical)

1. Deploy only with **no season open**: every arena must be settled or cancelled and cleaned up. An old arena left open would be refused by the new build, with its money in it.
2. Closed receipts of the old size can still be committed, undelegated, recovered and released: the money fields did not move.
3. Old clients stop working (CreateSeason, Settle and Cancel take different accounts; StartFinals is gone).

**Done on devnet on 2026-11-26** (the finals build, sha256 `928fe971...`, 491,888 bytes, program data extended by 12,592 bytes, on-chain bytes equal to the artifact). Before it, one old season was still open: a fee-0 metering arena from 2026-11-24, created before receipts existed, so a receipt scan could not see it; probing the season numbers in the logs found it. It was closed with the old program (a late receipt and pool, Settle, Cleanup, RecoverBond). That search covers every receipt and every season number the logs imply. A few early test scripts used random season numbers they did not log, with fee 0; an arena of theirs, if one is left, holds no entry money, and the new program refuses it.

## Observed on devnet

* The pinned queue answered both seed requests of the same season.
* A paid five-entry season drew 363,520 lamports from the hub (arena and permission 328,576, claims account 34,944 for 20 seats) and CloseClaims plus Cleanup returned all of it. The claims account is readable with no token.
* An owner can undelegate its own token account in the rollup. A Claim to it is then rejected (`InvalidWritableAccount`) while every other entry's claim goes through, and Settle, Cleanup and the bond release are unaffected. A wallet other than the owner (the payer) delegated the account again on base, after which the waiting claim paid in full.
* A sealed strategy account of the then-new size cost the hub 20,000 lamports. (Since the Phase 6 build the registry pays that, see "Who pays".)
* A four-entry season whose finals seed was never requested became voidable after the 360,000-slot timeout. Past it, a finals seed request was refused (9111) and so was a refund (9033). A Settle signed by a wallet outside the season paid the whole pot 50/30/20 by the frozen season ranks, the receipt was marked voided with reason finals seed timeout, and every claim paid. The other void reasons have been exercised only in the SVM tests.
* **Reclaim, on the `0ea300bf` build** (before the registry paid). Four strategies sealed for a paid finals season cost the hub 20,000 lamports each. Their counts went to 1 at Enter; CloseStrategy was refused (9130) after Enter, after the run, and after a Settle that left an entry unpublished; the counts went to 0 as entries were published. After the season each strategy closed, each close returned exactly 20,000 to the hub, and the hub ended at exactly its starting balance. Each registry came back to base and CloseRegistry returned its 3,300,480 lamports to the owner, the amount paid at Register.
* In a cancelled season Cancel named no strategy and left the counts at 1; Cleanup was refused (9131) with none and with two of three named; a wallet owning none of the three then ran Cleanup naming all of them.
* A 404-byte and a 396-byte strategy sealed by earlier builds read a count of 0, entered, published and closed (20,000 and 19,744 back to the hub).
* A registry registered and not delegated (on the `0ea300bf` build; Seal now refuses this, 9133): Seal succeeded, Enter was refused by the rollup (`InvalidWritableAccount`), passing it read-only was refused by the program (9133), and CloseStrategy failed too. After the owner delegated it the same strategy entered, published and closed.
* A publish grace of 1, 600 and 179,999 slots was refused (9105); 180,000 was accepted.

## Tests

`tests/svm/tests/`: `findings_3a.rs` (each Phase 3a defect, reversed into a regression test), `grief_3a.rs` (an unpayable account delays only itself), `money.rs`, `lifecycle.rs`, `edge.rs`, `reject.rs`, `admin.rs`, `meter.rs`, `fuzz.rs` (parsing, corrupted state, and a money check and an open-entry count check after every accepted mutated transaction), `authored.rs`, `gaps_4a.rs` (the two receipt gaps, reversed into regressions), `roster_4a.rs` (the roster, attribution on every path, receipt formats, the score salt, the id marker), `reclaim.rs` (the counter on every path, close, the dodge attempts, the hub made whole with rent modelled, and an upgrade over the previous program's bytecode that is ignored unless that binary is supplied), `client_flows.rs` (the client's own instruction builders against the program; ignored unless node is available) and `vrf_3a.rs` (the real VRF program; ignored unless its bytes are supplied).

The stand-ins move no lamports. With `model_rent` the harness applies ephemeral rent from the calls the program really made, right after each transaction, so balances between transactions are exact but the program's own in-instruction rent figures read zero there. Delegation is not modelled.

**Stack frames.** `cargo-build-sbf` reports an overflowing stack frame as text and still exits 0, and the program then faults at run time. This happened while building the reclaim. `tests/svm.sh` and the reproducible build now fail on that message; the instructions that grew live in functions of their own.

Known limits: a sealed strategy account (20,000 lamports; 19,744 at the old size) stays in the rollup until its owner closes it, paid by the registry for strategies sealed since the Phase 6 build and by the hub for earlier ones; a cranker is not paid.

## Access guards and admin recovery

One config account (PDA `["config"]`, delegated to the rollup so changes act on the next transaction) holds the authority, a pause flag and up to 8 allowed stake mints. `InitConfig` (base) can only be signed by the program's upgrade authority, checked against the ProgramData account, and that key becomes the config authority. **The authority is a single key for now; moving it to a multisig is `Admin` sub-command 4 (set authority), no program change.**

| Guard | Rule | Error |
|---|---|---|
| Pause | `Admin 0` / `Admin 1`, authority only. While paused CreateSeason and Enter are refused. Lock, seeding in both phases, Advance, Settle, Cancel, Claim, CloseClaims, Publish and Cleanup keep working, so a pause stops new risk without trapping funds | 9060 paused, 9062 not the authority |
| Stake-mint allowlist | `Admin 2` / `3`, authority only, 8 mints at most. CreateSeason refuses a mint that is not listed (a mint with a freeze authority, a transfer hook or any other surprise stays out unless the authority lists it) | 9061 not allowed, 9064 list full |
| Config integrity | The config must be this program's PDA with the config magic; a copy at another address is refused | 9063 |
| RecoverBond | Authority only, in the rollup. Acts only on a receipt that is not closed, whose season header was written by Settle or Cancel, whose season id matches, and whose arena no longer exists. It moves no lamports; `ReleaseBond` then pays the creator recorded on the receipt, never the authority | 9070 |

Large fields: one Commit of a receipt plus 16 registries is rejected by the Magic program (observed on devnet), so commit registries in chunks of 4.
