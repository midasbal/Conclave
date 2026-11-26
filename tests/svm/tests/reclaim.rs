//! Strategy reclaim and the open-entry guard, through the real program bytecode, with ephemeral rent applied from the CPIs the program really makes (see common/mod.rs, `model_rent`).
//! NOT modelled here: delegation. In the SVM a "delegated" registry stays owned by the program, so the Commit-and-undelegate step is checked only for what the program allows into it.
mod common;
use common::*;
use solana_instruction::{AccountMeta, Instruction};

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn env(n: usize) -> Env { let mut e = Env::new(n); e.model_rent(); e }
fn sealed(e: &mut Env, n: usize) -> Vec<Strat> { (0..n).map(|i| { let o = i % e.players.len(); e.register_and_seal(o, NAMES[i % 5], code_of(NAMES[i % 5])) }).collect() }
/// a season holding these strategies, still unlocked
fn open(e: &mut Env, sid: u64, sts: &[Strat], fee: u64, finals: bool) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); let r = e.create_season(&mut s, if finals { 15 } else { 2 }, fee, 20, finals, 2); assert!(r.is_ok(), "CreateSeason {}", err_string(&r)); for st in sts { let r = e.enter(&mut s, st); assert!(r.is_ok(), "Enter {}", err_string(&r)); } s }
fn start(e: &mut Env, s: &mut Season, byte: u8) { assert!(e.lock(s).is_ok()); assert!(e.request_seed(s).is_ok()); assert!(e.deliver_seed(s, seed_of(byte)).is_ok()); }
fn play(e: &mut Env, s: &mut Season, byte: u8) { start(e, s, byte); e.drive(s, 1400, 1_400_000); if e.in_finals(s) { e.run_finals(s, byte); } }
fn rejects(r: &Res, code: u32, what: &str) { assert_eq!(custom(r), Some(code), "{}: expected Custom {}, got {}", what, code, err_string(r)); }
fn errs(r: &Res, what: &str) { assert!(r.is_err() && !failed_to_complete(r), "{} should be refused with an error, got {}", what, err_string(r)); }
fn counts(e: &Env, sts: &[Strat]) -> Vec<u16> { sts.iter().map(|s| e.open_count(s.id)).collect() }
/// the owner's close is refused because an entry is open, and nothing at all changes
fn close_refused_open(e: &mut Env, st: &Strat, when: &str) { let (k, rk) = (e.strat_pda(st.id), e.reg_pda(st.id)); let (s0, r0, h0) = (e.data(&k), e.data(&rk), e.lamports(&e.hub)); let r = e.close_strategy(st); rejects(&r, 9130, when); assert_eq!((e.data(&k), e.data(&rk), e.lamports(&e.hub)), (s0, r0, h0), "{}: a refused close changes nothing", when); }
/// close succeeds: exactly this strategy's rent returns to the hub, the sealed account is gone, the registry is marked closed
fn close_ok(e: &mut Env, st: &Strat, rent: u64) { let k = e.strat_pda(st.id); let ow = e.players[st.owner].pubkey(); let (h0, v0, o0) = (e.lamports(&e.hub), e.vault_total(), e.lamports(&ow)); let r = e.close_strategy(st); assert!(r.is_ok(), "CloseStrategy: {}", err_string(&r));
    assert_eq!(e.lamports(&e.hub) - h0, rent, "the hub gets back exactly what it paid"); assert_eq!(v0 - e.vault_total(), rent); assert_eq!(e.lamports(&ow), o0, "the owner paid nothing for the sealed account and receives nothing for it"); assert!(e.svm.get_account(&k).map_or(true, |a| a.data.is_empty()), "the sealed account is gone"); assert_eq!(rd32(&e.data(&e.reg_pda(st.id)), 0), M_REG_CLOSED); }

#[test] fn the_rent_model_reproduces_what_devnet_showed() {
    assert_eq!(STRAT_RENT, 20_000); let mut e = env(5); let h = e.lamports(&e.hub); let st = sealed(&mut e, 1); assert_eq!(h - e.lamports(&e.hub), 20_000, "a new sealed strategy");
    let h = e.lamports(&e.hub); let s = open(&mut e, 1, &st, 0, false); assert_eq!(e.rent_held.as_ref().unwrap()[&(false, s.arena)] + e.rent_held.as_ref().unwrap()[&(true, s.arena)], 328_576, "a 20-seat arena and its permission"); assert_eq!(e.rent_held.as_ref().unwrap()[&(false, s.claims)], 34_944, "its claims account"); assert_eq!(h - e.lamports(&e.hub), 328_576 + 34_944);
}

// ================= the counter, on every path =================
#[test] fn the_count_goes_up_at_enter_and_down_at_publish_whether_inline_or_separate() {
    let mut e = env(5); let st = sealed(&mut e, 4); assert_eq!(counts(&e, &st), [0, 0, 0, 0]);
    let mut a_ = open(&mut e, 10, &st, 10, false); assert_eq!(counts(&e, &st), [1, 1, 1, 1]); for i in 0..4 { assert!(e.counted(&a_, i)); }
    let mut b = open(&mut e, 11, &st[..2], 10, false); assert_eq!(counts(&e, &st), [2, 2, 1, 1], "one per open entry, across seasons");
    play(&mut e, &mut a_, 1); assert_eq!(counts(&e, &st), [2, 2, 1, 1], "playing changes nothing");
    assert!(e.settle_publishing(&a_, 2).is_ok()); assert_eq!(counts(&e, &st), [1, 1, 1, 1], "Settle releases exactly the entries it published inline");
    for i in 2..4 { assert!(e.publish(&a_, i).is_ok()); assert!(!e.counted(&a_, i)); } assert_eq!(counts(&e, &st), [1, 1, 0, 0]);
    for i in 0..4 { e.fresh_blockhash(); rejects(&e.publish(&a_, i), 9120, "second publish"); } assert_eq!(counts(&e, &st), [1, 1, 0, 0], "a refused publish never decrements");
    assert!(e.cleanup(&a_).is_ok()); assert_eq!(counts(&e, &st), [1, 1, 0, 0], "Cleanup of a fully published season releases nothing");
    play(&mut e, &mut b, 2); assert!(e.settle(&b).is_ok()); for i in 0..2 { assert!(e.publish(&b, i).is_ok()); } assert_eq!(counts(&e, &st), [0, 0, 0, 0]);
}

#[test] fn cancel_releases_the_strategies_it_is_given_and_never_needs_them() {
    let mut e = env(5); let st = sealed(&mut e, 4); let before: Vec<u64> = e.players.iter().map(|p| e.balance(&p.pubkey())).collect();
    // all named: released by Cancel itself
    let s = open(&mut e, 20, &st, 10, false); let ids: Vec<u64> = st.iter().map(|x| x.id).collect(); let ix = e.with_strats(e.cancel_ix(&s, e.payer.pubkey()), &ids); let r = e.send(&[ix], &[]); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(counts(&e, &st), [0, 0, 0, 0]); for i in 0..4 { assert!(!e.counted(&s, i)); }
    assert!(e.cleanup(&s).is_ok()); assert_eq!(counts(&e, &st), [0, 0, 0, 0], "nothing is released twice");
    // none named: the refund goes through regardless and the arena keeps the record of what is still held
    let s2 = open(&mut e, 21, &st, 10, false); assert!(e.cancel(&s2).is_ok()); e.claim_all(&s2); assert_eq!(counts(&e, &st), [1, 1, 1, 1]); close_refused_open(&mut e, &st[0], "cancelled, not yet released");
    // some named, and one of them twice
    let s3 = open(&mut e, 22, &st, 10, false); let ix = e.with_strats(e.cancel_ix(&s3, e.payer.pubkey()), &[st[1].id, st[1].id, st[2].id]); let r = e.send(&[ix], &[]); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(counts(&e, &st), [2, 1, 1, 2], "a repeated account releases once");
    e.claim_all(&s); e.claim_all(&s3); for i in 0..5 { assert_eq!(e.balance(&e.players[i].pubkey()), before[i], "every fee refunded"); }
    assert!(e.cleanup(&s2).is_ok()); assert!(e.cleanup(&s3).is_ok()); assert_eq!(counts(&e, &st), [0, 0, 0, 0], "a cancelled season never leaves a count behind");
}

#[test] fn a_wrong_account_given_to_cancel_fails_that_transaction_only() {
    let mut e = env(5); let st = sealed(&mut e, 3); let s = open(&mut e, 25, &st[..2], 10, false);
    for (bad, what) in [(e.strat_pda(st[2].id), "a strategy this season does not hold"), (e.reg_pda(st[0].id), "a registry instead of a strategy"), (s.receipt, "another program account")] { let mut ix = e.cancel_ix(&s, e.payer.pubkey()); ix.accounts.push(AccountMeta::new(bad, false)); e.fresh_blockhash(); errs(&e.send(&[ix], &[]), what); assert_eq!(e.data(&s.arena)[ar::F2] & (F2_CANCELLED | F2_REFUNDED), 0, "nothing happened"); assert_eq!(counts(&e, &st), [1, 1, 0]); }
    assert!(e.cancel(&s).is_ok(), "the refund itself never depended on them");
}

#[test] fn cleanup_will_not_destroy_an_arena_that_still_holds_a_count() {
    let mut e = env(5); e.params.grace = MIN_GRACE; let st = sealed(&mut e, 3);
    let mut s = open(&mut e, 30, &st, 10, false); play(&mut e, &mut s, 3); assert!(e.settle_publishing(&s, 1).is_ok()); assert_eq!(counts(&e, &st), [0, 1, 1]);
    let ix = e.with_strats(e.cleanup_ix(&s), &[st[1].id, st[2].id]); rejects(&e.send(&[ix], &[]), 9123, "inside the grace, naming the strategies changes nothing");
    e.warp(MIN_GRACE + 1); e.fresh_blockhash(); rejects(&{ let ix = e.cleanup_ix(&s); e.send(&[ix], &[]) }, 9131, "after the grace, naming none");
    e.fresh_blockhash(); let ix = e.with_strats(e.cleanup_ix(&s), &[st[1].id]); rejects(&e.send(&[ix], &[]), 9131, "naming only one of the two"); assert_eq!(counts(&e, &st), [0, 1, 1], "a refused Cleanup releases nothing");
    e.fresh_blockhash(); assert!(e.cleanup(&s).is_ok()); assert_eq!(counts(&e, &st), [0, 0, 0]); assert_eq!(e.data(&s.receipt)[rc::PUB], 1, "the two released entries were never published");
    // a cancelled season: the same rule
    let s2 = open(&mut e, 31, &st, 10, false); assert!(e.cancel(&s2).is_ok()); e.fresh_blockhash(); rejects(&{ let ix = e.cleanup_ix(&s2); e.send(&[ix], &[]) }, 9131, "cancelled, naming none"); assert!(e.cleanup(&s2).is_ok()); assert_eq!(counts(&e, &st), [0, 0, 0]);
}

#[test] fn under_minimum_seed_timeout_and_season_deadline_cancels_all_release() {
    let mut e = env(5); e.params.seedto = 100; e.params.window = 100; e.params.mins = 3; let st = sealed(&mut e, 3);
    // under-minimum Lock (the arena is cancelled by Lock, Cancel records the refunds)
    let s = open(&mut e, 40, &st[..2], 10, false); e.warp(101); e.fresh_blockhash(); assert!(e.lock_by(&s, 4).is_ok()); close_refused_open(&mut e, &st[0], "cancelled by Lock, nothing recorded yet"); assert!(e.cancel_by(&s, 4).is_ok()); assert!(e.cleanup(&s).is_ok()); assert_eq!(counts(&e, &st), [0, 0, 0]);
    e.params.mins = 1;
    // seed timeout
    let s = open(&mut e, 41, &st, 10, false); assert!(e.lock(&s).is_ok()); e.warp(101); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok()); assert!(e.cleanup(&s).is_ok()); assert_eq!(counts(&e, &st), [0, 0, 0]);
    // season deadline
    let mut s = open(&mut e, 42, &st, 10, false); start(&mut e, &mut s, 4); let dl = phase_deadline(rd64(&e.data(&s.arena), ar::START), 2, 1); let by = dl - e.slot; e.warp(by); e.fresh_blockhash(); let ids: Vec<u64> = st.iter().map(|x| x.id).collect(); let ix = e.with_strats(e.cancel_ix(&s, e.payer.pubkey()), &ids); assert!(e.send(&[ix], &[]).is_ok()); assert_eq!(counts(&e, &st), [0, 0, 0]);
}

#[test] fn a_voided_finals_season_publishes_and_releases_like_any_other() {
    let mut e = env(5); let st = sealed(&mut e, 4); let mut s = open(&mut e, 45, &st, 10, true); start(&mut e, &mut s, 5); e.drive(&s, 1400, 1_400_000); assert!(e.in_finals(&s)); e.warp(FINALS_SEEDTO); e.fresh_blockhash(); close_refused_open(&mut e, &st[0], "waiting out the finals seed");
    assert!(e.settle(&s).is_ok()); for i in 0..4 { close_refused_open(&mut e, &st[i], "voided and settled, unpublished"); assert!(e.publish(&s, i).is_ok()); } assert_eq!(counts(&e, &st), [0, 0, 0, 0]);
}

#[test] fn the_count_cannot_overflow() {
    let mut e = env(5); let st = sealed(&mut e, 1); let k = e.strat_pda(st[0].id); e.set_data(&k, |d| d[S_OPEN..S_OPEN + 2].copy_from_slice(&u16::MAX.to_le_bytes()));
    let mut s = e.season(47); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); let bal = e.balance(&e.players[0].pubkey()); errs(&e.enter(&mut s, &st[0]), "Enter at the maximum count"); assert_eq!(e.open_count(st[0].id), u16::MAX); assert_eq!(e.balance(&e.players[0].pubkey()), bal, "and no fee moved"); assert_eq!(e.data(&s.arena)[ar::NS], 0);
}

#[test] fn enter_needs_the_strategy_writable() {
    let mut e = env(5); let st = sealed(&mut e, 1); let mut s = e.season(48); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok());
    let mut ix = e.enter_ix(&s, &st[0], st[0].owner); ix.accounts[1].is_writable = false; let kp = e.player(st[0].owner); errs(&e.send(&[ix], &[&kp]), "the previous build's account list"); assert_eq!(e.data(&s.arena)[ar::NS], 0); assert!(e.enter(&mut s, &st[0]).is_ok());
}

// ================= the guard against dodging publication =================
#[test] fn an_owner_cannot_close_a_strategy_to_keep_a_result_off_the_record() {
    let mut e = env(5); let st = sealed(&mut e, 5); let mut s = open(&mut e, 50, &st, 10, false); close_refused_open(&mut e, &st[0], "entered, unlocked");
    assert!(e.lock(&s).is_ok()); close_refused_open(&mut e, &st[0], "locked"); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, seed_of(6)).is_ok()); close_refused_open(&mut e, &st[0], "running");
    e.drive(&s, 1400, 1_400_000); let ex = expect(&s, false); let last = (0..5).find(|&i| ex.srank[i] == 5).unwrap(); let loser = st[last].clone(); close_refused_open(&mut e, &loser, "finished, not settled");
    // the loser's owner front-runs: settles (permissionless) without publishing anyone, then tries every way out inside the grace
    assert!(e.settle(&s).is_ok()); close_refused_open(&mut e, &loser, "settled with a bad rank, unpublished");
    let kp = e.player(loser.owner); let ow = kp.pubkey(); let ids = e.held_ids(&s); let mut cl = e.with_strats(e.cleanup_ix(&s), &ids); cl.accounts[0] = AccountMeta::new_readonly(ow, true); e.fresh_blockhash(); rejects(&e.send(&[cl], &[&kp]), 9123, "the owner cannot destroy the arena inside the grace");
    let mut cx = e.with_strats(e.cancel_ix(&s, ow), &[loser.id]); cx.accounts[0] = AccountMeta::new_readonly(ow, true); e.fresh_blockhash(); rejects(&e.send(&[cx], &[&kp]), 9033, "nor cancel a finished season to release it"); assert_eq!(e.open_count(loser.id), 1);
    // anyone publishes it; only then can it be closed, and the result is already on the record
    assert!(e.publish(&s, last).is_ok()); let en = rc_entry(&e, &s, last); assert_eq!((en.0, en.1), (loser.id, 5)); let reg = e.data(&e.reg_pda(loser.id)); assert_eq!(rd32(&reg, 104), 5, "the registry carries the bad rank"); close_ok(&mut e, &loser, STRAT_RENT); assert_eq!(rc_entry(&e, &s, last), (loser.id, 5), "and the season receipt still does after the close");
}
fn rc_entry(e: &Env, s: &Season, i: usize) -> (u64, u32) { let d = e.data(&s.receipt); let o = RC_ENT + i * 80; assert_eq!(d[o + rc::E_PUBLISHED], 1); (rd64(&d, o), rd32(&d, o + rc::E_FRANK)) }

/// A LIMIT, kept on purpose and pinned here so it is not mistaken for something the counter prevents: if nobody publishes an entry within the creator's grace, Cleanup still drops its publication (as before),
/// and the count is released with it. The program's floor (180,000 slots) is the least time anyone has to publish it first.
#[test] fn limit_after_the_publish_grace_cleanup_still_drops_an_unpublished_result() {
    let mut e = env(5); e.params.grace = MIN_GRACE; let st = sealed(&mut e, 2); let mut s = open(&mut e, 55, &st, 10, false); play(&mut e, &mut s, 7); assert!(e.settle(&s).is_ok()); e.warp(MIN_GRACE - 1); e.fresh_blockhash(); { let ix = e.with_strats(e.cleanup_ix(&s), &e.held_ids(&s)); rejects(&e.send(&[ix], &[]), 9123, "one slot before the floor"); } e.warp(1); e.fresh_blockhash(); assert!(e.cleanup(&s).is_ok()); assert_eq!(counts(&e, &st), [0, 0]); assert_eq!(e.data(&s.receipt)[rc::PUB], 0); close_ok(&mut e, &st[0], STRAT_RENT);
    assert_eq!(rd64(&e.data(&s.receipt), RC_ENT), st[0].id, "Settle had already put the id and rank on the receipt"); assert!(rd32(&e.data(&s.receipt), RC_ENT + rc::E_FRANK) >= 1);
}

// ================= only a publishable strategy may enter =================
/// What the program checks is that the strategy's OWN open registry is passed WRITABLE. That a writable account must be delegated to the rollup is the rollup's rule, not modelled here: it is shown on devnet.
#[test] fn enter_needs_the_strategys_own_registry_writable() {
    let mut e = env(5); let st = sealed(&mut e, 2); let (a_, b) = (st[0].clone(), st[1].clone()); let mut s = e.season(52); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); let bal = e.balance(&e.players[a_.owner].pubkey());
    let mut try_with = |e: &mut Env, meta: AccountMeta, what: &str| { let mut ix = e.enter_ix(&s, &a_, a_.owner); *ix.accounts.last_mut().unwrap() = meta; e.fresh_blockhash(); let kp = e.player(a_.owner); rejects(&e.send(&[ix], &[&kp]), 9133, what); assert_eq!((e.data(&s.arena)[ar::NS], e.open_count(a_.id), e.balance(&e.players[a_.owner].pubkey())), (0, 0, bal), "{}: nothing entered, nothing counted, no fee moved", what); };
    let own = e.reg_pda(a_.id); try_with(&mut e, AccountMeta::new_readonly(own, false), "its registry read-only"); let other = e.reg_pda(b.id); try_with(&mut e, AccountMeta::new(other, false), "another strategy's registry"); let mine = e.register(a_.owner, "same owner", code_of("EMAcross")); let mine = e.reg_pda(mine.id); try_with(&mut e, AccountMeta::new(mine, false), "another registry of the SAME owner (the way round the rule: offer a delegated one for a strategy whose own is not)"); let strat_b = e.strat_pda(b.id); try_with(&mut e, AccountMeta::new(strat_b, false), "an account that is not a registry"); try_with(&mut e, AccountMeta::new(Address::new_unique(), false), "an account that does not exist");
    let good = e.data(&own); e.set_data(&own, |d| d[0..4].copy_from_slice(&M_REG_CLOSED.to_le_bytes())); try_with(&mut e, AccountMeta::new(own, false), "a closed registry"); e.set_data(&own, |d| *d = good.clone()); e.set_data(&own, |d| d[8] ^= 1); try_with(&mut e, AccountMeta::new(own, false), "a registry naming another owner"); e.set_data(&own, |d| *d = good.clone());
    let mut ix = e.enter_ix(&s, &a_, a_.owner); ix.accounts.pop(); e.fresh_blockhash(); let kp = e.player(a_.owner); errs(&e.send(&[ix], &[&kp]), "the previous account list, with no registry"); assert!(e.enter(&mut s, &a_).is_ok(), "with its own writable registry it enters"); assert_eq!(e.open_count(a_.id), 1);
}

// ================= close =================
#[test] fn close_at_zero_returns_the_rent_to_the_hub_and_the_registry_to_its_owner() {
    let mut e = env(5); let st = sealed(&mut e, 2); let a_ = st[0].clone(); let ow = e.players[a_.owner].pubkey(); let rk = e.reg_pda(a_.id);
    rejects(&e.close_registry(&a_), 9132, "removing the registry of a live strategy"); errs(&e.commit_undelegate(&[rk]), "pulling a live registry out of the rollup"); { let r = e.commit_undelegate(&[rk]); rejects(&r, 9055, "live registry undelegate"); }
    close_ok(&mut e, &a_, STRAT_RENT);
    assert!(e.commit_undelegate(&[rk]).is_ok(), "a closed registry may be committed and undelegated");
    let thief = e.players[3].pubkey(); e.fresh_blockhash(); let ix = e.close_registry_ix(a_.id, thief); rejects(&e.send(&[ix], &[]), 9132, "the registry pays only its owner");
    let (r0, o0, paid) = (e.lamports(&rk), e.lamports(&ow), e.lamports(&rk)); assert!(paid >= 2_000_000, "what the owner put in at Register"); let r = e.close_registry(&a_); assert!(r.is_ok(), "CloseRegistry (sent by a stranger's fee payer): {}", err_string(&r)); assert_eq!(e.lamports(&ow) - o0, r0, "every lamport of it back to the owner"); assert!(e.svm.get_account(&rk).map_or(true, |x| x.lamports == 0 && x.data.is_empty()), "the registry entry is gone");
    errs(&e.close_registry(&a_), "twice"); assert_eq!(e.open_count(st[1].id), 0, "the other strategy is untouched"); assert!(!e.data(&e.strat_pda(st[1].id)).is_empty());
}

#[test] fn only_the_owner_closes_and_the_rent_cannot_be_redirected() {
    let mut e = env(5); let st = sealed(&mut e, 2); let (a_, b) = (st[0].clone(), st[1].clone()); let kp = e.player(a_.owner);
    let go = |e: &mut Env, ix: Instruction, who: usize| { e.fresh_blockhash(); let k = e.player(who); e.send(&[ix], &[&k]) };
    let h0 = e.lamports(&e.hub);
    let ix = e.close_strategy_ix(a_.id, 3); errs(&go(&mut e, ix, 3), "another wallet");
    let mut ix = e.close_strategy_ix(a_.id, a_.owner); ix.accounts[0] = AccountMeta::new_readonly(kp.pubkey(), false); e.fresh_blockhash(); errs(&e.send(&[ix], &[]), "no owner signature");
    let mut ix = e.close_strategy_ix(a_.id, a_.owner); ix.accounts[1] = AccountMeta::new(kp.pubkey(), false); errs(&go(&mut e, ix, a_.owner), "the owner naming itself as the rent sponsor");
    let mut ix = e.close_strategy_ix(a_.id, a_.owner); ix.accounts[7] = AccountMeta::new(e.reg_pda(b.id), false); errs(&go(&mut e, ix, a_.owner), "another strategy's registry");
    let mut ix = e.close_strategy_ix(a_.id, a_.owner); ix.accounts[7].is_writable = false; errs(&go(&mut e, ix, a_.owner), "a registry that cannot be written (in the rollup: one that is not delegated here)");
    let ix = e.close_strategy_ix(b.id, a_.owner); errs(&go(&mut e, ix, a_.owner), "someone else's strategy");
    assert_eq!(e.lamports(&e.hub), h0); assert_eq!(counts(&e, &st), [0, 0]); for s in &st { assert_eq!(rd32(&e.data(&e.reg_pda(s.id)), 0), M_REG); }
    close_ok(&mut e, &a_, STRAT_RENT);
}

#[test] fn a_closed_strategy_cannot_be_entered_resealed_or_closed_again_and_close_works_while_paused() {
    let mut e = env(5); let st = sealed(&mut e, 2); assert!(e.admin(0, &[]).is_ok()); close_ok(&mut e, &st[0], STRAT_RENT); close_ok(&mut e, &st[1], STRAT_RENT); assert!(e.admin(1, &[]).is_ok());
    errs(&e.close_strategy(&st[0]), "closing twice"); let mut s = e.season(60); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); errs(&e.enter(&mut s, &st[0]), "entering a closed strategy");
    let h0 = e.lamports(&e.hub); errs(&e.seal(&st[0]), "sealing the id again while its registry is only marked closed"); assert_eq!(e.lamports(&e.hub), h0, "the hub paid nothing");
}

#[test] fn cancel_and_cleanup_naming_twenty_strategies_fit_in_one_transaction() {
    let mut e = env(20); let st = sealed(&mut e, 20); let ids: Vec<u64> = st.iter().map(|x| x.id).collect();
    let size = |e: &Env, ix: &Instruction| { let mut d = vec![2u8]; d.extend(1_400_000u32.to_le_bytes()); let cb = Instruction { program_id: a("ComputeBudget111111111111111111111111111111"), accounts: vec![], data: d }; solana_message::Message::new(&[cb, ix.clone()], Some(&e.payer.pubkey())).serialize().len() + 1 + 64 };
    let s = open(&mut e, 70, &st, 10, false); let cx = e.with_strats(e.cancel_ix(&s, e.payer.pubkey()), &ids); let n1 = size(&e, &cx); let r = e.send(&[cx], &[]); assert!(r.is_ok(), "{}", err_string(&r)); let cu1 = r.unwrap().compute_units_consumed; assert!(counts(&e, &st).iter().all(|&c| c == 0));
    let s2 = open(&mut e, 71, &st, 10, false); assert!(e.cancel(&s2).is_ok()); let cl = e.with_strats(e.cleanup_ix(&s2), &ids); let n2 = size(&e, &cl); let r = e.send(&[cl], &[]); assert!(r.is_ok(), "{}", err_string(&r)); let cu2 = r.unwrap().compute_units_consumed; assert!(counts(&e, &st).iter().all(|&c| c == 0));
    println!("METER release 20: Cancel {} bytes {} CU; Cleanup {} bytes {} CU", n1, cu1, n2, cu2); assert!(n1 <= 1232 && n2 <= 1232, "{} {}", n1, n2); assert!(cu1 < 700_000 && cu2 < 700_000);
}

// ================= older strategies =================
#[test] fn an_older_strategy_reads_as_zero_and_closes_for_its_own_rent() {
    let mut e = env(5); let st = sealed(&mut e, 1);
    // the 396-byte form: same fields, 8 bytes shorter, and the hub paid 19,744 for it. Bytes 6..8 were never written by any earlier build.
    let k = e.strat_pda(st[0].id); let mut acc = e.svm.get_account(&k).unwrap(); acc.data.truncate(STRAT_MIN_SIZE); e.svm.set_account(k, acc).unwrap(); e.rent_held.as_mut().unwrap().insert((false, k), eph_rent(STRAT_MIN_SIZE)); let mut h = e.svm.get_account(&e.hub).unwrap(); h.lamports += eph_rent(404) - eph_rent(396); e.svm.set_account(e.hub, h).unwrap();
    assert_eq!(e.open_count(st[0].id), 0); let mut s = open(&mut e, 80, &st, 10, false); assert_eq!(e.open_count(st[0].id), 1); close_refused_open(&mut e, &st[0], "old strategy, entered"); play(&mut e, &mut s, 8); assert!(e.settle_publishing(&s, 1).is_ok()); assert_eq!(e.open_count(st[0].id), 0); close_ok(&mut e, &st[0], 19_744);
}

/// The real compatibility test: strategies and seasons made by the PREVIOUS PROGRAM'S BYTECODE, then the program is swapped in place, as an upgrade does.
/// Needs that binary: CONCLAVE_OLD_SO=/path/to/conclave.so (sha256 928fe97110e617fdd1a90fbc3af04fa55be12b4e2a16d06af975a0ec3d1f04b4, the build deployed before this change)
#[test] #[ignore = "needs the previous program binary in CONCLAVE_OLD_SO"] fn state_made_by_the_deployed_bytecode_survives_the_upgrade_and_closes() {
    let old = std::fs::read(std::env::var("CONCLAVE_OLD_SO").expect("CONCLAVE_OLD_SO")).unwrap(); let new = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../program/target/deploy/conclave.so")).unwrap(); assert_eq!(sha256(&[&old]).iter().map(|b| format!("{:02x}", b)).collect::<String>(), "928fe97110e617fdd1a90fbc3af04fa55be12b4e2a16d06af975a0ec3d1f04b4"); assert_ne!(old, new);
    let mut e = env(5); let pid = e.pid; e.svm.add_program(pid, &old).unwrap();
    // old bytecode: seal four, and leave three kinds of season open across the upgrade: finished and unsettled, settled and half published, and unlocked
    let st = sealed(&mut e, 4); let enter_old = |e: &mut Env, s: &mut Season, t: &Strat| { let mut ix = e.enter_ix(s, t, t.owner); ix.accounts[1].is_writable = false; let kp = e.player(t.owner); e.fresh_blockhash(); let r = e.send(&[ix], &[&kp]); assert!(r.is_ok(), "old Enter: {}", err_string(&r)); s.entries.push(t.clone()); };
    let mk = |e: &mut Env, sid: u64| { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); for t in &st[..3] { enter_old(e, &mut s, t); } s };
    let mut unsettled = mk(&mut e, 900); play(&mut e, &mut unsettled, 9); let mut half = mk(&mut e, 901); play(&mut e, &mut half, 10); assert!(e.settle_publishing(&half, 1).is_ok()); let unlocked = mk(&mut e, 902);
    assert_eq!(counts(&e, &st), [0, 0, 0, 0], "the old build counts nothing");
    e.svm.add_program(pid, &new).unwrap();
    // new bytecode on old state: a new season enters an old strategy and counts it; the old seasons publish and clean up without ever touching a count
    let mut fresh = open(&mut e, 903, &st[..2], 10, false); assert_eq!(counts(&e, &st), [1, 1, 0, 0]);
    assert!(e.settle_publishing(&unsettled, 3).is_ok(), "an old season settles and publishes"); assert_eq!(counts(&e, &st), [1, 1, 0, 0], "publishing an old entry never takes a new season's unit");
    for i in 1..3 { assert!(e.publish(&half, i).is_ok()); } assert_eq!(counts(&e, &st), [1, 1, 0, 0]);
    assert!(e.cancel(&unlocked).is_ok()); assert!({ let ix = e.cleanup_ix(&unlocked); e.send(&[ix], &[]).is_ok() }, "an old cancelled arena needs no strategy named"); assert!(e.cleanup(&unsettled).is_ok()); assert!(e.cleanup(&half).is_ok()); assert_eq!(counts(&e, &st), [1, 1, 0, 0]);
    close_refused_open(&mut e, &st[0], "an old strategy in a new season"); close_ok(&mut e, &st[2], STRAT_RENT); close_ok(&mut e, &st[3], STRAT_RENT);
    play(&mut e, &mut fresh, 11); assert!(e.settle_publishing(&fresh, 2).is_ok()); close_ok(&mut e, &st[0], STRAT_RENT); close_ok(&mut e, &st[1], STRAT_RENT); for t in &st { let r = e.close_registry(t); assert!(r.is_ok(), "an old registry is removed too: {}", err_string(&r)); }
}

// ================= the hub is made whole =================
/// seal, a whole season, close everything, close the strategies: the hub is back to the lamport, nothing is left in the vault, and entries in equal claims out
fn whole_cycle(sid: u64, n: usize, finals: bool, ending: &str) {
    let mut e = env(20.max(n)); let hub0 = e.lamports(&e.hub); let tokens: Vec<u64> = e.players.iter().map(|p| e.balance(&p.pubkey())).collect(); assert_eq!(e.vault_total(), 0);
    let st = sealed(&mut e, n); assert_eq!(hub0 - e.lamports(&e.hub), n as u64 * STRAT_RENT);
    if ending == "cancelled" { e.params.seedto = 100; }
    let mut s = open(&mut e, sid, &st, 10, finals);
    match ending {
        "cancelled" => { assert!(e.lock(&s).is_ok()); e.warp(101); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok()); }
        "voided" => { start(&mut e, &mut s, 12); e.drive(&s, 1400, 1_400_000); assert!(e.in_finals(&s)); e.warp(FINALS_SEEDTO); e.fresh_blockhash(); assert!(e.settle(&s).is_ok()); for i in 0..n { assert!(e.publish(&s, i).is_ok()); } }
        _ => { play(&mut e, &mut s, 12); assert!(e.settle(&s).is_ok()); for i in 0..n { assert!(e.publish(&s, i).is_ok()); } }
    }
    e.claim_all(&s); e.assert_books(&s, 0); let (_, owed, claimed) = e.claim_totals(&s); assert_eq!((owed, claimed), (10 * n as u64, 10 * n as u64), "entries in = claims out"); assert_eq!(e.pool_balance(&s), 0);
    let after: u64 = e.players.iter().map(|p| e.balance(&p.pubkey())).sum(); assert_eq!(after, tokens.iter().sum::<u64>());
    assert!(e.close_claims(&s).is_ok()); assert!(e.cleanup(&s).is_ok()); assert!(e.commit_undelegate(&[s.receipt]).is_ok()); assert!(e.release_bond(&s).is_ok());
    assert_eq!(hub0 - e.lamports(&e.hub), n as u64 * STRAT_RENT, "after the season closes, only the live strategies are still holding the hub's rent: this is what a never-closed strategy keeps");
    for t in &st { close_ok(&mut e, t, STRAT_RENT); assert!(e.commit_undelegate(&[e.reg_pda(t.id)]).is_ok()); let r = e.close_registry(t); assert!(r.is_ok(), "{}", err_string(&r)); }
    assert_eq!(e.lamports(&e.hub), hub0, "the hub is whole, strategy rent included"); assert_eq!(e.vault_total(), 0, "nothing left in the rollup vault");
}
#[test] fn hub_whole_after_a_paid_two_phase_season_and_closing_its_strategies() { whole_cycle(100, 5, true, "settled"); }
#[test] fn hub_whole_after_a_full_twenty_seat_season() { whole_cycle(101, 20, true, "settled"); }
#[test] fn hub_whole_after_a_voided_finals_season() { whole_cycle(102, 4, true, "voided"); }
#[test] fn hub_whole_after_a_cancelled_season() { whole_cycle(103, 5, false, "cancelled"); }
