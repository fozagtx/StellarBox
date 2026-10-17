import {
  Address,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { loadStellarConfig } from "./config.js";

export interface SpendingLimitData {
  spending_limit: bigint;
  period_ledgers: number;
  spending_history: Array<{ amount: bigint; ledger_sequence: number }>;
}

export interface Budget {
  spendingLimit: bigint;
  spentInWindow: bigint;
  remaining: bigint;
  txMax: bigint;
}

function throwSimulationError(result: rpc.Api.SimulateTransactionResponse): void {
  if ("error" in result && result.error) {
    throw new Error(`Soroban read simulation failed: ${result.error}`);
  }
}

function scValFields(value: xdr.ScVal): Map<string, xdr.ScVal> {
  if (value.switch().name !== "scvMap") {
    throw new Error("Expected a Soroban map result");
  }
  return new Map(
    (value.map() ?? []).map((entry) => [entry.key().sym().toString(), entry.val()])
  );
}

function asBigInt(value: xdr.ScVal): bigint {
  const native = scValToNative(value);
  return typeof native === "bigint" ? native : BigInt(String(native));
}

function parseSpendingLimitData(value: xdr.ScVal): SpendingLimitData {
  const fields = scValFields(value);
  const spendingHistory = fields.get("spending_history");
  if (!spendingHistory || spendingHistory.switch().name !== "scvVec") {
    throw new Error("Invalid spending-limit history returned by the chain");
  }
  return {
    spending_limit: asBigInt(fields.get("spending_limit")!),
    period_ledgers: scValToNative(fields.get("period_ledgers")!) as number,
    spending_history: (spendingHistory.vec() ?? []).map((item) => {
      const entry = scValFields(item);
      return {
        amount: asBigInt(entry.get("amount")!),
        ledger_sequence: scValToNative(entry.get("ledger_sequence")!) as number,
      };
    }),
  };
}

export function remainingSpendingLimit(
  data: SpendingLimitData,
  currentLedger: number
): { spentInWindow: bigint; remaining: bigint } {
  const cutoff = currentLedger - data.period_ledgers;
  const spentInWindow = data.spending_history
    .filter((entry) => entry.ledger_sequence > cutoff)
    .reduce((total, entry) => total + entry.amount, 0n);
  return {
    spentInWindow,
    remaining: data.spending_limit > spentInWindow ? data.spending_limit - spentInWindow : 0n,
  };
}

async function simulateRead(
  server: rpc.Server,
  source: Keypair,
  networkPassphrase: string,
  contractId: string,
  functionName: string,
  args: xdr.ScVal[]
): Promise<xdr.ScVal> {
  const account = await server.getAccount(source.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: "100000",
    networkPassphrase,
  })
    .addOperation(new Contract(contractId).call(functionName, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(transaction);
  throwSimulationError(simulation);
  if (!("result" in simulation) || !simulation.result?.retval) {
    throw new Error(`Read ${functionName} returned no value`);
  }
  return simulation.result.retval;
}

export async function readBudget(input: {
  sourceSecret: string;
  smartAccount: string;
  contextRuleId: number;
  currentLedger?: number;
  server?: rpc.Server;
}): Promise<Budget> {
  const config = loadStellarConfig();
  const server = input.server ?? new rpc.Server(config.rpcUrl);
  const source = Keypair.fromSecret(input.sourceSecret);
  const [spendingLimitResult, txMaxResult, currentLedger] = await Promise.all([
    simulateRead(server, source, config.networkPassphrase, config.spendingLimitPolicy, "get_spending_limit_data", [
      nativeToScVal(input.contextRuleId, { type: "u32" }),
      Address.fromString(input.smartAccount).toScVal(),
    ]),
    simulateRead(server, source, config.networkPassphrase, config.txMaxPolicy, "get_max", [
      nativeToScVal(input.contextRuleId, { type: "u32" }),
      Address.fromString(input.smartAccount).toScVal(),
    ]),
    input.currentLedger ?? server.getLatestLedger().then((ledger) => ledger.sequence),
  ]);
  const spending = parseSpendingLimitData(spendingLimitResult);
  const { spentInWindow, remaining } = remainingSpendingLimit(spending, currentLedger);
  return {
    spendingLimit: spending.spending_limit,
    spentInWindow,
    remaining,
    txMax: asBigInt(txMaxResult),
  };
}
