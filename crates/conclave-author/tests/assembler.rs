use conclave_author::source::{assemble, disassemble, division_for, OPS};
use conclave_conformance_tools::{rand_program, Rng};
use conclave_vm::{validate, work_of, WORK_CAP};

const HEAD: &str = "conclave-strategy 1 ruleset 2\n";
fn ok(body: &str) -> conclave_author::source::Assembly { let a = assemble(&format!("{}{}", HEAD, body)); assert!(a.is_ok(), "expected to assemble: {:?}\n{}", a.errors, body); a }
fn errs(src: &str) -> Vec<(usize, String)> { assemble(src).errors.into_iter().map(|d| (d.line, d.msg)).collect() }
fn has(src: &str, line: usize, needle: &str) { let e = errs(src); assert!(e.iter().any(|(l, m)| *l == line && m.contains(needle)), "expected an error on line {} containing '{}', got {:?}\nsource:\n{}", line, needle, e, src); }
fn strategies() -> Vec<(String, String)> { let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../strategies"); let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x == "cvs").unwrap_or(false)).collect(); v.sort();
    v.into_iter().map(|p| (p.file_stem().unwrap().to_string_lossy().to_string(), std::fs::read_to_string(p).unwrap())).collect() }

#[test] fn every_example_assembles_and_lands_in_the_expected_division() {
    let want = [("at_the_cap", 64, 64), ("breakout_with_stop", 40, 64), ("calm_trend", 6, 16), ("ema_cross", 7, 16), ("mean_reversion", 31, 32), ("momentum", 4, 16)];
    let all = strategies(); assert_eq!(all.len(), want.len(), "the examples and this table must agree");
    for ((n, src), (wn, work, div)) in all.iter().zip(want) { assert_eq!(n, wn); let a = assemble(src); assert!(a.is_ok(), "{}: {:?}", n, a.errors); assert!(a.warnings.is_empty(), "{} should be warning-free: {:?}", n, a.warnings); assert_eq!(a.work, work, "{}", n); assert_eq!(a.division, Some(div), "{}", n); let c = a.code.unwrap(); assert_eq!(validate(&c).unwrap(), a.ops.len()); assert_eq!(work_of(&c), work); } }

#[test] fn work_is_charged_from_the_published_weights_for_every_window_size() {
    // independent statement of the weights in the ruleset: plain 1, HIST 5, WSUM 5+ceil(n/3), VOLW 6+ceil(2n/5), ZW 11+n
    fn weight(op: &str, n: u32) -> u32 { match op { "hist" => 5, "wsum" => 5 + n.div_ceil(3), "volw" => 6 + (2 * n).div_ceil(5), "zw" => 11 + n, _ => 1 } }
    for n in 1..=32u32 { for op in ["wsum", "volw", "zw"] { let a = ok(&format!("x = {} {}\npos x\n", op, n)); assert_eq!(a.ops[0].work, weight(op, n), "{} {}", op, n); assert_eq!(a.work, weight(op, n) + 1); assert_eq!(a.work, work_of(a.code.as_ref().unwrap())); } }
    for lag in 0..32u32 { let a = ok(&format!("x = hist {}\npos x\n", lag)); assert_eq!(a.ops[0].work, 5); }
    for o in OPS.iter().filter(|o| !matches!(o.name, "hist" | "wsum" | "volw" | "zw")) { assert_eq!(conclave_vm::op_work(o.code, 7), 1, "{} is a plain op", o.name); }
    // the breakdown sums to the total and every line is listed
    let a = ok("a = zw 16\nb = wsum 9\nc = hist 3\nd = volw 10\npos a\n"); assert_eq!(a.ops.iter().map(|o| o.work).collect::<Vec<_>>(), vec![27, 8, 5, 10, 1]); assert_eq!(a.work, 51); assert_eq!(a.division, Some(64)); }

#[test] fn divisions_are_reported_at_the_boundaries() {
    for (w, d) in [(0, Some(16)), (1, Some(16)), (16, Some(16)), (17, Some(32)), (32, Some(32)), (33, Some(64)), (64, Some(64)), (65, None), (500, None)] { assert_eq!(division_for(w), d, "work {}", w); }
    let mk = |n: usize| { let mut s = String::new(); for _ in 0..n { s += "x = sig T5\n"; } s += "pos x\n"; ok(&s) }; assert_eq!(mk(15).division, Some(16)); assert_eq!(mk(16).division, Some(32)); assert_eq!(mk(31).division, Some(32)); assert_eq!(mk(32).division, Some(64)); assert_eq!(mk(62).work, 63); }

#[test] fn the_work_cap_of_64_is_exact_and_refused_above() {
    let mut s = String::from(HEAD); s += "z = zw 32\nw = wsum 12\n"; for _ in 0..11 { s += "x = sig T5\n"; } s += "pos x\n"; let a = assemble(&s); assert_eq!(a.work, 64); assert!(a.is_ok()); assert_eq!(a.division, Some(64));
    let over = s.replace("pos x\n", "x = sig T5\npos x\n"); let a = assemble(&over); assert_eq!(a.work, 65); assert!(!a.is_ok()); assert!(a.code.is_none(), "no bytecode is produced for an over-cap strategy"); assert_eq!(a.division, None);
    let m = &a.errors[0].msg; assert!(m.contains("over the cap of 64") && m.contains("by 1") && m.contains("zw") && m.contains("costs 43"), "{}", m);
    // the listing is still produced so the author sees where the cost is
    assert_eq!(a.ops.len(), 15); assert_eq!(a.ops[0].work, 43); assert_eq!(a.ops.iter().map(|o| o.work).sum::<u32>(), 65);
    // refusing agrees with the VM's own validate
    let mut ops = vec![[conclave_vm::op::ZW, 0, 32, 0], [conclave_vm::op::WSUM, 1, 12, 0]]; for _ in 0..13 { ops.push([conclave_vm::op::SIG, 2, 0, 0]); } let mut v = vec![conclave_vm::VERSION, ops.len() as u8, 0, 0]; for o in &ops { v.extend_from_slice(o); } assert_eq!(validate(&v), Err(conclave_vm::VmError::OverWorkCap)); }

#[test] fn instruction_count_limit() {
    let mut s = String::from(HEAD); for _ in 0..64 { s += "nop\n"; } assert!(assemble(&s).is_ok()); s += "nop\n"; let a = assemble(&s); assert!(!a.is_ok()); assert!(a.errors[0].msg.contains("too many instructions") && a.errors[0].msg.contains("65")); assert_eq!(a.errors[0].line, 66); }

#[test] fn malformed_input_is_rejected_with_a_clear_message_and_position() {
    has("x = sig T20\npos x\n", 1, "first statement must be the header");
    has("", 1, "empty source");
    has("conclave-strategy 1 ruleset 3\nnop\n", 1, "targets ruleset 3 but this build is ruleset 2");
    has("conclave-strategy 2 ruleset 2\nnop\n", 1, "source format 2 is not supported");
    has("conclave-strategy one ruleset 2\n", 1, "must be a number"); has("conclave-strategy 1\n", 1, "malformed header");
    has(&format!("{}{}", HEAD, HEAD), 2, "header may appear only once");
    has(&format!("{}x = sigg T20\n", HEAD), 2, "unknown mnemonic 'sigg'"); has(&format!("{}x = sigg T20\n", HEAD), 2, "did you mean 'sig'");
    has(&format!("{}x = sig T21\n", HEAD), 2, "unknown signal 'T21'"); has(&format!("{}x = ema x 16\n", HEAD), 2, "ema shift must be a whole number 0..15");
    has(&format!("{}x = hist 32\n", HEAD), 2, "hist lag must be a whole number 0..31"); for bad in ["0", "33", "-1", "x"] { has(&format!("{}x = zw {}\n", HEAD, bad), 2, "window must be a whole number 1..32"); }
    has(&format!("{}x = const 128\n", HEAD), 2, "outside the const range"); has(&format!("{}x = const -128.5\n", HEAD), 2, "outside the const range"); has(&format!("{}x = const abc\n", HEAD), 2, "is not a number");
    has(&format!("{}y = sig T5\nx = thr y 4\n", HEAD), 3, "outside the threshold range"); has(&format!("{}y = sig T5\nx = thr y -4.5\n", HEAD), 3, "outside the threshold range");
    has(&format!("{}x = add y z\n", HEAD), 2, "'y' is read before it exists"); has(&format!("{}pos q\n", HEAD), 2, "'q' is read before it exists");
    has(&format!("{}x = sig T5\ny = add x\n", HEAD), 3, "add takes 2 operands"); has(&format!("{}x = sig T5\npos x x\n", HEAD), 3, "pos takes 1 operand"); has(&format!("{}x = sig\n", HEAD), 2, "sig takes 1 operand");
    has(&format!("{}x = sig T5\ny = pos x\n", HEAD), 3, "pos has no destination"); has(&format!("{}add x x\n", HEAD), 2, "add needs a destination"); has(&format!("{}x = sig T5\nx = nop\n", HEAD), 3, "nop has no destination");
    has(&format!("{}r16 = sig T5\n", HEAD), 2, "not a register"); has(&format!("{}pos r99\n", HEAD), 2, "not a register"); has(&format!("{}add = sig T5\n", HEAD), 2, "mnemonic or keyword"); has(&format!("{}1x = sig T5\n", HEAD), 2, "not a valid register name");
    has(&format!("{}x = sig T5\nfree y\n", HEAD), 3, "not a register that exists"); has(&format!("{}state x\nstate x\n", HEAD), 3, "already exists");
    has(&format!("{}name \"a\"\nname \"b\"\n", HEAD), 3, "set twice"); has(&format!("{}name unquoted\n", HEAD), 2, "takes one quoted string"); has(&format!("{}name \"caf\u{e9}\"\n", HEAD), 2, "plain printable ASCII"); has(&format!("{}name \"unterminated\n", HEAD), 2, "unterminated string");
    has(&format!("{}x = sig T5 = y\n", HEAD), 2, "only one '=' is allowed");
    // every message carries line and column, never a panic, whatever the input
    for junk in ["\u{0}", "= = =", "x = ", "= sig T5", "####", "x\u{7f} = sig T5", "state", "free", "pos", "\"", "x = const 1e5", "x = const --1", "x = const .", "x = const 99999999999999999999"] { let a = assemble(&format!("{}{}\n", HEAD, junk)); for d in a.errors.iter().chain(a.warnings.iter()) { assert!(d.line >= 1 && d.col >= 1, "{:?}", d); } assert!(a.code.is_none() || a.errors.is_empty()); } }

#[test] fn several_errors_are_reported_in_one_pass() { let e = errs(&format!("{}x = sigg T5\ny = add p q\nz = hist 99\npos w\n", HEAD)); assert!(e.len() >= 4, "{:?}", e); let lines: Vec<usize> = e.iter().map(|x| x.0).collect(); assert!(lines.contains(&2) && lines.contains(&3) && lines.contains(&4) && lines.contains(&5)); }

#[test] fn register_allocation_is_deterministic_and_explicit_registers_are_reserved() {
    let a = ok("a = sig T5\nb = sig T10\nc = sig T20\npos a\n"); assert_eq!(a.registers, vec![("a".into(), 0), ("b".into(), 1), ("c".into(), 2)]);
    let b = ok("r0 = sig T5\nx = sig T10\npos x\n"); assert_eq!(b.registers, vec![("x".into(), 1)], "an automatic name never lands on a register written explicitly"); assert_eq!(b.code.as_ref().unwrap()[4 + 1], 0); assert_eq!(b.code.as_ref().unwrap()[8 + 1], 1);
    let c = ok("a = sig T5\nfree a\nb = sig T10\npos b\n"); assert_eq!(c.registers, vec![("b".into(), 0)], "free releases the register for reuse");
    let mut s = String::from(HEAD); for i in 0..16 { s += &format!("v{} = sig T5\n", i); } s += "pos v0\n"; assert!(assemble(&s).is_ok(), "16 registers are available"); let s17 = s.replace("pos v0\n", "v16 = sig T5\npos v0\n"); has(&s17, 18, "out of registers"); }

#[test] fn state_and_register_reads_follow_the_rules() {
    has(&format!("{}x = add prev prev\npos x\n", HEAD), 2, "read before it exists"); let a = ok("state prev\nx = sig U1\nx = sub x prev\nprev = mov x\npos x\n"); assert_eq!(a.registers[0], ("prev".to_string(), 0));
    // ema keeps its own value between ticks, so a fresh destination is legitimate
    ok("c = sig CUM\nf = ema c 2\npos f\n");
    // sel reads its destination as the condition: assigning nothing first earns a warning
    let w = assemble(&format!("{}a = sig T5\nb = sig T10\nc = sel a b\npos c\n", HEAD)); assert!(w.is_ok()); assert!(w.warnings.iter().any(|d| d.msg.contains("sel reads its destination")), "{:?}", w.warnings);
    let none = assemble(&format!("{}x = sig T5\n", HEAD)); assert!(none.warnings.iter().any(|d| d.msg.contains("can never take a position")), "{:?}", none.warnings); }

#[test] fn numbers_are_quantised_with_integer_arithmetic_and_flagged_when_inexact() {
    let a = ok("x = const 0.25\ny = const -1.5\nz = const 127.99609375\nw = const -128\npos x\n"); assert!(a.warnings.is_empty()); let c = a.code.unwrap(); assert_eq!(i16::from_le_bytes([c[4 + 2], c[4 + 3]]), 64); assert_eq!(i16::from_le_bytes([c[8 + 2], c[8 + 3]]), -384); assert_eq!(i16::from_le_bytes([c[12 + 2], c[12 + 3]]), 32767); assert_eq!(i16::from_le_bytes([c[16 + 2], c[16 + 3]]), -32768);
    let b = assemble(&format!("{}x = const 0.3333\npos x\n", HEAD)); assert!(b.is_ok()); assert_eq!(i16::from_le_bytes([b.code.as_ref().unwrap()[6], b.code.as_ref().unwrap()[7]]), 85); assert!(b.warnings[0].msg.contains("stored as 0.33203125"), "{:?}", b.warnings);
    for (txt, q) in [("0.125", 4i8), ("-0.125", -4), ("3.96875", 127), ("-4", -128), ("0.05", 2), ("-0.05", -2), ("0.1", 3), ("1", 32)] { let a = ok(&format!("y = sig T5\nx = thr y {}\npos x\n", txt)); assert_eq!(a.code.unwrap()[8 + 3] as i8, q, "thr {}", txt); } }

#[test] fn assembly_is_deterministic_and_formatting_does_not_change_the_bytes() {
    for (n, src) in strategies() { let a = assemble(&src); let b = assemble(&src); assert_eq!(a.code, b.code, "{}", n); assert_eq!(a.source_hash, b.source_hash); assert_eq!(a.canonical, b.canonical);
        // the canonical form assembles to the same program and is its own fixed point
        let c = assemble(&a.canonical); assert!(c.is_ok(), "{}: {:?}\n{}", n, c.errors, a.canonical); assert_eq!(c.code, a.code, "{}", n); assert_eq!(c.canonical, a.canonical, "{}", n); assert_eq!(c.source_hash, a.source_hash); }
    let a = assemble("conclave-strategy 1 ruleset 2\nx = sig T20\n pos   x # trailing\n"); let b = assemble("# lead\nconclave-strategy   1   ruleset   2\n\n\nx=sig T20\n\tpos x\n"); assert!(a.is_ok() && b.is_ok()); assert_eq!(a.code, b.code); assert_eq!(a.source_hash, b.source_hash, "whitespace and comments do not change the source identity");
    let renamed = assemble("conclave-strategy 1 ruleset 2\ntrend = sig T20\npos trend\n"); assert_eq!(renamed.code, a.code, "register names do not change the bytecode"); assert_ne!(renamed.source_hash, a.source_hash, "but they do change the source identity");
    let meta = assemble("conclave-strategy 1 ruleset 2\nname \"hello\"\nx = sig T20\npos x\n"); assert_eq!(meta.code, a.code); assert_ne!(meta.source_hash, a.source_hash); assert_eq!(meta.name.as_deref(), Some("hello")); }

#[test] fn the_ops_table_covers_every_vm_opcode_exactly_once() { let mut seen = vec![false; usize::from(conclave_vm::op::COUNT)]; for o in OPS.iter() { assert!(!seen[usize::from(o.code)], "{} duplicated", o.name); seen[usize::from(o.code)] = true; assert!(!o.doc.is_empty() && !o.usage.is_empty()); } assert!(seen.iter().all(|x| *x), "an opcode has no source mnemonic"); }

#[test] fn disassemble_then_assemble_is_the_identity_for_the_whole_pool_and_for_random_programs() {
    let pool = conclave_lab::pool::fixed_pool(); assert!(pool.len() >= 40); for s in &pool { let src = disassemble(&s.code).unwrap(); let a = assemble(&src); assert!(a.is_ok(), "{}: {:?}\n{}", s.name, a.errors, src); assert_eq!(a.code.as_ref(), Some(&s.code), "{} does not round trip", s.name); assert_eq!(a.work, work_of(&s.code), "{}", s.name); }
    let mut rng = Rng::new(0xA55E_4B1E); let mut n = 0;
    for _ in 0..20_000 { let code = rand_program(&mut rng, 64); if validate(&code).is_err() { continue; } n += 1; let src = disassemble(&code).unwrap(); let a = assemble(&src); assert!(a.is_ok(), "{:?}\n{}", a.errors, src); assert_eq!(a.code.as_ref(), Some(&code), "round trip failed for:\n{}", src); assert_eq!(a.work, work_of(&code)); assert_eq!(a.division, division_for(work_of(&code))); }
    assert!(n > 15_000, "only {} valid random programs", n); assert!(disassemble(&[9, 0, 0, 0]).is_err(), "an invalid program does not disassemble"); }

#[test] fn no_input_can_make_the_assembler_panic() {
    let mut rng = Rng::new(0xFA11_BAC4); let words = ["sig", "pos", "x", "y", "=", "T5", "const", "0.5", "-1", "ema", "zw", "32", "state", "free", "name", "\"q\"", "r3", "r16", "#", "thr", "hist", "sel", "nop", "conclave-strategy", "1", "ruleset", "2", "\n", " ", "\t", "\u{e9}", "9999999999999999999999"];
    for _ in 0..20_000 { let mut s = String::new(); if rng.chance(3, 4) { s.push_str(HEAD); } for _ in 0..rng.range(0, 40) { s.push_str(words[rng.below(words.len() as u64) as usize]); s.push(if rng.chance(1, 5) { '\n' } else { ' ' }); } let a = assemble(&s); if a.errors.is_empty() { let c = a.code.expect("no errors means bytecode"); assert!(validate(&c).is_ok()); assert!(a.work <= WORK_CAP); } } }
