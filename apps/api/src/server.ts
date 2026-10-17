import { createDatabase } from "@stellabox/db";
import { createApiApp } from "./app.js";
import { loadApiConfig } from "./config.js";

const config = loadApiConfig();
if (!config.sessionSecret) {
  throw new Error("SESSION_SECRET is required");
}
const { db, pool } = createDatabase();
const app = createApiApp(db);
const server = app.listen(config.port, () => {
  process.stdout.write(`StellaBox API listening on ${config.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void pool.end();
    });
  });
}
