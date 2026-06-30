import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { assertRealSecret } from "../security/secret-guard";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
  const key = process.env.TELEGRAM_SESSION_KEY;
  if (!key || key.length < 32) {
    throw new Error("TELEGRAM_SESSION_KEY must be at least 32 characters (64 hex chars recommended)");
  }
  // C3: in production, reject the public build-time placeholder / dev defaults
  // so stored Telegram sessions can never be encrypted under a known key.
  assertRealSecret("TELEGRAM_SESSION_KEY", key);
  // Require hex-encoded 64-char key for proper 256-bit entropy (H1 fix)
  if (/^[0-9a-fA-F]{64}$/.test(key)) {
    return Buffer.from(key, "hex");
  }
  // Fallback: derive key via scrypt for non-hex strings (safer than raw truncation or SHA-256)
  console.warn(
    "[Crypto] TELEGRAM_SESSION_KEY is not a 64-char hex string. " +
    "Using scrypt key derivation. For best security, use: openssl rand -hex 32"
  );
  return scryptSync(key, "switchboard-telegram-session-salt", 32, { N: 16384, r: 8, p: 1 });
}

export function encrypt(plaintext: string): {
  ciphertext: string;
  iv: string;
  authTag: string;
} {
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf-8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return {
    ciphertext: encrypted,
    iv: iv.toString("hex"),
    authTag,
  };
}

export function decrypt(
  ciphertext: string,
  iv: string,
  authTag: string
): string {
  const key = getKey();

  // Validate IV length (AES-GCM requires 16 bytes = 32 hex chars)
  const ivBuffer = Buffer.from(iv, "hex");
  if (ivBuffer.length !== 16) {
    throw new Error(`Invalid IV length: expected 16 bytes, got ${ivBuffer.length}`);
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    ivBuffer,
  );
  const tagBuffer = Buffer.from(authTag, "hex");
  if (tagBuffer.length < 12 || tagBuffer.length > 16) {
    throw new Error(`Invalid auth tag length: expected 12-16 bytes, got ${tagBuffer.length}`);
  }
  decipher.setAuthTag(tagBuffer);

  let decrypted = decipher.update(ciphertext, "hex", "utf-8");
  decrypted += decipher.final("utf-8");

  return decrypted;
}
