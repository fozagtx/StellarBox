import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildGrantRuleParameters,
  buildSpendingLimitInstallScVal,
  buildTxMaxInstallScVal,
} from "../src/policy-params.js";

function fields(value: xdr.ScVal): Map<string, xdr.ScVal> {
  return new Map(
    (value.map() ?? []).map((entry) => [entry.key().sym().toString(), entry.val()])
  );
}

describe("policy install parameters", () => {
  it("builds spending-limit and transaction-maximum ScVals", () => {
    const spending = fields(buildSpendingLimitInstallScVal(30_000_000n));
    const txMax = fields(buildTxMaxInstallScVal(10_000_000n));

    expect(spending.get("period_ledgers")?.u32()).toBe(17_280);
    expect(spending.get("spending_limit")?.i128().lo().toString()).toBe("30000000");
    expect(txMax.get("max_amount")?.i128().lo().toString()).toBe("10000000");
  });

  it("builds a USDC grant context and an external agent signer", () => {
    const params = buildGrantRuleParameters({
      usdcAddress: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      spendingLimitPolicy: "CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G",
      txMaxPolicy: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      ed25519Verifier: "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4",
      agentPublicKey: Buffer.alloc(32, 1),
      dailyCapStroops: 30_000_000n,
      txMaxStroops: 10_000_000n,
      validUntilLedger: 1234,
    });

    expect(params.context_type).toEqual({
      tag: "CallContract",
      values: ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
    });
    expect(params.signers[0]?.tag).toBe("External");
    expect(
      params.policies
        .get("CABXBYJNZ7IUW4G3D6BND5YCAQF3ASSDMDAOKQQ63UYFSO7WUU2TIP5G")
        ?.switch().name
    ).toBe("scvMap");
  });
});
