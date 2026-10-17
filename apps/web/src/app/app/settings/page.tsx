"use client";

import { useEffect, useState } from "react";
import { api } from "../../../lib/api";
import { subscribePush } from "../../../lib/kit";
import config from "../../../../../../deployments/testnet.json";
import { explorerContract, shortAddress } from "../../../lib/format";
import { Button, Card, ErrorNote, Mono, PageHeader, SectionTitle, useLoad } from "../../../components/ui";

export default function SettingsPage() {
  const session = useLoad(api.session);
  const [permission, setPermission] = useState<string>("unsupported");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
    setPermission(Notification.permission);
    void navigator.serviceWorker.getRegistration().then(async (reg) => setSubscribed(!!(await reg?.pushManager.getSubscription())));
  }, []);

  async function enable() {
    setBusy(true);
    setError(undefined);
    try {
      await subscribePush();
      setPermission(Notification.permission);
      setSubscribed(true);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  const s = session.data;
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Settings" />
      <Card>
        <SectionTitle>Passkey</SectionTitle>
        <dl className="space-y-3 text-[14px]">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Credential</dt>
            <dd><Mono>{shortAddress(s?.credentialId, 8)}</Mono></dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Smart account</dt>
            <dd>
              {s ? (
                <a href={explorerContract(s.contractId)} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  <Mono>{shortAddress(s.contractId, 6)}</Mono>
                </a>
              ) : "—"}
            </dd>
          </div>
        </dl>
      </Card>
      <Card>
        <SectionTitle>Approval notifications</SectionTitle>
        <p className="text-[14px] text-muted">Get a push notification when an agent needs your approval.</p>
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="text-[14px]">
            {permission === "unsupported" ? "This browser doesn't support push." : subscribed ? "Enabled on this device" : permission === "denied" ? "Blocked in browser settings" : "Not enabled on this device"}
          </span>
          {permission !== "unsupported" && !subscribed && permission !== "denied" ? (
            <Button onClick={() => void enable()} disabled={busy}>{busy ? "Enabling…" : "Enable"}</Button>
          ) : null}
        </div>
        <div className="mt-3"><ErrorNote error={error} /></div>
      </Card>
      <Card>
        <SectionTitle>Network</SectionTitle>
        <dl className="space-y-3 text-[14px]">
          {[
            ["Network", "Stellar testnet"],
            ["RPC", config.rpcUrl],
            ["Spending-limit policy", shortAddress(config.spendingLimitPolicy, 6)],
            ["Tx-max policy", shortAddress(config.txMaxPolicy, 6)],
            ["USDC", shortAddress(config.usdcSac, 6)],
          ].map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4">
              <dt className="text-muted">{label}</dt>
              <dd><Mono>{value}</Mono></dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
