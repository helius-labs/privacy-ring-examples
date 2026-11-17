import {
  SprNodeProver,
  shapeByLabel,
} from "@heliuslabs/spr-web-prover/node";

import { localProofService } from "../src/local-proof-service.js";

import { runDepositTransferWithdraw } from "./deposit_transfer_withdraw.js";

const prover = new SprNodeProver({
  threads: Number(
    process.env["ZOLANA_LOCAL_PROVING_THREADS"] ??
      4,
  ),
  cacheDir:
    process.env["ZOLANA_LOCAL_PROVING_CACHE_DIR"],
  gpu: "off",
});
try {
  await prover.ensureKey(shapeByLabel("1x2"));
  await runDepositTransferWithdraw({
    proofService: localProofService(prover),
  });
} finally {
  prover.terminate();
}
