import { createECDH, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDatabase, createSession, registerWallet } from "@stellabox/db";
import { createDelegatedSigner } from "smart-account-kit";
import { Client as SmartAccountClient } from "smart-account-kit-bindings";
import {
  addGrantRule,
  deriveContractId,
  ensureFunded,
  fundUsdcWallet,
  loadStellarConfig,
  removeGrantRule,
} from "@stellabox/stellar";
import { createApiApp } from "../src/app.js";
import { PostgresOAuthProvider } from "../src/oauth.js";
import {
  createPaidApiApp,
  MAX_TRANSACTION_FEE_STROOPS,
} from "../../paid-api/src/index.js";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
process.loadEnvFile?.(resolve(root, ".env"));
process.env.DATABASE_URL ??= "postgres://stellabox:stellabox@127.0.0.1:5433/stellabox";
process.env.KEYSTORE_MASTER_KEY ??= randomBytes(32).toString("base64");
process.env.SESSION_SECRET ??= randomBytes(32).toString("base64url");
process.env.PUBLIC_API_URL = "http://localhost:4000";
process.env.API_PORT = "4000";

const evidencePath = resolve(root, "evidence/e2e-api-testnet.json");
const secretPath = resolve(root, ".deploy/e2e-api-owner.secret");
const apiBase = process.env.PUBLIC_API_URL ?? "http://localhost:4000";
const paidBase = "http://localhost:4100";
const steps: Array<{ step: string; result: string; detail?: string }> = [];
const FACILITATOR_PATH = "in-process @x402/stellar ExactStellarScheme";
const PUBLIC_FACILITATOR_TRIAL = {
  url: "https://x402.org/facilitator",
  status: 402,
  result: "rejected",
  error: "invalid_exact_stellar_payload_fee_exceeds_maximum",
  interpretation: "fee ceiling rejection, not a C-address payer rejection",
  observedDuringPriorTestnetTrial: true,
};
const FACILITATOR_EVENT_VALIDATION =
  "Ignores non-transfer contract events from auth and policy execution; still requires one matching USDC transfer.";

function record(step: string, result: unknown, detail?: string) {
  steps.push({ step, result: JSON.stringify(result), ...(detail ? { detail } : {}) });
}

async function listenPaidApi(): Promise<Server> {
  const server = (await createPaidApiApp()).listen(4100);
  await new Promise<void>((resolveListen, reject) => {
    server.once("listening", resolveListen);
    server.once("error", reject);
  });
  return server;
}

function getToolFailure(result: unknown): { code?: string; reason: string } | undefined {
  if (!result || typeof result !== "object") return undefined;
  const response = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (!response.isError) return undefined;
  if (response.structuredContent && typeof response.structuredContent === "object") {
    const content = response.structuredContent as { code?: unknown; reason?: unknown };
    return {
      ...(typeof content.code === "string" ? { code: content.code } : {}),
      reason: typeof content.reason === "string"
        ? content.reason
        : JSON.stringify(response.structuredContent),
    };
  }
  const message = response.content?.find((entry) => entry.type === "text")?.text;
  return { reason: message ?? "MCP tool failed without structured content" };
}

async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function authCookie(token: string) {
  return `${token}.${createHmac("sha256", process.env.SESSION_SECRET!).update(token).digest("base64url")}`;
}

function parseRuleParameters(value: Record<string, unknown>) {
  const signers = (value.signers as Array<{ tag: string; values: unknown[] }>).map((signer) => ({
    tag: signer.tag as "External",
    values: [
      String(signer.values[0]),
      Buffer.from(String(signer.values[1]), "base64url"),
    ] as [string, Buffer],
  }));
  const policies = new Map(
    Object.entries(value.policies as Record<string, string>).map(([address, encoded]) => [
      address,
      xdr.ScVal.fromXDR(encoded, "base64"),
    ])
  );
  return {
    context_type: value.context_type,
    name: value.name,
    valid_until: value.valid_until,
    signers,
    policies,
  } as unknown as Parameters<SmartAccountClient["add_context_rule"]>[0];
}

async function main() {
  await import("../../../packages/db/src/migrate.js");
  const { db } = createDatabase();
  const apiServer = createApiApp(db).listen(4000);
  await new Promise<void>((resolveListen, reject) => {
    apiServer.once("listening", resolveListen);
    apiServer.once("error", reject);
  });
  const config = loadStellarConfig();
  const server = new rpc.Server(config.rpcUrl);
  await mkdir(resolve(root, ".deploy"), { recursive: true });
  await mkdir(resolve(root, "evidence"), { recursive: true });
  const facilitatorSecretPath = resolve(root, ".deploy/paid-api-facilitator.secret");
  let facilitatorSecret: string;
  try {
    facilitatorSecret = (await readFile(facilitatorSecretPath, "utf8")).trim();
  } catch {
    const facilitator = Keypair.random();
    facilitatorSecret = facilitator.secret();
    await writeFile(facilitatorSecretPath, `${facilitatorSecret}\n`, { mode: 0o600 });
  }
  const facilitatorKey = Keypair.fromSecret(facilitatorSecret);
  await ensureFunded(facilitatorKey, server);
  record("fund_paid_api_facilitator", "friendbot-funded", facilitatorKey.publicKey());
  record(
    "paid_api_facilitator_active",
    FACILITATOR_PATH,
    `max_transaction_fee_stroops=${MAX_TRANSACTION_FEE_STROOPS}`
  );
  const paidServer = await listenPaidApi();
  const owner = Keypair.random();
  await writeFile(secretPath, `${owner.secret()}\n`, { mode: 0o600 });
  await ensureFunded(owner, server);
  const salt = randomBytes(32);
  const account = deriveContractId(owner.publicKey(), salt, config.networkPassphrase);
  const deployment = await SmartAccountClient.deploy(
    { signers: [createDelegatedSigner(owner.publicKey())], policies: new Map() },
    {
      wasmHash: config.accountWasmHash,
      salt,
      publicKey: owner.publicKey(),
      signTransaction: owner,
      networkPassphrase: config.networkPassphrase,
      rpcUrl: config.rpcUrl,
      timeoutInSeconds: 60,
    }
  );
  const deployed = await deployment.signAndSend({ force: true, signTransaction: owner });
  record("deploy_smart_account", deployed.sendTransactionResponse?.hash ?? "submitted", account);
  const funding = await fundUsdcWallet({ smartAccount: account, minimumUsdc: "7", sendXlm: "100" });
  record("fund_smart_account", funding.sacTransferHash, funding.pathPaymentHash);

  const passkeyKey = createECDH("prime256v1");
  passkeyKey.generateKeys();
  const registered = await registerWallet(db, {
    contractAddress: account,
    credentialId: randomBytes(24).toString("base64url"),
    publicKey: passkeyKey.getPublicKey().toString("base64url"),
  });
  const sessionToken = randomBytes(32).toString("base64url");
  await createSession(db, {
    userId: registered.user.id,
    tokenHash: createHash("sha256").update(sessionToken).digest("hex"),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const cookie = `stellabox_session=${authCookie(sessionToken)}`;
  const wallet = await jsonRequest(`${apiBase}/wallets/me`, { headers: { cookie } });
  record("seed_wallet_and_session", registered.wallet.id, JSON.stringify(wallet));

  const grantPayload = await jsonRequest<{
    grantId: string;
    agentPublicKey: string;
    ruleParams: Record<string, unknown>;
  }>(`${apiBase}/grants`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Phase 2 E2E grant",
      client: "e2e-mcp-client",
      dailyCap: "3",
      txCap: "1",
      assets: ["USDC"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }),
  });
  record("create_pending_grant", grantPayload.grantId);
  const accountClient = new SmartAccountClient({
    contractId: account,
    publicKey: owner.publicKey(),
    signTransaction: owner,
    networkPassphrase: config.networkPassphrase,
    rpcUrl: config.rpcUrl,
  });
  const added = await addGrantRule({
    client: accountClient,
    owner,
    smartAccount: account,
    server,
    networkPassphrase: config.networkPassphrase,
    parameters: parseRuleParameters(grantPayload.ruleParams),
  });
  await jsonRequest(`${apiBase}/grants/${grantPayload.grantId}/confirm`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ txHash: added.transactionHash }),
  });
  record("add_and_confirm_onchain_grant", added.transactionHash, String(added.id));

  const metadata = await jsonRequest<Record<string, unknown>>(`${apiBase}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "StellaBox Phase 2 E2E",
      redirect_uris: ["http://127.0.0.1:8787/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const authorize = new URL("/authorize", apiBase);
  for (const [key, value] of Object.entries({
    client_id: String(metadata.client_id),
    response_type: "code",
    redirect_uri: "http://127.0.0.1:8787/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "stellabox",
    resource: `${apiBase}/mcp`,
  })) authorize.searchParams.set(key, value);
  const authorization = await fetch(authorize, { redirect: "manual" });
  const connectUrl = new URL(authorization.headers.get("location")!);
  const requestId = connectUrl.searchParams.get("requestId")!;
  const consent = await jsonRequest<{ redirectUrl: string }>(`${apiBase}/oauth/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ requestId, grantId: grantPayload.grantId }),
  });
  const code = new URL(consent.redirectUrl).searchParams.get("code")!;
  const oauthProvider = new PostgresOAuthProvider(db);
  const oauthClient = await oauthProvider.clientsStore.getClient(String(metadata.client_id));
  if (
    !oauthClient ||
    (await oauthProvider.challengeForAuthorizationCode(oauthClient, code)) !== challenge
  ) {
    throw new Error("OAuth E2E code challenge was not persisted for the registered client");
  }
  record("oauth_code_challenge_lookup", "matched");
  const tokenResponse = await jsonRequest<{ access_token: string }>(`${apiBase}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: String(metadata.client_id),
      code,
      redirect_uri: "http://127.0.0.1:8787/callback",
      code_verifier: verifier,
      resource: `${apiBase}/mcp`,
    }),
  });
  record("oauth_dcr_pkce_consent_token", "issued");

  const transport = new StreamableHTTPClientTransport(new URL(`${apiBase}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${tokenResponse.access_token}` } },
  });
  const mcp = new Client({ name: "stellabox-e2e", version: "1.0.0" });
  await mcp.connect(transport);
  for (const tool of ["get_balance", "list_grants"] as const) {
    record(tool, await mcp.callTool({ name: tool, arguments: {} }));
  }
  const paymentResult = await mcp.callTool({
    name: "send_payment",
    arguments: { to: config.merchantAddress, amount: "0.5", asset: "USDC" },
  });
  const paymentContent = (paymentResult as { structuredContent?: unknown }).structuredContent as {
    tx_hash?: unknown;
  } | undefined;
  if (getToolFailure(paymentResult) || typeof paymentContent?.tx_hash !== "string") {
    throw new Error(`0.5 USDC payment failed: ${JSON.stringify(paymentResult)}`);
  }
  record("send_payment_0_5_usdc", paymentResult);
  const paid = await mcp.callTool({
    name: "pay_x402",
    arguments: { url: `${paidBase}/search?q=Stella`, method: "GET", max_amount: "0.1" },
  });
  const paidFailure = getToolFailure(paid);
  if (paidFailure) {
    throw new Error(`x402 payment failed: ${JSON.stringify(paidFailure)}`);
  }
  const paidResponse = paid as { structuredContent?: unknown };
  const paidContent = paidResponse.structuredContent as {
    body?: unknown;
    tx_hash?: unknown;
  } | undefined;
  if (
    !paidContent ||
    !paidContent.body ||
    typeof paidContent.tx_hash !== "string" ||
    !paidContent.tx_hash
  ) {
    throw new Error(`x402 response omitted the paid body or transaction hash: ${JSON.stringify(paid)}`);
  }
  record("pay_x402_wikipedia", paid);
  const overCap = await mcp.callTool({
    name: "send_payment",
    arguments: { to: config.merchantAddress, amount: "1.5", asset: "USDC" },
  });
  const overFailure = getToolFailure(overCap);
  if (overFailure?.code !== "over_tx_cap") {
    throw new Error(`Over-cap payment did not return over_tx_cap: ${JSON.stringify(overCap)}`);
  }
  record("over_tx_cap_approval", overCap);
  const overResult = overCap as { content?: Array<{ type: string; text?: string }> };
  const overContent = overResult.content?.find((entry) => entry.type === "text");
  const overJson = overContent?.type === "text" ? JSON.parse(overContent.text ?? "") as { approval_id?: string } : {};
  if (!overJson.approval_id) {
    throw new Error(`Over-cap payment did not create an approval: ${JSON.stringify(overCap)}`);
  }
  const approvalResult = await mcp.callTool({
    name: "get_approval",
    arguments: { approval_id: overJson.approval_id },
  });
  record("get_approval", approvalResult);
  const approvalContent = (approvalResult as { structuredContent?: unknown }).structuredContent as {
    status?: unknown;
  } | undefined;
  if (approvalContent?.status !== "pending") {
    throw new Error(`Over-cap approval is not pending: ${JSON.stringify(approvalResult)}`);
  }

  const revokeParams = await jsonRequest<{ contextRuleId: number }>(
    `${apiBase}/grants/${grantPayload.grantId}/revoke-params`,
    { headers: { cookie } }
  );
  const removalHash = await removeGrantRule({
    client: accountClient,
    owner,
    smartAccount: account,
    server,
    networkPassphrase: config.networkPassphrase,
    contextRuleId: revokeParams.contextRuleId,
  });
  await jsonRequest(`${apiBase}/grants/${grantPayload.grantId}/revoke`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ txHash: removalHash }),
  });
  record("revoke_grant_onchain", removalHash);
  try {
    const revokedResult = await mcp.callTool({
      name: "get_balance",
      arguments: {},
    });
    if (getToolFailure(revokedResult)?.code !== "grant_revoked") {
      throw new Error(
        `Post-revocation MCP call did not return grant_revoked: ${JSON.stringify(revokedResult)}`
      );
    }
    record("post_revoke_mcp_call", revokedResult);
  } catch (error) {
    const detail = String(error);
    if (!detail.includes("grant_revoked")) throw error;
    record("post_revoke_mcp_call", "grant_revoked", detail);
  }
  await writeFile(evidencePath, `${JSON.stringify({
    network: "testnet",
    createdAt: new Date().toISOString(),
    account,
    owner: owner.publicKey(),
    grantId: grantPayload.grantId,
    transactions: { deployment: deployed.sendTransactionResponse?.hash, funding: funding.sacTransferHash, addRule: added.transactionHash, removeRule: removalHash },
    facilitator: {
      path: FACILITATOR_PATH,
      feeKey: facilitatorKey.publicKey(),
      maxTransactionFeeStroops: MAX_TRANSACTION_FEE_STROOPS,
      maxTransactionFeeXlm: "0.2",
      feeCeilingRationale:
        "Smart-account __check_auth runs the verifier and both spending policies, increasing Soroban resource fees.",
      eventValidation: FACILITATOR_EVENT_VALIDATION,
      publicTrial: PUBLIC_FACILITATOR_TRIAL,
    },
    steps,
  }, null, 2)}\n`);
  console.log(`E2E evidence written to ${evidencePath}`);
  await mcp.close();
  void apiServer;
  void paidServer;
}

main().catch(async (error) => {
  const safeError = String(error).replace(/\bS[A-Z2-7]{55}\b/g, "[redacted]");
  steps.push({ step: "fatal_error", result: safeError });
  await mkdir(resolve(root, "evidence"), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({
    network: "testnet",
    createdAt: new Date().toISOString(),
    facilitator: {
      path: FACILITATOR_PATH,
      maxTransactionFeeStroops: MAX_TRANSACTION_FEE_STROOPS,
      eventValidation: FACILITATOR_EVENT_VALIDATION,
      publicTrial: PUBLIC_FACILITATOR_TRIAL,
    },
    steps,
    fatalError: safeError,
  }, null, 2)}\n`);
  console.error(safeError);
  process.exitCode = 1;
});
