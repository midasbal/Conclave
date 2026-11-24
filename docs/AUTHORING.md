# Writing and testing a strategy

Everything here is local: no chain, no network, no wallet. The assembler and simulator run the real `conclave-vm`, natively (`conclave-author`) or compiled to WASM (`node client/author.mjs`); both are the same Rust.

```
conclave-author asm   strategies/momentum.cvs        cost table, total work, division, bytecode, hashes
conclave-author sim   strategies/momentum.cvs        ensemble report
conclave-author fmt   FILE | disasm HEX | ops        canonical source | bytecode back to source | the instruction reference
node client/author.mjs asm|sim FILE | disasm HEX     the same through the WASM build
```

## Source format v1 (ruleset 2)

```
conclave-strategy 1 ruleset 2      required first statement: format version 1, pinned to ruleset 2
name "Momentum 20"                 optional name, author, note (plain ASCII, 80 characters); never part of the bytecode
state prev                         declare a register that carries last tick's value
x = sig T20                        [dst =] mnemonic operands, one instruction per line; # starts a comment
x = thr x 0.125
x = sign x
pos x
```

**Versioning.** The header carries two numbers. The format version (1) is the grammar of this file. The ruleset (2) is what the instructions mean: weights, caps, costs, signals. A source whose ruleset is not the build's is refused with a message naming both, never reinterpreted. A new ruleset gets a new assembler release that reads the new header and, if the author asks, still assembles ruleset 2 sources to their original bytes.

**Registers.** 16 of them, `r0..r15`. Name them freely: a name gets the lowest free register the first time it is written (or declared with `state`), so the same source always assembles to the same bytes. Writing `r0`..`r15` yourself reserves that register. `free NAME` releases one. Registers hold their value from tick to tick within an episode and start at 0 each episode, so reading a register above the line that writes it uses the previous tick's value; a name read before it exists is an error unless declared with `state`.

**Numbers** are plain decimals, quantised with integer arithmetic (round half away from zero): `const` to 1/256 (range -128 to 127.99609375), `gti`, `lti` and `thr` thresholds to 1/32 (range -4 to 3.96875). A value that is not exact earns a warning that shows what was stored.

**Instructions**: `conclave-author ops` prints the full reference. Signals for `sig`: `U1 CUM T5 T10 T20 MOM VOLR ZSC TLEFT` (market features) and `POS CASH PNL DD` (this seat's own state).

## Cost

Work per instruction comes from the VM itself (`conclave_vm::op_work`), not a copy: plain 1, `hist` 5, `wsum` 5 + ceil(n/3), `volw` 6 + ceil(2n/5), `zw` 11 + n. The assembler prints each instruction's cost and the total, refuses anything over the cap of 64 (naming the heaviest instructions), and names the smallest division that fits: 16, 32 or 64. A season's division is a ceiling on work; a strategy enters any division at or above its own.

## What the simulator measures

The unit is the **season total**, because that is what the chain ranks. A world is a 32-byte seed turned into a season exactly as the chain does (`season_words`, two packs drawn with `season_packs`, a pack per episode from `pack_for_season`), and the strategy runs on the real `Market` and `Seat`. The default is 48 worlds of 12 episodes, and there is no way to ask for one world alone: `--single-seed N` still prints the whole ensemble, then where that world falls in it.

| Section | What it tells you |
|---|---|
| Season total | mean, median, quantiles, share of worlds in profit, mean/stderr, a bootstrap 90% interval for the mean |
| Luck gap | how far the best world sits above the median: what cherry-picking a seed would claim |
| Fresh holdout | a second ensemble seeded from the hash of your bytecode, so every edit gets new worlds. A large gap to the dev ensemble means the dev result was luck or tuning |
| Per episode | mean, win rate, worst-5% average, drawdown quantiles, ruin-floor hits (-60 vol-units) |
| Gaps and jumps | worst single tick, ticks at the gap cap while in a position, PnL on big-move ticks against all others |
| By world pack | exact: each of the 6 packs forced, with its regime mix. A season draws 2 packs after lock, so you do not choose |
| By hidden regime | every tick attributed to the regime that produced it (see below); the regimes add up to the episode PnL exactly |
| Reference field | rank among you plus the 44 pool strategies, per dev world |
| Where it is fragile | the checks that fired: no demonstrated edge, holdout disagreement, sign flip between halves, ruin rate, a pack or regime that loses money, a heavy left tail, cost drag, giving back on jumps, rarely in a position |

## How it matches the chain

1. The VM, the generator and the seeding are the chain's own code. Season totals from the simulator equal the lab's reference driver and the conformance `SEASON` vector exactly (tests/simulator.rs).
2. Every strategy in `strategies/*.cvs` is assembled by this tool and turned into conformance vectors (`tests/conformance/authored.bin`: validate, 150-tick traces with state save/load, short traces for SBF, seasons, a whole arena). `tests/conformance.sh` runs them on host, WASM and SBF; all must be bit-identical. A change to the assembler or an example changes the file and fails the gate until regenerated on purpose.
3. The WASM build is compared with the native CLI byte for byte, and its episode runner with the conformance WASM's `cc_run` on the same trace vectors (`tests/author_wasm.mjs`).

## Known limits

- **Regime labels come from a twin of the world generator.** The generator does not expose which regime made each tick, and `conclave-vm` cannot change (the on-chain program is built from it; adding even an unused function changes the program's reproducible hash, observed). `src/twin.rs` is a copy that also records the labels. It is never trusted: every simulated episode compares its returns with the real generator's, the regime table is withheld if they ever differ, and a test checks 30,000 (pack, seed) pairs. Regime names are ours, read from the generator's drift rules.
- The simulator scores a strategy alone and against the fixed reference pool. It cannot know the field a real season will have.
- Statistics describe these worlds. They do not promise anything about the next season's packs.
