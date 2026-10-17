import { eq } from "drizzle-orm";
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { z } from "zod/v4";
import type { RequestHandler } from "express";
import { sql } from "drizzle-orm";
import type { Database } from "@stellabox/db";
import {
  createApproval,
  getApprovalForGrant,
  getGrant,
  listActivityForGrant,
  logActivity,
  approvals,
  wallets,
} from "@stellabox/db";
import { AgentKeyStore } from "@stellabox/signer";
import {
  createChannelsClient,
  loadStellarConfig,
  prepareAgentCall,
  readBudget,
  submitSorobanTransaction,
} from "@stellabox/stellar";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { getLiveBalances } from "./chain.js";
import { notifyApproval } from "./approvals.js";
import { loadApiConfig } from "./config.js";
import { payX402, X402LimitError } from "./x402-client.js";
import {
  approvalExpiresAt,
  grantAvailabilityError,
  spendLimitError,
  spendTargetError,
} from "./policy.js";

const STROOPS_PER_USDC = 10_000_000n;

function content(value: Record<string, unknown>, isError = false) {
  const serialized = JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item
  );
  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: JSON.parse(serialized) as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

function parseAmount(value: string): bigint {
  const match = /^([0-9]{1,30})(?:\.([0-9]{1,7}))?$/.exec(value);
  if (!match) throw new RangeError("Invalid USDC amount");
  return (
    BigInt(match[1]!) * STROOPS_PER_USDC +
    BigInt((match[2] ?? "").padEnd(7, "0") || "0")
  );
}

async function consumeGrantRateLimit(db: Database, grantId: string) {
  const key = `mcp-grant:${grantId}`;
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
  return Number(result.rows[0]?.count ?? 0) <= 120;
}

type GrantContext = {
  auth: AuthInfo;
  grantId: string;
  grant: NonNullable<Awaited<ReturnType<typeof getGrant>>>;
  wallet: { id: string; contractAddress: string; userId: string };
};

export async function resolveGrantContext(
  db: Database,
  auth: AuthInfo | undefined
): Promise<{ context?: GrantContext; error?: Record<string, unknown> }> {
  const grantId = String(auth?.extra?.grantId ?? "");
  if (!auth || !grantId) return { error: { code: "grant_revoked" } };
  if (!(await consumeGrantRateLimit(db, grantId))) {
    return { error: { code: "rate_limited", retry_after_seconds: 60 } };
  }
  const grant = await getGrant(db, grantId);
  if (!grant) return { error: { code: "grant_revoked" } };
  const grantError = grantAvailabilityError(grant);
  if (grantError) return { error: { code: grantError } };
  const [wallet] = await db
    .select({
      id: wallets.id,
      contractAddress: wallets.contractAddress,
      userId: wallets.userId,
    })
    .from(wallets)
    .where(eq(wallets.id, grant.walletId))
    .limit(1);
  if (!wallet) return { error: { code: "grant_revoked" } };
  return { context: { auth, grantId, grant, wallet } };
}

async function logTool(
  db: Database,
  grantId: string | undefined,
  tool: string,
  args: Record<string, unknown>,
  decision: string,
  fields: { amount?: bigint; txHash?: string; error?: string } = {}
) {
  await logActivity(db, {
    grantId,
    tool,
    argsJson: args,
    decision,
    ...fields,
  });
}

async function budgetFor(context: GrantContext) {
  if (context.grant.contextRuleId === null) throw new Error("Grant has no active rule");
  return readBudget({
    smartAccount: context.wallet.contractAddress,
    contextRuleId: context.grant.contextRuleId,
  });
}

function createMcpServer(db: Database, signer: AgentKeyStore) {
  const server = new McpServer({ name: "stellabox", version: "0.1.0" });

  server.registerTool("get_balance", { description: "Get the wallet's live USDC and XLM balances and grant budget." }, async (extra) => {
    const { context, error } = await resolveGrantContext(db, extra.authInfo);
    if (error) return content(error, true);
    try {
      const [balances, budget] = await Promise.all([
        getLiveBalances(context!.wallet.contractAddress),
        budgetFor(context!),
      ]);
      const value = {
        balances,
        remaining_budget_stroops: budget.remaining.toString(),
        tx_cap_stroops: budget.txMax.toString(),
      };
      await logTool(db, context!.grantId, "get_balance", {}, "allowed");
      return content(value);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      await logTool(db, context!.grantId, "get_balance", {}, "error", { error: reason });
      return content({ code: "chain_error", reason }, true);
    }
  });

  server.registerTool("list_grants", { description: "Get the grant bound to this OAuth token." }, async (extra) => {
    const { context, error } = await resolveGrantContext(db, extra.authInfo);
    if (error) return content(error, true);
    const value = {
      grants: [{
        grantId: context!.grant.id,
        name: context!.grant.name,
        client: context!.grant.clientId,
        daily_cap_stroops: context!.grant.dailyCap.toString(),
        tx_cap_stroops: context!.grant.txCap.toString(),
        assets: context!.grant.assets,
        expires_at: context!.grant.expiresAt.toISOString(),
      }],
    };
    await logTool(db, context!.grantId, "list_grants", {}, "allowed");
    return content(value);
  });

  server.registerTool(
    "send_payment",
    {
      description: "Send USDC from the smart account within this grant's on-chain limits.",
      inputSchema: {
        to: z.string().min(1),
        amount: z.string().min(1),
        asset: z.string().default("USDC"),
        memo: z.string().max(28).optional(),
      },
    },
    async (args, extra) => {
      const { context, error } = await resolveGrantContext(db, extra.authInfo);
      if (error) return content(error, true);
      let amount: bigint;
      try {
        amount = parseAmount(args.amount);
      } catch {
        return content({ code: "chain_error", reason: "invalid_amount" }, true);
      }
      const grant = context!.grant;
      const targetError = spendTargetError({
        asset: args.asset,
        allowedAssets: grant.assets,
        payee: args.to,
        allowedPayees: grant.payees,
      });
      if (targetError) {
        await logTool(db, grant.id, "send_payment", args, "rejected", { amount, error: targetError });
        return content({ code: targetError }, true);
      }
      try {
        const budget = await budgetFor(context!);
        const spendDecision = spendLimitError(
          amount,
          budget.txMax < grant.txCap ? budget.txMax : grant.txCap,
          budget.remaining
        );
        if (spendDecision === "over_tx_cap" || spendDecision === "over_daily_cap") {
          const approval = await createApproval(db, {
            grantId: grant.id,
            actionJson: {
              kind: "send_payment",
              to: args.to,
              amountStroops: amount.toString(),
              asset: args.asset,
              memo: args.memo ?? null,
              reason: spendDecision,
            },
            amount,
            expiresAt: approvalExpiresAt(),
          });
          await notifyApproval(db, grant.id, approval.id);
          await logTool(db, grant.id, "send_payment", args, "approval_required", { amount });
          return content({ code: spendDecision, approval_id: approval.id }, true);
        }
        const balances = await getLiveBalances(context!.wallet.contractAddress);
        if (BigInt(balances.usdcStroops) < amount) {
          await logTool(db, grant.id, "send_payment", args, "rejected", { amount, error: "insufficient_funds" });
          return content({ code: "insufficient_funds" }, true);
        }
        if (grant.contextRuleId === null) throw new Error("Grant has no active context rule");
        const config = loadStellarConfig();
        const prepared = await prepareAgentCall({
          sourcePublicKey: config.readSourceAccount,
          targetContract: config.usdcSac,
          targetFunction: "transfer",
          targetArgs: [
            Address.fromString(context!.wallet.contractAddress).toScVal(),
            Address.fromString(args.to).toScVal(),
            nativeToScVal(amount, { type: "i128" }),
          ],
          contextRuleId: grant.contextRuleId,
          agentPublicKey: Buffer.from(grant.agentPubkey, "base64url"),
          signAgentDigest: (digest) => signer.sign(grant.kmsKeyRef, digest),
        });
        if (prepared.simulationError) throw new Error(prepared.simulationError);
        const submitted = await submitSorobanTransaction(
          { func: prepared.func, auth: prepared.auth },
          createChannelsClient()
        );
        if (!submitted.hash) throw new Error(submitted.status ?? "Channels returned no transaction hash");
        const remaining = await budgetFor(context!);
        await logTool(db, grant.id, "send_payment", args, "executed", { amount, txHash: submitted.hash });
        return content({
          tx_hash: submitted.hash,
          remaining_budget_stroops: remaining.remaining.toString(),
          status: submitted.status,
        });
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        await logTool(db, grant.id, "send_payment", args, "error", { amount, error: reason });
        return content({ code: "chain_error", reason }, true);
      }
    }
  );

  server.registerTool(
    "request_approval",
    {
      description: "Ask the wallet owner to approve an action.",
      inputSchema: { action: z.string().min(1), reason: z.string().min(1) },
    },
    async (args, extra) => {
      const { context, error } = await resolveGrantContext(db, extra.authInfo);
      if (error) return content(error, true);
      const approval = await createApproval(db, {
        grantId: context!.grantId,
        actionJson: { kind: "explicit", action: args.action, reason: args.reason },
        expiresAt: approvalExpiresAt(),
      });
      await notifyApproval(db, context!.grantId, approval.id);
      await logTool(db, context!.grantId, "request_approval", args, "pending");
      return content({ approval_id: approval.id, status: approval.status });
    }
  );

  server.registerTool(
    "get_approval",
    {
      description: "Check the status of an owner approval.",
      inputSchema: { approval_id: z.string().uuid() },
    },
    async (args, extra) => {
      const { context, error } = await resolveGrantContext(db, extra.authInfo);
      if (error) return content(error, true);
      const approval = await getApprovalForGrant(db, args.approval_id, context!.grantId);
      if (!approval) return content({ code: "approval_not_found" }, true);
      if (approval.status === "pending" && approval.expiresAt.getTime() <= Date.now()) {
        await db.update(approvals)
          .set({ status: "expired" })
          .where(eq(approvals.id, approval.id));
        approval.status = "expired";
      }
      await logTool(db, context!.grantId, "get_approval", args, approval.status);
      return content({
        approval_id: approval.id,
        status: approval.status,
        tx_hash: approval.txHash,
        result_body: approval.resultBody,
      });
    }
  );

  server.registerTool(
    "get_activity",
    {
      description: "List recent actions for this grant.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
    },
    async (args, extra) => {
      const { context, error } = await resolveGrantContext(db, extra.authInfo);
      if (error) return content(error, true);
      const entries = await listActivityForGrant(db, context!.grantId, args.limit);
      await logTool(db, context!.grantId, "get_activity", args, "allowed");
      return content({ activity: entries });
    }
  );

  server.registerTool(
    "pay_x402",
    {
      description: "Pay a Stellar testnet USDC x402 endpoint within this grant's limits.",
      inputSchema: {
        url: z.string().url(),
        method: z.string().default("GET"),
        body: z.string().optional(),
        max_amount: z.string().min(1),
      },
    },
    async (args, extra) => {
      const { context, error } = await resolveGrantContext(db, extra.authInfo);
      if (error) return content(error, true);
      if (!context!.grant.assets.includes("USDC")) {
        await logTool(db, context!.grantId, "pay_x402", args, "rejected", { error: "asset_not_allowed" });
        return content({ code: "asset_not_allowed" }, true);
      }
      let maxAmountStroops: bigint;
      try {
        maxAmountStroops = parseAmount(args.max_amount);
      } catch {
        return content({ code: "chain_error", reason: "invalid_max_amount" }, true);
      }
      try {
        const budget = await budgetFor(context!);
        const paid = await payX402({
          url: args.url,
          method: args.method,
          ...(args.body ? { body: args.body } : {}),
          maxAmountStroops,
          txCapStroops: budget.txMax < context!.grant.txCap ? budget.txMax : context!.grant.txCap,
          remainingBudgetStroops: budget.remaining,
          payer: context!.wallet.contractAddress,
          agentPublicKey: Buffer.from(context!.grant.agentPubkey, "base64url"),
          contextRuleId: context!.grant.contextRuleId!,
          kmsKeyRef: context!.grant.kmsKeyRef,
          signer,
        });
        const responseBody = (() => {
          try {
            return JSON.parse(paid.body) as unknown;
          } catch {
            return paid.body;
          }
        })();
        await logTool(db, context!.grantId, "pay_x402", args, "executed", {
          ...(paid.txHash ? { txHash: paid.txHash } : {}),
        });
        const remaining = await budgetFor(context!);
        return content({
          body: responseBody,
          tx_hash: paid.txHash,
          status: paid.status,
          remaining_budget_stroops: remaining.remaining.toString(),
        });
      } catch (cause) {
        if (cause instanceof X402LimitError) {
          const approval = await createApproval(db, {
            grantId: context!.grantId,
            actionJson: {
              kind: "x402",
              url: args.url,
              method: args.method,
              body: args.body ?? null,
              amountStroops: cause.amountStroops.toString(),
              reason: cause.code,
            },
            amount: cause.amountStroops,
            expiresAt: approvalExpiresAt(),
          });
          await notifyApproval(db, context!.grantId, approval.id);
          await logTool(db, context!.grantId, "pay_x402", args, "approval_required", {
            amount: cause.amountStroops,
          });
          return content({ code: cause.code, approval_id: approval.id }, true);
        }
        const reason = cause instanceof Error ? cause.message : String(cause);
        await logTool(db, context!.grantId, "pay_x402", args, "error", { error: reason });
        return content({ code: "chain_error", reason }, true);
      }
    }
  );

  return server;
}

export function createMcpRouter(
  db: Database,
  verifier: OAuthTokenVerifier,
  signer: AgentKeyStore
): RequestHandler {
  const config = loadApiConfig();
  const bearer = requireBearerAuth({
    verifier,
    requiredScopes: ["stellabox"],
    resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", config.apiUrl).toString(),
    expectedResource: new URL("/mcp", config.apiUrl),
  });
  return (request, response, next) => {
    if (request.path !== "/mcp" || request.method !== "POST") {
      next();
      return;
    }
    bearer(request, response, (error) => {
      if (error) {
        next(error);
        return;
      }
      void (async () => {
        const server = createMcpServer(db, signer);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      })().catch(next);
    });
  };
}
