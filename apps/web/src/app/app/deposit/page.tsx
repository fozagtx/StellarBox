"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, type ApiWallet } from "../../../lib/api";
import { errorData } from "../../../components/json-data";

export default function DepositPage() {
  const [wallet, setWallet] = useState<ApiWallet>();
  const [qrCode, setQrCode] = useState<string>();
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    let mounted = true;
    void api
      .wallet()
      .then(async (result) => {
        const dataUrl = await QRCode.toDataURL(result.depositAddress);
        if (mounted) {
          setWallet(result);
          setQrCode(dataUrl);
        }
      })
      .catch((reason: unknown) => {
        if (mounted) setError(errorData(reason));
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <main>
      <h1>Deposit</h1>
      {wallet ? <p>Deposit address: {wallet.depositAddress}</p> : <p>Loading…</p>}
      {qrCode ? <img src={qrCode} alt="QR code for the wallet deposit address" /> : null}
      {wallet ? <pre>{JSON.stringify(wallet, null, 2)}</pre> : null}
      {error ? <pre>{JSON.stringify(error, null, 2)}</pre> : null}
    </main>
  );
}
