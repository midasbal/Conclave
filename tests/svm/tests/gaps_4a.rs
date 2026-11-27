//! Two gaps found by reading the 3b program, reproduced against its bytecode (each test failed there, reporting the damage), then fixed. Kept as regressions.
//! The delegation program is a stand-in that accepts the call, so what is real here is everything OUR program decides: whether it hands the receipt over at all. After a hand-over the receipt is owned by the
//! delegation program, exactly as on base.
mod common;
use common::*;
use solana_instruction::{AccountMeta, Instruction};

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
pub const E_DELEGATE_RECEIPT: u32 = 9140; pub const E_CLEANUP_RECEIPT: u32 = 9141;
/// Delegate, kind 2 (receipt), as any wallet can send it: it pays, and it names the validator that will hold the account
fn delegate_receipt_ix(e: &Env, s: &Season, payer: Address, validator: Address) -> Instruction { let mut d = vec![2u8]; d.extend(s.sid.to_le_bytes()); let buf = pda(&[b"buffer", s.receipt.as_ref()], &e.pid);
    e.ix(2, vec![e.m(payer, true, true), e.ro(a(SYSTEM)), e.rw(s.receipt), e.ro(e.pid), e.rw(buf), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(validator)], d) }
fn delegate_by(e: &mut Env, s: &Season, who: usize) -> Res { e.fresh_blockhash(); let kp = e.player(who); let ix = delegate_receipt_ix(e, s, kp.pubkey(), Address::new_unique()); e.send(&[ix], &[&kp]) }
fn delegate_by_creator(e: &mut Env, s: &Season) -> Res { e.fresh_blockhash(); let p = e.payer.pubkey(); let ix = delegate_receipt_ix(e, s, p, Address::new_unique()); e.send(&[ix], &[]) }
fn owner_of(e: &Env, k: &Address) -> Address { e.svm.get_account(k).unwrap().owner }
fn rejects(r: &Res, code: u32, what: &str) { assert_eq!(custom(r), Some(code), "{}: expected Custom {}, got {}", what, code, err_string(r)); }
fn finished(e: &mut Env, sid: u64) -> Season { let s = e.full_season(sid, &NAMES, 2, 10, false, 2, 3, true); assert!(e.settle(&s).is_ok()); for i in 0..5 { assert!(e.publish(&s, i).is_ok()); } s }

#[test] fn gap1_a_stranger_cannot_take_a_fresh_receipt_before_its_creator_delegates_it() {
    let mut e = Env::new(5); let s = e.season(401); assert!(e.init_receipt(&s).is_ok()); let (data0, lam0) = (e.data(&s.receipt), e.lamports(&s.receipt));
    let r = delegate_by(&mut e, &s, 3);
    if r.is_ok() { let own = owner_of(&e, &s.receipt); let mine = delegate_by_creator(&mut e, &s); panic!("GAP REPRODUCED: a stranger delegated the creator's fresh receipt to a validator of its own choosing. The receipt is now owned by {} (delegation program: {}), holding the creator's bond of {} lamports; the creator's own delegation afterwards: {}", own, own == a(DLP), BOND, err_string(&mine)); }
    rejects(&r, E_DELEGATE_RECEIPT, "a stranger delegating a fresh receipt"); assert_eq!((owner_of(&e, &s.receipt), e.data(&s.receipt), e.lamports(&s.receipt)), (e.pid, data0, lam0), "untouched");
    let r = delegate_by_creator(&mut e, &s); assert!(r.is_ok(), "the creator still delegates its own fresh receipt: {}", err_string(&r)); assert_eq!(owner_of(&e, &s.receipt), a(DLP));
}

#[test] fn gap1_a_closed_receipt_cannot_be_delegated_again_to_delay_the_bond() {
    let mut e = Env::new(5); let s = finished(&mut e, 402); assert!(e.cleanup(&s).is_ok()); assert_eq!(e.data(&s.receipt)[rc::STATE], 2); assert!(e.commit_undelegate(&[s.receipt]).is_ok());
    let before = e.data(&s.receipt);
    let r = delegate_by(&mut e, &s, 3);
    if r.is_ok() { let rel = e.release_bond(&s); panic!("GAP REPRODUCED: a stranger re-delegated a CLOSED receipt; it is now owned by the delegation program: {}, and the creator's ReleaseBond now answers: {}", owner_of(&e, &s.receipt) == a(DLP), err_string(&rel)); }
    rejects(&r, E_DELEGATE_RECEIPT, "a stranger re-delegating a closed receipt"); rejects(&delegate_by_creator(&mut e, &s), E_DELEGATE_RECEIPT, "nor may its creator: a closed receipt is the season's permanent record");
    assert_eq!((owner_of(&e, &s.receipt), e.data(&s.receipt)), (e.pid, before)); let c0 = e.lamports(&e.payer.pubkey()); let r = e.release_bond(&s); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(e.lamports(&e.payer.pubkey()) + r.unwrap().fee - c0, BOND);
}

#[test] fn gap1_a_receipt_that_has_opened_a_season_cannot_be_delegated_again() {
    // should such a receipt ever be back on base, nobody may move it: not a stranger and not the creator
    let mut e = Env::new(5); let mut s = e.season(403); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); assert_eq!(e.data(&s.receipt)[rc::STATE], 1);
    rejects(&delegate_by(&mut e, &s, 3), E_DELEGATE_RECEIPT, "an opened receipt, by a stranger"); rejects(&delegate_by_creator(&mut e, &s), E_DELEGATE_RECEIPT, "an opened receipt, by its creator"); assert_eq!(owner_of(&e, &s.receipt), e.pid);
}

/// a stranger's Cleanup, with whatever it puts where the receipt belongs
fn stranger_cleanup(e: &mut Env, s: &Season, rc_meta: Option<AccountMeta>) -> Res { e.fresh_blockhash(); let kp = e.player(4); let mut ix = e.with_strats(e.cleanup_ix(s), &e.held_ids(s)); ix.accounts[0] = AccountMeta::new_readonly(kp.pubkey(), true);
    match rc_meta { Some(m) => ix.accounts[7] = m, None => ix.accounts.truncate(7) } e.send(&[ix], &[&kp]) }
/// what the skipped accounting costs: used to describe the damage when the program accepts the call
fn damage(e: &mut Env, s: &Season) -> String { let state = e.data(&s.receipt)[rc::STATE]; let rel = e.release_bond(s); e.fresh_blockhash(); let ar = s.arena; e.svm.set_account(ar, solana_account::Account::default()).unwrap(); /* the closed arena no longer exists in the rollup */
    let mut d = s.sid.to_le_bytes().to_vec(); let _ = &mut d; let p = e.payer.pubkey(); let ix = e.ix(21, vec![e.m(p, true, true), e.ro(e.config), e.rw(s.receipt), e.ro(s.arena)], d); let rec = e.send(&[ix], &[]); format!("receipt state stays {} (opened), ReleaseBond answers {}; only RecoverBond (authority) moves it ({}), which makes {} of {} releasable with forfeit {}", state, err_string(&rel), err_string(&rec), rd64(&e.data(&s.receipt), rc::RELEASE), BOND, rd64(&e.data(&s.receipt), rc::FORFEIT)) }
/// a creator-cancelled season: the creator forfeits 25% of the bond at Cleanup
fn creator_cancelled(e: &mut Env, sid: u64) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); for i in 0..2 { let st = e.register_and_seal(i, NAMES[i], code_of(NAMES[i])); assert!(e.enter(&mut s, &st).is_ok()); } assert!(e.cancel(&s).is_ok()); e.claim_all(&s); s }

#[test] fn gap2_cleanup_with_a_read_only_receipt_cannot_strand_the_bond_or_skip_the_forfeit() {
    let mut e = Env::new(5); let s = creator_cancelled(&mut e, 410); let (hub0, rl0) = (e.lamports(&e.hub), e.lamports(&s.receipt));
    let ro = AccountMeta::new_readonly(s.receipt, false); let r = stranger_cleanup(&mut e, &s, Some(ro));
    if r.is_ok() { let d = damage(&mut e, &s); panic!("GAP REPRODUCED: a stranger cleaned up a creator-cancelled season passing the receipt READ-ONLY. The 25% forfeit ({} lamports) never reached the hub; {}", BOND / 4, d); }
    rejects(&r, E_CLEANUP_RECEIPT, "Cleanup with the receipt read-only"); assert_eq!((e.lamports(&e.hub), e.lamports(&s.receipt), e.data(&s.receipt)[rc::STATE]), (hub0, rl0, 1), "nothing happened");
    assert!(e.cleanup(&s).is_ok()); assert_eq!(e.data(&s.receipt)[rc::STATE], 2); assert_eq!(rd64(&e.data(&s.receipt), rc::FORFEIT), BOND / 4); assert_eq!(e.lamports(&e.hub) - hub0, BOND / 4, "the forfeit reached the hub");
}

#[test] fn gap2_cleanup_without_the_receipt_or_with_another_account_cannot_skip_the_accounting() {
    let mut e = Env::new(5); let s = finished(&mut e, 411); e.set_data(&s.arena, |d| d[arx::RENT..arx::RENT + 8].copy_from_slice(&300_000u64.to_le_bytes())); /* a shortfall the bond must top the hub up for */ let other = creator_cancelled(&mut e, 412);
    let hub0 = e.lamports(&e.hub);
    let r = stranger_cleanup(&mut e, &s, None);
    if r.is_ok() { let d = damage(&mut e, &s); panic!("GAP REPRODUCED: a stranger cleaned up with NO receipt account. The 300000 lamport hub top-up was skipped; {}", d); }
    assert!(r.is_err() && !failed_to_complete(&r), "Cleanup with no receipt: {}", err_string(&r));
    for (meta, what) in [(AccountMeta::new(other.receipt, false), "another season's receipt, writable"), (AccountMeta::new(e.hub, false), "an account that is not a receipt"), (AccountMeta::new(Address::new_unique(), false), "an account that does not exist")] {
        let r = stranger_cleanup(&mut e, &s, Some(meta)); if r.is_ok() { let d = damage(&mut e, &s); panic!("GAP REPRODUCED: Cleanup accepted {} in the receipt's place and skipped the accounting; {}", what, d); } rejects(&r, E_CLEANUP_RECEIPT, what); }
    assert_eq!(e.data(&other.receipt)[rc::STATE], 1, "the other season's receipt is untouched"); assert_eq!(e.lamports(&e.hub), hub0);
    // done properly, by a stranger: the shortfall comes out of the bond
    let p = e.payer.pubkey(); let _ = p; let ro_ok = AccountMeta::new(s.receipt, false); let r = stranger_cleanup(&mut e, &s, Some(ro_ok)); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(e.data(&s.receipt)[rc::STATE], 2); assert_eq!(e.lamports(&e.hub) - hub0, 300_000); assert_eq!(rd64(&e.data(&s.receipt), rc::RELEASE), BOND - 300_000);
}
