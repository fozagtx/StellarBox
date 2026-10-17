"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../../../lib/api";
import { explorerContract } from "../../../lib/format";
import { Button, Card, ErrorNote, Mono, PageHeader, Skeleton, useLoad } from "../../../components/ui";

export default function DepositPage() {
  const wallet = useLoad(api.wallet);
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);
  const address = wallet.data?.depositAddress;

  useEffect(() => {
    if (address) void QRCode.toDataURL(address, { margin: 1, width: 440, color: { dark: "#121212", light: "#ffffff" } }).then(setQr);
  }, [address]);

  return (
    <div className="max-w-2xl">
      <PageHeader title="Deposit" subtitle="Send testnet USDC (Circle issuer) to your smart account address." />
      <ErrorNote error={wallet.error} onRetry={wallet.reload} />
      <Card className="flex flex-col items-center text-center">
        {qr ? <img src={qr} alt="Deposit address QR code" className="h-56 w-56 rounded-xl" /> : <Skeleton className="h-56 w-56" />}
        {address ? (
          <>
            <Mono className="mt-6 break-all px-4 text-[14px] leading-relaxed">{address}</Mono>
            <div className="mt-6 flex gap-3">
              <Button
                onClick={() => {
                  void navigator.clipboard.writeText(address);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied" : "Copy address"}
              </Button>
              <Button variant="secondary" href={explorerContract(address)}>
                View on explorer
              </Button>
            </div>
          </>
        ) : null}
      </Card>
      <p className="mt-5 text-[13px] leading-relaxed text-muted">
        This is a Soroban contract (C…) address. Send USDC with a wallet that supports Soroban token transfers, or get testnet USDC from
        Circle&apos;s faucet at faucet.circle.com (Stellar testnet).
      </p>
    </div>
  );
}
