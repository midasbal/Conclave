//! Host leg of the conformance gate. Run: `cargo test --release -p conclave-conformance-tools`
use conclave_conformance::run_vector;
use conclave_conformance_tools::corpus::*;

fn golden() -> Vec<Entry> { let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/conformance/corpus.bin"); parse(&std::fs::read(p).expect("golden corpus missing: run cc-gen")).expect("corpus parses") }

#[test] fn host_matches_golden() { let es = golden(); assert!(es.len() > 3000); for (i, e) in es.iter().enumerate() { assert_eq!(run_vector(&e.input), e.output, "vector {} ({})", i, e.label); } }
#[test] fn golden_is_current() { let fresh = serialise(&build()); let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tests/conformance/corpus.bin"); assert!(fresh == std::fs::read(p).unwrap(), "corpus.bin is stale: any VM or generator change must regenerate it with cc-gen and be reviewed as a ruleset change"); }
/// a state save/load round trip in the middle of a run must not change a single bit of the trace
#[test] fn split_runs_equal_unsplit() { let es = golden(); let mut n = 0; for w in es.windows(2) { if w[1].label.ends_with(" split") { assert_eq!(w[0].output, w[1].output, "{}", w[1].label); n += 1; } } assert!(n > 100, "only {} split twins", n); }
/// independent oracle for the work-cap boundary: the label states the work, the cap is 64
#[test] fn cap_boundary_is_exact() { let mut n = 0; for e in golden() { if let Some(rest) = e.label.strip_prefix("validate/cap ") { let w: u32 = rest.split("work ").nth(1).unwrap().trim_end_matches(')').parse().unwrap(); assert_eq!(e.output[0], if w <= 64 { 0 } else { 8 }, "{}", e.label); assert_eq!(u32::from_le_bytes(e.output[1..5].try_into().unwrap()), w, "{}", e.label); n += 1; } } assert!(n > 90); }
#[test] fn work_total_matches_static_work() { // every single-seat TRACE: metered work == static work_of * ticks
    for e in golden() { if e.input[0] == 2 && e.input[23] == 1 && e.output.len() >= 16 { let nt = u64::from(e.input[22]); let nsp = usize::from(e.input[24]); let l = usize::from(u16::from_le_bytes([e.input[25 + nsp], e.input[26 + nsp]])); let code = &e.input[27 + nsp..27 + nsp + l];
        assert_eq!(u64::from_le_bytes(e.output[8..16].try_into().unwrap()), u64::from(conclave_vm::work_of(code)) * nt, "{}", e.label); } } }
