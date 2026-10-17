import type { ApiApproval } from "./api";

export function effectiveStatus(item: ApiApproval): string {
  return item.status === "pending" && new Date(item.expiresAt) <= new Date() ? "expired" : item.status;
}

export function approvalTitle(item: ApiApproval): string {
  const action = item.actionJson as Record<string, unknown>;
  if (action.kind === "x402") {
    try {
      return `Pay ${new URL(String(action.url)).host}`;
    } catch {
      return "Pay x402 endpoint";
    }
  }
  if (action.kind === "send_payment") return `Send to ${String(action.to).slice(0, 4)}…${String(action.to).slice(-4)}`;
  return String(action.action ?? "Agent request");
}
