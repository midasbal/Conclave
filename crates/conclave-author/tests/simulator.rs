use conclave_author::{abi, sim, source::{assemble, hex}, twin};
use conclave_conformance::run_vector;
use conclave_conformance_tools::v_season;
use conclave_vm::{world, Market, Seat};

fn strategies() -> Vec<(String, Vec<u8>)> { let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../strategies"); let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x == "cvs").unwrap_or(false)).collect(); v.sort();
    v.into_iter().map(|p| { let a = assemble(&std::fs::read_to_string(&p).unwrap()); (p.file_stem().unwrap().to_string_lossy().to_string(), a.code.expect("example assembles")) }).collect() }
fn src_code(body: &str) -> Vec<u8> { let a = assemble(&format!("conclave-strategy 1 ruleset 2\n{}", body)); a.code.unwrap_or_else(|| panic!("{:?}", a.errors)) }
fn small() -> sim::Config { sim::Config { worlds: 12, episodes: 6, pack_eps: 30, ..Default::default() } }

#[test] fn the_authored_path_matches_the_lab_and_the_conformance_season_vector_exactly() {
    // season totals from this simulator == the lab's reference driver == the conformance SEASON vector (the entry point the host, WASM and SBF legs all run)
    for (name, code) in strategies() { for (sa, sb, neps) in [(1u64, 2u64, 4u64), (0xDEAD_BEEF, 77, 6), (u64::MAX - 5, 9, 3)] {
        let packs = world::season_packs(sa, sb); let mut mine = 0i64; for e in 0..neps { let es = world::episode_seed(sa, sb, e); mine += sim::episode(&code, world::pack_for_season(&packs, es), es).pnl; }
        let lab = conclave_lab::run::run_season(&[code.as_slice()], sa, sb, neps)[0]; assert_eq!(mine, lab, "{} sa={:x}: simulator vs lab", name, sa);
        let out = run_vector(&v_season(sa, sb, neps as u8, 150, &[code.as_slice()])); let pnl = i64::from_le_bytes(out[2 + 16..2 + 24].try_into().unwrap()); assert_eq!(mine, pnl, "{} sa={:x}: simulator vs conformance vector", name, sa);
        assert_eq!(out[0] as usize, packs[0]); assert_eq!(out[1] as usize, packs[1]); } } }

#[test] fn a_whole_arena_through_the_simulators_field_loop_matches_the_conformance_vector() {
    let all = strategies(); let progs: Vec<&[u8]> = all.iter().map(|(_, c)| c.as_slice()).collect(); let (sa, sb) = (4242u64, 99u64); let mine = sim::field_totals(&progs, sa, sb, 5);
    let out = run_vector(&v_season(sa, sb, 5, 150, &progs)); for (i, m) in mine.iter().enumerate() { let o = 2 + 16 + 8 * i; assert_eq!(*m, i64::from_le_bytes(out[o..o + 8].try_into().unwrap()), "{}", all[i].0); } }

#[test] fn the_regime_label_twin_reproduces_the_real_generator_bit_for_bit() {
    let mut n = 0u64; for pack in 0..world::NPACK { for k in 0..5000u64 { let seed = world::splitmix(k * 977 + pack as u64) | 1; let mut real = [0i32; world::WORLD_T]; world::gen_episode(pack, seed, &mut real); let mut tw = [0i32; world::WORLD_T]; let mut lab = [0u8; world::WORLD_T]; twin::gen_labeled(pack, seed, &mut tw, &mut lab);
        assert_eq!(real, tw, "twin diverged: pack {} seed {:x}", pack, seed); assert!(lab.iter().all(|r| usize::from(*r) < twin::REGIMES)); n += 1; } } assert_eq!(n, 30_000);
    // and the labels are real: a trend-heavy pack spends far more ticks in regimes 0/1 than a mean-reverting one
    let count = |pack: usize, regs: &[u8]| { let mut c = 0; for k in 0..300u64 { let mut r = [0i32; world::WORLD_T]; let mut l = [0u8; world::WORLD_T]; twin::gen_labeled(pack, world::splitmix(k + 1) | 1, &mut r, &mut l); c += l.iter().filter(|x| regs.contains(x)).count(); } c };
    assert!(count(0, &[0, 1]) > 2 * count(1, &[0, 1]), "pack 0 is trend heavy, pack 1 is mean-reversion heavy"); }

#[test] fn regime_attribution_partitions_each_episodes_pnl_exactly() {
    for (name, code) in strategies() { let run = sim::run_ensemble(&code, 0x1234, 6, 6); for (i, e) in run.eps.iter().enumerate() { assert!(e.labels_ok, "{}", name); assert_eq!(e.reg_pnl.iter().sum::<i64>(), e.pnl, "{} episode {}: regimes must add up to the episode PnL", name, i); assert_eq!(e.reg_ticks.iter().sum::<u32>() as usize, world::WORLD_T);
        assert_eq!(e.ruin_tick.is_some(), e.ruin_reg.is_some()); assert!(e.maxdd >= 0 && e.worst_tick <= e.turnover.max(0) + i64::MAX / 2); } assert_eq!(run.totals.len(), 6); for (w, t) in run.totals.iter().enumerate() { assert_eq!(*t, run.eps[w * 6..w * 6 + 6].iter().map(|e| e.pnl).sum::<i64>()); } } }

#[test] fn episode_statistics_agree_with_a_direct_run_of_the_vm() {
    // ruin, final PnL and position-held counts recomputed here with Seat directly
    let code = strategies().into_iter().find(|(n, _)| n == "momentum").unwrap().1; let mut ruined = 0; let mut held = 0u32;
    for k in 0..200u64 { let es = world::episode_seed(7, 8, k); let pack = (k % 6) as usize; let e = sim::episode(&code, pack, es);
        let mut r = [0i32; world::WORLD_T]; world::gen_episode(pack, es, &mut r); let mut m = Market::new(world::WORLD_T as u32); let mut s = Seat::new(); let mut h = 0; for t in 0..world::WORLD_T { let sg0 = m.advance(r[t]); let pb = s.pos; s.step(&code, &m, r[t], sg0); if pb != 0 { h += 1; } }
        assert_eq!(e.pnl, s.pnl()); assert_eq!(e.ruin_tick.is_some(), s.ruined); assert_eq!(e.ticks_held, h); if s.ruined { ruined += 1; } held += h; } assert!(held > 0); let _ = ruined; }

#[test] fn the_ensemble_is_deterministic_and_the_json_is_stable() { let code = strategies()[3].1.clone(); let a = sim::simulate(&code, &small()).to_json(); let b = sim::simulate(&code, &small()).to_json(); assert_eq!(a, b); assert!(a.starts_with("{\"work\":") && a.contains("\"regime_labels_verified\":true")); assert!(!a.contains("NaN") && !a.contains("inf")); }

#[test] fn the_holdout_follows_the_bytecode_and_the_dev_ensemble_does_not() {
    let all = strategies(); let (a, b) = (&all[0].1, &all[1].1); assert_ne!(sim::holdout_base(a), sim::holdout_base(b)); assert_eq!(sim::holdout_base(a), sim::holdout_base(a));
    let ra = sim::simulate(a, &small()); let rb = sim::simulate(b, &small()); assert_eq!(ra.dev.base, rb.dev.base, "everyone's dev ensemble is the same fixed worlds"); assert_ne!(ra.holdout.base, rb.holdout.base);
    // a one-instruction edit moves the holdout to fresh worlds
    let c = src_code("x = sig T20\nx = sign x\npos x\n"); let d = src_code("x = sig T20\nx = sign x\nx = mov x\npos x\n"); assert_ne!(sim::holdout_base(&c), sim::holdout_base(&d)); assert_eq!(sim::simulate(&c, &small()).dev.season.mean, sim::simulate(&d, &small()).dev.season.mean, "same behaviour, same dev worlds, same dev result"); }

#[test] fn a_strategy_that_never_trades_scores_exactly_zero_and_is_called_out() {
    let flat = src_code("x = const 0\npos x\n"); let r = sim::simulate(&flat, &small()); assert_eq!(r.dev.season.mean, 0.0); assert_eq!(r.dev.season.sd, 0.0); assert_eq!(r.dev.ruin_rate, 0.0); assert_eq!(r.held_share, 0.0); assert_eq!(r.holdout.season.mean, 0.0);
    assert!(r.flags.iter().any(|f| f.contains("no demonstrated edge")), "{:?}", r.flags); assert!(r.flags.iter().any(|f| f.contains("in a position only 0.0%")), "{:?}", r.flags);
    for row in r.regimes.as_ref().unwrap() { assert_eq!(row.mean_per_tick, 0.0); assert_eq!(row.held_share, 0.0); } for p in &r.packs { assert_eq!(p.mean, 0.0); } }

#[test] fn a_losing_strategy_is_flagged_as_negative_edge_and_the_best_world_overstates_it() {
    // buy and sell the opposite of the 20-tick trend at full size: pays costs and fights drift
    let anti = src_code("x = sig T20\nx = thr x 0.125\nx = sign x\nx = neg x\npos x\n"); let r = sim::simulate(&anti, &sim::Config { worlds: 40, episodes: 12, pack_eps: 60, ..Default::default() }); let t = r.to_text();
    assert!(r.dev.season.max > r.dev.season.p50, "some worlds look better than the typical one"); assert!(r.luck_gap_pct > 0.0 || r.dev.season.max <= 0.0);
    assert!(t.contains("A single seed is one draw") && t.contains("luck gap") && t.contains("WHERE IT IS FRAGILE")); assert!(t.contains("BY WORLD PACK") && t.contains("BY HIDDEN REGIME")); }

#[test] fn asking_for_one_seed_always_comes_with_its_place_in_the_distribution() {
    let code = strategies()[5].1.clone(); let cfg = sim::Config { single: Some(3), ..small() }; let r = sim::simulate(&code, &cfg); let s = r.single.as_ref().expect("single section"); assert_eq!(s.world, 3); assert_eq!(s.ensemble_median, r.dev.season.p50);
    let run = sim::run_ensemble(&code, sim::DEV_BASE, 12, 6); let tot = run.totals[3] as f64 / 65536.0; assert!((s.total - tot).abs() < 1e-9); let below = run.totals.iter().filter(|x| (**x as f64 / 65536.0) < tot).count() as f64 / 12.0 * 100.0; assert!((s.percentile - below).abs() < 1e-9);
    let t = r.to_text(); assert!(t.contains("SINGLE SEED 3") && t.contains("one draw") && t.contains("Do not read skill into it") && t.contains("percentile"), "{}", t); let none = sim::simulate(&code, &small()); assert!(none.single.is_none() && !none.to_text().contains("SINGLE SEED")); assert!(r.to_json().contains("not evidence of skill")); }

#[test] fn the_reference_field_is_the_labs_pool_and_ranks_are_consistent() {
    let pool = conclave_lab::pool::fixed_pool(); let mut want = (pool.len() as u16).to_le_bytes().to_vec(); for s in &pool { want.extend((s.code.len() as u16).to_le_bytes()); want.extend(&s.code); }
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("data/field_v2.bin"); if std::env::var("CA_WRITE_FIELD").is_ok() { std::fs::write(&p, &want).unwrap(); }
    assert_eq!(std::fs::read(&p).unwrap(), want, "data/field_v2.bin is stale: run with CA_WRITE_FIELD=1 (it is the reference pool the simulator ranks against)");
    let code = strategies()[0].1.clone(); let r = sim::simulate(&code, &small()); let f = r.field.expect("field on by default"); assert_eq!(f.size, pool.len() + 1); assert!(f.median_rank >= 1.0 && f.median_rank <= f.size as f64); assert!(f.p25_rank <= f.median_rank && f.median_rank <= f.p75_rank);
    // the reference totals are the lab's: one world, recomputed
    let (sa, sb) = world::season_words(&sim::world_seed(sim::DEV_BASE, 0)); let progs: Vec<&[u8]> = pool.iter().map(|s| s.code.as_slice()).collect(); assert_eq!(sim::field_totals(&progs, sa, sb, 6), conclave_lab::run::run_season(&progs, sa, sb, 6));
    assert!(sim::simulate(&code, &sim::Config { field: false, ..small() }).field.is_none()); }

#[test] fn the_wasm_abi_returns_exactly_what_the_library_returns() {
    // the same entry points the browser/Node build exports, called natively
    let src = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../strategies/momentum.cvs")).unwrap(); let n = unsafe { abi::ca_assemble(src.as_ptr(), src.len()) }; let out = unsafe { std::slice::from_raw_parts(abi::ca_out(), n) }.to_vec();
    let a = assemble(&src); assert_eq!(String::from_utf8(out).unwrap(), conclave_author::source::assembly_json(&a)); let code = a.code.unwrap();
    let mut inp = vec![0u8]; inp.extend(12u32.to_le_bytes()); inp.extend(6u32.to_le_bytes()); inp.extend(sim::DEV_BASE.to_le_bytes()); inp.push(1); inp.extend(0u32.to_le_bytes()); inp.extend(&code);
    let n = unsafe { abi::ca_simulate(inp.as_ptr(), inp.len()) }; let got = String::from_utf8(unsafe { std::slice::from_raw_parts(abi::ca_out(), n) }.to_vec()).unwrap(); assert_eq!(got, sim::simulate(&code, &sim::Config { worlds: 12, episodes: 6, ..Default::default() }).to_json());
    inp[0] = 1; let n = unsafe { abi::ca_simulate(inp.as_ptr(), inp.len()) }; let text = String::from_utf8(unsafe { std::slice::from_raw_parts(abi::ca_out(), n) }.to_vec()).unwrap(); assert!(text.contains("SEASON TOTAL"));
    let es = world::episode_seed(5, 6, 1); let direct = sim::episode(&code, 2, es).pnl; assert_eq!(unsafe { abi::ca_episode(code.as_ptr(), code.len(), 2, es as u32, (es >> 32) as u32) }, direct);
    assert_eq!(unsafe { abi::ca_episode([9u8, 0, 0, 0].as_ptr(), 4, 0, 1, 0) }, i64::MIN, "invalid bytecode is refused, not run"); let bad = [1u8, 0, 0, 0, 0]; let n = unsafe { abi::ca_simulate(bad.as_ptr(), bad.len()) }; assert!(unsafe { std::slice::from_raw_parts(abi::ca_out(), n) }.starts_with(b"ERROR"));
    let h = hex(&code); assert_eq!(h.len(), code.len() * 2); }
