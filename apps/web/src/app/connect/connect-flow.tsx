"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, type ApiGrant } from "../../lib/api";
import { fromStroops } from "../../lib/format";
import { GrantForm } from "../../components/grant-form";
import { Logo } from "../../components/logo";
import { Button, ErrorNote } from "../../components/ui";

export default function ConnectFlow({ requestId, clientName }: { requestId: string; clientName: string }) {
  const router = useRouter();
  const client = clientName || "An MCP client";
  const [grants, setGrants] = useState<ApiGrant[]>();
  const [grantId, setGrantId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function loadGrants(select?: string) {
    const items = (await api.grants()).filter((grant) => grant.status === "active");
    setGrants(items);
    if (select) setGrantId(select);
    else if (items.length === 0) setCreating(true);
  }

  useEffect(() => {
    api
      .session()
      .then(() => loadGrants())
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) {
          const here = `/connect?requestId=${encodeURIComponent(requestId)}&clientName=${encodeURIComponent(clientName)}`;
          router.replace(`/onboarding?next=${encodeURIComponent(here)}`);
          return;
        }
        setError(reason);
      });
  }, []);

  async function authorize() {
    setBusy(true);
    setError(undefined);
    try {
      const consent = await api.oauthConsent({ requestId, grantId });
      window.location.assign(consent.redirectUrl);
    } catch (reason) {
      setError(reason);
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-cream">
      <header className="px-6 py-5">
        <Logo href="/app" />
      </header>
      <div className="mx-auto max-w-[560px] px-5 pb-16 pt-4">
        <div className="rounded-3xl border border-line bg-white p-8 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.03em]">Connect {client}</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            {client} is asking to use your StellaBox wallet. It can only spend within the grant you pick, and never more than its caps.
          </p>
          {!requestId ? <div className="mt-5"><ErrorNote error={new Error("This link is missing its authorization request. Start the connection again from your AI client.")} /></div> : null}

          {grants === undefined ? (
            <p className="mt-6 text-[14px] text-muted">Loading your grants…</p>
          ) : creating ? (
            <div className="mt-6">
              <h2 className="mb-4 text-[15px] font-semibold">New grant for {client}</h2>
              <GrantForm
                defaultName={`${client}`.slice(0, 20)}
                client={client}
                submitLabel="Create grant with passkey"
                onCreated={(id) => {
                  setCreating(false);
                  void loadGrants(id);
                }}
              />
              {grants.length ? (
                <button type="button" onClick={() => setCreating(false)} className="mt-4 text-[13px] font-medium text-muted hover:text-ink">
                  Use an existing grant instead
                </button>
              ) : null}
            </div>
          ) : (
            <div className="mt-6 space-y-2">
              {grants.map((grant) => (
                <label
                  key={grant.id}
                  className={`flex cursor-pointer items-center gap-4 rounded-2xl border p-4 transition ${grantId === grant.id ? "border-ink bg-cream" : "border-line hover:border-ink/30"}`}
                >
                  <input type="radio" name="grant" className="accent-black" checked={grantId === grant.id} onChange={() => setGrantId(grant.id)} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{grant.name}</p>
                    <p className="text-[13px] text-muted">
                      {fromStroops(grant.budget?.remaining ?? grant.dailyCap)} of {fromStroops(grant.dailyCap)} USDC left today · max {fromStroops(grant.txCap)} per payment
                    </p>
                  </div>
                </label>
              ))}
              <button type="button" onClick={() => setCreating(true)} className="pt-2 text-[13px] font-medium text-muted hover:text-ink">
                + Create a new grant for {client}
              </button>
              <div className="pt-4">
                <ErrorNote error={error} />
              </div>
              <div className="flex gap-3 pt-2">
                <Button onClick={() => void authorize()} disabled={busy || !grantId || !requestId}>
                  {busy ? "Connecting…" : `Allow ${client}`}
                </Button>
                <Button variant="secondary" href="/app">Cancel</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
