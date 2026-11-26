//! Rejection paths: ruleset gates, ordering and ownership guards, pin mismatch, finals and cleanup guards. Every rejection is asserted to be an error from the program, never an abort.
mod common;
use common::*;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn assert_rejects(r: &Res, what: &str) { assert!(r.is_err(), "{} was accepted", what); assert!(!failed_to_complete(r) || r.as_ref().err().unwrap().meta.logs.iter().any(|l| l.contains("exceeded")), "{} aborted instead of returning an error: {}", what, err_string(r)); }

#[test] fn ruleset_gates_at_seal() {
    let mut e = Env::new(5);
    let mut v1 = code_of("Mom20th"); v1[0] = 1; let s = e.register(0, "v1", v1); let r = e.seal(&s); assert_eq!(custom(&r), Some(9003), "a ruleset-1 program is rejected with the version error: {}", err_string(&r));
    let mut ops = vec![[conclave_vm::op::HIST, 1, 0, 0]; 14]; ops.push([conclave_vm::op::POS, 0, 1, 0]); let over = conclave_conformance_tools::assemble(&ops); let s = e.register(0, "over", over); let r = e.seal(&s); assert_eq!(custom(&r), Some(9001), "work 71 > 64: {}", err_string(&r));
    let mut ops = vec![[conclave_vm::op::HIST, 1, 0, 0]; 12]; ops.push([conclave_vm::op::ADD, 1, 0, 1]); ops.push([conclave_vm::op::ADD, 1, 0, 1]); ops.push([conclave_vm::op::ADD, 1, 0, 1]); ops.push([conclave_vm::op::POS, 0, 1, 0]); let exact = conclave_conformance_tools::assemble(&ops);
    assert_eq!(conclave_vm::work_of(&exact), 64); let s = e.register(0, "exactly 64", exact); assert!(e.seal(&s).is_ok(), "exactly 64 is accepted");
    let s = e.register(1, "garbage", vec![2, 1, 0, 0, 200, 0, 0, 0]); assert_rejects(&e.seal(&s), "unknown opcode");
    let st = e.register(1, "ok", code_of("Mom20th")); let r = { let ix = e.seal_ix(&st, 0); let kp = e.player(0); e.provision_if_new(e.strat_pda(st.id), STRAT_SIZE); e.send(&[ix], &[&kp]) }; assert_rejects(&r, "sealing another owner's registry entry");
    let mut tampered = e.register(2, "bad salt", code_of("Mom20th")); tampered.salt[0] ^= 1; assert_rejects(&e.seal(&tampered), "salt that does not open the registry commitment");
    let st = e.register_and_seal(3, "twice", code_of("Mom20th")); assert_rejects(&e.seal(&st), "sealing the same strategy twice (the ER refuses to create it again)");
}
#[test] fn enter_guards() {
    let mut e = Env::new(5); let mut s = e.season(1); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); assert!(e.create_season(&mut s, 2, 5, 3, false, 2).is_ok());
    let a1 = e.register_and_seal(0, "a", code_of("Mom20th")); let a2 = e.register_and_seal(1, "b", code_of("EMAcross")); let a3 = e.register_and_seal(2, "c", code_of("TrendSwitch")); let a4 = e.register_and_seal(3, "d", code_of("SwitchTwo"));
    { let ix = e.enter_ix(&s, &a1, 1); let kp = e.player(1); assert_rejects(&e.send(&[ix], &[&kp]), "entering with someone else's signature"); }
    assert!(e.enter(&mut s, &a1).is_ok()); let dup = e.enter(&mut s, &a1); assert_rejects(&dup, "entering the same strategy twice"); assert!(e.enter(&mut s, &a2).is_ok()); assert!(e.enter(&mut s, &a3).is_ok());
    assert_rejects(&e.enter(&mut s, &a4), "a fourth entrant into a three-slot arena"); assert_eq!(s.entries.len(), 3);
    assert!(e.lock(&s).is_ok()); let a5 = e.register_and_seal(4, "e", code_of("SwitchFade")); assert_rejects(&e.enter(&mut s, &a5), "entering after the lock");
    // division gate: SwitchFade has work 32, a division-0 season (work <= 16) refuses it, a division-1 season (<= 32) accepts it
    let mut d0 = e.season(2); assert!(e.create_season(&mut d0, 2, 0, 4, false, 0).is_ok()); let r = e.enter(&mut d0, &a5); assert_eq!(custom(&r), Some(9005), "division 0 refuses work 32: {}", err_string(&r));
    let mut d1 = e.season(3); assert!(e.create_season(&mut d1, 2, 0, 4, false, 1).is_ok()); assert!(e.enter(&mut d1, &a5).is_ok(), "division 1 admits work 32");
    // token guard: an owner without the fee cannot enter
    let poor = e.register_and_seal(0, "poor", code_of("Mom20th")); let ata = e.ata(&e.players[0].pubkey()); let bal = e.balance(&e.players[0].pubkey()); let sink = e.create_ata(&Address::new_unique()); let mut d = vec![3u8]; d.extend(bal.to_le_bytes());
    let ix = solana_instruction::Instruction { program_id: a(TOKEN), accounts: vec![solana_instruction::AccountMeta::new(ata, false), solana_instruction::AccountMeta::new(sink, false), solana_instruction::AccountMeta::new_readonly(e.players[0].pubkey(), true)], data: d }; let kp = e.player(0); assert!(e.send(&[ix], &[&kp]).is_ok());
    let mut s2 = e.season(4); assert!(e.init_pool(&s2).is_ok()); assert!(e.create_season(&mut s2, 2, 5, 3, false, 2).is_ok()); assert_rejects(&e.enter(&mut s2, &poor), "entering without the fee");
}
#[test] fn ordering_guards() {
    let mut e = Env::new(5); let mut s = e.season(11); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); assert!(e.create_season(&mut s, 15, 10, 20, true, 2).is_ok());
    assert_rejects(&e.lock(&s), "locking an empty arena"); let st = e.register_and_seal(0, "a", code_of("Mom20th")); assert!(e.enter(&mut s, &st).is_ok());
    assert_rejects(&e.request_seed(&s), "RequestSeed before Lock"); { let ix = e.ix(7, vec![e.m(e.players[1].pubkey(), true, true), e.rw(s.arena)], vec![]); let kp = e.player(1); assert_rejects(&e.send(&[ix], &[&kp]), "Lock by a non-authority"); }
    assert_rejects(&e.advance(&s, 1400, 1_400_000), "Advance before the seed"); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok()); assert_rejects(&e.request_seed(&s), "a second RequestSeed");
    assert_rejects(&e.advance(&s, 1400, 1_400_000), "Advance while the seed is still pending");
    // the VRF callback is only accepted from the VRF identity, once, and only after a request
    let mut seed = [9u8; 32]; { let bad_id = pda(&[b"identity", e.pid.as_ref()], &a(TOKEN)); let ix = solana_instruction::Instruction { program_id: e.pid, accounts: vec![solana_instruction::AccountMeta::new_readonly(bad_id, true), solana_instruction::AccountMeta::new(s.arena, false)], data: { let mut d = CB_DISC.to_vec(); d.extend_from_slice(&seed); d } }; assert_rejects(&e.send_oracle(ix), "callback from a wrong identity"); }
    { let id = pda(&[b"identity", e.pid.as_ref()], &a(VRF)); let ix = solana_instruction::Instruction { program_id: e.pid, accounts: vec![solana_instruction::AccountMeta::new_readonly(id, false), solana_instruction::AccountMeta::new(s.arena, false)], data: { let mut d = CB_DISC.to_vec(); d.extend_from_slice(&seed); d } }; assert_rejects(&e.send(&[ix], &[]), "callback without the identity signing"); }
    { let id = pda(&[b"identity", e.pid.as_ref()], &a(VRF)); let ix = solana_instruction::Instruction { program_id: e.pid, accounts: vec![solana_instruction::AccountMeta::new_readonly(id, true), solana_instruction::AccountMeta::new(s.arena, false)], data: CB_DISC.to_vec() }; assert_rejects(&e.send_oracle(ix), "callback with a short seed"); }
    assert!(e.deliver_seed(&mut s, seed).is_ok()); seed[0] ^= 1; assert_rejects(&e.deliver_seed(&mut s, seed), "a second callback");
    assert_rejects(&e.settle(&s), "Settle before the season is done"); assert_eq!(custom(&e.cleanup(&s)), Some(9122), "Cleanup before settlement"); assert_eq!(custom(&e.claim(&s, 0)), Some(9080), "Claim before settlement"); assert_eq!(custom(&e.settle(&s)), Some(9115));
    e.drive(&s, 1400, 1_400_000); assert_rejects(&e.advance(&s, 1400, 1_400_000), "Advance after the season is done"); assert_rejects(&e.publish(&s, 0), "Publish before Settle");
    assert!(e.in_finals(&s) == false && e.flags(&s) & F_DONE != 0, "one entrant: no finals to play");
    assert!(e.settle(&s).is_ok()); e.fresh_blockhash(); assert_eq!(custom(&e.settle(&s)), Some(9116), "a second Settle"); assert_eq!(custom(&e.cancel(&s)), Some(9033), "Cancel after Settle"); assert_eq!(custom(&e.cleanup(&s)), Some(9123), "Cleanup before every rank is published");
    assert!(e.publish(&s, 0).is_ok()); e.fresh_blockhash(); assert_eq!(custom(&e.publish(&s, 0)), Some(9120), "a second Publish"); { let id = s.entries[0].id; let ix = e.publish_ix(&s, 5, id); assert_rejects(&e.send(&[ix], &[]), "Publish for a slot that does not exist"); }
    e.fresh_blockhash(); assert!(e.cleanup(&s).is_ok()); // (a second Cleanup is refused on devnet because the arena no longer exists; the Magic stand-in does not remove it, so that is not asserted here)
}
#[test] fn the_retired_start_finals_tag_and_wrong_phase_requests_are_refused() {
    let mut e = Env::new(5); let mut s = e.full_season(21, &NAMES, 15, 10, true, 2, 5, false); e.drive(&s, 1400, 1_400_000);
    for data in [vec![], { let mut d = 22u64.to_le_bytes().to_vec(); d.extend([3u8, 3, 0, 0, 0, 1, 0, 0, 0]); d }] { let ix = e.ix(14, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.arena), e.rw(e.hub), e.rw(e.arena_pda(22)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(MAGIC)), e.ro(a(PERMISSION)), e.rw(e.receipt_pda(22))], data); e.fresh_blockhash(); let r = e.send(&[ix], &[]); assert!(format!("{}", err_string(&r)).contains("InvalidInstructionData"), "tag 14: {}", err_string(&r)); }
    assert_rejects(&e.publish(&s, 0), "Publish between the phases"); assert_eq!(custom(&e.claim(&s, 0)), Some(9080), "Claim between the phases"); assert_eq!(custom(&e.cleanup(&s)), Some(9122), "Cleanup between the phases");
    let st = e.register_and_seal(0, "late", code_of("Mom20th")); let mut t = s.clone(); assert_rejects(&e.enter(&mut t, &st), "entering during the finals"); assert_rejects(&e.lock(&s), "locking again during the finals");
    e.run_finals(&mut s, 5); e.fresh_blockhash(); assert_eq!(custom(&e.request_seed(&s)), Some(9111), "no third seed");
}
#[test] fn pin_mismatch_is_refused_everywhere() {
    let mut e = Env::new(5); let mut s = e.season(41); assert!(e.init_pool(&s).is_ok()); assert!(e.init_receipt(&s).is_ok()); assert!(e.create_season(&mut s, 2, 0, 20, false, 2).is_ok()); let st = e.register_and_seal(0, "a", code_of("Mom20th"));
    // an arena created under another ruleset: flip a pin byte (the generator version, byte 3 of the pin block) the way a different build would have stored it
    e.set_data(&s.arena, |d| d[ar::PINS + 3] ^= 1); let r = e.enter(&mut s, &st); assert_eq!(custom(&r), Some(9010), "Enter: {}", err_string(&r)); assert_eq!(custom(&e.lock(&s)), Some(9010)); assert_eq!(custom(&e.request_seed(&s)), Some(9010));
    e.set_data(&s.arena, |d| d[ar::PINS + 3] ^= 1); assert!(e.enter(&mut s, &st).is_ok()); assert!(e.lock(&s).is_ok()); assert!(e.request_seed(&s).is_ok());
    e.set_data(&s.arena, |d| d[ar::PINS + 4] ^= 1); let mut seed = [3u8; 32]; seed[1] = 7; assert_eq!(custom(&e.deliver_seed(&mut s, seed)), Some(9010), "the VRF callback also refuses a mismatched arena"); e.set_data(&s.arena, |d| d[ar::PINS + 4] ^= 1); assert!(e.deliver_seed(&mut s, seed).is_ok());
    e.set_data(&s.arena, |d| d[ar::PINS + 36] ^= 1); e.warp(100); assert_eq!(custom(&e.advance(&s, 1400, 1_400_000)), Some(9010), "Advance refuses a mismatched arena (division table pin)");
    e.set_data(&s.arena, |d| d[ar::PINS + 36] ^= 1); e.set_data(&s.arena, |d| d[ar::PINS + 40] ^= 1); assert_eq!(custom(&e.advance(&s, 1400, 1_400_000)), Some(9010), "generator checksum pin"); e.set_data(&s.arena, |d| d[ar::PINS + 40] ^= 1);
    e.drive(&s, 1400, 1_400_000); e.set_data(&s.arena, |d| d[ar::PINS] ^= 1); assert_eq!(custom(&e.settle(&s)), Some(9010), "Settle refuses too"); e.set_data(&s.arena, |d| d[ar::PINS] ^= 1); assert!(e.settle(&s).is_ok());
}
#[test] fn delegate_and_registry_ownership() {
    let mut e = Env::new(3); let st = e.register(0, "a", code_of("Mom20th")); let reg = e.reg_pda(st.id); let buf = Address::new_unique();
    let mk = |e: &Env, payer: usize| { let mut d = vec![1u8]; d.extend(st.id.to_le_bytes()); e.ix(2, vec![e.m(e.players[payer].pubkey(), true, true), e.ro(a(SYSTEM)), e.rw(reg), e.ro(e.pid), e.rw(buf), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique())], d) };
    let ix = mk(&e, 1); let kp = e.player(1); assert_rejects(&e.send(&[ix], &[&kp]), "delegating someone else's registry entry");
    let reg_dup = e.send(&[e.ix(1, vec![e.m(e.players[1].pubkey(), true, true), e.rw(reg), e.ro(a(SYSTEM))], { let mut d = st.id.to_le_bytes().to_vec(); d.extend([0u8; 32]); d })], &[&e.player(1)]); assert_rejects(&reg_dup, "registering an id that already exists");
}
