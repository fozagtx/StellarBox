"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { xdr } from "@stellar/stellar-sdk";
import { createEd25519Signer, LocalStorageAdapter } from "smart-account-kit";
import type { SmartAccountKit as SmartAccountKitType } from "smart-account-kit";
import testnet from "../../../../deployments/testnet.json";
import { api, type ApiSession, type CreateGrantInput } from "./api";
import { API_BASE_URL } from "./config";

type Kit = SmartAccountKitType;

const CREDENTIAL_ID_KEY = "stellabox.credentialId";
let kitPromise: Promise<Kit> | undefined;
let relayerFetchPatched = false;

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function patchRelayerFetch(relayerUrl: string): void {
  if (relayerFetchPatched) return;
  const target = new URL(relayerUrl);
  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
    let isRelayer = false;
    try {
      const requestUrl = new URL(rawUrl, window.location.href);
      isRelayer =
        requestUrl.origin === target.origin &&
        requestUrl.pathname === target.pathname;
    } catch {
      isRelayer = false;
    }
    return nativeFetch(
      input,
      isRelayer ? { ...init, credentials: "include" } : init
    );
  }) as typeof window.fetch;
  relayerFetchPatched = true;
}

export async function getKit(): Promise<Kit> {
  if (typeof window === "undefined") {
    throw new Error("SmartAccountKit is only available in the browser");
  }
  if (!kitPromise) {
    const relayerUrl = `${API_BASE_URL}/relay`;
    patchRelayerFetch(relayerUrl);
    kitPromise = import("smart-account-kit").then(({ SmartAccountKit }) => {
      return new SmartAccountKit({
        storage: new LocalStorageAdapter(),
        accountWasmHash: testnet.accountWasmHash,
        webauthnVerifierAddress: testnet.webauthnVerifier,
        ed25519VerifierAddress: testnet.ed25519Verifier,
        rpcUrl: testnet.rpcUrl,
        horizonUrl: testnet.horizonUrl,
        networkPassphrase: testnet.networkPassphrase,
        relayerUrl,
        rpId: window.location.hostname,
        rpName: "StellaBox",
        allowedOrigins: [window.location.origin],
      });
    });
  }
  return kitPromise;
}

function credentialIdFromStorage(): string {
  const credentialId = window.localStorage.getItem(CREDENTIAL_ID_KEY);
  if (!credentialId) {
    throw new Error("No passkey credential is saved in this browser");
  }
  return credentialId;
}

async function connectOwner(kit: Kit): Promise<ApiSession> {
  const session = await api.session();
  const connection = await kit.connectWallet({
    credentialId: session.credentialId,
  });
  if (!connection || connection.contractId !== session.contractId) {
    throw new Error("The browser passkey did not connect to the signed-in wallet");
  }
  return session;
}

export async function createWallet(name: string) {
  const kit = await getKit();
  const result = await kit.createWallet("StellaBox", name, {
    autoSubmit: true,
    forceMethod: "relayer",
  });
  if (result.submitResult && !result.submitResult.success) {
    throw new Error(result.submitResult.error.message);
  }
  window.localStorage.setItem(CREDENTIAL_ID_KEY, result.credentialId);
  const registered = await api.registerWallet({
    contractId: result.contractId,
    credentialId: result.credentialId,
    publicKey: encodeBase64Url(result.publicKey),
  });
  return { ...registered, deployment: result.submitResult };
}

export async function login(credentialId = credentialIdFromStorage()) {
  const options = await api.authOptions(credentialId);
  const assertion = await startAuthentication({
    optionsJSON: options,
  });
  await api.verifyLogin(assertion);
  return api.session();
}

export async function createGrant(input: CreateGrantInput) {
  const pending = await api.createGrant(input);
  const kit = await getKit();
  const session = await connectOwner(kit);
  const signers = pending.ruleParams.signers.map((signer) => {
    if (signer.tag !== "External") {
      throw new Error("Grant rule includes an unsupported signer");
    }
    return createEd25519Signer(
      signer.values[0],
      decodeBase64Url(signer.values[1])
    );
  });
  const policies = new Map(
    Object.entries(pending.ruleParams.policies).map(([address, value]) => [
      address,
      xdr.ScVal.fromXDR(value, "base64"),
    ])
  );
  const transaction = await kit.rules.add(
    pending.ruleParams.context_type as Parameters<typeof kit.rules.add>[0],
    pending.ruleParams.name,
    signers as Parameters<typeof kit.rules.add>[2],
    policies,
    pending.ruleParams.valid_until
  );
  const result = await kit.signAndSubmitAdmin(transaction, {
    credentialId: session.credentialId,
  });
  if (!result.success) throw new Error(result.error.message);
  return api.confirmGrant(pending.grantId, result.hash);
}

export async function revokeGrant(id: string) {
  const params = await api.revokeParams(id);
  const kit = await getKit();
  const session = await connectOwner(kit);
  const transaction = await kit.rules.remove(params.contextRuleId);
  const result = await kit.signAndSubmitAdmin(transaction, {
    credentialId: session.credentialId,
  });
  if (!result.success) throw new Error(result.error.message);
  return api.revoke(id, result.hash);
}

async function reauthenticate() {
  const session = await api.session();
  const options = await api.reauthOptions();
  const assertion = await startAuthentication({
    optionsJSON: options,
  });
  return { session, assertion };
}

function stroopsToNumber(value: string): number {
  const amount = Number(BigInt(value)) / 10_000_000;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("The approval amount is not a valid USDC amount");
  }
  return amount;
}

export async function rejectApproval(id: string) {
  const { assertion } = await reauthenticate();
  return api.approvalDecision(id, { decision: "reject", assertion });
}

export async function approveApproval(id: string) {
  const [approval, signParams] = await Promise.all([
    api.approval(id),
    api.approvalSignParams(id),
  ]);
  const { session, assertion } = await reauthenticate();
  const kit = await getKit();
  const connection = await kit.connectWallet({
    credentialId: session.credentialId,
  });
  if (!connection || connection.contractId !== session.contractId) {
    throw new Error("The browser passkey did not connect to the signed-in wallet");
  }

  if (signParams.kind === "send_payment") {
    const action = approval.actionJson as {
      to?: string;
      amountStroops?: string;
    };
    if (!action.to || !action.amountStroops) {
      throw new Error("The transfer approval is missing its payment details");
    }
    const result = await kit.transfer(
      testnet.usdcSac,
      action.to,
      stroopsToNumber(action.amountStroops),
      {
        credentialId: session.credentialId,
        forceMethod: "relayer",
        resolveContextRuleIds: () => [0],
      }
    );
    if (!result.success) throw new Error(result.error.message);
    return api.approvalDecision(id, {
      decision: "approve",
      assertion,
      txHash: result.hash,
    });
  }

  const authEntries = await Promise.all(
    signParams.auth.map(async (encoded) => {
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(encoded, "base64");
      const signed = await kit.signAuthEntry(entry, {
        credentialId: session.credentialId,
        contextRuleIds: [0],
      });
      return signed.toXDR("base64");
    })
  );
  return api.approvalDecision(id, {
    decision: "approve",
    assertion,
    authEntries,
  });
}

export async function subscribePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Push notifications are not available in this browser");
  }
  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const { publicKey } = await api.vapidPublicKey();
    const decodedKey = decodeBase64Url(publicKey);
    const applicationServerKey = new ArrayBuffer(decodedKey.byteLength);
    new Uint8Array(applicationServerKey).set(decodedKey);
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }
  await api.subscribePush(subscription.toJSON());
  return { endpoint: subscription.endpoint, subscribed: true };
}
