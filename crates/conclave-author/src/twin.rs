//! A label-reporting twin of the world generator.
//!
//! The real generator (`conclave_vm::world::gen_episode`) does not expose which hidden regime produced each tick, and `conclave-vm` must not change (the on-chain program is built from it:
//! adding even an unused function changes the program's reproducible hash, observed). The regime-by-regime view needs the labels, so this is a copy of the generator body that also
//! records them. It is never trusted: the simulator feeds the VM the REAL generator's returns, and for every episode compares them with this twin's returns. If they ever differ the
//! regime table is withheld and the report says so. A test also checks equality over tens of thousands of (pack, seed) pairs.
use conclave_vm::world::{Pack, NPACK, PACKS, WORLD_T};
const VMULT: [i64; 7] = [1000, 1000, 900, 700, 2300, 2300, 1200];
const LAM: [i64; 7] = [30, 30, 30, 30, 200, 200, 400];
struct Rng(u64);
impl Rng { fn next(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 33 }
    fn u(&mut self, m: i64) -> i64 { i64::try_from(self.next() % m.unsigned_abs().max(1)).unwrap_or(i64::MAX) } }
pub const REGIMES: usize = 7;
/// descriptions of what each hidden regime does, read from the generator's drift rule (these names are ours, the generator only numbers them)
pub const REGIME_NAMES: [&str; REGIMES] = ["trend up", "trend down", "mean reversion", "choppy (reverses tick to tick)", "volatile slide", "volatile rally", "noise with frequent jumps"];
pub fn gen_labeled(pack: usize, seed: u64, out: &mut [i32; WORLD_T], regimes: &mut [u8; WORLD_T]) {
    let p: &Pack = &PACKS[pack % NPACK]; let mut g = Rng(seed);
    let sigma0 = p.vol.0 + g.u(p.vol.1 - p.vol.0 + 1); let psw = p.psw.0 + g.u(p.psw.1 - p.psw.0 + 1); let mtr = sigma0 * (150 + g.u(350)) * p.drift_milli / 1_000_000;
    let phi_tr = -50 + g.u(200); let kappa = 80 + g.u(220); let phi_ch = -(150 + g.u(300)); let mc = sigma0 * (500 + g.u(500)) / 1000; let rho = p.rho.0 + g.u(p.rho.1 - p.rho.0 + 1);
    let pick = |u: i64| -> usize { let mut c = 0; for i in 0..7 { c += p.w[i]; if u < c { return i; } } 6 };
    let mut reg = pick(g.u(1000)); let (mut x, mut a, mut m, mut rprev, mut pend, mut pend_n) = (0i64, 0i64, 1000i64, 0i64, 0i64, 0i32);
    for (ti, slot) in out.iter_mut().enumerate() {
        if g.u(1000) < psw { reg = pick(g.u(1000)); }
        regimes[ti] = u8::try_from(reg).unwrap_or(6);
        let mut s = 0i64; for _ in 0..4 { s += g.u(65536); } let eps = (s - 131070) * 1000 / 37837;
        let d = match reg { 0 => mtr + phi_tr * (rprev - mtr) / 1000, 1 => -mtr + phi_tr * (rprev + mtr) / 1000, 2 => -(kappa * (x - a) / 1000), 3 => phi_ch * rprev / 1000, 4 => -mc + phi_tr * (rprev + mc) / 1000, 5 => mc + phi_tr * (rprev - mc) / 1000, _ => 0 };
        let sig = sigma0 * m / 1000; let mut j = 0i64; let lam = LAM[reg] * p.jm_milli / 1000;
        if g.u(10000) < lam { let ju = g.u(1000); let sd = g.u(1000); let mag = sig * (3000 + 3 * ju) / 1000; let bias = if reg == 4 { 700 } else if reg == 5 { 300 } else { 500 }; j = if sd < bias { -mag } else { mag }; pend = -rho * j / 5000; pend_n = 5; }
        let mut ret = d + sig * eps / 1000 + j; if pend_n > 0 { ret += pend; pend_n -= 1; }
        *slot = i32::try_from(ret.clamp(-(i32::MAX as i64), i32::MAX as i64)).unwrap_or(0); x += ret; a += (x - a) / 32; rprev = ret;
        m = m + (VMULT[reg] - m) / 8 + ((eps.abs() - 800) * m / 5000); m = m.clamp(300, 4000);
    }
}
