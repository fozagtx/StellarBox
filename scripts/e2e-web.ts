import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import testnet from "../deployments/testnet.json";
import {
  assertTransactionSucceeded,
  getContextRule,
  getContextRuleCount,
} from "../apps/api/src/chain.js";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
process.loadEnvFile?.(resolve(root, ".env"));
const apiRequire = createRequire(resolve(root, "apps/api/package.json"));
const { Client } = apiRequire("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = apiRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const { fundUsdcWallet, loadStellarConfig } = await import(
  pathToFileURL(resolve(root, "packages/stellar/src/index.ts")).href
);

const cdpUrl = process.env.CHROME_CDP_URL ?? "http://localhost:29229";
const webUrl =
  process.env.PUBLIC_WEB_URL ??
  process.env.WEB_URL ??
  "http://localhost:3000";
const apiUrl =
  process.env.NEXT_PUBLIC_API_URL ??
  process.env.PUBLIC_API_URL ??
  "http://localhost:4000";
const evidencePath = resolve(root, "evidence/e2e-web-testnet.json");
const stellar = loadStellarConfig();
const grantName = "Styled E2E grant";
const clientName = "StellaBox Web E2E";

type RelayResponse = {
  status: number;
  success?: boolean;
  hash?: string;
};

type StepEvidence = {
  step: string;
  status: "passed" | "failed";
  [key: string]: unknown;
};

type McpResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

function record(
  steps: StepEvidence[],
  step: string,
  details: Record<string, unknown> = {}
) {
  steps.push({ step, status: "passed", ...details });
}

function toolPayload(result: McpResult): Record<string, unknown> {
  if (
    result.structuredContent &&
    typeof result.structuredContent === "object"
  ) {
    return result.structuredContent as Record<string, unknown>;
  }

  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (text) {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function toolFailure(
  result: McpResult
): { code?: string; reason: string } | undefined {
  if (!result.isError) return undefined;
  const payload = toolPayload(result);
  return {
    ...(typeof payload.code === "string" ? { code: payload.code } : {}),
    reason:
      typeof payload.reason === "string"
        ? payload.reason
        : JSON.stringify(payload),
  };
}

async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as
    | (T & { error?: string; message?: string })
    | Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `${new URL(url).pathname} returned HTTP ${response.status}: ${JSON.stringify(body)}`
    );
  }
  return body as T;
}

async function browserJson<T>(page: Page, path: string): Promise<T> {
  const value = await page.evaluate(
    async ({ baseUrl, requestPath }) => {
      const response = await fetch(`${baseUrl}${requestPath}`, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          `${requestPath} returned HTTP ${response.status}: ${JSON.stringify(body)}`
        );
      }
      return body;
    },
    { baseUrl: apiUrl, requestPath: path }
  );
  return value as T;
}

async function waitForApprovalStatus(
  page: Page,
  approvalId: string,
  expectedStatus: string
) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const approval = await browserJson<{
      status: string;
      txHash: string | null;
    }>(page, `/approvals/${encodeURIComponent(approvalId)}`);
    if (approval.status === expectedStatus) return approval;
    await page.waitForTimeout(1_000);
  }
  throw new Error(
    `Approval ${approvalId} did not reach ${expectedStatus} before timeout`
  );
}

async function saveEvidence(value: Record<string, unknown>) {
  await mkdir(resolve(root, "evidence"), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function run() {
  const startedAt = new Date().toISOString();
  const relayResponses: RelayResponse[] = [];
  const steps: StepEvidence[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    startedAt,
    networkPassphrase: testnet.networkPassphrase,
    webUrl,
    apiUrl,
    network: "testnet",
    steps,
  };
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP has no browser context");
  const existingPages = context.pages();
  const webOrigin = new URL(webUrl).origin;
  const page =
    existingPages.find((candidate) => {
      try {
        return new URL(candidate.url()).origin === webOrigin;
      } catch {
        return false;
      }
    }) ??
    existingPages.find((candidate) => candidate.url() === "about:blank") ??
    existingPages[0] ??
    (await context.newPage());
  const reusedExistingTab = existingPages.includes(page);
  page.setDefaultTimeout(120_000);
  const cdp = await context.newCDPSession(page);
  let authenticatorId: string | undefined;
  let mcp: Client | undefined;

  const relayBodyReads: Promise<void>[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/relay") return;
    relayBodyReads.push(
      (async () => {
        let body: Partial<RelayResponse> = {};
        try {
          body = (await response.json()) as Partial<RelayResponse>;
        } catch {
          body = {};
        }
        relayResponses.push({
          status: response.status(),
          ...(body.success === true ? { success: true } : {}),
          ...(typeof body.hash === "string" ? { hash: body.hash } : {}),
        });
      })()
    );
  });

  try {
    await context.clearCookies({ name: "stellabox_session" });
    await cdp.send("WebAuthn.enable");
    const authenticator = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    authenticatorId = authenticator.authenticatorId;

    await page.goto(`${webUrl}/onboarding`);
    await page.getByLabel("Your name").fill("StellaBox E2E owner");
    await Promise.all([
      page.waitForURL((url) => url.pathname === "/app", {
        timeout: 180_000,
      }),
      page
        .getByRole("button", {
          name: "Create wallet with passkey",
          exact: true,
        })
        .click(),
    ]);
    const session = await browserJson<{
      authenticated: boolean;
      walletId: string;
      contractId: string;
      credentialId: string;
    }>(page, "/auth/session");
    if (!session.authenticated) {
      throw new Error("Wallet creation did not establish an authenticated session");
    }
    const contractId = session.contractId;
    const onChainRuleCount = await getContextRuleCount(contractId);
    const ownerRule = await getContextRule(contractId, 0);
    const ownerSigners = ownerRule.get("signers");
    const ownerSignerCount =
      ownerSigners?.switch().name === "scvVec"
        ? (ownerSigners.vec() ?? []).length
        : 0;
    const createdCredentials = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    if (createdCredentials.credentials.length < 1) {
      throw new Error("The virtual authenticator did not retain the new passkey");
    }
    if (session.contractId !== contractId) {
      throw new Error("The browser session is not bound to the newly deployed wallet");
    }
    record(steps, "create_wallet_with_passkey", {
      contractId,
      walletId: session.walletId,
      registered: true,
      onChainContextRuleCount: onChainRuleCount,
      ownerRuleSignerCount: ownerSignerCount,
      virtualAuthenticatorCredentialCount: createdCredentials.credentials.length,
      sessionAuthenticated: session.authenticated,
      reusedExistingTab,
    });

    const funding = await fundUsdcWallet({
      smartAccount: contractId,
      minimumUsdc: "3",
      sendXlm: "100",
    });
    const walletAfterFunding = await browserJson<{
      balances: { usdcStroops: string; xlmStroops: string };
    }>(page, "/wallets/me");
    if (BigInt(walletAfterFunding.balances.usdcStroops) < 30_000_000n) {
      throw new Error("The wallet did not receive 3 testnet USDC");
    }
    record(steps, "fund_wallet_with_testnet_usdc", {
      amountUsdc: "3",
      source: funding.source,
      pathPaymentHash: funding.pathPaymentHash,
      sacTransferHash: funding.sacTransferHash,
      walletUsdcStroops: walletAfterFunding.balances.usdcStroops,
    });

    await page.goto(`${webUrl}/app/grants/new`);
    await page.getByLabel("Grant name").fill(grantName);
    await page.getByLabel("AI client").fill(clientName);
    await page.getByLabel("Daily cap (USDC)").fill("5");
    await page.getByLabel("Per-payment cap (USDC)").fill("1");
    await page.getByRole("button", { name: "7 days", exact: true }).click();
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.pathname.startsWith("/app/grants/") &&
          url.pathname !== "/app/grants/new",
        { timeout: 180_000 }
      ),
      page
        .getByRole("button", {
          name: "Create grant with passkey",
          exact: true,
        })
        .click(),
    ]);
    const grantId = decodeURIComponent(
      new URL(page.url()).pathname.split("/").at(-1) ?? ""
    );
    const liveGrant = await browserJson<{
      id: string;
      status: string;
      contextRuleId: number | null;
      dailyCap: string;
      txCap: string;
      expiresAt: string;
      budget?: {
        spendingLimit?: string;
        remaining?: string;
        txMax?: string;
        periodLedgers?: number;
      };
    }>(page, `/grants/${encodeURIComponent(grantId)}`);
    const budget = liveGrant.budget;
    const validityDays =
      (new Date(liveGrant.expiresAt).getTime() - Date.now()) /
      (24 * 60 * 60 * 1000);
    if (
      liveGrant.id !== grantId ||
      liveGrant.status !== "active" ||
      liveGrant.dailyCap !== "50000000" ||
      liveGrant.txCap !== "10000000" ||
      budget?.spendingLimit !== "50000000" ||
      budget.txMax !== "10000000" ||
      budget.periodLedgers !== 17_280 ||
      typeof budget.remaining !== "string" ||
      validityDays < 6.8 ||
      validityDays > 7.1
    ) {
      throw new Error("The active grant did not match the requested caps and expiry");
    }
    const grantRuleCount = await getContextRuleCount(contractId);
    record(steps, "create_grant_with_passkey", {
      grantId,
      status: liveGrant.status,
      contextRuleId: liveGrant.contextRuleId,
      dailyCapStroops: liveGrant.dailyCap,
      txCapStroops: liveGrant.txCap,
      validityDays: Number(validityDays.toFixed(3)),
      onChainContextRuleCount: grantRuleCount,
      liveBudget: budget,
    });

    const redirectUri = new URL("/app", webUrl).toString();
    const metadata = await jsonRequest<Record<string, unknown>>(
      `${apiUrl}/register`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: clientName,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      }
    );
    const clientId = String(metadata.client_id ?? "");
    if (!clientId) throw new Error("OAuth DCR did not return a client_id");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const state = randomBytes(16).toString("hex");
    const authorizeUrl = new URL("/authorize", apiUrl);
    for (const [key, value] of Object.entries({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "stellabox",
      resource: `${apiUrl}/mcp`,
    })) {
      authorizeUrl.searchParams.set(key, value);
    }
    const authorization = await fetch(authorizeUrl, { redirect: "manual" });
    const location = authorization.headers.get("location");
    if (authorization.status !== 302 || !location) {
      throw new Error(
        `OAuth authorize returned HTTP ${authorization.status} without a consent redirect`
      );
    }
    const connectUrl = new URL(location, apiUrl);
    const requestId = connectUrl.searchParams.get("requestId");
    const connectClientName = connectUrl.searchParams.get("clientName");
    if (
      connectUrl.pathname !== "/connect" ||
      !requestId ||
      connectClientName !== clientName
    ) {
      throw new Error("OAuth authorize did not redirect to the expected consent request");
    }
    await page.goto(connectUrl.toString());
    const grantChoices = page.getByRole("radio");
    await grantChoices.first().waitFor({ state: "visible" });
    if ((await grantChoices.count()) !== 1) {
      throw new Error("The OAuth consent page did not show exactly the new active grant");
    }
    await grantChoices.first().check();
    await Promise.all([
      page.waitForURL(
        (url) =>
          url.origin === new URL(webUrl).origin &&
          url.pathname === "/app" &&
          url.searchParams.has("code"),
        { timeout: 120_000 }
      ),
      page
        .getByRole("button", {
          name: `Allow ${clientName}`,
          exact: true,
        })
        .click(),
    ]);
    const callback = new URL(page.url());
    const code = callback.searchParams.get("code");
    if (!code || callback.searchParams.get("state") !== state) {
      throw new Error("OAuth consent redirect omitted the authorization code or state");
    }
    const tokenResponse = await jsonRequest<{
      access_token: string;
      token_type: string;
      expires_in: number;
      scope: string;
    }>(`${apiUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: `${apiUrl}/mcp`,
      }),
    });
    if (tokenResponse.token_type !== "Bearer" || !tokenResponse.access_token) {
      throw new Error("OAuth PKCE token exchange did not return a bearer token");
    }
    record(steps, "oauth_dcr_pkce_consent_token", {
      clientName,
      grantId,
      scope: tokenResponse.scope,
      accessTokenExpiresInSeconds: tokenResponse.expires_in,
      pkceMethod: "S256",
    });

    const transport = new StreamableHTTPClientTransport(
      new URL(`${apiUrl}/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${tokenResponse.access_token}` },
        },
      }
    );
    mcp = new Client({ name: "stellabox-web-e2e", version: "1.0.0" });
    await mcp.connect(transport);
    const balance = await mcp.callTool({
      name: "get_balance",
      arguments: {},
    });
    if (toolFailure(balance)) {
      throw new Error(`MCP get_balance failed: ${JSON.stringify(balance)}`);
    }
    record(steps, "mcp_get_balance", {
      response: toolPayload(balance),
    });
    const grantList = await mcp.callTool({
      name: "list_grants",
      arguments: {},
    });
    if (toolFailure(grantList)) {
      throw new Error(`MCP list_grants failed: ${JSON.stringify(grantList)}`);
    }
    record(steps, "mcp_list_grants", {
      response: toolPayload(grantList),
    });

    const paymentResult = (await mcp.callTool({
      name: "send_payment",
      arguments: {
        to: stellar.merchantAddress,
        amount: "0.5",
        asset: "USDC",
      },
    })) as McpResult;
    const paymentPayload = toolPayload(paymentResult);
    if (
      toolFailure(paymentResult) ||
      typeof paymentPayload.tx_hash !== "string" ||
      !paymentPayload.tx_hash
    ) {
      throw new Error(`0.5 USDC payment failed: ${JSON.stringify(paymentResult)}`);
    }
    await assertTransactionSucceeded(paymentPayload.tx_hash);
    record(steps, "mcp_send_payment_0_5_usdc", {
      recipient: stellar.merchantAddress,
      transactionHash: paymentPayload.tx_hash,
      response: paymentPayload,
    });

    const paidResult = (await mcp.callTool({
      name: "pay_x402",
      arguments: {
        url: "http://localhost:4100/search?q=Stella",
        method: "GET",
        max_amount: "0.1",
      },
    })) as McpResult;
    const paidFailure = toolFailure(paidResult);
    const paidPayload = toolPayload(paidResult);
    if (
      paidFailure ||
      typeof paidPayload.tx_hash !== "string" ||
      !paidPayload.tx_hash ||
      paidPayload.body === undefined ||
      paidPayload.body === null ||
      paidPayload.body === ""
    ) {
      throw new Error(
        `x402 payment did not return a transaction hash and real response body: ${JSON.stringify(paidResult)}`
      );
    }
    await assertTransactionSucceeded(paidPayload.tx_hash);
    record(steps, "mcp_pay_x402_search", {
      url: "http://localhost:4100/search?q=Stella",
      transactionHash: paidPayload.tx_hash,
      responseBody: paidPayload.body,
    });

    const firstOverCap = (await mcp.callTool({
      name: "send_payment",
      arguments: {
        to: stellar.merchantAddress,
        amount: "2",
        asset: "USDC",
      },
    })) as McpResult;
    const firstOverCapFailure = toolFailure(firstOverCap);
    const firstOverCapPayload = toolPayload(firstOverCap);
    const firstApprovalId =
      typeof firstOverCapPayload.approval_id === "string"
        ? firstOverCapPayload.approval_id
        : "";
    if (
      firstOverCapFailure?.code !== "over_tx_cap" ||
      !firstApprovalId
    ) {
      throw new Error(
        `2 USDC over-cap payment did not create an over_tx_cap approval: ${JSON.stringify(firstOverCap)}`
      );
    }
    const firstApprovalResult = (await mcp.callTool({
      name: "get_approval",
      arguments: { approval_id: firstApprovalId },
    })) as McpResult;
    const firstApprovalPayload = toolPayload(firstApprovalResult);
    if (
      toolFailure(firstApprovalResult) ||
      firstApprovalPayload.status !== "pending"
    ) {
      throw new Error(
        `The first over-cap approval was not pending: ${JSON.stringify(firstApprovalResult)}`
      );
    }
    record(steps, "mcp_over_tx_cap_pending_approval", {
      requestedAmount: "2",
      errorCode: firstOverCapFailure.code,
      approvalId: firstApprovalId,
      status: firstApprovalPayload.status,
    });

    await page.goto(
      `${webUrl}/app/approvals/${encodeURIComponent(firstApprovalId)}`
    );
    await page
      .getByRole("button", {
        name: "Approve with passkey",
        exact: true,
      })
      .click();
    await page.getByText("executed", { exact: true }).waitFor({
      timeout: 180_000,
    });
    const executedApproval = await waitForApprovalStatus(
      page,
      firstApprovalId,
      "executed"
    );
    if (!executedApproval.txHash) {
      throw new Error("The approved transfer did not record its transaction hash");
    }
    await assertTransactionSucceeded(executedApproval.txHash);
    record(steps, "browser_approve_with_passkey", {
      approvalId: firstApprovalId,
      status: executedApproval.status,
      transactionHash: executedApproval.txHash,
    });

    const secondOverCap = (await mcp.callTool({
      name: "send_payment",
      arguments: {
        to: stellar.merchantAddress,
        amount: "2",
        asset: "USDC",
      },
    })) as McpResult;
    const secondOverCapFailure = toolFailure(secondOverCap);
    const secondOverCapPayload = toolPayload(secondOverCap);
    const secondApprovalId =
      typeof secondOverCapPayload.approval_id === "string"
        ? secondOverCapPayload.approval_id
        : "";
    if (
      secondOverCapFailure?.code !== "over_tx_cap" ||
      !secondApprovalId
    ) {
      throw new Error(
        `The second over-cap payment did not create a pending approval: ${JSON.stringify(secondOverCap)}`
      );
    }
    const secondApprovalResult = (await mcp.callTool({
      name: "get_approval",
      arguments: { approval_id: secondApprovalId },
    })) as McpResult;
    const secondApprovalPayload = toolPayload(secondApprovalResult);
    if (
      toolFailure(secondApprovalResult) ||
      secondApprovalPayload.status !== "pending"
    ) {
      throw new Error(
        `The second over-cap approval was not pending: ${JSON.stringify(secondApprovalResult)}`
      );
    }
    record(steps, "mcp_second_over_tx_cap_pending_approval", {
      requestedAmount: "2",
      errorCode: secondOverCapFailure.code,
      approvalId: secondApprovalId,
      status: secondApprovalPayload.status,
      leftPending: true,
    });

    await page.goto(`${webUrl}/app`);
    await page
      .getByRole("heading", { name: "Needs your approval", exact: true })
      .waitFor();
    await page.getByRole("link", { name: /2(?:\.00)?\s?USDC/ }).waitFor();
    const finalSession = await browserJson<{
      authenticated: boolean;
      contractId: string;
    }>(page, "/auth/session");
    if (
      !finalSession.authenticated ||
      finalSession.contractId !== contractId
    ) {
      throw new Error("The final dashboard tab is not logged in to the new wallet");
    }
    const finalCredentials = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    if (!finalCredentials.credentials.length) {
      throw new Error("The virtual authenticator no longer has a passkey");
    }
    await Promise.all(relayBodyReads);
    const successfulRelays = relayResponses.filter(
      (response) => response.success && response.hash
    );
    if (successfulRelays.length < 2) {
      throw new Error("The browser kit did not relay wallet deployment and grant creation");
    }

    Object.assign(evidence, {
      status: "passed",
      completedAt: new Date().toISOString(),
      wallet: {
        contractId,
        walletId: session.walletId,
        deploymentTxHash: successfulRelays[0]?.hash,
        registered: true,
        onChainContextRuleCount: onChainRuleCount,
        ownerRuleSignerCount: ownerSignerCount,
        virtualAuthenticatorCredentialCount:
          createdCredentials.credentials.length,
        sessionAuthenticated: session.authenticated,
        funding: {
          amountUsdc: "3",
          source: funding.source,
          pathPaymentHash: funding.pathPaymentHash,
          sacTransferHash: funding.sacTransferHash,
          balanceAfterFundingStroops:
            walletAfterFunding.balances.usdcStroops,
        },
      },
      grant: {
        grantId,
        status: liveGrant.status,
        contextRuleId: liveGrant.contextRuleId,
        transactionHash: successfulRelays[1]?.hash,
        onChainContextRuleCount: grantRuleCount,
        liveBudget: budget,
        expiresAt: liveGrant.expiresAt,
      },
      oauth: {
        clientName,
        grantId,
        pkceMethod: "S256",
        consentUiUsed: true,
      },
      payments: {
        sendPayment: steps.find(
          (step) => step.step === "mcp_send_payment_0_5_usdc"
        ),
        payX402: steps.find((step) => step.step === "mcp_pay_x402_search"),
        approvedOverCap: steps.find(
          (step) => step.step === "browser_approve_with_passkey"
        ),
      },
      approvals: {
        executed: {
          id: firstApprovalId,
          status: executedApproval.status,
          txHash: executedApproval.txHash,
        },
        pending: {
          id: secondApprovalId,
          status: secondApprovalPayload.status,
        },
      },
      relayer: {
        responses: relayResponses,
        protocolSuccessResponses: relayResponses.filter(
          (response) => response.success
        ).length,
      },
      finalBrowser: {
        url: page.url(),
        sessionAuthenticated: finalSession.authenticated,
        virtualAuthenticatorCredentialCount: finalCredentials.credentials.length,
        authenticatorRemoved: false,
        pendingApprovalVisibleOnDashboard: true,
        tabReused: reusedExistingTab,
      },
    });
    await saveEvidence(evidence);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    evidence.status = "failed";
    evidence.completedAt = new Date().toISOString();
    evidence.error = (
      error instanceof Error ? error.message : String(error)
    ).replace(/\bS[A-Z2-7]{55}\b/g, "[redacted]");
    evidence.relayer = { responses: relayResponses };
    await saveEvidence(evidence);
    throw error;
  } finally {
    await mcp?.close().catch(() => undefined);
    await cdp.detach().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

await run();
