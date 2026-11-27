//! Property test of the program's account and instruction parsing against malformed and adversarial inputs, run through the real bytecode.
//! Valid instructions for every tag and every lifecycle stage are mutated (data bytes, account substitution, order, duplicates, dropped accounts, flag flips) and sent.
//! Oracle: the program must answer with success or an error code. An abort (ProgramFailedToComplete that is not a compute-meter overrun) is a finding.
//! The first pass also checks MONEY after every accepted transaction: the token supply across players and pools is unchanged, and every recorded pool still covers everything unclaimed.
//! And the RECORD: a receipt that has been written names, for every entry, the true owner and code commitment; and a receipt that was closed never changes again except for its bond being released.
//! It checks the OPEN-ENTRY GUARD too: each strategy's count equals the number of arena slots holding a unit for it, and a strategy that no longer exists is held by none.
//! A second pass also corrupts program-owned account bytes before the call: that state is not reachable by a transaction, so findings there are reported separately.
mod common;
use common::*;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use std::collections::HashMap;

struct Rng(u64);
impl Rng { fn next(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545_F491_4F6C_DD1D) } fn below(&mut self, n: usize) -> usize { (self.next() % n.max(1) as u64) as usize } fn chance(&mut self, n: u64, d: u64) -> bool { self.next() % d < n } }

struct World { e: Env, keys: Vec<Address>, snap: Vec<(Address, Option<Account>)>, templates: Vec<Instruction>, program_owned: Vec<Address>, seasons: Vec<Season> }
fn build() -> World {
    let mut e = Env::new(5); let names = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"]; let mut seasons: Vec<Season> = vec![]; let mut templates: Vec<Instruction> = vec![];
    // stage 1: open arena with entries and finals enabled
    let mut sa0 = e.season(9001); e.init_pool(&sa0).unwrap(); e.init_receipt(&sa0).unwrap(); e.create_season(&mut sa0, 15, 10, 6, true, 2).unwrap(); let st: Vec<Strat> = (0..5).map(|i| e.register_and_seal(i, names[i], code_of(names[i]))).collect(); e.enter(&mut sa0, &st[0]).unwrap(); e.enter(&mut sa0, &st[1]).unwrap(); seasons.push(sa0.clone());
    // 2 locked and requested, 3 season part-run, 4 waiting for the finals seed, 5 finals seeded and part-run, 6 finals done, 7 settled with some claims and publishes done, 8 cancelled with claims partly paid, 9 settled voided
    let mk = |e: &mut Env, sid: u64, upto: u8| -> Season { let mut s = e.season(sid); e.init_pool(&s).unwrap(); e.init_receipt(&s).unwrap(); e.create_season(&mut s, 15, 10, 6, true, 2).unwrap(); for i in 0..4 { let t = e.register_and_seal(i, names[i], code_of(names[i])); e.enter(&mut s, &t).unwrap(); }
        if upto >= 1 { e.lock(&s).unwrap(); e.request_seed(&s).unwrap(); } if upto >= 2 { e.deliver_seed(&mut s, [sid as u8; 32]).unwrap(); e.warp(151); e.fresh_blockhash(); e.advance(&s, 650, 650_000).unwrap(); } if upto >= 3 { e.drive(&s, 1400, 1_400_000); assert!(e.in_finals(&s)); }
        if upto >= 4 { e.request_seed(&s).unwrap(); e.deliver_finals_seed(&mut s, [sid as u8 ^ 0x33; 32]).unwrap(); e.warp(151); e.fresh_blockhash(); e.advance(&s, 650, 650_000).unwrap(); } if upto >= 5 { e.drive(&s, 1400, 1_400_000); }
        if upto >= 6 { e.settle(&s).unwrap(); e.publish(&s, 0).unwrap(); e.publish(&s, 2).unwrap(); e.claim(&s, 0).unwrap(); e.claim(&s, 1).unwrap(); } s };
    for (i, up) in [1u8, 2, 3, 4, 5, 6].iter().enumerate() { seasons.push(mk(&mut e, 9010 + i as u64, *up)); }
    // a season that is CLOSED: everything published, claimed, cleaned up. The stand-in keeps closed ephemeral accounts, so its arena and roster are removed as the rollup would remove them
    { let c = mk(&mut e, 9040, 6); e.publish(&c, 1).unwrap(); e.publish(&c, 3).unwrap(); e.claim(&c, 2).unwrap(); e.claim(&c, 3).unwrap(); e.cleanup(&c).unwrap(); e.svm.set_account(c.arena, Account::default()).unwrap(); e.svm.set_account(c.roster, Account::default()).unwrap(); assert_eq!(e.data(&c.receipt)[rc::STATE], 2); seasons.push(c); }
    { let mut s = e.season(9030); e.init_pool(&s).unwrap(); e.params.seedto = 50; e.init_receipt(&s).unwrap(); e.create_season(&mut s, 3, 10, 6, false, 2).unwrap(); for i in 0..3 { let t = e.register_and_seal(i, names[i], code_of(names[i])); e.enter(&mut s, &t).unwrap(); } e.lock(&s).unwrap(); e.warp(51); e.fresh_blockhash(); e.cancel(&s).unwrap(); e.claim(&s, 1).unwrap(); seasons.push(s); e.params.seedto = 1_000_000; }
    // a sealed strategy no season holds, and one whose owner already closed it (its registry waits for base)
    let free = e.register_and_seal(0, names[0], code_of(names[0])); let closed = e.register_and_seal(1, names[1], code_of(names[1])); let r = e.close_strategy(&closed); assert!(r.is_ok(), "{}", err_string(&r));
    // template instructions, one family per tag and stage
    let all_strats: Vec<Strat> = e.strategies.clone(); let hub = e.hub; let pid = e.pid;
    for s in &seasons {
        templates.push(e.ix(7, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.arena)], vec![])); templates.push(e.ix(8, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.arena), e.ro(pda(&[b"identity"], &pid)), e.rw(a(VRF_QUEUE)), e.ro(a(SYSTEM)), e.ro(a(SLOT_HASHES)), e.ro(a(VRF))], vec![]));
        let mut view = s.clone(); if view.entries.is_empty() { view.entries = all_strats[..4].to_vec(); }
        templates.push(e.advance_ix(s, 65535, 1400)); templates.push(e.advance_ix(s, 3, 650)); templates.push(e.settle_ix(s)); templates.push(e.cleanup_ix(s)); templates.push(e.close_claims_ix(s, e.payer.pubkey()));
        for i in 0..4 { templates.push(e.claim_ix(&view, i.min(view.entries.len() - 1))); templates.push(e.claim_ix(&view, i.min(view.entries.len() - 1))); }
        for i in 0..3 { templates.push(e.publish_ix(s, i, view.entries[i.min(view.entries.len() - 1)].id)); }
        templates.push(e.ix(14, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.arena), e.rw(hub), e.rw(e.arena_pda(s.sid + 500)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(MAGIC)), e.ro(a(PERMISSION))], { let mut d = (s.sid + 500).to_le_bytes().to_vec(); d.extend([3u8, 3, 0, 0, 0, 1, 0, 0, 0]); d }));
        templates.push(e.create_season_ix(s, 5, 1, 7, 6, 2, 1)); for t in all_strats.iter().take(3) { templates.push(e.enter_ix(s, t, t.owner)); }
        templates.push(e.ix(13, vec![e.m(e.payer.pubkey(), true, true), e.rw(Address::new_unique()), e.ro(s.pool), e.ro(e.mint), e.ro(a(SYSTEM)), e.ro(a(ESPL)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique()), e.rw(e.ata(&s.pool)), e.ro(a(ATOKEN)), e.ro(a(TOKEN))], s.sid.to_le_bytes().to_vec()));
        templates.push(e.ix(16, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.receipt), e.ro(a(SYSTEM))], { let mut d = s.sid.to_le_bytes().to_vec(); d.extend(2_000_000u64.to_le_bytes()); d }));
        templates.push(e.cancel_ix(s, e.payer.pubkey())); templates.push(e.release_bond_ix(s, e.payer.pubkey())); { let mut ix = e.settle_ix(s); for t in view.entries.iter().take(4) { ix.accounts.push(e.rw(e.strat_pda(t.id))); ix.accounts.push(e.rw(e.reg_pda(t.id))); } templates.push(ix); }
        { let mut m = vec![e.m(e.payer.pubkey(), true, true), e.ro(a(MAGIC)), e.rw(a(MAGIC_CTX)), e.rw(s.receipt)]; for t in all_strats.iter().take(2) { m.push(e.rw(e.reg_pda(t.id))); } templates.push(e.ix(12, m, vec![1])); }
        let mut cm = vec![e.m(e.payer.pubkey(), true, true), e.ro(a(MAGIC)), e.rw(a(MAGIC_CTX)), e.rw(s.receipt)]; for t in all_strats.iter().take(3) { cm.push(e.rw(e.reg_pda(t.id))); } templates.push(e.ix(12, cm, vec![]));
        let id = pda(&[b"identity", pid.as_ref()], &a(VRF)); for disc in [CB_DISC, CB_DISC_FINALS] { let mut d = disc.to_vec(); d.extend([7u8; 32]); templates.push(Instruction { program_id: pid, accounts: vec![AccountMeta::new_readonly(id, true), AccountMeta::new(s.arena, false)], data: d }); } }
    for t in all_strats.iter().take(5) { templates.push(e.seal_ix(t, t.owner)); templates.push(e.ix(1, vec![e.m(e.players[t.owner].pubkey(), true, true), e.rw(e.reg_pda(t.id)), e.ro(a(SYSTEM))], { let mut d = t.id.to_le_bytes().to_vec(); d.extend([1u8; 32]); d }));
        let mut d = vec![1u8]; d.extend(t.id.to_le_bytes()); templates.push(e.ix(2, vec![e.m(e.players[t.owner].pubkey(), true, true), e.ro(a(SYSTEM)), e.rw(e.reg_pda(t.id)), e.ro(pid), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique())], d)); }
    // closing: every strategy (held or free), the registry removal, its undelegation, and Cancel / Cleanup naming the strategies they release
    for t in &all_strats { templates.push(e.close_strategy_ix(t.id, t.owner)); } for _ in 0..8 { templates.push(e.close_strategy_ix(free.id, free.owner)); templates.push(e.close_registry_ix(closed.id, e.players[closed.owner].pubkey())); templates.push(e.ix(12, vec![e.m(e.payer.pubkey(), true, true), e.ro(a(MAGIC)), e.rw(a(MAGIC_CTX)), e.rw(e.reg_pda(closed.id))], vec![1])); }
    for s in &seasons { let ids: Vec<u64> = e.held_ids(s); if !ids.is_empty() { for _ in 0..3 { templates.push(e.with_strats(e.cleanup_ix(s), &ids)); templates.push(e.with_strats(e.cancel_ix(s, e.payer.pubkey()), &ids)); } } }
    templates.push(e.ix(0, vec![e.m(e.payer.pubkey(), true, true), e.rw(hub), e.ro(a(SYSTEM))], 5u64.to_le_bytes().to_vec()));
    { let pd = pda(&[pid.as_ref()], &a(LOADER)); templates.push(e.init_config_ix(pd, e.payer.pubkey())); let mut sub = vec![2u8]; sub.extend_from_slice(e.mint.as_ref());
      for (k, d) in [(0u8, vec![]), (1, vec![]), (2, e.mint.as_ref().to_vec()), (3, e.mint.as_ref().to_vec()), (4, Address::new_unique().as_ref().to_vec())] { let mut dd = vec![k]; dd.extend(d); templates.push(e.ix(20, vec![e.m(e.payer.pubkey(), true, true), e.rw(e.config)], dd)); } let _ = sub;
      for s in seasons.iter() { templates.push(e.ix(21, vec![e.m(e.payer.pubkey(), true, true), e.ro(e.config), e.rw(s.receipt), e.ro(s.arena)], s.sid.to_le_bytes().to_vec())); } }
    let mut ud = vec![196u8, 28, 41, 206, 48, 37, 51, 167, 2, 0, 0, 0, 4, 0, 0, 0, b'h', b'u', b'b', 0]; ud.extend([0u8; 8]); templates.push(Instruction { program_id: pid, accounts: vec![AccountMeta::new(hub, false), AccountMeta::new(Address::new_unique(), false), AccountMeta::new(e.payer.pubkey(), true), AccountMeta::new_readonly(a(SYSTEM), false)], data: ud });
    // handing a receipt to a rollup: by its creator and by others, fresh, open and closed
    let fresh = e.season(9099); e.init_receipt(&fresh).unwrap();
    for s in seasons.iter().chain(std::iter::once(&fresh)) { for who in [None, Some(1usize)] { let payer = who.map(|w| e.players[w].pubkey()).unwrap_or_else(|| e.payer.pubkey()); let mut d = vec![2u8]; d.extend(s.sid.to_le_bytes()); templates.push(e.ix(2, vec![e.m(payer, true, true), e.ro(a(SYSTEM)), e.rw(s.receipt), e.ro(pid), e.rw(pda(&[b"buffer", s.receipt.as_ref()], &pid)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique())], d)); } }
    // this harness runs with rent at zero, so releasing a whole bond would leave a receipt with no lamports and the SVM would delete it. On the chain it keeps its rent: give each one that
    for s in &seasons { let mut acc = e.svm.get_account(&s.receipt).unwrap(); acc.lamports += 1_000_000; e.svm.set_account(s.receipt, acc).unwrap(); }
    // account universe and snapshot
    let mut keys: Vec<Address> = vec![hub, e.mint, e.payer.pubkey(), e.config]; keys.extend(e.players.iter().map(|p| p.pubkey())); let mut program_owned = vec![hub, e.config];
    for s in &seasons { keys.extend([s.arena, s.receipt, s.claims, s.roster, s.terms, s.pool, e.ata(&s.pool)]); program_owned.extend([s.arena, s.receipt, s.claims, s.roster, s.terms]); } for t in &all_strats { keys.extend([e.reg_pda(t.id), e.strat_pda(t.id)]); program_owned.extend([e.reg_pda(t.id), e.strat_pda(t.id)]); } for p in &e.players { keys.push(e.ata(&p.pubkey())); }
    keys.extend([pid, a(VRF_QUEUE), a(MAGIC), a(PERMISSION), a(VRF), a(ESPL), a(DLP), a(TOKEN), a(ATOKEN), a(SYSTEM), a(SLOT_HASHES), a(MAGIC_CTX)]); keys.sort(); keys.dedup();
    keys.push(fresh.receipt); keys.push(pda(&[b"buffer", fresh.receipt.as_ref()], &pid)); for s in &seasons { keys.push(pda(&[b"buffer", s.receipt.as_ref()], &pid)); } keys.sort(); keys.dedup();
    let snap = keys.iter().map(|k| (*k, e.svm.get_account(k))).collect(); let w = World { e, keys, snap, templates, program_owned, seasons }; assert!(guard(&w).is_empty(), "{:?}", guard(&w)); assert!(record(&w).is_empty(), "{:?}", record(&w)); assert!(!closed_now(&w).is_empty(), "the world must hold a closed receipt"); assert!(w.seasons.iter().filter(|s| w.e.data(&s.receipt)[rc::NS] > 0).count() >= 3, "and written ones"); w }

fn restore(w: &mut World) { for (k, acc) in w.snap.clone() { if let Some(a) = acc { if let Err(er) = w.e.svm.set_account(k, a.clone()) { panic!("restore {} owner {} len {} lamports {}: {:?}", k, a.owner, a.data.len(), a.lamports, er); } } } }
fn mutate(w: &World, r: &mut Rng, base: &Instruction, ids: &[Address]) -> (Instruction, Vec<usize>) {
    let mut ix = base.clone(); let rounds = 1 + r.below(3);
    for _ in 0..rounds { match r.below(9) {
        0 if !ix.data.is_empty() => { let i = r.below(ix.data.len()); ix.data[i] = r.next() as u8; }
        1 if !ix.data.is_empty() => { let n = r.below(ix.data.len() + 1); ix.data.truncate(n); }
        2 => { for _ in 0..r.below(40) { ix.data.push(r.next() as u8); } }
        3 if !ix.accounts.is_empty() => { let i = r.below(ix.accounts.len()); ix.accounts[i].pubkey = w.keys[r.below(w.keys.len())]; }
        4 if !ix.accounts.is_empty() => { let n = r.below(ix.accounts.len() + 1); ix.accounts.truncate(n); }
        5 if !ix.accounts.is_empty() => { let i = r.below(ix.accounts.len()); let m = ix.accounts[i].clone(); ix.accounts.insert(r.below(ix.accounts.len() + 1), m); }
        6 if ix.accounts.len() > 1 => { let (i, j) = (r.below(ix.accounts.len()), r.below(ix.accounts.len())); ix.accounts.swap(i, j); }
        7 if !ix.accounts.is_empty() => { let i = r.below(ix.accounts.len()); ix.accounts[i].is_writable = !ix.accounts[i].is_writable; }
        8 if !ix.accounts.is_empty() => { let i = r.below(ix.accounts.len()); ix.accounts[i].pubkey = ids[r.below(ids.len())]; }
        _ => { if !ix.data.is_empty() { let i = r.below(ix.data.len()); ix.data[i] ^= 1 << r.below(8); } } } }
    // only real keypairs can sign a top-level instruction; the VRF identity may sign the callback (the real oracle does)
    let identity = pda(&[b"identity", w.e.pid.as_ref()], &a(VRF)); for m in ix.accounts.iter_mut() { if m.is_signer && m.pubkey != identity && m.pubkey != w.e.payer.pubkey() && !w.e.players.iter().any(|p| p.pubkey() == m.pubkey) { m.is_signer = false; } }
    // never make a program account a signer through the payer slot confusion; the payer must stay unique-writable-consistent for the message compiler
    (ix, vec![])
}
/// MONEY, from the account bytes: tokens held by players and pools, and for each recorded season whether the pool still covers everything unclaimed and the claimed total equals the paid entries
fn money(w: &World) -> (u64, Vec<String>) {
    let bal = |k: &Address| { let d = w.e.data(k); if d.len() >= 72 { rd64(&d, 64) } else { 0 } };
    let mut supply = 0u64; for p in &w.e.players { supply += bal(&w.e.ata(&p.pubkey())); } let mut bad = vec![];
    for s in &w.seasons { let pool = bal(&w.e.ata(&s.pool)); supply += pool; let c = w.e.data(&s.claims); if c.len() < cl::HDR || c[cl::STATE] != 1 { continue; }
        let (owed, claimed, n) = (rd64(&c, cl::OWED), rd64(&c, cl::CLAIMED), c[cl::N] as usize); let paid: u64 = (0..n).filter(|i| c[cl::HDR + i * cl::ESZ + cl::E_DONE] != 0).map(|i| rd64(&c, cl::HDR + i * cl::ESZ + cl::E_OWED)).sum(); let sum: u64 = (0..n).map(|i| rd64(&c, cl::HDR + i * cl::ESZ + cl::E_OWED)).sum();
        if claimed > owed || pool < owed - claimed || paid != claimed || sum != owed { bad.push(format!("season {}: pool {} owed {} claimed {} paid entries {} entry sum {}", s.sid, pool, owed, claimed, paid, sum)); } }
    (supply, bad) }
/// THE GUARD, from the account bytes: for every strategy, its count is exactly the number of arena slots holding a unit for it; one that is gone (or wiped) is held by none
fn guard(w: &World) -> Vec<String> {
    let mut held: HashMap<u64, u16> = HashMap::new(); for s in &w.seasons { let d = w.e.data(&s.arena); if d.len() < HDR { continue; } for i in 0..usize::from(d[ar::NS]) { let o = HDR + i * SLOT; if d[o + ar::SL_BITS] & B_COUNTED != 0 { *held.entry(rd64(&d, o + ar::SL_ID)).or_default() += 1; } } }
    w.e.strategies.iter().filter_map(|t| { let d = w.e.data(&w.e.strat_pda(t.id)); let alive = d.len() >= STRAT_MIN_SIZE && rd32(&d, 0) != 0; let count = if alive { u16::from_le_bytes([d[S_OPEN], d[S_OPEN + 1]]) & S_OPEN_MASK } else { 0 }; let n = held.get(&t.id).copied().unwrap_or(0); (count != n).then(|| format!("strategy {}: count {} but {} slots hold it (exists: {})", t.id, count, n, alive)) }).collect() }
/// THE RECORD, from the account bytes, against what each strategy really is
fn record(w: &World) -> Vec<String> {
    let mut bad = vec![]; for s in &w.seasons { let d = w.e.data(&s.receipt); if d.len() < RC_SIZE || usize::from(d[rc::NS]) == 0 || d[RC_FORMAT] != RECEIPT_FORMAT { continue; }
        for i in 0..usize::from(d[rc::NS]).min(20) { let id = rd64(&d, RC_ENT + i * 80); let Some(t) = w.e.strategies.iter().find(|t| t.id == id) else { bad.push(format!("season {} entry {}: unknown id {}", s.sid, i, id)); continue }; if d[RC_OWNERS + i * 32..RC_OWNERS + i * 32 + 32] != w.e.players[t.owner].pubkey().to_bytes() || d[RC_ENT + i * 80 + 8..RC_ENT + i * 80 + 40] != code_commit(&t.salt, &t.code) { bad.push(format!("season {} entry {}: the receipt names the wrong owner or commitment", s.sid, i)); } } }
    bad }
/// a receipt that was closed before the transaction is the same after it, except that ReleaseBond zeroes the releasable amount
fn closed_changed(before: &[(Address, Vec<u8>)], w: &World) -> Vec<String> { before.iter().filter_map(|(k, d0)| { let mut d1 = w.e.data(k); let mut d0 = d0.clone(); if d1.len() == d0.len() && d1.len() >= RC_V2_SIZE { d1[rc::RELEASE..rc::RELEASE + 8].fill(0); d0[rc::RELEASE..rc::RELEASE + 8].fill(0); } (d0 != d1).then(|| format!("closed receipt {} changed", k)) }).collect() }
fn closed_now(w: &World) -> Vec<(Address, Vec<u8>)> { w.seasons.iter().filter_map(|s| { let d = w.e.data(&s.receipt); (d.len() >= RC_V2_SIZE && d[rc::STATE] == 2).then_some((s.receipt, d)) }).collect() }
static ACCEPTED_GUARD_MOVES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ACCEPTED_CLAIM_STATES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
fn run(iters: u64, seed: u64, corrupt: bool) -> (u64, Vec<String>, HashMap<String, u64>) {
    let mut w = build(); let ids: Vec<Address> = (0..24).map(|_| Address::new_unique()).collect(); let mut findings = vec![]; let mut hist: HashMap<String, u64> = HashMap::new(); let n_t = w.templates.len();
    for it in 0..iters { let mut r = Rng(seed ^ it.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1); for _ in 0..4 { r.next(); }
        let base = w.templates[r.below(n_t)].clone(); let (ix, _) = mutate(&w, &mut r, &base, &ids); let mut note = String::new();
        if corrupt { let k = 1 + r.below(6); for _ in 0..k { let key = w.program_owned[r.below(w.program_owned.len())]; if let Some(mut acc) = w.e.svm.get_account(&key) { if acc.data.is_empty() { continue; } let n = 1 + r.below(8); for _ in 0..n { let i = r.below(acc.data.len()); acc.data[i] = if r.chance(1, 3) { [0u8, 0xFF, 0x7F, 0x80][r.below(4)] } else { r.next() as u8 }; } note.push_str(&format!("{} ", key)); w.e.svm.set_account(key, acc).unwrap(); } } }
        w.e.fresh_blockhash(); let kps: Vec<solana_keypair::Keypair> = (0..w.e.players.len()).map(|i| w.e.player(i)).collect(); let refs: Vec<&solana_keypair::Keypair> = kps.iter().collect();
        let supply0 = if corrupt { 0 } else { money(&w).0 }; let closed0 = if corrupt { vec![] } else { closed_now(&w) };
        // verified signatures, except when the mutated instruction carries the oracle identity as a signer (the VRF callback stand-in)
        let oracle = pda(&[b"identity", w.e.pid.as_ref()], &a(VRF)); let unverified = ix.accounts.iter().any(|m| m.is_signer && m.pubkey == oracle); w.e.svm.set_sigverify(!unverified);
        let res = w.e.send(&[ix.clone()], &refs); w.e.svm.set_sigverify(true);
        if !corrupt && res.is_ok() { let (supply1, bad) = money(&w); if supply1 != supply0 { findings.push(format!("iter {} MONEY: token supply {} -> {} after tag {:?}", it, supply0, supply1, ix.data.first())); } for b in bad { findings.push(format!("iter {} MONEY: {} after tag {:?}", it, b, ix.data.first())); }
            for b in record(&w).into_iter().chain(closed_changed(&closed0, &w)) { findings.push(format!("iter {} RECORD: {} after tag {:?}", it, b, ix.data.first())); }
            for b in guard(&w) { findings.push(format!("iter {} GUARD: {} after tag {:?}", it, b, ix.data.first())); } if matches!(ix.data.first(), Some(6 | 10 | 11 | 15 | 17 | 24 | 25)) { ACCEPTED_GUARD_MOVES.fetch_add(1, std::sync::atomic::Ordering::Relaxed); }
            if matches!(ix.data.first(), Some(10 | 17 | 22)) { ACCEPTED_CLAIM_STATES.fetch_add(1, std::sync::atomic::Ordering::Relaxed); } if findings.len() >= 20 { break; } }
        let class = match &res { Ok(_) => "ok".to_string(), Err(e) => format!("{:?}", e.err).chars().take(60).collect() }; *hist.entry(class.clone()).or_default() += 1;
        if failed_to_complete(&res) { let logs = &res.as_ref().err().unwrap().meta.logs; let cu = logs.iter().any(|l| l.contains("exceeded")); if !cu { let tag = ix.data.first().copied().unwrap_or(255); findings.push(format!("iter {} tag {} data {}B [{}] accounts [{}]: {} | {}", it, tag, ix.data.len(), ix.data.iter().take(24).map(|b| format!("{:02x}", b)).collect::<String>(), ix.accounts.iter().map(|m| format!("{}{}{}", w.keys.iter().position(|k| *k == m.pubkey).map(|i| i.to_string()).unwrap_or("x".into()), if m.is_signer {"s"} else {""}, if m.is_writable {"w"} else {""})).collect::<Vec<_>>().join(","), class, logs.iter().cloned().collect::<Vec<_>>().join(" // "))); if findings.len() >= 20 { break; } } }
        restore(&mut w); }
    (iters, findings, hist) }

#[test] fn adversarial_inputs_never_abort_the_program() { let n: u64 = std::env::var("SVM_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000); let (it, f, h) = run(n, 0xC0FFEE, false);
    let mut top: Vec<_> = h.into_iter().collect(); top.sort_by(|a, b| b.1.cmp(&a.1)); println!("FUZZ money: supply and claims books checked after every accepted mutated transaction; {} accepted Settle/Cancel/Claim among them", ACCEPTED_CLAIM_STATES.load(std::sync::atomic::Ordering::Relaxed)); println!("FUZZ record: owners and commitments on every written receipt, and closed receipts unchanged, checked after the same transactions"); println!("FUZZ guard: open-entry counts checked after every accepted mutated transaction; {} accepted Enter/Settle/Publish/Cleanup/Cancel/Close among them", ACCEPTED_GUARD_MOVES.load(std::sync::atomic::Ordering::Relaxed)); println!("FUZZ inputs: {} iterations; outcomes: {}", it, top.iter().take(8).map(|(k, v)| format!("{} x{}", k, v)).collect::<Vec<_>>().join(" | ")); for x in &f { println!("FINDING {}", x); } assert!(f.is_empty(), "{} aborts found", f.len()); }
#[test] fn corrupted_state_never_aborts_the_program() { let n: u64 = std::env::var("SVM_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000); let (it, f, h) = run(n, 0xBADC0DE, true);
    let mut top: Vec<_> = h.into_iter().collect(); top.sort_by(|a, b| b.1.cmp(&a.1)); println!("FUZZ corrupted state: {} iterations; outcomes: {}", it, top.iter().take(8).map(|(k, v)| format!("{} x{}", k, v)).collect::<Vec<_>>().join(" | ")); for x in &f { println!("FINDING {}", x); } assert!(f.is_empty(), "{} aborts found", f.len()); }
