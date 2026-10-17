import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email"),
  createdAt: createdAt(),
});

export const passkeys = pgTable(
  "passkeys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull(),
    publicKey: text("public_key").notNull(),
    signCount: integer("sign_count").notNull().default(0),
    label: text("label"),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("passkeys_credential_id_idx").on(table.credentialId)]
);

export const wallets = pgTable(
  "wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contractAddress: text("contract_address").notNull(),
    network: text("network").notNull().default("testnet"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("wallets_contract_address_idx").on(table.contractAddress),
    index("wallets_user_id_idx").on(table.userId),
  ]
);

export const agentKeys = pgTable(
  "agent_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicKey: text("public_key").notNull(),
    nonce: bytea("nonce").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    authTag: bytea("auth_tag").notNull(),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [index("agent_keys_destroyed_at_idx").on(table.destroyedAt)]
);

export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => wallets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clientId: text("client_id"),
    agentPubkey: text("agent_pubkey").notNull(),
    kmsKeyRef: uuid("kms_key_ref")
      .notNull()
      .unique()
      .references(() => agentKeys.id, { onDelete: "restrict" }),
    contextRuleId: integer("context_rule_id"),
    validUntilLedger: integer("valid_until_ledger"),
    dailyCap: numeric("daily_cap", { precision: 38, scale: 0, mode: "bigint" }).notNull(),
    txCap: numeric("tx_cap", { precision: 38, scale: 0, mode: "bigint" }).notNull(),
    assets: text("assets")
      .array()
      .notNull()
      .default(sql`ARRAY['USDC']::text[]`),
    payees: text("payees").array().notNull().default(sql`ARRAY[]::text[]`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
  },
  (table) => [
    index("grants_wallet_id_idx").on(table.walletId),
    index("grants_status_expires_at_idx").on(table.status, table.expiresAt),
  ]
);

export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris").array().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
  registeredAt: createdAt(),
});

export const oauthAuthorizationRequests = pgTable(
  "oauth_authorization_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: text("request_id").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id").references(() => grants.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_authorization_requests_request_id_idx").on(table.requestId),
    index("oauth_authorization_requests_expires_at_idx").on(table.expiresAt),
  ]
);

export const oauthCodes = pgTable(
  "oauth_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method").notNull(),
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_codes_code_hash_idx").on(table.codeHash),
    index("oauth_codes_expires_at_idx").on(table.expiresAt),
  ]
);

export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    type: text("type").notNull(),
    familyId: uuid("family_id").notNull(),
    scopes: text("scopes").array().notNull().default(sql`ARRAY[]::text[]`),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("oauth_tokens_hash_idx").on(table.hash),
    index("oauth_tokens_grant_id_idx").on(table.grantId),
    index("oauth_tokens_expires_at_idx").on(table.expiresAt),
  ]
);

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => grants.id, { onDelete: "cascade" }),
    actionJson: jsonb("action_json").notNull(),
    amount: numeric("amount", { precision: 38, scale: 0, mode: "bigint" }),
    status: text("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    txHash: text("tx_hash"),
    resultBody: text("result_body"),
    createdAt: createdAt(),
  },
  (table) => [
    index("approvals_grant_id_idx").on(table.grantId),
    index("approvals_status_expires_at_idx").on(table.status, table.expiresAt),
  ]
);

export const activity = pgTable(
  "activity",
  {
    id: bigint("id", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    grantId: uuid("grant_id").references(() => grants.id, { onDelete: "set null" }),
    tool: text("tool").notNull(),
    argsJson: jsonb("args_json").notNull(),
    decision: text("decision").notNull(),
    amount: numeric("amount", { precision: 38, scale: 0, mode: "bigint" }),
    txHash: text("tx_hash"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (table) => [
    index("activity_grant_id_created_at_idx").on(table.grantId, table.createdAt),
    index("activity_tx_hash_idx").on(table.txHash),
  ]
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    keys: jsonb("keys").$type<{ p256dh: string; auth: string }>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("push_subscriptions_endpoint_idx").on(table.endpoint),
    index("push_subscriptions_user_id_idx").on(table.userId),
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    challenge: text("challenge"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_idx").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ]
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("rate_limits_expires_at_idx").on(table.expiresAt)]
);

export const schema = {
  users,
  passkeys,
  wallets,
  agentKeys,
  grants,
  oauthClients,
  oauthAuthorizationRequests,
  oauthCodes,
  oauthTokens,
  approvals,
  activity,
  pushSubscriptions,
  sessions,
  rateLimits,
};

export type Grant = typeof grants.$inferSelect;
