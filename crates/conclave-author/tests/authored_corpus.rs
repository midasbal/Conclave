//! Host leg for the authored-path conformance corpus (the WASM and SBF legs are tests/conformance.sh).
#![cfg(feature = "corpus")]
use conclave_conformance::run_vector; use conclave_conformance_tools::corpus::{parse, serialise};
fn dir() -> std::path::PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../strategies") }
fn file() -> std::path::PathBuf { std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/conformance/authored.bin") }
#[test] fn authored_corpus_is_current() { let fresh = serialise(&conclave_author::corpus::build(&dir())); assert!(fresh == std::fs::read(file()).expect("run ca-corpus"), "tests/conformance/authored.bin is stale: the assembler or a strategy changed. Review, then regenerate with `cargo run --release -p conclave-author --features corpus --bin ca-corpus`"); }
#[test] fn every_authored_vector_reproduces_on_the_host() { let es = parse(&std::fs::read(file()).unwrap()).expect("parse"); assert!(es.len() >= 30); assert!(es.iter().filter(|e| e.sbf).count() >= 12, "enough authored vectors run on SBF"); for e in &es { assert_eq!(run_vector(&e.input), e.output, "{}", e.label); } }
#[test] fn the_corpus_covers_every_example_strategy() { let es = parse(&std::fs::read(file()).unwrap()).unwrap(); for p in conclave_author::corpus::strategy_files(&dir()) { let n = p.file_stem().unwrap().to_string_lossy().to_string(); for what in ["validate", "short trace", "season"] { assert!(es.iter().any(|e| e.label == format!("authored {} {}", n, what)), "{} {}", n, what); } } }
