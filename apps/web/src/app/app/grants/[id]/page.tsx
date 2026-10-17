"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { api } from "../../../../lib/api";
import { MCP_URL } from "../../../../lib/config";
import { revokeGrant } from "../../../../lib/kit";
import { fromStroops, shortAddress, timeUntil } from "../../../../lib/format";
import { ActivityList, type ActivityEntry } from "../../../../components/activity-list";
import { Badge, BudgetBar, Button, Card, ErrorNote, Mono, SectionTitle, Skeleton, useLoad } from "../../../../components/ui";

export default function GrantDetailPage() {
  const { id } = useParams<{ id: string }>();
  const grant = useLoad(() => api.grant(id), [id]);
  const activity = useLoad(api.activity);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<unknown>();
  const [copied, setCopied] = useState(false);
  const g = grant.data;
  const mcpUrl = MCP_URL;
  const entries = ((activity.data ?? []) as unknown as ActivityEntry[]).filter((entry) => entry.grantId === id);

  async function revoke() {
    if (!window.confirm("Revoke this grant? Its agent key is removed from your smart account and destroyed.")) return;
    setRevoking(true);
    setRevokeError(undefined);
    try {
      await revokeGrant(id);
      await grant.reload();
    } catch (reason) {
      setRevokeError(reason);
    } finally {
      setRevoking(false);
    }
  }

  if (grant.error) return <ErrorNote error={grant.error} onRetry={grant.reload} />;
  if (!g) return <Skeleton className="h-64" />;

  const budget = g.budget;
  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-[32px] font-semibold leading-none tracking-[-0.03em]">{g.name}</h1>
            <Badge status={g.status} />
          </div>
          <p className="mt-2 text-[15px] text-muted">{g.clientId ?? "No client connected yet"}</p>
        </div>
        {g.status === "active" ? (
          <Button variant="danger" onClick={() => void revoke()} disabled={revoking}>
            {revoking ? "Revoking on-chain…" : "Revoke grant"}
          </Button>
        ) : null}
      </div>
      <ErrorNote error={revokeError} />

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card>
          <SectionTitle>Today&apos;s budget</SectionTitle>
          {budget ? (
            <>
              <p className="text-[44px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
                {fromStroops(budget.remaining)}
                <span className="ml-2 text-[16px] font-medium tracking-normal text-muted">of {fromStroops(budget.spendingLimit)} USDC left</span>
              </p>
              <div className="mt-5">
                <BudgetBar spent={Number(budget.spentInWindow)} limit={Number(budget.spendingLimit)} />
              </div>
              <dl className="mt-6 grid grid-cols-3 gap-4 text-[13px]">
                <div>
                  <dt className="text-muted">Spent (24h)</dt>
                  <dd className="mt-1 text-[16px] font-medium tabular-nums">{fromStroops(budget.spentInWindow)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Per payment</dt>
                  <dd className="mt-1 text-[16px] font-medium tabular-nums">{fromStroops(budget.txMax)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Expires</dt>
                  <dd className="mt-1 text-[16px] font-medium">{timeUntil(g.expiresAt)}</dd>
                </div>
              </dl>
              <p className="mt-5 text-[12px] text-muted">Read live from the spending-limit and tx-max policy contracts on Stellar testnet.</p>
            </>
          ) : (
            <p className="text-[14px] text-muted">
              {g.status === "active" ? "Couldn't read the on-chain budget." : `This grant is ${g.status}; it has no live budget.`}
            </p>
          )}
        </Card>
        <Card>
          <SectionTitle>Connect an AI client</SectionTitle>
          <p className="text-[14px] text-muted">Add this as a remote MCP server in Claude or any MCP client. You&apos;ll sign in and pick this grant.</p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(mcpUrl);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="mt-4 flex w-full items-center justify-between rounded-xl border border-line bg-cream px-4 py-3 text-left hover:border-ink/30"
          >
            <Mono className="truncate">{mcpUrl}</Mono>
            <span className="ml-3 text-[12px] font-medium">{copied ? "Copied" : "Copy"}</span>
          </button>
          <dl className="mt-5 space-y-2 text-[13px]">
            <div className="flex justify-between">
              <dt className="text-muted">Agent key</dt>
              <dd><Mono>{shortAddress(g.agentPubkey as string | undefined, 6)}</Mono></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Context rule</dt>
              <dd><Mono>{g.contextRuleId ?? "—"}</Mono></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Assets</dt>
              <dd>{g.assets.join(", ")}</dd>
            </div>
          </dl>
        </Card>
      </div>

      <section className="mt-10">
        <SectionTitle>Activity for this grant</SectionTitle>
        <Card className="py-2">
          {entries.length === 0 ? (
            <p className="py-6 text-center text-[14px] text-muted">{activity.loading ? "Loading…" : "This agent hasn't done anything yet."}</p>
          ) : (
            <ActivityList entries={entries} grantNames={new Map([[g.id, g.name]])} />
          )}
        </Card>
      </section>
    </>
  );
}
