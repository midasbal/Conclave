//! Stand-ins for the programs that only exist inside the rollup validators (or need an oracle), loaded at their real addresses in the in-process SVM.
//! The conclave program under test is the REAL compiled bytecode and talks to the REAL System, SPL Token and Associated Token programs; only these are stood in:
//!   Magic program         ephemeral account create (checks the size the program asked for and that the account is fresh), close (checks the sponsor signed), everything else accepted.
//!                         It moves no lamports: a program cannot debit accounts it does not own. Ephemeral rent is applied by the test harness from the CPIs the program really made (common/mod.rs, `model_rent`)
//!   permission program    accepted (read privacy is enforced by the TEE, not by this SVM)
//!   VRF oracle program    accepted (the test then delivers the callback itself)
//!   eSPL program          accepted (the base-layer eATA bookkeeping)
//!   delegation program    accepted
//! The same binary is loaded at every address; behaviour depends on the address it was invoked as.
use solana_program::{account_info::{next_account_info, AccountInfo}, entrypoint, entrypoint::ProgramResult, program_error::ProgramError, pubkey::Pubkey};
entrypoint!(process);
const MAGIC: Pubkey = solana_program::pubkey!("Magic11111111111111111111111111111111111111");
const CREATE_EPHEMERAL: u32 = 12; // bincode variant index of MagicBlockInstruction::CreateEphemeralAccount
const CLOSE_EPHEMERAL: u32 = 14;
fn process(pid: &Pubkey, accts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if *pid != MAGIC || data.len() < 4 { return Ok(()); }
    let tag = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    if tag == CLOSE_EPHEMERAL { return if next_account_info(&mut accts.iter())?.is_signer { Ok(()) } else { Err(ProgramError::MissingRequiredSignature) }; }
    if tag != CREATE_EPHEMERAL { return Ok(()); }
    let it = &mut accts.iter(); let (_sponsor, eph, _vault) = (next_account_info(it)?, next_account_info(it)?, next_account_info(it)?);
    if data.len() < 8 { return Err(ProgramError::InvalidInstructionData); }
    let want = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    // the real Magic program requires the new account to sign (squatting protection) and to be fresh; the test harness provisions the account with exactly the size the program must request
    if !eph.is_signer { return Err(ProgramError::MissingRequiredSignature); }
    if eph.data_len() != want { return Err(ProgramError::InvalidAccountData); }
    if eph.try_borrow_data()?.iter().take(4).any(|b| *b != 0) { return Err(ProgramError::AccountAlreadyInitialized); }
    Ok(())
}
