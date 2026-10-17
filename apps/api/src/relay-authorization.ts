import { StrKey, xdr } from "@stellar/stellar-sdk";

type RelaySubmission =
  | { func: string; auth: string[] }
  | { xdr: string };

function contractAddress(address: xdr.ScAddress): string | undefined {
  if (address.switch().name !== "scAddressTypeContract") return undefined;
  return StrKey.encodeContract(address.contractId() as unknown as Buffer);
}

function hostFunctionInvokesWallet(
  hostFunction: xdr.HostFunction,
  walletContractId: string
): boolean {
  if (hostFunction.switch().name !== "hostFunctionTypeInvokeContract") {
    return false;
  }
  return (
    contractAddress(hostFunction.invokeContract().contractAddress()) ===
    walletContractId
  );
}

function addressCredentialAddresses(
  entries: xdr.SorobanAuthorizationEntry[]
): Array<string | undefined> {
  return entries.flatMap((entry) => {
    const credentials = entry.credentials();
    const kind = credentials.switch().name;
    if (kind === "sorobanCredentialsAddress") {
      return [contractAddress(credentials.address().address())];
    }
    if (kind === "sorobanCredentialsAddressV2") {
      return [contractAddress(credentials.addressV2().address())];
    }
    if (kind === "sorobanCredentialsAddressWithDelegates") {
      return [
        contractAddress(
          credentials
            .addressWithDelegates()
            .addressCredentials()
            .address()
        ),
      ];
    }
    return [];
  });
}

function transactionOperations(encodedXdr: string): xdr.Operation[] {
  const envelope = xdr.TransactionEnvelope.fromXDR(encodedXdr, "base64");
  const kind = envelope.switch().name;
  if (kind === "envelopeTypeTx") {
    return envelope.v1().tx().operations();
  }
  if (kind === "envelopeTypeTxV0") {
    return envelope.v0().tx().operations();
  }
  if (kind === "envelopeTypeTxFeeBump") {
    return envelope.feeBump().tx().innerTx().v1().tx().operations();
  }
  throw new Error("Unsupported relayer transaction envelope");
}

function isWalletOwned(
  hostFunctions: xdr.HostFunction[],
  entries: xdr.SorobanAuthorizationEntry[],
  walletContractId: string
): boolean {
  const addresses = addressCredentialAddresses(entries);
  const allAddressCredentialsBelongToWallet =
    addresses.length > 0 &&
    addresses.every((address) => address === walletContractId);
  return (
    allAddressCredentialsBelongToWallet ||
    hostFunctions.some((hostFunction) =>
      hostFunctionInvokesWallet(hostFunction, walletContractId)
    )
  );
}

export function relaySubmissionBelongsToWallet(
  submission: RelaySubmission,
  walletContractId: string
): boolean {
  try {
    if ("func" in submission) {
      const hostFunction = xdr.HostFunction.fromXDR(submission.func, "base64");
      const entries = submission.auth.map((entry) =>
        xdr.SorobanAuthorizationEntry.fromXDR(entry, "base64")
      );
      return isWalletOwned([hostFunction], entries, walletContractId);
    }

    const operations = transactionOperations(submission.xdr);
    const hostFunctions: xdr.HostFunction[] = [];
    const entries: xdr.SorobanAuthorizationEntry[] = [];
    for (const operation of operations) {
      const body = operation.body();
      if (body.switch().name !== "invokeHostFunction") continue;
      const invoke = body.invokeHostFunctionOp();
      hostFunctions.push(invoke.hostFunction());
      entries.push(...invoke.auth());
    }
    return isWalletOwned(hostFunctions, entries, walletContractId);
  } catch {
    return false;
  }
}
