CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "passkeys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "credential_id" text NOT NULL,
  "public_key" text NOT NULL,
  "sign_count" integer DEFAULT 0 NOT NULL,
  "label" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "passkeys_credential_id_idx" ON "passkeys" USING btree ("credential_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "contract_address" text NOT NULL,
  "network" text DEFAULT 'testnet' NOT NULL,
  "deployed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallets_contract_address_idx" ON "wallets" USING btree ("contract_address");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallets_user_id_idx" ON "wallets" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "public_key" text NOT NULL,
  "nonce" bytea NOT NULL,
  "ciphertext" bytea NOT NULL,
  "auth_tag" bytea NOT NULL,
  "destroyed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_keys_destroyed_at_idx" ON "agent_keys" USING btree ("destroyed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "client_id" text,
  "agent_pubkey" text NOT NULL,
  "kms_key_ref" uuid NOT NULL UNIQUE REFERENCES "agent_keys"("id") ON DELETE RESTRICT,
  "context_rule_id" integer,
  "valid_until_ledger" integer,
  "daily_cap" numeric(38,0) NOT NULL,
  "tx_cap" numeric(38,0) NOT NULL,
  "assets" text[] DEFAULT ARRAY['USDC']::text[] NOT NULL,
  "payees" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grants_wallet_id_idx" ON "grants" USING btree ("wallet_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grants_status_expires_at_idx" ON "grants" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "redirect_uris" text[] NOT NULL,
  "metadata" jsonb NOT NULL,
  "registered_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_authorization_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" text NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "grant_id" uuid REFERENCES "grants"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "state" text,
  "code_challenge" text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "resource" text,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_authorization_requests_request_id_idx" ON "oauth_authorization_requests" USING btree ("request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_authorization_requests_expires_at_idx" ON "oauth_authorization_requests" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code_hash" text NOT NULL,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "grant_id" uuid NOT NULL REFERENCES "grants"("id") ON DELETE CASCADE,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "code_challenge_method" text NOT NULL,
  "scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "resource" text,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_codes_code_hash_idx" ON "oauth_codes" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_codes_expires_at_idx" ON "oauth_codes" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grant_id" uuid NOT NULL REFERENCES "grants"("id") ON DELETE CASCADE,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "hash" text NOT NULL,
  "type" text NOT NULL,
  "family_id" uuid NOT NULL,
  "scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "resource" text,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_tokens_hash_idx" ON "oauth_tokens" USING btree ("hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_grant_id_idx" ON "oauth_tokens" USING btree ("grant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_tokens_expires_at_idx" ON "oauth_tokens" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "grant_id" uuid NOT NULL REFERENCES "grants"("id") ON DELETE CASCADE,
  "action_json" jsonb NOT NULL,
  "amount" numeric(38,0),
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "tx_hash" text,
  "result_body" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_grant_id_idx" ON "approvals" USING btree ("grant_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_status_expires_at_idx" ON "approvals" USING btree ("status","expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "grant_id" uuid REFERENCES "grants"("id") ON DELETE SET NULL,
  "tool" text NOT NULL,
  "args_json" jsonb NOT NULL,
  "decision" text NOT NULL,
  "amount" numeric(38,0),
  "tx_hash" text,
  "error" text,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_grant_id_created_at_idx" ON "activity" USING btree ("grant_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_tx_hash_idx" ON "activity" USING btree ("tx_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL,
  "keys" jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_idx" ON "push_subscriptions" USING btree ("endpoint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "challenge" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key" text PRIMARY KEY NOT NULL,
  "window_started_at" timestamptz NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limits_expires_at_idx" ON "rate_limits" USING btree ("expires_at");
