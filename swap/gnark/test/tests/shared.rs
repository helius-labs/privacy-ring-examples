use anyhow::{anyhow, Result};
use solana_address::Address;
use spr_keypair::ShieldedKeypair;
use spr_program_test::{
    fixture,
    localnet::{FixtureLocalnet, LocalnetPorts},
    SprProgramTest,
};
use spr_transaction::{utxo::SppProofInputUtxo, AssetRegistry};
use spr_user_registry_interface::user_registry_program_id;

#[path = "../../../../test-utils/localnet.rs"]
mod release_localnet;
#[path = "../../../../test-utils/wallet.rs"]
mod wallet;

use wallet::deposit;
pub use wallet::{send, wait_for_merkle_proof, TestWallet};

// SPL the maker shields into the order UTXO (source), and SOL the taker pays (destination).
pub const MAKER_SHIELD_SPL: u64 = 1_000_000_000;
pub const SOURCE_AMOUNT: u64 = 400_000_000;
pub const DESTINATION_AMOUNT: u64 = 250_000_000;

// Each actor is one ed25519 identity: the wallet's signing key doubles as the
// Solana fee payer, and the wallet holds the asset registry and the spendable
// notes its scan found after the deposits.
pub struct TestEnv {
    /// The localnet with its client and default tree. Dropping it stops the
    /// validator, so it lives as long as the test.
    pub localnet: FixtureLocalnet,
    pub maker: TestWallet,
    /// The maker's own SPL deposit, which funds the order.
    pub maker_input: SppProofInputUtxo,
    pub taker: TestWallet,
    pub spl_mint: Address,
}

/// Boot the localnet of test number `test` ([`LocalnetPorts::for_test`]); tests
/// running in parallel take distinct numbers.
pub fn setup(test: u16) -> Result<TestEnv> {
    let localnet = FixtureLocalnet::start(
        "zolana-swap",
        LocalnetPorts::for_test(test)?,
        vec![
            (
                swap_program::ID,
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../program/target/deploy/swap_program.so"),
            ),
            (
                user_registry_program_id(),
                release_localnet::env_path("USER_REGISTRY_PROGRAM_PATH"),
            ),
        ],
        &release_localnet::paths(),
    )?;
    let payer = fixture::payer();

    let spl_mint = fixture::spl_mint();
    let mut assets = AssetRegistry::default();
    assets.insert(fixture::SPL_ASSET_ID, spl_mint)?;
    let spl_funding = fixture::payer_token_account();

    let maker_shielded_keypair = ShieldedKeypair::from_keypair(&fixture::actor(0))?;

    let taker_shielded_keypair = ShieldedKeypair::from_keypair(&fixture::actor(1))?;

    // Fund the actors: shield the maker's SPL and the taker's SOL directly to
    // each. The maker spends its own SPL into the order.
    let maker_address = maker_shielded_keypair
        .shielded_address()
        .map_err(|e| anyhow!("maker address: {e:?}"))?;
    deposit(
        &localnet,
        &payer,
        SprProgramTest::wallet_spl_shield_data(
            MAKER_SHIELD_SPL,
            &maker_address,
            &spl_mint,
            &spl_funding,
        )?,
    )?;
    let taker_address = taker_shielded_keypair
        .shielded_address()
        .map_err(|e| anyhow!("taker address: {e:?}"))?;
    deposit(
        &localnet,
        &payer,
        SprProgramTest::wallet_sol_shield_data(DESTINATION_AMOUNT, &taker_address)?,
    )?;

    // Both deposits are wallet-owned and indexed, so each wallet discovers
    // its own through the indexer.
    let maker = TestWallet::scan(maker_shielded_keypair, assets.clone(), &localnet.client)
        .map_err(|e| anyhow!("scan maker deposit: {e:?}"))?;
    let maker_input = SppProofInputUtxo::from(
        maker
            .spendable_utxo(spl_mint, MAKER_SHIELD_SPL)
            .ok_or_else(|| anyhow!("the maker's SPL deposit is not spendable"))?,
    );
    let taker = TestWallet::scan(taker_shielded_keypair, assets, &localnet.client)
        .map_err(|e| anyhow!("scan taker deposit: {e:?}"))?;

    let env = TestEnv {
        localnet,
        maker,
        maker_input,
        taker,
        spl_mint,
    };

    // Guard the fixture: the maker-owned input the make flows spend must be
    // exactly the note the maker deposit just funded.
    assert_eq!(
        (
            env.maker_input.utxo.owner,
            env.maker_input.utxo.asset.asset,
            env.maker_input.utxo.amount
        ),
        (
            env.maker.keypair.signing_pubkey(),
            spl_mint,
            MAKER_SHIELD_SPL
        )
    );
    Ok(env)
}
