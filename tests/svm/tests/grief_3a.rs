//! Phase 3a payout grief, REVERSED. The previous build paid every recipient in one transaction, so one entrant's unusable token account reverted the payout or refund for everyone.
//! With pull payouts such an entrant delays only its own claim. REAL SPL Token and Associated Token programs plus the program bytecode.
//! The harness can show a CLOSED or zeroed token account. The rollup's version of the grief is an owner UNDELEGATING its token account, which was shown by simulation against the rollup;
//! the harness does not model delegation, so that exact case is verified here only as far as "an account this claim cannot be paid into", and stays to be confirmed on devnet.
mod common;
use common::*;
use solana_instruction::{AccountMeta, Instruction};

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];
fn env(n: usize) -> Env { Env::new(n) }
fn bals(e: &Env) -> Vec<u64> { e.players.iter().map(|p| if e.data(&e.ata(&p.pubkey())).is_empty() { 0 } else { e.balance(&p.pubkey()) }).collect() }
fn tok(data: Vec<u8>, accounts: Vec<AccountMeta>) -> Instruction { Instruction { program_id: a(TOKEN), accounts, data } }
fn drain_and_close(e: &mut Env, who: usize) -> Res { let owner = e.players[who].pubkey(); let ata = e.ata(&owner); let sink = e.create_ata(&Address::new_unique()); let bal = e.balance(&owner); let kp = e.player(who); let mut ixs = vec![];
    if bal > 0 { let mut d = vec![3u8]; d.extend(bal.to_le_bytes()); ixs.push(tok(d, vec![AccountMeta::new(ata, false), AccountMeta::new(sink, false), AccountMeta::new_readonly(owner, true)])); }
    ixs.push(tok(vec![9], vec![AccountMeta::new(ata, false), AccountMeta::new(owner, false), AccountMeta::new_readonly(owner, true)])); e.fresh_blockhash(); e.send(&ixs, &[&kp]) }
fn recreate(e: &mut Env, who: usize) { let owner = e.players[who].pubkey(); let ix = Instruction { program_id: a(ATOKEN), accounts: vec![AccountMeta::new(e.payer.pubkey(), true), AccountMeta::new(e.ata(&owner), false), AccountMeta::new_readonly(owner, false), AccountMeta::new_readonly(e.mint, false), AccountMeta::new_readonly(a(SYSTEM), false), AccountMeta::new_readonly(a(TOKEN), false)], data: vec![1] }; e.fresh_blockhash(); assert!(e.send(&[ix], &[]).is_ok()); }
fn open(e: &mut Env, sid: u64, n: usize) -> Season { let mut s = e.season(sid); assert!(e.init_pool(&s).is_ok()); assert!(e.create_season(&mut s, 2, 10, 20, false, 2).is_ok()); for i in 0..n { let st = e.register_and_seal(i, NAMES[i % 5], code_of(NAMES[i % 5])); assert!(e.enter(&mut s, &st).is_ok()); } s }
fn run_to_done(e: &mut Env, s: &mut Season) { assert!(e.lock(s).is_ok()); assert!(e.request_seed(s).is_ok()); assert!(e.deliver_seed(s, [7; 32]).is_ok()); e.drive(s, 1400, 1_400_000); }

#[test] fn a_closed_account_delays_only_its_own_refund() {
    let mut e = env(5); e.params.seedto = 100; let start = bals(&e); let s = open(&mut e, 1, 4); assert!(e.lock(&s).is_ok()); e.warp(101); e.fresh_blockhash();
    assert!(drain_and_close(&mut e, 2).is_ok(), "the griefer closes its token account before the refund");
    let r = e.cancel_by(&s, 4); assert!(r.is_ok(), "Cancel records the refunds and touches no entrant account: {}", err_string(&r)); e.assert_books(&s, 0);
    assert!(e.claim(&s, 2).is_err(), "only the griefer's own claim fails"); assert!(!e.claim_done(&s, 2), "and it stays owed"); e.assert_books(&s, 0);
    for i in [0usize, 1, 3] { assert!(e.claim(&s, i).is_ok()); let p = s.entries[i].owner; assert_eq!(e.balance(&e.players[p].pubkey()), start[p], "entrant {} is whole", i); }
    e.assert_books(&s, 0); assert_eq!(e.pool_balance(&s), 10, "exactly the griefer's fee is still held");
    assert_eq!(custom(&e.close_claims(&s)), Some(9083), "the claims account stays while something is owed"); assert!(e.cleanup(&s).is_ok(), "the arena and the creator's bond are not held hostage"); assert_eq!(e.data(&s.receipt)[rc::STATE], 2);
    // whenever the account exists again, anyone completes the claim; there is no expiry
    e.warp(1_000_000_000); recreate(&mut e, 2); assert!(e.claim(&s, 2).is_ok()); assert_eq!(e.balance(&e.players[2].pubkey()), 10); e.assert_books(&s, 0); assert!(e.close_claims(&s).is_ok()); }

#[test] fn a_closed_winner_account_delays_only_the_winners_claim() {
    // find the ranking, then close each paid entrant's account in turn
    for close_rank in [1u32, 2, 3, 5] {
        let mut e = env(5); let before = bals(&e); let mut s = open(&mut e, 2, 5); run_to_done(&mut e, &mut s); let ex = expect(&s, false); let v = (0..5).find(|&i| ex.srank[i] == close_rank).unwrap(); let who = s.entries[v].owner; assert!(drain_and_close(&mut e, who).is_ok()); e.fresh_blockhash();
        let r = e.settle(&s); assert!(r.is_ok(), "Settle with the rank {} account closed: {}", close_rank, err_string(&r)); e.assert_books(&s, 0);
        for i in 0..5 { let r = e.claim(&s, i); if i == v && ex.owed[i] > 0 { assert!(r.is_err()); } else { assert!(r.is_ok(), "claim {} while rank {} is closed: {}", i, close_rank, err_string(&r)); } }
        let after = bals(&e); for i in 0..5 { let p = s.entries[i].owner; if p != who { assert_eq!(after[p] + 10 - before[p], ex.owed[i], "everyone else is paid in full"); } }
        e.assert_books(&s, 0); if ex.owed[v] > 0 { recreate(&mut e, who); assert!(e.claim(&s, v).is_ok()); assert_eq!(e.balance(&e.players[who].pubkey()), ex.owed[v]); } assert_eq!(e.pool_balance(&s), 0); } }

#[test] fn settle_cancel_and_claim_name_no_account_of_any_other_entrant() {
    let mut e = env(20); let mut s = e.season(4); for i in 0..20 { let st = e.register(i, "x", code_of("Mom20th")); s.entries.push(st); }
    let atas: Vec<Address> = (0..20).map(|i| e.ata(&e.players[i].pubkey())).collect();
    for ix in [e.settle_ix(&s), e.cancel_ix(&s, e.payer.pubkey())] { assert!(ix.accounts.iter().all(|m| !atas.contains(&m.pubkey)), "no entrant token account can make a Settle or a Cancel fail"); }
    for i in 0..20 { let ix = e.claim_ix(&s, i); for (j, t) in atas.iter().enumerate() { assert_eq!(ix.accounts.iter().any(|m| m.pubkey == *t), i == j); } let size = solana_message::Message::new(&[ix], Some(&e.payer.pubkey())).serialize().len() + 1 + 64; assert!(size < 400, "a claim is a small transaction ({} bytes)", size); } }

#[test] fn reassigning_the_token_account_owner_changes_only_where_that_entrants_money_goes() {
    let mut e = env(5); e.params.seedto = 100; let s = open(&mut e, 5, 3); assert!(e.lock(&s).is_ok()); e.warp(101); e.fresh_blockhash(); let owner = e.players[1].pubkey(); let kp = e.player(1); let mut d = vec![6u8, 2, 1]; d.extend_from_slice(Address::new_unique().as_ref());
    let ix = tok(d, vec![AccountMeta::new(e.ata(&owner), false), AccountMeta::new_readonly(owner, true)]); assert!(e.send(&[ix], &[&kp]).is_ok(), "legacy SPL Token allows it even for an associated account"); assert!(e.cancel(&s).is_ok()); e.claim_all(&s); assert_eq!(e.pool_balance(&s), 0); }
