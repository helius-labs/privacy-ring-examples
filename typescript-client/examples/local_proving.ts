import { runDepositTransferWithdraw } from "./deposit_transfer_withdraw.js";
import {
  createLocalProofService,
  fetchWithoutProver,
} from "../src/local-prover.js";

const proofs = await createLocalProofService();
try {
  // LocalKeys passes complete SDK inputs directly to the WASM ProofService.
  // The client still uses Solana RPC and Photon to build and send transactions.
  await runDepositTransferWithdraw({
    proofService: proofs,
    fetch: fetchWithoutProver,
  });
  if (proofs.proofCount !== 2)
    throw new Error(
      `Expected two locally generated SPP proofs, got ${proofs.proofCount}`,
    );
  console.log(
    `local_proving proofs=${proofs.proofCount}`,
  );
} finally {
  await proofs.close();
}
