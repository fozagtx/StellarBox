"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api } from "../../lib/api";

export default function ProtectedAppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    void api
      .session()
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) {
          router.replace("/onboarding");
          return;
        }
        if (mounted) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (mounted) setChecking(false);
      });
    return () => {
      mounted = false;
    };
  }, [router]);

  if (checking) return <main><p>Checking session…</p></main>;
  if (error) return <main><pre>{JSON.stringify({ error }, null, 2)}</pre></main>;
  return (
    <>
      <nav>
        <a href="/app">Wallet</a>
        {" | "}
        <a href="/app/grants">Grants</a>
        {" | "}
        <a href="/app/approvals">Approvals</a>
        {" | "}
        <a href="/app/activity">Activity</a>
        {" | "}
        <a href="/app/deposit">Deposit</a>
        {" | "}
        <a href="/app/settings">Settings</a>
      </nav>
      {children}
    </>
  );
}
