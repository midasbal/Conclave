//! Phase 6: the registry pays for a sealed strategy, a payer flag says who is repaid at close, and every season has a public terms record that Enter is checked against.
//! Real program bytecode, signatures verified. The Magic stand-in applies the real sponsor rules (signer, writable, holds the rent); ephemeral rent moves from the CPIs the program really makes (common/mod.rs, `model_rent`).
//! NOT modelled: that the rollup grants write access only to a delegated account (a registry that is not delegated is represented here by one passed read-only), and what the program's own in-instruction balance
//! reads after a rent CPI (the stand-ins move no lamports; the harness applies them after the transaction), so the program's second, post-CPI rent-exempt check is shown on devnet only.
mod common;
use common::*;
use solana_instruction::{AccountMeta, Instruction};

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn env(n: usize) -> Env { let mut e = Env::new(n); e.model_rent(); e }
fn rejects(r: &Res, code: u32, what: &str) { assert_eq!(custom(r), Some(code), "{}: expected Custom {}, got {}", what, code, err_string(r)); }
fn errs(r: &Res, what: &str) { assert!(r.is_err() && !failed_to_complete(r), "{} should be refused with an error, got {}", what, err_string(r)); }
fn send_as(e: &mut Env, ix: Instruction, who: usize) -> Res { e.fresh_blockhash(); let k = e.player(who); e.send(&[ix], &[&k]) }
fn sealed(e: &mut Env, n: usize) -> Vec<Strat> { (0..n).map(|i| e.register_and_seal(i % e.players.len(), NAMES[i % 5], code_of(NAMES[i % 5]))).collect() }
fn season_with(e: &mut Env, sid: u64, fee: u64, finals: bool) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); let r = e.create_season(&mut s, if finals { 15 } else { 2 }, fee, 20, finals, 2); assert!(r.is_ok(), "CreateSeason {}", err_string(&r)); s }
fn tx_size(e: &Env, ix: &Instruction) -> usize { let mut d = vec![2u8]; d.extend(1_400_000u32.to_le_bytes()); let cb = Instruction { program_id: a("ComputeBudget111111111111111111111111111111"), accounts: vec![], data: d }; solana_message::Message::new(&[cb, ix.clone()], Some(&e.payer.pubkey())).serialize().len() + 1 + 64 }

// ================= 1. the registry pays =================
#[test] fn seal_is_paid_by_the_owners_registry_and_the_hub_pays_nothing() {
    let mut e = env(3); let st = e.register(1, "a", code_of("Mom20th")); let rk = e.reg_pda(st.id); let ow = e.players[1].pubkey(); let (h0, r0, o0) = (e.lamports(&e.hub), e.lamports(&rk), e.lamports(&ow)); assert!(r0 >= 2_000_000, "what the owner put in at Register");
    let r = e.seal(&st); assert!(r.is_ok(), "Seal: {}", err_string(&r));
    assert_eq!((r0 - e.lamports(&rk), e.lamports(&e.hub), e.lamports(&ow)), (20_000, h0, o0), "the registry paid exactly 20,000; the hub and the owner's wallet did not move");
    let held = e.rent_held.as_ref().unwrap(); let k = e.strat_pda(st.id); assert_eq!((held[&(false, k)], held[&(true, k)]), (eph_rent(STRAT_SIZE), eph_rent(PERM_LEN)), "the sealed account and its permission are what the vault holds"); assert_eq!(held[&(false, k)] + held[&(true, k)], 20_000);
    assert_eq!((e.open_raw(st.id), e.open_count(st.id), e.registry_paid(st.id)), (S_PAYER_REG, 0, true), "the payer flag is set and no entry is open");
    let d = e.data(&k); assert_eq!(rd32(&d, 0), 0x5354_5254); assert_eq!(&d[8..40], ow.as_ref()); assert_eq!(&d[40..48], &st.id.to_le_bytes()); assert_eq!(&d[48..80], &code_commit(&st.salt, &st.code)); assert_eq!(&d[104..136], &st.salt); assert_eq!(&d[136..136 + st.code.len()], &st.code[..]);
    assert_eq!(rd32(&e.data(&rk), 0), M_REG, "the registry is still an open registry");
}
#[test] fn seal_refuses_a_registry_that_cannot_or_must_not_pay_and_creates_nothing() {
    let mut e = env(4); let st = e.register(1, "a", code_of("Mom20th")); let other = e.register(2, "b", code_of("EMAcross")); let (k, rk) = (e.strat_pda(st.id), e.reg_pda(st.id)); e.provision_if_new(k, STRAT_SIZE);
    let snap = |e: &Env| (e.data(&k), e.lamports(&rk), e.lamports(&e.hub), e.rent_held.as_ref().unwrap().len());
    let s0 = snap(&e);
    // the registry read-only: the rollup would refuse a registry that is not delegated, and the program says so first, before anything is created
    let mut ix = e.seal_ix(&st, 1); ix.accounts[6].is_writable = false; rejects(&send_as(&mut e, ix, 1), E_ENTRY_REGISTRY, "an undelegated (read-only) registry"); assert_eq!(snap(&e), s0, "nothing was created and nothing moved");
    // not this strategy's registry, a registry of the same owner, an account that is not a registry, no registry at all
    let mut ix = e.seal_ix(&st, 1); ix.accounts[6] = AccountMeta::new(e.reg_pda(other.id), false); errs(&send_as(&mut e, ix, 1), "another strategy's registry"); assert_eq!(snap(&e), s0);
    let own2 = e.register(1, "c", code_of("TrendSwitch")); let mut ix = e.seal_ix(&st, 1); ix.accounts[6] = AccountMeta::new(e.reg_pda(own2.id), false); errs(&send_as(&mut e, ix, 1), "another registry of the same owner"); assert_eq!(snap(&e), s0);
    let mut ix = e.seal_ix(&st, 1); ix.accounts[6] = AccountMeta::new(e.hub, false); errs(&send_as(&mut e, ix, 1), "the hub offered as the registry"); let mut ix = e.seal_ix(&st, 1); ix.accounts.truncate(6); errs(&send_as(&mut e, ix, 1), "no registry"); assert_eq!(snap(&e), s0);
    // someone else's signature, a code that is not the registered one
    let ix = e.seal_ix(&st, 2); errs(&send_as(&mut e, ix, 2), "another wallet seals it"); let mut bad = st.clone(); bad.code = code_of("EMAcross"); let ix = e.seal_ix(&bad, 1); errs(&send_as(&mut e, ix, 1), "other code than the commitment"); assert_eq!(snap(&e), s0);
    // the previous build's account list (the hub second, the registry last and read-only)
    let mut ix = e.seal_ix(&st, 1); ix.accounts.insert(1, e.rw(e.hub)); ix.accounts[7].is_writable = false; errs(&send_as(&mut e, ix, 1), "the previous build's account list"); assert_eq!(snap(&e), s0);
    // a registry closed by its owner, or one that cannot cover the rent
    let good = e.data(&rk); e.set_data(&rk, |d| d[0..4].copy_from_slice(&M_REG_CLOSED.to_le_bytes())); let ix = e.seal_ix(&st, 1); errs(&send_as(&mut e, ix, 1), "a closed registry"); e.set_data(&rk, |d| *d = good.clone());
    let mut acc = e.svm.get_account(&rk).unwrap(); let rich = acc.lamports; acc.lamports = 19_999; e.svm.set_account(rk, acc).unwrap(); let ix = e.seal_ix(&st, 1); rejects(&send_as(&mut e, ix, 1), E_REG_RENT, "a registry that holds less than the rent"); assert_eq!(e.data(&k), s0.0);
    let mut acc = e.svm.get_account(&rk).unwrap(); acc.lamports = rich; e.svm.set_account(rk, acc).unwrap(); let r = e.seal(&st); assert!(r.is_ok(), "and with its own writable registry it seals: {}", err_string(&r));
    let ix = e.seal_ix(&st, 1); errs(&send_as(&mut e, ix, 1), "sealing the same id twice");
}
#[test] fn the_registry_must_stay_rent_exempt_after_paying() {
    // the harness runs with rent at zero; this test sets a real one, after the registry exists, so the floor is 256 x 5,000 = 1,280,000 for 128 bytes
    let mut e = env(3); let st = e.register(1, "a", code_of("Mom20th")); let (k, rk) = (e.strat_pda(st.id), e.reg_pda(st.id));
    let mut rent = solana_rent::Rent::default(); rent.lamports_per_byte = 5_000; e.svm.set_sysvar(&rent); let floor = 256 * 5_000u64;
    let mut sacc = solana_account::Account { lamports: 10_000_000, data: vec![0; STRAT_SIZE], owner: e.pid, executable: false, rent_epoch: 0 }; e.svm.set_account(k, sacc.clone()).unwrap();
    let set = |e: &mut Env, lamports: u64| { let mut acc = e.svm.get_account(&rk).unwrap(); acc.lamports = lamports; e.svm.set_account(rk, acc).unwrap(); };
    set(&mut e, floor + 19_999); let ix = e.seal_ix(&st, 1); rejects(&send_as(&mut e, ix, 1), E_REG_RENT, "one lamport short of floor + rent"); assert_eq!(e.data(&k), vec![0u8; STRAT_SIZE]); assert_eq!(e.lamports(&rk), floor + 19_999, "nothing moved");
    set(&mut e, floor + 20_000); let ix = e.seal_ix(&st, 1); let r = send_as(&mut e, ix, 1); assert!(r.is_ok(), "exactly floor + rent: {}", err_string(&r)); assert_eq!(e.lamports(&rk), floor, "it ends exactly at the rent-exempt minimum, no lower"); sacc.lamports = 0;
}

// ================= 2. the payer flag: who is repaid =================
#[test] fn the_flag_survives_every_change_of_the_open_count() {
    let mut e = env(5); let st = sealed(&mut e, 3); assert!(st.iter().all(|t| e.registry_paid(t.id)));
    let mut a_ = season_with(&mut e, 10, 10, false); for t in &st { assert!(e.enter(&mut a_, t).is_ok()); } for t in &st { assert_eq!((e.open_raw(t.id), e.open_count(t.id)), (S_PAYER_REG | 1, 1), "entered: count 1, flag kept"); }
    let b = { let mut s = season_with(&mut e, 11, 10, false); for t in &st[..2] { assert!(e.enter(&mut s, t).is_ok()); } s }; assert_eq!((e.open_raw(st[0].id), e.open_raw(st[2].id)), (S_PAYER_REG | 2, S_PAYER_REG | 1));
    assert!(e.cancel(&b).is_ok()); let ids: Vec<u64> = st[..2].iter().map(|t| t.id).collect(); let ix = e.with_strats(e.cleanup_ix(&b), &ids); assert!(e.send(&[ix], &[]).is_ok()); assert_eq!((e.open_raw(st[0].id), e.open_raw(st[1].id)), (S_PAYER_REG | 1, S_PAYER_REG | 1), "released by Cleanup: count down, flag kept");
    assert!(e.lock(&a_).is_ok()); assert!(e.request_seed(&a_).is_ok()); assert!(e.deliver_seed(&mut a_, seed_of(3)).is_ok()); e.drive(&a_, 1400, 1_400_000); assert!(e.settle_publishing(&a_, 1).is_ok()); assert_eq!(e.open_raw(st[0].id), S_PAYER_REG, "published inline: zero open, flag kept"); assert!(e.publish(&a_, 1).is_ok()); assert!(e.publish(&a_, 2).is_ok());
    for t in &st { assert_eq!((e.open_count(t.id), e.registry_paid(t.id)), (0, true)); }
}
#[test] fn a_strategy_of_the_previous_build_never_gains_the_flag_and_a_new_one_is_repaid_by_its_registry() {
    let mut e = env(5); let new = sealed(&mut e, 2); let old = { let v = sealed(&mut e, 2); for t in &v { e.as_previous_build(t); } v };
    assert_eq!((e.registry_paid(new[0].id), e.registry_paid(old[0].id)), (true, false)); let mut s = season_with(&mut e, 20, 10, false); for t in new.iter().chain(old.iter()) { assert!(e.enter(&mut s, t).is_ok()); } assert_eq!((e.registry_paid(old[0].id), e.open_count(old[0].id)), (false, 1), "entering sets no flag on an old strategy");
    assert!(e.cancel(&s).is_ok()); let ids: Vec<u64> = new.iter().chain(old.iter()).map(|t| t.id).collect(); let ix = e.with_strats(e.cleanup_ix(&s), &ids); assert!(e.send(&[ix], &[]).is_ok());
    // each is repaid by whoever paid it, in the same world, in either order; the other party does not move
    for t in [&old[0], &new[0], &new[1], &old[1]] { let rk = e.reg_pda(t.id); let (h0, r0) = (e.lamports(&e.hub), e.lamports(&rk)); let by_reg = e.registry_paid(t.id); let r = e.close_strategy(t); assert!(r.is_ok(), "{}", err_string(&r));
        assert_eq!((e.lamports(&e.hub) - h0, e.lamports(&rk) - r0), if by_reg { (0, 20_000) } else { (20_000, 0) }, "{}", if by_reg { "registry repaid" } else { "hub repaid" }); }
    assert_eq!(e.vault_total(), 7_808 + 34_944, "only the season's own accounts are left in the vault (claims and terms: Cleanup closed the arena and the roster), none of the strategies' rent");
}
#[test] fn a_flagged_strategy_ignores_the_hub_slot_and_an_unflagged_one_needs_the_real_hub() {
    let mut e = env(4); let new = sealed(&mut e, 1); let old = { let v = sealed(&mut e, 1); e.as_previous_build(&v[0]); v };
    let mut ix = e.close_strategy_ix(old[0].id, old[0].owner); ix.accounts[1] = AccountMeta::new(e.players[3].pubkey(), false); let h = e.lamports(&e.players[3].pubkey()); errs(&send_as(&mut e, ix, old[0].owner), "an old strategy, another account where the hub goes"); assert_eq!(e.lamports(&e.players[3].pubkey()), h); assert!(!e.data(&e.strat_pda(old[0].id)).iter().all(|b| *b == 0), "and it is still sealed");
    let mut ix = e.close_strategy_ix(new[0].id, new[0].owner); ix.accounts[1] = AccountMeta::new(e.players[3].pubkey(), false); let r = send_as(&mut e, ix, new[0].owner); assert!(r.is_ok(), "{}", err_string(&r)); assert_eq!(e.lamports(&e.players[3].pubkey()), h, "nothing reached the account named instead of the hub");
}
#[test] fn closing_works_while_paused_for_both_kinds_and_a_registry_that_cannot_be_written_closes_neither() {
    let mut e = env(4); let new = sealed(&mut e, 1); let old = { let v = sealed(&mut e, 1); e.as_previous_build(&v[0]); v }; assert!(e.admin(0, &[]).is_ok());
    for t in [&new[0], &old[0]] { let mut ix = e.close_strategy_ix(t.id, t.owner); ix.accounts[7].is_writable = false; errs(&send_as(&mut e, ix, t.owner), "a registry that cannot be written"); }
    for t in [&new[0], &old[0]] { let r = e.close_strategy(t); assert!(r.is_ok(), "{}", err_string(&r)); } assert_eq!(e.vault_total(), 0, "both strategies' rent came back to someone");
}

// ================= 3. the public terms record =================
#[test] fn create_season_writes_the_terms_exactly_and_the_hub_pays_for_the_record() {
    for finals in [false, true] {
    let mut e = env(3); e.params = Params { window: 777_000, seedto: 321_000, grace: 654_321, mins: 2, bond: BOND }; let h0 = e.lamports(&e.hub); let mut s = e.season(30 + finals as u64); assert!(e.init_pool(&s).is_ok());
    let r = e.create_season(&mut s, if finals { 17 } else { 4 }, 123_456, 9, finals, 1); assert!(r.is_ok(), "CreateSeason: {}", err_string(&r)); let t = e.data(&s.terms); assert_eq!(t.len(), tm::SIZE);
    assert_eq!(rd32(&t, 0), M_TERMS); assert_eq!(t[tm::VERSION], 1); assert_eq!(rd64(&t, tm::SEASON), s.sid); assert_eq!(&t[tm::CREATOR..tm::CREATOR + 32], e.payer.pubkey().as_ref(), "the creator is the signer of CreateSeason"); assert_eq!(&t[tm::MINT..tm::MINT + 32], e.mint.as_ref());
    assert_eq!((rd64(&t, tm::FEE), rd32(&t, tm::NEPS), rd32(&t, tm::SPT), rd64(&t, tm::WINDOW), rd64(&t, tm::SEEDTO), rd64(&t, tm::GRACE)), (123_456, if finals { 17 } else { 4 }, 1, 777_000, 321_000, 654_321));
    assert_eq!((t[tm::MAXS], t[tm::MINS], t[tm::FLAGS], t[tm::DIV]), (9, 2, if finals { 2 } else { 0 }, 1)); assert_eq!(&t[tm::PINS..tm::PINS + PINS_LEN], &e.data(&s.arena)[1152..1152 + PINS_LEN], "the ruleset pins are the arena's own");
    let d = e.data(&s.arena); assert_eq!((rd64(&d, arx::FEE), rd64(&d, arx::WINDOW), rd64(&d, arx::SEEDTO), rd64(&d, arx::PUBGRACE), d[arx::MINS]), (123_456, 777_000, 321_000, 654_321, 2), "the arena agrees with the record");
    assert_eq!(e.rent_held.as_ref().unwrap()[&(false, s.terms)], 7_808, "a 184-byte record costs the hub (184 + 60) x 32"); assert_eq!(h0 - e.lamports(&e.hub), eph_rent(arena_size(9)) + eph_rent(68) + eph_rent(roster_size(9)) + eph_rent(68) + eph_rent(claims_size(9)) + 7_808, "arena, roster, their permissions, claims and the terms record");
    let again = e.data(&s.terms); assert_eq!(again, t, "nothing rewrites it"); }
}
#[test] fn the_terms_hash_is_what_a_client_computes_from_the_terms_it_read() {
    let mut e = env(2); let s = season_with(&mut e, 32, 55, true); let t = e.data(&s.terms);
    // computed from the individual terms, in the layout the program documents, with nothing read from the hash input but the terms themselves
    let mut body = vec![1u8, 0, 0, 0]; body.extend(s.sid.to_le_bytes()); body.extend_from_slice(e.payer.pubkey().as_ref()); body.extend_from_slice(e.mint.as_ref()); body.extend(55u64.to_le_bytes()); body.extend(15u32.to_le_bytes()); body.extend(1u32.to_le_bytes());
    body.extend(e.params.window.to_le_bytes()); body.extend(e.params.seedto.to_le_bytes()); body.extend(e.params.grace.to_le_bytes()); body.extend([20u8, e.params.mins, 2, 2, 0, 0, 0, 0]); body.extend_from_slice(&t[tm::PINS..tm::PINS + PINS_LEN]);
    assert_eq!(body.len(), tm::RENT - tm::VERSION); assert_eq!(terms_hash(&t), sha256(&[b"CNCL-TERMS-v1", &body]), "the program's record hashes to what the documented layout gives");
    let mut t2 = t.clone(); t2[tm::RENT..].fill(0xee); assert_eq!(terms_hash(&t2), terms_hash(&t), "the hub rent field is outside the hash"); let mut t3 = t.clone(); t3[tm::FEE] ^= 1; assert_ne!(terms_hash(&t3), terms_hash(&t), "every term is inside it"); for off in [tm::CREATOR, tm::MINT, tm::NEPS, tm::WINDOW, tm::SEEDTO, tm::GRACE, tm::MAXS, tm::MINS, tm::FLAGS, tm::DIV, tm::PINS, tm::PINS + 40] { let mut x = t.clone(); x[off] ^= 1; assert_ne!(terms_hash(&x), terms_hash(&t), "offset {}", off); }
}
#[test] fn enter_pays_only_into_the_terms_the_entrant_read() {
    let mut e = env(5); let st = sealed(&mut e, 4); let s = season_with(&mut e, 33, 10, false); let t = e.data(&s.terms); let (fee, mint, hash) = (rd64(&t, tm::FEE), t[tm::MINT..tm::MINT + 32].to_vec(), terms_hash(&t).to_vec());
    let bal = |e: &Env| e.balance(&e.players[st[0].owner].pubkey()); let b0 = bal(&e); let state = |e: &Env| (e.data(&s.arena)[ar::NS], e.open_count(st[0].id), bal(e), e.pool_balance(&s));
    let mut flip = hash.clone(); flip[31] ^= 1; let mut flip0 = hash.clone(); flip0[0] ^= 0x80; let mut other_mint = mint.clone(); other_mint[5] ^= 1;
    for (what, f, m, h, code) in [("a different fee", fee + 1, &mint, &hash, E_TERMS_MISMATCH), ("a lower fee", fee - 1, &mint, &hash, E_TERMS_MISMATCH), ("zero fee", 0, &mint, &hash, E_TERMS_MISMATCH), ("another stake mint", fee, &other_mint, &hash, E_TERMS_MISMATCH), ("a hash with the last bit flipped", fee, &mint, &flip, E_TERMS_MISMATCH), ("a hash with the first bit flipped", fee, &mint, &flip0, E_TERMS_MISMATCH), ("an all-zero hash", fee, &mint, &vec![0u8; 32], E_TERMS_MISMATCH)] {
        let ix = e.enter_ix_expecting(&s, &st[0], st[0].owner, f, m, h); rejects(&send_as(&mut e, ix, st[0].owner), code, what); assert_eq!(state(&e), (0, 0, b0, 0), "{}: nothing entered, nothing counted, no fee moved", what); }
    // data of the wrong length: the previous build's Enter carried none
    for n in [0usize, 1, 71, 73, 100] { let mut ix = e.enter_ix(&s, &st[0], st[0].owner); ix.data.truncate(1); ix.data.extend(vec![0u8; n]); errs(&send_as(&mut e, ix, st[0].owner), &format!("{} bytes of data", n)); assert_eq!(state(&e), (0, 0, b0, 0)); }
    let mut ix = e.enter_ix(&s, &st[0], st[0].owner); ix.accounts.truncate(9); errs(&send_as(&mut e, ix, st[0].owner), "no terms account"); assert_eq!(state(&e), (0, 0, b0, 0));
    let r = e.enter(&mut s.clone(), &st[0]); assert!(r.is_ok(), "the terms as read: {}", err_string(&r)); assert_eq!(state(&e), (1, 1, b0 - 10, 10), "entered, counted, the fee moved once");
}
#[test] fn enter_refuses_a_terms_record_that_is_not_this_seasons_or_does_not_match_its_arena() {
    let mut e = env(5); let st = sealed(&mut e, 3); let s = season_with(&mut e, 34, 10, false); let other = season_with(&mut e, 35, 99, false);
    let b0 = e.balance(&e.players[st[0].owner].pubkey()); let untouched = |e: &Env| (e.data(&s.arena)[ar::NS], e.balance(&e.players[st[0].owner].pubkey())) == (0, b0);
    // another season's terms, even with the hash and fee that season's record carries
    { let t = e.data(&other.terms); let mut ix = e.enter_ix_expecting(&s, &st[0], st[0].owner, rd64(&t, tm::FEE), &t[tm::MINT..tm::MINT + 32].to_vec(), &terms_hash(&t)); ix.accounts[9] = e.ro(other.terms); rejects(&send_as(&mut e, ix, st[0].owner), E_TERMS_ACCT, "another season's terms record"); assert!(untouched(&e)); }
    for (what, acct) in [("the arena in the terms slot", s.arena), ("the claims account", s.claims), ("an unrelated account", Address::new_unique()), ("the hub", e.hub)] { let mut ix = e.enter_ix(&s, &st[0], st[0].owner); ix.accounts[9] = e.ro(acct); rejects(&send_as(&mut e, ix, st[0].owner), E_TERMS_ACCT, what); assert!(untouched(&e)); }
    // SYNTHETIC: a terms record that was altered after CreateSeason (nothing in the program writes one), re-hashed by the entrant to match what it now says. The arena is the authority: the record must say what the arena does
    let good = e.data(&s.terms);
    for (what, off, len) in [("the fee", tm::FEE, 8), ("the mint", tm::MINT + 3, 1), ("the creator", tm::CREATOR + 3, 1), ("the episodes", tm::NEPS, 1), ("the pace", tm::SPT, 1), ("the entry window", tm::WINDOW, 1), ("the seed timeout", tm::SEEDTO, 1), ("the publish grace", tm::GRACE, 1), ("the seats", tm::MAXS, 1), ("the minimum", tm::MINS, 1), ("the finals flag", tm::FLAGS, 1), ("the division", tm::DIV, 1), ("the ruleset pins", tm::PINS + 5, 1), ("the season", tm::SEASON, 1)] {
        e.set_data(&s.terms, |d| for b in &mut d[off..off + len] { *b ^= 1; }); let t = e.data(&s.terms); let ix = e.enter_ix_expecting(&s, &st[0], st[0].owner, rd64(&t, tm::FEE), &t[tm::MINT..tm::MINT + 32].to_vec(), &terms_hash(&t)); rejects(&send_as(&mut e, ix, st[0].owner), E_TERMS_ACCT, &format!("a record that says another {}", what)); assert!(untouched(&e)); e.set_data(&s.terms, |d| *d = good.clone()); }
    for (what, f) in [("the terms magic", 0usize), ("the terms version", tm::VERSION)] { e.set_data(&s.terms, |d| d[f] ^= 1); let ix = e.enter_ix(&s, &st[0], st[0].owner); rejects(&send_as(&mut e, ix, st[0].owner), E_TERMS_ACCT, what); assert!(untouched(&e)); e.set_data(&s.terms, |d| *d = good.clone()); }
    let ix = e.enter_ix(&s, &st[0], st[0].owner); assert!(send_as(&mut e, ix, st[0].owner).is_ok(), "restored, it enters");
}
#[test] fn a_season_whose_terms_say_another_fee_cannot_take_it() {
    // the case the record exists for: a creator who wants a fee the entrant did not agree to. The entrant read 10 and sends 10; the season is 10. An entrant who read an older, cheaper record cannot be charged more
    let mut e = env(3); let st = sealed(&mut e, 1); let s = season_with(&mut e, 36, 10_000, false); let t = e.data(&s.terms); let h = terms_hash(&t).to_vec(); let m = t[tm::MINT..tm::MINT + 32].to_vec(); let b0 = e.balance(&e.players[0].pubkey());
    let ix = e.enter_ix_expecting(&s, &st[0], 0, 10, &m, &h); rejects(&send_as(&mut e, ix, 0), E_TERMS_MISMATCH, "the entrant expected a fee of 10, the season charges 10,000"); assert_eq!(e.balance(&e.players[0].pubkey()), b0);
    let ix = e.enter_ix_expecting(&s, &st[0], 0, 10_000, &m, &h); assert!(send_as(&mut e, ix, 0).is_ok()); assert_eq!(e.balance(&e.players[0].pubkey()), b0 - 10_000);
}

// ================= 4. the terms record closes with the claims account =================
#[test] fn close_claims_closes_the_terms_record_and_returns_its_rent() {
    let mut e = env(5); let hub0 = e.lamports(&e.hub); let s = e.full_season(40, &NAMES[..3], 2, 10, false, 2, 5, true); assert!(e.settle(&s).is_ok()); e.claim_all(&s); let other = season_with(&mut e, 41, 10, false); let v0 = e.vault_total(); let h0 = e.lamports(&e.hub);
    assert_eq!(e.rent_held.as_ref().unwrap()[&(false, s.terms)], 7_808);
    // not without it, not with another season's, not with an account that is not one
    let mut ix = e.close_claims_ix(&s, e.payer.pubkey()); ix.accounts.pop(); e.fresh_blockhash(); errs(&e.send(&[ix], &[]), "the terms account not named");
    let mut ix = e.close_claims_ix(&s, e.payer.pubkey()); ix.accounts[5] = e.rw(other.terms); e.fresh_blockhash(); rejects(&e.send(&[ix], &[]), E_TERMS_ACCT, "another season's terms record"); let mut ix = e.close_claims_ix(&s, e.payer.pubkey()); ix.accounts[5] = e.rw(Address::new_unique()); e.fresh_blockhash(); rejects(&e.send(&[ix], &[]), E_TERMS_ACCT, "an unrelated account"); let mut ix = e.close_claims_ix(&s, e.payer.pubkey()); ix.accounts[5] = e.rw(s.claims); e.fresh_blockhash(); errs(&e.send(&[ix], &[]), "the claims account twice");
    assert_eq!((e.vault_total(), e.lamports(&e.hub)), (v0, h0), "a refused close moved nothing"); assert!(!e.data(&s.claims).is_empty() && !e.data(&s.terms).is_empty());
    let r = e.close_claims(&s); assert!(r.is_ok(), "CloseClaims: {}", err_string(&r)); assert_eq!(e.lamports(&e.hub) - h0, 7_808 + 34_944, "the hub gets back the terms record's rent and the claims account's"); assert_eq!(v0 - e.vault_total(), 7_808 + 34_944); assert!(e.data(&s.terms).is_empty() && e.data(&s.claims).is_empty(), "both gone");
    let _ = hub0;
}
#[test] fn close_claims_still_waits_for_every_claim_and_a_season_without_terms_still_closes() {
    let mut e = env(5); let s = e.full_season(42, &NAMES[..3], 2, 10, false, 2, 6, true); assert!(e.settle(&s).is_ok()); rejects(&e.close_claims(&s), 9083, "unclaimed money"); assert!(!e.data(&s.terms).is_empty(), "the terms record is untouched by a refused close"); e.claim_all(&s);
    // SYNTHETIC: a season of the previous build never had a terms record, so its address holds nothing. CloseClaims then accepts that address, and only that
    let ghost = { let mut x = s.clone(); x.terms = Address::new_unique(); x }; let ix = e.close_claims_ix(&ghost, e.payer.pubkey()); e.fresh_blockhash(); rejects(&e.send(&[ix], &[]), E_TERMS_ACCT, "an empty account that is not where the terms record would be");
    e.svm.set_account(s.terms, solana_account::Account::default()).unwrap(); e.rent_held.as_mut().unwrap().remove(&(false, s.terms)); let h0 = e.lamports(&e.hub); let r = e.close_claims(&s); assert!(r.is_ok(), "CloseClaims for a season with no terms record: {}", err_string(&r)); assert_eq!(e.lamports(&e.hub) - h0, 34_944, "only the claims account's rent");
}

// ================= 5. the transactions still fit =================
#[test] fn the_changed_instructions_fit_in_one_transaction() {
    let mut e = env(20); let st = sealed(&mut e, 20); let s = season_with(&mut e, 50, 10, true); let n_create = tx_size(&e, &e.create_season_ix(&s, 5, 1, 7, 20, 2, 1)); let n_enter = tx_size(&e, &e.enter_ix(&s, &st[0], 0)); let n_seal = tx_size(&e, &e.seal_ix(&st[0], st[0].owner)); let n_close = tx_size(&e, &e.close_strategy_ix(st[0].id, 0)); let n_cc = tx_size(&e, &e.close_claims_ix(&s, e.payer.pubkey()));
    println!("METER tx sizes: CreateSeason {} Enter {} Seal {} CloseStrategy {} CloseClaims {}", n_create, n_enter, n_seal, n_close, n_cc); assert!(n_create <= 1232 && n_enter <= 1232 && n_seal <= 1232 && n_close <= 1232 && n_cc <= 1232);
}
