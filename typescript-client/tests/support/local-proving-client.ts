import assert from "node:assert/strict";
import { SprNodeProver, shapeByLabel } from "@heliuslabs/spr-web-prover/node";

import { localProofService } from "../../src/local-proof-service.js";

import { runDepositTransferWithdraw } from "../../examples/deposit_transfer_withdraw.js";
import { countProofs, fetchWithoutProver } from "./local-proving.js";

const prover = new SprNodeProver({
  threads: Number(process.env["ZOLANA_LOCAL_PROVING_THREADS"] ?? 4),
  cacheDir: process.env["ZOLANA_LOCAL_PROVING_CACHE_DIR"],
  gpu: "off",
  fetch: fetchWithoutProver,
});
const counted = countProofs(localProofService(prover), [1, 2]);
try {
  await prover.ensureKey(shapeByLabel("1x2"));
  await runDepositTransferWithdraw({
    proofService: counted,
    fetch: fetchWithoutProver,
  });
  assert.equal(counted.proofCount, 2);
  console.log(`local_proving proofs=${counted.proofCount}`);
} finally {
  prover.terminate();
}
