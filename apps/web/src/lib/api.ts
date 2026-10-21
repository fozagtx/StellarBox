import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { API_BASE_URL } from "./config";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message = code
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiSession {
  authenticated: true;
  userId: string;
  walletId: string;
  contractId: string;
  credentialId: string;
}

export interface ApiWallet {
  walletId: string;
  contractId: string;
  depositAddress: string;
  balances: Record<string, string>;
}

export interface ApiGrant {
  id: string;
  name: string;
  clientId: string;
  status: string;
  dailyCap: string;
  txCap: string;
  assets: string[];
  expiresAt: string;
  contextRuleId: number | null;
  budget?: {
    spendingLimit: string;
    spentInWindow: string;
    remaining: string;
    txMax: string;
    periodLedgers: number;
  };
  [key: string]: unknown;
}

export interface ApiApproval {
  id: string;
  grantId: string;
  status: string;
  actionJson: Record<string, unknown>;
  amount: string | null;
  expiresAt: string;
  txHash: string | null;
  resultBody: string | null;
  createdAt: string;
}

export interface CreateGrantInput {
  name: string;
  client: string;
  dailyCap: string;
  txCap: string;
  assets: ["USDC"];
  expiresAt: string;
}

export interface CreatedGrant {
  grantId: string;
  agentPublicKey: string;
  ruleParams: {
    context_type: unknown;
    name: string;
    valid_until: number;
    signers: Array<{ tag: "External"; values: [string, string] }>;
    policies: Record<string, string>;
  };
}

export type ApprovalSignParams =
  | { kind: "send_payment"; func: string; auth: string[] }
  | {
      kind: "x402";
      url: string;
      method: string;
      body?: string;
      amountStroops: string;
      paymentRequired: unknown;
      transaction: string;
      auth: string[];
    };

export type ApprovalDecision =
  | {
      decision: "reject";
      assertion: AuthenticationResponseJSON;
    }
  | {
      decision: "approve";
      assertion: AuthenticationResponseJSON;
      txHash: string;
    }
  | {
      decision: "approve";
      assertion: AuthenticationResponseJSON;
      authEntries: string[];
    };

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const body =
      typeof payload === "object" && payload !== null
        ? (payload as { error?: unknown; message?: unknown })
        : {};
    const code =
      typeof body.error === "string" ? body.error : `http_${response.status}`;
    const message = typeof body.message === "string" ? body.message : code;
    throw new ApiError(code, response.status, message);
  }
  return payload as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export const api = {
  session: () => request<ApiSession>("/auth/session"),
  wallet: () => request<ApiWallet>("/wallets/me"),
  activity: () => request<Array<Record<string, unknown>>>("/activity"),
  registerWallet: (input: {
    contractId: string;
    credentialId: string;
    publicKey: string;
    registration?: RegistrationResponseJSON;
  }) =>
    request<{
      signedIn: boolean;
      userId: string;
      walletId: string;
      contractId: string;
    }>("/wallets/register", { method: "POST", body: jsonBody(input) }),
  registrationOptions: () =>
    request<{ challenge: string }>("/auth/register/options", {
      method: "POST",
    }),
  authOptions: (credentialId: string) =>
    request<PublicKeyCredentialRequestOptionsJSON>("/auth/options", {
      method: "POST",
      body: jsonBody({ credentialId }),
    }),
  verifyLogin: (assertion: AuthenticationResponseJSON) =>
    request<{ ok: true }>("/auth/verify", {
      method: "POST",
      body: jsonBody(assertion),
    }),
  reauthOptions: () =>
    request<PublicKeyCredentialRequestOptionsJSON>("/auth/reauth/options", {
      method: "POST",
      body: jsonBody({}),
    }),
  relay: (input: { func: string; auth: string[] } | { xdr: string }) =>
    request<{ success: true; hash: string; transactionId: string; status: string }>(
      "/relay",
      { method: "POST", body: jsonBody(input) }
    ),
  grants: () => request<ApiGrant[]>("/grants"),
  grant: (id: string) =>
    request<ApiGrant>(`/grants/${encodeURIComponent(id)}`),
  createGrant: (input: CreateGrantInput) =>
    request<CreatedGrant>("/grants", {
      method: "POST",
      body: jsonBody(input),
    }),
  confirmGrant: (id: string, txHash: string) =>
    request<{ grantId: string; status: "active"; contextRuleId: number }>(
      `/grants/${encodeURIComponent(id)}/confirm`,
      { method: "POST", body: jsonBody({ txHash }) }
    ),
  revokeParams: (id: string) =>
    request<{ grantId: string; contextRuleId: number }>(
      `/grants/${encodeURIComponent(id)}/revoke-params`
    ),
  revoke: (id: string, txHash: string) =>
    request<{ grantId: string; status: "revoked" }>(
      `/grants/${encodeURIComponent(id)}/revoke`,
      { method: "POST", body: jsonBody({ txHash }) }
    ),
  approvals: () => request<ApiApproval[]>("/approvals"),
  approval: (id: string) =>
    request<ApiApproval>(`/approvals/${encodeURIComponent(id)}`),
  approvalSignParams: (id: string) =>
    request<ApprovalSignParams>(
      `/approvals/${encodeURIComponent(id)}/sign-params`
    ),
  approvalDecision: (id: string, decision: ApprovalDecision) =>
    request<Record<string, unknown>>(
      `/approvals/${encodeURIComponent(id)}/decision`,
      { method: "POST", body: jsonBody(decision) }
    ),
  vapidPublicKey: () =>
    request<{ publicKey: string }>("/push/vapid-public-key"),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<void>("/push/subscribe", {
      method: "POST",
      body: jsonBody(subscription),
    }),
  oauthConsent: (input: { requestId: string; grantId: string }) =>
    request<{ redirectUrl: string }>("/oauth/consent", {
      method: "POST",
      body: jsonBody(input),
    }),
  oauthRegister: (input: Record<string, unknown>) =>
    request<Record<string, unknown>>("/oauth/register", {
      method: "POST",
      body: jsonBody(input),
    }),
  oauthAuthorize: (query: URLSearchParams) =>
    apiFetch(`/oauth/authorize?${query.toString()}`, { method: "GET" }),
  oauthToken: (input: URLSearchParams) =>
    request<OAuthTokenResponse>("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: input.toString(),
    }),
  mcp: (input: unknown, accessToken: string) =>
    apiFetch("/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: jsonBody(input),
    }),
};
