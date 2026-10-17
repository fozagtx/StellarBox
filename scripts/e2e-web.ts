import { writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright-core";
import testnet from "../deployments/testnet.json";
import { getContextRule, getContextRuleCount } from "../apps/api/src/chain.js";

const cdpUrl = process.env.CHROME_CDP_URL ?? "http://localhost:29229";
const webUrl = process.env.WEB_URL ?? "http://localhost:3000";
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const evidencePath = new URL("../evidence/e2e-web-testnet.json", import.meta.url);

type RelayResponse = {
  status: number;
  success?: boolean;
  hash?: string;
};

function parsePreformattedJson(
  texts: string[],
  predicate: (value: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  for (const text of texts) {
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      if (predicate(value)) return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function waitForJson(
  page: Page,
  predicate: (value: Record<string, unknown>) => boolean,
  description: string
) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const texts = await page.locator("pre").allTextContents();
    const value = parsePreformattedJson(texts, predicate);
    if (value) return value;
    const failure = parsePreformattedJson(
      texts,
      (candidate) => typeof candidate.error === "string"
    );
    if (failure) {
      throw new Error(
        `${description} failed: ${JSON.stringify(failure)}`
      );
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function saveEvidence(value: Record<string, unknown>) {
  await writeFile(evidencePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function run() {
  const startedAt = new Date().toISOString();
  const relayResponses: RelayResponse[] = [];
  const evidence: Record<string, unknown> = {
    status: "running",
    startedAt,
    networkPassphrase: testnet.networkPassphrase,
    webUrl,
    apiUrl,
  };
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  if (!context) throw new Error("Chrome CDP has no browser context");
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  const cdp = await context.newCDPSession(page);
  let authenticatorId: string | undefined;

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
    await page.getByLabel("Wallet name").fill("Phase 3a browser wallet");
    await page.getByRole("button", { name: "Create wallet" }).click();
    const wallet = await waitForJson(
      page,
      (value) =>
        typeof value.contractId === "string" &&
        typeof value.walletId === "string",
      "wallet registration"
    );
    const contractId = String(wallet.contractId);
    const onChainRuleCount = await getContextRuleCount(contractId);
    const ownerRule = await getContextRule(contractId, 0);
    const ownerSigners = ownerRule.get("signers");
    const ownerSignerCount =
      ownerSigners?.switch().name === "scvVec"
        ? (ownerSigners.vec() ?? []).length
        : 0;
    const credentials = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    if (credentials.credentials.length !== 1) {
      throw new Error("The virtual authenticator did not retain one passkey");
    }

    await page.getByRole("button", { name: "Sign in with saved passkey" }).click();
    await page.waitForFunction(
      () => document.body.innerText.includes("Session: true"),
      undefined,
      { timeout: 120_000 }
    );
    const session = (await page.evaluate(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/auth/session`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`Session lookup failed: ${response.status}`);
      return response.json();
    }, apiUrl)) as {
      authenticated: boolean;
      contractId: string;
    };
    if (!session.authenticated || session.contractId !== contractId) {
      throw new Error("The browser session is not bound to the deployed wallet");
    }

    await page.goto(`${webUrl}/app/grants/new`);
    await page.getByLabel("Name").fill("Phase 3a browser grant");
    await page.getByLabel("Client").fill("Phase 3a browser check");
    await page.getByLabel("Daily USDC cap").fill("3");
    await page.getByLabel("Per-transaction USDC cap").fill("1");
    await page.getByRole("button", { name: "Create and activate grant" }).click();
    const confirmedGrant = await waitForJson(
      page,
      (value) => value.status === "active" && typeof value.grantId === "string",
      "active grant confirmation"
    );
    const grantId = String(confirmedGrant.grantId);

    await page.goto(`${webUrl}/app/grants/${encodeURIComponent(grantId)}`);
    const liveGrant = await waitForJson(
      page,
      (value) => value.id === grantId && typeof value.budget === "object",
      "live grant budget"
    );
    const budget = liveGrant.budget as {
      spendingLimit?: string;
      remaining?: string;
      txMax?: string;
      periodLedgers?: number;
    };
    if (
      liveGrant.status !== "active" ||
      budget.spendingLimit !== "30000000" ||
      budget.txMax !== "10000000" ||
      budget.periodLedgers !== 17_280 ||
      typeof budget.remaining !== "string"
    ) {
      throw new Error("The on-chain grant budget did not match the requested caps");
    }
    const grantRuleCount = await getContextRuleCount(contractId);
    await Promise.all(relayBodyReads);
    const grantRelayResponse = [...relayResponses]
      .reverse()
      .find((response) => response.success && response.hash);
    const deployment = wallet.deployment as { hash?: string } | undefined;
    const deploymentTxHash =
      deployment?.hash ??
      relayResponses.find((response) => response.success && response.hash)?.hash;
    if (!deploymentTxHash || !grantRelayResponse?.hash) {
      throw new Error("The relayer did not return both deployment and grant hashes");
    }

    Object.assign(evidence, {
      status: "passed",
      completedAt: new Date().toISOString(),
      wallet: {
        contractId,
        walletId: wallet.walletId,
        deploymentTxHash,
        registered: true,
        onChainContextRuleCount: onChainRuleCount,
        ownerRuleSignerCount: ownerSignerCount,
        virtualAuthenticatorCredentialCount: credentials.credentials.length,
        sessionAuthenticated: session.authenticated,
      },
      grant: {
        grantId,
        status: liveGrant.status,
        contextRuleId: liveGrant.contextRuleId,
        transactionHash: grantRelayResponse.hash,
        onChainContextRuleCount: grantRuleCount,
        liveBudget: budget,
      },
      relayer: {
        responses: relayResponses,
        protocolSuccessResponses: relayResponses.filter(
          (response) => response.success
        ).length,
      },
    });
    await saveEvidence(evidence);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    evidence.status = "failed";
    evidence.completedAt = new Date().toISOString();
    evidence.error = error instanceof Error ? error.message : String(error);
    evidence.relayer = { responses: relayResponses };
    await saveEvidence(evidence);
    throw error;
  } finally {
    if (authenticatorId) {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId,
      }).catch(() => undefined);
    }
    await cdp.detach().catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}

await run();
