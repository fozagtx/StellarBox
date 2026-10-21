import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "@stellabox/db";
import {
  createSession,
  findWalletForUser,
  findPasskeyByCredentialId,
  sessions,
  passkeys,
} from "@stellabox/db";
import { loadApiConfig } from "./config.js";

const SESSION_COOKIE = "stellabox_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRATION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function encodeCoseP256(publicKey: Buffer): Buffer {
  if (publicKey.length !== 65 || publicKey[0] !== 4) {
    throw new Error("WebAuthn public key must be a 65-byte uncompressed P-256 key");
  }
  const byteString = (value: Buffer) =>
    Buffer.concat([Buffer.from([0x58, value.length]), value]);
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21]),
    byteString(publicKey.subarray(1, 33)),
    Buffer.from([0x22]),
    byteString(publicKey.subarray(33)),
  ]);
}

function signedCookie(token: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64url");
  return `${token}.${signature}`;
}

function setSessionCookie(response: Response, token: string): void {
  const config = loadApiConfig();
  const secure = new URL(config.webUrl).protocol === "https:";
  response.cookie(SESSION_COOKIE, signedCookie(token, config.sessionSecret), {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    path: "/",
    maxAge: SESSION_DURATION_MS,
  });
}

export async function startSession(
  db: Database,
  response: Response,
  userId: string
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await createSession(db, {
    userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_DURATION_MS),
  });
  setSessionCookie(response, token);
}

function registrationChallengeTag(nonceAndExpiry: Buffer, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update("stellabox-registration")
    .update(nonceAndExpiry)
    .digest()
    .subarray(0, 16);
}

export function issueRegistrationChallenge(
  secret = loadApiConfig().sessionSecret,
  now = Date.now()
): string {
  const expiry = Buffer.alloc(8);
  expiry.writeBigUInt64BE(BigInt(now + REGISTRATION_CHALLENGE_TTL_MS));
  const nonceAndExpiry = Buffer.concat([randomBytes(16), expiry]);
  return Buffer.concat([
    nonceAndExpiry,
    registrationChallengeTag(nonceAndExpiry, secret),
  ]).toString("base64url");
}

export function registrationChallengeIsValid(
  challenge: string,
  secret: string,
  now = Date.now()
): boolean {
  const bytes = Buffer.from(challenge, "base64url");
  if (bytes.length !== 40 || bytes.toString("base64url") !== challenge) {
    return false;
  }
  const nonceAndExpiry = bytes.subarray(0, 24);
  const expected = registrationChallengeTag(nonceAndExpiry, secret);
  if (!timingSafeEqual(bytes.subarray(24), expected)) return false;
  return Number(nonceAndExpiry.readBigUInt64BE(16)) > now;
}

async function consumeRegistrationChallenge(
  db: Database,
  challenge: string
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO rate_limits (key, window_started_at, count, expires_at)
    VALUES (
      ${`registration-challenge:${challenge}`},
      now(),
      1,
      now() + interval '5 minutes'
    )
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `);
  return result.rows.length === 1;
}

/**
 * Checks the WebAuthn registration response produced while creating the
 * wallet's passkey. A valid response proves the caller holds the new passkey,
 * so registration can open a session without a second passkey prompt.
 */
export async function verifyWalletRegistration(
  db: Database,
  registration: unknown,
  credentialId: string,
  publicKey: Buffer
): Promise<boolean> {
  const config = loadApiConfig();
  const response = registration as Parameters<
    typeof verifyRegistrationResponse
  >[0]["response"];
  if (response?.id !== credentialId) return false;
  let challenge: string | undefined;
  try {
    challenge = (
      JSON.parse(
        Buffer.from(response.response.clientDataJSON, "base64url").toString("utf8")
      ) as { challenge?: string }
    ).challenge;
  } catch {
    return false;
  }
  if (!challenge || !registrationChallengeIsValid(challenge, config.sessionSecret)) {
    return false;
  }
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: config.webUrl,
      expectedRPID: new URL(config.webUrl).hostname,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7],
    });
  } catch {
    return false;
  }
  if (!verified.verified) return false;
  const key = decodeCredentialPublicKey(
    verified.registrationInfo.credential.publicKey
  ) as cose.COSEPublicKeyEC2;
  const x = key.get(cose.COSEKEYS.x);
  const y = key.get(cose.COSEKEYS.y);
  if (
    !x ||
    !y ||
    !Buffer.concat([Buffer.from([4]), x, y]).equals(publicKey)
  ) {
    return false;
  }
  return consumeRegistrationChallenge(db, challenge);
}

function readCookie(request: Request): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [name, ...value] = item.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

export function createSessionMiddleware(
  db: Database,
  secret = loadApiConfig().sessionSecret
): RequestHandler {
  return async (request, response, next) => {
    const cookie = readCookie(request);
    const separator = cookie?.lastIndexOf(".");
    if (!cookie || separator === undefined || separator < 1) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const token = cookie.slice(0, separator);
    const provided = Buffer.from(cookie.slice(separator + 1), "base64url");
    const expected = createHmac("sha256", secret).update(token).digest();
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    if (!session) {
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    response.locals.userId = session.userId;
    response.locals.sessionId = session.id;
    next();
  };
}

export async function verifyPasskeyAssertion(
  db: Database,
  passkey: typeof passkeys.$inferSelect,
  assertion: unknown,
  challenge: string
): Promise<boolean> {
  const config = loadApiConfig();
  const verified = await verifyAuthenticationResponse({
    response: assertion as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
    expectedChallenge: challenge,
    expectedOrigin: config.webUrl,
    expectedRPID: new URL(config.webUrl).hostname,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(
        encodeCoseP256(Buffer.from(passkey.publicKey, "base64url"))
      ),
      counter: passkey.signCount,
    },
  });
  if (!verified.verified) return false;
  await db
    .update(passkeys)
    .set({ signCount: verified.authenticationInfo.newCounter })
    .where(eq(passkeys.id, passkey.id));
  return true;
}

export function createAuthRouter(
  db: Database,
  requireSession: RequestHandler
) {
  const router = Router();
  const config = loadApiConfig();
  const rpID = new URL(config.webUrl).hostname;

  router.get("/auth/session", requireSession, async (_request, response, next) => {
    try {
      const userId = response.locals.userId as string;
      const wallet = await findWalletForUser(db, userId);
      const [passkey] = await db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, userId))
        .limit(1);
      if (!wallet || !passkey) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      response.json({
        authenticated: true,
        userId,
        walletId: wallet.id,
        contractId: wallet.contractAddress,
        credentialId: passkey.credentialId,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/register/options", (_request, response) => {
    response.json({ challenge: issueRegistrationChallenge(config.sessionSecret) });
  });

  router.post("/auth/options", async (request, response, next) => {
    try {
      const credentialId = String(request.body?.credentialId ?? "");
      const passkey = await findPasskeyByCredentialId(db, credentialId);
      if (!passkey) {
        response.status(404).json({ error: "credential_not_found" });
        return;
      }
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [{ id: credentialId }],
        userVerification: "required",
      });
      const placeholder = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await createSession(db, {
        userId: passkey.userId,
        tokenHash: hashToken(placeholder),
        challenge: options.challenge,
        expiresAt,
      });
      response.json(options);
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/verify", async (request, response, next) => {
    try {
      const assertion = request.body;
      const credentialId = String(assertion?.id ?? "");
      const passkey = await findPasskeyByCredentialId(db, credentialId);
      if (!passkey) {
        response.status(401).json({ error: "invalid_assertion" });
        return;
      }
      const clientData = JSON.parse(
        Buffer.from(assertion.response.clientDataJSON, "base64url").toString("utf8")
      ) as { challenge?: string };
      const [session] = await db
        .select()
        .from(sessions)
        .where(
          and(
            eq(sessions.userId, passkey.userId),
            eq(sessions.challenge, clientData.challenge ?? ""),
            gt(sessions.expiresAt, new Date())
          )
        )
        .limit(1);
      if (!session?.challenge) {
        response.status(401).json({ error: "invalid_assertion" });
        return;
      }
      if (
        !(await verifyPasskeyAssertion(
          db,
          passkey,
          assertion,
          session.challenge
        ))
      ) {
        response.status(401).json({ error: "invalid_assertion" });
        return;
      }
      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      await db.transaction(async (transaction) => {
        await transaction
          .update(sessions)
          .set({ tokenHash, challenge: null, expiresAt })
          .where(eq(sessions.id, session.id));
      });
      setSessionCookie(response, token);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/auth/reauth/options", requireSession, async (_request, response, next) => {
    try {
      const userId = response.locals.userId as string;
      const sessionId = response.locals.sessionId as string;
      const walletCredential = await db
        .select()
        .from(passkeys)
        .where(eq(passkeys.userId, userId))
        .limit(1);
      const credential = walletCredential[0];
      if (!credential) {
        response.status(404).json({ error: "credential_not_found" });
        return;
      }
      const options = await generateAuthenticationOptions({
        rpID,
        allowCredentials: [{ id: credential.credentialId }],
        userVerification: "required",
      });
      await db
        .update(sessions)
        .set({ challenge: options.challenge })
        .where(eq(sessions.id, sessionId));
      response.json(options);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
