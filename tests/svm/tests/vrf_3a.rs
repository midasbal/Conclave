//! Phase 3a, finding #4: the conclave bytes calling the REAL VRF program bytes (dumped from devnet) with REAL devnet queue accounts (as the rollup serves them).
//! Ignored by default. Run with CONCLAVE_SO, VRF_SO, VRF_QUEUES (a directory of <pubkey>.bin queue snapshots) and `cargo test --release --test vrf_3a -- --ignored --nocapture`.
//! Not covered here: whether an oracle SERVES a queue, and the rollup's rule on which accounts a transaction may modify.
mod common;
use common::*;
use solana_account::Account;
use solana_instruction::AccountMeta;

fn queues() -> Vec<(Address, Vec<u8>)> { let dir = std::env::var("VRF_QUEUES").expect("VRF_QUEUES"); let mut v: Vec<(Address, Vec<u8>)> = std::fs::read_dir(dir).unwrap().map(|f| { let p = f.unwrap().path(); (a(p.file_stem().unwrap().to_str().unwrap()), std::fs::read(&p).unwrap()) }).collect(); v.sort_by_key(|x| x.0.to_string()); v }
fn put(e: &mut Env, k: Address, data: Vec<u8>, owner: Address) { e.svm.set_account(k, Account { lamports: 1_000_000_000, data, owner, executable: false, rent_epoch: 0 }).unwrap(); }
fn locked(e: &mut Env, sid: u64) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); e.params.seedto = 1_000; assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); for i in 0..2 { let st = e.register_and_seal(i, "x", code_of("Mom20th")); assert!(e.enter(&mut s, &st).is_ok()); } assert!(e.lock(&s).is_ok()); s }
/// the deployed RequestSeed with a queue of the CALLER'S choosing, signed by a stranger
fn request_with(e: &mut Env, s: &Season, queue: Address) -> Res { let kp = e.player(4); let identity = pda(&[b"identity"], &e.pid); let ix = e.ix(8, vec![AccountMeta::new(kp.pubkey(), true), e.rw(s.arena), e.ro(identity), e.rw(queue), e.ro(a(SYSTEM)), e.ro(a(SLOT_HASHES)), e.ro(a(VRF))], vec![]); e.fresh_blockhash(); e.send(&[ix], &[&kp]) }
fn setup() -> Env { let mut e = Env::new(5); e.svm.add_program(a(VRF), &std::fs::read(std::env::var("VRF_SO").expect("VRF_SO")).unwrap()).unwrap(); e }
fn tail(r: &Res) -> String { match r { Ok(m) => m.logs.iter().filter(|l| l.contains("Program log")).cloned().collect::<Vec<_>>().join(" | "), Err(f) => f.meta.logs.iter().rev().take(4).cloned().collect::<Vec<_>>().join(" | ") } }

#[test] #[ignore = "needs VRF_SO and VRF_QUEUES: the real VRF program and queue snapshots from devnet"] fn only_the_pinned_queue_reaches_the_real_vrf_program() {
    // REVERSED: the previous build let the real VRF program accept every one of these. Now every real queue but the pinned one is refused by conclave itself (9110) before the VRF program is called.
    let qs = queues(); let mut accepted = vec![];
    for (n, (k, data)) in qs.iter().enumerate() { let mut e = setup(); put(&mut e, *k, data.clone(), a(VRF)); let s = locked(&mut e, 100 + n as u64); let r = request_with(&mut e, &s, *k);
        println!("queue {} ({} bytes): {}", &k.to_string()[..8], data.len(), if r.is_ok() { "ACCEPTED".to_string() } else { err_string(&r) });
        if r.is_ok() { accepted.push(*k); assert!(e.data(k) != *data, "the real VRF program recorded the request in the queue"); } else { assert_eq!(custom(&r), Some(9110)); assert_eq!(e.flags(&s) & F_REQ, 0, "the honest request is still possible"); assert!(e.data(k) == *data); } }
    println!("accepted {} of {} real queue accounts", accepted.len(), qs.len()); assert_eq!(accepted, vec![a(VRF_QUEUE)]); }
#[test] #[ignore = "needs VRF_SO and VRF_QUEUES: the real VRF program and queue snapshots from devnet"] fn control_forged_queues_never_pass_and_the_flag_is_untouched() {
    let qs = queues(); let good = qs.iter().find(|q| q.0.to_string().starts_with("5hBR")).expect("our queue").clone();
    for (label, data, owner) in [("garbage owned by VRF", vec![0xabu8; 9500], a(VRF)), ("zeroed account owned by VRF", vec![0u8; 9500], a(VRF)), ("copy of the real queue at another address", good.1.clone(), a(VRF)), ("copy of the real queue with a foreign owner", good.1.clone(), a(SYSTEM))] {
        let mut e = setup(); let s = locked(&mut e, 200); let k = Address::new_unique(); put(&mut e, k, data, owner); let r = request_with(&mut e, &s, k); println!("{}: {}", label, if r.is_ok() { "ACCEPTED".into() } else { format!("rejected {}", err_string(&r)) });
        assert_eq!(custom(&r), Some(9110)); assert_eq!(e.flags(&s) & F_REQ, 0, "a refused request leaves the season requestable"); }
}
