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
pub const VRF_QUEUE: &str = "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc";
pub const SLOT_HASHES: &str = "SysvarS1otHashes111111111111111111111111111";
pub fn a(s: &str) -> Address { Address::from_str(s).unwrap() }
pub fn pda(seeds: &[&[u8]], pid: &Address) -> Address { Address::find_program_address(seeds, pid).0 }
pub fn u64le(v: u64) -> [u8; 8] { v.to_le_bytes() }

// ---- layouts (mirror of program/src/lib.rs; the tests assert against these, they are not imported so a layout change must be made here on purpose) ----
pub const HDR: usize = 1280; pub const SLOT: usize = 440; pub const STRAT_MIN_SIZE: usize = 136 + 260; pub const STRAT_SIZE: usize = STRAT_MIN_SIZE + 8; pub const S_LFINALS: usize = 396; pub const REG_SIZE: usize = 128; pub const RC_ENT: usize = 224; pub const RC_MONEY_SIZE: usize = 192 + 20 * 80; pub const RC_OWNERS: usize = RC_ENT + 20 * 80; pub const RC_SIZE: usize = RC_OWNERS + 20 * 32; /** receipts of the previous build: no format byte, no owners */ pub const RC_V2_SIZE: usize = RC_ENT + 20 * 80;
pub const RC_FORMAT: usize = 146; pub const RECEIPT_FORMAT: u8 = 3; pub const M_ROSTER: u32 = 0x5453_4F52; pub const M_REG_DEAD: u32 = 0x4447_4552; pub const MARKER_SIZE: usize = 8; pub const RO_HDR: usize = 16;
pub fn roster_size(cap: usize) -> usize { RO_HDR + cap * 32 }
pub fn arena_size(maxs: usize) -> usize { HDR + maxs * SLOT }
pub mod ar { pub const FLAGS: usize = 4; pub const NS: usize = 5; pub const SEASON: usize = 40; pub const SEED: usize = 48; pub const NEPS: usize = 80; pub const CUREP: usize = 88; pub const CURTICK: usize = 92; pub const START: usize = 96; pub const POOL: usize = 112; pub const TICKS: usize = 152; pub const FSEED: usize = 1112; pub const F2: usize = 1144; pub const PUBN: usize = 1145; pub const SDONEAT: usize = 1272; pub const PINS: usize = 1152; pub const DIV: usize = 1200;
    pub const SL_OWNER: usize = 0; pub const SL_ID: usize = 32; pub const SL_SRANK: usize = 42; pub const SL_BITS: usize = 43; pub const SL_RANK: usize = 44; pub const SL_TOTAL: usize = 48; pub const SL_FTOTAL: usize = 56; pub const SL_SEAT: usize = 64; }
pub mod arx { pub const CREATED: usize = 1208; pub const WINDOW: usize = 1216; pub const SEEDTO: usize = 1224; pub const LOCKAT: usize = 1232; pub const SETTLEDAT: usize = 1240; pub const PUBGRACE: usize = 1248; pub const RENT: usize = 1256; pub const MINS: usize = 1264; pub const REASON: usize = 1265; pub const FEE: usize = 104; pub const AUTH: usize = 8; }
pub mod rc { pub const KIND: usize = 4; pub const NS: usize = 5; pub const PUB: usize = 6; pub const SEASON: usize = 8; pub const CREATOR: usize = 104; pub const BOND: usize = 136; pub const STATE: usize = 144; pub const REASON: usize = 145; pub const REFUNDED: usize = 152; pub const FSEEDA: usize = 192; pub const FSEEDB: usize = 200; pub const FPACKS: usize = 208; pub const FSTATUS: usize = 210; pub const FQUAL: usize = 211; pub const FNEPS: usize = 212; pub const OWED: usize = 216; pub const E_FRANK: usize = 72; pub const E_SRANK: usize = 76; pub const E_PUBLISHED: usize = 78; pub const E_FINALIST: usize = 79; pub const RENT: usize = 160; pub const RECLAIMED: usize = 168; pub const FORFEIT: usize = 176; pub const RELEASE: usize = 184; }
pub const F2_HASFIN: u8 = 2; pub const F2_CANCELLED: u8 = 8; pub const F2_REFUNDED: u8 = 16; pub const F2_THINFIELD: u8 = 32; pub const B_FINALIST: u8 = 1; pub const B_PUBLISHED: u8 = 2; pub const B_COUNTED: u8 = 4; pub const S_OPEN: usize = 6; pub const M_REG: u32 = 0x5245_4753; pub const M_REG_CLOSED: u32 = 0x5845_4752;
pub const FS_NONE: u8 = 0; pub const FS_PLAYED: u8 = 1; pub const FS_VOIDED: u8 = 2;
// ---- program constants (mirrored on purpose) ----
pub const MAX_EPISODES: u32 = 100; pub const MAX_SPT: u32 = 100; pub const MAX_RUN_SLOTS: u64 = 720_000; pub const MAX_SEEDTO: u64 = 1_000_000; pub const MAX_ENTRY_WINDOW: u64 = 25_000_000; pub const MAX_GRACE: u64 = 200_000_000; pub const MIN_GRACE: u64 = 180_000; pub const FINALS_EPISODES: u32 = 15; pub const FINALS_SEEDTO: u64 = 360_000; pub const SLACK_BASE: u64 = 360_000; pub const SLACK_PER_TICK: u64 = 40;
pub fn phase_deadline(start: u64, episodes: u32, spt: u32) -> u64 { let t = u64::from(episodes) * 150; start + t * u64::from(spt) + SLACK_BASE + t * SLACK_PER_TICK }
// ---- claims account ----
pub mod cl { pub const STATE: usize = 4; pub const N: usize = 5; pub const CAP: usize = 6; pub const KIND: usize = 7; pub const SEASON: usize = 8; pub const MINT: usize = 16; pub const OWED: usize = 48; pub const CLAIMED: usize = 56; pub const HDR: usize = 72; pub const E_OWNER: usize = 0; pub const E_OWED: usize = 32; pub const E_DONE: usize = 40; pub const ESZ: usize = 48; }
pub fn claims_size(cap: usize) -> usize { cl::HDR + cap * cl::ESZ }
pub const BOND: u64 = 2_000_000;
pub const F_LOCKED: u8 = 1; pub const F_REQ: u8 = 2; pub const F_SEEDED: u8 = 4; pub const F_DONE: u8 = 8; pub const F_SETTLED: u8 = 16; pub const F_SDONE: u8 = 32; pub const F_FREQ: u8 = 64; pub const F_FSEEDED: u8 = 128;
pub fn rd64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
pub fn rdi64(d: &[u8], o: usize) -> i64 { rd64(d, o) as i64 }
pub fn rd32(d: &[u8], o: usize) -> u32 { u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] { let mut h = Sha256::new(); for p in parts { h.update(p); } h.finalize().into() }
pub fn code_commit(salt: &[u8; 32], code: &[u8]) -> [u8; 32] { sha256(&[b"CNCL-CODE-v1", salt, code]) }
/// the salt a season's score commitments are keyed by: derived from the sealed salt, so revealing it opens that season's totals and nothing else
pub fn score_salt(salt: &[u8; 32], season: u64) -> [u8; 32] { sha256(&[b"CNCL-SSALT-v1", salt, &season.to_le_bytes()]) }
/// what a verifier who is given ONLY the score salt recomputes
pub fn score_commit_with(ssalt: &[u8; 32], season: u64, id: u64, total: i64, ftotal: i64, neps: u32, fneps: u32) -> [u8; 32] { sha256(&[b"CNCL-SCORE-v3", ssalt, &season.to_le_bytes(), &id.to_le_bytes(), &total.to_le_bytes(), &ftotal.to_le_bytes(), &neps.to_le_bytes(), &fneps.to_le_bytes()]) }
pub fn score_commit(salt: &[u8; 32], season: u64, id: u64, total: i64, ftotal: i64, neps: u32, fneps: u32) -> [u8; 32] { score_commit_with(&score_salt(salt, season), season, id, total, ftotal, neps, fneps) }

pub type Res = Result<TransactionMetadata, FailedTransactionMetadata>;
/// the custom error code of a failed transaction, if it failed with one
pub fn custom(r: &Res) -> Option<u32> { match r { Err(e) => match &e.err { solana_transaction_error::TransactionError::InstructionError(_, solana_instruction::error::InstructionError::Custom(c)) => Some(*c), _ => None }, _ => None } }
pub fn failed_to_complete(r: &Res) -> bool { matches!(r, Err(e) if matches!(&e.err, solana_transaction_error::TransactionError::InstructionError(_, solana_instruction::error::InstructionError::ProgramFailedToComplete))) }
pub fn err_string(r: &Res) -> String { match r { Ok(_) => "ok".into(), Err(e) => format!("{:?}", e.err) } }

#[derive(Clone, Copy)] pub struct Params { pub window: u64, pub seedto: u64, pub grace: u64, pub mins: u8, pub bond: u64 }
pub const LOADER: &str = "BPFLoaderUpgradeab1e11111111111111111111111";
pub struct Env { pub config: Address, pub params: Params, pub svm: LiteSVM, pub pid: Address, pub payer: Keypair, pub players: Vec<Keypair>, pub mint: Address, pub hub: Address, pub slot: u64, pub nonce: u64, pub strategies: Vec<Strat>,
    /// None: ephemeral rent is not modelled (the stand-ins move no lamports). Some: what the rollup vault holds for each live ephemeral account, keyed by (is permission, account)
    pub rent_held: Option<std::collections::HashMap<(bool, Address), u64>> }
/// Ephemeral rent, as MagicBlock states it and as devnet showed it: (data length + 60) x 32 lamports, paid by the sponsor and returned to whatever account is named as sponsor on close.
/// A permission account is 68 bytes plus 33 per member. Calibrated against devnet: sealed strategy 20,000 (404 bytes + 1 member) and 19,744 (396); 20-seat arena with its permission 328,576; its claims account 34,944.
pub fn eph_rent(len: usize) -> u64 { (len as u64 + 60) * 32 }
pub const STRAT_RENT: u64 = (404 + 60) * 32 + (68 + 33 + 60) * 32;
#[derive(Clone)] pub struct Strat { pub id: u64, pub owner: usize, pub salt: [u8; 32], pub code: Vec<u8>, pub name: String }

fn conclave_so() -> Vec<u8> { std::fs::read(std::env::var("CONCLAVE_SO").unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../../program/target/deploy/conclave.so").to_string())).expect("build the program first: (cd program && cargo build-sbf)") }
fn standin_so() -> Vec<u8> { std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/standins/target/deploy/conclave_svm_standins.so")).expect("build the stand-ins first: (cd tests/svm/standins && cargo build-sbf)") }

impl Env {
    pub fn new(nplayers: usize) -> Env { Env::new_with(nplayers, true) }
    /// configure=false leaves the config account uncreated so InitConfig itself can be tested
    pub fn new_with(nplayers: usize, configure: bool) -> Env {
        let mut svm = LiteSVM::new().with_sigverify(true).with_blockhash_check(false);
        let mut rent = solana_rent::Rent::default(); rent.lamports_per_byte = 0; svm.set_sysvar(&rent); // rent-exempt minimum 0: ER ephemeral accounts hold no lamports
        let pid = Address::new_unique(); svm.add_program(pid, &conclave_so()).unwrap();
        let so = standin_so(); for id in [MAGIC, PERMISSION, VRF, ESPL, DLP] { svm.add_program(a(id), &so).unwrap(); }
        let payer = Keypair::new(); svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
        let players: Vec<Keypair> = (0..nplayers).map(|_| Keypair::new()).collect(); for p in &players { svm.airdrop(&p.pubkey(), 10_000_000_000).unwrap(); }
        let hub = pda(&[b"hub"], &pid); svm.warp_to_slot(10);
        let mut e = Env { config: pda(&[b"config"], &pid), params: Params { window: 1_000_000, seedto: 1_000_000, grace: 1_000_000, mins: 1, bond: BOND }, svm, pid, payer, players, mint: Address::new_unique(), hub, slot: 10, nonce: 0, strategies: vec![], rent_held: None };
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
    /// send; `extra` are keypairs that must sign besides the payer. Signatures are VERIFIED. The one exception is `send_oracle`
    pub fn send_with(&mut self, ixs: &[Instruction], extra: &[&Keypair], cu: Option<u32>) -> Res {
        self.nonce += 1; self.svm.expire_blockhash(); /* every send is a distinct transaction, so a repeated operation is judged by the program, never refused as a duplicate */ let mut all: Vec<Instruction> = vec![];
        if let Some(c) = cu { let mut d = vec![2u8]; d.extend(c.to_le_bytes()); all.push(Instruction { program_id: a("ComputeBudget111111111111111111111111111111"), accounts: vec![], data: d }); }
        // distinct no-op memo-free marker so identical consecutive transactions are not rejected as duplicates
        all.push(Instruction { program_id: a(SYSTEM), accounts: vec![AccountMeta::new(self.payer.pubkey(), true), AccountMeta::new(self.payer.pubkey(), false)], data: { let mut d = vec![2, 0, 0, 0]; d.extend(0u64.to_le_bytes()); d } });
        all.extend_from_slice(ixs);
        let msg = Message::new(&all, Some(&self.payer.pubkey())); let mut tx = Transaction::new_unsigned(msg); let bh = self.svm.latest_blockhash();
        let need: Vec<Address> = tx.message.account_keys[..usize::from(tx.message.header.num_required_signatures)].to_vec(); let mut signers: Vec<&Keypair> = vec![&self.payer]; signers.extend(extra.iter().copied().filter(|k| need.contains(&k.pubkey()))); tx.partial_sign(&signers, bh);
        let keys = tx.message.account_keys.clone(); let r = self.svm.send_transaction(tx); if let Ok(meta) = &r { self.apply_rent(&keys, meta); } r
    }
    /// LIMIT: a stand-in cannot debit an account it does not own, so the lamports move right AFTER the transaction. Balances between transactions are exact, but inside an instruction the program sees no change,
    /// so its own rent measurement on the receipt (drawn, reclaimed) reads zero here. That reconciliation is covered by money.rs, and was observed on devnet.
    /// turn ephemeral rent on for the rest of this test (call before anything creates an ephemeral account) and give the hub room to pay it
    pub fn model_rent(&mut self) { self.rent_held = Some(Default::default()); let mut h = self.svm.get_account(&self.hub).unwrap(); h.lamports += 100_000_000; self.svm.set_account(self.hub, h).unwrap(); }
    /// lamports the rollup vault holds in total
    pub fn vault_total(&self) -> u64 { self.rent_held.as_ref().unwrap().values().sum() }
    fn shift_lamports(&mut self, k: &Address, by: i128) { let mut acc = self.svm.get_account(k).unwrap_or_else(|| panic!("rent: no account {}", k)); acc.lamports = u64::try_from(i128::from(acc.lamports) + by).unwrap_or_else(|_| panic!("rent: {} cannot pay {}", k, -by)); self.svm.set_account(*k, acc).unwrap(); }
    /// Applies what the rollup would do with lamports for each CPI a SUCCESSFUL transaction really made: the program, not the test, chooses the sponsor that pays and the account that is refunded.
    fn apply_rent(&mut self, keys: &[Address], meta: &TransactionMetadata) { if self.rent_held.is_none() { return; } let (magic, pp) = (a(MAGIC), a(PERMISSION)); let mut gone = vec![];
        for inner in meta.inner_instructions.iter().flatten() { let ix = &inner.instruction; let prog = keys[usize::from(ix.program_id_index)]; let acct = |i: usize| keys[usize::from(ix.accounts[i])]; let d = &ix.data;
            if prog == magic && d.len() >= 4 && d[..4] == 12u32.to_le_bytes() { let (sponsor, eph) = (acct(0), acct(1)); let amt = eph_rent(u32::from_le_bytes(d[4..8].try_into().unwrap()) as usize); self.shift_lamports(&sponsor, -i128::from(amt)); assert!(self.rent_held.as_mut().unwrap().insert((false, eph), amt).is_none(), "ephemeral account created twice"); }
            else if prog == magic && d.len() >= 4 && d[..4] == 14u32.to_le_bytes() { let (sponsor, eph) = (acct(0), acct(1)); let amt = self.rent_held.as_mut().unwrap().remove(&(false, eph)).expect("closing an ephemeral account that holds no rent"); self.shift_lamports(&sponsor, i128::from(amt)); gone.push(eph); }
            else if prog == pp && d.len() >= 8 && d[..8] == 6u64.to_le_bytes() { let (payer, of) = (acct(0), acct(1)); let members = (d.len() - 9) / 33; let amt = eph_rent(68 + 33 * members); self.shift_lamports(&payer, -i128::from(amt)); assert!(self.rent_held.as_mut().unwrap().insert((true, of), amt).is_none(), "permission created twice"); }
            else if prog == pp && d.len() >= 8 && d[..8] == 8u64.to_le_bytes() { let (payer, of) = (acct(0), acct(2)); let amt = self.rent_held.as_mut().unwrap().remove(&(true, of)).expect("closing a permission that holds no rent"); self.shift_lamports(&payer, i128::from(amt)); } }
        // a closed ephemeral account no longer exists in the rollup
        for k in gone { self.svm.set_account(k, Account::default()).unwrap(); } }
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
    pub fn claims_pda(&self, sid: u64) -> Address { pda(&[b"claims", &sid.to_le_bytes()], &self.pid) }
    pub fn roster_pda(&self, sid: u64) -> Address { pda(&[b"roster", &sid.to_le_bytes()], &self.pid) }
    /// stand in for the Magic program's two money-side accounts of a season: the claims account and the roster
    pub fn provision_side(&mut self, s: &Season, maxs: usize) { self.provision_if_new(s.claims, claims_size(maxs)); self.provision_if_new(s.roster, roster_size(maxs)); }
    pub fn receipt_owner(&self, s: &Season, i: usize) -> Vec<u8> { self.data(&s.receipt)[RC_OWNERS + i * 32..RC_OWNERS + i * 32 + 32].to_vec() }
    pub fn receipt_commit(&self, s: &Season, i: usize) -> Vec<u8> { self.data(&s.receipt)[RC_ENT + i * 80 + 8..RC_ENT + i * 80 + 40].to_vec() }
    pub fn seal_ix(&self, s: &Strat, signer: usize) -> Instruction { let mut d = s.id.to_le_bytes().to_vec(); d.extend_from_slice(&s.salt); d.extend_from_slice(&s.code); let ow = self.players[signer].pubkey();
        self.ix(3, vec![self.m(ow, true, false), self.rw(self.hub), self.rw(self.strat_pda(s.id)), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.ro(self.reg_pda(s.id))], d) }
    pub fn player(&self, i: usize) -> Keypair { Keypair::try_from(&self.players[i].to_bytes()[..]).unwrap() }
    pub fn seal(&mut self, s: &Strat) -> Res { self.provision_if_new(self.strat_pda(s.id), STRAT_SIZE); let ix = self.seal_ix(s, s.owner); let kp = self.player(s.owner); self.send(&[ix], &[&kp]) }
    pub fn provision_if_new(&mut self, k: Address, size: usize) { if self.svm.get_account(&k).is_none() { self.provision(k, size); } }
    pub fn register_and_seal(&mut self, owner: usize, name: &str, code: Vec<u8>) -> Strat { let s = self.register(owner, name, code); let r = self.seal(&s); assert!(r.is_ok(), "Seal {}: {}", name, err_string(&r)); s }
}

// ================= season lifecycle helpers =================
pub const CB_DISC: [u8; 8] = [200, 1, 2, 3, 4, 5, 6, 7];
pub const CB_DISC_FINALS: [u8; 8] = [200, 1, 2, 3, 4, 5, 6, 8];
pub fn seed_of(b: u8) -> [u8; 32] { let mut seed = [0u8; 32]; for (i, x) in seed.iter_mut().enumerate() { *x = b.wrapping_add((i as u8).wrapping_mul(37)) ^ 0x5a; } seed }
#[derive(Clone)] pub struct Season { pub sid: u64, pub arena: Address, pub receipt: Address, pub pool: Address, pub claims: Address, pub roster: Address, pub maxs: usize, pub entries: Vec<Strat>, pub seed: [u8; 32], pub fseed: [u8; 32], pub neps: u32, pub fee: u64 }
impl Env {
    pub fn season(&self, sid: u64) -> Season { Season { sid, arena: self.arena_pda(sid), receipt: self.receipt_pda(sid), pool: self.pool_pda(sid), claims: self.claims_pda(sid), roster: self.roster_pda(sid), maxs: 20, entries: vec![], seed: [0; 32], fseed: [0; 32], neps: 0, fee: 0 } }
    pub fn init_receipt(&mut self, s: &Season) -> Res { let b = self.params.bond; self.init_receipt_bond(s, b) }
    pub fn init_receipt_bond(&mut self, s: &Season, bond: u64) -> Res { let mut d = s.sid.to_le_bytes().to_vec(); d.extend(bond.to_le_bytes()); let ix = self.ix(16, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.receipt), self.ro(a(SYSTEM))], d); self.send(&[ix], &[]) }
    pub fn init_pool(&mut self, s: &Season) -> Res {
        let eata = pda(&[s.pool.as_ref(), self.mint.as_ref()], &a(ESPL)); let accts = vec![self.m(self.payer.pubkey(), true, true), self.rw(eata), self.ro(s.pool), self.ro(self.mint), self.ro(a(SYSTEM)), self.ro(a(ESPL)), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(DLP)), self.ro(Address::new_unique()), self.rw(self.ata(&s.pool)), self.ro(a(ATOKEN)), self.ro(a(TOKEN))];
        let ix = self.ix(13, accts, s.sid.to_le_bytes().to_vec()); self.send(&[ix], &[]) }
    pub fn create_season_ix(&self, s: &Season, neps: u32, spt: u32, fee: u64, maxs: u8, flags: u8, division: u8) -> Instruction {
        let mut d = s.sid.to_le_bytes().to_vec(); d.extend(neps.to_le_bytes()); d.extend(spt.to_le_bytes()); d.extend(fee.to_le_bytes()); d.extend_from_slice(self.mint.as_ref()); d.extend([maxs, flags, division]); let p = self.params; d.extend(p.window.to_le_bytes()); d.extend(p.seedto.to_le_bytes()); d.extend(p.grace.to_le_bytes()); d.push(p.mins);
        self.ix(5, vec![self.m(self.payer.pubkey(), true, true), self.rw(self.hub), self.rw(s.arena), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.rw(s.receipt), self.ro(self.config), self.rw(s.claims), self.rw(s.roster), self.rw(Address::new_unique())], d) }
    pub fn create_season(&mut self, s: &mut Season, neps: u32, fee: u64, maxs: u8, finals: bool, division: u8) -> Res { self.provision_if_new(s.arena, arena_size(maxs as usize)); self.provision_side(s, maxs as usize); if self.svm.get_account(&s.receipt).is_none() { let r = self.init_receipt(s); assert!(r.is_ok(), "InitReceipt {}", err_string(&r)); } s.maxs = maxs as usize; s.neps = neps; s.fee = fee;
        let ix = self.create_season_ix(s, neps, 1, fee, maxs, if finals { 2 } else { 0 }, division); self.send(&[ix], &[]) }
    pub fn enter_ix(&self, s: &Season, st: &Strat, signer: usize) -> Instruction { let ow = self.players[signer].pubkey(); let owner_of_strat = self.players[st.owner].pubkey();
        let _ = owner_of_strat; self.ix(6, vec![self.m(ow, true, false), self.rw(self.strat_pda(st.id)), self.rw(s.arena), self.rw(self.ata(&ow)), self.rw(self.ata(&s.pool)), self.ro(a(TOKEN)), self.ro(self.config), self.rw(self.reg_pda(st.id)), self.rw(s.roster)], vec![]) }
    pub fn enter(&mut self, s: &mut Season, st: &Strat) -> Res { let ix = self.enter_ix(s, st, st.owner); let kp = self.player(st.owner); let r = self.send(&[ix], &[&kp]); if r.is_ok() { s.entries.push(st.clone()); } r }
    pub fn lock(&mut self, s: &Season) -> Res { let ix = self.ix(7, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena)], vec![]); self.send(&[ix], &[]) }
    /// lock signed by someone other than the creator
    pub fn lock_by(&mut self, s: &Season, who: usize) -> Res { let kp = self.player(who); let ix = self.ix(7, vec![self.m(kp.pubkey(), true, false), self.rw(s.arena)], vec![]); self.send(&[ix], &[&kp]) }
    pub fn request_seed(&mut self, s: &Season) -> Res { let identity = pda(&[b"identity"], &self.pid); let ix = self.ix(8, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena), self.ro(identity), self.rw(a(VRF_QUEUE)), self.ro(a(SYSTEM)), self.ro(a(SLOT_HASHES)), self.ro(a(VRF))], vec![]); self.send(&[ix], &[]) }
    /// plays the VRF oracle: the real one calls back with the identity PDA of the VRF program as signer
    pub fn deliver_seed(&mut self, s: &mut Season, seed: [u8; 32]) -> Res { let identity = pda(&[b"identity", self.pid.as_ref()], &a(VRF)); let mut d = CB_DISC.to_vec(); d.extend_from_slice(&seed);
        let ix = Instruction { program_id: self.pid, accounts: vec![AccountMeta::new_readonly(identity, true), AccountMeta::new(s.arena, false)], data: d }; s.seed = seed; self.send_oracle(ix) }
    /// THE ONLY UNVERIFIED TRANSACTION: the VRF callback is signed by a program address, which no keypair can sign for (the oracle here is a stand-in). Verification is off for this one send.
    pub fn send_oracle(&mut self, ix: Instruction) -> Res { self.svm.set_sigverify(false); let r = self.send(&[ix], &[]); self.svm.set_sigverify(true); r }
    pub fn deliver_finals_seed(&mut self, s: &mut Season, seed: [u8; 32]) -> Res { let identity = pda(&[b"identity", self.pid.as_ref()], &a(VRF)); let mut d = CB_DISC_FINALS.to_vec(); d.extend_from_slice(&seed);
        let ix = Instruction { program_id: self.pid, accounts: vec![AccountMeta::new_readonly(identity, true), AccountMeta::new(s.arena, false)], data: d }; s.fseed = seed; self.send_oracle(ix) }
    /// the season phase has ended and the arena is waiting for (or running) the finals
    pub fn in_finals(&self, s: &Season) -> bool { let f = self.flags(s); f & F_SDONE != 0 && f & F_DONE == 0 }
    /// request and deliver the finals seed, then drive the finals to the end
    pub fn run_finals(&mut self, s: &mut Season, seed_byte: u8) { assert!(self.in_finals(s), "not in finals"); self.fresh_blockhash(); let r = self.request_seed(s); assert!(r.is_ok(), "finals RequestSeed {}", err_string(&r)); let r = self.deliver_finals_seed(s, seed_of(seed_byte ^ 0xa7)); assert!(r.is_ok(), "finals seed {}", err_string(&r)); self.drive(s, 1400, 1_400_000); }
    pub fn advance_ix(&self, s: &Season, max: u16, budget_k: u16) -> Instruction { let mut d = max.to_le_bytes().to_vec(); d.extend(budget_k.to_le_bytes()); self.ix(9, vec![self.rw(s.arena)], d) }
    pub fn advance(&mut self, s: &Season, budget_k: u16, cu: u32) -> Res { let ix = self.advance_ix(s, 65535, budget_k); self.send_with(&[ix], &[], Some(cu)) }
    pub fn flags(&self, s: &Season) -> u8 { self.data(&s.arena)[ar::FLAGS] }
    pub fn ticks(&self, s: &Season) -> u32 { rd32(&self.data(&s.arena), ar::TICKS) }
    /// drive the phase that is currently running to its end with real transactions; returns the number of Advance transactions. Warps exactly far enough for every tick to be due, never past a deadline.
    pub fn drive(&mut self, s: &Season, budget_k: u16, cu: u32) -> usize { let finals = self.flags(s) & F_SDONE != 0; let d = self.data(&s.arena); let neps = if finals { FINALS_EPISODES } else { rd32(&d, ar::NEPS) };
        let all_due = rd64(&d, ar::START) + u64::from(neps) * 150 * u64::from(rd32(&d, 84)) + 1; if all_due > self.slot { let by = all_due - self.slot; self.warp(by); }
        let mut n = 0; loop { let f = self.flags(s); if f & F_DONE != 0 || (!finals && f & F_SDONE != 0) { return n; } self.fresh_blockhash(); let r = self.advance(s, budget_k, cu); assert!(r.is_ok(), "Advance: {}", err_string(&r)); n += 1; assert!(n < 100_000, "driver does not terminate"); } }
    pub fn pool_accounts(&self, s: &Season) -> Vec<AccountMeta> { let mut v = vec![self.rw(s.pool).clone()]; v[0] = self.ro(s.pool); v }
    pub fn settle_ix(&self, s: &Season) -> Instruction { self.ix(10, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena), self.rw(s.receipt), self.rw(s.claims), self.ro(s.pool), self.ro(self.ata(&s.pool)), self.ro(s.roster)], vec![]) }
    pub fn settle(&mut self, s: &Season) -> Res { let ix = self.settle_ix(s); self.send(&[ix], &[]) }
    /// Settle that also publishes the first `n` entries inline (strat + registry pairs appended)
    pub fn settle_ix_publishing(&self, s: &Season, n: usize) -> Instruction { let mut ix = self.settle_ix(s); for e in s.entries.iter().take(n) { ix.accounts.push(self.rw(self.strat_pda(e.id))); ix.accounts.push(self.rw(self.reg_pda(e.id))); } ix }
    pub fn settle_publishing(&mut self, s: &Season, n: usize) -> Res { let ix = self.settle_ix_publishing(s, n); self.send(&[ix], &[]) }
    pub fn cancel_ix(&self, s: &Season, signer: Address) -> Instruction { self.ix(17, vec![self.m(signer, true, signer == self.payer.pubkey()), self.rw(s.arena), self.rw(s.claims), self.ro(s.pool), self.ro(self.ata(&s.pool)), self.rw(s.receipt), self.ro(s.roster)], vec![]) }
    /// Cancel signed by the payer (who is the creator in these tests)
    pub fn cancel(&mut self, s: &Season) -> Res { let ix = self.cancel_ix(s, self.payer.pubkey()); self.send(&[ix], &[]) }
    pub fn cancel_by(&mut self, s: &Season, who: usize) -> Res { let kp = self.player(who); let ix = self.cancel_ix(s, kp.pubkey()); self.send(&[ix], &[&kp]) }
    pub fn claim_ix_to(&self, s: &Season, i: u8, dest: Address) -> Instruction { self.ix(22, vec![self.rw(s.claims), self.ro(s.pool), self.rw(self.ata(&s.pool)), self.rw(dest), self.ro(a(TOKEN))], vec![i]) }
    pub fn claim_ix(&self, s: &Season, i: usize) -> Instruction { self.claim_ix_to(s, i as u8, self.ata(&self.players[s.entries[i].owner].pubkey())) }
    pub fn claim(&mut self, s: &Season, i: usize) -> Res { self.fresh_blockhash(); let ix = self.claim_ix(s, i); self.send(&[ix], &[]) }
    /// claim every entry, as the clients do; every claim must succeed (the no-op ones included)
    pub fn claim_all(&mut self, s: &Season) { for i in 0..s.entries.len() { let r = self.claim(s, i); assert!(r.is_ok(), "Claim {}: {}", i, err_string(&r)); } }
    pub fn close_claims_ix(&self, s: &Season, crank: Address) -> Instruction { self.ix(23, vec![self.m(crank, true, crank == self.payer.pubkey()), self.rw(self.hub), self.rw(s.claims), self.rw(Address::new_unique()), self.ro(a(MAGIC))], vec![]) }
    pub fn close_claims(&mut self, s: &Season) -> Res { self.fresh_blockhash(); let ix = self.close_claims_ix(s, self.payer.pubkey()); self.send(&[ix], &[]) }
    pub fn owed(&self, s: &Season, i: usize) -> u64 { rd64(&self.data(&s.claims), cl::HDR + i * cl::ESZ + cl::E_OWED) }
    pub fn claim_done(&self, s: &Season, i: usize) -> bool { self.data(&s.claims)[cl::HDR + i * cl::ESZ + cl::E_DONE] != 0 }
    /// (recorded?, owed total, claimed total)
    pub fn claim_totals(&self, s: &Season) -> (bool, u64, u64) { let d = self.data(&s.claims); (d[cl::STATE] == 1, rd64(&d, cl::OWED), rd64(&d, cl::CLAIMED)) }
    pub fn pool_balance(&self, s: &Season) -> u64 { rd64(&self.data(&self.ata(&s.pool)), 64) }
    /// the money invariant at any moment after recording: what the pool still holds (less any donation) is exactly what is still unclaimed, and entries in = claimed + unclaimed
    pub fn assert_books(&self, s: &Season, donated: u64) { let (rec, owed, claimed) = self.claim_totals(s); assert!(rec); let n = s.entries.len(); assert_eq!(owed, s.fee * n as u64, "owed = entries in"); assert_eq!((0..n).map(|i| self.owed(s, i)).sum::<u64>(), owed, "per-entry amounts sum to the pot"); let done: u64 = (0..n).filter(|&i| self.claim_done(s, i)).map(|i| self.owed(s, i)).sum(); assert_eq!(done, claimed, "claimed total = sum of paid entries"); if self.pool_exists(s) { assert_eq!(self.pool_balance(s), owed - claimed + donated, "pool = unclaimed"); } }
    pub fn pool_exists(&self, s: &Season) -> bool { self.data(&self.ata(&s.pool)).len() >= 72 }
    pub fn release_bond_ix(&self, s: &Season, creator: Address) -> Instruction { self.ix(18, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.receipt), self.rw(creator)], vec![]) }
    pub fn release_bond(&mut self, s: &Season) -> Res { let ix = self.release_bond_ix(s, self.payer.pubkey()); self.send(&[ix], &[]) }
    pub fn lamports(&self, k: &Address) -> u64 { self.svm.get_account(k).map(|x| x.lamports).unwrap_or(0) }
    pub fn publish_ix(&self, s: &Season, i: usize, id: u64) -> Instruction { self.ix(11, vec![self.m(self.payer.pubkey(), true, true), self.rw(s.arena), self.rw(self.strat_pda(id)), self.rw(self.reg_pda(id)), self.rw(s.receipt)], vec![i as u8]) }
    pub fn publish(&mut self, s: &Season, i: usize) -> Res { let ix = self.publish_ix(s, i, s.entries[i].id); self.send(&[ix], &[]) }
    pub fn commit(&mut self, accts: &[Address]) -> Res { let mut m = vec![self.m(self.payer.pubkey(), true, true), self.ro(a(MAGIC)), self.rw(a(MAGIC_CTX))]; for k in accts { m.push(self.rw(*k)); } let ix = self.ix(12, m, vec![]); self.send(&[ix], &[]) }
    pub fn commit_undelegate_ix_for(&self, s: &Season) -> Instruction { self.ix(12, vec![self.m(self.payer.pubkey(), true, true), self.ro(a(MAGIC)), self.rw(a(MAGIC_CTX)), self.rw(s.receipt)], vec![1]) }
    pub fn commit_undelegate(&mut self, accts: &[Address]) -> Res { let mut m = vec![self.m(self.payer.pubkey(), true, true), self.ro(a(MAGIC)), self.rw(a(MAGIC_CTX))]; for k in accts { m.push(self.rw(*k)); } let ix = self.ix(12, m, vec![1]); self.send(&[ix], &[]) }
    pub fn cleanup_ix(&self, s: &Season) -> Instruction { self.ix(15, vec![self.m(self.payer.pubkey(), true, true), self.rw(self.hub), self.rw(s.arena), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.rw(s.receipt), self.rw(s.roster), self.rw(Address::new_unique())], vec![]) }
    /// the strategies of the entries this arena still holds a count on (what the client has to name to Cleanup)
    pub fn held_ids(&self, s: &Season) -> Vec<u64> { let d = self.data(&s.arena); if d.len() < HDR { return vec![]; } (0..usize::from(d[ar::NS])).filter(|&i| d[HDR + i * SLOT + ar::SL_BITS] & B_COUNTED != 0).map(|i| rd64(&d, HDR + i * SLOT + ar::SL_ID)).collect() }
    pub fn with_strats(&self, mut ix: Instruction, ids: &[u64]) -> Instruction { for id in ids { ix.accounts.push(self.rw(self.strat_pda(*id))); } ix }
    /// Cleanup as the client sends it: naming every strategy still counted
    pub fn cleanup(&mut self, s: &Season) -> Res { let ix = self.with_strats(self.cleanup_ix(s), &self.held_ids(s)); self.send(&[ix], &[]) }
    /// the open-entry count on a strategy account
    pub fn open_count(&self, id: u64) -> u16 { let d = self.data(&self.strat_pda(id)); u16::from_le_bytes([d[S_OPEN], d[S_OPEN + 1]]) }
    pub fn counted(&self, s: &Season, i: usize) -> bool { self.data(&s.arena)[HDR + i * SLOT + ar::SL_BITS] & B_COUNTED != 0 }
    pub fn close_strategy_ix(&self, id: u64, signer: usize) -> Instruction { let strat = self.strat_pda(id); self.ix(24, vec![self.m(self.players[signer].pubkey(), true, false), self.rw(self.hub), self.rw(strat), self.rw(Address::new_unique()), self.rw(Address::new_unique()), self.ro(a(MAGIC)), self.ro(a(PERMISSION)), self.rw(self.reg_pda(id))], vec![]) }
    pub fn close_strategy(&mut self, st: &Strat) -> Res { self.fresh_blockhash(); let ix = self.close_strategy_ix(st.id, st.owner); let kp = self.player(st.owner); self.send(&[ix], &[&kp]) }
    pub fn close_registry_ix(&self, id: u64, owner: Address) -> Instruction { self.ix(25, vec![self.m(self.payer.pubkey(), true, true), self.rw(self.reg_pda(id)), self.rw(owner)], vec![]) }
    pub fn close_registry(&mut self, st: &Strat) -> Res { self.fresh_blockhash(); let ix = self.close_registry_ix(st.id, self.players[st.owner].pubkey()); self.send(&[ix], &[]) }
    /// register + seal one strategy per name for owners round-robin, then create, enter and lock a full season; returns it seeded and fully run if `run`
    pub fn full_season(&mut self, sid: u64, names: &[&str], neps: u32, fee: u64, finals: bool, division: u8, seed_byte: u8, run: bool) -> Season {
        let mut s = self.season(sid); let r = self.init_pool(&s); assert!(r.is_ok(), "InitPool {}", err_string(&r)); let r = self.init_receipt(&s); assert!(r.is_ok(), "InitReceipt {}", err_string(&r));
        let r = self.create_season(&mut s, neps, fee, 20, finals, division); assert!(r.is_ok(), "CreateSeason {}", err_string(&r));
        for (i, n) in names.iter().enumerate() { let st = self.register_and_seal(i % self.players.len(), n, code_of(n)); let r = self.enter(&mut s, &st); assert!(r.is_ok(), "Enter {}: {}", n, err_string(&r)); }
        let r = self.lock(&s); assert!(r.is_ok(), "Lock {}", err_string(&r)); let r = self.request_seed(&s); assert!(r.is_ok(), "RequestSeed {}", err_string(&r));
        let mut seed = [0u8; 32]; for (i, b) in seed.iter_mut().enumerate() { *b = seed_byte.wrapping_add((i as u8).wrapping_mul(37)) ^ 0x5a; } let r = self.deliver_seed(&mut s, seed); assert!(r.is_ok(), "seed callback {}", err_string(&r));
        if run { self.drive(&s, 1400, 1_400_000); if self.in_finals(&s) { self.run_finals(&mut s, seed_byte); } } s }
    pub fn finish(&mut self, s: &Season) { let r = self.settle(s); assert!(r.is_ok(), "Settle {}", err_string(&r)); self.claim_all(s); for i in 0..s.entries.len() { let r = self.publish(s, i); assert!(r.is_ok(), "Publish {} {}", i, err_string(&r)); } }
    // ---- readers ----
    pub fn slot_field(&self, s: &Season, i: usize, off: usize) -> u64 { rd64(&self.data(&s.arena), HDR + i * SLOT + off) }
    pub fn total(&self, s: &Season, i: usize) -> i64 { self.slot_field(s, i, ar::SL_TOTAL) as i64 }
    pub fn rank(&self, s: &Season, i: usize) -> u32 { rd32(&self.data(&s.arena), HDR + i * SLOT + ar::SL_RANK) }
    pub fn srank(&self, s: &Season, i: usize) -> u32 { u32::from(self.data(&s.arena)[HDR + i * SLOT + ar::SL_SRANK]) }
    pub fn ftotal(&self, s: &Season, i: usize) -> i64 { self.slot_field(s, i, ar::SL_FTOTAL) as i64 }
    pub fn finalist(&self, s: &Season, i: usize) -> bool { self.data(&s.arena)[HDR + i * SLOT + ar::SL_BITS] & B_FINALIST != 0 }
}
/// host replay of the season phase with the conclave-vm crate, from the same seed words the program derives
pub fn replay(s: &Season, sts: &[Strat]) -> (Vec<i64>, ()) { let (sa, sb) = conclave_vm::world::season_words(&s.seed); let progs: Vec<&[u8]> = sts.iter().map(|x| x.code.as_slice()).collect(); (conclave_lab::run::run_season(&progs, sa, sb, u64::from(s.neps)), ()) }
pub fn shares(ns: usize) -> Vec<u128> { match ns { 1 => vec![100], 2 => vec![60, 40], _ => vec![50, 30, 20] } }
/// 50/30/20 of `pot` by rank (1-based), remainder on the last paid rank
pub fn prize_by_rank(pot: u64, ns: usize) -> Vec<u64> { let sh = shares(ns); let np = sh.len().min(ns); let mut out = vec![0u64; ns]; let mut paid = 0u64; for k in 0..np { let amt = if k == np - 1 { pot - paid } else { (u128::from(pot) * sh[k] / 100) as u64 }; paid += amt; out[k] = amt; } out }
/// THE TEST ORACLE: everything a season must produce, computed from the VM replay alone (never from program state).
/// `played`: whether the finals counted. Season rank: total descending, ties to the earlier entry. Finals: the top three (both, with two) replayed on the finals seed; ordered by season + finals total, ties to the better season rank.
#[derive(Debug)] pub struct Expect { pub season: Vec<i64>, pub finals: Vec<i64>, pub finalist: Vec<bool>, pub srank: Vec<u32>, pub frank: Vec<u32>, pub owed: Vec<u64> }
pub fn expect(s: &Season, played: bool) -> Expect {
    let n = s.entries.len(); let season = replay(s, &s.entries).0; let mut ord: Vec<usize> = (0..n).collect(); ord.sort_by(|&x, &y| season[y].cmp(&season[x]).then(x.cmp(&y)));
    let mut srank = vec![0u32; n]; for (k, &i) in ord.iter().enumerate() { srank[i] = k as u32 + 1; }
    let (mut finals, mut finalist, mut frank) = (vec![0i64; n], vec![false; n], srank.clone());
    if played && n >= 2 { let q: Vec<usize> = (0..n).filter(|&i| srank[i] <= 3).collect(); let (fa, fb) = conclave_vm::world::season_words(&s.fseed); let progs: Vec<&[u8]> = q.iter().map(|&i| s.entries[i].code.as_slice()).collect(); let tot = conclave_lab::run::run_season(&progs, fa, fb, u64::from(FINALS_EPISODES));
        for (k, &i) in q.iter().enumerate() { finals[i] = tot[k]; finalist[i] = true; }
        let mut by = q.clone(); by.sort_by(|&x, &y| (season[y] + finals[y]).cmp(&(season[x] + finals[x])).then(srank[x].cmp(&srank[y]))); for (k, &i) in by.iter().enumerate() { frank[i] = k as u32 + 1; } }
    let prizes = prize_by_rank(s.fee * n as u64, n); let owed = (0..n).map(|i| prizes[frank[i] as usize - 1]).collect();
    Expect { season, finals, finalist, srank, frank, owed } }
