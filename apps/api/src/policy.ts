export type SpendDecisionCode =
  | "asset_not_allowed"
  | "payee_not_allowed"
  | "over_tx_cap"
  | "over_daily_cap";

export function grantAvailabilityError(
  grant: { status: string; expiresAt: Date } | undefined,
  now = new Date()
): "grant_revoked" | "grant_expired" | undefined {
  if (!grant || grant.status !== "active") return "grant_revoked";
  if (grant.expiresAt.getTime() <= now.getTime()) return "grant_expired";
  return undefined;
}

export function decideSpend(input: {
  asset: string;
  allowedAssets: string[];
  payee: string;
  allowedPayees: string[];
  amount: bigint;
  txCap: bigint;
  remaining: bigint;
}): SpendDecisionCode | undefined {
  const targetError = spendTargetError(input);
  if (targetError) return targetError;
  return spendLimitError(input.amount, input.txCap, input.remaining);
}

export function spendTargetError(input: {
  asset: string;
  allowedAssets: string[];
  payee: string;
  allowedPayees: string[];
}): "asset_not_allowed" | "payee_not_allowed" | undefined {
  if (input.asset !== "USDC" || !input.allowedAssets.includes(input.asset)) {
    return "asset_not_allowed";
  }
  if (input.allowedPayees.length > 0 && !input.allowedPayees.includes(input.payee)) {
    return "payee_not_allowed";
  }
}

export function spendLimitError(
  amount: bigint,
  txCap: bigint,
  remaining: bigint
): "over_tx_cap" | "over_daily_cap" | undefined {
  if (amount > txCap) return "over_tx_cap";
  if (amount > remaining) return "over_daily_cap";
  return undefined;
}

export function approvalExpiresAt(now = new Date()): Date {
  return new Date(now.getTime() + 15 * 60 * 1000);
}

export function assertX402MaxAmount(amount: bigint, maxAmount: bigint): void {
  if (amount > maxAmount) {
    throw new Error("x402_amount_exceeds_max");
  }
}
