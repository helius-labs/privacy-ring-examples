# Zolana examples: TypeScript client

TypeScript client examples for `@heliuslabs/spr`.

- **[register_private_wallet](examples/register_private_wallet.ts)** - Register a private wallet
- **[deposit_transfer_withdraw](examples/deposit_transfer_withdraw.ts)** - Deposit, private transfer, and withdraw
- **[local_proving](examples/local_proving.ts)** - The same flow with SPP proofs generated in Node by WASM
- **[deposit_with_interface_setup](examples/deposit_with_interface_setup.ts)** - Create a token interface and deposit in one transaction
- **[sync_balance](examples/sync_balance.ts)** - Read the private SOL and SPL balances
- **[read_history](examples/read_history.ts)** - Read the private transaction history

## Setup

Install Node.js 24+, pnpm 11.18.0, and Rust through rustup. The SDK is pinned to the published npm release
`@heliuslabs/spr@0.9.0-alpha`. It predates two changes in the deployed 1.0
programs that these examples do not use: the per-tree fee defaults of
`createTreeInstructions` (#533) and the user-registry `update_keys` data of
`buildKeyUpdateTransaction` (#591).

```bash
bash ../test-utils/setup-ts-local-prover.sh
pnpm install
```

`@heliuslabs/zopro-spr` is pinned to a Git commit and the
`zopro/packages/spr-prover` subdirectory of `helius-labs/zk-tools`. pnpm builds
its single and multithreaded WASM runtimes during installation. The setup script
installs the required `nightly-2025-11-15` Rust toolchain, its WASM target and
`rust-src`, and `wasm-bindgen-cli` 0.2.128. The exact Git artifact is allowed to
run its build script in `pnpm-workspace.yaml`.

**Devnet:**

The example uses devnet by default.

One Helius RPC endpoint serves Solana RPC, the Photon indexer, and the attested TEE prover. The SDK routes indexer and prover requests through `/v1/spr`, preserving the API key. The prover fetches Merkle proofs from Photon and assembles the witness server-side. Photon also serves balance and history reads.

Get an API key from [Helius](https://helius.dev) and add to .env:

```bash
cp .env.example .env # ...and set API_KEY
```

For mainnet, set `ZOLANA_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`. The examples select the signed TEE policy for the endpoint's network.

**Localnet**:

To run on localnet, download the `zolana` CLI from the
[`cli-v0.10.0`](https://github.com/helius-labs/zolana/releases/tag/cli-v0.10.0)
release and check it against the release's `SHA256SUMS`. Without `--local`,
`zolana dev start` downloads the prover, Photon, the deployed shielded-pool and
user-registry v1.0.0 programs, the smart-account program and an account
snapshot that the release pins and checks each one's SHA-256. It also
downloads surfpool and checks its version.

```bash
platform=darwin-arm64 # or linux-x64
asset=zolana-$platform-cli-v0.10.0
base=https://github.com/helius-labs/zolana/releases/download/cli-v0.10.0
curl -sSfLO "$base/$asset" -sSfLO "$base/SHA256SUMS"
grep " $asset\$" SHA256SUMS | shasum -a 256 -c - # sha256sum -c - on Linux
mkdir -p ~/.local/bin && install -m 755 "$asset" ~/.local/bin/zolana
zolana dev start
```

Set these overrides in `.env`:

```bash
ZOLANA_ENDPOINT=http://127.0.0.1:8899
ZOLANA_INDEXER_URL=http://127.0.0.1:8784
ZOLANA_PROVER_URL=http://127.0.0.1:3001
```

For a local prover without an indexer, set `ZOLANA_PROOF_DATA_SOURCE=client`. The localnet integration tests use this mode because they share one prover across separate validator/indexer stacks.

## Run

```bash
pnpm example examples/register_private_wallet.ts
pnpm example examples/deposit_transfer_withdraw.ts
pnpm example examples/deposit_with_interface_setup.ts
pnpm example examples/sync_balance.ts
pnpm example examples/read_history.ts
```

`deposit_with_interface_setup` prepares a fresh test token, then checks that its interface PDA is absent. One transaction creates the mint registry PDA and token vault, then deposits into the sender's private balance. The sender pays transaction fees and account rent. The network must allow permissionless interface creation.

## Prove locally in Node

The local proving example uses the same `ProofService` input and output types
as the SDK's server prover. `LocalKeys` sends complete typed inputs directly to
the WASM prover. Solana RPC and Photon supply chain and Merkle data; no proof
request leaves the process. The example refuses HTTP `/prove` routes and checks
that both the transfer and withdrawal generated local SPP proofs.

Start the local stack without its prover, fund the configured CLI wallet with
localnet SOL, and run:

```bash
zolana dev start --skip-prover
ZOLANA_ENDPOINT=http://127.0.0.1:8899 \
ZOLANA_INDEXER_URL=http://127.0.0.1:8784 \
pnpm example examples/local_proving.ts
```

Use `ZOLANA_LOCAL_PROVING_THREADS=0` for single-threaded proving, or set it to a
pool size from 1 to 64. The default is up to four available CPU threads.

The first proof downloads the required `.zopro` key. Its size, SHA-256 and source
gnark key digest are checked against [`src/local-proving-keys.json`](src/local-proving-keys.json),
the production `78751f5d1c591777` catalog pinned by the published
[`@heliuslabs/spr-web-prover@0.7.0-alpha`](https://www.npmjs.com/package/@heliuslabs/spr-web-prover/v/0.7.0-alpha).
Every source digest is also checked against the SDK's compiled deployment pins.
Keys are cached in `~/.cache/zolana-examples/proving-keys/78751f5d1c591777`;
`ZOLANA_LOCAL_PROVING_KEYS_DIR` overrides that directory. This is the key set used
by the CLI v0.10.0 deployment.

## Documentation

- [Connect](https://www.helius.dev/docs/privacy/connect)
- [Documentation](https://helius.dev/docs/privacy)
- [Source Code](https://github.com/helius-labs/zolana)
