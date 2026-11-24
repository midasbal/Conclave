# conclave-vm: panic-freedom audit

Why this matters: the SBF build runs with overflow checks on. Any arithmetic overflow, out-of-range index, division by zero or bad shift aborts the transaction, and an aborting `Advance` stalls the arena for every entrant. This file lists every operation that is not trivially total, the bound that makes it safe, and what enforces the bound. `clippy::arithmetic_side_effects` and `clippy::indexing_slicing` were used as the work list (about 200 flagged sites); each is covered by a row below. Evidence for the claims is the conformance corpus (`tests/conformance`) and the fuzzer (`cc-fuzz`), see the bottom.

Notation: `R = R_MAX = 2^24` (largest accepted per-tick return, ppm), `X = X_MAX = 2^40`, `ONE = 2^16`. All register values live in `[-(2^31-1), 2^31-1]` (`sat` clamps symmetrically, so `i32::MIN` never appears; loaded state is sanitised to the same range).

## Inputs and what the VM does with hostile ones

| input | handling |
|---|---|
| return `r: i32` (any value) | `Market::advance` clamps to `[-R, R]` before use. `Seat::step` uses `i64::from(r) * 65536` (at most 2^47), so it is safe even if a caller skips the market clamp. |
| `sg0: i64` passed to `step` | `max(sg0, 1)` (no division by zero, no negative divisor). |
| program bytes | `validate` is total (every index follows a length check). `step` additionally trims the op count to the bytes actually present and returns on a blob shorter than the header, so an unvalidated blob cannot index out of range. |
| saved state (`Market::load`, `Seat::load`) | every field is clamped into the range reachable from `new()` through `advance()`/`step()`, so a corrupted or hostile state cannot overflow downstream. Valid states are unchanged (conformance: `state/valid mid-run`, split-run twins). |
| save/load buffer length | **precondition, not checked at runtime**: `Market::BYTES` (352) and `Seat::BYTES` (111) bytes. The program enforces it at compile time with a `const` assertion over the arena layout (`program/src/lib.rs`), so a layout mistake is a build error. |

## Market (`advance`, window sums, features)

| operation | bound | why it cannot overflow |
|---|---|---|
| `sig += (\|r\| - sig) / 16`, same with `/64` | `sig, sig_s in [0, R]` | `sig` is an EMA of values in `[0, R]`: it stays between its old value and the new sample, and truncating division keeps it there. |
| `x = clamp(x + r, -X, X)`, `a += (x - a) / 32` | `\|x\|, \|a\| <= X` | explicit clamp; `a` moves toward `x`. `x + r` is at most `2^40 + 2^24`. |
| `sg = max(sig, 1000)` | `[1000, R]` | floor. Never zero, so every division by `sg`, `sg * SQRT*`, `5 * sg` is non-zero. |
| `wsum_raw(n <= 20)` | `<= 20 R = 2^28.4` | 20 terms each `<= R`. For `n <= 255` (unvalidated programs) `<= 255 R = 2^32`. |
| `s5/s10/s20 * 2^32` | `<= 20 R * 2^32 = 2^60.4 < 2^63` | the tightest product in the VM. This is why `R` is `2^24` and not larger. |
| `sg * SQRT20` | `<= 2^24 * 2^18.2 = 2^42.2` | |
| `qdiv(a, b)`: `a * 65536` | `\|a\| <= 2^47` at every call site (`r`, `x`, `x - a <= 2X`, `s20`, `sig`) | `a.saturating_mul(65536)` as a backstop; `b == 0` returns 0. Largest real case `(x - a) * 65536 <= 2^41 * 2^16 = 2^57`. |
| time left: `total - t - 1` | guarded by `total > t.saturating_add(1)` | no unsigned underflow. `t` uses `saturating_add`, so it cannot wrap. `total.max(1)` is non-zero. |
| ring/cum indexing | `& (RING - 1)` | index is masked; `cur.wrapping_sub(k)` cannot panic. |

## Seat (`step`)

| operation | bound | why it cannot overflow or abort |
|---|---|---|
| gap accrual `i64::from(r) * 65536 / sg0` | numerator `<= 2^47`, divisor `>= 1` | then `clamp(+-24 * 2^16)`. |
| `trade += (pos * u) >> 16` | `\|pos\| <= ONE`, `\|u\| <= 24 * 2^16` so the product is `<= 2^37` | `saturating_add` as well. Shifting a negative value right is arithmetic, not an error. |
| `pnl = cash + trade`, `peak - pnl` | both clamped to `+-2^50` on load; `saturating_add/sub` in step | |
| `LDI` | `i16 << 8 <= 2^23` | shift amount is a constant below the width. |
| `ADD`, `SUB` | computed in `i64`, then `sat` | sum of two `i32` fits `i64`. |
| `MUL` | `\|ra * rb\| <= (2^31-1)^2 < 2^62` | registers never hold `i32::MIN`. Result `>> 16` then `sat`. |
| `DIV` | `\|ra\| * 65536 <= 2^47`; `rb == 0` returns 0 | `i64` division only overflows for `MIN / -1`, impossible here. |
| `NEG`, `ABS` | `saturating_neg`, `saturating_abs` | plain negation would also be safe given the register invariant; the saturating forms make it unconditional. |
| `SIGN, MIN, MAX, GT, LT, AND, OR, NOT, SEL, MOV` | no arithmetic | |
| `GTI, LTI, THR` | `i8 << 11 <= 2^18` | |
| `EMA` | shift is `b & 15` | an unmasked shift of 64 or more aborts; validate already limits `b <= 15`, the mask protects unvalidated blobs. Difference `<= 2^32`. |
| `HIST k` | index masked | `qdiv` of a value `<= R`. |
| `WSUM n`, `VOLW n`, `ZW n` | `n <= 255` (validate: `1..=32`) | sums `<= 255 * 2^32 = 2^40`; times 65536 is `2^56`; `m.sgs * n <= 2^24 * 255`. |
| `ZW` divisor | `max(mad, sg / 4) >= 250` | never zero. `mean = s / n` with `n >= 2`. |
| `POS`, `SIZE`, `LONG/SHORT/FLAT`, `STOPSET/STOPCLR` | clamps to `[-ONE, ONE]`, `[0, ONE]`; `abs` of a value in `[-ONE, ONE]` | |
| `target = dir * size` | `dir in {-1,0,1}` (assigned only those; sanitised on load), `size in [0, ONE]` | `<= 2^16`; then `clamp(+-POS_CAP)` (unreachable by construction, kept as defence in depth). |
| `delta = \|target - pos\|` | computed in `i64` | `<= 2^17`; `delta * COST <= 2^17 * 9830`; `cash` uses `saturating_sub/add`. |
| `work += w` | `saturating_add` | per tick `w <= 64 * (11 + 255)` even for unvalidated blobs. |
| register and operand indices | `& 15` on every register index | |
| code indexing `code[o..o+3]` | `o = 4 + 4 i`, `i < avail = (len - 4) / 4` | trimmed in step; `validate` requires `len == 4 + 4n`. |

## validate, work_of, op_work, pins

`validate` checks `len >= 4` before reading the header, bounds `n <= 64` before computing `4 n`, and requires `len == 4 + 4 n`; every later index is inside the slice. `work_of` trims to the bytes present and uses `saturating_add`. `op_work` uses `u32` with `a <= 255` (`div_ceil`, `2 * a`). `pins_bytes` converts with `try_from`; `gen_checksum` uses wrapping multiplication.

## World generator (`gen_episode`, seeds)

- `Rng::u(m)`: `m.unsigned_abs().max(1)`, no division by zero. `next()` uses wrapping multiplication and constant shifts.
- Pack index: `PACKS[pack % NPACK]`, so any `usize` is valid. `season_packs`: `h % 6`, `(p0 + 1 + (.. % 5)) % 6`.
- Every intermediate is `i64`. Parameters are table-bounded (`sigma0 <= 16000`, `m in [300, 4000]`, `eps` from a sum of four 16-bit draws, `|eps| <= 3465`, `kappa <= 299`, `|phi| <= 449`, `rho <= 1000`). `kappa * (x - a)` is the largest product.
- Output: `ret` is converted with `clamp(+-(2^31-1))` then `try_from`, so the cast is saturating.
- **What I cannot bound tightly:** the analytic envelope on `|ret|`. Regimes feed back through `rprev` (contraction factor at most 0.45) and mean reversion feeds back through `x - a` (stable). My envelope argument gives `|ret| <~ 1.3e7` in the worst regime sequence (a long trend followed by a switch to mean reversion), which is below `R = 1.68e7` but not by a comfortable margin. I do not rely on it: the VM clamps inputs to `R` regardless, and every generator intermediate stays below `2^50` even at that envelope. The observed maximum over the fuzz run is reported in `evidence/v2_fuzz_main.txt` (a few times 10^5).

## What this audit does not cover

- The program around the VM (`program/src/lib.rs`): account parsing, slices into arena data, CPI. Those paths are exercised by the devnet runs but are not part of this audit.
- Time and compute: a program that is valid and within the work cap cannot abort, but the compute it uses is a separate budget (see the work cap and the metering model).
- `Market::load` / `Seat::load` length preconditions are compile-time asserted in the program, not checked in the VM.
