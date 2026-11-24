//! In-process SVM harness for the conclave program.
//! REAL: the compiled conclave program bytecode (program/target/deploy/conclave.so), and the System, SPL Token and Associated Token programs that LiteSVM ships.
//! STOOD IN (see standins/src/lib.rs): the Magic, permission, VRF oracle, eSPL and delegation programs, which only exist inside the rollup validators.
#![allow(dead_code)]
use litesvm::{types::{FailedTransactionMetadata, TransactionMetadata}, LiteSVM};
use sha2::{Digest, Sha256};
use solana_account::Account;
pub use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
pub use solana_signer::Signer;
use solana_transaction::Transaction;
use std::str::FromStr;

pub const MAGIC: &str = "Magic11111111111111111111111111111111111111";
pub const MAGIC_CTX: &str = "MagicContext1111111111111111111111111111111";
pub const PERMISSION: &str = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";
pub const VRF: &str = "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz";
pub const ESPL: &str = "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2";
pub const DLP: &str = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
pub const TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ATOKEN: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const SYSTEM: &str = "11111111111111111111111111111111";
pub const SLOT_HASHES: &str = "SysvarS1otHashes111111111111111111111111111";
pub fn a(s: &str) -> Address { Address::from_str(s).unwrap() }
pub fn pda(seeds: &[&[u8]], pid: &Address) -> Address { Address::find_program_address(seeds, pid).0 }
pub fn u64le(v: u64) -> [u8; 8] { v.to_le_bytes() }

// ---- layouts (mirror of program/src/lib.rs; the tests assert against these, they are not imported so a layout change must be made here on purpose) ----
pub const HDR: usize = 1280; pub const SLOT: usize = 440; pub const STRAT_SIZE: usize = 136 + 260; pub const REG_SIZE: usize = 128; pub const RC_ENT: usize = 192; pub const RC_SIZE: usize = RC_ENT + 20 * 80;
pub fn arena_size(maxs: usize) -> usize { HDR + maxs * SLOT }
pub mod ar { pub const FLAGS: usize = 4; pub const NS: usize = 5; pub const SEASON: usize = 40; pub const SEED: usize = 48; pub const NEPS: usize = 80; pub const CUREP: usize = 88; pub const CURTICK: usize = 92; pub const START: usize = 96; pub const POOL: usize = 112; pub const TICKS: usize = 152; pub const RESERVE: usize = 1120; pub const F2: usize = 1128; pub const PUBN: usize = 1129; pub const PINS: usize = 1152; pub const DIV: usize = 1200;
    pub const SL_OWNER: usize = 0; pub const SL_ID: usize = 32; pub const SL_WINS: usize = 42; pub const SL_RANK: usize = 44; pub const SL_TOTAL: usize = 48; pub const SL_SEAT: usize = 64; }
pub mod arx { pub const CREATED: usize = 1208; pub const WINDOW: usize = 1216; pub const SEEDTO: usize = 1224; pub const LOCKAT: usize = 1232; pub const SETTLEDAT: usize = 1240; pub const PUBGRACE: usize = 1248; pub const RENT: usize = 1256; pub const MINS: usize = 1264; pub const REASON: usize = 1265; pub const FEE: usize = 104; pub const AUTH: usize = 8; }
pub mod rc { pub const KIND: usize = 4; pub const NS: usize = 5; pub const PUB: usize = 6; pub const SEASON: usize = 8; pub const CREATOR: usize = 104; pub const BOND: usize = 136; pub const STATE: usize = 144; pub const REASON: usize = 145; pub const REFUNDED: usize = 152; pub const RENT: usize = 160; pub const RECLAIMED: usize = 168; pub const FORFEIT: usize = 176; pub const RELEASE: usize = 184; }
pub const F2_FINALS: u8 = 1; pub const F2_HASFIN: u8 = 2; pub const F2_FINSTARTED: u8 = 4; pub const F2_CANCELLED: u8 = 8; pub const F2_REFUNDED: u8 = 16;
pub const BOND: u64 = 2_000_000;
pub const F_LOCKED: u8 = 1; pub const F_REQ: u8 = 2; pub const F_SEEDED: u8 = 4; pub const F_DONE: u8 = 8; pub const F_SETTLED: u8 = 16;
pub fn rd64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
pub fn rdi64(d: &[u8], o: usize) -> i64 { rd64(d, o) as i64 }
pub fn rd32(d: &[u8], o: usize) -> u32 { u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] { let mut h = Sha256::new(); for p in parts { h.update(p); } h.finalize().into() }
pub fn code_commit(salt: &[u8; 32], code: &[u8]) -> [u8; 32] { sha256(&[b"CNCL-CODE-v1", salt, code]) }
pub fn score_commit(salt: &[u8; 32], season: u64, id: u64, total: i64, wins: u16, neps: u32) -> [u8; 32] { sha256(&[b"CNCL-SCORE-v1", salt, &season.to_le_bytes(), &id.to_le_bytes(), &total.to_le_bytes(), &wins.to_le_bytes(), &neps.to_le_bytes()]) }

pub type Res = Result<TransactionMetadata, FailedTransactionMetadata>;
/// the custom error code of a failed transaction, if it failed with one
pub fn custom(r: &Res) -> Option<u32> { match r { Err(e) => match &e.err { solana_transaction_error::TransactionError::InstructionError(_, solana_instruction::error::InstructionError::Custom(c)) => Some(*c), _ => None }, _ => None } }
pub fn failed_to_complete(r: &Res) -> bool { matches!(r, Err(e) if matches!(&e.err, solana_transaction_error::TransactionError::InstructionError(_, solana_instruction::error::InstructionError::ProgramFailedToComplete))) }
pub fn err_string(r: &Res) -> String { match r { Ok(_) => "ok".into(), Err(e) => format!("{:?}", e.err) } }

#[derive(Clone, Copy)] pub struct Params { pub window: u64, pub seedto: u64, pub grace: u64, pub mins: u8, pub bond: u64 }
pub const LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";
pub struct Env { pub config: Address, pub params: Params, pub svm: LiteSVM, pub pid: Address, pub payer: Keypair, pub players: Vec<Keypair>, pub mint: Address, pub hub: Address, pub slot: u64, pub nonce: u64, pub strategies: Vec<Strat> }
#[derive(Clone)] pub struct Strat { pub id: u64, pub owner: usize, pub salt: [u8; 32], pub code: Vec<u8>, pub name: String }

fn conclave_so() -> Vec<u8> { std::fs::read(std::env::var("CONCLAVE_SO").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../program/target/deploy/conclave.so").to_string())).expect("build the program first: (cd program && cargo build-sbf)") }
fn standin_so() -> Vec<u8> { std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/standins/target/deploy/conclave_svm_standins.so")).expect("build the stand-ins first: (cd tests/svm/standins && cargo build-sbf)") }

impl Env {
    pub fn new(nplayers: usize) -> Env { Env::new_with(nplayers, true) }
    /// configure=false leaves the config account uncreated so InitConfig itself can be tested
    pub fn new_with(nplayers: usize, configure: bool) -> Env {
        let mut svm = LiteSVM::new().with_sigverify(false).with_blockhash_check(false);
        let mut rent = solana_rent::Rent::default(); rent.lamports_per_byte = 0; svm.set_sysvar(&rent); // rent-exempt minimum 0: ER ephemeral accounts hold no lamports
        let pid = Address::new_unique(); svm.add_program(pid, &conclave_so()).unwrap();
        let so = standin_so(); for id in [MAGIC, PERMISSION, VRF, ESPL, DLP] { svm.add_program(a(id), &so).unwrap(); }
        let payer = Keypair::new(); svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        let players: Vec<Keypair> = (0..nplayers).map(|_| Keypair::new()).collect(); for p in &players { svm.airdrop(&p.pubkey(), 10_000_000_000).unwrap(); }
        let hub = pda(&[b"hub"], &pid); svm.warp_to_slot(10);
        let mut e = Env { config: pda(&[b"config"], &pid), params: Params { window: 1_000_000, seedto: 1_000_000, grace: 1_000_000, mins: 1, bond: BOND }, svm, pid, payer, players, mint: Address::new_unique(), hub, slot: 10, nonce: 0, strategies: vec![] };
        e.create_mint(); e.mint_to_players(1_000_000);
        e.ok(&[e.ix(0, vec![e.m(e.payer.pubkey(), true, true), e.m(hub, false, true), e.ro(a(SYSTEM))], u64le(1_000_000).to_vec())], &[], "InitHub");
        if configure { e.init_config(); let m = e.mint; e.admin_ok(2, m.as_ref()); }
        e
    }
    /// LiteSVM already keeps the program's real ProgramData account (the ELF) at the loader's PDA, with no upgrade authority. The real InitConfig checks that account's
    /// Some(upgrade authority) field, so the harness sets that one field in place (layout: tag 3, slot, option tag, authority) and leaves the ELF untouched.
    pub fn programdata_fixture(&mut self, authority: &Address) -> Address { let pd = pda(&[self.pid.as_ref()], &a(LOADER)); let mut acc = self.svm.get_account(&pd).expect("LiteSVM ProgramData"); assert_eq!(u32::from_le_bytes(acc.data[0..4].try_into().unwrap()), 3);
        acc.data[12] = 1; acc.data[13..45].copy_from_slice(authority.as_ref()); self.svm.set_account(pd, acc).unwrap(); pd }
    pub fn init_config_ix(&self, pd: Address, signer: Address) -> Instruction { self.ix(19, vec![self.m(signer, true, true), self.rw(self.config), self.ro(a(SYSTEM)), self.ro(pd)], vec![]) }
    pub fn init_config(&mut self) { let pd = self.programdata_fixture(&self.payer.pubkey()); let ix = self.init_config_ix(pd, self.payer.pubkey()); self.ok(&[ix], &[], "InitConfig"); }
    pub fn admin_ix(&self, signer: Address, sub: u8, payload: &[u8]) -> Instruction { let mut d = vec![sub]; d.extend_from_slice(payload); self.ix(20, vec![self.m(signer, true, signer == self.payer.pubkey()), self.rw(self.config)], d) }
    pub fn admin(&mut self, sub: u8, payload: &[u8]) -> Res { let ix = self.admin_ix(self.payer.pubkey(), sub, payload); self.send(&[ix], &[]) }
    pub fn admin_by(&mut self, who: &Keypair, sub: u8, payload: &[u8]) -> Res { let ix = self.admin_ix(who.pubkey(), sub, payload); self.send(&[ix], &[who]) }
    pub fn admin_ok(&mut self, sub: u8, payload: &[u8]) { let r = self.admin(sub, payload); assert!(r.is_ok(), "Admin {} failed: {}", sub, err_string(&r)); }
    // ---- instruction building ----
    pub fn m(&self, k: Address, signer: bool, writable: bool) -> AccountMeta { if writable { AccountMeta::new(k, signer) } else { AccountMeta::new_readonly(k, signer) } }
    pub fn ro(&self, k: Address) -> AccountMeta { AccountMeta::new_readonly(k, false) }
    pub fn rw(&self, k: Address) -> AccountMeta { AccountMeta::new(k, false) }
    pub fn ix(&self, tag: u8, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction { let mut d = vec![tag]; d.extend(data); Instruction { program_id: self.pid, accounts, data: d } }
    /// send; `extra` are keypairs that must sign besides the payer. `fake_signers` lists addresses that are marked signer without a signature (only possible because the SVM runs with sigverify off; used to play the VRF oracle's callback)
    pub fn send_with(&mut self, ixs: &[Instruction], extra: &[&Keypair], cu: Option<u32>) -> Res {
        self.nonce += 1; let mut all: Vec<Instruction> = vec![];
        if let Some(c) = cu { let mut d = vec![2u8]; d.extend(c.to_le_bytes()); all.push(Instruction { program_id: a("ComputeBudget111111111111111111111111111111"), accounts: vec![], data: d }); }
        // distinct no-op memo-free marker so identical consecutive transactions are not rejected as duplicates
        all.push(Instruction { program_id: a(SYSTEM), accounts: vec![AccountMeta::new(self.payer.pubkey(), true), AccountMeta::new(self.payer.pubkey(), false)], data: { let mut d = vec![2, 0, 0, 0]; d.extend(0u64.to_le_bytes()); d } });
        all.extend_from_slice(ixs);
        let msg = Message::new(&all, Some(&self.payer.pubkey())); let mut tx = Transaction::new_unsigned(msg); let bh = self.svm.latest_blockhash();
        let need: Vec<Address> = tx.message.account_keys[..usize::from(tx.message.header.num_required_signatures)].to_vec(); let mut signers: Vec<&Keypair> = vec![&self.payer]; signers.extend(extra.iter().copied().filter(|k| need.contains(&k.pubkey()))); tx.partial_sign(&signers, bh);
        self.svm.send_transaction(tx)
    }
    pub fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Res { self.send_with(ixs, extra, Some(1_400_000)) }
    pub fn ok(&mut self, ixs: &[Instruction], extra: &[&Keypair], what: &str) { let r = self.send(ixs, extra); assert!(r.is_ok(), "{} failed: {}\n{:?}", what, err_string(&r), r.as_ref().err().map(|e| e.meta.logs.iter().rev().take(6).cloned().collect::<Vec<_>>())); }
    pub fn fresh_blockhash(&mut self) { self.svm.expire_blockhash(); }
    // ---- accounts ----
    pub fn data(&self, k: &Address) -> Vec<u8> { self.svm.get_account(k).map(|x| x.data).unwrap_or_default() }
    pub fn set_data(&mut self, k: &Address, f: impl FnOnce(&mut Vec<u8>)) { let mut acc = self.svm.get_account(k).unwrap(); f(&mut acc.data); self.svm.set_account(*k, acc).unwrap(); }
    /// what the Magic program does inside the rollup: a zero-data account owned by the calling program appears at the PDA. The SVM needs 1 lamport for it to persist.
    pub fn provision(&mut self, k: Address, size: usize) { self.svm.set_account(k, Account { lamports: 1, data: vec![0; size], owner: self.pid, executable: false, rent_epoch: 0 }).unwrap(); }
    pub fn warp(&mut self, slots: u64) { self.slot += slots; self.svm.warp_to_slot(self.slot); }
    // ---- tokens (real SPL Token + ATA programs) ----
    pub fn ata(&self, owner: &Address) -> Address { pda(&[owner.as_ref(), a(TOKEN).as_ref(), self.mint.as_ref()], &a(ATOKEN)) }
    fn create_mint(&mut self) { let mint = Keypair::new(); self.mint = mint.pubkey(); let tok = a(TOKEN); let auth = self.payer.pubkey();
        let create = solana_system_interface_create(&auth, &self.mint, 1_000_000_000, 82, &tok); let mut init = vec![20u8, 0]; init.extend_from_slice(auth.as_ref()); init.push(0); init.extend_from_slice(&[0u8; 32]);
        let i2 = Instruction { program_id: tok, accounts: vec![AccountMeta::new(self.mint, false)], data: init }; let r = self.send(&[create, i2], &[&mint]); assert!(r.is_ok(), "mint: {}", err_string(&r)); }
    pub fn create_ata(&mut self, owner: &Address) -> Address { let ata = self.ata(owner); let ix = Instruction { program_id: a(ATOKEN), accounts: vec![AccountMeta::new(self.payer.pubkey(), true), AccountMeta::new(ata, false), AccountMeta::new_readonly(*owner, false), AccountMeta::new_readonly(self.mint, false), AccountMeta::new_readonly(a(SYSTEM), false), AccountMeta::new_readonly(a(TOKEN), false)], data: vec![1] }; let r = self.send(&[ix], &[]); assert!(r.is_ok(), "ata: {}", err_string(&r)); ata }
    pub fn mint_to(&mut self, dest: &Address, amount: u64) { let mut d = vec![7u8]; d.extend(amount.to_le_bytes()); let ix = Instruction { program_id: a(TOKEN), accounts: vec![AccountMeta::new(self.mint, false), AccountMeta::new(*dest, false), AccountMeta::new_readonly(self.payer.pubkey(), true)], data: d }; let r = self.send(&[ix], &[]); assert!(r.is_ok(), "mint_to: {}", err_string(&r)); }
    fn mint_to_players(&mut self, amount: u64) { let owners: Vec<Address> = self.players.iter().map(|p| p.pubkey()).collect(); for o in owners { let ata = self.create_ata(&o); self.mint_to(&ata, amount); } }
    pub fn balance(&self, owner: &Address) -> u64 { rd64(&self.data(&self.ata(owner)), 64) }
}
fn solana_system_interface_create(from: &Address, to: &Address, lamports: u64, space: u64, owner: &Address) -> Instruction {
    let mut d = vec![0u8, 0, 0, 0]; d.extend(lamports.to_le_bytes()); d.extend(space.to_le_bytes()); d.extend_from_slice(owner.as_ref());
    Instruction { program_id: a(SYSTEM), accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)], data: d } }

// ---- strategies ----
pub fn pool_codes() -> Vec<(String, Vec<u8>)> { conclave_lab::pool::fixed_pool().into_iter().map(|s| (s.name, s.code)).collect() }
pub fn code_of(name: &str) -> Vec<u8> { pool_codes().into_iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("no strategy {}", name)).1 }

impl Env {
    /// register on base (public registry, salted commitment); returns the strategy
    pub fn register(&mut self, owner: usize, name: &str, code: Vec<u8>) -> Strat {
        self.nonce += 1; let id = 0x1000_0000_0000_0000u64 + self.nonce * 7919 + self.strategies.len() as u64; let mut salt = [0u8; 32]; for (i, b) in salt.iter_mut().enumerate() { *b = (id.wrapping_mul(i as u64 + 31) >> 3) as u8 ^ (i as u8 * 17); }
        let reg = pda(&[b"reg", &id.to_le_bytes()], &self.pid); let commit = code_commit(&salt, &code); let ow = self.players[owner].pubkey(); let mut d = id.to_le_bytes().to_vec(); d.extend_from_slice(&commit);
        let ix = self.ix(1, vec![self.m(ow, true, true), self.rw(reg), self.ro(a(SYSTEM))], d); let kp = Keypair::try_from(&self.players[owner].to_bytes()[..]).unwrap(); self.ok(&[ix], &[&kp], "Register");
        let s = Strat { id, owner, salt, code, name: name.into() }; self.strategies.push(s.clone()); s }
    pub fn reg_pda(&self, id: u64) -> Address { pda(&[b"reg", &id.to_le_bytes()], &self.pid) }
    pub fn strat_pda(&self, id: u64) -> Address { pda(&[b"strat", &id.to_le_bytes()], &self.pid) }
    pub fn arena_pda(&self, sid: u64) -> Address { pda(&[b"arena", &sid.to_le_bytes()], &self.pid) }
    pub fn pool_pda(&self, sid: u64) -> Address { pda(&[b"pool", &sid.to_le_bytes()], &self.pid) }
    pub fn receipt_pda(&self, sid: u64) -> Address { pda(&[b"receipt", &sid.to_le_bytes()], &self.pid) }
    pub fn seal_ix(&self, s: &Strat, signer: usize) -> Instruction { let mut d = s.id.to_le_bytes().to_vec(); d.extend_from_slice(&s.salt); d.extend_from_slice(&s.code); let ow = self.players[signer].pubkey();
        self.ix(3, vec![self.m(ow, true, false), self.rw(self.hub), self.rw(self.strat_pda(s.id)), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.ro(self.reg_pda(s.id))], d) }
    pub fn player(&self, i: usize) -> Keypair { Keypair::try_from(&self.players[i].to_bytes()[..]).unwrap() }
    pub fn seal(&mut self, s: &Strat) -> Res { self.provision_if_new(self.strat_pda(s.id), STRAT_SIZE); let ix = self.seal_ix(s, s.owner); let kp = self.player(s.owner); self.send(&[ix], &[&kp]) }
    pub fn provision_if_new(&mut self, k: Address, size: usize) { if self.svm.get_account(&k).is_none() { self.provision(k, size); } }
    pub fn register_and_seal(&mut self, owner: usize, name: &str, code: Vec<u8>) -> Strat { let s = self.register(owner, name, code); let r = self.seal(&s); assert!(r.is_ok(), "Seal {}: {}", name, err_string(&r)); s }
}

// ================= season lifecycle helpers =================
pub const CB_DISC: [u8; 8] = [200, 1, 2, 3, 4, 5, 6, 7];
#[derive(Clone)] pub struct Season { pub sid: u64, pub arena: Address, pub receipt: Address, pub pool: Address, pub maxs: usize, pub entries: Vec<Strat>, pub seed: [u8; 32], pub neps: u32, pub fee: u64 }
impl Env {
    pub fn season(&self, sid: u64) -> Season { Season { sid, arena: self.arena_pda(sid), receipt: self.receipt_pda(sid), pool: self.pool_pda(sid), maxs: 20, entries: vec![], seed: [0; 32], neps: 0, fee: 0 } }
    pub fn init_receipt(&mut self, s: &Season) -> Res { let b = self.params.bond; self.init_receipt_bond(s, b) }
    pub fn init_receipt_bond(&mut self, s: &Season, bond: u64) -> Res { let mut d = s.sid.to_le_bytes().to_vec(); d.extend(bond.to_le_bytes()); let ix = self.ix(16, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.receipt), self.ro(a(SYSTEM))], d); self.send(&[ix], &[]) }
    pub fn init_pool(&mut self, s: &Season) -> Res {
        let eata = pda(&[s.pool.as_ref(), self.mint.as_ref()], &a(ESPL)); let accts = vec![self.m(self.payer.pubkey(), true, true), self.rw(eata), self.ro(s.pool), self.ro(self.mint), self.ro(a(SYSTEM)), self.ro(a(ESPL)), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(DLP)), self.ro(Address::new_unique()), self.rw(self.ata(&s.pool)), self.ro(a(ATOKEN)), self.ro(a(TOKEN))];
        let ix = self.ix(13, accts, s.sid.to_le_bytes().to_vec()); self.send(&[ix], &[]) }
    pub fn create_season_ix(&self, s: &Season, neps: u32, spt: u32, fee: u64, maxs: u8, flags: u8, division: u8) -> Instruction {
        let mut d = s.sid.to_le_bytes().to_vec(); d.extend(neps.to_le_bytes()); d.extend(spt.to_le_bytes()); d.extend(fee.to_le_bytes()); d.extend_from_slice(self.mint.as_ref()); d.extend([maxs, flags, division]); let p = self.params; d.extend(p.window.to_le_bytes()); d.extend(p.seedto.to_le_bytes()); d.extend(p.grace.to_le_bytes()); d.push(p.mins);
        self.ix(5, vec![self.m(self.payer.pubkey(), true, true), self.rw(self.hub), self.rw(s.arena), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.rw(s.receipt), self.ro(self.config)], d) }
    pub fn create_season(&mut self, s: &mut Season, neps: u32, fee: u64, maxs: u8, finals: bool, division: u8) -> Res { self.provision_if_new(s.arena, arena_size(maxs as usize)); if self.svm.get_account(&s.receipt).is_none() { let r = self.init_receipt(s); assert!(r.is_ok(), "InitReceipt {}", err_string(&r)); } s.maxs = maxs as usize; s.neps = neps; s.fee = fee;
        let ix = self.create_season_ix(s, neps, 1, fee, maxs, if finals { 2 } else { 0 }, division); self.send(&[ix], &[]) }
    pub fn enter_ix(&self, s: &Season, st: &Strat, signer: usize) -> Instruction { let ow = self.players[signer].pubkey(); let owner_of_strat = self.players[st.owner].pubkey();
        let _ = owner_of_strat; self.ix(6, vec![self.m(ow, true, false), self.ro(self.strat_pda(st.id)), self.rw(s.arena), self.rw(self.ata(&ow)), self.rw(self.ata(&s.pool)), self.ro(a(TOKEN)), self.ro(self.config)], vec![]) }
    pub fn enter(&mut self, s: &mut Season, st: &Strat) -> Res { let ix = self.enter_ix(s, st, st.owner); let kp = self.player(st.owner); let r = self.send(&[ix], &[&kp]); if r.is_ok() { s.entries.push(st.clone()); } r }
    pub fn lock(&mut self, s: &Season) -> Res { let ix = self.ix(7, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena)], vec![]); self.send(&[ix], &[]) }
    /// lock signed by someone other than the creator
    pub fn lock_by(&mut self, s: &Season, who: usize) -> Res { let kp = self.player(who); let ix = self.ix(7, vec![self.m(kp.pubkey(), true, false), self.rw(s.arena)], vec![]); self.send(&[ix], &[&kp]) }
    pub fn request_seed(&mut self, s: &Season) -> Res { let identity = pda(&[b"identity"], &self.pid); let ix = self.ix(8, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena), self.ro(identity), self.rw(Address::new_unique()), self.ro(a(SYSTEM)), self.ro(a(SLOT_HASHES)), self.ro(a(VRF))], vec![]); self.send(&[ix], &[]) }
    /// plays the VRF oracle: the real one calls back with the identity PDA of the VRF program as signer
    pub fn deliver_seed(&mut self, s: &mut Season, seed: [u8; 32]) -> Res { let identity = pda(&[b"identity", self.pid.as_ref()], &a(VRF)); let mut d = CB_DISC.to_vec(); d.extend_from_slice(&seed);
        let ix = Instruction { program_id: self.pid, accounts: vec![AccountMeta::new_readonly(identity, true), AccountMeta::new(s.arena, false)], data: d }; s.seed = seed; self.send(&[ix], &[]) }
    pub fn advance_ix(&self, s: &Season, max: u16, budget_k: u16) -> Instruction { let mut d = max.to_le_bytes().to_vec(); d.extend(budget_k.to_le_bytes()); self.ix(9, vec![self.rw(s.arena)], d) }
    pub fn advance(&mut self, s: &Season, budget_k: u16, cu: u32) -> Res { let ix = self.advance_ix(s, 65535, budget_k); self.send_with(&[ix], &[], Some(cu)) }
    pub fn flags(&self, s: &Season) -> u8 { self.data(&s.arena)[ar::FLAGS] }
    pub fn ticks(&self, s: &Season) -> u32 { rd32(&self.data(&s.arena), ar::TICKS) }
    /// drive to completion with real transactions; returns the number of Advance transactions
    pub fn drive(&mut self, s: &Season, budget_k: u16, cu: u32) -> usize { self.warp(2_000_000); let mut n = 0; loop { if self.flags(s) & F_DONE != 0 { return n; } self.fresh_blockhash(); let r = self.advance(s, budget_k, cu); assert!(r.is_ok(), "Advance: {}", err_string(&r)); n += 1; assert!(n < 100_000, "driver does not terminate"); } }
    pub fn pool_accounts(&self, s: &Season) -> Vec<AccountMeta> { let mut v = vec![self.rw(s.pool).clone()]; v[0] = self.ro(s.pool); v }
    pub fn settle_ix(&self, s: &Season, pool_sid_pool: Address, entries: &[Strat]) -> Instruction {
        let mut accts = vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena), self.rw(s.receipt), self.ro(pool_sid_pool), self.rw(self.ata(&pool_sid_pool)), self.ro(a(TOKEN))]; for e in entries { accts.push(self.rw(self.ata(&self.players[e.owner].pubkey()))); } self.ix(10, accts, vec![]) }
    pub fn settle(&mut self, s: &Season) -> Res { let ix = self.settle_ix(s, s.pool, &s.entries); self.send(&[ix], &[]) }
    /// Settle that also publishes the first `n` entries inline (strat + registry pairs appended)
    pub fn settle_ix_publishing(&self, s: &Season, n: usize) -> Instruction { let mut ix = self.settle_ix(s, s.pool, &s.entries); for e in s.entries.iter().take(n) { ix.accounts.push(self.rw(self.strat_pda(e.id))); ix.accounts.push(self.rw(self.reg_pda(e.id))); } ix }
    pub fn settle_publishing(&mut self, s: &Season, n: usize) -> Res { let ix = self.settle_ix_publishing(s, n); self.send(&[ix], &[]) }
    pub fn cancel_ix(&self, s: &Season, signer: Address, pool_sid_pool: Address, entries: &[Strat]) -> Instruction { let mut accts = vec![self.m(signer, true, signer == self.payer.pubkey()), self.rw(s.arena), self.ro(pool_sid_pool), self.rw(self.ata(&pool_sid_pool)), self.ro(a(TOKEN)), self.rw(s.receipt)]; for e in entries { accts.push(self.rw(self.ata(&self.players[e.owner].pubkey()))); } self.ix(17, accts, vec![]) }
    /// Cancel signed by the payer (who is the creator in these tests)
    pub fn cancel(&mut self, s: &Season) -> Res { let ix = self.cancel_ix(s, self.payer.pubkey(), s.pool, &s.entries); self.send(&[ix], &[]) }
    pub fn cancel_by(&mut self, s: &Season, who: usize) -> Res { let kp = self.player(who); let ix = self.cancel_ix(s, kp.pubkey(), s.pool, &s.entries); self.send(&[ix], &[&kp]) }
    pub fn release_bond_ix(&self, s: &Season, creator: Address) -> Instruction { self.ix(18, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.receipt), self.rw(creator)], vec![]) }
    pub fn release_bond(&mut self, s: &Season) -> Res { let ix = self.release_bond_ix(s, self.payer.pubkey()); self.send(&[ix], &[]) }
    pub fn lamports(&self, k: &Address) -> u64 { self.svm.get_account(k).map(|x| x.lamports).unwrap_or(0) }
    pub fn publish_ix(&self, s: &Season, i: usize, id: u64) -> Instruction { self.ix(11, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena), self.rw(self.strat_pda(id)), self.rw(self.reg_pda(id)), self.rw(s.receipt)], vec![i as u8]) }
    pub fn publish(&mut self, s: &Season, i: usize) -> Res { let ix = self.publish_ix(s, i, s.entries[i].id); self.send(&[ix], &[]) }
    pub fn commit(&mut self, accts: &[Address]) -> Res { let mut m = vec![self.m(self.payer.pubkey(), true, true), self.ro(a(MAGIC)), self.rw(a(MAGIC_CTX))]; for k in accts { m.push(self.rw(*k)); } let ix = self.ix(12, m, vec![]); self.send(&[ix], &[]) }
    pub fn commit_undelegate_ix_for(&self, s: &Season) -> Instruction { self.ix(12, vec![self.m(self.payer.pubkey(), true, true), self.ro(a(MAGIC)), self.rw(a(MAGIC_CTX)), self.rw(s.receipt)], vec![1]) }
    pub fn commit_undelegate(&mut self, accts: &[Address]) -> Res { let mut m = vec![self.m(self.payer.pubkey(), true, true), self.ro(a(MAGIC)), self.rw(a(MAGIC_CTX))]; for k in accts { m.push(self.rw(*k)); } let ix = self.ix(12, m, vec![1]); self.send(&[ix], &[]) }
    pub fn cleanup_ix(&self, s: &Season) -> Instruction { self.ix(15, vec![self.m(self.payer.pubkey(), true, true), self.rw(self.hub), self.rw(s.arena), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.rw(s.receipt)], vec![]) }
    pub fn cleanup(&mut self, s: &Season) -> Res { let ix = self.cleanup_ix(s); self.send(&[ix], &[]) }
    pub fn start_finals(&mut self, parent: &Season, fsid: u64, k: u8, neps: u32) -> (Res, Season) { let mut f = self.season(fsid); if self.svm.get_account(&f.receipt).is_none() { let r = self.init_receipt(&f); assert!(r.is_ok(), "InitReceipt finals {}", err_string(&r)); } f.neps = neps; let kk = (k as usize).min(parent.entries.len()).max(1); f.maxs = kk; self.provision_if_new(f.arena, arena_size(kk));
        let mut d = fsid.to_le_bytes().to_vec(); d.push(k); d.extend(neps.to_le_bytes()); d.extend(1u32.to_le_bytes());
        let ix = self.ix(14, vec![self.m(self.payer.pubkey(), true, true), self.rw(parent.arena), self.rw(self.hub), self.rw(f.arena), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.rw(f.receipt)], d); (self.send(&[ix], &[]), f) }
    /// register + seal one strategy per name for owners round-robin, then create, enter and lock a full season; returns it seeded and fully run if `run`
    pub fn full_season(&mut self, sid: u64, names: &[&str], neps: u32, fee: u64, finals: bool, division: u8, seed_byte: u8, run: bool) -> Season {
        let mut s = self.season(sid); let r = self.init_pool(&s); assert!(r.is_ok(), "InitPool {}", err_string(&r)); let r = self.init_receipt(&s); assert!(r.is_ok(), "InitReceipt {}", err_string(&r));
        let r = self.create_season(&mut s, neps, fee, 20, finals, division); assert!(r.is_ok(), "CreateSeason {}", err_string(&r));
        for (i, n) in names.iter().enumerate() { let st = self.register_and_seal(i % self.players.len(), n, code_of(n)); let r = self.enter(&mut s, &st); assert!(r.is_ok(), "Enter {}: {}", n, err_string(&r)); }
        let r = self.lock(&s); assert!(r.is_ok(), "Lock {}", err_string(&r)); let r = self.request_seed(&s); assert!(r.is_ok(), "RequestSeed {}", err_string(&r));
        let mut seed = [0u8; 32]; for (i, b) in seed.iter_mut().enumerate() { *b = seed_byte.wrapping_add((i as u8).wrapping_mul(37)) ^ 0x5a; } let r = self.deliver_seed(&mut s, seed); assert!(r.is_ok(), "seed callback {}", err_string(&r));
        if run { self.drive(&s, 1400, 1_400_000); } s }
    pub fn finish(&mut self, s: &Season) { let r = self.settle(s); assert!(r.is_ok(), "Settle {}", err_string(&r)); for i in 0..s.entries.len() { let r = self.publish(s, i); assert!(r.is_ok(), "Publish {} {}", i, err_string(&r)); } }
    // ---- readers ----
    pub fn slot_field(&self, s: &Season, i: usize, off: usize) -> u64 { rd64(&self.data(&s.arena), HDR + i * SLOT + off) }
    pub fn total(&self, s: &Season, i: usize) -> i64 { self.slot_field(s, i, ar::SL_TOTAL) as i64 }
    pub fn rank(&self, s: &Season, i: usize) -> u32 { rd32(&self.data(&s.arena), HDR + i * SLOT + ar::SL_RANK) }
    pub fn wins(&self, s: &Season, i: usize) -> u16 { let d = self.data(&s.arena); u16::from_le_bytes([d[HDR + i * SLOT + ar::SL_WINS], d[HDR + i * SLOT + ar::SL_WINS + 1]]) }
}
/// host replay of a whole season with the conclave-vm crate, from the same seed words the program derives
pub fn replay(s: &Season, sts: &[Strat]) -> (Vec<i64>, Vec<u32>) { let (sa, sb) = conclave_vm::world::season_words(&s.seed); let progs: Vec<&[u8]> = sts.iter().map(|x| x.code.as_slice()).collect(); conclave_lab::run::run_season_wins(&progs, sa, sb, u64::from(s.neps)) }
pub fn shares(ns: usize) -> Vec<u128> { match ns { 1 => vec![100], 2 => vec![60, 40], _ => vec![50, 30, 20] } }
