import assert from "node:assert/strict";

import type { ProofService } from "@heliuslabs/spr/client";

export interface CountedProofService extends ProofService {
  readonly proofCount: number;
}

export function countProofs(
  proofs: ProofService,
  transferShape?: readonly [number, number],
): CountedProofService {
  let count = 0;
  return {
    get proofCount() {
      return count;
    },
    async prove(inputs, context) {
      if (transferShape)
        assert.deepEqual(
          [inputs.payload.inputs.length, inputs.payload.outputs.length],
          transferShape,
          "the matching SPP key was decoded during setup",
        );
      const proof = await proofs.prove(inputs, context);
      count++;
      return proof;
    },
    async proveMerge(inputs, context) {
      const proof = await proofs.proveMerge(inputs, context);
      count++;
      return proof;
    },
  };
}

/** Preserve RPC/indexer traffic, but fail a test that sends a proof over HTTP. */
export const fetchWithoutProver: typeof fetch = (input, request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.split("/").includes("prove"))
    throw new Error("Proof requests must use the in-process prover");
  return fetch(input, request);
};
