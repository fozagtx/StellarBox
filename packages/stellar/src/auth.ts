import {
  Ed25519Signer,
  computeEntryAuthDigest,
  signerToScVal,
} from "smart-account-kit";
import { xdr } from "@stellar/stellar-sdk";
import type { Signer as ContractSigner } from "smart-account-kit-bindings";

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

export async function signAgentAuthEntryWithKeyStore(input: {
  entry: xdr.SorobanAuthorizationEntry;
  publicKey: Buffer;
  ed25519Verifier: string;
  networkPassphrase: string;
  contextRuleIds: number[];
  expirationLedger: number;
  signDigest: (digest: Buffer) => Promise<Uint8Array>;
}): Promise<xdr.SorobanAuthorizationEntry> {
  const signer: ContractSigner = {
    tag: "External",
    values: [input.ed25519Verifier, input.publicKey],
  };
  const { authDigest } = computeEntryAuthDigest(
    input.networkPassphrase,
    input.entry,
    input.expirationLedger,
    input.contextRuleIds
  );
  const signature = await input.signDigest(authDigest);
  const signaturePayload = xdr.ScVal.scvMap([
    mapEntry(
      xdr.ScVal.scvSymbol("context_rule_ids"),
      xdr.ScVal.scvVec(input.contextRuleIds.map((id) => xdr.ScVal.scvU32(id)))
    ),
    mapEntry(
      xdr.ScVal.scvSymbol("signers"),
      xdr.ScVal.scvMap([
        mapEntry(signerToScVal(signer), xdr.ScVal.scvBytes(Buffer.from(signature))),
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
