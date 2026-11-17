import { pathToFileURL } from "node:url";

import type { ProofService } from "@heliuslabs/spr/client";
import { createLocalProofService } from "@heliuslabs/zopro-spr";

import { runDepositTransferWithdraw } from "./deposit_transfer_withdraw.js";

export async function runLocalProving(
  proofService: ProofService,
  clientFetch?: typeof fetch,
): Promise<void> {
  await runDepositTransferWithdraw({
    proofService,
    ...(clientFetch
      ? { fetch: clientFetch }
      : {}),
  });
}

if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(process.argv[1]).href
) {
  const proofs = await createLocalProofService({
    threads: Number(
      process.env[
        "ZOLANA_LOCAL_PROVING_THREADS"
      ] ?? 4,
    ),
    keyDirectory:
      process.env[
        "ZOLANA_LOCAL_PROVING_KEYS_DIR"
      ],
  });
  try {
    await proofs.preload(
      "transfer_confidential_1_2.key",
    );
    // LocalKeys receives the package's ProofService through the shared flow.
    await runLocalProving(proofs);
  } finally {
    await proofs.close();
  }
}
