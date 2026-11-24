//! The authored-path conformance corpus: every strategy in strategies/*.cvs, assembled by THIS assembler, run through the same `run_vector` entry point the host, WASM and SBF legs use.
//! A divergence in what the assembler emits, or in how any target executes it, shows up as a changed or failing vector. Feature `corpus` only (never part of the WASM build).
use conclave_conformance::run_vector; use conclave_conformance_tools::{corpus::{est_cu, Entry}, v_season, v_trace, v_validate};
pub const SBF_BUDGET: u64 = 1_250_000; pub const SBF_MAX_IN: usize = 1_000; // mirrors conclave-conformance-tools/src/corpus.rs
pub fn strategy_files(dir: &std::path::Path) -> Vec<std::path::PathBuf> { let mut v: Vec<_> = std::fs::read_dir(dir).map(|r| r.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x == "cvs").unwrap_or(false)).collect()).unwrap_or_default(); v.sort(); v }
pub fn build(dir: &std::path::Path) -> Vec<Entry> {
    let mut es: Vec<Entry> = vec![]; let mut all: Vec<(String, Vec<u8>)> = vec![];
    for (i, p) in strategy_files(dir).iter().enumerate() { let src = std::fs::read_to_string(p).expect("read strategy"); let a = crate::source::assemble(&src); let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("?").to_string();
        let code = a.code.unwrap_or_else(|| panic!("{} does not assemble: {:?}", name, a.errors)); let push = |es: &mut Vec<Entry>, label: String, input: Vec<u8>| { let output = run_vector(&input); let sbf = input.len() <= SBF_MAX_IN && est_cu(&input) <= SBF_BUDGET; es.push(Entry { sbf, label, input, output }); };
        push(&mut es, format!("authored {} validate", name), v_validate(&code));
        for (k, pack) in [(i % 6) as u8, ((i + 3) % 6) as u8].into_iter().enumerate() { push(&mut es, format!("authored {} trace pack{}", name, pack), v_trace(pack, 1000 + i as u64, 77 + k as u64, k as u32, 150, &[50, 100], &[code.as_slice()])); }
        // short enough for one SBF transaction: the SBF leg executes the authored strategy for 24 ticks with a state save/load round trip in the middle
        push(&mut es, format!("authored {} short trace", name), v_trace(((i + 1) % 6) as u8, 1500 + i as u64, 13, 0, 24, &[8, 16], &[code.as_slice()]));
        push(&mut es, format!("authored {} season", name), v_season(2000 + i as u64, 91, 3, 150, &[code.as_slice()])); all.push((name, code)); }
    let progs: Vec<&[u8]> = all.iter().map(|(_, c)| c.as_slice()).collect();
    { let input = v_trace(2, 3100, 9, 0, 12, &[6], &progs); let output = run_vector(&input); let sbf = input.len() <= SBF_MAX_IN && est_cu(&input) <= SBF_BUDGET; es.push(Entry { sbf, label: format!("authored arena of {} short trace", progs.len()), input, output }); }
    for (k, (sa, neps)) in [(3000u64, 2u8), (3001, 3)].into_iter().enumerate() { let input = v_season(sa, 5 + k as u64, neps, 150, &progs); let output = run_vector(&input); let sbf = input.len() <= SBF_MAX_IN && est_cu(&input) <= SBF_BUDGET; es.push(Entry { sbf, label: format!("authored arena of {} season {}", progs.len(), k), input, output }); }
    es
}
