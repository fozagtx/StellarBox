"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "../../../lib/api";
import { explorerContract, explorerTx, fromStroops } from "../../../lib/format";
import { Button, Card, ErrorNote, Mono, PageHeader, Skeleton, useLoad } from "../../../components/ui";

export default function DepositPage() {
  const wallet = useLoad(api.wallet);
  const [qr, setQr] = useState<string>();
  const [copied, setCopied] = useState(false);
  const address = wallet.data?.depositAddress;
  const [funding, setFunding] = useState(false);
  const [fundError, setFundError] = useState<unknown>();
  const [fundedHash, setFundedHash] = useState<string>();

  async function getTestUsdc() {
    setFunding(true);
    setFundError(undefined);
    setFundedHash(undefined);
    try {
      await api.requestTestUsdc();
      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 4000));
        const job = await api.testUsdcStatus();
        if (job.status === "done") {
          setFundedHash(job.hash);
          await wallet.reload();
          return;
        }
        if (job.status === "failed") throw new Error(job.message);
      }
      throw new Error("Test USDC is taking longer than expected. Check your balance again in a minute.");
    } catch (reason) {
      setFundError(reason);
    } finally {
      setFunding(false);
    }
  }

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
      <Card className="mt-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[15px] font-medium">Get 10 test USDC</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              Balance: {wallet.data ? `${fromStroops(wallet.data.balances.usdcStroops)} USDC` : "…"}. Sends testnet USDC straight to this
              wallet. Takes about a minute. Once an hour.
            </p>
          </div>
          <Button onClick={() => void getTestUsdc()} disabled={funding || !address}>
            {funding ? "Sending…" : "Get test USDC"}
          </Button>
        </div>
        {fundedHash ? (
          <p className="mt-3 text-[13px] text-muted">
            10 USDC arrived.{" "}
            <a href={explorerTx(fundedHash)} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              View transaction
            </a>
          </p>
        ) : null}
        <div className="mt-3">
          <ErrorNote error={fundError} />
        </div>
      </Card>
      <p className="mt-5 text-[13px] leading-relaxed text-muted">
        This is a smart contract (C…) address. Circle&apos;s faucet can&apos;t send to it, because it only pays regular G… accounts. To
        send from another wallet, use one that supports Soroban token transfers to contract addresses.
      </p>
    </div>
  );
}
