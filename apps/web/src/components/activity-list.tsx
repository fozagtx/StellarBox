"use client";

import { ArrowUpRight } from "lucide-react";
import { explorerTx, fromStroops, timeAgo, toolLabel } from "../lib/format";
import { Badge } from "./ui";

export interface ActivityEntry {
  id: string;
  grantId: string | null;
  tool: string;
  argsJson: Record<string, unknown>;
  decision: string;
  amount: string | null;
  txHash: string | null;
  error: string | null;
  createdAt: string;
}

function target(entry: ActivityEntry): string | null {
  const args = entry.argsJson ?? {};
  if (typeof args.to === "string") return args.to;
  if (typeof args.url === "string") {
    try {
      return new URL(args.url).host + new URL(args.url).pathname;
    } catch {
      return args.url;
    }
  }
  return null;
}

export function ActivityList({ entries, grantNames }: { entries: ActivityEntry[]; grantNames: Map<string, string> }) {
  return (
    <ul className="divide-y divide-line">
      {entries.map((entry) => {
        const dest = target(entry);
        return (
          <li key={entry.id} className="flex items-center gap-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium capitalize">{toolLabel(entry.tool)}</span>
                <Badge status={entry.decision} />
              </div>
              <p className="mt-0.5 truncate text-[13px] text-muted">
                {entry.grantId ? grantNames.get(entry.grantId) ?? "Grant" : "Wallet"}
                {dest ? ` → ${dest}` : ""}
                {entry.error ? ` · ${entry.error.replace(/_/g, " ")}` : ""}
              </p>
            </div>
            <div className="text-right">
              {entry.amount ? <p className="text-[14px] font-medium tabular-nums">{fromStroops(entry.amount)} USDC</p> : null}
              <p className="text-[12px] text-muted">{timeAgo(entry.createdAt)}</p>
            </div>
            {entry.txHash ? (
              <a
                href={explorerTx(entry.txHash)}
                target="_blank"
                rel="noreferrer"
                title="View on Stellar Expert"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-black/5 hover:text-ink"
              >
                <ArrowUpRight size={16} />
              </a>
            ) : (
              <span className="w-8 shrink-0" />
            )}
          </li>
        );
      })}
    </ul>
  );
}
