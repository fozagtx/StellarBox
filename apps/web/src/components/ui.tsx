"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../lib/api";

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message === error.code ? error.code.replace(/_/g, " ") : error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setData(await run());
      setError(undefined);
    } catch (reason) {
      setError(reason);
    } finally {
      setLoading(false);
    }
  }, [run]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[32px] font-semibold leading-none tracking-[-0.03em]">{title}</h1>
        {subtitle ? <p className="mt-2 text-[15px] text-muted">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-white p-6 ${className}`}>{children}</div>;
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="text-[13px] font-medium uppercase tracking-[0.08em] text-muted">{children}</h2>
      {action}
    </div>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
};

const buttonStyles = {
  primary: "bg-ink text-white hover:bg-black/85",
  secondary: "border border-line bg-white text-ink hover:border-ink/40",
  danger: "border border-danger/30 bg-white text-danger hover:bg-danger/5",
  ghost: "text-ink hover:bg-black/5",
};

export function Button({ children, onClick, href, variant = "primary", disabled, type = "button", className = "" }: ButtonProps) {
  const classes = `inline-flex h-10 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${buttonStyles[variant]} ${className}`;
  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={classes}>
      {children}
    </button>
  );
}

const badgeStyles: Record<string, string> = {
  active: "bg-accent/10 text-accent",
  executed: "bg-accent/10 text-accent",
  approved: "bg-accent/10 text-accent",
  pending: "bg-warn/10 text-warn",
  approval_required: "bg-warn/10 text-warn",
  rejected: "bg-danger/10 text-danger",
  revoked: "bg-black/5 text-muted",
  expired: "bg-black/5 text-muted",
  error: "bg-danger/10 text-danger",
};

export function Badge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-medium ${badgeStyles[status] ?? "bg-black/5 text-muted"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-white/60 px-6 py-12 text-center">
      <p className="text-[15px] font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-[14px] text-muted">{body}</p>
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-danger/20 bg-danger/5 px-4 py-3 text-[14px] text-danger">
      <span>{errorMessage(error)}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-black/[0.06] ${className}`} />;
}

export function BudgetBar({ spent, limit }: { spent: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
  const tone = pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warn" : "bg-ink";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07]">
      <div className={`h-full rounded-full ${tone} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-[13px] font-medium">{label}</span>
      <div className="mt-1.5">{children}</div>
      {hint ? <span className="mt-1 block text-[12px] text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "h-11 w-full rounded-xl border border-line bg-white px-3.5 text-[15px] outline-none transition focus:border-ink/50 focus:ring-4 focus:ring-black/5";

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[13px] ${className}`}>{children}</span>;
}
