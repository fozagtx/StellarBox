import { Router, type RequestHandler } from "express";
import { sql } from "drizzle-orm";
import { waitUntil } from "@vercel/functions";
import type { Database } from "@stellabox/db";
import { findWalletForUser } from "@stellabox/db";
import { fundUsdcWallet } from "@stellabox/stellar";

export const FAUCET_USDC = "10";

type FaucetJob =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; hash: string }
  | { status: "failed"; message: string };

const FAILED_MESSAGE =
  "Couldn't get test USDC from the testnet exchange. Try again in a few minutes.";
// A pending job older than this was cut off (function timeout, redeploy).
const STALE_PENDING_SECONDS = 300;

// Circle's faucet sends classic Stellar payments, which can't reach a smart
// account's C… address. Funding swaps Friendbot XLM for testnet USDC on a
// throwaway account and moves it into the wallet with a SAC transfer. That
// takes longer than the web proxy allows for one request, so it runs in the
// background and the client polls for the result. Job state lives in
// Postgres, and waitUntil keeps a serverless function (Vercel) alive until
// funding settles, so any instance can answer the poll.
export function createFaucetRouter(
  db: Database,
  requireSession: RequestHandler,
  fund: typeof fundUsdcWallet = fundUsdcWallet
) {
  const router = Router();

  async function readJob(userId: string): Promise<FaucetJob> {
    const result = await db.execute(sql`
      SELECT status, hash, message,
        updated_at < now() - make_interval(secs => ${STALE_PENDING_SECONDS}) AS stale
      FROM faucet_jobs WHERE user_id = ${userId}
    `);
    const row = result.rows[0] as
      | { status: string; hash: string | null; message: string | null; stale: boolean }
      | undefined;
    if (!row) return { status: "idle" };
    if (row.status === "pending") {
      return row.stale ? { status: "failed", message: FAILED_MESSAGE } : { status: "pending" };
    }
    if (row.status === "done") return { status: "done", hash: row.hash ?? "" };
    return { status: "failed", message: row.message ?? FAILED_MESSAGE };
  }

  async function writeJob(
    userId: string,
    job: { status: "pending" } | { status: "done"; hash: string } | { status: "failed"; message: string }
  ): Promise<void> {
    const hash = job.status === "done" ? job.hash : null;
    const message = job.status === "failed" ? job.message : null;
    await db.execute(sql`
      INSERT INTO faucet_jobs (user_id, status, hash, message, updated_at)
      VALUES (${userId}, ${job.status}, ${hash}, ${message}, now())
      ON CONFLICT (user_id) DO UPDATE SET
        status = EXCLUDED.status,
        hash = EXCLUDED.hash,
        message = EXCLUDED.message,
        updated_at = now()
    `);
  }

  async function consumeFaucetLimit(userId: string): Promise<boolean> {
    const result = await db.execute(sql`
      INSERT INTO rate_limits (key, window_started_at, count, expires_at)
      VALUES (${`faucet:${userId}`}, now(), 1, now() + interval '1 hour')
      ON CONFLICT (key) DO UPDATE SET
        count = 1,
        window_started_at = now(),
        expires_at = now() + interval '1 hour'
      WHERE rate_limits.expires_at <= now()
      RETURNING key
    `);
    return result.rows.length === 1;
  }

  router.post("/faucet", requireSession, async (_request, response, next) => {
    try {
      const userId = response.locals.userId as string;
      if ((await readJob(userId)).status === "pending") {
        response.status(202).json({ status: "pending" });
        return;
      }
      const wallet = await findWalletForUser(db, userId);
      if (!wallet) {
        response.status(404).json({ error: "wallet_not_found" });
        return;
      }
      if (!(await consumeFaucetLimit(userId))) {
        response.status(429).json({
          error: "faucet_rate_limited",
          message: "You can get test USDC once an hour. Try again later.",
        });
        return;
      }
      await writeJob(userId, { status: "pending" });
      const job = fund({ smartAccount: wallet.contractAddress, minimumUsdc: FAUCET_USDC })
        .then((result) =>
          writeJob(userId, { status: "done", hash: result.sacTransferHash })
        )
        .catch(async (error: unknown) => {
          console.error("POST /faucet", error);
          await writeJob(userId, { status: "failed", message: FAILED_MESSAGE });
          await db.execute(sql`DELETE FROM rate_limits WHERE key = ${`faucet:${userId}`}`);
        })
        .catch((error: unknown) => console.error("POST /faucet job state", error));
      waitUntil(job);
      response.status(202).json({ status: "pending" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/faucet", requireSession, async (_request, response, next) => {
    try {
      response.json(await readJob(response.locals.userId as string));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
