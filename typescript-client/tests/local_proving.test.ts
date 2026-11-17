import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { SprNodeProver, shapeByLabel } from "@heliuslabs/spr-web-prover/node";

import {
  countLocalProofs,
  fetchWithoutProver,
} from "./support/local-proving.js";

test(
  "the packed Node prover answers SDK routes locally with randomized proofs",
  { timeout: 120_000 },
  async () => {
    const proverUrl = "http://127.0.0.1:3001";
    const keyLoads: number[] = [];
    const prover = new SprNodeProver({
      proverUrl,
      threads: 2,
      gpu: "off",
      cacheDir: process.env["ZOLANA_LOCAL_PROVING_CACHE_DIR"],
      fetch: fetchWithoutProver,
      onMeasurement: ({ step, ms }) => {
        if (step === "key-load") keyLoads.push(ms);
      },
    });
    try {
      await prover.ensureKey(shapeByLabel("1x2"));
      keyLoads.length = 0;
      const body = await readFile(
        new URL("./fixtures/transfer-1x2.json", import.meta.url),
        "utf8",
      );
      const counted = countLocalProofs(prover.createFetch());
      const prove = async () => {
        const response = await counted.fetch(
          `${proverUrl}/prove/transfer_confidential_1_2`,
          { method: "POST", body },
        );
        assert.equal(response.status, 200);
        return response.json();
      };
      const first = await prove();
      const second = await prove();
      assert.equal(counted.proofCount, 2);
      assert.equal(
        first.provingKeySha256,
        "c0b5c1a1081136911a6ad5496fb989ed26d85b09e983a4d5048cff96e0833d85",
      );
      assert.equal(second.provingKeySha256, first.provingKeySha256);
      for (const point of ["ar", "bs", "krs"])
        assert.notDeepEqual(first[point], second[point]);
      assert.deepEqual(
        keyLoads,
        [0, 0],
        "proofs reuse the key decoded during setup",
      );
      assert.throws(
        () =>
          fetchWithoutProver(`${proverUrl}/prove`, { method: "POST", body }),
        /Proof requests must use/,
      );
    } finally {
      prover.terminate();
    }
  },
);
