import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { computeEntryAuthDigest, Ed25519Signer } from "smart-account-kit";
import { describe, expect, it } from "vitest";

describe("agent auth digest", () => {
  it("signs the digest bound to the context rule ids", () => {
    const keypair = Keypair.random();
    const signer = new Ed25519Signer(
      keypair,
      "CAAVTMCBXEIBPR64EAASKFXERVPYFZA2JYP5A3BG6PESWEFUJX5IHKN4"
    );
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(
            "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
          ).toScAddress(),
          nonce: xdr.Int64.fromString("1"),
          signatureExpirationLedger: 100,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(
              "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
            ).toScAddress(),
            functionName: xdr.ScVal.scvSymbol("execute").sym(),
            args: [],
          })
        ),
        subInvocations: [],
      }),
    });
    const { authDigest } = computeEntryAuthDigest(
      "Test SDF Network ; September 2015",
      entry,
      100,
      [1]
    );
    const signature = signer.signAuthDigest(authDigest);

    expect(signature).toHaveLength(64);
    expect(keypair.verify(authDigest, signature)).toBe(true);
  });
});
