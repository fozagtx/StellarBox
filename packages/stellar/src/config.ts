import deployment from "../../../deployments/testnet.json" with { type: "json" };

export interface StellarConfig {
  network: "testnet";
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  channelsBaseUrl: string;
  accountWasmHash: string;
  webauthnVerifier: string;
  ed25519Verifier: string;
  spendingLimitPolicy: string;
  txMaxPolicy: string;
  usdcSac: string;
  xlmSac: string;
  usdcIssuer: string;
}

export function loadStellarConfig(env: NodeJS.ProcessEnv = process.env): StellarConfig {
  const txMaxPolicy = env.TX_MAX_POLICY_ADDRESS ?? deployment.txMaxPolicy;
  if (!txMaxPolicy) {
    throw new Error("TX_MAX_POLICY_ADDRESS is required until the testnet policy is deployed");
  }

  return {
    network: "testnet",
    rpcUrl: env.STELLAR_RPC_URL ?? deployment.rpcUrl,
    horizonUrl: env.STELLAR_HORIZON_URL ?? deployment.horizonUrl,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? deployment.networkPassphrase,
    channelsBaseUrl: env.CHANNELS_BASE_URL ?? deployment.channelsBaseUrl,
    accountWasmHash: env.ACCOUNT_WASM_HASH ?? deployment.accountWasmHash,
    webauthnVerifier: env.WEBAUTHN_VERIFIER_ADDRESS ?? deployment.webauthnVerifier,
    ed25519Verifier: env.ED25519_VERIFIER_ADDRESS ?? deployment.ed25519Verifier,
    spendingLimitPolicy:
      env.SPENDING_LIMIT_POLICY_ADDRESS ?? deployment.spendingLimitPolicy,
    txMaxPolicy,
    usdcSac: env.USDC_SAC_ADDRESS ?? deployment.usdcSac,
    xlmSac: env.XLM_SAC_ADDRESS ?? deployment.xlmSac,
    usdcIssuer: env.USDC_ISSUER ?? deployment.usdcIssuer,
  };
}
