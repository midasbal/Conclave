//! Settlement edge cases ported from the v1 scripts: 1, 2, 3, 4 and 20 entrants with exact payouts, plus double-op and ordering guards.
mod common;
use common::*;

const NAMES: [&str; 5] = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"];

fn payout_case(n: usize, fee: u64) { run_payout(n, fee, false); run_payout(n, fee, true); }
fn run_payout(n: usize, fee: u64, finals: bool) {
    let mut e = Env::new(5); let names: Vec<&str> = (0..n).map(|i| NAMES[i % 5]).collect(); let before: Vec<u64> = e.players.iter().map(|p| e.balance(&p.pubkey())).collect();
    let s = e.full_season(100 + n as u64, &names, if finals { 15 } else { 4 }, fee, finals, 2, n as u8, true);
    // ordering guard: nothing can be published before settlement
    let early = e.publish(&s, 0); assert!(early.is_err(), "Publish before Settle must be rejected");
    let r = e.settle(&s); assert!(r.is_ok(), "Settle: {}", err_string(&r));
    e.fresh_blockhash(); let again = e.settle(&s); assert_eq!(custom(&again), Some(9116), "a second Settle must be rejected");
    // one entrant cannot play finals (voided, paid by season rank); two or more play them
    let played = finals && n >= 2; let ex = expect(&s, played); assert_eq!(e.data(&s.receipt)[rc::FSTATUS], if played { FS_PLAYED } else if finals { FS_VOIDED } else { FS_NONE });
    for i in 0..n { assert_eq!(e.rank(&s, i), ex.frank[i], "{} entrants finals {}: final rank of {}", n, finals, i); assert_eq!(e.srank(&s, i), ex.srank[i]); assert_eq!(e.total(&s, i), ex.season[i]); assert_eq!(e.ftotal(&s, i), ex.finals[i]); assert_eq!(e.owed(&s, i), ex.owed[i]); }
    e.assert_books(&s, 0); e.claim_all(&s); e.assert_books(&s, 0);
    let mut delta = vec![0i128; 5]; for i in 0..n { delta[s.entries[i].owner] += i128::from(ex.owed[i]) - i128::from(fee); }
    for p in 0..5 { assert_eq!(i128::from(e.balance(&e.players[p].pubkey())) - i128::from(before[p]), delta[p], "{} entrants: owner {} balance", n, p); }
    assert_eq!(e.balance(&s.pool) as u128 + 0, 0, "the pool wallet itself is not a player");
    let pool_left = rd64(&e.data(&e.ata(&s.pool)), 64); assert_eq!(pool_left, 0, "{} entrants: the pool is paid out to the last unit", n);
    for i in 0..n { assert!(e.publish(&s, i).is_ok()); e.fresh_blockhash(); assert_eq!(custom(&e.publish(&s, i)), Some(9120), "double publish rejected"); }
    assert!(e.cleanup(&s).is_ok());
}
#[test] fn one_entrant_gets_the_pot_back() { payout_case(1, 10); }
#[test] fn two_entrants_pay_sixty_forty() { payout_case(2, 10); }
#[test] fn three_entrants_pay_fifty_thirty_twenty() { payout_case(3, 10); }
#[test] fn four_entrants_pay_top_three() { payout_case(4, 10); }
#[test] fn twenty_entrants_full_arena() { payout_case(20, 7); }
#[test] fn odd_pot_remainder_goes_to_the_last_paid_rank() { payout_case(3, 7); } // 21 -> 10 + 6 + 5, remainder on the last paid rank, nothing left in the pool

#[test] fn pot_with_zero_fee_pays_nothing_and_still_settles() { let mut e = Env::new(5); let s = e.full_season(7, &NAMES, 2, 0, false, 2, 3, true); assert!(e.settle(&s).is_ok()); e.claim_all(&s); assert!(e.close_claims(&s).is_ok()); for i in 0..5 { assert!(e.publish(&s, i).is_ok()); } assert!(e.cleanup(&s).is_ok()); }
