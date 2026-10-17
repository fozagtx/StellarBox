"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, api } from "../../lib/api";
import { MobileNav, Sidebar } from "../../components/sidebar";
import { ErrorNote } from "../../components/ui";

export default function ProtectedAppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    let mounted = true;
    api
      .session()
      .then(() => mounted && setReady(true))
      .catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) {
          router.replace(`/onboarding?next=${encodeURIComponent(pathname)}`);
          return;
        }
        if (mounted) setError(reason);
      });
    return () => {
      mounted = false;
    };
  }, [router, pathname]);

  useEffect(() => {
    if (!ready) return;
    const refresh = () =>
      api
        .approvals()
        .then((items) => setPending(items.filter((item) => item.status === "pending" && new Date(item.expiresAt) > new Date()).length))
        .catch(() => undefined);
    void refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [ready, pathname]);

  if (error) {
    return (
      <main className="mx-auto max-w-lg p-10">
        <ErrorNote error={error} onRetry={() => window.location.reload()} />
      </main>
    );
  }
  if (!ready) return <main className="flex min-h-screen items-center justify-center text-[14px] text-muted">Checking your passkey session…</main>;

  return (
    <div className="flex min-h-screen bg-paper">
      <Sidebar pendingApprovals={pending} />
      <main className="min-w-0 flex-1 px-5 pb-24 pt-8 md:px-10 md:pb-12 md:pt-10">
        <div className="mx-auto max-w-[1080px]">{children}</div>
      </main>
      <MobileNav />
    </div>
  );
}
