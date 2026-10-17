"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { api, type ApiApproval } from "../../../lib/api";
import { approvalTitle, effectiveStatus } from "../../../lib/approvals";
import { fromStroops, timeAgo, timeUntil } from "../../../lib/format";
import { Badge, Card, EmptyState, ErrorNote, PageHeader, SectionTitle, Skeleton, useLoad } from "../../../components/ui";

export default function ApprovalsPage() {
  const approvals = useLoad(api.approvals);
  const grants = useLoad(api.grants);
  const names = new Map((grants.data ?? []).map((grant) => [grant.id, grant.name]));
  const items = approvals.data ?? [];
  const pending = items.filter((item) => effectiveStatus(item) === "pending");
  const past = items.filter((item) => effectiveStatus(item) !== "pending");

  const row = (item: ApiApproval) => (
    <li key={item.id}>
      <Link href={`/app/approvals/${item.id}`} className="flex items-center gap-4 py-3.5 hover:opacity-80">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{approvalTitle(item)}</span>
            <Badge status={effectiveStatus(item)} />
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {names.get(item.grantId) ?? "Grant"} · {effectiveStatus(item) === "pending" ? timeUntil(item.expiresAt) : timeAgo(item.createdAt)}
          </p>
        </div>
        {item.amount ? <span className="text-[14px] font-medium tabular-nums">{fromStroops(item.amount)} USDC</span> : null}
        <ArrowRight size={16} className="text-muted" />
      </Link>
    </li>
  );

  return (
    <>
      <PageHeader title="Approvals" subtitle="Requests that went over a grant's caps. They expire after 15 minutes." />
      <ErrorNote error={approvals.error} onRetry={approvals.reload} />
      {approvals.loading && !approvals.data ? (
        <Skeleton className="h-40" />
      ) : items.length === 0 ? (
        <EmptyState title="No approval requests" body="When an agent tries to spend over its caps, the request shows up here and on your phone." />
      ) : (
        <>
          <SectionTitle>Waiting on you</SectionTitle>
          <Card className="py-1">
            {pending.length ? <ul className="divide-y divide-line">{pending.map(row)}</ul> : <p className="py-5 text-center text-[14px] text-muted">Nothing pending.</p>}
          </Card>
          {past.length ? (
            <section className="mt-10">
              <SectionTitle>History</SectionTitle>
              <Card className="py-1">
                <ul className="divide-y divide-line">{past.map(row)}</ul>
              </Card>
            </section>
          ) : null}
        </>
      )}
    </>
  );
}
