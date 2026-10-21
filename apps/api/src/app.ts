import cors from "cors";
import express, { type RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { xdr } from "@stellar/stellar-sdk";
import {
  findWalletForUser,
  listActivityForUser,
  registerWallet,
  type Database,
} from "@stellabox/db";
import { AgentKeyStore } from "@stellabox/signer";
import {
  createChannelsClient,
  loadStellarConfig,
  submitSorobanTransaction,
  submitXdrTransaction,
} from "@stellabox/stellar";
import {
  createAuthRouter,
  createSessionMiddleware,
  startSession,
  verifyWalletRegistration,
} from "./auth.js";
import { getLiveBalances, verifyRegisteredPasskey } from "./chain.js";
import { loadApiConfig } from "./config.js";
import { createGrantRouter } from "./grants.js";
import { createApprovalRouter } from "./approvals.js";
import { createOAuthRouter } from "./oauth.js";
import { createMcpRouter } from "./mcp.js";
import { mapApiError } from "./api-errors.js";
import { relaySubmissionBelongsToWallet } from "./relay-authorization.js";
import { serializeActivity } from "./api-json.js";

function isWalletDeploy(func: string): boolean {
  try {
    const hostFunction = xdr.HostFunction.fromXDR(func, "base64");
    if (hostFunction.switch().name !== "hostFunctionTypeCreateContractV2") {
      return false;
    }
    const executable = hostFunction.createContractV2().executable();
    return (
      executable.switch().name === "contractExecutableWasm" &&
      Buffer.from(executable.wasmHash()).toString("hex") ===
        loadStellarConfig().accountWasmHash
    );
  } catch {
    return false;
  }
}

const RELAY_NOT_CONFIGURED_MESSAGE =
  "Fee sponsoring is not configured: set CHANNELS_API_KEY on the stellabox-api service.";
const MAX_RELAY_ERROR_LENGTH = 300;

function sanitizeRelayErrorText(value: string): string {
  const apiKey = process.env.CHANNELS_API_KEY;
  const redactedApiKey = apiKey ? value.replaceAll(apiKey, "[redacted]") : value;
  return redactedApiKey.replace(/\bS[A-Z2-7]{55}\b/g, "[redacted]");
}

function relayErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeRelayErrorText(message).slice(0, MAX_RELAY_ERROR_LENGTH);
}

class RelaySubmissionFailure extends Error {
  constructor(error: unknown) {
    super(relayErrorMessage(error));
    this.name = "RelaySubmissionFailure";
    if (error instanceof Error && error.stack) {
      this.stack = sanitizeRelayErrorText(error.stack);
    }
  }
}

async function consumeDeployRateLimit(db: Database, ip: string): Promise<boolean> {
  const key = `wallet-deploy:${ip}`;
  const result = await db.execute(sql`
    INSERT INTO rate_limits (key, window_started_at, count, expires_at)
    VALUES (${key}, now(), 1, now() + interval '1 minute')
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.expires_at <= now() THEN 1
        ELSE rate_limits.count + 1
      END,
      window_started_at = CASE
        WHEN rate_limits.expires_at <= now() THEN now()
        ELSE rate_limits.window_started_at
      END,
      expires_at = CASE
        WHEN rate_limits.expires_at <= now() THEN now() + interval '1 minute'
        ELSE rate_limits.expires_at
      END
    RETURNING count
  `);
  return Number(result.rows[0]?.count ?? 0) <= 5;
}

export function createApiApp(db: Database) {
  const config = loadApiConfig();
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.webUrl, credentials: true }));
  app.use(express.json({ limit: "256kb" }));
  const requireSession = createSessionMiddleware(db);
  app.use(createAuthRouter(db, requireSession));

  const signer = new AgentKeyStore(db);
  app.use(createGrantRouter(db, signer, requireSession));
  app.use(createApprovalRouter(db, requireSession));
  const oauth = createOAuthRouter(db, requireSession);
  app.use(oauth.router);
  app.use(createMcpRouter(db, oauth.provider, signer));

  const classifyRelay: RequestHandler = (request, response, next) => {
    const func = request.body?.func;
    const auth = request.body?.auth;
    const transactionXdr = request.body?.xdr;
    const functionRequest =
      typeof func === "string" &&
      Array.isArray(auth) &&
      auth.every((entry) => typeof entry === "string");
    const xdrRequest = typeof transactionXdr === "string";
    if (
      functionRequest === xdrRequest ||
      (xdrRequest && Object.keys(request.body ?? {}).length !== 1)
    ) {
      response.status(400).json({ error: "invalid_relay_request" });
      return;
    }
    if (functionRequest && isWalletDeploy(func)) {
      response.locals.walletDeploy = true;
      next();
      return;
    }
    response.locals.relayXdr = xdrRequest;
    requireSession(request, response, next);
  };
  app.post("/relay", classifyRelay, async (request, response, next) => {
    try {
      const walletDeploy = response.locals.walletDeploy === true;
      const transactionXdr = request.body.xdr as string | undefined;
      if (walletDeploy) {
        const ip = request.ip ?? request.socket.remoteAddress ?? "unknown";
        if (!(await consumeDeployRateLimit(db, ip))) {
          response.status(429).json({ error: "deployment_rate_limited" });
          return;
        }
      } else {
        const userId = response.locals.userId as string;
        const wallet = await findWalletForUser(db, userId);
        const submission = transactionXdr
          ? { xdr: transactionXdr }
          : {
              func: request.body.func as string,
              auth: request.body.auth as string[],
            };
        if (
          !wallet ||
          !relaySubmissionBelongsToWallet(submission, wallet.contractAddress)
        ) {
          response.status(403).json({ error: "relay_not_owner" });
          return;
        }
      }
      if (!process.env.CHANNELS_API_KEY) {
        response.status(503).json({
          success: false,
          error: "relayer_not_configured",
          message: RELAY_NOT_CONFIGURED_MESSAGE,
        });
        return;
      }
      try {
        const channels = createChannelsClient();
        const transaction = transactionXdr
          ? await submitXdrTransaction({ xdr: transactionXdr }, channels)
          : await submitSorobanTransaction(
              {
                func: request.body.func,
                auth: request.body.auth,
              },
              channels
            );
        response.json({
          success: true,
          hash: transaction.hash,
          transactionId: transaction.transactionId,
          status: transaction.status,
        });
      } catch (error) {
        next(new RelaySubmissionFailure(error));
      }
    } catch (error) {
      next(error);
    }
  });

  app.post("/wallets/register", (async (request, response, next) => {
    try {
      const contractAddress = String(request.body?.contractId ?? "");
      const credentialId = String(request.body?.credentialId ?? "");
      const publicKey = String(request.body?.publicKey ?? "");
      const credentialBytes = Buffer.from(credentialId, "base64url");
      const publicKeyBytes = Buffer.from(publicKey, "base64url");
      if (
        !contractAddress.startsWith("C") ||
        publicKeyBytes.length !== 65 ||
        publicKeyBytes[0] !== 4 ||
        credentialBytes.length === 0 ||
        credentialBytes.length > 1024
      ) {
        response.status(400).json({ error: "invalid_registration" });
        return;
      }
      if (
        Buffer.from(publicKeyBytes).toString("base64url") !== publicKey ||
        Buffer.from(credentialBytes).toString("base64url") !== credentialId
      ) {
        response.status(400).json({ error: "invalid_registration" });
        return;
      }
      if (
        !(await verifyRegisteredPasskey(
          contractAddress,
          publicKeyBytes,
          credentialBytes
        ))
      ) {
        response.status(422).json({ error: "passkey_not_found_on_chain" });
        return;
      }
      const registration = request.body?.registration;
      const proven =
        registration !== undefined &&
        (await verifyWalletRegistration(
          db,
          registration,
          credentialId,
          publicKeyBytes
        ));
      const registered = await registerWallet(db, {
        contractAddress,
        credentialId,
        publicKey,
      });
      if (proven) await startSession(db, response, registered.user.id);
      response.status(201).json({
        signedIn: proven,
        userId: registered.user.id,
        walletId: registered.wallet.id,
        contractId: registered.wallet.contractAddress,
      });
    } catch (error) {
      next(error);
    }
  }) as RequestHandler);

  app.get("/wallets/me", requireSession, async (_request, response, next) => {
    try {
      const wallet = await findWalletForUser(db, response.locals.userId as string);
      if (!wallet) {
        response.status(404).json({ error: "wallet_not_found" });
        return;
      }
      response.json({
        walletId: wallet.id,
        contractId: wallet.contractAddress,
        depositAddress: wallet.contractAddress,
        balances: await getLiveBalances(wallet.contractAddress),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/activity", requireSession, async (_request, response, next) => {
    try {
      const entries = await listActivityForUser(
        db,
        response.locals.userId as string
      );
      response.json(entries.map(({ entry }) => serializeActivity(entry)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", async (_request, response, next) => {
    try {
      await db.execute(sql`SELECT 1`);
      response.json({
        ok: true,
        channelsConfigured: Boolean(process.env.CHANNELS_API_KEY),
        vapidConfigured: Boolean(
          config.vapidPublicKey && config.vapidPrivateKey
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, request: express.Request, response: express.Response, next: express.NextFunction) => {
    void next;
    const errorStack =
      error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`${request.method} ${request.path}`, errorStack);
    const mapped = mapApiError(error);
    if (error instanceof RelaySubmissionFailure) {
      response.status(502).json({
        success: false,
        error: "relay_failed",
        message: error.message,
      });
      return;
    }
    response.status(mapped.status).json(
      request.path === "/relay"
        ? { success: false, ...mapped.body }
        : mapped.body
    );
  });

  return app;
}
