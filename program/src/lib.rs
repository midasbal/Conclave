//! Conclave: sealed-strategy league (ruleset v2).
//! Register (base, public, salted commitment) -> Seal (TEE, private from its first instant) -> season arena (ER-only ephemeral, never committed)
//! -> Enter + Lock -> VRF seed -> permissionless, clock-gated, self-metering Advance (conclave-vm + generator, in the enclave)
//! -> (optional finals phase: top 3 by season rank, fresh VRF seed, 15 episodes) -> Settle (final ranks, RECORD what each entry is owed, write the season receipt)
//! -> Claim (anyone, one entry, pays the owner's token account once) -> Publish (coarse rank to the owner, score commitments to the receipt) -> Commit.
//! Every wait has a program-calculated deadline and a permissionless exit (program/LIFECYCLE.md).
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
/// VRF callback discriminators, one per phase, so a season-phase answer can never be accepted as the finals seed
const CB_DISC: [u8; 8] = [200, 1, 2, 3, 4, 5, 6, 7];
const CB_DISC_FINALS: [u8; 8] = [200, 1, 2, 3, 4, 5, 6, 8];
/// the only randomness queue the program will use (MagicBlock's default ephemeral queue). Anything else is refused (9110).
pub const VRF_QUEUE: Pubkey = solana_program::pubkey!("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const UNDELEGATE_DISC: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];
const ESPL: Pubkey = solana_program::pubkey!("SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2");
const UPGRADEABLE_LOADER: Pubkey = solana_program::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
const TOKEN: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATOKEN: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/// domain separation for the two hash commitments
const DOM_CODE: &[u8] = b"CNCL-CODE-v1";
const DOM_SCORE: &[u8] = b"CNCL-SCORE-v3";
/// the score commitment is keyed by a salt DERIVED from the sealed salt for one season, so an owner can prove a season's totals without giving away the salt behind the code commitment
const DOM_SCORE_SALT: &[u8] = b"CNCL-SSALT-v1";
/// the public terms of a season (fee, token, length, timing, field size, ruleset, creator) are committed to by one hash, which an entrant gives to Enter
const DOM_TERMS: &[u8] = b"CNCL-TERMS-v1";

// ---- layouts ----
/// arena generation 4 ("ARN4"; same bytes as 3, but every arena of this generation has a roster): an arena written by an older build is refused outright instead of being misread
pub const M_ARENA: u32 = 0x344E_5241; pub const M_CLAIMS: u32 = 0x534D_4C43;
 pub const M_STRAT: u32 = 0x5354_5254; pub const M_REG: u32 = 0x5245_4753; pub const M_HUB: u32 = 0x4855_4221; pub const M_RCPT: u32 = 0x5443_5052;
// config (PDA ["config"], delegated to the rollup so pause and allowlist changes act on the very next transaction): 0 magic | 4 paused u8 | 5 mint count u8 | 8 authority[32] | 64 allowed mints[8 x 32]
pub const M_CFG: u32 = 0x4746_4E43; pub const C_PAUSED: usize = 4; pub const C_NMINTS: usize = 5; pub const C_AUTH: usize = 8; pub const C_MINTS: usize = 64; pub const MAX_MINTS: usize = 8; pub const CFG_SIZE: usize = C_MINTS + MAX_MINTS * 32;
pub const CODE_MAX: usize = 4 + 4 * MAX_OPS;
// strategy (ephemeral, sealed, PDA ["strat", id]): 0 magic | 4 len u16 | 6 open entries u16 | 8 owner | 40 id | 48 commitment | 80 last_season+1 | 88 last_rank u32 | 92 last_n u32 | 96 last_pnl i64 | 104 salt[32] | 136 code
/// how many live arena slots still hold this strategy (entered, not yet published and not yet released). While it is not zero the strategy cannot be closed.
/// These two bytes were never written by an earlier build, so every older strategy reads zero.
pub const S_OPEN: usize = 6;
/// The same two bytes carry the PAYER FLAG in their top bit: set (0x8000) on a strategy whose sealed account and permission were paid for by its own registry (this build's Seal), so CloseStrategy hands the rent back
/// to the registry. A strategy sealed by an earlier build never had that bit (its count was at most a few), so it reads as paid by the hub and is refunded to the hub. The count is the low 15 bits.
pub const S_PAYER_REG: u16 = 0x8000; pub const S_OPEN_MASK: u16 = 0x7FFF;
pub const S_OWNER: usize = 8; pub const S_ID: usize = 40; pub const S_COMMIT: usize = 48; pub const S_LSEASON: usize = 80; pub const S_LRANK: usize = 88; pub const S_LN: usize = 92; pub const S_LPNL: usize = 96; pub const S_SALT: usize = 104; pub const S_CODE: usize = 136;
/// the size every sealed strategy has had since ruleset 2; accounts of this size remain valid
pub const STRAT_MIN_SIZE: usize = S_CODE + CODE_MAX;
/// new seals carry 8 more bytes: the owner's private finals total (appended, so no existing offset moves)
pub const S_LFINALS: usize = STRAT_MIN_SIZE; pub const STRAT_SIZE: usize = STRAT_MIN_SIZE + 8;
// registry (public, PDA ["reg", id]): 0 magic | 8 owner | 40 id | 48 commitment = sha256(DOM_CODE, salt, code) | 80 seasons u32 | 84 best_rank u32 | 88 total_pnl i64 | 96 last_season u64 | 104 last_rank u32 | 108 entries u32
pub const R_OWNER: usize = 8; pub const R_ID: usize = 40; pub const R_COMMIT: usize = 48; pub const R_SEASONS: usize = 80; pub const R_BEST: usize = 84; pub const R_TOTAL: usize = 88; pub const R_LSEASON: usize = 96; pub const R_LRANK: usize = 104; pub const R_ENTRIES: usize = 108;
pub const REG_SIZE: usize = 128;
/// a registry whose owner closed the strategy: no instruction that reads a registry accepts it; it only waits to be undelegated and removed on base
pub const M_REG_CLOSED: u32 = 0x5845_4752;
/// what is left of a removed registry, forever: the address stays taken, so its id can never be registered again. 0 magic | 4 zero
pub const M_REG_DEAD: u32 = 0x4447_4552; pub const MARKER_SIZE: usize = 8;
// season roster (ephemeral, PRIVATE with no members, PDA ["roster", season]): 0 magic | 4 capacity u8 | 8 season u64 | 16 + 32 * slot: the code commitment of the entry in that arena slot, copied from its sealed account at Enter
pub const M_ROSTER: u32 = 0x5453_4F52; pub const RO_CAP: usize = 4; pub const RO_SEASON: usize = 8; pub const RO_HDR: usize = 16; pub const RO_ESZ: usize = 32;
pub const fn roster_size(cap: usize) -> usize { RO_HDR + cap * RO_ESZ }
// season receipt (base, delegated while the season runs, committed at the end, PDA ["receipt", season]). Header is 224 bytes, entries are 80 bytes.
pub const RC_KIND: usize = 4; pub const RC_NS: usize = 5; pub const RC_PUB: usize = 6; pub const RC_DIV: usize = 7; pub const RC_SEASON: usize = 8; pub const RC_RULESET: usize = 24; pub const RC_VERSION: usize = 26; pub const RC_GEN: usize = 27;
pub const RC_PACKS: usize = 28; pub const RC_NEPS: usize = 32; pub const RC_SEEDA: usize = 40; pub const RC_SEEDB: usize = 48; pub const RC_PINS: usize = 56; pub const RC_ENT: usize = 224; pub const RC_ESZ: usize = 80;
// finals and money summary: 192 finals seed a | 200 finals seed b | 208 finals packs[2] | 210 finals status u8 (0 season without finals, 1 played, 2 voided) | 211 qualifiers u8 | 212 finals episodes u32 | 216 owed total u64
pub const RC_FSEEDA: usize = 192; pub const RC_FSEEDB: usize = 200; pub const RC_FPACKS: usize = 208; pub const RC_FSTATUS: usize = 210; pub const RC_FQUAL: usize = 211; pub const RC_FNEPS: usize = 212; pub const RC_OWED: usize = 216;
pub const FS_NONE: u8 = 0; pub const FS_PLAYED: u8 = 1; pub const FS_VOIDED: u8 = 2;
// money records on the receipt: 104 creator[32] | 136 bond u64 (lamports held above rent, posted at InitReceipt) | 144 state u8 (0 fresh, 1 season opened, 2 closed) | 145 reason u8 | 152 refunded u64 (fees recorded as refunds by Cancel) | 160 hub rent drawn | 168 hub rent reclaimed | 176 bond forfeited to the hub | 184 bond releasable to the creator
pub const RC_CREATOR: usize = 104; pub const RC_BOND: usize = 136; pub const RC_STATE: usize = 144; pub const RC_REASON: usize = 145; pub const RC_REFUNDED: usize = 152; pub const RC_RENT: usize = 160; pub const RC_RECLAIMED: usize = 168; pub const RC_FORFEIT: usize = 176; pub const RC_RELEASE: usize = 184;
// entry: 0 id u64 | 8 code commitment | 40 score commitment | 72 final rank u32 | 76 season rank u16 | 78 published u8 (the per-season publish guard) | 79 played the finals u8
pub const RE_FRANK: usize = 72; pub const RE_SRANK: usize = 76; pub const RE_PUBLISHED: usize = 78; pub const RE_FINALIST: usize = 79;
/// receipt format 3: the format byte is set at InitReceipt (earlier builds never wrote byte 146, so their receipts read 0), and each entry's OWNER follows the entry table
pub const RC_FORMAT: usize = 146; pub const RECEIPT_FORMAT: u8 = 3; pub const RC_OWNERS: usize = RC_ENT + 20 * RC_ESZ;
pub const RC_SIZE: usize = RC_OWNERS + 20 * 32;
/// receipts written by the previous build are this long. The money fields (104..192) did not move, so the bond paths still serve them.
pub const RC_MONEY_SIZE: usize = 192 + 20 * 80;
// arena header
pub const A_FLAGS: usize = 4; pub const A_NS: usize = 5; pub const A_MAXS: usize = 6; pub const A_AUTH: usize = 8; pub const A_SEASON: usize = 40; pub const A_SEED: usize = 48; pub const A_NEPS: usize = 80; pub const A_SPT: usize = 84;
pub const A_CUREP: usize = 88; pub const A_CURTICK: usize = 92; pub const A_START: usize = 96; pub const A_FEE: usize = 104; pub const A_POOL: usize = 112; pub const A_MINT: usize = 120; pub const A_TICKS: usize = 152; pub const A_BUMP: usize = 156;
pub const A_MKT: usize = 160; pub const A_RET: usize = A_MKT + 352;
// finals seed (32 bytes) | flags2 | published count
pub const A_FSEED: usize = 1112; pub const A_F2: usize = 1144; pub const A_PUBN: usize = 1145;
pub const A_PINS: usize = 1152; pub const A_DIV: usize = 1200; pub const HDR: usize = 1280;
// season clock and money guards: 1208 created slot | 1216 entry window (slots) | 1224 seed timeout after lock | 1232 lock slot | 1240 settle slot | 1248 publish grace | 1256 hub rent drawn at creation | 1264 min entrants | 1265 cancel reason
/// slot at which the season phase finished (starts the finals seed clock)
pub const A_SDONEAT: usize = 1272;
pub const A_CREATED: usize = 1208; pub const A_WINDOW: usize = 1216; pub const A_SEEDTO: usize = 1224; pub const A_LOCKAT: usize = 1232; pub const A_SETTLEDAT: usize = 1240; pub const A_PUBGRACE: usize = 1248; pub const A_RENT: usize = 1256; pub const A_MINS: usize = 1264; pub const A_REASON: usize = 1265;
/// arena flags2: finals enabled at creation | cancelled | refunds recorded in the claims account | finals voided because fewer than two qualified
pub const F2_HASFIN: u8 = 2; pub const F2_CANCELLED: u8 = 8; pub const F2_REFUNDED: u8 = 16; pub const F2_THINFIELD: u8 = 32;
pub const REASON_UNDERMIN: u8 = 1; pub const REASON_SEEDTO: u8 = 2; pub const REASON_CREATOR: u8 = 3; pub const REASON_FINALS_SEEDTO: u8 = 4; pub const REASON_FINALS_DEADLINE: u8 = 5; pub const REASON_FINALS_FIELD: u8 = 6; pub const REASON_DEADLINE: u8 = 7;
/// creation bond in lamports (held in the season receipt): refunded to the creator at cleanup, 25% forfeited to the hub when the creator abandons the season
pub const BOND_MIN: u64 = 1_000_000; pub const FORFEIT_PCT: u64 = 25; /// longest publish grace. It delays only the arena cleanup (hub rent and the creator's own bond), never an entrant's money
pub const MAX_GRACE: u64 = 200_000_000;
/// shortest publish grace: about 29 minutes at the about 103.5 slots a second observed on devnet. A full 20-entry field can be published one transaction at a time many times over inside it, with room for a client or the rollup
/// being unavailable for some minutes. Without a floor a creator could settle and clean up almost at once and drop results from the record.
pub const MIN_GRACE: u64 = 180_000;
/// longest entry window: how long paid buy-ins can wait before ANYONE may lock the season (about 2.8 days at the 103.5 slots/s observed on devnet)
pub const MAX_ENTRY_WINDOW: u64 = 25_000_000;
// slot: 0 owner | 32 id u64 | 40 len u16 | 42 season rank u8 (frozen when the season phase ends) | 43 bits u8 | 44 final rank u32 | 48 season total i64 | 56 finals total i64 | 64 seat(112) | 176 code(260)
pub const SL_OWNER: usize = 0; pub const SL_ID: usize = 32; pub const SL_LEN: usize = 40; pub const SL_SRANK: usize = 42; pub const SL_BITS: usize = 43; pub const SL_RANK: usize = 44; pub const SL_TOTAL: usize = 48; pub const SL_FTOTAL: usize = 56; pub const B_FINALIST: u8 = 1; pub const B_PUBLISHED: u8 = 2; /** this slot holds one unit of its strategy's open-entry count: set by Enter, cleared by whichever of Publish, Cancel or Cleanup releases it. Slots written by an earlier build never carry it, so they never decrement anything */ pub const B_COUNTED: u8 = 4; pub const SL_SEAT: usize = 64; pub const SL_CODE: usize = 176; pub const SLOT: usize = 440;
pub const MAX_SLOTS: usize = 20;
// ---- season bounds (fixed at CreateSeason) ----
/// season length in episodes
pub const MAX_EPISODES: u32 = 100;
/// rollup slots per VM tick (the clock gate's pace)
pub const MAX_SPT: u32 = 100;
/// the paced length of the whole season, BOTH phases (season episodes, plus the finals episodes when finals are on) x 150 ticks x slots per tick, may not exceed this (about 2 hours at the 103.5 slots/s observed on devnet)
pub const MAX_RUN_SLOTS: u64 = 720_000;
/// the creator's season seed timeout may not exceed this
pub const MAX_SEEDTO: u64 = 1_000_000;
// ---- finals format: fixed by the program, chosen by nobody ----
pub const FINALS_EPISODES: u32 = 15; pub const FINALS_QUALIFIERS: usize = 3;
/// with finals on, the season must carry at least as much weight as the finals
pub const MIN_EPISODES_WITH_FINALS: u32 = FINALS_EPISODES;
/// slots after the season phase ends in which the finals seed must arrive, or the finals are void
pub const FINALS_SEEDTO: u64 = 360_000;
// ---- deadlines: phase start + paced run + fixed slack + slack per tick ----
pub const SLACK_BASE: u64 = 360_000;
/// four times the ~10 slots per tick one sequential cranker needs in the worst case (20 seats at the work cap: 7.9 ticks per Advance, about 78 slots per Advance)
pub const SLACK_PER_TICK: u64 = 40;
/// the slot at which a running phase expires. From it on, Advance is refused: the season is refundable, or the finals are void
pub fn phase_deadline(start: u64, episodes: u32, spt: u32) -> u64 { let ticks = u64::from(episodes).saturating_mul(world::WORLD_T as u64); start.saturating_add(ticks.saturating_mul(u64::from(spt.max(1)))).saturating_add(SLACK_BASE).saturating_add(ticks.saturating_mul(SLACK_PER_TICK)) }
// arena flags. Season phase: REQ, SEEDED, then SDONE (ranks frozen). Finals phase: FREQ, FSEEDED. DONE: nothing left to run. SETTLED: amounts owed are recorded.
pub const F_LOCKED: u8 = 1; pub const F_REQ: u8 = 2; pub const F_SEEDED: u8 = 4; pub const F_DONE: u8 = 8; pub const F_SETTLED: u8 = 16; pub const F_SDONE: u8 = 32; pub const F_FREQ: u8 = 64; pub const F_FSEEDED: u8 = 128;
// ---- claims account (ephemeral, public, PDA ["claims", season], rent from the hub): what each entry is owed and whether it has been paid ----
// 0 magic | 4 state u8 (0 nothing recorded, 1 recorded) | 5 entries u8 | 6 capacity u8 | 7 kind u8 (1 payout, 2 refund) | 8 season u64 | 16 mint[32] | 48 owed total u64 | 56 claimed total u64 | 64 hub rent drawn u64
pub const CL_STATE: usize = 4; pub const CL_N: usize = 5; pub const CL_CAP: usize = 6; pub const CL_KIND: usize = 7; pub const CL_SEASON: usize = 8; pub const CL_MINT: usize = 16; pub const CL_OWED: usize = 48; pub const CL_CLAIMED: usize = 56; pub const CL_RENT: usize = 64; pub const CL_HDR: usize = 72;
// claims entry (slot order): 0 owner[32] | 32 owed u64 | 40 done u8 (paid, or nothing owed)
pub const CE_OWNER: usize = 0; pub const CE_OWED: usize = 32; pub const CE_DONE: usize = 40; pub const CE_SIZE: usize = 48;
pub const CLAIMS_PAYOUT: u8 = 1; pub const CLAIMS_REFUND: u8 = 2;
pub const fn claims_size(cap: usize) -> usize { CL_HDR + cap * CE_SIZE }
// ---- terms record (ephemeral, public, PDA ["terms", season], rent from the hub): the season's terms as CreateSeason fixed them, readable by anyone before they pay ----
// 0 magic | 4 version u8 (1) | 8 season u64 | 16 creator[32] | 48 mint[32] | 80 fee u64 | 88 episodes u32 | 92 slots per tick u32 | 96 entry window u64 | 104 seed timeout u64 | 112 publish grace u64
// | 120 seats u8 | 121 minimum entrants u8 | 122 flags u8 (finals bit) | 123 division u8 | 128 ruleset pins[PINS_LEN] | then hub rent drawn u64 (not part of the hash)
pub const M_TERMS: u32 = 0x4D52_4554; pub const TM_VERSION: usize = 4; pub const TM_SEASON: usize = 8; pub const TM_CREATOR: usize = 16; pub const TM_MINT: usize = 48; pub const TM_FEE: usize = 80; pub const TM_NEPS: usize = 88; pub const TM_SPT: usize = 92;
pub const TM_WINDOW: usize = 96; pub const TM_SEEDTO: usize = 104; pub const TM_GRACE: usize = 112; pub const TM_MAXS: usize = 120; pub const TM_MINS: usize = 121; pub const TM_FLAGS: usize = 122; pub const TM_DIV: usize = 123; pub const TM_PINS: usize = 128;
pub const TM_RENT: usize = TM_PINS + PINS_LEN; pub const TERMS_SIZE: usize = TM_RENT + 8; pub const TERMS_VERSION: u8 = 1;
/// what Enter's instruction data carries: the fee, the stake mint and the hash of the terms the entrant read
pub const ENTER_DATA: usize = 8 + 32 + 32;
// ---- error codes (fixed; documented in LIFECYCLE.md) ----
pub const E_NOT_RECORDED: u32 = 9080; pub const E_CLAIM_SLOT: u32 = 9081; pub const E_CLAIMS_ACCT: u32 = 9082; pub const E_OUTSTANDING: u32 = 9083; pub const E_CLAIM_DEST: u32 = 9084; pub const E_RECORDED: u32 = 9085;
pub const E_EPISODES: u32 = 9100; pub const E_SPT: u32 = 9101; pub const E_RUN_TOO_LONG: u32 = 9102; pub const E_SEASON_FLAGS: u32 = 9103; pub const E_SHORT_SEASON_FOR_FINALS: u32 = 9104; pub const E_GRACE_TOO_SHORT: u32 = 9105;
pub const E_QUEUE: u32 = 9110; pub const E_SEED_STATE: u32 = 9111; pub const E_SEED_LATE: u32 = 9112; pub const E_DEADLINE: u32 = 9113; pub const E_NOT_RUNNING: u32 = 9114; pub const E_NOT_SETTLEABLE: u32 = 9115; pub const E_SETTLE_STATE: u32 = 9116;
pub const E_STRAT_OPEN: u32 = 9130; pub const E_ENTRY_HELD: u32 = 9131; pub const E_REG_NOT_CLOSED: u32 = 9132;
pub const E_ENTRY_REGISTRY: u32 = 9133; pub const E_REG_RENT: u32 = 9134; pub const E_TERMS_ACCT: u32 = 9150; pub const E_TERMS_MISMATCH: u32 = 9151; pub const E_ROSTER: u32 = 9142; pub const E_DELEGATE_RECEIPT: u32 = 9140; pub const E_CLEANUP_RECEIPT: u32 = 9141;
pub const E_PUBLISHED: u32 = 9120; pub const E_PUBLISH_EARLY: u32 = 9121; pub const E_CLEANUP_STATE: u32 = 9122; pub const E_CLEANUP_UNPUBLISHED: u32 = 9123;
fn fail<T>(code: u32) -> Result<T, ProgramError> { Err(ProgramError::Custom(code)) }
pub fn arena_size(maxs: usize) -> usize { HDR + maxs * SLOT }
// compile-time layout guarantees the VM relies on: Market::load/Seat::load/save index fixed-size slices, so these regions must be large enough (a violation would be a build error, not a runtime abort)
const _: () = assert!(SL_SEAT + Seat::BYTES <= SL_CODE && A_MKT + Market::BYTES <= A_RET && A_RET + 4 * world::WORLD_T <= A_FSEED && A_FSEED + 32 <= A_F2 && A_PUBN < A_PINS && A_SDONEAT + 8 <= HDR && A_REASON < A_SDONEAT && SL_CODE + CODE_MAX <= SLOT && A_PINS + PINS_LEN <= A_DIV && HDR == 1280 && S_OPEN + 2 <= S_OWNER && HDR + MAX_SLOTS * SLOT <= 10_240 && A_DIV < A_CREATED && A_REASON < HDR && RC_RELEASE + 8 <= RC_FSEEDA && RC_OWED + 8 <= RC_ENT && RC_PINS + PINS_LEN <= RC_CREATOR && RE_FINALIST < RC_ESZ && RC_MONEY_SIZE <= RC_SIZE && RC_RELEASE + 8 <= RC_FSEEDA && RC_FORMAT < RC_REFUNDED && RC_STATE < RC_FORMAT && RC_REASON < RC_FORMAT && RC_SIZE <= 10_240 && roster_size(MAX_SLOTS) <= 10_240 && claims_size(MAX_SLOTS) <= 10_240);
// metering model (compute units), calibrated on SBF: per tick TICK_BASE + sum over seats (SEAT_BASE + SEAT_PER_WORK * work), times SAFETY_PCT; episode start adds GEN_COST; each call adds a load/save tail
const GEN_COST: u64 = 330_000; const TAIL_BASE: u64 = 15_000; const TAIL_PER_SEAT: u64 = 2_200; const TICK_BASE: u64 = 4_600; const SEAT_BASE: u64 = 700; const SEAT_PER_WORK: u64 = 90; const SAFETY_PCT: u64 = 115;

fn rd64(d: &[u8], o: usize) -> u64 { o.checked_add(8).and_then(|e| d.get(o..e)).and_then(|x| <[u8; 8]>::try_from(x).ok()).map(u64::from_le_bytes).unwrap_or(0) }
fn wr64(d: &mut [u8], o: usize, v: u64) { if let Some(x) = o.checked_add(8).and_then(|e| d.get_mut(o..e)) { x.copy_from_slice(&v.to_le_bytes()); } }
fn rd32(d: &[u8], o: usize) -> u32 { o.checked_add(4).and_then(|e| d.get(o..e)).and_then(|x| <[u8; 4]>::try_from(x).ok()).map(u32::from_le_bytes).unwrap_or(0) }
fn wr32(d: &mut [u8], o: usize, v: u32) { if let Some(x) = o.checked_add(4).and_then(|e| d.get_mut(o..e)) { x.copy_from_slice(&v.to_le_bytes()); } }
fn rdi64(d: &[u8], o: usize) -> i64 { rd64(d, o) as i64 }
fn pk(d: &[u8], o: usize) -> Pubkey { let mut b = [0u8; 32]; if let Some(x) = o.checked_add(32).and_then(|e| d.get(o..e)) { b.copy_from_slice(x); } Pubkey::new_from_array(b) }
/// instruction-data readers: an error, never an out-of-range index
fn arr<const N: usize>(d: &[u8], o: usize) -> Result<[u8; N], ProgramError> { o.checked_add(N).and_then(|e| d.get(o..e)).and_then(|x| <[u8; N]>::try_from(x).ok()).ok_or(ProgramError::InvalidInstructionData) }
fn ru32(d: &[u8], o: usize) -> Result<u32, ProgramError> { arr::<4>(d, o).map(u32::from_le_bytes) }
fn ru64(d: &[u8], o: usize) -> Result<u64, ProgramError> { arr::<8>(d, o).map(u64::from_le_bytes) }
macro_rules! bad { () => { ProgramError::Custom(line!()) }; }
fn owner_member(owner: &Pubkey) -> Vec<Member> { vec![Member { flags: TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG, pubkey: owner.compat() }] }
/// distinct, documented error codes for the ruleset gates
fn vm_err(e: VmError) -> ProgramError { match e { VmError::OverWorkCap => ProgramError::Custom(9001), VmError::Version => ProgramError::Custom(9003), _ => ProgramError::Custom(9004) } }
/// every account the program touches is validated for owner, magic AND full length before any fixed offset is read or written, so the offsets below cannot go out of range
fn check_arena(a: &AccountInfo, pid: &Pubkey) -> ProgramResult {
    if a.owner != pid || a.try_data_len()? < HDR { return Err(ProgramError::InvalidAccountData); }
    let d = a.try_borrow_data()?; let (maxs, ns) = (usize::from(d[A_MAXS]), usize::from(d[A_NS]));
    if rd32(&d, 0) != M_ARENA || maxs == 0 || maxs > MAX_SLOTS || ns > maxs || d.len() < arena_size(maxs) || usize::from(d[A_DIV]) >= DIVISIONS.len() { return Err(ProgramError::InvalidAccountData); } Ok(()) }
/// the open-entry count (low 15 bits) and the payer flag (top bit) of a sealed account
fn open_raw(s: &[u8]) -> u16 { u16::from_le_bytes([s[S_OPEN], s[S_OPEN + 1]]) }
/// stores a new count and keeps the payer flag as it was; a count that would reach the flag bit is an overflow
fn set_open(s: &mut [u8], n: u16) -> ProgramResult { if n > S_OPEN_MASK { return Err(ProgramError::ArithmeticOverflow); } let raw = (open_raw(s) & S_PAYER_REG) | n; s[S_OPEN..S_OPEN + 2].copy_from_slice(&raw.to_le_bytes()); Ok(()) }
/// the hash an entrant commits to: everything in the terms record except its rent field
fn terms_hash(t: &[u8]) -> Result<[u8; 32], ProgramError> { Ok(hashv(&[DOM_TERMS, t.get(TM_VERSION..TM_RENT).ok_or(bad!())?]).to_bytes()) }
/// the terms record of `season`: the PDA, program-owned, the terms magic and version
fn check_terms(t: &AccountInfo, pid: &Pubkey, season: &[u8]) -> ProgramResult {
    if Pubkey::find_program_address(&[b"terms", season], pid).0 != *t.key || t.owner != pid || t.try_data_len()? < TERMS_SIZE { return fail(E_TERMS_ACCT); }
    let d = t.try_borrow_data()?; if rd32(&d, 0) != M_TERMS || d[TM_VERSION] != TERMS_VERSION || &d[TM_SEASON..TM_SEASON + 8] != season { return fail(E_TERMS_ACCT); } Ok(()) }
/// the terms record says exactly what the arena will do: every term it states is the arena's own
#[inline(never)]
fn terms_match_arena(t: &[u8], a: &[u8]) -> bool {
    pk(t, TM_CREATOR) == pk(a, A_AUTH) && pk(t, TM_MINT) == pk(a, A_MINT) && rd64(t, TM_FEE) == rd64(a, A_FEE) && rd32(t, TM_NEPS) == rd32(a, A_NEPS) && rd32(t, TM_SPT) == rd32(a, A_SPT)
        && rd64(t, TM_WINDOW) == rd64(a, A_WINDOW) && rd64(t, TM_SEEDTO) == rd64(a, A_SEEDTO) && rd64(t, TM_GRACE) == rd64(a, A_PUBGRACE) && t[TM_MAXS] == a[A_MAXS] && t[TM_MINS] == a[A_MINS]
        && t[TM_FLAGS] == a[A_F2] & F2_HASFIN && t[TM_DIV] == a[A_DIV] && t[TM_PINS..TM_PINS + PINS_LEN] == a[A_PINS..A_PINS + PINS_LEN] && t[TM_SEASON..TM_SEASON + 8] == a[A_SEASON..A_SEASON + 8] }
fn check_strat(a: &AccountInfo, pid: &Pubkey) -> ProgramResult { if a.owner != pid || a.try_data_len()? < STRAT_MIN_SIZE || rd32(&a.try_borrow_data()?, 0) != M_STRAT { return Err(ProgramError::InvalidAccountData); } Ok(()) }
fn check_reg(a: &AccountInfo, pid: &Pubkey) -> ProgramResult { if a.owner != pid || a.try_data_len()? < REG_SIZE || rd32(&a.try_borrow_data()?, 0) != M_REG { return Err(ProgramError::InvalidAccountData); } Ok(()) }
// the open-entry helpers and the two close instructions are never inlined: the dispatcher's stack frame is already large, and inlining them into it overflowed the 4 KiB SBF frame
/// gives back one slot's unit of its strategy's open-entry count. Does nothing for a slot that holds none, so no path can decrement twice or decrement for an entry an earlier build made.
/// The caller has already checked that `strat` is the strategy of slot `i`.
#[inline(never)]
fn release_entry(arena: &mut [u8], i: usize, strat: &AccountInfo) -> ProgramResult {
    let o = HDR + i * SLOT; if arena[o + SL_BITS] & B_COUNTED == 0 { return Ok(()); }
    { let mut s = strat.try_borrow_mut_data()?; let n = (open_raw(&s) & S_OPEN_MASK).checked_sub(1).ok_or(ProgramError::InvalidAccountData)?; set_open(&mut s, n)?; }
    arena[o + SL_BITS] &= !B_COUNTED; Ok(()) }
/// For an arena whose unpublished entries will never publish (cancelled, or being destroyed): each account named must be the strategy of one of its slots, and that slot is released
#[inline(never)]
fn release_named<'a, 'info: 'a>(arena: &mut [u8], pid: &Pubkey, strats: impl Iterator<Item = &'a AccountInfo<'info>>) -> ProgramResult {
    for strat in strats { check_strat(strat, pid)?; let id: [u8; 8] = arr::<8>(&strat.try_borrow_data()?, S_ID)?; if Pubkey::find_program_address(&[b"strat", &id], pid).0 != *strat.key { return Err(bad!()); }
        let i = (0..usize::from(arena[A_NS])).find(|&i| arena[HDR + i * SLOT + SL_ID..HDR + i * SLOT + SL_ID + 8] == id).ok_or(bad!())?; release_entry(arena, i, strat)?; }
    Ok(()) }
/// ruleset pinning: an arena only ever runs under the exact rules it was created under
fn check_pins(d: &[u8]) -> ProgramResult { if d[A_PINS..A_PINS + PINS_LEN] != pins_bytes() { return Err(ProgramError::Custom(9010)); } Ok(()) }
fn check_receipt(rc: &AccountInfo, pid: &Pubkey, season: &[u8]) -> ProgramResult {
    if rc.owner != pid || rc.try_data_len()? < RC_SIZE || rd32(&rc.try_borrow_data()?, 0) != M_RCPT || rc.try_borrow_data()?[RC_FORMAT] != RECEIPT_FORMAT || Pubkey::find_program_address(&[b"receipt", season], pid).0 != *rc.key { return Err(ProgramError::Custom(9020)); } Ok(())
}
/// the one config account: this program's PDA, magic and full size. Anything else is refused (9063)
fn check_config(c: &AccountInfo, pid: &Pubkey) -> ProgramResult { if c.owner != pid || c.try_data_len()? < CFG_SIZE || rd32(&c.try_borrow_data()?, 0) != M_CFG || Pubkey::find_program_address(&[b"config"], pid).0 != *c.key { return Err(ProgramError::Custom(9063)); } Ok(()) }
fn cfg_authority(c: &AccountInfo, who: &AccountInfo) -> ProgramResult { if !who.is_signer { return Err(ProgramError::MissingRequiredSignature); } if &c.try_borrow_data()?[C_AUTH..C_AUTH + 32] != who.key.as_ref() { return Err(ProgramError::Custom(9062)); } Ok(()) }
fn cfg_paused(c: &AccountInfo) -> Result<bool, ProgramError> { Ok(c.try_borrow_data()?[C_PAUSED] != 0) }
/// a season receipt the program can trust: owner, size, magic and the PDA of this exact season
fn rcpt_ok(rc: &AccountInfo, pid: &Pubkey, season: &[u8]) -> bool { rc.owner == pid && rc.try_data_len().map(|l| l >= RC_SIZE).unwrap_or(false) && rc.try_borrow_data().map(|d| rd32(&d, 0) == M_RCPT && d[RC_FORMAT] == RECEIPT_FORMAT).unwrap_or(false) && Pubkey::find_program_address(&[b"receipt", season], pid).0 == *rc.key }
/// a receipt good enough for the bond paths only: the money fields sit at the same offsets in the previous build's shorter receipts, so no bond is stranded by the upgrade
fn rcpt_money_ok(rc: &AccountInfo, pid: &Pubkey, season: &[u8]) -> bool { rc.owner == pid && rc.try_data_len().map(|l| l >= RC_MONEY_SIZE).unwrap_or(false) && rc.try_borrow_data().map(|d| rd32(&d, 0) == M_RCPT).unwrap_or(false) && Pubkey::find_program_address(&[b"receipt", season], pid).0 == *rc.key }
/// the claims account: owner, magic, a capacity its length can hold, and the PDA of the season it names. Returns that season id.
fn check_claims(c: &AccountInfo, pid: &Pubkey) -> Result<[u8; 8], ProgramError> {
    if c.owner != pid || c.try_data_len()? < CL_HDR { return fail(E_CLAIMS_ACCT); }
    let d = c.try_borrow_data()?; let (n, cap) = (usize::from(d[CL_N]), usize::from(d[CL_CAP]));
    if rd32(&d, 0) != M_CLAIMS || cap > MAX_SLOTS || n > cap || d.len() < claims_size(cap) { return fail(E_CLAIMS_ACCT); }
    let sid: [u8; 8] = arr::<8>(&d, CL_SEASON)?; if Pubkey::find_program_address(&[b"claims", &sid], pid).0 != *c.key { return fail(E_CLAIMS_ACCT); } Ok(sid) }
/// the roster of exactly this season: this program's PDA, magic, and a capacity its length can hold
fn check_roster(r: &AccountInfo, pid: &Pubkey, season: &[u8]) -> ProgramResult {
    if r.owner != pid || r.try_data_len()? < RO_HDR { return fail(E_ROSTER); }
    let d = r.try_borrow_data()?; let cap = usize::from(d[RO_CAP]);
    if rd32(&d, 0) != M_ROSTER || cap > MAX_SLOTS || d.len() < roster_size(cap) || d[RO_SEASON..RO_SEASON + 8] != *season || Pubkey::find_program_address(&[b"roster", season], pid).0 != *r.key { return fail(E_ROSTER); } Ok(()) }
/// who each result belongs to, for EVERY entry, published or not: the owner the arena slot recorded at Enter and the code commitment the roster copied from the sealed account then
#[inline(never)]
fn attribute(arena: &[u8], roster: &AccountInfo, receipt: &mut [u8]) -> ProgramResult {
    let ro = roster.try_borrow_data()?; let ns = usize::from(arena[A_NS]); if ns > usize::from(ro[RO_CAP]) { return fail(E_ROSTER); }
    for i in 0..ns { let (o, e, w, c) = (HDR + i * SLOT, RC_ENT + i * RC_ESZ, RC_OWNERS + i * 32, RO_HDR + i * RO_ESZ);
        let owner: [u8; 32] = arr::<32>(arena, o + SL_OWNER)?; let commit: [u8; 32] = arr::<32>(&ro, c)?; receipt.get_mut(w..w + 32).ok_or(bad!())?.copy_from_slice(&owner); receipt.get_mut(e + 8..e + 40).ok_or(bad!())?.copy_from_slice(&commit); }
    Ok(()) }
/// Records, once, what every entry is owed. No token moves here: Claim pays. Asserts that the amounts sum to the pot and that the pool holds the pot.
fn record_owed(claims: &AccountInfo, pid: &Pubkey, arena: &[u8], pool: &AccountInfo, pool_ata: &AccountInfo, owed: &[u64], pot: u64, kind: u8) -> ProgramResult {
    let sid = check_claims(claims, pid)?; if sid != arr::<8>(arena, A_SEASON)? { return fail(E_CLAIMS_ACCT); }
    let total = owed.iter().try_fold(0u64, |a, x| a.checked_add(*x)).ok_or(ProgramError::ArithmeticOverflow)?; if total != pot { return fail(9042); }
    if pot > 0 { let mint = pk(arena, A_MINT); if Pubkey::find_program_address(&[b"pool", &sid], pid).0 != *pool.key || *pool_ata.key != ata(pool.key, &mint) { return Err(bad!()); }
        // solvency: >= and not ==, because anyone can donate to a pool address and that must not be able to block a season
        if token_balance(pool_ata)? < pot { return fail(9041); } }
    let mut c = claims.try_borrow_mut_data()?; if c[CL_STATE] != 0 { return fail(E_RECORDED); } if owed.len() > usize::from(c[CL_CAP]) { return fail(E_CLAIMS_ACCT); }
    for (i, amt) in owed.iter().enumerate() { let e = CL_HDR + i * CE_SIZE; let o = HDR + i * SLOT; let owner: [u8; 32] = arr::<32>(arena, o + SL_OWNER)?; c[e + CE_OWNER..e + CE_OWNER + 32].copy_from_slice(&owner); wr64(&mut c, e + CE_OWED, *amt); c[e + CE_DONE] = u8::from(*amt == 0); }
    c[CL_N] = owed.len() as u8; c[CL_KIND] = kind; c[CL_MINT..CL_MINT + 32].copy_from_slice(&arena[A_MINT..A_MINT + 32]); wr64(&mut c, CL_OWED, pot); wr64(&mut c, CL_CLAIMED, 0); c[CL_STATE] = 1; Ok(()) }
/// SPL token account balance; anything that is not a token account is an error, never a zero
fn token_balance(a: &AccountInfo) -> Result<u64, ProgramError> { if *a.owner != TOKEN || a.try_data_len()? < 72 { return Err(ProgramError::Custom(9041)); } Ok(rd64(&a.try_borrow_data()?, 64)) }
/// move lamports between two program-owned accounts (the receipt bond and the hub): checked, never below zero
fn move_lamports(from: &AccountInfo, to: &AccountInfo, amt: u64) -> ProgramResult { if amt == 0 { return Ok(()); }
    let f = from.lamports().checked_sub(amt).ok_or(ProgramError::InsufficientFunds)?; let t = to.lamports().checked_add(amt).ok_or(ProgramError::ArithmeticOverflow)?; **from.try_borrow_mut_lamports()? = f; **to.try_borrow_mut_lamports()? = t; Ok(()) }
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
    if data.len() >= 8 && data[..8] == CB_DISC { return vrf_callback(pid, accts, &data[8..], false); }
    if data.len() >= 8 && data[..8] == CB_DISC_FINALS { return vrf_callback(pid, accts, &data[8..], true); }
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    let need = |n: usize| -> ProgramResult { if rest.len() < n { Err(ProgramError::InvalidInstructionData) } else { Ok(()) } };
    let it = &mut accts.iter();
    match *tag {
        // 0 InitHub (base): [payer(s,w), hub(w), system]; data: fund u64
        0 => {
            need(8)?; let (payer, hub, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let (pda, bump) = Pubkey::find_program_address(&[b"hub"], pid); if pda != *hub.key || !payer.is_signer { return Err(bad!()); }
            let fund = ru64(rest, 0)?;
            if hub.lamports() == 0 { invoke_signed(&system_instruction::create_account(payer.key, hub.key, Rent::get()?.minimum_balance(16).saturating_add(fund), 16, pid), &[payer.clone(), hub.clone(), sys.clone()], &[&[b"hub", &[bump]]])?; }
            hub.try_borrow_mut_data()?[0..4].copy_from_slice(&M_HUB.to_le_bytes()); Ok(())
        }
        // 1 Register (base, public): [owner(s,w), reg(w), system]; data: id u64, commitment[32]. PDA ["reg", id]: the id is global, the owner is a field
        1 => {
            let (owner, reg, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            need(40)?; let id = &rest[0..8]; let (pda, bump) = Pubkey::find_program_address(&[b"reg", id], pid);
            if pda != *reg.key || !owner.is_signer { return Err(bad!()); }
            invoke_signed(&system_instruction::create_account(owner.key, reg.key, Rent::get()?.minimum_balance(REG_SIZE).saturating_add(2_000_000), REG_SIZE as u64, pid), &[owner.clone(), reg.clone(), sys.clone()], &[&[b"reg", id, &[bump]]])?;
            let mut d = reg.try_borrow_mut_data()?; d[0..4].copy_from_slice(&M_REG.to_le_bytes()); d[R_OWNER..R_OWNER + 32].copy_from_slice(owner.key.as_ref()); d[R_ID..R_ID + 8].copy_from_slice(id); d[R_COMMIT..R_COMMIT + 32].copy_from_slice(&rest[8..40]);
            wr32(&mut d, R_BEST, u32::MAX); Ok(())
        }
        // 2 Delegate (base): [payer(s,w), system, pda(w), owner_program, buffer, record, metadata, dlp, validator]; data: kind (0 hub, 1 registry, 2 receipt), id-or-season u64
        2 => {
            need(9)?; let (payer, sys, pda, op, buf, rec, meta, dlp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let validator = it.next().map(|a| *a.key);
            let acc = DelegateAccounts { payer, pda, owner_program: op, buffer: buf, delegation_record: rec, delegation_metadata: meta, delegation_program: dlp, system_program: sys };
            let cfg = DelegateConfig { validator, ..Default::default() };
            if !payer.is_signer { return Err(ProgramError::MissingRequiredSignature); }
            // signer seeds are only ever built for the exact PDA of this program: a foreign program id or a mismatched account would otherwise make the runtime abort the transaction on invalid seeds
            if op.key != pid { return Err(bad!()); }
            match rest[0] {
                0 => { if Pubkey::find_program_address(&[b"hub"], pid).0 != *pda.key { return Err(bad!()); } delegate_account(acc, &[b"hub"], cfg) }
                1 => { if Pubkey::find_program_address(&[b"reg", &rest[1..9]], pid).0 != *pda.key { return Err(bad!()); } check_reg(pda, pid)?; { let r = pda.try_borrow_data()?; if &r[R_OWNER..R_OWNER + 32] != payer.key.as_ref() || r[R_ID..R_ID + 8] != rest[1..9] { return Err(bad!()); } } delegate_account(acc, &[b"reg", &rest[1..9]], cfg) }
                // a receipt is handed to a rollup only by its CREATOR and only while FRESH (9140): a stranger cannot take it first, and a receipt that has opened a season, closed ones above all, is never delegated again
                2 => { if Pubkey::find_program_address(&[b"receipt", &rest[1..9]], pid).0 != *pda.key { return Err(bad!()); } if pda.owner != pid || pda.try_data_len()? < RC_MONEY_SIZE || rd32(&pda.try_borrow_data()?, 0) != M_RCPT { return Err(bad!()); }
                    { let r = pda.try_borrow_data()?; if r.len() < RC_SIZE || r[RC_FORMAT] != RECEIPT_FORMAT || r[RC_STATE] != 0 || &r[RC_CREATOR..RC_CREATOR + 32] != payer.key.as_ref() { return fail(E_DELEGATE_RECEIPT); } }
                    delegate_account(acc, &[b"receipt", &rest[1..9]], cfg) }
                3 => { if Pubkey::find_program_address(&[b"config"], pid).0 != *pda.key { return Err(bad!()); } check_config(pda, pid)?; cfg_authority(pda, payer)?; delegate_account(acc, &[b"config"], cfg) }
                _ => Err(bad!()),
            }
        }
        // 3 SealStrategy (TEE): [owner(s), strat(w), permission(w), vault(w), magic, permission_program, reg(w)]; data: id u64, salt[32], code. The OWNER'S REGISTRY pays the sealed account's rent and its permission's, and gets them
        // back at CloseStrategy. The hub is not involved. The registry must be writable, which the rollup grants only to an account that is delegated to it: an undelegated registry cannot seal.
        3 => seal(pid, accts, rest),
        5 => create_season(pid, accts, rest), // see create_season
        6 => enter(pid, accts, rest), // see enter
        // 7 Lock (TEE): [signer(s), arena(w)]. The creator may lock at any time; ANYONE may lock once the entry window has elapsed, so an absent creator cannot strand a season.
        // A field below the minimum at lock is cancelled instead (refunds follow via Cancel); the creator cannot cancel early this way, only after the window.
        7 => { let (auth, arena) = (next_account_info(it)?, next_account_info(it)?); check_arena(arena, pid)?; let mut d = arena.try_borrow_mut_data()?; check_pins(&d)?;
            if !auth.is_signer || d[A_FLAGS] & F_LOCKED != 0 { return Err(bad!()); }
            let slot = Clock::get()?.slot; let elapsed = slot >= rd64(&d, A_CREATED).saturating_add(rd64(&d, A_WINDOW)); let creator = &d[A_AUTH..A_AUTH + 32] == auth.key.as_ref();
            if !creator && !elapsed { return Err(ProgramError::Custom(9032)); }
            if d[A_NS] < d[A_MINS].max(1) { if !elapsed { return Err(ProgramError::Custom(9031)); } d[A_F2] |= F2_CANCELLED; d[A_REASON] = REASON_UNDERMIN; }
            d[A_FLAGS] |= F_LOCKED; wr64(&mut d, A_LOCKAT, slot); Ok(()) }
        // 8 RequestSeed (permissionless): [payer(s,w), arena(w), identity, queue(w), system, slot_hashes, vrf_program]
        // Used once for the season phase (after Lock) and, in a season with finals, once more after the season phase ends. The queue is pinned. Each request has its own callback, and a request after its timeout is refused.
        8 => {
            let (payer, arena, identity, queue, sys, slots, vrf) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; if *queue.key != VRF_QUEUE { return fail(E_QUEUE); }
            let finals = { let mut d = arena.try_borrow_mut_data()?; check_pins(&d)?; let f = d[A_FLAGS]; if d[A_F2] & F2_CANCELLED != 0 || f & (F_DONE | F_SETTLED) != 0 { return fail(E_SEED_STATE); }
                let slot = Clock::get()?.slot;
                if f & F_SDONE == 0 { if f & F_LOCKED == 0 || f & F_REQ != 0 || slot >= rd64(&d, A_LOCKAT).saturating_add(rd64(&d, A_SEEDTO)) { return fail(E_SEED_STATE); } d[A_FLAGS] |= F_REQ; false }
                else { if f & F_FREQ != 0 || slot >= rd64(&d, A_SDONEAT).saturating_add(FINALS_SEEDTO) { return fail(E_SEED_STATE); } d[A_FLAGS] |= F_FREQ; true } };
            let (idpda, bump) = Pubkey::find_program_address(&[b"identity"], pid); if idpda != *identity.key { return Err(bad!()); }
            let params = RequestRandomnessParams { payer: payer.key.compat(), oracle_queue: queue.key.compat(), callback_program_id: pid.compat(), callback_discriminator: if finals { CB_DISC_FINALS.to_vec() } else { CB_DISC.to_vec() }, caller_seed: if finals { [8u8; 32] } else { [7u8; 32] },
                accounts_metas: Some(vec![ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta { pubkey: arena.key.compat(), is_signer: false, is_writable: true }]), callback_args: None };
            let ix = create_request_randomness_ix_const(params, idpda.compat()).modern();
            invoke_signed(&ix, &[payer.clone(), identity.clone(), queue.clone(), sys.clone(), slots.clone(), vrf.clone()], &[&[b"identity", &[bump]]])
        }
        // 9 Advance (permissionless, clock-gated, idempotent, work-metered): [arena(w)]; data: max_ticks u16, budget_k u16 (the transaction's compute limit in thousands; the program decides how many ticks that budget buys)
        9 => { need(2)?; let arena = next_account_info(it)?; check_arena(arena, pid)?; let budget = if rest.len() >= 4 { u64::from(u16::from_le_bytes([rest[2], rest[3]])) * 1000 } else { 200_000 }; advance(arena, u64::from(u16::from_le_bytes([rest[0], rest[1]])), budget) }
        10 => settle(pid, accts), // see settle
        // 11 Publish (permissionless after settle): [crank(s), arena(w), strat(w), reg(w), receipt(w)]; data: slot u8
        11 => {
            let (_c, arena, strat, reg, receipt) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_arena(arena, pid)?; let mut d = arena.try_borrow_mut_data()?; if d[A_FLAGS] & F_SETTLED == 0 { return fail(E_PUBLISH_EARLY); }
            need(1)?; let i = usize::from(rest[0]); if i >= usize::from(d[A_NS]) { return Err(bad!()); }
            publish_entry(&mut d, i, strat, reg, receipt, pid)
        }
        // 12 Commit (TEE): [payer(s,w), magic, magic_ctx, accounts(w)...]  commits delegated registries and receipts to base
        12 => { let (payer, magic, ctx) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?); let regs: Vec<AccountInfo> = it.cloned().collect();
            let b = MagicIntentBundleBuilder::new(payer.clone(), ctx.clone(), magic.clone());
            // data [1]: commit AND undelegate (used on a closed season's receipt so the bond can be released on base, and on a closed registry so it can be removed); no data: commit only
            if rest.first() == Some(&1) {
                // undelegating is only ever allowed for receipts of closed seasons; anyone could otherwise pull a live season's receipt out of the rollup
                // ... and of registries whose owner closed the strategy (CloseStrategy), so base can remove them
                for r in &regs { if r.owner != pid || r.try_data_len()? < REG_SIZE { return Err(ProgramError::Custom(9055)); } let d = r.try_borrow_data()?; let closed_reg = rd32(&d, 0) == M_REG_CLOSED; let closed_receipt = d.len() >= RC_MONEY_SIZE && rd32(&d, 0) == M_RCPT && d[RC_STATE] == 2; if !closed_reg && !closed_receipt { return Err(ProgramError::Custom(9055)); } }
                b.commit_and_undelegate(&regs).build_and_invoke() } else { b.commit(&regs).build_and_invoke() } }
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
        // 14 was StartFinals. Finals are now a phase of the season arena that Advance enters by itself; the tag is retired and falls through to InvalidInstructionData.
        15 => cleanup(pid, accts), // see cleanup
        // 16 InitReceipt (base): [payer(s,w), receipt(w), system]; data: season u64, bond u64. The receipt is a durable, committable record on base and holds the creator's bond (lamports above rent), released at cleanup
        16 => {
            need(16)?; let (payer, rc, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?); let sid = &rest[0..8]; let bond = ru64(rest, 8)?;
            let (pda, bump) = Pubkey::find_program_address(&[b"receipt", sid], pid); if pda != *rc.key || !payer.is_signer { return Err(bad!()); }
            if bond < BOND_MIN { return Err(ProgramError::Custom(9050)); }
            invoke_signed(&system_instruction::create_account(payer.key, rc.key, Rent::get()?.minimum_balance(RC_SIZE).checked_add(bond).ok_or(bad!())?, RC_SIZE as u64, pid), &[payer.clone(), rc.clone(), sys.clone()], &[&[b"receipt", sid, &[bump]]])?;
            let mut r = rc.try_borrow_mut_data()?; r[0..4].copy_from_slice(&M_RCPT.to_le_bytes()); r[RC_FORMAT] = RECEIPT_FORMAT; r[RC_CREATOR..RC_CREATOR + 32].copy_from_slice(payer.key.as_ref()); wr64(&mut r, RC_BOND, bond); Ok(())
        }
        17 => cancel(pid, accts), // see cancel
        // 18 ReleaseBond (base, permissionless): [anyone(s), receipt(w), creator(w)]: pays the creator the releasable part of the bond once the season is closed and the receipt is back on base (undelegated), exactly once
        18 => {
            let (_c, rc, creator) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            if rc.owner != pid || rc.try_data_len()? < RC_MONEY_SIZE { return Err(ProgramError::Custom(9054)); }
            let amt = { let r = rc.try_borrow_data()?; if rd32(&r, 0) != M_RCPT || r[RC_STATE] != 2 || Pubkey::find_program_address(&[b"receipt", &r[RC_SEASON..RC_SEASON + 8]], pid).0 != *rc.key || &r[RC_CREATOR..RC_CREATOR + 32] != creator.key.as_ref() { return Err(ProgramError::Custom(9054)); } rd64(&r, RC_RELEASE) };
            move_lamports(rc, creator, amt)?; wr64(&mut rc.try_borrow_mut_data()?, RC_RELEASE, 0); Ok(())
        }
        // 19 InitConfig (base): [authority(s,w), config(w), system, program_data]. Only the program's upgrade authority can create the config, and it becomes the config authority (movable later with Admin 4, e.g. to a multisig)
        19 => {
            let (auth, cfgacc, sys, pdata) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let (cp, cbump) = Pubkey::find_program_address(&[b"config"], pid); if cp != *cfgacc.key || !auth.is_signer { return Err(bad!()); }
            if Pubkey::find_program_address(&[pid.as_ref()], &UPGRADEABLE_LOADER).0 != *pdata.key || pdata.owner != &UPGRADEABLE_LOADER { return Err(ProgramError::Custom(9062)); }
            { let d = pdata.try_borrow_data()?; if d.len() < 45 || rd32(&d, 0) != 3 || d[12] != 1 || &d[13..45] != auth.key.as_ref() { return Err(ProgramError::Custom(9062)); } }
            invoke_signed(&system_instruction::create_account(auth.key, cfgacc.key, Rent::get()?.minimum_balance(CFG_SIZE).max(1), CFG_SIZE as u64, pid), &[auth.clone(), cfgacc.clone(), sys.clone()], &[&[b"config", &[cbump]]])?;
            let mut c = cfgacc.try_borrow_mut_data()?; c[0..4].copy_from_slice(&M_CFG.to_le_bytes()); c[C_AUTH..C_AUTH + 32].copy_from_slice(auth.key.as_ref()); Ok(())
        }
        // 20 Admin (authority only; run in the rollup against the delegated config): [authority(s), config(w)]; data: 0 pause | 1 unpause | 2 allow mint[32] | 3 disallow mint[32] | 4 set authority[32]
        20 => {
            let (auth, cfgacc) = (next_account_info(it)?, next_account_info(it)?); check_config(cfgacc, pid)?; cfg_authority(cfgacc, auth)?; if !cfgacc.is_writable { return Err(bad!()); }
            need(1)?; let mut c = cfgacc.try_borrow_mut_data()?;
            match rest[0] {
                0 => { c[C_PAUSED] = 1; Ok(()) }
                1 => { c[C_PAUSED] = 0; Ok(()) }
                2 => { let m: [u8; 32] = arr::<32>(rest, 1)?; let n = usize::from(c[C_NMINTS]).min(MAX_MINTS); if (0..n).any(|i| c[C_MINTS + i * 32..C_MINTS + i * 32 + 32] == m) { return Ok(()); } if n >= MAX_MINTS { return Err(ProgramError::Custom(9064)); }
                    c[C_MINTS + n * 32..C_MINTS + n * 32 + 32].copy_from_slice(&m); c[C_NMINTS] = (n + 1) as u8; Ok(()) }
                3 => { let m: [u8; 32] = arr::<32>(rest, 1)?; let n = usize::from(c[C_NMINTS]).min(MAX_MINTS); let i = (0..n).find(|&i| c[C_MINTS + i * 32..C_MINTS + i * 32 + 32] == m).ok_or(bad!())?;
                    let last = (n - 1) * 32 + C_MINTS; let tmp: [u8; 32] = arr::<32>(&c, last)?; c[C_MINTS + i * 32..C_MINTS + i * 32 + 32].copy_from_slice(&tmp); c[last..last + 32].fill(0); c[C_NMINTS] = (n - 1) as u8; Ok(()) }
                4 => { let m: [u8; 32] = arr::<32>(rest, 1)?; if m == [0u8; 32] { return Err(bad!()); } c[C_AUTH..C_AUTH + 32].copy_from_slice(&m); Ok(()) }
                _ => Err(ProgramError::InvalidInstructionData),
            }
        }
        // 21 RecoverBond (authority only, in the rollup): [authority(s), config, receipt(w), arena]; data: season u64.
        // For a season whose bond has no release path (receipt not closed, season written or cancelled, arena gone from the rollup) it moves the receipt to the closed state with the whole bond releasable.
        // It moves no lamports itself: the existing ReleaseBond on base then pays the creator recorded on the receipt, so the authority can never receive anything. It refuses any live, fresh or already closed receipt.
        21 => {
            let (auth, cfgacc, rc, arena) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            check_config(cfgacc, pid)?; cfg_authority(cfgacc, auth)?; need(8)?; let sid = &rest[0..8];
            if Pubkey::find_program_address(&[b"arena", sid], pid).0 != *arena.key || arena.try_data_len()? != 0 || !rcpt_money_ok(rc, pid, sid) || !rc.is_writable { return Err(ProgramError::Custom(9070)); }
            let mut r = rc.try_borrow_mut_data()?;
            let written = r[RC_NS] != 0 || r[RC_KIND] == 2; // Settle or Cancel wrote this season's header: a fresh or merely opened receipt is not orphaned
            if r[RC_STATE] == 2 || !written || r[RC_SEASON..RC_SEASON + 8] != *sid { return Err(ProgramError::Custom(9070)); }
            let rel = rd64(&r, RC_BOND).min(rc.lamports()); wr64(&mut r, RC_RELEASE, rel); wr64(&mut r, RC_FORFEIT, 0); r[RC_STATE] = 2; Ok(())
        }
        // 22 Claim (permissionless, works while paused): [claims(w), pool_pda, pool_ata(w), owner_ata(w), token_program]; data: slot u8
        // Pays what one entry is owed to that entry owner's token account, exactly once. A claim that has nothing left to pay (already paid, or nothing owed) succeeds and moves nothing, so retries are harmless.
        // Solvency: before any transfer the pool must cover EVERYTHING still unclaimed, so a short pool can never be drained by whoever claims first.
        22 => {
            need(1)?; let (claims, pool, pe, dest, tp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let sid = check_claims(claims, pid)?; let i = usize::from(rest[0]);
            let (amt, owner, mint, outstanding) = { let c = claims.try_borrow_data()?; if c[CL_STATE] != 1 { return fail(E_NOT_RECORDED); } if i >= usize::from(c[CL_N]) { return fail(E_CLAIM_SLOT); }
                let e = CL_HDR + i * CE_SIZE; if c[e + CE_DONE] != 0 { return Ok(()); }
                (rd64(&c, e + CE_OWED), pk(&c, e + CE_OWNER), pk(&c, CL_MINT), rd64(&c, CL_OWED).checked_sub(rd64(&c, CL_CLAIMED)).ok_or(ProgramError::Custom(9042))?) };
            let (pp, pbump) = Pubkey::find_program_address(&[b"pool", &sid], pid); if pp != *pool.key || *pe.key != ata(&pp, &mint) { return Err(bad!()); }
            if *dest.key != ata(&owner, &mint) { return fail(E_CLAIM_DEST); }
            if amt > outstanding { return fail(9042); } if token_balance(pe)? < outstanding { return fail(9041); }
            { let mut c = claims.try_borrow_mut_data()?; let e = CL_HDR + i * CE_SIZE; c[e + CE_DONE] = 1; let paid = rd64(&c, CL_CLAIMED).checked_add(amt).ok_or(ProgramError::ArithmeticOverflow)?; wr64(&mut c, CL_CLAIMED, paid); }
            token_transfer(pe, dest, pool, tp, amt, &[&[b"pool", &sid, &[pbump]]])
        }
        // 23 CloseClaims (permissionless, works while paused): [crank(s), hub(w), claims(w), vault(w), magic, terms(w)]. Only once every amount recorded has been paid; the rent of the claims account and of the season's
        // terms record goes back to the hub. The terms record must be named (9150): a season of an earlier build never had one, and its address then holds nothing.
        23 => {
            let (crank, hub, claims, vault, magic) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
            let terms = next_account_info(it)?;
            if !crank.is_signer { return Err(ProgramError::MissingRequiredSignature); } let sid = check_claims(claims, pid)?; let _ = magic;
            { let c = claims.try_borrow_data()?; if c[CL_STATE] != 1 { return fail(E_NOT_RECORDED); } let n = usize::from(c[CL_N]);
              if (0..n).any(|i| c[CL_HDR + i * CE_SIZE + CE_DONE] == 0) || rd64(&c, CL_CLAIMED) != rd64(&c, CL_OWED) { return fail(E_OUTSTANDING); } }
            let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
            let hs: &[&[u8]] = &[b"hub", &[hbump]];
            if terms.lamports() == 0 && terms.data_is_empty() { if Pubkey::find_program_address(&[b"terms", &sid], pid).0 != *terms.key { return fail(E_TERMS_ACCT); } } // no terms record: only at the address it would have, and only if nothing is there
            else { check_terms(terms, pid, &sid)?; EphemeralAccount::new(hub, terms, vault).with_signer_seeds(&[hs]).close()?; }
            EphemeralAccount::new(hub, claims, vault).with_signer_seeds(&[hs]).close()
        }
        // 24 CloseStrategy (TEE) and 25 CloseRegistry (base): see close_strategy and close_registry
        24 => close_strategy(pid, accts),
        25 => close_registry(pid, accts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// Work-metered driver. The devnet runtime does not enable the remaining-compute syscall (observed: the loader rejects the program), so the program meters by a calibrated static model: cost per tick
/// is derived from each seat's metered work (the weights are calibrated so compute is roughly linear in work). Given the caller's compute limit it runs as many ticks as the model says fit,
/// with a safety factor, then stops cleanly. Partial progress is safe because the clock gate makes the call idempotent. The caller never picks a tick count.
/// The same call drives both phases. When the season phase ends it freezes the season ranks and, if there are finals to run, moves the arena into the finals phase by itself.
fn advance(arena: &AccountInfo, max: u64, budget: u64) -> ProgramResult {
    let mut d = arena.try_borrow_mut_data()?; check_pins(&d)?;
    let f = d[A_FLAGS]; let finals = f & F_SDONE != 0; let seeded = if finals { f & F_FSEEDED != 0 } else { f & F_SEEDED != 0 };
    if !seeded || f & (F_DONE | F_SETTLED) != 0 || d[A_F2] & F2_CANCELLED != 0 { return fail(E_NOT_RUNNING); }
    let slot = Clock::get()?.slot; let start = rd64(&d, A_START); let spt32 = rd32(&d, A_SPT); let spt = u64::from(spt32).max(1);
    let neps = if finals { FINALS_EPISODES } else { rd32(&d, A_NEPS) };
    // past its deadline a phase can no longer progress, so whether it finished is decided by the clock alone and nobody gets to choose between finishing it and the fallback
    if slot >= phase_deadline(start, neps, spt32) { return fail(E_DEADLINE); }
    let mut cur_ep = rd32(&d, A_CUREP); let mut cur_tick = rd32(&d, A_CURTICK) as usize;
    let done_g = u64::from(cur_ep).saturating_mul(world::WORLD_T as u64).saturating_add(cur_tick as u64); let due = slot.saturating_sub(start) / spt;
    if due <= done_g { return Ok(()); }
    let n = (due - done_g).min(max);
    let ns = usize::from(d[A_NS]); let seed: [u8; 32] = arr::<32>(&d, if finals { A_FSEED } else { A_SEED })?; let (sa, sb) = world::season_words(&seed); let packs = world::season_packs(sa, sb);
    if cur_tick >= world::WORLD_T || cur_ep >= neps { return Err(bad!()); }
    // the seats that run: everyone in the season phase, the qualifiers in the finals (same sealed bytecode, same arena)
    let active: Vec<usize> = (0..ns).filter(|&i| !finals || d[HDR + i * SLOT + SL_BITS] & B_FINALIST != 0).collect(); let total_at = if finals { SL_FTOTAL } else { SL_TOTAL };
    let mut est_tick = TICK_BASE; for &i in &active { let o = HDR + i * SLOT; let l = (u16::from_le_bytes([d[o + SL_LEN], d[o + SL_LEN + 1]]) as usize).min(CODE_MAX); est_tick += SEAT_BASE + SEAT_PER_WORK * u64::from(work_of(&d[o + SL_CODE..o + SL_CODE + l])); }
    est_tick = est_tick * SAFETY_PCT / 100;
    let mut left = budget.saturating_sub(TAIL_BASE + TAIL_PER_SEAT * active.len() as u64);
    let mut market = Market::load(&d[A_MKT..A_MKT + Market::BYTES]);
    let mut seats: Vec<Seat> = active.iter().map(|&i| Seat::load(&d[HDR + i * SLOT + SL_SEAT..HDR + i * SLOT + SL_SEAT + Seat::BYTES])).collect();
    let mut ran = 0u64; let mut finished = false; let mut totals: Vec<i64> = active.iter().map(|&i| rdi64(&d, HDR + i * SLOT + total_at)).collect();
    while ran < n && !finished {
        let need = est_tick + if cur_tick == 0 { GEN_COST } else { 0 }; if left < need { break; } left -= need;
        if cur_tick == 0 {
            let es = world::episode_seed(sa, sb, u64::from(cur_ep)); let mut r = [0i32; world::WORLD_T]; world::gen_episode(world::pack_for_season(&packs, es), es, &mut r);
            for (i, v) in r.iter().enumerate() { d[A_RET + i * 4..A_RET + i * 4 + 4].copy_from_slice(&v.to_le_bytes()); }
            market = Market::new(world::WORLD_T as u32); for s in seats.iter_mut() { *s = Seat::new(); }
        }
        let r = i32::from_le_bytes(arr::<4>(&d, A_RET + cur_tick * 4)?);
        let sg0 = market.advance(r);
        for (k, s) in seats.iter_mut().enumerate() { let o = HDR + active[k] * SLOT; let len = (u16::from_le_bytes([d[o + SL_LEN], d[o + SL_LEN + 1]]) as usize).min(CODE_MAX); s.step(&d[o + SL_CODE..o + SL_CODE + len], &market, r, sg0); }
        cur_tick += 1; ran += 1;
        if cur_tick == world::WORLD_T { for (k, s) in seats.iter().enumerate() { totals[k] = totals[k].saturating_add(s.pnl()); } cur_tick = 0; cur_ep += 1; if cur_ep >= neps { finished = true; } }
    }
    if ran == 0 { return Ok(()); }
    market.save(&mut d[A_MKT..A_MKT + Market::BYTES]);
    for (k, s) in seats.iter().enumerate() { let o = HDR + active[k] * SLOT; s.save(&mut d[o + SL_SEAT..o + SL_SEAT + Seat::BYTES]); d[o + total_at..o + total_at + 8].copy_from_slice(&totals[k].to_le_bytes()); }
    wr32(&mut d, A_CUREP, cur_ep); wr32(&mut d, A_CURTICK, cur_tick as u32); let t = rd32(&d, A_TICKS).saturating_add(u32::try_from(ran).unwrap_or(u32::MAX)); wr32(&mut d, A_TICKS, t);
    if finished { if finals { d[A_FLAGS] |= F_DONE; } else { end_season_phase(&mut d, slot)?; } }
    Ok(())
}
/// The season phase is over: freeze the season ranks (total descending, ties to the earlier entry). With finals and at least two entrants, the top three (or both, with two) qualify and the arena
/// waits for the finals seed; otherwise nothing is left to run. This is the automatic phase transition: no instruction starts the finals.
fn end_season_phase(d: &mut [u8], slot: u64) -> ProgramResult {
    let ns = usize::from(d[A_NS]); let mut order: Vec<usize> = (0..ns).collect(); order.sort_by(|a, b| rdi64(d, HDR + b * SLOT + SL_TOTAL).cmp(&rdi64(d, HDR + a * SLOT + SL_TOTAL)).then(a.cmp(b)));
    for (rank, &i) in order.iter().enumerate() { let o = HDR + i * SLOT; d[o + SL_SRANK] = u8::try_from(rank + 1).map_err(|_| ProgramError::InvalidAccountData)?; wr32(d, o + SL_RANK, rank as u32 + 1); }
    d[A_FLAGS] |= F_SDONE; wr64(d, A_SDONEAT, slot);
    if d[A_F2] & F2_HASFIN == 0 { d[A_FLAGS] |= F_DONE; }
    else if ns < 2 { d[A_F2] |= F2_THINFIELD; d[A_FLAGS] |= F_DONE; }
    else { for &i in order.iter().take(FINALS_QUALIFIERS) { let o = HDR + i * SLOT; d[o + SL_BITS] |= B_FINALIST; wr64(d, o + SL_FTOTAL, 0); } wr32(d, A_CUREP, 0); wr32(d, A_CURTICK, 0); }
    Ok(())
}

/// One entry's result: the owner's private record, the registry career stats, and the receipt's code and score commitments (salted with the entrant's secret, so an outsider who re-simulates presets from the revealed seed cannot match it).
/// Used by Publish and by Settle's inline publish. Each (season, entry) publishes at most once: the mark lives in THIS season's arena slot and receipt entry, so publishing the same strategy in another
/// season can never reopen this one, and the publish counters cannot exceed the number of entries.
/// The registry records the final rank (the result that was paid) and adds the season-phase total, which is comparable across seasons with and without finals.
#[inline(never)]
fn publish_entry(d: &mut [u8], i: usize, strat: &AccountInfo, reg: &AccountInfo, receipt: &AccountInfo, pid: &Pubkey) -> ProgramResult {
    if i >= usize::from(d[A_NS]) { return Err(bad!()); }
    let o = HDR + i * SLOT; let id: [u8; 8] = arr::<8>(d, o + SL_ID)?;
    check_strat(strat, pid)?; check_reg(reg, pid)?;
    if Pubkey::find_program_address(&[b"strat", &id], pid).0 != *strat.key || Pubkey::find_program_address(&[b"reg", &id], pid).0 != *reg.key { return Err(bad!()); }
    check_receipt(receipt, pid, &d[A_SEASON..A_SEASON + 8])?; let e = RC_ENT + i * RC_ESZ;
    { let r = receipt.try_borrow_data()?; if r[e..e + 8] != id { return Err(ProgramError::Custom(9022)); } if r[e + RE_PUBLISHED] != 0 || d[o + SL_BITS] & B_PUBLISHED != 0 { return fail(E_PUBLISHED); } if r[e + 8..e + 40] != strat.try_borrow_data()?[S_COMMIT..S_COMMIT + 32] { return Err(ProgramError::Custom(9022)); } }
    let (rank, total, ns, season, neps) = (rd32(d, o + SL_RANK), rdi64(d, o + SL_TOTAL), u32::from(d[A_NS]), rd64(d, A_SEASON), rd32(d, A_NEPS));
    let finalist = d[o + SL_BITS] & B_FINALIST != 0; let (ftotal, fneps) = if finalist { (rdi64(d, o + SL_FTOTAL), FINALS_EPISODES) } else { (0, 0) };
    let salt: [u8; 32];
    { let mut s = strat.try_borrow_mut_data()?; salt = arr::<32>(&s, S_SALT)?;
      wr64(&mut s, S_LSEASON, season.saturating_add(1)); wr32(&mut s, S_LRANK, rank); wr32(&mut s, S_LN, ns); wr64(&mut s, S_LPNL, total as u64); wr64(&mut s, S_LFINALS, ftotal as u64); } // (the last write is skipped by its bounds check on strategies sealed by the previous build)
    { let mut r = reg.try_borrow_mut_data()?; let (se, en, b, t) = (rd32(&r, R_SEASONS).saturating_add(1), rd32(&r, R_ENTRIES).saturating_add(1), rd32(&r, R_BEST).min(rank), rdi64(&r, R_TOTAL).saturating_add(total)); wr32(&mut r, R_SEASONS, se); wr32(&mut r, R_ENTRIES, en); wr32(&mut r, R_BEST, b);
      r[R_TOTAL..R_TOTAL + 8].copy_from_slice(&t.to_le_bytes()); wr64(&mut r, R_LSEASON, season); wr32(&mut r, R_LRANK, rank); }
    let score_salt = hashv(&[DOM_SCORE_SALT, &salt, &season.to_le_bytes()]).to_bytes();
    let score = hashv(&[DOM_SCORE, &score_salt, &season.to_le_bytes(), &id, &total.to_le_bytes(), &ftotal.to_le_bytes(), &neps.to_le_bytes(), &fneps.to_le_bytes()]).to_bytes();
    { let mut r = receipt.try_borrow_mut_data()?; r[e + 40..e + 72].copy_from_slice(&score); r[e + RE_PUBLISHED] = 1; r[RC_PUB] = r[RC_PUB].checked_add(1).ok_or(bad!())?; }
    release_entry(d, i, strat)?; d[o + SL_BITS] |= B_PUBLISHED; d[A_PUBN] = d[A_PUBN].checked_add(1).ok_or(bad!())?; Ok(())
}

/// ephemeral rent of a sealed account's permission with one member (68 bytes + 33 per member), as devnet showed it: 20,000 lamports with the sealed account itself
const PERM_LEN: u32 = 68 + 33;
/// 3 SealStrategy: see the dispatcher. The registry is the rent sponsor of both the sealed account and its permission, signed for with its own seeds, and the strategy is marked as registry-funded.
#[inline(never)]
fn seal(pid: &Pubkey, accts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accts.iter();
    let (owner, strat, perm, vault, magic, pp, reg) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    if !owner.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if rest.len() < 41 { return Err(ProgramError::InvalidInstructionData); } let idb = &rest[0..8]; let salt = &rest[8..40]; let code = &rest[40..];
    validate(code).map_err(vm_err)?; // ruleset v2: version tag, structure, work cap
    let (sp, sbump) = Pubkey::find_program_address(&[b"strat", idb], pid); if sp != *strat.key { return Err(bad!()); }
    let commit = hashv(&[DOM_CODE, salt, code]).to_bytes();
    check_reg(reg, pid)?;
    // the registry pays, so it must be writable here. The rollup grants write access only to an account delegated to it, so this is also the refusal of a registry that was never delegated (9133), before anything is created
    if !reg.is_writable { return fail(E_ENTRY_REGISTRY); }
    let (rp, rbump) = Pubkey::find_program_address(&[b"reg", idb], pid);
    { let r = reg.try_borrow_data()?; if rp != *reg.key || &r[R_OWNER..R_OWNER + 32] != owner.key.as_ref() || r[R_COMMIT..R_COMMIT + 32] != commit { return Err(bad!()); } }
    // the registry must stay rent-exempt after paying: what it holds must cover the minimum for its own size plus both ephemeral rents (9134). Checked before the first CPI, and again from the real balance after the last
    let floor = Rent::get()?.minimum_balance(reg.try_data_len()?); let need = ephemeral_rollups_sdk::ephemeral_accounts::rent(STRAT_SIZE as u32).saturating_add(ephemeral_rollups_sdk::ephemeral_accounts::rent(PERM_LEN));
    if reg.lamports() < floor.saturating_add(need) { return fail(E_REG_RENT); }
    let rs: &[&[u8]] = &[b"reg", idb, &[rbump]]; let ss: &[&[u8]] = &[b"strat", idb, &[sbump]];
    EphemeralAccount::new(reg, strat, vault).with_signer_seeds(&[rs, ss]).create(STRAT_SIZE as u32)?;
    if strat.try_data_len()? < STRAT_SIZE { return Err(ProgramError::AccountDataTooSmall); } // the ER must have created it at the size we asked for
    { let mut d = strat.try_borrow_mut_data()?; d[0..4].copy_from_slice(&M_STRAT.to_le_bytes()); d[4..6].copy_from_slice(&(code.len() as u16).to_le_bytes()); d[S_OWNER..S_OWNER + 32].copy_from_slice(owner.key.as_ref()); d[S_ID..S_ID + 8].copy_from_slice(idb);
      d[S_COMMIT..S_COMMIT + 32].copy_from_slice(&commit); d[S_SALT..S_SALT + 32].copy_from_slice(salt); d[S_CODE..S_CODE + code.len()].copy_from_slice(code);
      d[S_OPEN..S_OPEN + 2].copy_from_slice(&S_PAYER_REG.to_le_bytes()); } // no entry yet, and the registry paid
    CreateEphemeralPermissionCpi { payer: reg.clone(), permissioned_account: strat.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
        args: EphemeralMembersArgs { is_private: true, members: owner_member(owner.key) } }.invoke_signed(&[rs, ss])?;
    if reg.lamports() < floor { return fail(E_REG_RENT); } // from the real balance, whatever the rent turned out to be
    Ok(())
}
/// 24 CloseStrategy (TEE, the owner; works while paused): [owner(s), hub(w), strat(w), permission(w), vault(w), magic, permission_program, reg(w)]
/// Only with no open entry (9130), so a strategy cannot be closed out of a result it still owes the record, or while a Publish still needs its salt. Closes the sealed account and its permission and marks
/// the registry closed. The rent goes back to WHOEVER PAID IT, which the sealed account itself says: a strategy sealed by this build carries the payer flag and its registry is repaid (the registry signs with its own seeds);
/// one sealed by an earlier build has no flag and the hub, which paid its rent, is repaid. The hub account is read only on that second path. The owner's own rent is in the registry and comes back at CloseRegistry.
#[inline(never)]
fn close_strategy(pid: &Pubkey, accts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accts.iter();
    let (owner, hub, strat, perm, vault, magic, pp, reg) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    if !owner.is_signer { return Err(ProgramError::MissingRequiredSignature); } check_strat(strat, pid)?;
    let (id, raw) = { let s = strat.try_borrow_data()?; if &s[S_OWNER..S_OWNER + 32] != owner.key.as_ref() { return Err(ProgramError::MissingRequiredSignature); } (arr::<8>(&s, S_ID)?, open_raw(&s)) };
    let (sp, sbump) = Pubkey::find_program_address(&[b"strat", &id], pid); if sp != *strat.key { return Err(bad!()); }
    if raw & S_OPEN_MASK != 0 { return fail(E_STRAT_OPEN); }
    let reg_paid = raw & S_PAYER_REG != 0;
    let (rp, rbump) = Pubkey::find_program_address(&[b"reg", &id], pid);
    check_reg(reg, pid)?; if rp != *reg.key || !reg.is_writable { return Err(bad!()); }
    if &reg.try_borrow_data()?[R_OWNER..R_OWNER + 32] != owner.key.as_ref() { return Err(ProgramError::MissingRequiredSignature); }
    // the sponsor that paid: the registry (flag set) or the hub (no flag)
    let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if !reg_paid && hp != *hub.key { return Err(bad!()); }
    wr32(&mut reg.try_borrow_mut_data()?, 0, M_REG_CLOSED);
    strat.try_borrow_mut_data()?.fill(0); // salt and code are wiped before the account is handed back, and nothing later in this transaction can read it as a strategy
    let sponsor = if reg_paid { reg } else { hub };
    let rs: &[&[u8]] = &[b"reg", &id, &[rbump]]; let hs: &[&[u8]] = &[b"hub", &[hbump]]; let ss: &[&[u8]] = &[b"strat", &id, &[sbump]]; let ps: &[&[u8]] = if reg_paid { rs } else { hs };
    ephemeral_rollups_sdk::access_control::instructions::CloseEphemeralPermissionCpi { payer: sponsor.clone(), authority: strat.clone(), permissioned_account: strat.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(), authority_is_signer: false }.invoke_signed(&[ps, ss])?;
    EphemeralAccount::new(sponsor, strat, vault).with_signer_seeds(&[ps]).close()
}
/// 25 CloseRegistry (base, permissionless, like ReleaseBond): [anyone(s), reg(w), owner(w)]. Shrinks a closed registry that is back from the rollup to a permanent marker and returns the rest of its lamports to the owner recorded on it, who paid for it at Register.
#[inline(never)]
fn close_registry(pid: &Pubkey, accts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accts.iter();
    let (_c, reg, owner) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    if reg.owner != pid || reg.try_data_len()? < REG_SIZE { return fail(E_REG_NOT_CLOSED); }
    { let r = reg.try_borrow_data()?; if rd32(&r, 0) != M_REG_CLOSED || Pubkey::find_program_address(&[b"reg", &r[R_ID..R_ID + 8]], pid).0 != *reg.key || &r[R_OWNER..R_OWNER + 32] != owner.key.as_ref() { return fail(E_REG_NOT_CLOSED); } }
    // the registry shrinks to an 8-byte marker that nothing ever removes: its address stays taken, so Register refuses this id for good. The owner gets everything above the marker's rent
    let keep = Rent::get()?.minimum_balance(MARKER_SIZE).max(1); let pay = reg.lamports().saturating_sub(keep);
    reg.try_borrow_mut_data()?.fill(0); reg.resize(MARKER_SIZE)?; wr32(&mut reg.try_borrow_mut_data()?, 0, M_REG_DEAD); move_lamports(reg, owner, pay)
}

/// Enter's terms check: the record is this season's, hashes to what the entrant sent, and states the fee and mint the entrant expected; the arena agrees with the record on every term
#[inline(never)]
fn check_entry_terms(terms: &AccountInfo, pid: &Pubkey, arena: &[u8], rest: &[u8]) -> ProgramResult {
    check_terms(terms, pid, &arena[A_SEASON..A_SEASON + 8])?; let t = terms.try_borrow_data()?;
    if !terms_match_arena(&t, arena) { return fail(E_TERMS_ACCT); }
    let (fee, mint, hash) = (ru64(rest, 0)?, &rest[8..40], &rest[40..72]);
    if rd64(&t, TM_FEE) != fee || &t[TM_MINT..TM_MINT + 32] != mint || terms_hash(&t)?.as_slice() != hash { return fail(E_TERMS_MISMATCH); }
    Ok(())
}
/// 6 Enter (TEE): [owner(s), strat(w), arena(w), owner_ata(w), pool_ata(w), token_program, config, reg(w), roster(w), terms]; data: expected fee u64, expected stake mint[32], terms hash[32].
/// Counts the entry on the strategy: it cannot be closed until this entry is published or released.
/// The entrant pays only into terms it has read: the season's public terms record must exist, hash to what the entrant sent, state the fee and mint the entrant expected, and agree with the arena field by field (9150, 9151).
/// The strategy's registry must be given WRITABLE (9133). Publish writes it, and the rollup refuses any transaction that marks writable an account it does not hold, changed or not (observed on the devnet TEE),
/// so a strategy whose registry was never delegated here, and could therefore never be published, cannot enter.
#[inline(never)]
fn enter(pid: &Pubkey, accts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    if rest.len() != ENTER_DATA { return Err(ProgramError::InvalidInstructionData); }
    let it = &mut accts.iter();
    let (owner, strat, arena, oe, pe, tp, cfgacc) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    let reg = next_account_info(it)?; let roster = next_account_info(it)?; let terms = next_account_info(it)?;
    check_config(cfgacc, pid)?; if cfg_paused(cfgacc)? { return Err(ProgramError::Custom(9060)); } // paused: no new money enters; everything that unwinds a season stays open
    check_arena(arena, pid)?; check_strat(strat, pid)?;
    let s = strat.try_borrow_data()?; let mut d = arena.try_borrow_mut_data()?; check_pins(&d)?;
    check_entry_terms(terms, pid, &d, rest)?; // before a single token moves
    if !owner.is_signer || &s[S_OWNER..S_OWNER + 32] != owner.key.as_ref() || d[A_FLAGS] & F_LOCKED != 0 { return Err(ProgramError::MissingRequiredSignature); }
    if Clock::get()?.slot >= rd64(&d, A_CREATED).saturating_add(rd64(&d, A_WINDOW)) { return Err(ProgramError::Custom(9030)); } // the entry window is closed
    let (sp, _) = Pubkey::find_program_address(&[b"strat", &s[S_ID..S_ID + 8]], pid); if sp != *strat.key { return Err(bad!()); }
    // publishable: the strategy's own, open registry, writable. Writability is what makes the rollup require it to be delegated here
    if !reg.is_writable || check_reg(reg, pid).is_err() || Pubkey::find_program_address(&[b"reg", &s[S_ID..S_ID + 8]], pid).0 != *reg.key || reg.try_borrow_data()?[R_OWNER..R_OWNER + 32] != s[S_OWNER..S_OWNER + 32] { return fail(E_ENTRY_REGISTRY); }
    let ns = d[A_NS] as usize; if ns >= d[A_MAXS] as usize { return Err(bad!()); }
    check_roster(roster, pid, &d[A_SEASON..A_SEASON + 8])?; if ns >= usize::from(roster.try_borrow_data()?[RO_CAP]) { return fail(E_ROSTER); }
    let l = usize::from(u16::from_le_bytes([s[4], s[5]])); if l > CODE_MAX { return Err(bad!()); } let code = &s[S_CODE..S_CODE + l];
    validate(code).map_err(vm_err)?; if work_of(code) > *DIVISIONS.get(usize::from(d[A_DIV])).ok_or(bad!())? { return Err(ProgramError::Custom(9005)); } // ruleset gate and division gate, again, at entry
    for i in 0..ns { let o = HDR + i * SLOT; if d[o + SL_ID..o + SL_ID + 8] == s[S_ID..S_ID + 8] { return Err(bad!()); } }
    let mint = pk(&d, A_MINT); let sid = d[A_SEASON..A_SEASON + 8].to_vec(); let fee = rd64(&d, A_FEE);
    let (pool, _) = Pubkey::find_program_address(&[b"pool", &sid], pid);
    if *oe.key != ata(owner.key, &mint) || *pe.key != ata(&pool, &mint) { return Err(bad!()); }
    if fee > 0 { token_transfer(oe, pe, owner, tp, fee, &[])?; let np = rd64(&d, A_POOL).checked_add(fee).ok_or(bad!())?; wr64(&mut d, A_POOL, np); }
    let o = HDR + ns * SLOT;
    d[o..o + SLOT].fill(0); d[o + SL_OWNER..o + SL_OWNER + 32].copy_from_slice(&s[S_OWNER..S_OWNER + 32]); d[o + SL_ID..o + SL_ID + 8].copy_from_slice(&s[S_ID..S_ID + 8]); d[o + SL_LEN..o + SL_LEN + 2].copy_from_slice(&(l as u16).to_le_bytes());
    d[o + SL_CODE..o + SL_CODE + l].copy_from_slice(code); d[A_NS] = d[A_NS].checked_add(1).ok_or(bad!())?;
    // the commitment of the code just copied, from the same sealed account
    { let at = RO_HDR + ns * RO_ESZ; roster.try_borrow_mut_data()?.get_mut(at..at + RO_ESZ).ok_or(bad!())?.copy_from_slice(&s[S_COMMIT..S_COMMIT + 32]); }
    drop(s); { let mut s = strat.try_borrow_mut_data()?; let n = (open_raw(&s) & S_OPEN_MASK).checked_add(1).ok_or(ProgramError::ArithmeticOverflow)?; set_open(&mut s, n)?; }
    d[o + SL_BITS] |= B_COUNTED; Ok(())
}
/// 15 Cleanup (permissionless): [crank(s), hub(w), arena(w), permission(w), vault(w), magic, permission_program, receipt(w), roster(w), roster_permission(w), then strat(w) for every entry still counted] closes the ephemeral arena + its permission, refunding rent to the hub sponsor.
/// Allowed when the season is settled and published (or the publish grace has elapsed), or when it was cancelled and refunded. The arena is the only record of which entries are still counted on their
/// strategies, so it is never destroyed while one is: the strategy of every such entry must be named, and is released here (9131 otherwise). The hub is then reconciled against the receipt bond: whatever the arena drew and the close did not return is
/// made up from the bond, 25% of the bond is forfeited to the hub when the creator abandoned the season, and the rest becomes releasable to the creator (ReleaseBond on base after the receipt is committed and undelegated).
#[inline(never)]
fn cleanup(pid: &Pubkey, accts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accts.iter();
    let (crank, hub, arena, perm, vault, magic, pp) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    let (rc, roster, rperm) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    if !crank.is_signer { return Err(ProgramError::MissingRequiredSignature); } check_arena(arena, pid)?;
    let (sid, abump, cancelled, reason, rent) = { let d = arena.try_borrow_data()?; let cancelled = d[A_F2] & F2_CANCELLED != 0;
        if cancelled { if d[A_F2] & F2_REFUNDED == 0 { return fail(E_CLEANUP_STATE); } }
        else { if d[A_FLAGS] & F_SETTLED == 0 { return fail(E_CLEANUP_STATE); }
            // checked entry by entry, not by a counter: inside the grace the arena stays for as long as any entry still needs it to publish
            let unpublished = (0..usize::from(d[A_NS])).any(|i| d[HDR + i * SLOT + SL_BITS] & B_PUBLISHED == 0);
            if unpublished && Clock::get()?.slot < rd64(&d, A_SETTLEDAT).saturating_add(rd64(&d, A_PUBGRACE)) { return fail(E_CLEANUP_UNPUBLISHED); } }
        (d[A_SEASON..A_SEASON + 8].to_vec(), d[A_BUMP], cancelled, if cancelled { d[A_REASON] } else { 0 }, rd64(&d, A_RENT)) };
    // the season's own receipt, writable and open, BEFORE anything is closed (9141): the bond accounting, the forfeit and the hub top-up below can never be skipped
    if !rc.is_writable || !rcpt_ok(rc, pid, &sid) || rc.try_borrow_data()?[RC_STATE] != 1 { return fail(E_CLEANUP_RECEIPT); }
    check_roster(roster, pid, &sid)?; let robump = Pubkey::find_program_address(&[b"roster", &sid], pid).1;
    let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
    { let mut d = arena.try_borrow_mut_data()?; release_named(&mut d, pid, it)?; if (0..usize::from(d[A_NS])).any(|i| d[HDR + i * SLOT + SL_BITS] & B_COUNTED != 0) { return fail(E_ENTRY_HELD); } }
    let hs: &[&[u8]] = &[b"hub", &[hbump]]; let asd: &[&[u8]] = &[b"arena", &sid, &[abump]]; let hub0 = hub.lamports();
    ephemeral_rollups_sdk::access_control::instructions::CloseEphemeralPermissionCpi { payer: hub.clone(), authority: arena.clone(), permissioned_account: arena.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(), authority_is_signer: false }.invoke_signed(&[hs, asd])?;
    EphemeralAccount::new(hub, arena, vault).with_signer_seeds(&[hs]).close()?;
    let rsd: &[&[u8]] = &[b"roster", &sid, &[robump]];
    ephemeral_rollups_sdk::access_control::instructions::CloseEphemeralPermissionCpi { payer: hub.clone(), authority: roster.clone(), permissioned_account: roster.clone(), permission: rperm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(), authority_is_signer: false }.invoke_signed(&[hs, rsd])?;
    EphemeralAccount::new(hub, roster, vault).with_signer_seeds(&[hs]).close()?;
    let reclaimed = hub.lamports().saturating_sub(hub0);
    // reconcile with the bond
    { let mut r = rc.try_borrow_mut_data()?; let bond = rd64(&r, RC_BOND); let topup = rent.saturating_sub(reclaimed).min(bond);
        let abandoned = cancelled && (reason == REASON_UNDERMIN || reason == REASON_CREATOR); let forfeit = if abandoned { (bond / 100 * FORFEIT_PCT).min(bond - topup) } else { 0 };
        move_lamports(rc, hub, (topup + forfeit).min(rc.lamports()))?; wr64(&mut r, RC_RECLAIMED, reclaimed); wr64(&mut r, RC_FORFEIT, forfeit); wr64(&mut r, RC_RELEASE, bond - topup - forfeit); wr64(&mut r, RC_RENT, rent); r[RC_STATE] = 2; }
    Ok(())
}
/// 17 Cancel (TEE, permissionless where the clock allows): [signer(s), arena(w), claims(w), pool_pda, pool_ata, receipt(w), roster, then optional strat(w) accounts of this season's entries]
/// A cancelled season never publishes, so each strategy named is released at once. Naming them is optional: a refund never depends on a strategy account, and Cleanup releases whatever is left.
/// An arena can be cancelled (a) by its creator while unlocked, (b) by anyone once it is locked and the seed has not arrived within the seed timeout, (c) by anyone once the season phase has missed its
/// deadline, or (d) it is already cancelled by an under-minimum Lock. Never once the season phase has finished. Cancel RECORDS each entry's fee as owed; Claim pays it. No entrant token account is touched.
#[inline(never)]
fn cancel(pid: &Pubkey, accts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accts.iter();
    let (crank, arena, claims, pool, pe, rc) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    let roster = next_account_info(it)?;
    if !crank.is_signer { return Err(ProgramError::MissingRequiredSignature); } check_arena(arena, pid)?; let mut d = arena.try_borrow_mut_data()?; check_pins(&d)?;
    if d[A_F2] & F2_REFUNDED != 0 { return Err(ProgramError::Custom(9034)); }
    if d[A_F2] & F2_CANCELLED == 0 {
        let f = d[A_FLAGS]; let locked = f & F_LOCKED != 0; let creator = &d[A_AUTH..A_AUTH + 32] == crank.key.as_ref(); let slot = Clock::get()?.slot;
        if f & (F_SDONE | F_DONE | F_SETTLED) != 0 { return Err(ProgramError::Custom(9033)); }
        let reason = if !locked { if !creator { return Err(ProgramError::Custom(9033)); } REASON_CREATOR }
            else if f & F_SEEDED == 0 { if slot < rd64(&d, A_LOCKAT).saturating_add(rd64(&d, A_SEEDTO)) { return Err(ProgramError::Custom(9033)); } REASON_SEEDTO }
            else { if slot < phase_deadline(rd64(&d, A_START), rd32(&d, A_NEPS), rd32(&d, A_SPT)) { return Err(ProgramError::Custom(9033)); } REASON_DEADLINE };
        d[A_FLAGS] |= F_LOCKED; d[A_F2] |= F2_CANCELLED; d[A_REASON] = reason; }
    let ns = d[A_NS] as usize; let fee = rd64(&d, A_FEE);
    let total = fee.checked_mul(ns as u64).ok_or(bad!())?; if rd64(&d, A_POOL) != total { return Err(ProgramError::Custom(9040)); }
    let owed = vec![fee; ns];
    record_owed(claims, pid, &d, pool, pe, &owed, total, CLAIMS_REFUND)?;
    d[A_F2] |= F2_REFUNDED;
    // public record of the cancellation, and of who was in the field. It is REQUIRED: Cancel runs once, so a record skipped here would be lost for good. The receipt is in the rollup for as long as its arena is
    let season: Vec<u8> = d[A_SEASON..A_SEASON + 8].to_vec(); check_receipt(rc, pid, &season)?; if !rc.is_writable { return fail(9020); } check_roster(roster, pid, &season)?;
    { let mut r = rc.try_borrow_mut_data()?; attribute(&d, roster, &mut r)?; r[RC_KIND] = 2; r[RC_NS] = ns as u8; r[RC_DIV] = d[A_DIV]; r[RC_SEASON..RC_SEASON + 8].copy_from_slice(&season); r[RC_REASON] = d[A_REASON]; wr64(&mut r, RC_REFUNDED, total); wr64(&mut r, RC_OWED, total);
        let pins = &d[A_PINS..A_PINS + PINS_LEN]; r[RC_RULESET..RC_RULESET + 2].copy_from_slice(&pins[0..2]); r[RC_VERSION] = pins[2]; r[RC_GEN] = pins[3]; r[RC_PINS..RC_PINS + PINS_LEN].copy_from_slice(pins);
        for i in 0..ns { let e = RC_ENT + i * RC_ESZ; let id: [u8; 8] = arr::<8>(&d, HDR + i * SLOT + SL_ID)?; r[e..e + 8].copy_from_slice(&id); } }
    release_named(&mut d, pid, it)
}
/// 5 CreateSeason (TEE): [authority(s), hub(w), arena(w), permission(w), vault(w), magic, permission_program, receipt(w), config, claims(w), roster(w), roster_permission(w), terms(w)]
/// The last account is the public terms record, written once here and closed with the claims account.
/// data: season u64, neps u32, spt u32, fee u64, mint[32], maxs u8, flags u8, division u8, window u64 (entry window, slots), seed_timeout u64 (slots after lock), publish_grace u64 (slots after settle), min_entrants u8
/// The receipt must be fresh and carry the creator's bond (lamports posted at InitReceipt); a receipt opens exactly one arena, so a season id can never be created twice against one bond.
#[inline(never)]
fn create_season(pid: &Pubkey, accts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accts.iter();
    let (auth, hub, arena, perm, vault, magic, pp, rc, cfgacc) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    let claims = next_account_info(it)?;
    let (roster, rperm) = (next_account_info(it)?, next_account_info(it)?); let terms = next_account_info(it)?;
    if !auth.is_signer || rest.len() < 84 { return Err(ProgramError::MissingRequiredSignature); }
    let sid = &rest[0..8]; let maxs = rest[56] as usize; let division = rest[58] as usize; let (neps_in, spt_in) = (ru32(rest, 8)?, ru32(rest, 12)?); if maxs == 0 || maxs > MAX_SLOTS || division >= DIVISIONS.len() { return Err(bad!()); }
    // bounds: a season must be able to finish well inside its deadline, whatever the creator asks for
    if neps_in == 0 || neps_in > MAX_EPISODES { return fail(E_EPISODES); } if spt_in == 0 || spt_in > MAX_SPT { return fail(E_SPT); }
    if rest[57] & !F2_HASFIN != 0 { return fail(E_SEASON_FLAGS); }
    let finals_on = rest[57] & F2_HASFIN != 0; if finals_on && neps_in < MIN_EPISODES_WITH_FINALS { return fail(E_SHORT_SEASON_FOR_FINALS); }
    if (u64::from(neps_in) + if finals_on { u64::from(FINALS_EPISODES) } else { 0 }) * world::WORLD_T as u64 * u64::from(spt_in) > MAX_RUN_SLOTS { return fail(E_RUN_TOO_LONG); }
    let (window, seedto, grace, mins) = (ru64(rest, 59)?, ru64(rest, 67)?, ru64(rest, 75)?, rest[83]);
    if grace < MIN_GRACE { return fail(E_GRACE_TOO_SHORT); }
    if window == 0 || window > MAX_ENTRY_WINDOW || seedto == 0 || seedto > MAX_SEEDTO || grace > MAX_GRACE || mins == 0 || usize::from(mins) > maxs { return Err(ProgramError::Custom(9035)); }
    let (ap, abump) = Pubkey::find_program_address(&[b"arena", sid], pid); if ap != *arena.key { return Err(bad!()); }
    let (hp, hbump) = Pubkey::find_program_address(&[b"hub"], pid); if hp != *hub.key { return Err(bad!()); }
    // access guards: not while paused, and only an allowlisted stake mint (rules out mints with freeze authorities, transfer hooks or other surprises)
    check_config(cfgacc, pid)?; if cfg_paused(cfgacc)? { return Err(ProgramError::Custom(9060)); }
    { let c = cfgacc.try_borrow_data()?; let n = usize::from(c[C_NMINTS]).min(MAX_MINTS); if !(0..n).any(|i| c[C_MINTS + i * 32..C_MINTS + i * 32 + 32] == rest[24..56]) { return Err(ProgramError::Custom(9061)); } }
    check_receipt(rc, pid, sid)?; if !rc.is_writable { return Err(bad!()); }
    { let r = rc.try_borrow_data()?; if r[RC_STATE] != 0 { return Err(ProgramError::Custom(9051)); } if &r[RC_CREATOR..RC_CREATOR + 32] != auth.key.as_ref() { return Err(ProgramError::Custom(9052)); }
      let bond = rd64(&r, RC_BOND); if bond < BOND_MIN { return Err(ProgramError::Custom(9050)); } if rc.lamports() < bond { return Err(ProgramError::Custom(9053)); } }
    let hs: &[&[u8]] = &[b"hub", &[hbump]]; let asd: &[&[u8]] = &[b"arena", sid, &[abump]]; let slot = Clock::get()?.slot; let hub0 = hub.lamports();
    EphemeralAccount::new(hub, arena, vault).with_signer_seeds(&[hs, asd]).create(arena_size(maxs) as u32)?;
    if arena.try_data_len()? < arena_size(maxs) { return Err(ProgramError::AccountDataTooSmall); }
    { let mut d = arena.try_borrow_mut_data()?; d[0..4].copy_from_slice(&M_ARENA.to_le_bytes()); d[A_MAXS] = maxs as u8; d[A_AUTH..A_AUTH + 32].copy_from_slice(auth.key.as_ref()); d[A_SEASON..A_SEASON + 8].copy_from_slice(sid);
      wr32(&mut d, A_NEPS, ru32(rest, 8)?); wr32(&mut d, A_SPT, ru32(rest, 12)?); wr64(&mut d, A_FEE, ru64(rest, 16)?); d[A_MINT..A_MINT + 32].copy_from_slice(&rest[24..56]); d[A_BUMP] = abump;
      d[A_F2] = rest[57] & F2_HASFIN; d[A_DIV] = division as u8; d[A_PINS..A_PINS + PINS_LEN].copy_from_slice(&pins_bytes());
      wr64(&mut d, A_CREATED, slot); wr64(&mut d, A_WINDOW, window); wr64(&mut d, A_SEEDTO, seedto); wr64(&mut d, A_PUBGRACE, grace); d[A_MINS] = mins; }
    // private, members = [] : nobody (not even the authority) can read the arena
    CreateEphemeralPermissionCpi { payer: hub.clone(), permissioned_account: arena.clone(), permission: perm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
        args: EphemeralMembersArgs { is_private: true, members: vec![] } }.invoke_signed(&[hs, asd])?;
    // the roster: who is in the field, kept as private as the arena (no members) until Settle or Cancel puts it on the receipt. Created with the arena, and counted in the same rent
    let (rop, robump) = Pubkey::find_program_address(&[b"roster", sid], pid); if rop != *roster.key { return fail(E_ROSTER); }
    let rsd: &[&[u8]] = &[b"roster", sid, &[robump]];
    EphemeralAccount::new(hub, roster, vault).with_signer_seeds(&[hs, rsd]).create(roster_size(maxs) as u32)?;
    if roster.try_data_len()? < roster_size(maxs) { return Err(ProgramError::AccountDataTooSmall); }
    { let mut d = roster.try_borrow_mut_data()?; d[0..4].copy_from_slice(&M_ROSTER.to_le_bytes()); d[RO_CAP] = maxs as u8; d[RO_SEASON..RO_SEASON + 8].copy_from_slice(sid); }
    CreateEphemeralPermissionCpi { payer: hub.clone(), permissioned_account: roster.clone(), permission: rperm.clone(), vault: vault.clone(), magic_program: magic.clone(), permission_program: pp.clone(),
        args: EphemeralMembersArgs { is_private: true, members: vec![] } }.invoke_signed(&[hs, rsd])?;
    // what this arena, its roster and their permissions drew from the shared hub, measured; reconciled against the refund and the bond at Cleanup
    let rent = hub0.saturating_sub(hub.lamports()); wr64(&mut arena.try_borrow_mut_data()?, A_RENT, rent);
    // the claims account is created now, so recording what is owed can never fail for want of hub funds later. It is public (no permission account) and outlives the arena until every claim is paid;
    // its rent is measured separately and returns to the hub at CloseClaims, never touching the creator's bond
    let (cp, cbump) = Pubkey::find_program_address(&[b"claims", sid], pid); if cp != *claims.key { return fail(E_CLAIMS_ACCT); }
    let csd: &[&[u8]] = &[b"claims", sid, &[cbump]]; let hub1 = hub.lamports();
    EphemeralAccount::new(hub, claims, vault).with_signer_seeds(&[hs, csd]).create(claims_size(maxs) as u32)?;
    if claims.try_data_len()? < claims_size(maxs) { return Err(ProgramError::AccountDataTooSmall); }
    { let crent = hub1.saturating_sub(hub.lamports()); let mut c = claims.try_borrow_mut_data()?; c[0..4].copy_from_slice(&M_CLAIMS.to_le_bytes()); c[CL_CAP] = maxs as u8; c[CL_SEASON..CL_SEASON + 8].copy_from_slice(sid); wr64(&mut c, CL_RENT, crent); }
    write_terms(pid, hub, terms, vault, rest, auth.key, hbump)?;
    let mut r = rc.try_borrow_mut_data()?; r[RC_STATE] = 1; wr64(&mut r, RC_RENT, rent); Ok(())
}
/// the public terms record, created with the arena from the same inputs and paid for by the hub like the claims account: its rent is measured on its own and returns at CloseClaims, never touching the bond
#[inline(never)]
fn write_terms<'a>(pid: &Pubkey, hub: &AccountInfo<'a>, terms: &AccountInfo<'a>, vault: &AccountInfo<'a>, rest: &[u8], creator: &Pubkey, hbump: u8) -> ProgramResult {
    let sid = &rest[0..8]; let (tp, tbump) = Pubkey::find_program_address(&[b"terms", sid], pid); if tp != *terms.key { return fail(E_TERMS_ACCT); }
    let hs: &[&[u8]] = &[b"hub", &[hbump]]; let tsd: &[&[u8]] = &[b"terms", sid, &[tbump]]; let hub0 = hub.lamports();
    EphemeralAccount::new(hub, terms, vault).with_signer_seeds(&[hs, tsd]).create(TERMS_SIZE as u32)?;
    if terms.try_data_len()? < TERMS_SIZE { return Err(ProgramError::AccountDataTooSmall); }
    let trent = hub0.saturating_sub(hub.lamports()); let mut t = terms.try_borrow_mut_data()?;
    t[0..4].copy_from_slice(&M_TERMS.to_le_bytes()); t[TM_VERSION] = TERMS_VERSION; t[TM_SEASON..TM_SEASON + 8].copy_from_slice(sid); t[TM_CREATOR..TM_CREATOR + 32].copy_from_slice(creator.as_ref()); t[TM_MINT..TM_MINT + 32].copy_from_slice(&rest[24..56]);
    t[TM_FEE..TM_FEE + 8].copy_from_slice(&rest[16..24]); t[TM_NEPS..TM_NEPS + 4].copy_from_slice(&rest[8..12]); t[TM_SPT..TM_SPT + 4].copy_from_slice(&rest[12..16]);
    t[TM_WINDOW..TM_WINDOW + 8].copy_from_slice(&rest[59..67]); t[TM_SEEDTO..TM_SEEDTO + 8].copy_from_slice(&rest[67..75]); t[TM_GRACE..TM_GRACE + 8].copy_from_slice(&rest[75..83]);
    t[TM_MAXS] = rest[56]; t[TM_MINS] = rest[83]; t[TM_FLAGS] = rest[57] & F2_HASFIN; t[TM_DIV] = rest[58]; t[TM_PINS..TM_PINS + PINS_LEN].copy_from_slice(&pins_bytes());
    wr64(&mut t, TM_RENT, trent); Ok(())
}
/// 10 Settle (permissionless): [crank(s), arena(w), receipt(w), claims(w), pool_pda, pool_ata, roster, then optional (strat(w), reg(w)) pairs for entries 0, 1, 2, ...]
/// Allowed when nothing is left to run, or when the finals are void (their seed or their run missed its deadline). Final ranks are fixed, and what each entry is OWED is recorded in the claims account: no token moves
/// and no entrant token account is touched, so no entrant can block it. Money guards: pool bookkeeping equals fee x entrants (9040), the pool token account holds the pot (9041), the amounts owed sum to the pot (9042).
#[inline(never)]
fn settle(pid: &Pubkey, accts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accts.iter();
    let (_crank, arena, receipt, claims, pool, pe) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    let roster = next_account_info(it)?;
    check_arena(arena, pid)?; let mut d = arena.try_borrow_mut_data()?; check_pins(&d)?;
    let f = d[A_FLAGS]; if f & F_SETTLED != 0 || d[A_F2] & F2_CANCELLED != 0 { return fail(E_SETTLE_STATE); }
    let slot = Clock::get()?.slot; let ns = d[A_NS] as usize; let has_finals = d[A_F2] & F2_HASFIN != 0;
    // (finals status, void reason). A finals run that reached DONE did so before its deadline (Advance refuses to run past it), so the outcome never depends on who settles or when
    let (status, reason) = if f & F_DONE != 0 { if !has_finals { (FS_NONE, 0) } else if d[A_F2] & F2_THINFIELD != 0 { (FS_VOIDED, REASON_FINALS_FIELD) } else { (FS_PLAYED, 0) } }
        else if f & F_SDONE != 0 {
            if f & F_FSEEDED == 0 { if slot < rd64(&d, A_SDONEAT).saturating_add(FINALS_SEEDTO) { return fail(E_NOT_SETTLEABLE); } (FS_VOIDED, REASON_FINALS_SEEDTO) }
            else { if slot < phase_deadline(rd64(&d, A_START), FINALS_EPISODES, rd32(&d, A_SPT)) { return fail(E_NOT_SETTLEABLE); } (FS_VOIDED, REASON_FINALS_DEADLINE) } }
        else { return fail(E_NOT_SETTLEABLE) };
    check_receipt(receipt, pid, &d[A_SEASON..A_SEASON + 8])?; { if receipt.try_borrow_data()?[RC_NS] != 0 { return Err(ProgramError::Custom(9021)); } } check_roster(roster, pid, &d[A_SEASON..A_SEASON + 8])?;
    let played = status == FS_PLAYED;
    // voided finals: every partial finals score is discarded
    if !played { for i in 0..ns { let o = HDR + i * SLOT; wr64(&mut d, o + SL_FTOTAL, 0); d[o + SL_BITS] &= !B_FINALIST; } }
    // final rank = frozen season rank; played finals reorder the qualifiers among themselves by season + finals total, ties to the better season rank
    for i in 0..ns { let o = HDR + i * SLOT; let r = u32::from(d[o + SL_SRANK]); wr32(&mut d, o + SL_RANK, r); }
    let qualified = if played { let mut q: Vec<usize> = (0..ns).filter(|&i| d[HDR + i * SLOT + SL_BITS] & B_FINALIST != 0).collect();
        let key = |d: &[u8], i: usize| { let o = HDR + i * SLOT; rdi64(d, o + SL_TOTAL).saturating_add(rdi64(d, o + SL_FTOTAL)) };
        q.sort_by(|&a, &b| key(&d, b).cmp(&key(&d, a)).then(d[HDR + a * SLOT + SL_SRANK].cmp(&d[HDR + b * SLOT + SL_SRANK])));
        for (pos, &i) in q.iter().enumerate() { wr32(&mut d, HDR + i * SLOT + SL_RANK, pos as u32 + 1); } q.len() as u8 } else { 0 };
    if status == FS_VOIDED { d[A_REASON] = reason; }
    // 50/30/20 of the whole pot by final rank (60/40 with two entrants, all of it with one); the last paid rank takes the remainder
    let gross = rd64(&d, A_POOL); let fee = rd64(&d, A_FEE);
    if gross != fee.checked_mul(ns as u64).ok_or(bad!())? { return Err(ProgramError::Custom(9040)); } // the pool bookkeeping is exactly what the entrants paid
    let shares: &[u64] = match ns { 1 => &[100], 2 => &[60, 40], _ => &[50, 30, 20] }; let np = shares.len().min(ns);
    let mut amounts = [0u64; 3]; let mut sum = 0u64; for k in 0..np { amounts[k] = if k == np - 1 { gross.checked_sub(sum).ok_or(bad!())? } else { u64::try_from(u128::from(gross) * u128::from(shares[k]) / 100).map_err(|_| bad!())? }; sum = sum.checked_add(amounts[k]).ok_or(bad!())?; }
    let owed: Vec<u64> = (0..ns).map(|i| { let r = rd32(&d, HDR + i * SLOT + SL_RANK) as usize; if r >= 1 && r <= np { amounts[r - 1] } else { 0 } }).collect();
    record_owed(claims, pid, &d, pool, pe, &owed, gross, CLAIMS_PAYOUT)?;
    // season receipt header, both rank lists, and each entry's owner and code commitment (score commitments are filled by Publish, which has the salts)
    { let mut r = receipt.try_borrow_mut_data()?; attribute(&d, roster, &mut r)?; let seed: [u8; 32] = arr::<32>(&d, A_SEED)?; let (sa, sb) = world::season_words(&seed); let packs = world::season_packs(sa, sb);
      r[RC_KIND] = 0; r[RC_NS] = ns as u8; r[RC_DIV] = d[A_DIV]; r[RC_SEASON..RC_SEASON + 8].copy_from_slice(&d[A_SEASON..A_SEASON + 8]);
      let pins = &d[A_PINS..A_PINS + PINS_LEN]; r[RC_RULESET..RC_RULESET + 2].copy_from_slice(&pins[0..2]); r[RC_VERSION] = pins[2]; r[RC_GEN] = pins[3]; r[RC_PACKS] = packs[0] as u8; r[RC_PACKS + 1] = packs[1] as u8;
      wr32(&mut r, RC_NEPS, rd32(&d, A_NEPS)); wr64(&mut r, RC_SEEDA, sa); wr64(&mut r, RC_SEEDB, sb); r[RC_PINS..RC_PINS + PINS_LEN].copy_from_slice(pins);
      r[RC_FSTATUS] = status; r[RC_FQUAL] = qualified; r[RC_REASON] = reason; wr64(&mut r, RC_OWED, gross);
      if played { let fs: [u8; 32] = arr::<32>(&d, A_FSEED)?; let (fa, fb) = world::season_words(&fs); let fp = world::season_packs(fa, fb); wr64(&mut r, RC_FSEEDA, fa); wr64(&mut r, RC_FSEEDB, fb); r[RC_FPACKS] = fp[0] as u8; r[RC_FPACKS + 1] = fp[1] as u8; wr32(&mut r, RC_FNEPS, FINALS_EPISODES); }
      for i in 0..ns { let e = RC_ENT + i * RC_ESZ; let o = HDR + i * SLOT; let id: [u8; 8] = arr::<8>(&d, o + SL_ID)?; r[e..e + 8].copy_from_slice(&id); let rk = rd32(&d, o + SL_RANK); wr32(&mut r, e + RE_FRANK, rk); r[e + RE_SRANK..e + RE_SRANK + 2].copy_from_slice(&u16::from(d[o + SL_SRANK]).to_le_bytes()); r[e + RE_FINALIST] = u8::from(d[o + SL_BITS] & B_FINALIST != 0); } }
    d[A_FLAGS] |= F_SETTLED | F_DONE; wr64(&mut d, A_SETTLEDAT, slot);
    let extra: Vec<&AccountInfo> = it.collect(); for j in 0..(extra.len() / 2).min(ns) { publish_entry(&mut d, j, extra[2 * j], extra[2 * j + 1], receipt, pid)?; }
    Ok(())
}
fn vrf_callback(pid: &Pubkey, accts: &[AccountInfo], rest: &[u8], finals: bool) -> ProgramResult {
    let it = &mut accts.iter(); let (identity, arena) = (next_account_info(it)?, next_account_info(it)?);
    let expect = Pubkey::find_program_address(&[b"identity", pid.as_ref()], &VRF_PROGRAM_ID.modern()).0;
    if !identity.is_signer || *identity.key != expect { return Err(ProgramError::MissingRequiredSignature); }
    check_arena(arena, pid)?; let mut d = arena.try_borrow_mut_data()?; check_pins(&d)?;
    let f = d[A_FLAGS]; let waiting = if finals { f & F_SDONE != 0 && f & F_FREQ != 0 && f & F_FSEEDED == 0 && f & (F_DONE | F_SETTLED) == 0 } else { f & F_REQ != 0 && f & (F_SEEDED | F_SDONE | F_DONE | F_SETTLED) == 0 };
    if !waiting || d[A_F2] & F2_CANCELLED != 0 || rest.len() < 32 { return Err(bad!()); }
    // a seed that arrives after its timeout is refused: from that slot on the fallback is the only outcome, whoever acts first
    let slot = Clock::get()?.slot; let expires = if finals { rd64(&d, A_SDONEAT).saturating_add(FINALS_SEEDTO) } else { rd64(&d, A_LOCKAT).saturating_add(rd64(&d, A_SEEDTO)) };
    if slot >= expires { return fail(E_SEED_LATE); }
    let at = if finals { A_FSEED } else { A_SEED }; d[at..at + 32].copy_from_slice(&rest[..32]); d[A_FLAGS] |= if finals { F_FSEEDED } else { F_SEEDED }; wr64(&mut d, A_START, slot); wr32(&mut d, A_CUREP, 0); wr32(&mut d, A_CURTICK, 0);
    Market::new(world::WORLD_T as u32).save(&mut d[A_MKT..A_MKT + Market::BYTES]);
    let ns = d[A_NS] as usize; for i in 0..ns { Seat::new().save(&mut d[HDR + i * SLOT + SL_SEAT..HDR + i * SLOT + SL_SEAT + Seat::BYTES]); }
    Ok(())
}
fn undelegate_cb(pid: &Pubkey, accts: &[AccountInfo], rest: &[u8]) -> ProgramResult {
    let it = &mut accts.iter(); let (pda, buf, payer, sys) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    // seeds arrive as a borsh Vec<Vec<u8>> from the delegation program; every length is checked, a short or hostile payload is an error
    let n = ru32(rest, 0)? as usize; if n > 16 { return Err(ProgramError::InvalidInstructionData); } let mut seeds: Vec<Vec<u8>> = Vec::with_capacity(n); let mut o = 4usize;
    for _ in 0..n { let l = ru32(rest, o)? as usize; o = o.checked_add(4).ok_or(ProgramError::InvalidInstructionData)?; let e = o.checked_add(l).ok_or(ProgramError::InvalidInstructionData)?; seeds.push(rest.get(o..e).ok_or(ProgramError::InvalidInstructionData)?.to_vec()); o = e; }
    undelegate_account(pda, pid, buf, payer, sys, seeds)
}
