const STROOPS = 10_000_000n;

export function fromStroops(value: string | bigint | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const stroops = typeof value === "bigint" ? value : BigInt(value);
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = (abs / STROOPS).toLocaleString("en-US");
  const fraction = (abs % STROOPS).toString().padStart(7, "0").replace(/0+$/, "").padEnd(decimals, "0");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function percent(part: string | undefined, total: string | undefined): number {
  if (!part || !total) return 0;
  const t = BigInt(total);
  if (t <= 0n) return 0;
  return Math.min(100, Math.max(0, Number((BigInt(part) * 10_000n) / t) / 100));
}

export function shortAddress(address: string | null | undefined, size = 4): string {
  if (!address) return "—";
  return address.length <= size * 2 + 1 ? address : `${address.slice(0, size)}…${address.slice(-size)}`;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 0) return timeUntil(iso);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "—";
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return "expired";
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

export function explorerTx(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

export function explorerContract(id: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${id}`;
}

export function toolLabel(tool: string): string {
  return tool.replace(/_/g, " ");
}
