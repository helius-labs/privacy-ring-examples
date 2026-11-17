use anyhow::Result;
use rust_client_example::{asset_registry, cli_keypair, setup};
use solana_keypair::Keypair;
use spr_client::{SolanaRpc, SprClient, UtxoScan};
use spr_keypair::ShieldedKeypair;
use spr_transaction::HistoryEntry;

fn main() -> Result<()> {
    let context = setup()?;
    let client = context.client()?;
    run(&client, &cli_keypair()?).map(|_| ())
}

/// The sender's history, newest first: one entry per asset each transaction
/// moved.
pub fn run(client: &SprClient<SolanaRpc>, payer: &Keypair) -> Result<Vec<HistoryEntry>> {
    // Initialize the sender's private wallet and local authority
    // to decrypt transactions and read its history.
    // The Solana signer and private wallet are derived from the same Ed25519 seed.
    let sender = ShieldedKeypair::from_keypair(payer)?;
    let assets = asset_registry(client)?;

    // Fetch the transactions that created or spent the wallet's UTXOs and
    // classify what each one did to its balance.
    let history = UtxoScan::new(&sender, &assets).fetch(client)?.history;
    anyhow::ensure!(
        history.unknown_asset_ids.is_empty() && history.unknown_mints.is_empty(),
        "could not resolve SPL asset registrations"
    );

    let entries = history.entries();
    for entry in &entries {
        println!(
            "ok kind={:?} mint={} amount={} tx={}",
            entry.kind, entry.mint, entry.amount, entry.tx_signature,
        );
    }
    Ok(entries)
}
