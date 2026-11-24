//! Full lifecycle of a v2 season against the real program bytecode: register, seal, create, enter, lock, seed, advance, settle, publish, commit, finals, cleanup.
mod common;
use common::*;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn order(totals: &[i64]) -> Vec<usize> { let mut o: Vec<usize> = (0..totals.len()).collect(); o.sort_by(|&x, &y| totals[y].cmp(&totals[x]).then(x.cmp(&y))); o }

#[test] fn smoke_environment_boots() { let e = Env::new(5); assert_eq!(e.balance(&e.players[0].pubkey()), 1_000_000); assert!(e.svm.get_account(&e.hub).is_some()); }

#[test] fn full_season_with_finals_matches_host_replay_and_pays_exactly() {
    let mut e = Env::new(5); let before: Vec<u64> = e.players.iter().map(|p| e.balance(&p.pubkey())).collect();
    let s = e.full_season(1001, &NAMES, 6, 10, true, 2, 7, true);
    assert_eq!(e.flags(&s) & F_DONE, F_DONE); let d = e.data(&s.arena); assert_eq!(rd64(&d, ar::POOL), 50); assert_eq!(rd32(&d, ar::NEPS), 6);
    // identity: the in-program run equals a host replay with conclave-vm from the same seed words
    let (host_tot, _) = replay(&s, &s.entries); for i in 0..5 { assert_eq!(e.total(&s, i), host_tot[i], "slot {} total differs from host replay", i); }
    // pins stored in the arena equal the VM's
    assert!(d[ar::PINS..ar::PINS + 48] == conclave_vm::pins_bytes()[..]);
    e.finish(&s);
    // exact payout: finals reserve 20% of 50 = 10 kept back; 40 paid 50/30/20 to the top three
    let ord = order(&host_tot); let want = [20i64, 12, 8]; let mut delta = vec![-10i64; 5]; for (k, &i) in ord.iter().take(3).enumerate() { delta[i] += want[k]; }
    for i in 0..5 { assert_eq!(e.balance(&e.players[i].pubkey()) as i64 - before[i] as i64, delta[i], "owner {} balance", i); }
    assert_eq!(rd64(&e.data(&s.arena), ar::RESERVE), 10);
    // receipt on base: header, pins, seed words, entries, commitments, score commitments
    let r = e.data(&s.receipt); assert_eq!(rd32(&r, 0), 0x5443_5052); assert_eq!(r[4], 0, "ensemble kind"); assert_eq!(r[5], 5); assert_eq!(r[6], 5, "all five published"); assert_eq!(rd64(&r, 8), 1001);
    assert_eq!(u16::from_le_bytes([r[24], r[25]]), 2); assert_eq!(r[26], 2); assert_eq!(r[27], 2); assert_eq!(rd32(&r, 32), 6); let (sa, sb) = conclave_vm::world::season_words(&s.seed); assert_eq!(rd64(&r, 40), sa); assert_eq!(rd64(&r, 48), sb);
    let packs = conclave_vm::world::season_packs(sa, sb); assert_eq!((r[28] as usize, r[29] as usize), (packs[0], packs[1])); assert!(r[56..104] == conclave_vm::pins_bytes()[..]);
    for i in 0..5 { let st = &s.entries[i]; let en = 128 + i * 80; assert_eq!(rd64(&r, en), st.id); let reg = e.data(&e.reg_pda(st.id)); assert!(r[en + 8..en + 40] == reg[48..80], "code commitment equals the registry"); assert!(r[en + 8..en + 40] == code_commit(&st.salt, &st.code));
        assert_eq!(rd32(&r, en + 72), ord.iter().position(|&x| x == i).unwrap() as u32 + 1, "rank"); let sc = score_commit(&st.salt, 1001, st.id, host_tot[i], 0, 6); assert!(r[en + 40..en + 72] == sc, "score commitment recomputed from the salt"); }
    // sealed record of each owner carries its rank and score; the registry carries the track record
    for i in 0..5 { let sd = e.data(&e.strat_pda(s.entries[i].id)); assert_eq!(rd64(&sd, 80), 1002, "season+1 marker"); assert_eq!(rd32(&sd, 88), ord.iter().position(|&x| x == i).unwrap() as u32 + 1); assert_eq!(rdi64(&sd, 96), host_tot[i]); let rg = e.data(&e.reg_pda(s.entries[i].id)); assert_eq!(rd32(&rg, 80), 1); assert_eq!(rdi64(&rg, 88), host_tot[i]); }
    // commit to base is accepted (the Magic program is a stand-in here; the real commit was run on devnet)
    let mut accts = vec![s.receipt]; accts.extend(s.entries.iter().map(|x| e.reg_pda(x.id))); assert!(e.commit(&accts).is_ok());
    // ---- finals: top 3 replayed best-of-3 in a fresh seeded arena with its own receipt
    let (r1, mut f) = e.start_finals(&s, 2002, 3, 3); assert!(r1.is_ok(), "StartFinals {}", err_string(&r1));
    f.entries = s.entries.iter().enumerate().filter(|(i, _)| ord.iter().position(|x| x == i).unwrap() < 3).map(|(_, x)| x.clone()).collect(); assert_eq!(f.entries.len(), 3);
    assert!(e.init_receipt(&f).is_ok()); assert!(e.request_seed(&f).is_ok()); let mut seed = [0u8; 32]; for (i, b) in seed.iter_mut().enumerate() { *b = (i as u8).wrapping_mul(11) ^ 0xC3; } assert!(e.deliver_seed(&mut f, seed).is_ok());
    e.drive(&f, 1400, 1_400_000); let (ftot, fwins) = replay(&f, &f.entries); for i in 0..3 { assert_eq!(e.total(&f, i), ftot[i]); assert_eq!(e.wins(&f, i), fwins[i] as u16); }
    let champ_before: Vec<u64> = f.entries.iter().map(|x| e.balance(&e.players[x.owner].pubkey())).collect();
    let rs = { let ix = e.settle_ix(&f, s.pool, &f.entries); e.send(&[ix], &[]) }; assert!(rs.is_ok(), "finals Settle {}", err_string(&rs));
    let mut fo: Vec<usize> = (0..3).collect(); fo.sort_by(|&x, &y| fwins[y].cmp(&fwins[x]).then(ftot[y].cmp(&ftot[x])).then(x.cmp(&y)));
    for i in 0..3 { let gain = e.balance(&e.players[f.entries[i].owner].pubkey()) - champ_before[i]; assert_eq!(gain, if i == fo[0] { 10 } else { 0 }, "only the finals champion takes the reserve"); }
    for i in 0..3 { assert!(e.publish(&f, i).is_ok()); }
    let fr = e.data(&f.receipt); assert_eq!(fr[4], 1, "finals kind"); assert_eq!(rd64(&fr, 8), 2002); assert_eq!(rd64(&fr, 16), 1001, "parent season"); let fr_seed = (rd64(&fr, 40), rd64(&fr, 48)); assert!(fr_seed != (sa, sb), "finals have their own seed");
    assert!(e.data(&s.receipt) == r, "the ensemble receipt is untouched by the finals");
    // cleanup is accepted for both arenas once everything is published
    assert!(e.cleanup(&s).is_ok()); assert!(e.cleanup(&f).is_ok());
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
