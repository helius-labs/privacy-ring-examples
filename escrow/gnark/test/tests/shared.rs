use anyhow::{anyhow, Result};
use spr_keypair::ShieldedKeypair;
use spr_program_test::{
    fixture,
    localnet::{FixtureLocalnet, LocalnetPorts},
    SprProgramTest,
};
use spr_transaction::{utxo::SppProofInputUtxo, AssetRegistry, WalletUtxo, SOL_MINT};

#[path = "../../../../test-utils/localnet.rs"]
mod release_localnet;
#[path = "../../../../test-utils/wallet.rs"]
mod wallet;

use wallet::deposit;
pub use wallet::{send, wait_for_merkle_proof, TestWallet};

pub const SHIELD_AMOUNT: u64 = 500_000_000;
pub const LOCK_AMOUNT: u64 = 300_000_000;

// The committed unlock timestamp is already in the past, so the withdraw in
// these tests always succeeds immediately: the timelock escrow program
// requires `now > unlock_timestamp`.
pub const UNLOCK_TIMESTAMP: u64 = 1_000_000;

// The SPP relayer deadline on the withdraw transact must be in the future
// even when the escrow's own `unlock_timestamp` is already in the past (the
// two are unrelated fields; see timelock_escrow.md's Escrow Terms section).
pub const SPP_RELAYER_DEADLINE: u64 = 2_000_000_000;

// The creator is the only actor: one ed25519 identity whose signing key
// doubles as the Solana fee payer, holding the asset registry and the
// spendable notes its last scan found.
pub struct TestEnv {
    /// The localnet with its client and default tree. Dropping it stops the
    /// validator, so it lives as long as the test.
    pub localnet: FixtureLocalnet,
    /// The creator, its wallet scanned after the deposit.
    pub creator: TestWallet,
    /// The shielded balance the escrow locks from, owned by the creator.
    pub creator_input: SppProofInputUtxo,
}

/// Boot the localnet of test number `test` ([`LocalnetPorts::for_test`]); tests
/// running in parallel take distinct numbers.
pub fn setup(test: u16) -> Result<TestEnv> {
    let localnet = FixtureLocalnet::start(
        "timelock-escrow",
        LocalnetPorts::for_test(test)?,
        vec![(
            timelock_escrow_program::ID,
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../target/deploy/timelock_escrow_program.so"),
        )],
        &release_localnet::paths(),
    )?;
    let payer = fixture::payer();

    // SOL only: asset id 1 is a built-in AssetRegistry::default() entry, no
    // SPL registration needed.
    let assets = AssetRegistry::default();

    let creator_shielded_keypair = ShieldedKeypair::from_keypair(&fixture::actor(0))?;

    let creator_address = creator_shielded_keypair
        .shielded_address()
        .map_err(|e| anyhow!("creator address: {e:?}"))?;

    // Shield the creator's balance, which the escrow locks from: the creator
    // owns it and signs its spend.
    deposit(
        &localnet,
        &payer,
        SprProgramTest::wallet_sol_shield_data(SHIELD_AMOUNT, &creator_address)?,
    )?;

    // The creator's wallet reads the deposit back from the indexer.
    let creator = TestWallet::scan(creator_shielded_keypair, assets, localnet.client.indexer())
        .map_err(|e| anyhow!("scan creator after deposit: {e:?}"))?;
    let balance = creator
        .balance(SOL_MINT)
        .cloned()
        .ok_or_else(|| anyhow!("the creator has no SOL balance"))?;
    let [creator_input]: [WalletUtxo; 1] = balance
        .utxos
        .try_into()
        .map_err(|utxos: Vec<WalletUtxo>| anyhow!("expected one deposit, found {}", utxos.len()))?;
    let creator_input: SppProofInputUtxo = creator_input.into();
    assert_eq!(
        (
            creator_input.utxo.owner,
            creator_input.utxo.asset.asset,
            creator_input.utxo.amount
        ),
        (creator_address.signing_pubkey, SOL_MINT, SHIELD_AMOUNT)
    );

    Ok(TestEnv {
        localnet,
        creator,
        creator_input,
    })
}
