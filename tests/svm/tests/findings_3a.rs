//! Phase 3a REGRESSION tests. Each of these first REPRODUCED a defect in the previous deployed build (sha256 5b08cd1d...) and asserted the defective behaviour.
//! The assertions are now reversed: the same attack is attempted and must fail, and the money must still come out. The test names keep the finding numbers.
//! Signature verification is ON for every transaction (real ed25519 signatures). The single exception is the VRF oracle's callback, whose signer is a program address no keypair can sign for.
mod common;
use common::*;
use solana_instruction::AccountMeta;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
const R_SEASONS: usize = 80; const R_TOTAL: usize = 88; const R_ENTRIES: usize = 108;
fn env(n: usize) -> Env { Env::new(n) }
fn oracle(e: &mut Env, s: &mut Season, byte: u8) { let r = e.deliver_seed(s, seed_of(byte)); assert!(r.is_ok(), "VRF callback {}", err_string(&r)); }
fn finals_oracle(e: &mut Env, s: &mut Season, byte: u8) { assert!(e.request_seed(s).is_ok(), "finals RequestSeed"); let r = e.deliver_finals_seed(s, seed_of(byte ^ 0xa7)); assert!(r.is_ok(), "finals VRF callback {}", err_string(&r)); }
fn create(e: &mut Env, sid: u64, neps: u32, spt: u32, fee: u64, finals: bool) -> Result<Season, u32> { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_side(&s, 20); s.neps = neps; s.fee = fee; let ix = e.create_season_ix(&s, neps, spt, fee, 20, if finals { 2 } else { 0 }, 2); e.fresh_blockhash(); let r = e.send(&[ix], &[]); if r.is_ok() { Ok(s) } else { Err(custom(&r).unwrap_or(0)) } }
fn enter_n(e: &mut Env, s: &mut Season, n: usize) { for i in 0..n { let st = e.register_and_seal(i, NAMES[i % 5], code_of(NAMES[i % 5])); let r = e.enter(s, &st); assert!(r.is_ok(), "Enter {}", err_string(&r)); } }
fn bals(e: &Env) -> Vec<u64> { e.players.iter().map(|p| e.balance(&p.pubkey())).collect() }
fn is_code(r: &Res, c: u32, what: &str) { assert_eq!(custom(r), Some(c), "{}: expected Custom {}, got {}", what, c, err_string(r)); }
fn fresh(e: &mut Env, n: u64) { e.warp(n); e.fresh_blockhash(); }
fn warp_to(e: &mut Env, slot: u64) { assert!(slot >= e.slot); let by = slot - e.slot; fresh(e, by); }
/// the exact instruction the removed StartFinals took, with whatever k, episode count and slots-per-tick the caller likes
fn old_start_finals(e: &mut Env, s: &Season, who: usize, k: u8, neps: u32, spt: u32) -> Res { let kp = e.player(who); let mut d = (s.sid + 500).to_le_bytes().to_vec(); d.push(k); d.extend(neps.to_le_bytes()); d.extend(spt.to_le_bytes());
    let ix = e.ix(14, vec![AccountMeta::new_readonly(kp.pubkey(), true), e.rw(s.arena), e.rw(e.hub), e.rw(e.arena_pda(s.sid + 500)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(MAGIC)), e.ro(a(PERMISSION)), e.rw(e.receipt_pda(s.sid + 500))], d); e.fresh_blockhash(); e.send(&[ix], &[&kp]) }
/// finish: everyone claims, the claims account and the arena close, the bond becomes releasable
fn close_out(e: &mut Env, s: &Season) { e.claim_all(s); assert!(e.close_claims(s).is_ok(), "CloseClaims"); for i in 0..s.entries.len() { if e.data(&s.arena)[HDR + i * SLOT + ar::SL_BITS] & B_PUBLISHED == 0 && e.flags(s) & F_SETTLED != 0 { fresh(e, 1); assert!(e.publish(s, i).is_ok()); } } fresh(e, 1); let r = e.cleanup(s); assert!(r.is_ok(), "Cleanup {}", err_string(&r)); assert_eq!(e.data(&s.receipt)[rc::STATE], 2, "bond releasable"); assert_eq!(rd64(&e.data(&s.receipt), rc::RELEASE), BOND); }
fn seeded(e: &mut Env, sid: u64, neps: u32, spt: u32, finals: bool, seed: u8) -> Season { let mut s = create(e, sid, neps, spt, 10, finals).expect("create"); enter_n(e, &mut s, 5); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); oracle(e, &mut s, seed); s }

// ---- finding #1: unbounded slots-per-tick and episodes ----
#[test] fn finding1a_maximal_slots_per_tick_is_refused_and_a_stalled_season_refunds() {
    let mut e = env(5);
    assert_eq!(create(&mut e, 11, 2, u32::MAX, 10, false).err(), Some(9101), "the attack: slots-per-tick = u32::MAX");
    assert_eq!(create(&mut e, 12, 2, MAX_SPT + 1, 10, false).err(), Some(9101)); assert_eq!(create(&mut e, 13, 2, 0, 10, false).err(), Some(9101));
    assert_eq!(create(&mut e, 14, 49, MAX_SPT, 10, false).err(), Some(9102), "49 x 150 x 100 = 735,000 slots of pacing is over the 720,000 run bound");
    assert!(create(&mut e, 15, 48, MAX_SPT, 10, false).is_ok(), "48 episodes at the maximum pace is exactly the bound");
    // the slowest season the program now accepts, which nobody advances: after its program-calculated deadline anyone gets everyone refunded
    let before = bals(&e); let s = seeded(&mut e, 16, 33, MAX_SPT, true, 1); /* the slowest season WITH finals: (33 + 15) x 150 x 100 = 720,000 */ let dl = phase_deadline(rd64(&e.data(&s.arena), ar::START), 33, MAX_SPT);
    warp_to(&mut e, dl - 1); is_code(&e.cancel_by(&s, 4), 9033, "one slot before the deadline");
    warp_to(&mut e, dl); is_code(&e.advance(&s, 1400, 1_400_000), 9113, "from the deadline on the run cannot be resumed, so nobody can choose between finishing it and refunding it");
    let r = e.cancel_by(&s, 4); assert!(r.is_ok(), "Cancel at the deadline by a stranger: {}", err_string(&r)); assert_eq!(e.data(&s.arena)[arx::REASON], 7);
    close_out(&mut e, &s); assert_eq!(bals(&e), before, "every entry fee is back"); assert_eq!(e.pool_balance(&s), 0); }

#[test] fn finding1b_maximal_episodes_is_refused_and_the_longest_season_finishes_inside_its_deadline() {
    let mut e = env(5); for (sid, n) in [(21u64, 100_000u32), (22, MAX_EPISODES + 1), (23, 0)] { assert_eq!(create(&mut e, sid, n, 1, 10, false).err(), Some(9100), "{} episodes", n); }
    let s = seeded(&mut e, 24, MAX_EPISODES, 1, false, 2); let start = rd64(&e.data(&s.arena), ar::START);
    let n = e.drive(&s, 1400, 1_400_000); assert_ne!(e.flags(&s) & F_DONE, 0); assert!(n < 300, "{} Advance transactions for 100 episodes of five light seats (the old maximum needed about 133,000)", n);
    println!("F1b: {} episodes finished in {} Advance transactions; deadline allowed {} slots after the seed", MAX_EPISODES, n, phase_deadline(start, MAX_EPISODES, 1) - start);
    assert!(e.settle(&s).is_ok()); close_out(&mut e, &s); }

// ---- finding #2: the first StartFinals caller chose the format ----
#[test] fn finding2a_nobody_can_choose_k_1_the_leader_never_takes_a_reserve_unopposed() {
    let mut overtaken = 0;
    for (j, seed) in [3u8, 40, 90, 200].into_iter().enumerate() {
        let mut e = env(5); let before = bals(&e); let mut s = seeded(&mut e, 30 + j as u64, 15, 1, true, seed); e.drive(&s, 1400, 1_400_000);
        assert!(e.in_finals(&s), "the season phase moved the arena into the finals by itself"); let ex = expect(&s, false); let leader = (0..5).find(|&i| ex.srank[i] == 1).unwrap();
        let owner = s.entries[leader].owner; let r = old_start_finals(&mut e, &s, owner, 1, 1, 1); assert!(r.is_err(), "the k = 1 attack: the instruction no longer exists");
        assert_eq!((0..5).filter(|&i| e.finalist(&s, i)).count(), 3, "exactly three qualify"); for i in 0..5 { assert_eq!(e.finalist(&s, i), ex.srank[i] <= 3); assert_eq!(e.srank(&s, i), ex.srank[i]); }
        is_code(&e.settle(&s), 9115, "the leader cannot settle around the finals while they can still be played");
        finals_oracle(&mut e, &mut s, seed); e.drive(&s, 1400, 1_400_000); assert!(e.settle(&s).is_ok()); let want = expect(&s, true); e.claim_all(&s);
        let after = bals(&e); for i in 0..5 { assert_eq!(after[s.entries[i].owner] + 10 - before[s.entries[i].owner], want.owed[i], "seed {} entry {}", seed, i); assert_eq!(e.rank(&s, i), want.frank[i]); }
        assert!(want.owed[leader] < 50, "the leader never gets the whole pot"); if want.frank[leader] != 1 { overtaken += 1; } }
    println!("F2a: over 4 fixed seeds the season leader was overtaken in {}", overtaken); }

#[test] fn finding2a_nobody_outside_the_top_three_can_be_made_a_finalist_or_be_paid() {
    for seed in 0..12u8 { let mut e = env(5); let before = bals(&e); let mut s = seeded(&mut e, 40 + u64::from(seed), 15, 1, true, 9u8.wrapping_add(seed)); e.drive(&s, 1400, 1_400_000);
        let r = old_start_finals(&mut e, &s, 4, 255, 1, 1); assert!(r.is_err(), "the whole-field attack");
        finals_oracle(&mut e, &mut s, seed.wrapping_mul(53).wrapping_add(11)); e.drive(&s, 1400, 1_400_000); assert_eq!(rd32(&e.data(&s.arena), ar::NEPS), 15); assert_eq!(rd32(&e.data(&s.arena), ar::CUREP), FINALS_EPISODES, "the finals ran the fixed fifteen episodes");
        assert!(e.settle(&s).is_ok()); let ex = expect(&s, true); e.claim_all(&s); let after = bals(&e);
        for i in 0..5 { let p = s.entries[i].owner; assert_eq!(after[p] + 10 - before[p], ex.owed[i]); if ex.srank[i] > 3 { assert_eq!(ex.owed[i], 0); assert_eq!(e.rank(&s, i), ex.srank[i], "outside the top three the season rank stands"); assert_eq!(e.ftotal(&s, i), 0, "a non-qualifier runs no finals tick"); } else { assert!(e.rank(&s, i) <= 3); } } } }

#[test] fn finding2b_a_stranger_cannot_pace_the_finals_and_stalled_finals_are_voided() {
    let mut e = env(6); let before = bals(&e); let mut s = seeded(&mut e, 60, 15, 1, true, 5); e.drive(&s, 1400, 1_400_000);
    let r = old_start_finals(&mut e, &s, 5, 3, 3, u32::MAX); assert!(r.is_err(), "the u32::MAX finals attack");
    finals_oracle(&mut e, &mut s, 4); assert_eq!(rd32(&e.data(&s.arena), 84), 1, "the finals pace is the season's, fixed at creation");
    // run part of the finals, then everyone walks away
    let fstart = rd64(&e.data(&s.arena), ar::START); for _ in 0..4 { fresh(&mut e, 150); assert!(e.advance(&s, 1400, 1_400_000).is_ok()); } assert_eq!(e.flags(&s) & F_DONE, 0, "not finished"); assert!((0..5).any(|i| e.ftotal(&s, i) != 0), "partial finals scores exist");
    let dl = phase_deadline(fstart, FINALS_EPISODES, 1); warp_to(&mut e, dl - 1); is_code(&e.settle(&s), 9115, "one slot before the finals deadline"); is_code(&e.cancel_by(&s, 5), 9033, "a finished season phase is never refunded");
    warp_to(&mut e, dl); is_code(&e.advance(&s, 1400, 1_400_000), 9113, "late finals cannot be resumed");
    let r = { let kp = e.player(5); let mut ix = e.settle_ix(&s); ix.accounts[0] = AccountMeta::new(kp.pubkey(), true); e.send(&[ix], &[&kp]) }; assert!(r.is_ok(), "a stranger settles the voided finals: {}", err_string(&r));
    let ex = expect(&s, false); let rcp = e.data(&s.receipt); assert_eq!(rcp[rc::FSTATUS], FS_VOIDED); assert_eq!(rcp[rc::REASON], 5);
    for i in 0..5 { assert_eq!(e.rank(&s, i), ex.srank[i], "paid by the frozen season ranks"); assert_eq!(e.owed(&s, i), ex.owed[i]); assert_eq!(e.ftotal(&s, i), 0, "partial finals scores are discarded"); assert!(!e.finalist(&s, i)); }
    close_out(&mut e, &s); let after = bals(&e); for i in 0..5 { assert_eq!(after[s.entries[i].owner] + 10 - before[s.entries[i].owner], ex.owed[i]); } assert_eq!(e.pool_balance(&s), 0, "nothing is stranded"); }

// ---- finding #3: finals nobody started had no timeout ----
#[test] fn finding3_a_season_whose_finals_nobody_touches_still_settles_and_closes() {
    let mut e = env(6); let before = bals(&e); let s = seeded(&mut e, 70, 15, 1, true, 6); e.drive(&s, 1400, 1_400_000); let done_at = rd64(&e.data(&s.arena), ar::SDONEAT);
    assert!(e.cleanup(&s).is_err(), "not settled yet"); is_code(&e.settle(&s), 9115, "inside the finals seed timeout");
    warp_to(&mut e, done_at + FINALS_SEEDTO - 1); is_code(&e.settle(&s), 9115, "one slot early");
    warp_to(&mut e, done_at + FINALS_SEEDTO); is_code(&e.request_seed(&s), 9111, "too late to ask for the seed");
    let r = { let kp = e.player(5); let mut ix = e.settle_ix(&s); ix.accounts[0] = AccountMeta::new(kp.pubkey(), true); e.send(&[ix], &[&kp]) }; assert!(r.is_ok(), "anyone settles: {}", err_string(&r));
    assert_eq!(e.data(&s.receipt)[rc::FSTATUS], FS_VOIDED); assert_eq!(e.data(&s.receipt)[rc::REASON], 4);
    close_out(&mut e, &s); let ex = expect(&s, false); let after = bals(&e); for i in 0..5 { assert_eq!(after[s.entries[i].owner] + 10 - before[s.entries[i].owner], ex.owed[i]); } assert_eq!(e.pool_balance(&s), 0); }

// ---- finding #4: any VRF queue was accepted ----
#[test] fn finding4_only_the_pinned_queue_is_accepted_in_both_phases() {
    let mut e = env(5); let mut s = create(&mut e, 80, 15, 1, 10, true).unwrap(); enter_n(&mut e, &mut s, 3); assert!(e.lock(&s).is_ok());
    let others = ["Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT", "FRqXJqfCi3o6gF3Yqnkx1gKA3YnbRDJbBs6hKpme3NHJ", "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh", "GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb"];
    let try_all = |e: &mut Env, s: &Season, flags_before: u8| { for q in others.iter().map(|q| a(q)).chain([Address::new_unique()]) { let kp = e.player(4); let identity = pda(&[b"identity"], &e.pid); let ix = e.ix(8, vec![AccountMeta::new(kp.pubkey(), true), e.rw(s.arena), e.ro(identity), e.rw(q), e.ro(a(SYSTEM)), e.ro(a(SLOT_HASHES)), e.ro(a(VRF))], vec![]); e.fresh_blockhash(); is_code(&e.send(&[ix], &[&kp]), 9110, "a queue of the caller's choosing"); assert_eq!(e.flags(s), flags_before, "nothing changed, the honest request is still possible"); } };
    let f = e.flags(&s); try_all(&mut e, &s, f); assert!(e.request_seed(&s).is_ok(), "the pinned queue"); oracle(&mut e, &mut s, 7); e.drive(&s, 1400, 1_400_000);
    let f = e.flags(&s); try_all(&mut e, &s, f); finals_oracle(&mut e, &mut s, 7); }

// ---- finding #5: an earlier season could be published again ----
fn two_seasons(e: &mut Env, publish_inline: usize) -> (Season, Season) { let sts: Vec<Strat> = (0..2).map(|i| e.register_and_seal(i, NAMES[i], code_of(NAMES[i]))).collect(); let mut out = vec![];
    for (j, sid) in [90u64, 91].into_iter().enumerate() { let mut s = create(e, sid, 2, 1, 10, false).unwrap(); for st in &sts { assert!(e.enter(&mut s, st).is_ok()); } assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); oracle(e, &mut s, 20 + j as u8); e.drive(&s, 1400, 1_400_000); assert!(e.settle_publishing(&s, if j == 0 { publish_inline } else { 2 }).is_ok()); out.push(s); }
    (out.remove(0), out.remove(0)) }
fn career(e: &Env, id: u64) -> (u32, u32, i64) { let d = e.data(&e.reg_pda(id)); (rd32(&d, R_SEASONS), rd32(&d, R_ENTRIES), rdi64(&d, R_TOTAL)) }

#[test] fn finding5_an_earlier_season_can_never_be_published_again() {
    let mut e = env(5); let (a_, b) = two_seasons(&mut e, 2); let id = a_.entries[0].id; let honest = (2u32, 2u32, e.total(&a_, 0) + e.total(&b, 0)); assert_eq!(career(&e, id), honest);
    for round in 0..5 { for s in [&a_, &b] { for i in 0..2 { fresh(&mut e, 1); is_code(&e.publish(s, i), 9120, &format!("round {} republishing season {} entry {}", round, s.sid, i)); } } }
    assert_eq!(career(&e, id), honest, "two real seasons count as two"); for s in [&a_, &b] { assert_eq!(e.data(&s.receipt)[rc::PUB], 2, "the receipt counter cannot be inflated"); assert_eq!(e.data(&s.arena)[ar::PUBN], 2); } }

#[test] fn finding5_cleanup_cannot_skip_an_entry_that_was_never_published() {
    let mut e = env(5); e.params.grace = 200_000_000; let (a_, b) = two_seasons(&mut e, 0); assert!(e.publish(&a_, 0).is_ok());
    // the attack: bounce the strategy's last-season mark through another season, then publish the same entry again to run the counter up
    fresh(&mut e, 1); is_code(&e.publish(&b, 0), 9120, "the other season is already published"); fresh(&mut e, 1); is_code(&e.publish(&a_, 0), 9120, "the second publish of entry 0");
    assert_eq!(e.data(&a_.arena)[ar::PUBN], 1); is_code(&e.cleanup(&a_), 9123, "entry 1 is unpublished and the grace is running");
    // even a counter that lied would not be enough: Cleanup reads each entry's own mark
    e.set_data(&a_.arena, |d| d[ar::PUBN] = 2); fresh(&mut e, 1); is_code(&e.cleanup(&a_), 9123, "the per-entry mark decides, not the counter"); e.set_data(&a_.arena, |d| d[ar::PUBN] = 1);
    fresh(&mut e, 1); assert!(e.publish(&a_, 1).is_ok(), "entry 1 still has everything it needs"); fresh(&mut e, 1); assert!(e.cleanup(&a_).is_ok()); }

#[test] fn finding5_a_finals_season_publishes_each_entry_once_and_reopens_nothing() {
    let mut e = env(5); let sts: Vec<Strat> = (0..4).map(|i| e.register_and_seal(i, NAMES[i], code_of(NAMES[i]))).collect(); let mut seasons = vec![];
    for (j, finals) in [false, true].into_iter().enumerate() { let mut s = create(&mut e, 95 + j as u64, if finals { 15 } else { 2 }, 1, 10, finals).unwrap(); for st in &sts { assert!(e.enter(&mut s, st).is_ok()); } assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); oracle(&mut e, &mut s, 30 + j as u8); e.drive(&s, 1400, 1_400_000); if finals { finals_oracle(&mut e, &mut s, 3); e.drive(&s, 1400, 1_400_000); } assert!(e.settle_publishing(&s, 4).is_ok()); seasons.push(s); }
    for s in &seasons { for i in 0..4 { fresh(&mut e, 1); is_code(&e.publish(s, i), 9120, "republish"); } assert_eq!(e.data(&s.receipt)[rc::PUB], 4); } for st in &sts { assert_eq!(career(&e, st.id).0, 2); } }
