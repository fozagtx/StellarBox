// Vercel serverless entry. Vercel calls the Express app as a request handler;
// server.ts (app.listen) stays the entry for local dev and long-running hosts.
import { createDatabase } from "@stellabox/db";
import { createApiApp } from "./app.js";
import { loadApiConfig } from "./config.js";

if (!loadApiConfig().sessionSecret) {
  throw new Error("SESSION_SECRET is required");
}
const { db } = createDatabase();
export default createApiApp(db);
