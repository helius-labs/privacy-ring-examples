# Timelock Escrow Program

> [!WARNING]
> **Not for production.** This example is not audited. Its circuits use
> insecure test keys generated from a fixed public seed, so anyone can forge
> its proofs, and the program builds only with the `insecure-test-setup`
> feature. Do not deploy it or use it with real funds; a deployment needs its
> own trusted setup, verifying keys, program ID and audit.

A timelock escrow on the Solana Privacy Program (SPP): a creator locks a
private balance as a shielded UTXO with an unlock timestamp, and withdraws it
once that timestamp has passed.

The escrow program is an SPP ZK program: it verifies a small proof of its own
escrow rules and delegates the confidential transfer to SPP. It stores no state
and owns no accounts.

See [`timelock_escrow.md`](timelock_escrow.md) for the full design: the privacy
model, escrow terms, instructions, and circuits.

## Implementations

- [`gnark/`](gnark/) — circuits written in Go with gnark, proved in process
  through `spr-gnark-ffi-prover`.
- [`xark/`](xark/) — circuits written in Rust and compiled with Xark through
  Zolana's `ZkProgram` derives, proved in process by the Xark prover. See
  [xark](#xark) below.

Both implement the same instructions, tags, instruction data, errors and escrow
terms. They are separate Cargo workspaces with their own program IDs and share
no code.

## Benchmark

Both implementations measure the same things the same way and write them in
the same format, so their files compare line by line. No file is edited by
hand:

- [`gnark/BENCHMARK.md`](gnark/BENCHMARK.md) and
  [`xark/BENCHMARK.md`](xark/BENCHMARK.md) are written by each
  implementation's `bench_cu` test: circuit sizes, constraint counts, key
  loads, per-proof setup, warm and in-memory proving times, then per
  instruction the compute units (whole instruction, proof verification, SPP
  CPI), warm circuit and SPP proving times and the v1 transaction size.
- [`BENCHMARK.md`](BENCHMARK.md) puts the two side by side with the delta,
  written by `test-utils/compare-benchmarks.py` from the two files.

Each bench profiles its program under Mollusk, so build the profiling program
into `target/bench` first; a validator does not register the profiler
syscall. Both read the shielded-pool program from
`SHIELDED_POOL_PROGRAM_PATH` and use the prover at `ZOLANA_PROVER_URL`, or
start one with `ZOLANA_CLI_BIN`. Both use the `cli-v0.10.0` release
artifacts: the xark bench from `xark/scripts/build-localnet.sh`, the gnark
bench from `zolana dev artifacts` as in `test-utils/run-release-tests.sh`. From `escrow/xark/`, with the circuit
artifacts compiled (see [Build](#build)):

```bash
cargo build-sbf --manifest-path program/Cargo.toml --tools-version v1.54 --sbf-out-dir target/bench -- --locked --features bpf-entrypoint,profile-program
cargo test --release --manifest-path test/Cargo.toml --test bench_cu -- --ignored --nocapture
```

From `escrow/gnark/`, with the circuit keys generated into `build/gnark`:

```bash
for circuit in escrow withdraw; do
    cargo run --release --manifest-path prover/Cargo.toml --bin timelock-escrow-prover-setup -- \
        "$circuit" "$PWD/build/gnark/$circuit" --insecure-test-keys
done
CARGO_TARGET_DIR="$PWD/target" cargo build-sbf --manifest-path program/Cargo.toml --tools-version v1.54 --sbf-out-dir target/bench -- --features bpf-entrypoint,profile-program
cargo test --release --manifest-path test/Cargo.toml --test bench_cu -- --ignored --nocapture
```

Then, from the repository root:

```bash
python3 test-utils/compare-benchmarks.py escrow
```

## xark

The circuits live in the program crate as Rust. Each circuit's `execute`
method runs natively on the client, where it builds the SPP transaction, and
compiles through Xark for proving. `zolana zk compile` generates the program's
verifier of each circuit from its verifying key.

The workspace uses the published Zolana SDK 0.10.0 (`spr-hasher` remains at
0.8.0) and Xark [0.3.1](https://crates.io/crates/xark/0.3.1) from crates.io.
The tests share helpers from [`../test-utils/`](../test-utils/) with the gnark
implementation. The `zolana` CLI is the `cli-v0.10.0` release binary, which
includes Xark. The program ID is `42uWG786CJAdtdZy5KEEtE7QCuSHjVFu5ZAq32Z41hDD`.

What differs from the gnark implementation, within the spec:

- The escrow terms are an SDK state (`UtxoState`): `creator`, the creator's
  owner, and `unlock`. The circuits set them on the escrow `DataUtxo` and read
  them back from it; the SDK hashes them into the data hash
  (`Poseidon(DATA, Poseidon(discriminator, owner_hash, unlock))`) and encrypts
  them as the escrow UTXO's data. The SDK finds the creator's open escrows by
  fetching the transactions tagged with the creator's escrow-authority PDA and
  decrypting them (`state::open_escrows`), and withdraw takes the decoded
  escrow UTXO, so the creator does not store the terms separately.
- The proofs' single public input is the SDK's public hash over
  `(owner_pk_field, escrow_owner)` for escrow and `(unlock, owner_pk_field)`
  for withdraw, each with `transaction_hash`, where `owner_pk_field` is
  `solana_owner_identity` of the creator signer, `escrow_owner` is the address
  hash of the creator's escrow-authority PDA owner with the `viewing_pubkey`
  from the instruction data, and `transaction_hash` is `private_tx_hash`
  (neither transaction moves public funds). The program recomputes both from
  its accounts and instruction data. gnark checks only the PDA's owner hash;
  Xark checks the whole escrow owner address, as Zolana's reference escrow
  does.
- The escrow transaction is proved at the SPP `(1, 2)` shape, without a dummy
  input. The output blindings derive from the transaction's first nullifier,
  its blinding seed and the output slot.
- The circuits recompute every spent UTXO's hash from its preimage.

### Layout

- [`xark/program/src/circuits/`](xark/program/src/circuits/) holds the escrow
  and withdraw circuits and the escrow terms state.
- [`xark/program/src/instructions/`](xark/program/src/instructions/) checks the
  accounts, verifies the program proof and invokes SPP `transact`, signed by
  the escrow-authority PDA.
- [`xark/program/src/verifier/`](xark/program/src/verifier/) holds the
  generated verifiers.
- [`xark/sdk/`](xark/sdk/) holds the escrow UTXO lookup, the transaction and
  instruction builders and the checksum-pinned prover.
- [`xark/test/`](xark/test/) holds the localnet test and the CU benchmark.
- [`xark/timelock-escrow-keys.CHECKSUM`](xark/timelock-escrow-keys.CHECKSUM)
  pins each circuit's bytecode, proving key and verifying key.

### Build

Use Rust 1.98.1 (pinned in `xark/rust-toolchain.toml`, which fixes the compiler
that generates the checked bytecode) and Agave with SBF platform tools v1.54.
The setup script checks the workspace's SDK release pins, downloads
the `cli-v0.10.0` CLI for darwin-arm64 or linux-x64, checks it against the
release's `SHA256SUMS` and installs it to `xark/.tools/bin/zolana`. It prints
`ZOLANA_CLI_BIN`; `scripts/setup-zk-tools.sh --check-pins` only checks the
pins. Run from `escrow/xark/`:

```bash
eval "$(scripts/setup-zk-tools.sh | sed 's/^/export /')"
"$ZOLANA_CLI_BIN" zk compile --test --skip-wasm --manifest-path program/Cargo.toml
scripts/check-keys.sh
cargo build-sbf --manifest-path program/Cargo.toml --tools-version v1.54 -- --locked --features bpf-entrypoint
```

`zolana zk compile --test` writes each circuit's `circuit.xbc`, `pk.bin` and
`vk.bin` to `target/zk/timelock-escrow-program/<circuit>/` and its verifier to
`program/src/verifier/`. These are deterministic keys from an insecure test
setup, so the program compiles only with its default `insecure-test-setup`
feature; use a trusted setup before deploying it. Check that the circuits
reproduce the committed verifiers and checksums with
`"$ZOLANA_CLI_BIN" zk compile --test --manifest-path program/Cargo.toml --check`
and `scripts/check-keys.sh`. After an intentional circuit change, regenerate
them and update the checksums with `shasum -a 256` over the generated files,
relative to `target/zk/timelock-escrow-program/`. `TIMELOCK_ESCROW_KEYS_DIR`
points the SDK and the checksum script at another directory with the same
artifacts.

### Test

```bash
cargo fmt -p timelock-escrow-program -p timelock-escrow-sdk -p timelock-escrow-test -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --locked -p timelock-escrow-program --features bpf-entrypoint
cargo test --release --locked -p timelock-escrow-sdk
```

The program tests run the SBF build under Mollusk, so build it first. The SDK
tests prove both circuits with the checked artifacts and check that the
compiled circuits refuse broken inputs.

The localnet test starts surfpool, Photon and the SPP prover, and deploys the
shielded-pool program. `scripts/build-localnet.sh` runs
`"$ZOLANA_CLI_BIN" dev artifacts`, which downloads the versions the
`cli-v0.10.0` release pins (the deployed `shielded-pool-v1.0.0` program and
the release prover, Photon and surfpool), checks their checksums, caches them
under `~/.config/zolana/cache` and prints the variables to export
(`ZOLANA_CLI_BIN`, `SHIELDED_POOL_PROGRAM_PATH`, `PROVER_BIN`,
`ZOLANA_PHOTON_BIN`, `SURFPOOL_BIN`). The prover downloads missing SPP keys to `ZOLANA_PROVER_KEYS_DIR`, or
`~/.config/zolana/proving-keys` by default. `ZOLANA_PORT_OFFSET` and
`ZOLANA_PROVER_URL` move the services off the default ports.

```bash
eval "$(scripts/build-localnet.sh | sed 's/^/export /')"
mkdir -p ~/.config/zolana/proving-keys
cargo test --release --locked -p timelock-escrow-test --test escrow
```

### TypeScript Xark program test with local SPP proving

[`typescript-client/tests/xark_escrow_local_proving.ts`](../typescript-client/tests/xark_escrow_local_proving.ts)
deposits 0.5 SOL, locks 0.3 SOL through the Xark escrow program, then withdraws
the escrow back to its creator. Both custom program proofs run in the generated
Xark Node WASM module. The SPP proofs run through the Git-pinned
`@heliuslabs/zopro-spr` TypeScript `ProofService`; the test generates two
randomized proofs for each transaction, submits one, and checks the program's
accepted state transition and final 0.5 SOL private balance.

The test owns an isolated validator and Photon stack started with
`--skip-prover`. Its HTTP transport refuses prover routes, and its proof counter
checks the four SPP proofs in the escrow flow were generated locally. No SPP prover server
is started. It also runs the normal TypeScript local-proving CLI and its
shared base flow against the same stack; the latter uses a test-only
HTTP guard and checks the example's two local SPP proofs.
The normal example imports the shared factory directly; key management lives
in `@heliuslabs/zopro-spr`.

Setup preloads and decodes the SPP `transfer_confidential_1_2.key`, and the test
asserts that its transfer requests use that shape. It also creates separate
Xark `ProvingSession` instances for escrow and withdrawal, loading their
circuits and decoding their complete proving keys before any client actions.
Their `VerifyingKey` instances are decoded in setup too. The proof steps use
these resident objects rather than rereading artifacts or decoding keys.

Run from `escrow/xark/`, with Node 24+, the SBF tools, and the standard Rust/WASM
build prerequisites installed:

```bash
bash scripts/test-typescript-local.sh
```

The runner verifies the release's account snapshot, compiles the application
WASM with `--single-threaded --wasm-target nodejs`, builds its SBF program,
installs the Git-pinned SPP prover, and runs the new test file. The SPP prover
uses up to four threads; `ZOLANA_LOCAL_PROVING_THREADS=0` selects its single-thread
runtime. `ZOLANA_XARK_RPC_PORT`, `ZOLANA_XARK_PHOTON_PORT` and
`ZOLANA_XARK_PROVER_PORT` move the test's private ports (18599, 18784 and 18001).
Logs remain in `escrow/xark/target/typescript-localnet-<rpc port>/`.
If missing, the runner installs `wasm-pack` 0.15.0 for the application build.

The published TS SDK 0.9's experimental `bindProgramTransaction` accepts a
binary program assignment, while the Rust SDK 0.10-generated module exposes
the Xark assignment as a field map. The test therefore uses the generated
`escrowTransaction` / `withdrawTransaction` functions and the TS SDK's public
`decodeProgramTransaction` for their finalized transactions. It checks the
sender, payer and program public hash, and binds the locally generated custom
proof to that hash before building the CPI instruction. It retains the escrow's
data-bearing output and attaches its verified indexed leaf for withdrawal;
the generic token-wallet scanner does not discover program data UTXOs.
