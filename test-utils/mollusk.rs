//! Mollusk setup for the examples' program tests.
//!
//! Include it with `#[path = ".../test-utils/mollusk.rs"] mod mollusk;`. It
//! needs `mollusk-svm`, `solana-account`, `solana-instruction`,
//! `solana-program-error` and `solana-pubkey`.
#![allow(dead_code)]

use std::sync::Once;

use mollusk_svm::{result::ProgramResult, Mollusk};
use solana_account::Account;
use solana_instruction::Instruction;
use solana_program_error::ProgramError;
use solana_pubkey::Pubkey;

static SETUP: Once = Once::new();

/// A Mollusk instance with the SBF program `program_name` from `sbf_out_dir`
/// loaded at `program_id`. The first call in a process sets `SBF_OUT_DIR` and
/// quiets `RUST_LOG` unless the caller set it.
pub fn mollusk_with_program(
    sbf_out_dir: &str,
    program_id: [u8; 32],
    program_name: &str,
) -> (Mollusk, Pubkey) {
    SETUP.call_once(|| {
        std::env::set_var("SBF_OUT_DIR", sbf_out_dir);
        if std::env::var_os("RUST_LOG").is_none() {
            std::env::set_var("RUST_LOG", "error");
        }
    });
    let program_id = Pubkey::new_from_array(program_id);
    let mut mollusk = Mollusk::default();
    mollusk.add_program(&program_id, program_name);
    (mollusk, program_id)
}

/// Assert the instruction fails with exactly `expected`.
#[track_caller]
pub fn expect_err_exact(
    mollusk: &Mollusk,
    instruction: &Instruction,
    accounts: &[(Pubkey, Account)],
    expected: ProgramError,
) {
    let result = mollusk.process_instruction(instruction, accounts);
    assert_eq!(
        result.program_result,
        ProgramResult::Failure(expected),
        "unexpected program result"
    );
}
