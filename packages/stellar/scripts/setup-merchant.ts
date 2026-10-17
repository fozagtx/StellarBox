import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { loadStellarConfig } from "../src/config.js";

const secretPath = new URL("../../../.deploy/paid-api-merchant.secret", import.meta.url);
const config = loadStellarConfig();

await mkdir(new URL("../../../.deploy/", import.meta.url), {
  recursive: true,
  mode: 0o700,
});
let keypair: Keypair;
try {
  keypair = Keypair.fromSecret((await readFile(secretPath, "utf8")).trim());
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  keypair = Keypair.random();
  await writeFile(secretPath, keypair.secret(), { encoding: "utf8", mode: 0o600, flag: "wx" });
}

const horizon = new Horizon.Server(config.horizonUrl);
const friendbot = await fetch(
  `https://friendbot.stellar.org/?addr=${encodeURIComponent(keypair.publicKey())}`
);
if (!friendbot.ok && friendbot.status !== 400) {
  throw new Error(`Merchant Friendbot funding failed with HTTP ${friendbot.status}`);
}

const asset = new Asset("USDC", config.usdcIssuer);
let account = await horizon.loadAccount(keypair.publicKey());
if (
  !account.balances.some(
    (balance) =>
      "asset_code" in balance &&
      balance.asset_code === "USDC" &&
      balance.asset_issuer === config.usdcIssuer
  )
) {
  const trustline = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();
  trustline.sign(keypair);
  await horizon.submitTransaction(trustline);
  account = await horizon.loadAccount(keypair.publicKey());
}

const balance = account.balances.find(
  (entry) =>
    "asset_code" in entry &&
    entry.asset_code === "USDC" &&
    entry.asset_issuer === config.usdcIssuer
);
if (!balance || Number(balance.balance) < 1) {
  const payment = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: "100",
        destination: keypair.publicKey(),
        destAsset: asset,
        destMin: "1",
        path: [],
      })
    )
    .setTimeout(60)
    .build();
  payment.sign(keypair);
  await horizon.submitTransaction(payment);
}
console.log(JSON.stringify({ merchantAddress: keypair.publicKey() }));
