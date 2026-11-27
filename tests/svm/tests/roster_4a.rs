//! Receipts and identity: the private roster, who each result belongs to on the receipt (every entry, published or not), the receipt format, the derived score salt and the permanent id marker.
//! NOT modelled here: who can READ the roster. The program creates it private with no members, like the arena; that the rollup then hides it is shown on devnet.
mod common;
use common::*;
use solana_instruction::{AccountMeta, Instruction};

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn rejects(r: &Res, code: u32, what: &str) { assert_eq!(custom(r), Some(code), "{}: expected Custom {}, got {}", what, code, err_string(r)); }
fn errs(r: &Res, what: &str) { assert!(r.is_err() && !failed_to_complete(r), "{} should be refused with an error, got {}", what, err_string(r)); }
fn sealed(e: &mut Env, n: usize) -> Vec<Strat> { (0..n).map(|i| { let o = i % e.players.len(); e.register_and_seal(o, NAMES[i % 5], code_of(NAMES[i % 5])) }).collect() }
fn open(e: &mut Env, sid: u64, sts: &[Strat], fee: u64, finals: bool) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); let r = e.create_season(&mut s, if finals { 15 } else { 2 }, fee, 20, finals, 2); assert!(r.is_ok(), "CreateSeason {}", err_string(&r)); for st in sts { let r = e.enter(&mut s, st); assert!(r.is_ok(), "Enter {}", err_string(&r)); } s }
fn play(e: &mut Env, s: &mut Season, byte: u8) { assert!(e.lock(s).is_ok()); assert!(e.request_seed(s).is_ok()); assert!(e.deliver_seed(s, seed_of(byte)).is_ok()); e.drive(s, 1400, 1_400_000); if e.in_finals(s) { e.run_finals(s, byte); } }
fn owner_of(e: &Env, st: &Strat) -> Vec<u8> { e.players[st.owner].pubkey().to_bytes().to_vec() }
fn row(e: &Env, s: &Season, i: usize) -> Vec<u8> { e.data(&s.roster)[RO_HDR + i * 32..RO_HDR + i * 32 + 32].to_vec() }
fn sealed_commit(e: &Env, st: &Strat) -> Vec<u8> { e.data(&e.strat_pda(st.id))[48..80].to_vec() }
fn blank(e: &Env, s: &Season, i: usize) -> bool { e.receipt_owner(s, i).iter().all(|&b| b == 0) && e.receipt_commit(s, i).iter().all(|&b| b == 0) }
/// every entry of the receipt names the owner at entry and the commitment of the code that ran
fn assert_attributed(e: &Env, s: &Season, why: &str) { let d = e.data(&s.receipt); assert_eq!(usize::from(d[rc::NS]), s.entries.len(), "{}", why); for (i, st) in s.entries.iter().enumerate() { assert_eq!(rd64(&d, RC_ENT + i * 80), st.id, "{} entry {} id", why, i); assert_eq!(e.receipt_owner(s, i), owner_of(e, st), "{} entry {} owner", why, i); assert_eq!(e.receipt_commit(s, i), code_commit(&st.salt, &st.code).to_vec(), "{} entry {} commitment", why, i); }
    for i in s.entries.len()..20 { assert!(blank(e, s, i), "{}: unused seat {} stays empty", why, i); } }

// ================= the roster =================
#[test] fn create_season_makes_a_private_roster_and_enter_copies_each_sealed_commitment_into_it() {
    let mut e = Env::new(5); e.model_rent(); let st = sealed(&mut e, 5); let s = { let mut s = e.season(500); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); s };
    let ro = e.data(&s.roster); assert_eq!((ro.len(), rd32(&ro, 0), ro[4], rd64(&ro, 8)), (roster_size(20), M_ROSTER, 20, 500));
    // its permission was created with NO members (68 bytes + 0 members, plus 60 overhead): nobody may read it
    assert_eq!(e.rent_held.as_ref().unwrap()[&(true, s.roster)], eph_rent(68), "private, with no members, like the arena");
    let mut s = s; for (i, t) in st.iter().enumerate() { assert!(row(&e, &s, i).iter().all(|&b| b == 0)); assert!(e.enter(&mut s, t).is_ok()); assert_eq!(row(&e, &s, i), sealed_commit(&e, t), "row {} is the sealed account's commitment", i); assert_eq!(row(&e, &s, i), code_commit(&t.salt, &t.code).to_vec()); }
    // until Settle or Cancel, the public receipt says nothing about the field
    play(&mut e, &mut s, 1); let d = e.data(&s.receipt); assert_eq!(d[rc::NS], 0); for i in 0..5 { assert!(blank(&e, &s, i)); assert_eq!(rd64(&d, RC_ENT + i * 80), 0, "not even the ids, before Settle"); }
}

#[test] fn enter_needs_this_seasons_writable_roster_and_refuses_without_moving_anything() {
    let mut e = Env::new(5); let st = sealed(&mut e, 2); let s = open(&mut e, 501, &[], 10, false); let other = open(&mut e, 502, &[], 10, false); let bal = e.balance(&e.players[0].pubkey());
    let try_with = |e: &mut Env, meta: Option<AccountMeta>, what: &str| { let mut ix = e.enter_ix(&s, &st[0], 0); match meta { Some(m) => ix.accounts[8] = m, None => ix.accounts.truncate(8) } e.fresh_blockhash(); let kp = e.player(0); errs(&e.send(&[ix], &[&kp]), what); assert_eq!((e.data(&s.arena)[ar::NS], e.open_count(st[0].id), e.balance(&e.players[0].pubkey())), (0, 0, bal), "{}: nothing entered, no fee", what); };
    try_with(&mut e, Some(AccountMeta::new(other.roster, false)), "another season's roster"); try_with(&mut e, Some(AccountMeta::new_readonly(s.roster, false)), "its roster read-only"); try_with(&mut e, Some(AccountMeta::new(s.arena, false)), "an account that is not a roster"); try_with(&mut e, None, "no roster at all");
    assert!(other.entries.is_empty() && row(&e, &other, 0).iter().all(|&b| b == 0), "the other roster was not written"); let mut s = s.clone(); assert!(e.enter(&mut s, &st[0]).is_ok());
}

// ================= attribution on the receipt =================
#[test] fn settle_attributes_every_entry_even_when_none_is_ever_published() {
    let mut e = Env::new(5); e.params.grace = MIN_GRACE; let st = sealed(&mut e, 5); let mut s = open(&mut e, 510, &st, 10, true); play(&mut e, &mut s, 2); assert!(e.settle(&s).is_ok());
    assert_attributed(&e, &s, "after Settle, nothing published"); let d = e.data(&s.receipt); assert_eq!(d[rc::PUB], 0); for i in 0..5 { assert!(d[RC_ENT + i * 80 + 40..RC_ENT + i * 80 + 72].iter().all(|&b| b == 0), "no score commitment without Publish"); assert!(rd32(&d, RC_ENT + i * 80 + rc::E_FRANK) >= 1, "but the rank is there"); }
    // nobody publishes; after the grace the arena is destroyed. Who got which rank stays on the receipt
    e.warp(MIN_GRACE + 1); e.fresh_blockhash(); assert!(e.cleanup(&s).is_ok()); assert_attributed(&e, &s, "after Cleanup with every publication dropped");
}

#[test] fn publish_adds_the_score_commitment_and_changes_no_attribution() {
    let mut e = Env::new(20); let st = sealed(&mut e, 20); let mut s = open(&mut e, 511, &st, 10, false); play(&mut e, &mut s, 3); assert!(e.settle_publishing(&s, 7).is_ok()); assert_attributed(&e, &s, "20 entries, 7 published inline"); let before: Vec<(Vec<u8>, Vec<u8>)> = (0..20).map(|i| (e.receipt_owner(&s, i), e.receipt_commit(&s, i))).collect();
    for i in 7..20 { assert!(e.publish(&s, i).is_ok()); } assert_eq!((0..20).map(|i| (e.receipt_owner(&s, i), e.receipt_commit(&s, i))).collect::<Vec<_>>(), before); assert_eq!(e.data(&s.receipt)[rc::PUB], 20);
}

#[test] fn publish_refuses_a_strategy_whose_commitment_is_not_the_one_attributed() {
    let mut e = Env::new(5); let st = sealed(&mut e, 2); let mut s = open(&mut e, 512, &st, 10, false); play(&mut e, &mut s, 4); assert!(e.settle(&s).is_ok());
    // not reachable by a transaction (a sealed commitment never changes): the receipt is edited by hand, to show Publish cross-checks rather than overwrites
    e.set_data(&s.receipt, |d| d[RC_ENT + 8] ^= 1); rejects(&e.publish(&s, 0), 9022, "a commitment that is not the roster's"); assert_eq!(e.data(&s.receipt)[rc::PUB], 0); e.set_data(&s.receipt, |d| d[RC_ENT + 8] ^= 1); e.fresh_blockhash(); assert!(e.publish(&s, 0).is_ok());
}

#[test] fn attribution_is_the_owner_and_commitment_at_entry_not_whatever_the_registry_says_later() {
    let mut e = Env::new(5); let st = sealed(&mut e, 2); let mut s = open(&mut e, 513, &st, 10, false); let want: Vec<Vec<u8>> = st.iter().map(|t| owner_of(&e, t)).collect();
    // change the registry after Enter (no instruction can do this; set by hand) and the receipt still names who entered
    let rk = e.reg_pda(st[0].id); e.set_data(&rk, |d| { d[8] ^= 0xff; d[48] ^= 0xff; }); play(&mut e, &mut s, 5); assert!(e.settle(&s).is_ok()); for i in 0..2 { assert_eq!(e.receipt_owner(&s, i), want[i]); assert_eq!(e.receipt_commit(&s, i), code_commit(&st[i].salt, &st[i].code).to_vec()); }
}

#[test] fn cancel_attributes_every_entry_on_each_of_its_four_paths() {
    let mut e = Env::new(5); e.params.seedto = 100; e.params.window = 100; e.params.mins = 1; let st = sealed(&mut e, 3);
    // the creator, while unlocked
    let s = open(&mut e, 520, &st, 10, false); assert!(e.cancel(&s).is_ok()); assert_attributed(&e, &s, "creator cancel"); let d = e.data(&s.receipt); assert_eq!(d[rc::KIND], 2); for i in 0..3 { assert_eq!(rd32(&d, RC_ENT + i * 80 + rc::E_FRANK), 0, "a cancelled season has no result"); }
    // under-minimum Lock
    e.params.mins = 3; let s = open(&mut e, 521, &st[..2], 10, false); e.warp(101); e.fresh_blockhash(); assert!(e.lock_by(&s, 4).is_ok()); assert!(e.cancel_by(&s, 4).is_ok()); assert_attributed(&e, &s, "under the minimum"); e.params.mins = 1;
    // seed timeout
    let s = open(&mut e, 522, &st, 10, false); assert!(e.lock(&s).is_ok()); e.warp(101); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok()); assert_attributed(&e, &s, "seed timeout");
    // season deadline
    let mut s = open(&mut e, 523, &st, 10, false); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, seed_of(6)).is_ok()); let dl = phase_deadline(rd64(&e.data(&s.arena), ar::START), 2, 1); let by = dl - e.slot; e.warp(by); e.fresh_blockhash(); assert!(e.cancel_by(&s, 4).is_ok()); assert_attributed(&e, &s, "season deadline");
    // an empty season
    let s = open(&mut e, 524, &[], 10, false); assert!(e.cancel(&s).is_ok()); assert_attributed(&e, &s, "no entrants");
}

/// Cancel runs once. Before this build it wrote the receipt only "if it could", so anyone allowed to cancel could have left a season with no record of who was in it.
#[test] fn cancel_cannot_skip_the_record() {
    let mut e = Env::new(5); e.params.seedto = 100; let st = sealed(&mut e, 3); let s = open(&mut e, 530, &st, 10, false); let other = open(&mut e, 531, &st[..1], 10, false); assert!(e.lock(&s).is_ok()); e.warp(101); e.fresh_blockhash();
    let kp = e.player(4); let base = e.cancel_ix(&s, kp.pubkey()); let before = (e.data(&s.arena)[ar::F2], e.data(&s.claims), e.data(&s.receipt));
    let mut cases: Vec<(Instruction, &str)> = vec![];
    for (meta, what) in [(AccountMeta::new_readonly(s.receipt, false), "the receipt read-only"), (AccountMeta::new(other.receipt, false), "another season's receipt"), (AccountMeta::new(Address::new_unique(), false), "an account that does not exist")] { let mut ix = base.clone(); ix.accounts[5] = meta; cases.push((ix, what)); }
    for (meta, what) in [(AccountMeta::new_readonly(other.roster, false), "another season's roster"), (AccountMeta::new_readonly(s.arena, false), "no roster in the roster's place")] { let mut ix = base.clone(); ix.accounts[6] = meta; cases.push((ix, what)); }
    { let mut ix = base.clone(); ix.accounts.truncate(5); cases.push((ix, "no receipt")); } { let mut ix = base.clone(); ix.accounts.truncate(6); cases.push((ix, "no roster")); }
    for (ix, what) in cases { e.fresh_blockhash(); errs(&e.send(&[ix], &[&kp]), what); assert_eq!((e.data(&s.arena)[ar::F2], e.data(&s.claims), e.data(&s.receipt)), before, "{}: no refund recorded, nothing cancelled", what); }
    assert!(e.cancel_by(&s, 4).is_ok()); assert_attributed(&e, &s, "then properly"); assert_eq!(e.data(&other.receipt)[rc::NS], 0);
}

#[test] fn settle_needs_this_seasons_roster() {
    let mut e = Env::new(5); let st = sealed(&mut e, 2); let mut s = open(&mut e, 540, &st, 10, false); let other = open(&mut e, 541, &st, 10, false); play(&mut e, &mut s, 7);
    for (meta, what) in [(AccountMeta::new_readonly(other.roster, false), "another season's roster"), (AccountMeta::new_readonly(s.claims, false), "an account that is not a roster")] { let mut ix = e.settle_ix(&s); ix.accounts[6] = meta; e.fresh_blockhash(); rejects(&e.send(&[ix], &[]), 9142, what); assert_eq!(e.data(&s.receipt)[rc::NS], 0); assert!(!e.claim_totals(&s).0, "nothing recorded"); }
    e.fresh_blockhash(); assert!(e.settle(&s).is_ok()); assert_attributed(&e, &s, "settled");
}

#[test] fn cleanup_closes_the_roster_and_needs_the_right_one() {
    let mut e = Env::new(5); e.model_rent(); let st = sealed(&mut e, 2); let hub1 = e.lamports(&e.hub); let mut s = open(&mut e, 550, &st, 10, false); let other = open(&mut e, 551, &[], 10, false); play(&mut e, &mut s, 8); assert!(e.settle_publishing(&s, 2).is_ok()); e.claim_all(&s); assert!(e.close_claims(&s).is_ok());
    let mut ix = e.cleanup_ix(&s); ix.accounts[8] = AccountMeta::new(other.roster, false); e.fresh_blockhash(); rejects(&e.send(&[ix], &[]), 9142, "another season's roster");
    assert!(e.cleanup(&s).is_ok()); assert!(e.data(&s.roster).is_empty(), "the roster is gone with its arena"); assert!(e.rent_held.as_ref().unwrap().keys().all(|k| k.1 != s.roster && k.1 != s.arena));
    assert!(e.cancel(&other).is_ok()); assert!(e.close_claims(&other).is_ok()); assert!(e.cleanup(&other).is_ok()); assert_eq!(e.lamports(&e.hub) - hub1, BOND / 4, "both seasons returned all their rent, rosters included; the hub is up by exactly the second one's 25% forfeit"); }

// ================= the receipt format and the previous one =================
#[test] fn a_new_receipt_says_its_format_and_a_previous_one_cannot_start_anything() {
    assert_eq!((RC_OWNERS, RC_SIZE, RC_V2_SIZE), (1824, 2464, 1824)); let mut e = Env::new(5); let s = e.season(560); assert!(e.init_receipt(&s).is_ok()); let d = e.data(&s.receipt); assert_eq!((d.len(), d[RC_FORMAT]), (RC_SIZE, RECEIPT_FORMAT));
    // a previous-build receipt: 1824 bytes, byte 146 never written
    let shrink = |e: &mut Env, k: &Address| { let mut acc = e.svm.get_account(k).unwrap(); acc.data.truncate(RC_V2_SIZE); acc.data[RC_FORMAT] = 0; e.svm.set_account(*k, acc).unwrap(); };
    shrink(&mut e, &s.receipt); e.provision_if_new(s.arena, arena_size(20)); e.provision_side(&s, 20); let ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9020, "CreateSeason on a previous-format receipt");
    // the right length is not enough: the format byte is required too
    let t = e.season(561); assert!(e.init_receipt(&t).is_ok()); e.set_data(&t.receipt, |d| d[RC_FORMAT] = 0); e.provision_if_new(t.arena, arena_size(20)); e.provision_side(&t, 20); let ix = e.create_season_ix(&t, 2, 1, 10, 20, 0, 2); rejects(&e.send(&[ix], &[]), 9020, "CreateSeason without the format byte");
}

#[test] fn a_previous_format_receipt_keeps_its_bond_paths() {
    // closed with an unreleased bond: commit+undelegate and ReleaseBond. Stranded open: RecoverBond, then the same
    let mut e = Env::new(5);
    for (sid, stranded) in [(570u64, false), (571, true)] {
        let s = e.season(sid); assert!(e.init_receipt(&s).is_ok()); let mut acc = e.svm.get_account(&s.receipt).unwrap(); acc.data.truncate(RC_V2_SIZE); acc.data[RC_FORMAT] = 0; acc.data[rc::SEASON..rc::SEASON + 8].copy_from_slice(&sid.to_le_bytes()); acc.data[rc::NS] = 2; acc.data[rc::STATE] = if stranded { 1 } else { 2 }; if !stranded { acc.data[rc::RELEASE..rc::RELEASE + 8].copy_from_slice(&BOND.to_le_bytes()); } e.svm.set_account(s.receipt, acc).unwrap();
        if stranded { let p = e.payer.pubkey(); let ix = e.ix(21, vec![e.m(p, true, true), e.ro(e.config), e.rw(s.receipt), e.ro(s.arena)], sid.to_le_bytes().to_vec()); e.fresh_blockhash(); let r = e.send(&[ix], &[]); assert!(r.is_ok(), "RecoverBond: {}", err_string(&r)); }
        assert!(e.commit_undelegate(&[s.receipt]).is_ok()); let c0 = e.lamports(&e.payer.pubkey()); let r = e.release_bond(&s); assert!(r.is_ok(), "ReleaseBond: {}", err_string(&r)); assert_eq!(e.lamports(&e.payer.pubkey()) + r.unwrap().fee - c0, BOND);
    }
}

// ================= the derived score salt =================
#[test] fn a_seasons_totals_are_provable_without_the_salt_behind_the_code_commitment() {
    let mut e = Env::new(5); let st = sealed(&mut e, 5); let mut out = vec![];
    for sid in [580u64, 581] { let mut s = open(&mut e, sid, &st, 10, true); play(&mut e, &mut s, (sid % 250) as u8); assert!(e.settle_publishing(&s, 5).is_ok()); let ex = expect(&s, true); out.push((s, ex)); }
    for (s, ex) in &out { let d = e.data(&s.receipt);
        for (i, t) in st.iter().enumerate() { let on_chain = &d[RC_ENT + i * 80 + 40..RC_ENT + i * 80 + 72]; let (fin, fneps) = if ex.finalist[i] { (ex.finals[i], FINALS_EPISODES) } else { (0, 0) };
            // what the owner hands a verifier: the season's score salt and the totals. Nothing else
            let ssalt = score_salt(&t.salt, s.sid); assert_eq!(&score_commit_with(&ssalt, s.sid, t.id, ex.season[i], fin, s.neps, fneps)[..], on_chain, "entry {}", i);
            assert_ne!(&score_commit_with(&ssalt, s.sid, t.id, ex.season[i] + 1, fin, s.neps, fneps)[..], on_chain, "a different total does not verify");
            // it is not the secret behind the code commitment, and does not open it
            assert_ne!(ssalt, t.salt); assert_ne!(code_commit(&ssalt, &t.code).to_vec(), e.receipt_commit(s, i)); assert_eq!(code_commit(&t.salt, &t.code).to_vec(), e.receipt_commit(s, i), "the code commitment is unchanged");
            // the previous scheme, keyed by the sealed salt itself, is gone
            let v2 = sha256(&[b"CNCL-SCORE-v2", &t.salt, &s.sid.to_le_bytes(), &t.id.to_le_bytes(), &ex.season[i].to_le_bytes(), &fin.to_le_bytes(), &s.neps.to_le_bytes(), &fneps.to_le_bytes()]); assert_ne!(&v2[..], on_chain);
            assert!(!d.windows(32).any(|w| w == ssalt || w == t.salt), "neither salt is on the receipt"); } }
    for t in &st { assert_ne!(score_salt(&t.salt, 580), score_salt(&t.salt, 581), "one season's score salt opens no other season"); }
}

// ================= the permanent id marker =================
#[test] fn close_registry_leaves_a_permanent_marker_so_the_id_is_never_registered_again() {
    let mut e = Env::new(5); let st = sealed(&mut e, 1); let t = st[0].clone(); let rk = e.reg_pda(t.id); let ow = e.players[t.owner].pubkey(); assert!(e.close_strategy(&t).is_ok()); assert!(e.commit_undelegate(&[rk]).is_ok());
    // the harness runs with rent at zero; this part runs at the rate devnet showed (5,080 lamports per byte, 128 bytes of overhead) so the marker's rent is real
    let mut rent = solana_rent::Rent::default(); rent.lamports_per_byte = 5_080; e.svm.set_sysvar(&rent); let keep = (128 + MARKER_SIZE as u64) * 5_080; assert_eq!(keep, 690_880);
    let (held, o0) = (e.lamports(&rk), e.lamports(&ow)); let r = e.close_registry(&t); assert!(r.is_ok(), "CloseRegistry: {}", err_string(&r));
    let m = e.svm.get_account(&rk).expect("the marker stays"); assert_eq!((m.data.len(), rd32(&m.data, 0), rd32(&m.data, 4), m.owner), (MARKER_SIZE, M_REG_DEAD, 0, e.pid)); assert_eq!(m.lamports, keep, "exactly rent-exempt for 8 bytes"); assert_eq!(e.lamports(&ow) - o0, held - keep, "the owner gets everything else");
    // nobody can take the id again: not the old owner, not a stranger, not later
    for who in [t.owner, 3] { let kp = e.player(who); let mut d = t.id.to_le_bytes().to_vec(); d.extend([9u8; 32]); let ix = e.ix(1, vec![e.m(e.players[who].pubkey(), true, true), e.rw(rk), e.ro(a(SYSTEM))], d); e.fresh_blockhash(); errs(&e.send(&[ix], &[&kp]), "registering a retired id"); }
    e.warp(1_000_000_000); { let kp = e.player(3); let mut d = t.id.to_le_bytes().to_vec(); d.extend([9u8; 32]); let ix = e.ix(1, vec![e.m(e.players[3].pubkey(), true, true), e.rw(rk), e.ro(a(SYSTEM))], d); e.fresh_blockhash(); errs(&e.send(&[ix], &[&kp]), "years later"); }
    // and the marker is inert: it cannot be removed again, sealed against, delegated, or undelegated
    rejects(&e.close_registry(&t), 9132, "CloseRegistry on a marker"); errs(&e.seal(&t), "sealing a retired id"); { let r = e.commit_undelegate(&[rk]); rejects(&r, 9055, "undelegating a marker"); }
    { let mut d = vec![1u8]; d.extend(t.id.to_le_bytes()); let kp = e.player(t.owner); let ix = e.ix(2, vec![e.m(ow, true, true), e.ro(a(SYSTEM)), e.rw(rk), e.ro(e.pid), e.rw(pda(&[b"buffer", rk.as_ref()], &e.pid)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique())], d); e.fresh_blockhash(); errs(&e.send(&[ix], &[&kp]), "delegating a marker"); }
    assert_eq!(e.svm.get_account(&rk).unwrap().data, m.data); assert_eq!(e.lamports(&rk), keep);
}

#[test] fn registry_delegation_by_its_owner_still_works() {
    // the receipt rule is for receipts only: a registry owner still delegates, which every strategy needs
    let mut e = Env::new(3); let t = e.register(0, "a", code_of("Mom20th")); let rk = e.reg_pda(t.id); let mut d = vec![1u8]; d.extend(t.id.to_le_bytes()); let ix = e.ix(2, vec![e.m(e.players[0].pubkey(), true, true), e.ro(a(SYSTEM)), e.rw(rk), e.ro(e.pid), e.rw(pda(&[b"buffer", rk.as_ref()], &e.pid)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique())], d); let kp = e.player(0); let r = e.send(&[ix], &[&kp]); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(e.svm.get_account(&rk).unwrap().owner, a(DLP));
}

// ================= transaction sizes =================
#[test] fn the_extra_accounts_still_fit_cancel_and_cleanup_naming_twenty_strategies() {
    let mut e = Env::new(20); let st = sealed(&mut e, 20); let ids: Vec<u64> = st.iter().map(|x| x.id).collect();
    let size = |e: &Env, ix: &Instruction| { let mut d = vec![2u8]; d.extend(1_400_000u32.to_le_bytes()); let cb = Instruction { program_id: a("ComputeBudget111111111111111111111111111111"), accounts: vec![], data: d }; solana_message::Message::new(&[cb, ix.clone()], Some(&e.payer.pubkey())).serialize().len() + 1 + 64 };
    let s = open(&mut e, 590, &st, 10, false); let cx = e.with_strats(e.cancel_ix(&s, e.payer.pubkey()), &ids); let n1 = size(&e, &cx); let r = e.send(&[cx], &[]); assert!(r.is_ok(), "{}", err_string(&r)); let c1 = r.unwrap().compute_units_consumed;
    let s2 = open(&mut e, 591, &st, 10, false); assert!(e.cancel(&s2).is_ok()); let cl = e.with_strats(e.cleanup_ix(&s2), &ids); let n2 = size(&e, &cl); let r = e.send(&[cl], &[]); assert!(r.is_ok(), "{}", err_string(&r)); let c2 = r.unwrap().compute_units_consumed;
    println!("METER 4A release 20: Cancel {} bytes {} CU; Cleanup {} bytes {} CU", n1, c1, n2, c2); assert!(n1 <= 1232 && n2 <= 1232, "{} {}", n1, n2);
}
#[test] fn create_enter_and_settle_stay_inside_their_compute_limits() {
    let mut e = Env::new(20); let st = sealed(&mut e, 20); let mut s = e.season(592); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); e.provision_if_new(s.arena, arena_size(20)); e.provision_side(&s, 20); s.neps = 2; s.fee = 10;
    let ix = e.create_season_ix(&s, 2, 1, 10, 20, 0, 2); let r = e.send(&[ix], &[]); assert!(r.is_ok()); let create = r.unwrap().compute_units_consumed; let mut enter = 0; for t in &st { let ix = e.enter_ix(&s, t, t.owner); let kp = e.player(t.owner); let r = e.send(&[ix], &[&kp]); assert!(r.is_ok()); enter = enter.max(r.unwrap().compute_units_consumed); s.entries.push(t.clone()); }
    play(&mut e, &mut s, 9); let r = e.settle(&s); assert!(r.is_ok()); let settle = r.unwrap().compute_units_consumed; println!("METER 4A 20 seats: CreateSeason {} CU (stand-in CPIs), worst Enter {} CU, Settle {} CU", create, enter, settle); assert!(create < 400_000 && enter < 200_000 && settle < 200_000);
}
