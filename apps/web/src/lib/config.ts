export const API_BASE_URL = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

export const MCP_URL =
  process.env.NEXT_PUBLIC_MCP_URL ??
  `${API_BASE_URL}/mcp`;
