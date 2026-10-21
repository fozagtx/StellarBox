import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { Response } from "express";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { Address, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  agentKeys,
  approvals,
  createApproval,
  createGrant,
  createDatabase,
  grants,
  oauthClients,
  oauthTokens,
  rateLimits,
  sessions,
  users,
  wallets,
} from "@stellabox/db";
import { AgentKeyStore } from "@stellabox/signer";
import { loadStellarConfig } from "@stellabox/stellar";
import { InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import express from "express";
import { createApiApp } from "./app.js";
import { createSessionMiddleware } from "./auth.js";
import { createFaucetRouter, FAUCET_USDC } from "./faucet.js";
import { PostgresOAuthProvider } from "./oauth.js";
import { mapApiError } from "./api-errors.js";
import { decideSpend, approvalExpiresAt } from "./policy.js";
import { assertX402MaxAmount } from "./policy.js";
import { resolveGrantContext } from "./mcp.js";
import { serializeActivity, serializeApproval } from "./api-json.js";

process.env.DATABASE_URL ??=
  "postgres://stellabox:stellabox@127.0.0.1:5433/stellabox";
process.env.KEYSTORE_MASTER_KEY ??= randomBytes(32).toString("base64");
process.env.SESSION_SECRET ??= randomBytes(32).toString("base64url");

const database = createDatabase();
const { db } = database;
const signer = new AgentKeyStore(db);

let userId: string;
let walletId: string;
let activeGrantId: string;
let expiredGrantId: string;
let revokedGrantId: string;
const keyIds: string[] = [];
let oauthClientId: string;

async function makeGrant(input: {
  name: string;
  status: "active" | "revoked";
  expiresAt: Date;
}) {
  const key = await signer.create();
  keyIds.push(key.keyId);
  const grant = await createGrant(db, {
    walletId,
    name: input.name,
    agentPubkey: key.publicKey,
    kmsKeyRef: key.keyId,
    validUntilLedger: 9_999_999,
    dailyCap: 30_000_000n,
    txCap: 10_000_000n,
    assets: ["USDC"],
    expiresAt: input.expiresAt,
  });
  await db
    .update(grants)
    .set({ status: input.status })
    .where(eq(grants.id, grant.id));
  return grant.id;
}

function authFor(grantId: string): AuthInfo {
  return {
    token: "unit-test-token",
    clientId: "unit-test-client",
    scopes: ["stellabox"],
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    extra: { grantId },
  };
}

beforeAll(async () => {
  await db.execute(
    /* SQL */ (await import("drizzle-orm")).sql`SELECT 1`
  );
  const [user] = await db.insert(users).values({}).returning();
  userId = user!.id;
  const [wallet] = await db
    .insert(wallets)
    .values({ userId, contractAddress: `C${randomBytes(28).toString("hex")}` })
    .returning();
  walletId = wallet!.id;
  activeGrantId = await makeGrant({
    name: "API test active grant",
    status: "active",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  expiredGrantId = await makeGrant({
    name: "API test expired grant",
    status: "active",
    expiresAt: new Date(Date.now() - 1000),
  });
  revokedGrantId = await makeGrant({
    name: "API test revoked grant",
    status: "revoked",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  if (activeGrantId) {
    const grantIds = [activeGrantId, expiredGrantId, revokedGrantId];
    await db.delete(grants).where(inArray(grants.id, grantIds));
    if (oauthClientId) {
      await db.delete(oauthClients).where(eq(oauthClients.id, oauthClientId));
    }
    await db.delete(agentKeys).where(inArray(agentKeys.id, keyIds));
    await db
      .delete(rateLimits)
      .where(inArray(rateLimits.key, grantIds.map((id) => `mcp-grant:${id}`)));
    await db.delete(wallets).where(eq(wallets.id, walletId));
    await db.delete(users).where(eq(users.id, userId));
  }
  await database.pool.end();
});

describe("API error mapping and spend policy", () => {
  it("serializes database bigints in approval and activity responses", () => {
    expect(
      JSON.stringify(serializeApproval({ amount: 1_250_000n }))
    ).toBe('{"amount":"1250000"}');
    expect(
      JSON.stringify(serializeActivity({ id: 123n, amount: null }))
    ).toBe('{"id":"123","amount":null}');
  });

  it.each(["invalid_consent", "invalid_grant", "invalid_token"])(
    "maps %s to a client error",
    (message) => {
      expect(mapApiError(new Error(message))).toEqual({
        status: 400,
        body: { error: message },
      });
    }
  );

  it("hides unexpected error details", () => {
    expect(mapApiError(new Error("database password leaked"))).toEqual({
      status: 500,
      body: { error: "internal_error" },
    });
  });

  it("decides tx cap, daily cap, and asset allowlist outcomes", () => {
    const base = {
      asset: "USDC",
      allowedAssets: ["USDC"],
      payee: "Gmerchant",
      allowedPayees: [],
      amount: 1n,
      txCap: 10n,
      remaining: 10n,
    };
    expect(decideSpend({ ...base, amount: 11n })).toBe("over_tx_cap");
    expect(decideSpend({ ...base, amount: 10n, remaining: 9n })).toBe(
      "over_daily_cap"
    );
    expect(decideSpend({ ...base, asset: "XLM" })).toBe("asset_not_allowed");
    expect(decideSpend(base)).toBeUndefined();
  });

  it("rejects an x402 amount above max_amount before payment construction", () => {
    expect(() => assertX402MaxAmount(10_000_001n, 10_000_000n)).toThrow(
      "x402_amount_exceeds_max"
    );
    expect(() => assertX402MaxAmount(10_000_000n, 10_000_000n)).not.toThrow();
  });

  it("persists approvals with a 15-minute expiry", async () => {
    const now = new Date();
    const expiresAt = approvalExpiresAt(now);
    expect(expiresAt.getTime() - now.getTime()).toBe(15 * 60 * 1000);
    const approval = await createApproval(db, {
      grantId: activeGrantId,
      actionJson: { kind: "unit_test" },
      expiresAt,
    });
    const [persisted] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id))
      .limit(1);
    expect(persisted?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it("reads expired and revoked grant states from Postgres", async () => {
    expect((await resolveGrantContext(db, authFor(expiredGrantId))).error).toEqual({
      code: "grant_expired",
    });
    expect((await resolveGrantContext(db, authFor(revokedGrantId))).error).toEqual({
      code: "grant_revoked",
    });
  });
});

describe("Postgres OAuth provider", () => {
  it("enforces S256 PKCE and binds issued tokens to the consented grant", async () => {
    const provider = new PostgresOAuthProvider(db);
    const redirectUri = "http://127.0.0.1:8787/callback";
    const registerClient = provider.clientsStore.registerClient;
    if (!registerClient) throw new Error("OAuth client registration is unavailable");
    const client = await registerClient({
      client_name: "StellaBox API tests",
      redirect_uris: [redirectUri],
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    } as Parameters<NonNullable<typeof registerClient>>[0]);
    oauthClientId = client.client_id;

    const verifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    let connectUrl = "";
    const response = {
      redirect: (value: string) => {
        connectUrl = value;
      },
    } as unknown as Response;
    const params: AuthorizationParams = {
      redirectUri,
      codeChallenge,
      state: "api-test-state",
      scopes: ["stellabox"],
      resource: new URL("http://localhost:4000/mcp"),
    } as AuthorizationParams;
    await provider.authorize(client, params, response);
    const requestId = new URL(connectUrl).searchParams.get("requestId");
    expect(requestId).toBeTruthy();
    const redirectUrl = await provider.consent(requestId!, activeGrantId, userId);
    const callback = new URL(redirectUrl);
    const code = callback.searchParams.get("code");
    expect(callback.searchParams.get("state")).toBe("api-test-state");
    expect(code).toBeTruthy();

    await expect(
      provider.exchangeAuthorizationCode(
        client,
        code!,
        "wrong-pkce-verifier",
        redirectUri,
        new URL("http://localhost:4000/mcp")
      )
    ).rejects.toBeInstanceOf(InvalidGrantError);
    const tokens = await provider.exchangeAuthorizationCode(
      client,
      code!,
      verifier,
      redirectUri,
      new URL("http://localhost:4000/mcp")
    );
    expect(tokens.expires_in).toBe(15 * 60);
    const auth = await provider.verifyAccessToken(tokens.access_token);
    expect(auth.extra).toEqual({ grantId: activeGrantId, walletId });

    const tokenHash = createHash("sha256")
      .update(tokens.access_token)
      .digest("hex");
    const [stored] = await db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.hash, tokenHash), eq(oauthTokens.type, "access")))
      .limit(1);
    expect(stored?.grantId).toBe(activeGrantId);
    expect(stored?.grantId).not.toBe(expiredGrantId);
  });
});

describe("health and relay configuration", () => {
  it("returns public configuration booleans without requiring a session", async () => {
    const channelsConfigured = Boolean(process.env.CHANNELS_API_KEY);
    const vapidConfigured = Boolean(
      process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    );
    const server = createApiApp(db).listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("API test server did not bind to a TCP port");
      }
      const result = await fetch(
        `http://127.0.0.1:${address.port}/health`
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({
        ok: true,
        channelsConfigured,
        vapidConfigured,
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("reports an unconfigured relayer for wallet deployment", async () => {
    const originalChannelsApiKey = process.env.CHANNELS_API_KEY;
    const rateLimitKey = "wallet-deploy:127.0.0.1";
    delete process.env.CHANNELS_API_KEY;
    await db.delete(rateLimits).where(eq(rateLimits.key, rateLimitKey));
    try {
      const wasmHash = loadStellarConfig().accountWasmHash;
      const func = xdr.HostFunction.hostFunctionTypeCreateContractV2(
        new xdr.CreateContractArgsV2({
          executable: xdr.ContractExecutable.contractExecutableWasm(
            Buffer.from(wasmHash, "hex")
          ),
          contractIdPreimage:
            xdr.ContractIdPreimage.contractIdPreimageFromAddress(
              new xdr.ContractIdPreimageFromAddress({
                address: new Address(
                  StrKey.encodeEd25519PublicKey(randomBytes(32))
                ).toScAddress(),
                salt: Buffer.alloc(32),
              })
            ),
          constructorArgs: [],
        })
      ).toXDR("base64");
      const server = createApiApp(db).listen(0, "127.0.0.1");
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("API test server did not bind to a TCP port");
        }
        const result = await fetch(
          `http://127.0.0.1:${address.port}/relay`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ func, auth: [] }),
          }
        );
        expect(result.status).toBe(503);
        expect(await result.json()).toEqual({
          success: false,
          error: "relayer_not_configured",
          message:
            "Fee sponsoring is not configured: set CHANNELS_API_KEY on the stellabox-api service.",
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      if (originalChannelsApiKey === undefined) {
        delete process.env.CHANNELS_API_KEY;
      } else {
        process.env.CHANNELS_API_KEY = originalChannelsApiKey;
      }
      await db.delete(rateLimits).where(eq(rateLimits.key, rateLimitKey));
    }
  });
});

describe("relay ownership", () => {
  it("rejects a session relay request that does not involve its wallet", async () => {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const signature = createHmac("sha256", process.env.SESSION_SECRET!)
      .update(token)
      .digest("base64url");
    await db.insert(sessions).values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const contractBytes = Buffer.alloc(32, 31);
    const contractAddress = StrKey.encodeContract(contractBytes);
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: xdr.ScAddress.scAddressTypeContract(
          contractBytes as unknown as Parameters<
            typeof xdr.ScAddress.scAddressTypeContract
          >[0]
        ),
        functionName: "unrelated",
        args: [],
      })
    ).toXDR("base64");
    const server = createApiApp(db).listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("API test server did not bind to a TCP port");
      }
      const result = await fetch(`http://127.0.0.1:${address.port}/relay`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `stellabox_session=${encodeURIComponent(`${token}.${signature}`)}`,
        },
        body: JSON.stringify({ func, auth: [] }),
      });
      expect(result.status).toBe(403);
      expect(await result.json()).toEqual({ error: "relay_not_owner" });
      expect(contractAddress).not.toBe(
        (await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1))[0]
          ?.contractAddress
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    }
  });
});

describe("test USDC faucet", () => {
  it("funds the session wallet in the background and limits claims to one an hour", async () => {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const signature = createHmac("sha256", process.env.SESSION_SECRET!)
      .update(token)
      .digest("base64url");
    await db.insert(sessions).values({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const funded: Array<{ smartAccount: string; minimumUsdc?: string }> = [];
    const app = express();
    app.use(
      createFaucetRouter(db, createSessionMiddleware(db), async (input) => {
        funded.push(input);
        return { source: "G", pathPaymentHash: "p", sacTransferHash: "faucet-hash" };
      })
    );
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Faucet test server did not bind to a TCP port");
      }
      const url = `http://127.0.0.1:${address.port}/faucet`;
      const headers = {
        Cookie: `stellabox_session=${encodeURIComponent(`${token}.${signature}`)}`,
      };

      const first = await fetch(url, { method: "POST", headers });
      expect(first.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await (await fetch(url, { headers })).json()).toEqual({
        status: "done",
        hash: "faucet-hash",
      });
      const [wallet] = await db.select().from(wallets).where(eq(wallets.id, walletId)).limit(1);
      expect(funded).toEqual([
        { smartAccount: wallet!.contractAddress, minimumUsdc: FAUCET_USDC },
      ]);

      const second = await fetch(url, { method: "POST", headers });
      expect(second.status).toBe(429);
      expect(funded).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
      await db.delete(rateLimits).where(eq(rateLimits.key, `faucet:${userId}`));
    }
  });
});

describe("OAuth client registration over HTTP", () => {
  it("keeps the requested auth method and returns invalid_grant for a bad code", async () => {
    const server = createApiApp(db).listen(0, "127.0.0.1");
    let clientId: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("API test server did not bind to a TCP port");
      }
      const base = `http://127.0.0.1:${address.port}`;
      const redirectUri = "https://claude.ai/api/mcp/auth_callback";

      const secretClient = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Secret client",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "client_secret_post",
        }),
      }).then((result) => result.json() as Promise<Record<string, string>>);
      clientId = secretClient.client_id;
      expect(secretClient.token_endpoint_auth_method).toBe("client_secret_post");
      expect(secretClient.client_secret).toBeTruthy();

      const badCode = await fetch(`${base}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: secretClient.client_id!,
          client_secret: secretClient.client_secret!,
          code: "not-a-real-code",
          code_verifier: randomBytes(32).toString("base64url"),
          redirect_uri: redirectUri,
        }),
      });
      expect(badCode.status).toBe(400);
      expect((await badCode.json()).error).toBe("invalid_grant");

      const publicClient = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Public client",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
        }),
      }).then((result) => result.json() as Promise<Record<string, string>>);
      await db.delete(oauthClients).where(eq(oauthClients.id, publicClient.client_id!));
      expect(publicClient.token_endpoint_auth_method).toBe("none");
      expect(publicClient.client_secret).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (clientId) await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
    }
  });
});
