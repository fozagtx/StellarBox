import { Router, type RequestHandler } from "express";
import { sql } from "drizzle-orm";
import type { Database } from "@stellabox/db";
import { findWalletForUser } from "@stellabox/db";
import { fundUsdcWallet } from "@stellabox/stellar";

export const FAUCET_USDC = "10";

type FaucetJob =
  | { status: "pending" }
  | { status: "done"; hash: string }
  | { status: "failed"; message: string };

// Circle's faucet sends classic Stellar payments, which can't reach a smart
// account's C… address. Funding swaps Friendbot XLM for testnet USDC on a
// throwaway account and moves it into the wallet with a SAC transfer. That
// takes longer than the web proxy allows for one request, so it runs in the
// background and the client polls for the result.
export function createFaucetRouter(
  db: Database,
  requireSession: RequestHandler,
  fund: typeof fundUsdcWallet = fundUsdcWallet
) {
  const router = Router();
  const jobs = new Map<string, FaucetJob>();

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
      if (jobs.get(userId)?.status === "pending") {
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
      jobs.set(userId, { status: "pending" });
      void fund({ smartAccount: wallet.contractAddress, minimumUsdc: FAUCET_USDC })
        .then((result) => {
          jobs.set(userId, { status: "done", hash: result.sacTransferHash });
        })
        .catch((error: unknown) => {
          console.error("POST /faucet", error);
          jobs.set(userId, {
            status: "failed",
            message: "Couldn't get test USDC from the testnet exchange. Try again in a few minutes.",
          });
          void db.execute(sql`DELETE FROM rate_limits WHERE key = ${`faucet:${userId}`}`);
        });
      response.status(202).json({ status: "pending" });
    } catch (error) {
      next(error);
    }
  });

  router.get("/faucet", requireSession, (_request, response) => {
    const job = jobs.get(response.locals.userId as string);
    response.json(job ?? { status: "idle" });
  });

  return router;
}
