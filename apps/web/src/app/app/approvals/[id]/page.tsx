"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "../../../../lib/api";
import { approveApproval, rejectApproval } from "../../../../lib/kit";
import { explorerTx, fromStroops, timeUntil } from "../../../../lib/format";
import { Badge, Button, Card, ErrorNote, Mono, Skeleton, useLoad } from "../../../../components/ui";
import { approvalTitle, effectiveStatus } from "../../../../lib/approvals";

export default function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const approval = useLoad(() => api.approval(id), [id]);
  const grants = useLoad(api.grants);
  const [busy, setBusy] = useState<"approve" | "reject">();
  const [error, setError] = useState<unknown>();
  const item = approval.data;

  async function decide(kind: "approve" | "reject") {
    setBusy(kind);
    setError(undefined);
    try {
      await (kind === "approve" ? approveApproval(id) : rejectApproval(id));
      await approval.reload();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(undefined);
    }
  }

  if (approval.error) return <ErrorNote error={approval.error} onRetry={approval.reload} />;
  if (!item) return <Skeleton className="h-72" />;
  const action = item.actionJson as Record<string, unknown>;
  const grant = grants.data?.find((g) => g.id === item.grantId);
  const status = effectiveStatus(item);
  const over =
    item.amount && grant
      ? action.reason === "over_tx_cap"
        ? BigInt(item.amount) - BigInt(grant.budget?.txMax ?? grant.txCap)
        : grant.budget
          ? BigInt(item.amount) - BigInt(grant.budget.remaining)
          : null
      : null;

  const rows: Array<[string, React.ReactNode]> = [
    ["Grant", grant?.name ?? "—"],
    ["Action", action.kind === "x402" ? "Paid API call (x402)" : action.kind === "send_payment" ? "USDC payment" : "Custom request"],
  ];
  if (action.kind === "x402") rows.push(["Endpoint", <Mono key="u" className="break-all">{`${String(action.method ?? "GET")} ${String(action.url)}`}</Mono>]);
  if (action.kind === "send_payment") rows.push(["Recipient", <Mono key="t" className="break-all">{String(action.to)}</Mono>]);
  if (action.memo) rows.push(["Memo", String(action.memo)]);
  if (action.reason) rows.push(["Why approval", String(action.reason).replace(/_/g, " ")]);
  if (over !== null && over > 0n) rows.push(["Over the cap by", `${fromStroops(over)} USDC`]);

  return (
    <div className="max-w-2xl">
      <div className="mb-8 flex items-center gap-3">
        <h1 className="text-[32px] font-semibold leading-none tracking-[-0.03em]">{approvalTitle(item)}</h1>
        <Badge status={status} />
      </div>
      <Card>
        <p className="text-[13px] text-muted">Amount</p>
        <p className="mt-1 text-[44px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
          {item.amount ? fromStroops(item.amount) : "—"}
          <span className="ml-2 text-[16px] font-medium text-muted">USDC</span>
        </p>
        <dl className="mt-6 divide-y divide-line border-t border-line text-[14px]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex justify-between gap-6 py-3">
              <dt className="shrink-0 text-muted">{label}</dt>
              <dd className="text-right">{value}</dd>
            </div>
          ))}
        </dl>
        {status === "pending" ? (
          <>
            <p className="mt-5 text-[13px] text-muted">
              {timeUntil(item.expiresAt)}. Approving signs with your passkey through the owner rule, so it bypasses this grant&apos;s caps for this one payment.
            </p>
            <ErrorNote error={error} />
            <div className="mt-5 flex gap-3">
              <Button onClick={() => void decide("approve")} disabled={!!busy}>
                {busy === "approve" ? "Signing and submitting…" : "Approve with passkey"}
              </Button>
              <Button variant="secondary" onClick={() => void decide("reject")} disabled={!!busy}>
                {busy === "reject" ? "Rejecting…" : "Reject"}
              </Button>
            </div>
          </>
        ) : item.txHash ? (
          <a href={explorerTx(item.txHash)} target="_blank" rel="noreferrer" className="mt-5 inline-block text-[14px] font-medium underline underline-offset-2">
            View transaction on Stellar Expert
          </a>
        ) : null}
      </Card>
    </div>
  );
}
