//! Money safety in the season lifecycle: time-based lock, seed timeout, cancel and exact refund, minimum entrants, creation bond, hub reconciliation,
//! the leaked-arena recovery, force publish at settle, and the pool-solvency assertions. All through the real program bytecode.
mod common;
use common::*;
use solana_instruction::AccountMeta;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn open(e: &mut Env, sid: u64, n: usize, fee: u64, finals: bool) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); let r = e.create_season(&mut s, 2, fee, 20, finals, 2); assert!(r.is_ok(), "CreateSeason {}", err_string(&r));
    for i in 0..n { let nm = NAMES[i % 5]; let st = e.register_and_seal(i % e.players.len(), nm, code_of(nm)); let r = e.enter(&mut s, &st); assert!(r.is_ok(), "Enter {} {}", i, err_string(&r)); } s }
fn bals(e: &Env) -> Vec<u64> { e.players.iter().map(|p| e.balance(&p.pubkey())).collect() }
fn f2(e: &Env, s: &Season) -> u8 { e.data(&s.arena)[ar::F2] }
fn rcf(e: &Env, s: &Season, off: usize) -> u64 { rd64(&e.data(&s.receipt), off) }
fn pool_bal(e: &Env, s: &Season) -> u64 { rd64(&e.data(&e.ata(&s.pool)), 64) }
fn rejects(r: &Res, code: u32, what: &str) { assert_eq!(custom(r), Some(code), "{}: expected Custom {}, got {}", what, code, err_string(r)); }
fn errs(r: &Res, what: &str) { assert!(r.is_err() && !failed_to_complete(r), "{} should be refused with an error, got {}", what, err_string(r)); }
fn set64(e: &mut Env, k: &Address, off: usize, v: u64) { e.set_data(k, |d| d[off..off + 8].copy_from_slice(&v.to_le_bytes())); }

#[test] fn happy_path_force_publish_cleanup_and_bond_release() {
    let mut e = Env::new(5); let start = bals(&e); let hub0 = e.lamports(&e.hub);
    let s = e.full_season(100, &NAMES, 2, 10, false, 2, 7, true);
    let early = e.release_bond(&s); rejects(&early, 9054, "ReleaseBond before the season is closed");
    // Settle publishes every entry inline: 5 strat+registry pairs appended
    let r = e.settle_publishing(&s, 5); assert!(r.is_ok(), "Settle with inline publish: {}", err_string(&r));
    assert_eq!(e.data(&s.arena)[ar::PUBN], 5, "all five published by the settle itself"); assert_eq!(e.data(&s.receipt)[rc::PUB], 5);
    // payouts exact, unchanged by the new guards: pot 50 -> 25 / 15 / 10
    let (host, _) = replay(&s, &s.entries); let mut ord: Vec<usize> = (0..5).collect(); ord.sort_by(|&x, &y| host[y].cmp(&host[x]).then(x.cmp(&y)));
    let mut want = vec![-10i64; 5]; for (k, &i) in ord.iter().take(3).enumerate() { want[i] += [25i64, 15, 10][k]; } for i in 0..5 { assert_eq!(e.balance(&e.players[i].pubkey()) as i64 - start[i] as i64, want[i], "owner {}", i); }
    assert_eq!(pool_bal(&e, &s), 0, "the pool is paid out to the unit");
    for i in 0..5 { assert!(e.publish(&s, i).is_err(), "an inline-published entry cannot be published twice"); }
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
    let mut e = Env::new(5); e.params.grace = 5_000; let s = e.full_season(101, &NAMES, 2, 10, false, 2, 3, true);
    assert!(e.settle_publishing(&s, 2).is_ok()); assert_eq!(e.data(&s.arena)[ar::PUBN], 2);
    errs(&e.cleanup(&s), "Cleanup with entries unpublished inside the grace");
    for i in 2..5 { assert!(e.publish(&s, i).is_ok()); } assert!(e.cleanup(&s).is_ok(), "all published: cleanup");
    // nobody publishes: after the grace the season can still be closed, it cannot stay half-published forever
    let s2 = e.full_season(102, &NAMES, 2, 10, false, 2, 4, true); assert!(e.settle(&s2).is_ok()); errs(&e.cleanup(&s2), "Cleanup before the grace with nothing published"); e.warp(4_999); e.fresh_blockhash(); errs(&e.cleanup(&s2), "Cleanup one slot early");
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
    assert_eq!(bals(&e), start, "every entrant has exactly their fee back"); assert_eq!(pool_bal(&e, &s), 0); assert_eq!(rd64(&e.data(&s.arena), ar::POOL), 0);
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
    let r = e.cancel_by(&s, 4); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(bals(&e), start, "both entrants refunded in full"); assert_eq!(pool_bal(&e, &s), 0);
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
    // 3) the canary's leaked arena was created by the OLD program: its header has none of the new fields and its receipt is the old size. It must still be recoverable.
    let mut e = Env::new(5); let hub0 = e.lamports(&e.hub); let mut s = e.season(132); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok());
    e.set_data(&s.arena, |d| for b in d[arx::CREATED..arx::REASON + 1].iter_mut() { *b = 0; }); // legacy layout
    let junk_receipt = Address::new_unique(); e.provision(junk_receipt, 1728); // an old-size, old-layout receipt: not a valid new receipt
    let legacy = |e: &mut Env, tag: u8, who: usize, extra: Vec<AccountMeta>| { let kp = e.player(who); let mut m = vec![e.m(kp.pubkey(), true, false)]; m.extend(extra); let ix = e.ix(tag, m, vec![]); e.send(&[ix], &[&kp]) };
    let m = vec![e.rw(s.arena)]; let r = legacy(&mut e, 7, 2, m); assert!(r.is_ok(), "a stranger locks the legacy empty arena (window 0): {}", err_string(&r)); assert_eq!(f2(&e, &s) & F2_CANCELLED, F2_CANCELLED);
    let m = vec![e.rw(s.arena), e.ro(s.pool), e.rw(e.ata(&s.pool)), e.ro(a(TOKEN)), e.rw(junk_receipt)]; let r = legacy(&mut e, 17, 2, m); assert!(r.is_ok(), "Cancel of the legacy arena: {}", err_string(&r));
    let m = vec![e.rw(e.hub), e.rw(s.arena), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(MAGIC)), e.ro(a(PERMISSION)), e.rw(junk_receipt)]; let r = legacy(&mut e, 15, 2, m); assert!(r.is_ok(), "Cleanup of the legacy arena: {}", err_string(&r));
    assert_eq!(e.lamports(&e.hub), hub0, "no bond on a legacy arena: nothing to reconcile, nothing lost");
}
#[test] fn hub_is_reconciled_against_the_bond_at_cleanup() {
    // the stand-in Magic program does not move lamports, so the draw is set on the arena the way the real create records it, and the close returns nothing: a full shortfall the bond must cover
    let mut e = Env::new(5); let hub0 = e.lamports(&e.hub); let s = e.full_season(140, &NAMES, 2, 10, false, 2, 5, true); set64(&mut e, &s.arena, arx::RENT, 300_000); assert!(e.settle_publishing(&s, 5).is_ok());
    assert!(e.cleanup(&s).is_ok()); assert_eq!(e.lamports(&e.hub) - hub0, 300_000, "the hub is topped up from the bond by exactly the shortfall"); assert_eq!(rcf(&e, &s, rc::RELEASE), BOND - 300_000); assert_eq!(rcf(&e, &s, rc::FORFEIT), 0); assert_eq!(rcf(&e, &s, rc::RECLAIMED), 0);
    // a draw bigger than the whole bond: the bond is spent, nothing underflows, the creator gets nothing back
    let mut e = Env::new(5); let hub0 = e.lamports(&e.hub); let s = e.full_season(141, &NAMES, 2, 10, false, 2, 5, true); set64(&mut e, &s.arena, arx::RENT, 5_000_000); assert!(e.settle_publishing(&s, 5).is_ok());
    let rl = e.lamports(&s.receipt); assert!(e.cleanup(&s).is_ok()); assert_eq!(e.lamports(&e.hub) - hub0, BOND); assert_eq!(rl - e.lamports(&s.receipt), BOND, "the whole bond went to the hub, the creator gets nothing back");
}
#[test] fn solvency_assertions_at_settle_and_cancel() {
    // a donation to the pool address cannot block a season; the surplus simply stays
    let mut e = Env::new(5); let s = e.full_season(150, &NAMES, 2, 10, false, 2, 6, true); let pata = e.ata(&s.pool); e.mint_to(&pata, 3); let r = e.settle(&s); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(pool_bal(&e, &s), 3, "only the donation is left");
    // a pool that holds less than it owes refuses to settle, and nothing moves
    let mut e = Env::new(5); let s = e.full_season(151, &NAMES, 2, 10, false, 2, 6, true); let pata = e.ata(&s.pool); let before = bals(&e); e.set_data(&pata, |d| d[64..72].copy_from_slice(&49u64.to_le_bytes()));
    rejects(&e.settle(&s), 9041, "an under-funded pool"); assert_eq!(bals(&e), before); assert_eq!(e.flags(&s) & F_SETTLED, 0); e.set_data(&pata, |d| d[64..72].copy_from_slice(&50u64.to_le_bytes())); assert!(e.settle(&s).is_ok(), "restored pool settles");
    // the pool bookkeeping must equal fee x entrants exactly
    let mut e = Env::new(5); let s = e.full_season(152, &NAMES, 2, 10, false, 2, 6, true); let p = rd64(&e.data(&s.arena), ar::POOL); set64(&mut e, &s.arena, ar::POOL, p + 1); rejects(&e.settle(&s), 9040, "bookkeeping off by one"); set64(&mut e, &s.arena, ar::POOL, p); assert!(e.settle(&s).is_ok());
    // the same assertions guard refunds
    let mut e = Env::new(5); e.params.seedto = 100; let s = open(&mut e, 153, 3, 10, false); assert!(e.lock(&s).is_ok()); e.warp(100); e.fresh_blockhash(); let pata = e.ata(&s.pool); let before = bals(&e);
    e.set_data(&pata, |d| d[64..72].copy_from_slice(&29u64.to_le_bytes())); rejects(&e.cancel_by(&s, 4), 9041, "refund from an under-funded pool"); assert_eq!(bals(&e), before); assert_eq!(f2(&e, &s) & (F2_CANCELLED | F2_REFUNDED), 0, "a failed refund leaves no half-state");
    e.set_data(&pata, |d| d[64..72].copy_from_slice(&30u64.to_le_bytes())); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok());
    // donations on top of a cancelled season stay in the pool and the refunds are still exactly the fees
    let mut e = Env::new(5); e.params.seedto = 100; let start = bals(&e); let s = open(&mut e, 154, 3, 10, false); let pata = e.ata(&s.pool); e.mint_to(&pata, 7); assert!(e.lock(&s).is_ok()); e.warp(100); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok()); assert_eq!(bals(&e), start); assert_eq!(pool_bal(&e, &s), 7);
}
#[test] fn voided_finals_pay_the_reserve_to_the_parent_champion() {
    let mut e = Env::new(5); e.params.seedto = 400; let start = bals(&e); let s = e.full_season(160, &NAMES, 2, 10, true, 2, 8, true); assert!(e.settle_publishing(&s, 5).is_ok());
    let (host, _) = replay(&s, &s.entries); let mut ord: Vec<usize> = (0..5).collect(); ord.sort_by(|&x, &y| host[y].cmp(&host[x]).then(x.cmp(&y))); let champ = s.entries[ord[0]].owner;
    let before_champ = e.balance(&e.players[champ].pubkey()); assert_eq!(rd64(&e.data(&s.arena), ar::RESERVE), 10, "20% of 50 is held for the finals");
    let (r, mut f) = e.start_finals(&s, 161, 3, 3); assert!(r.is_ok(), "{}", err_string(&r)); f.entries = ord.iter().take(3).map(|&i| s.entries[i].clone()).collect(); f.entries.sort_by_key(|x| s.entries.iter().position(|y| y.id == x.id).unwrap());
    assert!(e.request_seed(&f).is_ok()); let cancel = |e: &mut Env, f: &Season, parent: &Season| { let kp = e.player(4); let ix = e.cancel_ix(f, kp.pubkey(), parent.pool, &f.entries); e.send(&[ix], &[&kp]) };
    rejects(&cancel(&mut e, &f, &s), 9033, "finals cancel before the timeout"); e.warp(400); e.fresh_blockhash(); let r = cancel(&mut e, &f, &s); assert!(r.is_ok(), "finals void: {}", err_string(&r));
    assert_eq!(e.balance(&e.players[champ].pubkey()) - before_champ, 10, "the champion takes the whole reserve"); assert_eq!(pool_bal(&e, &s), 0, "nothing is left in the pool"); assert_eq!(e.data(&f.receipt)[rc::REASON], 4);
    let _ = start; assert!(e.cleanup(&f).is_ok()); assert_eq!(rcf(&e, &f, rc::FORFEIT), 0, "a voided finals is not abandonment"); assert!(e.cleanup(&s).is_ok());
}
#[test] fn creation_bond_and_parameter_guards() {
    let mut e = Env::new(5); let s = e.season(170); rejects(&e.init_receipt_bond(&s, 1_000_000 - 1), 9050, "a bond below the minimum"); assert!(e.init_receipt_bond(&s, BOND).is_ok());
    // a stranger cannot open the arena against someone else's bond
    let mut s1 = s.clone(); e.provision_if_new(s1.arena, arena_size(20)); { let kp = e.player(2); let mut ix = e.create_season_ix(&s1, 2, 1, 10, 20, 0, 2); ix.accounts[0] = e.m(kp.pubkey(), true, false); rejects(&e.send(&[ix], &[&kp]), 9052, "CreateSeason by a wallet that did not post the bond"); }
    for (label, w, sd, g, m, maxs) in [("window 0", 0u64, 10u64, 10u64, 1u8, 20u8), ("seed timeout 0", 10, 0, 10, 1, 20), ("grace 0", 10, 10, 0, 1, 20), ("min 0", 10, 10, 10, 0, 20), ("min above max", 10, 10, 10, 5, 4), ("window absurd", MAX_W + 1, 10, 10, 1, 20)] {
        e.params = Params { window: w, seedto: sd, grace: g, mins: m, bond: BOND }; let ix = e.create_season_ix(&s1, 2, 1, 10, maxs, 0, 2); rejects(&e.send(&[ix], &[]), 9035, label); }
    e.params = Params { window: 1_000_000, seedto: 1_000_000, grace: 1_000_000, mins: 1, bond: BOND }; assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s1, 2, 10, 20, false, 2).is_ok());
    // one receipt opens one arena: the season id cannot be created twice against the same bond
    let ix = e.create_season_ix(&s1, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9051, "a second CreateSeason on an opened receipt");
    // a receipt that does not carry its bond (lamports drained) is refused
    let mut e = Env::new(5); let s = e.season(171); assert!(e.init_receipt(&s).is_ok()); let lam = e.lamports(&s.receipt); e.svm.set_account(s.receipt, { let mut acc = e.svm.get_account(&s.receipt).unwrap(); acc.lamports = lam - BOND + 1; acc }).unwrap(); e.provision_if_new(s.arena, arena_size(20));
    let ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9053, "an unfunded bond");
    // entry window: no entering once it has closed
    let mut e = Env::new(5); e.params.window = 100; let mut s = e.season(172); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); let st = e.register_and_seal(0, "a", code_of("Mom20th")); let st2 = e.register_and_seal(1, "b", code_of("EMAcross"));
    assert!(e.enter(&mut s, &st).is_ok()); e.warp(100); e.fresh_blockhash(); rejects(&e.enter(&mut s, &st2), 9030, "Enter after the window");
    // cancel guards: not once seeded
    let mut e = Env::new(5); let mut s = open(&mut e, 173, 2, 10, false); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, [5; 32]).is_ok()); e.warp(2_000_000); e.fresh_blockhash(); rejects(&e.cancel_by(&s, 4), 9033, "Cancel of a seeded season");
}
const MAX_W: u64 = 200_000_000;
