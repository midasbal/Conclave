//! The CLIENT's instruction builders against the REAL program bytecode: tests/client_ix.mjs prints what client/flows.mjs builds, and every instruction here is sent exactly as printed (accounts, order, signer and
//! writable flags, data). Ignored by default because it needs node and client/node_modules: `(cd client && npm ci)` then `cargo test --release --test client_flows -- --ignored`.
mod common;
use common::*;
use serde_json::Value;
use solana_instruction::{AccountMeta, Instruction};

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
const PASSPHRASE: &str = "svm test bundle passphrase";
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn bundle_dir(e: &Env, s: &Season) -> std::path::PathBuf { std::env::temp_dir().join(format!("cv-svm-bundles-{}-{}-{}", std::process::id(), e.pid, s.sid)) }
fn built(e: &Env, s: &Season, sts: &[Strat]) -> Value {
    // the sealed and registry accounts exactly as the program made them: the client exports its recovery bundles from these
    let accounts: Vec<Value> = sts.iter().map(|x| serde_json::json!({ "sealed": hex(&e.data(&e.strat_pda(x.id))), "registry": hex(&e.data(&e.reg_pda(x.id))) })).collect();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../.."); let secret = format!("{:?}", e.payer.to_bytes().to_vec());
    let input = serde_json::json!({ "bundleDir": bundle_dir(e, s), "passphrase": PASSPHRASE, "accounts": accounts, "sid": s.sid.to_string(), "mint": e.mint.to_string(), "players": e.players.iter().map(|p| p.pubkey().to_string()).collect::<Vec<_>>(), "strategies": sts.iter().map(|x| serde_json::json!({ "owner": x.owner, "id": x.id.to_string() })).collect::<Vec<_>>() });
    let out = std::process::Command::new("node").current_dir(root).args(["tests/client_ix.mjs", &input.to_string()]).env("CONCLAVE_PROGRAM_ID", e.pid.to_string()).env("CONCLAVE_SIGNER", secret).env_remove("CONCLAVE_SIGNER_FILE").output().expect("node");
    assert!(out.status.success(), "client_ix.mjs failed: {}", String::from_utf8_lossy(&out.stderr)); serde_json::from_slice(&out.stdout).expect("json") }
fn ix(e: &Env, v: &Value) -> Instruction { let h = v["data"].as_str().unwrap(); let data = (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect();
    Instruction { program_id: e.pid, data, accounts: v["keys"].as_array().unwrap().iter().map(|k| { let key = a(k["pubkey"].as_str().unwrap()); if k["w"].as_bool().unwrap() { AccountMeta::new(key, k["s"].as_bool().unwrap()) } else { AccountMeta::new_readonly(key, k["s"].as_bool().unwrap()) } }).collect() } }
fn send(e: &mut Env, v: &Value, who: Option<usize>, what: &str) { e.fresh_blockhash(); let i = ix(e, v); let kps: Vec<_> = who.into_iter().map(|w| e.player(w)).collect(); let refs: Vec<_> = kps.iter().collect(); let r = e.send(&[i], &refs); assert!(r.is_ok(), "client {}: {}", what, err_string(&r)); }
fn setup(e: &mut Env, sid: u64, n: usize) -> (Season, Vec<Strat>) { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_if_new(s.claims, claims_size(20)); s.neps = 15; s.fee = 10; let sts: Vec<Strat> = (0..n).map(|i| e.register_and_seal(i, NAMES[i], code_of(NAMES[i]))).collect(); (s, sts) }

#[test] #[ignore = "needs node and client/node_modules"] fn the_clients_instructions_run_a_two_phase_season_to_the_last_claim() {
    let mut e = Env::new(5); let before: Vec<u64> = e.players.iter().map(|p| e.balance(&p.pubkey())).collect(); let (mut s, sts) = setup(&mut e, 7001, 5); let v = built(&e, &s, &sts);
    assert_eq!(a(v["claimsPda"].as_str().unwrap()), s.claims); assert_eq!(v["scoreCommit"].as_str().unwrap(), score_commit(&[7; 32], 7001, 5, -123, 456, 2, 15).iter().map(|b| format!("{:02x}", b)).collect::<String>(), "the client's score commitment is the program's");
    send(&mut e, &v["create"], None, "CreateSeason"); for (i, st) in sts.iter().enumerate() { send(&mut e, &v["enter"][i], Some(st.owner), "Enter"); s.entries.push(st.clone()); }
    send(&mut e, &v["lock"], None, "Lock"); send(&mut e, &v["seed"], None, "RequestSeed"); assert!(e.deliver_seed(&mut s, seed_of(3)).is_ok()); e.warp(301); send(&mut e, &v["advance"], None, "Advance (season)"); e.drive(&s, 1400, 1_400_000);
    send(&mut e, &v["seed"], None, "RequestSeed (finals, the same builder)"); assert!(e.deliver_finals_seed(&mut s, seed_of(4)).is_ok()); e.drive(&s, 1400, 1_400_000);
    send(&mut e, &v["settle"], None, "Settle with inline publish"); let ex = expect(&s, true); for i in 0..5 { assert_eq!(e.owed(&s, i), ex.owed[i]); }
    for i in 0..5 { send(&mut e, &v["claim"][i], None, "Claim"); } e.assert_books(&s, 0); send(&mut e, &v["claimReadOnly"], None, "a repeat claim with read-only token accounts");
    for i in 0..5 { assert_eq!(e.balance(&e.players[i].pubkey()) + 10 - before[i], ex.owed[i]); } send(&mut e, &v["closeClaims"], None, "CloseClaims"); send(&mut e, &v["cleanup"], None, "Cleanup"); }

#[test] #[ignore = "needs node and client/node_modules"] fn the_clients_cancel_refunds_through_claims() {
    let mut e = Env::new(5); let before: Vec<u64> = e.players.iter().map(|p| e.balance(&p.pubkey())).collect(); let (mut s, sts) = setup(&mut e, 7002, 3); let v = built(&e, &s, &sts);
    send(&mut e, &v["create"], None, "CreateSeason"); for (i, st) in sts.iter().enumerate() { send(&mut e, &v["enter"][i], Some(st.owner), "Enter"); s.entries.push(st.clone()); }
    send(&mut e, &v["cancel"], None, "Cancel by the creator while unlocked"); for i in 0..3 { send(&mut e, &v["claim"][i], None, "Claim (refund)"); } e.assert_books(&s, 0); for i in 0..5 { assert_eq!(e.balance(&e.players[i].pubkey()), before[i]); } send(&mut e, &v["closeClaims"], None, "CloseClaims"); }

#[test] #[ignore = "needs node and client/node_modules"] fn the_clients_release_and_close_instructions_retire_strategies_and_make_the_hub_whole() {
    let mut e = Env::new(5); e.model_rent(); let hub0 = e.lamports(&e.hub); let (mut s, sts) = setup(&mut e, 7003, 3); let v = built(&e, &s, &sts);
    // cancelled with the strategies named by Cancel: Cleanup then names none
    send(&mut e, &v["create"], None, "CreateSeason"); for (i, st) in sts.iter().enumerate() { send(&mut e, &v["enter"][i], Some(st.owner), "Enter"); s.entries.push(st.clone()); }
    send(&mut e, &v["cancelReleasing"], None, "Cancel naming its strategies"); for st in &sts { assert_eq!(e.open_count(st.id), 0); } for i in 0..3 { send(&mut e, &v["claim"][i], None, "Claim"); } send(&mut e, &v["closeClaims"], None, "CloseClaims"); send(&mut e, &v["cleanup"], None, "Cleanup naming none");
    // a second season, cancelled with none named: Cleanup names them
    let (mut s2, _) = (e.season(7004), ()); assert!(e.init_pool(&s2).is_ok()); assert!(e.init_receipt(&s2).is_ok()); e.provision_if_new(s2.arena, arena_size(20)); e.provision_if_new(s2.claims, claims_size(20)); s2.neps = 15; s2.fee = 10; let w = built(&e, &s2, &sts);
    send(&mut e, &w["create"], None, "CreateSeason"); for (i, st) in sts.iter().enumerate() { send(&mut e, &w["enter"][i], Some(st.owner), "Enter"); s2.entries.push(st.clone()); }
    send(&mut e, &w["cancel"], None, "Cancel naming none"); for i in 0..3 { send(&mut e, &w["claim"][i], None, "Claim"); } send(&mut e, &w["closeClaims"], None, "CloseClaims"); send(&mut e, &w["cleanupNaming"], None, "Cleanup naming the held strategies");
    for (i, st) in sts.iter().enumerate() { send(&mut e, &v["closeStrategy"][i], Some(st.owner), "CloseStrategy"); } send(&mut e, &v["undelegateRegs"], None, "Commit and undelegate the closed registries"); for i in 0..3 { send(&mut e, &v["closeRegistry"][i], None, "CloseRegistry"); }
    assert_eq!(e.lamports(&e.hub), hub0 + 2 * (BOND / 4), "whole, plus the 25% bond each of the two creator cancels forfeits"); assert_eq!(e.vault_total(), 0); }

#[test] #[ignore = "needs node, client/node_modules and the WASM author module"] fn a_bundle_from_the_real_sealed_account_replays_the_season_after_the_strategy_is_closed() {
    let mut e = Env::new(5); e.model_rent(); let (mut s, sts) = setup(&mut e, 7005, 5); let v = built(&e, &s, &sts);
    send(&mut e, &v["create"], None, "CreateSeason"); for (i, st) in sts.iter().enumerate() { send(&mut e, &v["enter"][i], Some(st.owner), "Enter"); s.entries.push(st.clone()); }
    send(&mut e, &v["lock"], None, "Lock"); send(&mut e, &v["seed"], None, "RequestSeed"); assert!(e.deliver_seed(&mut s, seed_of(31)).is_ok()); e.warp(301); e.drive(&s, 1400, 1_400_000);
    send(&mut e, &v["seed"], None, "RequestSeed (finals)"); assert!(e.deliver_finals_seed(&mut s, seed_of(32)).is_ok()); e.drive(&s, 1400, 1_400_000); send(&mut e, &v["settle"], None, "Settle with inline publish");
    let ex = expect(&s, true);
    // the owners close every strategy with the client's guarded builder: the sealed salt and code are wiped and the accounts are gone
    for (i, st) in sts.iter().enumerate() { send(&mut e, &v["closeStrategy"][i], Some(st.owner), "CloseStrategy"); assert!(e.data(&e.strat_pda(st.id)).is_empty(), "the sealed account is gone"); }
    let receipt = hex(&e.data(&s.receipt)); let mut finalists = 0;
    for (i, st) in sts.iter().enumerate() {
        let file = v["bundles"][i].as_str().unwrap(); let input = serde_json::json!({ "bundle": file, "passphrase": PASSPHRASE, "receipt": receipt });
        let out = std::process::Command::new("node").current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).args(["tests/custody_replay.mjs", &input.to_string()]).env("CONCLAVE_PROGRAM_ID", e.pid.to_string()).env("CONCLAVE_SIGNER", format!("{:?}", e.payer.to_bytes().to_vec())).env_remove("CONCLAVE_SIGNER_FILE").output().expect("node");
        assert!(out.status.success(), "replay failed: {}", String::from_utf8_lossy(&out.stderr)); let r: Value = serde_json::from_slice(&out.stdout).expect("json");
        assert_eq!(r["id"].as_str().unwrap(), st.id.to_string()); assert_eq!(r["codeCommitmentMatches"], true, "entry {}", i); assert_eq!(r["scoreCommitmentMatches"], true, "entry {}: the bundle alone reproduces the score commitment", i);
        assert_eq!(r["total"].as_str().unwrap(), ex.season[i].to_string(), "the replayed season total is the oracle's"); assert_eq!(r["finalsTotal"].as_str().unwrap(), ex.finals[i].to_string()); if r["finalist"] == true { finalists += 1; } }
    assert_eq!(finalists, 3, "the replay covered finalists and non-finalists"); let _ = std::fs::remove_dir_all(bundle_dir(&e, &s)); }
