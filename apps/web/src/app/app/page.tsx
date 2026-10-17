"use client";

import Link from "next/link";
import { ArrowRight, Copy } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { fromStroops, shortAddress } from "../../lib/format";
import { ActivityList, type ActivityEntry } from "../../components/activity-list";
import { GrantCard } from "../../components/grant-card";
import { Button, Card, EmptyState, ErrorNote, SectionTitle, Skeleton, useLoad } from "../../components/ui";

export default function AppHomePage() {
  const wallet = useLoad(api.wallet);
  const grants = useLoad(api.grants);
  const approvals = useLoad(api.approvals);
  const activity = useLoad(api.activity);
  const [copied, setCopied] = useState(false);

  const active = (grants.data ?? []).filter((grant) => grant.status === "active");
  const pending = (approvals.data ?? []).filter((item) => item.status === "pending" && new Date(item.expiresAt) > new Date());
  const names = new Map((grants.data ?? []).map((grant) => [grant.id, grant.name]));
  const entries = ((activity.data ?? []) as unknown as ActivityEntry[]).slice(0, 6);

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-[32px] font-semibold leading-none tracking-[-0.03em]">Wallet</h1>
        <Button href="/app/grants/new">New grant</Button>
      </div>

      <ErrorNote error={wallet.error} onRetry={wallet.reload} />
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card className="bg-ink text-white">
          <p className="text-[13px] text-white/60">USDC balance</p>
          {wallet.data ? (
            <p className="mt-2 text-[52px] font-semibold leading-none tracking-[-0.04em] tabular-nums">
              {fromStroops(wallet.data.balances.usdcStroops)}
              <span className="ml-2 text-[18px] font-medium text-white/50">USDC</span>
            </p>
          ) : (
            <Skeleton className="mt-3 h-12 w-56 bg-white/10" />
          )}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 text-[13px] text-white/60">
            <span>{wallet.data ? `${fromStroops(wallet.data.balances.xlmStroops)} XLM` : " "}</span>
            {wallet.data ? (
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(wallet.data!.contractId);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 font-mono text-[12px] text-white/80 hover:bg-white/15"
              >
                {copied ? "Copied" : shortAddress(wallet.data.contractId, 6)}
                <Copy size={12} />
              </button>
            ) : null}
          </div>
        </Card>
        <Card>
          <SectionTitle>Needs your approval</SectionTitle>
          {approvals.loading && !approvals.data ? (
            <Skeleton className="h-16" />
          ) : pending.length === 0 ? (
            <p className="text-[14px] text-muted">Nothing waiting. Agents ask here when a payment goes over a grant&apos;s caps.</p>
          ) : (
            <ul className="space-y-2">
              {pending.slice(0, 3).map((item) => (
                <li key={item.id}>
                  <Link href={`/app/approvals/${item.id}`} className="flex items-center justify-between rounded-xl bg-warn/10 px-4 py-3 text-[14px] hover:bg-warn/15">
                    <span className="font-medium">
                      {item.amount ? `${fromStroops(item.amount)} USDC` : "Agent request"} · {names.get(item.grantId) ?? "Grant"}
                    </span>
                    <ArrowRight size={16} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <section className="mt-10">
        <SectionTitle action={<Link href="/app/grants" className="text-[13px] font-medium hover:underline">All grants</Link>}>Active grants</SectionTitle>
        {grants.loading && !grants.data ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : active.length === 0 ? (
          <EmptyState
            title="No agents connected yet"
            body="Create a grant to give an AI agent its own key with daily and per-payment caps your smart account enforces."
            action={<Button href="/app/grants/new">Create a grant</Button>}
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {active.map((grant) => (
              <GrantCard key={grant.id} grant={grant} />
            ))}
          </div>
        )}
      </section>

      <section className="mt-10">
        <SectionTitle action={<Link href="/app/activity" className="text-[13px] font-medium hover:underline">All activity</Link>}>Recent activity</SectionTitle>
        <Card className="py-2">
          {entries.length === 0 ? (
            <p className="py-6 text-center text-[14px] text-muted">{activity.loading ? "Loading…" : "No agent activity yet."}</p>
          ) : (
            <ActivityList entries={entries} grantNames={names} />
          )}
        </Card>
      </section>
    </>
  );
}
