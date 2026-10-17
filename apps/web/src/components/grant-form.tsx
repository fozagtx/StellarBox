"use client";

import { useState } from "react";
import { createGrant } from "../lib/kit";
import { Button, ErrorNote, Field, inputClass } from "./ui";

const EXPIRY_OPTIONS = [
  { label: "24 hours", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
];

export function GrantForm({
  defaultName,
  client,
  onCreated,
  submitLabel = "Create grant with passkey",
}: {
  defaultName: string;
  client?: string;
  onCreated: (grantId: string) => void;
  submitLabel?: string;
}) {
  const [name, setName] = useState(defaultName);
  const [clientName, setClientName] = useState(client ?? "");
  const [dailyCap, setDailyCap] = useState("5");
  const [txCap, setTxCap] = useState("1");
  const [hours, setHours] = useState(24 * 7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const daily = Number(dailyCap);
  const tx = Number(txCap);
  const invalid = !name.trim() || !clientName.trim() || !(daily > 0) || !(tx > 0) || tx > daily;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(undefined);
    try {
      const grant = await createGrant({
        name: name.trim(),
        client: clientName.trim(),
        dailyCap,
        txCap,
        assets: ["USDC"],
        expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
      });
      onCreated(grant.grantId);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Grant name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={20} required />
        </Field>
        <Field label="AI client">
          <input
            className={inputClass}
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Claude, ChatGPT, Cursor…"
            disabled={client !== undefined}
            required
          />
        </Field>
        <Field label="Daily cap (USDC)" hint="Rolling 24h limit enforced by the spending-limit policy">
          <input className={inputClass} value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} inputMode="decimal" required />
        </Field>
        <Field label="Per-payment cap (USDC)" hint="Max single transfer, enforced by the tx-max policy">
          <input className={inputClass} value={txCap} onChange={(e) => setTxCap(e.target.value)} inputMode="decimal" required />
        </Field>
      </div>
      <Field label="Expires after">
        <div className="flex flex-wrap gap-2">
          {EXPIRY_OPTIONS.map((option) => (
            <button
              key={option.hours}
              type="button"
              onClick={() => setHours(option.hours)}
              className={`h-9 rounded-full border px-4 text-[13px] font-medium transition ${hours === option.hours ? "border-ink bg-ink text-white" : "border-line bg-white hover:border-ink/40"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>
      <div className="rounded-xl bg-cream px-4 py-3 text-[13px] leading-relaxed text-muted">
        Assets: <span className="font-medium text-ink">USDC only</span>. Your passkey signs one transaction that adds a new agent
        key with these limits to your smart account. Anything above the caps needs your approval.
      </div>
      {tx > daily ? <p className="text-[13px] text-danger">The per-payment cap can't be higher than the daily cap.</p> : null}
      <ErrorNote error={error} />
      <Button type="submit" disabled={busy || invalid}>
        {busy ? "Waiting for passkey and testnet…" : submitLabel}
      </Button>
    </form>
  );
}
