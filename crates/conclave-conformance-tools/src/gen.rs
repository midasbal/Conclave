//! cc-gen: regenerate the golden corpus. `cc-gen <out.bin>`
use conclave_conformance_tools::corpus::*;
fn main() { let out = std::env::args().nth(1).unwrap_or_else(|| "tests/conformance/corpus.bin".into()); let es = build(); let b = serialise(&es);
    let mut kinds = [0usize; 8]; let mut sbf = 0; for e in &es { kinds[usize::from(e.input[0]).min(7)] += 1; if e.sbf { sbf += 1; } }
    std::fs::create_dir_all(std::path::Path::new(&out).parent().unwrap()).unwrap(); std::fs::write(&out, &b).unwrap();
    println!("{} vectors ({} also run on SBF), {} bytes -> {}", es.len(), sbf, b.len(), out); println!("by kind: validate {} world {} trace {} season {} pins {} opwork {} state {} synth {}", kinds[0], kinds[1], kinds[2], kinds[3], kinds[4], kinds[5], kinds[6], kinds[7]); }
