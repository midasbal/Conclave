//! C ABI for the WASM build (and for native callers). One output buffer per thread: call, then read `ca_out()` for the returned length.
//!   ca_assemble(src utf8)                         -> JSON listing (see source::assembly_json)
//!   ca_disassemble(bytecode)                      -> canonical source text, or "ERROR <VmError>"
//!   ca_simulate([mode u8][worlds u32][episodes u32][base u64][flags u8][single u32][bytecode]) -> JSON (mode 0) or the text report (mode 1); flags bit0 = reference field, bit1 = single seed given
//!   ca_episode(bytecode, pack, episode seed)      -> that episode's final PnL (Q16.16) on the real VM, for cross-checks against the conformance vectors
use std::cell::RefCell;
thread_local! { static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) }; }
fn set(v: Vec<u8>) -> usize { OUT.with(|o| { let mut b = o.borrow_mut(); *b = v; b.len() }) }
#[no_mangle] pub extern "C" fn ca_alloc(n: usize) -> *mut u8 { let mut v = Vec::<u8>::with_capacity(n.max(1)); let p = v.as_mut_ptr(); std::mem::forget(v); p }
#[no_mangle] pub extern "C" fn ca_out() -> *const u8 { OUT.with(|o| o.borrow().as_ptr()) }
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle] pub unsafe extern "C" fn ca_assemble(ptr: *const u8, len: usize) -> usize { let b = std::slice::from_raw_parts(ptr, len); match std::str::from_utf8(b) { Ok(s) => set(crate::source::assembly_json(&crate::source::assemble(s)).into_bytes()), Err(_) => set(br#"{"ok":false,"errors":[{"line":1,"col":1,"msg":"source is not valid UTF-8"}]}"#.to_vec()) } }
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle] pub unsafe extern "C" fn ca_disassemble(ptr: *const u8, len: usize) -> usize { let b = std::slice::from_raw_parts(ptr, len); set(match crate::source::disassemble(b) { Ok(s) => s.into_bytes(), Err(e) => format!("ERROR {:?}", e).into_bytes() }) }
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle] pub unsafe extern "C" fn ca_simulate(ptr: *const u8, len: usize) -> usize {
    let b = std::slice::from_raw_parts(ptr, len); if b.len() < 22 { return set(b"ERROR short input".to_vec()); }
    let (mode, worlds, episodes, base, flags, single) = (b[0], u32::from_le_bytes([b[1], b[2], b[3], b[4]]), u32::from_le_bytes([b[5], b[6], b[7], b[8]]), u64::from_le_bytes([b[9], b[10], b[11], b[12], b[13], b[14], b[15], b[16]]), b[17], u32::from_le_bytes([b[18], b[19], b[20], b[21]]));
    let code = &b[22..]; if conclave_vm::validate(code).is_err() { return set(b"ERROR bytecode does not validate".to_vec()); }
    if worlds == 0 || worlds > 2000 || episodes == 0 || episodes > 200 { return set(b"ERROR worlds must be 1..2000 and episodes 1..200".to_vec()); }
    let cfg = crate::sim::Config { worlds, episodes, base, field: flags & 1 != 0, pack_eps: 120, single: if flags & 2 != 0 { Some(single) } else { None } };
    let r = crate::sim::simulate(code, &cfg); set(if mode == 1 { r.to_text().into_bytes() } else { r.to_json().into_bytes() })
}
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle] pub unsafe extern "C" fn ca_episode(ptr: *const u8, len: usize, pack: u32, es_lo: u32, es_hi: u32) -> i64 { let code = std::slice::from_raw_parts(ptr, len); if conclave_vm::validate(code).is_err() { return i64::MIN; } crate::sim::episode(code, pack as usize, (u64::from(es_hi) << 32) | u64::from(es_lo)).pnl }
/// # Safety
/// `ptr` must point to `len` readable bytes.
/// Same text the native CLI prints for `asm`: the per-instruction cost table, total, division, bytecode and hashes.
#[no_mangle] pub unsafe extern "C" fn ca_listing(ptr: *const u8, len: usize) -> usize { let b = std::slice::from_raw_parts(ptr, len); match std::str::from_utf8(b) { Ok(s) => { let a = crate::source::assemble(s); set(crate::source::listing(&a, s).into_bytes()) } Err(_) => set(b"error: source is not valid UTF-8\n".to_vec()) } }
/// # Safety
/// `ptr` must point to `len` readable bytes.
/// One episode through the same seeding the conformance TRACE vector uses (pack, season seed words, episode index): final PnL (Q16.16), or i64::MIN for invalid bytecode.
#[no_mangle] pub unsafe extern "C" fn ca_trace(ptr: *const u8, len: usize, pack: u32, sa_lo: u32, sa_hi: u32, sb_lo: u32, sb_hi: u32, ep: u32) -> i64 { let code = std::slice::from_raw_parts(ptr, len); if conclave_vm::validate(code).is_err() { return i64::MIN; }
    let (sa, sb) = ((u64::from(sa_hi) << 32) | u64::from(sa_lo), (u64::from(sb_hi) << 32) | u64::from(sb_lo)); crate::sim::episode(code, pack as usize, conclave_vm::world::episode_seed(sa, sb, u64::from(ep))).pnl }
/// # Safety
/// `ptr` must point to `len` readable bytes.
/// One season of several strategies together, exactly the chain's loop (shared market, one seat each): input [sa u64][sb u64][neps u32][n u8] then n x ([u16 len][bytecode]).
/// Output JSON {"packs":[p0,p1],"totals":["Q16.16 season total as a decimal string", ...]} in input order.
#[no_mangle] pub unsafe extern "C" fn ca_season(ptr: *const u8, len: usize) -> usize {
    let b = std::slice::from_raw_parts(ptr, len); if b.len() < 21 { return set(b"ERROR short input".to_vec()); }
    let (sa, sb, neps, n) = (u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]), u64::from_le_bytes([b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]]), u32::from_le_bytes([b[16], b[17], b[18], b[19]]), usize::from(b[20]));
    if neps == 0 || neps > 1000 || n == 0 { return set(b"ERROR bad season".to_vec()); }
    let mut progs: Vec<&[u8]> = vec![]; let mut o = 21; for _ in 0..n { if o + 2 > b.len() { return set(b"ERROR truncated".to_vec()); } let l = usize::from(u16::from_le_bytes([b[o], b[o + 1]])); o += 2; if o + l > b.len() { return set(b"ERROR truncated".to_vec()); } let p = &b[o..o + l]; o += l; if conclave_vm::validate(p).is_err() { return set(b"ERROR bytecode does not validate".to_vec()); } progs.push(p); }
    let packs = conclave_vm::world::season_packs(sa, sb); let t = crate::sim::field_totals(&progs, sa, sb, neps);
    set(crate::json::J::obj(vec![("packs", crate::json::J::arr(vec![crate::json::J::n(packs[0] as f64), crate::json::J::n(packs[1] as f64)])), ("totals", crate::json::J::arr(t.iter().map(|v| crate::json::J::s(&v.to_string())).collect()))]).to_string().into_bytes())
}
