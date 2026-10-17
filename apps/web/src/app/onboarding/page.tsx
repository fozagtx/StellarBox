"use client";

import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { createWallet, login } from "../../lib/kit";
import { errorData } from "../../components/json-data";

export default function OnboardingPage() {
  const [name, setName] = useState("My StellaBox");
  const [wallet, setWallet] = useState<unknown>();
  const [session, setSession] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.session().then(setSession).catch((reason: unknown) => {
      setSession({ authenticated: false });
      if (!(reason instanceof Error) || !("status" in reason)) {
        setError(errorData(reason));
      }
    });
  }, []);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await action();
      setWallet(result);
      setSession(result);
    } catch (reason) {
      setError(errorData(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Set up StellaBox</h1>
      <p>Create a passkey-owned Stellar smart account or sign in with a saved passkey.</p>
      <label>
        Wallet name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button
        type="button"
        disabled={busy || !name.trim()}
        onClick={() => void run(() => createWallet(name.trim()))}
      >
        {busy ? "Working…" : "Create wallet"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const result = await login();
            const next = new URLSearchParams(window.location.search).get("next");
            if (next?.startsWith("/") && !next.startsWith("//")) {
              window.location.assign(next);
            }
            return result;
          })
        }
      >
        Sign in with saved passkey
      </button>
      <p>
        Session:{" "}
        {session && typeof session === "object" && "authenticated" in session
          ? String((session as { authenticated: boolean }).authenticated)
          : "checking"}
      </p>
      {wallet !== undefined ? <pre>{JSON.stringify(wallet, null, 2)}</pre> : null}
      {error ? <pre>{JSON.stringify(error, null, 2)}</pre> : null}
    </main>
  );
}
