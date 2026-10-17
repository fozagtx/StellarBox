import { Router, type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { rpc } from "@stellar/stellar-sdk";
import type { Database } from "@stellabox/db";
import {
  getGrantForUser,
  listGrantsForUser,
  createGrant,
  activateGrant,
  revokeGrant,
  findWalletForUser,
  logActivity,
  oauthTokens,
  type Grant,
} from "@stellabox/db";
import { AgentKeyStore } from "@stellabox/signer";
import { buildGrantRuleParameters, loadStellarConfig, readBudget } from "@stellabox/stellar";
import {
  assertTransactionSucceeded,
  contextRuleIsMissing,
  findAgentContextRule,
} from "./chain.js";

const STROOPS_PER_USDC = 10_000_000n;

function decimalToStroops(value: unknown): bigint {
  const text = String(value ?? "");
  const match = /^([0-9]{1,30})(?:\.([0-9]{1,7}))?$/.exec(text);
  if (!match) throw new RangeError("Cap must be a non-negative USDC amount with up to 7 decimals");
  const whole = BigInt(match[1]!);
  const fraction = BigInt((match[2] ?? "").padEnd(7, "0") || "0");
  return whole * STROOPS_PER_USDC + fraction;
}

function grantWithBudget(grant: Grant, budget?: Awaited<ReturnType<typeof readBudget>>) {
  return {
    ...grant,
    dailyCap: grant.dailyCap.toString(),
    txCap: grant.txCap.toString(),
    ...(budget
      ? {
          budget: {
            spendingLimit: budget.spendingLimit.toString(),
            spentInWindow: budget.spentInWindow.toString(),
            remaining: budget.remaining.toString(),
            txMax: budget.txMax.toString(),
            periodLedgers: budget.periodLedgers,
          },
        }
      : {}),
  };
}

export function createGrantRouter(
  db: Database,
  signer: AgentKeyStore,
  requireSession: RequestHandler
) {
  const router = Router();
  const config = loadStellarConfig();

  router.post("/grants", requireSession, async (request, response, next) => {
    let keyId: string | undefined;
    try {
      const wallet = await findWalletForUser(db, response.locals.userId as string);
      if (!wallet) {
        response.status(404).json({ error: "wallet_not_found" });
        return;
      }
      const name = String(request.body?.name ?? "").trim();
      const clientId = String(request.body?.client ?? "").trim();
      const assets = request.body?.assets;
      const expiresAt = new Date(String(request.body?.expiresAt ?? ""));
      if (
        !name ||
        name.length > 80 ||
        !clientId ||
        !Array.isArray(assets) ||
        assets.length !== 1 ||
        assets[0] !== "USDC" ||
        !Number.isFinite(expiresAt.getTime()) ||
        expiresAt.getTime() <= Date.now() + 60_000 ||
        expiresAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000
      ) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      const dailyCap = decimalToStroops(request.body?.dailyCap);
      const txCap = decimalToStroops(request.body?.txCap);
      if (dailyCap <= 0n || txCap <= 0n || txCap > dailyCap) {
        response.status(400).json({ error: "invalid_grant_caps" });
        return;
      }
      const server = new rpc.Server(config.rpcUrl);
      const [ledger, key] = await Promise.all([
        server.getLatestLedger(),
        signer.create(),
      ]);
      keyId = key.keyId;
      const validUntilLedger =
        ledger.sequence + Math.ceil((expiresAt.getTime() - Date.now()) / 5_000);
      const ruleParams = buildGrantRuleParameters({
        usdcAddress: config.usdcSac,
        spendingLimitPolicy: config.spendingLimitPolicy,
        txMaxPolicy: config.txMaxPolicy,
        ed25519Verifier: config.ed25519Verifier,
        agentPublicKey: Buffer.from(key.publicKey, "base64url"),
        dailyCapStroops: dailyCap,
        txMaxStroops: txCap,
        validUntilLedger,
        name: "Agent spending",
      });
      const grant = await createGrant(db, {
        walletId: wallet.id,
        name,
        clientId,
        agentPubkey: key.publicKey,
        kmsKeyRef: key.keyId,
        validUntilLedger,
        dailyCap,
        txCap,
        assets,
        expiresAt,
      });
      keyId = undefined;
      await logActivity(db, {
        grantId: grant.id,
        tool: "create_grant",
        argsJson: { name, client: clientId, dailyCap: dailyCap.toString(), txCap: txCap.toString() },
        decision: "pending",
      });
      response.status(201).json({
        grantId: grant.id,
        agentPublicKey: key.publicKey,
        ruleParams: {
          context_type: ruleParams.context_type,
          name: ruleParams.name,
          valid_until: ruleParams.valid_until,
          signers: ruleParams.signers.map((entry) => ({
            tag: entry.tag,
            values: [entry.values[0], Buffer.from(entry.values[1] as Uint8Array).toString("base64url")],
          })),
          policies: Object.fromEntries(
            [...ruleParams.policies].map(([address, value]) => [
              address,
              value.toXDR("base64"),
            ])
          ),
        },
      });
    } catch (error) {
      if (keyId) {
        await signer.destroy(keyId).catch(() => undefined);
      }
      if (error instanceof RangeError) {
        response.status(400).json({ error: "invalid_amount", message: error.message });
        return;
      }
      next(error);
    }
  });

  router.post("/grants/:id/confirm", requireSession, async (request, response, next) => {
    try {
      const userId = response.locals.userId as string;
      const grant = await getGrantForUser(db, String(request.params.id), userId);
      if (!grant || grant.status !== "pending" || grant.validUntilLedger === null) {
        response.status(404).json({ error: "pending_grant_not_found" });
        return;
      }
      const wallet = await findWalletForUser(db, userId);
      if (!wallet) {
        response.status(404).json({ error: "wallet_not_found" });
        return;
      }
      const txHash = String(request.body?.txHash ?? "");
      await assertTransactionSucceeded(txHash);
      const ruleId = await findAgentContextRule({
        contractId: wallet.contractAddress,
        agentPublicKey: Buffer.from(grant.agentPubkey, "base64url"),
        validUntilLedger: grant.validUntilLedger,
      });
      if (ruleId === undefined) {
        response.status(422).json({ error: "grant_rule_not_found_on_chain" });
        return;
      }
      const budget = await readBudget({
        smartAccount: wallet.contractAddress,
        contextRuleId: ruleId,
      });
      if (
        budget.spendingLimit !== grant.dailyCap ||
        budget.txMax !== grant.txCap ||
        budget.periodLedgers !== 17_280
      ) {
        response.status(422).json({ error: "grant_policy_mismatch" });
        return;
      }
      const active = await activateGrant(db, grant.id, ruleId);
      if (!active) {
        response.status(409).json({ error: "grant_state_changed" });
        return;
      }
      await logActivity(db, {
        grantId: grant.id,
        tool: "confirm_grant",
        argsJson: { txHash, contextRuleId: ruleId },
        decision: "active",
        txHash,
      });
      response.json({ grantId: grant.id, status: "active", contextRuleId: ruleId });
    } catch (error) {
      next(error);
    }
  });

  router.get("/grants/:id/revoke-params", requireSession, async (request, response, next) => {
    try {
      const grant = await getGrantForUser(
        db,
        String(request.params.id),
        response.locals.userId as string
      );
      if (!grant || grant.status !== "active" || grant.contextRuleId === null) {
        response.status(404).json({ error: "active_grant_not_found" });
        return;
      }
      response.json({ grantId: grant.id, contextRuleId: grant.contextRuleId });
    } catch (error) {
      next(error);
    }
  });

  router.post("/grants/:id/revoke", requireSession, async (request, response, next) => {
    try {
      const grant = await getGrantForUser(
        db,
        String(request.params.id),
        response.locals.userId as string
      );
      if (!grant || grant.status !== "active" || grant.contextRuleId === null) {
        response.status(404).json({ error: "active_grant_not_found" });
        return;
      }
      const wallet = await findWalletForUser(db, response.locals.userId as string);
      if (!wallet) {
        response.status(404).json({ error: "wallet_not_found" });
        return;
      }
      const txHash = String(request.body?.txHash ?? "");
      await assertTransactionSucceeded(txHash);
      if (!(await contextRuleIsMissing(wallet.contractAddress, grant.contextRuleId))) {
        response.status(422).json({ error: "grant_rule_still_active" });
        return;
      }
      await signer.destroy(grant.kmsKeyRef);
      await revokeGrant(db, grant.id);
      await db
        .update(oauthTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthTokens.grantId, grant.id));
      await logActivity(db, {
        grantId: grant.id,
        tool: "revoke_grant",
        argsJson: { txHash },
        decision: "revoked",
        txHash,
      });
      response.json({ grantId: grant.id, status: "revoked" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/grants", requireSession, async (_request, response, next) => {
    try {
      const rows = await listGrantsForUser(db, response.locals.userId as string);
      const grants = await Promise.all(
        rows.map(async ({ grant }) => {
          if (grant.status !== "active" || grant.contextRuleId === null) {
            return grantWithBudget(grant);
          }
          const wallet = await findWalletForUser(db, response.locals.userId as string);
          const budget = wallet
            ? await readBudget({
                smartAccount: wallet.contractAddress,
                contextRuleId: grant.contextRuleId,
              })
            : undefined;
          return grantWithBudget(grant, budget);
        })
      );
      response.json(grants);
    } catch (error) {
      next(error);
    }
  });

  router.get("/grants/:id", requireSession, async (request, response, next) => {
    try {
      const grant = await getGrantForUser(
        db,
        String(request.params.id),
        response.locals.userId as string
      );
      if (!grant) {
        response.status(404).json({ error: "grant_not_found" });
        return;
      }
      const wallet = await findWalletForUser(db, response.locals.userId as string);
      const budget =
        wallet && grant.status === "active" && grant.contextRuleId !== null
          ? await readBudget({
              smartAccount: wallet.contractAddress,
              contextRuleId: grant.contextRuleId,
            })
          : undefined;
      response.json(grantWithBudget(grant, budget));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
