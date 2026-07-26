import { describe, it, expect, beforeAll } from "vitest";

const TEST_SECRET = "a".repeat(64);

beforeAll(() => {
  process.env.MAIL_SESSION_SECRET = TEST_SECRET;
});

const ACC = "11111111-1111-4111-8111-111111111111";
const CID = "22222222-2222-4222-8222-222222222222";
const EM = "user@example.com";

async function loadModule() {
  return await import("../mail-token.server");
}

describe("mail-token.server", () => {
  it("accepts a freshly issued token", async () => {
    const { issueMailSessionToken, verifyMailSessionToken } = await loadModule();
    const { token } = await issueMailSessionToken({
      accountId: ACC,
      companyId: CID,
      normalizedEmail: EM,
    });
    const claims = await verifyMailSessionToken(token);
    expect(claims.sub).toBe(ACC);
    expect(claims.cid).toBe(CID);
    expect(claims.em).toBe(EM);
    expect(claims.iss).toBe("mailmaestro");
    expect(claims.aud).toBe("mailmaestro-index");
    expect(claims.ver).toBe(1);
    expect(claims.exp - claims.iat).toBe(12 * 60 * 60);
    expect(typeof claims.jti).toBe("string");
  });

  it("rejects a token with a mutated character", async () => {
    const { issueMailSessionToken, verifyMailSessionToken } = await loadModule();
    const { token } = await issueMailSessionToken({
      accountId: ACC,
      companyId: CID,
      normalizedEmail: EM,
    });
    const flipped = token.slice(0, -2) + (token.slice(-2) === "AA" ? "BB" : "AA");
    await expect(verifyMailSessionToken(flipped)).rejects.toBeDefined();
  });

  it("rejects an expired token", async () => {
    const { SignJWT } = await import("jose");
    const { verifyMailSessionToken } = await loadModule();
    const key = new TextEncoder().encode(TEST_SECRET);
    const iat = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    const token = await new SignJWT({ ver: 1, cid: CID, em: EM })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("mailmaestro")
      .setAudience("mailmaestro-index")
      .setSubject(ACC)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .setJti("j")
      .sign(key);
    await expect(verifyMailSessionToken(token)).rejects.toBeDefined();
  });

  it("rejects wrong issuer", async () => {
    const { SignJWT } = await import("jose");
    const { verifyMailSessionToken } = await loadModule();
    const key = new TextEncoder().encode(TEST_SECRET);
    const token = await new SignJWT({ ver: 1, cid: CID, em: EM })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("other")
      .setAudience("mailmaestro-index")
      .setSubject(ACC)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti("j")
      .sign(key);
    await expect(verifyMailSessionToken(token)).rejects.toBeDefined();
  });

  it("rejects wrong audience", async () => {
    const { SignJWT } = await import("jose");
    const { verifyMailSessionToken } = await loadModule();
    const key = new TextEncoder().encode(TEST_SECRET);
    const token = await new SignJWT({ ver: 1, cid: CID, em: EM })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("mailmaestro")
      .setAudience("other")
      .setSubject(ACC)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti("j")
      .sign(key);
    await expect(verifyMailSessionToken(token)).rejects.toBeDefined();
  });

  it("rejects wrong ver", async () => {
    const { SignJWT } = await import("jose");
    const { verifyMailSessionToken } = await loadModule();
    const key = new TextEncoder().encode(TEST_SECRET);
    const token = await new SignJWT({ ver: 2, cid: CID, em: EM })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("mailmaestro")
      .setAudience("mailmaestro-index")
      .setSubject(ACC)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti("j")
      .sign(key);
    await expect(verifyMailSessionToken(token)).rejects.toBeDefined();
  });

  it("rejects non-HS256 algorithm", async () => {
    const { SignJWT, generateKeyPair } = await import("jose");
    const { verifyMailSessionToken } = await loadModule();
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ ver: 1, cid: CID, em: EM })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("mailmaestro")
      .setAudience("mailmaestro-index")
      .setSubject(ACC)
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti("j")
      .sign(privateKey);
    await expect(verifyMailSessionToken(token)).rejects.toBeDefined();
  });

  it("rejects non-UUID sub", async () => {
    const { SignJWT } = await import("jose");
    const { verifyMailSessionToken } = await loadModule();
    const key = new TextEncoder().encode(TEST_SECRET);
    const token = await new SignJWT({ ver: 1, cid: CID, em: EM })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("mailmaestro")
      .setAudience("mailmaestro-index")
      .setSubject("not-a-uuid")
      .setIssuedAt()
      .setExpirationTime("1h")
      .setJti("j")
      .sign(key);
    await expect(verifyMailSessionToken(token)).rejects.toBeDefined();
  });

  it("fails safely when secret missing", async () => {
    const prev = process.env.MAIL_SESSION_SECRET;
    delete process.env.MAIL_SESSION_SECRET;
    try {
      const mod = await import("../mail-token.server");
      await expect(
        mod.issueMailSessionToken({ accountId: ACC, companyId: CID, normalizedEmail: EM }),
      ).rejects.toThrow(/MAIL_SESSION_SECRET/);
    } finally {
      process.env.MAIL_SESSION_SECRET = prev;
    }
  });

  it("payload contains no password or IMAP/SMTP fields", async () => {
    const { issueMailSessionToken } = await loadModule();
    const { token } = await issueMailSessionToken({
      accountId: ACC,
      companyId: CID,
      normalizedEmail: EM,
    });
    const [, payloadB64] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    );
    for (const k of ["password", "imap_host", "imap_port", "smtp_host", "smtp_port"]) {
      expect(payload[k]).toBeUndefined();
    }
  });
});
