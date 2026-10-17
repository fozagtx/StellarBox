import {
  Asset,
  Address,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { loadStellarConfig } from "./config.js";

async function submitHorizon(
  server: Horizon.Server,
  transaction: TransactionBuilder,
  keypair: Keypair
): Promise<string> {
  const built = transaction.setTimeout(60).build();
  built.sign(keypair);
  const result = await server.submitTransaction(built);
  return result.hash;
}

async function fundFriendbot(publicKey: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(publicKey)}`);
  if (!response.ok) {
    throw new Error(`Friendbot funding failed with HTTP ${response.status}`);
  }
}

export async function ensureUsdcTrustline(secretKey: string): Promise<void> {
  const config = loadStellarConfig();
  const keypair = Keypair.fromSecret(secretKey);
  const horizon = new Horizon.Server(config.horizonUrl);
  let account;
  try {
    account = await horizon.loadAccount(keypair.publicKey());
  } catch {
    await fundFriendbot(keypair.publicKey());
    account = await horizon.loadAccount(keypair.publicKey());
  }
  const alreadyHasTrustline = account.balances.some(
    (balance) =>
      "asset_code" in balance &&
      balance.asset_code === "USDC" &&
      balance.asset_issuer === config.usdcIssuer
  );
  if (alreadyHasTrustline) {
    return;
  }
  const trustline = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: config.networkPassphrase,
  }).addOperation(
    Operation.changeTrust({ asset: new Asset("USDC", config.usdcIssuer) })
  );
  await submitHorizon(horizon, trustline, keypair);
}

function usdcStroops(amount: string): bigint {
  if (!/^\d+(\.\d{1,7})?$/.test(amount)) {
    throw new RangeError("USDC amount must be a non-negative decimal with up to 7 places");
  }
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole!) * 10_000_000n + BigInt(fraction.padEnd(7, "0") || "0");
}

export async function fundUsdcWallet(input: {
  smartAccount: string;
  sourceKeypair?: Keypair;
  sendXlm?: string;
  minimumUsdc?: string;
}): Promise<{ source: string; pathPaymentHash: string; sacTransferHash: string }> {
  const config = loadStellarConfig();
  const keypair = input.sourceKeypair ?? Keypair.random();
  const horizon = new Horizon.Server(config.horizonUrl);
  await fundFriendbot(keypair.publicKey());

  const issuerAsset = new Asset("USDC", config.usdcIssuer);
  const account = await horizon.loadAccount(keypair.publicKey());
  const trustlineTx = new TransactionBuilder(account, {
    fee: "10000",
    networkPassphrase: config.networkPassphrase,
  }).addOperation(Operation.changeTrust({ asset: issuerAsset }));
  await submitHorizon(horizon, trustlineTx, keypair);

  const fundedAccount = await horizon.loadAccount(keypair.publicKey());
  const pathPaymentTx = new TransactionBuilder(fundedAccount, {
    fee: "10000",
    networkPassphrase: config.networkPassphrase,
  }).addOperation(
    Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(),
      sendAmount: input.sendXlm ?? "100",
      destination: keypair.publicKey(),
      destAsset: issuerAsset,
      destMin: input.minimumUsdc ?? "1",
      path: [],
    })
  );
  const pathPaymentHash = await submitHorizon(horizon, pathPaymentTx, keypair);

  const rpcServer = new rpc.Server(config.rpcUrl);
  const rpcAccount = await rpcServer.getAccount(keypair.publicKey());
  const transferFunc = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(config.usdcSac).toScAddress(),
      functionName: xdr.ScVal.scvSymbol("transfer").sym(),
      args: [
        Address.fromString(keypair.publicKey()).toScVal(),
        Address.fromString(input.smartAccount).toScVal(),
        nativeToScVal(usdcStroops(input.minimumUsdc ?? "1"), { type: "i128" }),
      ],
    })
  );
  const transferTx = new TransactionBuilder(rpcAccount, {
    fee: "100000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: transferFunc, auth: [] }))
    .setTimeout(60)
    .build();
  const simulation = await rpcServer.simulateTransaction(transferTx);
  if ("error" in simulation && simulation.error) {
    throw new Error(`USDC SAC transfer simulation failed: ${simulation.error}`);
  }
  const assembled = rpc.assembleTransaction(transferTx, simulation).build();
  assembled.sign(keypair);
  const submitted = await rpcServer.sendTransaction(assembled);
  if (submitted.status === "ERROR") {
    throw new Error(`USDC SAC transfer submission failed: ${JSON.stringify(submitted)}`);
  }
  let transaction = await rpcServer.getTransaction(submitted.hash);
  while (transaction.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    transaction = await rpcServer.getTransaction(submitted.hash);
  }
  if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`USDC SAC transfer failed: ${transaction.status}`);
  }
  return {
    source: keypair.publicKey(),
    pathPaymentHash,
    sacTransferHash: submitted.hash,
  };
}
