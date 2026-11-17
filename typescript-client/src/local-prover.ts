import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  Proof,
  ProofService,
  ProverInputs,
  MergeInputs,
} from "@heliuslabs/spr/client";
import type { RequestContext } from "@heliuslabs/spr/interface";
import { init, type SprProver } from "@heliuslabs/zopro-spr";
import { PROVING_KEY_SHA256S } from "@heliuslabs/spr/internal";

import catalog from "./local-proving-keys.json" with { type: "json" };

interface KeyArtifact {
  readonly file: string;
  readonly size: number;
  readonly sha256: string;
  readonly keySha256: string;
}

export interface LocalProofService extends ProofService {
  readonly proofCount: number;
  close(): Promise<void>;
}

export interface LocalProofOptions {
  readonly threads?: number;
  readonly keyDirectory?: string;
}

const artifacts: Readonly<Record<string, KeyArtifact>> = catalog.keys;

function checkedKey(bytes: Uint8Array, artifact: KeyArtifact): void {
  if (
    bytes.byteLength !== artifact.size ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  ) {
    throw new Error(`Proving key size or SHA-256 mismatch: ${artifact.file}`);
  }
}

/** The CLI v0.10.0 deployment's zopro conversions, pinned by the published web prover. */
async function keyBytes(
  directory: string,
  artifact: KeyArtifact,
  context?: RequestContext,
): Promise<Uint8Array> {
  const path = join(directory, artifact.file);
  try {
    const bytes = await readFile(path);
    checkedKey(bytes, artifact);
    return bytes;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const timeout = AbortSignal.timeout(120_000);
  const response = await fetch(new URL(artifact.file, catalog.baseUrl), {
    signal: context?.signal
      ? AbortSignal.any([context.signal, timeout])
      : timeout,
  });
  if (!response.ok)
    throw new Error(
      `Could not download ${artifact.file}: HTTP ${response.status}`,
    );
  const bytes = new Uint8Array(await response.arrayBuffer());
  checkedKey(bytes, artifact);
  await mkdir(directory, { recursive: true });
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return bytes;
}

/** In-process SPP proving. RPC and indexer access remain in the SDK client. */
export async function createLocalProofService(
  options: LocalProofOptions = {},
): Promise<LocalProofService> {
  for (const [name, artifact] of Object.entries(artifacts)) {
    if (PROVING_KEY_SHA256S[name] !== artifact.keySha256)
      throw new Error(
        `The local key catalog does not match the SDK deployment: ${name}`,
      );
  }
  const threads =
    options.threads ??
    Number(
      process.env["ZOLANA_LOCAL_PROVING_THREADS"] ??
        Math.min(4, availableParallelism()),
    );
  const runtime = await init({ threads });
  const directory = resolve(
    options.keyDirectory ??
      process.env["ZOLANA_LOCAL_PROVING_KEYS_DIR"] ??
      join(
        homedir(),
        ".cache",
        "zolana-examples",
        "proving-keys",
        "78751f5d1c591777",
      ),
  );
  let loaded: { name: string; prover: SprProver } | undefined;
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  let proofCount = 0;

  async function load(
    name: string,
    context?: RequestContext,
  ): Promise<SprProver> {
    if (loaded?.name === name) return loaded.prover;
    const artifact = artifacts[name];
    if (!artifact) throw new Error(`No pinned local proving key for ${name}`);
    const bytes = await keyBytes(directory, artifact, context);
    loaded?.prover.free();
    loaded = undefined;
    const prover = new runtime.SprProver(bytes);
    if (prover.digest() !== artifact.keySha256) {
      prover.free();
      throw new Error(`Source proving key digest mismatch: ${name}`);
    }
    loaded = { name, prover };
    return prover;
  }

  function enqueue(run: () => Promise<Proof>): Promise<Proof> {
    if (closed)
      return Promise.reject(new Error("The local proof service is closed"));
    const result = queue.then(run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    get proofCount() {
      return proofCount;
    },
    prove(inputs: ProverInputs, context?: RequestContext): Promise<Proof> {
      return enqueue(async () => {
        if (inputs.circuit !== "transfer")
          throw new Error(
            "This example proves confidential SPP transfers locally",
          );
        context?.signal?.throwIfAborted();
        const prover = await load(
          `transfer_confidential_${inputs.payload.inputs.length}_${inputs.payload.outputs.length}.key`,
          context,
        );
        const proof = await prover.prove(inputs, context);
        proofCount++;
        return proof;
      });
    },
    proveMerge(inputs: MergeInputs, context?: RequestContext): Promise<Proof> {
      return enqueue(async () => {
        if (inputs.ringProgramId !== 0n)
          throw new Error(
            "This example proves confidential SPP merges locally",
          );
        context?.signal?.throwIfAborted();
        const prover = await load(
          `merge_${inputs.inputs.length}_1.key`,
          context,
        );
        const proof = await prover.proveMerge(inputs, context);
        proofCount++;
        return proof;
      });
    },
    close(): Promise<void> {
      closed = true;
      closing ??= queue.then(async () => {
        loaded?.prover.free();
        loaded = undefined;
        await runtime.close();
      });
      return closing;
    },
  };
}

/** Keep RPC and indexer calls, and refuse every HTTP proving route. */
export const fetchWithoutProver: typeof fetch = (input, request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.split("/").includes("prove"))
    throw new Error("Proof requests must use the in-process prover");
  return fetch(input, request);
};
