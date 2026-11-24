# Program-level panic pass

The VM is panic-audited (`crates/conclave-vm/PANIC_FREEDOM.md`). This covers the program wrapper in `src/lib.rs`: account parsing, slice indexing, arithmetic and CPI. An abort inside Advance stalls the arena for every entrant, so every path must return an error.

## Method

1. Read every indexing, arithmetic, borrow and CPI site.
2. Property test through the real bytecode (`tests/svm/tests/fuzz.rs`): valid instructions for every tag at every lifecycle stage are mutated (data bytes, truncation, extension, account substitution, drop, duplicate, reorder, writable flips), plus a second pass that corrupts bytes inside program-owned accounts. Oracle: success or an error code. A `ProgramFailedToComplete` not caused by the compute meter is a finding.
3. The same fuzz run against the previous binary (built from the pre-pass source) is kept as the control: `evidence/svm_fuzz_prepass_binary.txt` (40 aborts in 2 x 20000 iterations). Against the hardened binary: `evidence/svm_fuzz_run1.txt` (0 in 2 x 20000).

## Findings and fixes

| Class | Observed | Fix |
|---|---|---|
| Delegate (tag 2) with a foreign program id or a PDA that does not match the seeds | Control binary and the first hardened build both aborted: the runtime kills the transaction when the SDK's signer seeds do not give a valid address | Check program id and the exact PDA (hub, registry with owner and id, receipt with magic) before delegating |
| Publish (tag 11) with an account passed twice | The first hardened build aborted: `AccountInfo::data_len()` panics while the same account is mutably borrowed | `try_data_len()?` at every site, and fallible borrows everywhere |
| Control binary only: tag 6 (Enter) and tag 196 (undelegate callback) aborts on malformed accounts or data | Seen in the control run; each was removed by the earlier parts of this pass (total readers, `check_*`, rewritten callback). The individual root causes were not diagnosed one by one | Total readers `rd32/rd64/rdi64/pk`, checked `arr`, `ru32`, `ru64`; `need(n)` length checks; `check_arena`, `check_strat`, `check_reg`; rewritten `undelegate_cb` |
| Arithmetic on stored counters and amounts | Reviewed, not observed to abort | Checked, saturating or u128 arithmetic; episode count capped at 100,000; `cur_tick >= WORLD_T` guard |
| Ephemeral account size | Reviewed, not observed to abort | Size checked after creation |

Everything above is a behavior-preserving change for valid inputs: the lifecycle tests replay the VM on the host and require identical scores and exact payouts.

## What the fuzz does not show

Absence of findings in a finite run is not proof. Stand-ins replace the Magic, permission, VRF, eSPL and delegation programs, so the CPI argument checks the program makes toward them are exercised only up to the stand-ins' behavior; the real services are covered by the devnet runs.
