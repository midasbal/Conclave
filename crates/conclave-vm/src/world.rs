//! World generator v2 (7 regimes, switching, vol clustering, jumps, 6 packs). Integer only, deterministic from a u64 episode seed.
//! Port of sim/world/world2.mjs. Returns are ppm (1e-6) per tick.
pub const WORLD_T: usize = 150;
pub const NPACK: usize = 6;
const VMULT: [i64; 7] = [1000, 1000, 900, 700, 2300, 2300, 1200];
const LAM: [i64; 7] = [30, 30, 30, 30, 200, 200, 400];
pub struct Pack { pub w: [i64; 7], pub vol: (i64, i64), pub psw: (i64, i64), pub jm_milli: i64, pub drift_milli: i64, pub rho: (i64, i64) }
pub const PACKS: [Pack; NPACK] = [
    Pack { w: [270, 270, 60, 80, 60, 60, 200], vol: (6000, 11000), psw: (8, 30), jm_milli: 1000, drift_milli: 1000, rho: (0, 700) },
    Pack { w: [50, 50, 330, 330, 40, 40, 160], vol: (5000, 9000), psw: (10, 35), jm_milli: 1000, drift_milli: 1000, rho: (0, 700) },
    Pack { w: [60, 60, 140, 140, 170, 170, 260], vol: (9000, 16000), psw: (20, 60), jm_milli: 1500, drift_milli: 1000, rho: (400, 1000) },
    Pack { w: [80, 80, 200, 200, 80, 80, 280], vol: (6000, 12000), psw: (60, 120), jm_milli: 1000, drift_milli: 1000, rho: (0, 700) },
    Pack { w: [180, 180, 160, 260, 30, 30, 160], vol: (3000, 6000), psw: (10, 25), jm_milli: 1000, drift_milli: 500, rho: (0, 700) },
    Pack { w: [143, 143, 143, 143, 143, 143, 142], vol: (5000, 12000), psw: (20, 50), jm_milli: 1000, drift_milli: 1000, rho: (0, 700) },
];
pub fn splitmix(z: u64) -> u64 {
    let z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
pub fn episode_seed(seed_a: u64, seed_b: u64, ep: u64) -> u64 {
    let s = splitmix(seed_a ^ seed_b.rotate_left(17) ^ ep.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    if s == 0 { 1 } else { s }
}
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33 }
    fn u(&mut self, m: i64) -> i64 { i64::try_from(self.next() % m.unsigned_abs().max(1)).unwrap_or(i64::MAX) }
}
/// Fill `out` with 150 per-tick returns (ppm) for `pack`, from `seed`. Regime ids are not exposed to strategies.
pub fn gen_episode(pack: usize, seed: u64, out: &mut [i32; WORLD_T]) {
    let p = &PACKS[pack % NPACK];
    let mut g = Rng(seed);
    let sigma0 = p.vol.0 + g.u(p.vol.1 - p.vol.0 + 1);
    let psw = p.psw.0 + g.u(p.psw.1 - p.psw.0 + 1);
    let mtr = sigma0 * (150 + g.u(350)) * p.drift_milli / 1_000_000;
    let phi_tr = -50 + g.u(200);
    let kappa = 80 + g.u(220);
    let phi_ch = -(150 + g.u(300));
    let mc = sigma0 * (500 + g.u(500)) / 1000;
    let rho = p.rho.0 + g.u(p.rho.1 - p.rho.0 + 1);
    let pick = |u: i64| -> usize { let mut c = 0; for i in 0..7 { c += p.w[i]; if u < c { return i; } } 6 };
    let mut reg = pick(g.u(1000));
    let (mut x, mut a, mut m, mut rprev, mut pend, mut pend_n) = (0i64, 0i64, 1000i64, 0i64, 0i64, 0i32);
    for slot in out.iter_mut() {
        if g.u(1000) < psw { reg = pick(g.u(1000)); }
        let mut s = 0i64; for _ in 0..4 { s += g.u(65536); }
        let eps = (s - 131070) * 1000 / 37837;
        let d = match reg {
            0 => mtr + phi_tr * (rprev - mtr) / 1000,
            1 => -mtr + phi_tr * (rprev + mtr) / 1000,
            2 => -(kappa * (x - a) / 1000),
            3 => phi_ch * rprev / 1000,
            4 => -mc + phi_tr * (rprev + mc) / 1000,
            5 => mc + phi_tr * (rprev - mc) / 1000,
            _ => 0,
        };
        let sig = sigma0 * m / 1000;
        let mut j = 0i64;
        let lam = LAM[reg] * p.jm_milli / 1000;
        if g.u(10000) < lam {
            let ju = g.u(1000); let sd = g.u(1000);
            let mag = sig * (3000 + 3 * ju) / 1000;
            let bias = if reg == 4 { 700 } else if reg == 5 { 300 } else { 500 };
            j = if sd < bias { -mag } else { mag };
            pend = -rho * j / 5000; pend_n = 5;
        }
        let mut ret = d + sig * eps / 1000 + j;
        if pend_n > 0 { ret += pend; pend_n -= 1; }
        *slot = i32::try_from(ret.clamp(-(i32::MAX as i64), i32::MAX as i64)).unwrap_or(0);
        x += ret; a += (x - a) / 32; rprev = ret;
        m = m + (VMULT[reg] - m) / 8 + ((eps.abs() - 800) * m / 5000);
        m = m.clamp(300, 4000);
    }
}

/// Which world pack an episode uses (rotation derived from the episode seed; strategies never see it).
pub fn pack_for(ep_seed: u64) -> usize { usize::try_from(splitmix(ep_seed ^ 0x5041_434B_5041_434B) % (NPACK as u64)).unwrap_or(0) }
/// Season seed words from 32 VRF bytes -> (seed_a, seed_b) used with episode_seed(a, b, ep).
pub fn season_words(seed: &[u8; 32]) -> (u64, u64) {
    let w = |i: usize| -> u64 { let mut b = [0u8; 8]; b.copy_from_slice(&seed[i * 8..i * 8 + 8]); u64::from_le_bytes(b) };
    (w(0) ^ w(2), w(1) ^ w(3))
}

/// Ruleset v2: a season plays on SEASON_PACKS distinct packs drawn from the season seed (after lock), and every episode picks one of them.
/// Strategies never see which packs were drawn. This replaces `pack_for` (v1: any of the 6 packs per episode).
pub const SEASON_PACKS: usize = 2;
pub fn season_packs(seed_a: u64, seed_b: u64) -> [usize; SEASON_PACKS] {
    let h = splitmix(seed_a ^ seed_b.rotate_left(29) ^ 0x5345_4153_4F4E_5041);
    let p0 = usize::try_from(h % (NPACK as u64)).unwrap_or(0);
    let p1 = (p0 + 1 + usize::try_from(splitmix(h) % ((NPACK - 1) as u64)).unwrap_or(0)) % NPACK;
    [p0, p1]
}
pub fn pack_for_season(packs: &[usize; SEASON_PACKS], ep_seed: u64) -> usize { packs[usize::try_from(splitmix(ep_seed ^ 0x5041_434B_5345_4153) % (SEASON_PACKS as u64)).unwrap_or(0)] }

/// Generator version. Bump on ANY change to the tables or the generation procedure.
pub const GEN_VERSION: u8 = 2;
/// FNV-1a over every generator table value: pins the actual numbers, not just the label.
pub fn gen_checksum() -> u32 {
    let mut h: u32 = 0x811C_9DC5;
    let mut feed = |v: i64| { for b in v.to_le_bytes() { h ^= u32::from(b); h = h.wrapping_mul(0x0100_0193); } };
    for v in VMULT { feed(v); } for v in LAM { feed(v); }
    for p in PACKS.iter() { for v in p.w { feed(v); } feed(p.vol.0); feed(p.vol.1); feed(p.psw.0); feed(p.psw.1); feed(p.jm_milli); feed(p.drift_milli); feed(p.rho.0); feed(p.rho.1); }
    h
}
