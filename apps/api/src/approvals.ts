import { Router, type RequestHandler } from "express";
import { and, desc, eq } from "drizzle-orm";
import webPush from "web-push";
import type { Database } from "@stellabox/db";
import {
  addPushSubscription,
  getApprovalForUser,
  getGrant,
  findPasskeyByCredentialId,
  logActivity,
  grants,
  approvals,
  sessions,
  pushSubscriptions,
  wallets,
} from "@stellabox/db";
import { loadApiConfig } from "./config.js";
import {
  assertTransactionSucceeded,
  buildUsdcTransferFunction,
  verifyUsdcTransfer,
} from "./chain.js";
import { verifyPasskeyAssertion } from "./auth.js";
import { executeX402Approval, prepareX402Approval } from "./x402-client.js";
import { serializeApproval } from "./api-json.js";

export async function notifyApproval(
  db: Database,
  grantId: string,
  approvalId: string
) {
  const grant = await getGrant(db, grantId);
  if (!grant) return;
  const [wallet] = await db
    .select()
    .from(wallets)
    .where(eq(wallets.id, grant.walletId))
    .limit(1);
  if (!wallet) return;
  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, wallet.userId));
  if (subscriptions.length === 0) return;
  const config = loadApiConfig();
  if (!config.vapidPublicKey || !config.vapidPrivateKey || !config.vapidSubject) {
    throw new Error("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT are required");
  }
  webPush.setVapidDetails(
    config.vapidSubject,
    config.vapidPublicKey,
    config.vapidPrivateKey
  );
  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
          },
          JSON.stringify({ type: "approval", approvalId, grantId })
        );
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.id, subscription.id));
          return;
        }
        throw error;
      }
    })
  );
}

export function createApprovalRouter(
  db: Database,
  requireSession: RequestHandler
) {
  const router = Router();

  router.get("/push/vapid-public-key", (_request, response) => {
    const publicKey = loadApiConfig().vapidPublicKey;
    if (!publicKey) {
      response.status(503).json({ error: "push_not_configured" });
      return;
    }
    response.json({ publicKey });
  });

  router.post("/push/subscribe", requireSession, async (request, response, next) => {
    try {
      const endpoint = String(request.body?.endpoint ?? "");
      const keys = request.body?.keys;
      if (
        !endpoint.startsWith("https://") ||
        typeof keys?.p256dh !== "string" ||
        typeof keys?.auth !== "string"
      ) {
        response.status(400).json({ error: "invalid_push_subscription" });
        return;
      }
      await addPushSubscription(db, {
        userId: response.locals.userId as string,
        endpoint,
        keys,
      });
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get("/approvals", requireSession, async (_request, response, next) => {
    try {
      const rows = await db
        .select({ approval: approvals })
        .from(approvals)
        .innerJoin(grants, eq(grants.id, approvals.grantId))
        .innerJoin(wallets, eq(wallets.id, grants.walletId))
        .where(eq(wallets.userId, response.locals.userId as string))
        .orderBy(desc(approvals.createdAt))
        .limit(100);
      response.json(rows.map(({ approval }) => serializeApproval(approval)));
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/approvals/:id",
    requireSession,
    async (request, response, next) => {
      try {
        const approval = await getApprovalForUser(
          db,
          String(request.params.id),
          response.locals.userId as string
        );
        if (!approval) {
          response.status(404).json({ error: "approval_not_found" });
          return;
        }
        response.json(serializeApproval(approval));
      } catch (error) {
        next(error);
      }
    }
  );

  router.get(
    "/approvals/:id/sign-params",
    requireSession,
    async (request, response, next) => {
      try {
        const approval = await getApprovalForUser(
          db,
          String(request.params.id),
          response.locals.userId as string
        );
        if (!approval) {
          response.status(404).json({ error: "approval_not_found" });
          return;
        }
        if (approval.status !== "pending" || approval.expiresAt.getTime() <= Date.now()) {
          if (approval.status === "pending") {
            await db
              .update(approvals)
              .set({ status: "expired" })
              .where(eq(approvals.id, approval.id));
          }
          response.status(410).json({ error: "approval_expired" });
          return;
        }
        const action = approval.actionJson as {
          kind?: string;
          to?: string;
          amountStroops?: string;
          asset?: string;
          func?: string;
          auth?: string[];
          url?: string;
          method?: string;
          body?: string | null;
        };
        if (
          action.kind === "x402" &&
          action.url &&
          action.amountStroops
        ) {
          const [wallet] = await db
            .select()
            .from(wallets)
            .innerJoin(grants, eq(wallets.id, grants.walletId))
            .where(eq(grants.id, approval.grantId))
            .limit(1);
          if (!wallet) {
            response.status(422).json({ error: "invalid_approval_action" });
            return;
          }
          response.json(
            await prepareX402Approval({
              url: action.url,
              method: action.method ?? "GET",
              ...(action.body ? { body: action.body } : {}),
              payer: wallet.wallets.contractAddress,
              expectedAmountStroops: BigInt(action.amountStroops),
            })
          );
          return;
        }
        if (action.kind === "send_payment") {
          const [wallet] = await db
            .select()
            .from(wallets)
            .innerJoin(grants, eq(wallets.id, grants.walletId))
            .where(eq(grants.id, approval.grantId))
            .limit(1);
          if (!wallet || !action.to || !action.amountStroops) {
            response.status(422).json({ error: "invalid_approval_action" });
            return;
          }
          response.json({
            kind: action.kind,
            func: buildUsdcTransferFunction(
              wallet.wallets.contractAddress,
              action.to,
              BigInt(action.amountStroops)
            ),
            auth: [],
          });
          return;
        }
        response.json({ kind: action.kind, func: action.func, auth: action.auth ?? [] });
      } catch (error) {
        next(error);
      }
    }
  );

  router.post(
    "/approvals/:id/decision",
    requireSession,
    async (request, response, next) => {
      try {
        const userId = response.locals.userId as string;
        const approval = await getApprovalForUser(db, String(request.params.id), userId);
        if (!approval || approval.status !== "pending") {
          response.status(404).json({ error: "pending_approval_not_found" });
          return;
        }
        if (approval.expiresAt.getTime() <= Date.now()) {
          await db
            .update(approvals)
            .set({ status: "expired" })
            .where(eq(approvals.id, approval.id));
          response.status(410).json({ error: "approval_expired" });
          return;
        }
        const sessionId = response.locals.sessionId as string;
        const [session] = await db
          .select()
          .from(sessions)
          .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
          .limit(1);
        const assertion = request.body?.assertion;
        const passkey = await findPasskeyByCredentialId(db, String(assertion?.id ?? ""));
        if (
          !session?.challenge ||
          !passkey ||
          passkey.userId !== userId ||
          !(await verifyPasskeyAssertion(db, passkey, assertion, session.challenge))
        ) {
          response.status(401).json({ error: "passkey_reauthentication_required" });
          return;
        }
        await db
          .update(sessions)
          .set({ challenge: null })
          .where(eq(sessions.id, session.id));

        const decision = request.body?.decision;
        if (decision === "reject") {
          await db
            .update(approvals)
            .set({ status: "rejected" })
            .where(eq(approvals.id, approval.id));
          await logActivity(db, {
            grantId: approval.grantId,
            tool: "approval_decision",
            argsJson: { approvalId: approval.id, decision },
            decision: "rejected",
          });
          response.json({ approvalId: approval.id, status: "rejected" });
          return;
        }
        if (decision !== "approve") {
          response.status(400).json({ error: "invalid_decision" });
          return;
        }
        const action = approval.actionJson as {
          kind?: string;
          to?: string;
          amountStroops?: string;
          url?: string;
          method?: string;
          body?: string | null;
        };
        if (action.kind === "x402" && action.url && action.amountStroops) {
          const [wallet] = await db
            .select()
            .from(wallets)
            .innerJoin(grants, eq(wallets.id, grants.walletId))
            .where(eq(grants.id, approval.grantId))
            .limit(1);
          if (!wallet) {
            response.status(422).json({ error: "invalid_approval_action" });
            return;
          }
          const paid = await executeX402Approval({
            url: action.url,
            method: action.method ?? "GET",
            ...(action.body ? { body: action.body } : {}),
            payer: wallet.wallets.contractAddress,
            expectedAmountStroops: BigInt(action.amountStroops),
            signedAuthEntries: Array.isArray(request.body?.authEntries)
              ? request.body.authEntries.filter(
                  (entry: unknown): entry is string => typeof entry === "string"
                )
              : [],
          });
          await db
            .update(approvals)
            .set({
              status: "executed",
              txHash: paid.txHash ?? null,
              resultBody: JSON.stringify(paid.resultBody),
            })
            .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")));
          await logActivity(db, {
            grantId: approval.grantId,
            tool: "approval_decision",
            argsJson: { approvalId: approval.id, decision, kind: "x402" },
            decision: "executed",
            ...(paid.txHash ? { txHash: paid.txHash } : {}),
            ...(approval.amount !== null ? { amount: approval.amount } : {}),
          });
          response.json({
            approvalId: approval.id,
            status: "executed",
            txHash: paid.txHash,
            resultBody: paid.resultBody,
          });
          return;
        }
        if (action.kind !== "send_payment" || !action.to || !action.amountStroops) {
          response.status(422).json({ error: "approval_action_not_supported" });
          return;
        }
        const txHash = String(request.body?.txHash ?? "");
        await assertTransactionSucceeded(txHash);
        if (
          !(await verifyUsdcTransfer(
            txHash,
            action.to,
            BigInt(action.amountStroops)
          ))
        ) {
          response.status(422).json({ error: "transfer_event_mismatch" });
          return;
        }
        await db
          .update(approvals)
          .set({ status: "executed", txHash })
          .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")));
        await logActivity(db, {
          grantId: approval.grantId,
          tool: "approval_decision",
          argsJson: { approvalId: approval.id, decision, kind: "send_payment" },
          decision: "executed",
          txHash,
          ...(approval.amount !== null ? { amount: approval.amount } : {}),
        });
        response.json({ approvalId: approval.id, status: "executed", txHash });
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
