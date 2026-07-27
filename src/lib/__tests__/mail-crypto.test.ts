import { describe, it, expect, beforeEach } from "vitest";
import {
  encryptCredential,
  decryptCredential,
  MailCryptoAuthError,
  MailCryptoFormatError,
  MailCryptoKeyMissingError,
  CURRENT_MAIL_KEY_VERSION,
  __resetKeyCacheForTests,
  __seedKeyForTests,
  constantTimeEquals,
} from "../mail-crypto.server";
import { randomBytes } from "node:crypto";

// A stub admin that never gets hit — we seed the key cache directly so tests
// do not depend on Vault or the RPC.
const stubAdmin = {
  rpc: async () => ({ data: null, error: { code: "SHOULD_NOT_BE_CALLED" } }),
} as any;

function seedFreshKey(version: number = CURRENT_MAIL_KEY_VERSION) {
  const key = randomBytes(32);
  __resetKeyCacheForTests();
  __seedKeyForTests(version, key);
  return key;
}

describe("mail-crypto: AES-256-GCM round-trip", () => {
  beforeEach(() => __resetKeyCacheForTests());

  it("encrypts and decrypts a password losslessly", async () => {
    seedFreshKey();
    const plaintext = "correct horse battery staple 🐴🔋 كلمة السر";
    const { ciphertext, keyVersion } = await encryptCredential(stubAdmin, plaintext);
    expect(keyVersion).toBe(CURRENT_MAIL_KEY_VERSION);
    expect(ciphertext).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const decrypted = await decryptCredential(stubAdmin, ciphertext);
    expect(constantTimeEquals(decrypted, plaintext)).toBe(true);
  });

  it("uses a fresh nonce on every encryption (probabilistic guarantee)", async () => {
    seedFreshKey();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { ciphertext } = await encryptCredential(stubAdmin, "same-plaintext");
      const nonce = ciphertext.split(":")[1];
      expect(seen.has(nonce)).toBe(false);
      seen.add(nonce);
    }
  });

  it("rejects an empty plaintext", async () => {
    seedFreshKey();
    await expect(encryptCredential(stubAdmin, "")).rejects.toMatchObject({
      code: "MAIL_CRYPTO_EMPTY_PLAINTEXT",
    });
  });
});

describe("mail-crypto: tamper detection", () => {
  beforeEach(() => __resetKeyCacheForTests());

  it("throws MailCryptoAuthError when the ciphertext byte is flipped", async () => {
    seedFreshKey();
    const { ciphertext } = await encryptCredential(stubAdmin, "hunter2");
    const parts = ciphertext.split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] = ct[0] ^ 0x01;
    parts[3] = ct.toString("base64");
    const tampered = parts.join(":");
    await expect(decryptCredential(stubAdmin, tampered)).rejects.toBeInstanceOf(MailCryptoAuthError);
  });

  it("throws MailCryptoAuthError when the auth tag is mutated", async () => {
    seedFreshKey();
    const { ciphertext } = await encryptCredential(stubAdmin, "hunter2");
    const parts = ciphertext.split(":");
    const tag = Buffer.from(parts[2], "base64");
    tag[0] = tag[0] ^ 0x80;
    parts[2] = tag.toString("base64");
    await expect(decryptCredential(stubAdmin, parts.join(":"))).rejects.toBeInstanceOf(
      MailCryptoAuthError,
    );
  });

  it("throws MailCryptoAuthError when the nonce is mutated", async () => {
    seedFreshKey();
    const { ciphertext } = await encryptCredential(stubAdmin, "hunter2");
    const parts = ciphertext.split(":");
    const nonce = Buffer.from(parts[1], "base64");
    nonce[5] = nonce[5] ^ 0x11;
    parts[1] = nonce.toString("base64");
    await expect(decryptCredential(stubAdmin, parts.join(":"))).rejects.toBeInstanceOf(
      MailCryptoAuthError,
    );
  });

  it("throws MailCryptoAuthError when using a different master key", async () => {
    seedFreshKey();
    const { ciphertext } = await encryptCredential(stubAdmin, "hunter2");
    // Rotate to a different key material under the SAME version → auth must fail.
    __resetKeyCacheForTests();
    __seedKeyForTests(CURRENT_MAIL_KEY_VERSION, randomBytes(32));
    await expect(decryptCredential(stubAdmin, ciphertext)).rejects.toBeInstanceOf(
      MailCryptoAuthError,
    );
  });
});

describe("mail-crypto: format validation", () => {
  beforeEach(() => __resetKeyCacheForTests());

  it.each([
    ["not-a-ciphertext", "expected 4 parts"],
    ["v1:abc:def", "expected 4 parts"],
    ["x1:aa:bb:cc", "missing version prefix"],
    ["v0:aa:bb:cc", "bad version"],
    ["v1:aa:bb:cc", "bad nonce length"],
  ])("rejects malformed input %p", async (input) => {
    seedFreshKey();
    await expect(decryptCredential(stubAdmin, input as string)).rejects.toBeInstanceOf(
      MailCryptoFormatError,
    );
  });

  it("throws MailCryptoKeyMissingError for an unknown key version", async () => {
    seedFreshKey(); // seeds only v1
    // Build a valid-looking v2 envelope so parse succeeds and lookup fails.
    const stub = {
      rpc: async (_fn: string, args: { p_version: number }) => ({
        data: null,
        error: { code: "42704", message: `version ${args.p_version} missing` },
      }),
    } as any;
    const nonce = Buffer.alloc(12);
    const tag = Buffer.alloc(16);
    const ct = Buffer.alloc(4);
    const v2 = `v2:${nonce.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
    await expect(decryptCredential(stub, v2)).rejects.toBeInstanceOf(MailCryptoKeyMissingError);
  });
});

describe("mail-crypto: no plaintext leakage in error surfaces", () => {
  beforeEach(() => __resetKeyCacheForTests());

  it("MailCryptoAuthError message contains no plaintext or key material", async () => {
    seedFreshKey();
    const secret = "SUPER_SECRET_PASSWORD_XyZ_9182";
    const { ciphertext } = await encryptCredential(stubAdmin, secret);
    const parts = ciphertext.split(":");
    const ct = Buffer.from(parts[3], "base64");
    ct[0] = ct[0] ^ 0xff;
    parts[3] = ct.toString("base64");
    try {
      await decryptCredential(stubAdmin, parts.join(":"));
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as Error;
      expect(err.message).not.toContain(secret);
      // The MailCryptoError message must not embed the ciphertext either.
      expect(err.message.length).toBeLessThan(120);
    }
  });
});
