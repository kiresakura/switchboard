import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, encrypt } from "@/lib/crypto/encryption";

// 測試專用的固定金鑰，不是任何環境的真實金鑰
const HEX_KEY = "0123456789abcdef".repeat(4);
const OTHER_HEX_KEY = "fedcba9876543210".repeat(4);

function flipLastHexDigit(hex: string) {
  const last = hex.at(-1) === "0" ? "1" : "0";
  return hex.slice(0, -1) + last;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("NEXT_PHASE", "");
  vi.stubEnv("TELEGRAM_SESSION_KEY", HEX_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("session encryption (AES-256-GCM)", () => {
  it("round-trips text, including non-ASCII", () => {
    const plaintext = JSON.stringify({ sessionString: "1BQANOTEU...", note: "會話 🔐" });
    const { ciphertext, iv, authTag } = encrypt(plaintext);

    expect(iv).toMatch(/^[0-9a-f]{32}$/);
    expect(authTag).toMatch(/^[0-9a-f]{32}$/);
    expect(decrypt(ciphertext, iv, authTag)).toBe(plaintext);
  });

  it("uses a fresh IV for every encryption", () => {
    const a = encrypt("same input");
    const b = encrypt("same input");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("refuses tampered ciphertext or auth tags", () => {
    const { ciphertext, iv, authTag } = encrypt("account session");

    expect(() => decrypt(flipLastHexDigit(ciphertext), iv, authTag)).toThrow();
    expect(() => decrypt(ciphertext, iv, flipLastHexDigit(authTag))).toThrow();
  });

  it("cannot be decrypted with a different key", () => {
    const { ciphertext, iv, authTag } = encrypt("account session");
    vi.stubEnv("TELEGRAM_SESSION_KEY", OTHER_HEX_KEY);
    expect(() => decrypt(ciphertext, iv, authTag)).toThrow();
  });

  it("validates IV and auth tag lengths", () => {
    const { ciphertext, iv, authTag } = encrypt("account session");

    expect(() => decrypt(ciphertext, iv.slice(0, 24), authTag)).toThrow(/Invalid IV length/);
    expect(() => decrypt(ciphertext, iv, authTag.slice(0, 16))).toThrow(/Invalid auth tag length/);
  });

  it("requires a key of at least 32 characters", () => {
    vi.stubEnv("TELEGRAM_SESSION_KEY", "too-short");
    expect(() => encrypt("x")).toThrow(/at least 32 characters/);
  });

  it("derives a key with scrypt when the key is not 64 hex characters", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("TELEGRAM_SESSION_KEY", "a passphrase that is long enough to use");

    const { ciphertext, iv, authTag } = encrypt("account session");

    expect(decrypt(ciphertext, iv, authTag)).toBe("account session");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("scrypt"));
  });

  it("refuses the public build-time placeholder in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TELEGRAM_SESSION_KEY", "build-time-placeholder-replaced-at-runtime");
    expect(() => encrypt("x")).toThrow(/placeholder/);
  });
});
