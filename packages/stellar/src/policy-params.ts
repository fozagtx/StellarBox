import { Address, xdr } from "@stellar/stellar-sdk";
import {
  buildI128ScVal,
  createCallContractContext,
  createEd25519Signer,
} from "smart-account-kit";
import type { ContextRuleType, Signer } from "smart-account-kit-bindings";

export interface GrantRuleParameters {
  context_type: ContextRuleType;
  name: string;
  valid_until: number;
  signers: Signer[];
  policies: Map<string, xdr.ScVal>;
}

function mapValue(entries: Array<[string, xdr.ScVal]>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    entries.map(
      ([key, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val,
        })
    )
  );
}

function sortPolicies(
  policies: Map<string, xdr.ScVal>
): Map<string, xdr.ScVal> {
  return new Map(
    [...policies].sort(([left], [right]) =>
      Buffer.compare(
        Address.fromString(left).toScVal().toXDR(),
        Address.fromString(right).toScVal().toXDR()
      )
    )
  );
}

export function buildSpendingLimitInstallScVal(
  spendingLimitStroops: bigint,
  periodLedgers = 17_280
): xdr.ScVal {
  if (spendingLimitStroops < 0n) {
    throw new RangeError("spending limit must not be negative");
  }
  if (!Number.isInteger(periodLedgers) || periodLedgers <= 0) {
    throw new RangeError("period ledgers must be a positive integer");
  }
  return mapValue([
    ["period_ledgers", xdr.ScVal.scvU32(periodLedgers)],
    ["spending_limit", buildI128ScVal(spendingLimitStroops)],
  ]);
}

export function buildTxMaxInstallScVal(maxAmountStroops: bigint): xdr.ScVal {
  if (maxAmountStroops < 0n) {
    throw new RangeError("transaction maximum must not be negative");
  }
  return mapValue([
    ["max_amount", buildI128ScVal(maxAmountStroops)],
  ]);
}

export function buildGrantRuleParameters(input: {
  usdcAddress: string;
  spendingLimitPolicy: string;
  txMaxPolicy: string;
  ed25519Verifier: string;
  agentPublicKey: Uint8Array;
  dailyCapStroops: bigint;
  txMaxStroops: bigint;
  validUntilLedger: number;
  name?: string;
}): GrantRuleParameters {
  if (!Number.isInteger(input.validUntilLedger) || input.validUntilLedger <= 0) {
    throw new RangeError("valid-until ledger must be a positive integer");
  }
  return {
    context_type: createCallContractContext(input.usdcAddress),
    name: input.name ?? "Agent spending grant",
    valid_until: input.validUntilLedger,
    signers: [createEd25519Signer(input.ed25519Verifier, input.agentPublicKey)],
    policies: sortPolicies(
      new Map([
        [
          input.spendingLimitPolicy,
          buildSpendingLimitInstallScVal(input.dailyCapStroops),
        ],
        [input.txMaxPolicy, buildTxMaxInstallScVal(input.txMaxStroops)],
      ])
    ),
  };
}
