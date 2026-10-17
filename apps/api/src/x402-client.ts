import {
  Address,
  contract,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactStellarScheme, type ClientStellarSigner } from "@x402/stellar";
import type { AgentKeyStore } from "@stellabox/signer";
import {
  loadStellarConfig,
  signAgentAuthEntryWithKeyStore,
} from "@stellabox/stellar";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_REQUEST_BODY_BYTES = 65_536;

export class X402LimitError extends Error {
  constructor(
    readonly code: "over_tx_cap" | "over_daily_cap" | "x402_amount_exceeds_max",
    readonly amountStroops: bigint
  ) {
    super(code);
  }
}

function parseEntryExpiration(entry: xdr.SorobanAuthorizationEntry) {
  const credentials = entry.credentials();
  const addressCredentials =
    credentials.switch().name === "sorobanCredentialsAddressV2"
      ? credentials.addressV2()
      : credentials.switch().name === "sorobanCredentialsAddress"
        ? credentials.address()
        : undefined;
  if (!addressCredentials) throw new Error("x402 returned non-address credentials");
  return addressCredentials.signatureExpirationLedger();
}

function validateTarget(value: string, body?: string): URL {
  const target = new URL(value);
  if (
    !["https:", "http:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    (target.protocol === "http:" &&
      !(target.hostname === "localhost" && target.port === "4100"))
  ) {
    throw new Error("x402_url_not_allowed");
  }
  if (body && Buffer.byteLength(body) > MAX_REQUEST_BODY_BYTES) {
    throw new Error("x402_request_body_too_large");
  }
  return target;
}

function makeHttpClient(
  payer: string,
  signAuthEntry: ClientStellarSigner["signAuthEntry"]
) {
  const config = loadStellarConfig();
  return new x402HTTPClient(
    new x402Client().register(
      "stellar:testnet",
      new ExactStellarScheme(
        { address: payer, signAuthEntry } satisfies ClientStellarSigner,
        { url: config.rpcUrl }
      )
    )
  );
}

async function fetchPaymentRequired(input: {
  url: string;
  method: string;
  body?: string;
  payer: string;
}) {
  const target = validateTarget(input.url, input.body);
  const initial = await fetch(target, {
    method: input.method,
    ...(input.body ? { body: input.body } : {}),
    redirect: "manual",
  });
  if (initial.status !== 402) {
    throw new Error(`x402_resource_expected_402_got_${initial.status}`);
  }
  const bodyBytes = Buffer.from(await initial.arrayBuffer());
  if (bodyBytes.length > MAX_RESPONSE_BYTES) throw new Error("x402_response_too_large");
  let bodyJson: unknown;
  try {
    bodyJson = bodyBytes.length ? JSON.parse(bodyBytes.toString("utf8")) : undefined;
  } catch {
    bodyJson = undefined;
  }
  const client = makeHttpClient(input.payer, async () => {
    throw new Error("Unexpected x402 authorization signing during requirement parsing");
  });
  const paymentRequired = client.getPaymentRequiredResponse(
    (name) => initial.headers.get(name),
    bodyJson
  ) as PaymentRequired;
  const config = loadStellarConfig();
  const requirement = paymentRequired.accepts.find(
    (accepted) =>
      accepted.scheme === "exact" &&
      accepted.network === "stellar:testnet" &&
      accepted.asset === config.usdcSac
  );
  if (!requirement) throw new Error("x402_requirement_not_supported");
  const amountStroops = BigInt(requirement.amount);
  if (amountStroops <= 0n) throw new Error("x402_requirement_invalid_amount");
  return { target, initial, client, paymentRequired, requirement, amountStroops };
}

export async function prepareX402Approval(input: {
  url: string;
  method: string;
  body?: string;
  payer: string;
  expectedAmountStroops: bigint;
}) {
  const prepared = await fetchPaymentRequired(input);
  if (prepared.amountStroops !== input.expectedAmountStroops) {
    throw new Error("x402_approval_amount_changed");
  }
  const transaction = await contract.AssembledTransaction.build({
    contractId: prepared.requirement.asset,
    method: "transfer",
    args: [
      nativeToScVal(input.payer, { type: "address" }),
      nativeToScVal(prepared.requirement.payTo, { type: "address" }),
      nativeToScVal(prepared.amountStroops, { type: "i128" }),
    ],
    networkPassphrase: loadStellarConfig().networkPassphrase,
    rpcUrl: loadStellarConfig().rpcUrl,
    parseResultXdr: (result) => result,
  });
  const simulation = transaction.simulation;
  if (!simulation || ("error" in simulation && simulation.error)) {
    throw new Error(
      `x402_payment_simulation_failed:${simulation && "error" in simulation ? simulation.error : "missing"}`
    );
  }
  if (!("result" in simulation) || !simulation.result) {
    throw new Error("x402_payment_simulation_missing_result");
  }
  const authEntries = simulation.result.auth ?? [];
  if (authEntries.length === 0 || !transaction.built) {
    throw new Error("x402_payment_auth_entry_missing");
  }
  return {
    kind: "x402",
    url: input.url,
    method: input.method,
    body: input.body,
    amountStroops: prepared.amountStroops.toString(),
    paymentRequired: prepared.paymentRequired,
    transaction: transaction.built.toXDR(),
    auth: authEntries.map((entry) => entry.toXDR("base64")),
  };
}

export async function executeX402Approval(input: {
  url: string;
  method: string;
  body?: string;
  payer: string;
  expectedAmountStroops: bigint;
  signedAuthEntries: string[];
}) {
  if (input.signedAuthEntries.length === 0) {
    throw new Error("x402_approval_auth_entries_required");
  }
  const signedEntries = input.signedAuthEntries.map((value) =>
    xdr.SorobanAuthorizationEntry.fromXDR(value, "base64")
  );
  const prepared = await fetchPaymentRequired(input);
  if (prepared.amountStroops !== input.expectedAmountStroops) {
    throw new Error("x402_approval_amount_changed");
  }
  const signedByInvocation = new Map(
    signedEntries.map((entry) => [
      entry.rootInvocation().toXDR("base64"),
      entry,
    ])
  );
  const client = makeHttpClient(input.payer, async (encodedEntry) => {
    const unsigned = xdr.SorobanAuthorizationEntry.fromXDR(encodedEntry, "base64");
    const signed = signedByInvocation.get(unsigned.rootInvocation().toXDR("base64"));
    if (!signed) throw new Error("x402_approval_auth_entry_mismatch");
    const expiration = parseEntryExpiration(unsigned);
    if (parseEntryExpiration(signed) !== expiration) {
      throw new Error("x402_approval_auth_expiration_mismatch");
    }
    const credentials = signed.credentials();
    if (
      credentials.switch().name !== "sorobanCredentialsAddressV2" &&
      credentials.switch().name !== "sorobanCredentialsAddress"
    ) {
      throw new Error("x402_approval_auth_credentials_invalid");
    }
    const signedAddress =
      credentials.switch().name === "sorobanCredentialsAddressV2"
        ? credentials.addressV2().address()
        : credentials.address().address();
    if (Address.fromScAddress(signedAddress).toString() !== input.payer) {
      throw new Error("x402_approval_auth_payer_mismatch");
    }
    return {
      signedAuthEntry: signed.toXDR("base64"),
      signerAddress: input.payer,
    };
  });
  const payload = await client.createPaymentPayload({
    ...prepared.paymentRequired,
    accepts: [prepared.requirement],
  });
  const response = await fetch(prepared.target, {
    method: input.method,
    ...(input.body ? { body: input.body } : {}),
    headers: client.encodePaymentSignatureHeader(payload),
    redirect: "manual",
  });
  const settlement = client.getPaymentSettleResponse(
    (name) => response.headers.get(name)
  );
  if (response.status === 402 || !settlement.success) {
    throw new Error(settlement.errorReason ?? "x402_settlement_failed");
  }
  const responseBytes = Buffer.from(await response.arrayBuffer());
  if (responseBytes.length > MAX_RESPONSE_BYTES) {
    throw new Error("x402_response_too_large");
  }
  let resultBody: unknown;
  try {
    resultBody = JSON.parse(responseBytes.toString("utf8"));
  } catch {
    resultBody = responseBytes.toString("utf8");
  }
  return {
    resultBody,
    txHash: settlement.transaction,
    status: response.status,
  };
}

export async function payX402(input: {
  url: string;
  method: string;
  body?: string;
  maxAmountStroops: bigint;
  txCapStroops: bigint;
  remainingBudgetStroops: bigint;
  payer: string;
  contextRuleId: number;
  agentPublicKey: Buffer;
  kmsKeyRef: string;
  signer: AgentKeyStore;
}) {
  const target = validateTarget(input.url, input.body);
  const config = loadStellarConfig();
  const initial = await fetch(target, {
    method: input.method,
    ...(input.body ? { body: input.body } : {}),
  });
  if (initial.status !== 402) {
    const bytes = Buffer.from(await initial.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("x402_response_too_large");
    return { body: bytes.toString("utf8"), txHash: undefined, status: initial.status };
  }
  const firstBody = await initial.clone().text();
  let bodyJson: unknown;
  try {
    bodyJson = firstBody ? JSON.parse(firstBody) : undefined;
  } catch {
    bodyJson = undefined;
  }
  const httpClient = new x402HTTPClient(
    new x402Client().register(
      "stellar:testnet",
      new ExactStellarScheme(
        {
          address: input.payer,
          signAuthEntry: async (authEntry, options) => {
            const entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntry, "base64");
            const signedEntry = await signAgentAuthEntryWithKeyStore({
              entry,
              publicKey: input.agentPublicKey,
              ed25519Verifier: config.ed25519Verifier,
              networkPassphrase: options?.networkPassphrase ?? config.networkPassphrase,
              contextRuleIds: [input.contextRuleId],
              expirationLedger: parseEntryExpiration(entry),
              signDigest: (digest) => input.signer.sign(input.kmsKeyRef, digest),
            });
            return {
              signedAuthEntry: signedEntry.toXDR("base64"),
              signerAddress: input.payer,
            };
          },
        } satisfies ClientStellarSigner,
        { url: config.rpcUrl }
      )
    )
  );
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name) => initial.headers.get(name),
    bodyJson
  ) as PaymentRequired;
  const requirement = paymentRequired.accepts.find(
    (accepted) =>
      accepted.scheme === "exact" &&
      accepted.network === "stellar:testnet" &&
      accepted.asset === config.usdcSac
  );
  if (!requirement) throw new Error("x402_requirement_not_supported");
  const amount = BigInt(requirement.amount);
  if (amount <= 0n) throw new Error("x402_requirement_invalid_amount");
  if (amount > input.maxAmountStroops) {
    throw new X402LimitError("x402_amount_exceeds_max", amount);
  }
  if (amount > input.txCapStroops) {
    throw new X402LimitError("over_tx_cap", amount);
  }
  if (amount > input.remainingBudgetStroops) {
    throw new X402LimitError("over_daily_cap", amount);
  }
  const payload = await httpClient.createPaymentPayload({
    ...paymentRequired,
    accepts: [requirement],
  });
  const signatureHeaders = httpClient.encodePaymentSignatureHeader(payload);
  const paidResponse = await fetch(target, {
    method: input.method,
    ...(input.body ? { body: input.body } : {}),
    headers: signatureHeaders,
  });
  const result = await httpClient.processPaymentResult(
    payload,
    (name) => paidResponse.headers.get(name),
    paidResponse.status
  );
  const settlement = httpClient.getPaymentSettleResponse(
    (name) => paidResponse.headers.get(name)
  );
  if (paidResponse.status === 402 || !settlement.success || result.settleResponse?.success === false) {
    throw new Error(settlement.errorReason ?? "x402_settlement_failed");
  }
  const bytes = Buffer.from(await paidResponse.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) throw new Error("x402_response_too_large");
  return {
    body: bytes.toString("utf8"),
    txHash: settlement.transaction,
    status: paidResponse.status,
  };
}
