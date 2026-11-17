import assert from "node:assert/strict";

/** Count successful intercepted requests and check the preloaded circuit shape. */
export function countLocalProofs(localFetch: typeof fetch) {
  let count = 0;
  return {
    get proofCount() {
      return count;
    },
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      if (!new URL(request.url).pathname.split("/").includes("prove"))
        return localFetch(input, init);
      const body = await request.clone().json();
      assert.equal(body.circuitType, "transfer-confidential");
      assert.deepEqual(
        [body.nInputs, body.nOutputs],
        [1, 2],
        "the SPP key was decoded during setup",
      );
      const response = await localFetch(input, init);
      if (response.ok) count++;
      return response;
    }) satisfies typeof fetch,
  };
}

/** Preserve RPC/indexer traffic, but fail a test that sends a proof over HTTP. */
export const fetchWithoutProver: typeof fetch = (input, request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname.split("/").includes("prove"))
    throw new Error("Proof requests must use the in-process prover");
  return fetch(input, request);
};
