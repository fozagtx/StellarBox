import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Keypair } from "@stellar/stellar-sdk";
import type { Database } from "@stellabox/db";
import { agentKeys } from "@stellabox/db";

interface EncryptedKey {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

function decodeMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  ) {
    throw new Error("KEYSTORE_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

function encrypt(seed: Buffer, key: Buffer): EncryptedKey {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function decrypt(encrypted: EncryptedKey, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.nonce);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]);
}

export class AgentKeyStore {
  private readonly masterKey: Buffer;

  constructor(
    private readonly db: Database,
    encodedMasterKey = process.env.KEYSTORE_MASTER_KEY
  ) {
    if (!encodedMasterKey) {
      throw new Error("KEYSTORE_MASTER_KEY is required");
    }
    this.masterKey = decodeMasterKey(encodedMasterKey);
  }

  async create(): Promise<{ keyId: string; publicKey: string }> {
    const seed = randomBytes(32);
    try {
      const keypair = Keypair.fromRawEd25519Seed(seed);
      const publicKey = Buffer.from(keypair.rawPublicKey()).toString("base64url");
      const encrypted = encrypt(seed, this.masterKey);
      const [row] = await this.db
        .insert(agentKeys)
        .values({ publicKey, ...encrypted })
        .returning({ id: agentKeys.id });
      return { keyId: row!.id, publicKey };
    } finally {
      seed.fill(0);
    }
  }

  async sign(keyId: string, digest: Uint8Array): Promise<Buffer> {
    if (digest.byteLength !== 32) {
      throw new RangeError("Agent signer digest must be exactly 32 bytes");
    }
    const [row] = await this.db
      .select({
        publicKey: agentKeys.publicKey,
        nonce: agentKeys.nonce,
        ciphertext: agentKeys.ciphertext,
        authTag: agentKeys.authTag,
      })
      .from(agentKeys)
      .where(and(eq(agentKeys.id, keyId), isNull(agentKeys.destroyedAt)))
      .limit(1);
    if (!row) {
      throw new Error("Agent signing key does not exist or has been destroyed");
    }
    const seed = decrypt(row, this.masterKey);
    try {
      return Buffer.from(
        Keypair.fromRawEd25519Seed(seed).sign(Buffer.from(digest))
      );
    } finally {
      seed.fill(0);
    }
  }

  async destroy(keyId: string): Promise<void> {
    await this.db.transaction(async (transaction) => {
      const [row] = await transaction
        .select({
          nonce: agentKeys.nonce,
          ciphertext: agentKeys.ciphertext,
          authTag: agentKeys.authTag,
        })
        .from(agentKeys)
        .where(and(eq(agentKeys.id, keyId), isNull(agentKeys.destroyedAt)))
        .for("update")
        .limit(1);
      if (!row) {
        throw new Error("Agent signing key does not exist or has been destroyed");
      }
      await transaction
        .update(agentKeys)
        .set({
          nonce: Buffer.alloc(row.nonce.length),
          ciphertext: Buffer.alloc(row.ciphertext.length),
          authTag: Buffer.alloc(row.authTag.length),
          destroyedAt: new Date(),
        })
        .where(eq(agentKeys.id, keyId));
    });
  }
}
