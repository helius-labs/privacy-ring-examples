import assert from "node:assert/strict";

import { createLocalProofService } from "@heliuslabs/zopro-spr";

import { runLocalProving } from "../../examples/local_proving.js";
import { countProofs, fetchWithoutProver } from "./local-proving.js";

const proofs = await createLocalProofService({
  threads: Number(process.env["ZOLANA_LOCAL_PROVING_THREADS"] ?? 4),
  keyDirectory: process.env["ZOLANA_LOCAL_PROVING_KEYS_DIR"],
});
const counted = countProofs(proofs, [1, 2]);
try {
  await proofs.preload("transfer_confidential_1_2.key");
  await runLocalProving(counted, fetchWithoutProver);
  assert.equal(counted.proofCount, 2);
  console.log(`local_proving proofs=${counted.proofCount}`);
} finally {
  await proofs.close();
}
