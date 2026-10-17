import {
  Address,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { loadStellarConfig } from "@stellabox/stellar";

function fields(value: xdr.ScVal): Map<string, xdr.ScVal> {
  if (value.switch().name !== "scvMap") {
    throw new Error("Expected contract response map");
  }
  return new Map(
    (value.map() ?? []).map((entry) => [
      entry.key().sym().toString(),
      entry.val(),
    ])
  );
}

async function simulateRead(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[]
): Promise<xdr.ScVal> {
  const config = loadStellarConfig();
  const account = await server.getAccount(config.readSourceAccount);
  const tx = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const result = await server.simulateTransaction(tx);
  if ("error" in result && result.error) {
    throw new Error(`Soroban read ${method} failed: ${result.error}`);
  }
  if (!("result" in result) || !result.result?.retval) {
    throw new Error(`Soroban read ${method} returned no value`);
  }
  return result.result.retval;
}

export async function getContextRule(
  contractId: string,
  ruleId: number,
  server = new rpc.Server(loadStellarConfig().rpcUrl)
) {
  const result = await simulateRead(
    server,
    contractId,
    "get_context_rule",
    [nativeToScVal(ruleId, { type: "u32" })]
  );
  return fields(result);
}

export async function getContextRuleCount(
  contractId: string,
  server = new rpc.Server(loadStellarConfig().rpcUrl)
): Promise<number> {
  const result = await simulateRead(server, contractId, "get_context_rules_count", []);
  return Number(scValToNative(result));
}

function isMissingContextRule(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("#3000") || message.includes("ContextRuleNotFound");
}

export async function findAgentContextRule(input: {
  contractId: string;
  agentPublicKey: Buffer;
  validUntilLedger: number;
  server?: rpc.Server;
}): Promise<number | undefined> {
  const config = loadStellarConfig();
  const server = input.server ?? new rpc.Server(config.rpcUrl);
  const count = await getContextRuleCount(input.contractId, server);
  for (let ruleId = 1; ruleId < count; ruleId += 1) {
    let rule: Map<string, xdr.ScVal>;
    try {
      rule = await getContextRule(input.contractId, ruleId, server);
    } catch (error) {
      if (isMissingContextRule(error)) continue;
      throw error;
    }
    const signers = rule.get("signers");
    const contextType = rule.get("context_type");
    const validUntil = rule.get("valid_until");
    if (
      !signers ||
      signers.switch().name !== "scvVec" ||
      !contextType ||
      contextType.switch().name !== "scvVec" ||
      !validUntil
    ) {
      continue;
    }
    const typeParts = contextType.vec() ?? [];
    const isUsdcCall =
      typeParts[0]?.switch().name === "scvSymbol" &&
      typeParts[0].sym().toString() === "CallContract" &&
      typeParts[1]?.switch().name === "scvAddress" &&
      Address.fromScAddress(typeParts[1].address()).toString() === config.usdcSac;
    const validUntilNumber = Number(scValToNative(validUntil));
    const hasSigner = (signers.vec() ?? []).some((signer) => {
      const values = externalSignerParts(signer);
      return (
        values?.length === 2 &&
        values[0]?.switch().name === "scvAddress" &&
        Address.fromScAddress(values[0].address()).toString() === config.ed25519Verifier &&
        values[1]?.switch().name === "scvBytes" &&
        Buffer.from(values[1].bytes()).equals(input.agentPublicKey)
      );
    });
    if (isUsdcCall && hasSigner && validUntilNumber === input.validUntilLedger) {
      return ruleId;
    }
  }
  return undefined;
}

export async function assertTransactionSucceeded(
  txHash: string,
  server = new rpc.Server(loadStellarConfig().rpcUrl)
) {
  const transaction = await server.getTransaction(txHash);
  if (transaction.status !== "SUCCESS") {
    throw new Error(`Transaction ${txHash} is not successful on testnet`);
  }
}

export async function contextRuleIsMissing(
  contractId: string,
  ruleId: number,
  server = new rpc.Server(loadStellarConfig().rpcUrl)
): Promise<boolean> {
  try {
    await getContextRule(contractId, ruleId, server);
    return false;
  } catch (error) {
    if (isMissingContextRule(error)) return true;
    throw error;
  }
}

export function buildUsdcTransferFunction(
  from: string,
  to: string,
  amountStroops: bigint
): string {
  const config = loadStellarConfig();
  const hostFunction = new Contract(config.usdcSac).call(
    "transfer",
    Address.fromString(from).toScVal(),
    Address.fromString(to).toScVal(),
    nativeToScVal(amountStroops, { type: "i128" })
  );
  return hostFunction.toXDR("base64");
}

export async function verifyUsdcTransfer(
  txHash: string,
  recipient: string,
  amountStroops: bigint,
  server = new rpc.Server(loadStellarConfig().rpcUrl)
): Promise<boolean> {
  const result = await server.getTransaction(txHash);
  if (result.status !== "SUCCESS") return false;
  const events = result.events?.contractEventsXdr.flat() ?? [];
  const config = loadStellarConfig();
  return events.some((event) => {
    const contractId = event.contractId();
    if (
      event.type().name !== "contract" ||
      !contractId ||
      StrKey.encodeContract(Buffer.from(contractId as unknown as Uint8Array)) !==
        config.usdcSac
    ) {
      return false;
    }
    const body = event.body().v0();
    const topics = body.topics();
    if (
      topics.length < 3 ||
      topics[0]?.switch().name !== "scvSymbol" ||
      topics[0].sym().toString() !== "transfer" ||
      topics[2]?.switch().name !== "scvAddress" ||
      Address.fromScAddress(topics[2].address()).toString() !== recipient
    ) {
      return false;
    }
    return BigInt(String(scValToNative(body.data()))) === amountStroops;
  });
}

function externalSignerParts(value: xdr.ScVal): xdr.ScVal[] | undefined {
  if (value.switch().name !== "scvVec") return undefined;
  const outer = value.vec() ?? [];
  if (outer[0]?.switch().name !== "scvSymbol" ||
      outer[0].sym().toString() !== "External") {
    return undefined;
  }
  if (outer.length === 3) return outer.slice(1);
  if (outer.length === 2 && outer[1]?.switch().name === "scvVec") {
    return outer[1].vec() ?? [];
  }
  return undefined;
}

export async function verifyRegisteredPasskey(
  contractId: string,
  publicKey: Buffer,
  credentialId: Buffer
): Promise<boolean> {
  const config = loadStellarConfig();
  const rule = await getContextRule(contractId, 0);
  const signers = rule.get("signers");
  if (!signers || signers.switch().name !== "scvVec") {
    throw new Error("Wallet rule 0 has no signer list");
  }
  const expectedKeyData = Buffer.concat([publicKey, credentialId]);
  return (signers.vec() ?? []).some((signer) => {
    const values = externalSignerParts(signer);
    if (values?.length !== 2 || values[0]?.switch().name !== "scvAddress" ||
        values[1]?.switch().name !== "scvBytes") {
      return false;
    }
    const verifier = Address.fromScAddress(values[0].address()).toString();
    return (
      verifier === config.webauthnVerifier &&
      Buffer.from(values[1].bytes()).equals(expectedKeyData)
    );
  });
}

export async function readSacBalance(
  sacAddress: string,
  walletAddress: string,
  server = new rpc.Server(loadStellarConfig().rpcUrl)
): Promise<bigint> {
  const result = await simulateRead(server, sacAddress, "balance", [
    Address.fromString(walletAddress).toScVal(),
  ]);
  const native = scValToNative(result);
  return typeof native === "bigint" ? native : BigInt(String(native));
}

export async function getLiveBalances(walletAddress: string) {
  const config = loadStellarConfig();
  const server = new rpc.Server(config.rpcUrl);
  const [usdc, xlm] = await Promise.all([
    readSacBalance(config.usdcSac, walletAddress, server),
    readSacBalance(config.xlmSac, walletAddress, server),
  ]);
  return { usdcStroops: usdc.toString(), xlmStroops: xlm.toString() };
}
