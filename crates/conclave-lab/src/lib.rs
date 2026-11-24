pub mod asm; pub mod run; pub mod pool;
use conclave_vm::world::{self, WORLD_T};
// ---- WASM / C ABI (also callable natively) ----
#[no_mangle] pub extern "C" fn cv_alloc(n: usize) -> *mut u8 { let mut v = Vec::<u8>::with_capacity(n); let p = v.as_mut_ptr(); std::mem::forget(v); p }
/// Fill out[0..150] (i32) with world returns.
#[no_mangle] pub unsafe extern "C" fn cv_world(pack: u32, seed_a_lo: u32, seed_a_hi: u32, seed_b_lo: u32, seed_b_hi: u32, ep: u32, out: *mut i32) {
    let sa = (seed_a_hi as u64) << 32 | seed_a_lo as u64; let sb = (seed_b_hi as u64) << 32 | seed_b_lo as u64;
    let mut r = [0i32; WORLD_T]; world::gen_episode(pack as usize, world::episode_seed(sa, sb, ep as u64), &mut r);
    std::ptr::copy_nonoverlapping(r.as_ptr(), out, WORLD_T);
}
/// blob = [u16 count] then count x ([u16 len][bytes]). Writes count x i64 pnl (and optional metered work, may be null) to out. Returns count or 0 on invalid program.
#[no_mangle] pub unsafe extern "C" fn cv_run(blob: *const u8, blob_len: usize, pack: u32, seed_a_lo: u32, seed_a_hi: u32, seed_b_lo: u32, seed_b_hi: u32, ep: u32, out: *mut i64) -> u32 {
    let b = std::slice::from_raw_parts(blob, blob_len); let n = u16::from_le_bytes([b[0], b[1]]) as usize; let mut off = 2; let mut progs: Vec<&[u8]> = vec![];
    for _ in 0..n { let l = u16::from_le_bytes([b[off], b[off + 1]]) as usize; off += 2; let p = &b[off..off + l]; off += l; if conclave_vm::validate(p).is_err() { return 0; } progs.push(p); }
    let sa = (seed_a_hi as u64) << 32 | seed_a_lo as u64; let sb = (seed_b_hi as u64) << 32 | seed_b_lo as u64;
    let mut res = vec![0i64; n]; run::run_episode(&progs, pack as usize, sa, sb, ep as u64, &mut res, None);
    std::ptr::copy_nonoverlapping(res.as_ptr(), out, n); n as u32
}
