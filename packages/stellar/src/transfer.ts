import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { loadStellarConfig } from "./config.js";
import { signAgentAuthEntry } from "./auth.js";

export interface AgentTransfer {
  func: string;
  auth: string[];
}

export interface PreparedAgentCall extends AgentTransfer {
  simulationError?: string;
}

function invokeContract(
  contractId: string,
  functionName: string,
  args: xdr.ScVal[]
): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(contractId).toScAddress(),
      functionName: xdr.ScVal.scvSymbol(functionName).sym(),
      args,
    })
  );
}

function simulationError(result: rpc.Api.SimulateTransactionResponse): string | undefined {
  return "error" in result && result.error ? result.error : undefined;
}

export async function prepareAgentCall(input: {
  sourceSecret: string;
  targetContract: string;
  targetFunction: string;
  targetArgs: xdr.ScVal[];
  contextRuleId: number;
  agentSecret: string;
  server?: rpc.Server;
}): Promise<PreparedAgentCall> {
  const config = loadStellarConfig();
  const server = input.server ?? new rpc.Server(config.rpcUrl);
  const source = Keypair.fromSecret(input.sourceSecret);
  const hostFunction = invokeContract(
    input.targetContract,
    input.targetFunction,
    input.targetArgs
  );
  const func = hostFunction.toXDR("base64");
  const sourceAccount = await server.getAccount(source.publicKey());
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: "100000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: hostFunction, auth: [] }))
    .setTimeout(60)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  const initialError = simulationError(simulation);
  if (initialError) {
    return { func, auth: [], simulationError: initialError };
  }
  if (!("result" in simulation)) {
    return {
      func,
      auth: [],
      simulationError: "Simulation did not return an authorization result",
    };
  }
  const authEntries = simulation.result?.auth ?? [];
  if (authEntries.length === 0) {
    return {
      func,
      auth: [],
      simulationError: "Simulation did not return a smart-account authorization entry",
    };
  }
  const latestLedger = simulation.latestLedger;
  if (latestLedger === undefined) {
    return { func, auth: [], simulationError: "Simulation did not return its latest ledger" };
  }
  const signedEntries = authEntries.map((entry) =>
    signAgentAuthEntry({
      entry,
      secretKey: input.agentSecret,
      ed25519Verifier: config.ed25519Verifier,
      networkPassphrase: config.networkPassphrase,
      contextRuleIds: [input.contextRuleId],
      expirationLedger: latestLedger + 60,
    })
  );

  const resimulationTransaction = new TransactionBuilder(sourceAccount, {
    fee: "100000",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.invokeHostFunction({ func: hostFunction, auth: signedEntries })
    )
    .setTimeout(60)
    .build();
  const resimulation = await server.simulateTransaction(
    resimulationTransaction
  );
  const resimulationError = simulationError(resimulation);
  return {
    func,
    auth: signedEntries.map((entry) => entry.toXDR("base64")),
    ...(resimulationError ? { simulationError: resimulationError } : {}),
  };
}

export async function buildAgentTransfer(input: {
  sourceSecret: string;
  smartAccount: string;
  destination: string;
  amountStroops: bigint;
  contextRuleId: number;
  agentSecret: string;
  server?: rpc.Server;
}): Promise<AgentTransfer> {
  const config = loadStellarConfig();
  const prepared = await prepareAgentCall({
    sourceSecret: input.sourceSecret,
    targetContract: config.usdcSac,
    targetFunction: "transfer",
    targetArgs: [
      Address.fromString(input.smartAccount).toScVal(),
      Address.fromString(input.destination).toScVal(),
      nativeToScVal(input.amountStroops, { type: "i128" }),
    ],
    contextRuleId: input.contextRuleId,
    agentSecret: input.agentSecret,
    server: input.server,
  });
  if (prepared.simulationError) {
    throw new Error(`Soroban simulation failed: ${prepared.simulationError}`);
  }
  return { func: prepared.func, auth: prepared.auth };
}
