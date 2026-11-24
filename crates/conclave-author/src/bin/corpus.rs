//! ca-corpus: regenerate the authored-path corpus. `ca-corpus [strategies-dir] [out.bin]`. Regenerating is a reviewed change, like cc-gen: it means the assembler or a strategy changed.
use conclave_conformance_tools::corpus::serialise;
fn main() { let a: Vec<String> = std::env::args().skip(1).collect(); let dir = a.first().cloned().unwrap_or_else(|| "strategies".into()); let out = a.get(1).cloned().unwrap_or_else(|| "tests/conformance/authored.bin".into());
    let es = conclave_author::corpus::build(std::path::Path::new(&dir)); let b = serialise(&es); std::fs::write(&out, &b).unwrap(); println!("{} authored vectors ({} also run on SBF), {} bytes -> {}", es.len(), es.iter().filter(|e| e.sbf).count(), b.len(), out); }
