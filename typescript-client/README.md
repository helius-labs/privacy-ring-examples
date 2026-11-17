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

`spr-prover.lock.json` pins zk-tools PR #12 at commit
`3104adbb6c320c849ffe217742b4905298449519`. The setup script checks out that
source into `target/spr-prover-source`, builds `@heliuslabs/spr-web-prover`
from `clients/spr-prover`, then pnpm installs the built package as a local
`file:` dependency. No unpublished npm version or install-time build hook is
required. The package's own `runtime.lock.json` independently pins its WASM
runtime. Setup installs that runtime's Rust toolchain and wasm-bindgen version.
Rerun setup before installing after changing the source pin.

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

The example creates `SprNodeProver` from `@heliuslabs/spr-web-prover/node` and
passes `localProofService(prover)` to `LocalKeys`. No prover URL or fetch
interceptor is needed. The SDK gathers proof data from Photon
(`proofDataSource: "client"`); WASM generates and verifies the proof in Node
worker threads. Solana RPC and indexer requests still use the network.

`src/local-proof-service.ts` adapts the pinned SDK's typed inputs to
`proveRequest()`, using SDK serialization, proof/key-digest validation and
cancellation/deadline handling. The transaction example only configures the
service. Its remote-proving path remains available with the default options.

The example preloads `shapeByLabel("1x2")` before client actions. The test-only
HTTP guard rejects network proof requests; a typed proof-service counter checks
the exact 1x2 circuit requests. Key downloads, digest checks, disk caching,
key switching and worker cleanup belong to the prover package.

Start the local stack without its prover, fund the configured CLI wallet with
localnet SOL, and run:

```bash
zolana dev start --skip-prover
ZOLANA_ENDPOINT=http://127.0.0.1:8899 \
ZOLANA_INDEXER_URL=http://127.0.0.1:8784 \
pnpm example examples/local_proving.ts
```

Use `ZOLANA_LOCAL_PROVING_THREADS=0` for single-threaded proving, or set it to a
pool size from 1 to 64. This example selects four threads by default.

The bundled key set matches SDK 0.9.0-alpha and the CLI v0.10.0 deployment.
`ZOLANA_LOCAL_PROVING_CACHE_DIR` overrides `cacheDir` (by default
`~/.cache/spr-prover`). CPU proving is selected with `gpu: "off"`; the Node
package also supports optional WebGPU acceleration.

Run the real-proof smoke test without a validator or Photon:

```bash
pnpm test:local
```

The test scripts use `--test-isolation=none` so Node does not copy its test-child
V8 flags into the prover’s worker threads. The prover isolates its own work in
workers; the localnet runner also gives the validator and Photon separate ports.

It uses a synthetic request fixture from the same pinned zk-tools commit,
checks the pinned release's source-key digest and fresh proof randomization, and verifies
that both proofs reuse the preloaded key. The Xark escrow runner and its full
localnet flow are documented in [escrow/README.md](../escrow/README.md).

## Documentation

- [Connect](https://www.helius.dev/docs/privacy/connect)
- [Documentation](https://helius.dev/docs/privacy)
- [Source Code](https://github.com/helius-labs/zolana)
