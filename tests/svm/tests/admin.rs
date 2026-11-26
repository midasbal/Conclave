//! Access guards and admin recovery: the pause, the stake-mint allowlist, authority control, InitConfig, and the stranded-bond recovery.
mod common;
use common::*;
use solana_account::Account;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn open(e: &mut Env, sid: u64, n: usize, fee: u64) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); let r = e.create_season(&mut s, 2, fee, 20, false, 2); assert!(r.is_ok(), "CreateSeason {}", err_string(&r));
    for i in 0..n { let nm = NAMES[i % 5]; let st = e.register_and_seal(i % e.players.len(), nm, code_of(nm)); let r = e.enter(&mut s, &st); assert!(r.is_ok(), "Enter {}", err_string(&r)); } s }
fn bals(e: &Env) -> Vec<u64> { e.players.iter().map(|p| e.balance(&p.pubkey())).collect() }
fn rejects(r: &Res, code: u32, what: &str) { assert_eq!(custom(r), Some(code), "{}: expected Custom {}, got {}", what, code, err_string(r)); }
fn cfgb(e: &Env) -> Vec<u8> { e.data(&e.config) }
const C_PAUSED: usize = 4; const C_NMINTS: usize = 5; const C_AUTH: usize = 8;

#[test] fn pause_stops_new_risk_and_never_traps_a_live_season() {
    let mut e = Env::new(5); e.params.seedto = 100; let start = bals(&e);
    let a = e.full_season(200, &NAMES, 2, 10, false, 2, 3, true);                      // done, waiting for settlement
    let b = open(&mut e, 201, 3, 10); assert!(e.lock(&b).is_ok()); assert!(e.request_seed(&b).is_ok()); // locked, seed never arrives
    let mut c = open(&mut e, 202, 1, 10);                                              // open arena with room, one entrant
    let late = e.register_and_seal(3, "late", code_of("Mom20th")); let fresh = e.season(203); assert!(e.init_pool(&fresh).is_ok());
    // pause: only the authority may
    let outsider = e.player(1); rejects(&e.admin_by(&outsider, 0, &[]), 9062, "a stranger pausing"); assert_eq!(cfgb(&e)[C_PAUSED], 0);
    e.admin_ok(0, &[]); assert_eq!(cfgb(&e)[C_PAUSED], 1);
    // new risk is refused: a new season and a new entry
    let mut f2 = fresh.clone(); rejects(&e.create_season(&mut f2, 2, 10, 20, false, 2), 9060, "CreateSeason while paused"); rejects(&e.enter(&mut c, &late), 9060, "Enter while paused");
    // everything that unwinds a live season still works
    let r = e.settle_publishing(&a, 3); assert!(r.is_ok(), "Settle while paused: {}", err_string(&r)); e.claim_all(&a); assert!(e.close_claims(&a).is_ok(), "Claim and CloseClaims while paused"); for i in 3..5 { assert!(e.publish(&a, i).is_ok(), "Publish while paused"); } assert!(e.cleanup(&a).is_ok(), "Cleanup while paused");
    e.warp(100); e.fresh_blockhash(); let pre = bals(&e); let r = e.cancel_by(&b, 4); assert!(r.is_ok(), "Cancel (seed timeout) while paused: {}", err_string(&r)); e.claim_all(&b); assert!(e.cleanup(&b).is_ok(), "Cleanup of the cancelled season while paused"); let mid = bals(&e); for i in 0..3 { assert_eq!(mid[i] - pre[i], 10, "entrant {} refunded exactly while paused", i); }
    let r = e.cancel(&c); assert!(r.is_ok(), "creator Cancel (refund) while paused: {}", err_string(&r)); e.claim_all(&c);
    let bl = bals(&e); assert_eq!(bl[0] - mid[0], 10, "the creator-cancelled season refunded its entrant exactly"); let _ = start;
    // the finals phase runs to the end while paused too: transition, finals seed, both runs, Settle and Claim
    e.admin_ok(1, &[]); let mut f = e.season(204); assert!(e.init_pool(&f).is_ok()); assert!(e.create_season(&mut f, 15, 10, 20, true, 2).is_ok()); for i in 0..3 { let st = e.register_and_seal(i, NAMES[i], code_of(NAMES[i])); assert!(e.enter(&mut f, &st).is_ok()); } e.admin_ok(0, &[]); assert!(e.lock(&f).is_ok()); assert!(e.request_seed(&f).is_ok()); assert!(e.deliver_seed(&mut f, seed_of(4)).is_ok()); e.drive(&f, 1400, 1_400_000); e.run_finals(&mut f, 4); assert!(e.settle(&f).is_ok(), "two-phase settle while paused"); e.claim_all(&f); e.assert_books(&f, 0);
    // unpause: new seasons and entries work again
    e.admin_ok(1, &[]); assert_eq!(cfgb(&e)[C_PAUSED], 0); let r = e.create_season(&mut f2, 2, 10, 20, false, 2); assert!(r.is_ok(), "{}", err_string(&r)); let r = e.enter(&mut f2, &late); assert!(r.is_ok(), "{}", err_string(&r));
}
#[test] fn authority_is_stored_and_movable() {
    let mut e = Env::new(5); assert_eq!(&cfgb(&e)[C_AUTH..C_AUTH + 32], e.payer.pubkey().as_ref(), "the upgrade authority is the first config authority");
    let p2 = e.player(2); let new = p2.pubkey(); e.admin_ok(4, new.as_ref()); assert_eq!(&cfgb(&e)[C_AUTH..C_AUTH + 32], new.as_ref());
    rejects(&e.admin(0, &[]), 9062, "the old authority after the hand-over"); assert!(e.admin_by(&p2, 0, &[]).is_ok(), "the new authority pauses"); assert_eq!(cfgb(&e)[C_PAUSED], 1); assert!(e.admin_by(&p2, 1, &[]).is_ok());
    assert!(e.admin_by(&p2, 4, &[0u8; 32]).is_err(), "the authority cannot be set to nothing"); assert!(e.admin_by(&p2, 9, &[]).is_err(), "unknown sub-command"); let q = e.player(3); rejects(&e.admin_by(&q, 4, q.pubkey().as_ref()), 9062, "a stranger taking over");
    // the config account must be the genuine one
    let ix = { let mut i = e.admin_ix(p2.pubkey(), 0, &[]); i.accounts[1] = e.rw(Address::new_unique()); i }; rejects(&e.send(&[ix], &[&p2]), 9063, "Admin on a fake config");
}
#[test] fn stake_mint_allowlist_accepts_and_rejects() {
    let mut e = Env::new(5); let real = e.mint; let other = Address::new_unique();
    let attempt = |e: &mut Env, sid: u64, mint: Address| -> Res { let s = e.season(sid); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_if_new(s.claims, claims_size(20)); let keep = e.mint; e.mint = mint; let ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); e.mint = keep; e.send(&[ix], &[]) };
    assert!(attempt(&mut e, 210, real).is_ok(), "the allowlisted mint is accepted"); rejects(&attempt(&mut e, 211, other), 9061, "a mint that is not on the list");
    e.admin_ok(2, other.as_ref()); assert_eq!(cfgb(&e)[C_NMINTS], 2); assert!(attempt(&mut e, 212, other).is_ok(), "after being allowed"); e.admin_ok(2, other.as_ref()); assert_eq!(cfgb(&e)[C_NMINTS], 2, "allowing twice is idempotent");
    e.admin_ok(3, other.as_ref()); assert_eq!(cfgb(&e)[C_NMINTS], 1); rejects(&attempt(&mut e, 213, other), 9061, "after being removed"); assert!(attempt(&mut e, 214, real).is_ok(), "the other mint is unaffected by the removal");
    assert!(e.admin(3, other.as_ref()).is_err(), "removing a mint that is not listed");
    for _ in 0..7 { let m = Address::new_unique(); e.admin_ok(2, m.as_ref()); } assert_eq!(cfgb(&e)[C_NMINTS], 8); rejects(&e.admin(2, Address::new_unique().as_ref()), 9064, "a ninth mint");
    // only the authority edits the list
    let q = e.player(1); rejects(&e.admin_by(&q, 2, other.as_ref()), 9062, "a stranger editing the allowlist");
    // a fake config cannot be slipped in to bypass the list or the pause
    let s = e.season(215); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_if_new(s.claims, claims_size(20)); let mut ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); ix.accounts[8] = e.rw(Address::new_unique()); rejects(&e.send(&[ix], &[]), 9063, "CreateSeason with a fake config");
    let mut s2 = open(&mut e, 216, 1, 10); let st = e.register_and_seal(2, "x", code_of("EMAcross")); let mut ix = e.enter_ix(&s2, &st, 2); ix.accounts[6] = e.ro(Address::new_unique()); let kp = e.player(2); rejects(&e.send(&[ix], &[&kp]), 9063, "Enter with a fake config"); let _ = &mut s2;
}
#[test] fn a_lookalike_config_at_another_address_is_refused() {
    // a program-owned account carrying a copy of the real config (same magic, a permissive allowlist, not paused) must not be accepted in place of the PDA
    let mut e = Env::new(5); let other = Address::new_unique(); let fake = Address::new_unique(); let mut d = e.data(&e.config); d[C_NMINTS] = 2; d[64 + 32..64 + 64].copy_from_slice(other.as_ref());
    e.svm.set_account(fake, Account { lamports: 1, data: d, owner: e.pid, executable: false, rent_epoch: 0 }).unwrap();
    let s = e.season(250); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); let keep = e.mint; e.mint = other; let mut ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); e.mint = keep; ix.accounts[8] = e.ro(fake);
    rejects(&e.send(&[ix], &[]), 9063, "a copy of the config at another address");
}
#[test] fn init_config_is_for_the_upgrade_authority_only() {
    let mut e = Env::new_with(5, false); let imposter = e.player(1); let pd = e.programdata_fixture(&e.payer.pubkey());
    let ix = e.init_config_ix(pd, imposter.pubkey()); rejects(&e.send(&[ix], &[&imposter]), 9062, "a wallet that is not the upgrade authority");
    let fake = Address::new_unique(); e.svm.set_account(fake, Account { lamports: 1, data: vec![0; 64], owner: a(LOADER), executable: false, rent_epoch: 0 }).unwrap(); let ix = e.init_config_ix(fake, e.payer.pubkey()); rejects(&e.send(&[ix], &[]), 9062, "a ProgramData account that is not this program's");
    e.set_data(&pd, |d| d[12] = 0); let ix = e.init_config_ix(pd, e.payer.pubkey()); rejects(&e.send(&[ix], &[]), 9062, "an immutable program (no upgrade authority)"); let _ = e.programdata_fixture(&e.payer.pubkey());
    let ix = e.init_config_ix(pd, e.payer.pubkey()); assert!(e.send(&[ix], &[]).is_ok(), "the upgrade authority creates the config"); assert_eq!(&cfgb(&e)[C_AUTH..C_AUTH + 32], e.payer.pubkey().as_ref()); assert_eq!(cfgb(&e)[C_NMINTS], 0, "no mint is allowed until the authority allows one");
    let ix = e.init_config_ix(pd, e.payer.pubkey()); assert!(e.send(&[ix], &[]).is_err(), "the config cannot be created twice");
    // with an empty allowlist nothing can be created
    let s = e.season(220); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_if_new(s.claims, claims_size(20)); let ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9061, "empty allowlist");
}

// ---- stranded-bond recovery ----
fn recover_ix(e: &Env, signer: Address, sid: u64, rc: Address, arena: Address) -> solana_instruction::Instruction { e.ix(21, vec![e.m(signer, true, signer == e.payer.pubkey()), e.ro(e.config), e.rw(rc), e.ro(arena)], sid.to_le_bytes().to_vec()) }
fn gone(e: &mut Env, k: Address) { e.svm.set_account(k, Account { lamports: 0, data: vec![], owner: a(SYSTEM), executable: false, rent_epoch: 0 }).unwrap(); } // how a closed ephemeral account looks inside the rollup
fn stranded(e: &mut Env, sid: u64) -> Season { // a season the old binary left behind: settled, published, arena closed, receipt never opened/closed (state 0), creator recorded
    let s = e.full_season(sid, &NAMES, 2, 10, false, 2, 5, true); assert!(e.settle_publishing(&s, 5).is_ok()); assert!(e.cleanup(&s).is_ok()); e.set_data(&s.receipt, |d| { d[rc::STATE] = 0; d[rc::RELEASE..rc::RELEASE + 8].fill(0); d[rc::FORFEIT..rc::FORFEIT + 8].fill(0); }); gone(e, s.arena); s }
#[test] fn bond_recovery_refuses_every_live_or_fresh_case() {
    let mut e = Env::new(5); let pay = e.payer.pubkey();
    // (a) a live season: arena exists, bond in use
    let live = e.full_season(230, &NAMES, 2, 10, false, 2, 5, true); assert!(e.settle_publishing(&live, 5).is_ok()); let ix = recover_ix(&e, pay, 230, live.receipt, live.arena); rejects(&e.send(&[ix], &[]), 9070, "a season whose arena is still live");
    // (b) a running season that has not settled (header not written, arena live)
    let mut run = e.season(231); assert!(e.init_pool(&run).is_ok()); assert!(e.create_season(&mut run, 2, 10, 20, false, 2).is_ok()); let ix = recover_ix(&e, pay, 231, run.receipt, run.arena); rejects(&e.send(&[ix], &[]), 9070, "an open season");
    // (c) a fresh, never-opened receipt whose arena does not exist yet
    let fresh = e.season(232); assert!(e.init_receipt(&fresh).is_ok()); let ix = recover_ix(&e, pay, 232, fresh.receipt, fresh.arena); rejects(&e.send(&[ix], &[]), 9070, "a fresh receipt (arena not created yet)");
    // (d) opened but the arena vanished before anything was written: still not orphaned by the rule (no settle or cancel header)
    let mut opened = e.season(233); assert!(e.init_pool(&opened).is_ok()); assert!(e.create_season(&mut opened, 2, 10, 20, false, 2).is_ok()); gone(&mut e, opened.arena); let ix = recover_ix(&e, pay, 233, opened.receipt, opened.arena); rejects(&e.send(&[ix], &[]), 9070, "opened receipt, no header written");
    // (e) already closed (state 2): the normal path owns it
    let done = e.full_season(234, &NAMES, 2, 10, false, 2, 5, true); assert!(e.settle_publishing(&done, 5).is_ok()); assert!(e.cleanup(&done).is_ok()); gone(&mut e, done.arena); assert_eq!(e.data(&done.receipt)[rc::STATE], 2); let ix = recover_ix(&e, pay, 234, done.receipt, done.arena); rejects(&e.send(&[ix], &[]), 9070, "an already closed receipt");
    // (f) the arena passed is some other season's, the receipt is not the season's, or the caller is not the authority
    let s = stranded(&mut e, 235); let other = e.season(236); let ix = recover_ix(&e, pay, 235, s.receipt, other.arena); rejects(&e.send(&[ix], &[]), 9070, "a different season's arena account"); let ix = recover_ix(&e, pay, 235, other.receipt, s.arena); rejects(&e.send(&[ix], &[]), 9070, "a different season's receipt");
    let q = e.player(1); let ix = recover_ix(&e, q.pubkey(), 235, s.receipt, s.arena); rejects(&e.send(&[ix], &[&q]), 9062, "a caller who is not the authority"); assert_eq!(e.data(&s.receipt)[rc::STATE], 0, "nothing changed");
    // a live bond is untouched by all of the above
    assert_eq!(e.data(&live.receipt)[rc::STATE], 1); assert_eq!(e.data(&run.receipt)[rc::STATE], 1);
}
#[test] fn bond_recovery_pays_the_creator_and_never_the_authority() {
    let mut e = Env::new(5); let pay = e.payer.pubkey(); let s = stranded(&mut e, 240); let creator = e.player(3); e.set_data(&s.receipt, |d| d[rc::CREATOR..rc::CREATOR + 32].copy_from_slice(creator.pubkey().as_ref()));
    rejects(&e.release_bond(&s), 9054, "ReleaseBond on a receipt that is not closed: the stranded state");
    rejects(&{ let kp = e.player(1); let ix = e.commit_undelegate_ix_for(&s); e.send(&[ix], &[&kp]) }, 9055, "undelegating the stranded receipt is refused until it is recovered");
    let (auth0, c0, rl0) = (e.lamports(&pay), e.lamports(&creator.pubkey()), e.lamports(&s.receipt));
    let ix = recover_ix(&e, pay, 240, s.receipt, s.arena); let r = e.send(&[ix], &[]); assert!(r.is_ok(), "recovery: {}", err_string(&r)); let fee = r.unwrap().fee;
    assert_eq!(e.data(&s.receipt)[rc::STATE], 2); assert_eq!(rcf(&e, &s, rc::RELEASE), BOND); assert_eq!(rcf(&e, &s, rc::FORFEIT), 0); assert_eq!(e.lamports(&s.receipt), rl0, "recovery itself moves no lamports"); assert_eq!(e.lamports(&pay), auth0 - fee, "the authority received nothing");
    assert!(e.commit_undelegate(&[s.receipt]).is_ok());
    // ReleaseBond pays only the creator recorded on the receipt, and only once
    let ix = e.release_bond_ix(&s, pay); rejects(&e.send(&[ix], &[]), 9054, "paying the authority instead of the creator");
    let ix = e.release_bond_ix(&s, creator.pubkey()); let r = e.send(&[ix], &[]); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(e.lamports(&creator.pubkey()) - c0, BOND, "the rightful creator gets the whole bond");
    let ix = e.release_bond_ix(&s, creator.pubkey()); let r = e.send(&[ix], &[]); assert!(r.is_err(), "no second payout"); assert_eq!(e.lamports(&creator.pubkey()) - c0, BOND);
    let ix = recover_ix(&e, pay, 240, s.receipt, s.arena); assert!(e.send(&[ix], &[]).is_err(), "and the closed receipt cannot be recovered again");
}
fn rcf(e: &Env, s: &Season, off: usize) -> u64 { rd64(&e.data(&s.receipt), off) }
