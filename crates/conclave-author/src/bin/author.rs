//! conclave-author: write, check and simulate strategies locally. Same library the WASM build exports (client/author.mjs); no chain, no network.
//!   conclave-author asm   FILE [--json]            assemble: per-instruction work, total, division, bytecode
//!   conclave-author fmt   FILE                     print the canonical (normalised) source
//!   conclave-author disasm HEX|FILE                bytecode back to source
//!   conclave-author sim   FILE [--worlds N] [--episodes N] [--base HEX] [--no-field] [--single-seed N] [--json]
//!   conclave-author ops                            the instruction reference with work weights
use conclave_author::{sim, source};
fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect(); let cmd = a.first().map(|s| s.as_str()).unwrap_or("help");
    let flag = |n: &str| a.iter().any(|x| x == n); let val = |n: &str| a.iter().position(|x| x == n).and_then(|i| a.get(i + 1)).cloned();
    let read = |p: &str| std::fs::read_to_string(p).unwrap_or_else(|e| { eprintln!("cannot read {}: {}", p, e); std::process::exit(2) });
    match cmd {
        "ops" => { println!("work per instruction: plain 1, hist 5, wsum 5+ceil(n/3), volw 6+ceil(2n/5), zw 11+n ; cap {} ; divisions {:?}\n", conclave_vm::WORK_CAP, conclave_vm::DIVISIONS); for o in source::OPS.iter() { println!("  {:<28} {}", o.usage, o.doc); } }
        "asm" | "fmt" | "sim" => {
            let path = a.get(1).cloned().unwrap_or_else(|| { eprintln!("usage: conclave-author {} FILE", cmd); std::process::exit(2) }); let src = read(&path); let asm = source::assemble(&src);
            if cmd == "fmt" { if !asm.errors.is_empty() { print!("{}", source::listing(&asm, &src)); std::process::exit(1); } print!("{}", asm.canonical); return; }
            if cmd == "asm" { if flag("--json") { println!("{}", source::assembly_json(&asm)); } else { println!("{}: {}", path, asm.name.clone().unwrap_or_default()); print!("{}", source::listing(&asm, &src)); } std::process::exit(if asm.is_ok() { 0 } else { 1 }); }
            if !asm.is_ok() { print!("{}", source::listing(&asm, &src)); std::process::exit(1); }
            let mut cfg = sim::Config::default(); if let Some(v) = val("--worlds") { cfg.worlds = v.parse().unwrap_or(cfg.worlds).clamp(1, 2000); } if let Some(v) = val("--episodes") { cfg.episodes = v.parse().unwrap_or(cfg.episodes).clamp(1, 200); }
            if let Some(v) = val("--base") { cfg.base = u64::from_str_radix(v.trim_start_matches("0x"), 16).unwrap_or(cfg.base); } if flag("--no-field") { cfg.field = false; } if let Some(v) = val("--single-seed") { cfg.single = v.parse().ok(); }
            let r = sim::simulate(asm.code.as_deref().unwrap_or(&[]), &cfg); if flag("--json") { println!("{}", r.to_json()); } else { print!("{}", source::listing(&asm, &src)); println!(); print!("{}", r.to_text()); }
        }
        "disasm" => { let h = a.get(1).cloned().unwrap_or_default(); let h = if std::path::Path::new(&h).exists() { std::fs::read_to_string(&h).unwrap_or_default() } else { h }; let h: String = h.chars().filter(|c| c.is_ascii_hexdigit()).collect();
            let bytes: Vec<u8> = (0..h.len() / 2).filter_map(|i| u8::from_str_radix(&h[2 * i..2 * i + 2], 16).ok()).collect(); match source::disassemble(&bytes) { Ok(s) => print!("{}", s), Err(e) => { eprintln!("not a valid program: {:?}", e); std::process::exit(1); } } }
        _ => println!("conclave-author asm|fmt|sim FILE | disasm HEX | ops   (see crates/conclave-author/src/bin/author.rs)"),
    }
}
