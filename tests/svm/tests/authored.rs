//! Authored strategies (assembled by the 2a author tool from strategies/*.cvs) through the real compiled program: salted register, seal, what the public registry holds, and the division gate at Enter.
mod common;
use common::*;
use conclave_author::source::assemble;
use conclave_vm::DIVISIONS;
use sha2::{Digest, Sha256};

fn authored() -> Vec<(String, Vec<u8>, u32)> { let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../strategies"); let mut v: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x == "cvs").unwrap_or(false)).collect(); v.sort();
    v.into_iter().map(|p| { let a = assemble(&std::fs::read_to_string(&p).unwrap()); (p.file_stem().unwrap().to_string_lossy().to_string(), a.code.expect("example assembles"), a.work) }).collect() }
fn sha(parts: &[&[u8]]) -> Vec<u8> { let mut h = Sha256::new(); for p in parts { h.update(p); } h.finalize().to_vec() }
fn has(hay: &[u8], needle: &[u8]) -> bool { !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle) }

#[test] fn authored_strategies_seal_through_the_real_program_and_the_registry_holds_only_the_commitment() {
    let mut e = Env::new(5);
    for (i, (name, code, _work)) in authored().into_iter().enumerate() {
        let st = e.register_and_seal(i % 5, &name, code.clone()); // the program recomputes sha256("CNCL-CODE-v1", salt, code) against the registry and validates the code, or Seal fails
        let reg = e.data(&e.reg_pda(st.id)); assert_eq!(reg.len(), REG_SIZE); let commitment = &reg[48..80];
        assert_eq!(commitment, code_commit(&st.salt, &code), "{}: the registry commitment is the salted commitment", name);
        assert_eq!(&reg[8..40], e.players[i % 5].pubkey().as_ref()); assert_eq!(rd64(&reg, 40), st.id);
        // nothing in the public registry lets anyone recognise the strategy
        assert!(!has(&reg, &code), "{}: no code in the registry", name); assert!(!has(&reg, &st.salt), "{}: no salt in the registry", name);
        for (what, h) in [("bare sha256(code)", sha(&[&code])), ("sha256(domain, code)", sha(&[b"CNCL-CODE-v1", &code])), ("sha256(domain, zero salt, code)", sha(&[b"CNCL-CODE-v1", &[0u8; 32], &code]))] { assert!(!has(&reg, &h), "{}: registry must not hold {}", name, what); assert_ne!(commitment, h.as_slice()); }
        // the sealed account (rollup only, owner-only) holds exactly the authored bytes and the salt that opens the commitment
        let sd = e.data(&e.strat_pda(st.id)); assert_eq!(rd32(&sd, 0), 0x5354_5254, "the sealed-strategy magic the client parser (client/artifact.mjs STRAT_MAGIC) relies on"); let len = u16::from_le_bytes([sd[4], sd[5]]) as usize; assert_eq!(&sd[136..136 + len], code.as_slice(), "{}: sealed bytes are the authored bytes", name); assert_eq!(&sd[104..136], &st.salt); assert_eq!(&sd[48..80], commitment);
    } }

#[test] fn a_wrong_salt_or_edited_code_cannot_be_sealed_under_the_registered_commitment() {
    let mut e = Env::new(5); let (name, code, _) = authored().remove(0); let st = e.register(0, &name, code.clone());
    let mut bad_salt = st.clone(); bad_salt.salt[0] ^= 1; let r = e.seal(&bad_salt); assert!(r.is_err(), "a salt that does not open the commitment is refused");
    let mut edited = st.clone(); edited.code = { let mut c = code.clone(); let n = c.len(); c[n - 3] ^= 1; c }; assert!(e.seal(&edited).is_err(), "code that is not what was committed is refused (or invalid)");
    let r = e.seal(&st); assert!(r.is_ok(), "the exact authored code and salt seal: {}", err_string(&r)); }

#[test] fn the_division_on_the_artifact_is_exactly_what_enter_enforces() {
    // for every authored strategy, in every division: Enter accepts iff work <= the division's cap (else Custom 9005); the smallest accepting division is the one the assembler reports
    for (name, code, work) in authored() {
        let mut e = Env::new(5); let st = e.register_and_seal(0, &name, code.clone()); let mut smallest = None;
        for (d, cap) in DIVISIONS.iter().enumerate() { let mut s = e.season(300 + d as u64); assert!(e.init_pool(&s).is_ok()); let r = e.create_season(&mut s, 2, 0, 20, false, d as u8); assert!(r.is_ok(), "{}", err_string(&r));
            let r = e.enter(&mut s, &st); if work <= *cap { assert!(r.is_ok(), "{} (work {}) must enter division {} (cap {}): {}", name, work, d, cap, err_string(&r)); if smallest.is_none() { smallest = Some(d); } } else { assert_eq!(custom(&r), Some(9005), "{} (work {}) must be refused by division {} (cap {})", name, work, d, cap); } }
        let a = assemble(&std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../strategies/{}.cvs", name))).unwrap()); assert_eq!(a.division, smallest.map(|d| DIVISIONS[d]), "{}: the artifact's division is the smallest one Enter accepts", name); } }

#[test] fn the_cap_is_enforced_at_seal_whatever_the_source_tool_says() {
    // the assembler refuses over-cap source, and the program independently refuses over-cap bytecode (9001), so neither layer is trusted alone
    let (_, code, work) = authored().into_iter().find(|(n, _, _)| n == "at_the_cap").unwrap(); assert_eq!(work, 64); let mut e = Env::new(5); let s = e.register_and_seal(0, "cap", code.clone()); assert!(e.data(&e.strat_pda(s.id)).len() > 136);
    let mut ops = vec![[conclave_vm::op::ZW, 0, 32, 0], [conclave_vm::op::WSUM, 1, 12, 0]]; for _ in 0..13 { ops.push([conclave_vm::op::SIG, 2, 0, 0]); } let mut over = vec![conclave_vm::VERSION, ops.len() as u8, 0, 0]; for o in &ops { over.extend_from_slice(o); }
    let st = e.register(1, "over", over); let r = e.seal(&st); assert_eq!(custom(&r), Some(9001), "{}", err_string(&r)); }
