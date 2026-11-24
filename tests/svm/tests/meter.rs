//! Work-metered Advance on a full 20-seat arena of worst-case strategies, measured with the SVM's own compute meter.
mod common;
use common::*;

fn worst() -> Vec<u8> { let mut ops: Vec<[u8; 4]> = (0..63).map(|i| [conclave_vm::op::EMA, 1 + (i % 12) as u8, 0, 3]).collect(); ops.push([conclave_vm::op::POS, 0, 1, 0]); let c = conclave_conformance_tools::assemble(&ops); assert_eq!(conclave_vm::work_of(&c), 64); c }
fn arena20(e: &mut Env, sid: u64, neps: u32) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); assert!(e.create_season(&mut s, neps, 0, 20, false, 2).is_ok());
    let code = worst(); for i in 0..20 { let st = e.register_and_seal(i % 5, "worst", code.clone()); assert!(e.enter(&mut s, &st).is_ok()); } assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); let mut seed = [0u8; 32]; for (i, b) in seed.iter_mut().enumerate() { *b = (i as u8).wrapping_mul(13) ^ 0x71; } assert!(e.deliver_seed(&mut s, seed).is_ok()); e.warp(2_000_000); s }

#[test] fn worst_case_full_arena_never_exceeds_the_cap_and_adapts_to_the_budget() {
    let mut e = Env::new(5); let mut report = vec![];
    for (budget_k, cu) in [(1400u16, 1_400_000u32), (900, 900_000), (650, 650_000)] {
        let sid = 500 + u64::from(budget_k); let s = arena20(&mut e, sid, 2); let mut txs = 0; let mut max_cu = 0u64; let mut start_cu = 0u64;
        while e.flags(&s) & F_DONE == 0 { e.fresh_blockhash(); let before = e.ticks(&s); let r = e.advance(&s, budget_k, cu); assert!(r.is_ok(), "budget {}k: {}", budget_k, err_string(&r)); let m = r.unwrap(); if before == 0 { start_cu = m.compute_units_consumed; } max_cu = max_cu.max(m.compute_units_consumed); txs += 1; assert!(e.ticks(&s) > before, "every metered call makes progress at budget {}k", budget_k); assert!(txs < 1000); }
        assert!(max_cu <= u64::from(cu), "consumed {} of limit {}", max_cu, cu); report.push(format!("budget {}k limit {}: {} Advance txs for {} ticks ({:.1} per tx), max compute used {} ({:.0}% of its limit), episode-start tx {}", budget_k, cu, txs, e.ticks(&s), f64::from(e.ticks(&s)) / txs as f64, max_cu, 100.0 * max_cu as f64 / f64::from(cu), start_cu)); }
    for l in &report { println!("METER {}", l); }
    // too small a budget: no progress, no failure
    let s = arena20(&mut e, 777, 1); for _ in 0..3 { e.fresh_blockhash(); let r = e.advance(&s, 300, 300_000); assert!(r.is_ok(), "{}", err_string(&r)); } assert_eq!(e.ticks(&s), 0, "a 300k budget cannot fit an episode start, so nothing runs"); assert_eq!(e.flags(&s) & F_DONE, 0);
    // a caller that overstates its budget fails safely and leaves the arena untouched
    let before = e.data(&s.arena); let r = e.advance(&s, 1400, 200_000); assert!(r.is_err(), "claimed 1400k with a 200k limit"); assert!(e.data(&s.arena) == before, "a failed Advance changes nothing"); e.fresh_blockhash(); assert!(e.advance(&s, 1400, 1_400_000).is_ok(), "and the same arena can then be driven correctly");
}
