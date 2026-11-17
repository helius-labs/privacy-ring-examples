//! Proving helpers for the examples' localnet tests and benchmarks: the
//! nullifier keys a proof completes its inputs with, the fixture nullifier
//! tree with the non-inclusion witnesses of padding inputs, and the shared SPP
//! prover.
//!
//! Include it with `#[path = ".../test-utils/proving.rs"] mod proving;`. It
//! needs `num-bigint`, `spr-client`, `spr-hasher`, `spr-interface`,
//! `spr-keypair`, `spr-merkle-tree` and `spr-transaction`.
#![allow(dead_code)]

use std::{env, path::Path};

use num_bigint::BigUint;
use spr_client::{
    ClientError, MerkleContext, NonInclusionProof, ProofAuthority, TransferInput,
    NULLIFIER_TREE_HEIGHT,
};
use spr_hasher::Poseidon;
use spr_keypair::NullifierKey;
use spr_merkle_tree::indexed::IndexedMerkleTree;
use spr_transaction::instructions::transact::{SppProofInputs, BN254_MODULUS_DEC};

/// Complete each input with the key whose nullifier it carries.
pub struct ProofKeys<'a>(pub &'a [&'a NullifierKey]);

impl ProofAuthority for ProofKeys<'_> {
    fn complete_inputs(&self, inputs: &mut [TransferInput]) -> Result<(), ClientError> {
        for (index, input) in inputs.iter_mut().enumerate() {
            if input.nullifier_secret.is_some() {
                continue;
            }
            let hash = input.utxo.hash()?;
            let key = self
                .0
                .iter()
                .find(|key| {
                    key.nullifier(&hash, &input.utxo.blinding)
                        .is_ok_and(|nullifier| {
                            BigUint::from_bytes_be(&nullifier) == input.nullifier
                        })
                })
                .ok_or(ClientError::InputNullifierMismatch { index })?;
            key.complete_inputs(std::slice::from_mut(input))?;
        }
        Ok(())
    }
}

/// An empty nullifier tree, as a freshly created pool tree holds it.
pub fn nullifier_tree() -> IndexedMerkleTree<Poseidon, usize> {
    let modulus_minus_one =
        BigUint::parse_bytes(BN254_MODULUS_DEC.as_bytes(), 10).expect("parse bn254 modulus") - 1u32;
    IndexedMerkleTree::<Poseidon, usize>::new_with_next_value(
        NULLIFIER_TREE_HEIGHT,
        0,
        modulus_minus_one,
    )
    .expect("nullifier tree")
}

/// Non-inclusion witnesses of the padding inputs of `transaction` in a fresh
/// nullifier tree.
pub fn dummy_proofs(transaction: &SppProofInputs) -> Vec<NonInclusionProof> {
    let tree = nullifier_tree();
    transaction
        .input_utxos
        .iter()
        .filter(|input| input.is_dummy())
        .map(|input| {
            let proof = tree
                .get_non_inclusion_proof(&BigUint::from_bytes_be(&input.nullifier))
                .expect("dummy non-inclusion");
            NonInclusionProof {
                leaf: input.nullifier,
                merkle_context: MerkleContext {
                    tree_type: 1,
                    tree: spr_interface::pda::tree(input.tree_id),
                },
                path: proof.merkle_proof.to_vec(),
                low_element: proof.leaf_lower_range_value,
                low_element_index: proof.leaf_index as u64,
                high_element: proof.leaf_higher_range_value,
                high_element_index: 0,
                root: tree.root(),
                root_seq: 0,
                root_index: 0,
            }
        })
        .collect()
}

/// Start the shared SPP prover, or reuse a running one, with the keys in
/// `ZOLANA_PROVER_KEYS_DIR` (default `~/.config/zolana/proving-keys`).
pub fn start_prover() {
    if env::var_os("ZOLANA_PROVER_KEYS_DIR").is_none() {
        let home = env::var("HOME").expect("HOME is set");
        env::set_var(
            "ZOLANA_PROVER_KEYS_DIR",
            Path::new(&home).join(".config/zolana/proving-keys"),
        );
    }
    spr_client::spawn_prover().expect("spawn prover");
}
