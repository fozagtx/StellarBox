import { afterAll, describe, expect, it } from "vitest";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentKeys, createDatabase } from "@stellabox/db";
import { AgentKeyStore } from "./index.js";

const database = createDatabase();
const store = new AgentKeyStore(database.db);

afterAll(async () => {
  await database.pool.end();
});

describe("AgentKeyStore", () => {
  it("stores an encrypted key, signs with real Ed25519, and zeroes it on destroy", async () => {
    const created = await store.create();
    const [encrypted] = await database.db
      .select()
      .from(agentKeys)
      .where(eq(agentKeys.id, created.keyId))
      .limit(1);
    expect(encrypted).toBeDefined();
    expect(encrypted?.destroyedAt).toBeNull();
    expect(encrypted?.ciphertext.some((byte) => byte !== 0)).toBe(true);

    const digest = randomBytes(32);
    const signature = await store.sign(created.keyId, digest);
    const publicKeyDer = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(created.publicKey, "base64url"),
    ]);
    const publicKey = createPublicKey({
      key: publicKeyDer,
      format: "der",
      type: "spki",
    });
    expect(verify(null, digest, publicKey, signature)).toBe(true);

    await store.destroy(created.keyId);
    const [destroyed] = await database.db
      .select()
      .from(agentKeys)
      .where(eq(agentKeys.id, created.keyId))
      .limit(1);
    expect(destroyed?.destroyedAt).toBeInstanceOf(Date);
    expect(destroyed?.ciphertext.every((byte) => byte === 0)).toBe(true);
    await expect(store.sign(created.keyId, digest)).rejects.toThrow(
      "Agent signing key does not exist or has been destroyed"
    );
    await database.db.delete(agentKeys).where(eq(agentKeys.id, created.keyId));
  });
});
