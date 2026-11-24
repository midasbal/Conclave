use conclave_lab::{pool::*, run::run_episode};
use conclave_vm::world::NPACK;
use std::io::Write;
struct R(u64); impl R { fn n(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545F4914F6CDD1D) >> 11 } fn pick(&mut self, n: usize) -> usize { (self.n() % n as u64) as usize } }
const TEST_A: u64 = 777; const TEST_B: u64 = 31337; const TRAIN_A: u64 = 4242; const TRAIN_B: u64 = 555;
fn par_eps<F: Fn(usize, u64) -> Vec<i64> + Sync>(jobs: &[(usize, u64)], nstrat: usize, f: F) -> Vec<i64> {
    let nt = 6; let chunk = (jobs.len() + nt - 1) / nt; let mut out = vec![0i64; jobs.len() * nstrat];
    std::thread::scope(|s| { for (jc, oc) in jobs.chunks(chunk).zip(out.chunks_mut(chunk * nstrat)) { let f = &f; s.spawn(move || { for (i, &(p, e)) in jc.iter().enumerate() { let r = f(p, e); oc[i * nstrat..(i + 1) * nstrat].copy_from_slice(&r); } }); } });
    out
}
fn main() {
    let args: Vec<String> = std::env::args().collect(); let m: usize = args.get(1).and_then(|x| x.parse().ok()).unwrap_or(1000); let ncand: usize = args.get(2).and_then(|x| x.parse().ok()).unwrap_or(400); let ntrain: usize = args.get(3).and_then(|x| x.parse().ok()).unwrap_or(40);
    if args.get(1).map(|x| x.as_str()) == Some("pins") { println!("{}", conclave_vm::pins_bytes().iter().map(|b| format!("{:02x}", b)).collect::<String>()); return; }
    if args.get(1).map(|x| x.as_str()) == Some("ruinstats") { // per-episode worst drawdown (running-min PnL) distribution over the fixed pool; run with the ruin floor effectively disabled
        use conclave_vm::{world::{self, WORLD_T}, Market, Seat}; let pool = fixed_pool(); let n = pool.len(); let ths = [20.0, 30.0, 40.0, 60.0, 80.0, 120.0]; let mut cnt = vec![[0u32; 6]; n]; let mut mins: Vec<Vec<f64>> = vec![vec![]; n]; let mut tot = 0u32; let mut ubig = [0u64; 4]; let mut nt = 0u64;
        for p in 0..NPACK { for e in 0..200u64 { let es = world::episode_seed(TEST_A + p as u64, TEST_B, e); let mut r = [0i32; WORLD_T]; world::gen_episode(p, es, &mut r); let mut m = Market::new(WORLD_T as u32); let mut seats: Vec<Seat> = pool.iter().map(|_| Seat::new()).collect(); let mut mn = vec![0i64; n];
            for t in 0..WORLD_T { let sg0 = m.advance(r[t]); let u = (i64::from(r[t]) * 65536 / sg0).abs() as f64 / 65536.0; nt += 1; for (k, th) in [4.0, 8.0, 12.0, 20.0].iter().enumerate() { if u > *th { ubig[k] += 1; } } for (i, s) in seats.iter_mut().enumerate() { s.step(&pool[i].code, &m, r[t], sg0); mn[i] = mn[i].min(s.pnl()); } }
            tot += 1; for i in 0..n { let d = -(mn[i] as f64) / 65536.0; mins[i].push(d); for (k, th) in ths.iter().enumerate() { if d >= *th { cnt[i][k] += 1; } } } } }
        println!("per-tick |u| (vol units) share above 4/8/12/20: {:.5} {:.5} {:.5} {:.5}", ubig[0] as f64 / nt as f64, ubig[1] as f64 / nt as f64, ubig[2] as f64 / nt as f64, ubig[3] as f64 / nt as f64);
        println!("{:16} {:>6} {:>6} {:>6} | share of episodes whose running drawdown reaches 20/30/40/60/80/120 vol-units", "strategy", "p50", "p90", "p99");
        for i in 0..n { mins[i].sort_by(|a, b| a.partial_cmp(b).unwrap()); let q = |f: f64| mins[i][((mins[i].len() as f64 - 1.0) * f) as usize]; println!("{:16} {:6.1} {:6.1} {:6.1} | {}", pool[i].name, q(0.5), q(0.9), q(0.99), cnt[i].iter().map(|c| format!("{:5.1}%", 100.0 * *c as f64 / tot as f64)).collect::<Vec<_>>().join(" ")); } return;
    }
    if args.get(1).map(|x| x.as_str()) == Some("workcheck") { // static work_of == metered Seat.work/tick for every pool program (+ max over pool)
        let pool = fixed_pool(); let progs: Vec<&[u8]> = pool.iter().map(|s| s.code.as_slice()).collect(); let n = pool.len(); let mut w = vec![0u64; n]; let mut o = vec![0i64; n];
        run_episode(&progs, 0, 1, 2, 0, &mut o, Some(&mut w)); let mut bad = 0; let mut mx = 0;
        for i in 0..n { let sw = conclave_vm::work_of(&pool[i].code); mx = mx.max(sw); if u64::from(sw) * 150 != w[i] { bad += 1; println!("MISMATCH {} static {} metered/tick {}", pool[i].name, sw, w[i] as f64 / 150.0); } }
        println!("work_of vs metered: {} programs, {} mismatches, max static work in fixed pool = {}", n, bad, mx); return;
    }
    if args.get(1).map(|x| x.as_str()) == Some("season") { // season <seed_a> <seed_b> <neps> <pool.bin> <idx,idx,...>
        let blob = std::fs::read(&args[5]).unwrap(); let n = u16::from_le_bytes([blob[0], blob[1]]) as usize; let mut off = 2; let mut all: Vec<&[u8]> = vec![];
        for _ in 0..n { let l = u16::from_le_bytes([blob[off], blob[off + 1]]) as usize; off += 2; all.push(&blob[off..off + l]); off += l; }
        let progs: Vec<&[u8]> = args[6].split(',').map(|x| all[x.parse::<usize>().unwrap()]).collect();
        let (t, w) = conclave_lab::run::run_season_wins(&progs, args[2].parse().unwrap(), args[3].parse().unwrap(), args[4].parse().unwrap()); println!("{}", t.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")); println!("{}", w.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")); return;
    }
    if args.get(1).map(|x| x.as_str()) == Some("ref") { // ref <pool.bin> <nticks> <neps> <out.bin> : PnL after nticks for every (pack,ep,strategy), test seeds
        let blob = std::fs::read(&args[2]).unwrap(); let nt: usize = args[3].parse().unwrap(); let ne: u64 = args[4].parse().unwrap(); let n = u16::from_le_bytes([blob[0], blob[1]]) as usize; let mut off = 2; let mut progs: Vec<&[u8]> = vec![];
        for _ in 0..n { let l = u16::from_le_bytes([blob[off], blob[off + 1]]) as usize; off += 2; progs.push(&blob[off..off + l]); off += l; }
        let mut f = std::fs::File::create(&args[5]).unwrap(); for p in 0..NPACK { for e in 0..ne { let mut o = vec![0i64; n]; conclave_lab::run::run_episode_n(&progs, p, TEST_A + p as u64, TEST_B, e, nt, &mut o); for v in o { f.write_all(&v.to_le_bytes()).unwrap(); } } } return;
    }
    if args.get(1).map(|x| x.as_str()) == Some("stats") {
        let pool = fixed_pool(); let progs: Vec<&[u8]> = pool.iter().map(|s| s.code.as_slice()).collect(); let n = pool.len(); let mut work = vec![0u64; n]; let mut o = vec![0i64; n];
        let t = std::time::Instant::now(); let neps = 300u64; for e in 0..neps { let mut w = vec![0u64; n]; run_episode(&progs, (e % 6) as usize, 1, 2, e, &mut o, Some(&mut w)); for i in 0..n { work[i] += w[i]; } } let el = t.elapsed().as_secs_f64();
        for (i, s) in pool.iter().enumerate() { println!("{:16} ops {:2} bytes {:3} regs {:2} metered work/tick {:6.1}", s.name, s.code[1], s.code.len(), s.regs, work[i] as f64 / (neps as f64 * 150.0)); }
        println!("host: {:.1} ns per (strategy,tick) incl. world+market amortised", el * 1e9 / (neps as f64 * 150.0 * n as f64)); return;
    }
    let tag = std::env::var("CV_TAG").unwrap_or_default(); let out = std::env::var("CONCLAVE_OUT").unwrap_or_else(|_| "out".into()); std::fs::create_dir_all(&out).unwrap(); let t0 = std::time::Instant::now(); let mut pool = fixed_pool();
    // ---- tuning (what a competitor would do): random search per family on TRAIN seeds, objective mean PnL; keep top 3 distinct per family
    let fams = tunable(); let mut rng = R(0x1234_5678_9ABC_DEF1);
    let train: Vec<(usize, u64)> = (0..NPACK).flat_map(|p| (0..ntrain as u64).map(move |e| (p, e))).collect();
    let mut tuned_log = String::new();
    for fam in &fams {
        let mut cands: Vec<(Vec<f64>, Vec<u8>, usize)> = vec![]; let mut tries = 0;
        while cands.len() < ncand && tries < ncand * 5 { tries += 1; let p: Vec<f64> = fam.space.iter().map(|s| s[rng.pick(s.len())]).collect(); let a = (fam.build)(&p); let regs = a.peak; if let Some(c) = a.finish() { if !cands.iter().any(|x| x.1 == c) { cands.push((p, c, regs)); } } }
        let progs: Vec<&[u8]> = cands.iter().map(|c| c.1.as_slice()).collect();
        let sums = par_eps(&train, progs.len(), |p, e| { let mut o = vec![0i64; progs.len()]; run_episode(&progs, p, TRAIN_A + p as u64, TRAIN_B, e, &mut o, None); o });
        let mut tot = vec![0f64; progs.len()]; for e in 0..train.len() { for i in 0..progs.len() { tot[i] += sums[e * progs.len() + i] as f64 / 65536.0; } }
        let mut idx: Vec<usize> = (0..progs.len()).collect(); idx.sort_by(|&x, &y| tot[y].partial_cmp(&tot[x]).unwrap());
        tuned_log += &format!("{:8} tried {:4} valid {:4} | best train mean PnL/ep: {:.2} {:.2} {:.2} | median cand {:.2}\n", fam.name, tries, cands.len(), tot[idx[0]] / train.len() as f64, tot[idx[1]] / train.len() as f64, tot[idx[2]] / train.len() as f64, tot[idx[idx.len() / 2]] / train.len() as f64);
        for (rank, &i) in idx.iter().take(3).enumerate() { let (p, c, regs) = &cands[i]; pool.push(Spec { name: format!("{}~T{}", fam.name, rank + 1), tier: fam.tier, fam: Box::leak(fam.name.to_string().into_boxed_str()), tuned: true, params: p.clone(), code: c.clone(), regs: *regs }); }
    }
    eprintln!("tuning done {:.1}s\n{}", t0.elapsed().as_secs_f64(), tuned_log);
    // ---- test bank on fresh seeds
    let n = pool.len(); let progs: Vec<&[u8]> = pool.iter().map(|s| s.code.as_slice()).collect();
    let jobs: Vec<(usize, u64)> = (0..NPACK).flat_map(|p| (0..m as u64).map(move |e| (p, e))).collect();
    let bank = par_eps(&jobs, n, |p, e| { let mut o = vec![0i64; n]; run_episode(&progs, p, TEST_A + p as u64, TEST_B, e, &mut o, None); o });
    eprintln!("bank {}x{}x{} done {:.1}s", NPACK, m, n, t0.elapsed().as_secs_f64());
    let mut f = std::fs::File::create(&format!("{}/real{}_bank.bin",out,tag)).unwrap(); for v in &bank { f.write_all(&v.to_le_bytes()).unwrap(); }
    let mut blob = (n as u16).to_le_bytes().to_vec(); for s in &pool { blob.extend((s.code.len() as u16).to_le_bytes()); blob.extend(&s.code); } std::fs::write(&format!("{}/real{}_pool.bin",out,tag), &blob).unwrap();
    let mut js = String::from("{\"m\":"); js += &m.to_string(); js += ",\"strategies\":[";
    for (i, s) in pool.iter().enumerate() { if i > 0 { js += ","; } js += &format!("{{\"name\":\"{}\",\"tier\":{},\"fam\":\"{}\",\"tuned\":{},\"work\":{},\"ops\":{},\"bytes\":{},\"regs\":{},\"params\":{:?}}}", s.name, s.tier, s.fam, s.tuned, conclave_vm::work_of(&s.code), s.code[1], s.code.len(), s.regs, s.params); }
    js += "]}"; std::fs::write(&format!("{}/real{}_pool.json",out,tag), js).unwrap();
    std::fs::write(&format!("{}/real{}_tuning.txt",out,tag), tuned_log).unwrap();
    println!("pool {} strategies; bank written", n);
}
