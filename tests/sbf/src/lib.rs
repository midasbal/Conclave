//! SBF leg of the conformance gate: the same `run_vector` as every other target, run by the real SBF VM. Output goes back as return data.
use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, program::set_return_data, pubkey::Pubkey};
entrypoint!(process);
fn process(_: &Pubkey, _: &[AccountInfo], data: &[u8]) -> ProgramResult { let out = conclave_conformance::run_vector(data); set_return_data(&out[..out.len().min(1024)]); Ok(()) }
