//! UTXO and transaction fixtures for the examples' tests, built on the
//! published `spr-transaction` and `spr-keypair` crates: committed input
//! UTXOs, output blindings, the transaction viewing key and output encryption.
//!
//! Include it with `#[path = ".../test-utils/utxo.rs"] mod utxo;`. It needs
//! `anyhow`, `solana-address`, `spr-interface`, `spr-keypair` and
//! `spr-transaction`.
#![allow(dead_code)]

use anyhow::{anyhow, Result};
use solana_address::Address;
use spr_interface::instruction::{OwnerTag, TransactOutput};
use spr_keypair::{random_blinding, random_salt, NullifierKey, ShieldedKeypair, ViewingKey};
use spr_transaction::{
    instructions::transact::{ExternalData, SppProofInputs, SppProofOutputUtxo},
    serialization::{
        confidential::{Confidential, ConfidentialEncode, ConfidentialOutputPlaintext},
        UtxoSerialization,
    },
    utxo::{derive_output_blinding_seed, derive_transact_output_blinding, SppProofInputUtxo},
    Utxo, WalletUtxo,
};

/// `utxo` as a wallet UTXO owned by `key`, committed at `leaf_index` of tree
/// `tree_id` with no data or ring data hash.
pub fn wallet_utxo(utxo: Utxo, key: &NullifierKey, tree_id: u16, leaf_index: u64) -> WalletUtxo {
    let nullifier_pubkey = key.pubkey().expect("nullifier pubkey");
    let utxo_hash = utxo
        .hash(&nullifier_pubkey, &[0; 32], &[0; 32], tree_id)
        .expect("input hash");
    let nullifier = key
        .nullifier(&utxo_hash, &utxo.blinding)
        .expect("input nullifier");
    WalletUtxo {
        utxo,
        nullifier_pubkey,
        utxo_hash,
        nullifier,
        tx_viewing_key: None,
        data_hash: None,
        ring_data_hash: None,
        tree_id,
        leaf_index,
        latest_tree_id: None,
        slot: 0,
        tx_signature: Default::default(),
        slot_index: 0,
    }
}

/// The proof inputs `sender` posts spending `input_utxos` into
/// `output_utxos` under a random blinding seed and salt: each output blinding
/// is derived from the first input's nullifier, and each output is encrypted
/// to its owner and published under `output_tree_id`.
pub fn test_transaction(
    input_utxos: Vec<SppProofInputUtxo>,
    mut output_utxos: Vec<SppProofOutputUtxo>,
    sender: &ShieldedKeypair,
    output_tree_id: u16,
) -> SppProofInputs {
    let blinding_seed =
        prepare_output_blindings(&input_utxos, &mut output_utxos).expect("output blindings");
    let tx = get_transaction_viewing_key(sender, &input_utxos).expect("transaction viewing key");
    let external_data =
        encrypt_transaction_data(&output_utxos, &tx, output_tree_id).expect("encrypted outputs");
    SppProofInputs {
        input_utxos,
        output_utxos,
        blinding_seed,
        output_tree_id,
        external_data,
        payer: Address::default(),
        cache_accounts: Default::default(),
    }
}

/// Set each output's blinding from the first nullifier and the output
/// blinding seed, by slot index.
pub fn assign_output_blindings(
    outputs: &mut [SppProofOutputUtxo],
    first_nullifier: &[u8; 32],
    seed: &[u8; 32],
) -> Result<()> {
    for (index, output) in (0u32..).zip(outputs.iter_mut()) {
        output.blinding = derive_transact_output_blinding(first_nullifier, seed, index)?;
    }
    Ok(())
}

/// Draw a random blinding seed and assign every output blinding from it.
/// Returns the seed, which goes into `SppProofInputs::blinding_seed`.
pub fn prepare_output_blindings(
    input_utxos: &[SppProofInputUtxo],
    outputs: &mut [SppProofOutputUtxo],
) -> Result<[u8; 32]> {
    let blinding_seed = random_blinding();
    let first_nullifier = first_nullifier(input_utxos)?;
    let seed = derive_output_blinding_seed(&first_nullifier, &blinding_seed)?;
    assign_output_blindings(outputs, &first_nullifier, &seed)?;
    Ok(blinding_seed)
}

/// The viewing key of the transaction spending `input_utxos`, derived from the
/// first input's nullifier.
pub fn get_transaction_viewing_key(
    keypair: &ShieldedKeypair,
    input_utxos: &[SppProofInputUtxo],
) -> Result<ViewingKey> {
    Ok(keypair.get_transaction_viewing_key(&first_nullifier(input_utxos)?)?)
}

fn first_nullifier(input_utxos: &[SppProofInputUtxo]) -> Result<[u8; 32]> {
    Ok(input_utxos
        .first()
        .ok_or_else(|| anyhow!("the transaction has no inputs"))?
        .nullifier)
}

/// The external data of a transaction that publishes `outputs` under
/// `output_tree_id`, each encrypted to its own owner under a random salt, with
/// no messages and no expiry.
pub fn encrypt_transaction_data(
    outputs: &[SppProofOutputUtxo],
    transaction_viewing_key: &ViewingKey,
    output_tree_id: u16,
) -> Result<ExternalData> {
    let salt = random_salt();
    let mut transact_outputs = Vec::with_capacity(outputs.len());
    let mut resolved_owner_tags = Vec::with_capacity(outputs.len());
    for (slot_index, output) in (0u32..).zip(outputs) {
        let address = output
            .owner_address
            .ok_or_else(|| anyhow!("output {slot_index} has no owner"))?;
        let message = Confidential::encode_plaintext(
            &ConfidentialOutputPlaintext {
                asset_id: output.asset.asset_id,
                amount: output.amount,
                blinding: output.blinding,
                ring_program_id: output.ring_program_id,
                data: output.data.clone(),
            },
            address.signing_pubkey.confidential_view_tag()?,
            &ConfidentialEncode {
                tx: transaction_viewing_key.clone(),
                recipient_pubkey: address.viewing_pubkey,
                salt,
                slot_index,
            },
        )?;
        transact_outputs.push(TransactOutput {
            utxo_hash: output.hash(output_tree_id)?,
            owner_tag: OwnerTag::Inline(message.view_tag),
            data: Some(message.data),
        });
        resolved_owner_tags.push(message.view_tag);
    }
    Ok(ExternalData::new(
        *transaction_viewing_key.pubkey().as_bytes(),
        salt,
        transact_outputs,
        resolved_owner_tags,
        vec![],
    ))
}
