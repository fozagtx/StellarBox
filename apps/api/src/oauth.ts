import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  mcpAuthRouter,
  mcpAuthMetadataRouter,
  createOAuthMetadata,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Database } from "@stellabox/db";
import {
  oauthClients,
  oauthAuthorizationRequests,
  oauthCodes,
  oauthTokens,
} from "@stellabox/db";
import { getGrantForUser, getGrant } from "@stellabox/db";
import { loadApiConfig } from "./config.js";

const ACCESS_TOKEN_SECONDS = 15 * 60;
const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

class PostgresOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly apiUrl: string;
  private readonly webUrl: string;
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    const config = loadApiConfig();
    this.apiUrl = config.apiUrl;
    this.webUrl = config.webUrl;
    this.clientsStore = {
      getClient: async (clientId) => {
        const [client] = await db
          .select()
          .from(oauthClients)
          .where(eq(oauthClients.id, clientId))
          .limit(1);
        return client?.metadata as OAuthClientInformationFull | undefined;
      },
      registerClient: async (metadata) => {
        const clientId = randomBytes(24).toString("base64url");
        const client = {
          ...metadata,
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          token_endpoint_auth_method: "none",
        } as OAuthClientInformationFull;
        await db.insert(oauthClients).values({
          id: clientId,
          name: String(metadata.client_name ?? clientId),
          redirectUris: metadata.redirect_uris,
          metadata: client as unknown as Record<string, unknown>,
        });
        return client;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: import("express").Response
  ) {
    const requestId = randomBytes(24).toString("base64url");
    await this.db.insert(oauthAuthorizationRequests).values({
      requestId,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      state: params.state ?? null,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      scopes: params.scopes?.length ? params.scopes : ["stellabox"],
      resource: params.resource?.toString() ?? null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const connect = new URL("/connect", this.webUrl);
    connect.searchParams.set("requestId", requestId);
    connect.searchParams.set("clientName", String(client.client_name ?? "MCP client"));
    response.redirect(connect.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string
  ) {
    const [stored] = await this.db
      .select()
      .from(oauthCodes)
      .where(
        and(
          eq(oauthCodes.codeHash, digest(code)),
          eq(oauthCodes.clientId, client.client_id),
          isNull(oauthCodes.consumedAt),
          gt(oauthCodes.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!stored) throw new Error("invalid_grant");
    return stored.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const codeHash = digest(code);
    const [stored] = await this.db
      .select()
      .from(oauthCodes)
      .where(
        and(
          eq(oauthCodes.codeHash, codeHash),
          eq(oauthCodes.clientId, client.client_id),
          isNull(oauthCodes.consumedAt),
          gt(oauthCodes.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!stored || !codeVerifier || stored.redirectUri !== redirectUri) {
      throw new Error("invalid_grant");
    }
    const verifierHash = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    if (!constantTimeEqual(verifierHash, stored.codeChallenge)) {
      throw new Error("invalid_grant");
    }
    const [consumed] = await this.db
      .update(oauthCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthCodes.id, stored.id), isNull(oauthCodes.consumedAt)))
      .returning();
    if (!consumed) throw new Error("invalid_grant");
    return this.issueTokenPair(
      stored.grantId,
      client.client_id,
      stored.scopes,
      resource?.toString() ?? stored.resource ?? undefined
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL
  ): Promise<OAuthTokens> {
    const [stored] = await this.db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.hash, digest(refreshToken)),
          eq(oauthTokens.type, "refresh"),
          eq(oauthTokens.clientId, client.client_id),
          isNull(oauthTokens.revokedAt),
          gt(oauthTokens.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!stored) throw new Error("invalid_grant");
    const [rotated] = await this.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthTokens.id, stored.id), isNull(oauthTokens.revokedAt)))
      .returning({ id: oauthTokens.id });
    if (!rotated) throw new Error("invalid_grant");
    return this.issueTokenPair(
      stored.grantId,
      client.client_id,
      scopes ?? stored.scopes,
      resource?.toString() ?? stored.resource ?? undefined,
      stored.familyId
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [stored] = await this.db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.hash, digest(token)),
          eq(oauthTokens.type, "access"),
          isNull(oauthTokens.revokedAt),
          gt(oauthTokens.expiresAt, new Date())
        )
      )
      .limit(1);
    if (!stored) throw new Error("invalid_token");
    const grant = await getGrant(this.db, stored.grantId);
    if (!grant || grant.status !== "active" || grant.expiresAt <= new Date()) {
      throw new Error("grant_revoked");
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: Math.floor(stored.expiresAt.getTime() / 1000),
      ...(stored.resource ? { resource: new URL(stored.resource) } : {}),
      extra: { grantId: grant.id, walletId: grant.walletId },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest
  ) {
    await this.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(oauthTokens.hash, digest(request.token)),
          isNull(oauthTokens.revokedAt)
        )
      );
  }

  async consent(requestId: string, grantId: string, userId: string) {
    const [pending] = await this.db
      .select()
      .from(oauthAuthorizationRequests)
      .where(
        and(
          eq(oauthAuthorizationRequests.requestId, requestId),
          isNull(oauthAuthorizationRequests.consumedAt),
          gt(oauthAuthorizationRequests.expiresAt, new Date())
        )
      )
      .limit(1);
    const grant = await getGrantForUser(this.db, grantId, userId);
    if (!pending || !grant || grant.status !== "active" || grant.expiresAt <= new Date()) {
      throw new Error("invalid_consent");
    }
    const code = randomBytes(32).toString("base64url");
    const now = new Date();
    await this.db.transaction(async (transaction) => {
      const [consumed] = await transaction
        .update(oauthAuthorizationRequests)
        .set({ userId, grantId, consumedAt: now })
        .where(
          and(
            eq(oauthAuthorizationRequests.id, pending.id),
            isNull(oauthAuthorizationRequests.consumedAt)
          )
        )
        .returning();
      if (!consumed) throw new Error("invalid_consent");
      await transaction.insert(oauthCodes).values({
        codeHash: digest(code),
        clientId: pending.clientId,
        grantId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        codeChallengeMethod: pending.codeChallengeMethod,
        scopes: pending.scopes,
        resource: pending.resource,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      });
    });
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", code);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    return redirect.toString();
  }

  private async issueTokenPair(
    grantId: string,
    clientId: string,
    scopes: string[],
    resource?: string,
    existingFamilyId?: string
  ): Promise<OAuthTokens> {
    const grant = await getGrant(this.db, grantId);
    if (!grant || grant.status !== "active" || grant.expiresAt <= new Date()) {
      throw new Error("invalid_grant");
    }
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(48).toString("base64url");
    const familyId = existingFamilyId ?? randomUUID();
    const now = Date.now();
    await this.db.insert(oauthTokens).values([
      {
        grantId,
        clientId,
        hash: digest(accessToken),
        type: "access",
        familyId,
        scopes,
        resource: resource ?? null,
        expiresAt: new Date(now + ACCESS_TOKEN_SECONDS * 1000),
      },
      {
        grantId,
        clientId,
        hash: digest(refreshToken),
        type: "refresh",
        familyId,
        scopes,
        resource: resource ?? null,
        expiresAt: new Date(now + REFRESH_TOKEN_SECONDS * 1000),
      },
    ]);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

export function createOAuthRouter(db: Database, requireSession: RequestHandler) {
  const config = loadApiConfig();
  const provider = new PostgresOAuthProvider(db);
  const issuerUrl = new URL(config.apiUrl);
  const resourceServerUrl = new URL("/mcp", config.apiUrl);
  const oauthMetadata = createOAuthMetadata({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    scopesSupported: ["stellabox"],
  });
  const router = Router();
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      baseUrl: issuerUrl,
      resourceServerUrl,
      scopesSupported: ["stellabox"],
      resourceName: "StellaBox MCP",
    })
  );
  router.use(
    mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl,
      scopesSupported: ["stellabox"],
      resourceName: "StellaBox MCP",
    })
  );
  router.post("/oauth/consent", requireSession, async (request, response, next) => {
    try {
      const redirectUrl = await provider.consent(
        String(request.body?.requestId ?? ""),
        String(request.body?.grantId ?? ""),
        response.locals.userId as string
      );
      response.json({ redirectUrl });
    } catch (error) {
      next(error);
    }
  });
  return { router, provider };
}
