import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  AccountRole,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  lamports,
  type Instruction,
} from "@solana/kit";
import {
  ShieldedKeypair,
  SigningKey,
  SOL_MINT,
  Wallet,
  createSprClient,
  syncWallet,
} from "@heliuslabs/spr";
import { LocalKeys, atSlot, type ProofService } from "@heliuslabs/spr/client";
import {
  DepositAsset,
  depositInstruction,
  encodeTransactInstructionData,
  SHIELDED_POOL_PROGRAM_ID,
  type TransactInstructionData,
} from "@heliuslabs/spr/interface";
import {
  ProgramOwner,
  decodeProgramTransaction,
  toProgramWalletUtxo,
  transactCpiAccounts,
  type ProgramWalletUtxo,
} from "@heliuslabs/spr/program";
import { AssetRegistry, Utxo } from "@heliuslabs/spr/transaction";
import { createLocalProofService } from "@heliuslabs/zopro-spr";

import { sendAndConfirmFactory } from "../src/lib.js";
import { countProofs, fetchWithoutProver } from "./support/local-proving.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const xarkRoot = resolve(root, "escrow/xark");
const artifactRoot = resolve(xarkRoot, "target/zk/timelock-escrow-program");
const programAddress = address("42uWG786CJAdtdZy5KEEtE7QCuSHjVFu5ZAq32Z41hDD");
const shieldAmount = 500_000_000n;
const lockAmount = 300_000_000n;
const unlockTimestamp = 1_000_000n;

interface ProofBundle {
  readonly proof: Uint8Array;
  readonly publicInputs: Uint8Array;
  free(): void;
}

interface PreparedApplicationTransaction {
  readonly finalizedTx: unknown;
  readonly proofInputs: Readonly<Record<string, string>>;
  readonly publicHash: Uint8Array;
}

interface ProgramProver {
  prove(inputs: Readonly<Record<string, string>>, options: object): ProofBundle;
  free(): void;
}

interface ProgramVerifier {
  verify(proof: Uint8Array, publicInputs: Uint8Array): boolean;
  free(): void;
}

interface LoadedProgramCircuit {
  readonly prover: ProgramProver;
  readonly verifier: ProgramVerifier;
}

// The generated .d.ts lives beside build artifacts. This narrow boundary lets
// the ordinary client typecheck run before the optional Xark package is built.
interface EscrowRuntime {
  escrowTransaction(
    inputs: Record<string, unknown>,
    sender: Uint8Array,
    payer: string,
  ): PreparedApplicationTransaction;
  withdrawTransaction(
    inputs: Record<string, unknown>,
    sender: Uint8Array,
    payer: string,
  ): PreparedApplicationTransaction;
  escrowTermsDataUtxo(utxo: ProgramWalletUtxo): { data: unknown };
  readonly ProvingSession: new (
    circuit: Uint8Array,
    key: Uint8Array,
  ) => ProgramProver;
  readonly VerifyingKey: new (key: Uint8Array) => ProgramVerifier;
  programProof(
    proof: Uint8Array,
    publicInputs: Uint8Array,
    expectedHash: Uint8Array,
  ): unknown;
  compressedProgramProof(proof: Uint8Array): Uint8Array;
}

function applicationRuntime(): EscrowRuntime {
  return createRequire(import.meta.url)(
    resolve(artifactRoot, "wasm/timelock_escrow_program.js"),
  ) as EscrowRuntime;
}

async function checkedArtifact(
  circuit: string,
  file: string,
): Promise<Uint8Array> {
  const checksums = await readFile(
    resolve(xarkRoot, "timelock-escrow-keys.CHECKSUM"),
    "utf8",
  );
  const expected = checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(([, name]) => name === `${circuit}/${file}`)?.[0];
  assert.ok(expected, `committed checksum for ${circuit}/${file}`);
  const bytes = await readFile(resolve(artifactRoot, circuit, file));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
  return bytes;
}

async function loadProgramCircuit(
  app: EscrowRuntime,
  circuit: "escrow" | "withdraw",
): Promise<LoadedProgramCircuit> {
  const [bytecode, key, verifyingKey] = await Promise.all([
    checkedArtifact(circuit, "circuit.xbc"),
    checkedArtifact(circuit, "pk.bin"),
    checkedArtifact(circuit, "vk.bin"),
  ]);
  const verifier = new app.VerifyingKey(verifyingKey);
  try {
    return { prover: new app.ProvingSession(bytecode, key), verifier };
  } catch (error) {
    verifier.free();
    throw error;
  }
}

function programProof(
  app: EscrowRuntime,
  circuit: LoadedProgramCircuit,
  inputs: Readonly<Record<string, string>>,
  publicHash: Uint8Array,
): Uint8Array {
  const first = circuit.prover.prove(inputs, {});
  let second: ProofBundle | undefined;
  try {
    second = circuit.prover.prove(inputs, {});
    assert.equal(
      circuit.verifier.verify(first.proof, first.publicInputs),
      true,
    );
    assert.equal(
      circuit.verifier.verify(second.proof, second.publicInputs),
      true,
    );
    assert.deepEqual(first.publicInputs, second.publicInputs);
    app.programProof(first.proof, first.publicInputs, publicHash);
    const proof = app.compressedProgramProof(first.proof);
    const randomized = app.compressedProgramProof(second.proof);
    assert.equal(proof.length, 128);
    for (const [start, end] of [
      [0, 32],
      [32, 96],
      [96, 128],
    ]) {
      assert.notDeepEqual(
        proof.subarray(start, end),
        randomized.subarray(start, end),
        "Xark proof points use fresh blinding",
      );
    }
    return proof;
  } finally {
    first.free();
    second?.free();
  }
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, bytes) => length + bytes.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function portIsFree(port: number): Promise<void> {
  const listener = createServer();
  await new Promise<void>((ready, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", ready);
  });
  await new Promise<void>((done, reject) =>
    listener.close((error) => (error ? reject(error) : done())),
  );
}

test(
  "Xark escrow and withdraw use local TypeScript SPP proofs",
  { timeout: 300_000 },
  async (t) => {
    const app = applicationRuntime();
    const escrowCircuit = await loadProgramCircuit(app, "escrow");
    t.after(() => {
      escrowCircuit.prover.free();
      escrowCircuit.verifier.free();
    });
    const withdrawCircuit = await loadProgramCircuit(app, "withdraw");
    t.after(() => {
      withdrawCircuit.prover.free();
      withdrawCircuit.verifier.free();
    });
    const local = await createLocalProofService({
      threads: Number(process.env["ZOLANA_LOCAL_PROVING_THREADS"] ?? 4),
      keyDirectory: process.env["ZOLANA_LOCAL_PROVING_KEYS_DIR"],
    });
    t.after(() => local.close());
    await local.preload("transfer_confidential_1_2.key");
    const counted = countProofs(local, [1, 2]);

    const cli =
      process.env["ZOLANA_CLI_BIN"] ?? resolve(xarkRoot, ".tools/bin/zolana");
    const rpcPort = Number(process.env["ZOLANA_XARK_RPC_PORT"] ?? "18599");
    const photonPort = Number(
      process.env["ZOLANA_XARK_PHOTON_PORT"] ?? "18784",
    );
    const proverPort = Number(
      process.env["ZOLANA_XARK_PROVER_PORT"] ?? "18001",
    );
    await Promise.all(
      [rpcPort, rpcPort + 1, photonPort, proverPort].map(portIsFree),
    );
    const workingDirectory = resolve(
      xarkRoot,
      `target/typescript-localnet-${rpcPort}`,
    );
    await mkdir(workingDirectory, { recursive: true });
    await mkdir(resolve(workingDirectory, "processes"), { recursive: true });
    const ports = [
      "--rpc-port",
      String(rpcPort),
      "--photon-port",
      String(photonPort),
      "--prover-port",
      String(proverPort),
    ];
    const runCli = (args: string[]) =>
      exec(cli, ["dev", "start", ...ports, ...args], {
        cwd: workingDirectory,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          ZOLANA_PROCESS_SCOPE_DIR: resolve(workingDirectory, "processes"),
        },
      });
    t.after(async () => {
      await runCli(["--stop", "--skip-prover"]);
    });
    await runCli([
      "--skip-prover",
      "--slot-time",
      "50",
      "--sbf-program",
      programAddress,
      resolve(xarkRoot, "target/deploy/timelock_escrow_program.so"),
      "--sbf-program",
      SHIELDED_POOL_PROGRAM_ID,
      process.env["SHIELDED_POOL_PROGRAM_PATH"] ??
        resolve(xarkRoot, "target/deploy/shielded_pool_program.so"),
      "--account-dir",
      process.env["ZOLANA_XARK_ACCOUNTS_DIR"] ??
        resolve(xarkRoot, "target/typescript-accounts"),
    ]);

    const client = await createSprClient({
      solanaRpcUrl: `http://127.0.0.1:${rpcPort}`,
      indexerUrl: `http://127.0.0.1:${photonPort}`,
      proverUrl: `http://127.0.0.1:${proverPort}`,
      proofDataSource: "client",
      fetch: fetchWithoutProver,
    });
    const proofService: ProofService = {
      async prove(inputs, context) {
        const first = await counted.prove(inputs, context);
        const second = await counted.prove(inputs, context);
        for (const point of ["a", "b", "c"] as const) {
          assert.notDeepEqual(
            first[point],
            second[point],
            `local SPP ${point} uses fresh blinding`,
          );
        }
        return first;
      },
      proveMerge: (inputs, context) => counted.proveMerge(inputs, context),
    };
    const signingKey = SigningKey.generate();
    const creator = ShieldedKeypair.fromKeypair(signingKey);
    t.after(() => creator.destroy());
    const creatorAddress = creator.shieldedAddress();
    const signer = creator.toSolanaSigner();
    const creatorKeys = LocalKeys.fromKeypair(creator, proofService);
    t.after(() => creatorKeys.destroy());
    const assets = new AssetRegistry();
    const wallet = new Wallet({ identity: creatorAddress, registry: assets });
    const send = sendAndConfirmFactory(client, signer);
    const airdrop = await client.solanaRpc
      .requestAirdrop(signer.address, lamports(2_000_000_000n))
      .send();
    await client.confirmTransaction(airdrop);
    const deposited = await send([
      await depositInstruction({
        tree: client.tree,
        depositor: signer,
        deposits: [
          {
            asset: DepositAsset.sol(),
            viewTag: creatorAddress.confidentialViewTag(),
            recipientOwnerHash: creatorAddress.ownerHash(),
            amount: shieldAmount,
          },
        ],
      }),
    ]);
    await syncWallet({
      client,
      wallet,
      keys: creatorKeys,
      config: { requireSlot: deposited.slot },
    });
    assert.equal(wallet.balance(SOL_MINT).amount, shieldAmount);
    const [source] = wallet.utxos().filter((utxo) => !utxo.spent);
    assert.ok(source);
    const [authorityAddress, authorityBump] = await getProgramDerivedAddress({
      programAddress,
      seeds: ["escrow_authority", getAddressEncoder().encode(signer.address)],
    });
    const owner = new ProgramOwner(authorityAddress);
    const escrowAddress = owner.address(creator.viewingPublicKey());
    const escrowViewingKey = creator.viewingKey();
    const escrowNullifierKey = ProgramOwner.nullifierKey();
    const escrowKeys = LocalKeys.fromKeys(
      {
        address: escrowAddress,
        viewingKeys: [escrowViewingKey],
        nullifierKey: escrowNullifierKey,
      },
      proofService,
    );
    escrowViewingKey.destroy();
    escrowNullifierKey.destroy();
    t.after(() => escrowKeys.destroy());
    const asProgramUtxo = (
      utxo: Parameters<typeof toProgramWalletUtxo>[0],
      nullifierPublicKey = creator.nullifierPublicKey(),
    ) =>
      toProgramWalletUtxo(utxo, {
        nullifierPublicKey,
        treeId: client.treeId,
        assets,
      });
    const ownerPkField = BigInt(
      `0x${Buffer.from(creator.signingPublicKey().ownerProofInputHash()).toString("hex")}`,
    ).toString();
    // Rust 0.10 emits an assignment map; the published SDK 0.9 binder expects
    // a binary assignment. Its public finalized-transaction decoder is shared.
    const prepare =
      (build: EscrowRuntime["escrowTransaction"]) =>
      async (inputs: Record<string, unknown>) => {
        const prepared = build(
          inputs,
          creatorAddress.toBytes(),
          signer.address,
        );
        const transaction = await decodeProgramTransaction(
          prepared.finalizedTx,
          assets,
        );
        assert.deepEqual(
          transaction.sender.toBytes(),
          creatorAddress.toBytes(),
        );
        assert.equal(transaction.payer, signer.address);
        assert.equal(
          prepared.proofInputs["public_hash"],
          BigInt(
            `0x${Buffer.from(prepared.publicHash).toString("hex")}`,
          ).toString(),
        );
        return { ...prepared, transaction };
      };
    const prepareEscrow = prepare(app.escrowTransaction);
    const escrow = await prepareEscrow({
      private: {
        txContext: { outputTreeId: client.treeId },
        source: asProgramUtxo(source),
        amount: lockAmount,
        unlock: unlockTimestamp,
      },
      public: { ownerPkField, escrowOwner: escrowAddress.toBytes() },
    });
    const sppEscrow = await client.proveTransact(
      escrow.transaction.encryptWithKeys(creator),
      creatorKeys,
    );
    assert.equal(counted.proofCount, 2);
    assert.deepEqual(
      sppEscrow.privateTxHash,
      escrow.transaction.paddingIndependentPrivateTxHash,
    );
    const escrowProof = programProof(
      app,
      escrowCircuit,
      escrow.proofInputs,
      escrow.publicHash,
    );
    const cpiAccounts = (
      data: TransactInstructionData,
      ownerSigners: readonly (typeof signer)[],
    ) =>
      transactCpiAccounts({
        payer: signer,
        ownerSigners,
        inputTree: client.tree,
        outputTree: client.tree,
        data,
        signerPdas: [authorityAddress],
      });
    const creatorAccount = {
      address: signer.address,
      role: AccountRole.READONLY_SIGNER,
      signer,
    } as const;
    const escrowInstruction: Instruction = {
      programAddress,
      accounts: [creatorAccount, ...(await cpiAccounts(sppEscrow, [signer]))],
      data: concat(
        Uint8Array.of(0),
        escrowProof,
        creator.viewingPublicKey().toBytes(),
        Uint8Array.of(authorityBump),
        encodeTransactInstructionData(sppEscrow),
      ),
    };
    const escrowed = await send([escrowInstruction]);
    await syncWallet({
      client,
      wallet,
      keys: creatorKeys,
      config: { requireSlot: escrowed.slot },
    });
    assert.equal(wallet.balance(SOL_MINT).amount, shieldAmount - lockAmount);
    // Keep the program's data-bearing output and attach its confirmed leaf.
    // The generic token-wallet scan does not discover program data UTXOs.
    const output = escrow.transaction.outputs[1];
    assert.ok(output);
    assert.deepEqual(output.ownerAddress?.toBytes(), escrowAddress.toBytes());
    assert.equal(output.amount, lockAmount);
    const outputHash = output.hash(client.treeId);
    assert.deepEqual(outputHash, escrow.transaction.outputHashes[1]);
    const indexedEscrow = await client.getShieldedTransactionsBySignature(
      escrowed.signature,
      atSlot(escrowed.slot),
    );
    const outputContext = indexedEscrow.transactions
      .flatMap(({ transaction }) => transaction.outputSlots)
      .find((slot) =>
        Buffer.from(slot.outputContext.hash).equals(outputHash),
      )?.outputContext;
    assert.ok(outputContext, "SPP appended the committed escrow output");
    const escrowUtxo = new Utxo({
      owner: owner.publicKey(),
      asset: output.asset,
      mint: output.mint,
      amount: output.amount,
      blinding: output.blinding,
      data: output.data,
      ringProgramId: output.ringProgramId,
    });
    const nullifierKey = ProgramOwner.nullifierKey();
    const locked = {
      utxo: escrowUtxo,
      outputContext,
      spent: false,
      dataHash: output.dataHash,
      ringDataHash: output.ringDataHash,
      nullifier: escrowUtxo.nullifier(outputHash, nullifierKey),
    };
    nullifierKey.destroy();
    const escrowInput = asProgramUtxo(
      locked,
      ProgramOwner.nullifierPublicKey(),
    );
    const terms = app.escrowTermsDataUtxo(escrowInput).data;
    assert.ok(terms && typeof terms === "object" && "unlock" in terms);
    assert.equal(terms.unlock, unlockTimestamp);
    const prepareWithdraw = prepare(app.withdrawTransaction);
    const withdraw = await prepareWithdraw({
      private: {
        txContext: { outputTreeId: client.treeId },
        escrow: escrowInput,
        terms,
      },
      public: { unlock: unlockTimestamp, ownerPkField },
    });
    const sppWithdraw = await client.proveTransact(
      withdraw.transaction.encryptWithKeys(creator),
      escrowKeys,
    );
    assert.equal(counted.proofCount, 4);
    assert.deepEqual(
      sppWithdraw.privateTxHash,
      withdraw.transaction.paddingIndependentPrivateTxHash,
    );
    const withdrawProof = programProof(
      app,
      withdrawCircuit,
      withdraw.proofInputs,
      withdraw.publicHash,
    );
    const unlockBytes = new Uint8Array(8);
    new DataView(unlockBytes.buffer).setBigUint64(0, unlockTimestamp, true);
    const withdrawn = await send([
      {
        programAddress,
        accounts: [
          { ...creatorAccount, role: AccountRole.WRITABLE_SIGNER },
          creatorAccount,
          ...(await cpiAccounts(sppWithdraw, [])),
        ],
        data: concat(
          Uint8Array.of(1),
          withdrawProof,
          unlockBytes,
          Uint8Array.of(authorityBump),
          encodeTransactInstructionData(sppWithdraw),
        ),
      },
    ]);
    await syncWallet({
      client,
      wallet,
      keys: creatorKeys,
      config: { requireSlot: withdrawn.slot },
    });
    assert.equal(wallet.balance(SOL_MINT).amount, shieldAmount);
    const spentEscrow = await client.getShieldedTransactionsByNullifiers(
      { nullifiers: [locked.nullifier] },
      atSlot(withdrawn.slot),
    );
    assert.equal(
      spentEscrow.data.some(
        ({ signature }) => signature === withdrawn.signature,
      ),
      true,
    );

    const payerFile = resolve(workingDirectory, "client-example-payer.json");
    const seed = signingKey.secretBytes();
    try {
      await writeFile(
        payerFile,
        JSON.stringify([...seed, ...signingKey.publicKey().ed25519()]),
        { mode: 0o600 },
      );
    } finally {
      seed.fill(0);
    }
    try {
      const runClient = (entry: string) =>
        exec(
          process.execPath,
          ["--import", "tsx", resolve(root, "typescript-client", entry)],
          {
            cwd: resolve(root, "typescript-client"),
            timeout: 120_000,
            env: {
              ...process.env,
              ZOLANA_ENDPOINT: `http://127.0.0.1:${rpcPort}`,
              ZOLANA_INDEXER_URL: `http://127.0.0.1:${photonPort}`,
              ZOLANA_PROVER_URL: `http://127.0.0.1:${proverPort}`,
              ZOLANA_PROOF_DATA_SOURCE: "client",
              ZOLANA_PAYER_KEYPAIR: payerFile,
            },
          },
        );
      const normal = await runClient("examples/local_proving.ts");
      // The CLI reports the change from its own new deposit, not all prior funds.
      assert.match(normal.stdout, /withdraw private_balance=4000000\b/u);
      const checked = await runClient("tests/support/local-proving-client.ts");
      assert.match(checked.stdout, /local_proving proofs=2/u);
    } finally {
      await rm(payerFile, { force: true });
    }
  },
);
