import type { NextConfig } from "next";

const apiHost = process.env.API_HOST ?? "";
const apiOrigin =
  process.env.API_ORIGIN ??
  (apiHost ? `https://${apiHost}` : "http://localhost:4000");
const apiBaseUrl =
  process.env.NEXT_PUBLIC_API_URL ??
  (apiHost ? "/api" : "http://localhost:4000");
const mcpUrl =
  process.env.NEXT_PUBLIC_MCP_URL ??
  (apiHost ? `https://${apiHost}/mcp` : `${apiBaseUrl.replace(/\/$/, "")}/mcp`);

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: apiBaseUrl,
    NEXT_PUBLIC_MCP_URL: mcpUrl,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
