//! The conformance corpus: deterministic generation, (de)serialisation, and the SBF-eligibility estimate.
use crate::*;
use conclave_conformance::run_vector;
use conclave_vm::{op, work_of, world, Market, Seat, DIVISIONS};

pub struct Entry { pub sbf: bool, pub label: String, pub input: Vec<u8>, pub output: Vec<u8> }
const MAGIC: &[u8; 4] = b"CCV1";
pub fn serialise(es: &[Entry]) -> Vec<u8> { let mut o = MAGIC.to_vec(); o.extend_from_slice(&(es.len() as u32).to_le_bytes());
    for e in es { o.push(u8::from(e.sbf)); o.push(e.label.len() as u8); o.extend_from_slice(e.label.as_bytes()); o.extend_from_slice(&(e.input.len() as u32).to_le_bytes()); o.extend_from_slice(&e.input); o.extend_from_slice(&(e.output.len() as u32).to_le_bytes()); o.extend_from_slice(&e.output); } o }
pub fn parse(b: &[u8]) -> Option<Vec<Entry>> { if b.get(..4)? != MAGIC { return None; } let n = u32::from_le_bytes(b.get(4..8)?.try_into().ok()?) as usize; let mut p = 8; let mut v = Vec::with_capacity(n);
    for _ in 0..n { let sbf = *b.get(p)? != 0; let ll = usize::from(*b.get(p + 1)?); p += 2; let label = String::from_utf8_lossy(b.get(p..p + ll)?).to_string(); p += ll;
        let il = u32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?) as usize; p += 4; let input = b.get(p..p + il)?.to_vec(); p += il; let ol = u32::from_le_bytes(b.get(p..p + 4)?.try_into().ok()?) as usize; p += 4; let output = b.get(p..p + ol)?.to_vec(); p += ol; v.push(Entry { sbf, label, input, output }); }
    Some(v) }
/// conservative SBF compute estimate for a vector (compute units); the SBF runner only sends vectors whose estimate is under budget
pub fn est_cu(input: &[u8]) -> u64 {
    let gen = 340_000u64; let seat_hash = 1_400u64;
    let progs_at = |mut p: usize, n: usize| -> Vec<&[u8]> { let mut v = vec![]; for _ in 0..n { if p + 2 > input.len() { break; } let l = usize::from(u16::from_le_bytes([input[p], input[p + 1]])); p += 2; if p + l > input.len() { break; } v.push(&input[p..p + l]); p += l; } v };
    let tick = |progs: &[&[u8]]| -> u64 { 4_800 + progs.iter().map(|c| 700 + 90 * u64::from(work_of(c)) + seat_hash).sum::<u64>() };
    let c = match input.first() { Some(0) => 20_000 + input.len() as u64 * 40, Some(1) => gen + 20_000, Some(4) => 40_000, Some(5) => 700_000,
        Some(2) if input.len() > 26 => { let nt = u64::from(input[22]); let ns = usize::from(input[23]); let nsp = usize::from(input[24]); gen + nt * tick(&progs_at(25 + nsp, ns)) + 30_000 * (nsp as u64 + 1) }
        Some(3) if input.len() > 19 => { let neps = u64::from(input[17]); let nt = u64::from(input[18]); let ns = usize::from(input[19]); neps * (gen + nt * tick(&progs_at(20, ns))) }
        Some(6) => 120_000, Some(7) if input.len() > 4 => { let nt = u64::from(input[1]); let ns = usize::from(input[2]); let nsp = usize::from(input[3]); nt * tick(&progs_at(4 + nsp + 4 * nt as usize, ns)) + 30_000 * (nsp as u64 + 1) }
        _ => 100_000 };
    c + c / 3
}
const ONE_Q: i32 = 1 << 16;
const SBF_BUDGET: u64 = 1_250_000; const SBF_MAX_IN: usize = 1_000;
fn push(es: &mut Vec<Entry>, label: &str, input: Vec<u8>, want_sbf: bool) { let output = run_vector(&input); let sbf = want_sbf && input.len() <= SBF_MAX_IN && est_cu(&input) <= SBF_BUDGET; es.push(Entry { sbf, label: label.to_string(), input, output }); }
fn adds(n: usize) -> Vec<[u8; 4]> { (0..n).map(|i| [op::ADD, 1 + (i % 12) as u8, 0, 1]).collect() }

pub fn build() -> Vec<Entry> {
    let mut es: Vec<Entry> = vec![]; let mut rng = Rng::new(0xC0FF_EE00_1234_5678);
    let pool = conclave_lab::pool::fixed_pool();
    // ---------- VALIDATE: structure, operand classes, header, work-cap boundary ----------
    for c in 0..=255u8 {   // every opcode byte, with a valid-shaped and an all-zero operand set
        for ops in [[c, 1, 0, 1], [c, 0, 0, 0], [c, 1, 2, 0], [c, 1, 1, 3], [c, 0, 5, 0]] { push(&mut es, "validate/opcode", v_validate(&assemble(&[ops, [op::POS, 0, 1, 0]])), true); } }
    for (d, a, b) in [(16u8, 0u8, 0u8), (255, 0, 0), (1, 16, 0), (1, 255, 0), (1, 0, 16), (1, 0, 255), (1, 0, 1), (1, 13, 0), (1, 33, 0), (1, 32, 0), (1, 31, 0), (1, 0, 15), (1, 0, 16)] {
        for c in [op::LDI, op::SIG, op::MOV, op::ADD, op::GTI, op::EMA, op::HIST, op::WSUM, op::VOLW, op::ZW, op::LONG, op::POS, op::NOP] { push(&mut es, "validate/operand", v_validate(&assemble(&[[c, d, a, b]])), true); } }
    for ver in [0u8, 1, 2, 3, 4, 255] { for n in [0u8, 1, 63, 64, 65, 255] { let mut p = vec![ver, n, 0, 0]; p.extend(std::iter::repeat([op::NOP, 0, 0, 0]).take(usize::from(n.min(66))).flatten()); push(&mut es, "validate/header", v_validate(&p), true); } }
    for len in 0..8 { push(&mut es, "validate/short", v_validate(&vec![2u8; len]), true); }
    for (b2, b3) in [(1u8, 0u8), (0, 1), (255, 255)] { push(&mut es, "validate/noncanonical", v_validate(&[2, 1, b2, b3, op::NOP, 0, 0, 0]), true); }
    for delta in [-8i32, -4, -1, 1, 4, 8] { let mut p = assemble(&adds(5)); if delta < 0 { p.truncate((p.len() as i32 + delta) as usize); } else { p.extend(std::iter::repeat(0u8).take(delta as usize)); } push(&mut es, "validate/length", v_validate(&p), true); }
    // work-cap boundary: window ops of known weight plus ADD fill, total work 56..=72 (cap is 64)
    for target in 56..=72usize { for kind in 0..6usize { let (win, w): (Option<[u8; 4]>, usize) = match kind { 0 => (None, 1), 1 => (Some([op::HIST, 1, 3, 0]), 5), 2 => (Some([op::WSUM, 1, 32, 0]), 16), 3 => (Some([op::VOLW, 1, 32, 0]), 19), 4 => (Some([op::ZW, 1, 32, 0]), 43), _ => (Some([op::ZW, 1, 2, 0]), 13) };
        let mut ops: Vec<[u8; 4]> = vec![]; let mut work = 0usize; if let Some(o) = win { while work + w <= target && ops.len() < 3 { ops.push(o); work += w; } } while work < target && ops.len() < 64 { ops.push([op::ADD, 1, 0, 1]); work += 1; }
        let p = assemble(&ops); push(&mut es, &format!("validate/cap {} (work {})", target, work_of(&p)), v_validate(&p), true); } }
    let mut max64 = adds(63); max64.push([op::POS, 0, 1, 0]); push(&mut es, "validate/64 ops work 64", v_validate(&assemble(&max64)), true); max64[0] = [op::HIST, 1, 0, 0]; push(&mut es, "validate/64 ops work 68", v_validate(&assemble(&max64)), true);
    for d in DIVISIONS { let mut ops = adds(d as usize - 1); ops.push([op::POS, 0, 1, 0]); push(&mut es, &format!("validate/division {}", d), v_validate(&assemble(&ops)), true); }
    for s in &pool { push(&mut es, &format!("validate/pool {}", s.name), v_validate(&s.code), true); }
    for _ in 0..200 { let p = rand_program(&mut rng, 64); push(&mut es, "validate/random valid", v_validate(&p), true); }
    for _ in 0..200 { let mut p = rand_program(&mut rng, 40); for _ in 0..rng.range(1, 3) { let i = rng.below(p.len() as u64) as usize; p[i] = rng.byte(); } push(&mut es, "validate/mutated", v_validate(&p), true); }
    // ---------- WORLD ----------
    for pack in 0..6u8 { for k in 0..16u64 { let (sa, sb, ep) = match k { 0 => (0, 0, 0), 1 => (u64::MAX, u64::MAX, u32::MAX), 2 => (1, 0, 1), 3 => (0, 1, 1000), _ => (rng.next(), rng.next(), rng.next() as u32) }; push(&mut es, &format!("world/pack {}", pack), v_world(pack, sa, sb, ep), true); } }
    for pack in [6u8, 7, 11, 12, 100, 255] { push(&mut es, "world/pack index wraps", v_world(pack, 7, 9, 3), true); }
    // ---------- TRACE: every pool program, three scenarios; multi-seat; random programs; split round trips ----------
    for (i, s) in pool.iter().enumerate() { let pack = (i % 6) as u8; let (sa, sb, ep) = (rng.next(), rng.next(), i as u32);
        push(&mut es, &format!("trace/pool {} 150 ticks", s.name), v_trace(pack, sa, sb, ep, 150, &[], &[&s.code]), false);
        push(&mut es, &format!("trace/pool {} 150 ticks split", s.name), v_trace(pack, sa, sb, ep, 150, &[1, 17, 32, 33, 100, 149], &[&s.code]), false);
        for nt in [30u8, 90] { push(&mut es, &format!("trace/pool {} {} ticks", s.name, nt), v_trace(pack, sa, sb, ep, nt, &[], &[&s.code]), true); } }
    for _ in 0..60 { let ns = rng.range(2, 4) as usize; let ps: Vec<Vec<u8>> = (0..ns).map(|_| pool[rng.below(pool.len() as u64) as usize].code.clone()).collect(); let r: Vec<&[u8]> = ps.iter().map(|v| v.as_slice()).collect();
        let (pack, sa, sb, ep) = (rng.below(6) as u8, rng.next(), rng.next(), rng.next() as u32); push(&mut es, "trace/multi-seat 150", v_trace(pack, sa, sb, ep, 150, &[], &r), false); push(&mut es, "trace/multi-seat 150 split", v_trace(pack, sa, sb, ep, 150, &[3, 64, 65], &r), false); push(&mut es, "trace/multi-seat 24", v_trace(pack, sa, sb, ep, 24, &[], &r[..2.min(r.len())]), true); }
    for k in 0..400 { let p = rand_program(&mut rng, 64); let (pack, sa, sb, ep) = (rng.below(6) as u8, rng.next(), rng.next(), rng.next() as u32);
        push(&mut es, "trace/random program 150", v_trace(pack, sa, sb, ep, 150, &[], &[&p]), false); if k % 2 == 0 { push(&mut es, "trace/random program sbf", v_trace(pack, sa, sb, ep, rng.range(5, 60) as u8, &[], &[&p]), true); } }
    for pack in 0..6u8 { for k in 0..30u64 { let long = vec![op::LDI, 1, 0, 1]; let p = assemble(&[[long[0], long[1], long[2], long[3]], [op::POS, 0, 1, 0]]); push(&mut es, "trace/always long (ruin floor)", v_trace(pack, 1000 + k, 7, k as u32, 150, &[], &[&p]), false); } }
    // ---------- SEASON ----------
    for k in 0..30u64 { let ns = rng.range(1, 3) as usize; let ps: Vec<Vec<u8>> = (0..ns).map(|_| pool[rng.below(pool.len() as u64) as usize].code.clone()).collect(); let r: Vec<&[u8]> = ps.iter().map(|v| v.as_slice()).collect(); push(&mut es, "season/host+wasm", v_season(rng.next(), rng.next(), (3 + k % 10) as u8, 150, &r), false); }
    for _ in 0..16 { let p = pool[rng.below(pool.len() as u64) as usize].code.clone(); push(&mut es, "season/sbf 2 episodes", v_season(rng.next(), rng.next(), 2, 10, &[&p]), true); }
    // ---------- PINS, OPWORK ----------
    push(&mut es, "pins", vec![4], true); for lo in (0..=255u16).step_by(32) { push(&mut es, "opwork", vec![5, lo as u8, (lo + 31) as u8], true); }
    // ---------- STATE: valid states taken mid-run, and arbitrary hostile bytes ----------
    let prog = pool[pool.len() - 1].code.clone();
    for k in 0..12u32 { let mut rets = [0i32; world::WORLD_T]; world::gen_episode(k as usize % 6, world::episode_seed(5, 6, k as u64), &mut rets); let mut m = Market::new(150); let mut s = Seat::new(); let upto = 5 + 11 * k as usize;
        for r in rets.iter().take(upto) { let sg = m.advance(*r); s.step(&prog, &m, *r, sg); } let (mut mb, mut sb) = (vec![0u8; Market::BYTES], vec![0u8; Seat::BYTES]); m.save(&mut mb); s.save(&mut sb); push(&mut es, "state/valid mid-run", v_state(&mb, &sb, rets[upto.min(149)], 8000, &prog), true); }
    for k in 0..120 { let mut mb: Vec<u8> = (0..Market::BYTES).map(|_| rng.byte()).collect(); let mut sb: Vec<u8> = (0..Seat::BYTES).map(|_| rng.byte()).collect();
        if k % 3 == 0 { for c in mb.iter_mut() { *c = if rng.chance(1, 2) { 0xFF } else { 0x7F }; } for c in sb.iter_mut() { *c = if rng.chance(1, 2) { 0x80 } else { 0xFF }; } } else if k % 3 == 1 { for c in mb.iter_mut().skip(8) { if rng.chance(3, 4) { *c = 0; } } }
        let r = [0i32, i32::MAX, i32::MIN, 1, -1, rng.next() as i32][rng.below(6) as usize]; let sg = [0i64, 1, -1, i64::MAX, i64::MIN, 1000, rng.next() as i64][rng.below(7) as usize]; let p = rand_program(&mut rng, 30); push(&mut es, "state/hostile bytes", v_state(&mb, &sb, r, sg, &p), true); }
    // unvalidated, hostile program blobs run through `step` (defence in depth: the program validates first, the VM must still never abort)
    { let mut mb = vec![0u8; Market::BYTES]; Market::new(150).save(&mut mb); let mut sb = vec![0u8; Seat::BYTES]; Seat::new().save(&mut sb);
      let hostile: Vec<Vec<u8>> = vec![vec![], vec![2], vec![2, 5, 0, 0], vec![2, 5, 0, 0, op::ADD, 1, 0, 1], vec![2, 255, 0, 0, op::ADD, 1, 0, 1, op::POS, 0, 1, 0], vec![2, 1, 0, 0, op::VOLW, 1, 0, 0], vec![2, 1, 0, 0, op::VOLW, 1, 255, 0], vec![2, 1, 0, 0, op::WSUM, 1, 0, 0], vec![2, 1, 0, 0, op::WSUM, 1, 255, 0],
          vec![2, 1, 0, 0, op::ZW, 1, 1, 0], vec![2, 1, 0, 0, op::ZW, 1, 255, 0], vec![2, 1, 0, 0, op::HIST, 1, 255, 0], vec![2, 1, 0, 0, op::EMA, 1, 0, 200], vec![2, 1, 0, 0, op::EMA, 1, 0, 64], vec![2, 1, 0, 0, op::SIG, 1, 200, 0], vec![2, 1, 0, 0, 200, 1, 2, 3], vec![2, 1, 0, 0, op::DIV, 255, 255, 255],
          vec![2, 2, 0, 0, op::POS, 0, 200, 0, op::LDI, 1, 255, 255], vec![9, 3, 7, 7, 1, 1, 1, 1], vec![2, 1, 9, 9, op::SEL, 1, 2, 3]];
      for h in &hostile { for r in [0i32, 123_456, i32::MAX, i32::MIN] { push(&mut es, "state/hostile program blob", v_state(&mb, &sb, r, 8000, h), true); } } }
    // exact-boundary states: ruin floor and stop level, one unit below / at / above
    { let long = assemble(&[[op::LDI, 1, 0, 1], [op::POS, 0, 1, 0]]); let mut mb = vec![0u8; Market::BYTES]; Market::new(150).save(&mut mb);
      for d in [-1i64, 0, 1] { let mut st = Seat::new(); st.cash = conclave_vm::RUIN_FLOOR_Q16 + d; st.dir = 1; st.pos = ONE_Q; let mut sb = vec![0u8; Seat::BYTES]; st.save(&mut sb); push(&mut es, &format!("state/ruin boundary {:+}", d), v_state(&mb, &sb, 0, 8000, &long), true); }
      for d in [-1i64, 0, 1] { let mut st = Seat::new(); st.stop = ONE_Q; st.trade = -i64::from(ONE_Q) + d; st.dir = 1; st.pos = ONE_Q; let mut sb = vec![0u8; Seat::BYTES]; st.save(&mut sb); push(&mut es, &format!("state/stop boundary {:+}", d), v_state(&mb, &sb, 0, 8000, &long), true); }
      for r in [191_999i32, 192_000, 192_001, -191_999, -192_000, -192_001, 30_000_000, -30_000_000] { let mut st = Seat::new(); st.pos = ONE_Q; st.dir = 1; let mut sb = vec![0u8; Seat::BYTES]; st.save(&mut sb); push(&mut es, &format!("state/gap cap boundary r={}", r), v_state(&mb, &sb, r, 8000, &long), true); } }
    // ---------- SYNTH: adversarial return series ----------
    let progs: Vec<Vec<u8>> = vec![assemble(&[[op::LDI, 1, 0, 1], [op::POS, 0, 1, 0]]), pool[pool.len() - 1].code.clone(), pool[20].code.clone(), pool.iter().find(|s| s.name == "SwitchBrk").map(|s| s.code.clone()).unwrap_or_else(|| pool[0].code.clone())];
    let pats: Vec<(&str, Box<dyn Fn(&mut Rng, usize) -> i32>)> = vec![("max", Box::new(|_, _| i32::MAX)), ("min", Box::new(|_, _| i32::MIN)), ("alt rmax", Box::new(|_, i| if i % 2 == 0 { 1 << 24 } else { -(1 << 24) })), ("zeros", Box::new(|_, _| 0)),
        ("zeros then spike", Box::new(|_, i| if i == 70 { 9_000_000 } else if i == 71 { -9_000_000 } else { 0 })), ("ramp", Box::new(|_, i| (i as i32 - 75) * 20_000)), ("full range random", Box::new(|r, _| r.next() as i32)), ("small noise", Box::new(|r, _| (r.below(2001) as i32) - 1000)),
        ("crash", Box::new(|_, i| if i < 100 { -4_000 } else { -400_000 })), ("lopsided", Box::new(|r, i| if i % 7 == 0 { 3_000_000 } else { -(r.below(500) as i32) }))];
    for (name, f) in pats.iter() { for (pi, p) in progs.iter().enumerate() { let rets: Vec<i32> = (0..150).map(|i| f(&mut rng, i)).collect(); push(&mut es, &format!("synth/{} prog{}", name, pi), v_synth(&rets, &[], &[p]), false); push(&mut es, &format!("synth/{} prog{} split", name, pi), v_synth(&rets, &[5, 60, 61, 149], &[p]), false);
        let n = 60.min(rets.len()); push(&mut es, &format!("synth/{} prog{} sbf", name, pi), v_synth(&rets[..n], &[], &[p]), true); } }
    es
}
