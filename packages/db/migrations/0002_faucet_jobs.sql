CREATE TABLE IF NOT EXISTS "faucet_jobs" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "hash" text,
  "message" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
