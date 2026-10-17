import Link from "next/link";
import type { ApiGrant } from "../lib/api";
import { fromStroops, timeUntil } from "../lib/format";
import { Badge, BudgetBar } from "./ui";

export function GrantCard({ grant }: { grant: ApiGrant }) {
  const budget = grant.budget;
  const limit = Number(budget?.spendingLimit ?? grant.dailyCap);
  const spent = Number(budget?.spentInWindow ?? 0);
  return (
    <Link href={`/app/grants/${grant.id}`} className="block rounded-2xl border border-line bg-white p-5 transition hover:border-ink/30">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold tracking-[-0.01em]">{grant.name}</p>
          <p className="mt-0.5 truncate text-[13px] text-muted">{grant.clientId ?? "No client connected"}</p>
        </div>
        <Badge status={grant.status} />
      </div>
      {budget ? (
        <div className="mt-5">
          <div className="mb-2 flex items-baseline justify-between text-[13px]">
            <span className="text-[20px] font-semibold tabular-nums tracking-[-0.02em]">
              {fromStroops(budget.remaining)}
              <span className="ml-1 text-[13px] font-normal text-muted">USDC left today</span>
            </span>
            <span className="text-muted tabular-nums">of {fromStroops(budget.spendingLimit)}</span>
          </div>
          <BudgetBar spent={spent} limit={limit} />
          <div className="mt-3 flex justify-between text-[12px] text-muted">
            <span>Max {fromStroops(budget.txMax)} per payment</span>
            <span>{timeUntil(grant.expiresAt)}</span>
          </div>
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-muted">
          Daily cap {fromStroops(grant.dailyCap)} · per payment {fromStroops(grant.txCap)} USDC
        </p>
      )}
    </Link>
  );
}
