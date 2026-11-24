//! Ensemble simulator. Every number comes from running the real `conclave_vm::{Market, Seat}` over returns from the real `conclave_vm::world::gen_episode`, seeded and rotated exactly like
//! the chain does a season (32-byte seed -> season_words -> season_packs -> pack_for_season per episode). Nothing here re-implements the VM.
//!
//! The unit of evidence is the SEASON TOTAL over `episodes` episodes, because that is what the chain ranks. The default view is the distribution over many seeded worlds, never one seed.
//! A second, fresh ensemble ("holdout") is seeded from the hash of the strategy's own bytecode, so it changes with every edit and cannot be tuned against.
use conclave_vm::{world::{self, NPACK, PACKS, WORLD_T}, Market, Seat, COST_Q16, GAP_CAP_VU, RUIN_FLOOR_VU, WORK_CAP};
use crate::twin::{self, REGIMES, REGIME_NAMES};
use crate::json::J;
use sha2::{Digest, Sha256};

pub const DEV_BASE: u64 = 0xC0DE_C1A5_5E11_0001;
const Q: f64 = 65536.0;
/// 44 reference strategies (the lab's fixed pool, bytecode snapshot; a test checks it against the lab) used to say where a strategy would have ranked
static FIELD: &[u8] = include_bytes!("../data/field_v2.bin");

#[derive(Clone, Debug)]
pub struct Config { pub worlds: u32, pub episodes: u32, pub base: u64, pub field: bool, pub pack_eps: u32, pub single: Option<u32> }
impl Default for Config { fn default() -> Self { Config { worlds: 48, episodes: 12, base: DEV_BASE, field: true, pack_eps: 120, single: None } } }

pub fn world_seed(base: u64, i: u32) -> [u8; 32] { let mut s = [0u8; 32]; for k in 0..4u64 { let v = world::splitmix(base ^ (u64::from(i) + 1).wrapping_mul(0xD6E8_FEB8_6659_FD93) ^ k.wrapping_mul(0x9E37_79B9_7F4A_7C15)); s[(8 * k) as usize..(8 * k + 8) as usize].copy_from_slice(&v.to_le_bytes()); } s }
pub fn holdout_base(code: &[u8]) -> u64 { let h = Sha256::digest(code); world::splitmix(u64::from_le_bytes([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]]) ^ 0x484F_4C44_4F55_5421) }

/// everything measured in one episode
#[derive(Clone, Debug)]
pub struct Ep { pub pnl: i64, pub ruin_tick: Option<u8>, pub ruin_reg: Option<u8>, pub maxdd: i64, pub worst_tick: i64, pub gap_ticks: u32, pub big_ticks: u32, pub big_pnl: i64, pub normal_pnl: i64, pub turnover: i64,
    pub reg_pnl: [i64; REGIMES], pub reg_ticks: [u32; REGIMES], pub reg_active: [u32; REGIMES], pub reg_abspos: [i64; REGIMES], pub labels_ok: bool, pub ticks_held: u32 }
/// one episode of one strategy on the real VM. `es` is the episode seed (world::episode_seed).
pub fn episode(code: &[u8], pack: usize, es: u64) -> Ep {
    let mut r = [0i32; WORLD_T]; world::gen_episode(pack, es, &mut r); let mut r2 = [0i32; WORLD_T]; let mut lab = [0u8; WORLD_T]; twin::gen_labeled(pack, es, &mut r2, &mut lab);
    let labels_ok = r == r2;
    let mut m = Market::new(WORLD_T as u32); let mut s = Seat::new();
    let mut e = Ep { pnl: 0, ruin_tick: None, ruin_reg: None, maxdd: 0, worst_tick: 0, gap_ticks: 0, big_ticks: 0, big_pnl: 0, normal_pnl: 0, turnover: 0, reg_pnl: [0; REGIMES], reg_ticks: [0; REGIMES], reg_active: [0; REGIMES], reg_abspos: [0; REGIMES], labels_ok, ticks_held: 0 };
    let mut peak = 0i64;
    for t in 0..WORLD_T {
        let sg0 = m.advance(r[t]); let ur = i64::from(r[t]) * 65536 / sg0.max(1); let before = s.pnl(); let pos_b = s.pos;
        s.step(code, &m, r[t], sg0); let after = s.pnl(); let d = after - before; let rg = usize::from(lab[t]).min(REGIMES - 1);
        if d < e.worst_tick { e.worst_tick = d; } if after > peak { peak = after; } if peak - after > e.maxdd { e.maxdd = peak - after; }
        if ur.abs() > GAP_CAP_VU << 16 && pos_b != 0 { e.gap_ticks += 1; }
        if ur.abs() >= 4 << 16 { e.big_ticks += 1; e.big_pnl += d; } else { e.normal_pnl += d; }
        e.turnover += i64::from((s.pos - pos_b).abs()); if pos_b != 0 { e.ticks_held += 1; }
        if labels_ok { e.reg_pnl[rg] += d; e.reg_ticks[rg] += 1; if pos_b != 0 { e.reg_active[rg] += 1; e.reg_abspos[rg] += i64::from(pos_b.abs()); } }
        if e.ruin_tick.is_none() && s.ruined { e.ruin_tick = Some(t as u8); if labels_ok { e.ruin_reg = Some(rg as u8); } }
    }
    e.pnl = s.pnl(); e
}

#[derive(Clone, Debug, Default)]
pub struct Dist { pub n: usize, pub mean: f64, pub sd: f64, pub min: f64, pub p5: f64, pub p25: f64, pub p50: f64, pub p75: f64, pub p95: f64, pub max: f64, pub pos_share: f64, pub cvar5: f64 }
fn mean(v: &[f64]) -> f64 { if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 } }
fn sd(v: &[f64]) -> f64 { if v.len() < 2 { return 0.0; } let m = mean(v); (v.iter().map(|x| (x - m) * (x - m)).sum::<f64>() / (v.len() - 1) as f64).sqrt() }
fn q(sorted: &[f64], p: f64) -> f64 { if sorted.is_empty() { 0.0 } else { sorted[(((sorted.len() - 1) as f64) * p).round() as usize] } }
pub fn dist(v: &[f64]) -> Dist { let mut s = v.to_vec(); s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); let k = ((s.len() as f64) * 0.05).ceil().max(1.0) as usize;
    Dist { n: s.len(), mean: mean(v), sd: sd(v), min: q(&s, 0.0), p5: q(&s, 0.05), p25: q(&s, 0.25), p50: q(&s, 0.5), p75: q(&s, 0.75), p95: q(&s, 0.95), max: q(&s, 1.0), pos_share: if s.is_empty() { 0.0 } else { s.iter().filter(|x| **x > 0.0).count() as f64 / s.len() as f64 }, cvar5: mean(&s[..k.min(s.len())]) } }
fn tstat(v: &[f64]) -> f64 { let n = v.len() as f64; let s = sd(v); if v.len() < 2 || s == 0.0 { 0.0 } else { mean(v) / (s / n.sqrt()) } }
struct Xs(u64); impl Xs { fn next(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545_F491_4F6C_DD1D) } }
fn bootstrap_ci(v: &[f64], seed: u64) -> (f64, f64) { if v.len() < 2 { return (0.0, 0.0); } let mut g = Xs(seed | 1); let mut ms: Vec<f64> = (0..1000).map(|_| { let mut s = 0.0; for _ in 0..v.len() { s += v[(g.next() % v.len() as u64) as usize]; } s / v.len() as f64 }).collect(); ms.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); (q(&ms, 0.05), q(&ms, 0.95)) }

/// all episodes of an ensemble, grouped by world
pub struct Run { pub totals: Vec<i64>, pub eps: Vec<Ep>, pub per_world: u32, pub seeds: Vec<(u64, u64)> }
pub fn run_ensemble(code: &[u8], base: u64, worlds: u32, episodes: u32) -> Run {
    let mut totals = vec![]; let mut eps = vec![]; let mut seeds = vec![];
    for i in 0..worlds { let (sa, sb) = world::season_words(&world_seed(base, i)); let packs = world::season_packs(sa, sb); seeds.push((sa, sb)); let mut tot = 0i64;
        for e in 0..u64::from(episodes) { let es = world::episode_seed(sa, sb, e); let pack = world::pack_for_season(&packs, es); let ep = episode(code, pack, es); tot += ep.pnl; eps.push(ep); } totals.push(tot); }
    Run { totals, eps, per_world: episodes, seeds }
}

#[derive(Clone, Debug, Default)]
pub struct Ensemble { pub label: String, pub worlds: u32, pub episodes: u32, pub base: u64, pub season: Dist, pub episode: Dist, pub t_edge: f64, pub ci90: (f64, f64), pub ruin_rate: f64, pub maxdd: (f64, f64, f64) }
fn summarise(label: &str, run: &Run, base: u64, worlds: u32, code_seed: u64) -> Ensemble {
    let st: Vec<f64> = run.totals.iter().map(|v| *v as f64 / Q).collect(); let ep: Vec<f64> = run.eps.iter().map(|e| e.pnl as f64 / Q).collect(); let dd: Vec<f64> = { let mut d: Vec<f64> = run.eps.iter().map(|e| e.maxdd as f64 / Q).collect(); d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); d };
    Ensemble { label: label.into(), worlds, episodes: run.per_world, base, season: dist(&st), episode: dist(&ep), t_edge: tstat(&st), ci90: bootstrap_ci(&st, code_seed ^ base), ruin_rate: run.eps.iter().filter(|e| e.ruin_tick.is_some()).count() as f64 / run.eps.len().max(1) as f64, maxdd: (q(&dd, 0.5), q(&dd, 0.9), q(&dd, 0.99)) }
}

#[derive(Clone, Debug)] pub struct PackRow { pub pack: usize, pub mix: [f64; REGIMES], pub n: usize, pub mean: f64, pub sd: f64, pub t: f64, pub p5: f64, pub win_rate: f64, pub ruin_rate: f64 }
#[derive(Clone, Debug)] pub struct RegimeRow { pub regime: usize, pub name: &'static str, pub tick_share: f64, pub held_share: f64, pub mean_abs_pos: f64, pub mean_per_tick: f64, pub t: f64, pub n_eps: usize, pub ruins: u32 }
#[derive(Clone, Debug)] pub struct FieldRow { pub size: usize, pub median_rank: f64, pub p25_rank: f64, pub p75_rank: f64, pub top_tenth_share: f64, pub beats_median_share: f64 }
#[derive(Clone, Debug)] pub struct Single { pub world: u32, pub total: f64, pub percentile: f64, pub ensemble_median: f64 }
#[derive(Clone, Debug)] pub struct Gap { pub capped_ticks_per_10k: f64, pub worst_tick: f64, pub big_ticks_share: f64, pub big_mean: f64, pub normal_mean: f64 }
#[derive(Clone, Debug)] pub struct Report {
    pub work: u32, pub division: Option<u32>, pub ops: usize, pub code_hash: String, pub cfg: Config, pub dev: Ensemble, pub holdout: Ensemble, pub dev_vs_holdout_z: f64, pub halves: (f64, f64),
    pub best_world: f64, pub luck_gap_pct: f64, pub packs: Vec<PackRow>, pub regimes: Option<Vec<RegimeRow>>, pub gap: Gap, pub turnover_per_tick: f64, pub cost_share: f64, pub held_share: f64, pub field: Option<FieldRow>, pub single: Option<Single>, pub flags: Vec<String>, pub labels_ok: bool,
}

fn parse_field() -> Vec<&'static [u8]> { let b = FIELD; if b.len() < 2 { return vec![]; } let n = usize::from(u16::from_le_bytes([b[0], b[1]])); let mut off = 2; let mut v = vec![]; for _ in 0..n { if off + 2 > b.len() { break; } let l = usize::from(u16::from_le_bytes([b[off], b[off + 1]])); off += 2; if off + l > b.len() { break; } v.push(&b[off..off + l]); off += l; } v }
/// totals of the reference strategies over one world (same loop as the chain: shared market, one seat each)
pub fn field_totals(progs: &[&[u8]], sa: u64, sb: u64, episodes: u32) -> Vec<i64> { let packs = world::season_packs(sa, sb); let mut tot = vec![0i64; progs.len()];
    for e in 0..u64::from(episodes) { let es = world::episode_seed(sa, sb, e); let mut r = [0i32; WORLD_T]; world::gen_episode(world::pack_for_season(&packs, es), es, &mut r); let mut m = Market::new(WORLD_T as u32); let mut seats: Vec<Seat> = progs.iter().map(|_| Seat::new()).collect();
        for t in 0..WORLD_T { let sg0 = m.advance(r[t]); for (s, p) in seats.iter_mut().zip(progs.iter()) { s.step(p, &m, r[t], sg0); } } for (i, s) in seats.iter().enumerate() { tot[i] += s.pnl(); } } tot }

/// The whole report. `code` must pass `validate` (the assembler guarantees it).
pub fn simulate(code: &[u8], cfg: &Config) -> Report {
    let work = conclave_vm::work_of(code); let code_hash = crate::source::hex(&Sha256::digest(code)); let cseed = holdout_base(code);
    let dev_run = run_ensemble(code, cfg.base, cfg.worlds, cfg.episodes); let dev = summarise("dev ensemble (fixed seeds)", &dev_run, cfg.base, cfg.worlds, cseed);
    let hbase = holdout_base(code); let hold_run = run_ensemble(code, hbase, cfg.worlds, cfg.episodes); let holdout = summarise("fresh holdout (seeded from this bytecode)", &hold_run, hbase, cfg.worlds, cseed);
    let se = |d: &Ensemble| if d.season.n > 1 { d.season.sd / (d.season.n as f64).sqrt() } else { 0.0 }; let dz = { let den = (se(&dev).powi(2) + se(&holdout).powi(2)).sqrt(); if den == 0.0 { 0.0 } else { (dev.season.mean - holdout.season.mean) / den } };
    let st: Vec<f64> = dev_run.totals.iter().map(|v| *v as f64 / Q).collect(); let ev: Vec<f64> = st.iter().step_by(2).copied().collect(); let od: Vec<f64> = st.iter().skip(1).step_by(2).copied().collect();
    let best = dev.season.max; let med = dev.season.p50; let luck = if best.abs() > 1e-9 { 100.0 * (best - med) / best.abs() } else { 0.0 };
    // per pack: exact (pack forced), same episode count each
    let mut packs = vec![]; for p in 0..NPACK { let (sa, sb) = world::season_words(&world_seed(cfg.base ^ 0x5041_434B, p as u32)); let mut v = vec![]; let mut ruins = 0; for k in 0..u64::from(cfg.pack_eps) { let es = world::episode_seed(sa, sb, k); let e = episode(code, p, es); v.push(e.pnl as f64 / Q); if e.ruin_tick.is_some() { ruins += 1; } }
        let d = dist(&v); let tot_w: f64 = PACKS[p].w.iter().sum::<i64>() as f64; let mut mix = [0.0; REGIMES]; for i in 0..REGIMES { mix[i] = 100.0 * PACKS[p].w[i] as f64 / tot_w; }
        packs.push(PackRow { pack: p, mix, n: v.len(), mean: d.mean, sd: d.sd, t: tstat(&v), p5: d.p5, win_rate: d.pos_share, ruin_rate: ruins as f64 / v.len().max(1) as f64 }); }
    // regime attribution over the dev ensemble; withheld if the twin ever disagreed with the real generator
    let labels_ok = dev_run.eps.iter().chain(hold_run.eps.iter()).all(|e| e.labels_ok);
    let regimes = if labels_ok { let mut rows = vec![]; let all_ticks: f64 = dev_run.eps.iter().map(|e| e.reg_ticks.iter().map(|t| f64::from(*t)).sum::<f64>()).sum();
        for r in 0..REGIMES { let ticks: f64 = dev_run.eps.iter().map(|e| f64::from(e.reg_ticks[r])).sum(); let held: f64 = dev_run.eps.iter().map(|e| f64::from(e.reg_active[r])).sum(); let ap: f64 = dev_run.eps.iter().map(|e| e.reg_abspos[r] as f64).sum(); let pn: f64 = dev_run.eps.iter().map(|e| e.reg_pnl[r] as f64).sum();
            let per: Vec<f64> = dev_run.eps.iter().filter(|e| e.reg_ticks[r] >= 5).map(|e| e.reg_pnl[r] as f64 / Q / f64::from(e.reg_ticks[r])).collect();
            rows.push(RegimeRow { regime: r, name: REGIME_NAMES[r], tick_share: if all_ticks > 0.0 { ticks / all_ticks } else { 0.0 }, held_share: if ticks > 0.0 { held / ticks } else { 0.0 }, mean_abs_pos: if held > 0.0 { ap / held / Q } else { 0.0 }, mean_per_tick: if ticks > 0.0 { pn / ticks / Q } else { 0.0 }, t: tstat(&per), n_eps: per.len(), ruins: dev_run.eps.iter().filter(|e| e.ruin_reg == Some(r as u8)).count() as u32 }); } Some(rows) } else { None };
    let nt: f64 = dev_run.eps.len() as f64 * WORLD_T as f64; let gap = Gap { capped_ticks_per_10k: dev_run.eps.iter().map(|e| f64::from(e.gap_ticks)).sum::<f64>() / nt * 10_000.0, worst_tick: dev_run.eps.iter().map(|e| e.worst_tick).min().unwrap_or(0) as f64 / Q,
        big_ticks_share: dev_run.eps.iter().map(|e| f64::from(e.big_ticks)).sum::<f64>() / nt, big_mean: { let n: f64 = dev_run.eps.iter().map(|e| f64::from(e.big_ticks)).sum(); if n > 0.0 { dev_run.eps.iter().map(|e| e.big_pnl as f64).sum::<f64>() / n / Q } else { 0.0 } },
        normal_mean: { let n = nt - dev_run.eps.iter().map(|e| f64::from(e.big_ticks)).sum::<f64>(); if n > 0.0 { dev_run.eps.iter().map(|e| e.normal_pnl as f64).sum::<f64>() / n / Q } else { 0.0 } } };
    let turnover = dev_run.eps.iter().map(|e| e.turnover as f64).sum::<f64>() / Q / nt; let cost = dev_run.eps.iter().map(|e| e.turnover as f64).sum::<f64>() * (COST_Q16 as f64 / Q) / Q; let net: f64 = dev_run.eps.iter().map(|e| e.pnl as f64).sum::<f64>() / Q; let gross = net + cost;
    let held_share = dev_run.eps.iter().map(|e| f64::from(e.ticks_held)).sum::<f64>() / nt;
    let field = if cfg.field { let progs = parse_field(); if progs.is_empty() { None } else { let mut ranks = vec![]; for (i, (sa, sb)) in dev_run.seeds.iter().enumerate() { let t = field_totals(&progs, *sa, *sb, cfg.episodes); let mine = dev_run.totals[i]; ranks.push(1.0 + t.iter().filter(|x| **x >= mine).count() as f64); }
        let mut s = ranks.clone(); s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)); let n = progs.len() as f64 + 1.0;
        Some(FieldRow { size: progs.len() + 1, median_rank: q(&s, 0.5), p25_rank: q(&s, 0.25), p75_rank: q(&s, 0.75), top_tenth_share: ranks.iter().filter(|r| **r <= (n * 0.1).ceil()).count() as f64 / ranks.len().max(1) as f64, beats_median_share: ranks.iter().filter(|r| **r <= (n / 2.0).floor()).count() as f64 / ranks.len().max(1) as f64 }) } } else { None };
    let single = cfg.single.filter(|i| *i < cfg.worlds).map(|i| { let tot = st[i as usize]; Single { world: i, total: tot, percentile: 100.0 * st.iter().filter(|x| **x < tot).count() as f64 / st.len() as f64, ensemble_median: dev.season.p50 } });
    // fragility: where the evidence says this strategy is weak, not only where it is strong
    let mut flags = vec![]; let pc = |x: f64| format!("{:.1}%", 100.0 * x);
    if dev.ci90.0 <= 0.0 && dev.ci90.1 >= 0.0 { flags.push(format!("no demonstrated edge: the 90% interval for the mean season total ({:+.1} to {:+.1} vol-units) includes zero", dev.ci90.0, dev.ci90.1)); }
    else if dev.ci90.1 < 0.0 { flags.push(format!("negative edge: the 90% interval for the mean season total is {:+.1} to {:+.1} vol-units", dev.ci90.0, dev.ci90.1)); }
    if dz.abs() >= 2.0 { flags.push(format!("the fresh holdout disagrees with the dev ensemble by {:.1} standard errors (dev mean {:+.1}, holdout mean {:+.1}): the dev result is probably luck or has been tuned to", dz.abs(), dev.season.mean, holdout.season.mean)); }
    if ev.len() > 3 && od.len() > 3 && (mean(&ev) > 0.0) != (mean(&od) > 0.0) { flags.push(format!("the edge changes sign between two halves of the dev worlds ({:+.1} vs {:+.1}): not stable", mean(&ev), mean(&od))); }
    if dev.ruin_rate >= 0.01 { let mut worst = None; if let Some(rs) = &regimes { worst = rs.iter().max_by_key(|r| r.ruins); } flags.push(format!("hits the ruin floor (-{} vol-units) in {} of episodes{}", RUIN_FLOOR_VU, pc(dev.ruin_rate), worst.filter(|r| r.ruins > 0).map(|r| format!(", most often in '{}'", r.name)).unwrap_or_default())); }
    for p in &packs { if p.mean < 0.0 && p.t <= -2.0 { flags.push(format!("loses money in world pack {} (mean {:+.2} per episode, t {:.1})", p.pack, p.mean, p.t)); } }
    if let Some(rs) = &regimes { for r in rs { if r.n_eps >= 30 && r.mean_per_tick < 0.0 && r.t <= -2.0 { flags.push(format!("loses money in the '{}' regime ({:+.4} vol-units per tick, t {:.1}); that regime is {} of ticks", r.name, r.mean_per_tick, r.t, pc(r.tick_share))); } } }
    if dev.episode.mean > 0.0 && dev.episode.cvar5 < -6.0 * dev.episode.mean { flags.push(format!("heavy left tail: the worst 5% of episodes average {:+.1} against a mean of {:+.2}", dev.episode.cvar5, dev.episode.mean)); }
    if gross > 0.0 && cost / gross > 0.5 { flags.push(format!("turnover eats {} of gross profit in transaction cost", pc(cost / gross))); }
    if gap.big_mean < 0.0 && gap.normal_mean > 0.0 && gap.big_ticks_share > 0.0 { flags.push(format!("gives back on big-move ticks ({:+.3} per tick on |move| >= 4 vol-units vs {:+.4} otherwise)", gap.big_mean, gap.normal_mean)); }
    if held_share < 0.1 { flags.push(format!("in a position only {} of the time: the result rests on very few decisions", pc(held_share))); }
    if work > WORK_CAP { flags.push("over the work cap: this would be refused on chain".into()); }
    Report { work, division: crate::source::division_for(work), ops: usize::from(code.get(1).copied().unwrap_or(0)), code_hash, cfg: cfg.clone(), dev, holdout, dev_vs_holdout_z: dz, halves: (mean(&ev), mean(&od)), best_world: best, luck_gap_pct: luck, packs, regimes, gap, turnover_per_tick: turnover, cost_share: if gross > 0.0 { cost / gross } else { 0.0 }, held_share, field, single, flags, labels_ok }
}

fn f(x: f64) -> String { format!("{:+.2}", x) }
impl Report {
    pub fn to_text(&self) -> String {
        let c = &self.cfg; let mut o = String::new(); let d = &self.dev; let h = &self.holdout;
        o += &format!("STRATEGY  {} ops, work {} of {} cap, {}  (bytecode sha256 {}...)\n", self.ops, self.work, WORK_CAP, match self.division { Some(v) => format!("fits division {}", v), None => "OVER THE CAP".into() }, &self.code_hash[..16]);
        o += &format!("\nHOW TO READ THIS\n  A single seed is one draw from a distribution: it measures luck as much as skill. Everything below is the distribution over {} seeded worlds x {} episodes ({} episodes),\n  the unit the chain ranks (a season total). Hunting for a good seed teaches nothing; the question is whether the whole distribution is on your side.\n", c.worlds, c.episodes, d.season.n as u32 * c.episodes);
        o += &format!("\nSEASON TOTAL (vol-units, sum of {} episodes), {} worlds\n  mean {}   median {}   sd {:.1}   positive in {:.0}% of worlds\n  p5 {}   p25 {}   p75 {}   p95 {}   worst {}   best {}\n  edge: mean/stderr = {:.2} ; 90% interval for the mean {} to {}\n", c.episodes, d.season.n, f(d.season.mean), f(d.season.p50), d.season.sd, 100.0 * d.season.pos_share, f(d.season.p5), f(d.season.p25), f(d.season.p75), f(d.season.p95), f(d.season.min), f(d.season.max), d.t_edge, f(d.ci90.0), f(d.ci90.1));
        o += &format!("  luck gap: the best world ({}) is {:.0}% above the median world ({}). Showing only that one would overstate the strategy by that much.\n", f(self.best_world), self.luck_gap_pct.max(0.0), f(d.season.p50));
        o += &format!("\nFRESH HOLDOUT (worlds seeded from this exact bytecode, so they change with every edit and cannot be tuned against)\n  mean {} median {} p5 {} p95 {} ; difference from dev {:+.1} standard errors\n", f(h.season.mean), f(h.season.p50), f(h.season.p5), f(h.season.p95), self.dev_vs_holdout_z);
        o += &format!("  stability: even-numbered dev worlds mean {} vs odd-numbered {}\n", f(self.halves.0), f(self.halves.1));
        o += &format!("\nPER EPISODE\n  mean {} sd {:.2} win rate {:.0}% ; worst 5% average {}\n  running drawdown (vol-units) median {:.1}  p90 {:.1}  p99 {:.1}\n  ruin floor (-{}): hit in {:.1}% of episodes\n", f(d.episode.mean), d.episode.sd, 100.0 * d.episode.pos_share, f(d.episode.cvar5), d.maxdd.0, d.maxdd.1, d.maxdd.2, RUIN_FLOOR_VU, 100.0 * d.ruin_rate);
        o += &format!("  holds a position {:.0}% of ticks ; turnover {:.3} position-units per tick ; transaction cost is {:.0}% of gross profit\n", 100.0 * self.held_share, self.turnover_per_tick, 100.0 * self.cost_share);
        o += &format!("\nGAPS AND JUMPS\n  worst single tick {:+.1} vol-units ; ticks at the {}-vol-unit gap cap while in a position: {:.1} per 10,000\n  on big-move ticks (|move| >= 4 vol-units, {:.1}% of ticks): {:+.4} per tick, vs {:+.4} on all other ticks\n", self.gap.worst_tick, GAP_CAP_VU, self.gap.capped_ticks_per_10k, 100.0 * self.gap.big_ticks_share, self.gap.big_mean, self.gap.normal_mean);
        o += &format!("\nBY WORLD PACK (exact: each pack forced, {} episodes each; a season draws 2 of these 6 after lock, so you do not choose)\n   pack  regime mix (up/down/revert/chop/slide/rally/noise %)   mean/ep     sd   t     p5   win%  ruin%\n", c.pack_eps);
        for p in &self.packs { o += &format!("   {:>3}   {:>3.0}/{:>3.0}/{:>3.0}/{:>3.0}/{:>3.0}/{:>3.0}/{:>3.0}                         {:>7} {:>6.2} {:>5.1} {:>6.1} {:>5.0} {:>5.1}\n", p.pack, p.mix[0], p.mix[1], p.mix[2], p.mix[3], p.mix[4], p.mix[5], p.mix[6], f(p.mean), p.sd, p.t, p.p5, 100.0 * p.win_rate, 100.0 * p.ruin_rate); }
        match &self.regimes { Some(rs) => { o += "\nBY HIDDEN REGIME (every tick of the dev ensemble attributed to the regime that generated it; strategies never see regimes)\n   regime                          ticks   held  avg|pos|   PnL/tick      t   ruins\n"; for r in rs { o += &format!("   {} {:<30} {:>5.1}% {:>5.0}% {:>8.2} {:>10.4} {:>6.1} {:>6}\n", r.regime, r.name, 100.0 * r.tick_share, 100.0 * r.held_share, r.mean_abs_pos, r.mean_per_tick, r.t, r.ruins); } }
            None => { o += "\nBY HIDDEN REGIME: withheld. The label twin of the generator disagreed with the real generator on some episode, so regime attribution cannot be trusted. Everything else is unaffected.\n"; } }
        if let Some(fr) = &self.field { o += &format!("\nAGAINST THE REFERENCE FIELD ({} strategies: you plus the 44 pool strategies), per dev world\n  rank median {:.0} (p25 {:.0}, p75 {:.0}); top 10% in {:.0}% of worlds; in the top half in {:.0}% of worlds. Ties rank behind.\n", fr.size, fr.median_rank, fr.p25_rank, fr.p75_rank, 100.0 * fr.top_tenth_share, 100.0 * fr.beats_median_share); }
        if let Some(s) = &self.single { o += &format!("\nSINGLE SEED {} (you asked for one world)\n  *** one draw. Its season total is {}: percentile {:.0} of the {} dev worlds, ensemble median {}. Do not read skill into it. ***\n", s.world, f(s.total), s.percentile, c.worlds, f(s.ensemble_median)); }
        o += "\nWHERE IT IS FRAGILE\n"; if self.flags.is_empty() { o += "  none of these checks flagged anything (that is not a guarantee: the field and the next season's packs are different draws)\n"; } else { for x in &self.flags { o += &format!("  - {}\n", x); } }
        o
    }
    pub fn to_json(&self) -> String {
        let dist = |d: &Dist| J::obj(vec![("n", J::n(d.n as f64)), ("mean", J::n(d.mean)), ("sd", J::n(d.sd)), ("min", J::n(d.min)), ("p5", J::n(d.p5)), ("p25", J::n(d.p25)), ("p50", J::n(d.p50)), ("p75", J::n(d.p75)), ("p95", J::n(d.p95)), ("max", J::n(d.max)), ("positive_share", J::n(d.pos_share)), ("cvar5", J::n(d.cvar5))]);
        let ens = |e: &Ensemble| J::obj(vec![("label", J::s(&e.label)), ("worlds", J::n(f64::from(e.worlds))), ("episodes_per_world", J::n(f64::from(e.episodes))), ("base", J::s(&format!("{:016x}", e.base))), ("season_total", dist(&e.season)), ("episode", dist(&e.episode)), ("edge_t", J::n(e.t_edge)), ("ci90_mean", J::arr(vec![J::n(e.ci90.0), J::n(e.ci90.1)])), ("ruin_rate", J::n(e.ruin_rate)), ("drawdown_p50_p90_p99", J::arr(vec![J::n(e.maxdd.0), J::n(e.maxdd.1), J::n(e.maxdd.2)]))]);
        J::obj(vec![("work", J::n(f64::from(self.work))), ("work_cap", J::n(f64::from(WORK_CAP))), ("division", match self.division { Some(d) => J::n(f64::from(d)), None => J::Null }), ("ops", J::n(self.ops as f64)), ("code_sha256", J::s(&self.code_hash)),
            ("config", J::obj(vec![("worlds", J::n(f64::from(self.cfg.worlds))), ("episodes", J::n(f64::from(self.cfg.episodes))), ("base", J::s(&format!("{:016x}", self.cfg.base))), ("field", J::Bool(self.cfg.field)), ("pack_episodes", J::n(f64::from(self.cfg.pack_eps)))])),
            ("dev", ens(&self.dev)), ("holdout", ens(&self.holdout)), ("dev_vs_holdout_z", J::n(self.dev_vs_holdout_z)), ("halves", J::arr(vec![J::n(self.halves.0), J::n(self.halves.1)])), ("best_world", J::n(self.best_world)), ("luck_gap_pct", J::n(self.luck_gap_pct)),
            ("packs", J::arr(self.packs.iter().map(|p| J::obj(vec![("pack", J::n(p.pack as f64)), ("regime_mix_pct", J::arr(p.mix.iter().map(|x| J::n(*x)).collect())), ("n", J::n(p.n as f64)), ("mean", J::n(p.mean)), ("sd", J::n(p.sd)), ("t", J::n(p.t)), ("p5", J::n(p.p5)), ("win_rate", J::n(p.win_rate)), ("ruin_rate", J::n(p.ruin_rate))])).collect())),
            ("regimes", match &self.regimes { Some(rs) => J::arr(rs.iter().map(|r| J::obj(vec![("regime", J::n(r.regime as f64)), ("name", J::s(r.name)), ("tick_share", J::n(r.tick_share)), ("held_share", J::n(r.held_share)), ("mean_abs_pos", J::n(r.mean_abs_pos)), ("pnl_per_tick", J::n(r.mean_per_tick)), ("t", J::n(r.t)), ("episodes", J::n(r.n_eps as f64)), ("ruins", J::n(f64::from(r.ruins)))])).collect()), None => J::Null }),
            ("gap", J::obj(vec![("capped_ticks_per_10k", J::n(self.gap.capped_ticks_per_10k)), ("worst_tick", J::n(self.gap.worst_tick)), ("big_move_tick_share", J::n(self.gap.big_ticks_share)), ("big_move_pnl_per_tick", J::n(self.gap.big_mean)), ("other_pnl_per_tick", J::n(self.gap.normal_mean))])),
            ("turnover_per_tick", J::n(self.turnover_per_tick)), ("cost_share_of_gross", J::n(self.cost_share)), ("held_share", J::n(self.held_share)),
            ("field", match &self.field { Some(x) => J::obj(vec![("size", J::n(x.size as f64)), ("median_rank", J::n(x.median_rank)), ("p25_rank", J::n(x.p25_rank)), ("p75_rank", J::n(x.p75_rank)), ("top_tenth_share", J::n(x.top_tenth_share)), ("top_half_share", J::n(x.beats_median_share))]), None => J::Null }),
            ("single_seed", match &self.single { Some(s) => J::obj(vec![("world", J::n(f64::from(s.world))), ("total", J::n(s.total)), ("percentile", J::n(s.percentile)), ("ensemble_median", J::n(s.ensemble_median)), ("warning", J::s("one draw from the distribution, not evidence of skill"))]), None => J::Null }),
            ("fragility", J::arr(self.flags.iter().map(|x| J::s(x)).collect())), ("regime_labels_verified", J::Bool(self.labels_ok))]).to_string()
    }
}
