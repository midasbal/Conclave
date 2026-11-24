//! Conclave: sealed-strategy league (ruleset v2).
//! Register (base, public, salted commitment) -> Seal (TEE, private from its first instant) -> season arena (ER-only ephemeral, never committed)
//! -> Enter + Lock -> VRF seed -> permissionless, clock-gated, self-metering Advance (conclave-vm + generator, in the enclave)
//! -> Settle (rank by total vol-targeted PnL, pay the eSPL pool, write the season receipt) -> Publish (coarse rank to the owner, score commitments to the receipt) -> Commit.
use conclave_vm::{pins_bytes, validate, work_of, world, Market, Seat, VmError, DIVISIONS, MAX_OPS, PINS_LEN};
use ephemeral_rollups_sdk::access_control::{instructions::CreateEphemeralPermissionCpi, structs::{EphemeralMembersArgs, Member, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG}};
use ephemeral_rollups_sdk::compat::{Compat, Modern};
use ephemeral_rollups_sdk::cpi::{delegate_account, undelegate_account, DelegateAccounts, DelegateConfig};
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::ephemeral_accounts::EphemeralAccount;
use ephemeral_rollups_sdk::vrf::{consts::VRF_PROGRAM_ID, instructions::{create_request_randomness_ix_const, RequestRandomnessParams}};
use solana_program::{account_info::{next_account_info, AccountInfo}, clock::Clock, entrypoint, entrypoint::ProgramResult, hash::hashv, instruction::{AccountMeta, Instruction}, program::{invoke, invoke_signed}, program_error::ProgramError, pubkey::Pubkey, sysvar::{rent::Rent, Sysvar}};
use solana_system_interface::instruction as system_instruction;

entrypoint!(process);
const CB_DISC: [u8; 8] = [200, 1, 2, 3, 4, 5, 6, 7];
const UNDELEGATE_DISC: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];
const ESPL: Pubkey = solana_program::pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
const TOKEN: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOKEN: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// domain separation for the two hash commitments
const DOM_CODE: &[u8] = b"CNCL-CODE-v1";
const DOM_SCORE: &[u8] = b"CNCL-SCORE-v1";

// ---- layouts ----
pub const M_ARENA: u32 = 0x4152_4E41; pub const M_STRAT: u32 = 0x5354_5254; pub const M_REG: u32 = 0x5245_4753; pub const M_HUB: u32 = 0x4855_4221; pub const M_RCPT: u32 = 0x5443_5052;
pub const CODE_MAX: usize = 4 + 4 * MAX_OPS;
// strategy (ephemeral, sealed, PDA ["strat", id]): 0 magic | 4 len u16 | 8 owner | 40 id | 48 commitment | 80 last_season+1 | 88 last_rank u32 | 92 last_n u32 | 96 last_pnl i64 | 104 salt[32] | 136 code
pub const S_OWNER: usize = 8; pub const S_ID: usize = 40; pub const S_COMMIT: usize = 48; pub const S_LSEASON: usize = 80; pub const S_LRANK: usize = 88; pub const S_LN: usize = 92; pub const S_LPNL: usize = 96; pub const S_SALT: usize = 104; pub const S_CODE: usize = 136;
pub const STRAT_SIZE: usize = S_CODE + CODE_MAX;
// registry (public, PDA ["reg", id]): 0 magic | 8 owner | 40 id | 48 commitment = sha256(DOM_CODE, salt, code) | 80 seasons u32 | 84 best_rank u32 | 88 total_pnl i64 | 96 last_season u64 | 104 last_rank u32 | 108 entries u32
pub const R_OWNER: usize = 8; pub const R_ID: usize = 40; pub const R_COMMIT: usize = 48; pub const R_SEASONS: usize = 80; pub const R_BEST: usize = 84; pub const R_TOTAL: usize = 88; pub const R_LSEASON: usize = 96; pub const R_LRANK: usize = 104; pub const R_ENTRIES: usize = 108;
pub const REG_SIZE: usize = 128;
// season receipt (base, delegated while the season runs, committed at the end, PDA ["receipt", season])
pub const RC_KIND: usize = 4; pub const RC_NS: usize = 5; pub const RC_PUB: usize = 6; pub const RC_DIV: usize = 7; pub const RC_SEASON: usize = 8; pub const RC_PARENT: usize = 16; pub const RC_RULESET: usize = 24; pub const RC_VERSION: usize = 26; pub const RC_GEN: usize = 27;
pub const RC_PACKS: usize = 28; pub const RC_NEPS: usize = 32; pub const RC_SEEDA: usize = 40; pub const RC_SEEDB: usize = 48; pub const RC_PINS: usize = 56; pub const RC_ENT: usize = 128; pub const RC_ESZ: usize = 80;
// entry: 0 id u64 | 8 code commitment | 40 score commitment | 72 rank u32 | 76 wins u16
pub const RC_SIZE: usize = RC_ENT + 20 * RC_ESZ;
// arena header
pub const A_FLAGS: usize = 4; pub const A_NS: usize = 5; pub const A_MAXS: usize = 6; pub const A_AUTH: usize = 8; pub const A_SEASON: usize = 40; pub const A_SEED: usize = 48; pub const A_NEPS: usize = 80; pub const A_SPT: usize = 84;
pub const A_CUREP: usize = 88; pub const A_CURTICK: usize = 92; pub const A_START: usize = 96; pub const A_FEE: usize = 104; pub const A_POOL: usize = 112; pub const A_MINT: usize = 120; pub const A_TICKS: usize = 152; pub const A_BUMP: usize = 156;
pub const A_MKT: usize = 160; pub const A_RET: usize = A_MKT + 352;
pub const A_PARENT: usize = 1112; pub const A_RESERVE: usize = 1120; pub const A_F2: usize = 1128; pub const A_PUBN: usize = 1129;
pub const A_PINS: usize = 1152; pub const A_DIV: usize = 1200; pub const HDR: usize = 1280;
// slot: 0 owner | 32 id u64 | 40 len u16 | 42 wins u16 | 44 rank u32 | 48 total i64 | 56 ep_last i64 | 64 seat(112) | 176 code(260)
pub const SL_OWNER: usize = 0; pub const SL_ID: usize = 32; pub const SL_LEN: usize = 40; pub const SL_WINS: usize = 42; pub const SL_RANK: usize = 44; pub const SL_TOTAL: usize = 48; pub const SL_EPLAST: usize = 56; pub const SL_SEAT: usize = 64; pub const SL_CODE: usize = 176; pub const SLOT: usize = 440;
pub const F2_FINALS: u8 = 1; pub const F2_HASFIN: u8 = 2; pub const F2_FINSTARTED: u8 = 4; pub const MAX_SLOTS: usize = 20; pub const FINALS_BPS: u64 = 20;
pub const F_LOCKED: u8 = 1; pub const F_REQ: u8 = 2; pub const F_SEEDED: u8 = 4; pub const F_DONE: u8 = 8; pub const F_SETTLED: u8 = 16;
pub fn arena_size(maxs: usize) -> usize { HDR + maxs * SLOT }
// compile-time layout guarantees the VM relies on: Market::load/Seat::load/save index fixed-size slices, so these regions must be large enough (a violation would be a build error, not a runtime abort)
const _: () = assert!(SL_SEAT + Seat::BYTES <= SL_CODE && A_MKT + Market::BYTES <= A_RET && A_RET + 4 * world::WORLD_T <= A_PARENT && SL_CODE + CODE_MAX <= SLOT && A_PINS + PINS_LEN <= A_DIV && HDR == 1280 && HDR + MAX_SLOTS * SLOT <= 10_240);
// metering model (compute units), calibrated on SBF: per tick TICK_BASE + sum over seats (SEAT_BASE + SEAT_PER_WORK * work), times SAFETY_PCT; episode start adds GEN_COST; each call adds a load/save tail
const GEN_COST: u64 = 330_000; const TAIL_BASE: u64 = 15_000; const TAIL_PER_SEAT: u64 = 2_200; const TICK_BASE: u64 = 4_600; const SEAT_BASE: u64 = 700; const SEAT_PER_WORK: u64 = 90; const SAFETY_PCT: u64 = 115;

fn rd64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
fn wr64(d: &mut [u8], o: usize, v: u64) { d[o..o + 8].copy_from_slice(&v.to_le_bytes()); }
fn rd32(d: &[u8], o: usize) -> u32 { u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }
fn wr32(d: &mut [u8], o: usize, v: u32) { d[o..o + 4].copy_from_slice(&v.to_le_bytes()); }
fn rdi64(d: &[u8], o: usize) -> i64 { i64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
fn pk(d: &[u8], o: usize) -> Pubkey { Pubkey::new_from_array(d[o..o + 32].try_into().unwrap()) }
macro_rules! bad { () => { ProgramError::Custom(line!()) }; }
fn owner_member(owner: &Pubkey) -> Vec<Member> { vec![Member { flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG, pubkey: owner.compat() }] }
/// distinct, documented error codes for the ruleset gates
fn vm_err(e: VmError) -> ProgramError { match e { VmError::OverWorkCap => ProgramError::Custom(9001), VmError::Version => ProgramError::Custom(9003), _ => ProgramError::Custom(9004) } }
fn check_arena(a: &AccountInfo, pid: &Pubkey) -> ProgramResult { if a.owner != pid || a.data_len() < HDR || rd32(&a.data.borrow(), 0) != M_ARENA { return Err(ProgramError::InvalidAccountData); } Ok(()) }
/// ruleset pinning: an arena only ever runs under the exact rules it was created under
fn check_pins(d: &[u8]) -> ProgramResult { if d[A_PINS..A_PINS + PINS_LEN] != pins_bytes() { return Err(ProgramError::Custom(9010)); } Ok(()) }
fn check_receipt(rc: &AccountInfo, pid: &Pubkey, season: &[u8]) -> ProgramResult {
    if rc.owner != pid || rc.data_len() < RC_SIZE || rd32(&rc.data.borrow(), 0) != M_RCPT || Pubkey::find_program_address(&[b"receipt", season], pid).0 != *rc.key { return Err(ProgramError::Custom(9020)); } Ok(())
}
/// eSPL bookkeeping record (what gets delegated)
fn espl_eata(owner: &Pubkey, mint: &Pubkey) -> Pubkey { Pubkey::find_program_address(&[owner.as_ref(), mint.as_ref()], &ESPL).0 }
/// standard ATA address: this is the token account the ER transfers operate on
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey { Pubkey::find_program_address(&[owner.as_ref(), TOKEN.as_ref(), mint.as_ref()], &ATOKEN).0 }
fn token_transfer<'a>(src: &AccountInfo<'a>, dst: &AccountInfo<'a>, auth: &AccountInfo<'a>, tp: &AccountInfo<'a>, amount: u64, seeds: &[&[&[u8]]]) -> ProgramResult {
    let mut data = vec![3u8]; data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction { program_id: TOKEN, accounts: vec![AccountMeta::new(*src.key, false), AccountMeta::new(*dst.key, false), AccountMeta::new_readonly(*auth.key, true)], data };
    if seeds.is_empty() { invoke(&ix, &[src.clone(), dst.clone(), auth.clone(), tp.clone()]) } else { invoke_signed(&ix, &[src.clone(), dst.clone(), auth.clone(), tp.clone()], seeds) }
}

fn process(pid: &Pubkey, accts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() >= 8 && data[..8] == UNDELEGATE_DISC { return undelegate_cb(pid, accts, &data[8..]); }
    if data.len() >= 8 && data[..8] == CB_DISC { return vrf_callback(pid, accts, &data[8..]); }
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let need = |n: usize| -> ProgramResult { if rest.len() < n { Err(ProgramError::InvalidInstructionData) } else { Ok(()) } };
    let it = &mut accts.iter();
    match *tag {
        // 0 InitHub (base): [payer(s,w), hub(w), system]; data: fund u64
        0 => {
            need(8)?; let (payer, hub, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let (pda, bump) = Pubkey::find_program_address(&[b"hub"], pid); if pda != *hub.key || !payer.is_signer { return Err(bad!()); }
            let fund = u64::from_le_bytes(rest[0..8].try_into().unwrap());
            if hub.lamports() == 0 { invoke_signed(&system_instruction::create_account(payer.key, hub.key, Rent::get()?.minimum_balance(16) + fund, 16, pid), &[payer.clone(), hub.clone(), sys.clone()], &[&[b"hub", &[bump]]])?; }
            hub.data.borrow_mut()[0..4].copy_from_slice(&M_HUB.to_le_bytes()); Ok(())
        }
        // 1 Register (base, public): [owner(s,w), reg(w), system]; data: id u64, commitment[32]. PDA ["reg", id]: the id is global, the owner is a field
        1 => {
            let (owner, reg, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            need(40)?; let id = &rest[0..8]; let (pda, bump) = Pubkey::find_program_address(&[b"reg", id], pid);
            if pda != *reg.key || !owner.is_signer { return Err(bad!()); }
            invoke_signed(&system_instruction::create_account(owner.key, reg.key, Rent::get()?.minimum_balance(REG_SIZE) + 2_000_000, REG_SIZE as u64, pid), &[owner.clone(), reg.clone(), sys.clone()], &[&[b"reg", id, &[bump]]])?;
            let mut d = reg.data.borrow_mut(); d[0..4].copy_from_slice(&M_REG.to_le_bytes()); d[R_OWNER..R_OWNER + 32].copy_from_slice(owner.key.as_ref()); d[R_ID..R_ID + 8].copy_from_slice(id); d[R_COMMIT..R_COMMIT + 32].copy_from_slice(&rest[8..40]);
            wr32(&mut d, R_BEST, u32::MAX); Ok(())
        }
        // 2 Delegate (base): [payer(s,w), system, pda(w), owner_program, buffer, record, metadata, dlp, validator]; data: kind (0 hub, 1 registry, 2 receipt), id-or-season u64
        2 => {
            need(9)?; let (payer, sys, pda, op, buf, rec, meta, dlp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let validator = it.next().map(|a| *a.key);
            let acc = DelegateAccounts { payer, pda, owner_program: op, buffer: buf, delegation_record: rec, delegation_metadata: meta, delegation_program: dlp, system_program: sys };
            let cfg = DelegateConfig { validator, ..Default::default() };
            if !payer.is_signer { return Err(ProgramError::MissingRequiredSignature); }
            match rest[0] {
                0 => delegate_account(acc, &[b"hub"], cfg),
                1 => { { let r = pda.data.borrow(); if pda.owner != pid || rd32(&r, 0) != M_REG || &r[R_OWNER..R_OWNER + 32] != payer.key.as_ref() || r[R_ID..R_ID + 8] != rest[1..9] { return Err(bad!()); } } delegate_account(acc, &[b"reg", &rest[1..9]], cfg) }
                _ => { if pda.owner != pid || rd32(&pda.data.borrow(), 0) != M_RCPT { return Err(bad!()); } delegate_account(acc, &[b"receipt", &rest[1..9]], cfg) }
            }
        }
        // 3 SealStrategy (TEE): [owner(s), hub(w), strat(w), permission(w), vault(w), magic, permission_program, reg]; data: id u64, salt[32], code
        3 => {
            let (owner, hub, strat, perm, vault, magic, pp, reg) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if !owner.is_signer { return Err(ProgramError::MissingRequiredSignature); }
            need(41)?; let idb = &rest[0..8]; let salt = &rest[8..40]; let code = &rest[40..];
            validate(code).map_err(vm_err)?; // ruleset v2: version tag, structure, work cap
            let (sp, sbump) = Pubkey::find_program_address(&[b"strat", idb], pid); if sp != *strat.key { return Err(bad!()); }
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let commit = hashv(&[DOM_CODE, salt, code]).to_bytes();
            { let r = reg.data.borrow(); let (rp, _) = Pubkey::find_program_address(&[b"reg", idb], pid);
              if reg.owner != pid || rp != *reg.key || rd32(&r, 0) != M_REG || &r[R_OWNER..R_OWNER + 32] != owner.key.as_ref() || r[R_COMMIT..R_COMMIT + 32] != commit { return Err(bad!()); } }
            let hs: &[&[u8]] = &[b"hub", &[hbump]]; let ss: &[&[u8]] = &[b"strat", idb, &[sbump]];
            EphemeralAccount::new(hub, strat, vault).with_signer_seeds(&[hs, ss]).create(STRAT_SIZE as u32)?;
            { let mut d = strat.data.borrow_mut(); d[0..4].copy_from_slice(&M_STRAT.to_le_bytes()); d[4..6].copy_from_slice(&(code.len() as u16).to_le_bytes()); d[S_OWNER..S_OWNER + 32].copy_from_slice(owner.key.as_ref()); d[S_ID..S_ID + 8].copy_from_slice(idb);
              d[S_COMMIT..S_COMMIT + 32].copy_from_slice(&commit); d[S_SALT..S_SALT + 32].copy_from_slice(salt); d[S_CODE..S_CODE + code.len()].copy_from_slice(code); }
            CreateEphemeralPermissionCpi { payer: hub.clone(), permissioned_account: strat.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
                args: EphemeralMembersArgs { is_private: true, members: owner_member(owner.key) } }.invoke_signed(&[hs, ss])
        }
        // 5 CreateSeason (TEE): [authority(s), hub(w), arena(w), permission(w), vault(w), magic, permission_program]; data: season u64, neps u32, spt u32, fee u64, mint[32], maxs u8, flags u8, division u8
        5 => {
            let (auth, hub, arena, perm, vault, magic, pp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if !auth.is_signer || rest.len() < 59 { return Err(ProgramError::MissingRequiredSignature); }
            let sid = &rest[0..8]; let maxs = rest[56] as usize; let division = rest[58] as usize; if maxs == 0 || maxs > MAX_SLOTS || division >= DIVISIONS.len() { return Err(bad!()); }
            let (ap, abump) = Pubkey::find_program_address(&[b"arena", sid], pid); if ap != *arena.key { return Err(bad!()); }
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let hs: &[&[u8]] = &[b"hub", &[hbump]]; let asd: &[&[u8]] = &[b"arena", sid, &[abump]];
            EphemeralAccount::new(hub, arena, vault).with_signer_seeds(&[hs, asd]).create(arena_size(maxs) as u32)?;
            { let mut d = arena.data.borrow_mut(); d[0..4].copy_from_slice(&M_ARENA.to_le_bytes()); d[A_MAXS] = maxs as u8; d[A_AUTH..A_AUTH + 32].copy_from_slice(auth.key.as_ref()); d[A_SEASON..A_SEASON + 8].copy_from_slice(sid);
              wr32(&mut d, A_NEPS, u32::from_le_bytes(rest[8..12].try_into().unwrap())); wr32(&mut d, A_SPT, u32::from_le_bytes(rest[12..16].try_into().unwrap())); wr64(&mut d, A_FEE, u64::from_le_bytes(rest[16..24].try_into().unwrap())); d[A_MINT..A_MINT + 32].copy_from_slice(&rest[24..56]); d[A_BUMP] = abump;
              d[A_F2] = rest[57] & F2_HASFIN; d[A_DIV] = division as u8; d[A_PINS..A_PINS + PINS_LEN].copy_from_slice(&pins_bytes()); }
            // private, members = [] : nobody (not even the authority) can read the arena
            CreateEphemeralPermissionCpi { payer: hub.clone(), permissioned_account: arena.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
                args: EphemeralMembersArgs { is_private: true, members: vec![] } }.invoke_signed(&[hs, asd])
        }
        // 6 Enter (TEE): [owner(s), strat, arena(w), owner_ata(w), pool_ata(w), token_program]
        6 => {
            let (owner, strat, arena, oe, pe, tp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; if strat.owner != pid { return Err(ProgramError::InvalidAccountData); }
            let s = strat.data.borrow(); let mut d = arena.data.borrow_mut(); check_pins(&d)?;
            if !owner.is_signer || rd32(&s, 0) != M_STRAT || &s[S_OWNER..S_OWNER + 32] != owner.key.as_ref() || d[A_FLAGS] & F_LOCKED != 0 { return Err(ProgramError::MissingRequiredSignature); }
            let (sp, _) = Pubkey::find_program_address(&[b"strat", &s[S_ID..S_ID + 8]], pid); if sp != *strat.key { return Err(bad!()); }
            let ns = d[A_NS] as usize; if ns >= d[A_MAXS] as usize { return Err(bad!()); }
            let l = u16::from_le_bytes([s[4], s[5]]) as usize; let code = &s[S_CODE..S_CODE + l];
            validate(code).map_err(vm_err)?; if work_of(code) > DIVISIONS[d[A_DIV] as usize] { return Err(ProgramError::Custom(9005)); } // ruleset gate and division gate, again, at entry
            for i in 0..ns { let o = HDR + i * SLOT; if d[o + SL_ID..o + SL_ID + 8] == s[S_ID..S_ID + 8] { return Err(bad!()); } }
            let mint = pk(&d, A_MINT); let sid = d[A_SEASON..A_SEASON + 8].to_vec(); let fee = rd64(&d, A_FEE);
            let (pool, _) = Pubkey::find_program_address(&[b"pool", &sid], pid);
            if *oe.key != ata(owner.key, &mint) || *pe.key != ata(&pool, &mint) { return Err(bad!()); }
            if fee > 0 { token_transfer(oe, pe, owner, tp, fee, &[])?; let np = rd64(&d, A_POOL) + fee; wr64(&mut d, A_POOL, np); }
            let o = HDR + ns * SLOT;
            d[o..o + SLOT].fill(0); d[o + SL_OWNER..o + SL_OWNER + 32].copy_from_slice(&s[S_OWNER..S_OWNER + 32]); d[o + SL_ID..o + SL_ID + 8].copy_from_slice(&s[S_ID..S_ID + 8]); d[o + SL_LEN..o + SL_LEN + 2].copy_from_slice(&(l as u16).to_le_bytes());
            d[o + SL_CODE..o + SL_CODE + l].copy_from_slice(code); d[A_NS] += 1; Ok(())
        }
        // 7 Lock (TEE): [authority(s), arena(w)]
        7 => { let (auth, arena) = (next_account_info(it)?, next_account_info(it)?); check_arena(arena, pid)?; let mut d = arena.data.borrow_mut(); check_pins(&d)?;
            if !auth.is_signer || &d[A_AUTH..A_AUTH + 32] != auth.key.as_ref() || d[A_NS] == 0 { return Err(bad!()); } d[A_FLAGS] |= F_LOCKED; Ok(()) }
        // 8 RequestSeed (permissionless after lock): [payer(s,w), arena(w), identity, queue(w), system, slot_hashes, vrf_program]
        8 => {
            let (payer, arena, identity, queue, sys, slots, vrf) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?;
            { let mut d = arena.data.borrow_mut(); check_pins(&d)?; if d[A_FLAGS] & F_LOCKED == 0 || d[A_FLAGS] & F_REQ != 0 { return Err(bad!()); } d[A_FLAGS] |= F_REQ; }
            let (idpda, bump) = Pubkey::find_program_address(&[b"identity"], pid); if idpda != *identity.key { return Err(bad!()); }
            let params = RequestRandomnessParams { payer: payer.key.compat(), oracle_queue: queue.key.compat(), callback_program_id: pid.compat(), callback_discriminator: CB_DISC.to_vec(), caller_seed: [7u8; 32],
                accounts_metas: Some(vec![ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta { pubkey: arena.key.compat(), is_signer: false, is_writable: true }]), callback_args: None };
            let ix = create_request_randomness_ix_const(params, idpda.compat()).modern();
            invoke_signed(&ix, &[payer.clone(), identity.clone(), queue.clone(), sys.clone(), slots.clone(), vrf.clone()], &[&[b"identity", &[bump]]])
        }
        // 9 Advance (permissionless, clock-gated, idempotent, work-metered): [arena(w)]; data: max_ticks u16, budget_k u16 (the transaction's compute limit in thousands; the program decides how many ticks that budget buys)
        9 => { need(2)?; let arena = next_account_info(it)?; check_arena(arena, pid)?; let budget = if rest.len() >= 4 { u64::from(u16::from_le_bytes([rest[2], rest[3]])) * 1000 } else { 200_000 }; advance(arena, u64::from(u16::from_le_bytes([rest[0], rest[1]])), budget) }
        // 10 Settle (permissionless): [crank(s), arena(w), receipt(w), pool_pda, pool_ata(w), token_program, entrant_atas(w)...]
        10 => {
            let (_crank, arena, receipt, pool, pe, tp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; let mut d = arena.data.borrow_mut(); check_pins(&d)?;
            if d[A_FLAGS] & F_DONE == 0 || d[A_FLAGS] & F_SETTLED != 0 { return Err(bad!()); }
            let ns = d[A_NS] as usize; let fin = d[A_F2] & F2_FINALS != 0; let mint = pk(&d, A_MINT);
            check_receipt(receipt, pid, &d[A_SEASON..A_SEASON + 8])?; { if receipt.data.borrow()[RC_NS] != 0 { return Err(ProgramError::Custom(9021)); } }
            let sid = if fin { d[A_PARENT..A_PARENT + 8].to_vec() } else { d[A_SEASON..A_SEASON + 8].to_vec() }; // finals pay out of the PARENT season's pool PDA
            let mut order: Vec<usize> = (0..ns).collect();
            if fin { order.sort_by(|a, b| { let (oa, ob) = (HDR + a * SLOT, HDR + b * SLOT); u16::from_le_bytes([d[ob + SL_WINS], d[ob + SL_WINS + 1]]).cmp(&u16::from_le_bytes([d[oa + SL_WINS], d[oa + SL_WINS + 1]])).then(rdi64(&d, ob + SL_TOTAL).cmp(&rdi64(&d, oa + SL_TOTAL))).then(a.cmp(b)) }); }
            else { order.sort_by(|a, b| rdi64(&d, HDR + b * SLOT + SL_TOTAL).cmp(&rdi64(&d, HDR + a * SLOT + SL_TOTAL)).then(a.cmp(b))); }
            for (rank, &i) in order.iter().enumerate() { wr32(&mut d, HDR + i * SLOT + SL_RANK, rank as u32 + 1); }
            // season receipt header + rank list (commitments are filled by Publish, which has the salts)
            { let mut r = receipt.data.borrow_mut(); let seed: [u8; 32] = d[A_SEED..A_SEED + 32].try_into().unwrap(); let (sa, sb) = world::season_words(&seed); let packs = world::season_packs(sa, sb);
              r[RC_KIND] = fin as u8; r[RC_NS] = ns as u8; r[RC_DIV] = d[A_DIV]; r[RC_SEASON..RC_SEASON + 8].copy_from_slice(&d[A_SEASON..A_SEASON + 8]); if fin { let p: [u8; 8] = d[A_PARENT..A_PARENT + 8].try_into().unwrap(); r[RC_PARENT..RC_PARENT + 8].copy_from_slice(&p); }
              let pins = &d[A_PINS..A_PINS + PINS_LEN]; r[RC_RULESET..RC_RULESET + 2].copy_from_slice(&pins[0..2]); r[RC_VERSION] = pins[2]; r[RC_GEN] = pins[3]; r[RC_PACKS] = packs[0] as u8; r[RC_PACKS + 1] = packs[1] as u8;
              wr32(&mut r, RC_NEPS, rd32(&d, A_NEPS)); wr64(&mut r, RC_SEEDA, sa); wr64(&mut r, RC_SEEDB, sb); r[RC_PINS..RC_PINS + PINS_LEN].copy_from_slice(pins);
              for i in 0..ns { let e = RC_ENT + i * RC_ESZ; let o = HDR + i * SLOT; let id: [u8; 8] = d[o + SL_ID..o + SL_ID + 8].try_into().unwrap(); r[e..e + 8].copy_from_slice(&id); let rk = rd32(&d, o + SL_RANK); wr32(&mut r, e + 72, rk); r[e + 76..e + 78].copy_from_slice(&d[o + SL_WINS..o + SL_WINS + 2]); } }
            let gross = rd64(&d, A_POOL);
            let (pot, shares): (u64, &[u64]) = if fin { (rd64(&d, A_RESERVE), &[100]) } else {
                let pay = if d[A_F2] & F2_HASFIN != 0 { gross - gross * FINALS_BPS / 100 } else { gross }; wr64(&mut d, A_RESERVE, gross - pay);
                (pay, match ns { 1 => &[100], 2 => &[60, 40], _ => &[50, 30, 20] }) };
            let (pp, pbump) = Pubkey::find_program_address(&[b"pool", &sid], pid); if pp != *pool.key || *pe.key != ata(&pp, &mint) { return Err(bad!()); }
            // winners are located INSIDE the program: the caller passes every entrant's token account in slot order and learns nothing about the ranking
            let atas: Vec<&AccountInfo> = it.collect(); if atas.len() < ns { return Err(bad!()); }
            let mut paid = 0u64; let np = shares.len().min(ns);
            for k in 0..np { let i = order[k]; let w = atas[i]; let owner = pk(&d, HDR + i * SLOT + SL_OWNER);
                if *w.key != ata(&owner, &mint) { return Err(bad!()); } let amt = if k == np - 1 { pot - paid } else { pot * shares[k] / 100 };
                if amt > 0 { token_transfer(pe, w, pool, tp, amt, &[&[b"pool", &sid, &[pbump]]])?; } paid += amt; }
            d[A_FLAGS] |= F_SETTLED; Ok(())
        }
        // 11 Publish (permissionless after settle): [crank(s), arena(w), strat(w), reg(w), receipt(w)]; data: slot u8
        11 => {
            let (_c, arena, strat, reg, receipt) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; let mut d = arena.data.borrow_mut(); if d[A_FLAGS] & F_SETTLED == 0 { return Err(bad!()); }
            let i = rest[0] as usize; if i >= d[A_NS] as usize { return Err(bad!()); } let o = HDR + i * SLOT; let id: [u8; 8] = d[o + SL_ID..o + SL_ID + 8].try_into().unwrap();
            if strat.owner != pid || reg.owner != pid || Pubkey::find_program_address(&[b"strat", &id], pid).0 != *strat.key || Pubkey::find_program_address(&[b"reg", &id], pid).0 != *reg.key { return Err(bad!()); }
            check_receipt(receipt, pid, &d[A_SEASON..A_SEASON + 8])?;
            let (rank, total, ns, season, neps) = (rd32(&d, o + SL_RANK), rdi64(&d, o + SL_TOTAL), d[A_NS] as u32, rd64(&d, A_SEASON), rd32(&d, A_NEPS)); let wins = [d[o + SL_WINS], d[o + SL_WINS + 1]]; let fin = d[A_F2] & F2_FINALS != 0;
            let salt: [u8; 32]; let commit: [u8; 32];
            { let mut s = strat.data.borrow_mut(); if rd64(&s, S_LSEASON) == season + 1 { return Err(bad!()); } salt = s[S_SALT..S_SALT + 32].try_into().unwrap(); commit = s[S_COMMIT..S_COMMIT + 32].try_into().unwrap();
              wr64(&mut s, S_LSEASON, season + 1); wr32(&mut s, S_LRANK, rank); wr32(&mut s, S_LN, ns); s[S_LPNL..S_LPNL + 8].copy_from_slice(&total.to_le_bytes()); }
            if !fin { let mut r = reg.data.borrow_mut(); let (se, en, b, t) = (rd32(&r, R_SEASONS) + 1, rd32(&r, R_ENTRIES) + 1, rd32(&r, R_BEST).min(rank), rdi64(&r, R_TOTAL) + total); wr32(&mut r, R_SEASONS, se); wr32(&mut r, R_ENTRIES, en); wr32(&mut r, R_BEST, b);
              r[R_TOTAL..R_TOTAL + 8].copy_from_slice(&t.to_le_bytes()); wr64(&mut r, R_LSEASON, season); wr32(&mut r, R_LRANK, rank); }
            // score commitment: salted with the entrant's secret, so an outsider who re-simulates presets from the revealed seed cannot match it
            let score = hashv(&[DOM_SCORE, &salt, &season.to_le_bytes(), &id, &total.to_le_bytes(), &wins, &neps.to_le_bytes()]).to_bytes();
            { let mut r = receipt.data.borrow_mut(); let e = RC_ENT + i * RC_ESZ; if r[e..e + 8] != id { return Err(ProgramError::Custom(9022)); } r[e + 8..e + 40].copy_from_slice(&commit); r[e + 40..e + 72].copy_from_slice(&score); r[RC_PUB] += 1; }
            d[A_PUBN] += 1; Ok(())
        }
        // 12 Commit (TEE): [payer(s,w), magic, magic_ctx, accounts(w)...]  commits delegated registries and receipts to base
        12 => { let (payer, magic, ctx) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?); let regs: Vec<AccountInfo> = it.cloned().collect();
            MagicIntentBundleBuilder::new(payer.clone(), ctx.clone(), magic.clone()).commit(&regs).build_and_invoke() }
        // 13 InitPool (base): [payer(s,w), eata(w), pool_pda, mint, system, espl, buffer(w), record(w), metadata(w), dlp, validator, pool_ata(w), ata_program, token_program]; data: season u64
        13 => {
            need(8)?; let (payer, ea, pool, mint, sys, espl) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let (buf, rec, meta, dlp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?); let validator = next_account_info(it)?;
            let (pata, atp, tkp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if Pubkey::find_program_address(&[b"pool", &rest[0..8]], pid).0 != *pool.key || *ea.key != espl_eata(pool.key, mint.key) || !payer.is_signer { return Err(bad!()); }
            // ordering: the pool's base ATA must exist BEFORE its eATA is delegated (the ER token account is derived from it); creating it here makes pool setup atomic
            if *pata.key != ata(pool.key, mint.key) { return Err(bad!()); }
            invoke(&Instruction { program_id: ATOKEN, accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*pata.key, false), AccountMeta::new_readonly(*pool.key, false), AccountMeta::new_readonly(*mint.key, false), AccountMeta::new_readonly(*sys.key, false), AccountMeta::new_readonly(*tkp.key, false)], data: vec![1] },
                &[payer.clone(), pata.clone(), pool.clone(), mint.clone(), sys.clone(), tkp.clone(), atp.clone()])?;
            let ix = Instruction { program_id: ESPL, accounts: vec![AccountMeta::new(*ea.key, false), AccountMeta::new(*payer.key, true), AccountMeta::new_readonly(*pool.key, false), AccountMeta::new_readonly(*mint.key, false), AccountMeta::new_readonly(*sys.key, false)], data: vec![0] };
            invoke(&ix, &[ea.clone(), payer.clone(), pool.clone(), mint.clone(), sys.clone(), espl.clone()])?;
            let mut dd = vec![4u8]; dd.extend_from_slice(validator.key.as_ref());
            let ix = Instruction { program_id: ESPL, accounts: vec![AccountMeta::new(*payer.key, true), AccountMeta::new(*ea.key, false), AccountMeta::new_readonly(ESPL, false), AccountMeta::new(*buf.key, false), AccountMeta::new(*rec.key, false), AccountMeta::new(*meta.key, false), AccountMeta::new_readonly(*dlp.key, false), AccountMeta::new_readonly(*sys.key, false)], data: dd };
            invoke(&ix, &[payer.clone(), ea.clone(), espl.clone(), buf.clone(), rec.clone(), meta.clone(), dlp.clone(), sys.clone()])
        }
        // 14 StartFinals (permissionless, after settle): [crank(s), parent(w), hub(w), finals(w), permission(w), vault(w), magic, permission_program]; data: finals_sid u64, k u8, neps u32, spt u32
        // copies the top-k (by parent rank) sealed strategies INSIDE the program into a fresh private arena that gets its own VRF seed; ranking there is by episodes won (best-of-N), then total PnL
        14 => {
            need(17)?; let (crank, parent, hub, fin, perm, vault, magic, pp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if !crank.is_signer { return Err(ProgramError::MissingRequiredSignature); } check_arena(parent, pid)?;
            let fsid = &rest[0..8]; let neps = u32::from_le_bytes(rest[9..13].try_into().unwrap()); let spt = u32::from_le_bytes(rest[13..17].try_into().unwrap()); if neps == 0 || neps % 2 == 0 { return Err(bad!()); }
            let k = { let d = parent.data.borrow(); check_pins(&d)?; if d[A_FLAGS] & F_SETTLED == 0 || d[A_F2] & F2_HASFIN == 0 || d[A_F2] & F2_FINSTARTED != 0 { return Err(bad!()); } (rest[8] as usize).min(d[A_NS] as usize).max(1) };
            let (ap, abump) = Pubkey::find_program_address(&[b"arena", fsid], pid); if ap != *fin.key { return Err(bad!()); }
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let hs: &[&[u8]] = &[b"hub", &[hbump]]; let asd: &[&[u8]] = &[b"arena", fsid, &[abump]];
            EphemeralAccount::new(hub, fin, vault).with_signer_seeds(&[hs, asd]).create(arena_size(k) as u32)?;
            { let mut p = parent.data.borrow_mut(); let mut d = fin.data.borrow_mut();
              d[0..4].copy_from_slice(&M_ARENA.to_le_bytes()); d[A_MAXS] = k as u8; d[A_NS] = k as u8; d[A_AUTH..A_AUTH + 32].copy_from_slice(&p[A_AUTH..A_AUTH + 32]); d[A_SEASON..A_SEASON + 8].copy_from_slice(fsid);
              wr32(&mut d, A_NEPS, neps); wr32(&mut d, A_SPT, spt); d[A_MINT..A_MINT + 32].copy_from_slice(&p[A_MINT..A_MINT + 32]); d[A_BUMP] = abump; d[A_FLAGS] = F_LOCKED; d[A_F2] = F2_FINALS; d[A_DIV] = p[A_DIV];
              let pins: [u8; PINS_LEN] = p[A_PINS..A_PINS + PINS_LEN].try_into().unwrap(); d[A_PINS..A_PINS + PINS_LEN].copy_from_slice(&pins);
              let psid: [u8; 8] = p[A_SEASON..A_SEASON + 8].try_into().unwrap(); d[A_PARENT..A_PARENT + 8].copy_from_slice(&psid); let res = rd64(&p, A_RESERVE); wr64(&mut d, A_RESERVE, res);
              let pn = p[A_NS] as usize; let mut filled = 0;
              // finalist slots keep parent ENTRY order (public information once ranks are published), so a cranker can address them without learning anything private
              for i in 0..pn { let o = HDR + i * SLOT; let r = rd32(&p, o + SL_RANK); if r >= 1 && r as usize <= k { let n = filled * SLOT + HDR; let l = u16::from_le_bytes([p[o + SL_LEN], p[o + SL_LEN + 1]]) as usize;
                  d[n + SL_OWNER..n + SL_OWNER + 40].copy_from_slice(&p[o + SL_OWNER..o + SL_OWNER + 40]); d[n + SL_LEN..n + SL_LEN + 2].copy_from_slice(&(l as u16).to_le_bytes()); d[n + SL_CODE..n + SL_CODE + l].copy_from_slice(&p[o + SL_CODE..o + SL_CODE + l]); filled += 1; } }
              if filled != k { return Err(bad!()); } p[A_F2] |= F2_FINSTARTED; }
            CreateEphemeralPermissionCpi { payer: hub.clone(), permissioned_account: fin.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
                args: EphemeralMembersArgs { is_private: true, members: vec![] } }.invoke_signed(&[hs, asd])
        }
        // 15 Cleanup (permissionless): [crank(s), hub(w), arena(w), permission(w), vault(w), magic, permission_program] closes the ephemeral arena + its permission, refunding rent to the hub sponsor
        15 => {
            let (crank, hub, arena, perm, vault, magic, pp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if !crank.is_signer { return Err(ProgramError::MissingRequiredSignature); } check_arena(arena, pid)?;
            let (sid, abump) = { let d = arena.data.borrow(); if d[A_FLAGS] & F_SETTLED == 0 || d[A_PUBN] < d[A_NS] { return Err(bad!()); } if d[A_F2] & F2_HASFIN != 0 && d[A_F2] & F2_FINSTARTED == 0 { return Err(bad!()); } (d[A_SEASON..A_SEASON + 8].to_vec(), d[A_BUMP]) };
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let hs: &[&[u8]] = &[b"hub", &[hbump]]; let asd: &[&[u8]] = &[b"arena", &sid, &[abump]];
            ephemeral_rollups_sdk::access_control::instructions::CloseEphemeralPermissionCpi { payer: hub.clone(), authority: arena.clone(), permissioned_account: arena.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(), authority_is_signer: false }.invoke_signed(&[hs, asd])?;
            EphemeralAccount::new(hub, arena, vault).with_signer_seeds(&[hs]).close()
        }
        // 16 InitReceipt (base): [payer(s,w), receipt(w), system]; data: season u64. The receipt is a durable, committable record on base
        16 => {
            need(8)?; let (payer, rc, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?); let sid = &rest[0..8];
            let (pda, bump) = Pubkey::find_program_address(&[b"receipt", sid], pid); if pda != *rc.key || !payer.is_signer { return Err(bad!()); }
            invoke_signed(&system_instruction::create_account(payer.key, rc.key, Rent::get()?.minimum_balance(RC_SIZE) + 2_000_000, RC_SIZE as u64, pid), &[payer.clone(), rc.clone(), sys.clone()], &[&[b"receipt", sid, &[bump]]])?;
            rc.data.borrow_mut()[0..4].copy_from_slice(&M_RCPT.to_le_bytes()); Ok(())
        }
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Work-metered driver. The devnet runtime does not enable the remaining-compute syscall (observed: the loader rejects the program), so the program meters by a calibrated static model: cost per tick
/// is derived from each seat's metered work (the weights are calibrated so compute is roughly linear in work). Given the caller's compute limit it runs as many ticks as the model says fit,
/// with a safety factor, then stops cleanly. Partial progress is safe because the clock gate makes the call idempotent. The caller never picks a tick count.
fn advance(arena: &AccountInfo, max: u64, budget: u64) -> ProgramResult {
    let mut d = arena.data.borrow_mut(); check_pins(&d)?;
    if d[A_FLAGS] & F_SEEDED == 0 || d[A_FLAGS] & F_DONE != 0 { return Err(bad!()); }
    let slot = Clock::get()?.slot; let start = rd64(&d, A_START); let spt = u64::from(rd32(&d, A_SPT)).max(1);
    let neps = rd32(&d, A_NEPS); let mut cur_ep = rd32(&d, A_CUREP); let mut cur_tick = rd32(&d, A_CURTICK) as usize;
    let done_g = u64::from(cur_ep) * world::WORLD_T as u64 + cur_tick as u64; let due = slot.saturating_sub(start) / spt;
    if due <= done_g { return Ok(()); }
    let n = (due - done_g).min(max);
    let ns = d[A_NS] as usize; let seed: [u8; 32] = d[A_SEED..A_SEED + 32].try_into().unwrap(); let (sa, sb) = world::season_words(&seed); let packs = world::season_packs(sa, sb);
    let mut est_tick = TICK_BASE; for i in 0..ns { let o = HDR + i * SLOT; let l = u16::from_le_bytes([d[o + SL_LEN], d[o + SL_LEN + 1]]) as usize; est_tick += SEAT_BASE + SEAT_PER_WORK * u64::from(work_of(&d[o + SL_CODE..o + SL_CODE + l])); }
    est_tick = est_tick * SAFETY_PCT / 100;
    let mut left = budget.saturating_sub(TAIL_BASE + TAIL_PER_SEAT * ns as u64);
    let mut market = Market::load(&d[A_MKT..A_MKT + Market::BYTES]);
    let mut seats: Vec<Seat> = (0..ns).map(|i| Seat::load(&d[HDR + i * SLOT + SL_SEAT..HDR + i * SLOT + SL_SEAT + Seat::BYTES])).collect();
    let mut ran = 0u64; let mut finished = false; let mut totals: Vec<i64> = (0..ns).map(|i| rdi64(&d, HDR + i * SLOT + SL_TOTAL)).collect();
    while ran < n && !finished {
        let need = est_tick + if cur_tick == 0 { GEN_COST } else { 0 }; if left < need { break; } left -= need;
        if cur_tick == 0 {
            let es = world::episode_seed(sa, sb, u64::from(cur_ep)); let mut r = [0i32; world::WORLD_T]; world::gen_episode(world::pack_for_season(&packs, es), es, &mut r);
            for (i, v) in r.iter().enumerate() { d[A_RET + i * 4..A_RET + i * 4 + 4].copy_from_slice(&v.to_le_bytes()); }
            market = Market::new(world::WORLD_T as u32); for s in seats.iter_mut() { *s = Seat::new(); }
        }
        let r = i32::from_le_bytes(d[A_RET + cur_tick * 4..A_RET + cur_tick * 4 + 4].try_into().unwrap());
        let sg0 = market.advance(r);
        for (i, s) in seats.iter_mut().enumerate() { let o = HDR + i * SLOT; let len = u16::from_le_bytes([d[o + SL_LEN], d[o + SL_LEN + 1]]) as usize; s.step(&d[o + SL_CODE..o + SL_CODE + len], &market, r, sg0); }
        cur_tick += 1; ran += 1;
        if cur_tick == world::WORLD_T { let mut best = 0usize; for (i, s) in seats.iter().enumerate() { totals[i] += s.pnl(); wr64(&mut d, HDR + i * SLOT + SL_EPLAST, s.pnl() as u64); if s.pnl() > seats[best].pnl() { best = i; } }
            if d[A_F2] & F2_FINALS != 0 && ns > 0 { let o = HDR + best * SLOT + SL_WINS; let w = u16::from_le_bytes([d[o], d[o + 1]]).saturating_add(1); d[o..o + 2].copy_from_slice(&w.to_le_bytes()); }
            cur_tick = 0; cur_ep += 1; if cur_ep >= neps { finished = true; } }
    }
    if ran == 0 { return Ok(()); }
    market.save(&mut d[A_MKT..A_MKT + Market::BYTES]);
    for (i, s) in seats.iter().enumerate() { let o = HDR + i * SLOT; s.save(&mut d[o + SL_SEAT..o + SL_SEAT + Seat::BYTES]); d[o + SL_TOTAL..o + SL_TOTAL + 8].copy_from_slice(&totals[i].to_le_bytes()); }
    wr32(&mut d, A_CUREP, cur_ep); wr32(&mut d, A_CURTICK, cur_tick as u32); let t = rd32(&d, A_TICKS) + ran as u32; wr32(&mut d, A_TICKS, t);
    if finished { d[A_FLAGS] |= F_DONE; }
    Ok(())
}

fn vrf_callback(pid: &Pubkey, accts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accts.iter(); let (identity, arena) = (next_account_info(it)?, next_account_info(it)?);
    let expect = Pubkey::find_program_address(&[b"identity", pid.as_ref()], &VRF_PROGRAM_ID.modern()).0;
    if !identity.is_signer || *identity.key != expect { return Err(ProgramError::MissingRequiredSignature); }
    check_arena(arena, pid)?; let mut d = arena.data.borrow_mut(); check_pins(&d)?;
    if d[A_FLAGS] & F_REQ == 0 || d[A_FLAGS] & F_SEEDED != 0 || rest.len() < 32 { return Err(bad!()); }
    d[A_SEED..A_SEED + 32].copy_from_slice(&rest[..32]); d[A_FLAGS] |= F_SEEDED; wr64(&mut d, A_START, Clock::get()?.slot);
    Market::new(world::WORLD_T as u32).save(&mut d[A_MKT..A_MKT + Market::BYTES]);
    let ns = d[A_NS] as usize; for i in 0..ns { Seat::new().save(&mut d[HDR + i * SLOT + SL_SEAT..HDR + i * SLOT + SL_SEAT + Seat::BYTES]); }
    Ok(())
}
fn undelegate_cb(pid: &Pubkey, accts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accts.iter(); let (pda, buf, payer, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    let mut seeds: Vec<Vec<u8>> = Vec::new(); let n = u32::from_le_bytes(rest[0..4].try_into().unwrap()) as usize; let mut o = 4;
    for _ in 0..n { let l = u32::from_le_bytes(rest[o..o + 4].try_into().unwrap()) as usize; o += 4; seeds.push(rest[o..o + l].to_vec()); o += l; }
    undelegate_account(pda, pid, buf, payer, sys, seeds)
}
