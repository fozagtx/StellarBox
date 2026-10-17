"use client";

import { useEffect, useState } from "react";
import { Fingerprint } from "lucide-react";
import { ApiError, api } from "../../lib/api";
import { createWallet, login } from "../../lib/kit";
import { Logo } from "../../components/logo";
import { Button, ErrorNote, Field, inputClass } from "../../components/ui";

function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

export default function OnboardingPage() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"create" | "login">();
  const [error, setError] = useState<unknown>();
  const [step, setStep] = useState<string>();

  useEffect(() => {
    void api.session().then(() => window.location.replace(nextPath())).catch(() => undefined);
  }, []);

  async function create() {
    setBusy("create");
    setError(undefined);
    try {
      setStep("Creating your passkey and deploying your smart account on testnet…");
      await createWallet(name.trim() || "StellaBox user");
      try {
        await api.session();
      } catch (reason) {
        if (!(reason instanceof ApiError) || reason.status !== 401) throw reason;
        setStep("Signing in with your new passkey…");
        await login();
      }
      window.location.assign(nextPath());
    } catch (reason) {
      setError(reason);
      setStep(undefined);
    } finally {
      setBusy(undefined);
    }
  }

  async function signIn() {
    setBusy("login");
    setError(undefined);
    try {
      await login();
      window.location.assign(nextPath());
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <main className="flex min-h-screen flex-col bg-cream">
      <header className="px-6 py-5">
        <Logo href="/" />
      </header>
      <div className="flex flex-1 items-center justify-center px-5 pb-16">
        <div className="w-full max-w-[420px] rounded-3xl border border-line bg-white p-8 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.25)]">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-ink text-white">
            <Fingerprint size={24} />
          </div>
          <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.03em]">Create your wallet</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Your passkey owns a Stellar smart account. No seed phrase, and fees are sponsored.
          </p>
          <div className="mt-6">
            <Field label="Your name" hint="Shown in your device's passkey prompt">
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
            </Field>
          </div>
          <Button className="mt-5 w-full" onClick={() => void create()} disabled={!!busy}>
            {busy === "create" ? "Working…" : "Create wallet with passkey"}
          </Button>
          {step ? <p className="mt-3 text-[13px] text-muted">{step}</p> : null}
          <div className="my-6 flex items-center gap-3 text-[12px] text-muted">
            <span className="h-px flex-1 bg-line" />
            already have one
            <span className="h-px flex-1 bg-line" />
          </div>
          <Button variant="secondary" className="w-full" onClick={() => void signIn()} disabled={!!busy}>
            {busy === "login" ? "Waiting for passkey…" : "Sign in with passkey"}
          </Button>
          <div className="mt-4">
            <ErrorNote error={error} />
          </div>
          <p className="mt-6 text-center text-[12px] text-muted">Stellar testnet · test funds only</p>
        </div>
      </div>
    </main>
  );
}
