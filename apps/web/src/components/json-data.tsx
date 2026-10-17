"use client";

import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";

export function errorData(error: unknown) {
  return error instanceof ApiError
    ? { error: error.code, status: error.status, message: error.message }
    : { error: error instanceof Error ? error.message : String(error) };
}

export function JsonData({
  title,
  load,
}: {
  title: string;
  load: () => Promise<unknown>;
}) {
  const [value, setValue] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    void load()
      .then((result) => {
        if (mounted) setValue(result);
      })
      .catch((reason: unknown) => {
        if (mounted) setError(errorData(reason));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <main>
      <h1>{title}</h1>
      {loading ? <p>Loading…</p> : null}
      {error ? <pre>{JSON.stringify(error, null, 2)}</pre> : null}
      {value !== undefined ? <pre>{JSON.stringify(value, null, 2)}</pre> : null}
    </main>
  );
}

export function ActionButton({
  label,
  action,
}: {
  label: string;
  action: () => Promise<unknown>;
}) {
  const [value, setValue] = useState<unknown>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setValue(undefined);
    setError(undefined);
    try {
      setValue(await action());
    } catch (reason) {
      setError(errorData(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <button type="button" onClick={() => void run()} disabled={busy}>
        {busy ? "Working…" : label}
      </button>
      {value !== undefined ? <pre>{JSON.stringify(value, null, 2)}</pre> : null}
      {error ? <pre>{JSON.stringify(error, null, 2)}</pre> : null}
    </section>
  );
}
