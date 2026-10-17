"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, type ApiGrant } from "../../lib/api";
import { createGrant } from "../../lib/kit";
import { errorData } from "../../components/json-data";

export default function ConnectFlow({
  requestId,
  clientName,
}: {
  requestId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [grants, setGrants] = useState<ApiGrant[]>([]);
  const [grantId, setGrantId] = useState("");
  const [name, setName] = useState(`${clientName || "Agent"} grant`);
  const [dailyCap, setDailyCap] = useState("3");
  const [txCap, setTxCap] = useState("1");
  const [expiresAt, setExpiresAt] = useState(
    new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16)
  );
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void api
      .session()
      .then(() => api.grants())
      .then((items) => {
        if (mounted) setGrants(items.filter((grant) => grant.status === "active"));
      })
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) {
          const connectUrl = `/connect?requestId=${encodeURIComponent(requestId)}&clientName=${encodeURIComponent(clientName)}`;
          router.replace(`/onboarding?next=${encodeURIComponent(connectUrl)}`);
          return;
        }
        if (mounted) setError(errorData(reason));
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  async function submitConsent() {
    if (!requestId || !grantId) {
      setError({ error: "request_and_active_grant_required" });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const consent = await api.oauthConsent({ requestId, grantId });
      setResult(consent);
      window.location.assign(consent.redirectUrl);
    } catch (reason) {
      setError(errorData(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submitNewGrant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const grant = await createGrant({
        name,
        client: clientName || "OAuth client",
        dailyCap,
        txCap,
        assets: ["USDC"],
        expiresAt: new Date(expiresAt).toISOString(),
      });
      setGrantId(grant.grantId);
      setGrants(await api.grants());
      setResult(grant);
    } catch (reason) {
      setError(errorData(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Connect {clientName || "an application"}</h1>
      <p>Authorization request: {requestId || "missing requestId"}</p>
      <label>
        Active grant
        <select value={grantId} onChange={(event) => setGrantId(event.target.value)}>
          <option value="">Choose a grant</option>
          {grants.map((grant) => (
            <option key={grant.id} value={grant.id}>
              {grant.name} — {grant.clientId}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy || !grantId} onClick={() => void submitConsent()}>
        {busy ? "Working…" : "Authorize"}
      </button>
      <h2>Create a grant</h2>
      <form onSubmit={(event) => void submitNewGrant(event)}>
        <label>Name <input value={name} onChange={(event) => setName(event.target.value)} required /></label>
        <label>Daily USDC cap <input value={dailyCap} onChange={(event) => setDailyCap(event.target.value)} required inputMode="decimal" /></label>
        <label>Per-transaction USDC cap <input value={txCap} onChange={(event) => setTxCap(event.target.value)} required inputMode="decimal" /></label>
        <label>Expires at <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required /></label>
        <button type="submit" disabled={busy}>{busy ? "Submitting…" : "Create and activate grant"}</button>
      </form>
      {result !== undefined ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}
      {error ? <pre>{JSON.stringify(error, null, 2)}</pre> : null}
      <pre>{JSON.stringify(grants, null, 2)}</pre>
    </main>
  );
}
