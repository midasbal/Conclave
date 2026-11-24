//! Property test of the program's account and instruction parsing against malformed and adversarial inputs, run through the real bytecode.
//! Valid instructions for every tag and every lifecycle stage are mutated (data bytes, account substitution, order, duplicates, dropped accounts, flag flips) and sent.
//! Oracle: the program must answer with success or an error code. An abort (ProgramFailedToComplete that is not a compute-meter overrun) is a finding.
//! A second pass also corrupts program-owned account bytes before the call: that state is not reachable by a transaction, so findings there are reported separately.
mod common;
use common::*;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use std::collections::HashMap;

struct Rng(u64);
impl Rng { fn next(&mut self) -> u64 { let mut x = self.0; x ^= x >> 12; x ^= x << 25; x ^= x >> 27; self.0 = x; x.wrapping_mul(0x2545_F491_4F6C_DD1D) } fn below(&mut self, n: usize) -> usize { (self.next() % n.max(1) as u64) as usize } fn chance(&mut self, n: u64, d: u64) -> bool { self.next() % d < n } }

struct World { e: Env, keys: Vec<Address>, snap: Vec<(Address, Option<Account>)>, templates: Vec<Instruction>, program_owned: Vec<Address> }
fn build() -> World {
    let mut e = Env::new(5); let names = ["Mom20th", "EMAcross", "TrendSwitch", "SwitchTwo", "SwitchFade"]; let mut seasons: Vec<Season> = vec![]; let mut templates: Vec<Instruction> = vec![];
    // stage 1: open arena with entries and finals enabled
    let mut sa0 = e.season(9001); e.init_pool(&sa0).unwrap(); e.init_receipt(&sa0).unwrap(); e.create_season(&mut sa0, 4, 10, 6, true, 2).unwrap(); let st: Vec<Strat> = (0..5).map(|i| e.register_and_seal(i, names[i], code_of(names[i]))).collect(); e.enter(&mut sa0, &st[0]).unwrap(); e.enter(&mut sa0, &st[1]).unwrap(); seasons.push(sa0.clone());
    // stage 2: locked and requested, stage 3: seeded and part-run, stage 4: done, stage 5: settled with some ranks published, stage 6: settled, finals started
    let mk = |e: &mut Env, sid: u64, upto: u8| -> Season { let mut s = e.season(sid); e.init_pool(&s).unwrap(); e.init_receipt(&s).unwrap(); e.create_season(&mut s, 3, 10, 6, true, 2).unwrap(); for i in 0..4 { let t = e.register_and_seal(i, names[i], code_of(names[i])); e.enter(&mut s, &t).unwrap(); }
        if upto >= 1 { e.lock(&s).unwrap(); e.request_seed(&s).unwrap(); } if upto >= 2 { e.deliver_seed(&mut s, [sid as u8; 32]).unwrap(); e.warp(1_000_000); e.fresh_blockhash(); e.advance(&s, 650, 650_000).unwrap(); } if upto >= 3 { e.drive(&s, 1400, 1_400_000); } if upto >= 4 { e.settle(&s).unwrap(); e.publish(&s, 0).unwrap(); e.publish(&s, 2).unwrap(); } s };
    for (i, up) in [1u8, 2, 3, 4].iter().enumerate() { seasons.push(mk(&mut e, 9010 + i as u64, *up)); }
    let mut s6 = mk(&mut e, 9020, 4); for i in [1usize, 3] { e.publish(&s6, i).unwrap(); } let (r, f) = e.start_finals(&s6, 9021, 3, 3); r.unwrap(); e.init_receipt(&f).unwrap(); seasons.push(s6.clone()); seasons.push(f.clone()); s6.entries.truncate(4);
    // template instructions, one family per tag and stage
    let all_strats: Vec<Strat> = e.strategies.clone(); let hub = e.hub; let pid = e.pid;
    for s in &seasons {
        templates.push(e.ix(7, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.arena)], vec![])); templates.push(e.ix(8, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.arena), e.ro(pda(&[b"identity"], &pid)), e.rw(Address::new_unique()), e.ro(a(SYSTEM)), e.ro(a(SLOT_HASHES)), e.ro(a(VRF))], vec![]));
        templates.push(e.advance_ix(s, 65535, 1400)); templates.push(e.advance_ix(s, 3, 650)); templates.push(e.settle_ix(s, s.pool, &all_strats[..4.min(all_strats.len())].to_vec())); templates.push(e.cleanup_ix(s));
        for i in 0..3 { templates.push(e.publish_ix(s, i, all_strats[i].id)); } let mut d = s.sid.to_le_bytes().to_vec(); d.extend([3u8, 3, 0, 0, 0, 1, 0, 0, 0]);
        templates.push(e.ix(14, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.arena), e.rw(hub), e.rw(e.arena_pda(s.sid + 500)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(MAGIC)), e.ro(a(PERMISSION))], { let mut d = (s.sid + 500).to_le_bytes().to_vec(); d.extend([3u8, 3, 0, 0, 0, 1, 0, 0, 0]); d }));
        templates.push(e.create_season_ix(s, 5, 1, 7, 6, 2, 1)); for t in all_strats.iter().take(3) { templates.push(e.enter_ix(s, t, t.owner)); }
        templates.push(e.ix(13, vec![e.m(e.payer.pubkey(), true, true), e.rw(Address::new_unique()), e.ro(s.pool), e.ro(e.mint), e.ro(a(SYSTEM)), e.ro(a(ESPL)), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique()), e.rw(e.ata(&s.pool)), e.ro(a(ATOKEN)), e.ro(a(TOKEN))], s.sid.to_le_bytes().to_vec()));
        templates.push(e.ix(16, vec![e.m(e.payer.pubkey(), true, true), e.rw(s.receipt), e.ro(a(SYSTEM))], s.sid.to_le_bytes().to_vec()));
        let mut cm = vec![e.m(e.payer.pubkey(), true, true), e.ro(a(MAGIC)), e.rw(a(MAGIC_CTX)), e.rw(s.receipt)]; for t in all_strats.iter().take(3) { cm.push(e.rw(e.reg_pda(t.id))); } templates.push(e.ix(12, cm, vec![]));
        let id = pda(&[b"identity", pid.as_ref()], &a(VRF)); let mut d = CB_DISC.to_vec(); d.extend([7u8; 32]); templates.push(Instruction { program_id: pid, accounts: vec![AccountMeta::new_readonly(id, true), AccountMeta::new(s.arena, false)], data: d }); }
    for t in all_strats.iter().take(5) { templates.push(e.seal_ix(t, t.owner)); templates.push(e.ix(1, vec![e.m(e.players[t.owner].pubkey(), true, true), e.rw(e.reg_pda(t.id)), e.ro(a(SYSTEM))], { let mut d = t.id.to_le_bytes().to_vec(); d.extend([1u8; 32]); d }));
        let mut d = vec![1u8]; d.extend(t.id.to_le_bytes()); templates.push(e.ix(2, vec![e.m(e.players[t.owner].pubkey(), true, true), e.ro(a(SYSTEM)), e.rw(e.reg_pda(t.id)), e.ro(pid), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.rw(Address::new_unique()), e.ro(a(DLP)), e.ro(Address::new_unique())], d)); }
    templates.push(e.ix(0, vec![e.m(e.payer.pubkey(), true, true), e.rw(hub), e.ro(a(SYSTEM))], 5u64.to_le_bytes().to_vec()));
    let mut ud = vec![196u8, 28, 41, 206, 48, 37, 51, 167, 2, 0, 0, 0, 4, 0, 0, 0, b'h', b'u', b'b', 0]; ud.extend([0u8; 8]); templates.push(Instruction { program_id: pid, accounts: vec![AccountMeta::new(hub, false), AccountMeta::new(Address::new_unique(), false), AccountMeta::new(e.payer.pubkey(), true), AccountMeta::new_readonly(a(SYSTEM), false)], data: ud });
    // account universe and snapshot
    let mut keys: Vec<Address> = vec![hub, e.mint, e.payer.pubkey()]; keys.extend(e.players.iter().map(|p| p.pubkey())); let mut program_owned = vec![hub];
    for s in &seasons { keys.extend([s.arena, s.receipt, s.pool, e.ata(&s.pool)]); program_owned.extend([s.arena, s.receipt]); } for t in &all_strats { keys.extend([e.reg_pda(t.id), e.strat_pda(t.id)]); program_owned.extend([e.reg_pda(t.id), e.strat_pda(t.id)]); } for p in &e.players { keys.push(e.ata(&p.pubkey())); }
    keys.extend([pid, a(MAGIC), a(PERMISSION), a(VRF), a(ESPL), a(DLP), a(TOKEN), a(ATOKEN), a(SYSTEM), a(SLOT_HASHES), a(MAGIC_CTX)]); keys.sort(); keys.dedup();
    let snap = keys.iter().map(|k| (*k, e.svm.get_account(k))).collect(); World { e, keys, snap, templates, program_owned } }

fn restore(w: &mut World) { for (k, acc) in w.snap.clone() { if let Some(a) = acc { w.e.svm.set_account(k, a).unwrap(); } } }
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
fn run(iters: u64, seed: u64, corrupt: bool) -> (u64, Vec<String>, HashMap<String, u64>) {
    let mut w = build(); let ids: Vec<Address> = (0..24).map(|_| Address::new_unique()).collect(); let mut findings = vec![]; let mut hist: HashMap<String, u64> = HashMap::new(); let n_t = w.templates.len();
    for it in 0..iters { let mut r = Rng(seed ^ it.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1); for _ in 0..4 { r.next(); }
        let base = w.templates[r.below(n_t)].clone(); let (ix, _) = mutate(&w, &mut r, &base, &ids); let mut note = String::new();
        if corrupt { let k = 1 + r.below(6); for _ in 0..k { let key = w.program_owned[r.below(w.program_owned.len())]; if let Some(mut acc) = w.e.svm.get_account(&key) { if acc.data.is_empty() { continue; } let n = 1 + r.below(8); for _ in 0..n { let i = r.below(acc.data.len()); acc.data[i] = if r.chance(1, 3) { [0u8, 0xFF, 0x7F, 0x80][r.below(4)] } else { r.next() as u8 }; } note.push_str(&format!("{} ", key)); w.e.svm.set_account(key, acc).unwrap(); } } }
        w.e.fresh_blockhash(); let kps: Vec<solana_keypair::Keypair> = (0..w.e.players.len()).map(|i| w.e.player(i)).collect(); let refs: Vec<&solana_keypair::Keypair> = kps.iter().collect();
        let res = w.e.send(&[ix.clone()], &refs);
        let class = match &res { Ok(_) => "ok".to_string(), Err(e) => format!("{:?}", e.err).chars().take(60).collect() }; *hist.entry(class.clone()).or_default() += 1;
        if failed_to_complete(&res) { let logs = &res.as_ref().err().unwrap().meta.logs; let cu = logs.iter().any(|l| l.contains("exceeded")); if !cu { let tag = ix.data.first().copied().unwrap_or(255); findings.push(format!("iter {} tag {} data {}B [{}] accounts [{}]: {} | {}", it, tag, ix.data.len(), ix.data.iter().take(24).map(|b| format!("{:02x}", b)).collect::<String>(), ix.accounts.iter().map(|m| format!("{}{}{}", w.keys.iter().position(|k| *k == m.pubkey).map(|i| i.to_string()).unwrap_or("x".into()), if m.is_signer {"s"} else {""}, if m.is_writable {"w"} else {""})).collect::<Vec<_>>().join(","), class, logs.iter().cloned().collect::<Vec<_>>().join(" // "))); if findings.len() >= 20 { break; } } }
        restore(&mut w); }
    (iters, findings, hist) }

#[test] fn adversarial_inputs_never_abort_the_program() { let n: u64 = std::env::var("SVM_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000); let (it, f, h) = run(n, 0xC0FFEE, false);
    let mut top: Vec<_> = h.into_iter().collect(); top.sort_by(|a, b| b.1.cmp(&a.1)); println!("FUZZ inputs: {} iterations; outcomes: {}", it, top.iter().take(8).map(|(k, v)| format!("{} x{}", k, v)).collect::<Vec<_>>().join(" | ")); for x in &f { println!("FINDING {}", x); } assert!(f.is_empty(), "{} aborts found", f.len()); }
#[test] fn corrupted_state_never_aborts_the_program() { let n: u64 = std::env::var("SVM_FUZZ_ITERS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000); let (it, f, h) = run(n, 0xBADC0DE, true);
    let mut top: Vec<_> = h.into_iter().collect(); top.sort_by(|a, b| b.1.cmp(&a.1)); println!("FUZZ corrupted state: {} iterations; outcomes: {}", it, top.iter().take(8).map(|(k, v)| format!("{} x{}", k, v)).collect::<Vec<_>>().join(" | ")); for x in &f { println!("FINDING {}", x); } assert!(f.is_empty(), "{} aborts found", f.len()); }
