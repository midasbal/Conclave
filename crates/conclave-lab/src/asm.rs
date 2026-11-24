//! Assembler: builds validated VM programs. Floats are allowed HERE (compile-time constants) but never in the VM.
use conclave_vm::{op, NREG, MAX_OPS, VERSION};
pub struct Asm { pub ops: Vec<[u8; 4]>, used: [bool; NREG], pub peak: usize, pub err: Option<&'static str> }
impl Asm {
    pub fn new() -> Self { Asm { ops: vec![], used: [false; NREG], peak: 0, err: None } }
    pub fn r(&mut self) -> u8 { for i in 0..NREG { if !self.used[i] { self.used[i] = true; let n = self.used.iter().filter(|x| **x).count(); if n > self.peak { self.peak = n; } return i as u8; } } self.err = Some("out of registers"); 0 }
    pub fn reserve(&mut self, r: u8) { self.used[r as usize] = true; }
    pub fn f(&mut self, r: u8) { self.used[r as usize] = false; }
    pub fn e(&mut self, o: u8, d: u8, a: u8, b: u8) { self.ops.push([o, d, a, b]); }
    pub fn ldi(&mut self, d: u8, c: f64) { let v = (c * 256.0).round().clamp(-32768.0, 32767.0) as i16 as u16; self.e(op::LDI, d, (v & 255) as u8, (v >> 8) as u8); }
    pub fn sig(&mut self, d: u8, k: u8) { self.e(op::SIG, d, k, 0); }
    pub fn imm5(c: f64) -> u8 { ((c * 32.0).round().clamp(-128.0, 127.0) as i8) as u8 }
    pub fn thr(&mut self, d: u8, a: u8, c: f64) { self.e(op::THR, d, a, Self::imm5(c)); }
    pub fn gti(&mut self, d: u8, a: u8, c: f64) { self.e(op::GTI, d, a, Self::imm5(c)); }
    pub fn lti(&mut self, d: u8, a: u8, c: f64) { self.e(op::LTI, d, a, Self::imm5(c)); }
    pub fn finish(&self) -> Option<Vec<u8>> {
        if self.err.is_some() || self.ops.len() > MAX_OPS { return None; }
        let mut v = vec![VERSION, self.ops.len() as u8, 0, 0]; for o in &self.ops { v.extend_from_slice(o); }
        conclave_vm::validate(&v).ok()?; Some(v)
    }
}
impl Default for Asm { fn default() -> Self { Self::new() } }
