//! Shared helpers for corpus generation, the fuzzer and the tests: a deterministic RNG, a random valid-program generator, and vector builders.
use conclave_vm::{op, validate, work_of, VERSION, WORK_CAP, MAX_OPS};
pub mod corpus;

pub struct Rng(pub u64);
impl Rng {
    pub fn new(seed: u64) -> Self { Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1) }
    pub fn next(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545_F491_4F6C_DD1D) }
    pub fn below(&mut self, n: u64) -> u64 { self.next() % n.max(1) }
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 { lo + self.below(hi - lo + 1) }
    pub fn byte(&mut self) -> u8 { (self.next() >> 24) as u8 }
    pub fn chance(&mut self, num: u64, den: u64) -> bool { self.below(den) < num }
}
/// one random op with valid, canonical operands
pub fn rand_op(rng: &mut Rng) -> [u8; 4] {
    let c = rng.below(34) as u8; let d = rng.below(16) as u8; let a = rng.below(16) as u8; let b = rng.below(16) as u8;
    match c {
        op::NOP => [c, 0, 0, 0],
        op::LDI => [c, d, rng.byte(), rng.byte()],
        op::SIG => [c, d, rng.below(13) as u8, 0],
        op::MOV | op::NEG | op::ABS | op::SIGN | op::NOT => [c, d, a, 0],
        op::ADD | op::SUB | op::MUL | op::DIV | op::MIN | op::MAX | op::GT | op::LT | op::AND | op::OR | op::SEL => [c, d, a, b],
        op::GTI | op::LTI | op::THR => [c, d, a, rng.byte()],
        op::EMA => [c, d, a, rng.below(16) as u8],
        op::HIST => [c, d, rng.below(32) as u8, 0],
        op::WSUM | op::VOLW | op::ZW => { let n = match rng.below(4) { 0 => 1, 1 => 32, 2 => 2, _ => rng.range(1, 32) as u8 }; [c, d, n, 0] }
        _ => [c, 0, a, 0],
    }
}
pub fn assemble(ops: &[[u8; 4]]) -> Vec<u8> { let mut v = vec![VERSION, ops.len() as u8, 0, 0]; for o in ops { v.extend_from_slice(o); } v }
/// a random program that passes `validate` (work cap included): window ops are replaced by ADD until it fits
pub fn rand_program(rng: &mut Rng, max_ops: usize) -> Vec<u8> {
    let n = rng.range(1, max_ops.min(MAX_OPS) as u64) as usize; let mut ops: Vec<[u8; 4]> = (0..n).map(|_| rand_op(rng)).collect();
    // bias: usually end with an action so the strategy actually trades
    if rng.chance(3, 4) { let l = ops.len(); ops[l - 1] = [op::POS, 0, rng.below(16) as u8, 0]; }
    loop { let p = assemble(&ops); if validate(&p).is_ok() { return p; } if work_of(&p) <= WORK_CAP { return p; } let heavy = ops.iter().position(|o| o[0] >= op::HIST && o[0] <= op::ZW).unwrap_or(0); ops[heavy] = [op::ADD, 1, 0, 1]; }
}
pub fn le<T: Into<u64>>(v: T, n: usize) -> Vec<u8> { v.into().to_le_bytes()[..n].to_vec() }
fn progs_bytes(progs: &[&[u8]]) -> Vec<u8> { let mut o = vec![]; for p in progs { o.extend_from_slice(&(p.len() as u16).to_le_bytes()); o.extend_from_slice(p); } o }
pub fn v_validate(code: &[u8]) -> Vec<u8> { let mut v = vec![0u8]; v.extend_from_slice(code); v }
pub fn v_world(pack: u8, sa: u64, sb: u64, ep: u32) -> Vec<u8> { let mut v = vec![1u8, pack]; v.extend_from_slice(&sa.to_le_bytes()); v.extend_from_slice(&sb.to_le_bytes()); v.extend_from_slice(&ep.to_le_bytes()); v }
pub fn v_trace(pack: u8, sa: u64, sb: u64, ep: u32, nticks: u8, splits: &[u8], progs: &[&[u8]]) -> Vec<u8> { let mut v = vec![2u8, pack]; v.extend_from_slice(&sa.to_le_bytes()); v.extend_from_slice(&sb.to_le_bytes()); v.extend_from_slice(&ep.to_le_bytes()); v.extend_from_slice(&[nticks, progs.len() as u8, splits.len() as u8]); v.extend_from_slice(splits); v.extend_from_slice(&progs_bytes(progs)); v }
pub fn v_season(sa: u64, sb: u64, neps: u8, nticks: u8, progs: &[&[u8]]) -> Vec<u8> { let mut v = vec![3u8]; v.extend_from_slice(&sa.to_le_bytes()); v.extend_from_slice(&sb.to_le_bytes()); v.extend_from_slice(&[neps, nticks, progs.len() as u8]); v.extend_from_slice(&progs_bytes(progs)); v }
pub fn v_synth(rets: &[i32], splits: &[u8], progs: &[&[u8]]) -> Vec<u8> { let mut v = vec![7u8, rets.len() as u8, progs.len() as u8, splits.len() as u8]; v.extend_from_slice(splits); for r in rets { v.extend_from_slice(&r.to_le_bytes()); } v.extend_from_slice(&progs_bytes(progs)); v }
pub fn v_state(market: &[u8], seat: &[u8], r: i32, sg0: i64, code: &[u8]) -> Vec<u8> { let mut v = vec![6u8]; v.extend_from_slice(market); v.extend_from_slice(seat); v.extend_from_slice(&r.to_le_bytes()); v.extend_from_slice(&sg0.to_le_bytes()); v.extend_from_slice(code); v }
