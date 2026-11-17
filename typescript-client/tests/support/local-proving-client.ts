import assert from "node:assert/strict";
import { SprNodeProver, shapeByLabel } from "@heliuslabs/spr-web-prover/node";

import { runDepositTransferWithdraw } from "../../examples/deposit_transfer_withdraw.js";
import { countLocalProofs, fetchWithoutProver } from "./local-proving.js";

const proverUrl = "http://127.0.0.1:3001";
const prover = new SprNodeProver({
  proverUrl,
  threads: Number(process.env["ZOLANA_LOCAL_PROVING_THREADS"] ?? 4),
  cacheDir: process.env["ZOLANA_LOCAL_PROVING_CACHE_DIR"],
  gpu: "off",
  fetch: fetchWithoutProver,
});
const counted = countLocalProofs(prover.createFetch());
try {
  await prover.ensureKey(shapeByLabel("1x2"));
  await runDepositTransferWithdraw({ proverUrl, fetch: counted.fetch });
  assert.equal(counted.proofCount, 2);
  console.log(`local_proving proofs=${counted.proofCount}`);
} finally {
  prover.terminate();
}
