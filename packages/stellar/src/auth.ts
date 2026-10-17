import {
  Ed25519Signer,
  computeEntryAuthDigest,
  signerToScVal,
} from "smart-account-kit";
import { xdr } from "@stellar/stellar-sdk";

function mapEntry(key: xdr.ScVal, val: xdr.ScVal): xdr.ScMapEntry {
  return new xdr.ScMapEntry({ key, val });
}

export function signAgentAuthEntry(input: {
  entry: xdr.SorobanAuthorizationEntry;
  secretKey: string;
  ed25519Verifier: string;
  networkPassphrase: string;
  contextRuleIds: number[];
  expirationLedger: number;
}): xdr.SorobanAuthorizationEntry {
  const signer = Ed25519Signer.fromSecret(input.secretKey, input.ed25519Verifier);
  const { authDigest } = computeEntryAuthDigest(
    input.networkPassphrase,
    input.entry,
    input.expirationLedger,
    input.contextRuleIds
  );
  const signature = signer.signAuthDigest(authDigest);
  const signaturePayload = xdr.ScVal.scvMap([
    mapEntry(
      xdr.ScVal.scvSymbol("context_rule_ids"),
      xdr.ScVal.scvVec(input.contextRuleIds.map((id) => xdr.ScVal.scvU32(id)))
    ),
    mapEntry(
      xdr.ScVal.scvSymbol("signers"),
      xdr.ScVal.scvMap([
        mapEntry(signerToScVal(signer.signer), xdr.ScVal.scvBytes(signature)),
      ])
    ),
  ]);
  const credentials = input.entry.credentials();
  const addressCredentials =
    credentials.switch().name === "sorobanCredentialsAddressV2"
      ? credentials.addressV2()
      : credentials.switch().name === "sorobanCredentialsAddress"
        ? credentials.address()
        : undefined;
  if (!addressCredentials) {
    throw new Error("Expected address credentials for the smart account");
  }
  addressCredentials.signatureExpirationLedger(input.expirationLedger);
  addressCredentials.signature(signaturePayload);
  return input.entry;
}
