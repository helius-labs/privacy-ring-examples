//! Wallet helpers for the examples' localnet tests: proofless deposits, the
//! notes a wallet can spend as the indexer reports them, and waiting for the
//! indexer.
//!
//! Include it with `#[path = ".../test-utils/wallet.rs"] mod wallet;`. It needs
//! `anyhow`, `solana-address`, `solana-instruction`, `solana-signature`,
//! `solana-signer`, `spr-client`, `spr-keypair`, `spr-program`,
//! `spr-program-test` (with `localnet`) and `spr-transaction`.
#![allow(dead_code)]

use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use solana_address::Address;
use solana_instruction::Instruction;
use solana_signature::Signature;
use solana_signer::Signer;
use spr_client::{ComputeBudgetConfig, MerkleProof, Rpc, UtxoScan};
use spr_keypair::ShieldedKeypair;
use spr_program::instruction::{AssetDeposit, Deposit};
use spr_program_test::localnet::FixtureLocalnet;
use spr_transaction::{AssetBalance, AssetRegistry, SpendableDecryptionResult, WalletUtxo};

// The whole per-transaction budget: a swap or an escrow forwards an SPP
// transact and verifies its own proof.
const TRANSACT_COMPUTE_UNIT_LIMIT: u32 = 1_400_000;
const INDEXER_TIMEOUT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// A shielded keypair with the notes it can spend, as of its last scan.
pub struct TestWallet {
    pub keypair: ShieldedKeypair,
    pub registry: AssetRegistry,
    spendable: SpendableDecryptionResult,
}

impl TestWallet {
    /// Scan the indexer for the notes `keypair` can spend.
    pub fn scan(
        keypair: ShieldedKeypair,
        registry: AssetRegistry,
        client: &impl Rpc,
    ) -> Result<Self> {
        let spendable = UtxoScan::new(&keypair, &registry).fetch(client)?.spendable;
        Ok(Self {
            keypair,
            registry,
            spendable,
        })
    }

    /// Scan the indexer again, replacing the notes found before.
    pub fn rescan(&mut self, client: &impl Rpc) -> Result<()> {
        self.spendable = UtxoScan::new(&self.keypair, &self.registry)
            .fetch(client)?
            .spendable;
        Ok(())
    }

    /// The spendable default-ring balance of `mint`.
    pub fn balance(&self, mint: Address) -> Option<&AssetBalance> {
        self.spendable.balances.get_balance(mint)
    }

    /// The first spendable default-ring note of `mint` worth at least
    /// `min_amount`.
    pub fn spendable_utxo(&self, mint: Address, min_amount: u64) -> Option<WalletUtxo> {
        self.balance(mint)?
            .utxos
            .iter()
            .find(|utxo| utxo.utxo.ring_program_id.is_none() && utxo.utxo.amount >= min_amount)
            .cloned()
    }
}

/// Send the proofless deposit `asset_deposit` into the localnet's tree from
/// `payer`, which pays the fee and funds the deposit, and wait until the
/// indexer has it.
pub fn deposit(
    localnet: &FixtureLocalnet,
    payer: &dyn Signer,
    asset_deposit: AssetDeposit,
) -> Result<()> {
    let ix = Deposit {
        tree: localnet.tree,
        depositor: payer.pubkey(),
        deposits: vec![asset_deposit],
    }
    .instruction()?;
    let signature = localnet.client.rpc().create_and_send_transaction(
        std::slice::from_ref(&ix),
        payer.pubkey(),
        &[payer],
        ComputeBudgetConfig::for_instruction_count(1),
    )?;
    localnet
        .client
        .confirm_private_transaction_sync(signature)
        .map_err(|e| anyhow!("deposit {signature} indexed: {e:?}"))?;
    Ok(())
}

/// Submit a single (large) instruction as a transaction **v1** message: its
/// 4096-byte limit is what holds the swap and escrow account lists and proofs,
/// which no longer fit a 1232-byte legacy packet. v1 has no address lookup
/// table, and it carries the compute ceilings in the message header rather than
/// in a compute-budget instruction. The first signer pays.
pub fn send(rpc: &impl Rpc, signers: &[&dyn Signer], ix: Instruction) -> Result<Signature> {
    let payer = signers
        .first()
        .ok_or_else(|| anyhow!("a transaction needs a fee payer"))?
        .pubkey();
    Ok(rpc.create_and_send_transaction(
        std::slice::from_ref(&ix),
        payer,
        signers,
        ComputeBudgetConfig::new(TRANSACT_COMPUTE_UNIT_LIMIT),
    )?)
}

/// Poll the indexer until it serves the inclusion proof of `leaf` in `tree`.
pub fn wait_for_merkle_proof(
    indexer: &impl Rpc,
    tree: Address,
    leaf: [u8; 32],
) -> Result<MerkleProof> {
    let started = Instant::now();
    let mut last_error = None;
    while started.elapsed() < INDEXER_TIMEOUT {
        match indexer.get_merkle_proofs(tree, vec![leaf], None) {
            Ok(response) => {
                if let Some(proof) = response.proofs.into_iter().next() {
                    return Ok(proof);
                }
            }
            Err(error) => last_error = Some(error.to_string()),
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    Err(anyhow!(
        "timed out waiting for an indexed merkle proof; last indexer error: {}",
        last_error.as_deref().unwrap_or("none")
    ))
}
