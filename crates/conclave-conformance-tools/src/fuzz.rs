//! cc-fuzz: hunts for panics, overflow aborts, invariant violations and non-determinism in conclave-vm.
//!   cc-fuzz [--seconds N] [--threads T] [--seed S]        run the fuzzer (build with `--profile fuzz` so panics unwind and overflow checks stay on)
//!   cc-fuzz --repro SEED THREAD ITER                      replay one iteration
//!   cc-fuzz --emit N out.bin [--seed S]                   write N random differential vectors (expected output from the host) for the WASM and SBF runners
//!   cc-fuzz --coverage-corpus corpus.bin                  report which opcodes and events the golden corpus reaches (needs --features cov)
use conclave_conformance::run_vector;
use conclave_conformance_tools::{corpus, *};
use conclave_vm::{validate, work_of, world, Market, Seat, ONE, R_MAX};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{atomic::{AtomicU64, Ordering}, Arc, Mutex};

#[derive(Default, Clone)] struct Stats { iters: u64, ticks: u64, steps: u64, validates: u64, valid: u64, loads: u64, worlds: u64, max_ret: i64, per: [u64; 6] }
struct Finding { scenario: &'static str, thread: u64, iter: u64, what: String }
fn mix(seed: u64, thread: u64, iter: u64) -> u64 { let mut z = seed ^ thread.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ iter.wrapping_mul(0xBF58_476D_1CE4_E5B9); z = (z ^ (z >> 30)).wrapping_mul(0x94D0_49BB_1331_11EB); z ^ (z >> 31) }
fn check_invariants(s: &Seat, m: &Market, what: &str) -> Result<(), String> {
    if s.pos < -ONE || s.pos > ONE { return Err(format!("{}: position {} outside the cap", what, s.pos)); }
    if s.regs.iter().any(|r| *r == i32::MIN) || m.f.iter().any(|v| *v == i32::MIN) { return Err(format!("{}: i32::MIN leaked into a register or feature", what)); }
    if (s.ruined || s.stopped) && s.pos != 0 { return Err(format!("{}: ruined or stopped seat holds a position", what)); }
    Ok(())
}
fn adversarial_returns(rng: &mut Rng, n: usize) -> Vec<i32> { let kind = rng.below(8); (0..n).map(|i| match kind { 0 => rng.next() as i32, 1 => if rng.chance(1, 10) { [i32::MAX, i32::MIN, 1 << 24, -(1 << 24), (1 << 24) + 1][rng.below(5) as usize] } else { 0 }, 2 => [i32::MAX, i32::MIN][(i % 2) as usize], 3 => (rng.below(2_000_001) as i32) - 1_000_000,
    4 => if i % 13 == 0 { (rng.next() as i32) / 3 } else { (rng.below(200) as i32) - 100 }, 5 => ((i as i32) - 75).saturating_mul(rng.below(200_000) as i32), 6 => 0, _ => (rng.below(40_000_000) as i32) - 20_000_000 }).collect() }
fn run_seats_checked(rng: &mut Rng, st: &mut Stats, rets: &[i32], total: u32, progs: &[Vec<u8>], validated: bool, splits: bool) -> Result<(), String> {
    let mut m = Market::new(total); let mut seats: Vec<Seat> = progs.iter().map(|_| Seat::new()).collect();
    for (t, r) in rets.iter().enumerate() {
        if splits && rng.chance(1, 20) { let mut mb = vec![0u8; Market::BYTES]; m.save(&mut mb); let m2 = Market::load(&mb); let mut mb2 = vec![0u8; Market::BYTES]; m2.save(&mut mb2); if mb != mb2 { return Err("market save/load/save is not idempotent on a live state".into()); } m = m2;
            for s in seats.iter_mut() { let mut sb = vec![0u8; Seat::BYTES]; s.save(&mut sb); let s2 = Seat::load(&sb); let mut sb2 = vec![0u8; Seat::BYTES]; s2.save(&mut sb2); if sb != sb2 { return Err("seat save/load/save is not idempotent on a live state".into()); } *s = s2; } }
        let sg0 = m.advance(*r); st.ticks += 1;
        for (s, p) in seats.iter_mut().zip(progs.iter()) { s.step(p, &m, *r, sg0); st.steps += 1; check_invariants(s, &m, "after step")?; if validated && s.work != u64::from(work_of(p)) * (t as u64 + 1) { return Err(format!("metered work {} != static work {} x {} ticks", s.work, work_of(p), t + 1)); } }
    }
    Ok(())
}
fn scenario(seed: u64, thread: u64, iter: u64, st: &mut Stats) -> Result<&'static str, (&'static str, String)> {
    let mut rng = Rng::new(mix(seed, thread, iter)); let pool: &Vec<Vec<u8>> = &POOL;
    let which = rng.below(100);
    if which < 28 { st.per[0] += 1; let ns = rng.range(1, 4) as usize; let progs: Vec<Vec<u8>> = (0..ns).map(|_| if rng.chance(1, 3) { pool[rng.below(pool.len() as u64) as usize].clone() } else { rand_program(&mut rng, 64) }).collect();
        let pack = if rng.chance(1, 8) { rng.next() as usize } else { rng.below(6) as usize }; let mut r = [0i32; world::WORLD_T]; world::gen_episode(pack, world::episode_seed(rng.next(), rng.next(), rng.next()), &mut r); st.worlds += 1; for v in r { st.max_ret = st.max_ret.max(i64::from(v).abs()); }
        let sp = rng.chance(1, 3); return run_seats_checked(&mut rng, st, &r, 150, &progs, true, sp).map(|_| "A generator episodes").map_err(|e| ("A generator episodes", e)); }
    if which < 50 { st.per[1] += 1; let ns = rng.range(1, 3) as usize; let progs: Vec<Vec<u8>> = (0..ns).map(|_| rand_program(&mut rng, 64)).collect(); let n = rng.range(1, 150) as usize; let rets = adversarial_returns(&mut rng, n); let total = if rng.chance(1, 4) { rng.next() as u32 } else { n as u32 };
        return run_seats_checked(&mut rng, st, &rets, total, &progs, true, true).map(|_| "B adversarial returns").map_err(|e| ("B adversarial returns", e)); }
    if which < 68 || which >= 94 { st.per[2] += 1; // byte-level programs, validated or not
        let mut p: Vec<u8> = if which >= 94 { let mut b = pool[rng.below(pool.len() as u64) as usize].clone(); for _ in 0..rng.range(1, 4) { let i = rng.below(b.len() as u64) as usize; if rng.chance(1, 2) { b[i] = rng.byte(); } else { b[i] ^= 1 << rng.below(8); } } b }
            else { let n = rng.below(70) as usize; let mut b = vec![[2u8, 2, 1, 2, 0][rng.below(5) as usize], n as u8, 0, 0]; if rng.chance(1, 20) { b[2] = rng.byte(); } for _ in 0..(4 * n) { b.push(if rng.chance(1, 2) { rng.below(40) as u8 } else { rng.byte() }); } if rng.chance(1, 6) { let cut = rng.below(b.len() as u64 + 1) as usize; b.truncate(cut); } b };
        if rng.chance(1, 50) { p.truncate(rng.below(5) as usize); } st.validates += 1; let ok = validate(&p).is_ok(); if ok { st.valid += 1; }
        let rets = adversarial_returns(&mut rng, 40); let r = run_seats_checked(&mut rng, st, &rets, 150, &[p.clone()], ok, false); // unvalidated blobs go through step on purpose: defence in depth
        return match r { Ok(()) => Ok("C byte-level programs"), Err(e) if !ok && e.contains("metered work") => Ok("C byte-level programs"), Err(e) => Err(("C byte-level programs", e)) }; }
    if which < 84 { st.per[3] += 1; // arbitrary saved state
        let mut mb: Vec<u8> = (0..Market::BYTES).map(|_| rng.byte()).collect(); let mut sb: Vec<u8> = (0..Seat::BYTES).map(|_| rng.byte()).collect();
        match rng.below(4) { 0 => { for c in mb.iter_mut() { *c = [0u8, 0xFF, 0x7F, 0x80][rng.below(4) as usize]; } for c in sb.iter_mut() { *c = [0u8, 0xFF, 0x7F, 0x80][rng.below(4) as usize]; } } 1 => { for c in mb.iter_mut().skip(8) { if rng.chance(2, 3) { *c = 0; } } } _ => {} }
        st.loads += 1; let mut m = Market::load(&mb); let mut s = Seat::load(&sb); let (mut b1, mut b2) = (vec![0u8; Market::BYTES], vec![0u8; Seat::BYTES]); m.save(&mut b1); s.save(&mut b2); let (m2, s2) = (Market::load(&b1), Seat::load(&b2)); let (mut c1, mut c2) = (vec![0u8; Market::BYTES], vec![0u8; Seat::BYTES]); m2.save(&mut c1); s2.save(&mut c2);
        if b1 != c1 || b2 != c2 { return Err(("D arbitrary state", "load is not idempotent: load(save(load(x))) != load(x)".into())); }
        let p = rand_program(&mut rng, 64); for _ in 0..rng.range(1, 12) { let r = [0i32, i32::MAX, i32::MIN, rng.next() as i32, 1, -1][rng.below(6) as usize]; let sg = [0i64, 1, -1, i64::MAX, i64::MIN, rng.next() as i64, 1000][rng.below(7) as usize]; let sg0 = m.advance(r); let _ = sg; s.step(&p, &m, r, if rng.chance(1, 3) { sg } else { sg0 }); st.steps += 1; st.ticks += 1; if let Err(e) = check_invariants(&s, &m, "after step on loaded state") { return Err(("D arbitrary state", e)); } }
        return Ok("D arbitrary state"); }
    st.per[4] += 1; // world generator with arbitrary pack indices and seeds
    let mut r = [0i32; world::WORLD_T]; for _ in 0..4 { let pack = if rng.chance(1, 2) { rng.next() as usize } else { rng.below(6) as usize }; world::gen_episode(pack, world::episode_seed(rng.next(), rng.next(), rng.next()), &mut r); st.worlds += 1; for v in r { st.max_ret = st.max_ret.max(i64::from(v).abs()); if i64::from(v).abs() > i64::from(R_MAX) { return Err(("F generator", format!("generator return {} exceeds the VM input bound", v))); } } }
    let _ = world::season_packs(rng.next(), rng.next()); Ok("F generator")
}
struct PoolHolder(Vec<Vec<u8>>);
impl std::ops::Deref for PoolHolder { type Target = Vec<Vec<u8>>; fn deref(&self) -> &Vec<Vec<u8>> { &self.0 } }
static POOL_CELL: std::sync::OnceLock<PoolHolder> = std::sync::OnceLock::new();
struct PoolRef; impl std::ops::Deref for PoolRef { type Target = Vec<Vec<u8>>; fn deref(&self) -> &Vec<Vec<u8>> { &POOL_CELL.get_or_init(|| PoolHolder(conclave_lab::pool::fixed_pool().into_iter().map(|s| s.code).collect())).0 } }
static POOL: PoolRef = PoolRef;
fn main() {
    let a: Vec<String> = std::env::args().collect(); let get = |k: &str, d: u64| a.iter().position(|x| x == k).and_then(|i| a.get(i + 1)).and_then(|v| v.parse().ok()).unwrap_or(d);
    if let Some(i) = a.iter().position(|x| x == "--coverage-corpus") { let es = corpus::parse(&std::fs::read(&a[i + 1]).unwrap()).unwrap(); for e in &es { let _ = run_vector(&e.input); } print_cov("golden corpus"); return; }
    if let Some(i) = a.iter().position(|x| x == "--emit") { let n: usize = a[i + 1].parse().unwrap(); let seed = get("--seed", 1); let mut rng = Rng::new(seed); let mut es = vec![]; let pool: &Vec<Vec<u8>> = &POOL;
        for k in 0..n { let input = match k % 5 { 0 | 1 => { let ns = rng.range(1, 3) as usize; let ps: Vec<Vec<u8>> = (0..ns).map(|_| if rng.chance(1, 3) { pool[rng.below(pool.len() as u64) as usize].clone() } else { rand_program(&mut rng, 64) }).collect(); let r: Vec<&[u8]> = ps.iter().map(|v| v.as_slice()).collect(); v_trace(rng.below(6) as u8, rng.next(), rng.next(), rng.next() as u32, rng.range(1, 150) as u8, &[], &r) }
            2 => { let p = rand_program(&mut rng, 64); let n = rng.range(1, 80) as usize; v_synth(&adversarial_returns(&mut rng, n), &[], &[&p]) } 3 => { let mut b = vec![[2u8, 2, 1, 0][rng.below(4) as usize], rng.below(70) as u8, 0, 0]; for _ in 0..rng.below(200) { b.push(if rng.chance(1, 2) { rng.below(40) as u8 } else { rng.byte() }); } v_validate(&b) }
            _ => { let mb: Vec<u8> = (0..Market::BYTES).map(|_| rng.byte()).collect(); let sb: Vec<u8> = (0..Seat::BYTES).map(|_| rng.byte()).collect(); v_state(&mb, &sb, rng.next() as i32, rng.next() as i64, &rand_program(&mut rng, 30)) } };
            let output = run_vector(&input); let sbf = input.len() <= 1000 && corpus::est_cu(&input) <= 1_250_000; es.push(corpus::Entry { sbf, label: format!("fuzz-diff {}", k), input, output }); }
        std::fs::write(&a[i + 2], corpus::serialise(&es)).unwrap(); println!("{} differential vectors ({} SBF-eligible) -> {}", es.len(), es.iter().filter(|e| e.sbf).count(), a[i + 2]); return; }
    let seed = get("--seed", 20261124);
    if let Some(i) = a.iter().position(|x| x == "--repro") { let (s, t, it): (u64, u64, u64) = (a[i + 1].parse().unwrap(), a[i + 2].parse().unwrap(), a[i + 3].parse().unwrap()); let mut st = Stats::default(); println!("{:?}", scenario(s, t, it, &mut st)); return; }
    let secs = get("--seconds", 60); let threads = get("--threads", 6); let findings = Arc::new(Mutex::new(Vec::<Finding>::new())); let total = Arc::new(Mutex::new(Stats::default())); let iters = Arc::new(AtomicU64::new(0));
    std::panic::set_hook(Box::new(|_| {})); let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs); let t0 = std::time::Instant::now();
    let hs: Vec<_> = (0..threads).map(|t| { let (f, tot, itc) = (findings.clone(), total.clone(), iters.clone()); std::thread::spawn(move || { let mut st = Stats::default(); let mut i = 0u64;
        while std::time::Instant::now() < deadline { for _ in 0..200 { let r = catch_unwind(AssertUnwindSafe(|| scenario(seed, t, i, &mut st))); st.iters += 1;
            match r { Ok(Ok(_)) => {}, Ok(Err((sc, e))) => { let mut g = f.lock().unwrap(); if g.len() < 40 { g.push(Finding { scenario: sc, thread: t, iter: i, what: e }); } },
                Err(p) => { let msg = p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default(); let mut g = f.lock().unwrap(); if g.len() < 40 { g.push(Finding { scenario: "PANIC", thread: t, iter: i, what: msg }); } } } i += 1; } itc.fetch_add(200, Ordering::Relaxed); }
        let mut g = tot.lock().unwrap(); g.iters += st.iters; g.ticks += st.ticks; g.steps += st.steps; g.validates += st.validates; g.valid += st.valid; g.loads += st.loads; g.worlds += st.worlds; g.max_ret = g.max_ret.max(st.max_ret); for k in 0..6 { g.per[k] += st.per[k]; } }) }).collect();
    for h in hs { h.join().unwrap(); } let s = total.lock().unwrap().clone(); let f = findings.lock().unwrap();
    println!("FUZZ seed {} | {} threads | {:.0}s | iterations {} | market ticks {} | seat steps {} | validate calls {} ({} valid) | state loads {} | generator episodes {} | max |generator return| = {} (VM input bound {})", seed, threads, t0.elapsed().as_secs_f64(), s.iters, s.ticks, s.steps, s.validates, s.valid, s.loads, s.worlds, s.max_ret, R_MAX);
    println!("scenario mix: A generator episodes {} | B adversarial returns {} | C byte-level programs {} | D arbitrary state {} | F generator {}", s.per[0], s.per[1], s.per[2], s.per[3], s.per[4]);
    println!("FINDINGS: {}", f.len()); for x in f.iter() { println!("  [{}] repro: cc-fuzz --repro {} {} {}  ->  {}", x.scenario, seed, x.thread, x.iter, x.what); }
    print_cov("fuzzer"); std::process::exit(if f.is_empty() { 0 } else { 1 });
}
fn print_cov(label: &str) {
    #[cfg(feature = "cov")] { let c = conclave_vm::cov::snapshot(); let names = ["NOP", "LDI", "SIG", "MOV", "ADD", "SUB", "MUL", "DIV", "NEG", "ABS", "SIGN", "MIN", "MAX", "GT", "LT", "AND", "OR", "NOT", "SEL", "GTI", "LTI", "THR", "EMA", "HIST", "WSUM", "VOLW", "ZW", "LONG", "SHORT", "FLAT", "SIZE", "POS", "STOPSET", "STOPCLR"];
        let un: Vec<&str> = (0..34).filter(|i| c[*i] == 0).map(|i| names[i]).collect(); let min = (0..34).map(|i| c[i]).min().unwrap_or(0);
        println!("COVERAGE ({}): opcodes executed {}/34 (min executions {}){}", label, 34 - un.len(), min, if un.is_empty() { String::new() } else { format!(" UNCOVERED: {:?}", un) });
        let mut unev = vec![]; let mut tot = 0; for (i, n) in conclave_vm::cov::NAMES.iter() { tot += 1; if c[*i] == 0 { unev.push(*n); } } println!("COVERAGE ({}): branch/saturation events hit {}/{}{}", label, tot - unev.len(), tot, if unev.is_empty() { String::new() } else { format!(" NOT HIT: {:?}", unev) }); let _ = (c, names); }
    #[cfg(not(feature = "cov"))] { let _ = label; }
}
