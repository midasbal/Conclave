//! Conformance vectors for conclave-vm. One pure function, `run_vector(input) -> output`, is the single entry point on every target:
//! the host test, the WASM export, and the SBF harness program all call exactly this code, so a divergence can only come from the target, never from the harness.
//! Input and output are plain bytes. Malformed input returns `[0xEE]`; nothing in here panics.
use conclave_vm::{op_work, pins_bytes, validate, work_of, world, Market, Seat, VmError, ONE};

pub const KIND_VALIDATE: u8 = 0; pub const KIND_WORLD: u8 = 1; pub const KIND_TRACE: u8 = 2; pub const KIND_SEASON: u8 = 3; pub const KIND_PINS: u8 = 4; pub const KIND_OPWORK: u8 = 5; pub const KIND_STATE: u8 = 6; pub const KIND_SYNTH: u8 = 7;

/// FNV-1a 64
#[derive(Clone, Copy)] pub struct Fnv(pub u64);
impl Fnv { pub fn new() -> Self { Fnv(0xcbf2_9ce4_8422_2325) } pub fn bytes(&mut self, b: &[u8]) { for x in b { self.0 ^= u64::from(*x); self.0 = self.0.wrapping_mul(0x0100_0001_b3); } }
    pub fn u32(&mut self, v: u32) { self.bytes(&v.to_le_bytes()); } pub fn i32(&mut self, v: i32) { self.bytes(&v.to_le_bytes()); } pub fn i64(&mut self, v: i64) { self.bytes(&v.to_le_bytes()); } pub fn u64(&mut self, v: u64) { self.bytes(&v.to_le_bytes()); } }
impl Default for Fnv { fn default() -> Self { Self::new() } }

struct Rd<'a> { b: &'a [u8], p: usize }
impl<'a> Rd<'a> {
    fn u8(&mut self) -> Option<u8> { let v = *self.b.get(self.p)?; self.p += 1; Some(v) }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> { let s = self.b.get(self.p..self.p.checked_add(n)?)?; self.p += n; Some(s) }
    fn u16(&mut self) -> Option<u16> { Some(u16::from_le_bytes(self.take(2)?.try_into().ok()?)) }
    fn u32(&mut self) -> Option<u32> { Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?)) }
    fn i32(&mut self) -> Option<i32> { Some(i32::from_le_bytes(self.take(4)?.try_into().ok()?)) }
    fn u64(&mut self) -> Option<u64> { Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?)) }
    fn i64(&mut self) -> Option<i64> { Some(i64::from_le_bytes(self.take(8)?.try_into().ok()?)) }
    fn progs(&mut self, n: usize) -> Option<Vec<&'a [u8]>> { let mut v = Vec::with_capacity(n); for _ in 0..n { let l = usize::from(self.u16()?); v.push(self.take(l)?); } Some(v) }
}
fn err() -> Vec<u8> { vec![0xEE] }
pub fn vm_err_code(e: VmError) -> u8 { match e { VmError::Length => 1, VmError::Version => 2, VmError::TooManyOps => 3, VmError::BadOpcode => 4, VmError::BadReg => 5, VmError::BadOperand => 6, VmError::NonCanonical => 7, VmError::OverWorkCap => 8 } }

/// hash of the complete observable state of every seat after a tick
fn hash_tick(h: &mut Fnv, t: u32, seats: &[Seat], m: &Market) {
    h.u32(t); for f in m.f { h.i32(f); }
    for s in seats { for r in s.regs { h.i32(r); } h.i32(s.pos); h.i64(s.cash); h.i64(s.trade); h.i64(s.peak); h.bytes(&[s.dir.to_le_bytes()[0], u8::from(s.stopped), u8::from(s.ruined)]); h.i32(s.size); h.i32(s.stop); h.u64(s.work); }
}
/// shared by TRACE, SEASON and SYNTH: run seats over given returns. `splits` force a save/load round trip of ALL state at those ticks.
pub fn run_seats(returns: &[i32], total: u32, programs: &[&[u8]], splits: &[u8], h: &mut Fnv) -> (Vec<i64>, u64) {
    let mut m = Market::new(total); let mut seats: Vec<Seat> = programs.iter().map(|_| Seat::new()).collect();
    for (t, r) in returns.iter().enumerate() {
        if u8::try_from(t).map(|t8| splits.contains(&t8)).unwrap_or(false) {
            let mut mb = vec![0u8; Market::BYTES]; m.save(&mut mb); m = Market::load(&mb);
            for s in seats.iter_mut() { let mut sb = vec![0u8; Seat::BYTES]; s.save(&mut sb); *s = Seat::load(&sb); }
        }
        let sg0 = m.advance(*r); for (s, p) in seats.iter_mut().zip(programs.iter()) { s.step(p, &m, *r, sg0); }
        hash_tick(h, u32::try_from(t).unwrap_or(u32::MAX), &seats, &m);
    }
    (seats.iter().map(|s| s.pnl()).collect(), seats.iter().map(|s| s.work).sum())
}
fn pnl_out(h: &Fnv, work: u64, pnls: &[i64]) -> Vec<u8> { let mut o = Vec::with_capacity(16 + 8 * pnls.len()); o.extend_from_slice(&h.0.to_le_bytes()); o.extend_from_slice(&work.to_le_bytes()); for p in pnls { o.extend_from_slice(&p.to_le_bytes()); } o }

pub fn run_vector(inp: &[u8]) -> Vec<u8> {
    let mut r = Rd { b: inp, p: 0 };
    let Some(kind) = r.u8() else { return err() };
    match kind {
        KIND_VALIDATE => { let code = &inp[1..]; let st = match validate(code) { Ok(_) => 0, Err(e) => vm_err_code(e) }; let mut o = vec![st]; o.extend_from_slice(&work_of(code).to_le_bytes()); o }
        KIND_WORLD => { let (Some(pack), Some(sa), Some(sb), Some(ep)) = (r.u8(), r.u64(), r.u64(), r.u32()) else { return err() };
            let mut rets = [0i32; world::WORLD_T]; world::gen_episode(usize::from(pack), world::episode_seed(sa, sb, u64::from(ep)), &mut rets);
            let mut h = Fnv::new(); let (mut mn, mut mx, mut sum) = (i32::MAX, i32::MIN, 0i64); for v in rets { h.i32(v); mn = mn.min(v); mx = mx.max(v); sum += i64::from(v); }
            let mut o = h.0.to_le_bytes().to_vec(); o.extend_from_slice(&mn.to_le_bytes()); o.extend_from_slice(&mx.to_le_bytes()); o.extend_from_slice(&sum.to_le_bytes()); o }
        KIND_TRACE => { let (Some(pack), Some(sa), Some(sb), Some(ep), Some(nt), Some(ns), Some(nsp)) = (r.u8(), r.u64(), r.u64(), r.u32(), r.u8(), r.u8(), r.u8()) else { return err() };
            let Some(splits) = r.take(usize::from(nsp)) else { return err() }; let Some(progs) = r.progs(usize::from(ns)) else { return err() };
            for (i, p) in progs.iter().enumerate() { if validate(p).is_err() { return vec![0xFF, u8::try_from(i).unwrap_or(0xFF)]; } }
            let mut rets = [0i32; world::WORLD_T]; world::gen_episode(usize::from(pack), world::episode_seed(sa, sb, u64::from(ep)), &mut rets);
            let n = usize::from(nt).min(world::WORLD_T); let mut h = Fnv::new(); let (p, w) = run_seats(&rets[..n], world::WORLD_T as u32, &progs, splits, &mut h); pnl_out(&h, w, &p) }
        KIND_SEASON => { let (Some(sa), Some(sb), Some(neps), Some(nt), Some(ns)) = (r.u64(), r.u64(), r.u8(), r.u8(), r.u8()) else { return err() };
            let Some(progs) = r.progs(usize::from(ns)) else { return err() }; for p in progs.iter() { if validate(p).is_err() { return vec![0xFF, 0]; } }
            let packs = world::season_packs(sa, sb); let n = usize::from(nt).min(world::WORLD_T); let mut tot = vec![0i64; progs.len()]; let mut h = Fnv::new(); let mut w = 0u64;
            for e in 0..u64::from(neps) { let es = world::episode_seed(sa, sb, e); let mut rets = [0i32; world::WORLD_T]; world::gen_episode(world::pack_for_season(&packs, es), es, &mut rets);
                let mut hh = Fnv::new(); let (p, ww) = run_seats(&rets[..n], world::WORLD_T as u32, &progs, &[], &mut hh); w += ww; h.u64(hh.0); for (t, v) in tot.iter_mut().zip(p) { *t += v; } }
            let mut o = vec![u8::try_from(packs[0]).unwrap_or(255), u8::try_from(packs[1]).unwrap_or(255)]; o.extend_from_slice(&pnl_out(&h, w, &tot)); o }
        KIND_PINS => { let mut o = pins_bytes().to_vec(); o.extend_from_slice(&world::gen_checksum().to_le_bytes()); o }
        KIND_OPWORK => { let (Some(lo), Some(hi)) = (r.u8(), r.u8()) else { return err() }; let mut h = Fnv::new(); for c in 0..=255u8 { for a in lo..=hi { h.u32(op_work(c, u32::from(a))); } } h.0.to_le_bytes().to_vec() }
        KIND_STATE => { // arbitrary bytes as saved state: load must sanitise, one tick must not panic, the result must round-trip
            let (Some(mb), Some(sb), Some(rr), Some(sg0)) = (r.take(Market::BYTES), r.take(Seat::BYTES), r.i32(), r.i64()) else { return err() }; let code = &inp[r.p..];
            let mut m = Market::load(mb); let mut s = Seat::load(sb); let sg = m.advance(rr); let _ = sg0; s.step(code, &m, rr, sg0);
            let mut h = Fnv::new(); hash_tick(&mut h, m.t, core::slice::from_ref(&s), &m); let mut b1 = vec![0u8; Market::BYTES]; m.save(&mut b1); let mut b2 = vec![0u8; Seat::BYTES]; s.save(&mut b2); h.bytes(&b1); h.bytes(&b2);
            let mut o = h.0.to_le_bytes().to_vec(); o.extend_from_slice(&sg.to_le_bytes()); o }
        KIND_SYNTH => { let (Some(nt), Some(ns), Some(nsp)) = (r.u8(), r.u8(), r.u8()) else { return err() }; let Some(splits) = r.take(usize::from(nsp)) else { return err() }; let mut rets = Vec::with_capacity(usize::from(nt));
            for _ in 0..nt { let Some(v) = r.i32() else { return err() }; rets.push(v); } let Some(progs) = r.progs(usize::from(ns)) else { return err() };
            for p in progs.iter() { if validate(p).is_err() { return vec![0xFF, 0]; } }
            let mut h = Fnv::new(); let (p, w) = run_seats(&rets, u32::from(nt), &progs, splits, &mut h); pnl_out(&h, w, &p) }
        _ => err(),
    }
}
/// expected: ONE is re-exported only so tools can build 1.0 constants without importing the VM crate
pub const Q_ONE: i32 = ONE;

// ---- WASM exports: the same function, called from JavaScript ----
#[no_mangle] pub extern "C" fn cc_alloc(n: usize) -> *mut u8 { let mut v = Vec::<u8>::with_capacity(n.max(1)); let p = v.as_mut_ptr(); core::mem::forget(v); p }
/// # Safety
/// `inp` must point to `len` readable bytes and `out` to at least 2048 writable bytes (both obtained from `cc_alloc`).
#[no_mangle] pub unsafe extern "C" fn cc_run(inp: *const u8, len: usize, out: *mut u8) -> usize { let o = run_vector(core::slice::from_raw_parts(inp, len)); let n = o.len().min(2048); core::ptr::copy_nonoverlapping(o.as_ptr(), out, n); n }
