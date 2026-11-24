//! Conclave strategy VM v1. no_std, no alloc, no floats, no i128, no recursion, no panics on any validated program.
//! Straight-line register machine: every tick the whole program runs once, top to bottom. Registers are episode-scope (zeroed at episode start).
//! Values are Q16.16 in i32, symmetric saturation at +-(2^31-1). Everything a strategy can see is a vol-normalised signal; it never sees price level or regime.
#![no_std]
#![deny(clippy::float_arithmetic)]
pub mod world;

/// RULESET v2. Everything that changes what a strategy MEANS lives in this block: bytecode version, work weights and cap, cost, ruin floor, caps.
/// Changing any constant here is a new ruleset (bump RULESET and VERSION); sealed strategies and receipts must carry the ruleset they were made under.
pub const RULESET: u16 = 2;
pub const VERSION: u8 = 2;
/// per-tick metered work cap (work units, 1 unit is about 70 compute units on SBF). A full 20-seat arena at the cap costs about 20 * 70 * 64 + market per tick.
pub const WORK_CAP: u32 = 64;
/// op-budget divisions, in WORK units (not op counts)
pub const DIVISIONS: [u32; 3] = [16, 32, 64];
/// ruin floor: once an episode's PnL (realised + open) falls to this many vol-units below zero the seat is liquidated: flat for the rest of the episode
pub const RUIN_FLOOR_VU: i64 = 60;
pub const RUIN_FLOOR_Q16: i64 = -(RUIN_FLOOR_VU << 16);
/// position cap in vol-target units. Targets are clamped to +-POS_CAP no matter what the program computes (SIZE and POS are clamped too).
pub const POS_CAP: i32 = ONE;
/// single-tick gap cap in vol units (never reached in 1.2M simulated ticks; it only bounds the worst case when the vol estimate has collapsed before a jump)
pub const GAP_CAP_VU: i64 = 24;
/// Largest per-tick return the VM accepts (ppm). Larger inputs are clamped, which makes every later product provably fit in i64. The generator never gets near it (see PANIC_FREEDOM.md).
pub const R_MAX: i32 = 1 << 24;
/// Bound on the running cumulative return and its EMA (ppm).
pub const X_MAX: i64 = 1 << 40;
pub const NREG: usize = 16;
pub const MAX_OPS: usize = 64;
pub const RING: usize = 32;
pub const ONE: i32 = 1 << 16;
pub const NSIG: u8 = 13;
pub const HEADER: usize = 4;
/// transaction cost: 0.05 vol-units per unit of position change
pub const COST_Q16: i64 = 9830;

/// Test-only event counters (cargo feature `cov`). Off in every production build: the macro expands to nothing.
#[cfg(feature = "cov")]
pub mod cov {
    use core::sync::atomic::{AtomicU64, Ordering};
    pub const N: usize = 128;
    pub static C: [AtomicU64; N] = [const { AtomicU64::new(0) }; N];
    #[inline] pub fn hit(i: usize) { C[i].fetch_add(1, Ordering::Relaxed); }
    pub fn snapshot() -> [u64; N] { let mut o = [0u64; N]; for (i, v) in o.iter_mut().enumerate() { *v = C[i].load(Ordering::Relaxed); } o }
    pub fn reset() { for c in C.iter() { c.store(0, Ordering::Relaxed); } }
    /// event ids (0..=33 are the opcodes themselves)
    pub const NAMES: [(usize, &str); 45] = [(40, "sat clamp high"), (41, "sat clamp low"), (42, "DIV by zero"), (43, "qdiv zero denominator"), (44, "SEL true"), (45, "SEL false"), (46, "THR pass"), (47, "THR zero"),
        (48, "GTI/LTI true"), (49, "GTI/LTI false"), (50, "POS clamp high"), (51, "POS clamp low"), (52, "SIZE clamp high"), (53, "SIZE clamp low"), (54, "STOPSET negative"), (55, "STOPCLR taken"), (56, "stop triggered"),
        (57, "ruin floor triggered"), (58, "gap cap high"), (59, "gap cap low"), (60, "target clamp"), (61, "position flip realised"), (62, "flat realised"), (63, "sigma floor used"), (64, "input return clamped"),
        (65, "cumulative clamped"), (66, "ring wrapped"), (67, "time-left zero"), (68, "time-left positive"), (69, "ZW denominator floor"), (70, "ZW denominator mad"), (71, "step on short code"), (72, "step op count trimmed"),
        (73, "load sanitised a field"), (74, "validate ok"), (75, "validate Length"), (76, "validate Version"), (77, "validate TooManyOps"), (78, "validate BadOpcode"), (79, "validate BadReg"), (80, "validate BadOperand"),
        (81, "validate NonCanonical"), (82, "validate OverWorkCap"), (83, "stopped while flat"), (84, "ruined seat held flat")];
}
#[cfg(feature = "cov")] macro_rules! cov { ($i:expr) => { $crate::cov::hit($i) }; }
#[cfg(not(feature = "cov"))] macro_rules! cov { ($i:expr) => {}; }

pub mod op {
    pub const NOP: u8 = 0; pub const LDI: u8 = 1; pub const SIG: u8 = 2; pub const MOV: u8 = 3;
    pub const ADD: u8 = 4; pub const SUB: u8 = 5; pub const MUL: u8 = 6; pub const DIV: u8 = 7;
    pub const NEG: u8 = 8; pub const ABS: u8 = 9; pub const SIGN: u8 = 10; pub const MIN: u8 = 11; pub const MAX: u8 = 12;
    pub const GT: u8 = 13; pub const LT: u8 = 14; pub const AND: u8 = 15; pub const OR: u8 = 16; pub const NOT: u8 = 17;
    pub const SEL: u8 = 18; pub const GTI: u8 = 19; pub const LTI: u8 = 20; pub const THR: u8 = 21;
    pub const EMA: u8 = 22; pub const HIST: u8 = 23; pub const WSUM: u8 = 24; pub const VOLW: u8 = 25; pub const ZW: u8 = 26;
    pub const LONG: u8 = 27; pub const SHORT: u8 = 28; pub const FLAT: u8 = 29; pub const SIZE: u8 = 30; pub const POS: u8 = 31;
    pub const STOPSET: u8 = 32; pub const STOPCLR: u8 = 33;
    pub const COUNT: u8 = 34;
}
/// signal ids for SIG
pub mod sg { pub const U1: u8 = 0; pub const CUM: u8 = 1; pub const T5: u8 = 2; pub const T10: u8 = 3; pub const T20: u8 = 4; pub const MOM: u8 = 5;
    pub const VOLR: u8 = 6; pub const ZSC: u8 = 7; pub const TLEFT: u8 = 8; pub const POS: u8 = 9; pub const CASH: u8 = 10; pub const PNL: u8 = 11; pub const DD: u8 = 12; }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VmError { Length, Version, TooManyOps, BadOpcode, BadReg, BadOperand, NonCanonical, OverWorkCap }

/// Validate a program blob: [version, n_ops, 0, 0] ++ n_ops*4 bytes. Returns n_ops. Canonical form required (unused operand bytes must be 0).
pub fn validate(code: &[u8]) -> Result<usize, VmError> {
    let r = validate_inner(code);
    #[cfg(feature = "cov")] { match r { Ok(_) => cov!(74), Err(VmError::Length) => cov!(75), Err(VmError::Version) => cov!(76), Err(VmError::TooManyOps) => cov!(77), Err(VmError::BadOpcode) => cov!(78), Err(VmError::BadReg) => cov!(79), Err(VmError::BadOperand) => cov!(80), Err(VmError::NonCanonical) => cov!(81), Err(VmError::OverWorkCap) => cov!(82) } }
    r
}
fn validate_inner(code: &[u8]) -> Result<usize, VmError> {
    if code.len() < HEADER { return Err(VmError::Length); }
    if code[0] != VERSION { return Err(VmError::Version); }
    if code[2] != 0 || code[3] != 0 { return Err(VmError::NonCanonical); }
    let n = code[1] as usize;
    if n > MAX_OPS { return Err(VmError::TooManyOps); }
    if code.len() != HEADER + 4 * n { return Err(VmError::Length); }
    let mut i = 0;
    while i < n {
        let o = &code[HEADER + 4 * i..HEADER + 4 * i + 4];
        let (c, d, a, b) = (o[0], o[1], o[2], o[3]);
        let r = |x: u8| -> Result<(), VmError> { if (x as usize) < NREG { Ok(()) } else { Err(VmError::BadReg) } };
        let z = |x: u8| -> Result<(), VmError> { if x == 0 { Ok(()) } else { Err(VmError::NonCanonical) } };
        match c {
            op::NOP => { z(d)?; z(a)?; z(b)?; }
            op::LDI => { r(d)?; }                                   // a,b = imm16 (LE, Q8)
            op::SIG => { r(d)?; if a >= NSIG { return Err(VmError::BadOperand); } z(b)?; }
            op::MOV | op::NEG | op::ABS | op::SIGN | op::NOT => { r(d)?; r(a)?; z(b)?; }
            op::ADD | op::SUB | op::MUL | op::DIV | op::MIN | op::MAX | op::GT | op::LT | op::AND | op::OR | op::SEL => { r(d)?; r(a)?; r(b)?; }
            op::GTI | op::LTI | op::THR => { r(d)?; r(a)?; }          // b = imm8 (i8, Q5)
            op::EMA => { r(d)?; r(a)?; if b > 15 { return Err(VmError::BadOperand); } }
            op::HIST => { r(d)?; if a as usize >= RING { return Err(VmError::BadOperand); } z(b)?; }
            op::WSUM | op::VOLW | op::ZW => { r(d)?; if a == 0 || a as usize > RING { return Err(VmError::BadOperand); } z(b)?; }
            op::LONG | op::SHORT | op::FLAT | op::SIZE | op::POS | op::STOPSET | op::STOPCLR => { z(d)?; r(a)?; z(b)?; }
            _ => return Err(VmError::BadOpcode),
        }
        i += 1;
    }
    if work_of(code) > WORK_CAP { return Err(VmError::OverWorkCap); }
    Ok(n)
}
#[inline] fn sat(x: i64) -> i32 { const M: i64 = i32::MAX as i64; if x > M { cov!(40); } if x < -M { cov!(41); } i32::try_from(x.clamp(-M, M)).unwrap_or(0) }
#[inline] fn bool_q(b: bool) -> i32 { if b { ONE } else { 0 } }
#[inline] fn sgn(x: i32) -> i32 { if x > 0 { ONE } else if x < 0 { -ONE } else { 0 } }
/// a is always within +-2^47 at every call site (see PANIC_FREEDOM.md), so a * 65536 fits i64; the multiplication is saturating anyway.
#[inline] fn qdiv(a: i64, b: i64) -> i32 { if b == 0 { cov!(43); 0 } else { sat(a.saturating_mul(65536) / b) } }

/// Shared per-tick market state (computed once per tick for all seats). Integer only.
pub struct Market {
    pub t: u32, pub total: u32, sig: i64, sig_s: i64, x: i64, a: i64, ring: [i32; RING], cum: [i32; RING], pub f: [i32; 9], sg: i64, sgs: i64, cur: u32,
}
const SQRT5: i64 = 146543; const SQRT10: i64 = 207243; const SQRT20: i64 = 293086; // sqrt(n)*65536
impl Market {
    pub fn new(total: u32) -> Self { Market { t: 0, total, sig: 8000, sig_s: 8000, x: 0, a: 0, ring: [0; RING], cum: [0; RING], f: [0; 9], sg: 8000, sgs: 8000, cur: 0 } }
    /// Ingest return r (ppm). Returns the lagged sigma (ppm, floored) that the engine uses to accrue PnL for THIS tick.
    pub fn advance(&mut self, r: i32) -> i64 {
        if r > R_MAX || r < -R_MAX { cov!(64); }
        let r = r.clamp(-R_MAX, R_MAX);
        let sg0 = if self.sig < 1000 { cov!(63); 1000 } else { self.sig };
        let r64 = i64::from(r);
        self.sig += (r64.abs() - self.sig) / 16; self.sig_s += (r64.abs() - self.sig_s) / 64;
        let nx = self.x + r64; if nx > X_MAX || nx < -X_MAX { cov!(65); } self.x = nx.clamp(-X_MAX, X_MAX); self.a += (self.x - self.a) / 32;
        self.cur = self.t;
        self.ring[(self.t as usize) & (RING - 1)] = r; self.cum[(self.t as usize) & (RING - 1)] = sat(self.x);
        self.sg = if self.sig < 1000 { 1000 } else { self.sig }; self.sgs = if self.sig_s < 1000 { 1000 } else { self.sig_s };
        let (s5, s10, s20) = (self.wsum_raw(5), self.wsum_raw(10), self.wsum_raw(20));
        let sg = self.sg;
        self.f[0] = qdiv(r64, sg); self.f[1] = qdiv(self.x, sg);
        self.f[2] = sat(s5 * 4_294_967_296 / (sg * SQRT5)); self.f[3] = sat(s10 * 4_294_967_296 / (sg * SQRT10)); self.f[4] = sat(s20 * 4_294_967_296 / (sg * SQRT20));
        self.f[5] = qdiv(s20, self.sgs); self.f[6] = qdiv(self.sig, self.sgs); self.f[7] = qdiv(self.x - self.a, 5 * sg);
        if self.t >= RING as u32 { cov!(66); }
        let left = if self.total > self.t.saturating_add(1) { cov!(68); i64::from(self.total - self.t - 1) } else { cov!(67); 0 };
        self.f[8] = sat(left * 65536 / i64::from(self.total.max(1)));
        self.t = self.t.saturating_add(1);
        sg0
    }
    fn at(&self, k: u32) -> i32 { self.ring[(self.cur.wrapping_sub(k) as usize) & (RING - 1)] }
    fn cat(&self, k: u32) -> i32 { self.cum[(self.cur.wrapping_sub(k) as usize) & (RING - 1)] }
    fn wsum_raw(&self, n: u32) -> i64 { let mut s = 0i64; let mut k = 0; while k < n { s += self.at(k) as i64; k += 1; } s }
}
/// One strategy's live state. Everything resets at episode start (episode-scope registers).
#[derive(Clone)]
pub struct Seat { pub regs: [i32; NREG], pub pos: i32, pub cash: i64, pub trade: i64, pub peak: i64, pub dir: i8, pub size: i32, pub stop: i32, pub stopped: bool, pub ruined: bool, pub work: u64 }
impl Seat {
    pub fn new() -> Self { Seat { regs: [0; NREG], pos: 0, cash: 0, trade: 0, peak: 0, dir: 0, size: ONE, stop: 0, stopped: false, ruined: false, work: 0 } }
    pub fn pnl(&self) -> i64 { self.cash.saturating_add(self.trade) }
    /// One tick. `code` must have passed `validate`. `r` is this tick's return, `sg0` from Market::advance (called first).
    pub fn step(&mut self, code: &[u8], m: &Market, r: i32, sg0: i64) {
        let sg0 = sg0.max(1);
        let ur = i64::from(r) * 65536 / sg0; if ur > GAP_CAP_VU << 16 { cov!(58); } if ur < -(GAP_CAP_VU << 16) { cov!(59); }
        let u = ur.clamp(-(GAP_CAP_VU << 16), GAP_CAP_VU << 16);
        self.trade = self.trade.saturating_add((i64::from(self.pos) * u) >> 16);
        let pnl = self.pnl(); if pnl > self.peak { self.peak = pnl; }
        if pnl <= RUIN_FLOOR_Q16 { cov!(57); self.ruined = true; }
        // defence in depth: callers validate first, but a short or truncated blob must never index out of range
        if code.len() < HEADER { cov!(71); return; }
        let avail = (code.len() - HEADER) / 4; let mut n = code[1] as usize; if n > avail { cov!(72); n = avail; } let mut w: u64 = 0;
        let mut i = 0;
        while i < n {
            let o = HEADER + 4 * i; let (c, d, a, b) = (code[o], code[o + 1] as usize & 15, code[o + 2], code[o + 3]); if usize::from(c) < 34 { cov!(usize::from(c)); }
            let ra = self.regs[a as usize & 15]; let rb = self.regs[b as usize & 15];
            w += u64::from(op_work(c, u32::from(a)));
            match c {
                op::LDI => { self.regs[d] = i32::from(i16::from_le_bytes([a, b])) << 8; }
                op::SIG => { self.regs[d] = match a { 0..=8 => m.f[a as usize], 9 => self.pos, 10 => sat(self.cash), 11 => sat(self.pnl()), _ => sat(self.peak.saturating_sub(self.pnl())) }; }
                op::MOV => self.regs[d] = ra,
                op::ADD => self.regs[d] = sat(i64::from(ra) + i64::from(rb)),
                op::SUB => self.regs[d] = sat(i64::from(ra) - i64::from(rb)),
                op::MUL => { self.regs[d] = sat((i64::from(ra) * i64::from(rb)) >> 16); }
                op::DIV => { self.regs[d] = if rb == 0 { cov!(42); 0 } else { sat(i64::from(ra) * 65536 / i64::from(rb)) }; }
                op::NEG => self.regs[d] = ra.saturating_neg(),
                op::ABS => self.regs[d] = ra.saturating_abs(),
                op::SIGN => self.regs[d] = sgn(ra),
                op::MIN => self.regs[d] = if ra < rb { ra } else { rb },
                op::MAX => self.regs[d] = if ra > rb { ra } else { rb },
                op::GT => self.regs[d] = bool_q(ra > rb), op::LT => self.regs[d] = bool_q(ra < rb),
                op::AND => self.regs[d] = bool_q(ra != 0 && rb != 0), op::OR => self.regs[d] = bool_q(ra != 0 || rb != 0),
                op::NOT => self.regs[d] = bool_q(ra == 0),
                op::SEL => { self.regs[d] = if self.regs[d] != 0 { cov!(44); ra } else { cov!(45); rb }; }
                op::GTI => { let t = i32::from(i8::from_le_bytes([b])) << 11; let v = ra > t; cov!(if v { 48 } else { 49 }); self.regs[d] = bool_q(v) }
                op::LTI => { let t = i32::from(i8::from_le_bytes([b])) << 11; let v = ra < t; cov!(if v { 48 } else { 49 }); self.regs[d] = bool_q(v) }
                op::THR => { let t = i32::from(i8::from_le_bytes([b])) << 11; self.regs[d] = if ra >= t || ra <= -t { cov!(46); ra } else { cov!(47); 0 }; }
                op::EMA => { let cur = i64::from(self.regs[d]); self.regs[d] = sat(cur + ((i64::from(ra) - cur) >> (b & 15))); }
                op::HIST => { self.regs[d] = qdiv(i64::from(m.at(u32::from(a))), m.sg); }
                op::WSUM => { self.regs[d] = qdiv(m.wsum_raw(u32::from(a)), m.sg); }
                op::VOLW => { let mut s = 0i64; let mut k = 0; while k < u32::from(a) { s += i64::from(m.at(k)).abs(); k += 1; } self.regs[d] = qdiv(s, m.sgs * i64::from(a)); }
                op::ZW => {
                    let nn = u32::from(a).max(2); let mut s = 0i64; let mut k = 0; while k < nn { s += i64::from(m.cat(k)); k += 1; }
                    let mean = s / i64::from(nn); let mut dev = 0i64; k = 0; while k < nn { dev += (i64::from(m.cat(k)) - mean).abs(); k += 1; }
                    let mad = dev / i64::from(nn); let den = if mad > m.sg / 4 { cov!(70); mad } else { cov!(69); m.sg / 4 };
                    self.regs[d] = qdiv(i64::from(m.cat(0)) - mean, den);
                }
                op::LONG => { if ra != 0 { self.dir = 1; } }
                op::SHORT => { if ra != 0 { self.dir = -1; } }
                op::FLAT => { if ra != 0 { self.dir = 0; } }
                op::SIZE => { if ra > ONE { cov!(52); } if ra < 0 { cov!(53); } self.size = ra.clamp(0, ONE); }
                op::POS => { if ra > ONE { cov!(50); } if ra < -ONE { cov!(51); } let v = ra.clamp(-ONE, ONE); if v == 0 { self.dir = 0; } else { self.dir = if v > 0 { 1 } else { -1 }; self.size = v.abs(); } }
                op::STOPSET => { if ra < 0 { cov!(54); } self.stop = ra.max(0); }
                op::STOPCLR => { if ra != 0 { cov!(55); self.stopped = false; } }
                _ => {}
            }
            i += 1;
        }
        self.work = self.work.saturating_add(w);
        let mut target = i32::from(self.dir) * self.size;
        if self.stop > 0 && target != 0 && self.trade <= -i64::from(self.stop) { cov!(56); self.stopped = true; }
        if target > POS_CAP || target < -POS_CAP { cov!(60); }
        target = target.clamp(-POS_CAP, POS_CAP);
        if self.ruined || self.stopped { if target != 0 { cov!(if self.ruined { 84 } else { 83 }); } target = 0; }
        let delta = (i64::from(target) - i64::from(self.pos)).abs();
        self.cash = self.cash.saturating_sub((delta * COST_Q16) >> 16);
        if target == 0 || (target > 0) != (self.pos > 0) && self.pos != 0 { cov!(if target == 0 { 62 } else { 61 }); self.cash = self.cash.saturating_add(self.trade); self.trade = 0; }
        self.pos = target;
    }
}


/// Static per-tick metered work of a program (straight-line, so it is a constant). Mirrors exactly what `Seat::step` accumulates. This, not the op count, is what compute scales with.
pub fn work_of(code: &[u8]) -> u32 {
    if code.len() < HEADER { return 0; }
    let n = usize::from(code[1]).min((code.len() - HEADER) / 4); let mut w = 0u32;
    for i in 0..n { let o = HEADER + 4 * i; w = w.saturating_add(op_work(code[o], u32::from(code[o + 2]))); }
    w
}
/// Work weight of one op, calibrated on SBF (see the ruleset v2 notes): a plain op is 1 unit (about 70 CU); the rest are priced from measured compute.
pub fn op_work(c: u8, a: u32) -> u32 {
    match c { op::HIST => 5, op::WSUM => 5 + a.div_ceil(3), op::VOLW => 6 + (2 * a).div_ceil(5), op::ZW => 11 + a, _ => 1 }
}

/// Length of the ruleset pin block.
pub const PINS_LEN: usize = 48;
/// Everything that determines what a score means, as bytes. Arenas and receipts store it; a program build whose pins differ refuses to run the arena.
pub fn pins_bytes() -> [u8; PINS_LEN] {
    let mut p = [0u8; PINS_LEN];
    p[0..2].copy_from_slice(&RULESET.to_le_bytes()); p[2] = VERSION; p[3] = world::GEN_VERSION;
    p[4..8].copy_from_slice(&u32::try_from(COST_Q16).unwrap_or(0).to_le_bytes()); p[8..12].copy_from_slice(&WORK_CAP.to_le_bytes());
    p[12..16].copy_from_slice(&u32::try_from(RUIN_FLOOR_VU).unwrap_or(0).to_le_bytes()); p[16..20].copy_from_slice(&u32::try_from(GAP_CAP_VU).unwrap_or(0).to_le_bytes());
    p[20..24].copy_from_slice(&u32::try_from(POS_CAP).unwrap_or(0).to_le_bytes()); p[24] = u8::try_from(world::SEASON_PACKS).unwrap_or(0);
    let tbl = [op_work(op::HIST, 0), op_work(op::WSUM, 1), op_work(op::WSUM, 32), op_work(op::VOLW, 1), op_work(op::VOLW, 32), op_work(op::ZW, 2), op_work(op::ZW, 32), op_work(op::ADD, 0)];
    for (i, v) in tbl.iter().enumerate() { p[28 + i] = u8::try_from(*v).unwrap_or(255); }
    for (i, d) in DIVISIONS.iter().enumerate() { p[36 + i] = u8::try_from(*d).unwrap_or(255); }
    p[40..44].copy_from_slice(&world::gen_checksum().to_le_bytes());
    p
}

// ---- state (de)serialisation, additive: lets a program persist Market/Seat between transactions without changing any semantics ----
fn put32(o: &mut [u8], p: &mut usize, v: i32) { o[*p..*p + 4].copy_from_slice(&v.to_le_bytes()); *p += 4; }
fn put64(o: &mut [u8], p: &mut usize, v: i64) { o[*p..*p + 8].copy_from_slice(&v.to_le_bytes()); *p += 8; }
fn put32u(o: &mut [u8], p: &mut usize, v: u32) { o[*p..*p + 4].copy_from_slice(&v.to_le_bytes()); *p += 4; }
fn put64u(o: &mut [u8], p: &mut usize, v: u64) { o[*p..*p + 8].copy_from_slice(&v.to_le_bytes()); *p += 8; }
fn get32u(o: &[u8], p: &mut usize) -> u32 { let v = u32::from_le_bytes([o[*p], o[*p + 1], o[*p + 2], o[*p + 3]]); *p += 4; v }
fn get64u(o: &[u8], p: &mut usize) -> u64 { let mut b = [0u8; 8]; b.copy_from_slice(&o[*p..*p + 8]); *p += 8; u64::from_le_bytes(b) }
fn get32(o: &[u8], p: &mut usize) -> i32 { let v = i32::from_le_bytes([o[*p], o[*p + 1], o[*p + 2], o[*p + 3]]); *p += 4; v }
fn get64(o: &[u8], p: &mut usize) -> i64 { let mut b = [0u8; 8]; b.copy_from_slice(&o[*p..*p + 8]); *p += 8; i64::from_le_bytes(b) }
impl Market {
    pub const BYTES: usize = 4 + 4 + 8 * 4 + 4 * RING * 2 + 4 * 9 + 8 + 8 + 4;
    pub fn save(&self, o: &mut [u8]) {
        let mut p = 0; put32u(o, &mut p, self.t); put32u(o, &mut p, self.total);
        put64(o, &mut p, self.sig); put64(o, &mut p, self.sig_s); put64(o, &mut p, self.x); put64(o, &mut p, self.a);
        for v in self.ring { put32(o, &mut p, v); } for v in self.cum { put32(o, &mut p, v); } for v in self.f { put32(o, &mut p, v); }
        put64(o, &mut p, self.sg); put64(o, &mut p, self.sgs); put32u(o, &mut p, self.cur);
    }
    pub fn load(o: &[u8]) -> Self {
        let mut p = 0; let mut m = Market::new(0);
        m.t = get32u(o, &mut p); m.total = get32u(o, &mut p); m.sig = get64(o, &mut p); m.sig_s = get64(o, &mut p); m.x = get64(o, &mut p); m.a = get64(o, &mut p);
        for v in m.ring.iter_mut() { *v = get32(o, &mut p); } for v in m.cum.iter_mut() { *v = get32(o, &mut p); } for v in m.f.iter_mut() { *v = get32(o, &mut p); }
        m.sg = get64(o, &mut p); m.sgs = get64(o, &mut p); m.cur = get32u(o, &mut p); m.sanitise(); m
    }
    /// Clamp every field into the range it can reach from `new()` through `advance()`. A valid saved state is unchanged; a corrupted one can no longer cause an overflow downstream.
    fn sanitise(&mut self) {
        let (s0, ss0, x0, a0, g0, gs0) = (self.sig, self.sig_s, self.x, self.a, self.sg, self.sgs);
        let rmax = i64::from(R_MAX);
        self.sig = self.sig.clamp(0, rmax); self.sig_s = self.sig_s.clamp(0, rmax); self.x = self.x.clamp(-X_MAX, X_MAX); self.a = self.a.clamp(-X_MAX, X_MAX); self.sg = self.sg.clamp(1000, rmax.max(1000)); self.sgs = self.sgs.clamp(1000, rmax.max(1000));
        for v in self.ring.iter_mut() { *v = (*v).clamp(-R_MAX, R_MAX); }
        for v in self.cum.iter_mut() { *v = (*v).max(-i32::MAX); } for v in self.f.iter_mut() { *v = (*v).max(-i32::MAX); }
        if (s0, ss0, x0, a0, g0, gs0) != (self.sig, self.sig_s, self.x, self.a, self.sg, self.sgs) { cov!(73); }
    }
}
impl Seat {
    pub const BYTES: usize = 4 * NREG + 4 + 8 * 3 + 1 + 4 + 4 + 1 + 1 + 8;
    pub fn save(&self, o: &mut [u8]) {
        let mut p = 0; for v in self.regs { put32(o, &mut p, v); } put32(o, &mut p, self.pos); put64(o, &mut p, self.cash); put64(o, &mut p, self.trade); put64(o, &mut p, self.peak);
        o[p] = self.dir.to_le_bytes()[0]; p += 1; put32(o, &mut p, self.size); put32(o, &mut p, self.stop); o[p] = self.stopped as u8; p += 1; o[p] = self.ruined as u8; p += 1; put64u(o, &mut p, self.work);
    }
    pub fn load(o: &[u8]) -> Self {
        let mut p = 0; let mut s = Seat::new(); for v in s.regs.iter_mut() { *v = get32(o, &mut p); }
        s.pos = get32(o, &mut p); s.cash = get64(o, &mut p); s.trade = get64(o, &mut p); s.peak = get64(o, &mut p);
        s.dir = i8::from_le_bytes([o[p]]); p += 1; s.size = get32(o, &mut p); s.stop = get32(o, &mut p); s.stopped = o[p] != 0; p += 1; s.ruined = o[p] != 0; p += 1; s.work = get64u(o, &mut p); s.sanitise(); s
    }
    /// Clamp every field into its reachable range (valid states are unchanged).
    fn sanitise(&mut self) {
        let before = (self.pos, self.dir, self.size, self.stop, self.cash, self.trade, self.peak);
        for v in self.regs.iter_mut() { *v = (*v).max(-i32::MAX); }
        self.pos = self.pos.clamp(-POS_CAP, POS_CAP); self.dir = self.dir.clamp(-1, 1); self.size = self.size.clamp(0, ONE); self.stop = self.stop.max(0);
        let lim = 1i64 << 50; self.cash = self.cash.clamp(-lim, lim); self.trade = self.trade.clamp(-lim, lim); self.peak = self.peak.clamp(-lim, lim);
        if before != (self.pos, self.dir, self.size, self.stop, self.cash, self.trade, self.peak) { cov!(73); }
    }
}
impl Default for Seat { fn default() -> Self { Self::new() } }
