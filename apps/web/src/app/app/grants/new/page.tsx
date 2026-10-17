"use client";

import { useState } from "react";
import { errorData } from "../../../../components/json-data";
import { createGrant } from "../../../../lib/kit";

export default function NewGrantPage() {
  const [name, setName] = useState("Travel agent");
  const [client, setClient] = useState("StellaBox browser");
  const [dailyCap, setDailyCap] = useState("3");
  const [txCap, setTxCap] = useState("1");
  const [expiresAt, setExpiresAt] = useState(
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16)
  );
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setResult(
        await createGrant({
          name,
          client,
          dailyCap,
          txCap,
          assets: ["USDC"],
          expiresAt: new Date(expiresAt).toISOString(),
        })
      );
    } catch (reason) {
      setError(errorData(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Create a grant</h1>
      <form onSubmit={(event) => void submit(event)}>
        <label>Name <input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Client <input value={client} onChange={(event) => setClient(event.target.value)} required /></label>
        <label>Daily USDC cap <input value={dailyCap} onChange={(event) => setDailyCap(event.target.value)} required inputMode="decimal" /></label>
        <label>Per-transaction USDC cap <input value={txCap} onChange={(event) => setTxCap(event.target.value)} required inputMode="decimal" /></label>
        <label>Expires at <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></label>
        <button type="submit" disabled={busy}>{busy ? "Submitting…" : "Create and activate grant"}</button>
      </form>
      {result !== undefined ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}
      {error ? <pre>{JSON.stringify(error, null, 2)}</pre> : null}
    </main>
  );
}
