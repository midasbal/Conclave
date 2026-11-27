//! Money safety in the season lifecycle: time-based lock, seed timeout and season deadline, cancel and exact refund, minimum entrants, creation bond, hub reconciliation, force publish at settle,
//! settle-records-not-pays, Claim, the claims account, every finals void path, and the pool-solvency assertions. All through the real program bytecode.
//! Every money path ends in the same invariant (`assert_books`): entries in = claimed + unclaimed, and the pool holds exactly the unclaimed part.
mod common;
use common::*;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn open(e: &mut Env, sid: u64, n: usize, fee: u64, finals: bool) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); let r = e.create_season(&mut s, if finals { 15 } else { 2 }, fee, 20, finals, 2); assert!(r.is_ok(), "CreateSeason {}", err_string(&r));
    for i in 0..n { let nm = NAMES[i % 5]; let st = e.register_and_seal(i % e.players.len(), nm, code_of(nm)); let r = e.enter(&mut s, &st); assert!(r.is_ok(), "Enter {} {}", i, err_string(&r)); } s }
fn bals(e: &Env) -> Vec<u64> { e.players.iter().map(|p| e.balance(&p.pubkey())).collect() }
fn f2(e: &Env, s: &Season) -> u8 { e.data(&s.arena)[ar::F2] }
fn rcf(e: &Env, s: &Season, off: usize) -> u64 { rd64(&e.data(&s.receipt), off) }
fn pool_bal(e: &Env, s: &Season) -> u64 { e.pool_balance(s) }
fn rejects(r: &Res, code: u32, what: &str) { assert_eq!(custom(r), Some(code), "{}: expected Custom {}, got {}", what, code, err_string(r)); }
fn errs(r: &Res, what: &str) { assert!(r.is_err() && !failed_to_complete(r), "{} should be refused with an error, got {}", what, err_string(r)); }
fn set64(e: &mut Env, k: &Address, off: usize, v: u64) { e.set_data(k, |d| d[off..off + 8].copy_from_slice(&v.to_le_bytes())); }

#[test] fn happy_path_force_publish_cleanup_and_bond_release() {
    let mut e = Env::new(5); let start = bals(&e); let hub0 = e.lamports(&e.hub);
    let s = e.full_season(100, &NAMES, 2, 10, false, 2, 7, true);
    let early = e.release_bond(&s); rejects(&early, 9054, "ReleaseBond before the season is closed");
    // Settle publishes every entry inline: 5 strat+registry pairs appended
    let mid = bals(&e); let r = e.settle_publishing(&s, 5); assert!(r.is_ok(), "Settle with inline publish: {}", err_string(&r));
    assert_eq!(bals(&e), mid, "Settle records, it does not pay"); assert_eq!(pool_bal(&e, &s), 50, "the whole pot is still in the pool"); e.assert_books(&s, 0); assert_eq!(e.claim_totals(&s), (true, 50, 0)); assert_eq!(e.data(&s.claims)[cl::KIND], 1);
    assert_eq!(custom(&e.close_claims(&s)), Some(9083), "the claims account cannot close while money is owed");
    e.claim_all(&s); e.assert_books(&s, 0); let paid = bals(&e); e.claim_all(&s); assert_eq!(bals(&e), paid, "every claim again: all succeed, nobody is paid twice"); e.assert_books(&s, 0); assert!(e.close_claims(&s).is_ok());
    assert_eq!(e.data(&s.arena)[ar::PUBN], 5, "all five published by the settle itself"); assert_eq!(e.data(&s.receipt)[rc::PUB], 5);
    // payouts exact, unchanged by the new guards: pot 50 -> 25 / 15 / 10
    let (host, _) = replay(&s, &s.entries); let mut ord: Vec<usize> = (0..5).collect(); ord.sort_by(|&x, &y| host[y].cmp(&host[x]).then(x.cmp(&y)));
    let mut want = vec![-10i64; 5]; for (k, &i) in ord.iter().take(3).enumerate() { want[i] += [25i64, 15, 10][k]; } for i in 0..5 { assert_eq!(e.balance(&e.players[i].pubkey()) as i64 - start[i] as i64, want[i], "owner {}", i); }
    assert_eq!(pool_bal(&e, &s), 0, "the pool is paid out to the unit");
    for i in 0..5 { e.fresh_blockhash(); assert_eq!(custom(&e.publish(&s, i)), Some(9120), "an inline-published entry cannot be published twice"); }
    // cleanup needs nothing else, then the bond is releasable and the hub is exactly where it began
    rejects(&e.commit_undelegate(&[s.receipt]), 9055, "undelegating the receipt of a season that is not closed");
    let c = e.cleanup(&s); assert!(c.is_ok(), "Cleanup {}", err_string(&c));
    assert_eq!(e.data(&s.receipt)[rc::STATE], 2); assert_eq!(rcf(&e, &s, rc::FORFEIT), 0, "a completed season forfeits nothing"); assert_eq!(rcf(&e, &s, rc::RELEASE), BOND); assert_eq!(e.lamports(&e.hub), hub0, "hub made whole");
    assert!(e.commit_undelegate(&[s.receipt]).is_ok());
    let (rl0, p0) = (e.lamports(&s.receipt), e.lamports(&e.payer.pubkey())); let r = e.release_bond(&s); assert!(r.is_ok(), "ReleaseBond {}", err_string(&r)); let fee = r.unwrap().fee;
    assert_eq!(e.lamports(&e.payer.pubkey()) + fee - p0, BOND, "the creator gets the exact bond back"); assert_eq!(rl0 - e.lamports(&s.receipt), BOND); // (the SVM runs with zero rent, so the emptied receipt is collected; on a real cluster the rent-exempt minimum stays)
    let p1 = e.lamports(&e.payer.pubkey()); let r = e.release_bond(&s); assert!(r.is_err(), "a second release finds nothing to pay"); assert!(e.lamports(&e.payer.pubkey()) <= p1, "no money moved to the creator, only the transaction fee was paid");
}
#[test] fn partial_inline_publish_and_the_publish_grace() {
    let mut e = Env::new(5); e.params.grace = MIN_GRACE; let s = e.full_season(101, &NAMES, 2, 10, false, 2, 3, true);
    assert!(e.settle_publishing(&s, 2).is_ok()); assert_eq!(e.data(&s.arena)[ar::PUBN], 2);
    rejects(&e.cleanup(&s), 9123, "Cleanup with entries unpublished inside the grace");
    for i in 2..5 { assert!(e.publish(&s, i).is_ok()); } assert!(e.cleanup(&s).is_ok(), "all published: cleanup");
    // nobody publishes: after the grace the season can still be closed, it cannot stay half-published forever
    let s2 = e.full_season(102, &NAMES, 2, 10, false, 2, 4, true); assert!(e.settle(&s2).is_ok()); errs(&e.cleanup(&s2), "Cleanup before the grace with nothing published"); e.warp(MIN_GRACE - 1); e.fresh_blockhash(); errs(&e.cleanup(&s2), "Cleanup one slot early");
    e.warp(2); e.fresh_blockhash(); assert!(e.cleanup(&s2).is_ok(), "Cleanup after the grace"); assert_eq!(e.data(&s2.receipt)[rc::STATE], 2);
}
#[test] fn inline_publish_is_limited_by_the_transaction_size_and_that_is_why_the_grace_exists() {
    let mut e = Env::new(20); let mut s = e.season(103); let mut max_full = 0; let mut max_pairs_at_20 = 0;
    for i in 0..20 { let st = e.register(i, "x", code_of("Mom20th")); s.entries.push(st); }
    let size = |e: &Env, s: &Season, n: usize| { let ix = e.settle_ix_publishing(s, n); let m = solana_message::Message::new(&[ix], Some(&e.payer.pubkey())); m.serialize().len() + 1 + 64 };
    for n in 1..=20 { let mut t = s.clone(); t.entries.truncate(n); if size(&e, &t, n) <= 1232 { max_full = n; } }
    for k in 0..=20 { if size(&e, &s, k) <= 1232 { max_pairs_at_20 = k; } }
    println!("TXSIZE all {} entrants publish inline within 1232 bytes; with 20 entrants {} of 20 pairs fit ({} bytes with all 20)", max_full, max_pairs_at_20, size(&e, &s, 20));
    assert!(size(&e, &s, 20) > 1232, "publishing all 20 inline cannot fit in one legacy transaction"); assert!(max_full >= 8 && max_full < 20);
}
#[test] fn seed_timeout_cancels_and_refunds_every_fee_exactly() {
    let mut e = Env::new(5); e.params.seedto = 3_000; let start = bals(&e); let hub0 = e.lamports(&e.hub); let mut s = open(&mut e, 110, 4, 10, false);
    let after = bals(&e); for i in 0..4 { assert_eq!(after[i], start[i] - 10); } assert_eq!(pool_bal(&e, &s), 40);
    errs(&e.cancel_by(&s, 4), "a stranger cancelling an unlocked arena"); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok());
    rejects(&e.cancel_by(&s, 4), 9033, "Cancel before the seed timeout"); e.warp(2_999); e.fresh_blockhash(); rejects(&e.cancel_by(&s, 4), 9033, "Cancel one slot early");
    e.warp(2); e.fresh_blockhash(); let r = e.cancel_by(&s, 4); assert!(r.is_ok(), "Cancel after the timeout, by a stranger: {}", err_string(&r));
    assert_eq!(bals(&e), after, "Cancel records the refunds, it does not pay them"); e.assert_books(&s, 0); assert_eq!(e.data(&s.claims)[cl::KIND], 2); for i in 0..4 { assert_eq!(e.owed(&s, i), 10); }
    e.claim_all(&s); assert_eq!(bals(&e), start, "every entrant has exactly their fee back"); assert_eq!(pool_bal(&e, &s), 0); e.assert_books(&s, 0);
    assert_eq!(f2(&e, &s) & (F2_CANCELLED | F2_REFUNDED), F2_CANCELLED | F2_REFUNDED); assert_eq!(e.data(&s.arena)[arx::REASON], 2);
    let rcp = e.data(&s.receipt); assert_eq!(rcp[rc::KIND], 2, "public record: cancelled"); assert_eq!(rcp[rc::NS], 4); assert_eq!(rcp[rc::REASON], 2); assert_eq!(rd64(&rcp, rc::REFUNDED), 40);
    rejects(&e.cancel_by(&s, 4), 9034, "a second refund"); assert_eq!(bals(&e), start);
    let mut s2 = s.clone(); errs(&e.deliver_seed(&mut s2, [9; 32]), "a seed that arrives after the cancel"); errs(&e.advance(&s, 1400, 1_400_000), "Advance on a cancelled arena"); errs(&e.settle(&s), "Settle on a cancelled arena");
    let st = e.register_and_seal(4, "late", code_of("Mom20th")); let mut s3 = s.clone(); errs(&e.enter(&mut s3, &st), "Enter on a cancelled arena");
    assert!(e.cleanup(&s).is_ok()); assert_eq!(e.data(&s.receipt)[rc::STATE], 2); assert_eq!(rcf(&e, &s, rc::FORFEIT), 0, "a seed timeout is not the creator's fault: no forfeit"); assert_eq!(rcf(&e, &s, rc::RELEASE), BOND); assert_eq!(e.lamports(&e.hub), hub0);
    s = e.season(111); let _ = s; // (a fresh season id is unaffected)
}
#[test] fn under_minimum_at_lock_cancels_and_refunds_in_full() {
    let mut e = Env::new(5); e.params.mins = 3; e.params.window = 1_000; let start = bals(&e); let hub0 = e.lamports(&e.hub); let s = open(&mut e, 120, 2, 10, false);
    rejects(&e.lock(&s), 9031, "the creator cannot cancel early by locking an under-filled field"); rejects(&e.lock_by(&s, 4), 9032, "a stranger cannot lock inside the window");
    e.warp(1_000); e.fresh_blockhash(); let r = e.lock_by(&s, 4); assert!(r.is_ok(), "any wallet locks after the window: {}", err_string(&r));
    assert_eq!(f2(&e, &s) & F2_CANCELLED, F2_CANCELLED); assert_eq!(e.data(&s.arena)[arx::REASON], 1); assert_eq!(e.flags(&s) & F_LOCKED, F_LOCKED);
    errs(&e.request_seed(&s), "RequestSeed on an under-minimum season"); let st = e.register_and_seal(3, "late", code_of("Mom20th")); let mut t = s.clone(); errs(&e.enter(&mut t, &st), "Enter after the window");
    let r = e.cancel_by(&s, 4); assert!(r.is_ok(), "{}", err_string(&r)); e.assert_books(&s, 0); e.claim_all(&s); assert_eq!(bals(&e), start, "both entrants refunded in full"); assert_eq!(pool_bal(&e, &s), 0);
    let hub1 = e.lamports(&e.hub); assert!(e.cleanup(&s).is_ok()); let forfeit = BOND / 100 * 25;
    assert_eq!(rcf(&e, &s, rc::FORFEIT), forfeit, "an abandoned season forfeits 25% of the bond"); assert_eq!(rcf(&e, &s, rc::RELEASE), BOND - forfeit); assert_eq!(e.lamports(&e.hub) - hub1, forfeit, "the hub keeps the forfeit"); assert_eq!(e.lamports(&e.hub) - hub0, forfeit);
    // a full-enough field is NOT cancelled by a stranger's lock after the window: it just locks and runs
    let mut e = Env::new(5); e.params.mins = 2; e.params.window = 1_000; let s = open(&mut e, 121, 2, 10, false); e.warp(1_000); e.fresh_blockhash(); assert!(e.lock_by(&s, 4).is_ok()); assert_eq!(f2(&e, &s) & F2_CANCELLED, 0); assert_eq!(e.flags(&s) & F_LOCKED, F_LOCKED); assert!(e.request_seed(&s).is_ok());
}
#[test] fn creator_cancel_and_the_leaked_arena_recovery() {
    // 1) a season that failed mid-setup: the arena exists, the pool was never initialised, nobody entered. The creator cancels, then anyone cleans up and the hub is whole.
    let mut e = Env::new(5); let hub0 = e.lamports(&e.hub); let mut s = e.season(130); let r = e.create_season(&mut s, 2, 10, 20, false, 2); assert!(r.is_ok());
    errs(&e.cancel_by(&s, 4), "a stranger cancelling an unlocked arena"); let r = e.cancel(&s); assert!(r.is_ok(), "creator Cancel with no pool at all: {}", err_string(&r)); let r = e.cleanup(&s); assert!(r.is_ok(), "{}", err_string(&r));
    assert_eq!(e.data(&s.receipt)[rc::REASON], 3); assert_eq!(rcf(&e, &s, rc::FORFEIT), BOND / 100 * 25, "creating and abandoning costs a quarter of the bond"); assert_eq!(e.lamports(&e.hub) - hub0, BOND / 100 * 25);
    // 2) the creator never comes back: after the window ANYONE locks (which cancels the empty arena), cancels and cleans up
    let mut e = Env::new(5); e.params.window = 500; let hub0 = e.lamports(&e.hub); let mut s = e.season(131); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok());
    rejects(&e.lock_by(&s, 3), 9032, "inside the window"); e.warp(500); e.fresh_blockhash(); assert!(e.lock_by(&s, 3).is_ok()); assert!(e.cancel_by(&s, 3).is_ok());
    let cl = { let kp = e.player(3); let mut ix = e.cleanup_ix(&s); ix.accounts[0] = e.m(kp.pubkey(), true, false); e.send(&[ix], &[&kp]) }; assert!(cl.is_ok(), "Cleanup by a stranger: {}", err_string(&cl)); assert_eq!(e.lamports(&e.hub) - hub0, BOND / 100 * 25);
    // nobody entered, so nothing is owed: the claims account is closable at once
    assert!(e.close_claims(&s).is_ok()); assert_eq!(e.claim_totals(&s), (true, 0, 0));
}
#[test] fn the_upgrade_refuses_old_arenas_and_never_strands_an_old_bond() {
    // an arena written by the previous build carries the old magic: every instruction refuses it instead of misreading its layout (so the deploy must happen with no season open)
    let mut e = Env::new(5); let mut s = e.season(132); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); e.set_data(&s.arena, |d| d[0..4].copy_from_slice(&0x4152_4E41u32.to_le_bytes()));
    for r in [e.lock(&s), e.cancel(&s), e.settle(&s), e.cleanup(&s), e.advance(&s, 1400, 1_400_000)] { errs(&r, "an old-layout arena"); }
    // a closed receipt of the previous, shorter size with its bond still unreleased: undelegation and ReleaseBond must still serve it, because the money fields did not move
    let s = e.season(133); assert!(e.init_receipt(&s).is_ok()); let mut acc = e.svm.get_account(&s.receipt).unwrap(); acc.data.truncate(RC_MONEY_SIZE); acc.data[rc::STATE] = 2; acc.data[rc::SEASON..rc::SEASON + 8].copy_from_slice(&133u64.to_le_bytes()); acc.data[rc::RELEASE..rc::RELEASE + 8].copy_from_slice(&BOND.to_le_bytes()); e.svm.set_account(s.receipt, acc).unwrap();
    assert!(e.commit_undelegate(&[s.receipt]).is_ok(), "commit+undelegate of an old closed receipt"); let before = e.lamports(&e.payer.pubkey()); let r = e.release_bond(&s); assert!(r.is_ok(), "ReleaseBond on an old receipt: {}", err_string(&r)); assert_eq!(e.lamports(&e.payer.pubkey()) + r.unwrap().fee - before, BOND);
    // but an old receipt cannot open a season under the new layout
    let t = e.season(134); assert!(e.init_receipt(&t).is_ok()); let mut acc = e.svm.get_account(&t.receipt).unwrap(); acc.data.truncate(RC_MONEY_SIZE); e.svm.set_account(t.receipt, acc).unwrap(); e.provision_if_new(t.arena, arena_size(20)); e.provision_side(&t, 20); let ix = e.create_season_ix(&t, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9020, "CreateSeason on an old-size receipt");
}
#[test] fn hub_is_reconciled_against_the_bond_at_cleanup() {
    // the stand-in Magic program does not move lamports, so the draw is set on the arena the way the real create records it, and the close returns nothing: a full shortfall the bond must cover
    let mut e = Env::new(5); let hub0 = e.lamports(&e.hub); let s = e.full_season(140, &NAMES, 2, 10, false, 2, 5, true); set64(&mut e, &s.arena, arx::RENT, 300_000); assert!(e.settle_publishing(&s, 5).is_ok());
    assert!(e.cleanup(&s).is_ok()); assert_eq!(e.lamports(&e.hub) - hub0, 300_000, "the hub is topped up from the bond by exactly the shortfall"); assert_eq!(rcf(&e, &s, rc::RELEASE), BOND - 300_000); assert_eq!(rcf(&e, &s, rc::FORFEIT), 0); assert_eq!(rcf(&e, &s, rc::RECLAIMED), 0);
    // a draw bigger than the whole bond: the bond is spent, nothing underflows, the creator gets nothing back
    let mut e = Env::new(5); let hub0 = e.lamports(&e.hub); let s = e.full_season(141, &NAMES, 2, 10, false, 2, 5, true); set64(&mut e, &s.arena, arx::RENT, 5_000_000); assert!(e.settle_publishing(&s, 5).is_ok());
    let rl = e.lamports(&s.receipt); assert!(e.cleanup(&s).is_ok()); assert_eq!(e.lamports(&e.hub) - hub0, BOND); assert_eq!(rl - e.lamports(&s.receipt), BOND, "the whole bond went to the hub, the creator gets nothing back");
}
#[test] fn solvency_assertions_at_record_and_at_claim() {
    // a donation to the pool address cannot block a season; the surplus simply stays
    let mut e = Env::new(5); let s = e.full_season(150, &NAMES, 2, 10, false, 2, 6, true); let pata = e.ata(&s.pool); e.mint_to(&pata, 3); let r = e.settle(&s); assert!(r.is_ok(), "{}", err_string(&r)); e.assert_books(&s, 3); e.claim_all(&s); assert_eq!(pool_bal(&e, &s), 3, "only the donation is left"); e.assert_books(&s, 3);
    // a pool that holds less than the pot refuses to settle, and nothing is recorded
    let mut e = Env::new(5); let s = e.full_season(151, &NAMES, 2, 10, false, 2, 6, true); let pata = e.ata(&s.pool); e.set_data(&pata, |d| d[64..72].copy_from_slice(&49u64.to_le_bytes()));
    rejects(&e.settle(&s), 9041, "an under-funded pool"); assert_eq!(e.flags(&s) & F_SETTLED, 0); assert_eq!(e.claim_totals(&s).0, false, "nothing recorded"); e.set_data(&pata, |d| d[64..72].copy_from_slice(&50u64.to_le_bytes())); e.fresh_blockhash(); assert!(e.settle(&s).is_ok(), "restored pool settles");
    // at Claim the pool must cover EVERYTHING unclaimed, not just this claim: one unit short and nobody can drain it ahead of the others
    let before = bals(&e); let first = (0..5).find(|&i| e.owed(&s, i) > 0).unwrap(); e.set_data(&pata, |d| d[64..72].copy_from_slice(&49u64.to_le_bytes())); for i in 0..5 { if e.owed(&s, i) > 0 { rejects(&e.claim(&s, i), 9041, "a claim against a short pool"); } } assert_eq!(bals(&e), before); assert!(!e.claim_done(&s, first));
    e.set_data(&pata, |d| d[64..72].copy_from_slice(&50u64.to_le_bytes())); e.claim_all(&s); e.assert_books(&s, 0);
    // the claims books cannot be talked into paying more than was recorded: an entry amount above what is outstanding is refused
    let mut e = Env::new(5); let s = e.full_season(155, &NAMES, 2, 10, false, 2, 6, true); assert!(e.settle(&s).is_ok()); let i = (0..5).find(|&i| e.owed(&s, i) > 0).unwrap(); set64(&mut e, &s.claims, cl::HDR + i * cl::ESZ + cl::E_OWED, 51); rejects(&e.claim(&s, i), 9042, "an amount above everything outstanding");
    // the pool bookkeeping must equal fee x entrants exactly
    let mut e = Env::new(5); let s = e.full_season(152, &NAMES, 2, 10, false, 2, 6, true); let p = rd64(&e.data(&s.arena), ar::POOL); set64(&mut e, &s.arena, ar::POOL, p + 1); rejects(&e.settle(&s), 9040, "bookkeeping off by one"); set64(&mut e, &s.arena, ar::POOL, p); e.fresh_blockhash(); assert!(e.settle(&s).is_ok());
    // the same assertions guard refunds
    let mut e = Env::new(5); e.params.seedto = 100; let s = open(&mut e, 153, 3, 10, false); assert!(e.lock(&s).is_ok()); e.warp(100); e.fresh_blockhash(); let pata = e.ata(&s.pool);
    e.set_data(&pata, |d| d[64..72].copy_from_slice(&29u64.to_le_bytes())); rejects(&e.cancel_by(&s, 4), 9041, "refunds from an under-funded pool"); assert_eq!(f2(&e, &s) & (F2_CANCELLED | F2_REFUNDED), 0, "a failed cancel leaves no half-state");
    e.set_data(&pata, |d| d[64..72].copy_from_slice(&30u64.to_le_bytes())); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok()); e.assert_books(&s, 0);
    // donations on top of a cancelled season stay in the pool and the refunds are still exactly the fees
    let mut e = Env::new(5); e.params.seedto = 100; let start = bals(&e); let s = open(&mut e, 154, 3, 10, false); let pata = e.ata(&s.pool); e.mint_to(&pata, 7); assert!(e.lock(&s).is_ok()); e.warp(100); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok()); e.claim_all(&s); assert_eq!(bals(&e), start); assert_eq!(pool_bal(&e, &s), 7); e.assert_books(&s, 7);
}
#[test] fn claim_is_exact_once_only_to_the_owner_and_works_while_paused() {
    let mut e = Env::new(5); let s = e.full_season(156, &NAMES, 2, 10, false, 2, 9, true);
    rejects(&e.claim(&s, 0), 9080, "a claim before anything is recorded"); rejects(&e.close_claims(&s), 9080, "closing before anything is recorded");
    assert!(e.settle(&s).is_ok()); assert!(e.admin(0, &[]).is_ok(), "pause"); let ex = expect(&s, false); let before = bals(&e);
    let win = (0..5).find(|&i| ex.frank[i] == 1).unwrap(); let other = (win + 1) % 5;
    let ix = e.claim_ix_to(&s, win as u8, e.ata(&e.players[s.entries[other].owner].pubkey())); rejects(&e.send(&[ix], &[]), 9084, "redirecting the winner's claim to another entrant");
    let ix = e.claim_ix_to(&s, 5, e.ata(&e.players[0].pubkey())); rejects(&e.send(&[ix], &[]), 9081, "a slot that does not exist");
    { let mut ix = e.claim_ix(&s, win); ix.accounts[0] = e.rw(Address::new_unique()); assert!(e.send(&[ix], &[]).is_err(), "a fake claims account"); }
    { let other_season = e.season(157); let mut ix = e.claim_ix(&s, win); ix.accounts[1] = e.ro(other_season.pool); ix.accounts[2] = e.rw(e.ata(&other_season.pool)); assert!(e.send(&[ix], &[]).is_err(), "another season's pool"); }
    // a lookalike claims account at another address with a copy of the data is refused
    { let fake = Address::new_unique(); let mut acc = e.svm.get_account(&s.claims).unwrap(); acc.lamports = 1; e.svm.set_account(fake, acc).unwrap(); let mut ix = e.claim_ix(&s, win); ix.accounts[0] = e.rw(fake); rejects(&e.send(&[ix], &[]), 9082, "a copy of the claims account"); }
    assert_eq!(bals(&e), before, "no refused claim moved anything"); e.assert_books(&s, 0);
    // a stranger pays the fee for someone else's claim, while the program is paused
    let kp = e.player(4); let ix = e.claim_ix(&s, win); e.fresh_blockhash(); let r = { let msg_ix = ix.clone(); e.send(&[msg_ix], &[&kp]) }; assert!(r.is_ok(), "Claim while paused: {}", err_string(&r));
    assert_eq!(bals(&e)[s.entries[win].owner] - before[s.entries[win].owner], ex.owed[win]); let once = bals(&e);
    for _ in 0..3 { assert!(e.claim(&s, win).is_ok(), "a repeat claim succeeds"); } assert_eq!(bals(&e), once, "and pays nothing"); e.assert_books(&s, 0); e.claim_all(&s); e.assert_books(&s, 0); assert!(e.close_claims(&s).is_ok(), "CloseClaims while paused"); assert_eq!(pool_bal(&e, &s), 0);
}
/// a finals season of `n` entrants driven to the end of its season phase
fn to_finals(e: &mut Env, sid: u64, n: usize, seed: u8) -> Season { let mut s = open(e, sid, n, 10, true); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, seed_of(seed)).is_ok()); e.drive(&s, 1400, 1_400_000); s }
fn warp_to(e: &mut Env, slot: u64) { assert!(slot >= e.slot, "cannot warp back"); let by = slot - e.slot; e.warp(by); e.fresh_blockhash(); }
/// settle a voided season and prove the money: frozen season ranks, nothing from the finals, claims equal entries, pool empty, creator not punished
fn void_pays_by_season_rank(e: &mut Env, s: &Season, reason: u8, start: &[u64]) {
    let r = e.settle(s); assert!(r.is_ok(), "settle voided (reason {}): {}", reason, err_string(&r)); let ex = expect(s, false); let rcp = e.data(&s.receipt); assert_eq!(rcp[rc::FSTATUS], FS_VOIDED); assert_eq!(rcp[rc::REASON], reason); assert_eq!(e.data(&s.arena)[arx::REASON], reason);
    assert_eq!(rd64(&rcp, rc::FSEEDA), 0); assert_eq!(rcp[rc::FQUAL], 0); for i in 0..s.entries.len() { assert_eq!(e.rank(s, i), ex.srank[i]); assert_eq!(e.owed(s, i), ex.owed[i]); assert_eq!(e.ftotal(s, i), 0, "partial finals scores discarded"); assert_eq!(rcp[RC_ENT + i * 80 + rc::E_FINALIST], 0); }
    e.assert_books(s, 0); e.claim_all(s); e.assert_books(s, 0); assert_eq!(pool_bal(e, s), 0); let after = bals(e); for i in 0..s.entries.len() { let p = s.entries[i].owner; assert_eq!(after[p] + 10 - start[p], ex.owed[i]); }
    for i in 0..s.entries.len() { assert!(e.publish(s, i).is_ok()); } assert!(e.cleanup(s).is_ok()); assert_eq!(rcf(e, s, rc::FORFEIT), 0, "a voided finals is not abandonment"); assert!(e.close_claims(s).is_ok()); }
#[test] fn void_path_finals_seed_never_requested_or_never_delivered() {
    for requested in [false, true] { let mut e = Env::new(5); let start = bals(&e); let mut s = to_finals(&mut e, 160, 5, 8); let at = rd64(&e.data(&s.arena), ar::SDONEAT); if requested { assert!(e.request_seed(&s).is_ok()); rejects(&e.request_seed(&s), 9111, "a second finals request"); }
        warp_to(&mut e, at + FINALS_SEEDTO - 1); rejects(&e.settle(&s), 9115, "one slot before the finals seed timeout"); rejects(&e.cancel_by(&s, 4), 9033, "never refundable once the season phase is over"); rejects(&e.advance(&s, 1400, 1_400_000), 9114, "Advance with no finals seed");
        warp_to(&mut e, at + FINALS_SEEDTO); if requested { rejects(&e.deliver_finals_seed(&mut s, seed_of(1)), 9112, "a finals seed arriving at the timeout is refused, whoever acts first"); } else { rejects(&e.request_seed(&s), 9111, "requesting after the timeout"); }
        void_pays_by_season_rank(&mut e, &s, 4, &start); } }
#[test] fn void_path_finals_run_misses_its_deadline_and_partial_scores_are_discarded() {
    let mut e = Env::new(5); let start = bals(&e); let mut s = to_finals(&mut e, 162, 5, 9); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_finals_seed(&mut s, seed_of(33)).is_ok()); let fs = rd64(&e.data(&s.arena), ar::START);
    for _ in 0..8 { e.warp(150); e.fresh_blockhash(); assert!(e.advance(&s, 1400, 1_400_000).is_ok()); } assert!(rd32(&e.data(&s.arena), ar::CUREP) >= 2 && e.flags(&s) & F_DONE == 0, "some finals episodes ran, not all");
    let dl = phase_deadline(fs, FINALS_EPISODES, 1); warp_to(&mut e, dl - 1); rejects(&e.settle(&s), 9115, "one slot before the finals deadline"); warp_to(&mut e, dl); rejects(&e.advance(&s, 1400, 1_400_000), 9113, "the finals cannot be resumed at the deadline");
    void_pays_by_season_rank(&mut e, &s, 5, &start); }
#[test] fn finals_that_finish_one_slot_before_the_deadline_count_however_late_settle_is() {
    let mut e = Env::new(5); let mut s = to_finals(&mut e, 163, 5, 10); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_finals_seed(&mut s, seed_of(34)).is_ok()); let dl = phase_deadline(rd64(&e.data(&s.arena), ar::START), FINALS_EPISODES, 1);
    warp_to(&mut e, dl - 1); let mut n = 0; while e.flags(&s) & F_DONE == 0 { e.fresh_blockhash(); assert!(e.advance(&s, 1400, 1_400_000).is_ok()); n += 1; assert!(n < 1000); }
    warp_to(&mut e, dl + 10_000_000); assert!(e.settle(&s).is_ok()); assert_eq!(e.data(&s.receipt)[rc::FSTATUS], FS_PLAYED); let ex = expect(&s, true); for i in 0..5 { assert_eq!(e.rank(&s, i), ex.frank[i]); assert_eq!(e.owed(&s, i), ex.owed[i]); } e.claim_all(&s); e.assert_books(&s, 0); }
#[test] fn void_path_thin_field_and_the_two_qualifier_split() {
    // one entrant: fewer than two qualifiers, so there is nothing to play
    let mut e = Env::new(5); let start = bals(&e); let s = to_finals(&mut e, 164, 1, 11); assert_ne!(e.flags(&s) & F_DONE, 0); assert_ne!(f2(&e, &s) & F2_THINFIELD, 0); rejects(&e.request_seed(&s), 9111, "no finals seed for a thin field"); void_pays_by_season_rank(&mut e, &s, 6, &start);
    // exactly two entrants: both qualify and split 60/40 in the combined order
    let mut e = Env::new(5); let start = bals(&e); let mut s = to_finals(&mut e, 165, 2, 12); assert!(e.in_finals(&s)); assert!(e.finalist(&s, 0) && e.finalist(&s, 1)); e.run_finals(&mut s, 12); assert!(e.settle(&s).is_ok()); let ex = expect(&s, true); let mut owed: Vec<u64> = (0..2).map(|i| e.owed(&s, i)).collect(); for i in 0..2 { assert_eq!(e.owed(&s, i), ex.owed[i]); } owed.sort(); assert_eq!(owed, vec![8, 12]); assert_eq!(e.data(&s.receipt)[rc::FQUAL], 2); e.claim_all(&s); e.assert_books(&s, 0); let after = bals(&e); for i in 0..2 { let p = s.entries[i].owner; assert_eq!(after[p] + 10 - start[p], ex.owed[i]); } }
#[test] fn season_deadline_makes_everyone_refundable_and_only_while_the_season_phase_is_unfinished() {
    for finals in [false, true] { let mut e = Env::new(5); let start = bals(&e); let hub0 = e.lamports(&e.hub); let mut s = open(&mut e, 166, 4, 10, finals); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, seed_of(13)).is_ok()); let dl = phase_deadline(rd64(&e.data(&s.arena), ar::START), if finals { 15 } else { 2 }, 1);
        e.warp(150); assert!(e.advance(&s, 1400, 1_400_000).is_ok()); assert!(e.ticks(&s) > 0 && e.flags(&s) & F_SDONE == 0, "partly run");
        warp_to(&mut e, dl - 1); rejects(&e.cancel_by(&s, 4), 9033, "one slot before the season deadline"); rejects(&e.settle(&s), 9115, "Settle of an unfinished season");
        warp_to(&mut e, dl); rejects(&e.advance(&s, 1400, 1_400_000), 9113, "past the deadline"); rejects(&e.settle(&s), 9115, "a missed season is never settled by partial scores"); assert!(e.cancel_by(&s, 4).is_ok()); assert_eq!(e.data(&s.arena)[arx::REASON], 7); assert_eq!(e.data(&s.receipt)[rc::REASON], 7);
        e.assert_books(&s, 0); e.claim_all(&s); assert_eq!(bals(&e), start); rejects(&e.advance(&s, 1400, 1_400_000), 9114, "Advance after the cancel"); assert!(e.cleanup(&s).is_ok()); assert_eq!(rcf(&e, &s, rc::FORFEIT), 0); assert_eq!(rcf(&e, &s, rc::RELEASE), BOND); assert!(e.close_claims(&s).is_ok()); assert_eq!(e.lamports(&e.hub), hub0); }
    // once the season phase has finished, the deadline is gone: no refund, however long it takes to settle
    let mut e = Env::new(5); let s = e.full_season(167, &NAMES, 2, 10, false, 2, 14, true); e.warp(50_000_000); e.fresh_blockhash(); rejects(&e.cancel_by(&s, 4), 9033, "a finished season"); assert!(e.settle(&s).is_ok()); }
#[test] fn late_season_seed_is_refused_and_a_season_phase_answer_cannot_seed_the_finals() {
    let mut e = Env::new(5); e.params.seedto = 500; let mut s = open(&mut e, 168, 3, 10, true); assert!(e.lock(&s).is_ok()); let at = rd64(&e.data(&s.arena), arx::LOCKAT); assert!(e.request_seed(&s).is_ok()); warp_to(&mut e, at + 500); rejects(&e.deliver_seed(&mut s, seed_of(2)), 9112, "a season seed at its timeout");
    let mut e = Env::new(5); let mut s = to_finals(&mut e, 169, 3, 15); assert!(e.deliver_finals_seed(&mut s, seed_of(3)).is_err(), "a finals answer before any finals request"); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, seed_of(4)).is_err(), "the season-phase callback is not accepted as the finals seed"); assert!(e.deliver_finals_seed(&mut s, seed_of(5)).is_ok()); assert!(e.deliver_finals_seed(&mut s, seed_of(6)).is_err(), "a second finals answer"); }
#[test] fn creation_bond_and_parameter_guards() {
    let mut e = Env::new(5); let s = e.season(170); rejects(&e.init_receipt_bond(&s, 1_000_000 - 1), 9050, "a bond below the minimum"); assert!(e.init_receipt_bond(&s, BOND).is_ok());
    // a stranger cannot open the arena against someone else's bond
    let mut s1 = s.clone(); e.provision_if_new(s1.arena, arena_size(20)); { let kp = e.player(2); let mut ix = e.create_season_ix(&s1, 2, 1, 10, 20, 0, 2); ix.accounts[0] = e.m(kp.pubkey(), true, false); rejects(&e.send(&[ix], &[&kp]), 9052, "CreateSeason by a wallet that did not post the bond"); }
    e.provision_side(&s1, 20);
    for (label, neps, spt, flags, code) in [("zero episodes", 0u32, 1u32, 0u8, 9100u32), ("101 episodes", 101, 1, 0, 9100), ("zero slots per tick", 2, 0, 0, 9101), ("101 slots per tick", 2, 101, 0, 9101), ("paced run over the bound", 100, 49, 0, 9102), ("an unknown season flag", 2, 1, 1, 9103), ("another unknown flag", 2, 1, 130, 9103)] { let ix = e.create_season_ix(&s1, neps, spt, 10, 20, flags, 2); rejects(&e.send(&[ix], &[]), code, label); }
    for (label, w, sd, g, m, maxs) in [("seed timeout over its bound", 10u64, MAX_SEEDTO + 1, MIN_GRACE, 1u8, 20u8), ("window 0", 0, 10, MIN_GRACE, 1, 20), ("seed timeout 0", 10, 0, MIN_GRACE, 1, 20), ("grace over its cap", 10, 10, MAX_GRACE + 1, 1, 20), ("min 0", 10, 10, MIN_GRACE, 0, 20), ("min above max", 10, 10, MIN_GRACE, 5, 4), ("window absurd", MAX_W + 1, 10, MIN_GRACE, 1, 20)] {
        e.params = Params { window: w, seedto: sd, grace: g, mins: m, bond: BOND }; let ix = e.create_season_ix(&s1, 2, 1, 10, maxs, 0, 2); e.fresh_blockhash(); rejects(&e.send(&[ix], &[]), 9035, label); }
    // the claims account must be this season's
    e.params = Params { window: 1_000_000, seedto: 1_000_000, grace: 1_000_000, mins: 1, bond: BOND }; { let mut other = s1.clone(); other.claims = e.claims_pda(999); e.provision_side(&other, 20); let ix = e.create_season_ix(&other, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9082, "another season's claims account"); }
    assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s1, 2, 10, 20, false, 2).is_ok());
    // one receipt opens one arena: the season id cannot be created twice against the same bond
    let ix = e.create_season_ix(&s1, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9051, "a second CreateSeason on an opened receipt");
    // a receipt that does not carry its bond (lamports drained) is refused
    let mut e = Env::new(5); let s = e.season(171); assert!(e.init_receipt(&s).is_ok()); let lam = e.lamports(&s.receipt); e.svm.set_account(s.receipt, { let mut acc = e.svm.get_account(&s.receipt).unwrap(); acc.lamports = lam - BOND + 1; acc }).unwrap(); e.provision_if_new(s.arena, arena_size(20));
    e.provision_side(&s, 20); let ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9053, "an unfunded bond");
    // entry window: no entering once it has closed
    let mut e = Env::new(5); e.params.window = 100; let mut s = e.season(172); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); let st = e.register_and_seal(0, "a", code_of("Mom20th")); let st2 = e.register_and_seal(1, "b", code_of("EMAcross"));
    assert!(e.enter(&mut s, &st).is_ok()); e.warp(100); e.fresh_blockhash(); rejects(&e.enter(&mut s, &st2), 9030, "Enter after the window");
    // cancel guards: not once seeded
    let mut e = Env::new(5); let mut s = open(&mut e, 173, 2, 10, false); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, [5; 32]).is_ok()); e.warp(1_000); e.fresh_blockhash(); rejects(&e.cancel_by(&s, 4), 9033, "Cancel of a running season inside its deadline");
}
const MAX_W: u64 = MAX_ENTRY_WINDOW;


// ---- review change 1: the season carries at least as much weight as the finals ----
#[test] fn a_finals_season_is_at_least_as_long_as_the_finals_and_the_run_bound_covers_both_phases() {
    let mut e = Env::new(5);
    let try_create = |e: &mut Env, sid: u64, neps: u32, spt: u32, finals: bool| -> Option<u32> { let s = e.season(sid); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_side(&s, 20); let ix = e.create_season_ix(&s, neps, spt, 10, 20, if finals { 2 } else { 0 }, 2); let r = e.send(&[ix], &[]); if r.is_ok() { None } else { Some(custom(&r).unwrap_or(0)) } };
    for (n, neps) in (1..FINALS_EPISODES).enumerate() { assert_eq!(try_create(&mut e, 600 + n as u64, neps, 1, true), Some(9104), "{} season episodes with 15 finals episodes", neps); }
    assert_eq!(try_create(&mut e, 620, FINALS_EPISODES, 1, true), None, "equal weight is allowed"); assert_eq!(try_create(&mut e, 621, 1, 1, false), None, "without finals a one-episode season stays allowed");
    // the 720,000-slot run bound counts both phases
    for (sid, neps, spt, finals, want) in [(630u64, 33u32, 100u32, true, None), (631, 34, 100, true, Some(9102)), (632, 48, 100, false, None), (633, 49, 100, false, Some(9102)), (634, 100, 41, true, None), (635, 100, 42, true, Some(9102)), (636, 100, 48, false, None)] {
        assert_eq!(try_create(&mut e, sid, neps, spt, finals), want, "{} episodes at {} slots per tick, finals {}", neps, spt, finals); }
}
// ---- review change 2: creator-chosen waits are capped, and the refund path still works at the caps ----
#[test] fn the_creators_waits_are_capped_and_a_creator_at_the_caps_still_cannot_keep_buy_ins() {
    let mut e = Env::new(5);
    for (sid, window, seedto, ok) in [(640u64, MAX_ENTRY_WINDOW + 1, 10u64, false), (641, 200_000_000, 10, false), (642, 10, MAX_SEEDTO + 1, false), (643, MAX_ENTRY_WINDOW, MAX_SEEDTO, true)] {
        e.params.window = window; e.params.seedto = seedto; let s = e.season(sid); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_side(&s, 20); let ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); let r = e.send(&[ix], &[]); if ok { assert!(r.is_ok(), "at the caps: {}", err_string(&r)); } else { rejects(&r, 9035, "over a cap"); } }
    // the worst the creator can do: both waits at their caps, then walk away. A stranger gets every buy-in back as soon as the two waits have passed
    let start = bals(&e); let s = open(&mut e, 650, 3, 10, false); let created = rd64(&e.data(&s.arena), arx::CREATED);
    warp_to(&mut e, created + MAX_ENTRY_WINDOW - 1); rejects(&e.lock_by(&s, 4), 9032, "inside the window"); warp_to(&mut e, created + MAX_ENTRY_WINDOW); assert!(e.lock_by(&s, 4).is_ok(), "anyone locks when the window ends");
    let locked = rd64(&e.data(&s.arena), arx::LOCKAT); warp_to(&mut e, locked + MAX_SEEDTO - 1); rejects(&e.cancel_by(&s, 4), 9033, "inside the seed timeout"); warp_to(&mut e, locked + MAX_SEEDTO); assert!(e.cancel_by(&s, 4).is_ok(), "anyone cancels"); e.claim_all(&s); assert_eq!(bals(&e), start, "every buy-in is back"); e.assert_books(&s, 0);
    assert_eq!(e.slot - created, MAX_ENTRY_WINDOW + MAX_SEEDTO);
    // the longest possible path from creation to a guaranteed exit, over every season the bounds allow: window + seed timeout + season deadline (+ finals seed wait + finals deadline)
    let mut worst = 0u64; for finals in [false, true] { for neps in if finals { FINALS_EPISODES } else { 1 }..=MAX_EPISODES { for spt in 1..=MAX_SPT { if (u64::from(neps) + if finals { u64::from(FINALS_EPISODES) } else { 0 }) * 150 * u64::from(spt) > MAX_RUN_SLOTS { continue; } let mut t = MAX_ENTRY_WINDOW + MAX_SEEDTO + phase_deadline(0, neps, spt); if finals { t += FINALS_SEEDTO + phase_deadline(0, FINALS_EPISODES, spt); } worst = worst.max(t); } } }
    println!("WAITS longest creation-to-guaranteed-exit: {} slots = {:.2} days at 103.5 slots/s", worst, worst as f64 / 103.5 / 86400.0); assert!(worst as f64 / 103.5 / 86400.0 < 3.5, "a few days at most");
}
// ---- the CloseClaims guard: it can never strand a claimant ----
#[test] fn close_claims_refuses_while_any_entry_is_still_unclaimed() {
    // a settled season where all three entrants are owed, and a cancelled one: leave each entry in turn as the only unclaimed one
    for refund in [false, true] { for left in 0..3usize {
        let mut e = Env::new(5); let mut s = open(&mut e, 660, 3, 10, false);
        if refund { assert!(e.cancel(&s).is_ok()); } else { assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, seed_of(5)).is_ok()); e.drive(&s, 1400, 1_400_000); assert!(e.settle(&s).is_ok()); }
        rejects(&e.close_claims(&s), 9083, "nothing claimed yet");
        for i in 0..3 { if i != left { assert!(e.claim(&s, i).is_ok()); rejects(&e.close_claims(&s), 9083, "something still unclaimed"); } }
        let owed = e.owed(&s, left); assert!(owed > 0, "the entry left behind is owed money"); { let kp = e.player(4); let ix = e.close_claims_ix(&s, kp.pubkey()); rejects(&e.send(&[ix], &[&kp]), 9083, "by a stranger, one entry unclaimed"); }
        e.warp(2_000_000_000); rejects(&e.close_claims(&s), 9083, "no expiry: years later it still refuses"); e.assert_books(&s, 0); assert_eq!(pool_bal(&e, &s), owed);
        assert!(e.claim(&s, left).is_ok(), "the late claimant is paid in full"); assert!(e.close_claims(&s).is_ok(), "only now can it close");
    } }
    // both halves of the check hold on their own: lie in either the totals or one entry's flag and it still refuses
    let mut e = Env::new(5); let mut s = open(&mut e, 661, 3, 10, false); assert!(e.cancel(&s).is_ok()); e.claim_all(&s);
    set64(&mut e, &s.claims, cl::CLAIMED, 29); rejects(&e.close_claims(&s), 9083, "every entry flagged paid but the total is short"); set64(&mut e, &s.claims, cl::CLAIMED, 30);
    e.set_data(&s.claims, |d| d[cl::HDR + 2 * cl::ESZ + cl::E_DONE] = 0); rejects(&e.close_claims(&s), 9083, "the total is full but one entry is not marked paid"); e.set_data(&s.claims, |d| d[cl::HDR + 2 * cl::ESZ + cl::E_DONE] = 1); assert!(e.close_claims(&s).is_ok()); let _ = &mut s;
}

// ---- the shortest publish grace ----
#[test] fn the_publish_grace_has_a_floor_so_cleanup_cannot_drop_results_right_after_settle() {
    assert_eq!(MIN_GRACE, 180_000); let mut e = Env::new(5);
    for (n, (grace, finals, want)) in [(0u64, false, Some(9105u32)), (1, false, Some(9105)), (600, true, Some(9105)), (MIN_GRACE - 1, false, Some(9105)), (MIN_GRACE - 1, true, Some(9105)), (MIN_GRACE, false, None), (MIN_GRACE, true, None), (MAX_GRACE, false, None), (MAX_GRACE + 1, false, Some(9035))].into_iter().enumerate() {
        e.params.grace = grace; let s = e.season(680 + n as u64); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_side(&s, 20); let hub = e.lamports(&e.hub); let ix = e.create_season_ix(&s, if finals { 15 } else { 2 }, 1, 10, 20, if finals { 2 } else { 0 }, 2); let r = e.send(&[ix], &[]);
        match want { None => assert!(r.is_ok(), "grace {}: {}", grace, err_string(&r)), Some(c) => { rejects(&r, c, &format!("grace {}", grace)); assert_eq!((e.data(&s.receipt)[rc::STATE], e.lamports(&e.hub)), (0, hub), "a refused creation leaves the receipt unopened") } } }
}

