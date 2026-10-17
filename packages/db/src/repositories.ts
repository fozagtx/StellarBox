import { and, desc, eq, gt, lt } from "drizzle-orm";
import type { Database } from "./client.js";
import {
  activity,
  approvals,
  grants,
  passkeys,
  pushSubscriptions,
  sessions,
  users,
  wallets,
} from "./schema.js";

export async function registerWallet(
  db: Database,
  input: {
    contractAddress: string;
    credentialId: string;
    publicKey: string;
    network?: string;
  }
) {
  return db.transaction(async (transaction) => {
    const [user] = await transaction.insert(users).values({}).returning();
    const [wallet] = await transaction
      .insert(wallets)
      .values({
        userId: user!.id,
        contractAddress: input.contractAddress,
        network: input.network ?? "testnet",
      })
      .returning();
    const [passkey] = await transaction
      .insert(passkeys)
      .values({
        userId: user!.id,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
      })
      .returning();
    return { user: user!, wallet: wallet!, passkey: passkey! };
  });
}

export async function findWalletForUser(db: Database, userId: string) {
  const [wallet] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  return wallet;
}

export async function findPasskeyByCredentialId(db: Database, credentialId: string) {
  const [passkey] = await db
    .select()
    .from(passkeys)
    .where(eq(passkeys.credentialId, credentialId))
    .limit(1);
  return passkey;
}

export async function findActiveSession(db: Database, tokenHash: string, now = new Date()) {
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, now)
      )
    )
    .limit(1);
  return session;
}

export async function createSession(
  db: Database,
  input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    challenge?: string;
  }
) {
  const [session] = await db.insert(sessions).values(input).returning();
  return session!;
}

export async function expireSession(db: Database, sessionId: string, now = new Date()) {
  await db.update(sessions).set({ expiresAt: now }).where(eq(sessions.id, sessionId));
}

export async function createGrant(
  db: Database,
  input: {
    walletId: string;
    name: string;
    clientId?: string;
    agentPubkey: string;
    kmsKeyRef: string;
    validUntilLedger?: number;
    dailyCap: bigint;
    txCap: bigint;
    assets: string[];
    payees?: string[];
    expiresAt: Date;
  }
) {
  const [grant] = await db
    .insert(grants)
    .values({
      ...input,
      payees: input.payees ?? [],
      status: "pending",
    })
    .returning();
  return grant!;
}

export async function getGrant(db: Database, grantId: string) {
  const [grant] = await db.select().from(grants).where(eq(grants.id, grantId)).limit(1);
  return grant;
}

export async function getGrantForUser(db: Database, grantId: string, userId: string) {
  const [grant] = await db
    .select({ grant: grants })
    .from(grants)
    .innerJoin(wallets, eq(wallets.id, grants.walletId))
    .where(and(eq(grants.id, grantId), eq(wallets.userId, userId)))
    .limit(1);
  return grant?.grant;
}

export async function listGrantsForUser(db: Database, userId: string) {
  return db
    .select({ grant: grants })
    .from(grants)
    .innerJoin(wallets, eq(wallets.id, grants.walletId))
    .where(eq(wallets.userId, userId))
    .orderBy(desc(grants.createdAt));
}

export async function activateGrant(
  db: Database,
  grantId: string,
  contextRuleId: number
) {
  const [grant] = await db
    .update(grants)
    .set({ contextRuleId, status: "active" })
    .where(and(eq(grants.id, grantId), eq(grants.status, "pending")))
    .returning();
  return grant;
}

export async function revokeGrant(db: Database, grantId: string) {
  const [grant] = await db
    .update(grants)
    .set({ status: "revoked" })
    .where(eq(grants.id, grantId))
    .returning();
  return grant;
}

export async function createApproval(
  db: Database,
  input: {
    grantId: string;
    actionJson: Record<string, unknown>;
    amount?: bigint | null;
    expiresAt: Date;
  }
) {
  const [approval] = await db.insert(approvals).values(input).returning();
  return approval!;
}

export async function getApprovalForUser(
  db: Database,
  approvalId: string,
  userId: string
) {
  const [result] = await db
    .select({ approval: approvals })
    .from(approvals)
    .innerJoin(grants, eq(grants.id, approvals.grantId))
    .innerJoin(wallets, eq(wallets.id, grants.walletId))
    .where(and(eq(approvals.id, approvalId), eq(wallets.userId, userId)))
    .limit(1);
  return result?.approval;
}

export async function getApprovalForGrant(
  db: Database,
  approvalId: string,
  grantId: string
) {
  const [approval] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.grantId, grantId)))
    .limit(1);
  return approval;
}

export async function addPushSubscription(
  db: Database,
  input: {
    userId: string;
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
) {
  const [subscription] = await db
    .insert(pushSubscriptions)
    .values(input)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: input.userId, keys: input.keys },
    })
    .returning();
  return subscription!;
}

export async function logActivity(
  db: Database,
  input: {
    grantId?: string | null;
    tool: string;
    argsJson: Record<string, unknown>;
    decision: string;
    amount?: bigint | null;
    txHash?: string | null;
    error?: string | null;
  }
) {
  const [entry] = await db.insert(activity).values(input).returning();
  return entry!;
}

export async function listActivityForUser(
  db: Database,
  userId: string,
  limit = 100
) {
  return db
    .select({ entry: activity })
    .from(activity)
    .innerJoin(grants, eq(grants.id, activity.grantId))
    .innerJoin(wallets, eq(wallets.id, grants.walletId))
    .where(eq(wallets.userId, userId))
    .orderBy(desc(activity.createdAt))
    .limit(Math.max(1, Math.min(limit, 500)));
}

export async function listActivityForGrant(
  db: Database,
  grantId: string,
  limit = 100
) {
  return db
    .select()
    .from(activity)
    .where(eq(activity.grantId, grantId))
    .orderBy(desc(activity.createdAt))
    .limit(Math.max(1, Math.min(limit, 500)));
}

export async function expirePendingApprovals(db: Database, now = new Date()) {
  await db
    .update(approvals)
    .set({ status: "expired" })
    .where(
      and(
        eq(approvals.status, "pending"),
        lt(approvals.expiresAt, now)
      )
    );
}
