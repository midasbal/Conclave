//! The record builder and verifier against receipts written by the REAL program bytecode, with throwaway keys, so that every proof level can be exercised with its secrets (none of which exist for a
//! committed devnet fixture). This file only produces the receipts and the oracle's expected scores; verifier/test/svm_child.mjs runs the verifier over them. The delegation record around a "still delegated"
//! receipt is synthetic (the SVM does not model delegation); the receipt bytes at every stage are the program's.
//! Needs node, verifier/node_modules and the WASM author module: `(cd verifier && npm ci)`, `tests/author.sh`, then `cargo test --release --test verifier_4b -- --ignored`.
mod common;
use common::*;
use serde_json::json;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn season_json(e: &Env, s: &Season, ex: &Expect) -> serde_json::Value {
    json!({ "sid": s.sid.to_string(), "address": s.receipt.to_string(), "strategies": s.entries.iter().map(|x| json!({ "id": x.id.to_string(), "owner": e.players[x.owner].pubkey().to_string(), "ownerIndex": x.owner, "salt": hex(&x.salt), "code": hex(&x.code) })).collect::<Vec<_>>(),
        "oracle": { "season": ex.season.iter().map(|v| v.to_string()).collect::<Vec<_>>(), "finals": ex.finals.iter().map(|v| v.to_string()).collect::<Vec<_>>(), "finalist": ex.finalist, "rank": ex.frank, "seasonRank": ex.srank } })
}

#[test] #[ignore = "needs node, verifier/node_modules and the WASM author module"] fn the_verifier_reads_and_proves_receipts_written_by_the_real_program() {
    let mut e = Env::new(5); let mut stages = serde_json::Map::new(); let mut keep = |e: &Env, name: &str, s: &Season| { stages.insert(name.to_string(), json!(hex(&e.data(&s.receipt)))); };
    // A: a paid season with finals, taken from settled-with-two-unpublished to bond-released
    let a_s = e.full_season(501, &NAMES, 15, 10, true, 2, 3, true); let ex_a = expect(&a_s, true); assert!(e.settle_publishing(&a_s, 3).is_ok()); keep(&e, "a_settled3", &a_s);
    for i in 3..5 { assert!(e.publish(&a_s, i).is_ok()); } keep(&e, "a_published", &a_s);
    e.claim_all(&a_s); assert!(e.cleanup(&a_s).is_ok()); assert!(e.commit_undelegate(&[a_s.receipt]).is_ok()); keep(&e, "a_closed", &a_s);
    // on base the receipt keeps its rent when the bond leaves; the stand-in InitReceipt holds only the bond, so give it rent or the SVM would delete the emptied account
    let mut acc = e.svm.get_account(&a_s.receipt).unwrap(); acc.lamports += 20_000_000; e.svm.set_account(a_s.receipt, acc).unwrap();
    let r = e.release_bond(&a_s); assert!(r.is_ok(), "{}", err_string(&r)); keep(&e, "a_released", &a_s);
    assert_eq!(e.data(&a_s.receipt).len(), 2464, "the receipt is still there");
    // C: the SAME five strategies again, finals voided because their seed never comes
    let mut c = e.season(503); assert!(e.init_pool(&c).is_ok()); assert!(e.init_receipt(&c).is_ok()); assert!(e.create_season(&mut c, 15, 10, 20, true, 2).is_ok()); for st in &a_s.entries { let r = e.enter(&mut c, st); assert!(r.is_ok(), "{}", err_string(&r)); }
    assert!(e.lock(&c).is_ok()); assert!(e.request_seed(&c).is_ok()); assert!(e.deliver_seed(&mut c, seed_of(9)).is_ok()); e.warp(301); e.drive(&c, 1400, 1_400_000); e.warp(360_001);
    let r = e.settle(&c); assert!(r.is_ok(), "void settle: {}", err_string(&r)); let ex_c = expect(&c, false); e.claim_all(&c); for i in 0..5 { assert!(e.publish(&c, i).is_ok()); } assert!(e.cleanup(&c).is_ok()); keep(&e, "c_closed", &c);
    // B: cancelled by its creator before Lock
    let mut b = e.season(502); assert!(e.init_pool(&b).is_ok()); assert!(e.init_receipt(&b).is_ok()); assert!(e.create_season(&mut b, 2, 10, 20, false, 2).is_ok()); for st in a_s.entries.iter().take(2) { assert!(e.enter(&mut b, st).is_ok()); }
    assert!(e.cancel(&b).is_ok()); e.claim_all(&b); assert!(e.cleanup(&b).is_ok()); keep(&e, "b_closed", &b);

    let secrets: Vec<Vec<u8>> = e.players.iter().map(|p| p.to_bytes().to_vec()).collect();
    let input = json!({ "program": e.pid.to_string(), "creator": e.payer.pubkey().to_string(), "playerKeys": secrets, "stages": stages,
        "seasons": { "a": season_json(&e, &a_s, &ex_a), "c": season_json(&e, &c, &ex_c), "b": { "sid": "502", "address": b.receipt.to_string() } } });
    // on stdin, not in the arguments: it carries (throwaway) keys and salts
    let mut child = std::process::Command::new("node").current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../..")).arg("verifier/test/svm_child.mjs").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().expect("node");
    use std::io::Write; child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap(); let out = child.wait_with_output().unwrap();
    let text = String::from_utf8_lossy(&out.stdout); println!("{}", text);
    assert!(out.status.success(), "verifier checks failed:\n{}\n{}", text, String::from_utf8_lossy(&out.stderr));
    let done: usize = text.lines().filter(|l| l.starts_with("ok ")).count(); assert!(done >= 48, "only {} checks ran", done);
}
