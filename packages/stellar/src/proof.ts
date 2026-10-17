import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  Keypair,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import {
  computeEntryAuthDigest,
  createCallContractContext,
  createDelegatedSigner,
  createEd25519Signer,
  signerToScVal,
} from "smart-account-kit";
import { Client as SmartAccountClient } from "smart-account-kit-bindings";
import { createChannelsClient } from "./channels.js";
import { loadStellarConfig } from "./config.js";
import { ensureUsdcTrustline, fundUsdcWallet } from "./funding.js";
import { buildGrantRuleParameters, buildTxMaxInstallScVal } from "./policy-params.js";
import { prepareAgentCall } from "./transfer.js";

interface ProofStep {
  step: string;
  expected: string;
  actual: string;
  transactionHash?: string;
  transactionId?: string;
  errorCode?: string;
  simulationError?: string;
  detail?: string;
  passed: boolean;
}

interface ProofSummary {
  network: "testnet";
  createdAt: string;
  account?: string;
  owner?: string;
  agent?: string;
  deploymentTransactionHash?: string;
  funding?: {
    source: string;
    pathPaymentHash: string;
    sacTransferHash: string;
  };
  grantRules: Array<{ id: number; name: string; transactionHash: string }>;
  steps: ProofStep[];
  fatalError?: string;
}

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../../../");

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bS[A-Z2-7]{55}\b/g, "[redacted]")
    .replace(process.env.CHANNELS_API_KEY ?? "\0", "[redacted]");
}

function expectedFailurePassed(input: {
  expected: string;
  actual: string;
  errorCode?: string;
  expectedErrorCode?: string;
}): boolean {
  if (!input.expected.startsWith("revert") || input.actual === "success") {
    return false;
  }
  if (input.expectedErrorCode) {
    return input.errorCode === input.expectedErrorCode;
  }
  return (
    input.actual === "reverted_on_chain" ||
    (input.errorCode !== undefined &&
      ["simulation_error", "rejected_before_submission", "submission_error"].includes(
        input.actual
      ))
  );
}

function errorCode(message: string | undefined): string | undefined {
  if (!message) {
    return undefined;
  }
  const match = message.match(/(?:Error\(Contract,\s*#|Contract,\s*#)(\d+)\)?/);
  return match?.[1];
}

function invocation(
  contractId: string,
  functionName: string,
  args: xdr.ScVal[]
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contractId).toScAddress(),
      functionName: xdr.ScVal.scvSymbol(functionName).sym(),
        args,
      })
    ),
    subInvocations: [],
  });
}

function addressSignature(
  publicKey: Uint8Array,
  signature: Uint8Array
): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_key"),
        val: xdr.ScVal.scvBytes(Buffer.from(publicKey)),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signature"),
        val: xdr.ScVal.scvBytes(Buffer.from(signature)),
      }),
    ]),
  ]);
}

export function signDelegatedAuthEntries(input: {
  entries: xdr.SorobanAuthorizationEntry[];
  smartAccount: string;
  owner: Keypair;
  networkPassphrase: string;
  expirationLedger: number;
}): xdr.SorobanAuthorizationEntry[] {
  const delegatedSigner = createDelegatedSigner(input.owner.publicKey());
  const signedEntries: xdr.SorobanAuthorizationEntry[] = [];

  for (const entry of input.entries) {
    const credentials = entry.credentials();
    if (credentials.switch().name !== "sorobanCredentialsAddressV2") {
      throw new Error("Expected an AddressV2 smart-account authorization entry");
    }
    const accountCredentials = credentials.addressV2();
    if (
      Address.fromScAddress(accountCredentials.address()).toString() !==
      input.smartAccount
    ) {
      throw new Error("Simulation returned authorization for an unexpected address");
    }
    accountCredentials.signatureExpirationLedger(input.expirationLedger);
    const { authDigest } = computeEntryAuthDigest(
      input.networkPassphrase,
      entry,
      input.expirationLedger,
      [0]
    );
    accountCredentials.signature(
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("context_rule_ids"),
          val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("signers"),
          val: xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: signerToScVal(delegatedSigner),
              val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
            }),
          ]),
        }),
      ])
    );

    const delegatedInvocation = invocation(input.smartAccount, "__check_auth", [
      xdr.ScVal.scvBytes(authDigest),
    ]);
    const nonce = xdr.Int64.fromString(
      (1n +
        (randomBytes(8).readBigUInt64BE() %
          9_223_372_036_854_775_807n)).toString()
    );
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(input.networkPassphrase)),
    nonce,
        signatureExpirationLedger: input.expirationLedger,
        invocation: delegatedInvocation,
      })
    );
    const delegatedCredentials = new xdr.SorobanAddressCredentials({
      address: Address.fromString(input.owner.publicKey()).toScAddress(),
      nonce,
      signatureExpirationLedger: input.expirationLedger,
      signature: addressSignature(
        input.owner.rawPublicKey(),
        input.owner.sign(hash(preimage.toXDR()))
      ),
    });
    signedEntries.push(entry);
    signedEntries.push(
      new xdr.SorobanAuthorizationEntry({
        credentials:
          xdr.SorobanCredentials.sorobanCredentialsAddress(delegatedCredentials),
        rootInvocation: delegatedInvocation,
      })
    );
  }
  return signedEntries;
}

async function submitAdminOperation<T>(input: {
  assembled: AssembledTransaction<T>;
  smartAccount: string;
  owner: Keypair;
  server: rpc.Server;
  networkPassphrase: string;
}): Promise<string> {
  const initialSimulation = input.assembled.simulation;
  const initialTransaction = input.assembled.built;
  if (!initialSimulation || !initialTransaction) {
    throw new Error("Smart-account operation did not produce a simulation");
  }
  if ("error" in initialSimulation && initialSimulation.error) {
    throw new Error(`Admin operation simulation failed: ${initialSimulation.error}`);
  }
  if (!("result" in initialSimulation)) {
    throw new Error("Admin operation simulation returned no result");
  }
  const latestLedger = initialSimulation.latestLedger;
  if (latestLedger === undefined) {
    throw new Error("Admin operation simulation did not return its latest ledger");
  }
  const authEntries = initialSimulation.result?.auth ?? [];
  if (authEntries.length === 0) {
    throw new Error("Admin operation simulation returned no authorization entries");
  }
  const initialHostCall = initialTransaction
    .toEnvelope()
    .v1()
    .tx()
    .operations()[0]
    .body()
    .value() as xdr.InvokeHostFunctionOp;
  const signedEntries = signDelegatedAuthEntries({
    entries: authEntries,
    smartAccount: input.smartAccount,
    owner: input.owner,
    networkPassphrase: input.networkPassphrase,
    expirationLedger: latestLedger + 60,
  });
  const resimulationTransaction = new TransactionBuilder(
    await input.server.getAccount(input.owner.publicKey()),
    {
      fee: "100000",
      networkPassphrase: input.networkPassphrase,
    }
  )
    .addOperation(
      Operation.invokeHostFunction({
        func: initialHostCall.hostFunction(),
        auth: signedEntries,
      })
    )
    .setTimeout(60)
    .build();

  const resimulation = await input.server.simulateTransaction(
    resimulationTransaction
  );
  if ("error" in resimulation && resimulation.error) {
    throw new Error(`Signed admin operation simulation failed: ${resimulation.error}`);
  }
  const transaction = rpc
    .assembleTransaction(resimulationTransaction, resimulation)
    .build();
  transaction.sign(input.owner);
  const submitted = await input.server.sendTransaction(transaction);
  if (submitted.status === "ERROR") {
    throw new Error(`Admin transaction submission failed: ${JSON.stringify(submitted)}`);
  }
  const confirmed = await waitForTransaction(input.server, submitted.hash);
  if (confirmed.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Admin transaction failed on-chain: ${confirmed.status}`);
  }
  return submitted.hash;
}

async function waitForTransaction(
  server: rpc.Server,
  transactionHash: string
): Promise<rpc.Api.GetTransactionResponse> {
  const deadline = Date.now() + 120_000;
  let response = await server.getTransaction(transactionHash);
  while (
    response.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
    Date.now() < deadline
  ) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    response = await server.getTransaction(transactionHash);
  }
  return response;
}

export function deriveContractId(
  deployer: string,
  salt: Buffer,
  networkPassphrase: string
): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: hash(Buffer.from(networkPassphrase)),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: Address.fromString(deployer).toScAddress(),
          salt,
        })
      ),
    })
  );
  return StrKey.encodeContract(hash(preimage.toXDR()));
}

export async function ensureFunded(
  keypair: Keypair,
  server: rpc.Server
): Promise<void> {
  try {
    await server.getAccount(keypair.publicKey());
    return;
  } catch {
    const response = await fetch(
      `https://friendbot.stellar.org/?addr=${encodeURIComponent(keypair.publicKey())}`
    );
    if (!response.ok) {
      throw new Error(`Friendbot funding failed with HTTP ${response.status}`);
    }
  }
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      await server.getAccount(keypair.publicKey());
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    }
  }
  throw new Error("Friendbot-funded owner account did not appear on the RPC");
}

async function addGrantRule(input: {
  client: SmartAccountClient;
  owner: Keypair;
  smartAccount: string;
  server: rpc.Server;
  networkPassphrase: string;
  parameters: Parameters<SmartAccountClient["add_context_rule"]>[0];
}): Promise<{ id: number; transactionHash: string }> {
  const assembled = await input.client.add_context_rule(input.parameters, {
    publicKey: input.owner.publicKey(),
    signTransaction: input.owner,
    useUpgradedAuth: true,
  });
  const id = assembled.result.id;
  const transactionHash = await submitAdminOperation({
    assembled,
    smartAccount: input.smartAccount,
    owner: input.owner,
    server: input.server,
    networkPassphrase: input.networkPassphrase,
  });
  return { id, transactionHash };
}

async function removeGrantRule(input: {
  client: SmartAccountClient;
  owner: Keypair;
  smartAccount: string;
  server: rpc.Server;
  networkPassphrase: string;
  contextRuleId: number;
}): Promise<string> {
  const assembled = await input.client.remove_context_rule(
    { context_rule_id: input.contextRuleId },
    {
      publicKey: input.owner.publicKey(),
      signTransaction: input.owner,
      useUpgradedAuth: true,
    }
  );
  return submitAdminOperation({
    assembled,
    smartAccount: input.smartAccount,
    owner: input.owner,
    server: input.server,
    networkPassphrase: input.networkPassphrase,
  });
}

async function runAgentCase(input: {
  step: string;
  expected: string;
  expectedErrorCode?: string;
  sourceSecret: string;
  smartAccount: string;
  destination: string;
  amountStroops: bigint;
  contextRuleId: number;
  agentSecret: string;
  server: rpc.Server;
  approve?: boolean;
  channels: ReturnType<typeof createChannelsClient>;
}): Promise<ProofStep> {
    const config = loadStellarConfig();
    const approvalExpiration = (await input.server.getLatestLedger()).sequence + 17_280;
    let prepared: Awaited<ReturnType<typeof prepareAgentCall>>;
  try {
      prepared = await prepareAgentCall({
        sourceSecret: input.sourceSecret,
        targetContract: config.usdcSac,
      targetFunction: input.approve ? "approve" : "transfer",
      targetArgs: input.approve
        ? [
            Address.fromString(input.smartAccount).toScVal(),
            Address.fromString(input.destination).toScVal(),
            nativeToScVal(input.amountStroops, { type: "i128" }),
            xdr.ScVal.scvU32(approvalExpiration),
          ]
        : [
            Address.fromString(input.smartAccount).toScVal(),
            Address.fromString(input.destination).toScVal(),
            nativeToScVal(input.amountStroops, { type: "i128" }),
          ],
      contextRuleId: input.contextRuleId,
      agentSecret: input.agentSecret,
      server: input.server,
    });
  } catch (error) {
    const detail = publicError(error);
    const code = errorCode(detail);
    return {
      step: input.step,
      expected: input.expected,
      actual: "simulation_error",
      ...(code ? { errorCode: code } : {}),
      detail,
      passed: expectedFailurePassed({
        expected: input.expected,
        actual: "simulation_error",
        errorCode: code,
        expectedErrorCode: input.expectedErrorCode,
      }),
    };
  }

  let response;
  try {
    response = await input.channels.submitSorobanTransaction({
      func: prepared.func,
      auth: prepared.auth,
    });
  } catch (error) {
    const detail = publicError(error);
    const code = errorCode(prepared.simulationError) ?? errorCode(detail);
    const actual = prepared.simulationError
      ? "rejected_before_submission"
      : "submission_error";
    return {
      step: input.step,
      expected: input.expected,
      actual,
      ...(code ? { errorCode: code } : {}),
      ...(prepared.simulationError
        ? { simulationError: publicError(prepared.simulationError) }
        : {}),
      detail,
      passed: expectedFailurePassed({
        expected: input.expected,
        actual,
        errorCode: code,
        expectedErrorCode: input.expectedErrorCode,
      }),
    };
  }

  const status = response.status?.toLowerCase() ?? "submitted";
  const actual = ["success", "succeeded", "confirmed"].includes(status)
    ? "success"
    : ["failed", "error", "reverted"].includes(status)
      ? "reverted_on_chain"
      : status;
  const reportedError = response.metadata?.logs?.map((log) => log.message).join("\n");
  const code = errorCode(prepared.simulationError ?? reportedError);
  const expectedSuccess = input.expected === "success";
  return {
    step: input.step,
    expected: input.expected,
    actual,
    ...(response.hash ? { transactionHash: response.hash } : {}),
    ...(response.transactionId ? { transactionId: response.transactionId } : {}),
    ...(code ? { errorCode: code } : {}),
    ...(prepared.simulationError
      ? { simulationError: publicError(prepared.simulationError) }
      : {}),
    ...(reportedError ? { detail: publicError(reportedError) } : {}),
    passed: expectedSuccess
      ? actual === "success"
      : expectedFailurePassed({
          expected: input.expected,
          actual,
          errorCode: code,
          expectedErrorCode: input.expectedErrorCode,
        }),
  };
}

async function writeSummary(summary: ProofSummary): Promise<void> {
  const evidencePath = resolve(rootDirectory, "evidence/prove-caps-testnet.json");
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(summary, null, 2)}\n`);
}

export async function runCapsProof(): Promise<ProofSummary> {
  const summary: ProofSummary = {
    network: "testnet",
    createdAt: new Date().toISOString(),
    grantRules: [],
    steps: [],
  };
  try {
    const ownerSecret = process.env.STELLAR_OWNER_SECRET;
    const agentSecret = process.env.STELLAR_AGENT_SECRET;
    if (!ownerSecret || !agentSecret) {
      throw new Error("STELLAR_OWNER_SECRET and STELLAR_AGENT_SECRET are required");
    }
    const config = loadStellarConfig();
    const owner = Keypair.fromSecret(ownerSecret);
    const agent = Keypair.fromSecret(agentSecret);
    const server = new rpc.Server(config.rpcUrl);
    summary.owner = owner.publicKey();
    summary.agent = agent.publicKey();
    await ensureFunded(owner, server);

    const salt = randomBytes(32);
    const accountAddress = deriveContractId(
      owner.publicKey(),
      salt,
      config.networkPassphrase
    );
    const deployment = await SmartAccountClient.deploy(
      {
        signers: [createDelegatedSigner(owner.publicKey())],
        policies: new Map(),
      },
      {
        wasmHash: config.accountWasmHash,
        salt,
        publicKey: owner.publicKey(),
        signTransaction: owner,
        networkPassphrase: config.networkPassphrase,
        rpcUrl: config.rpcUrl,
        timeoutInSeconds: 60,
      }
    );
    const sentDeployment = await deployment.signAndSend({
      force: true,
      signTransaction: owner,
    });
    summary.deploymentTransactionHash =
      sentDeployment.sendTransactionResponse?.hash ??
      deployment.signed?.hash().toString("hex");
    summary.account = accountAddress;

    summary.funding = await fundUsdcWallet({
      smartAccount: accountAddress,
      minimumUsdc: "7",
      sendXlm: "100",
    });
    await ensureUsdcTrustline(agentSecret);

    const latestLedger = await server.getLatestLedger();
    const validUntil = latestLedger.sequence + 17_280;
    const parameters = buildGrantRuleParameters({
      usdcAddress: config.usdcSac,
      spendingLimitPolicy: config.spendingLimitPolicy,
      txMaxPolicy: config.txMaxPolicy,
      ed25519Verifier: config.ed25519Verifier,
      agentPublicKey: agent.rawPublicKey(),
      dailyCapStroops: 30_000_000n,
      txMaxStroops: 10_000_000n,
      validUntilLedger: validUntil,
      name: "Agent transfer grant",
    });
    const accountClient = new SmartAccountClient({
      contractId: accountAddress,
      publicKey: owner.publicKey(),
      signTransaction: owner,
      networkPassphrase: config.networkPassphrase,
      rpcUrl: config.rpcUrl,
    });
    const firstGrant = await addGrantRule({
      client: accountClient,
      owner,
      smartAccount: accountAddress,
      server,
      networkPassphrase: config.networkPassphrase,
      parameters,
    });
    summary.grantRules.push({
      id: firstGrant.id,
      name: "Agent transfer grant",
      transactionHash: firstGrant.transactionHash,
    });

    const channels = createChannelsClient();
    const transferDestination = agent.publicKey();
    const agentSourceSecret = owner.secret();
    const firstTests = [
      {
        step: "transfer_0_5_usdc",
        expected: "success",
        amountStroops: 5_000_000n,
      },
      {
        step: "transfer_1_5_usdc_tx_max",
        expected: "revert:TxMaxExceeded",
        expectedErrorCode: "3301",
        amountStroops: 15_000_000n,
      },
      {
        step: "spending_limit_transfer_1",
        expected: "success",
        amountStroops: 10_000_000n,
      },
      {
        step: "spending_limit_transfer_2",
        expected: "success",
        amountStroops: 10_000_000n,
      },
      {
        step: "spending_limit_transfer_3_after_initial_0_5",
        expected: "revert:SpendingLimitExceeded",
        expectedErrorCode: "3221",
        amountStroops: 10_000_000n,
      },
    ];
    for (const test of firstTests) {
      summary.steps.push(
        await runAgentCase({
          ...test,
          sourceSecret: agentSourceSecret,
          smartAccount: accountAddress,
          destination: transferDestination,
          contextRuleId: firstGrant.id,
          agentSecret,
          server,
          channels,
        })
      );
      await writeSummary(summary);
    }

    const freshGrantParameters = buildGrantRuleParameters({
      usdcAddress: config.usdcSac,
      spendingLimitPolicy: config.spendingLimitPolicy,
      txMaxPolicy: config.txMaxPolicy,
      ed25519Verifier: config.ed25519Verifier,
      agentPublicKey: agent.rawPublicKey(),
      dailyCapStroops: 30_000_000n,
      txMaxStroops: 10_000_000n,
      validUntilLedger: validUntil,
      name: "Agent grant",
    });
    const freshGrant = await addGrantRule({
      client: accountClient,
      owner,
      smartAccount: accountAddress,
      server,
      networkPassphrase: config.networkPassphrase,
      parameters: freshGrantParameters,
    });
    summary.grantRules.push({
      id: freshGrant.id,
      name: "Agent grant",
      transactionHash: freshGrant.transactionHash,
    });

    for (let index = 1; index <= 4; index += 1) {
      const isFourth = index === 4;
      summary.steps.push(
        await runAgentCase({
          step: `fresh_grant_transfer_1_usdc_${index}`,
          expected: isFourth ? "revert:SpendingLimitExceeded" : "success",
          ...(isFourth ? { expectedErrorCode: "3221" } : {}),
          sourceSecret: agentSourceSecret,
          smartAccount: accountAddress,
          destination: transferDestination,
          amountStroops: 10_000_000n,
          contextRuleId: freshGrant.id,
          agentSecret,
          server,
          channels,
        })
      );
      await writeSummary(summary);
    }

    const approveRuleParameters = {
      context_type: createCallContractContext(config.usdcSac),
      name: "Transfer only",
      valid_until: validUntil,
      signers: [
        createEd25519Signer(config.ed25519Verifier, agent.rawPublicKey()),
      ],
      policies: new Map([
        [config.txMaxPolicy, buildTxMaxInstallScVal(10_000_000n)],
      ]),
    };
    const approveRule = await addGrantRule({
      client: accountClient,
      owner,
      smartAccount: accountAddress,
      server,
      networkPassphrase: config.networkPassphrase,
      parameters: approveRuleParameters,
    });
    summary.grantRules.push({
      id: approveRule.id,
      name: "Transfer only",
      transactionHash: approveRule.transactionHash,
    });
    summary.steps.push(
      await runAgentCase({
        step: "usdc_approve_rejected",
        expected: "revert:FunctionNotAllowed",
        expectedErrorCode: "3302",
        sourceSecret: agentSourceSecret,
        smartAccount: accountAddress,
        destination: transferDestination,
        amountStroops: 1_000_000n,
        contextRuleId: approveRule.id,
        agentSecret,
        server,
        approve: true,
        channels,
      })
    );
    await writeSummary(summary);

    for (const rule of [approveRule, freshGrant, firstGrant]) {
      const transactionHash = await removeGrantRule({
        client: accountClient,
        owner,
        smartAccount: accountAddress,
        server,
        networkPassphrase: config.networkPassphrase,
        contextRuleId: rule.id,
      });
      summary.steps.push({
        step: `owner_removed_rule_${rule.id}`,
        expected: "success",
        actual: "success",
        transactionHash,
        passed: true,
      });
      await writeSummary(summary);
    }

    summary.steps.push(
      await runAgentCase({
        step: "agent_transfer_after_rule_removal",
        expected: "revert:RuleRemoved",
        sourceSecret: agentSourceSecret,
        smartAccount: accountAddress,
        destination: transferDestination,
        amountStroops: 1_000_000n,
        contextRuleId: firstGrant.id,
        agentSecret,
        server,
        channels,
      })
    );
  } catch (error) {
    summary.fatalError = publicError(error);
  }
  await writeSummary(summary);
  return summary;
}
