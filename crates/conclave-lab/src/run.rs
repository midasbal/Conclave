use conclave_vm::{world::{self, WORLD_T}, Market, Seat};
/// Run all programs through one episode. Returns per-program final PnL (Q16 vol-units, mark-to-market) in `out`, and metered work into `work`.
pub fn run_episode(progs: &[&[u8]], pack: usize, seed_a: u64, seed_b: u64, ep: u64, out: &mut [i64], work: Option<&mut [u64]>) {
    let mut r = [0i32; WORLD_T]; world::gen_episode(pack, world::episode_seed(seed_a, seed_b, ep), &mut r);
    let mut m = Market::new(WORLD_T as u32); let mut seats: Vec<Seat> = progs.iter().map(|_| Seat::new()).collect();
    for t in 0..WORLD_T { let sg0 = m.advance(r[t]); for (s, p) in seats.iter_mut().zip(progs.iter()) { s.step(p, &m, r[t], sg0); } }
    for (i, s) in seats.iter().enumerate() { out[i] = s.pnl(); }
    if let Some(w) = work { for (i, s) in seats.iter().enumerate() { w[i] = s.work; } }
}

/// Same as run_episode but stops after `nticks` ticks (market still believes the episode is WORLD_T long). Used for SBF parity on heavy strategies.
pub fn run_episode_n(progs: &[&[u8]], pack: usize, seed_a: u64, seed_b: u64, ep: u64, nticks: usize, out: &mut [i64]) {
    let mut r = [0i32; WORLD_T]; world::gen_episode(pack, world::episode_seed(seed_a, seed_b, ep), &mut r);
    let mut m = Market::new(WORLD_T as u32); let mut seats: Vec<Seat> = progs.iter().map(|_| Seat::new()).collect();
    for t in 0..nticks.min(WORLD_T) { let sg0 = m.advance(r[t]); for (s, p) in seats.iter_mut().zip(progs.iter()) { s.step(p, &m, r[t], sg0); } }
    for (i, s) in seats.iter().enumerate() { out[i] = s.pnl(); }
}

/// Local reference for the on-chain driver: same seed words, same pack rotation, same per-episode reset. Returns season totals (Q16 vol-units).
pub fn run_season(progs: &[&[u8]], sa: u64, sb: u64, neps: u64) -> Vec<i64> {
    let mut tot = vec![0i64; progs.len()]; let sp = world::season_packs(sa, sb);
    for ep in 0..neps { let es = world::episode_seed(sa, sb, ep); let mut r = [0i32; WORLD_T]; world::gen_episode(world::pack_for_season(&sp, es), es, &mut r);
        let mut m = Market::new(WORLD_T as u32); let mut seats: Vec<Seat> = progs.iter().map(|_| Seat::new()).collect();
        for t in 0..WORLD_T { let sg0 = m.advance(r[t]); for (s, p) in seats.iter_mut().zip(progs.iter()) { s.step(p, &m, r[t], sg0); } }
        for (i, s) in seats.iter().enumerate() { tot[i] += s.pnl(); } }
    tot
}

/// Per-strategy season totals plus the number of episodes each won (ties -> lowest slot). The wins tally is a lab statistic only: the program ranks by totals, in both phases.
pub fn run_season_wins(progs: &[&[u8]], sa: u64, sb: u64, neps: u64) -> (Vec<i64>, Vec<u32>) {
    let mut tot = vec![0i64; progs.len()]; let mut wins = vec![0u32; progs.len()]; let sp = world::season_packs(sa, sb);
    for ep in 0..neps { let es = world::episode_seed(sa, sb, ep); let mut r = [0i32; WORLD_T]; world::gen_episode(world::pack_for_season(&sp, es), es, &mut r);
        let mut m = Market::new(WORLD_T as u32); let mut seats: Vec<Seat> = progs.iter().map(|_| Seat::new()).collect();
        for t in 0..WORLD_T { let sg0 = m.advance(r[t]); for (s, p) in seats.iter_mut().zip(progs.iter()) { s.step(p, &m, r[t], sg0); } }
        let mut best = 0; for (i, s) in seats.iter().enumerate() { tot[i] += s.pnl(); if s.pnl() > seats[best].pnl() { best = i; } } wins[best] += 1; }
    (tot, wins)
}
