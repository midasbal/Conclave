# Conclave ruleset v2 (frozen)

Everything that changes what a strategy means lives in `crates/conclave-vm/src/lib.rs` (constants block at the top) and `world.rs`.
Changing any value below is a new ruleset: bump `RULESET` and `VERSION`.

| item | value |
|---|---|
| bytecode version tag (`VERSION`) | 2 |
| ruleset id (`RULESET`) | 2 |
| work weights (units, 1 unit is about 70 compute units on SBF) | plain op 1, HIST 5, WSUM 5 + ceil(n/3), VOLW 6 + ceil(2n/5), ZW 11 + n |
| work cap per tick (`WORK_CAP`) | 64, enforced by `validate` |
| divisions (work units) | 16, 32, 64 |
| transaction cost (`COST_Q16`) | 0.15 vol-units per unit of position change |
| ruin floor | an episode PnL of -60 vol-units liquidates the seat for the rest of the episode |
| single-tick gap cap | 24 vol-units |
| position cap (`POS_CAP`) | 1.0 vol-target unit, clamps the target whatever the program computes |
| packs per season (`SEASON_PACKS`) | 2 of 6, drawn from the season seed after lock |
