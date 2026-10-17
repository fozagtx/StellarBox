import {
  Address,
  contract,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import {
  ExactStellarScheme,
  getEstimatedLedgerCloseTimeSeconds,
  type ClientStellarSigner,
} from "@x402/stellar";
import type { AgentKeyStore } from "@stellabox/signer";
import {
  loadStellarConfig,
  signAgentAuthEntryWithKeyStore,
} from "@stellabox/stellar";
import { assertX402MaxAmount } from "./policy.js";

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

async function createSmartAccountPaymentPayload(input: {
  paymentRequired: PaymentRequired;
  requirement: PaymentRequirements;
  payer: string;
  authorizeEntry: (
    entry: xdr.SorobanAuthorizationEntry,
    expirationLedger: number,
    networkPassphrase: string
  ) => Promise<xdr.SorobanAuthorizationEntry>;
}): Promise<PaymentPayload> {
  if (input.paymentRequired.x402Version !== 2) {
    throw new Error("x402_version_unsupported");
  }
  const config = loadStellarConfig();
  const server = new rpc.Server(config.rpcUrl);
  const latestLedger = await server.getLatestLedger();
  const estimatedLedgerSeconds = await getEstimatedLedgerCloseTimeSeconds(
    input.requirement.network
  );
  const expirationLedger =
    latestLedger.sequence +
    Math.ceil(input.requirement.maxTimeoutSeconds / estimatedLedgerSeconds);
  const transaction = await contract.AssembledTransaction.build({
    contractId: input.requirement.asset,
    method: "transfer",
    args: [
      nativeToScVal(input.payer, { type: "address" }),
      nativeToScVal(input.requirement.payTo, { type: "address" }),
      nativeToScVal(BigInt(input.requirement.amount), { type: "i128" }),
    ],
    networkPassphrase: config.networkPassphrase,
    rpcUrl: config.rpcUrl,
    parseResultXdr: (result) => result,
  });
  const unsignedSigners = transaction.needsNonInvokerSigningBy();
  if (
    unsignedSigners.length !== 1 ||
    unsignedSigners[0] !== input.payer
  ) {
    throw new Error(
      `x402_unexpected_signers:${unsignedSigners.join(",")}`
    );
  }
  await transaction.signAuthEntries({
    address: input.payer,
    expiration: expirationLedger,
    authorizeEntry: (entry, _signer, entryExpiration, networkPassphrase) =>
      input.authorizeEntry(entry, entryExpiration, networkPassphrase),
  });
  await transaction.simulate();
  if (
    transaction.simulation &&
    "error" in transaction.simulation &&
    transaction.simulation.error
  ) {
    throw new Error(`x402_payment_simulation_failed:${transaction.simulation.error}`);
  }
  if (transaction.needsNonInvokerSigningBy().length > 0 || !transaction.built) {
    throw new Error("x402_payment_authorization_incomplete");
  }
  return {
    x402Version: 2,
    payload: { transaction: transaction.built.toXDR() },
    accepted: input.requirement,
    ...(input.paymentRequired.extensions
      ? { extensions: input.paymentRequired.extensions }
      : {}),
    ...(input.paymentRequired.resource
      ? { resource: input.paymentRequired.resource }
      : {}),
  };
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
  const httpClient = makeHttpClient(input.payer, async () => {
    throw new Error("Unexpected x402 authorization signing");
  });
  const payload = await createSmartAccountPaymentPayload({
    paymentRequired: prepared.paymentRequired,
    requirement: prepared.requirement,
    payer: input.payer,
    authorizeEntry: async (unsigned) => {
      const signed = signedByInvocation.get(unsigned.rootInvocation().toXDR("base64"));
      if (!signed) throw new Error("x402_approval_auth_entry_mismatch");
      const unsignedExpiration = parseEntryExpiration(unsigned);
      if (parseEntryExpiration(signed) !== unsignedExpiration) {
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
      return signed;
    },
  });
  const response = await fetch(prepared.target, {
    method: input.method,
    ...(input.body ? { body: input.body } : {}),
    headers: httpClient.encodePaymentSignatureHeader(payload),
    redirect: "manual",
  });
  const settlement = httpClient.getPaymentSettleResponse(
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
  agentPublicKey: Buffer;
  contextRuleId: number;
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
  const httpClient = makeHttpClient(input.payer, async () => {
    throw new Error("Unexpected x402 authorization signing");
  });
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
  try {
    assertX402MaxAmount(amount, input.maxAmountStroops);
  } catch {
    throw new X402LimitError("x402_amount_exceeds_max", amount);
  }
  if (amount > input.txCapStroops) {
    throw new X402LimitError("over_tx_cap", amount);
  }
  if (amount > input.remainingBudgetStroops) {
    throw new X402LimitError("over_daily_cap", amount);
  }
  const payload = await createSmartAccountPaymentPayload({
    paymentRequired,
    requirement,
    payer: input.payer,
    authorizeEntry: (entry, expirationLedger, networkPassphrase) =>
      signAgentAuthEntryWithKeyStore({
        entry,
        publicKey: input.agentPublicKey,
        ed25519Verifier: config.ed25519Verifier,
        networkPassphrase,
        contextRuleIds: [input.contextRuleId],
        expirationLedger,
        signDigest: (digest) => input.signer.sign(input.kmsKeyRef, digest),
      }),
  });
  const signatureHeaders = httpClient.encodePaymentSignatureHeader(payload);
  const paidResponse = await fetch(target, {
    method: input.method,
    ...(input.body ? { body: input.body } : {}),
    headers: signatureHeaders,
  });
  if (paidResponse.status === 402) {
    const responseText = await paidResponse.clone().text();
    let responseBody: unknown;
    try {
      responseBody = responseText ? JSON.parse(responseText) as unknown : undefined;
    } catch {
      responseBody = undefined;
    }
    let paymentRequiredError: string | undefined;
    try {
      const rejectedPayment = httpClient.getPaymentRequiredResponse(
        (name) => paidResponse.headers.get(name),
        responseBody
      ) as PaymentRequired;
      paymentRequiredError = rejectedPayment.error;
    } catch {
      paymentRequiredError = undefined;
    }
    throw new Error(
      `x402_payment_response_402:${paymentRequiredError ?? responseText.slice(0, 2_000)}`
    );
  }
  const result = await httpClient.processPaymentResult(
    payload,
    (name) => paidResponse.headers.get(name),
    paidResponse.status
  );
  let settlement;
  try {
    settlement = httpClient.getPaymentSettleResponse(
      (name) => paidResponse.headers.get(name)
    );
  } catch {
    const responseBody = (await paidResponse.clone().text()).slice(0, 2_000);
    throw new Error(`x402_payment_response_${paidResponse.status}:${responseBody}`);
  }
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
