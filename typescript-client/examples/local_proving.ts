import {
  SprNodeProver,
  shapeByLabel,
} from "@heliuslabs/spr-web-prover/node";

import { runDepositTransferWithdraw } from "./deposit_transfer_withdraw.js";

// This URL identifies the intercepted route; no prover server listens here.
const proverUrl = "http://127.0.0.1:3001";
const prover = new SprNodeProver({
  proverUrl,
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
    proverUrl,
    fetch: prover.createFetch(),
  });
} finally {
  prover.terminate();
}
