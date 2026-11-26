//! Full lifecycle of a v2 season against the real program bytecode: register, seal, create, enter, lock, seed, advance, settle, publish, commit, finals, cleanup.
mod common;
use common::*;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];

#[test] fn smoke_environment_boots() { let e = Env::new(5); assert_eq!(e.balance(&e.players[0].pubkey()), 1_000_000); assert!(e.svm.get_account(&e.hub).is_some()); }

#[test] fn two_phase_season_matches_the_host_replay_of_both_phases_and_pays_exactly() {
    let mut e = Env::new(5); let before: Vec<u64> = e.players.iter().map(|p| e.balance(&p.pubkey())).collect();
    let mut s = e.full_season(1001, &NAMES, 15, 10, true, 2, 7, false); e.drive(&s, 1400, 1_400_000);
    // ---- the season phase ended by itself: ranks frozen, three qualifiers, nothing settled, waiting for the finals seed
    assert_eq!(e.flags(&s) & (F_SDONE | F_DONE | F_FREQ | F_FSEEDED), F_SDONE); let season_only = expect(&s, false);
    for i in 0..5 { assert_eq!(e.total(&s, i), season_only.season[i], "slot {} season total differs from host replay", i); assert_eq!(e.srank(&s, i), season_only.srank[i]); assert_eq!(e.finalist(&s, i), season_only.srank[i] <= 3); assert_eq!(e.ftotal(&s, i), 0); }
    let ticks_season = e.ticks(&s); assert_eq!(ticks_season, 15 * 150); assert!(e.advance(&s, 1400, 1_400_000).is_err(), "nothing to run until the finals seed arrives");
    let sealed: Vec<Vec<u8>> = (0..5).map(|i| e.data(&s.arena)[HDR + i * SLOT + 176..HDR + i * SLOT + 436].to_vec()).collect(); let strat_before: Vec<Vec<u8>> = s.entries.iter().map(|x| e.data(&e.strat_pda(x.id))).collect();
    // ---- finals: same arena, same sealed bytecode, fresh seed, packs redrawn; no instruction "starts" them
    e.run_finals(&mut s, 7); let ex = expect(&s, true); assert_eq!(e.ticks(&s), ticks_season + FINALS_EPISODES * 150);
    let d = e.data(&s.arena); assert!(d[ar::SEED..ar::SEED + 32] == s.seed, "the season seed is kept"); assert!(d[ar::FSEED..ar::FSEED + 32] == s.fseed); assert_ne!(s.seed, s.fseed);
    for i in 0..5 { assert_eq!(e.total(&s, i), ex.season[i], "the finals never touch a season total"); assert_eq!(e.ftotal(&s, i), ex.finals[i], "slot {} finals total differs from host replay", i); assert!(d[HDR + i * SLOT + 176..HDR + i * SLOT + 436] == sealed[i][..], "the bytecode is untouched"); assert!(e.data(&e.strat_pda(s.entries[i].id)) == strat_before[i], "no re-submission: the sealed accounts were not written"); }
    assert!(d[ar::PINS..ar::PINS + 48] == conclave_vm::pins_bytes()[..]);
    assert!(e.settle(&s).is_ok()); e.claim_all(&s); e.assert_books(&s, 0);
    // pot 50: 25 / 15 / 10 to the qualifiers in combined order, everyone else nothing
    let mut owed = ex.owed.clone(); owed.sort(); assert_eq!(owed, vec![0, 0, 10, 15, 25]);
    for i in 0..5 { assert_eq!(e.rank(&s, i), ex.frank[i]); assert_eq!(e.balance(&e.players[i].pubkey()) + 10 - before[i], ex.owed[i], "owner {}", i); }
    for i in 0..5 { assert!(e.publish(&s, i).is_ok()); }
    // ---- one receipt covers both phases: both seeds, both pack draws, both ranks per entry
    let r = e.data(&s.receipt); assert_eq!(rd32(&r, 0), 0x5443_5052); assert_eq!(r[4], 0); assert_eq!(r[5], 5); assert_eq!(r[6], 5); assert_eq!(rd64(&r, 8), 1001); assert_eq!(u16::from_le_bytes([r[24], r[25]]), 2); assert_eq!(r[26], 2); assert_eq!(r[27], 2); assert_eq!(rd32(&r, 32), 15);
    for (seed, at_a, at_packs) in [(s.seed, 40usize, 28usize), (s.fseed, rc::FSEEDA, rc::FPACKS)] { let (sa, sb) = conclave_vm::world::season_words(&seed); assert_eq!(rd64(&r, at_a), sa); assert_eq!(rd64(&r, at_a + 8), sb); let packs = conclave_vm::world::season_packs(sa, sb); assert_eq!((r[at_packs] as usize, r[at_packs + 1] as usize), (packs[0], packs[1])); }
    assert_eq!(r[rc::FSTATUS], FS_PLAYED); assert_eq!(r[rc::FQUAL], 3); assert_eq!(rd32(&r, rc::FNEPS), 15); assert_eq!(rd64(&r, rc::OWED), 50); assert!(r[56..104] == conclave_vm::pins_bytes()[..]);
    for i in 0..5 { let st = &s.entries[i]; let en = RC_ENT + i * 80; assert_eq!(rd64(&r, en), st.id); let reg = e.data(&e.reg_pda(st.id)); assert!(r[en + 8..en + 40] == reg[48..80]); assert!(r[en + 8..en + 40] == code_commit(&st.salt, &st.code));
        assert_eq!(rd32(&r, en + rc::E_FRANK), ex.frank[i], "final rank"); assert_eq!(u16::from_le_bytes([r[en + rc::E_SRANK], r[en + rc::E_SRANK + 1]]) as u32, ex.srank[i], "season rank"); assert_eq!(r[en + rc::E_PUBLISHED], 1); assert_eq!(r[en + rc::E_FINALIST] != 0, ex.finalist[i]);
        let sc = score_commit(&st.salt, 1001, st.id, ex.season[i], ex.finals[i], 15, if ex.finalist[i] { 15 } else { 0 }); assert!(r[en + 40..en + 72] == sc, "score commitment recomputed from the salt, the season total and the finals total");
        let sd = e.data(&e.strat_pda(st.id)); assert_eq!(rd64(&sd, 80), 1002); assert_eq!(rd32(&sd, 88), ex.frank[i]); assert_eq!(rdi64(&sd, 96), ex.season[i]); assert_eq!(rdi64(&sd, S_LFINALS), ex.finals[i]);
        let rg = e.data(&e.reg_pda(st.id)); assert_eq!(rd32(&rg, 80), 1); assert_eq!(rd32(&rg, 104), ex.frank[i], "the registry records the final rank"); assert_eq!(rdi64(&rg, 88), ex.season[i], "and adds the season total"); }
    let mut accts = vec![s.receipt]; accts.extend(s.entries.iter().map(|x| e.reg_pda(x.id))); assert!(e.commit(&accts).is_ok());
    assert!(e.close_claims(&s).is_ok()); assert!(e.cleanup(&s).is_ok());
}
#[test] fn a_strategy_sealed_by_the_previous_build_still_enters_runs_and_publishes() {
    let mut e = Env::new(5); let mut s = e.season(1002); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 15, 10, 20, true, 2).is_ok());
    let mut old = vec![]; for (i, n) in NAMES.iter().take(2).enumerate() { let st = e.register_and_seal(i, n, code_of(n)); let k = e.strat_pda(st.id); let mut acc = e.svm.get_account(&k).unwrap(); acc.data.truncate(STRAT_MIN_SIZE); e.svm.set_account(k, acc).unwrap(); assert!(e.enter(&mut s, &st).is_ok()); old.push(st); }
    assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert!(e.deliver_seed(&mut s, seed_of(21)).is_ok()); e.drive(&s, 1400, 1_400_000); e.run_finals(&mut s, 21); assert!(e.settle_publishing(&s, 2).is_ok()); let ex = expect(&s, true);
    for (i, st) in old.iter().enumerate() { let sd = e.data(&e.strat_pda(st.id)); assert_eq!(sd.len(), STRAT_MIN_SIZE); assert_eq!(rdi64(&sd, 96), ex.season[i]); assert_eq!(rd32(&sd, 88), ex.frank[i]); }
}
#[test] fn ruin_floor_and_ties_through_the_program() {
    // twenty identical always-long strategies tie exactly; one long strategy run over many episodes must hit the ruin floor on the host and still match the in-program totals
    let mut e = Env::new(5);
    let long = conclave_conformance_tools::assemble(&[[conclave_vm::op::LDI, 1, 0, 1], [conclave_vm::op::POS, 0, 1, 0]]);
    let mut seed_byte = 0u8; let ruin_episodes = loop { let mut seed = [0u8; 32]; for (i, b) in seed.iter_mut().enumerate() { *b = seed_byte.wrapping_add((i as u8).wrapping_mul(37)) ^ 0x5a; } let (sa, sb) = conclave_vm::world::season_words(&seed); let packs = conclave_vm::world::season_packs(sa, sb); let mut n = 0;
        for ep in 0..40u64 { let es = conclave_vm::world::episode_seed(sa, sb, ep); let mut r = [0i32; 150]; conclave_vm::world::gen_episode(conclave_vm::world::pack_for_season(&packs, es), es, &mut r); let mut m = conclave_vm::Market::new(150); let mut st = conclave_vm::Seat::new(); for v in r { let sg = m.advance(v); st.step(&long, &m, v, sg); } if st.ruined { n += 1; } }
        if n > 0 { break (seed_byte, n); } seed_byte += 1; };
    assert!(ruin_episodes.1 > 0); let mut s = e.season(3001); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); assert!(e.create_season(&mut s, 40, 0, 20, false, 2).is_ok());
    for i in 0..20 { let st = e.register_and_seal(i % 5, "AlwaysLong", long.clone()); assert!(e.enter(&mut s, &st).is_ok()); } assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok());
    let mut seed = [0u8; 32]; for (i, b) in seed.iter_mut().enumerate() { *b = ruin_episodes.0.wrapping_add((i as u8).wrapping_mul(37)) ^ 0x5a; } assert!(e.deliver_seed(&mut s, seed).is_ok()); e.drive(&s, 1400, 1_400_000);
    let (host, _) = replay(&s, &s.entries); for i in 0..20 { assert_eq!(e.total(&s, i), host[0], "all twenty identical strategies score identically, and match the host replay including {} ruined episodes", ruin_episodes.1); }
    assert!(e.settle(&s).is_ok()); for i in 0..20 { assert_eq!(e.rank(&s, i), i as u32 + 1, "a tie is broken by entry order"); }
}
