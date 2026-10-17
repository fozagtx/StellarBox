import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./client.js";

const { pool } = createDatabase();
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const connection = await pool.connect();
try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS stellabox_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationFiles) {
    const existing = await connection.query(
      "SELECT 1 FROM stellabox_migrations WHERE name = $1",
      [name]
    );
    if (existing.rowCount) continue;
    const sql = await readFile(new URL(name, `file://${migrationsDirectory}/`), "utf8");
    await connection.query("BEGIN");
    try {
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await connection.query(statement);
      }
      await connection.query(
        "INSERT INTO stellabox_migrations (name) VALUES ($1)",
        [name]
      );
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  connection.release();
  await pool.end();
}
