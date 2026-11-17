import { createLocalProofService } from "@heliuslabs/zopro-spr";

import { runDepositTransferWithdraw } from "./deposit_transfer_withdraw.js";

const proofs = await createLocalProofService({
  threads: Number(
    process.env["ZOLANA_LOCAL_PROVING_THREADS"] ??
      4,
  ),
  keyDirectory:
    process.env["ZOLANA_LOCAL_PROVING_KEYS_DIR"],
});
try {
  await proofs.preload(
    "transfer_confidential_1_2.key",
  );
  await runDepositTransferWithdraw({
    proofService: proofs,
  });
} finally {
  await proofs.close();
}
