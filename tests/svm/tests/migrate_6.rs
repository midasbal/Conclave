//! The upgrade from the build that is deployed now (sha256 7bd612e7..., the artifact program/BUILD_HASH recorded before this change) to this one, run on the REAL deployed bytecode:
//! strategies, seasons and claims made by the previous program, then the program is swapped in place, as an upgrade does, and everything that matters is done to them with the new one.
//! Needs the previous binary: CONCLAVE_PREV_SO=/path/to/it (the first 512,600 bytes of `solana program dump <program id>`; scripts/verify-deployed.sh shows it is what is on devnet).
//! The previous build's account lists are written out below: Seal with the hub second and the registry read-only; Enter with no terms account and no data; CreateSeason and CloseClaims without the terms account.
mod common;
use common::*;
use solana_instruction::Instruction;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn errs(r: &Res, what: &str) { assert!(r.is_err() && !failed_to_complete(r), "{} should be refused with an error, got {}", what, err_string(r)); }
fn hex(b: [u8; 32]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn old_seal_ix(e: &Env, s: &Strat) -> Instruction { let mut d = s.id.to_le_bytes().to_vec(); d.extend_from_slice(&s.salt); d.extend_from_slice(&s.code); let ow = e.players[s.owner].pubkey();
    e.ix(3, vec![e.m(ow, true, false), e.rw(e.hub), e.rw(e.strat_pda(s.id)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(MAGIC)), e.ro(a(PERMISSION)), e.ro(e.reg_pda(s.id))], d) }
fn old_seal(e: &mut Env, s: &Strat) { e.provision_if_new(e.strat_pda(s.id), STRAT_SIZE); let ix = old_seal_ix(e, s); let kp = e.player(s.owner); e.fresh_blockhash(); let r = e.send(&[ix], &[&kp]); assert!(r.is_ok(), "old Seal: {}", err_string(&r)); }
fn old_enter(e: &mut Env, s: &mut Season, t: &Strat) { let mut ix = e.enter_ix(s, t, t.owner); ix.accounts.truncate(9); ix.data.truncate(1); let kp = e.player(t.owner); e.fresh_blockhash(); let r = e.send(&[ix], &[&kp]); assert!(r.is_ok(), "old Enter: {}", err_string(&r)); s.entries.push(t.clone()); }
fn old_season(e: &mut Env, sid: u64, fee: u64) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_if_new(s.claims, claims_size(20)); e.provision_if_new(s.roster, roster_size(20)); assert!(e.init_receipt(&s).is_ok());
    let mut ix = e.create_season_ix(&s, 2, 1, fee, 20, 0, 2); ix.accounts.pop(); e.fresh_blockhash(); let r = e.send(&[ix], &[]); assert!(r.is_ok(), "old CreateSeason: {}", err_string(&r)); s.maxs = 20; s.neps = 2; s.fee = fee; s }
fn play(e: &mut Env, s: &mut Season, byte: u8) { assert!(e.lock(s).is_ok()); assert!(e.request_seed(s).is_ok()); assert!(e.deliver_seed(s, seed_of(byte)).is_ok()); e.drive(s, 1400, 1_400_000); }

#[test] #[ignore = "needs the previous program binary in CONCLAVE_PREV_SO"] fn state_made_by_the_deployed_bytecode_is_upgraded_in_place_and_every_party_is_repaid_correctly() {
    let prev = std::fs::read(std::env::var("CONCLAVE_PREV_SO").expect("CONCLAVE_PREV_SO")).unwrap(); let new = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../program/target/deploy/conclave.so")).unwrap();
    assert_eq!(hex(sha256(&[&prev])), "7bd612e7032fd525f2d49b8943dfeec9f7fe7c84e3cdd5538d989fe6b139b3f4", "the binary on devnet"); assert_ne!(prev, new);
    let mut e = Env::new(5); e.model_rent(); let pid = e.pid; e.svm.add_program(pid, &prev).unwrap(); let hub0 = e.lamports(&e.hub);
    // ---- made by the previous program: two strategies sealed (the HUB pays), a season played and paid out but not yet closed, and one left open with entries ----
    let (a_, b) = (e.register(1, "old A", code_of(NAMES[0])), e.register(2, "old B", code_of(NAMES[1]))); old_seal(&mut e, &a_); old_seal(&mut e, &b);
    assert_eq!((hub0 - e.lamports(&e.hub), e.open_raw(a_.id), e.open_raw(b.id)), (40_000, 0, 0), "the previous build: the hub paid 20,000 for each, and no flag exists");
    let mut s1 = old_season(&mut e, 700, 10); old_enter(&mut e, &mut s1, &a_); old_enter(&mut e, &mut s1, &b); play(&mut e, &mut s1, 3); assert!(e.settle_publishing(&s1, 2).is_ok()); e.claim_all(&s1);
    let mut s2 = old_season(&mut e, 701, 10); old_enter(&mut e, &mut s2, &a_); assert_eq!(e.open_count(a_.id), 1); assert!(e.data(&s2.terms).is_empty() && e.data(&s1.terms).is_empty(), "no terms record exists for either");
    // the previous build's own CloseStrategy still works before the upgrade: and the strategy is repaid to the hub (checked after, with the new program, below)
    // ---- the upgrade ----
    e.svm.add_program(pid, &new).unwrap();
    // 1. a season of the old build can still be paid out and closed: its claims account closes with NO terms record, and the hub gets its rent back
    let v0 = e.vault_total(); let h0 = e.lamports(&e.hub); let r = e.close_claims(&s1); assert!(r.is_ok(), "CloseClaims on a season with no terms record: {}", err_string(&r)); assert_eq!((e.lamports(&e.hub) - h0, v0 - e.vault_total()), (34_944, 34_944)); assert!(e.cleanup(&s1).is_ok());
    // 2. an old season still open cannot take new entries (no terms to read), but can be wound up: refunds, claims, close, cleanup; and the old strategy's count is released
    let b_before = e.balance(&e.players[2].pubkey()); { let t = e.data(&s2.terms); assert!(t.is_empty()); } let ix = e.enter_ix_expecting(&s2, &b, 2, 10, &[0u8; 32], &[0u8; 32]); let kp = e.player(2); e.fresh_blockhash(); errs(&e.send(&[ix], &[&kp]), "entering a season that has no terms record"); assert_eq!(e.balance(&e.players[2].pubkey()), b_before);
    assert!(e.cancel(&s2).is_ok()); e.claim_all(&s2); let r = e.close_claims(&s2); assert!(r.is_ok(), "{}", err_string(&r)); let ids = e.held_ids(&s2); let ix = e.with_strats(e.cleanup_ix(&s2), &ids); assert!(e.send(&[ix], &[]).is_ok()); assert_eq!(e.open_count(a_.id), 0, "released");
    // 3. a NEW season: the old strategies enter it with the terms they read, and a strategy sealed by the new program enters too
    let c = e.register(3, "new C", code_of(NAMES[2])); assert!(e.seal(&c).is_ok()); assert_eq!((e.registry_paid(c.id), e.registry_paid(a_.id), e.registry_paid(b.id)), (true, false, false), "only the new one carries the flag");
    let mut s3 = e.season(702); assert!(e.init_pool(&s3).is_ok()); let r = e.create_season(&mut s3, 2, 10, 20, false, 2); assert!(r.is_ok(), "CreateSeason (new): {}", err_string(&r)); for t in [&a_, &b, &c] { let r = e.enter(&mut s3, t); assert!(r.is_ok(), "Enter (new): {}", err_string(&r)); }
    assert_eq!((e.open_raw(a_.id), e.open_raw(b.id), e.open_raw(c.id)), (1, 1, S_PAYER_REG | 1), "an old strategy's count works as before and never gains the flag; the new one keeps it");
    play(&mut e, &mut s3, 4); assert!(e.settle(&s3).is_ok()); for i in 0..3 { assert!(e.publish(&s3, i).is_ok()); } e.claim_all(&s3); assert!(e.close_claims(&s3).is_ok()); assert!(e.svm.get_account(&s3.terms).map_or(true, |x| x.data.is_empty()), "the new season's terms closed with its claims");
    // 4. each is repaid by whoever paid it: the old strategies by the HUB, the new one by its REGISTRY
    for t in [&a_, &b, &c] { let rk = e.reg_pda(t.id); let (h, r) = (e.lamports(&e.hub), e.lamports(&rk)); let by_reg = e.registry_paid(t.id); let res = e.close_strategy(t); assert!(res.is_ok(), "CloseStrategy {}: {}", t.id, err_string(&res)); let (dh, dr) = (e.lamports(&e.hub) - h, e.lamports(&rk) - r);
        assert_eq!((dh, dr), if by_reg { (0, 20_000) } else { (20_000, 0) }, "strategy {}: {}", t.id, if by_reg { "its registry is repaid" } else { "the hub is repaid" }); }
    assert!(e.cleanup(&s3).is_ok()); assert!(e.commit_undelegate(&[s3.receipt]).is_ok()); assert!(e.release_bond(&s3).is_ok()); for t in [&a_, &b, &c] { assert!(e.commit_undelegate(&[e.reg_pda(t.id)]).is_ok()); let r = e.close_registry(t); assert!(r.is_ok(), "{}", err_string(&r)); }
    // the one forfeit: s2 was cancelled by its creator
    assert_eq!(e.vault_total(), 0, "nothing left in the rollup vault"); assert_eq!(e.lamports(&e.hub), hub0 + BOND / 4, "the hub is whole: every rent returned, plus the creator's 25% forfeit on the season it abandoned");
}
