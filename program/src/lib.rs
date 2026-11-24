//! Conclave: sealed-strategy league. Spine: Register (base, public) -> Seal (TEE, private from first instant) -> Season arena (ER-only ephemeral, never committed)
//! -> Enter + Lock -> VRF seed -> permissionless clock-gated Advance (real conclave-vm + v2 world, in-enclave) -> Settle (rank by total vol-targeted PnL, pay eSPL pool) -> Publish coarse rank.
use conclave_vm::{validate, world, Market, Seat, MAX_OPS};
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
// ---- layouts ----
pub const M_ARENA: u32 = 0x4152_4E41; pub const M_STRAT: u32 = 0x5354_5254; pub const M_REG: u32 = 0x5245_4753; pub const M_HUB: u32 = 0x4855_4221;
pub const CODE_MAX: usize = 4 + 4 * MAX_OPS;
// strategy (ephemeral, sealed): 0 magic | 4 len u16 | 8 owner | 40 id | 48 code_hash | 80 last_season | 88 last_rank u32 | 92 last_n u32 | 96 last_pnl i64 | 104 code
pub const S_OWNER: usize = 8; pub const S_ID: usize = 40; pub const S_HASH: usize = 48; pub const S_LSEASON: usize = 80; pub const S_LRANK: usize = 88; pub const S_LN: usize = 92; pub const S_LPNL: usize = 96; pub const S_CODE: usize = 104;
pub const STRAT_SIZE: usize = S_CODE + CODE_MAX;
// registry (public, delegated for settlement writes): 0 magic | 8 owner | 40 id | 48 hash | 80 seasons u32 | 84 best_rank u32 | 88 total_pnl i64 | 96 last_season u64 | 104 last_rank u32 | 108 entries u32
pub const R_OWNER: usize = 8; pub const R_ID: usize = 40; pub const R_HASH: usize = 48; pub const R_SEASONS: usize = 80; pub const R_BEST: usize = 84; pub const R_TOTAL: usize = 88; pub const R_LSEASON: usize = 96; pub const R_LRANK: usize = 104; pub const R_ENTRIES: usize = 108;
pub const R_SEEDAB: usize = 112; // (seed_a, seed_b) of the last settled season: revealed after settlement (retire-and-reveal), lets anyone re-derive that season's worlds
pub const REG_SIZE: usize = 128;
// arena header
pub const A_FLAGS: usize = 4; pub const A_NS: usize = 5; pub const A_MAXS: usize = 6; pub const A_AUTH: usize = 8; pub const A_SEASON: usize = 40; pub const A_SEED: usize = 48; pub const A_NEPS: usize = 80; pub const A_SPT: usize = 84;
pub const A_CUREP: usize = 88; pub const A_CURTICK: usize = 92; pub const A_START: usize = 96; pub const A_FEE: usize = 104; pub const A_POOL: usize = 112; pub const A_MINT: usize = 120; pub const A_TICKS: usize = 152; pub const A_BUMP: usize = 156;
pub const A_MKT: usize = 160; pub const A_RET: usize = A_MKT + 352; pub const HDR: usize = 1152;
// slot: 0 owner | 32 id u64 | 40 len u16 | 44 rank u32 | 48 total i64 | 56 ep_last i64 | 64 seat(112) | 176 code(260)
pub const SL_OWNER: usize = 0; pub const SL_ID: usize = 32; pub const SL_LEN: usize = 40; pub const SL_RANK: usize = 44; pub const SL_TOTAL: usize = 48; pub const SL_EPLAST: usize = 56; pub const SL_SEAT: usize = 64; pub const SL_CODE: usize = 176; pub const SLOT: usize = 440;
/// per-tick metered work cap (see conclave_vm::work_of). Pool max is 75; 128 keeps a full 20-seat arena far inside the 1.4M CU cap (measured, see evidence).
pub const WORK_CAP: u32 = 128;
pub const A_PARENT: usize = 1112; pub const A_RESERVE: usize = 1120; pub const A_F2: usize = 1128; pub const A_PUBN: usize = 1129;
pub const F2_FINALS: u8 = 1; pub const F2_HASFIN: u8 = 2; pub const F2_FINSTARTED: u8 = 4; pub const SL_WINS: usize = 42; pub const MAX_SLOTS: usize = 20; pub const FINALS_BPS: u64 = 20;
pub const F_LOCKED: u8 = 1; pub const F_REQ: u8 = 2; pub const F_SEEDED: u8 = 4; pub const F_DONE: u8 = 8; pub const F_SETTLED: u8 = 16;
pub fn arena_size(maxs: usize) -> usize { HDR + maxs * SLOT }

fn rd64(d: &[u8], o: usize) -> u64 { u64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
fn wr64(d: &mut [u8], o: usize, v: u64) { d[o..o + 8].copy_from_slice(&v.to_le_bytes()); }
fn rd32(d: &[u8], o: usize) -> u32 { u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) }
fn wr32(d: &mut [u8], o: usize, v: u32) { d[o..o + 4].copy_from_slice(&v.to_le_bytes()); }
fn rdi64(d: &[u8], o: usize) -> i64 { i64::from_le_bytes(d[o..o + 8].try_into().unwrap()) }
fn pk(d: &[u8], o: usize) -> Pubkey { Pubkey::new_from_array(d[o..o + 32].try_into().unwrap()) }
macro_rules! bad { () => { ProgramError::Custom(line!()) }; }
fn owner_member(owner: &Pubkey) -> Vec<Member> { vec![Member { flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG, pubkey: owner.compat() }] }

fn check_arena(a: &AccountInfo, pid: &Pubkey) -> ProgramResult { if a.owner != pid || a.data_len() < HDR || rd32(&a.data.borrow(), 0) != M_ARENA { return Err(ProgramError::InvalidAccountData); } Ok(()) }
const ATOKEN: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
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
    let it = &mut accts.iter();
    match *tag {
        // 0 InitHub (base): [payer(s,w), hub(w), system]; data: fund u64
        0 => {
            let (payer, hub, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let (pda, bump) = Pubkey::find_program_address(&[b"hub"], pid); if pda != *hub.key || !payer.is_signer { return Err(bad!()); }
            let fund = u64::from_le_bytes(rest[0..8].try_into().unwrap());
            if hub.lamports() == 0 { invoke_signed(&system_instruction::create_account(payer.key, hub.key, Rent::get()?.minimum_balance(16) + fund, 16, pid), &[payer.clone(), hub.clone(), sys.clone()], &[&[b"hub", &[bump]]])?; }
            hub.data.borrow_mut()[0..4].copy_from_slice(&M_HUB.to_le_bytes()); Ok(())
        }
        // 1 Register (base, public): [owner(s,w), reg(w), system]; data: id u64, code_hash[32]
        1 => {
            let (owner, reg, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let id = &rest[0..8]; let (pda, bump) = Pubkey::find_program_address(&[b"reg", owner.key.as_ref(), id], pid);
            if pda != *reg.key || !owner.is_signer { return Err(bad!()); }
            invoke_signed(&system_instruction::create_account(owner.key, reg.key, Rent::get()?.minimum_balance(REG_SIZE) + 2_000_000, REG_SIZE as u64, pid), &[owner.clone(), reg.clone(), sys.clone()], &[&[b"reg", owner.key.as_ref(), id, &[bump]]])?;
            let mut d = reg.data.borrow_mut(); d[0..4].copy_from_slice(&M_REG.to_le_bytes()); d[R_OWNER..R_OWNER + 32].copy_from_slice(owner.key.as_ref()); d[R_ID..R_ID + 8].copy_from_slice(id); d[R_HASH..R_HASH + 32].copy_from_slice(&rest[8..40]);
            wr32(&mut d, R_BEST, u32::MAX); Ok(())
        }
        // 2 Delegate (base): [payer(s,w), system, pda(w), owner_program, buffer, record, metadata, dlp, validator]; data: kind(0 hub,1 reg), id u64, owner[32]
        2 => {
            let (payer, sys, pda, op, buf, rec, meta, dlp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let validator = it.next().map(|a| *a.key);
            let acc = DelegateAccounts { payer, pda, owner_program: op, buffer: buf, delegation_record: rec, delegation_metadata: meta, delegation_program: dlp, system_program: sys };
            let cfg = DelegateConfig { validator, ..Default::default() };
            match rest[0] {
                0 => delegate_account(acc, &[b"hub"], cfg),
                _ => { if !payer.is_signer || payer.key.as_ref() != &rest[9..41] { return Err(bad!()); } delegate_account(acc, &[b"reg", &rest[9..41], &rest[1..9]], cfg) }
            }
        }
        // 3 SealStrategy (TEE): [owner(s), hub(w), strat(w), permission(w), vault(w), magic, permission_program, reg]; data: id u64, code blob
        3 => {
            let (owner, hub, strat, perm, vault, magic, pp, reg) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if !owner.is_signer { return Err(ProgramError::MissingRequiredSignature); }
            let idb = &rest[0..8]; let code = &rest[8..]; validate(code).map_err(|_| ProgramError::Custom(line!()))?; if conclave_vm::work_of(code) > WORK_CAP { return Err(ProgramError::Custom(9001)); }
            let (sp, sbump) = Pubkey::find_program_address(&[b"strat", owner.key.as_ref(), idb], pid); if sp != *strat.key { return Err(bad!()); }
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let hash = hashv(&[code]).to_bytes();
            { let r = reg.data.borrow(); let (rp, _) = Pubkey::find_program_address(&[b"reg", owner.key.as_ref(), idb], pid);
              if reg.owner != pid || rp != *reg.key || rd32(&r, 0) != M_REG || &r[R_OWNER..R_OWNER + 32] != owner.key.as_ref() || r[R_HASH..R_HASH + 32] != hash { return Err(bad!()); } }
            let hs: &[&[u8]] = &[b"hub", &[hbump]]; let ss: &[&[u8]] = &[b"strat", owner.key.as_ref(), idb, &[sbump]];
            EphemeralAccount::new(hub, strat, vault).with_signer_seeds(&[hs, ss]).create(STRAT_SIZE as u32)?;
            { let mut d = strat.data.borrow_mut(); d[0..4].copy_from_slice(&M_STRAT.to_le_bytes()); d[4..6].copy_from_slice(&(code.len() as u16).to_le_bytes()); d[S_OWNER..S_OWNER + 32].copy_from_slice(owner.key.as_ref()); d[S_ID..S_ID + 8].copy_from_slice(idb); d[S_HASH..S_HASH + 32].copy_from_slice(&hash); d[S_CODE..S_CODE + code.len()].copy_from_slice(code); }
            CreateEphemeralPermissionCpi { payer: hub.clone(), permissioned_account: strat.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
                args: EphemeralMembersArgs { is_private: true, members: owner_member(owner.key) } }.invoke_signed(&[hs, ss])
        }
        // 5 CreateSeason (TEE): [authority(s), hub(w), arena(w), permission(w), vault(w), magic, permission_program]; data: season u64, neps u32, spt u32, fee u64, mint[32], maxs u8
        5 => {
            let (auth, hub, arena, perm, vault, magic, pp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if !auth.is_signer { return Err(ProgramError::MissingRequiredSignature); }
            let sid = &rest[0..8]; let maxs = rest[56] as usize; if maxs == 0 || maxs > MAX_SLOTS { return Err(bad!()); }
            let (ap, abump) = Pubkey::find_program_address(&[b"arena", sid], pid); if ap != *arena.key { return Err(bad!()); }
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let hs: &[&[u8]] = &[b"hub", &[hbump]]; let asd: &[&[u8]] = &[b"arena", sid, &[abump]];
            EphemeralAccount::new(hub, arena, vault).with_signer_seeds(&[hs, asd]).create(arena_size(maxs) as u32)?;
            { let mut d = arena.data.borrow_mut(); d[0..4].copy_from_slice(&M_ARENA.to_le_bytes()); d[A_MAXS] = maxs as u8; d[A_AUTH..A_AUTH + 32].copy_from_slice(auth.key.as_ref()); d[A_SEASON..A_SEASON + 8].copy_from_slice(sid);
              wr32(&mut d, A_NEPS, u32::from_le_bytes(rest[8..12].try_into().unwrap())); wr32(&mut d, A_SPT, u32::from_le_bytes(rest[12..16].try_into().unwrap())); wr64(&mut d, A_FEE, u64::from_le_bytes(rest[16..24].try_into().unwrap())); d[A_MINT..A_MINT + 32].copy_from_slice(&rest[24..56]); d[A_BUMP] = abump; d[A_F2] = rest.get(57).copied().unwrap_or(0) & F2_HASFIN; }
            // private, members = [] : nobody (not even the authority) can read the arena
            CreateEphemeralPermissionCpi { payer: hub.clone(), permissioned_account: arena.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
                args: EphemeralMembersArgs { is_private: true, members: vec![] } }.invoke_signed(&[hs, asd])
        }
        // 6 Enter (TEE): [owner(s), strat, arena(w), owner_eata(w), pool_eata(w), token_program, pool_pda]
        6 => {
            let (owner, strat, arena, oe, pe, tp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; if strat.owner != pid { return Err(ProgramError::InvalidAccountData); }
            let s = strat.data.borrow(); let mut d = arena.data.borrow_mut();
            if !owner.is_signer || rd32(&s, 0) != M_STRAT || &s[S_OWNER..S_OWNER + 32] != owner.key.as_ref() || d[A_FLAGS] & F_LOCKED != 0 { return Err(ProgramError::MissingRequiredSignature); }
            let (sp, _) = Pubkey::find_program_address(&[b"strat", owner.key.as_ref(), &s[S_ID..S_ID + 8]], pid); if sp != *strat.key { return Err(bad!()); }
            let ns = d[A_NS] as usize; if ns >= d[A_MAXS] as usize { return Err(bad!()); }
            { let l = u16::from_le_bytes([s[4], s[5]]) as usize; if conclave_vm::work_of(&s[S_CODE..S_CODE + l]) > WORK_CAP { return Err(ProgramError::Custom(9002)); } }
            for i in 0..ns { let o = HDR + i * SLOT; if d[o + SL_OWNER..o + SL_OWNER + 32] == s[S_OWNER..S_OWNER + 32] && d[o + SL_ID..o + SL_ID + 8] == s[S_ID..S_ID + 8] { return Err(bad!()); } }
            let mint = pk(&d, A_MINT); let sid = d[A_SEASON..A_SEASON + 8].to_vec(); let fee = rd64(&d, A_FEE);
            let (pool, _) = Pubkey::find_program_address(&[b"pool", &sid], pid);
            if *oe.key != ata(owner.key, &mint) || *pe.key != ata(&pool, &mint) { return Err(bad!()); }
            if fee > 0 { token_transfer(oe, pe, owner, tp, fee, &[])?; let np = rd64(&d, A_POOL) + fee; wr64(&mut d, A_POOL, np); }
            let o = HDR + ns * SLOT; let len = u16::from_le_bytes([s[4], s[5]]) as usize;
            d[o..o + SLOT].fill(0); d[o + SL_OWNER..o + SL_OWNER + 32].copy_from_slice(&s[S_OWNER..S_OWNER + 32]); d[o + SL_ID..o + SL_ID + 8].copy_from_slice(&s[S_ID..S_ID + 8]); d[o + SL_LEN..o + SL_LEN + 2].copy_from_slice(&(len as u16).to_le_bytes());
            d[o + SL_CODE..o + SL_CODE + len].copy_from_slice(&s[S_CODE..S_CODE + len]); d[A_NS] += 1; Ok(())
        }
        // 7 Lock (TEE): [authority(s), arena(w)]
        7 => { let (auth, arena) = (next_account_info(it)?, next_account_info(it)?); check_arena(arena, pid)?; let mut d = arena.data.borrow_mut();
            if !auth.is_signer || &d[A_AUTH..A_AUTH + 32] != auth.key.as_ref() || d[A_NS] == 0 { return Err(bad!()); } d[A_FLAGS] |= F_LOCKED; Ok(()) }
        // 8 RequestSeed (permissionless after lock): [payer(s,w), arena(w), identity, queue(w), system, slot_hashes, vrf_program]
        8 => {
            let (payer, arena, identity, queue, sys, slots, vrf) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?;
            { let mut d = arena.data.borrow_mut(); if d[A_FLAGS] & F_LOCKED == 0 || d[A_FLAGS] & F_REQ != 0 { return Err(bad!()); } d[A_FLAGS] |= F_REQ; }
            let (idpda, bump) = Pubkey::find_program_address(&[b"identity"], pid); if idpda != *identity.key { return Err(bad!()); }
            let params = RequestRandomnessParams { payer: payer.key.compat(), oracle_queue: queue.key.compat(), callback_program_id: pid.compat(), callback_discriminator: CB_DISC.to_vec(), caller_seed: [7u8; 32],
                accounts_metas: Some(vec![ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta { pubkey: arena.key.compat(), is_signer: false, is_writable: true }]), callback_args: None };
            let ix = create_request_randomness_ix_const(params, idpda.compat()).modern();
            invoke_signed(&ix, &[payer.clone(), identity.clone(), queue.clone(), sys.clone(), slots.clone(), vrf.clone()], &[&[b"identity", &[bump]]])
        }
        // 9 Advance (permissionless, clock-gated, idempotent): [arena(w)]; data: max_ticks u16
        9 => { let arena = next_account_info(it)?; check_arena(arena, pid)?; advance(arena, u16::from_le_bytes([rest[0], rest[1]]) as u64) }
        // 10 Settle (permissionless): [crank(s), arena(w), pool_pda, pool_eata(w), token_program, winner_eatas(w)...]
        10 => {
            let (_crank, arena, pool, pe, tp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; let mut d = arena.data.borrow_mut();
            if d[A_FLAGS] & F_DONE == 0 || d[A_FLAGS] & F_SETTLED != 0 { return Err(bad!()); }
            let ns = d[A_NS] as usize; let fin = d[A_F2] & F2_FINALS != 0; let mint = pk(&d, A_MINT);
            let sid = if fin { d[A_PARENT..A_PARENT + 8].to_vec() } else { d[A_SEASON..A_SEASON + 8].to_vec() }; // finals pay out of the PARENT season's pool PDA
            let mut order: Vec<usize> = (0..ns).collect();
            if fin { order.sort_by(|a, b| { let (oa, ob) = (HDR + a * SLOT, HDR + b * SLOT); u16::from_le_bytes([d[ob + SL_WINS], d[ob + SL_WINS + 1]]).cmp(&u16::from_le_bytes([d[oa + SL_WINS], d[oa + SL_WINS + 1]])).then(rdi64(&d, ob + SL_TOTAL).cmp(&rdi64(&d, oa + SL_TOTAL))).then(a.cmp(b)) }); }
            else { order.sort_by(|a, b| rdi64(&d, HDR + b * SLOT + SL_TOTAL).cmp(&rdi64(&d, HDR + a * SLOT + SL_TOTAL)).then(a.cmp(b))); }
            for (rank, &i) in order.iter().enumerate() { wr32(&mut d, HDR + i * SLOT + SL_RANK, rank as u32 + 1); }
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
        // 11 Publish (permissionless after settle): [crank(s), arena, strat(w), reg(w)]; data: slot u8. coarse rank + score to owner's sealed record and public track record
        11 => {
            let (_c, arena, strat, reg) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; let mut d = arena.data.borrow_mut(); if d[A_FLAGS] & F_SETTLED == 0 { return Err(bad!()); }
            let i = rest[0] as usize; if i >= d[A_NS] as usize { return Err(bad!()); } let o = HDR + i * SLOT; let owner = pk(&d, o + SL_OWNER); let id = &d[o + SL_ID..o + SL_ID + 8];
            if strat.owner != pid || reg.owner != pid || Pubkey::find_program_address(&[b"strat", owner.as_ref(), id], pid).0 != *strat.key || Pubkey::find_program_address(&[b"reg", owner.as_ref(), id], pid).0 != *reg.key { return Err(bad!()); }
            let (rank, total, ns, season) = (rd32(&d, o + SL_RANK), rdi64(&d, o + SL_TOTAL), d[A_NS] as u32, rd64(&d, A_SEASON)); let sab = world::season_words(&d[A_SEED..A_SEED + 32].try_into().unwrap());
            { let mut s = strat.data.borrow_mut(); if rd64(&s, S_LSEASON) == season + 1 { return Err(bad!()); } wr64(&mut s, S_LSEASON, season + 1); wr32(&mut s, S_LRANK, rank); wr32(&mut s, S_LN, ns); s[S_LPNL..S_LPNL + 8].copy_from_slice(&total.to_le_bytes()); }
            let fin = d[A_F2] & F2_FINALS != 0; if !fin { let mut r = reg.data.borrow_mut(); let (se, en, b, t) = (rd32(&r, R_SEASONS) + 1, rd32(&r, R_ENTRIES) + 1, rd32(&r, R_BEST).min(rank), rdi64(&r, R_TOTAL) + total); wr32(&mut r, R_SEASONS, se); wr32(&mut r, R_ENTRIES, en); wr32(&mut r, R_BEST, b);
              r[R_TOTAL..R_TOTAL + 8].copy_from_slice(&t.to_le_bytes()); wr64(&mut r, R_LSEASON, season); wr32(&mut r, R_LRANK, rank); wr64(&mut r, R_SEEDAB, sab.0); wr64(&mut r, R_SEEDAB + 8, sab.1); }
            if fin { let mut r = reg.data.borrow_mut(); wr64(&mut r, R_SEEDAB, sab.0); wr64(&mut r, R_SEEDAB + 8, sab.1); } // finals reveal their (fresh) seed words too
            d[A_PUBN] += 1; Ok(())
        }
        // 12 Commit (TEE): [payer(s,w), magic, magic_ctx, accounts(w)...]  commits delegated registries to base
        12 => { let (payer, magic, ctx) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?); let regs: Vec<AccountInfo> = it.cloned().collect();
            MagicIntentBundleBuilder::new(payer.clone(), ctx.clone(), magic.clone()).commit(&regs).build_and_invoke() }
        // 13 InitPool (base): [payer(s,w), eata(w), pool_pda, mint, system, espl, buffer(w), record(w), metadata(w), dlp, validator]; data: season u64
        13 => {
            let (payer, ea, pool, mint, sys, espl) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let (buf, rec, meta, dlp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?); let validator = next_account_info(it)?;
            let (pata, atp, tkp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if Pubkey::find_program_address(&[b"pool", &rest[0..8]], pid).0 != *pool.key || *ea.key != espl_eata(pool.key, mint.key) || !payer.is_signer { return Err(bad!()); }
            // ordering fix: the pool's base ATA must exist BEFORE its eATA is delegated (the ER token account is derived from it); creating it here makes pool setup atomic
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
            let (crank, parent, hub, fin, perm, vault, magic, pp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if !crank.is_signer { return Err(ProgramError::MissingRequiredSignature); } check_arena(parent, pid)?;
            let fsid = &rest[0..8]; let neps = u32::from_le_bytes(rest[9..13].try_into().unwrap()); let spt = u32::from_le_bytes(rest[13..17].try_into().unwrap()); if neps == 0 || neps % 2 == 0 { return Err(bad!()); }
            let (ns, k) = { let d = parent.data.borrow(); if d[A_FLAGS] & F_SETTLED == 0 || d[A_F2] & F2_HASFIN == 0 || d[A_F2] & F2_FINSTARTED != 0 { return Err(bad!()); } let ns = d[A_NS] as usize; (ns, (rest[8] as usize).min(ns).max(1)) };
            let _ = ns; let (ap, abump) = Pubkey::find_program_address(&[b"arena", fsid], pid); if ap != *fin.key { return Err(bad!()); }
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let hs: &[&[u8]] = &[b"hub", &[hbump]]; let asd: &[&[u8]] = &[b"arena", fsid, &[abump]];
            EphemeralAccount::new(hub, fin, vault).with_signer_seeds(&[hs, asd]).create(arena_size(k) as u32)?;
            { let mut p = parent.data.borrow_mut(); let mut d = fin.data.borrow_mut();
              d[0..4].copy_from_slice(&M_ARENA.to_le_bytes()); d[A_MAXS] = k as u8; d[A_NS] = k as u8; d[A_AUTH..A_AUTH + 32].copy_from_slice(&p[A_AUTH..A_AUTH + 32]); d[A_SEASON..A_SEASON + 8].copy_from_slice(fsid);
              wr32(&mut d, A_NEPS, neps); wr32(&mut d, A_SPT, spt); d[A_MINT..A_MINT + 32].copy_from_slice(&p[A_MINT..A_MINT + 32]); d[A_BUMP] = abump; d[A_FLAGS] = F_LOCKED; d[A_F2] = F2_FINALS;
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
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn advance(arena: &AccountInfo, max: u64) -> ProgramResult {
    let mut d = arena.data.borrow_mut();
    if d[A_FLAGS] & F_SEEDED == 0 || d[A_FLAGS] & F_DONE != 0 { return Err(bad!()); }
    let slot = Clock::get()?.slot; let start = rd64(&d, A_START); let spt = (rd32(&d, A_SPT) as u64).max(1);
    let neps = rd32(&d, A_NEPS); let mut cur_ep = rd32(&d, A_CUREP); let mut cur_tick = rd32(&d, A_CURTICK) as usize;
    let done_g = cur_ep as u64 * world::WORLD_T as u64 + cur_tick as u64; let due = slot.saturating_sub(start) / spt;
    if due <= done_g { return Ok(()); }
    let n = (due - done_g).min(max);
    let ns = d[A_NS] as usize; let seed: [u8; 32] = d[A_SEED..A_SEED + 32].try_into().unwrap(); let (sa, sb) = world::season_words(&seed);
    let mut market = Market::load(&d[A_MKT..A_MKT + Market::BYTES]);
    let mut seats: Vec<Seat> = (0..ns).map(|i| Seat::load(&d[HDR + i * SLOT + SL_SEAT..HDR + i * SLOT + SL_SEAT + Seat::BYTES])).collect();
    let mut ran = 0u64; let mut finished = false; let mut totals: Vec<i64> = (0..ns).map(|i| rdi64(&d, HDR + i * SLOT + SL_TOTAL)).collect();
    while ran < n && !finished {
        if cur_tick == 0 {
            let es = world::episode_seed(sa, sb, cur_ep as u64); let mut r = [0i32; world::WORLD_T]; world::gen_episode(world::pack_for(es), es, &mut r);
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
    check_arena(arena, pid)?; let mut d = arena.data.borrow_mut();
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
